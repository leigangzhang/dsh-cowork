/** M12 real-host E2E runner: lifecycle, session capture, and host plumbing. */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, realpath, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  M12_E2E_EVIDENCE_RELATIVE,
  M12_E2E_POLL_MS,
  M12_E2E_STEP_TIMEOUT_MS,
  MAX_EVENTS,
  MAX_GIT_TEXT,
  assistantTextSince,
  buildEvidenceDocument,
  clip,
  createRun,
  isoNow,
  lastSeq,
  messageOf,
  obs,
  parseInboxFile,
  persistEvidenceDocument,
  readActivityAt,
  readInboxAt,
  readProjectIndexAt,
  readReviewRequestAt,
  recordCheck,
  runGit,
  runStatusView,
  shouldRemoveFixture,
  sleep,
  stepFailureState,
  toolCallsSince,
  toolResultJson,
  workItemOfTopic,
} from './m12-e2e-support.js'
import type {
  ActivityEvent,
  GitOutcome,
  M12ArchivedSession,
  M12CleanupReport,
  M12E2EConfig,
  M12E2EHost,
  M12EvidenceDocument,
  M12PromptEvidence,
  M12ReviewRequestView,
  M12RunState,
  M12RunStatusView,
  M12SessionRole,
  M12ToolCallEvidence,
  MutableRun,
  MutableStep,
  PromptMode,
  ProjectIndexV2,
  SessionEvent,
  WorkItemRecordV2,
} from './m12-e2e-support.js'

/** Options one run may carry (the dev route reads them from the query string). */
export interface M12RunOptions {
  readonly keep?: boolean
  /** Base ref for the artifact diff (e.g. the M12 base commit). */
  readonly baseRef?: string
}

/**
 * The half of the runner the seventeen chain steps build on: the run registry,
 * the session event buffer, the poll/prompt/git primitives, the index readers,
 * and the end-of-run cleanup report.
 *
 * The steps themselves are the subclass in `m12-e2e.ts`; they are abstract
 * here only through {@link runStep}, so the lifecycle loop stays in one file and
 * every step stays together in the other.
 */
export abstract class M12E2ERunnerBase {
  protected readonly host: M12E2EHost
  protected readonly config: M12E2EConfig
  private readonly runs = new Map<string, MutableRun>()
  private readonly events = new Map<string, SessionEvent[]>()
  protected readonly tracked = new Set<string>()
  private readonly evidenceFile: string
  private lastRunId: string | null = null
  private disposed = false
  protected fixturePath: string | null = null
  protected keepFixture = false
  protected masterId: string | null = null
  protected topicId: string | null = null
  protected reviewerId: string | null = null
  protected extraTopicId: string | null = null
  protected workItemId: string | null = null
  protected mainRef = ''
  protected setupHead = ''
  protected reviewedHead = ''
  protected requestId = ''
  protected requestSummary: string | null = null
  protected masterSeqAtVerdict = 0
  protected resolvedAt: string | null = null

  constructor(host: M12E2EHost, config: M12E2EConfig) {
    this.host = host
    this.config = config
    this.evidenceFile = join(config.repoPath, M12_E2E_EVIDENCE_RELATIVE)
  }

