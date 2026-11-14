import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import './support/ts-hook.mjs'
/**
 * Contract tests for the topic notice model: the pure 1:1 copy, the delivery
 * ledger, the B-mode ports, and the per-project dispatcher (order, retry,
 * replay, and the fact that a delivery failure never rolls state back).
 *
 * `src/notices.ts` imports its sibling with a `.js` specifier, so the usual
 * small resolve hook is installed. The dispatcher runs against a real
 * `ProjectStore` in a throwaway directory; only the host port is a fake.
 */
import { makeTopicFixture, withRepo } from './support/inbox-fixtures.mjs'

const notices = await import('../src/notices.ts')
const { ProjectStore } = await import('../src/store/project-store.ts')
const {
  assignmentNotice,
  authorizationRequestedActivity,
  authorizationResolvedActivity,
  buildActivityEvent,
  decisionProposedActivity,
  topicArchivedActivity,
  topicReportedActivity,
} = await import('../src/store/activity.ts')

const NOW = new Date('2026-11-10T10:00:00.000Z')
const NOW_ISO = NOW.toISOString()
const CREATED_AT = '2026-11-10T09:00:00.000Z'

const topic = makeTopicFixture({
  topicId: 'session-topic',
  title: 'wire the notices',
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  lastActiveAt: CREATED_AT,
})

/** A recording port that can be told to fail the first N appends. */
function fakePort({ supported = true, failTimes = 0, failAlways = false } = {}) {
  const appends = []
  const updates = []
  let remaining = failTimes
  return {
    appends,
    updates,
    capabilities: () => ({ supported, actions: supported, updates: supported }),
    async append(sessionId, notice) {
      if (failAlways || remaining > 0) {
        if (remaining > 0) remaining -= 1
        throw new Error('host is down')
      }
      appends.push({ sessionId, notice })
      return 'delivered'
    },
    async update(sessionId, noticeId, patch) {
      updates.push({ sessionId, noticeId, patch })
      return 'delivered'
    },
  }
}


/** A store for one throwaway project with an initialised index. */
async function openStore(repoPath) {
  const store = new ProjectStore({ repoPath, clock: () => NOW, projectId: 'p' })
  await store.initIndex('session-master')
  return store
}

// ---------------------------------------------------------------------------
// copy: one notice per target, no merging, no batching
// ---------------------------------------------------------------------------

test('noticeFor renders master and topic copy for the same event, one notice each', () => {
  const event = topicReportedActivity(topic(), { summary: 'wired the store', kind: 'progress' }, NOW)
  const master = notices.noticeFor(event, 'master')
  const topicSide = notices.noticeFor(event, 'topic')
  assert.ok(master !== null && topicSide !== null)
  assert.notEqual(master.title, topicSide.title, 'the two sides are worded for their reader')
  assert.equal(master.noticeId, event.eventId)
  assert.equal(topicSide.noticeId, event.eventId, 'the id is the activity event id')
  assert.equal(master.topicId, 'session-topic')
  assert.equal(master.kind, 'report')
  assert.match(master.summary, /wire the notices/)
  assert.match(master.summary, /wired the store/)
  assert.equal(master.status, 'pending')
  assert.deepEqual(notices.noticesOf(event).map((entry) => entry.noticeId), [event.eventId, event.eventId])
})

test('the archive notice reaches the master only', () => {
  const event = topicArchivedActivity(topic({ digest: 'done' }), { by: 'user' }, NOW)
  const master = notices.noticeFor(event, 'master')
  assert.ok(master !== null)
  assert.equal(master.kind, 'archive')
  assert.equal(master.status, 'void')
  assert.equal(notices.noticeFor(event, 'topic'), null)
  assert.equal(notices.noticesOf(event).length, 1)
})

