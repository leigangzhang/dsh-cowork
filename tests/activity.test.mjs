import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import './support/ts-hook.mjs'
/**
 * M8.3 contract tests for business activity events (A5): the builders stamp
 * the injected clock and structured details, and recording reuses the M7 file
 * layer — 500 events / 512 KiB bounds and damaged-line skipping — instead of
 * re-implementing it. Cases run on a throwaway repository under os.tmpdir().
 */

const { ProjectStore } = await import('../src/store.ts')
const {
  buildActivityEvent,
  errorActivity,
  recordActivity,
  requestCreatedActivity,
  requestResolvedActivity,
  statusChangedActivity,
  topicReopenedActivity,
} = await import('../src/activity.ts')

const CREATED_AT = '2026-11-05T03:04:05.006Z'
const NOW = new Date('2026-11-08T10:11:12.013Z')
const NOW_ISO = NOW.toISOString()

/** Run one case inside a throwaway directory that is always removed. */
async function withTempDir(run) {
  const path = await mkdtemp(join(tmpdir(), 'dsh-cowork-activity-'))
  try {
    return await run(path)
  } finally {
    await rm(path, { recursive: true, force: true })
  }
}

/** A clock frozen at one instant. */
const clockAt = (iso) => () => new Date(iso)

/** A full v2 topic record. */
const topicV2 = (overrides = {}) => ({
  topicId: 'session-a',
  title: 'canonical work',
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

/** One valid event with a deterministic id, for seeding a stream. */
const seedEvent = (id, overrides = {}) => ({
  eventId: `event-${id}`,
  time: CREATED_AT,
  type: 'topic-created',
  topicId: 'session-a',
  summary: `seeded ${id}`,
  details: {},
  ...overrides,
})

test('buildActivityEvent stamps the injected clock, a fresh id, and details', () => {
  const first = buildActivityEvent(
    { type: 'status-changed', topicId: 'session-a', summary: 'went idle' },
    NOW,
  )
  assert.equal(first.time, NOW_ISO)
  assert.equal(first.type, 'status-changed')
  assert.equal(first.topicId, 'session-a')
  assert.equal(first.summary, 'went idle')
  assert.deepEqual(first.details, {}, 'details default to an empty object')
  assert.match(first.eventId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

  const second = buildActivityEvent(
    { type: 'error', topicId: null, summary: 'boom', details: { code: 'store/corrupt' } },
    NOW,
  )
  assert.notEqual(second.eventId, first.eventId, 'every event gets its own id')
  assert.equal(second.topicId, null)
  assert.deepEqual(second.details, { code: 'store/corrupt' })
})

test('buildActivityEvent refuses an unknown type or a blank summary', () => {
  assert.throws(
    () => buildActivityEvent({ type: 'not-a-type', topicId: null, summary: 'x' }, NOW),
    /activity\.type must be one of topic-created\|/,
  )
  for (const summary of ['', '   ', '\n\t']) {
    assert.throws(
      () => buildActivityEvent({ type: 'error', topicId: null, summary }, NOW),
      /activity\.summary must be a non-empty string/,
    )
  }
})

test('recordActivity appends through the sink and returns the written event', async () => {
  const appended = []
  const sink = {
    async appendActivity(event) {
      appended.push(event)
    },
  }
  const event = await recordActivity(
    sink,
    { type: 'review-verdict', topicId: 'session-a', summary: 'review passed' },
    NOW,
  )
  assert.deepEqual(appended, [event], 'the returned event is the appended one')
  assert.equal(appended[0].time, NOW_ISO)
})

test('recordActivity appends nothing when the input is invalid', async () => {
  const appended = []
  const sink = {
    async appendActivity(event) {
      appended.push(event)
    },
  }
  await assert.rejects(
    recordActivity(sink, { type: 'not-a-type', topicId: null, summary: 'x' }, NOW),
    /activity\.type/,
  )
  assert.deepEqual(appended, [])
})

test('topicReopenedActivity records the resolution the reopen cleared', () => {
  const topic = topicV2({
    status: 'resolved',
    resolvedAt: '2026-11-07T11:22:33.444Z',
    resolvedBy: 'master',
  })
  const event = topicReopenedActivity(topic, NOW)

  assert.equal(event.type, 'topic-reopened')
  assert.equal(event.topicId, 'session-a')
  assert.equal(event.time, NOW_ISO)
  assert.match(event.summary, /session-a/)
  assert.deepEqual(event.details, {
    topicId: 'session-a',
    resolvedAt: '2026-11-07T11:22:33.444Z',
    resolvedBy: 'master',
  })
})

test('statusChangedActivity and errorActivity are thin, structured builders', () => {
  const topic = topicV2()
  const changed = statusChangedActivity(topic, { from: 'active', to: 'idle' }, NOW)
  assert.equal(changed.type, 'status-changed')
  assert.equal(changed.topicId, 'session-a')
  assert.deepEqual(changed.details, { topicId: 'session-a', from: 'active', to: 'idle' })

  const failed = errorActivity('session-a', 'could not archive reviewer', NOW, {
    reviewerSessionId: 'session-reviewer',
  })
  assert.equal(failed.type, 'error')
  assert.equal(failed.topicId, 'session-a')
  assert.equal(failed.summary, 'could not archive reviewer')
  assert.deepEqual(failed.details, { reviewerSessionId: 'session-reviewer' })
})

test('a topic-reopened event is accepted by the real activity stream', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(NOW_ISO), projectId: 'p' })
    const topic = topicV2({ status: 'resolved', resolvedAt: CREATED_AT, resolvedBy: 'master' })
    const event = topicReopenedActivity(topic, NOW)

    await store.appendActivity(event)

    const read = await store.readActivity()
    assert.equal(read.skippedLines, 0)
    assert.deepEqual(read.events, [event])
    assert.equal(await readFile(store.activityFile, 'utf8'), `${JSON.stringify(event)}\n`)
  })
})

