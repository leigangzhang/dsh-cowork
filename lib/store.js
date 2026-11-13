/**
 * Project store: the single writer of `<repo>/.dsh-cowork/index.json`, of
 * every handoff file under `<repo>/.dsh-cowork/handoffs/`, and of every review
 * file under `<repo>/.dsh-cowork/reviews/`.
 *
 * Writers serialize through the shared project lock in `src/atomic-json.ts`;
 * each JSON replacement goes through `writeJsonAtomic` (exclusive-create
 * random-suffix sibling + rename, mode 0600, then an explicit parent-directory
 * fsync, because the host helper documents crash durability as out of scope).
 * Readers stay lock-free: the rename commits complete content, so a read sees
 * the old or the new document, never a half-written one.
 *
 * Reads validate the whole document. A missing index raises
 * `store/not-found`; damaged JSON or a schema mismatch raises `store/corrupt`
 * naming the file. Nothing is rebuilt silently — an index this module cannot
 * trust is a defect the caller has to see.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { INDEX_VERSION_V2, INBOX_MAX_ITEMS, activityEventProblems, handoffRecordProblems, inboxItemProblems, normalizeProjectIndexV1, normalizeProjectIndexV2, projectIndexV1Problems, projectIndexV2Problems, reviewRecordProblems, serializeActivityEvents, threadV1Problems, trimActivityEvents, } from './store-schema.js';
import { DIR_MODE, FILE_MODE, LOCK_FILE_NAME, fsyncDirectory, readTextIfPresent, withProjectLock, writeJsonAtomic, writeTextAtomic as writeAtomicText, } from './atomic-json.js';
import { MigrationError, applyLegacyView, legacyViewOf, migrateV1ToV2 } from './store-migration.js';
import { NoticeFileError, NoticeLedgerFile } from './notice-store.js';
const execFileAsync = promisify(execFile);
/** Project directory name inside the repository root. */
const PROJECT_DIR_NAME = '.dsh-cowork';
/** Index file name inside the project directory. */
const INDEX_FILE_NAME = 'index.json';
/** Pre-migration index backup: the original v1 document, written once. */
const BACKUP_FILE_NAME = 'index.v1.backup.json';
/** Activity stream file name inside the project directory. */
const ACTIVITY_FILE_NAME = 'activity.jsonl';
/** Master inbox file name inside the project directory. */
const INBOX_FILE_NAME = 'inbox.json';
/** Notice delivery ledger file name inside the project directory. */
const NOTICES_FILE_NAME = 'notices.json';
/** Handoff directory name inside the project directory. */
const HANDOFFS_DIR_NAME = 'handoffs';
/** Review directory name inside the project directory. */
const REVIEWS_DIR_NAME = 'reviews';
/** Handoff file suffix. */
const HANDOFF_SUFFIX = '.json';
/** Review file suffix. */
const REVIEW_SUFFIX = '.json';
/** Length of the repository-path project id fallback. */
const PROJECT_ID_HASH_LENGTH = 12;
/** How many activity events a read returns when the caller does not say. */
const ACTIVITY_READ_LIMIT = 50;
/** Every lifecycle a thread may carry; `tests/api-contract.test.mjs` pins this list. */
const THREAD_STATUSES = [
    'new',
    'active',
    'awaiting_review',
    'done',
    'blocked',
    'archived',
];
/** A store failure carrying a stable code and, when relevant, the offending file. */
export class StoreError extends Error {
    code;
    filePath;
    constructor(code, message, filePath) {
        super(message);
        this.name = 'StoreError';
        this.code = code;
        this.filePath = filePath;
    }
}
/** Whether a value is a JSON object (not null, not an array). */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Whether a value is a string with non-whitespace content. */
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
}
/** Whether a value is a string that `Date.parse` accepts. */
function isIsoDate(value) {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}
/** The error message body for a set of schema problems. */
function problemMessage(prefix, filePath, problems) {
    return `${prefix} (${filePath}): ${problems.join('; ')}`;
}
/**
 * Read a document this store owns. A missing file is `store/not-found`; any
 * other read failure (a directory where the document belongs, a permission
 * change) is a damaged store and is reported with the path.
 */
