import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  artifactStore,
  makeComment,
  makeRecord,
  makeRepo,
} from '../support/artifact-fixtures.mjs'

/**
 * The store owns the on-disk layout, the independent writer lock, and the
 * read tolerance rules: a damaged record fails only itself, a damaged JSONL
 * row is skipped, and records are listed newest first.
 */
const ARTIFACT = 'artifact-11111111-1111-4111-8111-111111111111'

/** A store rooted at a fresh temporary repository. */
async function withStore(operation) {
  const repo = await makeRepo()
  try {
    return await operation(new artifactStore.ArtifactStore(repo.repoPath), repo)
  } finally {
    await repo.remove()
  }
}

test('a fresh project has no records', async () => {
  await withStore(async (store) => {
    assert.deepEqual(await store.listRecords(), { records: [], corrupt: [], total: 0 })
    assert.equal(await store.readRecord(ARTIFACT), null)
  })
})

test('create, read, and list one record', async () => {
  await withStore(async (store) => {
    const record = makeRecord()
    assert.deepEqual(await store.createRecord(record), record)
    assert.deepEqual(await store.readRecord(ARTIFACT), record)
    const scan = await store.listRecords()
    assert.equal(scan.total, 1)
    assert.deepEqual(scan.records, [record])
    assert.deepEqual(scan.corrupt, [])
    assert.equal(await store.lastEventSeq(), 0)
    assert.deepEqual(await store.readComments(ARTIFACT), [])
    assert.equal(await store.readLatestDispatch(ARTIFACT), null)
  })
})

test('a duplicate id is refused', async () => {
  await withStore(async (store) => {
    await store.createRecord(makeRecord())
    await assert.rejects(store.createRecord(makeRecord()), (error) => {
      assert.equal(error.code, 'artifact/duplicate')
      return true
    })
  })
})

