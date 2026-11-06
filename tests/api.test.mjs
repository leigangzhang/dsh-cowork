import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// `src/api.ts` imports its siblings with the build's `.js` specifiers, and
// Node's type stripping does not rewrite those to `.ts`. The rest of the repo's
// tested modules avoid runtime imports entirely; this route module cannot, so
// the test installs a resolve hook that only retries relative `.js` specifiers
// as `.ts` (and falls back to the real `.js` when there is no source sibling).
const HOOK_SOURCE = [
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier.startsWith('.') && specifier.endsWith('.js')) {",
  "    try { return await nextResolve(specifier.slice(0, -3) + '.ts', context) } catch {}",
  '  }',
  '  return nextResolve(specifier, context)',
  '}',
].join('\n')
register(`data:text/javascript,${encodeURIComponent(HOOK_SOURCE)}`)

const api = await import('../src/api.ts')
const contract = await import('../src/api-contract.ts')
const handoff = await import('../src/handoff.ts')
const store = await import('../src/store.ts')

const INDEX_CREATED_AT = '2026-01-01T00:00:00.000Z'

function thread(overrides = {}) {
  return {
    threadId: 't1',
    subject: 'thread one',
    status: 'new',
    cwd: '/repo',
    checkoutPath: null,
    createdAt: INDEX_CREATED_AT,
    updatedAt: INDEX_CREATED_AT,
    lastHandoffAt: null,
    ...overrides,
  }
}

function projectIndex(threads) {
  return {
    version: 1,
    projectId: 'example.com/acme/repo',
    masterSessionId: 'master-session',
    createdAt: INDEX_CREATED_AT,
    threads,
  }
}

function handoffRecord(overrides = {}) {
  return {
    version: 1,
    threadId: 't1',
    masterSessionId: 'master-session',
    status: 'awaiting_review',
    subject: 'thread one',
    summary: 'did the work',
    decisions: ['keep it simple'],
    changedPaths: ['src/api.ts'],
    artifacts: [],
    verification: [{ command: 'npm test', exitCode: 0, evidence: '65 passed' }],
    openIssues: [],
    nextStep: null,
    createdAt: '2026-01-02T00:00:00.000Z',
    deliveredAt: null,
    ...overrides,
  }
}

function handoffFile(threadId, createdAt, fileName, overrides = {}) {
  return {
    filePath: `/repo/.dsh-cowork/handoffs/${fileName}`,
    fileName,
    record: handoffRecord({ threadId, createdAt, ...overrides }),
  }
}

function reviewRecord(overrides = {}) {
  return {
    version: 1,
    threadId: 't1',
    reviewerSessionId: 'reviewer-session',
    verdict: 'needs_revision',
    summary: 'two findings need work',
    findings: [
      { id: 'F1', severity: 'high', problem: 'missing guard', requiredFix: 'add the guard', file: 'src/api.ts', line: 12 },
      { id: 'F2', severity: 'low', problem: 'typo', requiredFix: 'rename' },
    ],
    verification: [{ command: 'node --test', exitCode: 0, evidence: '65 passed' }],
    createdAt: '2026-01-03T00:00:00.000Z',
    ...overrides,
  }
}

test('buildOverview drops archived threads and keeps the panel order', () => {
  const index = projectIndex([
    thread({ threadId: 'done-1', status: 'done', updatedAt: '2026-01-09T00:00:00.000Z' }),
    thread({ threadId: 'active-1', status: 'active', updatedAt: '2026-01-02T00:00:00.000Z' }),
    thread({ threadId: 'archived-1', status: 'archived', updatedAt: '2026-01-03T00:00:00.000Z' }),
    thread({ threadId: 'review-1', status: 'awaiting_review', updatedAt: '2026-01-04T00:00:00.000Z' }),
    thread({
      threadId: 'blocked-1',
      status: 'blocked',
      updatedAt: '2026-01-05T00:00:00.000Z',
      lastHandoffAt: '2026-01-05T00:00:00.000Z',
    }),
    thread({ threadId: 'new-1', status: 'new', updatedAt: '2026-01-06T00:00:00.000Z' }),
  ])
  const overview = api.buildOverview(index, '/repo')
  assert.deepEqual(
    overview.threads.map((row) => row.threadId),
    ['review-1', 'blocked-1', 'active-1', 'new-1', 'done-1'],
  )
  assert.equal(overview.threads.some((row) => row.status === 'archived'), false)
  assert.deepEqual(
    overview.threads.filter((row) => row.hasHandoff).map((row) => row.threadId),
    ['blocked-1'],
    'hasHandoff is derived from lastHandoffAt',
  )
  assert.equal(overview.threads.find((row) => row.threadId === 'blocked-1').lastHandoffAt, '2026-01-05T00:00:00.000Z')
  assert.deepEqual(overview.project, {
    repoPath: '/repo',
    projectId: 'example.com/acme/repo',
    masterSessionId: 'master-session',
    createdAt: INDEX_CREATED_AT,
  })
})

