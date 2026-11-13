/**
 * Project-level tools: `cowork_project_init` and the bounded
 * `cowork_project_status` (PLAN-V0.2 §5.6/§5.7, M9.3a).
 *
 * `project_status` is the read point the lifecycle rules were waiting for: it
 * evaluates every topic lazily before reading, then returns a bounded summary
 * (topics and counts, at most 50 topics, at most 10 undelivered inbox items,
 * the activity tail, the inbox replay result, and work-item/review counts). M10
 * removed the handoff compatibility replay: old handoff files are read-only and
 * no longer repaired into the index from a status read. It never returns the
 * full index, the full handoff/review set, or checkout rows.
 *
 * Everything host-specific lives in `src/tool-runtime.ts`; this module only
 * declares the two tools and the shapes they return.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { callerOf, deliverInbox, evaluateProjectLifecycle, isFailure, makeSlice, mapError, nowOf, openProject, projectStoreFor, renderJson, toJson, } from './tool-runtime.js';
import { DEFAULT_IDLE_AFTER_MS, DEFAULT_RESOLVE_AFTER_MS } from './topic.js';
import { activeWorkItemCount } from './work-item.js';
import { checkRole, claimMaster, success } from './tool-model.js';
/** Most topics one status response lists. */
export const STATUS_TOPIC_LIMIT = 50;
/** Most undelivered inbox items one status response lists. */
export const STATUS_INBOX_LIMIT = 10;
/** Most activity events one status response returns (the stream tail). */
export const STATUS_ACTIVITY_LIMIT = 20;
/** Most characters of one topic digest a status response returns. */
export const STATUS_DIGEST_MAX_CHARS = 200;
/** Most lifecycle changes one status response reports. */
export const STATUS_LIFECYCLE_CHANGES_LIMIT = 10;
/** Cut text to at most `limit` Unicode code points without splitting a pair. */
function truncate(text, limit) {
    const points = Array.from(text);
    return points.length <= limit ? text : points.slice(0, limit).join('');
}
/** One bounded topic row, with the per-topic facts a master decides on. */
function topicStatusView(topic, activeWorkItems, reviewsPending) {
    return {
        topicId: topic.topicId,
        title: topic.title,
        status: topic.status,
        blocked: topic.blocked,
        awaitingReview: topic.awaitingReview,
        digest: truncate(topic.digest, STATUS_DIGEST_MAX_CHARS),
        scope: topic.scope,
        ownedPaths: topic.ownedPaths,
        lastActiveAt: topic.lastActiveAt,
        updatedAt: topic.updatedAt,
        resolvedAt: topic.resolvedAt,
        resolvedBy: topic.resolvedBy,
        activeWorkItems,
        reviewsPending,
    };
}
/** Work items in flight, by status; the mergeable counts stay separate. */
function workItemCountsOf(workItems) {
    const counts = { total: workItems.length, active: 0, reviewing: 0, merged: 0, abandoned: 0 };
    for (const workItem of workItems)
        counts[workItem.status] += 1;
    return counts;
}
/** Pending review requests: each topic carries at most one (`reviewStatus`). */
function reviewsPendingOf(topic) {
    return topic.reviewStatus === 'pending' ? 1 : 0;
}
/** One bounded undelivered inbox row. */
function inboxItemView(item) {
    return {
        id: item.id,
        topicId: item.topicId,
        kind: item.kind,
        summary: truncate(item.summary, 200),
        time: item.time,
    };
}
/** Status reasons the master may want to know about, in status order. */
function countsOf(topics) {
    const counts = { total: topics.length, active: 0, idle: 0, resolved: 0, blocked: 0, awaitingReview: 0 };
    for (const topic of topics) {
        counts[topic.status] += 1;
        if (topic.blocked)
            counts.blocked += 1;
        if (topic.awaitingReview)
            counts.awaitingReview += 1;
    }
    return counts;
}
/** The two project tools, registered in the documented order. */
export function registerProjectTools(ctx, deps) {
    const host = ctx;
    const disposers = [];
    // 1) cowork_project_init — the only tool that may create or rebind a project, always at the caller's cwd.
    disposers.push(host.tools.register(defineTool({
        name: 'cowork_project_init',
        description: 'Initialize the cowork project rooted at the caller cwd: write .dsh-cowork/index.json with the calling session as master and ensure the workspace. Idempotent; refuses a different master unless takeOver is true, which rebinds the project to the caller.',
        parameters: {
            takeOver: {
                type: 'boolean',
                description: 'Take the master role for this session when the index records a different master. Defaults to false: without it the call stays fail-closed. A session recorded as a thread can never take over.',
            },
        },
        output: { schema: { type: 'json' }, render: renderJson },
        execute: async (args, exec) => {
            const caller = callerOf(exec);
            if (isFailure(caller))
                return toJson(caller);
            try {
                const repoPath = caller.cwd;
                const store = projectStoreFor(repoPath, deps);
                const slice = makeSlice(deps);
                // Idempotent by construction: an existing index keeps its master unless
                // the caller explicitly takes the role over.
                const initialized = await store.initIndex(caller.sessionId);
                const claim = claimMaster(caller, initialized.index, { takeOver: args.takeOver === true });
                if (isFailure(claim))
                    return toJson(claim);
                const previousMasterSessionId = initialized.index.masterSessionId;
                const rebound = claim.action === 'takeover';
                if (rebound)
                    await store.rebindMaster(caller.sessionId);
                // Read-only legacy view for the payload: M10 removed the reconcile
                // write, so init no longer repairs the index from handoff files.
                const index = await store.readIndex();
                const workspaceId = await slice.resolveWorkspaceId(repoPath);
                // A workspace record alone does not put the project back in the sidebar:
                // the host shows a workspace through the sessions attached to it. The
                // registry's header bootstrap runs only while its domain is
                // uninitialized, so a lost record is never rebuilt from session headers
                // after a restart. Binding the calling master here is the primary
                // registration path; the startup repair is only a transitional fallback
                // (KI-39).
                const attachment = await slice.attachSession(workspaceId, caller.sessionId);
                if (!attachment.attached) {
                    // A refusal must not undo a successful project init: keep the result
                    // usable but say plainly that the sidebar binding did not happen.
                    deps.log?.(`cowork_project_init: session ${caller.sessionId} was not attached to workspace ${workspaceId}: ${attachment.error ?? 'unknown error'}`);
                }
                return toJson(success({
                    projectId: index.projectId,
                    repoPath,
                    masterSessionId: index.masterSessionId,
                    workspaceId,
                    sessionAttached: attachment.attached,
                    ...(attachment.attached
                        ? {}
                        : { sessionAttachError: attachment.error ?? 'unknown error' }),
                    created: initialized.created,
                    rebound,
                    previousMasterSessionId,
                    index,
                }));
            }
            catch (error) {
                return toJson(mapError(error));
            }
        },
    })));
    // 2) cowork_project_status — bounded snapshot, lifecycle read point, replay once.
    disposers.push(host.tools.register(defineTool({
        name: 'cowork_project_status',
        description: 'Read a bounded cowork project summary: topic and work-item counts, up to 50 topics with their in-flight work items and pending reviews, undelivered inbox items, the activity tail, and the result of replaying undelivered inbox items. Evaluates idle/resolved lazily; never returns the full index, every handoff, or every review.',
        parameters: {},
        output: { schema: { type: 'json' }, render: renderJson },
        execute: async (_args, exec) => {
            const caller = callerOf(exec);
            if (isFailure(caller))
                return toJson(caller);
            try {
                const opened = await openProject(caller, deps);
                if (isFailure(opened))
                    return toJson(opened);
                const denied = checkRole('master-or-thread', caller, opened.index);
                if (denied !== null)
                    return toJson(denied);
                // Read point (PLAN §5.1): evaluate idle/resolved inside the lock before
                // anything is read; a no-change pass writes nothing.
                const now = nowOf(deps);
                const lifecycle = await evaluateProjectLifecycle(opened.store, {
                    idleAfterMs: deps.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS,
                    resolveAfterMs: deps.resolveAfterMs ?? DEFAULT_RESOLVE_AFTER_MS,
                    now,
                    activeWorkItemsOf: (topicId, document) => activeWorkItemCount(document, topicId),
                });
                const document = await opened.store.readIndexDocument();
                const masterSessionId = document.masterSessionId;
                // Snapshot the inbox before replaying it: the caller sees what was
                // pending, and the replay result reports what was delivered.
                const inboxSnapshot = await opened.store.readInbox();
                const pendingInbox = inboxSnapshot.filter((item) => item.deliveredAt === null);
                const inboxReplay = await deliverInbox({
                    store: opened.store,
                    deliver: async (text) => {
                        const prompted = await opened.slice.promptSession(masterSessionId, text);
                        if (!prompted.accepted)
                            throw new Error('master did not accept the inbox batch');
                    },
                    clock: () => now,
                });
                // Read one extra event to tell the tail apart from the whole stream.
                const activityRead = await opened.store.readActivity(STATUS_ACTIVITY_LIMIT + 1);
                const activityTruncated = activityRead.events.length > STATUS_ACTIVITY_LIMIT;
                const activityEvents = activityRead.events.slice(-STATUS_ACTIVITY_LIMIT);
                const sortedTopics = [...document.topics].sort((left, right) => {
                    const leftAt = Date.parse(left.lastActiveAt);
                    const rightAt = Date.parse(right.lastActiveAt);
                    if (leftAt !== rightAt)
                        return rightAt - leftAt;
                    if (left.topicId === right.topicId)
                        return 0;
                    return left.topicId < right.topicId ? -1 : 1;
                });
                const topics = sortedTopics
                    .slice(0, STATUS_TOPIC_LIMIT)
                    .map((topic) => topicStatusView(topic, activeWorkItemCount(document, topic.topicId), reviewsPendingOf(topic)));
                return toJson(success({
                    project: {
                        projectId: document.projectId,
                        repoPath: opened.repoPath,
                        masterSessionId: document.masterSessionId,
                        createdAt: document.createdAt,
                    },
                    counts: countsOf(document.topics),
                    workItems: workItemCountsOf(document.workItems),
                    reviews: {
                        pending: document.topics.reduce((total, topic) => total + reviewsPendingOf(topic), 0),
                    },
                    topics,
                    inbox: {
                        pendingTotal: pendingInbox.length,
                        items: pendingInbox.slice(0, STATUS_INBOX_LIMIT).map(inboxItemView),
                    },
                    activity: { events: activityEvents, skippedLines: activityRead.skippedLines },
                    lifecycle: {
                        evaluated: lifecycle.evaluated,
                        changes: lifecycle.changes.slice(0, STATUS_LIFECYCLE_CHANGES_LIMIT),
                        activityErrors: lifecycle.activityErrors,
                    },
                    inboxReplay,
                    truncated: sortedTopics.length > STATUS_TOPIC_LIMIT
                        || pendingInbox.length > STATUS_INBOX_LIMIT
                        || activityTruncated,
                }));
            }
            catch (error) {
                return toJson(mapError(error));
            }
        },
    })));
    return disposers;
}
//# sourceMappingURL=project-tools.js.map