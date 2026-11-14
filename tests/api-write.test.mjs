import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import './support/ts-hook.mjs'
// The workflow guard requires every API route suite to load the shared
// public surface; the route-count assertions use PANEL_ROUTES.
import { PANEL_ROUTES } from './support/public-surface.mjs'
import {
  api,
  contract,
  inboxContract,
  reviewRequest,
  store,
  panelProbe,
  requestService,
  CREATED_AT,
  NOW,
  STALE,
  HOST,
  ORIGIN,
  MASTER,
  OTHER_SESSION,
  makeTopic,
  makeWorkItem,
  makeDocument,
  makeEvent,
  makeInboxItem,
  fakePorts,
  fakeHost,
  fakeConnection,
  registerRoutes,
  getRequest,
  postRequest,
  readResponse,
  overviewQuery,
  topicsById,
  makeReviewRequest,
  writeReviewFile,
  fakeNoticePort,
  pendingAuthorizationFixture,
} from './support/api-fixtures.mjs'
/**
 * Panel write routes and the shared request fence: resolve, reopen,
 * route.move, master-only checks, the real-store integration, and archive
 * semantics.
 *
 * Split out of the former `tests/api.test.mjs`; setup lives in
 * `tests/support/api-fixtures.mjs`.
 */

// ---------------------------------------------------------------------------
// security fence
// ---------------------------------------------------------------------------

test('a non-loopback Host is refused on every route', async () => {
  const portBag = fakePorts({ now: () => NOW })
  const { routes } = await registerRoutes(portBag)
  const requests = [
    [contract.OVERVIEW_PATH, new Request(`http://evil.test${contract.OVERVIEW_PATH}`, { headers: { host: 'evil.test' } })],
    [contract.ACTIVITY_PATH, new Request(`http://evil.test${contract.ACTIVITY_PATH}`, { headers: { host: 'evil.test' } })],
    [contract.TOPIC_PATH, new Request(`http://evil.test${contract.TOPIC_PATH}`, { headers: { host: 'evil.test' } })],
  ]
  for (const [path, request] of requests) {
    const { status, body } = await readResponse(await routes.get(path).fetch(request))
    assert.equal(status, 403, path)
    assert.equal(body.error.code, 'request/origin', path)
    assert.match(body.error.message, /loopback/, path)
  }
  const writeRequest = new Request(`http://evil.test${contract.RESOLVE_PATH}`, {
    method: 'POST',
    headers: { host: 'evil.test', 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: MASTER, topicId: 'topic-1' }),
  })
  const write = await readResponse(await routes.get(contract.RESOLVE_PATH).fetch(writeRequest))
  assert.equal(write.status, 403)
  assert.equal(write.body.error.code, 'request/origin')
  assert.equal(portBag.state.writes, 0)
  assert.equal(portBag.state.listCalls, 0, 'the fence runs before any host or store work')
})

test('a missing Host header and a foreign Origin are refused', async () => {
  const portBag = fakePorts({ now: () => NOW })
  const { routes } = await registerRoutes(portBag)
  const route = routes.get(contract.OVERVIEW_PATH)

  const noHost = await readResponse(await route.fetch(new Request(`http://${HOST}${contract.OVERVIEW_PATH}?sessionId=${MASTER}`)))
  assert.equal(noHost.status, 403)
  assert.match(noHost.body.error.message, /\(missing\)/)

  const foreign = await readResponse(await route.fetch(getRequest(
    contract.OVERVIEW_PATH,
    overviewQuery(),
    { origin: 'http://evil.test' },
  )))
  assert.equal(foreign.status, 403)
  assert.equal(foreign.body.error.code, 'request/origin')
  assert.match(foreign.body.error.message, /does not match request host/)

  const malformed = await readResponse(await route.fetch(getRequest(
    contract.OVERVIEW_PATH,
    overviewQuery(),
    { origin: 'not a url' },
  )))
  assert.equal(malformed.status, 403)
  assert.match(malformed.body.error.message, /not a valid URL/)

  const sameOrigin = await readResponse(await route.fetch(getRequest(
    contract.OVERVIEW_PATH,
    overviewQuery(),
    { origin: ORIGIN },
  )))
  assert.equal(sameOrigin.status, 200, 'the browser origin is allowed')
  const noOrigin = await readResponse(await route.fetch(getRequest(contract.OVERVIEW_PATH, overviewQuery())))
  assert.equal(noOrigin.status, 200, 'a server-side caller sends no Origin')
})

