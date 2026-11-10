/**
 * Pure presentation logic for the Cowork topic page (topic-page v2).
 *
 * Everything here is a plain function over values: the four-group view model,
 * marker and action rules, time formatting, menu placement, error mapping and
 * action receipts. The React components consume it and
 * `tests/panel-model.test.mjs` pins it without rendering anything, so this
 * module must stay React-free (no JSX, no `react` import) to stay loadable by
 * `node --test` through type stripping.
 *
 * The topic page is a list only: blocked / running / idle / resolved, two-line
 * cards, one state action per card. Review state, work items, decision records
 * and the list/detail split are gone by design; nothing here can bring them
 * back.
 */
import type { PanelInboxItem, PanelTopic, PanelTopicStatus } from '../api-contract.ts'
import type { PanelErrorInfo } from './contracts.ts'

/** How often relative timestamps are recomputed while the panel is open. */
export const CLOCK_TICK_MS = 60_000

/** Characters kept when the header shortens the project path. */
export const PROJECT_PATH_MAX_CHARS = 44

/** Characters kept when a receipt names a topic id. */
export const TOPIC_ID_MAX_CHARS = 8

/** How long an action receipt stays on screen. */
export const FEEDBACK_TTL_MS = 5000

/** Characters kept in the inbox chip's tooltip (the joined summaries). */
export const INBOX_TITLE_MAX_CHARS = 160

/** Most inbox summaries the tooltip joins; the count chip still shows them all. */
export const INBOX_TITLE_SUMMARIES = 5

/** The four groups, in the order the page renders them. */
export const TOPIC_GROUP_ORDER = ['blocked', 'running', 'idle', 'resolved'] as const

/** One group key; the order is fixed by {@link TOPIC_GROUP_ORDER}. */
export type TopicGroupKey = (typeof TOPIC_GROUP_ORDER)[number]

/** Chinese group titles. */
export const TOPIC_GROUP_LABELS: Record<TopicGroupKey, string> = {
  blocked: '阻塞',
  running: '运行中',
  idle: '空闲',
  resolved: '已解决',
}

/** Empty-group copy is not rendered; the count is always visible on the title. */
export function topicGroupLabel(key: TopicGroupKey): string {
  return TOPIC_GROUP_LABELS[key] ?? key
}

/** The only two markers a card may carry. */
export type TopicMarkerKind = 'authorization' | 'waiting-master'

/** Visible copy of each marker; the text carries the meaning, never color alone. */
export const TOPIC_MARKER_LABELS: Record<TopicMarkerKind, string> = {
  authorization: '待授权',
  'waiting-master': '等待主会话',
}

/** Label of one marker; an invented marker stays visible instead of vanishing. */
export function topicMarkerLabel(marker: TopicMarkerKind): string {
  return TOPIC_MARKER_LABELS[marker] ?? String(marker)
}

/** Blocked reasons the host may send; the page itself never derives them. */
export type BlockedReason = 'authorization' | 'handoff' | 'conflict'

/**
 * What a topic row must carry for the page. The two authorization fields are
 * optional on purpose: the backend contract adds them, and a host that has not
 * shipped them yet must degrade to "no marker, no needs-you entry" rather than
 * guessing from `awaitingReview`.
 */
export interface TopicCardSource
  extends Pick<PanelTopic, 'topicId' | 'title' | 'status' | 'digest' | 'updatedAt'> {
  readonly blocked?: boolean
  readonly awaitingAuthorization?: boolean
  readonly blockedReason?: BlockedReason | string | null
  readonly lastActiveAt?: string
}

/** The minimal overview shape `buildTopicViewModel` reads. */
export interface TopicViewModelInput {
  readonly topics: readonly TopicCardSource[]
}

/** One card: exactly what a two-line card renders, nothing else. */
export interface TopicCardView {
  readonly topicId: string
  readonly title: string
  readonly digest: string
  readonly updatedAt: string
  readonly marker: TopicMarkerKind | null
  readonly canArchive: boolean
  readonly canRestore: boolean
}

/** One group: fixed key, count and its cards (newest first). */
export interface TopicGroupView {
  readonly key: TopicGroupKey
  readonly label: string
  readonly count: number
  readonly cards: readonly TopicCardView[]
  /** The resolved group starts folded; the other three never fold. */
  readonly collapsedByDefault: boolean
}

/** The "需要你处理" entry: a count and the session it opens. */
export interface NeedsYouView {
  readonly count: number
  readonly topicId: string | null
}

/** The whole topic page, derived once per overview read. */
export interface TopicViewModel {
  readonly groups: readonly TopicGroupView[]
  readonly needsYou: NeedsYouView
  readonly total: number
}

/**
 * Group rule: resolved first; otherwise blocked (an authorization request also
 * blocks, even if the derived `blocked` flag lags); otherwise idle; otherwise
 * running. A new status value reads as running instead of disappearing.
 */
