/**
 * Browser client for the work-item routes.
 *
 * Every call goes through the same fetch-first shape: build the exact route
 * path, parse the one JSON envelope, and turn `{ok:false}` (or a failed status)
 * into a typed {@link WorkItemApiError} the components can present. The fetch
 * implementation is injected so the module is testable in Node without a host.
 */
import {
  ARTIFACT_COMMENT_PATH,
  ARTIFACT_COMMENT_RESOLVE_PATH,
  ARTIFACT_COMMENTS_MAX_LIMIT,
  ARTIFACT_COMMENTS_PATH,
  ARTIFACT_DETAIL_PATH,
  ARTIFACT_DISPATCH_RETRY_PATH,
  ARTIFACT_EDIT_PATH,
  ARTIFACT_FILE_PATH,
  ARTIFACT_ATTACHMENT_PATH,
  ARTIFACT_LIST_PATH,
  ARTIFACT_OPEN_PATH,
  ARTIFACT_PRESENCE_PATH,
  ARTIFACT_REBIND_PATH,
  ARTIFACT_UPLOAD_PATH,
  ARTIFACT_STATUS_PATH,
  type ArtifactAnchor,
  type ArtifactDispatchRetryResponse,
  type ArtifactCommentResolveResponse,
  type ArtifactCommentResponse,
  type ArtifactCommentsResponse,
  type ArtifactDetailResponse,
  type ArtifactEditResponse,
  type ArtifactFileResponse,
  type ArtifactListResponse,
  type ArtifactOpenResponse,
  type ArtifactPresenceResponse,
  type ArtifactRecordV1,
  type ArtifactStatus,
  type ArtifactStatusResponse,
  type ArtifactUploadResponse,
  type AttachmentRefV1,
} from '../../panel/artifact-contract.js'

/** The fetch shape this client needs; the platform fetch satisfies it. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** One failed work-item request, already normalized from the wire envelope. */
export class WorkItemApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'WorkItemApiError'
    this.code = code
    this.status = status
  }
}

/** One new comment or reply. */
export interface CommentInput {
  readonly sessionId: string
  readonly artifactId: string
  readonly body: string
  readonly anchor?: ArtifactAnchor
  /** Existing root comment being replied to; replies inherit its anchor. */
  readonly threadId?: string
  readonly attachments?: readonly AttachmentRefV1[]
}

/** One attachment upload. */
export interface UploadInput {
  readonly sessionId: string
  readonly artifactId: string
  readonly name: string
  readonly bytes: Blob | Uint8Array
}

/** One resolve/reopen request. */
export interface ResolveCommentInput {
  readonly sessionId: string
  readonly artifactId: string
  readonly commentId: string
  readonly resolved: boolean
}

/** One text save; the base revision and version are what the browser loaded. */
export interface EditInput {
  readonly sessionId: string
  readonly artifactId: string
  readonly path: string
  readonly baseRevision: number
  readonly baseVersion: string | null
  readonly content: string
}

/** The conflict ranges a 409 save carries. */
export interface SaveConflict {
  readonly currentVersion: string
  readonly revision: number
  readonly conflictRanges: readonly { readonly startLine: number; readonly endLine: number }[]
}

/** One editing-presence report. */
export interface PresenceInput {
  readonly sessionId: string
  readonly artifactId: string
  readonly path: string
  readonly ranges: readonly { readonly startLine: number; readonly endLine: number }[]
}

/** One "open in app" request. */
export interface OpenInput {
  readonly sessionId: string
  readonly artifactId: string
}

/** One rebind request: the registered path that vanished and its replacement. */
export interface RebindInput {
  readonly sessionId: string
  readonly artifactId: string
  readonly oldPath: string
  readonly newPath: string
}

/**
 * Frozen stage-5 wire shape of `POST artifact.rebind`.
 *
 * The route constant is the contract module's; its response type is owned by
 * the backend task, so the browser half declares the shape it decodes. The two
 * are structurally identical: a rebind reports whether the path changed and
 * returns the whole updated record.
 */
