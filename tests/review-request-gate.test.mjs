import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import './support/ts-hook.mjs'
// `src/review-request.ts` imports its siblings with the build's `.js`
// specifiers, which Node's type stripping does not retry as `.ts`; this test
// installs the same small resolve hook tests/presets.test.mjs uses.
import { withRepo } from './support/inbox-fixtures.mjs'

const {
  REVIEW_BRIEF_MAX_CHARS,
  REVIEW_CHANGED_PATHS_MAX,
  REVIEW_EXTRA_MAX_BYTES,
  REVIEW_EXTRA_MAX_DEPTH,
  REVIEW_EXTRA_MAX_KEYS,
  REVIEW_NOTES_MAX_CHARS,
  REVIEW_PATH_MAX_CHARS,
  REVIEW_PURPOSE_MAX_CHARS,
  REVIEW_REQUEST_ID_PATTERN,
  REVIEW_SUMMARY_MAX_CHARS,
  REVIEW_VERIFICATION_MAX_ROWS,
  buildReviewBrief,
  buildReviewRequestRecord,
  checkPreviousRequest,
  deriveReviewOutcome,
  isValidReviewRequestId,
  mergeGate,
  parseReviewRequestRecord,
  reviewRequestFileName,
  reviewRequestFilePath,
  reviewRequestRecordProblems,
  serializeReviewRequestRecord,
  validateReviewRequestInput,
} = await import('../src/review-request.ts')
const { ERROR_CODES, M10_ERROR_CODES } = await import('../src/platform/tool-model.ts')
const { REVIEWER_PRESET_ID: PRESETS_REVIEWER_ID } = await import('../src/platform/presets.ts')
const schema = await import('../src/store/schema.ts')

/**
 * Contract tests for the pure M10 review-request model (`src/review-request.ts`):
 * field validation, the request record on disk, the previous-request chain, the
 * verdict outcome, the merge gate, and the reviewer brief. Everything here is
 * in memory: no `.dsh-cowork/`, no git, no clock.
 */

const REPO = '/repo/project'
const WORK_ITEM_PATH = '/repo/project/.dsh-cowork/workitems/wi-1'
const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const REQUESTED_AT = new Date('2026-11-08T00:00:00.000Z')
const REVIEWED_AT = '2026-11-08T01:00:00.000Z'

/** A complete valid request input; overrides replace one field at a time. */
const requestInput = (overrides = {}) => ({
  purpose: 'review the work item change',
  baseCommit: BASE,
  headCommit: HEAD,
  path: WORK_ITEM_PATH,
  verification: [{ command: 'node --test tests/review-request.test.mjs', exitCode: 0, evidence: '6 pass' }],
  notes: 'ready for the independent review',
  extra: { requestTag: 'wi-1' },
  previousRequestId: null,
  ...overrides,
})

/** The trusted scope the tool derives from the index and git, never the model. */
const requestScope = (overrides = {}) => ({
  topicId: 'session-topic',
  workItemId: 'wi-1',
  repoPath: REPO,
  workItemPath: WORK_ITEM_PATH,
  branch: 'cowork/wi-1',
  changedPaths: ['src/review-request.ts', 'tests/review-request.test.mjs'],
  ...overrides,
})

/** Validate a request input against the default scope. */
const validate = (input = requestInput(), scope = requestScope()) =>
  validateReviewRequestInput(input, scope)

/** The rejected field names of an invalid input. */
function refusedFields(input, scope = requestScope()) {
  const result = validate(input, scope)
  assert.equal(result.ok, false, 'the input was expected to be rejected')
  return result.errors.map((error) => error.field)
}

/** One nested object `levels` containers deep. */
function nested(levels) {
  let value = 'leaf'
  for (let index = 0; index < levels; index += 1) value = { next: value }
  return value
}

/** The validated draft every record fixture starts from. */
function draft() {
  const result = validate()
  assert.equal(result.ok, true, 'the default request fixture must validate')
  return result.value
}

/** A pending record as the review-request tool writes it. */
function pendingRecord(overrides = {}) {
  return buildReviewRequestRecord(draft(), {
    requestId: 'req-1',
    reviewerSessionId: 'session-reviewer',
    requestedAt: REQUESTED_AT,
    ...overrides,
  })
}