function groupOf(topic: TopicCardSource): TopicGroupKey {
  if (topic.status === 'resolved') return 'resolved'
  if (topic.blocked === true || topic.awaitingAuthorization === true) return 'blocked'
  if (topic.status === 'idle') return 'idle'
  return 'running'
}

/**
 * Marker rule: an authorization request is the marker; otherwise a blocked
 * topic whose host named a non-authorization reason is waiting for the master.
 * Without `awaitingAuthorization` there is no authorization marker, and
 * `awaitingReview` is never consulted.
 */
function markerOf(topic: TopicCardSource): TopicMarkerKind | null {
  if (topic.status === 'resolved') return null
  if (topic.awaitingAuthorization === true) return 'authorization'
  if (topic.blocked !== true) return null
  const reason = topic.blockedReason
  if (typeof reason !== 'string' || reason.trim() === '') return null
  // A reason that says authorization while the boolean is missing is a
  // half-written row: show nothing rather than the wrong marker.
  return reason === 'authorization' ? null : 'waiting-master'
}

/** Project one source topic into its card. */
function cardOf(topic: TopicCardSource): TopicCardView {
  const resolved = topic.status === 'resolved'
  return {
    topicId: topic.topicId,
    title: topic.title,
    digest: topic.digest,
    updatedAt: topic.updatedAt,
    marker: markerOf(topic),
    canArchive: !resolved,
    canRestore: resolved,
  }
}

/** Sort two cards newest first; equal or invalid stamps fall back to the id. */
function compareCards(left: TopicCardView, right: TopicCardView): number {
  const leftMs = Date.parse(left.updatedAt)
  const rightMs = Date.parse(right.updatedAt)
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) {
    return rightMs - leftMs
  }
  return left.topicId.localeCompare(right.topicId)
}

/**
 * Build the four-group view model. Groups always come out in
 * {@link TOPIC_GROUP_ORDER} with their counts (zero included); cards inside a
 * group are newest first, ties broken by topic id so the order is stable.
 * `needsYou` counts only `awaitingAuthorization` topics and points at the first
 * one in the blocked group.
 */
export function buildTopicViewModel(overview: TopicViewModelInput): TopicViewModel {
  const buckets: Record<TopicGroupKey, TopicCardView[]> = {
    blocked: [],
    running: [],
    idle: [],
    resolved: [],
  }
  for (const topic of overview.topics) {
    buckets[groupOf(topic)].push(cardOf(topic))
  }
  const groups: TopicGroupView[] = TOPIC_GROUP_ORDER.map((key) => {
    const cards = buckets[key].sort(compareCards)
    return {
      key,
      label: topicGroupLabel(key),
      count: cards.length,
      cards,
      collapsedByDefault: key === 'resolved',
    }
  })
  const blocked = buckets.blocked
  const authorizationCards = blocked.filter(card => card.marker === 'authorization')
  return {
    groups,
    needsYou: {
      count: authorizationCards.length,
      topicId: authorizationCards[0]?.topicId ?? null,
    },
    total: overview.topics.length,
  }
}

/** The panel surface state; loading, empty, error and the list are separate. */
export type PanelSurfaceState = 'loading' | 'error' | 'empty' | 'default'

/**
 * Decide the surface state. A failed load wins over an empty list; a project
 * that is not initialized (or has no topics yet) is the empty state; anything
 * else renders the topic list.
 */
export function surfaceState(input: {
  readonly loading: boolean
  readonly error: PanelErrorInfo | null
  readonly topicCount: number
}): PanelSurfaceState {
  if (input.loading) return 'loading'
  if (input.error !== null) return input.error.code === 'project/not-initialized' ? 'empty' : 'error'
  return input.topicCount === 0 ? 'empty' : 'default'
}

/** Shorten `text` in the middle, keeping both ends readable. */
export function middleEllipsis(text: string, maxChars: number): string {
  const budget = Math.max(3, Math.floor(maxChars))
  if (text.length <= budget) return text
  const head = Math.ceil((budget - 1) / 2)
  const tail = budget - 1 - head
  if (tail <= 0) return `${text.slice(0, budget - 1)}…`
  return `${text.slice(0, head)}…${text.slice(-tail)}`
}

/** Short topic id used in receipts (topic ids are session ids). */
export function shortTopicId(topicId: string): string {
  return topicId.length <= TOPIC_ID_MAX_CHARS ? topicId : topicId.slice(0, TOPIC_ID_MAX_CHARS)
}

/** What the panel renders for an error or an empty project. */
export interface NoticePresentation {
  readonly kind: 'empty' | 'error'
  readonly title: string
  readonly detail: string
  readonly code: string | null
  readonly path: string | null
  readonly retry: boolean
  readonly hint: string | null
}

