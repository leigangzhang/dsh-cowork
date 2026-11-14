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
 * Panel read routes and the wire contract: overview, activity, topic detail,
 * route registration, and the shared error envelope.
 *
 * Split out of the former `tests/api.test.mjs`; setup lives in
 * `tests/support/api-fixtures.mjs` so the write and authorization suites share
 * the same fake host without copying it.
 */

// ---------------------------------------------------------------------------
// wire mapping and error contract
// ---------------------------------------------------------------------------

test('toPanelTopic maps a v2 topic, bounds its text, and counts open work', () => {
  const topic = makeTopic({
    topicId: 't1',
    blocked: true,
    blockedReason: 'handoff',
    awaitingReview: true,
    reviewStatus: 'needs_revision',
    latestReviewRequestId: 'req-1',
    digest: 'x'.repeat(250),
    scope: '  two   words  ',
    ownedPaths: Array.from({ length: 60 }, (_, index) => `path-${index}`),
    resolvedAt: null,
    resolvedBy: null,
  })
  const document = makeDocument({
    topics: [topic],
    workItems: [
      makeWorkItem({ workItemId: 'w1', topicId: 't1', status: 'active' }),
      makeWorkItem({ workItemId: 'w2', topicId: 't1', status: 'reviewing' }),
      makeWorkItem({ workItemId: 'w3', topicId: 't1', status: 'merged' }),
      makeWorkItem({ workItemId: 'w4', topicId: 't1', status: 'abandoned' }),
      makeWorkItem({ workItemId: 'w5', topicId: 'other', status: 'active' }),
    ],
  })
  const panel = api.toPanelTopic(document, topic)
  assert.equal(panel.topicId, 't1')
  assert.equal(panel.status, 'active')
  assert.equal(panel.blocked, true)
  assert.equal(panel.blockedReason, 'handoff')
  assert.equal(panel.awaitingAuthorization, false)
  assert.equal(panel.awaitingReview, true)
  assert.equal(panel.reviewStatus, 'needs_revision')
  assert.equal(panel.latestReviewRequestId, 'req-1')
  assert.equal(panel.scope, 'two words', 'scope is folded and trimmed')
  assert.equal(Array.from(panel.digest).length, contract.MAX_SUMMARY_CHARS, 'digest is cut to its wire bound')
  assert.ok(panel.digest.endsWith('…'))
  assert.equal(panel.ownedPaths.length, contract.MAX_TOPIC_OWNED_PATHS)
  assert.equal(panel.activeWorkItems, 2, 'active + reviewing count as in flight; merged/abandoned/stray do not')
  assert.equal(panel.resolvedBy, null)
  // The wire carries no thread/reviewer/handoff facts: the exact key set pins it.
  assert.deepEqual(Object.keys(panel).sort(), [
    'activeWorkItems',
    'awaitingAuthorization',
    'awaitingReview',
    'blocked',
    'blockedReason',
    'digest',
    'lastActiveAt',
    'lastDeliveryConfirmedAt',
    'latestReviewRequestId',
    'ownedPaths',
    'resolvedAt',
    'resolvedBy',
    'reviewStatus',
    'scope',
    'status',
    'title',
    'topicId',
    'updatedAt',
  ])
})

test('toPanelTopic degrades an unknown review state and a bogus resolver to null', () => {
  const topic = makeTopic({ reviewStatus: 'invented', resolvedBy: 'someone', resolvedAt: '2026-01-02T00:00:00.000Z' })
  const panel = api.toPanelTopic(makeDocument({ topics: [topic] }), topic)
  assert.equal(panel.reviewStatus, null)
  assert.equal(panel.resolvedBy, null)
  assert.equal(panel.resolvedAt, '2026-01-02T00:00:00.000Z')
})

