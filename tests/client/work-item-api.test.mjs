import test from 'node:test'
import assert from 'node:assert/strict'
import '../support/ts-hook.mjs'
const { createWorkItemApi, WorkItemApiError, workItemApi } = await import('../../src/client/work-item/api.ts')

/**
 * The work-item HTTP client: exact route paths, query building, the one JSON
 * envelope, and the typed error a component presents. Fetch is injected, so no
 * host or network runs here.
 */
function fakeFetch(handler) {
  const calls = []
  const impl = async (input, init) => {
    calls.push({ input, init })
    return handler(input, init)
  }
  return { calls, impl }
}

/** One ok JSON response. */
function ok(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** One error envelope response. */
function failure(status, code, message) {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('every route is built from the shared contract path', async () => {
  const { calls, impl } = fakeFetch(() => ok({ ok: true, items: [], counts: {}, truncated: false }))
  const api = createWorkItemApi(impl)
  await api.list('session-1')
  assert.equal(calls[0].input, '/api/cowork.artifact.list?sessionId=session-1')
  assert.equal(calls[0].init, undefined)
})

test('the list read carries search, merged status, and one abort signal', async () => {
  const { calls, impl } = fakeFetch(() => ok({ ok: true, items: [], counts: {}, truncated: false }))
  const api = createWorkItemApi(impl)
  const controller = new AbortController()
  await api.list('session-1', { q: 'spec', status: 'pending-confirm', signal: controller.signal })
  assert.equal(
    calls[0].input,
    '/api/cowork.artifact.list?sessionId=session-1&q=spec&status=pending-confirm',
  )
  assert.equal(calls[0].init.signal, controller.signal)
  // No signal means no init at all, keeping the simple GET shape.
  await api.list('session-1', { q: 'ready' })
  assert.equal(calls[1].input, '/api/cowork.artifact.list?sessionId=session-1&q=ready')
  assert.equal(calls[1].init, undefined)
  // Empty query/status are omitted rather than sent as empty filters.
  await api.list('session-1', { q: '', status: undefined })
  assert.equal(calls[2].input, '/api/cowork.artifact.list?sessionId=session-1')
})

test('the reads carry the expected query parameters', async () => {
  const { calls, impl } = fakeFetch(() => ok({ ok: true }))
  const api = createWorkItemApi(impl)
  await api.detail('session-1', 'artifact-1')
  await api.file('session-1', 'artifact-1', 'docs/spec.md')
  await api.comments('session-1', 'artifact-1')
  await api.comments('session-1', 'artifact-1', 'event-2')
  assert.deepEqual(calls.map((call) => call.input), [
    '/api/cowork.artifact.detail?sessionId=session-1&artifactId=artifact-1',
    '/api/cowork.artifact.file?sessionId=session-1&artifactId=artifact-1&path=docs%2Fspec.md',
    '/api/cowork.artifact.comments?sessionId=session-1&artifactId=artifact-1&limit=200',
    '/api/cowork.artifact.comments?sessionId=session-1&artifactId=artifact-1&after=event-2&limit=200',
  ])
})

test('a new comment omits dispatch (the host default is delivery) and sends only present extras', async () => {
  const { calls, impl } = fakeFetch(() => ok({ ok: true }))
  const api = createWorkItemApi(impl)
  await api.comment({ sessionId: 's', artifactId: 'a', body: 'hello' })
  const plain = JSON.parse(calls[0].init.body)
  assert.deepEqual(plain, { sessionId: 's', artifactId: 'a', body: 'hello' })
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')

  await api.comment({
    sessionId: 's',
    artifactId: 'a',
    body: 'anchored',
    anchor: { kind: 'line-range', path: 'docs/spec.md', startLine: 2, endLine: 3, quote: 'q' },
    attachments: [{ attachmentId: 'attachment-1', name: 'x.png', mediaType: 'image/png', size: 1, sha256: 'x' }],
  })
  const anchored = JSON.parse(calls[1].init.body)
  assert.equal(anchored.anchor.startLine, 2)
  assert.equal(anchored.attachments.length, 1)
  assert.equal('dispatch' in anchored, false)

  await api.comment({ sessionId: 's', artifactId: 'a', body: 'reply', threadId: 'comment-1' })
  const reply = JSON.parse(calls[2].init.body)
  assert.equal(reply.threadId, 'comment-1')
  assert.equal('anchor' in reply, false)
})

test('retryDispatch posts the batch id to its own route', async () => {
  const { calls, impl } = fakeFetch(() => ok({ ok: true, dispatch: { dispatchId: 'd2' }, record: {} }))
  const api = createWorkItemApi(impl)
  await api.retryDispatch({ sessionId: 's', artifactId: 'a', dispatchId: 'd1' })
  assert.equal(calls[0].input, '/api/cowork.artifact.dispatch.retry')
  assert.deepEqual(JSON.parse(calls[0].init.body), { sessionId: 's', artifactId: 'a', dispatchId: 'd1' })
})

test('open posts to its own route and surfaces the unsupported host', async () => {
  const { calls, impl } = fakeFetch(() => ok({ ok: true }))
  const api = createWorkItemApi(impl)
  await api.open({ sessionId: 's', artifactId: 'a' })
  assert.equal(calls[0].input, '/api/cowork.artifact.open')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), { sessionId: 's', artifactId: 'a' })

  const unsupported = createWorkItemApi(fakeFetch(
    () => failure(501, 'artifact/open-unsupported', 'this host exposes no file-open capability'),
  ).impl)
  await assert.rejects(unsupported.open({ sessionId: 's', artifactId: 'a' }), (error) => {
    assert.ok(error instanceof WorkItemApiError)
    assert.equal(error.code, 'artifact/open-unsupported')
    return true
  })
})

