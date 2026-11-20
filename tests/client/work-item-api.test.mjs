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
    '/api/cowork.artifact.comments?sessionId=session-1&artifactId=artifact-1',
    '/api/cowork.artifact.comments?sessionId=session-1&artifactId=artifact-1&after=event-2',
  ])
})

test('a new comment always sends dispatch:false and only sends an anchor when present', async () => {
  const { calls, impl } = fakeFetch(() => ok({ ok: true }))
  const api = createWorkItemApi(impl)
  await api.comment({ sessionId: 's', artifactId: 'a', body: 'hello' })
  const plain = JSON.parse(calls[0].init.body)
  assert.deepEqual(plain, { sessionId: 's', artifactId: 'a', body: 'hello', dispatch: false })
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')

  await api.comment({
    sessionId: 's',
    artifactId: 'a',
    body: 'anchored',
    anchor: { kind: 'line-range', path: 'docs/spec.md', startLine: 2, endLine: 3, quote: 'q' },
  })
  const anchored = JSON.parse(calls[1].init.body)
  assert.equal(anchored.anchor.startLine, 2)
  assert.equal(anchored.dispatch, false)
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
