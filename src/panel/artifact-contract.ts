/**
 * Wire contract of the work-item (artifact) surface.
 *
 * One browser-safe leaf shared by the host routes
 * (`src/panel/artifact-api.ts`), the record/file/event stores, the
 * `cowork_artifact_*` tools, and the browser half under `src/client/work-item/`.
 * It carries route names, wire types, limits, state vocabulary, labels, and the
 * error table — no I/O, no clock, and no import outside this file — so both
 * halves are written against one frozen vocabulary and the client never
 * hand-writes a second copy.
 *
 * The record truth is {@link ArtifactRecordV1}: the browser's `ArtifactRecord`
 * is a projection of it. The two state axes stay separate: `status` is the
 * collaboration state of the work item, `DispatchState` is the delivery state
 * of one annotation batch.
 */

/** Exact Fetch-route path: work items of one project (right-rail list). */
export const ARTIFACT_LIST_PATH = '/api/cowork.artifact.list'

/** Exact Fetch-route path: one work item's metadata, files, and dispatch. */
export const ARTIFACT_DETAIL_PATH = '/api/cowork.artifact.detail'

/** Exact Fetch-route path: one registered file's text content. */
export const ARTIFACT_FILE_PATH = '/api/cowork.artifact.file'

/** Exact Fetch-route path: comment threads of one work item. */
export const ARTIFACT_COMMENTS_PATH = '/api/cowork.artifact.comments'

/** Exact Fetch-route path: append one comment or one reply. */
export const ARTIFACT_COMMENT_PATH = '/api/cowork.artifact.comment'

/** Exact Fetch-route path: resolve or reopen one comment thread. */
export const ARTIFACT_COMMENT_RESOLVE_PATH = '/api/cowork.artifact.comment.resolve'

/** Exact Fetch-route path: move the work-item collaboration status. */
export const ARTIFACT_STATUS_PATH = '/api/cowork.artifact.status'

/** Exact Fetch-route path: save text with optimistic concurrency (stage 2). */
export const ARTIFACT_EDIT_PATH = '/api/cowork.artifact.edit'

/** Exact Fetch-route path: report the lines the user is editing (stage 2). */
export const ARTIFACT_PRESENCE_PATH = '/api/cowork.artifact.presence'

/** Exact Fetch-route path: upload one comment/reply attachment (stage 3). */
export const ARTIFACT_UPLOAD_PATH = '/api/cowork.artifact.upload'

/** Exact Fetch-route path: the project's work-item event stream (SSE). */
export const ARTIFACT_EVENTS_PATH = '/api/cowork.artifact.events'

/** Exact Fetch-route path: open one registered file in its native app (stage 4). */
export const ARTIFACT_OPEN_PATH = '/api/cowork.artifact.open'

/** Exact Fetch-route path: rebind a file that moved (stage 5). */
export const ARTIFACT_REBIND_PATH = '/api/cowork.artifact.rebind'

/** Version stamped on every artifact record file. */
export const ARTIFACT_RECORD_VERSION = 1

/** Version stamped on every comment event. */
export const ARTIFACT_COMMENT_VERSION = 1

/** Version stamped on every dispatch record and every event row. */
export const ARTIFACT_DISPATCH_VERSION = 1
export const ARTIFACT_EVENT_VERSION = 1

/** Every artifact type, in the design's order. */
export const ARTIFACT_TYPES = [
  'text',
  'doc',
  'table',
  'diagram',
  'canvas',
  'pdf',
  'image',
  'html',
  'other',
] as const

/** One artifact type; it selects the renderer, never the record shape. */
export type ArtifactType = (typeof ARTIFACT_TYPES)[number]

/** Collaboration states of a work item, in rail-group order. */
export const ARTIFACT_STATUSES = [
  'pending-view',
  'pending-confirm',
  'needs-feedback',
  'in-progress',
  'confirmed',
] as const

/** One work-item collaboration state. */
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number]

