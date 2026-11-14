import test from 'node:test'
import assert from 'node:assert/strict'
import '../support/ts-hook.mjs'
/**
 * Contract tests for the v1 → v2 index migration and the v1 compatibility view
 * the unchanged v1 tools keep using (PLAN-V0.2 §5.2, A1).
 *
 * `src/store/migration.ts` value-imports `./store-schema.js`, so this test
 * installs the same resolve hook tests/review-verdict.test.mjs uses. Every
 * fixture is an in-memory object: nothing here touches `.dsh-cowork/`.
 */

const { MigrationError, applyLegacyView, isLegacyIndexDocument, legacyViewOf, migrateV1ToV2 } =
  await import('../../src/store/migration.ts')

const CREATED_AT = '2026-11-05T03:04:05.006Z'
const UPDATED_AT = '2026-11-07T09:00:00.000Z'
const LATER_AT = '2026-11-07T11:22:33.444Z'
const CHECKOUT = '/repo/.dsh-cowork/threads/session-a'

/** One v1 thread with the shape `src/store/project-store.ts` writes today. */
const threadV1 = (overrides = {}) => ({
  threadId: 'session-a',
  subject: 'wire the store',
  status: 'new',
  cwd: '/repo',
  checkoutPath: null,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  lastHandoffAt: null,
  reviewStatus: null,
  reviewRequestedAt: null,
  reviewedAt: null,
  reviewerSessionId: null,
  latestReviewPath: null,
  ...overrides,
})

const indexV1 = (threads = [threadV1()], overrides = {}) => ({
  version: 1,
  projectId: 'project-1',
  masterSessionId: 'session-master',
  createdAt: CREATED_AT,
  threads,
  ...overrides,
})

/** The v2 topic shape `legacyViewOf`/`applyLegacyView` exchange. */
const topicV2 = (overrides = {}) => ({
  topicId: 'topic-a',
  title: 'wire the store',
  status: 'active',
  awaitingReview: false,
  blocked: false,
  scope: 'billing',
  ownedPaths: ['src/billing'],
  aliases: ['invoice'],
  digest: 'billing is wired',
  cwd: '/repo',
  legacyCheckoutPath: null,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  lastActiveAt: UPDATED_AT,
  lastDeliveryConfirmedAt: null,
  resolvedAt: null,
  resolvedBy: null,
  latestReviewRequestId: 'request-1',
  reviewStatus: null,
  reviewerSessionId: null,
  lastHandoffAt: null,
  reviewRequestedAt: null,
  reviewedAt: null,
  latestReviewPath: null,
  ...overrides,
})

const workItemV2 = (overrides = {}) => ({
  workItemId: 'work-1',
  topicId: 'topic-a',
  path: '/repo/.dsh-cowork/workitems/work-1',
  branch: 'cowork/work-1',
  baseCommit: 'abc123',
  headCommit: null,
  status: 'active',
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  ...overrides,
})

const indexV2 = (topics = [topicV2()], overrides = {}) => ({
  version: 2,
  projectId: 'project-1',
  masterSessionId: 'session-master',
  createdAt: CREATED_AT,
  topics,
  workItems: [],
  ...overrides,
})

/** Migrate one thread and return its topic. */
function topicOf(thread, docOverrides = {}) {
  const { document } = migrateV1ToV2(indexV1([thread], docOverrides))
  return document.topics[0]
}

/** Run a migration that must fail and return the error. */
function migrationErrorOf(document) {
  try {
    migrateV1ToV2(document)
  } catch (error) {
    return error
  }
  return assert.fail('the migration was expected to fail closed')
}

test('v1 status new migrates to an active topic with the documented defaults', () => {
  const { document, report } = migrateV1ToV2(indexV1([threadV1({ status: 'new' })]))

  assert.equal(document.version, 2)
  assert.deepEqual(document.workItems, [])
  assert.deepEqual(document.topics, [
    {
      topicId: 'session-a',
      title: 'wire the store',
      status: 'active',
      awaitingReview: false,
      blocked: false,
      blockedReason: null,
      blockedFromStatus: null,
      blockedAt: null,
      authorization: null,
      legacyStatus: 'new',
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
      lastHandoffAt: null,
      reviewRequestedAt: null,
      reviewedAt: null,
      latestReviewPath: null,
    },
  ])
  assert.equal(report.fromVersion, 1)
  assert.equal(report.toVersion, 2)
  assert.equal(report.migrated, true)
  assert.deepEqual(report.statusCounts, {
    new: 1,
    active: 0,
    awaiting_review: 0,
    done: 0,
    blocked: 0,
    archived: 0,
  })
  assert.deepEqual(report.resolvedTopics, [])
  assert.deepEqual(report.pendingReviewerArchives, [])
})

