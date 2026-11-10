/**
 * Fetch layer for the Cowork topic page (wire v2).
 *
 * The browser cannot read `.dsh-cowork`, so every view comes from the host's
 * loopback JSON routes (`src/api-contract.ts` owns the wire shapes). Reads are
 * same-origin GETs with `cache: 'no-store'`; writes are same-origin POSTs with
 * `content-type: application/json`. Both keep the caller's `AbortController` so
 * unmount / refresh cancels the request.
 *
 * The topic page only needs three routes: the overview, archive (resolve) and
 * restore (reopen). The list/detail split is gone, so the per-topic detail and
 * the route-move write are not part of this module any more.
 *
 * Every response is validated at runtime before the panel sees it: a hand-edited
 * index or an older host must degrade to "this row is unusable" (dropped), not to
 * an empty page. Error envelopes keep the host's `code`/`message`/`path`.
 */
import {
  OVERVIEW_PATH,
  REOPEN_PATH,
  RESOLVE_PATH,
  isPanelError,
  isPanelReviewStatus,
  isPanelTopicStatus,
  type OverviewResponse,
  type PanelCounts,
  type PanelInboxItem,
  type PanelProject,
  type PanelTopic,
  type ReopenResponse,
  type ResolveResponse,
} from '../api-contract.ts'
import type { PanelErrorInfo } from './contracts.ts'

/**
 * The topic row with the fields the topic-page contract adds. They are
 * optional here because this frontend branch may run against a host that has
 * not shipped them yet; a missing field means "degrade", never "guess".
 */
export interface WireTopic extends PanelTopic {
  readonly awaitingAuthorization?: boolean
  readonly blockedReason?: 'authorization' | 'handoff' | 'conflict' | null
}

/** The overview response with the optional newer topic fields preserved. */
export type WireOverview = Omit<OverviewResponse, 'topics'> & {
  readonly topics: readonly WireTopic[]
}

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

/** Whether a thrown value is an aborted request (unmount / refresh). */
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

/** Whether a value is a plain JSON object (arrays and null are not). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A non-empty trimmed string from untrusted JSON, or null. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** A string from untrusted JSON, or '' when the field is missing. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** An optional string field (null and non-strings collapse to null). */
function optionalText(value: unknown): string | null {
  return nonEmptyString(value)
}

/** A non-negative integer from untrusted JSON, or 0. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

/** A string array from untrusted JSON; non-string members are dropped. */
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/** Map a required array field; a missing array fails the whole response. */
function requiredArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new PanelApiError('internal', `响应缺少 ${what} 数组`)
  return value
}

/** The three blocked reasons the topic-page contract defines. */
const BLOCKED_REASONS: readonly WireTopic['blockedReason'][] = ['authorization', 'handoff', 'conflict']

/** Narrow an optional blocked reason; an invented value reads as null. */
function blockedReason(value: unknown): WireTopic['blockedReason'] {
  return BLOCKED_REASONS.find(reason => reason === value) ?? null
}

/** Narrow the project identity; every field falls back to ''. */
export function parseProject(value: unknown): PanelProject {
  if (!isRecord(value)) throw new PanelApiError('internal', '总览响应缺少 project')
  return {
    repoPath: text(value.repoPath),
    projectId: text(value.projectId),
    masterSessionId: text(value.masterSessionId),
    createdAt: text(value.createdAt),
  }
}

/** Narrow the flat counts; a missing or invented field reads as 0. */
export function parseCounts(value: unknown): PanelCounts {
  const record = isRecord(value) ? value : {}
  return {
    active: count(record.active),
    idle: count(record.idle),
    resolved: count(record.resolved),
    blocked: count(record.blocked),
    awaitingReview: count(record.awaitingReview),
    pendingReview: count(record.pendingReview),
    workItemActive: count(record.workItemActive),
    workItemReviewing: count(record.workItemReviewing),
    workItemMerged: count(record.workItemMerged),
    workItemAbandoned: count(record.workItemAbandoned),
  }
}

/**
 * Narrow one topic row. The id and the state are load-bearing (a row the page
 * cannot label is dropped, not rendered bare); the authorization fields degrade
 * to "absent" so an older host never shows a guessed marker.
 */
