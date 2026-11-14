/**
 * Fetch layer for the Cowork topic page (wire v2).
 *
 * The browser cannot read `.dsh-cowork`, so every view comes from the host's
 * loopback JSON routes (`src/panel/api-contract.ts` owns the wire shapes). Reads are
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
} from '../panel/api-contract.ts'
import {
  INBOX_OPEN_PATH,
  INBOX_PATH,
  INBOX_RESOLVE_PATH,
  actionAllowed,
  emptyInboxCounts,
  isInboxNotificationKind,
  isRequestAction,
  isRequestKind,
  isRequestStatus,
  type AuthorizationPayload,
  type InboxAnswerInput,
  type InboxCounts,
  type InboxItem,
  type InboxNotificationItem,
  type InboxOpenResponse,
  type InboxRequestItem,
  type InboxResolveResponse,
  type InboxResponse,
  type PlanPayload,
  type QuestionPayload,
  type QuestionSpec,
  type RequestAction,
  type ReviewPayload,
  type ReviewVerification,
} from '../panel/inbox-contract.ts'
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

/** One verification row from untrusted JSON; a row without a command is unusable. */
function parseVerification(value: unknown): ReviewVerification | null {
  if (!isRecord(value)) return null
  const command = text(value.command)
  if (command.trim() === '') return null
  const exitCode = value.exitCode
  return {
    command,
    exitCode: typeof exitCode === 'number' && Number.isFinite(exitCode) ? Math.trunc(exitCode) : 0,
    evidence: text(value.evidence),
  }
}

/** Narrow the payload of a `user-review` request; missing fields degrade. */
function parseReviewPayload(value: unknown): ReviewPayload {
  const record = isRecord(value) ? value : {}
  const reviewRequestId = optionalText(record.reviewRequestId)
  const payload: ReviewPayload = {
    purpose: text(record.purpose),
    changedPaths: stringArray(record.changedPaths),
    verification: Array.isArray(record.verification)
      ? record.verification.map(parseVerification).filter((row): row is ReviewVerification => row !== null)
      : [],
  }
  return reviewRequestId === null ? payload : { ...payload, reviewRequestId }
}

/** Narrow the payload of an `authorization` request. */
function parseAuthorizationPayload(value: unknown): AuthorizationPayload {
  const record = isRecord(value) ? value : {}
  const command = optionalText(record.command)
  const summary = text(record.summary)
  return command === null ? { summary } : { summary, command }
}

/** One question option; an option without an id is dropped. */
function parseQuestionOption(value: unknown): InboxQuestionOption | null {
  if (!isRecord(value)) return null
  const id = nonEmptyString(value.id)
  if (id === null) return null
  const description = optionalText(value.description)
  const option = {
    id,
    label: text(value.label),
    recommended: value.recommended === true,
  }
  return description === null ? option : { ...option, description }
}

/** One question; a question without an id is dropped. */
function parseQuestion(value: unknown): QuestionSpec | null {
  if (!isRecord(value)) return null
  const id = nonEmptyString(value.id)
  if (id === null) return null
  const options = Array.isArray(value.options)
    ? value.options.map(parseQuestionOption).filter((option): option is InboxQuestionOption => option !== null)
    : undefined
  const question: QuestionSpec = {
    id,
    prompt: text(value.prompt),
    mode: value.mode === 'multi' ? 'multi' : 'single',
    allowText: value.allowText === true,
  }
  return options === undefined ? question : { ...question, options }
}

/** Narrow the payload of a `question` request; a missing list reads as none. */
function parseQuestionPayload(value: unknown): QuestionPayload {
  const record = isRecord(value) ? value : {}
  return {
    questions: Array.isArray(record.questions)
      ? record.questions.map(parseQuestion).filter((question): question is QuestionSpec => question !== null)
      : [],
  }
}

/** Narrow the payload of a `plan` request. */
function parsePlanPayload(value: unknown): PlanPayload {
  const record = isRecord(value) ? value : {}
  const planTitle = optionalText(record.planTitle)
  const planPath = text(record.planPath)
  return planTitle === null ? { planPath } : { planPath, planTitle }
}