test('buildOverview counts agree with the returned threads', () => {
  const index = projectIndex([
    thread({ threadId: 'a', status: 'awaiting_review' }),
    thread({ threadId: 'b', status: 'blocked' }),
    thread({ threadId: 'c', status: 'blocked' }),
    thread({ threadId: 'd', status: 'active' }),
    thread({ threadId: 'e', status: 'new' }),
    thread({ threadId: 'f', status: 'done' }),
    thread({ threadId: 'g', status: 'archived' }),
  ])
  const overview = api.buildOverview(index, '/repo')
  const tally = { new: 0, active: 0, awaiting_review: 0, blocked: 0, done: 0 }
  for (const row of overview.threads) tally[row.status] += 1
  assert.deepEqual(overview.counts, tally)
  assert.equal(
    overview.threads.length,
    Object.values(overview.counts).reduce((sum, value) => sum + value, 0),
    'the chips add up to the list length',
  )
})

test('buildOverview truncates to MAX_PANEL_THREADS without dropping attention rows', () => {
  const total = contract.MAX_PANEL_THREADS + 7
  const threads = []
  for (let at = 0; at < total; at += 1) {
    threads.push(thread({
      threadId: `t${at}`,
      status: 'new',
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, at)).toISOString(),
    }))
  }
  // One row that must survive the cap regardless of age.
  threads.push(thread({
    threadId: 'review-first',
    status: 'awaiting_review',
    updatedAt: '2025-01-01T00:00:00.000Z',
  }))
  const overview = api.buildOverview(projectIndex(threads), '/repo')
  assert.equal(overview.threads.length, contract.MAX_PANEL_THREADS)
  assert.equal(overview.threads[0].threadId, 'review-first')
  assert.equal(
    overview.threads[contract.MAX_PANEL_THREADS - 1].threadId,
    `t${total - (contract.MAX_PANEL_THREADS - 1)}`,
    'the cap keeps the newest rows after the attention row',
  )
  assert.deepEqual(overview.counts, {
    new: contract.MAX_PANEL_THREADS - 1,
    active: 0,
    awaiting_review: 1,
    blocked: 0,
    done: 0,
  })
})

test('selectLatestHandoff picks the newest record of one thread only', () => {
  const files = [
    handoffFile('t1', '2026-01-01T00:00:00.000Z', 't1-a.json'),
    handoffFile('t2', '2026-01-09T00:00:00.000Z', 't2-a.json'),
    handoffFile('t1', '2026-01-05T00:00:00.000Z', 't1-b.json'),
    handoffFile('t1', '2026-01-03T00:00:00.000Z', 't1-c.json'),
  ]
  assert.equal(api.selectLatestHandoff(files, 't1').fileName, 't1-b.json')
  assert.equal(api.selectLatestHandoff(files, 't2').fileName, 't2-a.json')
  assert.equal(api.selectLatestHandoff(files, 'missing'), null)
  assert.equal(api.selectLatestHandoff([], 't1'), null)
})

test('selectLatestHandoff breaks equal timestamps by file name', () => {
  const at = '2026-01-05T00:00:00.000Z'
  const files = [
    handoffFile('t1', at, 't1-a.json'),
    handoffFile('t1', at, 't1-c.json'),
    handoffFile('t1', at, 't1-b.json'),
  ]
  assert.equal(api.selectLatestHandoff(files, 't1').fileName, 't1-c.json')
})

test('buildHandoffPayload carries the exact master message and formatter version', () => {
  const file = handoffFile('t1', '2026-01-02T00:00:00.000Z', 't1-a.json')
  const payload = api.buildHandoffPayload(file)
  assert.equal(payload.filePath, '/repo/.dsh-cowork/handoffs/t1-a.json')
  assert.equal(payload.filePath, file.filePath, 'the absolute path is passed through')
  assert.equal(payload.masterMessage, handoff.formatMasterMessage(file.record, file.filePath))
  assert.match(payload.masterMessage, /^handoff from thread t1/)
  assert.equal(payload.formatterVersion, contract.HANDOFF_FORMATTER_VERSION)
  assert.equal(payload.record, file.record)
})