test('v1 status active migrates to active and keeps the last active time', () => {
  const topic = topicOf(threadV1({ status: 'active', updatedAt: LATER_AT }))
  assert.equal(topic.status, 'active')
  assert.equal(topic.lastActiveAt, LATER_AT)
  assert.equal(topic.blocked, false)
})

test('v1 awaiting_review cancels the in-flight review and archives its reviewer', () => {
  const { document, report } = migrateV1ToV2(
    indexV1([
      threadV1({
        status: 'awaiting_review',
        reviewStatus: 'pending',
        reviewRequestedAt: UPDATED_AT,
        reviewerSessionId: 'session-reviewer',
        latestReviewPath: '/repo/.dsh-cowork/reviews/session-a-1.json',
      }),
    ]),
  )

  const topic = document.topics[0]
  assert.equal(topic.status, 'active')
  assert.equal(topic.awaitingReview, false)
  assert.equal(topic.blocked, false)
  assert.equal(topic.reviewStatus, null)
  assert.equal(topic.reviewerSessionId, null)
  assert.deepEqual(report.pendingReviewerArchives, [
    { topicId: 'session-a', reviewerSessionId: 'session-reviewer' },
  ])
  assert.equal(topic.reviewRequestedAt, UPDATED_AT, 'the request time survives as a legacy field')
  assert.equal(topic.latestReviewPath, '/repo/.dsh-cowork/reviews/session-a-1.json')
})

test('v1 blocked migrates to an active topic with the blocked flag', () => {
  const topic = topicOf(threadV1({ status: 'blocked', reviewStatus: 'needs_revision' }))
  assert.equal(topic.status, 'active')
  assert.equal(topic.blocked, true)
  assert.equal(topic.awaitingReview, false)
  assert.equal(topic.reviewStatus, 'needs_revision', 'review fields of a live topic map directly')
})

test('v1 done migrates to resolved with master attribution and delivery time', () => {
  const { document, report } = migrateV1ToV2(
    indexV1([threadV1({ status: 'done', reviewStatus: 'pass', updatedAt: LATER_AT })]),
  )

  const topic = document.topics[0]
  assert.equal(topic.status, 'resolved')
  assert.equal(topic.resolvedBy, 'master')
  assert.equal(topic.resolvedAt, LATER_AT)
  assert.equal(topic.lastDeliveryConfirmedAt, LATER_AT)
  assert.equal(topic.lastActiveAt, LATER_AT)
  assert.equal(topic.reviewStatus, 'pass')
  assert.deepEqual(report.resolvedTopics, ['session-a'])
})

test('only the v1-only states leave a legacyStatus marker', () => {
  const { document } = migrateV1ToV2(
    indexV1([
      threadV1({ threadId: 'a', status: 'new' }),
      threadV1({ threadId: 'b', status: 'done' }),
      threadV1({ threadId: 'c', status: 'archived' }),
      threadV1({ threadId: 'd', status: 'active' }),
      threadV1({ threadId: 'e', status: 'awaiting_review', reviewerSessionId: 'r' }),
    ]),
  )
  assert.deepEqual(
    document.topics.map((topic) => [topic.topicId, topic.legacyStatus ?? null]),
    [
      ['a', 'new'],
      ['b', null],
      ['c', 'archived'],
      ['d', null],
      ['e', null],
    ],
  )
})

test('v1 archived migrates like done and keeps its archived marker', () => {
  const { document, report } = migrateV1ToV2(
    indexV1([threadV1({ status: 'archived', updatedAt: LATER_AT })]),
  )

  const topic = document.topics[0]
  assert.equal(topic.status, 'resolved')
  assert.equal(topic.resolvedBy, 'master')
  assert.equal(topic.resolvedAt, LATER_AT)
  assert.equal(topic.lastDeliveryConfirmedAt, LATER_AT)
  assert.equal(topic.legacyStatus, 'archived')
  assert.deepEqual(report.resolvedTopics, ['session-a'])
})

