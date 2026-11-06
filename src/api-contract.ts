/**
 * Wire contract for the read-only Cowork panel API (`/api/cowork.*`).
 *
 * The host half serves it and the browser half consumes it, so this module is
 * deliberately dependency-free: the client bundle imports it, and importing
 * `./store.js` (node builtins) there would break the bundle. The status union is
 * therefore restated as the wire schema; `tests/api-contract.test.mjs` pins it
 * to the store's own union, and the host half maps records into these shapes.
 */

/** Exact Fetch-route path below the connection `/api` channel: project overview. */
export const OVERVIEW_PATH = '/api/cowork.overview'

/** Exact Fetch-route path below the connection `/api` channel: one thread's latest handoff. */
export const HANDOFF_PATH = '/api/cowork.handoff'

/** Identifies the message renderer that produced `masterMessage`. */
export const HANDOFF_FORMATTER_VERSION = 'cowork/handoff-message@1'

/** Upper bound on threads returned by one overview response. */
export const MAX_PANEL_THREADS = 500

/** Thread lifecycle the panel lists. `archived` threads are never returned. */
export type PanelThreadStatus = 'new' | 'active' | 'awaiting_review' | 'done' | 'blocked'

/** Priority order: what needs attention first, then recency within a status. */
export const PANEL_STATUS_ORDER: readonly PanelThreadStatus[] = [
  'awaiting_review', 'blocked', 'active', 'new', 'done',
]

/** Project identity the panel header shows. */
export interface PanelProject {
  readonly repoPath: string
  readonly projectId: string
  readonly masterSessionId: string
  readonly createdAt: string
}

/** One thread as the panel lists and selects it. */
export interface PanelThread {
  readonly threadId: string
  readonly subject: string
  readonly status: PanelThreadStatus
  readonly cwd: string
  /** Isolated checkout path, or null for a thread working in the shared repository. */
  readonly checkoutPath: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastHandoffAt: string | null
  /** True when `lastHandoffAt` is set; the panel's list marker. */
  readonly hasHandoff: boolean
  /** Latest review state recorded in the index, or null when never requested. */
  readonly reviewStatus: PanelReviewStatus | null
  /** When the latest verdict was recorded; null while pending or never reviewed. */
  readonly reviewedAt: string | null
  /** Session that may deliver a verdict; null when no review session exists. */
  readonly reviewerSessionId: string | null
}

/** Per-status thread counts shown as the header chips. */
export interface PanelCounts {
  readonly new: number
  readonly active: number
  readonly awaiting_review: number
  readonly blocked: number
  readonly done: number
}

/** Success body of {@link OVERVIEW_PATH}. */
export interface OverviewPayload {
  readonly project: PanelProject
  readonly counts: PanelCounts
  readonly threads: readonly PanelThread[]
}

/** One verification row of a handoff record. */
export interface PanelVerification {
  readonly command: string
  readonly exitCode: number
  readonly evidence: string
}

/**
 * Review lifecycle of one thread. `pending` means a reviewer session was asked
 * and has not answered yet; the three others are the recorded verdicts.
 */
export type PanelReviewStatus = 'pending' | 'pass' | 'needs_revision' | 'reject'

/** A verdict is what a review file records; `pending` is index state, not a verdict. */
export type PanelReviewVerdict = Exclude<PanelReviewStatus, 'pending'>

/** Filename finding severity, most serious first. */
export type PanelReviewSeverity = 'blocker' | 'high' | 'medium' | 'low'

/** The four review states, in no priority order (they never enter the list sort). */
export const PANEL_REVIEW_STATUSES: readonly PanelReviewStatus[] = [
  'pending', 'pass', 'needs_revision', 'reject',
]

/** The three verdicts a review file may carry. */
export const PANEL_REVIEW_VERDICTS: readonly PanelReviewVerdict[] = ['pass', 'needs_revision', 'reject']

/** The four finding severities. */
export const PANEL_REVIEW_SEVERITIES: readonly PanelReviewSeverity[] = ['blocker', 'high', 'medium', 'low']

/** Whether a value is one of the four review states (the index may hold garbage). */
export function isPanelReviewStatus(value: unknown): value is PanelReviewStatus {
  return typeof value === 'string' && (PANEL_REVIEW_STATUSES as readonly string[]).includes(value)
}

/** Whether a value is one of the three recorded verdicts. */
export function isPanelReviewVerdict(value: unknown): value is PanelReviewVerdict {
  return typeof value === 'string' && (PANEL_REVIEW_VERDICTS as readonly string[]).includes(value)
}

/** Whether a value is one of the four finding severities. */
export function isPanelReviewSeverity(value: unknown): value is PanelReviewSeverity {
  return typeof value === 'string' && (PANEL_REVIEW_SEVERITIES as readonly string[]).includes(value)
}

/** One finding of a review; `file`/`line` locate it when the reviewer named them. */
export interface PanelReviewFinding {
  readonly id: string
  readonly severity: PanelReviewSeverity
  readonly problem: string
  readonly requiredFix: string
  readonly file?: string
  readonly line?: number
}

/** One verification row the reviewer actually ran. */
export interface PanelReviewVerification {
  readonly command: string
  readonly exitCode: number
  readonly evidence: string
}

