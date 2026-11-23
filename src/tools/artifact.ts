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
    execute: async (args, exec) => {
      const caller = callerOf(exec)
      if (isFailure(caller)) return toJson(caller)
      try {
        const opened = await openProject(caller, deps)
        if (isFailure(opened)) return toJson(opened)
        const denied = checkRole('master-or-thread', caller, opened.index)
        if (denied !== null) return toJson(denied)
        const runtime = runtimeOf(deps, opened.repoPath)
        if (runtime === null) {
          return toJson(failure(
            'artifact/fs-unavailable',
            'work items are unavailable in this host: no artifact runtime is registered',
          ))
        }
        const pathCheck = normalizeArtifactPath(args.path)
        if (!pathCheck.ok) {
          return toJson(failure('artifact/path-not-allowed', pathCheck.reason))
        }
        const path = pathCheck.path
        // The tool schema's enum already validated `type`; the cast only
        // restores the literal union the rest of this module reads.
        const type: ArtifactType = args.type === undefined
          ? inferArtifactType(path)
          : (args.type as ArtifactType)
        const title = typeof args.title === 'string' && args.title.trim() !== ''
          ? args.title.trim().slice(0, MAX_ARTIFACT_TITLE_CHARS)
          : titleForPath(path)
        const scan = await runtime.store.listRecords()
        const existing = scan.records.find((record) =>
          record.projectId === opened.index.projectId
          && record.ownerSessionId === caller.sessionId
          && record.primaryPath === path)
        if (existing !== undefined) {
          return toJson(success({ created: false, artifact: artifactSummaryOf(existing) }))
        }
        const observed = await runtime.files.stat(path)
        if (!observed.exists) {
          return toJson(failure('artifact/file-missing', `file does not exist: ${path}`, { path }))
        }
        if (!observed.regular) {
          return toJson(failure('artifact/path-not-allowed', `path is not a regular file: ${path}`, { path }))
        }
        const mediaType = inferMediaType(path)
        const editable = isEditableArtifactType(type) && isTextMediaType(mediaType)
        const now = nowOf(deps)
        const revision = 1
        let sha256 = ''
        let size = observed.size
        let content: string | null = null
        if (editable) {
          const read = await runtime.files.readText(path)
          content = read.content
          sha256 = sha256Hex(read.content)
          size = read.size
        }
        const record: ArtifactRecordV1 = {
          version: ARTIFACT_RECORD_VERSION,
          artifactId: `artifact-${randomUUID()}`,
          projectId: opened.index.projectId,
          ownerSessionId: caller.sessionId,
          title,
          type,
          status: 'pending-view',
          files: [{
            path,
            mediaType,
            editable,
            size,
            sha256,
            revision,
            fsVersion: observed.version,
            missing: false,
          }],
          primaryPath: path,
          revision,
          commentCount: 0,
          attachmentCount: 0,
          activeDispatch: null,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        }
        const created = await runtime.store.createRecord(record)
        if (content !== null) {
          try {
            await runtime.store.saveRevision(created.artifactId, 1, content)
          } catch (error) {
            // A missing first snapshot only makes a later stale save a 409.
            deps.log?.(`artifact create: revision snapshot failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        try {
          const event = await runtime.store.appendEvent({
            eventId: `event-${randomUUID()}`,
            type: 'artifact.updated',
            artifactId: created.artifactId,
            time: now.toISOString(),
            data: { revision: created.revision, path },
          })
          runtime.events.publish(event)
        } catch (error) {
          // The record is committed; a lost event is a logged evidence gap, not
          // a failed registration.
          deps.log?.(`artifact create event was not recorded: ${error instanceof Error ? error.message : String(error)}`)
        }
        return toJson(success({ created: true, artifact: artifactSummaryOf(created) }))
      } catch (error) {
        return toJson(mapError(error))
      }
    },
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
    execute: async (args, exec) => {
      const caller = callerOf(exec)
      if (isFailure(caller)) return toJson(caller)
      try {
        const opened = await openProject(caller, deps)
        if (isFailure(opened)) return toJson(opened)
        const denied = checkRole('master-or-thread', caller, opened.index)
        if (denied !== null) return toJson(denied)
        const runtime = runtimeOf(deps, opened.repoPath)
        if (runtime === null) {
          return toJson(failure('artifact/fs-unavailable', 'work items are unavailable in this host'))
        }
        const artifactId = typeof args.artifactId === 'string' ? args.artifactId.trim() : ''
        if (artifactId === '') return toJson(failure('artifact/not-found', 'artifactId is required'))
        const record = await runtime.store.readRecord(artifactId)
        if (record === null || record.projectId !== opened.index.projectId) {
          return toJson(failure('artifact/not-found', `unknown work item: ${artifactId}`))
        }
        if (record.ownerSessionId !== caller.sessionId && caller.sessionId !== opened.index.masterSessionId) {
          return toJson(failure('role/forbidden', 'only the owning topic session or the master may read this work item'))
        }
        const events = await runtime.store.readComments(artifactId)
        const threads = new Map<string, { resolved: boolean; comments: CommentEventV1[]; anchor: ArtifactAnchor | undefined }>()
        for (const event of events) {
          const thread = threads.get(event.threadId) ?? { resolved: false, comments: [], anchor: undefined }
          if (event.type === 'resolve') thread.resolved = true
          else if (event.type === 'reopen') thread.resolved = false
          else if (event.type === 'anchor-moved') thread.anchor = event.anchor
          else if (event.type === 'create' || event.type === 'reply') {
            thread.comments.push(event)
            if (event.type === 'create' && event.anchor !== undefined) thread.anchor = event.anchor
          }
          threads.set(event.threadId, thread)
        }
        const includeResolved = args.includeResolved === true
        const visible = [...threads.entries()]
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
        return toJson(success({ artifact: artifactSummaryOf(record), threads: visible }))
      } catch (error) {
        return toJson(mapError(error))
      }
    },
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
    execute: async (args, exec) => {
      const caller = callerOf(exec)
      if (isFailure(caller)) return toJson(caller)
      try {
        const opened = await openProject(caller, deps)
        if (isFailure(opened)) return toJson(opened)
        const denied = checkRole('master-or-thread', caller, opened.index)
        if (denied !== null) return toJson(denied)
        const runtime = runtimeOf(deps, opened.repoPath)
        if (runtime === null) {
          return toJson(failure('artifact/fs-unavailable', 'work items are unavailable in this host'))
        }
        const artifactId = typeof args.artifactId === 'string' ? args.artifactId.trim() : ''
        const body = typeof args.body === 'string' ? args.body.trim() : ''
        if (artifactId === '') return toJson(failure('artifact/not-found', 'artifactId is required'))
        if (body === '' || body.length > MAX_ARTIFACT_COMMENT_CHARS) {
          return toJson(failure('artifact/anchor-invalid', `body must be 1..${String(MAX_ARTIFACT_COMMENT_CHARS)} characters`))
        }
        const commentIds = Array.isArray(args.commentIds)
          ? args.commentIds.filter((id): id is string => typeof id === 'string' && id.trim() !== '').slice(0, 10)
          : []
        if (commentIds.length === 0) return toJson(failure('artifact/anchor-invalid', 'commentIds must name at least one thread'))
        const record = await runtime.store.readRecord(artifactId)
        if (record === null || record.projectId !== opened.index.projectId) {
          return toJson(failure('artifact/not-found', `unknown work item: ${artifactId}`))
        }
        if (record.ownerSessionId !== caller.sessionId && caller.sessionId !== opened.index.masterSessionId) {
          return toJson(failure('role/forbidden', 'only the owning topic session or the master may reply to this work item'))
        }
        const roots = await runtime.store.readComments(artifactId)
        const rootIds = new Set(roots.filter((event) => event.type === 'create').map((event) => event.commentId))
        for (const commentId of commentIds) {
          if (!rootIds.has(commentId)) {
            return toJson(failure('artifact/not-found', `unknown comment thread: ${commentId}`))
          }
        }
        const batch = runtime.dispatch?.inFlightFor(artifactId) ?? null
        if (batch === null) {
          // A host with a dispatcher only accepts a reply while a batch is in
          // flight; otherwise the reply would close no batch and could revive
          // a settled one. A host without a dispatcher keeps the manual path.
          if (runtime.dispatch !== null) {
            return toJson(failure('artifact/dispatch-not-found', 'no in-flight annotation batch is waiting for a reply'))
          }
        } else {
          for (const commentId of commentIds) {
            if (!batch.commentIds.includes(commentId)) {
              return toJson(failure('artifact/anchor-invalid', `reply ids must belong to the in-flight annotation batch: ${commentId}`))
            }
          }
        }
        const rawAttachments = Array.isArray(args.attachments) ? args.attachments : []
        const attachments: AttachmentRefV1[] = []
        for (const entry of rawAttachments.slice(0, 5)) {
          const ref = parseAttachmentRef(entry)
          const bytes = ref === null ? null : await runtime.store.readUpload(artifactId, ref.attachmentId)
          if (ref === null || bytes === null) {
            return toJson(failure('artifact/upload-invalid', 'attachment refs must name an upload stored on this work item'))
          }
          if (ref.name.length > 200) return toJson(failure('artifact/upload-invalid', 'attachment names must be at most 200 characters'))
          attachments.push({
            ...ref,
            mediaType: attachmentMediaType(ref.name, bytes),
            size: bytes.byteLength,
            sha256: sha256HexBytes(bytes),
          })
        }
        const now = nowOf(deps)
        const events: CommentEventV1[] = commentIds.map((commentId, index) => ({
          version: ARTIFACT_COMMENT_VERSION,
          eventId: `comment-event-${randomUUID()}`,
          artifactId,
          commentId: `comment-${randomUUID()}`,
          threadId: commentId,
          type: 'reply',
          author: 'model',
          sessionId: caller.sessionId,
          body,
          createdAt: now.toISOString(),
          ...(index === 0 && attachments.length > 0 ? { attachments } : {}),
        }))
        const committed = await runtime.store.withLock(async () => {
          const current = await runtime.store.readRecord(artifactId)
          if (current !== null && current.commentCount >= MAX_ARTIFACT_COMMENTS) {
            throw new ArtifactDomainError('artifact/comment-limit', `work item already holds ${String(MAX_ARTIFACT_COMMENTS)} comments`)
          }
          // The reply's refs are published in the same transaction that writes
          // the reply, so the thread and the attachment list never disagree.
          const publishEvents = []
          for (const attachment of attachments) {
            const outcome = await publishAttachmentUnlocked(runtime, {
              artifactId,
              attachment,
              source: 'user',
              now,
            })
            if (outcome.event !== null) publishEvents.push(outcome.event)
          }
          let saved = record
          for (const event of events) {
            await runtime.store.appendCommentUnlocked(event)
            saved = await runtime.store.mutateRecordUnlocked(artifactId, (current) =>
              applyCommentEventForTool(current, now))
          }
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
        for (const event of committed.events) runtime.events.publish(event)
        let dispatchId: string | null = null
        if (runtime.dispatch !== null) {
          const dispatch = runtime.dispatch.inFlightFor(artifactId)
          if (dispatch !== null && (await runtime.dispatch.markReplied(dispatch.dispatchId))) dispatchId = dispatch.dispatchId
        }
        return toJson(success({ replied: events.length, dispatchId, artifact: artifactSummaryOf(committed.record) }))
      } catch (error) {
        return toJson(mapError(error))
      }
    },
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
    execute: async (args, exec) => {
      const caller = callerOf(exec)
      if (isFailure(caller)) return toJson(caller)
      try {
        const opened = await openProject(caller, deps)
        if (isFailure(opened)) return toJson(opened)
        const denied = checkRole('master-or-thread', caller, opened.index)
        if (denied !== null) return toJson(denied)
        const runtime = runtimeOf(deps, opened.repoPath)
        if (runtime === null) {
          return toJson(failure('artifact/fs-unavailable', 'work items are unavailable in this host'))
        }
        const artifactId = typeof args.artifactId === 'string' ? args.artifactId.trim() : ''
        if (artifactId === '') return toJson(failure('artifact/not-found', 'artifactId is required'))
        const record = await runtime.store.readRecord(artifactId)
        if (record === null || record.projectId !== opened.index.projectId) {
          return toJson(failure('artifact/not-found', `unknown work item: ${artifactId}`))
        }
        if (record.ownerSessionId !== caller.sessionId && caller.sessionId !== opened.index.masterSessionId) {
          return toJson(failure('role/forbidden', 'only the owning topic session or the master may attach to this work item'))
        }
        const pathCheck = normalizeArtifactPath(args.sourcePath)
        if (!pathCheck.ok) return toJson(failure('artifact/path-not-allowed', pathCheck.reason))
        const sourcePath = pathCheck.path
        if (record.attachmentCount >= MAX_ARTIFACT_ATTACHMENTS) {
          return toJson(failure(
            'artifact/limit-reached',
            `work item already holds ${String(MAX_ARTIFACT_ATTACHMENTS)} attachments`,
          ))
        }
        // The bytes are read only after the path is proven to resolve to a
        // regular file inside the repository, and the size is checked before
        // the read so an oversized file is never loaded.
        const bytes = await readBytesInsideRepo(runtime.repoPath, sourcePath, MAX_ARTIFACT_ATTACHMENT_BYTES)
        if (bytes.byteLength === 0) {
          return toJson(failure('artifact/upload-invalid', 'attachment is empty', { path: sourcePath }))
        }
        // The type comes from the file the model generated, never from the
        // display name it supplies; whitespace and control characters are
        // stripped from that name.
        const name = sanitizeAttachmentName(args.name, sourcePath.slice(sourcePath.lastIndexOf('/') + 1))
        const attachment: AttachmentRefV1 = {
          attachmentId: `attachment-${randomUUID()}`,
          name,
          mediaType: attachmentMediaType(sourcePath, bytes),
          size: bytes.byteLength,
          sha256: sha256HexBytes(bytes),
        }
        await runtime.store.saveUpload(artifactId, attachment.attachmentId, bytes)
        const now = nowOf(deps)
        const outcome = await runtime.store.withLock(() =>
          publishAttachmentUnlocked(runtime, { artifactId, attachment, source: 'model', now }))
        if (outcome.event !== null) runtime.events.publish(outcome.event)
        return toJson(success({
          attachment: attachmentRefOf(outcome.publish),
          source: 'model',
          published: outcome.published,
          record: artifactSummaryOf(outcome.record),
        }))
      } catch (error) {
        return toJson(mapError(error))
      }
    },
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
