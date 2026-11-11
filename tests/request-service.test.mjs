import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `src/request-service.ts` imports its siblings with the build's `.js`
// specifiers, so the test loads it after the resolve hook.
const HOOK_SOURCE = [
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier.startsWith('.') && specifier.endsWith('.js')) {",
  "    try { return await nextResolve(specifier.slice(0, -3) + '.ts', context) } catch {}",
  '  }',
  '  return nextResolve(specifier, context)',
  '}',
].join('\n')
register(`data:text/javascript,${encodeURIComponent(HOOK_SOURCE)}`)

const { ProjectStore } = await import('../src/store.ts')
const service = await import('../src/request-service.ts')
const { RequestStore } = await import('../src/request-store.ts')
const { archiveTopic } = await import('../src/tool-runtime.ts')
const { OPEN_FILE_MAX_BYTES } = await import('../src/inbox-contract.ts')

const NOW = new Date('2026-11-10T09:00:00.000Z')
const NOW_ISO = NOW.toISOString()
const MASTER = 'session-master'
const TOPIC = 'session-topic'

/** One v2 topic with every field the schema requires. */
function topic(overrides = {}) {
  return {
    topicId: TOPIC,
    title: 'Inbox backend',
    status: 'active',
    awaitingReview: false,
    blocked: false,
    blockedReason: null,
    blockedFromStatus: null,
    blockedAt: null,
    authorization: null,
    scope: 'inbox',
    ownedPaths: [],
    aliases: [],
    digest: 'working',
    cwd: '/repo',
    legacyCheckoutPath: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    lastActiveAt: '2026-11-01T00:00:00.000Z',
    lastDeliveryConfirmedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    latestReviewRequestId: null,
    reviewStatus: null,
    reviewerSessionId: null,
    ...overrides,
  }
}

/** A topic blocked on one pending authorization. */
function pendingAuthorization(overrides = {}) {
  return topic({
    status: 'idle',
    blocked: true,
    blockedReason: 'authorization',
    blockedFromStatus: 'idle',
    blockedAt: NOW_ISO,
    authorization: { requestId: 'req-1', summary: 'may I push?', requestedAt: NOW_ISO },
    ...overrides,
  })
}

/** Fake host ports: the queue prompt and the notice channel. */
function fakeHost({ accepted = true, promptError = null, noticePort = undefined } = {}) {
  const prompts = []
  const updates = []
  const port = noticePort ?? {
    capabilities: () => ({ supported: true, actions: true, updates: true }),
    append: async () => 'delivered',
    update: async (sessionId, noticeId, patch) => {
      updates.push({ sessionId, noticeId, patch })
      if (noticePort === undefined) return 'delivered'
      return 'delivered'
    },
  }
  return {
    prompts,
    updates,
    port,
    promptSession: async (sessionId, text) => {
      prompts.push({ sessionId, text })
      if (promptError !== null) throw new Error(promptError)
      return { accepted }
    },
  }
}

async function withRepo(run) {
  const repoPath = await mkdtemp(join(tmpdir(), 'dsh-cowork-request-service-'))
  try {
    return await run(repoPath)
  } finally {
    await rm(repoPath, { recursive: true, force: true })
  }
}

async function seedProject(repoPath, topics) {
  const store = new ProjectStore({ repoPath, clock: () => NOW, projectId: 'p' })
  await store.initIndex(MASTER)
  if (topics.length > 0) {
    await store.mutateIndexDocument((document) => ({
      ...document,
      topics: topics.map((entry) => ({ ...entry, cwd: repoPath })),
    }))
  }
  return store
}

/** Create one request for the seeded topic through the service. */
async function seedRequest(repoPath, store, input) {
  return service.createRequest({
    store,
    repoPath,
    projectId: 'p',
    topic: topic(),
    now: NOW,
    requestId: 'req-1',
    ...input,
  })
}

/** The persisted request of the repo. */
async function readRequest(repoPath, requestId = 'req-1') {
  return new RequestStore({ repoPath }).read(requestId)
}

