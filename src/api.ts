/**
 * Read-only HTTP surface of the Cowork panel.
 *
 * The two routes are mounted on the host `connection` service, whose Exact
 * Fetch channel authenticates browser requests before they reach us; unlike the
 * M0 probe routes on `ctx.webServer` this module therefore registers no
 * loopback guard of its own. Everything the routes need sits behind ports so
 * the wire mapping (overview assembly, latest-handoff choice, error mapping)
 * is unit-testable without a running host.
 *
 * Read-only by construction: the store port exposes only reads, and the
 * project root always comes from `sessionId` → session cwd → `findProjectRoot`.
 * A path sent by the browser is never trusted.
 */
import {
  HANDOFF_FORMATTER_VERSION,
  HANDOFF_PATH,
  MAX_PANEL_THREADS,
  OVERVIEW_PATH,
  countThreads,
  isPanelThreadStatus,
  sortThreadsForPanel,
  type HandoffPayload,
  type HandoffResponse,
  type OverviewPayload,
  type OverviewResponse,
  type PanelErrorBody,
  type PanelErrorCode,
  type PanelThread,
} from './api-contract.js'
import { formatMasterMessage } from './handoff.js'
import type { HandoffFile, ProjectIndex, ThreadRecord } from './store.js'
import { StoreError } from './store.js'

/** Session identity the panel needs; `sessionController.inspect` supplies it. */
export interface PanelSessionMeta {
  readonly id: string
  /** The session's working directory; the only accepted start for project discovery. */
  readonly cwd?: string
}

/** Store reads the routes may perform. `ProjectStore` satisfies this structurally. */
export interface CoworkStorePort {
  hasIndex(): Promise<boolean>
  readIndex(): Promise<ProjectIndex>
  listHandoffs(): Promise<HandoffFile[]>
}

/** The host facts a route needs, injected so tests can stand in for the host. */
export interface CoworkApiPorts {
  inspectSession(sessionId: string): Promise<{ readonly meta?: PanelSessionMeta }>
  findProjectRoot(startPath: string): Promise<string | null>
  createStore(repoPath: string): CoworkStorePort
}

/** Methods the connection channel supports for a registered route. */
export type PanelFetchMethod = 'GET' | 'HEAD' | 'POST'
/** Whether the channel buffers or streams the request body before the handler. */
export type PanelRequestBodyMode = 'buffered' | 'streaming'

/** One Exact Fetch route as the host `connection` service declares it. */
export interface PanelFetchRoute {
  readonly path: string
  readonly methods: readonly PanelFetchMethod[]
  readonly requestBody: PanelRequestBodyMode
  readonly fetch: (request: Request) => Promise<Response>
}

/** The slice of the host `connection` service this module registers on. */
export interface CoworkConnection {
  readonly fetch: {
    register(route: PanelFetchRoute): () => Promise<void>
  }
}

/**
 * The Cordis context surface used here. `get` mirrors `ctx.get(name)`: it
 * returns `undefined` when the service is absent instead of throwing, which is
 * what keeps the plugin loadable in a host without `connection`.
 */
export interface CoworkApiHost {
  get(name: string): unknown
  effect(execute: () => unknown, label?: string): void
}

/** A failure the routes map to a stable panel error code and HTTP status. */
export class PanelApiError extends Error {
  readonly code: PanelErrorCode
  readonly path: string | undefined

  constructor(code: PanelErrorCode, message: string, path?: string) {
    super(message)
    this.name = 'PanelApiError'
    this.code = code
    this.path = path
  }
}

/** One route failure: HTTP status plus the shared error envelope. */
export interface PanelErrorResult {
  readonly status: number
  readonly body: PanelErrorBody
}

/** HTTP status per stable error code; the panel keys its states off the code. */
const PANEL_ERROR_STATUS: Readonly<Record<PanelErrorCode, number>> = {
  'request/session-required': 400,
  'request/thread-required': 400,
  'session/unknown': 400,
  'session/cwd-unavailable': 400,
  'project/not-initialized': 404,
  'handoff/not-found': 404,
  'store/corrupt': 500,
  internal: 500,
}

