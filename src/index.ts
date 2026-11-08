/**
 * @dsh-external/dsh-cowork host plugin.
 *
 * The business surface — the panel API, the eleven cowork tools, the three
 * presets, and the project-memory prompt section — is always registered. The
 * M0/S0/M2/M3 probe and E2E surfaces (two probe tools, two probe presets, the
 * loopback-only start/status routes, and four session event feeds) only exist
 * when `Config.enableDevRoutes` is true, so an installed profile does not
 * expose them to users.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import type { CoworkApiHost, CoworkApiPorts } from './api.js'
import { registerCoworkApi } from './api.js'
import type { HealthView, ProbeConfig, ProbeHost } from './probe-engine.js'
import { PROBE_PRESET_ID, ProbeRunner } from './probe-engine.js'
import { MEMORY_FILES, MEMORY_KINDS, memoryFilePath, parseMemoryFile, renderMemoryBlock } from './memory.js'
import type { MemoryInjectInput } from './memory.js'
import { registerMemoryPrompt } from './memory-prompt.js'
import type { MemoryPromptAgent, MemoryPromptDeps, MemoryPromptHost, MemoryRender } from './memory-prompt.js'
import { M2E2ERunner } from './m2-e2e.js'
import type { M2E2EHost } from './m2-e2e.js'
import { M3E2ERunner, M3_E2E_RUN_PATH, M3_E2E_STATUS_PATH } from './m3-e2e.js'
import type { M3E2EHost } from './m3-e2e.js'
import { canonicalRepoPath, isLoopbackAddress, isLoopbackHost, readPath, readQuery, requireRunId } from './probe-model.js'
import { registerPresets } from './presets.js'
import type { S0Host, S0Identity } from './s0-probe.js'
import { EMPTY_PRESET_ID, S0Runner, THREAD_SMOKE_PRESET_ID } from './s0-probe.js'
import { ProjectStore, findProjectRoot, findProjectRootSync } from './store.js'
import { createLlmRoutingPort } from './llm-port.js'
import type { HostLlmLike } from './llm-port.js'
import { DEFAULT_ISOLATION_PROVIDER, DEFAULT_REVIEWER_RECLAIM } from './tool-runtime.js'
import type { CoworkToolDeps, CurrentModelRoute } from './tool-runtime.js'
import { registerCoworkTools } from './tools.js'
import { TopicEvents } from './topic-events.js'
import type { TopicEventLike, TopicEventSession } from './topic-events.js'
import { DEFAULT_IDLE_AFTER_MS, DEFAULT_RESOLVE_AFTER_MS } from './topic.js'

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { name: string; version: string }

const PLUGIN_NAME = packageJson.name
const PLUGIN_VERSION = packageJson.version

/** Health route: liveness, plugin identity, and preset registration state. */
const HEALTH_PATH = '/dsh-cowork/probe/health'
/** Run route: start one probe run and return its id immediately. */
const RUN_PATH = '/dsh-cowork/probe/run'
/** Status route: poll one run's phases, evidence, sessions, and error. */
const STATUS_PATH = '/dsh-cowork/probe/status'
/** S0 run route: start one M1 S0 probe run and return its id immediately. */
const S0_RUN_PATH = '/dsh-cowork/probe/s0'
/** S0 status route: poll one S0 run. */
const S0_STATUS_PATH = '/dsh-cowork/probe/s0-status'
/** M2 E2E run route: start one real-host run and return its id immediately. */
const M2_E2E_RUN_PATH = '/dsh-cowork/e2e/m2/run'
/** M2 E2E status route: poll one run's steps, evidence, and error. */
const M2_E2E_STATUS_PATH = '/dsh-cowork/e2e/m2/status'

/** Lossless JSON value accepted by the tool result boundary. */
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** The third routing layer's knobs (PLAN-V0.2 §5.10, M9.1). */
export interface RoutingConfig {
  /** Whether the model fallback may run at all. */
  enabled: boolean
  /** Model provider id; empty means "unset". */
  provider: string
  /** Model id; empty means "unset". */
  model: string
  /** Reasoning effort; empty means "unset". */
  effort: string
  /** Model-call timeout in milliseconds. */
  timeoutMs: number
  /** Model output cap in tokens. */
  maxTokens: number
}

