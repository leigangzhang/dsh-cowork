/**
 * Index v2 schema: the types `.dsh-cowork/index.json` carries after M7 and the
 * pure validation this plugin applies before it trusts a document.
 *
 * Two vocabularies live here on purpose. v2 (`TopicRecordV2`, `WorkItemRecordV2`)
 * is what the store writes; the v1 shapes (`ThreadRecordV1`, `ProjectIndexV1`)
 * stay because `src/app/tools.ts`, `src/panel/api.ts`, `src/domains/topic/handoff.ts` and
 * `src/tools/review.ts` are still v1-shaped and cannot change in M7. The v1
 * normalizer reproduces `src/store/project-store.ts`'s `normalizeThreadDocument` behaviour
 * (pre-M2 `worktreePath` adoption, M3 review fields defaulted to null) so a
 * document read through this module and one read through the old store agree.
 *
 * Nothing here touches the file system: I/O and locking stay in `src/store/project-store.ts`.
 */

/** On-disk index version this module describes: topics + work items. */
export const INDEX_VERSION_V2 = 2
/** Legacy thread-centred index version this module still reads. */
export const INDEX_VERSION_V1 = 1
/** Most events `activity.jsonl` keeps before the oldest are dropped. */
export const ACTIVITY_MAX_EVENTS = 500
/** Largest serialized `activity.jsonl` (512 KiB) before the oldest rows go. */
export const ACTIVITY_MAX_BYTES = 524288
/** Most items `inbox.json` keeps. */
export const INBOX_MAX_ITEMS = 50
/** Most records the notice delivery ledger keeps (`notices.json` v1). */
export const NOTICE_LEDGER_MAX_RECORDS = 200

/** Lifecycle of one topic. */
export const TOPIC_STATUSES = ['active', 'idle', 'resolved'] as const
/** Lifecycle of one topic as recorded in the project index. */
export type TopicStatus = (typeof TOPIC_STATUSES)[number]

/**
 * Why a topic is blocked. The flag is derived (`blocked === blockedReason !== null`),
 * so the list is also the only legal source of that boolean.
 */
export const BLOCKED_REASONS = ['authorization', 'handoff', 'conflict'] as const
/** Why a topic is blocked. */
export type BlockedReason = (typeof BLOCKED_REASONS)[number]

/** The statuses a block can be released back to. */
export const BLOCKED_FROM_STATUSES = ['active', 'idle'] as const
/** The status a block restores when it is cleared. */
export type BlockedFromStatus = (typeof BLOCKED_FROM_STATUSES)[number]

/** Longest authorization summary the index accepts, in code points. */
export const AUTHORIZATION_SUMMARY_MAX_CHARS = 200

/** One pending authorization request of a topic. */
export interface TopicAuthorization {
  requestId: string
  summary: string
  requestedAt: string
}

/** Lifecycle of one isolated work item. */
export const WORK_ITEM_STATUSES = ['active', 'reviewing', 'merged', 'abandoned'] as const
/** Lifecycle of one isolated work item. */
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number]

/** The only reasons an event may enter the master inbox. */
export const INBOX_KINDS = ['merge-needed', 'blocked', 'review-reject', 'cross-topic-conflict'] as const
/** Why an inbox item is waiting for the master. */
export type InboxKind = (typeof INBOX_KINDS)[number]

/** Review states a topic or review request may carry. */
export const REVIEW_STATUSES = ['pending', 'pass', 'needs_revision', 'reject'] as const
/** Review state of a topic's newest review. */
export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

/** The verdicts a reviewer may return. `pending` is a request state, not a verdict. */
export const REVIEW_VERDICTS = ['pass', 'needs_revision', 'reject'] as const
/** One verdict a reviewer may return. */
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number]

/** Finding severities, most severe first. */
export const REVIEW_SEVERITIES = ['blocker', 'high', 'medium', 'low'] as const
/** Severity of one review finding. */
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number]

/**
 * Lifecycle of a v1 thread. Moved here from `src/review.ts` so the legacy review
 * model has one home that outlives that module (M10.3 deletes it).
 */
export type ReviewThreadStatus = 'new' | 'active' | 'awaiting_review' | 'done' | 'blocked' | 'archived'

/** One required fix a legacy review names. */
export interface ReviewFinding {
  id: string
  severity: ReviewSeverity
  problem: string
  requiredFix: string
  file?: string
  line?: number
}

/** One check a reviewer actually ran. */
export interface ReviewVerification {
  command: string
  exitCode: number
  evidence: string
}

/**
 * One legacy verdict-only review document
 * (`<repo>/.dsh-cowork/reviews/<threadId>-<stamp>.json`). M10 replaced this
 * model with the request file (`src/domains/review/review-request.ts`); old files stay
 * readable by `src/store/project-store.ts` and are never rewritten.
 */
