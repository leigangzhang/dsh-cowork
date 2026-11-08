/**
 * Work items: the pure half of the M10 isolation model.
 *
 * A work item is one isolated clone (`.dsh-cowork/workitems/<id>`, branch
 * `cowork/<id>`) plus the v2 index record PLAN-V0.2 §4.3 defines. This module
 * owns the parts that need no host and no file system: the status vocabulary,
 * the in-flight count a topic's "resolved" condition reads, the record builder,
 * the marker updates, and the bounded view a tool returns.
 *
 * Creating and cleaning a clone, and gating the merge itself, stay out of this
 * module: they need git (src/checkout.ts) or the request model
 * (`mergeGate` in src/review-request.ts). Nothing here touches the host, the
 * file system, the clock, or the store.
 */
import { WORK_ITEM_STATUSES } from './store-schema.js'
import type { WorkItemRecordV2, WorkItemStatus } from './store-schema.js'

export { WORK_ITEM_STATUSES }
export type { WorkItemStatus }

/** A work-item id that is also usable as a directory and branch name. */
export const WORK_ITEM_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
/** Statuses that count as work in flight (PLAN-V0.2 §5.1: active + reviewing). */
export const ACTIVE_WORK_ITEM_STATUSES = ['active', 'reviewing'] as const
/** Statuses a work item may be merged from. */
export const MERGEABLE_WORK_ITEM_STATUSES = ['reviewing'] as const

/** Longest path `workItemView` returns, in characters. */
export const WORK_ITEM_VIEW_PATH_MAX_CHARS = 1024
/** Longest branch `workItemView` returns, in characters. */
export const WORK_ITEM_VIEW_BRANCH_MAX_CHARS = 256
/** Longest commit id `workItemView` returns, in characters. */
export const WORK_ITEM_VIEW_COMMIT_MAX_CHARS = 64

/** Whether a value is a usable work-item id. */
export function isValidWorkItemId(value: unknown): value is string {
  return typeof value === 'string'
    && WORK_ITEM_ID_PATTERN.test(value)
    && value !== '.'
    && value !== '..'
}

/** Whether a work item in this status may be merged by the master. */
export function isMergeableWorkItemStatus(status: unknown): boolean {
  return (MERGEABLE_WORK_ITEM_STATUSES as readonly unknown[]).includes(status)
}

/** Cut text to at most `limit` Unicode code points without splitting a pair. */
function cut(text: string, limit: number): string {
  if (limit <= 0) return ''
  const points = Array.from(text)
  return points.length <= limit ? text : points.slice(0, limit).join('')
}

/**
 * How many work items of one topic are in flight: `active` plus `reviewing`.
 * Both count, because a topic waiting on a review is still working and marking
 * it resolved has no undo (PLAN-V0.2 §5.1, KI-24).
 */
export function activeWorkItemCount(
  document: { workItems?: readonly WorkItemRecordV2[] } | null | undefined,
  topicId: string,
): number {
  const workItems = document?.workItems ?? []
  let count = 0
  for (const workItem of workItems) {
    if (workItem.topicId !== topicId) continue
    if ((ACTIVE_WORK_ITEM_STATUSES as readonly unknown[]).includes(workItem.status)) count += 1
  }
  return count
}

/** What the caller knows when a work item is created. */
export interface NewWorkItemInput {
  workItemId: string
  topicId: string
  /** Absolute clone path (`.dsh-cowork/workitems/<id>`). */
  path: string
  /** Branch the clone is on (`cowork/<id>`). */
  branch: string
  /** Commit the clone was created from, or null when git could not be read. */
  baseCommit: string | null
}

/**
 * Build the `active` record of one freshly created work item. A programmer error
 * in the caller's input throws here rather than writing an index row that
 * `projectIndexV2Problems` would refuse.
 */
