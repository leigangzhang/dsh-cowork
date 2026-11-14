import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import './support/ts-hook.mjs'
import { PANEL_ROUTES } from './support/public-surface.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `src/api.ts` imports its siblings with the build's `.js` specifiers, and
// Node's type stripping does not rewrite those to `.ts`. The rest of the repo's
// tested modules avoid runtime imports entirely; this route module cannot, so
// the test installs a resolve hook that only retries relative `.js` specifiers
// as `.ts` (and falls back to the real `.js` when there is no source sibling).

const api = await import('../src/api.ts')
const contract = await import('../src/api-contract.ts')
const inboxContract = await import('../src/inbox-contract.ts')
const reviewRequest = await import('../src/review-request.ts')
const store = await import('../src/store.ts')
const panelProbe = await import('../src/panel-probe.ts')
const requestService = await import('../src/request-service.ts')

const CREATED_AT = '2026-01-01T00:00:00.000Z'
/** A clock ten minutes after the fixture's `lastActiveAt`, so nothing transitions. */
const NOW = new Date('2026-01-02T00:10:00.000Z')
/** An activity timestamp old enough to be idle (2 h) but not resolvable (3 d). */
const STALE = '2026-01-01T00:00:00.000Z'
const HOST = '127.0.0.1:3080'
const ORIGIN = `http://${HOST}`
const MASTER = 'master-session'
const OTHER_SESSION = 'other-session'

/** One v2 topic with every field the schema requires. */
function makeTopic(overrides = {}) {
  return {
    topicId: 'topic-1',
    title: 'topic one',
    status: 'active',
    awaitingReview: false,
    blocked: false,
    blockedReason: null,
    blockedFromStatus: null,
    blockedAt: null,
    authorization: null,
    scope: 'scope one',
    ownedPaths: ['src/api.ts'],
    aliases: [],
    digest: 'did the work',
    cwd: '/repo',
    legacyCheckoutPath: null,
    createdAt: CREATED_AT,
    updatedAt: '2026-01-02T00:00:00.000Z',
    lastActiveAt: '2026-01-02T00:00:00.000Z',
    lastDeliveryConfirmedAt: '2026-01-02T00:00:00.000Z',
    resolvedAt: null,
    resolvedBy: null,
    latestReviewRequestId: null,
    reviewStatus: null,
    reviewerSessionId: null,
    ...overrides,
  }
}

/** One v2 work item with every field the schema requires. */
function makeWorkItem(overrides = {}) {
  return {
    workItemId: 'wi-1',
    topicId: 'topic-1',
    path: '/repo/.dsh-cowork/workitems/wi-1',
    branch: 'cowork/wi-1',
    baseCommit: 'aaaaaaa',
    headCommit: 'bbbbbbb',
    status: 'active',
    createdAt: CREATED_AT,
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  }
}

/** One canonical v2 index document. */
function makeDocument(overrides = {}) {
  return {
    version: 2,
    projectId: 'example.com/acme/repo',
    masterSessionId: MASTER,
    createdAt: CREATED_AT,
    masterFocusTopicId: null,
    lastRouteTopicId: null,
    topics: [makeTopic()],
    workItems: [],
    ...overrides,
  }
}

/** One activity row as the store writes it. */
function makeEvent(overrides = {}) {
  return {
    eventId: `event-${Math.random().toString(16).slice(2)}`,
    time: '2026-01-02T00:00:00.000Z',
    type: 'status-changed',
    topicId: 'topic-1',
    summary: 'changed something',
    details: {},
    ...overrides,
  }
}

/** One inbox item; `deliveredAt: null` is the only state the overview lists. */
function makeInboxItem(overrides = {}) {
  return {
    id: 'inbox-1',
    time: '2026-01-02T00:00:00.000Z',
    topicId: 'topic-1',
    kind: 'blocked',
    summary: 'blocked on the master',
    deliveredAt: null,
    ...overrides,
  }
}

/**
 * Route-facing ports with a store whose calls are recorded. The fake store
 * intentionally exposes NO `listReviews`/`latestReviews`/`writeReview` and no
 * `readReview`: a route that fell back to the legacy review model would fail
 * with a TypeError and show up as `internal`, never quietly pass.
 */
