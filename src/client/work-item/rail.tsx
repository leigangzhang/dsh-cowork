/**
 * The comment rail's two levels: the read-only thread list and one session.
 *
 * The list level shows summary cards, the filter header, and the resolved
 * summary; it holds no composer and no reply control. The session level shows
 * one thread's message log (user comments, model replies, attachments, and
 * delivery state) plus the reply composer. The module also owns that two-level
 * navigation (`useRailNavigation`); the viewer keeps the loaded data and the
 * composer's draft so returning to the list never loses it.
 */
import { useCallback, useState } from 'react'
import type { Dispatch, ReactElement, Ref, SetStateAction } from 'react'
import type {
  ActiveDispatchV1,
  ArtifactAnchor,
  ArtifactDispatchSummary,
  AttachmentRefV1,
} from '../../panel/artifact-contract.js'
import {
  activeDispatchSummary,
  anchorLabel,
  dispatchDetailLabel,
  dispatchForThread,
  formatElapsed,
  type LineSelection,
  type ThreadFilter,
  type WorkItemThread,
} from './model.ts'
import {
  RAIL_LIST_STATE,
  railAfterContextChange,
  railBackToList,
  railListProjection,
  railOrdinal,
  railSessionState,
  railSessionThread,
  type RailState,
} from './rail-state.ts'
import { CommentComposer } from './comment-composer.tsx'
import { ThreadCard } from './thread-card.tsx'
import { ThreadList } from './thread-list.tsx'

/** The reader of one anchor's quote: line ranges carry it, other kinds do not. */
function anchorQuote(anchor: ArtifactAnchor | null): string {
  return anchor !== null && 'quote' in anchor ? anchor.quote : ''
}

/** The selected part of a line-range anchor, when the user saved one. */
function anchorSelectedText(anchor: ArtifactAnchor | null): string | null {
  return anchor !== null && anchor.kind === 'line-range' ? (anchor.selectedText ?? null) : null
}

/** The model-activity strip above the list, or null while no dispatch runs. */
// Absent dispatch, tone, and age are the strip's visible states.
// fallow-ignore-next-line complexity
function ActivityStrip({ dispatch, ordinal, now }: {
  readonly dispatch: ActiveDispatchV1 | null
  readonly ordinal: number | null
  readonly now: Date
}): ReactElement | null {
  if (dispatch === null) return null
  return (
    <div
      className="cwi-activity"
      data-tone={activeDispatchSummary(dispatch)?.tone ?? 'active'}
      data-testid="cwi-activity-strip"
    >
      <span className="cwi-activity-dot" aria-hidden="true" />
      <span className="cwi-activity-label">
        模型正在处理{ordinal === null ? '' : ` #${String(ordinal)}`}：{dispatchDetailLabel(dispatch.state)}
      </span>
      <span className="cwi-activity-age">{formatElapsed(dispatch.updatedAt, now)}</span>
    </div>
  )
}

/** Viewer toolbars the rail navigation can show. */
type RailViewTab = 'document' | 'versions' | 'attachments'

/** Viewer state setters the rail navigation writes. */
export interface RailNavigationSinks {
  readonly setSelectedThreadId: Dispatch<SetStateAction<string | null>>
  readonly setViewTab: Dispatch<SetStateAction<RailViewTab>>
  readonly setSelection: Dispatch<SetStateAction<LineSelection | null>>
  readonly setReadFocusLine: Dispatch<SetStateAction<number | null>>
  readonly setReadFocusToken: Dispatch<SetStateAction<number>>
  readonly setReplyTarget: Dispatch<SetStateAction<WorkItemThread | null>>
}

