import { type PanelErrorBody, type PanelErrorCode, type PanelTopic } from './api-contract.js';
import type { NoticeLedgerV1, TopicNoticePort } from './notices.js';
import type { ActivityEvent, InboxItem, ProjectIndexV2, ReadActivityResult, TopicRecordV2 } from './store-schema.js';
import { PanelServiceError } from './request-service.js';
/** One metadata row of the host's session listing; only id and cwd matter here. */
export interface PanelSessionRow {
    readonly sessionId: string;
    /** The session's working directory; the only accepted start for project discovery. */
    readonly cwd?: string;
}
/**
 * Store operations the routes may perform. `ProjectStore` satisfies this
 * structurally. The writer half (`mutateIndexDocument`/`appendActivity`) is used
 * only by the three POST routes; the reads never call a write.
 */
export interface CoworkStorePort {
    hasIndex(): Promise<boolean>;
    readIndexDocument(): Promise<ProjectIndexV2>;
    mutateIndexDocument(mutator: (document: ProjectIndexV2) => ProjectIndexV2 | null): Promise<ProjectIndexV2>;
    appendActivity(event: ActivityEvent): Promise<void>;
    readActivity(limit?: number): Promise<ReadActivityResult>;
    readInbox(): Promise<InboxItem[]>;
    /** Raw text read of one project-owned file; `null` when the file is gone. */
    readText(absPath: string): Promise<string | null>;
    /** The notice ledger; the inbox note stream reads it without writing it. */
    readNotices?(): Promise<NoticeLedgerV1>;
    /** `<repo>/.dsh-cowork/reviews`, the only home of review-request facts. */
    readonly reviewsDir: string;
}
/** The host facts a route needs, injected so tests can stand in for the host. */
export interface CoworkApiPorts {
    /**
     * Session metadata, deliberately `list` and not `inspect`: on a live host
     * `inspect` waits for the session's event log (the panel request hung on
     * running or large sessions), while the listing is a cheap summary read that
     * already carries `cwd`.
     */
    listSessions(): Promise<{
        readonly items: readonly PanelSessionRow[];
    }>;
    /**
     * Bound on {@link listSessions}, in milliseconds. Production leaves this
     * unset and gets {@link LIST_SESSIONS_TIMEOUT_MS}; tests inject a few
     * milliseconds so the timeout path is deterministic without waiting 30 s.
     * Not part of the wire contract: it only bounds the host call.
     */
    listSessionsTimeoutMs?: number;
    findProjectRoot(startPath: string): Promise<string | null>;
    createStore(repoPath: string): CoworkStorePort;
    /**
     * Clock for the write routes and the lifecycle read point. Production passes
     * the same `() => new Date()` that the store stamps with; tests freeze it.
     */
    now?(): Date;
    /** Idle threshold for the lifecycle read point; `src/topic.ts` owns the default. */
    idleAfterMs?: number;
    /**
     * Deprecated and ignored: the lifecycle no longer resolves a topic on its
     * own. Kept so a caller wired for the old `resolveAfterMs` still typechecks.
     */
    resolveAfterMs?: number;
    /** Diagnostic sink for a non-fatal failure (lifecycle/activity write). */
    log?(message: string): void;
    /** Archive the host session of an archived topic; a failure is logged only. */
    archiveSession?(sessionId: string, options?: {
        stopActivity?: boolean;
    }): Promise<void>;
    /** Restore the host session of a reopened topic; a failure is logged only. */
    unarchiveSession?(sessionId: string): Promise<void>;
    /** Prompt the topic session after an authorization decision. */
    promptSession?(sessionId: string, text: string): Promise<{
        accepted: boolean;
    }>;
    /** Host notice port, used to update the original authorization notice. */
    noticePort?: TopicNoticePort;
    /**
     * Host file-browser port for `POST /api/cowork.inbox.open`. Optional: a host
     * without the desktop capability answers `inbox/open-unsupported` instead of
     * faking a success.
     */
    openWorkspacePath?(path: string): Promise<void>;
    /** Schedule the notice dispatcher for one project after a committed write. */
    kickNotices?(repoPath: string): void;
}
/** Methods the connection channel supports for a registered route. */
export type PanelFetchMethod = 'GET' | 'HEAD' | 'POST';
/** Whether the channel buffers or streams the request body before the handler. */
export type PanelRequestBodyMode = 'buffered' | 'streaming';
export { panelErrorStatus, PANEL_ERROR_STATUS } from './api-contract.js';
/** One Exact Fetch route as the host `connection` service declares it. */
export interface PanelFetchRoute {
    readonly path: string;
    readonly methods: readonly PanelFetchMethod[];
    readonly requestBody: PanelRequestBodyMode;
    readonly fetch: (request: Request) => Promise<Response>;
}
/** The slice of the host `connection` service this module registers on. */
export interface CoworkConnection {
    readonly fetch: {
        register(route: PanelFetchRoute): () => Promise<void>;
    };
}
/**
 * The Cordis context surface used here. `get` mirrors `ctx.get(name)`: it
 * returns `undefined` when the service is absent instead of throwing, which is
 * what keeps the plugin loadable in a host without `connection`.
 */
export interface CoworkApiHost {
    get(name: string): unknown;
    effect(execute: () => unknown, label?: string): void;
}
/**
 * A failure the routes map to a stable panel error code and HTTP status.
 * `PanelServiceError` is the shared base, so a failure raised by
 * `src/request-service.ts` (resolve/open) and one raised here answer with the
 * same envelope.
 */
export declare class PanelApiError extends PanelServiceError {
    constructor(code: PanelErrorCode, message: string, path?: string);
}
/** One route failure: HTTP status plus the shared error envelope. */
export interface PanelErrorResult {
    readonly status: number;
    readonly body: PanelErrorBody;
}
/**
 * How long a route waits for the host's session listing. The listing is a
 * metadata read that answers in milliseconds on a healthy host, but an old
 * fiber or a very large session list has been observed to hang for minutes
 * (KI-12); waiting forever turns that into an endless panel spinner. Giving up
 * with a retryable 504 is better than a request that never settles.
 */
export declare const LIST_SESSIONS_TIMEOUT_MS = 30000;
/**
 * Map any failure the routes may raise onto the panel error contract:
 * `PanelApiError` keeps its code, a corrupt store keeps its file path, and
 * everything else degrades to `internal` rather than leaking a status the
 * client cannot interpret.
 */
export declare function toErrorResponse(error: unknown): PanelErrorResult;
/** One JSON response with the headers every panel route shares. */
export declare function jsonResponse(status: number, payload: unknown): Response;
/**
 * Project one v2 topic onto the wire shape. Review state comes from the index
 * row (the request files carry the detail); `reviews` are read separately by
 * the topic route. No reviewer session or handoff text is copied onto the wire.
 */
export declare function toPanelTopic(document: ProjectIndexV2, topic: TopicRecordV2): PanelTopic;
/**
 * Register the ten panel routes on the host connection service.
 *
 * A host without `connection` (older builds, unit hosts) simply gets no panel
 * API: this returns without throwing so the rest of the plugin keeps loading.
 * The disposer returned by `register` rides the plugin fiber through
 * `ctx.effect`, so a hot reload unregisters the route instead of tripping over
 * a duplicate on the next load.
 */
export declare function registerCoworkApi(host: CoworkApiHost, ports: CoworkApiPorts): void;
