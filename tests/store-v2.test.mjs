import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { register } from 'node:module'

/**
 * M7 contract tests for the v2 project store: the on-disk v1 → v2 migration
 * transaction (backup, reviewer archiving, fail-closed paths), the v1
 * compatibility view over v2, and the activity/inbox file I/O. Pure file-system
 * cases run on a throwaway repository under os.tmpdir().
 *
 * `src/store.ts` value-imports `./store-schema.js` and `./store-migration.js`,
 * and Node's type stripping does not retry a `.js` sibling as `.ts`; this is the
 * same resolve hook tests/review-verdict.test.mjs uses.
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

const { ProjectStore, StoreError } = await import('../src/store.ts')
const { legacyViewOf } = await import('../src/store-migration.ts')

const CREATED_AT = '2026-11-05T03:04:05.006Z'

/** Run one case inside a throwaway directory that is always removed. */
async function withTempDir(run) {
  const path = await mkdtemp(join(tmpdir(), 'dsh-cowork-store-v2-'))
  try {
    return await run(path)
  } finally {
    await rm(path, { recursive: true, force: true })
  }
}

/** A clock frozen at one instant. */
const clockAt = (iso) => () => new Date(iso)

/** A v1 thread record with the given overrides. */
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

/** A v2 topic with every field the canonical document requires. */
const topicV2 = (overrides = {}) => ({
  topicId: 'session-a',
  title: 'canonical work',
  status: 'active',
  awaitingReview: false,
  blocked: false,
  scope: '',
  ownedPaths: [],
  aliases: [],
  digest: '',
  cwd: '/repo',
  legacyCheckoutPath: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  lastActiveAt: CREATED_AT,
  lastDeliveryConfirmedAt: null,
  resolvedAt: null,
  resolvedBy: null,
  latestReviewRequestId: null,
  reviewStatus: null,
  reviewerSessionId: null,
  lastHandoffAt: null,
  reviewRequestedAt: null,
  reviewedAt: null,
  latestReviewPath: null,
  ...overrides,
})

/** A v2 index document with the given topics. */
const v2Index = (topics = [topicV2()], overrides = {}) => ({
  version: 2,
  projectId: 'p',
  masterSessionId: 'session-master',
  createdAt: CREATED_AT,
  topics,
  workItems: [],
  ...overrides,
})

/** Seed `index.json` with a v2 document and return the exact bytes written. */
async function seedV2Index(store, topics, overrides = {}) {
  await mkdir(store.projectDir, { recursive: true })
  const text = JSON.stringify(v2Index(topics, overrides))
  await writeFile(store.indexFile, text, 'utf8')
  return text
}

test('readIndexDocument projects a v1 index without writing the migration', async () => {
  await withTempDir(async (repoPath) => {
    const archived = []
    const store = new ProjectStore({
      repoPath,
      clock: clockAt(CREATED_AT),
      projectId: 'p',
      async archiveSession(sessionId, options) {
        archived.push({ sessionId, options })
      },
    })
    const original = await seedV1Index(store, [
      thread({
        status: 'awaiting_review',
        reviewStatus: 'pending',
        reviewRequestedAt: CREATED_AT,
        reviewerSessionId: 'session-reviewer',
        latestReviewPath: '/repo/.dsh-cowork/reviews/session-a-1.json',
      }),
    ])
    const stamp = new Date('2020-01-01T00:00:00.000Z')
    await utimes(store.indexFile, stamp, stamp)
    const before = (await stat(store.indexFile)).mtimeMs

    const document = await store.readIndexDocument()
    assert.equal(document.version, 2)
    assert.equal('threads' in document, false)
    const topic = document.topics[0]
    assert.equal(topic.topicId, 'session-a')
    assert.equal(topic.status, 'active')
    assert.equal(topic.awaitingReview, true)
    assert.equal(topic.reviewStatus, 'pending')
    assert.equal(topic.reviewerSessionId, 'session-reviewer')
    assert.equal(topic.reviewRequestedAt, CREATED_AT)

    // A read is not a write: no bytes, mtime, backup, archive, or migration report.
    assert.equal(await readFile(store.indexFile, 'utf8'), original)
    assert.equal((await stat(store.indexFile)).mtimeMs, before)
    assert.equal(existsSync(store.backupFile), false)
    assert.deepEqual(archived, [])
    assert.equal(store.lastMigrationReport, null)
    assert.deepEqual(residue(await readdir(store.projectDir)), [])
  })
})

