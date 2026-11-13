/**
 * Thin adapter over the host session/workspace services.
 *
 * The module depends only on structural ports so it can be unit tested without
 * a running DSH host; the plugin wires the real `sessionController` and
 * `workspaceRegistry` in src/index.ts. It owns no state and caches no id: the
 * workspace registry stays the single source of truth.
 */
/** Every thread session is renamed with this prefix so the sidebar groups them. */
export const THREAD_TITLE_PREFIX = 'cowork: ';
/** Every reviewer session is renamed with this prefix, distinguishing it from a working thread. */
export const REVIEW_TITLE_PREFIX = 'cowork review: ';
const PRESET_MISMATCH_PREFIX = 'session/create-preset-mismatch:';
const SESSION_ID_MISMATCH_PREFIX = 'session/create-id-mismatch:';
const DEFAULT_PROMPT_TIMEOUT_MS = 120_000;
export class SessionSlice {
    #ports;
    #options;
    constructor(ports, options = {}) {
        this.#ports = ports;
        this.#options = options;
    }
    /**
     * Resolve a workspace id for a repository path, creating the workspace when
     * the registry does not know the path yet. The title is deliberately not
     * passed: the host derives it from the last path segment.
     */
    async resolveWorkspaceId(repoPath) {
        const existing = await this.#ports.workspaces.resolveByPath(repoPath);
        if (existing !== undefined)
            return existing.id;
        const created = await this.#ports.workspaces.create(repoPath);
        return created.id;
    }
    /**
     * Attach a session to a workspace without failing the caller.
     *
     * Project init and the startup repair both need a truthful answer to "can the
     * sidebar see this project?", and neither may abort because the host refused
     * the attachment. The host's reason is returned in the value so the caller can
     * warn and surface it; a port without `attachSession` is reported the same way
     * instead of being treated as success.
     */
    async attachSession(workspaceId, sessionId) {
        const attach = this.#ports.workspaces.attachSession;
        if (attach === undefined) {
            return { attached: false, error: 'the host workspace port exposes no attachSession' };
        }
        try {
            await attach.call(this.#ports.workspaces, workspaceId, sessionId);
            return { attached: true };
        }
        catch (error) {
            return { attached: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
    /**
     * Create a thread session in the target workspace and rename it to
     * `cowork: <subject>`. The host's rename result wins: it may normalize the
     * title, and callers must show what the sidebar actually shows.
     */
    async createThread(options) {
        const { repoPath, subject, presetId } = options;
        const workspaceId = await this.resolveWorkspaceId(repoPath);
        const created = await this.#ports.sessions.create({ workspaceId, agentPreset: presetId });
        // A missing agentPreset means the session did not mount the requested
        // preset; treating that as success would silently run threads with the
        // wrong tool surface, so fail closed before any state is written.
        if (created.agentPreset !== presetId) {
            throw new Error(`${PRESET_MISMATCH_PREFIX} expected ${JSON.stringify(presetId)}, ` +
                `got ${JSON.stringify(created.agentPreset)} for session ${created.sessionId}`);
        }
        const renamed = await this.#ports.sessions.rename({
            sessionId: created.sessionId,
            title: THREAD_TITLE_PREFIX + subject,
        });
        return { sessionId: created.sessionId, workspaceId, title: renamed.title };
    }
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
    async createCheckoutThread(options) {
        // `repoPath` is accepted for symmetry with createThread, but the workspace
        // is created on the checkout path: the thread works inside its clone.
        const { checkoutPath, threadId, subject, presetId } = options;
        const title = THREAD_TITLE_PREFIX + subject;
        const workspace = await this.#ports.workspaces.create(checkoutPath, title);
        const created = await this.#ports.sessions.create({
            sessionId: threadId,
            workspaceId: workspace.id,
            agentPreset: presetId,
        });
        if (created.sessionId !== threadId) {
            throw new Error(`${SESSION_ID_MISMATCH_PREFIX} requested ${JSON.stringify(threadId)}, ` +
                `got ${JSON.stringify(created.sessionId)}; refusing to rename a session that does not own the checkout`);
        }
        if (created.agentPreset !== presetId) {
            throw new Error(`${PRESET_MISMATCH_PREFIX} expected ${JSON.stringify(presetId)}, ` +
                `got ${JSON.stringify(created.agentPreset)} for session ${created.sessionId}`);
        }
        const renamed = await this.#ports.sessions.rename({
            sessionId: created.sessionId,
            title,
        });
        return { sessionId: created.sessionId, workspaceId: workspace.id, title: renamed.title };
    }
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
    async createReviewSession(options) {
        const { repoPath, subject, presetId } = options;
        const workspaceId = await this.resolveWorkspaceId(repoPath);
        const created = await this.#ports.sessions.create({ workspaceId, agentPreset: presetId });
        if (created.agentPreset !== presetId) {
            throw new Error(`${PRESET_MISMATCH_PREFIX} expected ${JSON.stringify(presetId)}, ` +
                `got ${JSON.stringify(created.agentPreset)} for session ${created.sessionId}`);
        }
        const renamed = await this.#ports.sessions.rename({
            sessionId: created.sessionId,
            title: REVIEW_TITLE_PREFIX + subject,
        });
        return { sessionId: created.sessionId, workspaceId, title: renamed.title };
    }
    /**
     * Remove a workspace from the registry. `false` means it was already gone and
     * is not an error: checkout teardown must stay idempotent.
     */
    async deleteWorkspace(workspaceId) {
        return this.#ports.workspaces.delete(workspaceId);
    }
    /**
     * Archive a session through the workspace registry (the host's owner of that
     * operation); failures propagate so teardown can report them. `options` is
     * forwarded unchanged, so a caller without options keeps the old behaviour.
     */
    async archiveSession(sessionId, options) {
        await this.#ports.workspaces.archiveSession(sessionId, options);
    }
    /**
     * Restore an archived session; a port that does not expose it raises, so the
     * caller can log one honest reason instead of assuming the sidebar is back.
     */
    async unarchiveSession(sessionId) {
        const restore = this.#ports.workspaces.unarchiveSession;
        if (restore === undefined) {
            throw new Error('the host workspace port exposes no unarchiveSession');
        }
        await restore.call(this.#ports.workspaces, sessionId);
    }
    /**
     * Queue a text prompt. `accepted: false` is not an error: it only means the
     * host refused to queue, and the caller decides whether to surface or retry.
     */
    async promptSession(sessionId, text) {
        const requestId = this.#options.requestId?.() ?? crypto.randomUUID();
        const timeoutMs = this.#options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
        const result = await this.#ports.sessions.prompt({
            requestId,
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
        }, AbortSignal.timeout(timeoutMs));
        return { accepted: result.accepted, requestId };
    }
    /**
     * Report whether a session is still visible to the host. Missing sessions are
     * not recreated here: a vanished thread means the index and the host have
     * diverged and the caller must report that instead of silently rebinding.
     */
    async ensureSession(sessionId) {
        const listed = await this.#ports.sessions.list({});
        return listed.items.some((row) => row.sessionId === sessionId);
    }
    /** Rename a session; failures propagate so callers never assume success. */
    async renameSession(sessionId, title) {
        await this.#ports.sessions.rename({ sessionId, title });
    }
}
//# sourceMappingURL=session-slice.js.map