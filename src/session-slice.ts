/**
 * Thin adapter over the host session/workspace services.
 *
 * The module depends only on structural ports so it can be unit tested without
 * a running DSH host; the plugin wires the real `sessionController` and
 * `workspaceRegistry` in src/index.ts. It owns no state and caches no id: the
 * workspace registry stays the single source of truth.
 */

/** Every thread session is renamed with this prefix so the sidebar groups them. */
export const THREAD_TITLE_PREFIX = 'cowork: '

const PRESET_MISMATCH_PREFIX = 'session/create-preset-mismatch:'
const DEFAULT_PROMPT_TIMEOUT_MS = 120_000

export interface SessionCreateRequest {
  workspaceId?: string
  cwd?: string
  agentPreset?: string
}

export interface SessionCreateResult {
  sessionId: string
  agentPreset?: string
}

export interface SessionPromptRequest {
  requestId: string
  sessionId: string
  mode: 'queue' | 'steer'
  content: ReadonlyArray<{ type: 'text'; text: string }>
}

export interface SessionRow {
  sessionId: string
  running: boolean
}

export interface SessionHeader {
  id: string
  cwd?: string
  agentPreset?: string
}

export interface SessionSlicePorts {
  sessions: {
    create(request: SessionCreateRequest): Promise<SessionCreateResult>
    rename(request: { sessionId: string; title: string }): Promise<{ title: string; seq: number }>
    prompt(request: SessionPromptRequest, signal?: AbortSignal): Promise<{ accepted: boolean }>
    list(request?: unknown, signal?: AbortSignal): Promise<{ items: readonly SessionRow[] }>
    inspect(sessionId: string, signal?: AbortSignal): Promise<{ meta: SessionHeader }>
  }
  workspaces: {
    resolveByPath(path: string): Promise<{ id: string; path: string } | undefined>
    create(path: string, title?: string): Promise<{ id: string; path: string }>
  }
}

export interface SessionSliceOptions {
  requestId?: () => string
  promptTimeoutMs?: number
}

export class SessionSlice {
  readonly #ports: SessionSlicePorts
  readonly #options: SessionSliceOptions

  constructor(ports: SessionSlicePorts, options: SessionSliceOptions = {}) {
    this.#ports = ports
    this.#options = options
  }

  /**
   * Resolve a workspace id for a repository path, creating the workspace when
   * the registry does not know the path yet. The title is deliberately not
   * passed: the host derives it from the last path segment.
   */
  async resolveWorkspaceId(repoPath: string): Promise<string> {
    const existing = await this.#ports.workspaces.resolveByPath(repoPath)
    if (existing !== undefined) return existing.id
    const created = await this.#ports.workspaces.create(repoPath)
    return created.id
  }

  /**
   * Create a thread session in the target workspace and rename it to
   * `cowork: <subject>`. The host's rename result wins: it may normalize the
   * title, and callers must show what the sidebar actually shows.
   */
  async createThread(options: {
    repoPath: string
    subject: string
    presetId: string
  }): Promise<{ sessionId: string; workspaceId: string; title: string }> {
    const { repoPath, subject, presetId } = options
    const workspaceId = await this.resolveWorkspaceId(repoPath)
    const created = await this.#ports.sessions.create({ workspaceId, agentPreset: presetId })

    // A missing agentPreset means the session did not mount the requested
    // preset; treating that as success would silently run threads with the
    // wrong tool surface, so fail closed before any state is written.
    if (created.agentPreset !== presetId) {
      throw new Error(
        `${PRESET_MISMATCH_PREFIX} expected ${JSON.stringify(presetId)}, ` +
          `got ${JSON.stringify(created.agentPreset)} for session ${created.sessionId}`,
      )
    }

    const renamed = await this.#ports.sessions.rename({
      sessionId: created.sessionId,
      title: THREAD_TITLE_PREFIX + subject,
    })
    return { sessionId: created.sessionId, workspaceId, title: renamed.title }
  }

  /**
   * Queue a text prompt. `accepted: false` is not an error: it only means the
   * host refused to queue, and the caller decides whether to surface or retry.
   */
  async promptSession(sessionId: string, text: string): Promise<{ accepted: boolean; requestId: string }> {
    const requestId = this.#options.requestId?.() ?? crypto.randomUUID()
    const timeoutMs = this.#options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS
    const result = await this.#ports.sessions.prompt(
      {
        requestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
      AbortSignal.timeout(timeoutMs),
    )
    return { accepted: result.accepted, requestId }
  }

  /**
   * Report whether a session is still visible to the host. Missing sessions are
   * not recreated here: a vanished thread means the index and the host have
   * diverged and the caller must report that instead of silently rebinding.
   */
  async ensureSession(sessionId: string): Promise<boolean> {
    const listed = await this.#ports.sessions.list({})
    return listed.items.some((row) => row.sessionId === sessionId)
  }

  /** Rename a session; failures propagate so callers never assume success. */
  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.#ports.sessions.rename({ sessionId, title })
  }
}
