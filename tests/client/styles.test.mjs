import test from 'node:test'
import assert from 'node:assert/strict'
import '../support/ts-hook.mjs'

const { PANEL_CSS, ensurePanelStyles } = await import('../../src/client/styles.ts')

/** The host-facing stylesheet key the mounted tag is deduplicated by. */
const STYLE_KEY = '@dsh-external/dsh-cowork/panel'

/**
 * The smallest document `ensurePanelStyles` touches: `head.querySelector`,
 * `createElement('style')` and `head.appendChild`. It answers the lookup from
 * the children it was given, so the second call observes the first mount.
 */
function fakeDocument() {
  const children = []
  const selectors = []
  const doc = {
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
  return doc
}

test('ensurePanelStyles mounts the stylesheet once, keyed for the host', () => {
  const doc = fakeDocument()
  ensurePanelStyles(doc)

  assert.equal(doc.children.length, 1)
  const [tag] = doc.children
  assert.equal(tag.tagName, 'style')
  assert.deepEqual(tag.dataset, { plugin: STYLE_KEY, pluginCss: STYLE_KEY })
  assert.equal(tag.textContent, PANEL_CSS)
  assert.ok(PANEL_CSS.includes('.cw-root'), 'the mounted text is the panel stylesheet')
  assert.deepEqual(doc.selectors, [`style[data-plugin-css="${STYLE_KEY}"]`])
})

test('raised neutral surfaces use the visible overlay token in both themes', () => {
  assert.match(
    PANEL_CSS,
    /--cw-surface-muted: var\(--dsw-alias-interactive-bg-hover, var\(--dsw-alias-bg-layer-2, #f2f4f7\)\)/,
  )
  for (const selector of ['cw-notice-hint', 'cw-code', 'cw-skeleton-bar', 'cw-thread-bubble', 'cw-req-head', 'cw-req-command']) {
    assert.match(
      PANEL_CSS,
      new RegExp(`\\.${selector} \\{[\\s\\S]*?background: var\\(--cw-surface-muted\\)`),
      `${selector} uses the theme overlay fill`,
    )
  }
  assert.match(PANEL_CSS, /\.cw-thread-avatar \{[\s\S]*?state-business-tertiary/)
  assert.match(PANEL_CSS, /\.cw-thread-avatar \{[\s\S]*?label-primary-bluish/)
  assert.match(PANEL_CSS, /\.cw-card-marker\[data-marker="authorization"\] \{[\s\S]*?state-warn-tertiary/)
})

test('ensurePanelStyles is idempotent and a no-op without a document', () => {
  const doc = fakeDocument()
  ensurePanelStyles(doc)
  ensurePanelStyles(doc)

  assert.equal(doc.children.length, 1, 'a mounted stylesheet is not appended twice')
  assert.equal(doc.selectors.length, 2, 'every call checks the same key')

  ensurePanelStyles(undefined)
  assert.equal(doc.children.length, 1, 'the server render creates no node')
})
