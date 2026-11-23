/**
 * Right-rail work-item list (the second internal tab of the Cowork panel).
 *
 * It owns only the list projection: load, filter, group, empty/error states,
 * server-side search, and the click that opens the work item in the Cowork
 * conversation view. The topic tab's data logic is untouched; this component
 * is a sibling inside the same panel shell.
 *
 * Search and filter are one server query: both go into the list route so the
 * scan covers the whole project and the rail never filters a partial page
 * locally. The current rows stay visible while a search is in flight; only the
 * first read shows the skeleton.
 *
 * Opening writes the shared open-work-item store and then activates the host
 * tab. The activation has no host API: it clicks the tab and verifies
 * `aria-selected`, so a failure is shown here with a retry instead of leaving
 * the user on Chat with no work item to see.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Dispatch,
  KeyboardEvent as ReactKeyboardEvent,
  MutableRefObject,
  ReactElement,
  ReactNode,
  RefObject,
  SetStateAction,
} from 'react'
import {
  ARTIFACT_EVENTS_PATH,
  ARTIFACT_EVENT_TYPES,
  type ArtifactListResponse,
  type ArtifactSummaryV1,
  railStatusLabel,
} from '../../panel/artifact-contract.js'
import { WorkItemApiError, workItemApi, type ListOptions } from './api.ts'
import {
  activeDispatchSummary,
  boundSearchQuery,
  cardTitle,
  filterArtifacts,
  filterCount,
  filterLabel,
  formatRelativeTime,
  groupArtifacts,
  groupStartsExpanded,
  isAbortError,
  listEmptyMessage,
  LIST_SEARCH_DEBOUNCE_MS,
  LIST_TRUNCATED_MESSAGE,
  searchStatusOf,
  sourceLabel,
  toggledGroupExpanded,
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

/* ------------------------------------------------------------------ */
/* list read: one aborted-per-change request, rows retained on failure */
/* ------------------------------------------------------------------ */

/** State setters one list read writes. */
interface ListReadSinks {
  readonly setData: Dispatch<SetStateAction<ArtifactListResponse | null>>
  readonly setPhase: Dispatch<SetStateAction<'loading' | 'ready' | 'error'>>
  readonly setError: Dispatch<SetStateAction<unknown>>
  readonly setRefreshError: Dispatch<SetStateAction<unknown>>
  readonly setSearching: Dispatch<SetStateAction<boolean>>
  readonly setNow: Dispatch<SetStateAction<Date>>
}

/** Everything one list request needs. */
interface ListReadParams {
  readonly sessionId: string
  readonly filter: WorkItemFilter
  readonly searchTerm: string
  readonly loadedRef: MutableRefObject<boolean>
  readonly requestRef: MutableRefObject<AbortController | null>
  readonly sinks: ListReadSinks
}

/** What a failed read must do with the rows already on screen. */
type ListReadFailure = 'ignore' | 'refresh' | 'fatal'

/** The route query for one filter and search term. */
function listOptionsOf(filter: WorkItemFilter, searchTerm: string, signal: AbortSignal | undefined): ListOptions {
  const status = searchStatusOf(filter)
  return {
    ...(searchTerm === '' ? {} : { q: searchTerm }),
    ...(status === null ? {} : { status }),
    ...(signal === undefined ? {} : { signal }),
  }
}

/** Adopt one successful read: it replaces the rows and ends the loading state. */
function applyListRead(response: ArtifactListResponse, sinks: ListReadSinks): void {
  sinks.setData(response)
  sinks.setPhase('ready')
  sinks.setSearching(false)
  sinks.setNow(new Date())
}

/** Classify a failed read against whether rows were ever loaded. */
function listFailureOf(reason: unknown, active: boolean, loaded: boolean): ListReadFailure {
  if (!active || isAbortError(reason)) return 'ignore'
  return loaded ? 'refresh' : 'fatal'
}

/** Present one failed read: a refresh keeps rows, a first read shows the error. */
function applyListFailure(outcome: ListReadFailure, reason: unknown, sinks: ListReadSinks): void {
  if (outcome === 'ignore') return
  sinks.setSearching(false)
  if (outcome === 'refresh') {
    sinks.setRefreshError(reason)
    return
  }
  sinks.setError(reason)
  sinks.setPhase('error')
}

