/**
 * Request-inbox wire contract (topic inbox, 2026-11-10).
 *
 * One leaf module shared by the host routes (`src/panel/inbox-api.ts`), the request
 * record model (`src/domains/requests/request-schema.ts`), the browser fetch layer
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
 * `InboxNotificationItem` (not `PanelInboxItem`): `src/panel/api-contract.ts`
 * already exports `PanelInboxItem` for the legacy master inbox rows carried by
 * the overview response, and the two concepts must not be confused.
 */

import { NOTICE_KINDS, type NoticeKind } from './notice-contract.js'

/** Route paths of the request inbox. */
export const INBOX_PATH = '/api/cowork.inbox'
export const INBOX_RESOLVE_PATH = '/api/cowork.inbox.resolve'
export const INBOX_OPEN_PATH = '/api/cowork.inbox.open'

/** Most items one `GET /api/cowork.inbox` response carries. */
export const INBOX_MAX_ITEMS = 50

/** Most request files one inbox read scans; more files report `truncated`. */
export const INBOX_MAX_REQUEST_FILES = 200

/** Version stamped on every request record file. */
export const REQUEST_RECORD_VERSION = 1

/** Longest request title (the topic title it is attached to). */
export const REQUEST_TITLE_MAX_CHARS = 120

/** Longest request summary the list row carries. */
export const REQUEST_SUMMARY_MAX_CHARS = 500

/** Longest persisted left-hand message ("主题「…」…"). */
export const REQUEST_MESSAGE_MAX_CHARS = 400

/** Longest persisted right-hand user reply. */
export const RESOLUTION_MESSAGE_MAX_CHARS = 200

/** Longest free-text comment (review return findings, plan revise reason). */
export const REQUEST_COMMENT_MAX_CHARS = 2000

/** Largest serialized payload one request record accepts. */
export const REQUEST_PAYLOAD_MAX_BYTES = 8192

/** Longest review purpose / question prompt text. */
export const REVIEW_PURPOSE_MAX_CHARS = 500

/** Most changed paths one user-review request carries. */
export const REVIEW_MAX_CHANGED_PATHS = 50

/** Most verification rows one user-review request carries. */
export const REVIEW_MAX_VERIFICATION = 10

/** Longest changed path and verification command/evidence text. */
export const REVIEW_TEXT_MAX_CHARS = 300

/** Longest authorization command line. */
export const AUTHORIZATION_COMMAND_MAX_CHARS = 300

/** Most questions one request may ask (the card pages through them). */
export const QUESTION_MAX_QUESTIONS = 5

/** Most options one question may offer. */
export const QUESTION_MAX_OPTIONS = 10

/** Longest question prompt. */
export const QUESTION_PROMPT_MAX_CHARS = 500

/** Longest option label and option description. */
export const QUESTION_OPTION_LABEL_MAX_CHARS = 80
export const QUESTION_OPTION_DESCRIPTION_MAX_CHARS = 200

/** Longest free-text answer one question accepts. */
export const QUESTION_TEXT_MAX_CHARS = 500

/** Longest repo-relative plan path and plan title. */
export const PLAN_PATH_MAX_CHARS = 500
export const PLAN_TITLE_MAX_CHARS = 120

/** Largest file `POST /api/cowork.inbox.open` will hand to the desktop opener. */
export const OPEN_FILE_MAX_BYTES = 1_048_576

/** The four request kinds, in the contract's order. */
export const REQUEST_KINDS = ['user-review', 'authorization', 'question', 'plan'] as const

/** One kind of request the inbox carries. */
export type RequestKind = (typeof REQUEST_KINDS)[number]

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
] as const

/** One request lifecycle state. */
export type RequestStatus = (typeof REQUEST_STATUSES)[number]

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
] as const

/** One resolving action. */
export type RequestAction = (typeof REQUEST_ACTIONS)[number]

/** Which actions each kind accepts while pending, in card order. */
export const REQUEST_ACTIONS_BY_KIND: Readonly<Record<RequestKind, readonly RequestAction[]>> = {
  'user-review': ['return', 'pass'],
  authorization: ['deny', 'allow'],
  question: ['skip', 'submit'],
  plan: ['revise', 'approve'],
}

