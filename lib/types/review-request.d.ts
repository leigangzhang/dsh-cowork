import type { ToolFailure } from './tool-model.js';
import type { InboxKind, ReviewFinding, ReviewStatus, ReviewVerdict, ReviewVerification, WorkItemStatus } from './store-schema.js';
/** On-disk version of one review request file. */
export declare const REVIEW_REQUEST_VERSION = 1;
/** Suffix of one review request file. */
export declare const REVIEW_REQUEST_FILE_SUFFIX = ".json";
/** A request/topic id that may be used inside a file name (and only that). */
export declare const REVIEW_REQUEST_ID_PATTERN: RegExp;
/** Upper bound of `purpose`, in characters. */
export declare const REVIEW_PURPOSE_MAX_CHARS = 500;
/** Upper bound of `notes`, in characters. */
export declare const REVIEW_NOTES_MAX_CHARS = 2000;
/** Upper bound of a verdict `summary`, in characters. */
export declare const REVIEW_SUMMARY_MAX_CHARS = 2000;
/** Upper bound of an absolute review path, in characters. */
export declare const REVIEW_PATH_MAX_CHARS = 1024;
/** Upper bound of a branch name, in characters. */
export declare const REVIEW_BRANCH_MAX_CHARS = 256;
/** Most keys `extra` may carry. */
export declare const REVIEW_EXTRA_MAX_KEYS = 20;
/** Longest accepted key of `extra`, in characters. */
export declare const REVIEW_EXTRA_KEY_MAX_CHARS = 128;
/** Largest serialized `extra` value, in bytes. */
export declare const REVIEW_EXTRA_MAX_BYTES = 4096;
/** Deepest container nesting of one `extra` value. */
export declare const REVIEW_EXTRA_MAX_DEPTH = 4;
/** Most changed paths one request may carry. */
export declare const REVIEW_CHANGED_PATHS_MAX = 500;
/** Most verification rows one request may carry. */
export declare const REVIEW_VERIFICATION_MAX_ROWS = 50;
/** Longest accepted verification command or evidence, in characters. */
export declare const REVIEW_VERIFICATION_FIELD_MAX_CHARS = 2000;
/** Most findings one verdict may carry. */
export declare const REVIEW_FINDINGS_MAX_ROWS = 200;
/** Longest accepted finding field, in characters. */
export declare const REVIEW_FINDING_FIELD_MAX_CHARS = 2000;
/** Hard ceiling of the reviewer brief, in characters. */
export declare const REVIEW_BRIEF_MAX_CHARS = 8000;
/** Longest single line the brief builder writes, in characters. */
export declare const REVIEW_BRIEF_LINE_MAX_CHARS = 500;
/** Most changed paths the brief lists before summarising the rest. */
export declare const REVIEW_BRIEF_MAX_PATHS_SHOWN = 60;
/** Most verification rows the brief lists. */
export declare const REVIEW_BRIEF_MAX_ROWS_SHOWN = 10;
/** Most findings of the previous round the brief lists. */
export declare const REVIEW_BRIEF_MAX_FINDINGS_SHOWN = 10;
/** Lossless JSON value accepted in `extra`. */
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
/** One rejected field of untrusted input. */
export interface ReviewFieldError {
    field: string;
    message: string;
}
/** A validated request: what the tool stamps into a pending record. */
export interface ReviewRequestDraft {
    topicId: string;
    workItemId: string | null;
    purpose: string;
    notes: string;
    extra: Record<string, JsonValue>;
    baseCommit: string;
    headCommit: string;
    path: string;
    branch: string | null;
    changedPaths: string[];
    verification: ReviewVerification[];
    previousRequestId: string | null;
}
/** One review request file (`reviews/<topicId>-<requestId>.json`). */
export interface ReviewRequestRecord extends ReviewRequestDraft {
    version: 1;
    requestId: string;
    status: ReviewStatus;
    reviewerSessionId: string | null;
    requestedAt: string;
    reviewedAt: string | null;
    summary: string | null;
    findings: ReviewFinding[];
    reviewVerification: ReviewVerification[];
}
/** What the caller knows about the request before the model's input is read. */
export interface ReviewRequestValidationOptions {
    /** Topic the request belongs to (from the index, never the model). */
    topicId: string;
    /** Work item under review, or null for a shared-tree request. */
    workItemId: string | null;
    /** Absolute repository root the request must stay inside. */
    repoPath: string;
    /** Absolute work-item checkout the request may point at, when any. */
    workItemPath?: string | null;
    /** Branch the request reviews, derived from git. */
    branch?: string | null;
    /** Paths `git diff base..head` reported; derived, never trusted from input. */
    changedPaths?: readonly string[];
}
/** Result of validating untrusted review-request input. */
export type ReviewRequestValidation = {
    ok: true;
    value: ReviewRequestDraft;
} | {
    ok: false;
    code: string;
    message: string;
    errors: ReviewFieldError[];
};
/** Result of parsing one stored request file. */
export type ReviewRequestParse = {
    ok: true;
    record: ReviewRequestRecord;
} | {
    ok: false;
    problems: string[];
};
/** The plugin-supplied identity of one request. */
export interface ReviewRequestStamp {
    /** Freshly generated id (a UUID in production). */
    requestId: string;
    /** Session of the reviewer that must answer this request. */
    reviewerSessionId: string;
    /** When the request was accepted. */
    requestedAt: Date;
}
/** Everything the previous-request chain check needs. */
export interface PreviousRequestLookup {
    previousRequestId: string | null;
    previous: ReviewRequestRecord | null;
    topicId: string;
    workItemId: string | null;
}
/** Where one verdict moves the topic, and whether it wakes the master. */
export interface ReviewOutcome {
    /** Review state the topic records. */
    reviewStatus: ReviewStatus;
    /** Whether the topic must be marked blocked. */
    blocked: boolean;
    /** A verdict always clears the in-flight marker. */
    awaitingReview: false;
    /** Whether the findings are delivered back to the topic session. */
    deliverToTopic: boolean;
    /** Inbox kind for the master, or null when the master must not be woken. */
    inboxKind: InboxKind | null;
    /** Whether the work item enters the master's merge queue. */
    mergeNeeded: boolean;
}
/** Everything the merge gate reads. */
export interface MergeGateInput {
    /** The request the merge would rely on, or null when none was found. */
    request: ReviewRequestRecord | null;
    /** Current HEAD of the repository the merge would land in. */
    headCommit: string | null;
    /** Whether `request.baseCommit` is an ancestor of `headCommit` (git answered). */
    baseIsAncestor: boolean;
    /** Current status of the request's work item, or null when it is unknown. */
    workItemStatus: WorkItemStatus | null;
    /** Whether the work-item checkout has no uncommitted change. */
    workTreeClean: boolean;
}
/** The merge decision: allowed, or a refusal the caller returns as-is. */
export type MergeGateResult = {
    ok: true;
} | {
    ok: false;
    failure: ToolFailure;
};
/** What the reviewer briefing needs. */
export interface ReviewBriefInput {
    /** The pending request the reviewer must answer. */
    request: ReviewRequestRecord;
    /** The previous terminal request of the same topic/work item, when any. */
    previous?: ReviewRequestRecord | null;
}
/** Whether a value may be used as one dash-joined component of a file name. */
export declare function isSafeFileNamePart(value: unknown): value is string;
/** Whether a value is a usable review request id. */
export declare function isValidReviewRequestId(value: unknown): value is string;
/**
 * Validate untrusted `cowork_review_request` input against the trusted scope the
 * tool derived from the index and git.
 *
 * Every problem is collected before refusing, so one call names every field the
 * model must fix. Nothing is written here: a refused request leaves no file, no
 * reviewer, and no index change behind.
 */