test('the M12 panel probe clears the same-origin guard (F4)', async () => {
  const portBag = fakePorts({ now: () => NOW })
  const { routes } = await registerRoutes(portBag)

  // The probe states the loopback authority explicitly; the production
  // overview handler must accept it and read the sessionId query string.
  const probe = await readResponse(await routes.get(contract.OVERVIEW_PATH).fetch(
    panelProbe.panelProbeRequest(`${contract.OVERVIEW_PATH}${overviewQuery()}`),
  ))
  assert.equal(probe.status, 200)
  assert.equal(probe.body.ok, true)
  assert.equal(probe.body.project.masterSessionId, MASTER)

  // Negative control: a bare Request carries no Host header (undici computes
  // it only when sending), which is the exact shape t22 hit as a 403.
  const bare = new Request(`http://127.0.0.1${contract.OVERVIEW_PATH}${overviewQuery()}`)
  assert.equal(bare.headers.get('host'), null)
  const refused = await readResponse(await routes.get(contract.OVERVIEW_PATH).fetch(bare))
  assert.equal(refused.status, 403)
  assert.equal(refused.body.error.code, 'request/origin')

  // The write half keeps the caller's content-type/body and adds the same
  // origin headers: the reopen route reaches its own business logic (an
  // already-live topic is an idempotent 200), so no host gate rejects the probe.
  const write = await readResponse(await routes.get(contract.REOPEN_PATH).fetch(
    panelProbe.panelProbeRequest(contract.REOPEN_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: MASTER, topicId: 'topic-1' }),
    }),
  ))
  assert.equal(write.status, 200)
  assert.equal(write.body.ok, true)
})

test('write routes refuse a missing or wrong content type with 415', async () => {
  const portBag = fakePorts({ now: () => NOW })
  const { routes } = await registerRoutes(portBag)
  const bodies = {
    [contract.RESOLVE_PATH]: { sessionId: MASTER, topicId: 'topic-1' },
    [contract.REOPEN_PATH]: { sessionId: MASTER, topicId: 'topic-1' },
    [contract.ROUTE_MOVE_PATH]: { sessionId: MASTER, fromTopicId: 'topic-1', toTopicId: 'topic-2', intent: 'alpha' },
  }
  for (const [path, body] of Object.entries(bodies)) {
    for (const contentType of [null, 'text/plain', 'application/x-www-form-urlencoded']) {
      const { status, headers, body: payload } = await readResponse(
        await routes.get(path).fetch(postRequest(path, body, { contentType })),
      )
      assert.equal(status, 415, `${path} ${contentType}`)
      assert.equal(payload.error.code, 'request/content-type', `${path} ${contentType}`)
      assert.equal(headers.get('cache-control'), 'no-store')
      assert.match(headers.get('content-type'), /application\/json/)
    }
  }
  assert.equal(portBag.state.writes, 0)
})

test('write routes refuse a body over 8 KiB with 413', async () => {
  const portBag = fakePorts({ now: () => NOW })
  const { routes } = await registerRoutes(portBag)
  const oversized = JSON.stringify({
    sessionId: MASTER,
    topicId: 'topic-1',
    fromTopicId: 'topic-1',
    toTopicId: 'topic-2',
    intent: 'alpha',
    padding: 'x'.repeat(contract.MAX_REQUEST_BODY_BYTES),
  })
  for (const path of [contract.RESOLVE_PATH, contract.REOPEN_PATH, contract.ROUTE_MOVE_PATH]) {
    const { status, body } = await readResponse(
      await routes.get(path).fetch(postRequest(path, oversized)),
    )
    assert.equal(status, 413, path)
    assert.equal(body.error.code, 'request/body-too-large', path)
    assert.match(body.error.message, /8192/, path)
  }
  assert.equal(portBag.state.storeCalls.length, 0)
})

