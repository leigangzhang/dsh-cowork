import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import {
  ProjectStore,
  StoreError,
  findProjectRoot,
  findProjectRootSync,
  handoffFileName,
  projectIdFor,
} from '../src/store.ts'

const execFileAsync = promisify(execFile)

const CREATED_AT = '2026-11-05T03:04:05.006Z'

/** Run one case inside a throwaway directory that is always removed. */
async function withTempDir(run) {
  const path = await mkdtemp(join(tmpdir(), 'dsh-cowork-store-'))
  try {
    return await run(path)
  } finally {
    await rm(path, { recursive: true, force: true })
  }
}

/** A clock frozen at one instant. */
const clockAt = (iso) => () => new Date(iso)

/** A thread record with the given overrides. */
const thread = (overrides = {}) => ({
  threadId: 'session-a',
  subject: 'wire the store',
  status: 'new',
  cwd: '/repo',
  checkoutPath: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  lastHandoffAt: null,
  ...overrides,
})

/** A handoff record with the given overrides. */
const handoff = (overrides = {}) => ({
  version: 1,
  threadId: 'session-a',
  masterSessionId: 'session-master',
  status: 'awaiting_review',
  subject: 'store works',
  summary: 'implemented the project store',
  decisions: [],
  changedPaths: [],
  artifacts: [],
  verification: [{ command: 'node --test tests/store.test.mjs', exitCode: 0, evidence: 'pass 12' }],
  openIssues: [],
  nextStep: null,
  createdAt: CREATED_AT,
  deliveredAt: null,
  ...overrides,
})

/** Escape a literal for use inside a RegExp. */
const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Assert a promise rejects with the given StoreError code (and message part). */
async function rejectsStore(promise, code, messagePart) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof StoreError, true, `expected StoreError, got ${error?.constructor?.name}`)
    assert.equal(error.code, code, error.message)
    if (messagePart !== undefined) {
      assert.match(error.message, new RegExp(escapePattern(messagePart)))
    }
    return true
  })
}

/** The permission bits of a path. */
async function modeOf(path) {
  return (await stat(path)).mode & 0o777
}

/** File names in a directory that would mean an uncommitted atomic write or a held lock. */
function residue(names) {
  return names.filter((name) => name.endsWith('.tmp') || name.includes('.lock'))
}

test('initIndex creates the index once and never replaces the master', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({
      repoPath,
      clock: clockAt(CREATED_AT),
      projectId: 'github.com-owner-repo',
    })
    assert.equal(await store.hasIndex(), false)
    await rejectsStore(store.readIndex(), 'store/not-found', store.indexFile)

    const first = await store.initIndex('session-master')
    assert.deepEqual(first, {
      index: {
        version: 1,
        projectId: 'github.com-owner-repo',
        masterSessionId: 'session-master',
        createdAt: CREATED_AT,
        threads: [],
      },
      created: true,
    })
    assert.equal(await store.hasIndex(), true)

    const second = await store.initIndex('session-other')
    assert.equal(second.created, false)
    assert.equal(second.index.masterSessionId, 'session-master')

    // A later init must not move the original creation timestamp either.
    const third = await store.initIndex('session-third')
    assert.equal(third.index.createdAt, CREATED_AT)

    const onDisk = JSON.parse(await readFile(store.indexFile, 'utf8'))
    assert.deepEqual(onDisk, first.index)
    assert.match(await readFile(store.indexFile, 'utf8'), /\n$/)
    assert.equal(await modeOf(store.indexFile), 0o600)
    assert.equal(await modeOf(store.projectDir), 0o700)
    assert.deepEqual(residue(await readdir(store.projectDir)), [])
  })
})