/** Work-item isolation settings (PLAN-V0.2 §4.5); M10 implements `clone`. */
export interface IsolationConfig {
  /** Provider that creates an isolated work item; unknown values fail the tool. */
  provider: string
}

/** Reviewer lifecycle settings (PLAN-V0.2 §5.4); M10 supports one value. */
export interface ReviewerConfig {
  /** When the reviewer session is reclaimed after a verdict. */
  reclaim: string
}

/** Working defaults for the fields a caller may omit. */
const DEFAULT_PROMPT_TIMEOUT_MS = 120_000
const DEFAULT_STORE_RELATIVE_PATH = '.dsh-cowork/probe/store.json'
const DEFAULT_WORKTREE_RELATIVE_PATH = '.dsh-cowork/worktrees/probe'
const DEFAULT_ROUTING_TIMEOUT_MS = 2_000
const DEFAULT_ROUTING_MAX_TOKENS = 256

/** Plugin configuration; every field has a working default. */
export interface Config {
  /** Repository the probe writes under; defaults to this plugin's package root. */
  repoPath: string
  /** Upper bound for one prompt's turn and for any bounded wait; M0 pins 120s. */
  promptTimeoutMs: number
  /** Probe store path, relative to `repoPath`. */
  storeRelativePath: string
  /** Probe worktree path, relative to `repoPath`. */
  worktreeRelativePath: string
  /**
   * Register the M0/S0/M2/M3 probe and E2E surfaces. Off by default: an
   * installed profile keeps only the business tools, presets, and panel API.
   */
  enableDevRoutes: boolean
  /** Silence after which a topic displays as idle (PLAN §5.10: 2h). */
  idleAfterMs: number
  /** Silence after which a resolvable topic is resolved (PLAN §5.10: 3d). */
  resolveAfterMs: number
  /** Third-layer model fallback (PLAN §5.10). */
  routing: RoutingConfig
  /** Isolation used for work items (PLAN §4.5). */
  isolation: IsolationConfig
  /** Reviewer lifecycle (PLAN §5.4). */
  reviewer: ReviewerConfig
}

export const Config: z<Config> = z.object({
  repoPath: z.string().default(''),
  promptTimeoutMs: z.number().min(30_000).max(600_000).default(DEFAULT_PROMPT_TIMEOUT_MS),
  storeRelativePath: z.string().default(DEFAULT_STORE_RELATIVE_PATH),
  worktreeRelativePath: z.string().default(DEFAULT_WORKTREE_RELATIVE_PATH),
  enableDevRoutes: z.boolean().default(false),
  idleAfterMs: z.number().min(0).default(DEFAULT_IDLE_AFTER_MS),
  resolveAfterMs: z.number().min(0).default(DEFAULT_RESOLVE_AFTER_MS),
  routing: z.object({
    enabled: z.boolean().default(true),
    provider: z.string().default(''),
    model: z.string().default(''),
    effort: z.string().default(''),
    timeoutMs: z.number().min(1).default(DEFAULT_ROUTING_TIMEOUT_MS),
    maxTokens: z.number().min(1).default(DEFAULT_ROUTING_MAX_TOKENS),
  }),
  isolation: z.object({
    provider: z.string().default(DEFAULT_ISOLATION_PROVIDER),
  }),
  reviewer: z.object({
    reclaim: z.string().default(DEFAULT_REVIEWER_RECLAIM),
  }),
})

/**
 * Fill every omitted configuration field with its documented default.
 *
 * The host feeds `apply` a schema-validated `Config`, but tests and future
 * embedders construct one by hand; routing must not crash because one nested
 * object is missing. This is the single place that knows the defaults, and
 * `apply` uses only its result.
 */
export function normalizeConfig(
  config: Partial<Config> & {
    routing?: Partial<RoutingConfig> | null
    isolation?: Partial<IsolationConfig> | null
    reviewer?: Partial<ReviewerConfig> | null
  },
): Config {
  return {
    repoPath: config.repoPath ?? '',
    promptTimeoutMs: config.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
    storeRelativePath: config.storeRelativePath ?? DEFAULT_STORE_RELATIVE_PATH,
    worktreeRelativePath: config.worktreeRelativePath ?? DEFAULT_WORKTREE_RELATIVE_PATH,
    enableDevRoutes: config.enableDevRoutes ?? false,
    idleAfterMs: config.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS,
    resolveAfterMs: config.resolveAfterMs ?? DEFAULT_RESOLVE_AFTER_MS,
    routing: {
      enabled: config.routing?.enabled ?? true,
      provider: config.routing?.provider ?? '',
      model: config.routing?.model ?? '',
      effort: config.routing?.effort ?? '',
      timeoutMs: config.routing?.timeoutMs ?? DEFAULT_ROUTING_TIMEOUT_MS,
      maxTokens: config.routing?.maxTokens ?? DEFAULT_ROUTING_MAX_TOKENS,
    },
    isolation: {
      provider: config.isolation?.provider ?? DEFAULT_ISOLATION_PROVIDER,
    },
    reviewer: {
      reclaim: config.reviewer?.reclaim ?? DEFAULT_REVIEWER_RECLAIM,
    },
  }
}

