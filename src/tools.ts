/**
 * The cowork tool assembly (M9.3a).
 *
 * This module is orchestration plus the tools that are still waiting for their
 * own module: `cowork_route`, `cowork_thread_create`, `cowork_thread_list` and
 * `cowork_handoff` (their route/handoff semantics change in M9.3b). Project,
 * memory and checkout tools live in `project-tools.ts`, `memory-tools.ts` and
 * `checkout-tools.ts`; the two review tools stay in `review-tools.ts`.
 *
 * The registration order is part of the public surface: project_init,
 * project_status, route, thread_create, thread_list, handoff, memory_write,
 * memory_search, checkout_merge, review_request, review_verdict.
 *
 * Every tool follows the same path: read the caller from `exec.agent` (fail
 * closed when absent), resolve the project from the caller's cwd, build a fresh
 * `ProjectStore`/`SessionSlice`, enforce the role gate, and return either a
 * success payload or the shared failure envelope. Host services arrive through
 * `CoworkToolDeps`; nothing throws across the tool boundary.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { registerCheckoutTools } from './checkout-tools.js'
import { submitHandoff } from './handoff.js'
import { registerMemoryTools } from './memory-tools.js'
import { THREAD_PRESET_ID } from './presets.js'
import { registerProjectTools } from './project-tools.js'
import { decideRoute } from './router.js'
import type { RoutableThread } from './router.js'
import { registerReviewTools } from './review-tools.js'
import type { CoworkToolDeps } from './tool-runtime.js'
import {
  callerOf,
  createIsolatedThread,
  handoffSummaries,
  isFailure,
  mapError,
  newThreadRecord,
  nowOf,
  openProject,
  renderJson,
  threadView,
  toJson,
} from './tool-runtime.js'
import { ERROR_CODES, buildThreadBrief, checkRole, failure, routePayload, success } from './tool-model.js'

/**
 * Register the eleven cowork tools and return their disposers. The caller owns
 * the effect scope; this function only registers.
 */
