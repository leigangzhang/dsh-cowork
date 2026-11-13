import type { CheckoutDeps, GitRunner } from './checkout.js';
import type { NoticeLedgerV1, TopicNoticePort } from './notices.js';
import type { InboxEvent, InboxStore } from './inbox.js';
import type { MemoryIo } from './memory.js';
import type { PresetRegistryPort } from './presets.js';
import { SessionSlice } from './session-slice.js';
import type { SessionSlicePorts } from './session-slice.js';
import type { LlmRoutingPort } from './router-model.js';
import { ProjectStore } from './store.js';
import type { ProjectIndex, ThreadRecord } from './store.js';
import type { ActivityEvent, ProjectIndexV2, ReadActivityResult, TopicRecordV2, TopicStatus } from './store-schema.js';
import type { CallerIdentity, ToolFailure } from './tool-model.js';
/** Lossless JSON value accepted by the tool result boundary. */
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
/** The third routing layer's settings as the tools receive them (M9.1/M9.2). */
export interface RoutingSettings {
    enabled: boolean;
    provider: string;
    model: string;
    effort: string;
    timeoutMs: number;
    maxTokens: number;
}
/**
 * Host services the M1 assembly needs. `agentPresets` is used by src/index.ts to
 * register the presets; the tools themselves never touch it, but it lives here
 * so the assembly has exactly one dependency bag. The lifecycle/routing fields
 * are optional so a hand-built deps object (tests, embedders) still works; the
 * defaults live in src/index.ts's normalized config and src/topic.ts.
 */
/** The host's current default model route, as `agentDefaultModel` reports it. */
export interface CurrentModelRoute {
    provider: string;
    model: string;
}
/**
 * Isolation provider used to create an isolated work item (PLAN-V0.2 §4.5).
 * Derived from the checkout module so the wire value has one home; M10
 * implements `clone` only, and a different configured value fails the
 * work-item tool with `workitem/provider-unsupported` instead of silently
 * falling back.
 */
export declare const DEFAULT_ISOLATION_PROVIDER = "clone";
/**
 * When a reviewer session is reclaimed (PLAN-V0.2 §5.4). M10 supports only
 * `after-verdict` — reclaiming a reviewer any earlier blocks its turn before a
 * verdict exists — and startup rejects every other value.
 */
export declare const DEFAULT_REVIEWER_RECLAIM = "after-verdict";
export interface CoworkToolDeps {
    sessionController: SessionSlicePorts['sessions'];
    workspaceRegistry: SessionSlicePorts['workspaces'];
    agentPresets: PresetRegistryPort;
    /** Injected clock for every timestamp the tools write. */
    clock?: () => Date;
    /** The plugin's default repository root, used only to improve an error hint. */
    resolveRepoPath?: () => string;
    /** Warning sink for non-fatal degradations the caller must still see. */
    log?: (message: string) => void;
    /** Silence after which a topic becomes idle; defaults to `DEFAULT_IDLE_AFTER_MS`. */
    idleAfterMs?: number;
    /** Silence after which a resolvable topic is resolved; defaults to `DEFAULT_RESOLVE_AFTER_MS`. */
    resolveAfterMs?: number;
    /** Work-item isolation provider; defaults to {@link DEFAULT_ISOLATION_PROVIDER}. */
    isolationProvider?: string;
    /** Reviewer reclaim mode; defaults to {@link DEFAULT_REVIEWER_RECLAIM}. */
    reviewerReclaim?: string;
    /** Third-layer model routing settings (M9.2). */
    routing?: RoutingSettings;
    /** Host LLM port for the third routing layer; absent means "unavailable". */
    llmRoutingPort?: LlmRoutingPort;
    /** The host's current default model, used when routing.provider/model are unset. */
    currentModelRoute?: () => CurrentModelRoute | null;
    /** Notice delivery runtime; absent means the ledger is written but not drained. */
    notices?: TopicNoticeRuntime;
}
/** The notice port plus the per-project kick the tools call after a write. */
export interface TopicNoticeRuntime {
    port: TopicNoticePort;
    kick(repoPath: string): void;
}
/** Longest `brief` a tool may carry into a new topic or route prompt. */
export declare const BRIEF_MAX_CHARS = 2000;
/** Cut text to at most `limit` Unicode code points without splitting a pair. */
export declare function truncateText(text: string, limit: number): string;
/** One resolved project plus the collaborators for one tool call. */
export interface ProjectRuntime {
    repoPath: string;
    store: ProjectStore;
    slice: SessionSlice;
    index: ProjectIndex;
}
/** Convert any payload to the lossless JSON value the tool boundary accepts. */
export declare function toJson(value: unknown): JsonValue;
/** Render one JSON result as model-facing text. */
export declare function renderJson(_args: unknown, value: JsonValue): Array<{
    type: 'text';
    text: string;
}>;
/**
 * The one place a production {@link ProjectStore} is constructed. The store's
 * v1→v2 migration entry archives the reviewer of an in-flight review through
 * `ProjectStoreOptions.archiveSession`; wiring the host port here is what makes
 * that a real archive instead of a recorded failure.
 */
