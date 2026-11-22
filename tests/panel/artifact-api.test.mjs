import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  NOW,
  PROJECT_ID,
  SESSION,
  artifactApi,
  artifactContract,
  createHarness,
  jsonOf,
  makeComment,
  makeFile,
  makeRecord,
  sha256,
} from '../support/artifact-fixtures.mjs'
/**
 * Route-level behavior for the eight stage-1 artifact routes: session→project
 * resolution, path registration, reconciliation, comment anchoring, status
 * transitions, the error envelope, and the SSE stream.
 */
const SPEC = '# Spec\n\nfirst paragraph\nsecond paragraph\n'
const ARTIFACT = 'artifact-11111111-1111-4111-8111-111111111111'
/** A file entry whose sha/version match the fake host fs token. */
function specFile(content = SPEC, overrides = {}) {
  return makeFile({
    size: Buffer.byteLength(content),
    sha256: sha256(content),
    fsVersion: sha256(content),
    ...overrides,
  })
}
/** Create the harness plus one registered work item. */
async function withSeededHarness(operation, options = {}) {
  const harness = await createHarness({ files: { 'docs/spec.md': SPEC, ...(options.files ?? {}) }, sessionTitle: 'Spec 主题', ...options })
  try {
    await harness.runtime().store.createRecord(makeRecord({ files: [specFile(options.content)] }))
    return await operation(harness)
  } finally {
    await harness.cleanup()
  }
}

test('the harness registers every panel and artifact route', async () => {
  const harness = await createHarness()
  try {
    assert.equal(harness.routes.size, 25)
    assert.ok(harness.routes.has('/api/cowork.artifact.list'))
    assert.ok(harness.routes.has('/api/cowork.artifact.events'))
  } finally {
    await harness.cleanup()
  }
})

test('list returns the project inventory, counts, and status filter', async () => {
  await withSeededHarness(async (harness) => {
    const response = await harness.request('/api/cowork.artifact.list', { query: { sessionId: SESSION } })
    assert.equal(response.status, 200)
    const body = await jsonOf(response)
    assert.equal(body.ok, true)
    assert.equal(body.items.length, 1)
    assert.equal(body.items[0].artifactId, ARTIFACT)
    assert.equal(body.items[0].title, 'Spec')
    assert.equal(body.counts.total, 1)
    assert.equal(body.counts.pendingView, 1)
    assert.equal(body.truncated, false)

    const filtered = await jsonOf(await harness.request('/api/cowork.artifact.list', {
      query: { sessionId: SESSION, status: 'confirmed' },
    }))
    assert.equal(filtered.items.length, 0)
    assert.equal(filtered.counts.total, 1)

    const badStatus = await harness.request('/api/cowork.artifact.list', {
      query: { sessionId: SESSION, status: 'nope' },
    })
    assert.equal(badStatus.status, 400)
    assert.equal((await jsonOf(badStatus)).error.code, 'request/invalid-query')

    const noSession = await harness.request('/api/cowork.artifact.list')
    assert.equal(noSession.status, 400)
    assert.equal((await jsonOf(noSession)).error.code, 'request/session-required')
  })
})

test('a cross-origin request is refused before any store work', async () => {
  await withSeededHarness(async (harness) => {
    const response = await harness.request('/api/cowork.artifact.list', {
      query: { sessionId: SESSION },
      headers: { origin: 'http://evil.example' },
    })
    assert.equal(response.status, 403)
    assert.equal((await jsonOf(response)).error.code, 'request/origin')
  })
})

test('list skips records from another project, reports corrupt ids, and truncates', async () => {
  const harness = await createHarness()
  try {
    const store = harness.runtime().store
    await store.createRecord(makeRecord({ artifactId: ARTIFACT, projectId: 'other-project' }))
    const root = join(harness.repoPath, '.dsh-cowork', 'artifacts')
    await mkdir(join(root, 'artifact-corrupt-0000-4000-8000-000000000000'), { recursive: true })
    await writeFile(join(root, 'artifact-corrupt-0000-4000-8000-000000000000', 'artifact.json'), '{broken')
    for (let index = 0; index < 201; index += 1) {
      const id = `artifact-s${String(index).padStart(7, '0')}-0000-4000-8000-000000000000`
      await mkdir(join(root, id), { recursive: true })
      await writeFile(join(root, id, 'artifact.json'), JSON.stringify(makeRecord({ artifactId: id })))
    }
    const body = await jsonOf(await harness.request('/api/cowork.artifact.list', { query: { sessionId: SESSION } }))
    assert.equal(body.items.length, 199)
    assert.equal(body.truncated, true)
    assert.equal(body.counts.total, 199)
    assert.equal(body.items.every((item) => item.artifactId !== ARTIFACT), true)
    assert.ok(harness.logs.some((message) => message.includes('artifact-corrupt-0000-4000-8000-000000000000')))
  } finally {
    await harness.cleanup()
  }
})

