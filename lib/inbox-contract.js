/**
 * Request-inbox wire contract (topic inbox, 2026-11-10).
 *
 * One leaf module shared by the host routes (`src/inbox-api.ts`), the request
 * record model (`src/request-schema.ts`), the browser fetch layer
 * (`src/client/api.ts`) and the browser view model
 * (`src/client/inbox-model.ts`). It carries names, caps and pure guards — no
 * I/O, no clock, and only the pure `notice-contract` dependency — so the two
 * halves of the feature can be written against one frozen vocabulary.
 *
 * The four request kinds are the ones the design fixes:
 * `user-review`, `authorization`, `question`, `plan`. A "user-review" is the
 * user's review request; the automatic reviewer's `review-verdict` stays a
 * read-only notification note and never becomes a request here.
 *
 * The wire item type is deliberately named `InboxRequestItem` /
 * `InboxNotificationItem` (not `PanelInboxItem`): `src/api-contract.ts`
 * already exports `PanelInboxItem` for the legacy master inbox rows carried by
 * the overview response, and the two concepts must not be confused.
 */
import { NOTICE_KINDS } from './notice-contract.js';
/** Route paths of the request inbox. */
export const INBOX_PATH = '/api/cowork.inbox';
export const INBOX_RESOLVE_PATH = '/api/cowork.inbox.resolve';
export const INBOX_OPEN_PATH = '/api/cowork.inbox.open';
/** Most items one `GET /api/cowork.inbox` response carries. */
export const INBOX_MAX_ITEMS = 50;
/** Most request files one inbox read scans; more files report `truncated`. */
export const INBOX_MAX_REQUEST_FILES = 200;
/** Version stamped on every request record file. */
export const REQUEST_RECORD_VERSION = 1;
/** Longest request title (the topic title it is attached to). */
export const REQUEST_TITLE_MAX_CHARS = 120;
/** Longest request summary the list row carries. */
export const REQUEST_SUMMARY_MAX_CHARS = 500;
/** Longest persisted left-hand message ("主题「…」…"). */
export const REQUEST_MESSAGE_MAX_CHARS = 400;
/** Longest persisted right-hand user reply. */
export const RESOLUTION_MESSAGE_MAX_CHARS = 200;
/** Longest free-text comment (review return findings, plan revise reason). */
export const REQUEST_COMMENT_MAX_CHARS = 2000;
/** Largest serialized payload one request record accepts. */
export const REQUEST_PAYLOAD_MAX_BYTES = 8192;
/** Longest review purpose / question prompt text. */
export const REVIEW_PURPOSE_MAX_CHARS = 500;
/** Most changed paths one user-review request carries. */
export const REVIEW_MAX_CHANGED_PATHS = 50;
/** Most verification rows one user-review request carries. */
export const REVIEW_MAX_VERIFICATION = 10;
/** Longest changed path and verification command/evidence text. */
export const REVIEW_TEXT_MAX_CHARS = 300;
/** Longest authorization command line. */
export const AUTHORIZATION_COMMAND_MAX_CHARS = 300;
/** Most questions one request may ask (the card pages through them). */
export const QUESTION_MAX_QUESTIONS = 5;
/** Most options one question may offer. */
export const QUESTION_MAX_OPTIONS = 10;
/** Longest question prompt. */
export const QUESTION_PROMPT_MAX_CHARS = 500;
/** Longest option label and option description. */
export const QUESTION_OPTION_LABEL_MAX_CHARS = 80;
export const QUESTION_OPTION_DESCRIPTION_MAX_CHARS = 200;
/** Longest free-text answer one question accepts. */
export const QUESTION_TEXT_MAX_CHARS = 500;
/** Longest repo-relative plan path and plan title. */
export const PLAN_PATH_MAX_CHARS = 500;
export const PLAN_TITLE_MAX_CHARS = 120;
/** Largest file `POST /api/cowork.inbox.open` will hand to the desktop opener. */
export const OPEN_FILE_MAX_BYTES = 1_048_576;
/** The four request kinds, in the contract's order. */
export const REQUEST_KINDS = ['user-review', 'authorization', 'question', 'plan'];
/**
 * Every lifecycle state a request record can hold. `pending` is the only
 * actionable state; the rest are terminal. `void` is written when the topic is
 * archived while the request was pending.
 */
