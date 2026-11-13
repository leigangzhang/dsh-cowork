import type { NoticeLedgerV1 } from './notices.js';
import type { ActivityEvent, InboxItem, ProjectIndexV2, ReadActivityResult, ReviewRecord, ReviewStatus } from './store-schema.js';
export type { ReadActivityResult } from './store-schema.js';
import type { MigrationReport } from './store-migration.js';
/** Lifecycle of one thread as recorded in the project index. */
export type ThreadStatus = 'new' | 'active' | 'awaiting_review' | 'done' | 'blocked' | 'archived';
/** One thread entry of the project index. */
export interface ThreadRecord {
    threadId: string;
    subject: string;
    status: ThreadStatus;
    cwd: string;
    /**
     * Thread's isolated clone (`<repo>/.dsh-cowork/threads/<threadId>`), or null
     * for a thread that works in the shared repository. Indexes written before
     * M2 named this field `worktreePath`; {@link normalizeThreadDocument} reads
     * that legacy name and every write emits `checkoutPath` only.
     */
    checkoutPath: string | null;
    createdAt: string;
    updatedAt: string;
    lastHandoffAt: string | null;
    /**
     * Review state of the thread. Indexes written before M3 have none of these
     * fields; {@link normalizeThreadDocument} fills every one with `null`, so a
     * loaded record always carries the keys.
     */
    reviewStatus: ReviewStatus | null;
    /** When the current review request was opened. */
    reviewRequestedAt: string | null;
    /** When the current verdict was recorded. */
    reviewedAt: string | null;
    /** Session id of the reviewer the thread's review was requested from. */
    reviewerSessionId: string | null;
    /** Absolute path of the newest review file, or null. */
    latestReviewPath: string | null;
}
/** The project index document (`<repo>/.dsh-cowork/index.json`). */
export interface ProjectIndex {
    version: 1;
    projectId: string;
    masterSessionId: string;
    createdAt: string;
    threads: ThreadRecord[];
}
/** One verification row of a handoff. */
export interface HandoffVerification {
    command: string;
    exitCode: number;
    evidence: string;
}
/** Status a handoff may carry. `new`/`active` are thread states, not handoff states. */
export type HandoffStatus = 'awaiting_review' | 'blocked' | 'done';
/** One handoff document (`<repo>/.dsh-cowork/handoffs/<threadId>-<stamp>.json`). */
export interface HandoffRecord {
    version: 1;
    threadId: string;
    masterSessionId: string;
    status: HandoffStatus;
    subject: string;
    summary: string;
    decisions: string[];
    changedPaths: string[];
    artifacts: string[];
    verification: HandoffVerification[];
    openIssues: string[];
    nextStep: string | null;
    createdAt: string;
    deliveredAt: string | null;
}
/** A handoff record together with where it lives. */
export interface HandoffFile {
    filePath: string;
    fileName: string;
    record: HandoffRecord;
}
/** A review record together with where it lives. */
export interface ReviewFile {
    filePath: string;
    fileName: string;
    record: ReviewRecord;
}
/** The newest verdict of one thread, as the status view reports it. */
export interface LatestReview {
    threadId: string;
    verdict: ReviewRecord['verdict'];
    summary: string;
    reviewedAt: string;
    filePath: string;
}
/** A store failure carrying a stable code and, when relevant, the offending file. */
export declare class StoreError extends Error {
    readonly code: string;
    readonly filePath: string | undefined;
    constructor(code: string, message: string, filePath?: string);
}
/** Construction options for {@link ProjectStore}. */
export interface ProjectStoreOptions {
    /** Repository root that owns `.dsh-cowork/`. */
    repoPath: string;
    /** Injected clock; every timestamp this store writes comes from it. */
    clock?: () => Date;
    /** Explicit project id; defaults to `projectIdFor(repoPath)` on first init. */
    projectId?: string;
    /**
     * Host port used to archive the reviewer of an in-flight v1 review while the
     * index migrates. M7 wires no host into the store (`src/tools.ts` and
     * `src/index.ts` are frozen), so a migration records `archiveFailures` and
     * still writes v2 instead of claiming the review was safely cancelled.
     */
    archiveSession?: (sessionId: string, options?: {
        stopActivity?: boolean;
    }) => Promise<void>;
}
export declare class ProjectStore {
    /** Repository root that owns the project directory. */
    readonly repoPath: string;
    /** `<repo>/.dsh-cowork`. */
    readonly projectDir: string;
    /** `<repo>/.dsh-cowork/handoffs`. */
    readonly handoffsDir: string;
    /** `<repo>/.dsh-cowork/reviews`. */
    readonly reviewsDir: string;
    /** `<repo>/.dsh-cowork/index.json`. */
    readonly indexFile: string;
    /** `<repo>/.dsh-cowork/index.v1.backup.json` (written once, before the first migration). */
    readonly backupFile: string;
    /** `<repo>/.dsh-cowork/activity.jsonl`. */
    readonly activityFile: string;
    /** `<repo>/.dsh-cowork/inbox.json`. */
    readonly inboxFile: string;
    /** `<repo>/.dsh-cowork/notices.json` (the delivery ledger). */
    readonly noticesFile: string;
    private readonly ledger;
    /** `<repo>/.dsh-cowork/.write.lock` (the writers' lock; `withFileLock` owns the sibling). */
    readonly lockFile: string;
    private readonly clock;
    private readonly explicitProjectId;
    private readonly archiveSession;
    private migrationReport;
    constructor(options: ProjectStoreOptions);
    /** Value of the injected clock, used for every timestamp this store stamps. */
    private now;
    /** Whether the project index file exists. */
    hasIndex(): Promise<boolean>;
    /**
     * Read the project index as the v1-shaped view every M7 caller still uses.
     * It is derived from the read-only canonical projection, so a v1 disk still
     * reports an in-flight review exactly as it is: a read never migrates, writes
     * the file, creates a backup, or archives a reviewer. A damaged document, or
     * an unknown v1 status, is `store/corrupt`.
     */
    readIndex(): Promise<ProjectIndex>;
    /**
     * Read the canonical v2 document. A v2 file is validated as is. A v1 file is
     * projected onto v2 in memory only — no write, backup, archive, or mtime
     * change — and the projection keeps an in-flight review (`awaitingReview`,
     * `reviewStatus`, `reviewerSessionId` intact). Only {@link readIndexForWrite}
     * cancels the review, backs the v1 text up, and archives the reviewer.
     */
    readIndexDocument(): Promise<ProjectIndexV2>;
    /**
     * The report of the most recent on-write v1 → v2 migration, or null when this
     * store has not migrated anything. `archiveFailures` names every reviewer the
     * host port could not archive; an empty list means the migration had nothing
     * to archive or archived it successfully. `activityFailure` names why the
     * migration activity row could not be written, or is null.
     */
    get lastMigrationReport(): MigrationReport | null;
    /**
     * Create the index for `masterSessionId` once. An existing index wins and its
     * `masterSessionId` is never replaced; a damaged one raises `store/corrupt`.
     */
    initIndex(masterSessionId: string): Promise<{
        index: ProjectIndex;
        created: boolean;
    }>;
    /**
     * Move the master role to `masterSessionId`, keeping `projectId`, `createdAt`
     * and every thread exactly as they are. Last writer wins: the tool layer
     * owns the authorization decision (`claimMaster`), this method owns the
     * atomic swap under the project lock.
     *
     * A missing or damaged index is not repaired: it raises before the lock is
     * taken so no lock file creates `.dsh-cowork/` for an uninitialized project.
     */
    rebindMaster(masterSessionId: string): Promise<ProjectIndex>;
    /**
     * Run `mutator` against the current index under the project lock and persist
     * its result in one atomic write. Concurrent callers are serialized, so no
     * read-modify-write cycle can resurrect a replaced state. The view is the
     * whole document: a topic it omits is deleted, a thread it adds becomes a new
     * topic, and every v2-only field of a surviving topic is inherited.
     */
    mutateIndex(mutator: (index: ProjectIndex) => ProjectIndex): Promise<ProjectIndex>;
    /**
     * Run `mutator` against the canonical v2 document under the project lock and
     * persist its result. The mutator sees the document re-read (and, for a v1
     * file, migrated) inside the lock — the point where an automatic marker
     * re-checks `lastActiveAt` before writing. Returning `null` abandons the
     * change: the lock-read document is returned and nothing is written.
     */
    mutateIndexDocument(mutator: (document: ProjectIndexV2) => ProjectIndexV2 | null): Promise<ProjectIndexV2>;
    /** Append one thread record; a duplicate `threadId` is rejected. */
    addThread(record: ThreadRecord): Promise<ProjectIndex>;
    /** Merge `patch` into one thread and stamp `updatedAt` from the clock. */
    updateThread(threadId: string, patch: Partial<Pick<ThreadRecord, 'subject' | 'status' | 'cwd' | 'checkoutPath' | 'updatedAt' | 'lastHandoffAt' | 'reviewStatus' | 'reviewRequestedAt' | 'reviewedAt' | 'reviewerSessionId' | 'latestReviewPath'>>): Promise<ProjectIndex>;
    /** Append one event to `activity.jsonl`, trimming the stream to its bounds. */
    appendActivity(event: ActivityEvent): Promise<void>;
    /**
     * The newest `limit` activity events, oldest first, together with the number
     * of lines that were not valid events. A missing file is an empty stream; a
     * damaged line is skipped, never a whole-file failure, so one bad append
     * cannot take the history down.
     */
    readActivity(limit?: number): Promise<ReadActivityResult>;
    /** Every inbox item, oldest first. A damaged file is `store/corrupt`. */
    readInbox(): Promise<InboxItem[]>;
    /**
     * Replace the inbox with `items`, keeping the newest {@link INBOX_MAX_ITEMS}.
     * M7 owns the file only: merging several pending events into one message and
     * replaying an undelivered one are M8 rules and are not implemented here.
     */
    writeInbox(items: InboxItem[]): Promise<InboxItem[]>;
    /** Read the delivery ledger; a missing file is empty, damage is `store/corrupt`. */
    readNotices(): Promise<NoticeLedgerV1>;
    /** Validate, trim, and write the delivery ledger under the project lock. */
    writeNotices(ledger: NoticeLedgerV1): Promise<NoticeLedgerV1>;
    /** Locked read-modify-write of the ledger (concurrent appends must not lose rows). */
    mutateNotices(mutator: (ledger: NoticeLedgerV1) => NoticeLedgerV1): Promise<NoticeLedgerV1>;
    /** Map a ledger file failure onto this store's error codes. */
    private noticeError;
    /**
     * Read arbitrary text this project owns (the memory files). A missing file is
     * `null`; every other failure propagates, because an append must not treat an
     * unreadable file as empty and overwrite it.
     */
    readText(absPath: string): Promise<string | null>;
    /**
     * Write arbitrary text (the memory files) through the same atomic path as the
     * index: exclusive-create temp sibling, rename, then fsync the parent.
     * The caller holds {@link withWriteLock} across its read-modify-write cycle;
     * this method never takes the lock itself, so nesting cannot deadlock.
     */
    writeTextAtomic(absPath: string, content: string): Promise<void>;
    /**
     * Run an arbitrary read-modify-write cycle under the project write lock, the
     * same serialization every index and handoff writer uses.
     */
    withWriteLock<T>(operation: () => Promise<T>): Promise<T>;
    /** Every handoff file, ordered by `createdAt` epoch (then by file name). */
    listHandoffs(): Promise<HandoffFile[]>;
    /** Read and validate one handoff file. */
    readHandoff(filePath: string): Promise<HandoffRecord>;
    /**
     * Write one handoff file under the project lock. The default file name comes
     * from the record's own `createdAt`, so the file name is predictable; a
     * second write to the same name is rejected instead of overwriting a source
     * of truth.
     */
    writeHandoff(record: HandoffRecord, fileName?: string): Promise<HandoffFile>;
    /** Record successful delivery by rewriting `deliveredAt` in place. */
    markHandoffDelivered(filePath: string, deliveredAt: string): Promise<HandoffFile>;
    /**
     * Every review file, ordered by `createdAt` epoch (then by file name). A
     * missing reviews directory is an empty list; a review file this store
     * cannot validate raises `store/corrupt` rather than being skipped.
     */
    listReviews(): Promise<ReviewFile[]>;
    /**
     * Newest verdict per thread. A review file this store cannot read means "that
     * thread has no review" for this projection (its index pointer is tried
     * instead), not a failed status call; the index itself still fails in
     * {@link readIndex}.
     */
    latestReviews(threads: ReadonlyArray<{
        threadId: string;
        latestReviewPath: string | null;
    }>): Promise<LatestReview[]>;
    /** Read and validate one review file. */
    readReview(filePath: string): Promise<ReviewRecord>;
    /**
     * Write one review file under the project lock. The file name comes from the
     * record's own `createdAt`, so it is predictable; a second write to the same
     * name is rejected (`store/review-exists`) instead of overwriting a verdict
     * the index may already point at.
     */
    writeReview(record: ReviewRecord): Promise<ReviewFile>;
    /** Create the project directory once, before any lock or write touches it. */
    private ensureProjectDir;
    /** Run `operation` while holding the project write lock. */
    private withLock;
    /** Parse one index document, reporting damaged JSON with its path. */
    private parseIndexText;
    /**
     * Read the index inside the write lock, migrating a v1 document as one
     * transaction before anything else touches it: validate the migrated v2
     * document, copy the original v1 bytes to `index.v1.backup.json` (never
     * overwriting an earlier backup), archive the reviewers of the in-flight
     * reviews the migration cancels, and only then replace `index.json` with v2.
     *
     * A failure before the replacement leaves both the backup and the original
     * file exactly as they were and raises `store/corrupt`. A failed archive is
     * recorded instead: the reviewer pointer is already cleared, so the migration
     * must not pretend the review was safely cancelled, but it also must not leave
     * the index half-migrated. The activity record is appended only after v2 is
     * on disk; its failure is reported as `activityFailure` and never undoes the
     * migration (KI-20).
     */
    private readIndexForWrite;
    /** Copy the original v1 index text once, before `index.json` becomes v2. */
    private writeMigrationBackup;
    /** Archive the reviewers of the v1 reviews the migration cancelled. */
    private archivePendingReviewers;
    /** Record the migration, plus one error event per reviewer left un-archived. */
    private recordMigrationActivity;
    /** Build one activity event stamped with the injected clock. */
    private activityEvent;
    /** Read the activity stream without taking the lock. */
    private readActivityLocked;
    /** Append one event and rewrite the trimmed stream (the caller holds the lock). */
    private appendActivityLocked;
}
/** The file name of one handoff: `<threadId>-YYYYMMDDTHHmmssSSSZ.json` in UTC. */
export declare function handoffFileName(threadId: string, createdAt: Date): string;
/** The file name of one review: the handoff stamp format, under the reviews directory. */
export declare function reviewFileName(threadId: string, createdAt: Date): string;
/**
 * The project's stable identity: the normalized `origin` remote when the
 * repository has one, otherwise `sha256(realpath(repoPath))` truncated to 12
 * hex characters (a path with no remote still gets a stable id).
 */
export declare function projectIdFor(repoPath: string): Promise<string>;
/** Walk up from `startPath` to the nearest directory holding `.dsh-cowork/index.json`. */
export declare function findProjectRoot(startPath: string): Promise<string | null>;
/**
 * Synchronous {@link findProjectRoot}: walk up from `startPath` to the nearest
 * directory holding `.dsh-cowork/index.json`. The system-prompt section asks
 * this on every prompt assembly, where an async lookup is not available.
 */
export declare function findProjectRootSync(startPath: string): string | null;
