/** Result of one git invocation. Non-zero exits are values, not exceptions. */
export interface GitResult {
    code: number;
    stdout: string;
    stderr: string;
}
/** Runs git with an argument array in an explicit working directory. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitResult>;
/** Directory (relative to the repository root) that holds thread clones. */
export declare const CHECKOUT_ROOT_RELATIVE = ".dsh-cowork/threads";
/** Directory (relative to the repository root) that holds work-item clones. */
export declare const WORK_ITEM_ROOT_RELATIVE = ".dsh-cowork/workitems";
/** Branch prefix for a checkout's private commits. */
export declare const CHECKOUT_BRANCH_PREFIX = "cowork/";
/** Branch prefix for a work item's private commits (same namespace as threads). */
export declare const WORK_ITEM_BRANCH_PREFIX = "cowork/";
/**
 * Isolation provider this module implements. `src/tool-runtime.ts` owns the
 * configured default; M10 implements `clone` only and `src/work-item.ts`
 * refuses every other value instead of silently falling back.
 */
export declare const CLONE_ISOLATION_PROVIDER = "clone";
/** Timeout for one git invocation. No git call is retried automatically. */
export declare const GIT_TIMEOUT_MS = 30000;
/**
 * Upper bound on stderr copied into an outcome's `details`.
 *
 * Failure details travel to a model-facing tool result, so a verbose git error
 * must never become an unbounded string. Anything longer is truncated and
 * marked; the marker is part of the value, so a reader cannot mistake a clipped
 * message for the complete one.
 */
export declare const STDERR_DETAIL_LIMIT = 2000;
/** The paths and branch a thread id maps to. */
export interface CheckoutPaths {
    repoPath: string;
    threadId: string;
    path: string;
    branch: string;
}
/** The paths and branch a work-item id maps to. */
export interface WorkItemCheckoutPaths {
    repoPath: string;
    workItemId: string;
    path: string;
    branch: string;
}
/**
 * One isolation target: the id that names the clone, the directory under the
 * repository root that holds it, and the branch prefix it commits on. Making
 * this a value (instead of a thread-only signature) is what lets M10 add work
 * items without a second clone implementation.
 */
export interface IsolationTarget {
    id: string;
    rootRelative: string;
    branchPrefix: string;
}
/** Map a thread id to its isolation target (the M4 default). */
export declare function threadIsolationTarget(threadId: string): IsolationTarget;
/** Map a work-item id to its isolation target. */
export declare function workItemIsolationTarget(workItemId: string): IsolationTarget;
/**
 * Map a repository path and thread id to the checkout's location and branch.
 * Pure: no filesystem access, no validation (see the path guard used by the
 * operations). `repoPath` is resolved to an absolute path so the result does
 * not depend on the caller's cwd.
 */
export declare function checkoutPaths(repoPath: string, threadId: string): CheckoutPaths;
/**
 * Map a repository path and work-item id to the clone's location and branch.
 * Pure, like {@link checkoutPaths}; validation happens in the path guard.
 */
export declare function workItemCheckoutPaths(repoPath: string, workItemId: string): WorkItemCheckoutPaths;
/** Stable error codes callers can branch on without parsing messages. */
export declare const CHECKOUT_ERROR: {
    readonly notFound: "checkout/not-found";
    readonly alreadyExists: "checkout/already-exists";
    readonly createFailed: "checkout/create-failed";
    readonly invalidBaseRef: "checkout/invalid-base-ref";
    readonly pathGuard: "checkout/path-guard";
    readonly dirty: "checkout/dirty";
    readonly mergeConflict: "checkout/merge-conflict";
    readonly mergeFailed: "checkout/merge-failed";
    readonly gitFailed: "checkout/git-failed";
};
/** Union of every value in {@link CHECKOUT_ERROR}. */
export type CheckoutErrorCode = (typeof CHECKOUT_ERROR)[keyof typeof CHECKOUT_ERROR];
/** Discriminated result of a checkout operation. */
export type CheckoutOutcome<T> = ({
    ok: true;
} & T) | {
    ok: false;
    code: CheckoutErrorCode;
    message: string;
    details?: Record<string, unknown>;
};
/** Injected git runner; the only I/O this module performs through git. */
export interface CheckoutDeps {
    runGit: GitRunner;
}
/** What one thread checkout currently looks like. */
export interface CheckoutStatus {
    exists: boolean;
    dirty: boolean;
    branch: string | null;
    head: string | null;
    commitsAhead: number | null;
}
/** Successful path-guard resolution of one isolation target. */
export interface IsolationTargetSuccess {
    ok: true;
    /** Target the resolution was for (id, root, branch prefix). */
    target: IsolationTarget;
    repoPath: string;
    rootPath: string;
    checkoutPath: string;
    branch: string;
}
/** Rejected path-guard resolution; no git command may run after this. */
export interface IsolationTargetFailure {
    ok: false;
    message: string;
}
/** Result of {@link resolveIsolationTarget}: a guarded checkout or the reason. */
export type IsolationTargetResolution = IsolationTargetSuccess | IsolationTargetFailure;
/**
 * Everything the checkout operations accept instead of a bare thread id: either
 * the legacy `threadId` (resolved to the thread target) or an explicit
 * {@link IsolationTarget}. Exactly one of the two must be present.
 */
