/**
 * M12 real-host E2E support: constants, types, prompt builders, pure plan
 * rules, durable-file readers, and the step assertion tables. Host-free: it
 * imports Node built-ins plus the plugin's pure modules only, so the contract
 * tests run under `node --test` without mounting a host.
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { parseReviewRequestRecord } from './review-request.js'
import { MASTER_PRESET_ID, REVIEWER_PRESET_ID, TOPIC_PRESET_ID } from './presets.js'
import {
  activityEventProblems,
  inboxItemProblems,
  normalizeProjectIndexV2,
  projectIndexV2Problems,
} from './store-schema.js'
import type {
  ActivityEvent,
  InboxItem,
  ProjectIndexV2,
  TopicRecordV2,
  WorkItemRecordV2,
} from './store-schema.js'

export type { ActivityEvent, InboxItem, ProjectIndexV2, TopicRecordV2, WorkItemRecordV2 } from './store-schema.js'

export const M12_E2E_EVIDENCE_RELATIVE = '.dsh-cowork/e2e/M12_E2E.json'

export const M12_E2E_RUN_PATH = '/dsh-cowork/e2e/m12/run'

export const M12_E2E_STATUS_PATH = '/dsh-cowork/e2e/m12/status'

export const M12_E2E_STEP_TIMEOUT_MS = 180_000

export const M12_E2E_POLL_MS = 500

export const M12_E2E_SHORT_IDLE_MS = 500

export const M12_E2E_SHORT_RESOLVE_MS = 1_000

export const M12_E2E_FIXTURE_PREFIX = 'dsh-cowork-m12-'

export const M12_E2E_WORK_FILE = 'm12-e2e.txt'

export const M12_E2E_WORK_CONTENT = 'M12-E2E-WORK'

export const M12_E2E_TOPIC_INTENT = 'M12 E2E billing retry backoff'

export const M12_E2E_WAIT_BRIEF = 'M12 E2E control: do not start any work and do not create or edit files yet; reply DONE.'

export const M12_E2E_REVIEW_SUMMARY = 'M12 E2E review: the isolated work item adds m12-e2e.txt and the recorded verification passed.'

export const M12_E2E_HANDOFF_SUMMARY = 'M12 E2E topic: the isolated work item added m12-e2e.txt, the work item commit was reviewed, and the merge is the master decision.'

export const M12_E2E_DONE = 'Reply DONE.'

export const MAX_EVENTS = 4_000
export const MAX_ASSISTANT_TEXT = 1_000
export const MAX_FILE_TEXT = 2_000
export const MAX_GIT_TEXT = 2_000
export const MAX_FIELD_TEXT = 3_000
export const GIT_TIMEOUT_MS = 30_000
export const GIT_MAX_BUFFER = 8 * 1024 * 1024

export const PROJECT_INIT_TOOL = 'cowork_project_init'
export const ROUTE_TOOL = 'cowork_route'
export const WORK_ITEM_TOOL = 'cowork_work_item_create'
export const REVIEW_REQUEST_TOOL = 'cowork_review_request'
export const REVIEW_VERDICT_TOOL = 'cowork_review_verdict'
export const HANDOFF_TOOL = 'cowork_handoff'
export const MERGE_TOOL = 'cowork_checkout_merge'

export { MASTER_PRESET_ID, REVIEWER_PRESET_ID, TOPIC_PRESET_ID }

export const M12_EXPECTED_ACTIVITY_TYPES = [
  'topic-created',
  'route-created',
  'work-item-created',
  'review-requested',
  'review-verdict',
  'work-item-merged',
  'status-changed',
  'topic-reopened',
] as const

export const M12_STEP_IDS = [
  'setup',
  'route-topic',
  'session-list',
  'overview',
  'work-item',
  'work-item-commit',
  'review-request',
  'review-verdict',
  'master-merge-decision',
  'handoff-done',
  'merge',
  'auto-resolve',
  'no-undo',
  'resolved-no-receive',
  'reopen',
  'activity',
  'cleanup',
] as const

export type M12RunState = 'running' | 'done' | 'failed'

export type M12StepStatus = 'pending' | 'running' | 'passed' | 'failed'

export type PromptMode = 'queue' | 'steer'

export type M12SessionRole = 'master' | 'topic' | 'reviewer'

export interface SessionEvent {
  readonly type: string
  readonly seq: number
  readonly data: Record<string, unknown>
}

export interface M12SessionRow {
  readonly sessionId: string
  readonly cwd?: string
  readonly running: boolean
}

export interface M12Assertion {
  readonly name: string
  readonly ok: boolean
  readonly evidence: string
}

export interface M12ToolCallEvidence {
  readonly name: string
  readonly callId: string
  readonly arguments: string
  resultText: string | null
  isError: boolean | null
}

export interface M12PromptEvidence {
  readonly sessionId: string
  readonly role: M12SessionRole
  readonly content: string
  readonly mode: PromptMode
  accepted: boolean
  readonly fromSeq: number
  assistantText: string
  toolCalls: M12ToolCallEvidence[]
}

export interface M12StepEvidence {
  startedAt: string | null
  endedAt: string | null
  prompts: M12PromptEvidence[]
  observations: Record<string, unknown>
  assertions: M12Assertion[]
  note?: string
  error?: string
}

export interface M12StepView {
  readonly id: string
  readonly status: M12StepStatus
  readonly evidence: M12StepEvidence
}

export interface M12RunStatusView {
  readonly runId: string
  readonly state: M12RunState
  readonly startedAt: string
  readonly endedAt?: string
  readonly steps: readonly M12StepView[]
  readonly evidenceFile: string
  readonly error?: string
}

export interface M12ArtifactIdentity {
  readonly repoPath: string
  readonly pluginVersion: string
  
  readonly head: string | null
  
  readonly baseRef: string
  
  readonly baseCommit: string | null
  
  readonly diffSha256: string | null
  
  readonly diffCommand: string
  
  readonly statusPorcelain: string | null
  
  readonly gitAvailable: boolean
  readonly error?: string
  
  readonly emptyRange: boolean
}

export interface M12ArchivedSession {
  readonly role: string
  readonly sessionId: string
  readonly archived: boolean
  readonly error: string | null
}

export interface M12CleanupReport {
  readonly sessions: readonly M12ArchivedSession[]
  readonly archivedSessionIds: readonly string[]
  readonly archiveErrors: readonly string[]
  readonly workspaceId: string | null
  readonly workspaceDeleted: boolean
  readonly workspaceError: string | null
  readonly fixturePath: string
  readonly keepFixture: boolean
  readonly fixtureRemoved: boolean
  readonly errors: readonly string[]
}

export interface M12EvidenceDocument {
  readonly version: 1
  readonly runId: string
  readonly state: M12RunState
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
  readonly fixture: {
    readonly path: string | null
    readonly keep: boolean
  }
  readonly artifactIdentity: M12ArtifactIdentity | null
  readonly steps: readonly M12StepView[]
  readonly finalIndex: unknown
  readonly cleanup: M12CleanupReport | Record<string, unknown>
  readonly error?: string
}

export interface M12ReviewRequestView {
  readonly filePath: string
  readonly requestId: string
  readonly status: string
  readonly topicId: string
  readonly workItemId: string | null
  readonly baseCommit: string
  readonly headCommit: string
  readonly path: string
  readonly branch: string | null
  readonly changedPaths: readonly string[]
  readonly verificationCount: number
  readonly reviewerSessionId: string | null
  readonly requestedAt: string
  readonly reviewedAt: string | null
  readonly summary: string | null
  readonly findingCount: number
  readonly record: Record<string, unknown>
}

export interface M12OverviewTopic {
  readonly topicId: string
  readonly status: string
  readonly awaitingReview: boolean
  readonly reviewStatus: string | null
  readonly resolvedAt: string | null
  readonly resolvedBy: string | null
}

export interface M12PanelResult {
  readonly status: number
  readonly body: unknown
}

export interface M12PanelProbe {
  overview(input: { sessionId: string }): Promise<M12PanelResult>
  reopen(input: { sessionId: string; topicId: string }): Promise<M12PanelResult>
}

export interface M12E2EHost {
  readonly sessionController: {
    create(request: {
      workspaceId?: string
      cwd?: string
      sessionId?: string
      agentPreset?: string
    }): Promise<{ sessionId: string; agentPreset?: string }>
    prompt(
      request: {
        requestId: string
        sessionId: string
        mode: PromptMode
        content: ReadonlyArray<{ type: 'text'; text: string }>
      },
      signal?: AbortSignal,
    ): Promise<{ accepted: boolean }>
    list(request?: unknown, signal?: AbortSignal): Promise<{ items: readonly M12SessionRow[] }>
    inspect(sessionId: string, signal?: AbortSignal): Promise<{ meta: { id: string; cwd?: string; agentPreset?: string } }>
  }
  readonly workspaceRegistry: {
    resolveByPath(path: string): Promise<{ id: string; path: string } | undefined>
    delete(id: string): Promise<boolean>
    archiveSession(sessionId: string, options?: { stopActivity?: boolean }): Promise<void>
    
    readonly archivedSessionIds?: readonly string[]
  }
  on(
    name: 'session/event',
    listener: (session: { id: string }, event: SessionEvent) => void,
  ): () => void
}

export interface M12E2EConfig {
  
  readonly repoPath: string
  
  readonly fixturePath?: string
  
  readonly keepFixture?: boolean
  
  readonly artifactBaseRef?: string
  readonly promptTimeoutMs: number
  
  readonly idleAfterMs: number
  readonly resolveAfterMs: number
  readonly pluginName: string
  readonly pluginVersion: string
  readonly panel: M12PanelProbe
  readonly log?: (message: string) => void
}

export interface MutableStep {
  readonly id: string
  status: M12StepStatus
  readonly evidence: M12StepEvidence
}

export interface MutableRun {
  readonly runId: string
  state: M12RunState
  readonly startedAt: string
  endedAt?: string
  readonly steps: MutableStep[]
  error?: string
  finalIndex: unknown
  cleanup: M12CleanupReport | Record<string, unknown>
  artifactIdentity: M12ArtifactIdentity | null
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

export function createRun(runId: string, startedAt: string): MutableRun {
  return {
    runId,
    state: 'running',
    startedAt,
    steps: M12_STEP_IDS.map((id) => ({
      id,
      status: 'pending',
      evidence: { startedAt: null, endedAt: null, prompts: [], observations: {}, assertions: [] },
    })),
    finalIndex: null,
    cleanup: {},
    artifactIdentity: null,
  }
}

export function runStatusView(run: MutableRun, evidenceFile: string): M12RunStatusView {
  return JSON.parse(JSON.stringify({
    runId: run.runId,
    state: run.state,
    startedAt: run.startedAt,
    ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
    steps: run.steps,
    evidenceFile,
    ...(run.error === undefined ? {} : { error: run.error }),
  })) as M12RunStatusView
}

export function buildEvidenceDocument(
  host: { plugin: string; pluginVersion: string; repoPath: string },
  run: MutableRun,
  evidenceFile: string,
  fixture: { path: string | null; keep: boolean },
): M12EvidenceDocument {
  return JSON.parse(JSON.stringify({
    version: 1,
    runId: run.runId,
    state: run.state,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? null,
    evidenceFile,
    host: {
      plugin: host.plugin,
      pluginVersion: host.pluginVersion,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      repoPath: host.repoPath,
    },
    fixture,
    artifactIdentity: run.artifactIdentity,
    steps: run.steps,
    finalIndex: run.finalIndex,
    cleanup: run.cleanup,
    ...(run.error === undefined ? {} : { error: run.error }),
  })) as M12EvidenceDocument
}

export function stepFailureState(stepId: string, error: unknown): { state: 'failed'; error: string } {
  return { state: 'failed', error: `step ${stepId}: ${messageOf(error)}` }
}

export function shouldRemoveFixture(state: M12RunState, keepFixture: boolean): boolean {
  if (keepFixture) return false
  return state === 'done' || state === 'failed'
}

export function shortThresholdsProblem(idleAfterMs: number, resolveAfterMs: number): string | null {
  if (idleAfterMs !== M12_E2E_SHORT_IDLE_MS) {
    return `idleAfterMs must be ${M12_E2E_SHORT_IDLE_MS} for the M12 E2E run; got ${idleAfterMs}`
  }
  if (resolveAfterMs !== M12_E2E_SHORT_RESOLVE_MS) {
    return `resolveAfterMs must be ${M12_E2E_SHORT_RESOLVE_MS} for the M12 E2E run; got ${resolveAfterMs}`
  }
  return null
}

/** The throwaway project must live outside the plugin repository, so a run can never write the real project's `.dsh-cowork` index/activity/inbox/reviews. */
export function fixturePathProblem(pluginRepoPath: string, fixturePath: string): string | null {
  const repo = resolve(pluginRepoPath)
  const fixture = resolve(fixturePath)
  if (fixture === repo) return `the E2E project must not be the plugin repository (${repo})`
  if (isStrictlyInside(repo, fixture)) {
    return `the E2E project must live outside the plugin repository (${fixture} is inside ${repo})`
  }
  return null
}

