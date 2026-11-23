import test from 'node:test'
import assert from 'node:assert/strict'
import '../support/ts-hook.mjs'
import { waitForMainSession, writeViewPreference } from '../../src/client/work-item/session-preference.ts'
import { openOwnerSession } from '../../src/client/work-item/session-open.ts'

/** A session catalog whose snapshot a test can replace. */
function fakeSessions(rows) {
  let snapshot = { ids: Object.keys(rows), byId: rows }
  return {
    list: {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
    },
    set(ids, byId) {
      snapshot = { ids, byId }
    },
  }
}

/** The retention row for a main-view session. */
function mainRow() {
  return { retainedBy: { mainView: 1 } }
}

/** A storage stub recording the last write. */
function fakeStorage(initial = {}) {
  const values = { ...initial }
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => { values[key] = value },
  }
}

/** A workspace stub that records the sessions it was asked to open. */
function fakeWorkspace(options = {}) {
  const opened = []
  const unarchived = []
  return {
    opened,
    unarchived,
    openSession(sessionId) {
      opened.push(sessionId)
      if (options.throwOpen === true) throw new Error('fixture open boom')
    },
    unarchiveSession: options.withoutUnarchive === true
      ? undefined
      : async (sessionId) => {
          unarchived.push(sessionId)
          if (options.unarchiveFails === true) throw new Error('fixture unarchive boom')
        },
  }
}

/** A tab strip with one Cowork tab; `select` controls whether its click sticks. */
function fakeTabStrip(select = true) {
  const tab = {
    textContent: 'Cowork',
    selected: false,
    clicks: 0,
    getAttribute: () => String(tab.selected),
    click() {
      tab.clicks += 1
      if (select) tab.selected = true
    },
  }
  return {
    tab,
    document: { querySelectorAll: () => [tab] },
  }
}

/** A wait that resolves immediately and records every step. */
function immediateWait() {
  const steps = []
  const wait = async (ms) => { steps.push(ms) }
  return { wait, steps }
}

test('the preference is stored under the host conversation key', () => {
  const storage = fakeStorage()
  assert.equal(writeViewPreference('session-1', 'cowork-work-item', storage), true)
  assert.equal(storage.values['dsh.conversation.session-1'], '{"view":"cowork-work-item"}')
})

test('a view preference merges with the stored conversation record', () => {
  for (const [raw, expected] of [
    ['{"draft":{"text":"hi"},"view":"chat"}', { draft: { text: 'hi' }, view: 'cowork-work-item' }],
    ['not json', { view: 'cowork-work-item' }],
    ['[1,2]', { view: 'cowork-work-item' }],
    ['null', { view: 'cowork-work-item' }],
  ]) {
    const storage = fakeStorage({ 'dsh.conversation.session-1': raw })
    assert.equal(writeViewPreference('session-1', 'cowork-work-item', storage), true)
    assert.deepEqual(JSON.parse(storage.values['dsh.conversation.session-1']), expected, raw)
  }
})

test('writing the preference keeps the previous fields and reports refusal', () => {
  const storage = fakeStorage({ 'dsh.conversation.session-1': '{"draft":{"text":"hi"}}' })
  assert.equal(writeViewPreference('session-1', 'cowork-work-item', storage), true)
  assert.deepEqual(JSON.parse(storage.values['dsh.conversation.session-1']), {
    draft: { text: 'hi' },
    view: 'cowork-work-item',
  })
  assert.equal(writeViewPreference('session-1', 'cowork-work-item', undefined), false)
  const failing = { getItem: () => null, setItem: () => { throw new Error('quota') } }
  assert.equal(writeViewPreference('session-1', 'cowork-work-item', failing), false)
})

test('the retention ledger decides which session is main', async () => {
  const second = fakeSessions({ a: { retainedBy: {} }, b: mainRow() })
  assert.equal(await waitForMainSession(second.list, 'b', { wait: immediateWait().wait }), true)
  const unknown = fakeSessions({ a: { retainedBy: {} } })
  assert.equal(await waitForMainSession(unknown.list, 'b', { wait: immediateWait().wait, timeoutMs: 100 }), false)
  const zero = fakeSessions({ a: { retainedBy: { mainView: 0 } } })
  assert.equal(await waitForMainSession(zero.list, 'a', { wait: immediateWait().wait, timeoutMs: 100 }), false)
})

test('waitForMainSession polls until the owner becomes main', async () => {
  const sessions = fakeSessions({ a: { retainedBy: {} } })
  const { wait, steps } = immediateWait()
  const pending = waitForMainSession(sessions.list, 'a', { wait, timeoutMs: 300 })
  sessions.set(['a'], { a: mainRow() })
  assert.equal(await pending, true)
  assert.deepEqual(steps, [100])

  const never = fakeSessions({ a: { retainedBy: {} } })
  const timeout = immediateWait()
  assert.equal(await waitForMainSession(never.list, 'a', { wait: timeout.wait, timeoutMs: 200 }), false)
  assert.deepEqual(timeout.steps, [100, 100])
})