test('write routes refuse invalid JSON and a non-object body with 400', async () => {
  const portBag = fakePorts({ now: () => NOW })
  const { routes } = await registerRoutes(portBag)
  const route = routes.get(contract.RESOLVE_PATH)
  for (const body of ['not json', '[1,2]', 'null', '"text"', '42', '']) {
    const { status, body: payload } = await readResponse(await route.fetch(postRequest(contract.RESOLVE_PATH, body)))
    assert.equal(status, 400, body)
    assert.equal(payload.error.code, 'request/invalid-body', body)
  }
  assert.equal(portBag.state.writes, 0)
})

test('write routes require a session id and topic ids', async () => {
  const portBag = fakePorts({ now: () => NOW })
  const { routes } = await registerRoutes(portBag)
  const cases = [
    [contract.RESOLVE_PATH, {}, 'request/session-required'],
    [contract.RESOLVE_PATH, { sessionId: '   ' }, 'request/session-required'],
    [contract.RESOLVE_PATH, { sessionId: MASTER }, 'request/topic-required'],
    [contract.RESOLVE_PATH, { sessionId: MASTER, topicId: ' ' }, 'request/topic-required'],
    [contract.REOPEN_PATH, { sessionId: MASTER }, 'request/topic-required'],
    [contract.ROUTE_MOVE_PATH, { sessionId: MASTER }, 'request/topic-required'],
    [contract.ROUTE_MOVE_PATH, { sessionId: MASTER, fromTopicId: 'topic-1' }, 'request/topic-required'],
  ]
  for (const [path, body, code] of cases) {
    const { status, body: payload } = await readResponse(await routes.get(path).fetch(postRequest(path, body)))
    assert.equal(status, 400, JSON.stringify(body))
    assert.equal(payload.error.code, code, JSON.stringify(body))
  }
  assert.equal(portBag.state.listCalls, 0, 'missing ids never reach the host')
})

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

test('resolve marks a topic resolved once and is idempotent afterwards', async () => {
  const portBag = fakePorts({ now: () => NOW })
  const { routes } = await registerRoutes(portBag)
  const route = routes.get(contract.RESOLVE_PATH)
  const body = { sessionId: MASTER, topicId: 'topic-1' }

  const first = await readResponse(await route.fetch(postRequest(contract.RESOLVE_PATH, body)))
  assert.equal(first.status, 200)
  assert.equal(first.body.ok, true)
  assert.equal(first.body.alreadyResolved, false)
  assert.equal(first.body.topic.status, 'resolved')
  assert.equal(first.body.topic.resolvedBy, 'user')
  assert.equal(first.body.topic.resolvedAt, NOW.toISOString())
  assert.equal(first.body.topic.updatedAt, NOW.toISOString())
  assert.equal(portBag.state.writes, 1)
  assert.equal(portBag.state.appended.length, 1)
  const event = portBag.state.appended[0]
  assert.equal(event.type, 'topic-archived', 'archiving is its own event type')
  assert.equal(event.topicId, 'topic-1')
  assert.equal(event.time, NOW.toISOString())
  assert.equal(event.details.by, 'user')
  assert.equal(event.details.notice.kind, 'archive')
  assert.deepEqual([...event.details.notice.targets], ['master'], 'the archive notices the master only')
  assert.ok(typeof event.eventId === 'string' && event.eventId.length > 0)

  const second = await readResponse(await route.fetch(postRequest(contract.RESOLVE_PATH, body)))
  assert.equal(second.status, 200)
  assert.equal(second.body.alreadyResolved, true)
  assert.equal(second.body.topic.status, 'resolved')
  assert.equal(portBag.state.writes, 1, 'the second resolve writes nothing')
  assert.equal(portBag.state.appended.length, 1, 'and records no second activity row')
})

test('resolve reports an unknown topic with 404 and no write', async () => {
  const portBag = fakePorts({ now: () => NOW })
  const { routes } = await registerRoutes(portBag)
  const { status, body } = await readResponse(
    await routes.get(contract.RESOLVE_PATH)
      .fetch(postRequest(contract.RESOLVE_PATH, { sessionId: MASTER, topicId: 'ghost' })),
  )
  assert.equal(status, 404)
  assert.equal(body.error.code, 'topic/not-found')
  assert.equal(portBag.state.writes, 0)
  assert.equal(portBag.state.appended.length, 0)
})

