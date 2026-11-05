/**
 * The six `cowork_*` tools and the host ports they run against.
 *
 * Every tool follows the same path: read the caller from `exec.agent` (fail
 * closed when it is absent), resolve the project from the caller's cwd, build a
 * fresh `ProjectStore`/`SessionSlice` for that project, enforce the role gate
 * from src/tool-model.ts, and return either a success payload or the shared
 * failure envelope. Nothing throws across the tool boundary and no stack trace
 * reaches the model.
 *
 * The module imports `defineTool` (the host's tool DSL) plus the already-merged
 * pure modules; all host services arrive through {@link CoworkToolDeps}, so the
 * assembly can be wired and inspected without a running host.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { CHECKOUT_ERROR, createCheckout, inspectCheckout, mergeCheckout, removeCheckout } from './checkout.js'
import type { CheckoutDeps, CheckoutStatus, GitResult, GitRunner } from './checkout.js'
import { replayPendingHandoffs, submitHandoff } from './handoff.js'
import {
  MemoryCorruptError,
  appendMemoryEntry,
  loadMemory,
  searchMemory,
  validateMemoryEntry,
} from './memory.js'
import type { MemoryIo } from './memory.js'
import { THREAD_PRESET_ID } from './presets.js'
import type { PresetRegistryPort } from './presets.js'
import { decideRoute, tokenize } from './router.js'
import type { RoutableThread } from './router.js'
import { SessionSlice } from './session-slice.js'
import type { SessionSlicePorts } from './session-slice.js'
import { ProjectStore, StoreError, findProjectRoot } from './store.js'
import type { HandoffFile, ProjectIndex, ThreadRecord } from './store.js'
import {
  ERROR_CODES,
  buildThreadBrief,
  checkRole,
  failure,
  readCaller,
  routePayload,
  success,
} from './tool-model.js'
import type { CallerIdentity, ToolFailure } from './tool-model.js'

/** Lossless JSON value accepted by the tool result boundary. */
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** The tool-registry slice of the plugin context; the rest of `ctx` stays opaque. */
export interface CoworkToolsHost {
  tools: { register(definition: ToolDefinition): () => void }
}

/**
 * Host services the M1 assembly needs. `agentPresets` is used by src/index.ts to
 * register the presets; the tools themselves never touch it, but it lives here
 * so the assembly has exactly one dependency bag.
 */
export interface CoworkToolDeps {
  sessionController: SessionSlicePorts['sessions']
  workspaceRegistry: SessionSlicePorts['workspaces']
  agentPresets: PresetRegistryPort
  /** Injected clock for every timestamp the tools write. */
  clock?: () => Date
  /** The plugin's default repository root, used only to improve an error hint. */
  resolveRepoPath?: () => string
}

/** One resolved project plus the collaborators for one tool call. */
interface ProjectRuntime {
  repoPath: string
  store: ProjectStore
  slice: SessionSlice
  index: ProjectIndex
}

/** Convert any payload to the lossless JSON value the tool boundary accepts. */
function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/** Render one JSON result as model-facing text. */
function renderJson(_args: unknown, value: JsonValue): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** The clock every write uses. */
function nowOf(deps: CoworkToolDeps): Date {
  return deps.clock === undefined ? new Date() : deps.clock()
}

/** Build the session adapter over the injected host services. */
function makeSlice(deps: CoworkToolDeps): SessionSlice {
  return new SessionSlice({ sessions: deps.sessionController, workspaces: deps.workspaceRegistry })
}

/** Timeout for one git invocation; no git call is retried automatically. */
const GIT_TIMEOUT_MS = 30_000

/** Upper bound on captured git output; a runaway diff should fail, not OOM. */
const GIT_MAX_BUFFER = 8 * 1024 * 1024

/** One non-zero exit code returned by a failed spawn (git never ran). */
const SPAWN_FAILED_EXIT = 1

/**
 * Git runner for the checkout module: argument array, explicit cwd, a
 * 30-second timeout, and no shell, so a thread id or repository path can never
 * become part of a command. A non-zero exit is a value, never an exception.
 */
const runGit: GitRunner = (args, cwd) =>
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
const checkoutDeps: CheckoutDeps = { runGit }

/** The memory module's IO port, backed by the project store's lock and atomic write. */
function memoryIo(store: ProjectStore): MemoryIo {
  return {
    readText: (path) => store.readText(path),
    writeText: (path, content) => store.writeTextAtomic(path, content),
    withLock: (operation) => store.withWriteLock(operation),
  }
}

