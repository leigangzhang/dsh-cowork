import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_ROUTE_THRESHOLD,
  decideRoute,
  rankThreads,
  scoreThread,
  tokenize,
} from '../src/router.ts'

const MS_PER_DAY = 86_400_000
const NOW = new Date('2026-11-05T00:00:00.000Z')

const at = (daysAgo) => new Date(NOW.getTime() - daysAgo * MS_PER_DAY).toISOString()

/** A routable thread; defaults are the "healthy, just touched" shape. */
const thread = (overrides = {}) => ({
  threadId: 't1',
  subject: '',
  status: 'active',
  updatedAt: at(0),
  lastHandoffSummary: null,
  ...overrides,
})

test('tokenize lowercases ASCII words and splits on punctuation', () => {
  assert.deepEqual(tokenize('Hello, World 42!'), ['hello', 'world', '42'])
  assert.deepEqual(tokenize('foo_bar/baz'), ['foo', 'bar', 'baz'])
  assert.deepEqual(tokenize('   '), [])
  assert.deepEqual(tokenize(''), [])
  // dedupe keeps the first occurrence, not the last
  assert.deepEqual(tokenize('Bug bug BUG fix'), ['bug', 'fix'])
})

test('tokenize turns CJK runs into bigrams and keeps lone characters', () => {
  assert.deepEqual(tokenize('修复路由'), ['修复', '复路', '路由'])
  assert.deepEqual(tokenize('修复 路由'), ['修复', '路由'])
  assert.deepEqual(tokenize('看'), ['看'])
  assert.deepEqual(tokenize('看 a'), ['看', 'a'])
  assert.deepEqual(tokenize('修复 router bug'), ['修复', 'router', 'bug'])
  // a bigram repeated across runs is emitted once, at its first position
  assert.deepEqual(tokenize('路由 路由器'), ['路由', '由器'])
})

test('scoreThread counts subject and handoff-summary overlap separately', () => {
  const scored = scoreThread('fix router crash', thread({
    subject: 'router crash',
    lastHandoffSummary: 'fix the router',
  }), { now: NOW })

  assert.equal(scored.score, 11)
  assert.deepEqual(scored.breakdown, {
    subjectOverlap: 2,
    keywordOverlap: 2,
    statusPenalty: 0,
    recencyBonus: 1,
    total: 11,
  })
  assert.equal(scored.threadId, 't1')
  assert.equal(scored.status, 'active')
})

test('scoreThread applies blocked and awaiting_review penalties', () => {
  const intent = 'router'
  const blocked = scoreThread(intent, thread({ subject: 'router', status: 'blocked' }), { now: NOW })
  const review = scoreThread(intent, thread({ subject: 'router', status: 'awaiting_review' }), { now: NOW })
  const fresh = scoreThread(intent, thread({ subject: 'router', status: 'new' }), { now: NOW })

  assert.equal(blocked.breakdown.statusPenalty, -1)
  assert.equal(blocked.score, 3)
  assert.equal(review.breakdown.statusPenalty, -0.5)
  assert.equal(review.score, 3.5)
  assert.equal(fresh.score, 4)
  assert.equal(fresh.breakdown.statusPenalty, 0)
})

test('recency bonus honours the exact 7-day and 30-day boundaries', () => {
  const bonus = (updatedAt) =>
    scoreThread('router', thread({ subject: 'router', updatedAt }), { now: NOW }).breakdown.recencyBonus

  assert.equal(bonus(at(0)), 1)
  assert.equal(bonus(at(7)), 1) // exactly 7 days still counts as recent
  assert.equal(bonus(new Date(NOW.getTime() - 7 * MS_PER_DAY - 1).toISOString()), 0.5)
  assert.equal(bonus(at(30)), 0.5) // exactly 30 days still earns the half bonus
  assert.equal(bonus(new Date(NOW.getTime() - 30 * MS_PER_DAY - 1).toISOString()), 0)
  assert.equal(bonus('not-a-date'), 0)
  assert.equal(bonus(at(-3)), 1) // future timestamp (clock skew) counts as today
})

