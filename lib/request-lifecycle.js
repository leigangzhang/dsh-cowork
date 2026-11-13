/**
 * Request lifecycle: creation, resolution, the wake-up prompt and the
 * authorization bridge.
 *
 * The terminal write is durable before the prompt is attempted, so a refused or
 * failed queue prompt is reported in `delivery.lastError` instead of rolling
 * the decision back. A replay of the same action is idempotent; a different
 * action on a terminal request is `inbox/request-resolved`.
 */
import { requestCreatedActivity, requestResolvedActivity } from './activity.js';
import { actionForStatus, isTerminalStatus, statusForAction } from './inbox-contract.js';
import { REQUEST_DELIVERY_ERROR_MAX_CHARS, RequestSchemaError, answerProblems, applyResolution, buildRequestRecord, kindOffersAction, normalizeComment, resolutionMessage, resolutionPrompt, } from './request-schema.js';
import { RequestStore } from './request-store.js';
import { resolveAuthorizationDecision } from './authorization-decision.js';
import { PanelServiceError, assertMember, clipText, messageOf } from './request-support.js';
/**
 * Persist one pending request and its `request-created` activity. The request
 * file is the state; a failed activity append is a logged evidence gap and
 * never rolls the file back.
 */
export async function createRequest(input) {
    let record;
    try {
        record = buildRequestRecord({
            requestId: input.requestId,
            projectId: input.projectId,
            topicId: input.topic.topicId,
            kind: input.kind,
            title: input.topic.title,
            summary: input.summary,
            payload: input.payload,
            now: input.now,
        });
    }
    catch (error) {
        if (error instanceof RequestSchemaError) {
            throw new PanelServiceError('request/invalid-body', error.message);
        }
        throw error;
    }
    const store = new RequestStore({ repoPath: input.repoPath, log: input.log });
    await store.create(record);
    try {
        await input.store.appendActivity(requestCreatedActivity(record, input.now));
    }
    catch (error) {
        input.log?.(`request ${record.requestId} created, activity not recorded: ${messageOf(error)}`);
    }
    return record;
}
/**
 * Resolve one pending request: validate the caller, the action and the
 * answers, write the terminal state and the right-hand reply, record the
 * activity, then wake the topic session with the reply.
 *
 * The terminal write is durable before the prompt is attempted, so a refused
 * or failed queue prompt is reported in `delivery.lastError` instead of
 * rolling the decision back. A replay of the same action is idempotent
 * (`changed: false`); a different action on a terminal request is
 * `inbox/request-resolved`.
 */