export interface ReviewVerdictPlan {
  readonly action: 'steer' | 'skip' | 'fail'
  readonly mode: PromptMode | null
  readonly reason: string
}

export function planReviewVerdict(
  request: Pick<M12ReviewRequestView, 'status'> | null,
  expected: 'pass' | 'needs_revision',
): ReviewVerdictPlan {
  if (request === null) return { action: 'steer', mode: 'steer', reason: 'the review request file is not visible yet' }
  if (request.status === expected) {
    return { action: 'skip', mode: null, reason: `the reviewer already produced ${expected}` }
  }
  if (request.status === 'pending') {
    return { action: 'steer', mode: 'steer', reason: 'the reviewer has not produced a verdict yet' }
  }
  return {
    action: 'fail',
    mode: null,
    reason: `the reviewer produced ${request.status} while ${expected} was expected`,
  }
}

export interface ReviewRequestPlan {
  readonly action: 'steer' | 'adopt' | 'fail'
  readonly reason: string
}

export function planRequestReview(
  requests: readonly Pick<M12ReviewRequestView, 'status' | 'workItemId'>[],
  workItemId: string,
): ReviewRequestPlan {
  const mine = requests.filter((request) => request.workItemId === workItemId)
  if (mine.some((request) => request.status === 'pending')) {
    return { action: 'adopt', reason: 'a pending review request for this work item already exists' }
  }
  if (mine.length > 0) {
    return { action: 'fail', reason: `the work item already has a reviewed request (${mine.map((request) => request.status).join(',')})` }
  }
  return { action: 'steer', reason: 'the topic must create the review request' }
}

