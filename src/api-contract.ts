/**
 * Wire contract for the Cowork panel API v2 (`/api/cowork.*`).
 *
 * The host serves these shapes and the browser bundle consumes them, so this
 * module stays browser-safe: no node builtins, and its only import is the pure
 * inbox vocabulary (`src/inbox-contract.ts`), which owns the inbox error codes
 * and their HTTP statuses. The status unions are restated here as the wire
 * schema; `tests/api-contract.test.mjs` pins them to the canonical lists in
 * `src/store-schema.ts`, and the host maps index records into these shapes.
 *
 * Every collection is bounded by the constants below, because the panel fetches
 * whole responses and a hand-edited index must not be able to ship the browser
 * an unbounded payload.
 */
import { INBOX_ERROR_STATUS } from './inbox-contract.js'
import type { InboxErrorCode } from './inbox-contract.js'

/** Exact Fetch-route path below the connection `/api` channel: project overview. */
export const OVERVIEW_PATH = '/api/cowork.overview'

/** Exact Fetch-route path below the connection `/api` channel: activity tail. */
export const ACTIVITY_PATH = '/api/cowork.activity'

/** Exact Fetch-route path below the connection `/api` channel: one topic's detail. */
export const TOPIC_PATH = '/api/cowork.topic'

/** Write route: mark one topic resolved (master only, idempotent). */
export const RESOLVE_PATH = '/api/cowork.topic.resolve'

/** Write route: reopen one resolved topic (master only). */
export const REOPEN_PATH = '/api/cowork.topic.reopen'

/** Write route: decide one pending authorization (master or that topic's session). */
export const AUTHORIZATION_RESOLVE_PATH = '/api/cowork.authorization.resolve'

/** Write route: move work routed to one topic into another (master only). */
export const ROUTE_MOVE_PATH = '/api/cowork.route.move'

/** Most topics one overview response may carry. */
export const MAX_PANEL_TOPICS = 500

/** Activity rows returned when the request names no `limit`. */
export const ACTIVITY_DEFAULT_LIMIT = 50

/** Largest `limit` the activity route accepts. */
export const ACTIVITY_MAX_LIMIT = 200

/** Activity rows the topic detail carries. */
export const TOPIC_ACTIVITY_LIMIT = 50

/** Work items one topic detail may carry. */
export const MAX_TOPIC_WORK_ITEMS = 50

/** Review requests one topic detail may carry (newest first). */
export const MAX_TOPIC_REVIEW_REQUESTS = 10

/** Findings one review request may carry. */
export const MAX_REVIEW_FINDINGS = 20

/** Verification rows one review request may carry. */
export const MAX_REVIEW_VERIFICATION = 10

/** Changed paths one review request may carry. */
export const MAX_REVIEW_CHANGED_PATHS = 50

/** Owned paths one topic may carry. */
export const MAX_TOPIC_OWNED_PATHS = 50

/** Cap on every human-readable summary/digest the wire carries. */
export const MAX_SUMMARY_CHARS = 200

/** Most inbox items one overview response may carry. */
export const MAX_INBOX_ITEMS = 20

/** Largest request body a write route accepts (8 KiB). */
export const MAX_REQUEST_BODY_BYTES = 8192

/** Lifecycle of one topic as the panel lists it. `resolved` rows stay listed. */
export type PanelTopicStatus = 'active' | 'idle' | 'resolved'

/** Why a topic is blocked on the topic page, or null when it is not. */
export type PanelBlockedReason = 'authorization' | 'handoff' | 'conflict'

/** Every blocked reason, in the contract's order. */
export const PANEL_BLOCKED_REASONS: readonly PanelBlockedReason[] = [
  'authorization', 'handoff', 'conflict',
]

/** Lifecycle of one isolated work item. */
export type PanelWorkItemStatus = 'active' | 'reviewing' | 'merged' | 'abandoned'

/** Review lifecycle of a topic or a review request; `pending` is a request state. */
export type PanelReviewStatus = 'pending' | 'pass' | 'needs_revision' | 'reject'

