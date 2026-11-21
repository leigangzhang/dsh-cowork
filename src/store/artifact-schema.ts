/**
 * Validation and normalization for every artifact file this plugin writes.
 *
 * The store reads JSON written by earlier runs, by a model tool, and by the
 * browser's wire payloads; none of it is trusted. Parsers here are deliberately
 * tolerant on read (unknown fields are dropped, a missing counter defaults to
 * zero) and strict on identity (a record without an id, a file list, or a known
 * type/status is skipped instead of guessed). A malformed row never invalidates
 * the other rows of the same file.
 */
import {
  ARTIFACT_COMMENT_VERSION,
  ARTIFACT_DISPATCH_VERSION,
  ARTIFACT_EVENT_VERSION,
  ARTIFACT_RECORD_VERSION,
  MAX_ARTIFACT_ATTACHMENTS_PER_COMMENT,
  MAX_ARTIFACT_COMMENT_CHARS,
  MAX_ARTIFACT_FILES,
  MAX_ARTIFACT_QUOTE_CHARS,
  MAX_ARTIFACT_TITLE_CHARS,
  isArtifactEventType,
  isArtifactStatus,
  isArtifactType,
  isDispatchState,
  type ArtifactAnchor,
  type ArtifactEventV1,
  type ArtifactFileV1,
  type ArtifactRecordV1,
  type AttachmentRefV1,
  type CommentEventV1,
  type DispatchRecordV1,
} from '../panel/artifact-contract.js'
import { parseArtifactAnchor } from '../domains/artifact/anchor.js'
import { normalizeArtifactPath } from '../domains/artifact/paths.js'

