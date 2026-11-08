import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVITY_MAX_BYTES,
  ACTIVITY_MAX_EVENTS,
  ACTIVITY_TYPES,
  INBOX_KINDS,
  INBOX_MAX_ITEMS,
  INDEX_VERSION_V1,
  INDEX_VERSION_V2,
  REVIEW_STATUSES,
  TOPIC_STATUSES,
  WORK_ITEM_STATUSES,
  activityEventProblems,
  inboxItemProblems,
  normalizeProjectIndexV1,
  normalizeProjectIndexV2,
  projectIndexV1Problems,
  projectIndexV2Problems,
} from '../src/store-schema.ts'

/**
 * Contract tests for the v2 index schema and its v1 compatibility layer.
 * Everything here is pure: no file system, no clock, no `.dsh-cowork/`.
 *
 * The v1 expectations mirror `src/store.ts`'s `normalizeThreadDocument` and
 * `indexProblems` behaviour: legacy key adoption, M3 review fields defaulted to
 * null, unknown fields tolerated. The v2 expectations follow PLAN-V0.2 §4.3.
 */

const CREATED_AT = '2026-11-05T03:04:05.006Z'
const UPDATED_AT = '2026-11-07T09:00:00.000Z'

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

test('the exported constants are the documented values', () => {
  assert.equal(INDEX_VERSION_V2, 2)
  assert.equal(INDEX_VERSION_V1, 1)
  assert.equal(ACTIVITY_MAX_EVENTS, 500)
  assert.equal(ACTIVITY_MAX_BYTES, 524288)
  assert.equal(INBOX_MAX_ITEMS, 50)
})

test('the exported enumerations match PLAN-V0.2 §4.3', () => {
  assert.deepEqual(TOPIC_STATUSES, ['active', 'idle', 'resolved'])
  assert.deepEqual(WORK_ITEM_STATUSES, ['active', 'reviewing', 'merged', 'abandoned'])
  assert.deepEqual(INBOX_KINDS, ['merge-needed', 'blocked', 'review-reject', 'cross-topic-conflict'])
  assert.deepEqual(REVIEW_STATUSES, ['pending', 'pass', 'needs_revision', 'reject'])
  assert.ok(ACTIVITY_TYPES.includes('route-corrected'), 'PLAN §5.3 names route-corrected')
  assert.ok(ACTIVITY_TYPES.includes('topic-created'))
  assert.ok(ACTIVITY_TYPES.includes('review-requested'))
  assert.ok(ACTIVITY_TYPES.includes('review-verdict'))
  assert.ok(ACTIVITY_TYPES.includes('status-changed'))
  assert.ok(ACTIVITY_TYPES.includes('topic-reopened'), 'M8 reopening is its own event, not an undo')
  assert.ok(ACTIVITY_TYPES.includes('error'))
})

test('v1 normalization adopts the pre-M2 worktreePath name', () => {
  const { checkoutPath, ...rest } = threadV1()
  void checkoutPath
  const normalized = normalizeProjectIndexV1(
    indexV1([{ ...rest, worktreePath: '/repo/.dsh-cowork/threads/session-a' }]),
  )
  assert.equal(normalized.threads[0].checkoutPath, '/repo/.dsh-cowork/threads/session-a')
  assert.equal('worktreePath' in normalized.threads[0], false, 'the legacy key is consumed')
})

test('v1 normalization keeps a present checkoutPath over the legacy name', () => {
  const normalized = normalizeProjectIndexV1(
    indexV1([{ ...threadV1({ checkoutPath: null }), worktreePath: '/old/clone' }]),
  )
  assert.equal(normalized.threads[0].checkoutPath, null)
})

test('v1 normalization defaults every M3 review field to null', () => {
  const thread = threadV1()
  for (const field of ['reviewStatus', 'reviewRequestedAt', 'reviewedAt', 'reviewerSessionId', 'latestReviewPath']) {
    delete thread[field]
  }
  const normalized = normalizeProjectIndexV1(indexV1([thread]))
  assert.deepEqual(
    {
      reviewStatus: normalized.threads[0].reviewStatus,
      reviewRequestedAt: normalized.threads[0].reviewRequestedAt,
      reviewedAt: normalized.threads[0].reviewedAt,
      reviewerSessionId: normalized.threads[0].reviewerSessionId,
      latestReviewPath: normalized.threads[0].latestReviewPath,
    },
    {
      reviewStatus: null,
      reviewRequestedAt: null,
      reviewedAt: null,
      reviewerSessionId: null,
      latestReviewPath: null,
    },
  )
})

