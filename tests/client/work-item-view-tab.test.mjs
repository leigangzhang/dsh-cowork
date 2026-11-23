import test from 'node:test'
import assert from 'node:assert/strict'
import '../support/ts-hook.mjs'
import { activateViewTab } from '../../src/client/work-item/view-tab.ts'

/** The tab strip selector the activation is allowed to search. */
const TAB_SELECTOR = '[data-conversation-tabs] button[role="tab"]'

/** One fake tab button: text, aria-selected, and a recorded click count. */
function fakeTab(text, options = {}) {
  const tab = {
    textContent: text,
    selected: options.selected === true,
    clicks: 0,
    onClick: options.onClick ?? null,
    getAttribute(name) {
      assert.equal(name, 'aria-selected')
      return String(tab.selected)
    },
    click() {
      tab.clicks += 1
      tab.onClick?.(tab)
    },
  }
  return tab
}

/** A fake document that records the selector and returns the scripted tabs. */
function fakeDocument(script) {
  const tabs = []
  const selectors = []
  return {
    tabs,
    selectors,
    querySelectorAll(selector) {
      selectors.push(selector)
      return script(tabs)
    },
  }
}

/** A wait that resolves immediately and records each step. */
function immediateWait() {
  const steps = []
  const wait = async (ms) => { steps.push(ms) }
  return { wait, steps }
}

test('an already active Cowork tab is not clicked', async () => {
  const tab = fakeTab('Cowork', { selected: true })
  const doc = fakeDocument(() => [tab, fakeTab('Chat')])
  const { wait } = immediateWait()
  assert.equal(await activateViewTab({ document: doc, wait }), 'already')
  assert.equal(tab.clicks, 0)
  assert.deepEqual(doc.selectors, [TAB_SELECTOR])
})

test('the activation clicks the matching tab and verifies aria-selected', async () => {
  const tab = fakeTab('Cowork')
  const doc = fakeDocument(() => [fakeTab('Chat'), tab])
  const { wait, steps } = immediateWait()
  let polls = 0
  const scripted = async (ms) => {
    polls += 1
    await wait(ms)
    // The third poll marks the tab active, like a host render.
    if (polls === 3) tab.selected = true
  }
  assert.equal(await activateViewTab({ document: doc, wait: scripted }), 'activated')
  assert.equal(tab.clicks, 1)
  assert.deepEqual(steps, [100, 100, 100])
})

test('a tab that renders after registration is clicked, not reported missing', async () => {
  const tab = fakeTab('Cowork', { onClick: (current) => { current.selected = true } })
  let rendered = false
  const doc = fakeDocument(() => (rendered ? [tab] : []))
  const scripted = async () => { rendered = true }
  assert.equal(await activateViewTab({ document: doc, wait: scripted }), 'activated')
  assert.equal(tab.clicks, 1)
})

test('a missing tab fails with tab-missing after the render budget', async () => {
  const doc = fakeDocument(() => [fakeTab('Chat')])
  const { wait, steps } = immediateWait()
  await assert.rejects(
    activateViewTab({ document: doc, wait }),
    (error) => error.name === 'ViewTabError' && error.code === 'tab-missing',
  )
  // 2500 ms budget at 100 ms per step.
  assert.equal(steps.length, 25)
})

test('an unresponsive tab fails with tab-not-selected after the click budget', async () => {
  const tab = fakeTab('Cowork')
  const doc = fakeDocument(() => [tab])
  const { wait } = immediateWait()
  await assert.rejects(
    activateViewTab({ document: doc, wait, maxClicks: 2 }),
    (error) => error.name === 'ViewTabError' && error.code === 'tab-not-selected',
  )
  assert.equal(tab.clicks, 2)
})

test('a host without a document fails instead of hanging', async () => {
  await assert.rejects(
    activateViewTab({ document: undefined }),
    (error) => error.name === 'ViewTabError' && error.code === 'tab-missing',
  )
})

test('the default poll waits for the host instead of requiring an injected timer', async () => {
  const tab = fakeTab('Cowork', { onClick: (current) => { current.selected = true } })
  const doc = fakeDocument(() => [tab])
  // No `wait` override: exercises the production setTimeout step (one 100 ms
  // poll), not a readiness sleep.
  assert.equal(await activateViewTab({ document: doc }), 'activated')
})

test('the label match ignores a longer tab name', async () => {
  const longer = fakeTab('Cowork 视图')
  const tab = fakeTab('Cowork', { onClick: (current) => { current.selected = true } })
  const doc = fakeDocument(() => [fakeTab(' Chat '), longer, tab])
  const { wait } = immediateWait()
  assert.equal(await activateViewTab({ document: doc, wait }), 'activated')
  assert.equal(tab.clicks, 1)
  assert.equal(longer.clicks, 0)
})

test('a selectable node without click is not treated as the tab', async () => {
  const doc = fakeDocument(() => [{ textContent: 'Cowork', getAttribute: () => 'false' }])
  const { wait } = immediateWait()
  await assert.rejects(
    activateViewTab({ document: doc, wait }),
    (error) => error.name === 'ViewTabError' && error.code === 'tab-missing',
  )
})
