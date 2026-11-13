import { MASTER_PRESET_ID, REVIEWER_PRESET_ID, TOPIC_PRESET_ID } from './presets.js';
import type { ActivityEvent, InboxItem, ProjectIndexV2, TopicRecordV2, WorkItemRecordV2 } from './store-schema.js';
export type { ActivityEvent, InboxItem, ProjectIndexV2, TopicRecordV2, WorkItemRecordV2 } from './store-schema.js';
export declare const M12_E2E_EVIDENCE_RELATIVE = ".dsh-cowork/e2e/M12_E2E.json";
export declare const M12_E2E_RUN_PATH = "/dsh-cowork/e2e/m12/run";
export declare const M12_E2E_STATUS_PATH = "/dsh-cowork/e2e/m12/status";
export declare const M12_E2E_STEP_TIMEOUT_MS = 180000;
export declare const M12_E2E_POLL_MS = 500;
export declare const M12_E2E_SHORT_IDLE_MS = 500;
export declare const M12_E2E_SHORT_RESOLVE_MS = 1000;
export declare const M12_E2E_FIXTURE_PREFIX = "dsh-cowork-m12-";
export declare const M12_E2E_WORK_FILE = "m12-e2e.txt";
export declare const M12_E2E_WORK_CONTENT = "M12-E2E-WORK";
export declare const M12_E2E_TOPIC_INTENT = "M12 E2E billing retry backoff";
export declare const M12_E2E_WAIT_BRIEF = "M12 E2E control: do not start any work and do not create or edit files yet; reply DONE.";
export declare const M12_E2E_REVIEW_SUMMARY = "M12 E2E review: the isolated work item adds m12-e2e.txt and the recorded verification passed.";
export declare const M12_E2E_HANDOFF_SUMMARY = "M12 E2E topic: the isolated work item added m12-e2e.txt, the work item commit was reviewed, and the merge is the master decision.";
export declare const M12_E2E_DONE = "Reply DONE.";
export declare const MAX_EVENTS = 4000;
export declare const MAX_ASSISTANT_TEXT = 1000;
export declare const MAX_FILE_TEXT = 2000;
export declare const MAX_GIT_TEXT = 2000;
export declare const MAX_FIELD_TEXT = 3000;
export declare const GIT_TIMEOUT_MS = 30000;
export declare const GIT_MAX_BUFFER: number;
export declare const PROJECT_INIT_TOOL = "cowork_project_init";
export declare const ROUTE_TOOL = "cowork_route";
export declare const WORK_ITEM_TOOL = "cowork_work_item_create";
export declare const REVIEW_REQUEST_TOOL = "cowork_review_request";
export declare const REVIEW_VERDICT_TOOL = "cowork_review_verdict";
export declare const HANDOFF_TOOL = "cowork_handoff";
export declare const MERGE_TOOL = "cowork_checkout_merge";
export { MASTER_PRESET_ID, REVIEWER_PRESET_ID, TOPIC_PRESET_ID };
export declare const M12_EXPECTED_ACTIVITY_TYPES: readonly ["topic-created", "route-created", "work-item-created", "review-requested", "review-verdict", "work-item-merged", "status-changed", "topic-archived", "topic-reopened"];
export declare const M12_STEP_IDS: readonly ["setup", "route-topic", "session-list", "overview", "work-item", "work-item-commit", "review-request", "review-verdict", "master-merge-decision", "handoff-done", "merge", "archive", "no-undo", "resolved-no-receive", "reopen", "activity", "cleanup"];
export type M12RunState = 'running' | 'done' | 'failed';
export type M12StepStatus = 'pending' | 'running' | 'passed' | 'failed';
export type PromptMode = 'queue' | 'steer';
export type M12SessionRole = 'master' | 'topic' | 'reviewer';
export interface SessionEvent {
    readonly type: string;
    readonly seq: number;
    readonly data: Record<string, unknown>;
}
export interface M12SessionRow {
    readonly sessionId: string;
    readonly cwd?: string;
    readonly running: boolean;
}
export interface M12Assertion {
    readonly name: string;
    readonly ok: boolean;
    readonly evidence: string;
}
export interface M12ToolCallEvidence {
    readonly name: string;
    readonly callId: string;
    readonly arguments: string;
    resultText: string | null;
    isError: boolean | null;
}
export interface M12PromptEvidence {
    readonly sessionId: string;
    readonly role: M12SessionRole;
    readonly content: string;
    readonly mode: PromptMode;
    accepted: boolean;
    readonly fromSeq: number;
    assistantText: string;
    toolCalls: M12ToolCallEvidence[];
}
export interface M12StepEvidence {
    startedAt: string | null;
    endedAt: string | null;
    prompts: M12PromptEvidence[];
    observations: Record<string, unknown>;
    assertions: M12Assertion[];
    note?: string;
    error?: string;
}
export interface M12StepView {
    readonly id: string;
    readonly status: M12StepStatus;
    readonly evidence: M12StepEvidence;
}
export interface M12RunStatusView {
    readonly runId: string;
    readonly state: M12RunState;
    readonly startedAt: string;
    readonly endedAt?: string;
    readonly steps: readonly M12StepView[];
    readonly evidenceFile: string;
    readonly error?: string;
}
export interface M12ArtifactIdentity {
    readonly repoPath: string;
    readonly pluginVersion: string;
    readonly head: string | null;
    readonly baseRef: string;
    readonly baseCommit: string | null;
    readonly diffSha256: string | null;
    readonly diffCommand: string;
    readonly statusPorcelain: string | null;
    readonly gitAvailable: boolean;
    readonly error?: string;
    readonly emptyRange: boolean;
}
export interface M12ArchivedSession {
    readonly role: string;
    readonly sessionId: string;
    readonly archived: boolean;
    readonly error: string | null;
}
export interface M12CleanupReport {
    readonly sessions: readonly M12ArchivedSession[];
    readonly archivedSessionIds: readonly string[];
    readonly archiveErrors: readonly string[];
    readonly workspaceId: string | null;
    readonly workspaceDeleted: boolean;
    readonly workspaceError: string | null;
    readonly fixturePath: string;
    readonly keepFixture: boolean;
    readonly fixtureRemoved: boolean;
    readonly errors: readonly string[];
}
export interface M12EvidenceDocument {
    readonly version: 1;
    readonly runId: string;
    readonly state: M12RunState;
    readonly startedAt: string;
    readonly endedAt: string | null;
    readonly evidenceFile: string;
    readonly host: {
        readonly plugin: string;
        readonly pluginVersion: string;
        readonly node: string;
        readonly platform: string;
        readonly arch: string;
        readonly repoPath: string;
    };
    readonly fixture: {
        readonly path: string | null;
        readonly keep: boolean;
    };
    readonly artifactIdentity: M12ArtifactIdentity | null;
    readonly steps: readonly M12StepView[];
    readonly finalIndex: unknown;
    readonly cleanup: M12CleanupReport | Record<string, unknown>;
    readonly error?: string;
}
export interface M12ReviewRequestView {
    readonly filePath: string;
    readonly requestId: string;
    readonly status: string;
    readonly topicId: string;
    readonly workItemId: string | null;
    readonly baseCommit: string;
    readonly headCommit: string;
    readonly path: string;
    readonly branch: string | null;
    readonly changedPaths: readonly string[];
    readonly verificationCount: number;
    readonly reviewerSessionId: string | null;
    readonly requestedAt: string;
    readonly reviewedAt: string | null;
    readonly summary: string | null;
    readonly findingCount: number;
    readonly record: Record<string, unknown>;
}
export interface M12OverviewTopic {
    readonly topicId: string;
    readonly status: string;
    readonly awaitingReview: boolean;
    readonly reviewStatus: string | null;
    readonly resolvedAt: string | null;
    readonly resolvedBy: string | null;
}
export interface M12PanelResult {
    readonly status: number;
    readonly body: unknown;
}
export interface M12PanelProbe {
    overview(input: {
        sessionId: string;
    }): Promise<M12PanelResult>;
    reopen(input: {
        sessionId: string;
        topicId: string;
    }): Promise<M12PanelResult>;
    /** Archive one topic through the shipped resolve route (the topic-page menu). */
    resolve(input: {
        sessionId: string;
        topicId: string;
    }): Promise<M12PanelResult>;
    /** Decide one pending authorization (topic page action). */
    authorizationResolve(input: {
        sessionId: string;
        topicId: string;
        requestId: string;
        decision: 'allow' | 'deny';
    }): Promise<M12PanelResult>;
}
export interface M12E2EHost {
    readonly sessionController: {
        create(request: {
            workspaceId?: string;
            cwd?: string;
            sessionId?: string;
            agentPreset?: string;
        }): Promise<{
            sessionId: string;
            agentPreset?: string;
        }>;
        prompt(request: {
            requestId: string;
            sessionId: string;
            mode: PromptMode;
            content: ReadonlyArray<{
                type: 'text';
                text: string;
            }>;
        }, signal?: AbortSignal): Promise<{
            accepted: boolean;
        }>;
        list(request?: unknown, signal?: AbortSignal): Promise<{
            items: readonly M12SessionRow[];
        }>;
        inspect(sessionId: string, signal?: AbortSignal): Promise<{
            meta: {
                id: string;
                cwd?: string;
                agentPreset?: string;
            };
        }>;
    };
    readonly workspaceRegistry: {
        resolveByPath(path: string): Promise<{
            id: string;
            path: string;
        } | undefined>;
        delete(id: string): Promise<boolean>;
        archiveSession(sessionId: string, options?: {
            stopActivity?: boolean;
        }): Promise<void>;
        readonly archivedSessionIds?: readonly string[];
    };
    on(name: 'session/event', listener: (session: {
        id: string;
    }, event: SessionEvent) => void): () => void;
}
export interface M12E2EConfig {
    readonly repoPath: string;
    readonly fixturePath?: string;
    readonly keepFixture?: boolean;
    readonly artifactBaseRef?: string;
    readonly promptTimeoutMs: number;
    readonly idleAfterMs: number;
    readonly resolveAfterMs: number;
    readonly pluginName: string;
    readonly pluginVersion: string;
    readonly panel: M12PanelProbe;
    readonly log?: (message: string) => void;
}
export interface MutableStep {
    readonly id: string;
    status: M12StepStatus;
    readonly evidence: M12StepEvidence;
}
export interface MutableRun {
    readonly runId: string;
    state: M12RunState;
    readonly startedAt: string;
    endedAt?: string;
    readonly steps: MutableStep[];
    error?: string;
    finalIndex: unknown;
    cleanup: M12CleanupReport | Record<string, unknown>;
    artifactIdentity: M12ArtifactIdentity | null;
}
export interface GitOutcome {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}
export interface DeliveryEvent {
    readonly type: string;
    readonly seq: number;
    readonly source: 'event' | 'assistant-text';
    readonly text: string;
}
export declare function createRun(runId: string, startedAt: string): MutableRun;
export declare function runStatusView(run: MutableRun, evidenceFile: string): M12RunStatusView;
export declare function buildEvidenceDocument(host: {
    plugin: string;
    pluginVersion: string;
    repoPath: string;
}, run: MutableRun, evidenceFile: string, fixture: {
    path: string | null;
    keep: boolean;
}): M12EvidenceDocument;
export declare function stepFailureState(stepId: string, error: unknown): {
    state: 'failed';
    error: string;
};
export declare function shouldRemoveFixture(state: M12RunState, keepFixture: boolean): boolean;
export declare function shortThresholdsProblem(idleAfterMs: number, resolveAfterMs: number): string | null;
/** The throwaway project must live outside the plugin repository. */
export declare function fixturePathProblem(pluginRepoPath: string, fixturePath: string): string | null;
export interface ReviewVerdictPlan {
    readonly action: 'steer' | 'skip' | 'fail';
    readonly mode: PromptMode | null;
    readonly reason: string;
}
export declare function planReviewVerdict(request: Pick<M12ReviewRequestView, 'status'> | null, expected: 'pass' | 'needs_revision'): ReviewVerdictPlan;
export interface ReviewRequestPlan {
    readonly action: 'steer' | 'adopt' | 'fail';
    readonly reason: string;
}
export declare function planRequestReview(requests: readonly Pick<M12ReviewRequestView, 'status' | 'workItemId'>[], workItemId: string): ReviewRequestPlan;
export interface MergePlan {
    readonly action: 'skip' | 'steer';
    readonly reason: string;
}
export declare function planMergePrompt(alreadyDone: boolean): MergePlan;
export declare function missingActivityTypes(events: readonly Pick<ActivityEvent, 'type'>[], expected?: readonly string[]): string[];
export declare function buildCleanupReport(input: {
    sessions: readonly M12ArchivedSession[];
    workspaceId: string | null;
    workspaceDeleted: boolean;
    workspaceError: string | null;
    fixturePath: string;
    keepFixture: boolean;
    fixtureRemoved: boolean;
    errors: readonly string[];
}): M12CleanupReport;
export interface ArtifactGitFacts {
    readonly head: GitOutcome;
    readonly base: GitOutcome;
    readonly diff: GitOutcome;
    readonly status: GitOutcome;
}
export declare function artifactIdentityFrom(input: {
    repoPath: string;
    baseRef: string;
    pluginVersion: string;
    facts: ArtifactGitFacts;
}): M12ArtifactIdentity;
export declare function buildProjectInitPrompt(): string;
export declare function buildRoutePrompt(): string;
export declare function buildResolvedRoutePrompt(resolvedTopicId: string): string;
export declare function buildWorkItemPrompt(): string;
export declare function buildCommitPrompt(input: {
    checkoutPath: string;
    fileName: string;
    content: string;
    message: string;
}): string;
export interface ReviewRequestPromptInput {
    readonly workItemId: string;
    readonly checkoutPath: string;
    readonly baseCommit: string;
    readonly headCommit: string;
    readonly fileName: string;
    readonly purpose: string;
}
export declare function buildReviewRequestPrompt(input: ReviewRequestPromptInput): string;
export interface ReviewerVerdictPromptInput {
    readonly requestId: string;
    readonly workItemId: string;
    readonly checkoutPath: string;
    readonly branch: string;
    readonly fileName: string;
}
export declare function buildReviewerVerdictPrompt(input: ReviewerVerdictPromptInput): string;
export interface HandoffPromptInput {
    readonly fileName: string;
}
export declare function buildHandoffPrompt(input: HandoffPromptInput): string;
export declare function buildMergePrompt(workItemId: string): string;
export declare function isoNow(): string;
export declare function messageOf(error: unknown): string;
export declare function sleep(ms: number): Promise<void>;
export declare function asRecord(value: unknown): Record<string, unknown> | undefined;
export declare function stringOrNull(value: unknown): string | null;
export declare function clip(text: string, limit: number): string;
export declare function stableJson(value: unknown): string;
export declare function obs(step: MutableStep, patch: Record<string, unknown>): void;
export declare function recordCheck(step: MutableStep, name: string, ok: boolean, evidence: unknown): void;
export declare function readTextIfPresent(path: string): Promise<string | undefined>;
export declare function writeEvidenceAtomic(file: string, content: string): Promise<void>;
export declare function isStrictlyInside(parent: string, child: string): boolean;
export declare function runGit(args: readonly string[], cwd: string): Promise<GitOutcome>;
export declare function parseProjectIndexV2(text: string): ProjectIndexV2 | undefined;
export interface ActivityFileRead {
    readonly events: ActivityEvent[];
    readonly skippedLines: number;
}
export declare function parseActivityFile(text: string): ActivityFileRead;
export declare function parseInboxFile(text: string): InboxItem[];
export declare function reviewRequestView(filePath: string, record: Record<string, unknown>): M12ReviewRequestView;
export declare function readReviewRequests(reviewsDir: string): Promise<M12ReviewRequestView[]>;
export interface HandoffFileView {
    readonly filePath: string;
    readonly topicId: string;
    readonly status: string;
    readonly summary: string;
    readonly createdAt: string;
}
export declare function readHandoffFiles(handoffsDir: string): Promise<HandoffFileView[]>;
export declare function contentText(message: unknown): string;
export declare function lastSeq(events: readonly SessionEvent[]): number;
export declare function assistantTextSince(events: readonly SessionEvent[], fromSeq: number): string;
export declare function toolCallsSince(events: readonly SessionEvent[], fromSeq: number, name?: string): M12ToolCallEvidence[];
export declare function deliveryEventSince(sessionId: string, events: readonly SessionEvent[], fromSeq: number, needle: string): DeliveryEvent | undefined;
export declare function eventsSince(events: readonly SessionEvent[], fromSeq: number): SessionEvent[];
export declare function toolResultJson(call: M12ToolCallEvidence): Record<string, unknown> | undefined;
export declare function topicOf(index: ProjectIndexV2 | undefined, topicId: string): TopicRecordV2 | undefined;
export declare function workItemOfTopic(index: ProjectIndexV2 | undefined, topicId: string): WorkItemRecordV2 | undefined;
export declare const PROJECT_DIR_RELATIVE = ".dsh-cowork";
export declare const INDEX_FILE_RELATIVE = ".dsh-cowork/index.json";
export declare const ACTIVITY_FILE_RELATIVE = ".dsh-cowork/activity.jsonl";
export declare const INBOX_FILE_RELATIVE = ".dsh-cowork/inbox.json";
export declare const REVIEWS_DIR_RELATIVE = ".dsh-cowork/reviews";
export declare const HANDOFFS_DIR_RELATIVE = ".dsh-cowork/handoffs";
export declare function projectPath(fixturePath: string, relative: string): string;
export declare function isLiveTopicStatus(status: string | undefined): boolean;
export interface SidebarFacts {
    rowExists: boolean;
    cwdMatches: boolean;
    cwd: string | null;
    running: boolean | undefined;
    topicPreset: string | null;
    archived: readonly string[] | undefined;
}
export declare function assertSidebarVisibility(step: MutableStep, sessionId: string, facts: SidebarFacts): void;
export interface MergeFacts {
    fileName: string;
    filePath: string;
    fileText: string | undefined;
    clonePath: string;
    cloneExists: boolean;
    branchExit: number;
    workItemStatus: string;
    workItemHead: string | null;
    reviewedHead: string;
    mainRefBefore: string;
    mainRefAfter: string;
    headBefore: string;
    headAfter: string;
    parentsStdout: string;
    parentsExit: number;
    ancestorExit: number;
}
export declare function assertMergedFacts(step: MutableStep, facts: MergeFacts): void;
export interface VerdictFacts {
    request: M12ReviewRequestView;
    reviewerSessionId: string;
    topicReviewStatus: string | null;
    topicAwaitingReview: boolean;
    indexReviewerSessionId: string | null;
    workItemStatus: string;
    inboxItem: InboxItem;
    reviewerArchived: boolean;
}
export declare function assertVerdictFacts(step: MutableStep, facts: VerdictFacts): void;
export interface RequestFacts {
    request: M12ReviewRequestView;
    reviewerSessionId: string;
    topicId: string;
    workItemId: string;
    headCommit: string;
    checkoutPath: string;
    branch: string;
    filePath: string;
    fileExists: boolean;
    reviewerPreset: string | null;
}
export declare function assertRequestFacts(step: MutableStep, facts: RequestFacts): void;
export interface MergeDecisionFacts {
    inbox: readonly InboxItem[];
    delivered: readonly InboxItem[];
    topicId: string;
    workItemId: string;
    deliveryText: string | null;
    leakedSummaryEvents: number;
    leakedProcessEvents: number;
    requestSummary: string | null;
}
export declare function assertMergeDecision(step: MutableStep, facts: MergeDecisionFacts): void;
export declare function assertActivityAudit(step: MutableStep, input: {
    fixturePath: string;
    topicId: string;
    requestId: string;
    workItemId: string | null;
}): Promise<void>;
export declare function countActivityTypes(events: readonly ActivityEvent[]): Record<string, number>;
export interface NoUndoFacts {
    resolveAfterMs: number;
    resolvedAt: string | null;
    topicId: string;
    readTopics: () => Promise<M12OverviewTopic[]>;
    readIndex: () => Promise<ProjectIndexV2 | undefined>;
    readActivity: () => Promise<{
        events: ActivityEvent[];
    }>;
}
export declare function assertNoUndoAfterWindow(step: MutableStep, facts: NoUndoFacts): Promise<void>;
export interface ReopenFacts {
    status: number;
    body: unknown;
    indexRow: TopicRecordV2 | undefined;
    activity: {
        events: ActivityEvent[];
    };
    replacedResolvedAt: string | null;
    topicId: string;
}
export declare function assertReopenFacts(step: MutableStep, facts: ReopenFacts): void;
export declare function persistEvidenceDocument(document: M12EvidenceDocument, evidenceFile: string, log?: (message: string) => void): Promise<void>;
export declare function sessionEventSummary(events: readonly SessionEvent[]): string;
export declare function readProjectIndexAt(fixturePath: string): Promise<ProjectIndexV2 | undefined>;
export declare function readActivityAt(fixturePath: string): Promise<ActivityFileRead>;
export declare function readInboxAt(fixturePath: string): Promise<InboxItem[]>;
export declare function readReviewRequestAt(fixturePath: string, requestId: string): Promise<M12ReviewRequestView | null>;
