/**
 * Pure model for the session notice cards (host A2 contract, decision B here).
 *
 * One notice is one card: the model never merges two events and never renders a
 * digest across events. An update with the same `noticeId` replaces the card in
 * place and stays idempotent, because the host ledger is at-least-once and a
 * renderer re-run must not append a second card.
 *
 * Decisions are recorded (topic-page handoff, 2026-11-10): the running host is
 * DSH 0.2.1-rc.2, which has neither `ctx.sessionNotices` nor a `notice/message`
 * event. The renderer is therefore built but feature-detected and NOT registered
 * (B); the rules below are pinned by `tests/notice-model.test.mjs` so the A2
 * host release only needs the adapter and registration, not new copy.
 *
 * This module stays React-free so `node --test` can load it through type
 * stripping.
 */

/** The five notice kinds the contract defines. */
export const NOTICE_KINDS = ['assignment', 'report', 'proposal', 'authorization', 'archive'] as const

/** One notice kind. */
export type NoticeKind = (typeof NOTICE_KINDS)[number]

/** The four notice states the contract defines. */
export const NOTICE_STATUSES = ['pending', 'allowed', 'denied', 'void'] as const

/** One notice state. */
export type NoticeStatus = (typeof NOTICE_STATUSES)[number]

/** The four actions a notice may carry. */
export const NOTICE_ACTION_TYPES = ['allow', 'deny', 'open-topic', 'open-work-item'] as const

/** One notice action. */
export type NoticeActionType = (typeof NOTICE_ACTION_TYPES)[number]

/** Whether the card is rendered in the master session or in the topic session. */
export type NoticeAudience = 'master' | 'topic'

/** Chinese labels for the five kinds. */
export const NOTICE_KIND_LABELS: Record<NoticeKind, string> = {
  assignment: '分配',
  report: '上报',
  proposal: '决策提案',
  authorization: '待授权',
  archive: '归档',
}

/** Chinese labels for the four states. */
export const NOTICE_STATUS_LABELS: Record<NoticeStatus, string> = {
  pending: '待处理',
  allowed: '已允许',
  denied: '已拒绝',
  void: '已失效',
}

/** Chinese labels for the four actions. */
export const NOTICE_ACTION_LABELS: Record<NoticeActionType, string> = {
  allow: '允许',
  deny: '拒绝',
  'open-topic': '去主题会话处理',
  'open-work-item': '去工作项查看',
}

/** Action tones; the label always carries the meaning on its own. */
export const NOTICE_ACTION_TONES: Record<NoticeActionType, 'success' | 'error' | 'neutral'> = {
  allow: 'success',
  deny: 'error',
  'open-topic': 'neutral',
  'open-work-item': 'neutral',
}

/** Titles are bounded before they reach a card; the full text stays in the event. */
export const NOTICE_TITLE_MAX_CHARS = 120

/** Summaries are bounded too: a session card is not a transcript. */
export const NOTICE_SUMMARY_MAX_CHARS = 200

/** The client seat a host with A2 exposes for conversation nodes. */
export const NOTICE_SEAT = 'conversation.chat.node'

/** The node kind this plugin would register once A2 exists. */
export const NOTICE_NODE_KIND = 'notice'

/** One action as the wire sends it: a bare type or a type with a target. */
export type NoticeActionInput =
  | NoticeActionType
  | {
      readonly type: NoticeActionType
      readonly target?: string | null
    }

/** One notice as the wire sends it (fields beyond the contract are ignored). */
export interface NoticeInput {
  readonly noticeId: string
  readonly pluginId?: string
  readonly topicId: string
  readonly kind: NoticeKind
  readonly title: string
  readonly summary?: string
  readonly status: NoticeStatus
  readonly actions?: readonly NoticeActionInput[]
  readonly createdAt?: string
  readonly updatedAt?: string
}

