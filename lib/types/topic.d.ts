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
import type { BlockedReason, TopicRecordV2 } from './store-schema.js';
/** How long an unflagged topic may sit without activity (24 hours). */
export declare const DEFAULT_IDLE_AFTER_MS: number;
/**
 * Deprecated: kept only so a configuration written for the old auto-resolve
 * rule still validates. The lifecycle never reads it and never resolves a topic
 * on its own; archiving goes through the topic menu / tool.
 */
export declare const DEFAULT_RESOLVE_AFTER_MS: number;
/** What the caller knows when it evaluates one topic. */
export interface TopicLifecycleContext {
    /** Injected clock, in epoch milliseconds. */
    nowMs: number;
    /** Silence after which an unflagged topic is idle. */
    idleAfterMs: number;
    /** Deprecated and ignored: the lifecycle has no resolve threshold. */
    resolveAfterMs?: number;
    /** Kept for the read point's signature; resolution is not automatic any more. */
    activeWorkItems?: number;
}
/** The lifecycle change an evaluation asks for; `none` means write nothing. */
export type TopicLifecycleChange = {
    kind: 'none';
} | {
    kind: 'idle' | 'active';
    topic: TopicRecordV2;
};
/**
 * Decide whether `topic` should change state at `context.nowMs`.
 *
 * Only idle/active migration is automatic now: an `active` topic goes `idle`
 * when it carries no marker and the idle window is strictly past (exactly at
 * the threshold is not idle), and an `idle` topic returns to `active` when it is
 * marked or fresh activity arrived. A blocked topic never becomes idle, and a
 * resolved topic never changes here.
 */
export declare function evaluateTopicLifecycle(topic: TopicRecordV2, context: TopicLifecycleContext): TopicLifecycleChange;
/**
 * Stamp new activity: an active topic stays active, an idle one returns to
 * `active`, and a resolved one is returned untouched — reopening is the
 * caller's explicit choice ({@link reopenResolvedTopic}), never a side effect
 * of a message. A blocked topic also returns to `active` (the block itself
 * decides the group), but keeps its reason and the status it will restore.
 */
export declare function noteTopicActivity(topic: TopicRecordV2, nowMs: number): TopicRecordV2;
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
export declare function blockTopic(topic: TopicRecordV2, reason: BlockedReason, nowMs: number): TopicRecordV2;
/**
 * Release a block: clear the reason, the recorded status, and the pending
 * authorization, and restore the status the block interrupted (falling back to
 * the current status for a topic that was never blocked). Activity is not
 * re-stamped: releasing a block is not a report from the topic.
 */
export declare function unblockTopic(topic: TopicRecordV2, nowMs: number): TopicRecordV2;
/**
 * Archive a topic by user decision: resolved, with the block and any pending
 * authorization cleared. `resolvedBy` is the user (menu / tool); the master
 * never archives on its own. Re-archiving a resolved topic is a no-op that
 * returns the record untouched, so the caller can stay idempotent.
 */
export declare function archiveTopicRecord(topic: TopicRecordV2, nowMs: number, by?: 'user' | 'master'): TopicRecordV2;
/**
 * Reopen a resolved topic because its owner returned to it. Not an undo: the
 * resolution fields are cleared, the new activity is stamped, and the summary
 * plus delivery proof stay. A topic that is not resolved returns `null` so the
 * caller never invents a transition.
 */
export declare function reopenResolvedTopic(topic: TopicRecordV2, nowMs: number): TopicRecordV2 | null;
