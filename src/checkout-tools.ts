/**
 * `cowork_checkout_merge` — integrate one isolated thread branch, then tear the
 * clone down.
 *
 * Behaviour is unchanged from the M4 implementation that lived in
 * `src/tools.ts`; the shared helpers and the git runner moved to
 * `src/tool-runtime.ts`. The review gate still runs before the irreversible
 * merge step, and every teardown failure is reported in `cleanupErrors` instead
 * of turning a merged branch into a failed result.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { CHECKOUT_ERROR, mergeCheckout, removeCheckout } from './checkout.js'
import { applyThreadStatus, teardownMergedCheckout } from './checkout-teardown.js'
import { checkLegacyThreadMerge } from './review-request.js'
import type { ThreadRecord } from './store.js'
import type { CoworkToolDeps } from './tool-runtime.js'
import {
  callerOf,
  checkoutDeps,
  isFailure,
  mapError,
  openProject,
  renderJson,
  threadView,
  toJson,
} from './tool-runtime.js'
import { ERROR_CODES, checkRole, failure, success } from './tool-model.js'

/** The checkout tool. */
export function registerCheckoutTools(ctx: unknown, deps: CoworkToolDeps): Array<() => void> {
  const host = ctx as { tools: { register(definition: ToolDefinition): () => void } }
  const disposers: Array<() => void> = []

  disposers.push(host.tools.register(defineTool({
    name: 'cowork_checkout_merge',
    description:
      'Merge one isolated thread branch into the current repository, then delete its clone, workspace, and session. Requires a passed review unless the master explicitly overrides with allowUnreviewed + overrideReason. Master only.',
    parameters: {
      threadId: { type: 'string', required: true, description: 'Thread whose checkout should be merged.' },
      message: { type: 'string', description: 'Merge commit message; defaults to "cowork: merge <threadId>".' },
      allowUnreviewed: {
        type: 'boolean',
        description:
          'Merge even though the thread has not passed review. Requires overrideReason; the reason is recorded in the merge commit message and the result.',
      },
      overrideReason: {
        type: 'string',
        description: 'Why this merge skips the review gate; cleaned (control characters and line breaks removed) and appended to the merge commit message.',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: async (args, exec) => {
      const caller = callerOf(exec)
      if (isFailure(caller)) return toJson(caller)
      try {
        const opened = await openProject(caller, deps)
        if (isFailure(opened)) return toJson(opened)
        const denied = checkRole('master', caller, opened.index)
        if (denied !== null) return toJson(denied)

        const threadId = args.threadId.trim()
        const thread = opened.index.threads.find((entry) => entry.threadId === threadId)
        if (thread === undefined) {
          return toJson(failure(ERROR_CODES.threadNotFound, `thread not found in the project index: ${threadId}`, { threadId }))
        }
        const checkoutPath = thread.checkoutPath
        if (checkoutPath === null) {
          return toJson(failure(ERROR_CODES.checkoutNotFound, `thread ${threadId} has no isolated checkout`, { threadId }))
        }
        if (thread.status !== 'awaiting_review' && thread.status !== 'done') {
          return toJson(failure(
            ERROR_CODES.checkoutNotReady,
            `thread ${threadId} is ${thread.status}; merging is allowed for awaiting_review or done`,
            { threadId, status: thread.status },
          ))
        }

        // The gate runs before the irreversible step.
        const plan = checkLegacyThreadMerge({ threadId, reviewStatus: thread.reviewStatus }, {
          allowUnreviewed: args.allowUnreviewed === true,
          overrideReason: typeof args.overrideReason === 'string' ? args.overrideReason : '',
        })
        if (!plan.ok) {
          return toJson(failure(plan.failure.error.code, plan.failure.error.message, {
            threadId,
            status: thread.status,
            reviewStatus: thread.reviewStatus,
            latestReviewPath: thread.latestReviewPath,
          }))
        }
        const requestedMessage =
          typeof args.message === 'string' && args.message.trim() !== '' ? args.message.trim() : ''
        // checkout.ts owns the default message; the suffix must land on it too.
        const mergeMessage = plan.suffix === ''
          ? requestedMessage === '' ? undefined : requestedMessage
          : `${requestedMessage === '' ? `cowork: merge ${threadId}` : requestedMessage}${plan.suffix}`

        const merged = await mergeCheckout(checkoutDeps, {
          repoPath: opened.repoPath,
          threadId,
          message: mergeMessage,
        })
        if (!merged.ok) {
          if (merged.code === CHECKOUT_ERROR.mergeConflict) {
            // The clone stays so the thread can resolve and retry. The conflict
            // result is the real answer, so a failed index write is reported
            // inside it (`statusUpdateError`) instead of escaping to the
            // generic catch, which would hide the conflict itself.
            const statusUpdate = await applyThreadStatus(async () => {
              const updated = await opened.store.updateThread(threadId, { status: 'blocked' })
              return { thread: updated.threads.find((entry) => entry.threadId === threadId) ?? null }
            })
            return toJson(failure(merged.code, merged.message, {
              ...merged.details,
              threadId,
              status: 'blocked',
              thread: statusUpdate.thread === null ? null : threadView(statusUpdate.thread),
              ...(statusUpdate.error === null ? {} : { statusUpdateError: statusUpdate.error }),
            }))
          }
          return toJson(failure(merged.code, merged.message, { ...merged.details, threadId }))
        }

        // The merge already landed: every teardown step is caught on its own
        // and reported in `cleanupErrors`, never turned into a failed result.
        // A failure here means the branch *is* merged; a reported failure would
        // invite a retry that merges it a second time.
        const teardown = await teardownMergedCheckout<ThreadRecord>(
          { checkoutPath, threadId },
          {
            resolveWorkspace: (path) => deps.workspaceRegistry.resolveByPath(path),
            removeCheckout: () => removeCheckout(checkoutDeps, { repoPath: opened.repoPath, threadId }),
            deleteWorkspace: (workspaceId) => opened.slice.deleteWorkspace(workspaceId),
            archiveSession: (sessionId) => opened.slice.archiveSession(sessionId),
            updateThread: async (id) => {
              const updated = await opened.store.updateThread(id, { checkoutPath: null, status: 'done' })
              return { thread: updated.threads.find((entry) => entry.threadId === id) ?? null }
            },
          },
        )
        return toJson(success({
          threadId,
          merged: true,
          commit: merged.commit,
          branch: merged.branch,
          reviewOverride: plan.reason === null ? null : { reason: plan.reason },
          cleanup: teardown.cleanup,
          cleanupErrors: teardown.cleanupErrors,
          thread: teardown.thread === null ? null : threadView(teardown.thread),
        }))
      } catch (error) {
        return toJson(mapError(error))
      }
    },
  })))

  return disposers
}
