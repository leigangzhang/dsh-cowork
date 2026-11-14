/**
 * The cowork tool assembly (M10.4b): registration orchestration only.
 *
 * The twenty-two tools live in their domain modules:
 *
 * - `project-tools.ts` — project_init, project_status
 * - `route-tools.ts` — route
 * - `topic-tools.ts` — topic_create, thread_create (deprecated), topic_list,
 *   thread_list (deprecated), handoff, topic_resolve, topic_report,
 *   decision_propose, authorization_request, notices
 * - `checkout-tools.ts` — work_item_create, checkout_merge
 * - `request-tools.ts` — user_review_request, request_question, request_plan
 * - `review-tools.ts` — review_request, review_verdict
 * - `memory-tools.ts` — memory_write, memory_search
 *
 * The registration order is part of the public surface (PLAN-V0.2 §5.7):
 * project_init, project_status, route, topic_create, thread_create,
 * topic_list, thread_list, handoff, topic_resolve, topic_report,
 * decision_propose, authorization_request, notices, user_review_request,
 * request_question, request_plan, work_item_create, review_request,
 * review_verdict, memory_write, memory_search, checkout_merge.
 *
 * Host services arrive through `CoworkToolDeps`; nothing throws across the tool
 * boundary, and the review tools keep receiving their helpers by injection so
 * the dependency stays one-way. The v1 read-only compatibility surface
 * (`src/store/migration.ts` and the legacy store view) stays through 0.3.0
 * (KI-18); this assembly writes canonical v2 state only.
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { registerCheckoutTools, registerWorkItemTools } from '../tools/isolation.js'
import { registerMemoryTools } from '../tools/memory.js'
import { registerProjectTools } from '../tools/project.js'
import { registerRequestTools } from '../tools/request.js'
import { registerReviewTools } from '../tools/review.js'
import { registerRouteTools } from '../tools/route.js'
import type { CoworkToolDeps } from '../platform/tool-runtime.js'
import {
  callerOf,
  isFailure,
  mapError,
  nowOf,
  openProject,
  renderJson,
  threadView,
  toJson,
} from '../platform/tool-runtime.js'
import { registerTopicTools } from '../tools/topic.js'

/** The tool-registry slice of the plugin context. */
interface ToolHost {
  tools: { register(definition: ToolDefinition): () => void }
}

/**
 * Register the twenty-two cowork tools and return their disposers. The caller owns
 * the effect scope; this function only composes the domain registrars, in the
 * documented order (the review tools before memory, merge last).
 */
export function registerCoworkTools(ctx: unknown, deps: CoworkToolDeps): Array<() => void> {
  const host = ctx as ToolHost
  const disposers: Array<() => void> = [
    ...registerProjectTools(host, deps),
    ...registerRouteTools(host, deps),
    ...registerTopicTools(host, deps),
    ...registerRequestTools(host, deps),
    ...registerWorkItemTools(host, deps),
    ...registerReviewTools(host, {
      callerOf,
      openProject: (caller) => openProject(caller, deps),
      mapError,
      toJson,
      renderJson,
      nowOf: () => nowOf(deps),
      threadView,
      isFailure,
    }),
    ...registerMemoryTools(host, deps),
    ...registerCheckoutTools(host, deps),
  ]
  return disposers
}
