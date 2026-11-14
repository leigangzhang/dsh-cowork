/**
 * M10 review requests: the pure model every review tool feeds untrusted input
 * into, and the merge gate that decides whether a passed review may be merged.
 *
 * Host-free by contract: no store, no file system, no clock, no host service.
 * The module owns six decisions the tools must not re-derive:
 *
 * 1. what a review request must contain (`validateReviewRequestInput`),
 * 2. how one request is stamped, serialized, and parsed
 *    (`buildReviewRequestRecord` / `serializeReviewRequestRecord` /
 *    `parseReviewRequestRecord`), including the file name,
 * 3. which previous request a re-review may reference (`checkPreviousRequest`),
 * 4. where a verdict moves the topic and whether the master is woken
 *    (`deriveReviewOutcome`),
 * 5. whether a merge may proceed (`mergeGate`),
 * 6. what the reviewer session is told (`buildReviewBrief`).
 *
 * The request file is `<repo>/.dsh-cowork/reviews/<topicId>-<requestId>.json`
 * (PLAN-V0.2 §4.3). Reading and writing it is the file layer's job (M10.3); this
 * module only produces and checks the text.
 */
import { isAbsolute, join, normalize, relative } from 'node:path'
import { ERROR_CODES, M10_ERROR_CODES, failure } from '../../platform/tool-model.js'
import type { ToolFailure } from '../../platform/tool-model.js'
import { REVIEW_SEVERITIES, REVIEW_STATUSES, REVIEW_VERDICTS } from '../../store/schema.js'
import type {
  InboxKind,
  ReviewFinding,
  ReviewSeverity,
  ReviewStatus,
  ReviewVerdict,
  ReviewVerification,
  WorkItemStatus,
} from '../../store/schema.js'
import { isMergeableWorkItemStatus, isValidWorkItemId } from '../isolation/work-item.js'

// ---------------------------------------------------------------------------
// bounds
// ---------------------------------------------------------------------------

/** On-disk version of one review request file. */
export const REVIEW_REQUEST_VERSION = 1
/** Suffix of one review request file. */
export const REVIEW_REQUEST_FILE_SUFFIX = '.json'
/** A request/topic id that may be used inside a file name (and only that). */
export const REVIEW_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
/** Upper bound of `purpose`, in characters. */
export const REVIEW_PURPOSE_MAX_CHARS = 500
/** Upper bound of `notes`, in characters. */
export const REVIEW_NOTES_MAX_CHARS = 2000
/** Upper bound of a verdict `summary`, in characters. */
export const REVIEW_SUMMARY_MAX_CHARS = 2000
/** Upper bound of an absolute review path, in characters. */
export const REVIEW_PATH_MAX_CHARS = 1024
/** Upper bound of a branch name, in characters. */
export const REVIEW_BRANCH_MAX_CHARS = 256
/** Most keys `extra` may carry. */
export const REVIEW_EXTRA_MAX_KEYS = 20
/** Longest accepted key of `extra`, in characters. */
export const REVIEW_EXTRA_KEY_MAX_CHARS = 128
/** Largest serialized `extra` value, in bytes. */
export const REVIEW_EXTRA_MAX_BYTES = 4096
/** Deepest container nesting of one `extra` value. */
export const REVIEW_EXTRA_MAX_DEPTH = 4
/** Most changed paths one request may carry. */
export const REVIEW_CHANGED_PATHS_MAX = 500
/** Most verification rows one request may carry. */
export const REVIEW_VERIFICATION_MAX_ROWS = 50
/** Longest accepted verification command or evidence, in characters. */
export const REVIEW_VERIFICATION_FIELD_MAX_CHARS = 2000
/** Most findings one verdict may carry. */
export const REVIEW_FINDINGS_MAX_ROWS = 200
/** Longest accepted finding field, in characters. */
export const REVIEW_FINDING_FIELD_MAX_CHARS = 2000
/** Hard ceiling of the reviewer brief, in characters. */
export const REVIEW_BRIEF_MAX_CHARS = 8000
/** Longest single line the brief builder writes, in characters. */
export const REVIEW_BRIEF_LINE_MAX_CHARS = 500
/** Most changed paths the brief lists before summarising the rest. */
export const REVIEW_BRIEF_MAX_PATHS_SHOWN = 60
/** Most verification rows the brief lists. */
export const REVIEW_BRIEF_MAX_ROWS_SHOWN = 10
/** Most findings of the previous round the brief lists. */
export const REVIEW_BRIEF_MAX_FINDINGS_SHOWN = 10

/** A commit id as `git rev-parse` prints it (abbreviated ids included). */
const COMMIT_PATTERN = /^[0-9a-f]{4,64}$/i
/** Control characters a path must never carry. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

/** Lossless JSON value accepted in `extra`. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** One rejected field of untrusted input. */
export interface ReviewFieldError {
  field: string
  message: string
}

/** A validated request: what the tool stamps into a pending record. */
export interface ReviewRequestDraft {
  topicId: string
  workItemId: string | null
  purpose: string
  notes: string
  extra: Record<string, JsonValue>
  baseCommit: string
  headCommit: string
  path: string
  branch: string | null
  changedPaths: string[]
  verification: ReviewVerification[]
  previousRequestId: string | null
}

/** One review request file (`reviews/<topicId>-<requestId>.json`). */
export interface ReviewRequestRecord extends ReviewRequestDraft {
  version: 1
  requestId: string
  status: ReviewStatus
  reviewerSessionId: string | null
  requestedAt: string
  reviewedAt: string | null
  summary: string | null
  findings: ReviewFinding[]
  reviewVerification: ReviewVerification[]
}