test('the six v1 states are counted one by one', () => {
  const { report } = migrateV1ToV2(
    indexV1([
      threadV1({ threadId: 'a', status: 'new' }),
      threadV1({ threadId: 'b', status: 'active' }),
      threadV1({ threadId: 'c', status: 'active' }),
      threadV1({ threadId: 'd', status: 'awaiting_review', reviewerSessionId: 'r' }),
      threadV1({ threadId: 'e', status: 'blocked' }),
      threadV1({ threadId: 'f', status: 'done' }),
      threadV1({ threadId: 'g', status: 'archived' }),
    ]),
  )

  assert.deepEqual(report.statusCounts, {
    new: 1,
    active: 2,
    awaiting_review: 1,
    done: 1,
    blocked: 1,
    archived: 1,
  })
})

test('thread-level renames and the document envelope are exact', () => {
  const { document } = migrateV1ToV2(
    indexV1([threadV1({ checkoutPath: CHECKOUT, subject: 'the renamed subject' })], {
      projectId: 'project-9',
      createdAt: '2026-01-02T03:04:05.006Z',
      masterSessionId: 'session-master-9',
    }),
  )

  assert.deepEqual(
    {
      version: document.version,
      projectId: document.projectId,
      masterSessionId: document.masterSessionId,
      createdAt: document.createdAt,
    },
    {
      version: 2,
      projectId: 'project-9',
      masterSessionId: 'session-master-9',
      createdAt: '2026-01-02T03:04:05.006Z',
    },
  )
  assert.equal(document.topics[0].topicId, 'session-a')
  assert.equal(document.topics[0].title, 'the renamed subject')
  assert.equal(document.topics[0].legacyCheckoutPath, CHECKOUT)
  assert.equal('threadId' in document.topics[0], false)
  assert.equal('subject' in document.topics[0], false)
  assert.equal('checkoutPath' in document.topics[0], false)
  assert.equal('threads' in document, false)
})

test('the pre-M2 worktreePath name still feeds legacyCheckoutPath', () => {
  const { checkoutPath, ...rest } = threadV1({ status: 'active' })
  void checkoutPath
  const { document } = migrateV1ToV2(indexV1([{ ...rest, worktreePath: CHECKOUT }]))
  assert.equal(document.topics[0].legacyCheckoutPath, CHECKOUT)
  assert.equal('worktreePath' in document.topics[0], false, 'the old name is consumed')
})

test('an unknown v1 status fails closed instead of being guessed', () => {
  const error = migrationErrorOf(
    indexV1([threadV1({ status: 'active' }), threadV1({ threadId: 'session-b', status: 'in-flight' })]),
  )
  assert.ok(error instanceof MigrationError)
  assert.equal(error.code, 'migration/unknown-status')
  assert.match(error.message, /index\.threads\[1\]\.status/)
  assert.match(error.message, /in-flight/)
})

test('unknown document and thread fields are preserved and reported', () => {
  const { document, report } = migrateV1ToV2(
    indexV1([threadV1({ status: 'active', masterFocusTopicId: 'topic-b', note: 'kept' })], {
      writer: '0.1.0',
    }),
  )

  assert.equal(document.writer, '0.1.0')
  assert.equal(document.topics[0].masterFocusTopicId, 'topic-b')
  assert.equal(document.topics[0].note, 'kept')
  assert.deepEqual(report.unknownFields, [
    'index.writer',
    'index.topics[0].masterFocusTopicId',
    'index.topics[0].note',
  ])
})

test('a v1 migration writes both routing targets as null', () => {
  const { document } = migrateV1ToV2(indexV1([threadV1({ status: 'active' })]))
  assert.equal(document.masterFocusTopicId, null)
  assert.equal(document.lastRouteTopicId, null)
})

test('the read-only v1 projection also carries both null routing targets', () => {
  const { document, report } = migrateV1ToV2(indexV1([threadV1({ status: 'awaiting_review' })]), {
    cancelInFlightReviews: false,
  })
  assert.equal(report.migrated, true)
  assert.equal(document.masterFocusTopicId, null)
  assert.equal(document.lastRouteTopicId, null)
})

