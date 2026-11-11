import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  makeSeedProject,
  makeSeedRequest,
  makeTopicFixture,
  withRepo,
} from './support/inbox-fixtures.mjs'

const api = await import('../src/api.ts')
const inbox = await import('../src/inbox-api.ts')
const inboxContract = await import('../src/inbox-contract.ts')
const activity = await import('../src/activity.ts')
const { recordNoticesForEvent } = await import('../src/notices.ts')
const { ProjectStore } = await import('../src/store.ts')
const service = await import('../src/request-service.ts')
const { RequestStore } = await import('../src/request-store.ts')

const NOW = new Date('2026-11-10T09:00:00.000Z')
const NOW_ISO = NOW.toISOString()
const HOST = '127.0.0.1:3080'
const MASTER = 'session-master'
const TOPIC = 'session-topic'
const OTHER_TOPIC = 'session-other-topic'
const STRANGER = 'session-stranger'

/** The suite's v2 topic fixture, bound to one record template. */
const topicRecord = makeTopicFixture({ scope: 'scope' })
const topic = (topicId, title, overrides = {}) => topicRecord({ topicId, title, ...overrides })

const seedProject = makeSeedProject({ clock: () => NOW })

/** A supported host notice port that records every patch. */
function fakeNoticePort(state) {
  return {
    capabilities: () => ({ supported: true, actions: true, updates: true }),
    append: async (sessionId, notice) => {
      state.noticeAppends.push({ sessionId, notice })
      return 'delivered'
    },
    update: async (sessionId, noticeId, patch) => {
      state.noticeUpdates.push({ sessionId, noticeId, patch })
      return 'delivered'
    },
  }
}

/** Route-facing ports backed by the real store of `repoPath`. */
function fakePorts(repoPath, options = {}) {
  const state = {
    prompts: [],
    opened: [],
    noticeUpdates: [],
    noticeAppends: [],
    logs: [],
    kicked: [],
  }
  const sessions = [
    { sessionId: MASTER, cwd: repoPath },
    { sessionId: TOPIC, cwd: repoPath },
    { sessionId: STRANGER, cwd: repoPath },
  ]
  const ports = {
    listSessions: async () => ({ items: sessions }),
    findProjectRoot: async () => repoPath,
    createStore: (path) => new ProjectStore({ repoPath: path, clock: () => NOW }),
    now: () => NOW,
    log: (message) => state.logs.push(message),
    promptSession: options.noPrompt === true ? undefined : async (sessionId, text) => {
      state.prompts.push({ sessionId, text })
      if (options.promptError !== undefined) throw new Error(options.promptError)
      return { accepted: options.accepted ?? true }
    },
    noticePort: fakeNoticePort(state),
    kickNotices: (repoPath) => state.kicked.push(repoPath),
    ...(options.noOpener === true
      ? {}
      : {
        openWorkspacePath: async (path) => {
          state.opened.push(path)
          if (options.openError !== undefined) throw new Error(options.openError)
        },
      }),
  }
  return { ports, state }
}

/** A Cordis-like host that records the registered routes. */
function fakeHost() {
  const routes = new Map()
  const effects = []
  const connection = {
    fetch: {
      register(route) {
        routes.set(route.path, route)
        return async () => routes.delete(route.path)
      },
    },
  }
  return {
    routes,
    effects,
    host: {
      get: (name) => (name === 'connection' ? connection : undefined),
      effect(execute, label) {
        effects.push({ label, disposer: execute() })
      },
    },
  }
}

/** Register the shipped panel routes and return the route map. */
function registerRoutes(ports) {
  const fake = fakeHost()
  api.registerCoworkApi(fake.host, ports)
  return fake.routes
}

/** A GET from the panel origin. */
function getRequest(path, query = '') {
  return new Request(`http://${HOST}${path}${query}`, { headers: { host: HOST } })
}

