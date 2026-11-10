/**
 * Pure three-state topic lifecycle (PLAN-V0.2 §2.3/§5.1, M8.1; revised for the
 * topic page 2026-11-10).
 *
 * A topic is `active`, `idle` or `resolved`; `awaitingReview` and `blocked` are
 * flags, not states. Everything here is pure: no I/O, no clock read (the caller
 * injects `nowMs`), and the input topic is never mutated.
 *
 * The frozen topic-page rules this module owns:
 *
 * - `idle` needs strictly more than `idleAfterMs` (24 h) of silence and no flag;
 *   a blocked topic, or one with a pending authorization, never falls idle.
 * - There is no automatic `resolved`: archiving is a user action
 *   ({@link archiveTopicRecord}). A resolved topic never changes through
 *   evaluation or new activity, and reopening ({@link reopenResolvedTopic}) is a
 *   user action, not an undo.
 * - Blocking records the status to restore ({@link blockTopic}), and releasing
 *   the block restores it ({@link unblockTopic}).
 */
import type { BlockedReason, TopicRecordV2 } from './store-schema.js'

/** How long an unflagged topic may sit without activity (24 hours). */
export const DEFAULT_IDLE_AFTER_MS = 24 * 60 * 60 * 1000
/**
 * Deprecated: kept only so a configuration written for the old auto-resolve
 * rule still validates. The lifecycle never reads it and never resolves a topic
 * on its own; archiving goes through the topic menu / tool.
 */
export const DEFAULT_RESOLVE_AFTER_MS = 3 * 24 * 60 * 60 * 1000

/** What the caller knows when it evaluates one topic. */
export interface TopicLifecycleContext {
  /** Injected clock, in epoch milliseconds. */
  nowMs: number
  /** Silence after which an unflagged topic is idle. */
  idleAfterMs: number
  /** Deprecated and ignored: the lifecycle has no resolve threshold. */
  resolveAfterMs?: number
  /** Kept for the read point's signature; resolution is not automatic any more. */
  activeWorkItems?: number
}

/** The lifecycle change an evaluation asks for; `none` means write nothing. */
export type TopicLifecycleChange =
  | { kind: 'none' }
  | { kind: 'idle' | 'active'; topic: TopicRecordV2 }

/** Whether the topic carries a marker that suppresses (or reverses) idleness. */
function isMarked(topic: TopicRecordV2): boolean {
  return topic.awaitingReview || topic.blocked || topic.authorization !== null
}

/**
 * Decide whether `topic` should change state at `context.nowMs`.
 *
 * Only idle/active migration is automatic now: an `active` topic goes `idle`
 * when it carries no marker and the idle window is strictly past (exactly at
 * the threshold is not idle), and an `idle` topic returns to `active` when it is
 * marked or fresh activity arrived. A blocked topic never becomes idle, and a
 * resolved topic never changes here.
 */
export function evaluateTopicLifecycle(
  topic: TopicRecordV2,
  context: TopicLifecycleContext,
): TopicLifecycleChange {
  if (topic.status === 'resolved') return { kind: 'none' }
  const nowIso = new Date(context.nowMs).toISOString()
  const silentForMs = context.nowMs - Date.parse(topic.lastActiveAt)
  if (topic.status === 'idle') {
    if (isMarked(topic) || silentForMs <= context.idleAfterMs) {
      return { kind: 'active', topic: { ...topic, status: 'active', updatedAt: nowIso } }
    }
    return { kind: 'none' }
  }
  if (topic.status === 'active' && !isMarked(topic) && silentForMs > context.idleAfterMs) {
    return { kind: 'idle', topic: { ...topic, status: 'idle', updatedAt: nowIso } }
  }
  return { kind: 'none' }
}

/**
 * Stamp new activity: an active topic stays active, an idle one returns to
 * `active`, and a resolved one is returned untouched — reopening is the
 * caller's explicit choice ({@link reopenResolvedTopic}), never a side effect
 * of a message. A blocked topic also returns to `active` (the block itself
 * decides the group), but keeps its reason and the status it will restore.
 */
