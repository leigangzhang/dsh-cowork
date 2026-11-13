import type { CoworkToolDeps } from './tool-runtime.js';
/** Most topics `cowork_topic_list` returns (and its deprecated alias). */
export declare const TOPIC_LIST_LIMIT = 100;
/** Most notices `cowork_notices` returns in one call. */
export declare const TOPIC_NOTICES_MAX_LIMIT = 100;
/** Notices `cowork_notices` returns when the call names no limit. */
export declare const TOPIC_NOTICES_DEFAULT_LIMIT = 20;
/** Longest report/proposal summary a topic tool accepts. */
export declare const TOPIC_SUMMARY_MAX_CHARS = 2000;
/**
 * Wire codes owned by the topic-page tools. Kept here (not in the pinned
 * `tool-model` tables) so this task's scope stays one module.
 */
export declare const TOPIC_PAGE_ERROR_CODES: {
    readonly summaryRequired: "topic/summary-required";
    readonly summaryTooLong: "topic/summary-too-long";
    readonly proposalTitleRequired: "topic/proposal-title-required";
    readonly proposalWriteFailed: "topic/proposal-write-failed";
    readonly invalidKind: "topic/invalid-kind";
};
/** One stored decision proposal (`<repo>/.dsh-cowork/proposals/<id>.json`). */
export interface DecisionProposalV1 {
    version: 1;
    proposalId: string;
    topicId: string;
    title: string;
    summary: string;
    status: 'open';
    createdAt: string;
}
/**
 * Register the topic tools and return their disposers, in the documented order.
 */
export declare function registerTopicTools(ctx: unknown, deps: CoworkToolDeps): Array<() => void>;
