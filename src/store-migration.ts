/**
 * v1 → v2 index migration and the v1 compatibility view.
 *
 * M7 writes v2 only; it reads v1 by migrating on the write path. Everything in
 * this module is a pure function: it never reads a file, takes a lock, archives
 * a session, or asks for the time. That is what makes the six-state mapping
 * testable in isolation.
 *
 * Three things stay out of here on purpose:
 *
 * - The old convention files (`handoffs/`, `reviews/`) are evidence and are
 *   never rewritten; only their four newest attachment pointers migrate onto
 *   the topic so the legacy view can still show them.
 * - A v1 status the six-state mapping folds away (`new`, `archived`) leaves a
 *   tolerated `legacyStatus` marker on the topic so the compatibility view can
 *   restore it exactly; the flag itself is not a v2 field.
 * - Archiving the reviewer of an in-flight v1 review is asynchronous host I/O.
 *   The migration reports every reviewer that must be archived
 *   (`pendingReviewerArchives`) and clears the pointer; the store's migration
 *   entry performs the archive before writing v2.
 *
 * The view pair (`legacyViewOf` / `applyLegacyView`) exists because
 * `src/tools.ts`, `src/api.ts`, `src/handoff.ts` and `src/review-tools.ts` are
 * still v1-shaped in M7 and cannot change. `legacyViewOf` derives a v1 document
 * from v2, and `applyLegacyView` folds an edited view back into the v2 document
 * without letting legacy code overwrite fields it does not own.
 */
import {
  INDEX_VERSION_V1,
  INDEX_VERSION_V2,
  LEGACY_THREAD_STATUSES,
  normalizeProjectIndexV1,
  projectIndexV1Problems,
  projectIndexV2Problems,
} from './store-schema.js'
import type {
  LegacyStatusMarker,
  ProjectIndexV1,
  ProjectIndexV2,
  ThreadRecordV1,
  ThreadStatusV1,
  TopicRecordV2,
} from './store-schema.js'

/** Why a migration stopped. Both codes are terminal: nothing is written. */
export type MigrationErrorCode = 'migration/unknown-status' | 'migration/invalid'

/** A migration failure carrying a stable code and the position it stopped at. */
export class MigrationError extends Error {
  readonly code: MigrationErrorCode

  constructor(code: MigrationErrorCode, message: string) {
    super(message)
    this.name = 'MigrationError'
    this.code = code
  }
}

/** The v1 leftovers a v2 topic keeps for the legacy view. */
export interface LegacyTopicFields {
  /** `new`/`archived` v1 status the six-state mapping cannot express. */
  legacyStatus?: LegacyStatusMarker
  lastHandoffAt?: string | null
  reviewRequestedAt?: string | null
  reviewedAt?: string | null
  latestReviewPath?: string | null
}

/** A v2 topic plus the tolerated v1 attachment fields. */
type TopicWithLegacy = TopicRecordV2 & LegacyTopicFields

/** Per-state counts of the six v1 thread states. */
export interface MigrationStatusCounts {
  new: number
  active: number
  awaiting_review: number
  done: number
  blocked: number
  archived: number
}

/** One reviewer the migration entry must archive once it writes v2. */
export interface PendingReviewerArchive {
  topicId: string
  reviewerSessionId: string
}

/**
 * One reviewer the migration entry could not archive. The migration function
 * itself never archives: `src/store.ts` performs the host call and fills this
 * list, so a caller can report the failure instead of claiming the review was
 * safely cancelled.
 */
export interface ArchiveFailure extends PendingReviewerArchive {
  message: string
}

/** What the migration did, for the caller's activity record and tests. */
export interface MigrationReport {
  fromVersion: number
  toVersion: number
  migrated: boolean
  statusCounts: MigrationStatusCounts
  resolvedTopics: string[]
  pendingReviewerArchives: PendingReviewerArchive[]
  /** Filled by the store's migration entry; the pure function leaves it empty. */
  archiveFailures: ArchiveFailure[]
  /**
   * Why the migration activity record could not be appended, or null. The
   * activity is evidence written after v2 is on disk (KI-20): its failure is
   * reported here and never rolls the migration back.
   */
  activityFailure: string | null
  unknownFields: string[]
  legacyFieldsPreserved: string[]
}

/** The outcome of one migration call. */
export interface MigrationResult {
  document: ProjectIndexV2
  report: MigrationReport
}

