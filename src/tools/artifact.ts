/**
 * Work-item tools. Stage 1 ships `cowork_artifact_create`: register an existing
 * project file as a work item so the user can open, read, and annotate it.
 *
 * The tool never copies or moves the file — the record is a pointer plus the
 * counters the rail shows. Stage 3 adds `cowork_artifact_comments` and
 * `cowork_artifact_reply` to this module.
 */
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  ARTIFACT_RECORD_VERSION,
  MAX_ARTIFACT_PATH_CHARS,
  MAX_ARTIFACT_TITLE_CHARS,
  artifactSummaryOf,
  type ArtifactRecordV1,
  type ArtifactType,
} from '../panel/artifact-contract.js'
import {
  inferArtifactType,
  inferMediaType,
  isEditableArtifactType,
  isTextMediaType,
  normalizeArtifactPath,
} from '../domains/artifact/paths.js'
import { sha256Hex } from '../platform/artifact-files.js'
import type { ArtifactRuntime } from '../platform/artifact-runtime.js'
import type { CoworkToolDeps } from '../platform/tool-runtime.js'
import { callerOf, isFailure, mapError, nowOf, openProject, renderJson, toJson } from '../platform/tool-runtime.js'
import { checkRole, failure, success } from '../platform/tool-model.js'

/** The default title: the file's base name without its extension. */
function titleForPath(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/** The work-item runtime this call uses, or a failure envelope when absent. */
function runtimeOf(deps: CoworkToolDeps, repoPath: string): ArtifactRuntime | null {
  return deps.artifactRuntime === undefined ? null : deps.artifactRuntime.runtimeFor(repoPath)
}

/** Register `cowork_artifact_create`. */
export function registerArtifactTools(ctx: unknown, deps: CoworkToolDeps): Array<() => void> {
  const host = ctx as { tools: { register(definition: ToolDefinition): () => void } }
  const disposers: Array<() => void> = []

  disposers.push(host.tools.register(defineTool({
    name: 'cowork_artifact_create',
    description:
      'Register an existing project file as a work item (交付物) the user can open, read, and annotate. The file stays where it is; the work item is a pointer. Project-relative POSIX path, master or thread.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: `Project-relative POSIX path of an existing file (at most ${MAX_ARTIFACT_PATH_CHARS} characters).`,
      },
      title: { type: 'string', description: 'Work-item title; defaults to the file base name.' },
      type: {
        type: 'string',
        enum: ['text', 'doc', 'table', 'diagram', 'canvas', 'pdf', 'image', 'html', 'other'],
        description: 'Renderer type; inferred from the extension when omitted.',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: async (args, exec) => {
      const caller = callerOf(exec)
      if (isFailure(caller)) return toJson(caller)
      try {
        const opened = await openProject(caller, deps)
        if (isFailure(opened)) return toJson(opened)
        const denied = checkRole('master-or-thread', caller, opened.index)
        if (denied !== null) return toJson(denied)
        const runtime = runtimeOf(deps, opened.repoPath)
        if (runtime === null) {
          return toJson(failure(
            'artifact/fs-unavailable',
            'work items are unavailable in this host: no artifact runtime is registered',
          ))
        }
        const pathCheck = normalizeArtifactPath(args.path)
        if (!pathCheck.ok) {
          return toJson(failure('artifact/path-not-allowed', pathCheck.reason))
        }
        const path = pathCheck.path
        // The tool schema's enum already validated `type`; the cast only
        // restores the literal union the rest of this module reads.
        const type: ArtifactType = args.type === undefined
          ? inferArtifactType(path)
          : (args.type as ArtifactType)
        const title = typeof args.title === 'string' && args.title.trim() !== ''
          ? args.title.trim().slice(0, MAX_ARTIFACT_TITLE_CHARS)
          : titleForPath(path)
        const scan = await runtime.store.listRecords()
        const existing = scan.records.find((record) =>
          record.projectId === opened.index.projectId
          && record.ownerSessionId === caller.sessionId
          && record.primaryPath === path)
        if (existing !== undefined) {
          return toJson(success({ created: false, artifact: artifactSummaryOf(existing) }))
        }
        const observed = await runtime.files.stat(path)
        if (!observed.exists) {
          return toJson(failure('artifact/file-missing', `file does not exist: ${path}`, { path }))
        }
        if (!observed.regular) {
          return toJson(failure('artifact/path-not-allowed', `path is not a regular file: ${path}`, { path }))
        }
        const mediaType = inferMediaType(path)
        const editable = isEditableArtifactType(type) && isTextMediaType(mediaType)
        const now = nowOf(deps)
        const revision = 1
        let sha256 = ''
        let size = observed.size
        if (editable) {
          const read = await runtime.files.readText(path)
          sha256 = sha256Hex(read.content)
          size = read.size
        }
        const record: ArtifactRecordV1 = {
          version: ARTIFACT_RECORD_VERSION,
          artifactId: `artifact-${randomUUID()}`,
          projectId: opened.index.projectId,
          ownerSessionId: caller.sessionId,
          title,
          type,
          status: 'pending-view',
          files: [{
            path,
            mediaType,
            editable,
            size,
            sha256,
            revision,
            fsVersion: observed.version,
            missing: false,
          }],
          primaryPath: path,
          revision,
          commentCount: 0,
          attachmentCount: 0,
          activeDispatch: null,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        }
        const created = await runtime.store.createRecord(record)
        try {
          const event = await runtime.store.appendEvent({
            eventId: `event-${randomUUID()}`,
            type: 'artifact.updated',
            artifactId: created.artifactId,
            time: now.toISOString(),
            data: { revision: created.revision, path },
          })
          runtime.events.publish(event)
        } catch (error) {
          // The record is committed; a lost event is a logged evidence gap, not
          // a failed registration.
          deps.log?.(`artifact create event was not recorded: ${error instanceof Error ? error.message : String(error)}`)
        }
        return toJson(success({ created: true, artifact: artifactSummaryOf(created) }))
      } catch (error) {
        return toJson(mapError(error))
      }
    },
  })))

  return disposers
}
