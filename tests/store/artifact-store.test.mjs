import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  artifactContract,
  artifactStore,
  makeAttachmentPublish,
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

test('upload ids are validated and an unreadable entry is reported', async () => {
  await withStore(async (store, repo) => {
    await store.createRecord(makeRecord())
    assert.equal(await store.hasUpload(ARTIFACT, '../escape'), false)
    await assert.rejects(store.saveUpload(ARTIFACT, '../escape', new Uint8Array([1])), (error) => {
      assert.equal(error.code, 'artifact/not-found')
      return true
    })
    const directory = join(repo.repoPath, '.dsh-cowork', 'artifacts', ARTIFACT, 'uploads', 'attachment-11111111')
    await mkdir(directory, { recursive: true })
    await assert.rejects(store.readUpload(ARTIFACT, 'attachment-11111111'), (error) => {
      assert.equal(error.code, 'EISDIR')
      return true
    })
  })
})

test('countUploads counts stored upload files and ignores other entries', async () => {
  await withStore(async (store, repo) => {
    await store.createRecord(makeRecord())
    assert.equal(await store.countUploads(ARTIFACT), 0, 'a missing upload directory counts as zero')
    for (const attachmentId of ['attachment-a1', 'attachment-b2', 'attachment-c3']) {
      await store.saveUpload(ARTIFACT, attachmentId, new Uint8Array([1, 2, 3]))
    }
    const directory = join(repo.repoPath, '.dsh-cowork', 'artifacts', ARTIFACT, 'uploads')
    await writeFile(join(directory, 'notes.txt'), 'not an upload id')
    await writeFile(join(directory, 'artifact-lookalike'), 'not an upload prefix')
    assert.equal(await store.countUploads(ARTIFACT), 3)
    // The scan short-circuits at the requested bound.
    assert.equal(await store.countUploads(ARTIFACT, 2), 2)
    assert.equal(await store.countUploads(ARTIFACT, 0), 0)
    await assert.rejects(store.countUploads('../escape'), (error) => {
      assert.equal(error.code, 'artifact/not-found')
      return true
    })
  })
})