export interface CheckoutTargetSelector {
    repoPath: string;
    /** Legacy thread id; resolves to the thread target when `target` is absent. */
    threadId?: string;
    /** Explicit isolation target (work items, future providers). */
    target?: IsolationTarget;
}
/**
 * Resolve one target's clone path and branch under the path guard, without
 * touching git. `src/work-item.ts` uses this to read inside a work item's clone
 * with the same canonical/realpath rules every checkout operation applies.
 */
export declare function resolveIsolationTarget(repoPath: string, target: IsolationTarget): IsolationTargetResolution;
/**
 * Create one target's clone from `baseRef` and switch it to the target branch.
 *
 * Order is load-bearing: guard → existing check → resolve the base ref in the
 * source repository → create the parent directory → clone → create the target
 * branch. The base ref is resolved to a commit before cloning so the checkout
 * is pinned to one commit even if the ref moves mid-flight. Any failure after
 * the clone starts removes the directory this function created; the source
 * repository is never modified.
 */
export declare function createCheckout(deps: CheckoutDeps, input: CheckoutTargetSelector & {
    baseRef?: string;
}): Promise<CheckoutOutcome<{
    path: string;
    branch: string;
    baseCommit: string;
}>>;
/**
 * Inspect one checkout.
 *
 * This signature cannot carry an error, so git failures degrade conservatively
 * instead of throwing: a failed `status` reports `dirty: true` (assume the
 * checkout is unsafe to merge), a failed `branch`/`rev-parse` reports `null`,
 * and a failed commit count reports `null`. A missing directory is not an
 * error and reports an all-empty status. Only an invalid/path-escaping target
 * id throws, because continuing would inspect an unrelated directory.
 */
export declare function inspectCheckout(deps: CheckoutDeps, input: CheckoutTargetSelector & {
    baseCommit?: string;
}): Promise<CheckoutStatus>;
/**
 * Fetch one target's branch into the source repository and merge it with
 * `--no-ff`. The repository's branch of the same name is recreated from the
 * checkout on every merge, so a stale branch left by an earlier interrupted
 * run is deleted first; the checkout's own branch is never touched here.
 *
 * A dirty checkout is refused before any fetch/merge. On conflict the
 * conflicted merge is aborted, the files are reported, and the thread branch
 * is kept so the thread can resolve and retry. Any other merge failure aborts
 * only when a merge is actually in progress (`MERGE_HEAD` exists), preserving
 * the repository state otherwise.
 *
 * The abort itself is checked: a failed `git merge --abort` leaves the main
 * repository mid-merge, so it is reported as {@link CHECKOUT_ERROR.gitFailed}
 * with the abort stage and both stderr values, never as a clean conflict or
 * merge failure. Every stderr copied into `details` is truncated to
 * {@link STDERR_DETAIL_LIMIT} and marked when text was dropped.
 */
export declare function mergeCheckout(deps: CheckoutDeps, input: CheckoutTargetSelector & {
    message?: string;
}): Promise<CheckoutOutcome<{
    merged: boolean;
    commit: string | null;
    conflictFiles: string[];
    branch: string;
}>>;
/**
 * Remove one target's checkout directory and its repository-side branch.
 *
 * A missing directory or branch is not an error: removal is used both to clean
 * up and to assert absence, and asking twice is harmless. The path guard runs
 * first so a bad target id can never delete something outside its root.
 */
export declare function removeCheckout(deps: CheckoutDeps, input: CheckoutTargetSelector): Promise<CheckoutOutcome<{
    removed: boolean;
    branchDeleted: boolean;
}>>;
/**
 * Default {@link GitRunner}: `git` with an argument array, explicit cwd, a
 * 30-second timeout, and no shell. Non-zero exits and spawn failures are
 * reported as values so callers map them to checkout error codes.
 */
export declare const nodeGitRunner: GitRunner;
