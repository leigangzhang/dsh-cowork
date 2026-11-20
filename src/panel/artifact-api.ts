/**
 * HTTP surface of the work-item (artifact) feature.
 *
 * Every route is an Exact Fetch route beside the ten panel routes: the browser
 * sends only a `sessionId` and the server resolves the project from the host's
 * session metadata, then reads/writes `<repo>/.dsh-cowork/artifacts/` through
 * the per-project runtime. No route accepts an absolute path; a file path must
 * be one of the work item's registered project-relative paths.
 *
 * The route module owns wire parsing and status codes only. Business rules live
 * in `src/domains/artifact/` and persistence in `src/store/artifact-store.ts`; the
 * shared error envelope is produced by the panel plumbing (`serve`), which maps
 * {@link ArtifactDomainError} onto the one `PanelErrorBody` table.
 */
import { randomUUID } from 'node:crypto'
import type { PanelErrorCode } from './api-contract.js'
import type { PanelFetchRoute } from './api-types.js'
import {
  ARTIFACT_COMMENT_PATH,
  ARTIFACT_COMMENT_RESOLVE_PATH,
  ARTIFACT_COMMENT_VERSION,
  ARTIFACT_COMMENTS_PATH,
  ARTIFACT_COMMENTS_DEFAULT_LIMIT,
  ARTIFACT_COMMENTS_MAX_LIMIT,
  ARTIFACT_DETAIL_PATH,
  ARTIFACT_EVENTS_PATH,
  ARTIFACT_FILE_PATH,
  ARTIFACT_LIST_MAX_LIMIT,
  ARTIFACT_LIST_PATH,
  ARTIFACT_STATUS_PATH,
  MAX_ARTIFACT_COMMENT_CHARS,
  addArtifactToCounts,
  artifactSummaryOf,
  emptyArtifactCounts,
  isArtifactStatus,
  type ArtifactAnchor,
  type ArtifactCommentResponse,
  type ArtifactCommentResolveResponse,
  type ArtifactCommentsResponse,
  type ArtifactDetailResponse,
  type ArtifactEventV1,
  type ArtifactFileResponse,
  type ArtifactListResponse,
  type ArtifactRecordV1,
  type ArtifactStatusResponse,
  type CommentEventV1,
} from './artifact-contract.js'
import type { ArtifactRuntime } from '../platform/artifact-runtime.js'
import { parseLastEventId, openArtifactEventStream } from '../platform/artifact-events.js'
import { ArtifactDomainError } from '../domains/artifact/errors.js'
import { parseArtifactAnchor, deriveLineAnchor } from '../domains/artifact/anchor.js'
import { isTextMediaType } from '../domains/artifact/paths.js'
import { reconcileArtifactFile } from '../platform/artifact-files.js'
import { applyCommentEvent, applyStatusAction } from '../domains/artifact/state.js'
import type { ArtifactStatusAction } from '../domains/artifact/state.js'

/** One resolved project and its work-item runtime. */
export interface ArtifactOpenedProject {
  readonly repoPath: string
  readonly projectId: string
}

/**
 * The plumbing the panel assembly lends this module. It keeps one implementation
 * of session→project resolution, JSON bodies, the same-origin fence, and the
 * shared error envelope; the artifact routes never re-implement those.
 */
export interface ArtifactRouteKit {
  openProject(sessionId: string): Promise<ArtifactOpenedProject>
  readJsonBody(request: Request): Promise<Record<string, unknown>>
  jsonResponse(status: number, payload: unknown): Response
  serve(handler: (request: Request) => Promise<Response>): (request: Request) => Promise<Response>
  fail(code: PanelErrorCode, message: string, path?: string): Error
}

/** What the artifact route module needs from the composition root. */
export interface ArtifactApiPorts {
  runtimeFor(repoPath: string): ArtifactRuntime
  now?(): Date
  log?(message: string): void
}