export declare function validateReviewRequestInput(input: unknown, options: ReviewRequestValidationOptions): ReviewRequestValidation;
/** A validated verdict, before it is stamped into the request file. */
export interface ReviewVerdictDraft {
    requestId: string;
    verdict: ReviewVerdict;
    summary: string;
    findings: ReviewFinding[];
    verification: ReviewVerification[];
}
/** Result of validating untrusted `cowork_review_verdict` input. */
export type ReviewVerdictValidation = {
    ok: true;
    value: ReviewVerdictDraft;
} | {
    ok: false;
    code: string;
    message: string;
    errors: ReviewFieldError[];
};
/**
 * Validate untrusted verdict input, collecting every field problem at once. The
 * request id and the reviewer session are bound by the tool against the stored
 * request, not trusted from the model. `needs_revision` and `reject` must name
 * at least one finding (the topic has to know what to fix); `pass` may carry
 * none.
 */
export declare function validateReviewVerdictInput(input: unknown): ReviewVerdictValidation;
/**
 * Stamp a validated draft into the pending record the tool writes. The status
 * is always `pending`: a verdict rewrites the same file through the record's
 * terminal shape. A programmer error in the stamp throws rather than writing a
 * record the parser would refuse.
 */
export declare function buildReviewRequestRecord(draft: ReviewRequestDraft, stamp: ReviewRequestStamp): ReviewRequestRecord;
/** Serialize one request record the way the file layer writes it. */
export declare function serializeReviewRequestRecord(record: ReviewRequestRecord): string;
/**
 * Every schema problem of one stored request record. Strict by design: the file
 * this plugin writes must be as strict as the input that produced it, and the
 * legacy verdict-only record (a different shape with the same version) must be
 * refused instead of partially read.
 */
