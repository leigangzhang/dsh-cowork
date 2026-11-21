import test from 'node:test'
import assert from 'node:assert/strict'
import { artifactAnchor, artifactContract } from '../../support/artifact-fixtures.mjs'

/**
 * Anchors are the one structure a thread uses to find its place again. These
 * tests pin every anchor kind's required fields and the server-side derivation
 * that replaces a browser-supplied quote with the text the host actually read.
 */
const REGION = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }

test('every anchor kind accepts a valid shape', () => {
  const cases = [
    [{ kind: 'line-range', path: 'a.md', startLine: 2, endLine: 4, quote: 'b\nc' }, 'line-range'],
    [{ kind: 'line-range', path: 'a.md', startLine: 1, endLine: 1 }, 'line-range'],
    [{ kind: 'block', path: 'a.doc', quote: 'a block' }, 'block'],
    [{ kind: 'block', path: 'a.doc', quote: 'a block', blockId: 'p-1' }, 'block'],
    [{ kind: 'diagram-node', path: 'a.mmd', nodeId: 'api' }, 'diagram-node'],
    [{ kind: 'diagram-node', path: 'a.mmd', line: 3 }, 'diagram-node'],
    [{ kind: 'table-cell', path: 'a.csv', row: 1, column: 2 }, 'table-cell'],
    [{ kind: 'canvas-element', path: 'a.excalidraw', elementId: 'rect-1' }, 'canvas-element'],
    [{ kind: 'canvas-element', path: 'a.excalidraw', region: REGION }, 'canvas-element'],
    [{ kind: 'page', path: 'a.pdf', page: 2 }, 'page'],
    [{ kind: 'region', path: 'a.png', region: REGION }, 'region'],
    [{ kind: 'region', path: 'a.png', page: 2, region: REGION }, 'region'],
    [{ kind: 'whole', path: 'a.md' }, 'whole'],
  ]
  for (const [input, kind] of cases) {
    const parsed = artifactAnchor.parseArtifactAnchor(input)
    assert.equal(parsed.ok, true, JSON.stringify(input))
    assert.equal(parsed.anchor.kind, kind)
    assert.equal(parsed.anchor.path, input.path)
  }
})

test('invalid anchors are refused with a reason', () => {
  const cases = [
    [null, 'must be an object'],
    [{ kind: 'nope', path: 'a.md' }, 'kind is unknown'],
    [{ kind: 'whole', path: '../outside.md' }, 'anchor.path'],
    [{ kind: 'line-range', path: 'a.md', startLine: 0, endLine: 1 }, 'positive'],
    [{ kind: 'line-range', path: 'a.md', startLine: 2, endLine: 1 }, 'before startLine'],
    [{ kind: 'block', path: 'a.doc' }, 'quote'],
    [{ kind: 'diagram-node', path: 'a.mmd' }, 'nodeId or line'],
    [{ kind: 'table-cell', path: 'a.csv', row: -1, column: 0 }, 'non-negative'],
    [{ kind: 'canvas-element', path: 'a.excalidraw' }, 'elementId or region'],
    [{ kind: 'canvas-element', path: 'a.excalidraw', region: { ...REGION, width: 0 } }, 'elementId or region'],
    [{ kind: 'page', path: 'a.pdf', page: 0 }, 'positive page'],
    [{ kind: 'region', path: 'a.png' }, 'positive region'],
    [{ kind: 'region', path: 'a.png', page: 0, region: REGION }, 'page must be a positive integer'],
    [{ kind: 'region', path: 'a.png', region: { x: -1, y: 0, width: 1, height: 1 } }, 'positive region'],
    [{ kind: 'region', path: 'a.png', region: { x: 0, y: 0, width: '1', height: 1 } }, 'positive region'],
  ]
  for (const [input, expected] of cases) {
    const parsed = artifactAnchor.parseArtifactAnchor(input)
    assert.equal(parsed.ok, false, JSON.stringify(input))
    assert.ok(parsed.reason.includes(expected), `${JSON.stringify(input)}: ${parsed.reason}`)
  }
})