/** Start one list read; the returned cleanup aborts it. */
function subscribeListRead(params: ListReadParams): () => void {
  params.requestRef.current?.abort()
  const controller = typeof AbortController === 'undefined' ? null : new AbortController()
  params.requestRef.current = controller
  const { sinks } = params
  sinks.setSearching(true)
  sinks.setError(null)
  sinks.setRefreshError(null)
  let active = true
  workItemApi
    .list(params.sessionId, listOptionsOf(params.filter, params.searchTerm, controller?.signal))
    .then((response) => {
      if (!active) return
      params.loadedRef.current = true
      applyListRead(response, sinks)
    })
    .catch((reason: unknown) => {
      applyListFailure(listFailureOf(reason, active, params.loadedRef.current), reason, sinks)
    })
  return () => {
    active = false
    controller?.abort()
  }
}

/** The loaded rows and the states of the read that produced them. */
interface ListRead {
  readonly data: ArtifactListResponse | null
  readonly phase: 'loading' | 'ready' | 'error'
  readonly error: unknown
  readonly refreshError: unknown
  readonly searching: boolean
  readonly now: Date
  readonly retry: () => void
}

/**
 * Load the list for one session, filter, and committed search term.
 *
 * A session switch drops the old rows and the filter; a filter/search change
 * keeps them until the replacement arrives. Retry re-reads with the current
 * query after an in-place failure.
 */
function useArtifactListRead(
  sessionId: string,
  filter: WorkItemFilter,
  searchTerm: string,
  liveToken: number,
): ListRead {
  const [data, setData] = useState<ArtifactListResponse | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<unknown>(null)
  const [refreshError, setRefreshError] = useState<unknown>(null)
  const [searching, setSearching] = useState(false)
  const [now, setNow] = useState(() => new Date())
  const [retryToken, setRetryToken] = useState(0)
  const loadedRef = useRef(false)
  const requestRef = useRef<AbortController | null>(null)
  const sinks: ListReadSinks = { setData, setPhase, setError, setRefreshError, setSearching, setNow }

  useEffect(() => {
    loadedRef.current = false
    setData(null)
    setPhase('loading')
    setError(null)
    setRefreshError(null)
  }, [sessionId])

  useEffect(
    () => subscribeListRead({ sessionId, filter, searchTerm, loadedRef, requestRef, sinks }),
    [filter, liveToken, retryToken, searchTerm, sessionId],
  )

  const retry = useCallback(() => { setRetryToken(token => token + 1) }, [])
  return { data, phase, error, refreshError, searching, now, retry }
}

/* ------------------------------------------------------------------ */
/* filter + search controls                                            */
/* ------------------------------------------------------------------ */

/** Filter and search state owned by the list toolbar. */
interface ListControls {
  readonly filter: WorkItemFilter
  readonly setFilter: (filter: WorkItemFilter) => void
  readonly searchOpen: boolean
  readonly query: string
  readonly term: string
  readonly inputRef: RefObject<HTMLInputElement>
  readonly setQuery: (value: string) => void
  readonly toggleSearch: () => void
  readonly clearSearch: () => void
  readonly onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void
}

/** Keep the toolbar filters and the debounced server query. */
function useListControls(sessionId: string): ListControls {
  const [filter, setFilter] = useState<WorkItemFilter>('all')
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [term, setTerm] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // A different session starts from the default projection.
  useEffect(() => {
    setFilter('all')
    setSearchOpen(false)
    setQuery('')
    setTerm('')
  }, [sessionId])

  // Typed text rests for 150ms before becoming one server query; clearing the
  // field restores the full list immediately.
  useEffect(() => {
    const bounded = boundSearchQuery(query)
    if (bounded === '') {
      setTerm('')
      return
    }
    const timer = window.setTimeout(() => { setTerm(bounded) }, LIST_SEARCH_DEBOUNCE_MS)
    return () => { window.clearTimeout(timer) }
  }, [query])

  useEffect(() => {
    if (searchOpen) inputRef.current?.focus()
  }, [searchOpen])

  const clearSearch = useCallback(() => {
    setSearchOpen(false)
    setQuery('')
    setTerm('')
  }, [])

  const toggleSearch = useCallback(() => {
    if (searchOpen) {
      clearSearch()
      return
    }
    setSearchOpen(true)
  }, [clearSearch, searchOpen])

  const onSearchKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    clearSearch()
  }, [clearSearch])

  return {
    filter, setFilter, searchOpen, query, term, inputRef,
    setQuery, toggleSearch, clearSearch, onSearchKeyDown,
  }
}

/* ------------------------------------------------------------------ */
/* live updates                                                        */
/* ------------------------------------------------------------------ */

/** Callbacks one project event stream drives. */
interface ProjectEventHandlers {
  readonly onOpen: () => void
  readonly onEvent: () => void
  readonly onFailure: () => void
}

