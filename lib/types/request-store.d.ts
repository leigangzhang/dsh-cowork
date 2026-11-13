import type { RequestRecordV1 } from './inbox-contract.js';
/** What one scan of the request directory found. */
export interface RequestScan {
    /** Every valid request, newest `updatedAt` first. */
    readonly records: RequestRecordV1[];
    /** Files the scan looked at (valid or not). */
    readonly scanned: number;
    /** Files skipped as damaged or non-conforming. */
    readonly skipped: number;
    /** True when the directory holds more files than the scan cap. */
    readonly truncated: boolean;
}
/** Construction options for {@link RequestStore}. */
export interface RequestStoreOptions {
    /** Repository root that owns `.dsh-cowork/`. */
    repoPath: string;
    /** Diagnostic sink for a skipped file and a failed post-commit write. */
    log?: (message: string) => void;
}
/**
 * The request directory of one project. Every method takes the project path,
 * not a store instance, so the routes and tools can build it from the
 * `repoPath` they already resolved.
 */
export declare class RequestStore {
    readonly repoPath: string;
    /** `<repo>/.dsh-cowork`. */
    readonly projectDir: string;
    /** `<repo>/.dsh-cowork/requests`. */
    readonly requestsDir: string;
    /** `<repo>/.dsh-cowork/.write.lock`, shared with every other writer. */
    readonly lockFile: string;
    private readonly logSink;
    constructor(options: RequestStoreOptions);
    /**
     * Every request file, newest `updatedAt` first, bounded to
     * {@link INBOX_MAX_REQUEST_FILES}. A missing directory is an empty store; a
     * damaged file is skipped and reported to the log sink.
     */
    readAll(): Promise<RequestScan>;
    /** One request by id, or null when the file is missing; damage is skipped. */
    read(requestId: string): Promise<RequestRecordV1 | null>;
    /** Persist one new request under the project lock. */
    create(record: RequestRecordV1): Promise<RequestRecordV1>;
    /**
     * Locked read-modify-write of one request. The mutator re-reads the current
     * file under the lock, so two concurrent resolves serialize and the second
     * one sees the first terminal state. `null` from the mutator means "nothing
     * to write" and the current record is returned unchanged.
     */
    update(requestId: string, mutator: (current: RequestRecordV1) => RequestRecordV1 | null): Promise<RequestRecordV1 | null>;
    /** Locked patch of the delivery block, keeping the terminal state untouched. */
    recordDelivery(requestId: string, delivery: {
        promptedAt: string | null;
        lastError: string | null;
    }): Promise<RequestRecordV1 | null>;
    /**
     * Mark every pending request of one archived topic `void`. Returns the
     * records it changed so the caller can append one activity row each. A
     * failure is the caller's to log; nothing is deleted.
     */
    voidPendingForTopic(topicId: string, now: Date): Promise<RequestRecordV1[]>;
    /** Read and parse one request file, mapping a read failure to a skip. */
    private readFile;
    /** Run `operation` while holding the project writer lock. */
    private withLock;
    /** Create `requests/` with the private directory mode. */
    private ensureRequestsDir;
    private log;
}