test('readIndex reports a missing or damaged index without rebuilding it', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    await rejectsStore(store.readIndex(), 'store/not-found', join(repoPath, '.dsh-cowork', 'index.json'))
    assert.equal(await store.hasIndex(), false)
    assert.deepEqual(await readdir(store.projectDir).catch(() => []), [])

    await mkdir(store.projectDir, { recursive: true })
    await writeFile(store.indexFile, '{ not json', 'utf8')
    await rejectsStore(store.readIndex(), 'store/corrupt', store.indexFile)
    // The damaged file is still exactly what the writer left behind.
    assert.equal(await readFile(store.indexFile, 'utf8'), '{ not json')

    await writeFile(store.indexFile, JSON.stringify({ version: 2, projectId: 'p' }), 'utf8')
    await rejectsStore(store.readIndex(), 'store/corrupt', store.indexFile)

    const wrongThread = {
      version: 1,
      projectId: 'p',
      masterSessionId: 'm',
      createdAt: CREATED_AT,
      threads: [{ ...thread(), status: 'flying' }],
    }
    await writeFile(store.indexFile, JSON.stringify(wrongThread), 'utf8')
    await rejectsStore(store.readIndex(), 'store/corrupt', store.indexFile)

    const missingDate = { ...wrongThread, threads: [{ ...thread(), createdAt: 'yesterday' }] }
    await writeFile(store.indexFile, JSON.stringify(missingDate), 'utf8')
    await rejectsStore(store.readIndex(), 'store/corrupt', 'createdAt')

    // initIndex must surface the damage instead of silently replacing the file.
    await rejectsStore(store.initIndex('session-master'), 'store/corrupt', store.indexFile)
  })
})

test('concurrent writers serialize and leave no temp or lock residue', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    await store.initIndex('session-master')

    const ids = ['session-1', 'session-2', 'session-3', 'session-4', 'session-5', 'session-6']
    await Promise.all(ids.map((threadId) => store.addThread(thread({ threadId, subject: threadId }))))

    const index = await store.readIndex()
    // Lock serializes the writes; acquisition order is the OS's, not the call order,
    // so only "every write landed exactly once" is asserted.
    assert.deepEqual(
      index.threads.map((entry) => entry.threadId).sort(),
      [...ids].sort(),
    )

    // One of several writers racing on the same id wins; the rest see the committed state.
    const outcomes = await Promise.allSettled(
      ids.map((threadId) => store.addThread(thread({ threadId: 'session-race', subject: threadId }))),
    )
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected')
    assert.equal(rejected.length, ids.length - 1)
    for (const outcome of rejected) {
      assert.equal(outcome.reason.code, 'store/thread-exists')
    }
    assert.equal((await store.readIndex()).threads.filter((entry) => entry.threadId === 'session-race').length, 1)

    const names = await readdir(store.projectDir)
    assert.ok(names.includes('index.json'), names.join(','))
    assert.deepEqual(residue(names), [])
  })
})

test('addThread rejects duplicates and updateThread rejects unknown threads', async () => {
  await withTempDir(async (repoPath) => {
    let now = '2026-11-05T04:00:00.000Z'
    const store = new ProjectStore({ repoPath, clock: () => new Date(now), projectId: 'p' })
    await store.initIndex('session-master')

    await store.addThread(thread())
    await rejectsStore(store.addThread(thread()), 'store/thread-exists', 'session-a')
    await rejectsStore(store.addThread({ ...thread(), threadId: '' }), 'store/invalid-thread', 'threadId')
    const valid = await store.addThread(thread({ threadId: 'session-b' }))
    assert.equal(valid.threads.length, 2)
    await store.mutateIndex((index) => ({ ...index, threads: index.threads.filter((entry) => entry.threadId === 'session-a') }))

    const updated = await store.updateThread('session-a', { status: 'active', subject: 'renamed' })
    assert.equal(updated.threads.length, 1)
    assert.equal(updated.threads[0].status, 'active')
    assert.equal(updated.threads[0].subject, 'renamed')
    assert.equal(updated.threads[0].updatedAt, now)
    assert.equal(updated.threads[0].createdAt, CREATED_AT)
    assert.equal(updated.threads[0].lastHandoffAt, null)

    now = '2026-11-05T05:00:00.000Z'
    const stamped = await store.updateThread('session-a', {
      checkoutPath: '/repo/.dsh-cowork/threads/session-a',
      lastHandoffAt: '2026-11-05T04:30:00.000Z',
    })
    assert.equal(stamped.threads[0].updatedAt, now)
    assert.equal(stamped.threads[0].checkoutPath, '/repo/.dsh-cowork/threads/session-a')
    // The legacy name is gone from the record, so a rewrite cannot resurrect it.
    assert.equal('worktreePath' in stamped.threads[0], false)
    assert.equal(stamped.threads[0].lastHandoffAt, '2026-11-05T04:30:00.000Z')
    // Untouched fields survive the merge.
    assert.equal(stamped.threads[0].subject, 'renamed')

    const explicit = await store.updateThread('session-a', { updatedAt: '2026-01-01T00:00:00.000Z' })
    assert.equal(explicit.threads[0].updatedAt, '2026-01-01T00:00:00.000Z')

    await rejectsStore(store.updateThread('session-nope', { status: 'done' }), 'store/thread-not-found', 'session-nope')
    // The failed update wrote nothing.
    assert.equal((await store.readIndex()).threads.length, 1)
  })
})