test('applyLegacyView keeps the routing targets on the document envelope', () => {
  const base = indexV2([topicV2()], { masterFocusTopicId: 'topic-a', lastRouteTopicId: 'topic-b' })
  const view = legacyViewOf(base)
  const applied = applyLegacyView(base, view)
  assert.equal(applied.masterFocusTopicId, 'topic-a')
  assert.equal(applied.lastRouteTopicId, 'topic-b')

  view.threads[0].subject = 'renamed by the legacy view'
  const afterEdit = applyLegacyView(base, view)
  assert.equal(afterEdit.masterFocusTopicId, 'topic-a', 'an edited view does not drop the envelope fields')
  assert.equal(afterEdit.lastRouteTopicId, 'topic-b')
})

test('the four legacy review fields are preserved and reported', () => {
  const { document, report } = migrateV1ToV2(
    indexV1([
      threadV1({
        status: 'active',
        lastHandoffAt: UPDATED_AT,
        reviewStatus: 'pass',
        reviewRequestedAt: UPDATED_AT,
        reviewedAt: LATER_AT,
        reviewerSessionId: 'session-reviewer',
        latestReviewPath: '/repo/.dsh-cowork/reviews/session-a-2.json',
      }),
    ]),
  )

  const topic = document.topics[0]
  assert.equal(topic.lastHandoffAt, UPDATED_AT)
  assert.equal(topic.reviewedAt, LATER_AT)
  assert.equal(topic.reviewStatus, 'pass')
  assert.equal(topic.reviewerSessionId, 'session-reviewer')
  assert.equal(topic.latestReviewPath, '/repo/.dsh-cowork/reviews/session-a-2.json')
  assert.deepEqual(report.legacyFieldsPreserved, [
    'index.topics[0].lastHandoffAt',
    'index.topics[0].reviewRequestedAt',
    'index.topics[0].reviewedAt',
    'index.topics[0].latestReviewPath',
  ])
})

test('migrating an already valid v2 document is an identity', () => {
  const original = indexV2([topicV2({ status: 'resolved', resolvedBy: 'master', resolvedAt: UPDATED_AT })], {
    workItems: [workItemV2()],
  })
  const { document, report } = migrateV1ToV2(original)

  assert.deepEqual(document, original)
  assert.equal(report.fromVersion, 2)
  assert.equal(report.toVersion, 2)
  assert.equal(report.migrated, false)
  assert.deepEqual(report.pendingReviewerArchives, [])
  assert.deepEqual(report.resolvedTopics, [])
  assert.deepEqual(report.unknownFields, [])
  assert.deepEqual(report.legacyFieldsPreserved, [])
  assert.deepEqual(report.statusCounts, {
    new: 0,
    active: 0,
    awaiting_review: 0,
    done: 1,
    blocked: 0,
    archived: 0,
  })
})

test('a migrated document is a fixed point: re-running reproduces the same counts', () => {
  const first = migrateV1ToV2(
    indexV1([
      threadV1({ threadId: 'a', status: 'new' }),
      threadV1({ threadId: 'b', status: 'awaiting_review', reviewerSessionId: 'r' }),
      threadV1({ threadId: 'c', status: 'blocked' }),
      threadV1({ threadId: 'd', status: 'done', updatedAt: LATER_AT }),
      threadV1({ threadId: 'e', status: 'archived', updatedAt: LATER_AT }),
    ]),
  )
  const second = migrateV1ToV2(first.document)

  assert.deepEqual(second.document, first.document)
  assert.equal(second.report.migrated, false)
  assert.deepEqual(second.report.pendingReviewerArchives, [])
  // The counts describe the v2 document, so the cancelled in-flight review now
  // reads as a plain active topic; every other state survives through its marker.
  assert.deepEqual(second.report.statusCounts, {
    new: 1,
    active: 1,
    awaiting_review: 0,
    done: 1,
    blocked: 1,
    archived: 1,
  })
})

test('an invalid v2 document is rejected, never silently repaired', () => {
  const error = migrationErrorOf(indexV2([topicV2({ title: 42 })]))
  assert.ok(error instanceof MigrationError)
  assert.equal(error.code, 'migration/invalid')
  assert.match(error.message, /index\.topics\[0\]\.title/)
})

test('an invalid v1 document is rejected with the offending position', () => {
  const { subject, ...noSubject } = threadV1({ status: 'active' })
  void subject
  const error = migrationErrorOf(indexV1([noSubject]))
  assert.equal(error.code, 'migration/invalid')
  assert.match(error.message, /index\.threads\[0\]\.subject/)
})