/** Delivery states of one annotation batch, in the design's transition order. */
export const DISPATCH_STATES = [
  'queued',
  'sent',
  'thinking',
  'working',
  'replied',
  'failed',
  'blocked',
  'stale',
] as const

/** One delivery state of an annotation batch. */
export type DispatchState = (typeof DISPATCH_STATES)[number]

/** Delivery states that no longer change by themselves. */
export const TERMINAL_DISPATCH_STATES: readonly DispatchState[] = [
  'replied',
  'failed',
  'blocked',
  'stale',
]

/** Project event types carried on the artifact stream. */
export const ARTIFACT_EVENT_TYPES = [
  'artifact.updated',
  'file.changed',
  'comment.created',
  'comment.updated',
  'reply.created',
  'dispatch.updated',
  'reset',
] as const

/** One project event type. */
export type ArtifactEventType = (typeof ARTIFACT_EVENT_TYPES)[number]

/** Anchor kinds a comment may carry; the first two ship in stage 1. */
export const ANCHOR_KINDS = [
  'line-range',
  'block',
  'diagram-node',
  'table-cell',
  'canvas-element',
  'page',
  'region',
  'whole',
] as const

/** One comment anchor kind. */
export type AnchorKind = (typeof ANCHOR_KINDS)[number]

/** Normalized rectangle used by canvas/region anchors. */
export interface ArtifactRegion {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Where one comment points.
 *
 * A `line-range` anchor stores the quoted lines plus one line of context on
 * each side so the server can relocate it after an edit; the other kinds are
 * the per-renderer identities the design fixes. Every anchor names one
 * registered file path.
 */
export type ArtifactAnchor =
  | {
      readonly kind: 'line-range'
      readonly path: string
      readonly startLine: number
      readonly endLine: number
      readonly quote: string
      readonly contextBefore?: string
      readonly contextAfter?: string
    }
  | { readonly kind: 'block'; readonly path: string; readonly blockId?: string; readonly quote: string }
  | { readonly kind: 'diagram-node'; readonly path: string; readonly nodeId?: string; readonly line?: number }
  | { readonly kind: 'table-cell'; readonly path: string; readonly row: number; readonly column: number }
  | {
      readonly kind: 'canvas-element'
      readonly path: string
      readonly elementId?: string
      readonly region?: ArtifactRegion
    }
  | { readonly kind: 'page'; readonly path: string; readonly page: number }
  | { readonly kind: 'region'; readonly path: string; readonly page?: number; readonly region: ArtifactRegion }
  | { readonly kind: 'whole'; readonly path: string }

/** One attachment stored under the work item's `uploads/` directory. */
export interface AttachmentRefV1 {
  readonly attachmentId: string
  readonly name: string
  readonly mediaType: string
  readonly size: number
  readonly sha256: string
}

/** One file registered by a work item; the path is project-relative POSIX. */
export interface ArtifactFileV1 {
  readonly path: string
  readonly mediaType: string
  readonly editable: boolean
  readonly size: number
  readonly sha256: string
  readonly revision: number
  /** Opaque `ctx.fs` version token, or null when the host exposes no fs service. */
  readonly fsVersion: string | null
  /** True when the registered path no longer exists on disk. */
  readonly missing: boolean
}

/** The dispatch batch a work item last created, summarised on the record. */
export interface ActiveDispatchV1 {
  readonly dispatchId: string
  readonly state: DispatchState
  readonly updatedAt: string
}

/** One work item as stored in `<repo>/.dsh-cowork/artifacts/<id>/artifact.json`. */
export interface ArtifactRecordV1 {
  readonly version: typeof ARTIFACT_RECORD_VERSION
  readonly artifactId: string
  readonly projectId: string
  readonly ownerSessionId: string
  readonly title: string
  readonly type: ArtifactType
  readonly status: ArtifactStatus
  readonly files: readonly ArtifactFileV1[]
  readonly primaryPath: string
  readonly revision: number
  readonly commentCount: number
  readonly attachmentCount: number
  readonly activeDispatch: ActiveDispatchV1 | null
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * One comment event. `create` opens a thread and carries its anchor; `reply`
 * continues it; `resolve`/`reopen` toggle the thread; `anchor-moved` records
 * that a file change relocated (or failed to relocate) the anchor.
 */
export type CommentEventV1 =
  | {
      readonly version: typeof ARTIFACT_COMMENT_VERSION
      readonly eventId: string
      readonly artifactId: string
      readonly commentId: string
      readonly threadId: string
      readonly type: 'create'
      readonly author: 'user' | 'model'
      readonly sessionId?: string
      readonly body: string
      readonly anchor?: ArtifactAnchor
      readonly quote?: string
      readonly fileRevision?: number
      readonly attachments?: readonly AttachmentRefV1[]
      readonly createdAt: string
    }
  | {
      readonly version: typeof ARTIFACT_COMMENT_VERSION
      readonly eventId: string
      readonly artifactId: string
      readonly commentId: string
      readonly threadId: string
      readonly type: 'reply'
      readonly author: 'user' | 'model'
      readonly sessionId?: string
      readonly body: string
      readonly attachments?: readonly AttachmentRefV1[]
      readonly createdAt: string
    }
  | {
      readonly version: typeof ARTIFACT_COMMENT_VERSION
      readonly eventId: string
      readonly artifactId: string
      readonly commentId: string
      readonly threadId: string
      readonly type: 'resolve' | 'reopen'
      readonly author: 'user' | 'model'
      readonly createdAt: string
    }
  | {
      readonly version: typeof ARTIFACT_COMMENT_VERSION
      readonly eventId: string
      readonly artifactId: string
      readonly commentId: string
      readonly threadId: string
      readonly type: 'anchor-moved'
      readonly anchor: ArtifactAnchor
      readonly anchorStatus: 'moved' | 'stale'
      readonly createdAt: string
    }

/** One annotation batch delivered to its owning session. */
export interface DispatchRecordV1 {
  readonly version: typeof ARTIFACT_DISPATCH_VERSION
  readonly dispatchId: string
  readonly artifactId: string
  readonly sessionId: string
  readonly commentIds: readonly string[]
  readonly state: DispatchState
  readonly attempts: number
  readonly promptRequestId: string
  readonly errorCode: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** One project event row, replayed to a reconnecting stream by `seq`. */
export interface ArtifactEventV1 {
  readonly version: typeof ARTIFACT_EVENT_VERSION
  readonly seq: number
  readonly eventId: string
  readonly type: ArtifactEventType
  readonly artifactId: string
  readonly time: string
  /** Bounded payload; never a full file body or a full comment snapshot. */
  readonly data: Readonly<Record<string, unknown>>
}

/** Most work items one project may hold. */
export const MAX_ARTIFACTS_PER_PROJECT = 500

/** Work items one list response returns at most. */
export const ARTIFACT_LIST_MAX_LIMIT = 200

/** Files one work item may register. */
export const MAX_ARTIFACT_FILES = 20

/** Longest work-item title. */
export const MAX_ARTIFACT_TITLE_CHARS = 200

/** Longest registered path (project-relative POSIX). */
export const MAX_ARTIFACT_PATH_CHARS = 500

/** Longest comment or reply body. */
export const MAX_ARTIFACT_COMMENT_CHARS = 4000

/** Longest quoted source text one anchor keeps. */
export const MAX_ARTIFACT_QUOTE_CHARS = 2000

/** Most comments one work item may hold; new comments fail after this. */
export const MAX_ARTIFACT_COMMENTS = 5000

/** Comment events one comments response returns when the caller does not say. */
export const ARTIFACT_COMMENTS_DEFAULT_LIMIT = 50

/** Largest comment-event page the comments route accepts. */
export const ARTIFACT_COMMENTS_MAX_LIMIT = 200

/** Largest text file the viewer saves (bytes) and its line cap. */
export const MAX_ARTIFACT_TEXT_BYTES = 5 * 1024 * 1024
export const MAX_ARTIFACT_TEXT_LINES = 20_000

/** Attachments one comment or reply may carry and their per-file cap. */
export const MAX_ARTIFACT_ATTACHMENTS_PER_COMMENT = 5
export const MAX_ARTIFACT_ATTACHMENT_BYTES = 5 * 1024 * 1024

/** Revision snapshots kept per file. */
export const MAX_ARTIFACT_REVISIONS_PER_FILE = 20

/** Delivery batching: one window, at most this many comments per prompt. */
export const ARTIFACT_DISPATCH_WINDOW_MS = 1500
export const MAX_COMMENTS_PER_DISPATCH = 10

/** Queue bounds: per session and per project. */
export const MAX_DISPATCH_QUEUE_PER_SESSION = 50
export const MAX_DISPATCH_QUEUE_PER_PROJECT = 200

/** Retry delays before a prompt is accepted; after acceptance no retry runs. */
export const ARTIFACT_DISPATCH_RETRY_DELAYS_MS = [1000, 4000, 15000] as const

/** How long one accepted dispatch may stay unanswered before it fails. */
export const ARTIFACT_DISPATCH_TIMEOUT_MS = 600_000

/** Cross-topic dispatch concurrency (design default 4, range 1–8). */
export const ARTIFACT_DISPATCH_CONCURRENCY = 4

/** Editing-presence report interval and lifetime. */
export const ARTIFACT_PRESENCE_REPORT_INTERVAL_MS = 300
export const ARTIFACT_PRESENCE_TTL_MS = 5000

/** Autosave debounce the browser uses for text edits. */
export const ARTIFACT_SAVE_DEBOUNCE_MS = 800

/** SSE heartbeat interval and the event-log cap that triggers `reset`. */
export const ARTIFACT_EVENT_HEARTBEAT_MS = 15_000
export const ARTIFACT_EVENT_LOG_MAX_LINES = 2000

/** Most attachments one work item may hold. */
export const MAX_ARTIFACT_ATTACHMENTS = 200

/** Stable artifact failure codes. They join {@link PanelErrorCode} in `api-contract`. */
export const ARTIFACT_ERROR_CODES = [
  'artifact/not-found',
  'artifact/session-mismatch',
  'artifact/path-not-allowed',
  'artifact/invalid-type',
  'artifact/file-missing',
  'artifact/file-too-large',
  'artifact/not-editable',
  'artifact/not-previewable',
  'artifact/version-conflict',
  'artifact/anchor-invalid',
  'artifact/comment-limit',
  'artifact/upload-invalid',
  'artifact/upload-too-large',
  'artifact/dispatch-queue-full',
  'artifact/dispatch-unavailable',
  'artifact/dispatch-not-found',
  'artifact/fs-unavailable',
  'artifact/io-error',
  'artifact/limit-reached',
  'artifact/duplicate',
  'artifact/corrupt',
] as const

/** One artifact failure code. */
export type ArtifactErrorCode = (typeof ARTIFACT_ERROR_CODES)[number]

/**
 * HTTP status of every artifact failure code. The shared panel error table
 * spreads this, so a new code cannot ship without its status.
 */
export const ARTIFACT_ERROR_STATUS: Readonly<Record<ArtifactErrorCode, number>> = {
  'artifact/not-found': 404,
  'artifact/session-mismatch': 403,
  'artifact/path-not-allowed': 400,
  'artifact/invalid-type': 400,
  'artifact/file-missing': 404,
  'artifact/file-too-large': 413,
  'artifact/not-editable': 409,
  'artifact/not-previewable': 415,
  'artifact/version-conflict': 409,
  'artifact/anchor-invalid': 400,
  'artifact/comment-limit': 409,
  'artifact/upload-invalid': 400,
  'artifact/upload-too-large': 413,
  'artifact/dispatch-queue-full': 429,
  'artifact/dispatch-unavailable': 501,
  'artifact/dispatch-not-found': 404,
  'artifact/fs-unavailable': 501,
  'artifact/io-error': 500,
  'artifact/limit-reached': 409,
  'artifact/duplicate': 409,
  'artifact/corrupt': 500,
}

/** Human label of one collaboration state. */
export const ARTIFACT_STATUS_LABELS: Readonly<Record<ArtifactStatus, string>> = {
  'pending-view': '待查看',
  'pending-confirm': '待确认',
  'needs-feedback': '需反馈',
  'in-progress': '进行中',
  confirmed: '已确认',
}

/** Human label of one artifact type. */
export const ARTIFACT_TYPE_LABELS: Readonly<Record<ArtifactType, string>> = {
  text: 'Markdown',
  doc: 'Doc',
  table: '表格',
  diagram: '图表',
  canvas: '画布',
  pdf: 'PDF',
  image: '图片',
  html: 'HTML',
  other: '其他',
}

/** Human label of one delivery state. */
export const DISPATCH_STATE_LABELS: Readonly<Record<DispatchState, string>> = {
  queued: '排队',
  sent: '已送达',
  thinking: '思考中',
  working: '改文件中',
  replied: '已回复',
  failed: '失败',
  blocked: '会话不可用',
  stale: '待确认',
}

/** Whether a value is one of the nine artifact types. */
export function isArtifactType(value: unknown): value is ArtifactType {
  return typeof value === 'string' && (ARTIFACT_TYPES as readonly string[]).includes(value)
}

/** Whether a value is one of the five collaboration states. */
export function isArtifactStatus(value: unknown): value is ArtifactStatus {
  return typeof value === 'string' && (ARTIFACT_STATUSES as readonly string[]).includes(value)
}

/** Whether a value is one of the eight delivery states. */
export function isDispatchState(value: unknown): value is DispatchState {
  return typeof value === 'string' && (DISPATCH_STATES as readonly string[]).includes(value)
}

/** Whether a value is one of the seven project event types. */
export function isArtifactEventType(value: unknown): value is ArtifactEventType {
  return typeof value === 'string' && (ARTIFACT_EVENT_TYPES as readonly string[]).includes(value)
}

/** Whether a value is one of the eight anchor kinds. */
export function isAnchorKind(value: unknown): value is AnchorKind {
  return typeof value === 'string' && (ANCHOR_KINDS as readonly string[]).includes(value)
}

/** Whether a delivery state is terminal. */
export function isTerminalDispatchState(state: DispatchState): boolean {
  return TERMINAL_DISPATCH_STATES.includes(state)
}

/** One work item as the right-rail list carries it: the record without its files. */
export interface ArtifactSummaryV1 {
  readonly artifactId: string
  readonly ownerSessionId: string
  readonly title: string
  readonly type: ArtifactType
  readonly status: ArtifactStatus
  readonly primaryPath: string
  readonly revision: number
  readonly commentCount: number
  readonly attachmentCount: number
  readonly activeDispatch: ActiveDispatchV1 | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** Per-state counts the rail shows next to its filters. */
export interface ArtifactCounts {
  readonly total: number
  readonly pendingView: number
  readonly pendingConfirm: number
  readonly needsFeedback: number
  readonly inProgress: number
  readonly confirmed: number
}

/** Body of a successful `GET artifact.list`. */
export interface ArtifactListResponse {
  readonly ok: true
  readonly items: readonly ArtifactSummaryV1[]
  readonly counts: ArtifactCounts
  /** True when the project holds more records than one response carries. */
  readonly truncated: boolean
}

/** Body of a successful `GET artifact.detail`. */
export interface ArtifactDetailResponse {
  readonly ok: true
  readonly record: ArtifactRecordV1
  /** Last project-event sequence the viewer has seen. */
  readonly eventsSeq: number
}

/** Body of a successful text `GET artifact.file`. */
export interface ArtifactFileResponse {
  readonly ok: true
  readonly artifactId: string
  readonly path: string
  readonly mediaType: string
  readonly content: string
  readonly size: number
  readonly sha256: string
  readonly revision: number
  readonly fsVersion: string | null
}

/** Body of a successful `GET artifact.comments`. */
export interface ArtifactCommentsResponse {
  readonly ok: true
  readonly events: readonly CommentEventV1[]
  readonly truncated: boolean
}

/** Body of a successful `POST artifact.comment`. */
export interface ArtifactCommentResponse {
  readonly ok: true
  readonly comment: CommentEventV1
  readonly dispatch: DispatchRecordV1 | null
  readonly record: ArtifactRecordV1
}

/** Body of a successful `POST artifact.comment.resolve`. */
export interface ArtifactCommentResolveResponse {
  readonly ok: true
  readonly changed: boolean
  readonly comment: CommentEventV1 | null
  readonly record: ArtifactRecordV1
}

/** Body of a successful `POST artifact.status`. */
export interface ArtifactStatusResponse {
  readonly ok: true
  readonly changed: boolean
  readonly record: ArtifactRecordV1
}

/** One conflicting line region reported with a 409 save. */
export interface ArtifactConflictRange {
  /** 1-based first line in the merged (current) file. */
  readonly startLine: number
  /** 1-based last line, inclusive. */
  readonly endLine: number
}

/** Body of a successful `POST artifact.edit`. */
export interface ArtifactEditResponse {
  readonly ok: true
  readonly path: string
  readonly content: string
  readonly revision: number
  readonly fsVersion: string | null
  readonly record: ArtifactRecordV1
  /** True when the save came from a three-way merge rather than a direct write. */
  readonly merged: boolean
}

/** 409 body of `POST artifact.edit`: the conflict UI loads the latest and retries. */
export interface ArtifactConflictBody {
  readonly ok: false
  readonly error: { readonly code: 'artifact/version-conflict'; readonly message: string; readonly path?: string }
  readonly currentVersion: string
  readonly revision: number
  readonly conflictRanges: readonly ArtifactConflictRange[]
}

/** Body of a successful `POST artifact.presence`. */
export interface ArtifactPresenceResponse {
  readonly ok: true
  readonly ttlMs: number
}

/** Body of a successful `POST artifact.upload`. */
export interface ArtifactUploadResponse {
  readonly ok: true
  readonly attachment: AttachmentRefV1
}

/** Zero counts for an empty project. */
export function emptyArtifactCounts(): ArtifactCounts {
  return { total: 0, pendingView: 0, pendingConfirm: 0, needsFeedback: 0, inProgress: 0, confirmed: 0 }
}

/** Project the record fields the list carries. */
export function artifactSummaryOf(record: ArtifactRecordV1): ArtifactSummaryV1 {
  return {
    artifactId: record.artifactId,
    ownerSessionId: record.ownerSessionId,
    title: record.title,
    type: record.type,
    status: record.status,
    primaryPath: record.primaryPath,
    revision: record.revision,
    commentCount: record.commentCount,
    attachmentCount: record.attachmentCount,
    activeDispatch: record.activeDispatch,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/** Count one summary into the per-state tally. */
export function addArtifactToCounts(counts: ArtifactCounts, status: ArtifactStatus): ArtifactCounts {
  switch (status) {
    case 'pending-view':
      return { ...counts, total: counts.total + 1, pendingView: counts.pendingView + 1 }
    case 'pending-confirm':
      return { ...counts, total: counts.total + 1, pendingConfirm: counts.pendingConfirm + 1 }
    case 'needs-feedback':
      return { ...counts, total: counts.total + 1, needsFeedback: counts.needsFeedback + 1 }
    case 'in-progress':
      return { ...counts, total: counts.total + 1, inProgress: counts.inProgress + 1 }
    case 'confirmed':
      return { ...counts, total: counts.total + 1, confirmed: counts.confirmed + 1 }
  }
}
