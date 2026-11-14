import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import './support/ts-hook.mjs'
/**
 * Host-free contract tests for the M12 E2E driver. The driver itself needs a
 * real DSH host (sessions, the panel connection, git); these tests pin the
 * frozen plan instead: the step order, the evidence document shape, the
 * fail-fast/cleanup rules, the route constants, and the deterministic prompt
 * text. `src/m12-e2e-support.ts` value-imports only Node built-ins and the
 * plugin's pure modules (`store-schema`, `review-request`, `presets`), so this
 * file needs the usual `.js`→`.ts` resolve hook and nothing else.
 */

const {
  M12_E2E_EVIDENCE_RELATIVE,
  M12_E2E_HANDOFF_SUMMARY,
  M12_E2E_POLL_MS,
  M12_E2E_REVIEW_SUMMARY,
  M12_E2E_RUN_PATH,
  M12_E2E_SHORT_IDLE_MS,
  M12_E2E_SHORT_RESOLVE_MS,
  M12_E2E_STATUS_PATH,
  M12_E2E_STEP_TIMEOUT_MS,
  M12_E2E_TOPIC_INTENT,
  M12_E2E_WORK_CONTENT,
  M12_E2E_WORK_FILE,
  M12_EXPECTED_ACTIVITY_TYPES,
  M12_STEP_IDS,
  MASTER_PRESET_ID,
  MERGE_TOOL,
  REVIEWER_PRESET_ID,
  REVIEW_REQUEST_TOOL,
  REVIEW_VERDICT_TOOL,
  ROUTE_TOOL,
  TOPIC_PRESET_ID,
  WORK_ITEM_TOOL,
  artifactIdentityFrom,
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
  createRun,
  fixturePathProblem,
  isLiveTopicStatus,
  missingActivityTypes,
  parseActivityFile,
  parseInboxFile,
  parseProjectIndexV2,
  planMergePrompt,
  planRequestReview,
  planReviewVerdict,
  reviewRequestView,
  runStatusView,
  shortThresholdsProblem,
  shouldRemoveFixture,
  stepFailureState,
} = await import('../src/m12-e2e-support.ts')

const here = dirname(fileURLToPath(import.meta.url))
const driverPath = join(here, '..', 'src', 'm12-e2e.ts')
const driverBasePath = join(here, '..', 'src', 'm12-e2e-driver.ts')
const supportPath = join(here, '..', 'src', 'm12-e2e-support.ts')
/** The three modules behind the support barrel, in import order. */
const supportModulePaths = ['m12-e2e-contract.ts', 'm12-e2e-prompts.ts', 'm12-e2e-evidence.ts']
  .map((name) => join(here, '..', 'src', name))

/** The 48 KiB split target every M12 source file must keep. */
const FILE_BUDGET_BYTES = 49_152

/** Every file the split produced; the budget test walks all of them. */
const M12_SOURCE_PATHS = [driverPath, driverBasePath, supportPath, ...supportModulePaths]

/** Lifecycle and plumbing moved to the driver base module; structure pins read both. */
const driverBaseSource = () => [readFileSync(driverPath, 'utf8'), readFileSync(driverBasePath, 'utf8')].join('\n')

const CREATED_AT = '2026-11-08T09:00:00.000Z'

/** A v2 topic with every field the store's schema requires. */
function topicV2(overrides = {}) {
  return {
    topicId: 'session-topic',
    title: 'billing retry backoff',
    status: 'active',
    awaitingReview: false,
    blocked: false,
    scope: '',
    ownedPaths: [],
    aliases: [],
    digest: '',
    cwd: '/tmp/fixture',
    legacyCheckoutPath: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    lastActiveAt: CREATED_AT,
    lastDeliveryConfirmedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    latestReviewRequestId: null,
    reviewStatus: null,
    reviewerSessionId: null,
    ...overrides,
  }
}

