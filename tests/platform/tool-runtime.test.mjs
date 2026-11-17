import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { makeSeedProject, makeTopicFixture, withRepo } from '../support/inbox-fixtures.mjs'
/**
 * Behavior tests for every export of the shared tool-runtime module.
 *
 * The topic tools exercise these helpers against a real `ProjectStore` in their
 * own suites; this file owns the module's direct contract: the pure projections,
 * project/store adapters, and the failure shapes no tool can produce on a host
 * (a refused inbox batch, a failed notice-ledger write, the best-effort cleanup
 * paths of `archiveTopic`). Every injection is a fake port or a filesystem
 * object, so the calls are deterministic and never sleep.
 */
const {
  archiveTopic,
  callerOf,
  deliverInbox,
  evaluateProjectLifecycle,
  isFailure,
  makeSlice,
  mapError,
  memoryIo,
  nowOf,
  openProject,
  projectStoreFor,
  recordNoticeEvent,
  renderJson,
  runGit,
  threadView,
  toJson,
  topicView,
  truncateText,
} = await import('../../src/platform/tool-runtime.ts')
const { SessionSlice } = await import('../../src/platform/session-slice.ts')
const { ProjectStore, StoreError } = await import('../../src/store/project-store.ts')
const { RequestStore } = await import('../../src/store/request-store.ts')
const { authorizationRequestedActivity } = await import('../../src/store/activity.ts')
const { buildRequestRecord } = await import('../../src/domains/requests/request-schema.ts')

const NOW = new Date('2026-11-10T09:00:00.000Z')
const NOW_ISO = NOW.toISOString()
const TOPIC_ID = 'session-topic'

/** One v2 topic with the suite's identity and every required field. */
const topic = makeTopicFixture({
  topicId: TOPIC_ID,
  title: 'Inbox backend',
  scope: 'inbox',
  digest: 'working',
})

const seedProject = makeSeedProject({ clock: () => NOW })

/** One valid activity event; descriptor-carrying events override `details`. */
const activityEvent = (overrides = {}) => ({
  eventId: 'event-1',
  time: NOW_ISO,
  type: 'status-changed',
  topicId: TOPIC_ID,
  summary: 'status changed',
  details: {},
  ...overrides,
})

/** The in-memory inbox file; `failReadAt` rejects the Nth read (1-based). */
function fakeInboxStore({ items = [], failReadAt = null } = {}) {
  const store = {
    items,
    reads: 0,
    writes: 0,
    async readInbox() {
      store.reads += 1
      if (store.reads === failReadAt) throw new Error('inbox file vanished')
      return items.map((item) => ({ ...item }))
    },
    async writeInbox(next) {
      store.writes += 1
      store.items = next.map((item) => ({ ...item }))
      return store.items
    },
  }
  return store
}

/**
 * A store decorator that keeps `ProjectStore` semantics while injecting the
 * failure under test. `repoPath` is the path the request-void pass resolves
 * against, so a test can point it at storage the real store does not own.
 */
class StoreWithFailure {
  constructor(store, { repoPath = store.repoPath, failAppend = null, mutateNotices = null } = {}) {
    this.store = store
    this.repoPath = repoPath
    this.failAppend = failAppend
    this.mutateNoticesImpl = mutateNotices
    this.appended = []
  }

  async mutateIndexDocument(mutator) {
    return this.store.mutateIndexDocument(mutator)
  }

  async appendActivity(event) {
    this.appended.push(event)
    if (this.failAppend !== null && this.failAppend(event)) {
      throw new Error('activity store unavailable')
    }
    return this.store.appendActivity(event)
  }

  async readNotices() {
    return this.store.readNotices()
  }

  async writeNotices(ledger) {
    return this.store.writeNotices(ledger)
  }

  async mutateNotices(mutator) {
    if (this.mutateNoticesImpl !== null) return this.mutateNoticesImpl(mutator)
    return this.store.mutateNotices(mutator)
  }

