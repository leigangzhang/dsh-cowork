import type { NoticeLedgerV1 } from './notices.js';
/** A ledger read/write failure carrying a stable code and the offending file. */
export declare class NoticeFileError extends Error {
    readonly code: 'corrupt' | 'invalid';
    readonly filePath: string;
    constructor(code: 'corrupt' | 'invalid', message: string, filePath: string);
}
/** The ledger document as the store reads and writes it. */
export declare class NoticeLedgerFile {
    readonly projectDir: string;
    readonly noticesFile: string;
    readonly lockFile: string;
    constructor(projectDir: string, noticesFile: string, lockFile: string);
    /** Read the ledger: a missing file is empty, damage is `corrupt`. */
    read(): Promise<NoticeLedgerV1>;
    /** Validate, trim, and persist a ledger under the project lock. */
    write(ledger: NoticeLedgerV1): Promise<NoticeLedgerV1>;
    /** Locked read-modify-write: concurrent appends must not lose each other. */
    mutate(mutator: (ledger: NoticeLedgerV1) => NoticeLedgerV1): Promise<NoticeLedgerV1>;
    private withLock;
    private persist;
}
