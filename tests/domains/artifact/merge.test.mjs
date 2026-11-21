import test from 'node:test'
import assert from 'node:assert/strict'
import '../../support/ts-hook.mjs'
import * as merge from '../../../src/domains/artifact/merge.ts'

/**
 * The three-way merge is the host's save authority: it must merge edits that
 * touch different lines and refuse precisely the ones that overlap. These tests
 * pin both the diff hunks and the merged text.
 */
test('line split and join is lossless', () => {
  for (const text of ['a\nb\n', 'a\nb', '', '\n', 'one']) {
    assert.equal(merge.joinLines(merge.splitLines(text)), text)
  }
})

test('diffHunks reports replacements, insertions, and deletions', () => {
  assert.deepEqual(merge.diffHunks(['a', 'b', 'c'], ['a', 'b', 'c']), [])
  assert.deepEqual(merge.diffHunks(['a', 'b', 'c'], ['a', 'B', 'c']), [
    { baseStart: 1, baseEnd: 2, lines: ['B'] },
  ])
  assert.deepEqual(merge.diffHunks(['a', 'c'], ['a', 'b', 'c']), [
    { baseStart: 1, baseEnd: 1, lines: ['b'] },
  ])
  assert.deepEqual(merge.diffHunks(['a', 'b', 'c'], ['a', 'c']), [
    { baseStart: 1, baseEnd: 2, lines: [] },
  ])
  assert.deepEqual(merge.diffHunks(['a'], ['x', 'y']), [
    { baseStart: 0, baseEnd: 1, lines: ['x', 'y'] },
  ])
  assert.deepEqual(merge.diffHunks([], ['x']), [{ baseStart: 0, baseEnd: 0, lines: ['x'] }])
  assert.deepEqual(merge.diffHunks(['x'], []), [{ baseStart: 0, baseEnd: 1, lines: [] }])
  // Whole-file deletes, whole-file inserts, and a long trailing insert exercise
  // both tail loops of the backtrack script.
  assert.deepEqual(merge.diffHunks(['a', 'b', 'c'], []), [{ baseStart: 0, baseEnd: 3, lines: [] }])
  assert.deepEqual(merge.diffHunks([], ['a', 'b', 'c']), [{ baseStart: 0, baseEnd: 0, lines: ['a', 'b', 'c'] }])
  assert.deepEqual(merge.diffHunks(['a', 'b'], ['a', 'b', 'c', 'd']), [{ baseStart: 2, baseEnd: 2, lines: ['c', 'd'] }])
  // Prefix-only deletes and suffix-only inserts exercise the script tail.
  assert.deepEqual(merge.diffHunks(['a', 'b'], ['b']), [{ baseStart: 0, baseEnd: 1, lines: [] }])
  assert.deepEqual(merge.diffHunks(['a'], ['a', 'b']), [{ baseStart: 1, baseEnd: 1, lines: ['b'] }])
})

test('a diff beyond the edit bound reports null instead of guessing', () => {
  assert.equal(merge.diffHunks(['a', 'b', 'c'], ['x', 'y', 'z'], 1), null)
  assert.notEqual(merge.diffHunks(['a', 'b', 'c'], ['x', 'y', 'z'], 100), null)
})

test('identical, fast-forward, and mine-only cases merge trivially', () => {
  assert.deepEqual(merge.mergeText({ base: 'a\nb\n', current: 'a\nb\n', mine: 'a\nB\n' }), {
    ok: true, content: 'a\nB\n', lines: ['a', 'B', ''],
  })
  assert.deepEqual(merge.mergeText({ base: 'a\n', current: 'a\nb\n', mine: 'a\n' }), {
    ok: true, content: 'a\nb\n', lines: ['a', 'b', ''],
  })
  assert.deepEqual(merge.mergeText({ base: 'a\n', current: 'a\n', mine: 'a\nb\n' }), {
    ok: true, content: 'a\nb\n', lines: ['a', 'b', ''],
  })
  assert.deepEqual(merge.mergeText({ base: 'a\n', current: 'x\n', mine: 'x\n' }), {
    ok: true, content: 'x\n', lines: ['x', ''],
  })
})

