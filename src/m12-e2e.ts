/** M12 real-host end-to-end driver: the 0.2.0 topic-session chain. */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  HANDOFFS_DIR_RELATIVE,
  INDEX_FILE_RELATIVE,
  M12_E2E_EVIDENCE_RELATIVE,
  M12_E2E_FIXTURE_PREFIX,
  M12_E2E_POLL_MS,
  M12_E2E_STEP_TIMEOUT_MS,
  M12_E2E_TOPIC_INTENT,
  M12_E2E_WORK_CONTENT,
  M12_E2E_WORK_FILE,
  MASTER_PRESET_ID,
  MAX_EVENTS,
  MAX_GIT_TEXT,
  REVIEWS_DIR_RELATIVE,
  REVIEW_REQUEST_TOOL,
  REVIEW_VERDICT_TOOL,
  ROUTE_TOOL,
  WORK_ITEM_TOOL,
  asRecord,
  artifactIdentityFrom,
  assertActivityAudit,
  assertMergeDecision,
  assertMergedFacts,
  assertNoUndoAfterWindow,
  assertReopenFacts,
  assertRequestFacts,
  assertSidebarVisibility,
  assertVerdictFacts,
  assistantTextSince,
  buildCleanupReport,
  buildCommitPrompt,
  buildEvidenceDocument,
  buildHandoffPrompt,
  buildMergePrompt,
  buildProjectInitPrompt,
  buildResolvedRoutePrompt,
  buildReviewRequestPrompt,
  buildReviewerVerdictPrompt,
  buildRoutePrompt,
  buildWorkItemPrompt,
  clip,
  createRun,
  deliveryEventSince,
  eventsSince,
  fixturePathProblem,
  isoNow,
  isLiveTopicStatus,
  isStrictlyInside,
  lastSeq,
  messageOf,
  obs,
  parseInboxFile,
  persistEvidenceDocument,
  planMergePrompt,
  planRequestReview,
  planReviewVerdict,
  projectPath,
  readActivityAt,
  readHandoffFiles,
  readInboxAt,
  readProjectIndexAt,
  readReviewRequestAt,
  readReviewRequests,
  readTextIfPresent,
  recordCheck,
  sessionEventSummary,
  runGit,
  runStatusView,
  shortThresholdsProblem,
  shouldRemoveFixture,
  sleep,
  stableJson,
  stepFailureState,
  stringOrNull,
  toolCallsSince,
  toolResultJson,
  topicOf,
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
  M12OverviewTopic,
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

export { M12_E2E_RUN_PATH, M12_E2E_STATUS_PATH } from './m12-e2e-support.js'
export type { M12E2EHost, M12PanelProbe } from './m12-e2e-support.js'

/** Options one run may carry (the dev route reads them from the query string). */
export interface M12RunOptions {
  readonly keep?: boolean
  /** Base ref for the artifact diff (e.g. the M12 base commit). */
  readonly baseRef?: string
}

export class M12E2ERunner {
  private readonly host: M12E2EHost
  private readonly config: M12E2EConfig
  private readonly runs = new Map<string, MutableRun>()
  private readonly events = new Map<string, SessionEvent[]>()
  private readonly tracked = new Set<string>()
  private readonly evidenceFile: string
  private lastRunId: string | null = null
  private disposed = false
  private fixturePath: string | null = null
  private keepFixture = false
  private masterId: string | null = null
  private topicId: string | null = null
  private reviewerId: string | null = null
  private extraTopicId: string | null = null
  private workItemId: string | null = null
  private mainRef = ''
  private setupHead = ''
  private reviewedHead = ''
  private requestId = ''
  private requestSummary: string | null = null
  private masterSeqAtVerdict = 0
  private resolvedAt: string | null = null

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

  private readonly overrides: { baseRef?: string } = {}

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

  private async runStep(step: MutableStep, run: MutableRun): Promise<void> {
    switch (step.id) {
      case 'setup': return this.stepSetup(step, run)
      case 'route-topic': return this.stepRouteTopic(step)
      case 'session-list': return this.stepSessionList(step)
      case 'overview': return this.stepOverview(step)
      case 'work-item': return this.stepWorkItem(step)
      case 'work-item-commit': return this.stepWorkItemCommit(step)
      case 'review-request': return this.stepReviewRequest(step)
      case 'review-verdict': return this.stepReviewVerdict(step)
      case 'master-merge-decision': return this.stepMasterMergeDecision(step)
      case 'handoff-done': return this.stepHandoffDone(step)
      case 'merge': return this.stepMerge(step)
      case 'archive': return this.stepArchive(step)
      case 'no-undo': return this.stepNoUndo(step)
      case 'resolved-no-receive': return this.stepResolvedNoReceive(step)
      case 'reopen': return this.stepReopen(step)
      case 'activity': return this.stepActivity(step)
      case 'cleanup': return this.stepCleanup(step, run)
      default: throw new Error(`unknown M12 E2E step: ${step.id}`)
    }
  }