test('the five-hundred work-item cap is enforced', async () => {
  await withStore(async (store, repo) => {
    const root = join(repo.repoPath, '.dsh-cowork', 'artifacts')
    for (let index = 0; index < 500; index += 1) {
      const id = `artifact-00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
      await mkdir(join(root, id), { recursive: true })
      await writeFile(join(root, id, 'artifact.json'), `${JSON.stringify(makeRecord({ artifactId: id }))}\n`)
    }
    await assert.rejects(store.createRecord(makeRecord({ artifactId: `${ARTIFACT}1` })), (error) => {
      assert.equal(error.code, 'artifact/limit-reached')
      return true
    })
  })
})

test('records list newest first and a damaged record is reported, not served', async () => {
  await withStore(async (store, repo) => {
    const older = makeRecord({ artifactId: 'artifact-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', updatedAt: '2026-01-01T00:00:00.000Z' })
    const newer = makeRecord({ artifactId: 'artifact-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', updatedAt: '2026-03-01T00:00:00.000Z' })
    await store.createRecord(older)
    await store.createRecord(newer)
    const root = join(repo.repoPath, '.dsh-cowork', 'artifacts')
    await mkdir(join(root, 'artifact-cccccccc-cccc-4ccc-8ccc-cccccccccccc'), { recursive: true })
    await writeFile(join(root, 'artifact-cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'artifact.json'), '{not json')
    await mkdir(join(root, 'not-an-artifact'), { recursive: true })
    await writeFile(join(root, 'ignore-me.txt'), 'ignored')

    const scan = await store.listRecords()
    assert.deepEqual(scan.records.map((record) => record.artifactId), [newer.artifactId, older.artifactId])
    assert.deepEqual(scan.corrupt, ['artifact-cccccccc-cccc-4ccc-8ccc-cccccccccccc'])
    assert.equal(scan.total, 2)
    assert.deepEqual((await store.listRecords(1)).records.map((record) => record.artifactId), [newer.artifactId])

    await assert.rejects(store.readRecord('artifact-cccccccc-cccc-4ccc-8ccc-cccccccccccc'), (error) => {
      assert.equal(error.code, 'artifact/corrupt')
      return true
    })
  })
})

test('reading a damaged record throws artifact/corrupt', async () => {
  await withStore(async (store, repo) => {
    const dir = join(repo.repoPath, '.dsh-cowork', 'artifacts', ARTIFACT)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'artifact.json'), '{"artifactId": 1}')
    await assert.rejects(store.readRecord(ARTIFACT), (error) => {
      assert.equal(error.code, 'artifact/corrupt')
      assert.match(error.message, /unreadable/)
      return true
    })
  })
})

test('an unreadable store directory is reported instead of swallowed', async () => {
  await withStore(async (store, repo) => {
    const root = join(repo.repoPath, '.dsh-cowork', 'artifacts')
    await mkdir(root, { recursive: true })
    await chmod(root, 0o000)
    try {
      await assert.rejects(store.listRecords(), (error) => {
        assert.equal(error.code, 'EACCES')
        return true
      })
    } finally {
      await chmod(root, 0o700)
    }
  })
})

test('mutate rewrites a record, skips a no-op, and refuses an unknown id', async () => {
  await withStore(async (store) => {
    const record = makeRecord()
    await store.createRecord(record)
    const updated = await store.mutateRecord(ARTIFACT, (current) => ({
      ...current,
      title: 'renamed',
      updatedAt: '2026-02-02T00:00:00.000Z',
    }))
    assert.equal(updated.title, 'renamed')
    assert.equal((await store.readRecord(ARTIFACT)).title, 'renamed')

    const unchanged = await store.mutateRecord(ARTIFACT, () => null)
    assert.equal(unchanged.title, 'renamed')

    await assert.rejects(store.mutateRecord('artifact-dddddddd-dddd-4ddd-8ddd-dddddddddddd', () => null), (error) => {
      assert.equal(error.code, 'artifact/not-found')
      return true
    })
    await assert.rejects(store.mutateRecord('../escape', () => null), (error) => {
      assert.equal(error.code, 'artifact/not-found')
      return true
    })
  })
})

test('comments append and read back, skipping a damaged row', async () => {
  await withStore(async (store, repo) => {
    await store.createRecord(makeRecord())
    await store.appendComment(makeComment({ commentId: 'comment-1', eventId: 'event-1' }))
    await store.appendComment(makeComment({ commentId: 'comment-2', eventId: 'event-2', type: 'resolve' }))
    const file = join(repo.repoPath, '.dsh-cowork', 'artifacts', ARTIFACT, 'comments.jsonl')
    await writeFile(file, `${await readFile(file, 'utf8')}{broken\n`)
    const rows = await store.readComments(ARTIFACT)
    assert.deepEqual(rows.map((row) => row.commentId), ['comment-1', 'comment-2'])
    await assert.rejects(store.appendComment(makeComment({ artifactId: '../escape' })), (error) => {
      assert.equal(error.code, 'artifact/not-found')
      return true
    })
  })
})

test('dispatch rows append and the newest readable snapshot wins', async () => {
  await withStore(async (store) => {
    await store.createRecord(makeRecord())
    const base = {
      version: 1,
      dispatchId: 'dispatch-1',
      artifactId: ARTIFACT,
      sessionId: 'session-1',
      commentIds: ['comment-1'],
      state: 'queued',
      attempts: 0,
      promptRequestId: 'dispatch-1',
      errorCode: null,
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    }
    await store.appendDispatch(base)
    await store.appendDispatchUnlocked({ ...base, state: 'sent' })
    assert.equal((await store.readLatestDispatch(ARTIFACT)).state, 'sent')
  })
})

test('events get a monotonic sequence and replay after a cursor', async () => {
  await withStore(async (store) => {
    const base = {
      eventId: 'event-1',
      type: 'artifact.updated',
      artifactId: ARTIFACT,
      time: '2026-02-01T00:00:00.000Z',
      data: { revision: 1 },
    }
    const first = await store.appendEvent(base)
    const second = await store.appendEvent({ ...base, eventId: 'event-2', type: 'file.changed' })
    assert.equal(first.seq, 1)
    assert.equal(second.seq, 2)
    assert.equal(await store.lastEventSeq(), 2)
    assert.deepEqual((await store.readEvents(1)).map((event) => event.seq), [2])
    assert.deepEqual((await store.readEvents()).map((event) => event.seq), [1, 2])
  })
})

test('the artifact writer lock is the independent artifacts lock', async () => {
  await withStore(async (store) => {
    const order = []
    await store.withLock(async () => {
      order.push('inside')
    })
    order.push('after')
    assert.deepEqual(order, ['inside', 'after'])
  })
})