test('a non-object document and a v1 document with v2 fields fail closed', () => {
  assert.equal(migrationErrorOf(null).code, 'migration/invalid')
  assert.match(migrationErrorOf('nope').message, /index/)
  const collision = migrationErrorOf(indexV1([threadV1()], { topics: [] }))
  assert.equal(collision.code, 'migration/invalid')
  assert.match(collision.message, /index\.topics/)
})

test('isLegacyIndexDocument only claims documents that declare version 1', () => {
  assert.equal(isLegacyIndexDocument(indexV1()), true)
  assert.equal(isLegacyIndexDocument(indexV2()), false)
  assert.equal(isLegacyIndexDocument({ version: 1 }), true, 'version is the discriminator; validity is checked later')
  assert.equal(isLegacyIndexDocument({ version: 2 }), false)
  assert.equal(isLegacyIndexDocument({ version: '1' }), false)
  assert.equal(isLegacyIndexDocument({}), false)
  assert.equal(isLegacyIndexDocument(null), false)
  assert.equal(isLegacyIndexDocument([]), false)
})

test('legacyViewOf restores the v1-only states from the marker and derives the rest', () => {
  const document = indexV2([
    topicV2({ topicId: 'resolved', status: 'resolved', resolvedBy: 'master', resolvedAt: UPDATED_AT }),
    topicV2({ topicId: 'blocked', blocked: true }),
    topicV2({ topicId: 'reviewing', awaitingReview: true }),
    topicV2({ topicId: 'idle', status: 'idle' }),
    topicV2({ topicId: 'plain' }),
    topicV2({ topicId: 'resolved-and-blocked', status: 'resolved', blocked: true }),
    topicV2({ topicId: 'legacy-new', legacyStatus: 'new' }),
    topicV2({ topicId: 'legacy-archived', status: 'resolved', legacyStatus: 'archived' }),
  ])

  const view = legacyViewOf(document)
  assert.equal(view.version, 1)
  assert.deepEqual(
    view.threads.map((thread) => [thread.threadId, thread.status]),
    [
      ['resolved', 'done'],
      ['blocked', 'blocked'],
      ['reviewing', 'awaiting_review'],
      ['idle', 'active'],
      ['plain', 'active'],
      ['resolved-and-blocked', 'done'],
      ['legacy-new', 'new'],
      ['legacy-archived', 'archived'],
    ],
  )
  assert.equal(
    view.threads
      .slice(0, 6)
      .some((thread) => thread.status === 'new' || thread.status === 'archived'),
    false,
    'a derived status never invents a v1-only state',
  )
})

test('legacyViewOf maps the renames, review fields, and tolerated legacy fields', () => {
  const document = indexV2(
    [
      topicV2({
        legacyCheckoutPath: CHECKOUT,
        reviewStatus: 'pass',
        reviewerSessionId: 'session-reviewer',
        lastHandoffAt: UPDATED_AT,
        reviewRequestedAt: UPDATED_AT,
        reviewedAt: LATER_AT,
        latestReviewPath: '/repo/.dsh-cowork/reviews/session-a-3.json',
      }),
    ],
    { projectId: 'project-9', masterSessionId: 'session-master-9' },
  )

  const view = legacyViewOf(document)
  assert.deepEqual(view, {
    version: 1,
    projectId: 'project-9',
    masterSessionId: 'session-master-9',
    createdAt: CREATED_AT,
    threads: [
      {
        threadId: 'topic-a',
        subject: 'wire the store',
        status: 'active',
        cwd: '/repo',
        checkoutPath: CHECKOUT,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        lastHandoffAt: UPDATED_AT,
        reviewStatus: 'pass',
        reviewRequestedAt: UPDATED_AT,
        reviewedAt: LATER_AT,
        reviewerSessionId: 'session-reviewer',
        latestReviewPath: '/repo/.dsh-cowork/reviews/session-a-3.json',
      },
    ],
  })
})

test('legacyViewOf tolerates a v2 document without the legacy attachment fields', () => {
  const topic = topicV2()
  for (const field of ['lastHandoffAt', 'reviewRequestedAt', 'reviewedAt', 'latestReviewPath']) {
    delete topic[field]
  }
  const [thread] = legacyViewOf(indexV2([topic])).threads
  assert.equal(thread.lastHandoffAt, null)
  assert.equal(thread.reviewRequestedAt, null)
  assert.equal(thread.reviewedAt, null)
  assert.equal(thread.latestReviewPath, null)
})

