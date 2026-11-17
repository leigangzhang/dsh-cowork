import test from 'node:test'
import assert from 'node:assert/strict'
import '../support/ts-hook.mjs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Contract tests for `cowork_review_verdict` (M10.3): the verdict binds one
 * request and one reviewer, lands in the request file before the index moves,
 * wakes the master only when it must decide, and archives the reviewer without
 * letting an archive or delivery failure turn a recorded verdict into a failure.
 *
 * `src/tools/review.ts` value-imports its siblings as `./x.js`, so this test
 * installs the same resolve hook tests/presets.test.mjs uses. The tool is driven
 * through a fake host registry with a real ProjectStore in a temp repo.
 */
import { withRepo } from '../support/inbox-fixtures.mjs'

const { registerReviewTools } = await import('../../src/tools/review.ts')
const { ProjectStore } = await import('../../src/store/project-store.ts')
const { failure, readCaller } = await import('../../src/platform/tool-model.ts')
const {
  buildReviewRequestRecord,
  parseReviewRequestRecord,
  reviewRequestFileName,
  serializeReviewRequestRecord,
  validateReviewRequestInput,
  validateReviewVerdictInput,
} = await import('../../src/domains/review/review-request.ts')

const NOW = new Date('2026-11-08T01:00:00.000Z')
const CLOCK = () => NOW
const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const REVIEWER = 'session-reviewer'
const REQUEST_ID = 'req-1'

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