test('readIndex matches the read-only document projection on v1 and v2', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    await seedV1Index(store, [
      thread({
        threadId: 'session-review',
        status: 'awaiting_review',
        reviewStatus: 'pending',
        reviewRequestedAt: CREATED_AT,
        reviewerSessionId: 'session-reviewer',
      }),
      thread({ threadId: 'session-new', status: 'new' }),
      thread({ threadId: 'session-done', status: 'done', updatedAt: LATER_AT, reviewStatus: 'pass' }),
    ])

    const view = await store.readIndex()
    assert.deepEqual(view, legacyViewOf(await store.readIndexDocument()))
    assert.deepEqual(
      view.threads.map((entry) => [entry.threadId, entry.status]),
      [
        ['session-review', 'awaiting_review'],
        ['session-new', 'new'],
        ['session-done', 'done'],
      ],
    )
    assert.equal(view.threads[0].reviewStatus, 'pending')
    assert.equal(view.threads[0].reviewerSessionId, 'session-reviewer')

    await seedV2Index(store, [
      topicV2({ topicId: 'session-resolved', status: 'resolved', resolvedAt: LATER_AT, resolvedBy: 'master' }),
      topicV2({ topicId: 'session-review', awaitingReview: true, reviewStatus: 'pending' }),
    ])
    const v2View = await store.readIndex()
    assert.deepEqual(v2View, legacyViewOf(await store.readIndexDocument()))
    assert.deepEqual(
      v2View.threads.map((entry) => [entry.threadId, entry.status]),
      [
        ['session-resolved', 'done'],
        ['session-review', 'awaiting_review'],
      ],
    )
  })
})

test('readIndexDocument returns a validated v2 document as is', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    const topics = [
      topicV2({ topicId: 'topic-a', digest: 'first' }),
      topicV2({ topicId: 'topic-b', status: 'idle', lastActiveAt: LATER_AT }),
    ]
    await seedV2Index(store, topics)

    const document = await store.readIndexDocument()
    assert.deepEqual(document, v2Index(topics))
  })
})

test('readIndexDocument fails closed when a v1 extension collides with a v2 field', async () => {
  await withTempDir(async (repoPath) => {
    const archived = []
    const store = new ProjectStore({
      repoPath,
      clock: clockAt(CREATED_AT),
      projectId: 'p',
      async archiveSession(sessionId, options) {
        archived.push({ sessionId, options })
      },
    })
    // v1 validation tolerates unknown thread fields; this one shadows `digest`.
    const original = await seedV1Index(store, [thread({ digest: 123 })])
    const before = await stat(store.indexFile)

    await rejectsStore(store.readIndexDocument(), 'store/corrupt', 'projected project index is invalid')
    await rejectsStore(store.readIndex(), 'store/corrupt', store.indexFile)

    assert.equal(await readFile(store.indexFile, 'utf8'), original)
    assert.equal((await stat(store.indexFile)).mtimeMs, before.mtimeMs)
    assert.equal(existsSync(store.backupFile), false)
    assert.deepEqual(archived, [])
  })
})

test('a non-colliding v1 extension still projects and survives on the topic', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    await seedV1Index(store, [thread({ 'x-note': 'keep' })])

    const document = await store.readIndexDocument()
    assert.equal(document.topics[0]['x-note'], 'keep')
    assert.equal(document.topics[0].digest, '', 'the v2 default is not shadowed')

    // The compatibility view is unchanged; dropping the extension there is the
    // known, accepted difference between the two read shapes.
    const view = await store.readIndex()
    assert.equal(view.threads[0].status, 'new')
  })
})