test('toErrorResponse maps every stable code to its status and envelope', () => {
  const table = [
    ['request/session-required', 400],
    ['request/thread-required', 400],
    ['session/unknown', 400],
    ['session/cwd-unavailable', 400],
    ['session/list-timeout', 504],
    ['project/not-initialized', 404],
    ['handoff/not-found', 404],
    ['store/corrupt', 500],
    ['internal', 500],
  ]
  for (const [code, status] of table) {
    const result = api.toErrorResponse(new api.PanelApiError(code, 'message', '/tmp/where'))
    assert.equal(result.status, status, `${code} status`)
    assert.deepEqual(result.body, {
      ok: false,
      error: { code, message: 'message', path: '/tmp/where' },
    })
  }
  assert.equal(api.panelErrorStatus('request/session-required'), 400)
  assert.equal(api.panelErrorStatus('handoff/not-found'), 404)
  assert.equal(api.panelErrorStatus('session/list-timeout'), 504, 'a hung listing is a gateway timeout')
  assert.equal(api.panelErrorStatus('internal'), 500)
  assert.equal(api.LIST_SESSIONS_TIMEOUT_MS, 30_000, 'production waits about 30 s, not forever')
  const pathless = api.toErrorResponse(new api.PanelApiError('session/unknown', 'who?'))
  assert.deepEqual(pathless.body, { ok: false, error: { code: 'session/unknown', message: 'who?' } })
})

test('toErrorResponse keeps the store path for corruption and degrades the rest', () => {
  const corrupt = api.toErrorResponse(new store.StoreError(
    'store/corrupt',
    'index is invalid',
    '/repo/.dsh-cowork/index.json',
  ))
  assert.equal(corrupt.status, 500)
  assert.deepEqual(corrupt.body, {
    ok: false,
    error: { code: 'store/corrupt', message: 'index is invalid', path: '/repo/.dsh-cowork/index.json' },
  })
  const otherStoreError = api.toErrorResponse(new store.StoreError('store/invalid-handoff', 'bad record', '/x'))
  assert.equal(otherStoreError.status, 500)
  assert.equal(otherStoreError.body.error.code, 'internal')
  const plain = api.toErrorResponse(new Error('boom'))
  assert.deepEqual(plain, { status: 500, body: { ok: false, error: { code: 'internal', message: 'boom' } } })
  const thrown = api.toErrorResponse('boom')
  assert.deepEqual(thrown, { status: 500, body: { ok: false, error: { code: 'internal', message: 'boom' } } })
})

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

/** Route-facing ports with a read-only store whose calls are recorded. */
function fakePorts(options = {}) {
  const storeCalls = []
  const roots = []
  const reviewReads = []
  const counters = { listCalls: 0 }
  const sessions = options.sessions ?? [{ sessionId: 'session-1', cwd: '/repo' }]
  const reviewFiles = options.reviewFiles ?? {}
  const reviewTexts = options.reviewTexts ?? {}
  const storePort = {
    async hasIndex() {
      storeCalls.push('hasIndex')
      return options.hasIndex ?? true
    },
    async readIndex() {
      storeCalls.push('readIndex')
      if (options.readError !== undefined) throw options.readError
      return options.index ?? projectIndex([thread({ threadId: 't1' })])
    },
    async listHandoffs() {
      storeCalls.push('listHandoffs')
      if (options.handoffError !== undefined) throw options.handoffError
      return options.handoffs ?? []
    },
    async readReview(filePath) {
      storeCalls.push('readReview')
      reviewReads.push(filePath)
      if (options.reviewError !== undefined) throw options.reviewError
      if (!Object.hasOwn(reviewFiles, filePath)) {
        throw new store.StoreError('store/not-found', `review file not found: ${filePath}`, filePath)
      }
      return reviewFiles[filePath]
    },
    async readText(absPath) {
      storeCalls.push('readText')
      reviewReads.push(absPath)
      if (options.readTextError !== undefined) throw options.readTextError
      return Object.hasOwn(reviewTexts, absPath) ? reviewTexts[absPath] : null
    },
  }
  // A host whose store predates the review reader: the route must fall back to
  // the project's own text read instead of failing the handoff.
  if (options.omitReadReview === true) delete storePort.readReview
  const ports = {
    // Deliberately no `inspectSession`: the routes must resolve the cwd from
    // session metadata, so any regression back to `inspect` fails the test with
    // a TypeError instead of quietly passing.
    async listSessions() {
      counters.listCalls += 1
      // A listing that answers late is still a valid answer when it beats the
      // bound; the route must not turn a slow host into a failure by itself.
      if (options.listDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.listDelayMs))
      }
      if (options.listError !== undefined) throw options.listError
      // A host listing that never settles: the route must bound it instead of
      // leaving the panel request pending forever.
      if (options.listHangs === true) return new Promise(() => {})
      // A listing that rejects only after the route has already answered 504.
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
    // Only present when a test injects it; production gets the 30 s default.
    ...(options.listTimeoutMs === undefined ? {} : { listSessionsTimeoutMs: options.listTimeoutMs }),
    async findProjectRoot(startPath) {
      roots.push(startPath)
      return Object.hasOwn(options, 'root') ? options.root : '/repo'
    },
    createStore(repoPath) {
      roots.push(`store:${repoPath}`)
      return storePort
    },
  }
  return { ports, storeCalls, roots, counters, reviewReads }
}