/** How a v1 document is projected onto v2. */
export interface MigrationOptions {
  /**
   * Cancel an in-flight v1 review: `awaitingReview=false`, clear the review
   * pointer, and report the reviewer for archiving. Default `true` — the write
   * path. `false` is the read-only projection: the review stays in place and
   * nothing is archived.
   */
  cancelInFlightReviews?: boolean
}

/** The four tolerated review attachment fields, in report order. */
const LEGACY_TOPIC_FIELDS = [
  'lastHandoffAt',
  'reviewRequestedAt',
  'reviewedAt',
  'latestReviewPath',
] as const

/** v1 thread fields the migration reads; anything else is preserved as unknown. */
const THREAD_V1_FIELDS: ReadonlySet<string> = new Set([
  'threadId',
  'subject',
  'status',
  'cwd',
  'checkoutPath',
  'worktreePath',
  'createdAt',
  'updatedAt',
  'lastHandoffAt',
  'reviewStatus',
  'reviewRequestedAt',
  'reviewedAt',
  'reviewerSessionId',
  'latestReviewPath',
])

/** v1 document fields the migration reads; anything else is preserved as unknown. */
const DOCUMENT_V1_FIELDS: ReadonlySet<string> = new Set([
  'version',
  'projectId',
  'masterSessionId',
  'createdAt',
  'threads',
])

/** v2 document fields a v1 document must not already carry. */
const DOCUMENT_V2_FIELDS = ['topics', 'workItems'] as const

/** Whether a value is a JSON object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Build the fail-closed error for a document the migration cannot trust. */
function invalid(message: string): MigrationError {
  return new MigrationError('migration/invalid', `migration/invalid: ${message}`)
}

/** A fresh six-state counter. */
function emptyStatusCounts(): MigrationStatusCounts {
  return { new: 0, active: 0, awaiting_review: 0, done: 0, blocked: 0, archived: 0 }
}

/**
 * Whether a value is a v1 document. The version tag is the discriminator; a
 * document that claims v1 but is damaged is reported by the migration itself,
 * not by this predicate.
 */
export function isLegacyIndexDocument(value: unknown): boolean {
  return isRecord(value) && value.version === INDEX_VERSION_V1
}

/**
 * Migrate a v1 document to v2, or pass a v2 document through unchanged.
 *
 * A v2 document that validates is returned deep-equal (a second migration is an
 * identity, so a retry cannot change the file); a v2 document that does not
 * validate throws `migration/invalid`. A v1 document with a status outside the
 * six states throws `migration/unknown-status` before anything is rewritten.
 *
 * `options.cancelInFlightReviews` defaults to the M7 write semantics. A
 * read-only caller passes `false` so the projection keeps an in-flight review:
 * only a real write cancels it and asks the store to archive the reviewer.
 */
export function migrateV1ToV2(document: unknown, options: MigrationOptions = {}): MigrationResult {
  if (!isRecord(document)) throw invalid('index must be a JSON object')
  if (document.version === INDEX_VERSION_V2) return migrateV2Document(document)
  if (!isLegacyIndexDocument(document)) {
    throw invalid(`index.version must be ${INDEX_VERSION_V1} or ${INDEX_VERSION_V2}`)
  }
  return migrateV1Document(document, options.cancelInFlightReviews ?? true)
}

/** Pass a valid v2 document through; report only what describes it. */
function migrateV2Document(document: Record<string, unknown>): MigrationResult {
  const problems = projectIndexV2Problems(document)
  if (problems.length > 0) throw invalid(problems.join('; '))
  const cloned = structuredClone(document) as unknown as ProjectIndexV2
  const statusCounts = emptyStatusCounts()
  for (const topic of cloned.topics) statusCounts[legacyStatusOf(topic)] += 1
  return {
    document: cloned,
    report: {
      fromVersion: INDEX_VERSION_V2,
      toVersion: INDEX_VERSION_V2,
      migrated: false,
      statusCounts,
      resolvedTopics: [],
      pendingReviewerArchives: [],
      archiveFailures: [],
      activityFailure: null,
      unknownFields: [],
      legacyFieldsPreserved: [],
    },
  }
}

