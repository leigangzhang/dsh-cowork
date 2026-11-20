import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
  const harness = await createHarness({ files: { 'docs/spec.md': SPEC, ...(options.files ?? {}) }, ...options })
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
    assert.equal(harness.routes.size, 18)
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

test('comments paginate with an after cursor', async () => {
  await withSeededHarness(async (harness) => {
    const store = harness.runtime().store
    for (let index = 0; index < 3; index += 1) {
      await store.appendComment(makeComment({ commentId: `comment-${index}`, eventId: `event-${index}` }))
    }
    const first = await jsonOf(await harness.request('/api/cowork.artifact.comments', {
      query: { sessionId: SESSION, artifactId: ARTIFACT, limit: '2' },
    }))
    assert.deepEqual(first.events.map((event) => event.commentId), ['comment-0', 'comment-1'])
    assert.equal(first.truncated, true)
    const second = await jsonOf(await harness.request('/api/cowork.artifact.comments', {
      query: { sessionId: SESSION, artifactId: ARTIFACT, after: 'event-1' },
    }))
    assert.deepEqual(second.events.map((event) => event.commentId), ['comment-2'])
    assert.equal(second.truncated, false)
    const fromStart = await jsonOf(await harness.request('/api/cowork.artifact.comments', {
      query: { sessionId: SESSION, artifactId: ARTIFACT, after: 'unknown' },
    }))
    assert.equal(fromStart.events.length, 3)
    const badLimit = await harness.request('/api/cowork.artifact.comments', {
      query: { sessionId: SESSION, artifactId: ARTIFACT, limit: '0' },
    })
    assert.equal(badLimit.status, 400)
    const hugeLimit = await harness.request('/api/cowork.artifact.comments', {
      query: { sessionId: SESSION, artifactId: ARTIFACT, limit: String(artifactContract.ARTIFACT_COMMENTS_MAX_LIMIT + 1) },
    })
    assert.equal(hugeLimit.status, 400)
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

test('comment validation refuses the bad shapes with stable codes', async () => {
  await withSeededHarness(async (harness) => {
    const cases = [
      [{ sessionId: SESSION, artifactId: ARTIFACT, body: '   ' }, 400, 'request/invalid-body'],
      [{ sessionId: SESSION, artifactId: ARTIFACT, body: 'x', dispatch: true }, 501, 'artifact/dispatch-unavailable'],
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
