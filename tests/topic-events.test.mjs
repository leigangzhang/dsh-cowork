import test from 'node:test'
import assert from 'node:assert/strict'
import './support/ts-hook.mjs'
/**
 * Host-free contract tests for M8.2: the session event listener that keeps
 * topic activity fresh and reopens resolved topics. The event source, repo
 * resolution, store, and clock are all fakes, so no host is involved.
 *
 * `src/platform/topic-events.ts` value-imports `./topic.js`, so this test installs the
 * same resolve hook tests/store-v2.test.mjs uses.
 */

const { TopicEvents } = await import('../src/platform/topic-events.ts')

const NOW_ISO = '2026-11-07T12:00:00.000Z'
const NOW = new Date(NOW_ISO)
const CREATED_AT = '2026-11-01T00:00:00.000Z'
const RESOLVED_AT = '2026-11-06T09:00:00.000Z'

/** A v2 topic carrying every field the listener may preserve. */
const topicV2 = (overrides = {}) => ({
  topicId: 'session-a',
  title: 'wire the lifecycle',
  status: 'active',
  awaitingReview: false,
  blocked: false,
  scope: '',
  ownedPaths: [],
  aliases: [],
  digest: '',
  cwd: '/repo',
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
  lastHandoffAt: null,
  reviewRequestedAt: null,
  reviewedAt: null,
  latestReviewPath: null,
  ...overrides,
})

/** A v2 document holding the given topics. */
const documentOf = (topics) => ({
  version: 2,
  projectId: 'p',
  masterSessionId: 'master',
  createdAt: CREATED_AT,
  topics,
  workItems: [],
})

/** A host session as far as the listener reads it. */
const session = (id, overrides = {}) => ({ id, header: { cwd: '/repo' }, ...overrides })

/**
 * An in-memory store. `readIndexDocument` returns the committed `document`,
 * while the mutator receives `lockDocument` — the document as the lock reads it
 * — so a stale snapshot and a concurrent write can be simulated separately.
 */
class FakeStore {
  constructor(document, options = {}) {
    this.document = structuredClone(document)
    this.lockDocument = structuredClone(options.lockDocument ?? document)
    this.reads = 0
    this.mutations = 0
    this.activity = []
    this.readError = options.readError
    this.mutateError = options.mutateError
    this.appendError = options.appendError
  }

  async readIndexDocument() {
    this.reads += 1
    if (this.readError !== undefined) throw this.readError
    return structuredClone(this.document)
  }

  async mutateIndexDocument(mutator) {
    if (this.mutateError !== undefined) throw this.mutateError
    const next = mutator(structuredClone(this.lockDocument))
    if (next === null) return structuredClone(this.lockDocument)
    this.lockDocument = next
    this.document = next
    this.mutations += 1
    return next
  }

  async appendActivity(event) {
    if (this.appendError !== undefined) throw this.appendError
    this.activity.push(event)
  }
}

/** Let every pending microtask of one event settle (an event-loop turn, not a sleep). */
const flush = () => new Promise((resolve) => setImmediate(resolve))

/** Wire one TopicEvents instance against a fake event source and store. */
function harnessFor(store, options = {}) {
  const listeners = new Set()
  const log = []
  const storePaths = []
  const source = {
    onSessionEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit(targetSession, event) {
      for (const listener of [...listeners]) listener(targetSession, event)
    },
    count: () => listeners.size,
  }
  const topicEvents = new TopicEvents({
    onSessionEvent: (listener) => source.onSessionEvent(listener),
    resolveRepoPath: options.resolveRepoPath ?? (() => '/repo'),
    storeFor: (repoPath) => {
      storePaths.push(repoPath)
      return store
    },
    clock: () => NOW,
    log: (message) => log.push(message),
  })
  const dispose = topicEvents.attach()
  return {
    topicEvents,
    dispose,
    log,
    storePaths,
    count: () => source.count(),
    emit: (targetSession, event) => source.emit(targetSession, event),
  }
}

