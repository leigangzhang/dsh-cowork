import type { ProjectIndexV2 } from './store-schema.js';
import type { RequestServiceStorePort } from './request-support.js';
/** What one open call needs. */
export interface OpenRequestTargetInput {
    readonly store: Pick<RequestServiceStorePort, 'readActivity'>;
    readonly repoPath: string;
    /**
     * The index the member check reads. The caller is the session that opened the
     * project, so the same "master or the owning topic" rule as resolve applies:
     * a repository session may not reveal another topic's file by guessing an id.
     */
    readonly document: ProjectIndexV2;
    readonly sessionId: string;
    readonly requestId?: string;
    readonly noticeId?: string;
    /** Host file-browser port; absent means the host cannot open files. */
    readonly openWorkspacePath?: (path: string) => Promise<void>;
}
/**
 * `POST /api/cowork.inbox.open`: reveal the plan or proposal file of one
 * request or notice through the host's file browser. The browser sends an id,
 * never a path; a host without the desktop capability is
 * `inbox/open-unsupported`, never a faked success.
 */
export declare function openRequestTarget(input: OpenRequestTargetInput): Promise<string>;
