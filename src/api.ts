/**
 * Read-only HTTP surface of the Cowork panel.
 *
 * The two routes are mounted on the host `connection` service, whose Exact
 * Fetch channel authenticates browser requests before they reach us; unlike the
 * M0 probe routes on `ctx.webServer` this module therefore registers no
 * loopback guard of its own. Everything the routes need sits behind ports so
 * the wire mapping (overview assembly, latest-handoff choice, error mapping)
 * is unit-testable without a running host.
 *
 * Read-only by construction: the store port exposes only reads, and the
 * project root always comes from `sessionId` → session cwd → `findProjectRoot`.
 * A path sent by the browser is never trusted.
 */
import {
  HANDOFF_FORMATTER_VERSION,
  HANDOFF_PATH,
  MAX_PANEL_THREADS,
  OVERVIEW_PATH,
  countThreads,
  isPanelReviewSeverity,
  isPanelReviewStatus,
  isPanelReviewVerdict,
  isPanelThreadStatus,
  sortThreadsForPanel,
  type HandoffPayload,
  type HandoffResponse,
  type OverviewPayload,
  type OverviewResponse,
  type PanelErrorBody,
  type PanelErrorCode,
  type PanelReviewFinding,
  type PanelReviewPayload,
  type PanelReviewRecord,
  type PanelReviewVerification,
  type PanelThread,
} from './api-contract.js'
import { formatMasterMessage } from './handoff.js'
import type { HandoffFile, ProjectIndex, ThreadRecord } from './store.js'
import { StoreError } from './store.js'

/** One metadata row of the host's session listing; only id and cwd matter here. */
export interface PanelSessionRow {
  readonly sessionId: string
  /** The session's working directory; the only accepted start for project discovery. */
  readonly cwd?: string
}

/**
 * Store reads the routes may perform. `ProjectStore` satisfies this
 * structurally. The review reader is optional because the M3 review module and
 * the panel land on separate lines: when the store does not expose it yet, the
 * route falls back to the project's own text read, so a review pointer never
 * becomes a panel failure just because the store predates the field.
 */
export interface CoworkStorePort {
  hasIndex(): Promise<boolean>
  readIndex(): Promise<ProjectIndex>
  listHandoffs(): Promise<HandoffFile[]>
  /** Read and validate one review file; `store/not-found` when it is gone. */
  readReview?(filePath: string): Promise<unknown>
  /** Raw text read of a project-owned file; `null` when the file is gone. */
  readText?(absPath: string): Promise<string | null>
}

/**
 * Optional review fields of one index thread. Indexes written before M3 carry
 * none of them, and this module must stay readable against such a project.
 */
interface ThreadReviewFields {
  readonly reviewStatus?: unknown
  readonly reviewedAt?: unknown
  readonly reviewerSessionId?: unknown
  /** Absolute path of the thread's latest review file, or null. */
  readonly latestReviewPath?: unknown
}

/** The host facts a route needs, injected so tests can stand in for the host. */
export interface CoworkApiPorts {
  /**
   * Session metadata, deliberately `list` and not `inspect`: on a live host
   * `inspect` waits for the session's event log (the panel request hung on
   * running or large sessions), while the listing is a cheap summary read that
   * already carries `cwd`.
   */
  listSessions(): Promise<{ readonly items: readonly PanelSessionRow[] }>
  /**
   * Bound on {@link listSessions}, in milliseconds. Production leaves this
   * unset and gets {@link LIST_SESSIONS_TIMEOUT_MS}; tests inject a few
   * milliseconds so the timeout path is deterministic without waiting 30 s.
   * Not part of the wire contract: it only bounds the host call.
   */
  listSessionsTimeoutMs?: number
  findProjectRoot(startPath: string): Promise<string | null>
  createStore(repoPath: string): CoworkStorePort
}

/** Methods the connection channel supports for a registered route. */
export type PanelFetchMethod = 'GET' | 'HEAD' | 'POST'
/** Whether the channel buffers or streams the request body before the handler. */
export type PanelRequestBodyMode = 'buffered' | 'streaming'

/** One Exact Fetch route as the host `connection` service declares it. */
export interface PanelFetchRoute {
  readonly path: string
  readonly methods: readonly PanelFetchMethod[]
  readonly requestBody: PanelRequestBodyMode
  readonly fetch: (request: Request) => Promise<Response>
}