test('resolve keeps a committed write when the activity append fails', async () => {
  const portBag = fakePorts({ now: () => NOW, appendError: new Error('activity lock timed out') })
  const { routes } = await registerRoutes(portBag)
  const { status, body } = await readResponse(
    await routes.get(contract.RESOLVE_PATH)
      .fetch(postRequest(contract.RESOLVE_PATH, { sessionId: MASTER, topicId: 'topic-1' })),
  )
  assert.equal(status, 200)
  assert.equal(body.topic.status, 'resolved')
  assert.equal(portBag.state.writes, 1)
  assert.equal(portBag.state.logs.length, 1)
  assert.match(portBag.state.logs[0], /topic archive event was not recorded/)
  assert.match(portBag.state.logs[0], /activity lock timed out/)
})

// ---------------------------------------------------------------------------
// reopen
// ---------------------------------------------------------------------------

test('reopen clears the resolution and records topic-reopened', async () => {
  const document = makeDocument({
    topics: [makeTopic({
      topicId: 'topic-1',
      status: 'resolved',
      resolvedAt: '2026-01-01T12:00:00.000Z',
      resolvedBy: 'master',
      updatedAt: '2026-01-01T12:00:00.000Z',
    })],
  })
  const portBag = fakePorts({ document, now: () => NOW })
  const { routes } = await registerRoutes(portBag)
  const { status, body } = await readResponse(
    await routes.get(contract.REOPEN_PATH)
      .fetch(postRequest(contract.REOPEN_PATH, { sessionId: MASTER, topicId: 'topic-1' })),
  )
  assert.equal(status, 200)
  assert.equal(body.topic.status, 'active')
  assert.equal(body.topic.resolvedAt, null)
  assert.equal(body.topic.resolvedBy, null)
  assert.equal(body.topic.lastActiveAt, NOW.toISOString())
  assert.equal(body.topic.updatedAt, NOW.toISOString())
  assert.equal(portBag.state.writes, 1)
  assert.equal(portBag.state.appended.length, 1)
  assert.equal(portBag.state.appended[0].type, 'topic-reopened')
  assert.deepEqual(portBag.state.appended[0].details, {
    topicId: 'topic-1',
    resolvedAt: '2026-01-01T12:00:00.000Z',
    resolvedBy: 'master',
  })
})

test('reopen of a topic that is not resolved is an idempotent 200 with no write', async () => {
  const portBag = fakePorts({ now: () => NOW })
  const { routes } = await registerRoutes(portBag)
  const { status, body } = await readResponse(
    await routes.get(contract.REOPEN_PATH)
      .fetch(postRequest(contract.REOPEN_PATH, { sessionId: MASTER, topicId: 'topic-1' })),
  )
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.topic.status, 'active')
  assert.equal(portBag.state.writes, 0, 'an already live topic is not rewritten')
  assert.equal(portBag.state.appended.length, 0, 'and produces no second reopen event')
})

// ---------------------------------------------------------------------------
// route.move
// ---------------------------------------------------------------------------

function moveDocument(overrides = {}) {
  return makeDocument({
    topics: [
      makeTopic({ topicId: 'topic-1' }),
      makeTopic({ topicId: 'topic-2', aliases: ['alpha'] }),
    ],
    ...overrides,
  })
}

test('route.move appends the intent aliases and records route-corrected', async () => {
  const portBag = fakePorts({ document: moveDocument(), now: () => NOW })
  const { routes } = await registerRoutes(portBag)
  const { status, body } = await readResponse(
    await routes.get(contract.ROUTE_MOVE_PATH).fetch(postRequest(contract.ROUTE_MOVE_PATH, {
      sessionId: MASTER,
      fromTopicId: 'topic-1',
      toTopicId: 'topic-2',
      intent: '  Alpha  beta gamma ',
    })),
  )
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.changed, true)
  assert.deepEqual(body.added, ['beta', 'gamma'])
  assert.deepEqual(body.aliases, ['alpha', 'beta', 'gamma'], 'existing aliases stay and duplicates are dropped')
  assert.equal(portBag.state.writes, 1)
  assert.equal(portBag.state.appended.length, 1)
  const event = portBag.state.appended[0]
  assert.equal(event.type, 'route-corrected')
  assert.equal(event.topicId, 'topic-2')
  assert.deepEqual(event.details, { topicId: 'topic-2', added: ['beta', 'gamma'], aliasCount: 3 })
})

