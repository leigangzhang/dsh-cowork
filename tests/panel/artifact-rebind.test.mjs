import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { realpath, writeFile } from 'node:fs/promises'
import {
  NOW,
  PROJECT_ID,
  SESSION,
  createHarness,
  jsonOf,
  linkInside,
  makeComment,
  makeFile,
  makeRecord,
  makeRepo,
  sha256,
} from '../support/artifact-fixtures.mjs'

/**
 * Stage-5 backend behavior: rebinding a moved file, the comment anchors that
 * follow it, the path/collision refusals, and the list read after each write
 * that must not serve a cached inventory.
 */
const ARTIFACT = 'artifact-11111111-1111-4111-8111-111111111111'
const OTHER = 'artifact-22222222-2222-4222-8222-222222222222'
const SPEC = '# Spec\n\nfirst paragraph\nsecond paragraph\n'

/** A file entry whose sha and host version match `content`. */
function specFile(path = 'docs/old.md', content = SPEC, overrides = {}) {
  return makeFile({
    path,
    size: Buffer.byteLength(content),
    sha256: sha256(content),
    fsVersion: sha256(content),
    ...overrides,
  })
}

/** Create the harness plus one work item that registers `docs/old.md`. */
async function withHarness(operation, options = {}) {
  const harness = await createHarness({
    files: {
      'docs/old.md': SPEC,
      'docs/new.md': SPEC,
      '.git/config': '[remote "origin"]\nurl = https://example.invalid/repo\n',
      '.env': 'TOKEN=secret\n',
      '.dsh-cowork/index.json': '{}\n',
      ...(options.files ?? {}),
    },
  })
  try {
    const store = harness.runtime().store
    await store.createRecord(makeRecord({
      files: [specFile('docs/old.md', SPEC, options.file ?? {})],
      primaryPath: 'docs/old.md',
      ...(options.record ?? {}),
    }))
    return await operation(harness, store)
  } finally {
    await harness.cleanup()
  }
}

/** POST one rebind body. */
function rebind(harness, body) {
  return harness.request('/api/cowork.artifact.rebind', {
    method: 'POST',
    body: { sessionId: SESSION, artifactId: ARTIFACT, ...body },
  })
}

/** GET one page of work items. */
async function listOf(harness) {
  return jsonOf(await harness.request('/api/cowork.artifact.list', { query: { sessionId: SESSION } }))
}

test('rebind moves a registered file, bumps one revision, and emits file.changed', async () => {
  await withHarness(async (harness, store) => {
    const response = await rebind(harness, { oldPath: 'docs/old.md', newPath: 'docs/new.md' })
    assert.equal(response.status, 200)
    const body = await jsonOf(response)
    assert.equal(body.ok, true)
    assert.equal(body.changed, true)
    assert.equal(body.record.primaryPath, 'docs/new.md')
    assert.equal(body.record.revision, 2)
    assert.equal(body.record.files[0].path, 'docs/new.md')
    assert.equal(body.record.files[0].revision, 2)
    assert.equal(body.record.files[0].missing, false)

    const persisted = await store.readRecord(ARTIFACT)
    assert.equal(persisted.primaryPath, 'docs/new.md')
    const events = await store.readEvents()
    const changed = events.find((event) => event.type === 'file.changed')
    assert.deepEqual(changed.data, { path: 'docs/new.md', from: 'docs/old.md', revision: 2 })
    assert.equal(events[events.length - 1].type, 'artifact.updated')

    // The list must not serve the inventory it cached before the rebind.
    const list = await listOf(harness)
    assert.equal(list.items[0].primaryPath, 'docs/new.md')
    assert.equal(list.items[0].revision, 2)
    assert.equal(list.counts.total, 1)
    assert.equal(list.truncated, false)

    // A detail read reconciles the untouched content without another bump.
    const detail = await jsonOf(await harness.request('/api/cowork.artifact.detail', {
      query: { sessionId: SESSION, artifactId: ARTIFACT },
    }))
    assert.equal(detail.record.revision, 2)
    assert.equal(detail.record.files[0].missing, false)
  })
})

test('rebinding a path to itself is an idempotent no-op', async () => {
  await withHarness(async (harness, store) => {
    const before = await store.readRecord(ARTIFACT)
    const body = await jsonOf(await rebind(harness, { oldPath: 'docs/old.md', newPath: 'docs/old.md' }))
    assert.equal(body.ok, true)
    assert.equal(body.changed, false)
    assert.deepEqual(body.record, before)
    assert.deepEqual(await store.readRecord(ARTIFACT), before)
    assert.deepEqual(await store.readEvents(), [])
  })
})