/** The slice of the host `connection` service this module registers on. */
export interface CoworkConnection {
  readonly fetch: {
    register(route: PanelFetchRoute): () => Promise<void>
  }
}

/**
 * The Cordis context surface used here. `get` mirrors `ctx.get(name)`: it
 * returns `undefined` when the service is absent instead of throwing, which is
 * what keeps the plugin loadable in a host without `connection`.
 */
export interface CoworkApiHost {
  get(name: string): unknown
  effect(execute: () => unknown, label?: string): void
}

/** A failure the routes map to a stable panel error code and HTTP status. */
export class PanelApiError extends Error {
  readonly code: PanelErrorCode
  readonly path: string | undefined

  constructor(code: PanelErrorCode, message: string, path?: string) {
    super(message)
    this.name = 'PanelApiError'
    this.code = code
    this.path = path
  }
}

/** One route failure: HTTP status plus the shared error envelope. */
export interface PanelErrorResult {
  readonly status: number
  readonly body: PanelErrorBody
}

/** HTTP status per stable error code; the panel keys its states off the code. */
const PANEL_ERROR_STATUS: Readonly<Record<PanelErrorCode, number>> = {
  'request/session-required': 400,
  'request/thread-required': 400,
  'session/unknown': 400,
  'session/cwd-unavailable': 400,
  'session/list-timeout': 504,
  'project/not-initialized': 404,
  'handoff/not-found': 404,
  'store/corrupt': 500,
  internal: 500,
}

/**
 * How long a route waits for the host's session listing. The listing is a
 * metadata read that answers in milliseconds on a healthy host, but an old
 * fiber or a very large session list has been observed to hang for minutes
 * (KI-12); waiting forever turns that into an endless panel spinner. Giving up
 * with a retryable 504 is better than a request that never settles.
 */
export const LIST_SESSIONS_TIMEOUT_MS = 30_000

const JSON_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json; charset=utf-8',
  // Every response is a live read of local files; a cached body would show a
  // stale project as if it were current.
  'cache-control': 'no-store',
}

/** HTTP status for a stable error code. */
export function panelErrorStatus(code: PanelErrorCode): number {
  return PANEL_ERROR_STATUS[code]
}

function errorBody(code: PanelErrorCode, message: string, path?: string): PanelErrorBody {
  const error: { code: PanelErrorCode; message: string; path?: string } = { code, message }
  if (path !== undefined) error.path = path
  return { ok: false, error }
}

/**
 * Map any failure the routes may raise onto the panel error contract:
 * `PanelApiError` keeps its code, a corrupt store keeps its file path, and
 * everything else degrades to `internal` rather than leaking a status the
 * client cannot interpret.
 */
export function toErrorResponse(error: unknown): PanelErrorResult {
  if (error instanceof PanelApiError) {
    return { status: panelErrorStatus(error.code), body: errorBody(error.code, error.message, error.path) }
  }
  if (error instanceof StoreError && error.code === 'store/corrupt') {
    return { status: 500, body: errorBody('store/corrupt', error.message, error.filePath) }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { status: 500, body: errorBody('internal', message) }
}

/** One JSON response with the headers both panel endpoints share. */
export function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS })
}

/** A query parameter, or null when absent or blank. GET routes carry no body. */
function queryParam(request: Request, name: string): string | null {
  const value = new URL(request.url).searchParams.get(name)
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Await the session listing with a bound. The losing branch of the race keeps
 * a handler attached: if the host listing rejects after the timeout already
 * answered 504, that late rejection must not surface as an unhandled rejection.
 * The timer is cleared in `finally`, so the successful path leaves none behind
 * either.
 */
async function listSessionsBounded(ports: CoworkApiPorts): Promise<readonly PanelSessionRow[]> {
  const timeoutMs = ports.listSessionsTimeoutMs ?? LIST_SESSIONS_TIMEOUT_MS
  const pending = ports.listSessions()
  void pending.catch(() => { /* answered by the race below; keeps a late rejection quiet */ })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new PanelApiError(
          'session/list-timeout',
          `session listing did not answer within ${timeoutMs} ms; `
            + 'the host may still be loading a large session list, retry the request',
        ))
      }, timeoutMs)
    })
    const { items } = await Promise.race([pending, timeout])
    return items
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Resolve the project root for a session. The browser only ever sends a
 * session id: the cwd comes from the host, so a crafted `path` parameter can
 * never read a repository the caller's session does not belong to.
 *
 * The cwd is read from session metadata (`listSessions`). A failure of that
 * listing is a host failure and falls through to `internal`; only a listing
 * that does not contain the id is reported as an unknown session. A listing
 * that never answers becomes `session/list-timeout` instead of hanging the
 * request forever.
 */