/** A v2 index document. */
function indexV2(topics = [topicV2()], workItems = []) {
  return JSON.stringify({
    version: 2,
    projectId: 'project-1',
    masterSessionId: 'session-master',
    createdAt: CREATED_AT,
    topics,
    workItems,
  })
}

const gitOk = (stdout) => ({ code: 0, stdout, stderr: '' })
const gitFail = (stderr) => ({ code: 128, stdout: '', stderr })

// ---------------------------------------------------------------------------
// the frozen step list
// ---------------------------------------------------------------------------

test('M12_STEP_IDS is the seventeen-step 0.2.0 chain in order', () => {
  assert.deepEqual(M12_STEP_IDS, [
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
    'archive',
    'no-undo',
    'resolved-no-receive',
    'reopen',
    'activity',
    'cleanup',
  ])
  assert.equal(M12_STEP_IDS.length, 17)
  assert.equal(new Set(M12_STEP_IDS).size, 17)
})

test('the chain keeps its gate order', () => {
  const at = (id) => M12_STEP_IDS.indexOf(id)

  assert.equal(at('route-topic'), at('setup') + 1)
  assert.equal(at('session-list'), at('route-topic') + 1)
  assert.equal(at('overview'), at('session-list') + 1)
  assert.equal(at('work-item-commit'), at('work-item') + 1)
  assert.equal(at('review-request'), at('work-item-commit') + 1)
  assert.equal(at('review-verdict'), at('review-request') + 1)
  assert.equal(at('master-merge-decision'), at('review-verdict') + 1)
  assert.equal(at('handoff-done'), at('master-merge-decision') + 1)
  assert.equal(at('merge'), at('handoff-done') + 1)
  assert.equal(at('archive'), at('merge') + 1)
  assert.equal(at('no-undo'), at('archive') + 1)
  assert.equal(at('resolved-no-receive'), at('no-undo') + 1)
  assert.equal(at('reopen'), at('resolved-no-receive') + 1)
  assert.equal(at('activity'), at('reopen') + 1)
  assert.equal(M12_STEP_IDS.at(-1), 'cleanup')
})

test('the support constants name the frozen M12 surface', () => {
  assert.equal(M12_E2E_EVIDENCE_RELATIVE, '.dsh-cowork/e2e/M12_E2E.json')
  assert.equal(M12_E2E_RUN_PATH, '/dsh-cowork/e2e/m12/run')
  assert.equal(M12_E2E_STATUS_PATH, '/dsh-cowork/e2e/m12/status')
  assert.equal(M12_E2E_STEP_TIMEOUT_MS, 180_000)
  assert.equal(M12_E2E_POLL_MS, 500)
  assert.equal(M12_E2E_SHORT_IDLE_MS, 500)
  assert.equal(M12_E2E_SHORT_RESOLVE_MS, 1_000)
  assert.equal(M12_E2E_WORK_FILE, 'm12-e2e.txt')
  assert.equal(M12_E2E_WORK_CONTENT, 'M12-E2E-WORK')
  assert.equal(MASTER_PRESET_ID, 'cowork-master')
  assert.equal(TOPIC_PRESET_ID, 'cowork-topic')
  assert.equal(REVIEWER_PRESET_ID, 'cowork-reviewer')
  assert.equal(ROUTE_TOOL, 'cowork_route')
  assert.equal(WORK_ITEM_TOOL, 'cowork_work_item_create')
  assert.equal(REVIEW_REQUEST_TOOL, 'cowork_review_request')
  assert.equal(REVIEW_VERDICT_TOOL, 'cowork_review_verdict')
  assert.equal(MERGE_TOOL, 'cowork_checkout_merge')
  assert.deepEqual(M12_EXPECTED_ACTIVITY_TYPES, [
    'topic-created',
    'route-created',
    'work-item-created',
    'review-requested',
    'review-verdict',
    'work-item-merged',
    'status-changed',
    'topic-archived',
    'topic-reopened',
  ])
})