test('the assignment and proposal events carry their own kinds and actions', () => {
  const assignment = buildActivityEvent({
    type: 'topic-created',
    topicId: 'session-topic',
    summary: 'created topic',
    details: { notice: assignmentNotice(topic(), 'start with the ledger') },
  }, NOW)
  const assignmentNoticeOf = notices.noticeFor(assignment, 'topic')
  assert.equal(assignmentNoticeOf.kind, 'assignment')
  assert.match(assignmentNoticeOf.summary, /start with the ledger/)

  const proposal = decisionProposedActivity(topic(), {
    proposalId: 'p-1',
    proposalPath: '.dsh-cowork/proposals/p-1.json',
    title: 'pick schema',
    summary: 'v2',
  }, NOW)
  const proposalNotice = notices.noticeFor(proposal, 'master')
  assert.equal(proposalNotice.kind, 'proposal')
  assert.deepEqual(proposalNotice.actions, ['open-work-item'])

  const rows = notices.noticeSummaries([proposal], { version: 1, notices: [] })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].proposalId, 'p-1')
  assert.equal(rows[0].proposalPath, '.dsh-cowork/proposals/p-1.json')
})

test('an authorization event is pending with allow/deny, and the decision patches the same id', () => {
  const requested = authorizationRequestedActivity(topic(), { requestId: 'request-1', summary: 'may I?' }, NOW)
  const pending = notices.noticeFor(requested, 'master')
  assert.equal(pending.status, 'pending')
  assert.deepEqual(pending.actions, ['allow', 'deny'])

  const resolved = authorizationResolvedActivity(topic(), {
    requestId: 'request-1',
    noticeId: requested.eventId,
    decision: 'deny',
    summary: 'may I?',
  }, NOW)
  const decided = notices.noticeFor(resolved, 'topic')
  assert.equal(decided.noticeId, requested.eventId, 'the decision updates the original notice')
  assert.equal(decided.status, 'denied')
  assert.equal(notices.noticeFor(resolved, 'master').noticeId, requested.eventId)
})

test('an event without a valid descriptor produces nothing', () => {
  const bare = buildActivityEvent({
    type: 'status-changed',
    topicId: 'session-topic',
    summary: 'changed status',
    details: { from: 'active', to: 'idle' },
  }, NOW)
  assert.equal(notices.noticeDescriptorOf(bare), null)
  assert.equal(notices.noticeFor(bare, 'master'), null)
  assert.deepEqual(notices.noticesOf(bare), [])

  const broken = buildActivityEvent({
    type: 'topic-reported',
    topicId: 'session-topic',
    summary: 'x',
    details: { notice: { kind: 'not-a-kind', title: 't', summary: 's', targets: ['master'] } },
  }, NOW)
  assert.equal(notices.noticeFor(broken, 'master'), null)
})

// ---------------------------------------------------------------------------
// ledger document
// ---------------------------------------------------------------------------

test('the ledger validator names every broken field', () => {
  assert.deepEqual(notices.noticeLedgerProblems(notices.emptyNoticeLedger()), [])
  const problems = notices.noticeLedgerProblems({
    version: 2,
    notices: [{ noticeId: '', topicId: '', target: 'nobody', status: 'maybe', attempts: -1, lastError: 3, updatedAt: 'soon' }],
  })
  assert.deepEqual(problems, [
    'notice ledger.version must be 1',
    'notices[0].noticeId must be a non-empty string',
    'notices[0].topicId must be a non-empty string',
    'notices[0].target must be one of master|topic',
    'notices[0].status must be one of pending|delivered|failed|void',
    'notices[0].attempts must be a non-negative integer',
    'notices[0].lastError must be a string or null',
    'notices[0].updatedAt must be an ISO 8601 timestamp',
  ])
  assert.deepEqual(notices.noticeLedgerProblems({ version: 1, notices: 'nope' }), [
    'notice ledger.notices must be an array',
  ])
})

