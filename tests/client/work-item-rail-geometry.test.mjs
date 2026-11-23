import test from 'node:test'
import assert from 'node:assert/strict'
import '../support/ts-hook.mjs'
const geometry = await import('../../src/client/work-item/rail-geometry.ts')
const artifactContract = await import('../../src/panel/artifact-contract.ts')

/** A storage double that records writes and can fail like a blocked browser. */
function storage(initial = null, fail = false) {
  const writes = []
  return {
    writes,
    getItem(key) {
      if (fail) throw new Error('blocked')
      return key === 'cowork.work-item.railWidth' ? initial : null
    },
    setItem(key, value) {
      if (fail) throw new Error('blocked')
      writes.push([key, value])
    },
  }
}

test('the rail width clamps to 280-560 and keeps a readable document column', () => {
  assert.equal(geometry.railWidthClamp(336, 1200), 336)
  assert.equal(geometry.railWidthClamp(100, 1200), 280)
  assert.equal(geometry.railWidthClamp(999, 1200), 560)
  // container 800 -> upper bound 440 (800 - 360).
  assert.equal(geometry.railWidthClamp(999, 800), 440)
  // A container too narrow for both minimums keeps the 280px floor.
  assert.equal(geometry.railWidthClamp(400, 500), 280)
  // Before the body is measured only the fixed range applies.
  assert.equal(geometry.railWidthClamp(999, 0), 560)
  assert.equal(geometry.railWidthClamp(Number.NaN, 1200), 336)
  assert.equal(geometry.railWidthClamp(336.6, 1200), 337)
})

test('arrow keys move the left-edge grip by 8px and clamp the result', () => {
  assert.equal(geometry.railWidthAfterKey(336, 'ArrowLeft', 1200), 344)
  assert.equal(geometry.railWidthAfterKey(336, 'ArrowRight', 1200), 328)
  assert.equal(geometry.railWidthAfterKey(280, 'ArrowRight', 1200), 280)
  assert.equal(geometry.railWidthAfterKey(560, 'ArrowLeft', 1200), 560)
  assert.equal(geometry.railWidthAfterKey(440, 'ArrowRight', 800), 432)
})

test('the stored width falls back to the default and the fixed range', () => {
  assert.equal(geometry.readRailWidth(storage(null)), 336)
  assert.equal(geometry.readRailWidth(storage('not-a-number')), 336)
  assert.equal(geometry.readRailWidth(storage('320')), 320)
  assert.equal(geometry.readRailWidth(storage('320.9')), 320)
  assert.equal(geometry.readRailWidth(storage('10')), 280)
  assert.equal(geometry.readRailWidth(storage('9999')), 560)
})

test('reading and saving survive a blocked or absent storage', () => {
  const memory = storage('352')
  assert.equal(geometry.readRailWidth(memory), 352)
  assert.equal(geometry.readRailWidth(null), 336)
  assert.equal(geometry.readRailWidth(storage(null, true)), 336)

  geometry.saveRailWidth(memory, 360.4)
  assert.deepEqual(memory.writes, [['cowork.work-item.railWidth', '360']])
  geometry.saveRailWidth(null, 360)
  geometry.saveRailWidth(storage(null, true), 360)
  assert.deepEqual(memory.writes, [['cowork.work-item.railWidth', '360']])

  // node --test has no window: the browser storage is absent, not a crash.
  assert.equal(geometry.browserRailStorage(), null)
})

test('a blocked browser storage is absent instead of crashing', () => {
  const previous = globalThis.window
  try {
    const blocked = Object.defineProperty({}, 'localStorage', {
      configurable: true,
      get() { throw new Error('blocked') },
    })
    Object.defineProperty(globalThis, 'window', { configurable: true, value: blocked })
    assert.equal(geometry.browserRailStorage(), null)
  } finally {
    if (previous === undefined) delete globalThis.window
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: previous })
  }
})

test('rect intersection falls back to the bounds when there is no overlap', () => {
  const overlap = geometry.intersectRects(
    { left: 100, top: 100, width: 400, height: 300 },
    { left: 0, top: 0, width: 300, height: 200 },
  )
  assert.deepEqual(overlap, { left: 100, top: 100, width: 200, height: 100 })
  const outside = { left: 600, top: 600, width: 100, height: 100 }
  assert.deepEqual(geometry.intersectRects({ left: 0, top: 0, width: 10, height: 10 }, outside), outside)
})

test('the annotate entry sits 8px below the selection, centred and clamped', () => {
  const bounds = { left: 0, top: 0, width: 1200, height: 800 }
  const selection = { left: 500, top: 100, width: 200, height: 20 }
  assert.deepEqual(geometry.annotationPopPosition(selection, bounds), { left: 484, top: 128 })
  // Near the right edge the entry clamps inside the bounds.
  const edge = { left: 1100, top: 100, width: 80, height: 20 }
  const edgePosition = geometry.annotationPopPosition(edge, bounds)
  assert.equal(edgePosition.left, 1200 - 232)
  assert.equal(edgePosition.top, 128)
})

test('the annotate entry flips above and stays inside the bounds', () => {
  const bounds = { left: 0, top: 0, width: 800, height: 400 }
  const low = { left: 100, top: 380, width: 120, height: 20 }
  const above = geometry.annotationPopPosition(low, bounds)
  assert.equal(above.top, 380 - 36 - 8)
  // Neither side fits: keep it inside the bounds near the selection.
  const middle = { left: 100, top: 10, width: 120, height: 380 }
  const cramped = geometry.annotationPopPosition(middle, { left: 0, top: 0, width: 800, height: 60 })
  assert.ok(cramped.top >= 0 && cramped.top + 36 <= 60)
  const custom = geometry.annotationPopPosition(
    { left: 0, top: 100, width: 10, height: 10 },
    bounds,
    { width: 100, height: 20 },
    12,
  )
  assert.deepEqual(custom, { left: 0, top: 122 })
})

test('a sub-line selection is trimmed and capped by code points', () => {
  assert.equal(geometry.selectedTextOf(null), undefined)
  assert.equal(geometry.selectedTextOf({ toString: () => '   ' }), undefined)
  assert.equal(geometry.selectedTextOf({ toString: () => '  beta  ' }), 'beta')
  assert.equal(geometry.selectedTextOf({ toString: () => 'abcd' }, 2), 'ab')
  assert.equal(geometry.selectedTextOf({ toString: () => '😀😀😀' }, 2), '😀😀')
  const long = geometry.selectedTextOf({ toString: () => 'x'.repeat(5000) })
  assert.equal(Array.from(long).length, artifactContract.MAX_ARTIFACT_QUOTE_CHARS)
})

test('the menu key covers the dedicated key and Shift+F10', () => {
  assert.equal(geometry.isMenuKey({ key: 'ContextMenu' }), true)
  assert.equal(geometry.isMenuKey({ key: 'Apps' }), true)
  assert.equal(geometry.isMenuKey({ key: 'F10', shiftKey: true }), true)
  assert.equal(geometry.isMenuKey({ key: 'F10', shiftKey: false }), false)
  assert.equal(geometry.isMenuKey({ key: 'Escape' }), false)
})

test('the range chip names one line or a span', () => {
  assert.equal(geometry.lineRangeLabel(3, 3), '第 3 行')
  assert.equal(geometry.lineRangeLabel(3, 5), '第 3–5 行')
})