test('detail serves the record and reconciles an external file change', async () => {
  await withSeededHarness(async (harness) => {
    const first = await jsonOf(await harness.request('/api/cowork.artifact.detail', {
      query: { sessionId: SESSION, artifactId: ARTIFACT },
    }))
    assert.equal(first.ok, true)
    assert.equal(first.record.revision, 1)
    assert.equal(first.eventsSeq, 0)
    assert.equal(first.sessionTitle, 'Spec 主题')
    assert.deepEqual(first.revisions, [])

    await harness.runtime().events // no-op; the runtime is shared
    await writeFile(join(harness.repoPath, 'docs/spec.md'), `${SPEC}\nappended\n`)
    const second = await jsonOf(await harness.request('/api/cowork.artifact.detail', {
      query: { sessionId: SESSION, artifactId: ARTIFACT },
    }))
    assert.equal(second.record.revision, 2)
    assert.equal(second.record.files[0].revision, 2)
    assert.equal(second.record.files[0].sha256, sha256(`${SPEC}\nappended\n`))
    assert.equal(second.eventsSeq, 2)
    const events = await harness.runtime().store.readEvents()
    assert.deepEqual(events.map((event) => event.type), ['file.changed', 'artifact.updated'])
  })
})
test('detail carries dispatch summaries and the retry route re-enqueues a failed batch', async () => {
  const prompts = []
  await withSeededHarness(async (harness) => {
    const failed = {
      version: 1,
      dispatchId: 'dispatch-failed',
      artifactId: ARTIFACT,
      sessionId: SESSION,
      commentIds: ['comment-1'],
      state: 'failed',
      attempts: 3,
      promptRequestId: 'request-failed',
      errorCode: 'artifact/dispatch-unavailable',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    }
    await harness.runtime().store.appendDispatch(failed)
    await harness.runtime().store.appendComment(makeComment({ eventId: 'event-1', commentId: 'comment-1', threadId: 'comment-1' }))
    const detail = await jsonOf(await harness.request('/api/cowork.artifact.detail', {
      query: { sessionId: SESSION, artifactId: ARTIFACT },
    }))
    assert.deepEqual(detail.dispatches, [{
      dispatchId: 'dispatch-failed',
      state: 'failed',
      commentIds: ['comment-1'],
      errorCode: 'artifact/dispatch-unavailable',
      updatedAt: NOW.toISOString(),
    }])
    const response = await harness.request('/api/cowork.artifact.dispatch.retry', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT, dispatchId: 'dispatch-failed' },
    })
    assert.equal(response.status, 200)
    const body = await jsonOf(response)
    assert.notEqual(body.dispatch.dispatchId, 'dispatch-failed')
    assert.equal(body.dispatch.state, 'queued')
    assert.deepEqual(body.dispatch.commentIds, ['comment-1'])

    const unknown = await harness.request('/api/cowork.artifact.dispatch.retry', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT, dispatchId: 'dispatch-missing' },
    })
    assert.equal(unknown.status, 404)
    const invalid = await harness.request('/api/cowork.artifact.dispatch.retry', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT, dispatchId: 7 },
    })
    assert.equal(invalid.status, 400)
    assert.equal(prompts.length, 0)
  }, { prompt: { async prompt(request) { prompts.push(request); return { accepted: true } } }, dispatch: { windowMs: 10_000 } })
})
test('the retry route refuses a runtime without a delivery port', async () => {
  const harness = await createHarness({ files: { 'docs/spec.md': SPEC } })
  try {
    await harness.runtime().store.createRecord(makeRecord({ files: [specFile()] }))
    const response = await harness.request('/api/cowork.artifact.dispatch.retry', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT, dispatchId: 'dispatch-missing' },
    })
    assert.equal(response.status, 501)
    assert.equal((await jsonOf(response)).error.code, 'artifact/dispatch-unavailable')
  } finally {
    await harness.cleanup()
  }
})

test('detail refuses an unknown id, a foreign project, and a corrupt record', async () => {
  await withSeededHarness(async (harness) => {
    const unknown = await harness.request('/api/cowork.artifact.detail', {
      query: { sessionId: SESSION, artifactId: 'artifact-ffffffff-ffff-4fff-8fff-ffffffffffff' },
    })
    assert.equal(unknown.status, 404)
    assert.equal((await jsonOf(unknown)).error.code, 'artifact/not-found')

    await harness.runtime().store.createRecord(makeRecord({
      artifactId: 'artifact-22222222-2222-4222-8222-222222222222',
      projectId: 'other-project',
    }))
    const foreign = await harness.request('/api/cowork.artifact.detail', {
      query: { sessionId: SESSION, artifactId: 'artifact-22222222-2222-4222-8222-222222222222' },
    })
    assert.equal(foreign.status, 403)
    assert.equal((await jsonOf(foreign)).error.code, 'artifact/session-mismatch')

    const corruptDir = join(harness.repoPath, '.dsh-cowork', 'artifacts', 'artifact-33333333-3333-4333-8333-333333333333')
    await mkdir(corruptDir, { recursive: true })
    await writeFile(join(corruptDir, 'artifact.json'), '{broken')
    const corrupt = await harness.request('/api/cowork.artifact.detail', {
      query: { sessionId: SESSION, artifactId: 'artifact-33333333-3333-4333-8333-333333333333' },
    })
    assert.equal(corrupt.status, 500)
    assert.equal((await jsonOf(corrupt)).error.code, 'artifact/corrupt')

    const missingParam = await harness.request('/api/cowork.artifact.detail', { query: { sessionId: SESSION } })
    assert.equal(missingParam.status, 400)
  })
})

test('the file route serves text and refuses unregistered or binary paths', async () => {
  await withSeededHarness(async (harness) => {
    const response = await harness.request('/api/cowork.artifact.file', {
      query: { sessionId: SESSION, artifactId: ARTIFACT, path: 'docs/spec.md' },
    })
    assert.equal(response.status, 200)
    const body = await jsonOf(response)
    assert.equal(body.content, SPEC)
    assert.equal(body.sha256, sha256(SPEC))
    assert.equal(body.revision, 1)

    const unregistered = await harness.request('/api/cowork.artifact.file', {
      query: { sessionId: SESSION, artifactId: ARTIFACT, path: 'docs/other.md' },
    })
    assert.equal(unregistered.status, 400)
    assert.equal((await jsonOf(unregistered)).error.code, 'artifact/path-not-allowed')
  })
})

test('the file route refuses a binary preview and reports a missing file', async () => {
  const harness = await createHarness({ files: { 'docs/plot.png': 'not-really-a-png' } })
  try {
    await harness.runtime().store.createRecord(makeRecord({
      artifactId: ARTIFACT,
      type: 'image',
      files: [specFile('not-really-a-png', { path: 'docs/plot.png', mediaType: 'image/png', editable: false })],
      primaryPath: 'docs/plot.png',
    }))
    const binary = await harness.request('/api/cowork.artifact.file', {
      query: { sessionId: SESSION, artifactId: ARTIFACT, path: 'docs/plot.png' },
    })
    assert.equal(binary.status, 415)
    assert.equal((await jsonOf(binary)).error.code, 'artifact/not-previewable')
  } finally {
    await harness.cleanup()
  }

  const helper = await createHarness({ files: { 'docs/spec.md': SPEC } })
  try {
    await helper.runtime().store.createRecord(makeRecord({ files: [specFile()] }))
    await writeFile(join(helper.repoPath, 'docs/spec.md'), SPEC)
    const { rm } = await import('node:fs/promises')
    await rm(join(helper.repoPath, 'docs/spec.md'))
    const missing = await helper.request('/api/cowork.artifact.file', {
      query: { sessionId: SESSION, artifactId: ARTIFACT, path: 'docs/spec.md' },
    })
    assert.equal(missing.status, 404)
    assert.equal((await jsonOf(missing)).error.code, 'artifact/file-missing')
  } finally {
    await helper.cleanup()
  }
})

