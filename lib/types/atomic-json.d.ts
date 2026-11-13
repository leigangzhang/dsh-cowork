/** File mode for every document these stores write (owner read/write only). */
export declare const FILE_MODE = 384;
/** Directory mode for every directory these stores create. */
export declare const DIR_MODE = 448;
/** How long a writer waits for the project lock before failing. */
export declare const LOCK_WAIT_MS = 5000;
/** Name of the one writer lock shared by every store under `.dsh-cowork/`. */
export declare const LOCK_FILE_NAME = ".write.lock";
/** Flush a directory entry so a completed rename survives a crash. */
export declare function fsyncDirectory(directory: string): Promise<void>;
/** Read a file as UTF-8 text, or `undefined` when it does not exist. */
export declare function readTextIfPresent(filePath: string): Promise<string | undefined>;
/** Write text atomically (private temp sibling, rename, then directory fsync). */
export declare function writeTextAtomic(filePath: string, content: string): Promise<void>;
/** Write one JSON document atomically, with the repository's stable formatting. */
export declare function writeJsonAtomic(filePath: string, value: unknown): Promise<void>;
/**
 * Run `operation` while holding the project writer lock, creating the project
 * directory first. This is the one lock entry point every store uses.
 */
export declare function withProjectLock<T>(lockFile: string, operation: () => Promise<T>): Promise<T>;
