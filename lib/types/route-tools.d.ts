import type { ProjectStore } from './store.js';
import type { CoworkToolDeps } from './tool-runtime.js';
/**
 * Correction write path for the M11 panel: append the intent's tokens to one
 * topic's aliases and record `route-corrected`. Canonical lock-scoped write; if
 * the correction adds nothing, nothing is written and `changed` is false.
 */
export declare function applyRouteCorrectionToStore(store: ProjectStore, input: {
    topicId: string;
    intent: string;
}, now: Date): Promise<{
    topicId: string;
    changed: boolean;
    added: string[];
    aliases: string[];
}>;
/**
 * Register `cowork_route` and return its disposer. It sits after the project
 * tools and before the topic tools in the assembly order.
 */
export declare function registerRouteTools(ctx: unknown, deps: CoworkToolDeps): Array<() => void>;