const JSON_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json; charset=utf-8',
  // Every response is a live read of local files; a cached body would show a
  // stale project as if it were current.
  'cache-control': 'no-store',
}

/** HTTP status for a stable error code. */
export function panelErrorStatus(code: PanelErrorCode): number {
  return PANEL_ERROR_STATUS[code]
}

function errorBody(code: PanelErrorCode, message: string, path?: string): PanelErrorBody {
  const error: { code: PanelErrorCode; message: string; path?: string } = { code, message }
  if (path !== undefined) error.path = path
  return { ok: false, error }
}

/**
 * Map any failure the routes may raise onto the panel error contract:
 * `PanelApiError` keeps its code, a corrupt store keeps its file path, and
 * everything else degrades to `internal` rather than leaking a status the
 * client cannot interpret.
 */
export function toErrorResponse(error: unknown): PanelErrorResult {
  if (error instanceof PanelApiError) {
    return { status: panelErrorStatus(error.code), body: errorBody(error.code, error.message, error.path) }
  }
  if (error instanceof StoreError && error.code === 'store/corrupt') {
    return { status: 500, body: errorBody('store/corrupt', error.message, error.filePath) }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { status: 500, body: errorBody('internal', message) }
}

/** One JSON response with the headers both panel endpoints share. */
export function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS })
}