test('toPanelTopic derives the authorization marker and surfaces the blocked reason', () => {
  const pending = makeTopic({
    blocked: true,
    blockedReason: 'authorization',
    blockedFromStatus: 'idle',
    blockedAt: '2026-01-02T00:00:00.000Z',
    authorization: { requestId: 'request-1', summary: 'may I?', requestedAt: '2026-01-02T00:00:00.000Z' },
  })
  const panel = api.toPanelTopic(makeDocument({ topics: [pending] }), pending)
  assert.equal(panel.blocked, true)
  assert.equal(panel.blockedReason, 'authorization')
  assert.equal(panel.awaitingAuthorization, true, 'the marker is derived from the request, never stored twice')

  const handoff = makeTopic({ blocked: true, blockedReason: 'handoff' })
  const handoffPanel = api.toPanelTopic(makeDocument({ topics: [handoff] }), handoff)
  assert.equal(handoffPanel.awaitingAuthorization, false)
  assert.equal(handoffPanel.blockedReason, 'handoff')

  const invented = makeTopic({ blockedReason: 'because' })
  assert.equal(api.toPanelTopic(makeDocument({ topics: [invented] }), invented).blockedReason, null)
})

test('toErrorResponse maps every stable code to its documented status', () => {
  // One home for the status table; the contract's code list cannot grow
  // without this table and `panelErrorStatus` disagreeing.
  const expected = {
    'request/session-required': 400,
    'request/topic-required': 400,
    'request/invalid-query': 400,
    'request/invalid-body': 400,
    'request/body-too-large': 413,
    'request/content-type': 415,
    'request/origin': 403,
    'request/not-master': 403,
    'topic/not-found': 404,
    'topic/not-resolved': 409,
    'authorization/not-found': 404,
    'authorization/mismatch': 409,
    'authorization/not-allowed': 403,
    'route/move-invalid': 400,
    'session/unknown': 400,
    'session/cwd-unavailable': 400,
    'session/list-timeout': 504,
    'project/not-initialized': 404,
    'store/corrupt': 500,
    'inbox/request-not-found': 404,
    'inbox/request-resolved': 409,
    'inbox/action-not-allowed': 400,
    'inbox/invalid-answer': 400,
    'inbox/invalid-comment': 400,
    'inbox/path-missing': 404,
    'inbox/open-unsupported': 501,
    'inbox/not-member': 403,
    internal: 500,
  }
  assert.equal(Object.keys(expected).length, 28, 'a new PanelErrorCode must decide its status here')
  assert.deepEqual(
    Object.keys(expected).sort(),
    [...Object.keys(contract.PANEL_ERROR_STATUS)].sort(),
    'the table above and the contract carry the same codes',
  )
  for (const [code, status] of Object.entries(expected)) {
    assert.equal(api.panelErrorStatus(code), status, code)
    assert.deepEqual(api.toErrorResponse(new api.PanelApiError(code, 'm')), {
      status,
      body: { ok: false, error: { code, message: 'm' } },
    })
  }
  const withPath = api.toErrorResponse(new api.PanelApiError('topic/not-found', 'gone', '/repo'))
  assert.deepEqual(withPath.body.error, { code: 'topic/not-found', message: 'gone', path: '/repo' })
})

test('toErrorResponse keeps the store path for corruption and degrades the rest', () => {
  const corrupt = api.toErrorResponse(
    new store.StoreError('store/corrupt', 'invalid JSON', '/repo/.dsh-cowork/index.json'),
  )
  assert.deepEqual(corrupt, {
    status: 500,
    body: {
      ok: false,
      error: { code: 'store/corrupt', message: 'invalid JSON', path: '/repo/.dsh-cowork/index.json' },
    },
  })
  const notFound = api.toErrorResponse(new store.StoreError('store/not-found', 'gone', '/repo/x'))
  assert.equal(notFound.body.error.code, 'internal')
  assert.deepEqual(api.toErrorResponse(new Error('boom')), {
    status: 500,
    body: { ok: false, error: { code: 'internal', message: 'boom' } },
  })
})

// ---------------------------------------------------------------------------
// route registration
// ---------------------------------------------------------------------------


test('registerCoworkApi registers the ten v2 routes and disposes them', async () => {
  const portBag = fakePorts()
  const fake = fakeConnection()
  const { host, effects } = fakeHost(fake.connection)
  api.registerCoworkApi(host, portBag.ports)
  assert.equal(effects.length, 10, 'one fiber effect per route')
  assert.deepEqual(effects.map((effect) => effect.label), PANEL_ROUTES.map(
    ([path]) => `dsh-cowork: panel route ${path}`,
  ))
  assert.deepEqual(fake.registered.map((route) => [route.path, route.methods.join(',')]), PANEL_ROUTES)
  for (const route of fake.registered) {
    assert.equal(route.requestBody, 'buffered')
    assert.equal(typeof route.fetch, 'function')
  }
  for (const effect of effects) await effect.disposer()
  assert.equal(fake.routes.size, 0, 'disposal unregisters every route')
  api.registerCoworkApi(host, portBag.ports)
  assert.equal(fake.routes.size, 10, 'a reload re-registers without a duplicate error')
})