test('the ledger trims to its newest 200 rows', () => {
  const rows = Array.from({ length: 205 }, (_, index) => ({
    noticeId: `event-${index}`,
    topicId: 'session-topic',
    target: 'master',
    status: 'pending',
    attempts: 0,
    lastError: null,
    updatedAt: new Date(Date.parse(CREATED_AT) + index * 1000).toISOString(),
  }))
  const kept = notices.trimNoticeLedger(rows)
  assert.equal(kept.length, 200)
  assert.equal(kept[0].noticeId, 'event-5')
  assert.equal(kept[199].noticeId, 'event-204')
})

test('recordNoticesForEvent writes exactly one row per target and upserts on replay', async () => {
  await withRepo(async (repoPath) => {
    const store = await openStore(repoPath)
    const event = topicReportedActivity(topic(), { summary: 'progress', kind: 'progress' }, NOW)
    const rows = await notices.recordNoticesForEvent(store, event, NOW)
    assert.deepEqual(rows.map((row) => row.target).sort(), ['master', 'topic'])
    let ledger = await store.readNotices()
    assert.equal(ledger.notices.length, 2)
    assert.ok(ledger.notices.every((row) => row.status === 'pending' && row.attempts === 0))

    const again = await notices.recordNoticesForEvent(store, event, new Date(NOW.getTime() + 1000))
    assert.equal(again.length, 2)
    ledger = await store.readNotices()
    assert.equal(ledger.notices.length, 2, 'a replay does not grow the ledger')

    // authorization-resolved is an update: no ledger row of its own.
    const resolved = authorizationResolvedActivity(topic(), {
      requestId: 'request-1',
      noticeId: event.eventId,
      decision: 'allow',
      summary: 'progress',
    }, NOW)
    assert.deepEqual(await notices.recordNoticesForEvent(store, resolved, NOW), [])
    assert.equal((await store.readNotices()).notices.length, 2)
  })
})

// ---------------------------------------------------------------------------
// B mode: the ports never claim a delivery
// ---------------------------------------------------------------------------

test('the Noop and Fixture ports report an unsupported capability and claim nothing', async () => {
  for (const port of [new notices.NoopTopicNoticePort(), new notices.FixtureTopicNoticePort()]) {
    assert.deepEqual(port.capabilities(), { supported: false, actions: false, updates: false })
  }
  const noop = new notices.NoopTopicNoticePort()
  await assert.rejects(noop.append('session-master', {
    noticeId: 'event-1',
    pluginId: 'p',
    topicId: 'session-topic',
    kind: 'report',
    title: 't',
    summary: 's',
    status: 'pending',
    actions: [],
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  }), /no topic notice channel/)

  const fixture = new notices.FixtureTopicNoticePort()
  const outcome = await fixture.append('session-master', {
    noticeId: 'event-1',
    pluginId: 'p',
    topicId: 'session-topic',
    kind: 'report',
    title: 't',
    summary: 's',
    status: 'pending',
    actions: [],
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  })
  assert.equal(outcome, 'duplicate')
  assert.equal(fixture.appended.length, 1, 'the fixture records the attempt')
})

test('updateAuthorizationNotice is a no-op in B mode and values a host failure', async () => {
  const document = {
    version: 2,
    projectId: 'p',
    masterSessionId: 'session-master',
    createdAt: CREATED_AT,
    topics: [],
    workItems: [],
  }
  assert.equal(await notices.updateAuthorizationNotice({
    port: new notices.NoopTopicNoticePort(),
    document,
    topicId: 'session-topic',
    noticeId: 'event-1',
    decision: 'allow',
    now: NOW,
  }), 'unsupported')

  const failing = fakePort()
  failing.update = async () => { throw new Error('host is down') }
  assert.equal(await notices.updateAuthorizationNotice({
    port: failing,
    document,
    topicId: 'session-topic',
    noticeId: 'event-1',
    decision: 'deny',
    now: NOW,
  }), 'failed')
})