test('rebind keeps its stable codes for unknown artifacts, paths, and sessions', async () => {
  await withHarness(async (harness, store) => {
    await store.createRecord(makeRecord({
      artifactId: OTHER,
      projectId: 'example.com/other/repo',
      files: [specFile('docs/old.md')],
      primaryPath: 'docs/old.md',
    }))
    const cases = [
      [{ oldPath: 'docs/old.md', newPath: 'docs/new.md' }, 'artifact-99999999-9999-4999-8999-999999999999', 404, 'artifact/not-found'],
      [{ oldPath: 'docs/unregistered.md', newPath: 'docs/new.md' }, ARTIFACT, 404, 'artifact/file-missing'],
      [{ oldPath: 'docs/old.md', newPath: 'docs/gone.md' }, ARTIFACT, 404, 'artifact/file-missing'],
      [{ oldPath: 'docs/old.md', newPath: 'docs/new.md' }, OTHER, 403, 'artifact/session-mismatch'],
    ]
    for (const [paths, artifactId, status, code] of cases) {
      const response = await rebind(harness, { artifactId, ...paths })
      assert.equal(response.status, status, `${artifactId}:${paths.newPath}`)
      assert.equal((await jsonOf(response)).error.code, code)
    }
    // A refused rebind leaves both entries untouched.
    assert.equal((await store.readRecord(ARTIFACT)).files[0].path, 'docs/old.md')
    assert.equal((await store.readRecord(OTHER)).files[0].path, 'docs/old.md')
  })
})

test('rebind refuses escaping, forbidden, non-file, and symlinked targets', async () => {
  const outside = await makeRepo({ 'target.md': 'secret\n' })
  try {
    await withHarness(async (harness) => {
      await linkInside(harness.repoPath, 'docs/escape.md', join(outside.repoPath, 'target.md'))
      await linkInside(harness.repoPath, 'docs/git.md', join(harness.repoPath, '.git/config'))
      await linkInside(harness.repoPath, 'docs/env.md', join(harness.repoPath, '.env'))
      const targets = [
        ['../escape.md', 400, 'artifact/path-not-allowed'],
        ['/etc/passwd', 400, 'artifact/path-not-allowed'],
        ['docs\\..\\escape.md', 400, 'artifact/path-not-allowed'],
        ['.git/config', 400, 'artifact/path-not-allowed'],
        ['.dsh-cowork/index.json', 400, 'artifact/path-not-allowed'],
        ['.env', 400, 'artifact/path-not-allowed'],
        ['secrets/id_rsa', 400, 'artifact/path-not-allowed'],
        ['docs', 400, 'artifact/path-not-allowed'],
        ['docs/escape.md', 400, 'artifact/path-not-allowed'],
        ['docs/git.md', 400, 'artifact/path-not-allowed'],
        ['docs/env.md', 400, 'artifact/path-not-allowed'],
      ]
      for (const [newPath, status, code] of targets) {
        const response = await rebind(harness, { oldPath: 'docs/old.md', newPath })
        assert.equal(response.status, status, newPath)
        assert.equal((await jsonOf(response)).error.code, code, newPath)
      }
    })
  } finally {
    await outside.remove()
  }
})

test('rebind refuses a path another work item or another entry already registers', async () => {
  await withHarness(async (harness, store) => {
    await store.createRecord(makeRecord({
      artifactId: OTHER,
      files: [specFile('docs/new.md')],
      primaryPath: 'docs/new.md',
    }))
    const taken = await rebind(harness, { oldPath: 'docs/old.md', newPath: 'docs/new.md' })
    assert.equal(taken.status, 409)
    assert.equal((await jsonOf(taken)).error.code, 'artifact/duplicate')
    assert.equal((await store.readRecord(ARTIFACT)).files[0].path, 'docs/old.md')

    await writeFile(join(harness.repoPath, 'docs/second.md'), SPEC)
    await store.mutateRecord(ARTIFACT, (record) => ({
      ...record,
      files: [...record.files, specFile('docs/second.md', SPEC)],
    }))
    const ownEntry = await rebind(harness, { oldPath: 'docs/old.md', newPath: 'docs/second.md' })
    assert.equal(ownEntry.status, 409)
    assert.equal((await jsonOf(ownEntry)).error.code, 'artifact/duplicate')
  })
})

