import test from 'node:test'
import assert from 'node:assert/strict'
import '../support/ts-hook.mjs'
import { WorkItemOpenStore, workItemOpenStore } from '../../src/client/work-item/store.ts'

/** The open-work-item external store: one context, stable snapshots, idempotence. */
test('open, replace, and close one context', () => {
  const store = new WorkItemOpenStore()
  const seen = []
  const unsubscribe = store.subscribe(() => seen.push(store.getSnapshot()))
  assert.deepEqual(store.getSnapshot(), { context: null })

  store.open({ sessionId: 'session-1', artifactId: 'artifact-1' })
  assert.deepEqual(store.getSnapshot(), { context: { sessionId: 'session-1', artifactId: 'artifact-1' } })
  assert.equal(seen.length, 1)

  // Re-opening the same pair must not emit or replace the snapshot object.
  const stable = store.getSnapshot()
  store.open({ sessionId: 'session-1', artifactId: 'artifact-1' })
  assert.equal(store.getSnapshot(), stable)
  assert.equal(seen.length, 1)

  store.open({ sessionId: 'session-1', artifactId: 'artifact-2' })
  assert.equal(seen.length, 2)
  assert.equal(store.getSnapshot().context.artifactId, 'artifact-2')

  unsubscribe()
  store.open({ sessionId: 'session-1', artifactId: 'artifact-3' })
  assert.equal(seen.length, 2)

  store.close()
  assert.deepEqual(store.getSnapshot(), { context: null })
  store.close()
  assert.deepEqual(store.getSnapshot(), { context: null })
})

test('the plugin store starts closed', () => {
  assert.equal(workItemOpenStore.getSnapshot().context, null)
})