export const REQUEST_STATUSES = [
    'pending',
    'passed',
    'returned',
    'allowed',
    'denied',
    'answered',
    'skipped',
    'approved',
    'revise',
    'void',
];
/** The eight resolving actions a user can take. */
export const REQUEST_ACTIONS = [
    'pass',
    'return',
    'allow',
    'deny',
    'submit',
    'skip',
    'approve',
    'revise',
];
/** Which actions each kind accepts while pending, in card order. */
export const REQUEST_ACTIONS_BY_KIND = {
    'user-review': ['return', 'pass'],
    authorization: ['deny', 'allow'],
    question: ['skip', 'submit'],
    plan: ['revise', 'approve'],
};
/** The terminal state one action records. */
export const REQUEST_ACTION_STATUS = {
    pass: 'passed',
    return: 'returned',
    allow: 'allowed',
    deny: 'denied',
    submit: 'answered',
    skip: 'skipped',
    approve: 'approved',
    revise: 'revise',
};
/** Card title while a request of this kind is pending. */
export const REQUEST_PENDING_LABELS = {
    'user-review': '等待审核',
    authorization: '等待审批',
    question: '问题',
    plan: '计划待审',
};
/** Status text a resolved card keeps. */
export const REQUEST_STATUS_LABELS = {
    pending: '等待处理',
    passed: '已通过',
    returned: '已退回',
    allowed: '已允许',
    denied: '已拒绝',
    answered: '已回答',
    skipped: '已跳过',
    approved: '已同意',
    revise: '已要求修改',
    void: '已作废',
};
/** The count field inside {@link InboxCounts} one kind contributes to. */
export const REQUEST_COUNT_FIELD = {
    'user-review': 'review',
    authorization: 'authorization',
    question: 'question',
    plan: 'plan',
};
/**
 * The notification kinds the inbox note stream carries: the shared notice kinds
 * except `authorization` (it has a request card) plus the automatic reviewer's
 * `review-verdict`, which is a read-only note and never becomes a request.
 */
const INBOX_NOTICE_KINDS = NOTICE_KINDS.filter((kind) => kind !== 'authorization');
export const INBOX_NOTIFICATION_KINDS = [...INBOX_NOTICE_KINDS, 'review-verdict'];
/**
 * Stable inbox failure codes. They join the shared `PanelErrorCode` union in
 * `src/api-contract.ts`, so every route answers with the one error envelope the
 * panel already understands.
 */
export const INBOX_ERROR_CODES = [
    'inbox/request-not-found',
    'inbox/request-resolved',
    'inbox/action-not-allowed',
    'inbox/invalid-answer',
    'inbox/invalid-comment',
    'inbox/path-missing',
    'inbox/open-unsupported',
    'inbox/not-member',
];
/**
 * HTTP status of every inbox failure code. The shared panel error table spreads
 * this, so a new code cannot ship without its status.
 */
export const INBOX_ERROR_STATUS = {
    'inbox/request-not-found': 404,
    'inbox/request-resolved': 409,
    'inbox/action-not-allowed': 400,
    'inbox/invalid-answer': 400,
    'inbox/invalid-comment': 400,
    'inbox/path-missing': 404,
    'inbox/open-unsupported': 501,
    'inbox/not-member': 403,
};
/** Zero counts for an empty inbox. */
export function emptyInboxCounts() {
    return { pending: 0, review: 0, authorization: 0, question: 0, plan: 0 };
}
/** Whether a value is one of the four request kinds. */
export function isRequestKind(value) {
    return typeof value === 'string' && REQUEST_KINDS.includes(value);
}
/** Whether a value is one of the request lifecycle states. */
export function isRequestStatus(value) {
    return typeof value === 'string' && REQUEST_STATUSES.includes(value);
}
/** Whether a value is one of the eight resolving actions. */
export function isRequestAction(value) {
    return typeof value === 'string' && REQUEST_ACTIONS.includes(value);
}
/** Whether a value is one of the notification kinds. */
export function isInboxNotificationKind(value) {
    return typeof value === 'string' && INBOX_NOTIFICATION_KINDS.includes(value);
}
/** Actions a kind offers, or an empty list when the kind is not pending. */
export function actionsForKind(kind) {
    return REQUEST_ACTIONS_BY_KIND[kind];
}
/** Whether `action` is legal for `kind` (kind only, not status). */
export function actionAllowed(kind, action) {
    return REQUEST_ACTIONS_BY_KIND[kind].some((candidate) => candidate === action);
}
/** The terminal status one action records. */
export function statusForAction(action) {
    return REQUEST_ACTION_STATUS[action];
}
/**
 * The action that produced one terminal status, or null for `pending`/`void`.
 * This is what makes a replay idempotent: the same action maps to the same
 * stored status, a different action does not.
 */
export function actionForStatus(status) {
    for (const action of REQUEST_ACTIONS) {
        if (REQUEST_ACTION_STATUS[action] === status)
            return action;
    }
    return null;
}
/**
 * Whether one answer covers one question, using the one rule the host and the
 * browser share: at least one known selected option (exactly one in `single`
 * mode) or a non-empty free-text answer the question allows. A text on a
 * question with `allowText !== true` does not count, so the card cannot enable
 * a submit the host will refuse.
 */
export function answerCoversQuestion(question, answer) {
    if (answer === undefined)
        return false;
    const selected = Array.isArray(answer.selected) ? answer.selected : [];
    const text = typeof answer.text === 'string' ? answer.text.trim() : '';
    const textCovers = text !== '' && question.allowText === true;
    if (selected.length === 0)
        return textCovers;
    const optionIds = new Set((question.options ?? []).map((option) => option.id));
    if (selected.some((id) => !optionIds.has(id)))
        return false;
    return question.mode === 'multi' || selected.length === 1;
}
/** Whether one status is terminal (anything but `pending`). */
export function isTerminalStatus(status) {
    return status !== 'pending';
}
//# sourceMappingURL=inbox-contract.js.map