/**
 * Business activity events (M8.3).
 *
 * This module builds the events the lifecycle rules publish and records them
 * through the store's append port. The file layer stays in `src/store.ts`:
 * `appendActivity` validates the event, enforces the 500-event / 512-KiB bounds
 * and repairs damaged lines on its next rewrite, so nothing here re-implements
 * JSON Lines I/O. The event-type vocabulary has one home,
 * `ACTIVITY_TYPES` in `src/store-schema.ts`; this module does not copy it.
 */
import { randomUUID } from 'node:crypto'
import { ACTIVITY_TYPES } from './store-schema.js'
import type { ActivityEvent, ActivityType, TopicRecordV2, TopicStatus } from './store-schema.js'

/** Everything one business activity event is built from. */
export interface ActivityInput {
  type: ActivityType
  /** Topic the event belongs to, or null for project-level events. */
  topicId: string | null
  summary: string
  /** Structured detail for the panel; never free-form log text. Defaults to `{}`. */
  details?: Record<string, unknown>
}

/** The narrow append port this module needs from the store. */
export interface ActivitySink {
  appendActivity(event: ActivityEvent): Promise<void>
}

/** Build one validated event stamped with the injected clock. */
export function buildActivityEvent(input: ActivityInput, now: Date): ActivityEvent {
  if (!(ACTIVITY_TYPES as readonly string[]).includes(input.type)) {
    throw new Error(`activity.type must be one of ${ACTIVITY_TYPES.join('|')}`)
  }
  if (input.summary.trim() === '') {
    throw new Error('activity.summary must be a non-empty string')
  }
  return {
    eventId: randomUUID(),
    time: now.toISOString(),
    type: input.type,
    topicId: input.topicId,
    summary: input.summary,
    details: input.details ?? {},
  }
}

/**
 * Build one event and append it through the store's validated file layer.
 * Returns the event that was written, so a caller can report the same id.
 */
export async function recordActivity(
  sink: ActivitySink,
  input: ActivityInput,
  now: Date,
): Promise<ActivityEvent> {
  const event = buildActivityEvent(input, now)
  await sink.appendActivity(event)
  return event
}

/**
 * The event a manual reopen records. Pass the topic as it was resolved: the
 * reopen clears `resolvedAt`/`resolvedBy`, and the event keeps the resolution
 * it replaced so the history in activity.jsonl stays auditable.
 */
export function topicReopenedActivity(topic: TopicRecordV2, now: Date): ActivityEvent {
  return buildActivityEvent(
    {
      type: 'topic-reopened',
      topicId: topic.topicId,
      summary: `reopened topic ${topic.topicId}`,
      details: { topicId: topic.topicId, resolvedAt: topic.resolvedAt, resolvedBy: topic.resolvedBy },
    },
    now,
  )
}

/** The event one lifecycle transition records (`status-changed`). */
export function statusChangedActivity(
  topic: TopicRecordV2,
  change: { from: TopicStatus; to: TopicStatus },
  now: Date,
): ActivityEvent {
  return buildActivityEvent(
    {
      type: 'status-changed',
      topicId: topic.topicId,
      summary: `changed topic status from ${change.from} to ${change.to}`,
      details: { topicId: topic.topicId, from: change.from, to: change.to },
    },
    now,
  )
}

/** The event one failure records; `details` carries the structured cause. */
export function errorActivity(
  topicId: string | null,
  summary: string,
  now: Date,
  details: Record<string, unknown> = {},
): ActivityEvent {
  return buildActivityEvent({ type: 'error', topicId, summary, details }, now)
}
