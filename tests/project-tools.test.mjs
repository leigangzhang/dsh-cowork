import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { readFileSync } from 'node:fs'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * M9.3a contract tests for the bounded `cowork_project_status` read point.
 *
 * `src/tools.ts` value-imports its siblings as `./x.js`, which Node's type
 * stripping does not retry as `.ts`, so this file installs the same resolve hook
 * `tests/tools-init.test.mjs` uses. The tool registry and host ports are
 * recording fakes; the project store is the real one under `os.tmpdir()`.
 *
 * The cases pin the M9.3a rules: the payload is bounded, the lifecycle read
 * point evaluates lazily inside the lock and writes nothing when nothing
 * changed, inbox delivery is replayed once, and a non-master/non-thread session
 * is refused.
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
const { Inbox } = await import('../src/inbox.ts')
const { STATUS_ACTIVITY_LIMIT, STATUS_INBOX_LIMIT, STATUS_TOPIC_LIMIT } = await import('../src/project-tools.ts')
const { ERROR_CODES } = await import('../src/tool-model.ts')

const NOW_ISO = '2026-11-07T10:00:00.000Z'
const NOW_MS = Date.parse(NOW_ISO)
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const iso = (ms) => new Date(ms).toISOString()

/** A tool registry that keeps every definition the assembly registers. */
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

/** The structured execution identity one tool call receives. */
function fakeExec(sessionId, cwd) {
  return { agent: { id: sessionId, session: { header: { cwd } } } }
}

/** Recording host ports: only the prompt port matters for status. */
function fakeDeps() {
  const promptCalls = []
  return {
    promptCalls,
    sessionController: {
      async create() { return { sessionId: 'session-created', agentPreset: 'cowork-topic' } },
      async rename({ title }) { return { title, seq: 1 } },
      async prompt(request) {
        promptCalls.push(request)
        return { accepted: true }
      },
      async list() { return { items: [] } },
      async inspect(sessionId) { return { meta: { id: sessionId } } },
    },
    workspaceRegistry: {
      async resolveByPath(path) { return { id: 'workspace-1', path } },
      async create(path) { return { id: 'workspace-1', path } },
      async delete() { return true },
      async archiveSession() {},
    },
    agentPresets: {},
    clock: () => new Date(NOW_ISO),
    idleAfterMs: 2 * HOUR_MS,
    resolveAfterMs: 3 * DAY_MS,
  }
}

async function withRepo(run) {
  const repoPath = await mkdtemp(join(tmpdir(), 'dsh-cowork-project-tools-'))
  try {
    return await run(repoPath)
  } finally {
    await rm(repoPath, { recursive: true, force: true })
  }
}

