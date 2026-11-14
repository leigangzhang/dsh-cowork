/**
 * The Cowork panel shell (topic-page v2 + request inbox): project header,
 * receipts, the topic list and the request inbox.
 *
 * The panel measures its own content width with a `ResizeObserver` and renders
 * two layouts: at >= 620px a fixed topic column next to an independently
 * scrolling inbox column; below that only the topic list plus a "需要你处理 N 项"
 * banner that opens the inbox full-width inside the panel (the host has no
 * right-bar width setter, so nothing here touches host DOM). The inbox has its
 * own load/error state, so a failed inbox read never blocks the topic list.
 *
 * Topic writes are optimistic: the card moves group first, the request follows,
 * and a failure rolls that one card back and leaves a visible receipt. Inbox
 * writes validate the visible action, block double submits, replace the row with
 * the server's item and keep a per-row receipt; a prompt failure is a warning,
 * never a fabricated reply.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  errorMessage,
  loadInbox,
  loadOverview,
  openInboxTarget,
  reopenTopic,
  resolveInboxRequest,
  resolveTopic,
  toPanelError,
  type WireOverview,
  type WireTopic,
} from './api.ts'
import { actionAllowed, type InboxResponse, type RequestAction } from '../panel/inbox-contract.ts'
import {
  CLOCK_TICK_MS,
  FEEDBACK_TTL_MS,
  PROJECT_PATH_MAX_CHARS,
  archiveSuccessMessage,
  buildTopicViewModel,
  emptyNotice,
  errorPresentation,
  masterBreadcrumbLabel,
  masterBreadcrumbTarget,
  middleEllipsis,
  openSessionFailureMessage,
  openSessionMessage,
  openSessionUnavailableMessage,
  openTopicSteps,
  restoreSuccessMessage,
  surfaceState,
  writeFailureMessage,
  type ActionFeedback,
  type PanelSurfaceState,
} from './model.ts'
import type { FooterActionOwnerProps, PanelErrorInfo, TabBodyProps } from './contracts.ts'
import { COWORK_TAB_KIND, COWORK_TAB_TITLE, useClientServices } from './contracts.ts'
import { TopicList, TopicStates } from './list.tsx'
import {
  InboxPanel,
  type InboxActionInput,
  type InboxReceipt,
} from './inbox.tsx'
import {
  WIDE_PANEL_MIN_PX,
  applyInboxItemUpdate,
  buildInboxViewModel,
  clearStoredFilter,
  inboxNeedsYouTitle,
  readStoredFilter,
  writeStoredFilter,
  type InboxFilterStorage,
  type InboxNoteView,
  type InboxRequestView,
} from './inbox-model.ts'
import { ensurePanelStyles } from './styles.ts'

type LoadPhase = 'loading' | 'ready' | 'error'

/** The optimistic shape of an archived topic (the group rule does the rest). */
function archived(topic: WireTopic): WireTopic {
  return {
    ...topic,
    status: 'resolved',
    blocked: false,
    awaitingAuthorization: false,
    blockedReason: null,
    resolvedAt: new Date().toISOString(),
    resolvedBy: 'user',
  }
}

/** The optimistic shape of a restored topic. */
function restored(topic: WireTopic): WireTopic {
  return {
    ...topic,
    status: 'active',
    blocked: false,
    awaitingAuthorization: false,
    blockedReason: null,
    resolvedAt: null,
    resolvedBy: null,
  }
}

/** Replace exactly one topic row, leaving every other row untouched. */
function replaceTopic(
  overview: WireOverview | null,
  topicId: string,
  next: WireTopic,
): WireOverview | null {
  if (overview === null) return null
  return {
    ...overview,
    topics: overview.topics.map(topic => (topic.topicId === topicId ? next : topic)),
  }
}

/** Roll one row back to its pre-action value; other concurrent edits survive. */
function rollbackTopic(
  overview: WireOverview | null,
  topicId: string,
  previous: WireTopic | null,
): WireOverview | null {
  if (overview === null || previous === null) return overview
  return replaceTopic(overview, topicId, previous)
}

/** Which layout the panel content width allows. */
type PanelWidthMode = 'wide' | 'narrow'

