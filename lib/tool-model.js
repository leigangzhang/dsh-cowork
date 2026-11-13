/**
 * Pure tool-model helpers for the `cowork_*` tools: the caller identity, the
 * role gate, the shared result envelope, the topic brief, and the route
 * payload mapping.
 *
 * Nothing here touches the host: no imports, no I/O, no clock. The tool layer
 * (src/tools.ts) feeds these helpers the structured `exec` identity and the
 * project index, which keeps every gate unit-testable without a running host.
 */
/** Stable error codes returned to the model. */
export const ERROR_CODES = {
    agentUnavailable: 'exec/agent-unavailable',
    roleForbidden: 'role/forbidden',
    projectNotInitialized: 'project/not-initialized',
    handoffInvalid: 'handoff/invalid',
    intentRequired: 'route/intent-required',
    sessionMissing: 'thread/session-missing',
    storeCorrupt: 'store/corrupt',
    memoryInvalid: 'memory/invalid',
    memoryWriteFailed: 'memory/write-failed',
    threadNotFound: 'thread/not-found',
    checkoutNotFound: 'checkout/not-found',
    checkoutAlreadyExists: 'checkout/already-exists',
    checkoutCreateFailed: 'checkout/create-failed',
    checkoutInvalidBaseRef: 'checkout/invalid-base-ref',
    checkoutPathGuard: 'checkout/path-guard',
    checkoutDirty: 'checkout/dirty',
    checkoutMergeConflict: 'checkout/merge-conflict',
    checkoutMergeFailed: 'checkout/merge-failed',
    checkoutGitFailed: 'checkout/git-failed',
    checkoutNotReady: 'checkout/not-ready',
    reviewNotReady: 'review/not-ready',
    reviewAlreadyPending: 'review/already-pending',
    reviewNotReviewer: 'review/not-reviewer',
    reviewSelfReview: 'review/self-review',
    reviewVerdictInvalid: 'review/verdict-invalid',
    reviewNotPassed: 'review/not-passed',
    reviewOverrideReasonRequired: 'review/override-reason-required',
    reviewSessionFailed: 'review/session-failed',
    reviewPromptFailed: 'review/prompt-failed',
    reviewWriteFailed: 'review/write-failed',
};
/**
 * Wire codes introduced by the M9.3b topic/route tools. Kept separate from the
 * long-stable {@link ERROR_CODES} table so adding a new tool family does not
 * rewrite the pinned compatibility list.
 */
export const TOPIC_ERROR_CODES = {
    routeBriefTooLong: 'route/brief-too-long',
    routeArgsConflict: 'route/args-conflict',
    topicNotFound: 'topic/not-found',
    topicTitleRequired: 'topic/title-required',
    topicInvalidOwnedPaths: 'topic/invalid-owned-paths',
};
/**
 * Wire codes introduced by M10 (review requests, work items, serial merge).
 * Every M10 module returns one of these; the table is the one home for them,
 * for the same reason {@link TOPIC_ERROR_CODES} is separate from the pinned
 * {@link ERROR_CODES} list. Added once in M10.1 — later M10 stages must not
 * need to touch this table again.
 */
export const M10_ERROR_CODES = {
    reviewRequestInvalid: 'review/request-invalid',
    reviewPathOutside: 'review/path-outside',
    reviewBaseNotAncestor: 'review/base-not-ancestor',
    reviewBaseEqualsHead: 'review/base-equals-head',
    reviewDirtyWorktree: 'review/dirty-worktree',
    reviewEmptyDiff: 'review/empty-diff',
    reviewChangedPathsMismatch: 'review/changed-paths-mismatch',
    reviewRequestNotFound: 'review/request-not-found',
    reviewNotPending: 'review/not-pending',
    reviewAlreadyReviewed: 'review/already-reviewed',
    reviewPreviousInvalid: 'review/previous-invalid',
    workItemNotFound: 'workitem/not-found',
    workItemAlreadyExists: 'workitem/already-exists',
    workItemProviderUnsupported: 'workitem/provider-unsupported',
    workItemCreateFailed: 'workitem/create-failed',
    workItemCleanupFailed: 'workitem/cleanup-failed',
    workItemNotReady: 'workitem/not-ready',
    checkoutProtectedBranch: 'checkout/protected-branch',
    checkoutHeadMismatch: 'checkout/head-mismatch',
};
/** Build a failure envelope. */
export function failure(code, message, details) {
    const error = { code, message };
    if (details !== undefined)
        error.details = details;
    return { ok: false, error };
}
/** Build a success envelope: the payload plus the `ok: true` discriminant. */
export function success(payload) {
    return { ok: true, ...payload };
}
/**
 * Read the caller from `exec.agent`. Both the session id and the session
 * header's cwd must be non-empty strings; anything else returns `null` so the
 * tool can fail closed instead of guessing which project was meant.
 */
export function readCaller(exec) {
    if (typeof exec !== 'object' || exec === null)
        return null;
    const agent = exec.agent;
    if (typeof agent !== 'object' || agent === null)
        return null;
    const id = agent.id;
    const session = agent.session;
    if (typeof session !== 'object' || session === null)
        return null;
    const header = session.header;
    if (typeof header !== 'object' || header === null)
        return null;
    const cwd = header.cwd;
    if (typeof id !== 'string' || id.trim() === '')
        return null;
    if (typeof cwd !== 'string' || cwd.trim() === '')
        return null;
    const agentPreset = header.agentPreset;
    if (typeof agentPreset === 'string' && agentPreset.trim() !== '') {
        return { sessionId: id, cwd, agentPreset };
    }
    return { sessionId: id, cwd };
}
/**
 * Check whether the caller may use a tool that requires `role`. Returns `null`
 * when allowed, otherwise a `role/forbidden` failure naming the expected role,
 * the caller, and the registered master.
 */