  private async stepSetup(step: MutableStep, run: MutableRun): Promise<void> {
    const fixture = await this.prepareFixture()
    this.fixturePath = fixture
    obs(step, { fixture, keepFixture: this.keepFixture })
    await this.gitOk(step, ['init', '-b', 'main'], fixture, 'git init')
    await this.gitOk(step, ['config', 'user.email', 'e2e@dsh-cowork.invalid'], fixture, 'git config email')
    await this.gitOk(step, ['config', 'user.name', 'dsh-cowork e2e'], fixture, 'git config name')
    await writeFile(join(fixture, 'README.md'), '# M12 E2E fixture\n', 'utf8')
    await writeFile(join(fixture, '.gitignore'), '.dsh-cowork/\n', 'utf8')
    await this.gitOk(step, ['add', 'README.md', '.gitignore'], fixture, 'git add')
    await this.gitOk(step, ['commit', '-m', 'init'], fixture, 'git commit')
    this.mainRef = (await this.gitOk(step, ['rev-parse', 'refs/heads/main'], fixture, 'git rev-parse main')).stdout.trim()
    this.setupHead = (await this.gitOk(step, ['rev-parse', 'HEAD'], fixture, 'git rev-parse HEAD')).stdout.trim()
    // The merge tool refuses main/master; the main ref is the invariant below.
    await this.gitOk(step, ['checkout', '-b', 'e2e-work'], fixture, 'git checkout e2e-work')
    recordCheck(step, 'the fixture starts on a non-protected integration branch', this.setupHead === this.mainRef, `${this.mainRef} == ${this.setupHead}`)

    const thresholdProblem = shortThresholdsProblem(this.config.idleAfterMs, this.config.resolveAfterMs)
    obs(step, { lifecycleThresholds: { idleAfterMs: this.config.idleAfterMs, resolveAfterMs: this.config.resolveAfterMs } })
    recordCheck(step, 'the plugin runs with the short M12 lifecycle thresholds', thresholdProblem === null, thresholdProblem ?? 'idleAfterMs=500 resolveAfterMs=1000')

    run.artifactIdentity = await this.collectArtifactIdentity()
    obs(step, { artifactIdentity: run.artifactIdentity })

    const created = await this.host.sessionController.create({ cwd: fixture, agentPreset: MASTER_PRESET_ID })
    this.masterId = created.sessionId
    this.track(created.sessionId)
    obs(step, { masterSessionId: created.sessionId })
    recordCheck(step, 'master session mounted cowork-master', created.agentPreset === MASTER_PRESET_ID, `agentPreset=${String(created.agentPreset)}`)
    await this.waitIdle(created.sessionId)
    await this.promptStep(step, created.sessionId, 'master', buildProjectInitPrompt())
    const index = await this.poll('project index initialized by the master', async () => {
      const current = await this.readIndex()
      return current !== undefined && current.masterSessionId === created.sessionId ? current : undefined
    })
    obs(step, { indexFile: projectPath(fixture, INDEX_FILE_RELATIVE), indexMasterSessionId: index.masterSessionId })
    recordCheck(step, 'index names the created master', index.masterSessionId === created.sessionId, `${index.masterSessionId} == ${created.sessionId}`)
    await this.waitIdle(created.sessionId)
  }

  private async prepareFixture(): Promise<string> {
    const configured = this.config.fixturePath
    let raw: string
    if (configured === undefined || configured.trim() === '') {
      raw = await mkdtemp(join(tmpdir(), M12_E2E_FIXTURE_PREFIX))
    } else {
      raw = resolve(configured)
      await mkdir(raw, { recursive: true, mode: 0o700 })
      const entries = await readdir(raw)
      if (entries.length > 0) {
        throw new Error(`M12 E2E fixturePath ${raw} is not empty; pass a fresh path or omit it to get a temp directory`)
      }
    }
    const canonical = await realpath(raw)
    const problem = fixturePathProblem(this.config.repoPath, canonical)
    if (problem !== null) throw new Error(problem)
    return canonical
  }

  private async collectArtifactIdentity(): Promise<ReturnType<typeof artifactIdentityFrom>> {
    const repoPath = this.config.repoPath
    const configured = (this.overrides.baseRef ?? this.config.artifactBaseRef ?? '').trim()
    const baseRef = configured === '' ? 'HEAD' : configured
    const head = await runGit(['rev-parse', 'HEAD'], repoPath)
    const base = await runGit(['rev-parse', '--verify', `${baseRef}^{commit}`], repoPath)
    const diff = await runGit(['diff', `${baseRef}..HEAD`], repoPath)
    const status = await runGit(['status', '--porcelain'], repoPath)
    return artifactIdentityFrom({
      repoPath,
      baseRef,
      pluginVersion: this.config.pluginVersion,
      facts: { head, base, diff, status },
    })
  }