test('resolve and status post their bodies to the contract routes', async () => {
  const { calls, impl } = fakeFetch(() => ok({ ok: true }))
  const api = createWorkItemApi(impl)
  await api.resolveComment({ sessionId: 's', artifactId: 'a', commentId: 'c', resolved: true })
  await api.status({ sessionId: 's', artifactId: 'a', action: 'view' })
  assert.equal(calls[0].input, '/api/cowork.artifact.comment.resolve')
  assert.equal(calls[1].input, '/api/cowork.artifact.status')
  assert.deepEqual(JSON.parse(calls[1].init.body), { sessionId: 's', artifactId: 'a', action: 'view' })
})

test('a failed status becomes a typed error carrying the wire code', async () => {
  const { impl } = fakeFetch(() => failure(404, 'artifact/not-found', 'work item is missing'))
  const api = createWorkItemApi(impl)
  await assert.rejects(api.detail('s', 'a'), (error) => {
    assert.ok(error instanceof WorkItemApiError)
    assert.equal(error.code, 'artifact/not-found')
    assert.equal(error.message, 'work item is missing')
    assert.equal(error.status, 404)
    return true
  })
})

test('a 200 response with ok:false is still an error', async () => {
  const { impl } = fakeFetch(() => ok({ ok: false, error: { code: 'artifact/corrupt', message: 'bad' } }))
  await assert.rejects(createWorkItemApi(impl).list('s'), (error) => {
    assert.equal(error.code, 'artifact/corrupt')
    return true
  })
})

test('an error without a shape still produces a usable failure', async () => {
  const { impl } = fakeFetch(() => new Response('oops', { status: 502 }))
  await assert.rejects(createWorkItemApi(impl).list('s'), (error) => {
    assert.equal(error.code, 'internal')
    assert.match(error.message, /invalid response payload/)
    assert.equal(error.status, 502)
    return true
  })
  const { impl: empty } = fakeFetch(() => new Response('null', { status: 200 }))
  await assert.rejects(createWorkItemApi(empty).list('s'), (error) => {
    assert.equal(error.code, 'internal')
    return true
  })
  const { impl: bareFailure } = fakeFetch(() => new Response(JSON.stringify({ ok: false }), { status: 400 }))
  await assert.rejects(createWorkItemApi(bareFailure).list('s'), (error) => {
    assert.equal(error.code, 'internal')
    assert.match(error.message, /HTTP 400/)
    return true
  })
})

test('a network rejection propagates untouched', async () => {
  const api = createWorkItemApi(async () => {
    throw new TypeError('network down')
  })
  await assert.rejects(api.list('s'), /network down/)
})

test('the plugin exports a callable client instance', () => {
  assert.equal(typeof workItemApi.list, 'function')
  assert.equal(typeof workItemApi.comment, 'function')
})

test('a save posts the base revision, base version, and content', async () => {
  const { calls, impl } = fakeFetch(() => ok({ ok: true, revision: 2 }))
  const api = createWorkItemApi(impl)
  await api.edit({
    sessionId: 's',
    artifactId: 'a',
    path: 'docs/spec.md',
    baseRevision: 1,
    baseVersion: 'v1',
    content: 'new body',
  })
  assert.equal(calls[0].input, '/api/cowork.artifact.edit')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    sessionId: 's',
    artifactId: 'a',
    path: 'docs/spec.md',
    baseRevision: 1,
    baseVersion: 'v1',
    content: 'new body',
  })
})

test('a 409 save throws an error carrying the conflict ranges', async () => {
  const { impl } = fakeFetch(() => new Response(JSON.stringify({
    ok: false,
    error: { code: 'artifact/version-conflict', message: 'changed' },
    currentVersion: 'v2',
    revision: 3,
    conflictRanges: [{ startLine: 2, endLine: 4 }],
  }), { status: 409 }))
  const api = createWorkItemApi(impl)
  await assert.rejects(api.edit({
    sessionId: 's',
    artifactId: 'a',
    path: 'docs/spec.md',
    baseRevision: 1,
    baseVersion: 'v1',
    content: 'x',
  }), (error) => {
    assert.ok(error instanceof WorkItemApiError)
    assert.equal(error.code, 'artifact/version-conflict')
    assert.deepEqual(error.conflict, {
      currentVersion: 'v2',
      revision: 3,
      conflictRanges: [{ startLine: 2, endLine: 4 }],
    })
    return true
  })
})

