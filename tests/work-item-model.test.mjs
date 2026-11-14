import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import './support/ts-hook.mjs'

/**
 * Contract tests for the pure M10 work-item model (`src/work-item.ts`): the
 * status vocabulary, the active count a topic's "resolved" condition reads, the
 * record builder, the marker updates, and the bounded view. No clone, no git,
 * no clock. The creation and merge flow live in `work-item-create.test.mjs`
 * and `work-item-merge.test.mjs`.
 */
const {
  MERGEABLE_WORK_ITEM_STATUSES,
  WORK_ITEM_STATUSES,
  activeWorkItemCount,
  buildWorkItemRecord,
  isMergeableWorkItemStatus,
  isValidWorkItemId,
  markWorkItem,
  workItemView,
} = await import('../src/work-item.ts')

const CREATED_AT = new Date('2026-11-08T00:00:00.000Z')
const UPDATED_AT = new Date('2026-11-08T02:00:00.000Z')
const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)

/** One work item as the index stores it. */
const item = (overrides = {}) => ({
  workItemId: 'wi-1',
  topicId: 'session-topic',
  path: '/repo/.dsh-cowork/workitems/wi-1',
  branch: 'cowork/wi-1',
  baseCommit: BASE,
  headCommit: BASE,
  status: 'active',
  createdAt: CREATED_AT.toISOString(),
  updatedAt: CREATED_AT.toISOString(),
  ...overrides,
})

/** A document-shaped object carrying work items. */
const document = (...workItems) => ({ workItems })

// ---------------------------------------------------------------------------
// vocabularies and identities
// ---------------------------------------------------------------------------

test('the work-item statuses are the four PLAN-V0.2 §4.3 states, in order', () => {
  assert.deepEqual([...WORK_ITEM_STATUSES], ['active', 'reviewing', 'merged', 'abandoned'])
  assert.deepEqual([...MERGEABLE_WORK_ITEM_STATUSES], ['reviewing'])
})

test('only reviewing work items may be merged', () => {
  assert.equal(isMergeableWorkItemStatus('reviewing'), true)
  for (const status of ['active', 'merged', 'abandoned', null, 'bogus']) {
    assert.equal(isMergeableWorkItemStatus(status), false, String(status))
  }
})

test('a work-item id is usable as a directory and branch name', () => {
  for (const valid of ['wi-1', 'wi_1-a', 'A'.repeat(128)]) {
    assert.equal(isValidWorkItemId(valid), true, valid)
  }
  // The pattern is aligned with the checkout path guard's TARGET_ID_PATTERN:
  // a dotted id is refused here, before any clone is attempted (R2).
  for (const invalid of ['', 'wi 1', 'wi/1', 'wi\\1', 'wi.1', '.wi', 'wi.', '..', '.', 'A'.repeat(129), 42, null, undefined]) {
    assert.equal(isValidWorkItemId(invalid), false, String(invalid))
  }
})

// ---------------------------------------------------------------------------
// active counting
// ---------------------------------------------------------------------------

test('activeWorkItemCount counts active and reviewing work items of one topic', () => {
  const doc = document(
    item({ workItemId: 'wi-1', status: 'active' }),
    item({ workItemId: 'wi-2', status: 'reviewing' }),
    item({ workItemId: 'wi-3', status: 'merged' }),
    item({ workItemId: 'wi-4', status: 'abandoned' }),
    item({ workItemId: 'wi-5', topicId: 'session-other', status: 'active' }),
  )
  assert.equal(activeWorkItemCount(doc, 'session-topic'), 2)
  assert.equal(activeWorkItemCount(doc, 'session-other'), 1)
  assert.equal(activeWorkItemCount(doc, 'session-unknown'), 0)
  assert.equal(activeWorkItemCount(document(), 'session-topic'), 0)
  assert.equal(activeWorkItemCount(null, 'session-topic'), 0)
})

test('a reviewing work item keeps its topic from being resolved', () => {
  // The read point must not treat only `active` as in-flight: a topic waiting on
  // a review is still working, and resolving it has no undo.
  const doc = document(item({ status: 'reviewing' }))
  assert.ok(activeWorkItemCount(doc, 'session-topic') > 0)
})

// ---------------------------------------------------------------------------
// record builder and marker updates
// ---------------------------------------------------------------------------

