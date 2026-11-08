import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { register } from 'node:module'

/**
 * `src/store.ts` value-imports `./store-schema.js` and `./store-migration.js`
 * (the v2 index schema and the v1→v2 migration), and Node's type stripping does
 * not retry a `.js` sibling as `.ts`. This is the same resolve hook
 * tests/review-verdict.test.mjs uses.
 */
const HOOK_SOURCE = [
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier.startsWith('.') && specifier.endsWith('.js')) {",
  "    try { return await nextResolve(specifier.slice(0, -3) + '.ts', context) } catch {}",
  '  }',
  '  return nextResolve(specifier, context)',
  '}',
].join('\n')
register(`data:text/javascript,${encodeURIComponent(HOOK_SOURCE)}`)

const {
  ProjectStore,
  StoreError,
  findProjectRoot,
  findProjectRootSync,
  handoffFileName,
  projectIdFor,
  reviewFileName,
} = await import('../src/store.ts')

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

/** A review record with the given overrides. */
const review = (overrides = {}) => ({
  version: 1,
  threadId: 'session-a',
  reviewerSessionId: 'session-reviewer',
  verdict: 'needs_revision',
  summary: 'one fix before merge',
  findings: [
    {
      id: 'F1',
      severity: 'high',
      problem: 'the merge gate can be skipped',
      requiredFix: 'route the merge through checkMergeGate',
      file: 'src/tools.ts',
      line: 42,
    },
  ],
  verification: [{ command: 'node --test tests/store.test.mjs', exitCode: 0, evidence: 'pass 30' }],
  createdAt: CREATED_AT,
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

const LATER_AT = '2026-11-07T11:22:33.444Z'

/** A v1 index document with the given threads. */
const v1Index = (threads, overrides = {}) => ({
  version: 1,
  projectId: 'p',
  masterSessionId: 'session-master',
  createdAt: CREATED_AT,
  threads,
  ...overrides,
})

/** Seed `index.json` with a v1 document and return the exact bytes written. */
async function seedV1Index(store, threads, overrides = {}) {
  await mkdir(store.projectDir, { recursive: true })
  const text = JSON.stringify(v1Index(threads, overrides))
  await writeFile(store.indexFile, text, 'utf8')
  return text
}

/** One activity event with a deterministic id. */
const activityEvent = (id, overrides = {}) => ({
  eventId: `event-${id}`,
  time: CREATED_AT,
  type: 'topic-created',
  topicId: 'session-a',
  summary: `event ${id}`,
  details: {},
  ...overrides,
})

/** One inbox item. */
const inboxItem = (id, overrides = {}) => ({
  id,
  time: CREATED_AT,
  topicId: 'session-a',
  kind: 'merge-needed',
  summary: `merge ${id}`,
  deliveredAt: null,
  ...overrides,
})

/** The activity ids in a read result, oldest first. */
const eventIds = (result) => result.events.map((event) => event.eventId)

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

    // M7 writes v2 only; the returned `index` is the v1-shaped compatibility view.
    const onDisk = JSON.parse(await readFile(store.indexFile, 'utf8'))
    assert.deepEqual(onDisk, {
      version: 2,
      projectId: 'github.com-owner-repo',
      masterSessionId: 'session-master',
      createdAt: CREATED_AT,
      topics: [],
      workItems: [],
    })
    assert.equal('threads' in onDisk, false)
    assert.match(await readFile(store.indexFile, 'utf8'), /\n$/)
    assert.equal(await modeOf(store.indexFile), 0o600)
    assert.equal(await modeOf(store.projectDir), 0o700)
    assert.deepEqual(residue(await readdir(store.projectDir)), [])
  })
})