function fakePorts(options = {}) {
  const state = {
    document: options.document ?? makeDocument(),
    storeCalls: [],
    writes: 0,
    appended: [],
    activityReads: [],
    logs: [],
    roots: [],
    listCalls: 0,
    readTexts: [],
    notices: options.notices ?? { version: 1, notices: [] },
    noticeWrites: 0,
    archived: [],
    unarchived: [],
    prompts: [],
    kicks: [],
  }
  const sessions = options.sessions ?? [{ sessionId: MASTER, cwd: '/repo' }]
  const storePort = {
    reviewsDir: options.reviewsDir ?? '/repo/.dsh-cowork/reviews',
    async hasIndex() {
      state.storeCalls.push('hasIndex')
      return options.hasIndex ?? true
    },
    async readIndexDocument() {
      state.storeCalls.push('readIndexDocument')
      if (options.readError !== undefined) throw options.readError
      return options.readDocument ?? state.document
    },
    async mutateIndexDocument(mutator) {
      state.storeCalls.push('mutateIndexDocument')
      // Optional concurrent writer: runs after the route's pre-check and before
      // the lock-scoped mutator reads the document.
      if (options.raceBeforeMutate !== undefined) options.raceBeforeMutate(state)
      const next = mutator(state.document)
      if (next === null) return state.document
      state.writes += 1
      state.document = next
      return next
    },
    async appendActivity(event) {
      state.storeCalls.push('appendActivity')
      if (options.appendError !== undefined) throw options.appendError
      state.appended.push(event)
    },
    async readActivity(limit = 50) {
      state.activityReads.push(limit)
      if (options.activityError !== undefined) throw options.activityError
      const events = options.activity ?? []
      return { events: limit > 0 ? events.slice(-limit) : [], skippedLines: options.skippedLines ?? 0 }
    },
    async readInbox() {
      state.storeCalls.push('readInbox')
      if (options.inboxError !== undefined) throw options.inboxError
      return options.inbox ?? []
    },
    async readText(absPath) {
      state.readTexts.push(absPath)
      if (options.readTextError !== undefined) throw options.readTextError
      try {
        return await readFile(absPath, 'utf8')
      } catch (error) {
        const code = error.code
        if (code === 'ENOENT' || code === 'ENOTDIR') return null
        throw error
      }
    },
    async readNotices() {
      return state.notices
    },
    async writeNotices(ledger) {
      state.noticeWrites += 1
      state.notices = ledger
      return ledger
    },
    async mutateNotices(mutator) {
      state.noticeWrites += 1
      state.notices = mutator(state.notices)
      return state.notices
    },
  }
  const ports = {
    // Deliberately no `inspectSession`: the routes must resolve the cwd from
    // session metadata, so any regression back to `inspect` fails loudly.
    async listSessions() {
      state.listCalls += 1
      if (options.listDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.listDelayMs))
      }
      if (options.listError !== undefined) throw options.listError
      if (options.listHangs === true) return new Promise(() => {})
      if (options.listLateErrorAfterMs !== undefined) {
        return new Promise((_resolve, reject) => {
          setTimeout(
            () => reject(options.listLateError ?? new Error('listing failed late')),
            options.listLateErrorAfterMs,
          )
        })
      }
      return { items: sessions }
    },
    ...(options.listTimeoutMs === undefined ? {} : { listSessionsTimeoutMs: options.listTimeoutMs }),
    async findProjectRoot(startPath) {
      state.roots.push(startPath)
      return Object.hasOwn(options, 'root') ? options.root : '/repo'
    },
    createStore(repoPath) {
      state.roots.push(`store:${repoPath}`)
      return storePort
    },
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.idleAfterMs === undefined ? {} : { idleAfterMs: options.idleAfterMs }),
    log: (message) => state.logs.push(message),
    ...(options.noArchive === true
      ? {}
      : { archiveSession: async (sessionId, archiveOptions) => {
          state.archived.push({ sessionId, options: archiveOptions })
          if (options.archiveError !== undefined) throw options.archiveError
        } }),
    ...(options.noUnarchive === true
      ? {}
      : { unarchiveSession: async (sessionId) => {
          state.unarchived.push(sessionId)
          if (options.unarchiveError !== undefined) throw options.unarchiveError
        } }),
    promptSession: options.noPrompt === true ? undefined : async (sessionId, text) => {
      state.prompts.push({ sessionId, text })
      return { accepted: options.promptAccepted ?? true }
    },
    ...(options.noticePort === undefined ? {} : { noticePort: options.noticePort }),
    kickNotices: (repoPath) => state.kicks.push(repoPath),
  }
  return { ports, state }
}

