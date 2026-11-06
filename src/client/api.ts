/**
 * Fetch layer for the read-only Cowork host API.
 *
 * The browser cannot read `.dsh-cowork`, so both views come from the host's
 * loopback JSON endpoints (`src/api-contract.ts` owns the wire shapes). Requests
 * are same-origin GETs with `cache: 'no-store'` and an `AbortController`, which
 * is what the panel passes in on unmount / re-select.
 */
import {
  HANDOFF_PATH,
  OVERVIEW_PATH,
  isPanelError,
  type HandoffPayload,
  type HandoffResponse,
  type OverviewPayload,
  type OverviewResponse,
} from '../api-contract.ts'
import type { PanelErrorInfo } from './contracts.ts'

/** Error raised for every non-success outcome, with the wire code preserved. */
export class PanelApiError extends Error implements PanelErrorInfo {
  readonly code: string
  readonly path?: string

  constructor(code: string, message: string, path?: string) {
    super(message)
    this.name = 'PanelApiError'
    this.code = code
    if (path !== undefined) this.path = path
  }
}

/** Whether a thrown value is an aborted request (unmount / re-select). */
export function isAbortError(reason: unknown): boolean {
  return typeof reason === 'object' && reason !== null
    && (reason as { name?: unknown }).name === 'AbortError'
}

/** Normalize an unknown thrown value into the panel's error shape. */
export function toPanelError(reason: unknown): PanelErrorInfo {
  if (reason instanceof PanelApiError) return reason
  if (reason instanceof Error) return { code: 'internal', message: reason.message }
  return { code: 'internal', message: String(reason) }
}

/** Copy an unknown thrown value into a short human message. */
export function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message.length > 0) return reason.message
  return String(reason)
}

/** Build a request path with its query string; values are URL-encoded. */
export function panelApiPath(path: string, params: Readonly<Record<string, string>>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) query.append(key, value)
  const search = query.toString()
  return search.length === 0 ? path : `${path}?${search}`
}

/** Narrow the parsed body to an overview payload (runtime trust boundary). */
function parseOverview(body: unknown): OverviewPayload {
  if (typeof body !== 'object' || body === null) throw new PanelApiError('internal', '总览响应不是对象')
  const record = body as Partial<OverviewResponse>
  if (record.ok !== true) throw new PanelApiError('internal', '总览响应缺少 ok: true')
  const project = record.project
  const counts = record.counts
  const threads = record.threads
  if (typeof project !== 'object' || project === null) throw new PanelApiError('internal', '总览响应缺少 project')
  if (typeof counts !== 'object' || counts === null) throw new PanelApiError('internal', '总览响应缺少 counts')
  if (!Array.isArray(threads)) throw new PanelApiError('internal', '总览响应缺少 threads 数组')
  return {
    project: {
      repoPath: String(project.repoPath ?? ''),
      projectId: String(project.projectId ?? ''),
      masterSessionId: String(project.masterSessionId ?? ''),
      createdAt: String(project.createdAt ?? ''),
    },
    counts: {
      new: Number(counts.new ?? 0),
      active: Number(counts.active ?? 0),
      awaiting_review: Number(counts.awaiting_review ?? 0),
      blocked: Number(counts.blocked ?? 0),
      done: Number(counts.done ?? 0),
    },
    threads: threads.map(thread => ({
      threadId: String(thread.threadId ?? ''),
      subject: String(thread.subject ?? ''),
      status: thread.status,
      cwd: String(thread.cwd ?? ''),
      checkoutPath: thread.checkoutPath ?? null,
      createdAt: String(thread.createdAt ?? ''),
      updatedAt: String(thread.updatedAt ?? ''),
      lastHandoffAt: thread.lastHandoffAt ?? null,
      hasHandoff: thread.hasHandoff === true,
    })),
  }
}

/** Narrow the parsed body to a handoff payload (runtime trust boundary). */
function parseHandoff(body: unknown): HandoffPayload {
  if (typeof body !== 'object' || body === null) throw new PanelApiError('internal', '交接单响应不是对象')
  const record = body as Partial<HandoffResponse>
  if (record.ok !== true) throw new PanelApiError('internal', '交接单响应缺少 ok: true')
  const handoff = record.handoff
  if (typeof handoff !== 'object' || handoff === null) throw new PanelApiError('internal', '交接单响应缺少 handoff')
  if (typeof handoff.filePath !== 'string') throw new PanelApiError('internal', '交接单响应缺少 filePath')
  if (typeof handoff.masterMessage !== 'string') throw new PanelApiError('internal', '交接单响应缺少 masterMessage')
  return handoff
}

/**
 * GET one panel endpoint and parse it.
 *
 * A non-2xx body carrying the shared error envelope becomes a
 * {@link PanelApiError} with the host's code, message and optional path; a
 * non-JSON or malformed body becomes `internal`. Aborts surface unchanged so
 * callers can ignore them.
 */
export async function fetchPanelJson<T>(
  path: string,
  params: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response
  try {
    response = await fetch(panelApiPath(path, params), {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal,
    })
  } catch (reason) {
    if (isAbortError(reason)) throw reason
    throw new PanelApiError('internal', `请求失败：${errorMessage(reason)}`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (reason) {
    if (isAbortError(reason)) throw reason
    throw new PanelApiError('internal', `响应不是 JSON（HTTP ${response.status}）`)
  }

  if (isPanelError(body)) {
    throw new PanelApiError(body.error.code, body.error.message, body.error.path)
  }
  if (!response.ok) {
    throw new PanelApiError('internal', `请求失败（HTTP ${response.status}）`)
  }
  return body as T
}

/** Load the project overview for one session. */
export async function loadOverview(sessionId: string, signal?: AbortSignal): Promise<OverviewPayload> {
  const body = await fetchPanelJson<unknown>(OVERVIEW_PATH, { sessionId }, signal)
  return parseOverview(body)
}

/** Load one thread's latest handoff; `null` means the host reported none. */
export async function loadHandoff(
  sessionId: string,
  threadId: string,
  signal?: AbortSignal,
): Promise<HandoffPayload | null> {
  try {
    const body = await fetchPanelJson<unknown>(HANDOFF_PATH, { sessionId, threadId }, signal)
    return parseHandoff(body)
  } catch (reason) {
    if (reason instanceof PanelApiError && reason.code === 'handoff/not-found') return null
    throw reason
  }
}