test('rebind remaps line anchors to the new path and keeps the comment body', async () => {
  await withHarness(async (harness, store) => {
    await store.appendComment(makeComment({
      anchor: {
        kind: 'line-range',
        path: 'docs/old.md',
        startLine: 3,
        endLine: 3,
        quote: 'first paragraph',
        contextBefore: '',
        contextAfter: 'second paragraph',
      },
    }))
    await store.mutateRecord(ARTIFACT, (record) => ({ ...record, commentCount: 1 }))
    const body = await jsonOf(await rebind(harness, { oldPath: 'docs/old.md', newPath: 'docs/new.md' }))
    assert.equal(body.changed, true)
    assert.equal(body.record.commentCount, 1)
    const comments = await store.readComments(ARTIFACT)
    const created = comments.find((event) => event.type === 'create')
    assert.equal(created.body, 'please tighten this paragraph')
    const moved = comments.find((event) => event.type === 'anchor-moved')
    assert.equal(moved.commentId, 'comment-1')
    assert.equal(moved.anchorStatus, 'moved')
    assert.equal(moved.anchor.path, 'docs/new.md')
    const events = await store.readEvents()
    const anchorEvent = events.find((event) => event.type === 'comment.updated')
    assert.deepEqual(anchorEvent.data, { commentId: 'comment-1', anchorStatus: 'moved' })
  })
})

test('an unlocatable anchor becomes stale without losing its comment', async () => {
  await withHarness(async (harness, store) => {
    await store.appendComment(makeComment({
      anchor: {
        kind: 'line-range',
        path: 'docs/old.md',
        startLine: 2,
        endLine: 2,
        quote: 'a paragraph that moved away',
      },
    }))
    // Replace the rebind target with content that does not carry the quote.
    await writeFile(join(harness.repoPath, 'docs/new.md'), '# Spec\n\nnothing else\n')
    const body = await jsonOf(await rebind(harness, { oldPath: 'docs/old.md', newPath: 'docs/new.md' }))
    assert.equal(body.changed, true)
    const comments = await store.readComments(ARTIFACT)
    const moved = comments.find((event) => event.type === 'anchor-moved')
    assert.equal(moved.anchorStatus, 'stale')
    assert.equal(moved.anchor.path, 'docs/new.md')
    assert.equal(comments.find((event) => event.type === 'create').body, 'please tighten this paragraph')
  })
})

test('list reads see comment, status, edit, create, and rebind writes', async () => {
  await withHarness(async (harness, store) => {
    const first = await listOf(harness)
    assert.equal(first.items[0].commentCount, 0)
    const second = await listOf(harness)
    assert.deepEqual(second, first)

    await harness.request('/api/cowork.artifact.comment', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT, body: 'new note', dispatch: false },
    })
    const afterComment = await listOf(harness)
    assert.equal(afterComment.items[0].commentCount, 1)
    assert.equal(afterComment.counts.needsFeedback, 1)

    await harness.request('/api/cowork.artifact.status', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT, action: 'confirm' },
    })
    const afterStatus = await listOf(harness)
    assert.equal(afterStatus.items[0].status, 'confirmed')
    assert.equal(afterStatus.counts.confirmed, 1)

    await store.saveRevision(ARTIFACT, 1, SPEC)
    const edited = await harness.request('/api/cowork.artifact.edit', {
      method: 'POST',
      body: {
        sessionId: SESSION,
        artifactId: ARTIFACT,
        path: 'docs/old.md',
        baseRevision: 1,
        baseVersion: sha256(SPEC),
        content: '# Spec\n\nfirst paragraph\nsecond paragraph\nchanged\n',
      },
    })
    assert.equal(edited.status, 200)
    const afterEdit = await listOf(harness)
    assert.equal(afterEdit.items[0].revision, 2)

    await store.createRecord(makeRecord({
      artifactId: OTHER,
      files: [specFile('docs/second.md', SPEC)],
      primaryPath: 'docs/second.md',
    }))
    const afterCreate = await listOf(harness)
    assert.equal(afterCreate.counts.total, 2)
    assert.equal(afterCreate.items.length, 2)

    const rebindBody = await jsonOf(await rebind(harness, { oldPath: 'docs/old.md', newPath: 'docs/new.md' }))
    assert.equal(rebindBody.changed, true)
    const afterRebind = await listOf(harness)
    const rebound = afterRebind.items.find((item) => item.artifactId === ARTIFACT)
    assert.equal(rebound.primaryPath, 'docs/new.md')
  })
})

