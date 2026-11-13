/**
 * Post-merge teardown of one thread's isolated clone, as an ordered step list.
 *
 * Once `git merge` has landed, the merge cannot be taken back: a clone that
 * fails to delete, a workspace the registry refuses to drop, or a session that
 * will not archive are all *cleanup* problems. Turning them into a failed tool
 * result would tell the model the branch was not merged while it actually was,
 * and the retry would then merge twice. So every step is caught on its own, the
 * error text is collected, and the index update — the step that clears
 * `checkoutPath` — always runs last, whatever happened before it.
 *
 * The module deliberately imports nothing: the host services arrive as ports,
 * so this orchestration runs under `node --test` with recording fakes and no
 * DSH host, no `@deepseek-ai/dsh-tools` and no git.
 */
/** Error text for a caught value; never a stack trace. */
export function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Tear the clone down after a successful merge.
 *
 * Fixed order, and the reason it is fixed: the workspace must be resolved
 * before the clone directory is deleted (the host canonicalises the path with
 * realpath, so a deleted path no longer matches), and the index update must be
 * last, because it is the only step that records the merge as finished.
 */
export async function teardownMergedCheckout(plan, ports) {
    const cleanup = {
        removed: false,
        branchDeleted: false,
        workspaceId: null,
        workspaceDeleted: false,
        sessionArchived: false,
    };
    const cleanupErrors = [];
    // Resolve the workspace while the clone still exists.
    let workspaceId = null;
    try {
        const workspace = await ports.resolveWorkspace(plan.checkoutPath);
        workspaceId = workspace === undefined ? null : workspace.id;
    }
    catch (error) {
        cleanupErrors.push(`workspace lookup: ${describeError(error)}`);
    }
    cleanup.workspaceId = workspaceId;
    try {
        const removed = await ports.removeCheckout();
        if (removed.ok) {
            cleanup.removed = removed.removed;
            cleanup.branchDeleted = removed.branchDeleted;
        }
        else {
            cleanupErrors.push(`checkout: ${removed.message}`);
        }
    }
    catch (error) {
        cleanupErrors.push(`checkout: ${describeError(error)}`);
    }
    // A workspace id we failed to resolve leaves nothing to delete; the missing
    // entry is already reported as `workspace lookup` above.
    if (workspaceId !== null) {
        try {
            cleanup.workspaceDeleted = await ports.deleteWorkspace(workspaceId);
        }
        catch (error) {
            cleanupErrors.push(`workspace: ${describeError(error)}`);
        }
    }
    try {
        await ports.archiveSession(plan.threadId);
        cleanup.sessionArchived = true;
    }
    catch (error) {
        cleanupErrors.push(`session: ${describeError(error)}`);
    }
    // Last and unconditional: the merge landed, so the index must stop claiming
    // the thread still owns a clone. A failure here is reported, never rethrown.
    let thread = null;
    try {
        thread = (await ports.updateThread(plan.threadId)).thread;
    }
    catch (error) {
        cleanupErrors.push(`index: ${describeError(error)}`);
    }
    return { cleanup, cleanupErrors, thread };
}
/**
 * Run one index write and report its own failure instead of letting it escape.
 *
 * The merge-conflict path uses this: the conflict result is the real answer,
 * and an index write that fails afterwards must be visible in that same
 * failure payload (`statusUpdateError`) rather than replacing it with a
 * generic internal error.
 */
export async function applyThreadStatus(update) {
    try {
        const updated = await update();
        return { thread: updated.thread, error: null };
    }
    catch (error) {
        return { thread: null, error: describeError(error) };
    }
}
/**
 * Tear one work item's clone down after a successful merge.
 *
 * The same rule as {@link teardownMergedCheckout}: once the branch is merged the
 * merge cannot be taken back, so a clone that will not delete, a workspace the
 * registry refuses to drop, or an index write that fails are *cleanup*
 * problems — they are collected, never turned into a failed merge result that
 * would invite a second merge.
 *
 * The order is fixed for the same reason: the workspace is resolved while the
 * clone still exists (the host canonicalises the path), the clone and its
 * `cowork/<id>` branch are removed together by the checkout port, and the index
 * update runs last because it is the step that records the merge as finished.
 * A work item owns no session (execution units work in the clone without a DSH
 * session of their own), so the thread teardown's archive step has no analogue
 * here.
 */
export async function teardownMergedWorkItem(plan, ports) {
    const cleanup = {
        removed: false,
        branchDeleted: false,
        workspaceId: null,
        workspaceDeleted: false,
    };
    const cleanupErrors = [];
    // Resolve the workspace while the clone still exists.
    let workspaceId = null;
    try {
        const workspace = await ports.resolveWorkspace(plan.checkoutPath);
        workspaceId = workspace === undefined ? null : workspace.id;
    }
    catch (error) {
        cleanupErrors.push(`workspace lookup: ${describeError(error)}`);
    }
    cleanup.workspaceId = workspaceId;
    try {
        const removed = await ports.removeCheckout();
        if (removed.ok) {
            cleanup.removed = removed.removed;
            cleanup.branchDeleted = removed.branchDeleted;
        }
        else {
            cleanupErrors.push(`checkout: ${removed.message}`);
        }
    }
    catch (error) {
        cleanupErrors.push(`checkout: ${describeError(error)}`);
    }
    if (workspaceId !== null) {
        try {
            cleanup.workspaceDeleted = await ports.deleteWorkspace(workspaceId);
        }
        catch (error) {
            cleanupErrors.push(`workspace: ${describeError(error)}`);
        }
    }
    // Last and unconditional: the merge landed, so the index must say so.
    let workItem = null;
    try {
        workItem = (await ports.updateWorkItem()).workItem;
    }
    catch (error) {
        cleanupErrors.push(`index: ${describeError(error)}`);
    }
    return { cleanup, cleanupErrors, workItem };
}
//# sourceMappingURL=checkout-teardown.js.map