test('v1 normalization preserves unknown document and thread fields', () => {
  const normalized = normalizeProjectIndexV1(
    indexV1([threadV1({ masterFocusTopicId: 'topic-b' })], { writer: '0.1.0' }),
  )
  assert.equal(normalized.writer, '0.1.0')
  assert.equal(normalized.threads[0].masterFocusTopicId, 'topic-b')
})

test('v1 normalization passes through documents it cannot read', () => {
  assert.equal(normalizeProjectIndexV1(null), null)
  assert.deepEqual(normalizeProjectIndexV1({ version: 1 }), { version: 1 })
  const untouched = indexV1(['not-a-record'])
  assert.equal(normalizeProjectIndexV1(untouched).threads[0], 'not-a-record')
})

test('v1 validation accepts a document the current store writes', () => {
  assert.deepEqual(projectIndexV1Problems(indexV1()), [])
  const { checkoutPath, ...withoutCheckout } = threadV1()
  void checkoutPath
  assert.deepEqual(projectIndexV1Problems(indexV1([{ ...withoutCheckout, worktreePath: '/old/clone' }])), [
    'index.threads[0].checkoutPath must be a string or null',
  ])
})

test('v1 validation names the offending field and path', () => {
  const problems = projectIndexV1Problems(
    indexV1([threadV1({ status: 'in-flight', subject: 42 }), threadV1({ threadId: '' })]),
  )
  assert.ok(problems.includes('index.threads[0].subject must be a string'))
  assert.ok(problems.includes('index.threads[1].threadId must be a non-empty string'))
  assert.ok(
    problems.some((problem) => problem.startsWith('index.threads[0].status must be one of')),
    'an unknown status is rejected by the v1 validator too',
  )
  assert.deepEqual(projectIndexV1Problems({ version: 1, threads: 'nope' }), [
    'index.projectId must be a non-empty string',
    'index.masterSessionId must be a non-empty string',
    'index.createdAt must be an ISO 8601 timestamp',
    'index.threads must be an array',
  ])
})

test('v2 normalization fills the tolerated legacy attachment fields only', () => {
  const normalized = normalizeProjectIndexV2(indexV2([topicV2({ lastHandoffAt: UPDATED_AT })]))
  assert.deepEqual(
    {
      lastHandoffAt: normalized.topics[0].lastHandoffAt,
      reviewRequestedAt: normalized.topics[0].reviewRequestedAt,
      reviewedAt: normalized.topics[0].reviewedAt,
      latestReviewPath: normalized.topics[0].latestReviewPath,
    },
    { lastHandoffAt: UPDATED_AT, reviewRequestedAt: null, reviewedAt: null, latestReviewPath: null },
  )
  assert.equal(normalized.topics[0].scope, '', 'v2 fields are never rewritten by normalization')
})

test('v2 normalization preserves unknown fields and passes unreadable documents through', () => {
  const normalized = normalizeProjectIndexV2(
    indexV2([topicV2({ aliases: ['store'] })], { masterFocusTopicId: 'topic-a' }),
  )
  assert.deepEqual(normalized.topics[0].aliases, ['store'])
  assert.equal(normalized.masterFocusTopicId, 'topic-a')
  assert.equal(normalizeProjectIndexV2(null), null)
  assert.deepEqual(normalizeProjectIndexV2({ version: 2 }), { version: 2 })
})

test('v2 normalization defaults the routing targets to null', () => {
  const normalized = normalizeProjectIndexV2(indexV2())
  assert.equal(normalized.masterFocusTopicId, null)
  assert.equal(normalized.lastRouteTopicId, null)
  assert.equal(normalized.projectId, 'project-1', 'the rest of the envelope is untouched')

  const present = normalizeProjectIndexV2(
    indexV2([topicV2()], { masterFocusTopicId: 'topic-a', lastRouteTopicId: 'topic-b' }),
  )
  assert.equal(present.masterFocusTopicId, 'topic-a')
  assert.equal(present.lastRouteTopicId, 'topic-b')

  const cleared = normalizeProjectIndexV2(
    indexV2([topicV2()], { masterFocusTopicId: null, lastRouteTopicId: null }),
  )
  assert.equal(cleared.masterFocusTopicId, null)
  assert.equal(cleared.lastRouteTopicId, null)
})