test('rebindMaster moves the master and keeps every other field of the project record', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({
      repoPath,
      clock: clockAt(CREATED_AT),
      projectId: 'github.com-owner-repo',
    })
    await store.initIndex('session-master')
    await store.addThread(thread({ threadId: 'session-thread', subject: 'keep me' }))
    const before = await store.readIndex()

    const rebound = await store.rebindMaster('session-new')
    assert.equal(rebound.masterSessionId, 'session-new')
    assert.equal(rebound.projectId, before.projectId)
    assert.equal(rebound.createdAt, before.createdAt)
    assert.deepEqual(rebound.threads, before.threads)

    const onDisk = JSON.parse(await readFile(store.indexFile, 'utf8'))
    assert.equal(onDisk.version, 2)
    assert.equal(onDisk.masterSessionId, 'session-new')
    assert.deepEqual(
      onDisk.topics.map((topic) => topic.topicId),
      rebound.threads.map((entry) => entry.threadId),
    )
    assert.equal('threads' in onDisk, false)
    assert.match(await readFile(store.indexFile, 'utf8'), /\n$/)
    assert.equal(await modeOf(store.indexFile), 0o600)
    assert.deepEqual(residue(await readdir(store.projectDir)), [])

    // The same id is a no-op that still returns the committed index.
    const again = await store.rebindMaster('session-new')
    assert.deepEqual(again, rebound)
  })
})

test('rebindMaster refuses a missing index without creating the project directory', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    await rejectsStore(store.rebindMaster('session-new'), 'store/not-found', store.indexFile)
    assert.equal(await store.hasIndex(), false)
    assert.deepEqual(await readdir(store.projectDir).catch(() => []), [])
    await rejectsStore(store.rebindMaster('   '), 'store/invalid', 'masterSessionId')
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
    // M3 review fields: a pre-M3 index has none of them, so every one reads null.
    for (const field of ['reviewStatus', 'reviewRequestedAt', 'reviewedAt', 'reviewerSessionId', 'latestReviewPath']) {
      assert.equal(index.threads[0][field], null, field)
      assert.equal(field in index.threads[0], true, `${field} is filled, not absent`)
    }

    // Neither field means "no checkout", not a corrupt index.
    const plain = { ...legacyThread, threadId: 'session-plain' }
    delete plain.worktreePath
    await writeFile(store.indexFile, indexFile([plain]), 'utf8')
    assert.equal((await store.readIndex()).threads[0].checkoutPath, null)

    // A rewrite emits checkoutPath only; the legacy name never comes back.
    await writeFile(store.indexFile, indexFile([legacyThread]), 'utf8')
    const updated = await store.updateThread('session-old', { status: 'active' })
    assert.equal(updated.threads[0].checkoutPath, '/legacy/wt')
    const onDisk = JSON.parse(await readFile(store.indexFile, 'utf8'))
    assert.equal(onDisk.version, 2)
    assert.equal(onDisk.topics[0].legacyCheckoutPath, '/legacy/wt')
    assert.equal('worktreePath' in onDisk.topics[0], false)
    assert.equal('threads' in onDisk, false)
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

// ---------------------------------------------------------------------------
// M3 reviews
// ---------------------------------------------------------------------------

test('reviewFileName stamps UTC with milliseconds, like a handoff', () => {
  assert.equal(
    reviewFileName('session-x', new Date('2026-11-05T03:04:05.006Z')),
    'session-x-20261105T030405006Z.json',
  )
  assert.equal(
    reviewFileName('session-x', new Date('2026-01-02T03:04:05.006+08:00')),
    'session-x-20260101T190405006Z.json',
  )
})

test('writeReview stores one file under reviews/ and refuses to overwrite it', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    const record = review()

    const written = await store.writeReview(record)

    assert.equal(written.fileName, reviewFileName(record.threadId, new Date(record.createdAt)))
    assert.equal(written.filePath, join(store.reviewsDir, written.fileName))
    assert.deepEqual(written.record, record)
    assert.deepEqual(await store.readReview(written.filePath), record)
    assert.equal(await modeOf(store.reviewsDir), 0o700)
    assert.equal(await modeOf(written.filePath), 0o600)
    assert.deepEqual(await store.listReviews(), [written])

    // A second verdict for the same thread and instant must not overwrite evidence.
    await rejectsStore(store.writeReview(record), 'store/review-exists', written.filePath)
    assert.deepEqual(await store.listReviews(), [written])
  })
})