/** A session slice that records prompts and archives; can fail one recipient. */
function fakeSlice(options = {}) {
  const calls = []
  return {
    calls,
    async createReviewSession() {
      throw new Error('a verdict must never create a session')
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

/** Register the two review tools against a real store and fake ports. */
function setup(repoPath, options = {}) {
  const store = options.store ?? new ProjectStore({ repoPath, clock: CLOCK })
  const slice = options.slice ?? fakeSlice()
  const host = fakeHost()
  const openProject = options.openProject
    ?? (async () => ({ repoPath, store, slice, index: await store.readIndex() }))
  registerReviewTools(host, {
    callerOf(exec) {
      return readCaller(exec) ?? failure('exec/agent-unavailable', 'no caller identity')
    },
    openProject,
    mapError(error) {
      return failure('tool/internal', error instanceof Error ? error.message : String(error))
    },
    toJson(value) {
      return JSON.parse(JSON.stringify(value))
    },
    renderJson() {
      return []
    },
    nowOf() {
      return NOW
    },
    threadView(thread) {
      return thread
    },
    isFailure(value) {
      return typeof value === 'object' && value !== null && value.ok === false
    },
    // The verdict path must not run git; a call here fails the test loudly.
    git: async (args) => {
      throw new Error(`verdict must not run git: ${args.join(' ')}`)
    },
  })
  return { store, slice, host, verdict: host.registry.get('cowork_review_verdict') }
}

/** A canonical v2 topic awaiting the review. */
function topicFixture(repoPath, overrides = {}) {
  const stamp = '2026-11-08T00:00:00.000Z'
  return {
    topicId: 'session-topic',
    title: 'wire the review',
    status: 'active',
    awaitingReview: true,
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
    latestReviewRequestId: REQUEST_ID,
    reviewStatus: 'pending',
    reviewerSessionId: REVIEWER,
    ...overrides,
  }
}

/** A canonical v2 work item under review. */
function workItemFixture(repoPath, overrides = {}) {
  const stamp = '2026-11-08T00:00:00.000Z'
  return {
    workItemId: 'wi-1',
    topicId: 'session-topic',
    path: join(repoPath, '.dsh-cowork', 'workitems', 'wi-1'),
    branch: 'cowork/wi-1',
    baseCommit: BASE,
    headCommit: HEAD,
    status: 'reviewing',
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  }
}

/**
 * Seed one project with a topic, an optional work item, and the pending request
 * file a reviewer would have been briefed with.
 */
async function seed(store, repoPath, options = {}) {
  const workItem = options.workItem === undefined ? workItemFixture(repoPath) : options.workItem
  await store.initIndex('session-master')
  await store.mutateIndexDocument((document) => ({
    ...document,
    topics: [topicFixture(repoPath, options.topicOverrides ?? {})],
    workItems: workItem === null ? [] : [workItem],
  }))
  const scope = {
    topicId: 'session-topic',
    workItemId: workItem === null ? null : 'wi-1',
    repoPath,
    workItemPath: workItem === null ? null : workItem.path,
    branch: workItem === null ? null : 'cowork/wi-1',
    changedPaths: ['src/one.ts'],
  }
  const input = {
    purpose: 'review the change',
    baseCommit: BASE,
    headCommit: HEAD,
    path: workItem === null ? repoPath : workItem.path,
    verification: [{ command: 'node --test tests/review-request.test.mjs', exitCode: 0, evidence: 'ok' }],
  }
  const validated = validateReviewRequestInput(input, scope)
  assert.equal(validated.ok, true, JSON.stringify(validated.ok ? {} : validated.errors))
  const record = buildReviewRequestRecord(validated.value, {
    requestId: REQUEST_ID,
    reviewerSessionId: REVIEWER,
    requestedAt: NOW,
  })
  const directory = join(repoPath, '.dsh-cowork', 'reviews')
  await mkdir(directory, { recursive: true })
  const filePath = join(directory, reviewRequestFileName('session-topic', REQUEST_ID))
  await writeFile(filePath, serializeReviewRequestRecord(record))
  return { record, filePath }
}

/**
 * Seed a pending request file whose topic is absent from the index: this binds
 * the verdict to the index entry instead of reusing the request tool's checks.
 */
async function seedOrphanRequest(store, repoPath, topicId, requestId) {
  await store.initIndex('session-master')
  const validated = validateReviewRequestInput(
    {
      purpose: 'review the change',
      baseCommit: BASE,
      headCommit: HEAD,
      path: repoPath,
      verification: [{ command: 'node --test tests/review-request.test.mjs', exitCode: 0, evidence: 'ok' }],
    },
    { topicId, workItemId: null, repoPath, workItemPath: null, branch: null, changedPaths: ['src/one.ts'] },
  )
  assert.equal(validated.ok, true, JSON.stringify(validated.ok ? {} : validated.errors))
  const record = buildReviewRequestRecord(validated.value, {
    requestId,
    reviewerSessionId: REVIEWER,
    requestedAt: NOW,
  })
  const directory = join(repoPath, '.dsh-cowork', 'reviews')
  await mkdir(directory, { recursive: true })
  const filePath = join(directory, reviewRequestFileName(topicId, requestId))
  await writeFile(filePath, serializeReviewRequestRecord(record))
  return filePath
}

/** One well-formed finding. */
function finding(overrides = {}) {
  return {
    id: 'F1',
    severity: 'high',
    problem: 'the merge gate can be skipped',
    requiredFix: 'route the merge through the gate',
    file: 'src/domains/review/review-request.ts',
    line: 42,
    ...overrides,
  }
}

/** Run one case against a fresh repository and clean up afterwards. */

/** Read the request file back as the JSON the tool wrote. */
const storedRequest = (filePath) => readFile(filePath, 'utf8').then((text) => JSON.parse(text))

// ---------------------------------------------------------------------------
// the verdict lifecycle
// ---------------------------------------------------------------------------

test('a pass verdict with a work item records, merges, and archives', async () => {
  await withRepo(async (repoPath) => {
    const { store, slice, verdict } = setup(repoPath)
    const { filePath } = await seed(store, repoPath)

    const result = await verdict.execute(
      { requestId: REQUEST_ID, verdict: 'pass', summary: 'the change holds up' },
      fakeExec(REVIEWER, repoPath),
    )

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.verdict, 'pass')
    assert.equal(result.status, 'pass')
    assert.equal(result.reviewFilePath, filePath)
    assert.equal(result.indexError, null)
    assert.equal(result.archived, true)
    assert.equal(result.archiveError, null)
    assert.deepEqual(result.inbox, { kind: 'merge-needed', delivered: 1, failed: 0, error: null })

    // File first: the terminal verdict is the request record.
    const stored = await storedRequest(filePath)
    assert.equal(stored.status, 'pass')
    assert.equal(stored.reviewedAt, NOW.toISOString())
    assert.equal(stored.summary, 'the change holds up')
    assert.deepEqual(stored.findings, [])
    assert.equal(parseReviewRequestRecord(JSON.stringify(stored)).ok, true)

    // The canonical index moved to "answered, mergeable".
    const document = await store.readIndexDocument()
    assert.equal(document.topics[0].awaitingReview, false)
    assert.equal(document.topics[0].reviewStatus, 'pass')
    assert.equal(document.topics[0].reviewerSessionId, null)
    assert.equal(document.topics[0].blocked, false)
    assert.equal(document.topics[0].latestReviewRequestId, REQUEST_ID)
    assert.equal(document.workItems[0].status, 'reviewing', 'a passed work item stays mergeable')

    // Only the master hears about it, and only through the merge-needed inbox.
    assert.deepEqual(
      slice.calls.filter((call) => call.type === 'prompt').map((call) => call.sessionId),
      ['session-master'],
    )
    assert.match(slice.calls[0].text, /\[merge-needed\]/)
    const inbox = await store.readInbox()
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0].kind, 'merge-needed')
    assert.equal(inbox[0].deliveredAt, NOW.toISOString())

    const archives = slice.calls.filter((call) => call.type === 'archive')
    assert.equal(archives.length, 1)
    assert.equal(archives[0].sessionId, REVIEWER)
    assert.deepEqual(archives[0].options, { stopActivity: true })

    const activity = await store.readActivity()
    assert.ok(activity.events.some((event) => event.type === 'review-verdict'))
  })
})