/** A POST from the panel origin. */
function postRequest(path, body) {
  return new Request(`http://${HOST}${path}`, {
    method: 'POST',
    headers: { host: HOST, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function readResponse(response) {
  return { status: response.status, body: await response.json() }
}

/** Create one request through the service of the seeded store. */
const seedRequest = makeSeedRequest({
  now: NOW,
  topic: (input) => topic(input.topicId ?? TOPIC, 'Inbox backend'),
})

/** Seed the four request kinds plus the notification tail the read merges. */
async function seedInbox(repoPath, store) {
  await seedRequest(repoPath, store, {
    requestId: 'req-review',
    kind: 'user-review',
    payload: { purpose: 'review the inbox backend' },
  })
  await seedRequest(repoPath, store, {
    requestId: 'req-question',
    topicId: TOPIC,
    kind: 'question',
    payload: {
      questions: [{ id: 'q1', prompt: 'ship it?', mode: 'single', options: [{ id: 'o1', label: 'yes' }], allowText: true }],
    },
  })
  await seedRequest(repoPath, store, {
    requestId: 'req-plan',
    topicId: OTHER_TOPIC,
    kind: 'plan',
    payload: { planPath: 'docs/plan.md', planTitle: 'PLAN' },
  })
  await service.resolveRequest({
    store,
    repoPath,
    document: { masterSessionId: MASTER, topics: [] },
    sessionId: MASTER,
    requestId: 'req-plan',
    action: 'approve',
    now: NOW,
    log: () => {},
  })
  await seedRequest(repoPath, store, {
    requestId: 'req-gone',
    topicId: 'session-gone',
    kind: 'authorization',
    payload: { summary: 'may I push?' },
  })

  const report = activity.topicReportedActivity(
    topic(OTHER_TOPIC, 'Second topic'),
    { summary: 'made progress', kind: 'progress' },
    NOW,
  )
  const proposal = activity.decisionProposedActivity(
    topic(TOPIC, 'Inbox backend'),
    { proposalId: 'prop-1', proposalPath: '.dsh-cowork/proposals/prop-1.json', title: 'Proposal', summary: 'what to decide' },
    NOW,
  )
  const authorization = activity.authorizationRequestedActivity(
    topic(TOPIC, 'Inbox backend'),
    { requestId: 'req-auth', summary: 'may I push?' },
    NOW,
  )
  const verdict = activity.buildActivityEvent({
    type: 'review-verdict',
    topicId: OTHER_TOPIC,
    summary: 'review req-auto returned pass',
    details: { requestId: 'req-auto', verdict: 'pass' },
  }, NOW)
  for (const event of [report, proposal, authorization, verdict]) {
    await store.appendActivity(event)
    await recordNoticesForEvent(store, event, NOW)
  }
}

const inboxQuery = (sessionId = MASTER) => `?sessionId=${encodeURIComponent(sessionId)}`

test('the inbox read merges requests and notes with pending-only counts', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [
      topic(TOPIC, 'Inbox backend'),
      topic(OTHER_TOPIC, 'Second topic'),
    ])
    await seedInbox(repoPath, store)
    const { ports } = fakePorts(repoPath)
    const routes = registerRoutes(ports)
    const { status, body } = await readResponse(
      await routes.get(inboxContract.INBOX_PATH).fetch(getRequest(inboxContract.INBOX_PATH, inboxQuery())),
    )
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.deepEqual(body.counts, { pending: 3, review: 1, authorization: 1, question: 1, plan: 0 })
    assert.equal(body.truncated, false)

    const requests = body.items.filter((item) => item.kind === 'request')
    assert.deepEqual(requests.map((item) => item.requestId).sort(), [
      'req-gone', 'req-plan', 'req-question', 'req-review',
    ])
    const review = requests.find((item) => item.requestId === 'req-review')
    assert.equal(review.requestKind, 'user-review')
    assert.equal(review.status, 'pending')
    assert.equal(review.topicTitle, 'Inbox backend')
    assert.deepEqual(review.actions, ['return', 'pass'])
    assert.equal(review.resolutionMessage, null)
    assert.match(review.requestMessage, /^主题「Inbox backend」/)
    const plan = requests.find((item) => item.requestId === 'req-plan')
    assert.equal(plan.status, 'approved')
    assert.deepEqual(plan.actions, [])
    assert.match(plan.resolutionMessage, /已同意该计划/)
    const gone = requests.find((item) => item.requestId === 'req-gone')
    assert.equal(gone.topicTitle, inbox.INBOX_ARCHIVED_TOPIC_TITLE, 'a topic the index lost shows the placeholder')

    const notes = body.items.filter((item) => item.kind === 'notification')
    assert.equal(notes.some((item) => item.noticeKind === 'report'), true)
    const proposal = notes.find((item) => item.noticeKind === 'proposal')
    assert.equal(proposal.canOpen, true)
    assert.equal(proposal.proposalPath, '.dsh-cowork/proposals/prop-1.json')
    const verdictNote = notes.find((item) => item.noticeKind === 'review-verdict')
    assert.equal(verdictNote.canOpen, false, 'the automatic verdict is read-only')
    assert.equal('actions' in verdictNote, false, 'a note carries no action')
    assert.match(verdictNote.summary, /自动评审结果：通过/)
    assert.equal(
      body.items.some((item) => item.kind === 'notification' && item.noticeKind === 'authorization'),
      false,
      'the old authorization notice is suppressed: the request card is the one card',
    )
  })
})