test('a rebind keeps the record timestamp and event sequence monotonic', async () => {
  await withHarness(async (harness, store) => {
    const before = await store.lastEventSeq()
    const body = await jsonOf(await rebind(harness, { oldPath: 'docs/old.md', newPath: 'docs/new.md' }))
    assert.equal(body.record.updatedAt, NOW.toISOString())
    assert.equal(await store.lastEventSeq(), before + 2)
  })
})

test('a second rebind follows the anchors the first one remapped', async () => {
  await withHarness(async (harness, store) => {
    await writeFile(join(harness.repoPath, 'docs/newer.md'), SPEC)
    await store.appendComment(makeComment({
      anchor: {
        kind: 'line-range',
        path: 'docs/old.md',
        startLine: 3,
        endLine: 3,
        quote: 'first paragraph',
        contextBefore: '',
        contextAfter: 'second paragraph',
      },
    }))
    assert.equal((await jsonOf(await rebind(harness, { oldPath: 'docs/old.md', newPath: 'docs/new.md' }))).changed, true)
    const body = await jsonOf(await rebind(harness, { oldPath: 'docs/new.md', newPath: 'docs/newer.md' }))
    assert.equal(body.changed, true)
    assert.equal(body.record.primaryPath, 'docs/newer.md')
    const moved = (await store.readComments(ARTIFACT)).filter((event) => event.type === 'anchor-moved')
    assert.equal(moved.length, 2)
    assert.equal(moved[1].anchor.path, 'docs/newer.md')
    assert.equal(moved[1].anchorStatus, 'moved')
  })
})

test('a work item that vanished before the lock fails as not-found', async () => {
  await withHarness(async (harness, store) => {
    const original = store.readRecord.bind(store)
    let reads = 0
    store.readRecord = async (artifactId) => {
      reads += 1
      return reads === 2 ? null : original(artifactId)
    }
    try {
      const response = await rebind(harness, { oldPath: 'docs/old.md', newPath: 'docs/new.md' })
      assert.equal(response.status, 404)
      assert.equal((await jsonOf(response)).error.code, 'artifact/not-found')
    } finally {
      store.readRecord = original
    }
  })
})

test('a file unregistered before the lock wins over the stale observation', async () => {
  await withHarness(async (harness, store) => {
    const original = store.readRecord.bind(store)
    let reads = 0
    store.readRecord = async (artifactId) => {
      reads += 1
      const current = await original(artifactId)
      return reads === 2 && current !== null ? { ...current, files: [] } : current
    }
    try {
      const response = await rebind(harness, { oldPath: 'docs/old.md', newPath: 'docs/new.md' })
      assert.equal(response.status, 404)
      assert.equal((await jsonOf(response)).error.code, 'artifact/file-missing')
    } finally {
      store.readRecord = original
    }
  })
})

test('an unreadable rebind target marks a line anchor stale instead of losing it', async () => {
  const repo = await makeRepo({
    'docs/old.md': SPEC,
    'docs/new.md': SPEC,
    '.git/config': '[remote "origin"]\n',
    '.env': 'TOKEN=secret\n',
    '.dsh-cowork/index.json': '{}\n',
  })
  const harness = await createHarness({
    repoPath: repo.repoPath,
    fsOptions: { failures: new Map([[join(await realpath(repo.repoPath), 'docs/new.md'), 'EACCES']]) },
  })
  try {
    const store = harness.runtime().store
    await store.createRecord(makeRecord({ files: [specFile('docs/old.md')], primaryPath: 'docs/old.md' }))
    await store.appendComment(makeComment({
      anchor: {
        kind: 'line-range',
        path: 'docs/old.md',
        startLine: 3,
        endLine: 3,
        quote: 'first paragraph',
      },
    }))
    const body = await jsonOf(await rebind(harness, { oldPath: 'docs/old.md', newPath: 'docs/new.md' }))
    assert.equal(body.changed, true)
    const moved = (await store.readComments(ARTIFACT)).find((event) => event.type === 'anchor-moved')
    assert.equal(moved.anchorStatus, 'stale')
    assert.equal(moved.anchor.path, 'docs/new.md')
  } finally {
    await harness.cleanup()
  }
})