/** Resolve one request with the shared fake host. */
function resolveInput(repoPath, store, host, overrides = {}) {
  return {
    store,
    repoPath,
    document: { masterSessionId: MASTER, topics: [topic()] },
    sessionId: MASTER,
    requestId: 'req-1',
    action: 'pass',
    now: NOW,
    promptSession: host.promptSession,
    noticePort: host.port,
    log: () => {},
    ...overrides,
  }
}

test('createRequest persists the record and its request-created activity', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    const record = await seedRequest(repoPath, store, {
      kind: 'user-review',
      payload: { purpose: 'review the inbox backend' },
    })
    assert.equal(record.status, 'pending')
    assert.match(record.requestMessage, /^主题「Inbox backend」请你审核：review/)
    const { events } = await store.readActivity()
    const created = events.find((event) => event.type === 'request-created')
    assert.equal(created.details.requestId, 'req-1')
    assert.equal(created.details.kind, 'user-review')
    assert.equal(created.details.status, 'pending')
    assert.equal(created.details.topicId, TOPIC)
  })
})

test('createRequest refuses an invalid payload without writing a file', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    await assert.rejects(
      seedRequest(repoPath, store, { kind: 'plan', payload: { planPath: '/etc/passwd' } }),
      (error) => error.code === 'request/invalid-body',
    )
    assert.equal(await readRequest(repoPath), null)
    assert.deepEqual((await store.readActivity()).events, [])
  })
})

test('resolveRequest writes the terminal state, the reply, the activity and the prompt', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    await seedRequest(repoPath, store, { kind: 'user-review', payload: { purpose: 'review' } })
    const host = fakeHost()
    const outcome = await service.resolveRequest(resolveInput(repoPath, store, host, {
      comment: 'looks right',
    }))
    assert.equal(outcome.changed, true)
    assert.equal(outcome.prompted, true)
    assert.equal(outcome.promptError, null)
    assert.equal(outcome.record.status, 'passed')
    assert.equal(outcome.record.resolvedBy, 'user')
    assert.equal(outcome.record.resolvedAt, NOW_ISO)
    assert.match(outcome.record.resolutionMessage, /已通过评审/)
    assert.match(outcome.record.resolutionMessage, /looks right/)
    assert.equal(outcome.record.delivery.promptedAt, NOW_ISO)
    assert.equal(outcome.record.delivery.lastError, null)
    assert.deepEqual(host.prompts, [{ sessionId: TOPIC, text: outcome.record.resolutionMessage }])
    const { events } = await store.readActivity()
    const resolved = events.find((event) => event.type === 'request-resolved')
    assert.equal(resolved.details.requestId, 'req-1')
    assert.equal(resolved.details.action, 'pass')
    assert.equal(resolved.details.status, 'passed')
    assert.equal(resolved.details.kind, 'user-review')
  })
})

test('the same action replays idempotently; a different action is a conflict', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    await seedRequest(repoPath, store, { kind: 'user-review', payload: { purpose: 'review' } })
    const host = fakeHost()
    await service.resolveRequest(resolveInput(repoPath, store, host))
    const replay = await service.resolveRequest(resolveInput(repoPath, store, host))
    assert.equal(replay.changed, false)
    assert.equal(replay.prompted, false)
    assert.equal(replay.record.status, 'passed')
    assert.match(replay.record.resolutionMessage, /已通过评审/)
    await assert.rejects(
      service.resolveRequest(resolveInput(repoPath, store, host, { action: 'return' })),
      (error) => error.code === 'inbox/request-resolved',
    )
    assert.deepEqual(host.prompts.length, 1, 'a replay never prompts twice')
  })
})