// ---------------------------------------------------------------------------
// dispatcher: order, retry, replay, and the failure rules
// ---------------------------------------------------------------------------

/** Build one project with a ledger row for a real event, plus extra events. */
async function seedPending(store, { extra = 0 } = {}) {
  const event = topicReportedActivity(topic(), { summary: 'progress', kind: 'progress' }, NOW)
  await store.appendActivity(event)
  await notices.recordNoticesForEvent(store, event, NOW)
  for (let index = 0; index < extra; index += 1) {
    await store.appendActivity(buildActivityEvent({
      type: 'status-changed',
      topicId: 'session-topic',
      summary: `noise ${index}`,
      details: { index },
    }, new Date(NOW.getTime() + 1000 + index)))
  }
  return event
}

test('the dispatcher delivers a pending notice once and keeps the ledger honest', async () => {
  await withRepo(async (repoPath) => {
    const store = await openStore(repoPath)
    const event = await seedPending(store)
    const port = fakePort()
    const dispatcher = new notices.TopicNoticeDispatcher({
      storeFor: () => store,
      port,
      clock: () => NOW,
      sleep: async () => { throw new Error('no sleep expected') },
    })
    await dispatcher.drain(repoPath)
    assert.equal(port.appends.length, 2, 'one append per target')
    assert.deepEqual(port.appends.map((entry) => entry.sessionId).sort(), ['session-master', 'session-topic'])
    assert.equal(port.appends[0].notice.noticeId, event.eventId)
    const ledger = await store.readNotices()
    assert.ok(ledger.notices.every((row) => row.status === 'delivered'), 'both rows are delivered')
    assert.ok(ledger.notices.every((row) => row.attempts === 1))

    // Replay is a no-op: delivered rows are never appended again.
    await dispatcher.drain(repoPath)
    assert.equal(port.appends.length, 2, 'a replay does not deliver twice')
    dispatcher.dispose()
  })
})

test('a >50-row activity tail does not hide an older pending notice', async () => {
  await withRepo(async (repoPath) => {
    const store = await openStore(repoPath)
    // The notice event lands first; 60 newer rows then push it past the default
    // 50-row read unless the dispatcher reads the whole stream.
    const event = await seedPending(store, { extra: 60 })
    assert.equal((await store.readActivity(50)).events.some((row) => row.eventId === event.eventId), false)
    assert.equal((await store.readActivity(500)).events.some(
      (row) => row.eventId === event.eventId,
    ), true)

    const port = fakePort()
    const dispatcher = new notices.TopicNoticeDispatcher({
      storeFor: () => store,
      port,
      clock: () => NOW,
    })
    await dispatcher.drain(repoPath)
    assert.equal(port.appends.length, 2, 'the old pending notice is still delivered')
    assert.ok((await store.readNotices()).notices.every((row) => row.status === 'delivered'))
    assert.equal((await store.readNotices()).notices.some((row) => row.status === 'failed'), false)
    dispatcher.dispose()
  })
})

test('delivery retries with the documented backoff and succeeds on a later attempt', async () => {
  await withRepo(async (repoPath) => {
    const store = await openStore(repoPath)
    await seedPending(store)
    const port = fakePort({ failTimes: 2 })
    const delays = []
    const dispatcher = new notices.TopicNoticeDispatcher({
      storeFor: () => store,
      port,
      clock: () => NOW,
      sleep: async (ms) => { delays.push(ms) },
    })
    await dispatcher.drain(repoPath)
    // The first row fails twice (1 s, 5 s) then succeeds; the fake's failure
    // budget is exhausted, so the second row delivers on its first attempt.
    assert.deepEqual(delays, [1000, 5000])
    assert.equal(port.appends.length, 2)
    const ledger = await store.readNotices()
    assert.ok(ledger.notices.every((row) => row.status === 'delivered'))
    assert.deepEqual(ledger.notices.map((row) => row.attempts).sort(), [1, 3])
    dispatcher.dispose()
  })
})

