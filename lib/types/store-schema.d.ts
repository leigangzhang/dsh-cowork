/**
 * Index v2 schema: the types `.dsh-cowork/index.json` carries after M7 and the
 * pure validation this plugin applies before it trusts a document.
 *
 * Two vocabularies live here on purpose. v2 (`TopicRecordV2`, `WorkItemRecordV2`)
 * is what the store writes; the v1 shapes (`ThreadRecordV1`, `ProjectIndexV1`)
 * stay because `src/tools.ts`, `src/api.ts`, `src/handoff.ts` and
 * `src/review-tools.ts` are still v1-shaped and cannot change in M7. The v1
 * normalizer reproduces `src/store.ts`'s `normalizeThreadDocument` behaviour
 * (pre-M2 `worktreePath` adoption, M3 review fields defaulted to null) so a
 * document read through this module and one read through the old store agree.
 *
 * Nothing here touches the file system: I/O and locking stay in `src/store.ts`.
 */
/** On-disk index version this module describes: topics + work items. */
export declare const INDEX_VERSION_V2 = 2;
/** Legacy thread-centred index version this module still reads. */
export declare const INDEX_VERSION_V1 = 1;
/** Most events `activity.jsonl` keeps before the oldest are dropped. */
export declare const ACTIVITY_MAX_EVENTS = 500;
/** Largest serialized `activity.jsonl` (512 KiB) before the oldest rows go. */
export declare const ACTIVITY_MAX_BYTES = 524288;
/** Most items `inbox.json` keeps. */
export declare const INBOX_MAX_ITEMS = 50;
/** Most records the notice delivery ledger keeps (`notices.json` v1). */
export declare const NOTICE_LEDGER_MAX_RECORDS = 200;
/** Lifecycle of one topic. */
export declare const TOPIC_STATUSES: readonly ["active", "idle", "resolved"];
/** Lifecycle of one topic as recorded in the project index. */
export type TopicStatus = (typeof TOPIC_STATUSES)[number];
/**
 * Why a topic is blocked. The flag is derived (`blocked === blockedReason !== null`),
 * so the list is also the only legal source of that boolean.
 */
export declare const BLOCKED_REASONS: readonly ["authorization", "handoff", "conflict"];
/** Why a topic is blocked. */
export type BlockedReason = (typeof BLOCKED_REASONS)[number];
/** The statuses a block can be released back to. */
export declare const BLOCKED_FROM_STATUSES: readonly ["active", "idle"];
/** The status a block restores when it is cleared. */
export type BlockedFromStatus = (typeof BLOCKED_FROM_STATUSES)[number];
/** Longest authorization summary the index accepts, in code points. */
export declare const AUTHORIZATION_SUMMARY_MAX_CHARS = 200;
/** One pending authorization request of a topic. */
export interface TopicAuthorization {
    requestId: string;
    summary: string;
    requestedAt: string;
}
/** Lifecycle of one isolated work item. */
export declare const WORK_ITEM_STATUSES: readonly ["active", "reviewing", "merged", "abandoned"];
/** Lifecycle of one isolated work item. */
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];
/** The only reasons an event may enter the master inbox. */
export declare const INBOX_KINDS: readonly ["merge-needed", "blocked", "review-reject", "cross-topic-conflict"];
/** Why an inbox item is waiting for the master. */
export type InboxKind = (typeof INBOX_KINDS)[number];
/** Review states a topic or review request may carry. */
export declare const REVIEW_STATUSES: readonly ["pending", "pass", "needs_revision", "reject"];
/** Review state of a topic's newest review. */
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
/** The verdicts a reviewer may return. `pending` is a request state, not a verdict. */
export declare const REVIEW_VERDICTS: readonly ["pass", "needs_revision", "reject"];
/** One verdict a reviewer may return. */
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
/** Finding severities, most severe first. */
export declare const REVIEW_SEVERITIES: readonly ["blocker", "high", "medium", "low"];
/** Severity of one review finding. */
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];
/**
 * Lifecycle of a v1 thread. Moved here from `src/review.ts` so the legacy review
 * model has one home that outlives that module (M10.3 deletes it).
 */
