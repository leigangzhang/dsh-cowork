import test from 'node:test'
import assert from 'node:assert/strict'
import './support/ts-hook.mjs'
/**
 * Contract tests for the M2/M3 E2E `parseIndex` helpers after M7: the drivers
 * still read `.dsh-cowork/index.json` directly, but the store now writes v2
 * (`topics[]` + `workItems[]`). Both parsers must keep accepting v1 unchanged
 * and project a v2 document through the same compatibility view the store uses,
 * so the E2E assertions keep seeing v1-shaped threads.
 *
 * `src/m2-e2e-support.ts` and `src/m3-e2e-support.ts` value-import the pure
 * `store-schema.js` / `store-migration.js` modules, so this test installs the
 * same resolve hook tests/review-verdict.test.mjs uses.
 */

const { parseIndex: parseM2Index } = await import('../src/m2-e2e-support.ts')
const { parseIndex: parseM3Index } = await import('../src/m3-e2e-support.ts')

const CREATED_AT = '2026-11-07T09:00:00.000Z'
const UPDATED_AT = '2026-11-07T10:00:00.000Z'

/** One v1 thread record, as the pre-M7 store wrote it. */
const threadV1 = (overrides = {}) => ({
  threadId: 'session-a',
  subject: 'wire the store',
  status: 'awaiting_review',
  cwd: '/repo',
  checkoutPath: '/repo/.dsh-cowork/threads/session-a',
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  lastHandoffAt: UPDATED_AT,
  reviewStatus: 'pending',
  reviewRequestedAt: UPDATED_AT,
  reviewedAt: null,
  reviewerSessionId: 'session-reviewer',
  latestReviewPath: '/repo/.dsh-cowork/reviews/session-a-1.json',
  ...overrides,
})

/** One v1 index document. */
const indexV1 = (threads, overrides = {}) => JSON.stringify({
  version: 1,
  projectId: 'project-1',
  masterSessionId: 'session-master',
  createdAt: CREATED_AT,
  threads,
  ...overrides,
})

/** One v2 topic with every field PLAN-V0.2 §4.3 requires. */
const topicV2 = (overrides = {}) => ({
  topicId: 'topic-a',
  title: 'wire the store',
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
  updatedAt: UPDATED_AT,
  lastActiveAt: UPDATED_AT,
  lastDeliveryConfirmedAt: null,
  resolvedAt: null,
  resolvedBy: null,
  latestReviewRequestId: null,
  reviewStatus: null,
  reviewerSessionId: null,
  ...overrides,
})

/** One v2 index document. */
const indexV2 = (topics, overrides = {}) => JSON.stringify({
  version: 2,
  projectId: 'project-1',
  masterSessionId: 'session-master',
  createdAt: CREATED_AT,
  topics,
  workItems: [],
  ...overrides,
})

const PARSERS = [
  ['m2', parseM2Index],
  ['m3', parseM3Index],
]

for (const [name, parseIndex] of PARSERS) {
  test(`${name} parseIndex keeps accepting a v1 index unchanged`, () => {
    const index = parseIndex(indexV1([threadV1()]))
    assert.equal(index.masterSessionId, 'session-master')
    assert.equal(index.threads.length, 1)
    assert.equal(index.threads[0].threadId, 'session-a')
    assert.equal(index.threads[0].subject, 'wire the store')
    assert.equal(index.threads[0].status, 'awaiting_review')
    assert.equal(index.threads[0].checkoutPath, '/repo/.dsh-cowork/threads/session-a')
    assert.equal(index.threads[0].reviewStatus, 'pending')
    assert.equal(index.threads[0].reviewerSessionId, 'session-reviewer')
  })

  test(`${name} parseIndex projects a v2 index through the store's compatibility view`, () => {
    const index = parseIndex(indexV2([
      topicV2({ topicId: 'topic-resolved', status: 'resolved', resolvedBy: 'master', resolvedAt: UPDATED_AT }),
      topicV2({ topicId: 'topic-blocked', blocked: true }),
      topicV2({ topicId: 'topic-review', awaitingReview: true, reviewStatus: 'pending' }),
      topicV2({ topicId: 'topic-idle', status: 'idle' }),
      topicV2({ topicId: 'topic-new', legacyStatus: 'new' }),
      topicV2({ topicId: 'topic-archived', status: 'resolved', legacyStatus: 'archived' }),
    ]))

    assert.equal(index.masterSessionId, 'session-master')
    assert.deepEqual(
      index.threads.map((thread) => [thread.threadId, thread.status]),
      [
        ['topic-resolved', 'done'],
        ['topic-blocked', 'blocked'],
        ['topic-review', 'awaiting_review'],
        ['topic-idle', 'active'],
        ['topic-new', 'new'],
        ['topic-archived', 'archived'],
      ],
    )
  })

  test(`${name} parseIndex carries the renamed and tolerated legacy fields`, () => {
    const index = parseIndex(indexV2([
      topicV2({
        topicId: 'topic-a',
        title: 'renamed topic',
        legacyCheckoutPath: '/repo/.dsh-cowork/threads/topic-a',
        reviewStatus: 'pass',
        reviewerSessionId: 'session-reviewer',
        lastHandoffAt: UPDATED_AT,
        reviewRequestedAt: UPDATED_AT,
        reviewedAt: UPDATED_AT,
        latestReviewPath: '/repo/.dsh-cowork/reviews/topic-a-2.json',
      }),
    ]))

    const thread = index.threads[0]
    assert.equal(thread.threadId, 'topic-a')
    assert.equal(thread.subject, 'renamed topic')
    assert.equal(thread.checkoutPath, '/repo/.dsh-cowork/threads/topic-a')
    assert.equal(thread.reviewStatus, 'pass')
    assert.equal(thread.reviewerSessionId, 'session-reviewer')
    assert.equal(thread.lastHandoffAt, UPDATED_AT)
    assert.equal(thread.reviewedAt, UPDATED_AT)
    assert.equal(thread.latestReviewPath, '/repo/.dsh-cowork/reviews/topic-a-2.json')
  })

  test(`${name} parseIndex rejects an invalid v2 document`, () => {
    // Unknown topic status: fail closed rather than guessing a v1 state.
    assert.equal(parseIndex(indexV2([topicV2({ status: 'done' })])), undefined)
    // Missing the required workItems array.
    assert.equal(parseIndex(JSON.stringify({
      version: 2,
      projectId: 'project-1',
      masterSessionId: 'session-master',
      createdAt: CREATED_AT,
      topics: [topicV2()],
    })), undefined)
    // Not a document at all.
    assert.equal(parseIndex('[]'), undefined)
  })

  test(`${name} parseIndex reports a half-written file as absent`, () => {
    assert.equal(parseIndex('{"version": 2, "topics": ['), undefined)
    assert.equal(parseIndex(''), undefined)
    assert.equal(parseIndex('not json'), undefined)
  })
}
