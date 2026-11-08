import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * Contract tests for the pure three-state topic lifecycle (PLAN-V0.2 §2.3/§5.1,
 * M8.1). Every case injects the clock: `src/topic.ts` never reads one.
 *
 * `src/topic.ts` imports only types, so no resolve hook is needed here.
 */
const topicModule = await import('../src/topic.ts')
const {
  DEFAULT_IDLE_AFTER_MS,
  DEFAULT_RESOLVE_AFTER_MS,
  evaluateTopicLifecycle,
  noteTopicActivity,
  reopenResolvedTopic,
} = topicModule

const NOW_ISO = '2026-11-07T12:00:00.000Z'
const NOW_MS = Date.parse(NOW_ISO)
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const IDLE_AFTER_MS = 2 * HOUR
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
  scope: 'store',
  ownedPaths: ['src/store.ts'],
  aliases: [],
  digest: 'store v2 is delivered',
  cwd: '/repo',
  legacyCheckoutPath: null,
  createdAt: CREATED_ISO,
  updatedAt: ago(RESOLVE_AFTER_MS),
  lastActiveAt: ago(RESOLVE_AFTER_MS),
  lastDeliveryConfirmedAt: ago(RESOLVE_AFTER_MS),
  resolvedAt: null,
  resolvedBy: null,
  latestReviewRequestId: null,
  reviewStatus: null,
  reviewerSessionId: null,
  ...overrides,
})