/** A query parameter, or null when absent or blank. GET routes carry no body. */
function queryParam(request: Request, name: string): string | null {
  const value = new URL(request.url).searchParams.get(name)
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Resolve the project root for a session. The browser only ever sends a
 * session id: the cwd comes from the host, so a crafted `path` parameter can
 * never read a repository the caller's session does not belong to.
 */
async function resolveProjectRoot(ports: CoworkApiPorts, sessionId: string): Promise<string> {
  let inspected: { readonly meta?: PanelSessionMeta } | undefined
  try {
    inspected = await ports.inspectSession(sessionId)
  } catch {
    // The host throws for an id it does not know; the panel must not care why.
    throw new PanelApiError('session/unknown', `unknown session: ${sessionId}`)
  }
  const meta = inspected?.meta
  if (meta === undefined) {
    throw new PanelApiError('session/unknown', `unknown session: ${sessionId}`)
  }
  const cwd = meta.cwd
  if (cwd === undefined || cwd.trim() === '') {
    throw new PanelApiError('session/cwd-unavailable', `session has no working directory: ${sessionId}`)
  }
  const repoPath = await ports.findProjectRoot(cwd)
  if (repoPath === null) {
    throw new PanelApiError(
      'project/not-initialized',
      `no .dsh-cowork project above ${cwd}`,
      cwd,
    )
  }
  return repoPath
}

/** Whether one index entry belongs in the panel (archived threads never do). */
export function isListableThread(
  thread: ThreadRecord,
): thread is ThreadRecord & { readonly status: PanelThread['status'] } {
  return thread.status !== 'archived' && isPanelThreadStatus(thread.status)
}

/** Project one index entry into the wire shape the panel renders. */
export function toPanelThread(
  record: ThreadRecord & { readonly status: PanelThread['status'] },
): PanelThread {
  return {
    threadId: record.threadId,
    subject: record.subject,
    status: record.status,
    cwd: record.cwd,
    worktreePath: record.worktreePath,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastHandoffAt: record.lastHandoffAt,
    // The panel only needs the marker; deriving it keeps the wire honest when
    // an older index lacks the derived field.
    hasHandoff: record.lastHandoffAt !== null,
  }
}

/**
 * Overview body: listable threads in panel order, capped, with counts computed
 * from the returned rows so the header chips can never disagree with the list.
 */
export function buildOverview(index: ProjectIndex, repoPath: string): OverviewPayload {
  const threads = sortThreadsForPanel(index.threads.filter(isListableThread).map(toPanelThread))
    .slice(0, MAX_PANEL_THREADS)
  return {
    project: {
      repoPath,
      projectId: index.projectId,
      masterSessionId: index.masterSessionId,
      createdAt: index.createdAt,
    },
    counts: countThreads(threads),
    threads,
  }
}

/** Whether `candidate` is newer than `current`; equal timestamps fall back to the file name. */
function isNewerHandoff(candidate: HandoffFile, current: HandoffFile): boolean {
  const delta = Date.parse(candidate.record.createdAt) - Date.parse(current.record.createdAt)
  if (Number.isFinite(delta) && delta !== 0) return delta > 0
  // Names carry a sortable stamp; the larger one is the later write.
  return candidate.fileName.localeCompare(current.fileName) > 0
}

/** The newest handoff of one thread, or null when it has none. */
export function selectLatestHandoff(
  files: readonly HandoffFile[],
  threadId: string,
): HandoffFile | null {
  let latest: HandoffFile | null = null
  for (const file of files) {
    if (file.record.threadId !== threadId) continue
    if (latest === null || isNewerHandoff(file, latest)) latest = file
  }
  return latest
}

/**
 * Handoff body: the stored record plus the message the master received. The
 * message is re-rendered on read (never stored), so the formatter version
 * travels with it and a rendering change is visible instead of silent.
 */
export function buildHandoffPayload(file: HandoffFile): HandoffPayload {
  return {
    record: file.record,
    filePath: file.filePath,
    masterMessage: formatMasterMessage(file.record, file.filePath),
    formatterVersion: HANDOFF_FORMATTER_VERSION,
  }
}

async function handleOverview(request: Request, ports: CoworkApiPorts): Promise<Response> {
  try {
    const sessionId = queryParam(request, 'sessionId')
    if (sessionId === null) {
      throw new PanelApiError('request/session-required', 'query parameter sessionId is required')
    }
    const repoPath = await resolveProjectRoot(ports, sessionId)
    const store = ports.createStore(repoPath)
    if (!(await store.hasIndex())) {
      // findProjectRoot guarantees an index, so this only fires when the file
      // vanished between discovery and read (concurrent checkout switch).
      throw new PanelApiError('project/not-initialized', `project index is missing under ${repoPath}`, repoPath)
    }
    const response: OverviewResponse = { ok: true, ...buildOverview(await store.readIndex(), repoPath) }
    return jsonResponse(200, response)
  } catch (error) {
    const { status, body } = toErrorResponse(error)
    return jsonResponse(status, body)
  }
}

async function handleHandoff(request: Request, ports: CoworkApiPorts): Promise<Response> {
  try {
    const sessionId = queryParam(request, 'sessionId')
    if (sessionId === null) {
      throw new PanelApiError('request/session-required', 'query parameter sessionId is required')
    }
    const threadId = queryParam(request, 'threadId')
    if (threadId === null) {
      throw new PanelApiError('request/thread-required', 'query parameter threadId is required')
    }
    const repoPath = await resolveProjectRoot(ports, sessionId)
    const store = ports.createStore(repoPath)
    if (!(await store.hasIndex())) {
      throw new PanelApiError('project/not-initialized', `project index is missing under ${repoPath}`, repoPath)
    }
    const latest = selectLatestHandoff(await store.listHandoffs(), threadId)
    if (latest === null) {
      throw new PanelApiError('handoff/not-found', `thread has no handoff: ${threadId}`)
    }
    const response: HandoffResponse = { ok: true, handoff: buildHandoffPayload(latest) }
    return jsonResponse(200, response)
  } catch (error) {
    const { status, body } = toErrorResponse(error)
    return jsonResponse(status, body)
  }
}

/**
 * Register both panel routes on the host connection service.
 *
 * A host without `connection` (older builds, unit hosts) simply gets no panel
 * API: this returns without throwing so the rest of the plugin keeps loading.
 * The disposer returned by `register` rides the plugin fiber through
 * `ctx.effect`, so a hot reload unregisters the route instead of tripping over
 * a duplicate on the next load.
 */
export function registerCoworkApi(host: CoworkApiHost, ports: CoworkApiPorts): void {
  const connection = host.get('connection') as CoworkConnection | undefined
  if (connection === undefined) return
  const routes: readonly PanelFetchRoute[] = [
    {
      path: OVERVIEW_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => handleOverview(request, ports),
    },
    {
      path: HANDOFF_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => handleHandoff(request, ports),
    },
  ]
  for (const route of routes) {
    host.effect(() => connection.fetch.register(route), `dsh-cowork: panel route ${route.path}`)
  }
}
