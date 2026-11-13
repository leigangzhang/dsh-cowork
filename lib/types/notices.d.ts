/**
 * Topic notices: the per-event 1:1 notification model of the topic page.
 *
 * One business event (assignment / report / proposal / authorization / archive)
 * becomes exactly one notice per target — the master session and, except for
 * archiving, the topic session. The event row in `activity.jsonl` is the only
 * source of the text: it carries a bounded descriptor in `details.notice`, and
 * {@link noticeFor} renders the per-target copy as a pure function. The ledger
 * (`notices.json`, v1) records delivery state only, keyed by
 * `(noticeId, target)` with `noticeId = activity.eventId`, so a replayed event
 * can never produce a second row.
 *
 * `TopicNoticePort` is the host side. DSH 0.2.1-rc.2 has no notice channel (A2
 * is unavailable), so {@link NoopTopicNoticePort} reports
 * `capabilities().supported === false` and the dispatcher leaves every row
 * `pending`: the ledger never claims a delivery that did not happen. When the
 * host ships the notice channel, only this file's port adapter needs replacing.
 *
 * The dispatcher is deliberately non-blocking: tools append the event and the
 * ledger rows, kick it, and return. A delivery failure is recorded on the row
 * (bounded retries, exponential backoff) and never rolls the topic state back.
 */
import { type NoticeKind } from './notice-contract.js';
import type { ActivityEvent, ProjectIndexV2, ReadActivityResult } from './store-schema.js';
/** Default plugin id stamped on every notice. */
export declare const DEFAULT_NOTICE_PLUGIN_ID = "@dsh-external/dsh-cowork";
/** Every target a notice can be addressed to. */
export declare const NOTICE_TARGETS: readonly ["master", "topic"];
/** One side of the 1:1 delivery: the master session or the topic session. */
export type NoticeTarget = (typeof NOTICE_TARGETS)[number];
/** The notice kinds the topic page emits, re-exported from the shared vocabulary. */
export { NOTICE_KINDS } from './notice-contract.js';
export type { NoticeKind } from './notice-contract.js';
/** The decision state a notice carries. */
export declare const NOTICE_STATUSES: readonly ["pending", "allowed", "denied", "void"];
/** Decision state of one notice. */
export type NoticeStatus = (typeof NOTICE_STATUSES)[number];
/** Actions a rendered notice may offer. */
export declare const NOTICE_ACTIONS: readonly ["allow", "deny", "open-topic", "open-work-item"];
/** One offered notice action. */
export type NoticeAction = (typeof NOTICE_ACTIONS)[number];
/** Delivery states the ledger records; `void` means the event was withdrawn. */
export declare const NOTICE_DELIVERY_STATUSES: readonly ["pending", "delivered", "failed", "void"];
/** Delivery state of one ledger row. */
export type NoticeDeliveryStatus = (typeof NOTICE_DELIVERY_STATUSES)[number];
/** Version of `notices.json` this module writes. */
export declare const NOTICE_LEDGER_VERSION = 1;
/** Most rows the ledger keeps; the oldest-by-update rows are dropped first. */
export declare const NOTICE_LEDGER_MAX_RECORDS = 200;
/** Most delivery attempts one row gets. */
export declare const NOTICE_MAX_ATTEMPTS = 5;
/** Backoff between failed attempts: 1 s, 5 s, 30 s, 30 s (max 5 attempts). */
export declare const NOTICE_RETRY_DELAYS_MS: readonly [1000, 5000, 30000, 30000];
/** Longest notice title, in code points. */
export declare const NOTICE_TITLE_MAX_CHARS = 80;
/** Longest notice summary, in code points. */
export declare const NOTICE_SUMMARY_MAX_CHARS = 200;
/** One rendered notice as the port (and a future client card) sees it. */
export interface TopicNotice {
    noticeId: string;
    pluginId: string;
    topicId: string;
    kind: NoticeKind;
    title: string;
    summary: string;
    status: NoticeStatus;
    actions: NoticeAction[];
    createdAt: string;
    updatedAt: string;
}
/** One row of the delivery ledger (`notices.json` v1). */
export interface NoticeLedgerRecord {
    /** `activity.eventId` of the event that produced the notice. */
    noticeId: string;
    topicId: string;
    target: NoticeTarget;
    status: NoticeDeliveryStatus;
    attempts: number;
    lastError: string | null;
    updatedAt: string;
}
/** The delivery ledger document. */
export interface NoticeLedgerV1 {
    version: 1;
    notices: NoticeLedgerRecord[];
}
/** What one port implementation can do. */
export interface TopicNoticeCapabilities {
    /** Whether the host can display a notice at all. */
    supported: boolean;
    /** Whether a rendered card can offer action buttons. */
    actions: boolean;
    /** Whether an existing notice can be updated in place (authorization outcome). */
    updates: boolean;
}
/** The fields an authorization outcome may patch on an existing notice. */
export interface TopicNoticePatch {
    status?: NoticeStatus;
    summary?: string;
    updatedAt?: string;
}
/**
 * The host notice port. `append` is idempotent by `noticeId`; a host that
 * already has the notice answers `duplicate` so a replay cannot double-post.
 */
