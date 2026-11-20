/**
 * Pure view model of the work-item surface: filters, groups, the dispatch
 * badge, relative timestamps, comment-thread folding, and the line selection
 * reducer.
 *
 * React-free on purpose: the same rules are exercised by `node --test` with
 * type stripping, and the TSX components stay thin enough for the browser lane
 * to cover them.
 */
import {
  ARTIFACT_STATUS_LABELS,
  ARTIFACT_TYPE_LABELS,
  DISPATCH_STATE_LABELS,
  isTerminalDispatchState,
  type ActiveDispatchV1,
  type ArtifactAnchor,
  type ArtifactFileV1,
  type ArtifactStatus,
  type ArtifactSummaryV1,
  type ArtifactType,
  type CommentEventV1,
  type DispatchState,
} from '../../panel/artifact-contract.js'

/** The right-rail filters, in card order. `all` is not a status. */
export const WORK_ITEM_FILTERS = [
  'all',
  'pending-confirm',
  'needs-feedback',
  'in-progress',
  'pending-view',
  'confirmed',
] as const

/** One right-rail filter. */
export type WorkItemFilter = (typeof WORK_ITEM_FILTERS)[number]

/**
 * Group order of the rail: things waiting on the user first, `pending-view`
 * after active work, and `confirmed` last (collapsed by default).
 */
export const WORK_ITEM_GROUP_ORDER: readonly ArtifactStatus[] = [
  'pending-confirm',
  'needs-feedback',
  'in-progress',
  'pending-view',
  'confirmed',
]

/** One status group the list renders. */
export interface WorkItemGroup {
  readonly status: ArtifactStatus
  readonly label: string
  readonly items: readonly ArtifactSummaryV1[]
  /** Confirmed groups start folded; every other group starts open. */
  readonly collapsedByDefault: boolean
}

/** Label of one filter chip. */
export function filterLabel(filter: WorkItemFilter): string {
  return filter === 'all' ? '全部' : ARTIFACT_STATUS_LABELS[filter]
}

/** Human label of one artifact type. */
export function typeLabel(type: ArtifactType): string {
  return ARTIFACT_TYPE_LABELS[type]
}

/** Human label of one delivery state. */
export function dispatchLabel(state: DispatchState): string {
  return DISPATCH_STATE_LABELS[state]
}

/** Keep only the items one filter names; `all` keeps everything. */
export function filterArtifacts(
  items: readonly ArtifactSummaryV1[],
  filter: WorkItemFilter,
): ArtifactSummaryV1[] {
  return filter === 'all' ? [...items] : items.filter((item) => item.status === filter)
}

/** Group items in rail order, skipping empty groups. */
export function groupArtifacts(items: readonly ArtifactSummaryV1[]): WorkItemGroup[] {
  const groups: WorkItemGroup[] = []
  for (const status of WORK_ITEM_GROUP_ORDER) {
    const grouped = items.filter((item) => item.status === status)
    if (grouped.length === 0) continue
    groups.push({
      status,
      label: ARTIFACT_STATUS_LABELS[status],
      items: grouped,
      collapsedByDefault: status === 'confirmed',
    })
  }
  return groups
}

/** The rail's per-filter count, showing the project total on `all`. */
export function filterCount(
  counts: {
    readonly total: number
    readonly pendingView: number
    readonly pendingConfirm: number
    readonly needsFeedback: number
    readonly inProgress: number
    readonly confirmed: number
  },
  filter: WorkItemFilter,
): number {
  switch (filter) {
    case 'all':
      return counts.total
    case 'pending-view':
      return counts.pendingView
    case 'pending-confirm':
      return counts.pendingConfirm
    case 'needs-feedback':
      return counts.needsFeedback
    case 'in-progress':
      return counts.inProgress
    case 'confirmed':
      return counts.confirmed
  }
}

/** The one-line activity a card or the viewer header shows, or null. */
export function activeDispatchSummary(
  dispatch: ActiveDispatchV1 | null,
): { readonly label: string; readonly tone: 'pending' | 'active' | 'done' | 'error'; readonly terminal: boolean } | null {
  if (dispatch === null) return null
  const terminal = isTerminalDispatchState(dispatch.state)
  const tone = dispatch.state === 'replied'
    ? 'done'
    : dispatch.state === 'failed' || dispatch.state === 'blocked'
      ? 'error'
      : dispatch.state === 'queued' || dispatch.state === 'sent' || dispatch.state === 'stale'
        ? 'pending'
        : 'active'
  return { label: DISPATCH_STATE_LABELS[dispatch.state], tone, terminal }
}