export interface ArtifactRebindResult {
  readonly ok: true
  readonly changed: boolean
  readonly record: ArtifactRecordV1
}

/**
 * One comments page. The wire contract owns the shape, including the stage-5
 * `hasOlder` flag, so the browser half reuses it instead of restating fields.
 */
export type CommentsPage = ArtifactCommentsResponse

/** One status action. */
export interface StatusInput {
  readonly sessionId: string
  readonly artifactId: string
  readonly action: 'view' | 'confirm'
}

/** Query and cancellation of one list read. */
export interface ListOptions {
  /** Trimmed search text; absent or empty means "no search". */
  readonly q?: string
  /** The merged rail status; `pending-confirm` also matches stored pending-view. */
  readonly status?: ArtifactStatus
  /** Aborts a superseded read; the caller keeps whatever rows it already has. */
  readonly signal?: AbortSignal
}

/** The work-item client surface the components consume. */
export interface WorkItemApi {
  list(sessionId: string, options?: ListOptions): Promise<ArtifactListResponse>
  detail(sessionId: string, artifactId: string): Promise<ArtifactDetailResponse>
  file(sessionId: string, artifactId: string, path: string): Promise<ArtifactFileResponse>
  /** `after` reads the next newer page; `before` reads the next older one. */
  comments(sessionId: string, artifactId: string, after?: string, before?: string): Promise<CommentsPage>
  comment(input: CommentInput): Promise<ArtifactCommentResponse>
  resolveComment(input: ResolveCommentInput): Promise<ArtifactCommentResolveResponse>
  open(input: OpenInput): Promise<ArtifactOpenResponse>
  retryDispatch(input: { sessionId: string; artifactId: string; dispatchId: string }): Promise<ArtifactDispatchRetryResponse>
  status(input: StatusInput): Promise<ArtifactStatusResponse>
  edit(input: EditInput): Promise<ArtifactEditResponse>
  presence(input: PresenceInput): Promise<ArtifactPresenceResponse>
  upload(input: UploadInput): Promise<ArtifactUploadResponse>
  /** Rebind a registered file that moved; the old path must still be registered. */
  rebind(input: RebindInput): Promise<ArtifactRebindResult>
  /** Same-origin URL of one stored attachment, for an `<img>` or a download link. */
  attachmentUrl(input: { sessionId: string; artifactId: string; attachmentId: string }): string
}

/** Read the JSON body of one response, refusing a non-JSON error page. */
async function readJson(response: Response): Promise<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new WorkItemApiError('internal', `invalid response payload (HTTP ${String(response.status)})`, response.status)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new WorkItemApiError('internal', 'response payload is not an object', response.status)
  }
  return parsed as Record<string, unknown>
}

/** The shared envelope: a failed status or `{ok:false}` becomes an error. */
async function envelope<T extends { ok: true }>(response: Response): Promise<T> {
  const body = await readJson(response)
  if (!response.ok || body.ok !== true) {
    const error = (body.error ?? {}) as { code?: unknown; message?: unknown }
    const code = typeof error.code === 'string' ? error.code : 'internal'
    const message = typeof error.message === 'string' ? error.message : `request failed (HTTP ${String(response.status)})`
    throw new WorkItemApiError(code, message, response.status)
  }
  return body as unknown as T
}

/** Append a query string, skipping empty values. */
function withQuery(path: string, query: Readonly<Record<string, string | undefined>>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, value)
  }
  const suffix = params.toString()
  return suffix === '' ? path : `${path}?${suffix}`
}

