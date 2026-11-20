import test from 'node:test'
import assert from 'node:assert/strict'
import '../support/ts-hook.mjs'
import { WORK_ITEM_CSS, WORK_ITEM_STYLE_ID, ensureWorkItemStyles } from '../../src/client/work-item/styles.ts'

/** The minimal document the mount function touches. */
function fakeDocument() {
  const children = []
  const selectors = []
  return {
    children,
    selectors,
    createElement(tagName) {
      assert.equal(tagName, 'style')
      return { tagName, dataset: {}, textContent: '' }
    },
    head: {
      querySelector(selector) {
        selectors.push(selector)
        return children.find((node) => node.tagName === 'style') ?? null
      },
      appendChild(node) {
        children.push(node)
        return node
      },
    },
  }
}

test('the stylesheet mounts once and is keyed for the host', () => {
  const doc = fakeDocument()
  ensureWorkItemStyles(doc)
  assert.equal(doc.children.length, 1)
  const [tag] = doc.children
  assert.deepEqual(tag.dataset, { plugin: WORK_ITEM_STYLE_ID, pluginCss: WORK_ITEM_STYLE_ID })
  assert.equal(tag.textContent, WORK_ITEM_CSS)
  assert.deepEqual(doc.selectors, [`style[data-plugin-css="${WORK_ITEM_STYLE_ID}"]`])
  ensureWorkItemStyles(doc)
  assert.equal(doc.children.length, 1)
})

test('a host without a document is a no-op', () => {
  assert.equal(ensureWorkItemStyles(undefined), undefined)
})

test('the sheet covers the list, viewer, rail, and the narrow layout', () => {
  for (const selector of ['.cwi-list', '.cwi-filter', '.cwi-card', '.cwi-viewer', '.cwi-rail', '.cwi-thread', '.cwi-composer']) {
    assert.ok(WORK_ITEM_CSS.includes(selector), selector)
  }
  assert.match(WORK_ITEM_CSS, /@media \(max-width: 900px\)/)
  assert.match(WORK_ITEM_CSS, /prefers-reduced-motion/)
  assert.match(WORK_ITEM_CSS, /:focus-visible/)
})