/** What the caller knows about the request before the model's input is read. */
export interface ReviewRequestValidationOptions {
  /** Topic the request belongs to (from the index, never the model). */
  topicId: string
  /** Work item under review, or null for a shared-tree request. */
  workItemId: string | null
  /** Absolute repository root the request must stay inside. */
  repoPath: string
  /** Absolute work-item checkout the request may point at, when any. */
  workItemPath?: string | null
  /** Branch the request reviews, derived from git. */
  branch?: string | null
  /** Paths `git diff base..head` reported; derived, never trusted from input. */
  changedPaths?: readonly string[]
}

/** Result of validating untrusted review-request input. */
export type ReviewRequestValidation =
  | { ok: true; value: ReviewRequestDraft }
  | { ok: false; code: string; message: string; errors: ReviewFieldError[] }

/** Result of parsing one stored request file. */
export type ReviewRequestParse =
  | { ok: true; record: ReviewRequestRecord }
  | { ok: false; problems: string[] }

/** The plugin-supplied identity of one request. */
export interface ReviewRequestStamp {
  /** Freshly generated id (a UUID in production). */
  requestId: string
  /** Session of the reviewer that must answer this request. */
  reviewerSessionId: string
  /** When the request was accepted. */
  requestedAt: Date
}

/** Everything the previous-request chain check needs. */
export interface PreviousRequestLookup {
  previousRequestId: string | null
  previous: ReviewRequestRecord | null
  topicId: string
  workItemId: string | null
}

/** Where one verdict moves the topic, and whether it wakes the master. */
export interface ReviewOutcome {
  /** Review state the topic records. */
  reviewStatus: ReviewStatus
  /** Whether the topic must be marked blocked. */
  blocked: boolean
  /** A verdict always clears the in-flight marker. */
  awaitingReview: false
  /** Whether the findings are delivered back to the topic session. */
  deliverToTopic: boolean
  /** Inbox kind for the master, or null when the master must not be woken. */
  inboxKind: InboxKind | null
  /** Whether the work item enters the master's merge queue. */
  mergeNeeded: boolean
}

/** Everything the merge gate reads. */
export interface MergeGateInput {
  /** The request the merge would rely on, or null when none was found. */
  request: ReviewRequestRecord | null
  /** Current HEAD of the repository the merge would land in. */
  headCommit: string | null
  /** Whether `request.baseCommit` is an ancestor of `headCommit` (git answered). */
  baseIsAncestor: boolean
  /** Current status of the request's work item, or null when it is unknown. */
  workItemStatus: WorkItemStatus | null
  /** Whether the work-item checkout has no uncommitted change. */
  workTreeClean: boolean
}

/** The merge decision: allowed, or a refusal the caller returns as-is. */
export type MergeGateResult = { ok: true } | { ok: false; failure: ToolFailure }

/** What the reviewer briefing needs. */
export interface ReviewBriefInput {
  /** The pending request the reviewer must answer. */
  request: ReviewRequestRecord
  /** The previous terminal request of the same topic/work item, when any. */
  previous?: ReviewRequestRecord | null
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** Whether a value is a JSON object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Cut text to at most `limit` Unicode code points without splitting a pair. */
function cut(text: string, limit: number): string {
  if (limit <= 0) return ''
  const points = Array.from(text)
  return points.length <= limit ? text : points.slice(0, limit).join('')
}

/** Whether a value is one of the given wire values. */
function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

/** Whether a value is a commit id this model accepts. */
function isCommit(value: unknown): value is string {
  return typeof value === 'string' && COMMIT_PATTERN.test(value)
}

/** Whether a value is a non-empty string within `limit` characters. */
function isBoundedText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= limit
}

/** Whether a value may be used as one dash-joined component of a file name. */
export function isSafeFileNamePart(value: unknown): value is string {
  if (typeof value !== 'string' || !REVIEW_REQUEST_ID_PATTERN.test(value)) return false
  return value !== '.' && value !== '..'
}

/** Whether a value is a usable review request id. */
export function isValidReviewRequestId(value: unknown): value is string {
  return isSafeFileNamePart(value)
}

/** Whether `candidate` is `root` itself or lives under it. */
function isInsidePath(root: string, candidate: string): boolean {
  const rel = relative(normalize(root), normalize(candidate))
  if (rel === '') return true
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/** Read one required bounded string field. */
function readRequiredText(
  input: Record<string, unknown>,
  field: string,
  limit: number,
  errors: ReviewFieldError[],
): string {
  const value = input[field]
  if (!isBoundedText(value, limit)) {
    errors.push({ field, message: `${field} must be a non-empty string of at most ${limit} characters` })
    return ''
  }
  return value
}

/** Read one optional bounded string field; absent means the empty string. */
function readOptionalText(
  input: Record<string, unknown>,
  field: string,
  limit: number,
  errors: ReviewFieldError[],
): string {
  const value = input[field]
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string' || value.length > limit) {
    errors.push({ field, message: `${field} must be a string of at most ${limit} characters` })
    return ''
  }
  return value
}