/** A short relative time: 刚刚 / N 分钟前 / N 小时前 / N 天前 / a date. */
export function formatRelativeTime(iso: string, now: Date): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return ''
  const deltaMs = now.getTime() - time
  if (deltaMs < 60_000) return '刚刚'
  const minutes = Math.floor(deltaMs / 60_000)
  if (minutes < 60) return `${String(minutes)} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${String(days)} 天前`
  const date = new Date(time)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${String(date.getFullYear())}-${month}-${day}`
}

/** `r12 · 3 条评论 · 2 个附件` — the viewer toolbar's file facts. */
export function revisionSummary(revision: number, commentCount: number, attachmentCount: number): string {
  const parts = [`r${String(revision)}`, `${String(commentCount)} 条评论`]
  if (attachmentCount > 0) parts.push(`${String(attachmentCount)} 个附件`)
  return parts.join(' · ')
}

/** A registered file's one-line fact: path plus size. */
export function fileSummary(file: ArtifactFileV1): string {
  const size = file.size < 1024
    ? `${String(file.size)} B`
    : `${(file.size / 1024).toFixed(1)} KB`
  return `${file.path} · ${size}`
}

/** One comment thread as the rail renders it. */
export interface WorkItemThread {
  readonly threadId: string
  readonly root: CommentEventV1 | null
  readonly comments: readonly CommentEventV1[]
  readonly anchor: ArtifactAnchor | null
  readonly resolved: boolean
  readonly anchorStatus: 'moved' | 'stale' | null
  readonly latestAt: string
}

/**
 * Fold the flat comment log into threads.
 *
 * `create` opens a thread, `reply` joins it, `resolve`/`reopen` toggle it, and
 * `anchor-moved` replaces the anchor (with its relocation status). A reply
 * without a known thread is ignored rather than inventing a thread.
 */
export function foldThreads(events: readonly CommentEventV1[]): WorkItemThread[] {
  const threads = new Map<string, {
    threadId: string
    root: CommentEventV1 | null
    comments: CommentEventV1[]
    anchor: ArtifactAnchor | null
    resolved: boolean
    anchorStatus: 'moved' | 'stale' | null
    latestAt: string
  }>()
  for (const event of events) {
    const existing = threads.get(event.threadId)
    if (event.type === 'create') {
      threads.set(event.threadId, {
        threadId: event.threadId,
        root: event,
        comments: [event],
        anchor: event.anchor ?? null,
        resolved: false,
        anchorStatus: null,
        latestAt: event.createdAt,
      })
      continue
    }
    if (existing === undefined) continue
    existing.latestAt = event.createdAt > existing.latestAt ? event.createdAt : existing.latestAt
    if (event.type === 'reply') existing.comments.push(event)
    if (event.type === 'resolve') existing.resolved = true
    if (event.type === 'reopen') existing.resolved = false
    if (event.type === 'anchor-moved') {
      existing.anchor = event.anchor
      existing.anchorStatus = event.anchorStatus
    }
  }
  return [...threads.values()].map((thread) => ({
    threadId: thread.threadId,
    root: thread.root,
    comments: [thread.comments[0], ...thread.comments.slice(1)],
    anchor: thread.anchor,
    resolved: thread.resolved,
    anchorStatus: thread.anchorStatus,
    latestAt: thread.latestAt,
  }))
}

/** Sort threads: unresolved first, then by anchor line, then newest. */
export function sortThreads(threads: readonly WorkItemThread[]): WorkItemThread[] {
  return [...threads].sort((left, right) => {
    if (left.resolved !== right.resolved) return left.resolved ? 1 : -1
    const leftLine = anchorLine(left.anchor)
    const rightLine = anchorLine(right.anchor)
    if (leftLine !== rightLine) return leftLine - rightLine
    return right.latestAt.localeCompare(left.latestAt)
  })
}

/** The anchor's first line, or a large number for anchors without one. */
export function anchorLine(anchor: ArtifactAnchor | null): number {
  if (anchor === null) return Number.MAX_SAFE_INTEGER
  if (anchor.kind === 'line-range') return anchor.startLine
  if (anchor.kind === 'diagram-node' && anchor.line !== undefined) return anchor.line
  return Number.MAX_SAFE_INTEGER
}

/** One anchor's display label, e.g. `第 3–5 行` or `整份文件`. */
export function anchorLabel(anchor: ArtifactAnchor | null): string {
  if (anchor === null) return '整份工作项'
  switch (anchor.kind) {
    case 'line-range':
      return anchor.startLine === anchor.endLine
        ? `第 ${String(anchor.startLine)} 行`
        : `第 ${String(anchor.startLine)}–${String(anchor.endLine)} 行`
    case 'block':
      return '段落'
    case 'diagram-node':
      return '图表节点'
    case 'table-cell':
      return `第 ${String(anchor.row + 1)} 行第 ${String(anchor.column + 1)} 列`
    case 'canvas-element':
      return '画布元素'
    case 'page':
      return `第 ${String(anchor.page)} 页`
    case 'region':
      return anchor.page === undefined ? '区域' : `第 ${String(anchor.page)} 页区域`
    case 'whole':
      return '整份文件'
  }
}

/** One line selection; both bounds are 1-based and inclusive. */
export interface LineSelection {
  readonly startLine: number
  readonly endLine: number
}

/**
 * The line-selection reducer. A plain click selects one line; an extending
 * click (shift) grows the current range to include the clicked line.
 */
export function selectLine(
  current: LineSelection | null,
  line: number,
  extend: boolean,
): LineSelection {
  if (extend && current !== null) {
    return {
      startLine: Math.min(current.startLine, line),
      endLine: Math.max(current.endLine, line),
    }
  }
  return { startLine: line, endLine: line }
}

/** Whether a line number falls inside the selection. */
export function isSelected(selection: LineSelection | null, line: number): boolean {
  return selection !== null && line >= selection.startLine && line <= selection.endLine
}

/** The content's display lines; the same rule the server uses for anchors. */
export function contentLines(content: string): string[] {
  const lines = content.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Full comment body or reply body, whichever the event carries. */
export function commentBody(event: CommentEventV1): string {
  return event.type === 'create' || event.type === 'reply' ? event.body : ''
}

/** The author label of one comment: the model's session or the user. */
export function commentAuthor(event: CommentEventV1): string {
  if (event.type === 'anchor-moved' || event.type === 'resolve' || event.type === 'reopen') return ''
  return event.author === 'model' ? '模型' : '你'
}

/** The badge a stale/moved anchor shows, or null. */
export function anchorStatusLabel(status: 'moved' | 'stale' | null): string | null {
  if (status === 'stale') return '位置待确认'
  if (status === 'moved') return '已重新定位'
  return null
}

/** How one failed request is presented: title, detail, and retryability. */
export function errorPresentation(error: { readonly code?: string; readonly message?: string } | null): {
  readonly title: string
  readonly detail: string
  readonly retryable: boolean
} {
  const code = error?.code ?? 'internal'
  const detail = error?.message ?? '请求失败，请稍后重试。'
  if (code === 'artifact/file-missing') return { title: '文件不存在', detail, retryable: true }
  if (code === 'artifact/not-found') return { title: '工作项不存在', detail, retryable: false }
  if (code === 'artifact/fs-unavailable') return { title: '当前宿主没有文件服务', detail, retryable: false }
  if (code === 'artifact/not-previewable') return { title: '暂不支持预览', detail, retryable: false }
  return { title: '加载失败', detail, retryable: true }
}

/**
 * Changed line ranges between the saved text and the draft, in draft line
 * numbers. This is what the browser reports as editing presence: the server
 * only needs the ranges a model write must avoid.
 *
 * The rule is intentionally simple — consecutive differing lines group into one
 * range, and an insertion contributes its own point range — because presence is
 * a transient hint, not a merge base.
 */
export function changedLineRanges(before: string, after: string): LineSelection[] {
  const beforeLines = contentLines(before)
  const afterLines = contentLines(after)
  const ranges: LineSelection[] = []
  const shared = Math.min(beforeLines.length, afterLines.length)
  let start = -1
  for (let index = 0; index < shared; index += 1) {
    if (beforeLines[index] !== afterLines[index]) {
      if (start === -1) start = index + 1
    } else if (start !== -1) {
      ranges.push({ startLine: start, endLine: index })
      start = -1
    }
  }
  if (start !== -1) ranges.push({ startLine: start, endLine: shared })
  if (afterLines.length > shared) {
    ranges.push({ startLine: shared + 1, endLine: afterLines.length })
  }
  return ranges
}

/** Save-state label the toolbar shows while editing. */
export type SavePhase = 'saved' | 'saving' | 'conflict' | 'failed'

/** Toolbar text of one save state, e.g. `已保存 · r12`. */
export function saveStateLabel(phase: SavePhase, revision: number): string {
  switch (phase) {
    case 'saved':
      return `已保存 · r${String(revision)}`
    case 'saving':
      return '保存中…'
    case 'conflict':
      return '冲突'
    case 'failed':
      return '保存失败'
  }
}
