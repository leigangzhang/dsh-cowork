/**
 * Business activity events (M8.3).
 *
 * This module builds the events the lifecycle rules publish and records them
 * through the store's append port. The file layer stays in `src/store.ts`:
 * `appendActivity` validates the event, enforces the 500-event / 512-KiB bounds
 * and repairs damaged lines on its next rewrite, so nothing here re-implements
 * JSON Lines I/O. The event-type vocabulary has one home,
 * `ACTIVITY_TYPES` in `src/store-schema.ts`; this module does not copy it.
 */
import { randomUUID } from 'node:crypto';
import { NOTICE_SUMMARY_MAX_CHARS, noticeDescriptor } from './notices.js';
import { ACTIVITY_TYPES } from './store-schema.js';
/** Build one validated event stamped with the injected clock. */
export function buildActivityEvent(input, now) {
    if (!ACTIVITY_TYPES.includes(input.type)) {
        throw new Error(`activity.type must be one of ${ACTIVITY_TYPES.join('|')}`);
    }
    if (input.summary.trim() === '') {
        throw new Error('activity.summary must be a non-empty string');
    }
    return {
        eventId: randomUUID(),
        time: now.toISOString(),
        type: input.type,
        topicId: input.topicId,
        summary: input.summary,
        details: input.details ?? {},
    };
}
/**
 * Build one event and append it through the store's validated file layer.
 * Returns the event that was written, so a caller can report the same id.
 */
export async function recordActivity(sink, input, now) {
    const event = buildActivityEvent(input, now);
    await sink.appendActivity(event);
    return event;
}
/**
 * The event a manual reopen records. Pass the topic as it was resolved: the
 * reopen clears `resolvedAt`/`resolvedBy`, and the event keeps the resolution
 * it replaced so the history in activity.jsonl stays auditable.
 */
export function topicReopenedActivity(topic, now) {
    return buildActivityEvent({
        type: 'topic-reopened',
        topicId: topic.topicId,
        summary: `reopened topic ${topic.topicId}`,
        details: { topicId: topic.topicId, resolvedAt: topic.resolvedAt, resolvedBy: topic.resolvedBy },
    }, now);
}
/** The event one lifecycle transition records (`status-changed`). */
export function statusChangedActivity(topic, change, now) {
    return buildActivityEvent({
        type: 'status-changed',
        topicId: topic.topicId,
        summary: `changed topic status from ${change.from} to ${change.to}`,
        details: { topicId: topic.topicId, from: change.from, to: change.to },
    }, now);
}
/** The event one failure records; `details` carries the structured cause. */
export function errorActivity(topicId, summary, now, details = {}) {
    return buildActivityEvent({ type: 'error', topicId, summary, details }, now);
}
/** Longest title a notice descriptor carries, in code points. */
export const NOTICE_TITLE_MAX_CHARS = 80;
/** Both sides of an event; the archive notice goes to the master only. */
const BOTH_TARGETS = ['master', 'topic'];
/** The archive notice is the one event the topic session does not receive. */
const MASTER_ONLY = ['master'];
/** Cut text to at most `limit` code points without splitting a pair. */
function clip(text, limit) {
    const points = Array.from(text);
    return points.length <= limit ? text : points.slice(0, limit).join('');
}
/**
 * The `topic-reported` event of one report. `kind` distinguishes a progress
 * report from a handoff-blocked report; both produce one notice per target.
 */
export function topicReportedActivity(topic, input, now) {
    const summary = clip(input.summary, NOTICE_SUMMARY_MAX_CHARS);
    return buildActivityEvent({
        type: 'topic-reported',
        topicId: topic.topicId,
        summary: input.kind === 'blocked' ? `topic blocked: ${summary}` : `topic reported progress: ${summary}`,
        details: {
            topicId: topic.topicId,
            kind: input.kind,
            summary,
            notice: noticeDescriptor({
                kind: 'report',
                title: topic.title,
                summary,
                targets: BOTH_TARGETS,
            }),
        },
    }, now);
}
/** The `decision-proposed` event of one decision proposal. */
export function decisionProposedActivity(topic, input, now) {
    const summary = clip(input.summary, NOTICE_SUMMARY_MAX_CHARS);
    return buildActivityEvent({
        type: 'decision-proposed',
        topicId: topic.topicId,
        summary: `proposed decision ${clip(input.title, NOTICE_TITLE_MAX_CHARS)}`,
        details: {
            topicId: topic.topicId,
            proposalId: input.proposalId,
            ...(input.proposalPath === undefined ? {} : { proposalPath: input.proposalPath }),
            title: clip(input.title, NOTICE_TITLE_MAX_CHARS),
            summary,
            notice: noticeDescriptor({
                kind: 'proposal',
                title: topic.title,
                summary,
                targets: BOTH_TARGETS,
                actions: ['open-work-item'],
            }),
        },
    }, now);
}
/** The `authorization-requested` event; the notice is pending until resolved. */
export function authorizationRequestedActivity(topic, input, now) {
    const summary = clip(input.summary, NOTICE_SUMMARY_MAX_CHARS);
    return buildActivityEvent({
        type: 'authorization-requested',
        topicId: topic.topicId,
        summary: `requested authorization: ${summary}`,
        details: {
            topicId: topic.topicId,
            requestId: input.requestId,
            notice: noticeDescriptor({
                kind: 'authorization',
                title: topic.title,
                summary,
                targets: BOTH_TARGETS,
                actions: ['allow', 'deny'],
                status: 'pending',
            }),
        },
    }, now);
}
/**
 * The `authorization-resolved` event. It updates the original notice instead of
 * creating one: `details.noticeId` is the `authorization-requested` event id,
 * and the descriptor carries the decision so `cowork_notices` and the port see
 * the same status the card gets updated to.
 */
