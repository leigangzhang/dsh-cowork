/**
 * Behavior tests for the `src/app/apply.ts` assembly.
 *
 * The subject is the wiring, not the modules it wires: a minimal Cordis-like
 * host records what `apply()` registers, hands out the optional host services
 * (`connection`, `llm`, `agentDefaultModel`), and lets a test drive the panel
 * fetch routes, the session event stream, and the registered tools. Project
 * state is real (`ProjectStore` under a temporary directory), so route and
 * lifecycle assertions observe files the plugin actually wrote.
 *
 * `tests/support/ts-hook.mjs` is required before loading `src/app/apply.ts`:
 * the assembly imports its siblings with the build's `.js` specifiers, and its
 * transitive dependencies use TypeScript parameter properties, which strip-only
 * mode rejects.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import '../support/ts-hook.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeSeedProject, makeTopicFixture, withRepo } from '../support/inbox-fixtures.mjs'
import { PANEL_PATHS } from '../support/public-surface.mjs'

// Loading the hook through the fixture above is enough only for the modules the
// fixture already imports; `apply.ts` is imported here, after the hook is live.
const { apply, createOpenWorkspacePathPort, OPEN_WORKSPACE_PATH_TIMEOUT_MS } = await import(
  '../../src/app/apply.ts'
)
const contract = await import('../../src/panel/api-contract.ts')
const { CONFIG_DEFAULTS } = await import('../../src/app/config.ts')

const PLUGIN = '@dsh-external/dsh-cowork'
const HOST = '127.0.0.1:3080'
const OVERVIEW_PATH = contract.OVERVIEW_PATH
const REOPEN_PATH = contract.REOPEN_PATH
const AUTHORIZATION_RESOLVE_PATH = contract.AUTHORIZATION_RESOLVE_PATH

/** Sentinel: a host service name whose lookup throws instead of answering. */
const THROWS = Symbol('throws')

const topic = makeTopicFixture()
const seedProject = makeSeedProject()

/** A hand-built partial config; `apply` normalizes every omitted field. */
function config(overrides = {}) {
  return {
    repoPath: '',
    promptTimeoutMs: 120_000,
    storeRelativePath: '.dsh-cowork/probe/store.json',
    worktreeRelativePath: '.dsh-cowork/worktrees/probe',
    enableDevRoutes: false,
    ...overrides,
  }
}

/**
 * Minimal host: records registrations instead of serving them.
 *
 * `effect` runs its callback immediately, as Cordis does, and keeps the
 * returned disposer; `get` is the only service seam — the assembly reaches the
 * host through structural fields for the required services and through `get`
 * for the optional `connection`/`llm`/`agentDefaultModel` slices.
 */
