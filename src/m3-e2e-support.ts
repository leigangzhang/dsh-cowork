/**
 * Shared types, constants, prompt builders, and pure helpers for the M3 real-host
 * E2E driver. Like `m2-e2e-support.ts`, this module has no runner import, so the
 * step list, prompt text, review-state helpers, and steer plan are testable under
 * plain `node --test` without mounting a host. The runner lives in
 * `src/m3-e2e.ts` and imports this module.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { M2E2EHost } from './m2-e2e-support.js'

export const M3_E2E_EVIDENCE_RELATIVE = '.dsh-cowork/e2e/M3_E2E.json'
export const M3_E2E_FIXTURE_RELATIVE = '.dsh-cowork/e2e/m3-repo'
export const M3_E2E_STEP_TIMEOUT_MS = 180_000
export const M3_E2E_POLL_MS = 500
export const M3_E2E_RUN_PATH = '/dsh-cowork/e2e/m3/run'
export const M3_E2E_STATUS_PATH = '/dsh-cowork/e2e/m3/status'

export const MAX_EVENTS = 4000
export const MAX_ASSISTANT_TEXT = 1000
export const MAX_FILE_TEXT = 2000
export const MAX_GIT_TEXT = 2000
export const GIT_TIMEOUT_MS = 30_000
export const GIT_MAX_BUFFER = 8 * 1024 * 1024

export const REVIEW_REQUEST_TOOL = 'cowork_review_request'
export const REVIEW_VERDICT_TOOL = 'cowork_review_verdict'
export const MERGE_TOOL = 'cowork_checkout_merge'
export const REVIEWER_PRESET_ID = 'cowork-reviewer'
export const MASTER_DONE = 'Reply DONE.'
export const THREAD_A_SUBJECT = 'M3 E2E review pass'
export const THREAD_B_SUBJECT = 'M3 E2E review repair'
export const FILE_A = 'e2e-a.txt'
export const CONTENT_A = 'M3-E2E-PASS'
export const FILE_B = 'e2e-b.txt'
export const CONTENT_B_INITIAL = 'M3-E2E-NEEDS-REPAIR'
export const CONTENT_B_FIXED = 'M3-E2E-FIXED'
export const FINDING_ID = 'M3-E2E-1'

export const M3_STEP_IDS = [
  'setup',
  'thread-a-create',
  'thread-a-work',
  'review-a-request',
  'review-a-pass',
  'merge-a',
  'thread-b-create',
  'thread-b-work',
  'review-b-request',
  'review-b-needs-revision',
  'thread-b-repair',
  'review-b-request-2',
  'review-b-pass',
  'merge-b',
  'cleanup',
] as const

export interface SessionEvent {
  readonly type: string
  readonly seq: number
  readonly data: Record<string, unknown>
}

export type M3RunState = 'running' | 'done' | 'failed'
export type M3StepStatus = 'pending' | 'running' | 'passed' | 'failed'
export type PromptMode = 'queue' | 'steer'
export type ReviewVerdict = 'pass' | 'needs_revision' | 'reject'
export type ReviewSeverity = 'blocker' | 'high' | 'medium' | 'low'

export interface ReviewFinding {
  readonly id: string
  readonly severity: ReviewSeverity
  readonly problem: string
  readonly requiredFix: string
  readonly file?: string
  readonly line?: number
}

export interface M3Assertion {
  readonly name: string
  readonly ok: boolean
  readonly evidence: string
}

export interface M3ToolCallEvidence {
  readonly name: string
  readonly callId: string
  readonly arguments: string
}

export interface M3PromptEvidence {
  readonly sessionId: string
  readonly role: 'master' | 'thread' | 'reviewer'
  readonly content: string
  readonly mode: PromptMode
  accepted: boolean
  readonly fromSeq: number
  assistantText: string
  toolCalls: M3ToolCallEvidence[]
}

export interface M3StepEvidence {
  startedAt: string | null
  endedAt: string | null
  prompts: M3PromptEvidence[]
  observations: Record<string, unknown>
  assertions: M3Assertion[]
  note?: string
  error?: string
}

export interface M3StepView {
  readonly id: string
  readonly status: M3StepStatus
  readonly evidence: M3StepEvidence
}

export interface M3RunStatusView {
  readonly runId: string
  readonly state: M3RunState
  readonly startedAt: string
  readonly endedAt?: string
  readonly steps: readonly M3StepView[]
  readonly evidenceFile: string
  readonly error?: string
}

export interface M3EvidenceDocument {
  readonly version: 1
  readonly runId: string
  readonly state: M3RunState
  readonly startedAt: string
  readonly endedAt: string | null
  readonly evidenceFile: string
  readonly host: {
    readonly plugin: string
    readonly pluginVersion: string
    readonly node: string
    readonly platform: string
    readonly arch: string
    readonly repoPath: string
  }
  readonly steps: readonly M3StepView[]
  readonly finalIndex: unknown
  readonly cleanup: Record<string, unknown>
  readonly error?: string
}

export interface ReviewStateSnapshot {
  readonly threadId: string
  readonly status: string
  readonly checkoutPath: string | null
  readonly reviewStatus: string | null
  readonly reviewerSessionId: string | null
  readonly reviewedAt: string | null
  readonly latestReviewPath: string | null
}

export interface M3E2EConfig {
  readonly repoPath: string
  readonly promptTimeoutMs: number
  readonly pluginName: string
  readonly pluginVersion: string
  readonly log?: (message: string) => void
}

export type M3E2EHost = M2E2EHost

export interface ReviewPromptInput {
  readonly threadId: string
  readonly subject: string
  readonly repoPath: string
  readonly checkoutPath: string
  readonly fileName: string
  readonly verificationCommand: string
}

export interface NeedsRevisionPromptInput extends ReviewPromptInput {
  readonly finding: ReviewFinding
}

export interface RepairPromptInput {
  readonly threadId: string
  readonly checkoutPath: string
  readonly fileName: string
  readonly fixedContent: string
  readonly finding: ReviewFinding
}

export const REVIEW_FINDING: ReviewFinding = {
  id: FINDING_ID,
  severity: 'high',
  problem: `${FILE_B} still contains ${CONTENT_B_INITIAL}`,
  requiredFix: `rewrite ${FILE_B} to content ${CONTENT_B_FIXED}`,
}

export interface HandoffView {
  readonly filePath: string
  readonly record: { readonly threadId: string; readonly status: string; readonly summary: string; readonly createdAt: string; readonly [key: string]: unknown }
}

export interface ReviewFileEvidence {
  readonly filePath: string
  readonly text: string
  readonly record?: Record<string, unknown>
}

export interface IndexThreadView {
  readonly threadId: string
  readonly subject?: string
  readonly status: string
  readonly checkoutPath: string | null
  readonly reviewStatus?: unknown
  readonly reviewerSessionId?: unknown
  readonly reviewedAt?: unknown
  readonly latestReviewPath?: unknown
  readonly [key: string]: unknown
}

export interface IndexView {
  readonly masterSessionId: string
  readonly threads: readonly IndexThreadView[]
  readonly [key: string]: unknown
}

export interface MutableStep {
  readonly id: string
  status: M3StepStatus
  readonly evidence: M3StepEvidence
}

export interface MutableRun {
  readonly runId: string
  state: M3RunState
  readonly startedAt: string
  endedAt?: string
  readonly steps: MutableStep[]
  error?: string
  finalIndex: unknown
  cleanup: Record<string, unknown>
}

export interface GitOutcome {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface DeliveryEvent {
  readonly type: string
  readonly seq: number
  readonly source: 'event' | 'assistant-text'
  readonly text: string
}

export function stepFailureState(stepId: string, error: unknown): { state: 'failed'; error: string } {
  return { state: 'failed', error: `step ${stepId}: ${messageOf(error)}` }
}

export function reviewPreamble(input: ReviewPromptInput, command: string): string[] {
  return [
    'This is the M3 E2E fixture run. Act as the independent reviewer; never modify an implementation file.',
    `Thread ${input.threadId} ("${input.subject}"). Main repo ${input.repoPath}; checkout ${input.checkoutPath} (branch cowork/${input.threadId}); read it with bash.`,
    `Step 1 — use the bash tool to run the recorded verification command from the checkout: cd ${input.checkoutPath} && ${input.verificationCommand}. Keep its real exit code and output.`,
    `Step 2 — ${command}`,
  ]
}

export function buildReviewerPassPrompt(input: ReviewPromptInput): string {
  const args = {
    threadId: input.threadId,
    verdict: 'pass',
    summary: `Independent review of ${input.threadId}: the handoff change is present and the recorded verification command passed.`,
    findings: [] as ReviewFinding[],
    verification: [{ command: input.verificationCommand, exitCode: 0, evidence: '<copy the real command output here>' }],
  }
  return [
    ...reviewPreamble(input, 'call cowork_review_verdict exactly once with these arguments (replace only the placeholder evidence with the real command output):'),
    JSON.stringify(args, null, 2),
    `Use verdict "pass" only if the command exited 0 and the change matches the handoff. ${MASTER_DONE}`,
  ].join('\n\n')
}

export function buildReviewerNeedsRevisionPrompt(input: NeedsRevisionPromptInput): string {
  const args = {
    threadId: input.threadId,
    verdict: 'needs_revision',
    summary: `Independent review of ${input.threadId}: the fixture requires exactly one blocking correction before this thread can be merged.`,
    findings: [input.finding],
    verification: [{ command: input.verificationCommand, exitCode: 0, evidence: '<copy the real command output here>' }],
  }
  return [
    ...reviewPreamble(input, 'the fixture must be sent back: call cowork_review_verdict exactly once with these arguments (keep the finding as written):'),
    JSON.stringify(args, null, 2),
    `The verdict must be "needs_revision" and the finding verbatim. ${MASTER_DONE}`,
  ].join('\n\n')
}

export function buildRepairPrompt(input: RepairPromptInput): string {
  const { finding } = input
  return [
    `The independent review returned needs_revision for thread ${input.threadId}.`,
    `Finding ${finding.id} (${finding.severity}): ${finding.problem} Required fix: ${finding.requiredFix}.`,
    `Use bash to run exactly: printf '${input.fixedContent}\\n' > ${input.fileName} && git add ${input.fileName} && git commit -m "fix: apply review finding ${finding.id}".`,
    `Then call cowork_handoff again with status "awaiting_review", summary "M3 E2E repair: ${input.fileName} now contains ${input.fixedContent}", verification [{command: "test -f ${input.fileName}", exitCode: 0, evidence: "${input.fileName} exists"}], changedPaths ["${input.fileName}"].`,
    `Change nothing else. ${MASTER_DONE}`,
  ].join('\n\n')
}

export function reviewStateOf(index: IndexView | undefined | null, threadId: string): ReviewStateSnapshot | null {
  if (index === undefined || index === null) return null
  const thread = index.threads.find((entry) => entry.threadId === threadId)
  if (thread === undefined) return null
  return {
    threadId,
    status: thread.status,
    checkoutPath: typeof thread.checkoutPath === 'string' ? thread.checkoutPath : null,
    reviewStatus: stringOrNull(thread.reviewStatus),
    reviewerSessionId: stringOrNull(thread.reviewerSessionId),
    reviewedAt: stringOrNull(thread.reviewedAt),
    latestReviewPath: stringOrNull(thread.latestReviewPath),
  }
}

/** What the runner must do with the reviewer's deterministic instruction. */
export interface ReviewVerdictPlan {
  readonly action: 'steer' | 'skip' | 'fail'
  readonly mode: PromptMode | null
  readonly reason: string
}

