/** Evidence file, relative to the plugin's default repository root. */
export declare const M2_E2E_EVIDENCE_RELATIVE = ".dsh-cowork/e2e/M2_E2E.json";
/** Throwaway project root, relative to the plugin's default repository root. */
export declare const M2_E2E_FIXTURE_RELATIVE = ".dsh-cowork/e2e/m2-repo";
/** Upper bound for one E2E step (including its polling). */
export declare const M2_E2E_STEP_TIMEOUT_MS = 180000;
/** Poll interval; state is polled, never replaced by a fixed sleep. */
export declare const POLL_MS = 500;
/** Per-session event buffer bound. */
export declare const MAX_EVENTS = 4000;
/** Clipping bounds for evidence text. */
export declare const MAX_ASSISTANT_TEXT = 1000;
export declare const MAX_TOOL_ARGUMENTS = 4000;
export declare const MAX_TOOL_TEXT = 4000;
export declare const MAX_FILE_TEXT = 2000;
export declare const MAX_GIT_TEXT = 2000;
export declare const MAX_FIELD_TEXT = 3000;
/** One session event as this driver consumes it. */
export interface M2SessionEvent {
    readonly type: string;
    readonly seq: number;
    readonly time: number;
    readonly data: Record<string, unknown>;
}
/** One session row returned by `sessionController.list`. */
export interface M2SessionRow {
    readonly sessionId: string;
    readonly cwd?: string;
    readonly running: boolean;
}
/** One session header returned by `sessionController.inspect`. */
export interface M2SessionHeader {
    readonly id: string;
    readonly cwd?: string;
    readonly agentPreset?: string;
}
/** One workspace record as this driver consumes it. */
export interface M2Workspace {
    readonly id: string;
    readonly path: string;
    readonly sessionIds: readonly string[];
}
/** Host services the driver calls; structural so the module stays testable. */
export interface M2E2EHost {
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
            mode: 'queue' | 'steer';
            content: ReadonlyArray<{
                type: 'text';
                text: string;
            }>;
        }, signal?: AbortSignal): Promise<{
            accepted: boolean;
        }>;
        list(request?: unknown, signal?: AbortSignal): Promise<{
            items: readonly M2SessionRow[];
        }>;
        inspect(sessionId: string, signal?: AbortSignal): Promise<{
            meta: M2SessionHeader;
        }>;
    };
    readonly workspaceRegistry: {
        resolveByPath(path: string): Promise<M2Workspace | undefined>;
        delete(id: string): Promise<boolean>;
        archiveSession(sessionId: string, options?: {
            stopActivity?: boolean;
        }): Promise<void>;
    };
    on(name: 'session/event', listener: (session: {
        id: string;
    }, event: M2SessionEvent) => void): () => void;
}
/** Construction knobs the plugin supplies. */
export interface M2E2EConfig {
    /** The plugin's default repository root; the fixture and evidence live under it. */
    readonly repoPath: string;
    /** Prompt admission timeout, reused from the plugin config. */
    readonly promptTimeoutMs: number;
    /** Plugin identity recorded in the evidence document. */
    readonly pluginName: string;
    readonly pluginVersion: string;
    readonly log?: (message: string) => void;
}
/** Run lifecycle. */
export type M2RunState = 'running' | 'done' | 'failed';
/** Step lifecycle. */
export type M2StepStatus = 'pending' | 'running' | 'passed' | 'failed';
/** One assertion with its observed value. */
export interface M2Assertion {
    readonly check: string;
    readonly passed: boolean;
    readonly detail: string;
}
/** One tool invocation observed in a session event stream. */
export interface M2ToolCallEvidence {
    readonly name: string;
    readonly callId: string;
    readonly arguments: string;
    resultText: string | null;
    isError: boolean | null;
    errorCode?: string;
}
/** One prompt plus what the session did in response to it. */
export interface M2PromptEvidence {
    readonly sessionId: string;
    readonly role: 'master' | 'thread';
    readonly text: string;
    accepted: boolean;
    readonly fromSeq: number;
    assistantText: string;
    toolCalls: M2ToolCallEvidence[];
}
/** Everything one step recorded. */
export interface M2StepEvidence {
    startedAt: string | null;
    endedAt: string | null;
    prompts: M2PromptEvidence[];
    observations: Record<string, unknown>;
    assertions: M2Assertion[];
    note?: string;
    error?: string;
}
/** One step view returned by the status route. */
export interface M2StepView {
    readonly id: string;
    readonly status: M2StepStatus;
    readonly evidence: M2StepEvidence;
}
/** One run view returned by the status route and stored in the evidence file. */
export interface M2E2EStatusView {
    readonly runId: string;
    readonly state: M2RunState;
    readonly startedAt: string;
    readonly endedAt?: string;
    readonly steps: readonly M2StepView[];
    readonly evidenceFile: string;
    readonly error?: string;
}
/**
 * Evidence document written at every step boundary and at the end.
 *
 * `host` intentionally has no hostname: the document is committed and shared,
 * and the machine name is neither needed to reproduce a run nor safe to
 * publish. Everything here is host identity by role, not by machine.
 */