function makeHost(options = {}) {
  const routes = []
  const fetchRoutes = new Map()
  const tools = []
  const listeners = []
  const presets = []
  const effects = []
  const info = []
  const warn = []
  const unarchived = []
  const prompts = []
  const attached = []
  const createdWorkspaces = []
  const sessionRows = options.sessionRows ?? []

  const connection = {
    fetch: {
      register(route) {
        assert.equal(fetchRoutes.has(route.path), false, `duplicate panel route ${route.path}`)
        fetchRoutes.set(route.path, route)
        return async () => {
          fetchRoutes.delete(route.path)
        }
      },
    },
  }

  const agentPresets = {
    list: async () => presets,
    register: async (definition) => {
      presets.push(definition)
      return async () => {
        const at = presets.indexOf(definition)
        if (at >= 0) presets.splice(at, 1)
      }
    },
  }
  if (options.roster !== false) {
    // Same projection the host roster uses: only the master is a manual entry.
    agentPresets.remoteExportList = async () => ({
      presets: presets.map((preset) => ({ id: preset.id, isDefault: preset.id === 'cowork-master' })),
    })
  }

  const ctx = {
    get(name) {
      if (options.services !== undefined && Object.hasOwn(options.services, name)) {
        const value = options.services[name]
        if (value === THROWS) throw new Error(`host service '${name}' is unavailable`)
        return value
      }
      return name === 'connection' ? connection : undefined
    },
    effect(callback, label) {
      const disposer = callback()
      effects.push({ label, disposer })
      return disposer
    },
    on(name, handler) {
      const entry = { name, handler }
      listeners.push(entry)
      return () => {
        const at = listeners.indexOf(entry)
        if (at >= 0) listeners.splice(at, 1)
      }
    },
    logger: {
      info: (message) => info.push(message),
      warn: (message) => warn.push(message),
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const at = routes.indexOf(route)
          if (at >= 0) routes.splice(at, 1)
        }
      },
    },
    tools: {
      register(toolDefinition) {
        tools.push(toolDefinition)
        return () => {
          const at = tools.indexOf(toolDefinition)
          if (at >= 0) tools.splice(at, 1)
        }
      },
    },
    sessionController: {
      list: options.listSessions ?? (async () => ({ items: sessionRows })),
      prompt: async (request, signal) => {
        prompts.push({ request, signal })
        return { accepted: true }
      },
      create: async (request) => ({ sessionId: 'session-created', agentPreset: request.agentPreset }),
      rename: async ({ title }) => ({ title, seq: 1 }),
      inspect: async (sessionId) => ({ meta: { id: sessionId } }),
    },
    workspaceRegistry: {
      resolveByPath: options.resolveByPath ?? (async (path) => ({ id: 'workspace-1', path })),
      create: async (path, title) => {
        createdWorkspaces.push({ path, title })
        return { id: 'workspace-created', path }
      },
      delete: async () => true,
      archiveSession: async () => {},
      ...(options.noUnarchive === true
        ? {}
        : {
            unarchiveSession: async (sessionId) => {
              unarchived.push(sessionId)
            },
          }),
      get: (id) => (options.workspaceOf ?? ((workspaceId) => ({
        attachSession: async (sessionId) => {
          attached.push({ workspaceId, sessionId })
        },
      })))(id),
    },
    agentPresets,
    agents: { list: () => options.agents ?? [] },
  }

  return {
    ctx,
    routes,
    fetchRoutes,
    tools,
    listeners,
    presets,
    effects,
    info,
    warn,
    unarchived,
    prompts,
    attached,
    createdWorkspaces,
  }
}

/** Run every registered effect disposer, awaiting the async ones. */
async function disposeAll(host) {
  for (const entry of host.effects) {
    let disposer = entry.disposer
    if (disposer !== null && typeof disposer === 'object' && typeof disposer.then === 'function') {
      disposer = await disposer
    }
    if (typeof disposer === 'function') await disposer()
  }
}

/** Let the microtask-only work `apply()` starts (preset registrations) settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

/**
 * Yield to the event loop until `predicate` holds, bounded by a real deadline.
 *
 * A `setImmediate`-only loop exhausts before the filesystem callbacks of the
 * startup repair complete on a loaded CI runner. The 5 ms yield gives pending
 * I/O a chance; the 10 s deadline turns a hung repair into a named failure
 * instead of a job timeout.
 */
async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** GET from the panel origin (no Origin header: same-origin reads are allowed). */
function getPanel(path, query = '') {
  return new Request(`http://${HOST}${path}${query}`, { headers: { host: HOST } })
}

