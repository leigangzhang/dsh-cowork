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
import { resolveInsideRepo } from '../platform/artifact-files.js'
import type { PanelFetchRoute } from './api-types.js'
import {
  ARTIFACT_COMMENT_PATH,
  ARTIFACT_COMMENT_RESOLVE_PATH,
  ARTIFACT_DISPATCH_RETRY_PATH,
  ARTIFACT_COMMENT_VERSION,
  ARTIFACT_COMMENTS_PATH,
  ARTIFACT_COMMENTS_DEFAULT_LIMIT,
  ARTIFACT_COMMENTS_MAX_LIMIT,
  ARTIFACT_ATTACH_PATH,
  ARTIFACT_ATTACHMENT_PATH,
  ARTIFACT_DETAIL_PATH,
  ARTIFACT_EDIT_PATH,
  ARTIFACT_EVENTS_PATH,
  ARTIFACT_FILE_PATH,
  ARTIFACT_LIST_PATH,
  ARTIFACT_OPEN_PATH,
  ARTIFACT_OPEN_UNSUPPORTED_CODE,
  ARTIFACT_PRESENCE_PATH,
  ARTIFACT_REBIND_PATH,
  ARTIFACT_STATUS_PATH,
  ARTIFACT_UPLOAD_PATH,
  MAX_ARTIFACT_ATTACHMENT_BYTES,
  MAX_ARTIFACT_ATTACHMENT_NAME_CHARS,
  MAX_ARTIFACT_ATTACHMENTS,
  MAX_ARTIFACT_ATTACHMENTS_PER_COMMENT,
  MAX_ARTIFACT_COMMENT_CHARS,
  MAX_ARTIFACT_COMMENTS,
  MAX_ARTIFACT_TEXT_BYTES,
  MAX_ARTIFACT_TEXT_LINES,
  MAX_PRESENCE_RANGES,
  type ArtifactAnchor,
  type ArtifactAttachResponse,
  type ArtifactCommentResponse,
  type ArtifactCommentResolveResponse,
  type ArtifactCommentsResponse,
  type ArtifactDetailResponse,
  type ArtifactEditResponse,
  type ArtifactEventV1,
  type ArtifactFileResponse,
  type ArtifactOpenResponse,
  type ArtifactPresenceResponse,
  type ArtifactRecordV1,
  type ArtifactDispatchError,
  type ArtifactDispatchRetryResponse,
  type ArtifactDispatchSummary,
  type ArtifactStatusResponse,
  type ArtifactUploadResponse,
  type AttachmentRefV1,
  type CommentEventV1,
  type DispatchRecordV1,
} from './artifact-contract.js'
import {
  attachmentRefOf,
  publishAttachmentUnlocked,
  publishedAttachmentsOf,
  type ArtifactRuntime,
} from '../platform/artifact-runtime.js'
import { createEventRow, parseLastEventId, openArtifactEventStream } from '../platform/artifact-events.js'
import { ArtifactDomainError } from '../domains/artifact/errors.js'
import { parseArtifactAnchor, deriveLineAnchor } from '../domains/artifact/anchor.js'
import { isTextMediaType } from '../domains/artifact/paths.js'
import { sha256Hex, sha256HexBytes } from '../platform/artifact-files.js'
import {
  attachmentMediaType,
  isUtf8,
  publishedAttachmentMediaType,
  sanitizeAttachmentName,
  sniffImageMediaType,
} from '../domains/artifact/attachments.js'
import { parseAttachmentRef } from '../store/artifact-schema.js'
import { applyCommentEvent, applyStatusAction } from '../domains/artifact/state.js'
import type { ArtifactStatusAction } from '../domains/artifact/state.js'
import { writeArtifactEdit } from './artifact-edit.js'
import type { ArtifactApiPorts, ArtifactRouteKit } from './artifact-route-kit.js'
import {
  nowOf,
  openRecord,
  openRecordFromBody,
  publishAll,
  queryParam,
  reconcileRecord,
  registeredFile,
  relocateAnchorsUnlocked,
  requireBodyBoolean,
  requireBodyString,
  requireQuery,
} from './artifact-records.js'
import { handleRebind } from './artifact-rebind.js'
import { handleList } from './artifact-list-api.js'