/** A query parameter, or null when absent or blank. `GET` routes carry no body. */
function queryParam(request: Request, name: string): string | null {
  const value = new URL(request.url).searchParams.get(name)
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** A required query parameter. */
function requireQuery(request: Request, name: string, kit: ArtifactRouteKit, code: PanelErrorCode): string {
  const value = queryParam(request, name)
  if (value === null) throw kit.fail(code, `query parameter ${name} is required`)
  return value
}

/** A required non-blank body string. */
function requireBodyString(
  body: Record<string, unknown>,
  name: string,
  kit: ArtifactRouteKit,
  code: PanelErrorCode = 'request/invalid-body',
): string {
  const value = body[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw kit.fail(code, `body field ${name} is required`)
  }
  return value.trim()
}

/** A required body boolean. */
function requireBodyBoolean(body: Record<string, unknown>, name: string, kit: ArtifactRouteKit): boolean {
  const value = body[name]
  if (typeof value !== 'boolean') throw kit.fail('request/invalid-body', `body field ${name} must be a boolean`)
  return value
}

/** The clock every write stamps. */
function nowOf(ports: ArtifactApiPorts): Date {
  return ports.now?.() ?? new Date()
}

/** Build one artifact event row ready for `store.appendEventUnlocked`. */
function eventRow(
  artifactId: string,
  type: ArtifactEventV1['type'],
  now: Date,
  data: Readonly<Record<string, unknown>>,
): Omit<ArtifactEventV1, 'version' | 'seq'> {
  return {
    eventId: `event-${randomUUID()}`,
    type,
    artifactId,
    time: now.toISOString(),
    data,
  }
}

/**
 * Read the work item a request names, after proving it belongs to the project
 * the session resolved to. A record from another project is refused instead of
 * served, so a copied id cannot cross project boundaries.
 */
async function openRecord(
  ports: ArtifactApiPorts,
  kit: ArtifactRouteKit,
  sessionId: string,
  artifactId: string,
): Promise<{ record: ArtifactRecordV1; runtime: ArtifactRuntime }> {
  const opened = await kit.openProject(sessionId)
  const runtime = ports.runtimeFor(opened.repoPath)
  const record = await runtime.store.readRecord(artifactId)
  if (record === null) {
    throw new ArtifactDomainError('artifact/not-found', `work item is missing: ${artifactId}`, artifactId)
  }
  if (record.projectId !== opened.projectId) {
    throw new ArtifactDomainError(
      'artifact/session-mismatch',
      `work item ${artifactId} belongs to another project`,
      artifactId,
    )
  }
  return { record, runtime }
}

/**
 * Reconcile every registered file against the filesystem, persist the result,
 * and append the events the change produces. Returns the record and the events
 * so the caller can broadcast them after the transaction commits.
 */
export async function reconcileRecord(
  runtime: ArtifactRuntime,
  record: ArtifactRecordV1,
  now: Date,
): Promise<{ record: ArtifactRecordV1; events: ArtifactEventV1[] }> {
  if (!runtime.fsAvailable) return { record, events: [] }
  const files = []
  const changed: { path: string; revision: number; missing: boolean }[] = []
  for (const file of record.files) {
    const result = await reconcileArtifactFile(runtime.files, file)
    files.push(result.file)
    if (result.changed) changed.push({ path: result.file.path, revision: result.file.revision, missing: result.file.missing })
  }
  if (changed.length === 0) return { record, events: [] }
  const reconciled = new Map(files.map((file) => [file.path, file]))
  return runtime.store.withLock(async () => {
    // Re-read inside the lock so a concurrent comment count or status update is
    // kept; only the reconciled file entries and the revision are ours.
    const current = await runtime.store.readRecord(record.artifactId)
    if (current === null) {
      throw new ArtifactDomainError('artifact/not-found', `work item is missing: ${record.artifactId}`, record.artifactId)
    }
    const next: ArtifactRecordV1 = {
      ...current,
      files: current.files.map((file) => reconciled.get(file.path) ?? file),
      revision: current.revision + 1,
      updatedAt: now.toISOString(),
    }
    const saved = await runtime.store.mutateRecordUnlocked(next.artifactId, () => next)
    const events: ArtifactEventV1[] = []
    for (const file of changed) {
      events.push(await runtime.store.appendEventUnlocked(
        eventRow(saved.artifactId, 'file.changed', now, file),
      ))
    }
    events.push(await runtime.store.appendEventUnlocked(
      eventRow(saved.artifactId, 'artifact.updated', now, { revision: saved.revision }),
    ))
    return { record: saved, events }
  })
}

/** Broadcast already-committed events to live subscribers. */
function publishAll(runtime: ArtifactRuntime, events: readonly ArtifactEventV1[]): void {
  for (const event of events) runtime.events.publish(event)
}

/** `GET /api/cowork.artifact.list` — the right-rail list and its counts. */
async function handleList(
  request: Request,
  ports: ArtifactApiPorts,
  kit: ArtifactRouteKit,
): Promise<Response> {
  const sessionId = requireQuery(request, 'sessionId', kit, 'request/session-required')
  const status = queryParam(request, 'status')
  if (status !== null && !isArtifactStatus(status)) {
    throw kit.fail('request/invalid-query', `unknown artifact status: ${status}`)
  }
  const opened = await kit.openProject(sessionId)
  const runtime = ports.runtimeFor(opened.repoPath)
  const scan = await runtime.store.listRecords(ARTIFACT_LIST_MAX_LIMIT)
  for (const artifactId of scan.corrupt) {
    ports.log?.(`artifact list: skipping unreadable work item ${artifactId}`)
  }
  const projectRecords = scan.records.filter((record) => record.projectId === opened.projectId)
  let counts = emptyArtifactCounts()
  for (const record of projectRecords) counts = addArtifactToCounts(counts, record.status)
  const items = projectRecords
    .filter((record) => status === null || record.status === status)
    .map((record) => artifactSummaryOf(record))
  const response: ArtifactListResponse = {
    ok: true,
    items,
    counts,
    truncated: scan.total > scan.records.length,
  }
  return kit.jsonResponse(200, response)
}

/** `GET /api/cowork.artifact.detail` — one work item with reconciled files. */
async function handleDetail(
  request: Request,
  ports: ArtifactApiPorts,
  kit: ArtifactRouteKit,
): Promise<Response> {
  const sessionId = requireQuery(request, 'sessionId', kit, 'request/session-required')
  const artifactId = requireQuery(request, 'artifactId', kit, 'request/invalid-query')
  const { record, runtime } = await openRecord(ports, kit, sessionId, artifactId)
  const reconciled = await reconcileRecord(runtime, record, nowOf(ports))
  publishAll(runtime, reconciled.events)
  const response: ArtifactDetailResponse = {
    ok: true,
    record: reconciled.record,
    eventsSeq: await runtime.store.lastEventSeq(),
  }
  return kit.jsonResponse(200, response)
}

/** The registered file a request names, or a refusal. */
function registeredFile(
  record: ArtifactRecordV1,
  path: string,
): ArtifactRecordV1['files'][number] {
  const file = record.files.find((entry) => entry.path === path)
  if (file === undefined) {
    throw new ArtifactDomainError('artifact/path-not-allowed', `path is not registered on this work item: ${path}`, path)
  }
  return file
}

/** `GET /api/cowork.artifact.file` — one registered text file. */
async function handleFile(
  request: Request,
  ports: ArtifactApiPorts,
  kit: ArtifactRouteKit,
): Promise<Response> {
  const sessionId = requireQuery(request, 'sessionId', kit, 'request/session-required')
  const artifactId = requireQuery(request, 'artifactId', kit, 'request/invalid-query')
  const path = requireQuery(request, 'path', kit, 'request/invalid-query')
  const { record, runtime } = await openRecord(ports, kit, sessionId, artifactId)
  const file = registeredFile(record, path)
  if (!isTextMediaType(file.mediaType)) {
    throw new ArtifactDomainError(
      'artifact/not-previewable',
      `this host renders ${file.mediaType} files in a later stage; the text viewer cannot preview it`,
      path,
    )
  }
  const reconciled = await reconcileRecord(runtime, record, nowOf(ports))
  publishAll(runtime, reconciled.events)
  const current = registeredFile(reconciled.record, path)
  const read = await runtime.files.readText(path)
  const response: ArtifactFileResponse = {
    ok: true,
    artifactId: reconciled.record.artifactId,
    path,
    mediaType: current.mediaType,
    content: read.content,
    size: read.size,
    sha256: current.sha256,
    revision: current.revision,
    fsVersion: read.version ?? current.fsVersion,
  }
  return kit.jsonResponse(200, response)
}

/** `GET /api/cowork.artifact.comments` — one page of comment rows. */
async function handleComments(
  request: Request,
  ports: ArtifactApiPorts,
  kit: ArtifactRouteKit,
): Promise<Response> {
  const sessionId = requireQuery(request, 'sessionId', kit, 'request/session-required')
  const artifactId = requireQuery(request, 'artifactId', kit, 'request/invalid-query')
  const limitText = queryParam(request, 'limit')
  const limit = limitText === null ? ARTIFACT_COMMENTS_DEFAULT_LIMIT : Number(limitText)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ARTIFACT_COMMENTS_MAX_LIMIT) {
    throw kit.fail('request/invalid-query', `limit must be an integer from 1 to ${ARTIFACT_COMMENTS_MAX_LIMIT}`)
  }
  const { runtime } = await openRecord(ports, kit, sessionId, artifactId)
  const events = await runtime.store.readComments(artifactId)
  const after = queryParam(request, 'after')
  const start = after === null
    ? 0
    : events.findIndex((event) => event.eventId === after) + 1
  const page = events.slice(start, start + limit)
  const response: ArtifactCommentsResponse = {
    ok: true,
    events: page,
    truncated: start + page.length < events.length,
  }
  return kit.jsonResponse(200, response)
}

