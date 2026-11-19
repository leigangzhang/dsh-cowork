import test from 'node:test'
import assert from 'node:assert/strict'
import '../../support/ts-hook.mjs'

/**
 * The shared authorization decision core against injected ports: the pre-check
 * and the lock-scoped re-read, the cross-file transaction failure order, card
 * classification, and the post-commit activity/notice/prompt failures. The
 * route-level transaction against a real store lives in
 * `authorization-transaction.test.mjs`; this file pins the branches that only a
 * collaborator failure or a torn index can reach.
 */

const {
  resolveAuthorizationDecision,
  settleAuthorizationRequestRecord,
} = await import('../../../src/domains/requests/authorization-decision.ts')
const { buildRequestRecord, applyResolution } = await import('../../../src/domains/requests/request-schema.ts')

const NOW = new Date('2026-11-13T10:00:00.000Z')
const NOW_ISO = NOW.toISOString()
const MASTER = 'session-master'
const TOPIC = 'session-topic'
const REQUEST_ID = 'req-1'

/** One topic blocked on the suite's pending authorization. */
function pendingTopic(overrides = {}) {
  return {
    topicId: TOPIC,
    title: 'Authorization core',
    status: 'idle',
    awaitingReview: false,
    blocked: true,
    blockedReason: 'authorization',
    blockedFromStatus: 'idle',
    blockedAt: NOW_ISO,
    scope: 'inbox',
    ownedPaths: [],
    aliases: [],
    digest: 'working',
    cwd: '/repo',
    legacyCheckoutPath: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    lastActiveAt: NOW_ISO,
    lastDeliveryConfirmedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    authorization: { requestId: REQUEST_ID, summary: 'may I push?', requestedAt: NOW_ISO },
    ...overrides,
  }
}

/** One index document holding the pending topic. */
function projectDocument(topic = pendingTopic(), overrides = {}) {
  return {
    version: 2,
    projectId: 'p',
    masterSessionId: MASTER,
    createdAt: NOW_ISO,
    topics: [topic],
    workItems: [],
    ...overrides,
  }
}

/** One pending authorization card. */
function pendingCard() {
  return buildRequestRecord({
    requestId: REQUEST_ID,
    projectId: 'p',
    topicId: TOPIC,
    kind: 'authorization',
    title: 'Authorization core',
    payload: { summary: 'may I push?' },
    now: NOW,
  })
}

/** A card store whose read and write share one record. */
function fakeCard(record = pendingCard(), options = {}) {
  let current = record
  return {
    get current() {
      return current
    },
    async read() {
      return current
    },
    async updateUnlocked(_requestId, mutator) {
      if (options.writtenStatus !== undefined) {
        return { ...current, status: options.writtenStatus }
      }
      const next = mutator(current)
      if (next !== null) current = next
      return next
    },
  }
}

/**
 * Fake project store. Every method mirrors the real store's documented
 * behavior; `mutateSees`, `mutateResult`, `readFailures` and
 * `mutateThrowsAfterApply` are the collaborator failures under test.
 */
function fakeStore(initial = projectDocument(), options = {}) {
  let current = initial
  const activity = [...(options.activity ?? [])]
  const calls = { mutations: 0, reads: 0, appends: [] }
  const logs = []
  let readIndexCalls = 0
  const store = {
    async readIndexDocument() {
      readIndexCalls += 1
      calls.reads = readIndexCalls
      const failure = options.readFailures?.[readIndexCalls - 1]
      if (failure) throw new Error(failure)
      return current
    },
    async readActivity() {
      return { events: [...activity] }
    },
    async appendActivity(event) {
      calls.appends.push(event.type)
      const failure = options.appendFailures?.shift()
      if (failure) throw new Error(failure)
      activity.push(event)
    },
    async withWriteLock(operation) {
      return operation()
    },
    async mutateIndexDocumentUnlocked(mutator) {
      calls.mutations += 1
      const base = options.mutateSees === undefined ? current : options.mutateSees(current)
      const next = mutator(base)
      if (options.mutateThrowsAfterApply === true && calls.mutations === 1) {
        throw new Error(options.mutateError ?? 'store/invalid: write failed after rename')
      }
      if (options.mutateResult !== undefined) {
        current = options.mutateResult
        return current
      }
      if (next === null) return base
      current = next
      return next
    },
  }
  return {
    store,
    calls,
    activity,
    logs,
    get document() {
      return current
    },
  }
}

