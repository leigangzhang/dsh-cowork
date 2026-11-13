import type { InboxItem, InboxKind } from './store-schema.js';
/** Most items one delivery batch may merge into the master prompt. */
export declare const INBOX_MAX_BATCH = 5;
/** Most characters one inbox summary may carry. */
export declare const INBOX_SUMMARY_MAX_CHARS = 200;
/** Immediate retries for the `deliveredAt` write after a successful delivery. */
export declare const INBOX_MARK_ATTEMPTS = 3;
/**
 * The delivery succeeded but its `deliveredAt` mark could not be written after
 * {@link INBOX_MARK_ATTEMPTS} immediate attempts.
 *
 * `delivered` counts the items whose mark is already committed (so a retry of
 * the caller does not double-count them); `pendingIds` are the items the port
 * received but the file still lists as undelivered. They will be replayed, so
 * this path is at-least-once, never at-most-once. The residual window
 * (delivered, then the process crashes before the mark) is the same shape and
 * is scheduled for the M12 real-host assessment.
 */
export declare class InboxMarkError extends Error {
    readonly delivered: number;
    readonly pendingIds: string[];
    constructor(delivered: number, pendingIds: string[]);
}
/** The file layer this module needs: read plus the capped atomic rewrite. */
export interface InboxStore {
    readInbox(): Promise<InboxItem[]>;
    writeInbox(items: InboxItem[]): Promise<InboxItem[]>;
}
/** One event waiting for the master, before it becomes an inbox item. */
export interface InboxEvent {
    topicId: string;
    kind: InboxKind;
    summary: string;
}
/** What one delivery pass did; `failed` counts the items left for replay. */
export interface InboxDeliveryResult {
    delivered: number;
    failed: number;
}
/** The injected ports: file layer, prompt port, and clock. */
export interface InboxOptions {
    store: InboxStore;
    deliver: (summary: string) => Promise<void>;
    clock: () => Date;
}
/** Undelivered inbox items, merged and delivered in bounded batches. */
export declare class Inbox {
    private readonly store;
    private readonly deliver;
    private readonly clock;
    constructor(options: InboxOptions);
    /**
     * Turn `events` into inbox items and append them to the file. Validation
     * runs before the read, so one bad event writes nothing; the store keeps the
     * newest 50 and performs the atomic rewrite.
     */
    enqueue(events: readonly InboxEvent[]): Promise<InboxItem[]>;
    /**
     * Deliver the undelivered items, oldest first, at most
     * {@link INBOX_MAX_BATCH} per message. A failed delivery stops the pass:
     * nothing from that batch is marked, the remaining items stay for
     * {@link replay}, and `failed` counts them.
     *
     * A successful delivery is followed by the `deliveredAt` write, retried
     * immediately up to {@link INBOX_MARK_ATTEMPTS} times: a transient write
     * failure must not make the next replay deliver the same batch again. If
     * every attempt fails, {@link InboxMarkError} is thrown with the committed
     * count and the still-unmarked ids; the items stay undelivered and no event is
     * lost.
     */
    flush(): Promise<InboxDeliveryResult>;
    /** Deliver everything still undelivered; the same rules as {@link flush}. */
    replay(): Promise<InboxDeliveryResult>;
}
