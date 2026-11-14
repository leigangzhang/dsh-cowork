import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod } from 'node:fs/promises'
import { join } from 'node:path'
import {
  makeSeedProject,
  makeSeedRequest,
  makeTopicFixture,
  withRepo,
} from './support/inbox-fixtures.mjs'

/**
 * The authorization decision is one cross-file transaction: the index unlock
 * and the request card's terminal state share one project-lock acquisition.
 *
 * Both routes that can decide an authorization are exercised against a real
 * `ProjectStore` on real files: the legacy `POST authorization.resolve` and the
 * inbox `POST inbox.resolve`. Each route is run against two failure orders
 * (index write refused, card write refused after the index write) plus the
 * idempotent replay. Failure injection stays at the store/directory boundary so
 * the production lock and write path are the ones under test.
 */
const api = await import('../src/api.ts')
const contract = await import('../src/api-contract.ts')
const inboxContract = await import('../src/inbox-contract.ts')

const { ProjectStore } = await import('../src/store.ts')
const { RequestStore } = await import('../src/request-store.ts')

const NOW = new Date('2026-11-13T10:00:00.000Z')
const MASTER = 'session-master'
const TOPIC = 'session-topic'
const REQUEST_ID = 'req-1'
const HOST = '127.0.0.1:3080'
/** The shipped lock wait; a reentrant acquisition would burn this and fail. */
const LOCK_WAIT_MS = 5000

const topic = makeTopicFixture({
  topicId: TOPIC,
  title: 'Authorization transaction',
  cwd: '/repo',
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  lastActiveAt: NOW.toISOString(),
})

/** A topic blocked on the suite's pending authorization. */
function pendingAuthorization() {
  return topic({
    status: 'idle',
    blocked: true,
    blockedReason: 'authorization',
    blockedFromStatus: 'idle',
    blockedAt: NOW.toISOString(),
    authorization: { requestId: REQUEST_ID, summary: 'may I push?', requestedAt: NOW.toISOString() },
  })
}

const seedProject = makeSeedProject({ clock: () => NOW, master: MASTER })
const seedRequest = makeSeedRequest({ now: NOW, topic: () => topic(), projectId: 'p' })

/** Register all panel routes over one store and record prompts and logs. */
function register(repoPath, store) {
  const routes = new Map()
  const prompts = []
  const logs = []
  const connection = {
    fetch: {
      register(route) {
        routes.set(route.path, route)
        return async () => {}
      },
    },
  }
  api.registerCoworkApi({
    get: (name) => (name === 'connection' ? connection : undefined),
    effect: (execute) => { execute() },
  }, {
    listSessions: async () => ({ items: [{ sessionId: MASTER, cwd: repoPath }] }),
    findProjectRoot: async (startPath) => (startPath === repoPath ? repoPath : null),
    createStore: () => store,
    now: () => NOW,
    promptSession: async (sessionId, text) => {
      prompts.push({ sessionId, text })
      return { accepted: true }
    },
    log: (message) => logs.push(message),
  })
  return { routes, prompts, logs }
}