/** A verdict is what a review records; `pending` is state, never a verdict. */
export type PanelReviewVerdict = Exclude<PanelReviewStatus, 'pending'>

/** Finding severity, most serious first. */
export type PanelReviewSeverity = 'blocker' | 'high' | 'medium' | 'low'

/** Topic lifecycle in list priority order: active first, resolved still listed. */
export const PANEL_TOPIC_STATUS_ORDER: readonly PanelTopicStatus[] = ['active', 'idle', 'resolved']

/** The four work-item states. */
export const PANEL_WORK_ITEM_STATUSES: readonly PanelWorkItemStatus[] = [
  'active', 'reviewing', 'merged', 'abandoned',
]

/** The four review states (they never enter the list sort). */
export const PANEL_REVIEW_STATUSES: readonly PanelReviewStatus[] = [
  'pending', 'pass', 'needs_revision', 'reject',
]

/** The three verdicts a review may carry. */
export const PANEL_REVIEW_VERDICTS: readonly PanelReviewVerdict[] = ['pass', 'needs_revision', 'reject']

/** The four finding severities. */
export const PANEL_REVIEW_SEVERITIES: readonly PanelReviewSeverity[] = ['blocker', 'high', 'medium', 'low']

/** Project identity the panel header shows. */
export interface PanelProject {
  readonly repoPath: string
  readonly projectId: string
  readonly masterSessionId: string
  readonly createdAt: string
}

/** One topic as the panel lists and selects it. */
export interface PanelTopic {
  readonly topicId: string
  readonly title: string
  readonly status: PanelTopicStatus
  /** The topic is blocked (derived: `blockedReason !== null`). */
  readonly blocked: boolean
  /**
   * Why the topic is blocked, or null. The topic page groups on this, not on
   * `awaitingReview`. Optional only at the type level so a client built against
   * an older host keeps compiling; the host always writes it on the wire.
   */
  readonly blockedReason?: PanelBlockedReason | null
  /**
   * A pending authorization request exists; the top "needs you" count uses
   * this. Optional at the type level for the same forward-compat reason; the
   * host always writes it.
   */
  readonly awaitingAuthorization?: boolean
  /** A review was requested and has no verdict yet; the topic page does not read it. */
  readonly awaitingReview: boolean
  /** Review state of the newest review request, or null when never requested. */
  readonly reviewStatus: PanelReviewStatus | null
  /** Newest review request, or null when never requested. */
  readonly latestReviewRequestId: string | null
  /** One-line digest of the topic's latest activity, already truncated. */
  readonly digest: string
  readonly scope: string
  readonly ownedPaths: readonly string[]
  readonly lastActiveAt: string
  readonly updatedAt: string
  readonly lastDeliveryConfirmedAt: string | null
  readonly resolvedAt: string | null
  /** Who resolved the topic; null while it is not resolved. */
  readonly resolvedBy: 'user' | 'master' | null
  /** Open work items of this topic, counted by the host at read time. */
  readonly activeWorkItems: number
}

/** One isolated work item of a topic. */
export interface PanelWorkItem {
  readonly workItemId: string
  readonly topicId: string
  readonly path: string
  readonly branch: string
  readonly baseCommit: string | null
  readonly headCommit: string | null
  readonly status: PanelWorkItemStatus
  readonly updatedAt: string
}

/** One finding of a review; `file`/`line` locate it when the reviewer named them. */
export interface PanelReviewFinding {
  readonly id: string
  readonly severity: PanelReviewSeverity
  readonly problem: string
  readonly requiredFix: string
  readonly file?: string
  readonly line?: number
}

/** One verification row the reviewer actually ran. */
export interface PanelReviewVerification {
  readonly command: string
  readonly exitCode: number
  readonly evidence: string
}

/**
 * One review request as the panel shows it. The reviewer session and any
 * handoff text are deliberately absent: the panel shows review facts, not the
 * process that produced them.
 */