/**
 * Narrow one request row. The id, kind and status are load-bearing (a card the
 * page cannot label is dropped); topic title and payload degrade so a missing
 * field never blanks the whole inbox. Terminal rows carry no actions.
 */
export function parseInboxRequestItem(value: unknown): InboxRequestItem | null {
  if (!isRecord(value) || value.kind !== 'request') return null
  const requestId = nonEmptyString(value.requestId)
  if (requestId === null) return null
  if (!isRequestKind(value.requestKind)) return null
  if (!isRequestStatus(value.status)) return null
  const topicId = nonEmptyString(value.topicId)
  if (topicId === null) return null
  const requestKind = value.requestKind
  const actions = Array.isArray(value.actions)
    ? value.actions.filter((action): action is RequestAction =>
        isRequestAction(action) && actionAllowed(requestKind, action))
    : []
  const base = {
    kind: 'request' as const,
    requestId,
    topicId,
    topicTitle: optionalText(value.topicTitle) ?? '已归档主题',
    status: value.status,
    title: text(value.title),
    summary: text(value.summary),
    requestMessage: text(value.requestMessage),
    resolutionMessage: optionalText(value.resolutionMessage),
    actions: value.status === 'pending' ? actions : [],
    createdAt: text(value.createdAt),
    updatedAt: text(value.updatedAt),
  }
  // The row is the one place a wire payload becomes a typed payload; the union
  // then narrows it for every consumer, so nothing re-parses it later.
  switch (requestKind) {
    case 'user-review':
      return { ...base, requestKind: 'user-review', payload: parseReviewPayload(value.payload) }
    case 'authorization':
      return { ...base, requestKind: 'authorization', payload: parseAuthorizationPayload(value.payload) }
    case 'question':
      return { ...base, requestKind: 'question', payload: parseQuestionPayload(value.payload) }
    case 'plan':
      return { ...base, requestKind: 'plan', payload: parsePlanPayload(value.payload) }
  }
}

/** Narrow one notification row; a row without a known kind is dropped. */
export function parseInboxNotificationItem(value: unknown): InboxNotificationItem | null {
  if (!isRecord(value) || value.kind !== 'notification') return null
  const noticeId = nonEmptyString(value.noticeId)
  if (noticeId === null) return null
  if (!isInboxNotificationKind(value.noticeKind)) return null
  const proposalPath = optionalText(value.proposalPath)
  const canOpen = value.noticeKind !== 'review-verdict' && value.canOpen === true
  const item: InboxNotificationItem = {
    kind: 'notification',
    noticeId,
    noticeKind: value.noticeKind,
    topicId: text(value.topicId),
    topicTitle: optionalText(value.topicTitle) ?? '已归档主题',
    summary: text(value.summary),
    createdAt: text(value.createdAt),
    updatedAt: text(value.updatedAt),
    canOpen,
  }
  return proposalPath === null ? item : { ...item, proposalPath }
}

/** Narrow one request-inbox row by its discriminant; an unusable row is dropped. */
export function parseInboxRow(value: unknown): InboxItem | null {
  if (!isRecord(value)) return null
  if (value.kind === 'request') return parseInboxRequestItem(value)
  if (value.kind === 'notification') return parseInboxNotificationItem(value)
  return null
}

/** Narrow the inbox counts; missing or invented fields read as 0. */
export function parseInboxCounts(value: unknown): InboxCounts {
  if (!isRecord(value)) return emptyInboxCounts()
  return {
    pending: count(value.pending),
    review: count(value.review),
    authorization: count(value.authorization),
    question: count(value.question),
    plan: count(value.plan),
  }
}

/**
 * Narrow the `GET /api/cowork.inbox` body. A malformed envelope fails the read
 * (the panel shows the retryable error); a single unusable row is dropped so
 * one hand-edited request file never blanks the inbox.
 */
export function parseInboxResponse(body: unknown): InboxResponse {
  if (!isRecord(body)) throw new PanelApiError('internal', '收件箱响应不是对象')
  if (body.ok !== true) throw new PanelApiError('internal', '收件箱响应缺少 ok: true')
  const items = requiredArray(body.items, 'items')
    .map(parseInboxRow)
    .filter((item): item is InboxItem => item !== null)
  return {
    ok: true,
    items,
    counts: parseInboxCounts(body.counts),
    truncated: body.truncated === true,
  }
}

