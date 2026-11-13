/**
 * The one authorization decision core: permission, idempotent replay,
 * lock-scoped unlock, `authorization-resolved` activity, notice patch and the
 * legacy route's card settlement.
 *
 * Both the legacy `authorization.resolve` route and the inbox resolve route call
 * this module; neither has an unlock path of its own. The prompt itself is
 * deferred to the caller (`deferPrompt`), so the request card can be terminal
 * before the topic is woken.
 */
import { authorizationResolvedActivity, requestResolvedActivity } from './activity.js';
import { updateAuthorizationNotice } from './notices.js';
import { REQUEST_DELIVERY_ERROR_MAX_CHARS, applyResolution } from './request-schema.js';
import { RequestStore } from './request-store.js';
import { ACTIVITY_MAX_EVENTS } from './store-schema.js';
import { unblockTopic } from './topic.js';
import { PanelServiceError, clipText, messageOf } from './request-support.js';
/** Find the decision already recorded for a request, if any. */
async function recordedDecision(store, topicId, requestId) {
    const { events } = await store.readActivity(ACTIVITY_MAX_EVENTS);
    for (const event of events) {
        if (event.type !== 'authorization-resolved' || event.topicId !== topicId)
            continue;
        const details = event.details;
        if (details.requestId !== requestId)
            continue;
        if (details.decision !== 'allow' && details.decision !== 'deny')
            continue;
        return {
            decision: details.decision,
            noticeId: typeof details.noticeId === 'string' ? details.noticeId : null,
        };
    }
    return null;
}
/** Find the `authorization-requested` event id whose notice a decision updates. */
async function authorizationNoticeId(store, topicId, requestId) {
    const { events } = await store.readActivity(ACTIVITY_MAX_EVENTS);
    for (const event of events) {
        if (event.type !== 'authorization-requested' || event.topicId !== topicId)
            continue;
        const details = event.details;
        if (details.requestId === requestId)
            return event.eventId;
    }
    return null;
}
/** The short prompt a decided topic session receives to continue its work. */
function authorizationPrompt(summary, decision) {
    const verb = decision === 'allow' ? '允许' : '拒绝';
    return `授权请求已${verb}：${clipText(summary, 200)}。请继续。`;
}
/**
 * The one authorization decision core: permission, idempotent replay,
 * lock-scoped unlock, `authorization-resolved` activity, notice patch and the
 * topic prompt. Both the legacy `authorization.resolve` route and the inbox
 * resolve route call this function; neither has an unlock path of its own.
 */
