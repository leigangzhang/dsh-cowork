/**
 * Independent review gate: the pure model behind `cowork_review_request` and
 * `cowork_review_verdict`.
 *
 * Host-free by contract. The only import is type-only, so it is erased when
 * Node strips types; that is what lets `node --test` import this file directly
 * (a value import of a sibling would be written `./x.js` and would not resolve
 * to `./x.ts`). No Node built-in, no store implementation, no clock.
 *
 * The module owns five decisions the tools must not re-derive:
 *
 * 1. what a review input must contain (validation),
 * 2. where one verdict moves the thread (transition),
 * 3. who may record a verdict (the reviewer session, never the implementer or
 *    the master),
 * 4. when a review may be requested and when a merge may proceed,
 * 5. the two prompts a review flow needs: the briefing for the reviewer and
 *    the revision message sent back to the thread.
 */
import type { ToolFailure } from './tool-model.js'

/** Preset id of the read-only reviewer session. */
export const REVIEWER_PRESET_ID = 'cowork-reviewer'

/** Lifecycle of a review request, stored on the thread record. */
export const REVIEW_STATUSES = ['pending', 'pass', 'needs_revision', 'reject'] as const
export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

/** The verdicts a reviewer may return. `pending` is a request state, not a verdict. */
export const REVIEW_VERDICTS = ['pass', 'needs_revision', 'reject'] as const
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number]

/** Finding severities, most severe first. */
export const REVIEW_SEVERITIES = ['blocker', 'high', 'medium', 'low'] as const
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number]

/** Thread statuses the gates in this module understand. Mirrors store.ts. */
export type ReviewThreadStatus = 'new' | 'active' | 'awaiting_review' | 'done' | 'blocked' | 'archived'

/** Upper bound of a cleaned override reason, in characters. */
export const MAX_OVERRIDE_REASON_LENGTH = 200

/** One required fix a review names. */
export interface ReviewFinding {
  id: string
  severity: ReviewSeverity
  problem: string
  requiredFix: string
  file?: string
  line?: number
}

/** One check the reviewer actually ran. */
export interface ReviewVerification {
  command: string
  exitCode: number
  evidence: string
}

/** One review document (`<repo>/.dsh-cowork/reviews/<threadId>-<stamp>.json`). */
export interface ReviewRecord {
  version: 1
  threadId: string
  reviewerSessionId: string
  verdict: ReviewVerdict
  summary: string
  findings: ReviewFinding[]
  verification: ReviewVerification[]
  createdAt: string
}

/** The validated review without the fields the store stamps. */
export interface ReviewDraft {
  threadId: string
  reviewerSessionId: string
  verdict: ReviewVerdict
  summary: string
  findings: ReviewFinding[]
  verification: ReviewVerification[]
}

/** One rejected field of an untrusted review input. */
export interface ReviewFieldError {
  field: string
  message: string
}

/** Result of validating untrusted review input. */
export type ReviewValidation =
  | { ok: true; value: ReviewDraft }
  | { ok: false; errors: ReviewFieldError[] }

/**
 * Build the failure envelope locally. src/tool-model.ts owns the canonical
 * `failure`, but importing it by value would drag a sibling `.js` specifier
 * into this host-free module and break `node --test` resolution.
 */
function failure(code: string, message: string, details?: unknown): ToolFailure {
  const error: { code: string; message: string; details?: unknown } = { code, message }
  if (details !== undefined) error.details = details
  return { ok: false, error }
}

/** Whether a value is a JSON object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one required non-empty string field. */
function readRequiredString(
  input: Record<string, unknown>,
  field: string,
  errors: ReviewFieldError[],
): string {
  const value = input[field]
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push({ field, message: `${field} must be a non-empty string` })
    return ''
  }
  return value
}