async function readDocument(filePath, label) {
    try {
        return await readFile(filePath, 'utf8');
    }
    catch (error) {
        const failure = error;
        if (failure.code === 'ENOENT' || failure.code === 'ENOTDIR') {
            throw new StoreError('store/not-found', `${label} not found: ${filePath}`, filePath);
        }
        throw new StoreError('store/corrupt', `${filePath}: unreadable (${failure.message})`, filePath);
    }
}
/** Schema problems of a whole inbox document, addressed by item position. */
function inboxProblems(items) {
    const problems = [];
    items.forEach((item, position) => {
        for (const problem of inboxItemProblems(item)) {
            problems.push(`inbox[${position}]${problem.slice('inbox'.length)}`);
        }
    });
    return problems;
}
/** A message for one failure, without carrying a stack into a report. */
function describeFailure(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Format a timestamp as the handoff filename stamp `YYYYMMDDTHHmmssSSSZ` in UTC. */
function handoffStamp(createdAt) {
    if (Number.isNaN(createdAt.getTime())) {
        throw new StoreError('store/invalid-time', 'handoff createdAt is not a valid Date');
    }
    const pad = (value, width = 2) => String(value).padStart(width, '0');
    return [
        pad(createdAt.getUTCFullYear(), 4),
        pad(createdAt.getUTCMonth() + 1),
        pad(createdAt.getUTCDate()),
        'T',
        pad(createdAt.getUTCHours()),
        pad(createdAt.getUTCMinutes()),
        pad(createdAt.getUTCSeconds()),
        pad(createdAt.getUTCMilliseconds(), 3),
        'Z',
    ].join('');
}
export class ProjectStore {
    /** Repository root that owns the project directory. */
    repoPath;
    /** `<repo>/.dsh-cowork`. */
    projectDir;
    /** `<repo>/.dsh-cowork/handoffs`. */
    handoffsDir;
    /** `<repo>/.dsh-cowork/reviews`. */
    reviewsDir;
    /** `<repo>/.dsh-cowork/index.json`. */
    indexFile;
    /** `<repo>/.dsh-cowork/index.v1.backup.json` (written once, before the first migration). */
    backupFile;
    /** `<repo>/.dsh-cowork/activity.jsonl`. */
    activityFile;
    /** `<repo>/.dsh-cowork/inbox.json`. */
    inboxFile;
    /** `<repo>/.dsh-cowork/notices.json` (the delivery ledger). */
    noticesFile;
    ledger;
    /** `<repo>/.dsh-cowork/.write.lock` (the writers' lock; `withFileLock` owns the sibling). */
    lockFile;
    clock;
    explicitProjectId;
    archiveSession;
    migrationReport = null;
    constructor(options) {
        this.repoPath = resolve(options.repoPath);
        this.projectDir = join(this.repoPath, PROJECT_DIR_NAME);
        this.handoffsDir = join(this.projectDir, HANDOFFS_DIR_NAME);
        this.reviewsDir = join(this.projectDir, REVIEWS_DIR_NAME);
        this.indexFile = join(this.projectDir, INDEX_FILE_NAME);
        this.backupFile = join(this.projectDir, BACKUP_FILE_NAME);
        this.activityFile = join(this.projectDir, ACTIVITY_FILE_NAME);
        this.inboxFile = join(this.projectDir, INBOX_FILE_NAME);
        this.noticesFile = join(this.projectDir, NOTICES_FILE_NAME);
        this.ledger = new NoticeLedgerFile(this.projectDir, this.noticesFile, join(this.projectDir, LOCK_FILE_NAME));
        this.lockFile = join(this.projectDir, LOCK_FILE_NAME);
        this.clock = options.clock ?? (() => new Date());
        this.explicitProjectId = options.projectId;
        this.archiveSession = options.archiveSession;
    }
    /** Value of the injected clock, used for every timestamp this store stamps. */
    now() {
        return this.clock();
    }
    /** Whether the project index file exists. */
    async hasIndex() {
        try {
            const info = await stat(this.indexFile);
            return info.isFile();
        }
        catch (error) {
            const code = error.code;
            if (code === 'ENOENT' || code === 'ENOTDIR')
                return false;
            throw error;
        }
    }
    /**
     * Read the project index as the v1-shaped view every M7 caller still uses.
     * It is derived from the read-only canonical projection, so a v1 disk still
     * reports an in-flight review exactly as it is: a read never migrates, writes
     * the file, creates a backup, or archives a reviewer. A damaged document, or
     * an unknown v1 status, is `store/corrupt`.
     */
    async readIndex() {
        return legacyViewOf(await this.readIndexDocument());
    }
    /**
     * Read the canonical v2 document. A v2 file is validated as is. A v1 file is
     * projected onto v2 in memory only — no write, backup, archive, or mtime
     * change — and the projection keeps an in-flight review (`awaitingReview`,
     * `reviewStatus`, `reviewerSessionId` intact). Only {@link readIndexForWrite}
     * cancels the review, backs the v1 text up, and archives the reviewer.
     */
    async readIndexDocument() {
        const text = await readDocument(this.indexFile, 'project index');
        const parsed = this.parseIndexText(text);
        if (isRecord(parsed) && parsed.version === INDEX_VERSION_V2) {
            const document = normalizeProjectIndexV2(parsed);
            const problems = projectIndexV2Problems(document);
            if (problems.length > 0) {
                throw new StoreError('store/corrupt', problemMessage('project index is invalid', this.indexFile, problems), this.indexFile);
            }
            return document;
        }
        const normalized = normalizeProjectIndexV1(parsed);
        const problems = projectIndexV1Problems(normalized);
        if (problems.length > 0) {
            throw new StoreError('store/corrupt', problemMessage('project index is invalid', this.indexFile, problems), this.indexFile);
        }
        let projected;
        try {
            projected = migrateV1ToV2(normalized, { cancelInFlightReviews: false }).document;
        }
        catch (error) {
            if (!(error instanceof MigrationError))
                throw error;
            throw new StoreError('store/corrupt', problemMessage('project index is invalid', this.indexFile, [error.message]), this.indexFile);
        }
        // A v1 thread may carry unknown fields and the migration copies them onto
        // the topic; one that shadows a v2 field (e.g. `digest: 123`) must not reach
        // a caller as a canonical document.
        const projectedProblems = projectIndexV2Problems(projected);
        if (projectedProblems.length > 0) {
            throw new StoreError('store/corrupt', problemMessage('projected project index is invalid', this.indexFile, projectedProblems), this.indexFile);
        }
        return projected;
    }
    /**
     * The report of the most recent on-write v1 → v2 migration, or null when this
     * store has not migrated anything. `archiveFailures` names every reviewer the
     * host port could not archive; an empty list means the migration had nothing
     * to archive or archived it successfully. `activityFailure` names why the
     * migration activity row could not be written, or is null.
     */
    get lastMigrationReport() {
        return this.migrationReport;
    }
    /**
     * Create the index for `masterSessionId` once. An existing index wins and its
     * `masterSessionId` is never replaced; a damaged one raises `store/corrupt`.
     */
    async initIndex(masterSessionId) {
        if (!isNonEmptyString(masterSessionId)) {
            throw new StoreError('store/invalid', 'masterSessionId must be a non-empty string');
        }
        if (await this.hasIndex())
            return { index: await this.readIndex(), created: false };
        await this.ensureProjectDir();
        return this.withLock(async () => {
            // Re-check under the lock: another writer may have initialized meanwhile.
            if (await this.hasIndex())
                return { index: await this.readIndex(), created: false };
            const projectId = this.explicitProjectId ?? (await projectIdFor(this.repoPath));
            const document = {
                version: INDEX_VERSION_V2,
                projectId,
                masterSessionId,
                createdAt: this.now().toISOString(),
                masterFocusTopicId: null,
                lastRouteTopicId: null,
                topics: [],
                workItems: [],
            };
            await writeJsonAtomic(this.indexFile, document);
            return { index: legacyViewOf(document), created: true };
        });
    }
    /**
     * Move the master role to `masterSessionId`, keeping `projectId`, `createdAt`
     * and every thread exactly as they are. Last writer wins: the tool layer
     * owns the authorization decision (`claimMaster`), this method owns the
     * atomic swap under the project lock.
     *
     * A missing or damaged index is not repaired: it raises before the lock is
     * taken so no lock file creates `.dsh-cowork/` for an uninitialized project.
     */
    async rebindMaster(masterSessionId) {
        if (!isNonEmptyString(masterSessionId)) {
            throw new StoreError('store/invalid', 'masterSessionId must be a non-empty string');
        }
        // Fail closed before the lock so no lock file creates `.dsh-cowork/` for an
        // uninitialized project; the write path re-reads (and migrates) under the lock.
        await this.readIndex();
        return this.withLock(async () => {
            const current = await this.readIndexForWrite();
            if (current.masterSessionId === masterSessionId)
                return legacyViewOf(current);
            const next = { ...current, masterSessionId };
            await writeJsonAtomic(this.indexFile, next);
            return legacyViewOf(next);
        });
    }
    /**
     * Run `mutator` against the current index under the project lock and persist
     * its result in one atomic write. Concurrent callers are serialized, so no
     * read-modify-write cycle can resurrect a replaced state. The view is the
     * whole document: a topic it omits is deleted, a thread it adds becomes a new
     * topic, and every v2-only field of a surviving topic is inherited.
     */
    async mutateIndex(mutator) {
        const next = await this.mutateIndexDocument((base) => applyLegacyView(base, mutator(legacyViewOf(base))));
        return legacyViewOf(next);
    }
    /**
     * Run `mutator` against the canonical v2 document under the project lock and
     * persist its result. The mutator sees the document re-read (and, for a v1
     * file, migrated) inside the lock — the point where an automatic marker
     * re-checks `lastActiveAt` before writing. Returning `null` abandons the
     * change: the lock-read document is returned and nothing is written.
     */
    async mutateIndexDocument(mutator) {
        await this.ensureProjectDir();
        return this.withLock(async () => {
            const base = await this.readIndexForWrite();
            const next = mutator(base);
            if (next === null)
                return base;
            // Normalise before validation and the write: a legacy mutator may hand
            // back a topic that predates the block/authorization fields, and a written
            // document must carry every field a reader relies on (write-complete).
            const document = normalizeProjectIndexV2(next);
            const problems = projectIndexV2Problems(document);
            if (problems.length > 0) {
                throw new StoreError('store/invalid', problemMessage('mutated project index is invalid', this.indexFile, problems), this.indexFile);
            }
            await writeJsonAtomic(this.indexFile, document);
            return document;
        });
    }
    /** Append one thread record; a duplicate `threadId` is rejected. */
    async addThread(record) {
        // A caller may hand in a record that predates the M3 review fields; the
        // index it writes always carries them as null, so a read is never partial.
        const complete = {
            ...record,
            reviewStatus: record.reviewStatus ?? null,
            reviewRequestedAt: record.reviewRequestedAt ?? null,
            reviewedAt: record.reviewedAt ?? null,
            reviewerSessionId: record.reviewerSessionId ?? null,
            latestReviewPath: record.latestReviewPath ?? null,
        };
        const problems = threadV1Problems(complete, 'thread');
        if (problems.length > 0) {
            throw new StoreError('store/invalid-thread', problemMessage('thread record is invalid', this.indexFile, problems), this.indexFile);
        }
        return this.mutateIndex((index) => {
            if (index.threads.some((thread) => thread.threadId === complete.threadId)) {
                throw new StoreError('store/thread-exists', `thread already exists in ${this.indexFile}: ${complete.threadId}`, this.indexFile);
            }
            return { ...index, threads: [...index.threads, complete] };
        });
    }
    /** Merge `patch` into one thread and stamp `updatedAt` from the clock. */
    async updateThread(threadId, patch) {
        if (patch.status !== undefined && !THREAD_STATUSES.includes(patch.status)) {
            throw new StoreError('store/invalid', `thread status must be one of ${THREAD_STATUSES.join('|')}: ${patch.status}`, this.indexFile);
        }
        return this.mutateIndex((index) => {
            const position = index.threads.findIndex((thread) => thread.threadId === threadId);
            if (position < 0) {
                throw new StoreError('store/thread-not-found', `thread not found in ${this.indexFile}: ${threadId}`, this.indexFile);
            }
            const current = index.threads[position];
            // Undefined patch values mean "leave as is", so a caller can pass a sparse object.
            const merged = {
                threadId: current.threadId,
                subject: patch.subject ?? current.subject,
                status: patch.status ?? current.status,
                cwd: patch.cwd ?? current.cwd,
                checkoutPath: patch.checkoutPath === undefined ? current.checkoutPath : patch.checkoutPath,
                createdAt: current.createdAt,
                updatedAt: patch.updatedAt ?? this.now().toISOString(),
                lastHandoffAt: patch.lastHandoffAt === undefined ? current.lastHandoffAt : patch.lastHandoffAt,
                reviewStatus: patch.reviewStatus === undefined ? current.reviewStatus : patch.reviewStatus,
                reviewRequestedAt: patch.reviewRequestedAt === undefined ? current.reviewRequestedAt : patch.reviewRequestedAt,
                reviewedAt: patch.reviewedAt === undefined ? current.reviewedAt : patch.reviewedAt,
                reviewerSessionId: patch.reviewerSessionId === undefined ? current.reviewerSessionId : patch.reviewerSessionId,
                latestReviewPath: patch.latestReviewPath === undefined ? current.latestReviewPath : patch.latestReviewPath,
            };
            const threads = index.threads.map((thread, at) => (at === position ? merged : thread));
            return { ...index, threads };
        });
    }
    /** Append one event to `activity.jsonl`, trimming the stream to its bounds. */
    async appendActivity(event) {
        const problems = activityEventProblems(event);
        if (problems.length > 0) {
            throw new StoreError('store/invalid-activity', problemMessage('activity event is invalid', this.activityFile, problems), this.activityFile);
        }
        await this.ensureProjectDir();
        await this.withLock(() => this.appendActivityLocked(event));
    }
    /**
     * The newest `limit` activity events, oldest first, together with the number
     * of lines that were not valid events. A missing file is an empty stream; a
     * damaged line is skipped, never a whole-file failure, so one bad append
     * cannot take the history down.
     */
    async readActivity(limit = ACTIVITY_READ_LIMIT) {
        const { events, skippedLines } = await this.readActivityLocked();
        return { events: limit > 0 ? events.slice(-limit) : [], skippedLines };
    }
    /** Every inbox item, oldest first. A damaged file is `store/corrupt`. */
    async readInbox() {
        const text = await readTextIfPresent(this.inboxFile);
        if (text === undefined)
            return [];
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch (error) {
            throw new StoreError('store/corrupt', `${this.inboxFile}: invalid JSON (${error.message})`, this.inboxFile);
        }
        if (!Array.isArray(parsed)) {
            throw new StoreError('store/corrupt', `${this.inboxFile}: inbox must be a JSON array`, this.inboxFile);
        }
        const problems = inboxProblems(parsed);
        if (problems.length > 0) {
            throw new StoreError('store/corrupt', problemMessage('inbox is invalid', this.inboxFile, problems), this.inboxFile);
        }
        return parsed;
    }
    /**
     * Replace the inbox with `items`, keeping the newest {@link INBOX_MAX_ITEMS}.
     * M7 owns the file only: merging several pending events into one message and
     * replaying an undelivered one are M8 rules and are not implemented here.
     */
    async writeInbox(items) {
        if (!Array.isArray(items)) {
            throw new StoreError('store/invalid-inbox', 'inbox must be an array of items', this.inboxFile);
        }
        const problems = inboxProblems(items);
        if (problems.length > 0) {
            throw new StoreError('store/invalid-inbox', problemMessage('inbox is invalid', this.inboxFile, problems), this.inboxFile);
        }
        const kept = items.slice(-INBOX_MAX_ITEMS);
        await this.ensureProjectDir();
        return this.withLock(async () => {
            await writeJsonAtomic(this.inboxFile, kept);
            return kept;
        });
    }
    /** Read the delivery ledger; a missing file is empty, damage is `store/corrupt`. */
    async readNotices() {
        try {
            return await this.ledger.read();
        }
        catch (error) {
            throw this.noticeError(error);
        }
    }
    /** Validate, trim, and write the delivery ledger under the project lock. */
    async writeNotices(ledger) {
        try {
            return await this.ledger.write(ledger);
        }
        catch (error) {
            throw this.noticeError(error);
        }
    }
    /** Locked read-modify-write of the ledger (concurrent appends must not lose rows). */
    async mutateNotices(mutator) {
        try {
            return await this.ledger.mutate(mutator);
        }
        catch (error) {
            throw this.noticeError(error);
        }
    }
    /** Map a ledger file failure onto this store's error codes. */
    noticeError(error) {
        if (!(error instanceof NoticeFileError))
            return error;
        return new StoreError(error.code === 'corrupt' ? 'store/corrupt' : 'store/invalid-notices', `${error.filePath}: ${error.message}`, error.filePath);
    }
    /**
     * Read arbitrary text this project owns (the memory files). A missing file is
     * `null`; every other failure propagates, because an append must not treat an
     * unreadable file as empty and overwrite it.
     */
    async readText(absPath) {
        const text = await readTextIfPresent(absPath);
        return text === undefined ? null : text;
    }
    /**
     * Write arbitrary text (the memory files) through the same atomic path as the
     * index: exclusive-create temp sibling, rename, then fsync the parent.
     * The caller holds {@link withWriteLock} across its read-modify-write cycle;
     * this method never takes the lock itself, so nesting cannot deadlock.
     */
    async writeTextAtomic(absPath, content) {
        await writeAtomicText(absPath, content);
    }
    /**
     * Run an arbitrary read-modify-write cycle under the project write lock, the
     * same serialization every index and handoff writer uses.
     */
    async withWriteLock(operation) {
        return this.withLock(operation);
    }
    /** Every handoff file, ordered by `createdAt` epoch (then by file name). */
    async listHandoffs() {
        let names;
        try {
            names = await readdir(this.handoffsDir);
        }
        catch (error) {
            const code = error.code;
            if (code === 'ENOENT' || code === 'ENOTDIR')
                return [];
            throw error;
        }
        const files = [];
        for (const fileName of names.filter((name) => name.endsWith(HANDOFF_SUFFIX)).sort()) {
            const filePath = join(this.handoffsDir, fileName);
            files.push({ filePath, fileName, record: await this.readHandoff(filePath) });
        }
        // File names only guarantee uniqueness; ordering is the record's own timestamp.
        return files.sort((left, right) => {
            const delta = Date.parse(left.record.createdAt) - Date.parse(right.record.createdAt);
            if (delta !== 0)
                return delta;
            return left.fileName.localeCompare(right.fileName);
        });
    }
    /** Read and validate one handoff file. */
    async readHandoff(filePath) {
        const absolute = isAbsolute(filePath) ? filePath : resolve(this.repoPath, filePath);
        const text = await readDocument(absolute, 'handoff file');
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch (error) {
            throw new StoreError('store/corrupt', `${absolute}: invalid JSON (${error.message})`, absolute);
        }
        const problems = handoffRecordProblems(parsed);
        if (problems.length > 0) {
            throw new StoreError('store/corrupt', problemMessage('handoff is invalid', absolute, problems), absolute);
        }
        return parsed;
    }
    /**
     * Write one handoff file under the project lock. The default file name comes
     * from the record's own `createdAt`, so the file name is predictable; a
     * second write to the same name is rejected instead of overwriting a source
     * of truth.
     */
    async writeHandoff(record, fileName) {
        const problems = handoffRecordProblems(record);
        if (problems.length > 0) {
            throw new StoreError('store/invalid-handoff', problemMessage('handoff record is invalid', this.handoffsDir, problems), this.handoffsDir);
        }
        const name = fileName ?? handoffFileName(record.threadId, new Date(record.createdAt));
        if (basename(name) !== name || !name.endsWith(HANDOFF_SUFFIX)) {
            throw new StoreError('store/invalid', `handoff file name must be a plain <name>.json: ${name}`);
        }
        await this.ensureProjectDir();
        return this.withLock(async () => {
            const filePath = join(this.handoffsDir, name);
            if ((await readTextIfPresent(filePath)) !== undefined) {
                throw new StoreError('store/handoff-exists', `handoff file already exists: ${filePath}`, filePath);
            }
            await writeJsonAtomic(filePath, record);
            return { filePath, fileName: name, record };
        });
    }
    /** Record successful delivery by rewriting `deliveredAt` in place. */
    async markHandoffDelivered(filePath, deliveredAt) {
        if (!isIsoDate(deliveredAt)) {
            throw new StoreError('store/invalid', `deliveredAt must be an ISO 8601 timestamp: ${deliveredAt}`);
        }
        const absolute = isAbsolute(filePath) ? filePath : resolve(this.repoPath, filePath);
        await this.ensureProjectDir();
        return this.withLock(async () => {
            const record = await this.readHandoff(absolute);
            const next = { ...record, deliveredAt };
            await writeJsonAtomic(absolute, next);
            return { filePath: absolute, fileName: basename(absolute), record: next };
        });
    }
    /**
     * Every review file, ordered by `createdAt` epoch (then by file name). A
     * missing reviews directory is an empty list; a review file this store
     * cannot validate raises `store/corrupt` rather than being skipped.
     */
    async listReviews() {
        let names;
        try {
            names = await readdir(this.reviewsDir);
        }
        catch (error) {
            const code = error.code;
            if (code === 'ENOENT' || code === 'ENOTDIR')
                return [];
            throw error;
        }
        const files = [];
        for (const fileName of names.filter((name) => name.endsWith(REVIEW_SUFFIX)).sort()) {
            const filePath = join(this.reviewsDir, fileName);
            files.push({ filePath, fileName, record: await this.readReview(filePath) });
        }
        return files.sort((left, right) => {
            const delta = Date.parse(left.record.createdAt) - Date.parse(right.record.createdAt);
            if (delta !== 0)
                return delta;
            return left.fileName.localeCompare(right.fileName);
        });
    }
    /**
     * Newest verdict per thread. A review file this store cannot read means "that
     * thread has no review" for this projection (its index pointer is tried
     * instead), not a failed status call; the index itself still fails in
     * {@link readIndex}.
     */
    async latestReviews(threads) {
        let files = [];
        try {
            files = await this.listReviews();
        }
        catch {
            files = [];
        }
        // listReviews is ascending by createdAt, so the last write per thread wins.
        const newest = new Map();
        for (const file of files)
            newest.set(file.record.threadId, file);
        const rows = [];
        for (const thread of threads) {
            let file = newest.get(thread.threadId) ?? null;
            const path = thread.latestReviewPath;
            if (file === null && path !== null) {
                try {
                    file = { filePath: path, fileName: basename(path), record: await this.readReview(path) };
                }
                catch {
                    file = null;
                }
            }
            if (file === null)
                continue;
            const { verdict, summary, createdAt } = file.record;
            rows.push({ threadId: thread.threadId, verdict, summary, reviewedAt: createdAt, filePath: file.filePath });
        }
        return rows;
    }
    /** Read and validate one review file. */
    async readReview(filePath) {
        const absolute = isAbsolute(filePath) ? filePath : resolve(this.repoPath, filePath);
        const text = await readDocument(absolute, 'review file');
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch (error) {
            throw new StoreError('store/corrupt', `${absolute}: invalid JSON (${error.message})`, absolute);
        }
        const problems = reviewRecordProblems(parsed);
        if (problems.length > 0) {
            throw new StoreError('store/corrupt', problemMessage('review is invalid', absolute, problems), absolute);
        }
        return parsed;
    }
    /**
     * Write one review file under the project lock. The file name comes from the
     * record's own `createdAt`, so it is predictable; a second write to the same
     * name is rejected (`store/review-exists`) instead of overwriting a verdict
     * the index may already point at.
     */
    async writeReview(record) {
        const problems = reviewRecordProblems(record);
        if (problems.length > 0) {
            throw new StoreError('store/invalid-review', problemMessage('review record is invalid', this.reviewsDir, problems), this.reviewsDir);
        }
        const name = reviewFileName(record.threadId, new Date(record.createdAt));
        await this.ensureProjectDir();
        await mkdir(this.reviewsDir, { recursive: true, mode: DIR_MODE });
        return this.withLock(async () => {
            const filePath = join(this.reviewsDir, name);
            if ((await readTextIfPresent(filePath)) !== undefined) {
                throw new StoreError('store/review-exists', `review file already exists: ${filePath}`, filePath);
            }
            await writeJsonAtomic(filePath, record);
            return { filePath, fileName: name, record };
        });
    }
    /** Create the project directory once, before any lock or write touches it. */
    async ensureProjectDir() {
        await mkdir(this.projectDir, { recursive: true, mode: DIR_MODE });
    }
    /** Run `operation` while holding the project write lock. */
    async withLock(operation) {
        return withProjectLock(this.lockFile, operation);
    }
    /** Parse one index document, reporting damaged JSON with its path. */
    parseIndexText(text) {
        try {
            return JSON.parse(text);
        }
        catch (error) {
            throw new StoreError('store/corrupt', `${this.indexFile}: invalid JSON (${error.message})`, this.indexFile);
        }
    }
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
    async readIndexForWrite() {
        const originalText = await readDocument(this.indexFile, 'project index');
        const parsed = this.parseIndexText(originalText);
        let migrated;
        try {
            migrated = migrateV1ToV2(parsed);
        }
        catch (error) {
            if (error instanceof MigrationError) {
                throw new StoreError('store/corrupt', problemMessage('project index cannot be migrated', this.indexFile, [error.message]), this.indexFile);
            }
            throw error;
        }
        migrated.document = normalizeProjectIndexV2(migrated.document);
        const problems = projectIndexV2Problems(migrated.document);
        if (problems.length > 0) {
            throw new StoreError('store/corrupt', problemMessage('migrated project index is invalid', this.indexFile, problems), this.indexFile);
        }
        if (!migrated.report.migrated)
            return normalizeProjectIndexV2(migrated.document);
        try {
            await this.writeMigrationBackup(originalText);
            migrated.report.archiveFailures = await this.archivePendingReviewers(migrated.report.pendingReviewerArchives);
            await writeJsonAtomic(this.indexFile, migrated.document);
        }
        catch (error) {
            // The backup and the original v1 document are both still on disk: report
            // the failure instead of retrying into a silently rebuilt index.
            throw new StoreError('store/corrupt', problemMessage('project index migration failed', this.indexFile, [describeFailure(error)]), this.indexFile);
        }
        // KI-20: v2 is already committed. The activity record is evidence and must
        // not roll the migration back; a retry sees v2 and never archives again, so
        // report the append failure instead of rewriting a half-migrated index.
        try {
            await this.recordMigrationActivity(migrated.report);
        }
        catch (error) {
            migrated.report.activityFailure = describeFailure(error);
        }
        this.migrationReport = migrated.report;
        return migrated.document;
    }
    /** Copy the original v1 index text once, before `index.json` becomes v2. */
    async writeMigrationBackup(originalText) {
        if ((await readTextIfPresent(this.backupFile)) !== undefined)
            return;
        await writeFileAtomic(this.backupFile, originalText, { mode: FILE_MODE, dirMode: DIR_MODE });
        await fsyncDirectory(this.projectDir);
    }
    /** Archive the reviewers of the v1 reviews the migration cancelled. */
    async archivePendingReviewers(pending) {
        const failures = [];
        for (const entry of pending) {
            try {
                if (this.archiveSession === undefined) {
                    throw new Error('no archiveSession port is wired into ProjectStore');
                }
                await this.archiveSession(entry.reviewerSessionId, { stopActivity: true });
            }
            catch (error) {
                failures.push({ ...entry, message: describeFailure(error) });
            }
        }
        return failures;
    }
    /** Record the migration, plus one error event per reviewer left un-archived. */
    async recordMigrationActivity(report) {
        const archived = report.pendingReviewerArchives.filter((entry) => !report.archiveFailures.some((failure) => failure.topicId === entry.topicId && failure.reviewerSessionId === entry.reviewerSessionId));
        await this.appendActivityLocked(this.activityEvent('status-changed', null, `migrated project index to v${report.toVersion}`, {
            fromVersion: report.fromVersion,
            statusCounts: report.statusCounts,
            archivedReviewers: archived.map((entry) => entry.reviewerSessionId),
        }));
        for (const failure of report.archiveFailures) {
            await this.appendActivityLocked(this.activityEvent('error', failure.topicId, `could not archive reviewer ${failure.reviewerSessionId}`, {
                topicId: failure.topicId,
                reviewerSessionId: failure.reviewerSessionId,
                message: failure.message,
            }));
        }
    }
    /** Build one activity event stamped with the injected clock. */
    activityEvent(type, topicId, summary, details) {
        return { eventId: randomUUID(), time: this.now().toISOString(), type, topicId, summary, details };
    }
    /** Read the activity stream without taking the lock. */
    async readActivityLocked() {
        const text = (await readTextIfPresent(this.activityFile)) ?? '';
        const events = [];
        let skippedLines = 0;
        for (const line of text.split('\n')) {
            if (line.trim() === '')
                continue;
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                skippedLines += 1;
                continue;
            }
            if (activityEventProblems(parsed).length > 0) {
                skippedLines += 1;
                continue;
            }
            events.push(parsed);
        }
        return { events, skippedLines };
    }
    /** Append one event and rewrite the trimmed stream (the caller holds the lock). */
    async appendActivityLocked(event) {
        const { events } = await this.readActivityLocked();
        const kept = trimActivityEvents([...events, event]);
        await writeFileAtomic(this.activityFile, serializeActivityEvents(kept), {
            mode: FILE_MODE,
            dirMode: DIR_MODE,
        });
        await fsyncDirectory(this.projectDir);
    }
}
/** The file name of one handoff: `<threadId>-YYYYMMDDTHHmmssSSSZ.json` in UTC. */
export function handoffFileName(threadId, createdAt) {
    return `${threadId}-${handoffStamp(createdAt)}${HANDOFF_SUFFIX}`;
}
/** The file name of one review: the handoff stamp format, under the reviews directory. */
export function reviewFileName(threadId, createdAt) {
    return `${threadId}-${handoffStamp(createdAt)}${REVIEW_SUFFIX}`;
}
/** The `git remote get-url origin` value, or `undefined` when there is no usable remote. */
async function readOriginRemote(repoPath) {
    try {
        const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
            cwd: repoPath,
            encoding: 'utf8',
        });
        const remote = String(stdout).trim();
        return remote === '' ? undefined : remote;
    }
    catch {
        // No repository, no remote, or no git binary all mean "fall back to the path hash".
        return undefined;
    }
}
/**
 * Normalize a git remote URL into a `<host>-<path>` project id.
 *
 * The host keeps its dots (`github.com`) and loses any port; path segments are
 * lowercased, joined with `-`, and anything outside `[a-z0-9-]` becomes `-`.
 * `https://github.com/Owner/Repo.git` and `git@github.com:Owner/Repo.git` both
 * yield `github.com-owner-repo`. An unparseable remote yields `''` so the
 * caller can fall back to the path hash.
 */