test('a row that never delivers is marked failed after five attempts and the drain never throws', async () => {
  await withRepo(async (repoPath) => {
    const store = await openStore(repoPath)
    await seedPending(store)
    const port = fakePort({ failAlways: true })
    const delays = []
    const errors = []
    const dispatcher = new notices.TopicNoticeDispatcher({
      storeFor: () => store,
      port,
      clock: () => NOW,
      sleep: async (ms) => { delays.push(ms) },
      log: (message) => errors.push(message),
    })
    await dispatcher.drain(repoPath)
    assert.deepEqual(delays, [1000, 5000, 30000, 30000, 1000, 5000, 30000, 30000])
    const ledger = await store.readNotices()
    assert.ok(ledger.notices.every((row) => row.status === 'failed'))
    assert.ok(ledger.notices.every((row) => row.attempts === 5))
    assert.ok(ledger.notices.every((row) => /host is down/.test(row.lastError)))
    assert.deepEqual(errors, [], 'an exhausted row is a value, not a log-only surprise')
    // The topic state is untouched by the failed delivery.
    const document = await store.readIndexDocument()
    assert.equal(document.topics.length, 0)
    dispatcher.dispose()
  })
})

test('B mode leaves every row pending and never calls the port', async () => {
  await withRepo(async (repoPath) => {
    const store = await openStore(repoPath)
    await seedPending(store)
    const fixture = new notices.FixtureTopicNoticePort()
    const dispatcher = new notices.TopicNoticeDispatcher({
      storeFor: () => store,
      port: fixture,
      clock: () => NOW,
    })
    await dispatcher.drain(repoPath)
    assert.equal(fixture.appended.length, 0)
    assert.ok((await store.readNotices()).notices.every((row) => row.status === 'pending'))
    dispatcher.dispose()
  })
})

test('a ledger row whose event is gone fails closed instead of being guessed', async () => {
  await withRepo(async (repoPath) => {
    const store = await openStore(repoPath)
    await store.appendActivity(buildActivityEvent({
      type: 'status-changed',
      topicId: 'session-topic',
      summary: 'other',
      details: {},
    }, NOW))
    await store.writeNotices({
      version: 1,
      notices: [{
        noticeId: 'event-missing',
        topicId: 'session-topic',
        target: 'master',
        status: 'pending',
        attempts: 0,
        lastError: null,
        updatedAt: NOW_ISO,
      }],
    })
    const port = fakePort()
    const dispatcher = new notices.TopicNoticeDispatcher({
      storeFor: () => store,
      port,
      clock: () => NOW,
    })
    await dispatcher.drain(repoPath)
    assert.equal(port.appends.length, 0)
    const row = (await store.readNotices()).notices[0]
    assert.equal(row.status, 'failed')
    assert.match(row.lastError, /activity event not found/)
    dispatcher.dispose()
  })
})

test('drains for one project are serialized, so events arrive in ledger order', async () => {
  await withRepo(async (repoPath) => {
    const store = await openStore(repoPath)
    const first = topicReportedActivity(topic({ title: 'first' }), { summary: 'one', kind: 'progress' }, NOW)
    const second = topicReportedActivity(topic({ title: 'second' }), { summary: 'two', kind: 'progress' }, NOW)
    await store.appendActivity(first)
    await notices.recordNoticesForEvent(store, first, NOW)
    await store.appendActivity(second)
    await notices.recordNoticesForEvent(store, second, NOW)
    const order = []
    const port = fakePort()
    const append = port.append.bind(port)
    port.append = async (sessionId, notice) => {
      order.push(notice.noticeId)
      await new Promise((settle) => setTimeout(settle, 1))
      return append(sessionId, notice)
    }
    const dispatcher = new notices.TopicNoticeDispatcher({
      storeFor: () => store,
      port,
      clock: () => NOW,
    })
    dispatcher.kick(repoPath)
    dispatcher.kick(repoPath)
    await dispatcher.drain(repoPath)
    const firstRows = order.slice(0, 2)
    assert.deepEqual(new Set(firstRows), new Set([first.eventId]), 'the first event is delivered first')
    assert.deepEqual(new Set(order.slice(2)), new Set([second.eventId]))
    assert.equal(order.length, 4, 'no event is delivered twice by the two kicks')
    dispatcher.dispose()
  })
})