export interface MergePlan {
  readonly action: 'skip' | 'steer'
  readonly reason: string
}

export function planMergePrompt(alreadyDone: boolean): MergePlan {
  return alreadyDone
    ? { action: 'skip', reason: 'merge target state was already reached; passed idempotently' }
    : { action: 'steer', reason: 'the merge instruction is steered into the master turn' }
}

export function missingActivityTypes(
  events: readonly Pick<ActivityEvent, 'type'>[],
  expected: readonly string[] = M12_EXPECTED_ACTIVITY_TYPES,
): string[] {
  const seen = new Set<string>(events.map((event) => event.type))
  return expected.filter((type) => !seen.has(type))
}

export function buildCleanupReport(input: {
  sessions: readonly M12ArchivedSession[]
  workspaceId: string | null
  workspaceDeleted: boolean
  workspaceError: string | null
  fixturePath: string
  keepFixture: boolean
  fixtureRemoved: boolean
  errors: readonly string[]
}): M12CleanupReport {
  return {
    sessions: [...input.sessions],
    archivedSessionIds: input.sessions.filter((session) => session.archived).map((session) => session.sessionId),
    archiveErrors: input.sessions
      .filter((session) => !session.archived)
      .map((session) => `${session.sessionId}: ${session.error ?? 'unknown error'}`),
    workspaceId: input.workspaceId,
    workspaceDeleted: input.workspaceDeleted,
    workspaceError: input.workspaceError,
    fixturePath: input.fixturePath,
    keepFixture: input.keepFixture,
    fixtureRemoved: input.fixtureRemoved,
    errors: [...input.errors],
  }
}

export interface ArtifactGitFacts {
  readonly head: GitOutcome
  readonly base: GitOutcome
  readonly diff: GitOutcome
  readonly status: GitOutcome
}

export function artifactIdentityFrom(input: {
  repoPath: string
  baseRef: string
  pluginVersion: string
  facts: ArtifactGitFacts
}): M12ArtifactIdentity {
  const head = input.facts.head.code === 0 ? input.facts.head.stdout.trim() : null
  const baseCommit = input.facts.base.code === 0 ? input.facts.base.stdout.trim() : null
  const diffOk = input.facts.diff.code === 0
  const statusOk = input.facts.status.code === 0
  const diffCommand = `git diff ${input.baseRef}..HEAD | shasum -a 256`
  const failed = [
    input.facts.head.code !== 0 ? input.facts.head : null,
    input.facts.base.code !== 0 ? input.facts.base : null,
    input.facts.diff.code !== 0 ? input.facts.diff : null,
    input.facts.status.code !== 0 ? input.facts.status : null,
  ].find((outcome): outcome is GitOutcome => outcome !== null)
  const identity: M12ArtifactIdentity = {
    repoPath: input.repoPath,
    pluginVersion: input.pluginVersion,
    head,
    baseRef: input.baseRef,
    baseCommit,
    diffSha256: diffOk ? createHash('sha256').update(input.facts.diff.stdout).digest('hex') : null,
    diffCommand,
    statusPorcelain: statusOk ? input.facts.status.stdout : null,
    gitAvailable: head !== null,
    emptyRange: head !== null && baseCommit !== null && head === baseCommit,
    ...(failed === undefined ? {} : { error: failed.stderr.trim() || `git exited ${failed.code}` }),
  }
  return identity
}

