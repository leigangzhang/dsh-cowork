import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import './support/ts-hook.mjs'
/**
 * M8.3 contract tests for the master inbox (A6): enqueue validates before it
 * writes, delivery merges at most 5 summaries per message, success stamps
 * `deliveredAt`, a failed delivery keeps the items for replay, and the store's
 * 50-item cap keeps the newest items. Cases run against a real ProjectStore
 * under os.tmpdir(); only the prompt port is a fake.
 */

const { ProjectStore } = await import('../src/store/project-store.ts')
const { Inbox, INBOX_MAX_BATCH, INBOX_MARK_ATTEMPTS, INBOX_SUMMARY_MAX_CHARS, InboxMarkError } =
  await import('../src/store/inbox.ts')

const CREATED_AT = '2026-11-05T03:04:05.006Z'

/** Run one case inside a throwaway directory that is always removed. */
async function withTempDir(run) {
  const path = await mkdtemp(join(tmpdir(), 'dsh-cowork-inbox-'))
  try {
    return await run(path)
  } finally {
    await rm(path, { recursive: true, force: true })
  }
}

/** A clock frozen at one instant. */
const clockAt = (iso) => () => new Date(iso)

/** A real file-layer store plus an inbox whose prompt port is the fake. */
function makeInbox(repoPath, deliver) {
  const store = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
  const calls = []
  const inbox = new Inbox({
    store,
    clock: clockAt(CREATED_AT),
    async deliver(message) {
      calls.push(message)
      return deliver(message, calls.length)
    },
  })
  return { store, inbox, calls }
}

/** `count` distinct blocked events. */
const events = (count) =>
  Array.from({ length: count }, (_, index) => ({
    topicId: 'session-a',
    kind: 'blocked',
    summary: `event ${index}`,
  }))