test('a pass verdict on a shared work tree wakes nobody and writes no inbox', async () => {
  await withRepo(async (repoPath) => {
    const { store, slice, verdict } = setup(repoPath)
    await seed(store, repoPath, { workItem: null })

    const result = await verdict.execute(
      { requestId: REQUEST_ID, verdict: 'pass', summary: 'holds up' },
      fakeExec(REVIEWER, repoPath),
    )

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.inbox, null)
    assert.equal(result.topicDelivered, null)
    assert.equal(slice.calls.filter((call) => call.type === 'prompt').length, 0)
    assert.deepEqual(await store.readInbox(), [])
    assert.equal(result.archived, true)
  })
})

test('needs_revision goes back to the topic only, never to the master', async () => {
  await withRepo(async (repoPath) => {
    const { store, slice, verdict } = setup(repoPath)
    await seed(store, repoPath)

    const result = await verdict.execute(
      {
        requestId: REQUEST_ID,
        verdict: 'needs_revision',
        summary: 'one fix before merge',
        findings: [finding()],
        verification: [{ command: 'node --test tests/review-request.test.mjs', exitCode: 0, evidence: 'pass' }],
      },
      fakeExec(REVIEWER, repoPath),
    )

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.inbox, null)
    assert.equal(result.topicDelivered, true)
    assert.equal(result.topicDeliveryError, null)

    // The topic gets the findings; the master gets no message and no inbox item.
    const prompts = slice.calls.filter((call) => call.type === 'prompt')
    assert.deepEqual(prompts.map((call) => call.sessionId), ['session-topic'])
    assert.match(prompts[0].text, /needs_revision/)
    assert.match(prompts[0].text, /F1 \[high\]/)
    assert.match(prompts[0].text, /route the merge through the gate/)
    assert.match(prompts[0].text, new RegExp(REQUEST_ID))
    assert.deepEqual(await store.readInbox(), [])

    const document = await store.readIndexDocument()
    assert.equal(document.topics[0].reviewStatus, 'needs_revision')
    assert.equal(document.topics[0].awaitingReview, false)
    assert.equal(document.topics[0].blocked, false)
    assert.equal(document.workItems[0].status, 'active', 'a revised work item is workable again')

    const stored = await storedRequest(result.reviewFilePath)
    assert.equal(stored.status, 'needs_revision')
    assert.deepEqual(stored.findings, [finding()])
    assert.deepEqual(stored.reviewVerification, [
      { command: 'node --test tests/review-request.test.mjs', exitCode: 0, evidence: 'pass' },
    ])
    assert.equal(result.archived, true)
  })
})