/** The terminal state one action records. */
export const REQUEST_ACTION_STATUS: Readonly<Record<RequestAction, RequestStatus>> = {
  pass: 'passed',
  return: 'returned',
  allow: 'allowed',
  deny: 'denied',
  submit: 'answered',
  skip: 'skipped',
  approve: 'approved',
  revise: 'revise',
}

/** Card title while a request of this kind is pending. */
export const REQUEST_PENDING_LABELS: Readonly<Record<RequestKind, string>> = {
  'user-review': '等待审核',
  authorization: '等待审批',
  question: '问题',
  plan: '计划待审',
}

/** Status text a resolved card keeps. */
export const REQUEST_STATUS_LABELS: Readonly<Record<RequestStatus, string>> = {
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
}

/** The count field inside {@link InboxCounts} one kind contributes to. */
export const REQUEST_COUNT_FIELD: Readonly<Record<RequestKind, keyof InboxCounts>> = {
  'user-review': 'review',
  authorization: 'authorization',
  question: 'question',
  plan: 'plan',
}

/**
 * The notification kinds the inbox note stream carries: the shared notice kinds
 * except `authorization` (it has a request card) plus the automatic reviewer's
 * `review-verdict`, which is a read-only note and never becomes a request.
 */
const INBOX_NOTICE_KINDS = NOTICE_KINDS.filter(
  (kind): kind is Exclude<NoticeKind, 'authorization'> => kind !== 'authorization',
)
export const INBOX_NOTIFICATION_KINDS = [...INBOX_NOTICE_KINDS, 'review-verdict'] as const

/** One read-only notification kind. */
export type InboxNotificationKind = (typeof INBOX_NOTIFICATION_KINDS)[number]

/** One row a user-review request exposes on the card. */
export interface ReviewVerification {
  readonly command: string
  readonly exitCode: number
  readonly evidence: string
}

/** Payload of a `user-review` request. */
export interface ReviewPayload {
  readonly purpose: string
  readonly changedPaths?: readonly string[]
  readonly verification?: readonly ReviewVerification[]
  /** Automatic-review request this user review refers to, when any. */
  readonly reviewRequestId?: string
}

/** Payload of an `authorization` request. */
export interface AuthorizationPayload {
  readonly summary: string
  /** Optional command the authorization is about; shown monospaced. */
  readonly command?: string
}

/** One option of one question. */
export interface QuestionOption {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly recommended?: boolean
}

/** One question; `single` picks one option, `multi` picks any number. */
export interface QuestionSpec {
  readonly id: string
  readonly prompt: string
  readonly mode: 'single' | 'multi'
  readonly options?: readonly QuestionOption[]
  /** Whether the free-text answer input is offered. */
  readonly allowText?: boolean
}

/** Payload of a `question` request. */
export interface QuestionPayload {
  readonly questions: readonly QuestionSpec[]
}

/** Payload of a `plan` request; the path is repo-relative POSIX. */
export interface PlanPayload {
  readonly planPath: string
  readonly planTitle?: string
}

/** Every payload shape a request record may hold. */
export type RequestPayload = ReviewPayload | AuthorizationPayload | QuestionPayload | PlanPayload

/** Delivery state of the wake-up prompt after a request was resolved. */
export interface RequestDelivery {
  /** When the topic session accepted the queue prompt; null when never. */
  readonly promptedAt: string | null
  /** Last prompt failure, kept without rolling the terminal state back. */
  readonly lastError: string | null
}

/**
 * The full resolution payload of one terminal request: the bounded comment and,
 * for a `question` submit, every selected option id and free-text answer.
 *
 * `resolutionMessage` stays the short right-hand reply (≤ 200 characters); this
 * block is the durable fact the topic prompt is rebuilt from, so a long comment
 * or an option label never survives only as a truncated display string.
 */
export interface RequestResolution {
  readonly comment?: string
  readonly answers?: readonly InboxAnswerInput[]
}