const TERMINAL_REVIEW_STATUSES: readonly string[] = ['pass', 'needs_revision', 'reject']

/**
 * Decide the verdict delivery mode from the index alone: skip when the reviewer
 * already produced the expected verdict, fail when it produced another terminal
 * verdict (or the thread left awaiting_review), else steer the instruction now.
 */
export function planReviewVerdict(
  state: ReviewStateSnapshot | null,
  verdict: ReviewVerdict,
  expectedStatus: string,
): ReviewVerdictPlan {
  if (state === null) return { action: 'steer', mode: 'steer', reason: 'the thread is not in the index yet' }
  if (state.reviewStatus === verdict && state.status === expectedStatus) {
    return { action: 'skip', mode: null, reason: 'reviewer already produced the expected verdict' }
  }
  const terminal = state.reviewStatus !== null && TERMINAL_REVIEW_STATUSES.includes(state.reviewStatus)
  if (terminal || state.status !== 'awaiting_review') {
    return {
      action: 'fail',
      mode: null,
      reason: `reviewer already produced ${String(state.reviewStatus)} while the thread is ${state.status}`,
    }
  }
  return { action: 'steer', mode: 'steer', reason: 'reviewer has not produced a verdict yet' }
}

export function assertionForReview(check: string, expected: unknown, actual: unknown): M3Assertion {
  const e = stableJson(expected)
  const a = stableJson(actual)
  return { name: check, ok: e === a, evidence: clip(`expected=${e} actual=${a}`, 3000) }
}