export interface ReviewRecord {
  version: 1
  threadId: string
  reviewerSessionId: string
  verdict: ReviewVerdict
  summary: string
  findings: ReviewFinding[]
  verification: ReviewVerification[]
  createdAt: string
}

/**
 * Event types the activity stream records. PLAN-V0.2 §5.3/§5.4/§5.5/§5.6 name
 * the kinds of event; `route-corrected` is the one name the plan spells out.
 */
export const ACTIVITY_TYPES = [
  'topic-created',
  'route-reused',
  'route-created',
  'route-corrected',
  'status-changed',
  'topic-reopened',
  'review-requested',
  'review-verdict',
  'work-item-created',
  'work-item-merged',
  'topic-reported',
  'decision-proposed',
  'authorization-requested',
  'authorization-resolved',
  'topic-archived',
  'request-created',
  'request-resolved',
  'error',
] as const
/** One kind of activity event. */
export type ActivityType = (typeof ACTIVITY_TYPES)[number]

/** One topic of the v2 project index (PLAN-V0.2 §4.3). */
export interface TopicRecordV2 {
  topicId: string
  title: string
  status: TopicStatus
  awaitingReview: boolean
  /** Derived flag: `blocked !== null` — see {@link TopicRecordV2.blockedReason}. */
  blocked: boolean
  /** Why the topic is blocked; null means it is not blocked. */
  blockedReason: BlockedReason | null
  /** Status the block restores when it is released; null when not blocked. */
  blockedFromStatus: BlockedFromStatus | null
  /** When the topic was first blocked, for diagnostics and sorting. */
  blockedAt: string | null
  /** Pending authorization request; non-null implies `blockedReason === 'authorization'`. */
  authorization: TopicAuthorization | null
  scope: string
  ownedPaths: string[]
  aliases: string[]
  digest: string
  cwd: string
  legacyCheckoutPath: string | null
  createdAt: string
  updatedAt: string
  lastActiveAt: string
  lastDeliveryConfirmedAt: string | null
  resolvedAt: string | null
  resolvedBy: 'user' | 'master' | null
  latestReviewRequestId: string | null
  reviewStatus: ReviewStatus | null
  reviewerSessionId: string | null
}

/** One isolated work item of the v2 project index (PLAN-V0.2 §4.3). */
export interface WorkItemRecordV2 {
  workItemId: string
  topicId: string
  path: string
  branch: string
  baseCommit: string | null
  headCommit: string | null
  status: WorkItemStatus
  createdAt: string
  updatedAt: string
}

/** The v2 project index document (`<repo>/.dsh-cowork/index.json`). */
export interface ProjectIndexV2 {
  version: 2
  projectId: string
  masterSessionId: string
  createdAt: string
  /**
   * Topic the user has open in the panel (PLAN-V0.2 §5.3 layer 1). Optional on
   * disk: an older v2 document predates the field and reads as null.
   */
  masterFocusTopicId?: string | null
  /** Topic the previous route picked (PLAN-V0.2 §5.3 layer 1). */
  lastRouteTopicId?: string | null
  topics: TopicRecordV2[]
  workItems: WorkItemRecordV2[]
}

/** One line of `<repo>/.dsh-cowork/activity.jsonl`. */
export interface ActivityEvent {
  eventId: string
  time: string
  type: ActivityType
  /** Topic the event belongs to, or null for project-level events. */
  topicId: string | null
  summary: string
  /** Structured detail for the panel; never free-form log text. */
  details: Record<string, unknown>
}

/**
 * One read of the activity stream: valid events oldest first, and how many
 * lines were skipped because they were not valid events.
 */
export interface ReadActivityResult {
  events: ActivityEvent[]
  skippedLines: number
}

/** One item of `<repo>/.dsh-cowork/inbox.json`. */
export interface InboxItem {
  id: string
  time: string
  topicId: string
  kind: InboxKind
  summary: string
  deliveredAt: string | null
}

/** One thread of the legacy v1 index, as the unchanged v1 tools expect it. */
export interface ThreadRecordV1 {
  threadId: string
  subject: string
  status: 'new' | 'active' | 'awaiting_review' | 'done' | 'blocked' | 'archived'
  cwd: string
  checkoutPath: string | null
  createdAt: string
  updatedAt: string
  lastHandoffAt: string | null
  reviewStatus: ReviewStatus | null
  reviewRequestedAt: string | null
  reviewedAt: string | null
  reviewerSessionId: string | null
  latestReviewPath: string | null
}

/** The legacy thread-centred index document (`version: 1`). */
export interface ProjectIndexV1 {
  version: 1
  projectId: string
  masterSessionId: string
  createdAt: string
  threads: ThreadRecordV1[]
}