test('view then apply rounds back to the same v2 document', () => {
  const { document } = migrateV1ToV2(
    indexV1(
      [
        threadV1({ threadId: 'a', status: 'done', reviewStatus: 'pass', updatedAt: LATER_AT }),
        threadV1({
          threadId: 'b',
          status: 'awaiting_review',
          reviewerSessionId: 'session-reviewer',
          reviewStatus: 'pending',
        }),
        threadV1({ threadId: 'c', status: 'blocked', updatedAt: LATER_AT }),
        threadV1({ threadId: 'd', status: 'active', checkoutPath: CHECKOUT }),
        threadV1({ threadId: 'e', status: 'new' }),
        threadV1({ threadId: 'f', status: 'archived', updatedAt: LATER_AT }),
      ],
      { workItemsHint: 'ignored' },
    ),
  )

  const applied = applyLegacyView(document, legacyViewOf(document))
  assert.deepEqual(applied, document)
})

test('applyLegacyView writes the view back without touching v2-only fields', () => {
  const base = indexV2(
    [
      topicV2({
        topicId: 'topic-a',
        awaitingReview: true,
        lastActiveAt: LATER_AT,
        resolvedAt: null,
        resolvedBy: null,
      }),
    ],
    { workItems: [workItemV2()] },
  )
  const view = legacyViewOf(base)
  const thread = view.threads[0]
  thread.subject = 'renamed by the legacy view'
  thread.status = 'done'
  thread.reviewStatus = 'pass'
  thread.reviewedAt = LATER_AT
  thread.checkoutPath = CHECKOUT
  thread.cwd = '/repo-2'
  thread.updatedAt = LATER_AT
  thread.lastHandoffAt = UPDATED_AT
  thread.reviewRequestedAt = UPDATED_AT
  thread.latestReviewPath = '/repo/.dsh-cowork/reviews/topic-a-9.json'

  const applied = applyLegacyView(base, view)
  const topic = applied.topics[0]

  assert.equal(topic.title, 'renamed by the legacy view')
  assert.equal(topic.status, 'resolved')
  assert.equal(topic.reviewStatus, 'pass')
  assert.equal(topic.reviewedAt, LATER_AT)
  assert.equal(topic.legacyCheckoutPath, CHECKOUT)
  assert.equal(topic.cwd, '/repo-2')
  assert.equal(topic.updatedAt, LATER_AT)
  assert.equal(topic.lastHandoffAt, UPDATED_AT)
  assert.equal(topic.reviewRequestedAt, UPDATED_AT)
  assert.equal(topic.latestReviewPath, '/repo/.dsh-cowork/reviews/topic-a-9.json')

  // The status also drives the lifecycle flags; the v2-only fields survive.
  assert.equal(topic.awaitingReview, false, 'a done status ends any in-flight review')
  assert.equal(topic.blocked, false)
  assert.equal(topic.resolvedAt, LATER_AT)
  assert.equal(topic.resolvedBy, 'master')
  assert.equal(topic.lastDeliveryConfirmedAt, LATER_AT)

  assert.deepEqual(
    {
      scope: topic.scope,
      ownedPaths: topic.ownedPaths,
      aliases: topic.aliases,
      digest: topic.digest,
      lastActiveAt: topic.lastActiveAt,
      latestReviewRequestId: topic.latestReviewRequestId,
    },
    {
      scope: 'billing',
      ownedPaths: ['src/billing'],
      aliases: ['invoice'],
      digest: 'billing is wired',
      lastActiveAt: LATER_AT,
      latestReviewRequestId: 'request-1',
    },
  )
  assert.deepEqual(
    {
      version: applied.version,
      projectId: applied.projectId,
      masterSessionId: applied.masterSessionId,
      createdAt: applied.createdAt,
      workItems: applied.workItems,
    },
    {
      version: 2,
      projectId: 'project-1',
      masterSessionId: 'session-master',
      createdAt: CREATED_AT,
      workItems: [workItemV2()],
    },
  )
})

