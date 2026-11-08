/**
 * Shared execution layer for the `cowork_*` tools (M9.3a).
 *
 * `src/tools.ts` used to hold every helper and every tool in one file. The
 * business boundary stays the same; this module owns the pieces every tool
 * needs — the dependency bag, caller/project resolution, the store and session
 * adapters, the git runner, thread views, and the isolated-thread creation /
 * cleanup flow — so the per-domain tool modules can register their tools
 * without importing each other.
 *
 * It also owns the M9 read-point rule: {@link evaluateProjectLifecycle} runs
 * `evaluateTopicLifecycle` against every topic inside the project lock and
 * writes only when something changed. Reading a status must not write, so a
 * no-change pass returns `null` from the mutator and the store skips the write.
 *
 * Nothing here assembles a host: the caller injects {@link CoworkToolDeps}, and
 * a test can register the tools against recording fakes.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { statusChangedActivity } from './activity.js'
import { createCheckout, inspectCheckout, removeCheckout } from './checkout.js'
import type { CheckoutDeps, CheckoutStatus, GitResult, GitRunner } from './checkout.js'
import { describeError } from './checkout-teardown.js'
import type { MemoryIo } from './memory.js'
import { THREAD_PRESET_ID } from './presets.js'
import type { PresetRegistryPort } from './presets.js'
import { SessionSlice } from './session-slice.js'
import type { SessionSlicePorts } from './session-slice.js'
import { ProjectStore, StoreError, findProjectRoot } from './store.js'
import type { HandoffFile, ProjectIndex, ThreadRecord } from './store.js'
import type { ActivityEvent, ProjectIndexV2, TopicRecordV2, TopicStatus } from './store-schema.js'
import { evaluateTopicLifecycle } from './topic.js'
import { ERROR_CODES, buildThreadBrief, failure, readCaller } from './tool-model.js'
import type { CallerIdentity, ToolFailure } from './tool-model.js'

/** Lossless JSON value accepted by the tool result boundary. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** The tool-registry slice of the plugin context; the rest of `ctx` stays opaque. */
export interface CoworkToolsHost {
  tools: { register(definition: ToolDefinition): () => void }
}

/** The third routing layer's settings as the tools receive them (M9.1/M9.2). */
export interface RoutingSettings {
  enabled: boolean
  provider: string
  model: string
  effort: string
  timeoutMs: number
  maxTokens: number
}

/**
 * Host services the M1 assembly needs. `agentPresets` is used by src/index.ts to
 * register the presets; the tools themselves never touch it, but it lives here
 * so the assembly has exactly one dependency bag. The lifecycle/routing fields
 * are optional so a hand-built deps object (tests, embedders) still works; the
 * defaults live in src/index.ts's normalized config and src/topic.ts.
 */
export interface CoworkToolDeps {
  sessionController: SessionSlicePorts['sessions']
  workspaceRegistry: SessionSlicePorts['workspaces']
  agentPresets: PresetRegistryPort
  /** Injected clock for every timestamp the tools write. */
  clock?: () => Date
  /** The plugin's default repository root, used only to improve an error hint. */
  resolveRepoPath?: () => string
  /** Silence after which a topic becomes idle; defaults to `DEFAULT_IDLE_AFTER_MS`. */
  idleAfterMs?: number
  /** Silence after which a resolvable topic is resolved; defaults to `DEFAULT_RESOLVE_AFTER_MS`. */
  resolveAfterMs?: number
  /** Third-layer model routing settings; M9.3a only carries them to M9.3b. */
  routing?: RoutingSettings
}

/** One resolved project plus the collaborators for one tool call. */
export interface ProjectRuntime {
  repoPath: string
  store: ProjectStore
  slice: SessionSlice
  index: ProjectIndex
}

/** Convert any payload to the lossless JSON value the tool boundary accepts. */
export function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/** Render one JSON result as model-facing text. */
export function renderJson(_args: unknown, value: JsonValue): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/**
 * The one place a production {@link ProjectStore} is constructed. The store's
 * v1→v2 migration entry archives the reviewer of an in-flight review through
 * `ProjectStoreOptions.archiveSession`; wiring the host port here is what makes
 * that a real archive instead of a recorded failure.
 */