/** Resolve and validate the anchor a create-comment request carries. */
async function commentAnchor(
  runtime: ArtifactRuntime,
  record: ArtifactRecordV1,
  value: unknown,
): Promise<{ anchor: ArtifactAnchor; fileRevision: number | null } | null> {
  if (value === undefined) return null
  const parsed = parseArtifactAnchor(value)
  if (!parsed.ok) throw new ArtifactDomainError('artifact/anchor-invalid', parsed.reason)
  const file = registeredFile(record, parsed.anchor.path)
  if (parsed.anchor.kind !== 'line-range') {
    return { anchor: parsed.anchor, fileRevision: file.revision }
  }
  if (!isTextMediaType(file.mediaType)) {
    throw new ArtifactDomainError('artifact/anchor-invalid', 'a line-range anchor needs a text file', file.path)
  }
  const read = await runtime.files.readText(file.path)
  const derived = deriveLineAnchor(read.content, file.path, parsed.anchor.startLine, parsed.anchor.endLine)
  if (!derived.ok) throw new ArtifactDomainError('artifact/anchor-invalid', derived.reason, file.path)
  return { anchor: derived.anchor, fileRevision: file.revision }
}

/** `POST /api/cowork.artifact.comment` — append one comment (or reply). */
async function handleComment(
  request: Request,
  ports: ArtifactApiPorts,
  kit: ArtifactRouteKit,
): Promise<Response> {
  const body = await kit.readJsonBody(request)
  const sessionId = requireBodyString(body, 'sessionId', kit)
  const artifactId = requireBodyString(body, 'artifactId', kit)
  const text = requireBodyString(body, 'body', kit)
  if (text.length > MAX_ARTIFACT_COMMENT_CHARS) {
    throw kit.fail('request/invalid-body', `body must be at most ${MAX_ARTIFACT_COMMENT_CHARS} characters`)
  }
  if (body.dispatch === true) {
    throw new ArtifactDomainError(
      'artifact/dispatch-unavailable',
      'annotation delivery is not available on this host yet; send dispatch: false',
    )
  }
  const { record, runtime } = await openRecord(ports, kit, sessionId, artifactId)
  const now = nowOf(ports)
  const anchorResult = await commentAnchor(runtime, record, body.anchor)
  const commentId = `comment-${randomUUID()}`
  const event: CommentEventV1 = {
    version: ARTIFACT_COMMENT_VERSION,
    eventId: `comment-event-${randomUUID()}`,
    artifactId,
    commentId,
    threadId: commentId,
    type: 'create',
    author: 'user',
    body: text,
    createdAt: now.toISOString(),
    ...(anchorResult === null
      ? {}
      : { anchor: anchorResult.anchor, ...(anchorResult.fileRevision === null ? {} : { fileRevision: anchorResult.fileRevision }) }),
  }
  const result = await runtime.store.withLock(async () => {
    await runtime.store.appendCommentUnlocked(event)
    const saved = await runtime.store.mutateRecordUnlocked(artifactId, (current) =>
      applyCommentEvent(current, event, now).record)
    const events = [
      await runtime.store.appendEventUnlocked(eventRow(artifactId, 'comment.created', now, { commentId })),
      await runtime.store.appendEventUnlocked(
        eventRow(artifactId, 'artifact.updated', now, { revision: saved.revision }),
      ),
    ]
    return { record: saved, events }
  })
  publishAll(runtime, result.events)
  const response: ArtifactCommentResponse = {
    ok: true,
    comment: event,
    dispatch: null,
    record: result.record,
  }
  return kit.jsonResponse(200, response)
}

