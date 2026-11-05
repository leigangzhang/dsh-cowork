/**
 * M2 real-host end-to-end driver.
 *
 * One run creates a throwaway git project under `<repo>/.dsh-cowork/e2e/m2-repo`,
 * drives a real `cowork-master` session plus two isolated thread sessions over
 * `sessionController`, and proves the M2 contract from durable state only:
 * the project index, the memory files, handoff files, git history/worktrees,
 * the workspace registry, and tool-result events. A model's prose is never an
 * assertion source; it is recorded as evidence and clipped.
 *
 * The run is started and polled through loopback-only routes registered by
 * src/index.ts. Evidence is written atomically to
 * `<repo>/.dsh-cowork/e2e/M2_E2E.json`, so a host reload does not lose the
 * cited run's record.
 *
 * Race handling: handoffs wake the master session on their own. Every step
 * waits for the session it is about to prompt to be idle, and both merge steps
 * first check whether their target state was already reached; if so they pass
 * idempotently and record `note` instead of prompting again.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { writeStoreAtomic } from './probe-store.js'
import { MASTER_PRESET_ID } from './presets.js'

/** Evidence file, relative to the plugin's default repository root. */
export const M2_E2E_EVIDENCE_RELATIVE = '.dsh-cowork/e2e/M2_E2E.json'
/** Throwaway project root, relative to the plugin's default repository root. */
export const M2_E2E_FIXTURE_RELATIVE = '.dsh-cowork/e2e/m2-repo'
/** Upper bound for one E2E step (including its polling). */
export const M2_E2E_STEP_TIMEOUT_MS = 180_000
/** Poll interval; state is polled, never replaced by a fixed sleep. */
const POLL_MS = 500
/** Per-session event buffer bound. */
const MAX_EVENTS = 4000
/** Clipping bounds for evidence text. */
const MAX_ASSISTANT_TEXT = 1000
const MAX_TOOL_ARGUMENTS = 4000
const MAX_TOOL_TEXT = 4000
const MAX_FILE_TEXT = 2000
const MAX_GIT_TEXT = 2000
const MAX_FIELD_TEXT = 3000
/** Git invocation bounds. */
const GIT_TIMEOUT_MS = 30_000
const GIT_MAX_BUFFER = 8 * 1024 * 1024

/** One session event as this driver consumes it. */
export interface M2SessionEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: Record<string, unknown>
}

/** One session row returned by `sessionController.list`. */
export interface M2SessionRow {
  readonly sessionId: string
  readonly cwd?: string
  readonly running: boolean
}

/** One session header returned by `sessionController.inspect`. */
export interface M2SessionHeader {
  readonly id: string
  readonly cwd?: string
  readonly agentPreset?: string
}

/** One workspace record as this driver consumes it. */
export interface M2Workspace {
  readonly id: string
  readonly path: string
  readonly sessionIds: readonly string[]
}

/** Host services the driver calls; structural so the module stays testable. */
export interface M2E2EHost {
  readonly sessionController: {
    create(request: {
      workspaceId?: string
      cwd?: string
      sessionId?: string
      agentPreset?: string
    }): Promise<{ sessionId: string; agentPreset?: string }>
    prompt(
      request: {
        requestId: string
        sessionId: string
        mode: 'queue' | 'steer'
        content: ReadonlyArray<{ type: 'text'; text: string }>
      },
      signal?: AbortSignal,
    ): Promise<{ accepted: boolean }>
    list(request?: unknown, signal?: AbortSignal): Promise<{ items: readonly M2SessionRow[] }>
    inspect(sessionId: string, signal?: AbortSignal): Promise<{ meta: M2SessionHeader }>
  }
  readonly workspaceRegistry: {
    resolveByPath(path: string): Promise<M2Workspace | undefined>
    delete(id: string): Promise<boolean>
    archiveSession(sessionId: string, options?: { stopActivity?: boolean }): Promise<void>
  }
  on(
    name: 'session/event',
    listener: (session: { id: string }, event: M2SessionEvent) => void,
  ): () => void
}

/** Construction knobs the plugin supplies. */
export interface M2E2EConfig {
  /** The plugin's default repository root; the fixture and evidence live under it. */
  readonly repoPath: string
  /** Prompt admission timeout, reused from the plugin config. */
  readonly promptTimeoutMs: number
  /** Plugin identity recorded in the evidence document. */
  readonly pluginName: string
  readonly pluginVersion: string
  readonly log?: (message: string) => void
}

/** Run lifecycle. */
export type M2RunState = 'running' | 'done' | 'failed'
/** Step lifecycle. */
export type M2StepStatus = 'pending' | 'running' | 'passed' | 'failed'

/** One assertion with its observed value. */
export interface M2Assertion {
  readonly check: string
  readonly passed: boolean
  readonly detail: string
}

/** One tool invocation observed in a session event stream. */
export interface M2ToolCallEvidence {
  readonly name: string
  readonly callId: string
  readonly arguments: string
  resultText: string | null
  isError: boolean | null
  errorCode?: string
}

/** One prompt plus what the session did in response to it. */
export interface M2PromptEvidence {
  readonly sessionId: string
  readonly role: 'master' | 'thread'
  readonly text: string
  accepted: boolean
  readonly fromSeq: number
  assistantText: string
  toolCalls: M2ToolCallEvidence[]
}

/** Everything one step recorded. */
export interface M2StepEvidence {
  startedAt: string | null
  endedAt: string | null
  prompts: M2PromptEvidence[]
  observations: Record<string, unknown>
  assertions: M2Assertion[]
  note?: string
  error?: string
}

/** One step view returned by the status route. */
export interface M2StepView {
  readonly id: string
  readonly status: M2StepStatus
  readonly evidence: M2StepEvidence
}

/** One run view returned by the status route and stored in the evidence file. */
export interface M2E2EStatusView {
  readonly runId: string
  readonly state: M2RunState
  readonly startedAt: string
  readonly endedAt?: string
  readonly steps: readonly M2StepView[]
  readonly evidenceFile: string
  readonly error?: string
}

/** Evidence document written at every step boundary and at the end. */
export interface M2E2EEvidenceDocument {
  readonly version: 1
  readonly runId: string
  readonly state: M2RunState
  readonly startedAt: string
  readonly endedAt: string | null
  readonly host: {
    readonly plugin: string
    readonly pluginVersion: string
    readonly node: string
    readonly platform: string
    readonly arch: string
    readonly hostname: string
    readonly repoPath: string
  }
  readonly steps: readonly M2StepView[]
  readonly finalIndex: unknown
  readonly cleanup: Record<string, unknown>
  readonly error?: string
}

/** A thread record as the index stores it. */
interface IndexThread {
  readonly threadId: string
  readonly subject: string
  readonly status: string
  readonly checkoutPath: string | null
  readonly [key: string]: unknown
}

/** The slice of the project index this driver reads. */
interface IndexView {
  readonly masterSessionId: string
  readonly threads: readonly IndexThread[]
  readonly [key: string]: unknown
}

/** One handoff file read from disk. */
interface HandoffView {
  readonly filePath: string
  readonly record: {
    readonly threadId: string
    readonly status: string
    readonly summary: string
    readonly createdAt: string
    readonly [key: string]: unknown
  }
}

interface MutableStep {
  readonly id: string
  status: M2StepStatus
  readonly evidence: M2StepEvidence
}

