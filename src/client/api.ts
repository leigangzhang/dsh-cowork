/**
 * Fetch layer for the Cowork host API (wire v2).
 *
 * The browser cannot read `.dsh-cowork`, so every view comes from the host's
 * loopback JSON routes (`src/api-contract.ts` owns the wire shapes). Reads are
 * same-origin GETs with `cache: 'no-store'`; writes are same-origin POSTs with
 * `content-type: application/json`. Both keep the caller's `AbortController` so
 * unmount / re-select cancels the request.
 *
 * Every response is validated at runtime before the panel sees it: a hand-edited
 * index or an older host must degrade to "this row is unusable" (dropped), not to
 * an empty page. Error envelopes keep the host's `code`/`message`/`path`.
 */
import {
  ACTIVITY_DEFAULT_LIMIT,
  ACTIVITY_MAX_LIMIT,
  ACTIVITY_PATH,
  OVERVIEW_PATH,
  REOPEN_PATH,
  RESOLVE_PATH,
  ROUTE_MOVE_PATH,
  TOPIC_PATH,
  isPanelError,
  isPanelReviewSeverity,
  isPanelReviewStatus,
  isPanelTopicStatus,
  isPanelWorkItemStatus,
  type ActivityResponse,
  type OverviewResponse,
  type PanelActivityEvent,
  type PanelCounts,
  type PanelInboxItem,
  type PanelProject,
  type PanelReviewFinding,
  type PanelReviewRequest,
  type PanelReviewVerification,
  type PanelTopic,
  type PanelWorkItem,
  type ReopenResponse,
  type ResolveResponse,
  type RouteMoveResponse,
  type TopicResponse,
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

/** An integer exit code, or null when the row cannot carry one. */
function exitCode(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
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
 * Narrow one topic row. The id and the state are load-bearing (a row the panel
 * cannot label is dropped, not rendered bare); everything else degrades to an
 * empty value so one sloppy field does not hide the topic.
 */
export function parseTopicRow(value: unknown): PanelTopic | null {
  if (!isRecord(value)) return null
  const topicId = nonEmptyString(value.topicId)
  if (topicId === null) return null
  if (!isPanelTopicStatus(value.status)) return null
  const resolvedBy = value.resolvedBy === 'user' || value.resolvedBy === 'master' ? value.resolvedBy : null
  return {
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
  }
}

/** Narrow one work item; an unlabelled state drops the row. */
export function parseWorkItem(value: unknown): PanelWorkItem | null {
  if (!isRecord(value)) return null
  const workItemId = nonEmptyString(value.workItemId)
  if (workItemId === null) return null
  const topicId = nonEmptyString(value.topicId)
  if (topicId === null) return null
  if (!isPanelWorkItemStatus(value.status)) return null
  return {
    workItemId,
    topicId,
    path: text(value.path),
    branch: text(value.branch),
    baseCommit: optionalText(value.baseCommit),
    headCommit: optionalText(value.headCommit),
    status: value.status,
    updatedAt: text(value.updatedAt),
  }
}

/** Narrow one finding; a row without an id, severity or fix is dropped. */
export function parseFinding(value: unknown): PanelReviewFinding | null {
  if (!isRecord(value)) return null
  const id = nonEmptyString(value.id)
  if (id === null) return null
  if (!isPanelReviewSeverity(value.severity)) return null
  if (typeof value.problem !== 'string' || typeof value.requiredFix !== 'string') return null
  const finding: {
    id: string
    severity: PanelReviewFinding['severity']
    problem: string
    requiredFix: string
    file?: string
    line?: number
  } = { id, severity: value.severity, problem: value.problem, requiredFix: value.requiredFix }
  const file = optionalText(value.file)
  if (file !== null) finding.file = file
  if (typeof value.line === 'number' && Number.isInteger(value.line) && value.line > 0) finding.line = value.line
  return finding
}

/** Narrow one verification row; `exitCode` must be an integer. */
export function parseVerification(value: unknown): PanelReviewVerification | null {
  if (!isRecord(value)) return null
  const command = nonEmptyString(value.command)
  if (command === null) return null
  const code = exitCode(value.exitCode)
  if (code === null) return null
  if (typeof value.evidence !== 'string') return null
  return { command, exitCode: code, evidence: value.evidence }
}

/** Narrow one review request; findings and verification rows are dropped individually. */
export function parseReviewRequest(value: unknown): PanelReviewRequest | null {
  if (!isRecord(value)) return null
  const requestId = nonEmptyString(value.requestId)
  if (requestId === null) return null
  const topicId = nonEmptyString(value.topicId)
  if (topicId === null) return null
  if (!isPanelReviewStatus(value.status)) return null
  const findings = Array.isArray(value.findings)
    ? value.findings.map(parseFinding).filter((row): row is PanelReviewFinding => row !== null)
    : []
  const verification = Array.isArray(value.verification)
    ? value.verification.map(parseVerification)
      .filter((row): row is PanelReviewVerification => row !== null)
    : []
  return {
    requestId,
    topicId,
    workItemId: optionalText(value.workItemId),
    purpose: text(value.purpose),
    status: value.status,
    baseCommit: text(value.baseCommit),
    headCommit: text(value.headCommit),
    changedPaths: stringArray(value.changedPaths),
    requestedAt: text(value.requestedAt),
    reviewedAt: optionalText(value.reviewedAt),
    summary: typeof value.summary === 'string' ? value.summary : null,
    findings,
    verification,
  }
}

/** Narrow one activity event; an event without an id or time is dropped. */
export function parseActivityEvent(value: unknown): PanelActivityEvent | null {
  if (!isRecord(value)) return null
  const eventId = nonEmptyString(value.eventId)
  if (eventId === null) return null
  const time = nonEmptyString(value.time)
  if (time === null) return null
  return {
    eventId,
    time,
    type: text(value.type),
    topicId: optionalText(value.topicId),
    summary: text(value.summary),
  }
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
export function parseOverview(body: unknown): OverviewResponse {
  if (!isRecord(body)) throw new PanelApiError('internal', '总览响应不是对象')
  if (body.ok !== true) throw new PanelApiError('internal', '总览响应缺少 ok: true')
  const project = parseProject(body.project)
  const counts = parseCounts(body.counts)
  const topics = requiredArray(body.topics, 'topics')
    .map(parseTopicRow)
    .filter((topic): topic is PanelTopic => topic !== null)
  const inbox = requiredArray(body.inbox, 'inbox')
    .map(parseInboxItem)
    .filter((item): item is PanelInboxItem => item !== null)
  return { ok: true, project, counts, topics, inbox }
}

/** Narrow the activity body. */
export function parseActivity(body: unknown): ActivityResponse {
  if (!isRecord(body)) throw new PanelApiError('internal', '活动响应不是对象')
  if (body.ok !== true) throw new PanelApiError('internal', '活动响应缺少 ok: true')
  const events = requiredArray(body.events, 'events')
    .map(parseActivityEvent)
    .filter((event): event is PanelActivityEvent => event !== null)
  return { ok: true, events, skippedLines: count(body.skippedLines) }
}

/** Narrow the topic detail body; an unusable topic fails the response. */
export function parseTopic(body: unknown): TopicResponse {
  if (!isRecord(body)) throw new PanelApiError('internal', '主题响应不是对象')
  if (body.ok !== true) throw new PanelApiError('internal', '主题响应缺少 ok: true')
  const topic = parseTopicRow(body.topic)
  if (topic === null) throw new PanelApiError('internal', '主题响应里的主题行不可用')
  const workItems = requiredArray(body.workItems, 'workItems')
    .map(parseWorkItem)
    .filter((item): item is PanelWorkItem => item !== null)
  const reviewRequests = requiredArray(body.reviewRequests, 'reviewRequests')
    .map(parseReviewRequest)
    .filter((request): request is PanelReviewRequest => request !== null)
  const activity = requiredArray(body.activity, 'activity')
    .map(parseActivityEvent)
    .filter((event): event is PanelActivityEvent => event !== null)
  return { ok: true, topic, workItems, reviewRequests, activity }
}

/** Narrow the resolve body. */
export function parseResolve(body: unknown): ResolveResponse {
  if (!isRecord(body)) throw new PanelApiError('internal', '解决响应不是对象')
  if (body.ok !== true) throw new PanelApiError('internal', '解决响应缺少 ok: true')
  const topic = parseTopicRow(body.topic)
  if (topic === null) throw new PanelApiError('internal', '解决响应里的主题行不可用')
  return { ok: true, topic, alreadyResolved: body.alreadyResolved === true }
}

/** Narrow the reopen body. */
export function parseReopen(body: unknown): ReopenResponse {
  if (!isRecord(body)) throw new PanelApiError('internal', '重开响应不是对象')
  if (body.ok !== true) throw new PanelApiError('internal', '重开响应缺少 ok: true')
  const topic = parseTopicRow(body.topic)
  if (topic === null) throw new PanelApiError('internal', '重开响应里的主题行不可用')
  return { ok: true, topic }
}

/** Narrow the route-move body. */
export function parseRouteMove(body: unknown): RouteMoveResponse {
  if (!isRecord(body)) throw new PanelApiError('internal', '改投响应不是对象')
  if (body.ok !== true) throw new PanelApiError('internal', '改投响应缺少 ok: true')
  const topic = parseTopicRow(body.topic)
  if (topic === null) throw new PanelApiError('internal', '改投响应里的主题行不可用')
  return {
    ok: true,
    topic,
    changed: body.changed === true,
    added: stringArray(body.added),
    aliases: stringArray(body.aliases),
  }
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
export async function loadOverview(sessionId: string, signal?: AbortSignal): Promise<OverviewResponse> {
  return parseOverview(await fetchPanelJson(OVERVIEW_PATH, { sessionId }, signal))
}

/** Load the project activity tail; the limit is clamped to the wire bounds. */
export async function loadActivity(
  sessionId: string,
  limit: number = ACTIVITY_DEFAULT_LIMIT,
  signal?: AbortSignal,
): Promise<ActivityResponse> {
  const safeLimit = Number.isFinite(limit)
    ? Math.min(Math.max(1, Math.trunc(limit)), ACTIVITY_MAX_LIMIT)
    : ACTIVITY_DEFAULT_LIMIT
  return parseActivity(
    await fetchPanelJson(ACTIVITY_PATH, { sessionId, limit: String(safeLimit) }, signal),
  )
}

/** Load one topic's detail (work items, review requests and its activity tail). */
export async function loadTopic(
  sessionId: string,
  topicId: string,
  signal?: AbortSignal,
): Promise<TopicResponse> {
  return parseTopic(await fetchPanelJson(TOPIC_PATH, { sessionId, topicId }, signal))
}

/** Mark one topic resolved (master only, idempotent on the host). */
export async function resolveTopic(
  sessionId: string,
  topicId: string,
  signal?: AbortSignal,
): Promise<ResolveResponse> {
  return parseResolve(await postPanelJson(RESOLVE_PATH, { sessionId, topicId }, signal))
}

/** Reopen one resolved topic (master only). */
export async function reopenTopic(
  sessionId: string,
  topicId: string,
  signal?: AbortSignal,
): Promise<ReopenResponse> {
  return parseReopen(await postPanelJson(REOPEN_PATH, { sessionId, topicId }, signal))
}

/** Move work routed to one topic into another (master only). */
export async function moveTopic(
  sessionId: string,
  fromTopicId: string,
  toTopicId: string,
  intent: string,
  signal?: AbortSignal,
): Promise<RouteMoveResponse> {
  const trimmed = intent.trim()
  const payload: Record<string, unknown> = { sessionId, fromTopicId, toTopicId }
  // The host rejects a blank intent, so only a non-empty one is sent.
  if (trimmed.length > 0) payload.intent = trimmed
  return parseRouteMove(await postPanelJson(ROUTE_MOVE_PATH, payload, signal))
}
