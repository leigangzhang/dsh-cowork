import type { InboxAnswerInput, RequestAction, RequestKind, RequestPayload, RequestRecordV1 } from './inbox-contract.js';
import type { TopicNoticePort } from './notices.js';
import type { ProjectIndexV2, TopicRecordV2 } from './store-schema.js';
import type { RequestServiceStorePort } from './request-support.js';
/** One request to create for an already-validated topic. */
export interface CreateRequestInput {
    readonly store: Pick<RequestServiceStorePort, 'appendActivity'>;
    readonly repoPath: string;
    readonly projectId: string;
    readonly topic: TopicRecordV2;
    readonly kind: RequestKind;
    readonly payload: RequestPayload;
    readonly summary?: string;
    /** Reuse the id another writer already minted (the authorization bridge). */
    readonly requestId: string;
    readonly now: Date;
    readonly log?: (message: string) => void;
}
/**
 * Persist one pending request and its `request-created` activity. The request
 * file is the state; a failed activity append is a logged evidence gap and
 * never rolls the file back.
 */
export declare function createRequest(input: CreateRequestInput): Promise<RequestRecordV1>;
/** Everything one resolve call needs. */
export interface ResolveRequestInput {
    readonly store: RequestServiceStorePort;
    readonly repoPath: string;
    /** The index read for the pre-check; the write re-reads under its own lock. */
    readonly document: ProjectIndexV2;
    readonly sessionId: string;
    readonly requestId: string;
    readonly action: RequestAction;
    readonly answers?: readonly InboxAnswerInput[];
    readonly comment?: unknown;
    readonly now: Date;
    readonly promptSession?: (sessionId: string, text: string) => Promise<{
        accepted: boolean;
    }>;
    readonly noticePort?: TopicNoticePort;
    readonly kickNotices?: (repoPath: string) => void;
    readonly log?: (message: string) => void;
}
/** What one resolve call did, with the row the response reports. */
export interface ResolveRequestOutcome {
    readonly record: RequestRecordV1;
    /** False when the same action replayed an already-terminal request. */
    readonly changed: boolean;
    /** Whether the topic session accepted the wake-up prompt. */
    readonly prompted: boolean;
    /** Prompt failure text; the request stays terminal. */
    readonly promptError: string | null;
}
/**
 * Resolve one pending request: validate the caller, the action and the
 * answers, write the terminal state and the right-hand reply, record the
 * activity, then wake the topic session with the reply.
 *
 * The terminal write is durable before the prompt is attempted, so a refused
 * or failed queue prompt is reported in `delivery.lastError` instead of
 * rolling the decision back. A replay of the same action is idempotent
 * (`changed: false`); a different action on a terminal request is
 * `inbox/request-resolved`.
 */
export declare function resolveRequest(input: ResolveRequestInput): Promise<ResolveRequestOutcome>;
/** Everything one wake-up prompt needs. */
export interface PromptRequestTopicInput {
    readonly repoPath: string;
    readonly requestId: string;
    readonly topicId: string;
    readonly sessionId: string;
    /** Already-rebuilt prompt text, or null when no prompt is due. */
    readonly text: string | null;
    /** The delivery block's previous `promptedAt`, kept on a refused prompt. */
    readonly previousPromptedAt: string | null;
    readonly promptSession?: (sessionId: string, text: string) => Promise<{
        accepted: boolean;
    }>;
    readonly now: Date;
    readonly log?: (message: string) => void;
}
/** What one wake-up prompt did. */
export interface PromptRequestTopicOutcome {
    readonly prompted: boolean;
    readonly promptError: string | null;
}
/**
 * Wake the topic session with `text` and persist the delivery facts on the
 * request card. A null text, a caller that is the topic itself and a host
 * without a prompt port are all deliberate non-prompts. A prompt failure is
 * recorded in `delivery.lastError` and never rolls the terminal state back; a
 * failed delivery write is logged rather than thrown, because the decision is
 * already durable.
 */
export declare function promptRequestTopic(input: PromptRequestTopicInput): Promise<PromptRequestTopicOutcome>;
