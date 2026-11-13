import type { TopicNoticePort } from './notices.js';
import type { ProjectIndexV2, TopicRecordV2 } from './store-schema.js';
import type { RequestServiceStorePort } from './request-support.js';
/** Everything the shared authorization decision core needs. */
export interface AuthorizationDecisionInput {
    readonly store: RequestServiceStorePort;
    /** Repository root, used only to kick the notice dispatcher after the write. */
    readonly repoPath: string;
    readonly topicId: string;
    readonly requestId: string;
    readonly decision: 'allow' | 'deny';
    readonly sessionId: string;
    readonly now: Date;
    /**
     * When true, commit the unlock, the notice patch and the activity, but return
     * the wake-up text in `promptText` instead of prompting. The caller prompts
     * after the request card is terminal, so a card write failure can never leave
     * a prompted topic behind a pending card.
     */
    readonly deferPrompt?: boolean;
    readonly promptSession?: (sessionId: string, text: string) => Promise<{
        accepted: boolean;
    }>;
    readonly noticePort?: TopicNoticePort;
    readonly kickNotices?: (repoPath: string) => void;
    readonly log?: (message: string) => void;
}
/** What one authorization decision did. */
export interface AuthorizationDecisionOutcome {
    readonly changed: boolean;
    readonly prompted: boolean;
    readonly promptError: string | null;
    /** The wake-up text when a committed decision still owes a prompt, or null. */
    readonly promptText: string | null;
    readonly noticeId: string | null;
    readonly document: ProjectIndexV2;
    readonly topic: TopicRecordV2;
    readonly decision: 'allow' | 'deny';
}
/**
 * The one authorization decision core: permission, idempotent replay,
 * lock-scoped unlock, `authorization-resolved` activity, notice patch and the
 * topic prompt. Both the legacy `authorization.resolve` route and the inbox
 * resolve route call this function; neither has an unlock path of its own.
 */
export declare function resolveAuthorizationDecision(input: AuthorizationDecisionInput): Promise<AuthorizationDecisionOutcome>;
/**
 * Converge the request-inbox record of one authorization decision made through
 * the legacy `authorization.resolve` route.
 *
 * The index, the topic authorization and the notice are already handled by
 * {@link resolveAuthorizationDecision}; this keeps the inbox card in step so
 * the two routes cannot show different states. The legacy route calls it with
 * no delivery facts and patches them after the deferred prompt (see
 * {@link promptRequestTopic}), so the card is terminal before the topic wakes.
 * It is
 * deliberately tolerant: the legacy route must keep its response shape, so a
 * missing record (a topic that never used the request tools), a record of
 * another kind or topic, and a record another writer already settled are all
 * quiet outcomes, and a storage/activity failure is logged rather than thrown.
 *
 * Only a pending record is written; an already-terminal record is never
 * overwritten, so an inbox.resolve that settled first keeps its own delivery
 * facts and its one `request-resolved` activity row.
 */
export type SettleAuthorizationOutcome = 'absent' | 'settled' | 'already-resolved' | 'conflict';
/** One legacy authorization decision to mirror into the request inbox. */
export interface SettleAuthorizationRecordInput {
    readonly store: Pick<RequestServiceStorePort, 'appendActivity'>;
    readonly repoPath: string;
    readonly topicId: string;
    readonly requestId: string;
    readonly decision: 'allow' | 'deny';
    readonly now: Date;
    /** When the topic session accepted the queue prompt, or null. */
    readonly promptedAt: string | null;
    /** Why the queue prompt failed, or null. */
    readonly promptError: string | null;
    /** The legacy route decides as the user unless told otherwise. */
    readonly resolvedBy?: 'user' | 'master';
    readonly log?: (message: string) => void;
}
export declare function settleAuthorizationRequestRecord(input: SettleAuthorizationRecordInput): Promise<SettleAuthorizationOutcome>;