export function projectStoreFor(repoPath: string, deps: CoworkToolDeps): ProjectStore {
  return new ProjectStore({
    repoPath,
    clock: deps.clock,
    archiveSession: (sessionId, options) => deps.workspaceRegistry.archiveSession(sessionId, options),
  })
}

/** The clock every write uses. */
export function nowOf(deps: CoworkToolDeps): Date {
  return deps.clock === undefined ? new Date() : deps.clock()
}

/** Build the session adapter over the injected host services. */
export function makeSlice(deps: CoworkToolDeps): SessionSlice {
  return new SessionSlice({ sessions: deps.sessionController, workspaces: deps.workspaceRegistry })
}

/** Timeout for one git invocation; no git call is retried automatically. */
export const GIT_TIMEOUT_MS = 30_000

/** Upper bound on captured git output; a runaway diff should fail, not OOM. */
export const GIT_MAX_BUFFER = 8 * 1024 * 1024

/** One non-zero exit code returned by a failed spawn (git never ran). */
export const SPAWN_FAILED_EXIT = 1

/**
 * Git runner for the checkout module: argument array, explicit cwd, a
 * 30-second timeout, and no shell, so a thread id or repository path can never
 * become part of a command. A non-zero exit is a value, never an exception.
 */
export const runGit: GitRunner = (args, cwd) =>
  new Promise<GitResult>((settle) => {
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
          code: typeof exit === 'number' ? exit : SPAWN_FAILED_EXIT,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr:
            typeof stderr === 'string' && stderr.length > 0 ? stderr : (error as Error).message,
        })
      },
    )
  })

/** The checkout module's only dependency is the git runner. */
export const checkoutDeps: CheckoutDeps = { runGit }

/** The memory module's IO port, backed by the project store's lock and atomic write. */
export function memoryIo(store: ProjectStore): MemoryIo {
  return {
    readText: (path) => store.readText(path),
    writeText: (path, content) => store.writeTextAtomic(path, content),
    withLock: (operation) => store.withWriteLock(operation),
  }
}

/** Whether a value is one of the shared failure envelopes. */
export function isFailure(value: unknown): value is ToolFailure {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false
}

/** Map a thrown error onto the model-facing failure envelope. */
export function mapError(error: unknown): ToolFailure {
  if (error instanceof StoreError) {
    if (error.code === 'store/corrupt') {
      return failure(ERROR_CODES.storeCorrupt, error.message, { filePath: error.filePath })
    }
    if (error.code === 'store/not-found') {
      return failure(ERROR_CODES.projectNotInitialized, error.message, { filePath: error.filePath })
    }
    return failure('tool/internal', error.message)
  }
  return failure('tool/internal', error instanceof Error ? error.message : String(error))
}

/** Read the caller or produce the `exec/agent-unavailable` failure. */
export function callerOf(exec: unknown): CallerIdentity | ToolFailure {
  const caller = readCaller(exec)
  if (caller !== null) return caller
  return failure(
    ERROR_CODES.agentUnavailable,
    'no caller identity on exec.agent (needs exec.agent.id and exec.agent.session.header.cwd); refusing to guess the project',
  )
}

/** Resolve the project that owns the caller's cwd. */
export async function openProject(
  caller: CallerIdentity,
  deps: CoworkToolDeps,
): Promise<ProjectRuntime | ToolFailure> {
  const repoPath = await findProjectRoot(caller.cwd)
  if (repoPath === null) {
    const hint = deps.resolveRepoPath === undefined ? '' : ` (plugin default repo: ${deps.resolveRepoPath()})`
    return failure(
      ERROR_CODES.projectNotInitialized,
      `no .dsh-cowork/index.json at or above ${caller.cwd}; run cowork_project_init first${hint}`,
    )
  }
  const store = projectStoreFor(repoPath, deps)
  const index = await store.readIndex()
  return { repoPath, store, slice: makeSlice(deps), index }
}