test('rankThreads excludes done and archived threads', () => {
  const ranked = rankThreads('router crash', [
    thread({ threadId: 'live', subject: 'router crash' }),
    thread({ threadId: 'done', subject: 'router crash', status: 'done' }),
    thread({ threadId: 'archived', subject: 'router crash', status: 'archived' }),
  ], { now: NOW })

  assert.deepEqual(ranked.map((candidate) => candidate.threadId), ['live'])

  // A matching thread that is finished must not be reused either.
  const decision = decideRoute('router crash', [
    thread({ threadId: 'done', subject: 'router crash', status: 'done' }),
  ], { now: NOW })
  assert.equal(decision.action, 'create')
  assert.deepEqual(decision.candidates, [])
})

test('rankThreads orders by score descending, then threadId ascending', () => {
  const ranked = rankThreads('alpha beta', [
    thread({ threadId: 'b', subject: 'alpha' }),
    thread({ threadId: 'c', subject: 'alpha beta' }),
    thread({ threadId: 'a', subject: 'alpha' }),
  ], { now: NOW })

  assert.deepEqual(ranked.map((candidate) => candidate.threadId), ['c', 'a', 'b'])
  assert.deepEqual(ranked.map((candidate) => candidate.score), [7, 4, 4])
})

test('decideRoute reuses a single thread whose score equals the threshold', () => {
  const decision = decideRoute('alpha', [thread({ threadId: 't1', subject: 'alpha' })], { now: NOW })

  assert.equal(DEFAULT_ROUTE_THRESHOLD, 4)
  assert.equal(decision.action, 'reuse')
  assert.equal(decision.threadId, 't1')
  assert.equal(decision.score, 4)
  assert.equal(decision.candidates.length, 1)
  assert.equal(decision.candidates[0].breakdown.total, 4)

  // Just above the threshold nothing is reused.
  const raised = decideRoute('alpha', [thread({ threadId: 't1', subject: 'alpha' })], {
    now: NOW,
    threshold: 4.5,
  })
  assert.equal(raised.action, 'create')
})

test('decideRoute refuses a tie because the margin is not met', () => {
  const threads = [
    thread({ threadId: 'b', subject: 'beta' }),
    thread({ threadId: 'a', subject: 'alpha' }),
  ]
  const tied = decideRoute('alpha beta', threads, { now: NOW })

  assert.equal(tied.action, 'create')
  assert.deepEqual(tied.candidates.map((candidate) => [candidate.threadId, candidate.score]), [
    ['a', 4],
    ['b', 4],
  ])

  // A tie is still resolvable when the caller explicitly asks for no margin.
  const noMargin = decideRoute('alpha beta', threads, { now: NOW, requireMargin: 0 })
  assert.equal(noMargin.action, 'reuse')
  assert.equal(noMargin.threadId, 'a')

  // Exactly one point of separation is enough.
  const separated = decideRoute('alpha beta', [
    thread({ threadId: 'top', subject: 'alpha' }),
    thread({ threadId: 'stale', subject: 'beta', updatedAt: at(40) }),
  ], { now: NOW })
  assert.equal(separated.action, 'reuse')
  assert.equal(separated.threadId, 'top')
  assert.equal(separated.score - separated.candidates[1].score, 1)
})

test('decideRoute creates for unrelated intents and asks for a subject', () => {
  const threads = [thread({ threadId: 'router', subject: 'router crash' })]
  const decision = decideRoute('quantum chromodynamics', threads, { now: NOW })

  assert.equal(decision.action, 'create')
  // The unrelated thread is still reported, scored on recency alone.
  assert.deepEqual(decision.candidates.map((candidate) => [candidate.threadId, candidate.score]), [
    ['router', 1],
  ])

  const withoutSubject = decideRoute('quantum chromodynamics', threads, {
    now: NOW,
    hasSubject: false,
  })
  assert.equal(withoutSubject.action, 'needs_subject')
  assert.deepEqual(
    withoutSubject.candidates.map((candidate) => candidate.threadId),
    decision.candidates.map((candidate) => candidate.threadId),
  )
})