/** A Cordis-like host: `get` returns the connection service or undefined. */
function fakeHost(connection) {
  const effects = []
  return {
    effects,
    host: {
      get(name) {
        return name === 'connection' ? connection : undefined
      },
      effect(execute, label) {
        effects.push({ label, disposer: execute() })
      },
    },
  }
}

function fakeConnection() {
  const routes = new Map()
  const registered = []
  return {
    routes,
    registered,
    connection: {
      fetch: {
        register(route) {
          if (routes.has(route.path)) throw new Error(`duplicate route: ${route.path}`)
          routes.set(route.path, route)
          registered.push(route)
          return async () => {
            routes.delete(route.path)
          }
        },
      },
    },
  }
}

async function registerRoutes(portBag) {
  const fake = fakeConnection()
  const { host, effects } = fakeHost(fake.connection)
  api.registerCoworkApi(host, portBag.ports)
  return { ...fake, effects, host }
}

/** A GET from the panel origin; `headers` overrides the defaults. */
function getRequest(path, query = '', headers = {}) {
  return new Request(`http://${HOST}${path}${query}`, { headers: { host: HOST, ...headers } })
}

/** A POST from the panel origin; `contentType: null` omits the header. */
function postRequest(path, body, options = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const headers = new Headers({ host: HOST, ...options.headers })
  if (options.contentType !== null) headers.set('content-type', options.contentType ?? 'application/json')
  return new Request(`http://${HOST}${path}`, { method: 'POST', headers, body: text })
}

/** Body of one served response, plus its status and headers. */
async function readResponse(response) {
  return { status: response.status, headers: response.headers, body: await response.json() }
}

const overviewQuery = (sessionId = MASTER) => `?sessionId=${encodeURIComponent(sessionId)}`

const topicsById = (rows) => new Map(rows.map((row) => [row.topicId, row]))

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

/** One valid review-request record, pending unless overridden. */
function makeReviewRequest(overrides = {}) {
  return {
    version: 1,
    requestId: 'req-pending',
    topicId: 'topic-1',
    workItemId: null,
    purpose: 'review the panel API',
    notes: '',
    extra: {},
    baseCommit: 'aaaaaaa',
    headCommit: 'bbbbbbb',
    path: '/repo',
    branch: 'feat/m11',
    changedPaths: ['src/api.ts'],
    verification: [{ command: 'node --test tests/api.test.mjs', exitCode: 0, evidence: '21 passed' }],
    previousRequestId: null,
    status: 'pending',
    reviewerSessionId: 'reviewer-session',
    requestedAt: '2026-01-02T00:00:00.000Z',
    reviewedAt: null,
    summary: null,
    findings: [],
    reviewVerification: [],
    ...overrides,
  }
}

/** Write a request record under its canonical file name and returns the path. */
async function writeReviewFile(dir, record) {
  const fileName = reviewRequest.reviewRequestFileName(record.topicId, record.requestId)
  assert.ok(fileName !== null, `request id must be file-name safe: ${record.requestId}`)
  await writeFile(join(dir, fileName), `${JSON.stringify(record, null, 2)}\n`)
  return fileName
}

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

/** A supported notice port that records the card patches. */
function fakeNoticePort() {
  const updates = []
  return {
    updates,
    capabilities: () => ({ supported: true, actions: true, updates: true }),
    append: async () => 'delivered',
    update: async (sessionId, noticeId, patch) => {
      updates.push({ sessionId, noticeId, patch })
      return 'delivered'
    },
  }
}