// ---------------------------------------------------------------------------
// prompts: deterministic instructions for real sessions
// ---------------------------------------------------------------------------

test('the init and route prompts carry the tool and the wait brief', () => {
  assert.equal(buildProjectInitPrompt().includes('cowork_project_init'), true)
  const route = buildRoutePrompt()
  assert.equal(route.includes(ROUTE_TOOL), true)
  assert.equal(route.includes(M12_E2E_TOPIC_INTENT), true)
  assert.equal(route.includes('do not start any work'), true)
  assert.equal(route.includes('Reply DONE.'), true)
  const resolved = buildResolvedRoutePrompt('session-old')
  assert.equal(resolved.includes('"topicId": "session-old"'), true)
  assert.match(resolved, /resolved/)
})

test('the work item and commit prompts stay inside the isolated clone', () => {
  assert.equal(buildWorkItemPrompt().includes(WORK_ITEM_TOOL), true)
  const commit = buildCommitPrompt({
    checkoutPath: '/tmp/fixture/.dsh-cowork/workitems/wi-1',
    fileName: M12_E2E_WORK_FILE,
    content: M12_E2E_WORK_CONTENT,
    message: 'feat: add the M12 E2E work item commit',
  })
  assert.equal(commit.includes('/tmp/fixture/.dsh-cowork/workitems/wi-1'), true)
  assert.equal(commit.includes(`${M12_E2E_WORK_CONTENT}\\n`), true)
  assert.match(commit, /git add m12-e2e\.txt/)
  assert.match(commit, /git commit -m/)
})

test('the review request prompt carries the whole reviewed range', () => {
  const prompt = buildReviewRequestPrompt({
    workItemId: 'wi-1',
    checkoutPath: '/tmp/fixture/.dsh-cowork/workitems/wi-1',
    baseCommit: 'a'.repeat(40),
    headCommit: 'b'.repeat(40),
    fileName: M12_E2E_WORK_FILE,
    purpose: 'Confirm the work item commit.',
  })
  assert.equal(prompt.includes(REVIEW_REQUEST_TOOL), true)
  assert.equal(prompt.includes('"workItemId": "wi-1"'), true)
  assert.equal(prompt.includes('"baseCommit": "aaaa'), true)
  assert.equal(prompt.includes('"headCommit": "bbbb'), true)
  assert.equal(prompt.includes('"changedPaths"'), true)
  assert.equal(prompt.includes(M12_E2E_WORK_FILE), true)
  assert.equal(prompt.includes('"verification"'), true)
})

test('the reviewer prompt runs the verification and keeps the verdict bound', () => {
  const prompt = buildReviewerVerdictPrompt({
    requestId: 'request-1',
    workItemId: 'wi-1',
    checkoutPath: '/tmp/fixture/.dsh-cowork/workitems/wi-1',
    branch: 'cowork/wi-1',
    fileName: M12_E2E_WORK_FILE,
  })
  assert.equal(prompt.includes(REVIEW_VERDICT_TOOL), true)
  assert.equal(prompt.includes('"requestId": "request-1"'), true)
  assert.equal(prompt.includes('"verdict": "pass"'), true)
  assert.equal(prompt.includes(M12_E2E_REVIEW_SUMMARY), true)
  assert.equal(prompt.includes('"findings": []'), true)
  assert.match(prompt, /test -f m12-e2e\.txt/)
  assert.match(prompt, /replace it with the one below/)
  assert.match(prompt, /never modify an implementation file/)
})

test('the handoff and merge prompts pin status done and the work item', () => {
  const handoff = buildHandoffPrompt({ fileName: M12_E2E_WORK_FILE })
  assert.equal(handoff.includes('cowork_handoff'), true)
  assert.equal(handoff.includes('"status": "done"'), true)
  assert.equal(handoff.includes(M12_E2E_HANDOFF_SUMMARY), true)
  assert.equal(handoff.includes('"verification"'), true)
  const merge = buildMergePrompt('wi-1')
  assert.equal(merge.includes(MERGE_TOOL), true)
  assert.equal(merge.includes('"workItemId": "wi-1"'), true)
  assert.match(merge, /Do not touch main/)
})

