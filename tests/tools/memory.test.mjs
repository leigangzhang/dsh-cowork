import test from 'node:test'
import assert from 'node:assert/strict'
import '../support/ts-hook.mjs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Behavior tests for the project-memory tools (`cowork_memory_write`,
 * `cowork_memory_search`).
 *
 * The domain module (`src/domains/memory/memory.ts`) owns parsing, validation,
 * ranking and append semantics and has its own suite. These tests cover the
 * tool wrapper only: the role gate, the failure envelopes, and the payload the
 * model observes. The registry is a recording fake and the project store is the
 * real one under `os.tmpdir()`, so every assertion reads the files the tool
 * actually wrote.
 */
import { makeSeedProject, makeTopicFixture, withRepo } from '../support/inbox-fixtures.mjs'

const { registerMemoryTools } = await import('../../src/tools/memory.ts')
const { ERROR_CODES } = await import('../../src/platform/tool-model.ts')

const NOW = new Date('2026-11-15T09:00:00.000Z')
const NOW_ISO = NOW.toISOString()
const MASTER = 'session-master'
const THREAD = 'session-thread'

/** Paths computed here, not through the module under test. */
const indexFile = (repoPath) => join(repoPath, '.dsh-cowork', 'index.json')
const memoryFile = (repoPath, fileName) => join(repoPath, '.dsh-cowork', 'memory', fileName)

/** One entry block exactly as the memory file format stores it. */
const block = (title, text, source = 'thread-a', createdAt = NOW_ISO) =>
  `## ${title}\n\n${text}\n\n(来源: ${source}; ${createdAt})`

/** A tool registry that keeps every definition the registrar registers. */
function fakeHost() {
  const registry = new Map()
  return {
    registry,
    tools: {
      register(definition) {
        registry.set(definition.name, definition)
        return () => registry.delete(definition.name)
      },
    },
  }
}

/** The structured execution identity one tool call receives. */
function fakeExec(sessionId, cwd) {
  return { agent: { id: sessionId, session: { header: { cwd } } } }
}

/**
 * Host ports the memory tools never call. A call that happens anyway fails
 * loudly instead of silently passing; the real store is the only dependency
 * they do use.
 */
function fakeDeps() {
  return {
    sessionController: {
      async create() { throw new Error('memory tools must not create sessions') },
      async rename() { throw new Error('memory tools must not rename sessions') },
      async prompt() { throw new Error('memory tools must not prompt sessions') },
      async list() { return { items: [] } },
      async inspect(sessionId) { return { meta: { id: sessionId } } },
    },
    workspaceRegistry: {
      async resolveByPath(path) { return { id: 'workspace-1', path } },
      async create(path) { return { id: 'workspace-1', path } },
      async delete() { return true },
      async archiveSession() {},
    },
    agentPresets: {},
    clock: () => NOW,
    log: () => {},
  }
}

const topic = makeTopicFixture({ topicId: THREAD, title: 'Memory thread' })
const seedProject = makeSeedProject({ clock: () => NOW })

function tools(deps) {
  const host = fakeHost()
  registerMemoryTools(host, deps)
  return host.registry
}

/** Write one memory file by hand, creating the memory directory. */
async function seedMemoryFile(repoPath, fileName, content) {
  const filePath = memoryFile(repoPath, fileName)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content)
  return filePath
}

/** Replace the project index with unreadable JSON. */
async function corruptProjectIndex(repoPath) {
  await mkdir(join(repoPath, '.dsh-cowork'), { recursive: true })
  await writeFile(indexFile(repoPath), '{not json\n')
}

/**
 * The real store with only its atomic text write replaced. Reads, the lock and
 * the index still go through the store, which is what the append path uses
 * before it reaches the failing write.
 */