async function resolveProjectRoot(ports: CoworkApiPorts, sessionId: string): Promise<string> {
  const items = await listSessionsBounded(ports)
  const row = items.find((item) => item.sessionId === sessionId)
  if (row === undefined) {
    throw new PanelApiError('session/unknown', `unknown session: ${sessionId}`)
  }
  const cwd = row.cwd
  if (cwd === undefined || cwd.trim() === '') {
    throw new PanelApiError('session/cwd-unavailable', `session has no working directory: ${sessionId}`)
  }
  const repoPath = await ports.findProjectRoot(cwd)
  if (repoPath === null) {
    throw new PanelApiError(
      'project/not-initialized',
      `no .dsh-cowork project above ${cwd}`,
      cwd,
    )
  }
  return repoPath
}

/** Whether one index entry belongs in the panel (archived threads never do). */
export function isListableThread(
  thread: ThreadRecord,
): thread is ThreadRecord & { readonly status: PanelThread['status'] } {
  return thread.status !== 'archived' && isPanelThreadStatus(thread.status)
}

/** A trimmed non-empty string, or null: the index may hold '' or a non-string. */
function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** Project one index entry into the wire shape the panel renders. */
export function toPanelThread(
  record: ThreadRecord & { readonly status: PanelThread['status'] },
): PanelThread {
  // Review fields are read through the optional view: an index written before
  // M3 has none of them, and that must degrade to null, not to a broken row.
  const review = record as unknown as ThreadReviewFields
  return {
    threadId: record.threadId,
    subject: record.subject,
    status: record.status,
    cwd: record.cwd,
    checkoutPath: record.checkoutPath,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastHandoffAt: record.lastHandoffAt,
    // The panel only needs the marker; deriving it keeps the wire honest when
    // an older index lacks the derived field.
    hasHandoff: record.lastHandoffAt !== null,
    reviewStatus: isPanelReviewStatus(review.reviewStatus) ? review.reviewStatus : null,
    reviewedAt: optionalString(review.reviewedAt),
    reviewerSessionId: optionalString(review.reviewerSessionId),
  }
}

/**
 * Overview body: listable threads in panel order, capped, with counts computed
 * from the returned rows so the header chips can never disagree with the list.
 */
export function buildOverview(index: ProjectIndex, repoPath: string): OverviewPayload {
  const threads = sortThreadsForPanel(index.threads.filter(isListableThread).map(toPanelThread))
    .slice(0, MAX_PANEL_THREADS)
  return {
    project: {
      repoPath,
      projectId: index.projectId,
      masterSessionId: index.masterSessionId,
      createdAt: index.createdAt,
    },
    counts: countThreads(threads),
    threads,
  }
}

/**
 * Normalize one finding of a review file. A row the panel cannot render is
 * dropped rather than blanking the whole review: the file path stays visible,
 * so the raw document can still be inspected.
 */
function toPanelReviewFinding(value: unknown): PanelReviewFinding | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  if (!optionalString(row.id) || !optionalString(row.problem) || !optionalString(row.requiredFix)) return null
  if (!isPanelReviewSeverity(row.severity)) return null
  const finding: {
    id: string
    severity: PanelReviewFinding['severity']
    problem: string
    requiredFix: string
    file?: string
    line?: number
  } = {
    id: row.id as string,
    severity: row.severity,
    problem: row.problem as string,
    requiredFix: row.requiredFix as string,
  }
  const file = optionalString(row.file)
  if (file !== null) finding.file = file
  if (typeof row.line === 'number' && Number.isInteger(row.line) && row.line > 0) finding.line = row.line
  return finding
}