// The route plumbing types used to live here; they are re-exported so existing
// importers (the panel assembly) keep one stable import site.
export type { ArtifactApiPorts, ArtifactOpenedProject, ArtifactRouteKit } from './artifact-route-kit.js'
// Kept for the tests that drive reconciliation directly.
export { reconcileRecord } from './artifact-records.js'

/** Recent delivery batches the detail response carries. */
const DISPATCH_SUMMARY_LIMIT = 50

/**
 * The owning session's title for the viewer breadcrumb.
 *
 * A host without the listing port, or a listing failure, degrades the
 * breadcrumb to "工作项"; it must not fail the work item itself. The failure is
 * logged because it is a host capability issue, not user data.
 */
async function sessionTitleOf(ports: ArtifactApiPorts, sessionId: string): Promise<string | null> {
  if (ports.sessionTitle === undefined) return null
  try {
    return await ports.sessionTitle(sessionId)
  } catch (error) {
    ports.log?.(`session title lookup failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/** Kept snapshot numbers; an auxiliary read that degrades to an empty list. */
async function revisionsOf(ports: ArtifactApiPorts, runtime: ArtifactRuntime, artifactId: string): Promise<number[]> {
  try {
    return await runtime.store.listRevisions(artifactId)
  } catch (error) {
    ports.log?.(`revision listing failed for ${artifactId}: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

/** `POST /api/cowork.artifact.open` — hand the primary file to the host. */
async function handleOpen(
  request: Request,
  ports: ArtifactApiPorts,
  kit: ArtifactRouteKit,
): Promise<Response> {
  const body = await kit.readJsonBody(request)
  const { record, runtime } = await openRecordFromBody(ports, kit, body)
  if (ports.openWorkspacePath === undefined) {
    throw new ArtifactDomainError(
      ARTIFACT_OPEN_UNSUPPORTED_CODE,
      'this host exposes no file-open capability',
      record.primaryPath,
    )
  }
  const file = registeredFile(record, record.primaryPath)
  const absolute = await resolveInsideRepo(runtime.repoPath, file.path)
  if (absolute === null) {
    throw new ArtifactDomainError('artifact/file-missing', `file does not exist: ${file.path}`, file.path)
  }
  try {
    await ports.openWorkspacePath(absolute)
  } catch (error) {
    if ((error as { code?: unknown }).code === ARTIFACT_OPEN_UNSUPPORTED_CODE) {
      throw new ArtifactDomainError(ARTIFACT_OPEN_UNSUPPORTED_CODE, 'this host exposes no file-open capability', file.path)
    }
    const detail = error instanceof Error ? error.message : String(error)
    ports.log?.(`host failed to open ${file.path}: ${detail}`)
    throw new ArtifactDomainError('artifact/io-error', `host failed to open ${file.path}: ${detail}`, file.path)
  }
  const response: ArtifactOpenResponse = { ok: true }
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
  const dispatches: ArtifactDispatchSummary[] = (await runtime.store.readDispatches(artifactId)).slice(-DISPATCH_SUMMARY_LIMIT).map((dispatch) => ({
    dispatchId: dispatch.dispatchId,
    state: dispatch.state,
    commentIds: dispatch.commentIds,
    errorCode: dispatch.errorCode,
    updatedAt: dispatch.updatedAt,
  }))
  const [sessionTitle, revisions, publishedAttachments] = await Promise.all([
    sessionTitleOf(ports, record.ownerSessionId),
    revisionsOf(ports, runtime, artifactId),
    publishedAttachmentsOf(runtime, artifactId),
  ])
  const response: ArtifactDetailResponse = {
    ok: true,
    record: reconciled.record,
    eventsSeq: await runtime.store.lastEventSeq(),
    dispatches,
    sessionTitle,
    revisions,
    publishedAttachments,
  }
  return kit.jsonResponse(200, response)
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

/**
 * `GET /api/cowork.artifact.comments` — one page of comment rows.
 *
 * The three directions keep paging honest: no cursor returns the newest page
 * the viewer opens with (`hasOlder` says more is kept), `before` walks
 * backwards, and `after` keeps the existing forward page where `truncated`
 * means newer rows follow.
 */
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
  const after = queryParam(request, 'after')
  const before = queryParam(request, 'before')
  if (after !== null && before !== null) {
    throw kit.fail('request/invalid-query', 'after and before are mutually exclusive')
  }
  const { runtime } = await openRecord(ports, kit, sessionId, artifactId)
  const events = await runtime.store.readComments(artifactId)
  const cursorIndex = (cursor: string, name: string): number => {
    const index = events.findIndex((event) => event.eventId === cursor)
    if (index < 0) {
      throw kit.fail('request/invalid-query', `${name} does not name a comment on this work item: ${cursor}`)
    }
    return index
  }
  let page: CommentEventV1[]
  let truncated = false
  let hasOlder: boolean
  if (after !== null) {
    const start = cursorIndex(after, 'after') + 1
    page = events.slice(start, start + limit)
    truncated = start + page.length < events.length
    hasOlder = false
  } else if (before !== null) {
    const end = cursorIndex(before, 'before')
    const start = Math.max(0, end - limit)
    page = events.slice(start, end)
    hasOlder = start > 0
  } else {
    const start = Math.max(0, events.length - limit)
    page = events.slice(start)
    hasOlder = start > 0
  }
  const response: ArtifactCommentsResponse = { ok: true, events: page, truncated, hasOlder }
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
  // `deriveLineAnchor` owns quote/context; the browser's sub-line selection is
  // display data that the file cannot reproduce, so it survives as sent.
  const anchor = parsed.anchor.selectedText === undefined
    ? derived.anchor
    : { ...derived.anchor, selectedText: parsed.anchor.selectedText }
  return { anchor, fileRevision: file.revision }
}

/** The validated parts of one comment/reply request body. */
interface CommentRequestParts {
  readonly text: string
  readonly wantsDispatch: boolean
  readonly threadId: string | null
}

/** Read and validate the optional reply thread id. */
function replyThreadIdOf(body: Record<string, unknown>, kit: ArtifactRouteKit): string | null {
  if (body.threadId === undefined) return null
  if (typeof body.threadId !== 'string' || body.threadId === '') {
    throw kit.fail('request/invalid-body', 'body field threadId must be a non-empty string')
  }
  if (body.anchor !== undefined) {
    throw kit.fail('request/invalid-body', 'a reply inherits its thread anchor; do not send anchor')
  }
  return body.threadId
}

/** Read and validate the body fields every comment/reply shares. */
function commentRequestOf(body: Record<string, unknown>, kit: ArtifactRouteKit): CommentRequestParts {
  const text = requireBodyString(body, 'body', kit)
  if (text.length > MAX_ARTIFACT_COMMENT_CHARS) {
    throw kit.fail('request/invalid-body', `body must be at most ${MAX_ARTIFACT_COMMENT_CHARS} characters`)
  }
  const wantsDispatch = body.dispatch === undefined ? true : body.dispatch === true
  return { text, wantsDispatch, threadId: replyThreadIdOf(body, kit) }
}

/** Reject a reply whose root thread does not exist. */
async function assertReplyThread(runtime: ArtifactRuntime, artifactId: string, threadId: string): Promise<void> {
  const comments = await runtime.store.readComments(artifactId)
  if (!comments.some((event) => event.type === 'create' && event.commentId === threadId)) {
    throw new ArtifactDomainError('artifact/not-found', `unknown comment thread: ${threadId}`, threadId)
  }
}

/** The optional anchor fields one created comment records. */
function anchorFieldsOf(anchorResult: { anchor: ArtifactAnchor; fileRevision: number | null } | null): {
  anchor?: ArtifactAnchor
  fileRevision?: number
} {
  if (anchorResult === null) return {}
  return {
    anchor: anchorResult.anchor,
    ...(anchorResult.fileRevision === null ? {} : { fileRevision: anchorResult.fileRevision }),
  }
}

/** The comment event one request appends. */
function commentEventOf(input: {
  readonly artifactId: string
  readonly commentId: string
  readonly threadId: string | null
  readonly text: string
  readonly anchorResult: { anchor: ArtifactAnchor; fileRevision: number | null } | null
  readonly attachments: readonly AttachmentRefV1[]
  readonly now: Date
}): CommentEventV1 {
  return {
    version: ARTIFACT_COMMENT_VERSION,
    eventId: `comment-event-${randomUUID()}`,
    artifactId: input.artifactId,
    commentId: input.commentId,
    threadId: input.threadId ?? input.commentId,
    type: input.threadId === null ? 'create' : 'reply',
    author: 'user',
    body: input.text,
    createdAt: input.now.toISOString(),
    ...anchorFieldsOf(input.anchorResult),
    ...(input.attachments.length === 0 ? {} : { attachments: input.attachments }),
  }
}

/** Publish the attachments one comment references, inside its transaction. */
async function publishCommentAttachments(
  runtime: ArtifactRuntime,
  artifactId: string,
  attachments: readonly AttachmentRefV1[],
  now: Date,
): Promise<ArtifactEventV1[]> {
  const events: ArtifactEventV1[] = []
  for (const attachment of attachments) {
    const outcome = await publishAttachmentUnlocked(runtime, { artifactId, attachment, source: 'user', now })
    if (outcome.event !== null) events.push(outcome.event)
  }
  return events
}

/** Append the comment's own `comment.created`/`reply.created` event. */
function appendCommentCreated(runtime: ArtifactRuntime, event: CommentEventV1, now: Date): Promise<ArtifactEventV1> {
  const type = event.type === 'create' ? 'comment.created' : 'reply.created'
  return runtime.store.appendEventUnlocked(
    createEventRow(event.artifactId, type, now, { commentId: event.commentId }),
  )
}

/** Commit the comment, its attachment publishes, and its events as one lock. */
async function commitComment(
  runtime: ArtifactRuntime,
  event: CommentEventV1,
  attachments: readonly AttachmentRefV1[],
  now: Date,
): Promise<{ record: ArtifactRecordV1; events: ArtifactEventV1[] }> {
  const { artifactId } = event
  return runtime.store.withLock(async () => {
    const current = await runtime.store.readRecord(artifactId)
    if (current !== null && current.commentCount >= MAX_ARTIFACT_COMMENTS) {
      throw new ArtifactDomainError('artifact/comment-limit', `work item already holds ${String(MAX_ARTIFACT_COMMENTS)} comments`)
    }
    // Referencing a stored upload publishes it in this same transaction: the
    // comment and the attachment list never disagree, and a re-reference of an
    // already-published id stays a no-op.
    const publishEvents = await publishCommentAttachments(runtime, artifactId, attachments, now)
    await runtime.store.appendCommentUnlocked(event)
    const saved = await runtime.store.mutateRecordUnlocked(artifactId, (open) =>
      applyCommentEvent(open, event, now).record)
    const events = [
      ...publishEvents,
      await appendCommentCreated(runtime, event, now),
      await runtime.store.appendEventUnlocked(
        createEventRow(artifactId, 'artifact.updated', now, { revision: saved.revision }),
      ),
    ]
    return { record: saved, events }
  })
}

/** Queue the dispatched batch; a full queue is a visible failure, not a lost comment. */
async function enqueueCommentDispatch(
  runtime: ArtifactRuntime,
  record: ArtifactRecordV1,
  commentId: string,
  event: CommentEventV1,
  wantsDispatch: boolean,
  ports: ArtifactApiPorts,
): Promise<{ dispatch: DispatchRecordV1 | null; dispatchError: ArtifactDispatchError | null }> {
  if (!wantsDispatch || runtime.dispatch === null) return { dispatch: null, dispatchError: null }
  try {
    const dispatch = await runtime.dispatch.enqueue({ record, commentIds: [commentId], comments: [event] })
    return { dispatch, dispatchError: null }
  } catch (error) {
    const code = error instanceof ArtifactDomainError ? error.code : 'artifact/dispatch-unavailable'
    const dispatchError = { code, message: error instanceof Error ? error.message : String(error) }
    ports.log?.(`artifact comment: dispatch not queued: ${dispatchError.message}`)
    return { dispatch: null, dispatchError }
  }
}

/** The comment route's response body, including the queued dispatch when present. */
function commentResponseOf(
  event: CommentEventV1,
  parts: { dispatch: DispatchRecordV1 | null; dispatchError: ArtifactDispatchError | null },
  record: ArtifactRecordV1,
): ArtifactCommentResponse {
  const { dispatch, dispatchError } = parts
  return {
    ok: true,
    comment: event,
    dispatch,
    dispatchError,
    record: dispatch === null
      ? record
      : { ...record, activeDispatch: { dispatchId: dispatch.dispatchId, state: dispatch.state, updatedAt: dispatch.updatedAt } },
  }
}

/** `POST /api/cowork.artifact.comment` — append one comment (or reply). */
async function handleComment(
  request: Request,
  ports: ArtifactApiPorts,
  kit: ArtifactRouteKit,
): Promise<Response> {
  const body = await kit.readJsonBody(request)
  const parts = commentRequestOf(body, kit)
  const { record, runtime } = await openRecordFromBody(ports, kit, body)
  const artifactId = record.artifactId
  const now = nowOf(ports)
  if (parts.threadId !== null) await assertReplyThread(runtime, artifactId, parts.threadId)
  const anchorResult = parts.threadId === null ? await commentAnchor(runtime, record, body.anchor) : null
  const attachments = await commentAttachments(runtime, record, body.attachments, kit)
  const commentId = `comment-${randomUUID()}`
  const event = commentEventOf({
    artifactId,
    commentId,
    threadId: parts.threadId,
    text: parts.text,
    anchorResult,
    attachments,
    now,
  })
  const result = await commitComment(runtime, event, attachments, now)
  publishAll(runtime, result.events)
  const dispatchParts = await enqueueCommentDispatch(runtime, result.record, commentId, event, parts.wantsDispatch, ports)
  return kit.jsonResponse(200, commentResponseOf(event, dispatchParts, result.record))
}

/** `POST /api/cowork.artifact.dispatch.retry` — retry one failed batch. */
async function handleDispatchRetry(
  request: Request,
  ports: ArtifactApiPorts,
  kit: ArtifactRouteKit,
): Promise<Response> {
  const body = await kit.readJsonBody(request)
  const dispatchId = requireBodyString(body, 'dispatchId', kit)
  const { record, runtime } = await openRecordFromBody(ports, kit, body)
  if (runtime.dispatch === null) {
    throw new ArtifactDomainError('artifact/dispatch-unavailable', 'delivery is not configured for this host')
  }
  const dispatch = await runtime.dispatch.retry(record, dispatchId)
  const current = await runtime.store.readRecord(record.artifactId) ?? record
  const response: ArtifactDispatchRetryResponse = { ok: true, dispatch, record: current }
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
  const commentId = requireBodyString(body, 'commentId', kit)
  const resolved = requireBodyBoolean(body, 'resolved', kit)
  const { record, runtime } = await openRecordFromBody(ports, kit, body)
  const artifactId = record.artifactId
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
  const action = body.action
  if (action !== 'view' && action !== 'confirm') {
    throw kit.fail('request/invalid-body', "action must be 'view' or 'confirm'")
  }
  const { record, runtime } = await openRecordFromBody(ports, kit, body)
  const artifactId = record.artifactId
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

/** The committed file write that must update the record, events, and cache. */
interface EditCommitInput {
  readonly runtime: ArtifactRuntime
  readonly kit: ArtifactRouteKit
  readonly artifactId: string
  readonly path: string
  readonly now: Date
  readonly content: string
  readonly merged: boolean
  readonly fsVersion: string | null
}

/**
 * Commit a written edit and publish the resulting record events.
 * @param input - the written content plus its version and merge state.
 * @returns the successful 200 response.
 */
async function commitEdit(input: EditCommitInput): Promise<Response> {
  const committed = await input.runtime.store.withLock(async () => {
    let nextRevision = 0
    const saved = await input.runtime.store.mutateRecordUnlocked(input.artifactId, (existing) => {
      const target = existing.files.find((entry) => entry.path === input.path)
      if (target === undefined) return null
      nextRevision = target.revision + 1
      const nextFile = {
        ...target,
        revision: nextRevision,
        sha256: sha256Hex(input.content),
        size: Buffer.byteLength(input.content, 'utf8'),
        fsVersion: input.fsVersion ?? target.fsVersion,
        missing: false,
      }
      return {
        ...existing,
        files: existing.files.map((entry) => (entry.path === input.path ? nextFile : entry)),
        revision: existing.revision + 1,
        updatedAt: input.now.toISOString(),
      }
    })
    const events = [
      await input.runtime.store.appendEventUnlocked(
        createEventRow(input.artifactId, 'file.changed', input.now, { path: input.path, revision: nextRevision, merged: input.merged }),
      ),
    ]
    events.push(...await relocateAnchorsUnlocked(input.runtime, saved, input.path, input.content, input.now))
    events.push(await input.runtime.store.appendEventUnlocked(
      createEventRow(input.artifactId, 'artifact.updated', input.now, { revision: saved.revision }),
    ))
    return { record: saved, events, revision: nextRevision }
  })
  publishAll(input.runtime, committed.events)
  try {
    await input.runtime.store.saveRevision(input.artifactId, committed.revision, input.content)
  } catch {
    // The save is committed; a missing snapshot only turns a later stale save
    // into a 409 instead of a merge.
  }
  // The guard's old_string lookup must see what the file now contains; without
  // this refresh a later model edit using new text would find no match.
  input.runtime.presence.cacheText(resolvePath(input.runtime.repoPath, input.path), input.content)
  const response: ArtifactEditResponse = {
    ok: true,
    path: input.path,
    content: input.content,
    revision: committed.revision,
    fsVersion: input.fsVersion,
    record: committed.record,
    merged: input.merged,
  }
  return input.kit.jsonResponse(200, response)
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
  const { record, runtime } = await openRecordFromBody(ports, kit, body)
  const artifactId = record.artifactId
  const registered = registeredFile(record, path)
  if (!registered.editable || !isTextMediaType(registered.mediaType)) {
    throw new ArtifactDomainError('artifact/not-editable', `file is not editable: ${path}`, path)
  }
  const now = nowOf(ports)
  const reconciled = await reconcileRecord(runtime, record, now)
  publishAll(runtime, reconciled.events)
  const current = await runtime.files.readText(path)
  const source = reconciled.record
  const file = registeredFile(source, path)
  if (content === current.content) {
    const unchanged: ArtifactEditResponse = {
      ok: true, path, content, revision: file.revision, fsVersion: current.version, record: source, merged: false,
    }
    return kit.jsonResponse(200, unchanged)
  }
  const written = await writeArtifactEdit({
    runtime,
    kit,
    artifactId,
    path,
    recordType: source.type,
    content,
    baseRevision,
    baseVersion,
    current,
    fileRevision: file.revision,
  })
  if (written.kind === 'conflict') return written.response
  return commitEdit({
    runtime,
    kit,
    artifactId,
    path,
    now,
    content: written.content,
    merged: written.merged,
    fsVersion: written.fsVersion,
  })
}

/** `POST /api/cowork.artifact.presence` — the browser's editing ranges. */
async function handlePresence(
  request: Request,
  ports: ArtifactApiPorts,
  kit: ArtifactRouteKit,
): Promise<Response> {
  const body = await kit.readJsonBody(request)
  const path = requireBodyString(body, 'path', kit)
  const ranges = parsePresenceRanges(body.ranges, kit)
  const { record, runtime } = await openRecordFromBody(ports, kit, body)
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

/**
 * `POST /api/cowork.artifact.upload` — store one attachment's bytes.
 *
 * The body is the raw bytes; the name rides the query string because the
 * connection route streams the body. Images are checked by magic bytes, text
 * must be UTF-8, and the stored file is never overwritten. Storing bytes
 * publishes nothing: the attachment counts, appears in the list, and becomes
 * readable only when the browser attach route or a comment/reply reference
 * publishes the id.
 */
async function handleUpload(
  request: Request,
  ports: ArtifactApiPorts,
  kit: ArtifactRouteKit,
): Promise<Response> {
  const sessionId = requireQuery(request, 'sessionId', kit, 'request/session-required')
  const artifactId = requireQuery(request, 'artifactId', kit, 'request/invalid-query')
  const name = requireQuery(request, 'name', kit, 'request/invalid-query')
  if (name.length > MAX_ARTIFACT_ATTACHMENT_NAME_CHARS) {
    throw kit.fail('request/invalid-query', `name must be at most ${String(MAX_ARTIFACT_ATTACHMENT_NAME_CHARS)} characters`)
  }
  const { record, runtime } = await openRecord(ports, kit, sessionId, artifactId)
  // Two caps bound one upload. The published cap refuses bytes that could never
  // be published; the stored-upload cap bounds orphan bytes too, because storing
  // publishes nothing and `attachmentCount` alone would let them grow without
  // limit. Published count and list still count only published rows.
  const storedUploads = await runtime.store.countUploads(record.artifactId)
  if (record.attachmentCount >= MAX_ARTIFACT_ATTACHMENTS || storedUploads >= MAX_ARTIFACT_ATTACHMENTS) {
    throw new ArtifactDomainError(
      'artifact/limit-reached',
      `work item already stores ${String(storedUploads)} upload file(s) and holds ${String(record.attachmentCount)} published attachment(s); the cap is ${String(MAX_ARTIFACT_ATTACHMENTS)}`,
    )
  }
  const bytes = await readBodyWithCap(request, MAX_ARTIFACT_ATTACHMENT_BYTES, kit)
  if (bytes.byteLength === 0) throw new ArtifactDomainError('artifact/upload-invalid', 'attachment is empty')
  const mediaType = publishedAttachmentMediaType(name, bytes)
  const attachment: AttachmentRefV1 = {
    attachmentId: `attachment-${randomUUID()}`,
    name,
    mediaType,
    size: bytes.byteLength,
    sha256: sha256HexBytes(bytes),
  }
  await runtime.store.saveUpload(artifactId, attachment.attachmentId, bytes)
  const response: ArtifactUploadResponse = { ok: true, attachment }
  return kit.jsonResponse(200, response)
}

/**
 * `POST /api/cowork.artifact.attach` — publish one stored upload.
 *
 * The browser uploads bytes first (which counts nothing), then publishes the
 * upload here, so an attachment appears, counts, and becomes readable only
 * after publication. The display name is optional; the media type, size, and
 * hash are always re-derived from the stored bytes. Publishing the same id
 * twice is idempotent: the existing row is returned with `published: false`.
 */
async function handleAttach(
  request: Request,
  ports: ArtifactApiPorts,
  kit: ArtifactRouteKit,
): Promise<Response> {
  const body = await kit.readJsonBody(request)
  const attachmentId = requireBodyString(body, 'attachmentId', kit)
  const { record, runtime } = await openRecordFromBody(ports, kit, body)
  const already = (await runtime.store.readAttachmentPublishes(record.artifactId))
    .find((row) => row.attachmentId === attachmentId)
  if (already !== undefined) {
    const response: ArtifactAttachResponse = {
      ok: true,
      attachment: attachmentRefOf(already),
      source: 'user',
      published: false,
    }
    return kit.jsonResponse(200, response)
  }
  const bytes = await runtime.store.readUpload(record.artifactId, attachmentId)
  if (bytes === null) {
    throw new ArtifactDomainError(
      'artifact/upload-invalid',
      `attachment is not stored on this work item: ${attachmentId}`,
      attachmentId,
    )
  }
  if (bytes.byteLength === 0) throw new ArtifactDomainError('artifact/upload-invalid', 'attachment is empty', attachmentId)
  const name = sanitizeAttachmentName(body.name, attachmentId)
  const attachment: AttachmentRefV1 = {
    attachmentId,
    name,
    mediaType: publishedAttachmentMediaType(name, bytes),
    size: bytes.byteLength,
    sha256: sha256HexBytes(bytes),
  }
  const now = nowOf(ports)
  const outcome = await runtime.store.withLock(() =>
    publishAttachmentUnlocked(runtime, { artifactId: record.artifactId, attachment, source: 'user', now }))
  if (outcome.event !== null) runtime.events.publish(outcome.event)
  const response: ArtifactAttachResponse = {
    ok: true,
    attachment: attachmentRefOf(outcome.publish),
    source: 'user',
    published: outcome.published,
  }
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
  // Published attachments are the only readable ones; an orphan upload has
  // bytes but no publish row, so it stays invisible. A record without the
  // publish log falls back to its comment refs (read-only legacy path).
  const publish = (await publishedAttachmentsOf(runtime, artifactId))
    .find((row) => row.attachmentId === attachmentId)
  if (publish === undefined) {
    throw new ArtifactDomainError('artifact/not-found', `unknown attachment: ${attachmentId}`, attachmentId)
  }
  const ref = attachmentRefOf(publish)
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
    route(ARTIFACT_DISPATCH_RETRY_PATH, ['POST'], (request) => handleDispatchRetry(request, ports, kit)),
    route(ARTIFACT_COMMENT_RESOLVE_PATH, ['POST'], (request) => handleCommentResolve(request, ports, kit)),
    route(ARTIFACT_STATUS_PATH, ['POST'], (request) => handleStatus(request, ports, kit)),
    route(ARTIFACT_EDIT_PATH, ['POST'], (request) => handleEdit(request, ports, kit)),
    route(ARTIFACT_PRESENCE_PATH, ['POST'], (request) => handlePresence(request, ports, kit)),
    route(ARTIFACT_UPLOAD_PATH, ['POST'], (request) => handleUpload(request, ports, kit), 'streaming'),
    route(ARTIFACT_ATTACH_PATH, ['POST'], (request) => handleAttach(request, ports, kit)),
    route(ARTIFACT_ATTACHMENT_PATH, ['GET'], (request) => handleAttachment(request, ports, kit)),
    route(ARTIFACT_EVENTS_PATH, ['GET'], (request) => handleEvents(request, ports, kit)),
    route(ARTIFACT_OPEN_PATH, ['POST'], (request) => handleOpen(request, ports, kit)),
    route(ARTIFACT_REBIND_PATH, ['POST'], (request) => handleRebind(request, ports, kit)),
  ]
}
