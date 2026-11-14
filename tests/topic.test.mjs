import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * Contract tests for the pure three-state topic lifecycle, revised for the
 * topic page (2026-11-10): a 24 h idle window, no automatic resolution, and a
 * block that records and restores the status it interrupted.
 * `src/topic.ts` imports only types, so no resolve hook is needed.
 */
const topicModule = await import('../src/topic.ts')
const {
  DEFAULT_IDLE_AFTER_MS,
  DEFAULT_RESOLVE_AFTER_MS,
  archiveTopicRecord,
  blockTopic,
  evaluateTopicLifecycle,
  noteTopicActivity,
  reopenResolvedTopic,
  unblockTopic,
} = topicModule

const NOW_ISO = '2026-11-07T12:00:00.000Z'
const NOW_MS = Date.parse(NOW_ISO)
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const IDLE_AFTER_MS = 24 * HOUR
/** Kept only to prove the deprecated threshold no longer drives a transition. */
const RESOLVE_AFTER_MS = 3 * DAY
const CREATED_ISO = '2026-11-01T00:00:00.000Z'

/** An ISO timestamp `ms` before the injected now. */
const ago = (ms) => new Date(NOW_MS - ms).toISOString()

/** A v2 topic carrying every field the lifecycle reads. */
const topicV2 = (overrides = {}) => ({
  topicId: 'topic-a',
  title: 'wire the store',
  status: 'active',
  awaitingReview: false,
  blocked: false,
  blockedReason: null,
  blockedFromStatus: null,
  blockedAt: null,
  authorization: null,
  scope: 'store',
  ownedPaths: ['src/store/project-store.ts'],
  aliases: [],
  digest: 'store v2 is delivered',
  cwd: '/repo',
  legacyCheckoutPath: null,
  createdAt: CREATED_ISO,
  updatedAt: ago(IDLE_AFTER_MS + 1),
  lastActiveAt: ago(IDLE_AFTER_MS + 1),
  lastDeliveryConfirmedAt: ago(IDLE_AFTER_MS + 1),
  resolvedAt: null,
  resolvedBy: null,
  latestReviewRequestId: null,
  reviewStatus: null,
  reviewerSessionId: null,
  ...overrides,
})

/** A pending authorization, as `cowork_authorization_request` writes it. */
const authorization = () => ({
  requestId: 'request-1',
  summary: 'may the topic merge?',
  requestedAt: ago(MINUTE),
})

/** The evaluation input with the documented defaults. */
const context = (overrides = {}) => ({
  nowMs: NOW_MS,
  idleAfterMs: IDLE_AFTER_MS,
  ...overrides,
})