test('a host without ctx.fs answers 501 on file reads but keeps the list working', async () => {
  const harness = await createHarness({ files: { 'docs/spec.md': SPEC }, hostFs: null })
  try {
    await harness.runtime().store.createRecord(makeRecord({ files: [specFile()] }))
    const list = await harness.request('/api/cowork.artifact.list', { query: { sessionId: SESSION } })
    assert.equal(list.status, 200)
    const file = await harness.request('/api/cowork.artifact.file', {
      query: { sessionId: SESSION, artifactId: ARTIFACT, path: 'docs/spec.md' },
    })
    assert.equal(file.status, 501)
    assert.equal((await jsonOf(file)).error.code, 'artifact/fs-unavailable')
  } finally {
    await harness.cleanup()
  }
})

test('comments page from the newest row and accept both cursors', async () => {
  await withSeededHarness(async (harness) => {
    const store = harness.runtime().store
    for (let index = 0; index < 3; index += 1) await store.appendComment(makeComment({ commentId: `comment-${index}`, eventId: `event-${index}` }))
    const commentsAt = (query) => harness.request('/api/cowork.artifact.comments', { query: { sessionId: SESSION, artifactId: ARTIFACT, ...query } })
    const latest = await jsonOf(await commentsAt({ limit: '2' }))
    assert.deepEqual(latest.events.map((event) => event.commentId), ['comment-1', 'comment-2'])
    assert.equal(latest.truncated, false)
    assert.equal(latest.hasOlder, true)
    const older = await jsonOf(await commentsAt({ before: 'event-1', limit: '1' }))
    assert.deepEqual(older.events.map((event) => event.commentId), ['comment-0'])
    assert.equal(older.hasOlder, false)
    const forward = await jsonOf(await commentsAt({ after: 'event-0', limit: '1' }))
    assert.deepEqual(forward.events.map((event) => event.commentId), ['comment-1'])
    assert.equal(forward.truncated, true)
    assert.equal(forward.hasOlder, false)
    const unknown = await commentsAt({ after: 'unknown' })
    assert.equal(unknown.status, 400)
    assert.equal((await jsonOf(unknown)).error.code, 'request/invalid-query')
    const unknownBefore = await commentsAt({ before: 'unknown' })
    assert.equal(unknownBefore.status, 400)
    assert.equal((await jsonOf(unknownBefore)).error.code, 'request/invalid-query')
    const both = await commentsAt({ after: 'event-0', before: 'event-1' })
    assert.equal(both.status, 400)
    assert.equal((await jsonOf(both)).error.code, 'request/invalid-query')
    assert.equal((await commentsAt({ limit: '0' })).status, 400)
    assert.equal((await commentsAt({ limit: String(artifactContract.ARTIFACT_COMMENTS_MAX_LIMIT + 1) })).status, 400)
  })
})

test('creating a comment derives a line anchor from the file', async () => {
  await withSeededHarness(async (harness) => {
    const response = await harness.request('/api/cowork.artifact.comment', {
      method: 'POST',
      body: {
        sessionId: SESSION,
        artifactId: ARTIFACT,
        body: 'tighten this',
        anchor: { kind: 'line-range', path: 'docs/spec.md', startLine: 3, endLine: 4, quote: 'stale quote' },
      },
    })
    assert.equal(response.status, 200)
    const body = await jsonOf(response)
    assert.equal(body.ok, true)
    assert.equal(body.comment.type, 'create')
    assert.equal(body.comment.threadId, body.comment.commentId)
    assert.equal(body.comment.anchor.quote, 'first paragraph\nsecond paragraph')
    assert.equal(body.comment.anchor.contextBefore, '')
    assert.equal(body.comment.fileRevision, 1)
    assert.equal(body.record.status, 'needs-feedback')
    assert.equal(body.record.commentCount, 1)
    assert.equal(body.dispatch, null)
    const events = await harness.runtime().store.readEvents()
    assert.deepEqual(events.map((event) => event.type), ['comment.created', 'artifact.updated'])
    const comments = await jsonOf(await harness.request('/api/cowork.artifact.comments', {
      query: { sessionId: SESSION, artifactId: ARTIFACT },
    }))
    assert.equal(comments.events.length, 1)
  })
})

test('a comment without an anchor is a whole-thread comment', async () => {
  await withSeededHarness(async (harness) => {
    const body = await jsonOf(await harness.request('/api/cowork.artifact.comment', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT, body: 'general note' },
    }))
    assert.equal('anchor' in body.comment, false)
    assert.equal(body.record.commentCount, 1)
  })
})

test('a reply joins the root thread and inherits its anchor', async () => {
  await withSeededHarness(async (harness) => {
    const root = await jsonOf(await harness.request('/api/cowork.artifact.comment', {
      method: 'POST',
      body: {
        sessionId: SESSION,
        artifactId: ARTIFACT,
        body: 'root',
        dispatch: false,
        anchor: { kind: 'line-range', path: 'docs/spec.md', startLine: 3, endLine: 3 },
      },
    }))
    const rootId = root.comment.commentId
    const reply = await jsonOf(await harness.request('/api/cowork.artifact.comment', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT, body: 'answer', threadId: rootId, dispatch: false },
    }))
    assert.equal(reply.comment.type, 'reply')
    assert.equal(reply.comment.threadId, rootId)
    assert.equal('anchor' in reply.comment, false)
    assert.equal(reply.record.commentCount, 2)
    const events = await harness.runtime().store.readEvents()
    assert.deepEqual(events.map((event) => event.type), ['comment.created', 'artifact.updated', 'reply.created', 'artifact.updated'])

    const unknown = await harness.request('/api/cowork.artifact.comment', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT, body: 'x', threadId: 'comment-missing' },
    })
    assert.equal(unknown.status, 404)
    const anchoredReply = await harness.request('/api/cowork.artifact.comment', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT, body: 'x', threadId: rootId, anchor: { kind: 'whole', path: 'docs/spec.md' } },
    })
    assert.equal(anchoredReply.status, 400)
    const emptyThread = await harness.request('/api/cowork.artifact.comment', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT, body: 'x', threadId: '' },
    })
    assert.equal(emptyThread.status, 400)
  })
})