/** Collect the problems of the findings array, keeping only well-formed rows. */
function readFindings(input: Record<string, unknown>, errors: ReviewFieldError[]): ReviewFinding[] {
  const value = input.findings
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    errors.push({ field: 'findings', message: 'findings must be an array' })
    return []
  }
  const findings: ReviewFinding[] = []
  value.forEach((row, position) => {
    const field = `findings[${position}]`
    if (!isRecord(row)) {
      errors.push({ field, message: `${field} must be an object` })
      return
    }
    let wellFormed = true
    const id = typeof row.id === 'string' && row.id.trim() !== '' ? row.id : null
    if (id === null) {
      errors.push({ field: `${field}.id`, message: 'id must be a non-empty string' })
      wellFormed = false
    }
    const severity =
      typeof row.severity === 'string' && REVIEW_SEVERITIES.includes(row.severity as ReviewSeverity)
        ? (row.severity as ReviewSeverity)
        : null
    if (severity === null) {
      errors.push({
        field: `${field}.severity`,
        message: `severity must be one of ${REVIEW_SEVERITIES.join('|')}`,
      })
      wellFormed = false
    }
    const problem = typeof row.problem === 'string' && row.problem.trim() !== '' ? row.problem : null
    if (problem === null) {
      errors.push({ field: `${field}.problem`, message: 'problem must be a non-empty string' })
      wellFormed = false
    }
    const requiredFix =
      typeof row.requiredFix === 'string' && row.requiredFix.trim() !== '' ? row.requiredFix : null
    if (requiredFix === null) {
      errors.push({ field: `${field}.requiredFix`, message: 'requiredFix must be a non-empty string' })
      wellFormed = false
    }
    let file: string | undefined
    if (row.file !== undefined && row.file !== null) {
      if (typeof row.file !== 'string' || row.file.trim() === '') {
        errors.push({ field: `${field}.file`, message: 'file must be a non-empty string when present' })
        wellFormed = false
      } else {
        file = row.file
      }
    }
    let line: number | undefined
    if (row.line !== undefined && row.line !== null) {
      if (typeof row.line !== 'number' || !Number.isInteger(row.line) || row.line < 1) {
        errors.push({ field: `${field}.line`, message: 'line must be a positive integer when present' })
        wellFormed = false
      } else {
        line = row.line
      }
    }
    if (wellFormed && id !== null && severity !== null && problem !== null && requiredFix !== null) {
      const finding: ReviewFinding = { id, severity, problem, requiredFix }
      if (file !== undefined) finding.file = file
      if (line !== undefined) finding.line = line
      findings.push(finding)
    }
  })
  return findings
}

/** Collect the problems of the verification array, keeping only complete rows. */
function readVerification(
  input: Record<string, unknown>,
  errors: ReviewFieldError[],
): ReviewVerification[] {
  const value = input.verification
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    errors.push({ field: 'verification', message: 'verification must be an array' })
    return []
  }
  const verification: ReviewVerification[] = []
  value.forEach((row, position) => {
    const field = `verification[${position}]`
    if (!isRecord(row)) {
      errors.push({ field, message: `${field} must be an object` })
      return
    }
    let wellFormed = true
    if (typeof row.command !== 'string' || row.command.trim() === '') {
      errors.push({ field: `${field}.command`, message: 'command must be a non-empty string' })
      wellFormed = false
    }
    if (!Number.isInteger(row.exitCode)) {
      errors.push({ field: `${field}.exitCode`, message: 'exitCode must be an integer' })
      wellFormed = false
    }
    if (typeof row.evidence !== 'string') {
      errors.push({ field: `${field}.evidence`, message: 'evidence must be a string' })
      wellFormed = false
    }
    if (wellFormed) {
      verification.push({
        command: row.command as string,
        exitCode: row.exitCode as number,
        evidence: row.evidence as string,
      })
    }
  })
  return verification
}

/**
 * Validate untrusted review input, collecting every field problem at once.
 * Nothing is written here: a rejected review leaves no file and no index
 * change behind. `needs_revision` and `reject` without a finding are rejected
 * because the thread must be told what to fix; `pass` may carry no findings.
 */
export function validateReviewInput(input: unknown): ReviewValidation {
  if (!isRecord(input)) {
    return { ok: false, errors: [{ field: 'input', message: 'review input must be an object' }] }
  }
  const errors: ReviewFieldError[] = []
  const threadId = readRequiredString(input, 'threadId', errors)
  const reviewerSessionId = readRequiredString(input, 'reviewerSessionId', errors)
  const summary = readRequiredString(input, 'summary', errors)

  let verdict: ReviewVerdict = 'needs_revision'
  let verdictKnown = false
  const rawVerdict = input.verdict
  if (rawVerdict === undefined || rawVerdict === null) {
    errors.push({ field: 'verdict', message: 'verdict is required' })
  } else if (
    typeof rawVerdict !== 'string' ||
    !REVIEW_VERDICTS.includes(rawVerdict as ReviewVerdict)
  ) {
    errors.push({
      field: 'verdict',
      message: `verdict must be one of ${REVIEW_VERDICTS.join('|')} (pending is a request state, not a verdict)`,
    })
  } else {
    verdict = rawVerdict as ReviewVerdict
    verdictKnown = true
  }

  const findings = readFindings(input, errors)
  const verification = readVerification(input, errors)

  // Only a known non-pass verdict demands a finding: an invalid verdict is
  // already reported, and adding "findings" on top would misdirect the fix.
  if (verdictKnown && verdict !== 'pass' && findings.length === 0) {
    errors.push({
      field: 'findings',
      message: `${verdict} requires at least one finding naming what to fix`,
    })
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { threadId, reviewerSessionId, verdict, summary, findings, verification } }
}