export type ReviewThreadStatus = 'new' | 'active' | 'awaiting_review' | 'done' | 'blocked' | 'archived';
/** One required fix a legacy review names. */
export interface ReviewFinding {
    id: string;
    severity: ReviewSeverity;
    problem: string;
    requiredFix: string;
    file?: string;
    line?: number;
}
/** One check a reviewer actually ran. */
export interface ReviewVerification {
    command: string;
    exitCode: number;
    evidence: string;
}
/**
 * One legacy verdict-only review document
 * (`<repo>/.dsh-cowork/reviews/<threadId>-<stamp>.json`). M10 replaced this
 * model with the request file (`src/review-request.ts`); old files stay
 * readable by `src/store.ts` and are never rewritten.
 */
export interface ReviewRecord {
    version: 1;
    threadId: string;
    reviewerSessionId: string;
    verdict: ReviewVerdict;
    summary: string;
    findings: ReviewFinding[];
    verification: ReviewVerification[];
    createdAt: string;
}
/**
 * Event types the activity stream records. PLAN-V0.2 §5.3/§5.4/§5.5/§5.6 name
 * the kinds of event; `route-corrected` is the one name the plan spells out.
 */
export declare const ACTIVITY_TYPES: readonly ["topic-created", "route-reused", "route-created", "route-corrected", "status-changed", "topic-reopened", "review-requested", "review-verdict", "work-item-created", "work-item-merged", "topic-reported", "decision-proposed", "authorization-requested", "authorization-resolved", "topic-archived", "request-created", "request-resolved", "error"];
/** One kind of activity event. */
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
/** One topic of the v2 project index (PLAN-V0.2 §4.3). */
export interface TopicRecordV2 {
    topicId: string;
    title: string;
    status: TopicStatus;
    awaitingReview: boolean;
    /** Derived flag: `blocked !== null` — see {@link TopicRecordV2.blockedReason}. */
    blocked: boolean;
    /** Why the topic is blocked; null means it is not blocked. */
    blockedReason: BlockedReason | null;
    /** Status the block restores when it is released; null when not blocked. */
    blockedFromStatus: BlockedFromStatus | null;
    /** When the topic was first blocked, for diagnostics and sorting. */
    blockedAt: string | null;
    /** Pending authorization request; non-null implies `blockedReason === 'authorization'`. */
    authorization: TopicAuthorization | null;
    scope: string;
    ownedPaths: string[];
    aliases: string[];
    digest: string;
    cwd: string;
    legacyCheckoutPath: string | null;
    createdAt: string;
    updatedAt: string;
    lastActiveAt: string;
    lastDeliveryConfirmedAt: string | null;
    resolvedAt: string | null;
    resolvedBy: 'user' | 'master' | null;
    latestReviewRequestId: string | null;
    reviewStatus: ReviewStatus | null;
    reviewerSessionId: string | null;
}
/** One isolated work item of the v2 project index (PLAN-V0.2 §4.3). */
export interface WorkItemRecordV2 {
    workItemId: string;
    topicId: string;
    path: string;
    branch: string;
    baseCommit: string | null;
    headCommit: string | null;
    status: WorkItemStatus;
    createdAt: string;
    updatedAt: string;
}
/** The v2 project index document (`<repo>/.dsh-cowork/index.json`). */
export interface ProjectIndexV2 {
    version: 2;
    projectId: string;
    masterSessionId: string;
    createdAt: string;
    /**
     * Topic the user has open in the panel (PLAN-V0.2 §5.3 layer 1). Optional on
     * disk: an older v2 document predates the field and reads as null.
     */
    masterFocusTopicId?: string | null;
    /** Topic the previous route picked (PLAN-V0.2 §5.3 layer 1). */
    lastRouteTopicId?: string | null;
    topics: TopicRecordV2[];
    workItems: WorkItemRecordV2[];
}
/** One line of `<repo>/.dsh-cowork/activity.jsonl`. */
export interface ActivityEvent {
    eventId: string;
    time: string;
    type: ActivityType;
    /** Topic the event belongs to, or null for project-level events. */
    topicId: string | null;
    summary: string;
    /** Structured detail for the panel; never free-form log text. */
    details: Record<string, unknown>;
}
/**
 * One read of the activity stream: valid events oldest first, and how many
 * lines were skipped because they were not valid events.
 */