test('comment validation refuses the bad shapes with stable codes', async () => {
  await withSeededHarness(async (harness) => {
    const cases = [
      [{ sessionId: SESSION, artifactId: ARTIFACT, body: '   ' }, 400, 'request/invalid-body'],
      [{ sessionId: SESSION, artifactId: ARTIFACT, body: 'x', dispatch: true }, 200, null],
      [{ sessionId: SESSION, artifactId: ARTIFACT, body: 'x', anchor: 'nope' }, 400, 'artifact/anchor-invalid'],
      [{ sessionId: SESSION, artifactId: ARTIFACT, body: 'x', anchor: { kind: 'whole', path: 'docs/other.md' } }, 400, 'artifact/path-not-allowed'],
      [{ sessionId: SESSION, artifactId: ARTIFACT, body: 'x', anchor: { kind: 'line-range', path: 'docs/spec.md', startLine: 99, endLine: 99 } }, 400, 'artifact/anchor-invalid'],
      [{ sessionId: SESSION, artifactId: ARTIFACT, body: 'x'.repeat(artifactContract.MAX_ARTIFACT_COMMENT_CHARS + 1) }, 400, 'request/invalid-body'],
      [{ sessionId: SESSION, artifactId: ARTIFACT, body: 'x', anchor: { kind: 'block', path: 'docs/spec.md', quote: 'q' } }, 200, null],
      [{ sessionId: SESSION, artifactId: 'artifact-ffffffff-ffff-4fff-8fff-ffffffffffff', body: 'x' }, 404, 'artifact/not-found'],
    ]
    for (const [payload, status, code] of cases) {
      const response = await harness.request('/api/cowork.artifact.comment', { method: 'POST', body: payload })
      assert.equal(response.status, status, JSON.stringify(payload).slice(0, 120))
      if (code !== null) assert.equal((await jsonOf(response)).error.code, code)
    }
    const invalidJson = await harness.request('/api/cowork.artifact.comment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: undefined,
    })
    assert.equal(invalidJson.status, 400)
  })
})

test('a line anchor on a non-text file is refused', async () => {
  const harness = await createHarness({ files: { 'docs/plot.png': 'x' } })
  try {
    await harness.runtime().store.createRecord(makeRecord({
      artifactId: ARTIFACT,
      type: 'image',
      files: [makeFile({ path: 'docs/plot.png', mediaType: 'image/png', editable: false })],
      primaryPath: 'docs/plot.png',
    }))
    const response = await harness.request('/api/cowork.artifact.comment', {
      method: 'POST',
      body: {
        sessionId: SESSION,
        artifactId: ARTIFACT,
        body: 'x',
        anchor: { kind: 'line-range', path: 'docs/plot.png', startLine: 1, endLine: 1 },
      },
    })
    assert.equal(response.status, 400)
    assert.equal((await jsonOf(response)).error.code, 'artifact/anchor-invalid')
  } finally {
    await harness.cleanup()
  }
})

test('resolve is idempotent and reopen undoes it', async () => {
  await withSeededHarness(async (harness) => {
    const create = await jsonOf(await harness.request('/api/cowork.artifact.comment', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT, body: 'thread' },
    }))
    const commentId = create.comment.commentId
    const resolved = await jsonOf(await harness.request('/api/cowork.artifact.comment.resolve', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT, commentId, resolved: true },
    }))
    assert.equal(resolved.changed, true)
    assert.equal(resolved.comment.type, 'resolve')
    const replay = await jsonOf(await harness.request('/api/cowork.artifact.comment.resolve', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT, commentId, resolved: true },
    }))
    assert.equal(replay.changed, false)
    assert.equal(replay.comment, null)
    const reopened = await jsonOf(await harness.request('/api/cowork.artifact.comment.resolve', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT, commentId, resolved: false },
    }))
    assert.equal(reopened.changed, true)
    assert.equal(reopened.comment.type, 'reopen')

    const unknown = await harness.request('/api/cowork.artifact.comment.resolve', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT, commentId: 'comment-missing', resolved: true },
    })
    assert.equal(unknown.status, 404)
    const invalid = await harness.request('/api/cowork.artifact.comment.resolve', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT, commentId, resolved: 'yes' },
    })
    assert.equal(invalid.status, 400)
  })
})

test('status view opens once, confirm accepts, and both report changes', async () => {
  await withSeededHarness(async (harness) => {
    const expected = [
      ['view', 'pending-confirm', true],
      ['view', 'pending-confirm', false],
      ['confirm', 'confirmed', true],
      ['confirm', 'confirmed', false],
    ]
    for (const [action, status, changed] of expected) {
      const response = await harness.request('/api/cowork.artifact.status', {
        method: 'POST',
        body: { sessionId: SESSION, artifactId: ARTIFACT, action },
      })
      assert.equal(response.status, 200)
      const body = await jsonOf(response)
      assert.equal(body.ok, true)
      assert.equal(body.record.status, status, `${action} status`)
      assert.equal(body.changed, changed, `${action} changed`)
    }
    const final = await jsonOf(await harness.request('/api/cowork.artifact.status', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT, action: 'confirm' },
    }))
    assert.equal(final.record.status, 'confirmed')
    assert.equal(final.changed, false)
    const invalid = await harness.request('/api/cowork.artifact.status', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT, action: 'archive' },
    })
    assert.equal(invalid.status, 400)
    const events = await harness.runtime().store.readEvents()
    assert.equal(events.filter((event) => event.type === 'artifact.updated').length, 2)
  })
})