test('an already main session and a missing catalog are handled without polling', async () => {
  const sessions = fakeSessions({ a: mainRow() })
  const { wait, steps } = immediateWait()
  assert.equal(await waitForMainSession(sessions.list, 'a', { wait }), true)
  assert.deepEqual(steps, [])
  assert.equal(await waitForMainSession(undefined, 'a'), false)
})

test('a host without a workspace service reports it instead of switching', async () => {
  const outcome = await openOwnerSession({
    ownerSessionId: 'session-1',
    uiWorkspace: undefined,
    sessions: fakeSessions({}).list ? { list: fakeSessions({}).list } : undefined,
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'no-workspace')
})

test('a failed openSession is reported and never thrown', async () => {
  const workspace = fakeWorkspace({ throwOpen: true })
  const storage = fakeStorage()
  const outcome = await openOwnerSession({
    ownerSessionId: 'session-1',
    uiWorkspace: workspace,
    sessions: { list: fakeSessions({}).list },
    storage,
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'session-not-switched')
  assert.match(outcome.message, /fixture open boom/)
  // The preference is written before the switch so the next bind reads it.
  assert.equal(JSON.parse(storage.values['dsh.conversation.session-1']).view, 'cowork-work-item')
})

test('a refused unarchive is tolerated; the switch still runs', async () => {
  const sessions = fakeSessions({ 'session-1': mainRow() })
  const workspace = fakeWorkspace({ unarchiveFails: true })
  const strip = fakeTabStrip()
  strip.tab.selected = true
  const outcome = await openOwnerSession({
    ownerSessionId: 'session-1',
    uiWorkspace: workspace,
    sessions: { list: sessions.list },
    storage: fakeStorage(),
    wait: immediateWait().wait,
    tab: { document: strip.document, wait: immediateWait().wait },
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.via, 'already')
  assert.deepEqual(workspace.unarchived, ['session-1'])
})

test('a workspace without unarchiveSession still switches', async () => {
  const sessions = fakeSessions({ 'session-1': mainRow() })
  const workspace = fakeWorkspace({ withoutUnarchive: true })
  const outcome = await openOwnerSession({
    ownerSessionId: 'session-1',
    uiWorkspace: workspace,
    sessions: { list: sessions.list },
    storage: fakeStorage(),
    wait: immediateWait().wait,
    tab: { document: fakeTabStrip().document, wait: immediateWait().wait },
  })
  assert.equal(outcome.ok, true)
})

test('an unverifiable switch keeps the read-only state', async () => {
  const workspace = fakeWorkspace()
  const outcome = await openOwnerSession({
    ownerSessionId: 'session-1',
    uiWorkspace: workspace,
    sessions: undefined,
    storage: fakeStorage(),
    wait: immediateWait().wait,
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'session-unverifiable')
  assert.deepEqual(workspace.opened, ['session-1'])
})

test('a switch that never makes the owner main is reported', async () => {
  const sessions = fakeSessions({ 'session-1': { retainedBy: {} } })
  const outcome = await openOwnerSession({
    ownerSessionId: 'session-1',
    uiWorkspace: fakeWorkspace(),
    sessions: { list: sessions.list },
    storage: fakeStorage(),
    wait: immediateWait().wait,
    timeoutMs: 200,
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'session-not-switched')
})

test('a switched session falls back to the tab click and reports how it opened', async () => {
  const sessions = fakeSessions({ 'session-1': { retainedBy: {} } })
  const strip = fakeTabStrip()
  const pending = openOwnerSession({
    ownerSessionId: 'session-1',
    uiWorkspace: fakeWorkspace(),
    sessions: { list: sessions.list },
    storage: fakeStorage(),
    wait: async () => { sessions.set(['session-1'], { 'session-1': mainRow() }) },
    tab: { document: strip.document, wait: immediateWait().wait },
  })
  const outcome = await pending
  assert.equal(outcome.ok, true)
  assert.equal(outcome.via, 'tab')
  assert.equal(strip.tab.clicks, 1)
})

test('a tab that cannot be activated is reported after the session switch', async () => {
  const sessions = fakeSessions({ 'session-1': mainRow() })
  const outcome = await openOwnerSession({
    ownerSessionId: 'session-1',
    uiWorkspace: fakeWorkspace(),
    sessions: { list: sessions.list },
    storage: fakeStorage(),
    wait: immediateWait().wait,
    // A strip without the Cowork tab: every click attempt fails on its budget.
    tab: { document: { querySelectorAll: () => [] }, wait: immediateWait().wait },
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'tab-not-switched')
  assert.match(outcome.message, /没有找到「Cowork」会话标签/)
})