/** Narrow the resolve body; the returned row carries the right-hand reply. */
export function parseInboxResolveResponse(body: unknown): InboxResolveResponse {
  if (!isRecord(body)) throw new PanelApiError('internal', '解决响应不是对象')
  if (body.ok !== true) throw new PanelApiError('internal', '解决响应缺少 ok: true')
  const item = parseInboxRequestItem(body.item)
  if (item === null) throw new PanelApiError('internal', '解决响应里的收件箱项不可用')
  return {
    ok: true,
    item,
    changed: body.changed === true,
    prompted: body.prompted === true,
    promptError: optionalText(body.promptError),
  }
}

/** Narrow the open body; the host only answers `opened: true` on success. */
export function parseInboxOpenResponse(body: unknown): InboxOpenResponse {
  if (!isRecord(body) || body.ok !== true || body.opened !== true) {
    throw new PanelApiError('internal', '打开响应缺少 ok: true 与 opened: true')
  }
  return { ok: true, opened: true }
}

/** Read one response: the shared error envelope becomes a {@link PanelApiError}
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

/** One option of one question, as narrowed from the wire. */
export interface InboxQuestionOption {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly recommended?: boolean
}

/** Body of a resolve write; `comment` and `answers` are kind-specific. */
export interface InboxResolveRequest {
  readonly sessionId: string
  readonly requestId: string
  readonly action: RequestAction
  /** User-review findings or plan revise reason, already validated locally. */
  readonly comment?: string
  /** Question answers; one entry per answered question. */
  readonly answers?: readonly InboxAnswerInput[]
}

/** Body of an open write: a request file or a proposal note, never a path. */
export interface InboxOpenRequest {
  readonly sessionId: string
  readonly requestId?: string
  readonly noticeId?: string
}

/**
 * Load the request inbox for one session. `topicId` narrows the read to one
 * topic; the server still returns the project-wide counts.
 */
export async function loadInbox(
  sessionId: string,
  topicId?: string | null,
  signal?: AbortSignal,
): Promise<InboxResponse> {
  const params: Record<string, string> = { sessionId }
  if (topicId !== undefined && topicId !== null && topicId.trim() !== '') params.topicId = topicId
  return parseInboxResponse(await fetchPanelJson(INBOX_PATH, params, signal))
}

/**
 * Resolve one pending request. The action is validated against the frozen
 * kind/action table before the write; the host re-validates the same action.
 */
export async function resolveInboxRequest(
  payload: InboxResolveRequest,
  signal?: AbortSignal,
): Promise<InboxResolveResponse> {
  const comment = payload.comment === undefined ? null : payload.comment.trim()
  const body: Record<string, unknown> = {
    sessionId: payload.sessionId,
    requestId: payload.requestId,
    action: payload.action,
  }
  if (comment !== null && comment !== '') body.comment = comment
  if (payload.answers !== undefined && payload.answers.length > 0) body.answers = payload.answers
  return parseInboxResolveResponse(await postPanelJson(INBOX_RESOLVE_PATH, body, signal))
}

/**
 * Ask the host to reveal the file behind a request or a proposal note. The
 * browser sends ids only; the server resolves and guards the path.
 */
export async function openInboxTarget(
  payload: InboxOpenRequest,
  signal?: AbortSignal,
): Promise<InboxOpenResponse> {
  const requestId = payload.requestId === undefined ? null : payload.requestId.trim()
  const noticeId = payload.noticeId === undefined ? null : payload.noticeId.trim()
  if ((requestId === null || requestId === '') && (noticeId === null || noticeId === '')) {
    throw new PanelApiError('inbox/path-missing', '打开目标缺少 requestId 或 noticeId')
  }
  const body: Record<string, unknown> = { sessionId: payload.sessionId }
  if (requestId !== null && requestId !== '') body.requestId = requestId
  if (noticeId !== null && noticeId !== '') body.noticeId = noticeId
  return parseInboxOpenResponse(await postPanelJson(INBOX_OPEN_PATH, body, signal))
}

