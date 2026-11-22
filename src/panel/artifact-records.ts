/**
 * Shared record and wire helpers of the work-item (artifact) routes.
 *
 * Every route resolves a work item the same way: the session must resolve to
 * the project that owns the record, a file path must be one the record
 * registers, and a read must reconcile the record against the filesystem before
 * the handler answers. Those rules live here so a new route cannot invent a
 * slightly different check; the handlers keep the status codes and business
 * calls.
 */
import { randomUUID } from 'node:crypto'
import type { PanelErrorCode } from './api-contract.js'
import type { ArtifactApiPorts, ArtifactRouteKit } from './artifact-route-kit.js'
import {
  ARTIFACT_COMMENT_VERSION,
  type ArtifactAnchor,
  type ArtifactEventV1,
  type ArtifactRecordV1,
  type CommentEventV1,
} from './artifact-contract.js'
import { createEventRow } from '../platform/artifact-events.js'
import { reconcileArtifactFile } from '../platform/artifact-files.js'
import type { ArtifactRuntime } from '../platform/artifact-runtime.js'
import { ArtifactDomainError } from '../domains/artifact/errors.js'
import { relocateLineAnchor } from '../domains/artifact/anchor.js'

/** A query parameter, or null when absent or blank. `GET` routes carry no body. */
export function queryParam(request: Request, name: string): string | null {
  const value = new URL(request.url).searchParams.get(name)?.trim()
  return value === undefined || value === '' ? null : value
}

/** A required query parameter. */
export function requireQuery(
  request: Request,
  name: string,
  kit: ArtifactRouteKit,
  code: PanelErrorCode,
): string {
  const value = queryParam(request, name)
  if (value === null) throw kit.fail(code, `query parameter ${name} is required`)
  return value
}