/** Every v1 thread status; the migration maps each one explicitly. */
export const LEGACY_THREAD_STATUSES = [
  'new',
  'active',
  'awaiting_review',
  'done',
  'blocked',
  'archived',
] as const
/** One legacy v1 thread status. */
export type ThreadStatusV1 = (typeof LEGACY_THREAD_STATUSES)[number]

/**
 * The two v1 states that have no v2 equivalent and therefore survive as a
 * tolerated marker on the topic (`legacyStatus`): `new` is an active topic that
 * never started, `archived` is a resolved topic that was archived rather than
 * finished. Deriving a status alone cannot recover either distinction.
 */
export const LEGACY_STATUS_MARKERS = ['new', 'archived'] as const
/** A preserved v1-only status. */
export type LegacyStatusMarker = (typeof LEGACY_STATUS_MARKERS)[number]

/** Whether a value is a JSON object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a value is a string with non-whitespace content. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** Whether a value is a string `Date.parse` accepts. */
function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

/** Whether a value is an array of strings. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** Whether a value is one of the allowed values. */
function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

/**
 * Read one v1 thread into the current v1 shape. Mirrors
 * `src/store/project-store.ts`'s `normalizeThreadDocument`: the pre-M2 `worktreePath` name is
 * adopted only when `checkoutPath` is absent and is never copied forward; the
 * M3 review fields are filled with null so a loaded record always has them.
 */
export function normalizeProjectIndexV1(index: unknown): unknown {
  if (!isRecord(index) || !Array.isArray(index.threads)) return index
  return { ...index, threads: index.threads.map(normalizeThreadV1) }
}

/** Read one v1 thread record into the current v1 shape. */
function normalizeThreadV1(thread: unknown): unknown {
  if (!isRecord(thread)) return thread
  const { worktreePath, checkoutPath, ...rest } = thread
  const adopted = checkoutPath === undefined ? worktreePath : checkoutPath
  const nullWhenAbsent = (value: unknown): unknown => (value === undefined ? null : value)
  return {
    ...rest,
    checkoutPath: adopted === undefined ? null : adopted,
    reviewStatus: nullWhenAbsent(rest.reviewStatus),
    reviewRequestedAt: nullWhenAbsent(rest.reviewRequestedAt),
    reviewedAt: nullWhenAbsent(rest.reviewedAt),
    reviewerSessionId: nullWhenAbsent(rest.reviewerSessionId),
    latestReviewPath: nullWhenAbsent(rest.latestReviewPath),
  }
}

/** Schema problems of a v1 project index document. */
export function projectIndexV1Problems(index: unknown): string[] {
  if (!isRecord(index)) return ['index must be a JSON object']
  const problems: string[] = []
  if (index.version !== INDEX_VERSION_V1) problems.push(`index.version must be ${INDEX_VERSION_V1}`)
  if (!isNonEmptyString(index.projectId)) problems.push('index.projectId must be a non-empty string')
  if (!isNonEmptyString(index.masterSessionId)) {
    problems.push('index.masterSessionId must be a non-empty string')
  }
  if (!isIsoDate(index.createdAt)) problems.push('index.createdAt must be an ISO 8601 timestamp')
  if (!Array.isArray(index.threads)) {
    problems.push('index.threads must be an array')
  } else {
    index.threads.forEach((thread, position) => {
      problems.push(...threadV1Problems(thread, `index.threads[${position}]`))
    })
  }
  return problems
}

/** Schema problems of one v1 thread record, addressed by `where`. */
export function threadV1Problems(thread: unknown, where: string): string[] {
  if (!isRecord(thread)) return [`${where} must be an object`]
  const problems: string[] = []
  if (!isNonEmptyString(thread.threadId)) problems.push(`${where}.threadId must be a non-empty string`)
  if (typeof thread.subject !== 'string') problems.push(`${where}.subject must be a string`)
  if (!isOneOf(thread.status, LEGACY_THREAD_STATUSES)) {
    problems.push(`${where}.status must be one of ${LEGACY_THREAD_STATUSES.join('|')}`)
  }
  if (!isNonEmptyString(thread.cwd)) problems.push(`${where}.cwd must be a non-empty string`)
  if (thread.checkoutPath !== null && typeof thread.checkoutPath !== 'string') {
    problems.push(`${where}.checkoutPath must be a string or null`)
  }
  if (!isIsoDate(thread.createdAt)) problems.push(`${where}.createdAt must be an ISO 8601 timestamp`)
  if (!isIsoDate(thread.updatedAt)) problems.push(`${where}.updatedAt must be an ISO 8601 timestamp`)
  if (thread.lastHandoffAt !== null && !isIsoDate(thread.lastHandoffAt)) {
    problems.push(`${where}.lastHandoffAt must be an ISO 8601 timestamp or null`)
  }
  if (
    thread.reviewStatus !== undefined &&
    thread.reviewStatus !== null &&
    !isOneOf(thread.reviewStatus, REVIEW_STATUSES)
  ) {
    problems.push(`${where}.reviewStatus must be one of ${REVIEW_STATUSES.join('|')} or null`)
  }
  for (const field of ['reviewRequestedAt', 'reviewedAt'] as const) {
    if (thread[field] !== undefined && thread[field] !== null && !isIsoDate(thread[field])) {
      problems.push(`${where}.${field} must be an ISO 8601 timestamp or null`)
    }
  }
  for (const field of ['reviewerSessionId', 'latestReviewPath'] as const) {
    if (thread[field] !== undefined && thread[field] !== null && !isNonEmptyString(thread[field])) {
      problems.push(`${where}.${field} must be a non-empty string or null`)
    }
  }
  return problems
}

