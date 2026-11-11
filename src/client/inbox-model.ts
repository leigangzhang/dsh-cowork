/**
 * Pure view model for the Cowork request inbox (topic inbox, 2026-11-10).
 *
 * Everything here is a plain function over values: it merges the request and
 * notification rows one `GET /api/cowork.inbox` returns, sorts them, applies
 * the topic filter, derives the narrow-panel banner copy and projects each row
 * into its card view (status text, action availability, conversation pair).
 * The React components consume it and `tests/inbox-model.test.mjs` pins it
 * without rendering anything, so this module must stay React-free (no JSX, no
 * `react` import) to stay loadable by `node --test` through type stripping.
 *
 * The frozen vocabulary (`REQUEST_KINDS`, statuses, actions, labels) lives in
 * `src/inbox-contract.ts`; this module only reads it. One request is one
 * thread: the persisted left message, the card, then — only after the request
 * is resolved with a non-empty reply — the right-hand user message.
 */
import {
  REQUEST_ACTIONS_BY_KIND,
  REQUEST_COUNT_FIELD,
  REQUEST_PENDING_LABELS,
  REQUEST_STATUS_LABELS,
  isRequestAction,
  type AuthorizationPayload,
  type InboxCounts,
  type InboxItem,
  type InboxNotificationItem,
  type InboxNotificationKind,
  type InboxRequestItem,
  type PlanPayload,
  type QuestionPayload,
  type QuestionSpec,
  type RequestAction,
  type RequestKind,
  type RequestPayload,
  type RequestStatus,
  type ReviewPayload,
  type ReviewVerification,
} from '../inbox-contract.ts'
import { formatRelativeTime } from './model.ts'

/** The panel is wide once its own content width reaches this many CSS pixels. */
export const WIDE_PANEL_MIN_PX = 620

/** Below the wide threshold, this is the narrowest the inbox column may get. */
export const INBOX_COLUMN_MIN_PX = 280

/** Width of the fixed topic column inside the wide two-column layout. */
export const TOPIC_COLUMN_WIDTH_PX = 318

/** Gap between the topic column and the inbox column. */
export const INBOX_COLUMN_GAP_PX = 12

/** Header title of the inbox column. */
export const INBOX_TITLE = '收件箱'

/** Filter chip copy when no topic filter is active. */
export const INBOX_ALL_TOPICS_LABEL = '全部类型'

/** Placeholder topic name for a row whose topic left the index. */
export const INBOX_ARCHIVED_TOPIC_LABEL = '已归档主题'

/** Empty-state copy; an empty inbox is not an error. */
export const INBOX_EMPTY_LABEL = '收件箱为空'

/** Copy shown while the inbox is still loading. */
export const INBOX_LOADING_LABEL = '正在读取收件箱…'

/** Copy of the narrow-panel entry into the full-width inbox. */
export function inboxNeedsYouTitle(count: number): string {
  return `需要你处理 ${count} 项`
}

/** Labels of the pending-request breakdown, in the fixed banner order. */
export const NEEDS_YOU_DETAIL_LABELS = {
  authorization: '待授权',
  review: '待审核',
  question: '待回答',
  plan: '待确认',
} as const

/** Narrow-panel breakdown order: authorization, review, question, plan. */
export const NEEDS_YOU_DETAIL_ORDER = ['authorization', 'review', 'question', 'plan'] as const

/** One count field the breakdown reads. */
export type NeedsYouDetailField = (typeof NEEDS_YOU_DETAIL_ORDER)[number]

/** Visible labels of the eight resolving actions, in card order per kind. */
export const REQUEST_ACTION_LABELS: Readonly<Record<RequestAction, string>> = {
  pass: '通过',
  return: '退回',
  allow: '允许一次',
  deny: '拒绝',
  submit: '提交',
  skip: '跳过',
  approve: '同意执行',
  revise: '要求修改',
}

/** Visible labels of the notification note kinds. */
export const INBOX_NOTE_LABELS: Readonly<Record<InboxNotificationKind, string>> = {
  assignment: '分配',
  report: '上报',
  proposal: '提案',
  'review-verdict': '自动评审',
  archive: '归档',
}

