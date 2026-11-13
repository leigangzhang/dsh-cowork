/**
 * Work items: the pure domain model and the creation flow of M10's isolation.
 *
 * A work item is one isolated clone (`.dsh-cowork/workitems/<id>`, branch
 * `cowork/<id>`) plus the v2 index record PLAN-V0.2 §4.3 defines. The first
 * half of this module owns the parts that need no host and no file system: the
 * status vocabulary, the in-flight count a topic's "resolved" condition reads,
 * the record builder, the marker updates, and the bounded view a tool returns.
 *
 * The second half is the creation/capture flow. It still owns no I/O itself:
 * git arrives as the checkout module's injected runner, the index and activity
 * writes arrive as a narrow store port, and time and ids are injected. Clone
 * creation, path guarding and cleanup reuse `src/checkout.ts` (the same guard
 * every thread checkout uses), so a work item can never land outside
 * `.dsh-cowork/workitems` and a failed creation leaves no half index record.
 */
import { buildActivityEvent } from './activity.js';
import { CHECKOUT_ERROR, CLONE_ISOLATION_PROVIDER, createCheckout, removeCheckout, resolveIsolationTarget, workItemIsolationTarget, } from './checkout.js';
import { describeError } from './checkout-teardown.js';
import { M10_ERROR_CODES, TOPIC_ERROR_CODES } from './tool-model.js';
import { WORK_ITEM_STATUSES } from './store-schema.js';
export { WORK_ITEM_STATUSES };
/**
 * A work-item id that is also usable as a directory and branch name. Kept
 * identical to the checkout path guard's `TARGET_ID_PATTERN`
 * (`src/checkout.ts`): a dotted id must fail here rather than pass this check
 * and be refused later by `createCheckout`.
 */
export const WORK_ITEM_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** Statuses that count as work in flight (PLAN-V0.2 §5.1: active + reviewing). */
export const ACTIVE_WORK_ITEM_STATUSES = ['active', 'reviewing'];
/** Statuses a work item may be merged from. */
export const MERGEABLE_WORK_ITEM_STATUSES = ['reviewing'];
/** Longest path `workItemView` returns, in characters. */
export const WORK_ITEM_VIEW_PATH_MAX_CHARS = 1024;
/** Longest branch `workItemView` returns, in characters. */
export const WORK_ITEM_VIEW_BRANCH_MAX_CHARS = 256;
/** Longest commit id `workItemView` returns, in characters. */
export const WORK_ITEM_VIEW_COMMIT_MAX_CHARS = 64;
/** Whether a value is a usable work-item id. */
export function isValidWorkItemId(value) {
    return typeof value === 'string'
        && WORK_ITEM_ID_PATTERN.test(value)
        // The pattern already excludes dots; these stay as a second guard so a
        // future widening cannot make `.`/`..` usable as a path segment.
        && value !== '.'
        && value !== '..';
}
/** Whether a work item in this status may be merged by the master. */
export function isMergeableWorkItemStatus(status) {
    return MERGEABLE_WORK_ITEM_STATUSES.includes(status);
}
/** Cut text to at most `limit` Unicode code points without splitting a pair. */
function cut(text, limit) {
    if (limit <= 0)
        return '';
    const points = Array.from(text);
    return points.length <= limit ? text : points.slice(0, limit).join('');
}
/**
 * How many work items of one topic are in flight: `active` plus `reviewing`.
 * Both count, because a topic waiting on a review is still working and marking
 * it resolved has no undo (PLAN-V0.2 §5.1, KI-24).
 */
export function activeWorkItemCount(document, topicId) {
    const workItems = document?.workItems ?? [];
    let count = 0;
    for (const workItem of workItems) {
        if (workItem.topicId !== topicId)
            continue;
        if (ACTIVE_WORK_ITEM_STATUSES.includes(workItem.status))
            count += 1;
    }
    return count;
}
/**
 * Build the `active` record of one freshly created work item. A programmer error
 * in the caller's input throws here rather than writing an index row that
 * `projectIndexV2Problems` would refuse.
 */