/** One valid v2 topic; `cwd` is filled by `seedProject`. */
const topic = (overrides = {}) => ({
  topicId: 'topic-a',
  title: 'topic a',
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

/** One v2 work-item record belonging to `topicId`. */
const workItem = (workItemId, topicId, status) => ({
  workItemId,
  topicId,
  path: `/repo/.dsh-cowork/workitems/${workItemId}`,
  branch: `cowork/${workItemId}`,
  baseCommit: 'a'.repeat(40),
  headCommit: 'b'.repeat(40),
  status,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
})

/** A real project store with the given v2 topics/work items and `session-master` as master. */
async function seedProject(repoPath, topics, workItems = []) {
  const store = new ProjectStore({ repoPath, clock: () => new Date(NOW_ISO), projectId: 'p' })
  await store.initIndex('session-master')
  if (topics.length > 0 || workItems.length > 0) {
    await store.mutateIndexDocument((document) => ({
      ...document,
      topics: topics.map((entry) => ({ ...entry, cwd: repoPath })),
      workItems: [...document.workItems, ...workItems],
    }))
  }
  return store
}

/** Register the assembly and return the status tool. */
function statusTool(deps) {
  const host = fakeHost()
  registerCoworkTools(host, deps)
  const tool = host.registry.get('cowork_project_status')
  assert.ok(tool, 'the assembly must register cowork_project_status')
  return tool
}

/** Register the assembly and return the init tool. */
function initTool(deps) {
  const host = fakeHost()
  registerCoworkTools(host, deps)
  const tool = host.registry.get('cowork_project_init')
  assert.ok(tool, 'the assembly must register cowork_project_init')
  return tool
}

/** A valid activity event for the store's append port. */
const activityEvent = (id, overrides = {}) => ({
  eventId: `event-${id}`,
  time: NOW_ISO,
  type: 'error',
  topicId: null,
  summary: `event ${id}`,
  details: {},
  ...overrides,
})

/** Undelivered inbox events for one topic. */
const inboxEvents = (count) =>
  Array.from({ length: count }, (_, index) => ({
    topicId: 'session-master',
    kind: 'blocked',
    summary: `inbox ${index}`,
  }))

test('the assembly registers the fifteen tools in the documented order', () => {
  const host = fakeHost()
  registerCoworkTools(host, fakeDeps())
  assert.deepEqual([...host.registry.keys()], [
    'cowork_project_init',
    'cowork_project_status',
    'cowork_route',
    'cowork_topic_create',
    'cowork_thread_create',
    'cowork_topic_list',
    'cowork_thread_list',
    'cowork_handoff',
    'cowork_topic_resolve',
    'cowork_work_item_create',
    'cowork_review_request',
    'cowork_review_verdict',
    'cowork_memory_write',
    'cowork_memory_search',
    'cowork_checkout_merge',
  ])
})

test('project_status bounds 60 topics, counts flags, and truncates a long digest', async () => {
  await withRepo(async (repoPath) => {
    const topics = Array.from({ length: 60 }, (_, index) => topic({
      topicId: `topic-${String(index).padStart(2, '0')}`,
      title: `topic ${index}`,
      status: index === 58 ? 'idle' : index === 59 ? 'resolved' : 'active',
      lastActiveAt: index === 58 ? iso(NOW_MS - 3 * HOUR_MS) : iso(NOW_MS - index * 60_000),
      blocked: index === 1,
      awaitingReview: index === 2,
      digest: index === 0 ? 'd'.repeat(250) : `digest ${index}`,
      ...(index === 59 ? { resolvedAt: iso(NOW_MS - DAY_MS), resolvedBy: 'master' } : {}),
    }))
    await seedProject(repoPath, topics)

    const result = await statusTool(fakeDeps()).execute({}, fakeExec('session-master', repoPath))

    assert.equal(result.ok, true)
    assert.equal(result.counts.total, 60)
    assert.deepEqual(result.counts, {
      total: 60,
      active: 58,
      idle: 1,
      resolved: 1,
      blocked: 1,
      awaitingReview: 1,
    })
    assert.equal(result.topics.length, STATUS_TOPIC_LIMIT)
    assert.equal(result.topics[0].topicId, 'topic-00', 'newest lastActiveAt first')
    assert.equal(result.topics[0].digest.length, 200, 'the digest is cut to 200 characters')
    assert.equal(result.truncated, true)
    assert.equal(result.lifecycle.evaluated, 60)
    assert.deepEqual(result.lifecycle.changes, [], 'the seeded states are already current')

    for (const field of ['threads', 'checkouts', 'latestReviews', 'pendingHandoffs', 'handoffReplay']) {
      assert.equal(field in result, false, `the bounded payload must not return ${field}`)
    }
  })
})

test('project_status returns the activity tail of twenty events and skipped lines', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    for (let index = 0; index < STATUS_ACTIVITY_LIMIT + 1; index += 1) {
      await store.appendActivity(activityEvent(index))
    }
    await appendFile(store.activityFile, 'not-json\n', 'utf8')

    const result = await statusTool(fakeDeps()).execute({}, fakeExec('session-master', repoPath))

    assert.equal(result.activity.events.length, STATUS_ACTIVITY_LIMIT)
    assert.equal(result.activity.events[0].eventId, 'event-1', 'the oldest event is the one dropped')
    assert.equal(result.activity.events.at(-1).eventId, `event-${STATUS_ACTIVITY_LIMIT}`)
    assert.equal(result.activity.skippedLines, 1)
    assert.equal(result.truncated, true, 'a longer activity stream marks the response truncated')
  })
})

