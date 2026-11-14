import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import './support/ts-hook.mjs'
import { BUSINESS_TOOLS, BUSINESS_TOOL_ORDER, PANEL_PATHS } from './support/public-surface.mjs'
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

const { apply, Config, normalizeConfig, panelRoutePathname } = await import('../src/index.ts')
const { CONFIG_DEFAULTS } = await import('../src/config.ts')
const { panelProbeRequest } = await import('../src/panel-probe.ts')
const { DEFAULT_ISOLATION_PROVIDER } = await import('../src/tool-runtime.ts')
const { CLONE_ISOLATION_PROVIDER } = await import('../src/checkout.ts')
const { OVERVIEW_PATH } = await import('../src/api-contract.ts')

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** The three runtime presets the business surface registers. */
const BUSINESS_PRESETS = ['cowork-master', 'cowork-reviewer', 'cowork-topic']

/** The opt-in dev surface: health plus the M12 E2E run/status pair, nothing else. */
const DEV_ROUTES = [
  '/dsh-cowork/e2e/m12/run',
  '/dsh-cowork/e2e/m12/status',
  '/dsh-cowork/probe/health',
]

/** Entry-point budget: the index must stay a readable orchestration layer. */
const INDEX_BUDGET_BYTES = 30 * 1024

const sorted = (values) => [...values].sort()

/** A config shaped like the parsed `Config`; `apply` reads the fields directly. */
function config(enableDevRoutes) {
  return {
    repoPath: '',
    promptTimeoutMs: 120_000,
    // Accepted for profile compatibility; still normalizes cleanly.
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
      list: async () => presets,
      remoteExportList: async () => ({
        presets: presets.map((preset) => ({ ...preset, isDefault: preset.id === 'cowork-master' })),
      }),
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

/**
 * Invoke one registered dev route with a synthetic Node request/response pair.
 * The handlers are synchronous for the health route and status-only for the
 * M12 pair, so the captured response is enough for the assertions here.
 */
function callRoute(route, { method = 'GET', url = route.path, remoteAddress = '127.0.0.1', host = '127.0.0.1' } = {}) {
  const response = {
    status: 0,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    writeHead(status, headers) {
      this.status = status
      Object.assign(this.headers, headers)
    },
    end(body) {
      this.body = body
    },
  }
  route.handler({
    socket: { remoteAddress },
    headers: host === null ? {} : { host },
    method,
    url,
    resume() {},
  }, response)
  return { ...response, json: response.body === null || response.body === '' ? null : JSON.parse(response.body) }
}

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
  assert.equal(BUSINESS_TOOL_ORDER.length, 22)
})

test('CONFIG_DEFAULTS is the one defaults table behind both readers', () => {
  assert.equal(Object.isFrozen(CONFIG_DEFAULTS), true, 'the shared table must not be mutable')
  for (const nested of ['routing', 'isolation', 'reviewer']) {
    assert.equal(Object.isFrozen(CONFIG_DEFAULTS[nested]), true, `${nested} defaults must not be mutable`)
  }
  // The schema and the normalizer fill the same values, field for field.
  assert.deepEqual(Config({}), normalizeConfig({}))
  assert.deepEqual(normalizeConfig({}), { ...CONFIG_DEFAULTS })
  assert.deepEqual(Config({}), { ...CONFIG_DEFAULTS })
})

