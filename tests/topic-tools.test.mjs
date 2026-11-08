import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * M9.3b contract tests for the topic tools: create (+ deprecated alias), list
 * (+ alias), resolve, and the v2 handoff semantics.
 *
 * The tool registry and host ports are recording fakes; the project store is
 * the real one under `os.tmpdir()`. The deprecated aliases must share the same
 * `execute` function and parameter schema, so the two names cannot drift.
 */
const HOOK_SOURCE = [
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier.startsWith('.') && specifier.endsWith('.js')) {",
  "    try { return await nextResolve(specifier.slice(0, -3) + '.ts', context) } catch {}",
  '  }',
  '  return nextResolve(specifier, context)',
  '}',
].join('\n')
register(`data:text/javascript,${encodeURIComponent(HOOK_SOURCE)}`)

const { registerCoworkTools } = await import('../src/tools.ts')
const { ProjectStore } = await import('../src/store.ts')
const { TOPIC_LIST_LIMIT } = await import('../src/topic-tools.ts')
const { ERROR_CODES, TOPIC_ERROR_CODES } = await import('../src/tool-model.ts')
const { INBOX_SUMMARY_MAX_CHARS } = await import('../src/inbox.ts')
const { deliverInbox } = await import('../src/tool-runtime.ts')

const NOW_ISO = '2026-11-07T10:00:00.000Z'
const NOW_MS = Date.parse(NOW_ISO)

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

/** Recording host ports: sessions, prompts, archives, and the clock. */
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
        return {
          sessionId: `session-created-${created}`,
          workspaceId: 'workspace-1',
          agentPreset: options.agentPreset,
        }
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

/** Advance the fake clock by one second between two handoff calls. */
const fakeDepsClock = {
  advance(deps) {
    deps.nowMs += 1000
  },
}

async function withRepo(run) {
  const repoPath = await mkdtemp(join(tmpdir(), 'dsh-cowork-topic-tools-'))
  try {
    return await run(repoPath)
  } finally {
    await rm(repoPath, { recursive: true, force: true })
  }
}

const topic = (overrides = {}) => ({
  topicId: 'session-thread',
  title: 'thread topic',
  status: 'active',
  awaitingReview: false,
  blocked: false,
  scope: '',
  ownedPaths: [],
  aliases: [],
  digest: '',
  cwd: '/repo',
  legacyCheckoutPath: null,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
  lastActiveAt: NOW_ISO,
  lastDeliveryConfirmedAt: null,
  resolvedAt: null,
  resolvedBy: null,
  latestReviewRequestId: null,
  reviewStatus: null,
  reviewerSessionId: null,
  ...overrides,
})

async function seedProject(repoPath, topics) {
  const store = new ProjectStore({ repoPath, clock: () => new Date(NOW_ISO), projectId: 'p' })
  await store.initIndex('session-master')
  if (topics.length > 0) {
    await store.mutateIndexDocument((document) => ({
      ...document,
      topics: topics.map((entry) => ({ ...entry, cwd: repoPath })),
    }))
  }
  return store
}

function tools(deps) {
  const host = fakeHost()
  registerCoworkTools(host, deps)
  return host.registry
}

const promptText = (call) => call.content[0].text

test('cowork_topic_create writes one canonical topic and records topic-created', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [])
    const deps = fakeDeps()
    const registry = tools(deps)

    const result = await registry.get('cowork_topic_create').execute({
      title: 'Billing work',
      scope: 'billing',
      ownedPaths: ['src/billing', ' src/billing ', 'src/invoices'],
      brief: 'Start with the invoice list.',
    }, fakeExec('session-master', repoPath))

    assert.equal(result.ok, true)
    assert.equal(result.title, 'Billing work')
    assert.equal(result.prompted, true)
    assert.equal(deps.createCalls.length, 1)
    assert.equal(deps.createCalls[0].agentPreset, 'cowork-topic')
    assert.equal(deps.promptCalls.length, 1)
    assert.equal(deps.promptCalls[0].sessionId, result.topic.topicId)
    assert.equal(promptText(deps.promptCalls[0]), 'Start with the invoice list.')

    assert.equal(result.topic.status, 'active')
    assert.equal(result.topic.scope, 'billing')
    assert.deepEqual(result.topic.ownedPaths, ['src/billing', 'src/invoices'])
    assert.equal(result.topic.digest, '')

    const document = await store.readIndexDocument()
    const stored = document.topics.find((entry) => entry.topicId === result.topic.topicId)
    assert.ok(stored)
    assert.equal(stored.status, 'active')
    assert.equal(stored.awaitingReview, false)
    assert.equal(stored.blocked, false)
    assert.equal(stored.createdAt, NOW_ISO)
    assert.equal(stored.updatedAt, NOW_ISO)
    assert.equal(stored.lastActiveAt, NOW_ISO)
    assert.equal(stored.cwd, repoPath)
    assert.equal(stored.lastDeliveryConfirmedAt, null)
    assert.equal(stored.resolvedAt, null)
    assert.equal(stored.resolvedBy, null)

    const activity = await store.readActivity()
    assert.ok(activity.events.some((event) => event.type === 'topic-created' && event.topicId === result.topic.topicId))
  })
})