/** One pending authorization topic plus the activity and ledger it produced. */
function pendingAuthorizationFixture() {
  const requested = makeEvent({
    eventId: 'event-auth-1',
    type: 'authorization-requested',
    topicId: 'topic-1',
    summary: 'requested authorization: may I?',
    details: { topicId: 'topic-1', requestId: 'req-1', notice: { kind: 'authorization', title: 'Topic', summary: 'may I?', targets: ['master', 'topic'] } },
  })
  const topic = makeTopic({
    topicId: 'topic-1',
    status: 'active',
    blocked: true,
    blockedReason: 'authorization',
    blockedFromStatus: 'idle',
    blockedAt: '2026-01-02T00:00:00.000Z',
    authorization: { requestId: 'req-1', summary: 'may I?', requestedAt: '2026-01-02T00:00:00.000Z' },
  })
  return { requested, topic }
}

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

// ---------------------------------------------------------------------------
// authorization.resolve
// ---------------------------------------------------------------------------

test('authorization.resolve allows the master to decide, restores the status, and prompts the topic only', async () => {
  const { requested, topic } = pendingAuthorizationFixture()
  const document = makeDocument({ topics: [topic] })
  const port = fakeNoticePort()
  const portBag = fakePorts({ document, now: () => NOW, activity: [requested], noticePort: port })
  const { routes } = await registerRoutes(portBag)
  const { status, body } = await readResponse(
    await routes.get(contract.AUTHORIZATION_RESOLVE_PATH).fetch(
      postRequest(contract.AUTHORIZATION_RESOLVE_PATH, {
        sessionId: MASTER,
        topicId: 'topic-1',
        requestId: 'req-1',
        decision: 'allow',
      }),
    ),
  )
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.requestId, 'req-1')
  assert.equal(body.decision, 'allow')
  assert.equal(body.changed, true)
  assert.equal(body.prompted, true)
  assert.equal(body.noticeId, 'event-auth-1')
  assert.equal(body.topic.status, 'idle', 'the block restores the status it interrupted')
  assert.equal(body.topic.awaitingAuthorization, false)
  const stored = portBag.state.document.topics[0]
  assert.equal(stored.authorization, null)
  assert.equal(stored.blockedReason, null)
  assert.equal(stored.lastActiveAt, NOW.toISOString())
  // The topic session continues; the master gets no extra message.
  assert.deepEqual(portBag.state.prompts.map((entry) => entry.sessionId), ['topic-1'])
  assert.match(portBag.state.prompts[0].text, /授权请求已允许/)
  const resolved = portBag.state.appended.find((event) => event.type === 'authorization-resolved')
  assert.equal(resolved.details.requestId, 'req-1')
  assert.equal(resolved.details.noticeId, 'event-auth-1')
  assert.equal(resolved.details.decision, 'allow')
  assert.deepEqual(port.updates.map((entry) => [entry.sessionId, entry.patch.status]), [
    ['master-session', 'allowed'],
    ['topic-1', 'allowed'],
  ])
  assert.equal(portBag.state.noticeWrites, 0, 'a decision updates the notice, it never adds a ledger row')
})

test('the topic session may decide its own request without prompting itself', async () => {
  const { requested, topic } = pendingAuthorizationFixture()
  const document = makeDocument({ topics: [topic] })
  const portBag = fakePorts({
    document,
    now: () => NOW,
    activity: [requested],
    sessions: [{ sessionId: 'topic-1', cwd: '/repo' }],
  })
  const { routes } = await registerRoutes(portBag)
  const { status, body } = await readResponse(
    await routes.get(contract.AUTHORIZATION_RESOLVE_PATH).fetch(
      postRequest(contract.AUTHORIZATION_RESOLVE_PATH, {
        sessionId: 'topic-1',
        topicId: 'topic-1',
        requestId: 'req-1',
        decision: 'deny',
      }),
    ),
  )
  assert.equal(status, 200)
  assert.equal(body.decision, 'deny')
  assert.equal(body.prompted, false)
  assert.deepEqual(portBag.state.prompts, [])
})

