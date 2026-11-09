/**
 * Pure three-state topic lifecycle (PLAN-V0.2 §2.3/§5.1, M8.1).
 *
 * A topic is `active`, `idle` or `resolved`; `awaitingReview` and `blocked` are
 * flags, not states. Everything here is pure: no I/O, no clock read (the caller
 * injects `nowMs`), and the input topic is never mutated. The rules belong to
 * `.agents/notes/proposed/feature/2026-11-07-three-state-lifecycle.md`:
 *
 * - `idle` needs strictly more than `idleAfterMs` of silence and neither flag.
 * - `resolved` needs all six conditions; there is no undo. Reopening
 *   ({@link reopenResolvedTopic}) is a user action, not a reversal. A topic
 *   whose latest review asked for changes (`needs_revision`) is not resolvable:
 *   the topic still owes a fix and the review round is not finished.
 */
import type { TopicRecordV2 } from './store-schema.js'

/** How long an unflagged topic may sit without activity (2 hours). */
export const DEFAULT_IDLE_AFTER_MS = 2 * 60 * 60 * 1000
/** How long a resolvable topic waits before master resolves it (3 days). */
export const DEFAULT_RESOLVE_AFTER_MS = 3 * 24 * 60 * 60 * 1000

/** What the caller knows when it evaluates one topic. */
export interface TopicLifecycleContext {
  /** Injected clock, in epoch milliseconds. */
  nowMs: number
  /** Silence after which an unflagged topic is idle. */
  idleAfterMs: number
  /** Silence after which a resolvable topic is resolved. */
  resolveAfterMs: number
  /** Work items in `active` state; M8 always passes 0 (M10 owns real counts). */
  activeWorkItems: number
}

/** The lifecycle change an evaluation asks for; `none` means write nothing. */
export type TopicLifecycleChange =
  | { kind: 'none' }
  | { kind: 'idle' | 'active' | 'resolved'; topic: TopicRecordV2 }

/** The resolved-state conditions that do not depend on the clock. */
function isResolvable(topic: TopicRecordV2, activeWorkItems: number): boolean {
  return (
    !topic.awaitingReview &&
    !topic.blocked &&
    // A review that asked for changes means the round is not over; resolving
    // here would hide a pending fix and has no undo (review R1, M10.5 repair).
    topic.reviewStatus !== 'needs_revision' &&
    activeWorkItems === 0 &&
    topic.lastDeliveryConfirmedAt !== null &&
    topic.digest.trim() !== ''
  )
}

/**
 * Decide whether `topic` should change state at `context.nowMs`.
 *
 * Resolution is evaluated before idleness: a topic past both thresholds is
 * resolved. An `idle` topic with a flag (or fresh activity) returns to `active`;
 * an `active` one only goes `idle` when neither flag is set and the idle window
 * is strictly past (exactly at the threshold is not idle).
 */
export function evaluateTopicLifecycle(
  topic: TopicRecordV2,
  context: TopicLifecycleContext,
): TopicLifecycleChange {
  if (topic.status === 'resolved') return { kind: 'none' }
  const nowIso = new Date(context.nowMs).toISOString()
  const silentForMs = context.nowMs - Date.parse(topic.lastActiveAt)
  if (silentForMs >= context.resolveAfterMs && isResolvable(topic, context.activeWorkItems)) {
    return {
      kind: 'resolved',
      topic: { ...topic, status: 'resolved', resolvedAt: nowIso, resolvedBy: 'master', updatedAt: nowIso },
    }
  }
  if (topic.status === 'idle') {
    if (topic.awaitingReview || topic.blocked || silentForMs <= context.idleAfterMs) {
      return { kind: 'active', topic: { ...topic, status: 'active', updatedAt: nowIso } }
    }
    return { kind: 'none' }
  }
  if (topic.status === 'active' && !topic.awaitingReview && !topic.blocked && silentForMs > context.idleAfterMs) {
    return { kind: 'idle', topic: { ...topic, status: 'idle', updatedAt: nowIso } }
  }
  return { kind: 'none' }
}

/**
 * Stamp new activity: an active topic stays active, an idle one returns to
 * `active`, and a resolved one is returned untouched — reopening is the
 * caller's explicit choice ({@link reopenResolvedTopic}), never a side effect
 * of a message.
 */
export function noteTopicActivity(topic: TopicRecordV2, nowMs: number): TopicRecordV2 {
  if (topic.status === 'resolved') return topic
  const nowIso = new Date(nowMs).toISOString()
  return { ...topic, status: 'active', lastActiveAt: nowIso, updatedAt: nowIso }
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
    lastActiveAt: nowIso,
    updatedAt: nowIso,
  }
}