/** Migrate one v1 document to v2. */
function migrateV1Document(index: Record<string, unknown>, cancelInFlightReviews: boolean): MigrationResult {
  for (const field of DOCUMENT_V2_FIELDS) {
    if (Object.hasOwn(index, field)) {
      throw invalid(`index.${field} is a v2 field on a v1 index`)
    }
  }
  assertKnownThreadStatuses(index.threads)

  // Normalize first (legacy worktreePath adoption, M3 review fields defaulted
  // to null), then validate: the mapping below reads the normalized shape.
  const normalized = normalizeProjectIndexV1(index)
  const problems = projectIndexV1Problems(normalized)
  if (problems.length > 0) throw invalid(problems.join('; '))
  const v1 = normalized as ProjectIndexV1

  const statusCounts = emptyStatusCounts()
  const resolvedTopics: string[] = []
  const pendingReviewerArchives: PendingReviewerArchive[] = []
  const documentExtras = Object.entries(index).filter(([key]) => !DOCUMENT_V1_FIELDS.has(key))
  const unknownFields: string[] = documentExtras.map(([key]) => `index.${key}`)
  const legacyFieldsPreserved: string[] = []

  const topics = v1.threads.map((thread, position) => {
    const where = `index.topics[${position}]`
    statusCounts[thread.status] += 1
    if (thread.status === 'done' || thread.status === 'archived') {
      resolvedTopics.push(thread.threadId)
    }
    if (thread.status === 'awaiting_review' && cancelInFlightReviews && thread.reviewerSessionId !== null) {
      pendingReviewerArchives.push({
        topicId: thread.threadId,
        reviewerSessionId: thread.reviewerSessionId,
      })
    }
    unknownFields.push(...threadV1UnknownFields(thread, where))
    legacyFieldsPreserved.push(...LEGACY_TOPIC_FIELDS.map((field) => `${where}.${field}`))
    return topicFromV1Thread(thread, cancelInFlightReviews)
  })

  const migrated: Record<string, unknown> = {
    version: INDEX_VERSION_V2,
    projectId: v1.projectId,
    masterSessionId: v1.masterSessionId,
    createdAt: v1.createdAt,
    // A migrated project has no route history yet; both targets start null
    // (PLAN-V0.2 §5.3). The read path normalizes the same way, so old v2
    // documents that lack the fields stay readable without a migration.
    masterFocusTopicId: null,
    lastRouteTopicId: null,
    topics,
    workItems: [],
  }
  for (const [key, value] of documentExtras) migrated[key] = value

  return {
    document: migrated as unknown as ProjectIndexV2,
    report: {
      fromVersion: INDEX_VERSION_V1,
      toVersion: INDEX_VERSION_V2,
      migrated: true,
      statusCounts,
      resolvedTopics,
      pendingReviewerArchives,
      archiveFailures: [],
      activityFailure: null,
      unknownFields,
      legacyFieldsPreserved,
    },
  }
}

/**
 * Fail closed on any v1 status the migration does not map. This runs before
 * validation so an unknown status is reported as such rather than as a generic
 * schema problem; a missing status is left to the validator.
 */
function assertKnownThreadStatuses(threads: unknown): void {
  if (!Array.isArray(threads)) return
  threads.forEach((thread, position) => {
    if (!isRecord(thread) || thread.status === undefined) return
    const known = (LEGACY_THREAD_STATUSES as readonly unknown[]).includes(thread.status)
    if (!known) {
      throw new MigrationError(
        'migration/unknown-status',
        `migration/unknown-status: index.threads[${position}].status is ${JSON.stringify(thread.status)}`,
      )
    }
  })
}

/** Map one normalized v1 thread onto a v2 topic. */
function topicFromV1Thread(thread: ThreadRecordV1, cancelInFlightReviews: boolean): TopicWithLegacy {
  const resolved = thread.status === 'done' || thread.status === 'archived'
  const inFlightReview = thread.status === 'awaiting_review'
  const cancelReview = inFlightReview && cancelInFlightReviews
  const topic: TopicWithLegacy = {
    topicId: thread.threadId,
    title: thread.subject,
    status: resolved ? 'resolved' : 'active',
    awaitingReview: inFlightReview && !cancelInFlightReviews,
    blocked: thread.status === 'blocked',
    blockedReason: thread.status === 'blocked' ? 'handoff' : null,
    blockedFromStatus: thread.status === 'blocked' ? 'active' : null,
    blockedAt: null,
    authorization: null,
    scope: '',
    ownedPaths: [],
    aliases: [],
    digest: '',
    cwd: thread.cwd,
    legacyCheckoutPath: thread.checkoutPath,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    lastActiveAt: thread.updatedAt,
    lastDeliveryConfirmedAt: resolved ? thread.updatedAt : null,
    resolvedAt: resolved ? thread.updatedAt : null,
    resolvedBy: resolved ? 'master' : null,
    latestReviewRequestId: null,
    reviewStatus: cancelReview ? null : thread.reviewStatus,
    reviewerSessionId: cancelReview ? null : thread.reviewerSessionId,
    lastHandoffAt: thread.lastHandoffAt,
    reviewRequestedAt: thread.reviewRequestedAt,
    reviewedAt: thread.reviewedAt,
    latestReviewPath: thread.latestReviewPath,
  }
  const marker = legacyStatusMarkerOf(thread)
  if (marker !== null) topic.legacyStatus = marker
  for (const [key, value] of Object.entries(thread)) {
    if (THREAD_V1_FIELDS.has(key)) continue
    ;(topic as unknown as Record<string, unknown>)[key] = value
  }
  return topic
}