test('turn/end returns an idle topic to active and stamps the activity clock', async () => {
  const store = new FakeStore(
    documentOf([topicV2({ status: 'idle', lastActiveAt: CREATED_AT, updatedAt: CREATED_AT })]),
  )
  const harness = harnessFor(store)

  harness.emit(session('session-a'), { type: 'turn/end' })
  await flush()

  const topic = store.document.topics[0]
  assert.equal(topic.status, 'active')
  assert.equal(topic.lastActiveAt, NOW_ISO)
  assert.equal(topic.updatedAt, NOW_ISO)
  assert.equal(store.mutations, 1)
  assert.deepEqual(store.activity, [], 'turn/end records no activity event')
  assert.deepEqual(harness.storePaths, ['/repo'])
})

test('turn/end leaves a resolved topic untouched and records no activity', async () => {
  const store = new FakeStore(
    documentOf([topicV2({ status: 'resolved', resolvedAt: RESOLVED_AT, resolvedBy: 'master' })]),
  )
  const harness = harnessFor(store)

  harness.emit(session('session-a'), { type: 'turn/end' })
  await flush()

  assert.equal(store.mutations, 0)
  assert.deepEqual(store.activity, [])
  assert.equal(store.document.topics[0].resolvedAt, RESOLVED_AT)
})

test('an event for a session that is not a topic writes nothing', async () => {
  const store = new FakeStore(documentOf([topicV2({ topicId: 'session-other' })]))
  const harness = harnessFor(store)

  harness.emit(session('session-a'), { type: 'turn/end' })
  harness.emit(session('session-a'), { type: 'user/message' })
  await flush()

  assert.equal(store.reads, 2)
  assert.equal(store.mutations, 0)
  assert.deepEqual(store.activity, [])
})

test('a session without a project cwd never touches the store', async () => {
  const store = new FakeStore(documentOf([topicV2()]))
  const harness = harnessFor(store, { resolveRepoPath: () => null })

  harness.emit(session('session-a', { header: undefined }), { type: 'turn/end' })
  harness.emit({ id: 'session-a' }, { type: 'turn/end' })
  await flush()

  assert.equal(store.reads, 0)
  assert.equal(store.mutations, 0)
  assert.deepEqual(harness.storePaths, [])
})

test('unrelated session events are ignored before any lookup', async () => {
  const store = new FakeStore(documentOf([topicV2()]))
  const harness = harnessFor(store)

  harness.emit(session('session-a'), { type: 'turn/start' })
  harness.emit(session('session-a'), { type: 'assistant/message' })
  await flush()

  assert.equal(store.reads, 0)
  assert.equal(harness.storePaths.length, 0)
})

test('user/message reopens a resolved topic and records one topic-reopened event', async () => {
  const store = new FakeStore(
    documentOf([
      topicV2({
        status: 'resolved',
        resolvedAt: RESOLVED_AT,
        resolvedBy: 'master',
        digest: 'delivered',
        lastDeliveryConfirmedAt: RESOLVED_AT,
      }),
    ]),
  )
  const harness = harnessFor(store)

  harness.emit(session('session-a'), { type: 'user/message' })
  await flush()

  const topic = store.document.topics[0]
  assert.equal(topic.status, 'active')
  assert.equal(topic.resolvedAt, null)
  assert.equal(topic.resolvedBy, null)
  assert.equal(topic.lastActiveAt, NOW_ISO)
  assert.equal(topic.updatedAt, NOW_ISO)
  assert.equal(topic.digest, 'delivered', 'the summary survives the reopen')
  assert.equal(topic.lastDeliveryConfirmedAt, RESOLVED_AT, 'the delivery proof survives')

  assert.equal(store.activity.length, 1)
  const event = store.activity[0]
  assert.match(event.eventId, /^[0-9a-f-]{36}$/)
  assert.deepEqual(
    { ...event, eventId: 'event' },
    {
      eventId: 'event',
      time: NOW_ISO,
      type: 'topic-reopened',
      topicId: 'session-a',
      summary: 'reopened topic session-a',
      details: { topicId: 'session-a', resolvedAt: RESOLVED_AT, resolvedBy: 'master' },
    },
  )
})

