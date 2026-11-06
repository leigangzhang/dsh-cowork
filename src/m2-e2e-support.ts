/**
 * Shared types, constants, and pure helpers for the M2 real-host E2E driver.
 *
 * This module carries no value imports from the rest of the plugin: everything
 * here is either a Node built-in call or a pure function, so the step ids,
 * clipping rules, and evidence document can be asserted under plain
 * `node --test` without mounting a host. src/m2-e2e.ts keeps only the runner
 * class and the ten scenario steps; both files stay below the 50 KB per-file
 * budget.
 *
 * The evidence document deliberately has no hostname field: evidence is
 * committed and shared, and the machine name is neither needed to reproduce a
 * run nor safe to publish.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'

/** Evidence file, relative to the plugin's default repository root. */
export const M2_E2E_EVIDENCE_RELATIVE = '.dsh-cowork/e2e/M2_E2E.json'
/** Throwaway project root, relative to the plugin's default repository root. */
export const M2_E2E_FIXTURE_RELATIVE = '.dsh-cowork/e2e/m2-repo'
/** Upper bound for one E2E step (including its polling). */
export const M2_E2E_STEP_TIMEOUT_MS = 180_000
/** Poll interval; state is polled, never replaced by a fixed sleep. */
export const POLL_MS = 500
/** Per-session event buffer bound. */
export const MAX_EVENTS = 4000
/** Clipping bounds for evidence text. */
export const MAX_ASSISTANT_TEXT = 1000
export const MAX_TOOL_ARGUMENTS = 4000
export const MAX_TOOL_TEXT = 4000
export const MAX_FILE_TEXT = 2000
export const MAX_GIT_TEXT = 2000
export const MAX_FIELD_TEXT = 3000
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

/**
 * Evidence document written at every step boundary and at the end.
 *
 * `host` intentionally has no hostname: the document is committed and shared,
 * and the machine name is neither needed to reproduce a run nor safe to
 * publish. Everything here is host identity by role, not by machine.
 */
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
    readonly repoPath: string
  }
  readonly steps: readonly M2StepView[]
  readonly finalIndex: unknown
  readonly cleanup: Record<string, unknown>
  readonly error?: string
}

/** A thread record as the index stores it. */
export interface IndexThread {
  readonly threadId: string
  readonly subject: string
  readonly status: string
  readonly checkoutPath: string | null
  readonly [key: string]: unknown
}

/** The slice of the project index this driver reads. */
export interface IndexView {
  readonly masterSessionId: string
  readonly threads: readonly IndexThread[]
  readonly [key: string]: unknown
}

/** One handoff file read from disk. */
export interface HandoffView {
  readonly filePath: string
  readonly record: {
    readonly threadId: string
    readonly status: string
    readonly summary: string
    readonly createdAt: string
    readonly [key: string]: unknown
  }
}

export interface MutableStep {
  readonly id: string
  status: M2StepStatus
  readonly evidence: M2StepEvidence
}