  async readActivity(limit) {
    return this.store.readActivity(limit)
  }
}

/** One pending request file in the project's request inbox. */
async function createPendingRequest(repoPath, requestId = 'req-1') {
  const requests = new RequestStore({ repoPath })
  await requests.create(buildRequestRecord({
    requestId,
    projectId: 'p',
    topicId: TOPIC_ID,
    kind: 'user-review',
    title: 'Inbox backend',
    payload: { purpose: 'review the inbox backend' },
    now: NOW,
  }))
  return requests
}

test('renderJson renders the value as one JSON text block', () => {
  assert.deepEqual(renderJson({ ignored: true }, { ok: true, items: [1, 'two', null] }), [
    { type: 'text', text: '{"ok":true,"items":[1,"two",null]}' },
  ])
  assert.deepEqual(renderJson(undefined, null), [{ type: 'text', text: 'null' }])
})

test('deliverInbox reports a rejected enqueue batch without reading or delivering', async () => {
  const store = fakeInboxStore()
  const delivered = []
  const outcome = await deliverInbox({
    store,
    events: [{ topicId: TOPIC_ID, kind: 'not-a-kind', summary: 'blocked on review' }],
    deliver: async (text) => { delivered.push(text) },
    clock: () => NOW,
  })
  assert.equal(outcome.delivered, 0)
  assert.equal(outcome.failed, 1)
  assert.match(outcome.error, /inbox\.kind must be one of/)
  assert.equal(store.reads, 0, 'validation runs before the file is read')
  assert.equal(store.writes, 0)
  assert.deepEqual(delivered, [], 'a rejected batch is never delivered')
})

test('deliverInbox keeps a refused batch undelivered and reports the failure', async () => {
  const item = {
    id: 'item-1',
    time: NOW_ISO,
    topicId: TOPIC_ID,
    kind: 'blocked',
    summary: 'needs help',
    deliveredAt: null,
  }
  const store = fakeInboxStore({ items: [item] })
  const attempts = []
  const outcome = await deliverInbox({
    store,
    deliver: async (text) => {
      attempts.push(text)
      throw new Error('master offline')
    },
    clock: () => NOW,
  })
  assert.deepEqual(attempts, ['[blocked] needs help'])
  assert.deepEqual(outcome, {
    delivered: 0,
    failed: 1,
    error: 'master did not accept the inbox batch',
  })
  assert.deepEqual(store.items, [item], 'the item stays in the file for the next replay')
  assert.equal(store.writes, 0, 'a failed delivery writes no deliveredAt')
})

test('deliverInbox reports an unexpected flush failure with unknown counts', async () => {
  const store = fakeInboxStore({ failReadAt: 2 })
  const outcome = await deliverInbox({
    store,
    deliver: async () => {},
    clock: () => NOW,
  })
  assert.deepEqual(outcome, { delivered: 0, failed: 0, error: 'inbox file vanished' })
  assert.equal(store.reads, 2, 'the enqueue read succeeds; the flush read is the one that fails')
})

test('recordNoticeEvent reports a failed activity append without kicking the dispatcher', async () => {
  const kicks = []
  const result = await recordNoticeEvent(
    { appendActivity: async () => { throw new Error('activity stream unavailable') } },
    activityEvent(),
    NOW,
    { kick: (repoPath) => kicks.push(repoPath) },
    '/repo',
  )
  assert.equal(result, false)
  assert.deepEqual(kicks, [], 'no ledger row means there is nothing to deliver')
})

test('recordNoticeEvent keeps the committed event when the notice ledger write fails', async () => {
  const appends = []
  const kicks = []
  const store = {
    async appendActivity(event) { appends.push(event) },
    async readNotices() { return { version: 1, notices: [] } },
    async writeNotices() { throw new Error('notice ledger unavailable') },
  }
  const event = activityEvent({
    details: { notice: { kind: 'report', title: 'Inbox backend', summary: 'done', targets: ['master'] } },
  })
  const result = await recordNoticeEvent(store, event, NOW, { kick: (repoPath) => kicks.push(repoPath) }, '/repo')
  assert.equal(result, true)
  assert.deepEqual(appends, [event], 'the activity append already stands')
  assert.deepEqual(kicks, ['/repo'], 'the dispatcher still runs for the readable event')
})