export async function resolveRequest(input) {
    const store = new RequestStore({ repoPath: input.repoPath, log: input.log });
    const record = await store.read(input.requestId);
    if (record === null) {
        throw new PanelServiceError('inbox/request-not-found', `no request ${input.requestId}`);
    }
    assertMember(input.document, input.sessionId, record.topicId);
    if (!kindOffersAction(record.kind, input.action)) {
        throw new PanelServiceError('inbox/action-not-allowed', `action ${input.action} is not offered by a ${record.kind} request`);
    }
    const comment = normalizeComment(input.comment);
    if (comment === 'invalid') {
        throw new PanelServiceError('inbox/invalid-comment', 'comment is not a valid bounded string');
    }
    if (isTerminalStatus(record.status)) {
        if (actionForStatus(record.status) === input.action) {
            return { record, changed: false, prompted: false, promptError: null };
        }
        throw new PanelServiceError('inbox/request-resolved', `request ${record.requestId} was already resolved as ${record.status}`);
    }
    if (record.kind === 'question' && input.action === 'submit') {
        const problems = answerProblems(record.payload, input.answers);
        if (problems.length > 0) {
            throw new PanelServiceError('inbox/invalid-answer', problems.join('; '));
        }
    }
    // An authorization decision is the one kind that also changes topic state and
    // the notice ledger; the shared core below is the only unlock path.
    const decision = record.kind === 'authorization'
        ? await decideAuthorization(input, record)
        : null;
    const status = statusForAction(input.action);
    const next = await store.update(input.requestId, (current) => (current.status === 'pending'
        ? applyResolution(current, {
            status,
            comment: comment ?? undefined,
            ...(record.kind === 'question' && input.answers !== undefined ? { answers: input.answers } : {}),
            resolvedBy: 'user',
            now: input.now,
        })
        : null));
    if (next === null) {
        // Another writer resolved the request between the read and the lock. The
        // same action is still an idempotent replay; a different one is a conflict.
        const current = await store.read(input.requestId);
        if (current === null) {
            throw new PanelServiceError('inbox/request-not-found', `request ${input.requestId} vanished`);
        }
        if (actionForStatus(current.status) === input.action) {
            return { record: current, changed: false, prompted: false, promptError: null };
        }
        throw new PanelServiceError('inbox/request-resolved', `request ${input.requestId} was resolved concurrently as ${current.status}`);
    }
    await appendResolvedActivity(input, next, input.action);
    // The card is terminal before any prompt is attempted. An authorization
    // decision was committed with `deferPrompt`, so its wake-up text only fires
    // here; every other kind rebuilds the text from its persisted resolution.
    const delivered = await promptRequestTopic({
        repoPath: input.repoPath,
        requestId: next.requestId,
        topicId: next.topicId,
        sessionId: input.sessionId,
        text: decision === null ? resolutionPromptOf(next) : decision.promptText,
        previousPromptedAt: next.delivery.promptedAt,
        promptSession: input.promptSession,
        now: input.now,
        log: input.log,
    });
    const recorded = delivered.prompted || delivered.promptError !== null
        ? await store.read(next.requestId)
        : next;
    return {
        record: recorded ?? next,
        changed: true,
        prompted: delivered.prompted,
        promptError: delivered.promptError,
    };
}
/** The wake-up text of one terminal request, from the durable resolution. */
function resolutionPromptOf(record) {
    return record.resolution === undefined
        ? (record.resolutionMessage ?? resolutionMessage(record.status))
        : resolutionPrompt(record);
}
/** Run the shared authorization core, mapping its codes onto the inbox ones. */
async function decideAuthorization(input, record) {
    const decision = input.action === 'allow' ? 'allow' : 'deny';
    try {
        return await resolveAuthorizationDecision({
            store: input.store,
            repoPath: input.repoPath,
            topicId: record.topicId,
            requestId: record.requestId,
            decision,
            sessionId: input.sessionId,
            now: input.now,
            // The card becomes terminal first; resolveRequest prompts afterwards.
            deferPrompt: true,
            promptSession: input.promptSession,
            noticePort: input.noticePort,
            kickNotices: input.kickNotices,
            log: input.log,
        });
    }
    catch (error) {
        if (error instanceof PanelServiceError
            && (error.code === 'authorization/not-found' || error.code === 'authorization/mismatch')) {
            throw new PanelServiceError('inbox/request-resolved', `the topic no longer holds authorization ${record.requestId}: ${error.message}`);
        }
        throw error;
    }
}
/** Append the `request-resolved` activity of one committed resolution. */
async function appendResolvedActivity(input, record, action) {
    try {
        await input.store.appendActivity(requestResolvedActivity(record, { action }, input.now));
    }
    catch (error) {
        input.log?.(`request ${record.requestId} resolved, activity not recorded: ${messageOf(error)}`);
    }
}
/**
 * Wake the topic session with `text` and persist the delivery facts on the
 * request card. A null text, a caller that is the topic itself and a host
 * without a prompt port are all deliberate non-prompts. A prompt failure is
 * recorded in `delivery.lastError` and never rolls the terminal state back; a
 * failed delivery write is logged rather than thrown, because the decision is
 * already durable.
 */
export async function promptRequestTopic(input) {
    // A caller that is the topic session already has the decision; prompting
    // itself would be a duplicate turn.
    if (input.text === null || input.sessionId === input.topicId || input.promptSession === undefined) {
        return { prompted: false, promptError: null };
    }
    let prompted = false;
    let promptError = null;
    try {
        const result = await input.promptSession(input.topicId, input.text);
        prompted = result.accepted === true;
        if (!prompted)
            promptError = 'the host refused the queue prompt';
    }
    catch (error) {
        promptError = clipText(messageOf(error), REQUEST_DELIVERY_ERROR_MAX_CHARS);
        input.log?.(`request ${input.requestId}: topic ${input.topicId} was not prompted: ${promptError}`);
    }
    const store = new RequestStore({ repoPath: input.repoPath, log: input.log });
    try {
        await store.recordDelivery(input.requestId, {
            promptedAt: prompted ? input.now.toISOString() : input.previousPromptedAt,
            lastError: promptError,
        });
    }
    catch (error) {
        input.log?.(`request ${input.requestId}: delivery was not recorded: ${messageOf(error)}`);
    }
    return { prompted, promptError };
}
//# sourceMappingURL=request-lifecycle.js.map