test('v2 validation accepts null, absent, and present routing targets', () => {
  assert.deepEqual(projectIndexV2Problems(indexV2()), [], 'an older v2 document has no fields')
  assert.deepEqual(
    projectIndexV2Problems(indexV2([topicV2()], { masterFocusTopicId: null, lastRouteTopicId: null })),
    [],
  )
  assert.deepEqual(
    projectIndexV2Problems(indexV2([topicV2()], { masterFocusTopicId: 'topic-a', lastRouteTopicId: 'topic-b' })),
    [],
  )
})

test('v2 validation rejects a broken routing target', () => {
  for (const value of [42, '', '   ', {}, ['topic-a'], true]) {
    const problems = projectIndexV2Problems(
      indexV2([topicV2()], { masterFocusTopicId: value, lastRouteTopicId: value }),
    )
    assert.deepEqual(problems, [
      'index.masterFocusTopicId must be a non-empty string or null',
      'index.lastRouteTopicId must be a non-empty string or null',
    ])
  }
})


test('v2 validation accepts a document with a full topic and work item', () => {
  const document = indexV2(
    [
      topicV2({ status: 'resolved', resolvedBy: 'master', resolvedAt: UPDATED_AT }),
      topicV2({ topicId: 'topic-b', legacyStatus: 'new' }),
      topicV2({ topicId: 'topic-c', status: 'resolved', legacyStatus: 'archived' }),
    ],
    { workItems: [workItemV2()] },
  )
  assert.deepEqual(projectIndexV2Problems(document), [])
})

test('v2 validation names every broken topic field', () => {
  const problems = projectIndexV2Problems(
    indexV2([
      topicV2({
        topicId: '',
        title: 42,
        status: 'done',
        awaitingReview: 'no',
        blocked: null,
        scope: 7,
        ownedPaths: ['src', 3],
        aliases: 'store',
        digest: [],
        cwd: '',
        legacyCheckoutPath: 5,
        createdAt: 'yesterday',
        updatedAt: null,
        lastActiveAt: 'soon',
        lastDeliveryConfirmedAt: 'later',
        resolvedAt: 'never',
        resolvedBy: 'nobody',
        latestReviewRequestId: 9,
        reviewStatus: 'maybe',
        reviewerSessionId: 3,
        legacyStatus: 'done',
      }),
    ]),
  )
  const expected = [
    'index.topics[0].topicId must be a non-empty string',
    'index.topics[0].title must be a string',
    'index.topics[0].status must be one of active|idle|resolved',
    'index.topics[0].awaitingReview must be a boolean',
    'index.topics[0].blocked must be a boolean',
    'index.topics[0].scope must be a string',
    'index.topics[0].ownedPaths must be an array of strings',
    'index.topics[0].aliases must be an array of strings',
    'index.topics[0].digest must be a string',
    'index.topics[0].cwd must be a non-empty string',
    'index.topics[0].legacyCheckoutPath must be a string or null',
    'index.topics[0].createdAt must be an ISO 8601 timestamp',
    'index.topics[0].updatedAt must be an ISO 8601 timestamp',
    'index.topics[0].lastActiveAt must be an ISO 8601 timestamp',
    'index.topics[0].lastDeliveryConfirmedAt must be an ISO 8601 timestamp or null',
    'index.topics[0].resolvedAt must be an ISO 8601 timestamp or null',
    "index.topics[0].resolvedBy must be one of user|master or null",
    'index.topics[0].latestReviewRequestId must be a non-empty string or null',
    'index.topics[0].reviewStatus must be one of pending|pass|needs_revision|reject or null',
    'index.topics[0].reviewerSessionId must be a non-empty string or null',
    'index.topics[0].legacyStatus must be one of new|archived',
  ]
  assert.deepEqual(problems, expected)
})