interface MutableRun {
  readonly runId: string
  state: M2RunState
  readonly startedAt: string
  endedAt?: string
  readonly steps: MutableStep[]
  error?: string
  finalIndex: unknown
  cleanup: Record<string, unknown>
}

/** Git result used by observed helper calls. */
interface GitOutcome {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** The ordered steps; a failure stops the run and leaves later steps pending. */
const STEP_IDS = [
  'setup',
  'memory-write',
  'isolated-thread',
  'thread-work',
  'memory-cross-thread',
  'merge-success',
  'conflict-thread',
  'conflict-merge',
  'conflict-retry',
  'cleanup',
] as const

const MERGE_TOOL = 'cowork_checkout_merge'
const MASTER_DONE = 'Reply DONE.'
const FIXTURE_SUBJECT_1 = 'E2E 隔离线程'
const FIXTURE_SUBJECT_2 = 'E2E 冲突线程'
const MEMORY_TITLE = 'E2E 约束'
const MEMORY_TEXT = '所有提交信息用中文'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

function isoNow(): string {
  return new Date().toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((settle) => setTimeout(settle, ms))
}

/** Pad a path check with a trailing separator so `/a/b` never matches `/a/bc`. */
function isStrictlyInside(parent: string, child: string): boolean {
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
}

/** Read a UTF-8 file, treating a missing path as `undefined` and other errors as failures. */
async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
}

/** Model-facing tool result text: text blocks joined, other blocks JSON-serialized. */
function contentText(message: unknown): string {
  const content = asRecord(message)?.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    const block = asRecord(part)
    if (block === undefined) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else {
      try {
        parts.push(JSON.stringify(block))
      } catch {
        parts.push('[unserializable block]')
      }
    }
  }
  return parts.join('\n')
}

/** git with an argument array, an explicit cwd, and a timeout; non-zero exits are values. */
function runGit(args: readonly string[], cwd: string): Promise<GitOutcome> {
  return new Promise<GitOutcome>((settle) => {
    execFile(
      'git',
      [...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error === null) {
          settle({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '' })
          return
        }
        const exit = (error as { code?: unknown }).code
        settle({
          code: typeof exit === 'number' ? exit : 1,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr:
            typeof stderr === 'string' && stderr.length > 0 ? stderr : (error as Error).message,
        })
      },
    )
  })
}

/**
 * One M2 E2E run at a time. The runner keeps only in-memory run views; every
 * durable fact comes from the host, the project directory, or git.
 */
export class M2E2ERunner {
  private readonly runs = new Map<string, MutableRun>()
  private readonly events = new Map<string, M2SessionEvent[]>()
  private readonly trackedSessions = new Set<string>()
  private readonly evidenceFile: string
  private readonly fixturePath: string
  private lastRunId: string | null = null
  private disposed = false

  private masterSessionId: string | null = null
  private thread1: string | null = null
  private thread1CheckoutPath: string | null = null
  private thread2: string | null = null
  private thread2CheckoutPath: string | null = null

  constructor(
    private readonly host: M2E2EHost,
    private readonly config: M2E2EConfig,
  ) {
    this.evidenceFile = join(config.repoPath, M2_E2E_EVIDENCE_RELATIVE)
    this.fixturePath = join(config.repoPath, M2_E2E_FIXTURE_RELATIVE)
    this.assertFixturePath(this.fixturePath)
  }