test('the topic filter narrows the items but never the counts', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [
      topic(TOPIC, 'Inbox backend'),
      topic(OTHER_TOPIC, 'Second topic'),
    ])
    await seedInbox(repoPath, store)
    const { ports } = fakePorts(repoPath)
    const routes = registerRoutes(ports)
    const { body } = await readResponse(
      await routes.get(inboxContract.INBOX_PATH)
        .fetch(getRequest(inboxContract.INBOX_PATH, `${inboxQuery()}&topicId=${OTHER_TOPIC}`)),
    )
    assert.equal(body.items.every((item) => item.topicId === OTHER_TOPIC), true)
    assert.equal(body.items.length > 0, true)
    assert.deepEqual(body.counts, { pending: 3, review: 1, authorization: 1, question: 1, plan: 0 })
  })
})

test('the inbox read writes nothing and wakes nobody', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic(TOPIC, 'Inbox backend')])
    await seedInbox(repoPath, store)
    const { ports, state } = fakePorts(repoPath)
    const routes = registerRoutes(ports)
    const beforeActivity = (await store.readActivity()).events.length
    const noticesFile = join(repoPath, '.dsh-cowork', 'notices.json')
    const beforeNotices = await readFile(noticesFile, 'utf8')
    await readResponse(
      await routes.get(inboxContract.INBOX_PATH).fetch(getRequest(inboxContract.INBOX_PATH, inboxQuery())),
    )
    assert.equal((await store.readActivity()).events.length, beforeActivity)
    assert.equal(await readFile(noticesFile, 'utf8'), beforeNotices)
    assert.deepEqual(state.prompts, [])
  })
})

test('the inbox read requires a session and bounds a large merge', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic(TOPIC, 'Inbox backend')])
    const { ports } = fakePorts(repoPath)
    const routes = registerRoutes(ports)
    const missing = await readResponse(
      await routes.get(inboxContract.INBOX_PATH).fetch(getRequest(inboxContract.INBOX_PATH)),
    )
    assert.equal(missing.status, 400)
    assert.equal(missing.body.error.code, 'request/session-required')

    for (let index = 0; index < inboxContract.INBOX_MAX_ITEMS + 1; index += 1) {
      await seedRequest(repoPath, store, {
        requestId: `req-${String(index).padStart(3, '0')}`,
        kind: 'user-review',
        payload: { purpose: `review ${index}` },
      })
    }
    const { body } = await readResponse(
      await routes.get(inboxContract.INBOX_PATH).fetch(getRequest(inboxContract.INBOX_PATH, inboxQuery())),
    )
    assert.equal(body.items.length, inboxContract.INBOX_MAX_ITEMS)
    assert.equal(body.truncated, true)
    assert.equal(body.counts.pending, inboxContract.INBOX_MAX_ITEMS + 1)
  })
})

test('resolve answers with the resolved row and wakes the topic', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic(TOPIC, 'Inbox backend')])
    await seedRequest(repoPath, store, {
      requestId: 'req-review',
      kind: 'user-review',
      payload: { purpose: 'review the inbox backend' },
    })
    const { ports, state } = fakePorts(repoPath)
    const routes = registerRoutes(ports)
    const { status, body } = await readResponse(
      await routes.get(inboxContract.INBOX_RESOLVE_PATH).fetch(postRequest(inboxContract.INBOX_RESOLVE_PATH, {
        sessionId: MASTER,
        requestId: 'req-review',
        action: 'pass',
        comment: 'looks right',
      })),
    )
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.changed, true)
    assert.equal(body.prompted, true)
    assert.equal(body.promptError, null)
    assert.equal(body.item.kind, 'request')
    assert.equal(body.item.requestId, 'req-review')
    assert.equal(body.item.status, 'passed')
    assert.equal(body.item.topicTitle, 'Inbox backend')
    assert.deepEqual(body.item.actions, [])
    assert.match(body.item.resolutionMessage, /已通过评审/)
    assert.equal(state.prompts.length, 1)
    assert.equal(state.prompts[0].sessionId, TOPIC)
  })
})