test('v2 validation checks the tolerated legacy attachment fields when present', () => {
  const problems = projectIndexV2Problems(
    indexV2([topicV2({ lastHandoffAt: 'never', reviewRequestedAt: 3, reviewedAt: [], latestReviewPath: '' })]),
  )
  assert.deepEqual(problems, [
    'index.topics[0].lastHandoffAt must be an ISO 8601 timestamp or null',
    'index.topics[0].reviewRequestedAt must be an ISO 8601 timestamp or null',
    'index.topics[0].reviewedAt must be an ISO 8601 timestamp or null',
    'index.topics[0].latestReviewPath must be a non-empty string or null',
  ])
})

test('v2 validation names broken document fields and work items', () => {
  const problems = projectIndexV2Problems(
    indexV2([topicV2()], {
      version: 1,
      projectId: '',
      masterSessionId: 5,
      createdAt: 'soon',
      workItems: [workItemV2({ workItemId: '', status: 'merging', baseCommit: 3, headCommit: '' })],
    }),
  )
  assert.deepEqual(problems, [
    'index.version must be 2',
    'index.projectId must be a non-empty string',
    'index.masterSessionId must be a non-empty string',
    'index.createdAt must be an ISO 8601 timestamp',
    'index.workItems[0].workItemId must be a non-empty string',
    'index.workItems[0].baseCommit must be a non-empty string or null',
    'index.workItems[0].headCommit must be a non-empty string or null',
    'index.workItems[0].status must be one of active|reviewing|merged|abandoned',
  ])
  assert.deepEqual(projectIndexV2Problems({ version: 2 }), [
    'index.projectId must be a non-empty string',
    'index.masterSessionId must be a non-empty string',
    'index.createdAt must be an ISO 8601 timestamp',
    'index.topics must be an array',
    'index.workItems must be an array',
  ])
  assert.deepEqual(projectIndexV2Problems(null), ['index must be a JSON object'])
})

test('an activity event is valid when every field matches the activity stream schema', () => {
  const event = {
    eventId: 'event-1',
    time: UPDATED_AT,
    type: 'topic-created',
    topicId: 'topic-a',
    summary: 'created topic',
    details: { route: 'new' },
  }
  assert.deepEqual(activityEventProblems(event), [])
  assert.deepEqual(activityEventProblems({ ...event, topicId: null }), [])
})

test('an activity event reports each invalid field by name', () => {
  assert.deepEqual(
    activityEventProblems({
      eventId: '',
      time: 'later',
      type: 'unknown-event',
      topicId: 3,
      summary: '',
      details: [],
    }),
    [
      'activity.eventId must be a non-empty string',
      'activity.time must be an ISO 8601 timestamp',
      'activity.type must be one of topic-created|route-reused|route-created|route-corrected|status-changed|topic-reopened|review-requested|review-verdict|work-item-created|work-item-merged|error',
      'activity.topicId must be a non-empty string or null',
      'activity.summary must be a non-empty string',
      'activity.details must be a JSON object',
    ],
  )
  assert.deepEqual(activityEventProblems(null), ['activity must be a JSON object'])
})

test('an inbox item is valid when every field matches the inbox schema', () => {
  const item = {
    id: 'inbox-1',
    time: UPDATED_AT,
    topicId: 'topic-a',
    kind: 'merge-needed',
    summary: 'merge topic-a',
    deliveredAt: null,
  }
  assert.deepEqual(inboxItemProblems(item), [])
  assert.deepEqual(inboxItemProblems({ ...item, deliveredAt: UPDATED_AT }), [])
})

test('an inbox item reports each invalid field by name', () => {
  assert.deepEqual(
    inboxItemProblems({
      id: '',
      time: 'later',
      topicId: null,
      kind: 'needs-attention',
      summary: '',
      deliveredAt: 'never',
    }),
    [
      'inbox.id must be a non-empty string',
      'inbox.time must be an ISO 8601 timestamp',
      'inbox.topicId must be a non-empty string',
      'inbox.kind must be one of merge-needed|blocked|review-reject|cross-topic-conflict',
      'inbox.summary must be a non-empty string',
      'inbox.deliveredAt must be an ISO 8601 timestamp or null',
    ],
  )
  assert.deepEqual(inboxItemProblems(null), ['inbox must be a JSON object'])
})