  /** Subscribe to the host session event feed; returns the disposer. */
  attachEvents(): () => void {
    return this.host.on('session/event', (session, event) => {
      if (!this.trackedSessions.has(session.id)) return
      const list = this.events.get(session.id) ?? []
      list.push(event)
      if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS)
      this.events.set(session.id, list)
    })
  }

  /** Start one run and return its identity immediately; execution stays in the background. */
  start(): { runId: string; state: M2RunState } {
    if (this.disposed) throw new Error('M2 E2E runner is disposed')
    const active = this.lastRunId === null ? undefined : this.runs.get(this.lastRunId)
    if (active !== undefined && active.state === 'running') {
      throw new Error(`M2 E2E run ${active.runId} is still running`)
    }
    const run: MutableRun = {
      runId: `m2-${randomUUID()}`,
      state: 'running',
      startedAt: isoNow(),
      steps: STEP_IDS.map((id) => ({
        id,
        status: 'pending',
        evidence: {
          startedAt: null,
          endedAt: null,
          prompts: [],
          observations: {},
          assertions: [],
        },
      })),
      finalIndex: null,
      cleanup: {},
    }
    this.runs.set(run.runId, run)
    this.lastRunId = run.runId
    this.trimRuns()
    void this.execute(run)
    return { runId: run.runId, state: run.state }
  }

  /** Read one live run view, or undefined when this process never saw the id. */
  status(runId: string): M2E2EStatusView | undefined {
    const run = this.runs.get(runId)
    return run === undefined ? undefined : this.view(run)
  }

  /**
   * Resolve a run from memory, else from the evidence file. A host rebuild
   * reloads the module and empties the table, so a cited id must still answer.
   */
  async resolve(runId: string): Promise<M2E2EStatusView | undefined> {
    const live = this.status(runId)
    if (live !== undefined) return live
    if (!/^m2-[0-9a-fA-F-]{8,64}$/.test(runId)) return undefined
    try {
      const parsed = JSON.parse(await readFile(this.evidenceFile, 'utf8')) as
        | M2E2EEvidenceDocument
        | undefined
      if (parsed === undefined || parsed.runId !== runId) return undefined
      return {
        runId: parsed.runId,
        state: parsed.state,
        startedAt: parsed.startedAt,
        ...(parsed.endedAt === null ? {} : { endedAt: parsed.endedAt }),
        steps: parsed.steps,
        evidenceFile: this.evidenceFile,
        ...(parsed.error === undefined ? {} : { error: parsed.error }),
      }
    } catch {
      return undefined
    }
  }

  /** Stop polling loops and release event buffers. */
  dispose(): void {
    this.disposed = true
    this.trackedSessions.clear()
    this.events.clear()
  }

  private trimRuns(): void {
    while (this.runs.size > 10) {
      const oldest = this.runs.keys().next().value
      if (oldest === undefined || oldest === this.lastRunId) return
      this.runs.delete(oldest)
    }
  }

  private view(run: MutableRun): M2E2EStatusView {
    return JSON.parse(JSON.stringify({
      runId: run.runId,
      state: run.state,
      startedAt: run.startedAt,
      ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
      steps: run.steps,
      evidenceFile: this.evidenceFile,
      ...(run.error === undefined ? {} : { error: run.error }),
    })) as M2E2EStatusView
  }

  private async execute(run: MutableRun): Promise<void> {
    try {
      for (const step of run.steps) {
        if (this.disposed) throw new Error('M2 E2E runner was disposed')
        step.status = 'running'
        step.evidence.startedAt = isoNow()
        step.evidence.observations.before = await this.safeSnapshot()
        try {
          await this.runStep(step, run)
          step.status = 'passed'
        } catch (error) {
          step.status = 'failed'
          step.evidence.error = messageOf(error)
          step.evidence.endedAt = isoNow()
          step.evidence.observations.after = await this.safeSnapshot()
          this.refreshPrompts(step)
          run.state = 'failed'
          run.error = `step ${step.id}: ${step.evidence.error}`
          break
        }
        step.evidence.endedAt = isoNow()
        step.evidence.observations.after = await this.safeSnapshot()
        this.refreshPrompts(step)
        await this.persist(run)
      }
      if (run.state === 'running') run.state = 'done'
    } catch (error) {
      run.state = 'failed'
      run.error = messageOf(error)
    } finally {
      run.endedAt = isoNow()
      await this.safeArchiveSessions(run)
      await this.persist(run)
      this.releaseSessions()
    }
  }

  private async runStep(step: MutableStep, run: MutableRun): Promise<void> {
    switch (step.id) {
      case 'setup': return this.stepSetup(step, run)
      case 'memory-write': return this.stepMemoryWrite(step)
      case 'isolated-thread': return this.stepIsolatedThread(step)
      case 'thread-work': return this.stepThreadWork(step)
      case 'memory-cross-thread': return this.stepMemoryCrossThread(step)
      case 'merge-success': return this.stepMergeSuccess(step)
      case 'conflict-thread': return this.stepConflictThread(step)
      case 'conflict-merge': return this.stepConflictMerge(step)
      case 'conflict-retry': return this.stepConflictRetry(step)
      case 'cleanup': return this.stepCleanup(step, run)
      default: throw new Error(`unknown M2 E2E step: ${step.id}`)
    }
  }

  // ------------------------------------------------------------------ steps

  /** Step 0: create the throwaway project and the master session; initialize the index. */
  private async stepSetup(step: MutableStep, run: MutableRun): Promise<void> {
    const repo = this.fixturePath
    await rm(repo, { recursive: true, force: true })
    await mkdir(repo, { recursive: true, mode: 0o700 })
    step.evidence.observations.fixture = repo

    await this.gitOk(step, ['init', '-b', 'main'], repo, 'git init')
    await this.gitOk(step, ['config', 'user.email', 'e2e@dsh-cowork.invalid'], repo, 'git config email')
    await this.gitOk(step, ['config', 'user.name', 'dsh-cowork e2e'], repo, 'git config name')
    await writeFile(join(repo, 'README.md'), '# M2 E2E fixture\n', 'utf8')
    await writeFile(join(repo, '.gitignore'), '.dsh-cowork/\n', 'utf8')
    await this.gitOk(step, ['add', 'README.md', '.gitignore'], repo, 'git add')
    await this.gitOk(step, ['commit', '-m', 'init'], repo, 'git commit')

    const created = await this.host.sessionController.create({
      cwd: repo,
      agentPreset: MASTER_PRESET_ID,
    })
    this.masterSessionId = created.sessionId
    this.track(created.sessionId)
    run.cleanup.masterSessionId = created.sessionId
    step.evidence.observations.masterSessionId = created.sessionId
    step.evidence.observations.createReturnedPreset = created.agentPreset ?? null
    this.check(
      step,
      'master session mounted cowork-master',
      created.agentPreset === MASTER_PRESET_ID,
      `agentPreset=${String(created.agentPreset)}`,
    )

    await this.waitIdle(created.sessionId)
    await this.promptStep(
      step,
      created.sessionId,
      'master',
      `Call cowork_project_init with no arguments. ${MASTER_DONE}`,
    )
    const index = await this.poll('project index initialized by the master', async () => {
      const current = await this.readIndex()
      return current !== undefined && current.masterSessionId === created.sessionId
        ? current
        : undefined
    })
    step.evidence.observations.indexFile = join(repo, '.dsh-cowork', 'index.json')
    step.evidence.observations.indexMasterSessionId = index.masterSessionId
    this.check(
      step,
      'index file exists',
      existsSync(join(repo, '.dsh-cowork', 'index.json')),
      join(repo, '.dsh-cowork', 'index.json'),
    )
    this.check(
      step,
      'index masterSessionId equals the created master',
      index.masterSessionId === created.sessionId,
      `${index.masterSessionId} == ${created.sessionId}`,
    )
    await this.waitIdle(created.sessionId)
  }

  /** Step 1: write one master constraint and prove it reached constraints.md. */
  private async stepMemoryWrite(step: MutableStep): Promise<void> {
    const master = this.master()
    await this.waitIdle(master)
    await this.promptStep(
      step,
      master,
      'master',
      `Call cowork_memory_write with kind "constraint", title "${MEMORY_TITLE}", `
        + `text "${MEMORY_TEXT}", source "e2e". ${MASTER_DONE}`,
    )
    const file = join(this.fixturePath, '.dsh-cowork', 'memory', 'constraints.md')
    const content = await this.poll('constraints.md to contain the E2E constraint', async () => {
      const text = await readTextIfPresent(file)
      return text !== undefined && text.includes(MEMORY_TITLE) ? text : undefined
    })
    step.evidence.observations.memoryFile = file
    step.evidence.observations.memoryText = clip(content, MAX_FILE_TEXT)
    this.check(step, 'constraints.md contains the entry title', content.includes(MEMORY_TITLE), file)
    this.check(step, 'constraints.md contains the entry text', content.includes(MEMORY_TEXT), file)
    await this.waitIdle(master)
  }

  /** Step 2: create the first isolated thread and prove clone, branch, workspace, session, index. */
  private async stepIsolatedThread(step: MutableStep): Promise<void> {
    const master = this.master()
    await this.waitIdle(master)
    await this.promptStep(
      step,
      master,
      'master',
      `Call cowork_thread_create with subject "${FIXTURE_SUBJECT_1}", isolated true, and brief `
        + `"Wait: do not call cowork_handoff yet; read cowork_project_status, then stop. ${MASTER_DONE}". `
        + `The brief keeps the new thread from handing off before step 3 gives it work. ${MASTER_DONE}`,
    )
    const record = await this.poll('first isolated thread in the index', async () => {
      const index = await this.readIndex()
      if (index === undefined) return undefined
      const thread = index.threads.find((entry) => entry.subject === FIXTURE_SUBJECT_1)
      return thread !== undefined && typeof thread.checkoutPath === 'string'
        ? thread
        : undefined
    })
    const threadId = record.threadId
    const checkoutPath = record.checkoutPath as string
    this.thread1 = threadId
    this.thread1CheckoutPath = checkoutPath
    this.track(threadId)
    step.evidence.observations.threadId = threadId
    step.evidence.observations.checkoutPath = checkoutPath
    step.evidence.observations.indexStatus = record.status

    this.check(step, 'clone directory exists', existsSync(checkoutPath), checkoutPath)
    this.check(
      step,
      'clone .git is a directory',
      existsSync(join(checkoutPath, '.git')) && statSync(join(checkoutPath, '.git')).isDirectory(),
      join(checkoutPath, '.git'),
    )
    const branch = await this.gitObserved(step, ['branch', '--show-current'], checkoutPath)
    this.check(
      step,
      'clone is on cowork/<threadId>',
      branch.code === 0 && branch.stdout.trim() === `cowork/${threadId}`,
      `exit=${branch.code} branch=${branch.stdout.trim()}`,
    )
    const workspace = await this.host.workspaceRegistry.resolveByPath(checkoutPath)
    step.evidence.observations.workspaceId = workspace?.id ?? null
    this.check(step, 'checkout path is a registered workspace', workspace !== undefined, checkoutPath)
    const header = await this.host.sessionController.inspect(threadId)
    step.evidence.observations.sessionCwd = header.meta.cwd ?? null
    step.evidence.observations.sessionPreset = header.meta.agentPreset ?? null
    this.check(
      step,
      'thread session cwd equals the checkout path',
      header.meta.cwd === checkoutPath,
      `${String(header.meta.cwd)} == ${checkoutPath}`,
    )
    this.check(
      step,
      'index status is active',
      record.status === 'active',
      String(record.status),
    )
    await this.waitIdle(threadId)
  }

  /** Step 3: the thread commits inside its clone and hands off. */
  private async stepThreadWork(step: MutableStep): Promise<void> {
    const thread = this.thread1
    if (thread === null) throw new Error('first thread was not created')
    const checkoutPath = this.checkoutOf(thread)
    await this.waitIdle(thread)
    const startedAt = isoNow()
    await this.promptStep(
      step,
      thread,
      'thread',
      "Use the bash tool to run exactly: printf 'e2e\\n' > e2e.txt && "
        + 'git add e2e.txt && git commit -m "e2e thread work". '
        + 'Then call cowork_handoff with status "awaiting_review", summary "e2e thread work", '
        + 'verification [{command: "git log --oneline -1", exitCode: 0, evidence: "<the command output>"}]. '
        + MASTER_DONE,
    )
    const target = await this.poll('thread commit, clean clone, and handoff', async () => {
      const text = await readTextIfPresent(join(checkoutPath, 'e2e.txt'))
      if (text === undefined) return undefined
      const log = await runGit(['log', '-1', '--format=%s'], checkoutPath)
      if (log.code !== 0 || log.stdout.trim() !== 'e2e thread work') return undefined
      const status = await runGit(['status', '--porcelain'], checkoutPath)
      if (status.code !== 0 || status.stdout.trim() !== '') return undefined
      const index = await this.readIndex()
      const record = index?.threads.find((entry) => entry.threadId === thread)
      if (record?.status !== 'awaiting_review') return undefined
      const handoff = await this.waitHandoffAfter(startedAt, thread)
      return handoff === undefined ? undefined : { text, log, status, record, handoff }
    })
    step.evidence.observations.e2eTxt = clip(target.text, MAX_FILE_TEXT)
    step.evidence.observations.gitLog = clip(target.log.stdout, MAX_GIT_TEXT)
    step.evidence.observations.gitStatus = clip(target.status.stdout, MAX_GIT_TEXT)
    step.evidence.observations.indexStatus = target.record.status
    step.evidence.observations.handoffFile = target.handoff.filePath
    step.evidence.observations.handoff = target.handoff.record
    this.check(step, 'clone contains e2e.txt', target.text.includes('e2e'), join(checkoutPath, 'e2e.txt'))
    this.check(step, 'clone HEAD is the thread commit', target.log.stdout.trim() === 'e2e thread work', target.log.stdout.trim())
    this.check(step, 'clone working tree is clean', target.status.stdout.trim() === '', target.status.stdout)
    this.check(step, 'index status is awaiting_review', target.record.status === 'awaiting_review', target.record.status)
    this.check(step, 'handoff file exists for the thread', existsSync(target.handoff.filePath), target.handoff.filePath)
    await this.waitIdle(thread)
  }

  /** Step 4: the thread reads the constraint the master wrote (project memory crosses sessions). */
  private async stepMemoryCrossThread(step: MutableStep): Promise<void> {
    const thread = this.thread1
    if (thread === null) throw new Error('first thread was not created')
    await this.waitIdle(thread)
    const prompt = await this.promptStep(
      step,
      thread,
      'thread',
      'Call cowork_memory_search with query "提交信息" and reply with the first hit title. '
        + MASTER_DONE,
    )
    const hit = await this.poll('thread memory_search result containing the master constraint', async () => {
      const calls = this.toolCallsSince(thread, prompt.fromSeq, 'cowork_memory_search')
      return calls.find((call) => call.resultText !== null && call.resultText.includes(MEMORY_TITLE))
    })
    step.evidence.observations.memorySearchResult = clip(hit.resultText ?? '', MAX_TOOL_TEXT)
    this.check(
      step,
      'thread tool result contains the master constraint title',
      (hit.resultText ?? '').includes(MEMORY_TITLE),
      clip(hit.resultText ?? '', MAX_TOOL_TEXT),
    )
    await this.waitIdle(thread)
  }

  /** Step 5: merge the first thread, clean up, and prove the main worktree got the file. */
  private async stepMergeSuccess(step: MutableStep): Promise<void> {
    const master = this.master()
    const thread = this.thread1
    if (thread === null) throw new Error('first thread was not created')
    const checkoutPath = this.checkoutOf(thread)
    await this.waitAllIdle([master, thread])
    if (await this.mergeAlreadyDone(thread, checkoutPath, 'e2e.txt')) {
      step.evidence.note = 'merge target state was already reached before the prompt; passed idempotently'
      await this.assertMerged(step, thread, checkoutPath, 'e2e.txt')
      return
    }
    const prompt = await this.promptStep(
      step,
      master,
      'master',
      `Call cowork_checkout_merge with threadId "${thread}". ${MASTER_DONE}`,
    )
    await this.poll('first thread merged and torn down', async () => {
      const failed = this.latestToolFailure(master, prompt.fromSeq, MERGE_TOOL)
      if (failed !== undefined) throw new Error(`cowork_checkout_merge failed: ${failed}`)
      return (await this.mergeAlreadyDone(thread, checkoutPath, 'e2e.txt')) ? true : undefined
    })
    const call = await this.waitToolResult(master, prompt.fromSeq, MERGE_TOOL)
    const payload = this.parseToolJson(call)
    step.evidence.observations.mergeToolResult = clip(call.resultText ?? '', MAX_TOOL_TEXT)
    step.evidence.observations.mergePayload = payload ?? null
    this.check(step, 'cowork_checkout_merge returned ok', payload?.ok === true, clip(call.resultText ?? '', 1000))
    await this.assertMerged(step, thread, checkoutPath, 'e2e.txt')
    await this.waitIdle(master)
  }

  /** Step 6: create the second isolated thread, commit its side, and commit the conflicting main side. */
  private async stepConflictThread(step: MutableStep): Promise<void> {
    const master = this.master()
    await this.waitIdle(master)
    await this.promptStep(
      step,
      master,
      'master',
      `Call cowork_thread_create with subject "${FIXTURE_SUBJECT_2}", isolated true, and brief `
        + `"Wait: do not call cowork_handoff yet; read cowork_project_status, then stop. ${MASTER_DONE}". `
        + `The brief keeps the new thread from handing off before step 6 gives it work. ${MASTER_DONE}`,
    )
    const record = await this.poll('second isolated thread in the index', async () => {
      const index = await this.readIndex()
      if (index === undefined) return undefined
      const thread = index.threads.find((entry) => entry.subject === FIXTURE_SUBJECT_2)
      return thread !== undefined && typeof thread.checkoutPath === 'string' ? thread : undefined
    })
    const threadId = record.threadId
    const checkoutPath = record.checkoutPath as string
    this.thread2 = threadId
    this.thread2CheckoutPath = checkoutPath
    this.track(threadId)
    step.evidence.observations.threadId = threadId
    step.evidence.observations.checkoutPath = checkoutPath
    this.check(step, 'second clone directory exists', existsSync(checkoutPath), checkoutPath)
    const branch = await this.gitObserved(step, ['branch', '--show-current'], checkoutPath)
    this.check(
      step,
      'second clone is on cowork/<threadId>',
      branch.code === 0 && branch.stdout.trim() === `cowork/${threadId}`,
      `exit=${branch.code} branch=${branch.stdout.trim()}`,
    )
    const workspace = await this.host.workspaceRegistry.resolveByPath(checkoutPath)
    this.check(step, 'second checkout is a registered workspace', workspace !== undefined, checkoutPath)
    const header = await this.host.sessionController.inspect(threadId)
    this.check(
      step,
      'second thread session cwd equals the checkout path',
      header.meta.cwd === checkoutPath,
      `${String(header.meta.cwd)} == ${checkoutPath}`,
    )
    await this.waitIdle(threadId)

    const startedAt = isoNow()
    await this.promptStep(
      step,
      threadId,
      'thread',
      "Use the bash tool to run exactly: printf 'thread\\n' > conflict.txt && "
        + 'git add conflict.txt && git commit -m "e2e conflict thread". '
        + 'Then call cowork_handoff with status "awaiting_review", summary "e2e conflict thread", '
        + 'verification [{command: "git log --oneline -1", exitCode: 0, evidence: "<the command output>"}]. '
        + MASTER_DONE,
    )
    // Commit the main side as soon as the thread commit exists, while the thread
    // turn may still be running. The handoff later wakes the master on its own;
    // if the master merges eagerly, both sides have changed by then and the merge
    // conflicts instead of silently landing before this driver can create it.
    const commit = await this.poll('second thread conflict commit', async () => {
      const text = await readTextIfPresent(join(checkoutPath, 'conflict.txt'))
      if (text === undefined || text.trim() !== 'thread') return undefined
      const log = await runGit(['log', '-1', '--format=%s'], checkoutPath)
      if (log.code !== 0 || log.stdout.trim() !== 'e2e conflict thread') return undefined
      const status = await runGit(['status', '--porcelain'], checkoutPath)
      if (status.code !== 0 || status.stdout.trim() !== '') return undefined
      return { text, log, status }
    })
    step.evidence.observations.threadConflictText = commit.text
    step.evidence.observations.threadGitLog = clip(commit.log.stdout, MAX_GIT_TEXT)

    await writeFile(join(this.fixturePath, 'conflict.txt'), 'main\n', 'utf8')
    await this.gitOk(step, ['add', 'conflict.txt'], this.fixturePath, 'git add main conflict')
    await this.gitOk(step, ['commit', '-m', 'e2e main conflict'], this.fixturePath, 'git commit main conflict')
    const mainText = await this.readObserved(step, join(this.fixturePath, 'conflict.txt'))
    step.evidence.observations.mainConflictText = mainText ?? null
    this.check(step, 'main worktree has conflict.txt with main content', mainText?.trim() === 'main', String(mainText))

    const handedOff = await this.poll('second thread handoff after the two-sided commit', async () => {
      const index = await this.readIndex()
      const current = index?.threads.find((entry) => entry.threadId === threadId)
      if (current === undefined || (current.status !== 'awaiting_review' && current.status !== 'blocked')) {
        return undefined
      }
      const handoff = await this.waitHandoffAfter(startedAt, threadId)
      return handoff === undefined ? undefined : { record: current, handoff }
    })
    step.evidence.observations.threadHandoff = handedOff.handoff.record
    step.evidence.observations.handoffFile = handedOff.handoff.filePath
    step.evidence.observations.indexStatusAfterHandoff = handedOff.record.status
    this.check(step, 'second clone commit exists', commit.log.stdout.trim() === 'e2e conflict thread', commit.log.stdout.trim())
    this.check(step, 'second clone is clean', commit.status.stdout.trim() === '', commit.status.stdout)
    this.check(step, 'handoff file exists for the second thread', existsSync(handedOff.handoff.filePath), handedOff.handoff.filePath)
    if (handedOff.record.status === 'blocked') {
      step.evidence.note = 'the master merged eagerly after the handoff and hit the conflict; step 7 verifies that state'
    }
    await this.waitAllIdle([master, threadId])
  }

  /** Step 7: merge the second thread, expect a conflict, and prove the abort kept the clone. */
  private async stepConflictMerge(step: MutableStep): Promise<void> {
    const master = this.master()
    const thread = this.thread2
    if (thread === null) throw new Error('second thread was not created')
    const checkoutPath = this.checkoutOf(thread)
    await this.waitAllIdle([master, thread])
    const before = await this.threadRecord(thread)
    const mainTextBefore = await readTextIfPresent(join(this.fixturePath, 'conflict.txt'))
    const alreadyBlocked = before?.status === 'blocked'
      && existsSync(checkoutPath)
      && !existsSync(join(this.fixturePath, '.git', 'MERGE_HEAD'))
      && mainTextBefore?.trim() === 'main'
    let call: M2ToolCallEvidence | undefined
    if (alreadyBlocked) {
      step.evidence.note = 'the master already hit the conflict before this prompt; passed idempotently'
      call = this.latestToolResultAnywhere(master, MERGE_TOOL)
    } else {
      const prompt = await this.promptStep(
        step,
        master,
        'master',
        `Call cowork_checkout_merge with threadId "${thread}". ${MASTER_DONE}`,
      )
      const record = await this.poll('second thread marked blocked after the conflict', async () => {
        const calls = this.toolCallsSince(master, prompt.fromSeq, MERGE_TOOL)
        const latest = calls.filter((entry) => entry.resultText !== null).at(-1)
        if (latest !== undefined) {
          const payload = this.parseToolJson(latest)
          const code = asRecord(payload?.error)?.code
          if (payload?.ok === false && code !== 'checkout/merge-conflict') {
            throw new Error(`cowork_checkout_merge failed unexpectedly: ${clip(latest.resultText ?? '', 1000)}`)
          }
        }
        const index = await this.readIndex()
        const current = index?.threads.find((entry) => entry.threadId === thread)
        return current?.status === 'blocked' ? current : undefined
      })
      step.evidence.observations.indexStatus = record.status
      call = await this.waitToolResult(master, prompt.fromSeq, MERGE_TOOL)
    }
    const record = await this.threadRecord(thread)
    step.evidence.observations.indexStatus = record?.status ?? null
    this.check(step, 'index status is blocked', record?.status === 'blocked', String(record?.status))
    if (call === undefined) {
      step.evidence.observations.toolResult = 'no cowork_checkout_merge result observed (idempotent auto-merge path)'
      this.check(step, 'clone is retained after the conflict', existsSync(checkoutPath), checkoutPath)
      this.check(
        step,
        'no merge is left in progress in the main repository',
        !existsSync(join(this.fixturePath, '.git', 'MERGE_HEAD')),
        join(this.fixturePath, '.git', 'MERGE_HEAD'),
      )
      const statusWithoutCall = await this.gitObserved(step, ['status', '--porcelain'], this.fixturePath)
      this.check(step, 'main worktree has no unresolved conflict markers', statusWithoutCall.stdout.trim() === '', statusWithoutCall.stdout)
      await this.waitAllIdle([master, thread])
      return
    }
    const payload = this.parseToolJson(call)
    const error = asRecord(payload?.error)
    const details = asRecord(error?.details)
    const conflictFiles = Array.isArray(details?.conflictFiles) ? details.conflictFiles : []
    step.evidence.observations.mergeToolResult = clip(call.resultText ?? '', MAX_TOOL_TEXT)
    step.evidence.observations.conflictFiles = conflictFiles
    this.check(step, 'cowork_checkout_merge returned a failure', payload?.ok === false, clip(call.resultText ?? '', 1000))
    this.check(
      step,
      'merge failure code is checkout/merge-conflict',
      error?.code === 'checkout/merge-conflict',
      String(error?.code),
    )
    this.check(
      step,
      'conflictFiles contains conflict.txt',
      conflictFiles.includes('conflict.txt'),
      JSON.stringify(conflictFiles),
    )
    this.check(step, 'clone is retained after the conflict', existsSync(checkoutPath), checkoutPath)
    this.check(
      step,
      'no merge is left in progress in the main repository',
      !existsSync(join(this.fixturePath, '.git', 'MERGE_HEAD')),
      join(this.fixturePath, '.git', 'MERGE_HEAD'),
    )
    const status = await this.gitObserved(step, ['status', '--porcelain'], this.fixturePath)
    this.check(step, 'main worktree has no unresolved conflict markers', status.stdout.trim() === '', status.stdout)
    await this.waitAllIdle([master, thread])
  }

  /** Step 8: the thread resolves its side and the second merge succeeds. */
  private async stepConflictRetry(step: MutableStep): Promise<void> {
    const master = this.master()
    const thread = this.thread2
    if (thread === null) throw new Error('second thread was not created')
    const checkoutPath = this.checkoutOf(thread)
    await this.waitIdle(thread)
    const startedAt = isoNow()
    await this.promptStep(
      step,
      thread,
      'thread',
      'The merge of the main repository conflicted on conflict.txt. Use the bash tool to run these '
        + `commands one at a time: 1) git fetch ${this.fixturePath} main 2) git merge --no-ff FETCH_HEAD `
        + "(this conflicts) 3) printf 'resolved\\n' > conflict.txt 4) git add conflict.txt && "
        + 'git commit -m "resolve conflict". '
        + 'Then call cowork_handoff with status "awaiting_review", summary "resolved conflict", '
        + 'verification [{command: "git status --porcelain", exitCode: 0, evidence: "clean"}]. '
        + MASTER_DONE,
    )
    const target = await this.poll('thread resolved conflict and handed off', async () => {
      const text = await readTextIfPresent(join(checkoutPath, 'conflict.txt'))
      if (text === undefined || text.trim() !== 'resolved') return undefined
      if (existsSync(join(checkoutPath, '.git', 'MERGE_HEAD'))) return undefined
      const status = await runGit(['status', '--porcelain'], checkoutPath)
      if (status.code !== 0 || status.stdout.trim() !== '') return undefined
      const index = await this.readIndex()
      const record = index?.threads.find((entry) => entry.threadId === thread)
      if (record?.status !== 'awaiting_review') return undefined
      const handoff = await this.waitHandoffAfter(startedAt, thread)
      return handoff === undefined ? undefined : { text, status, record, handoff }
    })
    step.evidence.observations.resolvedText = target.text
    step.evidence.observations.cloneStatus = clip(target.status.stdout, MAX_GIT_TEXT)
    step.evidence.observations.indexStatus = target.record.status
    step.evidence.observations.handoffFile = target.handoff.filePath
    this.check(step, 'clone conflict.txt is resolved', target.text.trim() === 'resolved', target.text)
    this.check(step, 'thread merge is committed and clone is clean', target.status.stdout.trim() === '', target.status.stdout)
    this.check(step, 'retry handoff exists', existsSync(target.handoff.filePath), target.handoff.filePath)

    await this.waitAllIdle([master, thread])
    if (await this.mergeAlreadyDone(thread, checkoutPath, 'conflict.txt')) {
      step.evidence.note = 'retry merge target state was already reached before the prompt; passed idempotently'
      await this.assertMerged(step, thread, checkoutPath, 'conflict.txt')
      return
    }
    const prompt = await this.promptStep(
      step,
      master,
      'master',
      `Call cowork_checkout_merge with threadId "${thread}". ${MASTER_DONE}`,
    )
    await this.poll('retry merge succeeded and tore the checkout down', async () => {
      const failed = this.latestToolFailure(master, prompt.fromSeq, MERGE_TOOL)
      if (failed !== undefined) throw new Error(`retry cowork_checkout_merge failed: ${failed}`)
      return (await this.mergeAlreadyDone(thread, checkoutPath, 'conflict.txt')) ? true : undefined
    })
    const call = await this.waitToolResult(master, prompt.fromSeq, MERGE_TOOL)
    const payload = this.parseToolJson(call)
    step.evidence.observations.mergeToolResult = clip(call.resultText ?? '', MAX_TOOL_TEXT)
    this.check(step, 'retry merge returned ok', payload?.ok === true, clip(call.resultText ?? '', 1000))
    await this.assertMerged(step, thread, checkoutPath, 'conflict.txt')
    const mainText = await this.readObserved(step, join(this.fixturePath, 'conflict.txt'))
    this.check(step, 'main worktree conflict.txt is resolved', mainText?.trim() === 'resolved', String(mainText))
    await this.waitIdle(master)
  }

  /** Step 9: snapshot the final index, archive sessions, drop workspaces, delete the fixture. */
  private async stepCleanup(step: MutableStep, run: MutableRun): Promise<void> {
    const index = await this.readIndex()
    run.finalIndex = index ?? null
    step.evidence.observations.finalIndex = index ?? null
    const cleanup = {
      archived: [] as string[],
      archiveErrors: [] as string[],
      workspacesDeleted: [] as string[],
      workspaceErrors: [] as string[],
      tempRepoRemoved: false,
      errors: [] as string[],
    }
    run.cleanup = { ...run.cleanup, ...cleanup }

    for (const sessionId of this.sessionIds()) {
      try {
        await this.archiveSession(sessionId)
        cleanup.archived.push(sessionId)
      } catch (error) {
        cleanup.archiveErrors.push(`${sessionId}: ${messageOf(error)}`)
      }
    }

    const workspacePaths = new Set<string>([this.fixturePath])
    for (const thread of index?.threads ?? []) {
      if (typeof thread.checkoutPath === 'string') workspacePaths.add(thread.checkoutPath)
    }
    for (const path of workspacePaths) {
      if (path !== this.fixturePath && !isStrictlyInside(this.fixturePath, path)) {
        cleanup.errors.push(`skipped workspace outside the fixture: ${path}`)
        continue
      }
      let workspace: M2Workspace | undefined
      try {
        workspace = await this.host.workspaceRegistry.resolveByPath(path)
      } catch {
        workspace = undefined
      }
      if (workspace === undefined) continue
      try {
        const deleted = await this.host.workspaceRegistry.delete(workspace.id)
        cleanup.workspacesDeleted.push(`${workspace.id}:${path}:${deleted}`)
      } catch (error) {
        cleanup.workspaceErrors.push(`${workspace.id}: ${messageOf(error)}`)
      }
    }

    try {
      await rm(this.fixturePath, { recursive: true, force: true })
      cleanup.tempRepoRemoved = !existsSync(this.fixturePath)
    } catch (error) {
      cleanup.errors.push(`delete fixture: ${messageOf(error)}`)
    }
    run.cleanup = { ...run.cleanup, ...cleanup }
    step.evidence.observations.cleanup = cleanup
    this.check(step, 'temporary project removed', cleanup.tempRepoRemoved, this.fixturePath)
  }

  // --------------------------------------------------------------- assertion

  private check(step: MutableStep, check: string, passed: boolean, detail: unknown): void {
    let text: string
    if (typeof detail === 'string') {
      text = detail
    } else {
      try {
        text = JSON.stringify(detail)
      } catch {
        text = String(detail)
      }
    }
    step.evidence.assertions.push({ check, passed, detail: clip(text, MAX_FIELD_TEXT) })
    if (!passed) {
      throw new Error(`assertion failed [${step.id}] ${check}: ${clip(text, 500)}`)
    }
  }

  /** Assert the durable "merge finished" facts shared by both merge scenarios. */
  private async assertMerged(
    step: MutableStep,
    threadId: string,
    checkoutPath: string,
    fileName: string,
  ): Promise<void> {
    const mainPath = join(this.fixturePath, fileName)
    const content = await this.readObserved(step, mainPath)
    this.check(step, `${fileName} exists in the main worktree`, content !== undefined, mainPath)
    if (fileName === 'conflict.txt') {
      this.check(step, 'merged conflict.txt is resolved', content?.trim() === 'resolved', String(content))
    }
    this.check(step, 'clone directory removed', !existsSync(checkoutPath), checkoutPath)
    const branch = await this.gitObserved(
      step,
      ['rev-parse', '--verify', `refs/heads/cowork/${threadId}`],
      this.fixturePath,
    )
    this.check(
      step,
      'thread branch deleted from the main repository',
      branch.code !== 0,
      `exitCode=${branch.code}`,
    )
    let workspace: M2Workspace | undefined
    try {
      workspace = await this.host.workspaceRegistry.resolveByPath(checkoutPath)
    } catch {
      workspace = undefined
    }
    this.check(
      step,
      'checkout workspace removed',
      workspace === undefined,
      workspace?.id ?? 'undefined',
    )
    const index = await this.readIndex()
    const record = index?.threads.find((entry) => entry.threadId === threadId)
    step.evidence.observations.finalThreadRecord = record ?? null
    this.check(step, 'index checkoutPath is null', record?.checkoutPath === null, String(record?.checkoutPath))
    this.check(step, 'index status is done', record?.status === 'done', String(record?.status))
  }

  /** Whether the merge target is already durable; used to pass idempotently. */
  private async mergeAlreadyDone(
    threadId: string,
    checkoutPath: string,
    fileName: string,
  ): Promise<boolean> {
    const index = await this.readIndex()
    const record = index?.threads.find((entry) => entry.threadId === threadId)
    return record?.checkoutPath === null
      && record.status === 'done'
      && !existsSync(checkoutPath)
      && existsSync(join(this.fixturePath, fileName))
  }

  // ----------------------------------------------------------------- polling

  private async poll<T>(
    label: string,
    read: () => Promise<T | undefined>,
    timeoutMs = M2_E2E_STEP_TIMEOUT_MS,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.disposed) throw new Error('M2 E2E runner was disposed')
      const value = await read()
      if (value !== undefined) return value
      if (Date.now() >= deadline) {
        throw new Error(`timeout after ${timeoutMs}ms waiting for ${label}`)
      }
      await sleep(POLL_MS)
    }
  }

  private async waitIdle(sessionId: string, timeoutMs = M2_E2E_STEP_TIMEOUT_MS): Promise<void> {
    await this.poll(`session ${sessionId} to be idle`, async () => {
      const { items } = await this.host.sessionController.list({})
      const row = items.find((item) => item.sessionId === sessionId)
      return row !== undefined && row.running === false ? true : undefined
    }, timeoutMs)
  }

  /**
   * Wait until every named session is idle in the same observation. Handoff
   * wakes can start a fresh master or thread turn right after one session goes
   * idle, so a single session's idleness is not enough before a merge prompt.
   */
  private async waitAllIdle(sessionIds: readonly string[], timeoutMs = M2_E2E_STEP_TIMEOUT_MS): Promise<void> {
    await this.poll(`sessions ${sessionIds.join(', ')} to be idle`, async () => {
      const { items } = await this.host.sessionController.list({})
      const allIdle = sessionIds.every((sessionId) => {
        const row = items.find((item) => item.sessionId === sessionId)
        return row !== undefined && row.running === false
      })
      return allIdle ? true : undefined
    }, timeoutMs)
  }

  private async promptStep(
    step: MutableStep,
    sessionId: string,
    role: 'master' | 'thread',
    text: string,
  ): Promise<M2PromptEvidence> {
    const fromSeq = this.lastSeq(sessionId)
    const evidence: M2PromptEvidence = {
      sessionId,
      role,
      text,
      accepted: false,
      fromSeq,
      assistantText: '',
      toolCalls: [],
    }
    step.evidence.prompts.push(evidence)
    const result = await this.host.sessionController.prompt(
      {
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
      AbortSignal.timeout(this.config.promptTimeoutMs),
    )
    evidence.accepted = result.accepted
    this.check(step, `prompt accepted by ${role} session`, result.accepted === true, sessionId)
    return evidence
  }

  /** Fill each prompt's assistant text and tool calls from the captured event stream. */
  private refreshPrompts(step: MutableStep): void {
    for (const prompt of step.evidence.prompts) {
      prompt.assistantText = this.assistantTextSince(prompt.sessionId, prompt.fromSeq)
      prompt.toolCalls = this.toolCallsSince(prompt.sessionId, prompt.fromSeq)
    }
  }

  private lastSeq(sessionId: string): number {
    return (this.events.get(sessionId) ?? []).at(-1)?.seq ?? 0
  }

  private assistantTextSince(sessionId: string, fromSeq: number): string {
    const parts: string[] = []
    for (const event of this.events.get(sessionId) ?? []) {
      if (event.seq <= fromSeq || event.type !== 'assistant/message') continue
      const text = contentText(asRecord(event.data.message))
      if (text !== '') parts.push(text)
    }
    return clip(parts.join('\n'), MAX_ASSISTANT_TEXT)
  }

  private toolCallsSince(
    sessionId: string,
    fromSeq: number,
    name?: string,
  ): M2ToolCallEvidence[] {
    const calls = new Map<string, M2ToolCallEvidence>()
    for (const event of this.events.get(sessionId) ?? []) {
      if (event.seq <= fromSeq) continue
      if (event.type === 'tool/call') {
        const callName = typeof event.data.name === 'string' ? event.data.name : ''
        if (name !== undefined && callName !== name) continue
        const callId = typeof event.data.callId === 'string'
          ? event.data.callId
          : `seq-${event.seq}`
        calls.set(callId, {
          name: callName,
          callId,
          arguments: clip(String(event.data.arguments ?? ''), MAX_TOOL_ARGUMENTS),
          resultText: null,
          isError: null,
        })
        continue
      }
      if (event.type !== 'tool/result') continue
      const message = asRecord(event.data.message)
      const callId = typeof message?.toolCallId === 'string'
        ? message.toolCallId
        : typeof asRecord(message?.source)?.callId === 'string'
          ? String(asRecord(message?.source)?.callId)
          : undefined
      if (callId === undefined) continue
      const call = calls.get(callId)
      if (call === undefined) continue
      call.resultText = clip(contentText(message), MAX_TOOL_TEXT)
      const error = asRecord(event.data.error)
      call.isError = message?.isError === true || error !== undefined
      if (typeof error?.code === 'string') call.errorCode = error.code
    }
    return [...calls.values()]
  }

  private async waitToolResult(
    sessionId: string,
    fromSeq: number,
    name: string,
  ): Promise<M2ToolCallEvidence> {
    return this.poll(`tool ${name} result on ${sessionId}`, async () => {
      const calls = this.toolCallsSince(sessionId, fromSeq, name)
      return calls.filter((call) => call.resultText !== null).at(-1)
    })
  }

  private parseToolJson(call: M2ToolCallEvidence): Record<string, unknown> | undefined {
    if (call.resultText === null) return undefined
    try {
      return asRecord(JSON.parse(call.resultText))
    } catch {
      return undefined
    }
  }

  /** The latest failed tool result text, used to fail a wait early instead of timing out. */
  private latestToolFailure(sessionId: string, fromSeq: number, name: string): string | undefined {
    const last = this.toolCallsSince(sessionId, fromSeq, name)
      .filter((call) => call.resultText !== null)
      .at(-1)
    if (last === undefined) return undefined
    return this.parseToolJson(last)?.ok === false ? clip(last.resultText ?? '', 1000) : undefined
  }

  /** The latest completed result for one tool over the whole buffered session. */
  private latestToolResultAnywhere(sessionId: string, name: string): M2ToolCallEvidence | undefined {
    return this.toolCallsSince(sessionId, 0, name)
      .filter((call) => call.resultText !== null)
      .at(-1)
  }

  private async threadRecord(threadId: string): Promise<IndexThread | undefined> {
    const index = await this.readIndex()
    return index?.threads.find((entry) => entry.threadId === threadId)
  }

  // ---------------------------------------------------------------- fixtures

  /** The fixture must be exactly the documented path, never a computed escape. */
  private assertFixturePath(path: string): void {
    const expected = join(resolve(this.config.repoPath), M2_E2E_FIXTURE_RELATIVE)
    if (resolve(path) !== expected) {
      throw new Error(`refusing to use fixture path ${resolve(path)}; expected ${expected}`)
    }
  }

  private async readIndex(): Promise<IndexView | undefined> {
    const text = await readTextIfPresent(join(this.fixturePath, '.dsh-cowork', 'index.json'))
    if (text === undefined) return undefined
    try {
      const parsed = asRecord(JSON.parse(text))
      if (
        parsed !== undefined
        && typeof parsed.masterSessionId === 'string'
        && Array.isArray(parsed.threads)
      ) {
        return parsed as unknown as IndexView
      }
    } catch {
      // A half-written file during a poll is transient; report absence.
    }
    return undefined
  }

  private async readObserved(step: MutableStep, path: string): Promise<string | undefined> {
    const text = await readTextIfPresent(path)
    const files = (step.evidence.observations.files as unknown[]) ?? []
    files.push({ path, exists: text !== undefined, text: clip(text ?? '', MAX_FILE_TEXT) })
    step.evidence.observations.files = files
    return text
  }

  private async listHandoffs(): Promise<HandoffView[]> {
    const directory = join(this.fixturePath, '.dsh-cowork', 'handoffs')
    let names: string[]
    try {
      names = await readdir(directory)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return []
      throw error
    }
    const files: HandoffView[] = []
    for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
      const filePath = join(directory, name)
      try {
        const record = asRecord(JSON.parse(await readFile(filePath, 'utf8')))
        if (record === undefined || typeof record.threadId !== 'string') continue
        if (typeof record.status !== 'string' || typeof record.summary !== 'string') continue
        files.push({
          filePath,
          record: record as unknown as HandoffView['record'],
        })
      } catch {
        // A handoff being atomically replaced is transient; the next poll sees it.
      }
    }
    return files
  }

  private async waitHandoffAfter(startedAt: string, threadId: string): Promise<HandoffView | undefined> {
    const files = await this.listHandoffs()
    return files.find((file) => file.record.threadId === threadId && file.record.createdAt >= startedAt)
  }

  private async git(args: readonly string[], cwd: string): Promise<GitOutcome> {
    return runGit(args, cwd)
  }

  /** Run git and record command + raw output in the step evidence. */
  private async gitObserved(step: MutableStep, args: readonly string[], cwd: string): Promise<GitOutcome> {
    const result = await this.git(args, cwd)
    const commands = (step.evidence.observations.git as unknown[]) ?? []
    commands.push({
      args: [...args],
      cwd,
      exitCode: result.code,
      stdout: clip(result.stdout, MAX_GIT_TEXT),
      stderr: clip(result.stderr, MAX_GIT_TEXT),
    })
    step.evidence.observations.git = commands
    return result
  }

  private async gitOk(
    step: MutableStep,
    args: readonly string[],
    cwd: string,
    label: string,
  ): Promise<GitOutcome> {
    const result = await this.gitObserved(step, args, cwd)
    if (result.code !== 0) {
      throw new Error(`${label} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`)
    }
    return result
  }

  private async stateSnapshot(): Promise<Record<string, unknown>> {
    const index = await this.readIndex()
    return {
      fixtureExists: existsSync(this.fixturePath),
      masterSessionId: index?.masterSessionId ?? null,
      threads: (index?.threads ?? []).map((thread) => ({
        threadId: thread.threadId,
        status: thread.status,
        checkoutPath: thread.checkoutPath,
        cloneExists: typeof thread.checkoutPath === 'string' && existsSync(thread.checkoutPath),
      })),
    }
  }

  private async safeSnapshot(): Promise<Record<string, unknown>> {
    try {
      return await this.stateSnapshot()
    } catch (error) {
      return { error: messageOf(error) }
    }
  }

  // ------------------------------------------------------------------ helpers

  private master(): string {
    if (this.masterSessionId === null) throw new Error('master session was not created')
    return this.masterSessionId
  }

  private checkoutOf(threadId: string): string {
    if (threadId === this.thread1 && this.thread1CheckoutPath !== null) return this.thread1CheckoutPath
    if (threadId === this.thread2 && this.thread2CheckoutPath !== null) return this.thread2CheckoutPath
    throw new Error(`no checkout recorded for thread ${threadId}`)
  }

  private sessionIds(): string[] {
    const ids = [this.masterSessionId, this.thread1, this.thread2].filter(
      (id): id is string => id !== null,
    )
    return [...new Set(ids)]
  }

  private track(sessionId: string): void {
    this.trackedSessions.add(sessionId)
    if (!this.events.has(sessionId)) this.events.set(sessionId, [])
  }

  private releaseSessions(): void {
    for (const sessionId of this.trackedSessions) this.events.delete(sessionId)
    this.trackedSessions.clear()
  }

  private async archiveSession(sessionId: string): Promise<void> {
    await this.host.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
  }

  /** Best-effort session archival; used even when the run failed before cleanup. */
  private async safeArchiveSessions(run: MutableRun): Promise<void> {
    const errors: string[] = []
    for (const sessionId of this.sessionIds()) {
      try {
        await this.archiveSession(sessionId)
      } catch (error) {
        errors.push(`${sessionId}: ${messageOf(error)}`)
      }
    }
    if (errors.length > 0) {
      run.cleanup = { ...run.cleanup, autoArchiveErrors: errors }
    }
  }

  private async persist(run: MutableRun): Promise<void> {
    const document: M2E2EEvidenceDocument = {
      version: 1,
      runId: run.runId,
      state: run.state,
      startedAt: run.startedAt,
      endedAt: run.endedAt ?? null,
      host: {
        plugin: this.config.pluginName,
        pluginVersion: this.config.pluginVersion,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        hostname: hostname(),
        repoPath: this.config.repoPath,
      },
      steps: JSON.parse(JSON.stringify(run.steps)) as M2StepView[],
      finalIndex: run.finalIndex,
      cleanup: run.cleanup,
      ...(run.error === undefined ? {} : { error: run.error }),
    }
    try {
      await mkdir(dirname(this.evidenceFile), { recursive: true, mode: 0o700 })
      await writeStoreAtomic(this.evidenceFile, `${JSON.stringify(document, null, 2)}\n`)
    } catch (error) {
      // Evidence persistence is a convenience for the status route after a
      // reload; the live in-memory run remains authoritative.
      this.config.log?.(`M2 E2E evidence write failed: ${messageOf(error)}`)
    }
  }
}
