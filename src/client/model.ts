/**
 * Pure presentation logic for the Cowork panel.
 *
 * Everything here is a plain function over values: layout selection, time
 * formatting, status copy, error-to-state mapping and clipboard feedback. The
 * React components consume it, and `tests/panel-model.test.mjs` pins it without
 * rendering anything. This module must stay React-free (no JSX, no `react`
 * import) so it can be loaded by `node --test` through type stripping.
 */
import type { PanelCounts, PanelThreadStatus } from '../api-contract.ts'
import type { PanelErrorInfo } from './contracts.ts'

/** Layout switch: above this measured width the panel splits into two columns. */
export const SPLIT_WIDTH_THRESHOLD = 480

/** Width of the thread list column in split mode. */
export const LIST_COLUMN_WIDTH = 248

/** Threads above this count make the list scroll (the long-list state). */
export const LONG_LIST_THRESHOLD = 12

/** Subjects above this length are visually truncated (the long-subject state). */
export const LONG_SUBJECT_THRESHOLD = 48

/** Characters kept when the header shortens a repository path. */
export const PROJECT_PATH_MAX_CHARS = 44

/** Characters kept when the detail shows a thread id. */
export const THREAD_ID_MAX_CHARS = 8

/** How long an action receipt (copy / open session) stays on screen. */
export const FEEDBACK_TTL_MS = 5000

/** Fallback height for the MASTER message block before the panel is measured. */
export const MASTER_MESSAGE_FALLBACK_HEIGHT = 240

/** Smallest height the MASTER message block may shrink to. */
export const MASTER_MESSAGE_MIN_HEIGHT = 120

/** Layout mode chosen from the measured container width. */
export type LayoutMode = 'split' | 'drill'

/**
 * Pick the layout from the width measured on the panel container (not the
 * viewport): above {@link SPLIT_WIDTH_THRESHOLD} the list and the detail sit
 * side by side, at or below it the panel becomes a single-column drill-down so
 * two columns are never squeezed. An unmeasured width stays in drill mode.
 */
export function chooseLayout(measuredWidth: number | null | undefined): LayoutMode {
  if (typeof measuredWidth !== 'number' || !Number.isFinite(measuredWidth)) return 'drill'
  return measuredWidth > SPLIT_WIDTH_THRESHOLD ? 'split' : 'drill'
}

/** The panel surface state; the three list/detail states are separate flags. */
export type PanelSurfaceState = 'loading' | 'error' | 'empty' | 'default'

/**
 * Decide the surface state. A failed load wins over an empty list; a project
 * that is not initialized (or simply has no threads yet) is the empty state;
 * anything else renders the list/detail surface.
 */
export function surfaceState(input: {
  readonly loading: boolean
  readonly error: PanelErrorInfo | null
  readonly threadCount: number
}): PanelSurfaceState {
  if (input.loading) return 'loading'
  if (input.error !== null) return input.error.code === 'project/not-initialized' ? 'empty' : 'error'
  return input.threadCount === 0 ? 'empty' : 'default'
}

/** Whether the list needs its own scroll area (the long-list state). */
export function isLongList(threadCount: number): boolean {
  return threadCount > LONG_LIST_THRESHOLD
}