/** Where a card is rendered and which targets the host can actually open. */
export interface NoticeContext {
  readonly audience: NoticeAudience
  /** The work-item page is not implemented yet, so its action stays hidden. */
  readonly workItemPageAvailable?: boolean
  /** Latest known work item of the notice, when the event carried one. */
  readonly workItemId?: string | null
}

/** One visible action of a card. `disabled` is carried for the renderer. */
export interface NoticeActionView {
  readonly type: NoticeActionType
  readonly label: string
  readonly tone: 'success' | 'error' | 'neutral'
  readonly target: string | null
  readonly disabled: boolean
}

/** One card: exactly one notice, plus the copy and actions it may show. */
export interface NoticeCardView {
  readonly noticeId: string
  readonly kind: NoticeKind
  readonly kindLabel: string
  readonly title: string
  readonly summary: string
  readonly status: NoticeStatus
  readonly statusLabel: string
  readonly audience: NoticeAudience
  readonly actions: readonly NoticeActionView[]
}

/** Whether a value is one of the contract's notice kinds. */
export function isNoticeKind(value: unknown): value is NoticeKind {
  return NOTICE_KINDS.some(kind => kind === value)
}

/** Whether a value is one of the contract's notice states. */
export function isNoticeStatus(value: unknown): value is NoticeStatus {
  return NOTICE_STATUSES.some(status => status === value)
}

/** Whether a value is one of the contract's action types. */
export function isNoticeActionType(value: unknown): value is NoticeActionType {
  return NOTICE_ACTION_TYPES.some(type => type === value)
}