  private async stepRouteTopic(step: MutableStep): Promise<void> {
    const master = this.master()
    await this.waitIdle(master)
    const before = (await this.readIndex())?.topics.map((topic) => topic.topicId) ?? []
    const prompt = await this.promptStep(step, master, 'master', buildRoutePrompt())
    const call = await this.waitToolResult(master, prompt.fromSeq, ROUTE_TOOL)
    const payload = toolResultJson(call)
    obs(step, { routeToolResult: clip(call.resultText ?? '', 2_000) })
    recordCheck(step, 'cowork_route returned ok', payload?.ok === true, clip(call.resultText ?? '', 1_000))
    const topic = await this.poll('the routed topic in the index', async () => {
      const index = await this.readIndex()
      return index?.topics.find((entry) => !before.includes(entry.topicId))
    })
    this.topicId = topic.topicId
    this.track(topic.topicId)
    obs(step, { topicId: topic.topicId, title: topic.title, status: topic.status, cwd: topic.cwd })
    recordCheck(step, 'the route created exactly one new topic', (await this.readIndex())?.topics.length === before.length + 1, before.length)
    recordCheck(step, 'the tool result names the created topic', payload?.topicId === topic.topicId, `${String(payload?.topicId)} == ${topic.topicId}`)
    recordCheck(step, 'the topic starts live (active or idle)', isLiveTopicStatus(topic.status), topic.status)
    recordCheck(step, 'the topic is not blocked or awaiting review', topic.blocked === false && topic.awaitingReview === false, `blocked=${String(topic.blocked)} awaitingReview=${String(topic.awaitingReview)}`)
    recordCheck(step, 'the index records the topic as the last route target', (await this.readIndex())?.lastRouteTopicId === topic.topicId, String((await this.readIndex())?.lastRouteTopicId))
    recordCheck(step, 'the topic id is a real session id (not the master)', topic.topicId !== master, topic.topicId)
    await this.waitIdle(topic.topicId)
  }

  private async stepSessionList(step: MutableStep): Promise<void> {
    const topic = this.topic()
    await this.waitIdle(topic)
    const { items } = await this.host.sessionController.list({})
    const row = items.find((item) => item.sessionId === topic)
    const { meta } = await this.host.sessionController.inspect(topic)
    assertSidebarVisibility(step, topic, {
      rowExists: row !== undefined,
      cwdMatches: await this.sameDirectory(row?.cwd, this.fixture()),
      cwd: row?.cwd ?? null,
      running: row?.running,
      topicPreset: meta.agentPreset ?? null,
      archived: this.archivedSessionIds(),
    })
  }

  private async stepOverview(step: MutableStep): Promise<void> {
    const topic = this.topic()
    const result = await this.config.panel.overview({ sessionId: this.master() })
    const body = asRecord(result.body)
    obs(step, { status: result.status, overview: clip(stableJson(result.body), 4_000) })
    recordCheck(step, 'GET /api/cowork.overview returns 200', result.status === 200, String(result.status))
    recordCheck(step, 'the overview body is ok', body?.ok === true, clip(stableJson(result.body), 1_000))
    const project = asRecord(body?.project)
    recordCheck(step, 'the overview names the master session', project?.masterSessionId === this.master(), String(project?.masterSessionId))
    recordCheck(step, 'the overview resolves the throwaway project', await this.sameDirectory(stringOrNull(project?.repoPath), this.fixture()), String(project?.repoPath))
    const topics = this.topicsFromBody(step, body)
    recordCheck(step, 'the overview lists the routed topic', topics.length === 1 && topics[0]?.topicId === topic, topics.map((entry) => entry.topicId).join(','))
    const listed = topics.find((entry) => entry.topicId === topic)
    recordCheck(step, 'the topic session id is the panel topic id', listed?.topicId === topic, String(listed?.topicId))
    recordCheck(step, 'the overview topic is live', isLiveTopicStatus(listed?.status), String(listed?.status))
    recordCheck(step, 'the overview topic has no review yet', listed?.reviewStatus === null && listed?.awaitingReview === false, `reviewStatus=${String(listed?.reviewStatus)} awaitingReview=${String(listed?.awaitingReview)}`)
    const counts = asRecord(body?.counts)
    recordCheck(step, 'the overview lists no resolved topic yet', counts?.resolved === 0, String(counts?.resolved))
  }

  private async overviewTopics(step: MutableStep): Promise<M12OverviewTopic[]> {
    const result = await this.config.panel.overview({ sessionId: this.master() })
    return this.topicsFromBody(step, asRecord(result.body))
  }

  private topicsFromBody(step: MutableStep, body: Record<string, unknown> | undefined): M12OverviewTopic[] {
    const topics = body?.topics
    if (!Array.isArray(topics)) return []
    const rows: M12OverviewTopic[] = []
    for (const entry of topics) {
      const topic = asRecord(entry)
      if (topic === undefined || typeof topic.topicId !== 'string') continue
      rows.push({
        topicId: topic.topicId,
        status: String(topic.status ?? ''),
        awaitingReview: topic.awaitingReview === true,
        reviewStatus: stringOrNull(topic.reviewStatus),
        resolvedAt: stringOrNull(topic.resolvedAt),
        resolvedBy: stringOrNull(topic.resolvedBy),
      })
    }
    obs(step, { overviewTopics: rows })
    return rows
  }

