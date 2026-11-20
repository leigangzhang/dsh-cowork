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
import { resolve as resolvePath } from 'node:path'
import type { PanelErrorCode } from './api-contract.js'
import type { PanelFetchRoute } from './api-types.js'
import {
  ARTIFACT_COMMENT_PATH,
  ARTIFACT_COMMENT_RESOLVE_PATH,
  ARTIFACT_COMMENT_VERSION,
  ARTIFACT_COMMENTS_PATH,
  ARTIFACT_COMMENTS_DEFAULT_LIMIT,
  ARTIFACT_COMMENTS_MAX_LIMIT,
  ARTIFACT_ATTACHMENT_PATH,
  ARTIFACT_DETAIL_PATH,
  ARTIFACT_EDIT_PATH,
  ARTIFACT_EVENTS_PATH,
  ARTIFACT_FILE_PATH,
  ARTIFACT_LIST_MAX_LIMIT,
  ARTIFACT_LIST_PATH,
  ARTIFACT_PRESENCE_PATH,
  ARTIFACT_STATUS_PATH,
  ARTIFACT_UPLOAD_PATH,
  MAX_ARTIFACT_ATTACHMENT_BYTES,
  MAX_ARTIFACT_ATTACHMENTS,
  MAX_ARTIFACT_ATTACHMENTS_PER_COMMENT,
  MAX_ARTIFACT_COMMENT_CHARS,
  MAX_ARTIFACT_COMMENTS,
  MAX_ARTIFACT_TEXT_BYTES,
  MAX_ARTIFACT_TEXT_LINES,
  MAX_PRESENCE_RANGES,
  addArtifactToCounts,
  artifactSummaryOf,
  emptyArtifactCounts,
  isArtifactStatus,
  type ArtifactAnchor,
  type ArtifactCommentResponse,
  type ArtifactCommentResolveResponse,
  type ArtifactCommentsResponse,
  type ArtifactConflictBody,
  type ArtifactConflictRange,
  type ArtifactDetailResponse,
  type ArtifactEditResponse,
  type ArtifactEventV1,
  type ArtifactFileResponse,
  type ArtifactListResponse,
  type ArtifactPresenceResponse,
  type ArtifactRecordV1,
  type ArtifactDispatchError,
  type ArtifactStatusResponse,
  type ArtifactUploadResponse,
  type AttachmentRefV1,
  type CommentEventV1,
  type DispatchRecordV1,
} from './artifact-contract.js'
import type { ArtifactRuntime } from '../platform/artifact-runtime.js'
import { createEventRow, parseLastEventId, openArtifactEventStream } from '../platform/artifact-events.js'
import { ArtifactDomainError } from '../domains/artifact/errors.js'
import { parseArtifactAnchor, deriveLineAnchor } from '../domains/artifact/anchor.js'
import { isTextMediaType } from '../domains/artifact/paths.js'
import { reconcileArtifactFile, sha256Hex, sha256HexBytes } from '../platform/artifact-files.js'
import { mergeText } from '../domains/artifact/merge.js'
import { attachmentMediaType, isUtf8, sniffImageMediaType } from '../domains/artifact/attachments.js'
import { parseAttachmentRef } from '../store/artifact-schema.js'
import { applyCommentEvent, applyStatusAction } from '../domains/artifact/state.js'
import type { ArtifactStatusAction } from '../domains/artifact/state.js'

/** The 1-based line range the conflict UI should highlight for a whole file. */
function wholeFileRange(content: string): ArtifactConflictRange[] {
  const lines = content.split('\n')
  const count = lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
  return [{ startLine: 1, endLine: Math.max(1, count) }]
}

