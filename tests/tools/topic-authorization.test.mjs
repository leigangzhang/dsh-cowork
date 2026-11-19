import test from 'node:test'
import assert from 'node:assert/strict'
import '../support/ts-hook.mjs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeSeedProject, makeTopicFixture, withRepo } from '../support/inbox-fixtures.mjs'

/**
 * The authorization invariants of the topic tools: one pending request per
 * topic, report/handoff never clearing it, and recovery from the historical
 * state where the topic record lost the pointer while the card stayed pending.
 */
const { registerCoworkTools } = await import('../../src/app/tools.ts')
const { TOPIC_PAGE_ERROR_CODES } = await import('../../src/tools/topic.ts')

const NOW_ISO = '2026-11-07T10:00:00.000Z'
const NOW_MS = Date.parse(NOW_ISO)
const HANDOFF_VERIFICATION = [{ command: 'npm test', exitCode: 0, evidence: 'ok' }]

function fakeHost() {
  const registry = new Map()
  return {
    tools: {
      register(definition) {
        registry.set(definition.name, definition)
        return () => registry.delete(definition.name)
      },
    },
    registry,
  }
}

function fakeExec(sessionId, cwd) {
  return { agent: { id: sessionId, session: { header: { cwd } } } }
}

/** The host ports these tool calls touch: sessions, prompts, archives, clock. */
function fakeDeps() {
  const createCalls = []
  const promptCalls = []
  const archiveCalls = []
  let created = 0
  const deps = {
    createCalls,
    promptCalls,
    archiveCalls,
    promptAccepted: true,
    sessionController: {
      async create(options) {
        createCalls.push(options)
        created += 1
        return { sessionId: `session-created-${created}`, workspaceId: 'workspace-1', agentPreset: options.agentPreset }
      },
      async rename({ title }) { return { title, seq: 1 } },
      async prompt(request) {
        promptCalls.push(request)
        return { accepted: deps.promptAccepted }
      },
      async list() { return { items: [] } },
      async inspect(sessionId) { return { meta: { id: sessionId } } },
    },
    workspaceRegistry: {
      async resolveByPath(path) { return { id: 'workspace-1', path } },
      async create(path) { return { id: 'workspace-1', path } },
      async delete() { return true },
      async archiveSession(sessionId, options) { archiveCalls.push({ sessionId, options }) },
    },
    agentPresets: {},
    nowMs: NOW_MS,
    clock: () => new Date(deps.nowMs),
  }
  return deps
}

const topic = makeTopicFixture({
  topicId: 'session-thread',
  title: 'thread topic',
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
  lastActiveAt: NOW_ISO,
})
const seedProject = makeSeedProject({ clock: () => new Date(NOW_ISO) })

function tools(deps) {
  const host = fakeHost()
  registerCoworkTools(host, deps)
  return host.registry
}

/** Advance the fake clock by one second between two handoff calls. */
function advanceClock(deps) {
  deps.nowMs += 1000
}

/** A store wrapper whose first direct index read returns another writer's view. */
function racingStoreFor(store, transform) {
  let reads = 0
  return new Proxy(store, {
    get(target, property) {
      if (property === 'readIndexDocument') {
        return async () => {
          reads += 1
          const document = await target.readIndexDocument()
          return reads === 1 ? transform(document) : document
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

test('cowork_topic_report(kind blocked) keeps a pending authorization decidable', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic({ status: 'idle' })])
    const registry = tools(fakeDeps())
    const requested = await registry.get('cowork_authorization_request').execute(
      { summary: 'may I print the time in Beijing?' },
      fakeExec('session-thread', repoPath),
    )
    assert.equal(requested.ok, true)

    const reported = await registry.get('cowork_topic_report').execute(
      { summary: 'waiting for the user to allow the timezone command', kind: 'blocked' },
      fakeExec('session-thread', repoPath),
    )
    assert.equal(reported.ok, true)

    const row = (await store.readIndexDocument()).topics[0]
    assert.equal(row.blocked, true)
    assert.equal(row.blockedReason, 'authorization')
    assert.deepEqual(row.authorization, {
      requestId: requested.requestId,
      summary: 'may I print the time in Beijing?',
      requestedAt: NOW_ISO,
    })
    const file = JSON.parse(await readFile(
      join(repoPath, '.dsh-cowork', 'requests', `${requested.requestId}.json`),
      'utf8',
    ))
    assert.equal(file.status, 'pending', 'the inbox card is still decidable')
  })
})

test('cowork_handoff keeps a pending authorization instead of releasing it', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    const deps = fakeDeps()
    const registry = tools(deps)
    const requested = await registry.get('cowork_authorization_request').execute(
      { summary: 'may I proceed?' },
      fakeExec('session-thread', repoPath),
    )
    assert.equal(requested.ok, true)

    const blocked = await registry.get('cowork_handoff').execute({
      status: 'blocked',
      summary: 'blocked on the authorization',
      verification: HANDOFF_VERIFICATION,
    }, fakeExec('session-thread', repoPath))
    assert.equal(blocked.ok, true)
    let row = (await store.readIndexDocument()).topics[0]
    assert.equal(row.blockedReason, 'authorization', 'a blocked handoff cannot replace the pending request')
    assert.equal(row.authorization?.requestId, requested.requestId)

    advanceClock(deps)
    const doneAt = new Date(deps.nowMs).toISOString()
    const done = await registry.get('cowork_handoff').execute({
      status: 'done',
      summary: 'finished the unrelated part',
      verification: HANDOFF_VERIFICATION,
    }, fakeExec('session-thread', repoPath))
    assert.equal(done.ok, true)
    row = (await store.readIndexDocument()).topics[0]
    assert.equal(row.blocked, true, 'a done handoff does not release the user decision')
    assert.equal(row.blockedReason, 'authorization')
    assert.equal(row.authorization?.requestId, requested.requestId)
    assert.equal(row.lastDeliveryConfirmedAt, doneAt, 'the handoff itself is still recorded')
  })
})