/** The current thread state: the last resolve/reopen row wins; default open. */
function threadResolved(events: readonly CommentEventV1[], threadId: string): boolean {
  let resolved = false
  for (const event of events) {
    if (event.threadId !== threadId) continue
    if (event.type === 'resolve') resolved = true
    if (event.type === 'reopen') resolved = false
  }
  return resolved
}

/** `POST /api/cowork.artifact.comment.resolve` — resolve or reopen a thread. */
async function handleCommentResolve(
  request: Request,
  ports: ArtifactApiPorts,
  kit: ArtifactRouteKit,
): Promise<Response> {
  const body = await kit.readJsonBody(request)
  const sessionId = requireBodyString(body, 'sessionId', kit)
  const artifactId = requireBodyString(body, 'artifactId', kit)
  const commentId = requireBodyString(body, 'commentId', kit)
  const resolved = requireBodyBoolean(body, 'resolved', kit)
  const { record, runtime } = await openRecord(ports, kit, sessionId, artifactId)
  const now = nowOf(ports)
  const events = await runtime.store.readComments(artifactId)
  const root = events.find((event) => event.type === 'create' && event.commentId === commentId)
  if (root === undefined) {
    throw new ArtifactDomainError('artifact/not-found', `unknown comment thread: ${commentId}`, commentId)
  }
  if (threadResolved(events, commentId) === resolved) {
    const unchanged: ArtifactCommentResolveResponse = { ok: true, changed: false, comment: null, record }
    return kit.jsonResponse(200, unchanged)
  }
  const event: CommentEventV1 = {
    version: ARTIFACT_COMMENT_VERSION,
    eventId: `comment-event-${randomUUID()}`,
    artifactId,
    commentId,
    threadId: commentId,
    type: resolved ? 'resolve' : 'reopen',
    author: 'user',
    createdAt: now.toISOString(),
  }
  const result = await runtime.store.withLock(async () => {
    await runtime.store.appendCommentUnlocked(event)
    const saved = await runtime.store.mutateRecordUnlocked(artifactId, (current) =>
      applyCommentEvent(current, event, now).record)
    const emitted = [
      await runtime.store.appendEventUnlocked(
        eventRow(artifactId, 'comment.updated', now, { commentId, resolved }),
      ),
      await runtime.store.appendEventUnlocked(
        eventRow(artifactId, 'artifact.updated', now, { revision: saved.revision }),
      ),
    ]
    return { record: saved, events: emitted }
  })
  publishAll(runtime, result.events)
  const response: ArtifactCommentResolveResponse = {
    ok: true,
    changed: true,
    comment: event,
    record: result.record,
  }
  return kit.jsonResponse(200, response)
}

