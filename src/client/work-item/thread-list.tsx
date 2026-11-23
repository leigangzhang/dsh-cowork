/**
 * The comment rail's filter header and thread list.
 *
 * The container keeps the draft, reply target, and request context; this file
 * owns only the visible thread projection (open cards, resolved summary, and
 * the three-state filter).
 */
import type { ReactElement, ReactNode } from 'react'
import type { ArtifactDispatchSummary } from '../../panel/artifact-contract.js'
import {
  commentBody,
  dispatchForThread,
  threadRailView,
  type ThreadFilter,
  type WorkItemThread,
} from './model.ts'
import { ThreadCard } from './thread-card.tsx'

/** Props of the comment rail list. */
interface ThreadListProps {
  readonly threads: readonly WorkItemThread[]
  readonly ordinals: ReadonlyMap<string, number>
  readonly selectedThreadId: string | null
  readonly pendingThread: string | null
  readonly now: Date
  readonly dispatches: readonly ArtifactDispatchSummary[]
  readonly retrying: boolean
  readonly filter: ThreadFilter
  readonly showResolved: boolean
  /** The comments route holds a page older than the loaded one. */
  readonly hasOlder: boolean
  readonly loadingOlder: boolean
  /** Narrow layout: the rail is a drawer over the content. */
  readonly drawer: boolean
  /** Cross-session preview: reply and resolve stay visible but disabled. */
  readonly readOnly: boolean
  readonly children?: ReactNode
  readonly onFilter: (filter: ThreadFilter) => void
  readonly onToggleResolved: () => void
  readonly onSelect: (thread: WorkItemThread) => void
  readonly onToggle: (thread: WorkItemThread) => void
  readonly onReply: (thread: WorkItemThread) => void
  readonly onRetry: (dispatch: ArtifactDispatchSummary) => void
  readonly onFocus: (thread: WorkItemThread) => void
  readonly onLoadOlder: () => void
  readonly onCloseDrawer: () => void
  readonly attachmentUrl: (attachmentId: string) => string
}

/** The resolved-summary label: count, first ordinal, and a short excerpt. */
function rootText(thread: WorkItemThread): string {
  const root = thread.comments.find((event) => event.type === 'create')
  return root !== undefined && 'body' in root ? commentBody(root) : ''
}

/** The resolved-summary label: count, first ordinal, and a short excerpt. */
function resolvedSummary(threads: readonly WorkItemThread[], ordinals: ReadonlyMap<string, number>): string {
  const first = threads[0]
  if (first === undefined) return ''
  const text = rootText(first)
  const hint = text.length > 28 ? `${text.slice(0, 28)}…` : text
  const ordinal = ordinals.get(first.threadId)
  return `已解决 ${String(threads.length)} 条：${ordinal === undefined ? '' : `#${String(ordinal)} `}${hint}`
}

/** One rail card; resolved cards render open when their group is expanded. */
function card(thread: WorkItemThread, props: ThreadListProps, open: boolean): ReactElement {
  return (
    <ThreadCard
      key={thread.threadId}
      thread={thread}
      ordinal={props.ordinals.get(thread.threadId) ?? 1}
      selected={props.selectedThreadId === thread.threadId}
      now={props.now}
      pending={props.pendingThread === thread.threadId}
      dispatch={dispatchForThread(thread, props.dispatches)}
      retrying={props.retrying}
      readOnly={props.readOnly}
      expandedByGroup={open}
      onSelect={() => { props.onSelect(thread) }}
      onToggle={() => { props.onToggle(thread) }}
      onReply={() => { props.onReply(thread) }}
      onRetry={props.onRetry}
      onFocus={() => { props.onFocus(thread) }}
      attachmentUrl={props.attachmentUrl}
    />
  )
}

/**
 * Render the rail filter and thread list.
 * @param props - threads, filter state, and callbacks owned by the container.
 * @returns the rail header, optional activity slot, and thread cards.
 */
// Projection lives in `threadRailView` (unit-tested); this is display branches.
// fallow-ignore-next-line complexity
export function ThreadList(props: ThreadListProps): ReactElement {
  const view = threadRailView(props.threads, props.filter, props.showResolved)
  return (
    <>
      <div className="cwi-rail-header" data-testid="cwi-thread-count">
        <div className="cwi-rail-head-row">
          <span className="cwi-rail-title">批注</span>
          <span className="cwi-count-pill">{props.threads.length}</span>
          <span className="cwi-rail-spacer" />
          <span className="cwi-rail-sort">按位置排序</span>
          {props.drawer ? (
            <button
              type="button"
              className="cwi-rail-close"
              data-testid="cwi-rail-close"
              aria-label="收起批注面板"
              onClick={props.onCloseDrawer}
            >
              收起
            </button>
          ) : null}
        </div>
        <div className="cwi-rail-tools">
          <select
            className="cwi-select"
            data-testid="cwi-thread-filter"
            aria-label="评论筛选"
            value={props.filter}
            onChange={(event) => { props.onFilter(event.target.value as ThreadFilter) }}
          >
            <option value="all">全部评论</option>
            <option value="pending">待处理</option>
            <option value="resolved">已解决</option>
          </select>
          <label className="cwi-switch">
            <input
              type="checkbox"
              data-testid="cwi-rail-pending-filter"
              checked={props.filter === 'pending'}
              onChange={(event) => { props.onFilter(event.target.checked ? 'pending' : 'all') }}
            />
            <span className="cwi-switch-track" aria-hidden="true"><span className="cwi-switch-thumb" /></span>
            只看待处理
          </label>
        </div>
      </div>
      {props.children}
      <div className="cwi-threads">
        {props.hasOlder ? (
          <button
            type="button"
            className="cwi-older"
            data-testid="cwi-load-older"
            disabled={props.loadingOlder}
            onClick={props.onLoadOlder}
          >
            {props.loadingOlder ? '加载中…' : '加载更早的批注'}
          </button>
        ) : null}
        {view.emptyMessage === null ? null : <p className="cwi-rail-empty">{view.emptyMessage}</p>}
        {view.visible.map((thread) => card(thread, props, false))}
        {view.showSummary ? (
          <button
            type="button"
            className="cwi-resolved-line"
            data-testid="cwi-resolved-line"
            aria-expanded={props.showResolved}
            onClick={props.onToggleResolved}
          >
            <span className="cwi-resolved-dot" aria-hidden="true">✓</span>
            <span className="cwi-resolved-text">
              {props.showResolved ? `收起已解决 ${String(view.resolved.length)} 条` : resolvedSummary(view.resolved, props.ordinals)}
            </span>
            <span className="cwi-resolved-arrow" aria-hidden="true">{props.showResolved ? '⌃' : '›'}</span>
          </button>
        ) : null}
        {view.showResolvedCards ? view.resolved.map((thread) => card(thread, props, true)) : null}
      </div>
    </>
  )
}
