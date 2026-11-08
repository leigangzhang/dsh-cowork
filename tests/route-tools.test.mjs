import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * M9.3b contract tests for `cowork_route`: the three layers wired to the
 * canonical v2 index, the read point, the model fallback, the bounded payload
 * and activity rows, and the correction write path M11 will call.
 *
 * The host ports and the LLM port are deterministic fakes; the project store is
 * the real one under `os.tmpdir()`. The structured router itself is covered by
 * `tests/routing.test.mjs` and the model module by `tests/router-model.test.mjs`;
 * these cases prove the wiring between them.
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
const { applyRouteCorrectionToStore } = await import('../src/route-tools.ts')
const { ERROR_CODES, TOPIC_ERROR_CODES } = await import('../src/tool-model.ts')

const NOW_ISO = '2026-11-07T10:00:00.000Z'
const NOW_MS = Date.parse(NOW_ISO)
const STALE_ISO = '2026-10-01T00:00:00.000Z'
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

const ROUTING = {
  enabled: true,
  provider: 'fake-provider',
  model: 'fake-model',
  effort: 'off',
  timeoutMs: 2000,
  maxTokens: 256,
}

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

/** Recording host ports; the LLM port is injected per test. */
function fakeDeps(overrides = {}) {
  const createCalls = []
  const promptCalls = []
  let created = 0
  const deps = {
    createCalls,
    promptCalls,
    sessionController: {
      async create(options) {
        createCalls.push(options)
        created += 1
        return { sessionId: `session-created-${created}`, workspaceId: 'workspace-1', agentPreset: options.agentPreset }
      },
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
    routing: { ...ROUTING },
    ...overrides,
  }
  return deps
}

/** A deterministic LLM port that records every request. */
function llmPort(handler) {
  const calls = []
  return {
    calls,
    async run(request, signal) {
      calls.push(request)
      return handler(request, calls.length, signal)
    },
  }
}

async function withRepo(run) {
  const repoPath = await mkdtemp(join(tmpdir(), 'dsh-cowork-route-tools-'))
  try {
    return await run(repoPath)
  } finally {
    await rm(repoPath, { recursive: true, force: true })
  }
}

const topic = (overrides = {}) => ({
  topicId: 'session-a',
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
  createdAt: STALE_ISO,
  updatedAt: STALE_ISO,
  lastActiveAt: NOW_ISO,
  lastDeliveryConfirmedAt: null,
  resolvedAt: null,
  resolvedBy: null,
  latestReviewRequestId: null,
  reviewStatus: null,
  reviewerSessionId: null,
  ...overrides,
})

async function seedProject(repoPath, topics, overrides = {}) {
  const store = new ProjectStore({ repoPath, clock: () => new Date(NOW_ISO), projectId: 'p' })
  await store.initIndex('session-master')
  await store.mutateIndexDocument((document) => ({
    ...document,
    ...overrides,
    topics: topics.map((entry) => ({ ...entry, cwd: repoPath })),
  }))
  return store
}

function routeTool(deps) {
  const host = fakeHost()
  registerCoworkTools(host, deps)
  const tool = host.registry.get('cowork_route')
  assert.ok(tool, 'the assembly must register cowork_route')
  return tool
}

const promptText = (call) => call.content[0].text

test('layer 1 reuses the focus topic and never calls the model', async () => {
  await withRepo(async (repoPath) => {
    const port = llmPort(() => '{"topicId":null,"confidence":0.1}')
    await seedProject(repoPath, [topic({ topicId: 'session-focus', title: 'focus topic' })], {
      masterFocusTopicId: 'session-focus',
    })
    const deps = fakeDeps({ llmRoutingPort: port })
    const result = await routeTool(deps).execute({ intent: '继续' }, fakeExec('session-master', repoPath))

    assert.equal(result.ok, true)
    assert.equal(result.action, 'reuse')
    assert.equal(result.topicId, 'session-focus')
    assert.equal(result.modelUsed, false)
    assert.equal(port.calls.length, 0, 'the first layer must not touch the model')
    assert.equal(deps.promptCalls.length, 1)
    assert.equal(deps.promptCalls[0].sessionId, 'session-focus')
    assert.equal(promptText(deps.promptCalls[0]), '继续')

    const store = new ProjectStore({ repoPath, clock: () => new Date(NOW_ISO) })
    const document = await store.readIndexDocument()
    assert.equal(document.lastRouteTopicId, 'session-focus')
    const activity = await store.readActivity()
    assert.ok(activity.events.some((event) => event.type === 'route-reused' && event.topicId === 'session-focus'))
  })
})

test('layer 1 falls back to the last route target and appends a brief to the prompt', async () => {
  await withRepo(async (repoPath) => {
    const port = llmPort(() => '{"topicId":null,"confidence":0.1}')
    await seedProject(repoPath, [topic({ topicId: 'session-last', title: 'last topic' })], {
      lastRouteTopicId: 'session-last',
    })
    const deps = fakeDeps({ llmRoutingPort: port })
    const result = await routeTool(deps).execute({ intent: '继续', brief: '加个边界测试' }, fakeExec('session-master', repoPath))

    assert.equal(result.action, 'reuse')
    assert.equal(result.topicId, 'session-last')
    assert.equal(port.calls.length, 0)
    assert.equal(promptText(deps.promptCalls[0]), '继续\n\n加个边界测试')
  })
})

test('layer 2 reuses a clear structured winner', async () => {
  await withRepo(async (repoPath) => {
    const port = llmPort(() => '{"topicId":null,"confidence":0.1}')
    await seedProject(repoPath, [topic({ topicId: 'session-a', title: '修复路由' })])
    const deps = fakeDeps({ llmRoutingPort: port })
    const result = await routeTool(deps).execute({ intent: '修复路由' }, fakeExec('session-master', repoPath))

    assert.equal(result.action, 'reuse')
    assert.equal(result.topicId, 'session-a')
    assert.match(result.reason, /^layer2:/)
    assert.equal(result.candidates[0].score, 6)
    assert.ok(result.candidates[0].reasons.some((reason) => reason.startsWith('title-overlap:')))
    assert.equal(port.calls.length, 0)
  })
})

test('a no-hit route creates a topic with the cowork-topic preset and both activities', async () => {
  await withRepo(async (repoPath) => {
    const port = llmPort(() => '{"topicId":null,"confidence":0.1}')
    await seedProject(repoPath, [topic({ topicId: 'session-a', title: 'unrelated english subject' })])
    const deps = fakeDeps({ llmRoutingPort: port })
    const result = await routeTool(deps).execute({
      intent: '写一个全新的部署脚本 alpha',
    }, fakeExec('session-master', repoPath))

    assert.equal(result.action, 'create')
    assert.equal(port.calls.length, 0)
    assert.ok(Array.from(result.title).length <= 24)
    assert.equal(deps.createCalls.length, 1)
    assert.equal(deps.createCalls[0].agentPreset, 'cowork-topic')
    assert.equal(deps.promptCalls.length, 1)
    assert.equal(deps.promptCalls[0].sessionId, result.topicId)
    assert.match(promptText(deps.promptCalls[0]), /写一个全新的部署脚本 alpha/)
    assert.ok(promptText(deps.promptCalls[0]).length <= 2000)

    const store = new ProjectStore({ repoPath, clock: () => new Date(NOW_ISO) })
    const document = await store.readIndexDocument()
    assert.equal(document.lastRouteTopicId, result.topicId)
    assert.ok(document.topics.some((entry) => entry.topicId === result.topicId))
    const activity = await store.readActivity()
    const types = activity.events.map((event) => event.type)
    assert.ok(types.includes('topic-created'))
    assert.ok(types.includes('route-created'))
  })
})

test('needs_model sends at most three candidates and reuses the model choice', async () => {
  await withRepo(async (repoPath) => {
    const port = llmPort(() => '{"topicId":"session-b","confidence":0.9}')
    await seedProject(repoPath, [
      topic({ topicId: 'session-c', title: 'alpha beta' }),
      topic({ topicId: 'session-a', title: 'alpha beta' }),
      topic({ topicId: 'session-b', title: 'alpha beta' }),
      topic({ topicId: 'session-d', title: 'alpha beta' }),
      topic({ topicId: 'session-e', title: 'alpha beta' }),
    ])
    const deps = fakeDeps({ llmRoutingPort: port })
    const result = await routeTool(deps).execute({ intent: 'alpha beta' }, fakeExec('session-master', repoPath))

    assert.equal(port.calls.length, 1)
    const candidateLines = port.calls[0].userPrompt.split('\n').filter((line) => line.startsWith('- topicId:'))
    assert.ok(candidateLines.length <= 3, `the model received ${candidateLines.length} candidates`)
    assert.equal(result.action, 'reuse')
    assert.equal(result.topicId, 'session-b')
    assert.equal(result.modelUsed, true)
    assert.equal(result.prompted, true)
    assert.equal(result.candidates.length, 3, 'the payload is bounded to three candidates')
  })
})

test('a model choice of null creates a new topic', async () => {
  await withRepo(async (repoPath) => {
    const port = llmPort(() => '{"topicId":null,"confidence":0.6}')
    await seedProject(repoPath, [
      topic({ topicId: 'session-a', title: 'alpha beta' }),
      topic({ topicId: 'session-b', title: 'alpha beta' }),
    ])
    const deps = fakeDeps({ llmRoutingPort: port })
    const result = await routeTool(deps).execute({ intent: 'alpha beta' }, fakeExec('session-master', repoPath))

    assert.equal(result.action, 'create')
    assert.equal(result.modelUsed, true)
    assert.equal(result.topicId, 'session-created-1')
  })
})

test('a failing model port falls back to the highest structured candidate', async () => {
  await withRepo(async (repoPath) => {
    const port = llmPort(() => { throw new Error('provider offline') })
    await seedProject(repoPath, [
      topic({ topicId: 'session-a', title: 'alpha beta' }),
      topic({ topicId: 'session-b', title: 'alpha beta' }),
    ])
    const deps = fakeDeps({ llmRoutingPort: port })
    const result = await routeTool(deps).execute({ intent: 'alpha beta' }, fakeExec('session-master', repoPath))

    assert.equal(port.calls.length, 1)
    assert.equal(result.action, 'reuse')
    assert.equal(result.topicId, 'session-a', 'the deterministic tie-break is the fallback target')
    assert.equal(result.modelUsed, false)
    assert.match(result.modelError, /port-error/)
  })
})

test('routing.enabled=false keeps the port untouched and uses the fallback', async () => {
  await withRepo(async (repoPath) => {
    const port = llmPort(() => '{"topicId":null,"confidence":0.1}')
    await seedProject(repoPath, [
      topic({ topicId: 'session-a', title: 'alpha beta' }),
      topic({ topicId: 'session-b', title: 'alpha beta' }),
    ])
    const deps = fakeDeps({
      llmRoutingPort: port,
      routing: { ...ROUTING, enabled: false },
    })
    const result = await routeTool(deps).execute({ intent: 'alpha beta' }, fakeExec('session-master', repoPath))

    assert.equal(port.calls.length, 0)
    assert.equal(result.action, 'reuse')
    assert.equal(result.topicId, 'session-a')
    assert.equal(result.modelUsed, false)
    assert.match(result.modelError, /disabled/)
  })
})

test('an unconfigured model falls back without touching the port', async () => {
  await withRepo(async (repoPath) => {
    const port = llmPort(() => '{"topicId":null,"confidence":0.1}')
    await seedProject(repoPath, [
      topic({ topicId: 'session-a', title: 'alpha beta' }),
      topic({ topicId: 'session-b', title: 'alpha beta' }),
    ])
    const deps = fakeDeps({
      llmRoutingPort: port,
      routing: { ...ROUTING, provider: '', model: '' },
    })
    const result = await routeTool(deps).execute({ intent: 'alpha beta' }, fakeExec('session-master', repoPath))

    assert.equal(port.calls.length, 0)
    assert.equal(result.action, 'reuse')
    assert.equal(result.topicId, 'session-a')
    assert.equal(result.modelUsed, false)
    assert.match(result.modelError, /unconfigured/)
  })
})

test('a blank provider/model is filled from the host default model route', async () => {
  await withRepo(async (repoPath) => {
    const port = llmPort(() => '{"topicId":"session-b","confidence":0.8}')
    await seedProject(repoPath, [
      topic({ topicId: 'session-a', title: 'alpha beta' }),
      topic({ topicId: 'session-b', title: 'alpha beta' }),
    ])
    const deps = fakeDeps({
      llmRoutingPort: port,
      routing: { ...ROUTING, provider: '', model: '' },
      currentModelRoute: () => ({ provider: 'host-provider', model: 'host-model' }),
    })
    const result = await routeTool(deps).execute({ intent: 'alpha beta' }, fakeExec('session-master', repoPath))

    assert.equal(port.calls.length, 1)
    assert.equal(port.calls[0].provider, 'host-provider')
    assert.equal(port.calls[0].model, 'host-model')
    assert.equal(result.topicId, 'session-b')
    assert.equal(result.modelUsed, true)
  })
})

test('an explicit resolved topic returns resolved_match and never prompts the old topic', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [
      topic({
        topicId: 'session-old',
        title: 'old resolved topic',
        status: 'resolved',
        resolvedAt: '2026-10-02T00:00:00.000Z',
        resolvedBy: 'master',
      }),
    ])
    const deps = fakeDeps()
    const result = await routeTool(deps).execute({
      intent: '继续旧主题的工作',
      topicId: 'session-old',
    }, fakeExec('session-master', repoPath))

    assert.equal(result.action, 'resolved_match')
    assert.deepEqual(result.resolvedMatch, { topicId: 'session-old', title: 'old resolved topic' })
    assert.notEqual(result.topicId, 'session-old')
    assert.equal(deps.promptCalls.length, 1)
    assert.equal(deps.promptCalls[0].sessionId, result.topicId)
    assert.ok(deps.promptCalls.every((call) => call.sessionId !== 'session-old'))
  })
})