  private async stepWorkItem(step: MutableStep): Promise<void> {
    const topic = this.topic()
    await this.waitIdle(topic)
    const prompt = await this.promptStep(step, topic, 'topic', buildWorkItemPrompt())
    const call = await this.waitToolResult(topic, prompt.fromSeq, WORK_ITEM_TOOL)
    const payload = toolResultJson(call)
    obs(step, { workItemToolResult: clip(call.resultText ?? '', 2_000) })
    recordCheck(step, 'cowork_work_item_create returned ok', payload?.ok === true, clip(call.resultText ?? '', 1_000))
    const item = await this.poll('the topic work item in the index', async () => workItemOfTopic(await this.readIndex(), topic))
    this.workItemId = item.workItemId
    obs(step, { workItem: { workItemId: item.workItemId, path: item.path, branch: item.branch, baseCommit: item.baseCommit } })
    recordCheck(step, 'the tool result names the created work item', payload?.workItemId === item.workItemId, `${String(payload?.workItemId)} == ${item.workItemId}`)
    recordCheck(step, 'the clone lives under the project workitems directory', isStrictlyInside(projectPath(this.fixture(), '.dsh-cowork/workitems'), item.path), item.path)
    recordCheck(step, 'the clone directory exists', existsSync(item.path), item.path)
    recordCheck(step, 'the work item branch is cowork/<id>', item.branch === `cowork/${item.workItemId}`, item.branch)
    recordCheck(step, 'the clone started from the fixture HEAD and is active', item.baseCommit === this.mainRef && item.status === 'active', `${String(item.baseCommit)} ${item.status}`)
    const branch = await this.observeGit(step, ['branch', '--show-current'], item.path)
    recordCheck(step, 'the clone is on its own branch', branch.code === 0 && branch.stdout.trim() === item.branch, `exit=${branch.code} ${branch.stdout.trim()}`)
    const status = await this.observeGit(step, ['status', '--porcelain'], item.path)
    recordCheck(step, 'the fresh clone is clean', status.code === 0 && status.stdout.trim() === '', status.stdout)
    await this.waitIdle(topic)
  }

  private async stepWorkItemCommit(step: MutableStep): Promise<void> {
    const topic = this.topic()
    const item = await this.workItem()
    await this.waitIdle(topic)
    const before = (await this.gitOk(step, ['rev-parse', 'HEAD'], item.path, 'git rev-parse clone HEAD')).stdout.trim()
    await this.promptStep(step, topic, 'topic', buildCommitPrompt({
      checkoutPath: item.path,
      fileName: M12_E2E_WORK_FILE,
      content: M12_E2E_WORK_CONTENT,
      message: 'feat: add the M12 E2E work item commit',
    }))
    const observed = await this.poll('the committed work item file in the clone', async () => {
      const text = await readTextIfPresent(join(item.path, M12_E2E_WORK_FILE))
      if (text === undefined || text.trim() !== M12_E2E_WORK_CONTENT) return undefined
      const status = await runGit(['status', '--porcelain'], item.path)
      if (status.code !== 0 || status.stdout.trim() !== '') return undefined
      const head = await runGit(['rev-parse', 'HEAD'], item.path)
      if (head.code !== 0 || head.stdout.trim() === before) return undefined
      const log = await runGit(['log', '-1', '--format=%s'], item.path)
      return log.code === 0 && log.stdout.trim() === 'feat: add the M12 E2E work item commit' ? { text, head: head.stdout.trim() } : undefined
    })
    this.reviewedHead = observed.head
    obs(step, { checkoutPath: item.path, headBefore: before, headAfter: observed.head })
    recordCheck(step, 'the commit advanced the clone head', observed.head !== before, `${before} -> ${observed.head}`)
    const index = await this.readIndex()
    const row = workItemOfTopic(index, this.topic())
    recordCheck(step, 'the work item is still active in the index', row?.status === 'active', String(row?.status))
    await this.waitIdle(topic)
  }

  private async stepReviewRequest(step: MutableStep): Promise<void> {
    const topic = this.topic()
    const item = await this.workItem()
    await this.waitIdle(topic)
    // The master may receive the merge decision while the reviewer is being
    // created; record the delivery window before the topic asks for the review.
    this.masterSeqAtVerdict = this.lastSeqOf(this.master())
    const head = (await this.gitOk(step, ['rev-parse', 'HEAD'], item.path, 'git rev-parse reviewed head')).stdout.trim()
    this.reviewedHead = head
    const reviewsDir = projectPath(this.fixture(), REVIEWS_DIR_RELATIVE)
    const existing = await readReviewRequests(reviewsDir)
    const plan = planRequestReview(existing, item.workItemId)
    obs(step, { requestPlan: plan })
    if (plan.action === 'fail') throw new Error(plan.reason)
    let payload: Record<string, unknown> | undefined
    if (plan.action === 'adopt') {
      const adopted = existing.find((request) => request.workItemId === item.workItemId && request.status === 'pending')
      step.evidence.note = plan.reason
      if (adopted !== undefined) {
        this.requestId = adopted.requestId
        this.reviewerId = adopted.reviewerSessionId
      }
    } else {
      const prompt = await this.promptStep(step, topic, 'topic', buildReviewRequestPrompt({
        workItemId: item.workItemId,
        checkoutPath: item.path,
        baseCommit: item.baseCommit ?? '',
        headCommit: head,
        fileName: M12_E2E_WORK_FILE,
        purpose: 'Confirm the isolated work item adds m12-e2e.txt and that the recorded verification passes.',
      }))
      const call = await this.waitToolResult(topic, prompt.fromSeq, REVIEW_REQUEST_TOOL)
      payload = toolResultJson(call)
      obs(step, { reviewRequestToolResult: clip(call.resultText ?? '', 3_000) })
      recordCheck(step, 'cowork_review_request returned ok', payload?.ok === true, clip(call.resultText ?? '', 1_000))
      recordCheck(step, 'the review request was created pending', payload?.status === 'pending', String(payload?.status))
      const requestId = stringOrNull(payload?.requestId)
      const reviewerId = stringOrNull(payload?.reviewerSessionId)
      recordCheck(step, 'the request id is file-name safe', requestId !== null && /^[A-Za-z0-9._-]{1,128}$/.test(requestId), String(requestId))
      recordCheck(step, 'a fresh reviewer session was created', reviewerId !== null && reviewerId !== topic && reviewerId !== this.master(), String(reviewerId))
      this.requestId = requestId ?? ''
      this.reviewerId = reviewerId
      const filePath = stringOrNull(payload?.filePath)
      recordCheck(step, 'the request file lives under the reviews directory', filePath !== null && isStrictlyInside(reviewsDir, filePath), String(filePath))
    }
    if (this.requestId === '' || this.reviewerId === null) throw new Error('the review request did not name a requestId and reviewerSessionId')
    const request = await this.poll('the review request file', async () => {
      const requests = await readReviewRequests(reviewsDir)
      return requests.find((entry) => entry.requestId === this.requestId)
    })
    const { meta } = await this.host.sessionController.inspect(this.reviewerId)
    assertRequestFacts(step, {
      request,
      reviewerSessionId: this.reviewerId,
      topicId: topic,
      workItemId: item.workItemId,
      headCommit: this.reviewedHead,
      checkoutPath: item.path,
      branch: item.branch,
      filePath: request.filePath,
      fileExists: true,
      reviewerPreset: meta.agentPreset ?? null,
    })
    await this.waitIdle(topic)
  }