/** One 409 response for a save that could not be merged. */
function conflictResponse(
  kit: ArtifactRouteKit,
  currentVersion: string | null,
  revision: number,
  conflictRanges: readonly ArtifactConflictRange[],
): Response {
  const body: ArtifactConflictBody = {
    ok: false,
    error: {
      code: 'artifact/version-conflict',
      message: 'the file changed since this revision; resolve the conflict and retry the save',
    },
    currentVersion: currentVersion ?? '',
    revision,
    conflictRanges,
  }
  return kit.jsonResponse(409, body)
}

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
  readJsonBody(request: Request, maxBytes?: number): Promise<Record<string, unknown>>
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
  const files: Awaited<ReturnType<typeof reconcileArtifactFile>>[] = []
  const changed: { path: string; revision: number; missing: boolean }[] = []
  for (const file of record.files) {
    const result = await reconcileArtifactFile(runtime.files, file)
    files.push(result)
    if (result.changed) changed.push({ path: result.file.path, revision: result.file.revision, missing: result.file.missing })
  }
  if (changed.length === 0) return { record, events: [] }
  const reconciled = new Map(files.map((entry) => [entry.file.path, entry]))
  const result = await runtime.store.withLock(async () => {
    // Re-read inside the lock so a concurrent comment count or status update is
    // kept; only the reconciled file entries and the revision are ours.
    const current = await runtime.store.readRecord(record.artifactId)
    if (current === null) {
      throw new ArtifactDomainError('artifact/not-found', `work item is missing: ${record.artifactId}`, record.artifactId)
    }
    const next: ArtifactRecordV1 = {
      ...current,
      files: current.files.map((file) => reconciled.get(file.path)?.file ?? file),
      revision: current.revision + 1,
      updatedAt: now.toISOString(),
    }
    const saved = await runtime.store.mutateRecordUnlocked(next.artifactId, () => next)
    const events: ArtifactEventV1[] = []
    for (const file of changed) {
      events.push(await runtime.store.appendEventUnlocked(
        createEventRow(saved.artifactId, 'file.changed', now, file),
      ))
    }
    events.push(await runtime.store.appendEventUnlocked(
      createEventRow(saved.artifactId, 'artifact.updated', now, { revision: saved.revision }),
    ))
    return { record: saved, events }
  })
  // A snapshot of every observed revision is the merge base a later save
  // needs; a failed snapshot is logged, never allowed to fail the read.
  for (const entry of files) {
    if (entry.text === null) continue
    const savedFile = result.record.files.find((file) => file.path === entry.file.path)
    if (savedFile === undefined) continue
    try {
      await runtime.store.saveRevision(record.artifactId, savedFile.revision, entry.text)
    } catch (error) {
      // A failed snapshot is a lost merge base, not a failed read; the next
      // save answers 409 instead of guessing a base.
      void error
    }
  }
  return result
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
  runtime.presence.cacheText(resolvePath(runtime.repoPath, path), read.content)
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