/** Open the project event stream; the returned cleanup closes it. */
function subscribeProjectEvents(sessionId: string, handlers: ProjectEventHandlers): () => void {
  if (typeof EventSource === 'undefined') return () => {}
  let closed = false
  let failures = 0
  const source = new EventSource(`${ARTIFACT_EVENTS_PATH}?sessionId=${encodeURIComponent(sessionId)}`)
  const open = (): void => {
    if (closed) return
    failures = 0
    handlers.onOpen()
  }
  const frame = (): void => {
    if (closed) return
    handlers.onEvent()
  }
  const failure = (): void => {
    if (closed) return
    failures += 1
    if (failures < SSE_MAX_FAILURES) return
    source.close()
    handlers.onFailure()
  }
  source.onopen = open
  for (const type of ARTIFACT_EVENT_TYPES) source.addEventListener(type, frame)
  source.onerror = failure
  return () => {
    closed = true
    source.close()
  }
}

/** The live-refresh token plus the disconnect notice and its retry. */
interface ListLive {
  readonly refreshToken: number
  readonly sseNotice: string | null
  readonly retryLive: () => void
}

/**
 * Coalesce project events into list re-reads for the current session.
 *
 * The list subscribes to the same project event route as the viewer (one
 * EventSource per surface), so comment counts, status chips, and delivery
 * summaries change without reopening the tab. A burst of events (one comment
 * appends two) is coalesced into one read; the current rows stay visible while
 * that read is in flight.
 */
function useListLive(sessionId: string): ListLive {
  const [refreshToken, setRefreshToken] = useState(0)
  const [sseNotice, setSseNotice] = useState<string | null>(null)
  const [sseToken, setSseToken] = useState(0)

  useEffect(() => {
    let timer: number | null = null
    const schedule = (): void => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        setRefreshToken(token => token + 1)
      }, LIST_REFRESH_DEBOUNCE_MS)
    }
    const unsubscribe = subscribeProjectEvents(sessionId, {
      onOpen: () => { setSseNotice(null) },
      onEvent: schedule,
      onFailure: () => { setSseNotice('实时更新中断，点击重试') },
    })
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      unsubscribe()
    }
  }, [sessionId, sseToken])

  const retryLive = useCallback(() => {
    setSseNotice(null)
    setSseToken(token => token + 1)
  }, [])
  return { refreshToken, sseNotice, retryLive }
}

/* ------------------------------------------------------------------ */
/* view switch                                                         */
/* ------------------------------------------------------------------ */

/** The conversation-tab activation state. */
interface ViewSwitch {
  readonly switching: boolean
  readonly switchError: string | null
  readonly switchToView: () => Promise<void>
  readonly clearSwitchError: () => void
}

/** Make the registered Cowork view active, surfacing any bounded failure. */
function useViewSwitch(): ViewSwitch {
  const [switching, setSwitching] = useState(false)
  const [switchError, setSwitchError] = useState<string | null>(null)
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
  const clearSwitchError = useCallback(() => { setSwitchError(null) }, [])
  return { switching, switchError, switchToView, clearSwitchError }
}

/* ------------------------------------------------------------------ */
/* cards, groups, surfaces                                             */
/* ------------------------------------------------------------------ */

/** One rail card; the stored path and session id never reach the DOM. */
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
      title={cardTitle(item)}
    >
      <span className="cwi-card-top">
        <span className="cwi-kind" data-type={item.type}>{typeLabel(item.type)}</span>
        <span className="cwi-card-status" data-testid="cwi-card-status" data-status={item.status}>
          {railStatusLabel(item.status)}
        </span>
      </span>
      <span className="cwi-card-title" data-testid="cwi-card-title">{item.title}</span>
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
      <span className="cwi-card-source" data-testid="cwi-card-source">{sourceLabel(item.sessionTitle)}</span>
    </button>
  )
}

/** The folded 已完成 row: one dashed full-width card that expands the group. */
function CollapsedGroupCard({ group, onExpand }: {
  readonly group: WorkItemGroup
  readonly onExpand: () => void
}): ReactElement {
  return (
    <div className="cwi-group" data-testid="cwi-group" data-group={group.status} data-collapsed="true">
      <button
        type="button"
        className="cwi-group-summary"
        data-testid="cwi-group-summary"
        aria-expanded={false}
        onClick={onExpand}
      >
        <span className="cwi-group-check" aria-hidden="true">✓</span>
        <span className="cwi-group-summary-text">{group.label} {group.items.length} 个工作项</span>
        <span className="cwi-group-chevron" aria-hidden="true">›</span>
      </button>
    </div>
  )
}

