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
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { replayPendingHandoffs, submitHandoff } from './handoff.js'
import { THREAD_PRESET_ID } from './presets.js'
import type { PresetRegistryPort } from './presets.js'
import { decideRoute } from './router.js'
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
  updatedAt: string
  lastHandoffAt: string | null
} {
  return {
    threadId: thread.threadId,
    subject: thread.subject,
    status: thread.status,
    cwd: thread.cwd,
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
): ThreadRecord {
  const stamp = createdAt.toISOString()
  return {
    threadId,
    subject,
    status: 'new',
    cwd: repoPath,
    worktreePath: null,
    createdAt: stamp,
    updatedAt: stamp,
    lastHandoffAt: null,
  }
}

/**
 * Register the six cowork tools and return their disposers. The caller owns the
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
        const brief = typeof args.brief === 'string' ? args.brief.trim() : ''
        if (brief !== '') {
          const result = await opened.slice.promptSession(created.sessionId, brief)
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

  return disposers
}