/** How the runner asks the master for a review without waiting for it to go idle. */
export interface ReviewRequestPlan {
  readonly action: 'steer' | 'already-pending'
  readonly reason: string
}

/**
 * Decide how to request a review. A handoff wakes the master, and that reaction
 * turn can run far longer than a step timeout, so the runner never waits for the
 * master to go idle: it adopts a review the master already requested when the
 * index shows a pending one with a fresh reviewer, and otherwise steers the
 * instruction into the master's current turn.
 */
export function planReviewRequest(input: {
  threadId: string
  masterSessionId: string
  previousReviewerSessionId: string | null
  state: ReviewStateSnapshot | null
}): ReviewRequestPlan {
  const reviewer = input.state?.reviewerSessionId ?? null
  const fresh =
    reviewer !== null &&
    reviewer !== input.threadId &&
    reviewer !== input.masterSessionId &&
    (input.previousReviewerSessionId === null || reviewer !== input.previousReviewerSessionId)
  if (input.state?.reviewStatus === 'pending' && fresh) {
    return { action: 'already-pending', reason: `the master already requested this review in session ${reviewer}` }
  }
  return { action: 'steer', reason: 'the review request is steered into the master turn' }
}

/** How the runner delivers the merge instruction. */
export interface MergePromptPlan {
  readonly action: 'skip' | 'steer'
  readonly reason: string
}