/** `POST /api/cowork.artifact.status` — viewer open or explicit confirm. */
async function handleStatus(
  request: Request,
  ports: ArtifactApiPorts,
  kit: ArtifactRouteKit,
): Promise<Response> {
  const body = await kit.readJsonBody(request)
  const sessionId = requireBodyString(body, 'sessionId', kit)
  const artifactId = requireBodyString(body, 'artifactId', kit)
  const action = body.action
  if (action !== 'view' && action !== 'confirm') {
    throw kit.fail('request/invalid-body', "action must be 'view' or 'confirm'")
  }
  const { runtime } = await openRecord(ports, kit, sessionId, artifactId)
  const now = nowOf(ports)
  const statusAction: ArtifactStatusAction = action
  const result = await runtime.store.withLock(async () => {
    let changed = false
    const saved = await runtime.store.mutateRecordUnlocked(artifactId, (current) => {
      const change = applyStatusAction(current, statusAction, now)
      changed = change.changed
      return change.changed ? change.record : null
    })
    if (!changed) return { record: saved, changed: false, events: [] as ArtifactEventV1[] }
    const events = [
      await runtime.store.appendEventUnlocked(
        eventRow(artifactId, 'artifact.updated', now, { status: saved.status }),
      ),
    ]
    return { record: saved, changed: true, events }
  })
  publishAll(runtime, result.events)
  const response: ArtifactStatusResponse = { ok: true, changed: result.changed, record: result.record }
  return kit.jsonResponse(200, response)
}