/** Whether one row's subject needs truncation (the long-subject state). */
export function isLongSubject(subject: string): boolean {
  return subject.length > LONG_SUBJECT_THRESHOLD
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

/** Short thread id shown in the detail header. */
export function shortThreadId(threadId: string): string {
  return threadId.length <= THREAD_ID_MAX_CHARS ? threadId : threadId.slice(0, THREAD_ID_MAX_CHARS)
}

/** Chinese labels for the five listable thread statuses. */
export const STATUS_LABELS: Record<PanelThreadStatus, string> = {
  new: '新建',
  active: '进行中',
  awaiting_review: '待审查',
  blocked: '受阻',
  done: '已完成',
}

/** Label for a status value; unknown values stay visible instead of vanishing. */
export function statusLabel(status: PanelThreadStatus): string {
  return STATUS_LABELS[status] ?? String(status)
}

/** Status dot tones, resolved to public theme tokens in `styles.ts`. */
export type StatusTone = 'success' | 'warn' | 'error' | 'idle'

/** One tone per status; the visible label always accompanies the dot. */
export const STATUS_TONES: Record<PanelThreadStatus, StatusTone> = {
  new: 'idle',
  active: 'success',
  awaiting_review: 'warn',
  blocked: 'error',
  done: 'idle',
}

/** Tone of one status value; unknown values fall back to the neutral dot. */
export function statusTone(status: PanelThreadStatus): StatusTone {
  return STATUS_TONES[status] ?? 'idle'
}

/** Header chip order: work in flight first, brand-new threads last. */
export const CHIP_STATUS_ORDER: readonly PanelThreadStatus[] = [
  'active', 'awaiting_review', 'blocked', 'done', 'new',
]

/** One header chip: status, label and current count. */
export interface StatusChip {
  readonly status: PanelThreadStatus
  readonly label: string
  readonly count: number
}

/** Build the header chips from the overview counts. */
export function statusChips(counts: PanelCounts): StatusChip[] {
  return CHIP_STATUS_ORDER.map(status => ({
    status,
    label: statusLabel(status),
    count: counts[status] ?? 0,
  }))
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

/** Copy for a project that has no threads yet (as opposed to not initialized). */
export function emptyNotice(reason: 'no-threads'): NoticePresentation {
  return {
    kind: 'empty',
    title: '这个项目还没有 thread',
    detail: reason === 'no-threads' ? '让 master 会话用 cowork_master 派一个 thread，面板会在这里列出它。' : '',
    code: null,
    path: null,
    retry: true,
    hint: null,
  }
}

/**
 * Map a host error to a panel notice. `project/not-initialized` is an empty
 * state with the exact command to run; `store/corrupt` keeps its code and the
 * offending path and offers a retry; everything else is a generic error with
 * the retry path still available.
 */
export function errorPresentation(error: PanelErrorInfo | null): NoticePresentation {
  if (error === null) {
    return {
      kind: 'error',
      title: '读取 Cowork 总览失败',
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
  if (error.code === 'handoff/not-found') {
    return {
      kind: 'empty',
      title: '这个 thread 还没有交接单',
      detail: 'master 收到 handoff 后，交接单会出现在这里。',
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
  return {
    kind: 'error',
    title: '读取 Cowork 总览失败',
    detail: error.message,
    code: error.code,
    path: error.path ?? null,
    retry: true,
    hint: null,
  }
}

/** Receipt after copying the handoff path. */
export function copySuccessMessage(): string {
  return '已复制交接单路径'
}

/** Receipt after a failed clipboard write; never silent. */
export function copyFailureMessage(reason: string): string {
  const suffix = reason.trim().length === 0 ? '' : `（${reason.trim()}）`
  return `复制失败：请在浏览器允许剪贴板权限后重试${suffix}`
}

/** Action receipt shown when the workspace service is unavailable. */
export function openSessionUnavailableMessage(): string {
  return '当前宿主没有提供会话导航服务，无法打开 thread 会话。'
}

/** Receipt after asking the host to show a thread's Conversation. */
export function openSessionMessage(threadId: string): string {
  return `已切换到 thread 会话 ${shortThreadId(threadId)}`
}

/** Receipt after the host refused the navigation. */
export function openSessionFailureMessage(reason: string): string {
  const suffix = reason.trim().length === 0 ? '' : `（${reason.trim()}）`
  return `打开 thread 会话失败${suffix}`
}

/**
 * Inline max-height for the MASTER message block: about 40% of the measured
 * detail area, clamped to a readable minimum. Measuring beats a viewport guess
 * because the right Sidebar is resizable.
 */
export function masterMessageMaxHeight(regionHeight: number): number {
  if (!Number.isFinite(regionHeight) || regionHeight <= 0) return MASTER_MESSAGE_FALLBACK_HEIGHT
  return Math.max(MASTER_MESSAGE_MIN_HEIGHT, Math.round(regionHeight * 0.4))
}