export interface PanelReviewRequest {
  readonly requestId: string
  readonly topicId: string
  readonly workItemId: string | null
  readonly purpose: string
  readonly status: PanelReviewStatus
  readonly baseCommit: string
  readonly headCommit: string
  readonly changedPaths: readonly string[]
  readonly requestedAt: string
  readonly reviewedAt: string | null
  readonly summary: string | null
  readonly findings: readonly PanelReviewFinding[]
  readonly verification: readonly PanelReviewVerification[]
}

/** One row of the project activity stream. */
export interface PanelActivityEvent {
  readonly eventId: string
  readonly time: string
  readonly type: string
  readonly topicId: string | null
  readonly summary: string
}

/** One master-inbox item. */
export interface PanelInboxItem {
  readonly id: string
  readonly time: string
  readonly topicId: string
  readonly kind: string
  readonly summary: string
  readonly deliveredAt: string | null
}

/** The header chips: topic states, the two markers, and work-item states. */
export interface PanelCounts {
  readonly active: number
  readonly idle: number
  readonly resolved: number
  readonly blocked: number
  /** Pending authorizations; always on the wire, optional for older clients. */
  readonly awaitingAuthorization?: number
  readonly awaitingReview: number
  readonly pendingReview: number
  readonly workItemActive: number
  readonly workItemReviewing: number
  readonly workItemMerged: number
  readonly workItemAbandoned: number
}

/** Body of a successful {@link OVERVIEW_PATH} response. */
export interface OverviewResponse {
  readonly ok: true
  readonly project: PanelProject
  readonly counts: PanelCounts
  readonly topics: readonly PanelTopic[]
  readonly inbox: readonly PanelInboxItem[]
}

/** Body of a successful {@link ACTIVITY_PATH} response. */
export interface ActivityResponse {
  readonly ok: true
  readonly events: readonly PanelActivityEvent[]
  /** Rows dropped while reading `activity.jsonl`, so the panel can say it is partial. */
  readonly skippedLines: number
}

/** Body of a successful {@link TOPIC_PATH} response. */
export interface TopicResponse {
  readonly ok: true
  readonly topic: PanelTopic
  readonly workItems: readonly PanelWorkItem[]
  readonly reviewRequests: readonly PanelReviewRequest[]
  readonly activity: readonly PanelActivityEvent[]
}

/** Body of a successful {@link RESOLVE_PATH} response. */
export interface ResolveResponse {
  readonly ok: true
  readonly topic: PanelTopic
  /** True when the topic was already resolved and nothing was written. */
  readonly alreadyResolved: boolean
}

/** Body of a successful {@link REOPEN_PATH} response. */
export interface ReopenResponse {
  readonly ok: true
  readonly topic: PanelTopic
}

/** Body of a successful {@link AUTHORIZATION_RESOLVE_PATH} response. */
export interface AuthorizationResolveResponse {
  readonly ok: true
  readonly topic: PanelTopic
  readonly requestId: string
  readonly decision: 'allow' | 'deny'
  /** The `authorization-requested` event id whose notice was updated, or null. */
  readonly noticeId: string | null
  /** True when the topic session was prompted to continue after the decision. */
  readonly prompted: boolean
  /** False when the same decision was already recorded (idempotent replay). */
  readonly changed: boolean
}

/** Body of a successful {@link ROUTE_MOVE_PATH} response. */
export interface RouteMoveResponse {
  readonly ok: true
  readonly topic: PanelTopic
  /** False when the intent already routed to the target topic. */
  readonly changed: boolean
  /** Aliases the move appended to the target topic. */
  readonly added: readonly string[]
  /** Every alias the target topic now carries. */
  readonly aliases: readonly string[]
}

/** Stable error codes the panel maps to its own states. */
export type PanelErrorCode =
  | 'request/session-required'
  | 'request/topic-required'
  | 'request/invalid-query'
  | 'request/invalid-body'
  | 'request/body-too-large'
  | 'request/content-type'
  | 'request/origin'
  | 'request/not-master'
  | 'topic/not-found'
  | 'topic/not-resolved'
  | 'authorization/not-found'
  | 'authorization/mismatch'
  | 'authorization/not-allowed'
  | 'route/move-invalid'
  | 'session/unknown'
  | 'session/cwd-unavailable'
  /**
   * The host session listing did not answer within the panel's bound. This one
   * is transient: the listing is a metadata read, so a retry can succeed once
   * the host finishes loading its session list.
   */
  | 'session/list-timeout'
  | 'project/not-initialized'
  | 'store/corrupt'
  | InboxErrorCode
  | 'internal'

