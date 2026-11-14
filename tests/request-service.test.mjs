import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  fakeHost,
  makeSeedProject,
  makeSeedRequest,
  makeTopicFixture,
  withRepo,
} from './support/inbox-fixtures.mjs'

const { ProjectStore } = await import('../src/store/project-store.ts')
const service = await import('../src/request-service.ts')
const { RequestStore } = await import('../src/store/request-store.ts')
const { archiveTopic } = await import('../src/platform/tool-runtime.ts')
const { OPEN_FILE_MAX_BYTES } = await import('../src/inbox-contract.ts')

const NOW = new Date('2026-11-10T09:00:00.000Z')
const NOW_ISO = NOW.toISOString()
const MASTER = 'session-master'
const TOPIC = 'session-topic'

/** One v2 topic with the suite's identity and every required field. */
const topic = makeTopicFixture({
  topicId: TOPIC,
  title: 'Inbox backend',
  scope: 'inbox',
  digest: 'working',
})

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

const seedProject = makeSeedProject({ clock: () => NOW })

/** Create one request for the seeded topic through the service. */
const seedRequest = makeSeedRequest({ now: NOW, topic: () => topic() })

/** The persisted request of the repo. */
async function readRequest(repoPath, requestId = 'req-1') {
  return new RequestStore({ repoPath }).read(requestId)
}

/** The index + caller identity one open call needs. */
function openInput(repoPath, store, overrides = {}) {
  return {
    store,
    repoPath,
    document: { masterSessionId: MASTER, topics: [topic()] },
    sessionId: MASTER,
    ...overrides,
  }
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
    // The prompt restates the full comment, not only the truncated reply.
    assert.deepEqual(host.prompts, [{ sessionId: TOPIC, text: '主题「Inbox backend」已通过评审。\n备注：looks right' }])
    const { events } = await store.readActivity()
    const resolved = events.find((event) => event.type === 'request-resolved')
    assert.equal(resolved.details.requestId, 'req-1')
    assert.equal(resolved.details.action, 'pass')
    assert.equal(resolved.details.status, 'passed')
    assert.equal(resolved.details.kind, 'user-review')
  })
})

test('a question submit persists every answer and the full comment, and the prompt carries them', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    await seedRequest(repoPath, store, {
      kind: 'question',
      payload: {
        questions: [
          {
            id: 'q1',
            prompt: 'ship it?',
            mode: 'single',
            options: [{ id: 'o1', label: '现在发布' }, { id: 'o2', label: '再等等' }],
          },
          { id: 'q2', prompt: '还有别的吗？', mode: 'single', allowText: true },
        ],
      },
    })
    const host = fakeHost()
    const observed = []
    const outcome = await service.resolveRequest(resolveInput(repoPath, store, host, {
      action: 'submit',
      answers: [
        { questionId: 'q1', selected: ['o1'] },
        { questionId: 'q2', text: '把文档补上' },
      ],
      comment: '先处理文档，再发布',
      promptSession: async (sessionId, text) => {
        // The prompt port reads the card as the topic would: it must be terminal
        // and already carry every answer.
        observed.push(await readRequest(repoPath))
        return host.promptSession(sessionId, text)
      },
    }))
    assert.equal(outcome.record.status, 'answered')
    assert.deepEqual(outcome.record.resolution, {
      comment: '先处理文档，再发布',
      answers: [
        { questionId: 'q1', selected: ['o1'] },
        { questionId: 'q2', text: '把文档补上' },
      ],
    })
    assert.match(outcome.record.resolutionMessage, /已回答全部问题/)
    assert.match(outcome.record.resolutionMessage, /现在发布/)
    assert.match(outcome.record.resolutionMessage, /把文档补上/)
    assert.ok(Array.from(outcome.record.resolutionMessage).length <= 200)
    assert.equal(observed.length, 1)
    assert.equal(observed[0].status, 'answered', 'the card is terminal before the topic is woken')
    assert.deepEqual(observed[0].resolution, outcome.record.resolution)
    assert.equal(host.prompts.length, 1)
    const prompt = host.prompts[0].text
    assert.match(prompt, /ship it\?/)
    assert.match(prompt, /现在发布/)
    assert.match(prompt, /把文档补上/)
    assert.match(prompt, /先处理文档，再发布/)
  })
})