/** POST from the panel origin with the JSON wire contract. */
function postPanel(path, body) {
  return new Request(`http://${HOST}${path}`, {
    method: 'POST',
    headers: { host: HOST, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function json(response) {
  return { status: response.status, body: await response.json() }
}

function routeOf(host, path) {
  const route = host.fetchRoutes.get(path)
  assert.ok(route, `expected the panel route ${path} to be registered`)
  return route
}

function toolOf(host, name) {
  const toolDefinition = host.tools.find((entry) => entry.name === name)
  assert.ok(toolDefinition, `expected the tool ${name} to be registered`)
  return toolDefinition
}

/** A caller identity shaped like the host's `exec.agent`. */
function execOf(cwd, id = 'session-master') {
  return { agent: { id, session: { header: { cwd, agentPreset: 'cowork-master' } } } }
}

/** Write the index the repair scan needs, and return the store that owns it. */
async function seedEmptyProject(repoPath) {
  return seedProject(repoPath, [])
}

/** A seed whose two equally-scored topics force the model fallback layer. */
async function seedAmbiguousRoute(repoPath) {
  const shared = {
    title: 'coverage debt',
    scope: '',
    digest: '',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    lastActiveAt: '2026-11-01T00:00:00.000Z',
  }
  return seedProject(repoPath, [
    topic({ ...shared, topicId: 'topic-a' }),
    topic({ ...shared, topicId: 'topic-b' }),
  ])
}

/** A deterministic host `llm` slice: records the call, streams one routing reply. */
function fakeLlm(reply) {
  const prepareCalls = []
  const streamCalls = []
  return {
    prepareCalls,
    streamCalls,
    async prepareCall(callConfig, signal) {
      prepareCalls.push({ callConfig, signal })
      return {
        config: { materialized: true },
        stream(options) {
          streamCalls.push(options)
          return (async function* chunks() {
            yield { type: 'text-delta', text: reply }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      }
    },
  }
}

/* ------------------------------------------------------------------ */
/* createOpenWorkspacePathPort                                          */
/* ------------------------------------------------------------------ */

test('the open port forwards the request and a real AbortSignal to the host', async () => {
  const calls = []
  const port = createOpenWorkspacePathPort({
    async openWorkspacePath(request, signal) {
      signal.throwIfAborted()
      calls.push({ request, signal })
    },
  })

  await port('/repo/docs/PLAN.md')

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].request, { path: '/repo/docs/PLAN.md', action: 'reveal' })
  assert.equal(calls[0].signal instanceof AbortSignal, true)
  assert.equal(calls[0].signal.aborted, false)
  assert.equal(OPEN_WORKSPACE_PATH_TIMEOUT_MS, 10_000)
})

test('a host without the opener, or a rejected open, is reported not swallowed', async () => {
  await assert.rejects(
    createOpenWorkspacePathPort(undefined)('/repo/a.md'),
    /exposes no openWorkspacePath/,
  )
  await assert.rejects(
    createOpenWorkspacePathPort({
      async openWorkspacePath() {
        throw new Error('no desktop session')
      },
    })('/repo/a.md'),
    /no desktop session/,
  )
})

/* ------------------------------------------------------------------ */
/* Configuration guard                                                  */
/* ------------------------------------------------------------------ */

test('an unsupported reviewer.reclaim value fails startup before any registration', () => {
  const host = makeHost()
  assert.throws(
    () => apply(host.ctx, config({ reviewer: { reclaim: 'immediate' } })),
    /reviewer\.reclaim must be 'after-verdict'.*got 'immediate'/,
  )
  assert.deepEqual(host.effects, [])
  assert.deepEqual(host.tools, [])
  assert.equal(host.fetchRoutes.size, 0)
  assert.deepEqual(host.info, [])
  assert.equal(CONFIG_DEFAULTS.reviewer.reclaim, 'after-verdict')
})

/* ------------------------------------------------------------------ */
/* Registration surface and teardown                                    */
/* ------------------------------------------------------------------ */

test('apply registers the business surface and dispose releases every effect', async () => {
  const host = makeHost()
  apply(host.ctx, config())
  await settle()

  // The panel API, the topic lifecycle listener, and the memory section listener.
  assert.equal(host.fetchRoutes.size, PANEL_PATHS.length)
  assert.deepEqual(
    host.listeners.map((entry) => entry.name).sort(),
    ['agent/created', 'session/event'],
  )
  assert.equal(host.tools.length, 22)
  assert.equal(host.presets.length, 3)
  assert.equal(host.info.at(-1), `[${PLUGIN}] cowork tools, presets, and panel ready`)

  // The remote roster hides the internal presets while registration stays whole.
  const roster = async () => (await host.ctx.agentPresets.remoteExportList()).presets.map((row) => row.id)
  assert.deepEqual((await roster()).sort(), ['cowork-master'])
  assert.deepEqual(
    host.effects.map((entry) => entry.label).sort(),
    [
      'dsh-cowork: cowork presets',
      'dsh-cowork: cowork tools',
      'dsh-cowork: hide internal presets',
      'dsh-cowork: notice dispatcher',
      'dsh-cowork: project memory prompt',
      'dsh-cowork: topic lifecycle events',
      'dsh-cowork: workspace repair',
      ...PANEL_PATHS.map((path) => `dsh-cowork: panel route ${path}`),
    ].sort(),
  )

  // The roster wrapper is idempotent: releasing it restores the original
  // method, and a second release leaves a later owner alone.
  const hide = host.effects.find((entry) => entry.label === 'dsh-cowork: hide internal presets')
  await hide.disposer()
  await hide.disposer()
  assert.deepEqual((await roster()).sort(), ['cowork-master', 'cowork-reviewer', 'cowork-topic'])

  await disposeAll(host)

  assert.equal(host.fetchRoutes.size, 0)
  assert.equal(host.tools.length, 0)
  assert.equal(host.presets.length, 0)
  assert.deepEqual(host.listeners, [])
  // The preset registrations owned by the disposed effect are gone, while the
  // roster method itself is the host's original one again.
  assert.deepEqual(await roster(), [])

  // Every disposer is idempotent: a second release removes nothing else and
  // leaves no stray listener or registration behind.
  await disposeAll(host)
  assert.equal(host.fetchRoutes.size, 0)
  assert.equal(host.tools.length, 0)
  assert.deepEqual(host.listeners, [])
})

test('enableDevRoutes adds the loopback health route only on request', async () => {
  const off = makeHost()
  apply(off.ctx, config())
  await settle()
  assert.deepEqual(off.routes, [])

  const host = makeHost()
  apply(host.ctx, config({ enableDevRoutes: true }))
  await settle()

  assert.deepEqual(host.routes.map((route) => route.path), [
    '/dsh-cowork/probe/health',
    '/dsh-cowork/e2e/m12/run',
    '/dsh-cowork/e2e/m12/status',
  ])
  assert.equal(host.routes.every((route) => route.kind === 'exact'), true)
  const labels = host.effects.map((entry) => entry.label)
  for (const path of host.routes.map((route) => route.path)) {
    assert.equal(labels.includes(`dsh-cowork: route ${path}`), true, `missing effect for ${path}`)
  }
  assert.equal(labels.includes('dsh-cowork: M12 E2E runner'), true)
  assert.equal(labels.includes('dsh-cowork: M12 E2E session event feed'), true)
  // The business surface is unchanged by the dev gate.
  assert.equal(host.tools.length, 22)
  assert.equal(host.listeners.filter((entry) => entry.name === 'session/event').length, 2)
})

/* ------------------------------------------------------------------ */
/* Workspace repair                                                     */
/* ------------------------------------------------------------------ */

test('startup repair re-creates a lost workspace and attaches the project session', async () => {
  await withRepo(async (repoPath) => {
    await seedEmptyProject(repoPath)
    const host = makeHost({
      sessionRows: [{ sessionId: 'session-1', cwd: repoPath }],
      resolveByPath: async () => undefined,
    })
    apply(host.ctx, config())

    await waitFor(
      () => host.info.some((line) => line.includes('created 1 workspace(s), attached 1 session(s)')),
      'the repair success log',
    )
    assert.deepEqual(host.createdWorkspaces.map((row) => row.path), [repoPath])
    // The registry entity, not the registry itself, owns attachment.
    assert.deepEqual(host.attached, [{ workspaceId: 'workspace-created', sessionId: 'session-1' }])
    assert.deepEqual(host.warn, [])
  })
})

test('a repair attachment the registry cannot resolve is logged, not thrown', async () => {
  await withRepo(async (repoPath) => {
    await seedEmptyProject(repoPath)
    const host = makeHost({
      sessionRows: [{ sessionId: 'session-1', cwd: repoPath }],
      resolveByPath: async () => undefined,
      workspaceOf: () => undefined,
    })
    apply(host.ctx, config())

    await waitFor(
      () => host.warn.some((line) => line.includes('workspace repair: session session-1 -> workspace')),
      'the repair attachment error',
    )
    const failure = host.warn.find((line) => line.includes('workspace repair: session session-1'))
    assert.ok(failure, 'the attach failure must be logged')
    assert.match(failure, /workspace 'workspace-created' is not registered, so it cannot own session 'session-1'/)
    // The project-scoped step still counted its creation before the attach failed.
    assert.deepEqual(host.createdWorkspaces.map((row) => row.path), [repoPath])
  })
})

test('a programming failure in the repair pass is logged and never fails startup', async () => {
  const host = makeHost({ listSessions: async () => ({}) })
  apply(host.ctx, config())

  await waitFor(
    () => host.warn.some((line) => line.includes('workspace repair failed:')),
    'the repair catch arm',
  )
  const failure = host.warn.find((line) => line.includes('workspace repair failed:'))
  assert.ok(failure, 'the repair catch arm must be reported')
  assert.ok(failure.startsWith(`[${PLUGIN}] workspace repair failed: `), failure)
  // The rest of the assembly mounted despite the failed pass.
  assert.equal(host.tools.length, 22)
})

/* ------------------------------------------------------------------ */
/* Hidden preset roster                                                 */
/* ------------------------------------------------------------------ */

test('a host without remoteExportList keeps the internal presets and logs the fallback', async () => {
  const host = makeHost({ roster: false })
  apply(host.ctx, config())
  await settle()

  const fallback = host.warn.find((line) => line.includes('internal preset entries stay visible:'))
  assert.ok(fallback, 'the fail-open path must be reported')
  assert.match(fallback, /agentPresets\.remoteExportList is unavailable/)
  assert.equal(host.tools.length, 22)
  // The effect returned a usable disposer even though hiding failed.
  await disposeAll(host)
  assert.equal(host.tools.length, 0)
})

/* ------------------------------------------------------------------ */
/* Project memory                                                       */
/* ------------------------------------------------------------------ */

/** One agent whose system-prompt section registration is captured. */
function memoryAgent(id, cwd, { sectionThrows = false } = {}) {
  const sections = []
  return {
    sections,
    agent: {
      id,
      session: { header: { cwd, agentPreset: 'cowork-master' } },
      ctx: {
        systemPrompt: {
          section(section) {
            if (sectionThrows) throw new Error(`${section.name}: section already registered`)
            sections.push(section)
            return () => {}
          },
        },
      },
    },
  }
}

test('the memory section renders the project block and refreshes it when a file changes', async () => {
  await withRepo(async (repoPath) => {
    await seedEmptyProject(repoPath)
    const memoryDir = join(repoPath, '.dsh-cowork', 'memory')
    await mkdir(memoryDir, { recursive: true })
    const constraint = '## Use pnpm\n\nRun pnpm only.\n\n(来源: notes; 2026-01-01T00:00:00.000Z)\n'
    await writeFile(join(memoryDir, 'constraints.md'), constraint, 'utf8')

    const recorder = memoryAgent('agent-memory', repoPath)
    const host = makeHost({ agents: [recorder.agent] })
    apply(host.ctx, config())

    assert.equal(recorder.sections.length, 1)
    const render = recorder.sections[0].text
    const expected = `Project memory for ${repoPath}:\n\n### constraints\n\n## Use pnpm\n\nRun pnpm only.\n\n(来源: notes; 2026-01-01T00:00:00.000Z)`
    assert.equal(render(), expected)
    // Unchanged memory renders the identical block, so the digest-keyed cache
    // stays a hit and the prompt assembly does not churn.
    assert.equal(render(), expected)

    const decision = '## Prefer newline\n\nEnd files with a newline.\n\n(来源: review; 2026-01-02T00:00:00.000Z)\n'
    await writeFile(join(memoryDir, 'decisions.md'), decision, 'utf8')
    const refreshed = render()
    assert.notEqual(refreshed, expected, 'a changed memory file must invalidate the cached block')
    assert.equal(
      refreshed,
      `${expected}\n\n### decisions\n\n## Prefer newline\n\nEnd files with a newline.\n\n(来源: review; 2026-01-02T00:00:00.000Z)`,
    )
  })
})

test('an unreadable memory file disables injection for that prompt', async () => {
  await withRepo(async (repoPath) => {
    await seedEmptyProject(repoPath)
    const memoryDir = join(repoPath, '.dsh-cowork', 'memory')
    // A directory where the file belongs: the read fails with EISDIR, which the
    // assembly must treat as "no memory", not quote a half-read project.
    await mkdir(join(memoryDir, 'constraints.md'), { recursive: true })

    const recorder = memoryAgent('agent-unreadable', repoPath)
    const host = makeHost({ agents: [recorder.agent] })
    apply(host.ctx, config())

    assert.equal(recorder.sections.length, 1)
    assert.equal(recorder.sections[0].text(), '')
  })
})

test('an installed project with empty memory files renders no section', async () => {
  await withRepo(async (repoPath) => {
    await seedEmptyProject(repoPath)
    const memoryDir = join(repoPath, '.dsh-cowork', 'memory')
    await mkdir(memoryDir, { recursive: true })
    for (const file of ['constraints.md', 'decisions.md', 'facts.md']) {
      await writeFile(join(memoryDir, file), '', 'utf8')
    }

    const recorder = memoryAgent('agent-empty', repoPath)
    const host = makeHost({ agents: [recorder.agent] })
    apply(host.ctx, config())

    assert.equal(recorder.sections.length, 1)
    assert.equal(recorder.sections[0].text(), '')
  })
})

test('a duplicate memory section is skipped and reported once per agent', async () => {
  await withRepo(async (repoPath) => {
    await seedEmptyProject(repoPath)
    const recorder = memoryAgent('agent-duplicate', repoPath, { sectionThrows: true })
    const host = makeHost({ agents: [recorder.agent] })
    apply(host.ctx, config())

    const duplicate = host.warn.find((line) => line.includes('cowork memory section(s) already registered'))
    assert.equal(
      duplicate,
      `[${PLUGIN}] 1 cowork memory section(s) already registered; skipped`,
    )
    // The per-agent failure is reported too, and startup continues.
    assert.equal(
      host.warn.some((line) => line.includes('memory section registration failed for agent agent-duplicate')),
      true,
    )
    assert.equal(host.tools.length, 22)
  })
})

/* ------------------------------------------------------------------ */
/* Host services: llm and agentDefaultModel                             */
/* ------------------------------------------------------------------ */

test('a host service that throws on lookup leaves routing on its structured fallback', async () => {
  await withRepo(async (repoPath) => {
    await seedAmbiguousRoute(repoPath)
    const host = makeHost({
      sessionRows: [{ sessionId: 'session-master', cwd: repoPath }],
      services: { llm: THROWS },
    })
    apply(host.ctx, config())
    await waitFor(() => host.attached.length > 0, 'the startup repair attachment')

    const result = await toolOf(host, 'cowork_route').execute(
      { intent: 'coverage debt' },
      execOf(repoPath),
    )

    assert.equal(result.ok, true)
    assert.equal(result.action, 'reuse')
    assert.equal(result.topicId, 'topic-a')
    assert.equal(result.modelUsed, false)
    assert.match(result.modelError, /^unconfigured: routing\.provider and routing\.model must both be set$/)
    assert.equal(result.reason, 'layer3:fallback-reuse')
  })
})

test('the host default model fills a blank routing provider and model', async () => {
  await withRepo(async (repoPath) => {
    await seedAmbiguousRoute(repoPath)
    const llm = fakeLlm('{"topicId":"topic-a","confidence":0.9}')
    const host = makeHost({
      sessionRows: [{ sessionId: 'session-master', cwd: repoPath }],
      services: {
        llm,
        agentDefaultModel: { currentSelection: () => ({ provider: 'host-provider', model: 'host-model' }) },
      },
    })
    apply(host.ctx, config())
    await waitFor(() => host.attached.length > 0, 'the startup repair attachment')

    const result = await toolOf(host, 'cowork_route').execute(
      { intent: 'coverage debt' },
      execOf(repoPath),
    )

    assert.equal(result.ok, true)
    assert.equal(result.action, 'reuse')
    assert.equal(result.topicId, 'topic-a')
    assert.equal(result.modelUsed, true)
    assert.deepEqual(llm.prepareCalls.map((call) => call.callConfig), [{
      provider: 'host-provider',
      model: 'host-model',
      maxTokens: 256,
      reasoningEffort: 'off',
    }])
    // The selected route reaches the stream request too, not just prepareCall.
    assert.equal(llm.streamCalls.length, 1)
    assert.equal(llm.streamCalls[0].provider, 'host-provider')
    assert.equal(llm.streamCalls[0].model, 'host-model')
    assert.equal(llm.streamCalls[0].signal instanceof AbortSignal, true)
    assert.equal(host.prompts.length, 1)
    assert.equal(host.prompts[0].request.content[0].text, 'coverage debt')
  })
})

test('an incomplete or throwing default-model selection stays unconfigured', async () => {
  for (const currentSelection of [
    () => ({ provider: 'host-provider' }),
    () => {
      throw new Error('selection is unavailable')
    },
  ]) {
    await withRepo(async (repoPath) => {
      await seedAmbiguousRoute(repoPath)
      const host = makeHost({
        sessionRows: [{ sessionId: 'session-master', cwd: repoPath }],
        services: { agentDefaultModel: { currentSelection } },
      })
      apply(host.ctx, config())
      await waitFor(() => host.attached.length > 0, 'the startup repair attachment')

      const result = await toolOf(host, 'cowork_route').execute(
        { intent: 'coverage debt' },
        execOf(repoPath),
      )

      assert.equal(result.ok, true)
      assert.equal(result.modelUsed, false)
      assert.match(result.modelError, /^unconfigured: /)
    })
  }
})

/* ------------------------------------------------------------------ */
/* Topic lifecycle over the host session event stream                   */
/* ------------------------------------------------------------------ */

test('a session turn end moves the topic activity through the real store', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [
      topic({
        topicId: 'topic-live',
        title: 'Live topic',
        lastActiveAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      }),
    ])
    const host = makeHost()
    apply(host.ctx, config())

    const listener = host.listeners.find((entry) => entry.name === 'session/event')
    assert.ok(listener, 'the topic lifecycle listener must be attached')

    // A session without a usable cwd is not ours: the event writes nothing.
    listener.handler({ id: 'topic-live' }, { type: 'turn/end' })
    listener.handler({ id: 'topic-live', header: { cwd: '' } }, { type: 'turn/end' })
    await settle()
    assert.equal((await store.readIndexDocument()).topics[0].lastActiveAt, '2026-11-01T00:00:00.000Z')

    listener.handler({ id: 'topic-live', header: { cwd: repoPath } }, { type: 'turn/end' })
    await waitFor(
      async () => (await store.readIndexDocument()).topics[0].lastActiveAt !== '2026-11-01T00:00:00.000Z',
      'the topic activity write',
    )
    const after = (await store.readIndexDocument()).topics[0]
    assert.equal(after.status, 'active')
    assert.ok(after.lastActiveAt > '2026-11-01T00:00:00.000Z')
  })
})

/* ------------------------------------------------------------------ */
/* Panel routes: store construction, reopen, authorization prompt       */
/* ------------------------------------------------------------------ */

const resolvedTopic = () => topic({
  topicId: 'topic-resolved',
  title: 'Resolved topic',
  status: 'resolved',
  resolvedAt: '2026-11-15T00:00:00.000Z',
  resolvedBy: 'user',
})

const pendingAuthorizationTopic = () => topic({
  topicId: 'topic-auth',
  title: 'Authorization topic',
  blocked: true,
  blockedReason: 'authorization',
  blockedFromStatus: 'active',
  blockedAt: '2026-11-15T00:00:00.000Z',
  authorization: { requestId: 'req-1', summary: 'may I deploy?', requestedAt: '2026-11-15T00:00:00.000Z' },
})

test('the overview route opens the project through the panel store port', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [topic({ topicId: 'topic-active', title: 'Active' }), resolvedTopic()])
    const host = makeHost({ sessionRows: [{ sessionId: 'session-master', cwd: repoPath }] })
    apply(host.ctx, config())
    await waitFor(() => host.attached.length > 0, 'the startup repair attachment')

    const response = await json(await routeOf(host, OVERVIEW_PATH).fetch(
      getPanel(OVERVIEW_PATH, '?sessionId=session-master'),
    ))

    assert.equal(response.status, 200)
    assert.equal(response.body.project.repoPath, repoPath)
    assert.deepEqual(
      response.body.topics.map((row) => row.topicId).sort(),
      ['topic-active', 'topic-resolved'],
    )
  })
})