/**
 * HTTP status per stable error code. It lives in the contract module (not in
 * `src/api.ts`) because the write surface outgrew the 50 KiB read cap: the
 * host's `panelErrorStatus` re-exports this one table, and
 * `tests/api-read.test.mjs` pins every status here.
 *
 * Typed as a complete `Record`, so adding a code to {@link PanelErrorCode}
 * without deciding its status is a compile error.
 */
export const PANEL_ERROR_STATUS: Readonly<Record<PanelErrorCode, number>> = {
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
  ...INBOX_ERROR_STATUS,
  internal: 500,
}

/** HTTP status for a stable error code. */
export function panelErrorStatus(code: PanelErrorCode): number {
  return PANEL_ERROR_STATUS[code]
}

/** Error body shared by every route. */
export interface PanelErrorBody {
  readonly ok: false
  readonly error: {
    readonly code: PanelErrorCode
    readonly message: string
    /** Offending file, query value or topic, when the code names one. */
    readonly path?: string
  }
}

/** Whether a parsed body is the shared error envelope. */
export function isPanelError(value: unknown): value is PanelErrorBody {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.ok !== false) return false
  const error = record.error
  return typeof error === 'object' && error !== null
    && typeof (error as Record<string, unknown>).code === 'string'
}

/** Whether a value is one of the three topic states. */
export function isPanelTopicStatus(value: unknown): value is PanelTopicStatus {
  return typeof value === 'string' && (PANEL_TOPIC_STATUS_ORDER as readonly string[]).includes(value)
}

/** Whether a value is one of the three blocked reasons. */
export function isPanelBlockedReason(value: unknown): value is PanelBlockedReason {
  return typeof value === 'string' && (PANEL_BLOCKED_REASONS as readonly string[]).includes(value)
}

/** Whether a value is one of the four work-item states. */
export function isPanelWorkItemStatus(value: unknown): value is PanelWorkItemStatus {
  return typeof value === 'string' && (PANEL_WORK_ITEM_STATUSES as readonly string[]).includes(value)
}

/** Whether a value is one of the four review states. */
export function isPanelReviewStatus(value: unknown): value is PanelReviewStatus {
  return typeof value === 'string' && (PANEL_REVIEW_STATUSES as readonly string[]).includes(value)
}

/** Whether a value is one of the three recorded verdicts. */
export function isPanelReviewVerdict(value: unknown): value is PanelReviewVerdict {
  return typeof value === 'string' && (PANEL_REVIEW_VERDICTS as readonly string[]).includes(value)
}

/** Whether a value is one of the four finding severities. */
export function isPanelReviewSeverity(value: unknown): value is PanelReviewSeverity {
  return typeof value === 'string' && (PANEL_REVIEW_SEVERITIES as readonly string[]).includes(value)
}

/** A copy of {@link PanelCounts} whose fields can be incremented while counting. */
type MutablePanelCounts = { -readonly [Key in keyof PanelCounts]-?: NonNullable<PanelCounts[Key]> }

/**
 * List rank of one topic: the two markers the topic page shows outrank every
 * status. `awaitingReview` is deliberately absent — the topic page does not use
 * review state, so a review no longer pushes a row to the top.
 */
function topicListRank(topic: {
  readonly blocked: boolean
  readonly awaitingAuthorization?: boolean
  readonly status: PanelTopicStatus
}): number {
  if (topic.blocked) return 0
  if (topic.awaitingAuthorization) return 1
  switch (topic.status) {
    case 'active': return 2
    case 'idle': return 3
    case 'resolved': return 4
    // A hand-edited index can carry an invented state; it sorts last, never throws.
    default: return 5
  }
}