/** The v1-only status a thread carries, if any. */
function legacyStatusMarkerOf(thread: ThreadRecordV1): LegacyStatusMarker | null {
  return thread.status === 'new' || thread.status === 'archived' ? thread.status : null
}

/**
 * Map a thread the legacy code added through the view onto a new v2 topic. Unlike
 * {@link topicFromV1Thread} this is not a document migration: the thread is live,
 * so its review fields are kept and `awaitingReview` follows its status instead
 * of the review being cancelled.
 */
function topicFromViewThread(thread: ThreadRecordV1): TopicWithLegacy {
  const topic: TopicWithLegacy = {
    topicId: thread.threadId,
    title: thread.subject,
    ...lifecycleFieldsOf(thread, null),
    blockedReason: thread.status === 'blocked' ? 'handoff' : null,
    blockedFromStatus: thread.status === 'blocked' ? 'active' : null,
    blockedAt: null,
    authorization: null,
    scope: '',
    ownedPaths: [],
    aliases: [],
    digest: '',
    cwd: thread.cwd,
    legacyCheckoutPath: thread.checkoutPath,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    lastActiveAt: thread.updatedAt,
    latestReviewRequestId: null,
    reviewStatus: thread.reviewStatus,
    reviewerSessionId: thread.reviewerSessionId,
    lastHandoffAt: thread.lastHandoffAt,
    reviewRequestedAt: thread.reviewRequestedAt,
    reviewedAt: thread.reviewedAt,
    latestReviewPath: thread.latestReviewPath,
  }
  const marker = legacyStatusMarkerOf(thread)
  if (marker !== null) topic.legacyStatus = marker
  for (const [key, value] of Object.entries(thread)) {
    if (THREAD_V1_FIELDS.has(key)) continue
    ;(topic as unknown as Record<string, unknown>)[key] = value
  }
  return topic
}

/** Addresses of the v1 thread fields the migration does not consume. */
function threadV1UnknownFields(thread: ThreadRecordV1, where: string): string[] {
  return Object.keys(thread)
    .filter((key) => !THREAD_V1_FIELDS.has(key))
    .map((key) => `${where}.${key}`)
}

/**
 * The v1 view of a v2 document: `status` is derived from the v2 flags so the
 * unchanged v1 tools keep working (`resolved` reports `done`). The two states a
 * derived status cannot express survive through the `legacyStatus` marker; the
 * four v1 review attach points come from the tolerated fields.
 */
export function legacyViewOf(document: ProjectIndexV2): ProjectIndexV1 {
  return {
    version: INDEX_VERSION_V1,
    projectId: document.projectId,
    masterSessionId: document.masterSessionId,
    createdAt: document.createdAt,
    threads: document.topics.map((topic) => threadOfTopic(topic)),
  }
}

/** Derive the v1 status of one v2 topic, preferring a preserved v1-only state. */
function legacyStatusOf(topic: TopicRecordV2): ThreadStatusV1 {
  const marker = (topic as TopicWithLegacy).legacyStatus
  if (marker === 'new' || marker === 'archived') return marker
  if (topic.status === 'resolved') return 'done'
  if (topic.blocked) return 'blocked'
  if (topic.awaitingReview) return 'awaiting_review'
  return 'active'
}