/** The activity row `recordedDecision` reads for an idempotent replay. */
function decisionEvent(decision = 'allow') {
  return {
    eventId: 'event-auth-decided',
    time: NOW_ISO,
    type: 'authorization-resolved',
    topicId: TOPIC,
    summary: 'authorization allowed',
    details: { topicId: TOPIC, requestId: REQUEST_ID, noticeId: null, decision },
  }
}

/** The base input every direct core call starts from. */
function coreInput(store, overrides = {}) {
  return {
    store,
    repoPath: '/repo',
    topicId: TOPIC,
    requestId: REQUEST_ID,
    decision: 'allow',
    sessionId: MASTER,
    now: NOW,
    log: () => {},
    ...overrides,
  }
}

test('the core refuses an unknown topic before taking the write lock', async () => {
  const empty = fakeStore({ ...projectDocument(), topics: [] })

  await assert.rejects(
    resolveAuthorizationDecision(coreInput(empty.store)),
    (error) => error.code === 'topic/not-found',
  )
  assert.equal(empty.calls.reads, 1)
  assert.equal(empty.calls.mutations, 0)
})

test('the lock re-read re-checks permission and the pending request id', async () => {
  const permission = fakeStore(projectDocument(), {
    mutateSees: (document) => ({ ...document, masterSessionId: 'session-other' }),
  })
  await assert.rejects(
    resolveAuthorizationDecision(coreInput(permission.store)),
    (error) => error.code === 'authorization/not-allowed',
  )
  assert.equal(permission.calls.mutations, 1)
  assert.deepEqual(permission.calls.appends, [])

  const mismatch = fakeStore(projectDocument(), {
    mutateSees: (document) => ({
      ...document,
      topics: document.topics.map((topic) => ({
        ...topic,
        authorization: { ...topic.authorization, requestId: 'req-other' },
      })),
    }),
  })
  await assert.rejects(
    resolveAuthorizationDecision(coreInput(mismatch.store)),
    (error) => error.code === 'authorization/mismatch',
  )
})

test('a write that may have landed is checked and restored before the original error escapes', async () => {
  const seeded = fakeStore(projectDocument(), {
    readFailures: [null, 'index unreadable during recovery'],
    mutateThrowsAfterApply: true,
  })
  await assert.rejects(
    resolveAuthorizationDecision(coreInput(seeded.store, { requestCard: fakeCard() })),
    /write failed after rename/,
  )
  assert.equal(seeded.calls.mutations, 2, 'the transaction restores the document it snapshotted')
  assert.notEqual(seeded.document.topics[0].authorization, null, 'the restore keeps the pending block')
})

test('an index that lost the topic while replaying an absent pending reports internal', async () => {
  const { store } = fakeStore(projectDocument(), {
    activity: [decisionEvent('allow')],
    mutateSees: (document) => ({ ...document, topics: [] }),
  })
  await assert.rejects(
    resolveAuthorizationDecision(coreInput(store)),
    (error) => error.code === 'internal',
  )
})

test('a committed decision whose index lost the topic reports internal, not a half outcome', async () => {
  const { store } = fakeStore(projectDocument(), {
    mutateResult: { ...projectDocument(), topics: [] },
  })
  await assert.rejects(
    resolveAuthorizationDecision(coreInput(store, { requestCard: fakeCard() })),
    (error) => error.code === 'internal',
  )
})

test('a card written with another terminal status is classified as a conflict', async () => {
  const card = fakeCard(pendingCard(), { writtenStatus: 'denied' })
  const { store } = fakeStore()
  const outcome = await resolveAuthorizationDecision(coreInput(store, { requestCard: card }))

  assert.equal(outcome.changed, true)
  assert.equal(outcome.cardSettled, 'conflict')
  assert.equal(outcome.cardRecord.status, 'denied')
})

