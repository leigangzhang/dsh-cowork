import test from 'node:test'
import assert from 'node:assert/strict'
import '../support/ts-hook.mjs'
const reading = await import('../../src/client/work-item/reading-surface.ts')

/** The reading fallback threshold the factory consults. */
const TWO_MIB = 2 * 1024 * 1024

/** A recorded state sink: every setter appends `[name, value]`. */
function sinks() {
  const calls = []
  const set = (name) => (value) => { calls.push([name, value]) }
  return {
    calls,
    setEditing: set('editing'),
    setReadMode: set('readMode'),
    setEditDraft: set('editDraft'),
    setSavedContent: set('savedContent'),
    setSavePhase: set('savePhase'),
    setConflict: set('conflict'),
    setReceipt: set('receipt'),
    setSelection: set('selection'),
    setPendingAnchor: set('pendingAnchor'),
    setViewTab: set('viewTab'),
    setShowRail: set('showRail'),
    setReadFocusLine: set('readFocusLine'),
    focusComposer: () => { calls.push(['focusComposer', null]) },
    openThread: (thread) => { calls.push(['openThread', thread.threadId]) },
  }
}

/** One thread with a line-range anchor. */
function thread(threadId, startLine, overrides = {}) {
  return {
    threadId,
    root: null,
    comments: [],
    anchor: { kind: 'line-range', path: 'docs/spec.md', startLine, endLine: startLine, quote: '' },
    resolved: false,
    anchorStatus: null,
    latestAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** Input with every field a caller must provide. */
function input(overrides = {}) {
  return {
    kind: 'text',
    file: {
      artifactId: 'artifact-1',
      path: 'docs/spec.md',
      mediaType: 'text/markdown',
      content: 'saved text',
      size: 10,
      sha256: '',
      revision: 1,
      fsVersion: null,
    },
    record: { artifactId: 'artifact-1', primaryPath: 'docs/spec.md' },
    lines: ['saved text', 'second line'],
    threads: [thread('thread-1', 1)],
    pins: new Map([[1, { ordinal: 1, tone: 'open' }]]),
    selectedThreadId: 'thread-1',
    selection: null,
    dirty: false,
    conflict: null,
    readOnly: false,
    editing: false,
    readMode: true,
    editDraft: 'saved text',
    savedContent: 'saved text',
    viewportLineRef: { current: 7 },
    focusLine: null,
    viewTab: 'document',
    attachmentUrl: (id) => `/api/cowork.artifact.attachment?attachmentId=${id}`,
    ...overrides,
  }
}

test('the reading config renders the saved text and exposes the selected anchor', () => {
  const surface = reading.createReadingSurface(input(), sinks())
  assert.equal(surface.config.content, 'saved text')
  assert.equal(surface.config.dirty, false)
  assert.equal(surface.config.annotateDisabled, false)
  assert.equal(surface.config.annotateReason, null)
  assert.equal(surface.config.fallback, null)
  assert.equal(surface.config.selectedAnchor.startLine, 1)
  assert.equal(surface.config.focusLine, null)
  assert.equal(surface.showMode, true)
})

test('the reading config renders the draft and explains each annotate gate', () => {
  const dirty = reading.createReadingSurface(input({ dirty: true, editDraft: 'draft text', selection: null }), sinks())
  assert.equal(dirty.config.content, 'draft text')
  assert.equal(dirty.config.annotateDisabled, true)
  assert.equal(dirty.config.annotateReason, '未保存草稿：保存后可批注')
  const readOnly = reading.createReadingSurface(input({ readOnly: true }), sinks())
  assert.equal(readOnly.config.annotateReason, '跨会话只读：切到所属会话后才能批注')
  const conflict = reading.createReadingSurface(input({ conflict: { code: 'artifact/version-conflict' } }), sinks())
  assert.equal(conflict.config.annotateReason, '版本冲突：先在源码中处理')
  assert.equal(conflict.config.annotateDisabled, true)
})

test('only Markdown gets the large-file fallback notice', () => {
  const huge = 'x'.repeat(TWO_MIB + 1)
  const markdown = reading.createReadingSurface(input({ file: { ...input().file, content: huge }, dirty: true, editDraft: huge }), sinks())
  assert.match(markdown.config.fallback, /2 MB/)
  const diagram = reading.createReadingSurface(input({ kind: 'diagram' }), sinks())
  assert.equal(diagram.config.fallback, null)
})

test('the mode switch enters and leaves editing without discarding a draft', () => {
  const clean = sinks()
  const surface = reading.createReadingSurface(input(), clean)
  surface.toggleReadMode()
  assert.deepEqual(clean.calls.map(([name]) => name), [
    'readMode', 'editDraft', 'savedContent', 'savePhase', 'editing', 'conflict', 'receipt',
  ])
  // A clean draft is reseeded from the file when the editor opens.
  assert.deepEqual(clean.calls.filter(([name]) => name === 'editDraft'), [['editDraft', 'saved text']])

  const dirty = sinks()
  const dirtySurface = reading.createReadingSurface(input({ dirty: true, editDraft: 'draft text' }), dirty)
  dirtySurface.toggleReadMode()
  assert.equal(dirty.calls.some(([name]) => name === 'editDraft'), false)

  const leaving = sinks()
  reading.createReadingSurface(input({ editing: true, readMode: false, viewportLineRef: { current: 4 } }), leaving).toggleReadMode()
  assert.deepEqual(leaving.calls, [['readFocusLine', 4], ['readMode', true], ['editing', false]])

  const leavingEdit = sinks()
  reading.createReadingSurface(input({ editing: true, readMode: false, viewportLineRef: { current: 5 } }), leavingEdit).toggleEditing()
  assert.deepEqual(leavingEdit.calls, [['readFocusLine', 5], ['editing', false], ['readMode', true]])

  const entering = sinks()
  reading.createReadingSurface(input(), entering).toggleEditing()
  assert.deepEqual(entering.calls.map(([name]) => name), [
    'editDraft', 'savedContent', 'savePhase', 'editing', 'conflict', 'receipt', 'readMode',
  ])
})

test('non-Markdown families toggle the numbered source surface only', () => {
  const calls = sinks()
  reading.createReadingSurface(input({ kind: 'diagram' }), calls).toggleReadMode()
  assert.deepEqual(calls.calls, [['readMode', false]])
  const back = sinks()
  reading.createReadingSurface(input({ kind: 'diagram', readMode: false }), back).toggleReadMode()
  assert.deepEqual(back.calls, [['readMode', true]])
})

test('annotating a selection maps it to a line-range anchor and opens the rail', () => {
  const calls = sinks()
  const surface = reading.createReadingSurface(input(), calls)
  surface.config.onAnnotate(1, 2, '  picked  ')
  const anchor = calls.calls.find(([name]) => name === 'pendingAnchor')[1]
  assert.equal(anchor.kind, 'line-range')
  assert.equal(anchor.startLine, 1)
  assert.equal(anchor.endLine, 2)
  assert.equal(anchor.selectedText, 'picked')
  assert.deepEqual(calls.calls.filter(([name]) => name !== 'pendingAnchor'), [
    ['selection', { startLine: 1, endLine: 2 }],
    ['viewTab', 'document'],
    ['showRail', true],
    ['focusComposer', null],
  ])
})

test('annotating refuses read-only, dirty, and missing-record states', () => {
  for (const overrides of [
    { readOnly: true },
    { dirty: true, editDraft: 'draft' },
    { record: null },
  ]) {
    const calls = sinks()
    reading.createReadingSurface(input(overrides), calls).config.onAnnotate(1, 1, 'x')
    assert.deepEqual(calls.calls, [], JSON.stringify(overrides))
  }
})

test('an out-of-file range produces no anchor', () => {
  const calls = sinks()
  reading.createReadingSurface(input({ lines: [] }), calls).config.onAnnotate(3, 3, 'x')
  assert.deepEqual(calls.calls, [])
})

test('the current selection and keyboard line annotation reuse the same entry', () => {
  const calls = sinks()
  const surface = reading.createReadingSurface(input({ selection: { startLine: 1, endLine: 2 } }), calls)
  surface.annotate()
  assert.equal(calls.calls.find(([name]) => name === 'pendingAnchor')[1].endLine, 2)
  const quiet = sinks()
  reading.createReadingSurface(input({ selection: null }), quiet).annotate()
  assert.deepEqual(quiet.calls, [])
  const line = sinks()
  reading.createReadingSurface(input(), line).annotateLine(2)
  assert.equal(line.calls.find(([name]) => name === 'pendingAnchor')[1].startLine, 2)
})

test('pins open the thread they number and ignore unknown indexes', () => {
  const byLine = sinks()
  reading.createReadingSurface(input(), byLine).focusPin(1)
  assert.deepEqual(byLine.calls, [['openThread', 'thread-1']])
  const missingLine = sinks()
  reading.createReadingSurface(input(), missingLine).focusPin(99)
  assert.deepEqual(missingLine.calls, [])
  const byOrdinal = sinks()
  reading.createReadingSurface(input(), byOrdinal).config.onPickPin(1)
  assert.deepEqual(byOrdinal.calls, [['openThread', 'thread-1']])
  const missingOrdinal = sinks()
  reading.createReadingSurface(input({ threads: [] }), missingOrdinal).config.onPickPin(2)
  assert.deepEqual(missingOrdinal.calls, [])
})

test('the viewport callback feeds the shared slot', () => {
  const slot = { current: 1 }
  const surface = reading.createReadingSurface(input({ viewportLineRef: slot }), sinks())
  surface.config.onViewportLine(9)
  assert.equal(slot.current, 9)
})

test('the mode switch only shows on the document tab of a loaded file', () => {
  const noFile = reading.createReadingSurface(input({ file: null }), sinks())
  assert.equal(noFile.showMode, false)
  const versions = reading.createReadingSurface(input({ viewTab: 'versions' }), sinks())
  assert.equal(versions.showMode, false)
  const diagramEditing = reading.createReadingSurface(input({ kind: 'diagram', editing: true }), sinks())
  assert.equal(diagramEditing.showMode, false)
  const textEditing = reading.createReadingSurface(input({ editing: true }), sinks())
  assert.equal(textEditing.showMode, true)
})

test('the config image resolver keeps http and attachments and refuses the rest', () => {
  const surface = reading.createReadingSurface(input({ attachmentUrl: (id) => `attachment:${id}` }), sinks())
  assert.equal(surface.config.imageUrl('https://example.com/a.png'), 'https://example.com/a.png')
  assert.equal(surface.config.imageUrl('cowork-attachment://abc'), 'attachment:abc')
  assert.equal(surface.config.imageUrl('./images/a.png'), null)
  assert.equal(surface.config.imageUrl('cowork-attachment://bad/id'), null)
})
