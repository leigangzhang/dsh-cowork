/**
 * Handoff module: validate a topic's report and format the record it persists.
 *
 * M10 removed the legacy submit/replay path: the `cowork_handoff` tool writes
 * the file as an audit record, updates the canonical topic, and (for `blocked`)
 * delivers one bounded inbox item. The full handoff text is no longer prompted
 * into the master turn, and nothing rewrites an old handoff file.
 *
 * The module owns no I/O: validation and formatting are pure, and the tool
 * layer supplies the store. The accepted write statuses are `blocked` and
 * `done` only. Reading is deliberately wider — `handoffRecordProblems` in
 * `src/store-schema.ts` still accepts the historical `awaiting_review` value so
 * old files stay readable.
 */
import type {
  HandoffRecord,
  HandoffStatus,
  HandoffVerification,
} from './store.js'

/** The validated handoff a thread submits. */
export interface HandoffDraft {
  threadId: string
  masterSessionId: string
  subject: string
  status: HandoffStatus
  summary: string
  decisions: string[]
  changedPaths: string[]
  artifacts: string[]
  verification: HandoffVerification[]
  openIssues: string[]
  nextStep: string | null
}

/** One rejected field. */
export interface HandoffFieldError {
  field: string
  message: string
}

/** Result of validating untrusted handoff input. */
export type HandoffValidation =
  | { ok: true; value: HandoffDraft }
  | { ok: false; errors: HandoffFieldError[] }

/**
 * Statuses a handoff may be *written* with (M10). The read-side vocabulary in
 * `src/store-schema.ts` keeps `awaiting_review` so old files stay readable.
 */
const HANDOFF_STATUSES: readonly HandoffStatus[] = ['blocked', 'done']

/** Optional string-array fields, normalized to `[]` when the caller omits them. */
const STRING_ARRAY_FIELDS = ['decisions', 'changedPaths', 'artifacts', 'openIssues'] as const

/** Whether a value is a JSON object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one optional string-array field.
 *
 * `undefined` and `null` both mean "the caller did not state it": tool
 * arguments travel as JSON, where an absent optional field and an explicit
 * `null` are indistinguishable in intent, and rejecting `null` would fail
 * honest handoffs on a formatting detail.
 */
function readStringArray(
  input: Record<string, unknown>,
  field: string,
  errors: HandoffFieldError[],
): string[] {
  const value = input[field]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    errors.push({ field, message: `${field} must be an array of strings` })
    return []
  }
  return [...(value as string[])]
}

/** Collect the problems of one verification row. */
function readVerification(
  input: Record<string, unknown>,
  errors: HandoffFieldError[],
): HandoffVerification[] {
  const value = input.verification
  if (value === undefined || value === null) {
    errors.push({ field: 'verification', message: 'verification is required' })
    return []
  }
  if (!Array.isArray(value)) {
    errors.push({ field: 'verification', message: 'verification must be an array' })
    return []
  }
  if (value.length === 0) {
    errors.push({ field: 'verification', message: 'verification must not be empty' })
    return []
  }
  const rows: HandoffVerification[] = []
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
      rows.push({
        command: row.command as string,
        exitCode: row.exitCode as number,
        evidence: row.evidence as string,
      })
    }
  })
  return rows
}

/** Read one required non-empty string field. */
function readRequiredString(
  input: Record<string, unknown>,
  field: string,
  errors: HandoffFieldError[],
): string {
  const value = input[field]
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push({ field, message: `${field} must be a non-empty string` })
    return ''
  }
  return value
}

/**
 * Validate untrusted handoff input, collecting every field problem at once.
 * Nothing is written here: a rejected handoff leaves no file and no index
 * change behind.
 */
export function validateHandoff(input: unknown): HandoffValidation {
  if (!isRecord(input)) {
    return { ok: false, errors: [{ field: 'input', message: 'handoff must be an object' }] }
  }
  const errors: HandoffFieldError[] = []
  const threadId = readRequiredString(input, 'threadId', errors)
  const masterSessionId = readRequiredString(input, 'masterSessionId', errors)
  const subject = readRequiredString(input, 'subject', errors)

  let status: HandoffStatus = 'blocked'
  const rawStatus = input.status
  if (rawStatus === undefined || rawStatus === null) {
    errors.push({ field: 'status', message: 'status is required' })
  } else if (typeof rawStatus !== 'string' || !HANDOFF_STATUSES.includes(rawStatus as HandoffStatus)) {
    errors.push({
      field: 'status',
      message: `status must be one of ${HANDOFF_STATUSES.join('|')} (new/active are thread states, not handoff states)`,
    })
  } else {
    status = rawStatus as HandoffStatus
  }

  const summary = readRequiredString(input, 'summary', errors)
  const verification = readVerification(input, errors)

  const optional: Record<string, string[]> = {}
  for (const field of STRING_ARRAY_FIELDS) optional[field] = readStringArray(input, field, errors)

  let nextStep: string | null = null
  const rawNextStep = input.nextStep
  if (rawNextStep !== undefined && rawNextStep !== null) {
    if (typeof rawNextStep !== 'string') {
      errors.push({ field: 'nextStep', message: 'nextStep must be a string' })
    } else {
      nextStep = rawNextStep
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      threadId,
      masterSessionId,
      subject,
      status,
      summary,
      decisions: optional.decisions,
      changedPaths: optional.changedPaths,
      artifacts: optional.artifacts,
      verification,
      openIssues: optional.openIssues,
      nextStep,
    },
  }
}

/** Build the persisted record: version 1, `createdAt` from the caller's clock, undelivered. */
export function buildHandoffRecord(draft: HandoffDraft, createdAt: Date): HandoffRecord {
  return {
    version: 1,
    threadId: draft.threadId,
    masterSessionId: draft.masterSessionId,
    status: draft.status,
    subject: draft.subject,
    summary: draft.summary,
    decisions: [...(draft.decisions ?? [])],
    changedPaths: [...(draft.changedPaths ?? [])],
    artifacts: [...(draft.artifacts ?? [])],
    verification: (draft.verification ?? []).map((row) => ({
      command: row.command,
      exitCode: row.exitCode,
      evidence: row.evidence,
    })),
    openIssues: [...(draft.openIssues ?? [])],
    nextStep: draft.nextStep ?? null,
    createdAt: createdAt.toISOString(),
    deliveredAt: null,
  }
}

/**
 * The message the master receives: a readable summary of the handoff, not the
 * JSON document (the file path is the handle to the full record).
 */
export function formatMasterMessage(record: HandoffRecord, filePath: string): string {
  const lines: string[] = [
    `handoff from thread ${record.threadId}`,
    `status: ${record.status}`,
    `subject: ${record.subject}`,
    'summary:',
    ...record.summary.split('\n').map((line) => `  ${line}`),
  ]
  lines.push('verification:')
  for (const row of record.verification) {
    lines.push(`  - ${row.command} (exit ${row.exitCode})`)
    if (row.evidence !== '') {
      for (const line of row.evidence.split('\n')) lines.push(`    ${line}`)
    }
  }
  if (record.changedPaths.length > 0) {
    lines.push('changed paths:')
    for (const changedPath of record.changedPaths) lines.push(`  - ${changedPath}`)
  }
  if (record.openIssues.length > 0) {
    lines.push('open issues:')
    for (const issue of record.openIssues) lines.push(`  - ${issue}`)
  }
  lines.push(`file: ${filePath}`)
  return lines.join('\n')
}