test('a recovery that loses the card before the lock does not write a second decision', async () => {
  const requested = {
    eventId: 'event-auth-requested',
    time: NOW_ISO,
    type: 'authorization-requested',
    topicId: TOPIC,
    summary: 'requested authorization',
    details: { topicId: TOPIC, requestId: REQUEST_ID, notice: {} },
  }
  const baseCard = pendingCard()
  let reads = 0
  const racingCard = {
    async read() {
      reads += 1
      return reads === 1 ? baseCard : { ...baseCard, status: 'allowed' }
    },
    async updateUnlocked() {
      throw new Error('the recovery must not settle a card that already lost the race')
    },
  }
  const { store, calls } = fakeStore(projectDocument(pendingTopic({
    authorization: null,
    blockedReason: 'handoff',
    blockedFromStatus: 'active',
  })), { activity: [requested] })

  await assert.rejects(
    resolveAuthorizationDecision(coreInput(store, { requestCard: racingCard })),
    (error) => error.code === 'authorization/not-found',
  )
  assert.equal(calls.mutations, 0, 'the index is not written after the card is gone')
  assert.equal(reads, 2, 'the recovery re-checks the card under the lock')
})

test('a deferred prompt is returned instead of fired, and a non-deferred one reports its failure', async () => {
  const deferred = await resolveAuthorizationDecision(coreInput(fakeStore().store, {
    requestCard: fakeCard(),
    deferPrompt: true,
    promptSession: async () => ({ accepted: true }),
  }))
  assert.equal(deferred.prompted, false)
  assert.match(deferred.promptText, /授权请求已允许/)

  const refused = await resolveAuthorizationDecision(coreInput(fakeStore().store, {
    requestCard: fakeCard(),
    promptSession: async () => ({ accepted: false }),
  }))
  assert.equal(refused.prompted, false)
  assert.equal(refused.promptError, 'the host refused the queue prompt')

  const logs = []
  const thrown = await resolveAuthorizationDecision(coreInput(fakeStore().store, {
    requestCard: fakeCard(),
    promptSession: async () => {
      throw new Error('queue closed')
    },
    log: (message) => logs.push(message),
  }))
  assert.equal(thrown.prompted, false)
  assert.match(thrown.promptError, /queue closed/)
  assert.ok(logs.some((line) => line.includes('was not prompted')), logs.join('\n'))
})

test('post-commit activity and notice failures are logged, never rolled back', async () => {
  const activity = [{
    eventId: 'event-auth-1',
    time: NOW_ISO,
    type: 'authorization-requested',
    topicId: TOPIC,
    summary: 'requested authorization',
    details: { topicId: TOPIC, requestId: REQUEST_ID, notice: {} },
  }]
  const logs = []
  const { store, calls } = fakeStore(projectDocument(), {
    activity,
    appendFailures: ['activity sink full', 'settled activity sink full'],
  })
  // `capabilities()` runs outside the notice helper's own try/catch, so this is
  // the one port failure that reaches the core's catch.
  const noticePort = {
    capabilities: () => {
      throw new Error('notice channel broken')
    },
    append: async () => 'delivered',
    update: async () => 'delivered',
  }

  const outcome = await resolveAuthorizationDecision(coreInput(store, {
    requestCard: fakeCard(),
    noticePort,
    log: (message) => logs.push(message),
  }))

  assert.equal(outcome.changed, true)
  assert.equal(outcome.noticeId, 'event-auth-1')
  assert.deepEqual(calls.appends, ['authorization-resolved', 'request-resolved'])
  assert.ok(logs.some((line) => line.includes('activity not recorded')), logs.join('\n'))
  assert.ok(logs.some((line) => line.includes('notice event-auth-1 was not updated')), logs.join('\n'))
  assert.ok(logs.some((line) => line.includes('settled, activity not recorded')), logs.join('\n'))
})

test('settling a card on its own logs a failed request-resolved activity', async () => {
  const logs = []
  const { store } = fakeStore(projectDocument(), { appendFailures: ['activity sink full'] })

  const outcome = await settleAuthorizationRequestRecord({
    store,
    repoPath: '/repo',
    topicId: TOPIC,
    requestId: REQUEST_ID,
    decision: 'allow',
    now: NOW,
    promptedAt: NOW_ISO,
    promptError: null,
    requestCard: fakeCard(),
    log: (message) => logs.push(message),
  })

  assert.equal(outcome, 'settled')
  assert.ok(logs.some((line) => line.includes('settled, activity not recorded')), logs.join('\n'))
})
