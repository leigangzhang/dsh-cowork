import test from 'node:test'
import assert from 'node:assert/strict'
import '../support/ts-hook.mjs'
const preview = await import('../../src/client/work-item/attachment-preview-model.ts')

test('the preview kind follows the media type and the extension fallback', () => {
  assert.equal(preview.previewKindOf('image/png', 'shot.png'), 'image')
  assert.equal(preview.previewKindOf('text/markdown; charset=utf-8', 'a.md'), 'text')
  assert.equal(preview.previewKindOf('text/csv', 'data.csv'), 'text')
  assert.equal(preview.previewKindOf('application/json', 'data'), 'text')
  // A generic stored type falls back to the extension.
  assert.equal(preview.previewKindOf('application/octet-stream', 'notes.MD'), 'text')
  assert.equal(preview.previewKindOf('application/octet-stream', 'archive.zip'), 'other')
  assert.equal(preview.previewKindOf('application/octet-stream', 'noext'), 'other')
})

test('a long screenshot starts width-fit and every other image starts contain', () => {
  assert.equal(preview.defaultFitForImage(3000, 600), 'width')
  assert.equal(preview.defaultFitForImage(1200, 600), 'contain')
  assert.equal(preview.defaultFitForImage(600, 600), 'contain')
  assert.equal(preview.defaultFitForImage(3000, 0), 'contain')
  assert.equal(preview.defaultFitForImage(0, 600), 'contain')
  assert.equal(preview.nextFit('contain'), 'width')
  assert.equal(preview.nextFit('width'), 'contain')
  assert.equal(preview.fitLabel('contain'), '适应页面')
  assert.equal(preview.fitLabel('width'), '适合宽度')
})

test('zoom steps by 10% and clamps both ends', () => {
  assert.equal(preview.zoomStep(100, 1), 110)
  assert.equal(preview.zoomStep(100, -1), 90)
  assert.equal(preview.zoomStep(preview.PREVIEW_ZOOM_MIN, -1), preview.PREVIEW_ZOOM_MIN)
  assert.equal(preview.zoomStep(preview.PREVIEW_ZOOM_MAX, 1), preview.PREVIEW_ZOOM_MAX)
  // Out-of-range zoom values clamp inside every consumer of the scale.
  const atMin = preview.imageDisplaySize({
    naturalWidth: 100, naturalHeight: 100, stageWidth: 400, stageHeight: 300, fit: 'contain', zoomPercent: 5,
  })
  assert.deepEqual(atMin, { width: 10, height: 10 })
  const atMax = preview.imageDisplaySize({
    naturalWidth: 100, naturalHeight: 100, stageWidth: 400, stageHeight: 300, fit: 'contain', zoomPercent: 9999,
  })
  assert.deepEqual(atMax, { width: 400, height: 400 })
})

test('contain never upscales a small image; width-fit fills the stage', () => {
  const small = preview.imageDisplaySize({
    naturalWidth: 100, naturalHeight: 100, stageWidth: 400, stageHeight: 300, fit: 'contain', zoomPercent: 100,
  })
  assert.deepEqual(small, { width: 100, height: 100 })
  const large = preview.imageDisplaySize({
    naturalWidth: 1000, naturalHeight: 500, stageWidth: 400, stageHeight: 300, fit: 'contain', zoomPercent: 100,
  })
  assert.deepEqual(large, { width: 400, height: 200 })
  const long = preview.imageDisplaySize({
    naturalWidth: 500, naturalHeight: 2000, stageWidth: 400, stageHeight: 600, fit: 'width', zoomPercent: 100,
  })
  assert.deepEqual(long, { width: 400, height: 1600 })
  const zoomed = preview.imageDisplaySize({
    naturalWidth: 500, naturalHeight: 2000, stageWidth: 400, stageHeight: 600, fit: 'width', zoomPercent: 200,
  })
  assert.deepEqual(zoomed, { width: 800, height: 3200 })
  // A zero/negative measurement never produces a zero-size box.
  const guarded = preview.imageDisplaySize({
    naturalWidth: 0, naturalHeight: 0, stageWidth: 0, stageHeight: 0, fit: 'contain', zoomPercent: 100,
  })
  assert.deepEqual(guarded, { width: 1, height: 1 })
})

test('the text preview slices the leading UTF-8 bytes without splitting a code point', () => {
  const short = preview.textPreview('hello')
  assert.deepEqual(short, { text: 'hello', truncated: false, omittedBytes: 0 })
  const long = preview.textPreview('abcdefghij', 4)
  assert.equal(long.text, 'abcd')
  assert.equal(long.truncated, true)
  assert.equal(long.omittedBytes, 6)
  // One 4-byte emoji fits in a 6-byte cap; the second one is left out.
  const emoji = preview.textPreview('😀😀', 6)
  assert.equal(emoji.text, '😀')
  assert.equal(emoji.omittedBytes, 4)
  assert.equal(emoji.truncated, true)
  // A cap below the first code point shows nothing rather than half a point.
  const none = preview.textPreview('😀', 2)
  assert.equal(none.text, '')
  assert.equal(none.omittedBytes, 4)
})

test('the dialog title names the attachment and focus returns to its trigger', () => {
  assert.equal(preview.previewTitle({ name: 'shot.png' }), '附件预览：shot.png')
  assert.equal(preview.restoreFocus(null), false)
  let focused = 0
  assert.equal(preview.restoreFocus({ focus: () => { focused += 1 } }), true)
  assert.equal(focused, 1)
})