/**
 * Read a v2 document into the shape every reader can rely on. v2 owns the topic
 * fields; the four review attachment fields (`lastHandoffAt`,
 * `reviewRequestedAt`, `reviewedAt`, `latestReviewPath`) are tolerated
 * leftovers of the v1 schema that the legacy view still exposes, so they are
 * defaulted to null here and never invented elsewhere. The routing targets
 * (`masterFocusTopicId`/`lastRouteTopicId`) are optional on disk — an older v2
 * document predates them — and default to null; an illegal value is passed
 * through unchanged so `projectIndexV2Problems` can fail closed. The
 * `legacyStatus` marker is left exactly as found: its absence is meaningful
 * (there is no v1 state to restore). Unknown fields survive untouched — a
 * document this version does not understand must not be rewritten just because
 * it was read.
 */
export function normalizeProjectIndexV2(index: unknown): unknown {
  if (!isRecord(index) || !Array.isArray(index.topics)) return index
  const nullWhenAbsent = (value: unknown): unknown => (value === undefined ? null : value)
  return {
    ...index,
    masterFocusTopicId: nullWhenAbsent(index.masterFocusTopicId),
    lastRouteTopicId: nullWhenAbsent(index.lastRouteTopicId),
    topics: index.topics.map(normalizeTopicV2),
  }
}

/**
 * Read one v2 topic, defaulting the tolerated legacy attachment fields and the
 * block/authorization state an older document predates.
 *
 * A document written before the block model only carries `blocked: true`; it is
 * normalised to the `handoff` reason (the only writer that could set the flag
 * back then) with the current status as the status to restore. `blocked` stays
 * the derived boolean, so a hand-edited inconsistency cannot survive a read:
 * a pending authorization implies `authorization`, and the flag always follows
 * `blockedReason`.
 */
function normalizeTopicV2(topic: unknown): unknown {
  if (!isRecord(topic)) return topic
  const nullWhenAbsent = (value: unknown): unknown => (value === undefined ? null : value)
  const blockedFlag = topic.blocked === true
  const authorization = nullWhenAbsent(topic.authorization)
  const declaredReason = nullWhenAbsent(topic.blockedReason)
  const reason: unknown = declaredReason ?? (
    authorization !== null ? 'authorization' : blockedFlag ? 'handoff' : null
  )
  const fromStatus = nullWhenAbsent(topic.blockedFromStatus) ?? (
    reason === null
      ? null
      : topic.status === 'idle' ? 'idle' : topic.status === 'active' ? 'active' : null
  )
  return {
    ...topic,
    lastHandoffAt: nullWhenAbsent(topic.lastHandoffAt),
    reviewRequestedAt: nullWhenAbsent(topic.reviewRequestedAt),
    reviewedAt: nullWhenAbsent(topic.reviewedAt),
    latestReviewPath: nullWhenAbsent(topic.latestReviewPath),
    // A non-boolean flag is passed through unchanged so validation fails closed
    // instead of a damaged document being silently healed into "not blocked".
    blocked: typeof topic.blocked === 'boolean' ? reason !== null : topic.blocked,
    blockedReason: reason,
    blockedFromStatus: fromStatus,
    blockedAt: nullWhenAbsent(topic.blockedAt),
    authorization,
  }
}

