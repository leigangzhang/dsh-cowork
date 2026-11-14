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
 * `authorization.resolve` and its convergence with the request inbox, over both
 * the fake store and a real `ProjectStore`.
 *
 * Split out of the former `tests/api.test.mjs`; setup lives in
 * `tests/support/api-fixtures.mjs`.
 */

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