/** A terminal (answered) version of the pending record. */
function answeredRecord(overrides = {}) {
  return {
    ...pendingRecord(),
    status: 'pass',
    reviewedAt: REVIEWED_AT,
    summary: 'the change holds up',
    findings: [],
    reviewVerification: [{ command: 'node --test tests/review-request.test.mjs', exitCode: 0, evidence: 'pass' }],
    ...overrides,
  }
}


const gateInput = (overrides = {}) => ({
  request: answeredRecord(),
  headCommit: HEAD,
  baseIsAncestor: true,
  workItemStatus: 'reviewing',
  workTreeClean: true,
  ...overrides,
})

/**
 * Gateway tests for the review request: the merge gate, the reviewer brief, the
 * `cowork_review_request` tool against real files and a fake host, and the
 * legacy thread merge gate. The record model lives in
 * `review-request-model.test.mjs`.
 */

// ---------------------------------------------------------------------------
// merge gate
// ---------------------------------------------------------------------------


test('the merge gate accepts exactly a passed review of the current head', () => {
  assert.deepEqual(mergeGate(gateInput()), { ok: true })
})

test('each merge-gate refusal carries its stable code and a message', () => {
  const cases = [
    ['no request', gateInput({ request: null }), M10_ERROR_CODES.reviewRequestNotFound],
    ['not passed', gateInput({ request: answeredRecord({ status: 'needs_revision', findings: [{ id: 'F1', severity: 'high', problem: 'p', requiredFix: 'f' }] }) }), ERROR_CODES.reviewNotPassed],
    ['another head', gateInput({ headCommit: 'c'.repeat(40) }), M10_ERROR_CODES.checkoutHeadMismatch],
    ['unknown head', gateInput({ headCommit: null }), M10_ERROR_CODES.checkoutHeadMismatch],
    ['base not an ancestor', gateInput({ baseIsAncestor: false }), M10_ERROR_CODES.reviewBaseNotAncestor],
    ['work item still active', gateInput({ workItemStatus: 'active' }), M10_ERROR_CODES.workItemNotReady],
    ['work item already merged', gateInput({ workItemStatus: 'merged' }), M10_ERROR_CODES.workItemNotReady],
    ['unknown work item', gateInput({ workItemStatus: null }), M10_ERROR_CODES.workItemNotFound],
    ['dirty checkout', gateInput({ workTreeClean: false }), M10_ERROR_CODES.reviewDirtyWorktree],
  ]
  for (const [label, input, code] of cases) {
    const gate = mergeGate(input)
    assert.equal(gate.ok, false, `${label} must be refused`)
    assert.equal(gate.failure.error.code, code, label)
    assert.ok(gate.failure.error.message.length > 0, `${label} must explain itself`)
  }

  // A shared-tree request has no work item, so there is nothing to merge.
  const shared = mergeGate(gateInput({ request: answeredRecord({ workItemId: null }), workItemStatus: null }))
  assert.equal(shared.ok, false)
  assert.equal(shared.failure.error.code, M10_ERROR_CODES.workItemNotFound)
})

// ---------------------------------------------------------------------------
// reviewer brief
// ---------------------------------------------------------------------------

test('the brief carries the request scope, the previous round, and the call to make', () => {
  const previous = answeredRecord({
    requestId: 'req-0',
    status: 'needs_revision',
    summary: 'the merge gate was skipped',
    findings: [
      {
        id: 'F1',
        severity: 'high',
        problem: 'the merge gate is skipped',
        requiredFix: 'call mergeGate before merging',
        file: 'src/review-request.ts',
        line: 42,
      },
    ],
  })
  const brief = buildReviewBrief({ request: pendingRecord(), previous })

  for (const expected of [
    'req-1',
    'review the work item change',
    BASE,
    HEAD,
    WORK_ITEM_PATH,
    'cowork/wi-1',
    'src/review-request.ts',
    'node --test tests/review-request.test.mjs',
    'req-0',
    'needs_revision',
    'the merge gate was skipped',
    'F1',
    'call mergeGate before merging',
    'cowork_review_verdict',
    'Read-only',
  ]) {
    assert.ok(brief.includes(expected), `the brief must mention ${expected}:\n${brief}`)
  }
  assert.ok(!brief.toLowerCase().includes('handoff'), 'the brief must not carry handoff text')
  assert.ok(brief.length <= REVIEW_BRIEF_MAX_CHARS)
})

