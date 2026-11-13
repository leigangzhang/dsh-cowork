import type { ActivityNoticeDescriptor } from './notices.js';
import type { ActivityEvent, ActivityType, TopicRecordV2, TopicStatus } from './store-schema.js';
import type { RequestAction, RequestRecordV1 } from './inbox-contract.js';
/** Everything one business activity event is built from. */
export interface ActivityInput {
    type: ActivityType;
    /** Topic the event belongs to, or null for project-level events. */
    topicId: string | null;
    summary: string;
    /** Structured detail for the panel; never free-form log text. Defaults to `{}`. */
    details?: Record<string, unknown>;
}
/** The narrow append port this module needs from the store. */
export interface ActivitySink {
    appendActivity(event: ActivityEvent): Promise<void>;
}
/** Build one validated event stamped with the injected clock. */
export declare function buildActivityEvent(input: ActivityInput, now: Date): ActivityEvent;
/**
 * Build one event and append it through the store's validated file layer.
 * Returns the event that was written, so a caller can report the same id.
 */
export declare function recordActivity(sink: ActivitySink, input: ActivityInput, now: Date): Promise<ActivityEvent>;
/**
 * The event a manual reopen records. Pass the topic as it was resolved: the
 * reopen clears `resolvedAt`/`resolvedBy`, and the event keeps the resolution
 * it replaced so the history in activity.jsonl stays auditable.
 */
export declare function topicReopenedActivity(topic: TopicRecordV2, now: Date): ActivityEvent;
/** The event one lifecycle transition records (`status-changed`). */
export declare function statusChangedActivity(topic: TopicRecordV2, change: {
    from: TopicStatus;
    to: TopicStatus;
}, now: Date): ActivityEvent;
/** The event one failure records; `details` carries the structured cause. */
export declare function errorActivity(topicId: string | null, summary: string, now: Date, details?: Record<string, unknown>): ActivityEvent;
/** Longest title a notice descriptor carries, in code points. */
export declare const NOTICE_TITLE_MAX_CHARS = 80;
/**
 * The `topic-reported` event of one report. `kind` distinguishes a progress
 * report from a handoff-blocked report; both produce one notice per target.
 */
export declare function topicReportedActivity(topic: TopicRecordV2, input: {
    summary: string;
    kind: 'progress' | 'blocked';
}, now: Date): ActivityEvent;
/** The `decision-proposed` event of one decision proposal. */
export declare function decisionProposedActivity(topic: TopicRecordV2, input: {
    proposalId: string;
    proposalPath?: string;
    title: string;
    summary: string;
}, now: Date): ActivityEvent;
/** The `authorization-requested` event; the notice is pending until resolved. */
export declare function authorizationRequestedActivity(topic: TopicRecordV2, input: {
    requestId: string;
    summary: string;
}, now: Date): ActivityEvent;
/**
 * The `authorization-resolved` event. It updates the original notice instead of
 * creating one: `details.noticeId` is the `authorization-requested` event id,
 * and the descriptor carries the decision so `cowork_notices` and the port see
 * the same status the card gets updated to.
 */
export declare function authorizationResolvedActivity(topic: TopicRecordV2, input: {
    requestId: string;
    noticeId: string;
    decision: 'allow' | 'deny';
    summary: string;
}, now: Date): ActivityEvent;
/** The `topic-archived` event; only the master is notified. */
export declare function topicArchivedActivity(topic: TopicRecordV2, input: {
    by: 'user' | 'master';
    voidedAuthorizationNoticeId?: string | null;
}, now: Date): ActivityEvent;
/** The assignment notice an already-built `topic-created` event carries. */
export declare function assignmentNotice(topic: TopicRecordV2, brief: string): ActivityNoticeDescriptor;
/**
 * The `request-created` event: one row per request a topic tool persisted. It
 * carries no notice descriptor on purpose — the inbox reads request files, not
 * notifications, so creating a request must not grow the notice ledger.
 */
export declare function requestCreatedActivity(record: RequestRecordV1, now: Date): ActivityEvent;
/**
 * The `request-resolved` event of one committed decision (or an archive's
 * `void`). Like `request-created` it carries no notice descriptor: the card is
 * the request file, and the activity row is the audit trail.
 */
export declare function requestResolvedActivity(record: RequestRecordV1, input: {
    action: RequestAction | null;
}, now: Date): ActivityEvent;