/**
 * The Cowork tab body (session scope).
 *
 * Wide (>= 620px of panel content): a fixed 318px topic column and an
 * independently scrolling inbox column. Narrow: the topic list plus a banner
 * with the pending-request count; the banner opens the inbox full-width inside
 * the panel (the host exposes no right-bar width setter, so nothing touches the
 * host DOM). The inbox is loaded and failed independently of the overview, and
 * the topic filter survives a width change.
 */
/** The browser's sessionStorage, or null when the context/private mode denies it. */
function browserFilterStorage(): InboxFilterStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

export function CoworkPanel({ sessionId }: TabBodyProps): ReactElement {
  ensurePanelStyles()
  const services = useClientServices()

  const [phase, setPhase] = useState<LoadPhase>('loading')
  const [overview, setOverview] = useState<WireOverview | null>(null)
  const [error, setError] = useState<PanelErrorInfo | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null)
  const [pendingTopicIds, setPendingTopicIds] = useState<ReadonlySet<string>>(() => new Set())
  // A topic archived twice (restore in between) must re-open the resolved group,
  // so the reveal carries a nonce instead of only the topic id.
  const [reveal, setReveal] = useState<{ readonly topicId: string; readonly nonce: number } | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())

  const [inbox, setInbox] = useState<InboxResponse | null>(null)
  const [inboxPhase, setInboxPhase] = useState<LoadPhase>('loading')
  const [inboxError, setInboxError] = useState<PanelErrorInfo | null>(null)
  const [selectedInboxTopicId, setSelectedInboxTopicId] = useState<string | null>(
    () => readStoredFilter(browserFilterStorage(), sessionId),
  )
  const [inboxFocus, setInboxFocus] = useState(false)
  const [pendingRequestIds, setPendingRequestIds] = useState<ReadonlySet<string>>(() => new Set())
  const [inboxReceipts, setInboxReceipts] = useState<ReadonlyMap<string, InboxReceipt>>(() => new Map())
  const [widthMode, setWidthMode] = useState<PanelWidthMode>('wide')

  const rootRef = useRef<HTMLDivElement | null>(null)
  const feedbackTimer = useRef<number | null>(null)
  const pendingRef = useRef<Set<string>>(new Set())
  const pendingRequestRef = useRef<Set<string>>(new Set())
  const overviewRef = useRef<WireOverview | null>(null)
  const lastSessionId = useRef(sessionId)
  const lastInboxSessionId = useRef(sessionId)

  useEffect(() => {
    overviewRef.current = overview
  }, [overview])

  // Measure the panel's own content width; the host owns the right-bar width,
  // so this only decides which of the two in-panel layouts renders.
  const measureWidth = useCallback(() => {
    const node = rootRef.current
    if (node === null) return
    const width = node.getBoundingClientRect().width
    if (width <= 0) return
    setWidthMode(width < WIDE_PANEL_MIN_PX ? 'narrow' : 'wide')
    if (width >= WIDE_PANEL_MIN_PX) setInboxFocus(false)
  }, [])

  useEffect(() => {
    measureWidth()
    if (typeof ResizeObserver === 'undefined') return
    const node = rootRef.current
    if (node === null) return
    const observer = new ResizeObserver(() => { measureWidth() })
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [measureWidth])

  // Load / refresh the overview; abort the in-flight request when the effect
  // tears down (unmount, session change, refresh). A refresh keeps the current
  // list on screen instead of flashing the skeleton.
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    if (lastSessionId.current !== sessionId) {
      lastSessionId.current = sessionId
      setOverview(null)
      setPhase('loading')
    }
    setError(null)
    setPhase(current => (current === 'ready' ? 'ready' : 'loading'))
    loadOverview(sessionId, controller.signal).then(result => {
      if (!active) return
      setSelectedInboxTopicId((current) => {
        if (current === null) return current
        if (result.topics.some(topic => topic.topicId === current)) return current
        clearStoredFilter(browserFilterStorage(), sessionId)
        return null
      })
      setOverview(result)
      setPhase('ready')
      setNowMs(Date.now())
    }).catch((reason: unknown) => {
      if (!active || controller.signal.aborted) return
      setOverview(null)
      setError(toPanelError(reason))
      setPhase('error')
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [sessionId, refreshToken])

  // The inbox loads on its own: a failure here never blocks the topic list and
  // only paints the inbox area's error + retry.
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    if (lastInboxSessionId.current !== sessionId) {
      lastInboxSessionId.current = sessionId
      setInbox(null)
      setInboxPhase('loading')
      setSelectedInboxTopicId(readStoredFilter(browserFilterStorage(), sessionId))
      setInboxReceipts(new Map())
    }
    setInboxError(null)
    setInboxPhase(current => (current === 'ready' ? 'ready' : 'loading'))
    loadInbox(sessionId, selectedInboxTopicId, controller.signal).then(result => {
      if (!active) return
      setInbox(result)
      setInboxPhase('ready')
    }).catch((reason: unknown) => {
      if (!active || controller.signal.aborted) return
      setInboxError(toPanelError(reason))
      setInboxPhase('error')
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [sessionId, refreshToken, selectedInboxTopicId])

  // Keep the relative timestamps honest while the panel stays open.
  useEffect(() => {
    const timer = window.setInterval(() => { setNowMs(Date.now()) }, CLOCK_TICK_MS)
    return () => { window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    return () => {
      if (feedbackTimer.current !== null) {
        window.clearTimeout(feedbackTimer.current)
        feedbackTimer.current = null
      }
    }
  }, [])

  const showFeedback = useCallback((next: ActionFeedback) => {
    setFeedback(next)
    if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current)
    feedbackTimer.current = window.setTimeout(() => {
      feedbackTimer.current = null
      setFeedback(null)
    }, FEEDBACK_TTL_MS)
  }, [])

  const refresh = useCallback(() => {
    setRefreshToken(token => token + 1)
  }, [])

  const markPending = useCallback((topicId: string, pending: boolean) => {
    if (pending) pendingRef.current.add(topicId)
    else pendingRef.current.delete(topicId)
    setPendingTopicIds(new Set(pendingRef.current))
  }, [])

  const canOpenSession = services.uiWorkspace !== undefined
    && typeof services.uiWorkspace.openSession === 'function'

  /**
   * Open one topic: `unarchive` is a tolerance for a topic the user archived by
   * hand (a live topic rejects it, and that refusal is ignored); the actual
   * navigation is `openSession`, which only switches the main area.
   */
  const openTopic = useCallback(async (topicId: string) => {
    const workspace = services.uiWorkspace
    if (workspace === undefined || typeof workspace.openSession !== 'function') {
      showFeedback({ kind: 'failed', text: openSessionUnavailableMessage() })
      return
    }
    const steps = openTopicSteps()
    try {
      if (steps.includes('unarchive') && typeof workspace.unarchiveSession === 'function') {
        try {
          await workspace.unarchiveSession(topicId)
        } catch {
          // The normal case (topic not archived) refuses; opening still works.
        }
      }
      if (steps.includes('open')) workspace.openSession(topicId)
      showFeedback({ kind: 'ok', text: openSessionMessage(topicId) })
    } catch (reason) {
      showFeedback({ kind: 'failed', text: openSessionFailureMessage(errorMessage(reason)) })
    }
  }, [services.uiWorkspace, showFeedback])

  /** Archive one topic: optimistic move, then the host route; rollback on failure. */
  const archiveTopic = useCallback(async (topicId: string, title: string) => {
    if (pendingRef.current.has(topicId)) return
    const previous = overviewRef.current?.topics.find(topic => topic.topicId === topicId) ?? null
    markPending(topicId, true)
    setOverview(current => {
      if (current === null) return current
      const topic = current.topics.find(entry => entry.topicId === topicId)
      return topic === undefined ? current : replaceTopic(current, topicId, archived(topic))
    })
    setReveal(current => ({ topicId, nonce: (current?.nonce ?? 0) + 1 }))
    try {
      const result = await resolveTopic(sessionId, topicId)
      setOverview(current => replaceTopic(current, topicId, result.topic))
      showFeedback({ kind: 'ok', text: archiveSuccessMessage(title) })
    } catch (reason) {
      setOverview(current => rollbackTopic(current, topicId, previous))
      showFeedback({ kind: 'failed', text: writeFailureMessage('归档', toPanelError(reason)) })
    } finally {
      markPending(topicId, false)
    }
  }, [markPending, sessionId, showFeedback])

  /** Restore one archived topic: optimistic move back to running, rollback on failure. */
  const restoreTopic = useCallback(async (topicId: string, title: string) => {
    if (pendingRef.current.has(topicId)) return
    const previous = overviewRef.current?.topics.find(topic => topic.topicId === topicId) ?? null
    markPending(topicId, true)
    setOverview(current => {
      if (current === null) return current
      const topic = current.topics.find(entry => entry.topicId === topicId)
      return topic === undefined ? current : replaceTopic(current, topicId, restored(topic))
    })
    try {
      const result = await reopenTopic(sessionId, topicId)
      setOverview(current => replaceTopic(current, topicId, result.topic))
      showFeedback({ kind: 'ok', text: restoreSuccessMessage(title) })
    } catch (reason) {
      setOverview(current => rollbackTopic(current, topicId, previous))
      showFeedback({ kind: 'failed', text: writeFailureMessage('恢复', toPanelError(reason)) })
    } finally {
      markPending(topicId, false)
    }
  }, [markPending, sessionId, showFeedback])

  /** Put one inbox receipt on the row it belongs to. */
  const putReceipt = useCallback((id: string, receipt: InboxReceipt) => {
    setInboxReceipts((previous) => {
      const next = new Map(previous)
      next.set(id, receipt)
      return next
    })
  }, [])

  /**
   * Toggle the inbox topic filter; the topic session is never opened here. The
   * selection is remembered per session so a refresh restores it.
   */
  const toggleInboxFilter = useCallback((topicId: string) => {
    setSelectedInboxTopicId((current) => {
      if (current === topicId) {
        clearStoredFilter(browserFilterStorage(), sessionId)
        return null
      }
      writeStoredFilter(browserFilterStorage(), sessionId, topicId)
      return topicId
    })
  }, [sessionId])

  const clearInboxFilter = useCallback(() => {
    clearStoredFilter(browserFilterStorage(), sessionId)
    setSelectedInboxTopicId(null)
  }, [sessionId])

  /**
   * Resolve one request: validate the action against the row the user sees,
   * block a second submit, replace the row with the server's item and move the
   * counts. A failed write keeps the card actionable and only paints a local
   * receipt; a prompt failure is a warning, never a fabricated reply.
   */
  const resolveRequest = useCallback(async (
    item: InboxRequestView,
    action: RequestAction,
    input: InboxActionInput,
  ) => {
    if (pendingRequestRef.current.has(item.requestId)) return
    if (!item.actions.includes(action) || !actionAllowed(item.requestKind, action)) {
      putReceipt(item.requestId, { kind: 'error', text: '这个动作已不可用，请刷新后重试。' })
      return
    }
    pendingRequestRef.current.add(item.requestId)
    setPendingRequestIds(new Set(pendingRequestRef.current))
    try {
      const result = await resolveInboxRequest({
        sessionId,
        requestId: item.requestId,
        action,
        comment: input.comment,
        answers: input.answers,
      })
      setInbox(current => current === null
        ? current
        : { ...current, ...applyInboxItemUpdate(current, result.item) })
      if (result.promptError !== null) {
        putReceipt(item.requestId, {
          kind: 'warn',
          text: `已记录，但主题会话未唤醒（${result.promptError}）`,
        })
      } else {
        putReceipt(item.requestId, { kind: 'ok', text: '已提交' })
      }
      // The inbox row and its counts moved; the topic card still carries the
      // old `待授权`/blocked marker unless the overview is re-read. A failed
      // write never reaches this branch, so this cannot fake a success.
      refresh()
    } catch (reason) {
      const info = toPanelError(reason)
      putReceipt(item.requestId, { kind: 'error', text: `提交失败：${info.message}` })
    } finally {
      pendingRequestRef.current.delete(item.requestId)
      setPendingRequestIds(new Set(pendingRequestRef.current))
    }
  }, [putReceipt, refresh, sessionId])

  /** Reveal the PLAN/proposal file behind one row; ids only, never a path. */
  const openInboxItem = useCallback(async (item: InboxRequestView | InboxNoteView) => {
    const id = item.kind === 'request' ? item.requestId : item.noticeId
    if (pendingRequestRef.current.has(id)) return
    pendingRequestRef.current.add(id)
    setPendingRequestIds(new Set(pendingRequestRef.current))
    try {
      if (item.kind === 'request') await openInboxTarget({ sessionId, requestId: item.requestId })
      else await openInboxTarget({ sessionId, noticeId: item.noticeId })
      putReceipt(id, { kind: 'ok', text: '已在文件浏览器中打开' })
    } catch (reason) {
      const info = toPanelError(reason)
      putReceipt(id, { kind: 'error', text: `打开失败：${info.message}` })
    } finally {
      pendingRequestRef.current.delete(id)
      setPendingRequestIds(new Set(pendingRequestRef.current))
    }
  }, [putReceipt, sessionId])

  const masterTarget = overview === null
    ? null
    : masterBreadcrumbTarget({
        currentSessionId: sessionId,
        masterSessionId: overview.project.masterSessionId,
        topics: overview.topics,
      })

  const backToMaster = useCallback(() => {
    if (masterTarget === null) return
    const workspace = services.uiWorkspace
    if (workspace === undefined || typeof workspace.openSession !== 'function') {
      showFeedback({ kind: 'failed', text: openSessionUnavailableMessage() })
      return
    }
    try {
      workspace.openSession(masterTarget)
      showFeedback({ kind: 'ok', text: '已返回主会话' })
    } catch (reason) {
      showFeedback({ kind: 'failed', text: openSessionFailureMessage(errorMessage(reason)) })
    }
  }, [masterTarget, services.uiWorkspace, showFeedback])

  const view = overview === null ? null : buildTopicViewModel(overview)
  const surface: PanelSurfaceState = surfaceState({
    loading: phase === 'loading',
    error,
    topicCount: overview?.topics.length ?? 0,
  })
  const stateNotice = error === null ? emptyNotice() : errorPresentation(error)
  const inboxView = inbox === null
    ? null
    : buildInboxViewModel({
        inbox,
        topics: overview?.topics ?? [],
        selectedTopicId: selectedInboxTopicId,
        nowMs,
      })
  const needsYou = inboxView?.needsYou ?? { count: 0, detail: '' }

  const topicStates = <TopicStates state={surface} notice={stateNotice} onRefresh={refresh} />
  const topicList = surface === 'default' && view !== null ? (
    <TopicList
      groups={view.groups}
      nowMs={nowMs}
      pendingTopicIds={pendingTopicIds}
      revealTopicId={reveal === null ? null : reveal.topicId}
      revealNonce={reveal === null ? 0 : reveal.nonce}
      onOpenTopic={(topicId) => { void openTopic(topicId) }}
      onArchive={(topicId, title) => { void archiveTopic(topicId, title) }}
      onRestore={(topicId, title) => { void restoreTopic(topicId, title) }}
      selectedFilterTopicId={selectedInboxTopicId}
      onToggleFilter={toggleInboxFilter}
    />
  ) : null
  const inboxPanel = (
    <InboxPanel
      view={inboxView}
      phase={inboxPhase}
      error={inboxError}
      pendingRequestIds={pendingRequestIds}
      receipts={inboxReceipts}
      onResolve={(item, action, input) => { void resolveRequest(item, action, input) }}
      onOpen={(item) => { void openInboxItem(item) }}
      onClearFilter={clearInboxFilter}
      onRetry={refresh}
    />
  )

  return (
    <div className="cw-root" data-surface={surface} data-width-mode={widthMode} ref={rootRef}>
      <header className="cw-header">
        <span
          className="cw-project"
          title={overview === null ? undefined : overview.project.repoPath}
        >
          {overview === null ? COWORK_TAB_TITLE : middleEllipsis(overview.project.repoPath, PROJECT_PATH_MAX_CHARS)}
        </span>
        {masterTarget === null ? null : (
          <button
            type="button"
            className="cw-breadcrumb"
            onClick={backToMaster}
            disabled={!canOpenSession}
            title="返回主会话"
          >
            ← {masterBreadcrumbLabel()}
          </button>
        )}
        <button
          type="button"
          className="cw-icon-button"
          onClick={refresh}
          disabled={phase === 'loading'}
          aria-label="刷新 Cowork 项目"
        >
          刷新
        </button>
      </header>

      {feedback === null ? null : (
        <p className="cw-receipt" role="status" data-kind={feedback.kind}>{feedback.text}</p>
      )}

      {widthMode === 'narrow' && inboxFocus ? (
        <div className="cw-inbox-focus" data-testid="cw-inbox-focus">
          <div className="cw-inbox-focus-bar">
            <button
              type="button"
              className="cw-breadcrumb"
              data-testid="cw-inbox-back"
              onClick={() => { setInboxFocus(false) }}
            >
              ← 返回主题列表
            </button>
          </div>
          {inboxPanel}
        </div>
      ) : widthMode === 'narrow' ? (
        <>
          <button
            type="button"
            className="cw-needs-you"
            data-testid="cw-needs-you-banner"
            onClick={() => { setInboxFocus(true) }}
          >
            <span className="cw-needs-you-title">{inboxNeedsYouTitle(needsYou.count)}</span>
            {needsYou.detail === '' ? null : <span className="cw-needs-you-hint">{needsYou.detail}</span>}
          </button>
          <div className="cw-body">
            {topicStates}
            {topicList}
          </div>
        </>
      ) : (
        <div className="cw-body cw-columns">
          <div className="cw-topic-column">
            {topicStates}
            {topicList}
          </div>
          <div className="cw-inbox-column">
            {inboxPanel}
          </div>
        </div>
      )}
    </div>
  )
}
/** Tab chip title registered into `sidebar.right.pane.tab.title`. */
export function CoworkPanelTitle(): ReactElement {
  return <span className="cw-tab-title"><CoworkColorGlyph size={16} />{COWORK_TAB_TITLE}</span>
}

/**
 * Line-art Cowork mark adapted from the supplied `xiezuo.eps`: a rounded
 * square and two people, stroked with `currentColor` and no fill.
 */
const COWORK_GLYPH_PATHS = [
  'M 245.762 819.2 L 573.441 819.2 C 737.281 819.2 819.199 737.278 819.199 573.438 L 819.199 245.759 C 819.199 81.919 737.281 0.001 573.441 0.001 L 245.762 0.001 C 81.922 0.001 0 81.919 0 245.759 L 0 573.438 C 0 737.278 81.922 819.2 245.762 819.2 Z',
  'M 245.762 532.481 C 245.926 486.204 273.988 444.595 316.828 427.098 C 359.672 409.602 408.836 419.669 441.352 452.598 C 473.867 485.524 483.316 534.813 465.281 577.43 C 447.246 620.048 405.289 647.583 359.016 647.169 C 296.141 646.606 245.531 595.356 245.762 532.481 Z',
  'M 600.68 527.973 C 600.68 589.415 540.262 632.423 474.93 624.231 C 497.914 600.235 509.734 567.677 507.496 534.528 C 507.496 485.579 483.125 457.727 450.355 428.442 C 527.789 388.364 584.312 317.001 605.594 232.446 L 670.719 232.446 L 670.719 256.204 C 670.969 292.751 662.324 328.809 645.531 361.266 C 628.188 396.993 599.336 425.848 563.609 443.188 C 587.617 464.833 601.312 495.649 601.293 527.973 Z',
  'M 571.188 172.032 C 572.805 181.227 573.559 190.552 573.441 199.884 C 573.441 317.063 478.445 412.059 361.266 412.059 C 244.086 412.059 149.094 317.063 149.094 199.884 C 149.027 190.544 149.848 181.216 151.551 172.032',
] as const

/** Props the host passes to a registered guide-entry icon. */
export interface CoworkGlyphProps {
  readonly size?: number
  readonly className?: string
}

export function CoworkGlyph({ size, className = 'cw-footer-glyph' }: CoworkGlyphProps): ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 820 820"
      width={size}
      height={size}
      style={size === undefined ? undefined : { width: size, height: size }}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={72}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <g transform="translate(0 820) scale(1 -1)">
        {COWORK_GLYPH_PATHS.map((path) => <path key={path} d={path} />)}
      </g>
    </svg>
  )
}