test('a reject verdict blocks the topic and wakes the master', async () => {
  await withRepo(async (repoPath) => {
    const { store, slice, verdict } = setup(repoPath)
    await seed(store, repoPath)

    const result = await verdict.execute(
      {
        requestId: REQUEST_ID,
        verdict: 'reject',
        summary: 'the approach is wrong',
        findings: [finding({ id: 'F2', severity: 'blocker' })],
      },
      fakeExec(REVIEWER, repoPath),
    )

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.inbox.kind, 'review-reject')
    assert.equal(result.inbox.delivered, 1)
    assert.deepEqual(
      slice.calls.filter((call) => call.type === 'prompt').map((call) => call.sessionId),
      ['session-topic', 'session-master'],
    )
    assert.match(slice.calls[1].text, /\[review-reject\]/)

    const document = await store.readIndexDocument()
    assert.equal(document.topics[0].reviewStatus, 'reject')
    assert.equal(document.topics[0].blocked, true)
    assert.equal(document.workItems[0].status, 'active')
    const inbox = await store.readInbox()
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0].kind, 'review-reject')
  })
})

// ---------------------------------------------------------------------------
// binding and refusals
// ---------------------------------------------------------------------------

test('only the recorded reviewer may answer the request', async () => {
  await withRepo(async (repoPath) => {
    const { store, slice, verdict } = setup(repoPath)
    const { filePath } = await seed(store, repoPath)

    const stranger = await verdict.execute(
      { requestId: REQUEST_ID, verdict: 'pass', summary: 'looks fine' },
      fakeExec('session-stranger', repoPath),
    )
    const master = await verdict.execute(
      { requestId: REQUEST_ID, verdict: 'pass', summary: 'looks fine' },
      fakeExec('session-master', repoPath),
    )

    assert.equal(stranger.ok, false)
    assert.equal(stranger.error.code, 'review/not-reviewer')
    assert.equal(master.ok, false)
    assert.equal(master.error.code, 'review/not-reviewer')
    assert.equal(slice.calls.length, 0, 'no prompt and no archive may happen')
    assert.equal((await storedRequest(filePath)).status, 'pending')
  })
})

test('a request accepts exactly one verdict', async () => {
  await withRepo(async (repoPath) => {
    const { store, verdict } = setup(repoPath)
    await seed(store, repoPath)

    const first = await verdict.execute(
      { requestId: REQUEST_ID, verdict: 'pass', summary: 'holds up' },
      fakeExec(REVIEWER, repoPath),
    )
    const second = await verdict.execute(
      { requestId: REQUEST_ID, verdict: 'reject', summary: 'changed my mind', findings: [finding()] },
      fakeExec(REVIEWER, repoPath),
    )

    assert.equal(first.ok, true)
    assert.equal(second.ok, false)
    assert.equal(second.error.code, 'review/already-reviewed')
    const document = await store.readIndexDocument()
    assert.equal(document.topics[0].reviewStatus, 'pass', 'the first verdict stands')
  })
})

test('an unknown request id is refused with a stable code', async () => {
  await withRepo(async (repoPath) => {
    const { store, verdict } = setup(repoPath)
    await seed(store, repoPath)

    const result = await verdict.execute(
      { requestId: 'req-404', verdict: 'pass', summary: 'looks fine' },
      fakeExec(REVIEWER, repoPath),
    )
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'review/request-not-found')
  })
})