test('registerCoworkApi is a no-op when the host has no connection service', () => {
  const portBag = fakePorts()
  const host = {
    get: () => undefined,
    effect: () => {
      throw new Error('must not register anything without connection')
    },
  }
  assert.doesNotThrow(() => api.registerCoworkApi(host, portBag.ports))
  assert.deepEqual(portBag.state.storeCalls, [])
})

// ---------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------

test('overview serves v2 topics, counts, and only the undelivered inbox', async () => {
  const document = makeDocument({
    topics: [
      makeTopic({ topicId: 'resolved-1', status: 'resolved', resolvedBy: 'user', resolvedAt: '2026-01-02T00:00:00.000Z' }),
      makeTopic({ topicId: 'idle-1', status: 'idle', lastActiveAt: STALE }),
      makeTopic({ topicId: 'blocked-1', blocked: true }),
      makeTopic({ topicId: 'review-1', awaitingReview: true, reviewStatus: 'pending' }),
    ],
    workItems: [
      makeWorkItem({ workItemId: 'w1', topicId: 'review-1', status: 'reviewing' }),
      makeWorkItem({ workItemId: 'w2', topicId: 'idle-1', status: 'merged' }),
      makeWorkItem({ workItemId: 'w3', topicId: 'ghost', status: 'active' }),
    ],
  })
  const inbox = [
    makeInboxItem({ id: 'inbox-delivered', deliveredAt: '2026-01-02T00:00:00.000Z' }),
    makeInboxItem({ id: 'inbox-1', summary: 'y'.repeat(240) }),
    makeInboxItem({ id: 'inbox-2' }),
  ]
  const portBag = fakePorts({ document, inbox, now: () => NOW })
  const { routes } = await registerRoutes(portBag)
  const response = await routes.get(contract.OVERVIEW_PATH).fetch(getRequest(contract.OVERVIEW_PATH, overviewQuery()))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.topics.map((row) => row.topicId), ['blocked-1', 'review-1', 'idle-1', 'resolved-1'])
  assert.deepEqual(body.topics[3].resolvedBy, 'user')
  assert.deepEqual(body.counts, {
    active: 2,
    idle: 1,
    resolved: 1,
    blocked: 1,
    awaitingAuthorization: 0,
    awaitingReview: 1,
    pendingReview: 1,
    workItemActive: 0,
    workItemReviewing: 1,
    workItemMerged: 1,
    workItemAbandoned: 0,
  })
  assert.deepEqual(body.inbox.map((row) => row.id), ['inbox-1', 'inbox-2'], 'delivered items are hidden')
  assert.equal(Array.from(body.inbox[0].summary).length, contract.MAX_SUMMARY_CHARS)
  assert.deepEqual(body.project, {
    repoPath: '/repo',
    projectId: 'example.com/acme/repo',
    masterSessionId: MASTER,
    createdAt: CREATED_AT,
  })
  assert.equal(portBag.state.listCalls, 1, 'the cwd comes from one metadata listing')
  assert.deepEqual(portBag.state.roots, ['/repo', 'store:/repo'])
  assert.ok(portBag.state.storeCalls.includes('mutateIndexDocument'), 'the read point evaluates the lifecycle')
  assert.equal(portBag.state.writes, 0, 'nothing had to transition, so the lifecycle wrote nothing')
})