test('cowork_thread_create is the same execute and schema as cowork_topic_create', async () => {
  await withRepo(async (repoPath) => {
    const deps = fakeDeps()
    const registry = tools(deps)
    const primary = registry.get('cowork_topic_create')
    const alias = registry.get('cowork_thread_create')
    assert.ok(primary && alias)
    assert.deepEqual(alias.parameters, primary.parameters)
    assert.match(alias.description, /deprecated/i)
    assert.ok(!('subject' in alias.parameters.properties), 'the old subject parameter is gone')
    assert.ok(!('isolated' in alias.parameters.properties), 'isolated belongs to M10 work items')

    const primaryPayload = await primary.execute({ title: 'Alias check' }, fakeExec('session-master', repoPath))
    const aliasPayload = await alias.execute({ title: 'Alias check' }, fakeExec('session-master', repoPath))
    assert.deepEqual(
      { ...primaryPayload, topic: { ...primaryPayload.topic, topicId: 'id' } },
      { ...aliasPayload, topic: { ...aliasPayload.topic, topicId: 'id' } },
      'both names must return the same payload shape and values',
    )
    assert.equal('thread' in primaryPayload, false, 'the payload uses the topic key')
  })
})

test('cowork_topic_create rejects an empty title, an empty owned path, and an over-long brief', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [])
    const registry = tools(fakeDeps())
    const create = registry.get('cowork_topic_create')

    const emptyTitle = await create.execute({ title: '   ' }, fakeExec('session-master', repoPath))
    assert.equal(emptyTitle.ok, false)
    assert.equal(emptyTitle.error.code, TOPIC_ERROR_CODES.topicTitleRequired)

    const emptyPath = await create.execute({ title: 'ok', ownedPaths: [''] }, fakeExec('session-master', repoPath))
    assert.equal(emptyPath.ok, false)
    assert.equal(emptyPath.error.code, TOPIC_ERROR_CODES.topicInvalidOwnedPaths)

    const longBrief = await create.execute({ title: 'ok', brief: 'x'.repeat(2001) }, fakeExec('session-master', repoPath))
    assert.equal(longBrief.ok, false)
    assert.equal(longBrief.error.code, TOPIC_ERROR_CODES.routeBriefTooLong)
  })
})

test('cowork_topic_list is bounded and only admits master or topic sessions', async () => {
  await withRepo(async (repoPath) => {
    const topics = Array.from({ length: TOPIC_LIST_LIMIT + 1 }, (_, index) => topic({
      topicId: `session-${String(index).padStart(3, '0')}`,
      title: `topic ${index}`,
      lastActiveAt: new Date(NOW_MS - index * 60_000).toISOString(),
    }))
    await seedProject(repoPath, topics)
    const registry = tools(fakeDeps())

    const master = await registry.get('cowork_topic_list').execute({}, fakeExec('session-master', repoPath))
    assert.equal(master.ok, true)
    assert.equal(master.total, TOPIC_LIST_LIMIT + 1)
    assert.equal(master.truncated, true)
    assert.equal(master.topics.length, TOPIC_LIST_LIMIT)
    assert.equal(master.topics[0].topicId, 'session-000', 'newest lastActiveAt first')
    assert.deepEqual(master.topics[0].ownedPaths, [])

    const alias = await registry.get('cowork_thread_list').execute({}, fakeExec('session-master', repoPath))
    assert.deepEqual(alias, master, 'the deprecated alias returns the same payload')

    const thread = await registry.get('cowork_topic_list').execute({}, fakeExec('session-001', repoPath))
    assert.equal(thread.ok, true)

    const stranger = await registry.get('cowork_topic_list').execute({}, fakeExec('session-stranger', repoPath))
    assert.equal(stranger.ok, false)
    assert.equal(stranger.error.code, ERROR_CODES.roleForbidden)
  })
})