export function buildWorkItemRecord(input, createdAt) {
    if (!isValidWorkItemId(input.workItemId)) {
        throw new TypeError(`workItemId ${String(input.workItemId)} is not a usable work-item id`);
    }
    if (typeof input.topicId !== 'string' || input.topicId.trim() === '') {
        throw new TypeError('topicId must be a non-empty topic id');
    }
    if (typeof input.path !== 'string' || input.path.trim() === '') {
        throw new TypeError('path must be a non-empty absolute path');
    }
    if (typeof input.branch !== 'string' || input.branch.trim() === '') {
        throw new TypeError('branch must be a non-empty branch name');
    }
    if (input.baseCommit !== null && (typeof input.baseCommit !== 'string' || input.baseCommit.trim() === '')) {
        throw new TypeError('baseCommit must be a commit id or null');
    }
    const stamp = createdAt.toISOString();
    return {
        workItemId: input.workItemId,
        topicId: input.topicId,
        path: input.path,
        branch: input.branch,
        baseCommit: input.baseCommit,
        headCommit: input.baseCommit,
        status: 'active',
        createdAt: stamp,
        updatedAt: stamp,
    };
}
/**
 * Stamp one marker update: the patch replaces the named fields, `updatedAt`
 * always moves, and every other field (identity, topic, timestamps) survives.
 * `headCommit` is refreshed here before a review request and before a merge.
 */
export function markWorkItem(workItem, patch, now) {
    if (patch.status !== undefined && !WORK_ITEM_STATUSES.includes(patch.status)) {
        throw new TypeError(`unknown work-item status ${String(patch.status)}`);
    }
    for (const field of ['baseCommit', 'headCommit']) {
        const value = patch[field];
        if (value !== undefined && value !== null && (typeof value !== 'string' || value.trim() === '')) {
            throw new TypeError(`${field} must be a commit id or null`);
        }
    }
    for (const field of ['path', 'branch']) {
        const value = patch[field];
        if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
            throw new TypeError(`${field} must be a non-empty string`);
        }
    }
    const next = { ...workItem, updatedAt: now.toISOString() };
    if (patch.status !== undefined)
        next.status = patch.status;
    if (patch.baseCommit !== undefined)
        next.baseCommit = patch.baseCommit;
    if (patch.headCommit !== undefined)
        next.headCommit = patch.headCommit;
    if (patch.path !== undefined)
        next.path = patch.path;
    if (patch.branch !== undefined)
        next.branch = patch.branch;
    return next;
}
/**
 * Project one work item onto the bounded tool view. Path and branch are cut, so
 * a pathological clone path cannot blow the status payload; identity, status,
 * and the two commits are returned whole because a merge decision needs them.
 */
export function workItemView(workItem) {
    return {
        workItemId: workItem.workItemId,
        topicId: workItem.topicId,
        path: cut(workItem.path, WORK_ITEM_VIEW_PATH_MAX_CHARS),
        branch: cut(workItem.branch, WORK_ITEM_VIEW_BRANCH_MAX_CHARS),
        baseCommit: workItem.baseCommit === null ? null : cut(workItem.baseCommit, WORK_ITEM_VIEW_COMMIT_MAX_CHARS),
        headCommit: workItem.headCommit === null ? null : cut(workItem.headCommit, WORK_ITEM_VIEW_COMMIT_MAX_CHARS),
        status: workItem.status,
        createdAt: workItem.createdAt,
        updatedAt: workItem.updatedAt,
    };
}
// ---------------------------------------------------------------------------
// creation and head capture
// ---------------------------------------------------------------------------
/** Upper bound on git stderr copied into a failure payload, in characters. */
const GIT_STDERR_DETAIL_LIMIT = 500;
/** Build one failure; kept local so every branch returns the same shape. */
function workItemFailure(code, message, details) {
    return details === undefined ? { ok: false, code, message } : { ok: false, code, message, details };
}
/**
 * Report what `createCheckout` cleaned up for one of its failures.
 *
 * `createCheckout` removes the directory it created for every failure after the
 * clone starts; a failure that never ran git (mkdir before any command) has
 * nothing to remove. A present numeric `exitCode` is therefore the signal that
 * a git command ran and a cleanup was attempted, and `cleanupError` says that
 * the removal itself failed.
 */
