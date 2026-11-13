import { CHECKOUT_ERROR } from './checkout.js';
import type { CheckoutDeps } from './checkout.js';
import { M10_ERROR_CODES, TOPIC_ERROR_CODES } from './tool-model.js';
import { WORK_ITEM_STATUSES } from './store-schema.js';
import type { ActivityEvent, ProjectIndexV2, WorkItemRecordV2, WorkItemStatus } from './store-schema.js';
export { WORK_ITEM_STATUSES };
export type { WorkItemStatus };
/**
 * A work-item id that is also usable as a directory and branch name. Kept
 * identical to the checkout path guard's `TARGET_ID_PATTERN`
 * (`src/checkout.ts`): a dotted id must fail here rather than pass this check
 * and be refused later by `createCheckout`.
 */
export declare const WORK_ITEM_ID_PATTERN: RegExp;
/** Statuses that count as work in flight (PLAN-V0.2 §5.1: active + reviewing). */
export declare const ACTIVE_WORK_ITEM_STATUSES: readonly ["active", "reviewing"];
/** Statuses a work item may be merged from. */
export declare const MERGEABLE_WORK_ITEM_STATUSES: readonly ["reviewing"];
/** Longest path `workItemView` returns, in characters. */
export declare const WORK_ITEM_VIEW_PATH_MAX_CHARS = 1024;
/** Longest branch `workItemView` returns, in characters. */
export declare const WORK_ITEM_VIEW_BRANCH_MAX_CHARS = 256;
/** Longest commit id `workItemView` returns, in characters. */
export declare const WORK_ITEM_VIEW_COMMIT_MAX_CHARS = 64;
/** Whether a value is a usable work-item id. */
export declare function isValidWorkItemId(value: unknown): value is string;
/** Whether a work item in this status may be merged by the master. */
export declare function isMergeableWorkItemStatus(status: unknown): boolean;
/**
 * How many work items of one topic are in flight: `active` plus `reviewing`.
 * Both count, because a topic waiting on a review is still working and marking
 * it resolved has no undo (PLAN-V0.2 §5.1, KI-24).
 */
export declare function activeWorkItemCount(document: {
    workItems?: readonly WorkItemRecordV2[];
} | null | undefined, topicId: string): number;
/** What the caller knows when a work item is created. */
export interface NewWorkItemInput {
    workItemId: string;
    topicId: string;
    /** Absolute clone path (`.dsh-cowork/workitems/<id>`). */
    path: string;
    /** Branch the clone is on (`cowork/<id>`). */
    branch: string;
    /** Commit the clone was created from, or null when git could not be read. */
    baseCommit: string | null;
}
/**
 * Build the `active` record of one freshly created work item. A programmer error
 * in the caller's input throws here rather than writing an index row that
 * `projectIndexV2Problems` would refuse.
 */
export declare function buildWorkItemRecord(input: NewWorkItemInput, createdAt: Date): WorkItemRecordV2;
/** The fields of a work item one marker update may change. */
export interface WorkItemPatch {
    status?: WorkItemStatus;
    baseCommit?: string | null;
    headCommit?: string | null;
    path?: string;
    branch?: string;
}
/**
 * Stamp one marker update: the patch replaces the named fields, `updatedAt`
 * always moves, and every other field (identity, topic, timestamps) survives.
 * `headCommit` is refreshed here before a review request and before a merge.
 */
export declare function markWorkItem(workItem: WorkItemRecordV2, patch: WorkItemPatch, now: Date): WorkItemRecordV2;
/** The bounded work-item row a tool returns. */
export interface WorkItemView {
    workItemId: string;
    topicId: string;
    path: string;
    branch: string;
    baseCommit: string | null;
    headCommit: string | null;
    status: WorkItemStatus;
    createdAt: string;
    updatedAt: string;
}
/**
 * Project one work item onto the bounded tool view. Path and branch are cut, so
 * a pathological clone path cannot blow the status payload; identity, status,
 * and the two commits are returned whole because a merge decision needs them.
 */
export declare function workItemView(workItem: WorkItemRecordV2): WorkItemView;
/**
 * The narrow store port every flow here needs: re-read the canonical document,
 * add or patch a record under the project lock, and append one activity event.
 * `ProjectStore` implements all three; nothing else about it is visible here.
 */
export interface WorkItemStorePort {
    readIndexDocument(): Promise<ProjectIndexV2>;
    mutateIndexDocument(mutator: (document: ProjectIndexV2) => ProjectIndexV2 | null): Promise<ProjectIndexV2>;
    appendActivity(event: ActivityEvent): Promise<void>;
}
/** Stable codes the work-item flows return; every one already exists. */
export type WorkItemFailureCode = typeof M10_ERROR_CODES.workItemNotFound | typeof M10_ERROR_CODES.workItemAlreadyExists | typeof M10_ERROR_CODES.workItemProviderUnsupported | typeof M10_ERROR_CODES.workItemCreateFailed | typeof M10_ERROR_CODES.workItemCleanupFailed | typeof CHECKOUT_ERROR.pathGuard | typeof CHECKOUT_ERROR.invalidBaseRef | typeof CHECKOUT_ERROR.gitFailed | typeof TOPIC_ERROR_CODES.topicNotFound;
/** One failed work-item flow, shaped like every other tool failure. */
export interface WorkItemFailure {
    ok: false;
    code: WorkItemFailureCode;
    message: string;
    details?: Record<string, unknown>;
}
/** What one failure cleaned up, reported instead of silently discarded. */
export interface WorkItemCleanupReport {
    removed: boolean;
    branchDeleted: boolean;
    error: string | null;
}
/** Everything `createWorkItem` needs; git, the store, the clock, ids arrive here. */
export interface CreateWorkItemDeps extends CheckoutDeps {
    store: WorkItemStorePort;
    /** Injected clock; this module never reads the wall clock itself. */
    now: () => Date;
    /** Id source for a creation that does not name one (the tool layer passes a UUID). */
    newWorkItemId: () => string;
}
/** What a caller asks for when it creates a work item. */
export interface CreateWorkItemInput {
    /** Repository whose current HEAD the clone starts from by default. */
    repoPath: string;
    /** Topic the work item belongs to; it must already exist in the index. */
    topicId: string;
    /** Explicit id; generated by `deps.newWorkItemId` when absent. */
    workItemId?: string;
    /** Ref the clone starts from; defaults to the repository's current HEAD. */
    baseRef?: string;
    /** Configured isolation provider; only `clone` is implemented. */
    isolationProvider: string;
}
/** Successful creation, or a stable failure that left nothing half-written. */
export type CreateWorkItemResult = {
    ok: true;
    workItem: WorkItemView;
} | WorkItemFailure;
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
export declare function createWorkItem(deps: CreateWorkItemDeps, input: CreateWorkItemInput): Promise<CreateWorkItemResult>;
/** Everything `captureWorkItemHead` needs: git in the clone, the index, a clock. */
export interface CaptureWorkItemHeadDeps extends CheckoutDeps {
    store: Pick<WorkItemStorePort, 'readIndexDocument' | 'mutateIndexDocument'>;
    now: () => Date;
}
/** Successful head capture, or a stable failure that changed nothing. */
export type CaptureWorkItemHeadResult = {
    ok: true;
    workItem: WorkItemView;
} | WorkItemFailure;
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
export declare function captureWorkItemHead(deps: CaptureWorkItemHeadDeps, input: {
    repoPath: string;
    workItemId: string;
}): Promise<CaptureWorkItemHeadResult>;