export interface TopicNoticePort {
    capabilities(): TopicNoticeCapabilities;
    append(sessionId: string, notice: TopicNotice): Promise<'delivered' | 'duplicate'>;
    update(sessionId: string, noticeId: string, patch: TopicNoticePatch): Promise<'delivered' | 'duplicate'>;
}
/** The bounded descriptor an activity row embeds in `details.notice`. */
export interface ActivityNoticeDescriptor {
    kind: NoticeKind;
    title: string;
    summary: string;
    targets: readonly NoticeTarget[];
    actions?: readonly NoticeAction[];
    status?: NoticeStatus;
}
/** Cut text to at most `limit` code points without splitting a pair. */
export declare function clipNoticeText(text: string, limit: number): string;
/** Build one bounded descriptor from already-validated input. */
export declare function noticeDescriptor(input: {
    kind: NoticeKind;
    title: string;
    summary: string;
    targets: readonly NoticeTarget[];
    actions?: readonly NoticeAction[];
    status?: NoticeStatus;
}): ActivityNoticeDescriptor;
/** Read the descriptor out of one event, or null when it carries none. */
export declare function noticeDescriptorOf(event: ActivityEvent): ActivityNoticeDescriptor | null;
/** The notice id an event carries: `details.noticeId` for an update, else its own id. */
export declare function noticeIdOf(event: ActivityEvent): string;
/**
 * Render the notice one event gives one target, or null when that target is not
 * addressed. Pure and total: a malformed descriptor yields null, never a throw.
 * The archive event addresses the master only, which is why its topic copy is
 * unreachable.
 */
export declare function noticeFor(event: ActivityEvent, target: NoticeTarget, options?: {
    pluginId?: string;
}): TopicNotice | null;
/** Every notice one event produces, in target order. */
export declare function noticesOf(event: ActivityEvent, options?: {
    pluginId?: string;
}): TopicNotice[];
/** An empty ledger. */
export declare function emptyNoticeLedger(): NoticeLedgerV1;
/** Schema problems of a whole notice ledger. An empty array means it is valid. */
export declare function noticeLedgerProblems(ledger: unknown): string[];
/**
 * Keep the newest {@link NOTICE_LEDGER_MAX_RECORDS} rows by `updatedAt`, ties
 * resolved by the input order. The oldest rows are dropped first.
 */
export declare function trimNoticeLedger(records: readonly NoticeLedgerRecord[]): NoticeLedgerRecord[];
/** The narrow store port the ledger writer needs; `ProjectStore` satisfies it. */
export interface NoticeLedgerStorePort {
    readNotices(): Promise<NoticeLedgerV1>;
    writeNotices(ledger: NoticeLedgerV1): Promise<NoticeLedgerV1>;
    /**
     * Locked read-modify-write. `ProjectStore` implements it; a caller that has
     * it must use it, because read + write without one lock loses concurrent rows.
     */
    mutateNotices?(mutator: (ledger: NoticeLedgerV1) => NoticeLedgerV1): Promise<NoticeLedgerV1>;
}
/** One parse of `notices.json`: the value, or the JSON/validation failure. */
export interface ParsedNoticeLedger {
    ledger: NoticeLedgerV1 | null;
    jsonError: string | null;
    problems: string[];
}
/** Parse one ledger document without touching the file system. */
export declare function parseNoticeLedgerText(text: string): ParsedNoticeLedger;
/** Validate a ledger before writing it and trim it to its newest rows. */
export declare function prepareNoticeLedger(ledger: unknown): {
    ledger: NoticeLedgerV1 | null;
    problems: string[];
};
/**
 * Append one ledger row per target of `event`. Upserts by
 * `(noticeId, target)`, so replaying the same event never grows the ledger.
 * `authorization-resolved` is an update of the original notice, not a new one:
 * it writes no row (the port is patched instead), which is what keeps the
 * 1:1 rule intact across the decision.
 */
export declare function recordNoticesForEvent(store: NoticeLedgerStorePort, event: ActivityEvent, now: Date, pluginId?: string): Promise<NoticeLedgerRecord[]>;
/**
 * Withdraw the notice of a pending authorization because the topic was
 * archived: the request can no longer be decided, so its ledger rows become
 * `void` and the master-facing listing stops showing a pending request. A host
 * channel that already delivered the card (A2) is patched to `void` on the same
 * noticeId — the archive must not leave a live allow/deny button behind.
 */
export declare function findAuthorizationNoticeId(store: {
    readActivity?(limit?: number): Promise<ReadActivityResult>;
}, topicId: string, requestId: string): Promise<string | null>;
export declare function voidAuthorizationNotice(input: {
    store: NoticeLedgerStorePort & {
        readActivity?(limit?: number): Promise<ReadActivityResult>;
    };
    document: ProjectIndexV2;
    topicId: string;
    requestId: string;
    now: Date;
    port?: TopicNoticePort;
    /** Known id, when the caller already found it for the archive event. */
    noticeId?: string | null;
    pluginId?: string;
}): Promise<{
    noticeId: string | null;
    voided: number;
}>;
/** What one `updateAuthorizationNotice` call reports. */
export type NoticeUpdateOutcome = 'updated' | 'unsupported' | 'failed';
/**
 * Patch the original authorization notice on both targets after a decision.
 * Never throws: an unsupported host (B) and a failed update are both values, so
 * the route can keep the committed decision and log the delivery problem.
 */