export async function resolveAuthorizationDecision(input) {
    const { store, topicId, requestId, decision, sessionId, now } = input;
    const before = await store.readIndexDocument();
    const topic = before.topics.find((entry) => entry.topicId === topicId);
    if (topic === undefined) {
        throw new PanelServiceError('topic/not-found', `unknown topic: ${topicId}`);
    }
    // Permission: the master may decide any topic; a topic session only its own.
    if (sessionId !== before.masterSessionId && sessionId !== topicId) {
        throw new PanelServiceError('authorization/not-allowed', `session ${sessionId} may not decide an authorization of topic ${topicId}`);
    }
    const pending = topic.authorization ?? null;
    if (pending === null) {
        const recorded = await recordedDecision(store, topicId, requestId);
        if (recorded === null) {
            throw new PanelServiceError('authorization/not-found', `no pending authorization ${requestId} on ${topicId}`);
        }
        if (recorded.decision !== decision) {
            throw new PanelServiceError('authorization/mismatch', `authorization ${requestId} was already ${recorded.decision}; refusing ${decision}`);
        }
        return {
            changed: false,
            prompted: false,
            promptError: null,
            promptText: null,
            noticeId: recorded.noticeId,
            document: before,
            topic,
            decision,
        };
    }
    if (pending.requestId !== requestId) {
        throw new PanelServiceError('authorization/mismatch', `pending authorization is ${pending.requestId}, not ${requestId}`);
    }
    const noticeId = await authorizationNoticeId(store, topicId, requestId);
    const summary = pending.summary;
    let changed = false;
    const document = await store.mutateIndexDocument((base) => {
        if (base.masterSessionId !== sessionId && sessionId !== topicId) {
            throw new PanelServiceError('authorization/not-allowed', `session ${sessionId} may not decide ${topicId}`);
        }
        const current = base.topics.find((entry) => entry.topicId === topicId);
        if (current === undefined || current.authorization === null)
            return null;
        if (current.authorization.requestId !== requestId) {
            throw new PanelServiceError('authorization/mismatch', `pending authorization is ${current.authorization.requestId}`);
        }
        changed = true;
        const released = unblockTopic(current, now.getTime());
        const next = { ...released, lastActiveAt: now.toISOString() };
        return { ...base, topics: base.topics.map((entry) => (entry.topicId === topicId ? next : entry)) };
    });
    if (!changed) {
        // The lock re-read found no pending authorization: another decision or an
        // archive won the race after the pre-check. Answer from the recorded
        // decision instead of reporting a no-op, so a duplicate click is idempotent
        // and a conflicting one is still refused.
        const recorded = await recordedDecision(store, topicId, requestId);
        if (recorded === null) {
            throw new PanelServiceError('authorization/not-found', `no pending authorization ${requestId} on ${topicId}`);
        }
        if (recorded.decision !== decision) {
            throw new PanelServiceError('authorization/mismatch', `authorization ${requestId} was already ${recorded.decision}; refusing ${decision}`);
        }
        const settled = document.topics.find((entry) => entry.topicId === topicId);
        if (settled === undefined) {
            throw new PanelServiceError('internal', `topic disappeared from the index: ${topicId}`);
        }
        return {
            changed: false,
            prompted: false,
            promptError: null,
            promptText: null,
            noticeId: recorded.noticeId,
            document,
            topic: settled,
            decision,
        };
    }
    try {
        await store.appendActivity(authorizationResolvedActivity(topic, { requestId, noticeId: noticeId ?? '', decision, summary }, now));
    }
    catch (error) {
        input.log?.(`panel authorization: activity not recorded: ${messageOf(error)}`);
    }
    if (noticeId !== null && input.noticePort !== undefined) {
        let update = 'failed';
        try {
            update = await updateAuthorizationNotice({
                port: input.noticePort,
                document,
                topicId,
                noticeId,
                decision,
                now,
            });
        }
        catch {
            update = 'failed';
        }
        if (update === 'failed')
            input.log?.(`panel authorization: notice ${noticeId} was not updated`);
    }
    // The topic continues on its own; the master already knows from the event.
    const promptText = input.promptSession !== undefined && sessionId !== topicId
        ? authorizationPrompt(summary, decision)
        : null;
    let prompted = false;
    let promptError = null;
    if (promptText !== null && input.deferPrompt !== true) {
        try {
            const result = await input.promptSession(topicId, promptText);
            prompted = result.accepted;
            if (!prompted)
                promptError = 'the host refused the queue prompt';
        }
        catch (error) {
            promptError = clipText(messageOf(error), REQUEST_DELIVERY_ERROR_MAX_CHARS);
            input.log?.(`panel authorization: topic ${topicId} was not prompted: ${promptError}`);
        }
    }
    input.kickNotices?.(input.repoPath);
    const current = document.topics.find((entry) => entry.topicId === topicId);
    if (current === undefined) {
        throw new PanelServiceError('internal', `topic disappeared from the index: ${topicId}`);
    }
    return {
        changed: true,
        prompted,
        promptError,
        promptText: input.deferPrompt === true ? promptText : null,
        noticeId,
        document,
        topic: current,
        decision,
    };
}
export async function settleAuthorizationRequestRecord(input) {
    const store = new RequestStore({ repoPath: input.repoPath, log: input.log });
    let record;
    try {
        record = await store.read(input.requestId);
    }
    catch (error) {
        input.log?.(`request ${input.requestId} was not read for settlement: ${messageOf(error)}`);
        return 'absent';
    }
    if (record === null)
        return 'absent';
    if (record.kind !== 'authorization' || record.topicId !== input.topicId)
        return 'absent';
    const status = input.decision === 'allow' ? 'allowed' : 'denied';
    if (record.status !== 'pending') {
        if (record.status === status)
            return 'already-resolved';
        input.log?.(`request ${input.requestId} carries ${record.status}, not ${status}; the legacy decision does not rewrite a settled card`);
        return 'conflict';
    }
    let settled = false;
    let next = null;
    try {
        next = await store.update(input.requestId, (current) => {
            if (current.kind !== 'authorization' || current.topicId !== input.topicId)
                return null;
            if (current.status !== 'pending')
                return null;
            settled = true;
            const resolved = applyResolution(current, {
                status,
                resolvedBy: input.resolvedBy ?? 'user',
                now: input.now,
            });
            return {
                ...resolved,
                delivery: {
                    promptedAt: input.promptedAt,
                    lastError: input.promptError === null
                        ? null
                        : clipText(input.promptError, REQUEST_DELIVERY_ERROR_MAX_CHARS),
                },
            };
        });
    }
    catch (error) {
        input.log?.(`request ${input.requestId} was not settled: ${messageOf(error)}`);
        return 'absent';
    }
    if (!settled || next === null) {
        // A concurrent writer settled the record after the pre-check. Mirroring is
        // best-effort: report what the file now says instead of rewriting it.
        return next !== null && next.status === status ? 'already-resolved' : 'conflict';
    }
    try {
        await input.store.appendActivity(requestResolvedActivity(next, { action: input.decision === 'allow' ? 'allow' : 'deny' }, input.now));
    }
    catch (error) {
        input.log?.(`request ${input.requestId} settled, activity not recorded: ${messageOf(error)}`);
    }
    return 'settled';
}
//# sourceMappingURL=authorization-decision.js.map