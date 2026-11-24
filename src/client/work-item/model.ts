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
  ARTIFACT_TYPE_LABELS,
  DISPATCH_STATE_LABELS,
  MAX_ARTIFACT_QUOTE_CHARS,
  MAX_ARTIFACT_SEARCH_CHARS,
  artifactStatusMatches,
  isTerminalDispatchState,
  railStatusLabel,
  type ActiveDispatchV1,
  type ArtifactAnchor,
  type ArtifactDetailResponse,
  type AttachmentRefV1,
  type ArtifactDispatchSummary,
  type ArtifactFileV1,
  type ArtifactRecordV1,
  type ArtifactStatus,
  type ArtifactSummaryV1,
  type ArtifactType,
  type AttachmentPublishV1,
  type CommentEventV1,
  type DispatchState,
} from '../../panel/artifact-contract.js'

/**
 * The right-rail filters, in card order. `all` is not a status; `pending-view`
 * is not a filter because it is shown as 待确认 (see `artifactStatusMatches`).
 */
export const WORK_ITEM_FILTERS = [
  'all',
  'pending-confirm',
  'needs-feedback',
  'in-progress',
  'confirmed',
] as const

/** One right-rail filter. */
export type WorkItemFilter = (typeof WORK_ITEM_FILTERS)[number]

/**
 * Group order of the rail: things waiting on the user first, then active work,
 * and `confirmed` last (collapsed by default). Stored `pending-view` rows join
 * the 待确认 group instead of getting a group of their own.
 */