export declare function updateAuthorizationNotice(input: {
    port: TopicNoticePort;
    document: ProjectIndexV2;
    topicId: string;
    noticeId: string;
    decision: 'allow' | 'deny';
    now: Date;
    pluginId?: string;
}): Promise<NoticeUpdateOutcome>;
/**
 * The B-mode port: DSH 0.2.1-rc.2 exposes no notice channel. It reports
 * `supported: false` and refuses to pretend; the dispatcher never calls it
 * while unsupported, so the ledger stays `pending`.
 */
export declare class NoopTopicNoticePort implements TopicNoticePort {
    capabilities(): TopicNoticeCapabilities;
    append(): Promise<'delivered' | 'duplicate'>;
    update(): Promise<'delivered' | 'duplicate'>;
}
/**
 * A fixture port for development and tests: it records what a delivery would
 * have sent and still reports `supported: false`, so it exercises the B path
 * (ledger stays pending) without a host.
 */
export declare class FixtureTopicNoticePort implements TopicNoticePort {
    readonly appended: Array<{
        sessionId: string;
        notice: TopicNotice;
    }>;
    readonly updated: Array<{
        sessionId: string;
        noticeId: string;
        patch: TopicNoticePatch;
    }>;
    capabilities(): TopicNoticeCapabilities;
    append(sessionId: string, notice: TopicNotice): Promise<'delivered' | 'duplicate'>;
    update(sessionId: string, noticeId: string, patch: TopicNoticePatch): Promise<'delivered' | 'duplicate'>;
}
/** The store operations the dispatcher needs; `ProjectStore` satisfies it. */
export interface NoticeDispatchStorePort extends NoticeLedgerStorePort {
    readActivity(limit?: number): Promise<ReadActivityResult>;
    readIndexDocument(): Promise<ProjectIndexV2>;
}
/** Everything the dispatcher needs; the host wires the production values. */
export interface TopicNoticeDispatcherOptions {
    storeFor(repoPath: string): NoticeDispatchStorePort;
    port: TopicNoticePort;
    clock(): Date;
    log?(message: string): void;
    /** Injected backoff so a test does not wait 66 s. */
    sleep?(ms: number): Promise<void>;
    pluginId?: string;
    /** Delivery attempts per row; defaults to {@link NOTICE_MAX_ATTEMPTS}. */
    maxAttempts?: number;
}
/**
 * Deliver pending notices per project, one event at a time.
 *
 * `kick(repoPath)` schedules a drain and returns immediately; drains for one
 * project are chained so events are delivered in ledger order. A drain never
 * throws: a failed read or write is logged, and a failed delivery is recorded on
 * the row. Replaying is safe: delivered rows are skipped and the port answers
 * `duplicate` by `noticeId`, so an at-least-once host cannot double-post.
 */
export declare class TopicNoticeDispatcher {
    private readonly options;
    private readonly chains;
    private readonly timers;
    private disposed;
    constructor(options: TopicNoticeDispatcherOptions);
    /** Schedule one drain for `repoPath`; never throws into the caller. */
    kick(repoPath: string): void;
    /** Queue one drain behind the previous one for the same project and await it. */
    drain(repoPath: string): Promise<void>;
    /** How many projects currently have a drain in flight or queued. */
    pending(): number;
    /** Stop scheduling and clear any backoff timer this dispatcher owns. */
    dispose(): void;
    private run;
    /**
     * One row's delivery loop: up to `maxAttempts` appends with the documented
     * backoff. `true` means delivered (or the host already had it); `false` means
     * the row exhausted its attempts and stays on the ledger as `failed`.
     */
    private deliver;
    private wait;
    private log;
}
/** One notice row as the master-facing `cowork_notices` tool reports it. */
export interface NoticeSummary {
    noticeId: string;
    topicId: string;
    kind: NoticeKind;
    title: string;
    summary: string;
    status: NoticeStatus;
    actions: NoticeAction[];
    createdAt: string;
    updatedAt: string;
    delivery: {
        status: NoticeDeliveryStatus;
        attempts: number;
        lastError: string | null;
    };
    /** Proposal id carried by a `decision-proposed` event. */
    proposalId?: string;
    /** Repo-relative proposal file path, when the event carries it. */
    proposalPath?: string;
}
/**
 * Project the activity tail onto one row per `(noticeId, target)`, newest event
 * winning. An `authorization-resolved` row points at the original notice id, so
 * the decision overwrites the pending row instead of adding a second one; the
 * ledger supplies the delivery state of the same id. Pure: no I/O, no clock.
 */
export declare function noticeSummaries(events: readonly ActivityEvent[], ledger: NoticeLedgerV1, options?: {
    pluginId?: string;
    target?: NoticeTarget;
}): NoticeSummary[];
