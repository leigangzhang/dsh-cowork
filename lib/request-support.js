/** A failure the panel routes answer with a stable code and status. */
export class PanelServiceError extends Error {
    code;
    path;
    constructor(code, message, path) {
        super(message);
        this.name = 'PanelServiceError';
        this.code = code;
        this.path = path;
    }
}
/** A message for one failure, without carrying a stack into a report. */
export function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Cut text to at most `limit` Unicode code points without splitting a pair. */
export function clipText(text, limit) {
    const points = Array.from(text);
    return points.length <= limit ? text : points.slice(0, limit).join('');
}
/**
 * Refuse a caller that is neither the project master nor the owning topic. A
 * row without a topic (an activity notice that carries none) is master-only,
 * because no topic session can own it.
 */
export function assertMember(document, sessionId, topicId) {
    if (sessionId === document.masterSessionId)
        return;
    if (topicId !== null && sessionId === topicId)
        return;
    throw new PanelServiceError('inbox/not-member', `session ${sessionId} may not act on a request of ${topicId === null ? 'no topic' : `topic ${topicId}`}`);
}
//# sourceMappingURL=request-support.js.map