test('the brief stays under its ceiling for a maximal request', () => {
  const huge = {
    ...answeredRecord(),
    purpose: 'p'.repeat(REVIEW_PURPOSE_MAX_CHARS),
    changedPaths: Array.from({ length: REVIEW_CHANGED_PATHS_MAX }, (_, index) => `${'d'.repeat(900)}/file-${index}.ts`),
    verification: Array.from({ length: REVIEW_VERIFICATION_MAX_ROWS }, () => ({
      command: 'c'.repeat(1900),
      exitCode: 0,
      evidence: 'e'.repeat(1900),
    })),
    findings: Array.from({ length: 50 }, (_, index) => ({
      id: `F${index}`,
      severity: 'low',
      problem: 'x'.repeat(1900),
      requiredFix: 'y'.repeat(1900),
    })),
  }
  const brief = buildReviewBrief({ request: huge, previous: huge })
  assert.ok(brief.length <= REVIEW_BRIEF_MAX_CHARS, `brief is ${brief.length} chars`)
  assert.ok(brief.includes('req-1'), 'the request id survives truncation')
  assert.ok(brief.includes('cowork_review_verdict'), 'the call to make survives truncation')
})

test('the brief without a previous round does not invent one', () => {
  const brief = buildReviewBrief({ request: pendingRecord() })
  assert.ok(!brief.includes('Previous review request'), brief)
  assert.ok(brief.includes('req-1'))
})

// ---------------------------------------------------------------------------
// the request tool, its file layer, and the deterministic pre-checks
// ---------------------------------------------------------------------------

const { registerReviewTools } = await import('../src/review-tools.ts')
const { ProjectStore } = await import('../src/store/project-store.ts')
const { failure: toolFailure, readCaller } = await import('../src/platform/tool-model.ts')

const CLOCK = () => REQUESTED_AT

/** A tool registry that keeps every definition the assembly registers. */
function fakeHost() {
  const registry = new Map()
  return {
    registry,
    tools: {
      register(definition) {
        registry.set(definition.name, definition)
        return () => registry.delete(definition.name)
      },
    },
  }
}

/** The structured execution identity one tool call receives. */
function fakeExec(sessionId, cwd) {
  return { agent: { id: sessionId, session: { header: { cwd } } } }
}

/**
 * A git runner that answers the request pre-checks by their arguments. Every
 * option is the answer to one question, so a test changes exactly one fact.
 */
function fakeGit(options = {}) {
  const calls = []
  const runGit = async (args, cwd) => {
    calls.push({ args: [...args], cwd })
    if (options.fail !== undefined) return { code: 1, stdout: '', stderr: options.fail }
    if (args[1] === '--verify') {
      const ref = String(args[3]).replace('^{commit}', '')
      if (options.unknownRefs?.includes(ref)) return { code: 1, stdout: '', stderr: '' }
      return { code: 0, stdout: `${ref}\n`, stderr: '' }
    }
    if (args[0] === 'merge-base') return { code: options.ancestor === false ? 1 : 0, stdout: '', stderr: '' }
    if (args[0] === 'status') return { code: 0, stdout: options.dirty === true ? ' M src/one.ts\n' : '', stderr: '' }
    if (args[0] === 'diff') {
      const paths = options.changedPaths ?? ['src/review-request.ts']
      return { code: 0, stdout: paths.map((path) => `${path}\n`).join(''), stderr: '' }
    }
    if (args[1] === '--abbrev-ref') return { code: 0, stdout: `${options.branch ?? 'cowork/wi-1'}\n`, stderr: '' }
    throw new Error(`unexpected git call: git ${args.join(' ')}`)
  }
  return { calls, runGit }
}

