import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { GitRunner } from './checkout.js';
import type { SessionSlice } from './session-slice.js';
import type { ProjectIndex, ProjectStore, ThreadRecord } from './store.js';
import type { CallerIdentity, ToolFailure } from './tool-model.js';
/** Lossless JSON value accepted by the tool result boundary. */
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
/** One resolved project plus the collaborators for one tool call. */
export interface ProjectRuntime {
    repoPath: string;
    store: ProjectStore;
    slice: SessionSlice;
    index: ProjectIndex;
}
/** The tool-registry slice of the plugin context; the rest of `ctx` stays opaque. */
export interface ReviewToolsHost {
    tools: {
        register(definition: ToolDefinition): () => void;
    };
}
/**
 * The src/tools.ts helpers these tools reuse. They are injected instead of
 * imported so the split does not create a `src/tools.ts` ↔ `src/review-tools.ts`
 * runtime cycle; `openProject` and `nowOf` are pre-bound to the assembly's deps.
 * `git` defaults to the real runner; a test injects a fake one.
 */
export interface ReviewToolsDeps {
    callerOf(exec: unknown): CallerIdentity | ToolFailure;
    openProject(caller: CallerIdentity): Promise<ProjectRuntime | ToolFailure>;
    mapError(error: unknown): ToolFailure;
    toJson(value: unknown): JsonValue;
    renderJson(args: unknown, value: JsonValue): Array<{
        type: 'text';
        text: string;
    }>;
    nowOf(): Date;
    threadView(thread: ThreadRecord): unknown;
    isFailure(value: unknown): value is ToolFailure;
    git?: GitRunner;
}
/**
 * Register the two review tools and return their disposers. The caller owns the
 * effect scope; this function only registers.
 */
export declare function registerReviewTools(ctx: unknown, deps: ReviewToolsDeps): Array<() => void>;