export interface MutableRun {
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
export interface GitOutcome {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** The ordered steps; a failure stops the run and leaves later steps pending. */
export const STEP_IDS = [
  'setup',
  'memory-write',
  'isolated-thread',
  'thread-work',
  'memory-visible',
  'memory-cross-thread',
  'merge-success',
  'conflict-thread',
  'conflict-merge',
  'conflict-retry',
  'cleanup',
] as const

export const MERGE_TOOL = 'cowork_checkout_merge'
export const MASTER_DONE = 'Reply DONE.'
export const FIXTURE_SUBJECT_1 = 'E2E 隔离线程'
export const FIXTURE_SUBJECT_2 = 'E2E 冲突线程'
/** Title of the constraint the E2E writes; the only memory hint a prompt gets. */
export const MEMORY_TITLE = 'E2E 约束'

/**
 * Text of the E2E constraint.
 *
 * The `M2-E2E-CONSTRAINT-7F3A` nonce makes the value unguessable: a model that
 * never saw the memory block cannot reproduce it from prior knowledge, so a
 * verbatim reply is evidence that the block reached the system prompt. It keeps
 * 提交信息 so the cross-thread memory search query still matches.
 */
export const MEMORY_TEXT = 'M2-E2E-CONSTRAINT-7F3A: 所有提交信息用中文'

/**
 * Prompt for the model-visible memory step.
 *
 * It names only the constraint's title and where it lives (the system prompt).
 * It must never interpolate {@link MEMORY_TEXT} or any other expected reply: a
 * prompt carrying the expected text would let a model copy it back without the
 * memory ever reaching its system prompt, and the step would prove nothing.
 */
export function memoryVisiblePrompt(memoryTitle: string = MEMORY_TITLE): string {
  return `Do not call any tool. The project memory is already rendered in your system prompt. `
    + `Find the constraint titled "${memoryTitle}" there and reply with its text `
    + 'verbatim, on one line, with nothing else.'
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

export function isoNow(): string {
  return new Date().toISOString()
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

export function sleep(ms: number): Promise<void> {
  return new Promise((settle) => setTimeout(settle, ms))
}

/** Pad a path check with a trailing separator so `/a/b` never matches `/a/bc`. */
export function isStrictlyInside(parent: string, child: string): boolean {
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
}

/** Read a UTF-8 file, treating a missing path as `undefined` and other errors as failures. */
export async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
}

/** Model-facing tool result text: text blocks joined, other blocks JSON-serialized. */
export function contentText(message: unknown): string {
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
export function runGit(args: readonly string[], cwd: string): Promise<GitOutcome> {
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

/** One assertion computed from a model-visible fact, before it is recorded. */
export interface M2MemoryVisibilityCheck {
  readonly check: string
  readonly passed: boolean
  readonly detail: string
}

/**
 * The two assertions of the model-visible memory step.
 *
 * Pure on purpose: the step itself needs a live host and a live model, so the
 * "the reply contains the constraint and no tool was called" rule is kept here
 * where `node --test` can prove both the passing and the failing shape.
 */
export function memoryVisibilityChecks(
  assistantText: string,
  toolCallCount: number,
  memoryText: string = MEMORY_TEXT,
): M2MemoryVisibilityCheck[] {
  return [
    {
      check: 'thread reply contains the constraint text',
      passed: assistantText.includes(memoryText),
      detail: clip(assistantText, MAX_ASSISTANT_TEXT),
    },
    {
      check: 'no tool was called to answer the constraint prompt',
      passed: toolCallCount === 0,
      detail: `toolCalls=${toolCallCount}`,
    },
  ]
}

/**
 * Serialise one run into the status view returned by the status route.
 *
 * The run is deep-cloned through JSON so a caller cannot mutate the runner's
 * in-memory state, and so the view matches exactly what a reload would read
 * back from the evidence file.
 */
export function statusView(run: MutableRun, evidenceFile: string): M2E2EStatusView {
  return JSON.parse(JSON.stringify({
    runId: run.runId,
    state: run.state,
    startedAt: run.startedAt,
    ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
    steps: run.steps,
    evidenceFile,
    ...(run.error === undefined ? {} : { error: run.error }),
  })) as M2E2EStatusView
}

/** Host identity recorded in the evidence document; no hostname by design. */
export interface M2E2EEvidenceHost {
  readonly pluginName: string
  readonly pluginVersion: string
  readonly repoPath: string
}

/** Build the evidence document for one run; pure apart from process identity. */
export function evidenceDocument(
  host: M2E2EEvidenceHost,
  run: MutableRun,
): M2E2EEvidenceDocument {
  return {
    version: 1,
    runId: run.runId,
    state: run.state,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? null,
    host: {
      plugin: host.pluginName,
      pluginVersion: host.pluginVersion,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      repoPath: host.repoPath,
    },
    steps: JSON.parse(JSON.stringify(run.steps)) as M2StepView[],
    finalIndex: run.finalIndex,
    cleanup: run.cleanup,
    ...(run.error === undefined ? {} : { error: run.error }),
  }
}

/** Writes text to a path atomically; injected so this module needs no plugin import. */
export type AtomicWriter = (path: string, content: string) => Promise<void>

/**
 * Persist one evidence document. A failure is logged, not thrown: the live
 * in-memory run stays authoritative, and the file only serves a reloaded host.
 */
export async function persistEvidence(
  document: M2E2EEvidenceDocument,
  evidenceFile: string,
  writeAtomic: AtomicWriter,
  log?: (message: string) => void,
): Promise<void> {
  try {
    await mkdir(dirname(evidenceFile), { recursive: true, mode: 0o700 })
    await writeAtomic(evidenceFile, `${JSON.stringify(document, null, 2)}\n`)
  } catch (error) {
    log?.(`M2 E2E evidence write failed: ${messageOf(error)}`)
  }
}

/** Record one assertion; a failed assertion stops the step with its value. */
export function recordAssertion(
  step: MutableStep,
  check: string,
  passed: boolean,
  detail: unknown,
): void {
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

/** Run git and record the command, cwd, exit code, and clipped output in the step. */
export async function observeGit(
  step: MutableStep,
  args: readonly string[],
  cwd: string,
): Promise<GitOutcome> {
  const result = await runGit(args, cwd)
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

/** Like {@link observeGit}, but a non-zero exit fails the step under `label`. */
export async function gitOkObserved(
  step: MutableStep,
  args: readonly string[],
  cwd: string,
  label: string,
): Promise<GitOutcome> {
  const result = await observeGit(step, args, cwd)
  if (result.code !== 0) {
    throw new Error(`${label} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`)
  }
  return result
}

/** Read a file and record existence plus clipped content in the step evidence. */
export async function readObserved(
  step: MutableStep,
  path: string,
): Promise<string | undefined> {
  const text = await readTextIfPresent(path)
  const files = (step.evidence.observations.files as unknown[]) ?? []
  files.push({ path, exists: text !== undefined, text: clip(text ?? '', MAX_FILE_TEXT) })
  step.evidence.observations.files = files
  return text
}

/** The durable state a step boundary records; index may be absent mid-write. */
export function stateSnapshot(
  index: IndexView | undefined,
  fixturePath: string,
): Record<string, unknown> {
  return {
    fixtureExists: existsSync(fixturePath),
    masterSessionId: index?.masterSessionId ?? null,
    threads: (index?.threads ?? []).map((thread) => ({
      threadId: thread.threadId,
      status: thread.status,
      checkoutPath: thread.checkoutPath,
      cloneExists: typeof thread.checkoutPath === 'string' && existsSync(thread.checkoutPath),
    })),
  }
}

/** Sequence of the newest buffered event for one session (0 when empty). */
export function lastSeq(events: readonly M2SessionEvent[]): number {
  return events.at(-1)?.seq ?? 0
}

/** Assistant text emitted after `fromSeq`, clipped for evidence. */
export function assistantTextSince(events: readonly M2SessionEvent[], fromSeq: number): string {
  const parts: string[] = []
  for (const event of events) {
    if (event.seq <= fromSeq || event.type !== 'assistant/message') continue
    const text = contentText(asRecord(event.data.message))
    if (text !== '') parts.push(text)
  }
  return clip(parts.join('\n'), MAX_ASSISTANT_TEXT)
}

/** Tool calls (optionally one tool) after `fromSeq`, paired with their results. */
export function toolCallsSince(
  events: readonly M2SessionEvent[],
  fromSeq: number,
  name?: string,
): M2ToolCallEvidence[] {
  const calls = new Map<string, M2ToolCallEvidence>()
  for (const event of events) {
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

/** Parse the project index; a half-written file during a poll reports absence. */
export function parseIndex(text: string): IndexView | undefined {
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

/** Read every handoff file under the fixture's project directory, sorted by name. */
export async function readHandoffs(fixturePath: string): Promise<HandoffView[]> {
  const directory = join(fixturePath, '.dsh-cowork', 'handoffs')
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
      files.push({ filePath, record: record as unknown as HandoffView['record'] })
    } catch {
      // A handoff being atomically replaced is transient; the next poll sees it.
    }
  }
  return files
}