test('an authorization topic is prompted only after its card is terminal', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [pendingAuthorization()])
    await seedRequest(repoPath, store, { kind: 'authorization', payload: { summary: 'may I push?' } })
    const host = fakeHost()
    const observed = []
    const outcome = await service.resolveRequest(resolveInput(repoPath, store, host, {
      action: 'allow',
      promptSession: async (sessionId, text) => {
        observed.push(await readRequest(repoPath))
        return host.promptSession(sessionId, text)
      },
    }))
    assert.equal(outcome.prompted, true)
    assert.equal(observed.length, 1)
    assert.equal(observed[0].status, 'allowed', 'the card is terminal before the topic is woken')
    assert.deepEqual(host.prompts, [{ sessionId: TOPIC, text: '授权请求已允许：may I push?。请继续。' }])
    assert.equal((await readRequest(repoPath)).delivery.promptedAt, NOW_ISO)
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
    const path = await service.openRequestTarget(openInput(repoPath, store, {
      requestId: 'req-1',
      openWorkspacePath: async (file) => { opened.push(file) },
    }))
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
          service.openRequestTarget(openInput(repoPath, store, {
            requestId,
            openWorkspacePath: async () => {},
          })),
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
      service.openRequestTarget(openInput(repoPath, store, {
        requestId: 'req-1',
        openWorkspacePath: async () => {},
      })),
      (error) => error.code === 'inbox/path-missing',
    )
    await assert.rejects(
      service.openRequestTarget(openInput(repoPath, store, {
        requestId: 'req-unknown',
        openWorkspacePath: async () => {},
      })),
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
      service.openRequestTarget(openInput(repoPath, store, { requestId: 'req-1' })),
      (error) => error.code === 'inbox/open-unsupported',
    )
    await assert.rejects(
      service.openRequestTarget(openInput(repoPath, store, {
        requestId: 'req-1',
        openWorkspacePath: async () => { throw new Error('no desktop') },
      })),
      (error) => error.code === 'inbox/open-unsupported',
    )
    await assert.rejects(
      service.openRequestTarget(openInput(repoPath, store, { openWorkspacePath: async () => {} })),
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
    await service.openRequestTarget(openInput(repoPath, store, {
      noticeId: 'event-proposal-1',
      openWorkspacePath: async (file) => { opened.push(file) },
    }))
    assert.deepEqual(opened, [await realpath(join(repoPath, '.dsh-cowork', 'proposals', 'p-1.json'))])
    await assert.rejects(
      service.openRequestTarget(openInput(repoPath, store, {
        noticeId: 'event-missing',
        openWorkspacePath: async () => {},
      })),
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

test('openRequestTarget admits only the master or the owning topic', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic(), topic({ topicId: 'session-other' })])
    await mkdir(join(repoPath, 'docs'), { recursive: true })
    await writeFile(join(repoPath, 'docs', 'plan.md'), '# plan\n')
    await seedRequest(repoPath, store, { kind: 'plan', payload: { planPath: 'docs/plan.md' } })

    // The owning topic session may reveal its own request's file.
    const owned = []
    await service.openRequestTarget(openInput(repoPath, store, {
      requestId: 'req-1',
      sessionId: TOPIC,
      openWorkspacePath: async (file) => { owned.push(file) },
    }))
    assert.equal(owned.length, 1)

    // A repository session that owns neither the project nor the topic is refused
    // before the host opener runs, so it cannot even probe the file's existence.
    const opened = []
    await assert.rejects(
      service.openRequestTarget(openInput(repoPath, store, {
        requestId: 'req-1',
        sessionId: 'session-stranger',
        openWorkspacePath: async (file) => { opened.push(file) },
      })),
      (error) => error.code === 'inbox/not-member',
    )
    assert.deepEqual(opened, [], 'the host opener is never called for a stranger')

    // The same rule covers a proposal notice, whose topic comes from its event.
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
    await assert.rejects(
      service.openRequestTarget(openInput(repoPath, store, {
        noticeId: 'event-proposal-1',
        sessionId: 'session-other',
        openWorkspacePath: async () => {},
      })),
      (error) => error.code === 'inbox/not-member',
    )
    await service.openRequestTarget(openInput(repoPath, store, {
      noticeId: 'event-proposal-1',
      sessionId: TOPIC,
      openWorkspacePath: async () => {},
    }))

    // A notice without a topic belongs to the project, so only the master opens it.
    await store.appendActivity({
      eventId: 'event-proposal-no-topic',
      time: NOW_ISO,
      type: 'decision-proposed',
      topicId: null,
      summary: 'project-wide proposal',
      details: { proposalId: 'p-1', proposalPath: '.dsh-cowork/proposals/p-1.json' },
    })
    await assert.rejects(
      service.openRequestTarget(openInput(repoPath, store, {
        noticeId: 'event-proposal-no-topic',
        sessionId: TOPIC,
        openWorkspacePath: async () => {},
      })),
      (error) => error.code === 'inbox/not-member',
    )
    await service.openRequestTarget(openInput(repoPath, store, {
      noticeId: 'event-proposal-no-topic',
      openWorkspacePath: async () => {},
    }))
  })
})