test('a second user/message does not reopen twice or record a second event', async () => {
  const store = new FakeStore(
    documentOf([topicV2({ status: 'resolved', resolvedAt: RESOLVED_AT, resolvedBy: 'master' })]),
  )
  const harness = harnessFor(store)

  harness.emit(session('session-a'), { type: 'user/message' })
  await flush()
  harness.emit(session('session-a'), { type: 'user/message' })
  await flush()

  assert.equal(store.mutations, 1)
  assert.equal(store.activity.length, 1)
  assert.equal(store.document.topics[0].status, 'active')
})

test('user/message on a topic that is not resolved writes nothing', async () => {
  const store = new FakeStore(documentOf([topicV2({ status: 'idle' })]))
  const harness = harnessFor(store)

  harness.emit(session('session-a'), { type: 'user/message' })
  await flush()

  assert.equal(store.mutations, 0)
  assert.deepEqual(store.activity, [])
})

test('a reopen abandoned under the lock writes nothing and records no event', async () => {
  const staleSnapshot = documentOf([
    topicV2({ status: 'resolved', resolvedAt: RESOLVED_AT, resolvedBy: 'master' }),
  ])
  const lockedDocument = documentOf([topicV2({ status: 'active' })])
  const store = new FakeStore(staleSnapshot, { lockDocument: lockedDocument })
  const harness = harnessFor(store)

  harness.emit(session('session-a'), { type: 'user/message' })
  await flush()

  assert.equal(store.mutations, 0)
  assert.deepEqual(store.activity, [])
  assert.equal(store.document.topics[0].status, 'resolved', 'the stale snapshot is not written')
})

test('a failed activity append keeps the reopen and only logs', async () => {
  const store = new FakeStore(
    documentOf([topicV2({ status: 'resolved', resolvedAt: RESOLVED_AT, resolvedBy: 'master' })]),
    { appendError: new Error('activity disk full') },
  )
  const harness = harnessFor(store)

  harness.emit(session('session-a'), { type: 'user/message' })
  await flush()

  assert.equal(store.document.topics[0].status, 'active', 'the reopen stays on disk')
  assert.equal(store.activity.length, 0)
  assert.equal(harness.log.length, 1)
  assert.match(harness.log[0], /topic-reopened activity/)
  assert.match(harness.log[0], /activity disk full/)
})

test('a failed read is logged and never reaches the host bus', async () => {
  const store = new FakeStore(documentOf([topicV2()]), { readError: new Error('index corrupt') })
  const harness = harnessFor(store)

  harness.emit(session('session-a'), { type: 'turn/end' })
  await flush()

  assert.equal(store.mutations, 0)
  assert.equal(harness.log.length, 1)
  assert.match(harness.log[0], /turn\/end failed/)
  assert.match(harness.log[0], /index corrupt/)
})

test('a failed mutation is logged and never reaches the host bus', async () => {
  const store = new FakeStore(documentOf([topicV2({ status: 'idle' })]), {
    mutateError: new Error('lock timeout'),
  })
  const harness = harnessFor(store)

  harness.emit(session('session-a'), { type: 'turn/end' })
  await flush()

  assert.equal(store.document.topics[0].status, 'idle')
  assert.equal(harness.log.length, 1)
  assert.match(harness.log[0], /lock timeout/)
})

test('the disposer stops delivery and is idempotent', async () => {
  const store = new FakeStore(documentOf([topicV2({ status: 'idle' })]))
  const harness = harnessFor(store)

  assert.equal(harness.topicEvents.attach(), harness.dispose)
  assert.equal(harness.count(), 1)

  harness.dispose()
  harness.dispose()
  assert.equal(harness.count(), 0)

  harness.emit(session('session-a'), { type: 'turn/end' })
  await flush()
  assert.equal(store.reads, 0)
})