test('listReviews orders by createdAt, then by file name', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    const newer = review({ createdAt: '2026-11-05T05:00:00.000Z', verdict: 'pass', findings: [] })
    const older = review({ createdAt: '2026-11-05T04:00:00.000Z' })

    // Written out of order on purpose: the listing sorts records, not writes.
    await store.writeReview(newer)
    await store.writeReview(older)

    const listed = await store.listReviews()
    assert.deepEqual(listed.map((file) => file.record.verdict), ['needs_revision', 'pass'])
    assert.deepEqual(listed.map((file) => file.record.createdAt), [older.createdAt, newer.createdAt])
    // An absent reviews directory is an empty list, not an error.
    assert.deepEqual(await new ProjectStore({ repoPath: join(repoPath, 'empty') }).listReviews(), [])
  })
})

test('writeReview rejects an invalid record without writing a file', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })

    await rejectsStore(store.writeReview(review({ findings: [] })), 'store/invalid-review', 'findings')
    await rejectsStore(store.writeReview(review({ verdict: 'pending' })), 'store/invalid-review', 'verdict')
    await rejectsStore(store.writeReview(review({ version: 2 })), 'store/invalid-review', 'version')
    await rejectsStore(store.writeReview(review({ createdAt: 'yesterday' })), 'store/invalid-review', 'createdAt')
    await rejectsStore(
      store.writeReview(review({ findings: [{ id: 'F1', severity: 'fatal', problem: 'x', requiredFix: 'y' }] })),
      'store/invalid-review',
      'severity',
    )

    assert.deepEqual(await store.listReviews(), [])
  })
})

test('a damaged review file is reported as store/corrupt, never skipped', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    const written = await store.writeReview(review())

    await writeFile(written.filePath, '{ not json', 'utf8')
    await rejectsStore(store.readReview(written.filePath), 'store/corrupt', written.filePath)
    await rejectsStore(store.listReviews(), 'store/corrupt', written.filePath)

    // Valid JSON that breaks the schema is corrupt too.
    await writeFile(written.filePath, JSON.stringify({ version: 1, threadId: 'session-a' }), 'utf8')
    await rejectsStore(store.readReview(written.filePath), 'store/corrupt', 'review.verdict')
  })
})

test('updateThread writes the M3 review fields and leaves the rest alone', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    await store.initIndex('session-master')
    const added = await store.addThread(thread())
    assert.equal(added.threads[0].reviewStatus, null)
    assert.equal(added.threads[0].reviewRequestedAt, null)
    assert.equal(added.threads[0].reviewedAt, null)
    assert.equal(added.threads[0].reviewerSessionId, null)
    assert.equal(added.threads[0].latestReviewPath, null)

    const record = review()
    const updated = await store.updateThread('session-a', {
      status: 'done',
      reviewStatus: 'needs_revision',
      reviewRequestedAt: '2026-11-05T03:00:00.000Z',
      reviewedAt: record.createdAt,
      reviewerSessionId: record.reviewerSessionId,
      latestReviewPath: '/repo/.dsh-cowork/reviews/session-a.json',
    })

    const updatedThread = updated.threads[0]
    assert.equal(updatedThread.status, 'done')
    assert.equal(updatedThread.reviewStatus, 'needs_revision')
    assert.equal(updatedThread.reviewRequestedAt, '2026-11-05T03:00:00.000Z')
    assert.equal(updatedThread.reviewedAt, record.createdAt)
    assert.equal(updatedThread.reviewerSessionId, 'session-reviewer')
    assert.equal(updatedThread.latestReviewPath, '/repo/.dsh-cowork/reviews/session-a.json')
    // The sparse-patch rule still holds: absent fields keep their stored value.
    assert.equal(updatedThread.createdAt, CREATED_AT)
    assert.equal(updatedThread.lastHandoffAt, null)

    // A bad review state is refused before the index is rewritten.
    await rejectsStore(
      store.updateThread('session-a', { reviewStatus: 'approved' }),
      'store/invalid',
      'reviewStatus',
    )
  })
})