/** A session slice that records reviewer creation, prompts, and archives. */
function fakeSlice(options = {}) {
  const calls = []
  return {
    calls,
    async createReviewSession(request) {
      calls.push({ type: 'create', request })
      return options.createResult ?? { sessionId: 'session-reviewer', workspaceId: 'workspace-1', title: 'cowork review: t' }
    },
    async promptSession(sessionId, text) {
      calls.push({ type: 'prompt', sessionId, text })
      if (options.throwFor === sessionId) throw new Error(`${sessionId} prompt failed`)
      return { accepted: options.rejectFor === sessionId ? false : true, requestId: 'prompt-1' }
    },
    async archiveSession(sessionId, archiveOptions) {
      calls.push({ type: 'archive', sessionId, options: archiveOptions })
      if (options.archiveError !== undefined) throw options.archiveError
    },
  }
}

/** Register the review tools against a real store and fake host ports. */
function setup(repoPath, options = {}) {
  const store = new ProjectStore({ repoPath, clock: CLOCK })
  const slice = options.slice ?? fakeSlice()
  const git = options.git ?? fakeGit()
  const host = fakeHost()
  registerReviewTools(host, {
    callerOf(exec) {
      return readCaller(exec) ?? toolFailure('exec/agent-unavailable', 'no caller identity')
    },
    async openProject() {
      return { repoPath, store, slice, index: await store.readIndex() }
    },
    mapError(error) {
      return toolFailure('tool/internal', error instanceof Error ? error.message : String(error))
    },
    toJson(value) {
      return JSON.parse(JSON.stringify(value))
    },
    renderJson() {
      return []
    },
    nowOf() {
      return CLOCK()
    },
    threadView(thread) {
      return thread
    },
    isFailure(value) {
      return typeof value === 'object' && value !== null && value.ok === false
    },
    git: git.runGit,
  })
  return { store, slice, git, host, request: host.registry.get('cowork_review_request') }
}

/** A canonical v2 topic for the seeded project. */
function topicFixture(repoPath, overrides = {}) {
  const stamp = REQUESTED_AT.toISOString()
  return {
    topicId: 'session-topic',
    title: 'wire the review',
    status: 'active',
    awaitingReview: false,
    blocked: false,
    scope: 'review',
    ownedPaths: [],
    aliases: [],
    digest: '',
    cwd: repoPath,
    legacyCheckoutPath: null,
    createdAt: stamp,
    updatedAt: stamp,
    lastActiveAt: stamp,
    lastDeliveryConfirmedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    latestReviewRequestId: null,
    reviewStatus: null,
    reviewerSessionId: null,
    ...overrides,
  }
}

/** A canonical v2 work item under the seeded topic. */
function workItemFixture(repoPath, overrides = {}) {
  const stamp = REQUESTED_AT.toISOString()
  return {
    workItemId: 'wi-1',
    topicId: 'session-topic',
    path: join(repoPath, '.dsh-cowork', 'workitems', 'wi-1'),
    branch: 'cowork/wi-1',
    baseCommit: BASE,
    headCommit: BASE,
    status: 'active',
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  }
}

/** Seed the canonical index with one topic and an optional work item. */
async function seedReviewProject(store, repoPath, options = {}) {
  const topic = topicFixture(repoPath, options.topicOverrides ?? {})
  await store.initIndex('session-master')
  await store.mutateIndexDocument((document) => ({
    ...document,
    topics: [topic],
    workItems: options.workItem === undefined ? [] : [options.workItem],
  }))
  return topic
}

/** The canonical index as the tools see it. */
const canonical = (store) => store.readIndexDocument()

/** One request call input; the path default is the shared working tree. */
function toolRequest(repoPath, overrides = {}) {
  return {
    purpose: 'review the request model',
    baseCommit: BASE,
    headCommit: HEAD,
    path: repoPath,
    verification: [{ command: 'node --test tests/review-request.test.mjs', exitCode: 0, evidence: '28 pass' }],
    ...overrides,
  }
}

/** Run one request against a fresh repository and clean up afterwards. */