export declare function projectStoreFor(repoPath: string, deps: CoworkToolDeps): ProjectStore;
/** The clock every write uses. */
export declare function nowOf(deps: CoworkToolDeps): Date;
/**
 * One inbox delivery pass as a value: enqueue the given events, flush
 * everything undelivered, and never throw.
 *
 * A delivery failure must not turn a successful handoff into a failed tool
 * result, so every failure mode is reported in the return value: a rejected
 * batch leaves the items undelivered (`failed`), and a batch the master already
 * received but whose `deliveredAt` could not be written is reported through
 * {@link InboxMarkError}'s committed count and pending ids. The store keeps the
 * items either way, so the next pass replays them.
 */
export interface InboxDeliveryOutcome {
    delivered: number;
    failed: number;
    error?: string;
}
/** What one {@link deliverInbox} call needs. */
export interface DeliverInboxOptions {
    store: InboxStore;
    /** Events to enqueue before flushing; omitted means "flush what is there". */
    events?: readonly InboxEvent[];
    /** Delivers one batch to the master; a throw or non-acceptance fails it. */
    deliver: (text: string) => Promise<void>;
    clock: () => Date;
}
export declare function deliverInbox(options: DeliverInboxOptions): Promise<InboxDeliveryOutcome>;
/**
 * The store operations one topic-notice write needs. `ProjectStore` satisfies
 * it; the notice helpers stay usable with a hand-built fake in tests.
 */
export interface TopicWriteStorePort extends LifecycleStorePort {
    readNotices?(): Promise<NoticeLedgerV1>;
    writeNotices?(ledger: NoticeLedgerV1): Promise<NoticeLedgerV1>;
    mutateNotices?(mutator: (ledger: NoticeLedgerV1) => NoticeLedgerV1): Promise<NoticeLedgerV1>;
    readActivity?(limit?: number): Promise<ReadActivityResult>;
}
/**
 * Append one notice-carrying activity row, write its ledger rows, and kick the
 * dispatcher. The activity row is the body the ledger points at, so a failed
 * append writes no ledger row (there would be nothing to deliver); the caller
 * still gets `false` and keeps its committed topic state.
 */
export declare function recordNoticeEvent(store: TopicWriteStorePort, event: ActivityEvent, now: Date, runtime: TopicNoticeRuntime | undefined, repoPath: string): Promise<boolean>;
/** What one shared archive write did. */
export interface ArchiveTopicOutcome {
    changed: boolean;
    topic: TopicRecordV2 | null;
    event: ActivityEvent | null;
    /** Ledger rows written for the archive notice (0 or 1: master only). */
    noticeRows: number;
}
/**
 * The shared archive core of the resolve route and `cowork_topic_resolve`:
 * clear the block and any pending authorization, mark the topic resolved by the
 * user, then record the `topic-archived` activity and its master-only notice.
 * Idempotent: an already resolved topic writes nothing and returns `changed:
 * false`. Neither the activity nor the ledger can roll the committed state back.
 */
export declare function archiveTopic(store: TopicWriteStorePort, topicId: string, options: {
    now: Date;
    repoPath: string;
    by?: 'user' | 'master';
    runtime?: TopicNoticeRuntime;
    /** Re-checked inside the lock (the resolve route's master gate). */
    assertAllowed?: (document: ProjectIndexV2) => void;
    log?: (message: string) => void;
}): Promise<ArchiveTopicOutcome>;
/** Build the session adapter over the injected host services. */
export declare function makeSlice(deps: CoworkToolDeps): SessionSlice;
/** Timeout for one git invocation; no git call is retried automatically. */
export declare const GIT_TIMEOUT_MS = 30000;
/** Upper bound on captured git output; a runaway diff should fail, not OOM. */
export declare const GIT_MAX_BUFFER: number;
/** One non-zero exit code returned by a failed spawn (git never ran). */
export declare const SPAWN_FAILED_EXIT = 1;
/**
 * Git runner for the checkout module: argument array, explicit cwd, a
 * 30-second timeout, and no shell, so a thread id or repository path can never
 * become part of a command. A non-zero exit is a value, never an exception.
 */