/** One same-origin POST from the panel */
function postRequest(path, body) {
  return new Request(`http://${HOST}${path}`, {
    method: 'POST',
    headers: { host: HOST, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function decideLegacy(routes, body = {}) {
  const response = await routes.get(contract.AUTHORIZATION_RESOLVE_PATH).fetch(postRequest(
    contract.AUTHORIZATION_RESOLVE_PATH,
    { sessionId: MASTER, topicId: TOPIC, requestId: REQUEST_ID, decision: 'allow', ...body },
  ))
  return { status: response.status, body: await response.json() }
}

async function decideInbox(routes, body = {}) {
  const response = await routes.get(inboxContract.INBOX_RESOLVE_PATH).fetch(postRequest(
    inboxContract.INBOX_RESOLVE_PATH,
    { sessionId: MASTER, requestId: REQUEST_ID, action: 'allow', ...body },
  ))
  return { status: response.status, body: await response.json() }
}

/** Everything a failure assertion needs, read back from disk. */
async function persisted(repoPath) {
  const store = new ProjectStore({ repoPath, clock: () => NOW })
  const document = await store.readIndexDocument()
  const card = await new RequestStore({ repoPath }).read(REQUEST_ID)
  const { events } = await store.readActivity(500)
  return {
    document,
    topic: document.topics.find((entry) => entry.topicId === TOPIC),
    card,
    events,
  }
}

/** A real store plus a mutable seed for one blocking authorization. */
async function seed(repoPath) {
  const store = await seedProject(repoPath, [pendingAuthorization()])
  await seedRequest(repoPath, store, {
    kind: 'authorization',
    payload: { summary: 'may I push?' },
  })
  return { store, repoPath }
}

/** A view over the real store that counts lock acquisitions. */
function countingLock(store) {
  const wrapped = Object.create(store)
  const state = { locks: 0, elapsedMs: 0 }
  wrapped.withWriteLock = async (operation) => {
    state.locks += 1
    const started = Date.now()
    try {
      return await store.withWriteLock(operation)
    } finally {
      state.elapsedMs = Date.now() - started
    }
  }
  return { wrapped, state }
}

/** A view whose unlocked index write can refuse the first or every call. */
function refusingIndexWrite(store, { after = 0 } = {}) {
  const wrapped = Object.create(store)
  const state = { calls: 0 }
  wrapped.mutateIndexDocumentUnlocked = async (mutator) => {
    state.calls += 1
    if (state.calls > after) throw new Error('index write refused by the fault injector')
    return store.mutateIndexDocumentUnlocked(mutator)
  }
  return { wrapped, state }
}

/** Make the request directory read-only so the card write fails. */
async function refuseCardWrites(repoPath) {
  const dir = join(repoPath, '.dsh-cowork', 'requests')
  await chmod(dir, 0o555)
  return async () => {
    try {
      await chmod(dir, 0o755)
    } catch (error) {
      // The throwaway repository may already be gone when the hook runs.
      if (error.code !== 'ENOENT') throw error
    }
  }
}

test('the legacy route commits the index and the card under one lock acquisition', async (t) => {
  await withRepo(async (repoPath) => {
    const { store } = await seed(repoPath)
    const { wrapped, state } = countingLock(store)
    const { routes, prompts } = register(repoPath, wrapped)

    const decided = await decideLegacy(routes)
    assert.equal(decided.status, 200, JSON.stringify(decided.body))
    assert.equal(decided.body.changed, true)
    assert.equal(decided.body.prompted, true)
    assert.equal(state.locks, 1, 'one project-lock acquisition covers index and card')
    assert.ok(state.elapsedMs < LOCK_WAIT_MS / 2, `the transaction did not re-enter the lock (${state.elapsedMs} ms)`)
    assert.equal(prompts.length, 1, 'the prompt follows the committed transaction')

    const after = await persisted(repoPath)
    assert.equal(after.topic.authorization, null)
    assert.equal(after.topic.blocked, false)
    assert.equal(after.card.status, 'allowed')
    assert.equal(after.card.delivery.promptedAt, NOW.toISOString())
    const resolvedRows = after.events.filter((event) => event.type === 'request-resolved')
    assert.equal(resolvedRows.length, 1)
    assert.equal(resolvedRows[0].details.requestId, REQUEST_ID)

    const replay = await decideLegacy(routes)
    assert.equal(replay.status, 200)
    assert.equal(replay.body.changed, false)
    assert.equal(replay.body.prompted, false)
    assert.equal(prompts.length, 1, 'the replay never prompts again')
    assert.equal(
      (await persisted(repoPath)).events.filter((event) => event.type === 'request-resolved').length,
      1,
      'the replay never writes a second request-resolved row',
    )
  })
})

test('the inbox route commits the index and the card under one lock acquisition', async (t) => {
  await withRepo(async (repoPath) => {
    const { store } = await seed(repoPath)
    const { wrapped, state } = countingLock(store)
    const { routes, prompts } = register(repoPath, wrapped)

    const decided = await decideInbox(routes)
    assert.equal(decided.status, 200, JSON.stringify(decided.body))
    assert.equal(decided.body.changed, true)
    assert.equal(decided.body.prompted, true)
    assert.equal(state.locks, 1, 'one project-lock acquisition covers index and card')
    assert.ok(state.elapsedMs < LOCK_WAIT_MS / 2, `the transaction did not re-enter the lock (${state.elapsedMs} ms)`)

    const after = await persisted(repoPath)
    assert.equal(after.topic.authorization, null)
    assert.equal(after.card.status, 'allowed')
    assert.equal(after.card.delivery.promptedAt, NOW.toISOString())
    assert.equal(after.events.filter((event) => event.type === 'request-resolved').length, 1)

    const replay = await decideInbox(routes)
    assert.equal(replay.status, 200)
    assert.equal(replay.body.changed, false)
    assert.equal(prompts.length, 1)
  })
})

test('a refused index write leaves both files untouched on the legacy route', async (t) => {
  await withRepo(async (repoPath) => {
    const { store } = await seed(repoPath)
    const { wrapped } = refusingIndexWrite(store)
    const { routes, prompts } = register(repoPath, wrapped)

    const failed = await decideLegacy(routes)
    assert.equal(failed.status >= 400, true, JSON.stringify(failed.body))
    assert.equal(prompts.length, 0)
    const after = await persisted(repoPath)
    assert.equal(after.topic.authorization.requestId, REQUEST_ID, 'the index still blocks')
    assert.equal(after.topic.blocked, true)
    assert.equal(after.card.status, 'pending', 'the card is still pending')
    assert.deepEqual(after.card.delivery, { promptedAt: null, lastError: null })
  })
})

test('a refused index write leaves both files untouched on the inbox route', async (t) => {
  await withRepo(async (repoPath) => {
    const { store } = await seed(repoPath)
    const { wrapped } = refusingIndexWrite(store)
    const { routes, prompts } = register(repoPath, wrapped)

    const failed = await decideInbox(routes)
    assert.equal(failed.status >= 400, true, JSON.stringify(failed.body))
    assert.equal(prompts.length, 0)
    const after = await persisted(repoPath)
    assert.equal(after.topic.authorization.requestId, REQUEST_ID)
    assert.equal(after.card.status, 'pending')
  })
})

test('a refused card write restores the index on the legacy route', async (t) => {
  await withRepo(async (repoPath) => {
    const { store } = await seed(repoPath)
    const restoreDir = await refuseCardWrites(repoPath)
    t.after(restoreDir)
    const { routes, prompts, logs } = register(repoPath, store)

    const failed = await decideLegacy(routes)
    await restoreDir()
    assert.equal(failed.status >= 400, true, JSON.stringify(failed.body))
    assert.equal(prompts.length, 0, 'a failed transaction never prompts')
    const after = await persisted(repoPath)
    assert.equal(after.topic.authorization.requestId, REQUEST_ID, 'the index write was compensated')
    assert.equal(after.topic.blocked, true)
    assert.equal(after.card.status, 'pending')
    assert.equal(after.events.some((event) => event.type === 'request-resolved'), false)
    assert.equal(logs.some((message) => /residual state/.test(message)), false)
  })
})

test('a refused card write restores the index on the inbox route', async (t) => {
  await withRepo(async (repoPath) => {
    const { store } = await seed(repoPath)
    const restoreDir = await refuseCardWrites(repoPath)
    t.after(restoreDir)
    const { routes, prompts, logs } = register(repoPath, store)

    const failed = await decideInbox(routes)
    await restoreDir()
    assert.equal(failed.status >= 400, true, JSON.stringify(failed.body))
    assert.equal(prompts.length, 0)
    const after = await persisted(repoPath)
    assert.equal(after.topic.authorization.requestId, REQUEST_ID)
    assert.equal(after.card.status, 'pending')
    assert.equal(after.events.filter((event) => event.type === 'request-resolved').length, 0)
    assert.equal(logs.some((message) => /residual state/.test(message)), false)
  })
})

test('a failed restore is logged as the documented residual window', async (t) => {
  await withRepo(async (repoPath) => {
    const { store } = await seed(repoPath)
    // The first unlocked write (the index) lands; the second (the compensation)
    // is refused, so the index stays decided while the card stays pending.
    const { wrapped } = refusingIndexWrite(store, { after: 1 })
    const restoreDir = await refuseCardWrites(repoPath)
    t.after(restoreDir)
    const { routes, logs } = register(repoPath, wrapped)

    const failed = await decideLegacy(routes)
    await restoreDir()
    assert.equal(failed.status >= 400, true)
    assert.equal(logs.some((message) => /residual state is "topic unlocked, card pending"/.test(message)), true)
    const after = await persisted(repoPath)
    assert.equal(after.topic.authorization, null, 'the documented residual window is exactly this state')
    assert.equal(after.card.status, 'pending')
  })
})
