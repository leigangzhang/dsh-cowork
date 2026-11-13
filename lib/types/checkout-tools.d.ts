import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { GitRunner } from './checkout.js';
import type { CoworkToolDeps } from './tool-runtime.js';
/**
 * Serialize merge operations inside this process: every `cowork_checkout_merge`
 * call runs through this chain, so two merges never interleave their gate and
 * git steps. The chain is not poisoned by a failed merge (a rejected operation
 * still lets the next one run), and the returned promise is the operation's own
 * result. Cross-process serialization is explicitly not promised (M10 risk).
 *
 * Exported so the ordering rule itself can be tested with plain promises.
 */
export declare function serializeMerge<T>(operation: () => Promise<T>): Promise<T>;
/**
 * The tool-registry slice of the plugin context; the rest of `ctx` stays opaque.
 */
export interface WorkItemToolsHost {
    tools: {
        register(definition: ToolDefinition): () => void;
    };
}
/**
 * What `registerWorkItemTools` needs beyond the shared bag: an id source and a
 * git runner, both optional so production keeps the defaults and a test can make
 * a creation deterministic or a clone fail.
 */
export interface WorkItemToolDeps extends CoworkToolDeps {
    newWorkItemId?: () => string;
    runGit?: GitRunner;
}
/** What `registerCheckoutTools` needs beyond the shared bag. */
export interface CheckoutToolDeps extends CoworkToolDeps {
    runGit?: GitRunner;
}
/**
 * Register `cowork_work_item_create` (topic/master): clone one isolated work
 * item, write its `active` v2 record, and record the creation activity. The tool
 * is registered but not yet assembled by `src/tools.ts`; M10.4b owns the 15-tool
 * order.
 */
export declare function registerWorkItemTools(ctx: unknown, deps: WorkItemToolDeps): Array<() => void>;
/**
 * Register `cowork_checkout_merge` (master only): the M10 work-item merge with
 * the deprecated thread clone as a compatibility alias. `workItemId` wins when
 * both are passed; `allowUnreviewed`/`overrideReason` no longer exist — a merge
 * without a passed review of the same head is refused.
 */
export declare function registerCheckoutTools(ctx: unknown, deps: CheckoutToolDeps): Array<() => void>;