test('resolve replays the same action and conflicts on a different one', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic(TOPIC, 'Inbox backend')])
    await seedRequest(repoPath, store, { requestId: 'req-1', kind: 'user-review', payload: { purpose: 'review' } })
    const { ports, state } = fakePorts(repoPath)
    const routes = registerRoutes(ports)
    const resolve = async (action) => readResponse(
      await routes.get(inboxContract.INBOX_RESOLVE_PATH).fetch(postRequest(inboxContract.INBOX_RESOLVE_PATH, {
        sessionId: MASTER, requestId: 'req-1', action,
      })),
    )
    const first = await resolve('pass')
    assert.equal(first.body.changed, true)
    const replay = await resolve('pass')
    assert.equal(replay.status, 200)
    assert.equal(replay.body.changed, false)
    assert.equal(replay.body.prompted, false)
    assert.match(replay.body.item.resolutionMessage, /已通过评审/)
    const conflict = await resolve('return')
    assert.equal(conflict.status, 409)
    assert.equal(conflict.body.error.code, 'inbox/request-resolved')
    assert.equal(state.prompts.length, 1)
  })
})

test('resolve refuses a foreign session, an unknown request and a wrong action', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic(TOPIC, 'Inbox backend')])
    await seedRequest(repoPath, store, { requestId: 'req-1', kind: 'user-review', payload: { purpose: 'review' } })
    const { ports } = fakePorts(repoPath)
    const routes = registerRoutes(ports)
    const resolve = async (body) => readResponse(
      await routes.get(inboxContract.INBOX_RESOLVE_PATH).fetch(postRequest(inboxContract.INBOX_RESOLVE_PATH, body)),
    )
    const foreign = await resolve({ sessionId: STRANGER, requestId: 'req-1', action: 'pass' })
    assert.equal(foreign.status, 403)
    assert.equal(foreign.body.error.code, 'inbox/not-member')
    const unknown = await resolve({ sessionId: MASTER, requestId: 'req-missing', action: 'pass' })
    assert.equal(unknown.status, 404)
    assert.equal(unknown.body.error.code, 'inbox/request-not-found')
    const wrongAction = await resolve({ sessionId: MASTER, requestId: 'req-1', action: 'allow' })
    assert.equal(wrongAction.status, 400)
    assert.equal(wrongAction.body.error.code, 'inbox/action-not-allowed')
    const invented = await resolve({ sessionId: MASTER, requestId: 'req-1', action: 'destroy' })
    assert.equal(invented.status, 400)
    assert.equal(invented.body.error.code, 'inbox/action-not-allowed')
    const noRequestId = await resolve({ sessionId: MASTER, action: 'pass' })
    assert.equal(noRequestId.status, 400)
    assert.equal(noRequestId.body.error.code, 'request/invalid-body')
  })
})

test('resolve validates question answers and the comment', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic(TOPIC, 'Inbox backend')])
    await seedRequest(repoPath, store, {
      requestId: 'req-q',
      kind: 'question',
      payload: {
        questions: [{ id: 'q1', prompt: 'ship it?', mode: 'single', options: [{ id: 'o1', label: 'yes' }, { id: 'o2', label: 'no' }] }],
      },
    })
    const { ports } = fakePorts(repoPath)
    const routes = registerRoutes(ports)
    const resolve = async (body) => readResponse(
      await routes.get(inboxContract.INBOX_RESOLVE_PATH).fetch(postRequest(inboxContract.INBOX_RESOLVE_PATH, body)),
    )
    const invalid = await resolve({ sessionId: MASTER, requestId: 'req-q', action: 'submit', answers: [{ questionId: 'q1', selected: ['o9'] }] })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.body.error.code, 'inbox/invalid-answer')
    const tooLong = await resolve({ sessionId: MASTER, requestId: 'req-q', action: 'submit', comment: 'c'.repeat(2001) })
    assert.equal(tooLong.status, 400)
    assert.equal(tooLong.body.error.code, 'inbox/invalid-comment')
    const answered = await resolve({
      sessionId: MASTER,
      requestId: 'req-q',
      action: 'submit',
      answers: [{ questionId: 'q1', selected: ['o1'] }],
    })
    assert.equal(answered.status, 200)
    assert.equal(answered.body.item.status, 'answered')
    const skip = await resolve({ sessionId: MASTER, requestId: 'req-plan-missing', action: 'skip' })
    assert.equal(skip.status, 404)
  })
})