function cleanupFromCheckoutFailure(details) {
    const attempted = details !== undefined && typeof details.exitCode === 'number';
    const cleanupError = details?.cleanupError;
    return {
        attempted,
        error: typeof cleanupError === 'string' ? cleanupError : null,
    };
}
/** Remove one work item's clone and branch, reporting instead of throwing. */
async function removeWorkItemClone(deps, repoPath, workItemId) {
    try {
        const removed = await removeCheckout(deps, {
            repoPath,
            target: workItemIsolationTarget(workItemId),
        });
        if (!removed.ok)
            return { removed: false, branchDeleted: false, error: removed.message };
        return { removed: removed.removed, branchDeleted: removed.branchDeleted, error: null };
    }
    catch (error) {
        return { removed: false, branchDeleted: false, error: describeError(error) };
    }
}
/** Map one failed `createCheckout` onto a stable work-item failure. */
function createCheckoutFailure(failure, workItemId) {
    if (failure.code === CHECKOUT_ERROR.alreadyExists) {
        return workItemFailure(M10_ERROR_CODES.workItemAlreadyExists, failure.message, {
            workItemId,
            ...failure.details,
        });
    }
    if (failure.code === CHECKOUT_ERROR.pathGuard) {
        return workItemFailure(CHECKOUT_ERROR.pathGuard, failure.message, {
            workItemId,
            ...failure.details,
        });
    }
    if (failure.code === CHECKOUT_ERROR.invalidBaseRef) {
        return workItemFailure(CHECKOUT_ERROR.invalidBaseRef, failure.message, {
            workItemId,
            ...failure.details,
        });
    }
    return workItemFailure(M10_ERROR_CODES.workItemCreateFailed, failure.message, {
        workItemId,
        stage: 'create-checkout',
        ...failure.details,
        cleanup: cleanupFromCheckoutFailure(failure.details),
    });
}
/**
 * Create one work item: clone `.dsh-cowork/workitems/<id>` from the repository's
 * current HEAD, commit there on `cowork/<id>`, write the `active` v2 record, and
 * record a `work-item-created` activity.
 *
 * Failure order is deliberate. The provider, the id, the topic and a duplicate
 * record are all checked before any clone; a clone failure is reported with the
 * cleanup `createCheckout` already performed; an index write that fails or
 * loses a duplicate race removes the fresh clone; an activity write that fails
 * removes both the clone and the record it just wrote. Every path leaves no
 * partial index row, and every cleanup failure is reported as
 * `workitem/cleanup-failed` rather than hidden.
 */
export async function createWorkItem(deps, input) {
    if (input.isolationProvider !== CLONE_ISOLATION_PROVIDER) {
        return workItemFailure(M10_ERROR_CODES.workItemProviderUnsupported, `isolation provider "${input.isolationProvider}" is not supported; only "${CLONE_ISOLATION_PROVIDER}" is implemented`, { provider: input.isolationProvider });
    }
    const workItemId = input.workItemId ?? deps.newWorkItemId();
    if (!isValidWorkItemId(workItemId)) {
        return workItemFailure(CHECKOUT_ERROR.pathGuard, `work item id "${workItemId}" is not usable as a directory and branch name`, { workItemId });
    }
    const topicId = input.topicId;
    if (typeof topicId !== 'string' || topicId.trim() === '') {
        return workItemFailure(M10_ERROR_CODES.workItemCreateFailed, 'topicId must be a non-empty topic id', {
            workItemId,
        });
    }
    const before = await deps.store.readIndexDocument();
    if (!before.topics.some((topic) => topic.topicId === topicId)) {
        return workItemFailure(TOPIC_ERROR_CODES.topicNotFound, `topic not found in the project index: ${topicId}`, {
            topicId,
            workItemId,
        });
    }
    if (before.workItems.some((entry) => entry.workItemId === workItemId)) {
        return workItemFailure(M10_ERROR_CODES.workItemAlreadyExists, `work item ${workItemId} is already in the project index`, { workItemId, topicId });
    }
    const createdAt = deps.now();
    const created = await createCheckout(deps, {
        repoPath: input.repoPath,
        target: workItemIsolationTarget(workItemId),
        ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
    });
    if (!created.ok)
        return createCheckoutFailure(created, workItemId);
    let record;
    try {
        record = buildWorkItemRecord({
            workItemId,
            topicId,
            path: created.path,
            branch: created.branch,
            baseCommit: created.baseCommit,
        }, createdAt);
    }
    catch (error) {
        const cleanup = await removeWorkItemClone(deps, input.repoPath, workItemId);
        return workItemFailure(cleanup.error === null ? M10_ERROR_CODES.workItemCreateFailed : M10_ERROR_CODES.workItemCleanupFailed, `cannot build the work-item record: ${describeError(error)}`, { workItemId, cleanup });
    }
    // The duplicate check repeats inside the lock: two creators can race between
    // the read above and this write, and the loser must not append a second row.
    let duplicate = false;
    let writeError = null;
    try {
        await deps.store.mutateIndexDocument((document) => {
            if (document.workItems.some((entry) => entry.workItemId === workItemId)) {
                duplicate = true;
                return null;
            }
            return { ...document, workItems: [...document.workItems, record] };
        });
    }
    catch (error) {
        writeError = describeError(error);
    }
    if (duplicate || writeError !== null) {
        const cleanup = await removeWorkItemClone(deps, input.repoPath, workItemId);
        if (writeError === null) {
            return workItemFailure(M10_ERROR_CODES.workItemAlreadyExists, `work item ${workItemId} was created concurrently; the fresh clone was removed`, { workItemId, cleanup });
        }
        return workItemFailure(cleanup.error === null ? M10_ERROR_CODES.workItemCreateFailed : M10_ERROR_CODES.workItemCleanupFailed, `cannot write work item ${workItemId} to the project index: ${writeError}`, { workItemId, indexError: writeError, cleanup });
    }
    const event = buildActivityEvent({
        type: 'work-item-created',
        topicId,
        summary: `created work item ${workItemId}`,
        details: {
            workItemId,
            topicId,
            path: record.path,
            branch: record.branch,
            baseCommit: record.baseCommit,
        },
    }, createdAt);
    try {
        await deps.store.appendActivity(event);
    }
    catch (error) {
        // The record is already on disk, so this failure must undo both writes.
        const rollbackErrors = [];
        try {
            await deps.store.mutateIndexDocument((document) => ({
                ...document,
                workItems: document.workItems.filter((entry) => entry.workItemId !== workItemId),
            }));
        }
        catch (rollbackError) {
            rollbackErrors.push(`index: ${describeError(rollbackError)}`);
        }
        const cleanup = await removeWorkItemClone(deps, input.repoPath, workItemId);
        if (cleanup.error !== null)
            rollbackErrors.push(`checkout: ${cleanup.error}`);
        return workItemFailure(rollbackErrors.length === 0
            ? M10_ERROR_CODES.workItemCreateFailed
            : M10_ERROR_CODES.workItemCleanupFailed, `cannot record the work-item-created activity: ${describeError(error)}`, {
            workItemId,
            activityError: describeError(error),
            cleanup,
            ...(rollbackErrors.length === 0 ? {} : { rollbackErrors }),
        });
    }
    return { ok: true, workItem: workItemView(record) };
}
/**
 * Refresh one work item's `headCommit` from the clone itself.
 *
 * The clone path is rebuilt from the repository and the id (never trusted from
 * the record) and re-checked by the checkout path guard, so a tampered index row
 * cannot point git at an unrelated directory; a row whose path differs from the
 * canonical one is refused as `checkout/path-guard`. The index write only
 * happens when the commit actually moved, so a no-op capture does not churn
 * `updatedAt`; when it does move, `updatedAt` moves with it (`markWorkItem`).
 * Review requests and merges call this before comparing heads.
 */