test('cowork_authorization_request refuses a second pending request', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    const registry = tools(fakeDeps())
    const first = await registry.get('cowork_authorization_request').execute(
      { summary: 'first ask' },
      fakeExec('session-thread', repoPath),
    )
    assert.equal(first.ok, true)

    const second = await registry.get('cowork_authorization_request').execute(
      { summary: 'second ask' },
      fakeExec('session-thread', repoPath),
    )
    assert.equal(second.ok, false)
    assert.equal(second.error.code, TOPIC_PAGE_ERROR_CODES.authorizationPending)
    const row = (await store.readIndexDocument()).topics[0]
    assert.equal(row.authorization?.requestId, first.requestId, 'the first request keeps the decision')
    assert.equal((await readdir(join(repoPath, '.dsh-cowork', 'requests'))).length, 1)
  })
})

test('cowork_authorization_request refuses a second request when the topic record lost its authorization', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    const registry = tools(fakeDeps())
    const first = await registry.get('cowork_authorization_request').execute(
      { summary: 'first ask' },
      fakeExec('session-thread', repoPath),
    )
    assert.equal(first.ok, true)

    await store.mutateIndexDocument((document) => ({
      ...document,
      topics: document.topics.map((entry) => (entry.topicId === 'session-thread'
        ? { ...entry, authorization: null, blockedReason: 'handoff' }
        : entry)),
    }))

    const second = await registry.get('cowork_authorization_request').execute(
      { summary: 'second ask' },
      fakeExec('session-thread', repoPath),
    )
    assert.equal(second.ok, false)
    assert.equal(second.error.code, TOPIC_PAGE_ERROR_CODES.authorizationPending)
    assert.match(second.error.message, new RegExp(first.requestId))
    assert.equal(
      (await readdir(join(repoPath, '.dsh-cowork', 'requests'))).length,
      1,
      'the orphaned card remains the only pending request',
    )
  })
})

test('cowork_authorization_request reports a pending request that wins the lock race', async () => {
  await withRepo(async (repoPath) => {
    const pending = { requestId: 'req-existing', summary: 'existing ask', requestedAt: NOW_ISO }
    const store = await seedProject(repoPath, [topic({
      blocked: true,
      blockedReason: 'authorization',
      blockedFromStatus: 'active',
      blockedAt: NOW_ISO,
      authorization: pending,
    })])
    const deps = fakeDeps()
    deps.createProjectStore = () => racingStoreFor(store, (document) => ({
      ...document,
      topics: document.topics.map((entry) => (entry.topicId === 'session-thread'
        ? { ...entry, authorization: null, blocked: false, blockedReason: null, blockedFromStatus: null, blockedAt: null }
        : entry)),
    }))
    const result = await tools(deps).get('cowork_authorization_request').execute(
      { summary: 'new ask' },
      fakeExec('session-thread', repoPath),
    )
    assert.equal(result.ok, false)
    assert.equal(result.error.code, TOPIC_PAGE_ERROR_CODES.authorizationPending)
    assert.match(result.error.message, /req-existing/)
  })
})
