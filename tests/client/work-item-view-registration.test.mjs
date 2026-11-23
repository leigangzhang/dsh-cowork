import test from 'node:test'
import assert from 'node:assert/strict'
import '../support/ts-hook.mjs'
import { COWORK_VIEW_ID, COWORK_VIEW_LABEL } from '../../src/client/contracts.ts'
import { workItemOpenStore } from '../../src/client/work-item/store.ts'
import { bindWorkItemView } from '../../src/client/work-item/view-registration.ts'

/** A slot service stub that records entries and their disposal. */
function fakeSlots() {
  const entries = []
  return {
    entries,
    register(options, component) {
      const entry = { options, component, disposed: false }
      entries.push(entry)
      return () => { entry.disposed = true }
    },
    inject() {
      throw new Error('the binding must not inject slots itself')
    },
  }
}

/** A placeholder component; the seat only needs a renderable reference. */
function View() {
  return null
}

test('the view registers only while a work item is open', () => {
  workItemOpenStore.close()
  const slots = fakeSlots()
  const dispose = bindWorkItemView(slots, View)
  assert.equal(slots.entries.length, 0)

  workItemOpenStore.open({ artifactId: 'artifact-1', ownerSessionId: 'session-1' })
  assert.equal(slots.entries.length, 1)
  const [entry] = slots.entries
  assert.equal(entry.options.name, 'conversation.view')
  assert.equal(entry.options.id, COWORK_VIEW_ID)
  assert.equal(entry.options.order, 20)
  assert.equal(entry.options.label(), COWORK_VIEW_LABEL)
  assert.deepEqual(entry.options.inject('session-1'), { sessionId: 'session-1' })
  assert.equal(entry.component, View)

  // Re-opening the same item, or switching items, must not add a second tab.
  workItemOpenStore.open({ artifactId: 'artifact-1', ownerSessionId: 'session-1' })
  workItemOpenStore.open({ artifactId: 'artifact-2', ownerSessionId: 'session-1' })
  assert.equal(slots.entries.length, 1)

  workItemOpenStore.close()
  assert.equal(entry.disposed, true)
  assert.equal(slots.entries.length, 1)

  // Closing an already closed store does not emit again.
  workItemOpenStore.close()
  assert.equal(entry.disposed, true)

  dispose()
})

test('binding while an item is already open registers immediately', () => {
  workItemOpenStore.close()
  workItemOpenStore.open({ artifactId: 'artifact-1', ownerSessionId: 'session-1' })
  const slots = fakeSlots()
  const dispose = bindWorkItemView(slots, View)
  assert.equal(slots.entries.length, 1)
  dispose()
  assert.equal(slots.entries[0].disposed, true)

  // The binding no longer tracks the store after disposal.
  workItemOpenStore.close()
  workItemOpenStore.open({ artifactId: 'artifact-2', ownerSessionId: 'session-1' })
  assert.equal(slots.entries.length, 1)
  workItemOpenStore.close()
})

test('disposing a closed binding is idempotent', () => {
  workItemOpenStore.close()
  const slots = fakeSlots()
  const dispose = bindWorkItemView(slots, View)
  dispose()
  dispose()
  workItemOpenStore.open({ artifactId: 'artifact-1', ownerSessionId: 'session-1' })
  assert.equal(slots.entries.length, 0)
  workItemOpenStore.close()
})
