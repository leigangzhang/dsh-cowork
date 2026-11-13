/**
 * Thin adapter over the host session/workspace services.
 *
 * The module depends only on structural ports so it can be unit tested without
 * a running DSH host; the plugin wires the real `sessionController` and
 * `workspaceRegistry` in src/index.ts. It owns no state and caches no id: the
 * workspace registry stays the single source of truth.
 */
/** Every thread session is renamed with this prefix so the sidebar groups them. */
export declare const THREAD_TITLE_PREFIX = "cowork: ";
/** Every reviewer session is renamed with this prefix, distinguishing it from a working thread. */
export declare const REVIEW_TITLE_PREFIX = "cowork review: ";
export interface SessionCreateRequest {
    workspaceId?: string;
    cwd?: string;
    /**
     * Explicit session id. The checkout flow mints `session-<uuid>` first because
     * the thread id names the clone directory and the `cowork/<id>` branch, so it
     * has to exist before the session does.
     */
    sessionId?: string;
    agentPreset?: string;
}
export interface SessionCreateResult {
    sessionId: string;
    agentPreset?: string;
}
export interface SessionPromptRequest {
    requestId: string;
    sessionId: string;
    mode: 'queue' | 'steer';
    content: ReadonlyArray<{
        type: 'text';
        text: string;
    }>;
}
export interface SessionRow {
    sessionId: string;
    running: boolean;
}
export interface SessionHeader {
    id: string;
    cwd?: string;
    agentPreset?: string;
}
/** Outcome of one workspace attachment; a refusal is a value, not a throw. */
export interface AttachSessionResult {
    attached: boolean;
    /** The host's refusal reason, present only when `attached` is false. */
    error?: string;
}
export interface SessionSlicePorts {
    sessions: {
        create(request: SessionCreateRequest): Promise<SessionCreateResult>;
        rename(request: {
            sessionId: string;
            title: string;
        }): Promise<{
            title: string;
            seq: number;
        }>;
        prompt(request: SessionPromptRequest, signal?: AbortSignal): Promise<{
            accepted: boolean;
        }>;
        list(request?: unknown, signal?: AbortSignal): Promise<{
            items: readonly SessionRow[];
        }>;
        inspect(sessionId: string, signal?: AbortSignal): Promise<{
            meta: SessionHeader;
        }>;
    };
    workspaces: {
        resolveByPath(path: string): Promise<{
            id: string;
            path: string;
        } | undefined>;
        create(path: string, title?: string): Promise<{
            id: string;
            path: string;
        }>;
        /**
         * Attach an existing session to a workspace. Optional because hand-built
         * test ports and older embedders may not expose it; a missing port is
         * reported as an unattached result, never as a failed project init.
         */
        attachSession?(workspaceId: string, sessionId: string): Promise<void>;
        /** Remove a workspace; `false` means it was already gone. */
        delete(id: string): Promise<boolean>;
        /**
         * Archive a session through the host's owner of that operation. `options`
         * is forwarded verbatim: the M7 migration passes `{stopActivity: true}` so a
         * running reviewer can be archived instead of being refused.
         */
        archiveSession(sessionId: string, options?: {
            stopActivity?: boolean;
        }): Promise<void>;
        /**
         * Restore an archived session. Optional: not every host exposes it, and a
         * missing port is reported as a failure only to the caller that needs it
         * (reopening a topic logs it), never as a failed project init.
         */
        unarchiveSession?(sessionId: string): Promise<void>;
    };
}
export interface SessionSliceOptions {
    requestId?: () => string;
    promptTimeoutMs?: number;
}
export declare class SessionSlice {
    #private;
    constructor(ports: SessionSlicePorts, options?: SessionSliceOptions);
    /**
     * Resolve a workspace id for a repository path, creating the workspace when
     * the registry does not know the path yet. The title is deliberately not
     * passed: the host derives it from the last path segment.
     */
    resolveWorkspaceId(repoPath: string): Promise<string>;
    /**
     * Attach a session to a workspace without failing the caller.
     *
     * Project init and the startup repair both need a truthful answer to "can the
     * sidebar see this project?", and neither may abort because the host refused
     * the attachment. The host's reason is returned in the value so the caller can
     * warn and surface it; a port without `attachSession` is reported the same way
     * instead of being treated as success.
     */
    attachSession(workspaceId: string, sessionId: string): Promise<AttachSessionResult>;
    /**
     * Create a thread session in the target workspace and rename it to
     * `cowork: <subject>`. The host's rename result wins: it may normalize the
     * title, and callers must show what the sidebar actually shows.
     */
    createThread(options: {
        repoPath: string;
        subject: string;
        presetId: string;
    }): Promise<{
        sessionId: string;
        workspaceId: string;
        title: string;
    }>;
    /**
     * Create a thread whose workspace *is* its checkout clone.
     *
     * Order is load-bearing: the workspace is created on `checkoutPath` first (so
     * the session mounts inside the clone), the session is created with the
     * explicit `sessionId` the caller already used for the clone directory and
     * branch, and only then is it renamed. Two fail-closed checks run between the
     * create and the rename, in this order:
     *
     * 1. the host must return the session id we asked for — the caller's thread
     *    id names the clone path and the `cowork/<id>` branch, so a host that
     *    mints a different id would leave the index pointing at a session that
     *    does not own the clone (and the rename below would retitle the wrong
     *    session);
     * 2. the session must have mounted the requested preset.
     *
     * Either failure throws before the rename, so neither the rename nor the
     * caller's index write happens.
     */
    createCheckoutThread(options: {
        repoPath: string;
        checkoutPath: string;
        threadId: string;
        subject: string;
        presetId: string;
    }): Promise<{
        sessionId: string;
        workspaceId: string;
        title: string;
    }>;
    /**
     * Create the independent reviewer session for one review request.
     *
     * The session joins the project's own workspace (a review reads the main
     * repository and, for an isolated thread, that thread's clone), mounts the
     * requested preset, and is renamed to `cowork review: <subject>`. The preset
     * check runs before the rename and fails closed: a session without the
     * reviewer preset would have the wrong tool surface, so it must not be
     * renamed and must not be recorded as a reviewer.
     */
    createReviewSession(options: {
        repoPath: string;
        subject: string;
        presetId: string;
    }): Promise<{
        sessionId: string;
        workspaceId: string;
        title: string;
    }>;
    /**
     * Remove a workspace from the registry. `false` means it was already gone and
     * is not an error: checkout teardown must stay idempotent.
     */
    deleteWorkspace(workspaceId: string): Promise<boolean>;
    /**
     * Archive a session through the workspace registry (the host's owner of that
     * operation); failures propagate so teardown can report them. `options` is
     * forwarded unchanged, so a caller without options keeps the old behaviour.
     */
    archiveSession(sessionId: string, options?: {
        stopActivity?: boolean;
    }): Promise<void>;
    /**
     * Restore an archived session; a port that does not expose it raises, so the
     * caller can log one honest reason instead of assuming the sidebar is back.
     */
    unarchiveSession(sessionId: string): Promise<void>;
    /**
     * Queue a text prompt. `accepted: false` is not an error: it only means the
     * host refused to queue, and the caller decides whether to surface or retry.
     */
    promptSession(sessionId: string, text: string): Promise<{
        accepted: boolean;
        requestId: string;
    }>;
    /**
     * Report whether a session is still visible to the host. Missing sessions are
     * not recreated here: a vanished thread means the index and the host have
     * diverged and the caller must report that instead of silently rebinding.
     */
    ensureSession(sessionId: string): Promise<boolean>;
    /** Rename a session; failures propagate so callers never assume success. */
    renameSession(sessionId: string, title: string): Promise<void>;
}