test('authorization.resolve rejects a wrong request id, a foreign session, and a missing request', async () => {
  const { requested, topic } = pendingAuthorizationFixture()
  const document = makeDocument({ topics: [topic] })

  const mismatch = fakePorts({ document, now: () => NOW, activity: [requested] })
  const mismatchRoutes = await registerRoutes(mismatch)
  const wrong = await readResponse(
    await mismatchRoutes.routes.get(contract.AUTHORIZATION_RESOLVE_PATH).fetch(
      postRequest(contract.AUTHORIZATION_RESOLVE_PATH, {
        sessionId: MASTER, topicId: 'topic-1', requestId: 'req-other', decision: 'allow',
      }),
    ),
  )
  assert.equal(wrong.status, 409)
  assert.equal(wrong.body.error.code, 'authorization/mismatch')
  assert.equal(mismatch.state.writes, 0)

  const foreign = fakePorts({
    document,
    now: () => NOW,
    activity: [requested],
    sessions: [{ sessionId: OTHER_SESSION, cwd: '/repo' }],
  })
  const foreignRoutes = await registerRoutes(foreign)
  const denied = await readResponse(
    await foreignRoutes.routes.get(contract.AUTHORIZATION_RESOLVE_PATH).fetch(
      postRequest(contract.AUTHORIZATION_RESOLVE_PATH, {
        sessionId: OTHER_SESSION, topicId: 'topic-1', requestId: 'req-1', decision: 'allow',
      }),
    ),
  )
  assert.equal(denied.status, 403)
  assert.equal(denied.body.error.code, 'authorization/not-allowed')
  assert.equal(foreign.state.writes, 0)

  const missing = fakePorts({ now: () => NOW })
  const missingRoutes = await registerRoutes(missing)
  const notFound = await readResponse(
    await missingRoutes.routes.get(contract.AUTHORIZATION_RESOLVE_PATH).fetch(
      postRequest(contract.AUTHORIZATION_RESOLVE_PATH, {
        sessionId: MASTER, topicId: 'topic-1', requestId: 'req-1', decision: 'allow',
      }),
    ),
  )
  assert.equal(notFound.status, 404)
  assert.equal(notFound.body.error.code, 'authorization/not-found')
})

test('authorization.resolve is idempotent for the same decision and conflicts on a different one', async () => {
  const { requested, topic } = pendingAuthorizationFixture()
  const resolvedTopic = makeTopic({ topicId: 'topic-1' })
  const resolvedEvent = makeEvent({
    eventId: 'event-auth-1-resolved',
    type: 'authorization-resolved',
    topicId: 'topic-1',
    summary: 'authorization allowed',
    details: { topicId: 'topic-1', requestId: 'req-1', noticeId: 'event-auth-1', decision: 'allow' },
  })

  const replay = fakePorts({
    document: makeDocument({ topics: [resolvedTopic] }),
    now: () => NOW,
    activity: [requested, resolvedEvent],
  })
  const replayRoutes = await registerRoutes(replay)
  const same = await readResponse(
    await replayRoutes.routes.get(contract.AUTHORIZATION_RESOLVE_PATH).fetch(
      postRequest(contract.AUTHORIZATION_RESOLVE_PATH, {
        sessionId: MASTER, topicId: 'topic-1', requestId: 'req-1', decision: 'allow',
      }),
    ),
  )
  assert.equal(same.status, 200)
  assert.equal(same.body.changed, false)
  assert.equal(same.body.prompted, false)
  assert.equal(same.body.noticeId, 'event-auth-1')
  assert.equal(replay.state.writes, 0, 'a replay writes nothing')
  assert.equal(replay.state.appended.length, 0)

  const conflictRoutes = await registerRoutes(
    fakePorts({
      document: makeDocument({ topics: [resolvedTopic] }),
      now: () => NOW,
      activity: [requested, resolvedEvent],
    }),
  )
  const conflict = await readResponse(
    await conflictRoutes.routes.get(contract.AUTHORIZATION_RESOLVE_PATH).fetch(
      postRequest(contract.AUTHORIZATION_RESOLVE_PATH, {
        sessionId: MASTER, topicId: 'topic-1', requestId: 'req-1', decision: 'deny',
      }),
    ),
  )
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'authorization/mismatch')
})