/** The original blue mark from `xiezuo.eps`, used by the large guide entry. */
const COWORK_COLOR_GLYPH_PATHS = [
  { fill: '#1389ff', d: 'M 245.762 819.2 L 573.441 819.2 C 737.281 819.2 819.199 737.278 819.199 573.438 L 819.199 245.759 C 819.199 81.919 737.281 0.001 573.441 0.001 L 245.762 0.001 C 81.922 0.001 0 81.919 0 245.759 L 0 573.438 C 0 737.278 81.922 819.2 245.762 819.2 Z' },
  { fill: '#2993ff', d: 'M 573.441 646.962 L 245.762 646.962 C 110.031 646.962 0 536.934 0 401.204 L 0 239.821 C 0 375.552 110.031 485.579 245.762 485.579 L 573.441 485.579 C 709.168 485.579 819.199 375.552 819.199 239.821 L 819.199 401.204 C 819.199 536.934 709.168 646.962 573.441 646.962 Z' },
  { fill: '#42a1ff', d: 'M 573.441 485.579 L 245.762 485.579 C 111.223 485.591 1.684 377.423 0 242.891 C 0.227 215.348 5.219 188.048 14.746 162.2 C 49.996 259.43 142.34 324.184 245.762 324.2 L 573.441 324.2 C 676.785 324.098 769.027 259.36 804.25 162.2 C 813.848 188.036 818.906 215.337 819.199 242.891 C 817.52 377.423 707.98 485.591 573.441 485.579 Z' },
  { fill: '#5aacff', d: 'M 805.684 161.794 C 770.527 259.028 678.27 323.864 574.875 323.993 L 247.195 323.993 C 138.035 323.993 45.465 263.989 13.516 169.778 C 22.988 140.477 37.93 113.235 57.547 89.497 C 103.898 146.677 173.59 179.864 247.195 179.813 L 574.875 179.813 C 648.531 179.837 718.273 146.661 764.723 89.497 C 782.324 111.134 796.172 135.571 805.684 161.794 Z' },
  { fill: '#76bbff', d: 'M 573.441 179.813 L 245.762 179.813 C 172.156 179.864 102.465 146.677 56.113 89.497 C 102.789 32.841 172.352 0.013 245.762 0.001 L 573.441 0.001 C 646.848 0.013 716.41 32.841 763.086 89.497 C 716.734 146.677 647.043 179.864 573.441 179.813 Z' },
  { fill: '#ffffff', d: 'M 245.762 532.481 C 245.926 486.204 273.988 444.595 316.828 427.098 C 359.672 409.602 408.836 419.669 441.352 452.598 C 473.867 485.524 483.316 534.813 465.281 577.43 C 447.246 620.048 405.289 647.583 359.016 647.169 C 296.141 646.606 245.531 595.356 245.762 532.481 Z' },
  { fill: '#ffffff', d: 'M 600.68 527.973 C 600.68 589.415 540.262 632.423 474.93 624.231 C 497.914 600.235 509.734 567.677 507.496 534.528 C 507.496 485.579 483.125 457.727 450.355 428.442 C 527.789 388.364 584.312 317.001 605.594 232.446 L 670.719 232.446 L 670.719 256.204 C 670.969 292.751 662.324 328.809 645.531 361.266 C 628.188 396.993 599.336 425.848 563.609 443.188 C 587.617 464.833 601.312 495.649 601.293 527.973 Z' },
  { fill: '#ffffff', d: 'M 571.188 172.032 C 572.805 181.227 573.559 190.552 573.441 199.884 C 573.441 317.063 478.445 412.059 361.266 412.059 C 244.086 412.059 149.094 317.063 149.094 199.884 C 149.027 190.544 149.848 181.216 151.551 172.032' },
] as const

