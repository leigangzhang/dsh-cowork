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
  isPanelReviewSeverity,
  isPanelReviewStatus,
  isPanelReviewVerdict,
  type HandoffPayload,
  type HandoffResponse,
  type OverviewPayload,
  type OverviewResponse,
  type PanelHandoffRecord,
  type PanelReviewFinding,
  type PanelReviewPayload,
  type PanelReviewRecord,
  type PanelReviewVerification,
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

/** A trimmed non-empty string from an untrusted body, or null. */
function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** One finding row; a row the panel cannot label is dropped, not rendered bare. */
function parseReviewFinding(value: unknown): PanelReviewFinding | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  if (optionalString(row.id) === null) return null
  if (!isPanelReviewSeverity(row.severity)) return null
  if (typeof row.problem !== 'string' || typeof row.requiredFix !== 'string') return null
  const finding: {
    id: string
    severity: PanelReviewFinding['severity']
    problem: string
    requiredFix: string
    file?: string
    line?: number
  } = {
    id: row.id as string,
    severity: row.severity,
    problem: row.problem,
    requiredFix: row.requiredFix,
  }
  const file = optionalString(row.file)
  if (file !== null) finding.file = file
  if (typeof row.line === 'number' && Number.isInteger(row.line) && row.line > 0) finding.line = row.line
  return finding
}

/** One reviewer verification row; malformed rows are dropped like findings. */
function parseReviewVerification(value: unknown): PanelReviewVerification | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  if (optionalString(row.command) === null) return null
  if (typeof row.exitCode !== 'number' || !Number.isInteger(row.exitCode)) return null
  if (typeof row.evidence !== 'string') return null
  return { command: row.command as string, exitCode: row.exitCode, evidence: row.evidence }
}

/** Narrow one review document to the wire record, or null when it has no verdict. */
function parseReviewRecord(value: unknown): PanelReviewRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (!isPanelReviewVerdict(record.verdict)) return null
  if (typeof record.summary !== 'string') return null
  const reviewerSessionId = optionalString(record.reviewerSessionId)
  const createdAt = optionalString(record.createdAt)
  if (reviewerSessionId === null || createdAt === null) return null
  const findings = Array.isArray(record.findings)
    ? record.findings.map(parseReviewFinding).filter((row): row is PanelReviewFinding => row !== null)
    : []
  const verification = Array.isArray(record.verification)
    ? record.verification.map(parseReviewVerification)
      .filter((row): row is PanelReviewVerification => row !== null)
    : []
  return {
    version: 1,
    threadId: optionalString(record.threadId) ?? '',
    reviewerSessionId,
    verdict: record.verdict,
    summary: record.summary,
    findings,
    verification,
    createdAt,
  }
}

/** Narrow the optional `review` field of a handoff response. */
function parseReviewPayload(value: unknown): PanelReviewPayload | null {
  if (typeof value !== 'object' || value === null) return null
  const payload = value as Record<string, unknown>
  const filePath = optionalString(payload.filePath)
  if (filePath === null) return null
  const record = parseReviewRecord(payload.record)
  if (record === null) return null
  return { record, filePath }
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
      // Only the four review states are accepted; anything else is "no review",
      // so a hand-written index cannot label a thread with an invented state.
      reviewStatus: isPanelReviewStatus(thread.reviewStatus) ? thread.reviewStatus : null,
      reviewedAt: optionalString(thread.reviewedAt),
      reviewerSessionId: optionalString(thread.reviewerSessionId),
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
  // `review` is optional on the wire by design (older hosts omit it, and a
  // missing verdict is a normal state), so it never fails the handoff parse.
  return {
    record: handoff.record as PanelHandoffRecord,
    filePath: handoff.filePath,
    masterMessage: handoff.masterMessage,
    formatterVersion: typeof handoff.formatterVersion === 'string' ? handoff.formatterVersion : '',
    review: parseReviewPayload(handoff.review),
  }
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