test('archiveTopic logs a per-request activity failure without rolling the archive back', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    const requests = await createPendingRequest(repoPath)
    const logs = []
    const failing = new StoreWithFailure(store, {
      failAppend: (event) => event.type === 'request-resolved',
    })
    const outcome = await archiveTopic(failing, TOPIC_ID, {
      now: NOW,
      repoPath,
      log: (message) => logs.push(message),
    })
    assert.equal(outcome.changed, true)
    assert.equal(outcome.event.type, 'topic-archived')
    assert.equal(outcome.noticeRows, 1)
    assert.deepEqual(logs, ['request req-1 voided, activity not recorded: activity store unavailable'])
    assert.equal((await requests.read('req-1')).status, 'void', 'the void is committed before its event')
    const types = (await store.readActivity()).events.map((event) => event.type)
    assert.ok(types.includes('topic-archived'))
    assert.ok(!types.includes('request-resolved'))
  })
})

test('archiveTopic logs a request-storage failure and still returns the archived topic', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    // A self-referential symlink makes the request scan fail with ELOOP, the
    // one shape a real store cannot produce on demand and a fake store cannot
    // own: `archiveTopic` builds the RequestStore itself.
    const loopRepo = join(repoPath, 'unreadable-requests')
    await mkdir(loopRepo)
    await symlink('.dsh-cowork', join(loopRepo, '.dsh-cowork'))
    const logs = []
    const failing = new StoreWithFailure(store, { repoPath: loopRepo })
    const outcome = await archiveTopic(failing, TOPIC_ID, {
      now: NOW,
      repoPath,
      log: (message) => logs.push(message),
    })
    assert.equal(outcome.changed, true)
    assert.equal(outcome.event.type, 'topic-archived')
    assert.equal(outcome.noticeRows, 1)
    assert.equal(logs.length, 1)
    assert.match(
      logs[0],
      /pending requests of archived topic session-topic were not voided: ELOOP/,
    )
    assert.equal((await store.readIndexDocument()).topics[0].status, 'resolved')
  })
})

test('archiveTopic logs a failed authorization-notice withdrawal and names the withdrawn notice', async () => {
  await withRepo(async (repoPath) => {
    const blocked = topic({
      status: 'idle',
      blocked: true,
      blockedReason: 'authorization',
      blockedFromStatus: 'idle',
      blockedAt: NOW_ISO,
      authorization: { requestId: 'req-1', summary: 'may I push?', requestedAt: NOW_ISO },
    })
    const store = await seedProject(repoPath, [blocked])
    const requested = authorizationRequestedActivity(
      blocked,
      { requestId: 'req-1', summary: 'may I push?' },
      NOW,
    )
    await store.appendActivity(requested)
    let ledgerMutations = 0
    const failing = new StoreWithFailure(store, {
      mutateNotices: async (mutator) => {
        ledgerMutations += 1
        if (ledgerMutations === 2) throw new Error('notice ledger unavailable')
        return store.mutateNotices(mutator)
      },
    })
    const logs = []
    const outcome = await archiveTopic(failing, TOPIC_ID, {
      now: NOW,
      repoPath,
      log: (message) => logs.push(message),
    })
    assert.equal(outcome.changed, true)
    assert.equal(outcome.noticeRows, 1, 'the archive notice itself was written')
    assert.equal(outcome.event.details.voidedAuthorizationNoticeId, requested.eventId)
    assert.deepEqual(logs, ['authorization notice was not voided: notice ledger unavailable'])
    assert.equal((await store.readIndexDocument()).topics[0].status, 'resolved')
  })
})

