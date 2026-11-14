/**
 * Project-memory tools (`cowork_memory_write`, `cowork_memory_search`).
 *
 * Behaviour is unchanged from the M2 implementation that lived in
 * `src/tools.ts`; only the shared helpers moved to `src/platform/tool-runtime.ts`. The
 * file layer is the memory module's injected IO port, backed by the project
 * store's lock and atomic write.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describeError } from './checkout-teardown.js'
import {
  MemoryCorruptError,
  appendMemoryEntry,
  loadMemory,
  searchMemory,
  validateMemoryEntry,
} from './memory.js'
import { tokenize } from './routing.js'
import type { CoworkToolDeps } from './platform/tool-runtime.js'
import {
  callerOf,
  isFailure,
  mapError,
  memoryIo,
  nowOf,
  openProject,
  renderJson,
  toJson,
} from './platform/tool-runtime.js'
import { ERROR_CODES, checkRole, failure, success } from './platform/tool-model.js'

/** The two memory tools, registered in the documented order. */
export function registerMemoryTools(ctx: unknown, deps: CoworkToolDeps): Array<() => void> {
  const host = ctx as { tools: { register(definition: ToolDefinition): () => void } }
  const disposers: Array<() => void> = []

  // 1) cowork_memory_write — append one durable project-memory entry.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_memory_write',
    description:
      'Append one durable project-memory entry (constraint, decision, or fact) to .dsh-cowork/memory/. Master or thread.',
    parameters: {
      kind: {
        type: 'string',
        required: true,
        enum: ['constraint', 'decision', 'fact'],
        description: 'Which memory file to append to: constraints.md, decisions.md, or facts.md.',
      },
      title: { type: 'string', required: true, description: 'One-line title; duplicate titles are allowed.' },
      text: { type: 'string', required: true, description: 'The entry body, at most 8000 characters.' },
      source: { type: 'string', required: true, description: 'Where this came from, e.g. the topic id.' },
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

        const validated = validateMemoryEntry(args.kind, {
          title: args.title,
          text: args.text,
          source: args.source,
        })
        if (!validated.ok) {
          return toJson(failure(ERROR_CODES.memoryInvalid, 'memory entry is invalid', {
            issues: validated.issues,
          }))
        }

        try {
          const appended = await appendMemoryEntry(
            memoryIo(opened.store),
            opened.repoPath,
            validated.kind,
            validated.value,
            () => nowOf(deps),
          )
          return toJson(success({
            file: appended.file,
            filePath: appended.filePath,
            entry: appended.entry,
          }))
        } catch (error) {
          if (error instanceof MemoryCorruptError) {
            return toJson(failure(ERROR_CODES.memoryInvalid, error.message, {
              file: error.file,
              issues: error.issues,
            }))
          }
          return toJson(failure(ERROR_CODES.memoryWriteFailed, describeError(error)))
        }
      } catch (error) {
        return toJson(mapError(error))
      }
    },
  })))

  // 2) cowork_memory_search — keyword search across the three memory files.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_memory_search',
    description:
      'Search the project memory (constraints, decisions, facts) by keyword; results are ranked by title, body, and source overlap. Master or thread.',
    parameters: {
      query: { type: 'string', required: true, description: 'Keywords to look for.' },
      limit: { type: 'integer', description: 'Maximum hits, 1..20 (default 5).' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: async (args, exec) => {
      const caller = callerOf(exec)
      if (isFailure(caller)) return toJson(caller)
      const query = args.query.trim()
      if (query === '') return toJson(failure(ERROR_CODES.memoryInvalid, 'query must not be empty'))
      try {
        const opened = await openProject(caller, deps)
        if (isFailure(opened)) return toJson(opened)
        const denied = checkRole('master-or-thread', caller, opened.index)
        if (denied !== null) return toJson(denied)

        const loaded = await loadMemory(
          { readText: (path) => opened.store.readText(path) },
          opened.repoPath,
        )
        const entries = loaded.files.flatMap((file) => file.entries.map((entry) => ({
          kind: file.kind,
          file: file.file,
          entry,
        })))
        const hits = searchMemory(entries, query, { tokenize, limit: args.limit })
        return toJson(success({ hits, issues: loaded.issues, total: hits.length }))
      } catch (error) {
        return toJson(mapError(error))
      }
    },
  })))

  return disposers
}