test('a question submit lands every answer on the card before the topic prompt', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic(TOPIC, 'Inbox backend')])
    await seedRequest(repoPath, store, {
      requestId: 'req-q',
      kind: 'question',
      payload: {
        questions: [
          {
            id: 'q1',
            prompt: 'ship it?',
            mode: 'single',
            options: [{ id: 'o1', label: '现在发布' }, { id: 'o2', label: '再等等' }],
          },
          { id: 'q2', prompt: '补充说明？', mode: 'single', allowText: true },
        ],
      },
    })
    const { ports } = fakePorts(repoPath)
    const observed = []
    // The prompt port reads the card the way the topic session will.
    ports.promptSession = async (sessionId, text) => {
      observed.push({
        sessionId,
        text,
        record: await new RequestStore({ repoPath }).read('req-q'),
      })
      return { accepted: true }
    }
    const routes = registerRoutes(ports)
    const { status, body } = await readResponse(
      await routes.get(inboxContract.INBOX_RESOLVE_PATH).fetch(postRequest(inboxContract.INBOX_RESOLVE_PATH, {
        sessionId: MASTER,
        requestId: 'req-q',
        action: 'submit',
        answers: [
          { questionId: 'q1', selected: ['o1'] },
          { questionId: 'q2', text: '把文档补上' },
        ],
        comment: '先处理文档，再发布',
      })),
    )
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.item.status, 'answered')
    assert.equal(observed.length, 1)
    assert.equal(observed[0].sessionId, TOPIC)
    assert.equal(observed[0].record.status, 'answered', 'the card is terminal before the prompt')
    assert.deepEqual(observed[0].record.resolution, {
      comment: '先处理文档，再发布',
      answers: [
        { questionId: 'q1', selected: ['o1'] },
        { questionId: 'q2', text: '把文档补上' },
      ],
    })
    assert.match(observed[0].text, /ship it\?/)
    assert.match(observed[0].text, /现在发布/)
    assert.match(observed[0].text, /把文档补上/)
    assert.match(observed[0].text, /先处理文档，再发布/)
    assert.match(body.item.resolutionMessage, /已回答全部问题/)
    assert.match(body.item.resolutionMessage, /现在发布/)
    const persisted = await new RequestStore({ repoPath }).read('req-q')
    assert.equal(persisted.delivery.promptedAt, NOW_ISO)
    assert.equal(persisted.delivery.lastError, null)
  })
})

test('a refused queue prompt reports promptError without faking a reply', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic(TOPIC, 'Inbox backend')])
    await seedRequest(repoPath, store, { requestId: 'req-1', kind: 'user-review', payload: { purpose: 'review' } })
    const { ports } = fakePorts(repoPath, { promptError: 'host is busy' })
    const routes = registerRoutes(ports)
    const { status, body } = await readResponse(
      await routes.get(inboxContract.INBOX_RESOLVE_PATH).fetch(postRequest(inboxContract.INBOX_RESOLVE_PATH, {
        sessionId: MASTER, requestId: 'req-1', action: 'pass',
      })),
    )
    assert.equal(status, 200)
    assert.equal(body.changed, true)
    assert.equal(body.prompted, false)
    assert.match(body.promptError, /host is busy/)
    assert.equal(body.item.status, 'passed')
    assert.match(body.item.resolutionMessage, /已通过评审/)
  })
})