/** Schema problems of a v2 project index document. */
export function projectIndexV2Problems(index: unknown): string[] {
  if (!isRecord(index)) return ['index must be a JSON object']
  const problems: string[] = []
  if (index.version !== INDEX_VERSION_V2) problems.push(`index.version must be ${INDEX_VERSION_V2}`)
  if (!isNonEmptyString(index.projectId)) problems.push('index.projectId must be a non-empty string')
  if (!isNonEmptyString(index.masterSessionId)) {
    problems.push('index.masterSessionId must be a non-empty string')
  }
  if (!isIsoDate(index.createdAt)) problems.push('index.createdAt must be an ISO 8601 timestamp')
  // Absent is legal (older v2 documents predate the routing targets); a present
  // value must be null or a non-empty id. Anything else fails closed.
  for (const field of ['masterFocusTopicId', 'lastRouteTopicId'] as const) {
    const value = index[field]
    if (value !== undefined && value !== null && !isNonEmptyString(value)) {
      problems.push(`index.${field} must be a non-empty string or null`)
    }
  }
  if (!Array.isArray(index.topics)) {
    problems.push('index.topics must be an array')
  } else {
    index.topics.forEach((topic, position) => {
      problems.push(...topicV2Problems(topic, `index.topics[${position}]`))
    })
  }
  if (!Array.isArray(index.workItems)) {
    problems.push('index.workItems must be an array')
  } else {
    index.workItems.forEach((workItem, position) => {
      problems.push(...workItemV2Problems(workItem, `index.workItems[${position}]`))
    })
  }
  return problems
}

/** Schema problems of one pending authorization request, addressed by `where`. */
function authorizationProblems(authorization: unknown, where: string): string[] {
  if (!isRecord(authorization)) return [`${where} must be an object`]
  const problems: string[] = []
  if (!isNonEmptyString(authorization.requestId)) {
    problems.push(`${where}.requestId must be a non-empty string`)
  }
  if (!isNonEmptyString(authorization.summary)) {
    problems.push(`${where}.summary must be a non-empty string`)
  } else if (Array.from(authorization.summary).length > AUTHORIZATION_SUMMARY_MAX_CHARS) {
    problems.push(`${where}.summary must be at most ${AUTHORIZATION_SUMMARY_MAX_CHARS} characters`)
  }
  if (!isIsoDate(authorization.requestedAt)) {
    problems.push(`${where}.requestedAt must be an ISO 8601 timestamp`)
  }
  return problems
}

/** Schema problems of one v2 topic record, addressed by `where`. */
function topicV2Problems(topic: unknown, where: string): string[] {
  if (!isRecord(topic)) return [`${where} must be an object`]
  const problems: string[] = []
  if (!isNonEmptyString(topic.topicId)) problems.push(`${where}.topicId must be a non-empty string`)
  if (typeof topic.title !== 'string') problems.push(`${where}.title must be a string`)
  if (!isOneOf(topic.status, TOPIC_STATUSES)) {
    problems.push(`${where}.status must be one of ${TOPIC_STATUSES.join('|')}`)
  }
  if (typeof topic.awaitingReview !== 'boolean') {
    problems.push(`${where}.awaitingReview must be a boolean`)
  }
  if (typeof topic.blocked !== 'boolean') problems.push(`${where}.blocked must be a boolean`)
  // Absent block fields are legal on an older document (normalised on read);
  // a present value must be coherent. `blocked` is derived from the reason.
  if (topic.blockedReason !== undefined && topic.blockedReason !== null && !isOneOf(topic.blockedReason, BLOCKED_REASONS)) {
    problems.push(`${where}.blockedReason must be one of ${BLOCKED_REASONS.join('|')} or null`)
  }
  if (
    topic.blockedFromStatus !== undefined &&
    topic.blockedFromStatus !== null &&
    !isOneOf(topic.blockedFromStatus, BLOCKED_FROM_STATUSES)
  ) {
    problems.push(`${where}.blockedFromStatus must be one of ${BLOCKED_FROM_STATUSES.join('|')} or null`)
  }
  if (topic.blockedAt !== undefined && topic.blockedAt !== null && !isIsoDate(topic.blockedAt)) {
    problems.push(`${where}.blockedAt must be an ISO 8601 timestamp or null`)
  }
  if (topic.authorization !== undefined && topic.authorization !== null) {
    problems.push(...authorizationProblems(topic.authorization, `${where}.authorization`))
    if (topic.blockedReason !== 'authorization') {
      problems.push(`${where}.blockedReason must be authorization when a request is pending`)
    }
  } else if (topic.blockedReason === 'authorization') {
    problems.push(`${where}.authorization must be an object when blockedReason is authorization`)
  }
  if (topic.blockedReason === null && typeof topic.blocked === 'boolean' && topic.blocked) {
    problems.push(`${where}.blocked must be false when blockedReason is null`)
  }
  if (typeof topic.blockedReason === 'string' && topic.blockedReason !== null && topic.blocked === false) {
    problems.push(`${where}.blocked must be true when blockedReason is set`)
  }
  if (typeof topic.scope !== 'string') problems.push(`${where}.scope must be a string`)
  if (!isStringArray(topic.ownedPaths)) {
    problems.push(`${where}.ownedPaths must be an array of strings`)
  }
  if (!isStringArray(topic.aliases)) problems.push(`${where}.aliases must be an array of strings`)
  if (typeof topic.digest !== 'string') problems.push(`${where}.digest must be a string`)
  if (!isNonEmptyString(topic.cwd)) problems.push(`${where}.cwd must be a non-empty string`)
  if (topic.legacyCheckoutPath !== null && typeof topic.legacyCheckoutPath !== 'string') {
    problems.push(`${where}.legacyCheckoutPath must be a string or null`)
  }
  if (!isIsoDate(topic.createdAt)) problems.push(`${where}.createdAt must be an ISO 8601 timestamp`)
  if (!isIsoDate(topic.updatedAt)) problems.push(`${where}.updatedAt must be an ISO 8601 timestamp`)
  if (!isIsoDate(topic.lastActiveAt)) {
    problems.push(`${where}.lastActiveAt must be an ISO 8601 timestamp`)
  }
  if (topic.lastDeliveryConfirmedAt !== null && !isIsoDate(topic.lastDeliveryConfirmedAt)) {
    problems.push(`${where}.lastDeliveryConfirmedAt must be an ISO 8601 timestamp or null`)
  }
  if (topic.resolvedAt !== null && !isIsoDate(topic.resolvedAt)) {
    problems.push(`${where}.resolvedAt must be an ISO 8601 timestamp or null`)
  }
  if (topic.resolvedBy !== null && !isOneOf(topic.resolvedBy, ['user', 'master'] as const)) {
    problems.push(`${where}.resolvedBy must be one of user|master or null`)
  }
  if (topic.latestReviewRequestId !== null && !isNonEmptyString(topic.latestReviewRequestId)) {
    problems.push(`${where}.latestReviewRequestId must be a non-empty string or null`)
  }
  if (topic.reviewStatus !== null && !isOneOf(topic.reviewStatus, REVIEW_STATUSES)) {
    problems.push(`${where}.reviewStatus must be one of ${REVIEW_STATUSES.join('|')} or null`)
  }
  if (topic.reviewerSessionId !== null && !isNonEmptyString(topic.reviewerSessionId)) {
    problems.push(`${where}.reviewerSessionId must be a non-empty string or null`)
  }
  if (topic.legacyStatus !== undefined && !isOneOf(topic.legacyStatus, LEGACY_STATUS_MARKERS)) {
    problems.push(`${where}.legacyStatus must be one of ${LEGACY_STATUS_MARKERS.join('|')}`)
  }
  problems.push(...legacyAttachmentProblems(topic, where))
  return problems
}