function normalizeRemoteUrl(remote) {
    const value = remote.trim();
    if (value === '')
        return '';
    let host;
    let path;
    const scpLike = /^[^/@\s]+@([^:/\s]+):(.+)$/.exec(value);
    if (scpLike !== null && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
        host = scpLike[1];
        path = scpLike[2];
    }
    else {
        let parsed;
        try {
            parsed = new URL(value);
        }
        catch {
            return '';
        }
        host = parsed.hostname;
        path = parsed.pathname;
    }
    host = host
        .toLowerCase()
        .replace(/:\d+$/, '')
        .replace(/^\[|\]$/g, '');
    const segments = path
        .split('/')
        .map((segment) => segment.trim().toLowerCase())
        .filter((segment) => segment !== '')
        .map((segment) => segment.replace(/\.git$/, ''))
        .map((segment) => segment.replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, ''))
        .filter((segment) => segment !== '');
    const parts = [...(host === '' ? [] : [host]), ...segments];
    const normalized = parts.join('-').replace(/[^a-z0-9.-]/g, '-').replace(/^-+|-+$/g, '');
    return normalized;
}
/**
 * The project's stable identity: the normalized `origin` remote when the
 * repository has one, otherwise `sha256(realpath(repoPath))` truncated to 12
 * hex characters (a path with no remote still gets a stable id).
 */
