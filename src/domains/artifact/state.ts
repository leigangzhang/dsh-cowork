/**
 * Pure work-item state transitions.
 *
 * Two axes must never mix: `status` is the collaboration state of the work item
 * and `DispatchState` is the delivery state of one annotation batch. This module
 * owns only the collaboration axis plus the counters a comment event moves, so
 * the routes, the tools and the file watcher cannot each invent a slightly
 * different transition table.
 */
import type {
  ArtifactRecordV1,
  CommentEventV1,
  DispatchState,
} from '../../panel/artifact-contract.js'

/** What a status route may ask for. `view` records that the viewer opened. */
export type ArtifactStatusAction = 'view' | 'confirm'

/** One record change: the new record plus whether anything moved. */
export interface RecordChange {
  readonly record: ArtifactRecordV1
  readonly changed: boolean
}

/** The timestamp every mutation stamps. */
function stamped(now: Date): string {
  return now.toISOString()
}

/**
 * Apply a user status action.
 *
 * `view` moves only first-open (`pending-view` → `pending-confirm`) and is
 * idempotent afterwards. `confirm` accepts the work from any state except
 * `confirmed`. Both leave the counters alone.
 */
export function applyStatusAction(
  record: ArtifactRecordV1,
  action: ArtifactStatusAction,
  now: Date,
): RecordChange {
  const next = action === 'view'
    ? (record.status === 'pending-view' ? 'pending-confirm' as const : null)
    : (record.status === 'confirmed' ? null : 'confirmed' as const)
  if (next === null) return { record, changed: false }
  return { record: { ...record, status: next, updatedAt: stamped(now) }, changed: true }
}

/**
 * Fold one comment event into the record counters and collaboration state.
 *
 * A new comment or reply counts as feedback and reopens a confirmed item; it
 * moves the status to `needs-feedback` unless the item is already there or is
 * being worked on (`in-progress`). Resolve, reopen, and anchor-moved rows touch
 * only the timestamp.
 */
export function applyCommentEvent(
  record: ArtifactRecordV1,
  event: CommentEventV1,
  now: Date,
): RecordChange {
  if (event.type === 'create' || event.type === 'reply') {
    const status = record.status === 'needs-feedback' || record.status === 'in-progress'
      ? record.status
      : 'needs-feedback'
    return {
      changed: true,
      record: {
        ...record,
        status,
        commentCount: record.commentCount + 1,
        updatedAt: stamped(now),
      },
    }
  }
  return { record: { ...record, updatedAt: stamped(now) }, changed: true }
}

/**
 * Record the dispatch a new annotation batch started. `null` keeps the current
 * summary (a comment created with `dispatch: false`).
 */
export function applyActiveDispatch(
  record: ArtifactRecordV1,
  dispatch: { dispatchId: string; state: DispatchState } | null,
  now: Date,
): RecordChange {
  if (dispatch === null) return { record, changed: false }
  return {
    changed: true,
    record: {
      ...record,
      activeDispatch: { ...dispatch, updatedAt: stamped(now) },
      updatedAt: stamped(now),
    },
  }
}
