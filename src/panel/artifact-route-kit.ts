/**
 * The plumbing types the work-item (artifact) routes are built from.
 *
 * The composition root supplies one implementation of session→project
 * resolution, JSON bodies, the same-origin fence, and the shared error
 * envelope; the artifact routes never re-implement those. Keeping the shapes
 * here lets the route modules (`artifact-api`, `artifact-records`,
 * `artifact-rebind`) share them without importing each other's handlers.
 *
 * This module is type-only: it emits no JavaScript and imports only types.
 */
import type { PanelErrorCode } from './api-contract.js'
import type { ArtifactRuntime } from '../platform/artifact-runtime.js'

/** One resolved project and its work-item runtime. */
export interface ArtifactOpenedProject {
  readonly repoPath: string
  readonly projectId: string
}

/** The panel plumbing one artifact route handler is served with. */
export interface ArtifactRouteKit {
  openProject(sessionId: string): Promise<ArtifactOpenedProject>
  readJsonBody(request: Request, maxBytes?: number): Promise<Record<string, unknown>>
  jsonResponse(status: number, payload: unknown): Response
  serve(handler: (request: Request) => Promise<Response>): (request: Request) => Promise<Response>
  fail(code: PanelErrorCode, message: string, path?: string): Error
}

/** What the artifact route module needs from the composition root. */
export interface ArtifactApiPorts {
  runtimeFor(repoPath: string): ArtifactRuntime
  now?(): Date
  log?(message: string): void
  /** Title of one session for the viewer breadcrumb; null when unavailable. */
  sessionTitle?(sessionId: string): Promise<string | null>
  /**
   * Titles of every listed session, keyed by session id, for one list request.
   *
   * The list route calls this once per request to project `sessionTitle` onto
   * every item; it must never be called per record. A host without it (or a
   * failing listing) leaves titles absent and lets the search fall back to
   * title/type only.
   */
  sessionTitles?(): Promise<ReadonlyMap<string, string>>
  /** Host file-browser port used by the "open in app" action. */
  openWorkspacePath?(path: string): Promise<void>
}