async function registerRoutes(portBag) {
  const fake = fakeConnection()
  const { host, effects } = fakeHost(fake.connection)
  api.registerCoworkApi(host, portBag.ports)
  return { ...fake, effects, host }
}

function overviewRequest(query) {
  return new Request(`http://panel.test${contract.OVERVIEW_PATH}${query}`)
}

function handoffRequest(query) {
  return new Request(`http://panel.test${contract.HANDOFF_PATH}${query}`)
}

test('registerCoworkApi registers both GET routes and disposes them', async () => {
  const portBag = fakePorts()
  const fake = fakeConnection()
  const { host, effects } = fakeHost(fake.connection)
  api.registerCoworkApi(host, portBag.ports)
  assert.equal(effects.length, 2, 'one fiber effect per route')
  assert.deepEqual(effects.map((effect) => effect.label), [
    `dsh-cowork: panel route ${contract.OVERVIEW_PATH}`,
    `dsh-cowork: panel route ${contract.HANDOFF_PATH}`,
  ])
  assert.deepEqual(fake.registered.map((route) => route.path), [
    contract.OVERVIEW_PATH,
    contract.HANDOFF_PATH,
  ])
  for (const route of fake.registered) {
    assert.deepEqual([...route.methods], ['GET'])
    assert.equal(route.requestBody, 'buffered')
    assert.equal(typeof route.fetch, 'function')
  }
  for (const effect of effects) await effect.disposer()
  assert.equal(fake.routes.size, 0, 'disposal unregisters both routes')
  api.registerCoworkApi(host, portBag.ports)
  assert.equal(fake.routes.size, 2, 'a reload re-registers without a duplicate error')
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
  assert.deepEqual(portBag.storeCalls, [])
})

test('overview route serves the panel body with no-store headers', async () => {
  const portBag = fakePorts({
    index: projectIndex([
      thread({ threadId: 't1', status: 'awaiting_review' }),
      thread({ threadId: 'hidden', status: 'archived' }),
    ]),
  })
  const { routes } = await registerRoutes(portBag)
  const response = await routes.get(contract.OVERVIEW_PATH).fetch(overviewRequest('?sessionId=session-1'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.threads.map((row) => row.threadId), ['t1'])
  assert.deepEqual(body.counts, { new: 0, active: 0, awaiting_review: 1, blocked: 0, done: 0 })
  assert.equal(body.project.repoPath, '/repo')
  assert.equal(portBag.counters.listCalls, 1, 'the cwd comes from one metadata listing')
  assert.deepEqual(portBag.roots, ['/repo', 'store:/repo'])
})

test('the project root comes from the session cwd, never from the query', async () => {
  const portBag = fakePorts()
  const { routes } = await registerRoutes(portBag)
  const response = await routes.get(contract.OVERVIEW_PATH)
    .fetch(overviewRequest('?sessionId=session-1&path=/etc&repoPath=/etc'))
  assert.equal(response.status, 200)
  assert.deepEqual(portBag.roots, ['/repo', 'store:/repo'], 'the browser path is ignored')
})

test('overview route rejects a missing session id before touching the store', async () => {
  const portBag = fakePorts()
  const { routes } = await registerRoutes(portBag)
  for (const query of ['', '?sessionId=', '?sessionId=%20']) {
    const response = await routes.get(contract.OVERVIEW_PATH).fetch(overviewRequest(query))
    assert.equal(response.status, 400)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), {
      ok: false,
      error: { code: 'request/session-required', message: 'query parameter sessionId is required' },
    })
  }
  assert.equal(portBag.counters.listCalls, 0)
})

test('the session cwd is looked up by id in the metadata listing', async () => {
  const portBag = fakePorts({
    sessions: [
      { sessionId: 'other-session', cwd: '/elsewhere' },
      { sessionId: 'session-1', cwd: '/repo' },
    ],
  })
  const { routes } = await registerRoutes(portBag)
  const response = await routes.get(contract.OVERVIEW_PATH).fetch(overviewRequest('?sessionId=session-1'))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).project.repoPath, '/repo')
  assert.equal(portBag.counters.listCalls, 1)
  assert.deepEqual(portBag.roots, ['/repo', 'store:/repo'], 'only the matching session cwd is used')
})

