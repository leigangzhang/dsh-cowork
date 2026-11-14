import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tokenize } from '../../../src/domains/routing/routing.ts'
import {
  DEFAULT_MEMORY_BUDGET_TOKENS,
  DEFAULT_SEARCH_LIMIT,
  MAX_ENTRY_TEXT_CHARS,
  MAX_SEARCH_LIMIT,
  MEMORY_FILES,
  MEMORY_KINDS,
  MemoryCorruptError,
  appendMemoryEntry,
  estimateTokens,
  loadMemory,
  memoryDirOf,
  memoryFilePath,
  parseMemoryFile,
  renderMemoryBlock,
  renderMemoryEntry,
  searchMemory,
  validateMemoryEntry,
} from '../../../src/domains/memory/memory.ts'

const REPO = '/repo'
const ISO = '2026-11-05T00:00:00.000Z'

/** One valid entry block, as written on disk. */
const block = (title, text, source = 'thread-a', createdAt = ISO) =>
  `## ${title}\n\n${text}\n\n(来源: ${source}; ${createdAt})`

const entry = (overrides = {}) => ({
  kind: 'fact',
  title: 'lock ordering',
  text: 'always acquire the lock before writing',
  source: 'thread-a',
  createdAt: ISO,
  ...overrides,
})

const searchable = (overrides = {}) => ({
  kind: 'fact',
  file: MEMORY_FILES.fact,
  entry: entry(overrides),
})