/** One group's title row, carrying the count and its expansion state. */
function GroupHeader({ group, expanded, onToggle }: {
  readonly group: WorkItemGroup
  readonly expanded: boolean
  readonly onToggle: () => void
}): ReactElement {
  return (
    <button
      type="button"
      className="cwi-group-title"
      data-testid="cwi-group-toggle"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <span>{expanded ? '▾' : '▸'} {group.label}</span>
      <span>{group.items.length}</span>
    </button>
  )
}

/**
 * One status group.
 *
 * 已完成 starts folded to a single full-row summary card and expands into the
 * usual title plus cards; every other group starts open. The section remounts
 * (its key carries the session) when the rail switches session, so the folded
 * default returns.
 */
function WorkItemGroupSection({
  group,
  now,
  onOpen,
}: {
  readonly group: WorkItemGroup
  readonly now: Date
  readonly onOpen: (item: ArtifactSummaryV1) => void
}): ReactElement {
  const [expanded, setExpanded] = useState(() => groupStartsExpanded(group))
  const toggle = (): void => { setExpanded(toggledGroupExpanded) }
  if (!expanded && group.collapsedByDefault) {
    return <CollapsedGroupCard group={group} onExpand={() => { setExpanded(true) }} />
  }
  return (
    <div className="cwi-group" data-testid="cwi-group" data-group={group.status} data-collapsed={expanded ? 'false' : 'true'}>
      <GroupHeader group={group} expanded={expanded} onToggle={toggle} />
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

/** The no-result surface for a filter or search that matched nothing. */
function ListNoResult({ message, searchActive, onClearSearch }: {
  readonly message: string
  /** Whether a search term produced this empty result. */
  readonly searchActive: boolean
  readonly onClearSearch: () => void
}): ReactElement {
  return (
    <div className="cwi-empty" data-testid="cwi-list-no-result">
      {message}
      {searchActive ? (
        <div><button type="button" className="cwi-secondary" data-testid="cwi-search-clear-empty" onClick={onClearSearch}>清除搜索</button></div>
      ) : null}
    </div>
  )
}

/** The truncation note under a capped result set. */
function TruncatedNotice({ truncated }: { readonly truncated: boolean }): ReactElement | null {
  if (!truncated) return null
  return <div className="cwi-empty" data-testid="cwi-list-truncated">{LIST_TRUNCATED_MESSAGE}</div>
}

/** The project event stream's disconnect strip. */
function LiveNotice({ notice, onRetry }: {
  readonly notice: string | null
  readonly onRetry: () => void
}): ReactElement | null {
  if (notice === null) return null
  return (
    <div className="cwi-receipt" data-testid="cwi-list-sse">
      {notice}{' '}
      <button type="button" className="cwi-secondary" data-testid="cwi-list-sse-retry" onClick={onRetry}>
        重试
      </button>
    </div>
  )
}

/** The filter row: one chip per merged status projection. */
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
          aria-pressed={filter === option}
          onClick={() => { onFilter(option) }}
        >
          {filterLabel(option)} {filterCount(counts, option)}
        </button>
      ))}
    </div>
  )
}