/** Build the work-item client over one fetch implementation. */
export function createWorkItemApi(fetchImpl: FetchLike = (input, init) => fetch(input, init)): WorkItemApi {
  const post = async <T extends { ok: true }>(path: string, body: unknown): Promise<T> => {
    const response = await fetchImpl(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return envelope<T>(response)
  }
  return {
    async list(sessionId, options) {
      const path = withQuery(ARTIFACT_LIST_PATH, {
        sessionId,
        q: options?.q,
        status: options?.status,
      })
      const signal = options?.signal
      const response = await fetchImpl(path, signal === undefined ? undefined : { signal })
      return envelope<ArtifactListResponse>(response)
    },
    async detail(sessionId, artifactId) {
      const response = await fetchImpl(withQuery(ARTIFACT_DETAIL_PATH, { sessionId, artifactId }))
      return envelope<ArtifactDetailResponse>(response)
    },
    async file(sessionId, artifactId, path) {
      const response = await fetchImpl(withQuery(ARTIFACT_FILE_PATH, { sessionId, artifactId, path }))
      return envelope<ArtifactFileResponse>(response)
    },
    async comments(sessionId, artifactId, after, before) {
      const response = await fetchImpl(withQuery(ARTIFACT_COMMENTS_PATH, {
        sessionId,
        artifactId,
        after,
        before,
        limit: String(ARTIFACT_COMMENTS_MAX_LIMIT),
      }))
      return envelope<CommentsPage>(response)
    },
    async comment(input) {
      const body: Record<string, unknown> = {
        sessionId: input.sessionId,
        artifactId: input.artifactId,
        body: input.body,
      }
      if (input.anchor !== undefined) body.anchor = input.anchor
      if (input.threadId !== undefined) body.threadId = input.threadId
      if (input.attachments !== undefined && input.attachments.length > 0) body.attachments = input.attachments
      return post<ArtifactCommentResponse>(ARTIFACT_COMMENT_PATH, body)
    },
    async retryDispatch(input) {
      return post<ArtifactDispatchRetryResponse>(ARTIFACT_DISPATCH_RETRY_PATH, input)
    },
    async open(input) {
      return post<ArtifactOpenResponse>(ARTIFACT_OPEN_PATH, input)
    },
    async resolveComment(input) {
      return post<ArtifactCommentResolveResponse>(ARTIFACT_COMMENT_RESOLVE_PATH, input)
    },
    status(input) {
      const result: Promise<ArtifactStatusResponse> = post<ArtifactStatusResponse>(ARTIFACT_STATUS_PATH, input)
      return result
    },
    async edit(input) {
      const response = await fetchImpl(ARTIFACT_EDIT_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (response.status === 409) {
        const body = await readJson(response)
        const conflict = body as unknown as SaveConflict & { ok?: unknown; error?: { code?: unknown; message?: unknown } }
        const error = new WorkItemApiError(
          typeof conflict.error?.code === 'string' ? conflict.error.code : 'artifact/version-conflict',
          typeof conflict.error?.message === 'string' ? conflict.error.message : 'save conflict',
          409,
        )
        Object.assign(error, {
          conflict: {
            currentVersion: typeof conflict.currentVersion === 'string' ? conflict.currentVersion : '',
            revision: typeof conflict.revision === 'number' ? conflict.revision : 0,
            conflictRanges: Array.isArray(conflict.conflictRanges) ? conflict.conflictRanges : [],
          } satisfies SaveConflict,
        })
        throw error
      }
      return envelope<ArtifactEditResponse>(response)
    },
    async presence(input) {
      return post<ArtifactPresenceResponse>(ARTIFACT_PRESENCE_PATH, input)
    },
    async upload(input) {
      const response = await fetchImpl(withQuery(ARTIFACT_UPLOAD_PATH, {
        sessionId: input.sessionId,
        artifactId: input.artifactId,
        name: input.name,
      }), {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: input.bytes as BodyInit,
      })
      return envelope<ArtifactUploadResponse>(response)
    },
    async rebind(input) {
      return post<ArtifactRebindResult>(ARTIFACT_REBIND_PATH, input)
    },
    attachmentUrl(input) {
      return withQuery(ARTIFACT_ATTACHMENT_PATH, {
        sessionId: input.sessionId,
        artifactId: input.artifactId,
        attachmentId: input.attachmentId,
      })
    },
  } satisfies WorkItemApi
}

/** The plugin's one client instance. */
export const workItemApi: WorkItemApi = createWorkItemApi()

