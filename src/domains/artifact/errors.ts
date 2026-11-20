/**
 * The one error type the artifact layers raise.
 *
 * The store, the filesystem adapter and the route handlers all fail with one of
 * the frozen `artifact/*` codes; the route maps this type onto the panel error
 * envelope, so a new failure site cannot invent a status the browser does not
 * know. Each layer still owns the failure: nothing here swallows a cause.
 */
import type { ArtifactErrorCode } from '../../panel/artifact-contract.js'

/** A work-item failure carrying one stable wire code. */
export class ArtifactDomainError extends Error {
  readonly code: ArtifactErrorCode
  readonly path?: string

  constructor(code: ArtifactErrorCode, message: string, path?: string) {
    super(message)
    this.name = 'ArtifactDomainError'
    this.code = code
    if (path !== undefined) this.path = path
  }
}