test('applyLegacyView derives the v2 lifecycle flags from the view status', () => {
  const cases = [
    { status: 'new', legacyStatus: 'new', awaitingReview: false, blocked: false, resolved: false },
    { status: 'active', legacyStatus: undefined, awaitingReview: false, blocked: false, resolved: false },
    { status: 'awaiting_review', legacyStatus: undefined, awaitingReview: true, blocked: false, resolved: false },
    { status: 'blocked', legacyStatus: undefined, awaitingReview: false, blocked: true, resolved: false },
    { status: 'done', legacyStatus: undefined, awaitingReview: false, blocked: false, resolved: true },
    { status: 'archived', legacyStatus: 'archived', awaitingReview: false, blocked: false, resolved: true },
  ]
  for (const expected of cases) {
    const base = indexV2([topicV2({ topicId: 'topic-a' })])
    const view = legacyViewOf(base)
    const thread = view.threads[0]
    thread.status = expected.status
    thread.updatedAt = LATER_AT

    const topic = applyLegacyView(base, view).topics[0]
    assert.equal(topic.status, expected.resolved ? 'resolved' : 'active', expected.status)
    assert.equal(topic.awaitingReview, expected.awaitingReview, expected.status)
    assert.equal(topic.blocked, expected.blocked, expected.status)
    assert.equal(topic.legacyStatus, expected.legacyStatus, expected.status)
    assert.equal(topic.resolvedAt, expected.resolved ? LATER_AT : null, expected.status)
    assert.equal(topic.resolvedBy, expected.resolved ? 'master' : null, expected.status)
    assert.equal(topic.lastDeliveryConfirmedAt, expected.resolved ? LATER_AT : null, expected.status)
  }
})

test('applyLegacyView clears a preserved marker once the status moves on', () => {
  const { document } = migrateV1ToV2(
    indexV1([
      threadV1({ threadId: 'a', status: 'archived', updatedAt: LATER_AT }),
      threadV1({ threadId: 'b', status: 'new' }),
    ]),
  )

  const resolvedView = legacyViewOf(document)
  resolvedView.threads[0].status = 'done'
  const resolvedApplied = applyLegacyView(document, resolvedView)
  assert.equal(resolvedApplied.topics[0].status, 'resolved')
  assert.equal(resolvedApplied.topics[0].legacyStatus, undefined)
  assert.equal(resolvedApplied.topics[0].resolvedAt, LATER_AT, 'existing resolution history is kept')
  assert.equal(resolvedApplied.topics[0].resolvedBy, 'master')

  const activeView = legacyViewOf(document)
  activeView.threads[1].status = 'active'
  const activeApplied = applyLegacyView(document, activeView)
  assert.equal(activeApplied.topics[1].status, 'active')
  assert.equal(activeApplied.topics[1].legacyStatus, undefined)

  const reopened = legacyViewOf(document)
  reopened.threads[0].status = 'active'
  const reopenedApplied = applyLegacyView(document, reopened)
  assert.equal(reopenedApplied.topics[0].status, 'active')
  assert.equal(reopenedApplied.topics[0].resolvedAt, null, 'reopening clears the resolution')
  assert.equal(reopenedApplied.topics[0].resolvedBy, null)
  assert.equal(reopenedApplied.topics[0].lastDeliveryConfirmedAt, null)
  assert.equal(reopenedApplied.topics[0].legacyStatus, undefined)
})

test('applyLegacyView deletes a topic the view omits', () => {
  const base = indexV2([
    topicV2({ topicId: 'topic-a' }),
    topicV2({ topicId: 'topic-b', title: 'rolled back' }),
  ])
  const view = legacyViewOf(base)
  // src/tools.ts rolls a failed thread creation back by filtering the thread out.
  view.threads = view.threads.filter((thread) => thread.threadId === 'topic-a')

  const applied = applyLegacyView(base, view)
  assert.deepEqual(
    applied.topics.map((topic) => topic.topicId),
    ['topic-a'],
  )
})

