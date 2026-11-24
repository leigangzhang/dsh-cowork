/**
 * Work-item tools. Stage 1 ships `cowork_artifact_create`: register an existing
 * project file as a work item so the user can open, read, and annotate it.
 *
 * The tool never copies or moves the file — the record is a pointer plus the
 * counters the rail shows. `cowork_artifact_comments` and
 * `cowork_artifact_reply` read and answer annotations, and
 * `cowork_artifact_attach` publishes a project file as an attachment.
 */
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  ARTIFACT_COMMENT_VERSION,
  ARTIFACT_RECORD_VERSION,
  MAX_ARTIFACT_ATTACHMENTS,
  MAX_ARTIFACT_ATTACHMENT_BYTES,
  MAX_ARTIFACT_COMMENT_CHARS,
  MAX_ARTIFACT_COMMENTS,
  MAX_ARTIFACT_PATH_CHARS,
  MAX_ARTIFACT_TITLE_CHARS,
  artifactSummaryOf,
  type ArtifactAnchor,
  type ArtifactRecordV1,
  type ArtifactType,
  type AttachmentRefV1,
  type CommentEventV1,
} from '../panel/artifact-contract.js'
import { parseAttachmentRef } from '../store/artifact-schema.js'
import { attachmentMediaType, sanitizeAttachmentName } from '../domains/artifact/attachments.js'
import { readBytesInsideRepo, sha256HexBytes } from '../platform/artifact-files.js'
import { createEventRow } from '../platform/artifact-events.js'
import {
  inferArtifactType,
  inferMediaType,
  isEditableArtifactType,
  isTextMediaType,
  normalizeArtifactPath,
} from '../domains/artifact/paths.js'
import { sha256Hex } from '../platform/artifact-files.js'
import { ArtifactDomainError } from '../domains/artifact/errors.js'
import {
  attachmentRefOf,
  publishAttachmentUnlocked,
  type ArtifactRuntime,
} from '../platform/artifact-runtime.js'
import type { CoworkToolDeps } from '../platform/tool-runtime.js'
import { callerOf, isFailure, mapError, nowOf, openProject, renderJson, toJson } from '../platform/tool-runtime.js'
import { checkRole, failure, success } from '../platform/tool-model.js'
import type { CallerIdentity, JsonValue, ToolFailure } from '../platform/tool-model.js'
import type { ArtifactFileStat } from '../platform/artifact-files.js'
import type { ProjectRuntime } from '../platform/tool-runtime.js'
import type { ArtifactEventV1 } from '../panel/artifact-contract.js'

