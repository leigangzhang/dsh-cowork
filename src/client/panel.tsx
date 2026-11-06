/**
 * The Cowork panel shell: project header, status chips, layout measurement and
 * the list ⇄ detail surface.
 *
 * Layout is measured on the panel container with a `ResizeObserver`, because
 * the right Sidebar is a resizable column (about 648px by default, but the user
 * can drag it): above 480px the list and the detail share the width, at or
 * below it the panel becomes a single-column drill-down. Data comes from the
 * read-only host API; this surface never writes project state.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { HandoffPayload, OverviewPayload } from '../api-contract.ts'
import { defaultSelectedThreadId } from '../api-contract.ts'
import { loadHandoff, loadOverview, toPanelError, errorMessage } from './api.ts'
import {
  chooseLayout,
  copyFailureMessage,
  copySuccessMessage,
  emptyNotice,
  errorPresentation,
  FEEDBACK_TTL_MS,
  masterMessageMaxHeight,
  middleEllipsis,
  openSessionFailureMessage,
  openSessionMessage,
  openSessionUnavailableMessage,
  PROJECT_PATH_MAX_CHARS,
  surfaceState,
  type LayoutMode,
  type NoticePresentation,
} from './model.ts'
import type { FooterActionOwnerProps, PanelErrorInfo, TabBodyProps } from './contracts.ts'
import { COWORK_TAB_KIND, COWORK_TAB_TITLE, useClientServices } from './contracts.ts'
import { StatusChips } from './chips.tsx'
import { ThreadList } from './list.tsx'
import { ThreadDetail, type DetailFeedback, type HandoffPhase } from './detail.tsx'
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

/** Empty state: not initialized yet, or a project without threads. */
function EmptyNotice({ notice, onRefresh }: { readonly notice: NoticePresentation; readonly onRefresh: () => void }): ReactElement {
  return (
    <div className="cw-notice" data-notice={notice.code ?? 'no-threads'}>
      <h2 className="cw-notice-title">{notice.title}</h2>
      <p className="cw-notice-detail">{notice.detail}</p>
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
  const [overview, setOverview] = useState<OverviewPayload | null>(null)
  const [error, setError] = useState<PanelErrorInfo | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [handoff, setHandoff] = useState<HandoffPayload | null>(null)
  const [handoffPhase, setHandoffPhase] = useState<HandoffPhase>('idle')
  const [handoffError, setHandoffError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<DetailFeedback | null>(null)
  const [drillOpen, setDrillOpen] = useState(false)
  const [layoutWidth, setLayoutWidth] = useState<number | null>(null)
  const [layoutHeight, setLayoutHeight] = useState(0)
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
    const apply = (width: number, height: number): void => {
      setLayoutWidth(current => (current === width ? current : width))
      setLayoutHeight(current => (current === height ? current : height))
    }
    const measure = (): void => {
      const rect = node.getBoundingClientRect()
      apply(rect.width, rect.height)
    }
    measure()
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(entries => {
        const entry = entries[0]
        if (entry === undefined) return
        const box = entry.contentRect
        apply(box.width, box.height)
      })
      observer.observe(node)
      return () => { observer.disconnect() }
    }
    window.addEventListener('resize', measure)
    return () => { window.removeEventListener('resize', measure) }
  }, [])

  // Load / refresh the overview; abort the in-flight request when the effect
  // tears down (unmount, session change, refresh) or the panel is hidden.
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
        current !== null && result.threads.some(thread => thread.threadId === current)
          ? current
          : defaultSelectedThreadId(result.threads)
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

  const selectedThread = overview === null
    ? null
    : overview.threads.find(thread => thread.threadId === selectedId) ?? null
  const selectedThreadId = selectedThread?.threadId ?? null
  const selectedThreadHasHandoff = selectedThread?.hasHandoff ?? false

  // Load the selected thread's latest handoff; no handoff means the
  // `no-handoff` state, and every non-abort failure stays visible.
  useEffect(() => {
    if (phase !== 'ready' || selectedThreadId === null || !selectedThreadHasHandoff) {
      setHandoff(null)
      setHandoffError(null)
      setHandoffPhase(selectedThreadId === null ? 'idle' : 'none')
      return
    }
    const controller = new AbortController()
    let active = true
    setHandoff(null)
    setHandoffError(null)
    setHandoffPhase('loading')
    loadHandoff(sessionId, selectedThreadId, controller.signal).then(result => {
      if (!active) return
      if (result === null) {
        setHandoff(null)
        setHandoffPhase('none')
      } else {
        setHandoff(result)
        setHandoffPhase('ready')
      }
    }).catch((reason: unknown) => {
      if (!active || controller.signal.aborted) return
      setHandoff(null)
      setHandoffError(errorMessage(reason))
      setHandoffPhase('error')
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [phase, sessionId, selectedThreadId, selectedThreadHasHandoff, refreshToken])

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
  }, [layout, drillOpen, selectedThreadId])

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

  const selectThread = useCallback((threadId: string) => {
    setSelectedId(threadId)
    setDrillOpen(true)
  }, [])

  const openSession = useCallback(() => {
    if (selectedThread === null) return
    const workspace = services.uiWorkspace
    if (workspace === undefined || typeof workspace.openSession !== 'function') {
      showFeedback({ kind: 'failed', text: openSessionUnavailableMessage() })
      return
    }
    try {
      workspace.openSession(selectedThread.threadId)
      showFeedback({ kind: 'ok', text: openSessionMessage(selectedThread.threadId) })
    } catch (reason) {
      showFeedback({ kind: 'failed', text: openSessionFailureMessage(errorMessage(reason)) })
    }
  }, [selectedThread, services.uiWorkspace, showFeedback])

  const copyHandoffPath = useCallback(() => {
    const filePath = handoff?.filePath
    if (filePath === undefined || filePath.length === 0) {
      showFeedback({ kind: 'failed', text: copyFailureMessage('没有可复制的交接单路径') })
      return
    }
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
      showFeedback({ kind: 'failed', text: copyFailureMessage('当前上下文没有剪贴板权限') })
      return
    }
    clipboard.writeText(filePath).then(() => {
      showFeedback({ kind: 'ok', text: copySuccessMessage() })
    }).catch((reason: unknown) => {
      showFeedback({ kind: 'failed', text: copyFailureMessage(errorMessage(reason)) })
    })
  }, [handoff?.filePath, showFeedback])

  const surface = surfaceState({ loading: phase === 'loading', error, threadCount: overview?.threads.length ?? 0 })
  const emptyPresentation = error === null ? emptyNotice('no-threads') : errorPresentation(error)
  const canOpenSession = services.uiWorkspace !== undefined && typeof services.uiWorkspace.openSession === 'function'

  const detail = selectedThread === null ? null : (
    <ThreadDetail
      thread={selectedThread}
      nowMs={nowMs}
      handoff={handoff}
      handoffPhase={handoffPhase}
      handoffError={handoffError}
      masterMaxHeight={masterMessageMaxHeight(layoutHeight)}
      canOpenSession={canOpenSession}
      openSessionHint={openSessionUnavailableMessage()}
      feedback={feedback}
      onOpenSession={openSession}
      onCopyPath={copyHandoffPath}
      onBack={layout === 'drill' ? () => { setDrillOpen(false) } : null}
    />
  )

  const list = overview === null ? null : (
    <ThreadList
      threads={overview.threads}
      selectedId={selectedId}
      nowMs={nowMs}
      onSelect={selectThread}
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
        <button
          type="button"
          className="cw-icon-button"
          onClick={refresh}
          disabled={phase === 'loading'}
          aria-label="刷新 Cowork 总览"
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
                  {detail ?? <p className="cw-muted cw-detail-empty">选择左侧的 thread 查看详情。</p>}
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
  )
}
