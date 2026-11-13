/**
 * Project memory module: the three markdown files (`constraints.md`,
 * `decisions.md`, `facts.md`) a cowork project keeps under
 * `.dsh-cowork/memory/`, plus the pure operations over their entries —
 * validation, parsing, rendering into a model-facing block, keyword search and
 * append under a caller-supplied lock.
 *
 * Everything here is pure logic plus an injected I/O port ({@link MemoryIo}), so
 * the whole surface runs under `node --test` without the host, a temporary
 * directory or the store. The module deliberately imports nothing but node
 * builtins: Node's TS type stripping does not rewrite `./x.js` to `./x.ts`, so a
 * value-level sibling import would make every test fail at resolution time.
 *
 * File format, exactly one entry per block:
 *
 * ```
 * ## <title>
 *
 * <text>
 *
 * (来源: <source>; <ISO 8601 UTC timestamp>)
 * ```
 *
 * Entries are separated by exactly one blank line and the file carries no
 * title of its own. A malformed entry is reported as an issue with a 1-based
 * line number instead of throwing: a single bad hand edit must not make the
 * other entries unreadable. {@link appendMemoryEntry} is the one place that
 * turns issues into a {@link MemoryCorruptError}, because appending to a file
 * it cannot fully parse would silently drop the unparsed tail.
 */
export type MemoryKind = 'constraint' | 'decision' | 'fact';
/** Tokenizer injected by the caller — the router's `tokenize` in production. */
export type Tokenize = (text: string) => readonly string[];
/** Render order as well as the canonical kind order (most to least binding). */
export declare const MEMORY_KINDS: readonly MemoryKind[];
export declare const MEMORY_FILES: Readonly<Record<MemoryKind, string>>;
/** Budget for the memory block injected into a model request. */
export declare const DEFAULT_MEMORY_BUDGET_TOKENS = 3000;
/** Longest single entry text accepted by {@link validateMemoryEntry}. */
export declare const MAX_ENTRY_TEXT_CHARS = 8000;
export declare const DEFAULT_SEARCH_LIMIT = 5;
export declare const MAX_SEARCH_LIMIT = 20;
export interface MemoryEntry {
    kind: MemoryKind;
    title: string;
    text: string;
    source: string;
    createdAt: string;
}
export interface MemoryFileIssue {
    /** File the issue was found in, as named by the caller. */
    file: string;
    /** 1-based line number. */
    line: number;
    message: string;
}
export interface ParsedMemoryFile {
    entries: MemoryEntry[];
    issues: MemoryFileIssue[];
}
export interface MemoryEntryInput {
    title: string;
    text: string;
    source: string;
}
export interface MemoryValidationIssue {
    /**
     * The field at fault. `kind` is an issue too: appending to the wrong file is
     * a validation error, and reporting it here (rather than casting it to one of
     * the entry fields) keeps the field name honest for the caller.
     */
    field: 'title' | 'text' | 'source' | 'kind';
    message: string;
}
export interface MemoryInjectInput {
    kind: MemoryKind;
    entries: readonly MemoryEntry[];
}
export interface MemoryBlock {
    text: string;
    truncated: boolean;
    tokens: number;
    entryCount: number;
}
export interface MemorySearchHit {
    kind: MemoryKind;
    title: string;
    text: string;
    source: string;
    file: string;
    createdAt: string;
    score: number;
}
export interface SearchOptions {
    tokenize: Tokenize;
    limit?: number;
}
export interface MemoryIo {
    readText(path: string): Promise<string | null>;
    writeText(path: string, text: string): Promise<void>;
    withLock<T>(operation: () => Promise<T>): Promise<T>;
}
export interface LoadedMemoryFile {
    kind: MemoryKind;
    file: string;
    entries: MemoryEntry[];
}
export interface MemoryLoadResult {
    files: LoadedMemoryFile[];
    issues: MemoryFileIssue[];
}
/**
 * Parse one memory file. Never throws for malformed content: each bad block
 * becomes an issue carrying the 1-based line the reader has to look at, and the
 * well-formed blocks are still returned so one hand edit cannot hide the rest.
 * CRLF (and stray CR) is normalised before splitting, so a Windows checkout
 * parses identically.
 */