/** Error text for a caught value. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isFailure(value: unknown): value is ToolFailure {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false
}

/** Map a thrown error onto the model-facing failure envelope. */
function mapError(error: unknown): ToolFailure {
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
function callerOf(exec: unknown): CallerIdentity | ToolFailure {
  const caller = readCaller(exec)
  if (caller !== null) return caller
  return failure(
    ERROR_CODES.agentUnavailable,
    'no caller identity on exec.agent (needs exec.agent.id and exec.agent.session.header.cwd); refusing to guess the project',
  )
}

/** Resolve the project that owns the caller's cwd. */
async function openProject(caller: CallerIdentity, deps: CoworkToolDeps): Promise<ProjectRuntime | ToolFailure> {
  const repoPath = await findProjectRoot(caller.cwd)
  if (repoPath === null) {
    const hint = deps.resolveRepoPath === undefined ? '' : ` (plugin default repo: ${deps.resolveRepoPath()})`
    return failure(
      ERROR_CODES.projectNotInitialized,
      `no .dsh-cowork/index.json at or above ${caller.cwd}; run cowork_project_init first${hint}`,
    )
  }
  const store = new ProjectStore({ repoPath, clock: deps.clock })
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
async function reconcileIndex(store: ProjectStore): Promise<ProjectIndex> {
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
function threadView(thread: ThreadRecord): {
  threadId: string
  subject: string
  status: ThreadRecord['status']
  cwd: string
  checkoutPath: string | null
  updatedAt: string
  lastHandoffAt: string | null
} {
  return {
    threadId: thread.threadId,
    subject: thread.subject,
    status: thread.status,
    cwd: thread.cwd,
    checkoutPath: thread.checkoutPath,
    updatedAt: thread.updatedAt,
    lastHandoffAt: thread.lastHandoffAt,
  }
}

/** Newest handoff summary per thread, for the router's keyword overlap. */
function handoffSummaries(handoffs: readonly HandoffFile[]): Map<string, string> {
  const summaries = new Map<string, string>()
  // listHandoffs is ascending by createdAt, so the last write per thread wins.
  for (const file of handoffs) summaries.set(file.record.threadId, file.record.summary)
  return summaries
}

/** Build a `'new'` thread record for a session the host just created. */
function newThreadRecord(
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
  }
}

/** What one successful isolated creation produced. */
interface IsolatedThread {
  thread: ThreadRecord
  threadId: string
  title: string
  prompted: boolean
  checkoutPath: string
}

/** One checkout row of the project status view. */
interface CheckoutRow {
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
async function createIsolatedThread(
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
async function inspectCheckouts(
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

/**
 * Register the nine cowork tools and return their disposers. The caller owns the
 * effect scope; this function only registers.
 */
export function registerCoworkTools(ctx: unknown, deps: CoworkToolDeps): Array<() => void> {
  const host = ctx as CoworkToolsHost
  const disposers: Array<() => void> = []

  // 1) cowork_project_init — the only tool that may create a project, always at the caller's cwd.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_project_init',
    description:
      'Initialize the cowork project rooted at the caller cwd: write .dsh-cowork/index.json with the calling session as master and ensure the workspace. Idempotent; refuses a different master.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    execute: async (_args, exec) => {
      const caller = callerOf(exec)
      if (isFailure(caller)) return toJson(caller)
      try {
        const repoPath = caller.cwd
        const store = new ProjectStore({ repoPath, clock: deps.clock })
        const slice = makeSlice(deps)
        // Idempotent by construction: an existing index keeps its master, and a
        // different caller is refused here instead of overwriting it.
        const initialized = await store.initIndex(caller.sessionId)
        const denied = checkRole('master', caller, initialized.index)
        if (denied !== null) return toJson(denied)
        const index = await reconcileIndex(store)
        const workspaceId = await slice.resolveWorkspaceId(repoPath)
        return toJson(success({
          projectId: index.projectId,
          repoPath,
          masterSessionId: index.masterSessionId,
          workspaceId,
          created: initialized.created,
          index,
        }))
      } catch (error) {
        return toJson(mapError(error))
      }
    },
  })))

  // 2) cowork_project_status — read snapshot + pending handoffs, replaying once.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_project_status',
    description:
      'Read the cowork project: index snapshot, thread overview, and handoffs not yet delivered to the master. Retries undelivered handoffs once.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    execute: async (_args, exec) => {
      const caller = callerOf(exec)
      if (isFailure(caller)) return toJson(caller)
      try {
        const opened = await openProject(caller, deps)
        if (isFailure(opened)) return toJson(opened)
        const denied = checkRole('master-or-thread', caller, opened.index)
        if (denied !== null) return toJson(denied)
        const index = await reconcileIndex(opened.store)
        const replay = await replayPendingHandoffs({
          store: opened.store,
          promptMaster: (text) => opened.slice.promptSession(index.masterSessionId, text),
          clock: deps.clock,
        })
        const files = await opened.store.listHandoffs()
        const pendingHandoffs = files
          .filter((file) => file.record.deliveredAt === null)
          .map((file) => ({
            threadId: file.record.threadId,
            fileName: file.fileName,
            createdAt: file.record.createdAt,
            status: file.record.status,
          }))
        return toJson(success({
          project: {
            projectId: index.projectId,
            repoPath: opened.repoPath,
            masterSessionId: index.masterSessionId,
            createdAt: index.createdAt,
          },
          threads: index.threads.map(threadView),
          checkouts: await inspectCheckouts(opened.repoPath, index.threads),
          pendingHandoffs,
          replay,
        }))
      } catch (error) {
        return toJson(mapError(error))
      }
    },
  })))

  // 3) cowork_route — reuse, create, or ask the master for a subject.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_route',
    description:
      'Route a user intent to an existing thread, create a new thread when a subject is given, or ask for a subject when the intent matches nothing. Master only.',
    parameters: {
      intent: { type: 'string', required: true, description: 'What the user wants, verbatim.' },
      subject: {
        type: 'string',
        description: 'Short subject for a new thread; omit to let the router ask for one instead of creating.',
      },
      isolated: {
        type: 'boolean',
        description:
          'Create the routed thread in its own local git clone (.dsh-cowork/threads/<threadId>, branch cowork/<threadId>) instead of the shared repository.',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: async (args, exec) => {
      const caller = callerOf(exec)
      if (isFailure(caller)) return toJson(caller)
      const intent = args.intent.trim()
      if (intent === '') return toJson(failure(ERROR_CODES.intentRequired, 'intent must not be empty'))
      try {
        const opened = await openProject(caller, deps)
        if (isFailure(opened)) return toJson(opened)
        const denied = checkRole('master', caller, opened.index)
        if (denied !== null) return toJson(denied)

        const summaries = handoffSummaries(await opened.store.listHandoffs())
        const routable: RoutableThread[] = opened.index.threads.map((thread) => ({
          threadId: thread.threadId,
          subject: thread.subject,
          status: thread.status,
          updatedAt: thread.updatedAt,
          lastHandoffSummary: summaries.get(thread.threadId) ?? null,
        }))
        const subject = typeof args.subject === 'string' ? args.subject.trim() : ''
        const decision = decideRoute(intent, routable, { hasSubject: subject !== '', now: nowOf(deps) })

        if (decision.action === 'reuse') {
          const prompted = await opened.slice.promptSession(decision.threadId, intent)
          return toJson(success({ ...routePayload(decision), prompted: prompted.accepted }))
        }
        if (decision.action === 'needs_subject') {
          return toJson(success({ ...routePayload(decision) }))
        }

        if (args.isolated === true) {
          const isolated = await createIsolatedThread(opened, { subject, intent }, deps)
          if (isFailure(isolated)) return toJson(isolated)
          return toJson(success({
            ...routePayload(decision),
            threadId: isolated.threadId,
            subject,
            title: isolated.title,
            prompted: isolated.prompted,
            isolated: true,
            checkoutPath: isolated.checkoutPath,
            thread: threadView(isolated.thread),
          }))
        }

        const createdAt = nowOf(deps)
        const created = await opened.slice.createThread({
          repoPath: opened.repoPath,
          subject,
          presetId: THREAD_PRESET_ID,
        })
        const record = newThreadRecord(created.sessionId, subject, opened.repoPath, createdAt)
        await opened.store.addThread(record)
        const brief = buildThreadBrief({
          repoPath: opened.repoPath,
          subject,
          threadId: created.sessionId,
          intent,
        })
        const prompted = await opened.slice.promptSession(created.sessionId, brief)
        let thread = record
        if (prompted.accepted) {
          const updated = await opened.store.updateThread(created.sessionId, { status: 'active' })
          thread = updated.threads.find((entry) => entry.threadId === created.sessionId) ?? record
        }
        return toJson(success({
          ...routePayload(decision),
          threadId: created.sessionId,
          subject,
          title: created.title,
          prompted: prompted.accepted,
          thread: threadView(thread),
        }))
      } catch (error) {
        return toJson(mapError(error))
      }
    },
  })))

  // 4) cowork_thread_create — explicit thread creation by the master.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_thread_create',
    description:
      'Create a cowork thread session for a given subject, record it in the index, and optionally send its first brief. Master only.',
    parameters: {
      subject: { type: 'string', required: true, description: 'Short subject the thread owns.' },
      brief: { type: 'string', description: 'Optional first message for the new thread.' },
      isolated: {
        type: 'boolean',
        description:
          'Run this thread in its own local git clone (.dsh-cowork/threads/<threadId>, branch cowork/<threadId>) instead of the shared repository.',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: async (args, exec) => {
      const caller = callerOf(exec)
      if (isFailure(caller)) return toJson(caller)
      const subject = args.subject.trim()
      if (subject === '') {
        return toJson(failure('thread/subject-required', 'subject must not be empty'))
      }
      try {
        const opened = await openProject(caller, deps)
        if (isFailure(opened)) return toJson(opened)
        const denied = checkRole('master', caller, opened.index)
        if (denied !== null) return toJson(denied)

        const briefText = typeof args.brief === 'string' ? args.brief.trim() : ''
        if (args.isolated === true) {
          const isolated = await createIsolatedThread(opened, { subject, brief: briefText }, deps)
          if (isFailure(isolated)) return toJson(isolated)
          return toJson(success({
            thread: threadView(isolated.thread),
            title: isolated.title,
            prompted: isolated.prompted,
            isolated: true,
            checkoutPath: isolated.checkoutPath,
          }))
        }

        const createdAt = nowOf(deps)
        const created = await opened.slice.createThread({
          repoPath: opened.repoPath,
          subject,
          presetId: THREAD_PRESET_ID,
        })
        const record = newThreadRecord(created.sessionId, subject, opened.repoPath, createdAt)
        await opened.store.addThread(record)
        let thread = record
        let prompted = false
        if (briefText !== '') {
          const result = await opened.slice.promptSession(created.sessionId, briefText)
          prompted = result.accepted
          if (prompted) {
            const updated = await opened.store.updateThread(created.sessionId, { status: 'active' })
            thread = updated.threads.find((entry) => entry.threadId === created.sessionId) ?? record
          }
        }
        return toJson(success({ thread: threadView(thread), title: created.title, prompted }))
      } catch (error) {
        return toJson(mapError(error))
      }
    },
  })))

  // 5) cowork_thread_list — thread overview off the index.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_thread_list',
    description: 'List the cowork threads recorded in the project index. Master or thread.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    execute: async (_args, exec) => {
      const caller = callerOf(exec)
      if (isFailure(caller)) return toJson(caller)
      try {
        const opened = await openProject(caller, deps)
        if (isFailure(opened)) return toJson(opened)
        const denied = checkRole('master-or-thread', caller, opened.index)
        if (denied !== null) return toJson(denied)
        return toJson(success({ threads: opened.index.threads.map(threadView) }))
      } catch (error) {
        return toJson(mapError(error))
      }
    },
  })))

  // 6) cowork_handoff — the only way a thread reports back.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_handoff',
    description:
      'Report this thread result to the master: status, summary, and the verification you ran. Thread only; a thread that stops without this has not finished.',
    parameters: {
      status: {
        type: 'string',
        required: true,
        enum: ['awaiting_review', 'blocked', 'done'],
        description: 'Thread state after this handoff.',
      },
      summary: { type: 'string', required: true, description: 'What was done, in one paragraph.' },
      verification: {
        type: 'array',
        required: true,
        description: 'One row per check actually run.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            command: { type: 'string', required: true, description: 'Exact command that was run.' },
            exitCode: { type: 'integer', required: true, description: 'Exit code the command returned.' },
            evidence: { type: 'string', required: true, description: 'Short output or result that proves it.' },
          },
        },
      },
      decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions the master should know.' },
      changedPaths: { type: 'array', items: { type: 'string' }, description: 'Files this thread changed.' },
      artifacts: { type: 'array', items: { type: 'string' }, description: 'Paths the master may want to open.' },
      openIssues: { type: 'array', items: { type: 'string' }, description: 'What is still open.' },
      nextStep: { type: 'string', description: 'What should happen next.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: async (args, exec) => {
      const caller = callerOf(exec)
      if (isFailure(caller)) return toJson(caller)
      try {
        const opened = await openProject(caller, deps)
        if (isFailure(opened)) return toJson(opened)
        const denied = checkRole('thread', caller, opened.index)
        if (denied !== null) return toJson(denied)
        const thread = opened.index.threads.find((entry) => entry.threadId === caller.sessionId)
        if (thread === undefined) {
          return toJson(failure(ERROR_CODES.sessionMissing, `thread ${caller.sessionId} is not in the project index`))
        }
        const result = await submitHandoff(
          {
            store: opened.store,
            promptMaster: (text) => opened.slice.promptSession(opened.index.masterSessionId, text),
            clock: deps.clock,
          },
          {
            threadId: caller.sessionId,
            masterSessionId: opened.index.masterSessionId,
            subject: thread.subject,
            status: args.status,
            summary: args.summary,
            verification: args.verification,
            decisions: args.decisions,
            changedPaths: args.changedPaths,
            artifacts: args.artifacts,
            openIssues: args.openIssues,
            nextStep: args.nextStep,
          },
        )
        if (!result.ok) {
          return toJson(failure(ERROR_CODES.handoffInvalid, result.error.message, { errors: result.error.errors }))
        }
        return toJson(success({
          delivered: result.delivered,
          filePath: result.filePath,
          status: result.record.status,
          record: result.record,
        }))
      } catch (error) {
        return toJson(mapError(error))
      }
    },
  })))

  // 7) cowork_memory_write — append one durable project-memory entry.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_memory_write',
    description:
      'Append one durable project-memory entry (constraint, decision, or fact) to .dsh-cowork/memory/. Master or thread.',
    parameters: {
      kind: {
        type: 'string',
        required: true,
        enum: ['constraint', 'decision', 'fact'],
        description: 'Which memory file to append to: constraints.md, decisions.md, or facts.md.',
      },
      title: { type: 'string', required: true, description: 'One-line title; duplicate titles are allowed.' },
      text: { type: 'string', required: true, description: 'The entry body, at most 8000 characters.' },
      source: { type: 'string', required: true, description: 'Where this came from, e.g. the thread id.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: async (args, exec) => {
      const caller = callerOf(exec)
      if (isFailure(caller)) return toJson(caller)
      try {
        const opened = await openProject(caller, deps)
        if (isFailure(opened)) return toJson(opened)
        const denied = checkRole('master-or-thread', caller, opened.index)
        if (denied !== null) return toJson(denied)

        const validated = validateMemoryEntry(args.kind, {
          title: args.title,
          text: args.text,
          source: args.source,
        })
        if (!validated.ok) {
          return toJson(failure(ERROR_CODES.memoryInvalid, 'memory entry is invalid', {
            issues: validated.issues,
          }))
        }

        try {
          const appended = await appendMemoryEntry(
            memoryIo(opened.store),
            opened.repoPath,
            validated.kind,
            validated.value,
            () => nowOf(deps),
          )
          return toJson(success({
            file: appended.file,
            filePath: appended.filePath,
            entry: appended.entry,
          }))
        } catch (error) {
          if (error instanceof MemoryCorruptError) {
            return toJson(failure(ERROR_CODES.memoryInvalid, error.message, {
              file: error.file,
              issues: error.issues,
            }))
          }
          return toJson(failure(ERROR_CODES.memoryWriteFailed, describeError(error)))
        }
      } catch (error) {
        return toJson(mapError(error))
      }
    },
  })))

  // 8) cowork_memory_search — keyword search across the three memory files.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_memory_search',
    description:
      'Search the project memory (constraints, decisions, facts) by keyword; results are ranked by title, body, and source overlap. Master or thread.',
    parameters: {
      query: { type: 'string', required: true, description: 'Keywords to look for.' },
      limit: { type: 'integer', description: 'Maximum hits, 1..20 (default 5).' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: async (args, exec) => {
      const caller = callerOf(exec)
      if (isFailure(caller)) return toJson(caller)
      const query = args.query.trim()
      if (query === '') return toJson(failure(ERROR_CODES.memoryInvalid, 'query must not be empty'))
      try {
        const opened = await openProject(caller, deps)
        if (isFailure(opened)) return toJson(opened)
        const denied = checkRole('master-or-thread', caller, opened.index)
        if (denied !== null) return toJson(denied)

        const loaded = await loadMemory(
          { readText: (path) => opened.store.readText(path) },
          opened.repoPath,
        )
        const entries = loaded.files.flatMap((file) => file.entries.map((entry) => ({
          kind: file.kind,
          file: file.file,
          entry,
        })))
        const hits = searchMemory(entries, query, { tokenize, limit: args.limit })
        return toJson(success({ hits, issues: loaded.issues, total: hits.length }))
      } catch (error) {
        return toJson(mapError(error))
      }
    },
  })))

  // 9) cowork_checkout_merge — integrate one thread's branch, then tear the clone down.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_checkout_merge',
    description:
      'Merge one isolated thread branch into the current repository, then delete its clone, workspace, and session. Master only.',
    parameters: {
      threadId: { type: 'string', required: true, description: 'Thread whose checkout should be merged.' },
      message: { type: 'string', description: 'Merge commit message; defaults to "cowork: merge <threadId>".' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: async (args, exec) => {
      const caller = callerOf(exec)
      if (isFailure(caller)) return toJson(caller)
      try {
        const opened = await openProject(caller, deps)
        if (isFailure(opened)) return toJson(opened)
        const denied = checkRole('master', caller, opened.index)
        if (denied !== null) return toJson(denied)

        const threadId = args.threadId.trim()
        const thread = opened.index.threads.find((entry) => entry.threadId === threadId)
        if (thread === undefined) {
          return toJson(failure(ERROR_CODES.threadNotFound, `thread not found in the project index: ${threadId}`, { threadId }))
        }
        const checkoutPath = thread.checkoutPath
        if (checkoutPath === null) {
          return toJson(failure(ERROR_CODES.checkoutNotFound, `thread ${threadId} has no isolated checkout`, { threadId }))
        }
        if (thread.status !== 'awaiting_review' && thread.status !== 'done') {
          return toJson(failure(
            ERROR_CODES.checkoutNotReady,
            `thread ${threadId} is ${thread.status}; merging is allowed for awaiting_review or done`,
            { threadId, status: thread.status },
          ))
        }

        const merged = await mergeCheckout(checkoutDeps, {
          repoPath: opened.repoPath,
          threadId,
          message: typeof args.message === 'string' && args.message.trim() !== '' ? args.message.trim() : undefined,
        })
        if (!merged.ok) {
          if (merged.code === CHECKOUT_ERROR.mergeConflict) {
            // The clone stays so the thread can resolve and retry.
            const updated = await opened.store.updateThread(threadId, { status: 'blocked' })
            const record = updated.threads.find((entry) => entry.threadId === threadId)
            return toJson(failure(merged.code, merged.message, {
              ...merged.details,
              threadId,
              status: 'blocked',
              thread: record === undefined ? null : threadView(record),
            }))
          }
          return toJson(failure(merged.code, merged.message, { ...merged.details, threadId }))
        }

        // The merge already landed; teardown problems are reported, never fatal.
        const cleanup = {
          removed: false,
          branchDeleted: false,
          workspaceId: null as string | null,
          workspaceDeleted: false,
          sessionArchived: false,
        }
        const cleanupErrors: string[] = []

        // Resolve the workspace while the clone still exists: the host
        // canonicalises the path with realpath before matching it.
        const workspace = await deps.workspaceRegistry.resolveByPath(checkoutPath)

        const removed = await removeCheckout(checkoutDeps, { repoPath: opened.repoPath, threadId })
        if (removed.ok) {
          cleanup.removed = removed.removed
          cleanup.branchDeleted = removed.branchDeleted
        } else {
          cleanupErrors.push(`checkout: ${removed.message}`)
        }

        if (workspace !== undefined) {
          cleanup.workspaceId = workspace.id
          try {
            cleanup.workspaceDeleted = await opened.slice.deleteWorkspace(workspace.id)
          } catch (error) {
            cleanupErrors.push(`workspace: ${describeError(error)}`)
          }
        }
        try {
          await opened.slice.archiveSession(threadId)
          cleanup.sessionArchived = true
        } catch (error) {
          cleanupErrors.push(`session: ${describeError(error)}`)
        }

        const updated = await opened.store.updateThread(threadId, { checkoutPath: null, status: 'done' })
        const record = updated.threads.find((entry) => entry.threadId === threadId)
        return toJson(success({
          threadId,
          merged: true,
          commit: merged.commit,
          branch: merged.branch,
          cleanup,
          cleanupErrors,
          thread: record === undefined ? null : threadView(record),
        }))
      } catch (error) {
        return toJson(mapError(error))
      }
    },
  })))

  return disposers
}
