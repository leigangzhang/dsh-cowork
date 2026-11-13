/**
 * The two M10 isolation tools: `cowork_work_item_create` and
 * `cowork_checkout_merge`.
 *
 * Both keep their business rules in the domain modules (`src/work-item.ts`,
 * `src/checkout.ts`, `src/review-request.ts`) and this file only orchestrates:
 * role gates, the canonical index reads/writes, the review request lookup, the
 * merge serialization, and the after-merge teardown. The merge never moves the
 * repository branch: it merges into whatever branch is checked out, and the
 * protected default branches are refused so `main`/`master` stay human-owned.
 */
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { buildActivityEvent } from './activity.js';
import { CHECKOUT_ERROR, inspectCheckout, mergeCheckout, removeCheckout, workItemIsolationTarget, } from './checkout.js';
import { applyThreadStatus, describeError, teardownMergedCheckout, teardownMergedWorkItem, } from './checkout-teardown.js';
import { checkLegacyThreadMerge, mergeGate, parseReviewRequestRecord, reviewRequestFileName, } from './review-request.js';
import { DEFAULT_ISOLATION_PROVIDER, callerOf, isFailure, mapError, nowOf, openProject, renderJson, runGit, threadView, toJson, } from './tool-runtime.js';
import { ERROR_CODES, M10_ERROR_CODES, TOPIC_ERROR_CODES, checkRole, failure, success } from './tool-model.js';
import { captureWorkItemHead, createWorkItem, markWorkItem, workItemView } from './work-item.js';
/** Branch names the plugin refuses to merge into; closing them is the human's step. */
const PROTECTED_BRANCHES = ['main', 'master'];
/** Directory the review request files live in, relative to the repository root. */
const REVIEWS_RELATIVE_DIR = join('.dsh-cowork', 'reviews');
/** Most conflict files one merge failure lists; the count is reported beside it. */
const CONFLICT_FILES_SHOWN = 100;
/** Resolve the git runner for one call, defaulting to the shared node runner. */
function gitDepsOf(deps) {
    return { runGit: deps.runGit ?? runGit };
}
/** Trim one optional string argument; an empty or absent value is null. */
function trimmedArg(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
// ---------------------------------------------------------------------------
// serial merge queue
// ---------------------------------------------------------------------------
/** Tail of the in-process merge queue. */
let mergeQueue = Promise.resolve();
/**
 * Serialize merge operations inside this process: every `cowork_checkout_merge`
 * call runs through this chain, so two merges never interleave their gate and
 * git steps. The chain is not poisoned by a failed merge (a rejected operation
 * still lets the next one run), and the returned promise is the operation's own
 * result. Cross-process serialization is explicitly not promised (M10 risk).
 *
 * Exported so the ordering rule itself can be tested with plain promises.
 */
export function serializeMerge(operation) {
    const run = mergeQueue.then(operation, operation);
    mergeQueue = run.then(() => undefined, () => undefined);
    return run;
}
/** The branch the repository currently has checked out, or why it could not be read. */
async function currentBranch(deps, repoPath) {
    const result = await deps.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
    if (result.code !== 0) {
        return { branch: null, error: result.stderr.trim() === '' ? `exit ${result.code}` : result.stderr.trim() };
    }
    const branch = result.stdout.trim();
    return { branch: branch === '' || branch === 'HEAD' ? null : branch, error: null };
}
/** The refusal that keeps `main`/`master` (and a detached HEAD) human-owned. */
function protectedBranchFailure(repoPath, branch) {
    return failure(M10_ERROR_CODES.checkoutProtectedBranch, `refusing to merge into ${branch === null ? 'a detached or unknown branch' : `the protected branch ${branch}`} of ${repoPath}; `
        + 'check out the integration branch first — the plugin never moves main/master, a human closes it', { repoPath, branch });
}
/**
 * Read every stored review request of this model. The legacy verdict-only files
 * (`review.ts`'s `ReviewRecord`) predate `requestId`/`status` and stay read-only,
 * so a file that does not parse as a request is skipped instead of interpreted.
 * File names are checked against each record's own identity.
 */
async function readReviewRequests(opened) {
    const directory = join(opened.repoPath, REVIEWS_RELATIVE_DIR);
    let names;
    try {
        names = await readdir(directory);
    }
    catch (error) {
        const code = error.code;
        if (code === 'ENOENT' || code === 'ENOTDIR')
            return [];
        throw error;
    }
    const requests = [];
    for (const fileName of names.filter((name) => name.endsWith('.json')).sort()) {
        const text = await opened.store.readText(join(directory, fileName));
        if (text === null)
            continue;
        const parsed = parseReviewRequestRecord(text);
        if (!parsed.ok)
            continue;
        if (reviewRequestFileName(parsed.record.topicId, parsed.record.requestId) !== fileName)
            continue;
        requests.push(parsed.record);
    }
    return requests;
}
/**
 * Register `cowork_work_item_create` (topic/master): clone one isolated work
 * item, write its `active` v2 record, and record the creation activity. The tool
 * is registered but not yet assembled by `src/tools.ts`; M10.4b owns the 15-tool
 * order.
 */
export function registerWorkItemTools(ctx, deps) {
    const host = ctx;
    const disposers = [];
    const gitDeps = gitDepsOf(deps);
    disposers.push(host.tools.register(defineTool({
        name: 'cowork_work_item_create',
        description: 'Create one isolated work item: clone the repository HEAD into .dsh-cowork/workitems/<id> on branch cowork/<id>, write its index record, and record the creation. A topic creates work items for itself; the master must pass topicId.',
        parameters: {
            topicId: {
                type: 'string',
                description: 'Topic the work item belongs to. Optional for a topic caller (defaults to the caller), required for the master.',
            },
            baseRef: {
                type: 'string',
                description: 'Ref the clone starts from; defaults to the repository current HEAD.',
            },
        },
        output: { schema: { type: 'json' }, render: renderJson },
        execute: async (args, exec) => {
            const caller = callerOf(exec);
            if (isFailure(caller))
                return toJson(caller);
            try {
                const opened = await openProject(caller, deps);
                if (isFailure(opened))
                    return toJson(opened);
                const document = await opened.store.readIndexDocument();
                const isTopic = document.topics.some((topic) => topic.topicId === caller.sessionId);
                const isMaster = caller.sessionId === document.masterSessionId;
                if (!isTopic && !isMaster) {
                    return toJson(failure(ERROR_CODES.roleForbidden, `cowork_work_item_create is restricted to a topic or the master; session ${caller.sessionId} is neither`, { role: 'topic-or-master', sessionId: caller.sessionId, masterSessionId: document.masterSessionId }));
                }
                const explicitTopic = trimmedArg(args.topicId);
                let topicId;
                if (isTopic) {
                    // A topic owns its work items; it may not create one for another topic.
                    topicId = explicitTopic ?? caller.sessionId;
                    if (topicId !== caller.sessionId) {
                        return toJson(failure(ERROR_CODES.roleForbidden, `topic ${caller.sessionId} may only create work items for itself, not for ${topicId}`, { role: 'topic', sessionId: caller.sessionId, topicId }));
                    }
                }
                else {
                    if (explicitTopic === null) {
                        return toJson(failure(M10_ERROR_CODES.workItemCreateFailed, 'the master must pass the topicId a work item belongs to', { caller: caller.sessionId }));
                    }
                    topicId = explicitTopic;
                }
                if (!document.topics.some((topic) => topic.topicId === topicId)) {
                    return toJson(failure(TOPIC_ERROR_CODES.topicNotFound, `topic not found in the project index: ${topicId}`, { topicId }));
                }
                const baseRef = trimmedArg(args.baseRef);
                const created = await createWorkItem({
                    runGit: gitDeps.runGit,
                    store: opened.store,
                    now: () => nowOf(deps),
                    newWorkItemId: deps.newWorkItemId ?? (() => randomUUID()),
                }, {
                    repoPath: opened.repoPath,
                    topicId,
                    isolationProvider: deps.isolationProvider ?? DEFAULT_ISOLATION_PROVIDER,
                    ...(baseRef === null ? {} : { baseRef }),
                });
                if (!created.ok)
                    return toJson(failure(created.code, created.message, created.details));
                return toJson(success({
                    workItemId: created.workItem.workItemId,
                    topicId: created.workItem.topicId,
                    path: created.workItem.path,
                    branch: created.workItem.branch,
                    baseCommit: created.workItem.baseCommit,
                    headCommit: created.workItem.headCommit,
                    status: created.workItem.status,
                }));
            }
            catch (error) {
                return toJson(mapError(error));
            }
        },
    })));
    return disposers;
}
/** Merge one work item and report either the merge or a stable refusal. */
async function mergeWorkItem(input) {
    const { opened, deps, gitDeps, workItemId, message } = input;
    const now = nowOf(deps);
    const document = await opened.store.readIndexDocument();
    const workItem = document.workItems.find((entry) => entry.workItemId === workItemId) ?? null;
    if (workItem === null) {
        return failure(M10_ERROR_CODES.workItemNotFound, `work item not found in the project index: ${workItemId}`, { workItemId });
    }
    if (workItem.status !== 'reviewing') {
        return failure(M10_ERROR_CODES.workItemNotReady, `work item ${workItemId} is ${workItem.status}; only a reviewing work item may be merged`, { workItemId, status: workItem.status });
    }
    // The clone must exist and be clean before any gate decision.
    let inspected;
    try {
        inspected = await inspectCheckout(gitDeps, {
            repoPath: opened.repoPath,
            target: workItemIsolationTarget(workItemId),
        });
    }
    catch (error) {
        return failure(CHECKOUT_ERROR.pathGuard, describeError(error), { workItemId });
    }
    if (!inspected.exists) {
        return failure(CHECKOUT_ERROR.notFound, `no work-item clone at ${workItem.path}`, { workItemId, path: workItem.path });
    }
    if (inspected.dirty) {
        return failure(M10_ERROR_CODES.reviewDirtyWorktree, `the clone of work item ${workItemId} has uncommitted changes; commit or discard them before merging`, { workItemId, path: workItem.path });
    }
    // Refresh the head from the clone itself, then bind the review to it.
    const captured = await captureWorkItemHead({ runGit: gitDeps.runGit, store: opened.store, now: () => now }, { repoPath: opened.repoPath, workItemId });
    if (!captured.ok)
        return failure(captured.code, captured.message, captured.details);
    const headCommit = captured.workItem.headCommit;
    if (headCommit === null) {
        return failure(CHECKOUT_ERROR.gitFailed, `work item ${workItemId} has no head commit`, { workItemId });
    }
    const request = await readReviewRequests(opened);
    const passed = request.filter((entry) => entry.workItemId === workItemId && entry.status === 'pass');
    const sameHead = passed.find((entry) => entry.headCommit === headCommit) ?? null;
    if (sameHead === null) {
        if (passed.length === 0) {
            return failure(ERROR_CODES.reviewNotPassed, `work item ${workItemId} has no passed review request; the topic must request a review before it can be merged`, { workItemId, headCommit });
        }
        return failure(M10_ERROR_CODES.checkoutHeadMismatch, `the reviewed head of work item ${workItemId} is not the current head ${headCommit}; the work moved after the review, so request another review`, { workItemId, headCommit, reviewedHeads: [...new Set(passed.map((entry) => entry.headCommit))] });
    }
    // The ancestry check runs in the clone: the reviewed head may not exist in the
    // repository yet (the merge fetches the branch), so only the clone knows both.
    const ancestor = await gitDeps.runGit(['merge-base', '--is-ancestor', sameHead.baseCommit, headCommit], workItem.path);
    if (ancestor.code !== 0 && ancestor.code !== 1) {
        return failure(ERROR_CODES.checkoutGitFailed, `git merge-base --is-ancestor failed in ${workItem.path}: ${ancestor.stderr.trim() || `exit ${ancestor.code}`}`, { workItemId, exitCode: ancestor.code });
    }
    const gate = mergeGate({
        request: sameHead,
        headCommit,
        baseIsAncestor: ancestor.code === 0,
        workItemStatus: workItem.status,
        workTreeClean: !inspected.dirty,
    });
    if (!gate.ok)
        return gate.failure;
    const merged = await mergeCheckout(gitDeps, {
        repoPath: opened.repoPath,
        target: workItemIsolationTarget(workItemId),
        ...(message === null ? {} : { message }),
    });
    if (!merged.ok) {
        if (merged.code === CHECKOUT_ERROR.mergeConflict) {
            // The clone and the conflicted files stay; the work item still needs work.
            const files = Array.isArray(merged.details?.conflictFiles)
                ? merged.details?.conflictFiles
                : [];
            return failure(merged.code, merged.message, {
                ...merged.details,
                workItemId,
                status: workItem.status,
                conflictFiles: files.slice(0, CONFLICT_FILES_SHOWN),
                conflictFilesTotal: files.length,
            });
        }
        return failure(merged.code, merged.message, { ...merged.details, workItemId });
    }
    // The merge landed: teardown steps are best-effort and never fail the result.
    const teardown = await teardownMergedWorkItem({ checkoutPath: workItem.path, workItemId }, {
        resolveWorkspace: (path) => deps.workspaceRegistry.resolveByPath(path),
        removeCheckout: async () => {
            const removed = await removeCheckout(gitDeps, {
                repoPath: opened.repoPath,
                target: workItemIsolationTarget(workItemId),
            });
            return removed.ok
                ? { ok: true, removed: removed.removed, branchDeleted: removed.branchDeleted }
                : { ok: false, message: removed.message };
        },
        deleteWorkspace: (workspaceId) => opened.slice.deleteWorkspace(workspaceId),
        updateWorkItem: async () => {
            const updated = await opened.store.mutateIndexDocument((current) => ({
                ...current,
                workItems: current.workItems.map((entry) => entry.workItemId === workItemId
                    ? markWorkItem(entry, { status: 'merged', headCommit }, now)
                    : entry),
            }));
            const row = updated.workItems.find((entry) => entry.workItemId === workItemId) ?? null;
            return { workItem: row === null ? null : workItemView(row) };
        },
    });
    let activityError = null;
    try {
        await opened.store.appendActivity(buildActivityEvent({
            type: 'work-item-merged',
            topicId: workItem.topicId,
            summary: `merged work item ${workItemId}`,
            details: {
                workItemId,
                topicId: workItem.topicId,
                requestId: sameHead.requestId,
                baseCommit: sameHead.baseCommit,
                headCommit,
                commit: merged.commit,
                branch: merged.branch,
            },
        }, now));
    }
    catch (error) {
        activityError = describeError(error);
    }
    return success({
        workItemId,
        merged: true,
        commit: merged.commit,
        branch: merged.branch,
        baseCommit: sameHead.baseCommit,
        headCommit,
        reviewRequestId: sameHead.requestId,
        cleanup: teardown.cleanup,
        cleanupErrors: teardown.cleanupErrors,
        activityError,
        workItem: teardown.workItem,
    });
}
/** Merge one legacy thread clone; the M9 gate without the allowUnreviewed override. */
async function mergeLegacyThread(input) {
    const { opened, deps, gitDeps, threadId, message } = input;
    const thread = opened.index.threads.find((entry) => entry.threadId === threadId);
    if (thread === undefined) {
        return failure(ERROR_CODES.threadNotFound, `thread not found in the project index: ${threadId}`, { threadId });
    }
    const checkoutPath = thread.checkoutPath;
    if (checkoutPath === null) {
        return failure(ERROR_CODES.checkoutNotFound, `thread ${threadId} has no isolated checkout`, { threadId });
    }
    if (thread.status !== 'awaiting_review' && thread.status !== 'done') {
        return failure(ERROR_CODES.checkoutNotReady, `thread ${threadId} is ${thread.status}; merging is allowed for awaiting_review or done`, { threadId, status: thread.status });
    }
    // The override is gone: the shared legacy gate is called without options, so
    // only a passed review merges on this path too.
    const plan = checkLegacyThreadMerge({ threadId, reviewStatus: thread.reviewStatus });
    if (!plan.ok)
        return plan.failure;
    const merged = await mergeCheckout(gitDeps, {
        repoPath: opened.repoPath,
        threadId,
        ...(message === null ? {} : { message }),
    });
    if (!merged.ok) {
        if (merged.code === CHECKOUT_ERROR.mergeConflict) {
            // The clone stays so the thread can resolve and retry. The conflict
            // result is the real answer, so a failed index write is reported inside
            // it (`statusUpdateError`) instead of escaping to the generic catch.
            const statusUpdate = await applyThreadStatus(async () => {
                const updated = await opened.store.updateThread(threadId, { status: 'blocked' });
                return { thread: updated.threads.find((entry) => entry.threadId === threadId) ?? null };
            });
            return failure(merged.code, merged.message, {
                ...merged.details,
                threadId,
                status: 'blocked',
                thread: statusUpdate.thread === null ? null : threadView(statusUpdate.thread),
                ...(statusUpdate.error === null ? {} : { statusUpdateError: statusUpdate.error }),
            });
        }
        return failure(merged.code, merged.message, { ...merged.details, threadId });
    }
    const teardown = await teardownMergedCheckout({ checkoutPath, threadId }, {
        resolveWorkspace: (path) => deps.workspaceRegistry.resolveByPath(path),
        removeCheckout: () => removeCheckout(gitDeps, { repoPath: opened.repoPath, threadId }),
        deleteWorkspace: (workspaceId) => opened.slice.deleteWorkspace(workspaceId),
        archiveSession: (sessionId) => opened.slice.archiveSession(sessionId),
        updateThread: async (id) => {
            const updated = await opened.store.updateThread(id, { checkoutPath: null, status: 'done' });
            return { thread: updated.threads.find((entry) => entry.threadId === id) ?? null };
        },
    });
    return success({
        threadId,
        merged: true,
        commit: merged.commit,
        branch: merged.branch,
        cleanup: teardown.cleanup,
        cleanupErrors: teardown.cleanupErrors,
        thread: teardown.thread === null ? null : threadView(teardown.thread),
    });
}
/**
 * Register `cowork_checkout_merge` (master only): the M10 work-item merge with
 * the deprecated thread clone as a compatibility alias. `workItemId` wins when
 * both are passed; `allowUnreviewed`/`overrideReason` no longer exist — a merge
 * without a passed review of the same head is refused.
 */
export function registerCheckoutTools(ctx, deps) {
    const host = ctx;
    const disposers = [];
    const gitDeps = gitDepsOf(deps);
    disposers.push(host.tools.register(defineTool({
        name: 'cowork_checkout_merge',
        description: 'Merge one isolated work item (preferred) or a legacy thread clone into the branch the repository currently has checked out, then tear the clone down. Master only. Requires a passed review of the same head commit; main/master are protected and never moved by the plugin.',
        parameters: {
            workItemId: { type: 'string', description: 'Work item to merge. Preferred; when both ids are given this one wins.' },
            threadId: { type: 'string', description: 'Deprecated: the legacy thread clone to merge when no workItemId is given.' },
            message: { type: 'string', description: 'Merge commit message; defaults to "cowork: merge <id>".' },
        },
        output: { schema: { type: 'json' }, render: renderJson },
        execute: async (args, exec) => {
            const caller = callerOf(exec);
            if (isFailure(caller))
                return toJson(caller);
            try {
                const opened = await openProject(caller, deps);
                if (isFailure(opened))
                    return toJson(opened);
                const denied = checkRole('master', caller, opened.index);
                if (denied !== null)
                    return toJson(denied);
                const workItemId = trimmedArg(args.workItemId);
                const threadId = trimmedArg(args.threadId);
                if (workItemId === null && threadId === null) {
                    return toJson(failure(ERROR_CODES.checkoutNotReady, 'cowork_checkout_merge needs a workItemId (preferred) or the deprecated threadId', {}));
                }
                const message = trimmedArg(args.message);
                // The protected-branch rule is a property of the tool, not of one path:
                // the plugin never writes main/master, whichever clone it merges.
                const probe = await currentBranch(gitDeps, opened.repoPath);
                if (probe.error !== null) {
                    return toJson(failure(ERROR_CODES.checkoutGitFailed, `cannot read the current branch of ${opened.repoPath}: ${probe.error}`, { repoPath: opened.repoPath }));
                }
                if (probe.branch === null || PROTECTED_BRANCHES.includes(probe.branch)) {
                    return toJson(protectedBranchFailure(opened.repoPath, probe.branch));
                }
                const result = await serializeMerge(() => workItemId !== null
                    ? mergeWorkItem({ opened, deps, gitDeps, workItemId, message })
                    : mergeLegacyThread({ opened, deps, gitDeps, threadId: threadId, message }));
                return toJson(result);
            }
            catch (error) {
                return toJson(mapError(error));
            }
        },
    })));
    return disposers;
}
//# sourceMappingURL=checkout-tools.js.map