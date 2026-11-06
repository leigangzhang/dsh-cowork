import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  PANEL_REVIEW_SEVERITIES,
  PANEL_REVIEW_STATUSES,
  PANEL_REVIEW_VERDICTS,
  PANEL_STATUS_ORDER,
  countThreads,
  defaultSelectedThreadId,
  isPanelError,
  isPanelReviewSeverity,
  isPanelReviewStatus,
  isPanelReviewVerdict,
  isPanelThreadStatus,
  sortThreadsForPanel,
} from '../src/api-contract.ts'

const STORE_SOURCE = fileURLToPath(new URL('../src/store.ts', import.meta.url))

/**
 * Read the store's own lifecycle list. The type union is erased at runtime, so
 * the declaration is the only authoritative copy to pin the panel order to.
 */
async function storeThreadStatuses() {
  const source = await readFile(STORE_SOURCE, 'utf8')
  const match = /const THREAD_STATUSES: readonly ThreadStatus\[\] = \[([\s\S]*?)\]/.exec(source)
  assert.ok(match, 'src/store.ts must declare const THREAD_STATUSES: readonly ThreadStatus[]')
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1])
}

test('panel status order covers the store lifecycle minus archived', async () => {
  const storeStatuses = await storeThreadStatuses()
  assert.ok(storeStatuses.includes('archived'), 'the store still tracks archived threads')
  const listable = storeStatuses.filter((status) => status !== 'archived')
  assert.deepEqual(
    [...PANEL_STATUS_ORDER].sort(),
    [...listable].sort(),
    'the panel lists exactly the non-archived store statuses',
  )
  assert.deepEqual(
    storeStatuses.filter((status) => !PANEL_STATUS_ORDER.includes(status)),
    ['archived'],
    'archived is the only status the panel hides',
  )
})

test('sortThreadsForPanel orders by priority first, recency second', () => {
  // Deliberately built in reverse priority order: the projection must reorder.
  const threads = [
    { threadId: 'done', status: 'done', updatedAt: '2026-01-05T00:00:00.000Z' },
    { threadId: 'new', status: 'new', updatedAt: '2026-01-05T00:00:00.000Z' },
    { threadId: 'active', status: 'active', updatedAt: '2026-01-05T00:00:00.000Z' },
    { threadId: 'blocked', status: 'blocked', updatedAt: '2026-01-05T00:00:00.000Z' },
    { threadId: 'awaiting_review', status: 'awaiting_review', updatedAt: '2026-01-05T00:00:00.000Z' },
  ]
  assert.deepEqual(
    sortThreadsForPanel(threads).map((thread) => thread.status),
    [...PANEL_STATUS_ORDER],
    'status priority follows PANEL_STATUS_ORDER exactly',
  )
})

test('sortThreadsForPanel sorts one status by updatedAt descending', () => {
  const threads = [
    { threadId: 'old', status: 'active', updatedAt: '2026-01-01T00:00:00.000Z' },
    { threadId: 'newest', status: 'active', updatedAt: '2026-01-03T00:00:00.000Z' },
    { threadId: 'middle', status: 'active', updatedAt: '2026-01-02T00:00:00.000Z' },
  ]
  assert.deepEqual(
    sortThreadsForPanel(threads).map((thread) => thread.threadId),
    ['newest', 'middle', 'old'],
  )
})

test('sortThreadsForPanel is stable for equal timestamps and handles empty input', () => {
  assert.deepEqual(sortThreadsForPanel([]), [])
  const threads = [
    { threadId: 'first', status: 'blocked', updatedAt: '2026-01-01T00:00:00.000Z' },
    { threadId: 'second', status: 'blocked', updatedAt: '2026-01-01T00:00:00.000Z' },
    { threadId: 'third', status: 'blocked', updatedAt: '2026-01-01T00:00:00.000Z' },
  ]
  assert.deepEqual(
    sortThreadsForPanel(threads).map((thread) => thread.threadId),
    ['first', 'second', 'third'],
    'ties keep the input order',
  )
  const original = [...threads]
  sortThreadsForPanel(threads)
  assert.deepEqual(threads, original, 'the input array is not mutated')
})

test('countThreads zero-fills every listable status and never counts archived', () => {
  assert.deepEqual(countThreads([]), {
    new: 0, active: 0, awaiting_review: 0, blocked: 0, done: 0,
  })
  const threads = [
    { status: 'new' },
    { status: 'new' },
    { status: 'active' },
    { status: 'awaiting_review' },
    { status: 'done' },
    // A hand-written index can carry archived or unknown rows; neither is counted.
    { status: 'archived' },
    { status: 'unexpected' },
  ]
  const counts = countThreads(threads)
  assert.deepEqual(counts, { new: 2, active: 1, awaiting_review: 1, blocked: 0, done: 1 })
  assert.equal(Object.hasOwn(counts, 'archived'), false, 'archived has no chip')
})

