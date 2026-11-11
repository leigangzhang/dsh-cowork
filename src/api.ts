/**
 * HTTP surface of the CoWork panel (M11, wire v2).
 *
 * Seven Exact Fetch routes live on the host `connection` service: three reads
 * (`overview`, `activity`, `topic`) and four writes (`resolve`, `reopen`,
 * `authorization.resolve`, `route.move`). `resolve`/`reopen`/`route.move` are
 * master-only; `authorization.resolve` accepts the master or the topic's own
 * session. The browser never names a filesystem path: the
 * project root comes from `sessionId` → session cwd → `findProjectRoot`, and
 * everything the routes need sits behind ports so the wire mapping is testable
 * without a running host.
 *
 * Two rules from the M11 handoff shape this module:
 *
 * - Reads report facts, not process. A topic carries its lifecycle, its review
 *   state, and its open work-item count; the reviewer session and the handoff
 *   text are not on the wire. Review cards come from the request files in
 *   `reviews/` (KI-18); the legacy per-topic review pointer is never read, and
 *   the write-only review helpers of the old store are not on the port.
 * - A write is one lock-scoped transaction. `mutateIndexDocument` owns the
 *   project lock and its activity row is appended afterwards, in a second
 *   independent lock acquisition: wrapping both in `withWriteLock` would
 *   deadlock on the non-reentrant file lock. An activity failure is logged and
 *   never turns a committed write into an error response.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ACTIVITY_DEFAULT_LIMIT,
  ACTIVITY_MAX_LIMIT,
  ACTIVITY_PATH,
  AUTHORIZATION_RESOLVE_PATH,
  MAX_INBOX_ITEMS,
  MAX_PANEL_TOPICS,
  MAX_REQUEST_BODY_BYTES,
  MAX_REVIEW_CHANGED_PATHS,
  MAX_REVIEW_FINDINGS,
  MAX_REVIEW_VERIFICATION,
  MAX_TOPIC_OWNED_PATHS,
  MAX_TOPIC_REVIEW_REQUESTS,
  MAX_TOPIC_WORK_ITEMS,
  OVERVIEW_PATH,
  REOPEN_PATH,
  RESOLVE_PATH,
  ROUTE_MOVE_PATH,
  TOPIC_ACTIVITY_LIMIT,
  TOPIC_PATH,
  countPanel,
  isPanelBlockedReason,
  isPanelReviewSeverity,
  isPanelReviewStatus,
  isPanelWorkItemStatus,
  sortTopicsForPanel,
  truncateSummary,
  type ActivityResponse,
  type AuthorizationResolveResponse,
  type OverviewResponse,
  type PanelActivityEvent,
  type PanelErrorBody,
  type PanelErrorCode,
  type PanelInboxItem,
  type PanelProject,
  type PanelReviewFinding,
  type PanelReviewRequest,
  type PanelReviewVerification,
  type PanelTopic,
  type PanelWorkItem,
  type ReopenResponse,
  type ResolveResponse,
  type RouteMoveResponse,
  type TopicResponse,
} from './api-contract.js'
import { authorizationResolvedActivity, buildActivityEvent, topicReopenedActivity } from './activity.js'
import {
  updateAuthorizationNotice,
} from './notices.js'
import type { NoticeUpdateOutcome, TopicNoticePort } from './notices.js'
import { isLoopbackHost } from './probe-model.js'
import { parseReviewRequestRecord, reviewRequestFileName } from './review-request.js'
import type { ReviewRequestRecord } from './review-request.js'
import { applyRouteCorrection } from './routing.js'
import { ACTIVITY_MAX_EVENTS } from './store-schema.js'
import type {
  ActivityEvent,
  InboxItem,
  ProjectIndexV2,
  ReadActivityResult,
  ReviewFinding,
  ReviewVerification,
  TopicRecordV2,
  WorkItemRecordV2,
} from './store-schema.js'
import { StoreError } from './store.js'
import { DEFAULT_IDLE_AFTER_MS, reopenResolvedTopic, unblockTopic } from './topic.js'
import { activeWorkItemCount } from './work-item.js'
import { archiveTopic, evaluateProjectLifecycle } from './tool-runtime.js'

/** One metadata row of the host's session listing; only id and cwd matter here. */
export interface PanelSessionRow {
  readonly sessionId: string
  /** The session's working directory; the only accepted start for project discovery. */
  readonly cwd?: string
}

/**
 * Store operations the routes may perform. `ProjectStore` satisfies this
 * structurally. The writer half (`mutateIndexDocument`/`appendActivity`) is used
 * only by the three POST routes; the reads never call a write.
 */