test('the reopen route restores the host session and reports the active topic', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [resolvedTopic()])
    const host = makeHost({ sessionRows: [{ sessionId: 'session-master', cwd: repoPath }] })
    apply(host.ctx, config())
    await waitFor(() => host.attached.length > 0, 'the startup repair attachment')

    const response = await json(await routeOf(host, REOPEN_PATH).fetch(
      postPanel(REOPEN_PATH, { sessionId: 'session-master', topicId: 'topic-resolved' }),
    ))

    assert.equal(response.status, 200)
    assert.equal(response.body.topic.topicId, 'topic-resolved')
    assert.equal(response.body.topic.status, 'active')
    assert.deepEqual(host.unarchived, ['topic-resolved'])
  })
})

test('a host without unarchiveSession logs the reopen failure but still reopens', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [resolvedTopic()])
    const host = makeHost({
      sessionRows: [{ sessionId: 'session-master', cwd: repoPath }],
      noUnarchive: true,
    })
    apply(host.ctx, config())
    await waitFor(() => host.attached.length > 0, 'the startup repair attachment')

    const response = await json(await routeOf(host, REOPEN_PATH).fetch(
      postPanel(REOPEN_PATH, { sessionId: 'session-master', topicId: 'topic-resolved' }),
    ))

    assert.equal(response.status, 200)
    assert.equal(response.body.topic.status, 'active')
    const failure = host.warn.find((line) => line.includes('panel reopen: host session topic-resolved was not restored'))
    assert.ok(failure, 'the refused restore must be logged')
    assert.match(failure, /exposes no unarchiveSession/)
  })
})

test('the authorization route queues the decision prompt on the topic session', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [pendingAuthorizationTopic()])
    const host = makeHost({ sessionRows: [{ sessionId: 'session-master', cwd: repoPath }] })
    apply(host.ctx, config())
    await waitFor(() => host.attached.length > 0, 'the startup repair attachment')

    const response = await json(await routeOf(host, AUTHORIZATION_RESOLVE_PATH).fetch(
      postPanel(AUTHORIZATION_RESOLVE_PATH, {
        sessionId: 'session-master',
        topicId: 'topic-auth',
        requestId: 'req-1',
        decision: 'allow',
      }),
    ))

    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    assert.equal(response.body.prompted, true)
    assert.equal(response.body.topic.awaitingAuthorization, false)
    assert.equal(host.prompts.length, 1)
    assert.equal(host.prompts[0].request.sessionId, 'topic-auth')
    assert.equal(host.prompts[0].request.mode, 'queue')
    assert.deepEqual(host.prompts[0].request.content, [
      { type: 'text', text: '授权请求已允许：may I deploy?。请继续。' },
    ])
    assert.equal(host.prompts[0].signal instanceof AbortSignal, true)
  })
})