/** In-memory MemoryIo that records writes, lock depth and read order. */
const fakeIo = (initial = {}) => {
  const files = new Map(Object.entries(initial))
  const calls = { writes: [], locks: 0, lockDepth: 0, wroteInsideLock: [] }
  return {
    files,
    calls,
    readText: async (path) => (files.has(path) ? files.get(path) : null),
    writeText: async (path, text) => {
      calls.writes.push({ path, text })
      calls.wroteInsideLock.push(calls.lockDepth > 0)
      files.set(path, text)
    },
    withLock: async (operation) => {
      calls.locks += 1
      calls.lockDepth += 1
      try {
        return await operation()
      } finally {
        calls.lockDepth -= 1
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Paths and constants
// ---------------------------------------------------------------------------

test('memory paths and kind order are fixed', () => {
  assert.deepEqual(MEMORY_KINDS, ['constraint', 'decision', 'fact'])
  assert.deepEqual(MEMORY_FILES, {
    constraint: 'constraints.md',
    decision: 'decisions.md',
    fact: 'facts.md',
  })
  assert.equal(memoryDirOf(REPO), join(REPO, '.dsh-cowork', 'memory'))
  assert.equal(memoryFilePath(REPO, 'constraint'), join(REPO, '.dsh-cowork/memory/constraints.md'))
  assert.equal(memoryFilePath(REPO, 'fact'), join(REPO, '.dsh-cowork/memory/facts.md'))
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcde'), 2)
})

// ---------------------------------------------------------------------------
// parseMemoryFile
// ---------------------------------------------------------------------------

test('parseMemoryFile parses one well-formed entry', () => {
  const parsed = parseMemoryFile('constraint', 'constraints.md', block('use pnpm', 'never npm install'))
  assert.deepEqual(parsed.issues, [])
  assert.deepEqual(parsed.entries, [
    {
      kind: 'constraint',
      title: 'use pnpm',
      text: 'never npm install',
      source: 'thread-a',
      createdAt: ISO,
    },
  ])
})

test('parseMemoryFile parses several entries and keeps duplicate titles', () => {
  const content = [block('same', 'first'), block('other', 'second'), block('same', 'third')].join('\n\n')
  const parsed = parseMemoryFile('decision', 'decisions.md', `${content}\n`)
  assert.deepEqual(parsed.issues, [])
  assert.deepEqual(
    parsed.entries.map((e) => e.title),
    ['same', 'other', 'same'],
  )
})

test('parseMemoryFile reports a missing provenance line with its 1-based line number', () => {
  const content = `${block('good', 'body')}\n\n## broken\n\nbody without source\n`
  const parsed = parseMemoryFile('fact', 'facts.md', content)
  assert.equal(parsed.entries.length, 1)
  assert.equal(parsed.issues.length, 1)
  assert.equal(parsed.issues[0].file, 'facts.md')
  assert.equal(parsed.issues[0].line, 9)
  assert.match(parsed.issues[0].message, /来源/)
})

test('parseMemoryFile reports an empty title at the heading line', () => {
  const parsed = parseMemoryFile('fact', 'facts.md', '\n##   \n\nbody\n\n(来源: s; 2026-11-05T00:00:00.000Z)\n')
  assert.equal(parsed.entries.length, 0)
  assert.deepEqual(
    parsed.issues.map((i) => i.line),
    [2],
  )
  assert.match(parsed.issues[0].message, /title is empty/)
})

test('parseMemoryFile normalises CRLF and still parses', () => {
  const crlf = `${block('windows', 'written on windows')}\r\n\r\n${block('second', 'another')}\r\n`
  const parsed = parseMemoryFile('fact', 'facts.md', crlf)
  assert.deepEqual(parsed.issues, [])
  assert.equal(parsed.entries.length, 2)
  assert.equal(parsed.entries[0].text, 'written on windows')
})

test('parseMemoryFile treats an empty file as zero entries and flags a preamble', () => {
  assert.deepEqual(parseMemoryFile('fact', 'facts.md', ''), { entries: [], issues: [] })
  assert.deepEqual(parseMemoryFile('fact', 'facts.md', '\n  \n'), { entries: [], issues: [] })

  const withPreamble = parseMemoryFile('fact', 'facts.md', `# Memories\n\n${block('a', 'b')}\n`)
  assert.equal(withPreamble.entries.length, 1)
  assert.equal(withPreamble.issues.length, 1)
  assert.equal(withPreamble.issues[0].line, 1)
})

test('parseMemoryFile rejects a source line whose timestamp is not a real date', () => {
  const parsed = parseMemoryFile('fact', 'facts.md', block('a', 'b', 's', '2026-13-45T99:99:99Z'))
  assert.equal(parsed.entries.length, 0)
  assert.equal(parsed.issues.length, 1)
  assert.match(parsed.issues[0].message, /ISO 8601/)
})

test('the timestamp policy rejects month 13 but keeps a shape-valid date verbatim', () => {
  // The regex shape matches month 13 with a plausible day and time; only
  // Date.parse can tell that the month does not exist.
  const month13 = parseMemoryFile('fact', 'facts.md', block('a', 'b', 's', '2026-13-05T00:00:00.000Z'))
  assert.equal(month13.entries.length, 0)
  assert.equal(month13.issues.length, 1)
  assert.match(month13.issues[0].message, /2026-13-05T00:00:00\.000Z/)
  assert.match(month13.issues[0].message, /ISO 8601/)

  // A leap day is real; the reader keeps the string it read (no normalisation).
  const leap = parseMemoryFile('fact', 'facts.md', block('leap', 'b', 's', '2028-02-29T12:34:56.789Z'))
  assert.deepEqual(leap.issues, [])
  assert.equal(leap.entries.length, 1)
  assert.equal(leap.entries[0].createdAt, '2028-02-29T12:34:56.789Z')
})

test('parseMemoryFile reports an entry whose body is only the provenance line', () => {
  const parsed = parseMemoryFile('fact', 'facts.md', `## empty body\n\n(来源: s; ${ISO})\n`)
  assert.equal(parsed.entries.length, 0)
  assert.equal(parsed.issues.length, 1)
  assert.equal(parsed.issues[0].line, 1)
  assert.match(parsed.issues[0].message, /text is empty/)
})

// ---------------------------------------------------------------------------
// validateMemoryEntry
// ---------------------------------------------------------------------------

test('validateMemoryEntry accepts and trims a complete entry', () => {
  const result = validateMemoryEntry('decision', {
    title: '  keep the store as the only writer  ',
    text: '\n one writer \n',
    source: ' thread-a ',
  })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'decision')
  assert.deepEqual(result.value, {
    title: 'keep the store as the only writer',
    text: 'one writer',
    source: 'thread-a',
  })
})

test('validateMemoryEntry rejects an unknown kind', () => {
  for (const kind of ['nope', '', null, 7, undefined]) {
    const result = validateMemoryEntry(kind, { title: 't', text: 'x', source: 's' })
    assert.equal(result.ok, false)
    assert.equal(result.issues.length, 1)
    // `kind` is a first-class field of the issue, not a cast into 'title'/'text'/'source'.
    assert.equal(result.issues[0].field, 'kind')
    assert.match(result.issues[0].message, /kind must be one of/)
  }
})

test('validateMemoryEntry reports every empty field at once', () => {
  const result = validateMemoryEntry('fact', { title: '   ', source: '' })
  assert.equal(result.ok, false)
  assert.deepEqual(
    result.issues.map((i) => i.field),
    ['title', 'text', 'source'],
  )
  for (const issue of result.issues) assert.match(issue.message, /non-empty/)
})

test('validateMemoryEntry rejects a non-object input and control characters', () => {
  const notAnObject = validateMemoryEntry('fact', 'nope')
  assert.equal(notAnObject.ok, false)
  assert.equal(notAnObject.issues.length, 3)

  const control = validateMemoryEntry('fact', {
    title: 'bad\u0000title',
    text: 'line\nbreak',
    source: 'tab\there',
  })
  assert.equal(control.ok, false)
  assert.deepEqual(
    control.issues.map((i) => i.field),
    ['title', 'text', 'source'],
  )
  for (const issue of control.issues) assert.match(issue.message, /control characters/)
})

test('validateMemoryEntry enforces the 8000 character text limit', () => {
  const atLimit = validateMemoryEntry('fact', { title: 't', text: 'x'.repeat(MAX_ENTRY_TEXT_CHARS), source: 's' })
  assert.equal(atLimit.ok, true)

  const tooLong = validateMemoryEntry('fact', {
    title: 't',
    text: 'x'.repeat(MAX_ENTRY_TEXT_CHARS + 1),
    source: 's',
  })
  assert.equal(tooLong.ok, false)
  assert.equal(tooLong.issues.length, 1)
  assert.equal(tooLong.issues[0].field, 'text')
  assert.match(tooLong.issues[0].message, new RegExp(String(MAX_ENTRY_TEXT_CHARS)))
})

// ---------------------------------------------------------------------------
// renderMemoryEntry / round trip
// ---------------------------------------------------------------------------

test('renderMemoryEntry round-trips through parseMemoryFile', () => {
  const input = { title: 'prefer worktrees', text: 'never share a working tree', source: 'thread-b' }
  const rendered = renderMemoryEntry(input)
  const timestamp = /\(来源: thread-b; (.+)\)/.exec(rendered)
  assert.ok(timestamp)
  assert.equal(Number.isNaN(Date.parse(timestamp[1])), false)

  const parsed = parseMemoryFile('decision', 'decisions.md', rendered)
  assert.deepEqual(parsed.issues, [])
  assert.equal(parsed.entries.length, 1)
  assert.equal(parsed.entries[0].title, input.title)
  assert.equal(parsed.entries[0].text, input.text)
  assert.equal(parsed.entries[0].source, input.source)
})

test('renderMemoryEntry stamps the injected clock instead of the wall clock', () => {
  const input = { title: 'pin the clock', text: 'tests assert exact timestamps', source: 'thread-c' }
  const fixed = new Date('2026-01-02T03:04:05.678Z')

  const rendered = renderMemoryEntry(input, () => fixed)
  assert.match(rendered, /\(来源: thread-c; 2026-01-02T03:04:05\.678Z\)$/)

  // The rendered block still round-trips, and the timestamp is stored verbatim.
  const parsed = parseMemoryFile('fact', 'facts.md', rendered)
  assert.deepEqual(parsed.issues, [])
  assert.equal(parsed.entries[0].createdAt, fixed.toISOString())

  // Without a clock the contract is "some real ISO 8601 instant", not a fixed value.
  const wall = renderMemoryEntry(input)
  const stamped = /\(来源: thread-c; (.+)\)$/.exec(wall)
  assert.ok(stamped)
  assert.equal(Number.isNaN(Date.parse(stamped[1])), false)
})

// ---------------------------------------------------------------------------
// renderMemoryBlock
// ---------------------------------------------------------------------------

test('renderMemoryBlock orders sections constraints, decisions, facts and counts tokens', () => {
  const entries = (kind) => [entry({ kind, title: `${kind} one`, text: `body of ${kind}` })]
  const blockResult = renderMemoryBlock([
    { kind: 'fact', entries: entries('fact') },
    { kind: 'constraint', entries: entries('constraint') },
    { kind: 'decision', entries: entries('decision') },
  ])

  assert.equal(blockResult.truncated, false)
  assert.equal(blockResult.entryCount, 3)
  assert.equal(blockResult.tokens, estimateTokens(blockResult.text))

  const constraints = blockResult.text.indexOf('### constraints')
  const decisions = blockResult.text.indexOf('### decisions')
  const facts = blockResult.text.indexOf('### facts')
  assert.ok(constraints >= 0 && decisions > constraints && facts > decisions)
  assert.equal(blockResult.text.split('### ').length - 1, 3)
})

test('renderMemoryBlock skips empty kinds and defaults to the 3000 token budget', () => {
  const blockResult = renderMemoryBlock([{ kind: 'decision', entries: [entry()] }])
  assert.equal(blockResult.text.includes('### constraints'), false)
  assert.equal(blockResult.text.includes('### facts'), false)
  assert.ok(blockResult.text.startsWith('### decisions\n\n## lock ordering'))
  assert.equal(DEFAULT_MEMORY_BUDGET_TOKENS, 3000)

  const withBudget = renderMemoryBlock([{ kind: 'decision', entries: [entry()] }], 3000)
  assert.deepEqual(withBudget, blockResult)
})

test('renderMemoryBlock truncates on whole entries and appends the marker', () => {
  const long = (n) => entry({ title: `entry ${n}`, text: 'x'.repeat(400), createdAt: ISO })
  const all = [1, 2, 3, 4, 5].map(long)
  const result = renderMemoryBlock([{ kind: 'fact', entries: all }], 300)

  assert.equal(result.truncated, true)
  assert.ok(result.text.endsWith('[memory truncated]'))
  assert.ok(result.entryCount > 0 && result.entryCount < all.length)
  assert.equal(result.text.split('\n').filter((line) => line.startsWith('## ')).length, result.entryCount)
  assert.equal(result.tokens, estimateTokens(result.text))
  assert.equal(result.text.includes('x'.repeat(400)), true)
})

test('renderMemoryBlock yields only the marker when nothing fits', () => {
  const result = renderMemoryBlock([{ kind: 'constraint', entries: [entry()] }], 1)
  assert.equal(result.entryCount, 0)
  assert.equal(result.truncated, true)
  assert.equal(result.text, '[memory truncated]')
  assert.equal(result.tokens, estimateTokens('[memory truncated]'))
})

test('renderMemoryBlock stops before a section that only partially fits', () => {
  const long = entry({ title: 'first', text: 'y'.repeat(400) })
  const result = renderMemoryBlock(
    [
      { kind: 'constraint', entries: [long] },
      { kind: 'decision', entries: [entry({ title: 'later', text: 'z'.repeat(400) })] },
    ],
    150,
  )
  assert.equal(result.entryCount, 1)
  assert.equal(result.truncated, true)
  assert.equal(result.text.includes('### decisions'), false)
  assert.ok(result.text.endsWith('[memory truncated]'))
})

// ---------------------------------------------------------------------------
// searchMemory
// ---------------------------------------------------------------------------

test('searchMemory weights title over text over source', () => {
  const hits = searchMemory(
    [
      searchable({ title: 'lock ordering', text: 'always take the lock' }),
      searchable({ title: 'unrelated', text: 'the lock lives here' }),
      searchable({ title: 'nothing', text: 'unrelated', source: 'lock' }),
      searchable({ title: 'nothing', text: 'unrelated' }),
    ],
    'lock',
    { tokenize },
  )

  assert.deepEqual(
    hits.map((hit) => [hit.title, hit.score]),
    [
      ['lock ordering', 5],
      ['unrelated', 2],
      ['nothing', 1],
    ],
  )
  assert.equal(hits[0].file, MEMORY_FILES.fact)
  assert.equal(hits[0].source, 'thread-a')
  assert.equal(hits[0].createdAt, ISO)
})

test('searchMemory breaks ties by createdAt descending then title ascending', () => {
  const newer = searchable({ title: 'zzz newer', createdAt: '2026-11-05T00:00:02.000Z' })
  const olderA = searchable({ title: 'aaa older', createdAt: '2026-11-04T00:00:00.000Z' })
  const olderB = searchable({ title: 'bbb older', createdAt: '2026-11-04T00:00:00.000Z' })

  const hits = searchMemory([olderB, newer, olderA], 'lock', { tokenize })
  assert.deepEqual(
    hits.map((hit) => hit.title),
    ['zzz newer', 'aaa older', 'bbb older'],
  )
})

test('searchMemory clamps the limit and falls back to the default', () => {
  const many = Array.from({ length: 25 }, (_, i) => searchable({ title: `lock ${i}` }))
  assert.equal(DEFAULT_SEARCH_LIMIT, 5)
  assert.equal(MAX_SEARCH_LIMIT, 20)

  assert.equal(searchMemory(many, 'lock', { tokenize }).length, 5)
  assert.equal(searchMemory(many, 'lock', { tokenize, limit: 3 }).length, 3)
  assert.equal(searchMemory(many, 'lock', { tokenize, limit: 100 }).length, 20)
  assert.equal(searchMemory(many, 'lock', { tokenize, limit: 0 }).length, 1)
  assert.equal(searchMemory(many, 'lock', { tokenize, limit: -7 }).length, 1)
  assert.equal(searchMemory(many, 'lock', { tokenize, limit: 2.9 }).length, 2)
  assert.equal(searchMemory(many, 'lock', { tokenize, limit: Number.NaN }).length, 5)
  assert.equal(searchMemory(many, 'lock', { tokenize, limit: 'x' }).length, 5)
})

test('searchMemory finds CJK terms with the real tokenizer and drops zero scores', () => {
  const entries = [
    searchable({ title: '部署流程', text: '先跑测试再发布', source: 'thread-cn' }),
    searchable({ title: 'unrelated english', text: 'nothing here' }),
  ]
  const hits = searchMemory(entries, '部署', { tokenize })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].title, '部署流程')
  assert.equal(hits[0].score, 3)

  assert.deepEqual(searchMemory(entries, '', { tokenize }), [])
  assert.deepEqual(searchMemory(entries, 'missing', { tokenize }), [])
})

// ---------------------------------------------------------------------------
// appendMemoryEntry
// ---------------------------------------------------------------------------

test('appendMemoryEntry writes the first entry into a missing file under the lock', async () => {
  const io = fakeIo()
  const clock = () => new Date('2026-11-05T01:02:03.004Z')
  const result = await appendMemoryEntry(
    io,
    REPO,
    'fact',
    { title: 'new fact', text: 'the body', source: 'thread-a' },
    clock,
  )

  const filePath = memoryFilePath(REPO, 'fact')
  assert.equal(result.file, MEMORY_FILES.fact)
  assert.equal(result.filePath, filePath)
  assert.equal(result.entry.createdAt, '2026-11-05T01:02:03.004Z')
  assert.equal(io.calls.locks, 1)
  assert.deepEqual(io.calls.wroteInsideLock, [true])
  assert.equal(io.files.get(filePath), `${block('new fact', 'the body', 'thread-a', '2026-11-05T01:02:03.004Z')}\n`)
})

test('appendMemoryEntry keeps existing entries with exactly one blank line', async () => {
  const filePath = memoryFilePath(REPO, 'decision')
  const io = fakeIo({ [filePath]: `${block('old', 'first body')}\n` })

  await appendMemoryEntry(io, REPO, 'decision', { title: 'new', text: 'second body', source: 'thread-b' }, () => new Date(ISO))

  const written = io.files.get(filePath)
  assert.equal(written, `${block('old', 'first body')}\n\n${block('new', 'second body', 'thread-b')}\n`)

  const parsed = parseMemoryFile('decision', 'decisions.md', written)
  assert.deepEqual(parsed.issues, [])
  assert.deepEqual(
    parsed.entries.map((e) => e.title),
    ['old', 'new'],
  )
})

test('appendMemoryEntry throws MemoryCorruptError and writes nothing for a corrupt file', async () => {
  const filePath = memoryFilePath(REPO, 'constraint')
  const corrupt = '## broken\n\nbody without a provenance line\n'
  const io = fakeIo({ [filePath]: corrupt })

  await assert.rejects(
    () => appendMemoryEntry(io, REPO, 'constraint', { title: 't', text: 'x', source: 's' }, () => new Date(ISO)),
    (error) => {
      assert.ok(error instanceof MemoryCorruptError)
      assert.equal(error.name, 'MemoryCorruptError')
      assert.equal(error.file, filePath)
      assert.equal(error.issues.length, 1)
      assert.equal(error.issues[0].line, 3)
      assert.match(error.message, /line 3/)
      return true
    },
  )
  assert.deepEqual(io.calls.writes, [])
  assert.equal(io.files.get(filePath), corrupt)
})

test('appendMemoryEntry rejects invalid input without touching the file', async () => {
  const io = fakeIo()
  await assert.rejects(
    () => appendMemoryEntry(io, REPO, 'fact', { title: '', text: 'x', source: 's' }, () => new Date(ISO)),
    /invalid fact memory entry/,
  )
  await assert.rejects(
    () => appendMemoryEntry(io, '/repo', 'nope', { title: 't', text: 'x', source: 's' }, () => new Date(ISO)),
    /unknown memory kind/,
  )
  assert.deepEqual(io.calls.writes, [])
})

// ---------------------------------------------------------------------------
// loadMemory
// ---------------------------------------------------------------------------

test('loadMemory skips missing files and reports corrupt ones by name', async () => {
  assert.deepEqual(await loadMemory(fakeIo(), REPO), { files: [], issues: [] })

  const io = fakeIo({
    [memoryFilePath(REPO, 'constraint')]: `${block('keep it simple', 'no extra layers')}\n`,
    [memoryFilePath(REPO, 'fact')]: '## broken\n\nno provenance here\n',
  })
  const loaded = await loadMemory(io, REPO)

  assert.deepEqual(
    loaded.files.map((file) => [file.kind, file.file, file.entries.length]),
    [
      ['constraint', MEMORY_FILES.constraint, 1],
      ['fact', MEMORY_FILES.fact, 0],
    ],
  )
  assert.equal(loaded.issues.length, 1)
  assert.match(loaded.issues[0].file, /facts\.md/)
  assert.equal(loaded.issues[0].line, 3)
})