// ---------------------------------------------------------------------------
// run shape, evidence shape, fail-fast, cleanup
// ---------------------------------------------------------------------------

test('a run starts with every step pending and an empty evidence frame', () => {
  const run = createRun('m12-test', CREATED_AT)
  assert.equal(run.state, 'running')
  assert.equal(run.runId, 'm12-test')
  assert.equal(run.steps.length, M12_STEP_IDS.length)
  assert.deepEqual(run.steps.map((step) => step.status), M12_STEP_IDS.map(() => 'pending'))
  for (const step of run.steps) {
    assert.deepEqual(step.evidence.assertions, [])
    assert.deepEqual(step.evidence.prompts, [])
    assert.deepEqual(step.evidence.observations, {})
    assert.equal(step.evidence.startedAt, null)
  }
  assert.equal(run.artifactIdentity, null)
  assert.deepEqual(run.cleanup, {})
})

test('the status view and the evidence document carry the frozen fields', () => {
  const run = createRun('m12-test', CREATED_AT)
  run.artifactIdentity = artifactIdentityFrom({
    repoPath: '/plugin',
    baseRef: '1b0801d',
    pluginVersion: '0.2.0',
    facts: {
      head: gitOk('c'.repeat(40)),
      base: gitOk('d'.repeat(40)),
      diff: gitOk('diff --git a/x b/x\n'),
      status: gitOk(''),
    },
  })
  run.cleanup = buildCleanupReport({
    sessions: [{ role: 'master', sessionId: 's1', archived: true, error: null }],
    workspaceId: 'w1',
    workspaceDeleted: true,
    workspaceError: null,
    fixturePath: '/tmp/fixture',
    keepFixture: false,
    fixtureRemoved: true,
    errors: [],
  })

  const view = runStatusView(run, '/plugin/.dsh-cowork/e2e/M12_E2E.json')
  assert.equal(view.runId, 'm12-test')
  assert.equal(view.state, 'running')
  assert.equal(view.steps.length, 17)
  assert.equal(view.evidenceFile, '/plugin/.dsh-cowork/e2e/M12_E2E.json')
  assert.equal('error' in view, false)

  const document = buildEvidenceDocument(
    { plugin: '@dsh-external/dsh-cowork', pluginVersion: '0.2.0', repoPath: '/plugin' },
    run,
    '/plugin/.dsh-cowork/e2e/M12_E2E.json',
    { path: '/tmp/fixture', keep: false },
  )
  assert.equal(document.version, 1)
  assert.equal(document.runId, 'm12-test')
  assert.equal(document.state, 'running')
  assert.equal(document.endedAt, null)
  assert.equal(document.host.plugin, '@dsh-external/dsh-cowork')
  assert.equal(document.host.repoPath, '/plugin')
  assert.equal(document.fixture.path, '/tmp/fixture')
  assert.equal(document.artifactIdentity.pluginVersion, '0.2.0')
  assert.equal(document.artifactIdentity.head, 'c'.repeat(40))
  assert.equal(document.artifactIdentity.diffSha256.length, 64)
  assert.equal(document.artifactIdentity.gitAvailable, true)
  assert.deepEqual(document.cleanup.sessions, [{ role: 'master', sessionId: 's1', archived: true, error: null }])
  assert.equal(document.steps.length, 17)
  assert.equal('error' in document, false)

  run.state = 'failed'
  run.error = 'step merge: boom'
  run.endedAt = '2026-11-08T09:05:00.000Z'
  const failed = buildEvidenceDocument(
    { plugin: 'p', pluginVersion: '0.2.0', repoPath: '/plugin' },
    run,
    '/e.json',
    { path: '/tmp/fixture', keep: false },
  )
  assert.equal(failed.state, 'failed')
  assert.equal(failed.error, 'step merge: boom')
  assert.equal(failed.endedAt, '2026-11-08T09:05:00.000Z')
})