/**
 * Problems of the tolerated v1 review attachment fields. They are optional on a
 * v2 topic; a present value must still be readable by the legacy view.
 */
function legacyAttachmentProblems(topic: Record<string, unknown>, where: string): string[] {
  const problems: string[] = []
  for (const field of ['lastHandoffAt', 'reviewRequestedAt', 'reviewedAt'] as const) {
    const value = topic[field]
    if (value !== undefined && value !== null && !isIsoDate(value)) {
      problems.push(`${where}.${field} must be an ISO 8601 timestamp or null`)
    }
  }
  const latestReviewPath = topic.latestReviewPath
  if (latestReviewPath !== undefined && latestReviewPath !== null && !isNonEmptyString(latestReviewPath)) {
    problems.push(`${where}.latestReviewPath must be a non-empty string or null`)
  }
  return problems
}

/** Schema problems of one v2 work item record, addressed by `where`. */
function workItemV2Problems(workItem: unknown, where: string): string[] {
  if (!isRecord(workItem)) return [`${where} must be an object`]
  const problems: string[] = []
  if (!isNonEmptyString(workItem.workItemId)) {
    problems.push(`${where}.workItemId must be a non-empty string`)
  }
  if (!isNonEmptyString(workItem.topicId)) problems.push(`${where}.topicId must be a non-empty string`)
  if (!isNonEmptyString(workItem.path)) problems.push(`${where}.path must be a non-empty string`)
  if (!isNonEmptyString(workItem.branch)) problems.push(`${where}.branch must be a non-empty string`)
  for (const field of ['baseCommit', 'headCommit'] as const) {
    if (workItem[field] !== null && !isNonEmptyString(workItem[field])) {
      problems.push(`${where}.${field} must be a non-empty string or null`)
    }
  }
  if (!isOneOf(workItem.status, WORK_ITEM_STATUSES)) {
    problems.push(`${where}.status must be one of ${WORK_ITEM_STATUSES.join('|')}`)
  }
  if (!isIsoDate(workItem.createdAt)) problems.push(`${where}.createdAt must be an ISO 8601 timestamp`)
  if (!isIsoDate(workItem.updatedAt)) problems.push(`${where}.updatedAt must be an ISO 8601 timestamp`)
  return problems
}