export interface CoworkStorePort {
  hasIndex(): Promise<boolean>
  readIndexDocument(): Promise<ProjectIndexV2>
  mutateIndexDocument(mutator: (document: ProjectIndexV2) => ProjectIndexV2 | null): Promise<ProjectIndexV2>
  appendActivity(event: ActivityEvent): Promise<void>
  readActivity(limit?: number): Promise<ReadActivityResult>
  readInbox(): Promise<InboxItem[]>
  /** Raw text read of one project-owned file; `null` when the file is gone. */
  readText(absPath: string): Promise<string | null>
  /** `<repo>/.dsh-cowork/reviews`, the only home of review-request facts. */
  readonly reviewsDir: string
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
  /**
   * Clock for the write routes and the lifecycle read point. Production passes
   * the same `() => new Date()` that the store stamps with; tests freeze it.
   */
  now?(): Date
  /** Idle threshold for the lifecycle read point; `src/topic.ts` owns the default. */
  idleAfterMs?: number
  /**
   * Deprecated and ignored: the lifecycle no longer resolves a topic on its
   * own. Kept so a caller wired for the old `resolveAfterMs` still typechecks.
   */
  resolveAfterMs?: number
  /** Diagnostic sink for a non-fatal failure (lifecycle/activity write). */
  log?(message: string): void
  /** Archive the host session of an archived topic; a failure is logged only. */
  archiveSession?(sessionId: string, options?: { stopActivity?: boolean }): Promise<void>
  /** Restore the host session of a reopened topic; a failure is logged only. */
  unarchiveSession?(sessionId: string): Promise<void>
  /** Prompt the topic session after an authorization decision. */
  promptSession?(sessionId: string, text: string): Promise<{ accepted: boolean }>
  /** Host notice port, used to update the original authorization notice. */
  noticePort?: TopicNoticePort
  /** Schedule the notice dispatcher for one project after a committed write. */
  kickNotices?(repoPath: string): void
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

/** The longest `route.move` intent the panel accepts, in code points. */
const ROUTE_MOVE_INTENT_MAX_CHARS = 500

/** Most alias tokens one `route-corrected` activity carries. */
const ROUTE_CORRECTION_DETAILS_MAX_TOKENS = 20

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

/**
 * HTTP status per stable error code. Typed as a complete `Record`, so adding a
 * code to the contract without deciding its status is a compile error.
 */
const PANEL_ERROR_STATUS: Readonly<Record<PanelErrorCode, number>> = {
  'request/session-required': 400,
  'request/topic-required': 400,
  'request/invalid-query': 400,
  'request/invalid-body': 400,
  'request/body-too-large': 413,
  'request/content-type': 415,
  'request/origin': 403,
  'request/not-master': 403,
  'topic/not-found': 404,
  'topic/not-resolved': 409,
  'authorization/not-found': 404,
  'authorization/mismatch': 409,
  'authorization/not-allowed': 403,
  'route/move-invalid': 400,
  'session/unknown': 400,
  'session/cwd-unavailable': 400,
  'session/list-timeout': 504,
  'project/not-initialized': 404,
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

/** One JSON response with the headers every panel route shares. */
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

/** A required query parameter; a blank value is missing, not empty. */
function requireQueryParam(request: Request, name: string, code: PanelErrorCode): string {
  const value = queryParam(request, name)
  if (value === null) {
    throw new PanelApiError(code, `query parameter ${name} is required`)
  }
  return value
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

/** A project store opened for one request, plus the root the panel reports. */
interface OpenedProject {
  readonly store: CoworkStorePort
  readonly repoPath: string
}

/**
 * Discover the project and refuse an index that vanished between discovery and
 * read. `findProjectRoot` guarantees an index, so the check only fires when the
 * file was removed by a concurrent checkout switch.
 */
async function openProject(ports: CoworkApiPorts, sessionId: string): Promise<OpenedProject> {
  const repoPath = await resolveProjectRoot(ports, sessionId)
  const store = ports.createStore(repoPath)
  if (!(await store.hasIndex())) {
    throw new PanelApiError('project/not-initialized', `project index is missing under ${repoPath}`, repoPath)
  }
  return { store, repoPath }
}

/**
 * The M9/M10 lifecycle read point, now on the panel's read path: evaluate every
 * topic inside the project lock with real in-flight work-item counts (KI-24),
 * so a topic whose work is still running is never auto-resolved. A failing
 * activity row is reported to the host log; the panel request still serves.
 */
async function runLifecycle(store: CoworkStorePort, ports: CoworkApiPorts): Promise<void> {
  const evaluation = await evaluateProjectLifecycle(store, {
    now: ports.now?.() ?? new Date(),
    idleAfterMs: ports.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS,
    activeWorkItemsOf: (topicId, document) => activeWorkItemCount(document, topicId),
  })
  for (const failure of evaluation.activityErrors) {
    ports.log?.(`panel overview: lifecycle activity not recorded: ${failure}`)
  }
}

/** A trimmed non-empty string, or null: an index may hold '' or a non-string. */
function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * Project one v2 topic onto the wire shape. Review state comes from the index
 * row (the request files carry the detail); `reviews` are read separately by
 * the topic route. No reviewer session or handoff text is copied onto the wire.
 */
export function toPanelTopic(document: ProjectIndexV2, topic: TopicRecordV2): PanelTopic {
  return {
    topicId: topic.topicId,
    title: topic.title,
    status: topic.status,
    blocked: topic.blocked,
    blockedReason: isPanelBlockedReason(topic.blockedReason) ? topic.blockedReason : null,
    awaitingAuthorization: topic.authorization !== null && topic.authorization !== undefined,
    awaitingReview: topic.awaitingReview,
    reviewStatus: isPanelReviewStatus(topic.reviewStatus) ? topic.reviewStatus : null,
    latestReviewRequestId: optionalString(topic.latestReviewRequestId),
    digest: truncateSummary(topic.digest),
    scope: truncateSummary(topic.scope),
    ownedPaths: topic.ownedPaths.slice(0, MAX_TOPIC_OWNED_PATHS),
    lastActiveAt: topic.lastActiveAt,
    updatedAt: topic.updatedAt,
    lastDeliveryConfirmedAt: optionalString(topic.lastDeliveryConfirmedAt),
    resolvedAt: optionalString(topic.resolvedAt),
    resolvedBy: topic.resolvedBy === 'user' || topic.resolvedBy === 'master' ? topic.resolvedBy : null,
    activeWorkItems: activeWorkItemCount(document, topic.topicId),
  }
}

/** Project one v2 work item onto the wire shape; an unknown state is skipped. */
function toPanelWorkItem(item: WorkItemRecordV2): PanelWorkItem | null {
  if (!isPanelWorkItemStatus(item.status)) return null
  return {
    workItemId: item.workItemId,
    topicId: item.topicId,
    path: item.path,
    branch: item.branch,
    baseCommit: optionalString(item.baseCommit),
    headCommit: optionalString(item.headCommit),
    status: item.status,
    updatedAt: item.updatedAt,
  }
}

/** Project one inbox item onto the wire shape. */
function toPanelInboxItem(item: InboxItem): PanelInboxItem {
  return {
    id: item.id,
    time: item.time,
    topicId: item.topicId,
    kind: item.kind,
    summary: truncateSummary(item.summary),
    deliveredAt: optionalString(item.deliveredAt),
  }
}

/** Project one activity row onto the wire shape. */
function toPanelActivityEvent(event: ActivityEvent): PanelActivityEvent {
  return {
    eventId: event.eventId,
    time: event.time,
    type: event.type,
    topicId: event.topicId,
    summary: truncateSummary(event.summary),
  }
}

/** Project one stored finding; its text is already bounded by the schema. */
function toPanelFinding(finding: ReviewFinding): PanelReviewFinding {
  const row: {
    id: string
    severity: PanelReviewFinding['severity']
    problem: string
    requiredFix: string
    file?: string
    line?: number
  } = {
    id: finding.id,
    severity: isPanelReviewSeverity(finding.severity) ? finding.severity : 'low',
    problem: finding.problem,
    requiredFix: finding.requiredFix,
  }
  const file = optionalString(finding.file)
  if (file !== null) row.file = file
  if (typeof finding.line === 'number' && Number.isInteger(finding.line) && finding.line > 0) {
    row.line = finding.line
  }
  return row
}

/** Project one stored verification row onto the wire shape. */
function toPanelVerification(row: ReviewVerification): PanelReviewVerification {
  return { command: row.command, exitCode: row.exitCode, evidence: row.evidence }
}

/**
 * Project one parsed request file onto the review card. Collections are
 * truncated here rather than in the contract, so the browser bundle stays
 * unaware of the file format; `purpose` is shown verbatim (the schema bounds it
 * to {@link REVIEW_PURPOSE_MAX_CHARS}).
 */
function toPanelReviewRequest(record: ReviewRequestRecord): PanelReviewRequest {
  return {
    requestId: record.requestId,
    topicId: record.topicId,
    workItemId: optionalString(record.workItemId),
    purpose: record.purpose,
    status: record.status,
    baseCommit: record.baseCommit,
    headCommit: record.headCommit,
    changedPaths: record.changedPaths.slice(0, MAX_REVIEW_CHANGED_PATHS),
    requestedAt: record.requestedAt,
    reviewedAt: optionalString(record.reviewedAt),
    summary: typeof record.summary === 'string' ? truncateSummary(record.summary) : null,
    findings: record.findings.slice(0, MAX_REVIEW_FINDINGS).map(toPanelFinding),
    verification: record.reviewVerification.slice(0, MAX_REVIEW_VERIFICATION).map(toPanelVerification),
  }
}

/** Descending comparison of two ISO timestamps; unparseable values sort last. */
function compareRequestedAtDescending(left: string, right: string): number {
  const leftTime = Date.parse(left)
  const rightTime = Date.parse(right)
  const leftValue = Number.isFinite(leftTime) ? leftTime : Number.NEGATIVE_INFINITY
  const rightValue = Number.isFinite(rightTime) ? rightTime : Number.NEGATIVE_INFINITY
  if (leftValue === rightValue) return 0
  return leftValue > rightValue ? -1 : 1
}

/**
 * Every review request of one topic, newest first and bounded.
 *
 * The request files are the only source (KI-18): a file is accepted only when
 * it parses as a request record AND its name equals
 * `reviewRequestFileName(record.topicId, record.requestId)`. A legacy
 * verdict-only file, a damaged file, a request of another topic, and a request
 * stored under a mismatched name are all skipped — never guessed at. Reading
 * them cannot fail the topic: an unreadable reviews directory is an empty list.
 */
async function readReviewRequests(store: CoworkStorePort, topicId: string): Promise<PanelReviewRequest[]> {
  const prefix = `${topicId}-`
  let names: string[]
  try {
    names = (await readdir(store.reviewsDir)).sort()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw error
  }
  const requests: PanelReviewRequest[] = []
  for (const fileName of names) {
    if (!fileName.startsWith(prefix) || !fileName.endsWith('.json')) continue
    const text = await store.readText(join(store.reviewsDir, fileName))
    if (text === null) continue
    const parsed = parseReviewRequestRecord(text)
    if (!parsed.ok) continue
    const record = parsed.record
    if (reviewRequestFileName(record.topicId, record.requestId) !== fileName) continue
    requests.push(toPanelReviewRequest(record))
  }
  return requests
    .sort((left, right) => compareRequestedAtDescending(left.requestedAt, right.requestedAt))
    .slice(0, MAX_TOPIC_REVIEW_REQUESTS)
}

/** The header counts and project identity shared by the overview body. */
function overviewProject(index: ProjectIndexV2, repoPath: string): PanelProject {
  return {
    repoPath,
    projectId: index.projectId,
    masterSessionId: index.masterSessionId,
    createdAt: index.createdAt,
  }
}

/** `GET overview`: project header, ordered topics, counts, and pending inbox. */
async function handleOverview(request: Request, ports: CoworkApiPorts): Promise<Response> {
  const sessionId = requireQueryParam(request, 'sessionId', 'request/session-required')
  const { store, repoPath } = await openProject(ports, sessionId)
  await runLifecycle(store, ports)
  // Read after the lifecycle pass: the document the panel shows must include
  // the transitions that pass just committed.
  const document = await store.readIndexDocument()
  const topics = sortTopicsForPanel(document.topics.map((topic) => toPanelTopic(document, topic)))
    .slice(0, MAX_PANEL_TOPICS)
  const inbox = (await store.readInbox())
    .filter((item) => item.deliveredAt === null)
    .slice(-MAX_INBOX_ITEMS)
    .map(toPanelInboxItem)
  const response: OverviewResponse = {
    ok: true,
    project: overviewProject(document, repoPath),
    counts: countPanel(topics, document.workItems),
    topics,
    inbox,
  }
  return jsonResponse(200, response)
}

/** Parse `limit`: absent means the default, anything else must be 1..max. */
function parseActivityLimit(request: Request): number {
  const raw = queryParam(request, 'limit')
  if (raw === null) return ACTIVITY_DEFAULT_LIMIT
  const invalid = (detail: string): PanelApiError => new PanelApiError(
    'request/invalid-query',
    `query parameter limit ${detail}; expected an integer between 1 and ${ACTIVITY_MAX_LIMIT}`,
  )
  if (!/^\d+$/.test(raw)) throw invalid(`is not an integer: ${raw}`)
  const limit = Number(raw)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ACTIVITY_MAX_LIMIT) {
    throw invalid(`is out of range: ${raw}`)
  }
  return limit
}

/** `GET activity`: the newest events, oldest first, plus skipped-line count. */
async function handleActivity(request: Request, ports: CoworkApiPorts): Promise<Response> {
  const sessionId = requireQueryParam(request, 'sessionId', 'request/session-required')
  const limit = parseActivityLimit(request)
  const { store } = await openProject(ports, sessionId)
  const { events, skippedLines } = await store.readActivity(limit)
  const response: ActivityResponse = {
    ok: true,
    events: events.map(toPanelActivityEvent),
    skippedLines,
  }
  return jsonResponse(200, response)
}

/** `GET topic`: one topic with its bounded work items, reviews, and activity. */
async function handleTopic(request: Request, ports: CoworkApiPorts): Promise<Response> {
  const sessionId = requireQueryParam(request, 'sessionId', 'request/session-required')
  const topicId = requireQueryParam(request, 'topicId', 'request/topic-required')
  const { store } = await openProject(ports, sessionId)
  const document = await store.readIndexDocument()
  const record = document.topics.find((topic) => topic.topicId === topicId)
  if (record === undefined) {
    throw new PanelApiError('topic/not-found', `unknown topic: ${topicId}`)
  }
  const workItems = document.workItems
    .filter((item) => item.topicId === topicId)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, MAX_TOPIC_WORK_ITEMS)
    .map(toPanelWorkItem)
    .filter((item): item is PanelWorkItem => item !== null)
  const reviewRequests = await readReviewRequests(store, topicId)
  const { events } = await store.readActivity(ACTIVITY_MAX_LIMIT)
  const activity = events
    .filter((event) => event.topicId === topicId)
    .slice(-TOPIC_ACTIVITY_LIMIT)
    .map(toPanelActivityEvent)
  const response: TopicResponse = {
    ok: true,
    topic: toPanelTopic(document, record),
    workItems,
    reviewRequests,
    activity,
  }
  return jsonResponse(200, response)
}

/**
 * Reject a request that does not come from this machine and this origin.
 *
 * The host `connection` channel already authenticates the browser, but the
 * plugin repeats the loopback check on the `Host` header (DNS-rebinding guard)
 * and requires a present `Origin` to equal the request authority. A missing
 * Origin is allowed: server-side callers do not send one.
 */
function assertSameOrigin(request: Request): void {
  const host = request.headers.get('host')
  if (!isLoopbackHost(host ?? undefined)) {
    throw new PanelApiError(
      'request/origin',
      `request host ${host === null ? '(missing)' : host} is not a loopback authority`,
    )
  }
  const origin = request.headers.get('origin')
  if (origin === null || origin.trim() === '') return
  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    throw new PanelApiError('request/origin', `origin is not a valid URL: ${origin}`)
  }
  if (originHost !== host) {
    throw new PanelApiError('request/origin', `origin ${origin} does not match request host ${host}`)
  }
}