/** One small header hint: how many inbox items are still waiting. */
export interface InboxNotice {
  readonly count: number
  readonly label: string
  readonly title: string
}

/**
 * Header hint for the undelivered inbox items (the wire already filters and
 * bounds them). No items means no hint; the tooltip joins the first five
 * summaries.
 */
export function inboxNotice(inbox: readonly PanelInboxItem[]): InboxNotice | null {
  if (inbox.length === 0) return null
  const summaries = inbox
    .slice(0, INBOX_TITLE_SUMMARIES)
    .map(item => item.summary.trim())
    .filter(summary => summary.length > 0)
  const joined = summaries.join(' · ')
  return {
    count: inbox.length,
    label: `待处理 ${inbox.length}`,
    title: joined.length === 0 ? '有未投递的收件箱条目' : middleEllipsis(joined, INBOX_TITLE_MAX_CHARS),
  }
}

/** Copy for a project without topics yet (as opposed to not initialized). */
export function emptyNotice(): NoticePresentation {
  return {
    kind: 'empty',
    title: '这个项目还没有主题',
    detail: '',
    code: null,
    path: null,
    retry: false,
    hint: null,
  }
}

/**
 * Map a host error to a panel notice. `project/not-initialized` is an empty
 * state naming the init command; `topic/not-found` is an empty state because the
 * topic is simply gone; the write-route refusals explain themselves without
 * offering a retry that cannot help; `store/corrupt` keeps its code and path;
 * everything else is a generic retryable error.
 */
export function errorPresentation(error: PanelErrorInfo | null): NoticePresentation {
  if (error === null) {
    return {
      kind: 'error',
      title: '读取 Cowork 项目失败',
      detail: '没有拿到错误详情，请重试。',
      code: null,
      path: null,
      retry: true,
      hint: null,
    }
  }
  if (error.code === 'project/not-initialized') {
    return {
      kind: 'empty',
      title: '这个仓库还没有 Cowork 项目',
      detail: '在 cowork-master 会话中调用 cowork_project_init 初始化当前仓库，然后刷新面板。',
      code: error.code,
      path: error.path ?? null,
      retry: false,
      hint: 'cowork_project_init',
    }
  }
  if (error.code === 'topic/not-found') {
    return {
      kind: 'empty',
      title: '这个主题不在项目索引里',
      detail: '它可能已被移出或索引已重建；刷新后会重新读取。',
      code: error.code,
      path: error.path ?? null,
      retry: true,
      hint: null,
    }
  }
  if (error.code === 'store/corrupt') {
    return {
      kind: 'error',
      title: '项目记录已损坏',
      detail: error.message,
      code: error.code,
      path: error.path ?? null,
      retry: true,
      hint: null,
    }
  }
  if (error.code === 'request/not-master') {
    return {
      kind: 'error',
      title: '只有主会话可以操作主题',
      detail: '请在 cowork-master 会话中操作，或让主会话代你执行。',
      code: error.code,
      path: error.path ?? null,
      retry: false,
      hint: null,
    }
  }
  if (error.code === 'request/origin') {
    return {
      kind: 'error',
      title: '请求来源不被接受',
      detail: '面板请求必须与宿主同源；请从 Cowork 面板内操作，或刷新后重试。',
      code: error.code,
      path: error.path ?? null,
      retry: false,
      hint: null,
    }
  }
  return {
    kind: 'error',
    title: '读取 Cowork 项目失败',
    detail: error.message,
    code: error.code,
    path: error.path ?? null,
    retry: true,
    hint: null,
  }
}

/** One visible action receipt (open / archive / restore). */
export interface ActionFeedback {
  readonly kind: 'ok' | 'failed'
  readonly text: string
}

/** The single copy used whenever the host refuses a write to a non-master. */
export const NOT_MASTER_MESSAGE = '只有主会话可以操作'

/** Action labels; the card menu shows exactly one of them. */
export const TOPIC_ACTION_LABELS = {
  archive: '归档',
  restore: '恢复',
} as const

/** The one action a card offers, derived from its own state. */
export type TopicCardAction = keyof typeof TOPIC_ACTION_LABELS

/** The current action of a card (archive for open, restore for resolved). */
export function topicCardAction(card: TopicCardView): TopicCardAction {
  return card.canRestore ? 'restore' : 'archive'
}

/** Receipt after archiving a topic; the receipt names the topic, not its id. */
export function archiveSuccessMessage(title: string): string {
  return `已归档「${title}」，可在已解决中恢复`
}

/** Receipt after restoring a topic. */
export function restoreSuccessMessage(title: string): string {
  return `已恢复「${title}」`
}