/** The newest handoff of one thread that is newer than the index already knows. */
function newerHandoff(handoffs: readonly HandoffFile[], thread: ThreadRecord): HandoffFile | null {
  const knownAt = thread.lastHandoffAt === null ? Number.NEGATIVE_INFINITY : Date.parse(thread.lastHandoffAt)
  let newest: HandoffFile | null = null
  for (const file of handoffs) {
    if (file.record.threadId !== thread.threadId) continue
    const createdAt = Date.parse(file.record.createdAt)
    if (createdAt <= knownAt) continue
    if (newest === null || createdAt > Date.parse(newest.record.createdAt)) newest = file
  }
  return newest
}

/**
 * Repair an index that lags behind the handoff files (the crash window between
 * "file written" and "index updated"). Epoch comparison, never filename
 * comparison; idempotent, because it rewrites `lastHandoffAt` to the same value
 * it read on the next call.
 */
export async function reconcileIndex(store: ProjectStore): Promise<ProjectIndex> {
  const [handoffs, index] = await Promise.all([store.listHandoffs(), store.readIndex()])
  if (!index.threads.some((thread) => newerHandoff(handoffs, thread) !== null)) return index
  return store.mutateIndex((current) => ({
    ...current,
    threads: current.threads.map((thread) => {
      const newest = newerHandoff(handoffs, thread)
      if (newest === null) return thread
      return {
        ...thread,
        status: newest.record.status,
        lastHandoffAt: newest.record.createdAt,
        updatedAt: newest.record.createdAt,
      }
    }),
  }))
}

/** The thread fields the tools expose. */
export function threadView(thread: ThreadRecord): {
  threadId: string
  subject: string
  status: ThreadRecord['status']
  cwd: string
  checkoutPath: string | null
  updatedAt: string
  lastHandoffAt: string | null
  reviewStatus: ThreadRecord['reviewStatus']
  reviewedAt: string | null
  reviewerSessionId: string | null
  latestReviewPath: string | null
} {
  return {
    threadId: thread.threadId,
    subject: thread.subject,
    status: thread.status,
    cwd: thread.cwd,
    checkoutPath: thread.checkoutPath,
    updatedAt: thread.updatedAt,
    lastHandoffAt: thread.lastHandoffAt,
    reviewStatus: thread.reviewStatus,
    reviewedAt: thread.reviewedAt,
    reviewerSessionId: thread.reviewerSessionId,
    latestReviewPath: thread.latestReviewPath,
  }
}

/** Newest handoff summary per thread, for the router's keyword overlap. */
export function handoffSummaries(handoffs: readonly HandoffFile[]): Map<string, string> {
  const summaries = new Map<string, string>()
  // listHandoffs is ascending by createdAt, so the last write per thread wins.
  for (const file of handoffs) summaries.set(file.record.threadId, file.record.summary)
  return summaries
}

/** Build a `'new'` thread record for a session the host just created. */
export function newThreadRecord(
  threadId: string,
  subject: string,
  repoPath: string,
  createdAt: Date,
  checkoutPath: string | null = null,
): ThreadRecord {
  const stamp = createdAt.toISOString()
  return {
    threadId,
    subject,
    status: 'new',
    cwd: repoPath,
    checkoutPath,
    createdAt: stamp,
    updatedAt: stamp,
    lastHandoffAt: null,
    reviewStatus: null,
    reviewRequestedAt: null,
    reviewedAt: null,
    reviewerSessionId: null,
    latestReviewPath: null,
  }
}

/** What one successful isolated creation produced. */
export interface IsolatedThread {
  thread: ThreadRecord
  threadId: string
  title: string
  prompted: boolean
  checkoutPath: string
}

/** One checkout row of the project status view. */
export interface CheckoutRow {
  threadId: string
  path: string
  exists: boolean
  dirty: boolean
  branch: string | null
  head: string | null
}