/** The image magic bytes this surface accepts. */
/** Validate the attachment refs one comment or reply carries. */
async function commentAttachments(
  runtime: ArtifactRuntime,
  record: ArtifactRecordV1,
  value: unknown,
  kit: ArtifactRouteKit,
): Promise<AttachmentRefV1[]> {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_ARTIFACT_ATTACHMENTS_PER_COMMENT) {
    throw kit.fail('request/invalid-body', `attachments must be an array of at most ${String(MAX_ARTIFACT_ATTACHMENTS_PER_COMMENT)} refs`)
  }
  const refs: AttachmentRefV1[] = []
  for (const entry of value) {
    const ref = parseAttachmentRef(entry)
    if (ref === null) throw kit.fail('request/invalid-body', 'each attachment needs attachmentId, name, and mediaType')
    const bytes = await runtime.store.readUpload(record.artifactId, ref.attachmentId)
    if (bytes === null) {
      throw new ArtifactDomainError('artifact/upload-invalid', `attachment is not stored on this work item: ${ref.attachmentId}`)
    }
    // The stored bytes decide the type, size, and hash; the request values are
    // never trusted for serving or prompt image parts.
    refs.push({
      ...ref,
      mediaType: attachmentMediaType(ref.name, bytes),
      size: bytes.byteLength,
      sha256: sha256HexBytes(bytes),
    })
  }
  return refs
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
  const wantsDispatch = body.dispatch === undefined ? true : body.dispatch === true
  const { record, runtime } = await openRecord(ports, kit, sessionId, artifactId)
  const now = nowOf(ports)
  const anchorResult = await commentAnchor(runtime, record, body.anchor)
  const attachments = await commentAttachments(runtime, record, body.attachments, kit)
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
    ...(attachments.length === 0 ? {} : { attachments }),
  }
  const result = await runtime.store.withLock(async () => {
    const current = await runtime.store.readRecord(artifactId)
    if (current !== null && current.commentCount >= MAX_ARTIFACT_COMMENTS) {
      throw new ArtifactDomainError('artifact/comment-limit', `work item already holds ${String(MAX_ARTIFACT_COMMENTS)} comments`)
    }
    await runtime.store.appendCommentUnlocked(event)
    const saved = await runtime.store.mutateRecordUnlocked(artifactId, (current) => {
      const folded = applyCommentEvent(current, event, now).record
      return folded.attachmentCount === current.attachmentCount && attachments.length === 0
        ? folded
        : { ...folded, attachmentCount: current.attachmentCount + attachments.length }
    })
    const events = [
      await runtime.store.appendEventUnlocked(createEventRow(artifactId, 'comment.created', now, { commentId })),
      await runtime.store.appendEventUnlocked(
        createEventRow(artifactId, 'artifact.updated', now, { revision: saved.revision }),
      ),
    ]
    return { record: saved, events }
  })
  publishAll(runtime, result.events)
  let dispatch: DispatchRecordV1 | null = null
  let dispatchError: ArtifactDispatchError | null = null
  if (wantsDispatch && runtime.dispatch !== null) {
    try {
      dispatch = await runtime.dispatch.enqueue({
        record: result.record,
        commentIds: [commentId],
        comments: [event],
      })
    } catch (error) {
      // The comment is committed; a full queue is a visible delivery failure,
      // not a reason to lose the user's annotation.
      const code = error instanceof ArtifactDomainError ? error.code : 'artifact/dispatch-unavailable'
      dispatchError = { code, message: error instanceof Error ? error.message : String(error) }
      ports.log?.(`artifact comment: dispatch not queued: ${dispatchError.message}`)
    }
  }
  const response: ArtifactCommentResponse = {
    ok: true,
    comment: event,
    dispatch,
    dispatchError,
    record: dispatch === null
      ? result.record
      : { ...result.record, activeDispatch: { dispatchId: dispatch.dispatchId, state: dispatch.state, updatedAt: dispatch.updatedAt } },
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
    const current = await runtime.store.readRecord(artifactId)
    if (current !== null && current.commentCount >= MAX_ARTIFACT_COMMENTS) {
      throw new ArtifactDomainError('artifact/comment-limit', `work item already holds ${String(MAX_ARTIFACT_COMMENTS)} comments`)
    }
    await runtime.store.appendCommentUnlocked(event)
    const saved = await runtime.store.mutateRecordUnlocked(artifactId, (current) =>
      applyCommentEvent(current, event, now).record)
    const emitted = [
      await runtime.store.appendEventUnlocked(
        createEventRow(artifactId, 'comment.updated', now, { commentId, resolved }),
      ),
      await runtime.store.appendEventUnlocked(
        createEventRow(artifactId, 'artifact.updated', now, { revision: saved.revision }),
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
        createEventRow(artifactId, 'artifact.updated', now, { status: saved.status }),
      ),
    ]
    return { record: saved, changed: true, events }
  })
  publishAll(runtime, result.events)
  const response: ArtifactStatusResponse = { ok: true, changed: result.changed, record: result.record }
  return kit.jsonResponse(200, response)
}


/** Validate one presence range list from the wire. */
function parsePresenceRanges(value: unknown, kit: ArtifactRouteKit): { startLine: number; endLine: number }[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PRESENCE_RANGES) {
    throw kit.fail('request/invalid-body', `ranges must be an array of 1..${String(MAX_PRESENCE_RANGES)} line ranges`)
  }
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw kit.fail('request/invalid-body', 'each presence range must be an object')
    }
    const { startLine, endLine } = entry as { startLine?: unknown; endLine?: unknown }
    if (
      typeof startLine !== 'number' || !Number.isSafeInteger(startLine) || startLine < 1
      || typeof endLine !== 'number' || !Number.isSafeInteger(endLine) || endLine < startLine
    ) {
      throw kit.fail('request/invalid-body', 'each presence range needs ordered positive line numbers')
    }
    return { startLine, endLine }
  })
}

