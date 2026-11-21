/**
 * Right-rail work-item list (the second internal tab of the Cowork panel).
 *
 * It owns only the list projection: load, filter, group, empty/error states,
 * and the click that opens the main-area viewer. The topic tab's data logic is
 * untouched; this component is a sibling inside the same panel shell.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import {
  ARTIFACT_EVENTS_PATH,
  ARTIFACT_EVENT_TYPES,
  ARTIFACT_STATUS_LABELS,
  type ArtifactListResponse,
  type ArtifactSummaryV1,
} from '../../panel/artifact-contract.js'
import { useClientServices } from '../contracts.ts'
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

/** Coalesce a burst of project events into one list read. */
const LIST_REFRESH_DEBOUNCE_MS = 250
/** EventSource retries on its own; after this many failures the rail stops. */
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
      <span className="cwi-card-title">{item.title}</span>
      <span className="cwi-card-meta">
        <span className="cwi-chip" data-testid="cwi-card-status" data-status={item.status}>
          {ARTIFACT_STATUS_LABELS[item.status]}
        </span>
        <span className="cwi-chip">{typeLabel(item.type)}</span>
        {dispatch === null ? null : (
          <span className="cwi-chip" data-tone={dispatch.tone} data-testid="cwi-card-dispatch">
            {dispatch.label}
          </span>
        )}
        <span>{item.commentCount} 条评论</span>
        {item.attachmentCount > 0 ? <span>{item.attachmentCount} 个附件</span> : null}
        <span>{formatRelativeTime(item.updatedAt, now)}</span>
      </span>
      <span className="cwi-path">{item.primaryPath}</span>
      <span className="cwi-card-meta" data-testid="cwi-card-source">来源：{item.ownerSessionId}</span>
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

/** The work-item tab body. */
export function WorkItemList({ sessionId }: WorkItemListProps): ReactElement {
  const services = useClientServices()
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [data, setData] = useState<ArtifactListResponse | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [filter, setFilter] = useState<WorkItemFilter>('all')
  const [openError, setOpenError] = useState<string | null>(null)
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

  const open = useCallback((item: ArtifactSummaryV1) => {
    const layout = services.layout
    if (layout === undefined || typeof layout.selectPanel !== 'function') {
      setOpenError('当前宿主没有主区域布局服务，无法打开工作项。')
      return
    }
    setOpenError(null)
    workItemOpenStore.open({ sessionId, artifactId: item.artifactId })
    layout.selectPanel('cowork-work-item')
  }, [services.layout, sessionId])

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
    return (
      <div className="cwi-list" data-testid="cwi-list" data-phase="loading" aria-busy="true">
        {liveNotice}
        {[0, 1, 2].map((index) => (
          <div key={index} className="cwi-skeleton-card" data-testid="cwi-skeleton">
            <div className="cwi-skeleton cwi-skeleton-title" />
            <div className="cwi-skeleton cwi-skeleton-line" />
          </div>
        ))}
      </div>
    )
  }
  if (data === null) {
    return (
      <div className="cwi-list" data-testid="cwi-list" data-phase="error">
        {liveNotice}
        <div className="cwi-error" data-testid="cwi-list-error">
          无法加载工作项：{messageOf(error)}
          <div><button type="button" className="cwi-secondary" onClick={retry}>重试</button></div>
        </div>
      </div>
    )
  }
  if (data.items.length === 0) {
    return (
      <div className="cwi-list" data-testid="cwi-list" data-phase="empty">
        {liveNotice}
        <div className="cwi-empty" data-testid="cwi-list-empty">
          还没有工作项。让主题会话用 cowork_artifact_create 登记项目里的交付物后，
          它们会出现在这里。
          <div><button type="button" className="cwi-secondary" onClick={retry}>刷新</button></div>
        </div>
      </div>
    )
  }
  const visible = filterArtifacts(data.items, filter)
  const groups = groupArtifacts(visible)
  return (
    <div className="cwi-list" data-testid="cwi-list" data-phase="ready">
      <div className="cwi-filter-row" role="group" aria-label="按状态筛选工作项">
        {WORK_ITEM_FILTERS.map(option => (
          <button
            key={option}
            type="button"
            className="cwi-filter"
            data-testid="cwi-filter"
            data-filter={option}
            data-active={filter === option ? 'true' : 'false'}
            onClick={() => { setFilter(option) }}
          >
            {filterLabel(option)} {filterCount(data.counts, option)}
          </button>
        ))}
      </div>
      {openError === null ? null : <div className="cwi-error" role="alert">{openError}</div>}
      {liveNotice}
      {phase === 'error' ? (
        <div className="cwi-error" role="alert" data-testid="cwi-list-error">
          刷新失败：{messageOf(error)}
          <div><button type="button" className="cwi-secondary" onClick={retry}>重试</button></div>
        </div>
      ) : null}
      {groups.length === 0 ? (
        <div className="cwi-empty">这个筛选下没有工作项。</div>
      ) : groups.map((group) => (
        <WorkItemGroupSection key={group.status} group={group} now={now} onOpen={open} />
      ))}
      {data.truncated ? <div className="cwi-empty">仅显示最近 200 个工作项。</div> : null}
    </div>
  )
}
