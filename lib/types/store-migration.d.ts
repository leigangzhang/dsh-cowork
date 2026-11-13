import type { LegacyStatusMarker, ProjectIndexV1, ProjectIndexV2 } from './store-schema.js';
/** Why a migration stopped. Both codes are terminal: nothing is written. */
export type MigrationErrorCode = 'migration/unknown-status' | 'migration/invalid';
/** A migration failure carrying a stable code and the position it stopped at. */
export declare class MigrationError extends Error {
    readonly code: MigrationErrorCode;
    constructor(code: MigrationErrorCode, message: string);
}
/** The v1 leftovers a v2 topic keeps for the legacy view. */
export interface LegacyTopicFields {
    /** `new`/`archived` v1 status the six-state mapping cannot express. */
    legacyStatus?: LegacyStatusMarker;
    lastHandoffAt?: string | null;
    reviewRequestedAt?: string | null;
    reviewedAt?: string | null;
    latestReviewPath?: string | null;
}
/** Per-state counts of the six v1 thread states. */
export interface MigrationStatusCounts {
    new: number;
    active: number;
    awaiting_review: number;
    done: number;
    blocked: number;
    archived: number;
}
/** One reviewer the migration entry must archive once it writes v2. */
export interface PendingReviewerArchive {
    topicId: string;
    reviewerSessionId: string;
}
/**
 * One reviewer the migration entry could not archive. The migration function
 * itself never archives: `src/store.ts` performs the host call and fills this
 * list, so a caller can report the failure instead of claiming the review was
 * safely cancelled.
 */
export interface ArchiveFailure extends PendingReviewerArchive {
    message: string;
}
/** What the migration did, for the caller's activity record and tests. */
export interface MigrationReport {
    fromVersion: number;
    toVersion: number;
    migrated: boolean;
    statusCounts: MigrationStatusCounts;
    resolvedTopics: string[];
    pendingReviewerArchives: PendingReviewerArchive[];
    /** Filled by the store's migration entry; the pure function leaves it empty. */
    archiveFailures: ArchiveFailure[];
    /**
     * Why the migration activity record could not be appended, or null. The
     * activity is evidence written after v2 is on disk (KI-20): its failure is
     * reported here and never rolls the migration back.
     */
    activityFailure: string | null;
    unknownFields: string[];
    legacyFieldsPreserved: string[];
}
/** The outcome of one migration call. */
export interface MigrationResult {
    document: ProjectIndexV2;
    report: MigrationReport;
}
/** How a v1 document is projected onto v2. */
export interface MigrationOptions {
    /**
     * Cancel an in-flight v1 review: `awaitingReview=false`, clear the review
     * pointer, and report the reviewer for archiving. Default `true` — the write
     * path. `false` is the read-only projection: the review stays in place and
     * nothing is archived.
     */
    cancelInFlightReviews?: boolean;
}
/**
 * Whether a value is a v1 document. The version tag is the discriminator; a
 * document that claims v1 but is damaged is reported by the migration itself,
 * not by this predicate.
 */
export declare function isLegacyIndexDocument(value: unknown): boolean;
/**
 * Migrate a v1 document to v2, or pass a v2 document through unchanged.
 *
 * A v2 document that validates is returned deep-equal (a second migration is an
 * identity, so a retry cannot change the file); a v2 document that does not
 * validate throws `migration/invalid`. A v1 document with a status outside the
 * six states throws `migration/unknown-status` before anything is rewritten.
 *
 * `options.cancelInFlightReviews` defaults to the M7 write semantics. A
 * read-only caller passes `false` so the projection keeps an in-flight review:
 * only a real write cancels it and asks the store to archive the reviewer.
 */
export declare function migrateV1ToV2(document: unknown, options?: MigrationOptions): MigrationResult;
/**
 * The v1 view of a v2 document: `status` is derived from the v2 flags so the
 * unchanged v1 tools keep working (`resolved` reports `done`). The two states a
 * derived status cannot express survive through the `legacyStatus` marker; the
 * four v1 review attach points come from the tolerated fields.
 */
export declare function legacyViewOf(document: ProjectIndexV2): ProjectIndexV1;
/**
 * Fold an edited v1 view back into the v2 document.
 *
 * The legacy tools own the title, status, review state and the four review
 * attachment fields, so those are written back; the status also drives the v2
 * lifecycle flags (`awaitingReview`, `blocked`, `resolvedAt`, `resolvedBy`,
 * `lastDeliveryConfirmedAt`) because `src/handoff.ts` and
 * `src/review-tools.ts` move the status and would otherwise leave the flags
 * stale. The v2-only fields — `scope`, `ownedPaths`, `aliases`, `digest`,
 * `lastActiveAt`, `latestReviewRequestId`, the work items, and the document
 * envelope — are never touched. The view is the whole document, so a topic the
 * view omits is deleted (the legacy tools roll a failed thread creation back by
 * filtering it out of `threads`); a thread the legacy tools added becomes a new
 * topic with migration defaults. M7 always has an empty `workItems` list, so a
 * topic deletion has nothing to cascade to; work item cleanup belongs to the
 * M8 lifecycle rules.
 */
export declare function applyLegacyView(base: ProjectIndexV2, view: ProjectIndexV1): ProjectIndexV2;
