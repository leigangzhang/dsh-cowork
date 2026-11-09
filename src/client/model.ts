/**
 * Pure presentation logic for the Cowork panel (wire v2).
 *
 * Everything here is a plain function over values: layout selection, status and
 * review copy, header chips, action availability, time formatting, error
 * mapping and action receipts. The React components consume it and
 * `tests/panel-model.test.mjs` pins it without rendering anything, so this
 * module must stay React-free (no JSX, no `react` import) to stay loadable by
 * `node --test` through type stripping.
 */
import type {
  PanelCounts,
  PanelInboxItem,
  PanelReviewSeverity,
  PanelReviewStatus,
  PanelTopic,
  PanelTopicStatus,
  PanelWorkItemStatus,
} from '../api-contract.ts'
import type { PanelErrorInfo } from './contracts.ts'

/** Layout switch: above this measured width the panel splits into two columns. */
export const SPLIT_WIDTH_THRESHOLD = 480

/** Width of the topic list column in split mode. */
export const LIST_COLUMN_WIDTH = 248

/** Topics above this count make the list scroll (the long-list state). */
export const LONG_LIST_THRESHOLD = 12

/** Titles above this length are visually truncated (the long-title state). */
export const LONG_SUBJECT_THRESHOLD = 48

/** Characters kept when the header shortens the project path. */
export const PROJECT_PATH_MAX_CHARS = 44

/** Characters kept when the detail header shows a topic id. */
export const TOPIC_ID_MAX_CHARS = 8

/** How long an action receipt stays on screen. */
export const FEEDBACK_TTL_MS = 5000

/** Characters kept in the inbox chip's tooltip (the joined summaries). */
export const INBOX_TITLE_MAX_CHARS = 160

/** Most inbox summaries the tooltip joins; the count chip still shows them all. */
export const INBOX_TITLE_SUMMARIES = 5

/** Layout mode chosen from the measured container width. */
export type LayoutMode = 'split' | 'drill'

/**
 * Pick the layout from the width measured on the panel container (not the
 * viewport): above {@link SPLIT_WIDTH_THRESHOLD} the list and the detail sit
 * side by side, at or below it the panel becomes a single-column drill-down.
 * An unmeasured width stays in drill mode.
 */
export function chooseLayout(measuredWidth: number | null | undefined): LayoutMode {
  if (typeof measuredWidth !== 'number' || !Number.isFinite(measuredWidth)) return 'drill'
  return measuredWidth > SPLIT_WIDTH_THRESHOLD ? 'split' : 'drill'
}

/** The panel surface state; the three list/detail states are separate flags. */
export type PanelSurfaceState = 'loading' | 'error' | 'empty' | 'default'

/**
 * Decide the surface state. A failed load wins over an empty list; a project
 * that is not initialized (or has no topics yet) is the empty state; anything
 * else renders the list/detail surface.
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

/** Whether the list needs its own scroll area (the long-list state). */
export function isLongList(topicCount: number): boolean {
  return topicCount > LONG_LIST_THRESHOLD
}