  private async stepReviewVerdict(step: MutableStep): Promise<void> {
    const topic = this.topic()
    const reviewer = this.reviewer()
    const item = await this.workItem()
    const request = await this.readRequest()
    const plan = planReviewVerdict(request, 'pass')
    obs(step, { verdictPlan: plan })
    if (plan.action === 'fail') {
      const events = sessionEventSummary(this.eventsOf(reviewer))
      throw new Error(`cannot deliver pass: ${plan.reason}; reviewerSessionId=${reviewer}; events=${events}`)
    }
    if (plan.action === 'steer') {
      const instruction = buildReviewerVerdictPrompt({
        requestId: this.requestId,
        workItemId: item.workItemId,
        checkoutPath: item.path,
        branch: item.branch,
        fileName: M12_E2E_WORK_FILE,
      })
      const steer = await this.promptStep(step, reviewer, 'reviewer', instruction, 'steer')
      obs(step, { steer: { mode: steer.mode, fromSeq: steer.fromSeq } })
    } else {
      step.evidence.note = plan.reason
    }
    const answered = await this.poll('the pass verdict on the review request file', async () => {
      const current = await this.readRequest()
      if (current === null) return undefined
      if (current.status === 'pass' && current.reviewedAt !== null) return current
      if (planReviewVerdict(current, 'pass').action === 'fail') {
        throw new Error(`unexpected verdict ${current.status} while waiting for pass; events=${sessionEventSummary(this.eventsOf(reviewer))}`)
      }
      return undefined
    })
    this.requestSummary = answered.summary
    const index = await this.poll('the pass in the index and the reviewing work item', async () => {
      const current = await this.readIndex()
      const topicRow = topicOf(current, topic)
      const workItem = workItemOfTopic(current, topic)
      return topicRow?.reviewStatus === 'pass' && topicRow.awaitingReview === false && workItem?.status === 'reviewing' ? { topicRow, workItem } : undefined
    })
    const inbox = await this.poll('the merge-needed inbox item delivered to the master', async () => {
      const items = await this.readInbox()
      return items.find((entry) => entry.topicId === topic && entry.kind === 'merge-needed' && entry.deliveredAt !== null)
    })
    const archived = await this.poll('the reviewer session archived after the verdict', async () => {
      const ids = this.archivedSessionIds()
      return ids === undefined || ids.includes(reviewer) ? true : undefined
    })
    assertVerdictFacts(step, {
      request: answered,
      reviewerSessionId: reviewer,
      topicReviewStatus: index.topicRow.reviewStatus,
      topicAwaitingReview: index.topicRow.awaitingReview,
      indexReviewerSessionId: index.topicRow.reviewerSessionId,
      workItemStatus: index.workItem.status,
      inboxItem: inbox,
      reviewerArchived: archived,
    })
  }

  private async stepMasterMergeDecision(step: MutableStep): Promise<void> {
    const topic = this.topic()
    const item = await this.workItem()
    const inbox = await this.readInbox()
    const delivered = inbox.filter((entry) => entry.deliveredAt !== null)
    const delivery = await this.poll('the merge decision delivered to the master session', async () =>
      deliveryEventSince(this.eventsOf(this.master()), this.masterSeqAtVerdict, 'merge-needed'))
    const after = eventsSince(this.eventsOf(this.master()), this.masterSeqAtVerdict)
    const summary = this.requestSummary
    const leaked = summary === null || summary.length < 20 ? [] : after.filter((event) => stableJson(event.data).includes(summary))
    const toolLeak = after.filter((event) => [REVIEW_VERDICT_TOOL, REVIEW_REQUEST_TOOL].some((tool) => stableJson(event.data).includes(tool)))
    assertMergeDecision(step, {
      inbox,
      delivered,
      topicId: topic,
      workItemId: item.workItemId,
      deliveryText: delivery?.text ?? null,
      leakedSummaryEvents: leaked.length,
      leakedProcessEvents: toolLeak.length,
      requestSummary: summary,
    })
  }

