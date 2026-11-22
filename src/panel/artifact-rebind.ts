/**
 * Rebind a work-item file that moved.
 *
 * A record keeps project-relative paths; when the user moves a registered file
 * the path in the record is stale and the viewer shows it as missing. This
 * route points one registered entry at its new location after proving the new
 * location is a regular file inside the repository that no other work item
 * claims. Comment anchors follow the file: they are remapped to the new path
 * and re-located against its text, or marked stale when the quote cannot be
 * found; the comment bodies are never dropped.
 */
import { randomUUID } from 'node:crypto'
import type { ArtifactApiPorts, ArtifactRouteKit } from './artifact-route-kit.js'
import {
  ARTIFACT_COMMENT_VERSION,
  MAX_ARTIFACTS_PER_PROJECT,
  type ArtifactAnchor,
  type ArtifactEventV1,
  type ArtifactRebindResponse,
  type ArtifactRecordV1,
  type CommentEventV1,
} from './artifact-contract.js'
import { createEventRow } from '../platform/artifact-events.js'
import { resolveInsideRepo } from '../platform/artifact-files.js'
import type { ArtifactRuntime } from '../platform/artifact-runtime.js'
import { ArtifactDomainError } from '../domains/artifact/errors.js'
import { normalizeArtifactPath } from '../domains/artifact/paths.js'
import { relocateLineAnchor } from '../domains/artifact/anchor.js'
import { nowOf, openRecord, publishAll, requireBodyString } from './artifact-records.js'

/** What one rebind observes and commits. */
interface RebindInput {
  readonly runtime: ArtifactRuntime
  readonly record: ArtifactRecordV1
  readonly oldPath: string
  readonly newPath: string
  readonly now: Date
}

/** The committed record plus the events the change produced. */
interface RebindOutcome {
  readonly changed: boolean
  readonly record: ArtifactRecordV1
  readonly events: ArtifactEventV1[]
}

/** The latest anchor state of every comment that carries one. */
async function anchorState(runtime: ArtifactRuntime, artifactId: string): Promise<
  Map<string, { anchor: ArtifactAnchor; threadId: string; stale: boolean }>
> {
  const comments = await runtime.store.readComments(artifactId)
  const anchors = new Map<string, { anchor: ArtifactAnchor; threadId: string; stale: boolean }>()
  for (const event of comments) {
    if (event.type === 'create' && event.anchor !== undefined) {
      anchors.set(event.commentId, { anchor: event.anchor, threadId: event.threadId, stale: false })
    } else if (event.type === 'anchor-moved') {
      const existing = anchors.get(event.commentId)
      if (existing !== undefined) {
        anchors.set(event.commentId, {
          anchor: event.anchor,
          threadId: existing.threadId,
          stale: event.anchorStatus === 'stale',
        })
      }
    }
  }
  return anchors
}

/** The new file's text, or null when it cannot be read (binary or host limit). */
async function textOf(runtime: ArtifactRuntime, path: string): Promise<string | null> {
  try {
    return (await runtime.files.readText(path)).content
  } catch {
    return null
  }
}

/**
 * Remap every anchor that pointed at the old path, inside the caller's lock.
 *
 * The path itself always moves; a line-range anchor additionally re-locates its
 * quote in the new text. When the quote is absent or the text unreadable the
 * anchor is marked stale, which keeps the thread visible instead of pretending
 * it still points at the right lines.
 */
async function remapAnchorsUnlocked(
  runtime: ArtifactRuntime,
  record: ArtifactRecordV1,
  oldPath: string,
  newPath: string,
  now: Date,
): Promise<ArtifactEventV1[]> {
  const anchors = await anchorState(runtime, record.artifactId)
  const candidates = [...anchors].filter(([, entry]) => entry.anchor.path === oldPath)
  if (candidates.length === 0) return []
  const text = candidates.some(([, entry]) => entry.anchor.kind === 'line-range')
    ? await textOf(runtime, newPath)
    : null
  const events: ArtifactEventV1[] = []
  for (const [commentId, entry] of candidates) {
    const rebased: ArtifactAnchor = { ...entry.anchor, path: newPath }
    let anchor: ArtifactAnchor = rebased
    let anchorStatus: 'moved' | 'stale' = entry.stale ? 'stale' : 'moved'
    if (rebased.kind === 'line-range') {
      const relocated = text === null ? null : relocateLineAnchor(text, rebased)
      if (relocated === null || relocated.status === 'stale') anchorStatus = 'stale'
      else anchor = relocated.anchor
    }
    const row: CommentEventV1 = {
      version: ARTIFACT_COMMENT_VERSION,
      eventId: `comment-event-${randomUUID()}`,
      artifactId: record.artifactId,
      commentId,
      threadId: entry.threadId,
      type: 'anchor-moved',
      anchor,
      anchorStatus,
      createdAt: now.toISOString(),
    }
    await runtime.store.appendCommentUnlocked(row)
    events.push(await runtime.store.appendEventUnlocked(
      createEventRow(record.artifactId, 'comment.updated', now, { commentId, anchorStatus }),
    ))
  }
  return events
}