test('overview passes real in-flight work-item counts to the lifecycle (idle only)', async () => {
  const resolvable = {
    status: 'active',
    lastActiveAt: STALE,
    lastDeliveryConfirmedAt: CREATED_AT,
  }
  const document = makeDocument({
    topics: [
      makeTopic({ topicId: 'busy', ...resolvable }),
      makeTopic({ topicId: 'quiet', ...resolvable }),
    ],
    // `busy` has a review in flight: it must not be resolved even though every
    // clock condition holds.
    workItems: [makeWorkItem({ workItemId: 'w1', topicId: 'busy', status: 'reviewing' })],
  })
  const portBag = fakePorts({ document, now: () => new Date('2026-01-10T00:00:00.000Z') })
  const { routes } = await registerRoutes(portBag)
  const { status, body } = await readResponse(
    await routes.get(contract.OVERVIEW_PATH).fetch(getRequest(contract.OVERVIEW_PATH, overviewQuery())),
  )
  assert.equal(status, 200)
  const byId = topicsById(body.topics)
  // The read point only migrates idle/active now: no topic is ever archived by
  // a clock, with or without open work.
  assert.equal(byId.get('quiet').status, 'idle', 'a stale topic goes idle, never resolved')
  assert.equal(byId.get('busy').status, 'idle')
  assert.equal(byId.get('busy').activeWorkItems, 1)
  assert.equal(body.counts.resolved, 0)
  assert.deepEqual(
    portBag.state.appended.map((event) => [event.type, event.topicId, event.details.to]),
    // The lifecycle walks the document order: `busy` first, then `quiet`.
    [
      ['status-changed', 'busy', 'idle'],
      ['status-changed', 'quiet', 'idle'],
    ],
  )
  assert.ok(portBag.state.writes >= 1, 'the transition was committed inside the lock')
})

test('a lifecycle activity failure is logged, not a failed overview', async () => {
  const document = makeDocument({
    topics: [makeTopic({ topicId: 'quiet', status: 'active', lastActiveAt: STALE })],
  })
  const portBag = fakePorts({
    document,
    now: () => new Date('2026-01-10T00:00:00.000Z'),
    appendError: new Error('activity write failed'),
  })
  const { routes } = await registerRoutes(portBag)
  const { status, body } = await readResponse(
    await routes.get(contract.OVERVIEW_PATH).fetch(getRequest(contract.OVERVIEW_PATH, overviewQuery())),
  )
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(topicsById(body.topics).get('quiet').status, 'idle')
  assert.equal(portBag.state.logs.length, 1)
  assert.match(portBag.state.logs[0], /lifecycle activity not recorded/)
  assert.match(portBag.state.logs[0], /activity write failed/)
})

test('overview caps the list at MAX_PANEL_TOPICS after sorting', async () => {
  const idle = Array.from({ length: 500 }, (_, index) => makeTopic({
    topicId: `idle-${index}`,
    status: 'idle',
    // Descending lastActiveAt: idle-0 is the freshest, idle-499 the oldest.
    lastActiveAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') - index * 60_000).toISOString(),
  }))
  const document = makeDocument({ topics: [makeTopic({ topicId: 'blocked', blocked: true }), ...idle] })
  const portBag = fakePorts({ document, now: () => NOW })
  const { routes } = await registerRoutes(portBag)
  const { body } = await readResponse(
    await routes.get(contract.OVERVIEW_PATH).fetch(getRequest(contract.OVERVIEW_PATH, overviewQuery())),
  )
  assert.equal(body.topics.length, contract.MAX_PANEL_TOPICS)
  assert.equal(body.topics[0].topicId, 'blocked')
  assert.equal(body.topics.at(-1).topicId, 'idle-498')
  assert.equal(body.counts.blocked, 1)
  assert.equal(body.counts.idle + body.counts.blocked, contract.MAX_PANEL_TOPICS)
})

test('overview requires sessionId before any host or store call', async () => {
  const portBag = fakePorts()
  const { routes } = await registerRoutes(portBag)
  for (const query of ['', '?sessionId=', '?sessionId=%20']) {
    const { status, headers, body } = await readResponse(
      await routes.get(contract.OVERVIEW_PATH).fetch(getRequest(contract.OVERVIEW_PATH, query)),
    )
    assert.equal(status, 400)
    assert.equal(headers.get('cache-control'), 'no-store')
    assert.deepEqual(body, {
      ok: false,
      error: { code: 'request/session-required', message: 'query parameter sessionId is required' },
    })
  }
  assert.equal(portBag.state.listCalls, 0)
  assert.deepEqual(portBag.state.storeCalls, [])
})