/** Receipt for a failed write; the master-only refusal gets the fixed copy. */
export function writeFailureMessage(actionLabel: string, error: PanelErrorInfo | null): string {
  if (error !== null && error.code === 'request/not-master') return NOT_MASTER_MESSAGE
  const reason = error === null ? '' : error.message.trim()
  const suffix = reason.length === 0 ? '' : `（${reason}）`
  return `${actionLabel}失败${suffix}`
}

/** Receipt shown when the workspace service is unavailable. */
export function openSessionUnavailableMessage(): string {
  return '当前宿主没有提供会话导航服务，无法打开主题。'
}

/** Receipt after asking the host to show a topic's Conversation. */
export function openSessionMessage(topicId: string): string {
  return `已切换到主题 ${shortTopicId(topicId)}`
}

/** Receipt after the host refused the navigation. */
export function openSessionFailureMessage(reason: string): string {
  const suffix = reason.trim().length === 0 ? '' : `（${reason.trim()}）`
  return `打开主题失败${suffix}`
}

/** The steps of opening a topic, in order (unarchive is only a tolerance). */
export function openTopicSteps(): readonly ('unarchive' | 'open')[] {
  return ['unarchive', 'open']
}

/** Breadcrumb copy: the control always returns to the master session. */
export function masterBreadcrumbLabel(): string {
  return '返回 master'
}

/** Inputs that decide whether this session can navigate back to a master. */
export interface MasterBreadcrumbInput {
  readonly currentSessionId: string
  readonly masterSessionId: string
  readonly topics: readonly Pick<PanelTopic, 'topicId'>[]
}

/**
 * The master session a topic should return to, or null when the breadcrumb is
 * meaningless. Only a topic session gets the control: a master (or any session
 * that is not in the topic index) is already where it belongs, and a stale
 * `masterSessionId` must not send the user to an unrelated old session.
 */
export function masterBreadcrumbTarget(input: MasterBreadcrumbInput): string | null {
  const currentIsTopic = input.topics.some(topic => topic.topicId === input.currentSessionId)
  if (!currentIsTopic) return null
  const target = input.masterSessionId.trim()
  return target.length > 0 && target !== input.currentSessionId ? target : null
}

/** Two-digit zero padding for timestamp formatting. */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** Local `YYYY-MM-DD HH:mm` timestamp (the `title` behind a relative time). */
export function formatLocalTimestamp(iso: string): string {
  const date = new Date(iso)
  const time = date.getTime()
  if (!Number.isFinite(time)) return '时间未知'
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/**
 * Relative time used on the card's second line. Anything older than a week
 * falls back to the absolute local timestamp, which stays readable without a
 * tooltip.
 */
export function formatRelativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return '时间未知'
  const delta = Math.max(0, nowMs - then)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (delta < minute) return '刚刚'
  if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`
  if (delta < day) return `${Math.floor(delta / hour)} 小时前`
  if (delta < 7 * day) return `${Math.floor(delta / day)} 天前`
  return formatLocalTimestamp(iso)
}

/** Geometry of the card's ⋯ button, in viewport coordinates. */
export interface MenuAnchorRect {
  readonly top: number
  readonly bottom: number
  readonly right: number
}

/** Viewport size used to keep the menu on screen. */
export interface ViewportSize {
  readonly width: number
  readonly height: number
}

/** Where the fixed-position card menu is painted. */
export interface MenuPlacement {
  readonly top: number
  readonly left: number
  readonly flipped: boolean
}

/** One-row menu: width, height and the gap below the ⋯ button. */
export const CARD_MENU_WIDTH = 104
export const CARD_MENU_HEIGHT = 36
export const CARD_MENU_GAP = 4
export const VIEWPORT_MARGIN = 8

/**
 * Place the card menu in viewport coordinates. A menu opened near the bottom of
 * the window flips above its button instead of being clipped; the horizontal
 * edge is clamped so a 378px sidebar keeps the menu visible.
 */
export function placeCardMenu(anchor: MenuAnchorRect, viewport: ViewportSize): MenuPlacement {
  const below = anchor.bottom + CARD_MENU_GAP
  const flipped = below + CARD_MENU_HEIGHT > viewport.height - VIEWPORT_MARGIN
  const top = flipped
    ? Math.max(VIEWPORT_MARGIN, anchor.top - CARD_MENU_GAP - CARD_MENU_HEIGHT)
    : below
  const rightAligned = anchor.right - CARD_MENU_WIDTH
  const maxLeft = viewport.width - CARD_MENU_WIDTH - VIEWPORT_MARGIN
  const left = Math.max(VIEWPORT_MARGIN, Math.min(rightAligned, maxLeft))
  return { top, left, flipped }
}

/** Topic status values the page understands, in contract order. */
export const TOPIC_STATUS_VALUES: readonly PanelTopicStatus[] = ['active', 'idle', 'resolved']