test('invalid verdict input is refused by the model validator', () => {
  const cases = [
    [{ verdict: 'pass', summary: 'x' }, 'requestId'],
    [{ requestId: REQUEST_ID, verdict: 'maybe', summary: 'x' }, 'verdict'],
    [{ requestId: REQUEST_ID, verdict: 'pass' }, 'summary'],
    [{ requestId: REQUEST_ID, verdict: 'pass', summary: 'x'.repeat(2001) }, 'summary'],
    [{ requestId: REQUEST_ID, verdict: 'needs_revision', summary: 'x' }, 'findings'],
    [{ requestId: REQUEST_ID, verdict: 'reject', summary: 'x', findings: [finding({ id: '' })] }, 'findings[0].id'],
    [{ requestId: 'req 404', verdict: 'pass', summary: 'x' }, 'requestId'],
  ]
  for (const [input, field] of cases) {
    const result = validateReviewVerdictInput(input)
    assert.equal(result.ok, false, JSON.stringify(input))
    assert.equal(result.code, 'review/verdict-invalid')
    assert.ok(result.errors.some((error) => error.field === field), JSON.stringify(result.errors))
  }
  const valid = validateReviewVerdictInput({
    requestId: REQUEST_ID,
    verdict: 'needs_revision',
    summary: 'one fix',
    findings: [finding()],
  })
  assert.equal(valid.ok, true, JSON.stringify(valid.ok ? {} : valid.errors))
})

test('a verdict that is not an object, or whose findings are malformed, is refused by field', () => {
  for (const input of [null, 'a verdict', 42, []]) {
    const result = validateReviewVerdictInput(input)
    assert.equal(result.ok, false, String(input))
    assert.equal(result.code, 'review/verdict-invalid')
    assert.deepEqual(result.errors, [{ field: 'input', message: 'review verdict input must be an object' }])
  }

  const base = { requestId: REQUEST_ID, verdict: 'pass', summary: 'x' }
  const tooMany = Array.from({ length: 201 }, () => finding())
  const cases = [
    [{ ...base, findings: 'npm test' }, 'findings'],
    [{ ...base, findings: tooMany }, 'findings'],
    [{ ...base, findings: [null] }, 'findings[0]'],
    [{ ...base, findings: [finding({ severity: 'critical' })] }, 'findings[0].severity'],
    [{ ...base, findings: [finding({ file: '' })] }, 'findings[0].file'],
    [{ ...base, findings: [finding({ line: 0 })] }, 'findings[0].line'],
  ]
  for (const [input, field] of cases) {
    const result = validateReviewVerdictInput(input)
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => error.field === field), `${field}: ${JSON.stringify(result.errors)}`)
  }
})

test('a semantically invalid verdict changes no file and no index', async () => {
  await withRepo(async (repoPath) => {
    const { store, slice, verdict } = setup(repoPath)
    const { filePath } = await seed(store, repoPath)

    const result = await verdict.execute(
      { requestId: REQUEST_ID, verdict: 'needs_revision', summary: 'no findings attached' },
      fakeExec(REVIEWER, repoPath),
    )

    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'review/verdict-invalid')
    assert.equal((await storedRequest(filePath)).status, 'pending')
    assert.equal(slice.calls.length, 0)
    const document = await store.readIndexDocument()
    assert.equal(document.topics[0].reviewStatus, 'pending')
  })
})

// ---------------------------------------------------------------------------
// failures that must not undo a recorded verdict
// ---------------------------------------------------------------------------

test('a failed reviewer archive is reported, not turned into a failed verdict', async () => {
  await withRepo(async (repoPath) => {
    const slice = fakeSlice({ archiveError: new Error('host refused to archive') })
    const { store, verdict } = setup(repoPath, { slice })
    await seed(store, repoPath)

    const result = await verdict.execute(
      { requestId: REQUEST_ID, verdict: 'pass', summary: 'holds up' },
      fakeExec(REVIEWER, repoPath),
    )

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.archived, false)
    assert.match(result.archiveError, /host refused to archive/)
    const document = await store.readIndexDocument()
    assert.equal(document.topics[0].reviewStatus, 'pass')
  })
})