/** Milliseconds of an ISO timestamp, or `-Infinity` when it does not parse. */
function timeValue(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

/** Descending comparison that is total for the values {@link timeValue} returns. */
function compareDescending(left: number, right: number): number {
  if (left === right) return 0
  return left > right ? -1 : 1
}

/**
 * Panel order: `blocked` first, then `awaitingAuthorization`, then the topic states in
 * {@link PANEL_TOPIC_STATUS_ORDER}; inside one rank the most recently active
 * topic leads, then the most recently updated, then the input order. Unknown
 * states sort last and unparseable timestamps never throw. The input array is
 * not mutated.
 */
export function sortTopicsForPanel<
  T extends {
    readonly blocked: boolean
    readonly awaitingAuthorization?: boolean
    readonly status: PanelTopicStatus
    readonly lastActiveAt: string
    readonly updatedAt: string
  },
>(topics: readonly T[]): T[] {
  return topics
    .map((topic, index) => ({ topic, index }))
    .sort((left, right) => {
      const byRank = topicListRank(left.topic) - topicListRank(right.topic)
      if (byRank !== 0) return byRank
      const byActive = compareDescending(timeValue(left.topic.lastActiveAt), timeValue(right.topic.lastActiveAt))
      if (byActive !== 0) return byActive
      const byUpdated = compareDescending(timeValue(left.topic.updatedAt), timeValue(right.topic.updatedAt))
      if (byUpdated !== 0) return byUpdated
      return left.index - right.index
    })
    .map(({ topic }) => topic)
}

/**
 * Zero-filled header counts. Topic counts come from `topics` alone; work-item
 * counts only include items whose `topicId` is one of `topics`, so a stray
 * record cannot inflate the chips. Unknown states are ignored, not guessed.
 */
export function countPanel(
  topics: readonly PanelTopic[],
  workItems: readonly PanelWorkItem[],
): PanelCounts {
  const counts: MutablePanelCounts = {
    active: 0,
    idle: 0,
    resolved: 0,
    blocked: 0,
    awaitingAuthorization: 0,
    awaitingReview: 0,
    pendingReview: 0,
    workItemActive: 0,
    workItemReviewing: 0,
    workItemMerged: 0,
    workItemAbandoned: 0,
  }
  const listed = new Set<string>()
  for (const topic of topics) {
    listed.add(topic.topicId)
    if (isPanelTopicStatus(topic.status)) counts[topic.status] += 1
    if (topic.blocked) counts.blocked += 1
    if (topic.awaitingAuthorization) counts.awaitingAuthorization += 1
    if (topic.awaitingReview) counts.awaitingReview += 1
    if (topic.reviewStatus === 'pending') counts.pendingReview += 1
  }
  for (const item of workItems) {
    if (!listed.has(item.topicId)) continue
    switch (item.status) {
      case 'active': counts.workItemActive += 1; break
      case 'reviewing': counts.workItemReviewing += 1; break
      case 'merged': counts.workItemMerged += 1; break
      case 'abandoned': counts.workItemAbandoned += 1; break
      default: break
    }
  }
  return counts
}

/** The topic the panel selects on first paint: the first row, or null when empty. */
export function defaultSelectedTopicId(topics: readonly { readonly topicId: string }[]): string | null {
  return topics.length === 0 ? null : topics[0].topicId
}

/**
 * One-line, bounded summary text. Every whitespace run becomes one space and
 * the ends are trimmed; the result is measured in Unicode code points (not
 * UTF-16 units), and an over-long text keeps `limit - 1` code points plus `…`,
 * so the result never exceeds `limit` code points. Non-strings become `''`:
 * the caller passes untrusted JSON, and a summary is never worth a throw.
 */
export function truncateSummary(text: unknown, limit: number = MAX_SUMMARY_CHARS): string {
  if (typeof text !== 'string') return ''
  const single = text.replace(/\s+/g, ' ').trim()
  const max = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : MAX_SUMMARY_CHARS
  if (max === 0) return ''
  const points = Array.from(single)
  if (points.length <= max) return single
  return `${points.slice(0, max - 1).join('')}…`
}
