/** Write `content` to `file` atomically and durably (file via rename, then the parent directory). */
export declare function writeStoreAtomic(file: string, content: string): Promise<void>;
/** Read the store's raw UTF-8 text. */
export declare function readStoreText(file: string): Promise<string>;
/** Temp siblings `writeFileAtomic` would leave behind on failure (empty after success). */
export declare function listAtomicTempSiblings(file: string): Promise<string[]>;