test('applyLegacyView appends a thread the legacy code created', () => {
  const base = indexV2([topicV2({ topicId: 'topic-a' })])
  const view = legacyViewOf(base)
  view.threads.push({
    threadId: 'session-new',
    subject: 'a thread the old tools added',
    status: 'blocked',
    cwd: '/repo',
    checkoutPath: CHECKOUT,
    createdAt: CREATED_AT,
    updatedAt: LATER_AT,
    lastHandoffAt: UPDATED_AT,
    reviewStatus: 'needs_revision',
    reviewRequestedAt: null,
    reviewedAt: null,
    reviewerSessionId: null,
    latestReviewPath: null,
  })

  const applied = applyLegacyView(base, view)
  assert.deepEqual(
    applied.topics.map((topic) => topic.topicId),
    ['topic-a', 'session-new'],
  )
  assert.deepEqual(applied.topics[1], {
    topicId: 'session-new',
    title: 'a thread the old tools added',
    status: 'active',
    awaitingReview: false,
    blocked: true,
    blockedReason: 'handoff',
    blockedFromStatus: 'active',
    blockedAt: null,
    authorization: null,
    scope: '',
    ownedPaths: [],
    aliases: [],
    digest: '',
    cwd: '/repo',
    legacyCheckoutPath: CHECKOUT,
    createdAt: CREATED_AT,
    updatedAt: LATER_AT,
    lastActiveAt: LATER_AT,
    lastDeliveryConfirmedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    latestReviewRequestId: null,
    reviewStatus: 'needs_revision',
    reviewerSessionId: null,
    lastHandoffAt: UPDATED_AT,
    reviewRequestedAt: null,
    reviewedAt: null,
    latestReviewPath: null,
  })
})

/** An in-flight v1 review fixture. */
const inFlightReview = () =>
  threadV1({
    status: 'awaiting_review',
    reviewStatus: 'pending',
    reviewRequestedAt: UPDATED_AT,
    reviewerSessionId: 'session-reviewer',
    latestReviewPath: '/repo/.dsh-cowork/reviews/session-a-1.json',
  })

test('the default migration mode is the write mode', () => {
  const implicit = migrateV1ToV2(indexV1([inFlightReview()]))
  const explicit = migrateV1ToV2(indexV1([inFlightReview()]), { cancelInFlightReviews: true })

  assert.deepEqual(implicit, explicit)
  const topic = implicit.document.topics[0]
  assert.equal(topic.status, 'active')
  assert.equal(topic.awaitingReview, false)
  assert.equal(topic.reviewStatus, null)
  assert.equal(topic.reviewerSessionId, null)
  assert.deepEqual(implicit.report.pendingReviewerArchives, [
    { topicId: 'session-a', reviewerSessionId: 'session-reviewer' },
  ])
})

test('the read-only mode keeps an in-flight review in place', () => {
  const { document, report } = migrateV1ToV2(indexV1([inFlightReview()]), {
    cancelInFlightReviews: false,
  })

  const topic = document.topics[0]
  assert.equal(topic.status, 'active')
  assert.equal(topic.awaitingReview, true)
  assert.equal(topic.reviewStatus, 'pending')
  assert.equal(topic.reviewerSessionId, 'session-reviewer')
  assert.equal(topic.reviewRequestedAt, UPDATED_AT)
  assert.equal(topic.latestReviewPath, '/repo/.dsh-cowork/reviews/session-a-1.json')
  assert.deepEqual(report.pendingReviewerArchives, [], 'no archive intent is raised')
  assert.equal(report.migrated, true)

  // The compatibility view over the projection is the v1 record again.
  const view = legacyViewOf(document)
  assert.equal(view.threads[0].status, 'awaiting_review')
  assert.equal(view.threads[0].reviewStatus, 'pending')
  assert.equal(view.threads[0].reviewerSessionId, 'session-reviewer')
  assert.equal(view.threads[0].reviewRequestedAt, UPDATED_AT)
})

test('both modes agree on every state except the in-flight review', () => {
  const threads = [
    threadV1({ threadId: 'a', status: 'new' }),
    threadV1({ threadId: 'b', status: 'active' }),
    threadV1({ threadId: 'c', status: 'blocked' }),
    threadV1({ threadId: 'd', status: 'done', updatedAt: LATER_AT }),
    threadV1({ threadId: 'e', status: 'archived' }),
  ]
  const writeMode = migrateV1ToV2(indexV1(threads))
  const readOnly = migrateV1ToV2(indexV1(threads), { cancelInFlightReviews: false })

  assert.deepEqual(readOnly.document, writeMode.document)
  assert.deepEqual(readOnly.report, writeMode.report)
})

test('a v2 document passes through unchanged in both modes', () => {
  for (const cancelInFlightReviews of [true, false]) {
    const { document, report } = migrateV1ToV2(indexV2(), { cancelInFlightReviews })
    assert.deepEqual(document, indexV2())
    assert.equal(report.migrated, false)
    assert.deepEqual(report.pendingReviewerArchives, [])
    assert.deepEqual(report.archiveFailures, [])
  }
})