test('route.move writes nothing when the intent adds no alias', async () => {
  const portBag = fakePorts({ document: moveDocument(), now: () => NOW })
  const { routes } = await registerRoutes(portBag)
  const { status, body } = await readResponse(
    await routes.get(contract.ROUTE_MOVE_PATH).fetch(postRequest(contract.ROUTE_MOVE_PATH, {
      sessionId: MASTER,
      fromTopicId: 'topic-1',
      toTopicId: 'topic-2',
      intent: 'alpha',
    })),
  )
  assert.equal(status, 200)
  assert.equal(body.changed, false)
  assert.deepEqual(body.added, [])
  assert.deepEqual(body.aliases, ['alpha'])
  assert.equal(portBag.state.writes, 0)
  assert.equal(portBag.state.appended.length, 0)
})

test('route.move keeps aliases deduplicated, under 50 items, and under 32 characters', async () => {
  const existing = Array.from({ length: 48 }, (_, index) => `alias-${index}`)
  const tooLong = 'a'.repeat(40)
  const document = moveDocument({
    topics: [
      makeTopic({ topicId: 'topic-1' }),
      makeTopic({ topicId: 'topic-2', aliases: existing }),
    ],
  })
  const portBag = fakePorts({ document, now: () => NOW })
  const { routes } = await registerRoutes(portBag)
  const { body } = await readResponse(
    await routes.get(contract.ROUTE_MOVE_PATH).fetch(postRequest(contract.ROUTE_MOVE_PATH, {
      sessionId: MASTER,
      fromTopicId: 'topic-1',
      toTopicId: 'topic-2',
      intent: `alias-0 ${tooLong} x1 x2 x3 x4 x5 x6`,
    })),
  )
  assert.equal(body.changed, true)
  // `alias-0` tokenizes to `alias` (and a dropped one-character token); only two
  // additions fit, so `x1` is the last one accepted and `x2` is cut by the bound.
  assert.deepEqual(body.added, ['alias', 'x1'])
  assert.equal(body.aliases.length, 50)
  assert.ok(body.aliases.every((alias) => Array.from(alias).length <= 32))
  assert.equal(body.aliases.includes(tooLong), false)
})

test('route.move rejects the same topic, a blank intent, and a resolved target', async () => {
  const document = moveDocument({
    topics: [
      makeTopic({ topicId: 'topic-1' }),
      makeTopic({ topicId: 'topic-2', aliases: ['alpha'] }),
      makeTopic({ topicId: 'resolved-2', status: 'resolved', resolvedBy: 'user', resolvedAt: CREATED_AT }),
    ],
  })
  const portBag = fakePorts({ document, now: () => NOW })
  const { routes } = await registerRoutes(portBag)
  const route = routes.get(contract.ROUTE_MOVE_PATH)
  const cases = [
    [{ sessionId: MASTER, fromTopicId: 'topic-1', toTopicId: 'topic-1', intent: 'beta' }, 'same topic'],
    [{ sessionId: MASTER, fromTopicId: 'topic-1', toTopicId: 'topic-2' }, 'missing intent'],
    [{ sessionId: MASTER, fromTopicId: 'topic-1', toTopicId: 'topic-2', intent: '   ' }, 'blank intent'],
    [{ sessionId: MASTER, fromTopicId: 'topic-1', toTopicId: 'topic-2', intent: 'a'.repeat(501) }, 'long intent'],
    [{ sessionId: MASTER, fromTopicId: 'topic-1', toTopicId: 'resolved-2', intent: 'beta' }, 'resolved target'],
  ]
  for (const [body, name] of cases) {
    const { status, body: payload } = await readResponse(await route.fetch(postRequest(contract.ROUTE_MOVE_PATH, body)))
    assert.equal(status, 400, name)
    assert.equal(payload.error.code, 'route/move-invalid', name)
    assert.ok(payload.error.message.length > 0, name)
  }
  assert.equal(portBag.state.writes, 0)
  assert.equal(portBag.state.appended.length, 0)
})