test('enqueue appends undelivered items and returns the stored list', async () => {
  await withTempDir(async (repoPath) => {
    const { store, inbox } = makeInbox(repoPath, async () => {})

    const stored = await inbox.enqueue([
      { topicId: 'session-a', kind: 'merge-needed', summary: 'merge A' },
      { topicId: 'session-b', kind: 'blocked', summary: 'blocked B' },
    ])

    assert.equal(stored.length, 2)
    for (const item of stored) {
      assert.match(item.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      assert.equal(item.time, CREATED_AT)
      assert.equal(item.deliveredAt, null)
    }
    assert.deepEqual(
      stored.map((item) => [item.topicId, item.kind, item.summary]),
      [
        ['session-a', 'merge-needed', 'merge A'],
        ['session-b', 'blocked', 'blocked B'],
      ],
    )
    assert.deepEqual(await store.readInbox(), stored)
  })
})

test('enqueue rejects an unknown kind, an empty summary, or an over-long summary', async () => {
  await withTempDir(async (repoPath) => {
    const { store, inbox } = makeInbox(repoPath, async () => {})
    const valid = { topicId: 'session-a', kind: 'blocked', summary: 'fine' }
    const cases = [
      [{ ...valid, kind: 'needs-attention' }, /inbox\.kind must be one of/],
      [{ ...valid, summary: '   ' }, /inbox\.summary must be a non-empty string/],
      [
        { ...valid, summary: 'x'.repeat(INBOX_SUMMARY_MAX_CHARS + 1) },
        /inbox\.summary must be at most 200 characters \(got 201\)/,
      ],
      [{ ...valid, topicId: '' }, /inbox\.topicId must be a non-empty string/],
    ]

    for (const [event, pattern] of cases) {
      await assert.rejects(inbox.enqueue([event]), pattern)
    }
    assert.equal(existsSync(store.inboxFile), false, 'a rejected event writes nothing')

    // Exactly the limit is accepted; nothing is silently truncated.
    const limit = 'y'.repeat(INBOX_SUMMARY_MAX_CHARS)
    const stored = await inbox.enqueue([{ ...valid, summary: limit }])
    assert.equal(stored[0].summary, limit)
  })
})

test('flush merges at most 5 items per message and stamps every delivery', async () => {
  await withTempDir(async (repoPath) => {
    const { store, inbox, calls } = makeInbox(repoPath, async () => {})
    await inbox.enqueue(events(12))

    const result = await inbox.flush()

    assert.deepEqual(result, { delivered: 12, failed: 0 })
    assert.equal(calls.length, 3)
    assert.deepEqual(
      calls.map((message) => message.split('\n').length),
      [INBOX_MAX_BATCH, INBOX_MAX_BATCH, 2],
    )
    assert.equal(calls[0].split('\n')[0], '[blocked] event 0')
    assert.equal(calls[2].split('\n')[1], '[blocked] event 11')

    const stored = await store.readInbox()
    assert.equal(stored.length, 12)
    assert.deepEqual(
      stored.map((item) => item.deliveredAt),
      Array.from({ length: 12 }, () => CREATED_AT),
    )

    // A second pass has nothing left: no prompt, no write, no duplicate item.
    const before = stored.length
    assert.deepEqual(await inbox.flush(), { delivered: 0, failed: 0 })
    assert.equal(calls.length, 3)
    assert.equal((await store.readInbox()).length, before)
  })
})

test('a failed delivery keeps every item and replay delivers it later', async () => {
  await withTempDir(async (repoPath) => {
    let failing = true
    const { store, inbox, calls } = makeInbox(repoPath, async () => {
      if (failing) throw new Error('prompt port unavailable')
    })
    await inbox.enqueue(events(3))

    assert.deepEqual(await inbox.flush(), { delivered: 0, failed: 3 })
    assert.equal(calls.length, 1, 'the pass stops on the first failure')
    assert.deepEqual(
      (await store.readInbox()).map((item) => item.deliveredAt),
      [null, null, null],
      'nothing is marked delivered',
    )

    failing = false
    assert.deepEqual(await inbox.replay(), { delivered: 3, failed: 0 })
    assert.equal(calls.length, 2)
    assert.deepEqual(
      (await store.readInbox()).map((item) => item.deliveredAt),
      [CREATED_AT, CREATED_AT, CREATED_AT],
    )
  })
})

test('a failure in a later batch keeps only the undelivered tail', async () => {
  await withTempDir(async (repoPath) => {
    let attempts = 0
    const { store, inbox, calls } = makeInbox(repoPath, async () => {
      attempts += 1
      if (attempts === 2) throw new Error('second batch failed')
    })
    await inbox.enqueue(events(7))

    assert.deepEqual(await inbox.flush(), { delivered: 5, failed: 2 })
    assert.equal(calls.length, 2, 'the attempted batch counts as one call')
    const stored = await store.readInbox()
    assert.deepEqual(
      stored.map((item) => item.deliveredAt === null),
      [false, false, false, false, false, true, true],
      'the first batch is committed, the failed batch and its tail are not',
    )

    attempts = 0
    assert.deepEqual(await inbox.replay(), { delivered: 2, failed: 0 })
    assert.equal(calls.length, 3)
    assert.deepEqual(
      (await store.readInbox()).map((item) => item.deliveredAt),
      Array.from({ length: 7 }, () => CREATED_AT),
    )
  })
})

test('a transient deliveredAt write failure is retried without delivering twice', async () => {
  await withTempDir(async (repoPath) => {
    const base = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    const seeder = new Inbox({ store: base, clock: clockAt(CREATED_AT), deliver: async () => {} })
    await seeder.enqueue(events(3))

    let failures = 2
    let writes = 0
    const store = {
      readInbox: () => base.readInbox(),
      async writeInbox(items) {
        writes += 1
        if (failures > 0) {
          failures -= 1
          throw new Error('inbox write unavailable')
        }
        return base.writeInbox(items)
      },
    }
    const calls = []
    const inbox = new Inbox({
      store,
      clock: clockAt(CREATED_AT),
      async deliver(message) { calls.push(message) },
    })

    assert.deepEqual(await inbox.flush(), { delivered: 3, failed: 0 })
    assert.equal(calls.length, 1, 'the batch is delivered exactly once')
    assert.equal(writes, INBOX_MARK_ATTEMPTS, 'two failures then one success')
    assert.deepEqual(
      (await base.readInbox()).map((item) => item.deliveredAt),
      [CREATED_AT, CREATED_AT, CREATED_AT],
      'the transient failure never leaves the batch unmarked',
    )

    // The next replay has nothing left, so the port is not called again.
    assert.deepEqual(await inbox.replay(), { delivered: 0, failed: 0 })
    assert.equal(calls.length, 1)
  })
})

test('a persistent deliveredAt write failure throws InboxMarkError and keeps the items', async () => {
  await withTempDir(async (repoPath) => {
    const base = new ProjectStore({ repoPath, clock: clockAt(CREATED_AT), projectId: 'p' })
    const seeder = new Inbox({ store: base, clock: clockAt(CREATED_AT), deliver: async () => {} })
    await seeder.enqueue(events(7))

    // The first batch is marked; every mark attempt after it fails.
    let writes = 0
    const store = {
      readInbox: () => base.readInbox(),
      async writeInbox(items) {
        writes += 1
        if (writes >= 2) throw new Error('inbox write unavailable')
        return base.writeInbox(items)
      },
    }
    const calls = []
    const inbox = new Inbox({
      store,
      clock: clockAt(CREATED_AT),
      async deliver(message) { calls.push(message) },
    })

    let error = null
    try {
      await inbox.flush()
    } catch (caught) {
      error = caught
    }
    assert.ok(error instanceof InboxMarkError, 'a named error reports the lost mark')
    assert.equal(error.delivered, INBOX_MAX_BATCH, 'only the committed batch is counted as delivered')
    assert.equal(error.pendingIds.length, 2, 'the unmarked batch keeps its ids for replay')
    assert.equal(calls.length, 2)
    assert.equal(writes, 1 + INBOX_MARK_ATTEMPTS, 'the failed mark is retried a bounded number of times')

    const stored = await base.readInbox()
    assert.deepEqual(
      stored.map((item) => item.deliveredAt === null),
      [false, false, false, false, false, true, true],
      'the failed batch and its tail stay undelivered; no event is lost',
    )
  })
})

test('the store keeps the newest 50 items', async () => {
  await withTempDir(async (repoPath) => {
    const { store, inbox } = makeInbox(repoPath, async () => {})
    const stored = await inbox.enqueue(events(55))

    assert.equal(stored.length, 50, 'enqueue returns what the store kept')
    const read = await store.readInbox()
    assert.equal(read.length, 50)
    assert.equal(read[0].summary, 'event 5', 'the oldest items are dropped')
    assert.equal(read.at(-1).summary, 'event 54', 'the newest item survives')
  })
})

test('an empty inbox makes flush and replay a no-op', async () => {
  await withTempDir(async (repoPath) => {
    const { store, inbox, calls } = makeInbox(repoPath, async () => {})

    assert.deepEqual(await inbox.flush(), { delivered: 0, failed: 0 })
    assert.deepEqual(await inbox.replay(), { delivered: 0, failed: 0 })
    assert.equal(calls.length, 0)
    assert.equal(existsSync(store.inboxFile), false, 'nothing is created for an empty inbox')
  })
})