test('latestReviews reports the newest review per thread and degrades unreadable files', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    const older = await store.writeReview(review({ createdAt: '2026-11-05T04:00:00.000Z' }))
    const newer = await store.writeReview(
      review({ createdAt: '2026-11-05T05:00:00.000Z', verdict: 'pass', findings: [] }),
    )
    const other = await store.writeReview(
      review({ threadId: 'session-b', createdAt: '2026-11-05T04:30:00.000Z', verdict: 'reject' }),
    )

    const threads = [
      { threadId: 'session-a', latestReviewPath: newer.filePath },
      { threadId: 'session-b', latestReviewPath: other.filePath },
      { threadId: 'session-missing', latestReviewPath: null },
    ]
    const rows = await store.latestReviews(threads)
    assert.deepEqual(rows, [
      {
        threadId: 'session-a',
        verdict: 'pass',
        summary: newer.record.summary,
        reviewedAt: newer.record.createdAt,
        filePath: newer.filePath,
      },
      {
        threadId: 'session-b',
        verdict: 'reject',
        summary: other.record.summary,
        reviewedAt: other.record.createdAt,
        filePath: other.filePath,
      },
    ])
    assert.equal(older.record.verdict, 'needs_revision')

    // A damaged review file must not fail the projection: the index pointer is used.
    await writeFile(newer.filePath, '{ nope', 'utf8')
    const degraded = await store.latestReviews(threads)
    assert.deepEqual(degraded.map((row) => row.threadId), ['session-b'])

    // A missing pointer and a missing file both mean "no review".
    const empty = await store.latestReviews([{ threadId: 'session-a', latestReviewPath: join(repoPath, 'gone.json') }])
    assert.deepEqual(empty, [])
  })
})


test('a v1 index is read as the compatibility view and never migrated by a read', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    const original = await seedV1Index(store, [
      thread({
        threadId: 'session-old',
        subject: 'legacy work',
        status: 'awaiting_review',
        checkoutPath: '/legacy/wt',
        lastHandoffAt: CREATED_AT,
        reviewStatus: 'pending',
        reviewRequestedAt: CREATED_AT,
        reviewedAt: null,
        reviewerSessionId: 'session-reviewer',
        latestReviewPath: '/repo/.dsh-cowork/reviews/session-old-1.json',
      }),
    ])
    const before = await stat(store.indexFile)

    const index = await store.readIndex()
    assert.equal(index.version, 1)
    assert.equal(index.threads[0].threadId, 'session-old')
    assert.equal(index.threads[0].subject, 'legacy work')
    assert.equal(index.threads[0].status, 'awaiting_review')
    assert.equal(index.threads[0].checkoutPath, '/legacy/wt')
    assert.equal(index.threads[0].reviewStatus, 'pending')
    assert.equal(index.threads[0].reviewerSessionId, 'session-reviewer')
    assert.equal(index.threads[0].reviewedAt, null)
    assert.equal(index.threads[0].latestReviewPath, '/repo/.dsh-cowork/reviews/session-old-1.json')

    // A read is not a write: same bytes, same mtime, no backup, no extra files.
    assert.equal(await readFile(store.indexFile, 'utf8'), original)
    assert.equal((await stat(store.indexFile)).mtimeMs, before.mtimeMs)
    assert.equal(existsSync(store.backupFile), false)
    assert.deepEqual((await readdir(store.projectDir)).sort(), ['index.json'])
    assert.equal(store.lastMigrationReport, null)
  })
})