test('cowork_topic_resolve is idempotent and records one status change', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic({ topicId: 'session-thread' })])
    const registry = tools(fakeDeps())
    const resolve = registry.get('cowork_topic_resolve')

    const first = await resolve.execute({ topicId: 'session-thread' }, fakeExec('session-master', repoPath))
    assert.equal(first.ok, true)
    assert.equal(first.alreadyResolved, false)
    assert.equal(first.topic.status, 'resolved')
    assert.equal(first.topic.resolvedBy, 'user')
    assert.equal(first.topic.resolvedAt, NOW_ISO)

    const afterFirst = await readFile(store.indexFile, 'utf8')
    const activity = await store.readActivity()
    assert.ok(activity.events.some((event) =>
      event.type === 'status-changed' && event.details.to === 'resolved' && event.details.by === 'user'))

    const second = await resolve.execute({ topicId: 'session-thread' }, fakeExec('session-master', repoPath))
    assert.equal(second.ok, true)
    assert.equal(second.alreadyResolved, true)
    assert.equal(await readFile(store.indexFile, 'utf8'), afterFirst, 'an already resolved topic is not rewritten')

    const missing = await resolve.execute({ topicId: 'session-missing' }, fakeExec('session-master', repoPath))
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, TOPIC_ERROR_CODES.topicNotFound)

    const threadCall = await resolve.execute({ topicId: 'session-thread' }, fakeExec('session-thread', repoPath))
    assert.equal(threadCall.ok, false)
    assert.equal(threadCall.error.code, ERROR_CODES.roleForbidden)
  })
})

const HANDOFF_VERIFICATION = [{ command: 'npm test', exitCode: 0, evidence: 'ok' }]

test('cowork_handoff exposes only blocked|done and no longer mentions awaiting_review', () => {
  const handoff = tools(fakeDeps()).get('cowork_handoff')
  assert.deepEqual([...handoff.parameters.properties.status.enum], ['blocked', 'done'])
  assert.match(handoff.description, /blocked or done/)
  assert.equal(/awaiting_review/.test(handoff.description), false)
})

test('cowork_handoff(done) records the summary and delivery confirmation without prompting the master', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [
      topic({
        topicId: 'session-thread',
        status: 'idle',
        blocked: true,
        awaitingReview: true,
        digest: 'old summary',
        lastActiveAt: new Date(NOW_MS - 4 * 60 * 60 * 1000).toISOString(),
      }),
    ])
    const deps = fakeDeps()
    const registry = tools(deps)

    const result = await registry.get('cowork_handoff').execute({
      status: 'done',
      summary: 'x'.repeat(250),
      verification: HANDOFF_VERIFICATION,
    }, fakeExec('session-thread', repoPath))

    assert.equal(result.ok, true)
    assert.equal(result.status, 'done')
    assert.equal(result.delivery, null, 'done does not notify the master')
    assert.equal(result.topic.status, 'active', 'noteTopicActivity returns the idle topic to active')
    assert.equal(result.topic.blocked, false)
    assert.equal(result.topic.awaitingReview, false)
    assert.equal(result.topic.digest.length, 200)
    assert.notEqual(result.topic.status, 'resolved', 'done is not a resolved topic')

    const document = await store.readIndexDocument()
    assert.equal(document.topics[0].status, 'active')
    assert.equal(document.topics[0].digest.length, 200)
    assert.equal(document.topics[0].lastDeliveryConfirmedAt, NOW_ISO, 'done confirms the delivery time')

    assert.equal(deps.promptCalls.length, 0, 'the handoff text is no longer prompted into the master turn')

    const files = await store.listHandoffs()
    assert.equal(files.length, 1)
    assert.equal(files[0].record.status, 'done')
    assert.equal(files[0].record.deliveredAt, null, 'the file is audit-only in M10, not a delivery ledger')
  })
})

