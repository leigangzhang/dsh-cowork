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
  type ArtifactDispatchSummary,
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

/** The newest delivery batch that carried any comment of one thread. */
export function dispatchForThread(
  thread: WorkItemThread,
  dispatches: readonly ArtifactDispatchSummary[],
): ArtifactDispatchSummary | null {
  const commentIds = new Set(thread.comments.map((event) => event.commentId))
  let newest: ArtifactDispatchSummary | null = null
  for (const dispatch of dispatches) {
    if (!dispatch.commentIds.some((commentId) => commentIds.has(commentId))) continue
    if (newest === null || dispatch.updatedAt > newest.updatedAt) newest = dispatch
  }
  return newest
}

/** Whether a failed/blocked/stale batch can be sent again. */
export function isRetryableDispatch(dispatch: ArtifactDispatchSummary): boolean {
  return dispatch.state === 'failed' || dispatch.state === 'blocked' || dispatch.state === 'stale'
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
 * A line diff (common prefix/suffix, then bounded LCS on the middle) keeps an
 * insertion at the top from widening the range to the whole file. Presence is
 * still a hint, not a merge base: a pure deletion reports the point where the
 * deleted line used to stand.
 */
export function changedLineRanges(before: string, after: string): LineSelection[] {
  const beforeLines = contentLines(before)
  const afterLines = contentLines(after)
  let prefix = 0
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < beforeLines.length - prefix
    && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) suffix += 1
  const left = beforeLines.slice(prefix, beforeLines.length - suffix)
  const right = afterLines.slice(prefix, afterLines.length - suffix)
  if (left.length === 0 && right.length === 0) return []
  if (right.length === 0) {
    const point = Math.max(1, prefix + 1)
    return [{ startLine: point, endLine: point }]
  }
  const matched = new Set<number>()
  const rows = left.length
  const columns = right.length
  if (rows * columns <= 250_000) {
    const table = new Uint16Array((rows + 1) * (columns + 1))
    const at = (row: number, column: number): number => row * (columns + 1) + column
    for (let row = 1; row <= rows; row += 1) {
      for (let column = 1; column <= columns; column += 1) {
        table[at(row, column)] = left[row - 1] === right[column - 1]
          ? table[at(row - 1, column - 1)] + 1
          : Math.max(table[at(row - 1, column)], table[at(row, column - 1)])
      }
    }
    let row = rows
    let column = columns
    while (row > 0 && column > 0) {
      if (left[row - 1] === right[column - 1]) {
        matched.add(column - 1)
        row -= 1
        column -= 1
      } else if (table[at(row - 1, column)] >= table[at(row, column - 1)]) {
        row -= 1
      } else {
        column -= 1
      }
    }
  }
  const ranges: LineSelection[] = []
  for (let index = 0; index < right.length; index += 1) {
    if (matched.has(index)) continue
    const line = prefix + index + 1
    const last = ranges[ranges.length - 1]
    if (last !== undefined && last.endLine === line - 1) {
      ranges[ranges.length - 1] = { startLine: last.startLine, endLine: line }
    } else {
      ranges.push({ startLine: line, endLine: line })
    }
  }
  return ranges
}

/** One source line reduced for the read-only Markdown-ish view. */
export interface ReadLine {
  readonly kind: 'text' | 'h1' | 'h2' | 'h3' | 'list' | 'quote'
  readonly text: string
}

/** Strip the most common Markdown markers without rendering HTML. */
export function markdownLine(line: string): ReadLine {
  if (line.startsWith('### ')) return { kind: 'h3', text: line.slice(4) }
  if (line.startsWith('## ')) return { kind: 'h2', text: line.slice(3) }
  if (line.startsWith('# ')) return { kind: 'h1', text: line.slice(2) }
  if (line.startsWith('- ') || line.startsWith('* ')) return { kind: 'list', text: line.slice(2) }
  if (line.startsWith('> ')) return { kind: 'quote', text: line.slice(2) }
  return { kind: 'text', text: line }
}

/** One inline run of a read-mode Markdown line. */
export interface InlineRun {
  readonly kind: 'text' | 'strong' | 'em' | 'code'
  readonly text: string
}

/**
 * Split one line into inline text, strong, emphasis, and code runs.
 *
 * The read view renders these as elements instead of printing the markers, so
 * `**bold**` reads as bold without an HTML parser and without trusting the
 * file. Only non-nested spans are recognized; an unmatched marker stays
 * literal text, which is how a half-finished Markdown line should read.
 * @param text - one line with block markers already stripped.
 * @returns the runs in source order; plain text is a single run.
 */
export function inlineMarkdown(text: string): readonly InlineRun[] {
  if (text === '') return []
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*/g
  const runs: InlineRun[] = []
  let start = 0
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match.index > start) runs.push({ kind: 'text', text: text.slice(start, match.index) })
    if (match[1] !== undefined) runs.push({ kind: 'code', text: match[1] })
    else if (match[2] !== undefined) runs.push({ kind: 'strong', text: match[2] })
    else runs.push({ kind: 'em', text: match[3] ?? '' })
    start = match.index + match[0].length
  }
  if (start < text.length) runs.push({ kind: 'text', text: text.slice(start) })
  return runs
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

/** Prefix of the per-work-item draft kept across close/session switches. */
const DRAFT_STORAGE_PREFIX = 'cowork.work-item.draft.'

/** Persisted shape of one unsaved draft. */
export interface PersistedDraft {
  readonly content: string
  readonly baseRevision: number
  readonly baseVersion: string | null
  readonly savedAt: string
}

/** Persist one draft; a storage failure must not break editing. */
export function savePersistedDraft(artifactId: string, draft: PersistedDraft): void {
  try {
    window.localStorage.setItem(`${DRAFT_STORAGE_PREFIX}${artifactId}`, JSON.stringify(draft))
  } catch {
    // Storage may be full or disabled; the in-memory draft still exists.
  }
}

/** Read and validate one stored draft; malformed entries are dropped. */
export function readPersistedDraft(artifactId: string): PersistedDraft | null {
  try {
    const raw = window.localStorage.getItem(`${DRAFT_STORAGE_PREFIX}${artifactId}`)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      removePersistedDraft(artifactId)
      return null
    }
    const value = parsed as Partial<PersistedDraft>
    if (typeof value.content !== 'string' || typeof value.baseRevision !== 'number') {
      removePersistedDraft(artifactId)
      return null
    }
    return {
      content: value.content,
      baseRevision: value.baseRevision,
      baseVersion: typeof value.baseVersion === 'string' ? value.baseVersion : null,
      savedAt: typeof value.savedAt === 'string' ? value.savedAt : '',
    }
  } catch {
    return null
  }
}

/** Remove the stored draft after a successful save or an explicit reload. */
export function removePersistedDraft(artifactId: string): void {
  try {
    window.localStorage.removeItem(`${DRAFT_STORAGE_PREFIX}${artifactId}`)
  } catch {
    // A storage failure must not break saving or closing.
  }
}

/** A compact attachment size label. */
export function formatBytes(size: number): string {
  if (size < 1024) return `${String(size)} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