/** Two-level rail state plus the navigation the toolbar, cards, and pins use. */
export interface RailNavigation {
  readonly showRail: boolean
  readonly state: RailState
  /**
   * Reading-surface sink: `true` opens the session level for a new annotation,
   * which has no thread until its comment is submitted.
   */
  readonly setShowRail: (visible: boolean) => void
  /** Toolbar "批注 N": open at the list level, or collapse the rail. */
  readonly toggleRail: () => void
  /** Enter one thread's session, or a new annotation's when id is null. */
  readonly openSession: (threadId: string | null) => void
  /** Card/pin entry: enter the thread's session and locate its anchor. */
  readonly openThread: (thread: WorkItemThread) => void
  /** Scroll to an anchor without changing the rail level. */
  readonly focusAnchor: (thread: WorkItemThread) => void
  /** Session header "← 返回批注列表"; the composer draft stays untouched. */
  readonly backToList: () => void
  /** Drawer/backdrop close; the next open starts from the list level. */
  readonly closeRail: () => void
  /** Another work item: drop the level, target, filter, and resolved group. */
  readonly reset: () => void
}

/**
 * Own the rail's two-level navigation for one viewer.
 *
 * The viewer keeps the loaded data and the composer state; this hook keeps the
 * level, the active thread, and whether the rail is visible, so the viewer
 * container stays wiring rather than rail state.
 * @param sinks - viewer state setters the navigation writes.
 * @returns the current level and every navigation entry point.
 */
export function useRailNavigation(sinks: RailNavigationSinks): RailNavigation {
  const [showRail, setShowVisible] = useState(false)
  const [state, setState] = useState<RailState>(RAIL_LIST_STATE)
  const {
    setSelectedThreadId, setViewTab, setSelection,
    setReadFocusLine, setReadFocusToken, setReplyTarget,
  } = sinks

  const focusAnchor = useCallback((thread: WorkItemThread) => {
    setSelectedThreadId(thread.threadId)
    const anchor = thread.anchor
    if (anchor === null || anchor.kind !== 'line-range') return
    setViewTab('document')
    setSelection({ startLine: anchor.startLine, endLine: anchor.endLine })
    setReadFocusLine(anchor.startLine)
    setReadFocusToken(token => token + 1)
    requestAnimationFrame(() => {
      document.querySelector(`[data-line="${String(anchor.startLine)}"]`)?.scrollIntoView({ block: 'center' })
    })
  }, [setReadFocusLine, setReadFocusToken, setSelectedThreadId, setSelection, setViewTab])

  const openSession = useCallback((threadId: string | null) => {
    setState(railSessionState(threadId))
    setShowVisible(true)
  }, [])

  const openThread = useCallback((thread: WorkItemThread) => {
    // A reply target belongs to its thread; another thread's session starts clean.
    setReplyTarget(current => (current !== null && current.threadId !== thread.threadId ? null : current))
    openSession(thread.threadId)
    focusAnchor(thread)
  }, [focusAnchor, openSession, setReplyTarget])

  const setShowRail = useCallback((visible: boolean) => {
    if (visible) setState(railSessionState(null))
    setShowVisible(visible)
  }, [])

  const toggleRail = useCallback(() => {
    if (showRail) {
      setShowVisible(false)
      return
    }
    setState(RAIL_LIST_STATE)
    setShowVisible(true)
  }, [showRail])

  const backToList = useCallback(() => {
    setState(railBackToList())
    setReplyTarget(null)
  }, [setReplyTarget])

  const closeRail = useCallback(() => { setShowVisible(false) }, [])

  const reset = useCallback(() => { setState(railAfterContextChange()) }, [])

  return {
    showRail, state, setShowRail, toggleRail, openSession, openThread,
    focusAnchor, backToList, closeRail, reset,
  }
}