/**
 * One request record as persisted at
 * `<repo>/.dsh-cowork/requests/<requestId>.json`. The left message and the
 * right reply are server-generated and persisted here, so a refresh restores
 * the whole thread instead of letting the browser rebuild it.
 */
export interface RequestRecordV1 {
  readonly version: typeof REQUEST_RECORD_VERSION
  readonly requestId: string
  readonly projectId: string
  readonly topicId: string
  readonly kind: RequestKind
  readonly status: RequestStatus
  /** The topic title at creation time. */
  readonly title: string
  readonly summary: string
  readonly requestMessage: string
  readonly resolutionMessage: string | null
  readonly payload: RequestPayload
  readonly createdAt: string
  readonly updatedAt: string
  readonly resolvedAt: string | null
  readonly resolvedBy: 'user' | 'master' | null
  /**
   * Full terminal payload; absent on records written before it existed (still
   * readable, and the prompt falls back to `resolutionMessage`).
   */
  readonly resolution?: RequestResolution
  readonly delivery: RequestDelivery
}

/** One request card with its persisted conversation pair. */
interface InboxRequestItemBase {
  readonly kind: 'request'
  readonly requestId: string
  readonly requestKind: RequestKind
  readonly topicId: string
  readonly topicTitle: string
  readonly status: RequestStatus
  readonly title: string
  readonly summary: string
  readonly requestMessage: string
  /** The right-hand user reply; null until the request is resolved. */
  readonly resolutionMessage: string | null
  /** Actions still offered; empty once the request is terminal. */
  readonly actions: readonly RequestAction[]
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * One request row, discriminated by `requestKind` so `payload` narrows to the
 * kind's own shape. `client/api.ts` is the one wire parser; every other consumer
 * reads `item.payload` directly instead of re-normalising it.
 */
export type InboxRequestItem =
  | (InboxRequestItemBase & { readonly requestKind: 'user-review'; readonly payload: ReviewPayload })
  | (InboxRequestItemBase & { readonly requestKind: 'authorization'; readonly payload: AuthorizationPayload })
  | (InboxRequestItemBase & { readonly requestKind: 'question'; readonly payload: QuestionPayload })
  | (InboxRequestItemBase & { readonly requestKind: 'plan'; readonly payload: PlanPayload })

/** One read-only notification note in the inbox stream. */
export interface InboxNotificationItem {
  readonly kind: 'notification'
  readonly noticeId: string
  readonly noticeKind: InboxNotificationKind
  readonly topicId: string
  readonly topicTitle: string
  readonly summary: string
  readonly createdAt: string
  readonly updatedAt: string
  /** Repo-relative proposal file, when the note is a decision proposal. */
  readonly proposalPath?: string
  /** Whether the open route can reveal a file for this note. */
  readonly canOpen: boolean
}

/** One inbox row: an actionable request thread or a notification note. */
export type InboxItem = InboxRequestItem | InboxNotificationItem

/** The header/banner counts; only pending requests are counted. */
export interface InboxCounts {
  readonly pending: number
  readonly review: number
  readonly authorization: number
  readonly question: number
  readonly plan: number
}

/** Body of a successful `GET /api/cowork.inbox` response. */
export interface InboxResponse {
  readonly ok: true
  readonly items: readonly InboxItem[]
  readonly counts: InboxCounts
  /** True when the request store or the merged wire list was cut at its cap. */
  readonly truncated: boolean
}

/** One free-text or selected-option answer the host validates. */
export interface InboxAnswerInput {
  readonly questionId: string
  readonly selected?: readonly string[]
  readonly text?: string
}

/** Body of a successful `POST /api/cowork.inbox.resolve` response. */
export interface InboxResolveResponse {
  readonly ok: true
  /** The resolved row, already carrying its right-hand reply. */
  readonly item: InboxRequestItem
  /** False when the same action replayed an already-terminal request. */
  readonly changed: boolean
  /** Whether the topic session accepted the wake-up prompt. */
  readonly prompted: boolean
  /** Prompt failure text; the request stays terminal. */
  readonly promptError: string | null
}

/** Body of a successful `POST /api/cowork.inbox.open` response. */
export interface InboxOpenResponse {
  readonly ok: true
  readonly opened: true
}

/**
 * Stable inbox failure codes. They join the shared `PanelErrorCode` union in
 * `src/panel/api-contract.ts`, so every route answers with the one error envelope the
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
] as const

/** One inbox failure code. */
export type InboxErrorCode = (typeof INBOX_ERROR_CODES)[number]

/**
 * HTTP status of every inbox failure code. The shared panel error table spreads
 * this, so a new code cannot ship without its status.
 */
export const INBOX_ERROR_STATUS: Readonly<Record<InboxErrorCode, number>> = {
  'inbox/request-not-found': 404,
  'inbox/request-resolved': 409,
  'inbox/action-not-allowed': 400,
  'inbox/invalid-answer': 400,
  'inbox/invalid-comment': 400,
  'inbox/path-missing': 404,
  'inbox/open-unsupported': 501,
  'inbox/not-member': 403,
}

/** Zero counts for an empty inbox. */
export function emptyInboxCounts(): InboxCounts {
  return { pending: 0, review: 0, authorization: 0, question: 0, plan: 0 }
}

/** Whether a value is one of the four request kinds. */
export function isRequestKind(value: unknown): value is RequestKind {
  return typeof value === 'string' && (REQUEST_KINDS as readonly string[]).includes(value)
}

/** Whether a value is one of the request lifecycle states. */
export function isRequestStatus(value: unknown): value is RequestStatus {
  return typeof value === 'string' && (REQUEST_STATUSES as readonly string[]).includes(value)
}

/** Whether a value is one of the eight resolving actions. */
export function isRequestAction(value: unknown): value is RequestAction {
  return typeof value === 'string' && (REQUEST_ACTIONS as readonly string[]).includes(value)
}

/** Whether a value is one of the notification kinds. */
export function isInboxNotificationKind(value: unknown): value is InboxNotificationKind {
  return typeof value === 'string' && (INBOX_NOTIFICATION_KINDS as readonly string[]).includes(value)
}

/** Actions a kind offers, or an empty list when the kind is not pending. */
export function actionsForKind(kind: RequestKind): readonly RequestAction[] {
  return REQUEST_ACTIONS_BY_KIND[kind]
}

/** Whether `action` is legal for `kind` (kind only, not status). */
export function actionAllowed(kind: RequestKind, action: RequestAction): boolean {
  return REQUEST_ACTIONS_BY_KIND[kind].some((candidate) => candidate === action)
}

/** The terminal status one action records. */
export function statusForAction(action: RequestAction): RequestStatus {
  return REQUEST_ACTION_STATUS[action]
}

/**
 * The action that produced one terminal status, or null for `pending`/`void`.
 * This is what makes a replay idempotent: the same action maps to the same
 * stored status, a different action does not.
 */
export function actionForStatus(status: RequestStatus): RequestAction | null {
  for (const action of REQUEST_ACTIONS) {
    if (REQUEST_ACTION_STATUS[action] === status) return action
  }
  return null
}

/**
 * Whether one answer covers one question, using the one rule the host and the
 * browser share: at least one known selected option (exactly one in `single`
 * mode) or a non-empty free-text answer the question allows. A text on a
 * question with `allowText !== true` does not count, so the card cannot enable
 * a submit the host will refuse.
 */
export function answerCoversQuestion(
  question: QuestionSpec,
  answer: Pick<InboxAnswerInput, 'selected' | 'text'> | undefined,
): boolean {
  if (answer === undefined) return false
  const selected = Array.isArray(answer.selected) ? answer.selected : []
  const text = typeof answer.text === 'string' ? answer.text.trim() : ''
  const textCovers = text !== '' && question.allowText === true
  if (selected.length === 0) return textCovers
  const optionIds = new Set((question.options ?? []).map((option) => option.id))
  if (selected.some((id) => !optionIds.has(id))) return false
  return question.mode === 'multi' || selected.length === 1
}

/** Whether one status is terminal (anything but `pending`). */
export function isTerminalStatus(status: RequestStatus): boolean {
  return status !== 'pending'
}
