/**
 * The notice delivery ledger file (`<repo>/.dsh-cowork/notices.json`).
 *
 * Its own module on purpose: `src/store.ts` sits at the repository's 50 KiB
 * read cap, and the ledger is a small, orthogonal document. The file lives
 * under the same project lock and atomic-write helper as the index, so a ledger
 * write can never interleave with another writer; the reader stays lock-free
 * like every other store read.
 *
 * Errors are values with a stable code; `src/store.ts` maps them onto its own
 * `StoreError`, which is what the tool and route layers already understand.
 */
import { readTextIfPresent, withProjectLock, writeJsonAtomic, } from './atomic-json.js';
import { emptyNoticeLedger, parseNoticeLedgerText, prepareNoticeLedger } from './notices.js';
/** A ledger read/write failure carrying a stable code and the offending file. */
export class NoticeFileError extends Error {
    code;
    filePath;
    constructor(code, message, filePath) {
        super(message);
        this.name = 'NoticeFileError';
        this.code = code;
        this.filePath = filePath;
    }
}
/** The ledger document as the store reads and writes it. */
export class NoticeLedgerFile {
    projectDir;
    noticesFile;
    lockFile;
    constructor(projectDir, noticesFile, lockFile) {
        this.projectDir = projectDir;
        this.noticesFile = noticesFile;
        this.lockFile = lockFile;
    }
    /** Read the ledger: a missing file is empty, damage is `corrupt`. */
    async read() {
        const text = await readTextIfPresent(this.noticesFile);
        if (text === undefined)
            return emptyNoticeLedger();
        const parsed = parseNoticeLedgerText(text);
        if (parsed.jsonError !== null) {
            throw new NoticeFileError('corrupt', `invalid JSON (${parsed.jsonError})`, this.noticesFile);
        }
        if (parsed.ledger === null) {
            throw new NoticeFileError('corrupt', parsed.problems.join('; '), this.noticesFile);
        }
        return parsed.ledger;
    }
    /** Validate, trim, and persist a ledger under the project lock. */
    async write(ledger) {
        const prepared = prepareNoticeLedger(ledger);
        if (prepared.ledger === null) {
            throw new NoticeFileError('invalid', prepared.problems.join('; '), this.noticesFile);
        }
        const kept = prepared.ledger;
        return this.withLock(async () => {
            await this.persist(kept);
            return kept;
        });
    }
    /** Locked read-modify-write: concurrent appends must not lose each other. */
    async mutate(mutator) {
        return this.withLock(async () => {
            const prepared = prepareNoticeLedger(mutator(await this.read()));
            if (prepared.ledger === null) {
                throw new NoticeFileError('invalid', prepared.problems.join('; '), this.noticesFile);
            }
            await this.persist(prepared.ledger);
            return prepared.ledger;
        });
    }
    async withLock(operation) {
        return withProjectLock(this.lockFile, operation);
    }
    async persist(ledger) {
        await writeJsonAtomic(this.noticesFile, ledger);
    }
}
//# sourceMappingURL=notice-store.js.map