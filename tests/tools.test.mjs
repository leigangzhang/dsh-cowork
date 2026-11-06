import test from 'node:test'
import assert from 'node:assert/strict'
import { applyThreadStatus, teardownMergedCheckout } from '../src/checkout-teardown.ts'

/**
 * `src/tools.ts` cannot be imported here: it value-imports its siblings as
 * `./x.js`, and Node's type stripping does not rewrite that to `./x.ts` (see
 * the note at the top of src/memory.ts). The post-merge teardown was therefore
 * extracted into src/checkout-teardown.ts — host-free, port-only — and these
 * tests drive it with recording fakes. The tool itself only wraps its result in
 * `success({ merged: true, ... })`, so "teardown fails, merge still ok" is
 * decided entirely in the module under test.
 */

/** The plan one merge hands to the teardown. */
const PLAN = { checkoutPath: '/repo/.dsh-cowork/threads/session-a', threadId: 'session-a' }

/** The index record the store returns once `checkoutPath` is cleared. */
const DONE_THREAD = { threadId: 'session-a', status: 'done', checkoutPath: null }

/**
 * Recording fake for the five host ports. Every call appends its step name to
 * `calls.order`, so a test can assert sequence (the index update must be last)
 * as well as presence. An override may throw, reject, or return a value.
 */
function makePorts(overrides = {}) {
  const calls = {
    order: [],
    resolveWorkspace: [],
    removeCheckout: [],
    deleteWorkspace: [],
    archiveSession: [],
    updateThread: [],
  }

  const ports = {
    async resolveWorkspace(path) {
      calls.order.push('resolveWorkspace')
      calls.resolveWorkspace.push(path)
      if (overrides.resolveWorkspace !== undefined) return overrides.resolveWorkspace(path)
      return { id: 'workspace-clone' }
    },
    async removeCheckout() {
      calls.order.push('removeCheckout')
      calls.removeCheckout.push('call')
      if (overrides.removeCheckout !== undefined) return overrides.removeCheckout()
      return { ok: true, removed: true, branchDeleted: true }
    },
    async deleteWorkspace(workspaceId) {
      calls.order.push('deleteWorkspace')
      calls.deleteWorkspace.push(workspaceId)
      if (overrides.deleteWorkspace !== undefined) return overrides.deleteWorkspace(workspaceId)
      return true
    },
    async archiveSession(threadId) {
      calls.order.push('archiveSession')
      calls.archiveSession.push(threadId)
      if (overrides.archiveSession !== undefined) return overrides.archiveSession(threadId)
      return undefined
    },
    async updateThread(threadId) {
      calls.order.push('updateThread')
      calls.updateThread.push(threadId)
      if (overrides.updateThread !== undefined) return overrides.updateThread(threadId)
      return { thread: overrides.thread === undefined ? DONE_THREAD : overrides.thread }
    },
  }

  return { ports, calls }
}

// ---------------------------------------------------------------------------
// happy path
// ---------------------------------------------------------------------------

test('teardownMergedCheckout clears the clone, the workspace and the session', async () => {
  const { ports, calls } = makePorts()

  const result = await teardownMergedCheckout(PLAN, ports)

  assert.deepEqual(result.cleanup, {
    removed: true,
    branchDeleted: true,
    workspaceId: 'workspace-clone',
    workspaceDeleted: true,
    sessionArchived: true,
  })
  assert.deepEqual(result.cleanupErrors, [])
  assert.deepEqual(result.thread, DONE_THREAD)
  assert.deepEqual(calls.resolveWorkspace, [PLAN.checkoutPath], 'the workspace is resolved from the clone path')
  assert.deepEqual(calls.deleteWorkspace, ['workspace-clone'])
  assert.deepEqual(calls.archiveSession, ['session-a'])
  assert.deepEqual(calls.updateThread, ['session-a'], 'the index write carries the thread id')
  assert.deepEqual(
    calls.order,
    ['resolveWorkspace', 'removeCheckout', 'deleteWorkspace', 'archiveSession', 'updateThread'],
    'the index update runs last: it is what records the merge as finished',
  )
})

// ---------------------------------------------------------------------------
// fault injection: several steps fail, the merge still counts as done
// ---------------------------------------------------------------------------

