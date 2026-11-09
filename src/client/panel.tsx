/**
 * The Cowork panel shell (wire v2): project header, inbox hint, status chips,
 * layout measurement, the topic list ⇄ detail surface and the write actions.
 *
 * Layout is measured on the panel container with a `ResizeObserver`, because the
 * right Sidebar is a resizable column: above 480px the list and the detail share
 * the width, at or below it the panel becomes a single-column drill-down.
 *
 * Opening a topic only switches the main area (`uiWorkspace.openSession`): it
 * never archives a topic, never adds or removes a sidebar entry, and the
 * breadcrumb goes back to the master session. Writes go through the host's
 * master-only routes; every result becomes a visible receipt and a refresh.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { OverviewResponse, TopicResponse as TopicPayload } from '../api-contract.ts'
import { defaultSelectedTopicId } from '../api-contract.ts'
import {
  errorMessage,
  loadOverview,
  loadTopic,
  moveTopic,
  reopenTopic,
  resolveTopic,
  toPanelError,
} from './api.ts'
import {
  actionFailureMessage,
  chooseLayout,
  copyFailureMessage,
  copySuccessMessage,
  emptyNotice,
  errorPresentation,
  FEEDBACK_TTL_MS,
  inboxNotice,
  masterBreadcrumbLabel,
  masterBreadcrumbTarget,
  middleEllipsis,
  moveSuccessMessage,
  moveTargets as computeMoveTargets,
  openSessionFailureMessage,
  openSessionMessage,
  openSessionUnavailableMessage,
  openTopicSteps,
  PROJECT_PATH_MAX_CHARS,
  reopenSuccessMessage,
  resolveSuccessMessage,
  surfaceState,
  type LayoutMode,
  type NoticePresentation,
} from './model.ts'
import type { FooterActionOwnerProps, PanelErrorInfo, TabBodyProps } from './contracts.ts'
import { COWORK_TAB_KIND, COWORK_TAB_TITLE, useClientServices } from './contracts.ts'
import { StatusChips } from './chips.tsx'
import { TopicList } from './list.tsx'
import { TopicDetail, type DetailFeedback, type DetailPhase } from './detail.tsx'
import { ensurePanelStyles } from './styles.ts'

/** How often the relative timestamps are recomputed while the panel is open. */
const CLOCK_TICK_MS = 60_000

type LoadPhase = 'loading' | 'ready' | 'error'

/** Skeleton for the loading state. */
function LoadingSkeleton(): ReactElement {
  return (
    <div className="cw-skeleton" role="status" aria-busy="true" aria-label="正在读取 Cowork 项目">
      <p className="cw-skeleton-label">正在读取 Cowork 项目…</p>
      <div className="cw-skeleton-bar" />
      <div className="cw-skeleton-bar" />
      <div className="cw-skeleton-bar" />
    </div>
  )
}

/** Empty state: not initialized yet, or a project without topics. */
function EmptyNotice({ notice, onRefresh }: { readonly notice: NoticePresentation; readonly onRefresh: () => void }): ReactElement {
  return (
    <div className="cw-notice" data-notice={notice.code ?? 'no-topics'}>
      <h2 className="cw-notice-title">{notice.title}</h2>
      {notice.detail.trim() === '' ? null : <p className="cw-notice-detail">{notice.detail}</p>}
      {notice.hint === null ? null : <code className="cw-notice-hint">{notice.hint}</code>}
      {notice.retry ? (
        <button type="button" className="cw-button" onClick={onRefresh}>刷新</button>
      ) : null}
    </div>
  )
}

/** Error state: the host's code and path stay visible, with a retry. */
function ErrorNotice({ notice, onRefresh }: { readonly notice: NoticePresentation; readonly onRefresh: () => void }): ReactElement {
  return (
    <div className="cw-notice" role="alert">
      <h2 className="cw-notice-title">{notice.title}</h2>
      <p className="cw-notice-detail">{notice.detail}</p>
      {notice.code === null ? null : (
        <p className="cw-notice-code">错误码 <code className="cw-code">{notice.code}</code></p>
      )}
      {notice.path === null ? null : (
        <p className="cw-notice-path">路径 <code className="cw-filepath">{notice.path}</code></p>
      )}
      <button type="button" className="cw-button" onClick={onRefresh}>重试</button>
    </div>
  )
}