  attachEvents(): () => void {
    return this.host.on('session/event', (session, event) => {
      if (!this.tracked.has(session.id)) return
      const list = this.events.get(session.id) ?? []
      list.push(event as SessionEvent)
      if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS)
      this.events.set(session.id, list)
    })
  }

  start(options: M12RunOptions = {}): { runId: string; state: M12RunState } {
    if (this.disposed) throw new Error('M12 E2E runner is disposed')
    const active = this.lastRunId === null ? undefined : this.runs.get(this.lastRunId)
    if (active !== undefined && active.state === 'running') throw new Error(`M12 E2E run ${active.runId} is still running`)
    this.keepFixture = options.keep === true
    this.resetRunState()
    const run = createRun(`m12-${randomUUID()}`, isoNow())
    this.runs.set(run.runId, run)
    this.lastRunId = run.runId
    void this.execute(run, options)
    return { runId: run.runId, state: run.state }
  }

  async resolve(runId: string): Promise<M12RunStatusView | undefined> {
    const run = this.runs.get(runId)
    if (run !== undefined) return runStatusView(run, this.evidenceFile)
    if (!/^m12-[0-9a-fA-F-]{8,64}$/.test(runId)) return undefined
    try {
      const parsed = JSON.parse(await readFile(this.evidenceFile, 'utf8')) as M12EvidenceDocument | undefined
      if (parsed === undefined || parsed.runId !== runId) return undefined
      return {
        runId: parsed.runId,
        state: parsed.state,
        startedAt: parsed.startedAt,
        ...(parsed.endedAt === null ? {} : { endedAt: parsed.endedAt }),
        steps: parsed.steps,
        evidenceFile: this.evidenceFile,
        ...(parsed.error === undefined ? {} : { error: parsed.error }),
      }
    } catch {
      return undefined
    }
  }

  dispose(): void {
    this.disposed = true
    this.tracked.clear()
    this.events.clear()
  }

  private resetRunState(): void {
    this.fixturePath = null
    this.masterId = null
    this.topicId = null
    this.reviewerId = null
    this.extraTopicId = null
    this.workItemId = null
    this.mainRef = ''
    this.setupHead = ''
    this.reviewedHead = ''
    this.requestId = ''
    this.requestSummary = null
    this.masterSeqAtVerdict = 0
    this.resolvedAt = null
  }

  protected readonly overrides: { baseRef?: string } = {}

  private async execute(run: MutableRun, options: M12RunOptions): Promise<void> {
    this.overrides.baseRef = options.baseRef
    try {
      for (const step of run.steps) {
        if (this.disposed) throw new Error('M12 E2E runner was disposed')
        step.status = 'running'
        step.evidence.startedAt = isoNow()
        obs(step, { before: await this.safeSnapshot() })
        try {
          await this.runStep(step, run)
          step.status = 'passed'
        } catch (error) {
          step.status = 'failed'
          step.evidence.error = messageOf(error)
          step.evidence.endedAt = isoNow()
          obs(step, { after: await this.safeSnapshot() })
          this.refreshPrompts(step)
          const failure = stepFailureState(step.id, step.evidence.error)
          run.state = failure.state
          run.error = failure.error
          break
        }
        step.evidence.endedAt = isoNow()
        obs(step, { after: await this.safeSnapshot() })
        this.refreshPrompts(step)
        await this.persist(run)
      }
      if (run.state === 'running') run.state = 'done'
    } catch (error) {
      run.state = 'failed'
      run.error = messageOf(error)
    } finally {
      run.endedAt = isoNow()
      await this.safeArchiveSessions(run)
      await this.persist(run)
      if (shouldRemoveFixture(run.state, this.keepFixture)) await this.removeFixture(run)
      this.releaseSessions()
    }
  }

  /** Run one chain step; `m12-e2e.ts` owns the dispatch and the steps. */
  protected abstract runStep(step: MutableStep, run: MutableRun): Promise<void>

  protected trackedSessionPlan(): Array<[string, string]> {
    const candidates: Array<[string, string | null]> = [
      ['master', this.masterId],
      ['topic', this.topicId],
      ['reviewer', this.reviewerId],
      ['topic-resolved-match', this.extraTopicId],
    ]
    const roles = new Map(candidates.filter((entry): entry is [string, string] => entry[1] !== null).map(([role, id]) => [id, role]))
    return [...this.tracked].map((sessionId) => [roles.get(sessionId) ?? 'session', sessionId] as [string, string])
  }

  protected async archiveOne(role: string, sessionId: string): Promise<M12ArchivedSession> {
    try {
      await this.host.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
    } catch (error) {
      return { role, sessionId, archived: false, error: messageOf(error) }
    }
    const ids = this.archivedSessionIds()
    if (ids === undefined) return { role, sessionId, archived: true, error: null }
    return ids.includes(sessionId)
      ? { role, sessionId, archived: true, error: null }
      : { role, sessionId, archived: false, error: 'not in archivedSessionIds after archive' }
  }

  protected async dropWorkspace(step: MutableStep): Promise<{ id: string | null; deleted: boolean; error: string | null }> {
    if (this.keepFixture) return { id: null, deleted: false, error: null }
    try {
      const workspace = await this.host.workspaceRegistry.resolveByPath(this.fixture())
      if (workspace === undefined) return { id: null, deleted: false, error: null }
      const deleted = await this.host.workspaceRegistry.delete(workspace.id)
      obs(step, { workspace: { id: workspace.id, path: workspace.path, deleted } })
      return { id: workspace.id, deleted, error: deleted ? null : 'workspace registry did not delete the workspace' }
    } catch (error) {
      return { id: null, deleted: false, error: messageOf(error) }
    }
  }

  protected readIndex(): Promise<ProjectIndexV2 | undefined> {
    return readProjectIndexAt(this.fixture())
  }

  protected readActivity(): Promise<{ events: ActivityEvent[]; skippedLines: number }> {
    return readActivityAt(this.fixture())
  }

  protected readInbox(): Promise<ReturnType<typeof parseInboxFile>> {
    return readInboxAt(this.fixture())
  }

  protected readRequest(): Promise<M12ReviewRequestView | null> {
    return readReviewRequestAt(this.fixture(), this.requestId)
  }

  protected async poll<T>(label: string, read: () => Promise<T | undefined>, timeoutMs = M12_E2E_STEP_TIMEOUT_MS): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.disposed) throw new Error('M12 E2E runner was disposed')
      const value = await read()
      if (value !== undefined) return value
      if (Date.now() >= deadline) throw new Error(`timeout after ${timeoutMs}ms waiting for ${label}`)
      await sleep(M12_E2E_POLL_MS)
    }
  }

  protected async waitIdle(sessionId: string, timeoutMs = M12_E2E_STEP_TIMEOUT_MS): Promise<void> {
    await this.poll(`session ${sessionId} to be idle`, async () => {
      const { items } = await this.host.sessionController.list({})
      const row = items.find((item) => item.sessionId === sessionId)
      return row !== undefined && row.running === false ? true : undefined
    }, timeoutMs)
  }

  protected async waitToolResult(sessionId: string, fromSeq: number, name: string): Promise<M12ToolCallEvidence> {
    return this.poll(`tool ${name} result on ${sessionId}`, async () => {
      const calls = toolCallsSince(this.eventsOf(sessionId), fromSeq, name)
      const call = calls.filter((entry) => entry.resultText !== null).at(-1)
      if (call === undefined) return undefined
      const payload = toolResultJson(call)
      if (call.isError === true || payload?.ok === false) {
        throw new Error(`${name} failed on ${sessionId}: ${clip(call.resultText ?? '', 1_000)}`)
      }
      return call
    })
  }

  protected async promptStep(step: MutableStep, sessionId: string, role: M12SessionRole, content: string, mode: PromptMode = 'queue'): Promise<M12PromptEvidence> {
    const fromSeq = this.lastSeqOf(sessionId)
    const evidence: M12PromptEvidence = { sessionId, role, content, mode, accepted: false, fromSeq, assistantText: '', toolCalls: [] }
    step.evidence.prompts.push(evidence)
    const result = await this.host.sessionController.prompt(
      { requestId: randomUUID(), sessionId, mode, content: [{ type: 'text', text: content }] },
      AbortSignal.timeout(this.config.promptTimeoutMs),
    )
    evidence.accepted = result.accepted
    recordCheck(step, `prompt accepted by ${role} session`, result.accepted === true, sessionId)
    return evidence
  }

  private refreshPrompts(step: MutableStep): void {
    for (const prompt of step.evidence.prompts) {
      const events = this.eventsOf(prompt.sessionId)
      prompt.assistantText = assistantTextSince(events, prompt.fromSeq)
      prompt.toolCalls = toolCallsSince(events, prompt.fromSeq)
    }
  }

  protected async observeGit(step: MutableStep, args: readonly string[], cwd: string): Promise<GitOutcome> {
    const result = await runGit(args, cwd)
    const commands = (step.evidence.observations.git as unknown[]) ?? []
    commands.push({ args: [...args], cwd, exitCode: result.code, stdout: clip(result.stdout, MAX_GIT_TEXT), stderr: clip(result.stderr, MAX_GIT_TEXT) })
    step.evidence.observations.git = commands
    return result
  }

  protected async gitOk(step: MutableStep, args: readonly string[], cwd: string, label: string): Promise<GitOutcome> {
    const result = await this.observeGit(step, args, cwd)
    if (result.code !== 0) throw new Error(`${label} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`)
    return result
  }

  protected async sameDirectory(left: string | null | undefined, right: string): Promise<boolean> {
    if (typeof left !== 'string' || left.trim() === '') return false
    try {
      return await realpath(left) === await realpath(right)
    } catch {
      return resolve(left) === resolve(right)
    }
  }

  protected archivedSessionIds(): readonly string[] | undefined {
    const ids = this.host.workspaceRegistry.archivedSessionIds
    return Array.isArray(ids) ? ids : undefined
  }

  protected fixture(): string {
    if (this.fixturePath === null) throw new Error('the M12 E2E fixture was not prepared')
    return this.fixturePath
  }

  protected master(): string {
    if (this.masterId === null) throw new Error('master session was not created')
    return this.masterId
  }

  protected topic(): string {
    if (this.topicId === null) throw new Error('the routed topic was not created')
    return this.topicId
  }

  protected reviewer(): string {
    if (this.reviewerId === null) throw new Error('the reviewer session was not created')
    return this.reviewerId
  }

  protected async workItem(): Promise<WorkItemRecordV2> {
    const item = workItemOfTopic(await this.readIndex(), this.topic())
    if (item === undefined) throw new Error('the topic work item is not in the index')
    return item
  }

  protected track(sessionId: string): void {
    this.tracked.add(sessionId)
    if (!this.events.has(sessionId)) this.events.set(sessionId, [])
  }

  protected releaseSessions(): void {
    for (const sessionId of this.tracked) this.events.delete(sessionId)
    this.tracked.clear()
  }

  protected eventsOf(sessionId: string): readonly SessionEvent[] {
    return this.events.get(sessionId) ?? []
  }

  protected lastSeqOf(sessionId: string): number {
    return lastSeq(this.eventsOf(sessionId))
  }

  private async safeSnapshot(): Promise<Record<string, unknown>> {
    try {
      if (this.fixturePath === null) return { fixtureExists: false }
      const index = await this.readIndex()
      return {
        fixtureExists: existsSync(this.fixturePath),
        masterSessionId: index?.masterSessionId ?? null,
        topics: (index?.topics ?? []).map((entry) => ({ topicId: entry.topicId, status: entry.status, reviewStatus: entry.reviewStatus, resolvedAt: entry.resolvedAt })),
        workItems: (index?.workItems ?? []).map((entry) => ({ workItemId: entry.workItemId, status: entry.status, headCommit: entry.headCommit })),
      }
    } catch (error) {
      return { error: messageOf(error) }
    }
  }

  private async safeArchiveSessions(run: MutableRun): Promise<void> {
    const cleanup = run.cleanup as M12CleanupReport | Record<string, unknown>
    if (Array.isArray((cleanup as M12CleanupReport).sessions) && (cleanup as M12CleanupReport).sessions.length > 0) return
    const archived: M12ArchivedSession[] = []
    for (const [role, sessionId] of this.trackedSessionPlan()) archived.push(await this.archiveOne(role, sessionId))
    if (archived.length === 0) return
    run.cleanup = {
      ...run.cleanup,
      autoArchived: archived,
      archivedSessionIds: archived.filter((entry) => entry.archived).map((entry) => entry.sessionId),
      autoArchiveErrors: archived.filter((entry) => !entry.archived).map((entry) => `${entry.sessionId}: ${entry.error ?? 'unknown error'}`),
    }
  }

  private async removeFixture(run: MutableRun): Promise<void> {
    const errors: string[] = []
    let removed = false
    if (this.fixturePath !== null) {
      try {
        await rm(this.fixturePath, { recursive: true, force: true })
        removed = !existsSync(this.fixturePath)
      } catch (error) {
        errors.push(`delete fixture: ${messageOf(error)}`)
      }
    }
    const cleanup = run.cleanup as M12CleanupReport | Record<string, unknown>
    const previous = Array.isArray(cleanup.errors) ? cleanup.errors as unknown[] : []
    run.cleanup = { ...run.cleanup, errors: [...previous, ...errors], fixturePath: this.fixturePath, keepFixture: this.keepFixture, fixtureRemoved: removed }
    await this.persist(run)
  }

  private async persist(run: MutableRun): Promise<void> {
    const document = buildEvidenceDocument(
      { plugin: this.config.pluginName, pluginVersion: this.config.pluginVersion, repoPath: this.config.repoPath },
      run,
      this.evidenceFile,
      { path: this.fixturePath, keep: this.keepFixture },
    )
    await persistEvidenceDocument(document, this.evidenceFile, this.config.log)
  }
}