test('a shared-tree request writes the pending file, the index, and the brief', async () => {
  await withRepo(async (repoPath) => {
    const { store, slice, request } = setup(repoPath)
    await seedReviewProject(store, repoPath)

    const result = await request.execute(toolRequest(repoPath), fakeExec('session-topic', repoPath))

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.status, 'pending')
    assert.equal(result.topicId, 'session-topic')
    assert.equal(result.workItemId, null)
    assert.equal(result.path, repoPath)
    assert.equal(result.baseCommit, BASE)
    assert.equal(result.headCommit, HEAD)
    assert.deepEqual(result.changedPaths, ['src/review-request.ts'])

    // The request file is the model's file, named from its own identity.
    assert.equal(result.filePath, join(repoPath, '.dsh-cowork', 'reviews', `session-topic-${result.requestId}.json`))
    const stored = JSON.parse(await readFile(result.filePath, 'utf8'))
    assert.equal(stored.status, 'pending')
    assert.equal(stored.reviewerSessionId, 'session-reviewer')
    assert.equal(stored.reviewedAt, null)
    assert.equal(stored.summary, null)
    assert.equal(stored.previousRequestId, null)
    assert.equal(stored.requestedAt, REQUESTED_AT.toISOString())
    assert.equal(stored.branch, 'cowork/wi-1')
    assert.deepEqual(stored.changedPaths, ['src/review-request.ts'])
    assert.equal(parseReviewRequestRecord(JSON.stringify(stored)).ok, true)

    // The canonical index carries the review markers and no legacy pointer.
    const document = await canonical(store)
    const topic = document.topics[0]
    assert.equal(topic.awaitingReview, true)
    assert.equal(topic.reviewStatus, 'pending')
    assert.equal(topic.latestReviewRequestId, result.requestId)
    assert.equal(topic.reviewerSessionId, 'session-reviewer')
    assert.equal(topic.latestReviewPath, null)
    assert.equal(topic.reviewRequestedAt, null)
    assert.equal(topic.reviewedAt, null)

    // One reviewer session was created and briefed with the request scope.
    const created = slice.calls.filter((call) => call.type === 'create')
    assert.equal(created.length, 1)
    assert.equal(created[0].request.presetId, 'cowork-reviewer')
    const prompts = slice.calls.filter((call) => call.type === 'prompt')
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].sessionId, 'session-reviewer')
    assert.match(prompts[0].text, new RegExp(result.requestId))
    assert.match(prompts[0].text, /review the request model/)
    assert.match(prompts[0].text, /cowork_review_verdict/)

    // The activity stream records the request.
    const activity = await store.readActivity()
    assert.ok(activity.events.some((event) => event.type === 'review-requested'))
  })
})

test('a work-item request points at the checkout and marks the item reviewing', async () => {
  await withRepo(async (repoPath) => {
    const item = workItemFixture(repoPath)
    const { store, request } = setup(repoPath)
    await seedReviewProject(store, repoPath, { workItem: item })

    const result = await request.execute(
      toolRequest(repoPath, { path: item.path, workItemId: 'wi-1' }),
      fakeExec('session-topic', repoPath),
    )

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.workItemId, 'wi-1')
    assert.equal(result.path, item.path)
    const document = await canonical(store)
    assert.equal(document.workItems[0].status, 'reviewing')
    assert.equal(document.workItems[0].headCommit, HEAD)
  })
})

test('the master cannot request a review', async () => {
  await withRepo(async (repoPath) => {
    const { store, slice, request } = setup(repoPath)
    await seedReviewProject(store, repoPath)

    const result = await request.execute(toolRequest(repoPath), fakeExec('session-master', repoPath))

    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'role/forbidden')
    assert.equal(slice.calls.length, 0)
    const document = await canonical(store)
    assert.equal(document.topics[0].awaitingReview, false)
  })
})

