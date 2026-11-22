import test from 'node:test'
import assert from 'node:assert/strict'
import '../support/ts-hook.mjs'
const { applyRefreshedFile } = await import('../../src/client/work-item/viewers/viewer-refresh.ts')

/** Collect every state sink call made by one refresh. */
function effects() {
  const calls = []
  return {
    calls,
    setEditDraft: (value) => { calls.push(['editDraft', value]) },
    setSavedContent: (value) => { calls.push(['savedContent', value]) },
    setCanvasReset: (update) => { calls.push(['canvasReset', update(3)]) },
    setSavePhase: (value) => { calls.push(['savePhase', value]) },
    setReceipt: (value) => { calls.push(['receipt', value]) },
  }
}

test('a refresh without a file leaves all viewer state untouched', () => {
  const sinks = effects()
  applyRefreshedFile(null, true, false, 'canvas', true, 'old', sinks)
  assert.deepEqual(sinks.calls, [])
})

test('a dirty draft keeps its state and reports a model change when named', () => {
  const named = effects()
  applyRefreshedFile({ content: 'new' }, true, true, 'canvas', true, 'old', named)
  assert.deepEqual(named.calls, [['receipt', '模型已修改文件；保存时会自动合并，重叠则提示冲突']])

  const silent = effects()
  applyRefreshedFile({ content: 'new' }, false, true, 'canvas', true, 'old', silent)
  assert.deepEqual(silent.calls, [])
})

test('a clean canvas edit updates text and rebuilds a changed scene', () => {
  const sinks = effects()
  applyRefreshedFile({ content: 'new' }, false, false, 'canvas', true, 'old', sinks)
  assert.deepEqual(sinks.calls, [
    ['editDraft', 'new'],
    ['savedContent', 'new'],
    ['canvasReset', 4],
  ])
})

test('a clean refresh marks a closed editor saved and skips an unchanged scene', () => {
  const sinks = effects()
  applyRefreshedFile({ content: 'same' }, false, false, 'canvas', false, 'same', sinks)
  assert.deepEqual(sinks.calls, [
    ['editDraft', 'same'],
    ['savedContent', 'same'],
    ['savePhase', 'saved'],
  ])

  const text = effects()
  applyRefreshedFile({ content: 'new' }, false, false, 'text', true, 'old', text)
  assert.deepEqual(text.calls, [
    ['editDraft', 'new'],
    ['savedContent', 'new'],
  ])
})