test('the first write migrates a v1 index to v2 and writes the backup exactly once', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    const original = await seedV1Index(store, [thread({ threadId: 'session-a', status: 'active' })])

    const view = await store.updateThread('session-a', { subject: 'renamed' })
    assert.equal(view.version, 1)
    assert.equal(view.threads[0].subject, 'renamed')

    const onDisk = JSON.parse(await readFile(store.indexFile, 'utf8'))
    assert.equal(onDisk.version, 2)
    assert.deepEqual(onDisk.workItems, [])
    assert.equal('threads' in onDisk, false)
    assert.equal(onDisk.topics.length, 1)
    assert.equal(onDisk.topics[0].topicId, 'session-a')
    assert.equal(onDisk.topics[0].title, 'renamed')
    assert.equal(onDisk.topics[0].status, 'active')
    assert.equal(onDisk.topics[0].lastActiveAt, CREATED_AT)

    // The backup is the original v1 bytes, not the migrated document.
    assert.equal(await readFile(store.backupFile, 'utf8'), original)
    assert.equal(await modeOf(store.backupFile), 0o600)

    const report = store.lastMigrationReport
    assert.equal(report.migrated, true)
    assert.equal(report.fromVersion, 1)
    assert.equal(report.toVersion, 2)
    assert.deepEqual(report.statusCounts, {
      new: 0,
      active: 1,
      awaiting_review: 0,
      done: 0,
      blocked: 0,
      archived: 0,
    })
    assert.deepEqual(report.pendingReviewerArchives, [])
    assert.deepEqual(report.archiveFailures, [])

    // A second write must not replace or rewrite the first backup.
    const stamp = new Date('2020-01-01T00:00:00.000Z')
    await utimes(store.backupFile, stamp, stamp)
    const backupStamp = (await stat(store.backupFile)).mtimeMs
    await store.updateThread('session-a', { subject: 'renamed again' })
    assert.equal(await readFile(store.backupFile, 'utf8'), original)
    assert.equal((await stat(store.backupFile)).mtimeMs, backupStamp)
    assert.equal(JSON.parse(await readFile(store.indexFile, 'utf8')).topics[0].title, 'renamed again')
    assert.deepEqual(residue(await readdir(store.projectDir)), [])
  })
})

test('every v1 state migrates to its v2 topic and reads back through the view', async () => {
  await withTempDir(async (repoPath) => {
    const archived = []
    const store = new ProjectStore({
      repoPath,
      clock: clockAt(LATER_AT),
      projectId: 'p',
      async archiveSession(sessionId, options) {
        archived.push({ sessionId, options })
      },
    })
    await seedV1Index(store, [
      thread({ threadId: 'state-new', status: 'new' }),
      thread({ threadId: 'state-active', status: 'active' }),
      thread({
        threadId: 'state-review',
        status: 'awaiting_review',
        reviewStatus: 'pending',
        reviewerSessionId: 'session-reviewer',
      }),
      thread({ threadId: 'state-blocked', status: 'blocked' }),
      thread({ threadId: 'state-done', status: 'done', updatedAt: LATER_AT, reviewStatus: 'pass' }),
      thread({ threadId: 'state-archived', status: 'archived', updatedAt: LATER_AT }),
    ])

    await store.rebindMaster('session-other')

    const onDisk = JSON.parse(await readFile(store.indexFile, 'utf8'))
    const byId = new Map(onDisk.topics.map((topic) => [topic.topicId, topic]))
    assert.equal(byId.size, 6)
    assert.equal(byId.get('state-new').status, 'active')
    assert.equal(byId.get('state-new').legacyStatus, 'new')
    assert.equal(byId.get('state-active').status, 'active')
    assert.equal(byId.get('state-active').legacyStatus, undefined)

    const review = byId.get('state-review')
    assert.equal(review.status, 'active')
    assert.equal(review.awaitingReview, false)
    assert.equal(review.reviewStatus, null)
    assert.equal(review.reviewerSessionId, null)
    assert.equal(byId.get('state-blocked').blocked, true)

    for (const id of ['state-done', 'state-archived']) {
      const topic = byId.get(id)
      assert.equal(topic.status, 'resolved')
      assert.equal(topic.resolvedBy, 'master')
      assert.equal(topic.resolvedAt, LATER_AT)
      assert.equal(topic.lastDeliveryConfirmedAt, LATER_AT)
      assert.equal(topic.lastActiveAt, LATER_AT)
    }
    assert.equal(byId.get('state-archived').legacyStatus, 'archived')

    // The compatibility view restores the v1-only states and derives the rest.
    const view = await store.readIndex()
    assert.deepEqual(
      view.threads.map((entry) => [entry.threadId, entry.status]),
      [
        ['state-new', 'new'],
        ['state-active', 'active'],
        ['state-review', 'active'],
        ['state-blocked', 'blocked'],
        ['state-done', 'done'],
        ['state-archived', 'archived'],
      ],
    )

    // The reviewer of the cancelled review was archived, and the migration says so.
    assert.deepEqual(archived, [{ sessionId: 'session-reviewer', options: { stopActivity: true } }])
    const report = store.lastMigrationReport
    assert.deepEqual(report.pendingReviewerArchives, [
      { topicId: 'state-review', reviewerSessionId: 'session-reviewer' },
    ])
    assert.deepEqual(report.archiveFailures, [])

    const activity = await store.readActivity()
    assert.equal(activity.skippedLines, 0)
    const migration = activity.events.find((event) => event.summary.startsWith('migrated project index'))
    assert.deepEqual(migration.details.archivedReviewers, ['session-reviewer'])
    assert.equal(activity.events.some((event) => event.type === 'error'), false)
    assert.equal(await modeOf(store.activityFile), 0o600)
  })
})

