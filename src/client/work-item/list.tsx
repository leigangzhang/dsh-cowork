/**
 * Right-rail work-item list (the second internal tab of the Cowork panel).
 *
 * It owns only the list projection: load, filter, group, empty/error states,
 * and the click that opens the work item in the Cowork conversation view. The
 * topic tab's data logic is untouched; this component is a sibling inside the
 * same panel shell.
 *
 * Opening writes the shared open-work-item store and then activates the host
 * tab. The activation has no host API: it clicks the tab and verifies
 * `aria-selected`, so a failure is shown here with a retry instead of leaving
 * the user on Chat with no work item to see.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import {
  ARTIFACT_EVENTS_PATH,
  ARTIFACT_EVENT_TYPES,
  ARTIFACT_STATUS_LABELS,
  type ArtifactListResponse,
  type ArtifactSummaryV1,
} from '../../panel/artifact-contract.js'
import { WorkItemApiError, workItemApi } from './api.ts'
import {
  activeDispatchSummary,
  filterArtifacts,
  filterCount,
  filterLabel,
  formatRelativeTime,
  groupArtifacts,
  typeLabel,
  type WorkItemGroup,
  WORK_ITEM_FILTERS,
  type WorkItemFilter,
} from './model.ts'
import { workItemOpenStore } from './store.ts'
import { activateViewTab } from './view-tab.ts'

/** Coalesce a burst of project events into one list read. */
const LIST_REFRESH_DEBOUNCE_MS = 250
/** EventSource retries on its own; after this many failed opens the rail stops. */
const SSE_MAX_FAILURES = 3

/** Who opens the main-area viewer. */
interface WorkItemListProps {
  readonly sessionId: string
}

/** A short, non-empty message from any thrown value. */
function messageOf(error: unknown): string {
  if (error instanceof WorkItemApiError) return error.message
  return error instanceof Error ? error.message : String(error)
}

/** One rail card. */
function WorkItemCard({
  item,
  now,
  onOpen,
}: {
  readonly item: ArtifactSummaryV1
  readonly now: Date
  readonly onOpen: (item: ArtifactSummaryV1) => void
}): ReactElement {
  const dispatch = activeDispatchSummary(item.activeDispatch)
  return (
    <button
      type="button"
      className="cwi-card"
      data-testid="cwi-card"
      data-artifact-id={item.artifactId}
      data-status={item.status}
      onClick={() => { onOpen(item) }}
      title={item.primaryPath}
    >
      <span className="cwi-card-top">
        <span className="cwi-kind" data-type={item.type}>{typeLabel(item.type)}</span>
        <span className="cwi-card-status" data-testid="cwi-card-status" data-status={item.status}>
          {ARTIFACT_STATUS_LABELS[item.status]}
        </span>
      </span>
      <span className="cwi-card-title">{item.title}</span>
      <span className="cwi-card-meta">
        <span className="cwi-chip">{item.commentCount} 条评论</span>
        {item.attachmentCount > 0 ? <span className="cwi-chip">{item.attachmentCount} 个附件</span> : null}
        {dispatch === null ? null : (
          <span className="cwi-chip" data-tone={dispatch.tone} data-testid="cwi-card-dispatch">
            {dispatch.label}
          </span>
        )}
        <span className="cwi-card-time">{formatRelativeTime(item.updatedAt, now)}</span>
      </span>
      <span className="cwi-path">{item.primaryPath}</span>
      <span className="cwi-card-source" data-testid="cwi-card-source">来源：{item.ownerSessionId}</span>
    </button>
  )
}

/** One status group; a confirmed group starts folded. */
function WorkItemGroupSection({
  group,
  now,
  onOpen,
}: {
  readonly group: WorkItemGroup
  readonly now: Date
  readonly onOpen: (item: ArtifactSummaryV1) => void
}): ReactElement {
  const [expanded, setExpanded] = useState(!group.collapsedByDefault)
  return (
    <div data-testid="cwi-group" data-group={group.status} data-collapsed={expanded ? 'false' : 'true'}>
      <button
        type="button"
        className="cwi-group-title"
        data-testid="cwi-group-toggle"
        aria-expanded={expanded}
        onClick={() => { setExpanded(value => !value) }}
      >
        <span>{expanded ? '▾' : '▸'} {group.label}</span>
        <span>{group.items.length}</span>
      </button>
      {expanded ? group.items.map(item => (
        <WorkItemCard key={item.artifactId} item={item} now={now} onOpen={onOpen} />
      )) : null}
    </div>
  )
}