/** Host services this plugin cannot activate without. */
export const inject = ['webServer', 'tools', 'agentPresets', 'sessionController', 'workspaceRegistry', 'agents']

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function loopbackOnly(request: IncomingMessage): boolean {
  return isLoopbackAddress(request.socket.remoteAddress)
    && isLoopbackHost(request.headers.host)
}

function sendMethodNotAllowed(response: ServerResponse, allow: string): void {
  response.setHeader('allow', allow)
  sendJson(response, 405, { ok: false, error: 'method not allowed' })
}

function guard(request: IncomingMessage, response: ServerResponse, allow: string): boolean {
  if (!loopbackOnly(request)) {
    sendJson(response, 403, { ok: false, error: 'loopback requests only' })
    return false
  }
  if (request.method !== allow) {
    sendMethodNotAllowed(response, allow)
    return false
  }
  return true
}

/** The plugin root (the directory holding package.json), used as the default repo. */
function defaultRepoPath(): string {
  return resolve(fileURLToPath(new URL('..', import.meta.url)))
}

/**
 * Host services the M1 assembly reads. The plugin cannot import the app's own
 * types, so these stay structural; the shapes are the ones S0 confirmed
 * (`agentPresets.register`, `sessionController`, `workspaceRegistry`).
 */
interface CoworkAssemblyHost {
  sessionController: CoworkToolDeps['sessionController']
  workspaceRegistry: CoworkToolDeps['workspaceRegistry']
  agentPresets: CoworkToolDeps['agentPresets']
  /** The live agent registry, read to attach the memory section to existing agents. */
  agents: { list(): readonly MemoryPromptAgent[] }
}

/**
 * Render the project memory block for one repository.
 *
 * Synchronous by contract: the system-prompt provider is synchronous, so the
 * three files are read with `readFileSync`. A missing file is empty memory; any
 * other read failure disables injection for this prompt rather than quoting a
 * half-read file. The digest is the sha1 of the rendered text, which is what
 * lets the section cache its output until the memory actually changes.
 */