/** The Cowork tab body (session scope). */
export function CoworkPanel({ sessionId }: TabBodyProps): ReactElement {
  ensurePanelStyles()
  const services = useClientServices()

  const [phase, setPhase] = useState<LoadPhase>('loading')
  const [overview, setOverview] = useState<OverviewResponse | null>(null)
  const [error, setError] = useState<PanelErrorInfo | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [topic, setTopic] = useState<TopicPayload | null>(null)
  const [topicPhase, setTopicPhase] = useState<DetailPhase>('idle')
  const [topicError, setTopicError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<DetailFeedback | null>(null)
  const [drillOpen, setDrillOpen] = useState(false)
  const [layoutWidth, setLayoutWidth] = useState<number | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())

  const rootRef = useRef<HTMLDivElement | null>(null)
  const feedbackTimer = useRef<number | null>(null)
  const previousLayout = useRef<LayoutMode>('drill')
  const wasDrillOpen = useRef(false)

  // Measure the panel itself (not the viewport): ResizeObserver is the source
  // of truth, with a resize fallback only for hosts that lack it.
  useLayoutEffect(() => {
    const node = rootRef.current
    if (node === null) return
    const apply = (width: number): void => {
      setLayoutWidth(current => (current === width ? current : width))
    }
    const measure = (): void => { apply(node.getBoundingClientRect().width) }
    measure()
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(entries => {
        const entry = entries[0]
        if (entry === undefined) return
        apply(entry.contentRect.width)
      })
      observer.observe(node)
      return () => { observer.disconnect() }
    }
    window.addEventListener('resize', measure)
    return () => { window.removeEventListener('resize', measure) }
  }, [])

  // Load / refresh the overview; abort the in-flight request when the effect
  // tears down (unmount, session change, refresh).
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setPhase('loading')
    setError(null)
    loadOverview(sessionId, controller.signal).then(result => {
      if (!active) return
      setOverview(result)
      setPhase('ready')
      setNowMs(Date.now())
      setSelectedId(current => (
        current !== null && result.topics.some(entry => entry.topicId === current)
          ? current
          : defaultSelectedTopicId(result.topics)
      ))
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

  const selectedTopic = overview === null
    ? null
    : overview.topics.find(entry => entry.topicId === selectedId) ?? null
  const selectedTopicId = selectedTopic?.topicId ?? null

  // Load the selected topic's detail (work items, review requests, activity).
  useEffect(() => {
    if (phase !== 'ready' || selectedTopicId === null) {
      setTopic(null)
      setTopicError(null)
      setTopicPhase('idle')
      return
    }
    const controller = new AbortController()
    let active = true
    setTopic(null)
    setTopicError(null)
    setTopicPhase('loading')
    loadTopic(sessionId, selectedTopicId, controller.signal).then(result => {
      if (!active) return
      setTopic(result)
      setTopicPhase('ready')
    }).catch((reason: unknown) => {
      if (!active || controller.signal.aborted) return
      setTopic(null)
      setTopicError(errorMessage(reason))
      setTopicPhase('error')
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [phase, sessionId, selectedTopicId, refreshToken])

  const layout = chooseLayout(layoutWidth)

  // Entering drill mode goes back to the list first: a narrow panel must never
  // start on a squeezed two-column view.
  useEffect(() => {
    if (previousLayout.current === layout) return
    previousLayout.current = layout
    setDrillOpen(false)
  }, [layout])

  // Returning from the drill-down detail puts the focus back on the selected
  // row, so a keyboard user does not fall back to the top of the document.
  useEffect(() => {
    if (layout !== 'drill') {
      wasDrillOpen.current = false
      return
    }
    if (drillOpen) {
      wasDrillOpen.current = true
      return
    }
    if (!wasDrillOpen.current) return
    wasDrillOpen.current = false
    rootRef.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.focus()
  }, [layout, drillOpen, selectedTopicId])

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

  const showFeedback = useCallback((next: DetailFeedback) => {
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

  const selectTopic = useCallback((topicId: string) => {
    setSelectedId(topicId)
    setDrillOpen(true)
  }, [])

  const canOpenSession = services.uiWorkspace !== undefined
    && typeof services.uiWorkspace.openSession === 'function'

  /**
   * Open one topic: the model fixes the steps. `unarchive` is a tolerance for a
   * topic the user archived by hand (a live topic rejects it, and that refusal
   * is ignored); the actual navigation is `openSession`, which only switches the
   * main area. Nothing here archives a topic or touches the sidebar.
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

  const masterTarget = overview === null
    ? null
    : masterBreadcrumbTarget({
        currentSessionId: sessionId,
        masterSessionId: overview.project.masterSessionId,
        topics: overview.topics,
      })

  const backToMaster = useCallback(() => {
    const workspace = services.uiWorkspace
    if (masterTarget === null) return
    if (workspace === undefined || typeof workspace.openSession !== 'function') {
      showFeedback({ kind: 'failed', text: openSessionUnavailableMessage() })
      return
    }
    try {
      workspace.openSession(masterTarget)
      showFeedback({ kind: 'ok', text: '已返回 master 会话' })
    } catch (reason) {
      showFeedback({ kind: 'failed', text: openSessionFailureMessage(errorMessage(reason)) })
    }
  }, [masterTarget, services.uiWorkspace, showFeedback])

  const resolveSelected = useCallback(async () => {
    if (selectedTopic === null) return
    try {
      await resolveTopic(sessionId, selectedTopic.topicId)
      showFeedback({ kind: 'ok', text: resolveSuccessMessage(selectedTopic.topicId) })
      refresh()
    } catch (reason) {
      showFeedback({ kind: 'failed', text: actionFailureMessage('标记已解决', errorMessage(reason)) })
    }
  }, [sessionId, selectedTopic, showFeedback, refresh])

  const reopenSelected = useCallback(async () => {
    if (selectedTopic === null) return
    try {
      await reopenTopic(sessionId, selectedTopic.topicId)
      showFeedback({ kind: 'ok', text: reopenSuccessMessage(selectedTopic.topicId) })
      refresh()
    } catch (reason) {
      showFeedback({ kind: 'failed', text: actionFailureMessage('重新打开', errorMessage(reason)) })
    }
  }, [sessionId, selectedTopic, showFeedback, refresh])

  const moveSelected = useCallback(async (fromTopicId: string, toTopicId: string, intent: string) => {
    try {
      const result = await moveTopic(sessionId, fromTopicId, toTopicId, intent)
      showFeedback({
        kind: 'ok',
        text: moveSuccessMessage({ changed: result.changed, addedCount: result.added.length }),
      })
      refresh()
    } catch (reason) {
      showFeedback({ kind: 'failed', text: actionFailureMessage('移动到其他主题', errorMessage(reason)) })
    }
  }, [sessionId, showFeedback, refresh])

  const copyPath = useCallback(() => {
    const repoPath = overview?.project.repoPath ?? ''
    if (repoPath.length === 0) {
      showFeedback({ kind: 'failed', text: copyFailureMessage('没有可复制的项目路径') })
      return
    }
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
      showFeedback({ kind: 'failed', text: copyFailureMessage('当前上下文没有剪贴板权限') })
      return
    }
    clipboard.writeText(repoPath).then(() => {
      showFeedback({ kind: 'ok', text: copySuccessMessage() })
    }).catch((reason: unknown) => {
      showFeedback({ kind: 'failed', text: copyFailureMessage(errorMessage(reason)) })
    })
  }, [overview?.project.repoPath, showFeedback])

  const surface = surfaceState({
    loading: phase === 'loading',
    error,
    topicCount: overview?.topics.length ?? 0,
  })
  const emptyPresentation = error === null ? emptyNotice() : errorPresentation(error)
  const inboxHint = overview === null ? null : inboxNotice(overview.inbox)
  const movedTargets = overview === null || selectedTopic === null
    ? []
    : computeMoveTargets(overview.topics, selectedTopic.topicId)

  const detail = selectedTopic === null ? null : (
    <TopicDetail
      key={selectedTopic.topicId}
      topic={selectedTopic}
      detail={topic}
      detailPhase={topicPhase}
      detailError={topicError}
      nowMs={nowMs}
      feedback={feedback}
      canOpen={canOpenSession}
      openHint={openSessionUnavailableMessage()}
      moveTargets={movedTargets}
      onOpen={() => { void openTopic(selectedTopic.topicId) }}
      onResolve={() => { void resolveSelected() }}
      onReopen={() => { void reopenSelected() }}
      onMove={(fromTopicId, toTopicId, intent) => { void moveSelected(fromTopicId, toTopicId, intent) }}
      onCopyPath={copyPath}
      onBack={layout === 'drill' ? () => { setDrillOpen(false) } : null}
    />
  )

  const list = overview === null ? null : (
    <TopicList
      topics={overview.topics}
      selectedId={selectedId}
      nowMs={nowMs}
      onSelect={selectTopic}
    />
  )

  return (
    <div className="cw-root" ref={rootRef} data-layout={layout} data-surface={surface}>
      <header className="cw-header">
        <span
          className="cw-project"
          title={overview === null ? undefined : overview.project.repoPath}
        >
          {overview === null ? COWORK_TAB_TITLE : middleEllipsis(overview.project.repoPath, PROJECT_PATH_MAX_CHARS)}
        </span>
        {inboxHint === null ? null : (
          <span className="cw-chip cw-inbox-chip" title={inboxHint.title}>
            <span className="cw-chip-label">{inboxHint.label}</span>
          </span>
        )}
        {masterTarget === null ? null : (
          <button
            type="button"
            className="cw-breadcrumb"
            onClick={backToMaster}
            disabled={!canOpenSession}
            title="返回 master 会话"
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

      {overview === null ? null : <StatusChips counts={overview.counts} />}

      <div className="cw-body">
        {surface === 'loading' ? <LoadingSkeleton /> : null}
        {surface === 'empty' ? <EmptyNotice notice={emptyPresentation} onRefresh={refresh} /> : null}
        {surface === 'error' ? <ErrorNotice notice={errorPresentation(error)} onRefresh={refresh} /> : null}

        {surface === 'default' && layout === 'split'
          ? (
              <>
                {list}
                <div className="cw-detail-pane">
                  {detail ?? <p className="cw-muted cw-detail-empty">选择左侧的主题查看详情。</p>}
                </div>
              </>
            )
          : null}

        {surface === 'default' && layout === 'drill'
          ? (drillOpen && detail !== null ? <div className="cw-detail-pane">{detail}</div> : list)
          : null}
      </div>
    </div>
  )
}

/** Tab chip title registered into `sidebar.right.pane.tab.title`. */
export function CoworkPanelTitle(): ReactElement {
  return <span className="cw-tab-title">{COWORK_TAB_TITLE}</span>
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
        <span className="cw-footer-glyph" aria-hidden="true">◧</span>
        {wide ? <span className="cw-footer-label">{COWORK_TAB_TITLE}</span> : null}
      </button>
    </div>
  )
}