test('writeHandoff names the file from createdAt and refuses to overwrite', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    await store.initIndex('session-master')

    const written = await store.writeHandoff(handoff())
    assert.equal(written.fileName, 'session-a-20261105T030405006Z.json')
    assert.equal(written.filePath, join(store.handoffsDir, written.fileName))
    assert.equal(written.record.deliveredAt, null)
    assert.deepEqual(JSON.parse(await readFile(written.filePath, 'utf8')), handoff())
    assert.equal(await modeOf(written.filePath), 0o600)
    assert.equal(await modeOf(store.handoffsDir), 0o700)
    assert.deepEqual(residue(await readdir(store.handoffsDir)), [])

    await rejectsStore(store.writeHandoff(handoff()), 'store/handoff-exists', written.fileName)
    assert.equal(await readFile(written.filePath, 'utf8'), `${JSON.stringify(handoff(), null, 2)}\n`)

    const custom = await store.writeHandoff(handoff({ subject: 'custom name' }), 'custom.json')
    assert.equal(custom.fileName, 'custom.json')
    assert.equal(custom.filePath, join(store.handoffsDir, 'custom.json'))

    await rejectsStore(store.writeHandoff(handoff(), '../escape.json'), 'store/invalid', 'escape.json')
    await rejectsStore(store.writeHandoff({ ...handoff(), status: 'new' }), 'store/invalid-handoff', 'status')
    await rejectsStore(
      store.writeHandoff({ ...handoff(), verification: [] }),
      'store/invalid-handoff',
      'verification',
    )
  })
})

test('listHandoffs orders by createdAt, not by file name', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    // No handoff directory yet: an empty project lists nothing instead of failing.
    assert.deepEqual(await store.listHandoffs(), [])

    await store.initIndex('session-master')
    const late = await store.writeHandoff(
      handoff({ createdAt: '2026-11-05T03:00:09.000Z', subject: 'late' }),
      'a-late.json',
    )
    const early = await store.writeHandoff(
      handoff({ createdAt: '2026-11-05T03:00:01.000Z', subject: 'early' }),
      'z-early.json',
    )
    const middle = await store.writeHandoff(handoff({ createdAt: '2026-11-05T03:00:05.000Z' }))
    const tieA = await store.writeHandoff(
      handoff({ createdAt: '2026-11-05T03:00:07.000Z', subject: 'tie' }),
      'b-tie.json',
    )
    const tieB = await store.writeHandoff(
      handoff({ createdAt: '2026-11-05T03:00:07.000Z', subject: 'tie' }),
      'a-tie.json',
    )
    // A non-JSON file in the directory is not a handoff.
    await writeFile(join(store.handoffsDir, 'notes.txt'), 'ignore me', 'utf8')

    const files = await store.listHandoffs()
    assert.deepEqual(
      files.map((file) => file.fileName),
      [early.fileName, middle.fileName, tieB.fileName, tieA.fileName, late.fileName],
    )
    assert.deepEqual(
      files.map((file) => file.record.createdAt),
      [
        '2026-11-05T03:00:01.000Z',
        '2026-11-05T03:00:05.000Z',
        '2026-11-05T03:00:07.000Z',
        '2026-11-05T03:00:07.000Z',
        '2026-11-05T03:00:09.000Z',
      ],
    )
    assert.equal(files[0].filePath, early.filePath)
  })
})