test('a failed inbox delivery keeps the item undelivered and reports it', async () => {
  await withRepo(async (repoPath) => {
    const slice = fakeSlice({ throwFor: 'session-master' })
    const { store, verdict } = setup(repoPath, { slice })
    await seed(store, repoPath)

    const result = await verdict.execute(
      { requestId: REQUEST_ID, verdict: 'pass', summary: 'holds up' },
      fakeExec(REVIEWER, repoPath),
    )

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.inbox.kind, 'merge-needed')
    assert.equal(result.inbox.delivered, 0)
    assert.equal(result.inbox.failed, 1)
    assert.match(result.inbox.error, /could not be delivered/)
    // The event is not lost: project_status can replay it later.
    const inbox = await store.readInbox()
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0].deliveredAt, null)
    // The verdict itself still stands.
    const document = await store.readIndexDocument()
    assert.equal(document.topics[0].reviewStatus, 'pass')
    assert.equal((await storedRequest(result.reviewFilePath)).status, 'pass')
  })
})

test('a failed index write is reported while the stored verdict stands', async () => {
  await withRepo(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: CLOCK })
    const base = setup(repoPath, { store })
    await seed(store, repoPath)
    const broken = Object.create(store)
    broken.mutateIndexDocument = async () => {
      throw new Error('index write refused')
    }
    const failing = setup(repoPath, { store: broken })

    const result = await failing.verdict.execute(
      { requestId: REQUEST_ID, verdict: 'pass', summary: 'holds up' },
      fakeExec(REVIEWER, repoPath),
    )

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.match(result.indexError, /index write refused/)
    assert.equal((await storedRequest(result.reviewFilePath)).status, 'pass')
    // The topic still awaits review because the index write did not land.
    const document = await base.store.readIndexDocument()
    assert.equal(document.topics[0].reviewStatus, 'pending')
    const activity = await base.store.readActivity()
    assert.ok(activity.events.some((event) => event.type === 'error'))
  })
})

// ---------------------------------------------------------------------------
// failures reported around a recorded verdict
// ---------------------------------------------------------------------------

test('a stored request whose topic left the index is refused as not found', async () => {
  await withRepo(async (repoPath) => {
    const { store, slice, verdict } = setup(repoPath)
    const filePath = await seedOrphanRequest(store, repoPath, 'session-gone', 'req-gone')

    const result = await verdict.execute(
      { requestId: 'req-gone', verdict: 'pass', summary: 'holds up' },
      fakeExec(REVIEWER, repoPath),
    )

    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'review/request-not-found', JSON.stringify(result.error))
    assert.match(result.error.message, /is not in the project index/)
    assert.deepEqual(result.error.details, { requestId: 'req-gone', topicId: 'session-gone' })
    assert.equal((await storedRequest(filePath)).status, 'pending')
    assert.equal(slice.calls.length, 0, 'no prompt and no archive may happen')
  })
})

test('a verdict file write failure is reported with the request context', async () => {
  await withRepo(async (repoPath) => {
    const real = new ProjectStore({ repoPath, clock: CLOCK })
    const { filePath } = await seed(real, repoPath)
    const broken = Object.create(real)
    broken.writeTextAtomic = async () => {
      throw new Error('review volume is read-only')
    }
    const { slice, verdict } = setup(repoPath, { store: broken })

    const result = await verdict.execute(
      { requestId: REQUEST_ID, verdict: 'pass', summary: 'holds up' },
      fakeExec(REVIEWER, repoPath),
    )

    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'review/write-failed', JSON.stringify(result.error))
    assert.match(result.error.message, /review volume is read-only/)
    assert.deepEqual(result.error.details, { requestId: REQUEST_ID, topicId: 'session-topic' })
    assert.equal((await storedRequest(filePath)).status, 'pending')
    assert.equal((await real.readIndexDocument()).topics[0].reviewStatus, 'pending')
    assert.equal(slice.calls.length, 0, 'nothing may be delivered or archived before the verdict is stored')
  })
})

test('a verdict that cannot be logged still succeeds and reports the activity error', async () => {
  await withRepo(async (repoPath) => {
    const real = new ProjectStore({ repoPath, clock: CLOCK })
    await seed(real, repoPath)
    const broken = Object.create(real)
    broken.appendActivity = async () => {
      throw new Error('activity store is read-only')
    }
    const { verdict } = setup(repoPath, { store: broken })

    const result = await verdict.execute(
      { requestId: REQUEST_ID, verdict: 'pass', summary: 'holds up' },
      fakeExec(REVIEWER, repoPath),
    )

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.match(result.activityError, /activity store is read-only/)
    assert.equal((await storedRequest(result.reviewFilePath)).status, 'pass')
    assert.equal((await real.readIndexDocument()).topics[0].reviewStatus, 'pass')
    assert.equal(result.inbox.delivered, 1)
  })
})