/** Collect the problems of one JSON value against the `extra` bounds. */
function jsonProblems(value: unknown, where: string, depth: number): string[] {
  if (Array.isArray(value) || isRecord(value)) {
    if (depth > REVIEW_EXTRA_MAX_DEPTH) {
      return [`${where} nests deeper than ${REVIEW_EXTRA_MAX_DEPTH} containers`]
    }
    const problems: string[] = []
    if (Array.isArray(value)) {
      value.forEach((item, index) => problems.push(...jsonProblems(item, `${where}[${index}]`, depth + 1)))
      return problems
    }
    for (const key of Object.keys(value)) {
      problems.push(...jsonProblems(value[key], `${where}.${key}`, depth + 1))
    }
    return problems
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return []
  if (typeof value === 'number') {
    return Number.isFinite(value) ? [] : [`${where} must be a finite number`]
  }
  return [`${where} must be a JSON value (not undefined, a function, a symbol, or a bigint)`]
}

/** Collect the problems of the `extra` object, field by field. */
function extraProblems(value: unknown, where: string, errors: ReviewFieldError[]): Record<string, JsonValue> {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) {
    errors.push({ field: where, message: `${where} must be a JSON object` })
    return {}
  }
  const keys = Object.keys(value)
  if (keys.length > REVIEW_EXTRA_MAX_KEYS) {
    errors.push({ field: where, message: `${where} must carry at most ${REVIEW_EXTRA_MAX_KEYS} keys` })
    return {}
  }
  for (const key of keys) {
    const field = `${where}.${key}`
    if (key === '' || key.length > REVIEW_EXTRA_KEY_MAX_CHARS) {
      errors.push({ field, message: `${field} must be a key of 1..${REVIEW_EXTRA_KEY_MAX_CHARS} characters` })
      continue
    }
    const problems = jsonProblems(value[key], field, 1)
    let bytes = 0
    try {
      bytes = Buffer.byteLength(JSON.stringify(value[key]) ?? '', 'utf8')
    } catch {
      problems.push(`${field} must be serializable JSON`)
    }
    if (bytes > REVIEW_EXTRA_MAX_BYTES) {
      problems.push(`${field} serializes to ${bytes} B, over the ${REVIEW_EXTRA_MAX_BYTES} B bound`)
    }
    for (const problem of problems) errors.push({ field, message: problem })
  }
  return value as Record<string, JsonValue>
}

/** How one array field is required. */
interface ArrayFieldRule {
  /** Whether the field must be present at all. */
  required: boolean
  /** Whether an empty array is a problem. */
  nonEmpty: boolean
}

/** Collect the problems of one verification array, keeping only complete rows. */
function verificationProblems(
  value: unknown,
  where: string,
  errors: ReviewFieldError[],
  rule: ArrayFieldRule,
): ReviewVerification[] {
  if (value === undefined || value === null) {
    if (rule.required) errors.push({ field: where, message: `${where} must be an array` })
    return []
  }
  if (!Array.isArray(value)) {
    errors.push({ field: where, message: `${where} must be an array` })
    return []
  }
  if (rule.nonEmpty && value.length === 0) {
    errors.push({ field: where, message: `${where} must not be empty` })
    return []
  }
  if (value.length > REVIEW_VERIFICATION_MAX_ROWS) {
    errors.push({ field: where, message: `${where} must carry at most ${REVIEW_VERIFICATION_MAX_ROWS} rows` })
    return []
  }
  const rows: ReviewVerification[] = []
  value.forEach((row, position) => {
    const field = `${where}[${position}]`
    if (!isRecord(row)) {
      errors.push({ field, message: `${field} must be an object` })
      return
    }
    let wellFormed = true
    if (!isBoundedText(row.command, REVIEW_VERIFICATION_FIELD_MAX_CHARS)) {
      errors.push({ field: `${field}.command`, message: 'command must be a non-empty string within the bound' })
      wellFormed = false
    }
    if (!Number.isInteger(row.exitCode)) {
      errors.push({ field: `${field}.exitCode`, message: 'exitCode must be an integer' })
      wellFormed = false
    }
    if (typeof row.evidence !== 'string' || row.evidence.length > REVIEW_VERIFICATION_FIELD_MAX_CHARS) {
      errors.push({ field: `${field}.evidence`, message: 'evidence must be a string within the bound' })
      wellFormed = false
    }
    if (wellFormed) {
      rows.push({
        command: row.command as string,
        exitCode: row.exitCode as number,
        evidence: row.evidence as string,
      })
    }
  })
  return rows
}

/** Collect the problems of one findings array, keeping only complete rows. */
function findingsProblems(
  value: unknown,
  where: string,
  errors: ReviewFieldError[],
): ReviewFinding[] {
  if (!Array.isArray(value)) {
    errors.push({ field: where, message: `${where} must be an array` })
    return []
  }
  if (value.length > REVIEW_FINDINGS_MAX_ROWS) {
    errors.push({ field: where, message: `${where} must carry at most ${REVIEW_FINDINGS_MAX_ROWS} rows` })
    return []
  }
  const findings: ReviewFinding[] = []
  value.forEach((row, position) => {
    const field = `${where}[${position}]`
    if (!isRecord(row)) {
      errors.push({ field, message: `${field} must be an object` })
      return
    }
    let wellFormed = true
    for (const key of ['id', 'problem', 'requiredFix'] as const) {
      if (!isBoundedText(row[key], REVIEW_FINDING_FIELD_MAX_CHARS)) {
        errors.push({ field: `${field}.${key}`, message: `${key} must be a non-empty string within the bound` })
        wellFormed = false
      }
    }
    if (!isOneOf(row.severity, REVIEW_SEVERITIES)) {
      errors.push({ field: `${field}.severity`, message: `severity must be one of ${REVIEW_SEVERITIES.join('|')}` })
      wellFormed = false
    }
    let file: string | undefined
    if (row.file !== undefined && row.file !== null) {
      if (!isBoundedText(row.file, REVIEW_PATH_MAX_CHARS)) {
        errors.push({ field: `${field}.file`, message: 'file must be a non-empty bounded string when present' })
        wellFormed = false
      } else {
        file = row.file
      }
    }
    let line: number | undefined
    if (row.line !== undefined && row.line !== null) {
      if (!Number.isInteger(row.line) || (row.line as number) < 1) {
        errors.push({ field: `${field}.line`, message: 'line must be a positive integer when present' })
        wellFormed = false
      } else {
        line = row.line as number
      }
    }
    if (wellFormed) {
      const finding: ReviewFinding = {
        id: row.id as string,
        severity: row.severity as ReviewSeverity,
        problem: row.problem as string,
        requiredFix: row.requiredFix as string,
      }
      if (file !== undefined) finding.file = file
      if (line !== undefined) finding.line = line
      findings.push(finding)
    }
  })
  return findings
}