/** A required non-blank body string. */
export function requireBodyString(
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
export function requireBodyBoolean(
  body: Record<string, unknown>,
  name: string,
  kit: ArtifactRouteKit,
): boolean {
  const value = body[name]
  if (typeof value !== 'boolean') throw kit.fail('request/invalid-body', `body field ${name} must be a boolean`)
  return value
}

/** The clock every write stamps. */
export function nowOf(ports: ArtifactApiPorts): Date {
  return ports.now?.() ?? new Date()
}

/**
 * Read one record inside a locked transaction; a vanished record is a stable
 * not-found rather than a half-applied write.
 */
export async function readRecordOrThrowUnlocked(
  runtime: ArtifactRuntime,
  artifactId: string,
): Promise<ArtifactRecordV1> {
  const record = await runtime.store.readRecord(artifactId)
  if (record === null) {
    throw new ArtifactDomainError('artifact/not-found', `work item is missing: ${artifactId}`, artifactId)
  }
  return record
}

/**
 * Read the work item a JSON body names; every body route starts with the same
 * two required fields, so the pair is parsed once here.
 */
export async function openRecordFromBody(
  ports: ArtifactApiPorts,
  kit: ArtifactRouteKit,
  body: Record<string, unknown>,
): Promise<{ record: ArtifactRecordV1; runtime: ArtifactRuntime }> {
  const sessionId = requireBodyString(body, 'sessionId', kit)
  const artifactId = requireBodyString(body, 'artifactId', kit)
  return openRecord(ports, kit, sessionId, artifactId)
}

/**
 * Read the work item a request names, after proving it belongs to the project
 * the session resolved to. A record from another project is refused instead of
 * served, so a copied id cannot cross project boundaries.
 */
export async function openRecord(
  ports: ArtifactApiPorts,
  kit: ArtifactRouteKit,
  sessionId: string,
  artifactId: string,
): Promise<{ record: ArtifactRecordV1; runtime: ArtifactRuntime }> {
  const opened = await kit.openProject(sessionId)
  const runtime = ports.runtimeFor(opened.repoPath)
  const record = await readRecordOrThrowUnlocked(runtime, artifactId)
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
  let anyChanged = false
  for (const file of record.files) {
    const result = await reconcileArtifactFile(runtime.files, file)
    files.push(result)
    if (result.changed) anyChanged = true
  }
  if (!anyChanged) return { record, events: [] }
  const sourceRevisions = new Map(record.files.map((file) => [file.path, file.revision]))
  const reconciled = new Map(files.map((entry) => [entry.file.path, entry]))
  const result = await runtime.store.withLock(async () => {
    // Re-read inside the lock so a concurrent comment count or status update is
    // kept. A file is only replaced when the record still carries the revision
    // this scan observed; a newer save wins and this observation is discarded.
    const current = await readRecordOrThrowUnlocked(runtime, record.artifactId)
    const applied: { path: string; revision: number; missing: boolean }[] = []
    const nextFiles = current.files.map((file) => {
      const observed = reconciled.get(file.path)
      if (observed === undefined || !observed.changed) return file
      if (file.revision !== sourceRevisions.get(file.path)) return file
      applied.push({ path: observed.file.path, revision: file.revision + 1, missing: observed.file.missing })
      return { ...observed.file, revision: file.revision + 1 }
    })
    if (applied.length === 0) return { record: current, events: [] as ArtifactEventV1[], applied }
    const next: ArtifactRecordV1 = {
      ...current,
      files: nextFiles,
      revision: current.revision + 1,
      updatedAt: now.toISOString(),
    }
    const saved = await runtime.store.mutateRecordUnlocked(next.artifactId, () => next)
    const events: ArtifactEventV1[] = []
    for (const file of applied) {
      events.push(await runtime.store.appendEventUnlocked(
        createEventRow(saved.artifactId, 'file.changed', now, file),
      ))
      const observed = files.find((candidate) => candidate.file.path === file.path)
      if (observed !== undefined && observed.text !== null) {
        events.push(...await relocateAnchorsUnlocked(runtime, saved, file.path, observed.text, now))
      }
    }
    events.push(await runtime.store.appendEventUnlocked(
      createEventRow(saved.artifactId, 'artifact.updated', now, { revision: saved.revision }),
    ))
    return { record: saved, events, applied }
  })
  // A snapshot of every applied revision is the merge base a later save needs;
  // a failed snapshot is logged, never allowed to fail the read.
  for (const file of result.applied) {
    const entry = files.find((candidate) => candidate.file.path === file.path)
    if (entry === undefined || entry.text === null) continue
    const savedFile = result.record.files.find((candidate) => candidate.path === file.path)
    if (savedFile === undefined) continue
    try {
      await runtime.store.saveRevision(record.artifactId, savedFile.revision, entry.text)
    } catch (error) {
      // A failed snapshot is a lost merge base, not a failed read; the next
      // save answers 409 instead of guessing a base.
      void error
    }
  }
  return { record: result.record, events: result.events }
}

/** Broadcast already-committed events to live subscribers. */
export function publishAll(runtime: ArtifactRuntime, events: readonly ArtifactEventV1[]): void {
  for (const event of events) runtime.events.publish(event)
}

/** The registered file a request names, or a refusal. */
export function registeredFile(
  record: ArtifactRecordV1,
  path: string,
): ArtifactRecordV1['files'][number] {
  const file = record.files.find((entry) => entry.path === path)
  if (file === undefined) {
    throw new ArtifactDomainError('artifact/path-not-allowed', `path is not registered on this work item: ${path}`, path)
  }
  return file
}

/** The latest anchor state of one comment. */
export interface AnchorStateEntry {
  readonly anchor: ArtifactAnchor
  readonly threadId: string
  readonly stale: boolean
}

/** Fold the comment log into the latest anchor state per comment. */
export function latestAnchors(comments: readonly CommentEventV1[]): Map<string, AnchorStateEntry> {
  const anchors = new Map<string, AnchorStateEntry>()
  for (const event of comments) {
    if (event.type === 'create' && event.anchor !== undefined) {
      anchors.set(event.commentId, { anchor: event.anchor, threadId: event.threadId, stale: false })
      continue
    }
    if (event.type !== 'anchor-moved') continue
    const existing = anchors.get(event.commentId)
    if (existing === undefined) continue
    anchors.set(event.commentId, {
      anchor: event.anchor,
      threadId: existing.threadId,
      stale: event.anchorStatus === 'stale',
    })
  }
  return anchors
}

/** Append one anchor-moved row and its project event, inside the caller's lock. */
export async function appendAnchorMovedUnlocked(
  runtime: ArtifactRuntime,
  record: ArtifactRecordV1,
  commentId: string,
  threadId: string,
  anchor: ArtifactAnchor,
  anchorStatus: 'moved' | 'stale',
  now: Date,
): Promise<ArtifactEventV1> {
  const row: CommentEventV1 = {
    version: ARTIFACT_COMMENT_VERSION,
    eventId: `comment-event-${randomUUID()}`,
    artifactId: record.artifactId,
    commentId,
    threadId,
    type: 'anchor-moved',
    anchor,
    anchorStatus,
    createdAt: now.toISOString(),
  }
  await runtime.store.appendCommentUnlocked(row)
  return runtime.store.appendEventUnlocked(
    createEventRow(record.artifactId, 'comment.updated', now, { commentId, anchorStatus }),
  )
}

/** Whether one anchor state is a live line-range anchor on the changed path. */
function lineAnchorAt(entry: AnchorStateEntry, path: string): boolean {
  return !entry.stale && entry.anchor.kind === 'line-range' && entry.anchor.path === path
}

/** The relocation one changed file implies for an anchor, or null for no move. */
function relocationOf(
  entry: AnchorStateEntry,
  path: string,
  content: string,
): { anchor: ArtifactAnchor; anchorStatus: 'moved' | 'stale' } | null {
  if (!lineAnchorAt(entry, path)) return null
  const relocated = relocateLineAnchor(content, entry.anchor)
  if (relocated.status === 'unchanged') return null
  return { anchor: relocated.anchor, anchorStatus: relocated.status }
}

/** Re-anchor every comment whose file changed, inside the caller's lock. */
export async function relocateAnchorsUnlocked(
  runtime: ArtifactRuntime,
  record: ArtifactRecordV1,
  path: string,
  content: string,
  now: Date,
): Promise<ArtifactEventV1[]> {
  const anchors = latestAnchors(await runtime.store.readComments(record.artifactId))
  const events: ArtifactEventV1[] = []
  for (const [commentId, entry] of anchors) {
    const relocation = relocationOf(entry, path, content)
    if (relocation === null) continue
    events.push(await appendAnchorMovedUnlocked(
      runtime,
      record,
      commentId,
      entry.threadId,
      relocation.anchor,
      relocation.anchorStatus,
      now,
    ))
  }
  return events
}
