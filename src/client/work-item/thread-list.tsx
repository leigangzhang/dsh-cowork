/**
 * The comment rail's list level: filter header and read-only thread summaries.
 *
 * The container keeps the draft, the session target, and the request context;
 * this file owns only the visible thread projection (open cards, resolved
 * summary, and the three-state filter). Its summary cards hold no reply
 * control and no composer: a card click enters the session level.
 */
import type { ReactElement, ReactNode } from 'react'
import type { ArtifactDispatchSummary } from '../../panel/artifact-contract.js'
import {
  commentBody,
  dispatchForThread,
  type ThreadFilter,
  type WorkItemThread,
} from './model.ts'
import type { RailListProjection, RailListRow } from './rail-state.ts'
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
  /** Rows for the active filter and resolved state. */
  readonly projection: RailListProjection
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
function resolvedSummary(
  first: RailListRow | null,
  count: number,
  ordinals: ReadonlyMap<string, number>,
): string {
  if (first === null) return ''
  const text = rootText(first.thread)
  const hint = text.length > 28 ? `${text.slice(0, 28)}…` : text
  const ordinal = ordinals.get(first.thread.threadId)
  return `已解决 ${String(count)} 条：${ordinal === undefined ? '' : `#${String(ordinal)} `}${hint}`
}

/**
 * One rail summary card; the list level never expands a thread inline.
 *
 * A summary card renders no reply and no resolve control, so those callbacks
 * cannot fire: the container's resolve callback passes through unchanged and
 * the optional reply callback stays unset, instead of wrapping calls the list
 * level can never make.
 */
function card(row: RailListRow, props: ThreadListProps): ReactElement {
  return (
    <ThreadCard
      key={row.thread.threadId}
      thread={row.thread}
      ordinal={row.ordinal}
      selected={row.selected}
      summaryOnly
      now={props.now}
      pending={props.pendingThread === row.thread.threadId}
      dispatch={dispatchForThread(row.thread, props.dispatches)}
      retrying={props.retrying}
      readOnly={props.readOnly}
      onSelect={() => { props.onSelect(row.thread) }}
      onToggle={props.onToggle}
      onRetry={props.onRetry}
      onFocus={() => { props.onFocus(row.thread) }}
      attachmentUrl={props.attachmentUrl}
    />
  )
}

/**
 * Render the rail filter and thread list.
 * @param props - threads, filter state, and callbacks owned by the container.
 * @returns the rail header, optional activity slot, and thread cards.
 */
// Header/filter/summary/card display matrix; the row projection is unit-tested
// in rail-state.ts and the browser lane owns the rendered states.
// fallow-ignore-next-line complexity
export function ThreadList(props: ThreadListProps): ReactElement {
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
        {props.projection.emptyMessage === null
          ? null
          : <p className="cwi-rail-empty">{props.projection.emptyMessage}</p>}
        {props.projection.open.map((row) => card(row, props))}
        {props.projection.showSummary ? (
          <button
            type="button"
            className="cwi-resolved-line"
            data-testid="cwi-resolved-line"
            aria-expanded={props.showResolved}
            onClick={props.onToggleResolved}
          >
            <span className="cwi-resolved-dot" aria-hidden="true">✓</span>
            <span className="cwi-resolved-text">
              {props.showResolved
                ? `收起已解决 ${String(props.projection.resolvedCount)} 条`
                : resolvedSummary(props.projection.resolvedFirst, props.projection.resolvedCount, props.ordinals)}
            </span>
            <span className="cwi-resolved-arrow" aria-hidden="true">{props.showResolved ? '⌃' : '›'}</span>
          </button>
        ) : null}
        {props.projection.resolved.map((row) => card(row, props))}
      </div>
    </>
  )
}
