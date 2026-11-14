import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import '../support/ts-hook.mjs'
import { PANEL_PATHS } from '../support/public-surface.mjs'

const {
  ACTIVITY_DEFAULT_LIMIT,
  ACTIVITY_MAX_LIMIT,
  MAX_INBOX_ITEMS,
  MAX_PANEL_TOPICS,
  MAX_REQUEST_BODY_BYTES,
  MAX_REVIEW_CHANGED_PATHS,
  MAX_REVIEW_FINDINGS,
  MAX_REVIEW_VERIFICATION,
  MAX_SUMMARY_CHARS,
  MAX_TOPIC_OWNED_PATHS,
  MAX_TOPIC_REVIEW_REQUESTS,
  MAX_TOPIC_WORK_ITEMS,
  PANEL_REVIEW_SEVERITIES,
  PANEL_REVIEW_STATUSES,
  PANEL_BLOCKED_REASONS,
  PANEL_REVIEW_VERDICTS,
  PANEL_TOPIC_STATUS_ORDER,
  PANEL_WORK_ITEM_STATUSES,
  TOPIC_ACTIVITY_LIMIT,
  countPanel,
  defaultSelectedTopicId,
  isPanelBlockedReason,
  isPanelError,
  isPanelReviewSeverity,
  isPanelReviewStatus,
  isPanelReviewVerdict,
  isPanelTopicStatus,
  isPanelWorkItemStatus,
  sortTopicsForPanel,
  truncateSummary,
} = await import('../../src/panel/api-contract.ts')
const {
} = await import('../../src/panel/inbox-contract.ts')

const STORE_SCHEMA_SOURCE = fileURLToPath(new URL('../../src/store/schema.ts', import.meta.url))
const CONTRACT_SOURCE = fileURLToPath(new URL('../../src/panel/api-contract.ts', import.meta.url))

/** Read `src/store/schema.ts` once; it is the canonical home of the lifecycle lists. */
let schemaText
async function storeSchemaText() {
  if (schemaText === undefined) schemaText = await readFile(STORE_SCHEMA_SOURCE, 'utf8')
  return schemaText
}

/**
 * Pull one `export const NAME = ['a', 'b'] as const` list out of the store
 * schema source. The type unions are erased at runtime, so the declaration is
 * the only authoritative copy the wire schema can be pinned to.
 */
