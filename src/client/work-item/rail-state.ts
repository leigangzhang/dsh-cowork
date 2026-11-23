/**
 * Two-level comment-rail navigation and its list projection.
 *
 * The rail has a read-only list of thread summaries and one thread's session
 * (message log plus the reply composer). The viewer keeps this state beside
 * `showRail`; every transition is a pure function so the navigation rules are
 * unit-tested without React: opening the rail always shows the list, a card,
 * pin, or new annotation enters the session, the back entry returns, and
 * switching work items resets both.
 */
import { threadRailView, type ThreadFilter, type WorkItemThread } from './model.ts'

/** Which of the rail's two levels is visible. */
export type RailView = 'list' | 'session'

/** The rail's two-level navigation state. */
export interface RailState {
  readonly view: RailView
  /** Thread whose session is open; null while a new annotation has no thread. */
  readonly activeThreadId: string | null
}

/** The list level with no active thread; every reset returns this value. */
export const RAIL_LIST_STATE: RailState = Object.freeze({ view: 'list', activeThreadId: null })

/**
 * The session level for one thread.
 * @param threadId - the thread to show, or null for a new annotation that has
 * no thread yet (the composer submits it).
 * @returns the session navigation state.
 */
export function railSessionState(threadId: string | null): RailState {
  return { view: 'session', activeThreadId: threadId }
}

/**
 * Back to the list level.
 *
 * The draft lives in the viewer, so returning never touches it; only the
 * session target is dropped.
 */
export function railBackToList(): RailState {
  return RAIL_LIST_STATE
}

/** Switching work items drops both the level and the active thread. */
export function railAfterContextChange(): RailState {
  return RAIL_LIST_STATE
}

/**
 * The thread a session level points at.
 * @param threads - folded threads in rail order.
 * @param state - current rail navigation state.
 * @returns the active thread, or null when no thread is targeted or the log no
 * longer carries it.
 */
export function railSessionThread(
  threads: readonly WorkItemThread[],
  state: RailState,
): WorkItemThread | null {
  const threadId = state.activeThreadId
  if (threadId === null) return null
  return threads.find((thread) => thread.threadId === threadId) ?? null
}

/**
 * The ordinal of one thread, or null when it is not in the list.
 * @param threads - folded threads in rail order, matching `threadOrdinals`.
 * @param threadId - thread to locate.
 */
export function railOrdinal(
  threads: readonly WorkItemThread[],
  threadId: string | null,
): number | null {
  if (threadId === null) return null
  const index = threads.findIndex((thread) => thread.threadId === threadId)
  return index === -1 ? null : index + 1
}

/** One read-only row of the list level. */
export interface RailListRow {
  readonly thread: WorkItemThread
  /** 1-based position rendered as the `#N` chip. */
  readonly ordinal: number
  /** The row carries the rail's selection ring. */
  readonly selected: boolean
}

/** Everything the list level renders for one filter and resolved state. */
export interface RailListProjection {
  readonly open: readonly RailListRow[]
  /** Resolved rows to render; empty while the resolved summary is collapsed. */
  readonly resolved: readonly RailListRow[]
  readonly resolvedCount: number
  /** First resolved row, for the collapsed summary's `#N` and excerpt. */
  readonly resolvedFirst: RailListRow | null
  readonly showSummary: boolean
  readonly emptyMessage: string | null
}

/**
 * Project the folded threads into the list level's rows.
 *
 * The filter/resolved rules stay in `threadRailView` (their single home); this
 * adds only the list-level per-row ordinal and selection ring.
 * @param threads - folded threads in rail order.
 * @param ordinals - thread id → ordinal, from `threadOrdinals`.
 * @param filter - active three-state filter.
 * @param showResolved - whether the resolved summary was expanded.
 * @param selectedThreadId - thread that carries the selection ring.
 * @returns rows split by group plus the empty and summary state.
 */
export function railListProjection(
  threads: readonly WorkItemThread[],
  ordinals: ReadonlyMap<string, number>,
  filter: ThreadFilter,
  showResolved: boolean,
  selectedThreadId: string | null,
): RailListProjection {
  const view = threadRailView(threads, filter, showResolved)
  const row = (thread: WorkItemThread): RailListRow => ({
    thread,
    ordinal: ordinals.get(thread.threadId) ?? 1,
    selected: thread.threadId === selectedThreadId,
  })
  return {
    open: view.visible.map(row),
    resolved: view.showResolvedCards ? view.resolved.map(row) : [],
    resolvedCount: view.resolved.length,
    resolvedFirst: view.resolved[0] === undefined ? null : row(view.resolved[0]),
    showSummary: view.showSummary,
    emptyMessage: view.emptyMessage,
  }
}