/**
 * Create a thread that works in its own clone.
 *
 * Fixed order: mint the id → clone (`createCheckout`) → workspace + session on
 * the clone (`createCheckoutThread`) → index record → brief. A failure after
 * the clone compensates: the index entry (if written), the clone, and the
 * workspace this call created are all removed, so a failed creation leaves no
 * half thread behind. Cleanup problems are reported in the failure details
 * instead of masking the original error.
 */
export async function createIsolatedThread(
  runtime: ProjectRuntime,
  input: { subject: string; intent?: string; brief?: string },
  deps: CoworkToolDeps,
): Promise<IsolatedThread | ToolFailure> {
  const threadId = `session-${randomUUID()}`
  const created = await createCheckout(checkoutDeps, { repoPath: runtime.repoPath, threadId })
  if (!created.ok) {
    // createCheckout already removed anything it created; the index was never touched.
    return failure(created.code, created.message, created.details)
  }

  let workspaceId: string | null = null
  let recordWritten = false
  const cleanupErrors: string[] = []
  try {
    const session = await runtime.slice.createCheckoutThread({
      repoPath: runtime.repoPath,
      checkoutPath: created.path,
      threadId,
      subject: input.subject,
      presetId: THREAD_PRESET_ID,
    })
    workspaceId = session.workspaceId

    const record = newThreadRecord(
      session.sessionId,
      input.subject,
      runtime.repoPath,
      nowOf(deps),
      created.path,
    )
    await runtime.store.addThread(record)
    recordWritten = true

    const brief = buildThreadBrief({
      repoPath: runtime.repoPath,
      subject: input.subject,
      threadId: session.sessionId,
      intent: input.intent,
      checkoutPath: created.path,
    })
    const extra = input.brief?.trim() ?? ''
    const prompted = await runtime.slice.promptSession(
      session.sessionId,
      extra === '' ? brief : `${brief}\n\n${extra}`,
    )
    let thread = record
    if (prompted.accepted) {
      const updated = await runtime.store.updateThread(session.sessionId, { status: 'active' })
      thread = updated.threads.find((entry) => entry.threadId === session.sessionId) ?? record
    }
    return {
      thread,
      threadId: session.sessionId,
      title: session.title,
      prompted: prompted.accepted,
      checkoutPath: created.path,
    }
  } catch (error) {
    if (recordWritten) {
      try {
        await runtime.store.mutateIndex((index) => ({
          ...index,
          threads: index.threads.filter((entry) => entry.threadId !== threadId),
        }))
      } catch (cleanupError) {
        cleanupErrors.push(`index: ${describeError(cleanupError)}`)
      }
    }

    // A workspace is created before the session, so a failure between them
    // leaves one that the thrown path never learned the id of; resolve by path.
    // The host canonicalises the path with realpath, so resolve while the clone
    // still exists.
    let resolvedWorkspaceId = workspaceId
    if (resolvedWorkspaceId === null) {
      try {
        const existing = await deps.workspaceRegistry.resolveByPath(created.path)
        resolvedWorkspaceId = existing === undefined ? null : existing.id
      } catch (cleanupError) {
        cleanupErrors.push(`workspace lookup: ${describeError(cleanupError)}`)
      }
    }

    const removed = await removeCheckout(checkoutDeps, { repoPath: runtime.repoPath, threadId })
    if (!removed.ok) cleanupErrors.push(`checkout: ${removed.message}`)

    let workspaceDeleted = false
    if (resolvedWorkspaceId !== null) {
      try {
        workspaceDeleted = await deps.workspaceRegistry.delete(resolvedWorkspaceId)
      } catch (cleanupError) {
        cleanupErrors.push(`workspace delete: ${describeError(cleanupError)}`)
      }
    }

    const mapped = mapError(error)
    return failure(mapped.error.code, mapped.error.message, {
      ...(typeof mapped.error.details === 'object' && mapped.error.details !== null
        ? (mapped.error.details as Record<string, unknown>)
        : {}),
      threadId,
      cleanup: {
        indexRolledBack: recordWritten,
        checkoutRemoved: removed.ok ? removed.removed : false,
        workspaceDeleted,
        errors: cleanupErrors,
      },
    })
  }
}