export function parseTopicRow(value: unknown): WireTopic | null {
  if (!isRecord(value)) return null
  const topicId = nonEmptyString(value.topicId)
  if (topicId === null) return null
  if (!isPanelTopicStatus(value.status)) return null
  const resolvedBy = value.resolvedBy === 'user' || value.resolvedBy === 'master' ? value.resolvedBy : null
  const row: WireTopic = {
    topicId,
    title: text(value.title),
    status: value.status,
    blocked: value.blocked === true,
    awaitingReview: value.awaitingReview === true,
    reviewStatus: isPanelReviewStatus(value.reviewStatus) ? value.reviewStatus : null,
    latestReviewRequestId: optionalText(value.latestReviewRequestId),
    digest: text(value.digest),
    scope: text(value.scope),
    ownedPaths: stringArray(value.ownedPaths),
    lastActiveAt: text(value.lastActiveAt),
    updatedAt: text(value.updatedAt),
    lastDeliveryConfirmedAt: optionalText(value.lastDeliveryConfirmedAt),
    resolvedAt: optionalText(value.resolvedAt),
    resolvedBy,
    activeWorkItems: count(value.activeWorkItems),
    awaitingAuthorization: value.awaitingAuthorization === true,
    blockedReason: blockedReason(value.blockedReason),
  }
  return row
}

/** Narrow one inbox item; an item without an id is dropped. */
export function parseInboxItem(value: unknown): PanelInboxItem | null {
  if (!isRecord(value)) return null
  const id = nonEmptyString(value.id)
  if (id === null) return null
  return {
    id,
    time: text(value.time),
    topicId: text(value.topicId),
    kind: text(value.kind),
    summary: text(value.summary),
    deliveredAt: optionalText(value.deliveredAt),
  }
}

/** Narrow the overview body (runtime trust boundary). */
export function parseOverview(body: unknown): WireOverview {
  if (!isRecord(body)) throw new PanelApiError('internal', '总览响应不是对象')
  if (body.ok !== true) throw new PanelApiError('internal', '总览响应缺少 ok: true')
  const project = parseProject(body.project)
  const counts = parseCounts(body.counts)
  const topics = requiredArray(body.topics, 'topics')
    .map(parseTopicRow)
    .filter((topic): topic is WireTopic => topic !== null)
  const inbox = requiredArray(body.inbox, 'inbox')
    .map(parseInboxItem)
    .filter((item): item is PanelInboxItem => item !== null)
  return { ok: true, project, counts, topics, inbox }
}

/** Narrow the resolve (archive) body. */
export function parseResolve(body: unknown): ResolveResponse {
  if (!isRecord(body)) throw new PanelApiError('internal', '解决响应不是对象')
  if (body.ok !== true) throw new PanelApiError('internal', '解决响应缺少 ok: true')
  const topic = parseTopicRow(body.topic)
  if (topic === null) throw new PanelApiError('internal', '解决响应里的主题行不可用')
  return { ok: true, topic, alreadyResolved: body.alreadyResolved === true }
}

/** Narrow the reopen (restore) body. */
export function parseReopen(body: unknown): ReopenResponse {
  if (!isRecord(body)) throw new PanelApiError('internal', '重开响应不是对象')
  if (body.ok !== true) throw new PanelApiError('internal', '重开响应缺少 ok: true')
  const topic = parseTopicRow(body.topic)
  if (topic === null) throw new PanelApiError('internal', '重开响应里的主题行不可用')
  return { ok: true, topic }
}

/**
 * Read one response: the shared error envelope becomes a {@link PanelApiError}
 * with the host's code, message and optional path; a non-JSON or malformed body
 * becomes `internal`. Aborts surface unchanged so callers can ignore them.
 */
async function readPanelBody(response: Response): Promise<unknown> {
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
  return body
}

/** GET one panel endpoint and return its parsed JSON (unvalidated). */
export async function fetchPanelJson(
  path: string,
  params: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<unknown> {
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
  return readPanelBody(response)
}

/**
 * POST one write endpoint with a JSON body and return its parsed JSON
 * (unvalidated). The same error-envelope handling as the GET path applies.
 */
export async function postPanelJson(
  path: string,
  payload: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      signal,
    })
  } catch (reason) {
    if (isAbortError(reason)) throw reason
    throw new PanelApiError('internal', `请求失败：${errorMessage(reason)}`)
  }
  return readPanelBody(response)
}

/** Load the project overview for one session. */
export async function loadOverview(sessionId: string, signal?: AbortSignal): Promise<WireOverview> {
  return parseOverview(await fetchPanelJson(OVERVIEW_PATH, { sessionId }, signal))
}

/** Archive one topic (host route `resolve`; master only, idempotent). */
export async function resolveTopic(
  sessionId: string,
  topicId: string,
  signal?: AbortSignal,
): Promise<ResolveResponse> {
  return parseResolve(await postPanelJson(RESOLVE_PATH, { sessionId, topicId }, signal))
}

/** Restore one archived topic (host route `reopen`; master only). */
export async function reopenTopic(
  sessionId: string,
  topicId: string,
  signal?: AbortSignal,
): Promise<ReopenResponse> {
  return parseReopen(await postPanelJson(REOPEN_PATH, { sessionId, topicId }, signal))
}