test('three failing teardown steps are collected and the index is still updated', async () => {
  const { ports, calls } = makePorts({
    removeCheckout: () => ({ ok: false, message: 'clone is busy' }),
    deleteWorkspace: () => {
      throw new Error('workspace registry is read-only')
    },
    archiveSession: () => {
      throw new Error('session is running')
    },
  })

  const result = await teardownMergedCheckout(PLAN, ports)

  // No throw and no "failed" flag: the merge landed, so the caller still
  // returns ok:true and only reports what the cleanup could not finish.
  assert.equal(result.cleanupErrors.length, 3)
  assert.match(result.cleanupErrors[0], /^checkout: clone is busy/)
  assert.match(result.cleanupErrors[1], /^workspace: workspace registry is read-only/)
  assert.match(result.cleanupErrors[2], /^session: session is running/)
  assert.deepEqual(result.cleanup, {
    removed: false,
    branchDeleted: false,
    workspaceId: 'workspace-clone',
    workspaceDeleted: false,
    sessionArchived: false,
  })
  // The last step ran anyway: that is the whole point of per-step catching.
  assert.deepEqual(calls.updateThread, ['session-a'])
  assert.deepEqual(result.thread, DONE_THREAD, 'the index still records the thread as done')
  assert.equal(calls.order.at(-1), 'updateThread')
})

test('a failed workspace lookup is reported and skips only the workspace delete', async () => {
  const { ports, calls } = makePorts({
    resolveWorkspace: () => {
      throw new Error('registry offline')
    },
  })

  const result = await teardownMergedCheckout(PLAN, ports)

  assert.equal(result.cleanupErrors.length, 1)
  assert.match(result.cleanupErrors[0], /^workspace lookup: registry offline/)
  assert.equal(result.cleanup.workspaceId, null)
  assert.deepEqual(calls.deleteWorkspace, [], 'no id to delete: the delete is skipped, the rest still runs')
  assert.deepEqual(calls.updateThread, ['session-a'])
  assert.equal(result.cleanup.sessionArchived, true)
  assert.equal(result.cleanup.removed, true)
})

test('a missing workspace (undefined) is not an error', async () => {
  const { ports, calls } = makePorts({ resolveWorkspace: () => undefined })

  const result = await teardownMergedCheckout(PLAN, ports)

  assert.deepEqual(result.cleanupErrors, [])
  assert.equal(result.cleanup.workspaceId, null)
  assert.equal(result.cleanup.workspaceDeleted, false)
  assert.deepEqual(calls.deleteWorkspace, [])
  assert.deepEqual(calls.updateThread, ['session-a'])
})

test('a rejecting removeCheckout is caught as a teardown error, not thrown', async () => {
  const { ports, calls } = makePorts({
    removeCheckout: async () => {
      throw new Error('rm exploded')
    },
  })

  const result = await teardownMergedCheckout(PLAN, ports)

  assert.equal(result.cleanupErrors.length, 1)
  assert.match(result.cleanupErrors[0], /^checkout: rm exploded/)
  assert.equal(result.cleanup.removed, false)
  assert.deepEqual(calls.updateThread, ['session-a'])
})

test('a failing index update is reported without undoing the merge', async () => {
  const { ports, calls } = makePorts({
    updateThread: () => {
      throw new Error('index is locked')
    },
  })

  const result = await teardownMergedCheckout(PLAN, ports)

  assert.equal(result.cleanupErrors.length, 1)
  assert.match(result.cleanupErrors[0], /^index: index is locked/)
  assert.equal(result.thread, null, 'no record to show, but the cleanup still happened')
  assert.equal(result.cleanup.removed, true)
  assert.equal(result.cleanup.sessionArchived, true)
  assert.deepEqual(calls.updateThread, ['session-a'])
})

test('a non-Error rejection is still rendered as text', async () => {
  const { ports } = makePorts({
    archiveSession: async () => {
      throw 'string failure'
    },
  })

  const result = await teardownMergedCheckout(PLAN, ports)

  assert.deepEqual(result.cleanupErrors, ['session: string failure'])
})

// ---------------------------------------------------------------------------
// conflict path: the index write failure must stay visible
// ---------------------------------------------------------------------------

test('applyThreadStatus surfaces a failed index write instead of throwing', async () => {
  const failing = await applyThreadStatus(async () => {
    throw new Error('index is locked')
  })

  assert.deepEqual(failing, { thread: null, error: 'index is locked' })
})

test('applyThreadStatus returns the updated record on success', async () => {
  const blocked = { threadId: 'session-a', status: 'blocked', checkoutPath: PLAN.checkoutPath }
  const ok = await applyThreadStatus(async () => ({ thread: blocked }))

  assert.deepEqual(ok, { thread: blocked, error: null })
})