/** Stamp a validated draft into the record the store persists. */
export function buildReviewRecord(draft: ReviewDraft, createdAt: Date): ReviewRecord {
  return {
    version: 1,
    threadId: draft.threadId,
    reviewerSessionId: draft.reviewerSessionId,
    verdict: draft.verdict,
    summary: draft.summary,
    findings: draft.findings,
    verification: draft.verification,
    createdAt: createdAt.toISOString(),
  }
}

/**
 * Where one verdict moves the thread, and whether the decision must reach the
 * thread. `pass` accepts the work and nothing is sent; both revision verdicts
 * wake the thread with the findings.
 */
export function verdictTransition(verdict: ReviewVerdict): {
  status: 'done' | 'active' | 'blocked'
  deliverToThread: boolean
} {
  if (verdict === 'pass') return { status: 'done', deliverToThread: false }
  if (verdict === 'needs_revision') return { status: 'active', deliverToThread: true }
  return { status: 'blocked', deliverToThread: true }
}

/**
 * Gate the verdict tool. Only the reviewer session recorded on the thread may
 * vote; the master and the thread itself are refused explicitly, so an
 * implementer can never sign off its own work and the master cannot bypass the
 * independent session.
 */
export function checkVerdictCaller(input: {
  caller: { sessionId: string; cwd: string; agentPreset?: string }
  thread: { threadId: string; reviewerSessionId: string | null; reviewStatus?: ReviewStatus | null }
  masterSessionId: string
}): ToolFailure | null {
  const { caller, thread, masterSessionId } = input
  if (caller.sessionId === masterSessionId || caller.sessionId === thread.threadId) {
    return failure(
      'review/self-review',
      `session ${caller.sessionId} cannot review thread ${thread.threadId}: a review must come from the independent reviewer session, not from the implementer or the master`,
      {
        threadId: thread.threadId,
        sessionId: caller.sessionId,
        role: caller.sessionId === masterSessionId ? 'master' : 'thread',
      },
    )
  }
  if (thread.reviewerSessionId === null || caller.sessionId !== thread.reviewerSessionId) {
    return failure(
      'review/not-reviewer',
      `session ${caller.sessionId} is not the reviewer of thread ${thread.threadId}`,
      { threadId: thread.threadId, sessionId: caller.sessionId, reviewerSessionId: thread.reviewerSessionId },
    )
  }
  return null
}

/**
 * Gate review requests: only a thread that handed off with `awaiting_review`
 * may be reviewed, and one pending request at a time. A thread that was
 * reviewed before (and is still awaiting review) may be reviewed again.
 */
export function checkReviewRequest(thread: {
  threadId: string
  status: ReviewThreadStatus
  reviewStatus: ReviewStatus | null
  reviewerSessionId: string | null
}): ToolFailure | null {
  if (thread.status !== 'awaiting_review') {
    return failure(
      'review/not-ready',
      `thread ${thread.threadId} is ${thread.status}; a review can only be requested for awaiting_review`,
      { threadId: thread.threadId, status: thread.status },
    )
  }
  if (thread.reviewStatus === 'pending') {
    return failure(
      'review/already-pending',
      `thread ${thread.threadId} already has a review pending in session ${thread.reviewerSessionId}`,
      { threadId: thread.threadId, reviewerSessionId: thread.reviewerSessionId },
    )
  }
  return null
}

/**
 * Gate a merge on the thread's review. A passed review needs nothing else; any
 * other state needs an explicit, non-empty override reason from the master.
 */