test('buildWorkItemRecord stamps an active item from its base', () => {
  assert.deepEqual(
    buildWorkItemRecord(
      {
        workItemId: 'wi-1',
        topicId: 'session-topic',
        path: '/repo/.dsh-cowork/workitems/wi-1',
        branch: 'cowork/wi-1',
        baseCommit: BASE,
      },
      CREATED_AT,
    ),
    item(),
  )
})

test('buildWorkItemRecord refuses an unsafe id, path, or branch', () => {
  const opened = { workItemId: 'wi-1', topicId: 'session-topic', path: '/repo/workitems/wi-1', branch: 'cowork/wi-1', baseCommit: BASE }
  assert.throws(() => buildWorkItemRecord({ ...opened, workItemId: '../wi' }, CREATED_AT), TypeError)
  assert.throws(() => buildWorkItemRecord({ ...opened, path: '' }, CREATED_AT), TypeError)
  assert.throws(() => buildWorkItemRecord({ ...opened, branch: '' }, CREATED_AT), TypeError)
})

test('markWorkItem stamps updatedAt and the new head, keeping the rest', () => {
  const marked = markWorkItem(item(), { status: 'reviewing', headCommit: HEAD }, UPDATED_AT)
  assert.deepEqual(marked, item({ status: 'reviewing', headCommit: HEAD, updatedAt: UPDATED_AT.toISOString() }))

  // A status-only update keeps the head; a head-only update keeps the status.
  const statusOnly = markWorkItem(item({ headCommit: HEAD }), { status: 'merged' }, UPDATED_AT)
  assert.equal(statusOnly.status, 'merged')
  assert.equal(statusOnly.headCommit, HEAD)
  const headOnly = markWorkItem(item(), { headCommit: HEAD }, UPDATED_AT)
  assert.equal(headOnly.status, 'active')
  assert.equal(headOnly.headCommit, HEAD)
  assert.equal(headOnly.updatedAt, UPDATED_AT.toISOString())
})

test('markWorkItem refuses an invalid status or an empty head', () => {
  assert.throws(() => markWorkItem(item(), { status: 'bogus' }, UPDATED_AT), TypeError)
  assert.throws(() => markWorkItem(item(), { headCommit: '' }, UPDATED_AT), TypeError)
})

// ---------------------------------------------------------------------------
// bounded view
// ---------------------------------------------------------------------------

test('workItemView carries the fixed field set of a work item', () => {
  assert.deepEqual(workItemView(item({ headCommit: HEAD })), {
    workItemId: 'wi-1',
    topicId: 'session-topic',
    path: '/repo/.dsh-cowork/workitems/wi-1',
    branch: 'cowork/wi-1',
    baseCommit: BASE,
    headCommit: HEAD,
    status: 'active',
    createdAt: CREATED_AT.toISOString(),
    updatedAt: CREATED_AT.toISOString(),
  })
})

test('workItemView cuts a path or branch that would blow the status budget', () => {
  const longPath = `/repo/${'d'.repeat(5000)}`
  const longBranch = 'b'.repeat(5000)
  const view = workItemView(item({ path: longPath, branch: longBranch }))
  assert.ok(view.path.length <= 1024, `path is ${view.path.length} chars`)
  assert.ok(view.branch.length <= 256, `branch is ${view.branch.length} chars`)
  assert.ok(!view.path.includes('d'.repeat(2000)))
})

// ---------------------------------------------------------------------------
// purity
// ---------------------------------------------------------------------------

test('src/work-item.ts keeps host, clock, and raw filesystem I/O out of itself', () => {
  const source = readFileSync(new URL('../src/work-item.ts', import.meta.url), 'utf8')
  // The creation flow now reuses src/checkout.ts for git and cleanup, so the
  // checkout import is expected; what must stay out is everything the injected
  // ports exist to provide.
  for (const forbidden of [/node:fs/, /node:child_process/, /from '\.\/store\.js'/, /Math\.random/, /new Date\(/, /process\./]) {
    assert.equal(forbidden.test(source), false, `work-item.ts must not contain ${forbidden}`)
  }
  for (const forbidden of [/rmSync\(/, /mkdirSync\(/, /writeFileSync\(/]) {
    assert.equal(forbidden.test(source), false, `work-item.ts must go through checkout.ts, not ${forbidden}`)
  }
  assert.match(source, /from '\.\/checkout\.js'/)
})
