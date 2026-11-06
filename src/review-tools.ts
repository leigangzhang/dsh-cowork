/**
 * The two `cowork_review_*` tools and the orchestration only they use.
 *
 * Split out of src/tools.ts so every source file stays under the DSH 50 KiB
 * single-file read limit (guarded by tests/source-budget.test.mjs). The shared
 * helpers (`callerOf`, `openProject`, `mapError`, `toJson`, `renderJson`,
 * `nowOf`, `threadView`, `isFailure`) arrive through {@link ReviewToolsDeps},
 * so this module imports no runtime value from src/tools.ts and the dependency
 * stays one-way.
 *
 * Tool names, descriptions, parameter schemas, error codes, role gates, write
 * order, and registration order are unchanged from the original module; this
 * file is a structural move only.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describeError } from './checkout-teardown.js'
import { REVIEWER_PRESET_ID } from './presets.js'
import {
  buildReviewBrief,
  buildReviewRecord,
  checkReviewRequest,
  formatRevisionMessage,
  prepareVerdict,
  verdictTransition,
} from './review.js'
import type { SessionSlice } from './session-slice.js'
import type { ProjectIndex, ProjectStore, ReviewFile, ThreadRecord } from './store.js'
import {
  ERROR_CODES,
  REVIEW_FINDING_PARAMETER,
  REVIEW_VERIFICATION_PARAMETER,
  checkRole,
  failure,
  success,
} from './tool-model.js'
import type { CallerIdentity, ToolFailure } from './tool-model.js'

/** Lossless JSON value accepted by the tool result boundary. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** One resolved project plus the collaborators for one tool call. */
export interface ProjectRuntime {
  repoPath: string
  store: ProjectStore
  slice: SessionSlice
  index: ProjectIndex
}

/** The tool-registry slice of the plugin context; the rest of `ctx` stays opaque. */
export interface ReviewToolsHost {
  tools: { register(definition: ToolDefinition): () => void }
}

/**
 * The src/tools.ts helpers these tools reuse. They are injected instead of
 * imported so the split does not create a `src/tools.ts` ↔ `src/review-tools.ts`
 * runtime cycle; `openProject` and `nowOf` are pre-bound to the assembly's deps.
 */
export interface ReviewToolsDeps {
  callerOf(exec: unknown): CallerIdentity | ToolFailure
  openProject(caller: CallerIdentity): Promise<ProjectRuntime | ToolFailure>
  mapError(error: unknown): ToolFailure
  toJson(value: unknown): JsonValue
  renderJson(args: unknown, value: JsonValue): Array<{ type: 'text'; text: string }>
  nowOf(): Date
  threadView(thread: ThreadRecord): unknown
  isFailure(value: unknown): value is ToolFailure
}

async function archiveReviewer(runtime: ProjectRuntime, sessionId: string): Promise<string[]> {
  try { await runtime.slice.archiveSession(sessionId); return [] }
  catch (error) { return [`session: ${describeError(error)}`] }
}

/** Undo a review request that could not be briefed, so the thread is not stuck pending. */
async function rollbackReviewRequest(runtime: ProjectRuntime, threadId: string, reviewerSessionId: string, reason: string): Promise<ToolFailure> {
  const cleanupErrors: string[] = []
  try { await runtime.store.updateThread(threadId, { reviewStatus: null, reviewRequestedAt: null, reviewerSessionId: null }) }
  catch (error) { cleanupErrors.push(`index: ${describeError(error)}`) }
  cleanupErrors.push(...await archiveReviewer(runtime, reviewerSessionId))
  return failure(ERROR_CODES.reviewPromptFailed, reason, { threadId, reviewerSessionId, cleanupErrors })
}

/**
 * Register the two review tools (positions 10 and 11) and return their
 * disposers. The caller owns the effect scope; this function only registers.
 */