test('a step error maps to the terminal failed state with its step id', () => {
  assert.deepEqual(stepFailureState('review-verdict', new Error('boom')), {
    state: 'failed',
    error: 'step review-verdict: boom',
  })
  assert.deepEqual(stepFailureState('cleanup', 'plain text'), {
    state: 'failed',
    error: 'step cleanup: plain text',
  })
})

test('a terminal run deletes the fixture unless keep mode asked for it', () => {
  assert.equal(shouldRemoveFixture('done', false), true)
  assert.equal(shouldRemoveFixture('failed', false), true)
  assert.equal(shouldRemoveFixture('running', false), false)
  assert.equal(shouldRemoveFixture('done', true), false)
  assert.equal(shouldRemoveFixture('failed', true), false)
})

test('the driver base persists evidence before deleting the fixture', () => {
  const source = readFileSync(driverBasePath, 'utf8')
  const finallyAt = source.indexOf('} finally {')
  assert.notEqual(finallyAt, -1, 'execute() must keep a finally block')
  const end = source.indexOf('this.releaseSessions()', finallyAt)
  assert.ok(end > finallyAt, 'the finally block must still release sessions')
  const block = source.slice(finallyAt, end)

  const persistAt = block.indexOf('await this.persist(run)')
  const deleteAt = block.indexOf('this.removeFixture(run)')
  assert.notEqual(persistAt, -1, 'the finally must persist the evidence')
  assert.notEqual(deleteAt, -1, 'the finally must delete the fixture')
  assert.ok(persistAt < deleteAt, 'evidence must be persisted before the fixture is deleted')
  assert.ok(block.indexOf('safeArchiveSessions(') < persistAt, 'archive first, then persist')
  assert.match(block, /shouldRemoveFixture\(run\.state, this\.keepFixture\)/, 'the delete is guarded by the pure helper')
})

test('the runner exposes start, resolve, attachEvents, dispose, and a fail-fast loop', () => {
  const source = driverBaseSource()

  for (const member of ['start(options', 'resolve(runId', 'attachEvents():', 'dispose():', 'private async execute(', 'protected async runStep(']) {
    assert.equal(source.includes(member), true, `driver is missing ${member}`)
  }
  assert.match(source, /still running/)
  // A failed step sets the terminal state and breaks the loop; no later step runs.
  assert.match(source, /run\.state = failure\.state\n\s+run\.error = failure\.error\n\s+break/)
  assert.equal(source.includes('safeArchiveSessions'), true)
  assert.equal(source.includes('archiveOne'), true)
  assert.equal(source.includes('workspaceDeleted'), true)
})

test('the cleanup plan names every session role the chain creates', () => {
  const source = readFileSync(driverBasePath, 'utf8')
  for (const role of ['master', 'topic', 'reviewer', 'topic-resolved-match']) {
    assert.equal(source.includes(`['${role}'`), true, `cleanup is missing the ${role} role`)
  }
})

// ---------------------------------------------------------------------------
// pure planning rules
// ---------------------------------------------------------------------------

const pendingRequest = { status: 'pending' }
const passRequest = { status: 'pass' }

test('planReviewVerdict steers a pending request, adopts pass, and fails otherwise', () => {
  assert.deepEqual(planReviewVerdict(null, 'pass'), {
    action: 'steer',
    mode: 'steer',
    reason: 'the review request file is not visible yet',
  })
  assert.deepEqual(planReviewVerdict(pendingRequest, 'pass'), {
    action: 'steer',
    mode: 'steer',
    reason: 'the reviewer has not produced a verdict yet',
  })
  assert.deepEqual(planReviewVerdict(passRequest, 'pass'), {
    action: 'skip',
    mode: null,
    reason: 'the reviewer already produced pass',
  })
  const fail = planReviewVerdict({ status: 'reject' }, 'pass')
  assert.equal(fail.action, 'fail')
  assert.equal(fail.mode, null)
  assert.match(fail.reason, /reject/)
})