/** Color guide-entry mark; the host supplies the large 22/26px guide size. */
export function CoworkColorGlyph({ size = 26, className }: CoworkGlyphProps): ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 820 820"
      width={size}
      height={size}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <g transform="translate(0 820) scale(1 -1)">
        {COWORK_COLOR_GLYPH_PATHS.map(({ fill, d }) => (
          <path key={d} d={d} fill={fill} fillRule="evenodd" />
        ))}
      </g>
    </svg>
  )
}

/**
 * Bottom-bar entry (`sidebar.footer.action`): opens the Cowork tab in the right
 * Sidebar. Disabled with an explanatory title when the host has no sidebar
 * navigation service, rather than disappearing silently.
 */
export function CoworkFooterAction({ wide }: FooterActionOwnerProps): ReactElement {
  ensurePanelStyles()
  const services = useClientServices()
  const canOpen = services.sidebarRight !== undefined && typeof services.sidebarRight.openTab === 'function'
  return (
    <div className="cw-footer-slot" data-wide={wide ? 'true' : 'false'}>
      <button
        type="button"
        className="cw-footer-button"
        data-wide={wide ? 'true' : 'false'}
        aria-label="打开 Cowork 面板"
        title={canOpen ? '打开 Cowork 面板' : '当前宿主没有提供右侧栏导航服务，无法打开 Cowork 面板。'}
        disabled={!canOpen}
        onClick={() => {
          if (!canOpen || services.sidebarRight === undefined) return
          services.sidebarRight.openTab(COWORK_TAB_KIND)
        }}
      >
        <CoworkGlyph />
        {wide ? <span className="cw-footer-label">{COWORK_TAB_TITLE}</span> : null}
      </button>
    </div>
  )
}
