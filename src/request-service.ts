/**
 * Request-inbox service: creation, resolution and file opening.
 *
 * This module owns the state machine of one request — the action matrix, the
 * member gate, idempotent replay, the terminal write, the wake-up prompt and
 * the `request-resolved` activity — and it owns the one authorization
 * decision core the legacy `authorization.resolve` route and the new
 * `inbox.resolve` route share. There is deliberately only one unlock path:
 * `blockTopic`/`unblockTopic` stay in `src/topic.ts`, and the notice patch and
 * the topic prompt happen here, once.
 *
 * Failures the routes answer with are {@link PanelServiceError}s carrying a
 * code from the shared `PanelErrorCode` union; `src/api.ts` maps them onto the
 * one error envelope and the one status table. No host is required: every port
 * is injected, so the whole matrix is unit-testable.
 */
import { realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { authorizationResolvedActivity, requestCreatedActivity, requestResolvedActivity } from './activity.js'
import { OPEN_FILE_MAX_BYTES, actionForStatus, isTerminalStatus, statusForAction } from './inbox-contract.js'
import type {
  InboxAnswerInput,
  QuestionPayload,
  RequestAction,
  RequestKind,
  RequestPayload,
  RequestRecordV1,
} from './inbox-contract.js'
import { noticeIdOf, updateAuthorizationNotice } from './notices.js'
import type { NoticeLedgerV1, NoticeUpdateOutcome, TopicNoticePort } from './notices.js'
import {
  RequestSchemaError,
  answerProblems,
  applyResolution,
  buildRequestRecord,
  isRepoRelativePosixPath,
  kindOffersAction,
  normalizeComment,
  resolutionMessage,
} from './request-schema.js'
import { RequestStore } from './request-store.js'
import { ACTIVITY_MAX_EVENTS } from './store-schema.js'
import type {
  ActivityEvent,
  ProjectIndexV2,
  ReadActivityResult,
  TopicRecordV2,
} from './store-schema.js'
import { unblockTopic } from './topic.js'
import { REQUEST_DELIVERY_ERROR_MAX_CHARS } from './request-schema.js'
import type { PanelErrorCode } from './api-contract.js'

/** A failure the panel routes answer with a stable code and status. */
export class PanelServiceError extends Error {
  readonly code: PanelErrorCode
  readonly path: string | undefined

  constructor(code: PanelErrorCode, message: string, path?: string) {
    super(message)
    this.name = 'PanelServiceError'
    this.code = code
    this.path = path
  }
}

/** The store operations creation and resolution need; `ProjectStore` satisfies it. */
export interface RequestServiceStorePort {
  readIndexDocument(): Promise<ProjectIndexV2>
  mutateIndexDocument(mutator: (document: ProjectIndexV2) => ProjectIndexV2 | null): Promise<ProjectIndexV2>
  appendActivity(event: ActivityEvent): Promise<void>
  readActivity(limit?: number): Promise<ReadActivityResult>
  readNotices?(): Promise<NoticeLedgerV1>
  writeNotices?(ledger: NoticeLedgerV1): Promise<NoticeLedgerV1>
  mutateNotices?(mutator: (ledger: NoticeLedgerV1) => NoticeLedgerV1): Promise<NoticeLedgerV1>
}

/** A message for one failure, without carrying a stack into a report. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Cut text to at most `limit` Unicode code points without splitting a pair. */
function clipText(text: string, limit: number): string {
  const points = Array.from(text)
  return points.length <= limit ? text : points.slice(0, limit).join('')
}

/** One request to create for an already-validated topic. */
export interface CreateRequestInput {
  readonly store: Pick<RequestServiceStorePort, 'appendActivity'>
  readonly repoPath: string
  readonly projectId: string
  readonly topic: TopicRecordV2
  readonly kind: RequestKind
  readonly payload: RequestPayload
  readonly summary?: string
  /** Reuse the id another writer already minted (the authorization bridge). */
  readonly requestId: string
  readonly now: Date
  readonly log?: (message: string) => void
}

/**
 * Persist one pending request and its `request-created` activity. The request
 * file is the state; a failed activity append is a logged evidence gap and
 * never rolls the file back.
 */
export async function createRequest(input: CreateRequestInput): Promise<RequestRecordV1> {
  let record: RequestRecordV1
  try {
    record = buildRequestRecord({
      requestId: input.requestId,
      projectId: input.projectId,
      topicId: input.topic.topicId,
      kind: input.kind,
      title: input.topic.title,
      summary: input.summary,
      payload: input.payload,
      now: input.now,
    })
  } catch (error) {
    if (error instanceof RequestSchemaError) {
      throw new PanelServiceError('request/invalid-body', error.message)
    }
    throw error
  }
  const store = new RequestStore({ repoPath: input.repoPath, log: input.log })
  await store.create(record)
  try {
    await input.store.appendActivity(requestCreatedActivity(record, input.now))
  } catch (error) {
    input.log?.(`request ${record.requestId} created, activity not recorded: ${messageOf(error)}`)
  }
  return record
}

/** Everything one resolve call needs. */
export interface ResolveRequestInput {
  readonly store: RequestServiceStorePort
  readonly repoPath: string
  /** The index read for the pre-check; the write re-reads under its own lock. */
  readonly document: ProjectIndexV2
  readonly sessionId: string
  readonly requestId: string
  readonly action: RequestAction
  readonly answers?: readonly InboxAnswerInput[]
  readonly comment?: unknown
  readonly now: Date
  readonly promptSession?: (sessionId: string, text: string) => Promise<{ accepted: boolean }>
  readonly noticePort?: TopicNoticePort
  readonly kickNotices?: (repoPath: string) => void
  readonly log?: (message: string) => void
}

/** What one resolve call did, with the row the response reports. */
export interface ResolveRequestOutcome {
  readonly record: RequestRecordV1
  /** False when the same action replayed an already-terminal request. */
  readonly changed: boolean
  /** Whether the topic session accepted the wake-up prompt. */
  readonly prompted: boolean
  /** Prompt failure text; the request stays terminal. */
  readonly promptError: string | null
}

/**
 * Resolve one pending request: validate the caller, the action and the
 * answers, write the terminal state and the right-hand reply, record the
 * activity, then wake the topic session with the reply.
 *
 * The terminal write is durable before the prompt is attempted, so a refused
 * or failed queue prompt is reported in `delivery.lastError` instead of
 * rolling the decision back. A replay of the same action is idempotent
 * (`changed: false`); a different action on a terminal request is
 * `inbox/request-resolved`.
 */
export async function resolveRequest(input: ResolveRequestInput): Promise<ResolveRequestOutcome> {
  const store = new RequestStore({ repoPath: input.repoPath, log: input.log })
  const record = await store.read(input.requestId)
  if (record === null) {
    throw new PanelServiceError('inbox/request-not-found', `no request ${input.requestId}`)
  }
  assertMember(input.document, input.sessionId, record.topicId)
  if (!kindOffersAction(record.kind, input.action)) {
    throw new PanelServiceError(
      'inbox/action-not-allowed',
      `action ${input.action} is not offered by a ${record.kind} request`,
    )
  }
  const comment = normalizeComment(input.comment)
  if (comment === 'invalid') {
    throw new PanelServiceError('inbox/invalid-comment', 'comment is not a valid bounded string')
  }
  if (isTerminalStatus(record.status)) {
    if (actionForStatus(record.status) === input.action) {
      return { record, changed: false, prompted: false, promptError: null }
    }
    throw new PanelServiceError(
      'inbox/request-resolved',
      `request ${record.requestId} was already resolved as ${record.status}`,
    )
  }
  if (record.kind === 'question' && input.action === 'submit') {
    const problems = answerProblems(record.payload as QuestionPayload, input.answers)
    if (problems.length > 0) {
      throw new PanelServiceError('inbox/invalid-answer', problems.join('; '))
    }
  }
  // An authorization decision is the one kind that also changes topic state and
  // the notice ledger; the shared core below is the only unlock path.
  const decision = record.kind === 'authorization'
    ? await decideAuthorization(input, record)
    : null
  const status = statusForAction(input.action)
  const next = await store.update(input.requestId, (current) => (
    current.status === 'pending'
      ? applyResolution(current, {
        status,
        comment: comment ?? undefined,
        resolvedBy: 'user',
        now: input.now,
      })
      : null
  ))
  if (next === null) {
    // Another writer resolved the request between the read and the lock. The
    // same action is still an idempotent replay; a different one is a conflict.
    const current = await store.read(input.requestId)
    if (current === null) {
      throw new PanelServiceError('inbox/request-not-found', `request ${input.requestId} vanished`)
    }
    if (actionForStatus(current.status) === input.action) {
      return { record: current, changed: false, prompted: false, promptError: null }
    }
    throw new PanelServiceError(
      'inbox/request-resolved',
      `request ${input.requestId} was resolved concurrently as ${current.status}`,
    )
  }
  await appendResolvedActivity(input, next, input.action)
  const prompted = decision === null
    ? await promptTopic(input, next)
    : { prompted: decision.prompted, promptError: decision.promptError }
  const recorded = prompted.prompted || prompted.promptError !== null
    ? await store.recordDelivery(next.requestId, {
      promptedAt: prompted.prompted ? input.now.toISOString() : next.delivery.promptedAt,
      lastError: prompted.promptError,
    })
    : next
  return {
    record: recorded ?? next,
    changed: true,
    prompted: prompted.prompted,
    promptError: prompted.promptError,
  }
}

/** Run the shared authorization core, mapping its codes onto the inbox ones. */
async function decideAuthorization(
  input: ResolveRequestInput,
  record: RequestRecordV1,
): Promise<AuthorizationDecisionOutcome> {
  const decision = input.action === 'allow' ? 'allow' : 'deny'
  try {
    return await resolveAuthorizationDecision({
      store: input.store,
      repoPath: input.repoPath,
      topicId: record.topicId,
      requestId: record.requestId,
      decision,
      sessionId: input.sessionId,
      now: input.now,
      promptSession: input.promptSession,
      noticePort: input.noticePort,
      kickNotices: input.kickNotices,
      log: input.log,
    })
  } catch (error) {
    if (error instanceof PanelServiceError
      && (error.code === 'authorization/not-found' || error.code === 'authorization/mismatch')) {
      throw new PanelServiceError(
        'inbox/request-resolved',
        `the topic no longer holds authorization ${record.requestId}: ${error.message}`,
      )
    }
    throw error
  }
}

/** Append the `request-resolved` activity of one committed resolution. */
async function appendResolvedActivity(
  input: ResolveRequestInput,
  record: RequestRecordV1,
  action: RequestAction,
): Promise<void> {
  try {
    await input.store.appendActivity(requestResolvedActivity(record, { action }, input.now))
  } catch (error) {
    input.log?.(`request ${record.requestId} resolved, activity not recorded: ${messageOf(error)}`)
  }
}

/** Wake the topic session with the persisted right-hand reply. */
async function promptTopic(
  input: ResolveRequestInput,
  record: RequestRecordV1,
): Promise<{ prompted: boolean; promptError: string | null }> {
  // A caller that is the topic session already has the decision; prompting
  // itself would be a duplicate turn.
  if (input.sessionId === record.topicId || input.promptSession === undefined) {
    return { prompted: false, promptError: null }
  }
  const text = record.resolutionMessage ?? resolutionMessage(record.status)
  try {
    const result = await input.promptSession(record.topicId, text)
    return result.accepted
      ? { prompted: true, promptError: null }
      : { prompted: false, promptError: 'the host refused the queue prompt' }
  } catch (error) {
    const message = clipText(messageOf(error), REQUEST_DELIVERY_ERROR_MAX_CHARS)
    input.log?.(`request ${record.requestId}: topic ${record.topicId} was not prompted: ${message}`)
    return { prompted: false, promptError: message }
  }
}

/** Refuse a caller that is neither the project master nor the request's topic. */
function assertMember(document: ProjectIndexV2, sessionId: string, topicId: string): void {
  if (sessionId === document.masterSessionId || sessionId === topicId) return
  throw new PanelServiceError(
    'inbox/not-member',
    `session ${sessionId} may not decide a request of topic ${topicId}`,
  )
}

/** Everything the shared authorization decision core needs. */
export interface AuthorizationDecisionInput {
  readonly store: RequestServiceStorePort
  /** Repository root, used only to kick the notice dispatcher after the write. */
  readonly repoPath: string
  readonly topicId: string
  readonly requestId: string
  readonly decision: 'allow' | 'deny'
  readonly sessionId: string
  readonly now: Date
  readonly promptSession?: (sessionId: string, text: string) => Promise<{ accepted: boolean }>
  readonly noticePort?: TopicNoticePort
  readonly kickNotices?: (repoPath: string) => void
  readonly log?: (message: string) => void
}

/** What one authorization decision did. */
export interface AuthorizationDecisionOutcome {
  readonly changed: boolean
  readonly prompted: boolean
  readonly promptError: string | null
  readonly noticeId: string | null
  readonly document: ProjectIndexV2
  readonly topic: TopicRecordV2
  readonly decision: 'allow' | 'deny'
}

/** One recorded authorization decision, as the activity stream remembers it. */
interface AuthorizationDecisionRecord {
  decision: 'allow' | 'deny'
  noticeId: string | null
}

/** Find the decision already recorded for a request, if any. */
async function recordedDecision(
  store: RequestServiceStorePort,
  topicId: string,
  requestId: string,
): Promise<AuthorizationDecisionRecord | null> {
  const { events } = await store.readActivity(ACTIVITY_MAX_EVENTS)
  for (const event of events) {
    if (event.type !== 'authorization-resolved' || event.topicId !== topicId) continue
    const details = event.details as Record<string, unknown>
    if (details.requestId !== requestId) continue
    if (details.decision !== 'allow' && details.decision !== 'deny') continue
    return {
      decision: details.decision,
      noticeId: typeof details.noticeId === 'string' ? details.noticeId : null,
    }
  }
  return null
}

/** Find the `authorization-requested` event id whose notice a decision updates. */
async function authorizationNoticeId(
  store: RequestServiceStorePort,
  topicId: string,
  requestId: string,
): Promise<string | null> {
  const { events } = await store.readActivity(ACTIVITY_MAX_EVENTS)
  for (const event of events) {
    if (event.type !== 'authorization-requested' || event.topicId !== topicId) continue
    const details = event.details as Record<string, unknown>
    if (details.requestId === requestId) return event.eventId
  }
  return null
}

/** The short prompt a decided topic session receives to continue its work. */
function authorizationPrompt(summary: string, decision: 'allow' | 'deny'): string {
  const verb = decision === 'allow' ? '允许' : '拒绝'
  return `授权请求已${verb}：${clipText(summary, 200)}。请继续。`
}

/**
 * The one authorization decision core: permission, idempotent replay,
 * lock-scoped unlock, `authorization-resolved` activity, notice patch and the
 * topic prompt. Both the legacy `authorization.resolve` route and the inbox
 * resolve route call this function; neither has an unlock path of its own.
 */
export async function resolveAuthorizationDecision(
  input: AuthorizationDecisionInput,
): Promise<AuthorizationDecisionOutcome> {
  const { store, topicId, requestId, decision, sessionId, now } = input
  const before = await store.readIndexDocument()
  const topic = before.topics.find((entry) => entry.topicId === topicId)
  if (topic === undefined) {
    throw new PanelServiceError('topic/not-found', `unknown topic: ${topicId}`)
  }
  // Permission: the master may decide any topic; a topic session only its own.
  if (sessionId !== before.masterSessionId && sessionId !== topicId) {
    throw new PanelServiceError(
      'authorization/not-allowed',
      `session ${sessionId} may not decide an authorization of topic ${topicId}`,
    )
  }
  const pending = topic.authorization ?? null
  if (pending === null) {
    const recorded = await recordedDecision(store, topicId, requestId)
    if (recorded === null) {
      throw new PanelServiceError(
        'authorization/not-found',
        `no pending authorization ${requestId} on ${topicId}`,
      )
    }
    if (recorded.decision !== decision) {
      throw new PanelServiceError(
        'authorization/mismatch',
        `authorization ${requestId} was already ${recorded.decision}; refusing ${decision}`,
      )
    }
    return {
      changed: false,
      prompted: false,
      promptError: null,
      noticeId: recorded.noticeId,
      document: before,
      topic,
      decision,
    }
  }
  if (pending.requestId !== requestId) {
    throw new PanelServiceError(
      'authorization/mismatch',
      `pending authorization is ${pending.requestId}, not ${requestId}`,
    )
  }
  const noticeId = await authorizationNoticeId(store, topicId, requestId)
  const summary = pending.summary
  let changed = false
  const document = await store.mutateIndexDocument((base) => {
    if (base.masterSessionId !== sessionId && sessionId !== topicId) {
      throw new PanelServiceError('authorization/not-allowed', `session ${sessionId} may not decide ${topicId}`)
    }
    const current = base.topics.find((entry) => entry.topicId === topicId)
    if (current === undefined || current.authorization === null) return null
    if (current.authorization.requestId !== requestId) {
      throw new PanelServiceError('authorization/mismatch', `pending authorization is ${current.authorization.requestId}`)
    }
    changed = true
    const released = unblockTopic(current, now.getTime())
    const next: TopicRecordV2 = { ...released, lastActiveAt: now.toISOString() }
    return { ...base, topics: base.topics.map((entry) => (entry.topicId === topicId ? next : entry)) }
  })
  if (!changed) {
    // The lock re-read found no pending authorization: another decision or an
    // archive won the race after the pre-check. Answer from the recorded
    // decision instead of reporting a no-op, so a duplicate click is idempotent
    // and a conflicting one is still refused.
    const recorded = await recordedDecision(store, topicId, requestId)
    if (recorded === null) {
      throw new PanelServiceError(
        'authorization/not-found',
        `no pending authorization ${requestId} on ${topicId}`,
      )
    }
    if (recorded.decision !== decision) {
      throw new PanelServiceError(
        'authorization/mismatch',
        `authorization ${requestId} was already ${recorded.decision}; refusing ${decision}`,
      )
    }
    const settled = document.topics.find((entry) => entry.topicId === topicId)
    if (settled === undefined) {
      throw new PanelServiceError('internal', `topic disappeared from the index: ${topicId}`)
    }
    return {
      changed: false,
      prompted: false,
      promptError: null,
      noticeId: recorded.noticeId,
      document,
      topic: settled,
      decision,
    }
  }
  try {
    await store.appendActivity(
      authorizationResolvedActivity(
        topic,
        { requestId, noticeId: noticeId ?? '', decision, summary },
        now,
      ),
    )
  } catch (error) {
    input.log?.(`panel authorization: activity not recorded: ${messageOf(error)}`)
  }
  if (noticeId !== null && input.noticePort !== undefined) {
    let update: NoticeUpdateOutcome = 'failed'
    try {
      update = await updateAuthorizationNotice({
        port: input.noticePort,
        document,
        topicId,
        noticeId,
        decision,
        now,
      })
    } catch {
      update = 'failed'
    }
    if (update === 'failed') input.log?.(`panel authorization: notice ${noticeId} was not updated`)
  }
  let prompted = false
  let promptError: string | null = null
  // The topic continues on its own; the master already knows from the event.
  if (input.promptSession !== undefined && sessionId !== topicId) {
    try {
      const result = await input.promptSession(topicId, authorizationPrompt(summary, decision))
      prompted = result.accepted
      if (!prompted) promptError = 'the host refused the queue prompt'
    } catch (error) {
      promptError = clipText(messageOf(error), REQUEST_DELIVERY_ERROR_MAX_CHARS)
      input.log?.(`panel authorization: topic ${topicId} was not prompted: ${promptError}`)
    }
  }
  input.kickNotices?.(input.repoPath)
  const current = document.topics.find((entry) => entry.topicId === topicId)
  if (current === undefined) {
    throw new PanelServiceError('internal', `topic disappeared from the index: ${topicId}`)
  }
  return { changed: true, prompted, promptError, noticeId, document, topic: current, decision }
}

/** What one open call needs. */
export interface OpenRequestTargetInput {
  readonly store: Pick<RequestServiceStorePort, 'readActivity'>
  readonly repoPath: string
  readonly requestId?: string
  readonly noticeId?: string
  /** Host file-browser port; absent means the host cannot open files. */
  readonly openWorkspacePath?: (path: string) => Promise<void>
}

/** Resolve one request id to its stored plan file. */
async function planPathOfRequest(repoPath: string, requestId: string): Promise<string> {
  const store = new RequestStore({ repoPath })
  const record = await store.read(requestId)
  if (record === null) {
    throw new PanelServiceError('inbox/request-not-found', `no request ${requestId}`)
  }
  if (record.kind !== 'plan') {
    throw new PanelServiceError('inbox/path-missing', `request ${requestId} carries no openable file`)
  }
  const payload = record.payload as { planPath?: unknown }
  if (typeof payload.planPath !== 'string') {
    throw new PanelServiceError('inbox/path-missing', `request ${requestId} carries no planPath`)
  }
  return payload.planPath
}

/** Resolve one notice id to the proposal file its event carries. */
async function proposalPathOfNotice(
  store: Pick<RequestServiceStorePort, 'readActivity'>,
  noticeId: string,
): Promise<string> {
  const { events } = await store.readActivity(ACTIVITY_MAX_EVENTS)
  for (const event of events) {
    if (noticeIdOf(event) !== noticeId) continue
    const details = event.details as Record<string, unknown>
    if (typeof details.proposalPath === 'string' && details.proposalPath.trim() !== '') {
      return details.proposalPath
    }
  }
  throw new PanelServiceError('inbox/path-missing', `notice ${noticeId} carries no openable file`)
}

/**
 * Resolve a repository path to a real file inside the repository.
 *
 * The browser never names a path: the caller passes the repo-relative value an
 * already-validated record or activity carries. Absolute paths, `..`
 * segments, Windows separators, a symlink that leaves the repository, a
 * non-regular file and a file over {@link OPEN_FILE_MAX_BYTES} are all
 * `inbox/path-missing`.
 */
async function resolveOpenableFile(repoPath: string, relative: unknown): Promise<string> {
  if (!isRepoRelativePosixPath(relative, 500)) {
    throw new PanelServiceError('inbox/path-missing', 'the stored path is not a repo-relative POSIX path')
  }
  let root: string
  try {
    root = await realpath(repoPath)
  } catch (error) {
    throw new PanelServiceError('inbox/path-missing', `the repository root is unreachable: ${messageOf(error)}`)
  }
  const candidate = resolve(root, relative)
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
    throw new PanelServiceError('inbox/path-missing', `the stored path leaves the repository: ${relative}`)
  }
  let real: string
  let info: Awaited<ReturnType<typeof stat>>
  try {
    real = await realpath(candidate)
    info = await stat(real)
  } catch {
    throw new PanelServiceError('inbox/path-missing', `the stored file does not exist: ${relative}`)
  }
  if (real !== root && !real.startsWith(`${root}${sep}`)) {
    throw new PanelServiceError('inbox/path-missing', `the stored path escapes the repository: ${relative}`)
  }
  if (!info.isFile()) {
    throw new PanelServiceError('inbox/path-missing', `the stored path is not a regular file: ${relative}`)
  }
  if (info.size > OPEN_FILE_MAX_BYTES) {
    throw new PanelServiceError(
      'inbox/path-missing',
      `the stored file is ${info.size} bytes; the limit is ${OPEN_FILE_MAX_BYTES}`,
    )
  }
  return real
}

/**
 * `POST /api/cowork.inbox.open`: reveal the plan or proposal file of one
 * request or notice through the host's file browser. The browser sends an id,
 * never a path; a host without the desktop capability is
 * `inbox/open-unsupported`, never a faked success.
 */
export async function openRequestTarget(input: OpenRequestTargetInput): Promise<string> {
  if ((input.requestId === undefined) === (input.noticeId === undefined)) {
    throw new PanelServiceError('inbox/path-missing', 'exactly one of requestId and noticeId is required')
  }
  const relative = input.requestId !== undefined
    ? await planPathOfRequest(input.repoPath, input.requestId)
    : await proposalPathOfNotice(input.store, input.noticeId as string)
  const absolute = await resolveOpenableFile(input.repoPath, relative)
  if (input.openWorkspacePath === undefined) {
    throw new PanelServiceError(
      'inbox/open-unsupported',
      'this host exposes no desktop file browser, so the file cannot be revealed',
    )
  }
  try {
    await input.openWorkspacePath(absolute)
  } catch (error) {
    throw new PanelServiceError(
      'inbox/open-unsupported',
      `the host refused to open ${relative}: ${messageOf(error)}`,
    )
  }
  return absolute
}