/**
 * `POST /api/cowork.artifact.edit` — save text with optimistic concurrency.
 *
 * The fast path writes when the browser's opaque version still matches. A
 * stale base falls back to a line merge against the snapshot the browser had;
 * only an overlap (or a missing snapshot) becomes 409 with conflict ranges.
 */
async function handleEdit(
  request: Request,
  ports: ArtifactApiPorts,
  kit: ArtifactRouteKit,
): Promise<Response> {
  const body = await kit.readJsonBody(request, MAX_ARTIFACT_TEXT_BYTES + 65_536)
  const sessionId = requireBodyString(body, 'sessionId', kit)
  const artifactId = requireBodyString(body, 'artifactId', kit)
  const path = requireBodyString(body, 'path', kit)
  if (typeof body.content !== 'string') throw kit.fail('request/invalid-body', 'body field content must be a string')
  const content = body.content
  const baseRevision = body.baseRevision
  if (typeof baseRevision !== 'number' || !Number.isSafeInteger(baseRevision) || baseRevision < 1) {
    throw kit.fail('request/invalid-body', 'body field baseRevision must be a positive integer')
  }
  const baseVersion = typeof body.baseVersion === 'string' && body.baseVersion !== '' ? body.baseVersion : null
  if (Buffer.byteLength(content, 'utf8') > MAX_ARTIFACT_TEXT_BYTES) {
    throw new ArtifactDomainError('artifact/file-too-large', `file must be at most ${String(MAX_ARTIFACT_TEXT_BYTES)} bytes`, path)
  }
  if (content.split('\n').length > MAX_ARTIFACT_TEXT_LINES) {
    throw new ArtifactDomainError('artifact/file-too-large', `file must be at most ${String(MAX_ARTIFACT_TEXT_LINES)} lines`, path)
  }
  const { record, runtime } = await openRecord(ports, kit, sessionId, artifactId)
  const registered = registeredFile(record, path)
  if (!registered.editable || !isTextMediaType(registered.mediaType)) {
    throw new ArtifactDomainError('artifact/not-editable', `file is not editable: ${path}`, path)
  }
  const now = nowOf(ports)
  const reconciled = await reconcileRecord(runtime, record, now)
  publishAll(runtime, reconciled.events)
  let current = await runtime.files.readText(path)
  let source = reconciled.record
  let file = registeredFile(source, path)
  if (content === current.content) {
    const unchanged: ArtifactEditResponse = {
      ok: true, path, content, revision: file.revision, fsVersion: current.version, record: source, merged: false,
    }
    return kit.jsonResponse(200, unchanged)
  }
  let nextContent = content
  let merged = false
  if (baseVersion === null || current.version === null || baseVersion !== current.version) {
    const base = await runtime.store.readRevision(artifactId, baseRevision)
    if (base === null) return conflictResponse(kit, current.version, file.revision, wholeFileRange(current.content))
    const result = mergeText({ base, current: current.content, mine: content })
    if (!result.ok) return conflictResponse(kit, current.version, file.revision, result.conflictRanges)
    nextContent = result.content
    merged = true
  }
  let written
  let retries = 0
  while (true) {
    try {
      written = await runtime.files.writeText(path, nextContent, current.version)
      break
    } catch (error) {
      const conflict = error instanceof ArtifactDomainError && error.code === 'artifact/version-conflict'
      if (!conflict || retries >= 2) {
        if (conflict) return conflictResponse(kit, current.version, file.revision, wholeFileRange(current.content))
        throw error
      }
      retries += 1
      current = await runtime.files.readText(path)
      const base = await runtime.store.readRevision(artifactId, baseRevision)
      if (base === null) return conflictResponse(kit, current.version, file.revision, wholeFileRange(current.content))
      const result = mergeText({ base, current: current.content, mine: content })
      if (!result.ok) return conflictResponse(kit, current.version, file.revision, result.conflictRanges)
      nextContent = result.content
      merged = true
    }
  }
  const committed = await runtime.store.withLock(async () => {
    let nextRevision = 0
    const saved = await runtime.store.mutateRecordUnlocked(artifactId, (existing) => {
      const target = existing.files.find((entry) => entry.path === path)
      if (target === undefined) return null
      nextRevision = target.revision + 1
      const nextFile = {
        ...target,
        revision: nextRevision,
        sha256: sha256Hex(nextContent),
        size: Buffer.byteLength(nextContent, 'utf8'),
        fsVersion: written.version ?? target.fsVersion,
        missing: false,
      }
      return {
        ...existing,
        files: existing.files.map((entry) => (entry.path === path ? nextFile : entry)),
        revision: existing.revision + 1,
        updatedAt: now.toISOString(),
      }
    })
    const events = [
      await runtime.store.appendEventUnlocked(
        createEventRow(artifactId, 'file.changed', now, { path, revision: nextRevision, merged }),
      ),
      await runtime.store.appendEventUnlocked(
        createEventRow(artifactId, 'artifact.updated', now, { revision: saved.revision }),
      ),
    ]
    file = registeredFile(saved, path)
    return { record: saved, events, revision: nextRevision }
  })
  publishAll(runtime, committed.events)
  try {
    await runtime.store.saveRevision(artifactId, committed.revision, nextContent)
  } catch {
    // The save is committed; a missing snapshot only turns a later stale save
    // into a 409 instead of a merge.
  }
  // The guard's old_string lookup must see what the file now contains; without
  // this refresh a later model edit using new text would find no match.
  runtime.presence.cacheText(resolvePath(runtime.repoPath, path), nextContent)
  const response: ArtifactEditResponse = {
    ok: true,
    path,
    content: nextContent,
    revision: committed.revision,
    fsVersion: written.version,
    record: committed.record,
    merged,
  }
  return kit.jsonResponse(200, response)
}

