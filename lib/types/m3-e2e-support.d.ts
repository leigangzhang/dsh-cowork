import type { M2E2EHost } from './m2-e2e-support.js';
export declare const M3_E2E_EVIDENCE_RELATIVE = ".dsh-cowork/e2e/M3_E2E.json";
export declare const M3_E2E_FIXTURE_RELATIVE = ".dsh-cowork/e2e/m3-repo";
export declare const M3_E2E_STEP_TIMEOUT_MS = 180000;
export declare const M3_E2E_POLL_MS = 500;
export declare const M3_E2E_RUN_PATH = "/dsh-cowork/e2e/m3/run";
export declare const M3_E2E_STATUS_PATH = "/dsh-cowork/e2e/m3/status";
export declare const MAX_EVENTS = 4000;
export declare const MAX_ASSISTANT_TEXT = 1000;
export declare const MAX_FILE_TEXT = 2000;
export declare const MAX_GIT_TEXT = 2000;
export declare const GIT_TIMEOUT_MS = 30000;
export declare const GIT_MAX_BUFFER: number;
export declare const REVIEW_REQUEST_TOOL = "cowork_review_request";
export declare const REVIEW_VERDICT_TOOL = "cowork_review_verdict";
export declare const MERGE_TOOL = "cowork_checkout_merge";
export declare const REVIEWER_PRESET_ID = "cowork-reviewer";
export declare const MASTER_DONE = "Reply DONE.";
export declare const THREAD_A_SUBJECT = "M3 E2E review pass";
export declare const THREAD_B_SUBJECT = "M3 E2E review repair";
export declare const FILE_A = "e2e-a.txt";
export declare const CONTENT_A = "M3-E2E-PASS";
export declare const FILE_B = "e2e-b.txt";
export declare const CONTENT_B_INITIAL = "M3-E2E-NEEDS-REPAIR";
export declare const CONTENT_B_FIXED = "M3-E2E-FIXED";
export declare const FINDING_ID = "M3-E2E-1";
export declare const M3_STEP_IDS: readonly ["setup", "thread-a-create", "thread-a-work", "review-a-request", "review-a-pass", "merge-a", "thread-b-create", "thread-b-work", "review-b-request", "review-b-needs-revision", "thread-b-repair", "review-b-request-2", "review-b-pass", "merge-b", "cleanup"];
export interface SessionEvent {
    readonly type: string;
    readonly seq: number;
    readonly data: Record<string, unknown>;
}
export type M3RunState = 'running' | 'done' | 'failed';
export type M3StepStatus = 'pending' | 'running' | 'passed' | 'failed';
export type PromptMode = 'queue' | 'steer';
export type ReviewVerdict = 'pass' | 'needs_revision' | 'reject';
export type ReviewSeverity = 'blocker' | 'high' | 'medium' | 'low';
export interface ReviewFinding {
    readonly id: string;
    readonly severity: ReviewSeverity;
    readonly problem: string;
    readonly requiredFix: string;
    readonly file?: string;
    readonly line?: number;
}
export interface M3Assertion {
    readonly name: string;
    readonly ok: boolean;
    readonly evidence: string;
}
export interface M3ToolCallEvidence {
    readonly name: string;
    readonly callId: string;
    readonly arguments: string;
}
export interface M3PromptEvidence {
    readonly sessionId: string;
    readonly role: 'master' | 'thread' | 'reviewer';
    readonly content: string;
    readonly mode: PromptMode;
    accepted: boolean;
    readonly fromSeq: number;
    assistantText: string;
    toolCalls: M3ToolCallEvidence[];
}
export interface M3StepEvidence {
    startedAt: string | null;
    endedAt: string | null;
    prompts: M3PromptEvidence[];
    observations: Record<string, unknown>;
    assertions: M3Assertion[];
    note?: string;
    error?: string;
}
export interface M3StepView {
    readonly id: string;
    readonly status: M3StepStatus;
    readonly evidence: M3StepEvidence;
}
export interface M3RunStatusView {
    readonly runId: string;
    readonly state: M3RunState;
    readonly startedAt: string;
    readonly endedAt?: string;
    readonly steps: readonly M3StepView[];
    readonly evidenceFile: string;
    readonly error?: string;
}
export interface M3EvidenceDocument {
    readonly version: 1;
    readonly runId: string;
    readonly state: M3RunState;
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
    readonly steps: readonly M3StepView[];
    readonly finalIndex: unknown;
    readonly cleanup: Record<string, unknown>;
    readonly error?: string;
}
export interface ReviewStateSnapshot {
    readonly threadId: string;
    readonly status: string;
    readonly checkoutPath: string | null;
    readonly reviewStatus: string | null;
    readonly reviewerSessionId: string | null;
    readonly reviewedAt: string | null;
    readonly latestReviewPath: string | null;
}
export interface M3E2EConfig {
    readonly repoPath: string;
    readonly promptTimeoutMs: number;
    readonly pluginName: string;
    readonly pluginVersion: string;
    readonly log?: (message: string) => void;
}
export type M3E2EHost = M2E2EHost;
export interface ReviewPromptInput {
    readonly threadId: string;
    readonly subject: string;
    readonly repoPath: string;
    readonly checkoutPath: string;
    readonly fileName: string;
    readonly verificationCommand: string;
}
export interface NeedsRevisionPromptInput extends ReviewPromptInput {
    readonly finding: ReviewFinding;
}
export interface RepairPromptInput {
    readonly threadId: string;
    readonly checkoutPath: string;
    readonly fileName: string;
    readonly fixedContent: string;
    readonly finding: ReviewFinding;
}
export declare const REVIEW_FINDING: ReviewFinding;
export interface HandoffView {
    readonly filePath: string;
    readonly record: {
        readonly threadId: string;
        readonly status: string;
        readonly summary: string;
        readonly createdAt: string;
        readonly [key: string]: unknown;
    };
}
export interface ReviewFileEvidence {
    readonly filePath: string;
    readonly text: string;
    readonly record?: Record<string, unknown>;
}
export interface IndexThreadView {
    readonly threadId: string;
    readonly subject?: string;
    readonly status: string;
    readonly checkoutPath: string | null;
    readonly reviewStatus?: unknown;
    readonly reviewerSessionId?: unknown;
    readonly reviewedAt?: unknown;
    readonly latestReviewPath?: unknown;
    readonly [key: string]: unknown;
}
export interface IndexView {
    readonly masterSessionId: string;
    readonly threads: readonly IndexThreadView[];
    readonly [key: string]: unknown;
}
export interface MutableStep {
    readonly id: string;
    status: M3StepStatus;
    readonly evidence: M3StepEvidence;
}
export interface MutableRun {
    readonly runId: string;
    state: M3RunState;
    readonly startedAt: string;
    endedAt?: string;
    readonly steps: MutableStep[];
    error?: string;
    finalIndex: unknown;
    cleanup: Record<string, unknown>;
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
export declare function stepFailureState(stepId: string, error: unknown): {
    state: 'failed';
    error: string;
};
/**
 * Whether the run-end `finally` must delete the fixture directory. A run that
 * is still `running` keeps its fixture; `done` and `failed` both drop it, so a
 * failed run cannot leave `.dsh-cowork/e2e/m3-repo/README.md` behind for
 * `npm run check` to scan (KI-13). Pure by design so the three states stay
 * testable without a host and the policy lives in one place.
 */
export declare function shouldRemoveFixture(state: M3RunState): boolean;
export declare function reviewPreamble(input: ReviewPromptInput, command: string): string[];
export declare function buildReviewerPassPrompt(input: ReviewPromptInput): string;
export declare function buildReviewerNeedsRevisionPrompt(input: NeedsRevisionPromptInput): string;
export declare function buildRepairPrompt(input: RepairPromptInput): string;
export declare function reviewStateOf(index: IndexView | undefined | null, threadId: string): ReviewStateSnapshot | null;
/** What the runner must do with the reviewer's deterministic instruction. */
export interface ReviewVerdictPlan {
    readonly action: 'steer' | 'skip' | 'fail';
    readonly mode: PromptMode | null;
    readonly reason: string;
}
/**
 * Decide the verdict delivery mode from the index alone: skip when the reviewer
 * already produced the expected verdict, fail when it produced another terminal
 * verdict (or the thread left awaiting_review), else steer the instruction now.
 */
export declare function planReviewVerdict(state: ReviewStateSnapshot | null, verdict: ReviewVerdict, expectedStatus: string): ReviewVerdictPlan;
export declare function assertionForReview(check: string, expected: unknown, actual: unknown): M3Assertion;
/** How the runner asks the master for a review without waiting for it to go idle. */
export interface ReviewRequestPlan {
    readonly action: 'steer' | 'already-pending';
    readonly reason: string;
}
/**
 * Decide how to request a review. A handoff wakes the master, and that reaction
 * turn can run far longer than a step timeout, so the runner never waits for the
 * master to go idle: it adopts a review the master already requested when the
 * index shows a pending one with a fresh reviewer, and otherwise steers the
 * instruction into the master's current turn.
 */
export declare function planReviewRequest(input: {
    threadId: string;
    masterSessionId: string;
    previousReviewerSessionId: string | null;
    state: ReviewStateSnapshot | null;
}): ReviewRequestPlan;
/** How the runner delivers the merge instruction. */
export interface MergePromptPlan {
    readonly action: 'skip' | 'steer';
    readonly reason: string;
}
/**
 * Merge is never gated on a long master-idle wait: when the target state is
 * already reached the step passes idempotently, otherwise the merge
 * instruction is steered into whatever turn the master is in.
 */
export declare function planMergePrompt(alreadyDone: boolean): MergePromptPlan;
export declare function clip(text: string, limit: number): string;
export declare function isoNow(): string;
export declare function messageOf(error: unknown): string;
export declare function sleep(ms: number): Promise<void>;
export declare function asRecord(value: unknown): Record<string, unknown> | undefined;
export declare function stringOrNull(value: unknown): string | null;
export declare function stableJson(value: unknown): string;
export declare function obs(step: MutableStep, patch: Record<string, unknown>): void;
export declare function readTextIfPresent(path: string): Promise<string | undefined>;
/**
 * Parse the project index; a half-written file during a poll reports absence.
 *
 * v1 (`threads[]`) is returned unchanged; v2 (`topics[]`) is validated with the
 * store schema and projected through `legacyViewOf`, so the E2E assertions read
 * the same compatibility view the tools do. An invalid or unknown-state
 * document is absent.
 */
export declare function parseIndex(text: string): IndexView | undefined;
export declare function readHandoffs(fixturePath: string): Promise<HandoffView[]>;
export declare function contentText(message: unknown): string;
export declare function lastSeq(events: readonly SessionEvent[]): number;
export declare function assistantTextSince(events: readonly SessionEvent[], fromSeq: number): string;
export declare function toolCallsSince(events: readonly SessionEvent[], fromSeq: number, name?: string): M3ToolCallEvidence[];
export declare function runGit(args: readonly string[], cwd: string): Promise<GitOutcome>;
export declare function writeEvidenceAtomic(file: string, content: string): Promise<void>;
export declare function isStrictlyInside(parent: string, child: string): boolean;
export declare function recordCheck(step: MutableStep, name: string, ok: boolean, evidence: unknown): void;
export declare function runView(run: MutableRun, evidenceFile: string): M3RunStatusView;
export interface ThreadRef {
    readonly threadId: string;
    readonly checkoutPath: string;
}