test('presence posts the ranges to its own route', async () => {
  const { calls, impl } = fakeFetch(() => ok({ ok: true, ttlMs: 5000 }))
  const api = createWorkItemApi(impl)
  const result = await api.presence({
    sessionId: 's',
    artifactId: 'a',
    path: 'docs/spec.md',
    ranges: [{ startLine: 2, endLine: 3 }],
  })
  assert.equal(result.ttlMs, 5000)
  assert.equal(calls[0].input, '/api/cowork.artifact.presence')
  assert.deepEqual(JSON.parse(calls[0].init.body).ranges, [{ startLine: 2, endLine: 3 }])
})

test('an upload posts raw bytes with the name in the query', async () => {
  const { calls, impl } = fakeFetch(() => ok({ ok: true, attachment: { attachmentId: 'attachment-1' } }))
  const api = createWorkItemApi(impl)
  const result = await api.upload({
    sessionId: 's',
    artifactId: 'a',
    name: 'shot.png',
    bytes: new Uint8Array([1, 2, 3]),
  })
  assert.equal(result.attachment.attachmentId, 'attachment-1')
  assert.equal(calls[0].input, '/api/cowork.artifact.upload?sessionId=s&artifactId=a&name=shot.png')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['content-type'], 'application/octet-stream')
  assert.deepEqual([...calls[0].init.body], [1, 2, 3])
})

test('the attachment URL is the same-origin read route', () => {
  const api = createWorkItemApi(async () => ok({ ok: true }))
  assert.equal(
    api.attachmentUrl({ sessionId: 's', artifactId: 'a', attachmentId: 'attachment-1' }),
    '/api/cowork.artifact.attachment?sessionId=s&artifactId=a&attachmentId=attachment-1',
  )
})

test('a rebind posts the old and new path to the frozen route', async () => {
  const record = { artifactId: 'a', primaryPath: 'docs/found.md', files: [{ path: 'docs/found.md', missing: false }] }
  const { calls, impl } = fakeFetch(() => ok({ ok: true, changed: true, record }))
  const api = createWorkItemApi(impl)
  const result = await api.rebind({
    sessionId: 's',
    artifactId: 'a',
    oldPath: 'docs/gone.md',
    newPath: 'docs/found.md',
  })
  assert.equal(calls[0].input, '/api/cowork.artifact.rebind')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    sessionId: 's',
    artifactId: 'a',
    oldPath: 'docs/gone.md',
    newPath: 'docs/found.md',
  })
  assert.equal(result.changed, true)
  assert.equal(result.record.primaryPath, 'docs/found.md')
})

test('a same-path rebind reports changed:false instead of inventing a move', async () => {
  const { impl } = fakeFetch(() => ok({ ok: true, changed: false, record: { artifactId: 'a' } }))
  const result = await createWorkItemApi(impl).rebind({
    sessionId: 's',
    artifactId: 'a',
    oldPath: 'docs/held.md',
    newPath: 'docs/held.md',
  })
  assert.equal(result.changed, false)
})

test('a failed rebind carries the wire code and reason', async () => {
  const { impl } = fakeFetch(() => failure(404, 'artifact/file-missing', 'docs/nope.md is not in the project'))
  await assert.rejects(createWorkItemApi(impl).rebind({
    sessionId: 's',
    artifactId: 'a',
    oldPath: 'docs/gone.md',
    newPath: 'docs/nope.md',
  }), (error) => {
    assert.ok(error instanceof WorkItemApiError)
    assert.equal(error.code, 'artifact/file-missing')
    assert.equal(error.message, 'docs/nope.md is not in the project')
    assert.equal(error.status, 404)
    return true
  })
  const { impl: forbidden } = fakeFetch(() => failure(400, 'artifact/path-not-allowed', 'path escapes the project'))
  await assert.rejects(createWorkItemApi(forbidden).rebind({
    sessionId: 's',
    artifactId: 'a',
    oldPath: 'docs/gone.md',
    newPath: '../outside.md',
  }), (error) => {
    assert.equal(error.code, 'artifact/path-not-allowed')
    return true
  })
})

test('the comments page carries hasOlder and reads older pages by before', async () => {
  const { calls, impl } = fakeFetch(() => ok({ ok: true, events: [], truncated: false, hasOlder: true }))
  const api = createWorkItemApi(impl)
  const page = await api.comments('s', 'a')
  assert.equal(calls[0].input, '/api/cowork.artifact.comments?sessionId=s&artifactId=a&limit=200')
  assert.equal(page.hasOlder, true)
  await api.comments('s', 'a', undefined, 'event-1')
  assert.equal(calls[1].input, '/api/cowork.artifact.comments?sessionId=s&artifactId=a&before=event-1&limit=200')
  await api.comments('s', 'a', 'event-9')
  assert.equal(calls[2].input, '/api/cowork.artifact.comments?sessionId=s&artifactId=a&after=event-9&limit=200')
})