/** Props of the comment rail. */
export interface CommentRailProps {
  /** `showRail`: the rail is mounted but hidden until the toolbar opens it. */
  readonly visible: boolean
  /** The list or session level the viewer selected. */
  readonly state: RailState
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
  readonly activeDispatch: ActiveDispatchV1 | null
  readonly activeOrdinal: number | null
  readonly draft: string
  readonly composerRef: Ref<HTMLTextAreaElement>
  readonly pendingAttachments: readonly AttachmentRefV1[]
  readonly uploading: boolean
  readonly submitting: boolean
  readonly receipt: string | null
  readonly replyTarget: WorkItemThread | null
  readonly pendingAnchor: ArtifactAnchor | null
  readonly onFilter: (filter: ThreadFilter) => void
  readonly onToggleResolved: () => void
  /** Enter the session level for one thread (card click, pin, locate). */
  readonly onEnterThread: (thread: WorkItemThread) => void
  /** Scroll the document to the thread's anchor without leaving the level. */
  readonly onLocate: (thread: WorkItemThread) => void
  readonly onToggle: (thread: WorkItemThread) => void
  readonly onReply: (thread: WorkItemThread) => void
  readonly onRetry: (dispatch: ArtifactDispatchSummary) => void
  readonly onLoadOlder: () => void
  readonly onCloseDrawer: () => void
  /** The session header's "← 返回批注列表". */
  readonly onBackToList: () => void
  readonly attachmentUrl: (attachmentId: string) => string
  readonly onDraft: (value: string) => void
  readonly onCancelReply: () => void
  readonly onCancelAnchor: () => void
  readonly onAttach: (files: FileList | readonly File[] | null) => void
  readonly onRemoveAttachment: (attachmentId: string) => void
  readonly onSubmit: () => void
}

/** The drawer's close control; the list header and session header each own one. */
function DrawerClose({ onClick }: { readonly onClick: () => void }): ReactElement {
  return (
    <button
      type="button"
      className="cwi-rail-close"
      data-testid="cwi-rail-close"
      aria-label="收起批注面板"
      onClick={onClick}
    >
      收起
    </button>
  )
}

/** The session header: back to the list, the `#N` chip, and the anchor. */
// Back/ordinal/anchor/drawer-close branches are the header's state matrix.
// fallow-ignore-next-line complexity
function SessionHead({ thread, pendingAnchor, ordinal, drawer, onBackToList, onCloseDrawer }: {
  readonly thread: WorkItemThread | null
  readonly pendingAnchor: ArtifactAnchor | null
  readonly ordinal: number | null
  readonly drawer: boolean
  readonly onBackToList: () => void
  readonly onCloseDrawer: () => void
}): ReactElement {
  const anchor = thread === null ? pendingAnchor : thread.anchor
  const selectedText = anchorSelectedText(anchor)
  const quote = anchorQuote(anchor)
  return (
    <div className="cwi-rail-header cwi-rail-session-head" data-testid="cwi-rail-session-head">
      <div className="cwi-rail-head-row">
        <button
          type="button"
          className="cwi-rail-back"
          data-testid="cwi-rail-back"
          onClick={onBackToList}
        >
          ← 返回批注列表
        </button>
        <span className="cwi-rail-spacer" />
        {ordinal === null ? null : (
          <span
            className="cwi-anchor-chip"
            data-tone={thread !== null && thread.resolved ? 'done' : 'open'}
          >
            #{ordinal}
          </span>
        )}
        {drawer ? <DrawerClose onClick={onCloseDrawer} /> : null}
      </div>
      <div className="cwi-rail-session-anchor">
        <span className="cwi-thread-anchor">{anchorLabel(anchor)}</span>
        {selectedText === null
          ? (quote === '' ? null : <span className="cwi-rail-quote" data-testid="cwi-rail-quote">{quote}</span>)
          : <span className="cwi-rail-selection" data-testid="cwi-rail-selection" title={selectedText}>{selectedText}</span>}
      </div>
    </div>
  )
}