/** Require `content-type: application/json` (parameters such as charset are fine). */
function assertJsonContentType(request: Request): void {
  const header = request.headers.get('content-type')
  if (header === null) {
    throw new PanelApiError('request/content-type', 'content-type must be application/json')
  }
  const media = header.split(';', 1)[0].trim().toLowerCase()
  if (media !== 'application/json') {
    throw new PanelApiError('request/content-type', `content-type must be application/json, got ${header}`)
  }
}

/**
 * Read one bounded JSON object body. The order is the wire contract's: the
 * media type, the size, then the JSON shape, each with its own stable code.
 */
async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  assertJsonContentType(request)
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) {
    throw new PanelApiError(
      'request/body-too-large',
      `request body must not exceed ${MAX_REQUEST_BODY_BYTES} bytes`,
    )
  }
  const buffer = await request.arrayBuffer()
  if (buffer.byteLength > MAX_REQUEST_BODY_BYTES) {
    throw new PanelApiError(
      'request/body-too-large',
      `request body is ${buffer.byteLength} bytes; the limit is ${MAX_REQUEST_BODY_BYTES}`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(buffer))
  } catch {
    throw new PanelApiError('request/invalid-body', 'request body is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PanelApiError('request/invalid-body', 'request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/** One required non-blank string field of a write body. */
function requireBodyString(body: Record<string, unknown>, name: string, code: PanelErrorCode): string {
  const value = body[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PanelApiError(code, `body field ${name} is required`)
  }
  return value.trim()
}

/** The project store of a write, already proven to belong to the master. */
interface OpenedWrite {
  readonly store: CoworkStorePort
  readonly repoPath: string
  readonly now: Date
}

/**
 * Open the project for a write and refuse a caller that is not its master
 * before anything is mutated. The same check runs again inside the lock, so a
 * concurrent master rebind cannot slip a write through.
 */
async function openWrite(ports: CoworkApiPorts, sessionId: string): Promise<OpenedWrite> {
  const { store, repoPath } = await openProject(ports, sessionId)
  const now = ports.now?.() ?? new Date()
  const document = await store.readIndexDocument()
  assertMaster(document, sessionId)
  return { store, repoPath, now }
}

/** Refuse a write from a session that does not own the project. */
function assertMaster(document: ProjectIndexV2, sessionId: string): void {
  if (document.masterSessionId !== sessionId) {
    throw new PanelApiError(
      'request/not-master',
      `session ${sessionId} is not the master of this project`,
    )
  }
}

/**
 * Build and append one activity row after a committed write. The index is
 * already durable, so both a failed build and a failed append are a log line:
 * rolling the write back would claim a state the index does not hold.
 */
async function appendActivityLogged(
  store: CoworkStorePort,
  ports: CoworkApiPorts,
  build: () => ActivityEvent,
): Promise<void> {
  try {
    await store.appendActivity(build())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ports.log?.(`panel write: activity not recorded: ${message}`)
  }
}

/** The topic the response reports, or `internal` when the write lost it. */
function topicAfterWrite(document: ProjectIndexV2, topicId: string): PanelTopic {
  const record = document.topics.find((topic) => topic.topicId === topicId)
  if (record === undefined) {
    throw new PanelApiError('internal', `topic disappeared from the index: ${topicId}`)
  }
  return toPanelTopic(document, record)
}

/**
 * `POST resolve`: archive one topic by user decision. The archive core clears the
 * block and any pending authorization, records `topic-archived` (master-only
 * notice), and the host session is archived afterwards. An already archived
 * topic is idempotent: no write, no notice, no second archive.
 */
async function handleResolve(request: Request, ports: CoworkApiPorts): Promise<Response> {
  const body = await readJsonBody(request)
  const sessionId = requireBodyString(body, 'sessionId', 'request/session-required')
  const topicId = requireBodyString(body, 'topicId', 'request/topic-required')
  const { store, repoPath, now } = await openWrite(ports, sessionId)
  const outcome = await archiveTopic(store, topicId, {
    now,
    repoPath,
    by: 'user',
    // The shared archive core writes the ledger itself; the runtime only kicks
    // the dispatcher and offers the host port for voiding a pending notice.
    runtime: ports.kickNotices === undefined && ports.noticePort === undefined
      ? undefined
      : { port: ports.noticePort ?? noNoticePort, kick: ports.kickNotices ?? (() => {}) },
    assertAllowed: (document) => assertMaster(document, sessionId),
    log: (message) => ports.log?.(`panel resolve: ${message}`),
  })
  if (outcome.topic === null) {
    throw new PanelApiError('topic/not-found', `unknown topic: ${topicId}`)
  }
  if (outcome.changed) {
    // The index is already committed: a refused host archive is a log line, not
    // a failed request, and it must never roll the resolution back.
    try {
      await ports.archiveSession?.(topicId, { stopActivity: true })
    } catch (error) {
      ports.log?.(`panel resolve: host session ${topicId} was not archived: ${messageOf(error)}`)
    }
  }
  const response: ResolveResponse = {
    ok: true,
    topic: topicAfterWrite(await store.readIndexDocument(), topicId),
    alreadyResolved: !outcome.changed,
  }
  return jsonResponse(200, response)
}

/** `POST reopen`: return a resolved topic to `active` and restore its session. */
async function handleReopen(request: Request, ports: CoworkApiPorts): Promise<Response> {
  const body = await readJsonBody(request)
  const sessionId = requireBodyString(body, 'sessionId', 'request/session-required')
  const topicId = requireBodyString(body, 'topicId', 'request/topic-required')
  const { store, repoPath, now } = await openWrite(ports, sessionId)
  let resolvedBefore: TopicRecordV2 | null = null
  const document = await store.mutateIndexDocument((base) => {
    assertMaster(base, sessionId)
    const topic = base.topics.find((entry) => entry.topicId === topicId)
    if (topic === undefined) {
      throw new PanelApiError('topic/not-found', `unknown topic: ${topicId}`)
    }
    const reopened = reopenResolvedTopic(topic, now.getTime())
    // Idempotent: reopening a live topic writes nothing and restores nothing.
    if (reopened === null) return null
    resolvedBefore = topic
    return { ...base, topics: base.topics.map((entry) => (entry.topicId === topicId ? reopened : entry)) }
  })
  if (resolvedBefore !== null) {
    // The event keeps the resolution it replaced, so activity.jsonl stays auditable.
    const before: TopicRecordV2 = resolvedBefore
    await appendActivityLogged(store, ports, () => topicReopenedActivity(before, now))
    try {
      await ports.unarchiveSession?.(topicId)
    } catch (error) {
      ports.log?.(`panel reopen: host session ${topicId} was not restored: ${messageOf(error)}`)
    }
    ports.kickNotices?.(repoPath)
  }
  const response: ReopenResponse = { ok: true, topic: topicAfterWrite(document, topicId) }
  return jsonResponse(200, response)
}

/** A non-throwing message for one host failure. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The B-mode port stand-in for the archive core: the ledger is still written
 * through the store, and the dispatcher (when wired) is what drains it, so the
 * core never needs to append through this port.
 */
const noNoticePort: TopicNoticePort = {
  capabilities: () => ({ supported: false, actions: false, updates: false }),
  append: async () => {
    throw new Error('the host exposes no topic notice channel')
  },
  update: async () => {
    throw new Error('the host exposes no topic notice channel')
  },
}

/** One recorded authorization decision, as the activity stream remembers it. */
interface AuthorizationDecisionRecord {
  decision: 'allow' | 'deny'
  noticeId: string | null
}

/** Find the decision already recorded for a request, if any. */
async function recordedDecision(
  store: CoworkStorePort,
  topicId: string,
  requestId: string,
): Promise<AuthorizationDecisionRecord | null> {
  const { events } = await store.readActivity(ACTIVITY_MAX_EVENTS)
  for (const event of events) {
    if (event.type !== 'authorization-resolved' || event.topicId !== topicId) continue
    const details = event.details as Record<string, unknown>
    if (details.requestId !== requestId) continue
    if (details.decision !== 'allow' && details.decision !== 'deny') continue
    return {
      decision: details.decision,
      noticeId: typeof details.noticeId === 'string' ? details.noticeId : null,
    }
  }
  return null
}

/** Find the `authorization-requested` event id whose notice a decision updates. */
async function authorizationNoticeId(
  store: CoworkStorePort,
  topicId: string,
  requestId: string,
): Promise<string | null> {
  const { events } = await store.readActivity(ACTIVITY_MAX_EVENTS)
  for (const event of events) {
    if (event.type !== 'authorization-requested' || event.topicId !== topicId) continue
    const details = event.details as Record<string, unknown>
    if (details.requestId === requestId) return event.eventId
  }
  return null
}

/** The short prompt a decided topic session receives to continue its work. */
function authorizationPrompt(summary: string, decision: 'allow' | 'deny'): string {
  const verb = decision === 'allow' ? '允许' : '拒绝'
  return `授权请求已${verb}：${truncateSummary(summary)}。请继续。`
}

/**
 * `POST authorization.resolve`: record the user's decision on one pending
 * authorization. The master or the topic's own session may decide; the
 * `requestId` is idempotent (the same decision replays, a different one is a
 * conflict). The original notice is patched, not duplicated, and only the topic
 * session is prompted — the master gets no extra message.
 */
async function handleAuthorizationResolve(request: Request, ports: CoworkApiPorts): Promise<Response> {
  const body = await readJsonBody(request)
  const sessionId = requireBodyString(body, 'sessionId', 'request/session-required')
  const topicId = requireBodyString(body, 'topicId', 'request/topic-required')
  const requestId = requireBodyString(body, 'requestId', 'request/invalid-body')
  const decision = body.decision
  if (decision !== 'allow' && decision !== 'deny') {
    throw new PanelApiError('request/invalid-body', "decision must be 'allow' or 'deny'")
  }
  const { store, repoPath } = await openProject(ports, sessionId)
  const now = ports.now?.() ?? new Date()
  const before = await store.readIndexDocument()
  const topic = before.topics.find((entry) => entry.topicId === topicId)
  if (topic === undefined) {
    throw new PanelApiError('topic/not-found', `unknown topic: ${topicId}`)
  }
  // Permission: the master may decide any topic; a topic session only its own.
  if (sessionId !== before.masterSessionId && sessionId !== topicId) {
    throw new PanelApiError(
      'authorization/not-allowed',
      `session ${sessionId} may not decide an authorization of topic ${topicId}`,
    )
  }
  const pending = topic.authorization ?? null
  if (pending === null) {
    const recorded = await recordedDecision(store, topicId, requestId)
    if (recorded === null) {
      throw new PanelApiError('authorization/not-found', `no pending authorization ${requestId} on ${topicId}`)
    }
    if (recorded.decision !== decision) {
      throw new PanelApiError(
        'authorization/mismatch',
        `authorization ${requestId} was already ${recorded.decision}; refusing ${decision}`,
      )
    }
    const response: AuthorizationResolveResponse = {
      ok: true,
      topic: toPanelTopic(before, topic),
      requestId,
      decision,
      noticeId: recorded.noticeId,
      prompted: false,
      changed: false,
    }
    return jsonResponse(200, response)
  }
  if (pending.requestId !== requestId) {
    throw new PanelApiError(
      'authorization/mismatch',
      `pending authorization is ${pending.requestId}, not ${requestId}`,
    )
  }
  const noticeId = await authorizationNoticeId(store, topicId, requestId)
  const summary = pending.summary
  let changed = false
  const document = await store.mutateIndexDocument((base) => {
    if (base.masterSessionId !== sessionId && sessionId !== topicId) {
      throw new PanelApiError('authorization/not-allowed', `session ${sessionId} may not decide ${topicId}`)
    }
    const current = base.topics.find((entry) => entry.topicId === topicId)
    if (current === undefined || current.authorization === null) return null
    if (current.authorization.requestId !== requestId) {
      throw new PanelApiError('authorization/mismatch', `pending authorization is ${current.authorization.requestId}`)
    }
    changed = true
    const released = unblockTopic(current, now.getTime())
    const next: TopicRecordV2 = { ...released, lastActiveAt: now.toISOString() }
    return { ...base, topics: base.topics.map((entry) => (entry.topicId === topicId ? next : entry)) }
  })
  if (!changed) {
    // The lock re-read found no pending authorization: another decision or an
    // archive won the race after the pre-check. Answer from the recorded
    // decision instead of reporting a no-op, so a duplicate click is idempotent
    // and a conflicting one is still refused.
    const recorded = await recordedDecision(store, topicId, requestId)
    if (recorded === null) {
      throw new PanelApiError(
        'authorization/not-found',
        `no pending authorization ${requestId} on ${topicId}`,
      )
    }
    if (recorded.decision !== decision) {
      throw new PanelApiError(
        'authorization/mismatch',
        `authorization ${requestId} was already ${recorded.decision}; refusing ${decision}`,
      )
    }
    const settled = document.topics.find((entry) => entry.topicId === topicId)
    if (settled === undefined) {
      throw new PanelApiError('internal', `topic disappeared from the index: ${topicId}`)
    }
    const replay: AuthorizationResolveResponse = {
      ok: true,
      topic: toPanelTopic(document, settled),
      requestId,
      decision,
      noticeId: recorded.noticeId,
      prompted: false,
      changed: false,
    }
    return jsonResponse(200, replay)
  }
  let prompted = false
  if (changed) {
    await appendActivityLogged(store, ports, () => authorizationResolvedActivity(
      topic,
      { requestId, noticeId: noticeId ?? '', decision, summary },
      now,
    ))
    let update: NoticeUpdateOutcome = 'unsupported'
    if (noticeId !== null && ports.noticePort !== undefined) {
      update = await updateAuthorizationNotice({
        port: ports.noticePort,
        document,
        topicId,
        noticeId,
        decision,
        now,
      })
      if (update === 'failed') ports.log?.(`panel authorization: notice ${noticeId} was not updated`)
    }
    // The topic continues on its own; the master already knows from the event.
    if (ports.promptSession !== undefined && sessionId !== topicId) {
      try {
        const result = await ports.promptSession(topicId, authorizationPrompt(summary, decision))
        prompted = result.accepted
      } catch (error) {
        ports.log?.(`panel authorization: topic ${topicId} was not prompted: ${messageOf(error)}`)
      }
    }
    ports.kickNotices?.(repoPath)
  }
  const current = document.topics.find((entry) => entry.topicId === topicId)
  if (current === undefined) {
    throw new PanelApiError('internal', `topic disappeared from the index: ${topicId}`)
  }
  const response: AuthorizationResolveResponse = {
    ok: true,
    topic: toPanelTopic(document, current),
    requestId,
    decision,
    noticeId,
    prompted,
    changed,
  }
  return jsonResponse(200, response)
}

/** `POST route.move`: append one intent's tokens to the target topic's aliases. */
async function handleRouteMove(request: Request, ports: CoworkApiPorts): Promise<Response> {
  const body = await readJsonBody(request)
  const sessionId = requireBodyString(body, 'sessionId', 'request/session-required')
  const fromTopicId = requireBodyString(body, 'fromTopicId', 'request/topic-required')
  const toTopicId = requireBodyString(body, 'toTopicId', 'request/topic-required')
  if (fromTopicId === toTopicId) {
    throw new PanelApiError('route/move-invalid', 'fromTopicId and toTopicId must differ')
  }
  const intent = typeof body.intent === 'string' ? body.intent.trim() : ''
  if (intent === '') {
    throw new PanelApiError('route/move-invalid', 'intent must be a non-empty string')
  }
  if (Array.from(intent).length > ROUTE_MOVE_INTENT_MAX_CHARS) {
    throw new PanelApiError(
      'route/move-invalid',
      `intent must be at most ${ROUTE_MOVE_INTENT_MAX_CHARS} characters`,
    )
  }
  const { store, now } = await openWrite(ports, sessionId)
  let changed = false
  let added: string[] = []
  let aliases: string[] = []
  const document = await store.mutateIndexDocument((base) => {
    assertMaster(base, sessionId)
    const source = base.topics.find((entry) => entry.topicId === fromTopicId)
    if (source === undefined) {
      throw new PanelApiError('topic/not-found', `unknown topic: ${fromTopicId}`)
    }
    const target = base.topics.find((entry) => entry.topicId === toTopicId)
    if (target === undefined) {
      throw new PanelApiError('topic/not-found', `unknown topic: ${toTopicId}`)
    }
    if (target.status === 'resolved') {
      throw new PanelApiError('route/move-invalid', `target topic is resolved: ${toTopicId}`)
    }
    const corrected = applyRouteCorrection(target, intent)
    aliases = [...corrected.aliases]
    if (corrected === target) {
      changed = false
      added = []
      return null
    }
    changed = true
    added = corrected.aliases.slice(target.aliases.length)
    return { ...base, topics: base.topics.map((entry) => (entry.topicId === toTopicId ? corrected : entry)) }
  })
  if (changed) {
    await appendActivityLogged(store, ports, () => buildActivityEvent({
      type: 'route-corrected',
      topicId: toTopicId,
      summary: `corrected route to topic ${toTopicId}`,
      details: {
        topicId: toTopicId,
        added: added.slice(0, ROUTE_CORRECTION_DETAILS_MAX_TOKENS),
        aliasCount: aliases.length,
      },
    }, now))
  }
  const response: RouteMoveResponse = {
    ok: true,
    topic: topicAfterWrite(document, toTopicId),
    changed,
    added,
    aliases,
  }
  return jsonResponse(200, response)
}

/** One handler plus the guards every panel route shares. */
function serve(
  ports: CoworkApiPorts,
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      // The same-origin fence runs before any host or store work, so a
      // cross-origin request learns nothing about the project.
      assertSameOrigin(request)
      return await handler(request)
    } catch (error) {
      const { status, body } = toErrorResponse(error)
      return jsonResponse(status, body)
    }
  }
}

/**
 * Register the seven panel routes on the host connection service.
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
      fetch: serve(ports, (request) => handleOverview(request, ports)),
    },
    {
      path: ACTIVITY_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: serve(ports, (request) => handleActivity(request, ports)),
    },
    {
      path: TOPIC_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: serve(ports, (request) => handleTopic(request, ports)),
    },
    {
      path: RESOLVE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: serve(ports, (request) => handleResolve(request, ports)),
    },
    {
      path: REOPEN_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: serve(ports, (request) => handleReopen(request, ports)),
    },
    {
      path: ROUTE_MOVE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: serve(ports, (request) => handleRouteMove(request, ports)),
    },
    {
      path: AUTHORIZATION_RESOLVE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: serve(ports, (request) => handleAuthorizationResolve(request, ports)),
    },
  ]
  for (const route of routes) {
    host.effect(() => connection.fetch.register(route), `dsh-cowork: panel route ${route.path}`)
  }
}