test('the project root comes from the session cwd, never from the query', async () => {
  const portBag = fakePorts({
    sessions: [
      { sessionId: OTHER_SESSION, cwd: '/elsewhere' },
      { sessionId: MASTER, cwd: '/repo' },
    ],
  })
  const { routes } = await registerRoutes(portBag)
  const { status, body } = await readResponse(
    await routes.get(contract.OVERVIEW_PATH)
      .fetch(getRequest(contract.OVERVIEW_PATH, `${overviewQuery()}&path=/etc&repoPath=/etc`)),
  )
  assert.equal(status, 200)
  assert.equal(body.project.repoPath, '/repo')
  assert.deepEqual(portBag.state.roots, ['/repo', 'store:/repo'], 'the browser path is ignored')
  assert.equal('inspectSession' in portBag.ports, false, 'fake ports expose listSessions only')
})

test('session and project failures map to the shared envelope', async () => {
  const cases = [
    {
      name: 'unknown session',
      options: { sessions: [{ sessionId: OTHER_SESSION, cwd: '/repo' }] },
      status: 400,
      error: { code: 'session/unknown', message: 'unknown session: master-session' },
    },
    {
      name: 'session without cwd',
      options: { sessions: [{ sessionId: MASTER }] },
      status: 400,
      error: { code: 'session/cwd-unavailable', message: 'session has no working directory: master-session' },
    },
    {
      name: 'uninitialized project',
      options: { root: null },
      status: 404,
      error: { code: 'project/not-initialized', message: 'no .dsh-cowork project above /repo', path: '/repo' },
    },
    {
      name: 'vanished index',
      options: { hasIndex: false },
      status: 404,
      error: { code: 'project/not-initialized', message: 'project index is missing under /repo', path: '/repo' },
    },
    {
      name: 'corrupt store',
      options: { readError: new store.StoreError('store/corrupt', 'invalid JSON', '/repo/.dsh-cowork/index.json') },
      status: 500,
      error: { code: 'store/corrupt', message: 'invalid JSON', path: '/repo/.dsh-cowork/index.json' },
    },
    {
      name: 'unexpected store failure',
      options: { readError: new Error('disk on fire') },
      status: 500,
      error: { code: 'internal', message: 'disk on fire' },
    },
    {
      name: 'failing session listing',
      options: { listError: new Error('session store unavailable') },
      status: 500,
      error: { code: 'internal', message: 'session store unavailable' },
    },
  ]
  for (const entry of cases) {
    const portBag = fakePorts({ ...entry.options, now: () => NOW })
    const { routes } = await registerRoutes(portBag)
    const { status, headers, body } = await readResponse(
      await routes.get(contract.OVERVIEW_PATH).fetch(getRequest(contract.OVERVIEW_PATH, overviewQuery())),
    )
    assert.equal(status, entry.status, entry.name)
    assert.equal(headers.get('cache-control'), 'no-store', entry.name)
    assert.deepEqual(body, { ok: false, error: entry.error }, entry.name)
  }
})

test('a hung session listing answers 504 on the read routes', async () => {
  const portBag = fakePorts({ listHangs: true, listTimeoutMs: 5 })
  const { routes } = await registerRoutes(portBag)
  const started = Date.now()
  const overview = await routes.get(contract.OVERVIEW_PATH)
    .fetch(getRequest(contract.OVERVIEW_PATH, overviewQuery()))
  assert.equal(overview.status, 504)
  const body = await overview.json()
  assert.equal(body.error.code, 'session/list-timeout')
  assert.match(body.error.message, /5 ms/)
  assert.match(body.error.message, /retry/i)
  assert.equal(Object.hasOwn(body.error, 'path'), false)

  const activity = await routes.get(contract.ACTIVITY_PATH)
    .fetch(getRequest(contract.ACTIVITY_PATH, overviewQuery()))
  assert.equal(activity.status, 504)
  assert.equal((await activity.json()).error.code, 'session/list-timeout')
  assert.equal(portBag.state.listCalls, 2, 'each route bounded its own listing call')
  assert.ok(Date.now() - started < 1_000, 'the injected bound keeps the timeout path fast')
  assert.deepEqual(portBag.state.roots, [], 'the timeout fires before cwd or store are touched')
})