test('the routes never call inspectSession, only the metadata listing', async () => {
  const portBag = fakePorts()
  assert.equal('inspectSession' in portBag.ports, false, 'fake ports expose listSessions only')
  const { routes } = await registerRoutes(portBag)
  const response = await routes.get(contract.HANDOFF_PATH)
    .fetch(handoffRequest('?sessionId=session-1&threadId=t1'))
  // A thread without handoffs still proves the session lookup ran: it reaches
  // handoff/not-found instead of failing on a missing inspectSession.
  assert.equal(response.status, 404)
  assert.equal((await response.json()).error.code, 'handoff/not-found')
  assert.equal(portBag.counters.listCalls, 1)
})

test('overview route maps session failures to the shared envelope', async () => {
  const unknown = fakePorts({ sessions: [{ sessionId: 'someone-else', cwd: '/repo' }] })
  let { routes } = await registerRoutes(unknown)
  let response = await routes.get(contract.OVERVIEW_PATH).fetch(overviewRequest('?sessionId=ghost'))
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    ok: false,
    error: { code: 'session/unknown', message: 'unknown session: ghost' },
  })
  assert.equal(unknown.counters.listCalls, 1)

  const noCwd = fakePorts({ sessions: [{ sessionId: 'session-1' }] })
  ;({ routes } = await registerRoutes(noCwd))
  response = await routes.get(contract.OVERVIEW_PATH).fetch(overviewRequest('?sessionId=session-1'))
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    ok: false,
    error: { code: 'session/cwd-unavailable', message: 'session has no working directory: session-1' },
  })
})

test('a failing metadata listing is a host failure, not an unknown session', async () => {
  const portBag = fakePorts({ listError: new Error('session store unavailable') })
  const { routes } = await registerRoutes(portBag)
  const response = await routes.get(contract.OVERVIEW_PATH).fetch(overviewRequest('?sessionId=session-1'))
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), {
    ok: false,
    error: { code: 'internal', message: 'session store unavailable' },
  })
})

test('a hung metadata listing answers 504 session/list-timeout on both routes', async () => {
  const portBag = fakePorts({ listHangs: true, listTimeoutMs: 5 })
  const { routes } = await registerRoutes(portBag)
  const started = Date.now()

  const overview = await routes.get(contract.OVERVIEW_PATH)
    .fetch(overviewRequest('?sessionId=session-1'))
  assert.equal(overview.status, 504)
  assert.equal(overview.headers.get('cache-control'), 'no-store')
  const overviewBody = await overview.json()
  assert.equal(overviewBody.ok, false)
  assert.equal(overviewBody.error.code, 'session/list-timeout')
  assert.match(overviewBody.error.message, /5 ms/, 'the message names the waited duration')
  assert.match(overviewBody.error.message, /retry/i, 'the message says the request is retryable')
  assert.equal(Object.hasOwn(overviewBody.error, 'path'), false, 'a timeout names no file path')

  const handoff = await routes.get(contract.HANDOFF_PATH)
    .fetch(handoffRequest('?sessionId=session-1&threadId=t1'))
  assert.equal(handoff.status, 504)
  assert.equal(handoff.headers.get('cache-control'), 'no-store')
  assert.equal((await handoff.json()).error.code, 'session/list-timeout')

  assert.equal(portBag.counters.listCalls, 2, 'each route bounded its own listing call')
  assert.ok(Date.now() - started < 1_000, 'the injected bound keeps the timeout path fast')
  assert.deepEqual(portBag.roots, [], 'the timeout fires before cwd or store are touched')
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
      .fetch(overviewRequest('?sessionId=session-1'))
    assert.equal(response.status, 504)
    assert.equal((await response.json()).error.code, 'session/list-timeout')
    // Wait past the late rejection: the route already answered, so the original
    // promise must have a handler attached or this becomes an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.deepEqual(unhandled, [], 'a late rejection after the timeout stays handled')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('a slow but answering listing inside the bound still serves 200', async () => {
  const portBag = fakePorts({
    listDelayMs: 5,
    listTimeoutMs: 50,
    handoffs: [handoffFile('t1', '2026-01-01T00:00:00.000Z', 't1-a.json')],
  })
  const { routes } = await registerRoutes(portBag)

  const overview = await routes.get(contract.OVERVIEW_PATH)
    .fetch(overviewRequest('?sessionId=session-1'))
  assert.equal(overview.status, 200)
  assert.equal(overview.headers.get('cache-control'), 'no-store')

  const handoff = await routes.get(contract.HANDOFF_PATH)
    .fetch(handoffRequest('?sessionId=session-1&threadId=t1'))
  assert.equal(handoff.status, 200)
  assert.equal(handoff.headers.get('cache-control'), 'no-store')
  assert.equal(portBag.counters.listCalls, 2)
})