export async function projectIdFor(repoPath) {
    const resolved = resolve(repoPath);
    const remote = await readOriginRemote(resolved);
    if (remote !== undefined) {
        const normalized = normalizeRemoteUrl(remote);
        if (normalized !== '')
            return normalized;
    }
    return createHash('sha256').update(await realpath(resolved)).digest('hex').slice(0, PROJECT_ID_HASH_LENGTH);
}
/** Walk up from `startPath` to the nearest directory holding `.dsh-cowork/index.json`. */
export async function findProjectRoot(startPath) {
    let current = resolve(startPath);
    try {
        const info = await stat(current);
        if (info.isFile())
            current = dirname(current);
    }
    catch (error) {
        const code = error.code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR')
            throw error;
    }
    for (;;) {
        if ((await readTextIfPresent(join(current, PROJECT_DIR_NAME, INDEX_FILE_NAME))) !== undefined) {
            return current;
        }
        const parent = dirname(current);
        if (parent === current)
            return null;
        current = parent;
    }
}
/**
 * Synchronous {@link findProjectRoot}: walk up from `startPath` to the nearest
 * directory holding `.dsh-cowork/index.json`. The system-prompt section asks
 * this on every prompt assembly, where an async lookup is not available.
 */
export function findProjectRootSync(startPath) {
    let current = resolve(startPath);
    try {
        if (statSync(current).isFile())
            current = dirname(current);
    }
    catch (error) {
        const code = error.code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR')
            throw error;
    }
    for (;;) {
        if (existsSync(join(current, PROJECT_DIR_NAME, INDEX_FILE_NAME)))
            return current;
        const parent = dirname(current);
        if (parent === current)
            return null;
        current = parent;
    }
}
//# sourceMappingURL=store.js.map