/**
 * Merge is never gated on a long master-idle wait: when the target state is
 * already reached the step passes idempotently, otherwise the merge
 * instruction is steered into whatever turn the master is in.
 */
export function planMergePrompt(alreadyDone: boolean): MergePromptPlan {
  return alreadyDone
    ? { action: 'skip', reason: 'merge target state was already reached; passed idempotently' }
    : { action: 'steer', reason: 'the merge instruction is steered into the master turn' }
}

export function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

export function isoNow(): string {
  return new Date().toISOString()
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((settle) => setTimeout(settle, ms))
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function stableJson(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

export function obs(step: MutableStep, patch: Record<string, unknown>): void {
  Object.assign(step.evidence.observations, patch)
}

export async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
}

export function parseIndex(text: string): IndexView | undefined {
  try {
    const parsed = asRecord(JSON.parse(text))
    if (parsed !== undefined && typeof parsed.masterSessionId === 'string' && Array.isArray(parsed.threads)) {
      return parsed as unknown as IndexView
    }
  } catch {
  }
  return undefined
}

export async function readHandoffs(fixturePath: string): Promise<HandoffView[]> {
  const directory = join(fixturePath, '.dsh-cowork', 'handoffs')
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw error
  }
  const files: HandoffView[] = []
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    const filePath = join(directory, name)
    try {
      const record = asRecord(JSON.parse(await readFile(filePath, 'utf8')))
      if (record === undefined || typeof record.threadId !== 'string' || typeof record.status !== 'string') continue
      if (typeof record.summary !== 'string' || typeof record.createdAt !== 'string') continue
      files.push({ filePath, record: record as unknown as HandoffView['record'] })
    } catch {
    }
  }
  return files
}