export interface M2E2EEvidenceDocument {
    readonly version: 1;
    readonly runId: string;
    readonly state: M2RunState;
    readonly startedAt: string;
    readonly endedAt: string | null;
    readonly host: {
        readonly plugin: string;
        readonly pluginVersion: string;
        readonly node: string;
        readonly platform: string;
        readonly arch: string;
        readonly repoPath: string;
    };
    readonly steps: readonly M2StepView[];
    readonly finalIndex: unknown;
    readonly cleanup: Record<string, unknown>;
    readonly error?: string;
}
/** A thread record as the index stores it. */
export interface IndexThread {
    readonly threadId: string;
    readonly subject: string;
    readonly status: string;
    readonly checkoutPath: string | null;
    readonly [key: string]: unknown;
}
/** The slice of the project index this driver reads. */
export interface IndexView {
    readonly masterSessionId: string;
    readonly threads: readonly IndexThread[];
    readonly [key: string]: unknown;
}
/** One handoff file read from disk. */
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
export interface MutableStep {
    readonly id: string;
    status: M2StepStatus;
    readonly evidence: M2StepEvidence;
}
export interface MutableRun {
    readonly runId: string;
    state: M2RunState;
    readonly startedAt: string;
    endedAt?: string;
    readonly steps: MutableStep[];
    error?: string;
    finalIndex: unknown;
    cleanup: Record<string, unknown>;
}
/** Git result used by observed helper calls. */
export interface GitOutcome {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}
/** The ordered steps; a failure stops the run and leaves later steps pending. */
export declare const STEP_IDS: readonly ["setup", "memory-write", "isolated-thread", "thread-work", "memory-visible", "memory-cross-thread", "merge-success", "conflict-thread", "conflict-merge", "conflict-retry", "cleanup"];
export declare const MERGE_TOOL = "cowork_checkout_merge";
export declare const MASTER_DONE = "Reply DONE.";
export declare const FIXTURE_SUBJECT_1 = "E2E \u9694\u79BB\u7EBF\u7A0B";
export declare const FIXTURE_SUBJECT_2 = "E2E \u51B2\u7A81\u7EBF\u7A0B";
/** Title of the constraint the E2E writes; the only memory hint a prompt gets. */
export declare const MEMORY_TITLE = "E2E \u7EA6\u675F";
/**
 * Text of the E2E constraint.
 *
 * The `M2-E2E-CONSTRAINT-7F3A` nonce makes the value unguessable: a model that
 * never saw the memory block cannot reproduce it from prior knowledge, so a
 * verbatim reply is evidence that the block reached the system prompt. It keeps
 * 提交信息 so the cross-thread memory search query still matches.
 */
export declare const MEMORY_TEXT = "M2-E2E-CONSTRAINT-7F3A: \u6240\u6709\u63D0\u4EA4\u4FE1\u606F\u7528\u4E2D\u6587";
/**
 * Prompt for the model-visible memory step.
 *
 * It names only the constraint's title and where it lives (the system prompt).
 * It must never interpolate {@link MEMORY_TEXT} or any other expected reply: a
 * prompt carrying the expected text would let a model copy it back without the
 * memory ever reaching its system prompt, and the step would prove nothing.
 */