test('listHandoffs and readHandoff surface a damaged handoff with its path', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    await mkdir(store.handoffsDir, { recursive: true })
    const broken = join(store.handoffsDir, 'broken.json')
    await writeFile(broken, '{ "version": 1,', 'utf8')
    await rejectsStore(store.listHandoffs(), 'store/corrupt', broken)
    await rejectsStore(store.readHandoff(broken), 'store/corrupt', broken)

    const wrongShape = join(store.handoffsDir, 'wrong-shape.json')
    await writeFile(wrongShape, JSON.stringify(handoff({ status: 'active' })), 'utf8')
    await rejectsStore(store.readHandoff(wrongShape), 'store/corrupt', 'status')

    await rejectsStore(store.readHandoff(join(store.handoffsDir, 'absent.json')), 'store/not-found', 'absent.json')
  })
})

test('markHandoffDelivered rewrites only deliveredAt', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    await store.initIndex('session-master')
    const written = await store.writeHandoff(handoff({ decisions: ['keep the store dumb'] }))

    const deliveredAt = '2026-11-05T06:00:00.000Z'
    const marked = await store.markHandoffDelivered(written.filePath, deliveredAt)
    assert.equal(marked.filePath, written.filePath)
    assert.equal(marked.fileName, written.fileName)
    assert.equal(marked.record.deliveredAt, deliveredAt)
    assert.deepEqual({ ...marked.record, deliveredAt: null }, handoff({ decisions: ['keep the store dumb'] }))
    assert.deepEqual(JSON.parse(await readFile(written.filePath, 'utf8')), marked.record)
    assert.deepEqual(residue(await readdir(store.handoffsDir)), [])

    // Reading it back through the public reader agrees with the returned record.
    assert.deepEqual(await store.readHandoff(written.filePath), marked.record)
    await rejectsStore(store.markHandoffDelivered(written.filePath, 'not-a-date'), 'store/invalid', 'deliveredAt')
  })
})

test('findProjectRoot walks up to the directory holding the index', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    assert.equal(await findProjectRoot(repoPath), null)

    // A `.dsh-cowork` directory without an index is not a project.
    await mkdir(store.projectDir, { recursive: true })
    assert.equal(await findProjectRoot(repoPath), null)

    await store.initIndex('session-master')
    const nested = join(repoPath, 'src', 'deep', 'deeper')
    await mkdir(nested, { recursive: true })
    assert.equal(await findProjectRoot(nested), repoPath)
    assert.equal(await findProjectRoot(repoPath), repoPath)

    const file = join(nested, 'note.txt')
    await writeFile(file, 'hi', 'utf8')
    assert.equal(await findProjectRoot(file), repoPath)

    // The nearest project wins, even when a parent is also a project.
    const child = join(repoPath, 'packages', 'child')
    const childStore = new ProjectStore({ repoPath: child, clock: clockAt(CREATED_AT), projectId: 'child' })
    await childStore.initIndex('session-child-master')
    assert.equal(await findProjectRoot(join(child, 'src')), child)

    // A directory outside any project reports no project.
    const outside = await mkdtemp(join(tmpdir(), 'dsh-cowork-outside-'))
    try {
      assert.equal(await findProjectRoot(outside), null)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

test('readIndex reads a pre-M2 index that still says worktreePath', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    await mkdir(store.projectDir, { recursive: true })
    const legacyThread = {
      threadId: 'session-old',
      subject: 'before the rename',
      status: 'new',
      cwd: '/repo',
      worktreePath: '/legacy/wt',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      lastHandoffAt: null,
    }
    const indexFile = (threads) => JSON.stringify({
      version: 1,
      projectId: 'p',
      masterSessionId: 'm',
      createdAt: CREATED_AT,
      threads,
    })

    await writeFile(store.indexFile, indexFile([legacyThread]), 'utf8')
    const index = await store.readIndex()
    assert.equal(index.threads[0].checkoutPath, '/legacy/wt')
    assert.equal('worktreePath' in index.threads[0], false)

    // Neither field means "no checkout", not a corrupt index.
    const plain = { ...legacyThread, threadId: 'session-plain' }
    delete plain.worktreePath
    await writeFile(store.indexFile, indexFile([plain]), 'utf8')
    assert.equal((await store.readIndex()).threads[0].checkoutPath, null)

    // A rewrite emits checkoutPath only; the legacy name never comes back.
    await writeFile(store.indexFile, indexFile([legacyThread]), 'utf8')
    await store.updateThread('session-old', { status: 'active' })
    const onDisk = JSON.parse(await readFile(store.indexFile, 'utf8'))
    assert.equal(onDisk.threads[0].checkoutPath, '/legacy/wt')
    assert.equal('worktreePath' in onDisk.threads[0], false)
  })
})