export async function captureWorkItemHead(deps, input) {
    const document = await deps.store.readIndexDocument();
    const workItem = document.workItems.find((entry) => entry.workItemId === input.workItemId);
    if (workItem === undefined) {
        return workItemFailure(M10_ERROR_CODES.workItemNotFound, `work item not found in the project index: ${input.workItemId}`, {
            workItemId: input.workItemId,
        });
    }
    const resolved = resolveIsolationTarget(input.repoPath, workItemIsolationTarget(input.workItemId));
    if (!resolved.ok) {
        return workItemFailure(CHECKOUT_ERROR.pathGuard, resolved.message, { workItemId: input.workItemId });
    }
    if (workItem.path !== resolved.checkoutPath) {
        return workItemFailure(CHECKOUT_ERROR.pathGuard, `work item ${input.workItemId} records path ${workItem.path}, which is not its canonical clone ${resolved.checkoutPath}`, { workItemId: input.workItemId, path: workItem.path, expectedPath: resolved.checkoutPath });
    }
    const head = await deps.runGit(['rev-parse', 'HEAD'], resolved.checkoutPath);
    if (head.code !== 0) {
        const stderr = head.stderr.trim();
        return workItemFailure(CHECKOUT_ERROR.gitFailed, `cannot read HEAD in ${resolved.checkoutPath}: ${stderr === '' ? `git exited with code ${head.code}` : stderr}`, {
            workItemId: input.workItemId,
            exitCode: head.code,
            stderr: stderr.slice(0, GIT_STDERR_DETAIL_LIMIT),
        });
    }
    const headCommit = head.stdout.trim();
    if (headCommit === '') {
        return workItemFailure(CHECKOUT_ERROR.gitFailed, `HEAD in ${resolved.checkoutPath} is empty`, {
            workItemId: input.workItemId,
        });
    }
    if (headCommit === workItem.headCommit)
        return { ok: true, workItem: workItemView(workItem) };
    const next = markWorkItem(workItem, { headCommit }, deps.now());
    let missing = false;
    await deps.store.mutateIndexDocument((current) => {
        if (!current.workItems.some((entry) => entry.workItemId === input.workItemId)) {
            missing = true;
            return null;
        }
        return {
            ...current,
            workItems: current.workItems.map((entry) => entry.workItemId === input.workItemId ? next : entry),
        };
    });
    if (missing) {
        return workItemFailure(M10_ERROR_CODES.workItemNotFound, `work item ${input.workItemId} disappeared before its head could be recorded`, { workItemId: input.workItemId });
    }
    return { ok: true, workItem: workItemView(next) };
}
//# sourceMappingURL=work-item.js.map