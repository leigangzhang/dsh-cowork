import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  makeSeedProject,
  makeTopicFixture,
  withRepo,
} from '../support/inbox-fixtures.mjs'

const { registerCoworkTools } = await import('../../src/app/tools.ts')
const { ProjectStore } = await import('../../src/store/project-store.ts')
const { RequestStore } = await import('../../src/store/request-store.ts')
const { REQUEST_TOOL_ERROR_CODES } = await import('../../src/tools/request.ts')
const { ERROR_CODES } = await import('../../src/platform/tool-model.ts')

const NOW = new Date('2026-11-10T09:00:00.000Z')
const NOW_ISO = NOW.toISOString()
const MASTER = 'session-master'
const TOPIC = 'session-thread'

function fakeHost() {
  const registry = new Map()
  return {
    registry,
    tools: {
      register(definition) {
        registry.set(definition.name, definition)
        return () => registry.delete(definition.name)
      },
    },
  }
}

function fakeExec(sessionId, cwd) {
  return { agent: { id: sessionId, session: { header: { cwd } } } }
}

/** Recording host ports; the project store is the real one under a temp dir. */
function fakeDeps() {
  const prompts = []
  const deps = {
    prompts,
    promptAccepted: true,
    sessionController: {
      async create(options) { return { sessionId: 'session-created', workspaceId: 'w', agentPreset: options.agentPreset } },
      async rename({ title }) { return { title, seq: 1 } },
      async prompt(request) {
        prompts.push(request)
        return { accepted: deps.promptAccepted }
      },
      async list() { return { items: [] } },
      async inspect(sessionId) { return { meta: { id: sessionId } } },
    },
    workspaceRegistry: {
      async resolveByPath(path) { return { id: 'w', path } },
      async create(path) { return { id: 'w', path } },
      async delete() { return true },
      async archiveSession() {},
    },
    agentPresets: {},
    clock: () => NOW,
    log: () => {},
  }
  return deps
}

/** The suite's v2 topic fixture, bound to one record template. */
const topic = makeTopicFixture({
  topicId: TOPIC,
  title: 'Inbox backend',
  scope: 'inbox',
  digest: 'working',
})

const seedProject = makeSeedProject({ clock: () => NOW })

function tools(deps) {
  const host = fakeHost()
  registerCoworkTools(host, deps)
  return host.registry
}

/** Every request file of the project. */
async function requestFiles(repoPath) {
  try {
    return (await readdir(join(repoPath, '.dsh-cowork', 'requests'))).filter((name) => name.endsWith('.json'))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

test('the three request tools register with their frozen parameter surface', () => {
  const deps = fakeDeps()
  const registry = tools(deps)
  const review = registry.get('cowork_user_review_request')
  const question = registry.get('cowork_request_question')
  const plan = registry.get('cowork_request_plan')
  assert.ok(review, 'cowork_user_review_request must be registered')
  assert.ok(question, 'cowork_request_question must be registered')
  assert.ok(plan, 'cowork_request_plan must be registered')
  assert.equal(review.parameters.type, 'object')
  assert.deepEqual(Object.keys(review.parameters.properties).sort(), [
    'changedPaths', 'purpose', 'reviewRequestId', 'verification',
  ])
  assert.deepEqual(review.parameters.required, ['purpose'])
  assert.equal(review.parameters.properties.verification.items.properties.exitCode.type, 'integer')
  assert.deepEqual(Object.keys(question.parameters.properties), ['questions'])
  assert.deepEqual(question.parameters.required, ['questions'])
  assert.deepEqual(question.parameters.properties.questions.items.properties.mode.enum, ['single', 'multi'])
  assert.deepEqual(Object.keys(plan.parameters.properties).sort(), ['planPath', 'planTitle', 'summary'])
  assert.deepEqual(plan.parameters.required.sort(), ['planPath', 'summary'])
  assert.match(review.description, /not the automatic reviewer/)
})

test('cowork_user_review_request writes one pending record and its activity', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    const deps = fakeDeps()
    const result = await tools(deps).get('cowork_user_review_request').execute({
      purpose: 'review the inbox backend',
      changedPaths: ['src/tools/request.ts'],
      verification: [{ command: 'node --test', exitCode: 0, evidence: 'ok' }],
      reviewRequestId: 'auto-review-1',
    }, fakeExec(TOPIC, repoPath))
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'user-review')
    assert.equal(result.status, 'pending')
    assert.match(result.requestMessage, /^主题「Inbox backend」请你审核：review/)
    assert.equal(result.topic.topicId, TOPIC)

    const record = await new RequestStore({ repoPath }).read(result.requestId)
    assert.equal(record.status, 'pending')
    assert.equal(record.topicId, TOPIC)
    assert.equal(record.payload.purpose, 'review the inbox backend')
    assert.deepEqual(record.payload.changedPaths, ['src/tools/request.ts'])
    assert.equal(record.payload.reviewRequestId, 'auto-review-1')
    assert.deepEqual(record.payload.verification, [{ command: 'node --test', exitCode: 0, evidence: 'ok' }])

    const { events } = await store.readActivity()
    const created = events.find((event) => event.type === 'request-created')
    assert.equal(created.details.requestId, result.requestId)
    assert.equal(created.details.kind, 'user-review')
    assert.equal(created.details.status, 'pending')
  })
})