/** Collect the problems of the derived changed-path list. */
function changedPathsProblems(
  value: readonly string[] | undefined,
  errors: ReviewFieldError[],
): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > REVIEW_CHANGED_PATHS_MAX) {
    errors.push({
      field: 'changedPaths',
      message: `changedPaths must be an array of at most ${REVIEW_CHANGED_PATHS_MAX} paths`,
    })
    return []
  }
  for (const path of value) {
    if (!isBoundedText(path, REVIEW_PATH_MAX_CHARS)) {
      errors.push({ field: 'changedPaths', message: 'every changed path must be a non-empty bounded string' })
      return []
    }
  }
  return [...value]
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

/**
 * Validate untrusted `cowork_review_request` input against the trusted scope the
 * tool derived from the index and git.
 *
 * Every problem is collected before refusing, so one call names every field the
 * model must fix. Nothing is written here: a refused request leaves no file, no
 * reviewer, and no index change behind.
 */
export function validateReviewRequestInput(
  input: unknown,
  options: ReviewRequestValidationOptions,
): ReviewRequestValidation {
  if (!isRecord(input)) {
    return refuse([{ field: 'input', message: 'review request input must be an object' }])
  }
  const errors: ReviewFieldError[] = []

  const topicId = options.topicId
  if (!isSafeFileNamePart(topicId)) {
    errors.push({ field: 'topicId', message: 'topicId must be usable in a file name' })
  }
  const workItemId = options.workItemId
  if (workItemId !== null && !isValidWorkItemId(workItemId)) {
    errors.push({ field: 'workItemId', message: 'workItemId is not a usable work-item id' })
  }
  if (typeof options.repoPath !== 'string' || !isAbsolute(options.repoPath)) {
    errors.push({ field: 'repoPath', message: 'repoPath must be an absolute path' })
  }

  const purpose = readRequiredText(input, 'purpose', REVIEW_PURPOSE_MAX_CHARS, errors)
  const notes = readOptionalText(input, 'notes', REVIEW_NOTES_MAX_CHARS, errors)
  const extra = extraProblems(input.extra, 'extra', errors)

  const baseCommit = readRequiredText(input, 'baseCommit', 64, errors)
  const headCommit = readRequiredText(input, 'headCommit', 64, errors)
  for (const [field, value] of [['baseCommit', baseCommit], ['headCommit', headCommit]] as const) {
    if (value !== '' && !isCommit(value)) {
      errors.push({ field, message: `${field} must be a commit id` })
    }
  }
  const sameCommit = baseCommit !== '' && baseCommit === headCommit

  const rawPath = input.path
  let path = ''
  let pathOutside = false
  if (!isBoundedText(rawPath, REVIEW_PATH_MAX_CHARS)) {
    errors.push({ field: 'path', message: `path must be a non-empty string of at most ${REVIEW_PATH_MAX_CHARS} characters` })
  } else if (!isAbsolute(rawPath) || CONTROL_CHARACTERS.test(rawPath)) {
    errors.push({ field: 'path', message: 'path must be an absolute path without control characters' })
    pathOutside = true
  } else {
    path = normalize(rawPath)
    const workItemPath = options.workItemPath ?? null
    const insideRepo = typeof options.repoPath === 'string' && isAbsolute(options.repoPath)
      && isInsidePath(options.repoPath, path)
    const insideWorkItem = workItemPath !== null && isAbsolute(workItemPath) && isInsidePath(workItemPath, path)
    if (!insideRepo && !insideWorkItem) {
      errors.push({ field: 'path', message: 'path must be the repository root, a work-item checkout, or inside one of them' })
      pathOutside = true
    }
  }

  const verification = verificationProblems(input.verification, 'verification', errors, {
    required: true,
    nonEmpty: true,
  })

  let branch: string | null = options.branch ?? null
  if (branch !== null) {
    if (!isBoundedText(branch, REVIEW_BRANCH_MAX_CHARS)) {
      errors.push({ field: 'branch', message: `branch must be a non-empty string of at most ${REVIEW_BRANCH_MAX_CHARS} characters` })
      branch = null
    }
  }

  const changedPaths = changedPathsProblems(options.changedPaths, errors)

  let previousRequestId: string | null = null
  const rawPreviousRequestId = input.previousRequestId
  if (rawPreviousRequestId !== undefined && rawPreviousRequestId !== null) {
    if (isValidReviewRequestId(rawPreviousRequestId)) {
      previousRequestId = rawPreviousRequestId
    } else {
      errors.push({ field: 'previousRequestId', message: 'previousRequestId must be a usable request id' })
    }
  }

  if (sameCommit) {
    errors.push({ field: 'headCommit', message: 'headCommit must differ from baseCommit' })
  }

  if (errors.length > 0) {
    const code = pathOutside
      ? M10_ERROR_CODES.reviewPathOutside
      : sameCommit
        ? M10_ERROR_CODES.reviewBaseEqualsHead
        : M10_ERROR_CODES.reviewRequestInvalid
    return {
      ok: false,
      code,
      message: pathOutside
        ? 'the review path is outside the repository and its work-item checkouts'
        : sameCommit
          ? 'baseCommit and headCommit must differ'
          : 'the review request is invalid',
      errors,
    }
  }
  return {
    ok: true,
    value: {
      topicId,
      workItemId,
      purpose,
      notes,
      extra,
      baseCommit,
      headCommit,
      path,
      branch,
      changedPaths,
      verification,
      previousRequestId,
    },
  }
}

/** Build the refusal of a validation with no scope-level problem. */
function refuse(errors: ReviewFieldError[]): ReviewRequestValidation {
  return {
    ok: false,
    code: M10_ERROR_CODES.reviewRequestInvalid,
    message: 'the review request is invalid',
    errors,
  }
}

// ---------------------------------------------------------------------------
// verdict validation
// ---------------------------------------------------------------------------

/** A validated verdict, before it is stamped into the request file. */
export interface ReviewVerdictDraft {
  requestId: string
  verdict: ReviewVerdict
  summary: string
  findings: ReviewFinding[]
  verification: ReviewVerification[]
}