export function registerCoworkTools(ctx: unknown, deps: CoworkToolDeps): Array<() => void> {
  const host = ctx as { tools: { register(definition: ReturnType<typeof defineTool>): () => void } }
  const disposers: Array<() => void> = []

  // 1-2) project_init and project_status (src/project-tools.ts).
  disposers.push(...registerProjectTools(host, deps))

  // 3) cowork_route — reuse, create, or ask the master for a subject.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_route',
    description:
      'Route a user intent to an existing thread, create a new thread when a subject is given, or ask for a subject when the intent matches nothing. Master only.',
    parameters: {
      intent: { type: 'string', required: true, description: 'What the user wants, verbatim.' },
      subject: {
        type: 'string',
        description: 'Short subject for a new thread; omit to let the router ask for one instead of creating.',
      },
      isolated: {
        type: 'boolean',
        description:
          'Create the routed thread in its own local git clone (.dsh-cowork/threads/<threadId>, branch cowork/<threadId>) instead of the shared repository.',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: async (args, exec) => {
      const caller = callerOf(exec)
      if (isFailure(caller)) return toJson(caller)
      const intent = args.intent.trim()
      if (intent === '') return toJson(failure(ERROR_CODES.intentRequired, 'intent must not be empty'))
      try {
        const opened = await openProject(caller, deps)
        if (isFailure(opened)) return toJson(opened)
        const denied = checkRole('master', caller, opened.index)
        if (denied !== null) return toJson(denied)

        const summaries = handoffSummaries(await opened.store.listHandoffs())
        const routable: RoutableThread[] = opened.index.threads.map((thread) => ({
          threadId: thread.threadId,
          subject: thread.subject,
          status: thread.status,
          updatedAt: thread.updatedAt,
          lastHandoffSummary: summaries.get(thread.threadId) ?? null,
        }))
        const subject = typeof args.subject === 'string' ? args.subject.trim() : ''
        const decision = decideRoute(intent, routable, { hasSubject: subject !== '', now: nowOf(deps) })

        if (decision.action === 'reuse') {
          const prompted = await opened.slice.promptSession(decision.threadId, intent)
          return toJson(success({ ...routePayload(decision), prompted: prompted.accepted }))
        }
        if (decision.action === 'needs_subject') {
          return toJson(success({ ...routePayload(decision) }))
        }

        if (args.isolated === true) {
          const isolated = await createIsolatedThread(opened, { subject, intent }, deps)
          if (isFailure(isolated)) return toJson(isolated)
          return toJson(success({
            ...routePayload(decision),
            threadId: isolated.threadId,
            subject,
            title: isolated.title,
            prompted: isolated.prompted,
            isolated: true,
            checkoutPath: isolated.checkoutPath,
            thread: threadView(isolated.thread),
          }))
        }

        const createdAt = nowOf(deps)
        const created = await opened.slice.createThread({
          repoPath: opened.repoPath,
          subject,
          presetId: THREAD_PRESET_ID,
        })
        const record = newThreadRecord(created.sessionId, subject, opened.repoPath, createdAt)
        await opened.store.addThread(record)
        const brief = buildThreadBrief({
          repoPath: opened.repoPath,
          subject,
          threadId: created.sessionId,
          intent,
        })
        const prompted = await opened.slice.promptSession(created.sessionId, brief)
        let thread = record
        if (prompted.accepted) {
          const updated = await opened.store.updateThread(created.sessionId, { status: 'active' })
          thread = updated.threads.find((entry) => entry.threadId === created.sessionId) ?? record
        }
        return toJson(success({
          ...routePayload(decision),
          threadId: created.sessionId,
          subject,
          title: created.title,
          prompted: prompted.accepted,
          thread: threadView(thread),
        }))
      } catch (error) {
        return toJson(mapError(error))
      }
    },
  })))

  // 4) cowork_thread_create — explicit thread creation by the master.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_thread_create',
    description:
      'Create a cowork thread session for a given subject, record it in the index, and optionally send its first brief. Master only.',
    parameters: {
      subject: { type: 'string', required: true, description: 'Short subject the thread owns.' },
      brief: { type: 'string', description: 'Optional first message for the new thread.' },
      isolated: {
        type: 'boolean',
        description:
          'Run this thread in its own local git clone (.dsh-cowork/threads/<threadId>, branch cowork/<threadId>) instead of the shared repository.',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: async (args, exec) => {
      const caller = callerOf(exec)
      if (isFailure(caller)) return toJson(caller)
      const subject = args.subject.trim()
      if (subject === '') {
        return toJson(failure('thread/subject-required', 'subject must not be empty'))
      }
      try {
        const opened = await openProject(caller, deps)
        if (isFailure(opened)) return toJson(opened)
        const denied = checkRole('master', caller, opened.index)
        if (denied !== null) return toJson(denied)

        const briefText = typeof args.brief === 'string' ? args.brief.trim() : ''
        if (args.isolated === true) {
          const isolated = await createIsolatedThread(opened, { subject, brief: briefText }, deps)
          if (isFailure(isolated)) return toJson(isolated)
          return toJson(success({
            thread: threadView(isolated.thread),
            title: isolated.title,
            prompted: isolated.prompted,
            isolated: true,
            checkoutPath: isolated.checkoutPath,
          }))
        }

        const createdAt = nowOf(deps)
        const created = await opened.slice.createThread({
          repoPath: opened.repoPath,
          subject,
          presetId: THREAD_PRESET_ID,
        })
        const record = newThreadRecord(created.sessionId, subject, opened.repoPath, createdAt)
        await opened.store.addThread(record)
        let thread = record
        let prompted = false
        if (briefText !== '') {
          const result = await opened.slice.promptSession(created.sessionId, briefText)
          prompted = result.accepted
          if (prompted) {
            const updated = await opened.store.updateThread(created.sessionId, { status: 'active' })
            thread = updated.threads.find((entry) => entry.threadId === created.sessionId) ?? record
          }
        }
        return toJson(success({ thread: threadView(thread), title: created.title, prompted }))
      } catch (error) {
        return toJson(mapError(error))
      }
    },
  })))

  // 5) cowork_thread_list — thread overview off the index.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_thread_list',
    description: 'List the cowork threads recorded in the project index. Master or thread.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    execute: async (_args, exec) => {
      const caller = callerOf(exec)
      if (isFailure(caller)) return toJson(caller)
      try {
        const opened = await openProject(caller, deps)
        if (isFailure(opened)) return toJson(opened)
        const denied = checkRole('master-or-thread', caller, opened.index)
        if (denied !== null) return toJson(denied)
        return toJson(success({ threads: opened.index.threads.map(threadView) }))
      } catch (error) {
        return toJson(mapError(error))
      }
    },
  })))

  // 6) cowork_handoff — the only way a thread reports back.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_handoff',
    description:
      'Report this thread result to the master: status, summary, and the verification you ran. Thread only; a thread that stops without this has not finished.',
    parameters: {
      status: {
        type: 'string',
        required: true,
        enum: ['awaiting_review', 'blocked', 'done'],
        description: 'Thread state after this handoff.',
      },
      summary: { type: 'string', required: true, description: 'What was done, in one paragraph.' },
      verification: {
        type: 'array',
        required: true,
        description: 'One row per check actually run.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            command: { type: 'string', required: true, description: 'Exact command that was run.' },
            exitCode: { type: 'integer', required: true, description: 'Exit code the command returned.' },
            evidence: { type: 'string', required: true, description: 'Short output or result that proves it.' },
          },
        },
      },
      decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions the master should know.' },
      changedPaths: { type: 'array', items: { type: 'string' }, description: 'Files this thread changed.' },
      artifacts: { type: 'array', items: { type: 'string' }, description: 'Paths the master may want to open.' },
      openIssues: { type: 'array', items: { type: 'string' }, description: 'What is still open.' },
      nextStep: { type: 'string', description: 'What should happen next.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: async (args, exec) => {
      const caller = callerOf(exec)
      if (isFailure(caller)) return toJson(caller)
      try {
        const opened = await openProject(caller, deps)
        if (isFailure(opened)) return toJson(opened)
        const denied = checkRole('thread', caller, opened.index)
        if (denied !== null) return toJson(denied)
        const thread = opened.index.threads.find((entry) => entry.threadId === caller.sessionId)
        if (thread === undefined) {
          return toJson(failure(ERROR_CODES.sessionMissing, `thread ${caller.sessionId} is not in the project index`))
        }
        const result = await submitHandoff(
          {
            store: opened.store,
            promptMaster: (text) => opened.slice.promptSession(opened.index.masterSessionId, text),
            clock: deps.clock,
          },
          {
            threadId: caller.sessionId,
            masterSessionId: opened.index.masterSessionId,
            subject: thread.subject,
            status: args.status,
            summary: args.summary,
            verification: args.verification,
            decisions: args.decisions,
            changedPaths: args.changedPaths,
            artifacts: args.artifacts,
            openIssues: args.openIssues,
            nextStep: args.nextStep,
          },
        )
        if (!result.ok) {
          return toJson(failure(ERROR_CODES.handoffInvalid, result.error.message, { errors: result.error.errors }))
        }
        return toJson(success({
          delivered: result.delivered,
          filePath: result.filePath,
          status: result.record.status,
          record: result.record,
        }))
      } catch (error) {
        return toJson(mapError(error))
      }
    },
  })))

  // 7-8) memory_write and memory_search (src/memory-tools.ts).
  disposers.push(...registerMemoryTools(host, deps))

  // 9) checkout_merge (src/checkout-tools.ts).
  disposers.push(...registerCheckoutTools(host, deps))

  // 10-11) review_request / review_verdict live in src/review-tools.ts; the
  // shared helpers they reuse are injected, so the import stays one-way.
  disposers.push(...registerReviewTools(host, {
    callerOf,
    openProject: (caller) => openProject(caller, deps),
    mapError,
    toJson,
    renderJson,
    nowOf: () => nowOf(deps),
    threadView,
    isFailure,
  }))

  return disposers
}