/**
 * Refuse a path another work item registers.
 *
 * Checked inside the rebind lock so two concurrent rebinds cannot claim the
 * same path. A path already registered on this work item is refused too; two
 * entries with one path would make `registeredFile` ambiguous.
 */
async function assertPathUnclaimed(
  runtime: ArtifactRuntime,
  record: ArtifactRecordV1,
  path: string,
): Promise<void> {
  if (record.files.some((file) => file.path === path)) {
    throw new ArtifactDomainError(
      'artifact/duplicate',
      `path is already registered on this work item: ${path}`,
      path,
    )
  }
  const scan = await runtime.store.listRecords(MAX_ARTIFACTS_PER_PROJECT + 1)
  const owner = scan.records.find((candidate) =>
    candidate.artifactId !== record.artifactId && candidate.files.some((file) => file.path === path))
  if (owner !== undefined) {
    throw new ArtifactDomainError(
      'artifact/duplicate',
      `path is already registered by work item ${owner.artifactId}: ${path}`,
      path,
    )
  }
}

/**
 * Move one registered file entry to a new path.
 *
 * The new path must be project-relative, resolve to a regular file inside the
 * repository, and be claimed by no other work item and no other entry of this
 * one. An idempotent retry (`oldPath === newPath`) reports `changed: false`
 * without writing.
 */
async function rebindRecord(input: RebindInput): Promise<RebindOutcome> {
  const { runtime, record, oldPath, newPath, now } = input
  if (!record.files.some((file) => file.path === oldPath)) {
    throw new ArtifactDomainError(
      'artifact/file-missing',
      `old path is not registered on this work item: ${oldPath}`,
      oldPath,
    )
  }
  if (oldPath === newPath) return { changed: false, record, events: [] }
  const checked = normalizeArtifactPath(newPath)
  if (!checked.ok) throw new ArtifactDomainError('artifact/path-not-allowed', checked.reason, newPath)
  const target = checked.path
  const absolute = await resolveInsideRepo(runtime.repoPath, target)
  if (absolute === null) {
    throw new ArtifactDomainError('artifact/file-missing', `file does not exist: ${target}`, target)
  }
  const result = await runtime.store.withLock(async () => {
    const current = await runtime.store.readRecord(record.artifactId)
    if (current === null) {
      throw new ArtifactDomainError(
        'artifact/not-found',
        `work item is missing: ${record.artifactId}`,
        record.artifactId,
      )
    }
    const source = current.files.find((file) => file.path === oldPath)
    if (source === undefined) {
      throw new ArtifactDomainError(
        'artifact/file-missing',
        `old path is not registered on this work item: ${oldPath}`,
        oldPath,
      )
    }
    await assertPathUnclaimed(runtime, current, target)
    const revision = source.revision + 1
    const saved = await runtime.store.mutateRecordUnlocked(current.artifactId, (existing) => ({
      ...existing,
      files: existing.files.map((file) =>
        file.path === oldPath ? { ...file, path: target, missing: false, revision } : file),
      primaryPath: existing.primaryPath === oldPath ? target : existing.primaryPath,
      revision: existing.revision + 1,
      updatedAt: now.toISOString(),
    }))
    const events: ArtifactEventV1[] = [await runtime.store.appendEventUnlocked(
      createEventRow(saved.artifactId, 'file.changed', now, { path: target, from: oldPath, revision }),
    )]
    events.push(...await remapAnchorsUnlocked(runtime, saved, oldPath, target, now))
    events.push(await runtime.store.appendEventUnlocked(
      createEventRow(saved.artifactId, 'artifact.updated', now, { revision: saved.revision }),
    ))
    return { record: saved, events }
  })
  return { changed: true, record: result.record, events: result.events }
}

/** `POST /api/cowork.artifact.rebind` — point a moved file at its new path. */
export async function handleRebind(
  request: Request,
  ports: ArtifactApiPorts,
  kit: ArtifactRouteKit,
): Promise<Response> {
  const body = await kit.readJsonBody(request)
  const sessionId = requireBodyString(body, 'sessionId', kit)
  const artifactId = requireBodyString(body, 'artifactId', kit)
  const oldPath = requireBodyString(body, 'oldPath', kit)
  const newPath = requireBodyString(body, 'newPath', kit)
  const { record, runtime } = await openRecord(ports, kit, sessionId, artifactId)
  const outcome = await rebindRecord({ runtime, record, oldPath, newPath, now: nowOf(ports) })
  publishAll(runtime, outcome.events)
  const response: ArtifactRebindResponse = { ok: true, changed: outcome.changed, record: outcome.record }
  return kit.jsonResponse(200, response)
}
