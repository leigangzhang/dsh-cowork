/**
 * Shared plumbing of the request-inbox service modules.
 *
 * `PanelServiceError` is the one failure every inbox route answers with; the
 * store port, the error-message helpers and the member guard are used by both
 * the lifecycle and the file-opening modules. Keeping them here lets
 * `request-lifecycle.ts` and `request-open.ts` stay acyclic.
 */
import type { PanelErrorCode } from './api-contract.js';
import type { ProjectIndexV2, ActivityEvent, ReadActivityResult } from './store-schema.js';
import type { NoticeLedgerV1 } from './notices.js';
/** A failure the panel routes answer with a stable code and status. */
export declare class PanelServiceError extends Error {
    readonly code: PanelErrorCode;
    readonly path: string | undefined;
    constructor(code: PanelErrorCode, message: string, path?: string);
}
/** The store operations creation and resolution need; `ProjectStore` satisfies it. */
export interface RequestServiceStorePort {
    readIndexDocument(): Promise<ProjectIndexV2>;
    mutateIndexDocument(mutator: (document: ProjectIndexV2) => ProjectIndexV2 | null): Promise<ProjectIndexV2>;
    appendActivity(event: ActivityEvent): Promise<void>;
    readActivity(limit?: number): Promise<ReadActivityResult>;
    readNotices?(): Promise<NoticeLedgerV1>;
    writeNotices?(ledger: NoticeLedgerV1): Promise<NoticeLedgerV1>;
    mutateNotices?(mutator: (ledger: NoticeLedgerV1) => NoticeLedgerV1): Promise<NoticeLedgerV1>;
}
/** A message for one failure, without carrying a stack into a report. */
export declare function messageOf(error: unknown): string;
/** Cut text to at most `limit` Unicode code points without splitting a pair. */
export declare function clipText(text: string, limit: number): string;
/**
 * Refuse a caller that is neither the project master nor the owning topic. A
 * row without a topic (an activity notice that carries none) is master-only,
 * because no topic session can own it.
 */
export declare function assertMember(document: ProjectIndexV2, sessionId: string, topicId: string | null): void;