/** `POST /api/cowork.artifact.presence` — the browser's editing ranges. */
async function handlePresence(
  request: Request,
  ports: ArtifactApiPorts,
  kit: ArtifactRouteKit,
): Promise<Response> {
  const body = await kit.readJsonBody(request)
  const sessionId = requireBodyString(body, 'sessionId', kit)
  const artifactId = requireBodyString(body, 'artifactId', kit)
  const path = requireBodyString(body, 'path', kit)
  const ranges = parsePresenceRanges(body.ranges, kit)
  const { record, runtime } = await openRecord(ports, kit, sessionId, artifactId)
  registeredFile(record, path)
  const ttlMs = runtime.presence.report(resolvePath(runtime.repoPath, path), ranges)
  const response: ArtifactPresenceResponse = { ok: true, ttlMs }
  return kit.jsonResponse(200, response)
}

/** Read a raw request body with a hard byte cap. */
async function readBodyWithCap(request: Request, maxBytes: number, kit: ArtifactRouteKit): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw kit.fail('request/body-too-large', `request body must not exceed ${String(maxBytes)} bytes`)
  }
  const reader = request.body?.getReader()
  if (reader === undefined) throw kit.fail('request/invalid-body', 'request body is required')
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    total += chunk.value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw kit.fail('request/body-too-large', `request body must not exceed ${String(maxBytes)} bytes`)
    }
    chunks.push(chunk.value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** The media type one uploaded name and its bytes resolve to. */
/**
 * `POST /api/cowork.artifact.upload` — one comment attachment.
 *
 * The body is the raw bytes; the name rides the query string because the
 * connection route streams the body. Images are checked by magic bytes, text
 * must be UTF-8, and the stored file is never overwritten.
 */
async function handleUpload(
  request: Request,
  ports: ArtifactApiPorts,
  kit: ArtifactRouteKit,
): Promise<Response> {
  const sessionId = requireQuery(request, 'sessionId', kit, 'request/session-required')
  const artifactId = requireQuery(request, 'artifactId', kit, 'request/invalid-query')
  const name = requireQuery(request, 'name', kit, 'request/invalid-query')
  if (name.length > 200) throw kit.fail('request/invalid-query', 'name must be at most 200 characters')
  const { record, runtime } = await openRecord(ports, kit, sessionId, artifactId)
  if (record.attachmentCount >= MAX_ARTIFACT_ATTACHMENTS) {
    throw new ArtifactDomainError('artifact/limit-reached', `work item already holds ${String(MAX_ARTIFACT_ATTACHMENTS)} attachments`)
  }
  const bytes = await readBodyWithCap(request, MAX_ARTIFACT_ATTACHMENT_BYTES, kit)
  if (bytes.byteLength === 0) throw new ArtifactDomainError('artifact/upload-invalid', 'attachment is empty')
  const mediaType = attachmentMediaType(name, bytes)
  const attachment: AttachmentRefV1 = {
    attachmentId: `attachment-${randomUUID()}`,
    name,
    mediaType,
    size: bytes.byteLength,
    sha256: sha256HexBytes(bytes),
  }
  await runtime.store.saveUpload(artifactId, attachment.attachmentId, bytes)
  const now = nowOf(ports)
  const result = await runtime.store.withLock(async () => {
    const saved = await runtime.store.mutateRecordUnlocked(artifactId, (current) => ({
      ...current,
      attachmentCount: current.attachmentCount + 1,
      updatedAt: now.toISOString(),
    }))
    const events = [await runtime.store.appendEventUnlocked(
      createEventRow(artifactId, 'artifact.updated', now, { attachmentId: attachment.attachmentId }),
    )]
    return { record: saved, events }
  })
  publishAll(runtime, result.events)
  const response: ArtifactUploadResponse = { ok: true, attachment }
  return kit.jsonResponse(200, response)
}

/** `GET /api/cowork.artifact.attachment` — one stored attachment's bytes. */
async function handleAttachment(
  request: Request,
  ports: ArtifactApiPorts,
  kit: ArtifactRouteKit,
): Promise<Response> {
  const sessionId = requireQuery(request, 'sessionId', kit, 'request/session-required')
  const artifactId = requireQuery(request, 'artifactId', kit, 'request/invalid-query')
  const attachmentId = requireQuery(request, 'attachmentId', kit, 'request/invalid-query')
  const { runtime } = await openRecord(ports, kit, sessionId, artifactId)
  const events = await runtime.store.readComments(artifactId)
  let ref: AttachmentRefV1 | null = null
  for (const event of events) {
    if (event.type !== 'create' && event.type !== 'reply') continue
    ref = (event.attachments ?? []).find((entry) => entry.attachmentId === attachmentId) ?? ref
  }
  if (ref === null) {
    throw new ArtifactDomainError('artifact/not-found', `unknown attachment: ${attachmentId}`, attachmentId)
  }
  const bytes = await runtime.store.readUpload(artifactId, attachmentId)
  if (bytes === null) {
    throw new ArtifactDomainError('artifact/not-found', `attachment content is missing: ${attachmentId}`, attachmentId)
  }
  // Serve from the bytes, never the client/model supplied ref: a text upload
  // renamed to text/html must not become an executable same-origin document.
  const imageType = sniffImageMediaType(bytes)
  const text = imageType === null && isUtf8(bytes)
  const mediaType = imageType ?? (text ? 'text/plain; charset=utf-8' : 'application/octet-stream')
  const filename = ref.name.replace(/[^\w.-]/g, '_').slice(0, 120) || attachmentId
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': mediaType,
      'content-disposition': `${imageType === null ? 'attachment' : 'inline'}; filename="${filename}"`,
      'content-security-policy': "sandbox; default-src 'none'",
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
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
    requestBody: PanelFetchRoute['requestBody'] = 'buffered',
  ): PanelFetchRoute => ({
    path,
    methods,
    requestBody,
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
    route(ARTIFACT_EDIT_PATH, ['POST'], (request) => handleEdit(request, ports, kit)),
    route(ARTIFACT_PRESENCE_PATH, ['POST'], (request) => handlePresence(request, ports, kit)),
    route(ARTIFACT_UPLOAD_PATH, ['POST'], (request) => handleUpload(request, ports, kit), 'streaming'),
    route(ARTIFACT_ATTACHMENT_PATH, ['GET'], (request) => handleAttachment(request, ports, kit)),
    route(ARTIFACT_EVENTS_PATH, ['GET'], (request) => handleEvents(request, ports, kit)),
  ]
}