test('a decision that loses the lock race answers from the recorded decision', async () => {
  const { requested, topic } = pendingAuthorizationFixture()
  const resolvedEvent = makeEvent({
    eventId: 'event-auth-1-resolved',
    type: 'authorization-resolved',
    topicId: 'topic-1',
    summary: 'authorization allowed',
    details: { topicId: 'topic-1', requestId: 'req-1', noticeId: 'event-auth-1', decision: 'allow' },
  })
  // Another writer clears the pending request between the route's pre-check and
  // its lock-scoped mutator, so the mutator returns null without writing.
  const loseRace = (state) => {
    state.document = {
      ...state.document,
      topics: state.document.topics.map((entry) => ({ ...entry, authorization: null, blocked: false, blockedReason: null })),
    }
  }

  const same = fakePorts({
    document: makeDocument({ topics: [topic] }),
    now: () => NOW,
    activity: [requested, resolvedEvent],
    raceBeforeMutate: loseRace,
  })
  const sameRoutes = await registerRoutes(same)
  const replay = await readResponse(
    await sameRoutes.routes.get(contract.AUTHORIZATION_RESOLVE_PATH).fetch(
      postRequest(contract.AUTHORIZATION_RESOLVE_PATH, {
        sessionId: MASTER, topicId: 'topic-1', requestId: 'req-1', decision: 'allow',
      }),
    ),
  )
  assert.equal(replay.status, 200)
  assert.equal(replay.body.ok, true)
  assert.equal(replay.body.changed, false, 'the winner already recorded the same decision')
  assert.equal(replay.body.prompted, false)
  assert.equal(replay.body.noticeId, 'event-auth-1', 'the recorded decision carries the original notice id')
  assert.equal(same.state.writes, 0, 'a lost race writes nothing')
  assert.equal(same.state.appended.length, 0)
  assert.deepEqual(same.state.prompts, [])

  const conflict = fakePorts({
    document: makeDocument({ topics: [topic] }),
    now: () => NOW,
    activity: [requested, resolvedEvent],
    raceBeforeMutate: loseRace,
  })
  const conflictRoutes = await registerRoutes(conflict)
  const refused = await readResponse(
    await conflictRoutes.routes.get(contract.AUTHORIZATION_RESOLVE_PATH).fetch(
      postRequest(contract.AUTHORIZATION_RESOLVE_PATH, {
        sessionId: MASTER, topicId: 'topic-1', requestId: 'req-1', decision: 'deny',
      }),
    ),
  )
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error.code, 'authorization/mismatch')

  // Concurrent archive: the pending request is gone and no decision was
  // recorded, so the request no longer exists.
  const archived = fakePorts({
    document: makeDocument({ topics: [topic] }),
    now: () => NOW,
    activity: [requested],
    raceBeforeMutate: (state) => {
      state.document = {
        ...state.document,
        topics: state.document.topics.map((entry) => ({
          ...entry,
          status: 'resolved',
          authorization: null,
          blocked: false,
          blockedReason: null,
          resolvedAt: '2026-01-02T00:00:00.000Z',
          resolvedBy: 'user',
        })),
      }
    },
  })
  const archivedRoutes = await registerRoutes(archived)
  const missing = await readResponse(
    await archivedRoutes.routes.get(contract.AUTHORIZATION_RESOLVE_PATH).fetch(
      postRequest(contract.AUTHORIZATION_RESOLVE_PATH, {
        sessionId: MASTER, topicId: 'topic-1', requestId: 'req-1', decision: 'allow',
      }),
    ),
  )
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error.code, 'authorization/not-found')
  assert.equal(archived.state.writes, 0)
})

test('authorization.resolve validates the decision and required fields', async () => {
  const portBag = fakePorts({ now: () => NOW })
  const { routes } = await registerRoutes(portBag)
  const route = routes.get(contract.AUTHORIZATION_RESOLVE_PATH)
  const badDecision = await readResponse(await route.fetch(postRequest(contract.AUTHORIZATION_RESOLVE_PATH, {
    sessionId: MASTER, topicId: 'topic-1', requestId: 'req-1', decision: 'maybe',
  })))
  assert.equal(badDecision.status, 400)
  assert.equal(badDecision.body.error.code, 'request/invalid-body')

  const missingRequest = await readResponse(await route.fetch(postRequest(contract.AUTHORIZATION_RESOLVE_PATH, {
    sessionId: MASTER, topicId: 'topic-1', decision: 'allow',
  })))
  assert.equal(missingRequest.status, 400)
  assert.equal(missingRequest.body.error.code, 'request/invalid-body')
})