/** The toolbar's search control: one button that expands into a search field. */
function SearchControl({
  open,
  query,
  searching,
  inputRef,
  onToggle,
  onQuery,
  onClear,
  onKeyDown,
}: {
  readonly open: boolean
  readonly query: string
  readonly searching: boolean
  readonly inputRef: RefObject<HTMLInputElement>
  readonly onToggle: () => void
  readonly onQuery: (value: string) => void
  readonly onClear: () => void
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void
}): ReactElement {
  return (
    <div className="cwi-list-tools">
      {searching ? <span className="cwi-search-loading" data-testid="cwi-search-loading" role="status">搜索中…</span> : null}
      {open ? (
        <div className="cwi-search" role="search">
          <input
            ref={inputRef}
            type="search"
            className="cwi-search-input"
            data-testid="cwi-search-input"
            aria-label="搜索工作项"
            placeholder="搜索"
            value={query}
            onChange={(event) => { onQuery(event.target.value) }}
            onKeyDown={onKeyDown}
          />
          <button
            type="button"
            className="cwi-search-clear"
            data-testid="cwi-search-clear"
            aria-label="清除搜索"
            onClick={onClear}
          >
            ×
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="cwi-search-toggle"
          data-testid="cwi-search-toggle"
          aria-label="搜索工作项"
          aria-expanded={false}
          onClick={onToggle}
        >
          搜索
        </button>
      )}
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

/** A refresh or search that failed after rows were already loaded. */
function ListRefreshError({ error, onRetry }: {
  readonly error: unknown | null
  readonly onRetry: () => void
}): ReactElement | null {
  if (error === null) return null
  return (
    <div className="cwi-error" role="alert" data-testid="cwi-list-error">
      加载失败：{messageOf(error)}
      <div><button type="button" className="cwi-secondary" onClick={onRetry}>重试</button></div>
    </div>
  )
}

/** The result area: project-empty, no-result, or the grouped cards. */
function ListResult({ data, filter, term, sessionId, now, onOpen, onEmptyRetry, onClearSearch }: {
  readonly data: ArtifactListResponse
  readonly filter: WorkItemFilter
  readonly term: string
  readonly sessionId: string
  readonly now: Date
  readonly onOpen: (item: ArtifactSummaryV1) => void
  readonly onEmptyRetry: () => void
  readonly onClearSearch: () => void
}): ReactElement {
  if (data.counts.total === 0) return <ListEmpty onRetry={onEmptyRetry} />
  if (data.items.length === 0) {
    return (
      <ListNoResult
        message={listEmptyMessage(term)}
        searchActive={term !== ''}
        onClearSearch={onClearSearch}
      />
    )
  }
  const groups = groupArtifacts(filterArtifacts(data.items, filter))
  return (
    <>
      {groups.map((group) => (
        <WorkItemGroupSection
          key={`${sessionId}:${group.status}`}
          group={group}
          now={now}
          onOpen={onOpen}
        />
      ))}
      <TruncatedNotice truncated={data.truncated} />
    </>
  )
}

/** The loaded list: toolbar, notices, and the result area. */
function ListReadyView({ sessionId, data, read, controls, view, live, onOpen }: {
  readonly sessionId: string
  readonly data: ArtifactListResponse
  readonly read: ListRead
  readonly controls: ListControls
  readonly view: ViewSwitch
  readonly live: ListLive
  readonly onOpen: (item: ArtifactSummaryV1) => void
}): ReactElement {
  return (
    <ListSurface phase="ready" liveNotice={<LiveNotice notice={live.sseNotice} onRetry={live.retryLive} />}>
      <div className="cwi-list-toolbar">
        <FilterRow filter={controls.filter} counts={data.counts} onFilter={controls.setFilter} />
        <SearchControl
          open={controls.searchOpen}
          query={controls.query}
          searching={read.searching && controls.term !== ''}
          inputRef={controls.inputRef}
          onToggle={controls.toggleSearch}
          onQuery={controls.setQuery}
          onClear={controls.clearSearch}
          onKeyDown={controls.onSearchKeyDown}
        />
      </div>
      <SwitchErrorNotice error={view.switchError} switching={view.switching} onRetry={() => { void view.switchToView() }} />
      <ListRefreshError error={read.refreshError} onRetry={read.retry} />
      <ListResult
        data={data}
        filter={controls.filter}
        term={controls.term}
        sessionId={sessionId}
        now={read.now}
        onOpen={onOpen}
        onEmptyRetry={read.retry}
        onClearSearch={controls.clearSearch}
      />
    </ListSurface>
  )
}

/** The work-item tab body. */
export function WorkItemList({ sessionId }: WorkItemListProps): ReactElement {
  const controls = useListControls(sessionId)
  const live = useListLive(sessionId)
  const read = useArtifactListRead(sessionId, controls.filter, controls.term, live.refreshToken)
  const view = useViewSwitch()

  /**
   * Open one work item in the conversation view.
   *
   * The store write registers the view synchronously; the tab click then runs
   * inside the same user gesture. A failed activation keeps the item open so
   * the retry only re-attempts the switch.
   */
  const open = useCallback((item: ArtifactSummaryV1) => {
    view.clearSwitchError()
    workItemOpenStore.open({ artifactId: item.artifactId, ownerSessionId: item.ownerSessionId })
    void view.switchToView()
  }, [view.clearSwitchError, view.switchToView])

  const { data } = read
  if (data === null && read.phase === 'loading') {
    return (
      <ListSurface phase="loading" liveNotice={<LiveNotice notice={live.sseNotice} onRetry={live.retryLive} />}>
        <ListSkeleton />
      </ListSurface>
    )
  }
  if (data === null) {
    return (
      <ListSurface phase="error" liveNotice={<LiveNotice notice={live.sseNotice} onRetry={live.retryLive} />}>
        <ListLoadError error={read.error} onRetry={read.retry} />
      </ListSurface>
    )
  }
  return (
    <ListReadyView
      sessionId={sessionId}
      data={data}
      read={read}
      controls={controls}
      view={view}
      live={live}
      onOpen={open}
    />
  )
}