test('a late rejection from a timed-out listing never becomes unhandled', async () => {
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const portBag = fakePorts({
      listLateErrorAfterMs: 20,
      listLateError: new Error('listing failed after the 504'),
      listTimeoutMs: 5,
    })
    const { routes } = await registerRoutes(portBag)
    const response = await routes.get(contract.OVERVIEW_PATH)
      .fetch(getRequest(contract.OVERVIEW_PATH, overviewQuery()))
    assert.equal(response.status, 504)
    // Wait past the late rejection: the route already answered, so the original
    // promise must have a handler attached or this becomes an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.deepEqual(unhandled, [], 'a late rejection after the timeout stays handled')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('a slow but answering listing inside the bound still serves 200', async () => {
  const portBag = fakePorts({ listDelayMs: 5, listTimeoutMs: 50, now: () => NOW })
  const { routes } = await registerRoutes(portBag)
  const response = await routes.get(contract.OVERVIEW_PATH)
    .fetch(getRequest(contract.OVERVIEW_PATH, overviewQuery()))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

// ---------------------------------------------------------------------------
// activity
// ---------------------------------------------------------------------------

test('activity defaults to 50 rows, accepts up to 200, and maps the wire shape', async () => {
  const events = Array.from({ length: 260 }, (_, index) => makeEvent({
    eventId: `event-${index}`,
    time: new Date(Date.parse(CREATED_AT) + index * 1_000).toISOString(),
    summary: index === 259 ? 'z'.repeat(240) : `event ${index}`,
  }))
  const portBag = fakePorts({ activity: events, skippedLines: 3, now: () => NOW })
  const { routes } = await registerRoutes(portBag)
  const route = routes.get(contract.ACTIVITY_PATH)

  const byDefault = await readResponse(
    await route.fetch(getRequest(contract.ACTIVITY_PATH, overviewQuery())),
  )
  assert.equal(byDefault.status, 200)
  assert.equal(byDefault.headers.get('cache-control'), 'no-store')
  assert.equal(byDefault.body.events.length, contract.ACTIVITY_DEFAULT_LIMIT)
  assert.equal(byDefault.body.skippedLines, 3)
  assert.equal(byDefault.body.events[0].eventId, 'event-210', 'the newest window, oldest first')
  assert.equal(Array.from(byDefault.body.events.at(-1).summary).length, contract.MAX_SUMMARY_CHARS)
  assert.deepEqual(Object.keys(byDefault.body.events[0]).sort(), [
    'eventId', 'summary', 'time', 'topicId', 'type',
  ])

  const capped = await readResponse(
    await route.fetch(getRequest(contract.ACTIVITY_PATH, `${overviewQuery()}&limit=200`)),
  )
  assert.equal(capped.status, 200)
  assert.equal(capped.body.events.length, 200)
  assert.deepEqual(portBag.state.activityReads, [
    contract.ACTIVITY_DEFAULT_LIMIT,
    contract.ACTIVITY_MAX_LIMIT,
  ])
})

test('activity rejects a limit outside 1..200 or a non-integer', async () => {
  const portBag = fakePorts({ now: () => NOW })
  const { routes } = await registerRoutes(portBag)
  const route = routes.get(contract.ACTIVITY_PATH)
  for (const raw of ['0', '201', 'abc', '1.5', '-1', '1e2']) {
    const { status, body } = await readResponse(
      await route.fetch(getRequest(contract.ACTIVITY_PATH, `${overviewQuery()}&limit=${encodeURIComponent(raw)}`)),
    )
    assert.equal(status, 400, raw)
    assert.equal(body.error.code, 'request/invalid-query', raw)
    assert.match(body.error.message, /limit/, raw)
    assert.match(body.error.message, /between 1 and 200/, raw)
  }
  assert.deepEqual(portBag.state.activityReads, [], 'an invalid limit reads no activity')
  assert.deepEqual(portBag.state.storeCalls, [])
})

// ---------------------------------------------------------------------------
// topic detail
// ---------------------------------------------------------------------------

test('topic reads review requests from real files and bounds every collection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cowork-topic-'))
  const reviews = join(root, 'reviews')
  await mkdir(reviews)
  t.after(() => rm(root, { recursive: true, force: true }))

  const bigChangedPaths = Array.from({ length: 60 }, (_, index) => `src/file-${index}.ts`)
  const bigFindings = Array.from({ length: 25 }, (_, index) => ({
    id: `F${index}`,
    severity: 'high',
    problem: `problem ${index}`,
    requiredFix: `fix ${index}`,
    file: 'src/api.ts',
    line: index + 1,
  }))
  const bigVerification = Array.from({ length: 12 }, (_, index) => ({
    command: `command ${index}`,
    exitCode: index === 11 ? 1 : 0,
    evidence: `evidence ${index}`,
  }))
  await writeReviewFile(reviews, makeReviewRequest({
    requestId: 'req-pass',
    status: 'pass',
    requestedAt: '2026-01-02T03:00:00.000Z',
    reviewedAt: '2026-01-02T04:00:00.000Z',
    summary: 's'.repeat(240),
    findings: bigFindings,
    reviewVerification: bigVerification,
    changedPaths: bigChangedPaths,
  }))
  await writeReviewFile(reviews, makeReviewRequest({
    requestId: 'req-needs',
    status: 'needs_revision',
    requestedAt: '2026-01-02T02:00:00.000Z',
    reviewedAt: '2026-01-02T02:30:00.000Z',
    summary: 'needs a fix',
    findings: [{
      id: 'F1',
      severity: 'blocker',
      problem: 'missing guard',
      requiredFix: 'add the guard',
      file: 'src/api.ts',
      line: 42,
    }],
  }))
  await writeReviewFile(reviews, makeReviewRequest({
    requestId: 'req-pending',
    requestedAt: '2026-01-02T01:00:00.000Z',
    purpose: 'p'.repeat(400),
  }))
  // Skipped: damaged JSON, a name that does not match the record, a legacy
  // verdict-only review, and another topic's request.
  await writeFile(join(reviews, 'topic-1-broken.json'), '{ not json\n')
  await writeFile(
    join(reviews, 'topic-1-mismatched.json'),
    `${JSON.stringify(makeReviewRequest({ requestId: 'req-other-name' }))}\n`,
  )
  await writeFile(join(reviews, 'topic-1-20260101T000000000Z.json'), `${JSON.stringify({
    version: 1,
    threadId: 'topic-1',
    reviewerSessionId: 'reviewer-session',
    verdict: 'pass',
    summary: 'legacy verdict file',
    findings: [],
    verification: [],
    createdAt: CREATED_AT,
  })}\n`)
  await writeReviewFile(reviews, makeReviewRequest({ topicId: 'topic-2', requestId: 'req-other-topic' }))

  const workItems = Array.from({ length: 55 }, (_, index) => makeWorkItem({
    workItemId: `wi-${index}`,
    topicId: 'topic-1',
    updatedAt: new Date(Date.parse('2026-01-02T00:00:00.000Z') + index * 1_000).toISOString(),
  }))
  const document = makeDocument({
    topics: [
      makeTopic({ topicId: 'topic-1', reviewStatus: 'needs_revision', latestReviewRequestId: 'req-needs' }),
      makeTopic({ topicId: 'topic-2' }),
    ],
    workItems: [
      ...workItems,
      makeWorkItem({ workItemId: 'other-1', topicId: 'topic-2' }),
    ],
  })
  const events = [
    ...Array.from({ length: 60 }, (_, index) => makeEvent({
      eventId: `topic-event-${index}`,
      time: new Date(Date.parse(CREATED_AT) + index * 1_000).toISOString(),
      topicId: 'topic-1',
    })),
    ...Array.from({ length: 10 }, (_, index) => makeEvent({
      eventId: `other-event-${index}`,
      topicId: 'topic-2',
    })),
  ]
  const portBag = fakePorts({ document, reviewsDir: reviews, activity: events, now: () => NOW })
  const { routes } = await registerRoutes(portBag)
  const { status, body } = await readResponse(
    await routes.get(contract.TOPIC_PATH)
      .fetch(getRequest(contract.TOPIC_PATH, `${overviewQuery()}&topicId=topic-1`)),
  )
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.topic.topicId, 'topic-1')
  assert.equal(body.topic.activeWorkItems, 55)

  assert.equal(body.workItems.length, contract.MAX_TOPIC_WORK_ITEMS)
  assert.equal(body.workItems[0].workItemId, 'wi-54', 'newest first')
  assert.equal(body.workItems.at(-1).workItemId, 'wi-5')
  assert.deepEqual(Object.keys(body.workItems[0]).sort(), [
    'baseCommit', 'branch', 'headCommit', 'path', 'status', 'topicId', 'updatedAt', 'workItemId',
  ])

  assert.deepEqual(body.reviewRequests.map((row) => row.requestId), ['req-pass', 'req-needs', 'req-pending'])
  const pass = body.reviewRequests[0]
  assert.equal(pass.status, 'pass')
  assert.equal(pass.findings.length, contract.MAX_REVIEW_FINDINGS)
  assert.equal(pass.verification.length, contract.MAX_REVIEW_VERIFICATION)
  assert.equal(pass.changedPaths.length, contract.MAX_REVIEW_CHANGED_PATHS)
  assert.equal(Array.from(pass.summary).length, contract.MAX_SUMMARY_CHARS)
  assert.equal(pass.reviewedAt, '2026-01-02T04:00:00.000Z')
  const needs = body.reviewRequests[1]
  assert.equal(needs.findings[0].id, 'F1')
  assert.equal(needs.findings[0].line, 42)
  assert.equal(body.reviewRequests[2].purpose.length, 400, 'purpose is shown verbatim')
  assert.equal(body.reviewRequests[2].summary, null)

  assert.equal(body.activity.length, contract.TOPIC_ACTIVITY_LIMIT)
  assert.ok(body.activity.every((row) => row.topicId === 'topic-1'))
  assert.equal(body.activity[0].eventId, 'topic-event-10', 'the newest 50 of this topic only')
  assert.equal(portBag.state.activityReads[0], contract.ACTIVITY_MAX_LIMIT)
  assert.equal(portBag.state.writes, 0, 'a topic read never writes the index')
  // The legacy review model is gone: these methods are not even on the port.
  for (const legacy of ['listReviews', 'latestReviews', 'writeReview', 'readReview']) {
    assert.equal(legacy in portBag.ports.createStore('/repo'), false, legacy)
  }
})