test('quotes and context are bounded and optional', () => {
  const long = 'q'.repeat(artifactContract.MAX_ARTIFACT_QUOTE_CHARS + 10)
  const parsed = artifactAnchor.parseArtifactAnchor({
    kind: 'line-range',
    path: 'a.md',
    startLine: 1,
    endLine: 1,
    quote: long,
    contextBefore: long,
    contextAfter: long,
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.anchor.quote.length, artifactContract.MAX_ARTIFACT_QUOTE_CHARS)
  assert.equal(parsed.anchor.contextBefore.length, artifactContract.MAX_ARTIFACT_QUOTE_CHARS)
  assert.equal(parsed.anchor.contextAfter.length, artifactContract.MAX_ARTIFACT_QUOTE_CHARS)
  const bare = artifactAnchor.parseArtifactAnchor({ kind: 'line-range', path: 'a.md', startLine: 1, endLine: 1 })
  assert.equal(bare.ok, true)
  assert.equal(bare.anchor.quote, '')
  assert.equal('contextBefore' in bare.anchor, false)
  assert.equal('contextAfter' in bare.anchor, false)
})

test('contentLines drops the trailing empty line only', () => {
  assert.deepEqual(artifactAnchor.contentLines('a\nb\n'), ['a', 'b'])
  assert.deepEqual(artifactAnchor.contentLines('a\nb'), ['a', 'b'])
  assert.deepEqual(artifactAnchor.contentLines(''), [''])
  assert.deepEqual(artifactAnchor.contentLines('\n'), [''])
})

test('deriveLineAnchor replaces the client quote with the file text', () => {
  const content = 'one\ntwo\nthree\nfour\n'
  const parsed = artifactAnchor.deriveLineAnchor(content, 'docs/spec.md', 2, 3)
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.anchor, {
    kind: 'line-range',
    path: 'docs/spec.md',
    startLine: 2,
    endLine: 3,
    quote: 'two\nthree',
    contextBefore: 'one',
    contextAfter: 'four',
  })
  const clamped = artifactAnchor.deriveLineAnchor(content, 'docs/spec.md', 3, 99)
  assert.equal(clamped.ok, true)
  assert.equal(clamped.anchor.endLine, 4)
  assert.equal(clamped.anchor.contextAfter, undefined)
  const firstLine = artifactAnchor.deriveLineAnchor('only\n', 'a.md', 1, 1)
  assert.equal(firstLine.ok, true)
  assert.equal(firstLine.anchor.contextBefore, undefined)
  assert.equal(firstLine.anchor.contextAfter, undefined)
})

test('deriveLineAnchor refuses an out-of-file or inverted range', () => {
  for (const [start, end, expected] of [[0, 1, 'positive'], [3, 1, 'positive'], [9, 9, 'outside the file']]) {
    const parsed = artifactAnchor.deriveLineAnchor('a\nb\n', 'a.md', start, end)
    assert.equal(parsed.ok, false)
    assert.ok(parsed.reason.includes(expected), parsed.reason)
  }
})

test('boundQuote keeps short text and caps long text', () => {
  assert.equal(artifactAnchor.boundQuote('short'), 'short')
  const long = 'x'.repeat(artifactContract.MAX_ARTIFACT_QUOTE_CHARS + 3)
  assert.equal(artifactAnchor.boundQuote(long).length, artifactContract.MAX_ARTIFACT_QUOTE_CHARS)
})

test('relocateLineAnchor keeps, moves, or marks a line thread stale', () => {
  const anchor = {
    kind: 'line-range', path: 'docs/spec.md', startLine: 2, endLine: 2,
    quote: 'target', contextBefore: 'before', contextAfter: 'after',
  }
  const unchanged = artifactAnchor.relocateLineAnchor('before\ntarget\nafter\n', anchor)
  assert.equal(unchanged.status, 'unchanged')
  assert.equal(unchanged.anchor.startLine, 2)

  const moved = artifactAnchor.relocateLineAnchor('inserted\nbefore\ntarget\nafter\n', anchor)
  assert.equal(moved.status, 'moved')
  assert.equal(moved.anchor.startLine, 3)
  assert.equal(moved.anchor.contextBefore, 'before')

  const deleted = artifactAnchor.relocateLineAnchor('before\nafter\n', anchor)
  assert.equal(deleted.status, 'stale')
  assert.deepEqual(deleted.anchor, anchor)

  const contextFree = { kind: 'line-range', path: 'a.md', startLine: 1, endLine: 1, quote: 'one' }
  assert.equal(artifactAnchor.relocateLineAnchor('one\ntwo\n', contextFree).status, 'unchanged')

  const ambiguous = artifactAnchor.relocateLineAnchor('target\ntarget\n', anchor)
  assert.equal(ambiguous.status, 'stale')

  assert.equal(artifactAnchor.relocateLineAnchor('anything', { kind: 'whole', path: 'a.md' }).status, 'unchanged')
  assert.equal(artifactAnchor.relocateLineAnchor('anything', { ...anchor, quote: '' }).status, 'stale')
})