test('mapError maps a missing project index onto project/not-initialized', () => {
  const filePath = '/repo/.dsh-cowork/index.json'
  const mapped = mapError(new StoreError('store/not-found', `project index not found: ${filePath}`, filePath))
  assert.deepEqual(mapped, {
    ok: false,
    error: {
      code: 'project/not-initialized',
      message: `project index not found: ${filePath}`,
      details: { filePath },
    },
  })
})

test('mapError maps a corrupt project index onto store/corrupt with its path', () => {
  const filePath = '/repo/.dsh-cowork/index.json'
  const mapped = mapError(new StoreError('store/corrupt', `project index is invalid (${filePath})`, filePath))
  assert.deepEqual(mapped, {
    ok: false,
    error: {
      code: 'store/corrupt',
      message: `project index is invalid (${filePath})`,
      details: { filePath },
    },
  })
})

test('mapError keeps an unknown store failure internal and carries no file path', () => {
  const mapped = mapError(new StoreError('store/thread-exists', 'thread already exists: thread-1'))
  assert.equal(mapped.ok, false)
  assert.equal(mapped.error.code, 'tool/internal')
  assert.equal(mapped.error.message, 'thread already exists: thread-1')
  assert.equal('details' in mapped.error, false)
})

test('truncateText bounds text by code points without splitting a pair', () => {
  assert.equal(truncateText('abcdef', 3), 'abc')
  assert.equal(truncateText('abc', 3), 'abc')
  assert.equal(truncateText('abc', 0), '')
  assert.equal(truncateText('abc', -1), '')
  // An emoji is two UTF-16 units; the cut keeps it whole.
  assert.equal(truncateText('a😀b', 2), 'a😀')
})

test('toJson serializes the value into a detached JSON copy', () => {
  const original = { nested: { flag: true }, list: [1, 'two'], dropped: undefined }
  const copy = toJson(original)
  assert.deepEqual(copy, { nested: { flag: true }, list: [1, 'two'] })
  assert.notEqual(copy, original)
  assert.notEqual(copy.nested, original.nested)
})

test('projectStoreFor prefers the injected factory and otherwise builds the production store', () => {
  const injected = { marker: 'injected' }
  const calls = []
  const deps = {
    createProjectStore: (repoPath, received) => {
      calls.push({ repoPath, received })
      return injected
    },
  }
  assert.equal(projectStoreFor('/repo', deps), injected)
  assert.deepEqual(calls, [{ repoPath: '/repo', received: deps }])

  const store = projectStoreFor('/repo', {})
  assert.ok(store instanceof ProjectStore)
  assert.equal(store.repoPath, '/repo')
})

test('nowOf reads the injected clock and falls back to the wall clock', () => {
  const fixed = new Date('2020-01-02T03:04:05.000Z')
  assert.equal(nowOf({ clock: () => fixed }), fixed)
  const before = Date.now()
  const now = nowOf({})
  assert.ok(now instanceof Date)
  assert.ok(now.getTime() >= before && now.getTime() <= Date.now())
})

test('deliverInbox reports a delivery whose deliveredAt mark never commits', async () => {
  const item = {
    id: 'item-1',
    time: NOW_ISO,
    topicId: TOPIC_ID,
    kind: 'merge-needed',
    summary: 'merge the topic',
    deliveredAt: null,
  }
  let writes = 0
  const store = {
    async readInbox() { return [{ ...item }] },
    async writeInbox() {
      writes += 1
      throw new Error('inbox write rejected')
    },
  }
  const outcome = await deliverInbox({ store, deliver: async () => {}, clock: () => NOW })
  assert.deepEqual(outcome, {
    delivered: 0,
    failed: 1,
    error:
      'inbox delivery could not be marked delivered after 3 attempts; '
      + '1 item(s) stay undelivered and will be replayed',
  })
  assert.equal(writes, 3, 'the mark is retried three times before it is reported')
})