test('project_status replays undelivered inbox items once and stamps deliveredAt', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [])
    const seeder = new Inbox({ store, clock: () => new Date(NOW_ISO), deliver: async () => {} })
    await seeder.enqueue(inboxEvents(12))

    const deps = fakeDeps()
    const result = await statusTool(deps).execute({}, fakeExec('session-master', repoPath))

    assert.equal(result.ok, true)
    assert.equal(result.inbox.pendingTotal, 12)
    assert.equal(result.inbox.items.length, STATUS_INBOX_LIMIT)
    assert.equal(result.inbox.items[0].summary, 'inbox 0')
    assert.equal(result.truncated, true, 'more than ten pending items is truncated')
    assert.deepEqual(result.inboxReplay, { delivered: 12, failed: 0 })
    assert.equal(deps.promptCalls.length, 3, 'delivery merges at most five items per message')
    assert.equal(deps.promptCalls[0].sessionId, 'session-master')

    const stored = await store.readInbox()
    assert.deepEqual(
      stored.map((item) => item.deliveredAt),
      Array.from({ length: 12 }, () => NOW_ISO),
      'every delivered item is marked in the file',
    )
  })
})

test('project_status lazily marks a three-hour silent topic idle and does not rewrite on no change', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [
      topic({ topicId: 'topic-idle', lastActiveAt: iso(NOW_MS - 3 * HOUR_MS) }),
    ])
    const before = await readFile(store.indexFile, 'utf8')
    const tool = statusTool(fakeDeps())

    const first = await tool.execute({}, fakeExec('session-master', repoPath))
    assert.equal(first.ok, true)
    assert.deepEqual(first.lifecycle.changes, [{ topicId: 'topic-idle', from: 'active', to: 'idle' }])
    assert.equal(first.topics[0].status, 'idle')
    assert.equal(first.counts.idle, 1)
    assert.ok(
      first.activity.events.some((event) => event.type === 'status-changed' && event.topicId === 'topic-idle'),
      'the transition records one status-changed event',
    )

    const afterFirst = await readFile(store.indexFile, 'utf8')
    assert.notEqual(afterFirst, before, 'the first read point writes the transition')

    const second = await tool.execute({}, fakeExec('session-master', repoPath))
    assert.deepEqual(second.lifecycle.changes, [], 'a settled project has nothing to change')
    const afterSecond = await readFile(store.indexFile, 'utf8')
    assert.equal(afterSecond, afterFirst, 'no change means no write at all')
  })
})

test('project_status resolves a three-day silent topic that meets every condition', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [
      topic({
        topicId: 'topic-resolved',
        lastActiveAt: iso(NOW_MS - 3 * DAY_MS - HOUR_MS),
        lastDeliveryConfirmedAt: iso(NOW_MS - 3 * DAY_MS - HOUR_MS),
        digest: 'delivered work',
      }),
    ])

    const result = await statusTool(fakeDeps()).execute({}, fakeExec('session-master', repoPath))

    assert.equal(result.ok, true)
    assert.deepEqual(result.lifecycle.changes, [
      { topicId: 'topic-resolved', from: 'active', to: 'resolved' },
    ])
    assert.equal(result.topics[0].status, 'resolved')
    assert.equal(result.topics[0].resolvedBy, 'master')
    assert.equal(result.topics[0].resolvedAt, NOW_ISO)
    assert.equal(result.counts.resolved, 1)
  })
})

test('project_status refuses a session that is neither master nor a thread', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [topic({ topicId: 'session-thread' })])
    const tool = statusTool(fakeDeps())

    const denied = await tool.execute({}, fakeExec('session-stranger', repoPath))
    assert.equal(denied.ok, false)
    assert.equal(denied.error.code, ERROR_CODES.roleForbidden)

    const allowed = await tool.execute({}, fakeExec('session-thread', repoPath))
    assert.equal(allowed.ok, true, 'a thread may read the bounded status')
  })
})