test('an archive failure is recorded without letting the migration claim success', async () => {
  await withTempDir(async (repoPath) => {
    const throwingPort = async () => {
      throw new Error('host refused to archive')
    }
    const scenarios = [
      { name: 'throwing port', port: throwingPort, message: /host refused to archive/ },
      { name: 'no port', port: undefined, message: /no archiveSession port/ },
    ]
    for (const [index, scenario] of scenarios.entries()) {
      const store = new ProjectStore({
        repoPath: join(repoPath, `case-${index}`),
        clock: clockAt(CREATED_AT),
        projectId: 'p',
        archiveSession: scenario.port,
      })
      await seedV1Index(store, [
        thread({
          threadId: 'session-review',
          status: 'awaiting_review',
          reviewStatus: 'pending',
          reviewerSessionId: 'session-reviewer',
        }),
      ])

      await store.updateThread('session-review', { subject: 'still migrates' })
      const onDisk = JSON.parse(await readFile(store.indexFile, 'utf8'))
      assert.equal(onDisk.version, 2, scenario.name)
      assert.equal('threads' in onDisk, false, scenario.name)
      assert.equal(onDisk.topics[0].reviewerSessionId, null, scenario.name)
      assert.equal(onDisk.topics[0].awaitingReview, false, scenario.name)

      const report = store.lastMigrationReport
      assert.equal(report.archiveFailures.length, 1, scenario.name)
      assert.equal(report.archiveFailures[0].topicId, 'session-review', scenario.name)
      assert.equal(report.archiveFailures[0].reviewerSessionId, 'session-reviewer', scenario.name)
      assert.match(report.archiveFailures[0].message, scenario.message)

      const activity = await store.readActivity()
      const error = activity.events.find((event) => event.type === 'error')
      assert.ok(error, `${scenario.name}: the failure must be visible in the activity stream`)
      assert.match(error.summary, /could not archive reviewer session-reviewer/)
      assert.equal(error.details.reviewerSessionId, 'session-reviewer', scenario.name)
      const migration = activity.events.find((event) => event.summary.startsWith('migrated project index'))
      assert.deepEqual(migration.details.archivedReviewers, [], scenario.name)
    }
  })
})

test('an unknown v1 status fails closed without touching the index', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    const original = await seedV1Index(store, [thread({ status: 'flying' })])
    const before = await stat(store.indexFile)

    await rejectsStore(store.readIndex(), 'store/corrupt', store.indexFile)
    await rejectsStore(store.updateThread('session-a', { subject: 'x' }), 'store/corrupt', store.indexFile)

    assert.equal(await readFile(store.indexFile, 'utf8'), original)
    assert.equal((await stat(store.indexFile)).mtimeMs, before.mtimeMs)
    assert.equal(existsSync(store.backupFile), false)
    assert.equal(existsSync(store.activityFile), false)
    assert.deepEqual((await readdir(store.projectDir)).sort(), ['index.json'])
    assert.equal(store.lastMigrationReport, null)

    // A v2 document that does not validate is refused on the write path too.
    const damagedV2 = JSON.stringify({ version: 2, projectId: 'p', topics: 'nope' })
    await writeFile(store.indexFile, damagedV2, 'utf8')
    await rejectsStore(store.updateThread('session-a', { subject: 'x' }), 'store/corrupt', store.indexFile)
    assert.equal(await readFile(store.indexFile, 'utf8'), damagedV2)
    assert.equal(existsSync(store.backupFile), false)
  })
})

