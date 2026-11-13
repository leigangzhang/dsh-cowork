/**
 * Host `llm` adapter for the routing model port (M9.2/M9.3b).
 *
 * The routing model module owns the guards, timeout, prompt budget, and reply
 * schema; this module is the thin host boundary it calls through
 * {@link LlmRoutingPort}. It lives outside `src/index.ts` so the exact request
 * shape can be unit-tested with a fake service and no host import.
 *
 * The shape is the one `@deepseek-ai/dsh-llm`'s `GenerateOptions` documents:
 * the system prompt is the top-level `system` string, and the user turn is one
 * `{role:'user', content:[{type:'text', text}]}` message. A plain string body
 * or a system-role message would be rejected by the real adapter, which is why
 * M9.3b's inline version failed in a real host.
 */
import type { LlmRoutingPort, RoutingModelRequest } from './router-model.js';
/** The host `llm` slice this adapter needs; the real service satisfies it structurally. */
export interface HostLlmLike {
    prepareCall(config: Record<string, unknown>, signal?: AbortSignal): Promise<{
        /** Detached call config; the stream request must repeat its fields. */
        config: Record<string, unknown>;
        stream(options: Record<string, unknown>): AsyncIterable<unknown>;
    }>;
}
/**
 * Build the `GenerateOptions`-shaped stream request for one routing call.
 *
 * The prepared config may carry adapter-materialized defaults (for example a
 * reasoning effort); it is spread first so nothing is lost, then the request's
 * own provider/model/maxTokens/reasoningEffort are authoritative. The system
 * prompt is top-level and the single user turn carries a text block, matching
 * the host's `RequestMessage` content shape.
 */
export declare function buildRoutingStreamOptions(request: RoutingModelRequest, preparedConfig: Record<string, unknown>, signal: AbortSignal): Record<string, unknown>;
/**
 * Wrap the host `llm` service as a routing port.
 *
 * Returns `undefined` when the service is absent or unusable; the model layer
 * then reports `unavailable` and the route falls back to the structured
 * candidates. A `prepareCall`/`stream` failure propagates to
 * `recommendWithModel`, which converts it into a bounded `modelError`; this
 * adapter never invents a decision.
 */
export declare function createLlmRoutingPort(llm: HostLlmLike | undefined | null): LlmRoutingPort | undefined;