test('project_status reports work-item and review counts and no handoff replay', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(
      repoPath,
      [
        topic({ topicId: 'topic-a' }),
        topic({
          topicId: 'topic-b',
          awaitingReview: true,
          reviewStatus: 'pending',
          latestReviewRequestId: 'request-1',
          reviewerSessionId: 'reviewer-1',
        }),
      ],
      [
        workItem('wi-1', 'topic-a', 'active'),
        workItem('wi-2', 'topic-a', 'reviewing'),
        workItem('wi-3', 'topic-b', 'merged'),
        workItem('wi-4', 'topic-b', 'abandoned'),
      ],
    )

    const result = await statusTool(fakeDeps()).execute({}, fakeExec('session-master', repoPath))

    assert.equal(result.ok, true)
    assert.deepEqual(result.workItems, { total: 4, active: 1, reviewing: 1, merged: 1, abandoned: 1 })
    assert.deepEqual(result.reviews, { pending: 1 })
    assert.equal('handoffReplay' in result, false, 'the M9 handoff replay window is gone')

    const byId = new Map(result.topics.map((row) => [row.topicId, row]))
    assert.equal(byId.get('topic-a').activeWorkItems, 2, 'active + reviewing both count as in flight')
    assert.equal(byId.get('topic-a').reviewsPending, 0)
    assert.equal(byId.get('topic-b').activeWorkItems, 0, 'merged/abandoned do not count')
    assert.equal(byId.get('topic-b').reviewsPending, 1)
  })
})

test('project_status keeps a topic with active or reviewing work items from resolving (KI-24)', async () => {
  for (const status of ['active', 'reviewing']) {
    await withRepo(async (repoPath) => {
      await seedProject(
        repoPath,
        [
          topic({
            topicId: 'topic-busy',
            lastActiveAt: iso(NOW_MS - 4 * DAY_MS),
            lastDeliveryConfirmedAt: iso(NOW_MS - 4 * DAY_MS),
            digest: 'delivered work',
          }),
        ],
        [workItem('wi-busy', 'topic-busy', status)],
      )

      const result = await statusTool(fakeDeps()).execute({}, fakeExec('session-master', repoPath))

      assert.equal(result.ok, true)
      assert.equal(result.counts.resolved, 0, `${status} work item must block auto-resolution`)
      assert.equal(result.topics[0].status, 'idle', 'it may still go idle')
      assert.deepEqual(
        result.lifecycle.changes.filter((change) => change.to === 'resolved'),
        [],
      )
    })
  }
})

test('project_init no longer reconciles a stale handoff into the index', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic({ topicId: 'topic-stale' })])
    await store.writeHandoff({
      version: 1,
      threadId: 'topic-stale',
      masterSessionId: 'session-master',
      status: 'blocked',
      subject: 'topic stale',
      summary: 'an old handoff file',
      decisions: [],
      changedPaths: [],
      artifacts: [],
      verification: [{ command: 'true', exitCode: 0, evidence: '' }],
      openIssues: [],
      nextStep: null,
      createdAt: NOW_ISO,
      deliveredAt: null,
    })

    const result = await initTool(fakeDeps()).execute({}, fakeExec('session-master', repoPath))
    assert.equal(result.ok, true)

    const document = await store.readIndexDocument()
    assert.equal(document.topics[0].blocked, false, 'the old handoff file stays read-only')
    assert.equal(document.topics[0].awaitingReview, false)
  })
})

test('the compatibility replay and the fixed work-item count are gone from the sources', () => {
  const projectSource = readFileSync(new URL('../src/project-tools.ts', import.meta.url), 'utf8')
  const routeSource = readFileSync(new URL('../src/route-tools.ts', import.meta.url), 'utf8')
  const runtimeSource = readFileSync(new URL('../src/tool-runtime.ts', import.meta.url), 'utf8')

  assert.equal(/reconcileIndex|replayPendingHandoffs|handoffReplay/.test(projectSource), false)
  assert.equal(/export async function reconcileIndex/.test(runtimeSource), false)
  assert.equal(/activeWorkItems: 0/.test(runtimeSource), false)
  assert.equal(/activeWorkItems\?: number/.test(runtimeSource), false)
  assert.match(projectSource, /activeWorkItemsOf/)
  assert.match(routeSource, /activeWorkItemsOf/)
})