test('overview route reports a project that was never initialized with the searched cwd', async () => {
  const portBag = fakePorts({ root: null })
  const { routes } = await registerRoutes(portBag)
  const response = await routes.get(contract.OVERVIEW_PATH).fetch(overviewRequest('?sessionId=session-1'))
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), {
    ok: false,
    error: {
      code: 'project/not-initialized',
      message: 'no .dsh-cowork project above /repo',
      path: '/repo',
    },
  })
})

test('overview route reports a vanished index and a corrupt store distinctly', async () => {
  const vanished = fakePorts({ hasIndex: false })
  let { routes } = await registerRoutes(vanished)
  let response = await routes.get(contract.OVERVIEW_PATH).fetch(overviewRequest('?sessionId=session-1'))
  assert.equal(response.status, 404)
  assert.equal((await response.json()).error.code, 'project/not-initialized')

  const corrupt = fakePorts({
    readError: new store.StoreError('store/corrupt', 'invalid JSON', '/repo/.dsh-cowork/index.json'),
  })
  ;({ routes } = await registerRoutes(corrupt))
  response = await routes.get(contract.OVERVIEW_PATH).fetch(overviewRequest('?sessionId=session-1'))
  assert.equal(response.status, 500)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), {
    ok: false,
    error: { code: 'store/corrupt', message: 'invalid JSON', path: '/repo/.dsh-cowork/index.json' },
  })
})

test('overview route maps unexpected store failures to internal', async () => {
  const portBag = fakePorts({ readError: new Error('disk on fire') })
  const { routes } = await registerRoutes(portBag)
  const response = await routes.get(contract.OVERVIEW_PATH).fetch(overviewRequest('?sessionId=session-1'))
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), {
    ok: false,
    error: { code: 'internal', message: 'disk on fire' },
  })
})

test('handoff route requires both ids in order', async () => {
  const portBag = fakePorts()
  const { routes } = await registerRoutes(portBag)
  const route = routes.get(contract.HANDOFF_PATH)
  let response = await route.fetch(handoffRequest('?threadId=t1'))
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, 'request/session-required')
  response = await route.fetch(handoffRequest('?sessionId=session-1'))
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    ok: false,
    error: { code: 'request/thread-required', message: 'query parameter threadId is required' },
  })
  assert.equal(portBag.counters.listCalls, 0, 'ids are validated before any host call')
})

