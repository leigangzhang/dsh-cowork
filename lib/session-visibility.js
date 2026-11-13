/**
 * Reviewer session lifecycle (M10.3): create one reviewer per review request,
 * archive it after the verdict, and list the reviewer ids the panel filters out.
 *
 * The M6 probe (§4) is the reason this is a module instead of two inline calls:
 * archiving a reviewer *before* its verdict ends the turn as `blocked`, so the
 * only supported reclaim point is after-verdict. Creation fails closed on the
 * preset: a session that did not mount `cowork-reviewer` has the wrong tool
 * surface and must not be recorded as a reviewer. Topics are never archived or
 * hidden here — they stay visible and resumable (2026-11-07 decision (b)).
 *
 * Host-free: the caller injects the session slice ports, so the rules are
 * unit-testable without a running DSH host.
 */
import { REVIEWER_PRESET_ID } from './presets.js';
/** A caller that asks for a non-reviewer preset; a programmer error. */
export class ReviewerPresetError extends Error {
    constructor(presetId) {
        super(`a reviewer session must mount ${JSON.stringify(REVIEWER_PRESET_ID)}; `
            + `refusing to create one with ${JSON.stringify(presetId)}`);
        this.name = 'ReviewerPresetError';
    }
}
/**
 * Create one reviewer session and return its identity. The preset is checked
 * here *and* by the session slice (which fails closed when the host does not
 * report the requested preset); both checks run before any review state exists.
 */
export async function createReviewerSession(ports, input) {
    const presetId = input.presetId ?? REVIEWER_PRESET_ID;
    if (presetId !== REVIEWER_PRESET_ID)
        throw new ReviewerPresetError(presetId);
    if (typeof input.repoPath !== 'string' || input.repoPath.trim() === '') {
        throw new Error('a reviewer session needs the project repository path');
    }
    const created = await ports.createReviewSession({
        repoPath: input.repoPath,
        subject: input.subject,
        presetId,
    });
    if (typeof created.sessionId !== 'string' || created.sessionId.trim() === '') {
        throw new Error('the host returned no reviewer session id');
    }
    return created;
}
/** Bound of a recorded archive error, in characters. */
const ARCHIVE_ERROR_MAX_CHARS = 500;
/**
 * Archive the reviewer after its verdict. `stopActivity: true` lets the host
 * stop a still-running reviewer instead of refusing the archive. A failure is
 * returned, never thrown: the verdict is already persisted, so archiving must
 * not turn it into a failed review (the session stays for a later attempt).
 */
export async function archiveReviewerAfterVerdict(ports, sessionId) {
    try {
        await ports.archiveSession(sessionId, { stopActivity: true });
        return { archived: true, error: null };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { archived: false, error: message.slice(0, ARCHIVE_ERROR_MAX_CHARS) };
    }
}
/**
 * The reviewer sessions the project index still records, deduplicated and in
 * topic order. The panel filters these session ids out of the topic list; live
 * reviewers in the host sidebar are an accepted M10 limit (M11 filters them).
 */
export function reviewerSessionIds(document) {
    const seen = new Set();
    for (const topic of document?.topics ?? []) {
        const id = topic.reviewerSessionId;
        if (typeof id === 'string' && id.trim() !== '')
            seen.add(id);
    }
    return [...seen];
}
//# sourceMappingURL=session-visibility.js.map