test('planRequestReview adopts a pending request and fails a repeated round', () => {
  assert.deepEqual(planRequestReview([], 'wi-1'), {
    action: 'steer',
    reason: 'the topic must create the review request',
  })
  assert.deepEqual(planRequestReview([{ status: 'pending', workItemId: 'wi-1' }], 'wi-1'), {
    action: 'adopt',
    reason: 'a pending review request for this work item already exists',
  })
  // Another work item's request does not block this one.
  assert.equal(planRequestReview([{ status: 'pending', workItemId: 'wi-2' }], 'wi-1').action, 'steer')
  assert.equal(planRequestReview([{ status: 'pass', workItemId: 'wi-1' }], 'wi-1').action, 'fail')
})

test('planMergePrompt skips a reached target and steers otherwise', () => {
  assert.deepEqual(planMergePrompt(true), {
    action: 'skip',
    reason: 'merge target state was already reached; passed idempotently',
  })
  assert.deepEqual(planMergePrompt(false), {
    action: 'steer',
    reason: 'the merge instruction is steered into the master turn',
  })
})

test('the M12 thresholds are the short E2E ones', () => {
  assert.equal(shortThresholdsProblem(500, 1_000), null)
  assert.match(String(shortThresholdsProblem(2 * 60 * 60 * 1_000, 3 * 24 * 60 * 60 * 1_000)), /idleAfterMs must be 500/)
  assert.match(String(shortThresholdsProblem(500, 3 * 24 * 60 * 60 * 1_000)), /resolveAfterMs must be 1000/)
})

test('the fixture must live outside the plugin repository', () => {
  assert.equal(fixturePathProblem('/plugin', '/tmp/m12-fixture'), null)
  assert.match(String(fixturePathProblem('/plugin', '/plugin')), /must not be the plugin repository/)
  assert.match(String(fixturePathProblem('/plugin', '/plugin/.dsh-cowork/e2e/m12')), /must live outside/)
})

test('a terminal topic status is not live', () => {
  assert.equal(isLiveTopicStatus('active'), true)
  assert.equal(isLiveTopicStatus('idle'), true)
  assert.equal(isLiveTopicStatus('resolved'), false)
  assert.equal(isLiveTopicStatus(undefined), false)
})

test('missingActivityTypes names exactly the absent chain events', () => {
  const events = M12_EXPECTED_ACTIVITY_TYPES.map((type) => ({ type }))
  assert.deepEqual(missingActivityTypes(events), [])
  assert.deepEqual(missingActivityTypes(events.filter((event) => event.type !== 'topic-reopened')), ['topic-reopened'])
  assert.deepEqual(missingActivityTypes([{ type: 'error' }]), [...M12_EXPECTED_ACTIVITY_TYPES])
})

// ---------------------------------------------------------------------------
// artifact identity
// ---------------------------------------------------------------------------

test('artifactIdentityFrom records the HEAD, the diff digest, and the status', () => {
  const identity = artifactIdentityFrom({
    repoPath: '/plugin',
    baseRef: 'origin/main',
    pluginVersion: '0.2.0',
    facts: {
      head: gitOk('1'.repeat(40)),
      base: gitOk('2'.repeat(40)),
      diff: gitOk('diff --git a/src/x b/src/x\n'),
      status: gitOk(' M src/x\n'),
    },
  })
  assert.equal(identity.head, '1'.repeat(40))
  assert.equal(identity.baseRef, 'origin/main')
  assert.equal(identity.baseCommit, '2'.repeat(40))
  assert.equal(identity.diffCommand, 'git diff origin/main..HEAD | shasum -a 256')
  assert.equal(identity.diffSha256, createHash('sha256').update('diff --git a/src/x b/src/x\n').digest('hex'))
  assert.equal(identity.statusPorcelain, ' M src/x\n')
  assert.equal(identity.gitAvailable, true)
  assert.equal(identity.emptyRange, false)
  assert.equal('error' in identity, false)
})

