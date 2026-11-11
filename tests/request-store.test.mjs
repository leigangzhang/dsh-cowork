import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import './support/ts-hook.mjs'
import { withRepo } from './support/inbox-fixtures.mjs'

// `src/request-store.ts` imports its siblings with the build's `.js`
// specifiers; the shared hook makes them importable here.
const { INBOX_MAX_REQUEST_FILES, REQUEST_RECORD_VERSION } = await import('../src/inbox-contract.ts')
const { RequestStore } = await import('../src/request-store.ts')
const { applyResolution, buildRequestRecord } = await import('../src/request-schema.ts')

const NOW = new Date('2026-11-10T09:00:00.000Z')

/** One valid pending record for `requestId`. */
function record(requestId, overrides = {}) {
  return buildRequestRecord({
    requestId,
    projectId: 'example.com/acme/repo',
    topicId: 'topic-1',
    kind: 'user-review',
    title: 'Inbox backend',
    payload: { purpose: 'review the records' },
    now: NOW,
    ...overrides,
  })
}


test('create writes one 0600 file in a 0700 requests directory', async () => {
  await withRepo(async (repoPath) => {
    const store = new RequestStore({ repoPath })
    await store.create(record('req-1'))

    const dirInfo = await stat(store.requestsDir)
    assert.equal(dirInfo.mode & 0o777, 0o700)
    const fileInfo = await stat(join(store.requestsDir, 'req-1.json'))
    assert.equal(fileInfo.mode & 0o777, 0o600)

    const text = await readFile(join(store.requestsDir, 'req-1.json'), 'utf8')
    const parsed = JSON.parse(text)
    assert.equal(parsed.version, REQUEST_RECORD_VERSION)
    assert.equal(parsed.requestId, 'req-1')
    assert.equal(parsed.status, 'pending')
    assert.equal(store.lockFile, join(repoPath, '.dsh-cowork', '.write.lock'), 'the project lock is shared')
  })
})

test('create refuses an invalid record before touching the disk', async () => {
  await withRepo(async (repoPath) => {
    const store = new RequestStore({ repoPath })
    const invalid = { ...record('req-1'), status: 'passed' }
    await assert.rejects(store.create(invalid), /invalid/)
    await assert.rejects(readdir(store.requestsDir), /ENOENT/)
  })
})

test('readAll sorts newest updatedAt first and reads one request by id', async () => {
  await withRepo(async (repoPath) => {
    const store = new RequestStore({ repoPath })
    await store.create(record('req-old', { now: new Date('2026-11-01T00:00:00.000Z') }))
    await store.create(record('req-new', { now: new Date('2026-11-09T00:00:00.000Z') }))
    await store.create(record('req-mid', { now: new Date('2026-11-05T00:00:00.000Z') }))

    const scan = await store.readAll()
    assert.deepEqual(scan.records.map((row) => row.requestId), ['req-new', 'req-mid', 'req-old'])
    assert.equal(scan.truncated, false)
    assert.equal(scan.skipped, 0)
    assert.equal((await store.read('req-mid')).requestId, 'req-mid')
    assert.equal(await store.read('req-missing'), null)
    assert.equal(await store.read('../escape'), null)
  })
})

test('a damaged or non-conforming file is skipped and logged, never fatal', async () => {
  await withRepo(async (repoPath) => {
    const logs = []
    const store = new RequestStore({ repoPath, log: (message) => logs.push(message) })
    await store.create(record('req-good'))
    await mkdir(store.requestsDir, { recursive: true })
    await writeFile(join(store.requestsDir, 'req-broken.json'), '{not json')
    await writeFile(join(store.requestsDir, 'req-wrong.json'), JSON.stringify({ version: 1, requestId: 'req-wrong' }))
    await writeFile(join(store.requestsDir, 'notes.txt'), 'not a request')

    const scan = await store.readAll()
    assert.deepEqual(scan.records.map((row) => row.requestId), ['req-good'])
    assert.equal(scan.skipped, 2)
    assert.equal(logs.length, 2)
    assert.match(logs[0], /skipped/)
  })
})

