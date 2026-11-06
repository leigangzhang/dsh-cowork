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
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { writeStoreAtomic } from './probe-store.js'
import { MASTER_PRESET_ID } from './presets.js'
import {
  FIXTURE_SUBJECT_1,
  FIXTURE_SUBJECT_2,
  MASTER_DONE,
  MAX_ASSISTANT_TEXT,
  MAX_EVENTS,
  MAX_FILE_TEXT,
  MAX_GIT_TEXT,
  MAX_TOOL_TEXT,
  MEMORY_TEXT,
  MEMORY_TITLE,
  MERGE_TOOL,
  M2_E2E_EVIDENCE_RELATIVE,
  M2_E2E_FIXTURE_RELATIVE,
  M2_E2E_STEP_TIMEOUT_MS,
  POLL_MS,
  STEP_IDS,
  asRecord,
  assistantTextSince,
  clip,
  contentText,
  evidenceDocument,
  gitOkObserved,
  isoNow,
  isStrictlyInside,
  lastSeq,
  memoryVisibilityChecks,
  memoryVisiblePrompt,
  messageOf,
  observeGit,
  parseIndex,
  persistEvidence,
  readHandoffs,
  readObserved,
  readTextIfPresent,
  recordAssertion,
  runGit,
  sleep,
  stateSnapshot,
  statusView,
  toolCallsSince,
} from './m2-e2e-support.js'
import type {
  GitOutcome,
  HandoffView,
  IndexThread,
  IndexView,
  M2E2EConfig,
  M2E2EEvidenceDocument,
  M2E2EHost,
  M2E2EStatusView,
  M2PromptEvidence,
  M2RunState,
  M2SessionEvent,
  M2ToolCallEvidence,
  M2Workspace,
  MutableRun,
  MutableStep,
} from './m2-e2e-support.js'
// The support module owns the shared types and constants; re-export the ones
// this module exported before the split so importers (src/index.ts) keep working.
export {
  M2_E2E_EVIDENCE_RELATIVE,
  M2_E2E_FIXTURE_RELATIVE,
  M2_E2E_STEP_TIMEOUT_MS,
} from './m2-e2e-support.js'
export type {
  M2Assertion,
  M2E2EConfig,
  M2E2EEvidenceDocument,
  M2E2EHost,
  M2E2EStatusView,
  M2PromptEvidence,
  M2RunState,
  M2SessionEvent,
  M2SessionHeader,
  M2SessionRow,
  M2StepEvidence,
  M2StepStatus,
  M2StepView,
  M2ToolCallEvidence,
  M2Workspace,
} from './m2-e2e-support.js'


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
    return run === undefined ? undefined : statusView(run, this.evidenceFile)
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
      case 'memory-visible': return this.stepMemoryVisible(step)
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

    await gitOkObserved(step, ['init', '-b', 'main'], repo, 'git init')
    await gitOkObserved(step, ['config', 'user.email', 'e2e@dsh-cowork.invalid'], repo, 'git config email')
    await gitOkObserved(step, ['config', 'user.name', 'dsh-cowork e2e'], repo, 'git config name')
    await writeFile(join(repo, 'README.md'), '# M2 E2E fixture\n', 'utf8')
    await writeFile(join(repo, '.gitignore'), '.dsh-cowork/\n', 'utf8')
    await gitOkObserved(step, ['add', 'README.md', '.gitignore'], repo, 'git add')
    await gitOkObserved(step, ['commit', '-m', 'init'], repo, 'git commit')

    const created = await this.host.sessionController.create({
      cwd: repo,
      agentPreset: MASTER_PRESET_ID,
    })
    this.masterSessionId = created.sessionId
    this.track(created.sessionId)
    run.cleanup.masterSessionId = created.sessionId
    step.evidence.observations.masterSessionId = created.sessionId
    step.evidence.observations.createReturnedPreset = created.agentPreset ?? null
    recordAssertion(
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
    recordAssertion(
      step,
      'index file exists',
      existsSync(join(repo, '.dsh-cowork', 'index.json')),
      join(repo, '.dsh-cowork', 'index.json'),
    )
    recordAssertion(
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
    recordAssertion(step, 'constraints.md contains the entry title', content.includes(MEMORY_TITLE), file)
    recordAssertion(step, 'constraints.md contains the entry text', content.includes(MEMORY_TEXT), file)
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

    recordAssertion(step, 'clone directory exists', existsSync(checkoutPath), checkoutPath)
    recordAssertion(
      step,
      'clone .git is a directory',
      existsSync(join(checkoutPath, '.git')) && statSync(join(checkoutPath, '.git')).isDirectory(),
      join(checkoutPath, '.git'),
    )
    const branch = await observeGit(step, ['branch', '--show-current'], checkoutPath)
    recordAssertion(
      step,
      'clone is on cowork/<threadId>',
      branch.code === 0 && branch.stdout.trim() === `cowork/${threadId}`,
      `exit=${branch.code} branch=${branch.stdout.trim()}`,
    )
    const workspace = await this.host.workspaceRegistry.resolveByPath(checkoutPath)
    step.evidence.observations.workspaceId = workspace?.id ?? null
    recordAssertion(step, 'checkout path is a registered workspace', workspace !== undefined, checkoutPath)
    const header = await this.host.sessionController.inspect(threadId)
    step.evidence.observations.sessionCwd = header.meta.cwd ?? null
    step.evidence.observations.sessionPreset = header.meta.agentPreset ?? null
    recordAssertion(
      step,
      'thread session cwd equals the checkout path',
      header.meta.cwd === checkoutPath,
      `${String(header.meta.cwd)} == ${checkoutPath}`,
    )
    recordAssertion(
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
    recordAssertion(step, 'clone contains e2e.txt', target.text.includes('e2e'), join(checkoutPath, 'e2e.txt'))
    recordAssertion(step, 'clone HEAD is the thread commit', target.log.stdout.trim() === 'e2e thread work', target.log.stdout.trim())
    recordAssertion(step, 'clone working tree is clean', target.status.stdout.trim() === '', target.status.stdout)
    recordAssertion(step, 'index status is awaiting_review', target.record.status === 'awaiting_review', target.record.status)
    recordAssertion(step, 'handoff file exists for the thread', existsSync(target.handoff.filePath), target.handoff.filePath)
    await this.waitIdle(thread)
  }

  /** Step 4: prove the master's constraint is visible to the model, not just to disk. */
  private async stepMemoryVisible(step: MutableStep): Promise<void> {
    const thread = this.thread1
    if (thread === null) throw new Error('first thread was not created')
    await this.waitIdle(thread)
    const prompt = await this.promptStep(
      step,
      thread,
      'thread',
      // Title-only prompt: the expected text lives in the system prompt's
      // memory block, never in the prompt (see memoryVisiblePrompt).
      memoryVisiblePrompt(),
    )
    const reply = await this.poll('thread reply containing the constraint text', async () => {
      const text = this.assistantTextSince(thread, prompt.fromSeq)
      return text.includes(MEMORY_TEXT) ? text : undefined
    })
    const toolCallCount = this.toolCallsSince(thread, prompt.fromSeq).length
    step.evidence.observations.assistantSummary = clip(reply, MAX_ASSISTANT_TEXT)
    step.evidence.observations.toolCallCount = toolCallCount
    for (const check of memoryVisibilityChecks(reply, toolCallCount, MEMORY_TEXT)) {
      recordAssertion(step, check.check, check.passed, check.detail)
    }
    await this.waitIdle(thread)
  }

  /** Step 5: the thread reads the constraint the master wrote (project memory crosses sessions). */
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
    recordAssertion(
      step,
      'thread tool result contains the master constraint title',
      (hit.resultText ?? '').includes(MEMORY_TITLE),
      clip(hit.resultText ?? '', MAX_TOOL_TEXT),
    )
    await this.waitIdle(thread)
  }

  /** Step 6: merge the first thread, clean up, and prove the main worktree got the file. */
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
      `Call cowork_checkout_merge with threadId "${thread}", allowUnreviewed true, overrideReason "M2 E2E lane predates the M3 review gate". ${MASTER_DONE}`,
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
    recordAssertion(step, 'cowork_checkout_merge returned ok', payload?.ok === true, clip(call.resultText ?? '', 1000))
    await this.assertMerged(step, thread, checkoutPath, 'e2e.txt')
    await this.waitIdle(master)
  }

  /** Step 7: create the second isolated thread, commit its side, and commit the conflicting main side. */
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
    recordAssertion(step, 'second clone directory exists', existsSync(checkoutPath), checkoutPath)
    const branch = await observeGit(step, ['branch', '--show-current'], checkoutPath)
    recordAssertion(
      step,
      'second clone is on cowork/<threadId>',
      branch.code === 0 && branch.stdout.trim() === `cowork/${threadId}`,
      `exit=${branch.code} branch=${branch.stdout.trim()}`,
    )
    const workspace = await this.host.workspaceRegistry.resolveByPath(checkoutPath)
    recordAssertion(step, 'second checkout is a registered workspace', workspace !== undefined, checkoutPath)
    const header = await this.host.sessionController.inspect(threadId)
    recordAssertion(
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
    await gitOkObserved(step, ['add', 'conflict.txt'], this.fixturePath, 'git add main conflict')
    await gitOkObserved(step, ['commit', '-m', 'e2e main conflict'], this.fixturePath, 'git commit main conflict')
    const mainText = await readObserved(step, join(this.fixturePath, 'conflict.txt'))
    step.evidence.observations.mainConflictText = mainText ?? null
    recordAssertion(step, 'main worktree has conflict.txt with main content', mainText?.trim() === 'main', String(mainText))

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
    recordAssertion(step, 'second clone commit exists', commit.log.stdout.trim() === 'e2e conflict thread', commit.log.stdout.trim())
    recordAssertion(step, 'second clone is clean', commit.status.stdout.trim() === '', commit.status.stdout)
    recordAssertion(step, 'handoff file exists for the second thread', existsSync(handedOff.handoff.filePath), handedOff.handoff.filePath)
    if (handedOff.record.status === 'blocked') {
      step.evidence.note = 'the master merged eagerly after the handoff and hit the conflict; step 7 verifies that state'
    }
    await this.waitAllIdle([master, threadId])
  }

  /** Step 8: merge the second thread, expect a conflict, and prove the abort kept the clone. */
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
        `Call cowork_checkout_merge with threadId "${thread}", allowUnreviewed true, overrideReason "M2 E2E lane predates the M3 review gate". ${MASTER_DONE}`,
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
    recordAssertion(step, 'index status is blocked', record?.status === 'blocked', String(record?.status))
    if (call === undefined) {
      step.evidence.observations.toolResult = 'no cowork_checkout_merge result observed (idempotent auto-merge path)'
      recordAssertion(step, 'clone is retained after the conflict', existsSync(checkoutPath), checkoutPath)
      recordAssertion(
        step,
        'no merge is left in progress in the main repository',
        !existsSync(join(this.fixturePath, '.git', 'MERGE_HEAD')),
        join(this.fixturePath, '.git', 'MERGE_HEAD'),
      )
      const statusWithoutCall = await observeGit(step, ['status', '--porcelain'], this.fixturePath)
      recordAssertion(step, 'main worktree has no unresolved conflict markers', statusWithoutCall.stdout.trim() === '', statusWithoutCall.stdout)
      await this.waitAllIdle([master, thread])
      return
    }
    const payload = this.parseToolJson(call)
    const error = asRecord(payload?.error)
    const details = asRecord(error?.details)
    const conflictFiles = Array.isArray(details?.conflictFiles) ? details.conflictFiles : []
    step.evidence.observations.mergeToolResult = clip(call.resultText ?? '', MAX_TOOL_TEXT)
    step.evidence.observations.conflictFiles = conflictFiles
    recordAssertion(step, 'cowork_checkout_merge returned a failure', payload?.ok === false, clip(call.resultText ?? '', 1000))
    recordAssertion(
      step,
      'merge failure code is checkout/merge-conflict',
      error?.code === 'checkout/merge-conflict',
      String(error?.code),
    )
    recordAssertion(
      step,
      'conflictFiles contains conflict.txt',
      conflictFiles.includes('conflict.txt'),
      JSON.stringify(conflictFiles),
    )
    recordAssertion(step, 'clone is retained after the conflict', existsSync(checkoutPath), checkoutPath)
    recordAssertion(
      step,
      'no merge is left in progress in the main repository',
      !existsSync(join(this.fixturePath, '.git', 'MERGE_HEAD')),
      join(this.fixturePath, '.git', 'MERGE_HEAD'),
    )
    const status = await observeGit(step, ['status', '--porcelain'], this.fixturePath)
    recordAssertion(step, 'main worktree has no unresolved conflict markers', status.stdout.trim() === '', status.stdout)
    await this.waitAllIdle([master, thread])
  }

  /** Step 9: the thread resolves its side and the second merge succeeds. */
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
    recordAssertion(step, 'clone conflict.txt is resolved', target.text.trim() === 'resolved', target.text)
    recordAssertion(step, 'thread merge is committed and clone is clean', target.status.stdout.trim() === '', target.status.stdout)
    recordAssertion(step, 'retry handoff exists', existsSync(target.handoff.filePath), target.handoff.filePath)

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
      `Call cowork_checkout_merge with threadId "${thread}", allowUnreviewed true, overrideReason "M2 E2E lane predates the M3 review gate". ${MASTER_DONE}`,
    )
    await this.poll('retry merge succeeded and tore the checkout down', async () => {
      const failed = this.latestToolFailure(master, prompt.fromSeq, MERGE_TOOL)
      if (failed !== undefined) throw new Error(`retry cowork_checkout_merge failed: ${failed}`)
      return (await this.mergeAlreadyDone(thread, checkoutPath, 'conflict.txt')) ? true : undefined
    })
    const call = await this.waitToolResult(master, prompt.fromSeq, MERGE_TOOL)
    const payload = this.parseToolJson(call)
    step.evidence.observations.mergeToolResult = clip(call.resultText ?? '', MAX_TOOL_TEXT)
    recordAssertion(step, 'retry merge returned ok', payload?.ok === true, clip(call.resultText ?? '', 1000))
    await this.assertMerged(step, thread, checkoutPath, 'conflict.txt')
    const mainText = await readObserved(step, join(this.fixturePath, 'conflict.txt'))
    recordAssertion(step, 'main worktree conflict.txt is resolved', mainText?.trim() === 'resolved', String(mainText))
    await this.waitIdle(master)
  }

  /** Step 10: snapshot the final index, archive sessions, drop workspaces, delete the fixture. */
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
    recordAssertion(step, 'temporary project removed', cleanup.tempRepoRemoved, this.fixturePath)
  }

  // --------------------------------------------------------------- assertion

  /** Assert the durable "merge finished" facts shared by both merge scenarios. */
  private async assertMerged(
    step: MutableStep,
    threadId: string,
    checkoutPath: string,
    fileName: string,
  ): Promise<void> {
    const mainPath = join(this.fixturePath, fileName)
    const content = await readObserved(step, mainPath)
    recordAssertion(step, `${fileName} exists in the main worktree`, content !== undefined, mainPath)
    if (fileName === 'conflict.txt') {
      recordAssertion(step, 'merged conflict.txt is resolved', content?.trim() === 'resolved', String(content))
    }
    recordAssertion(step, 'clone directory removed', !existsSync(checkoutPath), checkoutPath)
    const branch = await observeGit(
      step,
      ['rev-parse', '--verify', `refs/heads/cowork/${threadId}`],
      this.fixturePath,
    )
    recordAssertion(
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
    recordAssertion(
      step,
      'checkout workspace removed',
      workspace === undefined,
      workspace?.id ?? 'undefined',
    )
    const index = await this.readIndex()
    const record = index?.threads.find((entry) => entry.threadId === threadId)
    step.evidence.observations.finalThreadRecord = record ?? null
    recordAssertion(step, 'index checkoutPath is null', record?.checkoutPath === null, String(record?.checkoutPath))
    recordAssertion(step, 'index status is done', record?.status === 'done', String(record?.status))
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
    recordAssertion(step, `prompt accepted by ${role} session`, result.accepted === true, sessionId)
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
    return lastSeq(this.events.get(sessionId) ?? [])
  }

  private assistantTextSince(sessionId: string, fromSeq: number): string {
    return assistantTextSince(this.events.get(sessionId) ?? [], fromSeq)
  }

  private toolCallsSince(
    sessionId: string,
    fromSeq: number,
    name?: string,
  ): M2ToolCallEvidence[] {
    return toolCallsSince(this.events.get(sessionId) ?? [], fromSeq, name)
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
    return text === undefined ? undefined : parseIndex(text)
  }

  private async listHandoffs(): Promise<HandoffView[]> {
    return readHandoffs(this.fixturePath)
  }

  private async waitHandoffAfter(startedAt: string, threadId: string): Promise<HandoffView | undefined> {
    const files = await this.listHandoffs()
    return files.find((file) => file.record.threadId === threadId && file.record.createdAt >= startedAt)
  }

  private async safeSnapshot(): Promise<Record<string, unknown>> {
    try {
      return stateSnapshot(await this.readIndex(), this.fixturePath)
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
    const document = evidenceDocument(
      {
        pluginName: this.config.pluginName,
        pluginVersion: this.config.pluginVersion,
        repoPath: this.config.repoPath,
      },
      run,
    )
    await persistEvidence(document, this.evidenceFile, writeStoreAtomic, this.config.log)
  }
}