/** Result of validating untrusted `cowork_review_verdict` input. */
export type ReviewVerdictValidation =
  | { ok: true; value: ReviewVerdictDraft }
  | { ok: false; code: string; message: string; errors: ReviewFieldError[] }

/**
 * Validate untrusted verdict input, collecting every field problem at once. The
 * request id and the reviewer session are bound by the tool against the stored
 * request, not trusted from the model. `needs_revision` and `reject` must name
 * at least one finding (the topic has to know what to fix); `pass` may carry
 * none.
 */
export function validateReviewVerdictInput(input: unknown): ReviewVerdictValidation {
  if (!isRecord(input)) {
    return {
      ok: false,
      code: ERROR_CODES.reviewVerdictInvalid,
      message: 'the review verdict is invalid',
      errors: [{ field: 'input', message: 'review verdict input must be an object' }],
    }
  }
  const errors: ReviewFieldError[] = []
  const requestId = readRequiredText(input, 'requestId', 128, errors)
  if (requestId !== '' && !isValidReviewRequestId(requestId)) {
    errors.push({ field: 'requestId', message: 'requestId must be a file-name-safe request id' })
  }
  let verdict: ReviewVerdict = 'needs_revision'
  let verdictKnown = false
  if (isOneOf(input.verdict, REVIEW_VERDICTS)) {
    verdict = input.verdict
    verdictKnown = true
  } else {
    errors.push({ field: 'verdict', message: `verdict must be one of ${REVIEW_VERDICTS.join('|')} (pending is not a verdict)` })
  }
  const summary = readRequiredText(input, 'summary', REVIEW_SUMMARY_MAX_CHARS, errors)
  const findings: ReviewFinding[] = input.findings === undefined || input.findings === null
    ? []
    : findingsProblems(input.findings, 'findings', errors)
  const verification = verificationProblems(input.verification, 'verification', errors, {
    required: false,
    nonEmpty: false,
  })
  if (verdictKnown && verdict !== 'pass' && findings.length === 0) {
    errors.push({ field: 'findings', message: `${verdict} requires at least one finding naming what to fix` })
  }
  if (errors.length > 0) {
    return {
      ok: false,
      code: ERROR_CODES.reviewVerdictInvalid,
      message: 'the review verdict is invalid',
      errors,
    }
  }
  return { ok: true, value: { requestId, verdict, summary, findings, verification } }
}

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

/**
 * Stamp a validated draft into the pending record the tool writes. The status
 * is always `pending`: a verdict rewrites the same file through the record's
 * terminal shape. A programmer error in the stamp throws rather than writing a
 * record the parser would refuse.
 */
export function buildReviewRequestRecord(
  draft: ReviewRequestDraft,
  stamp: ReviewRequestStamp,
): ReviewRequestRecord {
  if (!isValidReviewRequestId(stamp.requestId)) {
    throw new TypeError(`requestId ${String(stamp.requestId)} must match ${REVIEW_REQUEST_ID_PATTERN}`)
  }
  if (!isBoundedText(stamp.reviewerSessionId, 256)) {
    throw new TypeError('reviewerSessionId must be a non-empty session id')
  }
  return {
    version: REVIEW_REQUEST_VERSION,
    ...draft,
    requestId: stamp.requestId,
    status: 'pending',
    reviewerSessionId: stamp.reviewerSessionId,
    requestedAt: stamp.requestedAt.toISOString(),
    reviewedAt: null,
    summary: null,
    findings: [],
    reviewVerification: [],
  }
}

