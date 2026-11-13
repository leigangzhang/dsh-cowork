/**
 * Pure three-layer routing core (PLAN-V0.2 §5.3, M9.1).
 *
 * This module replaces the keyword-only model of `src/router.ts` (which stays
 * until `src/tools.ts` switches its call site in M9.3b). It owns the decision
 * rules, not the side effects: no I/O, no clock read and no randomness. The
 * caller injects `context.nowMs`, so a decision is reproducible from its
 * inputs alone.
 *
 * The three layers:
 *
 * 1. Locality: an explicit `topicId` is handled by {@link decideExplicitRoute};
 *    otherwise `focusTopicId`, then `lastRouteTopicId`, is reused directly when
 *    it is still `active`/`idle` and the intent carries no new-topic signal.
 * 2. Structured match: every non-`resolved` topic is scored against the
 *    intent's title/scope/ownedPaths/aliases/digest tokens; each candidate
 *    carries the reasons that produced its score.
 * 3. Model fallback (M9.2) only receives the 1–3 candidates that layer 2 could
 *    not separate; this module never calls a model itself.
 *
 * `resolved` topics never enter the automatic candidates. Renaming intent
 * tokens into aliases ({@link applyRouteCorrection}) and automatic titles
 * ({@link routeCreateTitle}) are pure too, so the write path can call them
 * inside the project lock without re-reading anything.
 */
import type { ProjectIndexV2, TopicRecordV2 } from './store-schema.js';
/** A candidate must reach this score before it can be reused. */
export declare const ROUTE_THRESHOLD = 4;
/** The top candidate must lead the runner-up by this much to be reused. */
export declare const ROUTE_MARGIN = 1;
/** At most this many candidates are handed to the model layer. */
export declare const ROUTE_MAX_CANDIDATES = 3;
/** Automatic titles keep this many Unicode code points. */
export declare const TOPIC_TITLE_MAX_CHARS = 24;
/** A topic keeps at most this many aliases. */
export declare const ALIAS_MAX_ITEMS = 50;
/** One alias longer than this is not a routing token. */
export declare const ALIAS_MAX_LENGTH = 32;
/**
 * Intents that ask for a new topic. The first layer never reuses a focus or a
 * previous route when one of these phrases is present (PLAN §5.3).
 */
export declare const ROUTE_NEW_TOPIC_SIGNALS: readonly ["新开一个", "新开", "新建", "换个主题", "换个模块", "另一个主题", "另开一个", "新主题"];
/** What a routing decision asks the caller to do. */
export type RouteAction = 'reuse' | 'create' | 'needs_model' | 'resolved_match';
/** One scored topic plus the reasons that produced its score. */
export interface RouteCandidate {
    topicId: string;
    title: string;
    score: number;
    reasons: string[];
}
/** What the caller knows when it routes one intent. */
export interface RouteContext {
    /** Injected clock, in epoch milliseconds; only recency reads it. */
    nowMs: number;
    /** Topic the user currently has open, or null (PLAN §5.3 layer 1). */
    focusTopicId: string | null;
    /** Topic the previous route picked, or null (PLAN §5.3 layer 1). */
    lastRouteTopicId: string | null;
}
/** The outcome of one routing decision. */
export interface RouteDecision {
    action: RouteAction;
    /** Set for `reuse`; the topic to continue. */
    topicId?: string;
    /** Set for `resolved_match`; the resolved topic the intent named. */
    resolvedMatch?: {
        topicId: string;
        title: string;
    };
    /** Human-readable explanation; always names the layer that decided. */
    reason: string;
    /** Scored topics, bounded for `needs_model`; empty when nothing matched. */
    candidates: RouteCandidate[];
}
/** Where routing targets live on the v2 document envelope. */
export interface RouteTargets {
    /** Written to `masterFocusTopicId`; the panel owns this one (M11). */
    focusTopicId?: string | null;
    /** Written to `lastRouteTopicId`; the route tool owns this one (M9.3b). */
    lastRouteTopicId?: string | null;
}
/**
 * Split text into comparable tokens: lowercase ASCII words plus adjacent
 * two-character bigrams for CJK runs (a one-character run stays itself, since
 * it has no neighbour). Duplicates are dropped and first-seen order kept, so
 * the output is deterministic and cheap to assert on.
 */
export declare function tokenize(text: string): string[];
/**
 * Route one intent onto an existing or new topic.
 *
 * Layer 1 reuses the focus topic, then the previous route target, unless the
 * intent asks for a new topic; a `resolved` or unknown target is skipped and
 * layer 2 decides. Layer 2 ranks the remaining topics; a clear winner is
 * reused, a score below {@link ROUTE_THRESHOLD} creates a new topic, and
 * anything in between asks the model layer with at most
 * {@link ROUTE_MAX_CANDIDATES} candidates.
 */
export declare function decideRoute(intent: string, topics: readonly TopicRecordV2[], context: RouteContext): RouteDecision;
/**
 * Handle the explicit `topicId` form of `cowork_route`.
 *
 * `null` means the id names no topic (the caller reports an explicit error).
 * A `resolved` topic is reported as `resolved_match` so the caller creates a
 * new topic instead of messaging a finished one. Anything else is reused; an
 * explicit id bypasses both scoring and the new-topic signals.
 */
export declare function decideExplicitRoute(topicId: string, topics: readonly TopicRecordV2[]): RouteDecision | null;
/**
 * Learn from a misroute: append the intent tokens to the topic's aliases.
 *
 * Only `aliases` changes — the status, timestamps and every other field are
 * copied unchanged. Tokens are deduplicated (against existing aliases too),
 * bounded in length ({@link ALIAS_MAX_LENGTH}), added at most
 * {@link MAX_NEW_ALIASES_PER_CORRECTION} at a time, and the list never grows
 * past {@link ALIAS_MAX_ITEMS}. A correction that adds nothing returns the
 * topic itself.
 */
export declare function applyRouteCorrection(topic: TopicRecordV2, intent: string): TopicRecordV2;
/**
 * The automatic title of a new topic: all whitespace folded to one space,
 * trimmed, and cut to {@link TOPIC_TITLE_MAX_CHARS} Unicode code points so an
 * emoji is never split in half. An empty intent has a fixed fallback.
 */
export declare function routeCreateTitle(intent: string): string;
/**
 * Return a copy of the v2 document with the given routing targets changed.
 *
 * `undefined` leaves a target as it was, `null` clears it, and a string sets
 * it; an empty/whitespace string or a non-string throws. The rest of the
 * document envelope (`projectId`, `masterSessionId`, unknown fields, …) is
 * copied untouched, so `mutateIndexDocument` sees a complete document.
 */
export declare function withRouteTargets(document: ProjectIndexV2, targets: RouteTargets): ProjectIndexV2;