test('a v2 index round-trips through the view without changing its bytes', async () => {
  await withTempDir(async (repoPath) => {
    let now = CREATED_AT
    const store = new ProjectStore({ repoPath, clock: () => new Date(now), projectId: 'p' })
    await store.initIndex('session-master')
    await store.addThread(thread({ threadId: 'session-a', status: 'new' }))
    await store.addThread(thread({ threadId: 'session-b', status: 'active', checkoutPath: '/repo/wt' }))

    const before = await store.readIndex()
    const bytes = await readFile(store.indexFile, 'utf8')
    assert.equal('threads' in JSON.parse(bytes), false)
    now = LATER_AT
    await store.mutateIndex((index) => index)
    assert.equal(await readFile(store.indexFile, 'utf8'), bytes)
    await store.mutateIndex((index) => index)
    assert.equal(await readFile(store.indexFile, 'utf8'), bytes)
    assert.deepEqual(await store.readIndex(), before)
    assert.equal(store.lastMigrationReport, null)
  })
})

test('a legacy rollback that filters a thread deletes its topic', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    await store.initIndex('session-master')
    await store.addThread(thread({ threadId: 'session-a' }))
    await store.addThread(thread({ threadId: 'session-b' }))

    // src/tools.ts:386-390 rolls a failed thread creation back this way.
    const view = await store.mutateIndex((index) => ({
      ...index,
      threads: index.threads.filter((entry) => entry.threadId !== 'session-b'),
    }))
    assert.deepEqual(view.threads.map((entry) => entry.threadId), ['session-a'])

    const onDisk = JSON.parse(await readFile(store.indexFile, 'utf8'))
    assert.deepEqual(onDisk.topics.map((topic) => topic.topicId), ['session-a'])
    assert.deepEqual(onDisk.workItems, [])
    assert.deepEqual((await store.readIndex()).threads.map((entry) => entry.threadId), ['session-a'])
  })
})

test('activity appends JSON Lines and reads back the tail', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    assert.deepEqual(await store.readActivity(), { events: [], skippedLines: 0 })

    await store.appendActivity(activityEvent('one'))
    await store.appendActivity(activityEvent('two'))
    await store.appendActivity(activityEvent('three'))

    const tail = await store.readActivity(2)
    assert.deepEqual(eventIds(tail), ['event-two', 'event-three'])
    assert.equal(tail.skippedLines, 0)
    assert.deepEqual(eventIds(await store.readActivity()), ['event-one', 'event-two', 'event-three'])
    assert.equal(await modeOf(store.activityFile), 0o600)
    assert.equal(await modeOf(store.projectDir), 0o700)
    assert.match(await readFile(store.activityFile, 'utf8'), /\n$/)
    assert.deepEqual(residue(await readdir(store.projectDir)), [])
  })
})

test('activity keeps the newest 500 events', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    await mkdir(store.projectDir, { recursive: true })
    const seeded = Array.from({ length: 500 }, (_, index) => JSON.stringify(activityEvent(`old-${index}`)))
    await writeFile(store.activityFile, `${seeded.join('\n')}\n`, 'utf8')

    await store.appendActivity(activityEvent('new'))
    const { events, skippedLines } = await store.readActivity(1000)
    assert.equal(skippedLines, 0)
    assert.equal(events.length, 500)
    assert.equal(events[0].eventId, 'event-old-1')
    assert.equal(events[events.length - 1].eventId, 'event-new')
  })
})

