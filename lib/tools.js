import { registerCheckoutTools, registerWorkItemTools } from './checkout-tools.js';
import { registerMemoryTools } from './memory-tools.js';
import { registerProjectTools } from './project-tools.js';
import { registerRequestTools } from './request-tools.js';
import { registerReviewTools } from './review-tools.js';
import { registerRouteTools } from './route-tools.js';
import { callerOf, isFailure, mapError, nowOf, openProject, renderJson, threadView, toJson, } from './tool-runtime.js';
import { registerTopicTools } from './topic-tools.js';
/**
 * Register the twenty-two cowork tools and return their disposers. The caller owns
 * the effect scope; this function only composes the domain registrars, in the
 * documented order (the review tools before memory, merge last).
 */
export function registerCoworkTools(ctx, deps) {
    const host = ctx;
    const disposers = [
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
    ];
    return disposers;
}
//# sourceMappingURL=tools.js.map