export function checkRole(role, caller, index) {
    const isMaster = caller.sessionId === index.masterSessionId;
    const isThread = index.threads.some((thread) => thread.threadId === caller.sessionId);
    const allowed = role === 'master' ? isMaster : role === 'thread' ? isThread : isMaster || isThread;
    if (allowed)
        return null;
    const expected = role === 'master'
        ? 'the master session'
        : role === 'thread'
            ? 'a thread session recorded in this project'
            : 'the master session or one of its threads';
    return failure(ERROR_CODES.roleForbidden, `this tool is restricted to ${expected}; session ${caller.sessionId} is neither (master is ${index.masterSessionId})`, { role, sessionId: caller.sessionId, masterSessionId: index.masterSessionId });
}
/**
 * Decide whether `caller` may act as the project master, and whether it may
 * take the role over from the session the index currently records.
 *
 * Taking over is deliberately explicit: a different session is refused unless
 * the call passes `takeOver: true`, and a session the index records as a thread
 * can never take over — a thread hands work back to the master instead of
 * becoming one. This helper only decides; the store performs the write.
 */
export function claimMaster(caller, index, options) {
    if (caller.sessionId === index.masterSessionId)
        return { action: 'current' };
    if (index.threads.some((thread) => thread.threadId === caller.sessionId)) {
        return failure(ERROR_CODES.roleForbidden, `session ${caller.sessionId} is recorded as a thread of this project and cannot take over the master role; only the master owns the project`, { role: 'master', sessionId: caller.sessionId, masterSessionId: index.masterSessionId });
    }
    if (options?.takeOver !== true) {
        return failure(ERROR_CODES.roleForbidden, `this tool is restricted to the master session; session ${caller.sessionId} is not it (master is ${index.masterSessionId}); call cowork_project_init with takeOver: true to make this session the master`, { role: 'master', sessionId: caller.sessionId, masterSessionId: index.masterSessionId });
    }
    return { action: 'takeover', previousMasterSessionId: index.masterSessionId };
}
/**
 * Branch prefix of a topic's private commits. Mirrors `CHECKOUT_BRANCH_PREFIX`
 * in src/checkout.ts; kept as a literal because this module imports nothing.
 */
const TOPIC_BRANCH_PREFIX = 'cowork/';
/**
 * The opener a new cowork topic receives: where the project is, which topic it
 * owns, what it must not touch, and the handoff contract it cannot skip. An
 * isolated topic also learns its clone path and the branch the master merges.
 */
export function buildThreadBrief(input) {
    const lines = [
        `You are cowork topic ${input.topicId} in project ${input.repoPath}.`,
        `Subject: ${input.subject}`,
    ];
    const intent = input.intent?.trim() ?? '';
    if (intent !== '')
        lines.push(`User intent: ${intent}`);
    const checkoutPath = input.checkoutPath?.trim() ?? '';
    if (checkoutPath !== '') {
        lines.push(`Your isolated work area is ${checkoutPath} — a local git clone of the project, branch ${TOPIC_BRANCH_PREFIX}${input.topicId}. Make all edits and commits there; do not modify the main repository. The master merges your branch after your handoff.`);
    }
    lines.push('Scope: work only inside this topic. Do not modify files owned by other topics, and do not change the project index by hand — the cowork tools write it.', 'Read the project index and the latest handoff with cowork_project_status before you start.', 'Before you stop (finished or blocked) you must call cowork_handoff with status blocked or done, a summary, and verification: [{command, exitCode, evidence}] for every check you ran.', 'When the work needs an independent review, call cowork_review_request yourself with the scope and the evidence you ran.');
    return lines.join('\n');
}
/**
 * The `findings` parameter schema of `cowork_review_verdict`. It lives here,
 * not in src/review.ts, because it is a tool-boundary concern: the review
 * model owns the semantics, the tool model owns what the model is asked for.
 * The shape is kept `as const` so it satisfies the host's parameter-spec type.
 */
export const REVIEW_FINDING_PARAMETER = {
    type: 'object',
    additionalProperties: false,
    properties: {
        id: { type: 'string', required: true, description: 'Short finding id, e.g. F1.' },
        severity: {
            type: 'string',
            required: true,
            enum: ['blocker', 'high', 'medium', 'low'],
            description: 'How serious the finding is.',
        },
        problem: { type: 'string', required: true, description: 'What is wrong.' },
        requiredFix: { type: 'string', required: true, description: 'What must change.' },
        file: { type: 'string', description: 'File the finding is in, when known.' },
        line: { type: 'integer', description: 'Positive line number, when known.' },
    },
};
/** The `verification` row schema, shared by `cowork_review_verdict`. */
export const REVIEW_VERIFICATION_PARAMETER = {
    type: 'object',
    additionalProperties: false,
    properties: {
        command: { type: 'string', required: true, description: 'Exact command that was run.' },
        exitCode: { type: 'integer', required: true, description: 'Exit code the command returned.' },
        evidence: { type: 'string', required: true, description: 'Short output or result that proves it.' },
    },
};
//# sourceMappingURL=tool-model.js.map