test('defaultSelectedThreadId picks the first row, or null for an empty list', () => {
  assert.equal(defaultSelectedThreadId([]), null)
  assert.equal(
    defaultSelectedThreadId([{ threadId: 'b' }, { threadId: 'a' }]),
    'b',
    'selection follows the projection, it does not re-sort',
  )
})

test('isPanelThreadStatus accepts exactly the five listable statuses', () => {
  for (const status of PANEL_STATUS_ORDER) assert.equal(isPanelThreadStatus(status), true)
  assert.equal(isPanelThreadStatus('archived'), false)
  assert.equal(isPanelThreadStatus('unknown'), false)
  assert.equal(isPanelThreadStatus(undefined), false)
})

test('review states are their own union and never mix with thread statuses', () => {
  assert.deepEqual([...PANEL_REVIEW_STATUSES], ['pending', 'pass', 'needs_revision', 'reject'])
  assert.deepEqual([...PANEL_REVIEW_VERDICTS], ['pass', 'needs_revision', 'reject'])
  assert.deepEqual([...PANEL_REVIEW_SEVERITIES], ['blocker', 'high', 'medium', 'low'])

  for (const status of PANEL_REVIEW_STATUSES) assert.equal(isPanelReviewStatus(status), true)
  for (const status of PANEL_STATUS_ORDER) assert.equal(isPanelReviewStatus(status), false)
  assert.equal(isPanelReviewStatus('archived'), false)
  assert.equal(isPanelReviewStatus(undefined), false)
  assert.equal(isPanelReviewStatus(null), false)

  // A review state is never a thread status, and vice versa.
  for (const status of PANEL_REVIEW_STATUSES) assert.equal(isPanelThreadStatus(status), false)
  assert.equal(isPanelThreadStatus('pass'), false)
  assert.equal(isPanelThreadStatus('pending'), false)
  assert.equal(isPanelThreadStatus('awaiting_review'), true)

  // `pending` is a lifecycle state, never a recorded verdict.
  assert.equal(isPanelReviewVerdict('pending'), false)
  for (const verdict of PANEL_REVIEW_VERDICTS) assert.equal(isPanelReviewVerdict(verdict), true)
  assert.equal(isPanelReviewVerdict('approved'), false)

  assert.equal(isPanelReviewSeverity('blocker'), true)
  assert.equal(isPanelReviewSeverity('high'), true)
  assert.equal(isPanelReviewSeverity('medium'), true)
  assert.equal(isPanelReviewSeverity('low'), true)
  assert.equal(isPanelReviewSeverity('critical'), false)
})

test('review state does not change the panel order, counts or default selection', () => {
  assert.deepEqual(
    [...PANEL_STATUS_ORDER],
    ['awaiting_review', 'blocked', 'active', 'new', 'done'],
    'the list order still names thread statuses only',
  )
  const threads = [
    { threadId: 'a', status: 'done', updatedAt: '2026-01-02T00:00:00.000Z', reviewStatus: 'needs_revision' },
    { threadId: 'b', status: 'done', updatedAt: '2026-01-03T00:00:00.000Z', reviewStatus: 'pass' },
  ]
  const sorted = sortThreadsForPanel(threads)
  assert.deepEqual(
    sorted.map((thread) => thread.threadId),
    ['b', 'a'],
    'review state never reorders rows',
  )
  assert.deepEqual(countThreads(threads), {
    new: 0, active: 0, awaiting_review: 0, blocked: 0, done: 2,
  })
  assert.equal(defaultSelectedThreadId(sorted), 'b', 'the default row is still the first sorted row')
})

test('isPanelError recognizes the shared error envelope only', () => {
  assert.equal(isPanelError({ ok: false, error: { code: 'internal', message: 'x' } }), true)
  assert.equal(isPanelError({ ok: false, error: { code: 'store/corrupt' } }), true)
  // The M3L-1 timeout code rides the same envelope as every other failure; the
  // 504 status lives in the HTTP layer, not in the body.
  assert.equal(isPanelError({ ok: false, error: { code: 'session/list-timeout', message: 'x' } }), true)
  assert.equal(isPanelError({ ok: true }), false)
  assert.equal(isPanelError({ ok: false }), false, 'a bare ok:false is not the envelope')
  assert.equal(isPanelError({ ok: false, error: null }), false)
  assert.equal(isPanelError({ ok: false, error: { message: 'no code' } }), false)
  assert.equal(isPanelError(null), false)
  assert.equal(isPanelError('error'), false)
})