test('every failed pre-check leaves no reviewer, no file, and no index change', async () => {
  const cases = [
    ['missing purpose', toolRequest('/repo', { purpose: '' }), {}, 'review/request-invalid'],
    ['base equals head', toolRequest('/repo', { headCommit: BASE }), {}, 'review/base-equals-head'],
    ['unknown commit', toolRequest('/repo'), { git: fakeGit({ unknownRefs: [BASE] }) }, 'review/request-invalid'],
    ['base not an ancestor', toolRequest('/repo'), { git: fakeGit({ ancestor: false }) }, 'review/base-not-ancestor'],
    ['dirty worktree', toolRequest('/repo'), { git: fakeGit({ dirty: true }) }, 'review/dirty-worktree'],
    ['empty diff', toolRequest('/repo'), { git: fakeGit({ changedPaths: [] }) }, 'review/empty-diff'],
    ['changedPaths mismatch', toolRequest('/repo', { changedPaths: ['src/other.ts'] }), {}, 'review/changed-paths-mismatch'],
  ]
  for (const [label, input, options, code] of cases) {
    await withRepo(async (repoPath) => {
      const git = options.git ?? fakeGit()
      const slice = fakeSlice()
      const { store, request } = setup(repoPath, { git, slice })
      await seedReviewProject(store, repoPath)
      const scoped = { ...input, path: repoPath }

      const result = await request.execute(scoped, fakeExec('session-topic', repoPath))

      assert.equal(result.ok, false, `${label} must be refused`)
      assert.equal(result.error.code, code, label)
      assert.equal(slice.calls.length, 0, `${label} must not create a reviewer`)
      const document = await canonical(store)
      assert.equal(document.topics[0].awaitingReview, false, label)
      const files = await import('node:fs/promises').then((fs) => fs.readdir(join(repoPath, '.dsh-cowork', 'reviews')))
        .catch(() => [])
      assert.deepEqual(files, [], `${label} must not write a request file`)
    })
  }
})

test('a path outside the work-item checkout is refused', async () => {
  await withRepo(async (repoPath) => {
    const item = workItemFixture(repoPath)
    const { store, request } = setup(repoPath)
    await seedReviewProject(store, repoPath, { workItem: item })

    const result = await request.execute(
      toolRequest(repoPath, { path: repoPath, workItemId: 'wi-1' }),
      fakeExec('session-topic', repoPath),
    )
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'review/path-outside')

    // A shared-tree request must use the repository root, not a subdirectory.
    const shared = await request.execute(
      toolRequest(repoPath, { path: item.path }),
      fakeExec('session-topic', repoPath),
    )
    assert.equal(shared.ok, false)
    assert.equal(shared.error.code, 'review/path-outside')
  })
})

test('a work item must exist, belong to the topic, and be reviewable', async () => {
  await withRepo(async (repoPath) => {
    const { store, request } = setup(repoPath)
    await seedReviewProject(store, repoPath)
    const missing = await request.execute(
      toolRequest(repoPath, { workItemId: 'wi-404' }),
      fakeExec('session-topic', repoPath),
    )
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'workitem/not-found')
  })
  await withRepo(async (repoPath) => {
    const item = workItemFixture(repoPath, { status: 'merged' })
    const { store, request } = setup(repoPath)
    await seedReviewProject(store, repoPath, { workItem: item })
    const merged = await request.execute(
      toolRequest(repoPath, { path: item.path, workItemId: 'wi-1' }),
      fakeExec('session-topic', repoPath),
    )
    assert.equal(merged.ok, false)
    assert.equal(merged.error.code, 'workitem/not-ready')
  })
  await withRepo(async (repoPath) => {
    const item = workItemFixture(repoPath, { topicId: 'session-other' })
    const { store, request } = setup(repoPath)
    await seedReviewProject(store, repoPath, { workItem: item })
    const foreign = await request.execute(
      toolRequest(repoPath, { path: item.path, workItemId: 'wi-1' }),
      fakeExec('session-topic', repoPath),
    )
    assert.equal(foreign.ok, false)
    assert.equal(foreign.error.code, 'workitem/not-found')
  })
})

test('a second pending request for the same topic and work item is refused', async () => {
  await withRepo(async (repoPath) => {
    const { store, request } = setup(repoPath)
    await seedReviewProject(store, repoPath)

    const first = await request.execute(toolRequest(repoPath), fakeExec('session-topic', repoPath))
    assert.equal(first.ok, true)
    const second = await request.execute(toolRequest(repoPath), fakeExec('session-topic', repoPath))

    assert.equal(second.ok, false)
    assert.equal(second.error.code, 'review/already-pending', JSON.stringify(second.error))
    assert.equal(second.error.details.requestId, first.requestId)
  })
})

