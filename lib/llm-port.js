/** Narrow one unknown stream chunk to the fields read here. */
function asChunk(value) {
    return typeof value === 'object' && value !== null ? value : {};
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
export function buildRoutingStreamOptions(request, preparedConfig, signal) {
    return {
        ...preparedConfig,
        provider: request.provider,
        model: request.model,
        maxTokens: request.maxTokens,
        reasoningEffort: request.reasoningEffort,
        system: request.systemPrompt,
        messages: [{ role: 'user', content: [{ type: 'text', text: request.userPrompt }] }],
        signal,
    };
}
/**
 * Wrap the host `llm` service as a routing port.
 *
 * Returns `undefined` when the service is absent or unusable; the model layer
 * then reports `unavailable` and the route falls back to the structured
 * candidates. A `prepareCall`/`stream` failure propagates to
 * `recommendWithModel`, which converts it into a bounded `modelError`; this
 * adapter never invents a decision.
 */
export function createLlmRoutingPort(llm) {
    if (llm === undefined || llm === null || typeof llm.prepareCall !== 'function')
        return undefined;
    return {
        async run(request, signal) {
            const prepared = await llm.prepareCall({
                provider: request.provider,
                model: request.model,
                maxTokens: request.maxTokens,
                reasoningEffort: request.reasoningEffort,
            }, signal);
            let text = '';
            const chunks = prepared.stream(buildRoutingStreamOptions(request, prepared.config, signal));
            for await (const raw of chunks) {
                const chunk = asChunk(raw);
                if (chunk.type === 'text-delta' && typeof chunk.text === 'string')
                    text += chunk.text;
                if (chunk.type === 'finish') {
                    const kind = chunk.reason?.kind;
                    if (kind === 'error' || kind === 'aborted') {
                        const detail = chunk.reason?.failure?.message;
                        throw new Error(typeof detail === 'string' && detail !== ''
                            ? detail
                            : `model call finished with ${String(kind)}`);
                    }
                }
            }
            return text;
        },
    };
}
//# sourceMappingURL=llm-port.js.map