  private async stepHandoffDone(step: MutableStep): Promise<void> {
    const topic = this.topic()
    await this.waitIdle(topic)
    const startedAt = isoNow()
    await this.promptStep(step, topic, 'topic', buildHandoffPrompt({ fileName: M12_E2E_WORK_FILE }))
    const row = await this.poll('the handoff(done) digest in the index', async () => {
      const current = topicOf(await this.readIndex(), topic)
      return current !== undefined && current.digest.trim() !== '' && current.lastDeliveryConfirmedAt !== null && current.blocked === false && isLiveTopicStatus(current.status)
        ? current
        : undefined
    })
    obs(step, { digest: clip(row.digest, 300), lastDeliveryConfirmedAt: row.lastDeliveryConfirmedAt, status: row.status })
    recordCheck(step, 'the handoff records a digest and confirms the delivery', row.digest.includes('M12 E2E topic') && row.lastDeliveryConfirmedAt !== null, clip(row.digest, 200))
    const handoff = await this.poll('the handoff audit file', async () => {
      const files = await readHandoffFiles(projectPath(this.fixture(), HANDOFFS_DIR_RELATIVE))
      return files.find((entry) => entry.topicId === topic && entry.status === 'done' && entry.createdAt >= startedAt)
    })
    recordCheck(step, 'the handoff file exists and says done', existsSync(handoff.filePath) && handoff.status === 'done', handoff.filePath)
    await this.waitIdle(topic)
  }

  private async stepMerge(step: MutableStep): Promise<void> {
    const master = this.master()
    const item = await this.workItem()
    const plan = planMergePrompt(await this.mergeAlreadyDone())
    obs(step, { mergePlan: plan })
    if (plan.action === 'skip') {
      step.evidence.note = plan.reason
    } else {
      const steer = await this.promptStep(step, master, 'master', buildMergePrompt(item.workItemId), 'steer')
      obs(step, { steer: { mode: steer.mode, fromSeq: steer.fromSeq } })
    }
    const merged = await this.poll('the merged work item and its teardown', async () => {
      if (!(await this.mergeAlreadyDone())) return undefined
      const index = await this.readIndex()
      return workItemOfTopic(index, this.topic())
    })
    const content = await readTextIfPresent(join(this.fixture(), M12_E2E_WORK_FILE))
    const branch = await this.observeGit(step, ['rev-parse', '--verify', `refs/heads/${item.branch}`], this.fixture())
    const headAfter = (await this.gitOk(step, ['rev-parse', 'HEAD'], this.fixture(), 'git rev-parse HEAD after merge')).stdout.trim()
    const mainAfter = (await this.gitOk(step, ['rev-parse', 'refs/heads/main'], this.fixture(), 'git rev-parse main after merge')).stdout.trim()
    const parents = await this.observeGit(step, ['rev-list', '--parents', '-n', '1', 'HEAD'], this.fixture())
    const ancestor = await this.observeGit(step, ['merge-base', '--is-ancestor', this.reviewedHead, 'HEAD'], this.fixture())
    assertMergedFacts(step, {
      fileName: M12_E2E_WORK_FILE,
      filePath: join(this.fixture(), M12_E2E_WORK_FILE),
      fileText: content,
      clonePath: item.path,
      cloneExists: existsSync(item.path),
      branchExit: branch.code,
      workItemStatus: merged.status,
      workItemHead: merged.headCommit,
      reviewedHead: this.reviewedHead,
      mainRefBefore: this.mainRef,
      mainRefAfter: mainAfter,
      headBefore: this.setupHead,
      headAfter,
      parentsStdout: parents.stdout,
      parentsExit: parents.code,
      ancestorExit: ancestor.code,
    })
  }

  private async mergeAlreadyDone(): Promise<boolean> {
    const topic = this.topicId
    if (topic === null) return false
    const index = await this.readIndex()
    const item = workItemOfTopic(index, topic)
    if (item === undefined || item.status !== 'merged') return false
    if (item.headCommit !== this.reviewedHead) return false
    if (existsSync(item.path)) return false
    const text = await readTextIfPresent(join(this.fixture(), M12_E2E_WORK_FILE))
    return text?.trim() === M12_E2E_WORK_CONTENT
  }

  /** Archive through the topic-page menu (the shipped resolve route). */
  private async stepArchive(step: MutableStep): Promise<void> {
    const topic = this.topic()
    step.evidence.note = 'manual archive through POST /api/cowork.topic.resolve'
    const result = await this.config.panel.resolve({ sessionId: this.master(), topicId: topic })
    obs(step, { status: result.status, archiveBody: clip(stableJson(result.body), 2_000) })
    const body = asRecord(result.body)
    const panelTopic = asRecord(body?.topic)
    recordCheck(step, 'POST /api/cowork.topic.resolve returns 200', result.status === 200, String(result.status))
    recordCheck(step, 'the archive body is ok', body?.ok === true, clip(stableJson(result.body), 1_000))
    recordCheck(step, 'the topic is archived', panelTopic?.status === 'resolved', String(panelTopic?.status))
    recordCheck(step, 'the archive is attributed to the user', panelTopic?.resolvedBy === 'user', String(panelTopic?.resolvedBy))
    const resolvedAt = typeof panelTopic?.resolvedAt === 'string' ? panelTopic.resolvedAt : null
    this.resolvedAt = resolvedAt
    const indexRow = topicOf(await this.readIndex(), topic)
    recordCheck(step, 'the index records the resolution', indexRow?.status === 'resolved' && indexRow.resolvedAt === resolvedAt, `${String(indexRow?.status)} ${String(indexRow?.resolvedAt)}`)
    const activity = await this.readActivity()
    recordCheck(step, 'the archive is recorded in activity.jsonl', activity.events.some((event) => event.type === 'topic-archived' && event.topicId === topic), 'topic-archived')
  }

