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
  ARTIFACT_COMMENTS_PATH,
  ARTIFACT_DETAIL_PATH,
  ARTIFACT_FILE_PATH,
  ARTIFACT_LIST_PATH,
  ARTIFACT_STATUS_PATH,
  type ArtifactAnchor,
  type ArtifactCommentResolveResponse,
  type ArtifactCommentResponse,
  type ArtifactCommentsResponse,
  type ArtifactDetailResponse,
  type ArtifactFileResponse,
  type ArtifactListResponse,
  type ArtifactStatusResponse,
  type CommentEventV1,
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
}

/** One resolve/reopen request. */
export interface ResolveCommentInput {
  readonly sessionId: string
  readonly artifactId: string
  readonly commentId: string
  readonly resolved: boolean
}

/** One status action. */
export interface StatusInput {
  readonly sessionId: string
  readonly artifactId: string
  readonly action: 'view' | 'confirm'
}

/** The work-item client surface the components consume. */
export interface WorkItemApi {
  list(sessionId: string): Promise<ArtifactListResponse>
  detail(sessionId: string, artifactId: string): Promise<ArtifactDetailResponse>
  file(sessionId: string, artifactId: string, path: string): Promise<ArtifactFileResponse>
  comments(sessionId: string, artifactId: string, after?: string): Promise<ArtifactCommentsResponse>
  comment(input: CommentInput): Promise<ArtifactCommentResponse>
  resolveComment(input: ResolveCommentInput): Promise<ArtifactCommentResolveResponse>
  status(input: StatusInput): Promise<ArtifactStatusResponse>
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
    async list(sessionId) {
      const response = await fetchImpl(withQuery(ARTIFACT_LIST_PATH, { sessionId }))
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
    async comments(sessionId, artifactId, after) {
      const response = await fetchImpl(withQuery(ARTIFACT_COMMENTS_PATH, { sessionId, artifactId, after }))
      return envelope<ArtifactCommentsResponse>(response)
    },
    async comment(input) {
      const body: Record<string, unknown> = {
        sessionId: input.sessionId,
        artifactId: input.artifactId,
        body: input.body,
        dispatch: false,
      }
      if (input.anchor !== undefined) body.anchor = input.anchor
      return post<ArtifactCommentResponse>(ARTIFACT_COMMENT_PATH, body)
    },
    async resolveComment(input) {
      return post<ArtifactCommentResolveResponse>(ARTIFACT_COMMENT_RESOLVE_PATH, input)
    },
    status(input) {
      const result: Promise<ArtifactStatusResponse> = post<ArtifactStatusResponse>(ARTIFACT_STATUS_PATH, input)
      return result
    },
  } satisfies WorkItemApi
}

/** The plugin's one client instance. */
export const workItemApi: WorkItemApi = createWorkItemApi()

/** Type-only re-export seam: the components name comment rows without importing the contract twice. */
export type { CommentEventV1 }
