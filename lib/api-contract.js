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
import { INBOX_ERROR_STATUS } from './inbox-contract.js';
/** Exact Fetch-route path below the connection `/api` channel: project overview. */
export const OVERVIEW_PATH = '/api/cowork.overview';
/** Exact Fetch-route path below the connection `/api` channel: activity tail. */
export const ACTIVITY_PATH = '/api/cowork.activity';
/** Exact Fetch-route path below the connection `/api` channel: one topic's detail. */
export const TOPIC_PATH = '/api/cowork.topic';
/** Write route: mark one topic resolved (master only, idempotent). */
export const RESOLVE_PATH = '/api/cowork.topic.resolve';
/** Write route: reopen one resolved topic (master only). */
export const REOPEN_PATH = '/api/cowork.topic.reopen';
/** Write route: decide one pending authorization (master or that topic's session). */
export const AUTHORIZATION_RESOLVE_PATH = '/api/cowork.authorization.resolve';
/** Write route: move work routed to one topic into another (master only). */
export const ROUTE_MOVE_PATH = '/api/cowork.route.move';
/** Most topics one overview response may carry. */
export const MAX_PANEL_TOPICS = 500;
/** Activity rows returned when the request names no `limit`. */
export const ACTIVITY_DEFAULT_LIMIT = 50;
/** Largest `limit` the activity route accepts. */
export const ACTIVITY_MAX_LIMIT = 200;
/** Activity rows the topic detail carries. */
export const TOPIC_ACTIVITY_LIMIT = 50;
/** Work items one topic detail may carry. */
export const MAX_TOPIC_WORK_ITEMS = 50;
/** Review requests one topic detail may carry (newest first). */
export const MAX_TOPIC_REVIEW_REQUESTS = 10;
/** Findings one review request may carry. */
export const MAX_REVIEW_FINDINGS = 20;
/** Verification rows one review request may carry. */
export const MAX_REVIEW_VERIFICATION = 10;
/** Changed paths one review request may carry. */
export const MAX_REVIEW_CHANGED_PATHS = 50;
/** Owned paths one topic may carry. */
export const MAX_TOPIC_OWNED_PATHS = 50;
/** Cap on every human-readable summary/digest the wire carries. */
export const MAX_SUMMARY_CHARS = 200;
/** Most inbox items one overview response may carry. */
export const MAX_INBOX_ITEMS = 20;
/** Largest request body a write route accepts (8 KiB). */
export const MAX_REQUEST_BODY_BYTES = 8192;
/** Every blocked reason, in the contract's order. */
export const PANEL_BLOCKED_REASONS = [
    'authorization', 'handoff', 'conflict',
];
/** Topic lifecycle in list priority order: active first, resolved still listed. */
export const PANEL_TOPIC_STATUS_ORDER = ['active', 'idle', 'resolved'];
/** The four work-item states. */
export const PANEL_WORK_ITEM_STATUSES = [
    'active', 'reviewing', 'merged', 'abandoned',
];
/** The four review states (they never enter the list sort). */
export const PANEL_REVIEW_STATUSES = [
    'pending', 'pass', 'needs_revision', 'reject',
];
/** The three verdicts a review may carry. */
export const PANEL_REVIEW_VERDICTS = ['pass', 'needs_revision', 'reject'];
/** The four finding severities. */
export const PANEL_REVIEW_SEVERITIES = ['blocker', 'high', 'medium', 'low'];
/**
 * HTTP status per stable error code. It lives in the contract module (not in
 * `src/api.ts`) because the write surface outgrew the 50 KiB read cap: the
 * host's `panelErrorStatus` re-exports this one table, and
 * `tests/api.test.mjs` pins every status here.
 *
 * Typed as a complete `Record`, so adding a code to {@link PanelErrorCode}
 * without deciding its status is a compile error.
 */
export const PANEL_ERROR_STATUS = {
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
};
/** HTTP status for a stable error code. */
export function panelErrorStatus(code) {
    return PANEL_ERROR_STATUS[code];
}
/** Whether a parsed body is the shared error envelope. */
export function isPanelError(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const record = value;
    if (record.ok !== false)
        return false;
    const error = record.error;
    return typeof error === 'object' && error !== null
        && typeof error.code === 'string';
}
/** Whether a value is one of the three topic states. */
export function isPanelTopicStatus(value) {
    return typeof value === 'string' && PANEL_TOPIC_STATUS_ORDER.includes(value);
}
/** Whether a value is one of the three blocked reasons. */
export function isPanelBlockedReason(value) {
    return typeof value === 'string' && PANEL_BLOCKED_REASONS.includes(value);
}
/** Whether a value is one of the four work-item states. */
export function isPanelWorkItemStatus(value) {
    return typeof value === 'string' && PANEL_WORK_ITEM_STATUSES.includes(value);
}
/** Whether a value is one of the four review states. */
export function isPanelReviewStatus(value) {
    return typeof value === 'string' && PANEL_REVIEW_STATUSES.includes(value);
}
/** Whether a value is one of the three recorded verdicts. */
export function isPanelReviewVerdict(value) {
    return typeof value === 'string' && PANEL_REVIEW_VERDICTS.includes(value);
}
/** Whether a value is one of the four finding severities. */
export function isPanelReviewSeverity(value) {
    return typeof value === 'string' && PANEL_REVIEW_SEVERITIES.includes(value);
}
/**
 * List rank of one topic: the two markers the topic page shows outrank every
 * status. `awaitingReview` is deliberately absent — the topic page does not use
 * review state, so a review no longer pushes a row to the top.
 */