export function authorizationResolvedActivity(topic, input, now) {
    const status = input.decision === 'allow' ? 'allowed' : 'denied';
    return buildActivityEvent({
        type: 'authorization-resolved',
        topicId: topic.topicId,
        summary: `authorization ${input.decision === 'allow' ? 'allowed' : 'denied'}: ${clip(input.summary, NOTICE_SUMMARY_MAX_CHARS)}`,
        details: {
            topicId: topic.topicId,
            requestId: input.requestId,
            noticeId: input.noticeId,
            decision: input.decision,
            notice: noticeDescriptor({
                kind: 'authorization',
                title: topic.title,
                summary: input.summary,
                targets: BOTH_TARGETS,
                actions: ['allow', 'deny'],
                status,
            }),
        },
    }, now);
}
/** The `topic-archived` event; only the master is notified. */
export function topicArchivedActivity(topic, input, now) {
    return buildActivityEvent({
        type: 'topic-archived',
        topicId: topic.topicId,
        summary: `archived topic ${clip(topic.title, NOTICE_TITLE_MAX_CHARS)}`,
        details: {
            topicId: topic.topicId,
            by: input.by,
            resolvedAt: now.toISOString(),
            // Archiving invalidates a pending authorization; the listing needs the
            // withdrawn notice id because a delivered card keeps its delivery row.
            ...(input.voidedAuthorizationNoticeId === undefined || input.voidedAuthorizationNoticeId === null
                ? {}
                : { voidedAuthorizationNoticeId: input.voidedAuthorizationNoticeId }),
            notice: noticeDescriptor({
                kind: 'archive',
                title: topic.title,
                summary: topic.digest,
                targets: MASTER_ONLY,
                status: 'void',
            }),
        },
    }, now);
}
/** The assignment notice an already-built `topic-created` event carries. */
export function assignmentNotice(topic, brief) {
    return noticeDescriptor({
        kind: 'assignment',
        title: topic.title,
        summary: brief.trim() === '' ? topic.scope : brief,
        targets: BOTH_TARGETS,
    });
}
/** Short label per request kind, used by the two request activity rows. */
const REQUEST_KIND_LABEL = {
    'user-review': '用户评审',
    authorization: '授权',
    question: '提问',
    plan: '计划确认',
};
/**
 * The `request-created` event: one row per request a topic tool persisted. It
 * carries no notice descriptor on purpose — the inbox reads request files, not
 * notifications, so creating a request must not grow the notice ledger.
 */
export function requestCreatedActivity(record, now) {
    return buildActivityEvent({
        type: 'request-created',
        topicId: record.topicId,
        summary: `requested ${REQUEST_KIND_LABEL[record.kind]} ${record.requestId}`,
        details: {
            requestId: record.requestId,
            topicId: record.topicId,
            kind: record.kind,
            status: record.status,
        },
    }, now);
}
/**
 * The `request-resolved` event of one committed decision (or an archive's
 * `void`). Like `request-created` it carries no notice descriptor: the card is
 * the request file, and the activity row is the audit trail.
 */
export function requestResolvedActivity(record, input, now) {
    return buildActivityEvent({
        type: 'request-resolved',
        topicId: record.topicId,
        summary: `resolved ${REQUEST_KIND_LABEL[record.kind]} request ${record.requestId} as ${record.status}`,
        details: {
            requestId: record.requestId,
            topicId: record.topicId,
            kind: record.kind,
            action: input.action,
            status: record.status,
            resolvedBy: record.resolvedBy,
        },
    }, now);
}
//# sourceMappingURL=activity.js.map