test('activity trims by serialized bytes as well as by count', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    await mkdir(store.projectDir, { recursive: true })
    const big = (id) => JSON.stringify(activityEvent(id, { summary: 'x'.repeat(300000) }))
    await writeFile(store.activityFile, `${big('big-1')}\n${big('big-2')}\n`, 'utf8')

    await store.appendActivity(activityEvent('small'))
    const size = (await stat(store.activityFile)).size
    assert.ok(size <= 524288, `activity file is ${size} bytes`)
    const { events } = await store.readActivity(10)
    assert.deepEqual(eventIds({ events }), ['event-big-2', 'event-small'])
  })
})

test('activity skips damaged lines and repairs the stream on the next append', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    await mkdir(store.projectDir, { recursive: true })
    const badType = JSON.stringify(activityEvent('bad', { type: 'not-a-type' }))
    const lines = [JSON.stringify(activityEvent('one')), 'not json', badType, JSON.stringify(activityEvent('two'))]
    await writeFile(store.activityFile, `${lines.join('\n')}\n`, 'utf8')

    const damaged = await store.readActivity()
    assert.deepEqual(eventIds(damaged), ['event-one', 'event-two'])
    assert.equal(damaged.skippedLines, 2)

    await store.appendActivity(activityEvent('three'))
    const repaired = await store.readActivity()
    assert.deepEqual(eventIds(repaired), ['event-one', 'event-two', 'event-three'])
    assert.equal(repaired.skippedLines, 0)
  })
})

test('concurrent activity appends lose nothing', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    const ids = Array.from({ length: 24 }, (_, index) => `concurrent-${index}`)
    await Promise.all(ids.map((id) => store.appendActivity(activityEvent(id))))

    const { events, skippedLines } = await store.readActivity(100)
    assert.equal(skippedLines, 0)
    assert.deepEqual(
      events.map((event) => event.eventId).sort(),
      ids.map((id) => `event-${id}`).sort(),
    )
    assert.deepEqual(residue(await readdir(store.projectDir)), [])
  })
})

test('appendActivity rejects an invalid event without creating the stream', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    await rejectsStore(
      store.appendActivity(activityEvent('bad', { type: 'unknown-event' })),
      'store/invalid-activity',
      'activity.type',
    )
    assert.equal(existsSync(store.activityFile), false)
  })
})

test('inbox writes, reads, and keeps the newest 50 items', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    assert.deepEqual(await store.readInbox(), [])

    const first = await store.writeInbox([inboxItem('a'), inboxItem('b'), inboxItem('c')])
    assert.deepEqual(first.map((item) => item.id), ['a', 'b', 'c'])
    assert.deepEqual(await store.readInbox(), first)
    assert.equal(await modeOf(store.inboxFile), 0o600)
    assert.match(await readFile(store.inboxFile, 'utf8'), /\n$/)

    const many = Array.from({ length: 55 }, (_, index) => inboxItem(`item-${index}`))
    const kept = await store.writeInbox(many)
    assert.equal(kept.length, 50)
    assert.equal(kept[0].id, 'item-5')
    assert.equal(kept[49].id, 'item-54')
    assert.deepEqual((await store.readInbox()).map((item) => item.id), kept.map((item) => item.id))
    assert.deepEqual(residue(await readdir(store.projectDir)), [])
  })
})

test('inbox damage fails closed and invalid items are refused before writing', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    await mkdir(store.projectDir, { recursive: true })

    await writeFile(store.inboxFile, '{ not json', 'utf8')
    await rejectsStore(store.readInbox(), 'store/corrupt', store.inboxFile)

    await writeFile(store.inboxFile, JSON.stringify([inboxItem('a'), { ...inboxItem('b'), kind: 'nope' }]), 'utf8')
    await rejectsStore(store.readInbox(), 'store/corrupt', 'inbox[1].kind')

    await store.writeInbox([])
    const empty = await readFile(store.inboxFile, 'utf8')
    await rejectsStore(store.writeInbox([inboxItem('a', { kind: 'needs-attention' })]), 'store/invalid-inbox', 'inbox[0].kind')
    assert.equal(await readFile(store.inboxFile, 'utf8'), empty)
  })
})
