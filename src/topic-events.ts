/**
 * Topic lifecycle driven by the host session event stream (M8.2).
 *
 * The host delivers every session event as `(session, event)`. Only two matter
 * here: `turn/end` refreshes `lastActiveAt` (and pulls `idle` back to
 * `active`), and `user/message` reopens a `resolved` topic because its owner
 * returned to it. Everything is injected — event source, repo resolution,
 * store, clock, log — so the rules run without a host.
 *
 * Every write goes through the store's lock-scoped `mutateIndexDocument`, which
 * re-reads inside the lock; the mutator re-checks the topic and returns `null`
 * to abandon a marker another writer already made (automatic marks have no
 * undo). A listener must never reject into the host bus: a failed read,
 * mutation, or activity append is reported through `log` only, and an activity
 * failure does not roll back a reopen that is already on disk.
 *
 * The event type is the only input that classifies an event: the M6 probe found
 * the `user/message` fields at the top level and the `userMessageSeen` helper
 * unreliable, so nothing here inspects message payloads.
 */
import { randomUUID } from 'node:crypto'
import { noteTopicActivity, reopenResolvedTopic } from './topic.js'
import type { ActivityEvent, ProjectIndexV2, TopicRecordV2 } from './store-schema.js'

/** The host Session as far as this module reads it. */
export interface TopicEventSession {
  readonly id: string
  readonly header?: { readonly cwd?: string }
}

/** The host session event as far as this module reads it. */
export interface TopicEventLike {
  readonly type: string
}

/** The store operations the listener needs; `ProjectStore` satisfies it. */
export interface TopicEventStorePort {
  readIndexDocument(): Promise<ProjectIndexV2>
  mutateIndexDocument(mutator: (document: ProjectIndexV2) => ProjectIndexV2 | null): Promise<ProjectIndexV2>
  appendActivity(event: ActivityEvent): Promise<void>
}

/** Everything the listener touches, injected so it can run host-free. */
export interface TopicEventsPorts {
  onSessionEvent(listener: (session: TopicEventSession, event: TopicEventLike) => void): () => void
  resolveRepoPath(session: TopicEventSession): Promise<string | null> | string | null
  storeFor(repoPath: string): TopicEventStorePort
  clock(): Date
  log?(message: string): void
}

/** Event type the host emits when one agent turn finishes. */
const TURN_END = 'turn/end'
/** Event type the host emits for input the user typed into a session. */
const USER_MESSAGE = 'user/message'

/** A failure message safe to log: no user content, only the error text. */
function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Return `document` with one topic replaced by its new state. */
function replaceTopic(document: ProjectIndexV2, topic: TopicRecordV2): ProjectIndexV2 {
  return {
    ...document,
    topics: document.topics.map((entry) => (entry.topicId === topic.topicId ? topic : entry)),
  }
}

/** Listen to the host event stream and maintain topic activity and reopening. */
export class TopicEvents {
  private readonly ports: TopicEventsPorts
  private dispose: (() => void) | null = null

  constructor(ports: TopicEventsPorts) {
    this.ports = ports
  }

  /**
   * Start listening. Idempotent: while attached, a second call returns the same
   * disposer; the disposer is idempotent too. After disposal the next call
   * attaches a fresh listener.
   */
  attach(): () => void {
    if (this.dispose !== null) return this.dispose
    const off = this.ports.onSessionEvent((session, event) => {
      void this.handle(session, event).catch((error: unknown) => {
        this.log(`topic lifecycle event ${event.type} failed: ${describeFailure(error)}`)
      })
    })
    const dispose = (): void => {
      if (this.dispose === null) return
      this.dispose = null
      off()
    }
    this.dispose = dispose
    return dispose
  }

  /** One event, fully handled or reported through `log`. */
  private async handle(session: TopicEventSession, event: TopicEventLike): Promise<void> {
    if (event.type !== TURN_END && event.type !== USER_MESSAGE) return
    const repoPath = await this.ports.resolveRepoPath(session)
    if (repoPath === null) return
    // One clock read per event: the topic stamps and the activity time agree.
    const nowMs = this.ports.clock().getTime()
    const store = this.ports.storeFor(repoPath)
    if (event.type === TURN_END) {
      await this.trackActivity(store, session.id, nowMs)
      return
    }
    await this.reopenResolved(store, session.id, nowMs)
  }

  /**
   * `turn/end`: an idle topic returns to `active` and the activity time moves.
   * A topic this project does not know, or one already resolved, is left alone.
   */
  private async trackActivity(
    store: TopicEventStorePort,
    topicId: string,
    nowMs: number,
  ): Promise<void> {
    const document = await store.readIndexDocument()
    if (!document.topics.some((topic) => topic.topicId === topicId)) return
    await store.mutateIndexDocument((locked) => {
      const topic = locked.topics.find((entry) => entry.topicId === topicId)
      if (topic === undefined) return null
      const next = noteTopicActivity(topic, nowMs)
      // `noteTopicActivity` returns the same object for a resolved topic: the
      // caller has to reopen explicitly, so this event writes nothing.
      return next === topic ? null : replaceTopic(locked, next)
    })
  }

  /**
   * `user/message`: reopen a resolved topic exactly once. The lock-scoped
   * mutator re-checks `resolved`, so a message racing another reopen (or a
   * deleted topic) writes nothing and records no event. The activity event is
   * written after the index commits; if it fails, the reopen stays and only the
   * log records the lost evidence.
   */
  private async reopenResolved(
    store: TopicEventStorePort,
    topicId: string,
    nowMs: number,
  ): Promise<void> {
    const document = await store.readIndexDocument()
    const current = document.topics.find((topic) => topic.topicId === topicId)
    if (current === undefined || current.status !== 'resolved') return

    let outcome: { event: ActivityEvent | null } = { event: null }
    await store.mutateIndexDocument((locked) => {
      const topic = locked.topics.find((entry) => entry.topicId === topicId)
      if (topic === undefined || topic.status !== 'resolved') return null
      const reopened = reopenResolvedTopic(topic, nowMs)
      if (reopened === null) return null
      outcome = {
        event: {
          eventId: randomUUID(),
          time: new Date(nowMs).toISOString(),
          type: 'topic-reopened',
          topicId,
          summary: 'reopened resolved topic',
          details: { resolvedAt: topic.resolvedAt, resolvedBy: topic.resolvedBy },
        },
      }
      return replaceTopic(locked, reopened)
    })

    if (outcome.event === null) return
    try {
      await store.appendActivity(outcome.event)
    } catch (error) {
      this.log(`topic-reopened activity for ${topicId} was not recorded: ${describeFailure(error)}`)
    }
  }

  private log(message: string): void {
    this.ports.log?.(message)
  }
}