export function noteTopicActivity(topic: TopicRecordV2, nowMs: number): TopicRecordV2 {
  if (topic.status === 'resolved') return topic
  const nowIso = new Date(nowMs).toISOString()
  return { ...topic, status: 'active', lastActiveAt: nowIso, updatedAt: nowIso }
}

/**
 * Block `topic` for `reason` at `nowMs`.
 *
 * The first block records the status to restore (`blockedFromStatus`) and the
 * block time; a second block keeps both, because the status the user is coming
 * back to is the one from before the whole blocked period. A blocked topic is
 * `active` in the lifecycle (the group comes from the flag) and its activity
 * time moves, which is what keeps the idle rule from firing under the block.
 * A resolved topic is returned untouched: archiving is not blockable.
 */
export function blockTopic(
  topic: TopicRecordV2,
  reason: BlockedReason,
  nowMs: number,
): TopicRecordV2 {
  if (topic.status === 'resolved') return topic
  const nowIso = new Date(nowMs).toISOString()
  const blockedFromStatus = topic.blockedFromStatus ?? (
    topic.status === 'idle' ? 'idle' : 'active'
  )
  return {
    ...topic,
    status: 'active',
    blocked: true,
    blockedReason: reason,
    blockedFromStatus,
    blockedAt: topic.blockedAt ?? nowIso,
    lastActiveAt: nowIso,
    updatedAt: nowIso,
  }
}

/**
 * Release a block: clear the reason, the recorded status, and the pending
 * authorization, and restore the status the block interrupted (falling back to
 * the current status for a topic that was never blocked). Activity is not
 * re-stamped: releasing a block is not a report from the topic.
 */
export function unblockTopic(topic: TopicRecordV2, nowMs: number): TopicRecordV2 {
  if (!topic.blocked && topic.blockedReason === null && topic.authorization === null) return topic
  const nowIso = new Date(nowMs).toISOString()
  const restore = topic.blockedFromStatus
  return {
    ...topic,
    status: topic.status === 'resolved' || restore === null ? topic.status : restore,
    blocked: false,
    blockedReason: null,
    blockedFromStatus: null,
    blockedAt: null,
    authorization: null,
    updatedAt: nowIso,
  }
}

/**
 * Archive a topic by user decision: resolved, with the block and any pending
 * authorization cleared. `resolvedBy` is the user (menu / tool); the master
 * never archives on its own. Re-archiving a resolved topic is a no-op that
 * returns the record untouched, so the caller can stay idempotent.
 */
export function archiveTopicRecord(
  topic: TopicRecordV2,
  nowMs: number,
  by: 'user' | 'master' = 'user',
): TopicRecordV2 {
  if (topic.status === 'resolved') return topic
  const nowIso = new Date(nowMs).toISOString()
  return {
    ...topic,
    status: 'resolved',
    resolvedAt: nowIso,
    resolvedBy: by,
    blocked: false,
    blockedReason: null,
    blockedFromStatus: null,
    blockedAt: null,
    authorization: null,
    updatedAt: nowIso,
  }
}

/**
 * Reopen a resolved topic because its owner returned to it. Not an undo: the
 * resolution fields are cleared, the new activity is stamped, and the summary
 * plus delivery proof stay. A topic that is not resolved returns `null` so the
 * caller never invents a transition.
 */
export function reopenResolvedTopic(topic: TopicRecordV2, nowMs: number): TopicRecordV2 | null {
  if (topic.status !== 'resolved') return null
  const nowIso = new Date(nowMs).toISOString()
  return {
    ...topic,
    status: 'active',
    resolvedAt: null,
    resolvedBy: null,
    blocked: false,
    blockedReason: null,
    blockedFromStatus: null,
    blockedAt: null,
    authorization: null,
    lastActiveAt: nowIso,
    updatedAt: nowIso,
  }
}
