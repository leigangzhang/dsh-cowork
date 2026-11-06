/**
 * M3 real-host end-to-end driver: the independent review gate.
 *
 * Keeps only the `M3E2ERunner` class and its run/step methods; shared types,
 * constants, prompts, and pure helpers live in `src/m3-e2e-support.ts`. The
 * reviewer's deterministic verdict instruction is steered before the reviewer's
 * own first turn can decide, and an unexpected terminal verdict fails the step
 * immediately with the observed index state.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import {
  M3_E2E_EVIDENCE_RELATIVE,
  M3_E2E_FIXTURE_RELATIVE,
  M3_E2E_POLL_MS,
  M3_E2E_STEP_TIMEOUT_MS,
  M3_STEP_IDS,
  MAX_EVENTS,
  MAX_FILE_TEXT,
  MAX_GIT_TEXT,
  REVIEWER_PRESET_ID,
  REVIEW_FINDING,
  CONTENT_A,
  CONTENT_B_FIXED,
  CONTENT_B_INITIAL,
  FILE_A,
  FILE_B,
  FINDING_ID,
  MASTER_DONE,
  THREAD_A_SUBJECT,
  THREAD_B_SUBJECT,
  asRecord,
  assertionForReview,
  assistantTextSince,
  buildRepairPrompt,
  buildReviewerNeedsRevisionPrompt,
  buildReviewerPassPrompt,
  clip,
  isoNow,
  isStrictlyInside,
  lastSeq,
  messageOf,
  obs,
  parseIndex,
  planReviewVerdict,
  readHandoffs,
  readTextIfPresent,
  recordCheck,
  reviewStateOf,
  runGit,
  runView,
  sleep,
  stepFailureState,
  stableJson,
  stringOrNull,
  toolCallsSince,
  writeEvidenceAtomic,
} from './m3-e2e-support.js'
import type {
  DeliveryEvent,
  GitOutcome,
  HandoffView,
  IndexView,
  M3E2EConfig,
  M3E2EHost,
  M3EvidenceDocument,
  M3PromptEvidence,
  M3RunState,
  M3RunStatusView,
  M3StepView,
  MutableRun,
  PromptMode,
  MutableStep,
  ReviewFileEvidence,
  ReviewStateSnapshot,
  ReviewVerdict,
  SessionEvent,
  ThreadRef,
} from './m3-e2e-support.js'

export { M3_E2E_RUN_PATH, M3_E2E_STATUS_PATH } from './m3-e2e-support.js'
export type { M3E2EHost } from './m3-e2e-support.js'

export class M3E2ERunner {
  private readonly host: M3E2EHost
  private readonly config: M3E2EConfig
  private readonly runs = new Map<string, MutableRun>()
  private readonly events = new Map<string, SessionEvent[]>()
  private readonly tracked = new Set<string>()
  private readonly evidenceFile: string
  private readonly fixturePath: string
  private readonly reviewsDir: string
  private lastRunId: string | null = null
  private disposed = false
  private masterId: string | null = null
  private threadA: string | null = null
  private threadACheckout: string | null = null
  private threadB: string | null = null
  private threadBCheckout: string | null = null
  private reviewerA: string | null = null
  private reviewerB1: string | null = null
  private reviewerB2: string | null = null

  constructor(host: M3E2EHost, config: M3E2EConfig) {
    this.host = host
    this.config = config
    this.evidenceFile = join(config.repoPath, M3_E2E_EVIDENCE_RELATIVE)
    this.fixturePath = join(config.repoPath, M3_E2E_FIXTURE_RELATIVE)
    this.reviewsDir = join(this.fixturePath, '.dsh-cowork', 'reviews')
    const expected = join(resolve(config.repoPath), M3_E2E_FIXTURE_RELATIVE)
    if (resolve(this.fixturePath) !== expected) {
      throw new Error(`refusing to use fixture path ${resolve(this.fixturePath)}; expected ${expected}`)
    }
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

  start(): { runId: string; state: M3RunState } {
    if (this.disposed) throw new Error('M3 E2E runner is disposed')
    const active = this.lastRunId === null ? undefined : this.runs.get(this.lastRunId)
    if (active !== undefined && active.state === 'running') throw new Error(`M3 E2E run ${active.runId} is still running`)
    const run: MutableRun = {
      runId: `m3-${randomUUID()}`,
      state: 'running',
      startedAt: isoNow(),
      steps: M3_STEP_IDS.map((id) => ({ id, status: 'pending', evidence: { startedAt: null, endedAt: null, prompts: [], observations: {}, assertions: [] } })),
      finalIndex: null,
      cleanup: {},
    }
    this.runs.set(run.runId, run)
    this.lastRunId = run.runId
    while (this.runs.size > 10) {
      const oldest = this.runs.keys().next().value
      if (oldest === undefined || oldest === this.lastRunId) break
      this.runs.delete(oldest)
    }
    void this.execute(run)
    return { runId: run.runId, state: run.state }
  }

  async resolve(runId: string): Promise<M3RunStatusView | undefined> {
    const run = this.runs.get(runId)
    if (run !== undefined) return runView(run, this.evidenceFile)
    if (!/^m3-[0-9a-fA-F-]{8,64}$/.test(runId)) return undefined
    try {
      const parsed = JSON.parse(await readFile(this.evidenceFile, 'utf8')) as M3EvidenceDocument | undefined
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

  private async execute(run: MutableRun): Promise<void> {
    try {
      for (const step of run.steps) {
        if (this.disposed) throw new Error('M3 E2E runner was disposed')
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
      this.releaseSessions()
    }
  }

  private async runStep(step: MutableStep, run: MutableRun): Promise<void> {
    switch (step.id) {
      case 'setup': return this.stepSetup(step, run)
      case 'thread-a-create': {
        const c = await this.createThread(step, THREAD_A_SUBJECT)
        this.threadA = c.threadId
        this.threadACheckout = c.checkoutPath
        return
      }
      case 'thread-a-work': return this.stepThreadWork(step, this.threadOf('a'), FILE_A, CONTENT_A)
      case 'review-a-request':
        this.reviewerA = await this.requestReview(step, this.threadOf('a').threadId, null)
        return
      case 'review-a-pass':
        return this.reviewVerdict(step, 'pass', this.threadOf('a'), this.reviewerA, FILE_A)
      case 'merge-a':
        return this.mergeThread(step, run, this.threadOf('a'), FILE_A, CONTENT_A)
      case 'thread-b-create': {
        const c = await this.createThread(step, THREAD_B_SUBJECT)
        this.threadB = c.threadId
        this.threadBCheckout = c.checkoutPath
        return
      }
      case 'thread-b-work': return this.stepThreadWork(step, this.threadOf('b'), FILE_B, CONTENT_B_INITIAL)
      case 'review-b-request':
        this.reviewerB1 = await this.requestReview(step, this.threadOf('b').threadId, null)
        return
      case 'review-b-needs-revision':
        return this.reviewVerdict(step, 'needs_revision', this.threadOf('b'), this.reviewerB1, FILE_B)
      case 'thread-b-repair': return this.repairThread(step, this.threadOf('b'))
      case 'review-b-request-2':
        this.reviewerB2 = await this.requestReview(step, this.threadOf('b').threadId, this.reviewerB1)
        return
      case 'review-b-pass':
        return this.reviewVerdict(step, 'pass', this.threadOf('b'), this.reviewerB2, FILE_B)
      case 'merge-b':
        return this.mergeThread(step, run, this.threadOf('b'), FILE_B, CONTENT_B_FIXED)
      case 'cleanup': return this.stepCleanup(step, run)
      default: throw new Error(`unknown M3 E2E step: ${step.id}`)
    }
  }

  private async stepSetup(step: MutableStep, run: MutableRun): Promise<void> {
    const repo = this.fixturePath
    await rm(repo, { recursive: true, force: true })
    await mkdir(repo, { recursive: true, mode: 0o700 })
    obs(step, { fixture: repo })
    await this.gitOk(step, ['init', '-b', 'main'], repo, 'git init')
    await this.gitOk(step, ['config', 'user.email', 'e2e@dsh-cowork.invalid'], repo, 'git config email')
    await this.gitOk(step, ['config', 'user.name', 'dsh-cowork e2e'], repo, 'git config name')
    await writeFile(join(repo, 'README.md'), '# M3 E2E fixture\n', 'utf8')
    await writeFile(join(repo, '.gitignore'), '.dsh-cowork/\n', 'utf8')
    await this.gitOk(step, ['add', 'README.md', '.gitignore'], repo, 'git add')
    await this.gitOk(step, ['commit', '-m', 'init'], repo, 'git commit')
    const created = await this.host.sessionController.create({ cwd: repo, agentPreset: 'cowork-master' })
    this.masterId = created.sessionId
    this.track(created.sessionId)
    run.cleanup.masterSessionId = created.sessionId
    obs(step, { masterSessionId: created.sessionId, createReturnedPreset: created.agentPreset ?? null })
    recordCheck(step, 'master session mounted cowork-master', created.agentPreset === 'cowork-master', `agentPreset=${String(created.agentPreset)}`)
    await this.waitIdle(created.sessionId)
    await this.promptStep(step, created.sessionId, 'master', `Call cowork_project_init with no arguments. ${MASTER_DONE}`)
    const index = await this.poll('project index initialized by the master', async () => {
      const current = await this.readIndex()
      return current !== undefined && current.masterSessionId === created.sessionId ? current : undefined
    })
    obs(step, { indexFile: join(repo, '.dsh-cowork', 'index.json'), indexMasterSessionId: index.masterSessionId })
    recordCheck(step, 'index file names the created master', existsSync(join(repo, '.dsh-cowork', 'index.json')) && index.masterSessionId === created.sessionId, `${index.masterSessionId} == ${created.sessionId}`)
    await this.waitIdle(created.sessionId)
  }

  private async createThread(step: MutableStep, subject: string): Promise<{ threadId: string; checkoutPath: string }> {
    const master = this.master()
    await this.waitIdle(master)
    await this.promptStep(
      step,
      master,
      'master',
      `Call cowork_thread_create with subject "${subject}", isolated true, and brief "Wait: do not call cowork_handoff yet; read cowork_project_status, then stop. ${MASTER_DONE}". The brief keeps the new thread from handing off before the next step gives it work. ${MASTER_DONE}`,
    )
    const record = await this.poll(`thread "${subject}" in the index`, async () => {
      const index = await this.readIndex()
      if (index === undefined) return undefined
      const thread = index.threads.find((entry) => entry.subject === subject)
      return thread !== undefined && typeof thread.checkoutPath === 'string' ? thread : undefined
    })
    const threadId = record.threadId
    const checkoutPath = record.checkoutPath as string
    this.track(threadId)
    obs(step, { threadId, checkoutPath, indexStatus: record.status })
    recordCheck(step, 'clone directory exists', existsSync(checkoutPath), checkoutPath)
    const branch = await this.observeGit(step, ['branch', '--show-current'], checkoutPath)
    recordCheck(step, 'clone is on cowork/<threadId>', branch.code === 0 && branch.stdout.trim() === `cowork/${threadId}`, `exit=${branch.code} branch=${branch.stdout.trim()}`)
    recordCheck(step, 'index status is new or active', record.status === 'new' || record.status === 'active', String(record.status))
    await this.waitIdle(threadId)
    return { threadId, checkoutPath }
  }

  private async pollThreadHandoff(thread: ThreadRef, fileName: string, content: string, commitMessage: string, startedAt: string): Promise<{ text: string; log: GitOutcome; status: GitOutcome; handoff: HandoffView }> {
    return this.poll(`${fileName} committed and handed off`, async () => {
      const text = await readTextIfPresent(join(thread.checkoutPath, fileName))
      if (text === undefined || text.trim() !== content) return undefined
      const log = await runGit(['log', '-1', '--format=%s'], thread.checkoutPath)
      if (log.code !== 0 || log.stdout.trim() !== commitMessage) return undefined
      const status = await runGit(['status', '--porcelain'], thread.checkoutPath)
      if (status.code !== 0 || status.stdout.trim() !== '') return undefined
      const state = await this.reviewState(thread.threadId)
      if (state === null || state.status !== 'awaiting_review') return undefined
      const handoff = await this.waitHandoffAfter(startedAt, thread.threadId)
      return handoff === undefined ? undefined : { text, log, status, handoff }
    })
  }

  private async stepThreadWork(step: MutableStep, thread: ThreadRef, fileName: string, content: string): Promise<void> {
    const isA = thread.threadId === this.threadA
    const commitMessage = isA ? 'e2e review pass work' : 'e2e review repair work'
    const summary = isA ? 'M3 E2E review pass work' : 'M3 E2E review repair work'
    await this.waitIdle(thread.threadId)
    const startedAt = isoNow()
    await this.promptStep(
      step,
      thread.threadId,
      'thread',
      `Use the bash tool to run exactly: printf '${content}\\n' > ${fileName} && git add ${fileName} && git commit -m "${commitMessage}". Then call cowork_handoff with status "awaiting_review", summary "${summary}", verification [{command: "test -f ${fileName}", exitCode: 0, evidence: "${fileName} exists"}], and changedPaths ["${fileName}"]. ${MASTER_DONE}`,
    )
    const t = await this.pollThreadHandoff(thread, fileName, content, commitMessage, startedAt)
    obs(step, { fileName, fileText: clip(t.text, MAX_FILE_TEXT), gitLog: clip(t.log.stdout, MAX_GIT_TEXT), gitStatus: clip(t.status.stdout, MAX_GIT_TEXT), handoffFile: t.handoff.filePath, handoff: t.handoff.record })
    recordCheck(step, `clone contains ${fileName}`, t.text.trim() === content, t.text)
    recordCheck(step, 'clone working tree is clean', t.status.stdout.trim() === '', t.status.stdout)
    const state = await this.reviewState(thread.threadId)
    recordCheck(step, 'index status is awaiting_review', state?.status === 'awaiting_review', String(state?.status))
    recordCheck(step, 'handoff file exists for the thread', existsSync(t.handoff.filePath), t.handoff.filePath)
    await this.waitIdle(thread.threadId)
  }

  private async requestReview(step: MutableStep, threadId: string, previousReviewer: string | null): Promise<string> {
    const master = this.master()
    await this.waitIdle(master)
    await this.promptStep(step, master, 'master', `Call cowork_review_request with threadId "${threadId}". ${MASTER_DONE}`)
    const target = await this.poll('review pending with a fresh reviewer session', async () => {
      const state = await this.reviewState(threadId)
      if (state === null || state.reviewStatus !== 'pending') return undefined
      const reviewer = state.reviewerSessionId
      if (reviewer === null || reviewer === threadId || reviewer === previousReviewer) return undefined
      return { state, reviewer }
    })
    this.track(target.reviewer)
    obs(step, { threadId, reviewerSessionId: target.reviewer, previousReviewerSessionId: previousReviewer, reviewStatus: target.state.reviewStatus, reviewerPreset: REVIEWER_PRESET_ID })
    const rows: [string, boolean, unknown][] = [
      ['reviewer session is not the thread session', target.reviewer !== threadId, `${target.reviewer} != ${threadId}`],
      ['reviewer session is not the master session', target.reviewer !== master, `${target.reviewer} != ${master}`],
      ['a new reviewer session was created', previousReviewer === null || target.reviewer !== previousReviewer, `${target.reviewer} (previous ${String(previousReviewer)})`],
    ]
    for (const [name, ok, evidence] of rows) recordCheck(step, name, ok, evidence)
    return target.reviewer
  }

  private async reviewVerdict(step: MutableStep, verdict: 'pass' | 'needs_revision', thread: ThreadRef, reviewerId: string | null, fileName: string): Promise<void> {
    if (reviewerId === null) throw new Error(`no reviewer session for verdict ${verdict}`)
    const expectedStatus = verdict === 'pass' ? 'done' : 'active'
    const deliveredFromSeq = this.lastSeqOf(thread.threadId)
    const initial = await this.reviewState(thread.threadId)
    const plan = planReviewVerdict(initial, verdict, expectedStatus)
    obs(step, { initialReviewState: initial, verdictPlan: plan })
    if (plan.action === 'fail') {
      const events = this.reviewerEventSummary(reviewerId)
      obs(step, { reviewerEvents: events })
      throw new Error(`cannot deliver ${verdict}: ${plan.reason}; reviewerSessionId=${reviewerId}; events=${events}`)
    }
    const input = {
      threadId: thread.threadId,
      subject: fileName === FILE_A ? THREAD_A_SUBJECT : THREAD_B_SUBJECT,
      repoPath: this.fixturePath,
      checkoutPath: thread.checkoutPath,
      fileName,
      verificationCommand: `test -f ${fileName}`,
    }
    if (plan.action === 'steer') {
      const instruction = 'Before calling cowork_review_verdict, follow this instruction; if you already planned a different verdict, replace it with the one below.\n\n'
        + (verdict === 'pass' ? buildReviewerPassPrompt(input) : buildReviewerNeedsRevisionPrompt({ ...input, finding: REVIEW_FINDING }))
      const steer = await this.promptStep(step, reviewerId, 'reviewer', instruction, 'steer')
      obs(step, { steer: { mode: steer.mode, fromSeq: steer.fromSeq } })
    } else {
      step.evidence.note = plan.reason
    }
    const state = await this.poll(`verdict ${verdict} and thread status ${expectedStatus}`, async () => {
      const current = await this.reviewState(thread.threadId)
      if (current === null) return undefined
      if (current.reviewStatus === verdict && current.status === expectedStatus) return current
      if (planReviewVerdict(current, verdict, expectedStatus).action === 'fail') {
        const events = this.reviewerEventSummary(reviewerId)
        obs(step, { unexpectedReviewState: current, reviewerEvents: events })
        throw new Error(`unexpected review state while waiting for ${verdict}/${expectedStatus}: reviewStatus=${String(current.reviewStatus)} status=${current.status} reviewerSessionId=${reviewerId}; events=${events}`)
      }
      return undefined
    })
    obs(step, { indexStatus: state.status, reviewStatus: state.reviewStatus })
    await this.checkReviewFile(step, verdict, await this.readReviewRecord(state.latestReviewPath), thread.threadId, reviewerId)
    if (verdict === 'needs_revision') {
      const delivery = await this.poll('findings delivered to the thread session', async () => this.deliveryEventSince(thread.threadId, deliveredFromSeq, FINDING_ID))
      obs(step, { delivery, deliveredAfterSeq: deliveredFromSeq })
      recordCheck(step, 'thread session received the findings delivery', delivery.text.includes(FINDING_ID), `${delivery.source}:${delivery.type}@${delivery.seq}`)
    }
    await this.waitIdle(reviewerId)
  }

  private reviewerEventSummary(reviewerId: string): string {
    const events = this.events.get(reviewerId) ?? []
    const types = events.slice(-12).map((event) => event.type).join(',')
    return clip(`${types} | ${assistantTextSince(events, 0)}`, 800)
  }

  private async repairThread(step: MutableStep, thread: ThreadRef): Promise<void> {
    await this.waitIdle(thread.threadId)
    const fixed = await readTextIfPresent(join(thread.checkoutPath, FILE_B))
    const clean = await runGit(['status', '--porcelain'], thread.checkoutPath)
    const before = await this.reviewState(thread.threadId)
    if (fixed?.trim() === CONTENT_B_FIXED && clean.code === 0 && clean.stdout.trim() === '' && before?.status === 'awaiting_review') {
      step.evidence.note = 'the thread already repaired and re-handed off after the findings delivery; passed idempotently'
    } else {
      const startedAt = isoNow()
      await this.promptStep(
        step,
        thread.threadId,
        'thread',
        buildRepairPrompt({ threadId: thread.threadId, checkoutPath: thread.checkoutPath, fileName: FILE_B, fixedContent: CONTENT_B_FIXED, finding: REVIEW_FINDING }),
      )
      const t = await this.pollThreadHandoff(thread, FILE_B, CONTENT_B_FIXED, `fix: apply review finding ${FINDING_ID}`, startedAt)
      obs(step, { fileText: clip(t.text, MAX_FILE_TEXT), gitStatus: clip(t.status.stdout, MAX_GIT_TEXT), handoffFile: t.handoff.filePath, handoff: t.handoff.record })
      recordCheck(step, 'repair handoff file exists', existsSync(t.handoff.filePath), t.handoff.filePath)
    }
    const text = await readTextIfPresent(join(thread.checkoutPath, FILE_B))
    obs(step, { fileText: clip(text ?? '', MAX_FILE_TEXT) })
    recordCheck(step, `${FILE_B} now holds the fixed content`, text?.trim() === CONTENT_B_FIXED, String(text))
    const status = await this.observeGit(step, ['status', '--porcelain'], thread.checkoutPath)
    recordCheck(step, 'repaired clone is clean', status.stdout.trim() === '', status.stdout)
    const state = await this.reviewState(thread.threadId)
    obs(step, { indexStatus: state?.status ?? null })
    recordCheck(step, 'index status is awaiting_review after the repair', state?.status === 'awaiting_review', String(state?.status))
    await this.waitIdle(thread.threadId)
  }

  private async mergeThread(step: MutableStep, run: MutableRun, thread: ThreadRef, fileName: string, expectedContent: string): Promise<void> {
    const master = this.master()
    await this.waitAllIdle([master, thread.threadId])
    if (await this.mergeAlreadyDone(thread, fileName, expectedContent)) {
      step.evidence.note = 'merge target state was already reached before the prompt; passed idempotently'
    } else {
      await this.promptStep(step, master, 'master', `Call cowork_checkout_merge with threadId "${thread.threadId}". ${MASTER_DONE}`)
      await this.poll('thread merged and torn down', async () => await this.mergeAlreadyDone(thread, fileName, expectedContent) ? true : undefined)
    }
    const content = await readTextIfPresent(join(this.fixturePath, fileName))
    const branch = await this.observeGit(step, ['rev-parse', '--verify', `refs/heads/cowork/${thread.threadId}`], this.fixturePath)
    const state = await this.reviewState(thread.threadId)
    obs(step, { mainFileText: clip(content ?? '', MAX_FILE_TEXT), finalThreadReviewState: state })
    const rows: [string, boolean, unknown][] = [
      [`${fileName} exists in the main worktree`, content !== undefined, join(this.fixturePath, fileName)],
      [`${fileName} holds the merged content`, content?.trim() === expectedContent, String(content)],
      ['clone directory removed', !existsSync(thread.checkoutPath), thread.checkoutPath],
      ['thread branch deleted', branch.code !== 0, `exitCode=${branch.code}`],
      ['index checkoutPath is null', state?.checkoutPath === null, String(state?.checkoutPath)],
      ['index status is done', state?.status === 'done', String(state?.status)],
      ['index reviewStatus is pass', state?.reviewStatus === 'pass', String(state?.reviewStatus)],
    ]
    for (const [name, ok, evidence] of rows) recordCheck(step, name, ok, evidence)
    const head = await this.observeGit(step, ['rev-parse', 'HEAD'], this.fixturePath)
    recordCheck(step, 'merge commit exists in the main repository', head.code === 0 && /^[0-9a-f]{40}/.test(head.stdout.trim()), head.stdout.trim())
    obs(step, { mergeCommit: head.stdout.trim() })
    const commits = Array.isArray(run.cleanup.mergeCommits) ? run.cleanup.mergeCommits as unknown[] : []
    run.cleanup.mergeCommits = [...commits, { threadId: thread.threadId, commit: head.stdout.trim() }]
    await this.waitIdle(master)
  }

  private async stepCleanup(step: MutableStep, run: MutableRun): Promise<void> {
    const index = await this.readIndex()
    run.finalIndex = index ?? null
    obs(step, { finalIndex: index ?? null })
    const archived: string[] = []
    const archiveErrors: string[] = []
    const errors: string[] = []
    const reviews: unknown[] = []
    for (const thread of [this.threadOf('a'), this.threadOf('b')]) {
      const state = reviewStateOf(index, thread.threadId)
      const file = await this.readReviewRecord(state?.latestReviewPath ?? null)
      reviews.push({ threadId: thread.threadId, filePath: file?.filePath ?? null, exists: file !== undefined, text: file === undefined ? null : clip(file.text, MAX_FILE_TEXT), record: file?.record ?? null })
    }
    obs(step, { reviews, mergeCommits: run.cleanup.mergeCommits ?? [] })
    for (const sessionId of this.sessionIds()) {
      try {
        await this.archiveSession(sessionId)
        archived.push(sessionId)
      } catch (error) {
        archiveErrors.push(`${sessionId}: ${messageOf(error)}`)
      }
    }
    let tempRepoRemoved = false
    try {
      await rm(this.fixturePath, { recursive: true, force: true })
      tempRepoRemoved = !existsSync(this.fixturePath)
    } catch (error) {
      errors.push(`delete fixture: ${messageOf(error)}`)
    }
    const cleanup: Record<string, unknown> = {
      archived,
      archiveErrors,
      errors,
      reviews,
      mergeCommits: run.cleanup.mergeCommits ?? [],
      masterSessionId: this.masterId,
      threadSessions: { a: this.threadA, b: this.threadB },
      reviewerSessions: { a: this.reviewerA, b1: this.reviewerB1, b2: this.reviewerB2 },
      tempRepoRemoved,
    }
    run.cleanup = { ...run.cleanup, ...cleanup }
    obs(step, { cleanup })
    recordCheck(step, 'temporary project removed', tempRepoRemoved, this.fixturePath)
  }

  private async mergeAlreadyDone(thread: ThreadRef, fileName: string, expectedContent: string): Promise<boolean> {
    const state = await this.reviewState(thread.threadId)
    const text = await readTextIfPresent(join(this.fixturePath, fileName))
    return state !== null && state.checkoutPath === null && state.status === 'done' && !existsSync(thread.checkoutPath) && text?.trim() === expectedContent
  }

  private async checkReviewFile(step: MutableStep, verdict: 'pass' | 'needs_revision', file: ReviewFileEvidence | undefined, threadId: string, reviewerId: string): Promise<void> {
    if (file !== undefined) {
      obs(step, { reviewFile: { filePath: file.filePath, text: clip(file.text, MAX_FILE_TEXT) } })
      recordCheck(step, 'review file lives under the reviews directory', isStrictlyInside(this.reviewsDir, file.filePath), file.filePath)
    }
    if (file === undefined || file.record === undefined) throw new Error(`review file missing or not JSON for thread ${threadId}`)
    const rec = file.record
    for (const c of [
      assertionForReview('review file verdict', verdict, rec.verdict),
      assertionForReview('review file threadId', threadId, rec.threadId),
      assertionForReview('review file reviewerSessionId', reviewerId, rec.reviewerSessionId),
      assertionForReview('review file version', 1, rec.version),
    ]) recordCheck(step, c.name, c.ok, c.evidence)
    const findings = Array.isArray(rec.findings) ? rec.findings : []
    if (verdict === 'pass') {
      recordCheck(step, 'pass review has no findings', findings.length === 0, String(findings.length))
      return
    }
    const f = findings.map((entry) => asRecord(entry)).find((entry) => entry?.id === FINDING_ID) ?? {}
    const rows: [string, boolean, unknown][] = [
      ['review carries the finding', f.id === FINDING_ID, `findings=${findings.length}`],
      ['finding severity is high', f.severity === 'high', String(f.severity)],
      ['finding problem names the unfixed content', typeof f.problem === 'string' && f.problem.includes(CONTENT_B_INITIAL), String(f.problem)],
      ['finding requiredFix names the fixed content', typeof f.requiredFix === 'string' && f.requiredFix.includes(CONTENT_B_FIXED), String(f.requiredFix)],
    ]
    for (const [name, ok, evidence] of rows) recordCheck(step, name, ok, evidence)
  }

  private async poll<T>(label: string, read: () => Promise<T | undefined>, timeoutMs = M3_E2E_STEP_TIMEOUT_MS): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.disposed) throw new Error('M3 E2E runner was disposed')
      const value = await read()
      if (value !== undefined) return value
      if (Date.now() >= deadline) throw new Error(`timeout after ${timeoutMs}ms waiting for ${label}`)
      await sleep(M3_E2E_POLL_MS)
    }
  }

  private async waitIdle(sessionId: string, timeoutMs = M3_E2E_STEP_TIMEOUT_MS): Promise<void> {
    await this.poll(`session ${sessionId} to be idle`, async () => {
      const { items } = await this.host.sessionController.list({})
      const row = items.find((item) => item.sessionId === sessionId)
      return row !== undefined && row.running === false ? true : undefined
    }, timeoutMs)
  }

  private async waitAllIdle(sessionIds: readonly string[], timeoutMs = M3_E2E_STEP_TIMEOUT_MS): Promise<void> {
    await this.poll(`sessions ${sessionIds.join(', ')} to be idle`, async () => {
      const { items } = await this.host.sessionController.list({})
      const allIdle = sessionIds.every((sessionId) => {
        const row = items.find((item) => item.sessionId === sessionId)
        return row !== undefined && row.running === false
      })
      return allIdle ? true : undefined
    }, timeoutMs)
  }

  private async promptStep(step: MutableStep, sessionId: string, role: M3PromptEvidence['role'], content: string, mode: PromptMode = 'queue'): Promise<M3PromptEvidence> {
    const fromSeq = this.lastSeqOf(sessionId)
    const evidence: M3PromptEvidence = { sessionId, role, content, mode, accepted: false, fromSeq, assistantText: '', toolCalls: [] }
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
      prompt.assistantText = assistantTextSince(this.events.get(prompt.sessionId) ?? [], prompt.fromSeq)
      prompt.toolCalls = toolCallsSince(this.events.get(prompt.sessionId) ?? [], prompt.fromSeq)
    }
  }

  private lastSeqOf(sessionId: string): number {
    return lastSeq(this.events.get(sessionId) ?? [])
  }

  // A delivered prompt/inbox event is primary evidence; the thread's own turn is a labelled fallback.
  private deliveryEventSince(sessionId: string, fromSeq: number, needle: string): DeliveryEvent | undefined {
    const events = this.events.get(sessionId) ?? []
    const matches: DeliveryEvent[] = []
    for (const event of events) {
      if (event.seq <= fromSeq) continue
      let text: string
      try {
        text = JSON.stringify(event.data)
      } catch {
        continue
      }
      if (!text.includes(needle)) continue
      matches.push({ type: event.type, seq: event.seq, source: event.type === 'assistant/message' ? 'assistant-text' : 'event', text: clip(text, 3000) })
    }
    return matches.find((m) => m.source === 'event') ?? matches[0]
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

  private async readIndex(): Promise<IndexView | undefined> {
    const text = await readTextIfPresent(join(this.fixturePath, '.dsh-cowork', 'index.json'))
    return text === undefined ? undefined : parseIndex(text)
  }

  private async reviewState(threadId: string): Promise<ReviewStateSnapshot | null> {
    return reviewStateOf(await this.readIndex(), threadId)
  }

  private async readReviewRecord(path: string | null): Promise<ReviewFileEvidence | undefined> {
    if (path === null) return undefined
    const filePath = isAbsolute(path) ? path : join(this.fixturePath, path)
    const text = await readTextIfPresent(filePath)
    if (text === undefined) return undefined
    let record: Record<string, unknown> | undefined
    try {
      record = asRecord(JSON.parse(text))
    } catch {
      record = undefined
    }
    return { filePath, text, ...(record === undefined ? {} : { record }) }
  }

  private async waitHandoffAfter(startedAt: string, threadId: string): Promise<HandoffView | undefined> {
    const files = await readHandoffs(this.fixturePath)
    return files.find((file) => file.record.threadId === threadId && file.record.createdAt >= startedAt)
  }

  private async safeSnapshot(): Promise<Record<string, unknown>> {
    try {
      const index = await this.readIndex()
      const threads = (index?.threads ?? []).map((t) => ({
        threadId: t.threadId,
        status: t.status,
        checkoutPath: t.checkoutPath ?? null,
        reviewStatus: stringOrNull(t.reviewStatus),
        reviewerSessionId: stringOrNull(t.reviewerSessionId),
        latestReviewPath: stringOrNull(t.latestReviewPath),
        cloneExists: typeof t.checkoutPath === 'string' && existsSync(t.checkoutPath),
      }))
      return { fixtureExists: existsSync(this.fixturePath), masterSessionId: index?.masterSessionId ?? null, threads }
    } catch (error) {
      return { error: messageOf(error) }
    }
  }

  private master(): string {
    if (this.masterId === null) throw new Error('master session was not created')
    return this.masterId
  }

  private threadOf(which: 'a' | 'b'): ThreadRef {
    const id = which === 'a' ? this.threadA : this.threadB
    const checkoutPath = which === 'a' ? this.threadACheckout : this.threadBCheckout
    if (id === null || checkoutPath === null) throw new Error(`thread ${which} was not created`)
    return { threadId: id, checkoutPath }
  }

  private sessionIds(): string[] {
    const ids = [this.masterId, this.threadA, this.threadB, this.reviewerA, this.reviewerB1, this.reviewerB2].filter((id): id is string => id !== null)
    return [...new Set(ids)]
  }

  private track(sessionId: string): void {
    this.tracked.add(sessionId)
    if (!this.events.has(sessionId)) this.events.set(sessionId, [])
  }

  private releaseSessions(): void {
    for (const sessionId of this.tracked) this.events.delete(sessionId)
    this.tracked.clear()
  }

  private async archiveSession(sessionId: string): Promise<void> {
    await this.host.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
  }

  private async safeArchiveSessions(run: MutableRun): Promise<void> {
    const errors: string[] = []
    for (const sessionId of this.sessionIds()) {
      try {
        await this.archiveSession(sessionId)
      } catch (error) {
        errors.push(`${sessionId}: ${messageOf(error)}`)
      }
    }
    if (errors.length > 0) run.cleanup = { ...run.cleanup, autoArchiveErrors: errors }
  }

  private async persist(run: MutableRun): Promise<void> {
    const document: M3EvidenceDocument = {
      version: 1,
      runId: run.runId,
      state: run.state,
      startedAt: run.startedAt,
      endedAt: run.endedAt ?? null,
      evidenceFile: this.evidenceFile,
      host: {
        plugin: this.config.pluginName,
        pluginVersion: this.config.pluginVersion,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        repoPath: this.config.repoPath,
      },
      steps: JSON.parse(JSON.stringify(run.steps)) as M3StepView[],
      finalIndex: run.finalIndex,
      cleanup: run.cleanup,
      ...(run.error === undefined ? {} : { error: run.error }),
    }
    try {
      await writeEvidenceAtomic(this.evidenceFile, `${JSON.stringify(document, null, 2)}\n`)
    } catch (error) {
      this.config.log?.(`M3 E2E evidence write failed: ${messageOf(error)}`)
    }
  }
}