test('the inbox resolve route shares the one authorization decision core', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic(TOPIC, 'Inbox backend', {
      status: 'idle',
      blocked: true,
      blockedReason: 'authorization',
      blockedFromStatus: 'idle',
      blockedAt: NOW_ISO,
      authorization: { requestId: 'req-auth', summary: 'may I push?', requestedAt: NOW_ISO },
    })])
    await seedRequest(repoPath, store, {
      requestId: 'req-auth',
      kind: 'authorization',
      payload: { summary: 'may I push?', command: 'git push' },
    })
    await store.appendActivity(activity.authorizationRequestedActivity(
      topic(TOPIC, 'Inbox backend'),
      { requestId: 'req-auth', summary: 'may I push?' },
      NOW,
    ))
    const { ports, state } = fakePorts(repoPath)
    const routes = registerRoutes(ports)
    const { status, body } = await readResponse(
      await routes.get(inboxContract.INBOX_RESOLVE_PATH).fetch(postRequest(inboxContract.INBOX_RESOLVE_PATH, {
        sessionId: MASTER, requestId: 'req-auth', action: 'allow',
      })),
    )
    assert.equal(status, 200)
    assert.equal(body.item.status, 'allowed')
    assert.equal(body.prompted, true)
    const document = await store.readIndexDocument()
    assert.equal(document.topics[0].authorization, null)
    assert.equal(document.topics[0].blocked, false)
    assert.equal(state.noticeUpdates.length, 2, 'the original notice is patched on both targets')
    assert.equal(state.noticeUpdates[0].patch.status, 'allowed')
  })
})

test('open reveals the stored plan file and rejects a path-shaped body', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic(TOPIC, 'Inbox backend')])
    await mkdir(join(repoPath, 'docs'), { recursive: true })
    await writeFile(join(repoPath, 'docs', 'plan.md'), '# plan\n')
    await seedRequest(repoPath, store, { requestId: 'req-plan', kind: 'plan', payload: { planPath: 'docs/plan.md' } })
    const { ports, state } = fakePorts(repoPath)
    const routes = registerRoutes(ports)
    const open = async (body) => readResponse(
      await routes.get(inboxContract.INBOX_OPEN_PATH).fetch(postRequest(inboxContract.INBOX_OPEN_PATH, body)),
    )
    const ok = await open({ sessionId: MASTER, requestId: 'req-plan' })
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body, { ok: true, opened: true })
    assert.deepEqual(state.opened, [await realpath(join(repoPath, 'docs', 'plan.md'))])

    const both = await open({ sessionId: MASTER, requestId: 'req-plan', noticeId: 'event-1' })
    assert.equal(both.status, 400)
    assert.equal(both.body.error.code, 'request/invalid-body')
    const neither = await open({ sessionId: MASTER })
    assert.equal(neither.status, 400)
    assert.equal(neither.body.error.code, 'request/invalid-body')
    // A browser-named path is not a request id and resolves to nothing.
    const pathOnly = await open({ sessionId: MASTER, path: join(repoPath, 'docs', 'plan.md') })
    assert.equal(pathOnly.status, 400)
    assert.equal(pathOnly.body.error.code, 'request/invalid-body')
    const missingSession = await open({ requestId: 'req-plan' })
    assert.equal(missingSession.status, 400)
    assert.equal(missingSession.body.error.code, 'request/session-required')
    const unknown = await open({ sessionId: MASTER, requestId: 'req-nope' })
    assert.equal(unknown.status, 404)
    assert.equal(unknown.body.error.code, 'inbox/request-not-found')
  })
})