test('route.move reports an unknown source or target topic with 404', async () => {
  const portBag = fakePorts({ document: moveDocument(), now: () => NOW })
  const { routes } = await registerRoutes(portBag)
  const route = routes.get(contract.ROUTE_MOVE_PATH)
  for (const body of [
    { sessionId: MASTER, fromTopicId: 'ghost', toTopicId: 'topic-2', intent: 'beta' },
    { sessionId: MASTER, fromTopicId: 'topic-1', toTopicId: 'ghost', intent: 'beta' },
  ]) {
    const { status, body: payload } = await readResponse(await route.fetch(postRequest(contract.ROUTE_MOVE_PATH, body)))
    assert.equal(status, 404)
    assert.equal(payload.error.code, 'topic/not-found')
  }
  assert.equal(portBag.state.writes, 0)
})

// ---------------------------------------------------------------------------
// master-only writes
// ---------------------------------------------------------------------------

test('every write route refuses a non-master session with 403 and zero writes', async () => {
  const portBag = fakePorts({
    document: moveDocument(),
    sessions: [{ sessionId: OTHER_SESSION, cwd: '/repo' }],
    now: () => NOW,
  })
  const { routes } = await registerRoutes(portBag)
  const cases = [
    [contract.RESOLVE_PATH, { sessionId: OTHER_SESSION, topicId: 'topic-1' }],
    [contract.REOPEN_PATH, { sessionId: OTHER_SESSION, topicId: 'topic-1' }],
    [contract.ROUTE_MOVE_PATH, { sessionId: OTHER_SESSION, fromTopicId: 'topic-1', toTopicId: 'topic-2', intent: 'beta' }],
  ]
  for (const [path, body] of cases) {
    const { status, body: payload } = await readResponse(await routes.get(path).fetch(postRequest(path, body)))
    assert.equal(status, 403, path)
    assert.equal(payload.error.code, 'request/not-master', path)
    assert.match(payload.error.message, /not the master/, path)
  }
  assert.equal(portBag.state.writes, 0)
  assert.equal(portBag.state.appended.length, 0)
})

test('the master check runs again inside the write lock', async () => {
  // The read that precedes the lock sees this session as master; the document
  // the mutator re-reads does not. A stale pre-check must not write.
  const stale = makeDocument()
  const live = makeDocument({ masterSessionId: 'another-master' })
  const portBag = fakePorts({ document: live, readDocument: stale, now: () => NOW })
  const { routes } = await registerRoutes(portBag)
  const { status, body } = await readResponse(
    await routes.get(contract.RESOLVE_PATH)
      .fetch(postRequest(contract.RESOLVE_PATH, { sessionId: MASTER, topicId: 'topic-1' })),
  )
  assert.equal(status, 403)
  assert.equal(body.error.code, 'request/not-master')
  assert.equal(portBag.state.writes, 0)
  assert.equal(portBag.state.appended.length, 0)
})

// ---------------------------------------------------------------------------
// real store integration (one lock per transaction, no nesting)
// ---------------------------------------------------------------------------