test('the scan is capped and reports truncation, keeping every file on disk', async () => {
  await withRepo(async (repoPath) => {
    const store = new RequestStore({ repoPath })
    for (let index = 0; index < INBOX_MAX_REQUEST_FILES + 1; index += 1) {
      const requestId = `req-${String(index).padStart(3, '0')}`
      await store.create(record(requestId))
    }
    const scan = await store.readAll()
    assert.equal(scan.scanned, INBOX_MAX_REQUEST_FILES)
    assert.equal(scan.truncated, true)
    const files = (await readdir(store.requestsDir)).filter((name) => name.endsWith('.json'))
    assert.equal(files.length, INBOX_MAX_REQUEST_FILES + 1, 'nothing is deleted')
  })
})

test('update is one locked read-modify-write and can report no change', async () => {
  await withRepo(async (repoPath) => {
    const store = new RequestStore({ repoPath })
    await store.create(record('req-1'))
    const applied = await store.update('req-1', (current) => ({
      ...current,
      summary: 'updated summary',
      updatedAt: new Date('2026-11-10T10:00:00.000Z').toISOString(),
    }))
    assert.equal(applied.summary, 'updated summary')
    const unchanged = await store.update('req-1', () => null)
    assert.equal(unchanged.summary, 'updated summary')
    assert.equal(await store.update('req-missing', () => null), null)
  })
})

test('create waits for the shared project write lock', async () => {
  await withRepo(async (repoPath) => {
    const store = new RequestStore({ repoPath })
    // Create the project directory first so the lock file has a home.
    await store.create(record('warmup'))
    let release
    let lockReady
    const ready = new Promise((resolve) => { lockReady = resolve })
    const held = withFileLock(store.lockFile, async () => {
      lockReady()
      await new Promise((resolve) => { release = resolve })
    })
    await ready
    let settled = false
    const created = store.create(record('req-late')).then(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(settled, false, 'a request write must wait for the project lock')
    release()
    await held
    await created
    assert.equal(settled, true)
    assert.equal((await store.read('req-late')).requestId, 'req-late')
  })
})

test('recordDelivery keeps the terminal state and stores the prompt outcome', async () => {
  await withRepo(async (repoPath) => {
    const store = new RequestStore({ repoPath })
    await store.create(record('req-1'))
    await store.update('req-1', (current) => applyResolution(current, { status: 'passed', resolvedBy: 'user', now: NOW }))
    const recorded = await store.recordDelivery('req-1', {
      promptedAt: '2026-11-10T09:30:00.000Z',
      lastError: null,
    })
    assert.equal(recorded.status, 'passed')
    assert.equal(recorded.delivery.promptedAt, '2026-11-10T09:30:00.000Z')
    const failed = await store.recordDelivery('req-1', { promptedAt: null, lastError: 'host refused' })
    assert.equal(failed.status, 'passed', 'a prompt failure never rolls the terminal state back')
    assert.equal(failed.delivery.lastError, 'host refused')
  })
})

test('voidPendingForTopic voids exactly the pending requests of one topic', async () => {
  await withRepo(async (repoPath) => {
    const store = new RequestStore({ repoPath })
    await store.create(record('req-a', { topicId: 'topic-1' }))
    await store.create(record('req-b', { topicId: 'topic-2' }))
    await store.create(record('req-c', { topicId: 'topic-1' }))
    await store.update('req-c', (current) => applyResolution(current, { status: 'passed', resolvedBy: 'user', now: NOW }))
    await store.create(record('req-d', { topicId: 'topic-1' }))

    const voided = await store.voidPendingForTopic('topic-1', NOW)
    assert.deepEqual(voided.map((row) => row.requestId).sort(), ['req-a', 'req-d'])
    for (const row of voided) {
      assert.equal(row.status, 'void')
      assert.match(row.resolutionMessage, /作废/)
      assert.equal(row.resolvedBy, 'user')
      assert.equal(row.resolvedAt, NOW.toISOString())
    }
    assert.equal((await store.read('req-b')).status, 'pending', 'another topic is untouched')
    assert.equal((await store.read('req-c')).status, 'passed', 'a resolved request is untouched')
    assert.equal((await store.readAll()).records.length, 4, 'voiding never deletes history')
  })
})

test('two concurrent voids withdraw a pending request only once', async () => {
  await withRepo(async (repoPath) => {
    const store = new RequestStore({ repoPath })
    await store.create(record('req-1'))
    const [first, second] = await Promise.all([
      store.voidPendingForTopic('topic-1', NOW),
      store.voidPendingForTopic('topic-1', NOW),
    ])
    assert.equal(first.length + second.length, 1, 'the lock-scoped re-read sees the first void')
    assert.equal((await store.read('req-1')).status, 'void')
  })
})