/** Cut `text` to `maxChars`, marking the cut with an ellipsis. */
function bound(text: string, maxChars: number): string {
  const trimmed = text.trim()
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, Math.max(1, maxChars - 1))}…`
}

/** Label of one kind; an invented kind (already filtered) stays readable. */
export function noticeKindLabel(kind: NoticeKind): string {
  return NOTICE_KIND_LABELS[kind] ?? String(kind)
}

/** Label of one state; an invented state (already filtered) stays readable. */
export function noticeStatusLabel(status: NoticeStatus): string {
  return NOTICE_STATUS_LABELS[status] ?? String(status)
}

/** Label of one action type. */
export function noticeActionLabel(type: NoticeActionType): string {
  return NOTICE_ACTION_LABELS[type] ?? String(type)
}

/** Normalize the wire actions into type + target pairs, dropping unknown types. */
export function noticeActionInputs(notice: NoticeInput): { type: NoticeActionType; target: string | null }[] {
  const raw = notice.actions ?? []
  const actions: { type: NoticeActionType; target: string | null }[] = []
  for (const entry of raw) {
    if (typeof entry === 'string') {
      if (isNoticeActionType(entry)) actions.push({ type: entry, target: null })
      continue
    }
    if (!isRecord(entry)) continue
    if (!isNoticeActionType(entry.type)) continue
    const target = typeof entry.target === 'string' && entry.target.trim() !== '' ? entry.target.trim() : null
    actions.push({ type: entry.type, target })
  }
  return actions
}

/** Whether a value is a plain JSON object (arrays and null are not). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a notice is visible in this audience. An archive notice only exists
 * in the master session (the design records no archive card in the topic).
 */
export function isNoticeVisible(notice: NoticeInput, audience: NoticeAudience): boolean {
  if (notice.kind === 'archive') return audience === 'master'
  return true
}

/**
 * The actions one notice may show. The wire names the actions; the model only
 * removes what the audience cannot do or what has no target:
 *
 * - assignment / report: read-only, no actions.
 * - proposal: `open-work-item`, only when the work-item page exists and the
 *   notice names a target.
 * - authorization: master gets `open-topic`, the topic gets `allow`/`deny`;
 *   only while pending.
 * - archive: no actions, master only.
 *
 * An open action without a target is hidden instead of rendering a dead button.
 */
export function noticeActions(notice: NoticeInput, context: NoticeContext): NoticeActionView[] {
  if (notice.kind === 'assignment' || notice.kind === 'report' || notice.kind === 'archive') return []
  const requested = noticeActionInputs(notice)
  const views: NoticeActionView[] = []
  for (const action of requested) {
    if (notice.kind === 'proposal') {
      if (action.type !== 'open-work-item') continue
      if (context.workItemPageAvailable !== true) continue
      const target = action.target ?? context.workItemId ?? null
      if (target === null || target.trim() === '') continue
      views.push(actionView(action.type, target, false))
      continue
    }
    // Authorization.
    if (notice.status !== 'pending') continue
    if (context.audience === 'master') {
      if (action.type !== 'open-topic') continue
      const target = notice.topicId.trim()
      if (target === '') continue
      views.push(actionView(action.type, target, false))
      continue
    }
    if (action.type !== 'allow' && action.type !== 'deny') continue
    views.push(actionView(action.type, null, false))
  }
  return views
}

/** Build one action view from its type and resolved target. */
function actionView(type: NoticeActionType, target: string | null, disabled: boolean): NoticeActionView {
  return {
    type,
    label: noticeActionLabel(type),
    tone: NOTICE_ACTION_TONES[type],
    target,
    disabled,
  }
}

/**
 * Project one notice into a card, or null when the notice is invisible in this
 * audience or carries a kind/status this build does not know. The card is a
 * value: the same input always produces the same card (update idempotence).
 */
export function noticeCard(notice: NoticeInput, context: NoticeContext): NoticeCardView | null {
  if (typeof notice.noticeId !== 'string' || notice.noticeId.trim() === '') return null
  if (!isNoticeKind(notice.kind) || !isNoticeStatus(notice.status)) return null
  if (!isNoticeVisible(notice, context.audience)) return null
  const title = bound(typeof notice.title === 'string' ? notice.title : '', NOTICE_TITLE_MAX_CHARS)
  return {
    noticeId: notice.noticeId,
    kind: notice.kind,
    kindLabel: noticeKindLabel(notice.kind),
    title: title.length === 0 ? noticeKindLabel(notice.kind) : title,
    summary: bound(typeof notice.summary === 'string' ? notice.summary : '', NOTICE_SUMMARY_MAX_CHARS),
    status: notice.status,
    statusLabel: noticeStatusLabel(notice.status),
    audience: context.audience,
    actions: noticeActions(notice, context),
  }
}

/**
 * Build the card list for one render pass. Duplicate `noticeId`s keep their
 * first position and the last state wins (the ledger replays updates), so one
 * notice never produces two cards.
 */
export function buildNoticeCards(
  notices: readonly NoticeInput[],
  context: NoticeContext,
): NoticeCardView[] {
  const byId = new Map<string, NoticeCardView>()
  for (const notice of notices) {
    const card = noticeCard(notice, context)
    if (card === null) continue
    byId.set(card.noticeId, card)
  }
  return [...byId.values()]
}

/**
 * Apply one notice update to an already rendered list: the same `noticeId`
 * replaces the card in place, a new id is appended, an invisible notice removes
 * its card. Applying the same update twice yields an equal list.
 */
export function upsertNoticeCard(
  cards: readonly NoticeCardView[],
  notice: NoticeInput,
  context: NoticeContext,
): NoticeCardView[] {
  const card = noticeCard(notice, context)
  const index = cards.findIndex(entry => entry.noticeId === notice.noticeId)
  if (card === null) {
    return index < 0 ? [...cards] : cards.filter(entry => entry.noticeId !== notice.noticeId)
  }
  if (index < 0) return [...cards, card]
  const next = cards.slice()
  next[index] = card
  return next
}

/** B feature-detect: only a host that exposes session notices can render cards. */
export function canRegisterNoticeRenderer(input: { readonly sessionNotices?: unknown }): boolean {
  return input.sessionNotices !== undefined
}