/** The default title: the file's base name without its extension. */
function titleForPath(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/** The work-item runtime this call uses, or a failure envelope when absent. */
function runtimeOf(deps: CoworkToolDeps, repoPath: string): ArtifactRuntime | null {
  return deps.artifactRuntime === undefined ? null : deps.artifactRuntime.runtimeFor(repoPath)
}

/** The caller, project, and runtime one work-item tool resolved. */
interface ArtifactToolScope {
  readonly caller: CallerIdentity
  readonly project: ProjectRuntime
  readonly runtime: ArtifactRuntime
}

/**
 * Resolve caller → project → role → runtime for one work-item tool.
 *
 * Every branch returns the same failure envelope the tools already produced,
 * so the per-tool bodies only carry their own validation and work.
 */
async function artifactScope(
  exec: unknown,
  deps: CoworkToolDeps,
  role: Parameters<typeof checkRole>[0],
): Promise<ArtifactToolScope | ToolFailure> {
  const caller = callerOf(exec)
  if (isFailure(caller)) return caller
  const opened = await openProject(caller, deps)
  if (isFailure(opened)) return opened
  const denied = checkRole(role, caller, opened.index)
  if (denied !== null) return denied
  const runtime = runtimeOf(deps, opened.repoPath)
  if (runtime === null) {
    return failure('artifact/fs-unavailable', 'work items are unavailable in this host')
  }
  return { caller, project: opened, runtime }
}

/** The trimmed `artifactId` argument, or ''. */
function artifactIdOf(args: { readonly artifactId?: unknown }): string {
  return typeof args.artifactId === 'string' ? args.artifactId.trim() : ''
}

/** Read one work item and prove the caller may touch it. */
async function ownedRecordOf(
  scope: ArtifactToolScope,
  artifactId: string,
  verb: 'read' | 'reply' | 'attach',
): Promise<ArtifactRecordV1 | ToolFailure> {
  const record = await scope.runtime.store.readRecord(artifactId)
  if (record === null || record.projectId !== scope.project.index.projectId) {
    return failure('artifact/not-found', `unknown work item: ${artifactId}`)
  }
  if (record.ownerSessionId !== scope.caller.sessionId && scope.caller.sessionId !== scope.project.index.masterSessionId) {
    return failure('role/forbidden', `only the owning topic session or the master may ${verb} this work item`)
  }
  return record
}

/** The validated path/type/title of one create request. */
interface CreateArtifactInput {
  readonly path: string
  readonly type: ArtifactType
  readonly title: string
}

/** Validate the path and derive the type and title of a new work item. */
function createInputOf(args: { readonly path: string; readonly title?: string; readonly type?: string }): CreateArtifactInput | ToolFailure {
  const pathCheck = normalizeArtifactPath(args.path)
  if (!pathCheck.ok) return failure('artifact/path-not-allowed', pathCheck.reason)
  const path = pathCheck.path
  // The tool schema's enum already validated `type`; the cast only restores the
  // literal union the rest of this module reads.
  const type: ArtifactType = args.type === undefined ? inferArtifactType(path) : (args.type as ArtifactType)
  const title = typeof args.title === 'string' && args.title.trim() !== ''
    ? args.title.trim().slice(0, MAX_ARTIFACT_TITLE_CHARS)
    : titleForPath(path)
  return { path, type, title }
}

/** The caller's existing record for one path, or null. */
async function existingArtifactOf(scope: ArtifactToolScope, path: string): Promise<ArtifactRecordV1 | null> {
  const scan = await scope.runtime.store.listRecords()
  return scan.records.find((record) => record.projectId === scope.project.index.projectId
    && record.ownerSessionId === scope.caller.sessionId
    && record.primaryPath === path) ?? null
}

/** The file stat a create needs, or the failure envelope for a bad path. */
async function observeCreateFile(runtime: ArtifactRuntime, path: string): Promise<ArtifactFileStat | ToolFailure> {
  const observed = await runtime.files.stat(path)
  if (!observed.exists) return failure('artifact/file-missing', `file does not exist: ${path}`, { path })
  if (!observed.regular) return failure('artifact/path-not-allowed', `path is not a regular file: ${path}`, { path })
  return observed
}

/** The initial text snapshot of a new work item (none for a non-editable one). */
async function createSnapshotOf(
  runtime: ArtifactRuntime,
  path: string,
  editable: boolean,
  observedSize: number,
): Promise<{ readonly content: string | null; readonly sha256: string; readonly size: number }> {
  if (!editable) return { content: null, sha256: '', size: observedSize }
  const read = await runtime.files.readText(path)
  return { content: read.content, sha256: sha256Hex(read.content), size: read.size }
}

/** The record one create request writes. */
function artifactRecordOf(input: {
  readonly scope: ArtifactToolScope
  readonly create: CreateArtifactInput
  readonly observed: ArtifactFileStat
  readonly mediaType: string
  readonly editable: boolean
  readonly snapshot: { readonly sha256: string; readonly size: number }
  readonly now: Date
}): ArtifactRecordV1 {
  const { scope, create, observed, mediaType, editable, snapshot, now } = input
  return {
    version: ARTIFACT_RECORD_VERSION,
    artifactId: `artifact-${randomUUID()}`,
    projectId: scope.project.index.projectId,
    ownerSessionId: scope.caller.sessionId,
    title: create.title,
    type: create.type,
    status: 'pending-view',
    files: [{
      path: create.path,
      mediaType,
      editable,
      size: snapshot.size,
      sha256: snapshot.sha256,
      revision: 1,
      fsVersion: observed.version,
      missing: false,
    }],
    primaryPath: create.path,
    revision: 1,
    commentCount: 0,
    attachmentCount: 0,
    activeDispatch: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }
}

/** Save the first revision snapshot; a failure only makes a later save a 409. */
async function saveInitialRevision(
  runtime: ArtifactRuntime,
  deps: CoworkToolDeps,
  artifactId: string,
  content: string | null,
): Promise<void> {
  if (content === null) return
  try {
    await runtime.store.saveRevision(artifactId, 1, content)
  } catch (error) {
    deps.log?.(`artifact create: revision snapshot failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Append the create event; a lost event is a logged evidence gap, not a failure. */
async function recordCreatedEvent(
  runtime: ArtifactRuntime,
  deps: CoworkToolDeps,
  artifactId: string,
  now: Date,
  path: string,
): Promise<void> {
  try {
    const event = await runtime.store.appendEvent({
      eventId: `event-${randomUUID()}`,
      type: 'artifact.updated',
      artifactId,
      time: now.toISOString(),
      data: { revision: 1, path },
    })
    runtime.events.publish(event)
  } catch (error) {
    deps.log?.(`artifact create event was not recorded: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Register one project file as a work item (create tool body). */
async function createArtifact(scope: ArtifactToolScope, args: {
  readonly path: string
  readonly title?: string
  readonly type?: string
}, deps: CoworkToolDeps): Promise<unknown> {
  const create = createInputOf(args)
  if (isFailure(create)) return create
  const existing = await existingArtifactOf(scope, create.path)
  if (existing !== null) return success({ created: false, artifact: artifactSummaryOf(existing) })
  const observed = await observeCreateFile(scope.runtime, create.path)
  if (isFailure(observed)) return observed
  const mediaType = inferMediaType(create.path)
  const editable = isEditableArtifactType(create.type) && isTextMediaType(mediaType)
  const snapshot = await createSnapshotOf(scope.runtime, create.path, editable, observed.size)
  const now = nowOf(deps)
  const record = artifactRecordOf({ scope, create, observed, mediaType, editable, snapshot, now })
  const created = await scope.runtime.store.createRecord(record)
  await saveInitialRevision(scope.runtime, deps, created.artifactId, snapshot.content)
  await recordCreatedEvent(scope.runtime, deps, created.artifactId, now, create.path)
  return success({ created: true, artifact: artifactSummaryOf(created) })
}

/** One thread's accumulated state while the comment log is folded. */
interface ThreadAccumulator {
  resolved: boolean
  anchor: ArtifactAnchor | undefined
  readonly comments: CommentEventV1[]
}

/** Apply one comment-log event to its thread. */
function applyThreadEvent(thread: ThreadAccumulator, event: CommentEventV1): void {
  if (event.type === 'resolve') thread.resolved = true
  else if (event.type === 'reopen') thread.resolved = false
  else if (event.type === 'anchor-moved') thread.anchor = event.anchor
  else if (event.type === 'create' || event.type === 'reply') {
    thread.comments.push(event)
    if (event.type === 'create' && event.anchor !== undefined) thread.anchor = event.anchor
  }
}

/** Fold the comment log into one accumulator per thread. */
function foldThreads(events: readonly CommentEventV1[]): Map<string, ThreadAccumulator> {
  const threads = new Map<string, ThreadAccumulator>()
  for (const event of events) {
    const thread = threads.get(event.threadId) ?? { resolved: false, anchor: undefined, comments: [] }
    applyThreadEvent(thread, event)
    threads.set(event.threadId, thread)
  }
  return threads
}

/** The bounded thread views one comments response carries. */
function threadViewsOf(
  threads: Map<string, ThreadAccumulator>,
  includeResolved: boolean,
): Array<{
  threadId: string
  resolved: boolean
  anchor: ArtifactAnchor | null
  comments: Array<{ commentId: string; author: 'user' | 'model'; body: string; attachments: readonly AttachmentRefV1[] }>
}> {
  return [...threads.entries()]
    .filter(([, thread]) => includeResolved || !thread.resolved)
    .slice(0, 50)
    .map(([threadId, thread]) => ({
      threadId,
      resolved: thread.resolved,
      anchor: thread.anchor ?? null,
      comments: thread.comments.slice(-20)
        .filter((comment) => comment.type === 'create' || comment.type === 'reply')
        .map((comment) => ({
          commentId: comment.commentId,
          author: comment.author,
          body: comment.body.slice(0, MAX_ARTIFACT_COMMENT_CHARS),
          attachments: comment.attachments ?? [],
        })),
    }))
}

/** Read one work item and its open threads (comments tool body). */
async function readArtifactThreads(scope: ArtifactToolScope, args: {
  readonly artifactId: string
  readonly includeResolved?: boolean
}): Promise<unknown> {
  const artifactId = artifactIdOf(args)
  if (artifactId === '') return failure('artifact/not-found', 'artifactId is required')
  const record = await ownedRecordOf(scope, artifactId, 'read')
  if (isFailure(record)) return record
  const events = await scope.runtime.store.readComments(artifactId)
  return success({
    artifact: artifactSummaryOf(record),
    threads: threadViewsOf(foldThreads(events), args.includeResolved === true),
  })
}

/** The validated fields of one reply request. */
interface ReplyInput {
  readonly artifactId: string
  readonly body: string
  readonly commentIds: string[]
}

/** Validate the reply's artifact, body, and comment ids. */
function replyInputOf(args: { readonly artifactId: string; readonly commentIds?: unknown; readonly body?: string }): ReplyInput | ToolFailure {
  const artifactId = artifactIdOf(args)
  const body = typeof args.body === 'string' ? args.body.trim() : ''
  if (artifactId === '') return failure('artifact/not-found', 'artifactId is required')
  if (body === '' || body.length > MAX_ARTIFACT_COMMENT_CHARS) {
    return failure('artifact/anchor-invalid', `body must be 1..${String(MAX_ARTIFACT_COMMENT_CHARS)} characters`)
  }
  const commentIds = Array.isArray(args.commentIds)
    ? args.commentIds.filter((id): id is string => typeof id === 'string' && id.trim() !== '').slice(0, 10)
    : []
  if (commentIds.length === 0) return failure('artifact/anchor-invalid', 'commentIds must name at least one thread')
  return { artifactId, body, commentIds }
}

/** The first reply id that is not a root thread, or null. */
function unknownRootId(commentIds: readonly string[], rootIds: ReadonlySet<string>): string | null {
  for (const commentId of commentIds) {
    if (!rootIds.has(commentId)) return commentId
  }
  return null
}

/** The first reply id outside the in-flight batch, or null. */
function outsideBatchId(commentIds: readonly string[], batchIds: readonly string[]): string | null {
  for (const commentId of commentIds) {
    if (!batchIds.includes(commentId)) return commentId
  }
  return null
}

/**
 * Prove the reply names known threads and, on a dispatch host, an in-flight
 * batch: a settled batch must not be revived by a late reply.
 */
async function replyTargetFailure(scope: ArtifactToolScope, artifactId: string, commentIds: readonly string[]): Promise<ToolFailure | null> {
  const roots = await scope.runtime.store.readComments(artifactId)
  const rootIds = new Set(roots.filter((event) => event.type === 'create').map((event) => event.commentId))
  const unknown = unknownRootId(commentIds, rootIds)
  if (unknown !== null) return failure('artifact/not-found', `unknown comment thread: ${unknown}`)
  const batch = scope.runtime.dispatch?.inFlightFor(artifactId) ?? null
  if (batch === null) {
    return scope.runtime.dispatch === null
      ? null
      : failure('artifact/dispatch-not-found', 'no in-flight annotation batch is waiting for a reply')
  }
  const outside = outsideBatchId(commentIds, batch.commentIds)
  return outside === null
    ? null
    : failure('artifact/anchor-invalid', `reply ids must belong to the in-flight annotation batch: ${outside}`)
}

/** The stored upload refs one reply attaches. */
async function replyAttachmentsOf(
  runtime: ArtifactRuntime,
  artifactId: string,
  raw: readonly unknown[],
): Promise<AttachmentRefV1[] | ToolFailure> {
  const attachments: AttachmentRefV1[] = []
  for (const entry of raw.slice(0, 5)) {
    const ref = parseAttachmentRef(entry)
    const bytes = ref === null ? null : await runtime.store.readUpload(artifactId, ref.attachmentId)
    if (ref === null || bytes === null) {
      return failure('artifact/upload-invalid', 'attachment refs must name an upload stored on this work item')
    }
    if (ref.name.length > 200) return failure('artifact/upload-invalid', 'attachment names must be at most 200 characters')
    attachments.push({
      ...ref,
      mediaType: attachmentMediaType(ref.name, bytes),
      size: bytes.byteLength,
      sha256: sha256HexBytes(bytes),
    })
  }
  return attachments
}

/** The reply events one batch writes; the first carries the attachments. */
function replyEventsOf(
  input: ReplyInput,
  sessionId: string,
  attachments: readonly AttachmentRefV1[],
  now: Date,
): CommentEventV1[] {
  return input.commentIds.map((commentId, index) => ({
    version: ARTIFACT_COMMENT_VERSION,
    eventId: `comment-event-${randomUUID()}`,
    artifactId: input.artifactId,
    commentId: `comment-${randomUUID()}`,
    threadId: commentId,
    type: 'reply',
    author: 'model',
    sessionId,
    body: input.body,
    createdAt: now.toISOString(),
    ...(index === 0 && attachments.length > 0 ? { attachments } : {}),
  }))
}

/** Publish the reply's refs inside the reply transaction. */
async function publishReplyAttachments(
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

/** Append one reply's comment rows and its counter update. */
async function appendReplyComments(
  runtime: ArtifactRuntime,
  artifactId: string,
  events: readonly CommentEventV1[],
  now: Date,
): Promise<ArtifactRecordV1> {
  let saved: ArtifactRecordV1 | null = null
  for (const event of events) {
    await runtime.store.appendCommentUnlocked(event)
    saved = await runtime.store.mutateRecordUnlocked(artifactId, (current) => applyCommentEventForTool(current, now))
  }
  // commentIds always holds at least one id, so the loop runs and saved is set.
  return saved as ArtifactRecordV1
}

/** Commit the replies, their attachment publishes, and their events as one lock. */
async function commitReplies(
  runtime: ArtifactRuntime,
  artifactId: string,
  events: readonly CommentEventV1[],
  attachments: readonly AttachmentRefV1[],
  now: Date,
): Promise<{ record: ArtifactRecordV1; events: ArtifactEventV1[] }> {
  return runtime.store.withLock(async () => {
    const current = await runtime.store.readRecord(artifactId)
    if (current !== null && current.commentCount >= MAX_ARTIFACT_COMMENTS) {
      throw new ArtifactDomainError('artifact/comment-limit', `work item already holds ${String(MAX_ARTIFACT_COMMENTS)} comments`)
    }
    const publishEvents = await publishReplyAttachments(runtime, artifactId, attachments, now)
    const saved = await appendReplyComments(runtime, artifactId, events, now)
    const published = [...publishEvents]
    for (const event of events) {
      published.push(await runtime.store.appendEventUnlocked(
        createEventRow(artifactId, 'reply.created', now, { commentId: event.commentId, threadId: event.threadId }),
      ))
    }
    published.push(await runtime.store.appendEventUnlocked(
      createEventRow(artifactId, 'artifact.updated', now, { revision: saved.revision }),
    ))
    return { record: saved, events: published }
  })
}

/** Mark the in-flight batch replied; null when there is none or it moved on. */
async function markBatchReplied(runtime: ArtifactRuntime, artifactId: string): Promise<string | null> {
  if (runtime.dispatch === null) return null
  const dispatch = runtime.dispatch.inFlightFor(artifactId)
  if (dispatch === null) return null
  return (await runtime.dispatch.markReplied(dispatch.dispatchId)) ? dispatch.dispatchId : null
}

/** Reply to the annotation threads of one work item (reply tool body). */
async function replyArtifact(scope: ArtifactToolScope, args: {
  readonly artifactId: string
  readonly commentIds?: unknown
  readonly body?: string
  readonly attachments?: unknown
}, deps: CoworkToolDeps): Promise<unknown> {
  const input = replyInputOf(args)
  if (isFailure(input)) return input
  const record = await ownedRecordOf(scope, input.artifactId, 'reply')
  if (isFailure(record)) return record
  const targetFailure = await replyTargetFailure(scope, input.artifactId, input.commentIds)
  if (targetFailure !== null) return targetFailure
  const attachments = await replyAttachmentsOf(
    scope.runtime,
    input.artifactId,
    Array.isArray(args.attachments) ? args.attachments : [],
  )
  if (isFailure(attachments)) return attachments
  const now = nowOf(deps)
  const events = replyEventsOf(input, scope.caller.sessionId, attachments, now)
  const committed = await commitReplies(scope.runtime, input.artifactId, events, attachments, now)
  for (const event of committed.events) scope.runtime.events.publish(event)
  const dispatchId = await markBatchReplied(scope.runtime, input.artifactId)
  return success({ replied: events.length, dispatchId, artifact: artifactSummaryOf(committed.record) })
}

/** The stored bytes one attach reads, or the empty-file failure. */
async function attachBytesOf(runtime: ArtifactRuntime, sourcePath: string): Promise<Uint8Array | ToolFailure> {
  const bytes = await readBytesInsideRepo(runtime.repoPath, sourcePath, MAX_ARTIFACT_ATTACHMENT_BYTES)
  if (bytes.byteLength === 0) return failure('artifact/upload-invalid', 'attachment is empty', { path: sourcePath })
  return bytes
}

/** The model-sourced attachment ref one file publishes. */
function modelAttachmentOf(name: string | undefined, sourcePath: string, bytes: Uint8Array): AttachmentRefV1 {
  const displayName = sanitizeAttachmentName(name, sourcePath.slice(sourcePath.lastIndexOf('/') + 1))
  return {
    attachmentId: `attachment-${randomUUID()}`,
    name: displayName,
    mediaType: attachmentMediaType(sourcePath, bytes),
    size: bytes.byteLength,
    sha256: sha256HexBytes(bytes),
  }
}

/** Save the bytes, then publish the row and its event in one lock. */
async function publishModelAttachment(
  runtime: ArtifactRuntime,
  artifactId: string,
  attachment: AttachmentRefV1,
  bytes: Uint8Array,
  now: Date,
): Promise<Awaited<ReturnType<typeof publishAttachmentUnlocked>>> {
  await runtime.store.saveUpload(artifactId, attachment.attachmentId, bytes)
  return runtime.store.withLock(() =>
    publishAttachmentUnlocked(runtime, { artifactId, attachment, source: 'model', now }))
}

/** Publish a project file as a model attachment (attach tool body). */
async function attachArtifact(scope: ArtifactToolScope, args: {
  readonly artifactId: string
  readonly sourcePath: string
  readonly name?: string
}, deps: CoworkToolDeps): Promise<unknown> {
  const artifactId = artifactIdOf(args)
  if (artifactId === '') return failure('artifact/not-found', 'artifactId is required')
  const record = await ownedRecordOf(scope, artifactId, 'attach')
  if (isFailure(record)) return record
  const pathCheck = normalizeArtifactPath(args.sourcePath)
  if (!pathCheck.ok) return failure('artifact/path-not-allowed', pathCheck.reason)
  if (record.attachmentCount >= MAX_ARTIFACT_ATTACHMENTS) {
    return failure('artifact/limit-reached', `work item already holds ${String(MAX_ARTIFACT_ATTACHMENTS)} attachments`)
  }
  // The bytes are read only after the path is proven to resolve to a regular
  // file inside the repository, and the size is checked before the read so an
  // oversized file is never loaded.
  const bytes = await attachBytesOf(scope.runtime, pathCheck.path)
  if (isFailure(bytes)) return bytes
  const attachment = modelAttachmentOf(args.name, pathCheck.path, bytes)
  const now = nowOf(deps)
  const outcome = await publishModelAttachment(scope.runtime, artifactId, attachment, bytes, now)
  if (outcome.event !== null) scope.runtime.events.publish(outcome.event)
  return success({
    attachment: attachmentRefOf(outcome.publish),
    source: 'model',
    published: outcome.published,
    record: artifactSummaryOf(outcome.record),
  })
}

/** The execute body every work-item tool shares: scope, body, error mapping. */
function artifactExecute<Args>(
  deps: CoworkToolDeps,
  body: (scope: ArtifactToolScope, args: Args, deps: CoworkToolDeps) => Promise<unknown>,
): (args: Args, exec: unknown) => Promise<JsonValue> {
  return async (args, exec) => {
    try {
      const scope = await artifactScope(exec, deps, 'master-or-thread')
      return isFailure(scope) ? toJson(scope) : toJson(await body(scope, args, deps))
    } catch (error) {
      return toJson(mapError(error))
    }
  }
}

/** Register `cowork_artifact_create`. */
export function registerArtifactTools(ctx: unknown, deps: CoworkToolDeps): Array<() => void> {
  const host = ctx as { tools: { register(definition: ToolDefinition): () => void } }
  const disposers: Array<() => void> = []

  disposers.push(host.tools.register(defineTool({
    name: 'cowork_artifact_create',
    description:
      'Register an existing project file as a work item (交付物) the user can open, read, and annotate. The file stays where it is; the work item is a pointer. Project-relative POSIX path, master or thread.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: `Project-relative POSIX path of an existing file (at most ${MAX_ARTIFACT_PATH_CHARS} characters).`,
      },
      title: { type: 'string', description: 'Work-item title; defaults to the file base name.' },
      type: {
        type: 'string',
        enum: ['text', 'doc', 'table', 'diagram', 'canvas', 'pdf', 'image', 'html', 'other'],
        description: 'Renderer type; inferred from the extension when omitted.',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: artifactExecute(deps, createArtifact),
  })))

  // 2) cowork_artifact_comments — read the work item and its open threads.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_artifact_comments',
    description:
      'Read one registered work item and its annotation threads, so the topic session can pick up the context a delivery prompt summarized. Master or the owning thread session.',
    parameters: {
      artifactId: { type: 'string', required: true, description: 'Work-item id (from the delivery prompt).' },
      includeResolved: { type: 'boolean', description: 'Include resolved threads too (default false).' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: artifactExecute(deps, readArtifactThreads),
  })))

  // 3) cowork_artifact_reply — write the model's reply into the threads.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_artifact_reply',
    description:
      'Reply to one or more annotation threads on a work item. Every delivered annotation batch must end with this call; the batch only becomes replied when it succeeds. Master or the owning thread session.',
    parameters: {
      artifactId: { type: 'string', required: true, description: 'Work-item id from the delivery prompt.' },
      commentIds: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'The annotation ids this reply answers (from the delivery prompt).',
      },
      body: { type: 'string', required: true, description: `Reply text, at most ${MAX_ARTIFACT_COMMENT_CHARS} characters.` },
      attachments: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: 'Attachment refs returned by cowork_artifact_comments; each must already be stored on the work item.',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: artifactExecute(deps, replyArtifact),
  })))

  // 4) cowork_artifact_attach — publish a project file as an attachment.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_artifact_attach',
    description:
      'Publish a project file (for example a generated chart image) as an attachment of a work item, so it appears in the attachment list and can be referenced by cowork_artifact_reply. The file stays where it is; the work item is a pointer. Project-relative POSIX path, master or thread, and no in-flight annotation batch is required.',
    parameters: {
      artifactId: { type: 'string', required: true, description: 'Work-item id (from the delivery prompt).' },
      sourcePath: {
        type: 'string',
        required: true,
        description: `Project-relative POSIX path of the file to publish (at most ${MAX_ARTIFACT_PATH_CHARS} characters).`,
      },
      name: { type: 'string', description: 'Display name; defaults to the file base name.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: artifactExecute(deps, attachArtifact),
  })))

  return disposers
}

/** Fold one model reply into the record counters (same rule as the routes). */
function applyCommentEventForTool(record: ArtifactRecordV1, now: Date): ArtifactRecordV1 {
  return {
    ...record,
    status: record.status === 'needs-feedback' || record.status === 'in-progress' ? record.status : 'needs-feedback',
    commentCount: record.commentCount + 1,
    updatedAt: now.toISOString(),
  }
}