export function registerReviewTools(ctx: unknown, deps: ReviewToolsDeps): Array<() => void> {
  const host = ctx as ReviewToolsHost
  const disposers: Array<() => void> = []
  const { callerOf, openProject, mapError, toJson, renderJson, nowOf, threadView, isFailure } = deps

  // 10) cowork_review_request — open the independent reviewer for a handed-off thread.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_review_request',
    description:
      'Request an independent review for a thread that handed off as awaiting_review: create a read-only reviewer session, mark the thread pending, and brief it. Master or thread.',
    parameters: {
      threadId: { type: 'string', required: true, description: 'Thread whose handoff should be reviewed.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: async (args, exec) => {
      const caller = callerOf(exec)
      if (isFailure(caller)) return toJson(caller)
      try {
        const opened = await openProject(caller)
        if (isFailure(opened)) return toJson(opened)
        const denied = checkRole('master-or-thread', caller, opened.index)
        if (denied !== null) return toJson(denied)
        const threadId = args.threadId.trim()
        const thread = opened.index.threads.find((entry) => entry.threadId === threadId)
        if (thread === undefined) {
          return toJson(failure(ERROR_CODES.threadNotFound, `thread not found in the project index: ${threadId}`, { threadId }))
        }
        const notReady = checkReviewRequest({
          threadId,
          status: thread.status,
          reviewStatus: thread.reviewStatus,
          reviewerSessionId: thread.reviewerSessionId,
        })
        if (notReady !== null) return toJson(notReady)

        // The newest handoff is the reviewer's evidence.
        const handoffs = (await opened.store.listHandoffs()).filter((file) => file.record.threadId === threadId)
        const handoff = handoffs.length === 0 ? null : handoffs[handoffs.length - 1]
        let created: { sessionId: string; workspaceId: string; title: string }
        try {
          created = await opened.slice.createReviewSession({ repoPath: opened.repoPath, subject: thread.subject, presetId: REVIEWER_PRESET_ID })
        } catch (error) {
          return toJson(failure(ERROR_CODES.reviewSessionFailed, describeError(error), { threadId }))
        }
        try {
          await opened.store.updateThread(threadId, {
            reviewStatus: 'pending',
            reviewRequestedAt: nowOf().toISOString(),
            reviewedAt: null,
            reviewerSessionId: created.sessionId,
            latestReviewPath: null,
          })
        } catch (error) {
          // No pending record: the reviewer cannot be attributed, so archive it.
          const cleanupErrors = await archiveReviewer(opened, created.sessionId)
          const mapped = mapError(error)
          return toJson(failure(mapped.error.code, mapped.error.message, { threadId, reviewerSessionId: created.sessionId, cleanupErrors }))
        }
        const brief = buildReviewBrief({
          repoPath: opened.repoPath,
          subject: thread.subject,
          threadId,
          handoffFilePath: handoff === null ? null : handoff.filePath,
          changedPaths: handoff?.record.changedPaths ?? [],
          verification: handoff?.record.verification ?? [],
          checkoutPath: thread.checkoutPath,
        })
        let accepted = false
        let promptError: string | null = null
        try { accepted = (await opened.slice.promptSession(created.sessionId, brief)).accepted }
        catch (error) { promptError = describeError(error) }
        if (!accepted) {
          const reason = promptError === null ? 'the reviewer session did not accept the brief' : promptError
          return toJson(await rollbackReviewRequest(
            opened,
            threadId,
            created.sessionId,
            `the reviewer session was created but not briefed (${reason}); the pending review was rolled back`,
          ))
        }
        return toJson(success({ threadId, reviewerSessionId: created.sessionId, title: created.title, prompted: true, status: 'pending' }))
      } catch (error) {
        return toJson(mapError(error))
      }
    },
  })))

  // 11) cowork_review_verdict — the reviewer's single decision, written before the index moves.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_review_verdict',
    description:
      'Record the independent review verdict for one thread. Only the reviewer session named on the thread may call this; needs_revision and reject need at least one finding.',
    parameters: {
      threadId: { type: 'string', required: true, description: 'Thread under review.' },
      verdict: { type: 'string', required: true, enum: ['pass', 'needs_revision', 'reject'], description: 'pass accepts; needs_revision reopens the thread with findings; reject blocks it.' },
      summary: { type: 'string', required: true, description: 'One-paragraph review summary.' },
      findings: {
        type: 'array',
        description: 'Required for needs_revision and reject; a pass may carry none.',
        items: REVIEW_FINDING_PARAMETER,
      },
      verification: {
        type: 'array',
        description: 'One row per check the reviewer actually ran.',
        items: REVIEW_VERIFICATION_PARAMETER,
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: async (args, exec) => {
      const caller = callerOf(exec)
      if (isFailure(caller)) return toJson(caller)
      try {
        const opened = await openProject(caller)
        if (isFailure(opened)) return toJson(opened)
        const threadId = args.threadId.trim()
        const thread = opened.index.threads.find((entry) => entry.threadId === threadId)
        if (thread === undefined) {
          return toJson(failure(ERROR_CODES.threadNotFound, `thread not found in the project index: ${threadId}`, { threadId }))
        }
        // A verdict never overwrites a merged, blocked, or reopened thread.
        const prepared = prepareVerdict({
          thread,
          caller,
          masterSessionId: opened.index.masterSessionId,
          review: { verdict: args.verdict, summary: args.summary, findings: args.findings, verification: args.verification },
        })
        if (!prepared.ok) return toJson(prepared.failure)
        const record = buildReviewRecord(prepared.draft, nowOf())
        let file: ReviewFile
        try { file = await opened.store.writeReview(record) } // file first: the index will point at it
        catch (error) { return toJson(failure(ERROR_CODES.reviewWriteFailed, describeError(error), { threadId })) }
        const transition = verdictTransition(record.verdict)
        const updated = await opened.store.updateThread(threadId, {
          status: transition.status,
          reviewStatus: record.verdict,
          reviewedAt: record.createdAt,
          latestReviewPath: file.filePath,
        })
        const latest = updated.threads.find((entry) => entry.threadId === threadId) ?? null
        let delivered = false
        let deliveryError: string | null = null
        if (transition.deliverToThread) {
          try {
            const prompted = await opened.slice.promptSession(threadId, formatRevisionMessage(record, threadId))
            delivered = prompted.accepted
            if (!prompted.accepted) deliveryError = 'the host did not accept the revision message'
          } catch (error) {
            // The index already moved: a delivery failure is reported, never a failed verdict.
            deliveryError = describeError(error)
          }
        }
        return toJson(success({ verdict: record.verdict, status: transition.status, thread: latest === null ? null : threadView(latest), reviewFilePath: file.filePath, reviewedAt: record.createdAt, delivered, deliveryError }))
      } catch (error) {
        return toJson(mapError(error))
      }
    },
  })))

  return disposers
}