/** Normalize one reviewer verification row; same leniency as findings. */
function toPanelReviewVerification(value: unknown): PanelReviewVerification | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  if (!optionalString(row.command)) return null
  if (typeof row.exitCode !== 'number' || !Number.isInteger(row.exitCode)) return null
  if (typeof row.evidence !== 'string') return null
  return { command: row.command as string, exitCode: row.exitCode, evidence: row.evidence }
}

/**
 * Narrow one review document to the wire record. Returns null when the verdict
 * or one of the identity fields is unusable: without a verdict the panel cannot
 * label the review, so the caller reports the file as corrupt instead of
 * inventing a state.
 */
export function toPanelReviewRecord(document: unknown): PanelReviewRecord | null {
  if (typeof document !== 'object' || document === null) return null
  const record = document as Record<string, unknown>
  if (!isPanelReviewVerdict(record.verdict)) return null
  if (typeof record.summary !== 'string') return null
  if (!optionalString(record.reviewerSessionId)) return null
  if (!optionalString(record.createdAt)) return null
  const findings = Array.isArray(record.findings)
    ? record.findings.map(toPanelReviewFinding).filter((row): row is PanelReviewFinding => row !== null)
    : []
  const verification = Array.isArray(record.verification)
    ? record.verification.map(toPanelReviewVerification).filter((row): row is PanelReviewVerification => row !== null)
    : []
  return {
    version: 1,
    threadId: optionalString(record.threadId) ?? '',
    reviewerSessionId: record.reviewerSessionId as string,
    verdict: record.verdict,
    summary: record.summary,
    findings,
    verification,
    createdAt: record.createdAt as string,
  }
}

/** Whether a read failure means "the pointer file is gone" rather than "unreadable". */
function isMissingReviewFile(error: unknown): boolean {
  return error instanceof StoreError && error.code === 'store/not-found'
}

/**
 * Read the review file an index pointer names. `null` means the pointer file no
 * longer exists; a damaged document is `store/corrupt`, and any other failure
 * propagates to the shared error mapping. The path is never guessed from the
 * reviews directory: only the index pointer decides which verdict is current.
 */
export async function readReviewPayload(
  store: CoworkStorePort,
  filePath: string,
): Promise<PanelReviewPayload | null> {
  let document: unknown
  if (typeof store.readReview === 'function') {
    try {
      document = await store.readReview(filePath)
    } catch (error) {
      if (isMissingReviewFile(error)) return null
      throw error
    }
  } else if (typeof store.readText === 'function') {
    const text = await store.readText(filePath)
    if (text === null) return null
    try {
      document = JSON.parse(text)
    } catch (error) {
      throw new StoreError(
        'store/corrupt',
        `${filePath}: invalid review JSON (${(error as Error).message})`,
        filePath,
      )
    }
  } else {
    // A host whose store exposes no read path at all: the review is unknown,
    // and the panel must still render the handoff.
    return null
  }
  const record = toPanelReviewRecord(document)
  if (record === null) {
    throw new StoreError('store/corrupt', `${filePath}: invalid review document`, filePath)
  }
  return { record, filePath }
}

/** The review pointer of one index thread, or null when it has none. */
function latestReviewPathOf(record: ThreadRecord | undefined): string | null {
  if (record === undefined) return null
  return optionalString((record as unknown as ThreadReviewFields).latestReviewPath)
}

/** Latest review of one thread, resolved through the index pointer only. */
export async function readThreadReview(
  store: CoworkStorePort,
  index: ProjectIndex,
  threadId: string,
): Promise<PanelReviewPayload | null> {
  const pointer = latestReviewPathOf(index.threads.find((thread) => thread.threadId === threadId))
  if (pointer === null) return null
  return readReviewPayload(store, pointer)
}


/** Whether `candidate` is newer than `current`; equal timestamps fall back to the file name. */
function isNewerHandoff(candidate: HandoffFile, current: HandoffFile): boolean {
  const delta = Date.parse(candidate.record.createdAt) - Date.parse(current.record.createdAt)
  if (Number.isFinite(delta) && delta !== 0) return delta > 0
  // Names carry a sortable stamp; the larger one is the later write.
  return candidate.fileName.localeCompare(current.fileName) > 0
}