/** The list frame every phase shares: test id, phase, and the SSE notice. */
function ListSurface({ phase, liveNotice, children }: {
  readonly phase: string
  readonly liveNotice: ReactNode
  readonly children: ReactNode
}): ReactElement {
  return (
    <div
      className="cwi-list"
      data-testid="cwi-list"
      data-phase={phase}
      aria-busy={phase === 'loading' ? 'true' : undefined}
    >
      {liveNotice}
      {children}
    </div>
  )
}

/** Three placeholder cards while the first list read is in flight. */
function ListSkeleton(): ReactElement {
  return (
    <>
      {[0, 1, 2].map((index) => (
        <div key={index} className="cwi-skeleton-card" data-testid="cwi-skeleton">
          <div className="cwi-skeleton cwi-skeleton-title" />
          <div className="cwi-skeleton cwi-skeleton-line" />
        </div>
      ))}
    </>
  )
}

/** The first-read failure surface with its retry. */
function ListLoadError({ error, onRetry }: {
  readonly error: unknown
  readonly onRetry: () => void
}): ReactElement {
  return (
    <div className="cwi-error" data-testid="cwi-list-error">
      无法加载工作项：{messageOf(error)}
      <div><button type="button" className="cwi-secondary" onClick={onRetry}>重试</button></div>
    </div>
  )
}

/** The empty project surface; the retry re-reads the list. */
function ListEmpty({ onRetry }: { readonly onRetry: () => void }): ReactElement {
  return (
    <div className="cwi-empty" data-testid="cwi-list-empty">
      还没有工作项。让主题会话用 cowork_artifact_create 登记项目里的交付物后，
      它们会出现在这里。
      <div><button type="button" className="cwi-secondary" onClick={onRetry}>刷新</button></div>
    </div>
  )
}

/** The filter row: one chip per status projection. */
function FilterRow({ filter, counts, onFilter }: {
  readonly filter: WorkItemFilter
  readonly counts: ArtifactListResponse['counts']
  readonly onFilter: (filter: WorkItemFilter) => void
}): ReactElement {
  return (
    <div className="cwi-filter-row" role="group" aria-label="按状态筛选工作项">
      {WORK_ITEM_FILTERS.map(option => (
        <button
          key={option}
          type="button"
          className="cwi-filter"
          data-testid="cwi-filter"
          data-filter={option}
          data-active={filter === option ? 'true' : 'false'}
          onClick={() => { onFilter(option) }}
        >
          {filterLabel(option)} {filterCount(counts, option)}
        </button>
      ))}
    </div>
  )
}

/** A failed conversation-tab activation, with the retry that re-attempts it. */
function SwitchErrorNotice({ error, switching, onRetry }: {
  readonly error: string | null
  readonly switching: boolean
  readonly onRetry: () => void
}): ReactElement | null {
  if (error === null) return null
  return (
    <div className="cwi-error" role="alert" data-testid="cwi-list-switch-error">
      {error}{' '}
      <button
        type="button"
        className="cwi-secondary"
        data-testid="cwi-list-switch-retry"
        disabled={switching}
        onClick={onRetry}
      >
        重试切换
      </button>
    </div>
  )
}

/** A refresh that failed after rows were already loaded. */
function ListRefreshError({ phase, error, onRetry }: {
  readonly phase: 'loading' | 'ready' | 'error'
  readonly error: unknown
  readonly onRetry: () => void
}): ReactElement | null {
  if (phase !== 'error') return null
  return (
    <div className="cwi-error" role="alert" data-testid="cwi-list-error">
      刷新失败：{messageOf(error)}
      <div><button type="button" className="cwi-secondary" onClick={onRetry}>重试</button></div>
    </div>
  )
}