test('an explicit missing topic, an over-long brief, and forceCreate+topicId fail closed', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [topic({ topicId: 'session-a' })])
    const deps = fakeDeps()
    const route = routeTool(deps)

    const missing = await route.execute({ intent: 'x', topicId: 'session-missing' }, fakeExec('session-master', repoPath))
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, TOPIC_ERROR_CODES.topicNotFound)

    const longBrief = await route.execute({ intent: 'x', brief: 'y'.repeat(2001) }, fakeExec('session-master', repoPath))
    assert.equal(longBrief.ok, false)
    assert.equal(longBrief.error.code, TOPIC_ERROR_CODES.routeBriefTooLong)

    const conflict = await route.execute({
      intent: 'x',
      forceCreate: true,
      topicId: 'session-a',
    }, fakeExec('session-master', repoPath))
    assert.equal(conflict.ok, false)
    assert.equal(conflict.error.code, TOPIC_ERROR_CODES.routeArgsConflict)
  })
})

test('route activity details are bounded and never contain the intent', async () => {
  await withRepo(async (repoPath) => {
    const secretIntent = 'very secret intent that must not be stored'
    await seedProject(repoPath, [topic({ topicId: 'session-a', title: 'secret work' })], {
      masterFocusTopicId: 'session-a',
    })
    const deps = fakeDeps()
    await routeTool(deps).execute({ intent: secretIntent }, fakeExec('session-master', repoPath))

    const store = new ProjectStore({ repoPath, clock: () => new Date(NOW_ISO) })
    const activity = await store.readActivity()
    const routed = activity.events.find((event) => event.type === 'route-reused')
    assert.ok(routed)
    const serialized = JSON.stringify(routed.details)
    assert.equal(serialized.includes(secretIntent), false, 'the intent is not persisted')
    assert.ok(Array.isArray(routed.details.candidates))
    assert.ok(routed.details.candidates.length <= 3)
    assert.equal(routed.details.modelUsed, false)
    assert.equal(routed.details.confidence, null)
  })
})