test('recording reuses the 500-event bound and repairs damaged lines', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(NOW_ISO), projectId: 'p' })
    await mkdir(store.projectDir, { recursive: true })
    const seeded = Array.from({ length: 500 }, (_, index) => JSON.stringify(seedEvent(`old-${index}`)))
    // Two damaged lines: a non-JSON row and a valid JSON row with a bad type.
    const damaged = ['not json', JSON.stringify(seedEvent('bad-type', { type: 'not-a-type' }))]
    await writeFile(store.activityFile, `${[...damaged, ...seeded].join('\n')}\n`, 'utf8')

    const before = await store.readActivity(1000)
    assert.equal(before.skippedLines, 2, 'a damaged line is skipped, not fatal')
    assert.equal(before.events.length, 500)

    const written = await recordActivity(
      store,
      { type: 'status-changed', topicId: 'session-a', summary: 'newest' },
      NOW,
    )
    const after = await store.readActivity(1000)
    assert.equal(after.skippedLines, 0, 'the append repairs the stream')
    assert.equal(after.events.length, 500)
    assert.deepEqual(after.events.at(-1), written)
    assert.equal(after.events[0].eventId, 'event-old-1', 'the oldest row was dropped')
  })
})

test('recording reuses the 512-KiB bound', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(NOW_ISO), projectId: 'p' })
    await mkdir(store.projectDir, { recursive: true })
    const big = (id) => JSON.stringify(seedEvent(id, { summary: 'x'.repeat(300000) }))
    const seeded = `${big('big-1')}\n${big('big-2')}\n`
    await writeFile(store.activityFile, seeded, 'utf8')

    await recordActivity(store, { type: 'status-changed', topicId: null, summary: 'small' }, NOW)

    const size = (await stat(store.activityFile)).size
    assert.ok(size <= 524288, `activity file is ${size} bytes`)
    const read = await store.readActivity(1000)
    assert.equal(read.events.at(-1).summary, 'small')
    assert.equal(read.events.length, 2, 'the oldest 300 KB row is dropped, the newest is kept')
    assert.equal(read.events[0].eventId, 'event-big-2')
  })
})

test('the request activity rows carry the request facts and no notice descriptor', () => {
  const record = {
    version: 1,
    requestId: 'req-1',
    projectId: 'p',
    topicId: 'session-a',
    kind: 'user-review',
    status: 'pending',
    title: 'canonical work',
    summary: 'review it',
    requestMessage: '主题「canonical work」请你审核：review it',
    resolutionMessage: null,
    payload: { purpose: 'review it' },
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    resolvedAt: null,
    resolvedBy: null,
    delivery: { promptedAt: null, lastError: null },
  }
  const created = requestCreatedActivity(record, NOW)
  assert.equal(created.type, 'request-created')
  assert.equal(created.topicId, 'session-a')
  assert.equal(created.time, NOW_ISO)
  assert.deepEqual(created.details, {
    requestId: 'req-1',
    topicId: 'session-a',
    kind: 'user-review',
    status: 'pending',
  })
  // No `notice` descriptor: creating a request must not grow the notice ledger.
  assert.equal('notice' in created.details, false)

  const resolved = requestResolvedActivity(
    { ...record, status: 'returned', resolutionMessage: '已退回评审。', resolvedAt: NOW_ISO, resolvedBy: 'user' },
    { action: 'return' },
    NOW,
  )
  assert.equal(resolved.type, 'request-resolved')
  assert.deepEqual(resolved.details, {
    requestId: 'req-1',
    topicId: 'session-a',
    kind: 'user-review',
    action: 'return',
    status: 'returned',
    resolvedBy: 'user',
  })
  assert.equal('notice' in resolved.details, false)

  const voided = requestResolvedActivity(
    { ...record, status: 'void', resolutionMessage: '已作废。', resolvedAt: NOW_ISO, resolvedBy: 'user' },
    { action: null },
    NOW,
  )
  assert.equal(voided.details.action, null)
  assert.equal(voided.details.status, 'void')
})
