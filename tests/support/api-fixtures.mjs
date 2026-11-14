/**
 * Shared setup of the three panel API suites (`api-read`, `api-write`,
 * `api-auth`), extracted from the former `tests/api.test.mjs`: the v2 record
 * fixtures, the fake host/ports, the route helpers, and the review/notice
 * fixtures. The assertions stay in each suite; this module holds no test.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import './ts-hook.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `src/api.ts` imports its siblings with the build's `.js` specifiers, and
// Node's type stripping does not rewrite those to `.ts`. The rest of the repo's
// tested modules avoid runtime imports entirely; this route module cannot, so
// the test installs a resolve hook that only retries relative `.js` specifiers
// as `.ts` (and falls back to the real `.js` when there is no source sibling).

export const api = await import('../../src/api.ts')
export const contract = await import('../../src/api-contract.ts')
export const inboxContract = await import('../../src/inbox-contract.ts')
export const reviewRequest = await import('../../src/review-request.ts')
export const store = await import('../../src/store.ts')
export const panelProbe = await import('../../src/panel-probe.ts')
export const requestService = await import('../../src/request-service.ts')

export const CREATED_AT = '2026-01-01T00:00:00.000Z'
/** A clock ten minutes after the fixture's `lastActiveAt`, so nothing transitions. */
export const NOW = new Date('2026-01-02T00:10:00.000Z')
/** An activity timestamp old enough to be idle (2 h) but not resolvable (3 d). */
export const STALE = '2026-01-01T00:00:00.000Z'
export const HOST = '127.0.0.1:3080'
export const ORIGIN = `http://${HOST}`
export const MASTER = 'master-session'
export const OTHER_SESSION = 'other-session'

/** One v2 topic with every field the schema requires. */
export function makeTopic(overrides = {}) {
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
export function makeWorkItem(overrides = {}) {
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
export function makeDocument(overrides = {}) {
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
export function makeEvent(overrides = {}) {
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
export function makeInboxItem(overrides = {}) {
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
export function fakePorts(options = {}) {
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
    // The fake has no real file lock; the authorization transaction calls these
    // two, and a test that needs lock semantics uses a real ProjectStore.
    async withWriteLock(operation) {
      state.locks = (state.locks ?? 0) + 1
      return operation()
    },
    async mutateIndexDocumentUnlocked(mutator) {
      state.storeCalls.push('mutateIndexDocumentUnlocked')
      // Same concurrent-writer seam as the locked variant: it runs before the
      // mutator reads, which is what the lock re-read would have seen.
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
export function fakeHost(connection) {
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

export function fakeConnection() {
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

export async function registerRoutes(portBag) {
  const fake = fakeConnection()
  const { host, effects } = fakeHost(fake.connection)
  api.registerCoworkApi(host, portBag.ports)
  return { ...fake, effects, host }
}

/** A GET from the panel origin; `headers` overrides the defaults. */
export function getRequest(path, query = '', headers = {}) {
  return new Request(`http://${HOST}${path}${query}`, { headers: { host: HOST, ...headers } })
}

/** A POST from the panel origin; `contentType: null` omits the header. */
export function postRequest(path, body, options = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const headers = new Headers({ host: HOST, ...options.headers })
  if (options.contentType !== null) headers.set('content-type', options.contentType ?? 'application/json')
  return new Request(`http://${HOST}${path}`, { method: 'POST', headers, body: text })
}

/** Body of one served response, plus its status and headers. */
export async function readResponse(response) {
  return { status: response.status, headers: response.headers, body: await response.json() }
}

export const overviewQuery = (sessionId = MASTER) => `?sessionId=${encodeURIComponent(sessionId)}`

export const topicsById = (rows) => new Map(rows.map((row) => [row.topicId, row]))

/** One valid review-request record, pending unless overridden. */
export function makeReviewRequest(overrides = {}) {
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
export async function writeReviewFile(dir, record) {
  const fileName = reviewRequest.reviewRequestFileName(record.topicId, record.requestId)
  assert.ok(fileName !== null, `request id must be file-name safe: ${record.requestId}`)
  await writeFile(join(dir, fileName), `${JSON.stringify(record, null, 2)}\n`)
  return fileName
}

/** A supported notice port that records the card patches. */
export function fakeNoticePort() {
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
export function pendingAuthorizationFixture() {
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