test('a legacy verdict-only file never counts as a pending request', async () => {
  await withRepo(async (repoPath) => {
    const { store, request } = setup(repoPath)
    await seedReviewProject(store, repoPath)
    const reviewsDir = join(repoPath, '.dsh-cowork', 'reviews')
    await import('node:fs/promises').then((fs) => fs.mkdir(reviewsDir, { recursive: true }))
    await writeFile(join(reviewsDir, 'session-topic-20261107T090000000Z.json'), JSON.stringify({
      version: 1,
      threadId: 'session-topic',
      reviewerSessionId: 'session-old-reviewer',
      verdict: 'pass',
      summary: 'the old model',
      findings: [],
      verification: [],
      createdAt: '2026-11-07T09:00:00.000Z',
    }))

    const result = await request.execute(toolRequest(repoPath), fakeExec('session-topic', repoPath))

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.skippedFiles.length, 1)
    assert.equal(result.skippedFiles[0].fileName, 'session-topic-20261107T090000000Z.json')
  })
})

test('the previous request must exist, belong to the same chain, and be answered', async () => {
  await withRepo(async (repoPath) => {
    const { store, request } = setup(repoPath)
    await seedReviewProject(store, repoPath)

    const missing = await request.execute(
      toolRequest(repoPath, { previousRequestId: 'req-404' }),
      fakeExec('session-topic', repoPath),
    )
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'review/previous-invalid')
  })
  await withRepo(async (repoPath) => {
    const { store, request } = setup(repoPath)
    await seedReviewProject(store, repoPath)
    const first = await request.execute(toolRequest(repoPath), fakeExec('session-topic', repoPath))
    assert.equal(first.ok, true)

    // The first request is still pending: a second request for the same pair is
    // refused before the chain check, so no second reviewer is created.
    const pendingPrevious = await request.execute(
      toolRequest(repoPath, { previousRequestId: first.requestId }),
      fakeExec('session-topic', repoPath),
    )
    assert.equal(pendingPrevious.ok, false)
    assert.equal(pendingPrevious.error.code, 'review/already-pending')
  })
  // A terminal predecessor is accepted and bound into the new request.
  await withRepo(async (repoPath) => {
    const { store, request } = setup(repoPath)
    await seedReviewProject(store, repoPath)
    const first = await request.execute(toolRequest(repoPath), fakeExec('session-topic', repoPath))
    assert.equal(first.ok, true)
    const filePath = first.filePath
    const answered = JSON.parse(await readFile(filePath, 'utf8'))
    answered.status = 'needs_revision'
    answered.reviewedAt = REQUESTED_AT.toISOString()
    answered.summary = 'one fix before merge'
    answered.findings = [{ id: 'F1', severity: 'high', problem: 'p', requiredFix: 'f' }]
    await writeFile(filePath, `${JSON.stringify(answered, null, 2)}\n`)

    const second = await request.execute(
      toolRequest(repoPath, { previousRequestId: first.requestId }),
      fakeExec('session-topic', repoPath),
    )

    assert.equal(second.ok, true, JSON.stringify(second))
    const stored = JSON.parse(await readFile(second.filePath, 'utf8'))
    assert.equal(stored.previousRequestId, first.requestId)
    assert.equal(stored.status, 'pending')
  })
})

test('a brief failure rolls the request back in order and records it', async () => {
  await withRepo(async (repoPath) => {
    const slice = fakeSlice({ rejectFor: 'session-reviewer' })
    const { store, request } = setup(repoPath, { slice })
    await seedReviewProject(store, repoPath)

    const result = await request.execute(toolRequest(repoPath), fakeExec('session-topic', repoPath))

    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'review/prompt-failed', JSON.stringify(result.error))
    // No request file and no pending markers remain.
    const reviewsDir = join(repoPath, '.dsh-cowork', 'reviews')
    const files = await import('node:fs/promises').then((fs) => fs.readdir(reviewsDir)).catch(() => [])
    assert.deepEqual(files, [])
    const document = await canonical(store)
    assert.equal(document.topics[0].awaitingReview, false)
    assert.equal(document.topics[0].reviewStatus, null)
    assert.equal(document.topics[0].reviewerSessionId, null)
    // The half-created reviewer is archived, and the failure is in activity.
    const archives = slice.calls.filter((call) => call.type === 'archive')
    assert.deepEqual(archives.map((call) => call.sessionId), ['session-reviewer'])
    assert.deepEqual(archives[0].options, { stopActivity: true })
    const activity = await store.readActivity()
    assert.ok(activity.events.some((event) => event.type === 'error'))
  })
})

