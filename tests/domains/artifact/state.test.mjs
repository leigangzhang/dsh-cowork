import test from 'node:test'
import assert from 'node:assert/strict'
import { artifactState, makeComment, makeRecord } from '../../support/artifact-fixtures.mjs'

/**
 * The collaboration-state axis: opening the viewer, confirming, and folding a
 * comment in. Delivery states are a different axis and never appear here.
 */
const NOW = new Date('2026-02-02T00:00:00.000Z')

test('view moves only the first open and is idempotent afterwards', () => {
  const pending = makeRecord({ status: 'pending-view' })
  const opened = artifactState.applyStatusAction(pending, 'view', NOW)
  assert.equal(opened.changed, true)
  assert.equal(opened.record.status, 'pending-confirm')
  assert.equal(opened.record.updatedAt, NOW.toISOString())
  for (const status of ['pending-confirm', 'needs-feedback', 'in-progress', 'confirmed']) {
    const record = makeRecord({ status })
    const result = artifactState.applyStatusAction(record, 'view', NOW)
    assert.equal(result.changed, false)
    assert.equal(result.record, record)
  }
})

test('confirm accepts every unfinished state and is idempotent once confirmed', () => {
  for (const status of ['pending-view', 'pending-confirm', 'needs-feedback', 'in-progress']) {
    const result = artifactState.applyStatusAction(makeRecord({ status }), 'confirm', NOW)
    assert.equal(result.changed, true)
    assert.equal(result.record.status, 'confirmed')
    assert.equal(result.record.updatedAt, NOW.toISOString())
  }
  const confirmed = makeRecord({ status: 'confirmed' })
  const replay = artifactState.applyStatusAction(confirmed, 'confirm', NOW)
  assert.equal(replay.changed, false)
  assert.equal(replay.record, confirmed)
})

test('a new comment counts as feedback and reopens a confirmed item', () => {
  const pending = makeRecord({ status: 'pending-confirm', commentCount: 2 })
  const created = artifactState.applyCommentEvent(pending, makeComment(), NOW)
  assert.equal(created.changed, true)
  assert.equal(created.record.status, 'needs-feedback')
  assert.equal(created.record.commentCount, 3)
  assert.equal(created.record.updatedAt, NOW.toISOString())

  const confirmed = artifactState.applyCommentEvent(makeRecord({ status: 'confirmed' }), makeComment(), NOW)
  assert.equal(confirmed.record.status, 'needs-feedback')

  const reply = artifactState.applyCommentEvent(
    makeRecord({ status: 'pending-view' }),
    makeComment({ type: 'reply', commentId: 'comment-2', threadId: 'comment-1' }),
    NOW,
  )
  assert.equal(reply.record.status, 'needs-feedback')
  assert.equal(reply.record.commentCount, 1)
})

test('comments during feedback or work keep the status while counting', () => {
  for (const status of ['needs-feedback', 'in-progress']) {
    const record = makeRecord({ status, commentCount: 4 })
    const result = artifactState.applyCommentEvent(record, makeComment(), NOW)
    assert.equal(result.record.status, status)
    assert.equal(result.record.commentCount, 5)
  }
})

test('resolve, reopen and anchor-moved touch only the timestamp', () => {
  for (const type of ['resolve', 'reopen', 'anchor-moved']) {
    const record = makeRecord({ status: 'needs-feedback', commentCount: 3 })
    const event = type === 'anchor-moved'
      ? makeComment({ type, anchor: { kind: 'whole', path: 'docs/spec.md' }, anchorStatus: 'stale' })
      : makeComment({ type })
    const result = artifactState.applyCommentEvent(record, event, NOW)
    assert.equal(result.changed, true)
    assert.equal(result.record.status, 'needs-feedback')
    assert.equal(result.record.commentCount, 3)
    assert.equal(result.record.updatedAt, NOW.toISOString())
  }
})

test('a dispatch summary is recorded only when one exists', () => {
  const record = makeRecord({ status: 'needs-feedback' })
  const unchanged = artifactState.applyActiveDispatch(record, null, NOW)
  assert.equal(unchanged.changed, false)
  assert.equal(unchanged.record, record)
  const dispatched = artifactState.applyActiveDispatch(record, { dispatchId: 'dispatch-1', state: 'queued' }, NOW)
  assert.equal(dispatched.changed, true)
  assert.deepEqual(dispatched.record.activeDispatch, {
    dispatchId: 'dispatch-1',
    state: 'queued',
    updatedAt: NOW.toISOString(),
  })
  assert.equal(dispatched.record.status, 'needs-feedback')
})