test('the isolation provider has one source of truth', () => {
  assert.equal(CLONE_ISOLATION_PROVIDER, 'clone')
  assert.equal(DEFAULT_ISOLATION_PROVIDER, CLONE_ISOLATION_PROVIDER)
  assert.equal(CONFIG_DEFAULTS.isolation.provider, CLONE_ISOLATION_PROVIDER)
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

test('the business surface registers exactly twenty-two tools in the documented order', async () => {
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

  // No dev route at all; the panel API still registers its own ten.
  assert.deepEqual(host.routes, [])
  assert.deepEqual(fetchPaths(host), sorted(PANEL_PATHS))

  // Exactly the twenty-two business tools: the retired probe tool is absent.
  assert.deepEqual(toolNames(host), sorted(BUSINESS_TOOLS))

  // The M12 runner's session feed is not attached; the business topic
  // lifecycle listener and the memory prompt's agent/created listener are.
  assert.equal(sessionListeners(host).length, 1)
  assert.equal(host.listeners.filter((entry) => entry.name === 'agent/created').length, 1)

  // Only the three business presets; the retired probe preset is absent.
  assert.deepEqual(presetIds(host), sorted(BUSINESS_PRESETS))

  // No dev-owned effect was registered either, so nothing can survive dispose.
  const devLabels = host.effects
    .map((entry) => entry.label)
    .filter((label) => /probe|e2e|session event feed/i.test(label))
  assert.deepEqual(devLabels, [])
})

test('the remote roster hides topic/reviewer while registration stays complete', async () => {
  const host = fakeHost()
  apply(host.ctx, config(false))
  await settle()

  assert.deepEqual(presetIds(host), sorted(BUSINESS_PRESETS))
  assert.deepEqual(
    sorted((await host.ctx.agentPresets.list()).map((preset) => preset.id)),
    sorted(BUSINESS_PRESETS),
  )
  assert.deepEqual(
    (await host.ctx.agentPresets.remoteExportList()).presets.map((preset) => preset.id),
    ['cowork-master'],
  )

  await disposeAll(host)
  assert.deepEqual(
    sorted((await host.ctx.agentPresets.remoteExportList()).presets.map((preset) => preset.id)),
    sorted(BUSINESS_PRESETS),
  )
})

test('enableDevRoutes=true adds only the health and M12 E2E routes', async () => {
  const host = fakeHost()
  apply(host.ctx, config(true))
  await settle()

  // Exactly three loopback-only routes with the exact-match shape.
  assert.deepEqual(sorted(host.routes.map((route) => route.path)), DEV_ROUTES)
  assert.equal(host.routes.every((route) => route.kind === 'exact'), true)
  assert.equal(host.routes.every((route) => typeof route.handler === 'function'), true)

  // Panel API, business tools, and business presets are untouched by the gate:
  // the retired M0 probe tool, probe preset, and run/status routes stay gone.
  assert.deepEqual(fetchPaths(host), sorted(PANEL_PATHS))
  assert.deepEqual(toolNames(host), sorted(BUSINESS_TOOLS))
  assert.deepEqual(presetIds(host), sorted(BUSINESS_PRESETS))
  assert.equal(host.tools.some((tool) => tool.name === 'cowork_probe'), false)
  assert.equal(host.presets.some((preset) => preset.id === 'cowork-probe'), false)

  // The M12 session feed plus the business topic lifecycle listener.
  assert.equal(sessionListeners(host).length, 2)
  assert.equal(host.listeners.filter((entry) => entry.name === 'agent/created').length, 1)

  // Every dev route and the M12 event feed are fiber-owned effects with a
  // label a later diagnostic can recognise.
  const labels = host.effects.map((entry) => entry.label)
  for (const path of DEV_ROUTES) {
    assert.equal(labels.includes(`dsh-cowork: route ${path}`), true, `missing effect for ${path}`)
  }
  assert.equal(labels.includes('dsh-cowork: M12 E2E session event feed'), true)
  assert.equal(labels.includes('dsh-cowork: M12 E2E runner'), true)
})

test('the dev health route reports the canonical repoPath and keeps the loopback gate (P0-F1)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cowork-gate-'))
  try {
    const real = join(root, 'repo')
    mkdirSync(real)
    const link = join(root, 'link')
    symlinkSync(real, link)

    const host = fakeHost()
    apply(host.ctx, { ...config(true), repoPath: link })

    const health = host.routes.find((route) => route.path === '/dsh-cowork/probe/health')
    assert.ok(health, 'the health route must be registered in dev mode')

    const ok = callRoute(health)
    assert.equal(ok.status, 200)
    assert.deepEqual(Object.keys(ok.json).sort(), ['host', 'ok', 'plugin', 'repoPath', 'version'])
    assert.equal(ok.json.ok, true)
    assert.equal(ok.json.plugin, packageJson.name)
    assert.equal(ok.json.version, packageJson.version)
    assert.equal(ok.json.repoPath, realpathSync(real))
    assert.notEqual(ok.json.repoPath, link)

    // The loopback-only admission and the method guard still run.
    assert.equal(callRoute(health, { remoteAddress: '10.0.0.2' }).status, 403)
    assert.equal(callRoute(health, { host: 'example.com' }).status, 403)
    assert.equal(callRoute(health, { method: 'POST' }).status, 405)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the retired M0 probe run and status routes are not registered', async () => {
  const host = fakeHost()
  apply(host.ctx, config(true))
  await settle()

  for (const path of ['/dsh-cowork/probe/run', '/dsh-cowork/probe/status']) {
    assert.equal(host.routes.some((route) => route.path === path), false, `${path} must be retired`)
  }
})