export const WORK_ITEM_GROUP_ORDER: readonly ArtifactStatus[] = [
  'pending-confirm',
  'needs-feedback',
  'in-progress',
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

/** Label of one filter chip under the merged rail projection. */
export function filterLabel(filter: WorkItemFilter): string {
  return filter === 'all' ? '全部' : railStatusLabel(filter)
}

/** Human label of one artifact type. */
export function typeLabel(type: ArtifactType): string {
  return ARTIFACT_TYPE_LABELS[type]
}

/** Human label of one delivery state. */
export function dispatchLabel(state: DispatchState): string {
  return DISPATCH_STATE_LABELS[state]
}

/**
 * Keep only the items one filter names; `all` keeps everything.
 *
 * `pending-confirm` keeps both stored statuses because the rail merges
 * 待查看 into 待确认; the contract owns that rule.
 */
export function filterArtifacts(
  items: readonly ArtifactSummaryV1[],
  filter: WorkItemFilter,
): ArtifactSummaryV1[] {
  if (filter === 'all') return [...items]
  return items.filter((item) => artifactStatusMatches(filter, item.status))
}

/**
 * Group items in rail order under the merged status, skipping empty groups.
 * @param items - summaries; their stored `status` stays untouched on the cards.
 * @returns groups whose status is the merged rail status.
 */
export function groupArtifacts(items: readonly ArtifactSummaryV1[]): WorkItemGroup[] {
  const groups: WorkItemGroup[] = []
  for (const status of WORK_ITEM_GROUP_ORDER) {
    const grouped = items.filter((item) => artifactStatusMatches(status, item.status))
    if (grouped.length === 0) continue
    groups.push({
      status,
      label: railStatusLabel(status),
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
    case 'pending-confirm':
      // 待查看 is shown as 待确认, so the chip counts both stored statuses.
      return counts.pendingView + counts.pendingConfirm
    case 'needs-feedback':
      return counts.needsFeedback
    case 'in-progress':
      return counts.inProgress
    case 'confirmed':
      return counts.confirmed
  }
}

/** How long typed search text rests before it becomes one server request. */
export const LIST_SEARCH_DEBOUNCE_MS = 150

/** The note shown when the server capped a result set at 200 rows. */
export const LIST_TRUNCATED_MESSAGE = '匹配结果超过 200 条，仅显示前 200 条'

/**
 * Trim search text and cap it to the server's accepted length.
 * @param raw - the input's current value.
 * @returns the request-safe query; empty means "no search".
 */
export function boundSearchQuery(raw: string): string {
  const text = raw.trim()
  const points = Array.from(text)
  return points.length <= MAX_ARTIFACT_SEARCH_CHARS
    ? text
    : points.slice(0, MAX_ARTIFACT_SEARCH_CHARS).join('')
}

/**
 * The `status` query value for one filter.
 * @param filter - active rail filter.
 * @returns the merged status the server filters on, or null for `all`.
 */
export function searchStatusOf(filter: WorkItemFilter): ArtifactStatus | null {
  return filter === 'all' ? null : filter
}

/** The card's source line: the owning session name or the unnamed fallback. */
export function sourceLabel(sessionTitle: string | null | undefined): string {
  return `来源：${sessionTitle ?? '未命名会话'}`
}

/** The card's tooltip: the title only, never the stored path. */
export function cardTitle(item: ArtifactSummaryV1): string {
  return item.title
}

/**
 * Empty-list copy for the active query.
 * @param query - the committed (trimmed) server query, or ''.
 * @returns the no-result text with the query echoed, or the filter-only text.
 */
export function listEmptyMessage(query: string): string {
  return query === '' ? '这个筛选下没有工作项。' : `没有匹配「${query}」的工作项`
}

/** Whether one group starts open (every group except 已完成). */
export function groupStartsExpanded(group: WorkItemGroup): boolean {
  return !group.collapsedByDefault
}

/** Toggle one group's remembered expansion state. */
export function toggledGroupExpanded(expanded: boolean): boolean {
  return !expanded
}

/** Whether a thrown value is the abort of a superseded list request. */
export function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { readonly name?: unknown }).name === 'AbortError'
}

/** One-line activity badge the header and cards render. */
export interface ActiveDispatchBadge {
  readonly label: string
  readonly tone: 'pending' | 'active' | 'done' | 'error'
  readonly terminal: boolean
}

/** One-line badge for the viewer header's live activity pill. */
export function activeDispatchSummary(dispatch: ActiveDispatchV1 | null): ActiveDispatchBadge | null {
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

/** The rail's three-state comment filter. */
export type ThreadFilter = 'all' | 'pending' | 'resolved'

/** One rail projection: cards to show, summary state, and the empty message. */
export interface ThreadRailView {
  readonly open: readonly WorkItemThread[]
  readonly resolved: readonly WorkItemThread[]
  readonly visible: readonly WorkItemThread[]
  readonly showResolvedCards: boolean
  readonly showSummary: boolean
  readonly emptyMessage: string | null
}

const EMPTY_MESSAGES: Readonly<Record<ThreadFilter, string>> = {
  all: '还没有批注。选中行后点“批注”，或直接写整体批注。',
  pending: '没有待处理的批注。',
  resolved: '没有已解决的批注。',
}

/** Resolved cards stay visible under "all" only while the summary is expanded. */
function resolvedCardsVisible(filter: ThreadFilter, showResolved: boolean): boolean {
  return filter === 'resolved' || (filter === 'all' && showResolved)
}

/** The empty message for the active filter, or null when the rail has rows. */
function railEmptyMessage(
  filter: ThreadFilter,
  threads: number,
  open: number,
  resolved: number,
): string | null {
  const count = filter === 'all' ? threads : (filter === 'pending' ? open : resolved)
  return count === 0 ? EMPTY_MESSAGES[filter] : null
}

/**
 * Project the folded threads for the rail's filter and resolved group state.
 * @param threads - folded threads in sort order.
 * @param filter - active three-state filter.
 * @param showResolved - whether the resolved summary was expanded.
 * @returns visible cards, summary state, and the empty message.
 */
export function threadRailView(
  threads: readonly WorkItemThread[],
  filter: ThreadFilter,
  showResolved: boolean,
): ThreadRailView {
  const open = threads.filter((thread) => !thread.resolved)
  const resolved = threads.filter((thread) => thread.resolved)
  const visible = filter === 'resolved' ? [] : open
  return {
    open,
    resolved,
    visible,
    showResolvedCards: resolvedCardsVisible(filter, showResolved),
    showSummary: filter === 'all' && resolved.length > 0,
    emptyMessage: railEmptyMessage(filter, threads.length, open.length, resolved.length),
  }
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

/** One missing-file state the viewer can offer to repair. */
export interface MissingFileState {
  readonly path: string
  readonly hint: string
}

/**
 * The rebind state of a work item whose registered file vanished.
 *
 * The record's own `missing` flag is authoritative when the detail read
 * succeeded; a failed file read supplies the same fact through its error code.
 * @param record - the loaded record.
 * @param fileErrorCode - the file read's failure code, if it failed.
 * @returns the missing path and the hint, or null when the file is readable.
 */
export function missingFileState(record: ArtifactRecordV1, fileErrorCode: string | null): MissingFileState | null {
  const primary = record.files.find((file) => file.path === record.primaryPath) ?? record.files[0]
  const missing = fileErrorCode === 'artifact/file-missing' || primary?.missing === true
  if (!missing) return null
  return {
    path: primary?.path ?? record.primaryPath,
    hint: '文件已被移动或删除。填入它在项目中的新路径；批注和版本都保留在这个工作项上。',
  }
}

/** A validated rebind target typed by the user. */
export type RebindTarget =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: string }

/**
 * Validate one rebind path before sending it.
 *
 * The server still rejects an escaping path; this catches the obvious mistakes
 * locally so the user gets the reason without a round trip.
 * @param input - the raw path typed by the user.
 * @returns the trimmed project-relative path, or the reason it is unusable.
 */
export function rebindTarget(input: string): RebindTarget {
  const path = input.trim()
  if (path === '') return { ok: false, error: '请输入文件在项目中的新路径。' }
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) {
    return { ok: false, error: '路径必须是项目内的相对路径。' }
  }
  if (path.split('/').includes('..')) return { ok: false, error: '路径不能包含 ..。' }
  return { ok: true, path }
}

/** How one failed rebind is presented: a short title and the server's reason. */
export function rebindFailure(
  error: { readonly code?: string; readonly message?: string } | null,
): { title: string; detail: string } {
  const code = error?.code ?? 'internal'
  const detail = error?.message ?? '重新绑定失败，请稍后重试。'
  if (code === 'artifact/file-missing') return { title: '新路径不存在', detail }
  if (code === 'artifact/path-not-allowed') return { title: '路径不可用', detail }
  if (code === 'artifact/not-found') return { title: '工作项不存在', detail }
  return { title: '重新绑定失败', detail }
}

/** The receipt after a successful rebind. */
export function rebindReceipt(changed: boolean, path: string): string {
  return changed ? `已重新绑定到 ${path}` : '路径没有变化，已刷新文件'
}

/** The line range one thread anchors, when it is a line range and matches the filter. */
function threadLineRange(
  thread: WorkItemThread,
  unresolvedOnly: boolean,
): { readonly startLine: number; readonly endLine: number } | null {
  if (unresolvedOnly && thread.resolved) return null
  if (thread.anchor === null || thread.anchor.kind !== 'line-range') return null
  return thread.anchor
}

/** Add every line of one range. */
function addRange(values: Set<number>, range: { readonly startLine: number; readonly endLine: number }): void {
  for (let line = range.startLine; line <= range.endLine; line += 1) values.add(line)
}

/** The line numbers of every unresolved thread's line-range anchor. */
export function anchoredLineNumbers(threads: readonly WorkItemThread[]): Set<number> {
  const values = new Set<number>()
  for (const thread of threads) {
    const range = threadLineRange(thread, true)
    if (range !== null) addRange(values, range)
  }
  return values
}

/** The line numbers of every thread whose anchor was marked stale. */
export function staleLineNumbers(threads: readonly WorkItemThread[]): Set<number> {
  const values = new Set<number>()
  for (const thread of threads) {
    const range = thread.anchorStatus === 'stale' ? threadLineRange(thread, false) : null
    if (range !== null) addRange(values, range)
  }
  return values
}

/** The attachments one comment or reply event carries. */
function commentAttachments(event: CommentEventV1): AttachmentRefV1[] {
  if (event.type !== 'create' && event.type !== 'reply') return []
  return [...(event.attachments ?? [])]
}

/** Every attachment carried by the folded threads, in display order. */
function attachmentRowsOf(threads: readonly WorkItemThread[]): AttachmentRefV1[] {
  return threads.flatMap((thread) => thread.comments.flatMap(commentAttachments))
}

/** Empty copy of the attachment page. */
export const ATTACHMENT_EMPTY_TEXT = '还没有附件。在批注或回复里添加图片或文本文件。'

/** Row state when the stored bytes are gone. */
export const ATTACHMENT_MISSING_TEXT = '附件已缺失'

/** Text badge that marks a model-published attachment. */
export const MODEL_ATTACHMENT_LABEL = '模型生成'

/** One attachment the page or a thread renders, with its publication source. */
export interface AttachmentDisplayRow {
  readonly attachmentId: string
  readonly name: string
  readonly mediaType: string
  readonly size: number
  /** `model` only for `cowork_artifact_attach`; browser uploads are `user`. */
  readonly source: 'user' | 'model'
}

/**
 * The attachment page's rows.
 *
 * The published log (`detail.publishedAttachments`) is the source of truth; a
 * host that does not maintain it (older records) falls back to the refs the
 * comments carry, which predate the publish log and cannot be model-flagged.
 * @param published - detail.publishedAttachments, or null/undefined when the
 * host did not send it.
 * @param threads - folded threads, used only for the fallback.
 * @returns rows in publish/comment order with a source for the badge.
 */
export function attachmentDisplayRows(
  published: readonly AttachmentPublishV1[] | null | undefined,
  threads: readonly WorkItemThread[],
): AttachmentDisplayRow[] {
  if (published !== null && published !== undefined) {
    return published.map((entry) => ({
      attachmentId: entry.attachmentId,
      name: entry.name,
      mediaType: entry.mediaType,
      size: entry.size,
      source: entry.source,
    }))
  }
  return attachmentRowsOf(threads).map((entry) => ({ ...entry, source: 'user' }))
}

/** Where a composer attachment came from. */
export type AttachmentAttachSource = 'paste' | 'picker'

/**
 * Upload options for one composer source.
 *
 * A pasted image publishes right after upload so an abandoned draft cannot
 * leave it orphaned; a picked file waits for the comment's publish path.
 */
export function attachOptionsFor(source: AttachmentAttachSource): { readonly publish: boolean } {
  return { publish: source === 'paste' }
}

/** The badge text one attachment source shows, or null for a user upload. */
export function attachmentSourceBadge(source: 'user' | 'model'): string | null {
  return source === 'model' ? MODEL_ATTACHMENT_LABEL : null
}

/** The thread a line's pin numbers, or null when the line has no pin. */
export function pinThread(
  linePins: ReadonlyMap<number, ThreadPin>,
  threads: readonly WorkItemThread[],
  line: number,
): WorkItemThread | null {
  const pin = linePins.get(line)
  if (pin === undefined) return null
  return threads[pin.ordinal - 1] ?? null
}

/** The cursor that asks the comments route for the page before the loaded one. */
export function olderCursor(events: readonly CommentEventV1[]): string | null {
  return events[0]?.eventId ?? null
}

/**
 * Prepend an older comments page, dropping rows already loaded.
 *
 * The route pages by event id, so an overlap (a comment arriving between the
 * two reads) is expected; the merged order stays chronological.
 * @param current - the rows already shown.
 * @param older - the older page, oldest first.
 * @returns one chronological array without duplicate event ids.
 */
function mergeOlderComments(
  current: readonly CommentEventV1[],
  older: readonly CommentEventV1[],
): CommentEventV1[] {
  const known = new Set(current.map((event) => event.eventId))
  return [...older.filter((event) => !known.has(event.eventId)), ...current]
}

/** Whether the rail still offers "load older" after one page. */
export function olderPageAvailable(
  page: { readonly hasOlder?: boolean; readonly events: readonly CommentEventV1[] },
): boolean {
  return page.hasOlder === true && page.events.length > 0
}

/** Move the keyboard-active line within the document, clamped to its lines. */
export function moveActiveLine(active: number, delta: number, total: number): number {
  if (total <= 0) return 1
  return Math.min(total, Math.max(1, active + delta))
}

/** What one line-list key press asks the viewer to do. */
type LineKeyIntent = 'previous' | 'next' | 'annotate'

/** One key press per intent; keys outside the map do nothing. */
const LINE_KEY_INTENTS: Readonly<Record<string, LineKeyIntent>> = {
  ArrowDown: 'next',
  ArrowUp: 'previous',
  Enter: 'annotate',
  ' ': 'annotate',
}

/** The intent of one line-list key, or null when the key is not ours. */
export function lineKeyIntent(key: string): LineKeyIntent | null {
  return LINE_KEY_INTENTS[key] ?? null
}

/** The step a previous/next intent moves the keyboard cursor. */
export function lineMoveDelta(intent: LineKeyIntent): number {
  return intent === 'next' ? 1 : -1
}

/** The registered path a rebind starts from: the primary file's entry, else primaryPath. */
export function rebindOldPath(record: ArtifactRecordV1): string {
  return record.files.find((file) => file.path === record.primaryPath)?.path ?? record.primaryPath
}

/** Replace the loaded record without touching the rest of the view. */
export function withRecord<T extends { readonly record: ArtifactRecordV1 }>(
  data: T | null,
  record: ArtifactRecordV1,
): T | null {
  return data === null ? null : { ...data, record }
}

/** One older comment page as the route returns it, narrowed to what paging needs. */
interface OlderCommentPage {
  readonly events: readonly CommentEventV1[]
  readonly hasOlder: boolean
}

/** Prepend an older page and adopt its `hasOlder` flag. */
export function withOlderPage<T extends { readonly events: readonly CommentEventV1[]; readonly hasOlder: boolean }>(
  data: T | null,
  page: OlderCommentPage,
): T | null {
  if (data === null) return null
  return { ...data, events: mergeOlderComments(data.events, page.events), hasOlder: olderPageAvailable(page) }
}

/** One load-older request, or null when the viewer is not ready for it. */
export interface OlderCall {
  readonly ownerSessionId: string
  readonly artifactId: string
  readonly before: string
}

/** Build a load-older request, or null while the viewer is busy or idle. */
export function olderCall(
  context: { readonly ownerSessionId: string; readonly artifactId: string } | null,
  data: { readonly events: readonly CommentEventV1[] } | null,
  pending: boolean,
  before: string,
): OlderCall | null {
  if (context === null || data === null || pending) return null
  return { ownerSessionId: context.ownerSessionId, artifactId: context.artifactId, before }
}

/** One validated line-range annotation, or null when the range is empty. */
interface LineRangeAnnotation {
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  readonly quote: string
  /**
   * The user's sub-line selection, bounded like the quote. Display and prompt
   * data only: the server rebuilds quote/context and relocation ignores it.
   */
  readonly selectedText?: string
}

/** Cut a sub-line selection to the quote cap without splitting a code point. */
function boundSelectedText(text: string): string | undefined {
  const value = text.trim()
  if (value === '') return undefined
  const points = Array.from(value)
  return points.length <= MAX_ARTIFACT_QUOTE_CHARS ? value : points.slice(0, MAX_ARTIFACT_QUOTE_CHARS).join('')
}

/**
 * Build the annotation one line range implies, or null for an empty range.
 * @param lines - source lines of the file.
 * @param file - the file the range addresses, when known.
 * @param primaryPath - fallback path when the file entry is missing.
 * @param startLine - 1-based inclusive first line.
 * @param endLine - 1-based inclusive last line.
 * @param selectedText - the browser's sub-line selection, when it has one.
 * @returns the line range with its full-line quote and optional selection.
 */
export function lineRangeAnnotation(
  lines: readonly string[],
  file: { readonly path: string } | null,
  primaryPath: string,
  startLine: number,
  endLine: number,
  selectedText?: string,
): LineRangeAnnotation | null {
  const start = Math.max(1, startLine)
  const end = Math.min(endLine, Math.max(1, lines.length))
  if (end < start) return null
  const bounded = selectedText === undefined ? undefined : boundSelectedText(selectedText)
  return {
    path: file?.path ?? primaryPath,
    startLine: start,
    endLine: end,
    quote: lines.slice(start - 1, end).join('\n'),
    ...(bounded === undefined ? {} : { selectedText: bounded }),
  }
}

/** Whether the rail should offer one more older page. */
export function olderEntryVisible(hasOlder: boolean, before: string | null): boolean {
  return hasOlder && before !== null
}

/** Whether one key event is an unhandled Escape. */
export function isEscapeKey(event: { readonly key: string; readonly defaultPrevented: boolean }): boolean {
  return event.key === 'Escape' && !event.defaultPrevented
}

/** Whether Escape may close the narrow drawer (the header menu wins first). */
export function drawerClosesOnEscape(narrow: boolean, showRail: boolean, menuOpen: boolean): boolean {
  return narrow && showRail && !menuOpen
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

/** One line's pin: the thread ordinal and the state that colours it. */
export interface ThreadPin {
  readonly ordinal: number
  readonly tone: 'open' | 'stale' | 'resolved'
}

/** Thread ordinal by thread id, numbered in the rail's sorted order. */
export function threadOrdinals(threads: readonly WorkItemThread[]): ReadonlyMap<string, number> {
  return new Map(threads.map((thread, index) => [thread.threadId, index + 1]))
}

/**
 * The pin shown on each anchored line.
 *
 * A line keeps the first thread that starts there; later threads on the same
 * line still appear in the rail and in the footer. Threads without a line
 * anchor get no pin.
 * @param threads - threads in rail order, so ordinals match the anchor chips.
 * @returns one pin per anchored line.
 */
export function threadLinePins(threads: readonly WorkItemThread[]): ReadonlyMap<number, ThreadPin> {
  const pins = new Map<number, ThreadPin>()
  threads.forEach((thread, index) => {
    if (thread.anchor === null || thread.anchor.kind !== 'line-range') return
    const line = thread.anchor.startLine
    if (pins.has(line)) return
    const tone = thread.resolved ? 'resolved' : (thread.anchorStatus === 'stale' ? 'stale' : 'open')
    pins.set(line, { ordinal: index + 1, tone })
  })
  return pins
}

/** Elapsed time in the demo's activity form: `18 秒`, `3 分钟`, `2 小时`, `4 天`. */
export function formatElapsed(iso: string, now: Date): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return ''
  const seconds = Math.max(0, Math.floor((now.getTime() - time) / 1000))
  if (seconds < 60) return `${String(seconds)} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)} 小时`
  return `${String(Math.floor(hours / 24))} 天`
}

/** Local wall-clock time as `HH:mm`; invalid input renders an empty string. */
export function formatClock(iso: string): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return ''
  const date = new Date(time)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** Delivery state as the thread state row phrases it. */
export function dispatchDetailLabel(state: DispatchState): string {
  if (state === 'thinking') return '已送达 · 模型思考中'
  if (state === 'working') return '模型改文件中'
  return dispatchLabel(state)
}

/** The thread that carried one dispatch batch, if it is in the rail. */
export function threadForDispatch(
  dispatchId: string,
  dispatches: readonly ArtifactDispatchSummary[],
  threads: readonly WorkItemThread[],
): WorkItemThread | null {
  const dispatch = dispatches.find((entry) => entry.dispatchId === dispatchId)
  if (dispatch === undefined) return null
  const commentIds = new Set(dispatch.commentIds)
  return threads.find((thread) => thread.comments.some((event) => commentIds.has(event.commentId))) ?? null
}

/**
 * The viewer footer's delivery line: replied ordinals, in-flight batches, and
 * anchors whose position moved.
 * @param threads - threads in rail order, so ordinals match the anchor chips.
 * @param dispatches - the detail response's newest batch per thread.
 * @returns a `·` separated summary, or `还没有模型回复`.
 */
export function deliverySummary(
  threads: readonly WorkItemThread[],
  dispatches: readonly ArtifactDispatchSummary[],
): string {
  const replied: string[] = []
  const active: string[] = []
  const stale: string[] = []
  threads.forEach((thread, index) => {
    const ordinal = `#${String(index + 1)}`
    if (thread.anchorStatus === 'stale') {
      stale.push(ordinal)
      return
    }
    const dispatch = dispatchForThread(thread, dispatches)
    if (dispatch === null) return
    if (dispatch.state === 'replied') replied.push(ordinal)
    else active.push(`${ordinal} ${DISPATCH_STATE_LABELS[dispatch.state]}`)
  })
  const parts: string[] = []
  if (replied.length > 0) parts.push(`模型已回复 ${replied.join('、')}`)
  if (active.length > 0) parts.push(active.join('、'))
  if (stale.length > 0) parts.push(`${stale.join('、')} 位置待确认`)
  return parts.length === 0 ? '还没有模型回复' : parts.join(' · ')
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
  readonly kind: 'text' | 'h1' | 'h2' | 'h3' | 'list' | 'quote' | 'code' | 'fence'
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

/**
 * Classify a whole document, tracking fenced code blocks.
 *
 * Fence marker lines keep their row (line numbers stay aligned with the stored
 * file) but render empty; the lines between them render in the code style.
 * @param lines - stored file lines.
 * @returns one classification per line, in order.
 */
export function markdownLines(lines: readonly string[]): ReadLine[] {
  let fenced = false
  return lines.map((line) => {
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced
      return { kind: 'fence', text: '' }
    }
    if (fenced) return { kind: 'code', text: line }
    return markdownLine(line)
  })
}

/** Session title, kept snapshots, and publish log carried by the detail response. */
export interface DetailMeta {
  readonly sessionTitle: string | null
  readonly revisions: readonly number[]
  /**
   * Published attachments in publish order; null when this host/record predates
   * `attachments.jsonl` and the page must fall back to comment refs.
   */
  readonly publishedAttachments: readonly AttachmentPublishV1[] | null
}

/**
 * Detail metadata with the previous view's values as a fallback.
 * @param detail - the freshly fetched detail.
 * @param fallback - the values already on screen, if any.
 * @returns normalized title and snapshot list.
 */
export function detailMeta(
  detail: Pick<ArtifactDetailResponse, 'sessionTitle' | 'revisions' | 'publishedAttachments'>,
  fallback?: DetailMeta,
): DetailMeta {
  return {
    sessionTitle: detail.sessionTitle ?? fallback?.sessionTitle ?? null,
    revisions: detail.revisions ?? fallback?.revisions ?? [],
    publishedAttachments: detail.publishedAttachments ?? fallback?.publishedAttachments ?? null,
  }
}

/** One visible viewer tab. */
export interface ViewerTab {
  readonly id: 'document' | 'versions' | 'attachments'
  readonly label: string
}

/**
 * Tab labels for the viewer toolbar.
 * @param revisions - kept snapshot count.
 * @param attachments - attachment count.
 * @returns the three tabs in display order.
 */
export function viewerTabs(revisions: number, attachments: number): readonly ViewerTab[] {
  return [
    { id: 'document', label: '文档' },
    { id: 'versions', label: revisions === 0 ? '版本' : `版本 ${String(revisions)}` },
    { id: 'attachments', label: attachments === 0 ? '附件' : `附件 ${String(attachments)}` },
  ]
}

/** The last path segment, used by file headers and exports. */
export function baseName(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? path : path.slice(cut + 1)
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

/** The owner-side draft lookup: a cross-session preview reads no draft. */
export function readOwnDraft(artifactId: string, crossSession: boolean): PersistedDraft | null {
  return crossSession ? null : readPersistedDraft(artifactId)
}

/** The owner context and file one save may address, or null when it may not. */
export function saveTarget<
  Owner extends { readonly ownerSessionId: string; readonly artifactId: string },
  File extends { readonly path: string },
>(
  readOnly: boolean,
  context: Owner | null,
  file: File | null,
): { readonly owner: Owner; readonly file: File } | null {
  if (readOnly) return null
  if (context === null || file === null) return null
  return { owner: context, file }
}

/** A compact attachment size label. */
export function formatBytes(size: number): string {
  if (size < 1024) return `${String(size)} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