test('an unreadable upload directory is reported instead of counting zero', async () => {
  await withStore(async (store, repo) => {
    await store.createRecord(makeRecord())
    const directory = join(repo.repoPath, '.dsh-cowork', 'artifacts', ARTIFACT, 'uploads')
    await mkdir(directory, { recursive: true })
    await chmod(directory, 0o000)
    try {
      await assert.rejects(store.countUploads(ARTIFACT), (error) => {
        assert.equal(error.code, 'EACCES')
        return true
      })
    } finally {
      await chmod(directory, 0o700)
    }
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

test('revision snapshots are readable and keep only the newest twenty', async () => {
  await withStore(async (store) => {
    await store.createRecord(makeRecord())
    for (let revision = 1; revision <= 21; revision += 1) {
      await store.saveRevision(ARTIFACT, revision, `content ${revision}\n`)
    }
    assert.equal(await store.readRevision(ARTIFACT, 1), null)
    assert.equal(await store.readRevision(ARTIFACT, 2), 'content 2\n')
    assert.equal(await store.readRevision(ARTIFACT, 21), 'content 21\n')
    assert.equal(await store.readRevision(ARTIFACT, 99), null)
    assert.deepEqual(await store.listRevisions(ARTIFACT), Array.from({ length: 20 }, (_, index) => 21 - index))
    assert.deepEqual(await store.listRevisions('artifact-99999999-9999-4999-8999-999999999999'), [])
  })
})

test('revision listing rethrows an unexpected filesystem error', async () => {
  await withStore(async (store) => {
    await store.createRecord(makeRecord())
    const directory = store.revisionsDir(ARTIFACT)
    await mkdir(directory, { recursive: true })
    await chmod(directory, 0o000)
    try {
      await assert.rejects(store.listRevisions(ARTIFACT), (error) => error.code === 'EACCES')
    } finally {
      await chmod(directory, 0o700)
    }
  })
})

test('revision IO for an unknown or malformed artifact id fails like the record', async () => {
  await withStore(async (store) => {
    assert.equal(await store.readRevision('artifact-99999999-9999-4999-8999-999999999999', 1), null)
    await assert.rejects(store.readRevision('../escape', 1), (error) => {
      assert.equal(error.code, 'artifact/not-found')
      return true
    })
    await assert.rejects(store.saveRevision('../escape', 1, 'x'), (error) => {
      assert.equal(error.code, 'artifact/not-found')
      return true
    })
  })
})

test('the event window filters by artifact before the cap and reports a trimmed log', async () => {
  await withStore(async (store) => {
    await mkdir(store.root, { recursive: true })
    const row = (seq, artifactId) => ({
      version: 1, seq, eventId: `event-${seq}`, type: 'artifact.updated',
      artifactId, time: '2026-02-01T00:00:00.000Z', data: { seq },
    })
    await writeFile(
      join(store.root, 'events.jsonl'),
      `${JSON.stringify(row(5, 'artifact-a'))}\n${JSON.stringify(row(6, 'artifact-b'))}\n`,
    )
    const current = await store.readEventsWindow(0, 'artifact-b')
    assert.deepEqual(current.events.map((event) => event.seq), [6])
    assert.equal(current.newest, 6)
    assert.equal(current.truncated, false)
    const trimmed = await store.readEventsWindow(2, 'artifact-b')
    assert.equal(trimmed.truncated, true)
    assert.deepEqual(trimmed.events.map((event) => event.seq), [6])
    const empty = await store.readEventsWindow(9, 'artifact-b')
    assert.deepEqual(empty.events, [])
    assert.equal(empty.newest, 6)
  })
})

test('the list cache serves its snapshot until a write invalidates it', async () => {
  await withStore(async (store) => {
    await store.createRecord(makeRecord())
    const first = await store.listRecords()
    const recordPath = join(store.root, ARTIFACT, 'artifact.json')
    // An outside write to a record does not change the artifacts directory
    // mtime, so the cached inventory keeps serving the snapshot it took.
    await writeFile(recordPath, JSON.stringify(makeRecord({ status: 'confirmed' })))
    const cached = await store.listRecords()
    assert.deepEqual(cached.records, first.records)
    assert.equal(cached.records[0].status, 'pending-view')

    // A record write invalidates: the next read sees the outside change.
    await store.mutateRecord(ARTIFACT, (record) => ({ ...record, status: 'confirmed' }))
    assert.equal((await store.listRecords()).records[0].status, 'confirmed')

    // Comment and event appends invalidate for the same reason.
    await writeFile(recordPath, JSON.stringify(makeRecord({ status: 'needs-feedback' })))
    await store.appendComment(makeComment())
    assert.equal((await store.listRecords()).records[0].status, 'needs-feedback')

    await writeFile(recordPath, JSON.stringify(makeRecord({ status: 'in-progress' })))
    await store.appendEvent({
      eventId: 'event-1',
      type: 'artifact.updated',
      artifactId: ARTIFACT,
      time: '2026-02-01T00:00:00.000Z',
      data: {},
    })
    assert.equal((await store.listRecords()).records[0].status, 'in-progress')
  })
})

test('a cached list keeps limit, total, and corrupt semantics', async () => {
  await withStore(async (store, repo) => {
    const ids = [
      'artifact-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'artifact-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'artifact-cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    ]
    for (const artifactId of ids) await store.createRecord(makeRecord({ artifactId }))
    const root = join(repo.repoPath, '.dsh-cowork', 'artifacts')
    await mkdir(join(root, 'artifact-dddddddd-dddd-4ddd-8ddd-dddddddddddd'), { recursive: true })
    await writeFile(join(root, 'artifact-dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'artifact.json'), '{broken')

    const first = await store.listRecords(2)
    assert.equal(first.records.length, 2)
    assert.equal(first.total, 3)
    assert.deepEqual(first.corrupt, ['artifact-dddddddd-dddd-4ddd-8ddd-dddddddddddd'])
    const cached = await store.listRecords(2)
    assert.deepEqual(cached, first)
  })
})

test('an event window keeps the newest rows and reports a lagging cursor trimmed', async () => {
  await withStore(async (store) => {
    await mkdir(store.root, { recursive: true })
    const row = (seq) => ({
      version: 1,
      seq,
      eventId: `event-${seq}`,
      type: 'artifact.updated',
      artifactId: seq % 2 === 0 ? 'artifact-even' : 'artifact-odd',
      time: '2026-02-01T00:00:00.000Z',
      data: { seq },
    })
    const rows = []
    for (let seq = 1; seq <= 2500; seq += 1) rows.push(JSON.stringify(row(seq)))
    await writeFile(join(store.root, 'events.jsonl'), `${rows.join('\n')}\n`)

    const fresh = await store.readEvents(0)
    assert.equal(fresh.length, 2000)
    assert.equal(fresh[0].seq, 501, 'the newest window must be replayed, not the oldest')
    assert.equal(fresh[fresh.length - 1].seq, 2500)

    const lagging = await store.readEventsWindow(1)
    assert.equal(lagging.events.length, 2000)
    assert.equal(lagging.events[0].seq, 501)
    assert.equal(lagging.newest, 2500)
    assert.equal(lagging.truncated, true, 'a cursor behind more than one window must reset')

    const filtered = await store.readEventsWindow(1, 'artifact-even')
    assert.equal(filtered.events.length, 1250)
    assert.equal(filtered.truncated, false, 'a filtered replay that fits one window is complete')

    const trimmedRows = []
    for (let seq = 5; seq <= 2504; seq += 1) trimmedRows.push(JSON.stringify(row(seq)))
    await writeFile(join(store.root, 'events.jsonl'), `${trimmedRows.join('\n')}\n`)
    const trimmed = await store.readEventsWindow(3)
    assert.equal(trimmed.truncated, true, 'a gap between the cursor and the retained log must reset')
    assert.equal(trimmed.events[0].seq, 505)
  })
})

test('a cache fingerprint that cannot stat the directory is rethrown', async () => {
  await withStore(async (store, repo) => {
    const root = join(repo.repoPath, '.dsh-cowork', 'artifacts')
    await mkdir(join(repo.repoPath, '.dsh-cowork'), { recursive: true })
    // A self-referential symlink makes stat fail with ELOOP, not ENOENT, so
    // the fingerprint must rethrow instead of reporting an empty project.
    await symlink(root, root)
    await assert.rejects(store.listRecords(), (error) => error.code === 'ELOOP')
  })
})

test('publish rows append in order and a damaged row is skipped', async () => {
  await withStore(async (store, repo) => {
    await store.withLock(async () => {
      await store.appendAttachmentPublishUnlocked(ARTIFACT, makeAttachmentPublish({ attachmentId: 'attachment-one', name: 'one.png' }))
      await store.appendAttachmentPublishUnlocked(ARTIFACT, makeAttachmentPublish({
        attachmentId: 'attachment-two',
        name: 'two.txt',
        mediaType: 'text/plain',
        source: 'user',
      }))
    })
    const rows = await store.readAttachmentPublishes(ARTIFACT)
    assert.deepEqual(rows.map((row) => row.attachmentId), ['attachment-one', 'attachment-two'])
    assert.equal(rows[1].source, 'user')
    assert.equal(rows[1].publishedAt, '2026-02-01T00:00:00.000Z')

    const file = join(repo.repoPath, '.dsh-cowork', 'artifacts', ARTIFACT, 'attachments.jsonl')
    await appendFile(file, '{broken\n')
    await appendFile(file, `${JSON.stringify(makeAttachmentPublish({ attachmentId: 'attachment-three' }))}\n`)
    assert.deepEqual(
      (await store.readAttachmentPublishes(ARTIFACT)).map((row) => row.attachmentId),
      ['attachment-one', 'attachment-two', 'attachment-three'],
    )
  })
})

test('a repeated publish id keeps the newest row once', async () => {
  await withStore(async (store) => {
    await store.withLock(async () => {
      await store.appendAttachmentPublishUnlocked(ARTIFACT, makeAttachmentPublish({ name: 'first.png', source: 'user' }))
      await store.appendAttachmentPublishUnlocked(ARTIFACT, makeAttachmentPublish({ name: 'second.png', source: 'model' }))
    })
    const rows = await store.readAttachmentPublishes(ARTIFACT)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].name, 'second.png')
    assert.equal(rows[0].source, 'model')
  })
})

test('the publish log read keeps the newest rows within the attachment cap', async () => {
  await withStore(async (store) => {
    const limit = artifactContract.MAX_ARTIFACT_ATTACHMENTS
    await store.withLock(async () => {
      for (let index = 0; index <= limit; index += 1) {
        await store.appendAttachmentPublishUnlocked(ARTIFACT, makeAttachmentPublish({
          attachmentId: `attachment-${String(index).padStart(3, '0')}`,
        }))
      }
    })
    const rows = await store.readAttachmentPublishes(ARTIFACT)
    assert.equal(rows.length, limit)
    assert.equal(rows[0].attachmentId, 'attachment-001')
    assert.equal(rows[rows.length - 1].attachmentId, `attachment-${String(limit).padStart(3, '0')}`)
  })
})