export declare function parseMemoryFile(kind: MemoryKind, fileName: string, content: string): ParsedMemoryFile;
/**
 * Validate untrusted entry input before it is rendered or written. Returns
 * every problem at once so a caller can show them together; `kind` itself is
 * part of the input because appending to the wrong file must be caught here,
 * not by the file parser.
 */
export declare function validateMemoryEntry(kind: unknown, input: unknown): {
    ok: true;
    kind: MemoryKind;
    value: MemoryEntryInput;
} | {
    ok: false;
    issues: MemoryValidationIssue[];
};
/**
 * Render one entry in file format. The clock is injectable so a test (or a
 * caller that already owns a clock, such as the tools layer) can pin the
 * timestamp; without one this falls back to the wall clock. See the timestamp
 * policy at {@link SOURCE_LINE} for what the writer guarantees.
 */
export declare function renderMemoryEntry(entry: MemoryEntryInput, clock?: () => Date): string;
/** Token estimate: four characters per token, rounded up. */
export declare function estimateTokens(text: string): number;
/**
 * Render the memory block injected into a model request: one `### <kind>s`
 * section (`### constraints` …) per non-empty kind, in constraints → decisions →
 * facts order, with
 * whole entries only. The first entry that does not fit stops the block and
 * appends {@link TRUNCATION_MARKER}; `tokens` is measured on the final text, so
 * it can exceed the budget by the marker itself.
 */
export declare function renderMemoryBlock(files: readonly MemoryInjectInput[], budgetTokens?: number): MemoryBlock;
/**
 * Rank entries against a query with the injected tokenizer. Score is 3×title
 * hits + 2×text hits + 1×source hits over distinct tokens; zero scores are
 * dropped because a weak hit is noise in a 3000-token block. Ties fall back to
 * newest first, then title ascending, so the output is deterministic. The
 * tokenizer owns normalisation (case folding, CJK bigrams), which is why the
 * field text is tokenized by the same function rather than substring-matched.
 */
export declare function searchMemory(entries: readonly {
    kind: MemoryKind;
    file: string;
    entry: MemoryEntry;
}[], query: string, options: SearchOptions): MemorySearchHit[];
/** Directory holding the project memory files. */
export declare function memoryDirOf(repoPath: string): string;
/** Absolute path of one memory file. */
export declare function memoryFilePath(repoPath: string, kind: MemoryKind): string;
/**
 * Read all memory files through the injected port. A missing file is simply
 * absent from `files`; a malformed one is reported in `issues` while its
 * well-formed entries are still returned, so one broken file does not blank the
 * whole memory.
 */
export declare function loadMemory(io: Pick<MemoryIo, 'readText'>, repoPath: string): Promise<MemoryLoadResult>;
/** A memory file that cannot be parsed, so appending would lose entries. */
export declare class MemoryCorruptError extends Error {
    readonly file: string;
    readonly issues: MemoryFileIssue[];
    constructor(file: string, issues: MemoryFileIssue[]);
}
/**
 * Append one entry under the injected lock. Read → parse → fail on issues →
 * compose → re-parse whole file → write: the re-parse is the guard that the
 * composed content still parses (it also catches an entry whose text would let
 * it forge structure, though validation normally rejects that first). The
 * timestamp comes from the injected clock so tests stay deterministic.
 */
export declare function appendMemoryEntry(io: MemoryIo, repoPath: string, kind: MemoryKind, input: MemoryEntryInput, clock: () => Date): Promise<{
    file: string;
    filePath: string;
    entry: MemoryEntry;
}>;