/** The session level: header, one thread's message log, and the composer. */
// Header/log/composer composition; the empty new-annotation session is one branch.
// fallow-ignore-next-line complexity
function RailSession(props: CommentRailProps): ReactElement {
  const thread = railSessionThread(props.threads, props.state)
  const ordinal = thread === null ? null : railOrdinal(props.threads, thread.threadId)
  return (
    <div className="cwi-rail-session" data-testid="cwi-rail-session">
      <SessionHead
        thread={thread}
        pendingAnchor={props.pendingAnchor}
        ordinal={ordinal}
        drawer={props.drawer}
        onBackToList={props.onBackToList}
        onCloseDrawer={props.onCloseDrawer}
      />
      <div className="cwi-threads cwi-rail-session-log">
        {thread === null
          ? <p className="cwi-rail-empty">新批注：写好后提交，会出现在批注列表。</p>
          : (
              <ThreadCard
                thread={thread}
                ordinal={ordinal ?? 1}
                selected={props.selectedThreadId === thread.threadId}
                expandedByGroup
                now={props.now}
                pending={props.pendingThread === thread.threadId}
                dispatch={dispatchForThread(thread, props.dispatches)}
                retrying={props.retrying}
                readOnly={props.readOnly}
                onSelect={() => { props.onEnterThread(thread) }}
                onToggle={() => { props.onToggle(thread) }}
                onReply={() => { props.onReply(thread) }}
                onRetry={props.onRetry}
                onFocus={() => { props.onLocate(thread) }}
                attachmentUrl={props.attachmentUrl}
              />
            )}
      </div>
      <CommentComposer
        replyTarget={props.replyTarget}
        pendingAnchor={props.pendingAnchor}
        draft={props.draft}
        composerRef={props.composerRef}
        pendingAttachments={props.pendingAttachments}
        uploading={props.uploading}
        submitting={props.submitting}
        receipt={props.visible ? props.receipt : null}
        readOnly={props.readOnly}
        onDraft={props.onDraft}
        onCancelReply={props.onCancelReply}
        onCancelAnchor={props.onCancelAnchor}
        onAttach={props.onAttach}
        onRemoveAttachment={props.onRemoveAttachment}
        onSubmit={props.onSubmit}
      />
    </div>
  )
}

/** The list level: filter header, activity strip, summary cards, resolved summary. */
function RailList(props: CommentRailProps): ReactElement {
  const projection = railListProjection(
    props.threads,
    props.ordinals,
    props.filter,
    props.showResolved,
    props.selectedThreadId,
  )
  return (
    <div className="cwi-rail-list" data-testid="cwi-rail-list">
      <ThreadList
        threads={props.threads}
        ordinals={props.ordinals}
        selectedThreadId={props.selectedThreadId}
        pendingThread={props.pendingThread}
        now={props.now}
        dispatches={props.dispatches}
        retrying={props.retrying}
        filter={props.filter}
        showResolved={props.showResolved}
        projection={projection}
        hasOlder={props.hasOlder}
        loadingOlder={props.loadingOlder}
        drawer={props.drawer}
        readOnly={props.readOnly}
        onFilter={props.onFilter}
        onToggleResolved={props.onToggleResolved}
        onSelect={props.onEnterThread}
        onToggle={props.onToggle}
        onRetry={props.onRetry}
        onFocus={props.onLocate}
        onLoadOlder={props.onLoadOlder}
        onCloseDrawer={props.onCloseDrawer}
        attachmentUrl={props.attachmentUrl}
      >
        <ActivityStrip dispatch={props.activeDispatch} ordinal={props.activeOrdinal} now={props.now} />
      </ThreadList>
    </div>
  )
}

/**
 * Render the comment rail at the level the viewer selected.
 * @param props - rail state, loaded threads, composer state, and callbacks.
 * @returns the rail aside; hidden while the toolbar keeps it collapsed.
 */
export function CommentRail(props: CommentRailProps): ReactElement {
  return (
    <aside
      className="cwi-rail"
      data-testid="cwi-rail"
      data-drawer={String(props.drawer)}
      data-view={props.state.view}
      hidden={!props.visible}
    >
      {props.state.view === 'session' ? <RailSession {...props} /> : <RailList {...props} />}
    </aside>
  )
}
