import test from 'node:test'
import assert from 'node:assert/strict'
import '../support/ts-hook.mjs'
const rail = await import('../../src/client/work-item/rail-state.ts')

/** One folded thread with a line-range anchor. */
function thread(threadId, startLine, overrides = {}) {
  return {
    threadId,
    root: null,
    comments: [],
    anchor: { kind: 'line-range', path: 'docs/spec.md', startLine, endLine: startLine, quote: '' },
    resolved: false,
    anchorStatus: null,
    latestAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** Ordinals in rail order, as `threadOrdinals` returns them. */
function ordinalsOf(threads) {
  return new Map(threads.map((entry, index) => [entry.threadId, index + 1]))
}

test('the rail starts at the list level and the toolbar always opens it there', () => {
  assert.deepEqual(rail.RAIL_LIST_STATE, { view: 'list', activeThreadId: null })
  assert.equal(rail.RAIL_LIST_STATE.view, 'list')
  assert.equal(rail.RAIL_LIST_STATE.activeThreadId, null)
})

test('a card, pin, or new annotation enters the session level', () => {
  const session = rail.railSessionState('thread-2')
  assert.deepEqual(session, { view: 'session', activeThreadId: 'thread-2' })
  assert.equal(session.view, 'session')
  // A new annotation has no thread yet; the composer submits it.
  assert.deepEqual(rail.railSessionState(null), { view: 'session', activeThreadId: null })
})

test('back to the list drops the session target and keeps no state behind', () => {
  assert.deepEqual(rail.railBackToList(rail.railSessionState('thread-1')), {
    view: 'list',
    activeThreadId: null,
  })
  assert.equal(rail.railBackToList(rail.RAIL_LIST_STATE), rail.RAIL_LIST_STATE)
})

test('switching work items resets both levels', () => {
  assert.equal(rail.railAfterContextChange(), rail.RAIL_LIST_STATE)
  assert.deepEqual(rail.railAfterContextChange(), { view: 'list', activeThreadId: null })
  assert.notDeepEqual(rail.railAfterContextChange(), rail.railSessionState('thread-1'))
})

test('the session projection resolves its thread and ordinal by identity', () => {
  const threads = [thread('thread-1', 1), thread('thread-2', 5)]
  assert.equal(rail.railSessionThread(threads, rail.railSessionState('thread-2'))?.threadId, 'thread-2')
  assert.equal(rail.railSessionThread(threads, rail.railSessionState('missing')), null)
  assert.equal(rail.railSessionThread(threads, rail.railSessionState(null)), null)
  assert.equal(rail.railOrdinal(threads, 'thread-2'), 2)
  assert.equal(rail.railOrdinal(threads, 'missing'), null)
  assert.equal(rail.railOrdinal(threads, null), null)
})

test('the list projection keeps resolved cards collapsed until expanded', () => {
  const threads = [thread('open-1', 1), thread('done-1', 3, { resolved: true })]
  const ordinals = ordinalsOf(threads)
  const collapsed = rail.railListProjection(threads, ordinals, 'all', false, 'open-1')
  assert.deepEqual(collapsed.open.map((row) => row.thread.threadId), ['open-1'])
  assert.deepEqual(collapsed.resolved, [])
  assert.equal(collapsed.resolvedCount, 1)
  assert.equal(collapsed.resolvedFirst?.thread.threadId, 'done-1')
  assert.equal(collapsed.resolvedFirst?.ordinal, 2)
  assert.equal(collapsed.showSummary, true)
  assert.equal(collapsed.emptyMessage, null)
  assert.deepEqual(collapsed.open[0].ordinal, 1)
  assert.equal(collapsed.open[0].selected, true)

  const expanded = rail.railListProjection(threads, ordinals, 'all', true, null)
  assert.deepEqual(expanded.resolved.map((row) => row.thread.threadId), ['done-1'])
  assert.equal(expanded.resolved[0].ordinal, 2)
  assert.equal(expanded.resolved[0].selected, false)
  assert.equal(expanded.showSummary, true)
})

test('the list projection applies the three-state filter and empty message', () => {
  const open = thread('open-1', 1)
  const done = thread('done-1', 2, { resolved: true })
  const ordinals = ordinalsOf([open, done])

  const pending = rail.railListProjection([open, done], ordinals, 'pending', false, null)
  assert.deepEqual(pending.open.map((row) => row.thread.threadId), ['open-1'])
  assert.equal(pending.showSummary, false)

  const resolved = rail.railListProjection([open, done], ordinals, 'resolved', false, null)
  assert.deepEqual(resolved.open, [])
  assert.deepEqual(resolved.resolved.map((row) => row.thread.threadId), ['done-1'])
  assert.equal(resolved.emptyMessage, null)

  const allResolved = rail.railListProjection([done], ordinalsOf([done]), 'pending', false, null)
  assert.equal(allResolved.emptyMessage, '没有待处理的批注。')
  assert.equal(
    rail.railListProjection([], new Map(), 'all', false, null).emptyMessage,
    '还没有批注。选中行后点“批注”，或直接写整体批注。',
  )
})
