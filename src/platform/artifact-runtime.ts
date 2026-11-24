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
import { ArtifactEventHub, createEventRow } from './artifact-events.js'
import { ArtifactStore } from '../store/artifact-store.js'
import {
  MAX_ARTIFACT_ATTACHMENTS,
  type ArtifactEventV1,
  type ArtifactRecordV1,
  type AttachmentPublishV1,
  type AttachmentRefV1,
  type CommentEventV1,
} from '../panel/artifact-contract.js'
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

/** One attachment about to be published. */
export interface PublishAttachmentInput {
  readonly artifactId: string
  /** Canonical ref; media type, size, and hash come from the stored bytes. */
  readonly attachment: AttachmentRefV1
  /** Who published the bytes; only the model tool may pass `'model'`. */
  readonly source: 'user' | 'model'
  readonly now: Date
}

/** What one publish call produced. */
export interface AttachmentPublishOutcome {
  readonly publish: AttachmentPublishV1
  readonly record: ArtifactRecordV1
  /** Project event to broadcast after the transaction; null on a re-publish. */
  readonly event: ArtifactEventV1 | null
  /** False when the id was already published (the idempotent re-publish). */
  readonly published: boolean
}

/** Project one publish row back onto the wire attachment ref. */
export function attachmentRefOf(publish: AttachmentPublishV1): AttachmentRefV1 {
  return {
    attachmentId: publish.attachmentId,
    name: publish.name,
    mediaType: publish.mediaType,
    size: publish.size,
    sha256: publish.sha256,
  }
}

/**
 * Publish one stored attachment inside the caller's store transaction.
 *
 * This is the single place `attachmentCount` grows. The browser upload route
 * only stores bytes; the browser attach route, the comment/reply routes, and
 * `cowork_artifact_attach` all publish through here, so no path can count the
 * same bytes twice or count an orphan upload. Publishing an id that is already
 * in the log returns its existing row with `published: false` and touches
 * neither the record nor the event log.
 *
 * The caller must hold the store's write lock; record update, log append, and
 * the project event then commit as one publish transaction.
 *
 * @throws ArtifactDomainError `artifact/not-found` when the record vanished, or
 * `artifact/limit-reached` when the work item already holds the cap.
 */
export async function publishAttachmentUnlocked(
  runtime: ArtifactRuntime,
  input: PublishAttachmentInput,
): Promise<AttachmentPublishOutcome> {
  const { artifactId, attachment, source, now } = input
  const existing = (await runtime.store.readAttachmentPublishes(artifactId))
    .find((row) => row.attachmentId === attachment.attachmentId)
  const current = await runtime.store.readRecord(artifactId)
  if (current === null) {
    throw new ArtifactDomainError('artifact/not-found', `unknown artifact: ${artifactId}`, artifactId)
  }
  if (existing !== undefined) {
    return { publish: existing, record: current, event: null, published: false }
  }
  const record = await runtime.store.mutateRecordUnlocked(artifactId, (open) => {
    if (open.attachmentCount >= MAX_ARTIFACT_ATTACHMENTS) {
      throw new ArtifactDomainError(
        'artifact/limit-reached',
        `work item already holds ${String(MAX_ARTIFACT_ATTACHMENTS)} attachments`,
        artifactId,
      )
    }
    return { ...open, attachmentCount: open.attachmentCount + 1, updatedAt: now.toISOString() }
  })
  const publish: AttachmentPublishV1 = {
    version: 1,
    attachmentId: attachment.attachmentId,
    name: attachment.name,
    mediaType: attachment.mediaType,
    size: attachment.size,
    sha256: attachment.sha256,
    source,
    publishedAt: now.toISOString(),
  }
  await runtime.store.appendAttachmentPublishUnlocked(artifactId, publish)
  const event = await runtime.store.appendEventUnlocked(
    createEventRow(artifactId, 'artifact.updated', now, { attachmentId: attachment.attachmentId }),
  )
  return { publish, record, event, published: true }
}

/**
 * Every published attachment of one work item.
 *
 * `attachments.jsonl` is the source once it has rows. A record written before
 * the log existed has none, so its list is derived from the comment refs — a
 * read-only fallback that writes nothing and changes no count.
 */
export async function publishedAttachmentsOf(
  runtime: ArtifactRuntime,
  artifactId: string,
): Promise<readonly AttachmentPublishV1[]> {
  const publishes = await runtime.store.readAttachmentPublishes(artifactId)
  if (publishes.length > 0) return publishes
  return legacyPublishesOf(await runtime.store.readComments(artifactId))
}

/** Derive publish rows from the comment refs of a record without the publish log. */
function legacyPublishesOf(comments: readonly CommentEventV1[]): AttachmentPublishV1[] {
  const rows = new Map<string, AttachmentPublishV1>()
  for (const event of comments) {
    if (event.type !== 'create' && event.type !== 'reply') continue
    for (const ref of event.attachments ?? []) {
      if (rows.has(ref.attachmentId)) continue
      rows.set(ref.attachmentId, {
        version: 1,
        attachmentId: ref.attachmentId,
        name: ref.name,
        mediaType: ref.mediaType,
        size: ref.size,
        sha256: ref.sha256,
        source: event.author === 'model' ? 'model' : 'user',
        publishedAt: event.createdAt,
      })
    }
  }
  const distinct = [...rows.values()]
  return distinct.length > MAX_ARTIFACT_ATTACHMENTS ? distinct.slice(0, MAX_ARTIFACT_ATTACHMENTS) : distinct
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