test('topic caps review requests at 10, newest first', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cowork-topic-cap-'))
  const reviews = join(root, 'reviews')
  await mkdir(reviews)
  t.after(() => rm(root, { recursive: true, force: true }))
  for (let index = 1; index <= 12; index += 1) {
    const stamp = String(index).padStart(2, '0')
    await writeReviewFile(reviews, makeReviewRequest({
      requestId: `req-${stamp}`,
      requestedAt: `2026-01-02T00:${stamp}:00.000Z`,
    }))
  }
  const portBag = fakePorts({ reviewsDir: reviews, now: () => NOW })
  const { routes } = await registerRoutes(portBag)
  const { body } = await readResponse(
    await routes.get(contract.TOPIC_PATH)
      .fetch(getRequest(contract.TOPIC_PATH, `${overviewQuery()}&topicId=topic-1`)),
  )
  assert.equal(body.reviewRequests.length, contract.MAX_TOPIC_REVIEW_REQUESTS)
  assert.deepEqual(body.reviewRequests.map((row) => row.requestId), [
    'req-12', 'req-11', 'req-10', 'req-09', 'req-08',
    'req-07', 'req-06', 'req-05', 'req-04', 'req-03',
  ])
})

test('topic requires its ids and reports an unknown topic', async () => {
  const portBag = fakePorts({ now: () => NOW })
  const { routes } = await registerRoutes(portBag)
  const route = routes.get(contract.TOPIC_PATH)

  let response = await readResponse(await route.fetch(getRequest(contract.TOPIC_PATH, '')))
  assert.equal(response.status, 400)
  assert.equal(response.body.error.code, 'request/session-required')

  response = await readResponse(await route.fetch(getRequest(contract.TOPIC_PATH, overviewQuery())))
  assert.equal(response.status, 400)
  assert.deepEqual(response.body.error, {
    code: 'request/topic-required',
    message: 'query parameter topicId is required',
  })
  assert.equal(portBag.state.listCalls, 0, 'ids are validated before any host call')

  response = await readResponse(
    await route.fetch(getRequest(contract.TOPIC_PATH, `${overviewQuery()}&topicId=ghost`)),
  )
  assert.equal(response.status, 404)
  assert.equal(response.body.error.code, 'topic/not-found')
  assert.match(response.body.error.message, /ghost/)
})