/** A plain object (not an array, not null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A non-empty trimmed string, or null. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** A non-negative safe integer, or the fallback. */
function count(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

/** A non-empty timestamp string, or the fallback. */
function timestamp(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback
}

/** One attachment reference, or null when it is not one. */
export function parseAttachmentRef(value: unknown): AttachmentRefV1 | null {
  if (!isRecord(value)) return null
  const attachmentId = nonEmptyString(value.attachmentId)
  const name = nonEmptyString(value.name)
  const mediaType = nonEmptyString(value.mediaType)
  if (attachmentId === null || name === null || mediaType === null) return null
  return {
    attachmentId,
    name,
    mediaType,
    size: count(value.size),
    sha256: nonEmptyString(value.sha256) ?? '',
  }
}

/** Attachment arrays are capped; an absent field means "none". */
function parseAttachments(value: unknown): AttachmentRefV1[] | null {
  if (value === undefined) return null
  if (!Array.isArray(value)) return []
  const parsed: AttachmentRefV1[] = []
  for (const entry of value.slice(0, MAX_ARTIFACT_ATTACHMENTS_PER_COMMENT)) {
    const attachment = parseAttachmentRef(entry)
    if (attachment !== null) parsed.push(attachment)
  }
  return parsed
}

/** One registered file, or null when the entry is not one. */
export function parseArtifactFile(value: unknown): ArtifactFileV1 | null {
  if (!isRecord(value)) return null
  const pathCheck = normalizeArtifactPath(value.path)
  if (!pathCheck.ok) return null
  return {
    path: pathCheck.path,
    mediaType: nonEmptyString(value.mediaType) ?? 'application/octet-stream',
    editable: value.editable === true,
    size: count(value.size),
    sha256: nonEmptyString(value.sha256) ?? '',
    revision: count(value.revision),
    fsVersion: nonEmptyString(value.fsVersion),
    missing: value.missing === true,
  }
}

/** The dispatch summary the record carries, or null. */
function parseActiveDispatch(value: unknown): ArtifactRecordV1['activeDispatch'] {
  if (!isRecord(value)) return null
  const dispatchId = nonEmptyString(value.dispatchId)
  if (dispatchId === null || !isDispatchState(value.state)) return null
  return {
    dispatchId,
    state: value.state,
    updatedAt: timestamp(value.updatedAt, '1970-01-01T00:00:00.000Z'),
  }
}

/** One work-item record, or null when its identity or file list is unusable. */
export function parseArtifactRecord(value: unknown): ArtifactRecordV1 | null {
  if (!isRecord(value)) return null
  const artifactId = nonEmptyString(value.artifactId)
  const projectId = nonEmptyString(value.projectId)
  const ownerSessionId = nonEmptyString(value.ownerSessionId)
  if (artifactId === null || projectId === null || ownerSessionId === null) return null
  if (!isArtifactType(value.type) || !isArtifactStatus(value.status)) return null
  const files: ArtifactFileV1[] = []
  if (Array.isArray(value.files)) {
    for (const entry of value.files.slice(0, MAX_ARTIFACT_FILES)) {
      const file = parseArtifactFile(entry)
      if (file !== null) files.push(file)
    }
  }
  if (files.length === 0) return null
  const primaryCheck = normalizeArtifactPath(value.primaryPath)
  const primaryPath = primaryCheck.ok ? primaryCheck.path : files[0].path
  const createdAt = timestamp(value.createdAt, '1970-01-01T00:00:00.000Z')
  return {
    version: ARTIFACT_RECORD_VERSION,
    artifactId,
    projectId,
    ownerSessionId,
    title: (nonEmptyString(value.title) ?? primaryPath).slice(0, MAX_ARTIFACT_TITLE_CHARS),
    type: value.type,
    status: value.status,
    files,
    primaryPath,
    revision: count(value.revision),
    commentCount: count(value.commentCount),
    attachmentCount: count(value.attachmentCount),
    activeDispatch: parseActiveDispatch(value.activeDispatch),
    createdAt,
    updatedAt: timestamp(value.updatedAt, createdAt),
  }
}

/** The comment author, or null for an unknown value. */
function parseAuthor(value: unknown): 'user' | 'model' | null {
  return value === 'user' || value === 'model' ? value : null
}

/** The optional create-event anchor; a present-but-invalid anchor fails the event. */
function parseCreateAnchor(value: unknown): { ok: true; anchor: ArtifactAnchor | null } | { ok: false } {
  if (value === undefined) return { ok: true, anchor: null }
  const parsed = parseArtifactAnchor(value)
  return parsed.ok ? { ok: true, anchor: parsed.anchor } : { ok: false }
}

/** One comment event, or null when its identity or payload is unusable. */
export function parseCommentEvent(value: unknown): CommentEventV1 | null {
  if (!isRecord(value)) return null
  const eventId = nonEmptyString(value.eventId)
  const artifactId = nonEmptyString(value.artifactId)
  const commentId = nonEmptyString(value.commentId)
  const threadId = nonEmptyString(value.threadId)
  if (eventId === null || artifactId === null || commentId === null || threadId === null) return null
  const createdAt = timestamp(value.createdAt, '1970-01-01T00:00:00.000Z')
  const base = { version: ARTIFACT_COMMENT_VERSION, eventId, artifactId, commentId, threadId, createdAt } as const
  const type = value.type
  switch (type) {
    case 'create': {
      const author = parseAuthor(value.author)
      const body = nonEmptyString(value.body)
      if (author === null || body === null) return null
      const anchor = parseCreateAnchor(value.anchor)
      if (!anchor.ok) return null
      const attachments = parseAttachments(value.attachments)
      const sessionId = nonEmptyString(value.sessionId)
      const anchorValue = anchor.anchor === null ? {} : { anchor: anchor.anchor }
      const sessionValue = sessionId === null ? {} : { sessionId }
      const quoteValue = typeof value.quote === 'string'
        ? { quote: value.quote.slice(0, MAX_ARTIFACT_QUOTE_CHARS) }
        : {}
      const revisionValue = typeof value.fileRevision === 'number' && Number.isSafeInteger(value.fileRevision)
        ? { fileRevision: value.fileRevision }
        : {}
      const attachmentValue = attachments === null || attachments.length === 0 ? {} : { attachments }
      return {
        ...base,
        type: 'create',
        author,
        body: body.slice(0, MAX_ARTIFACT_COMMENT_CHARS),
        ...sessionValue,
        ...anchorValue,
        ...quoteValue,
        ...revisionValue,
        ...attachmentValue,
      }
    }
    case 'reply': {
      const author = parseAuthor(value.author)
      const body = nonEmptyString(value.body)
      if (author === null || body === null) return null
      const attachments = parseAttachments(value.attachments)
      const sessionId = nonEmptyString(value.sessionId)
      const sessionValue = sessionId === null ? {} : { sessionId }
      const attachmentValue = attachments === null || attachments.length === 0 ? {} : { attachments }
      return {
        ...base,
        type: 'reply',
        author,
        body: body.slice(0, MAX_ARTIFACT_COMMENT_CHARS),
        ...sessionValue,
        ...attachmentValue,
      }
    }
    case 'resolve':
    case 'reopen': {
      const author = parseAuthor(value.author)
      if (author === null) return null
      return { ...base, type, author }
    }
    case 'anchor-moved': {
      const parsed = parseArtifactAnchor(value.anchor)
      if (!parsed.ok) return null
      if (value.anchorStatus !== 'moved' && value.anchorStatus !== 'stale') return null
      return { ...base, type: 'anchor-moved', anchor: parsed.anchor, anchorStatus: value.anchorStatus }
    }
    default:
      return null
  }
}

/** One dispatch record, or null when its identity or state is unusable. */
export function parseDispatchRecord(value: unknown): DispatchRecordV1 | null {
  if (!isRecord(value)) return null
  const dispatchId = nonEmptyString(value.dispatchId)
  const artifactId = nonEmptyString(value.artifactId)
  const sessionId = nonEmptyString(value.sessionId)
  const promptRequestId = nonEmptyString(value.promptRequestId)
  if (dispatchId === null || artifactId === null || sessionId === null || promptRequestId === null) return null
  if (!isDispatchState(value.state)) return null
  if (!Array.isArray(value.commentIds)) return null
  const commentIds = value.commentIds.filter((id): id is string => typeof id === 'string' && id !== '')
  const createdAt = timestamp(value.createdAt, '1970-01-01T00:00:00.000Z')
  return {
    version: ARTIFACT_DISPATCH_VERSION,
    dispatchId,
    artifactId,
    sessionId,
    commentIds,
    state: value.state,
    attempts: count(value.attempts),
    promptRequestId,
    errorCode: nonEmptyString(value.errorCode),
    createdAt,
    updatedAt: timestamp(value.updatedAt, createdAt),
  }
}

/** One project event row, or null when it cannot be replayed. */
export function parseArtifactEvent(value: unknown): ArtifactEventV1 | null {
  if (!isRecord(value)) return null
  if (typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq) || value.seq < 1) return null
  const eventId = nonEmptyString(value.eventId)
  const artifactId = nonEmptyString(value.artifactId)
  if (eventId === null || artifactId === null) return null
  if (!isArtifactEventType(value.type)) return null
  return {
    version: ARTIFACT_EVENT_VERSION,
    seq: value.seq,
    eventId,
    type: value.type,
    artifactId,
    time: timestamp(value.time, '1970-01-01T00:00:00.000Z'),
    data: isRecord(value.data) ? value.data : {},
  }
}
