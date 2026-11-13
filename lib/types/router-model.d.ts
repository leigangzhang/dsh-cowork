/**
 * Model-backed fallback for the third routing layer (M9.2).
 *
 * The structured router (src/routing.ts) hands over 1–3 candidates and asks the
 * model to pick one (or none). This module is the *only* place the plugin asks
 * an LLM to make a routing decision, and it owns no host code: the host wires
 * its `llm` service through {@link LlmRoutingPort} in src/index.ts. That keeps
 * the guard rails (disabled / unconfigured / unavailable), the prompt budget,
 * the timeout, and the reply schema testable with a fake port and no network.
 *
 * Every failure path returns {@link ModelOutcome} with `action: 'fallback'`:
 * the caller reuses the highest structured candidate (the first element of the
 * candidate list, which M9.1 emits in descending score order) or creates a new
 * topic. This module never throws and never asks the user to choose.
 */
/** Default per-call output budget from PLAN-V0.2 §5.10. */
export declare const DEFAULT_ROUTING_MAX_TOKENS = 256;
/** Default wall-clock budget from PLAN-V0.2 §5.10. */
export declare const DEFAULT_ROUTING_TIMEOUT_MS = 2000;
/**
 * Reasoning is off by default. M6 probe 1 proved `'off'` is the adapter's
 * lowest effort and maps to `thinking.type="disabled"` with no `output_config`
 * (docs/M6_PROBE_RESULT.md §1), which is what a 256-token routing call wants.
 */
export declare const DEFAULT_REASONING_EFFORT = "off";
/** Hard cap for the serialized intent plus candidates. */
export declare const ROUTING_MODEL_PROMPT_MAX_CHARS = 2000;
/** Hard cap for the bounded `modelError` string on fallback. */
export declare const ROUTING_MODEL_ERROR_MAX_CHARS = 200;
/** One request to the host LLM service; `run` returns the model's text. */
export interface RoutingModelRequest {
    provider: string;
    model: string;
    maxTokens: number;
    /** `'off'` unless the configuration names a higher effort explicitly. */
    reasoningEffort: string;
    timeoutMs: number;
    systemPrompt: string;
    userPrompt: string;
}
/**
 * The minimal slice of the host `llm` service this module needs. `signal`
 * aborts at `timeoutMs`; an implementation may reject with the signal reason
 * or simply stop, in which case the race in {@link recommendWithModel} wins.
 */
export interface LlmRoutingPort {
    run(request: RoutingModelRequest, signal: AbortSignal): Promise<string>;
}
/**
 * Routing model configuration (PLAN-V0.2 §5.10): `effort` empty means the
 * default `'off'`; `timeoutMs`/`maxTokens` non-positive fall back to the
 * documented defaults rather than failing the route.
 */
export interface RoutingModelConfig {
    enabled: boolean;
    provider: string;
    model: string;
    effort: string;
    timeoutMs: number;
    maxTokens: number;
}
/** One structured candidate, already scored and ordered by src/routing.ts. */
export interface ModelCandidate {
    topicId: string;
    title: string;
    scope: string;
    digest: string;
}
/** Model chose an existing candidate. */
export interface RoutingModelReuseOutcome {
    readonly action: 'reuse';
    readonly topicId: string;
    readonly confidence: number;
    readonly modelUsed: true;
}
/** Model chose a new topic (`topicId: null`). */
export interface RoutingModelCreateOutcome {
    readonly action: 'create';
    readonly topicId: null;
    readonly confidence: number;
    readonly modelUsed: true;
}
/**
 * No model decision: the caller reuses the highest structured candidate
 * (`topicId` non-null) or creates a topic (`topicId: null`). `modelError` is a
 * bounded, human-readable reason (`<code>: <detail>`), never a stack trace.
 */
export interface RoutingModelFallbackOutcome {
    readonly action: 'fallback';
    readonly topicId: string | null;
    readonly confidence: null;
    readonly modelError: string;
    readonly modelUsed: false;
}
export type ModelOutcome = RoutingModelReuseOutcome | RoutingModelCreateOutcome | RoutingModelFallbackOutcome;
/** Input of {@link recommendWithModel}. */
export interface RecommendWithModelInput {
    intent: string;
    /** Ordered by score, highest first; 0–3 items in practice. */
    candidates: readonly ModelCandidate[];
    config: RoutingModelConfig;
    port?: LlmRoutingPort;
}
/** Stable failure codes; the route activity stores them inside `modelError`. */
export type RoutingModelErrorCode = 'disabled' | 'unconfigured' | 'unavailable' | 'timeout' | 'port-error' | 'bad-json' | 'invalid-reply' | 'topic-not-candidate' | 'confidence-out-of-range';
/**
 * Serialize the intent and candidates into the user prompt.
 *
 * Deterministic by construction: the intent keeps up to 700 characters, each
 * candidate keeps up to 3 (the structured layer's own cap), and the per-line
 * budget is `(2000 - header - line separators) / count`, so the result never
 * exceeds {@link ROUTING_MODEL_PROMPT_MAX_CHARS}. The final truncate is a
 * belt-and-braces bound; oversized inputs shrink `scope`/`digest` first.
 */
export declare function buildRoutingUserPrompt(intent: string, candidates: readonly ModelCandidate[]): string;
/**
 * Ask the model to choose between structured candidates, never throwing.
 *
 * Guards run before any port call: disabled configuration, a missing
 * provider/model, and an unwired port all return `fallback` and leave the port
 * untouched. A valid reply yields `reuse` (a candidate id) or `create` (null);
 * every other outcome — bad JSON, wrong types, an unknown topic, an
 * out-of-range confidence, a timeout, or a port error — returns `fallback`
 * with the highest structured candidate as the reuse target.
 */
export declare function recommendWithModel(input: RecommendWithModelInput): Promise<ModelOutcome>;