test('resolveRequest refuses a foreign session, an unknown request and a wrong action', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    await seedRequest(repoPath, store, { kind: 'user-review', payload: { purpose: 'review' } })
    const host = fakeHost()
    await assert.rejects(
      service.resolveRequest(resolveInput(repoPath, store, host, { sessionId: 'session-stranger' })),
      (error) => error.code === 'inbox/not-member',
    )
    await assert.rejects(
      service.resolveRequest(resolveInput(repoPath, store, host, { requestId: 'req-missing' })),
      (error) => error.code === 'inbox/request-not-found',
    )
    await assert.rejects(
      service.resolveRequest(resolveInput(repoPath, store, host, { action: 'allow' })),
      (error) => error.code === 'inbox/action-not-allowed',
    )
    assert.equal((await readRequest(repoPath)).status, 'pending')
  })
})

test('the topic session may resolve its own request without prompting itself', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    await seedRequest(repoPath, store, { kind: 'plan', payload: { planPath: 'docs/plan.md', planTitle: 'PLAN' } })
    const host = fakeHost()
    const outcome = await service.resolveRequest(resolveInput(repoPath, store, host, {
      sessionId: TOPIC,
      action: 'approve',
    }))
    assert.equal(outcome.changed, true)
    assert.equal(outcome.prompted, false)
    assert.equal(outcome.record.status, 'approved')
    assert.deepEqual(host.prompts, [])
  })
})

test('a failed queue prompt keeps the terminal state and records delivery.lastError', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    await seedRequest(repoPath, store, { kind: 'plan', payload: { planPath: 'docs/plan.md' } })
    const host = fakeHost({ promptError: 'host is busy' })
    const outcome = await service.resolveRequest(resolveInput(repoPath, store, host, { action: 'revise' }))
    assert.equal(outcome.changed, true)
    assert.equal(outcome.prompted, false)
    assert.match(outcome.promptError, /host is busy/)
    assert.equal(outcome.record.status, 'revise', 'prompt failure never rolls the decision back')
    assert.equal(outcome.record.delivery.lastError, 'host is busy')
    assert.equal(outcome.record.delivery.promptedAt, null)
    assert.match(outcome.record.resolutionMessage, /已要求修改计划/)
  })
})

test('a refused queue prompt is reported without a fake right-hand reply', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    await seedRequest(repoPath, store, { kind: 'user-review', payload: { purpose: 'review' } })
    const host = fakeHost({ accepted: false })
    const outcome = await service.resolveRequest(resolveInput(repoPath, store, host))
    assert.equal(outcome.prompted, false)
    assert.match(outcome.promptError, /refused/)
    assert.equal((await readRequest(repoPath)).status, 'passed')
  })
})

test('a question submit validates answers and only then resolves', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    await seedRequest(repoPath, store, {
      kind: 'question',
      payload: {
        questions: [{ id: 'q1', prompt: 'ship it?', mode: 'single', options: [{ id: 'o1', label: 'yes' }] }],
      },
    })
    const host = fakeHost()
    await assert.rejects(
      service.resolveRequest(resolveInput(repoPath, store, host, { action: 'submit', answers: [] })),
      (error) => error.code === 'inbox/invalid-answer',
    )
    const outcome = await service.resolveRequest(resolveInput(repoPath, store, host, {
      action: 'submit',
      answers: [{ questionId: 'q1', selected: ['o1'] }],
    }))
    assert.equal(outcome.record.status, 'answered')
    assert.match(outcome.record.resolutionMessage, /已回答全部问题/)
  })
})

test('an over-long comment is refused before anything is written', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    await seedRequest(repoPath, store, { kind: 'user-review', payload: { purpose: 'review' } })
    const host = fakeHost()
    await assert.rejects(
      service.resolveRequest(resolveInput(repoPath, store, host, { comment: 'c'.repeat(2001) })),
      (error) => error.code === 'inbox/invalid-comment',
    )
    assert.equal((await readRequest(repoPath)).status, 'pending')
  })
})