test('a refused user review writes nothing', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    const deps = fakeDeps()
    const review = tools(deps).get('cowork_user_review_request')
    const exec = fakeExec(TOPIC, repoPath)
    const noPurpose = await review.execute({ purpose: '' }, exec)
    assert.equal(noPurpose.ok, false)
    assert.equal(noPurpose.error.code, REQUEST_TOOL_ERROR_CODES.payloadInvalid)
    const tooManyPaths = await review.execute({
      purpose: 'p',
      changedPaths: Array.from({ length: 51 }, (_, index) => `p-${index}`),
    }, exec)
    assert.equal(tooManyPaths.ok, false)
    // A non-integer exit code never reaches the tool: the argument schema refuses it.
    await assert.rejects(
      review.execute({ purpose: 'p', verification: [{ command: 'c', exitCode: 1.5, evidence: 'e' }] }, exec),
      /must be an integer/,
    )
    assert.deepEqual(await requestFiles(repoPath), [])
    assert.deepEqual((await store.readActivity()).events, [])
  })
})

test('cowork_request_question mints q1..qn and o1..on and stores the answers contract', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [topic()])
    const deps = fakeDeps()
    const result = await tools(deps).get('cowork_request_question').execute({
      questions: [
        { prompt: 'ship it?', mode: 'single', options: [{ label: 'yes', recommended: true }, { label: 'no' }] },
        { prompt: 'anything else?', mode: 'multi', allowText: true },
      ],
    }, fakeExec(TOPIC, repoPath))
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'question')
    const record = await new RequestStore({ repoPath }).read(result.requestId)
    assert.deepEqual(record.payload.questions.map((question) => question.id), ['q1', 'q2'])
    assert.deepEqual(record.payload.questions[0].options.map((option) => option.id), ['o1', 'o2'])
    assert.equal(record.payload.questions[0].options[0].recommended, true)
    assert.equal(record.payload.questions[1].allowText, true)
    assert.match(record.requestMessage, /请你回答：ship it\?（共 2 个问题）/)
  })
})

test('a refused question or plan writes nothing', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    const deps = fakeDeps()
    const registry = tools(deps)
    const exec = fakeExec(TOPIC, repoPath)
    const noQuestions = await registry.get('cowork_request_question').execute({ questions: [] }, exec)
    assert.equal(noQuestions.ok, false)
    const tooMany = await registry.get('cowork_request_question').execute({
      questions: Array.from({ length: 6 }, () => ({ prompt: 'p', mode: 'single' })),
    }, exec)
    assert.equal(tooMany.ok, false)
    await assert.rejects(
      registry.get('cowork_request_question').execute({
        questions: [{ prompt: 'p', mode: 'single', options: [{ description: 'no label' }] }],
      }, exec),
      /missing required property/,
    )
    const absolute = await registry.get('cowork_request_plan').execute({
      planPath: '/etc/passwd', summary: 's',
    }, exec)
    assert.equal(absolute.ok, false)
    assert.equal(absolute.error.code, REQUEST_TOOL_ERROR_CODES.planPathInvalid)
    const escaping = await registry.get('cowork_request_plan').execute({
      planPath: 'docs/../etc/passwd', summary: 's',
    }, exec)
    assert.equal(escaping.ok, false)
    await assert.rejects(
      registry.get('cowork_request_plan').execute({ planPath: 'docs/plan.md' }, exec),
      /missing required property/,
    )
    assert.deepEqual(await requestFiles(repoPath), [])
    assert.deepEqual((await store.readActivity()).events, [])
  })
})