test('mutateIndexDocument reads under the lock and writes a validated v2 document', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    await seedV2Index(store, [topicV2()])
    let seen = null

    const next = await store.mutateIndexDocument((document) => {
      seen = document
      return {
        ...document,
        topics: document.topics.map((topic) => ({ ...topic, status: 'idle', updatedAt: LATER_AT })),
      }
    })

    assert.equal(seen.version, 2, 'the mutator receives the canonical document')
    assert.equal(next.topics[0].status, 'idle')
    assert.deepEqual(JSON.parse(await readFile(store.indexFile, 'utf8')), next)
    assert.deepEqual(residue(await readdir(store.projectDir)), [])
  })
})

test('mutateIndexDocument returning null writes nothing', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    const original = await seedV2Index(store, [topicV2()])
    const stamp = new Date('2020-01-01T00:00:00.000Z')
    await utimes(store.indexFile, stamp, stamp)
    const before = (await stat(store.indexFile)).mtimeMs

    const document = await store.mutateIndexDocument(() => null)

    assert.deepEqual(document, v2Index())
    assert.equal(await readFile(store.indexFile, 'utf8'), original)
    assert.equal((await stat(store.indexFile)).mtimeMs, before)
    assert.equal(existsSync(store.backupFile), false)
    assert.deepEqual(residue(await readdir(store.projectDir)), [])
  })
})

test('the first mutateIndexDocument write migrates a v1 index for real', async () => {
  await withTempDir(async (repoPath) => {
    const archived = []
    const store = new ProjectStore({
      repoPath,
      clock: clockAt(CREATED_AT),
      projectId: 'p',
      async archiveSession(sessionId, options) {
        archived.push({ sessionId, options })
      },
    })
    const original = await seedV1Index(store, [
      thread({
        status: 'awaiting_review',
        reviewStatus: 'pending',
        reviewRequestedAt: CREATED_AT,
        reviewerSessionId: 'session-reviewer',
      }),
    ])

    const next = await store.mutateIndexDocument((document) => ({
      ...document,
      topics: document.topics.map((topic) => ({ ...topic, digest: 'first write' })),
    }))

    const onDisk = JSON.parse(await readFile(store.indexFile, 'utf8'))
    assert.equal(onDisk.version, 2)
    assert.equal(onDisk.topics[0].awaitingReview, false)
    assert.equal(onDisk.topics[0].reviewStatus, null)
    assert.equal(onDisk.topics[0].digest, 'first write')
    assert.deepEqual(next, onDisk)
    assert.equal(await readFile(store.backupFile, 'utf8'), original)
    assert.deepEqual(archived, [{ sessionId: 'session-reviewer', options: { stopActivity: true } }])
    assert.deepEqual(store.lastMigrationReport.pendingReviewerArchives, [
      { topicId: 'session-a', reviewerSessionId: 'session-reviewer' },
    ])
  })
})

test('the canonical read and write fail closed on a damaged index', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    await mkdir(store.projectDir, { recursive: true })
    await writeFile(store.indexFile, '{ not json', 'utf8')

    await rejectsStore(store.readIndexDocument(), 'store/corrupt', store.indexFile)
    await rejectsStore(store.mutateIndexDocument((document) => document), 'store/corrupt', store.indexFile)

    assert.equal(await readFile(store.indexFile, 'utf8'), '{ not json')
    assert.equal(existsSync(store.backupFile), false)
  })
})

test('a missing index is not-found for the canonical read and write', async () => {
  await withTempDir(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })

    await rejectsStore(store.readIndexDocument(), 'store/not-found', store.indexFile)
    await rejectsStore(store.mutateIndexDocument((document) => document), 'store/not-found', store.indexFile)
    assert.equal(existsSync(store.indexFile), false)
  })
})