async function storeList(name) {
  const source = await storeSchemaText()
  const match = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const`).exec(source)
  assert.ok(match, `src/store/schema.ts must declare export const ${name} = [...] as const`)
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1])
}

/** A complete wire topic; every test overrides only the field it is about. */
function topic(overrides = {}) {
  return {
    topicId: 't',
    title: 'Topic',
    status: 'active',
    blocked: false,
    blockedReason: null,
    awaitingAuthorization: false,
    awaitingReview: false,
    reviewStatus: null,
    latestReviewRequestId: null,
    digest: '',
    scope: '',
    ownedPaths: [],
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastDeliveryConfirmedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    activeWorkItems: 0,
    ...overrides,
  }
}

/** A complete wire work item. */
function workItem(overrides = {}) {
  return {
    workItemId: 'w',
    topicId: 't',
    path: '/tmp/w',
    branch: 'dsh-wt/t/w',
    baseCommit: null,
    headCommit: null,
    status: 'active',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

test('the wire status unions are exactly the canonical store-schema lists', async () => {
  const pairs = [
    ['TOPIC_STATUSES', PANEL_TOPIC_STATUS_ORDER],
    ['WORK_ITEM_STATUSES', PANEL_WORK_ITEM_STATUSES],
    ['REVIEW_STATUSES', PANEL_REVIEW_STATUSES],
    ['REVIEW_VERDICTS', PANEL_REVIEW_VERDICTS],
    ['REVIEW_SEVERITIES', PANEL_REVIEW_SEVERITIES],
  ]
  for (const [name, wire] of pairs) {
    const store = await storeList(name)
    assert.deepEqual([...wire], store, `${name} must match the store-schema declaration in order`)
  }
  // The list priority order is a second fact, so keep it next to the lifecycle.
  assert.deepEqual([...PANEL_TOPIC_STATUS_ORDER], ['active', 'idle', 'resolved'])
  assert.deepEqual([...PANEL_BLOCKED_REASONS], await storeList('BLOCKED_REASONS'))
  assert.deepEqual([...PANEL_BLOCKED_REASONS], ['authorization', 'handoff', 'conflict'])
})

test('sortTopicsForPanel ranks blocked, awaitingAuthorization, then active/idle/resolved', () => {
  // Built in reverse priority order: the projection must reorder.
  const rows = [
    topic({ topicId: 'resolved', status: 'resolved' }),
    topic({ topicId: 'idle', status: 'idle' }),
    topic({ topicId: 'active', status: 'active' }),
    topic({ topicId: 'review-only', awaitingReview: true }),
    topic({ topicId: 'awaiting', awaitingReview: true, awaitingAuthorization: true }),
    topic({ topicId: 'blocked', blocked: true }),
  ]
  assert.deepEqual(
    sortTopicsForPanel(rows).map((row) => row.topicId),
    ['blocked', 'awaiting', 'active', 'review-only', 'idle', 'resolved'],
    'awaitingReview alone no longer changes the rank',
  )
})

test('the markers outrank status and blocked outranks awaitingAuthorization', () => {
  const rows = [
    topic({ topicId: 'resolved', status: 'resolved' }),
    topic({ topicId: 'review-resolved', status: 'resolved', awaitingReview: true }),
    topic({ topicId: 'active', status: 'active' }),
    topic({ topicId: 'blocked-idle', status: 'idle', blocked: true }),
    topic({ topicId: 'both', status: 'resolved', blocked: true, awaitingAuthorization: true }),
  ]
  assert.deepEqual(
    sortTopicsForPanel(rows).map((row) => row.topicId),
    ['blocked-idle', 'both', 'active', 'resolved', 'review-resolved'],
    'blocked rows lead, then awaited authorizations, then the plain topic states',
  )
})

test('one rank sorts by lastActiveAt first and updatedAt second, both descending', () => {
  const byActive = [
    topic({ topicId: 'old', lastActiveAt: '2026-01-01T00:00:00.000Z' }),
    topic({ topicId: 'newest', lastActiveAt: '2026-01-03T00:00:00.000Z' }),
    topic({ topicId: 'middle', lastActiveAt: '2026-01-02T00:00:00.000Z' }),
  ]
  assert.deepEqual(
    sortTopicsForPanel(byActive).map((row) => row.topicId),
    ['newest', 'middle', 'old'],
  )

  const byUpdated = [
    topic({ topicId: 'stale', updatedAt: '2026-01-01T00:00:00.000Z' }),
    topic({ topicId: 'fresh', updatedAt: '2026-01-05T00:00:00.000Z' }),
    topic({ topicId: 'middle', updatedAt: '2026-01-03T00:00:00.000Z' }),
  ]
  assert.deepEqual(
    sortTopicsForPanel(byUpdated).map((row) => row.topicId),
    ['fresh', 'middle', 'stale'],
    'updatedAt only decides when lastActiveAt ties',
  )

  const mixed = [
    // Same updatedAt, different lastActiveAt: recency of activity wins.
    topic({ topicId: 'later-updated-earlier-active', updatedAt: '2026-02-01T00:00:00.000Z', lastActiveAt: '2026-01-01T00:00:00.000Z' }),
    topic({ topicId: 'earlier-updated-later-active', updatedAt: '2026-01-15T00:00:00.000Z', lastActiveAt: '2026-01-20T00:00:00.000Z' }),
  ]
  assert.deepEqual(
    sortTopicsForPanel(mixed).map((row) => row.topicId),
    ['earlier-updated-later-active', 'later-updated-earlier-active'],
  )
})

test('sortTopicsForPanel is stable, handles empty input and never mutates its argument', () => {
  assert.deepEqual(sortTopicsForPanel([]), [])

  const rows = [
    topic({ topicId: 'first', blocked: true }),
    topic({ topicId: 'second', blocked: true }),
    topic({ topicId: 'third', blocked: true }),
  ]
  assert.deepEqual(
    sortTopicsForPanel(rows).map((row) => row.topicId),
    ['first', 'second', 'third'],
    'ties keep the input order',
  )
  const original = rows.map((row) => row.topicId)
  sortTopicsForPanel(rows)
  assert.deepEqual(rows.map((row) => row.topicId), original, 'the input array is not reordered')
})

test('sortTopicsForPanel tolerates unknown states and unparseable timestamps', () => {
  const rows = [
    topic({ topicId: 'archived', status: 'archived' }),
    topic({ topicId: 'active', status: 'active' }),
    topic({ topicId: 'resolved', status: 'resolved' }),
  ]
  assert.deepEqual(
    sortTopicsForPanel(rows).map((row) => row.topicId),
    ['active', 'resolved', 'archived'],
    'an invented state sorts after every known rank instead of throwing',
  )

  const times = [
    topic({ topicId: 'broken-active', lastActiveAt: 'not-a-date' }),
    topic({ topicId: 'valid-active', lastActiveAt: '2026-01-02T00:00:00.000Z' }),
    // Pre-epoch on purpose: an unparseable time must sort below a valid old one,
    // which a naive `0` fallback would get backwards.
    topic({ topicId: 'valid-ancient', lastActiveAt: '1960-01-01T00:00:00.000Z' }),
    topic({ topicId: 'broken-updated', lastActiveAt: 'not-a-date', updatedAt: 'not-a-date' }),
  ]
  assert.deepEqual(
    sortTopicsForPanel(times).map((row) => row.topicId),
    ['valid-active', 'valid-ancient', 'broken-active', 'broken-updated'],
    'unparseable times sort last inside their rank, still deterministically',
  )
})

test('countPanel zero-fills every wire field', () => {
  assert.deepEqual(countPanel([], []), {
    active: 0,
    idle: 0,
    resolved: 0,
    blocked: 0,
    awaitingAuthorization: 0,
    awaitingReview: 0,
    pendingReview: 0,
    workItemActive: 0,
    workItemReviewing: 0,
    workItemMerged: 0,
    workItemAbandoned: 0,
  })
})

test('countPanel counts topic states, resolved included, plus the markers', () => {
  const topics = [
    topic({ topicId: 'a1' }),
    topic({ topicId: 'a2', blocked: true }),
    topic({ topicId: 'i1', status: 'idle', awaitingReview: true, awaitingAuthorization: true }),
    topic({ topicId: 'r1', status: 'resolved', reviewStatus: 'pending' }),
  ]
  assert.deepEqual(countPanel(topics, []), {
    active: 2,
    idle: 1,
    resolved: 1,
    blocked: 1,
    awaitingAuthorization: 1,
    awaitingReview: 1,
    pendingReview: 1,
    workItemActive: 0,
    workItemReviewing: 0,
    workItemMerged: 0,
    workItemAbandoned: 0,
  })
  // A resolved row still carries its state chip; it is never folded away.
  assert.equal(countPanel([topic({ status: 'resolved' })], []).resolved, 1)
})

test('countPanel counts only the work items of the listed topics', () => {
  const topics = [
    topic({ topicId: 'a1' }),
    topic({ topicId: 'a2' }),
    topic({ topicId: 'i1', status: 'idle' }),
    topic({ topicId: 'r1', status: 'resolved' }),
  ]
  const items = [
    workItem({ workItemId: 'w1', topicId: 'a1', status: 'active' }),
    workItem({ workItemId: 'w2', topicId: 'i1', status: 'reviewing' }),
    workItem({ workItemId: 'w3', topicId: 'r1', status: 'merged' }),
    workItem({ workItemId: 'w4', topicId: 'a2', status: 'abandoned' }),
    // Not in `topics`: a stray record is ignored, not counted.
    workItem({ workItemId: 'stray', topicId: 'other', status: 'active' }),
    // An invented state is ignored too.
    workItem({ workItemId: 'weird', topicId: 'a1', status: 'unknown' }),
  ]
  const counts = countPanel(topics, items)
  assert.equal(counts.workItemActive, 1)
  assert.equal(counts.workItemReviewing, 1)
  assert.equal(counts.workItemMerged, 1)
  assert.equal(counts.workItemAbandoned, 1)
  const counted = counts.workItemActive + counts.workItemReviewing
    + counts.workItemMerged + counts.workItemAbandoned
  assert.equal(counted, 4, 'neither the stray topic nor the invented state is counted')
})

test('truncateSummary bounds long text to the default 200 code points', () => {
  const result = truncateSummary('x'.repeat(300))
  assert.equal(Array.from(result).length, MAX_SUMMARY_CHARS)
  assert.equal(result.endsWith('…'), true)
  assert.equal(result, `${'x'.repeat(MAX_SUMMARY_CHARS - 1)}…`)
})

test('truncateSummary keeps the 200/201 boundary exact', () => {
  const atLimit = 'y'.repeat(MAX_SUMMARY_CHARS)
  assert.equal(truncateSummary(atLimit), atLimit, 'exactly 200 code points is not truncated')

  const overLimit = 'y'.repeat(MAX_SUMMARY_CHARS + 1)
  const result = truncateSummary(overLimit)
  assert.equal(Array.from(result).length, MAX_SUMMARY_CHARS)
  assert.equal(result.endsWith('…'), true)
  assert.equal(result, `${'y'.repeat(MAX_SUMMARY_CHARS - 1)}…`)
})

test('truncateSummary flattens whitespace and counts code points, not UTF-16 units', () => {
  assert.equal(truncateSummary('  a\n\n b\t c  '), 'a b c', 'every whitespace run becomes one space')
  assert.equal(truncateSummary('line one\nline two\r\nline three'), 'line one line two line three')

  const chinese = truncateSummary('中'.repeat(300))
  assert.equal(Array.from(chinese).length, MAX_SUMMARY_CHARS)
  assert.equal(chinese.isWellFormed(), true)

  // An emoji is one code point but two UTF-16 units: the cap is code points.
  const emoji = truncateSummary('😀'.repeat(300))
  assert.equal(Array.from(emoji).length, MAX_SUMMARY_CHARS)
  assert.equal(emoji.endsWith('…'), true)
  assert.equal(emoji.isWellFormed(), true, 'truncation never splits a surrogate pair')

  // Collapsing happens before counting, so no summary can smuggle in a newline.
  const dense = truncateSummary(`${'a'.repeat(150)}\n${'b'.repeat(150)}`)
  assert.equal(Array.from(dense).length, MAX_SUMMARY_CHARS)
  assert.equal(dense.includes('\n'), false)
})

test('truncateSummary returns an empty string for non-strings and honours a custom limit', () => {
  for (const value of [undefined, null, 42, true, {}, [], () => 'x']) {
    assert.equal(truncateSummary(value), '', `non-string ${String(value)} becomes an empty summary`)
  }
  assert.equal(truncateSummary(''), '')
  assert.equal(truncateSummary('   \n\t '), '', 'whitespace-only text flattens to nothing')

  assert.equal(truncateSummary('abcdef', 4), 'abc…')
  assert.equal(truncateSummary('abcd', 4), 'abcd', 'a text at the custom limit is unchanged')
  assert.equal(Array.from(truncateSummary('abcdef', 1)).length, 1)
  assert.equal(truncateSummary('abcdef', 0), '')
})

test('the exported bounds keep the documented values and their relations', () => {
  assert.equal(MAX_PANEL_TOPICS, 500)
  assert.equal(ACTIVITY_DEFAULT_LIMIT, 50)
  assert.equal(ACTIVITY_MAX_LIMIT, 200)
  assert.equal(TOPIC_ACTIVITY_LIMIT, 50)
  assert.equal(MAX_TOPIC_WORK_ITEMS, 50)
  assert.equal(MAX_TOPIC_REVIEW_REQUESTS, 10)
  assert.equal(MAX_REVIEW_FINDINGS, 20)
  assert.equal(MAX_REVIEW_VERIFICATION, 10)
  assert.equal(MAX_REVIEW_CHANGED_PATHS, 50)
  assert.equal(MAX_TOPIC_OWNED_PATHS, 50)
  assert.equal(MAX_SUMMARY_CHARS, 200)
  assert.equal(MAX_INBOX_ITEMS, 20)
  assert.equal(MAX_REQUEST_BODY_BYTES, 8192)

  const bounds = [
    MAX_PANEL_TOPICS,
    ACTIVITY_DEFAULT_LIMIT,
    ACTIVITY_MAX_LIMIT,
    TOPIC_ACTIVITY_LIMIT,
    MAX_TOPIC_WORK_ITEMS,
    MAX_TOPIC_REVIEW_REQUESTS,
    MAX_REVIEW_FINDINGS,
    MAX_REVIEW_VERIFICATION,
    MAX_REVIEW_CHANGED_PATHS,
    MAX_TOPIC_OWNED_PATHS,
    MAX_SUMMARY_CHARS,
    MAX_INBOX_ITEMS,
    MAX_REQUEST_BODY_BYTES,
  ]
  for (const bound of bounds) {
    assert.equal(Number.isInteger(bound) && bound > 0, true, `${bound} must be a positive integer cap`)
  }
  assert.ok(ACTIVITY_DEFAULT_LIMIT <= ACTIVITY_MAX_LIMIT, 'the default activity limit fits under the maximum')
  assert.ok(TOPIC_ACTIVITY_LIMIT <= ACTIVITY_MAX_LIMIT, 'a topic tail never exceeds the activity maximum')
  assert.ok(MAX_INBOX_ITEMS <= MAX_PANEL_TOPICS, 'the inbox is a subset of one overview response')
  assert.equal(MAX_REQUEST_BODY_BYTES, 8 * 1024, 'the write body cap is 8 KiB')
})

test('the ten route paths are unique, absolute and stable', () => {
  const paths = [...PANEL_PATHS]
  assert.deepEqual(paths, [
    '/api/cowork.overview',
    '/api/cowork.activity',
    '/api/cowork.topic',
    '/api/cowork.topic.resolve',
    '/api/cowork.topic.reopen',
    '/api/cowork.route.move',
    '/api/cowork.authorization.resolve',
    '/api/cowork.inbox',
    '/api/cowork.inbox.resolve',
    '/api/cowork.inbox.open',
  ])
  assert.equal(new Set(paths).size, paths.length, 'every route has its own path')
  for (const path of paths) assert.equal(path.startsWith('/api/'), true, `${path} stays below /api`)
  assert.equal(paths.includes('/api/cowork.handoff'), false, 'the legacy route is gone')
  // The inbox half owns its three paths in `src/panel/inbox-contract.ts`; the shared
  // registration list above is their one home in the suite.
  for (const path of ['/api/cowork.inbox', '/api/cowork.inbox.resolve', '/api/cowork.inbox.open']) {
    assert.equal(paths.includes(path), true, `the inbox path ${path} is registered`)
  }
})

test('isPanelError recognizes the shared error envelope only', () => {
  assert.equal(isPanelError({ ok: false, error: { code: 'internal', message: 'x' } }), true)
  assert.equal(isPanelError({ ok: false, error: { code: 'store/corrupt' } }), true)
  assert.equal(
    isPanelError({ ok: false, error: { code: 'topic/not-found', message: 'missing', path: 'topic-1' } }),
    true,
    'the optional path rides the same envelope',
  )
  // Write-route codes are ordinary envelope codes; the HTTP status lives in the layer.
  for (const code of [
    'request/topic-required',
    'request/not-master',
    'request/content-type',
    'request/origin',
    'route/move-invalid',
    'topic/not-resolved',
  ]) {
    assert.equal(isPanelError({ ok: false, error: { code, message: 'x' } }), true)
  }
  assert.equal(isPanelError({ ok: true }), false)
  assert.equal(isPanelError({ ok: false }), false, 'a bare ok:false is not the envelope')
  assert.equal(isPanelError({ ok: false, error: null }), false)
  assert.equal(isPanelError({ ok: false, error: { message: 'no code' } }), false)
  assert.equal(isPanelError(null), false)
  assert.equal(isPanelError('error'), false)
})

test('every status guard accepts its own members and rejects everything else', () => {
  const guards = [
    [isPanelTopicStatus, PANEL_TOPIC_STATUS_ORDER],
    [isPanelWorkItemStatus, PANEL_WORK_ITEM_STATUSES],
    [isPanelReviewStatus, PANEL_REVIEW_STATUSES],
    [isPanelReviewVerdict, PANEL_REVIEW_VERDICTS],
    [isPanelReviewSeverity, PANEL_REVIEW_SEVERITIES],
    [isPanelBlockedReason, PANEL_BLOCKED_REASONS],
  ]
  for (const [guard, members] of guards) {
    for (const member of members) assert.equal(guard(member), true, `${String(member)} must be accepted`)
    for (const value of ['archived', 'unknown', '', 'Active', 'PENDING', null, undefined, 0, {}, []]) {
      assert.equal(guard(value), false, `${String(value)} must be rejected`)
    }
  }
  // The vocabularies do not bleed into each other.
  assert.equal(isPanelTopicStatus('pass'), false)
  assert.equal(isPanelWorkItemStatus('resolved'), false)
  assert.equal(isPanelReviewStatus('active'), false)
  assert.equal(isPanelReviewVerdict('pending'), false, 'pending is a request state, never a verdict')
  for (const verdict of PANEL_REVIEW_VERDICTS) assert.equal(isPanelReviewStatus(verdict), true)
  assert.equal(isPanelReviewSeverity('critical'), false)
  assert.equal(isPanelBlockedReason('blocked'), false)
  assert.equal(isPanelBlockedReason(null), false)
})

test('defaultSelectedTopicId picks the first row, or null for an empty list', () => {
  assert.equal(defaultSelectedTopicId([]), null)
  assert.equal(
    defaultSelectedTopicId([{ topicId: 'b' }, { topicId: 'a' }]),
    'b',
    'selection follows the projection, it does not re-sort',
  )
})

test('the contract carries no v1 vocabulary, only the pure inbox import, and stays inside the size cap', async () => {
  const source = await readFile(CONTRACT_SOURCE, 'utf8')
  for (const symbol of [
    'PanelThread',
    'PanelHandoff',
    'HANDOFF_PATH',
    'HANDOFF_FORMATTER_VERSION',
    'sortThreadsForPanel',
    'countThreads',
    'THREAD',
    "'request/thread-required'",
    "'handoff/not-found'",
  ]) {
    assert.equal(source.includes(symbol), false, `src/api-contract.ts must not mention ${symbol}`)
  }
  assert.deepEqual(
    [...source.matchAll(/^import\b[^\n]*$/gm)].map((match) => match[0]),
    [
      "import { INBOX_ERROR_STATUS } from './inbox-contract.js'",
      "import type { InboxErrorCode } from './inbox-contract.js'",
    ],
    'the only import is the pure inbox vocabulary',
  )
  assert.equal(source.includes('node:'), false, 'no node builtin reaches the client bundle')
  assert.ok(Buffer.byteLength(source, 'utf8') < 51_200, 'src/api-contract.ts stays below the 50 KiB read cap')
})