test('forceCreate skips the locality layers', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [topic({ topicId: 'session-a', title: 'alpha beta' })], {
      masterFocusTopicId: 'session-a',
    })
    const deps = fakeDeps()
    const result = await routeTool(deps).execute({
      intent: 'alpha beta',
      forceCreate: true,
    }, fakeExec('session-master', repoPath))

    assert.equal(result.action, 'create')
    assert.notEqual(result.topicId, 'session-a')
  })
})

test('applyRouteCorrectionToStore writes aliases and one route-corrected activity', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [
      topic({ topicId: 'session-a', title: 'billing', digest: 'invoice work' }),
    ])
    const before = (await store.readIndexDocument()).topics[0]

    const corrected = await applyRouteCorrectionToStore(
      store,
      { topicId: 'session-a', intent: '发票 对账' },
      new Date(NOW_ISO),
    )
    assert.equal(corrected.changed, true)
    assert.ok(corrected.added.length > 0)
    assert.deepEqual(corrected.aliases.slice(0, corrected.added.length), corrected.added)

    const after = (await store.readIndexDocument()).topics[0]
    assert.deepEqual(after.aliases, corrected.aliases)
    assert.deepEqual({ ...after, aliases: before.aliases }, before, 'only aliases change')
    const activity = await store.readActivity()
    const routed = activity.events.filter((event) => event.type === 'route-corrected')
    assert.equal(routed.length, 1)
    assert.equal(routed[0].topicId, 'session-a')

    const indexAfterFirst = await readFile(store.indexFile, 'utf8')
    const again = await applyRouteCorrectionToStore(
      store,
      { topicId: 'session-a', intent: '发票 对账' },
      new Date(NOW_MS + DAY_MS),
    )
    assert.equal(again.changed, false, 'a repeated correction adds nothing')
    assert.equal(await readFile(store.indexFile, 'utf8'), indexAfterFirst)
    const finalActivity = await store.readActivity()
    assert.equal(finalActivity.events.filter((event) => event.type === 'route-corrected').length, 1)
  })
})

