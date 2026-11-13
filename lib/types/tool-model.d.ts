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
export declare const ERROR_CODES: {
    readonly agentUnavailable: "exec/agent-unavailable";
    readonly roleForbidden: "role/forbidden";
    readonly projectNotInitialized: "project/not-initialized";
    readonly handoffInvalid: "handoff/invalid";
    readonly intentRequired: "route/intent-required";
    readonly sessionMissing: "thread/session-missing";
    readonly storeCorrupt: "store/corrupt";
    readonly memoryInvalid: "memory/invalid";
    readonly memoryWriteFailed: "memory/write-failed";
    readonly threadNotFound: "thread/not-found";
    readonly checkoutNotFound: "checkout/not-found";
    readonly checkoutAlreadyExists: "checkout/already-exists";
    readonly checkoutCreateFailed: "checkout/create-failed";
    readonly checkoutInvalidBaseRef: "checkout/invalid-base-ref";
    readonly checkoutPathGuard: "checkout/path-guard";
    readonly checkoutDirty: "checkout/dirty";
    readonly checkoutMergeConflict: "checkout/merge-conflict";
    readonly checkoutMergeFailed: "checkout/merge-failed";
    readonly checkoutGitFailed: "checkout/git-failed";
    readonly checkoutNotReady: "checkout/not-ready";
    readonly reviewNotReady: "review/not-ready";
    readonly reviewAlreadyPending: "review/already-pending";
    readonly reviewNotReviewer: "review/not-reviewer";
    readonly reviewSelfReview: "review/self-review";
    readonly reviewVerdictInvalid: "review/verdict-invalid";
    readonly reviewNotPassed: "review/not-passed";
    readonly reviewOverrideReasonRequired: "review/override-reason-required";
    readonly reviewSessionFailed: "review/session-failed";
    readonly reviewPromptFailed: "review/prompt-failed";
    readonly reviewWriteFailed: "review/write-failed";
};
/**
 * Wire codes introduced by the M9.3b topic/route tools. Kept separate from the
 * long-stable {@link ERROR_CODES} table so adding a new tool family does not
 * rewrite the pinned compatibility list.
 */
export declare const TOPIC_ERROR_CODES: {
    readonly routeBriefTooLong: "route/brief-too-long";
    readonly routeArgsConflict: "route/args-conflict";
    readonly topicNotFound: "topic/not-found";
    readonly topicTitleRequired: "topic/title-required";
    readonly topicInvalidOwnedPaths: "topic/invalid-owned-paths";
};
/**
 * Wire codes introduced by M10 (review requests, work items, serial merge).
 * Every M10 module returns one of these; the table is the one home for them,
 * for the same reason {@link TOPIC_ERROR_CODES} is separate from the pinned
 * {@link ERROR_CODES} list. Added once in M10.1 — later M10 stages must not
 * need to touch this table again.
 */
export declare const M10_ERROR_CODES: {
    readonly reviewRequestInvalid: "review/request-invalid";
    readonly reviewPathOutside: "review/path-outside";
    readonly reviewBaseNotAncestor: "review/base-not-ancestor";
    readonly reviewBaseEqualsHead: "review/base-equals-head";
    readonly reviewDirtyWorktree: "review/dirty-worktree";
    readonly reviewEmptyDiff: "review/empty-diff";
    readonly reviewChangedPathsMismatch: "review/changed-paths-mismatch";
    readonly reviewRequestNotFound: "review/request-not-found";
    readonly reviewNotPending: "review/not-pending";
    readonly reviewAlreadyReviewed: "review/already-reviewed";
    readonly reviewPreviousInvalid: "review/previous-invalid";
    readonly workItemNotFound: "workitem/not-found";
    readonly workItemAlreadyExists: "workitem/already-exists";
    readonly workItemProviderUnsupported: "workitem/provider-unsupported";
    readonly workItemCreateFailed: "workitem/create-failed";
    readonly workItemCleanupFailed: "workitem/cleanup-failed";
    readonly workItemNotReady: "workitem/not-ready";
    readonly checkoutProtectedBranch: "checkout/protected-branch";
    readonly checkoutHeadMismatch: "checkout/head-mismatch";
};
/** The one failure envelope every tool returns instead of throwing. */
export interface ToolFailure {
    ok: false;
    error: {
        code: string;
        message: string;
        details?: unknown;
    };
}
/** Build a failure envelope. */
export declare function failure(code: string, message: string, details?: unknown): ToolFailure;
/** Build a success envelope: the payload plus the `ok: true` discriminant. */
export declare function success<T extends Record<string, unknown>>(payload: T): {
    ok: true;
} & T;
/** The calling session, read from the structured execution identity only. */
export interface CallerIdentity {
    sessionId: string;
    cwd: string;
    agentPreset?: string;
}
/**
 * Read the caller from `exec.agent`. Both the session id and the session
 * header's cwd must be non-empty strings; anything else returns `null` so the
 * tool can fail closed instead of guessing which project was meant.
 */
