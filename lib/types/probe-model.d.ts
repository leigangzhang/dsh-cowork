/** One session event as the probe consumes it. */
export interface ProbeEvent {
    readonly type: string;
    readonly seq: number;
    readonly time: number;
    readonly data: Record<string, unknown>;
}
/** Folded view of one completed turn. */
export interface TurnSummary {
    readonly turn: number | undefined;
    readonly startSeq: number | undefined;
    readonly endSeq: number | undefined;
    readonly reason: string | undefined;
    readonly text: string;
}
/** The on-disk probe store document. */
export interface StoreDocument {
    readonly runId: string;
    readonly token: string;
    readonly createdAt: number;
}
/** Whether a socket peer address is a loopback address. */
export declare function isLoopbackAddress(address: string | undefined): boolean;
/** Whether a Host header names this machine (a second gate against DNS rebinding). */
export declare function isLoopbackHost(host: string | undefined): boolean;
/**
 * Resolve a repository path to its real path so it compares equal to a host
 * session cwd, which macOS normalizes (`/tmp` → `/private/tmp`). A path that
 * does not exist yet keeps its configured spelling: realpath cannot resolve a
 * suffix that is not on disk, and failing here would break the probe config
 * before it creates anything.
 */
export declare function canonicalRepoPath(path: string): string;
/** Pathname of a request target, dropping the query. */
export declare function readPath(url: string | undefined): string;
/** One query parameter of a request target, or undefined. */
export declare function readQuery(url: string | undefined, name: string): string | undefined;
/** Validate a status query's run id. */
export declare function requireRunId(value: string | undefined): string;
/** Narrow an unknown JSON value to one object record. */
export declare function asRecord(value: unknown): Record<string, unknown> | undefined;
/** Assistant text carried by one `assistant/message` event. */
export declare function assistantText(event: ProbeEvent): string | undefined;
/** Turn-end reason kind of one `turn/end` event. */
export declare function turnEndKind(event: ProbeEvent): string | undefined;
/**
 * Fold the events of one turn: the last `turn/start` opens it, the last
 * `turn/end` closes it, and every assistant text between them is joined.
 * Events at or below `fromSeq` belong to earlier turns and are skipped.
 */
export declare function summarizeEvents(events: readonly ProbeEvent[], fromSeq?: number): TurnSummary;
/** Serialize a store document with a trailing newline. */
export declare function buildStoreDocument(document: StoreDocument): string;
/** Parse and validate a store document. */
export declare function parseStoreDocument(raw: string): StoreDocument;