test('the M12 panel probe matches a query-string path to the bare registered route (F1)', () => {
  // The host registers the panel routes under the bare path; the probe calls
  // overview with `?sessionId=…`, so a raw Map lookup missed it in t6.
  const routes = new Map([[OVERVIEW_PATH, { path: OVERVIEW_PATH }]])
  const probePath = `${OVERVIEW_PATH}?sessionId=session-1`

  assert.equal(panelRoutePathname(probePath), OVERVIEW_PATH)
  assert.equal(routes.get(panelRoutePathname(probePath)), routes.get(OVERVIEW_PATH))
  assert.equal(panelRoutePathname(OVERVIEW_PATH), OVERVIEW_PATH)
  assert.equal(routes.get(panelRoutePathname('/api/cowork.unknown')), undefined)
  assert.equal(routes.get(panelRoutePathname(`${OVERVIEW_PATH}?sessionId=`)), routes.get(OVERVIEW_PATH))

  // The Request still carries the query string and the same-origin headers.
  const request = panelProbeRequest(probePath)
  assert.equal(new URL(request.url).searchParams.get('sessionId'), 'session-1')
  assert.equal(request.headers.get('host'), '127.0.0.1')
  assert.equal(request.headers.get('origin'), 'http://127.0.0.1')
})

test('src/index.ts stays an orchestration entry point under 30 KiB', () => {
  const file = new URL('../src/index.ts', import.meta.url)
  const bytes = statSync(file).size
  console.log(`# src/index.ts: ${bytes} B / ${INDEX_BUDGET_BYTES} B`)
  assert.ok(bytes <= INDEX_BUDGET_BYTES, `src/index.ts is ${bytes} B, over the ${INDEX_BUDGET_BYTES} B entry budget`)

  const source = readFileSync(file, 'utf8')
  // The moved concerns live in their own modules and are imported, not restated.
  assert.match(source, /from '\.\/config\.js'/, 'the entry point must import src/config.ts')
  assert.match(source, /from '\.\/dev-surfaces\.js'/, 'the entry point must import src/dev-surfaces.ts')
  for (const moved of [/z\.object\(/, /cowork_probe/, /probe\/run/, /createM12PanelProbe/]) {
    assert.equal(moved.test(source), false, `src/index.ts must not restate ${moved}`)
  }
})

test('disposing the plugin releases the dev session listeners', async () => {
  const host = fakeHost()
  apply(host.ctx, config(true))
  await settle()
  assert.equal(sessionListeners(host).length, 2)

  await disposeAll(host)

  assert.equal(sessionListeners(host).length, 0)
  // The memory prompt's agent/created listener is released too, so a hot
  // reload leaves no stale provider behind.
  assert.equal(host.listeners.length, 0)
})