export function checkMergeGate(
  thread: { threadId: string; reviewStatus: ReviewStatus | null },
  options: { allowUnreviewed?: boolean; overrideReason?: string } = {},
): ToolFailure | null {
  if (thread.reviewStatus === 'pass') return null
  if (options.allowUnreviewed === true) {
    if (cleanOverrideReason(options.overrideReason ?? '') !== '') return null
    return failure(
      'review/override-reason-required',
      `thread ${thread.threadId} has not passed review (${thread.reviewStatus ?? 'never requested'}); allowUnreviewed needs a non-empty overrideReason`,
      { threadId: thread.threadId, reviewStatus: thread.reviewStatus },
    )
  }
  return failure(
    'review/not-passed',
    `thread ${thread.threadId} has not passed review (${thread.reviewStatus ?? 'never requested'}); ask for a review first, or pass allowUnreviewed with an overrideReason to merge anyway`,
    { threadId: thread.threadId, reviewStatus: thread.reviewStatus },
  )
}

/**
 * Clean an override reason for a commit message: control characters and line
 * breaks become spaces, whitespace runs collapse, and the result is trimmed
 * and bounded. An empty reason means "no override".
 */
export function cleanOverrideReason(reason: string): string {
  if (typeof reason !== 'string') return ''
  const cleaned = reason
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.slice(0, MAX_OVERRIDE_REASON_LENGTH).trim()
}

/** The commit-message suffix an override appends; empty when there is no reason. */
export function overrideCommitSuffix(reason: string): string {
  const cleaned = cleanOverrideReason(reason)
  return cleaned === '' ? '' : ` (unreviewed: ${cleaned})`
}

/** Everything the verdict tool decides before touching the store. */
export function prepareVerdict(input: {
  thread: {
    threadId: string
    status: ReviewThreadStatus
    reviewerSessionId: string | null
    reviewStatus: ReviewStatus | null
  }
  caller: { sessionId: string; cwd: string; agentPreset?: string }
  masterSessionId: string
  review: unknown
}): { ok: true; draft: ReviewDraft } | { ok: false; failure: ToolFailure } {
  const { thread, caller, masterSessionId } = input
  if (thread.status !== 'awaiting_review') {
    return {
      ok: false,
      failure: failure(
        'review/not-ready',
        `thread ${thread.threadId} is ${thread.status}; a verdict may only be recorded while it is awaiting_review`,
        { threadId: thread.threadId, status: thread.status },
      ),
    }
  }
  const callerProblem = checkVerdictCaller({ caller, thread, masterSessionId })
  if (callerProblem !== null) return { ok: false, failure: callerProblem }
  // The index owns the project identity: the model cannot claim another thread
  // or another reviewer, so both fields are overwritten here.
  const raw =
    typeof input.review === 'object' && input.review !== null && !Array.isArray(input.review)
      ? (input.review as Record<string, unknown>)
      : {}
  const validated = validateReviewInput({
    ...raw,
    threadId: thread.threadId,
    reviewerSessionId: thread.reviewerSessionId ?? '',
  })
  if (!validated.ok) {
    return {
      ok: false,
      failure: failure('review/verdict-invalid', 'review verdict is invalid', {
        threadId: thread.threadId,
        errors: validated.errors,
      }),
    }
  }
  return { ok: true, draft: validated.value }
}

/** The merge decision: either a refusal, or how the commit message is built. */
export type MergePlan =
  | { ok: true; suffix: string; reason: string | null }
  | { ok: false; failure: ToolFailure }

/**
 * Decide one merge in one place: the gate first, then the commit suffix and
 * the reason the response reports. A passed review never counts as an
 * override, so a reviewed merge is never labelled unreviewed.
 */
export function planMerge(
  thread: { threadId: string; reviewStatus: ReviewStatus | null },
  options: { allowUnreviewed?: boolean; overrideReason?: string } = {},
): MergePlan {
  const gate = checkMergeGate(thread, options)
  if (gate !== null) return { ok: false, failure: gate }
  if (thread.reviewStatus === 'pass' || options.allowUnreviewed !== true) {
    return { ok: true, suffix: '', reason: null }
  }
  const reason = cleanOverrideReason(options.overrideReason ?? '')
  return { ok: true, suffix: overrideCommitSuffix(options.overrideReason ?? ''), reason: reason === '' ? null : reason }
}

/** What the reviewer briefing needs to know. */
export interface ReviewBriefInput {
  repoPath: string
  subject: string
  threadId: string
  handoffFilePath: string | null
  changedPaths?: readonly string[]
  verification?: readonly ReviewVerification[]
  checkoutPath?: string | null
  baseRef?: string | null
}