test('a failed snapshot during reconcile is swallowed, not returned', async () => {
  const fakeRuntime = {
    fsAvailable: true,
    files: {
      async stat() {
        return { exists: true, regular: true, size: 1, version: 'v2' }
      },
      async readText() {
        return { content: 'x', size: 1, version: 'v2' }
      },
      async writeText() {
        return { version: null, before: null }
      },
    },
    events: { publish() {} },
  }
  fakeRuntime.store = {
    async withLock(operation) {
      return operation()
    },
    async readRecord() {
      return makeRecord({ files: [specFile()] })
    },
    async mutateRecordUnlocked() {
      return makeRecord({
        files: [makeFile({ revision: 2, sha256: sha256('x'), size: 1, fsVersion: 'v2' })],
        revision: 2,
      })
    },
    async appendEventUnlocked(_event) {
      return { version: 1, seq: 1, eventId: 'e', type: 'file.changed', artifactId: ARTIFACT, time: NOW.toISOString(), data: {} }
    },
    async readComments() {
      return []
    },
    async appendCommentUnlocked() {},
    async saveRevision() {
      throw new Error('snapshot write failed')
    },
  }
  const result = await artifactApi.reconcileRecord(
    fakeRuntime,
    makeRecord({ files: [makeFile({ sha256: sha256('old'), size: 3, fsVersion: 'v1' })] }),
    NOW,
  )
  assert.equal(result.record.revision, 2)
})

test('a reconcile observation loses to a newer save made before its lock', async () => {
  let mutated = false
  const fakeRuntime = {
    fsAvailable: true,
    files: {
      async stat() {
        return { exists: true, regular: true, size: 5, version: 'v2' }
      },
      async readText() {
        return { content: 'fresh', size: 5, version: 'v2' }
      },
      async writeText() {
        throw new Error('read-only')
      },
    },
    store: {
      async withLock(operation) {
        return operation()
      },
      async readRecord() {
        return makeRecord({
          files: [makeFile({ revision: 2, sha256: sha256('winner'), size: 6, fsVersion: 'v2' })],
          revision: 2,
        })
      },
      async mutateRecordUnlocked() {
        mutated = true
        throw new Error('must not overwrite a newer save')
      },
      async appendEventUnlocked() {
        throw new Error('must not append for a discarded observation')
      },
      async saveRevision() {
        throw new Error('must not snapshot a discarded observation')
      },
    },
    events: { publish() {} },
  }
  const result = await artifactApi.reconcileRecord(
    fakeRuntime,
    makeRecord({ files: [makeFile({ revision: 1, sha256: sha256('old'), size: 3, fsVersion: 'v1' })] }),
    NOW,
  )
  assert.equal(mutated, false)
  assert.equal(result.record.revision, 2)
  assert.equal(result.record.files[0].sha256, sha256('winner'))
  assert.deepEqual(result.events, [])
})

test('reconcile refuses a record that vanished before its lock', async () => {
  const fakeRuntime = {
    fsAvailable: true,
    files: {
      async stat() {
        return { exists: true, regular: true, size: 1, version: 'v1' }
      },
      async readText() {
        return { content: 'x', size: 1, version: 'v1' }
      },
      async writeText() {
        return { version: null, before: null }
      },
    },
    async store() {},
    events: { publish() {} },
  }
  fakeRuntime.store = {
    async withLock(operation) {
      return operation()
    },
    async readRecord() {
      return null
    },
    async mutateRecordUnlocked() {
      throw new Error('must not write a vanished record')
    },
    async appendEventUnlocked() {
      throw new Error('must not append for a vanished record')
    },
  }
  const record = makeRecord({ files: [specFile()] })
  await assert.rejects(
    artifactApi.reconcileRecord(fakeRuntime, record, NOW),
    (error) => {
      assert.equal(error.code, 'artifact/not-found')
      return true
    },
  )
})

test('the SSE route replays by Last-Event-ID and streams live events', async () => {
  await withSeededHarness(async (harness) => {
    const runtime = harness.runtime()
    await runtime.store.appendEvent({
      eventId: 'event-1',
      type: 'artifact.updated',
      artifactId: ARTIFACT,
      time: NOW.toISOString(),
      data: { revision: 1 },
    })
    const response = await harness.request('/api/cowork.artifact.events', {
      query: { sessionId: SESSION },
      headers: { 'last-event-id': '0' },
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/event-stream/)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (!buffer.includes(': ready')) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
    }
    assert.match(buffer, /id: 1/)
    assert.match(buffer, /event: artifact.updated/)

    runtime.events.publish({
      version: 1,
      seq: 2,
      eventId: 'event-2',
      type: 'comment.created',
      artifactId: ARTIFACT,
      time: NOW.toISOString(),
      data: { commentId: 'comment-1' },
    })
    while (!buffer.includes('id: 2')) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
    }
    assert.match(buffer, /event: comment.created/)
    await reader.cancel()

    const noSession = await harness.request('/api/cowork.artifact.events')
    assert.equal(noSession.status, 400)
  })
})

/** Save one revision-1 snapshot for the seeded spec. */
async function seedBaseRevision(harness, content = SPEC) {
  await harness.runtime().store.saveRevision(ARTIFACT, 1, content)
}

/** One edit body with the seeded file's opaque version. */
function editBody(overrides = {}) {
  return {
    sessionId: SESSION,
    artifactId: ARTIFACT,
    path: 'docs/spec.md',
    baseRevision: 1,
    baseVersion: sha256(SPEC),
    content: '# Spec\n\nfirst paragraph\nsecond paragraph\nchanged\n',
    ...overrides,
  }
}

test('a matching base version saves directly and bumps one revision', async () => {
  await withSeededHarness(async (harness) => {
    await seedBaseRevision(harness)
    const body = await jsonOf(await harness.request('/api/cowork.artifact.edit', { method: 'POST', body: editBody() }))
    assert.equal(body.ok, true)
    assert.equal(body.merged, false)
    assert.equal(body.content, editBody().content)
    assert.equal(body.revision, 2)
    assert.equal(body.record.files[0].revision, 2)
    assert.equal(body.record.files[0].sha256, sha256(editBody().content))
    assert.equal(await harness.runtime().store.readRevision(ARTIFACT, 2), editBody().content)
    const events = await harness.runtime().store.readEvents()
    assert.deepEqual(events.slice(-2).map((event) => event.type), ['file.changed', 'artifact.updated'])
  })
})