function storeWithFailingWrite(store, message) {
  return new Proxy(store, {
    get(target, property) {
      if (property === 'writeTextAtomic') {
        return async () => { throw new Error(message) }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

// ---------------------------------------------------------------------------
// cowork_memory_write
// ---------------------------------------------------------------------------

test('cowork_memory_write appends each kind to its own file and reports the entry', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [topic()])
    const write = tools(fakeDeps()).get('cowork_memory_write')
    const cases = [
      ['constraint', 'constraints.md', fakeExec(MASTER, repoPath)],
      ['decision', 'decisions.md', fakeExec(THREAD, repoPath)],
      ['fact', 'facts.md', fakeExec(MASTER, repoPath)],
    ]

    for (const [kind, fileName, exec] of cases) {
      const title = `${kind} title`
      const text = `${kind} body`
      const result = await write.execute({ kind, title, text, source: 'thread-a' }, exec)

      assert.equal(result.ok, true, kind)
      assert.equal(result.file, fileName, kind)
      assert.equal(result.filePath, memoryFile(repoPath, fileName), kind)
      assert.deepEqual(result.entry, {
        kind,
        title,
        text,
        source: 'thread-a',
        createdAt: NOW_ISO,
      }, kind)
      assert.equal(
        await readFile(result.filePath, 'utf8'),
        `${block(title, text)}\n`,
        `${kind} is stored under its own heading with the injected clock`,
      )
    }
  })
})

test('cowork_memory_write refuses an empty or control-character entry without writing', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [])
    const write = tools(fakeDeps()).get('cowork_memory_write')

    const empty = await write.execute(
      { kind: 'fact', title: '   ', text: '', source: '' },
      fakeExec(MASTER, repoPath),
    )
    assert.equal(empty.ok, false)
    assert.equal(empty.error.code, ERROR_CODES.memoryInvalid)
    assert.equal(empty.error.message, 'memory entry is invalid')
    assert.deepEqual(
      empty.error.details.issues.map((issue) => issue.field),
      ['title', 'text', 'source'],
    )
    for (const issue of empty.error.details.issues) assert.match(issue.message, /non-empty/)

    const control = await write.execute({
      kind: 'constraint',
      title: 'bad\u0000title',
      text: 'line\nbreak',
      source: 'tab\there',
    }, fakeExec(MASTER, repoPath))
    assert.equal(control.ok, false)
    assert.equal(control.error.code, ERROR_CODES.memoryInvalid)
    assert.deepEqual(
      control.error.details.issues.map((issue) => issue.field),
      ['title', 'text', 'source'],
    )
    for (const issue of control.error.details.issues) assert.match(issue.message, /control characters/)

    await assert.rejects(readFile(memoryFile(repoPath, 'constraints.md'), 'utf8'), { code: 'ENOENT' })
    await assert.rejects(readFile(memoryFile(repoPath, 'facts.md'), 'utf8'), { code: 'ENOENT' })
  })
})

test('cowork_memory_write reports a corrupt memory file instead of appending to it', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [])
    const corrupt = '## broken\n\nbody without a provenance line\n'
    const filePath = await seedMemoryFile(repoPath, 'facts.md', corrupt)

    const result = await tools(fakeDeps()).get('cowork_memory_write').execute(
      { kind: 'fact', title: 'new fact', text: 'the body', source: 'thread-a' },
      fakeExec(MASTER, repoPath),
    )

    assert.equal(result.ok, false)
    assert.equal(result.error.code, ERROR_CODES.memoryInvalid)
    assert.match(result.error.message, /is corrupt/)
    assert.match(result.error.message, /line 3/)
    assert.equal(result.error.details.file, filePath)
    assert.equal(result.error.details.issues.length, 1)
    assert.equal(result.error.details.issues[0].file, filePath)
    assert.equal(result.error.details.issues[0].line, 3)
    assert.match(result.error.details.issues[0].message, /来源/)
    assert.equal(await readFile(filePath, 'utf8'), corrupt, 'the unparseable tail is never overwritten')
  })
})

test('cowork_memory_write reports a failed store write as memoryWriteFailed', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [])
    const deps = fakeDeps()
    deps.createProjectStore = () => storeWithFailingWrite(store, 'disk full')
    const indexBefore = await readFile(indexFile(repoPath), 'utf8')

    const result = await tools(deps).get('cowork_memory_write').execute(
      { kind: 'fact', title: 'new fact', text: 'the body', source: 'thread-a' },
      fakeExec(MASTER, repoPath),
    )

    assert.equal(result.ok, false)
    assert.equal(result.error.code, ERROR_CODES.memoryWriteFailed)
    assert.equal(result.error.message, 'disk full')
    await assert.rejects(readFile(memoryFile(repoPath, 'facts.md'), 'utf8'), { code: 'ENOENT' })
    assert.equal(await readFile(indexFile(repoPath), 'utf8'), indexBefore, 'a failed append does not touch the index')
  })
})

// ---------------------------------------------------------------------------
// shared wrapper behavior: project open, role gate, caller identity
// ---------------------------------------------------------------------------

test('memory tools map a corrupt project index instead of throwing', async () => {
  await withRepo(async (repoPath) => {
    await corruptProjectIndex(repoPath)
    const registry = tools(fakeDeps())
    const cases = [
      ['cowork_memory_write', { kind: 'fact', title: 't', text: 'x', source: 's' }],
      ['cowork_memory_search', { query: 'lock' }],
    ]

    for (const [name, args] of cases) {
      const result = await registry.get(name).execute(args, fakeExec(MASTER, repoPath))
      assert.equal(result.ok, false, name)
      assert.equal(result.error.code, ERROR_CODES.storeCorrupt, name)
      assert.equal(result.error.details.filePath, indexFile(repoPath), name)
    }
  })
})

