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
  for (const selector of [
    '.cwi-list', '.cwi-list-toolbar', '.cwi-filter', '.cwi-search-toggle',
    '.cwi-search-input', '.cwi-search-clear', '.cwi-group-summary',
    '.cwi-card', '.cwi-viewer', '.cwi-cross',
    '.cwi-rail', '.cwi-rail-list', '.cwi-rail-session', '.cwi-rail-back',
    '.cwi-rail-grip', '.cwi-annotate-pop', '.cwi-annotate-button', '.cwi-line-annotate',
    '.cwi-thread[data-summary="true"]', '.cwi-thread', '.cwi-composer',
  ]) {
    assert.ok(WORK_ITEM_CSS.includes(selector), selector)
  }
  assert.match(WORK_ITEM_CSS, /@media \(max-width: 900px\)/)
  assert.match(WORK_ITEM_CSS, /prefers-reduced-motion/)
  assert.match(WORK_ITEM_CSS, /:focus-visible/)
  // The card no longer shows the stored path; the viewer header still does.
  assert.equal(WORK_ITEM_CSS.includes('.cwi-card .cwi-path'), false)
  // 待查看 keeps its raw data-status but paints the merged 待确认 chip.
  assert.ok(WORK_ITEM_CSS.includes(
    '.cwi-card-status[data-status="pending-view"], .cwi-card-status[data-status="pending-confirm"]',
  ))
})

test('the Cowork view hides the host composer only while it is mounted', () => {
  // The host exposes no per-view composer switch; the rule must stay scoped to
  // the viewer's own root class so Chat gets its composer and draft back.
  assert.match(
    WORK_ITEM_CSS,
    /\[data-conversation-scroll\]:has\(\.cwi-viewer\) > \[data-composer-seat\] \{ display: none; \}/,
  )
  // No leftover breadcrumb styling: the host header owns the session identity.
  assert.equal(WORK_ITEM_CSS.includes('cwi-crumbs'), false)
})