/** Build the v1 thread the legacy tools see for one v2 topic. */
function threadOfTopic(topic: TopicRecordV2): ThreadRecordV1 {
  const withLegacy = topic as TopicWithLegacy
  return {
    threadId: topic.topicId,
    subject: topic.title,
    status: legacyStatusOf(topic),
    cwd: topic.cwd,
    checkoutPath: topic.legacyCheckoutPath,
    createdAt: topic.createdAt,
    updatedAt: topic.updatedAt,
    lastHandoffAt: withLegacy.lastHandoffAt ?? null,
    reviewStatus: topic.reviewStatus,
    reviewRequestedAt: withLegacy.reviewRequestedAt ?? null,
    reviewedAt: withLegacy.reviewedAt ?? null,
    reviewerSessionId: topic.reviewerSessionId,
    latestReviewPath: withLegacy.latestReviewPath ?? null,
  }
}

/**
 * Fold an edited v1 view back into the v2 document.
 *
 * The legacy tools own the title, status, review state and the four review
 * attachment fields, so those are written back; the status also drives the v2
 * lifecycle flags (`awaitingReview`, `blocked`, `resolvedAt`, `resolvedBy`,
 * `lastDeliveryConfirmedAt`) because `src/handoff.ts` and
 * `src/review-tools.ts` move the status and would otherwise leave the flags
 * stale. The v2-only fields — `scope`, `ownedPaths`, `aliases`, `digest`,
 * `lastActiveAt`, `latestReviewRequestId`, the work items, and the document
 * envelope — are never touched. The view is the whole document, so a topic the
 * view omits is deleted (the legacy tools roll a failed thread creation back by
 * filtering it out of `threads`); a thread the legacy tools added becomes a new
 * topic with migration defaults. M7 always has an empty `workItems` list, so a
 * topic deletion has nothing to cascade to; work item cleanup belongs to the
 * M8 lifecycle rules.
 */
export function applyLegacyView(base: ProjectIndexV2, view: ProjectIndexV1): ProjectIndexV2 {
  const pending = new Map<string, ThreadRecordV1>()
  for (const thread of view.threads) {
    if (!pending.has(thread.threadId)) pending.set(thread.threadId, thread)
  }
  const topics: TopicWithLegacy[] = []
  for (const topic of base.topics) {
    const thread = pending.get(topic.topicId)
    if (thread === undefined) continue
    pending.delete(topic.topicId)
    topics.push(mergeTopicWithThread(topic, thread))
  }
  for (const thread of pending.values()) topics.push(topicFromViewThread(thread))
  return { ...(base as unknown as Record<string, unknown>), topics } as unknown as ProjectIndexV2
}

/** Write the legacy-owned fields of one thread back onto its v2 topic. */
function mergeTopicWithThread(topic: TopicRecordV2, thread: ThreadRecordV1): TopicWithLegacy {
  const merged: TopicWithLegacy = {
    ...(topic as TopicWithLegacy),
    title: thread.subject,
    ...lifecycleFieldsOf(thread, topic),
    cwd: thread.cwd,
    legacyCheckoutPath: thread.checkoutPath,
    updatedAt: thread.updatedAt,
    reviewStatus: thread.reviewStatus,
    reviewerSessionId: thread.reviewerSessionId,
    lastHandoffAt: thread.lastHandoffAt,
    reviewRequestedAt: thread.reviewRequestedAt,
    reviewedAt: thread.reviewedAt,
    latestReviewPath: thread.latestReviewPath,
  }
  const marker = legacyStatusMarkerOf(thread)
  if (marker !== null) merged.legacyStatus = marker
  else delete merged.legacyStatus
  return merged
}

/** The v2 lifecycle state a v1 status implies; `base` is null for a new topic. */
function lifecycleFieldsOf(
  thread: ThreadRecordV1,
  base: Pick<TopicRecordV2, 'resolvedAt' | 'resolvedBy' | 'lastDeliveryConfirmedAt'> | null,
): Pick<
  TopicRecordV2,
  'status' | 'awaitingReview' | 'blocked' | 'resolvedAt' | 'resolvedBy' | 'lastDeliveryConfirmedAt'
> {
  const resolved = thread.status === 'done' || thread.status === 'archived'
  return {
    status: resolved ? 'resolved' : 'active',
    awaitingReview: thread.status === 'awaiting_review',
    blocked: thread.status === 'blocked',
    // Resolution history belongs to the lifecycle layer (M8): an existing
    // resolution keeps its original timestamps, a newly resolved topic gets
    // the time the legacy writer stamped on the thread.
    resolvedAt: resolved ? (base?.resolvedAt ?? thread.updatedAt) : null,
    resolvedBy: resolved ? (base?.resolvedBy ?? 'master') : null,
    lastDeliveryConfirmedAt: resolved ? (base?.lastDeliveryConfirmedAt ?? thread.updatedAt) : null,
  }
}