test('memory tools refuse a session that is neither the master nor a thread', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [topic()])
    const registry = tools(fakeDeps())
    const stranger = fakeExec('session-stranger', repoPath)

    const write = await registry.get('cowork_memory_write').execute(
      { kind: 'fact', title: 't', text: 'x', source: 's' },
      stranger,
    )
    assert.equal(write.ok, false)
    assert.equal(write.error.code, ERROR_CODES.roleForbidden)
    assert.deepEqual(write.error.details, {
      role: 'master-or-thread',
      sessionId: 'session-stranger',
      masterSessionId: MASTER,
    })

    const search = await registry.get('cowork_memory_search').execute({ query: 'lock' }, stranger)
    assert.equal(search.ok, false)
    assert.equal(search.error.code, ERROR_CODES.roleForbidden)
    assert.deepEqual(search.error.details, {
      role: 'master-or-thread',
      sessionId: 'session-stranger',
      masterSessionId: MASTER,
    })
  })
})

test('memory tools fail closed when exec carries no caller', async () => {
  const registry = tools(fakeDeps())
  const cases = [
    ['cowork_memory_write', { kind: 'fact', title: 't', text: 'x', source: 's' }],
    ['cowork_memory_search', { query: 'lock' }],
  ]

  for (const [name, args] of cases) {
    const result = await registry.get(name).execute(args, undefined)
    assert.equal(result.ok, false, name)
    assert.equal(result.error.code, ERROR_CODES.agentUnavailable, name)
    assert.match(result.error.message, /no caller identity/)
  }
})

// ---------------------------------------------------------------------------
// cowork_memory_search
// ---------------------------------------------------------------------------

test('cowork_memory_search returns ranked hits, the applicable issues and the bounded total', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [])
    await seedMemoryFile(repoPath, 'constraints.md', [
      block('lock ordering', 'always take the lock', 'thread-a', '2026-11-15T08:00:00.000Z'),
      block('prefer pnpm', 'never run npm install', 'thread-b', '2026-11-15T07:00:00.000Z'),
    ].join('\n\n') + '\n')
    await seedMemoryFile(repoPath, 'facts.md', `${block(
      'fact title',
      'the lock lives here',
      'thread-c',
      '2026-11-15T06:00:00.000Z',
    )}\n`)
    const search = tools(fakeDeps()).get('cowork_memory_search')

    const all = await search.execute({ query: 'lock' }, fakeExec(MASTER, repoPath))
    assert.equal(all.ok, true)
    assert.deepEqual(all.issues, [])
    assert.deepEqual(all.hits, [
      {
        kind: 'constraint',
        title: 'lock ordering',
        text: 'always take the lock',
        source: 'thread-a',
        file: 'constraints.md',
        createdAt: '2026-11-15T08:00:00.000Z',
        score: 5,
      },
      {
        kind: 'fact',
        title: 'fact title',
        text: 'the lock lives here',
        source: 'thread-c',
        file: 'facts.md',
        createdAt: '2026-11-15T06:00:00.000Z',
        score: 2,
      },
    ])
    assert.equal(all.total, 2)

    const limited = await search.execute({ query: 'lock', limit: 1 }, fakeExec(MASTER, repoPath))
    assert.equal(limited.ok, true)
    assert.equal(limited.total, 1)
    assert.deepEqual(limited.hits, [all.hits[0]], 'the limit keeps the highest-ranked hit')

    const missing = await search.execute({ query: 'not stored anywhere' }, fakeExec(MASTER, repoPath))
    assert.equal(missing.ok, true)
    assert.deepEqual(missing.hits, [])
    assert.equal(missing.total, 0)
  })
})

test('cowork_memory_search refuses a whitespace-only query', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [])
    const result = await tools(fakeDeps()).get('cowork_memory_search').execute(
      { query: ' \t ' },
      fakeExec(MASTER, repoPath),
    )

    assert.equal(result.ok, false)
    assert.equal(result.error.code, ERROR_CODES.memoryInvalid)
    assert.equal(result.error.message, 'query must not be empty')
  })
})

test('cowork_memory_search reports parse issues while still searching readable files', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [])
    await seedMemoryFile(repoPath, 'constraints.md', `${block('keep it simple', 'no extra layers')}\n`)
    const corrupt = '## broken\n\nno provenance here\n'
    const filePath = await seedMemoryFile(repoPath, 'facts.md', corrupt)

    const result = await tools(fakeDeps()).get('cowork_memory_search').execute(
      { query: 'simple' },
      fakeExec(MASTER, repoPath),
    )

    assert.equal(result.ok, true)
    assert.equal(result.hits.length, 1)
    assert.equal(result.hits[0].file, 'constraints.md')
    assert.equal(result.hits[0].title, 'keep it simple')
    assert.equal(result.total, 1)
    assert.equal(result.issues.length, 1)
    assert.equal(result.issues[0].file, 'facts.md')
    assert.equal(result.issues[0].line, 3)
    assert.match(result.issues[0].message, /来源/)
    assert.equal(await readFile(filePath, 'utf8'), corrupt, 'search never rewrites a corrupt file')
  })
})
