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
/** What one teardown left behind, reported as the tool's `cleanup` payload. */
export interface MergeCleanup {
    removed: boolean;
    branchDeleted: boolean;
    workspaceId: string | null;
    workspaceDeleted: boolean;
    sessionArchived: boolean;
}
/** The checkout module's removal outcome, narrowed to what teardown needs. */
export type CheckoutRemoval = {
    ok: true;
    removed: boolean;
    branchDeleted: boolean;
} | {
    ok: false;
    message: string;
};
/**
 * Host services, as functions. `updateThread` is the index write that drops
 * `checkoutPath` and marks the thread done; it is expected to run even when the
 * steps above it failed, and it receives the id rather than a path so the
 * caller can rebuild its own store handle.
 */
export interface MergeTeardownPorts<TThread> {
    resolveWorkspace(path: string): Promise<{
        id: string;
    } | undefined>;
    removeCheckout(): Promise<CheckoutRemoval>;
    deleteWorkspace(workspaceId: string): Promise<boolean>;
    archiveSession(threadId: string): Promise<void>;
    updateThread(threadId: string): Promise<{
        thread: TThread | null;
    }>;
}
export interface MergeTeardownPlan {
    checkoutPath: string;
    threadId: string;
}
export interface MergeTeardownResult<TThread> {
    cleanup: MergeCleanup;
    /** One entry per failed step, prefixed with the step name; empty on a clean run. */
    cleanupErrors: string[];
    /** The updated index record, or null when the index write itself failed. */
    thread: TThread | null;
}
/** Error text for a caught value; never a stack trace. */
export declare function describeError(error: unknown): string;
/**
 * Tear the clone down after a successful merge.
 *
 * Fixed order, and the reason it is fixed: the workspace must be resolved
 * before the clone directory is deleted (the host canonicalises the path with
 * realpath, so a deleted path no longer matches), and the index update must be
 * last, because it is the only step that records the merge as finished.
 */
export declare function teardownMergedCheckout<TThread>(plan: MergeTeardownPlan, ports: MergeTeardownPorts<TThread>): Promise<MergeTeardownResult<TThread>>;
/**
 * Run one index write and report its own failure instead of letting it escape.
 *
 * The merge-conflict path uses this: the conflict result is the real answer,
 * and an index write that fails afterwards must be visible in that same
 * failure payload (`statusUpdateError`) rather than replacing it with a
 * generic internal error.
 */
export declare function applyThreadStatus<TThread>(update: () => Promise<{
    thread: TThread | null;
}>): Promise<{
    thread: TThread | null;
    error: string | null;
}>;
/** What one work-item teardown left behind, reported as `cleanup`. */
export interface WorkItemCleanup {
    removed: boolean;
    branchDeleted: boolean;
    workspaceId: string | null;
    workspaceDeleted: boolean;
}
/** The ports one work-item teardown needs; they match the thread teardown shape. */
export interface WorkItemTeardownPorts<TWorkItem> {
    resolveWorkspace(path: string): Promise<{
        id: string;
    } | undefined>;
    removeCheckout(): Promise<CheckoutRemoval>;
    deleteWorkspace(workspaceId: string): Promise<boolean>;
    updateWorkItem(): Promise<{
        workItem: TWorkItem | null;
    }>;
}
export interface WorkItemTeardownPlan {
    checkoutPath: string;
    workItemId: string;
}
export interface WorkItemTeardownResult<TWorkItem> {
    cleanup: WorkItemCleanup;
    /** One entry per failed step, prefixed with the step name; empty on a clean run. */
    cleanupErrors: string[];
    /** The updated work-item view, or null when the index write itself failed. */
    workItem: TWorkItem | null;
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
export declare function teardownMergedWorkItem<TWorkItem>(plan: WorkItemTeardownPlan, ports: WorkItemTeardownPorts<TWorkItem>): Promise<WorkItemTeardownResult<TWorkItem>>;