/** The minimal topic shape the filter title reads. */
export interface InboxTopicRef {
  readonly topicId: string
  readonly title?: string
}

/** The wire body `buildInboxViewModel` reads (already runtime-checked). */
export interface InboxViewModelInput {
  readonly inbox: {
    readonly items: readonly InboxItem[]
    readonly counts: InboxCounts
    readonly truncated?: boolean
  }
  readonly topics?: readonly InboxTopicRef[]
  readonly selectedTopicId?: string | null
  readonly nowMs?: number
}

/** One request thread: persisted left message, card, optional right reply. */
interface InboxRequestViewBase {
  readonly kind: 'request'
  readonly requestId: string
  readonly topicId: string
  readonly topicTitle: string
  readonly status: RequestStatus
  readonly pending: boolean
  /** Pending card title (`等待审核` …) or the terminal status label. */
  readonly statusText: string
  readonly title: string
  readonly summary: string
  readonly requestMessage: string
  /** The right-hand reply, only when persisted and non-empty. */
  readonly resolutionMessage: string | null
  readonly showsResolution: boolean
  /** Actions still offered; empty for every terminal request and `void`. */
  readonly actions: readonly RequestAction[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly timeLabel: string
}

/** One request view, discriminated by kind so a card narrows its payload. */
export type InboxRequestView =
  | (InboxRequestViewBase & { readonly requestKind: 'user-review'; readonly payload: ReviewPayload })
  | (InboxRequestViewBase & { readonly requestKind: 'authorization'; readonly payload: AuthorizationPayload })
  | (InboxRequestViewBase & { readonly requestKind: 'question'; readonly payload: QuestionPayload })
  | (InboxRequestViewBase & { readonly requestKind: 'plan'; readonly payload: PlanPayload })

/** One read-only notification note. */
export interface InboxNoteView {
  readonly kind: 'notification'
  readonly noticeId: string
  readonly noticeKind: InboxNotificationKind
  readonly topicId: string
  readonly topicTitle: string
  readonly summary: string
  readonly noteLabel: string
  readonly proposalPath: string | null
  readonly canOpen: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly timeLabel: string
}

/** One inbox row as the components render it. */
export type InboxItemView = InboxRequestView | InboxNoteView

/** The narrow-panel banner: pending count plus its non-zero breakdown. */
export interface InboxNeedsYouView {
  readonly count: number
  readonly detail: string
}

/** The whole inbox, derived once per wire read (or per resolve replacement). */
export interface InboxViewModel {
  /** Sorted and topic-filtered rows. */
  readonly items: readonly InboxItemView[]
  /** Server counts; only pending requests are counted. */
  readonly counts: InboxCounts
  readonly selectedTopicId: string | null
  /** Title of the selected topic, or null when the filter is off. */
  readonly filterTopicTitle: string | null
  /** Rows under the current filter (the number next to the title). */
  readonly titleCount: number
  /** Rows before the filter (the `全部类型` number). */
  readonly totalCount: number
  readonly needsYou: InboxNeedsYouView
  readonly empty: boolean
  readonly truncated: boolean
}

/** The part of an inbox snapshot a resolve replaces. */
export interface InboxSnapshot {
  readonly items: readonly InboxItem[]
  readonly counts: InboxCounts
}

/** One untrusted JSON object, or an empty record. */
function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** A string from untrusted input, or ''. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** A non-empty string from untrusted input, or null. */
function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** A string array from untrusted input; non-string members are dropped. */
function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/** One verification row from untrusted input, or null. */
function verificationOf(value: unknown): ReviewVerification | null {
  const raw = recordOf(value)
  const command = textOf(raw.command)
  if (command.trim() === '') return null
  return {
    command,
    exitCode: typeof raw.exitCode === 'number' && Number.isFinite(raw.exitCode) ? Math.trunc(raw.exitCode) : 0,
    evidence: textOf(raw.evidence),
  }
}

/** Normalize a user-review payload; missing fields degrade to empty values. */
function reviewPayloadOf(value: RequestPayload | unknown): ReviewPayload {
  const raw = recordOf(value)
  return {
    purpose: textOf(raw.purpose),
    changedPaths: textArray(raw.changedPaths),
    verification: Array.isArray(raw.verification)
      ? raw.verification.map(verificationOf).filter((row): row is ReviewVerification => row !== null)
      : [],
    reviewRequestId: nonEmpty(raw.reviewRequestId) ?? undefined,
  }
}

/** Normalize an authorization payload. */
function authorizationPayloadOf(value: RequestPayload | unknown): AuthorizationPayload {
  const raw = recordOf(value)
  const command = nonEmpty(raw.command)
  return command === null
    ? { summary: textOf(raw.summary) }
    : { summary: textOf(raw.summary), command }
}

/** One normalized option; the card renders its label and description. */
interface NormalizedQuestionOption {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly recommended: boolean
}

/** Normalize one option; a missing id drops the option. */
function questionOptionOf(value: unknown): NormalizedQuestionOption | null {
  const raw = recordOf(value)
  const id = nonEmpty(raw.id)
  if (id === null) return null
  const description = nonEmpty(raw.description)
  return description === null
    ? { id, label: textOf(raw.label), recommended: raw.recommended === true }
    : { id, label: textOf(raw.label), description, recommended: raw.recommended === true }
}

/** Normalize one question; a missing id drops the question. */
function questionOf(value: unknown): QuestionSpec | null {
  const raw = recordOf(value)
  const id = nonEmpty(raw.id)
  if (id === null) return null
  const options = Array.isArray(raw.options)
    ? raw.options.map(questionOptionOf).filter((option): option is NormalizedQuestionOption => option !== null)
    : undefined
  return {
    id,
    prompt: textOf(raw.prompt),
    mode: raw.mode === 'multi' ? 'multi' : 'single',
    options,
    allowText: raw.allowText === true,
  }
}

/** Normalize a question payload; a missing list reads as no questions. */
function questionPayloadOf(value: RequestPayload | unknown): QuestionPayload {
  const raw = recordOf(value)
  return {
    questions: Array.isArray(raw.questions)
      ? raw.questions.map(questionOf).filter((question): question is QuestionSpec => question !== null)
      : [],
  }
}

/** One question answer as the card holds it before it becomes a wire payload. */
export interface InboxAnswerDraft {
  readonly selected: readonly string[]
  readonly text: string
}

/**
 * Whether one answer covers one question, using the host's own rule
 * (`src/request-schema.ts` `answerProblems`): at least one known selected
 * option (exactly one in `single` mode) or a non-empty free-text answer the
 * question allows. A text on a question with `allowText !== true` does not
 * count, so the card cannot enable a submit the host will refuse.
 */
export function answerCoversQuestion(
  question: QuestionSpec,
  answer: InboxAnswerDraft | undefined,
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

/** How many questions still need an answer; zero enables the submit action. */
export function unansweredQuestionCount(
  questions: readonly QuestionSpec[],
  answers: Readonly<Record<string, InboxAnswerDraft>>,
): number {
  let missing = 0
  for (const question of questions) {
    if (!answerCoversQuestion(question, answers[question.id])) missing += 1
  }
  return missing
}

/** Whether every question is answered — the submit gate of the question card. */
export function answersComplete(
  questions: readonly QuestionSpec[],
  answers: Readonly<Record<string, InboxAnswerDraft>>,
): boolean {
  return questions.length > 0 && unansweredQuestionCount(questions, answers) === 0
}

/** Visible hint while the submit action is blocked. */
export function unansweredAnswerHint(count: number): string {
  return count === 1 ? '还有 1 题未回答' : `还有 ${count} 题未回答`
}

/** Normalize a plan payload. */
function planPayloadOf(value: RequestPayload | unknown): PlanPayload {
  const raw = recordOf(value)
  const planTitle = nonEmpty(raw.planTitle)
  return planTitle === null
    ? { planPath: textOf(raw.planPath) }
    : { planPath: textOf(raw.planPath), planTitle }
}

/** The actions a pending request still offers, in the contract's card order. */
function availableActions(item: InboxRequestItem): readonly RequestAction[] {
  if (item.status !== 'pending') return []
  const legal = REQUEST_ACTIONS_BY_KIND[item.requestKind]
  const offered = Array.isArray(item.actions)
    ? item.actions.filter((action): action is RequestAction => isRequestAction(action) && legal.includes(action))
    : []
  // A pending card with no legal action would be dead UI; fall back to the
  // contract's own list instead of rendering a request the user cannot answer.
  return offered.length === 0 ? legal : legal.filter(action => offered.includes(action))
}

/** The visible status text: pending copy while open, terminal copy after. */
function statusTextOf(item: InboxRequestItem): string {
  if (item.status === 'pending') return REQUEST_PENDING_LABELS[item.requestKind]
  return REQUEST_STATUS_LABELS[item.status]
}

/** Project one wire request into its thread view. */
function requestViewOf(item: InboxRequestItem, nowMs: number): InboxRequestView {
  const resolutionMessage = nonEmpty(item.resolutionMessage)
  const base: InboxRequestViewBase = {
    kind: 'request',
    requestId: item.requestId,
    topicId: item.topicId,
    topicTitle: nonEmpty(item.topicTitle) ?? INBOX_ARCHIVED_TOPIC_LABEL,
    status: item.status,
    pending: item.status === 'pending',
    statusText: statusTextOf(item),
    title: textOf(item.title),
    summary: textOf(item.summary),
    requestMessage: textOf(item.requestMessage),
    resolutionMessage,
    showsResolution: resolutionMessage !== null,
    actions: availableActions(item),
    createdAt: textOf(item.createdAt),
    updatedAt: textOf(item.updatedAt),
    timeLabel: formatRelativeTime(item.updatedAt, nowMs),
  }
  switch (item.requestKind) {
    case 'user-review':
      return { ...base, requestKind: 'user-review', payload: reviewPayloadOf(item.payload) }
    case 'authorization':
      return { ...base, requestKind: 'authorization', payload: authorizationPayloadOf(item.payload) }
    case 'question':
      return { ...base, requestKind: 'question', payload: questionPayloadOf(item.payload) }
    case 'plan':
      return { ...base, requestKind: 'plan', payload: planPayloadOf(item.payload) }
  }
}

/** Project one wire notification into its note view. */
function noteViewOf(item: InboxNotificationItem, nowMs: number): InboxNoteView {
  const proposalPath = nonEmpty(item.proposalPath)
  // The automatic reviewer's verdict is a read-only note: never a link, never
  // an action, even if a host sends `canOpen: true` for it.
  const canOpen = item.noticeKind !== 'review-verdict' && item.canOpen === true
  return {
    kind: 'notification',
    noticeId: item.noticeId,
    noticeKind: item.noticeKind,
    topicId: textOf(item.topicId),
    topicTitle: nonEmpty(item.topicTitle) ?? INBOX_ARCHIVED_TOPIC_LABEL,
    summary: textOf(item.summary),
    noteLabel: INBOX_NOTE_LABELS[item.noticeKind] ?? item.noticeKind,
    proposalPath,
    canOpen,
    createdAt: textOf(item.createdAt),
    updatedAt: textOf(item.updatedAt),
    timeLabel: formatRelativeTime(item.updatedAt, nowMs),
  }
}

/** Stable identity of one view row, used for the sort tie-break. */
function viewIdOf(item: InboxItemView): string {
  return item.kind === 'request' ? `request:${item.requestId}` : `notification:${item.noticeId}`
}

/** Parse a timestamp; invalid stamps sort as the oldest row. */
function timestampOf(item: InboxItemView): number | null {
  const parsed = Date.parse(item.updatedAt)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Inbox order: pending requests first (newest `updatedAt` first), then every
 * other row — resolved requests and notifications mixed — newest first. Ties
 * fall back to the row id so the order never depends on scan order.
 */
function compareItems(left: InboxItemView, right: InboxItemView): number {
  const leftPending = left.kind === 'request' && left.pending
  const rightPending = right.kind === 'request' && right.pending
  if (leftPending !== rightPending) return leftPending ? -1 : 1
  const leftTime = timestampOf(left)
  const rightTime = timestampOf(right)
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return rightTime - leftTime
  if (leftTime !== null && rightTime === null) return -1
  if (leftTime === null && rightTime !== null) return 1
  return viewIdOf(left).localeCompare(viewIdOf(right))
}

/** Non-zero pending counts as banner copy, in the fixed order. */
function needsYouDetailOf(counts: InboxCounts): string {
  return NEEDS_YOU_DETAIL_ORDER
    .filter(field => counts[field] > 0)
    .map(field => `${NEEDS_YOU_DETAIL_LABELS[field]} ${counts[field]}`)
    .join(' · ')
}

/** The selected topic's display title, degrading to the row or a placeholder. */
function filterTitleOf(
  selectedTopicId: string,
  topics: readonly InboxTopicRef[],
  items: readonly InboxItemView[],
): string {
  const known = topics.find(topic => topic.topicId === selectedTopicId)
  const fromTopic = known === undefined ? null : nonEmpty(known.title)
  if (fromTopic !== null) return fromTopic
  const fromRow = items.find(item => item.topicId === selectedTopicId)
  const rowTitle = fromRow === undefined ? null : nonEmpty(fromRow.topicTitle)
  return rowTitle ?? INBOX_ARCHIVED_TOPIC_LABEL
}

/**
 * Build the inbox view. Rows are sorted before filtering, so switching the
 * filter never reorders the stream; the filter only drops rows of other
 * topics. `counts` stay the server's counts (they also cover rows past the
 * 50-item cap), while `titleCount` is the visible row count under the filter.
 */
export function buildInboxViewModel(input: InboxViewModelInput): InboxViewModel {
  const nowMs = input.nowMs ?? Date.now()
  const selectedTopicId = input.selectedTopicId ?? null
  const allItems = input.inbox.items
    .map(item => item.kind === 'request' ? requestViewOf(item, nowMs) : noteViewOf(item, nowMs))
    .sort(compareItems)
  const items = selectedTopicId === null
    ? allItems
    : allItems.filter(item => item.topicId === selectedTopicId)
  const topics = input.topics ?? []
  return {
    items,
    counts: input.inbox.counts,
    selectedTopicId,
    filterTopicTitle: selectedTopicId === null ? null : filterTitleOf(selectedTopicId, topics, items),
    titleCount: items.length,
    totalCount: allItems.length,
    needsYou: {
      count: input.inbox.counts.pending,
      detail: needsYouDetailOf(input.inbox.counts),
    },
    empty: items.length === 0,
    truncated: input.inbox.truncated === true,
  }
}

/** The narrow-panel banner copy for a view (title + non-zero breakdown). */
export function needsYouBanner(view: InboxViewModel): { readonly title: string; readonly detail: string } {
  return {
    title: inboxNeedsYouTitle(view.needsYou.count),
    detail: view.needsYou.detail,
  }
}

/** Decrement the pending and per-kind counts after one request is resolved. */
function countResolvedRequest(counts: InboxCounts, kind: RequestKind): InboxCounts {
  const field = REQUEST_COUNT_FIELD[kind]
  return {
    pending: Math.max(0, counts.pending - 1),
    review: field === 'review' ? Math.max(0, counts.review - 1) : counts.review,
    authorization: field === 'authorization' ? Math.max(0, counts.authorization - 1) : counts.authorization,
    question: field === 'question' ? Math.max(0, counts.question - 1) : counts.question,
    plan: field === 'plan' ? Math.max(0, counts.plan - 1) : counts.plan,
  }
}

/**
 * Replace one resolved request in place and move the counts along. The server
 * response is authoritative for the row; only a request that was pending
 * before and is terminal now touches the counts.
 */
export function applyInboxItemUpdate(snapshot: InboxSnapshot, next: InboxRequestItem): InboxSnapshot {
  const previous = snapshot.items.find(
    (item): item is InboxRequestItem => item.kind === 'request' && item.requestId === next.requestId,
  )
  const items = snapshot.items.map(item =>
    item.kind === 'request' && item.requestId === next.requestId ? next : item,
  )
  const counts = previous !== undefined && previous.status === 'pending' && next.status !== 'pending'
    ? countResolvedRequest(snapshot.counts, previous.requestKind)
    : snapshot.counts
  return { items, counts }
}