test('changes on different lines merge into one result', () => {
  const merged = merge.mergeText({
    base: 'one\ntwo\nthree\n',
    current: 'one\ntwo\nTHREE\n',
    mine: 'ONE\ntwo\nthree\n',
  })
  assert.equal(merged.ok, true)
  assert.equal(merged.content, 'ONE\ntwo\nTHREE\n')
})

test('an insertion at one point and a replacement elsewhere merge', () => {
  const merged = merge.mergeText({
    base: 'a\nb\nc\n',
    current: 'a\nb\nc\ninserted\n',
    mine: 'A\nb\nc\n',
  })
  assert.equal(merged.ok, true)
  assert.equal(merged.content, 'A\nb\nc\ninserted\n')
})

test('the same edit on both sides is applied once, not twice', () => {
  const merged = merge.mergeText({
    base: 'a\nb\nc\n',
    current: 'a\nB\nc\n',
    mine: 'a\nB\nc\n',
  })
  assert.equal(merged.ok, true)
  assert.equal(merged.content, 'a\nB\nc\n')
})

test('one identical edit merges once while another side edits elsewhere', () => {
  const merged = merge.mergeText({
    base: 'a\nb\nc\nd\n',
    current: 'a\nB\nc\nd\n',
    mine: 'a\nB\nc\nD\n',
  })
  assert.equal(merged.ok, true)
  assert.equal(merged.content, 'a\nB\nc\nD\n')
})

test('the same insertion on both sides is a conflict', () => {
  const merged = merge.mergeText({
    base: 'a\nb\n',
    current: 'a\nX\nb\n',
    mine: 'a\nY\nb\n',
  })
  assert.equal(merged.ok, false)
  assert.deepEqual(merged.conflictRanges, [{ startLine: 2, endLine: 2 }])
})

test('modifying the same line is a conflict with the current line range', () => {
  const merged = merge.mergeText({
    base: 'one\ntwo\nthree\n',
    current: 'one\nCURRENT\nthree\n',
    mine: 'one\nMINE\nthree\n',
  })
  assert.equal(merged.ok, false)
  assert.deepEqual(merged.conflictRanges, [{ startLine: 2, endLine: 2 }])
})

test('an insertion inside a replaced range conflicts', () => {
  const merged = merge.mergeText({
    base: 'a\nb\nc\nd\n',
    current: 'a\nB\nC\nd\n',
    mine: 'a\nb\nX\nc\nd\n',
  })
  assert.equal(merged.ok, false)
  assert.equal(merged.conflictRanges.length, 1)
})

test('an insertion at the boundary of a replaced range is allowed', () => {
  const after = merge.mergeText({
    base: 'a\nb\nc\n',
    current: 'a\nB\nc\n',
    mine: 'a\nb\nc\nX\n',
  })
  assert.equal(after.ok, true)
  assert.equal(after.content, 'a\nB\nc\nX\n')
  const before = merge.mergeText({
    base: 'a\nb\nc\n',
    current: 'a\nB\nc\n',
    mine: 'X\na\nb\nc\n',
  })
  assert.equal(before.ok, true)
  assert.equal(before.content, 'X\na\nB\nc\n')
})

test('deleting a line another side modified is a conflict', () => {
  const merged = merge.mergeText({
    base: 'a\nb\nc\n',
    current: 'a\nc\n',
    mine: 'a\nB\nc\n',
  })
  assert.equal(merged.ok, false)
  assert.equal(merged.conflictRanges.length, 1)
})

test('a rewrite past the edit bound is one conflict over the whole file', () => {
  const merged = merge.mergeText({
    base: 'a\nb\nc\n',
    current: 'x\ny\nz\n',
    mine: 'q\nr\ns\n',
    maxEdits: 1,
  })
  assert.equal(merged.ok, false)
  assert.deepEqual(merged.conflictRanges, [{ startLine: 1, endLine: 3 }])
})

test('trailing newlines and empty files survive the merge', () => {
  assert.equal(
    merge.mergeText({ base: '', current: '', mine: 'hello\n' }).content,
    'hello\n',
  )
  assert.equal(
    merge.mergeText({ base: 'a', current: 'a\nb', mine: 'A' }).content,
    'A\nb',
  )
  const removeEverything = merge.mergeText({ base: 'a\nb\n', current: 'a\nb\n', mine: '' })
  assert.equal(removeEverything.ok, true)
  assert.equal(removeEverything.content, '')
})