export function buildProjectInitPrompt(): string {
  return `Call ${PROJECT_INIT_TOOL} exactly once with no arguments. ${M12_E2E_DONE}`
}

export function buildRoutePrompt(): string {
  return [
    `Call ${ROUTE_TOOL} exactly once with these arguments (JSON):`,
    JSON.stringify({ intent: M12_E2E_TOPIC_INTENT, brief: M12_E2E_WAIT_BRIEF }, null, 2),
    M12_E2E_DONE,
  ].join('\n\n')
}

export function buildResolvedRoutePrompt(resolvedTopicId: string): string {
  return [
    `Call ${ROUTE_TOOL} exactly once with these arguments (JSON):`,
    JSON.stringify({ intent: `${M12_E2E_TOPIC_INTENT} follow-up`, brief: M12_E2E_WAIT_BRIEF, topicId: resolvedTopicId }, null, 2),
    `The topic is resolved; follow the tool result exactly and do not message it. ${M12_E2E_DONE}`,
  ].join('\n\n')
}

export function buildWorkItemPrompt(): string {
  return `Call ${WORK_ITEM_TOOL} exactly once with no arguments: it clones this repository for the topic. Do not edit files yet. ${M12_E2E_DONE}`
}

export function buildCommitPrompt(input: { checkoutPath: string; fileName: string; content: string; message: string }): string {
  return [
    'Use the bash tool to run exactly this one command and keep its real exit code:',
    `cd ${input.checkoutPath} && printf '${input.content}\\n' > ${input.fileName} && git add ${input.fileName} && git commit -m "${input.message}"`,
    `Change nothing else. ${M12_E2E_DONE}`,
  ].join('\n\n')
}

export interface ReviewRequestPromptInput {
  readonly workItemId: string
  readonly checkoutPath: string
  readonly baseCommit: string
  readonly headCommit: string
  readonly fileName: string
  readonly purpose: string
}

export function buildReviewRequestPrompt(input: ReviewRequestPromptInput): string {
  const args = {
    purpose: input.purpose,
    baseCommit: input.baseCommit,
    headCommit: input.headCommit,
    path: input.checkoutPath,
    workItemId: input.workItemId,
    verification: [{ command: `test -f ${input.fileName}`, exitCode: 0, evidence: `${input.fileName} exists in the reviewed clone` }],
    changedPaths: [input.fileName],
  }
  return [
    `Call ${REVIEW_REQUEST_TOOL} exactly once with these arguments (JSON):`,
    JSON.stringify(args, null, 2),
    `Do not change the arguments and do not commit anything else. ${M12_E2E_DONE}`,
  ].join('\n\n')
}

export interface ReviewerVerdictPromptInput {
  readonly requestId: string
  readonly workItemId: string
  readonly checkoutPath: string
  readonly branch: string
  readonly fileName: string
}

export function buildReviewerVerdictPrompt(input: ReviewerVerdictPromptInput): string {
  const args = {
    requestId: input.requestId,
    verdict: 'pass',
    summary: M12_E2E_REVIEW_SUMMARY,
    findings: [],
    verification: [{ command: `test -f ${input.fileName}`, exitCode: 0, evidence: '<copy what you observed here>' }],
  }
  return [
    'This is the M12 E2E review request. Act as the independent reviewer; never modify an implementation file.',
    `The reviewed work item ${input.workItemId} is the isolated clone ${input.checkoutPath} on branch ${input.branch}; read it with bash.`,
    `First run the recorded verification yourself: cd ${input.checkoutPath} && test -f ${input.fileName}. Keep its real exit code.`,
    'Before calling the verdict tool, follow this instruction; if you already planned a different verdict, replace it with the one below.',
    `Call ${REVIEW_VERDICT_TOOL} exactly once with these arguments (replace only the placeholder evidence with what you observed):`,
    JSON.stringify(args, null, 2),
    `Use verdict "pass" only if the file exists and the change matches the request. ${M12_E2E_DONE}`,
  ].join('\n\n')
}

export interface HandoffPromptInput {
  readonly fileName: string
}

export function buildHandoffPrompt(input: HandoffPromptInput): string {
  const args = {
    status: 'done',
    summary: M12_E2E_HANDOFF_SUMMARY,
    verification: [{ command: `test -f ${input.fileName}`, exitCode: 0, evidence: `${input.fileName} exists in the work item clone` }],
    changedPaths: [input.fileName],
  }
  return [
    `Call ${HANDOFF_TOOL} exactly once with these arguments (JSON):`,
    JSON.stringify(args, null, 2),
    M12_E2E_DONE,
  ].join('\n\n')
}