/** Whether one row's title needs truncation (the long-title state). */
export function isLongSubject(title: string): boolean {
  return title.length > LONG_SUBJECT_THRESHOLD
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

/** Short topic id shown in the detail header (topic ids are session ids). */
export function shortTopicId(topicId: string): string {
  return topicId.length <= TOPIC_ID_MAX_CHARS ? topicId : topicId.slice(0, TOPIC_ID_MAX_CHARS)
}

/** Short commit for the work-item table; an absent head/base reads as a dash. */
export function shortCommit(commit: string | null): string {
  if (commit === null || commit.length === 0) return '—'
  return commit.length <= 7 ? commit : commit.slice(0, 7)
}

/** Status dot tones, resolved to public theme tokens in `styles.ts`. */
export type StatusTone = 'success' | 'warn' | 'error' | 'idle'

/** Chinese labels for the three topic states; resolved topics stay listed. */
export const TOPIC_STATUS_LABELS: Record<PanelTopicStatus, string> = {
  active: '进行中',
  idle: '空闲',
  resolved: '已解决',
}

/** Label of one topic state; an invented state stays visible instead of vanishing. */
export function statusLabel(status: PanelTopicStatus): string {
  return TOPIC_STATUS_LABELS[status] ?? String(status)
}

/** One tone per topic state; the visible label always accompanies the dot. */
export const TOPIC_STATUS_TONES: Record<PanelTopicStatus, StatusTone> = {
  active: 'success',
  idle: 'idle',
  resolved: 'success',
}

/** Tone of one topic state; unknown values fall back to the neutral dot. */
export function statusTone(status: PanelTopicStatus): StatusTone {
  return TOPIC_STATUS_TONES[status] ?? 'idle'
}

/** Who resolved a topic; `master` covers the automated resolution. */
export const RESOLVED_BY_LABELS: Record<'user' | 'master', string> = {
  user: '用户',
  master: '自动',
}

/** Label of one resolution source; an invented source stays visible. */
export function resolvedByLabel(resolvedBy: 'user' | 'master'): string {
  return RESOLVED_BY_LABELS[resolvedBy] ?? String(resolvedBy)
}

/** Chinese labels for the four review states; the badge always shows one. */
export const REVIEW_STATUS_LABELS: Record<PanelReviewStatus, string> = {
  pending: '审查中',
  pass: '审查通过',
  needs_revision: '需修改',
  reject: '已拒绝',
}

/** Label of one review state; unknown values stay visible instead of vanishing. */
export function reviewStatusLabel(status: PanelReviewStatus): string {
  return REVIEW_STATUS_LABELS[status] ?? String(status)
}

/** Review badge tones: only a pass reads as success. */
export const REVIEW_STATUS_TONES: Record<PanelReviewStatus, StatusTone> = {
  pending: 'warn',
  pass: 'success',
  needs_revision: 'warn',
  reject: 'error',
}

/** Tone of one review state; unknown values fall back to the neutral dot. */
export function reviewStatusTone(status: PanelReviewStatus): StatusTone {
  return REVIEW_STATUS_TONES[status] ?? 'idle'
}

/** Chinese labels for finding severities, most serious first. */
export const FINDING_SEVERITY_LABELS: Record<PanelReviewSeverity, string> = {
  blocker: '阻断',
  high: '高',
  medium: '中',
  low: '低',
}

/** Label of one finding severity; the text always accompanies the tone. */
export function findingSeverityLabel(severity: PanelReviewSeverity): string {
  return FINDING_SEVERITY_LABELS[severity] ?? String(severity)
}

/** Finding tones: blockers and highs are errors, mediums warnings, lows neutral. */
export const FINDING_SEVERITY_TONES: Record<PanelReviewSeverity, StatusTone> = {
  blocker: 'error',
  high: 'error',
  medium: 'warn',
  low: 'idle',
}

/** Tone of one finding severity; unknown values fall back to neutral. */
export function findingSeverityTone(severity: PanelReviewSeverity): StatusTone {
  return FINDING_SEVERITY_TONES[severity] ?? 'idle'
}

/** Chinese labels for the four work-item states. */
export const WORK_ITEM_STATUS_LABELS: Record<PanelWorkItemStatus, string> = {
  active: '进行中',
  reviewing: '审查中',
  merged: '已合并',
  abandoned: '已放弃',
}

/** Label of one work-item state; an invented state stays visible. */
export function workItemStatusLabel(status: PanelWorkItemStatus): string {
  return WORK_ITEM_STATUS_LABELS[status] ?? String(status)
}

/** Work-item tones: only a merged unit reads as finished-success. */
export const WORK_ITEM_STATUS_TONES: Record<PanelWorkItemStatus, StatusTone> = {
  active: 'success',
  reviewing: 'warn',
  merged: 'idle',
  abandoned: 'error',
}

/** Tone of one work-item state; unknown values fall back to neutral. */
export function workItemStatusTone(status: PanelWorkItemStatus): StatusTone {
  return WORK_ITEM_STATUS_TONES[status] ?? 'idle'
}

/**
 * Tooltip of a review badge: the state, the absolute review time when there is
 * one, and the finding count when the review carries findings. The visible
 * badge text stays short; the title carries the detail.
 */
export function reviewBadgeTitle(
  status: PanelReviewStatus,
  reviewedAt: string | null,
  findingCount = 0,
): string {
  const parts = [reviewStatusLabel(status)]
  if (reviewedAt !== null && reviewedAt.trim() !== '') parts.push(formatLocalTimestamp(reviewedAt))
  if (findingCount > 0) parts.push(`${findingCount} 条 finding`)
  return parts.join(' · ')
}

/** Count fields the header chips render, in their fixed order. */
export type StatusChipKey = 'active' | 'idle' | 'resolved' | 'blocked' | 'awaitingReview'

/** One header chip: count field, label, tone and current count. */
export interface StatusChip {
  readonly key: StatusChipKey
  readonly label: string
  readonly tone: StatusTone
  readonly count: number
}

/** Chip order and copy: topic states first, then the two markers. */
const STATUS_CHIP_DEFINITIONS: readonly {
  readonly key: StatusChipKey
  readonly label: string
  readonly tone: StatusTone
}[] = [
  { key: 'active', label: '进行中', tone: 'success' },
  { key: 'idle', label: '空闲', tone: 'idle' },
  { key: 'resolved', label: '已解决', tone: 'success' },
  { key: 'blocked', label: '受阻', tone: 'error' },
  { key: 'awaitingReview', label: '待评审', tone: 'warn' },
]

/** Build the header chips from the overview counts, zero-filled. */
export function statusChips(counts: PanelCounts): StatusChip[] {
  return STATUS_CHIP_DEFINITIONS.map(chip => ({
    key: chip.key,
    label: chip.label,
    tone: chip.tone,
    count: counts[chip.key] ?? 0,
  }))
}

/** One marker chip (blocked / awaiting review) shown on a topic row. */
export interface TopicMarker {
  readonly label: string
  readonly tone: StatusTone
}

/** One topic row's presentation: state, markers, review badge and summary. */
export interface TopicRowPresentation {
  readonly statusLabel: string
  readonly statusTone: StatusTone
  readonly markers: readonly TopicMarker[]
  readonly reviewLabel: string | null
  readonly reviewTone: StatusTone | null
  readonly reviewTitle: string | null
  readonly digest: string
  readonly resolvedByLabel: string | null
  readonly hasActiveWork: boolean
}

/**
 * Project one topic into what the list row shows. The markers are derived from
 * the two wire flags (they outrank the state chip), and a resolved topic keeps
 * its resolution source so the row can say who closed it.
 */
export function topicRow(topic: PanelTopic): TopicRowPresentation {
  const markers: TopicMarker[] = []
  if (topic.blocked) markers.push({ label: '受阻', tone: 'error' })
  if (topic.awaitingReview) markers.push({ label: '待评审', tone: 'warn' })
  const reviewStatus = topic.reviewStatus
  return {
    statusLabel: statusLabel(topic.status),
    statusTone: statusTone(topic.status),
    markers,
    reviewLabel: reviewStatus === null ? null : reviewStatusLabel(reviewStatus),
    reviewTone: reviewStatus === null ? null : reviewStatusTone(reviewStatus),
    reviewTitle: reviewStatus === null ? null : reviewBadgeTitle(reviewStatus, null),
    digest: topic.digest,
    resolvedByLabel: topic.resolvedBy === null ? null : resolvedByLabel(topic.resolvedBy),
    hasActiveWork: topic.activeWorkItems > 0,
  }
}

/** Which topic actions the detail offers, and the warning the resolve card shows. */
export interface TopicActions {
  readonly canResolve: boolean
  readonly canReopen: boolean
  readonly canMove: boolean
  readonly resolveWarning: string | null
}

/**
 * Action availability: a resolved topic can only be reopened; an open one can be
 * resolved and have its routing moved. Resolving while work items still run is
 * allowed but warns, because it cannot be undone from the panel.
 */
export function topicActions(topic: PanelTopic): TopicActions {
  const resolved = topic.status === 'resolved'
  return {
    canResolve: !resolved,
    canReopen: resolved,
    canMove: !resolved,
    resolveWarning: topic.activeWorkItems > 0
      ? `该主题仍有 ${topic.activeWorkItems} 个工作项在跑；标记已解决后不可撤销`
      : null,
  }
}

/** Other open topics a route may be moved to, in the order the overview gave. */
export function moveTargets(topics: readonly PanelTopic[], currentTopicId: string): PanelTopic[] {
  return topics.filter(topic => topic.topicId !== currentTopicId && topic.status !== 'resolved')
}

/** Prefill for the move intent: the topic digest, or its title when empty. */
export function moveIntentPrefill(topic: PanelTopic): string {
  return topic.digest.trim().length > 0 ? topic.digest : topic.title
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
 * summaries, so the user can see why the master is needed without a new panel.
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
 * topic is simply gone; the two write-route refusals explain themselves without
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
      title: '只有 master 会话可以修改主题',
      detail: '请在 cowork-master 会话中操作，或让 master 代你执行。',
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

/** Receipt after copying a path to the clipboard. */
export function copySuccessMessage(): string {
  return '已复制项目路径'
}

/** Receipt after a failed clipboard write; never silent. */
export function copyFailureMessage(reason: string): string {
  const suffix = reason.trim().length === 0 ? '' : `（${reason.trim()}）`
  return `复制失败：请在浏览器允许剪贴板权限后重试${suffix}`
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

/** Receipt after the host marked a topic resolved. */
export function resolveSuccessMessage(topicId: string): string {
  return `已把主题 ${shortTopicId(topicId)} 标记为已解决`
}

/** Receipt after the host reopened a resolved topic. */
export function reopenSuccessMessage(topicId: string): string {
  return `已重新打开主题 ${shortTopicId(topicId)}`
}

/** Receipt after a route move; an unchanged move says so instead of claiming success. */
export function moveSuccessMessage(input: {
  readonly changed: boolean
  readonly addedCount: number
}): string {
  if (!input.changed) return '目标主题已经包含这条路由，没有改动'
  return `已移动到目标主题，新增 ${input.addedCount} 个别名`
}

/** Receipt for a failed write action: names the action and the host's reason. */
export function actionFailureMessage(label: string, reason: string): string {
  const suffix = reason.trim().length === 0 ? '' : `（${reason.trim()}）`
  return `${label}失败${suffix}`
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
 * Relative time used in the list and the detail header. Anything older than a
 * week falls back to the absolute local timestamp, which stays readable
 * without a tooltip.
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

/** Exit-code label on a verification row. */
export function verificationExitLabel(exitCode: number): string {
  return `exit ${exitCode}`
}

/** Tone of a verification row: only a clean exit reads as success. */
export function verificationTone(exitCode: number): StatusTone {
  return exitCode === 0 ? 'success' : 'error'
}