test('an unexpected project-open failure is mapped instead of thrown', async () => {
  await withRepo(async (repoPath) => {
    const { slice, verdict } = setup(repoPath, {
      async openProject() {
        throw new Error('project open exploded')
      },
    })

    const result = await verdict.execute(
      { requestId: REQUEST_ID, verdict: 'pass', summary: 'holds up' },
      fakeExec(REVIEWER, repoPath),
    )

    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'tool/internal')
    assert.match(result.error.message, /project open exploded/)
    assert.equal(slice.calls.length, 0, 'a failed open must not archive the reviewer')
  })
})

test('an inbox enqueue failure is reported without failing the stored verdict', async () => {
  await withRepo(async (repoPath) => {
    const real = new ProjectStore({ repoPath, clock: CLOCK })
    await seed(real, repoPath)
    const broken = Object.create(real)
    broken.writeInbox = async () => {
      throw new Error('inbox file is read-only')
    }
    const { verdict } = setup(repoPath, { store: broken })

    const result = await verdict.execute(
      { requestId: REQUEST_ID, verdict: 'pass', summary: 'holds up' },
      fakeExec(REVIEWER, repoPath),
    )

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.inbox.kind, 'merge-needed')
    assert.equal(result.inbox.delivered, 0)
    assert.equal(result.inbox.failed, 1)
    assert.match(result.inbox.error, /^enqueue: inbox file is read-only/)
    assert.equal((await storedRequest(result.reviewFilePath)).status, 'pass')
    assert.equal((await real.readIndexDocument()).topics[0].reviewStatus, 'pass')
  })
})

test('a delivery whose mark cannot be written reports the undelivered item', async () => {
  await withRepo(async (repoPath) => {
    const real = new ProjectStore({ repoPath, clock: CLOCK })
    await seed(real, repoPath)
    const broken = Object.create(real)
    let writes = 0
    broken.writeInbox = async (items) => {
      writes += 1
      if (writes === 1) return real.writeInbox(items)
      throw new Error('inbox mark refused')
    }
    const { slice, verdict } = setup(repoPath, { store: broken })

    const result = await verdict.execute(
      { requestId: REQUEST_ID, verdict: 'pass', summary: 'holds up' },
      fakeExec(REVIEWER, repoPath),
    )

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.inbox.delivered, 0)
    assert.equal(result.inbox.failed, 1)
    assert.match(result.inbox.error, /could not be marked delivered/)
    // The delivered batch stays undelivered for replay; the verdict itself stands.
    const inbox = await real.readInbox()
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0].deliveredAt, null)
    assert.deepEqual(
      slice.calls.filter((call) => call.type === 'prompt').map((call) => call.sessionId),
      ['session-master'],
    )
  })
})

test('an inbox that cannot be read during delivery is reported, not thrown', async () => {
  await withRepo(async (repoPath) => {
    const real = new ProjectStore({ repoPath, clock: CLOCK })
    await seed(real, repoPath)
    const broken = Object.create(real)
    let reads = 0
    broken.readInbox = async () => {
      reads += 1
      if (reads === 1) return real.readInbox()
      throw new Error('inbox file is unreadable')
    }
    const { slice, verdict } = setup(repoPath, { store: broken })

    const result = await verdict.execute(
      { requestId: REQUEST_ID, verdict: 'pass', summary: 'holds up' },
      fakeExec(REVIEWER, repoPath),
    )

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.inbox.kind, 'merge-needed')
    assert.equal(result.inbox.delivered, 0)
    assert.equal(result.inbox.failed, 1)
    assert.equal(result.inbox.error, 'inbox file is unreadable')
    assert.equal(slice.calls.filter((call) => call.type === 'prompt').length, 0)
  })
})