export declare function memoryVisiblePrompt(memoryTitle?: string): string;
export declare function messageOf(error: unknown): string;
export declare function clip(text: string, limit: number): string;
export declare function isoNow(): string;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function asRecord(value: unknown): Record<string, unknown> | undefined;
export declare function sleep(ms: number): Promise<void>;
/** Pad a path check with a trailing separator so `/a/b` never matches `/a/bc`. */
export declare function isStrictlyInside(parent: string, child: string): boolean;
/** Read a UTF-8 file, treating a missing path as `undefined` and other errors as failures. */
export declare function readTextIfPresent(path: string): Promise<string | undefined>;
/** Model-facing tool result text: text blocks joined, other blocks JSON-serialized. */
export declare function contentText(message: unknown): string;
/** git with an argument array, an explicit cwd, and a timeout; non-zero exits are values. */
export declare function runGit(args: readonly string[], cwd: string): Promise<GitOutcome>;
/** One assertion computed from a model-visible fact, before it is recorded. */
export interface M2MemoryVisibilityCheck {
    readonly check: string;
    readonly passed: boolean;
    readonly detail: string;
}
/**
 * The two assertions of the model-visible memory step.
 *
 * Pure on purpose: the step itself needs a live host and a live model, so the
 * "the reply contains the constraint and no tool was called" rule is kept here
 * where `node --test` can prove both the passing and the failing shape.
 */
export declare function memoryVisibilityChecks(assistantText: string, toolCallCount: number, memoryText?: string): M2MemoryVisibilityCheck[];
/**
 * Serialise one run into the status view returned by the status route.
 *
 * The run is deep-cloned through JSON so a caller cannot mutate the runner's
 * in-memory state, and so the view matches exactly what a reload would read
 * back from the evidence file.
 */
export declare function statusView(run: MutableRun, evidenceFile: string): M2E2EStatusView;
/** Host identity recorded in the evidence document; no hostname by design. */
export interface M2E2EEvidenceHost {
    readonly pluginName: string;
    readonly pluginVersion: string;
    readonly repoPath: string;
}
/** Build the evidence document for one run; pure apart from process identity. */
export declare function evidenceDocument(host: M2E2EEvidenceHost, run: MutableRun): M2E2EEvidenceDocument;
/** Writes text to a path atomically; injected so this module needs no plugin import. */
export type AtomicWriter = (path: string, content: string) => Promise<void>;
/**
 * Persist one evidence document. A failure is logged, not thrown: the live
 * in-memory run stays authoritative, and the file only serves a reloaded host.
 */
export declare function persistEvidence(document: M2E2EEvidenceDocument, evidenceFile: string, writeAtomic: AtomicWriter, log?: (message: string) => void): Promise<void>;
/** Record one assertion; a failed assertion stops the step with its value. */
export declare function recordAssertion(step: MutableStep, check: string, passed: boolean, detail: unknown): void;
/** Run git and record the command, cwd, exit code, and clipped output in the step. */
export declare function observeGit(step: MutableStep, args: readonly string[], cwd: string): Promise<GitOutcome>;
/** Like {@link observeGit}, but a non-zero exit fails the step under `label`. */
export declare function gitOkObserved(step: MutableStep, args: readonly string[], cwd: string, label: string): Promise<GitOutcome>;
/** Read a file and record existence plus clipped content in the step evidence. */
export declare function readObserved(step: MutableStep, path: string): Promise<string | undefined>;
/** The durable state a step boundary records; index may be absent mid-write. */
export declare function stateSnapshot(index: IndexView | undefined, fixturePath: string): Record<string, unknown>;
/** Sequence of the newest buffered event for one session (0 when empty). */
export declare function lastSeq(events: readonly M2SessionEvent[]): number;
/** Assistant text emitted after `fromSeq`, clipped for evidence. */
export declare function assistantTextSince(events: readonly M2SessionEvent[], fromSeq: number): string;
/** Tool calls (optionally one tool) after `fromSeq`, paired with their results. */
export declare function toolCallsSince(events: readonly M2SessionEvent[], fromSeq: number, name?: string): M2ToolCallEvidence[];
/**
 * Parse the project index; a half-written file during a poll reports absence.
 *
 * v1 (`threads[]`) is returned unchanged — these drivers were written against
 * the thread shape. v2 (`topics[]`) is validated with the store schema and
 * projected through `legacyViewOf`, so the E2E assertions cannot drift from the
 * store's own status semantics. An invalid or unknown-state document is absent.
 */
export declare function parseIndex(text: string): IndexView | undefined;
/** Read every handoff file under the fixture's project directory, sorted by name. */
export declare function readHandoffs(fixturePath: string): Promise<HandoffView[]>;
