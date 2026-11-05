/**
 * Pure tool-model helpers for the `cowork_*` tools: the caller identity, the
 * role gate, the shared result envelope, the thread brief, and the route
 * payload mapping.
 *
 * Nothing here touches the host: no imports, no I/O, no clock. The tool layer
 * (src/tools.ts) feeds these helpers the structured `exec` identity and the
 * project index, which keeps every gate unit-testable without a running host.
 */

/** Stable error codes returned to the model. */
export const ERROR_CODES = {
  agentUnavailable: 'exec/agent-unavailable',
  roleForbidden: 'role/forbidden',
  projectNotInitialized: 'project/not-initialized',
  handoffInvalid: 'handoff/invalid',
  intentRequired: 'route/intent-required',
  sessionMissing: 'thread/session-missing',
  storeCorrupt: 'store/corrupt',
  memoryInvalid: 'memory/invalid',
  memoryWriteFailed: 'memory/write-failed',
  threadNotFound: 'thread/not-found',
  checkoutNotFound: 'checkout/not-found',
  checkoutAlreadyExists: 'checkout/already-exists',
  checkoutCreateFailed: 'checkout/create-failed',
  checkoutInvalidBaseRef: 'checkout/invalid-base-ref',
  checkoutPathGuard: 'checkout/path-guard',
  checkoutDirty: 'checkout/dirty',
  checkoutMergeConflict: 'checkout/merge-conflict',
  checkoutMergeFailed: 'checkout/merge-failed',
  checkoutGitFailed: 'checkout/git-failed',
  checkoutNotReady: 'checkout/not-ready',
} as const

/** The one failure envelope every tool returns instead of throwing. */
export interface ToolFailure {
  ok: false
  error: { code: string; message: string; details?: unknown }
}

/** Build a failure envelope. */
export function failure(code: string, message: string, details?: unknown): ToolFailure {
  const error: { code: string; message: string; details?: unknown } = { code, message }
  if (details !== undefined) error.details = details
  return { ok: false, error }
}

/** Build a success envelope: the payload plus the `ok: true` discriminant. */
export function success<T extends Record<string, unknown>>(payload: T): { ok: true } & T {
  return { ok: true, ...payload }
}

/** The calling session, read from the structured execution identity only. */
export interface CallerIdentity {
  sessionId: string
  cwd: string
  agentPreset?: string
}

/**
 * Read the caller from `exec.agent`. Both the session id and the session
 * header's cwd must be non-empty strings; anything else returns `null` so the
 * tool can fail closed instead of guessing which project was meant.
 */
export function readCaller(exec: unknown): CallerIdentity | null {
  if (typeof exec !== 'object' || exec === null) return null
  const agent = (exec as { agent?: unknown }).agent
  if (typeof agent !== 'object' || agent === null) return null
  const id = (agent as { id?: unknown }).id
  const session = (agent as { session?: unknown }).session
  if (typeof session !== 'object' || session === null) return null
  const header = (session as { header?: unknown }).header
  if (typeof header !== 'object' || header === null) return null
  const cwd = (header as { cwd?: unknown }).cwd
  if (typeof id !== 'string' || id.trim() === '') return null
  if (typeof cwd !== 'string' || cwd.trim() === '') return null
  const agentPreset = (header as { agentPreset?: unknown }).agentPreset
  if (typeof agentPreset === 'string' && agentPreset.trim() !== '') {
    return { sessionId: id, cwd, agentPreset }
  }
  return { sessionId: id, cwd }
}

/** The slice of the project index the role gate reads. */
export interface RoleIndexView {
  masterSessionId: string
  threads: ReadonlyArray<{ threadId: string }>
}

/** Which party a tool is restricted to. */
export type RoleName = 'master' | 'thread' | 'master-or-thread'

/**
 * Check whether the caller may use a tool that requires `role`. Returns `null`
 * when allowed, otherwise a `role/forbidden` failure naming the expected role,
 * the caller, and the registered master.
 */
export function checkRole(
  role: RoleName,
  caller: CallerIdentity,
  index: RoleIndexView,
): ToolFailure | null {
  const isMaster = caller.sessionId === index.masterSessionId
  const isThread = index.threads.some((thread) => thread.threadId === caller.sessionId)
  const allowed = role === 'master' ? isMaster : role === 'thread' ? isThread : isMaster || isThread
  if (allowed) return null
  const expected =
    role === 'master'
      ? 'the master session'
      : role === 'thread'
        ? 'a thread session recorded in this project'
        : 'the master session or one of its threads'
  return failure(
    ERROR_CODES.roleForbidden,
    `this tool is restricted to ${expected}; session ${caller.sessionId} is neither (master is ${index.masterSessionId})`,
    { role, sessionId: caller.sessionId, masterSessionId: index.masterSessionId },
  )
}

/**
 * Branch prefix of a thread's private commits. Mirrors `CHECKOUT_BRANCH_PREFIX`
 * in src/checkout.ts; kept as a literal because this module imports nothing.
 */
const THREAD_BRANCH_PREFIX = 'cowork/'

/**
 * The opener a new thread receives: where the project is, which thread it owns,
 * what it must not touch, and the handoff contract it cannot skip. An isolated
 * thread also learns its clone path and the branch the master will merge.
 */
export function buildThreadBrief(input: {
  repoPath: string
  subject: string
  threadId: string
  intent?: string
  checkoutPath?: string | null
}): string {
  const lines = [
    `You are cowork thread ${input.threadId} in project ${input.repoPath}.`,
    `Subject: ${input.subject}`,
  ]
  const intent = input.intent?.trim() ?? ''
  if (intent !== '') lines.push(`User intent: ${intent}`)
  const checkoutPath = input.checkoutPath?.trim() ?? ''
  if (checkoutPath !== '') {
    lines.push(
      `Your isolated work area is ${checkoutPath} — a local git clone of the project, branch ${THREAD_BRANCH_PREFIX}${input.threadId}. Make all edits and commits there; do not modify the main repository. The master merges your branch after your handoff.`,
    )
  }
  lines.push(
    'Scope: work only inside this thread. Do not modify files owned by other threads, and do not change the project index by hand — the cowork tools write it.',
    'Read the project index and the latest handoff with cowork_project_status before you start.',
    'Before you stop (finished or blocked) you must call cowork_handoff with status (awaiting_review|blocked|done), a summary, and verification: [{command, exitCode, evidence}] for every check you ran.',
  )
  return lines.join('\n')
}

/** The router decision this module maps into a tool payload. */
export interface RouteDecisionLike {
  action: 'reuse' | 'create' | 'needs_subject'
  threadId?: string
  score?: number
  candidates: ReadonlyArray<{ threadId: string; subject: string; status: string; score: number }>
}

/** Map a router decision onto the payload the master sees. */
export function routePayload(decision: RouteDecisionLike): {
  action: 'routed' | 'created' | 'needs_subject'
  threadId?: string
  score?: number
  candidates: ReadonlyArray<{ threadId: string; subject: string; status: string; score: number }>
} {
  const candidates = decision.candidates.map((candidate) => ({
    threadId: candidate.threadId,
    subject: candidate.subject,
    status: candidate.status,
    score: candidate.score,
  }))
  if (decision.action === 'reuse') {
    return { action: 'routed', threadId: decision.threadId, score: decision.score, candidates }
  }
  if (decision.action === 'create') return { action: 'created', candidates }
  return { action: 'needs_subject', candidates }
}