/** The work-item tab body. */
export function WorkItemList({ sessionId }: WorkItemListProps): ReactElement {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [data, setData] = useState<ArtifactListResponse | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [filter, setFilter] = useState<WorkItemFilter>('all')
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)
  const [sseNotice, setSseNotice] = useState<string | null>(null)
  const [sseToken, setSseToken] = useState(0)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    let active = true
    setPhase(current => (current === 'ready' ? 'ready' : 'loading'))
    setError(null)
    workItemApi.list(sessionId).then((response) => {
      if (!active) return
      setData(response)
      setPhase('ready')
      setNow(new Date())
    }).catch((reason: unknown) => {
      if (!active) return
      setError(reason)
      setPhase('error')
    })
    return () => { active = false }
  }, [sessionId, refreshToken])

  // The list subscribes to the same project event route as the viewer (one
  // EventSource per surface), so comment counts, status chips, and delivery
  // summaries change without reopening the tab. A burst of events (one comment
  // appends two) is coalesced into one read; the current rows stay visible
  // while that read is in flight.
  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    let closed = false
    let failures = 0
    let timer: number | null = null
    let source: EventSource | null = null
    const scheduleRefresh = (): void => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        setRefreshToken(token => token + 1)
      }, LIST_REFRESH_DEBOUNCE_MS)
    }
    const connect = (): void => {
      source = new EventSource(`${ARTIFACT_EVENTS_PATH}?sessionId=${encodeURIComponent(sessionId)}`)
      source.onopen = () => {
        if (closed) return
        failures = 0
        setSseNotice(null)
      }
      const onFrame = (): void => {
        if (closed) return
        scheduleRefresh()
      }
      for (const type of ARTIFACT_EVENT_TYPES) {
        source.addEventListener(type, onFrame)
      }
      source.onerror = () => {
        if (closed) return
        failures += 1
        if (failures >= SSE_MAX_FAILURES) {
          source?.close()
          setSseNotice('实时更新中断，点击重试')
        }
      }
    }
    connect()
    return () => {
      closed = true
      if (timer !== null) window.clearTimeout(timer)
      source?.close()
    }
  }, [sessionId, sseToken])

  const retryLive = useCallback(() => {
    setSseNotice(null)
    setSseToken(token => token + 1)
  }, [])

  /** Make the registered Cowork view active, surfacing any bounded failure. */
  const switchToView = useCallback(async () => {
    setSwitching(true)
    try {
      await activateViewTab()
      setSwitchError(null)
    } catch (reason) {
      setSwitchError(messageOf(reason))
    } finally {
      setSwitching(false)
    }
  }, [])

  /**
   * Open one work item in the conversation view.
   *
   * The store write registers the view synchronously; the tab click then runs
   * inside the same user gesture. A failed activation keeps the item open so
   * the retry only re-attempts the switch.
   */
  const open = useCallback((item: ArtifactSummaryV1) => {
    setSwitchError(null)
    workItemOpenStore.open({ artifactId: item.artifactId, ownerSessionId: item.ownerSessionId })
    void switchToView()
  }, [switchToView])

  const retry = useCallback(() => { setRefreshToken(token => token + 1) }, [])

  // The stream can stop while the rail is loading, empty, or failed; the retry
  // must stay reachable in every one of those states, not only with rows.
  const liveNotice = sseNotice === null ? null : (
    <div className="cwi-receipt" data-testid="cwi-list-sse">
      {sseNotice}{' '}
      <button type="button" className="cwi-secondary" data-testid="cwi-list-sse-retry" onClick={retryLive}>
        重试
      </button>
    </div>
  )

  if (phase === 'loading') {
    return <ListSurface phase="loading" liveNotice={liveNotice}><ListSkeleton /></ListSurface>
  }
  if (data === null) {
    return <ListSurface phase="error" liveNotice={liveNotice}><ListLoadError error={error} onRetry={retry} /></ListSurface>
  }
  if (data.items.length === 0) {
    return <ListSurface phase="empty" liveNotice={liveNotice}><ListEmpty onRetry={retry} /></ListSurface>
  }
  const visible = filterArtifacts(data.items, filter)
  const groups = groupArtifacts(visible)
  return (
    <ListSurface phase="ready" liveNotice={liveNotice}>
      <FilterRow filter={filter} counts={data.counts} onFilter={setFilter} />
      <SwitchErrorNotice error={switchError} switching={switching} onRetry={() => { void switchToView() }} />
      <ListRefreshError phase={phase} error={error} onRetry={retry} />
      {groups.length === 0 ? (
        <div className="cwi-empty">这个筛选下没有工作项。</div>
      ) : groups.map((group) => (
        <WorkItemGroupSection key={group.status} group={group} now={now} onOpen={open} />
      ))}
      {data.truncated ? <div className="cwi-empty">仅显示最近 200 个工作项。</div> : null}
    </ListSurface>
  )
}