/** Serialize one request record the way the file layer writes it. */
export function serializeReviewRequestRecord(record: ReviewRequestRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`
}

/**
 * Every schema problem of one stored request record. Strict by design: the file
 * this plugin writes must be as strict as the input that produced it, and the
 * legacy verdict-only record (a different shape with the same version) must be
 * refused instead of partially read.
 */
export function reviewRequestRecordProblems(record: unknown): string[] {
  if (!isRecord(record)) return ['review must be a JSON object']
  const problems: string[] = []
  if (record.version !== REVIEW_REQUEST_VERSION) {
    problems.push(`review.version must be ${REVIEW_REQUEST_VERSION}`)
  }
  if (!isValidReviewRequestId(record.requestId)) {
    problems.push('review.requestId must be a file-name-safe request id')
  }
  if (!isSafeFileNamePart(record.topicId)) {
    problems.push('review.topicId must be a file-name-safe topic id')
  }
  if (record.workItemId !== null && !isValidWorkItemId(record.workItemId)) {
    problems.push('review.workItemId must be a work-item id or null')
  }
  if (!isBoundedText(record.purpose, REVIEW_PURPOSE_MAX_CHARS)) {
    problems.push(`review.purpose must be a non-empty string of at most ${REVIEW_PURPOSE_MAX_CHARS} characters`)
  }
  if (typeof record.notes !== 'string' || record.notes.length > REVIEW_NOTES_MAX_CHARS) {
    problems.push(`review.notes must be a string of at most ${REVIEW_NOTES_MAX_CHARS} characters`)
  }
  if (!isRecord(record.extra)) {
    problems.push('review.extra must be a JSON object')
  } else {
    const extraErrors: ReviewFieldError[] = []
    extraProblems(record.extra, 'review.extra', extraErrors)
    for (const error of extraErrors) problems.push(`${error.field}: ${error.message}`)
  }

  for (const field of ['baseCommit', 'headCommit'] as const) {
    if (!isCommit(record[field])) problems.push(`review.${field} must be a commit id`)
  }
  if (!isBoundedText(record.path, REVIEW_PATH_MAX_CHARS) || !isAbsolute(record.path as string) || CONTROL_CHARACTERS.test(record.path as string)) {
    problems.push('review.path must be an absolute bounded path without control characters')
  }
  if (record.branch !== null && !isBoundedText(record.branch, REVIEW_BRANCH_MAX_CHARS)) {
    problems.push(`review.branch must be a non-empty string of at most ${REVIEW_BRANCH_MAX_CHARS} characters or null`)
  }
  if (!Array.isArray(record.changedPaths)) {
    problems.push('review.changedPaths must be an array of paths')
  } else {
    const changedErrors: ReviewFieldError[] = []
    changedPathsProblems(record.changedPaths as readonly string[] | undefined, changedErrors)
    for (const error of changedErrors) problems.push(`${error.field}: ${error.message}`)
  }

  const verificationErrors: ReviewFieldError[] = []
  verificationProblems(record.verification, 'review.verification', verificationErrors, {
    required: true,
    nonEmpty: true,
  })
  for (const error of verificationErrors) problems.push(`${error.field}: ${error.message}`)

  if (record.previousRequestId !== null && !isValidReviewRequestId(record.previousRequestId)) {
    problems.push('review.previousRequestId must be a file-name-safe request id or null')
  }
  if (!isOneOf(record.status, REVIEW_STATUSES)) {
    problems.push(`review.status must be one of ${REVIEW_STATUSES.join('|')}`)
    return problems
  }
  if (!isBoundedText(record.reviewerSessionId, 256)) {
    problems.push('review.reviewerSessionId must be a non-empty session id')
  }
  if (typeof record.requestedAt !== 'string' || Number.isNaN(Date.parse(record.requestedAt))) {
    problems.push('review.requestedAt must be an ISO 8601 timestamp')
  }

  const pending = record.status === 'pending'
  if (pending) {
    if (record.reviewedAt !== null) problems.push('review.reviewedAt must be null while the request is pending')
    if (record.summary !== null) problems.push('review.summary must be null while the request is pending')
  } else {
    if (typeof record.reviewedAt !== 'string' || Number.isNaN(Date.parse(record.reviewedAt))) {
      problems.push('review.reviewedAt must be an ISO 8601 timestamp once the request is answered')
    }
    if (!isBoundedText(record.summary, REVIEW_SUMMARY_MAX_CHARS)) {
      problems.push(`review.summary must be a non-empty string of at most ${REVIEW_SUMMARY_MAX_CHARS} characters once the request is answered`)
    }
  }

  const findingErrors: ReviewFieldError[] = []
  const findings = findingsProblems(record.findings, 'review.findings', findingErrors)
  for (const error of findingErrors) problems.push(`${error.field}: ${error.message}`)
  if (!pending && record.status !== 'pass' && findings.length === 0) {
    problems.push(`review.findings must not be empty for ${record.status}`)
  }
  const reviewVerificationErrors: ReviewFieldError[] = []
  verificationProblems(record.reviewVerification, 'review.reviewVerification', reviewVerificationErrors, {
    required: true,
    nonEmpty: false,
  })
  for (const error of reviewVerificationErrors) problems.push(`${error.field}: ${error.message}`)

  return problems
}

/**
 * Parse one request file. A missing field, an unknown status, a pending record
 * that carries a verdict, an answered record without a review timestamp, or the
 * legacy verdict-only record all refuse with the problems named; nothing is
 * repaired or guessed.
 */
export function parseReviewRequestRecord(text: string): ReviewRequestParse {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return { ok: false, problems: ['review file is not valid JSON'] }
  }
  const problems = reviewRequestRecordProblems(parsed)
  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, record: parsed as ReviewRequestRecord }
}

/** File name of one request, or null when an id cannot be a file name. */
export function reviewRequestFileName(topicId: string, requestId: string): string | null {
  if (!isSafeFileNamePart(topicId) || !isValidReviewRequestId(requestId)) return null
  return `${topicId}-${requestId}${REVIEW_REQUEST_FILE_SUFFIX}`
}

/** Absolute file path of one request under the reviews directory, or null. */
export function reviewRequestFilePath(
  reviewsDir: string,
  topicId: string,
  requestId: string,
): string | null {
  const fileName = reviewRequestFileName(topicId, requestId)
  if (fileName === null) return null
  if (typeof reviewsDir !== 'string' || reviewsDir === '') return null
  return join(reviewsDir, fileName)
}

// ---------------------------------------------------------------------------
// previous request chain
// ---------------------------------------------------------------------------

/**
 * Check the `previousRequestId` a re-review references. It must exist, belong to
 * the same topic and the same work item (a shared-tree request and a work-item
 * request are different chains), and already be answered: a pending predecessor
 * means two reviewers would judge the same range without a result.
 */
export function checkPreviousRequest(input: PreviousRequestLookup): ToolFailure | null {
  if (input.previousRequestId === null) return null
  const details = {
    previousRequestId: input.previousRequestId,
    topicId: input.topicId,
    workItemId: input.workItemId,
  }
  const previous = input.previous
  if (previous === null) {
    return failure(
      M10_ERROR_CODES.reviewPreviousInvalid,
      `previousRequestId ${input.previousRequestId} does not name a stored review request`,
      details,
    )
  }
  if (previous.requestId !== input.previousRequestId) {
    return failure(
      M10_ERROR_CODES.reviewPreviousInvalid,
      `previousRequestId ${input.previousRequestId} resolved to request ${previous.requestId}`,
      details,
    )
  }
  if (previous.topicId !== input.topicId) {
    return failure(
      M10_ERROR_CODES.reviewPreviousInvalid,
      `previousRequestId ${previous.requestId} belongs to topic ${previous.topicId}, not ${input.topicId}`,
      details,
    )
  }
  if (previous.workItemId !== input.workItemId) {
    return failure(
      M10_ERROR_CODES.reviewPreviousInvalid,
      `previousRequestId ${previous.requestId} reviews work item ${String(previous.workItemId)}, not ${String(input.workItemId)}`,
      details,
    )
  }
  if (previous.status === 'pending') {
    return failure(
      M10_ERROR_CODES.reviewPreviousInvalid,
      `previousRequestId ${previous.requestId} is still pending; wait for its verdict before requesting another review`,
      details,
    )
  }
  return null
}

// ---------------------------------------------------------------------------
// outcome
// ---------------------------------------------------------------------------

/**
 * Where one verdict moves the topic and whom it wakes. `needs_revision` goes
 * back to the topic only — the master is not woken by a round the topic can
 * handle. `pass` wakes the master only when a work item must be merged (a
 * shared-tree pass just confirms the delivery). `reject` blocks the topic and
 * wakes the master.
 */
export function deriveReviewOutcome(verdict: ReviewVerdict, workItemId: string | null): ReviewOutcome {
  if (verdict === 'needs_revision') {
    return {
      reviewStatus: 'needs_revision',
      blocked: false,
      awaitingReview: false,
      deliverToTopic: true,
      inboxKind: null,
      mergeNeeded: false,
    }
  }
  if (verdict === 'reject') {
    return {
      reviewStatus: 'reject',
      blocked: true,
      awaitingReview: false,
      deliverToTopic: true,
      inboxKind: 'review-reject',
      mergeNeeded: false,
    }
  }
  const mergeNeeded = workItemId !== null
  return {
    reviewStatus: 'pass',
    blocked: false,
    awaitingReview: false,
    deliverToTopic: false,
    inboxKind: mergeNeeded ? 'merge-needed' : null,
    mergeNeeded,
  }
}

// ---------------------------------------------------------------------------
// merge gate
// ---------------------------------------------------------------------------

/**
 * Decide whether a review request allows a merge, before any git write. The
 * request must have passed, the head that passed must still be the head being
 * merged, its base must still be an ancestor, the work item must be in the
 * mergeable state, and the checkout must be clean. Each refusal carries its
 * stable code; the caller returns the failure unchanged.
 */
export function mergeGate(input: MergeGateInput): MergeGateResult {
  const { request } = input
  if (request === null) {
    return {
      ok: false,
      failure: failure(M10_ERROR_CODES.reviewRequestNotFound, 'no review request matches this merge', {}),
    }
  }
  const details = {
    requestId: request.requestId,
    topicId: request.topicId,
    workItemId: request.workItemId,
    reviewedHead: request.headCommit,
    currentHead: input.headCommit,
  }
  if (request.status !== 'pass') {
    return {
      ok: false,
      failure: failure(
        ERROR_CODES.reviewNotPassed,
        `review request ${request.requestId} is ${request.status}; only a passed review may be merged`,
        details,
      ),
    }
  }
  if (request.workItemId === null) {
    return {
      ok: false,
      failure: failure(
        M10_ERROR_CODES.workItemNotFound,
        `review request ${request.requestId} reviewed the shared work tree, so there is no work item to merge`,
        details,
      ),
    }
  }
  if (input.workItemStatus === null) {
    return {
      ok: false,
      failure: failure(
        M10_ERROR_CODES.workItemNotFound,
        `work item ${request.workItemId} of review request ${request.requestId} is not in the project index`,
        details,
      ),
    }
  }
  if (!isMergeableWorkItemStatus(input.workItemStatus)) {
    return {
      ok: false,
      failure: failure(
        M10_ERROR_CODES.workItemNotReady,
        `work item ${request.workItemId} is ${input.workItemStatus}; only a reviewing work item may be merged`,
        details,
      ),
    }
  }
  if (input.headCommit === null || input.headCommit !== request.headCommit) {
    return {
      ok: false,
      failure: failure(
        M10_ERROR_CODES.checkoutHeadMismatch,
        `the reviewed head ${request.headCommit} is not the current head ${String(input.headCommit)}; the work moved after the review, so request another review`,
        details,
      ),
    }
  }
  if (!input.baseIsAncestor) {
    return {
      ok: false,
      failure: failure(
        M10_ERROR_CODES.reviewBaseNotAncestor,
        `base ${request.baseCommit} is no longer an ancestor of head ${request.headCommit}`,
        details,
      ),
    }
  }
  if (!input.workTreeClean) {
    return {
      ok: false,
      failure: failure(
        M10_ERROR_CODES.reviewDirtyWorktree,
        `the work item checkout of ${request.workItemId} has uncommitted changes; commit or discard them before merging`,
        details,
      ),
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// reviewer brief
// ---------------------------------------------------------------------------

/** One finding as the brief shows it, bounded. */
function findingLine(finding: ReviewFinding): string {
  const where =
    finding.file !== undefined && finding.line !== undefined
      ? ` at ${finding.file}:${finding.line}`
      : finding.file !== undefined
        ? ` at ${finding.file}`
        : ''
  return `- ${finding.id} [${finding.severity}] ${finding.problem} | required fix: ${finding.requiredFix}${where}`
}

/**
 * The opener for a new reviewer session. It carries the requested scope (the
 * purpose, the two commits, the path, the branch, the changed paths, and the
 * checks the requester ran), the previous round's summary and findings when a
 * re-review follows one, the read-only rule, and the one tool call the reviewer
 * must make. It never carries a handoff body: the request is the unit of review.
 *
 * The body is built within a budget that reserves the closing instructions, and
 * every line is bounded, so the result is at most
 * {@link REVIEW_BRIEF_MAX_CHARS} characters even for a maximal request.
 */
export function buildReviewBrief(input: ReviewBriefInput): string {
  const request = input.request
  const previous = input.previous ?? null
  const tail = [
    'Read-only rules: do not modify implementation files, do not stage or commit, do not create or prompt other sessions, and do not merge.',
    `When the review is finished, call cowork_review_verdict exactly once with requestId ${request.requestId}, verdict (${REVIEW_VERDICTS.join('|')}), a summary, findings, and verification (the commands you actually ran). needs_revision and reject require at least one finding naming id, severity (${REVIEW_SEVERITIES.join('|')}), problem, and requiredFix.`,
  ].join('\n')

  const lines: string[] = []
  let used = 0
  const budget = REVIEW_BRIEF_MAX_CHARS - tail.length - 1
  const push = (line: string): boolean => {
    const text = cut(line, REVIEW_BRIEF_LINE_MAX_CHARS)
    if (used + text.length + (lines.length === 0 ? 0 : 1) > budget) return false
    used += text.length + (lines.length === 0 ? 0 : 1)
    lines.push(text)
    return true
  }

  push(
    `You are the independent reviewer of cowork review request ${request.requestId} of topic ${request.topicId}`
      + `${request.workItemId === null ? ' (shared work tree)' : ` (work item ${request.workItemId})`}.`,
  )
  push(`Purpose: ${request.purpose}`)
  push(
    `Review range: base ${request.baseCommit} .. head ${request.headCommit}; ${request.changedPaths.length} changed file(s).`,
  )
  push(`Review path: ${request.path}${request.branch === null ? '' : ` (branch ${request.branch})`}.`)

  if (request.changedPaths.length === 0) {
    push('Changed paths reported by git: none recorded.')
  } else {
    push('Changed paths reported by git (the review scope):')
    for (const path of request.changedPaths.slice(0, REVIEW_BRIEF_MAX_PATHS_SHOWN)) {
      if (!push(`- ${path}`)) break
    }
    if (request.changedPaths.length > REVIEW_BRIEF_MAX_PATHS_SHOWN) {
      push(
        `- ... and ${request.changedPaths.length - REVIEW_BRIEF_MAX_PATHS_SHOWN} more changed path(s); see git diff ${request.baseCommit}..${request.headCommit}.`,
      )
    }
  }

  push('Verification the requester ran (re-run these yourself; do not trust them):')
  for (const row of request.verification.slice(0, REVIEW_BRIEF_MAX_ROWS_SHOWN)) {
    if (!push(`- ${row.command} (exit ${row.exitCode}): ${row.evidence}`)) break
  }

  if (previous !== null) {
    push(
      `Previous review request ${previous.requestId} returned ${previous.status}: ${previous.summary ?? 'no summary recorded'}.`,
    )
    for (const finding of previous.findings.slice(0, REVIEW_BRIEF_MAX_FINDINGS_SHOWN)) {
      if (!push(findingLine(finding))) break
    }
  }

  return `${lines.join('\n')}\n${tail}`
}

// ---------------------------------------------------------------------------
// messages to the topic
// ---------------------------------------------------------------------------

/** Hard ceiling of a verdict message to the topic, in characters. */
export const REVIEW_MESSAGE_MAX_CHARS = 4000

/** Render the findings of one answered request within `budget` characters. */
function findingLines(record: ReviewRequestRecord, budget: number): string[] {
  const lines: string[] = []
  let used = 0
  for (const finding of record.findings) {
    const line = cut(findingLine(finding), REVIEW_BRIEF_LINE_MAX_CHARS)
    if (used + line.length + 1 > budget) {
      lines.push(cut('- ... more findings in the review request file', Math.max(budget - used, 0)))
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  return lines
}

/** Build one bounded message for the topic: decision, findings, next step. */
function topicMessage(
  record: ReviewRequestRecord,
  opener: string,
  next: string,
): string {
  const head = [opener, `Summary: ${record.summary ?? 'no summary recorded'}`].join('\n')
  const reserve = Math.min(next.length + 32, REVIEW_MESSAGE_MAX_CHARS - head.length - 2)
  const lines = findingLines(record, Math.max(REVIEW_MESSAGE_MAX_CHARS - head.length - reserve - 2, 0))
  const body = lines.length === 0 ? [head, 'Findings: none recorded.'] : [head, 'Findings:', ...lines]
  return cut([...body, next].join('\n'), REVIEW_MESSAGE_MAX_CHARS)
}

/** The message a `needs_revision` verdict sends back to the topic. */
export function buildRevisionMessage(record: ReviewRequestRecord): string {
  return topicMessage(
    record,
    `The independent review of topic ${record.topicId} returned needs_revision (review request ${record.requestId}).`,
    `Fix every finding in your own work area, re-run the verification you report, then call cowork_review_request again with previousRequestId ${record.requestId}.`,
  )
}

/** The message a `reject` verdict sends to the blocked topic. */
export function buildRejectMessage(record: ReviewRequestRecord): string {
  return topicMessage(
    record,
    `The independent review of topic ${record.topicId} returned reject (review request ${record.requestId}); the topic is blocked.`,
    'Do not start another review of this range: the master decides whether to replan the work. Fixing the findings still requires a new request.',
  )
}

// ---------------------------------------------------------------------------
// legacy thread merge gate (the last thread clone is removed in M11/M12)
// ---------------------------------------------------------------------------

/** The legacy merge decision: allowed, or the refusal the caller returns as-is. */
export type LegacyMergePlan = { ok: true } | { ok: false; failure: ToolFailure }

/**
 * Transitional gate for `cowork_checkout_merge(threadId)`: a deprecated thread
 * clone merges only when its review passed. The M8 `allowUnreviewed` override
 * is gone (M10.4b) — the plugin never merges an unreviewed range, not even for
 * the legacy clone — and M11/M12 remove the path together with the last legacy
 * checkout.
 */
export function checkLegacyThreadMerge(
  thread: { threadId: string; reviewStatus: ReviewStatus | null },
): LegacyMergePlan {
  if (thread.reviewStatus === 'pass') return { ok: true }
  return {
    ok: false,
    failure: failure(
      ERROR_CODES.reviewNotPassed,
      `thread ${thread.threadId} has not passed review (${thread.reviewStatus ?? 'never requested'}); ask for a review first`,
      { threadId: thread.threadId, reviewStatus: thread.reviewStatus },
    ),
  }
}
