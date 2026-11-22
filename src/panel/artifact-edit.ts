/**
 * Write path behind `POST /api/cowork.artifact.edit`.
 *
 * The route validates the request and opens the project; this module owns the
 * stale-base decision, the three-way text merge, the bounded version-race
 * retries, and the 409 response it returns. Keeping it out of the route module
 * lets the edit path stay readable and gives the unit lane one owner for every
 * failure shape.
 */
import type { ArtifactConflictBody, ArtifactConflictRange, ArtifactRecordV1 } from './artifact-contract.js'
import type { ArtifactRuntime } from '../platform/artifact-runtime.js'
import type { ArtifactTextRead } from '../platform/artifact-files.js'
import { ArtifactDomainError } from '../domains/artifact/errors.js'
import { mergeText } from '../domains/artifact/merge.js'

/** Minimal route plumbing needed to build a conflict response. */
export interface EditRouteKit {
  jsonResponse(status: number, body: unknown): Response
}

/** The 1-based line range the conflict UI should highlight for a whole file. */
function wholeFileRange(content: string): ArtifactConflictRange[] {
  const lines = content.split('\n')
  const count = lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
  return [{ startLine: 1, endLine: Math.max(1, count) }]
}

/** One 409 response for a save that could not be merged. */
function conflictResponse(
  kit: EditRouteKit,
  currentVersion: string | null,
  revision: number,
  conflictRanges: readonly ArtifactConflictRange[],
): Response {
  const body: ArtifactConflictBody = {
    ok: false,
    error: {
      code: 'artifact/version-conflict',
      message: 'the file changed since this revision; resolve the conflict and retry the save',
    },
    currentVersion: currentVersion ?? '',
    revision,
    conflictRanges,
  }
  return kit.jsonResponse(409, body)
}

/**
 * Resolve one stale edit base.
 *
 * A text file is three-way merged against the snapshot the browser held; an
 * overlap or a missing snapshot becomes a 409. A canvas scene is opaque JSON:
 * it has no line identity, so a stale base is always a conflict.
 */
interface StaleBaseInput {
  readonly canvas: boolean
  readonly artifactId: string
  readonly baseRevision: number
  readonly current: { readonly content: string; readonly version: string | null }
  readonly content: string
  readonly fileRevision: number
  readonly runtime: ArtifactRuntime
  readonly kit: EditRouteKit
}

/** One resolved stale save: merged text, or the 409 response. */
type StaleBaseResult =
  | { readonly kind: 'content'; readonly content: string }
  | { readonly kind: 'conflict'; readonly response: Response }

async function resolveStaleBase(input: StaleBaseInput): Promise<StaleBaseResult> {
  const conflict = (): StaleBaseResult => ({
    kind: 'conflict',
    response: conflictResponse(input.kit, input.current.version, input.fileRevision, wholeFileRange(input.current.content)),
  })
  if (input.canvas) return conflict()
  const base = await input.runtime.store.readRevision(input.artifactId, input.baseRevision)
  if (base === null) return conflict()
  const result = mergeText({ base, current: input.current.content, mine: input.content })
  if (!result.ok) {
    return {
      kind: 'conflict',
      response: conflictResponse(input.kit, input.current.version, input.fileRevision, result.conflictRanges),
    }
  }
  return { kind: 'content', content: result.content }
}

/** The state one edit route hands to the merge/write path. */
export interface EditWriteInput {
  readonly runtime: ArtifactRuntime
  readonly kit: EditRouteKit
  readonly artifactId: string
  readonly path: string
  readonly recordType: ArtifactRecordV1['type']
  readonly content: string
  readonly baseRevision: number
  readonly baseVersion: string | null
  readonly current: ArtifactTextRead
  readonly fileRevision: number
}

/** A successful file write, or the 409 the route must return. */
export type EditWriteOutcome =
  | { readonly kind: 'written'; readonly content: string; readonly merged: boolean; readonly fsVersion: string | null }
  | { readonly kind: 'conflict'; readonly response: Response }

/** The merge decision before the first write attempt. */
type MergedEdit =
  | { readonly kind: 'content'; readonly content: string; readonly merged: boolean }
  | { readonly kind: 'conflict'; readonly response: Response }

/** Resolve one stale base against the current file snapshot. */
async function resolveStaleEdit(input: EditWriteInput, current: ArtifactTextRead): Promise<StaleBaseResult> {
  return resolveStaleBase({
    canvas: input.recordType === 'canvas',
    artifactId: input.artifactId,
    baseRevision: input.baseRevision,
    current,
    content: input.content,
    fileRevision: input.fileRevision,
    runtime: input.runtime,
    kit: input.kit,
  })
}

/** Whether the browser base no longer matches the current file version. */
function baseIsStale(baseVersion: string | null, currentVersion: string | null): boolean {
  return baseVersion === null || currentVersion === null || baseVersion !== currentVersion
}

/** Merge a stale base before the first write. */
async function mergeStaleEdit(input: EditWriteInput): Promise<MergedEdit> {
  if (!baseIsStale(input.baseVersion, input.current.version)) {
    return { kind: 'content', content: input.content, merged: false }
  }
  const resolved = await resolveStaleEdit(input, input.current)
  if (resolved.kind === 'conflict') return { kind: 'conflict', response: resolved.response }
  return { kind: 'content', content: resolved.content, merged: true }
}

/** Whether one thrown write error is the optimistic-concurrency conflict. */
function isVersionConflict(error: unknown): boolean {
  return error instanceof ArtifactDomainError && error.code === 'artifact/version-conflict'
}

/** Whether a failed write has exhausted its retries or is not retryable. */
function shouldGiveUpWrite(conflict: boolean, retries: number): boolean {
  return !conflict || retries >= 2
}

/** Turn a permanent write failure into the route's conflict response. */
function writeFailureOutcome(
  error: unknown,
  conflict: boolean,
  input: EditWriteInput,
  current: ArtifactTextRead,
): EditWriteOutcome {
  if (!conflict) throw error
  return {
    kind: 'conflict',
    response: conflictResponse(input.kit, current.version, input.fileRevision, wholeFileRange(current.content)),
  }
}

/** Write the merged content and retry a version race at most twice. */
async function writeWithRetry(input: EditWriteInput, content: string, merged: boolean): Promise<EditWriteOutcome> {
  let current = input.current
  let nextContent = content
  let retryMerged = merged
  let retries = 0
  while (true) {
    try {
      const written = await input.runtime.files.writeText(input.path, nextContent, current.version)
      return { kind: 'written', content: nextContent, merged: retryMerged, fsVersion: written.version }
    } catch (error) {
      const conflict = isVersionConflict(error)
      if (shouldGiveUpWrite(conflict, retries)) return writeFailureOutcome(error, conflict, input, current)
      retries += 1
      current = await input.runtime.files.readText(input.path)
      const resolved = await resolveStaleEdit(input, current)
      if (resolved.kind === 'conflict') return { kind: 'conflict', response: resolved.response }
      nextContent = resolved.content
      retryMerged = true
    }
  }
}

/**
 * Write one edit, merging or retrying when the browser base is stale.
 * @param input - validated request data and the current file snapshot.
 * @returns the written content/version, or the conflict response.
 */
export async function writeArtifactEdit(input: EditWriteInput): Promise<EditWriteOutcome> {
  const resolved = await mergeStaleEdit(input)
  if (resolved.kind === 'conflict') return { kind: 'conflict', response: resolved.response }
  return writeWithRetry(input, resolved.content, resolved.merged)
}