  private async stepNoUndo(step: MutableStep): Promise<void> {
    await assertNoUndoAfterWindow(step, {
      resolveAfterMs: this.config.resolveAfterMs,
      resolvedAt: this.resolvedAt,
      topicId: this.topic(),
      readTopics: () => this.overviewTopics(step),
      readIndex: () => this.readIndex(),
      readActivity: () => this.readActivity(),
    })
  }

  private async stepResolvedNoReceive(step: MutableStep): Promise<void> {
    const topic = this.topic()
    const master = this.master()
    const before = new Set((await this.readIndex())?.topics.map((entry) => entry.topicId) ?? [])
    const topicSeq = this.lastSeqOf(topic)
    const prompt = await this.promptStep(step, master, 'master', buildResolvedRoutePrompt(topic))
    const call = await this.waitToolResult(master, prompt.fromSeq, ROUTE_TOOL)
    const payload = toolResultJson(call)
    obs(step, { resolvedRouteToolResult: clip(call.resultText ?? '', 2_000) })
    recordCheck(step, 'the route reports resolved_match', payload?.ok === true && payload?.action === 'resolved_match', clip(call.resultText ?? '', 1_000))
    const resolvedMatch = asRecord(payload?.resolvedMatch)
    recordCheck(step, 'the resolved match names the old topic', resolvedMatch?.topicId === topic, String(resolvedMatch?.topicId))
    const created = await this.poll('the replacement topic', async () => {
      const index = await this.readIndex()
      const fresh = index?.topics.find((entry) => !before.has(entry.topicId))
      return fresh === undefined ? undefined : fresh
    })
    this.extraTopicId = created.topicId
    this.track(created.topicId)
    obs(step, { oldTopicId: topic, newTopicId: created.topicId, newTopicStatus: created.status })
    recordCheck(step, 'a new topic was created instead of the resolved one', created.topicId !== topic, created.topicId)
    recordCheck(step, 'the tool result names the new topic', payload?.topicId === created.topicId, `${String(payload?.topicId)} == ${created.topicId}`)
    recordCheck(step, 'the new topic is live', isLiveTopicStatus(created.status), created.status)
    recordCheck(step, 'the old topic stays resolved', topicOf(await this.readIndex(), topic)?.status === 'resolved', String(topicOf(await this.readIndex(), topic)?.status))
    const received = deliveryEventSince(this.eventsOf(topic), topicSeq, M12_E2E_TOPIC_INTENT)
    recordCheck(step, 'the resolved topic received no intent', received === undefined, 'no delivery event after the resolved route')
    await this.waitIdle(created.topicId)
  }

  private async stepReopen(step: MutableStep): Promise<void> {
    const topic = this.topic()
    // M11 exposes a manual reopen only as this user write route (no tool).
    step.evidence.note = 'manual reopen through POST /api/cowork.topic.reopen'
    const result = await this.config.panel.reopen({ sessionId: this.master(), topicId: topic })
    assertReopenFacts(step, {
      status: result.status,
      body: result.body,
      indexRow: topicOf(await this.readIndex(), topic),
      activity: await this.readActivity(),
      replacedResolvedAt: this.resolvedAt,
      topicId: topic,
    })
  }

  private async stepActivity(step: MutableStep): Promise<void> {
    await assertActivityAudit(step, {
      fixturePath: this.fixture(),
      topicId: this.topic(),
      requestId: this.requestId,
      workItemId: this.workItemId,
    })
  }

  private async stepCleanup(step: MutableStep, run: MutableRun): Promise<void> {
    const index = await this.readIndex()
    run.finalIndex = index ?? null
    if (index !== undefined) obs(step, { finalIndex: { topics: index.topics.length, workItems: index.workItems.length } })
    const sessions: M12ArchivedSession[] = []
    for (const [role, sessionId] of this.trackedSessionPlan()) {
      sessions.push(await this.archiveOne(role, sessionId))
    }
    const workspace = await this.dropWorkspace(step)
    const errors: string[] = []
    let fixtureRemoved = false
    if (this.keepFixture) {
      step.evidence.note = 'keep mode: the throwaway project and its workspace stay on disk'
    } else {
      try {
        await rm(this.fixture(), { recursive: true, force: true })
        fixtureRemoved = !existsSync(this.fixture())
      } catch (error) {
        errors.push(`delete fixture: ${messageOf(error)}`)
      }
    }
    const cleanup: M12CleanupReport = buildCleanupReport({
      sessions,
      workspaceId: workspace.id,
      workspaceDeleted: workspace.deleted,
      workspaceError: workspace.error,
      fixturePath: this.fixture(),
      keepFixture: this.keepFixture,
      fixtureRemoved,
      errors,
    })
    run.cleanup = cleanup
    obs(step, { cleanup })
    recordCheck(step, this.keepFixture ? 'keep mode kept the throwaway project' : 'the throwaway project was removed', this.keepFixture ? existsSync(this.fixture()) : fixtureRemoved, this.fixture())
    recordCheck(step, 'every created session was archived', sessions.every((session) => session.archived), sessions.filter((session) => !session.archived).map((session) => session.sessionId).join(','))
  }