test('cowork_route settles a three-hour silent focus topic to idle before reuse (A5 read point)', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [
      topic({
        topicId: 'session-idle',
        title: 'idle focus topic',
        status: 'active',
        lastActiveAt: new Date(NOW_MS - 3 * HOUR_MS).toISOString(),
      }),
    ], { masterFocusTopicId: 'session-idle' })
    const deps = fakeDeps()

    const result = await routeTool(deps).execute({ intent: '继续这个主题' }, fakeExec('session-master', repoPath))

    assert.equal(result.ok, true)
    assert.equal(result.action, 'reuse')
    assert.equal(result.topicId, 'session-idle')

    const store = new ProjectStore({ repoPath, clock: () => new Date(NOW_ISO) })
    const document = await store.readIndexDocument()
    const settled = document.topics.find((entry) => entry.topicId === 'session-idle')
    assert.ok(settled, 'the focus topic is still in the index')
    assert.equal(settled.status, 'idle', 'the read point settles the silent topic before routing')
    assert.equal(settled.updatedAt, NOW_ISO)

    const activity = await store.readActivity()
    const changed = activity.events.find(
      (event) => event.type === 'status-changed' && event.topicId === 'session-idle',
    )
    assert.ok(changed, 'the transition records one status-changed event')
    assert.deepEqual(changed.details, { topicId: 'session-idle', from: 'active', to: 'idle' })
    assert.ok(
      activity.events.some((event) => event.type === 'route-reused' && event.topicId === 'session-idle'),
      'the route still reuses the focus topic after it settled to idle',
    )
  })
})