test('overview counts the topics that await an authorization', async () => {
  const { topic } = pendingAuthorizationFixture()
  const document = makeDocument({
    topics: [topic, makeTopic({ topicId: 'topic-2' })],
  })
  const portBag = fakePorts({ document, now: () => NOW })
  const { routes } = await registerRoutes(portBag)
  const { body } = await readResponse(
    await routes.get(contract.OVERVIEW_PATH).fetch(getRequest(contract.OVERVIEW_PATH, overviewQuery())),
  )
  assert.equal(body.counts.awaitingAuthorization, 1)
  assert.equal(body.counts.blocked, 1)
  assert.equal(body.topics[0].topicId, 'topic-1', 'a blocked topic leads the list')
})

// ---------------------------------------------------------------------------
// authorization.resolve ↔ request inbox convergence (repair F1)
// ---------------------------------------------------------------------------

test('the legacy authorization route settles the inbox card over real files', async (t) => {
  const repoPath = await mkdtemp(join(tmpdir(), 'cowork-api-auth-card-'))
  t.after(() => rm(repoPath, { recursive: true, force: true }))
  const realStore = new store.ProjectStore({ repoPath, clock: () => NOW })
  await realStore.initIndex(MASTER)
  await realStore.mutateIndexDocument((document) => ({
    ...document,
    topics: [
      makeTopic({
        topicId: 'topic-1',
        status: 'idle',
        blocked: true,
        blockedReason: 'authorization',
        blockedFromStatus: 'idle',
        blockedAt: NOW.toISOString(),
        authorization: { requestId: 'req-1', summary: 'may I push?', requestedAt: NOW.toISOString() },
      }),
      makeTopic({ topicId: 'topic-2' }),
    ],
  }))
  const document = await realStore.readIndexDocument()
  const topicOne = document.topics.find((row) => row.topicId === 'topic-1')
  const topicTwo = document.topics.find((row) => row.topicId === 'topic-2')
  for (const [requestId, topic] of [['req-1', topicOne], ['req-2', topicTwo]]) {
    await requestService.createRequest({
      store: realStore,
      repoPath,
      projectId: document.projectId,
      topic,
      kind: 'authorization',
      payload: { summary: 'may I push?' },
      requestId,
      now: NOW,
    })
  }
  const prompts = []
  const promptedCards = []
  const readCard = async (requestId) => JSON.parse(
    await readFile(join(repoPath, '.dsh-cowork', 'requests', `${requestId}.json`), 'utf8'),
  )
  const { routes } = await registerRoutes({
    ports: {
      listSessions: async () => ({ items: [{ sessionId: MASTER, cwd: repoPath }] }),
      findProjectRoot: async (startPath) => (startPath === repoPath ? repoPath : null),
      createStore: () => realStore,
      now: () => NOW,
      promptSession: async (sessionId, text) => {
        prompts.push({ sessionId, text })
        // The topic is woken only after the card it continues from is durable.
        promptedCards.push(await readCard('req-1'))
        return { accepted: true }
      },
      log: () => {},
    },
  })
  const resolveAuth = async (body) => readResponse(
    await routes.get(contract.AUTHORIZATION_RESOLVE_PATH).fetch(
      postRequest(contract.AUTHORIZATION_RESOLVE_PATH, body),
    ),
  )

  const decided = await resolveAuth({
    sessionId: MASTER, topicId: 'topic-1', requestId: 'req-1', decision: 'allow',
  })
  assert.equal(decided.status, 200)
  assert.equal(decided.body.ok, true)
  assert.equal(decided.body.changed, true)
  assert.equal(decided.body.prompted, true)
  assert.equal(decided.body.requestId, 'req-1')
  assert.equal(decided.body.decision, 'allow')
  assert.equal(decided.body.noticeId, null, 'the response shape is unchanged; no notice event existed')

  const card = await readCard('req-1')
  assert.equal(card.status, 'allowed')
  assert.match(card.resolutionMessage, /已允许该授权/)
  assert.equal(card.resolvedAt, NOW.toISOString())
  assert.equal(card.resolvedBy, 'user')
  assert.deepEqual(card.delivery, { promptedAt: NOW.toISOString(), lastError: null })
  assert.equal((await readCard('req-2')).status, 'pending', 'another topic card is untouched')
  const resolvedRows = (await realStore.readActivity()).events
    .filter((event) => event.type === 'request-resolved')
  assert.equal(resolvedRows.length, 1)
  assert.equal(resolvedRows[0].details.requestId, 'req-1')
  assert.equal(resolvedRows[0].details.action, 'allow')
  assert.equal(resolvedRows[0].details.status, 'allowed')

  // The replay of the same decision still answers 200 changed=false, does not
  // prompt again, and does not rewrite the card or duplicate its activity row.
  const replay = await resolveAuth({
    sessionId: MASTER, topicId: 'topic-1', requestId: 'req-1', decision: 'allow',
  })
  assert.equal(replay.status, 200)
  assert.equal(replay.body.changed, false)
  assert.equal(replay.body.prompted, false)
  assert.deepEqual(await readCard('req-1'), card)
  assert.equal(
    (await realStore.readActivity()).events.filter((event) => event.type === 'request-resolved').length,
    1,
  )
  assert.equal(prompts.length, 1, 'only the committed decision prompts the topic')
  assert.equal(promptedCards.length, 1)
  assert.equal(promptedCards[0].status, 'allowed', 'the legacy route settles the card before prompting')
  assert.equal(promptedCards[0].delivery.promptedAt, null, 'the delivery facts are patched after the prompt')
})