test('archiveTopic writes nothing for an already resolved topic', async () => {
  await withRepo(async (repoPath) => {
    const resolved = topic({ status: 'resolved', resolvedAt: NOW_ISO, resolvedBy: 'user' })
    const store = await seedProject(repoPath, [resolved])
    let appended = 0
    const failing = new StoreWithFailure(store, {
      failAppend: () => { appended += 1; return false },
    })
    const outcome = await archiveTopic(failing, TOPIC_ID, { now: NOW, repoPath })
    assert.equal(outcome.changed, false)
    assert.equal(outcome.event, null)
    assert.equal(outcome.noticeRows, 0)
    assert.equal(outcome.topic.status, 'resolved')
    assert.equal(appended, 0, 'an idempotent archive appends no activity')
  })
})

test('archiveTopic keeps the committed topic when its archive event cannot be recorded', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    const requests = await createPendingRequest(repoPath)
    const logs = []
    const failing = new StoreWithFailure(store, {
      failAppend: (event) => event.type === 'topic-archived',
    })
    const outcome = await archiveTopic(failing, TOPIC_ID, {
      now: NOW,
      repoPath,
      log: (message) => logs.push(message),
    })
    assert.equal(outcome.changed, true)
    assert.equal(outcome.event, null)
    assert.equal(outcome.noticeRows, 0)
    assert.deepEqual(logs, ['topic archive event was not recorded: activity store unavailable'])
    assert.equal((await store.readIndexDocument()).topics[0].status, 'resolved')
    assert.equal((await requests.read('req-1')).status, 'pending', 'the early return skips the void pass')
  })
})

test('makeSlice builds one session adapter over the injected host ports', () => {
  const slice = makeSlice({ sessionController: {}, workspaceRegistry: {} })
  assert.ok(slice instanceof SessionSlice)
  assert.notEqual(makeSlice({ sessionController: {}, workspaceRegistry: {} }), slice)
})

test('runGit returns a successful command as a value and keeps a non-zero exit', async () => {
  const version = await runGit(['--version'], process.cwd())
  assert.equal(version.code, 0)
  assert.match(version.stdout, /^git version /)
  assert.equal(version.stderr, '')

  const missing = await runGit(['rev-parse', '--verify', 'refs/heads/no-such-branch-for-test'], process.cwd())
  assert.notEqual(missing.code, 0)
  assert.ok(missing.stderr.length > 0, 'a failed git call reports its stderr')
})

test('runGit maps a failed spawn onto the non-git exit fallback', async () => {
  await withRepo(async (repoPath) => {
    const result = await runGit(['--version'], join(repoPath, 'no-such-directory'))
    // execFile never produced a numeric git exit code, so the fallback applies.
    assert.equal(result.code, 1)
    assert.equal(result.stdout, '')
    assert.ok(result.stderr.length > 0)
  })
})

test('memoryIo reads, writes, and locks through the project store', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [])
    const io = memoryIo(store)
    const file = join(repoPath, 'memory.md')
    assert.equal(await io.readText(file), null)
    await io.writeText(file, 'remembered\n')
    assert.equal(await io.readText(file), 'remembered\n')
    assert.equal(await io.withLock(async () => 'ran under the lock'), 'ran under the lock')
  })
})

test('isFailure recognizes only the failure envelope', () => {
  assert.equal(isFailure({ ok: false, error: {} }), true)
  assert.equal(isFailure({ ok: true }), false)
  assert.equal(isFailure(null), false)
  assert.equal(isFailure('failure'), false)
})

test('callerOf reads the execution identity or refuses to guess', () => {
  const exec = { agent: { id: 'session-a', session: { header: { cwd: '/repo' } } } }
  assert.deepEqual(callerOf(exec), { sessionId: 'session-a', cwd: '/repo' })
  const denied = callerOf({})
  assert.equal(denied.ok, false)
  assert.equal(denied.error.code, 'exec/agent-unavailable')
  assert.match(denied.error.message, /no caller identity on exec\.agent/)
})