test('an edit relocates line threads and emits comment.updated', async () => {
  await withSeededHarness(async (harness) => {
    await seedBaseRevision(harness)
    const created = await jsonOf(await harness.request('/api/cowork.artifact.comment', {
      method: 'POST',
      body: {
        sessionId: SESSION,
        artifactId: ARTIFACT,
        body: 'this paragraph',
        dispatch: false,
        anchor: { kind: 'line-range', path: 'docs/spec.md', startLine: 3, endLine: 3 },
      },
    }))
    const commentId = created.comment.commentId
    const content = '# Spec\n\ninserted\nfirst paragraph\nsecond paragraph\n'
    const saved = await jsonOf(await harness.request('/api/cowork.artifact.edit', {
      method: 'POST',
      body: editBody({ content }),
    }))
    assert.equal(saved.ok, true)
    const comments = await harness.runtime().store.readComments(ARTIFACT)
    const moved = comments.filter((event) => event.type === 'anchor-moved')
    assert.equal(moved.length, 1)
    assert.equal(moved[0].commentId, commentId)
    assert.equal(moved[0].anchorStatus, 'moved')
    assert.equal(moved[0].anchor.startLine, 4)
    const events = await harness.runtime().store.readEvents()
    assert.deepEqual(events.slice(-3).map((event) => event.type), ['file.changed', 'comment.updated', 'artifact.updated'])

    // A second save of unchanged content must not append another relocation.
    const unchangedSave = await jsonOf(await harness.request('/api/cowork.artifact.edit', {
      method: 'POST',
      body: editBody({ content, baseRevision: 2, baseVersion: saved.fsVersion }),
    }))
    assert.equal((await harness.runtime().store.readComments(ARTIFACT)).filter((event) => event.type === 'anchor-moved').length, 1)

    // Deleting the quoted line marks the thread stale once; repeated reads do
    // not append another stale row.
    const deleted = await jsonOf(await harness.request('/api/cowork.artifact.edit', {
      method: 'POST',
      body: editBody({ content: '# Spec\n\ninserted\nsecond paragraph\n', baseRevision: 2, baseVersion: unchangedSave.fsVersion }),
    }))
    assert.equal(deleted.ok, true)
    const staleComments = await harness.runtime().store.readComments(ARTIFACT)
    assert.deepEqual(
      staleComments.filter((event) => event.type === 'anchor-moved').map((event) => event.anchorStatus),
      ['moved', 'stale'],
    )
    for (let index = 0; index < 2; index += 1) {
      await harness.request('/api/cowork.artifact.detail', { query: { sessionId: SESSION, artifactId: ARTIFACT } })
    }
    assert.equal((await harness.runtime().store.readComments(ARTIFACT)).filter((event) => event.type === 'anchor-moved').length, 2)
  })
})

test('saving identical content is a no-op with no revision bump', async () => {
  await withSeededHarness(async (harness) => {
    await seedBaseRevision(harness)
    const body = await jsonOf(await harness.request('/api/cowork.artifact.edit', {
      method: 'POST',
      body: editBody({ content: SPEC }),
    }))
    assert.equal(body.ok, true)
    assert.equal(body.revision, 1)
    assert.equal(body.record.revision, 1)
  })
})

test('a stale save merges a non-overlapping model change', async () => {
  await withSeededHarness(async (harness) => {
    await seedBaseRevision(harness)
    // The model changed the last line while the browser held revision 1.
    await writeFile(join(harness.repoPath, 'docs/spec.md'), SPEC.replace('second paragraph', 'MODEL LINE'))
    const body = await jsonOf(await harness.request('/api/cowork.artifact.edit', {
      method: 'POST',
      body: editBody({
        baseVersion: sha256(SPEC),
        content: SPEC.replace('first paragraph', 'USER LINE'),
      }),
    }))
    assert.equal(body.ok, true)
    assert.equal(body.merged, true)
    assert.equal(body.content, '# Spec\n\nUSER LINE\nMODEL LINE\n')
    assert.equal(body.record.files[0].revision, 3)
  })
})

test('an overlapping stale save returns 409 with conflict ranges and writes nothing', async () => {
  await withSeededHarness(async (harness) => {
    await seedBaseRevision(harness)
    await writeFile(join(harness.repoPath, 'docs/spec.md'), SPEC.replace('first paragraph', 'MODEL LINE'))
    const response = await harness.request('/api/cowork.artifact.edit', {
      method: 'POST',
      body: editBody({ content: SPEC.replace('first paragraph', 'USER LINE') }),
    })
    assert.equal(response.status, 409)
    const body = await jsonOf(response)
    assert.equal(body.error.code, 'artifact/version-conflict')
    assert.deepEqual(body.conflictRanges, [{ startLine: 3, endLine: 3 }])
    const read = await harness.runtime().files.readText('docs/spec.md')
    assert.equal(read.content, SPEC.replace('first paragraph', 'MODEL LINE'))
  })
})

test('a stale save without a base snapshot refuses to guess', async () => {
  await withSeededHarness(async (harness) => {
    await writeFile(join(harness.repoPath, 'docs/spec.md'), `${SPEC}model\n`)
    const response = await harness.request('/api/cowork.artifact.edit', {
      method: 'POST',
      body: editBody({ content: `${SPEC}user\n` }),
    })
    assert.equal(response.status, 409)
    const body = await jsonOf(response)
    assert.equal(body.error.code, 'artifact/version-conflict')
    assert.equal(body.conflictRanges.length, 1)
    assert.equal(body.conflictRanges[0].startLine, 1)
    assert.equal(body.conflictRanges[0].endLine, 5)
  })
})

