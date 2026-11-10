/**
 * The Cowork panel shell (topic-page v2): project header, inbox hint, the
 * "需要你处理" entry, receipts and the topic list.
 *
 * The topic page is a single-column list now. There is no list/detail split, no
 * layout measurement, no detail fetch and no write form: opening a card only
 * switches the main area (`uiWorkspace.openSession`), and archiving/restoring a
 * topic is one immediate ⋯ menu action (master-only on the host).
 *
 * Writes are optimistic: the card moves group first, the request follows, and a
 * failure rolls that one card back and leaves a visible receipt. A topic with a
 * request in flight cannot submit again.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  errorMessage,
  loadOverview,
  reopenTopic,
  resolveTopic,
  toPanelError,
  type WireOverview,
  type WireTopic,
} from './api.ts'
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

/** The Cowork tab body (session scope). */
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

  const feedbackTimer = useRef<number | null>(null)
  const pendingRef = useRef<Set<string>>(new Set())
  const overviewRef = useRef<WireOverview | null>(null)
  const lastSessionId = useRef(sessionId)

  useEffect(() => {
    overviewRef.current = overview
  }, [overview])

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
  const needsYou = view?.needsYou ?? null
  const needsYouCount = needsYou === null ? 0 : needsYou.count
  const needsYouTopicId = needsYouCount > 0 ? needsYou?.topicId ?? null : null

  return (
    <div className="cw-root" data-surface={surface}>
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

      {needsYouTopicId === null ? null : (
        <button
          type="button"
          className="cw-needs-you"
          onClick={() => { void openTopic(needsYouTopicId) }}
        >
          <span className="cw-needs-you-title">需要你处理 {needsYouCount} 项</span>
          <span className="cw-needs-you-hint">待授权 · 点此去主题会话处理</span>
        </button>
      )}

      {feedback === null ? null : (
        <p className="cw-receipt" role="status" data-kind={feedback.kind}>{feedback.text}</p>
      )}

      <div className="cw-body">
        <TopicStates state={surface} notice={stateNotice} onRefresh={refresh} />
        {surface === 'default' && view !== null ? (
          <TopicList
            groups={view.groups}
            nowMs={nowMs}
            pendingTopicIds={pendingTopicIds}
            revealTopicId={reveal === null ? null : reveal.topicId}
            revealNonce={reveal === null ? 0 : reveal.nonce}
            onOpenTopic={(topicId) => { void openTopic(topicId) }}
            onArchive={(topicId, title) => { void archiveTopic(topicId, title) }}
            onRestore={(topicId, title) => { void restoreTopic(topicId, title) }}
          />
        ) : null}
      </div>
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
