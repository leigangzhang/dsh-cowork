/**
 * The one authorization decision core: permission, idempotent replay,
 * lock-scoped unlock, `authorization-resolved` activity, notice patch and the
 * request-card settlement shared by both routes.
 *
 * The index unlock and the request card's terminal state are written while one
 * project-lock acquisition is held. Both stores use the same
 * `<repo>/.dsh-cowork/.write.lock`, so the transaction opens it once through
 * `withWriteLock` and then uses the no-lock writes
 * (`mutateIndexDocumentUnlocked`, `updateUnlocked`). The lock is not reentrant;
 * taking it twice would deadlock, which is why no locked store method runs
 * inside the transaction.
 *
 * The prompt itself is deferred to the caller (`deferPrompt`), so the card can
 * be terminal before the topic is woken.
 */
import { authorizationResolvedActivity, requestResolvedActivity } from './store/activity.js'
import type { RequestRecordV1 } from './inbox-contract.js'
import { updateAuthorizationNotice } from './notices.js'
import type { NoticeUpdateOutcome, TopicNoticePort } from './notices.js'
import { REQUEST_DELIVERY_ERROR_MAX_CHARS, applyResolution } from './request-schema.js'
import { RequestStore } from './store/request-store.js'
import { ACTIVITY_MAX_EVENTS } from './store/schema.js'
import type { ProjectIndexV2, TopicRecordV2 } from './store/schema.js'
import { unblockTopic } from './topic.js'
import { PanelServiceError, clipText, messageOf } from './request-support.js'
import type { RequestServiceStorePort } from './request-support.js'

/** Card state after one authorization decision. */
export type SettleAuthorizationOutcome = 'absent' | 'settled' | 'already-resolved' | 'conflict'

/**
 * The request-card operations the transaction needs. `RequestStore` satisfies
 * it: `read` is lock-free, `updateUnlocked` requires the caller's lock.
 */
export interface RequestCardStorePort {
  read(requestId: string): Promise<RequestRecordV1 | null>
  updateUnlocked(
    requestId: string,
    mutator: (current: RequestRecordV1) => RequestRecordV1 | null,
  ): Promise<RequestRecordV1 | null>
  /** The project writer lock, when the store can take it (standalone settlement). */
  withWriteLock?<T>(operation: () => Promise<T>): Promise<T>
}

/** Everything the shared authorization decision core needs. */
export interface AuthorizationDecisionInput {
  readonly store: RequestServiceStorePort
  /** Repository root, used to kick the notice dispatcher after the write. */
  readonly repoPath: string
  readonly topicId: string
  readonly requestId: string
  readonly decision: 'allow' | 'deny'
  readonly sessionId: string
  readonly now: Date
  /**
   * When true, commit the unlock, the card, the notice patch and the activity,
   * but return the wake-up text in `promptText` instead of prompting. The
   * caller prompts after the request card is terminal, so a card write failure
   * can never leave a prompted topic behind a pending card.
   */
  readonly deferPrompt?: boolean
  readonly promptSession?: (sessionId: string, text: string) => Promise<{ accepted: boolean }>
  readonly noticePort?: TopicNoticePort
  readonly kickNotices?: (repoPath: string) => void
  /** Card store override; defaults to a `RequestStore` for `repoPath`. */
  readonly requestCard?: RequestCardStorePort
  /**
   * Terminal state of one pending card. Defaults to the legacy mirror: the
   * decision's status, `resolvedBy: 'user'` and empty delivery facts (the caller
   * patches delivery after its deferred prompt).
   */
  readonly settleCard?: (current: RequestRecordV1, status: 'allowed' | 'denied') => RequestRecordV1 | null
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
  /** How the request card ended up; `absent` when the project has no card. */
  readonly cardSettled: SettleAuthorizationOutcome
  /** The card after the transaction, or null when it was absent. */
  readonly cardRecord: RequestRecordV1 | null
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

/** Classify a card that was not written: absent, terminal-same or terminal-different. */
function cardOutcomeOf(
  current: RequestRecordV1 | null,
  status: 'allowed' | 'denied',
): SettleAuthorizationOutcome {
  if (current === null) return 'absent'
  if (current.status === status) return 'already-resolved'
  if (current.status === 'pending') return 'absent'
  return 'conflict'
}

/**
 * Read, classify and (for a pending card) write one authorization card. The
 * caller already holds the project writer lock, so this never takes it.
 */
async function settleCardInLock(
  cardStore: RequestCardStorePort,
  requestId: string,
  topicId: string,
  status: 'allowed' | 'denied',
  decide: (current: RequestRecordV1) => RequestRecordV1 | null,
): Promise<{ outcome: SettleAuthorizationOutcome; record: RequestRecordV1 | null }> {
  const current = await cardStore.read(requestId)
  if (current === null) return { outcome: 'absent', record: null }
  if (current.kind !== 'authorization' || current.topicId !== topicId) {
    return { outcome: 'absent', record: current }
  }
  if (current.status !== 'pending') {
    return { outcome: cardOutcomeOf(current, status), record: current }
  }
  const next = decide(current)
  if (next === null) return { outcome: 'absent', record: current }
  const written = await cardStore.updateUnlocked(requestId, (latest) => (
    latest.kind === 'authorization' && latest.topicId === topicId && latest.status === 'pending'
      ? next
      : null
  ))
  if (written === null) return { outcome: 'absent', record: null }
  if (written.status === status) return { outcome: 'settled', record: written }
  return { outcome: cardOutcomeOf(written, status), record: written }
}

/**
 * The one authorization decision core: permission, idempotent replay,
 * lock-scoped unlock and card settlement, `authorization-resolved` activity,
 * notice patch and the topic prompt. Both the legacy `authorization.resolve`
 * route and the inbox resolve route call this function; neither has an unlock
 * path of its own.
 *
 * The index and the card are written in one lock acquisition. If the card write
 * fails after the index write, the index is restored to the document the
 * mutator saw before the failure and the original error propagates. The residual
 * window — the restore write itself failing — is logged with the request id; it
 * can only be closed by an external repair, because both files are separate
 * atomic writes.
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
      cardSettled: 'absent',
      cardRecord: null,
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
  const status = decision === 'allow' ? 'allowed' : 'denied'
  const cardStore = input.requestCard ?? new RequestStore({ repoPath: input.repoPath, log: input.log })
  const decideCard = input.settleCard ?? ((current: RequestRecordV1, cardStatus: 'allowed' | 'denied') => ({
    ...applyResolution(current, { status: cardStatus, resolvedBy: 'user', now }),
    delivery: { promptedAt: null, lastError: null },
  }))
  let changed = false
  // The card outcome is assigned inside the lock callback; a holder keeps the
  // flow analysis from narrowing it back to the initial value after the await.
  const card: { settled: SettleAuthorizationOutcome; record: RequestRecordV1 | null } = {
    settled: 'absent',
    record: null,
  }
  let snapshot: ProjectIndexV2 | null = null

  /** Restore the index the mutator saw; a failed restore is the residual window. */
  const restoreIndex = async (): Promise<void> => {
    const target = snapshot
    if (target === null) return
    try {
      await store.mutateIndexDocumentUnlocked(() => target)
    } catch (restoreError) {
      input.log?.(
        `request ${requestId} authorization: index/card transaction failed and the index could not be `
          + `restored; residual state is "topic unlocked, card pending": ${messageOf(restoreError)}`,
      )
    }
  }