test('a failed prompt on the legacy route is recorded on the card without re-prompting', async (t) => {
  const repoPath = await mkdtemp(join(tmpdir(), 'cowork-api-auth-prompt-'))
  t.after(() => rm(repoPath, { recursive: true, force: true }))
  const realStore = new store.ProjectStore({ repoPath, clock: () => NOW })
  await realStore.initIndex(MASTER)
  await realStore.mutateIndexDocument((document) => ({
    ...document,
    topics: [
      makeTopic({
        topicId: 'topic-1',
        status: 'idle',
        blocked: true,
        blockedReason: 'authorization',
        blockedFromStatus: 'idle',
        blockedAt: NOW.toISOString(),
        authorization: { requestId: 'req-1', summary: 'may I push?', requestedAt: NOW.toISOString() },
      }),
    ],
  }))
  const document = await realStore.readIndexDocument()
  await requestService.createRequest({
    store: realStore,
    repoPath,
    projectId: document.projectId,
    topic: document.topics[0],
    kind: 'authorization',
    payload: { summary: 'may I push?' },
    requestId: 'req-1',
    now: NOW,
  })
  let attempts = 0
  const { routes } = await registerRoutes({
    ports: {
      listSessions: async () => ({ items: [{ sessionId: MASTER, cwd: repoPath }] }),
      findProjectRoot: async (startPath) => (startPath === repoPath ? repoPath : null),
      createStore: () => realStore,
      now: () => NOW,
      promptSession: async () => {
        attempts += 1
        throw new Error('host is busy')
      },
      log: () => {},
    },
  })
  const readCard = async () => JSON.parse(
    await readFile(join(repoPath, '.dsh-cowork', 'requests', 'req-1.json'), 'utf8'),
  )
  const decide = async () => readResponse(
    await routes.get(contract.AUTHORIZATION_RESOLVE_PATH).fetch(
      postRequest(contract.AUTHORIZATION_RESOLVE_PATH, {
        sessionId: MASTER, topicId: 'topic-1', requestId: 'req-1', decision: 'allow',
      }),
    ),
  )

  const first = await decide()
  assert.equal(first.status, 200)
  assert.equal(first.body.changed, true)
  assert.equal(first.body.prompted, false)
  assert.equal('promptError' in first.body, false, 'the legacy response shape is unchanged')
  const card = await readCard()
  assert.equal(card.status, 'allowed', 'the card is terminal even when the prompt fails')
  assert.equal(card.delivery.promptedAt, null)
  assert.match(card.delivery.lastError, /host is busy/)

  const replay = await decide()
  assert.equal(replay.status, 200)
  assert.equal(replay.body.changed, false)
  assert.equal(replay.body.prompted, false)
  assert.equal(attempts, 1, 'a replay never prompts twice')
  assert.match((await readCard()).delivery.lastError, /host is busy/, 'a replay leaves the recorded failure alone')
})