/**
 * The opener for a review session: where the project is, which thread is being
 * reviewed, the handoff the thread claims, how to see the real change, and the
 * one tool call the reviewer must make. It says nothing the handoff alone
 * proves — the reviewer is asked to re-run the checks.
 */
export function buildReviewBrief(input: ReviewBriefInput): string {
  const lines = [
    `You are the independent reviewer of cowork thread ${input.threadId} in project ${input.repoPath}.`,
    `Subject: ${input.subject}`,
    'Review the work, not the thread self-report. Do not modify implementation files, do not commit, and do not create or prompt other sessions.',
  ]
  lines.push(
    input.handoffFilePath === null
      ? 'Latest handoff: none recorded; read the project index with cowork_project_status instead.'
      : `Latest handoff: ${input.handoffFilePath}`,
  )
  const changedPaths = [...(input.changedPaths ?? [])]
  lines.push(
    changedPaths.length === 0
      ? 'Changed paths reported by the thread: none recorded.'
      : `Changed paths reported by the thread: ${changedPaths.join(', ')}`,
  )
  const verification = [...(input.verification ?? [])]
  if (verification.length === 0) {
    lines.push('Verification the thread claims to have run: none recorded.')
  } else {
    lines.push('Verification the thread claims to have run (re-run these yourself; do not trust them):')
    for (const row of verification) {
      lines.push(`- ${row.command} (exit ${row.exitCode}): ${row.evidence}`)
    }
  }
  const checkoutPath = input.checkoutPath?.trim() ?? ''
  if (checkoutPath !== '') {
    const baseRef = input.baseRef?.trim() ?? ''
    const base = baseRef === '' ? 'origin/HEAD' : baseRef
    lines.push(
      `Thread work area: ${checkoutPath} on branch cowork/${input.threadId}. Review the actual change with git -C ${checkoutPath} diff ${base}...HEAD and git -C ${checkoutPath} log ${base}..HEAD; or read the clone directly with bash.`,
    )
  } else {
    lines.push(
      `The thread worked in the shared repository working tree at ${input.repoPath}; read the changed files there and compare them against the handoff.`,
    )
  }
  lines.push(
    'Use bash to read files and to run the verification commands yourself, and record the command, exit code, and evidence you actually observed.',
    `When the review is finished, call cowork_review_verdict exactly once for thread ${input.threadId}: pass accepts the work, needs_revision sends findings back to the thread, reject blocks it. needs_revision and reject require at least one finding with id, severity (${REVIEW_SEVERITIES.join('|')}), problem, and requiredFix.`,
  )
  return lines.join('\n')
}

/** One finding as the revision message shows it. */
function findingLine(finding: ReviewFinding): string {
  const where =
    finding.file !== undefined && finding.line !== undefined
      ? `${finding.file}:${finding.line}`
      : finding.file !== undefined
        ? finding.file
        : ''
  return [
    `- ${finding.id} [${finding.severity}] ${finding.problem}`,
    `required fix: ${finding.requiredFix}`,
    ...(where === '' ? [] : [`at ${where}`]),
  ].join(' | ')
}

/**
 * The message a revision verdict delivers to the thread: what was decided, by
 * whom (implicitly: the independent reviewer), and what must change before the
 * next handoff. The pass verdict is not delivered, but the formatter handles
 * it so a caller cannot accidentally send a message with no content.
 */
export function formatRevisionMessage(record: ReviewRecord, threadId: string): string {
  const lines = [
    `The independent review of thread ${threadId} returned ${record.verdict}.`,
    `Summary: ${record.summary}`,
  ]
  if (record.findings.length === 0) {
    lines.push('Findings: none.')
  } else {
    lines.push(`Findings (${record.findings.length}):`)
    for (const finding of record.findings) lines.push(findingLine(finding))
  }
  lines.push(
    `Fix every finding in your own work area, re-run the verification commands, then call cowork_handoff again with status awaiting_review so the revision can be reviewed. The full review record is saved under .dsh-cowork/reviews/.`,
  )
  return lines.join('\n')
}

/** The newest review of one thread among already-listed review files, or null. */
export function latestReviewFor(
  files: ReadonlyArray<{ record: ReviewRecord }>,
  threadId: string,
): ReviewRecord | null {
  let latest: ReviewRecord | null = null
  for (const file of files) {
    if (file.record.threadId !== threadId) continue
    if (latest === null || Date.parse(file.record.createdAt) > Date.parse(latest.createdAt)) {
      latest = file.record
    }
  }
  return latest
}