test('open admits only the master or the owning topic', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic(TOPIC, 'Inbox backend'), topic(OTHER_TOPIC, 'Second topic')])
    await mkdir(join(repoPath, 'docs'), { recursive: true })
    await writeFile(join(repoPath, 'docs', 'plan.md'), '# plan\n')
    await seedRequest(repoPath, store, {
      requestId: 'req-plan',
      topicId: TOPIC,
      kind: 'plan',
      payload: { planPath: 'docs/plan.md' },
    })
    const { ports, state } = fakePorts(repoPath)
    const routes = registerRoutes(ports)
    const open = async (body) => readResponse(
      await routes.get(inboxContract.INBOX_OPEN_PATH).fetch(postRequest(inboxContract.INBOX_OPEN_PATH, body)),
    )

    // A topic session may reveal its own request's file.
    const own = await open({ sessionId: TOPIC, requestId: 'req-plan' })
    assert.equal(own.status, 200)
    assert.equal(state.opened.length, 1)

    // A repository session that owns neither the project nor the topic is
    // refused, and its call never reaches the host opener.
    const foreign = await open({ sessionId: STRANGER, requestId: 'req-plan' })
    assert.equal(foreign.status, 403)
    assert.equal(foreign.body.error.code, 'inbox/not-member')
    assert.equal(state.opened.length, 1, 'the host opener is not called for a stranger')

    // The same rule applies to a proposal notice, whose topic comes from its event.
    await mkdir(join(repoPath, '.dsh-cowork', 'proposals'), { recursive: true })
    await writeFile(join(repoPath, '.dsh-cowork', 'proposals', 'prop-1.json'), '{}\n')
    await store.appendActivity(activity.decisionProposedActivity(
      topic(OTHER_TOPIC, 'Second topic'),
      { proposalId: 'prop-1', proposalPath: '.dsh-cowork/proposals/prop-1.json', title: 'Proposal', summary: 'decide' },
      NOW,
    ))
    const proposalId = (await store.readActivity()).events
      .find((event) => event.type === 'decision-proposed').eventId
    const foreignNotice = await open({ sessionId: TOPIC, noticeId: proposalId })
    assert.equal(foreignNotice.status, 403)
    assert.equal(foreignNotice.body.error.code, 'inbox/not-member')
    assert.equal(state.opened.length, 1)
    const masterNotice = await open({ sessionId: MASTER, noticeId: proposalId })
    assert.equal(masterNotice.status, 200)
    assert.deepEqual(masterNotice.body, { ok: true, opened: true })
  })
})

test('open reports an unsupported host and a refused open', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic(TOPIC, 'Inbox backend')])
    await mkdir(join(repoPath, 'docs'), { recursive: true })
    await writeFile(join(repoPath, 'docs', 'plan.md'), '# plan\n')
    await seedRequest(repoPath, store, { requestId: 'req-plan', kind: 'plan', payload: { planPath: 'docs/plan.md' } })

    const noOpener = fakePorts(repoPath, { noOpener: true })
    const noOpenerRoutes = registerRoutes(noOpener.ports)
    const unsupported = await readResponse(
      await noOpenerRoutes.get(inboxContract.INBOX_OPEN_PATH).fetch(postRequest(inboxContract.INBOX_OPEN_PATH, {
        sessionId: MASTER, requestId: 'req-plan',
      })),
    )
    assert.equal(unsupported.status, 501)
    assert.equal(unsupported.body.error.code, 'inbox/open-unsupported')

    const refused = fakePorts(repoPath, { openError: 'no desktop' })
    const refusedRoutes = registerRoutes(refused.ports)
    const refusedResponse = await readResponse(
      await refusedRoutes.get(inboxContract.INBOX_OPEN_PATH).fetch(postRequest(inboxContract.INBOX_OPEN_PATH, {
        sessionId: MASTER, requestId: 'req-plan',
      })),
    )
    assert.equal(refusedResponse.status, 501)
    assert.equal(refusedResponse.body.error.code, 'inbox/open-unsupported')
  })
})

test('the inbox routes share the same-origin fence and error envelope', async () => {
  await withRepo(async (repoPath) => {
    const { ports } = fakePorts(repoPath)
    const routes = registerRoutes(ports)
    const crossOrigin = await readResponse(
      await routes.get(inboxContract.INBOX_PATH).fetch(new Request(
        `http://${HOST}${inboxContract.INBOX_PATH}${inboxQuery()}`,
        { headers: { host: HOST, origin: 'http://evil.example' } },
      )),
    )
    assert.equal(crossOrigin.status, 403)
    assert.equal(crossOrigin.body.ok, false)
    assert.equal(crossOrigin.body.error.code, 'request/origin')

    const badBody = await readResponse(
      await routes.get(inboxContract.INBOX_RESOLVE_PATH).fetch(new Request(
        `http://${HOST}${inboxContract.INBOX_RESOLVE_PATH}`,
        { method: 'POST', headers: { host: HOST, 'content-type': 'text/plain' }, body: 'x' },
      )),
    )
    assert.equal(badBody.status, 415)
    assert.equal(badBody.body.error.code, 'request/content-type')
  })
})
