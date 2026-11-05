/**
 * Handoff module: validate a thread's report, persist it, update the project
 * index, deliver it to the master, and replay the ones whose delivery failed.
 *
 * This module owns no I/O of its own. It reaches the on-disk store only
 * through the injected {@link HandoffStorePort} (the type-only import keeps the
 * store implementation out of the module graph), so the delivery ordering can
 * be exercised in a unit test with a fake port.
 *
 * Ordering is fixed and load-bearing: validate (no file on failure) → write the
 * handoff file (the source of truth) → update the index → prompt the master.
 * A failed prompt keeps both the file and the index entry, and only a
 * successful prompt writes `deliveredAt`; whatever is left pending is what
 * {@link replayPendingHandoffs} retries.
 */
import type {
  HandoffFile,
  HandoffRecord,
  HandoffStatus,
  HandoffVerification,
  ProjectIndex,
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

const HANDOFF_STATUSES: readonly HandoffStatus[] = ['awaiting_review', 'blocked', 'done']

/** Optional string-array fields, normalized to `[]` when the caller omits them. */
const STRING_ARRAY_FIELDS = ['decisions', 'changedPaths', 'artifacts', 'openIssues'] as const

/** Whether a value is a JSON object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a value is a string that `Date.parse` accepts. */
function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
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

  let status: HandoffStatus = 'awaiting_review'
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

/** The slice of the store this module needs; the real `ProjectStore` satisfies it. */
export interface HandoffStorePort {
  writeHandoff(record: HandoffRecord): Promise<HandoffFile>
  markHandoffDelivered(filePath: string, deliveredAt: string): Promise<HandoffFile>
  readIndex(): Promise<ProjectIndex>
  mutateIndex(mutator: (index: ProjectIndex) => ProjectIndex): Promise<ProjectIndex>
  listHandoffs(): Promise<HandoffFile[]>
}

/** Everything a handoff submission needs from the host. */
export interface HandoffPorts {
  store: HandoffStorePort
  /** Deliver the summary to the master session; resolves with its acceptance. */
  promptMaster(text: string): Promise<{ accepted: boolean }>
  /** Injected clock for `createdAt`/`deliveredAt`. */
  clock?: () => Date
}

/** Result of one submission. A failed delivery is still a stored handoff. */
export type SubmitHandoffResult =
  | {
      ok: true
      delivered: boolean
      record: HandoffRecord
      filePath: string
      deliveryError?: string
    }
  | {
      ok: false
      error: {
        code: 'handoff/invalid'
        message: string
        errors: HandoffFieldError[]
      }
    }

/** Result of replaying every undelivered handoff once. */
export interface ReplayResult {
  attempted: number
  delivered: number
  failed: number
  failures: { threadId: string; filePath: string; error: string }[]
}

/** A readable message for a thrown value. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve the injected clock, defaulting to the wall clock. */
function clockNow(ports: HandoffPorts): Date {
  return ports.clock === undefined ? new Date() : ports.clock()
}

/** Fold one handoff's status and timestamps into its index thread entry. */
function applyHandoffToIndex(index: ProjectIndex, record: HandoffRecord): ProjectIndex {
  const threads = index.threads.map((thread) =>
    thread.threadId === record.threadId
      ? {
          ...thread,
          status: record.status,
          lastHandoffAt: record.createdAt,
          updatedAt: record.createdAt,
        }
      : thread,
  )
  return { ...index, threads }
}

/**
 * Validate, persist, index, and deliver one handoff to the master.
 *
 * Invalid input returns `handoff/invalid` with per-field reasons and writes
 * nothing. A delivery failure (throw or `accepted !== true`) returns
 * `ok: true, delivered: false` with a replayable file and index entry, and
 * leaves `deliveredAt` null.
 */
export async function submitHandoff(ports: HandoffPorts, input: unknown): Promise<SubmitHandoffResult> {
  const validation = validateHandoff(input)
  if (!validation.ok) {
    const summary = validation.errors.map((error) => `${error.field}: ${error.message}`).join('; ')
    return {
      ok: false,
      error: { code: 'handoff/invalid', message: `handoff is invalid: ${summary}`, errors: validation.errors },
    }
  }
  const record = buildHandoffRecord(validation.value, clockNow(ports))
  const file = await ports.store.writeHandoff(record)
  await ports.store.mutateIndex((index) => applyHandoffToIndex(index, record))

  let acceptance: { accepted: boolean }
  try {
    acceptance = await ports.promptMaster(formatMasterMessage(record, file.filePath))
  } catch (error) {
    return {
      ok: true,
      delivered: false,
      record,
      filePath: file.filePath,
      deliveryError: errorText(error),
    }
  }
  if (acceptance.accepted !== true) {
    return {
      ok: true,
      delivered: false,
      record,
      filePath: file.filePath,
      deliveryError: 'master did not accept the handoff',
    }
  }

  try {
    const delivered = await ports.store.markHandoffDelivered(file.filePath, clockNow(ports).toISOString())
    return { ok: true, delivered: true, record: delivered.record, filePath: file.filePath }
  } catch (error) {
    // The master already has the summary; report the bookkeeping failure
    // instead of pretending nothing was delivered.
    return { ok: true, delivered: true, record, filePath: file.filePath, deliveryError: errorText(error) }
  }
}

/**
 * Retry every handoff whose `deliveredAt` is null, exactly once each.
 *
 * A successful prompt writes `deliveredAt` for that file only; a failure is
 * counted and the loop continues, so one bad file cannot block the rest.
 */
export async function replayPendingHandoffs(ports: HandoffPorts): Promise<ReplayResult> {
  const files = await ports.store.listHandoffs()
  const pending = files.filter((file) => file.record.deliveredAt === null)
  const failures: { threadId: string; filePath: string; error: string }[] = []
  let delivered = 0
  for (const file of pending) {
    try {
      const acceptance = await ports.promptMaster(formatMasterMessage(file.record, file.filePath))
      if (acceptance.accepted !== true) {
        failures.push({
          threadId: file.record.threadId,
          filePath: file.filePath,
          error: 'master did not accept the handoff',
        })
        continue
      }
      await ports.store.markHandoffDelivered(file.filePath, clockNow(ports).toISOString())
      delivered += 1
    } catch (error) {
      failures.push({ threadId: file.record.threadId, filePath: file.filePath, error: errorText(error) })
    }
  }
  return { attempted: pending.length, delivered, failed: failures.length, failures }
}