test('handoff route serves the latest handoff of the requested thread', async () => {
  const handoffs = [
    handoffFile('t1', '2026-01-01T00:00:00.000Z', 't1-a.json'),
    handoffFile('t2', '2026-01-09T00:00:00.000Z', 't2-a.json'),
    handoffFile('t1', '2026-01-07T00:00:00.000Z', 't1-b.json'),
  ]
  const portBag = fakePorts({ handoffs })
  const { routes } = await registerRoutes(portBag)
  const response = await routes.get(contract.HANDOFF_PATH)
    .fetch(handoffRequest('?sessionId=session-1&threadId=t1'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.handoff.filePath, '/repo/.dsh-cowork/handoffs/t1-b.json')
  assert.equal(body.handoff.formatterVersion, contract.HANDOFF_FORMATTER_VERSION)
  const expected = handoff.formatMasterMessage(
    handoffs[2].record,
    handoffs[2].filePath,
  )
  assert.equal(body.handoff.masterMessage, expected)
  assert.equal(body.handoff.record.threadId, 't1')
})

test('overview maps the index review fields and degrades older or odd rows to null', () => {
  const index = projectIndex([
    thread({
      threadId: 'reviewed',
      status: 'awaiting_review',
      reviewStatus: 'needs_revision',
      reviewedAt: '2026-01-03T00:00:00.000Z',
      reviewerSessionId: 'reviewer-1',
      latestReviewPath: '/repo/.dsh-cowork/reviews/t1-a.json',
    }),
    // An index written before M3 has none of the review fields.
    thread({ threadId: 'legacy', status: 'active' }),
    // A hand-written index may carry values the union does not allow.
    thread({
      threadId: 'odd',
      status: 'done',
      reviewStatus: 'passing',
      reviewedAt: 42,
      reviewerSessionId: '   ',
    }),
  ])
  const overview = api.buildOverview(index, '/repo')
  const reviewed = overview.threads.find((row) => row.threadId === 'reviewed')
  assert.equal(reviewed.reviewStatus, 'needs_revision')
  assert.equal(reviewed.reviewedAt, '2026-01-03T00:00:00.000Z')
  assert.equal(reviewed.reviewerSessionId, 'reviewer-1')

  const legacy = overview.threads.find((row) => row.threadId === 'legacy')
  assert.equal(legacy.reviewStatus, null)
  assert.equal(legacy.reviewedAt, null)
  assert.equal(legacy.reviewerSessionId, null)

  const odd = overview.threads.find((row) => row.threadId === 'odd')
  assert.equal(odd.reviewStatus, null, 'an unknown review state is no review')
  assert.equal(odd.reviewedAt, null, 'a non-string timestamp is no timestamp')
  assert.equal(odd.reviewerSessionId, null, 'a blank session id is no session')

  // Review state never enters the counts or the sort.
  assert.deepEqual(overview.counts, { new: 0, active: 1, awaiting_review: 1, blocked: 0, done: 1 })
  assert.deepEqual(
    overview.threads.map((row) => row.threadId),
    ['reviewed', 'legacy', 'odd'],
    'the panel order stays status-then-recency',
  )
})

test('handoff route returns the review its index pointer names', async () => {
  const pointer = '/repo/.dsh-cowork/reviews/t1-b.json'
  const portBag = fakePorts({
    handoffs: [handoffFile('t1', '2026-01-02T00:00:00.000Z', 't1-a.json')],
    index: projectIndex([thread({ threadId: 't1', latestReviewPath: pointer })]),
    reviewFiles: { [pointer]: reviewRecord() },
  })
  const { routes } = await registerRoutes(portBag)
  const response = await routes.get(contract.HANDOFF_PATH)
    .fetch(handoffRequest('?sessionId=session-1&threadId=t1'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.equal(body.handoff.review.filePath, pointer)
  assert.equal(body.handoff.review.record.verdict, 'needs_revision')
  assert.equal(body.handoff.review.record.summary, 'two findings need work')
  assert.equal(body.handoff.review.record.reviewerSessionId, 'reviewer-session')
  assert.equal(body.handoff.review.record.createdAt, '2026-01-03T00:00:00.000Z')
  assert.deepEqual(body.handoff.review.record.findings.map((row) => row.id), ['F1', 'F2'])
  assert.equal(body.handoff.review.record.findings[0].line, 12)
  assert.deepEqual(body.handoff.review.record.verification, [
    { command: 'node --test', exitCode: 0, evidence: '65 passed' },
  ])
  assert.deepEqual(portBag.reviewReads, [pointer], 'only the pointed file is read, never a directory guess')
})

test('handoff review is null without a pointer, with a null pointer, or when the file is gone', async () => {
  const handoffAt = '2026-01-02T00:00:00.000Z'
  const handoffs = [handoffFile('t1', handoffAt, 't1-a.json')]

  // 1. Legacy index: the field itself is missing.
  let portBag = fakePorts({ handoffs, index: projectIndex([thread({ threadId: 't1' })]) })
  let { routes } = await registerRoutes(portBag)
  let response = await routes.get(contract.HANDOFF_PATH)
    .fetch(handoffRequest('?sessionId=session-1&threadId=t1'))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).handoff.review, null)
  assert.deepEqual(portBag.reviewReads, [], 'no pointer means no read at all')

  // 2. Explicit null pointer.
  portBag = fakePorts({
    handoffs,
    index: projectIndex([thread({ threadId: 't1', latestReviewPath: null })]),
  })
  ;({ routes } = await registerRoutes(portBag))
  response = await routes.get(contract.HANDOFF_PATH)
    .fetch(handoffRequest('?sessionId=session-1&threadId=t1'))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).handoff.review, null)

  // 3. Pointer kept, file removed after the verdict: still a usable handoff.
  portBag = fakePorts({
    handoffs,
    index: projectIndex([thread({ threadId: 't1', latestReviewPath: '/repo/.dsh-cowork/reviews/gone.json' })]),
  })
  ;({ routes } = await registerRoutes(portBag))
  response = await routes.get(contract.HANDOFF_PATH)
    .fetch(handoffRequest('?sessionId=session-1&threadId=t1'))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.handoff.review, null)
  assert.equal(body.handoff.filePath, '/repo/.dsh-cowork/handoffs/t1-a.json', 'the handoff still renders')
})

test('a store without readReview falls back to the project text read', async () => {
  const pointer = '/repo/.dsh-cowork/reviews/t1-a.json'
  const portBag = fakePorts({
    handoffs: [handoffFile('t1', '2026-01-02T00:00:00.000Z', 't1-a.json')],
    index: projectIndex([thread({ threadId: 't1', latestReviewPath: pointer })]),
    omitReadReview: true,
    reviewTexts: { [pointer]: JSON.stringify(reviewRecord({ verdict: 'pass' })) },
  })
  const { routes } = await registerRoutes(portBag)
  const response = await routes.get(contract.HANDOFF_PATH)
    .fetch(handoffRequest('?sessionId=session-1&threadId=t1'))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.handoff.review.record.verdict, 'pass')
  assert.equal(body.handoff.review.filePath, pointer)
})

