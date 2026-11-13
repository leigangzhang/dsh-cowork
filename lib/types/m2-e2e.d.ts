import type { M2E2EConfig, M2E2EHost, M2E2EStatusView, M2RunState } from './m2-e2e-support.js';
export { M2_E2E_EVIDENCE_RELATIVE, M2_E2E_FIXTURE_RELATIVE, M2_E2E_STEP_TIMEOUT_MS, } from './m2-e2e-support.js';
export type { M2Assertion, M2E2EConfig, M2E2EEvidenceDocument, M2E2EHost, M2E2EStatusView, M2PromptEvidence, M2RunState, M2SessionEvent, M2SessionHeader, M2SessionRow, M2StepEvidence, M2StepStatus, M2StepView, M2ToolCallEvidence, M2Workspace, } from './m2-e2e-support.js';
/**
 * One M2 E2E run at a time. The runner keeps only in-memory run views; every
 * durable fact comes from the host, the project directory, or git.
 */
export declare class M2E2ERunner {
    private readonly host;
    private readonly config;
    private readonly runs;
    private readonly events;
    private readonly trackedSessions;
    private readonly evidenceFile;
    private readonly fixturePath;
    private lastRunId;
    private disposed;
    private masterSessionId;
    private thread1;
    private thread1CheckoutPath;
    private thread2;
    private thread2CheckoutPath;
    constructor(host: M2E2EHost, config: M2E2EConfig);
    /** Subscribe to the host session event feed; returns the disposer. */
    attachEvents(): () => void;
    /** Start one run and return its identity immediately; execution stays in the background. */
    start(): {
        runId: string;
        state: M2RunState;
    };
    /** Read one live run view, or undefined when this process never saw the id. */
    status(runId: string): M2E2EStatusView | undefined;
    /**
     * Resolve a run from memory, else from the evidence file. A host rebuild
     * reloads the module and empties the table, so a cited id must still answer.
     */
    resolve(runId: string): Promise<M2E2EStatusView | undefined>;
    /** Stop polling loops and release event buffers. */
    dispose(): void;
    private trimRuns;
    private execute;
    private runStep;
    /** Step 0: create the throwaway project and the master session; initialize the index. */
    private stepSetup;
    /** Step 1: write one master constraint and prove it reached constraints.md. */
    private stepMemoryWrite;
    /** Step 2: create the first isolated thread and prove clone, branch, workspace, session, index. */
    private stepIsolatedThread;
    /** Step 3: the thread commits inside its clone and hands off. */
    private stepThreadWork;
    /** Step 4: prove the master's constraint is visible to the model, not just to disk. */
    private stepMemoryVisible;
    /** Step 5: the thread reads the constraint the master wrote (project memory crosses sessions). */
    private stepMemoryCrossThread;
    /** Step 6: merge the first thread, clean up, and prove the main worktree got the file. */
    private stepMergeSuccess;
    /** Step 7: create the second isolated thread, commit its side, and commit the conflicting main side. */
    private stepConflictThread;
    /** Step 8: merge the second thread, expect a conflict, and prove the abort kept the clone. */
    private stepConflictMerge;
    /** Step 9: the thread resolves its side and the second merge succeeds. */
    private stepConflictRetry;
    /** Step 10: snapshot the final index, archive sessions, drop workspaces, delete the fixture. */
    private stepCleanup;
    /** Assert the durable "merge finished" facts shared by both merge scenarios. */
    private assertMerged;
    /** Whether the merge target is already durable; used to pass idempotently. */
    private mergeAlreadyDone;
    private poll;
    private waitIdle;
    /**
     * Wait until every named session is idle in the same observation. Handoff
     * wakes can start a fresh master or thread turn right after one session goes
     * idle, so a single session's idleness is not enough before a merge prompt.
     */
    private waitAllIdle;
    private promptStep;
    /** Fill each prompt's assistant text and tool calls from the captured event stream. */
    private refreshPrompts;
    private lastSeq;
    private assistantTextSince;
    private toolCallsSince;
    private waitToolResult;
    private parseToolJson;
    /** The latest failed tool result text, used to fail a wait early instead of timing out. */
    private latestToolFailure;
    /** The latest completed result for one tool over the whole buffered session. */
    private latestToolResultAnywhere;
    private threadRecord;
    /** The fixture must be exactly the documented path, never a computed escape. */
    private assertFixturePath;
    private readIndex;
    private listHandoffs;
    private waitHandoffAfter;
    private safeSnapshot;
    private master;
    private checkoutOf;
    private sessionIds;
    private track;
    private releaseSessions;
    private archiveSession;
    /** Best-effort session archival; used even when the run failed before cleanup. */
    private safeArchiveSessions;
    private persist;
}