/** The newest handoff of one thread, or null when it has none. */
export function selectLatestHandoff(
  files: readonly HandoffFile[],
  threadId: string,
): HandoffFile | null {
  let latest: HandoffFile | null = null
  for (const file of files) {
    if (file.record.threadId !== threadId) continue
    if (latest === null || isNewerHandoff(file, latest)) latest = file
  }
  return latest
}

/**
 * Handoff body: the stored record plus the message the master received. The
 * message is re-rendered on read (never stored), so the formatter version
 * travels with it and a rendering change is visible instead of silent. The
 * optional review is the thread's latest verdict, already resolved by the
 * caller from the index pointer.
 */
export function buildHandoffPayload(
  file: HandoffFile,
  review: PanelReviewPayload | null = null,
): HandoffPayload {
  return {
    record: file.record,
    filePath: file.filePath,
    masterMessage: formatMasterMessage(file.record, file.filePath),
    formatterVersion: HANDOFF_FORMATTER_VERSION,
    review,
  }
}

async function handleOverview(request: Request, ports: CoworkApiPorts): Promise<Response> {
  try {
    const sessionId = queryParam(request, 'sessionId')
    if (sessionId === null) {
      throw new PanelApiError('request/session-required', 'query parameter sessionId is required')
    }
    const repoPath = await resolveProjectRoot(ports, sessionId)
    const store = ports.createStore(repoPath)
    if (!(await store.hasIndex())) {
      // findProjectRoot guarantees an index, so this only fires when the file
      // vanished between discovery and read (concurrent checkout switch).
      throw new PanelApiError('project/not-initialized', `project index is missing under ${repoPath}`, repoPath)
    }
    const response: OverviewResponse = { ok: true, ...buildOverview(await store.readIndex(), repoPath) }
    return jsonResponse(200, response)
  } catch (error) {
    const { status, body } = toErrorResponse(error)
    return jsonResponse(status, body)
  }
}

async function handleHandoff(request: Request, ports: CoworkApiPorts): Promise<Response> {
  try {
    const sessionId = queryParam(request, 'sessionId')
    if (sessionId === null) {
      throw new PanelApiError('request/session-required', 'query parameter sessionId is required')
    }
    const threadId = queryParam(request, 'threadId')
    if (threadId === null) {
      throw new PanelApiError('request/thread-required', 'query parameter threadId is required')
    }
    const repoPath = await resolveProjectRoot(ports, sessionId)
    const store = ports.createStore(repoPath)
    if (!(await store.hasIndex())) {
      throw new PanelApiError('project/not-initialized', `project index is missing under ${repoPath}`, repoPath)
    }
    const latest = selectLatestHandoff(await store.listHandoffs(), threadId)
    if (latest === null) {
      throw new PanelApiError('handoff/not-found', `thread has no handoff: ${threadId}`)
    }
    // The review pointer lives on the thread's index row: a review file that
    // exists in the directory but is not pointed at is not the current verdict.
    const review = await readThreadReview(store, await store.readIndex(), threadId)
    const response: HandoffResponse = { ok: true, handoff: buildHandoffPayload(latest, review) }
    return jsonResponse(200, response)
  } catch (error) {
    const { status, body } = toErrorResponse(error)
    return jsonResponse(status, body)
  }
}

/**
 * Register both panel routes on the host connection service.
 *
 * A host without `connection` (older builds, unit hosts) simply gets no panel
 * API: this returns without throwing so the rest of the plugin keeps loading.
 * The disposer returned by `register` rides the plugin fiber through
 * `ctx.effect`, so a hot reload unregisters the route instead of tripping over
 * a duplicate on the next load.
 */
export function registerCoworkApi(host: CoworkApiHost, ports: CoworkApiPorts): void {
  const connection = host.get('connection') as CoworkConnection | undefined
  if (connection === undefined) return
  const routes: readonly PanelFetchRoute[] = [
    {
      path: OVERVIEW_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => handleOverview(request, ports),
    },
    {
      path: HANDOFF_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => handleHandoff(request, ports),
    },
  ]
  for (const route of routes) {
    host.effect(() => connection.fetch.register(route), `dsh-cowork: panel route ${route.path}`)
  }
}