test('a missing fallback file is no review, not an error', async () => {
  const pointer = '/repo/.dsh-cowork/reviews/t1-a.json'
  const portBag = fakePorts({
    handoffs: [handoffFile('t1', '2026-01-02T00:00:00.000Z', 't1-a.json')],
    index: projectIndex([thread({ threadId: 't1', latestReviewPath: pointer })]),
    omitReadReview: true,
  })
  const { routes } = await registerRoutes(portBag)
  const response = await routes.get(contract.HANDOFF_PATH)
    .fetch(handoffRequest('?sessionId=session-1&threadId=t1'))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).handoff.review, null)
})

test('a damaged review document is store/corrupt, other read failures stay internal', async () => {
  const pointer = '/repo/.dsh-cowork/reviews/t1-a.json'
  const handoffs = [handoffFile('t1', '2026-01-02T00:00:00.000Z', 't1-a.json')]
  const index = projectIndex([thread({ threadId: 't1', latestReviewPath: pointer })])

  // A document without a valid verdict cannot be labelled: report the file.
  let portBag = fakePorts({
    handoffs,
    index,
    reviewFiles: { [pointer]: { verdict: 'pending', summary: 'x', reviewerSessionId: 'r', createdAt: 'nope' } },
  })
  let { routes } = await registerRoutes(portBag)
  let response = await routes.get(contract.HANDOFF_PATH)
    .fetch(handoffRequest('?sessionId=session-1&threadId=t1'))
  assert.equal(response.status, 500)
  let body = await response.json()
  assert.equal(body.error.code, 'store/corrupt')
  assert.equal(body.error.path, pointer)
  assert.equal(response.headers.get('cache-control'), 'no-store')

  // A typed store error keeps its corrupt mapping.
  portBag = fakePorts({
    handoffs,
    index,
    reviewError: new store.StoreError('store/corrupt', 'review JSON is invalid', pointer),
  })
  ;({ routes } = await registerRoutes(portBag))
  response = await routes.get(contract.HANDOFF_PATH)
    .fetch(handoffRequest('?sessionId=session-1&threadId=t1'))
  assert.equal(response.status, 500)
  body = await response.json()
  assert.deepEqual(body.error, { code: 'store/corrupt', message: 'review JSON is invalid', path: pointer })

  // Anything else degrades to internal, like every other unexpected read.
  portBag = fakePorts({ handoffs, index, reviewError: new Error('disk on fire') })
  ;({ routes } = await registerRoutes(portBag))
  response = await routes.get(contract.HANDOFF_PATH)
    .fetch(handoffRequest('?sessionId=session-1&threadId=t1'))
  assert.equal(response.status, 500)
  body = await response.json()
  assert.deepEqual(body.error, { code: 'internal', message: 'disk on fire' })
})

test('a malformed fallback review document is store/corrupt', async () => {
  const pointer = '/repo/.dsh-cowork/reviews/t1-a.json'
  const portBag = fakePorts({
    handoffs: [handoffFile('t1', '2026-01-02T00:00:00.000Z', 't1-a.json')],
    index: projectIndex([thread({ threadId: 't1', latestReviewPath: pointer })]),
    omitReadReview: true,
    reviewTexts: { [pointer]: '{not json' },
  })
  const { routes } = await registerRoutes(portBag)
  const response = await routes.get(contract.HANDOFF_PATH)
    .fetch(handoffRequest('?sessionId=session-1&threadId=t1'))
  assert.equal(response.status, 500)
  const body = await response.json()
  assert.equal(body.error.code, 'store/corrupt')
  assert.equal(body.error.path, pointer)
})

test('handoff route reports a thread without a handoff', async () => {
  const portBag = fakePorts({ handoffs: [handoffFile('other', '2026-01-01T00:00:00.000Z', 'other-a.json')] })
  const { routes } = await registerRoutes(portBag)
  const response = await routes.get(contract.HANDOFF_PATH)
    .fetch(handoffRequest('?sessionId=session-1&threadId=t1'))
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), {
    ok: false,
    error: { code: 'handoff/not-found', message: 'thread has no handoff: t1' },
  })
})

test('neither route ever calls a store write', async () => {
  const portBag = fakePorts({
    handoffs: [handoffFile('t1', '2026-01-01T00:00:00.000Z', 't1-a.json')],
  })
  const { routes } = await registerRoutes(portBag)
  const results = await Promise.all([
    routes.get(contract.OVERVIEW_PATH).fetch(overviewRequest('?sessionId=session-1')),
    routes.get(contract.HANDOFF_PATH).fetch(handoffRequest('?sessionId=session-1&threadId=t1')),
  ])
  assert.deepEqual(results.map((response) => response.status), [200, 200])
  const allowed = new Set(['hasIndex', 'readIndex', 'listHandoffs', 'readReview', 'readText'])
  for (const call of portBag.storeCalls) assert.ok(allowed.has(call), `unexpected store call: ${call}`)
})
