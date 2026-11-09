import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The assembly under test is `src/index.ts`, so this test loads the real
// `apply()`. Two loader duties make that possible under `node --test`:
//  (a) index.ts imports its siblings with the build's `.js` specifiers, which
//      Node's type stripping does not retry as `.ts`;
//  (b) the runners it constructs use TypeScript parameter properties, which
//      strip-only mode rejects — transform mode is required.
// Everything else (dsh-tools, schemastery) resolves from the links that
// `npm run build` creates, like tests/api.test.mjs already relies on.
const HOOK_SOURCE = [
  "import { readFileSync } from 'node:fs'",
  "import { stripTypeScriptTypes } from 'node:module'",
  "import { fileURLToPath } from 'node:url'",
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier.startsWith('.') && specifier.endsWith('.js')) {",
  "    try { return await nextResolve(specifier.slice(0, -3) + '.ts', context) } catch {}",
  '  }',
  '  return nextResolve(specifier, context)',
  '}',
  'export async function load(url, context, nextLoad) {',
  "  if (url.startsWith('file:') && url.endsWith('.ts')) {",
  "    const source = readFileSync(fileURLToPath(url), 'utf8')",
  "    return { format: 'module', shortCircuit: true, source: stripTypeScriptTypes(source, { mode: 'transform' }) }",
  '  }',
  '  return nextLoad(url, context)',
  '}',
].join('\n')
register(`data:text/javascript,${encodeURIComponent(HOOK_SOURCE)}`)

const { apply, Config, normalizeConfig } = await import('../src/index.ts')
const { DEFAULT_ISOLATION_PROVIDER } = await import('../src/tool-runtime.ts')
const { CLONE_ISOLATION_PROVIDER } = await import('../src/checkout.ts')
const { HANDOFF_PATH, OVERVIEW_PATH } = await import('../src/api-contract.ts')

/** The fifteen business tools — stable public names, pinned here on purpose. */
const BUSINESS_TOOLS = [
  'cowork_checkout_merge',
  'cowork_handoff',
  'cowork_memory_search',
  'cowork_memory_write',
  'cowork_project_init',
  'cowork_project_status',
  'cowork_review_request',
  'cowork_review_verdict',
  'cowork_route',
  'cowork_thread_create',
  'cowork_thread_list',
  'cowork_topic_create',
  'cowork_topic_list',
  'cowork_topic_resolve',
  'cowork_work_item_create',
]

/**
 * The registration order is the public surface (PLAN-V0.2 §5.7), pinned by name
 * so a reorder is a red test, not a silent change.
 */
const BUSINESS_TOOL_ORDER = [
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
]

/** The four runtime presets every mode registers (thread is the deprecated topic alias). */
const BUSINESS_PRESETS = ['cowork-master', 'cowork-reviewer', 'cowork-thread', 'cowork-topic']

/** Probe-only tools, presets, and routes; all gated by `enableDevRoutes`. */
const DEV_TOOLS = ['cowork_identity_probe', 'cowork_probe']
const DEV_PRESETS = ['cowork-probe', 'cowork-thread-s0']
const DEV_ROUTES = [
  '/dsh-cowork/e2e/m2/run',
  '/dsh-cowork/e2e/m2/status',
  '/dsh-cowork/e2e/m3/run',
  '/dsh-cowork/e2e/m3/status',
  '/dsh-cowork/probe/health',
  '/dsh-cowork/probe/run',
  '/dsh-cowork/probe/s0',
  '/dsh-cowork/probe/s0-status',
  '/dsh-cowork/probe/status',
]

const sorted = (values) => [...values].sort()

/** A config shaped like the parsed `Config`; `apply` reads the fields directly. */
function config(enableDevRoutes) {
  return {
    repoPath: '',
    promptTimeoutMs: 120_000,
    storeRelativePath: '.dsh-cowork/probe/store.json',
    worktreeRelativePath: '.dsh-cowork/worktrees/probe',
    enableDevRoutes,
  }
}

