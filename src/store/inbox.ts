/**
 * Master inbox (M8.3): merge pending events into bounded delivery batches and
 * hand them to an injected prompt port.
 *
 * The file layer stays in `src/store/project-store.ts`: `readInbox` validates the whole
 * document and `writeInbox` rewrites it atomically while keeping the newest 50
 * items. This module owns only the business rules — at most 5 summaries per
 * delivery, at most 200 characters per summary (never silently truncated),
 * `deliveredAt` written only after a whole batch was delivered, and a failed
 * delivery kept for replay instead of dropped.
 */
import { randomUUID } from 'node:crypto'
import { attemptDelivery } from '../domains/notices/delivery.js'
import { INBOX_KINDS } from './schema.js'
import type { InboxItem, InboxKind } from './schema.js'

/** Most items one delivery batch may merge into the master prompt. */
export const INBOX_MAX_BATCH = 5
/** Most characters one inbox summary may carry. */
export const INBOX_SUMMARY_MAX_CHARS = 200
/** Immediate retries for the `deliveredAt` write after a successful delivery. */
export const INBOX_MARK_ATTEMPTS = 3

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
export class InboxMarkError extends Error {
  readonly delivered: number
  readonly pendingIds: string[]

  constructor(delivered: number, pendingIds: string[]) {
    super(
      `inbox delivery could not be marked delivered after ${INBOX_MARK_ATTEMPTS} attempts; `
        + `${pendingIds.length} item(s) stay undelivered and will be replayed`,
    )
    this.name = 'InboxMarkError'
    this.delivered = delivered
    this.pendingIds = pendingIds
  }
}

/** The file layer this module needs: read plus the capped atomic rewrite. */
export interface InboxStore {
  readInbox(): Promise<InboxItem[]>
  writeInbox(items: InboxItem[]): Promise<InboxItem[]>
}

/** One event waiting for the master, before it becomes an inbox item. */
export interface InboxEvent {
  topicId: string
  kind: InboxKind
  summary: string
}

/** What one delivery pass did; `failed` counts the items left for replay. */
export interface InboxDeliveryResult {
  delivered: number
  failed: number
}

/** The injected ports: file layer, prompt port, and clock. */
export interface InboxOptions {
  store: InboxStore
  deliver: (summary: string) => Promise<void>
  clock: () => Date
}

/** The one line one item becomes inside a delivery batch. */
function messageLine(item: InboxItem): string {
  return `[${item.kind}] ${item.summary}`
}

/** Validate one event before anything is read or written. */
function inboxItemOf(event: InboxEvent, time: string): InboxItem {
  if (!(INBOX_KINDS as readonly string[]).includes(event.kind)) {
    throw new Error(`inbox.kind must be one of ${INBOX_KINDS.join('|')} (got ${String(event.kind)})`)
  }
  if (event.summary.trim() === '') {
    throw new Error('inbox.summary must be a non-empty string')
  }
  if (event.summary.length > INBOX_SUMMARY_MAX_CHARS) {
    throw new Error(
      `inbox.summary must be at most ${INBOX_SUMMARY_MAX_CHARS} characters (got ${event.summary.length})`,
    )
  }
  if (event.topicId.trim() === '') {
    throw new Error('inbox.topicId must be a non-empty string')
  }
  return {
    id: randomUUID(),
    time,
    topicId: event.topicId,
    kind: event.kind,
    summary: event.summary,
    deliveredAt: null,
  }
}

/** Undelivered inbox items, merged and delivered in bounded batches. */
export class Inbox {
  private readonly store: InboxStore
  private readonly deliver: (summary: string) => Promise<void>
  private readonly clock: () => Date

  constructor(options: InboxOptions) {
    this.store = options.store
    this.deliver = options.deliver
    this.clock = options.clock
  }

  /**
   * Turn `events` into inbox items and append them to the file. Validation
   * runs before the read, so one bad event writes nothing; the store keeps the
   * newest 50 and performs the atomic rewrite.
   */
  async enqueue(events: readonly InboxEvent[]): Promise<InboxItem[]> {
    const time = this.clock().toISOString()
    const created = events.map((event) => inboxItemOf(event, time))
    const current = await this.store.readInbox()
    if (created.length === 0) return current
    return this.store.writeInbox([...current, ...created])
  }

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
  async flush(): Promise<InboxDeliveryResult> {
    const pending = (await this.store.readInbox()).filter((item) => item.deliveredAt === null)
    if (pending.length === 0) return { delivered: 0, failed: 0 }

    let delivered = 0
    let next = 0
    while (next < pending.length) {
      const batch = pending.slice(next, next + INBOX_MAX_BATCH)
      // One attempt per flush: a rejected batch stays undelivered for replay,
      // and the prompt port is never asked twice for the same batch.
      const delivery = await attemptDelivery(() => this.deliver(batch.map(messageLine).join('\n')))
      if (!delivery.delivered) return { delivered, failed: pending.length - next }
      // Mark only now: a batch the port rejected stays undelivered. The write is
      // retried immediately because the delivery already happened; a lost mark
      // would deliver the same batch again on the next replay.
      const stamp = this.clock().toISOString()
      const ids = new Set(batch.map((item) => item.id))
      let marked = false
      for (let attempt = 0; attempt < INBOX_MARK_ATTEMPTS && !marked; attempt += 1) {
        try {
          const current = await this.store.readInbox()
          await this.store.writeInbox(
            current.map((item) =>
              item.deliveredAt === null && ids.has(item.id) ? { ...item, deliveredAt: stamp } : item,
            ),
          )
          marked = true
        } catch {
          // Bounded immediate retry; the next attempt re-reads the file so a
          // concurrent writer is never overwritten by a stale list.
        }
      }
      if (!marked) throw new InboxMarkError(delivered, batch.map((item) => item.id))
      delivered += batch.length
      next += batch.length
    }
    return { delivered, failed: 0 }
  }

  /** Deliver everything still undelivered; the same rules as {@link flush}. */
  async replay(): Promise<InboxDeliveryResult> {
    return this.flush()
  }
}