function renderProjectMemory(repoPath: string): MemoryRender | null {
  const inputs: MemoryInjectInput[] = []
  for (const kind of MEMORY_KINDS) {
    let content = ''
    try {
      content = readFileSync(memoryFilePath(repoPath, kind), 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null
    }
    inputs.push({ kind, entries: parseMemoryFile(kind, MEMORY_FILES[kind], content).entries })
  }
  const block = renderMemoryBlock(inputs)
  if (block.text === '') return null
  const text = `Project memory for ${repoPath}:\n\n${block.text}`
  return { text, digest: createHash('sha1').update(text).digest('hex') }
}

/**
 * One row of the host's session listing as it exists at runtime. The shared
 * `SessionSlicePorts['sessions'].list` type models rows as `{ sessionId,
 * running }` only; the real summary also carries `cwd` (SessionSummary in the
 * host API catalog). Declared locally instead of widening the shared slice,
 * which other tools depend on.
 */
interface HostSessionListRow {
  sessionId: string
  cwd?: string
}

/** Dev-probe knobs, read only when {@link Config.enableDevRoutes} is on. */
interface DevSurfaceOptions {
  /** Configured repository path, before symlink canonicalization. */
  repoPath: string
  promptTimeoutMs: number
  storeRelativePath: string
  worktreeRelativePath: string
}

/**
 * Register the M0/S0/M2/M3 probe and E2E surfaces: two probe tools, two probe
 * presets, the loopback-only start/status routes, and the four session event
 * feeds. Every registration is an effect owned by this fiber, so an unload
 * leaves neither a route nor a listener behind.
 */
function registerDevSurfaces(ctx: Context, options: DevSurfaceOptions): void {
  const host = ctx as unknown as ProbeHost
  const probeConfig: ProbeConfig = {
    // The host canonicalizes a session cwd (/tmp → /private/tmp on macOS); the
    // probe must compare against the same real path or its assertions fail.
    repoPath: canonicalRepoPath(options.repoPath),
    promptTimeoutMs: options.promptTimeoutMs,
    storeRelativePath: options.storeRelativePath,
    worktreeRelativePath: options.worktreeRelativePath,
  }
  const runner = new ProbeRunner(host, probeConfig, PLUGIN_NAME, PLUGIN_VERSION)
  const s0 = new S0Runner(ctx as unknown as S0Host, {
    repoPath: probeConfig.repoPath,
    promptTimeoutMs: probeConfig.promptTimeoutMs,
  })
  // M2 real-host E2E: loopback-only start/status routes, evidence under .dsh-cowork/e2e/.
  const m2e2e = new M2E2ERunner(ctx as unknown as M2E2EHost, {
    repoPath: probeConfig.repoPath,
    promptTimeoutMs: probeConfig.promptTimeoutMs,
    pluginName: PLUGIN_NAME,
    pluginVersion: PLUGIN_VERSION,
    log: (message) => ctx.logger?.info?.(`[${PLUGIN_NAME}] ${message}`),
  })
  // M3 real-host E2E: independent review gate, two review rounds, evidence under
  // .dsh-cowork/e2e/M3_E2E.json. Same loopback-only start/status shape as M2.
  const m3e2e = new M3E2ERunner(ctx as unknown as M3E2EHost, {
    repoPath: probeConfig.repoPath,
    promptTimeoutMs: probeConfig.promptTimeoutMs,
    pluginName: PLUGIN_NAME,
    pluginVersion: PLUGIN_VERSION,
    log: (message) => ctx.logger?.info?.(`[${PLUGIN_NAME}] ${message}`),
  })

  // Risk 3: a preset registered at runtime, owned by this fiber's lifetime.
  ctx.effect(() => {
    const registration = host.agentPresets.register({
      id: PROBE_PRESET_ID,
      name: 'cowork probe',
      description: 'M0 probe preset: registered at runtime, mounts no extra plugins.',
      plugins: [],
    })
    void registration.then(
      () => runner.markPresetRegistered(),
      () => { /* registration failure surfaces through health and the preset phase */ },
    )
    return registration
  }, 'dsh-cowork: runtime agent preset')

  // S0: explicit plugin rows prove whether a cowork-thread preset can carry tools.
  ctx.effect(() => host.agentPresets.register({
    id: THREAD_SMOKE_PRESET_ID,
    name: 'cowork thread s0',
    description: 'M1 S0 probe preset: persona plus explicit tool rows.',
    plugins: [
      {
        id: 'persona',
        name: '@deepseek-ai/dsh-persona',
        config: { prefix: 'You are a cowork thread probe. Use your tools to inspect the repository when asked.' },
      },
      { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
      { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
      { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
      { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    ],
  }), 'dsh-cowork: S0 thread preset')

  // S0: report the calling session identity to answer whether `exec.agent` exists.
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'cowork_identity_probe',
    description: 'Temporary M1 S0 probe: report the calling session id, cwd, preset, and execution keys. Read-only.',
    parameters: {
      token: { type: 'string', required: true, description: 'Evidence label, e.g. "master" or "thread".' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args: { token: string }, exec): Promise<JsonValue> => {
      const caller = exec as unknown as {
        agent?: {
          id?: string
          session?: { header?: { cwd?: string; agentPreset?: string } }
        }
      }
      const identity: S0Identity = {
        token: args.token,
        agentId: caller.agent?.id ?? null,
        cwd: caller.agent?.session?.header?.cwd ?? null,
        agentPreset: caller.agent?.session?.header?.agentPreset ?? null,
        execKeys: Object.keys(exec).sort(),
        hasAgent: caller.agent !== undefined,
      }
      s0.recordIdentity(identity)
      return JSON.parse(JSON.stringify(identity)) as JsonValue
    },
  })), 'dsh-cowork: S0 identity probe tool')

  // One read-only tool: health plus the last run summary.
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'cowork_probe',
    description: 'Read the dsh-cowork M0 probe health and the last run summary. Starts no work.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (): Promise<JsonValue> => {
      const payload = { health: runner.health(), lastRun: runner.lastRun() ?? null }
      return JSON.parse(JSON.stringify(payload)) as JsonValue
    },
  })), 'dsh-cowork: cowork_probe tool')

  const routes: WebRoute[] = [
    {
      kind: 'exact',
      path: HEALTH_PATH,
      handler: (request, response) => {
        if (!guard(request, response, 'GET')) return
        sendJson(response, 200, runner.health())
      },
    },
    {
      kind: 'exact',
      path: RUN_PATH,
      handler: (request, response) => {
        if (!guard(request, response, 'POST')) return
        request.resume()
        try {
          const run = runner.start()
          sendJson(response, 200, { runId: run.runId, state: run.state })
        } catch (error) {
          sendJson(response, 409, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            lastRunId: runner.lastRun()?.runId ?? null,
          })
        }
      },
    },
    {
      kind: 'exact',
      path: STATUS_PATH,
      handler: async (request, response) => {
        if (!guard(request, response, 'GET')) return
        let runId: string
        try {
          runId = requireRunId(readQuery(request.url, 'runId'))
        } catch (error) {
          sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          return
        }
        const run = await runner.resolve(runId)
        if (run === undefined) {
          sendJson(response, 404, { ok: false, error: `unknown runId: ${runId}` })
          return
        }
        sendJson(response, 200, run)
      },
    },
  ]
  routes.push({
    kind: 'exact',
    path: S0_RUN_PATH,
    handler: (request, response) => {
      if (!guard(request, response, 'POST')) return
      request.resume()
      try {
        const run = s0.start()
        sendJson(response, 200, { runId: run.runId, state: run.state })
      } catch (error) {
        sendJson(response, 409, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }, {
    kind: 'exact',
    path: S0_STATUS_PATH,
    handler: async (request, response) => {
      if (!guard(request, response, 'GET')) return
      let runId: string
      try {
        runId = requireRunId(readQuery(request.url, 'runId'))
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        return
      }
      const run = await s0.resolve(runId)
      if (run === undefined) {
        sendJson(response, 404, { ok: false, error: `unknown S0 runId: ${runId}` })
        return
      }
      sendJson(response, 200, run)
    },
  }, {
    kind: 'exact',
    path: M2_E2E_RUN_PATH,
    handler: (request, response) => {
      if (!guard(request, response, 'POST')) return
      request.resume()
      try {
        const run = m2e2e.start()
        sendJson(response, 200, { ok: true, runId: run.runId })
      } catch (error) {
        sendJson(response, 409, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }, {
    kind: 'exact',
    path: M2_E2E_STATUS_PATH,
    handler: async (request, response) => {
      if (!guard(request, response, 'GET')) return
      let runId: string
      try {
        runId = requireRunId(readQuery(request.url, 'runId'))
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        return
      }
      const run = await m2e2e.resolve(runId)
      if (run === undefined) {
        sendJson(response, 404, { ok: false, error: `unknown M2 E2E runId: ${runId}` })
        return
      }
      sendJson(response, 200, {
        ok: true,
        runId: run.runId,
        state: run.state,
        startedAt: run.startedAt,
        ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
        steps: run.steps,
        evidenceFile: run.evidenceFile,
        ...(run.error === undefined ? {} : { error: run.error }),
      })
    },
  }, {
    kind: 'exact',
    path: M3_E2E_RUN_PATH,
    handler: (request, response) => {
      if (!guard(request, response, 'POST')) return
      request.resume()
      try {
        const run = m3e2e.start()
        sendJson(response, 200, { ok: true, runId: run.runId })
      } catch (error) {
        sendJson(response, 409, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }, {
    kind: 'exact',
    path: M3_E2E_STATUS_PATH,
    handler: async (request, response) => {
      if (!guard(request, response, 'GET')) return
      let runId: string
      try {
        runId = requireRunId(readQuery(request.url, 'runId'))
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        return
      }
      const run = await m3e2e.resolve(runId)
      if (run === undefined) {
        sendJson(response, 404, { ok: false, error: `unknown M3 E2E runId: ${runId}` })
        return
      }
      sendJson(response, 200, {
        ok: true,
        runId: run.runId,
        state: run.state,
        startedAt: run.startedAt,
        ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
        steps: run.steps,
        evidenceFile: run.evidenceFile,
        ...(run.error === undefined ? {} : { error: run.error }),
      })
    },
  })

  for (const route of routes) {
    ctx.effect(() => ctx.webServer.register(route), `dsh-cowork: route ${readPath(route.path)}`)
  }

  ctx.effect(() => runner.attachEvents(), 'dsh-cowork: session event feed')
  ctx.effect(() => s0.attachEvents(), 'dsh-cowork: S0 session event feed')
  ctx.effect(() => m2e2e.attachEvents(), 'dsh-cowork: M2 E2E session event feed')
  ctx.effect(() => m3e2e.attachEvents(), 'dsh-cowork: M3 E2E session event feed')
  ctx.effect(() => () => {
    runner.dispose()
    s0.dispose()
    m2e2e.dispose()
    m3e2e.dispose()
  }, 'dsh-cowork: probe runners')

  ctx.logger?.info?.(`[${PLUGIN_NAME}] M0 probe ready at ${HEALTH_PATH} (repo ${probeConfig.repoPath})`)
  ctx.logger?.info?.(`[${PLUGIN_NAME}] M1 S0 probe ready at ${S0_RUN_PATH}`)
}

/** The host default-model service slice (M9.3b). */
interface HostAgentDefaultModel {
  currentSelection(): { provider?: unknown; model?: unknown } | null | undefined
}

/** Read one optional host service without making it a required injection. */
function hostService<T>(ctx: Context, name: string): T | undefined {
  const get = (ctx as unknown as { get?: (key: string) => unknown }).get
  if (typeof get !== 'function') return undefined
  try {
    return get.call(ctx, name) as T | undefined
  } catch {
    return undefined
  }
}

/**
 * The host's current default model route, used when `routing.provider/model`
 * are unset. Swallowing a missing service keeps this an optional enhancement.
 */
function hostCurrentModelRoute(ctx: Context): () => CurrentModelRoute | null {
  return () => {
    const service = hostService<HostAgentDefaultModel>(ctx, 'agentDefaultModel')
    if (service === undefined || service === null || typeof service.currentSelection !== 'function') return null
    try {
      const selection = service.currentSelection()
      if (
        typeof selection?.provider === 'string' && selection.provider.trim() !== ''
        && typeof selection.model === 'string' && selection.model.trim() !== ''
      ) {
        return { provider: selection.provider, model: selection.model }
      }
      return null
    } catch {
      return null
    }
  }
}

/** Register the business surface, plus the opt-in dev probe surface when enabled. */
export function apply(ctx: Context, config: Config): void {
  // One normalized view of the settings: a hand-built partial config (tests,
  // embedders) must not crash routing because `routing` is absent.
  const settings = normalizeConfig(config)
  // M10 supports exactly one reviewer reclaim mode. Any other value fails
  // startup instead of quietly pretending to support it (PLAN §5.4, M10 §8).
  if (settings.reviewer.reclaim !== DEFAULT_REVIEWER_RECLAIM) {
    throw new Error(
      `${PLUGIN_NAME}: reviewer.reclaim must be '${DEFAULT_REVIEWER_RECLAIM}' (M10 supports only after-verdict); got '${settings.reviewer.reclaim}'`,
    )
  }
  // M1 assembly services: one dependency bag for the presets and the fourteen tools.
  const assembly = ctx as unknown as CoworkAssemblyHost
  // Business repo path: identical in both dev modes and unchanged from M0-M3.
  // Only the dev probe canonicalizes it, because only the probe compares paths
  // against a host session cwd.
  const repoPath = settings.repoPath === '' ? defaultRepoPath() : resolve(settings.repoPath)
  const coworkDeps: CoworkToolDeps = {
    sessionController: assembly.sessionController,
    workspaceRegistry: assembly.workspaceRegistry,
    agentPresets: assembly.agentPresets,
    clock: () => new Date(),
    resolveRepoPath: () => repoPath,
    // M9.1/M9.3a: the tool layer owns the lifecycle read point. The values come
    // from the normalized config, never from a second set of defaults here.
    idleAfterMs: settings.idleAfterMs,
    resolveAfterMs: settings.resolveAfterMs,
    isolationProvider: settings.isolation.provider,
    reviewerReclaim: settings.reviewer.reclaim,
    routing: settings.routing,
    // M9.3b: the only host LLM entry point. Missing services leave the third
    // layer on its structured fallback; they never fail a route.
    llmRoutingPort: createLlmRoutingPort(hostService<HostLlmLike>(ctx, 'llm')),
    currentModelRoute: hostCurrentModelRoute(ctx),
  }

  // M2 panel: read-only HTTP routes over the host connection service. The
  // project root is derived from the session's own cwd, never from the request.
  const panelPorts: CoworkApiPorts = {
    // Metadata only: `inspect` also reads the session event log and hung the
    // panel requests on running or large sessions.
    listSessions: () => assembly.sessionController.list() as Promise<{
      items: readonly HostSessionListRow[]
    }>,
    findProjectRoot,
    // Same construction as the tool layer: a panel-triggered migration must
    // archive a cancelled reviewer through the host, not record a fake failure.
    createStore: (repoPath) => new ProjectStore({
      repoPath,
      archiveSession: (sessionId, options) => assembly.workspaceRegistry.archiveSession(sessionId, options),
    }),
  }
  registerCoworkApi(ctx as unknown as CoworkApiHost, panelPorts)

  // M8.2: the session event stream keeps topic activity fresh and reopens a
  // resolved topic when its owner returns. The rules live in topic-events.ts
  // behind injected ports; this effect releases the listener on unload.
  const topicEvents = new TopicEvents({
    onSessionEvent: (listener) => (ctx as unknown as {
      on(
        name: 'session/event',
        handler: (session: TopicEventSession, event: TopicEventLike) => void,
      ): () => void
    }).on('session/event', listener),
    resolveRepoPath: async (session) => {
      const cwd = session.header?.cwd
      if (typeof cwd !== 'string' || cwd === '') return null
      return findProjectRoot(cwd)
    },
    storeFor: (repoPath) => new ProjectStore({
      repoPath,
      clock: () => new Date(),
      archiveSession: (sessionId, options) => assembly.workspaceRegistry.archiveSession(sessionId, options),
    }),
    clock: () => new Date(),
    log: (message) => ctx.logger?.warn?.(`[${PLUGIN_NAME}] ${message}`),
  })
  ctx.effect(() => topicEvents.attach(), 'dsh-cowork: topic lifecycle events')

  // Dev surfaces are opt-in: an installed profile never exposes the probe
  // routes, the probe tools, the probe presets, or the session event feeds.
  if (settings.enableDevRoutes) {
    registerDevSurfaces(ctx, {
      repoPath,
      promptTimeoutMs: settings.promptTimeoutMs,
      storeRelativePath: settings.storeRelativePath,
      worktreeRelativePath: settings.worktreeRelativePath,
    })
  }

  // M1: the three runtime presets and the eleven cowork tools, owned by this fiber.
  ctx.effect(() => registerPresets(coworkDeps.agentPresets).then((disposers) => async () => {
    for (const dispose of disposers) await dispose()
  }), 'dsh-cowork: cowork presets')

  ctx.effect(() => {
    const disposers = registerCoworkTools(ctx, coworkDeps)
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-cowork: cowork tools')

  // M2: project memory rides in the system prompt of every cowork agent. The
  // section is registered per agent (current and future) and released when the
  // plugin unloads, so a hot reload does not leave a stale provider behind.
  const memoryHost: MemoryPromptHost = {
    onAgentCreated: (listener) => {
      const events = ctx as unknown as {
        on(
          name: string,
          handler: (payload: { agent: MemoryPromptAgent; source?: string }) => void,
        ): () => void
      }
      return events.on('agent/created', (payload) => listener(payload))
    },
    listAgents: () => assembly.agents.list(),
  }
  const memoryDeps: MemoryPromptDeps = {
    resolveProjectRoot: (cwd) => findProjectRootSync(cwd),
    renderMemory: (repoPath) => renderProjectMemory(repoPath),
    log: (message) => ctx.logger?.warn?.(message),
  }
  ctx.effect(() => {
    const registration = registerMemoryPrompt(memoryHost, memoryDeps)
    if (registration.duplicateSkipped() > 0) {
      ctx.logger?.warn?.(
        `[${PLUGIN_NAME}] ${registration.duplicateSkipped()} cowork memory section(s) already registered; skipped`,
      )
    }
    return () => registration.dispose()
  }, 'dsh-cowork: project memory prompt')

  ctx.logger?.info?.(`[${PLUGIN_NAME}] cowork tools, presets, and panel ready`)
}