function topicListRank(topic) {
    if (topic.blocked)
        return 0;
    if (topic.awaitingAuthorization)
        return 1;
    switch (topic.status) {
        case 'active': return 2;
        case 'idle': return 3;
        case 'resolved': return 4;
        // A hand-edited index can carry an invented state; it sorts last, never throws.
        default: return 5;
    }
}
/** Milliseconds of an ISO timestamp, or `-Infinity` when it does not parse. */
function timeValue(value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}
/** Descending comparison that is total for the values {@link timeValue} returns. */
function compareDescending(left, right) {
    if (left === right)
        return 0;
    return left > right ? -1 : 1;
}
/**
 * Panel order: `blocked` first, then `awaitingAuthorization`, then the topic states in
 * {@link PANEL_TOPIC_STATUS_ORDER}; inside one rank the most recently active
 * topic leads, then the most recently updated, then the input order. Unknown
 * states sort last and unparseable timestamps never throw. The input array is
 * not mutated.
 */
export function sortTopicsForPanel(topics) {
    return topics
        .map((topic, index) => ({ topic, index }))
        .sort((left, right) => {
        const byRank = topicListRank(left.topic) - topicListRank(right.topic);
        if (byRank !== 0)
            return byRank;
        const byActive = compareDescending(timeValue(left.topic.lastActiveAt), timeValue(right.topic.lastActiveAt));
        if (byActive !== 0)
            return byActive;
        const byUpdated = compareDescending(timeValue(left.topic.updatedAt), timeValue(right.topic.updatedAt));
        if (byUpdated !== 0)
            return byUpdated;
        return left.index - right.index;
    })
        .map(({ topic }) => topic);
}
/**
 * Zero-filled header counts. Topic counts come from `topics` alone; work-item
 * counts only include items whose `topicId` is one of `topics`, so a stray
 * record cannot inflate the chips. Unknown states are ignored, not guessed.
 */
export function countPanel(topics, workItems) {
    const counts = {
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
    };
    const listed = new Set();
    for (const topic of topics) {
        listed.add(topic.topicId);
        if (isPanelTopicStatus(topic.status))
            counts[topic.status] += 1;
        if (topic.blocked)
            counts.blocked += 1;
        if (topic.awaitingAuthorization)
            counts.awaitingAuthorization += 1;
        if (topic.awaitingReview)
            counts.awaitingReview += 1;
        if (topic.reviewStatus === 'pending')
            counts.pendingReview += 1;
    }
    for (const item of workItems) {
        if (!listed.has(item.topicId))
            continue;
        switch (item.status) {
            case 'active':
                counts.workItemActive += 1;
                break;
            case 'reviewing':
                counts.workItemReviewing += 1;
                break;
            case 'merged':
                counts.workItemMerged += 1;
                break;
            case 'abandoned':
                counts.workItemAbandoned += 1;
                break;
            default: break;
        }
    }
    return counts;
}
/** The topic the panel selects on first paint: the first row, or null when empty. */
export function defaultSelectedTopicId(topics) {
    return topics.length === 0 ? null : topics[0].topicId;
}
/**
 * One-line, bounded summary text. Every whitespace run becomes one space and
 * the ends are trimmed; the result is measured in Unicode code points (not
 * UTF-16 units), and an over-long text keeps `limit - 1` code points plus `…`,
 * so the result never exceeds `limit` code points. Non-strings become `''`:
 * the caller passes untrusted JSON, and a summary is never worth a throw.
 */
export function truncateSummary(text, limit = MAX_SUMMARY_CHARS) {
    if (typeof text !== 'string')
        return '';
    const single = text.replace(/\s+/g, ' ').trim();
    const max = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : MAX_SUMMARY_CHARS;
    if (max === 0)
        return '';
    const points = Array.from(single);
    if (points.length <= max)
        return single;
    return `${points.slice(0, max - 1).join('')}…`;
}
//# sourceMappingURL=api-contract.js.map