test('a real ProjectStore serves the seven routes over real files and locks', async (t) => {
  // The unit tests above use a fake store; this one wires the routes to the
  // real store so the two independent lock acquisitions (index transaction,
  // then activity append) are exercised for real. A nested `withWriteLock`
  // would time out here instead of passing.
  const repoPath = await mkdtemp(join(tmpdir(), 'cowork-api-real-'))
  t.after(() => rm(repoPath, { recursive: true, force: true }))
  const realStore = new store.ProjectStore({ repoPath, clock: () => NOW })
  await realStore.initIndex(MASTER)
  await realStore.mutateIndexDocument((document) => ({
    ...document,
    topics: [
      makeTopic({ topicId: 'topic-1', lastActiveAt: NOW.toISOString(), updatedAt: NOW.toISOString() }),
      makeTopic({ topicId: 'topic-2', aliases: ['alpha'], lastActiveAt: NOW.toISOString() }),
    ],
    workItems: [makeWorkItem({ workItemId: 'wi-1', topicId: 'topic-1', status: 'active' })],
  }))
  const fileName = reviewRequest.reviewRequestFileName('topic-1', 'req-real')
  assert.ok(fileName !== null)
  await mkdir(realStore.reviewsDir, { recursive: true })
  await writeFile(join(realStore.reviewsDir, fileName), `${JSON.stringify(makeReviewRequest({
    requestId: 'req-real',
    reviewedAt: '2026-01-02T00:05:00.000Z',
    status: 'pass',
    summary: 'real store review',
  }), null, 2)}\n`)

  const { routes } = await registerRoutes({
    ports: {
      listSessions: async () => ({ items: [{ sessionId: MASTER, cwd: repoPath }] }),
      findProjectRoot: async (startPath) => (startPath === repoPath ? repoPath : null),
      createStore: () => realStore,
      now: () => NOW,
      log: () => {},
    },
  })

  const overview = await readResponse(
    await routes.get(contract.OVERVIEW_PATH).fetch(getRequest(contract.OVERVIEW_PATH, overviewQuery())),
  )
  assert.equal(overview.status, 200)
  assert.deepEqual(overview.body.topics.map((row) => row.topicId), ['topic-1', 'topic-2'])
  assert.equal(topicsById(overview.body.topics).get('topic-1').activeWorkItems, 1)

  const detail = await readResponse(
    await routes.get(contract.TOPIC_PATH)
      .fetch(getRequest(contract.TOPIC_PATH, `${overviewQuery()}&topicId=topic-1`)),
  )
  assert.equal(detail.status, 200)
  assert.deepEqual(detail.body.reviewRequests.map((row) => row.requestId), ['req-real'])

  const resolved = await readResponse(
    await routes.get(contract.RESOLVE_PATH)
      .fetch(postRequest(contract.RESOLVE_PATH, { sessionId: MASTER, topicId: 'topic-1' })),
  )
  assert.equal(resolved.status, 200)
  assert.equal(resolved.body.alreadyResolved, false)
  let document = await realStore.readIndexDocument()
  assert.equal(document.topics.find((topic) => topic.topicId === 'topic-1').status, 'resolved')
  assert.deepEqual(
    (await realStore.readActivity(50)).events.map((event) => event.type),
    ['topic-archived'],
  )
  assert.equal((await realStore.readNotices()).notices.length, 1, 'the archive writes one master notice row')
  assert.equal((await realStore.readNotices()).notices[0].target, 'master')

  const reopened = await readResponse(
    await routes.get(contract.REOPEN_PATH)
      .fetch(postRequest(contract.REOPEN_PATH, { sessionId: MASTER, topicId: 'topic-1' })),
  )
  assert.equal(reopened.status, 200)
  assert.equal(reopened.body.topic.status, 'active')
  document = await realStore.readIndexDocument()
  assert.equal(document.topics.find((topic) => topic.topicId === 'topic-1').resolvedBy, null)
  assert.deepEqual(
    (await realStore.readActivity(50)).events.map((event) => event.type),
    ['topic-archived', 'topic-reopened'],
  )
  assert.equal((await realStore.readNotices()).notices.length, 1, 'reopening writes no notice')

  const moved = await readResponse(
    await routes.get(contract.ROUTE_MOVE_PATH).fetch(postRequest(contract.ROUTE_MOVE_PATH, {
      sessionId: MASTER,
      fromTopicId: 'topic-1',
      toTopicId: 'topic-2',
      intent: 'panel api',
    })),
  )
  assert.equal(moved.status, 200)
  assert.deepEqual(moved.body.added, ['panel', 'api'])
  document = await realStore.readIndexDocument()
  assert.deepEqual(
    document.topics.find((topic) => topic.topicId === 'topic-2').aliases,
    ['alpha', 'panel', 'api'],
  )
  assert.deepEqual(
    (await realStore.readActivity(50)).events.map((event) => event.type),
    ['topic-archived', 'topic-reopened', 'route-corrected'],
  )
})

// ---------------------------------------------------------------------------
// archive semantics: host session, pending authorization, notices
// ---------------------------------------------------------------------------