test('an index write failure archives the reviewer and removes the file', async () => {
  await withRepo(async (repoPath) => {
    const { store, slice, request } = setup(repoPath)
    await seedReviewProject(store, repoPath)
    const broken = Object.create(store)
    broken.mutateIndexDocument = async () => {
      throw new Error('index write refused')
    }
    // Re-register against a store whose index write fails after the file write.
    const host = fakeHost()
    registerReviewTools(host, {
      callerOf: (exec) => readCaller(exec) ?? toolFailure('exec/agent-unavailable', 'no caller'),
      openProject: async () => ({ repoPath, store: broken, slice, index: await store.readIndex() }),
      mapError: (error) => toolFailure('tool/internal', String(error)),
      toJson: (value) => JSON.parse(JSON.stringify(value)),
      renderJson: () => [],
      nowOf: () => CLOCK(),
      threadView: (thread) => thread,
      isFailure: (value) => typeof value === 'object' && value !== null && value.ok === false,
      git: fakeGit().runGit,
    })
    const tool = host.registry.get('cowork_review_request')

    const result = await tool.execute(toolRequest(repoPath), fakeExec('session-topic', repoPath))

    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'tool/internal')
    assert.match(result.error.message, /could not be recorded in the index/)
    const reviewsDir = join(repoPath, '.dsh-cowork', 'reviews')
    const files = await import('node:fs/promises').then((fs) => fs.readdir(reviewsDir)).catch(() => [])
    assert.deepEqual(files, [])
    // The file and reviewer were cleaned up; restoring the index is the one step
    // the failing store cannot do, and that is reported instead of hidden.
    assert.equal(result.error.details.cleanupErrors.length, 1)
    assert.match(result.error.details.cleanupErrors[0], /^index: index write refused/)
    const archives = slice.calls.filter((call) => call.type === 'archive')
    assert.deepEqual(archives.map((call) => call.sessionId), ['session-reviewer'])
  })
})

// ---------------------------------------------------------------------------
// the legacy thread merge gate and the topic messages
// ---------------------------------------------------------------------------

test('the legacy thread merge gate requires a passed review, with no override', async () => {
  const { checkLegacyThreadMerge } = await import('../src/review-request.ts')

  assert.deepEqual(checkLegacyThreadMerge({ threadId: 't1', reviewStatus: 'pass' }), { ok: true })

  for (const reviewStatus of ['pending', 'needs_revision', 'reject', null]) {
    const gate = checkLegacyThreadMerge({ threadId: 't1', reviewStatus })
    assert.equal(gate.ok, false, String(reviewStatus))
    assert.equal(gate.failure.error.code, 'review/not-passed')
    assert.match(gate.failure.error.message, /has not passed review/)
    assert.deepEqual(gate.failure.error.details, { threadId: 't1', reviewStatus })
  }

  // The M8 override is gone: the gate takes only the thread, and the module no
  // longer exports the override helpers.
  assert.equal(checkLegacyThreadMerge.length, 1)
  const module = await import('../src/review-request.ts')
  for (const name of ['cleanOverrideReason', 'overrideCommitSuffix', 'MAX_OVERRIDE_REASON_LENGTH']) {
    assert.equal(name in module, false, `${name} must not be exported any more`)
  }
})

test('a topic message stays bounded even with many long findings', async () => {
  const { REVIEW_MESSAGE_MAX_CHARS, buildRejectMessage, buildRevisionMessage } =
    await import('../src/review-request.ts')
  const many = {
    ...answeredRecord({
      status: 'needs_revision',
      summary: 's'.repeat(REVIEW_SUMMARY_MAX_CHARS),
      findings: Array.from({ length: 60 }, (_, index) => ({
        id: `F${index}`,
        severity: 'low',
        problem: 'p'.repeat(1900),
        requiredFix: 'r'.repeat(1900),
      })),
    }),
  }
  for (const message of [buildRevisionMessage(many), buildRejectMessage(many)]) {
    assert.ok(message.length <= REVIEW_MESSAGE_MAX_CHARS, `message is ${message.length} chars`)
    assert.match(message, /needs_revision|reject/)
    assert.match(message, /F0/)
  }
})