/** Schema problems of one activity event. An empty array means the event is valid. */
export function activityEventProblems(event: unknown): string[] {
  if (!isRecord(event)) return ['activity must be a JSON object']
  const problems: string[] = []
  if (!isNonEmptyString(event.eventId)) problems.push('activity.eventId must be a non-empty string')
  if (!isIsoDate(event.time)) problems.push('activity.time must be an ISO 8601 timestamp')
  if (!isOneOf(event.type, ACTIVITY_TYPES)) {
    problems.push(`activity.type must be one of ${ACTIVITY_TYPES.join('|')}`)
  }
  if (event.topicId !== null && !isNonEmptyString(event.topicId)) {
    problems.push('activity.topicId must be a non-empty string or null')
  }
  if (!isNonEmptyString(event.summary)) problems.push('activity.summary must be a non-empty string')
  if (!isRecord(event.details)) problems.push('activity.details must be a JSON object')
  return problems
}

/** Schema problems of one inbox item. An empty array means the item is valid. */
export function inboxItemProblems(item: unknown): string[] {
  if (!isRecord(item)) return ['inbox must be a JSON object']
  const problems: string[] = []
  if (!isNonEmptyString(item.id)) problems.push('inbox.id must be a non-empty string')
  if (!isIsoDate(item.time)) problems.push('inbox.time must be an ISO 8601 timestamp')
  if (!isNonEmptyString(item.topicId)) problems.push('inbox.topicId must be a non-empty string')
  if (!isOneOf(item.kind, INBOX_KINDS)) {
    problems.push(`inbox.kind must be one of ${INBOX_KINDS.join('|')}`)
  }
  if (!isNonEmptyString(item.summary)) problems.push('inbox.summary must be a non-empty string')
  if (item.deliveredAt !== null && !isIsoDate(item.deliveredAt)) {
    problems.push('inbox.deliveredAt must be an ISO 8601 timestamp or null')
  }
  return problems
}

/** On-disk version of the handoff and review documents (unchanged by index v2). */
const RECORD_VERSION = 1

/** The only statuses a stored handoff may carry. */
const HANDOFF_RECORD_STATUSES = ['awaiting_review', 'blocked', 'done'] as const

/** Status a handoff may carry. `new`/`active` are thread states, not handoff states. */
export type HandoffStatus = (typeof HANDOFF_RECORD_STATUSES)[number]

/** One verification row of a handoff. */
export interface HandoffVerification {
  command: string
  exitCode: number
  evidence: string
}

/** One handoff document (`<repo>/.dsh-cowork/handoffs/<threadId>-<stamp>.json`). */
export interface HandoffRecord {
  version: 1
  threadId: string
  masterSessionId: string
  status: HandoffStatus
  subject: string
  summary: string
  decisions: string[]
  changedPaths: string[]
  artifacts: string[]
  verification: HandoffVerification[]
  openIssues: string[]
  nextStep: string | null
  createdAt: string
  deliveredAt: string | null
}

/** Schema problems of a handoff record this store is asked to persist. */
export function handoffRecordProblems(record: unknown): string[] {
  if (!isRecord(record)) return ['handoff must be a JSON object']
  const problems: string[] = []
  if (record.version !== RECORD_VERSION) problems.push(`handoff.version must be ${RECORD_VERSION}`)
  if (!isNonEmptyString(record.threadId)) problems.push('handoff.threadId must be a non-empty string')
  if (!isNonEmptyString(record.masterSessionId)) {
    problems.push('handoff.masterSessionId must be a non-empty string')
  }
  if (!(HANDOFF_RECORD_STATUSES as readonly unknown[]).includes(record.status)) {
    problems.push(`handoff.status must be one of ${HANDOFF_RECORD_STATUSES.join('|')}`)
  }
  if (!isNonEmptyString(record.subject)) problems.push('handoff.subject must be a non-empty string')
  if (!isNonEmptyString(record.summary)) problems.push('handoff.summary must be a non-empty string')
  for (const field of ['decisions', 'changedPaths', 'artifacts', 'openIssues'] as const) {
    if (!isStringArray(record[field])) problems.push(`handoff.${field} must be an array of strings`)
  }
  if (!Array.isArray(record.verification) || record.verification.length === 0) {
    problems.push('handoff.verification must be a non-empty array')
  } else {
    record.verification.forEach((row, position) => {
      const where = `handoff.verification[${position}]`
      if (!isRecord(row)) {
        problems.push(`${where} must be an object`)
        return
      }
      if (!isNonEmptyString(row.command)) problems.push(`${where}.command must be a non-empty string`)
      if (!Number.isInteger(row.exitCode)) problems.push(`${where}.exitCode must be an integer`)
      if (typeof row.evidence !== 'string') problems.push(`${where}.evidence must be a string`)
    })
  }
  if (record.nextStep !== null && typeof record.nextStep !== 'string') {
    problems.push('handoff.nextStep must be a string or null')
  }
  if (!isIsoDate(record.createdAt)) problems.push('handoff.createdAt must be an ISO 8601 timestamp')
  if (record.deliveredAt !== null && !isIsoDate(record.deliveredAt)) {
    problems.push('handoff.deliveredAt must be an ISO 8601 timestamp or null')
  }
  return problems
}