test('cowork_handoff(blocked) sets the flag and wakes the master through one bounded inbox item', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic({ topicId: 'session-thread', status: 'idle' })])
    const deps = fakeDeps()
    const registry = tools(deps)
    const handoff = registry.get('cowork_handoff')

    const blocked = await handoff.execute({
      status: 'blocked',
      summary: 'waiting for input',
      verification: HANDOFF_VERIFICATION,
    }, fakeExec('session-thread', repoPath))

    assert.equal(blocked.ok, true)
    assert.equal(blocked.status, 'blocked')
    assert.deepEqual(blocked.delivery, { delivered: 1, failed: 0 })
    assert.equal(blocked.topic.status, 'active')
    assert.equal(blocked.topic.blocked, true)
    assert.equal(blocked.topic.awaitingReview, false)

    const inbox = await store.readInbox()
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0].kind, 'blocked')
    assert.equal(inbox[0].topicId, 'session-thread')
    assert.equal(inbox[0].summary, 'topic session-thread blocked: waiting for input')
    assert.equal(inbox[0].deliveredAt, NOW_ISO)

    assert.equal(deps.promptCalls.length, 1)
    assert.equal(deps.promptCalls[0].sessionId, 'session-master')
    assert.match(promptText(deps.promptCalls[0]), /\[blocked\] topic session-thread blocked: waiting for input/)

    // The tool boundary itself now rejects the old review status before any write.
    await assert.rejects(
      handoff.execute({
        status: 'awaiting_review',
        summary: 'please review',
        verification: HANDOFF_VERIFICATION,
      }, fakeExec('session-thread', repoPath)),
      /must be one of \["blocked","done"\]/,
    )
    assert.equal((await store.listHandoffs()).length, 1)
  })
})

test('a blocked handoff bounds the inbox summary', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic({ topicId: 'session-thread' })])
    const deps = fakeDeps()

    const result = await tools(deps).get('cowork_handoff').execute({
      status: 'blocked',
      summary: 'y'.repeat(5000),
      verification: HANDOFF_VERIFICATION,
    }, fakeExec('session-thread', repoPath))

    assert.equal(result.ok, true)
    const inbox = await store.readInbox()
    assert.equal(inbox.length, 1)
    assert.ok(
      inbox[0].summary.length <= INBOX_SUMMARY_MAX_CHARS,
      `inbox summary is ${inbox[0].summary.length} characters`,
    )
    assert.match(inbox[0].summary, /^topic session-thread blocked: /)
  })
})

test('cowork_handoff refuses the master; a failed blocked delivery stays replayable and does not fail the handoff', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic({ topicId: 'session-thread' })])
    const deps = fakeDeps()
    deps.promptAccepted = false
    const handoff = tools(deps).get('cowork_handoff')

    const master = await handoff.execute({
      status: 'done',
      summary: 'master call',
      verification: HANDOFF_VERIFICATION,
    }, fakeExec('session-master', repoPath))
    assert.equal(master.ok, false)
    assert.equal(master.error.code, ERROR_CODES.roleForbidden)

    const failed = await handoff.execute({
      status: 'blocked',
      summary: 'not delivered',
      verification: HANDOFF_VERIFICATION,
    }, fakeExec('session-thread', repoPath))
    assert.equal(failed.ok, true, 'a delivery failure must not fail the handoff')
    assert.equal(failed.topic.blocked, true)
    assert.equal(failed.delivery.delivered, 0)
    assert.equal(failed.delivery.failed, 1)
    assert.match(failed.delivery.error, /did not accept/)

    const inbox = await store.readInbox()
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0].deliveredAt, null, 'the undelivered item stays for the next pass')

    const files = await store.listHandoffs()
    assert.equal(files.length, 1)
    assert.equal(files[0].record.deliveredAt, null, 'the audit file is not a delivery ledger')
  })
})

test('deliverInbox reports an InboxMarkError as a value and never throws', async () => {
  const item = {
    id: 'item-1',
    time: NOW_ISO,
    topicId: 'session-thread',
    kind: 'blocked',
    summary: 'pending',
    deliveredAt: null,
  }
  let writes = 0
  const store = {
    async readInbox() { return [item] },
    async writeInbox(items) {
      writes += 1
      if (writes > 1) throw new Error('inbox is read-only')
      return items
    },
  }

  const outcome = await deliverInbox({
    store,
    events: [{ topicId: 'session-thread', kind: 'blocked', summary: 'new event' }],
    deliver: async () => {},
    clock: () => new Date(NOW_ISO),
  })

  assert.equal(outcome.delivered, 0)
  assert.equal(outcome.failed, 1)
  assert.match(outcome.error, /could not be marked delivered/)
})
