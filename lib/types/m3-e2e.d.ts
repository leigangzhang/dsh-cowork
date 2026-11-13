import type { M3E2EConfig, M3E2EHost, M3RunState, M3RunStatusView } from './m3-e2e-support.js';
export { M3_E2E_RUN_PATH, M3_E2E_STATUS_PATH } from './m3-e2e-support.js';
export type { M3E2EHost } from './m3-e2e-support.js';
export declare class M3E2ERunner {
    private readonly host;
    private readonly config;
    private readonly runs;
    private readonly events;
    private readonly tracked;
    private readonly evidenceFile;
    private readonly fixturePath;
    private readonly reviewsDir;
    private lastRunId;
    private disposed;
    private masterId;
    private threadA;
    private threadACheckout;
    private threadB;
    private threadBCheckout;
    private reviewerA;
    private reviewerB1;
    private reviewerB2;
    constructor(host: M3E2EHost, config: M3E2EConfig);
    attachEvents(): () => void;
    start(): {
        runId: string;
        state: M3RunState;
    };
    resolve(runId: string): Promise<M3RunStatusView | undefined>;
    dispose(): void;
    private execute;
    private runStep;
    private stepSetup;
    private createThread;
    private pollThreadHandoff;
    private stepThreadWork;
    private requestReview;
    private reviewVerdict;
    private reviewerEventSummary;
    private repairThread;
    private mergeThread;
    private stepCleanup;
    private mergeAlreadyDone;
    private checkReviewFile;
    private poll;
    private waitIdle;
    private promptStep;
    private refreshPrompts;
    private lastSeqOf;
    private deliveryEventSince;
    private observeGit;
    private gitOk;
    private readIndex;
    private reviewState;
    private readReviewRecord;
    private waitHandoffAfter;
    private safeSnapshot;
    private master;
    private threadOf;
    private sessionIds;
    private track;
    private releaseSessions;
    private archiveSession;
    private safeArchiveSessions;
    /**
     * Delete the fixture after the evidence file has been written. `rm(force)`
     * makes the second delete (after a successful `stepCleanup`) a no-op. A
     * failed delete is appended to `cleanup.errors` and persisted again; it never
     * rewrites `run.state`/`run.error`, so the original run error stays reported.
     */
    private removeFixture;
    private persist;
}