test('a concurrent write is merged and retried once', async () => {
  const harness = await createHarness({
    files: { 'docs/spec.md': SPEC },
    fsOptions: { staleOnFirstWrite: ['docs/spec.md'] },
  })
  try {
    await harness.runtime().store.createRecord(makeRecord({ files: [specFile()] }))
    await harness.runtime().store.saveRevision(ARTIFACT, 1, SPEC)
    const response = await harness.request('/api/cowork.artifact.edit', {
      method: 'POST',
      body: editBody({ content: SPEC.replace('first paragraph', 'USER LINE') }),
    })
    assert.equal(response.status, 200)
    const body = await jsonOf(response)
    assert.equal(body.merged, true)
    assert.match(body.content, /USER LINE/)
    assert.match(body.content, /concurrent-model-line/)
  } finally {
    await harness.cleanup()
  }
})

test('a permanent write race gives up with a conflict after two retries', async () => {
  const harness = await createHarness({
    files: { 'docs/spec.md': SPEC },
    fsOptions: { staleAlways: ['docs/spec.md'] },
  })
  try {
    await harness.runtime().store.createRecord(makeRecord({ files: [specFile()] }))
    await harness.runtime().store.saveRevision(ARTIFACT, 1, SPEC)
    const response = await harness.request('/api/cowork.artifact.edit', {
      method: 'POST',
      body: editBody({ content: SPEC.replace('first paragraph', 'USER LINE') }),
    })
    assert.equal(response.status, 409)
    const body = await jsonOf(response)
    assert.equal(body.error.code, 'artifact/version-conflict')
    assert.deepEqual(body.conflictRanges, [{ startLine: 1, endLine: 4 }])
  } finally {
    await harness.cleanup()
  }
})

test('a non-conflict write failure is returned with its own code', async () => {
  const harness = await createHarness({
    files: { 'docs/spec.md': SPEC },
    fsOptions: { writeFailures: new Map([['docs/spec.md', 'FS_TOO_LARGE']]) },
  })
  try {
    await harness.runtime().store.createRecord(makeRecord({ files: [specFile()] }))
    await harness.runtime().store.saveRevision(ARTIFACT, 1, SPEC)
    const response = await harness.request('/api/cowork.artifact.edit', { method: 'POST', body: editBody() })
    assert.equal(response.status, 413)
    assert.equal((await jsonOf(response)).error.code, 'artifact/file-too-large')
  } finally {
    await harness.cleanup()
  }
})

test('a failed revision snapshot does not fail the committed save', async () => {
  const harness = await createHarness({ files: { 'docs/spec.md': SPEC } })
  try {
    await harness.runtime().store.createRecord(makeRecord({ files: [specFile()] }))
    await harness.runtime().store.saveRevision(ARTIFACT, 1, SPEC)
    // A file where the revision directory belongs makes the snapshot write fail.
    const revisions = join(harness.repoPath, '.dsh-cowork', 'artifacts', ARTIFACT, 'revisions')
    const { rm } = await import('node:fs/promises')
    await rm(revisions, { recursive: true, force: true })
    await writeFile(revisions, 'not a directory')
    const response = await harness.request('/api/cowork.artifact.edit', { method: 'POST', body: editBody() })
    assert.equal(response.status, 200)
    const body = await jsonOf(response)
    assert.equal(body.revision, 2)
  } finally {
    await harness.cleanup()
  }
})

test('the text line cap refuses a save before writing', async () => {
  await withSeededHarness(async (harness) => {
    await seedBaseRevision(harness)
    const content = Array.from({ length: artifactContract.MAX_ARTIFACT_TEXT_LINES + 1 }, () => 'x').join('\n')
    const response = await harness.request('/api/cowork.artifact.edit', {
      method: 'POST',
      body: editBody({ content }),
    })
    assert.equal(response.status, 413)
    assert.equal((await jsonOf(response)).error.code, 'artifact/file-too-large')
  })
})

test('edit validation keeps its stable codes', async () => {
  await withSeededHarness(async (harness) => {
    const cases = [
      [editBody({ content: 7 }), 400, 'request/invalid-body'],
      [editBody({ baseRevision: 0 }), 400, 'request/invalid-body'],
      [editBody({ path: 'docs/other.md' }), 400, 'artifact/path-not-allowed'],
      [editBody({ content: 'x'.repeat(5 * 1024 * 1024 + 1) }), 413, 'artifact/file-too-large'],
      [editBody({ sessionId: '   ' }), 400, 'request/invalid-body'],
    ]
    for (const [payload, status, code] of cases) {
      const response = await harness.request('/api/cowork.artifact.edit', { method: 'POST', body: payload })
      assert.equal(response.status, status, JSON.stringify(payload).slice(0, 100))
      assert.equal((await jsonOf(response)).error.code, code)
    }
  })
})

test('a non-editable or non-text file refuses the save', async () => {
  const harness = await createHarness({ files: { 'docs/plot.png': 'x' } })
  try {
    await harness.runtime().store.createRecord(makeRecord({
      artifactId: ARTIFACT,
      type: 'image',
      files: [makeFile({ path: 'docs/plot.png', mediaType: 'image/png', editable: false })],
      primaryPath: 'docs/plot.png',
    }))
    const response = await harness.request('/api/cowork.artifact.edit', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT, path: 'docs/plot.png', baseRevision: 1, content: 'x' },
    })
    assert.equal(response.status, 409)
    assert.equal((await jsonOf(response)).error.code, 'artifact/not-editable')
  } finally {
    await harness.cleanup()
  }
})