export declare function readCaller(exec: unknown): CallerIdentity | null;
/** The slice of the project index the role gate reads. */
export interface RoleIndexView {
    masterSessionId: string;
    threads: ReadonlyArray<{
        threadId: string;
    }>;
}
/** Which party a tool is restricted to. */
export type RoleName = 'master' | 'thread' | 'master-or-thread';
/**
 * Check whether the caller may use a tool that requires `role`. Returns `null`
 * when allowed, otherwise a `role/forbidden` failure naming the expected role,
 * the caller, and the registered master.
 */
export declare function checkRole(role: RoleName, caller: CallerIdentity, index: RoleIndexView): ToolFailure | null;
/** What a caller may do with the master role when it opens the project. */
export type MasterClaim = {
    action: 'current';
} | {
    action: 'takeover';
    previousMasterSessionId: string;
};
/**
 * Decide whether `caller` may act as the project master, and whether it may
 * take the role over from the session the index currently records.
 *
 * Taking over is deliberately explicit: a different session is refused unless
 * the call passes `takeOver: true`, and a session the index records as a thread
 * can never take over — a thread hands work back to the master instead of
 * becoming one. This helper only decides; the store performs the write.
 */
export declare function claimMaster(caller: CallerIdentity, index: RoleIndexView, options?: {
    takeOver?: boolean;
}): MasterClaim | ToolFailure;
/**
 * The opener a new cowork topic receives: where the project is, which topic it
 * owns, what it must not touch, and the handoff contract it cannot skip. An
 * isolated topic also learns its clone path and the branch the master merges.
 */
export declare function buildThreadBrief(input: {
    repoPath: string;
    subject: string;
    topicId: string;
    intent?: string;
    checkoutPath?: string | null;
}): string;
/**
 * The `findings` parameter schema of `cowork_review_verdict`. It lives here,
 * not in src/review.ts, because it is a tool-boundary concern: the review
 * model owns the semantics, the tool model owns what the model is asked for.
 * The shape is kept `as const` so it satisfies the host's parameter-spec type.
 */
export declare const REVIEW_FINDING_PARAMETER: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly properties: {
        readonly id: {
            readonly type: "string";
            readonly required: true;
            readonly description: "Short finding id, e.g. F1.";
        };
        readonly severity: {
            readonly type: "string";
            readonly required: true;
            readonly enum: readonly ["blocker", "high", "medium", "low"];
            readonly description: "How serious the finding is.";
        };
        readonly problem: {
            readonly type: "string";
            readonly required: true;
            readonly description: "What is wrong.";
        };
        readonly requiredFix: {
            readonly type: "string";
            readonly required: true;
            readonly description: "What must change.";
        };
        readonly file: {
            readonly type: "string";
            readonly description: "File the finding is in, when known.";
        };
        readonly line: {
            readonly type: "integer";
            readonly description: "Positive line number, when known.";
        };
    };
};
/** The `verification` row schema, shared by `cowork_review_verdict`. */
export declare const REVIEW_VERIFICATION_PARAMETER: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly properties: {
        readonly command: {
            readonly type: "string";
            readonly required: true;
            readonly description: "Exact command that was run.";
        };
        readonly exitCode: {
            readonly type: "integer";
            readonly required: true;
            readonly description: "Exit code the command returned.";
        };
        readonly evidence: {
            readonly type: "string";
            readonly required: true;
            readonly description: "Short output or result that proves it.";
        };
    };
};