export function buildMergePrompt(workItemId: string): string {
  return [
    `Call ${MERGE_TOOL} exactly once with these arguments (JSON):`,
    JSON.stringify({ workItemId }, null, 2),
    `Do not touch main. ${M12_E2E_DONE}`,
  ].join('\n\n')
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

export function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
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

export function recordCheck(step: MutableStep, name: string, ok: boolean, evidence: unknown): void {
  const text = typeof evidence === 'string' ? evidence : stableJson(evidence)
  step.evidence.assertions.push({ name, ok, evidence: clip(text, MAX_FIELD_TEXT) })
  if (!ok) throw new Error(`assertion failed [${step.id}] ${name}: ${clip(text, 500)}`)
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

export async function writeEvidenceAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${createHash('sha256').update(`${process.pid}:${Date.now()}:${Math.random()}`).digest('hex')}.tmp`
  await writeFile(temp, content, { mode: 0o600 })
  await rename(temp, file)
}

export function isStrictlyInside(parent: string, child: string): boolean {
  const base = resolve(parent)
  const target = resolve(child)
  return target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

export function runGit(args: readonly string[], cwd: string): Promise<GitOutcome> {
  return new Promise<GitOutcome>((settle) => {
    execFile(
      'git',
      [...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error === null) {
          settle({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '' })
          return
        }
        const exit = (error as { code?: unknown }).code
        settle({
          code: typeof exit === 'number' ? exit : 1,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' && stderr.length > 0 ? stderr : (error as Error).message,
        })
      },
    )
  })
}

export function parseProjectIndexV2(text: string): ProjectIndexV2 | undefined {
  try {
    const parsed = asRecord(JSON.parse(text))
    if (parsed === undefined || parsed.version !== 2 || !Array.isArray(parsed.topics)) return undefined
    const document = normalizeProjectIndexV2(parsed) as ProjectIndexV2
    if (projectIndexV2Problems(document).length > 0) return undefined
    return document
  } catch {
    return undefined
  }
}

export interface ActivityFileRead {
  readonly events: ActivityEvent[]
  readonly skippedLines: number
}

export function parseActivityFile(text: string): ActivityFileRead {
  const events: ActivityEvent[] = []
  let skippedLines = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      skippedLines += 1
      continue
    }
    if (activityEventProblems(parsed).length > 0) {
      skippedLines += 1
      continue
    }
    events.push(parsed as ActivityEvent)
  }
  return { events, skippedLines }
}

export function parseInboxFile(text: string): InboxItem[] {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    const items: InboxItem[] = []
    for (const entry of parsed) {
      if (inboxItemProblems(entry).length > 0) return []
      items.push(entry as InboxItem)
    }
    return items
  } catch {
    return []
  }
}

export function reviewRequestView(filePath: string, record: Record<string, unknown>): M12ReviewRequestView {
  return {
    filePath,
    requestId: String(record.requestId ?? ''),
    status: String(record.status ?? ''),
    topicId: String(record.topicId ?? ''),
    workItemId: stringOrNull(record.workItemId),
    baseCommit: String(record.baseCommit ?? ''),
    headCommit: String(record.headCommit ?? ''),
    path: String(record.path ?? ''),
    branch: stringOrNull(record.branch),
    changedPaths: Array.isArray(record.changedPaths) ? record.changedPaths.filter((entry): entry is string => typeof entry === 'string') : [],
    verificationCount: Array.isArray(record.verification) ? record.verification.length : 0,
    reviewerSessionId: stringOrNull(record.reviewerSessionId),
    requestedAt: String(record.requestedAt ?? ''),
    reviewedAt: stringOrNull(record.reviewedAt),
    summary: stringOrNull(record.summary),
    findingCount: Array.isArray(record.findings) ? record.findings.length : 0,
    record,
  }
}

export async function readReviewRequests(reviewsDir: string): Promise<M12ReviewRequestView[]> {
  let names: string[]
  try {
    names = await readdir(reviewsDir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw error
  }
  const requests: M12ReviewRequestView[] = []
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    const filePath = join(reviewsDir, name)
    const text = await readTextIfPresent(filePath)
    if (text === undefined) continue
    const parsed = parseReviewRequestRecord(text)
    if (!parsed.ok) continue
    requests.push(reviewRequestView(filePath, parsed.record as unknown as Record<string, unknown>))
  }
  requests.sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))
  return requests
}

export interface HandoffFileView {
  readonly filePath: string
  readonly topicId: string
  readonly status: string
  readonly summary: string
  readonly createdAt: string
}

export async function readHandoffFiles(handoffsDir: string): Promise<HandoffFileView[]> {
  let names: string[]
  try {
    names = await readdir(handoffsDir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw error
  }
  const files: HandoffFileView[] = []
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    const filePath = join(handoffsDir, name)
    const text = await readTextIfPresent(filePath)
    if (text === undefined) continue
    try {
      const record = asRecord(JSON.parse(text))
      if (record === undefined) continue
      if (typeof record.threadId !== 'string' || typeof record.status !== 'string') continue
      if (typeof record.summary !== 'string' || typeof record.createdAt !== 'string') continue
      files.push({ filePath, topicId: record.threadId, status: record.status, summary: record.summary, createdAt: record.createdAt })
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
    else parts.push(stableJson(block))
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

export function toolCallsSince(events: readonly SessionEvent[], fromSeq: number, name?: string): M12ToolCallEvidence[] {
  const calls = new Map<string, M12ToolCallEvidence>()
  for (const event of events) {
    if (event.seq <= fromSeq) continue
    if (event.type === 'tool/call') {
      const callName = typeof event.data.name === 'string' ? event.data.name : ''
      if (name !== undefined && callName !== name) continue
      const callId = typeof event.data.callId === 'string' ? event.data.callId : `seq-${event.seq}`
      calls.set(callId, { name: callName, callId, arguments: clip(String(event.data.arguments ?? ''), 4_000), resultText: null, isError: null })
      continue
    }
    if (event.type !== 'tool/result') continue
    const message = asRecord(event.data.message)
    const callId = typeof message?.toolCallId === 'string'
      ? message.toolCallId
      : typeof asRecord(message?.source)?.callId === 'string'
        ? String(asRecord(message?.source)?.callId)
        : undefined
    if (callId === undefined) continue
    const call = calls.get(callId)
    if (call === undefined) continue
    call.resultText = clip(contentText(message), 4_000)
    call.isError = message?.isError === true || asRecord(event.data.error) !== undefined
  }
  return [...calls.values()]
}

export function deliveryEventSince(sessionId: string, events: readonly SessionEvent[], fromSeq: number, needle: string): DeliveryEvent | undefined {
  const matches: DeliveryEvent[] = []
  for (const event of events) {
    if (event.seq <= fromSeq) continue
    const text = stableJson(event.data)
    if (!text.includes(needle)) continue
    matches.push({
      type: event.type,
      seq: event.seq,
      source: event.type === 'assistant/message' ? 'assistant-text' : 'event',
      text: clip(text, MAX_FIELD_TEXT),
    })
  }
  return matches.find((match) => match.source === 'event') ?? matches[0]
}

export function eventsSince(events: readonly SessionEvent[], fromSeq: number): SessionEvent[] {
  return events.filter((event) => event.seq > fromSeq)
}

export function toolResultJson(call: M12ToolCallEvidence): Record<string, unknown> | undefined {
  if (call.resultText === null) return undefined
  try {
    return asRecord(JSON.parse(call.resultText))
  } catch {
    return undefined
  }
}

export function topicOf(index: ProjectIndexV2 | undefined, topicId: string): TopicRecordV2 | undefined {
  return index?.topics.find((topic) => topic.topicId === topicId)
}

export function workItemOfTopic(index: ProjectIndexV2 | undefined, topicId: string): WorkItemRecordV2 | undefined {
  return index?.workItems.find((item) => item.topicId === topicId)
}

export const PROJECT_DIR_RELATIVE = '.dsh-cowork'

export const INDEX_FILE_RELATIVE = `${PROJECT_DIR_RELATIVE}/index.json`

export const ACTIVITY_FILE_RELATIVE = `${PROJECT_DIR_RELATIVE}/activity.jsonl`

export const INBOX_FILE_RELATIVE = `${PROJECT_DIR_RELATIVE}/inbox.json`

export const REVIEWS_DIR_RELATIVE = `${PROJECT_DIR_RELATIVE}/reviews`

export const HANDOFFS_DIR_RELATIVE = `${PROJECT_DIR_RELATIVE}/handoffs`

export function projectPath(fixturePath: string, relative: string): string {
  return join(fixturePath, relative)
}

export function isLiveTopicStatus(status: string | undefined): boolean {
  return status === 'active' || status === 'idle'
}

export interface SidebarFacts {
  rowExists: boolean
  cwdMatches: boolean
  cwd: string | null
  running: boolean | undefined
  topicPreset: string | null
  archived: readonly string[] | undefined
}

export function assertSidebarVisibility(step: MutableStep, sessionId: string, facts: SidebarFacts): void {
  obs(step, { topicRow: facts.rowExists ? { sessionId, cwd: facts.cwd, running: facts.running, preset: facts.topicPreset } : null, archivedObservable: facts.archived !== undefined })
  recordCheck(step, 'the host session list contains the topic session (left sidebar)', facts.rowExists, `listed=${facts.rowExists}`)
  recordCheck(step, 'the topic session cwd is the throwaway project', facts.cwdMatches, String(facts.cwd))
  recordCheck(step, 'the topic session is not running', facts.running === false, String(facts.running))
  recordCheck(step, 'the topic session mounted cowork-topic', facts.topicPreset === TOPIC_PRESET_ID, String(facts.topicPreset))
  if (facts.archived !== undefined) {
    recordCheck(step, 'the topic session is not archived', !facts.archived.includes(sessionId), `archived=${facts.archived.length}`)
  } else {
    step.evidence.note = 'the host exposes no archivedSessionIds getter; sidebar visibility is proven by the listing row'
  }
}

export interface MergeFacts {
  fileName: string
  filePath: string
  fileText: string | undefined
  clonePath: string
  cloneExists: boolean
  branchExit: number
  workItemStatus: string
  workItemHead: string | null
  reviewedHead: string
  mainRefBefore: string
  mainRefAfter: string
  headBefore: string
  headAfter: string
  parentsStdout: string
  parentsExit: number
  ancestorExit: number
}

export function assertMergedFacts(step: MutableStep, facts: MergeFacts): void {
  obs(step, {
    mainRefBefore: facts.mainRefBefore,
    mainRefAfter: facts.mainRefAfter,
    headBefore: facts.headBefore,
    headAfter: facts.headAfter,
    mergeParents: facts.parentsStdout.trim(),
    ancestorExit: facts.ancestorExit,
  })
  recordCheck(step, `${facts.fileName} exists in the main worktree`, facts.fileText !== undefined, facts.filePath)
  recordCheck(step, `${facts.fileName} holds the committed content`, facts.fileText?.trim() === M12_E2E_WORK_CONTENT, String(facts.fileText))
  recordCheck(step, 'the work item clone was torn down', !facts.cloneExists, facts.clonePath)
  recordCheck(step, 'the work item branch was deleted', facts.branchExit !== 0, `exit=${facts.branchExit}`)
  recordCheck(step, 'the index marks the work item merged', facts.workItemStatus === 'merged', facts.workItemStatus)
  recordCheck(step, 'the index keeps the reviewed head', facts.workItemHead === facts.reviewedHead, `${String(facts.workItemHead)} == ${facts.reviewedHead}`)
  recordCheck(step, 'the main branch ref did not move', facts.mainRefAfter === facts.mainRefBefore, `${facts.mainRefAfter} == ${facts.mainRefBefore}`)
  recordCheck(step, 'the integration branch advanced by a merge', facts.headAfter !== facts.headBefore, `${facts.headBefore} -> ${facts.headAfter}`)
  recordCheck(step, 'the merge commit has two parents', facts.parentsExit === 0 && facts.parentsStdout.trim().split(/\s+/).length === 3, facts.parentsStdout.trim())
  recordCheck(step, 'the reviewed head is an ancestor of the merge', facts.ancestorExit === 0, `exit=${facts.ancestorExit}`)
}

export interface VerdictFacts {
  request: M12ReviewRequestView
  reviewerSessionId: string
  topicReviewStatus: string | null
  topicAwaitingReview: boolean
  indexReviewerSessionId: string | null
  workItemStatus: string
  inboxItem: InboxItem
  reviewerArchived: boolean
}

export function assertVerdictFacts(step: MutableStep, facts: VerdictFacts): void {
  const request = facts.request
  obs(step, {
    requestStatus: request.status,
    reviewedAt: request.reviewedAt,
    summary: clip(String(request.summary), 1_000),
    findings: request.findingCount,
    verification: request.verificationCount,
    topicReviewStatus: facts.topicReviewStatus,
    topicAwaitingReview: facts.topicAwaitingReview,
    workItemStatus: facts.workItemStatus,
    mergeInboxItem: facts.inboxItem,
    reviewerArchived: facts.reviewerArchived,
  })
  recordCheck(step, 'the verdict is bound to the request and the reviewer', request.reviewerSessionId === facts.reviewerSessionId, `${String(request.reviewerSessionId)} == ${facts.reviewerSessionId}`)
  recordCheck(step, 'the pass says what was reviewed', request.summary !== null && request.summary.trim() !== '', String(request.summary))
  recordCheck(step, 'the pass carries no findings', request.findingCount === 0, String(request.findingCount))
  recordCheck(step, 'the pass carries its verification', request.verificationCount >= 1, String(request.verificationCount))
  recordCheck(step, 'the topic records the pass', facts.topicReviewStatus === 'pass', String(facts.topicReviewStatus))
  recordCheck(step, 'the topic is no longer awaiting review', facts.topicAwaitingReview === false, String(facts.topicAwaitingReview))
  recordCheck(step, 'the index drops the reviewer id after the verdict', facts.indexReviewerSessionId === null, String(facts.indexReviewerSessionId))
  recordCheck(step, 'the reviewed work item is in reviewing state', facts.workItemStatus === 'reviewing', facts.workItemStatus)
  recordCheck(step, 'the reviewer session is archived after the verdict', facts.reviewerArchived, 'archivedSessionIds includes the reviewer')
}

export interface RequestFacts {
  request: M12ReviewRequestView
  reviewerSessionId: string
  topicId: string
  workItemId: string
  headCommit: string
  checkoutPath: string
  branch: string
  filePath: string
  fileExists: boolean
  reviewerPreset: string | null
}

export function assertRequestFacts(step: MutableStep, facts: RequestFacts): void {
  const request = facts.request
  obs(step, {
    requestFilePath: request.filePath,
    requestStatusAtPoll: request.status,
    request: clip(stableJson(request.record), 4_000),
    reviewerPreset: facts.reviewerPreset,
  })
  recordCheck(step, 'the request record names the topic', request.topicId === facts.topicId, request.topicId)
  recordCheck(step, 'the request record names the work item', request.workItemId === facts.workItemId, String(request.workItemId))
  recordCheck(step, 'the request record names the reviewed head', request.headCommit === facts.headCommit, `${request.headCommit} == ${facts.headCommit}`)
  recordCheck(step, 'the request record names the clone path', resolve(request.path) === resolve(facts.checkoutPath), request.path)
  recordCheck(step, 'the request record names the work item branch', request.branch === facts.branch, String(request.branch))
  recordCheck(step, 'the request record carries the changed path', request.changedPaths.length === 1 && request.changedPaths[0] === M12_E2E_WORK_FILE, request.changedPaths.join(','))
  recordCheck(step, 'the request record carries the verification', request.verificationCount >= 1, String(request.verificationCount))
  recordCheck(step, 'the request record is bound to the reviewer session', request.reviewerSessionId === facts.reviewerSessionId, String(request.reviewerSessionId))
  recordCheck(step, 'the request file exists', facts.fileExists && existsSync(facts.filePath), facts.filePath)
  recordCheck(step, 'the reviewer session mounted cowork-reviewer', facts.reviewerPreset === REVIEWER_PRESET_ID, String(facts.reviewerPreset))
}

export interface MergeDecisionFacts {
  inbox: readonly InboxItem[]
  delivered: readonly InboxItem[]
  topicId: string
  workItemId: string
  deliveryText: string | null
  leakedSummaryEvents: number
  leakedProcessEvents: number
  requestSummary: string | null
}

export function assertMergeDecision(step: MutableStep, facts: MergeDecisionFacts): void {
  obs(step, {
    inbox: facts.inbox.map((entry) => ({ kind: entry.kind, topicId: entry.topicId, deliveredAt: entry.deliveredAt, summary: clip(entry.summary, 300) })),
    masterDelivery: facts.deliveryText === null ? null : clip(facts.deliveryText, 600),
    leakedEventCount: facts.leakedSummaryEvents,
    summaryNeedle: facts.requestSummary === null ? null : clip(facts.requestSummary, 200),
  })
  recordCheck(step, 'the master received exactly one inbox decision', facts.delivered.length === 1, String(facts.delivered.length))
  const decision = facts.delivered[0]
  recordCheck(step, 'the decision is a merge-needed item for this topic', decision?.kind === 'merge-needed' && decision.topicId === facts.topicId, `${String(decision?.kind)} ${String(decision?.topicId)}`)
  recordCheck(step, 'the merge decision names the reviewed work item', typeof decision?.summary === 'string' && decision.summary.includes(facts.workItemId), String(decision?.summary))
  recordCheck(step, 'the master received no review-reject or blocked item', facts.inbox.every((entry) => entry.kind === 'merge-needed'), facts.inbox.map((entry) => entry.kind).join(','))
  recordCheck(step, 'the master session received the merge decision message', facts.deliveryText !== null, 'merge-needed delivery event')
  recordCheck(step, 'the master received no review summary', facts.leakedSummaryEvents === 0, `events containing the summary: ${facts.leakedSummaryEvents}`)
  recordCheck(step, 'the master received no review process text', facts.leakedProcessEvents === 0, `events containing review process text: ${facts.leakedProcessEvents}`)
}

export async function assertActivityAudit(
  step: MutableStep,
  input: { fixturePath: string; topicId: string; requestId: string; workItemId: string | null },
): Promise<void> {
  const text = await readTextIfPresent(join(input.fixturePath, ACTIVITY_FILE_RELATIVE))
  const activity = parseActivityFile(text ?? '')
  obs(step, { skippedLines: activity.skippedLines, eventCount: activity.events.length, types: countActivityTypes(activity.events) })
  recordCheck(step, 'activity.jsonl has no skipped lines', activity.skippedLines === 0, String(activity.skippedLines))
  const missing = missingActivityTypes(activity.events)
  recordCheck(step, 'activity.jsonl carries every chain event type', missing.length === 0, `missing: ${missing.join(',')}`)
  const ids = activity.events.map((event) => event.eventId)
  recordCheck(step, 'activity event ids are unique', new Set(ids).size === ids.length, `${ids.length} rows`)
  const times = activity.events.map((event) => Date.parse(event.time))
  recordCheck(step, 'activity rows are in time order', times.every((time, index) => index === 0 || times[index - 1] <= time), 'non-decreasing')
  const topicTypes = ['topic-created', 'route-created', 'work-item-created', 'review-requested', 'review-verdict', 'work-item-merged', 'topic-reopened'] as const
  for (const type of topicTypes) {
    recordCheck(step, `activity has ${type} for the chain topic`, activity.events.some((event) => event.type === type && event.topicId === input.topicId), `topic ${input.topicId}`)
  }
  const verdict = activity.events.find((event) => event.type === 'review-verdict' && event.topicId === input.topicId)
  recordCheck(step, 'the verdict activity names the request', asRecord(verdict?.details)?.requestId === input.requestId, String(asRecord(verdict?.details)?.requestId))
  const merged = activity.events.find((event) => event.type === 'work-item-merged' && event.topicId === input.topicId)
  recordCheck(step, 'the merge activity names the work item', asRecord(merged?.details)?.workItemId === input.workItemId, String(asRecord(merged?.details)?.workItemId))
  recordCheck(step, 'the resolution activity exists', activity.events.some((event) => event.type === 'status-changed' && event.topicId === input.topicId && asRecord(event.details)?.to === 'resolved'), 'status-changed to resolved')
  obs(step, { tail: activity.events.slice(-12).map((event) => ({ type: event.type, topicId: event.topicId, summary: clip(event.summary, 160) })) })
}

export function countActivityTypes(events: readonly ActivityEvent[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1
  return counts
}

export interface NoUndoFacts {
  resolveAfterMs: number
  resolvedAt: string | null
  topicId: string
  readTopics: () => Promise<M12OverviewTopic[]>
  readIndex: () => Promise<ProjectIndexV2 | undefined>
  readActivity: () => Promise<{ events: ActivityEvent[] }>
}

export async function assertNoUndoAfterWindow(step: MutableStep, facts: NoUndoFacts): Promise<void> {
  const before = facts.resolvedAt
  await sleep(facts.resolveAfterMs + M12_E2E_POLL_MS)
  const row = (await facts.readTopics()).find((entry) => entry.topicId === facts.topicId)
  obs(step, { resolvedAtBefore: before, resolvedAtAfter: row?.resolvedAt ?? null, status: row?.status ?? null })
  recordCheck(step, 'the topic is still resolved after another window', row?.status === 'resolved', String(row?.status))
  recordCheck(step, 'the resolution timestamp did not change', row?.resolvedAt === before, `${String(row?.resolvedAt)} == ${String(before)}`)
  const indexRow = topicOf(await facts.readIndex(), facts.topicId)
  recordCheck(step, 'the index still records the same resolution', indexRow?.status === 'resolved' && indexRow.resolvedAt === before, String(indexRow?.resolvedAt))
  const reopened = (await facts.readActivity()).events.filter((event) => event.type === 'topic-reopened' && event.topicId === facts.topicId)
  recordCheck(step, 'nothing reopened the topic', reopened.length === 0, `topic-reopened rows: ${reopened.length}`)
}

export interface ReopenFacts {
  status: number
  body: unknown
  indexRow: TopicRecordV2 | undefined
  activity: { events: ActivityEvent[] }
  replacedResolvedAt: string | null
  topicId: string
}

export function assertReopenFacts(step: MutableStep, facts: ReopenFacts): void {
  const body = asRecord(facts.body)
  const panelTopic = asRecord(body?.topic)
  obs(step, { status: facts.status, reopen: clip(stableJson(facts.body), 2_000) })
  recordCheck(step, 'POST /api/cowork.topic.reopen returns 200', facts.status === 200, String(facts.status))
  recordCheck(step, 'the reopen body is ok', body?.ok === true, clip(stableJson(facts.body), 1_000))
  recordCheck(step, 'the topic is active again', panelTopic?.status === 'active', String(panelTopic?.status))
  recordCheck(step, 'the resolution fields are cleared', panelTopic?.resolvedAt === null && panelTopic?.resolvedBy === null, `resolvedAt=${String(panelTopic?.resolvedAt)} resolvedBy=${String(panelTopic?.resolvedBy)}`)
  recordCheck(step, 'the index cleared the resolution', facts.indexRow?.status === 'active' && facts.indexRow.resolvedAt === null && facts.indexRow.resolvedBy === null, `${String(facts.indexRow?.status)} ${String(facts.indexRow?.resolvedAt)}`)
  const reopened = facts.activity.events.find((event) => event.type === 'topic-reopened' && event.topicId === facts.topicId)
  obs(step, { reopenActivity: reopened === undefined ? null : { eventId: reopened.eventId, details: reopened.details } })
  recordCheck(step, 'the reopen is recorded in activity.jsonl', reopened !== undefined, 'topic-reopened row')
  recordCheck(step, 'the reopen activity keeps the replaced resolution', asRecord(reopened?.details)?.resolvedAt === facts.replacedResolvedAt, String(asRecord(reopened?.details)?.resolvedAt))
}

export async function persistEvidenceDocument(
  document: M12EvidenceDocument,
  evidenceFile: string,
  log?: (message: string) => void,
): Promise<void> {
  try {
    await writeEvidenceAtomic(evidenceFile, `${JSON.stringify(document, null, 2)}\n`)
  } catch (error) {
    log?.(`M12 E2E evidence write failed: ${messageOf(error)}`)
  }
}

export function sessionEventSummary(events: readonly SessionEvent[]): string {
  return clip(`${events.slice(-12).map((event) => event.type).join(',')} | ${assistantTextSince(events, 0)}`, 800)
}

export async function readProjectIndexAt(fixturePath: string): Promise<ProjectIndexV2 | undefined> {
  const text = await readTextIfPresent(join(fixturePath, INDEX_FILE_RELATIVE))
  return text === undefined ? undefined : parseProjectIndexV2(text)
}

export async function readActivityAt(fixturePath: string): Promise<ActivityFileRead> {
  const text = await readTextIfPresent(join(fixturePath, ACTIVITY_FILE_RELATIVE))
  return parseActivityFile(text ?? '')
}

export async function readInboxAt(fixturePath: string): Promise<InboxItem[]> {
  const text = await readTextIfPresent(join(fixturePath, INBOX_FILE_RELATIVE))
  return text === undefined ? [] : parseInboxFile(text)
}

export async function readReviewRequestAt(fixturePath: string, requestId: string): Promise<M12ReviewRequestView | null> {
  const requests = await readReviewRequests(join(fixturePath, REVIEWS_DIR_RELATIVE))
  return requests.find((request) => request.requestId === requestId) ?? null
}
