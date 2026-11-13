/** The session-slice operations this module needs. */
export interface ReviewerSessionPorts {
    createReviewSession(options: {
        repoPath: string;
        subject: string;
        presetId: string;
    }): Promise<{
        sessionId: string;
        workspaceId: string;
        title: string;
    }>;
    archiveSession(sessionId: string, options?: {
        stopActivity?: boolean;
    }): Promise<void>;
}
/** What one new reviewer session was asked for. */
export interface CreateReviewerInput {
    repoPath: string;
    /** Subject the sidebar shows after `cowork review: `. */
    subject: string;
    /** Defaults to {@link REVIEWER_PRESET_ID}; any other value is refused. */
    presetId?: string;
}
/** The reviewer session the host created. */
export interface CreatedReviewerSession {
    sessionId: string;
    workspaceId: string;
    title: string;
}
/** A caller that asks for a non-reviewer preset; a programmer error. */
export declare class ReviewerPresetError extends Error {
    constructor(presetId: string);
}
/**
 * Create one reviewer session and return its identity. The preset is checked
 * here *and* by the session slice (which fails closed when the host does not
 * report the requested preset); both checks run before any review state exists.
 */
export declare function createReviewerSession(ports: ReviewerSessionPorts, input: CreateReviewerInput): Promise<CreatedReviewerSession>;
/** What one archival attempt did; a failure keeps the session for a retry. */
export interface ReviewerArchiveResult {
    archived: boolean;
    error: string | null;
}
/**
 * Archive the reviewer after its verdict. `stopActivity: true` lets the host
 * stop a still-running reviewer instead of refusing the archive. A failure is
 * returned, never thrown: the verdict is already persisted, so archiving must
 * not turn it into a failed review (the session stays for a later attempt).
 */
export declare function archiveReviewerAfterVerdict(ports: ReviewerSessionPorts, sessionId: string): Promise<ReviewerArchiveResult>;
/**
 * The reviewer sessions the project index still records, deduplicated and in
 * topic order. The panel filters these session ids out of the topic list; live
 * reviewers in the host sidebar are an accepted M10 limit (M11 filters them).
 */
export declare function reviewerSessionIds(document: {
    topics: ReadonlyArray<{
        reviewerSessionId: string | null;
    }>;
} | null | undefined): string[];