export declare const runGit: GitRunner;
/** The checkout module's only dependency is the git runner. */
export declare const checkoutDeps: CheckoutDeps;
/** The memory module's IO port, backed by the project store's lock and atomic write. */
export declare function memoryIo(store: ProjectStore): MemoryIo;
/** Whether a value is one of the shared failure envelopes. */
export declare function isFailure(value: unknown): value is ToolFailure;
/** Map a thrown error onto the model-facing failure envelope. */
export declare function mapError(error: unknown): ToolFailure;
/** Read the caller or produce the `exec/agent-unavailable` failure. */
export declare function callerOf(exec: unknown): CallerIdentity | ToolFailure;
/** Resolve the project that owns the caller's cwd. */
export declare function openProject(caller: CallerIdentity, deps: CoworkToolDeps): Promise<ProjectRuntime | ToolFailure>;
/** The thread fields the tools expose. */
export declare function threadView(thread: ThreadRecord): {
    threadId: string;
    subject: string;
    status: ThreadRecord['status'];
    cwd: string;
    checkoutPath: string | null;
    updatedAt: string;
    lastHandoffAt: string | null;
    reviewStatus: ThreadRecord['reviewStatus'];
    reviewedAt: string | null;
    reviewerSessionId: string | null;
    latestReviewPath: string | null;
};
/** Most characters of a topic digest a bounded tool view carries. */
export declare const TOPIC_VIEW_DIGEST_MAX_CHARS = 200;
/** The bounded topic row `cowork_topic_*` and `cowork_route` return. */
export interface TopicView {
    topicId: string;
    title: string;
    status: TopicStatus;
    blocked: boolean;
    awaitingReview: boolean;
    scope: string;
    ownedPaths: string[];
    digest: string;
    lastActiveAt: string;
    updatedAt: string;
    resolvedAt: string | null;
    resolvedBy: 'user' | 'master' | null;
}
/** Project one v2 topic onto the bounded tool view (digest cut to 200 points). */
export declare function topicView(topic: TopicRecordV2): TopicView;
/** One lifecycle transition the read point made. */
export interface LifecycleChange {
    topicId: string;
    from: TopicStatus;
    to: TopicStatus;
}
/** What one read-point evaluation did. */
export interface LifecycleEvaluation {
    /** How many topics the lock-scoped pass evaluated. */
    evaluated: number;
    /** The transitions it wrote, in document order. */
    changes: LifecycleChange[];
    /** Activity rows that could not be appended; the index write already stands. */
    activityErrors: string[];
}
/** Everything the read point needs; the defaults live at the call site. */
export interface LifecycleOptions {
    idleAfterMs: number;
    /** Deprecated and ignored; kept so older callers still typecheck. */
    resolveAfterMs?: number;
    now: Date;
    /**
     * Per-topic in-flight work-item count (M10, KI-24). It is called with the
     * document re-read inside the project lock, so a topic cannot be resolved from
     * a stale snapshot that predates a concurrent work-item creation. Absent means
     * "no work items", which keeps unit fixtures without a work-item model valid.
     */
    activeWorkItemsOf?: (topicId: string, document: ProjectIndexV2) => number;
}
/** The narrow store port the read point needs; `ProjectStore` satisfies it. */
export interface LifecycleStorePort {
    mutateIndexDocument(mutator: (document: ProjectIndexV2) => ProjectIndexV2 | null): Promise<ProjectIndexV2>;
    appendActivity(event: ActivityEvent): Promise<void>;
}
/**
 * Evaluate every topic's lifecycle inside the project lock (M9 read point).
 *
 * The mutator re-reads the document under the lock, so a concurrent write is
 * never overwritten by a stale snapshot; when no topic changed it returns
 * `null` and the store performs no write at all. A transition that lands is
 * committed atomically first, then its `status-changed` activity is appended
 * outside the lock: an activity failure is collected in `activityErrors` and
 * never rolls the index back (the M8 listener follows the same rule).
 */
export declare function evaluateProjectLifecycle(store: LifecycleStorePort, options: LifecycleOptions): Promise<LifecycleEvaluation>;