test('openProject opens the nearest project or names the missing index', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [])
    const opened = await openProject({ sessionId: 'session-master', cwd: repoPath }, {})
    assert.equal(opened.repoPath, repoPath)
    assert.ok(opened.store instanceof ProjectStore)
    assert.equal(opened.index.masterSessionId, 'session-master')
    assert.ok(opened.slice instanceof SessionSlice)
  })
  await withRepo(async (repoPath) => {
    const missing = await openProject(
      { sessionId: 'session-x', cwd: repoPath },
      { resolveRepoPath: () => '/plugin/default' },
    )
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'project/not-initialized')
    assert.match(missing.error.message, /no \.dsh-cowork\/index\.json at or above/)
    assert.match(missing.error.message, /plugin default repo: \/plugin\/default/)
  })
})

test('threadView projects every public thread field and nothing else', () => {
  const thread = {
    threadId: 'thread-1',
    subject: 'wire the lifecycle',
    status: 'active',
    cwd: '/repo',
    checkoutPath: '/repo/.dsh-cowork/threads/thread-1',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: NOW_ISO,
    lastHandoffAt: null,
    reviewStatus: 'pending',
    reviewRequestedAt: NOW_ISO,
    reviewedAt: null,
    reviewerSessionId: 'session-reviewer',
    latestReviewPath: '/repo/.dsh-cowork/reviews/thread-1.json',
  }
  assert.deepEqual(threadView(thread), {
    threadId: 'thread-1',
    subject: 'wire the lifecycle',
    status: 'active',
    cwd: '/repo',
    checkoutPath: '/repo/.dsh-cowork/threads/thread-1',
    updatedAt: NOW_ISO,
    lastHandoffAt: null,
    reviewStatus: 'pending',
    reviewedAt: null,
    reviewerSessionId: 'session-reviewer',
    latestReviewPath: '/repo/.dsh-cowork/reviews/thread-1.json',
  })
})

test('topicView maps a v2 topic and bounds its digest to 200 code points', () => {
  const record = topic({ digest: 'd'.repeat(250) })
  const view = topicView(record)
  assert.deepEqual(view, {
    topicId: TOPIC_ID,
    title: 'Inbox backend',
    status: 'active',
    blocked: false,
    awaitingReview: false,
    scope: 'inbox',
    ownedPaths: [],
    digest: 'd'.repeat(200),
    lastActiveAt: record.lastActiveAt,
    updatedAt: record.updatedAt,
    resolvedAt: null,
    resolvedBy: null,
  })
  assert.equal(Array.from(view.digest).length, 200)
})

test('evaluateProjectLifecycle reports one transition per changed topic and survives a failed activity', async () => {
  const idle = topic({ status: 'active', lastActiveAt: '2026-11-01T00:00:00.000Z' })
  const fresh = topic({ topicId: 'session-fresh', lastActiveAt: NOW_ISO })
  const document = {
    version: 2,
    projectId: 'p',
    masterSessionId: 'master',
    createdAt: NOW_ISO,
    topics: [idle, fresh],
    workItems: [],
  }
  const commits = []
  const appended = []
  const store = {
    async mutateIndexDocument(mutator) {
      const next = mutator(structuredClone(document))
      if (next !== null) commits.push(next)
      return next ?? document
    },
    async appendActivity(event) {
      appended.push(event)
      throw new Error('activity stream unavailable')
    },
  }
  const evaluation = await evaluateProjectLifecycle(store, { idleAfterMs: 60_000, now: NOW })
  assert.equal(evaluation.evaluated, 2)
  assert.deepEqual(evaluation.changes, [{ topicId: TOPIC_ID, from: 'active', to: 'idle' }])
  assert.deepEqual(evaluation.activityErrors, [`${TOPIC_ID}: activity stream unavailable`])
  assert.equal(commits.length, 1)
  assert.equal(commits[0].topics[0].status, 'idle')
  assert.equal(commits[0].topics[1].status, 'active')
  assert.equal(appended.length, 1, 'only the changed topic gets an activity row')
  assert.equal(appended[0].type, 'status-changed')
})
