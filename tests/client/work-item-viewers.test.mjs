import test from 'node:test'
import assert from 'node:assert/strict'
import '../support/ts-hook.mjs'
const document = await import('../../src/client/work-item/viewers/document.ts')

test('viewerKindOf maps the stage-4 types and keeps the rest on source', () => {
  assert.equal(document.viewerKindOf('text'), 'text')
  assert.equal(document.viewerKindOf('diagram'), 'diagram')
  assert.equal(document.viewerKindOf('html'), 'html')
  assert.equal(document.viewerKindOf('canvas'), 'canvas')
  for (const type of ['doc', 'table', 'pdf', 'image', 'other']) {
    assert.equal(document.viewerKindOf(type), 'source')
  }
})

test('the static HTML preview forbids scripts and network', () => {
  const html = document.htmlPreviewDocument('<h1>hi</h1>', false)
  assert.ok(html.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"'))
  assert.ok(html.includes("script-src 'none'"))
  assert.ok(html.includes("connect-src 'none'"))
  assert.ok(html.includes("default-src 'none'"))
  assert.ok(html.includes('<meta name="referrer" content="no-referrer">'))
  assert.ok(html.endsWith('<h1>hi</h1>'))
  assert.equal(html.includes("script-src 'unsafe-inline'"), false)
})

test('the interactive HTML preview allows inline scripts but no network', () => {
  const html = document.htmlPreviewDocument('<script>1</script>', true)
  assert.ok(html.includes("script-src 'unsafe-inline'"))
  assert.ok(html.includes("connect-src 'none'"))
  assert.ok(html.includes("default-src 'none'"))
  assert.ok(html.endsWith('<script>1</script>'))
})

test('the policy meta precedes any source byte', () => {
  const html = document.htmlPreviewDocument('<!doctype html><html><head><script src="x"></script></head></html>', false)
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<html>'))
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'))
})

test('parseCanvasScene accepts a scene with no view state and no files', () => {
  const parsed = document.parseCanvasScene(JSON.stringify({ elements: [{ id: 'a', type: 'rectangle' }] }))
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.scene.appState, {})
  assert.deepEqual(parsed.scene.files, {})
  assert.equal(parsed.scene.elements.length, 1)
})

test('parseCanvasScene accepts appState and embedded files', () => {
  const parsed = document.parseCanvasScene(JSON.stringify({
    elements: [{ id: 'a', type: 'text' }, { id: 'b', type: 'arrow' }],
    appState: { viewBackgroundColor: '#fff' },
    files: { 'file-1': { mimeType: 'image/png' } },
  }))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.scene.appState.viewBackgroundColor, '#fff')
  assert.deepEqual(Object.keys(parsed.scene.files), ['file-1'])
})

test('parseCanvasScene rejects malformed input with a reason', () => {
  const invalidJson = document.parseCanvasScene('{')
  assert.equal(invalidJson.ok, false)
  assert.match(invalidJson.reason, /JSON/)

  const notObject = document.parseCanvasScene('[]')
  assert.equal(notObject.ok, false)
  assert.match(notObject.reason, /JSON 对象/)

  const noElements = document.parseCanvasScene('{"appState":{}}')
  assert.equal(noElements.ok, false)
  assert.match(noElements.reason, /elements/)

  const badElement = document.parseCanvasScene('{"elements":[{"id":""}]}')
  assert.equal(badElement.ok, false)
  assert.match(badElement.reason, /id 或 type/)

  const badAppState = document.parseCanvasScene('{"elements":[],"appState":[]}')
  assert.equal(badAppState.ok, false)
  assert.match(badAppState.reason, /appState/)

  const badFiles = document.parseCanvasScene('{"elements":[],"files":[]}')
  assert.equal(badFiles.ok, false)
  assert.match(badFiles.reason, /files/)
})

test('canvasPresenceRanges covers the whole file and never an empty range', () => {
  assert.deepEqual(document.canvasPresenceRanges(''), [{ startLine: 1, endLine: 1 }])
  assert.deepEqual(document.canvasPresenceRanges('{}'), [{ startLine: 1, endLine: 1 }])
  assert.deepEqual(document.canvasPresenceRanges('{\n"elements": []\n}'), [{ startLine: 1, endLine: 3 }])
})
