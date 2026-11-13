import type { CoworkToolDeps } from './tool-runtime.js';
/** Wire codes owned by the request tools. */
export declare const REQUEST_TOOL_ERROR_CODES: {
    /** A payload field is missing, malformed, or over its contract cap. */
    readonly payloadInvalid: "request/payload-invalid";
    /** The plan path is not a repo-relative POSIX path. */
    readonly planPathInvalid: "request/plan-path-invalid";
    /** The topic is archived, so it may not ask the user for anything. */
    readonly topicArchived: "request/topic-archived";
};
/**
 * Register the three request tools and return their disposers, in the
 * documented registration order (after the topic tools).
 */
export declare function registerRequestTools(ctx: unknown, deps: CoworkToolDeps): Array<() => void>;