test('resolve archives the host session, clears the pending authorization, and voids its notice', async () => {
  const { requested, topic } = pendingAuthorizationFixture()
  const document = makeDocument({ topics: [topic] })
  const port = fakeNoticePort()
  const portBag = fakePorts({
    document,
    now: () => NOW,
    activity: [requested],
    noticePort: port,
    notices: {
      version: 1,
      notices: [
        { noticeId: 'event-auth-1', topicId: 'topic-1', target: 'master', status: 'pending', attempts: 0, lastError: null, updatedAt: '2026-01-02T00:00:00.000Z' },
        { noticeId: 'event-auth-1', topicId: 'topic-1', target: 'topic', status: 'pending', attempts: 0, lastError: null, updatedAt: '2026-01-02T00:00:00.000Z' },
      ],
    },
  })
  const { routes } = await registerRoutes(portBag)
  const { status, body } = await readResponse(
    await routes.get(contract.RESOLVE_PATH)
      .fetch(postRequest(contract.RESOLVE_PATH, { sessionId: MASTER, topicId: 'topic-1' })),
  )
  assert.equal(status, 200)
  assert.equal(body.topic.status, 'resolved')
  assert.equal(body.topic.awaitingAuthorization, false)
  assert.equal(body.topic.blockedReason, null)
  assert.deepEqual(portBag.state.archived, [{ sessionId: 'topic-1', options: { stopActivity: true } }])
  const stored = portBag.state.document.topics[0]
  assert.equal(stored.authorization, null, 'the pending request is gone')
  assert.equal(stored.blocked, false)
  assert.equal(stored.blockedFromStatus, null)
  const noticeRows = portBag.state.notices.notices
  assert.deepEqual(
    noticeRows.filter((row) => row.noticeId === 'event-auth-1').map((row) => [row.target, row.status]).sort(),
    [['master', 'void'], ['topic', 'void']],
    'the pending authorization notice is withdrawn',
  )
  const archiveRow = noticeRows.find((row) => row.noticeId !== 'event-auth-1')
  assert.equal(archiveRow.target, 'master', 'the archive notifies the master only')
  assert.deepEqual(port.updates.map((entry) => [entry.noticeId, entry.patch.status]), [
    ['event-auth-1', 'void'],
    ['event-auth-1', 'void'],
  ])
  const archivedEvent = portBag.state.appended.find((event) => event.type === 'topic-archived')
  assert.equal(archivedEvent.details.voidedAuthorizationNoticeId, 'event-auth-1')
})

test('a refused host archive is logged and never fails or rolls back the resolve', async () => {
  const portBag = fakePorts({ now: () => NOW, archiveError: new Error('session is busy') })
  const { routes } = await registerRoutes(portBag)
  const { status, body } = await readResponse(
    await routes.get(contract.RESOLVE_PATH)
      .fetch(postRequest(contract.RESOLVE_PATH, { sessionId: MASTER, topicId: 'topic-1' })),
  )
  assert.equal(status, 200, 'the index is already committed')
  assert.equal(body.topic.status, 'resolved')
  assert.equal(portBag.state.logs.length, 1)
  assert.match(portBag.state.logs[0], /was not archived/)
  assert.match(portBag.state.logs[0], /session is busy/)
})

test('reopen restores the host session and logs a refused restore', async () => {
  const resolvedDocument = makeDocument({
    topics: [makeTopic({ topicId: 'topic-1', status: 'resolved', resolvedAt: '2026-01-01T12:00:00.000Z', resolvedBy: 'user' })],
  })
  const ok = fakePorts({ document: resolvedDocument, now: () => NOW })
  const okRoutes = await registerRoutes(ok)
  const reopened = await readResponse(
    await okRoutes.routes.get(contract.REOPEN_PATH)
      .fetch(postRequest(contract.REOPEN_PATH, { sessionId: MASTER, topicId: 'topic-1' })),
  )
  assert.equal(reopened.status, 200)
  assert.deepEqual(ok.state.unarchived, ['topic-1'])
  assert.equal(ok.state.notices.notices.length, 0, 'a reopen produces no notice')

  const refused = fakePorts({
    document: resolvedDocument,
    now: () => NOW,
    unarchiveError: new Error('session is unknown'),
  })
  const refusedRoutes = await registerRoutes(refused)
  const again = await readResponse(
    await refusedRoutes.routes.get(contract.REOPEN_PATH)
      .fetch(postRequest(contract.REOPEN_PATH, { sessionId: MASTER, topicId: 'topic-1' })),
  )
  assert.equal(again.status, 200)
  assert.match(refused.state.logs[0], /was not restored/)
})