test('presence reports its TTL and validates the ranges', async () => {
  await withSeededHarness(async (harness) => {
    const response = await harness.request('/api/cowork.artifact.presence', {
      method: 'POST',
      body: {
        sessionId: SESSION,
        artifactId: ARTIFACT,
        path: 'docs/spec.md',
        ranges: [{ startLine: 2, endLine: 3 }],
      },
    })
    assert.equal(response.status, 200)
    const body = await jsonOf(response)
    assert.equal(body.ok, true)
    assert.equal(body.ttlMs, artifactContract.ARTIFACT_PRESENCE_TTL_MS)
    const absolute = `${harness.repoPath}/docs/spec.md`
    assert.deepEqual(harness.runtime().presence.activeRanges(absolute), [{ startLine: 2, endLine: 3 }])

    const cases = [
      [{ ranges: [] }, 400],
      [{ ranges: [{ startLine: 0, endLine: 1 }] }, 400],
      [{ ranges: [{ startLine: 3, endLine: 2 }] }, 400],
      [{ ranges: [{ startLine: 1.5, endLine: 2 }] }, 400],
      [{ ranges: [null] }, 400],
      [{ ranges: Array.from({ length: artifactContract.MAX_PRESENCE_RANGES + 1 }, () => ({ startLine: 1, endLine: 1 })) }, 400],
      [{ path: 'docs/other.md' }, 400],
    ]
    for (const [override, status] of cases) {
      const bad = await harness.request('/api/cowork.artifact.presence', {
        method: 'POST',
        body: {
          sessionId: SESSION,
          artifactId: ARTIFACT,
          path: 'docs/spec.md',
          ranges: [{ startLine: 1, endLine: 1 }],
          ...override,
        },
      })
      assert.equal(bad.status, status, JSON.stringify(override).slice(0, 80))
    }
  })
})
test('a full dispatch queue keeps the comment and reports no dispatch', async () => {
  const harness = await createHarness({
    files: { 'docs/spec.md': SPEC },
    prompt: { async prompt() { return { accepted: true } } },
    dispatch: { windowMs: 60_000, maxQueuePerSession: 0 },
  })
  try {
    await harness.runtime().store.createRecord(makeRecord({ files: [specFile()] }))
    const response = await harness.request('/api/cowork.artifact.comment', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT, body: 'still saved' },
    })
    assert.equal(response.status, 200)
    const body = await jsonOf(response)
    assert.equal(body.dispatch, null)
    assert.equal(body.record.commentCount, 1)
    assert.ok(harness.logs.some((message) => message.includes('dispatch not queued')))
  } finally {
    await harness.cleanup()
  }
})
test('a comment queues a dispatch when the runtime has a prompt port', async () => {
  const prompts = []
  const harness = await createHarness({
    files: { 'docs/spec.md': SPEC },
    prompt: {
      async prompt(request) {
        prompts.push(request)
        return { accepted: true }
      },
    },
    dispatch: { windowMs: 1 },
  })
  try {
    await harness.runtime().store.createRecord(makeRecord({ files: [specFile()] }))
    const response = await harness.request('/api/cowork.artifact.comment', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT, body: 'deliver me' },
    })
    assert.equal(response.status, 200)
    const body = await jsonOf(response)
    assert.equal(body.dispatch.state, 'queued')
    assert.equal(body.record.activeDispatch.state, 'queued')
    const deadline = Date.now() + 15_000
    while (prompts.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].sessionId, SESSION)
    const sentDeadline = Date.now() + 5_000
    while (Date.now() < sentDeadline && (await harness.runtime().store.readLatestDispatch(ARTIFACT))?.state !== 'sent') {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal((await harness.runtime().store.readLatestDispatch(ARTIFACT))?.state, 'sent')
  } finally {
    await harness.cleanup()
  }
})

/** SHA-256 helper for assertion values. */
function createHashForTest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

test('a delivery enqueue failure is reported next to the saved comment', async () => {
  await withSeededHarness(async (harness) => {
    const runtime = harness.runtime()
    const original = runtime.dispatch.enqueue.bind(runtime.dispatch)
    runtime.dispatch.enqueue = async () => {
      const { ArtifactDomainError } = await import('../../src/domains/artifact/errors.ts')
      throw new ArtifactDomainError('artifact/dispatch-queue-full', 'session queue holds 10 batches')
    }
    try {
      const response = await harness.request('/api/cowork.artifact.comment', {
        method: 'POST',
        body: { sessionId: SESSION, artifactId: ARTIFACT, body: 'still saved' },
      })
      assert.equal(response.status, 200)
      const body = await jsonOf(response)
      assert.equal(body.ok, true)
      assert.equal(body.dispatch, null)
      assert.equal(body.dispatchError.code, 'artifact/dispatch-queue-full')
      assert.match(body.dispatchError.message, /queue holds 10/)
      assert.equal(body.comment.body, 'still saved')
      assert.equal(body.record.commentCount, 1)
    } finally {
      runtime.dispatch.enqueue = original
    }
  }, { prompt: { async prompt() { return { accepted: true } } } })
})

test('the comment limit is enforced before a row is appended', async () => {
  await withSeededHarness(async (harness) => {
    const runtime = harness.runtime()
    await runtime.store.mutateRecord(ARTIFACT, (record) => ({ ...record, commentCount: 5000 }))
    const response = await harness.request('/api/cowork.artifact.comment', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT, body: 'one too many' },
    })
    assert.equal(response.status, 409)
    const body = await jsonOf(response)
    assert.equal(body.error.code, 'artifact/comment-limit')
    assert.equal((await runtime.store.readComments(ARTIFACT)).length, 0)
  })
})

test('a successful save refreshes the guard text cache', async () => {
  await withSeededHarness(async (harness) => {
    await seedBaseRevision(harness)
    await harness.request('/api/cowork.artifact.file', {
      query: { sessionId: SESSION, artifactId: ARTIFACT, path: 'docs/spec.md' },
    })
    const runtime = harness.runtime()
    const absolute = join(harness.repoPath, 'docs/spec.md')
    runtime.presence.report(absolute, [{ startLine: 2, endLine: 2 }])
    const body = await jsonOf(await harness.request('/api/cowork.artifact.edit', { method: 'POST', body: editBody() }))
    assert.equal(body.ok, true)
    assert.equal(runtime.presence.cachedText(absolute), editBody().content)
  })
})

test('the comment limit also guards resolve events', async () => {
  await withSeededHarness(async (harness) => {
    const runtime = harness.runtime()
    await runtime.store.appendComment(makeComment({ artifactId: ARTIFACT, commentId: 'comment-1', threadId: 'comment-1', eventId: 'e-limit' }))
    await runtime.store.mutateRecord(ARTIFACT, (record) => ({ ...record, commentCount: 5000 }))
    const response = await harness.request('/api/cowork.artifact.comment.resolve', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT, commentId: 'comment-1', resolved: true },
    })
    assert.equal(response.status, 409)
    assert.equal((await jsonOf(response)).error.code, 'artifact/comment-limit')
  })
})