test('settleAuthorizationRequestRecord mirrors a legacy decision into the card', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    await seedRequest(repoPath, store, { kind: 'authorization', payload: { summary: 'may I push?' } })
    const outcome = await service.settleAuthorizationRequestRecord({
      store,
      repoPath,
      topicId: TOPIC,
      requestId: 'req-1',
      decision: 'allow',
      now: NOW,
      promptedAt: NOW_ISO,
      promptError: null,
    })
    assert.equal(outcome, 'settled')
    const record = await readRequest(repoPath)
    assert.equal(record.status, 'allowed')
    assert.equal(record.resolvedBy, 'user')
    assert.equal(record.resolvedAt, NOW_ISO)
    assert.match(record.resolutionMessage, /已允许该授权/)
    assert.deepEqual(record.delivery, { promptedAt: NOW_ISO, lastError: null })

    const { events } = await store.readActivity()
    const resolved = events.filter((event) => event.type === 'request-resolved')
    assert.equal(resolved.length, 1, 'one settled card records one resolved row')
    assert.equal(resolved[0].details.requestId, 'req-1')
    assert.equal(resolved[0].details.action, 'allow')
    assert.equal(resolved[0].details.status, 'allowed')

    // A replay of the same decision writes nothing new.
    assert.equal(await service.settleAuthorizationRequestRecord({
      store,
      repoPath,
      topicId: TOPIC,
      requestId: 'req-1',
      decision: 'allow',
      now: new Date('2026-11-10T10:00:00.000Z'),
      promptedAt: null,
      promptError: null,
    }), 'already-resolved')
    assert.equal((await store.readActivity()).events.filter((event) => event.type === 'request-resolved').length, 1)
    assert.deepEqual((await readRequest(repoPath)).delivery, { promptedAt: NOW_ISO, lastError: null })
  })
})

test('settleAuthorizationRequestRecord keeps a prompt failure on the card', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    await seedRequest(repoPath, store, { kind: 'authorization', payload: { summary: 'may I push?' } })
    const outcome = await service.settleAuthorizationRequestRecord({
      store,
      repoPath,
      topicId: TOPIC,
      requestId: 'req-1',
      decision: 'deny',
      now: NOW,
      promptedAt: null,
      promptError: 'host is busy',
    })
    assert.equal(outcome, 'settled')
    const record = await readRequest(repoPath)
    assert.equal(record.status, 'denied')
    assert.match(record.resolutionMessage, /已拒绝该授权/)
    assert.deepEqual(record.delivery, { promptedAt: null, lastError: 'host is busy' })
  })
})

test('settleAuthorizationRequestRecord never rewrites a conflicting or foreign card', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic(), topic({ topicId: 'session-other' })])
    // No record at all: the legacy route keeps its old behaviour.
    assert.equal(await service.settleAuthorizationRequestRecord({
      store, repoPath, topicId: TOPIC, requestId: 'req-missing',
      decision: 'allow', now: NOW, promptedAt: null, promptError: null,
    }), 'absent')
    assert.deepEqual((await store.readActivity()).events, [])

    // A record of another topic and one of another kind are both left alone.
    await service.createRequest({
      store, repoPath, projectId: 'p', topic: topic(), kind: 'authorization',
      payload: { summary: 'may I push?' }, requestId: 'req-1', now: NOW,
    })
    await service.createRequest({
      store, repoPath, projectId: 'p', topic: topic({ topicId: 'session-other' }), kind: 'authorization',
      payload: { summary: 'other topic' }, requestId: 'req-other-topic', now: NOW,
    })
    await service.createRequest({
      store, repoPath, projectId: 'p', topic: topic(), kind: 'user-review',
      payload: { purpose: 'review' }, requestId: 'req-review', now: NOW,
    })
    const activitiesBefore = (await store.readActivity()).events.length
    assert.equal(await service.settleAuthorizationRequestRecord({
      store, repoPath, topicId: TOPIC, requestId: 'req-other-topic',
      decision: 'allow', now: NOW, promptedAt: null, promptError: null,
    }), 'absent')
    assert.equal(await service.settleAuthorizationRequestRecord({
      store, repoPath, topicId: TOPIC, requestId: 'req-review',
      decision: 'allow', now: NOW, promptedAt: null, promptError: null,
    }), 'absent')
    assert.equal((await readRequest(repoPath, 'req-other-topic')).status, 'pending')
    assert.equal((await readRequest(repoPath, 'req-review')).status, 'pending')
    assert.equal((await store.readActivity()).events.length, activitiesBefore)

    // An already-denied card is not rewritten by a late allow.
    await service.settleAuthorizationRequestRecord({
      store, repoPath, topicId: TOPIC, requestId: 'req-1',
      decision: 'deny', now: NOW, promptedAt: null, promptError: null,
    })
    const beforeConflict = await readRequest(repoPath)
    assert.equal(await service.settleAuthorizationRequestRecord({
      store, repoPath, topicId: TOPIC, requestId: 'req-1',
      decision: 'allow', now: NOW, promptedAt: NOW_ISO, promptError: null,
    }), 'conflict')
    assert.deepEqual(await readRequest(repoPath), beforeConflict, 'a settled card is immutable')
  })
})
