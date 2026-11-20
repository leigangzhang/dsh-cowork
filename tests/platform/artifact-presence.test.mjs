import test from 'node:test'
import assert from 'node:assert/strict'
import '../support/ts-hook.mjs'
const {
  ArtifactPresenceRegistry,
  createArtifactWriteGuard,
  lineOfNeedle,
} = await import('../../src/platform/artifact-presence.ts')

/**
 * Presence is a short-lived in-memory fact: which lines a browser user is
 * editing right now. The guard turns it into a synchronous denial for the three
 * structured write tools; nothing here reads or writes a file.
 */
const PATH = '/repo/docs/spec.md'

/** A clock the test moves by hand. */
function fakeClock(start = 1_000) {
  let now = start
  return { now: () => now, advance: (ms) => { now += ms } }
}

/** One execution as the tool pipeline sees it. */
function exec(name, args, cwd = '/repo') {
  return { name, arguments: args, agent: { session: { header: { cwd } } } }
}

test('a report is visible until its TTL passes', () => {
  const clock = fakeClock()
  const presence = new ArtifactPresenceRegistry({ ttlMs: 5000, clock: clock.now })
  assert.equal(presence.report(PATH, [{ startLine: 2, endLine: 4 }]), 5000)
  assert.deepEqual(presence.activeRanges(PATH), [{ startLine: 2, endLine: 4 }])
  clock.advance(4999)
  assert.equal(presence.activeRanges(PATH).length, 1)
  clock.advance(2)
  assert.deepEqual(presence.activeRanges(PATH), [])
  assert.equal(presence.cachedText(PATH), null)
})

test('a newer report replaces the ranges and keeps the cached text', () => {
  const clock = fakeClock()
  const presence = new ArtifactPresenceRegistry({ clock: clock.now })
  presence.report(PATH, [{ startLine: 1, endLine: 1 }])
  presence.cacheText(PATH, 'one\ntwo\nthree\n')
  presence.report(PATH, [{ startLine: 3, endLine: 3 }])
  assert.deepEqual(presence.activeRanges(PATH), [{ startLine: 3, endLine: 3 }])
  assert.equal(presence.cachedText(PATH), 'one\ntwo\nthree\n')
  assert.equal(presence.report(PATH, [], 'explicit text'), 5000)
  assert.equal(presence.cachedText(PATH), 'explicit text')
})

test('caching text for an unobserved file creates an empty-range entry', () => {
  const clock = fakeClock()
  const presence = new ArtifactPresenceRegistry({ clock: clock.now })
  presence.cacheText(PATH, 'body')
  assert.equal(presence.cachedText(PATH), 'body')
  assert.deepEqual(presence.activeRanges(PATH), [])
})

test('clear and dispose drop the entries', () => {
  const presence = new ArtifactPresenceRegistry()
  presence.report(PATH, [{ startLine: 1, endLine: 1 }])
  presence.clear(PATH)
  assert.deepEqual(presence.activeRanges(PATH), [])
  presence.report(PATH, [{ startLine: 1, endLine: 1 }])
  presence.dispose()
  assert.deepEqual(presence.activeRanges(PATH), [])
})

test('needle lookup returns the first matching line range', () => {
  const text = 'alpha\nbeta\ngamma\ndelta\n'
  assert.deepEqual(lineOfNeedle(text, 'beta'), { startLine: 2, endLine: 2 })
  assert.deepEqual(lineOfNeedle(text, 'gamma\ndelta'), { startLine: 3, endLine: 4 })
  assert.equal(lineOfNeedle(text, 'missing'), null)
  assert.equal(lineOfNeedle(text, ''), null)
  assert.deepEqual(lineOfNeedle('x\nx\n', 'x'), { startLine: 1, endLine: 1 })
})

test('the guard ignores tools and arguments it does not cover', () => {
  const presence = new ArtifactPresenceRegistry()
  const guard = createArtifactWriteGuard(presence)
  presence.report(PATH, [{ startLine: 1, endLine: 9 }])
  assert.equal(guard(exec('bash', { command: 'rm' })), undefined)
  assert.equal(guard({ name: 'write', arguments: null }), undefined)
  assert.equal(guard(exec('write', { file_path: '' })), undefined)
  assert.equal(guard({ name: 'write', arguments: { file_path: 'docs/spec.md' } }), undefined)
  assert.equal(guard(exec('write', { file_path: 'docs/other.md' })), undefined)
})

test('a whole-file write is denied while any range is active', () => {
  const presence = new ArtifactPresenceRegistry()
  const guard = createArtifactWriteGuard(presence)
  assert.equal(guard(exec('write', { file_path: PATH })), undefined)
  presence.report(PATH, [{ startLine: 2, endLine: 2 }, { startLine: 5, endLine: 5 }])
  const denial = guard(exec('write', { file_path: 'docs/spec.md' }))
  assert.match(denial, /用户正在编辑/)
  assert.match(denial, /第 2 行、第 5 行/)
  assert.match(denial, /整文件写入/)
})

test('an edit is denied only when old_string overlaps the active range', () => {
  const presence = new ArtifactPresenceRegistry()
  const guard = createArtifactWriteGuard(presence)
  presence.report(PATH, [{ startLine: 3, endLine: 4 }])

  // No cached text: conservative denial.
  assert.match(guard(exec('edit', { file_path: 'docs/spec.md', old_string: 'gamma', new_string: 'G' })), /先读取文件/)

  presence.cacheText(PATH, 'alpha\nbeta\ngamma\ndelta\n')
  assert.match(
    guard(exec('edit', { file_path: 'docs/spec.md', old_string: 'gamma', new_string: 'G' })),
    /重叠/,
  )
  assert.equal(
    guard(exec('edit', { file_path: 'docs/spec.md', old_string: 'alpha', new_string: 'A' })),
    undefined,
  )
  assert.equal(
    guard(exec('edit', { file_path: 'docs/spec.md', old_string: 'missing', new_string: 'M' })),
    undefined,
  )
  assert.equal(guard(exec('edit', { file_path: 'docs/spec.md' })), undefined)
})

test('str_replace_editor distinguishes view, create, and insert', () => {
  const presence = new ArtifactPresenceRegistry()
  const guard = createArtifactWriteGuard(presence)
  presence.report(PATH, [{ startLine: 3, endLine: 4 }])
  presence.cacheText(PATH, 'alpha\nbeta\ngamma\ndelta\n')

  assert.equal(guard(exec('str_replace_editor', { command: 'view', path: PATH })), undefined)
  assert.match(guard(exec('str_replace_editor', { command: 'create', path: PATH, file_text: 'x' })), /不能新建覆盖/)
  assert.match(
    guard(exec('str_replace_editor', { command: 'str_replace', path: PATH, old_str: 'gamma', new_str: 'G' })),
    /重叠/,
  )
  assert.equal(
    guard(exec('str_replace_editor', { command: 'str_replace', path: PATH, old_str: 'alpha', new_str: 'A' })),
    undefined,
  )
  assert.equal(
    guard(exec('str_replace_editor', { command: 'str_replace', path: PATH })),
    undefined,
  )
  assert.match(
    guard(exec('str_replace_editor', { command: 'insert', path: PATH, insert_line: 2 })),
    /重叠/,
  )
  assert.equal(
    guard(exec('str_replace_editor', { command: 'insert', path: PATH, insert_line: 5 })),
    undefined,
  )
  assert.match(
    guard(exec('str_replace_editor', { command: 'insert', path: PATH, insert_line: '3' })),
    /无法判断/,
  )
})