export function contentText(message: unknown): string {
  const content = asRecord(message)?.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    const block = asRecord(part)
    if (block === undefined) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else {
      try {
        parts.push(JSON.stringify(block))
      } catch {
        parts.push('[unserializable block]')
      }
    }
  }
  return parts.join('\n')
}

export function lastSeq(events: readonly SessionEvent[]): number {
  return events.at(-1)?.seq ?? 0
}

export function assistantTextSince(events: readonly SessionEvent[], fromSeq: number): string {
  const parts: string[] = []
  for (const event of events) {
    if (event.seq <= fromSeq || event.type !== 'assistant/message') continue
    const text = contentText(asRecord(event.data.message))
    if (text !== '') parts.push(text)
  }
  return clip(parts.join('\n'), MAX_ASSISTANT_TEXT)
}

export function toolCallsSince(events: readonly SessionEvent[], fromSeq: number, name?: string): M3ToolCallEvidence[] {
  const calls: M3ToolCallEvidence[] = []
  for (const event of events) {
    if (event.seq <= fromSeq || event.type !== 'tool/call') continue
    const callName = typeof event.data.name === 'string' ? event.data.name : ''
    if (name !== undefined && callName !== name) continue
    calls.push({ name: callName, callId: String(event.data.callId ?? `seq-${event.seq}`), arguments: clip(String(event.data.arguments ?? ''), 4000) })
  }
  return calls
}

export function runGit(args: readonly string[], cwd: string): Promise<GitOutcome> {
  return new Promise<GitOutcome>((settle) => {
    execFile('git', [...args], { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error === null) {
        settle({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '' })
        return
      }
      const exit = (error as { code?: unknown }).code
      settle({ code: typeof exit === 'number' ? exit : 1, stdout: typeof stdout === 'string' ? stdout : '', stderr: typeof stderr === 'string' && stderr.length > 0 ? stderr : (error as Error).message })
    })
  })
}

export async function writeEvidenceAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomUUID()}.tmp`
  await writeFile(temp, content, { mode: 0o600 })
  await rename(temp, file)
}

export function isStrictlyInside(parent: string, child: string): boolean {
  const base = resolve(parent)
  return resolve(child).startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

export function recordCheck(step: MutableStep, name: string, ok: boolean, evidence: unknown): void {
  const text = typeof evidence === 'string' ? evidence : stableJson(evidence)
  step.evidence.assertions.push({ name, ok, evidence: clip(text, 3000) })
  if (!ok) throw new Error(`assertion failed [${step.id}] ${name}: ${clip(text, 500)}`)
}

export function runView(run: MutableRun, evidenceFile: string): M3RunStatusView {
  return JSON.parse(JSON.stringify({
    runId: run.runId,
    state: run.state,
    startedAt: run.startedAt,
    ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
    steps: run.steps,
    evidenceFile,
    ...(run.error === undefined ? {} : { error: run.error }),
  })) as M3RunStatusView
}
export interface ThreadRef {
  readonly threadId: string
  readonly checkoutPath: string
}