test('an authorization request resolves through the one shared decision core', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [pendingAuthorization()])
    await seedRequest(repoPath, store, {
      kind: 'authorization',
      payload: { summary: 'may I push?' },
    })
    // The authorization-requested event is what the decision core patches.
    await store.appendActivity({
      eventId: 'event-auth-1',
      time: NOW_ISO,
      type: 'authorization-requested',
      topicId: TOPIC,
      summary: 'requested authorization: may I push?',
      details: { topicId: TOPIC, requestId: 'req-1', notice: { kind: 'authorization', title: 'T', summary: 'may I push?', targets: ['master', 'topic'], actions: ['allow', 'deny'], status: 'pending' } },
    })
    const host = fakeHost()
    const outcome = await service.resolveRequest(resolveInput(repoPath, store, host, { action: 'allow' }))
    assert.equal(outcome.record.status, 'allowed')
    assert.equal(outcome.prompted, true)
    const document = await store.readIndexDocument()
    assert.equal(document.topics[0].authorization, null)
    assert.equal(document.topics[0].blocked, false)
    const { events } = await store.readActivity()
    const decided = events.find((event) => event.type === 'authorization-resolved')
    assert.equal(decided.details.requestId, 'req-1')
    assert.equal(decided.details.decision, 'allow')
    assert.equal(decided.details.noticeId, 'event-auth-1')
    assert.equal(events.some((event) => event.type === 'request-resolved'), true)
    assert.deepEqual(host.updates.map((entry) => [entry.sessionId, entry.patch.status]), [
      ['session-master', 'allowed'],
      [TOPIC, 'allowed'],
    ])
    assert.equal(host.prompts.length, 1)
    assert.match(host.prompts[0].text, /授权请求已允许/)
  })
})

test('an authorization request without its topic block is reported resolved', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    await seedRequest(repoPath, store, { kind: 'authorization', payload: { summary: 'may I push?' } })
    const host = fakeHost()
    await assert.rejects(
      service.resolveRequest(resolveInput(repoPath, store, host, { action: 'allow' })),
      (error) => error.code === 'inbox/request-resolved',
    )
  })
})

test('archiving a topic voids its pending requests and records each resolution', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic(), topic({ topicId: 'session-other' })])
    await seedRequest(repoPath, store, { kind: 'user-review', payload: { purpose: 'review' } })
    const host = fakeHost()
    const outcome = await archiveTopic(store, TOPIC, {
      now: NOW,
      repoPath,
      by: 'user',
      runtime: { port: host.port, kick: () => {} },
    })
    assert.equal(outcome.changed, true)
    const record = await readRequest(repoPath)
    assert.equal(record.status, 'void')
    assert.match(record.resolutionMessage, /作废/)
    const { events } = await store.readActivity()
    const voided = events.find((event) => event.type === 'request-resolved')
    assert.equal(voided.details.requestId, 'req-1')
    assert.equal(voided.details.action, null)
    assert.equal(voided.details.status, 'void')
    assert.deepEqual(host.prompts, [], 'archiving never wakes the topic')
  })
})

test('openRequestTarget reveals a plan file inside the repository', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    await mkdir(join(repoPath, 'docs'), { recursive: true })
    await writeFile(join(repoPath, 'docs', 'plan.md'), '# plan\n')
    await seedRequest(repoPath, store, { kind: 'plan', payload: { planPath: 'docs/plan.md' } })
    const opened = []
    const path = await service.openRequestTarget({
      store,
      repoPath,
      requestId: 'req-1',
      openWorkspacePath: async (file) => { opened.push(file) },
    })
    const expected = await realpath(join(repoPath, 'docs', 'plan.md'))
    assert.equal(path, expected)
    assert.deepEqual(opened, [expected])
  })
})