/** Freeze every object reachable from `value` so an in-place write throws. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}

test('the idle threshold is one day; the old resolve threshold is only kept for compatibility', () => {
  assert.equal(DEFAULT_IDLE_AFTER_MS, 24 * 60 * 60 * 1000)
  assert.equal(DEFAULT_RESOLVE_AFTER_MS, 3 * 24 * 60 * 60 * 1000, 'the constant still exists')
})

test('an active topic turns idle only after the 24-hour window', () => {
  const stale = (elapsed) => topicV2({ lastActiveAt: ago(elapsed) })

  assert.equal(evaluateTopicLifecycle(stale(IDLE_AFTER_MS - 1), context()).kind, 'none')
  assert.equal(evaluateTopicLifecycle(stale(IDLE_AFTER_MS), context()).kind, 'none')
  assert.equal(evaluateTopicLifecycle(stale(IDLE_AFTER_MS + 1), context()).kind, 'idle')
  assert.equal(evaluateTopicLifecycle(stale(3 * HOUR), context()).kind, 'none', '3 h is not idle any more')

  const changed = evaluateTopicLifecycle(stale(IDLE_AFTER_MS + 1), context())
  assert.equal(changed.kind, 'idle')
  assert.equal(changed.topic.status, 'idle')
  assert.equal(changed.topic.updatedAt, NOW_ISO)
  assert.equal(changed.topic.lastActiveAt, ago(IDLE_AFTER_MS + 1), 'last activity is not rewritten')
})

test('the lifecycle never resolves a topic on its own, however stale it is', () => {
  for (const elapsed of [RESOLVE_AFTER_MS, 30 * DAY, 365 * DAY]) {
    const transition = evaluateTopicLifecycle(topicV2({ lastActiveAt: ago(elapsed) }), context())
    assert.equal(transition.kind, 'idle', `an active topic goes idle after ${elapsed} ms`)
  }
  const idle = evaluateTopicLifecycle(
    topicV2({ status: 'idle', lastActiveAt: ago(RESOLVE_AFTER_MS) }),
    context(),
  )
  assert.deepEqual(idle, { kind: 'none' }, 'a stale idle topic stays idle')
})

test('awaitingReview, a block, and a pending authorization suppress idle', () => {
  const stale = (overrides) => topicV2({ lastActiveAt: ago(IDLE_AFTER_MS + 1), ...overrides })

  assert.equal(evaluateTopicLifecycle(stale({ awaitingReview: true }), context()).kind, 'none')
  assert.equal(
    evaluateTopicLifecycle(stale({ blocked: true, blockedReason: 'handoff' }), context()).kind,
    'none',
  )
  assert.equal(
    evaluateTopicLifecycle(stale({ blocked: true, blockedReason: 'authorization', authorization: authorization() }), context()).kind,
    'none',
  )
  // A pending authorization alone (even before the flag is derived) counts.
  assert.equal(evaluateTopicLifecycle(stale({ authorization: authorization() }), context()).kind, 'none')

  const idleBlocked = evaluateTopicLifecycle(
    stale({ status: 'idle', blocked: true, blockedReason: 'handoff' }),
    context(),
  )
  assert.equal(idleBlocked.kind, 'active')
  assert.equal(idleBlocked.topic.blocked, true, 'the flag survives the move')
})

test('new activity moves an idle topic back to active', () => {
  const idle = topicV2({ status: 'idle', lastActiveAt: ago(10 * MINUTE), updatedAt: ago(10 * MINUTE) })
  const changed = evaluateTopicLifecycle(idle, context())
  assert.equal(changed.kind, 'active')
  assert.equal(changed.topic.status, 'active')
  assert.equal(changed.topic.updatedAt, NOW_ISO)
})

test('blockTopic records the reason, the status to restore, and the first block time', () => {
  const idle = topicV2({ status: 'idle', lastActiveAt: ago(HOUR), updatedAt: ago(HOUR) })
  const blocked = blockTopic(idle, 'authorization', NOW_MS)
  assert.equal(blocked.status, 'active', 'a blocked topic is active in the lifecycle')
  assert.equal(blocked.blocked, true)
  assert.equal(blocked.blockedReason, 'authorization')
  assert.equal(blocked.blockedFromStatus, 'idle', 'the block restores idle')
  assert.equal(blocked.blockedAt, NOW_ISO)
  assert.equal(blocked.lastActiveAt, NOW_ISO)
  assert.equal(blocked.updatedAt, NOW_ISO)

  // A second block keeps the original restore point and block time.
  const later = NOW_MS + 5 * MINUTE
  const again = blockTopic(blocked, 'handoff', later)
  assert.equal(again.blockedReason, 'handoff', 'the reason moves to the newest one')
  assert.equal(again.blockedFromStatus, 'idle')
  assert.equal(again.blockedAt, NOW_ISO, 'the first block time is kept')
  assert.equal(reopenResolvedTopic(blocked, later), null, 'a blocked live topic is not resolvable by reopen')

  const resolved = topicV2({ status: 'resolved' })
  assert.equal(blockTopic(resolved, 'conflict', NOW_MS), resolved, 'an archived topic is not blockable')
})

test('unblockTopic restores the recorded status and clears the authorization', () => {
  const blocked = topicV2({
    status: 'active',
    blocked: true,
    blockedReason: 'authorization',
    blockedFromStatus: 'idle',
    blockedAt: ago(HOUR),
    authorization: authorization(),
    updatedAt: ago(HOUR),
  })
  const released = unblockTopic(blocked, NOW_MS)
  assert.equal(released.status, 'idle', 'the pre-block status comes back')
  assert.equal(released.blocked, false)
  assert.equal(released.blockedReason, null)
  assert.equal(released.blockedFromStatus, null)
  assert.equal(released.blockedAt, null)
  assert.equal(released.authorization, null)
  assert.equal(released.updatedAt, NOW_ISO)
  assert.equal(released.lastActiveAt, blocked.lastActiveAt, 'releasing a block is not activity')

  const live = topicV2()
  assert.equal(unblockTopic(live, NOW_MS), live, 'a topic that is not blocked is untouched')
})

test('archiveTopicRecord clears the block and the pending authorization, and is idempotent', () => {
  const blocked = topicV2({
    status: 'active',
    blocked: true,
    blockedReason: 'authorization',
    blockedFromStatus: 'idle',
    blockedAt: ago(HOUR),
    authorization: authorization(),
  })
  const archived = archiveTopicRecord(blocked, NOW_MS)
  assert.equal(archived.status, 'resolved')
  assert.equal(archived.resolvedAt, NOW_ISO)
  assert.equal(archived.resolvedBy, 'user')
  assert.equal(archived.blocked, false)
  assert.equal(archived.blockedReason, null)
  assert.equal(archived.blockedFromStatus, null)
  assert.equal(archived.blockedAt, null)
  assert.equal(archived.authorization, null, 'archiving voids the pending authorization')
  assert.equal(archived.updatedAt, NOW_ISO)

  const again = archiveTopicRecord(archived, NOW_MS + 1000)
  assert.equal(again, archived, 'an archived topic is not rewritten')
})

test('a resolved topic never changes through evaluation or new activity', () => {
  const resolved = topicV2({ status: 'resolved', resolvedAt: CREATED_ISO, resolvedBy: 'user' })
  assert.deepEqual(evaluateTopicLifecycle(resolved, context()), { kind: 'none' })
  assert.deepEqual(noteTopicActivity(resolved, NOW_MS), resolved)
})

test('noteTopicActivity stamps the activity time and returns to active', () => {
  const idle = topicV2({ status: 'idle', lastActiveAt: ago(HOUR), updatedAt: ago(HOUR) })
  const next = noteTopicActivity(idle, NOW_MS)
  assert.equal(next.status, 'active')
  assert.equal(next.lastActiveAt, NOW_ISO)
  assert.equal(next.updatedAt, NOW_ISO)
  assert.notEqual(next, idle)
})

test('reopening clears the resolution fields, the block, and returns to active', () => {
  const resolved = topicV2({
    status: 'resolved',
    resolvedAt: CREATED_ISO,
    resolvedBy: 'master',
    digest: 'delivered',
    lastDeliveryConfirmedAt: CREATED_ISO,
    authorization: null,
  })
  const reopened = reopenResolvedTopic(resolved, NOW_MS)
  assert.equal(reopened.status, 'active')
  assert.equal(reopened.resolvedAt, null)
  assert.equal(reopened.resolvedBy, null)
  assert.equal(reopened.lastActiveAt, NOW_ISO)
  assert.equal(reopened.updatedAt, NOW_ISO)
  assert.equal(reopened.digest, 'delivered', 'the summary survives')
  assert.equal(reopened.lastDeliveryConfirmedAt, CREATED_ISO, 'the delivery proof survives')

  assert.equal(reopenResolvedTopic(topicV2(), NOW_MS), null)
  assert.equal(reopenResolvedTopic(topicV2({ status: 'idle' }), NOW_MS), null)
})

test('the lifecycle functions never mutate their input', () => {
  const input = deepFreeze(topicV2({
    status: 'idle',
    blocked: true,
    blockedReason: 'authorization',
    blockedFromStatus: 'idle',
    authorization: authorization(),
  }))
  const snapshot = structuredClone(input)

  evaluateTopicLifecycle(input, context())
  noteTopicActivity(input, NOW_MS)
  blockTopic(input, 'handoff', NOW_MS)
  unblockTopic(input, NOW_MS)
  archiveTopicRecord(input, NOW_MS)
  reopenResolvedTopic(input, NOW_MS)

  assert.deepEqual(input, snapshot)
})

test('the module exposes no hidden state machine', () => {
  assert.deepEqual(Object.keys(topicModule).sort(), [
    'DEFAULT_IDLE_AFTER_MS',
    'DEFAULT_RESOLVE_AFTER_MS',
    'archiveTopicRecord',
    'blockTopic',
    'evaluateTopicLifecycle',
    'noteTopicActivity',
    'reopenResolvedTopic',
    'unblockTopic',
  ])
})