export declare function reviewRequestRecordProblems(record: unknown): string[];
/**
 * Parse one request file. A missing field, an unknown status, a pending record
 * that carries a verdict, an answered record without a review timestamp, or the
 * legacy verdict-only record all refuse with the problems named; nothing is
 * repaired or guessed.
 */
export declare function parseReviewRequestRecord(text: string): ReviewRequestParse;
/** File name of one request, or null when an id cannot be a file name. */
export declare function reviewRequestFileName(topicId: string, requestId: string): string | null;
/** Absolute file path of one request under the reviews directory, or null. */
export declare function reviewRequestFilePath(reviewsDir: string, topicId: string, requestId: string): string | null;
/**
 * Check the `previousRequestId` a re-review references. It must exist, belong to
 * the same topic and the same work item (a shared-tree request and a work-item
 * request are different chains), and already be answered: a pending predecessor
 * means two reviewers would judge the same range without a result.
 */
export declare function checkPreviousRequest(input: PreviousRequestLookup): ToolFailure | null;
/**
 * Where one verdict moves the topic and whom it wakes. `needs_revision` goes
 * back to the topic only — the master is not woken by a round the topic can
 * handle. `pass` wakes the master only when a work item must be merged (a
 * shared-tree pass just confirms the delivery). `reject` blocks the topic and
 * wakes the master.
 */
export declare function deriveReviewOutcome(verdict: ReviewVerdict, workItemId: string | null): ReviewOutcome;
/**
 * Decide whether a review request allows a merge, before any git write. The
 * request must have passed, the head that passed must still be the head being
 * merged, its base must still be an ancestor, the work item must be in the
 * mergeable state, and the checkout must be clean. Each refusal carries its
 * stable code; the caller returns the failure unchanged.
 */
export declare function mergeGate(input: MergeGateInput): MergeGateResult;
/**
 * The opener for a new reviewer session. It carries the requested scope (the
 * purpose, the two commits, the path, the branch, the changed paths, and the
 * checks the requester ran), the previous round's summary and findings when a
 * re-review follows one, the read-only rule, and the one tool call the reviewer
 * must make. It never carries a handoff body: the request is the unit of review.
 *
 * The body is built within a budget that reserves the closing instructions, and
 * every line is bounded, so the result is at most
 * {@link REVIEW_BRIEF_MAX_CHARS} characters even for a maximal request.
 */
export declare function buildReviewBrief(input: ReviewBriefInput): string;
/** Hard ceiling of a verdict message to the topic, in characters. */
export declare const REVIEW_MESSAGE_MAX_CHARS = 4000;
/** The message a `needs_revision` verdict sends back to the topic. */
export declare function buildRevisionMessage(record: ReviewRequestRecord): string;
/** The message a `reject` verdict sends to the blocked topic. */
export declare function buildRejectMessage(record: ReviewRequestRecord): string;
/** The legacy merge decision: allowed, or the refusal the caller returns as-is. */
export type LegacyMergePlan = {
    ok: true;
} | {
    ok: false;
    failure: ToolFailure;
};
/**
 * Transitional gate for `cowork_checkout_merge(threadId)`: a deprecated thread
 * clone merges only when its review passed. The M8 `allowUnreviewed` override
 * is gone (M10.4b) — the plugin never merges an unreviewed range, not even for
 * the legacy clone — and M11/M12 remove the path together with the last legacy
 * checkout.
 */
export declare function checkLegacyThreadMerge(thread: {
    threadId: string;
    reviewStatus: ReviewStatus | null;
}): LegacyMergePlan;