test('artifactIdentityFrom degrades when the checkout is not a git repository', () => {
  const identity = artifactIdentityFrom({
    repoPath: '/packaged',
    baseRef: 'HEAD',
    pluginVersion: '0.2.0',
    facts: {
      head: gitFail('fatal: not a git repository'),
      base: gitFail('fatal: not a git repository'),
      diff: gitFail('fatal: not a git repository'),
      status: gitFail('fatal: not a git repository'),
    },
  })
  assert.equal(identity.gitAvailable, false)
  assert.equal(identity.head, null)
  assert.equal(identity.diffSha256, null)
  assert.equal(identity.statusPorcelain, null)
  assert.match(String(identity.error), /not a git repository/)
})

test('an empty diff range is labelled, not hidden', () => {
  const sha = '3'.repeat(40)
  const identity = artifactIdentityFrom({
    repoPath: '/plugin',
    baseRef: 'HEAD',
    pluginVersion: '0.2.0',
    facts: { head: gitOk(`${sha}\n`), base: gitOk(`${sha}\n`), diff: gitOk(''), status: gitOk('') },
  })
  assert.equal(identity.emptyRange, true)
  assert.equal(identity.diffSha256.length, 64)
})

// ---------------------------------------------------------------------------
// durable file readers (the store schema stays the authority)
// ---------------------------------------------------------------------------

test('parseProjectIndexV2 accepts a valid v2 document and refuses anything else', () => {
  const parsed = parseProjectIndexV2(indexV2())
  assert.equal(parsed?.version, 2)
  assert.equal(parsed?.topics.length, 1)
  assert.equal(parsed?.topics[0].topicId, 'session-topic')
  assert.equal(parseProjectIndexV2('{"version":1,"threads":[]}'), undefined)
  assert.equal(parseProjectIndexV2('not json'), undefined)
  assert.equal(parseProjectIndexV2(indexV2([{ ...topicV2(), status: 'done' }])), undefined)
})

test('parseActivityFile keeps valid rows and counts skipped lines', () => {
  const event = {
    eventId: 'event-1',
    time: CREATED_AT,
    type: 'topic-created',
    topicId: 'session-topic',
    summary: 'created a topic',
    details: {},
  }
  const text = `${JSON.stringify(event)}\nnot json\n${JSON.stringify({ ...event, type: 'invented' })}\n`
  const parsed = parseActivityFile(text)
  assert.equal(parsed.events.length, 1)
  assert.equal(parsed.events[0].type, 'topic-created')
  assert.equal(parsed.skippedLines, 2)
})

test('parseInboxFile refuses a partially invalid inbox', () => {
  const item = {
    id: 'inbox-1',
    time: CREATED_AT,
    topicId: 'session-topic',
    kind: 'merge-needed',
    summary: 'merge work item wi-1',
    deliveredAt: CREATED_AT,
  }
  assert.deepEqual(parseInboxFile(JSON.stringify([item])), [item])
  assert.deepEqual(parseInboxFile(JSON.stringify([{ ...item, kind: 'invented' }])), [])
  assert.deepEqual(parseInboxFile('not json'), [])
})

