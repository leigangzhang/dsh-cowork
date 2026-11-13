/**
 * `requests/` storage of the Cowork request inbox.
 *
 * One request per JSON file under `<repo>/.dsh-cowork/requests/`. The directory
 * is its own module for the same reason `src/notice-store.ts` is: `src/store.ts`
 * sits at the repository's 50 KiB read cap, and the request files are a small,
 * orthogonal document set. Writes take the shared project writer lock
 * (`src/atomic-json.ts`, `<repo>/.dsh-cowork/.write.lock`) and go through
 * `writeJsonAtomic`, so a request write can never interleave with an index or
 * ledger writer, and a reader observes either the old or the new complete
 * file. Reads stay lock-free, like every other store read.
 *
 * A damaged or non-conforming file is skipped with a log line, never a thrown
 * read: one hand-edited request must not take the whole inbox down. Nothing
 * here deletes a request file; resolved and voided records stay as history.
 */
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DIR_MODE, LOCK_FILE_NAME, readTextIfPresent, withProjectLock, writeJsonAtomic, } from './atomic-json.js';
import { INBOX_MAX_REQUEST_FILES, } from './inbox-contract.js';
import { REQUEST_DIR_NAME, REQUEST_FILE_SUFFIX, applyResolution, isRequestId, parseRequestRecordText, requestFileName, requestRecordProblems, } from './request-schema.js';
/**
 * The request directory of one project. Every method takes the project path,
 * not a store instance, so the routes and tools can build it from the
 * `repoPath` they already resolved.
 */
export class RequestStore {
    repoPath;
    /** `<repo>/.dsh-cowork`. */
    projectDir;
    /** `<repo>/.dsh-cowork/requests`. */
    requestsDir;
    /** `<repo>/.dsh-cowork/.write.lock`, shared with every other writer. */
    lockFile;
    logSink;
    constructor(options) {
        this.repoPath = options.repoPath;
        this.projectDir = join(this.repoPath, '.dsh-cowork');
        this.requestsDir = join(this.projectDir, REQUEST_DIR_NAME);
        this.lockFile = join(this.projectDir, LOCK_FILE_NAME);
        this.logSink = options.log;
    }
    /**
     * Every request file, newest `updatedAt` first, bounded to
     * {@link INBOX_MAX_REQUEST_FILES}. A missing directory is an empty store; a
     * damaged file is skipped and reported to the log sink.
     */
    async readAll() {
        let names;
        try {
            names = await readdir(this.requestsDir);
        }
        catch (error) {
            const code = error.code;
            if (code === 'ENOENT' || code === 'ENOTDIR') {
                return { records: [], scanned: 0, skipped: 0, truncated: false };
            }
            throw error;
        }
        const files = names.filter((name) => name.endsWith(REQUEST_FILE_SUFFIX)).sort();
        const truncated = files.length > INBOX_MAX_REQUEST_FILES;
        const selected = truncated ? files.slice(0, INBOX_MAX_REQUEST_FILES) : files;
        const records = [];
        let skipped = 0;
        for (const name of selected) {
            const parsed = await this.readFile(join(this.requestsDir, name));
            if (!parsed.ok) {
                skipped += 1;
                this.log(`request file ${name} was skipped: ${parsed.problems.join('; ')}`);
                continue;
            }
            records.push(parsed.record);
        }
        records.sort((left, right) => {
            const delta = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
            if (Number.isFinite(delta) && delta !== 0)
                return delta;
            return left.requestId < right.requestId ? -1 : left.requestId > right.requestId ? 1 : 0;
        });
        return { records, scanned: selected.length, skipped, truncated };
    }
    /** One request by id, or null when the file is missing; damage is skipped. */
    async read(requestId) {
        if (!isRequestId(requestId))
            return null;
        const parsed = await this.readFile(join(this.requestsDir, requestFileName(requestId)));
        if (!parsed.ok)
            return null;
        return parsed.record;
    }
    /** Persist one new request under the project lock. */
    async create(record) {
        const problems = requestRecordProblems(record);
        if (problems.length > 0) {
            throw new Error(`request record is invalid: ${problems.join('; ')}`);
        }
        return this.withLock(async () => {
            await this.ensureRequestsDir();
            await writeJsonAtomic(join(this.requestsDir, requestFileName(record.requestId)), record);
            return record;
        });
    }
    /**
     * Locked read-modify-write of one request. The mutator re-reads the current
     * file under the lock, so two concurrent resolves serialize and the second
     * one sees the first terminal state. `null` from the mutator means "nothing
     * to write" and the current record is returned unchanged.
     */
    async update(requestId, mutator) {
        if (!isRequestId(requestId))
            return null;
        return this.withLock(async () => {
            const current = await this.read(requestId);
            if (current === null)
                return null;
            const next = mutator(current);
            if (next === null)
                return current;
            const problems = requestRecordProblems(next);
            if (problems.length > 0) {
                throw new Error(`resolved request record is invalid: ${problems.join('; ')}`);
            }
            await writeJsonAtomic(join(this.requestsDir, requestFileName(requestId)), next);
            return next;
        });
    }
    /** Locked patch of the delivery block, keeping the terminal state untouched. */
    async recordDelivery(requestId, delivery) {
        return this.update(requestId, (current) => ({ ...current, delivery }));
    }
    /**
     * Mark every pending request of one archived topic `void`. Returns the
     * records it changed so the caller can append one activity row each. A
     * failure is the caller's to log; nothing is deleted.
     */
    async voidPendingForTopic(topicId, now) {
        const scan = await this.readAll();
        const pending = scan.records.filter((record) => record.topicId === topicId && record.status === 'pending');
        const voided = [];
        for (const record of pending) {
            // The mutator runs inside the project lock; `withdrew` tells a record
            // this call voided from one a concurrent call already voided.
            let withdrew = false;
            const next = await this.update(record.requestId, (current) => {
                if (current.topicId !== topicId || current.status !== 'pending')
                    return null;
                withdrew = true;
                return applyResolution(current, { status: 'void', resolvedBy: 'user', now });
            });
            if (withdrew && next !== null)
                voided.push(next);
        }
        return voided;
    }
    /** Read and parse one request file, mapping a read failure to a skip. */
    async readFile(filePath) {
        let text;
        try {
            text = await readTextIfPresent(filePath);
        }
        catch (error) {
            return { ok: false, problems: [`unreadable (${error instanceof Error ? error.message : String(error)})`] };
        }
        if (text === undefined)
            return { ok: false, problems: ['file is missing'] };
        return parseRequestRecordText(text);
    }
    /** Run `operation` while holding the project writer lock. */
    async withLock(operation) {
        return withProjectLock(this.lockFile, operation);
    }
    /** Create `requests/` with the private directory mode. */
    async ensureRequestsDir() {
        await mkdir(this.requestsDir, { recursive: true, mode: DIR_MODE });
    }
    log(message) {
        this.logSink?.(message);
    }
}
//# sourceMappingURL=request-store.js.map