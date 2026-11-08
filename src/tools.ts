/**
 * The cowork tool assembly (M9.3b): registration orchestration only.
 *
 * The fourteen tools live in their domain modules:
 *
 * - `project-tools.ts` — project_init, project_status
 * - `route-tools.ts` — route
 * - `topic-tools.ts` — topic_create, thread_create (deprecated), topic_list,
 *   thread_list (deprecated), handoff, topic_resolve
 * - `memory-tools.ts` — memory_write, memory_search
 * - `checkout-tools.ts` — checkout_merge
 * - `review-tools.ts` — review_request, review_verdict
 *
 * The registration order is part of the public surface:
 * project_init, project_status, route, topic_create, thread_create,
 * topic_list, thread_list, handoff, topic_resolve, memory_write,
 * memory_search, checkout_merge, review_request, review_verdict.
 *
 * Host services arrive through `CoworkToolDeps`; nothing throws across the tool
 * boundary, and the review tools keep receiving their helpers by injection so
 * the dependency stays one-way.
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { registerCheckoutTools } from './checkout-tools.js'
import { registerMemoryTools } from './memory-tools.js'
import { registerProjectTools } from './project-tools.js'
import { registerReviewTools } from './review-tools.js'
import { registerRouteTools } from './route-tools.js'
import type { CoworkToolDeps } from './tool-runtime.js'
import {
  callerOf,
  isFailure,
  mapError,
  nowOf,
  openProject,
  renderJson,
  threadView,
  toJson,
} from './tool-runtime.js'
import { registerTopicTools } from './topic-tools.js'

/** The tool-registry slice of the plugin context. */
interface ToolHost {
  tools: { register(definition: ToolDefinition): () => void }
}

/**
 * Register the fourteen cowork tools and return their disposers. The caller
 * owns the effect scope; this function only composes the domain registrars.
 */
export function registerCoworkTools(ctx: unknown, deps: CoworkToolDeps): Array<() => void> {
  const host = ctx as ToolHost
  const disposers: Array<() => void> = [
    ...registerProjectTools(host, deps),
    ...registerRouteTools(host, deps),
    ...registerTopicTools(host, deps),
    ...registerMemoryTools(host, deps),
    ...registerCheckoutTools(host, deps),
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
  ]
  return disposers
}