/**
 * Read-only checkout summary for every isolated thread. `inspectCheckout` can
 * throw only for an invalid thread id; one bad record must not fail the whole
 * status view, so that row degrades to the module's own all-empty shape.
 */
export async function inspectCheckouts(
  repoPath: string,
  threads: readonly ThreadRecord[],
): Promise<CheckoutRow[]> {
  const isolated = threads.filter((thread) => thread.checkoutPath !== null)
  return Promise.all(isolated.map(async (thread) => {
    let status: CheckoutStatus
    try {
      status = await inspectCheckout(checkoutDeps, { repoPath, threadId: thread.threadId })
    } catch {
      status = { exists: false, dirty: false, branch: null, head: null, commitsAhead: null }
    }
    return {
      threadId: thread.threadId,
      path: thread.checkoutPath as string,
      exists: status.exists,
      dirty: status.dirty,
      branch: status.branch,
      head: status.head,
    }
  }))
}

/** One lifecycle transition the read point made. */
export interface LifecycleChange {
  topicId: string
  from: TopicStatus
  to: TopicStatus
}

/** What one read-point evaluation did. */
export interface LifecycleEvaluation {
  /** How many topics the lock-scoped pass evaluated. */
  evaluated: number
  /** The transitions it wrote, in document order. */
  changes: LifecycleChange[]
  /** Activity rows that could not be appended; the index write already stands. */
  activityErrors: string[]
}

/** Everything the read point needs; the defaults live at the call site. */
export interface LifecycleOptions {
  idleAfterMs: number
  resolveAfterMs: number
  now: Date
  /** M9 always passes 0; M10 forwards real active work-item counts. */
  activeWorkItems?: number
}

/** The narrow store port the read point needs; `ProjectStore` satisfies it. */
export interface LifecycleStorePort {
  mutateIndexDocument(mutator: (document: ProjectIndexV2) => ProjectIndexV2 | null): Promise<ProjectIndexV2>
  appendActivity(event: ActivityEvent): Promise<void>
}

/**
 * Evaluate every topic's lifecycle inside the project lock (M9 read point).
 *
 * The mutator re-reads the document under the lock, so a concurrent write is
 * never overwritten by a stale snapshot; when no topic changed it returns
 * `null` and the store performs no write at all. A transition that lands is
 * committed atomically first, then its `status-changed` activity is appended
 * outside the lock: an activity failure is collected in `activityErrors` and
 * never rolls the index back (the M8 listener follows the same rule).
 */
export async function evaluateProjectLifecycle(
  store: LifecycleStorePort,
  options: LifecycleOptions,
): Promise<LifecycleEvaluation> {
  const nowMs = options.now.getTime()
  const activeWorkItems = options.activeWorkItems ?? 0
  const changes: LifecycleChange[] = []
  let evaluated = 0

  const next = await store.mutateIndexDocument((document) => {
    changes.length = 0
    evaluated = document.topics.length
    const topics: TopicRecordV2[] = []
    let changed = false
    for (const topic of document.topics) {
      const transition = evaluateTopicLifecycle(topic, {
        nowMs,
        idleAfterMs: options.idleAfterMs,
        resolveAfterMs: options.resolveAfterMs,
        activeWorkItems,
      })
      if (transition.kind === 'none') {
        topics.push(topic)
        continue
      }
      changed = true
      topics.push(transition.topic)
      changes.push({ topicId: topic.topicId, from: topic.status, to: transition.kind })
    }
    return changed ? { ...document, topics } : null
  })

  const activityErrors: string[] = []
  for (const change of changes) {
    const topic = next.topics.find((entry) => entry.topicId === change.topicId)
    if (topic === undefined) continue
    try {
      await store.appendActivity(
        statusChangedActivity(topic, { from: change.from, to: change.to }, options.now),
      )
    } catch (error) {
      activityErrors.push(`${change.topicId}: ${describeError(error)}`)
    }
  }
  return { evaluated, changes, activityErrors }
}