  /**
   * Whether a failed unlocked index write still reached the file. `writeJsonAtomic`
   * renames before the directory fsync, so a failure can follow a landed write.
   */
  const indexMayHaveLanded = async (): Promise<boolean> => {
    try {
      const current = await store.readIndexDocument()
      return current.topics.find((entry) => entry.topicId === topicId)?.authorization == null
    } catch {
      return true
    }
  }

  const document = await store.withWriteLock(async () => {
    let nextDocument: ProjectIndexV2
    try {
      nextDocument = await store.mutateIndexDocumentUnlocked((base) => {
        snapshot = base
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
    } catch (error) {
      // The mutation may have thrown before writing, or the write may have
      // landed and the directory fsync failed afterwards. Restore only when the
      // file actually shows the unlock; the caller sees the original error.
      if (changed && snapshot !== null && await indexMayHaveLanded()) await restoreIndex()
      throw error
    }
    if (!changed) return nextDocument
    try {
      const settled = await settleCardInLock(cardStore, requestId, topicId, status, (current) => decideCard(current, status))
      card.settled = settled.outcome
      card.record = settled.record
    } catch (error) {
      // The index is already on disk; take it back so a failed card write cannot
      // leave a decided topic behind a pending card.
      await restoreIndex()
      throw error
    }
    return nextDocument
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
      cardSettled: card.settled,
      cardRecord: card.record,
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
  // The card and the index were committed together; the inbox activity follows
  // both, so a replay of the same decision cannot write a second row.
  if (card.settled === 'settled' && card.record !== null) {
    try {
      await store.appendActivity(
        requestResolvedActivity(card.record, { action: decision === 'allow' ? 'allow' : 'deny' }, now),
      )
    } catch (error) {
      input.log?.(`request ${requestId} settled, activity not recorded: ${messageOf(error)}`)
    }
  }
  const current = document.topics.find((entry) => entry.topicId === topicId)
  if (current === undefined) {
    throw new PanelServiceError('internal', `topic disappeared from the index: ${topicId}`)
  }
  return {
    changed: true,
    prompted,
    promptError,
    promptText: input.deferPrompt === true ? promptText : null,
    cardSettled: card.settled,
    cardRecord: card.record,
    noticeId,
    document,
    topic: current,
    decision,
  }
}

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
  /** Card store override; defaults to a `RequestStore` for `repoPath`. */
  readonly requestCard?: RequestCardStorePort
  readonly log?: (message: string) => void
}

/**
 * Settle one request card on its own, without an index decision.
 *
 * The two routes commit their card inside
 * {@link resolveAuthorizationDecision}'s transaction; this entry remains for a
 * caller that only has a card to mirror (and for the regression tests that pin
 * the tolerant classification). Only a pending record is written; an
 * already-terminal record is never overwritten, so an inbox.resolve that
 * settled first keeps its own delivery facts and its one `request-resolved`
 * activity row.
 */
export async function settleAuthorizationRequestRecord(
  input: SettleAuthorizationRecordInput,
): Promise<SettleAuthorizationOutcome> {
  const cardStore = input.requestCard ?? new RequestStore({ repoPath: input.repoPath, log: input.log })
  const status = input.decision === 'allow' ? 'allowed' : 'denied'
  const settle = () => settleCardInLock(cardStore, input.requestId, input.topicId, status, (current) => {
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
  const { outcome, record } = cardStore.withWriteLock === undefined
    ? await settle()
    : await cardStore.withWriteLock(settle)
  if (outcome === 'settled' && record !== null) {
    try {
      await input.store.appendActivity(
        requestResolvedActivity(record, { action: input.decision === 'allow' ? 'allow' : 'deny' }, input.now),
      )
    } catch (error) {
      input.log?.(`request ${input.requestId} settled, activity not recorded: ${messageOf(error)}`)
    }
  }
  return outcome
}