test('noticeSummaries folds the decision into the original row and reads the ledger state', () => {
  const requested = authorizationRequestedActivity(topic(), { requestId: 'request-1', summary: 'may I?' }, new Date('2026-11-10T09:00:00.000Z'))
  const resolved = authorizationResolvedActivity(topic(), {
    requestId: 'request-1',
    noticeId: requested.eventId,
    decision: 'allow',
    summary: 'may I?',
  }, new Date('2026-11-10T09:05:00.000Z'))
  const ledger = {
    version: 1,
    notices: [{
      noticeId: requested.eventId,
      topicId: 'session-topic',
      target: 'master',
      status: 'pending',
      attempts: 0,
      lastError: null,
      updatedAt: NOW_ISO,
    }],
  }
  const rows = notices.noticeSummaries([requested, resolved], ledger)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].noticeId, requested.eventId)
  assert.equal(rows[0].status, 'allowed')
  assert.equal(rows[0].delivery.status, 'pending', 'the ledger is the delivery fact, not the card state')
  assert.equal(rows[0].createdAt, requested.time)
  assert.equal(rows[0].updatedAt, resolved.time)
})

test('archiving withdraws a pending authorization notice instead of leaving it pending', async () => {
  await withRepo(async (repoPath) => {
    const store = await openStore(repoPath)
    const requested = authorizationRequestedActivity(topic(), { requestId: 'request-1', summary: 'may I?' }, NOW)
    await store.appendActivity(requested)
    await notices.recordNoticesForEvent(store, requested, NOW)
    // Pretend the host delivered the master card (A2) while the topic card is
    // still pending: both must stop being actionable, only one is voided.
    const ledger = await store.readNotices()
    ledger.notices = ledger.notices.map((row) => (
      row.target === 'master' ? { ...row, status: 'delivered', attempts: 1 } : row
    ))
    await store.writeNotices(ledger)

    const port = fakePort()
    const document = {
      version: 2,
      projectId: 'p',
      masterSessionId: 'session-master',
      createdAt: CREATED_AT,
      topics: [],
      workItems: [],
    }
    const outcome = await notices.voidAuthorizationNotice({
      store,
      document,
      topicId: 'session-topic',
      requestId: 'request-1',
      now: NOW,
      port,
    })
    assert.equal(outcome.noticeId, requested.eventId)
    assert.equal(outcome.voided, 1, 'only the still-pending row is voided')
    const rows = await store.readNotices()
    assert.equal(rows.notices.find((row) => row.target === 'topic').status, 'void')
    assert.equal(rows.notices.find((row) => row.target === 'master').status, 'delivered')
    assert.deepEqual(port.updates.map((entry) => [entry.sessionId, entry.patch.status]), [
      ['session-master', 'void'],
      ['session-topic', 'void'],
    ], 'a delivered card is patched to void on the same noticeId')

    const archived = topicArchivedActivity(topic({ status: 'resolved' }), {
      by: 'user',
      voidedAuthorizationNoticeId: requested.eventId,
    }, NOW)
    const listing = notices.noticeSummaries([requested, archived], await store.readNotices())
    assert.equal(listing.length, 2, 'the archive has its own master notice')
    const withdrawn = listing.find((row) => row.noticeId === requested.eventId)
    assert.equal(withdrawn.status, 'void')
    assert.deepEqual(withdrawn.actions, [], 'a void notice offers no allow/deny action')
  })
})
