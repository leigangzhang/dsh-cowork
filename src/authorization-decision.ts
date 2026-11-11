/**
 * The one authorization decision core: permission, idempotent replay,
 * lock-scoped unlock, `authorization-resolved` activity, notice patch and the
 * legacy route's card settlement.
 *
 * Both the legacy `authorization.resolve` route and the inbox resolve route call
 * this module; neither has an unlock path of its own. The prompt itself is
 * deferred to the caller (`deferPrompt`), so the request card can be terminal
 * before the topic is woken.
 */
import { authorizationResolvedActivity, requestResolvedActivity } from './activity.js'
import type { RequestRecordV1 } from './inbox-contract.js'
import { updateAuthorizationNotice } from './notices.js'
import type { NoticeUpdateOutcome, TopicNoticePort } from './notices.js'
import { REQUEST_DELIVERY_ERROR_MAX_CHARS, applyResolution } from './request-schema.js'
import { RequestStore } from './request-store.js'
import { ACTIVITY_MAX_EVENTS } from './store-schema.js'
import type { ProjectIndexV2, TopicRecordV2 } from './store-schema.js'
import { unblockTopic } from './topic.js'
import { PanelServiceError, clipText, messageOf } from './request-support.js'
import type { RequestServiceStorePort } from './request-support.js'

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
  /**
   * When true, commit the unlock, the notice patch and the activity, but return
   * the wake-up text in `promptText` instead of prompting. The caller prompts
   * after the request card is terminal, so a card write failure can never leave
   * a prompted topic behind a pending card.
   */
  readonly deferPrompt?: boolean
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
  /** The wake-up text when a committed decision still owes a prompt, or null. */
  readonly promptText: string | null
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
      promptText: null,
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
      promptText: null,
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
  // The topic continues on its own; the master already knows from the event.
  const promptText = input.promptSession !== undefined && sessionId !== topicId
    ? authorizationPrompt(summary, decision)
    : null
  let prompted = false
  let promptError: string | null = null
  if (promptText !== null && input.deferPrompt !== true) {
    try {
      const result = await input.promptSession!(topicId, promptText)
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
  return {
    changed: true,
    prompted,
    promptError,
    promptText: input.deferPrompt === true ? promptText : null,
    noticeId,
    document,
    topic: current,
    decision,
  }
}

/**
 * Converge the request-inbox record of one authorization decision made through
 * the legacy `authorization.resolve` route.
 *
 * The index, the topic authorization and the notice are already handled by
 * {@link resolveAuthorizationDecision}; this keeps the inbox card in step so
 * the two routes cannot show different states. The legacy route calls it with
 * no delivery facts and patches them after the deferred prompt (see
 * {@link promptRequestTopic}), so the card is terminal before the topic wakes.
 * It is
 * deliberately tolerant: the legacy route must keep its response shape, so a
 * missing record (a topic that never used the request tools), a record of
 * another kind or topic, and a record another writer already settled are all
 * quiet outcomes, and a storage/activity failure is logged rather than thrown.
 *
 * Only a pending record is written; an already-terminal record is never
 * overwritten, so an inbox.resolve that settled first keeps its own delivery
 * facts and its one `request-resolved` activity row.
 */
export type SettleAuthorizationOutcome = 'absent' | 'settled' | 'already-resolved' | 'conflict'

/** One legacy authorization decision to mirror into the request inbox. */
export interface SettleAuthorizationRecordInput {
  readonly store: Pick<RequestServiceStorePort, 'appendActivity'>
  readonly repoPath: string
  readonly topicId: string
  readonly requestId: string
  readonly decision: 'allow' | 'deny'
  readonly now: Date
  /** When the topic session accepted the queue prompt, or null. */
  readonly promptedAt: string | null
  /** Why the queue prompt failed, or null. */
  readonly promptError: string | null
  /** The legacy route decides as the user unless told otherwise. */
  readonly resolvedBy?: 'user' | 'master'
  readonly log?: (message: string) => void
}

export async function settleAuthorizationRequestRecord(
  input: SettleAuthorizationRecordInput,
): Promise<SettleAuthorizationOutcome> {
  const store = new RequestStore({ repoPath: input.repoPath, log: input.log })
  let record: RequestRecordV1 | null
  try {
    record = await store.read(input.requestId)
  } catch (error) {
    input.log?.(`request ${input.requestId} was not read for settlement: ${messageOf(error)}`)
    return 'absent'
  }
  if (record === null) return 'absent'
  if (record.kind !== 'authorization' || record.topicId !== input.topicId) return 'absent'
  const status = input.decision === 'allow' ? 'allowed' : 'denied'
  if (record.status !== 'pending') {
    if (record.status === status) return 'already-resolved'
    input.log?.(
      `request ${input.requestId} carries ${record.status}, not ${status}; the legacy decision does not rewrite a settled card`,
    )
    return 'conflict'
  }
  let settled = false
  let next: RequestRecordV1 | null = null
  try {
    next = await store.update(input.requestId, (current) => {
      if (current.kind !== 'authorization' || current.topicId !== input.topicId) return null
      if (current.status !== 'pending') return null
      settled = true
      const resolved = applyResolution(current, {
        status,
        resolvedBy: input.resolvedBy ?? 'user',
        now: input.now,
      })
      return {
        ...resolved,
        delivery: {
          promptedAt: input.promptedAt,
          lastError: input.promptError === null
            ? null
            : clipText(input.promptError, REQUEST_DELIVERY_ERROR_MAX_CHARS),
        },
      }
    })
  } catch (error) {
    input.log?.(`request ${input.requestId} was not settled: ${messageOf(error)}`)
    return 'absent'
  }
  if (!settled || next === null) {
    // A concurrent writer settled the record after the pre-check. Mirroring is
    // best-effort: report what the file now says instead of rewriting it.
    return next !== null && next.status === status ? 'already-resolved' : 'conflict'
  }
  try {
    await input.store.appendActivity(
      requestResolvedActivity(next, { action: input.decision === 'allow' ? 'allow' : 'deny' }, input.now),
    )
  } catch (error) {
    input.log?.(`request ${input.requestId} settled, activity not recorded: ${messageOf(error)}`)
  }
  return 'settled'
}

