/**
 * Per-project work-item runtime: store + file port + event hub.
 *
 * One runtime exists per repository, created on first use and cached until the
 * plugin unloads. The panel routes, the `cowork_artifact_*` tools, and the
 * dispatcher share it, so they observe one event hub and one writer lock
 * instead of each opening its own.
 *
 * A host without `ctx.fs` still gets a runtime: file reads and saves answer
 * `artifact/fs-unavailable`, while records, comments, and the event stream keep
 * working. That is the documented degradation, not a silent fallback to raw
 * filesystem access.
 */
import { ArtifactEventHub } from './artifact-events.js'
import { ArtifactStore } from '../store/artifact-store.js'
import {
  createHostArtifactFiles,
  type ArtifactFilePort,
  type ArtifactTextRead,
  type ArtifactWriteResult,
  type HostFileSystem,
} from './artifact-files.js'
import { ArtifactDomainError } from '../domains/artifact/errors.js'
import { ArtifactPresenceRegistry } from './artifact-presence.js'
import { ArtifactDispatcher } from './artifact-dispatch.js'
import type { DispatchPromptPort } from './artifact-dispatch.js'

/** One project's work-item collaborators. */
export interface ArtifactRuntime {
  readonly repoPath: string
  readonly store: ArtifactStore
  readonly files: ArtifactFilePort
  readonly events: ArtifactEventHub
  /** Whether the host exposes `ctx.fs`; false makes file routes answer 501. */
  readonly fsAvailable: boolean
  /** Editing presence shared with the tool guard. */
  readonly presence: ArtifactPresenceRegistry
  /** Annotation delivery; null on a host/embed without a prompt port. */
  readonly dispatch: ArtifactDispatcher | null
  dispose(): void
}

/** The file port of a host without `ctx.fs`: every operation fails the same way. */
export function unavailableArtifactFiles(): ArtifactFilePort {
  const fail = (path: string): never => {
    throw new ArtifactDomainError(
      'artifact/fs-unavailable',
      'the host exposes no fs service, so work-item files cannot be read or saved',
      path,
    )
  }
  return {
    async stat(path): Promise<never> {
      return fail(path)
    },
    async readText(path): Promise<ArtifactTextRead> {
      return fail(path)
    },
    async writeText(path): Promise<ArtifactWriteResult> {
      return fail(path)
    },
  }
}

/** What the manager needs from the composition root. */
export interface ArtifactRuntimeOptions {
  readonly hostFs?: HostFileSystem
  readonly log?: (message: string) => void
  /** One presence registry shared by every project and the tool guard. */
  readonly presence?: ArtifactPresenceRegistry
  /** How to queue an annotation prompt; absent means delivery is unavailable. */
  readonly prompt?: DispatchPromptPort
  /** Dispatcher timing/batching overrides (tests use zero delays). */
  readonly dispatch?: {
    readonly windowMs?: number
    readonly maxComments?: number
    readonly retryDelaysMs?: readonly number[]
    readonly timeoutMs?: number
    readonly concurrency?: number
    /** Whether to reconcile persisted dispatch logs when the runtime is born. */
    readonly recoverOnCreate?: boolean
  }
}

/** Create and cache one runtime per repository. */
export class ArtifactRuntimeManager {
  private readonly options: ArtifactRuntimeOptions
  private readonly runtimes = new Map<string, ArtifactRuntime>()

  constructor(options: ArtifactRuntimeOptions = {}) {
    this.options = options
    this.presence = options.presence ?? new ArtifactPresenceRegistry()
  }

  /** The one presence registry every runtime reports into. */
  readonly presence: ArtifactPresenceRegistry

  /** The runtime of one project, created on first use. */
  runtimeFor(repoPath: string): ArtifactRuntime {
    const existing = this.runtimes.get(repoPath)
    if (existing !== undefined) return existing
    const events = new ArtifactEventHub()
    const hostFs = this.options.hostFs
    const store = new ArtifactStore(repoPath)
    const runtime = {
      repoPath,
      store,
      files: hostFs === undefined ? unavailableArtifactFiles() : createHostArtifactFiles(hostFs, repoPath),
      events,
      fsAvailable: hostFs !== undefined,
      presence: this.presence,
      dispatch: null as ArtifactDispatcher | null,
      dispose: () => {
        events.dispose()
        runtime.dispatch?.dispose()
      },
    }
    if (this.options.prompt !== undefined) {
      runtime.dispatch = new ArtifactDispatcher({
        runtime,
        prompt: this.options.prompt,
        attachments: {
          read: (artifactId, attachmentId) => store.readUpload(artifactId, attachmentId),
        },
        log: this.options.log,
        ...(this.options.dispatch ?? {}),
      })
      if (this.options.dispatch?.recoverOnCreate !== false) {
        void runtime.dispatch.recover().catch((error: unknown) => {
          this.options.log?.(`artifact dispatch recovery failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
    }
    this.runtimes.set(repoPath, runtime)
    return runtime
  }

  /** Drop every cached runtime and its hub subscriptions. */
  dispose(): void {
    for (const runtime of this.runtimes.values()) runtime.dispose()
    this.runtimes.clear()
    this.presence.dispose()
  }
}