export interface ReadActivityResult {
    events: ActivityEvent[];
    skippedLines: number;
}
/** One item of `<repo>/.dsh-cowork/inbox.json`. */
export interface InboxItem {
    id: string;
    time: string;
    topicId: string;
    kind: InboxKind;
    summary: string;
    deliveredAt: string | null;
}
/** One thread of the legacy v1 index, as the unchanged v1 tools expect it. */
export interface ThreadRecordV1 {
    threadId: string;
    subject: string;
    status: 'new' | 'active' | 'awaiting_review' | 'done' | 'blocked' | 'archived';
    cwd: string;
    checkoutPath: string | null;
    createdAt: string;
    updatedAt: string;
    lastHandoffAt: string | null;
    reviewStatus: ReviewStatus | null;
    reviewRequestedAt: string | null;
    reviewedAt: string | null;
    reviewerSessionId: string | null;
    latestReviewPath: string | null;
}
/** The legacy thread-centred index document (`version: 1`). */
export interface ProjectIndexV1 {
    version: 1;
    projectId: string;
    masterSessionId: string;
    createdAt: string;
    threads: ThreadRecordV1[];
}
/** Every v1 thread status; the migration maps each one explicitly. */
export declare const LEGACY_THREAD_STATUSES: readonly ["new", "active", "awaiting_review", "done", "blocked", "archived"];
/** One legacy v1 thread status. */
export type ThreadStatusV1 = (typeof LEGACY_THREAD_STATUSES)[number];
/**
 * The two v1 states that have no v2 equivalent and therefore survive as a
 * tolerated marker on the topic (`legacyStatus`): `new` is an active topic that
 * never started, `archived` is a resolved topic that was archived rather than
 * finished. Deriving a status alone cannot recover either distinction.
 */
export declare const LEGACY_STATUS_MARKERS: readonly ["new", "archived"];
/** A preserved v1-only status. */
export type LegacyStatusMarker = (typeof LEGACY_STATUS_MARKERS)[number];
/**
 * Read one v1 thread into the current v1 shape. Mirrors
 * `src/store.ts`'s `normalizeThreadDocument`: the pre-M2 `worktreePath` name is
 * adopted only when `checkoutPath` is absent and is never copied forward; the
 * M3 review fields are filled with null so a loaded record always has them.
 */
export declare function normalizeProjectIndexV1(index: unknown): unknown;
/** Schema problems of a v1 project index document. */
export declare function projectIndexV1Problems(index: unknown): string[];
/** Schema problems of one v1 thread record, addressed by `where`. */
export declare function threadV1Problems(thread: unknown, where: string): string[];
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
export declare function normalizeProjectIndexV2(index: unknown): unknown;
/** Schema problems of a v2 project index document. */
export declare function projectIndexV2Problems(index: unknown): string[];
/** Schema problems of one activity event. An empty array means the event is valid. */
export declare function activityEventProblems(event: unknown): string[];
/** Schema problems of one inbox item. An empty array means the item is valid. */
export declare function inboxItemProblems(item: unknown): string[];
/** Schema problems of a handoff record this store is asked to persist. */
export declare function handoffRecordProblems(record: unknown): string[];
/**
 * Schema problems of a review record, mirroring `validateReviewInput` in
 * src/review.ts (kept here for the type-only-import rule above): a stored
 * review must be as strict as the input that produced it.
 */
export declare function reviewRecordProblems(record: unknown): string[];
/** Serialized size of one activity line, including its newline. */
export declare function activityLineBytes(event: ActivityEvent): number;
/** Serialize the activity stream as JSON Lines, one event per line. */
export declare function serializeActivityEvents(events: readonly ActivityEvent[]): string;
/**
 * Keep the newest events within both bounds: at most
 * {@link ACTIVITY_MAX_EVENTS} events and at most {@link ACTIVITY_MAX_BYTES}
 * serialized bytes. The oldest events are dropped first.
 */
export declare function trimActivityEvents(events: readonly ActivityEvent[]): ActivityEvent[];