test('cowork_route resolves a four-day settled topic before force-creating a new one (A5 read point)', async () => {
  await withRepo(async (repoPath) => {
    const settledAt = new Date(NOW_MS - 4 * DAY_MS).toISOString()
    await seedProject(repoPath, [
      topic({
        topicId: 'session-resolved',
        title: 'finished topic',
        status: 'active',
        lastActiveAt: settledAt,
        digest: 'done work',
        lastDeliveryConfirmedAt: settledAt,
      }),
    ])
    const deps = fakeDeps()

    const result = await routeTool(deps).execute({
      intent: '一个全新的任务',
      forceCreate: true,
    }, fakeExec('session-master', repoPath))

    assert.equal(result.ok, true)
    assert.equal(result.action, 'create')
    assert.notEqual(result.topicId, 'session-resolved')

    const store = new ProjectStore({ repoPath, clock: () => new Date(NOW_ISO) })
    const document = await store.readIndexDocument()
    const settled = document.topics.find((entry) => entry.topicId === 'session-resolved')
    assert.ok(settled, 'the settled topic is still in the index')
    assert.equal(settled.status, 'resolved', 'the read point resolves the topic before the route decides')
    assert.equal(settled.resolvedBy, 'master')
    assert.equal(settled.resolvedAt, NOW_ISO)

    const activity = await store.readActivity()
    const changed = activity.events.find(
      (event) => event.type === 'status-changed' && event.topicId === 'session-resolved',
    )
    assert.ok(changed, 'the transition records one status-changed event')
    assert.deepEqual(changed.details, { topicId: 'session-resolved', from: 'active', to: 'resolved' })
  })
})