  private trackedSessionPlan(): Array<[string, string]> {
    const candidates: Array<[string, string | null]> = [
      ['master', this.masterId],
      ['topic', this.topicId],
      ['reviewer', this.reviewerId],
      ['topic-resolved-match', this.extraTopicId],
    ]
    const roles = new Map(candidates.filter((entry): entry is [string, string] => entry[1] !== null).map(([role, id]) => [id, role]))
    return [...this.tracked].map((sessionId) => [roles.get(sessionId) ?? 'session', sessionId] as [string, string])
  }

  private async archiveOne(role: string, sessionId: string): Promise<M12ArchivedSession> {
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

  private async dropWorkspace(step: MutableStep): Promise<{ id: string | null; deleted: boolean; error: string | null }> {
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

  private readIndex(): Promise<ProjectIndexV2 | undefined> {
    return readProjectIndexAt(this.fixture())
  }

  private readActivity(): Promise<{ events: ActivityEvent[]; skippedLines: number }> {
    return readActivityAt(this.fixture())
  }

  private readInbox(): Promise<ReturnType<typeof parseInboxFile>> {
    return readInboxAt(this.fixture())
  }

  private readRequest(): Promise<M12ReviewRequestView | null> {
    return readReviewRequestAt(this.fixture(), this.requestId)
  }

  private async poll<T>(label: string, read: () => Promise<T | undefined>, timeoutMs = M12_E2E_STEP_TIMEOUT_MS): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.disposed) throw new Error('M12 E2E runner was disposed')
      const value = await read()
      if (value !== undefined) return value
      if (Date.now() >= deadline) throw new Error(`timeout after ${timeoutMs}ms waiting for ${label}`)
      await sleep(M12_E2E_POLL_MS)
    }
  }

  private async waitIdle(sessionId: string, timeoutMs = M12_E2E_STEP_TIMEOUT_MS): Promise<void> {
    await this.poll(`session ${sessionId} to be idle`, async () => {
      const { items } = await this.host.sessionController.list({})
      const row = items.find((item) => item.sessionId === sessionId)
      return row !== undefined && row.running === false ? true : undefined
    }, timeoutMs)
  }

  private async waitToolResult(sessionId: string, fromSeq: number, name: string): Promise<M12ToolCallEvidence> {
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

  private async promptStep(step: MutableStep, sessionId: string, role: M12SessionRole, content: string, mode: PromptMode = 'queue'): Promise<M12PromptEvidence> {
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

  private async observeGit(step: MutableStep, args: readonly string[], cwd: string): Promise<GitOutcome> {
    const result = await runGit(args, cwd)
    const commands = (step.evidence.observations.git as unknown[]) ?? []
    commands.push({ args: [...args], cwd, exitCode: result.code, stdout: clip(result.stdout, MAX_GIT_TEXT), stderr: clip(result.stderr, MAX_GIT_TEXT) })
    step.evidence.observations.git = commands
    return result
  }

  private async gitOk(step: MutableStep, args: readonly string[], cwd: string, label: string): Promise<GitOutcome> {
    const result = await this.observeGit(step, args, cwd)
    if (result.code !== 0) throw new Error(`${label} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`)
    return result
  }

  private async sameDirectory(left: string | null | undefined, right: string): Promise<boolean> {
    if (typeof left !== 'string' || left.trim() === '') return false
    try {
      return await realpath(left) === await realpath(right)
    } catch {
      return resolve(left) === resolve(right)
    }
  }

  private archivedSessionIds(): readonly string[] | undefined {
    const ids = this.host.workspaceRegistry.archivedSessionIds
    return Array.isArray(ids) ? ids : undefined
  }

  private fixture(): string {
    if (this.fixturePath === null) throw new Error('the M12 E2E fixture was not prepared')
    return this.fixturePath
  }

  private master(): string {
    if (this.masterId === null) throw new Error('master session was not created')
    return this.masterId
  }

  private topic(): string {
    if (this.topicId === null) throw new Error('the routed topic was not created')
    return this.topicId
  }

  private reviewer(): string {
    if (this.reviewerId === null) throw new Error('the reviewer session was not created')
    return this.reviewerId
  }

  private async workItem(): Promise<WorkItemRecordV2> {
    const item = workItemOfTopic(await this.readIndex(), this.topic())
    if (item === undefined) throw new Error('the topic work item is not in the index')
    return item
  }

  private track(sessionId: string): void {
    this.tracked.add(sessionId)
    if (!this.events.has(sessionId)) this.events.set(sessionId, [])
  }

  private releaseSessions(): void {
    for (const sessionId of this.tracked) this.events.delete(sessionId)
    this.tracked.clear()
  }

  private eventsOf(sessionId: string): readonly SessionEvent[] {
    return this.events.get(sessionId) ?? []
  }

  private lastSeqOf(sessionId: string): number {
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
