/**
 * The port and route types shared by `src/api.ts` and `src/inbox-api.ts`.
 *
 * `src/api.ts` registers the inbox routes, and `src/inbox-api.ts` receives the
 * route plumbing as a value through {@link InboxApiKit}. The types those two
 * modules exchange used to live in `src/api.ts`, which made the inbox module
 * import it (a type-only cycle that the compiler still follows). They live here
 * so both sides depend on one leaf module and neither imports the other's
 * implementation.
 */
import type { TopicNoticePort, NoticeLedgerV1 } from './notices.js'
import type {
  ActivityEvent,
  InboxItem,
  ProjectIndexV2,
  ReadActivityResult,
} from './store/schema.js'

/** One metadata row of the host's session listing; only id and cwd matter here. */
export interface PanelSessionRow {
  readonly sessionId: string
  /** The session's working directory; the only accepted start for project discovery. */
  readonly cwd?: string
}

/**
 * Store operations the routes may perform. `ProjectStore` satisfies this
 * structurally. The writer half (`mutateIndexDocument`/`appendActivity`) is used
 * only by the POST routes; the reads never call a write.
 *
 * `mutateIndexDocumentUnlocked` is the no-lock half of
 * {@link mutateIndexDocument}: it may only run inside
 * {@link withWriteLock}, and it exists so one transaction can write the index
 * and a request card under the same project lock. Both stores use the same
 * `<repo>/.dsh-cowork/.write.lock`, so nesting an unlocked write inside the
 * lock is safe and nesting a locked write inside it would deadlock.
 */
export interface CoworkStorePort {
  hasIndex(): Promise<boolean>
  readIndexDocument(): Promise<ProjectIndexV2>
  mutateIndexDocument(mutator: (document: ProjectIndexV2) => ProjectIndexV2 | null): Promise<ProjectIndexV2>
  /** Index write that assumes the caller holds {@link withWriteLock}. */
  mutateIndexDocumentUnlocked(
    mutator: (document: ProjectIndexV2) => ProjectIndexV2 | null,
  ): Promise<ProjectIndexV2>
  /** Run `operation` while holding the one project writer lock. */
  withWriteLock<T>(operation: () => Promise<T>): Promise<T>
  appendActivity(event: ActivityEvent): Promise<void>
  readActivity(limit?: number): Promise<ReadActivityResult>
  readInbox(): Promise<InboxItem[]>
  /** Raw text read of one project-owned file; `null` when the file is gone. */
  readText(absPath: string): Promise<string | null>
  /** The notice ledger; the inbox note stream reads it without writing it. */
  readNotices?(): Promise<NoticeLedgerV1>
  /** `<repo>/.dsh-cowork/reviews`, the only home of review-request facts. */
  readonly reviewsDir: string
}

/** The host facts a route needs, injected so tests can stand in for the host. */
export interface CoworkApiPorts {
  /**
   * Session metadata, deliberately `list` and not `inspect`: on a live host
   * `inspect` waits for the session's event log (the panel request hung on
   * running or large sessions), while the listing is a cheap summary read that
   * already carries `cwd`.
   */
  listSessions(): Promise<{ readonly items: readonly PanelSessionRow[] }>
  /**
   * Bound on `listSessions`, in milliseconds. Production leaves this unset and
   * gets the route module's documented default; tests inject a few milliseconds
   * so the timeout path is deterministic without waiting 30 s. Not part of the
   * wire contract: it only bounds the host call.
   */
  listSessionsTimeoutMs?: number
  findProjectRoot(startPath: string): Promise<string | null>
  createStore(repoPath: string): CoworkStorePort
  /**
   * Clock for the write routes and the lifecycle read point. Production passes
   * the same `() => new Date()` that the store stamps with; tests freeze it.
   */
  now?(): Date
  /** Idle threshold for the lifecycle read point; `src/topic.ts` owns the default. */
  idleAfterMs?: number
  /** Diagnostic sink for a non-fatal failure (lifecycle/activity write). */
  log?(message: string): void
  /** Archive the host session of an archived topic; a failure is logged only. */
  archiveSession?(sessionId: string, options?: { stopActivity?: boolean }): Promise<void>
  /** Restore the host session of a reopened topic; a failure is logged only. */
  unarchiveSession?(sessionId: string): Promise<void>
  /** Prompt the topic session after an authorization decision. */
  promptSession?(sessionId: string, text: string): Promise<{ accepted: boolean }>
  /** Host notice port, used to update the original authorization notice. */
  noticePort?: TopicNoticePort
  /**
   * Host file-browser port for `POST /api/cowork.inbox.open`. Optional: a host
   * without the desktop capability answers `inbox/open-unsupported` instead of
   * faking a success.
   */
  openWorkspacePath?(path: string): Promise<void>
  /** Schedule the notice dispatcher for one project after a committed write. */
  kickNotices?(repoPath: string): void
}

/** Methods the connection channel supports for a registered route. */
export type PanelFetchMethod = 'GET' | 'HEAD' | 'POST'
/** Whether the channel buffers or streams the request body before the handler. */
export type PanelRequestBodyMode = 'buffered' | 'streaming'

/** One Exact Fetch route as the host `connection` service declares it. */
export interface PanelFetchRoute {
  readonly path: string
  readonly methods: readonly PanelFetchMethod[]
  readonly requestBody: PanelRequestBodyMode
  readonly fetch: (request: Request) => Promise<Response>
}

/** The slice of the host `connection` service this module registers on. */
export interface CoworkConnection {
  readonly fetch: {
    register(route: PanelFetchRoute): () => Promise<void>
  }
}

/**
 * The Cordis context surface used here. `get` mirrors `ctx.get(name)`: it
 * returns `undefined` when the service is absent instead of throwing, which is
 * what keeps the plugin loadable in a host without `connection`.
 */
export interface CoworkApiHost {
  get(name: string): unknown
  effect(execute: () => unknown, label?: string): void
}