/** One review record, as stored under `.dsh-cowork/reviews/`. */
export interface PanelReviewRecord {
  readonly version: 1
  readonly threadId: string
  readonly reviewerSessionId: string
  readonly verdict: PanelReviewVerdict
  readonly summary: string
  readonly findings: readonly PanelReviewFinding[]
  readonly verification: readonly PanelReviewVerification[]
  readonly createdAt: string
}

/** The latest review of one thread, plus the absolute file it was read from. */
export interface PanelReviewPayload {
  readonly record: PanelReviewRecord
  /** Absolute path of the review JSON file; the panel shows it read-only. */
  readonly filePath: string
}

/** Handoff status as recorded on disk. */
export type PanelHandoffStatus = 'awaiting_review' | 'blocked' | 'done'

/** One handoff record, passed through exactly as stored. */
export interface PanelHandoffRecord {
  readonly version: 1
  readonly threadId: string
  readonly masterSessionId: string
  readonly status: PanelHandoffStatus
  readonly subject: string
  readonly summary: string
  readonly decisions: readonly string[]
  readonly changedPaths: readonly string[]
  readonly artifacts: readonly string[]
  readonly verification: readonly PanelVerification[]
  readonly openIssues: readonly string[]
  readonly nextStep: string | null
  readonly createdAt: string
  readonly deliveredAt: string | null
}

/** What the panel shows for one thread's latest handoff. */
export interface HandoffPayload {
  readonly record: PanelHandoffRecord
  /** Absolute path of the handoff JSON file. */
  readonly filePath: string
  /**
   * The exact text the host delivered to the master, re-rendered on read and
   * returned verbatim. Its size is bounded by the handoff file this plugin
   * wrote, not by a separate wire cap: truncating would break the "what the
   * master saw" evidence the panel exists to show.
   */
  readonly masterMessage: string
  readonly formatterVersion: string
  /**
   * Latest review of the same thread, read from the index pointer (never guessed
   * from the reviews directory). Null when the thread has no review yet, or when
   * the pointer file was removed after the verdict.
   */
  readonly review: PanelReviewPayload | null
}

/** Stable error codes the panel maps to its own states. */
export type PanelErrorCode =
  | 'request/session-required'
  | 'request/thread-required'
  | 'session/unknown'
  | 'session/cwd-unavailable'
  /**
   * The host session listing did not answer within the panel's bound. This one
   * is transient: the listing is a metadata read, so a retry can succeed once
   * the host finishes loading its session list.
   */
  | 'session/list-timeout'
  | 'project/not-initialized'
  | 'handoff/not-found'
  | 'store/corrupt'
  | 'internal'

/** Error body shared by both endpoints. */
export interface PanelErrorBody {
  readonly ok: false
  readonly error: {
    readonly code: PanelErrorCode
    readonly message: string
    /** Offending file or searched directory, when the code names one. */
    readonly path?: string
  }
}

/** Body of a successful {@link OVERVIEW_PATH} response. */
export interface OverviewResponse extends OverviewPayload {
  readonly ok: true
}

/** Body of a successful {@link HANDOFF_PATH} response. */
export interface HandoffResponse {
  readonly ok: true
  readonly handoff: HandoffPayload
}

/** Whether a parsed body is the shared error envelope. */
export function isPanelError(value: unknown): value is PanelErrorBody {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.ok !== false) return false
  const error = record.error
  return typeof error === 'object' && error !== null
    && typeof (error as Record<string, unknown>).code === 'string'
}

/** Whether a value is one of the five listable thread statuses. */
export function isPanelThreadStatus(value: unknown): value is PanelThreadStatus {
  return typeof value === 'string' && (PANEL_STATUS_ORDER as readonly string[]).includes(value)
}

/** Rank of one status in {@link PANEL_STATUS_ORDER}; unknown statuses sort last. */
function statusRank(status: PanelThreadStatus): number {
  const rank = PANEL_STATUS_ORDER.indexOf(status)
  return rank < 0 ? PANEL_STATUS_ORDER.length : rank
}

/**
 * Panel order: attention first (`awaiting_review`, `blocked`, `active`, `new`,
 * `done`), then most recently updated first inside one status. Ties keep the
 * input order, so the projection is stable and testable.
 */
export function sortThreadsForPanel<T extends { readonly status: PanelThreadStatus, readonly updatedAt: string }>(
  threads: readonly T[],
): T[] {
  return threads
    .map((thread, index) => ({ thread, index }))
    .sort((left, right) => {
      const byStatus = statusRank(left.thread.status) - statusRank(right.thread.status)
      if (byStatus !== 0) return byStatus
      const byUpdated = Date.parse(right.thread.updatedAt) - Date.parse(left.thread.updatedAt)
      if (Number.isFinite(byUpdated) && byUpdated !== 0) return byUpdated
      return left.index - right.index
    })
    .map(({ thread }) => thread)
}

/** Zero-filled counts of the listable statuses. */
export function countThreads(threads: readonly { readonly status: PanelThreadStatus }[]): PanelCounts {
  const counts: Record<PanelThreadStatus, number> = {
    new: 0, active: 0, awaiting_review: 0, blocked: 0, done: 0,
  }
  for (const thread of threads) {
    if (isPanelThreadStatus(thread.status)) counts[thread.status] += 1
  }
  return counts
}

/** The thread the panel selects on first paint: the first row of the panel order. */
export function defaultSelectedThreadId(threads: readonly { readonly threadId: string }[]): string | null {
  return threads.length === 0 ? null : threads[0].threadId
}