/** `GET /api/cowork.artifact.events` — the project SSE stream. */
async function handleEvents(
  request: Request,
  ports: ArtifactApiPorts,
  kit: ArtifactRouteKit,
): Promise<Response> {
  const sessionId = requireQuery(request, 'sessionId', kit, 'request/session-required')
  const artifactId = queryParam(request, 'artifactId')
  const opened = await kit.openProject(sessionId)
  const runtime = ports.runtimeFor(opened.repoPath)
  const lastEventId = parseLastEventId(request.headers.get('last-event-id'))
  return openArtifactEventStream({
    hub: runtime.events,
    source: runtime.store,
    ...(artifactId === null ? {} : { filter: { artifactId } }),
    lastEventId,
    signal: request.signal,
  })
}

/** Build the eight stage-1 artifact routes, in registration order. */
export function artifactPanelRoutes(
  ports: ArtifactApiPorts,
  kit: ArtifactRouteKit,
): PanelFetchRoute[] {
  const route = (
    path: string,
    methods: PanelFetchRoute['methods'],
    handler: (request: Request) => Promise<Response>,
  ): PanelFetchRoute => ({
    path,
    methods,
    requestBody: 'buffered',
    fetch: kit.serve(handler),
  })
  return [
    route(ARTIFACT_LIST_PATH, ['GET'], (request) => handleList(request, ports, kit)),
    route(ARTIFACT_DETAIL_PATH, ['GET'], (request) => handleDetail(request, ports, kit)),
    route(ARTIFACT_FILE_PATH, ['GET'], (request) => handleFile(request, ports, kit)),
    route(ARTIFACT_COMMENTS_PATH, ['GET'], (request) => handleComments(request, ports, kit)),
    route(ARTIFACT_COMMENT_PATH, ['POST'], (request) => handleComment(request, ports, kit)),
    route(ARTIFACT_COMMENT_RESOLVE_PATH, ['POST'], (request) => handleCommentResolve(request, ports, kit)),
    route(ARTIFACT_STATUS_PATH, ['POST'], (request) => handleStatus(request, ports, kit)),
    route(ARTIFACT_EVENTS_PATH, ['GET'], (request) => handleEvents(request, ports, kit)),
  ]
}