export function buildWorkItemRecord(input: NewWorkItemInput, createdAt: Date): WorkItemRecordV2 {
  if (!isValidWorkItemId(input.workItemId)) {
    throw new TypeError(`workItemId ${String(input.workItemId)} is not a usable work-item id`)
  }
  if (typeof input.topicId !== 'string' || input.topicId.trim() === '') {
    throw new TypeError('topicId must be a non-empty topic id')
  }
  if (typeof input.path !== 'string' || input.path.trim() === '') {
    throw new TypeError('path must be a non-empty absolute path')
  }
  if (typeof input.branch !== 'string' || input.branch.trim() === '') {
    throw new TypeError('branch must be a non-empty branch name')
  }
  if (input.baseCommit !== null && (typeof input.baseCommit !== 'string' || input.baseCommit.trim() === '')) {
    throw new TypeError('baseCommit must be a commit id or null')
  }
  const stamp = createdAt.toISOString()
  return {
    workItemId: input.workItemId,
    topicId: input.topicId,
    path: input.path,
    branch: input.branch,
    baseCommit: input.baseCommit,
    headCommit: input.baseCommit,
    status: 'active',
    createdAt: stamp,
    updatedAt: stamp,
  }
}

/** The fields of a work item one marker update may change. */
export interface WorkItemPatch {
  status?: WorkItemStatus
  baseCommit?: string | null
  headCommit?: string | null
  path?: string
  branch?: string
}

/**
 * Stamp one marker update: the patch replaces the named fields, `updatedAt`
 * always moves, and every other field (identity, topic, timestamps) survives.
 * `headCommit` is refreshed here before a review request and before a merge.
 */
export function markWorkItem(
  workItem: WorkItemRecordV2,
  patch: WorkItemPatch,
  now: Date,
): WorkItemRecordV2 {
  if (patch.status !== undefined && !(WORK_ITEM_STATUSES as readonly unknown[]).includes(patch.status)) {
    throw new TypeError(`unknown work-item status ${String(patch.status)}`)
  }
  for (const field of ['baseCommit', 'headCommit'] as const) {
    const value = patch[field]
    if (value !== undefined && value !== null && (typeof value !== 'string' || value.trim() === '')) {
      throw new TypeError(`${field} must be a commit id or null`)
    }
  }
  for (const field of ['path', 'branch'] as const) {
    const value = patch[field]
    if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
      throw new TypeError(`${field} must be a non-empty string`)
    }
  }
  const next: WorkItemRecordV2 = { ...workItem, updatedAt: now.toISOString() }
  if (patch.status !== undefined) next.status = patch.status
  if (patch.baseCommit !== undefined) next.baseCommit = patch.baseCommit
  if (patch.headCommit !== undefined) next.headCommit = patch.headCommit
  if (patch.path !== undefined) next.path = patch.path
  if (patch.branch !== undefined) next.branch = patch.branch
  return next
}

/** The bounded work-item row a tool returns. */
export interface WorkItemView {
  workItemId: string
  topicId: string
  path: string
  branch: string
  baseCommit: string | null
  headCommit: string | null
  status: WorkItemStatus
  createdAt: string
  updatedAt: string
}

/**
 * Project one work item onto the bounded tool view. Path and branch are cut, so
 * a pathological clone path cannot blow the status payload; identity, status,
 * and the two commits are returned whole because a merge decision needs them.
 */
export function workItemView(workItem: WorkItemRecordV2): WorkItemView {
  return {
    workItemId: workItem.workItemId,
    topicId: workItem.topicId,
    path: cut(workItem.path, WORK_ITEM_VIEW_PATH_MAX_CHARS),
    branch: cut(workItem.branch, WORK_ITEM_VIEW_BRANCH_MAX_CHARS),
    baseCommit: workItem.baseCommit === null ? null : cut(workItem.baseCommit, WORK_ITEM_VIEW_COMMIT_MAX_CHARS),
    headCommit: workItem.headCommit === null ? null : cut(workItem.headCommit, WORK_ITEM_VIEW_COMMIT_MAX_CHARS),
    status: workItem.status,
    createdAt: workItem.createdAt,
    updatedAt: workItem.updatedAt,
  }
}
