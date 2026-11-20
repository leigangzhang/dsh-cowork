/**
 * Right-rail work-item list (the second internal tab of the Cowork panel).
 *
 * It owns only the list projection: load, filter, group, empty/error states,
 * and the click that opens the main-area viewer. The topic tab's data logic is
 * untouched; this component is a sibling inside the same panel shell.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { ArtifactListResponse, ArtifactSummaryV1 } from '../../panel/artifact-contract.js'
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
  WORK_ITEM_FILTERS,
  type WorkItemFilter,
} from './model.ts'
import { workItemOpenStore } from './store.ts'

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
    </button>
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
      setData(null)
      setError(reason)
      setPhase('error')
    })
    return () => { active = false }
  }, [sessionId, refreshToken])

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

  if (phase === 'loading') {
    return (
      <div className="cwi-list" data-testid="cwi-list" data-phase="loading" aria-busy="true">
        <div className="cwi-skeleton" />
        <div className="cwi-skeleton" />
        <div className="cwi-skeleton" />
      </div>
    )
  }
  if (phase === 'error' || data === null) {
    return (
      <div className="cwi-list" data-testid="cwi-list" data-phase="error">
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
        <div className="cwi-empty" data-testid="cwi-list-empty">
          还没有工作项。让主题会话用 cowork_artifact_create 登记项目里的交付物后，
          它们会出现在这里。
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
      {groups.length === 0 ? (
        <div className="cwi-empty">这个筛选下没有工作项。</div>
      ) : groups.map((group) => (
        <div key={group.status} data-testid="cwi-group" data-group={group.status}>
          <div className="cwi-group-title">
            <span>{group.label}</span>
            <span>{group.items.length}</span>
          </div>
          {group.items.map(item => (
            <WorkItemCard key={item.artifactId} item={item} now={now} onOpen={open} />
          ))}
        </div>
      ))}
      {data.truncated ? <div className="cwi-empty">仅显示最近 200 个工作项。</div> : null}
    </div>
  )
}