/**
 * Schema problems of a review record, mirroring `validateReviewInput` in
 * src/review.ts (kept here for the type-only-import rule above): a stored
 * review must be as strict as the input that produced it.
 */
export function reviewRecordProblems(record: unknown): string[] {
  if (!isRecord(record)) return ['review must be a JSON object']
  const problems: string[] = []
  if (record.version !== RECORD_VERSION) problems.push(`review.version must be ${RECORD_VERSION}`)
  if (!isNonEmptyString(record.threadId)) problems.push('review.threadId must be a non-empty string')
  if (!isNonEmptyString(record.reviewerSessionId)) {
    problems.push('review.reviewerSessionId must be a non-empty string')
  }
  if (!REVIEW_VERDICTS.includes(record.verdict as ReviewVerdict)) {
    problems.push(`review.verdict must be one of ${REVIEW_VERDICTS.join('|')}`)
  }
  if (!isNonEmptyString(record.summary)) problems.push('review.summary must be a non-empty string')
  if (!Array.isArray(record.findings)) {
    problems.push('review.findings must be an array')
  } else {
    if (record.verdict !== 'pass' && record.findings.length === 0) {
      problems.push(`review.findings must not be empty for ${String(record.verdict)}`)
    }
    record.findings.forEach((finding, position) => {
      const where = `review.findings[${position}]`
      if (!isRecord(finding)) {
        problems.push(`${where} must be an object`)
        return
      }
      if (!isNonEmptyString(finding.id)) problems.push(`${where}.id must be a non-empty string`)
      if (!REVIEW_SEVERITIES.includes(finding.severity as ReviewSeverity)) {
        problems.push(`${where}.severity must be one of ${REVIEW_SEVERITIES.join('|')}`)
      }
      if (!isNonEmptyString(finding.problem)) {
        problems.push(`${where}.problem must be a non-empty string`)
      }
      if (!isNonEmptyString(finding.requiredFix)) {
        problems.push(`${where}.requiredFix must be a non-empty string`)
      }
      if (finding.file !== undefined && !isNonEmptyString(finding.file)) {
        problems.push(`${where}.file must be a non-empty string when present`)
      }
      if (
        finding.line !== undefined &&
        (!Number.isInteger(finding.line) || (finding.line as number) < 1)
      ) {
        problems.push(`${where}.line must be a positive integer when present`)
      }
    })
  }
  if (!Array.isArray(record.verification)) {
    problems.push('review.verification must be an array')
  } else {
    record.verification.forEach((row, position) => {
      const where = `review.verification[${position}]`
      if (!isRecord(row)) {
        problems.push(`${where} must be an object`)
        return
      }
      if (!isNonEmptyString(row.command)) problems.push(`${where}.command must be a non-empty string`)
      if (!Number.isInteger(row.exitCode)) problems.push(`${where}.exitCode must be an integer`)
      if (typeof row.evidence !== 'string') problems.push(`${where}.evidence must be a string`)
    })
  }
  if (!isIsoDate(record.createdAt)) problems.push('review.createdAt must be an ISO 8601 timestamp')
  return problems
}

/** Serialized size of one activity line, including its newline. */
export function activityLineBytes(event: ActivityEvent): number {
  return Buffer.byteLength(JSON.stringify(event), 'utf8') + 1
}

/** Serialize the activity stream as JSON Lines, one event per line. */
export function serializeActivityEvents(events: readonly ActivityEvent[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join('')
}

/**
 * Keep the newest events within both bounds: at most
 * {@link ACTIVITY_MAX_EVENTS} events and at most {@link ACTIVITY_MAX_BYTES}
 * serialized bytes. The oldest events are dropped first.
 */
export function trimActivityEvents(events: readonly ActivityEvent[]): ActivityEvent[] {
  let first = 0
  let bytes = events.reduce((total, event) => total + activityLineBytes(event), 0)
  while (
    first < events.length &&
    (events.length - first > ACTIVITY_MAX_EVENTS || bytes > ACTIVITY_MAX_BYTES)
  ) {
    bytes -= activityLineBytes(events[first])
    first += 1
  }
  return events.slice(first)
}