/** The evaluation input with the documented defaults. */
const context = (overrides = {}) => ({
  nowMs: NOW_MS,
  idleAfterMs: IDLE_AFTER_MS,
  resolveAfterMs: RESOLVE_AFTER_MS,
  activeWorkItems: 0,
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

test('the documented thresholds are two hours and three days', () => {
  assert.equal(DEFAULT_IDLE_AFTER_MS, 2 * 60 * 60 * 1000)
  assert.equal(DEFAULT_RESOLVE_AFTER_MS, 3 * 24 * 60 * 60 * 1000)
})

test('an active topic turns idle only after the two-hour window', () => {
  const stale = (elapsed) => topicV2({ lastActiveAt: ago(elapsed) })

  assert.equal(evaluateTopicLifecycle(stale(IDLE_AFTER_MS - 1), context()).kind, 'none')
  assert.equal(evaluateTopicLifecycle(stale(IDLE_AFTER_MS), context()).kind, 'none')

  const changed = evaluateTopicLifecycle(stale(IDLE_AFTER_MS + 1), context())
  assert.equal(changed.kind, 'idle')
  assert.equal(changed.topic.status, 'idle')
  assert.equal(changed.topic.updatedAt, NOW_ISO)
  assert.equal(changed.topic.lastActiveAt, ago(IDLE_AFTER_MS + 1), 'last activity is not rewritten')
})

test('awaitingReview and blocked suppress idle and pull an idle topic back to active', () => {
  const stale = (overrides) =>
    topicV2({ lastActiveAt: ago(IDLE_AFTER_MS + 1), ...overrides })

  assert.equal(evaluateTopicLifecycle(stale({ awaitingReview: true }), context()).kind, 'none')
  assert.equal(evaluateTopicLifecycle(stale({ blocked: true }), context()).kind, 'none')

  const reviewIdle = evaluateTopicLifecycle(stale({ status: 'idle', awaitingReview: true }), context())
  assert.equal(reviewIdle.kind, 'active')
  assert.equal(reviewIdle.topic.status, 'active')
  assert.equal(reviewIdle.topic.awaitingReview, true, 'the flag survives the move')
  assert.equal(reviewIdle.topic.updatedAt, NOW_ISO)

  const blockedIdle = evaluateTopicLifecycle(stale({ status: 'idle', blocked: true }), context())
  assert.equal(blockedIdle.kind, 'active')
  assert.equal(blockedIdle.topic.blocked, true)
})

test('new activity moves an idle topic back to active', () => {
  const idle = topicV2({ status: 'idle', lastActiveAt: ago(10 * MINUTE), updatedAt: ago(10 * MINUTE) })
  const changed = evaluateTopicLifecycle(idle, context())
  assert.equal(changed.kind, 'active')
  assert.equal(changed.topic.status, 'active')
  assert.equal(changed.topic.updatedAt, NOW_ISO)
})

test('a topic is resolved only when all five conditions hold', () => {
  const old = ago(RESOLVE_AFTER_MS)

  // 1) an in-flight review: an active topic three days stale stays put, no idle.
  assert.equal(
    evaluateTopicLifecycle(topicV2({ awaitingReview: true, lastActiveAt: old }), context()).kind,
    'none',
  )
  // 2) the blocked flag: same suppression.
  assert.equal(evaluateTopicLifecycle(topicV2({ blocked: true, lastActiveAt: old }), context()).kind, 'none')
  // 3) an active work item: an idle topic so the idle rule cannot mask the answer.
  assert.equal(
    evaluateTopicLifecycle(topicV2({ status: 'idle', lastActiveAt: old }), context({ activeWorkItems: 1 }))
      .kind,
    'none',
  )
  // 4) no confirmed delivery.
  assert.equal(
    evaluateTopicLifecycle(
      topicV2({ status: 'idle', lastActiveAt: old, lastDeliveryConfirmedAt: null }),
      context(),
    ).kind,
    'none',
  )
  // 5) an empty or whitespace-only digest.
  assert.equal(
    evaluateTopicLifecycle(topicV2({ status: 'idle', lastActiveAt: old, digest: '' }), context()).kind,
    'none',
  )
  assert.equal(
    evaluateTopicLifecycle(topicV2({ status: 'idle', lastActiveAt: old, digest: '  \n\t ' }), context())
      .kind,
    'none',
  )
  // 6) one millisecond short of three days.
  assert.equal(
    evaluateTopicLifecycle(topicV2({ status: 'idle', lastActiveAt: ago(RESOLVE_AFTER_MS - 1) }), context())
      .kind,
    'none',
  )

  const resolved = evaluateTopicLifecycle(topicV2({ lastActiveAt: old }), context())
  assert.equal(resolved.kind, 'resolved')
  assert.equal(resolved.topic.status, 'resolved')
  assert.equal(resolved.topic.resolvedBy, 'master')
  assert.equal(resolved.topic.resolvedAt, NOW_ISO)
  assert.equal(resolved.topic.updatedAt, NOW_ISO)
  assert.equal(resolved.topic.lastActiveAt, old, 'resolution does not rewrite last activity')
})

test('the three-day threshold is inclusive and wins over idle', () => {
  const at = (elapsed) => topicV2({ lastActiveAt: ago(elapsed) })

  assert.equal(evaluateTopicLifecycle(at(RESOLVE_AFTER_MS - 1), context()).kind, 'idle')
  assert.equal(evaluateTopicLifecycle(at(RESOLVE_AFTER_MS), context()).kind, 'resolved')
  assert.equal(evaluateTopicLifecycle(at(RESOLVE_AFTER_MS + 1), context()).kind, 'resolved')
})

test('a resolved topic never changes through evaluation or new activity', () => {
  const resolved = topicV2({
    status: 'resolved',
    resolvedAt: CREATED_ISO,
    resolvedBy: 'user',
    lastActiveAt: ago(RESOLVE_AFTER_MS),
  })

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

test('reopening clears the resolution fields and returns to active', () => {
  const resolved = topicV2({
    status: 'resolved',
    resolvedAt: CREATED_ISO,
    resolvedBy: 'master',
    digest: 'delivered',
    lastDeliveryConfirmedAt: CREATED_ISO,
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
  const input = deepFreeze(topicV2({ lastActiveAt: ago(RESOLVE_AFTER_MS) }))
  const snapshot = structuredClone(input)

  evaluateTopicLifecycle(input, context())
  noteTopicActivity(input, NOW_MS)
  reopenResolvedTopic(input, NOW_MS)

  assert.deepEqual(input, snapshot)
})

test('the module exposes no undo path', () => {
  assert.deepEqual(Object.keys(topicModule).sort(), [
    'DEFAULT_IDLE_AFTER_MS',
    'DEFAULT_RESOLVE_AFTER_MS',
    'evaluateTopicLifecycle',
    'noteTopicActivity',
    'reopenResolvedTopic',
  ])
})