/**
 * Minimal host: records what `apply()` registers instead of serving it.
 * `effect` runs the callback immediately like Cordis does, and keeps its
 * disposer so the teardown path can be exercised.
 */
function fakeHost() {
  const routes = []
  const fetchRoutes = []
  const tools = []
  const listeners = []
  const presets = []
  const effects = []
  const connection = {
    fetch: {
      register(route) {
        fetchRoutes.push(route)
        return () => {}
      },
    },
  }
  const ctx = {
    get: (name) => (name === 'connection' ? connection : undefined),
    effect(callback, label) {
      const disposer = callback()
      effects.push({ label, disposer })
      return disposer
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
    on(name, handler) {
      const entry = { name, handler }
      listeners.push(entry)
      return () => {
        const at = listeners.indexOf(entry)
        if (at >= 0) listeners.splice(at, 1)
      }
    },
    logger: { info() {}, warn() {} },
    sessionController: { list: async () => ({ items: [] }) },
    workspaceRegistry: {},
    agentPresets: {
      list: async () => [],
      register: async (definition) => {
        presets.push(definition)
        return async () => {}
      },
    },
    agents: { list: () => [] },
  }
  return { ctx, routes, fetchRoutes, tools, listeners, presets, effects }
}

/** Settle the microtask-only work `apply()` starts (preset registrations). */
const settle = () => new Promise((resolve) => setImmediate(resolve))

const sessionListeners = (host) => host.listeners.filter((entry) => entry.name === 'session/event')

const toolNames = (host) => sorted(host.tools.map((tool) => tool.name))

const presetIds = (host) => sorted(host.presets.map((preset) => preset.id))

const fetchPaths = (host) => sorted(host.fetchRoutes.map((route) => route.path))

async function disposeAll(host) {
  for (const { disposer } of host.effects) {
    let value = disposer
    if (value !== null && typeof value === 'object' && typeof value.then === 'function') value = await value
    if (typeof value === 'function') await value()
  }
}

test('Config defaults enableDevRoutes to false', () => {
  assert.equal(Config({}).enableDevRoutes, false)
})

test('Config defaults pin the M10 isolation and reviewer settings', () => {
  const normalized = normalizeConfig({})
  assert.deepEqual(normalized.isolation, { provider: 'clone' })
  assert.deepEqual(normalized.reviewer, { reclaim: 'after-verdict' })
  assert.equal(BUSINESS_TOOL_ORDER.length, 15)
})

test('the isolation provider has one source of truth', () => {
  assert.equal(CLONE_ISOLATION_PROVIDER, 'clone')
  assert.equal(DEFAULT_ISOLATION_PROVIDER, CLONE_ISOLATION_PROVIDER)
})

test('apply refuses an unsupported reviewer reclaim value at startup', () => {
  const host = fakeHost()
  assert.throws(
    () => apply(host.ctx, { ...config(false), reviewer: { reclaim: 'immediate' } }),
    /reviewer\.reclaim must be 'after-verdict'/,
  )
  // The guard runs before any registration: nothing is half-mounted.
  assert.deepEqual(host.tools, [])
  assert.deepEqual(host.presets, [])
  assert.deepEqual(host.effects, [])
})

test('the business surface registers exactly fifteen tools in the documented order', async () => {
  const host = fakeHost()
  apply(host.ctx, config(false))
  await settle()

  assert.deepEqual(host.tools.map((tool) => tool.name), BUSINESS_TOOL_ORDER)
  assert.deepEqual(toolNames(host), sorted(BUSINESS_TOOLS))
})

test('cowork_handoff accepts exactly blocked and done (KI-25)', async () => {
  const host = fakeHost()
  apply(host.ctx, config(false))
  await settle()

  const handoff = host.tools.find((tool) => tool.name === 'cowork_handoff')
  assert.ok(handoff, 'cowork_handoff must be registered')
  assert.deepEqual(handoff.parameters.properties.status.enum, ['blocked', 'done'])
  assert.ok(handoff.parameters.required.includes('status'), 'status stays a required argument')
})

test('cowork_checkout_merge no longer accepts an unreviewed override (KI-25)', async () => {
  const host = fakeHost()
  apply(host.ctx, config(false))
  await settle()

  const merge = host.tools.find((tool) => tool.name === 'cowork_checkout_merge')
  assert.ok(merge, 'cowork_checkout_merge must be registered')
  assert.deepEqual(Object.keys(merge.parameters.properties).sort(), ['message', 'threadId', 'workItemId'])
  assert.equal('allowUnreviewed' in merge.parameters.properties, false)
  assert.equal('overrideReason' in merge.parameters.properties, false)
})

test('enableDevRoutes=false keeps the business surface and registers no dev surface', async () => {
  const host = fakeHost()
  apply(host.ctx, config(false))
  await settle()

  // No probe/E2E route at all; the panel API still registers its own two.
  assert.deepEqual(host.routes, [])
  assert.deepEqual(fetchPaths(host), sorted([OVERVIEW_PATH, HANDOFF_PATH]))

  // Exactly the fifteen business tools: the probe tools are absent.
  assert.deepEqual(toolNames(host), sorted(BUSINESS_TOOLS))

  // The four runner session feeds are not attached; the business topic
  // lifecycle listener and the memory prompt's agent/created listener are.
  assert.equal(sessionListeners(host).length, 1)
  assert.equal(host.listeners.filter((entry) => entry.name === 'agent/created').length, 1)

  // Only the four business presets; no probe preset rows.
  assert.deepEqual(presetIds(host), sorted(BUSINESS_PRESETS))

  // No dev-owned effect was registered either, so nothing can survive dispose.
  const devLabels = host.effects
    .map((entry) => entry.label)
    .filter((label) => /probe|e2e|session event feed/i.test(label))
  assert.deepEqual(devLabels, [])
})

test('enableDevRoutes=true restores the M0/S0/M2/M3 surface unchanged', async () => {
  const host = fakeHost()
  apply(host.ctx, config(true))
  await settle()

  // Same nine loopback-only routes and the same exact-match shape as before.
  assert.deepEqual(sorted(host.routes.map((route) => route.path)), DEV_ROUTES)
  assert.equal(host.routes.every((route) => route.kind === 'exact'), true)
  assert.equal(host.routes.every((route) => typeof route.handler === 'function'), true)

  // Panel API, business tools, and business presets are untouched by the gate.
  assert.deepEqual(fetchPaths(host), sorted([OVERVIEW_PATH, HANDOFF_PATH]))
  assert.deepEqual(toolNames(host), sorted([...BUSINESS_TOOLS, ...DEV_TOOLS]))
  assert.deepEqual(presetIds(host), sorted([...BUSINESS_PRESETS, ...DEV_PRESETS]))

  // One session/event listener per runner (M0, S0, M2, M3) plus the business
  // topic lifecycle listener.
  assert.equal(sessionListeners(host).length, 5)
  assert.equal(host.listeners.filter((entry) => entry.name === 'agent/created').length, 1)
})

test('the dev probe canonicalizes a symlinked repoPath (P0-F1)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cowork-gate-'))
  try {
    const real = join(root, 'repo')
    mkdirSync(real)
    const link = join(root, 'link')
    symlinkSync(real, link)

    const host = fakeHost()
    apply(host.ctx, { ...config(true), repoPath: link })
    await settle()

    const probe = host.tools.find((tool) => tool.name === 'cowork_probe')
    const value = await probe.execute({}, {})
    assert.equal(value.health.ok, true)
    assert.equal(value.health.plugin, '@dsh-external/dsh-cowork')
    assert.equal(value.health.repoPath, realpathSync(real))
    assert.notEqual(value.health.repoPath, link)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('disposing the plugin releases the dev session listeners', async () => {
  const host = fakeHost()
  apply(host.ctx, config(true))
  await settle()
  assert.equal(sessionListeners(host).length, 5)

  await disposeAll(host)

  assert.equal(sessionListeners(host).length, 0)
  // The memory prompt's agent/created listener is released too, so a hot
  // reload leaves no stale provider behind.
  assert.equal(host.listeners.length, 0)
})