test('openRequestTarget guards the stored path', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    await mkdir(join(repoPath, 'docs'), { recursive: true })
    await writeFile(join(repoPath, 'docs', 'big.md'), 'x'.repeat(OPEN_FILE_MAX_BYTES + 1))
    await mkdir(join(repoPath, 'docs', 'folder'))
    // A symlink that leaves the repository: the file exists, the real path does not.
    const outside = join(repoPath, '..', `outside-${process.pid}.md`)
    await writeFile(outside, '# outside\n')
    try {
      await symlink(outside, join(repoPath, 'docs', 'escape.md'))
      const cases = [
        ['req-missing', { planPath: 'docs/missing.md' }],
        ['req-dir', { planPath: 'docs/folder' }],
        ['req-big', { planPath: 'docs/big.md' }],
        ['req-escape', { planPath: 'docs/escape.md' }],
      ]
      for (const [requestId, payload] of cases) {
        await service.createRequest({
          store,
          repoPath,
          projectId: 'p',
          topic: topic(),
          kind: 'plan',
          payload,
          requestId,
          now: NOW,
        })
        await assert.rejects(
          service.openRequestTarget({ store, repoPath, requestId, openWorkspacePath: async () => {} }),
          (error) => error.code === 'inbox/path-missing',
          requestId,
        )
      }
    } finally {
      await rm(outside, { force: true })
    }
    // Non-plan requests carry no openable file, and an unknown id is missing.
    await seedRequest(repoPath, store, { kind: 'user-review', payload: { purpose: 'p' } })
    await assert.rejects(
      service.openRequestTarget({ store, repoPath, requestId: 'req-1', openWorkspacePath: async () => {} }),
      (error) => error.code === 'inbox/path-missing',
    )
    await assert.rejects(
      service.openRequestTarget({ store, repoPath, requestId: 'req-unknown', openWorkspacePath: async () => {} }),
      (error) => error.code === 'inbox/request-not-found',
    )
  })
})

test('openRequestTarget reports an unsupported host instead of faking success', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    await mkdir(join(repoPath, 'docs'), { recursive: true })
    await writeFile(join(repoPath, 'docs', 'plan.md'), '# plan\n')
    await seedRequest(repoPath, store, { kind: 'plan', payload: { planPath: 'docs/plan.md' } })
    await assert.rejects(
      service.openRequestTarget({ store, repoPath, requestId: 'req-1' }),
      (error) => error.code === 'inbox/open-unsupported',
    )
    await assert.rejects(
      service.openRequestTarget({
        store,
        repoPath,
        requestId: 'req-1',
        openWorkspacePath: async () => { throw new Error('no desktop') },
      }),
      (error) => error.code === 'inbox/open-unsupported',
    )
    await assert.rejects(
      service.openRequestTarget({ store, repoPath, openWorkspacePath: async () => {} }),
      (error) => error.code === 'inbox/path-missing',
    )
  })
})

test('openRequestTarget reveals a proposal file named by a notice id', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    await mkdir(join(repoPath, '.dsh-cowork', 'proposals'), { recursive: true })
    await writeFile(join(repoPath, '.dsh-cowork', 'proposals', 'p-1.json'), '{}\n')
    await store.appendActivity({
      eventId: 'event-proposal-1',
      time: NOW_ISO,
      type: 'decision-proposed',
      topicId: TOPIC,
      summary: 'proposed decision',
      details: { topicId: TOPIC, proposalId: 'p-1', proposalPath: '.dsh-cowork/proposals/p-1.json' },
    })
    const opened = []
    await service.openRequestTarget({
      store,
      repoPath,
      noticeId: 'event-proposal-1',
      openWorkspacePath: async (file) => { opened.push(file) },
    })
    assert.deepEqual(opened, [await realpath(join(repoPath, '.dsh-cowork', 'proposals', 'p-1.json'))])
    await assert.rejects(
      service.openRequestTarget({ store, repoPath, noticeId: 'event-missing', openWorkspacePath: async () => {} }),
      (error) => error.code === 'inbox/path-missing',
    )
  })
})

test('the persisted file survives a fresh store instance (refresh path)', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    await seedRequest(repoPath, store, { kind: 'user-review', payload: { purpose: 'review' } })
    const host = fakeHost()
    await service.resolveRequest(resolveInput(repoPath, store, host, { comment: 'ok' }))
    const text = await readFile(join(repoPath, '.dsh-cowork', 'requests', 'req-1.json'), 'utf8')
    const reread = JSON.parse(text)
    assert.equal(reread.status, 'passed')
    assert.equal(reread.resolutionMessage.includes('ok'), true)
    assert.equal(reread.requestMessage.startsWith('主题「Inbox backend」'), true)
  })
})