test('readText and writeTextAtomic give the memory files the atomic path and the store lock', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    const memoryFile = join(store.projectDir, 'memory', 'facts.md')
    assert.equal(await store.readText(memoryFile), null)

    const content = '## a\n\nb\n\n(来源: s; 2026-11-05T00:00:00.000Z)\n'
    await store.writeTextAtomic(memoryFile, content)
    assert.equal(await store.readText(memoryFile), content)
    assert.equal(await modeOf(memoryFile), 0o600)
    assert.equal(await modeOf(dirname(memoryFile)), 0o700)
    assert.deepEqual(residue(await readdir(dirname(memoryFile))), [])

    // A caller-side read-modify-write cycle serializes through the same lock.
    let running = 0
    let peak = 0
    await Promise.all([1, 2, 3].map(() => store.withWriteLock(async () => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((resolveWait) => setTimeout(resolveWait, 5))
      running -= 1
    })))
    assert.equal(peak, 1, 'withWriteLock must serialize its operations')
  })
})

test('findProjectRootSync matches the async walk-up', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    assert.equal(findProjectRootSync(repoPath), null)
    assert.equal(await findProjectRoot(repoPath), null)

    await store.initIndex('session-master')
    const nested = join(repoPath, 'src', 'deep')
    await mkdir(nested, { recursive: true })
    assert.equal(findProjectRootSync(nested), repoPath)
    assert.equal(findProjectRootSync(join(nested, 'not-created.txt')), repoPath)
    assert.equal(findProjectRootSync(nested), await findProjectRoot(nested))

    const outside = await mkdtemp(join(tmpdir(), 'dsh-cowork-outside-'))
    try {
      assert.equal(findProjectRootSync(outside), null)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

test('handoffFileName stamps UTC with milliseconds', () => {
  assert.equal(
    handoffFileName('session-x', new Date('2026-11-05T03:04:05.006Z')),
    'session-x-20261105T030405006Z.json',
  )
  assert.equal(
    handoffFileName('session-x', new Date('2026-01-02T03:04:05.006+08:00')),
    'session-x-20260101T190405006Z.json',
  )
  assert.equal(handoffFileName('session-x', new Date('2026-11-05T00:00:00.000Z')), 'session-x-20261105T000000000Z.json')
})

test('projectIdFor prefers a normalized origin remote and hashes the path otherwise', async () => {
  await withTempDir(async (repoPath) => {
    const git = (args) =>
      execFileAsync('git', args, {
        cwd: repoPath,
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      })

    await git(['init'])
    // No remote yet: the id is the truncated hash of the real path.
    const expected = createHash('sha256').update(await realpath(repoPath)).digest('hex').slice(0, 12)
    assert.equal(await projectIdFor(repoPath), expected)

    await git(['remote', 'add', 'origin', 'https://github.com/Owner/Repo.git'])
    assert.equal(await projectIdFor(repoPath), 'github.com-owner-repo')

    await git(['remote', 'set-url', 'origin', 'git@github.com:Owner/Repo.git'])
    assert.equal(await projectIdFor(repoPath), 'github.com-owner-repo')

    await git(['remote', 'set-url', 'origin', 'https://GitHub.com:8443/Owner/Repo.git'])
    assert.equal(await projectIdFor(repoPath), 'github.com-owner-repo')

    await git(['remote', 'set-url', 'origin', 'ssh://git@gitlab.example.com/Group/Sub.Repo.git'])
    assert.equal(await projectIdFor(repoPath), 'gitlab.example.com-group-sub-repo')

    // initIndex without an explicit id derives the same id the standalone helper reports.
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT) })
    const created = await store.initIndex('session-master')
    assert.equal(created.index.projectId, 'gitlab.example.com-group-sub-repo')
  })

  // A directory that is not a repository at all falls back to the path hash.
  await withTempDir(async (plainPath) => {
    const expected = createHash('sha256').update(await realpath(plainPath)).digest('hex').slice(0, 12)
    assert.equal(await projectIdFor(plainPath), expected)
  })
})