test('reviewRequestView projects the fields the chain asserts on', () => {
  const view = reviewRequestView('/repo/.dsh-cowork/reviews/topic-request.json', {
    requestId: 'request-1',
    status: 'pending',
    topicId: 'session-topic',
    workItemId: 'wi-1',
    baseCommit: 'a'.repeat(40),
    headCommit: 'b'.repeat(40),
    path: '/tmp/fixture/.dsh-cowork/workitems/wi-1',
    branch: 'cowork/wi-1',
    changedPaths: [M12_E2E_WORK_FILE],
    verification: [{ command: 'test -f m12-e2e.txt', exitCode: 0, evidence: 'exists' }],
    reviewerSessionId: 'session-reviewer',
    requestedAt: CREATED_AT,
    reviewedAt: null,
    summary: null,
    findings: [],
  })
  assert.equal(view.requestId, 'request-1')
  assert.equal(view.status, 'pending')
  assert.equal(view.workItemId, 'wi-1')
  assert.equal(view.branch, 'cowork/wi-1')
  assert.deepEqual(view.changedPaths, [M12_E2E_WORK_FILE])
  assert.equal(view.verificationCount, 1)
  assert.equal(view.findingCount, 0)
  assert.equal(view.reviewerSessionId, 'session-reviewer')
})

// ---------------------------------------------------------------------------
// file budget and import boundaries
// ---------------------------------------------------------------------------

test('every M12 driver file stays within the 48 KiB split budget', () => {
  for (const path of M12_SOURCE_PATHS) {
    const size = statSync(path).size
    assert.ok(size > 0, path)
    assert.ok(size <= FILE_BUDGET_BYTES, `${path} is ${size} bytes, above ${FILE_BUDGET_BYTES}`)
    assert.ok(size < 51_200, `${path} is ${size} bytes, above the 50 KiB read limit`)
  }
})

test('the support barrel only re-exports the split modules', () => {
  const code = readFileSync(supportPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && !/^\s*(\/\*\*|\*|\/\/)/.test(line))
  assert.deepEqual(code, [
    "export * from './m12-e2e-contract.js'",
    "export * from './m12-e2e-prompts.js'",
    "export * from './m12-e2e-evidence.js'",
  ])
})

test('the split modules import only built-ins and pure plugin modules', () => {
  const allowedLocal = new Set([
    './m12-e2e-contract.js',
    './review-request.js',
    './platform/presets.js',
    './store/schema.js',
  ])
  for (const path of supportModulePaths) {
    const valueImports = [...readFileSync(path, 'utf8').matchAll(/^import\s+(?!type\b)[\s\S]*?from\s+'([^']+)'/gm)]
      .map((match) => match[1])
    for (const specifier of valueImports) {
      const allowed = specifier.startsWith('node:') || allowedLocal.has(specifier)
      assert.equal(allowed, true, `unexpected runtime import in ${path}: ${specifier}`)
    }
    // No host, store I/O layer, panel API, runner, or driver: the support stays testable.
    for (const forbidden of ['./m12-e2e.js', './m12-e2e-driver.js', './api.js', './store.js', './index.js']) {
      assert.equal(valueImports.includes(forbidden), false, `${path} must not import ${forbidden}`)
    }
  }
})

test('the driver imports only its support barrel and the runner base', () => {
  const driver = readFileSync(driverPath, 'utf8')
  const allowed = new Set(['./m12-e2e-support.js', './m12-e2e-driver.js'])
  for (const line of driver.split('\n').filter((entry) => /^import .* from '\.\//.test(entry))) {
    const specifier = line.match(/from '([^']+)'/)?.[1]
    assert.equal(allowed.has(specifier), true, `driver imports an unexpected local module: ${line}`)
  }
  assert.match(driver, /M12_E2E_RUN_PATH/)
  assert.match(driver, /M12_E2E_STATUS_PATH/)
})

test('the driver base module keeps the lifecycle and imports only the support barrel', () => {
  const runner = readFileSync(driverBasePath, 'utf8')
  for (const line of runner.split('\n').filter((entry) => /^import .* from '\.\//.test(entry))) {
    assert.match(line, /from '\.\/m12-e2e-support\.js'/, `runner imports another local module: ${line}`)
  }
  assert.match(runner, /export abstract class M12E2ERunnerBase/)
})