test('cowork_request_plan registers a repo-relative plan file', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [topic()])
    const result = await tools(fakeDeps()).get('cowork_request_plan').execute({
      planPath: 'docs/plan.md',
      planTitle: 'PLAN',
      summary: 'approve the inbox plan',
    }, fakeExec(TOPIC, repoPath))
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'plan')
    assert.equal(result.summary, 'approve the inbox plan')
    assert.match(result.requestMessage, /请你确认计划《PLAN》/)
    const record = await new RequestStore({ repoPath }).read(result.requestId)
    assert.deepEqual(record.payload, { planPath: 'docs/plan.md', planTitle: 'PLAN' })
  })
})

test('the tools refuse a master caller and an archived topic', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [topic(), topic({ topicId: 'session-archived', status: 'resolved', resolvedAt: NOW_ISO, resolvedBy: 'user' })])
    const registry = tools(fakeDeps())
    const review = registry.get('cowork_user_review_request')
    const asMaster = await review.execute({ purpose: 'p' }, fakeExec(MASTER, repoPath))
    assert.equal(asMaster.ok, false)
    assert.equal(asMaster.error.code, ERROR_CODES.roleForbidden)
    const archived = await review.execute({ purpose: 'p' }, fakeExec('session-archived', repoPath))
    assert.equal(archived.ok, false)
    assert.equal(archived.error.code, REQUEST_TOOL_ERROR_CODES.topicArchived)
    // A session outside the project's threads fails the role gate before the
    // topic lookup; `checkRole('thread')` is what makes that the first answer.
    const unknown = await review.execute({ purpose: 'p' }, fakeExec('session-unknown', repoPath))
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, ERROR_CODES.roleForbidden)
    assert.deepEqual(await requestFiles(repoPath), [])
  })
})

test('cowork_authorization_request bridges the block and the request record', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    const result = await tools(fakeDeps()).get('cowork_authorization_request').execute({
      summary: 'may I rewrite the index?',
      command: 'git push origin main',
    }, fakeExec(TOPIC, repoPath))
    assert.equal(result.ok, true)
    assert.equal(result.requestRecorded, true)
    assert.equal(typeof result.requestId, 'string')

    const document = await store.readIndexDocument()
    const row = document.topics[0]
    assert.equal(row.blockedReason, 'authorization')
    assert.deepEqual(row.authorization, {
      requestId: result.requestId,
      summary: 'may I rewrite the index?',
      requestedAt: NOW_ISO,
    }, 'the topic record keeps its old shape; the command lives in the request payload')

    const record = await new RequestStore({ repoPath }).read(result.requestId)
    assert.equal(record.kind, 'authorization')
    assert.equal(record.topicId, TOPIC)
    assert.deepEqual(record.payload, {
      summary: 'may I rewrite the index?',
      command: 'git push origin main',
    })

    const { events } = await store.readActivity()
    assert.equal(events.filter((event) => event.type === 'request-created').length, 1)
    const requested = events.find((event) => event.type === 'authorization-requested')
    assert.equal(requested.details.requestId, result.requestId, 'both records share one requestId')
    const ledger = await store.readNotices()
    assert.equal(ledger.notices.length, 2, 'still one notice per target, no duplicate card')
  })
})

test('an authorization refusal blocks nothing and writes no request', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    const result = await tools(fakeDeps()).get('cowork_authorization_request').execute({
      summary: 'may I?',
      command: 'c'.repeat(301),
    }, fakeExec(TOPIC, repoPath))
    assert.equal(result.ok, false)
    assert.equal(result.error.code, REQUEST_TOOL_ERROR_CODES.payloadInvalid)
    const document = await store.readIndexDocument()
    assert.equal(document.topics[0].blocked, false)
    assert.equal(document.topics[0].authorization, null)
    assert.deepEqual(await requestFiles(repoPath), [])
  })
})

test('the persisted record keeps both messages so a refresh restores the thread', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [topic()])
    const result = await tools(fakeDeps()).get('cowork_user_review_request').execute({
      purpose: 'review the inbox backend',
    }, fakeExec(TOPIC, repoPath))
    const raw = JSON.parse(await readFile(
      join(repoPath, '.dsh-cowork', 'requests', `${result.requestId}.json`),
      'utf8',
    ))
    assert.equal(raw.requestMessage, result.requestMessage)
    assert.equal(raw.resolutionMessage, null)
    assert.equal(raw.version, 1)
    assert.equal(raw.delivery.promptedAt, null)
  })
})
