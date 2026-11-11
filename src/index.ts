/**
 * @dsh-external/dsh-cowork host plugin.
 *
 * The business surface — the panel API, the nineteen cowork tools, the three
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
import type { CoworkApiHost, CoworkApiPorts, PanelFetchRoute } from './api.js'
import { registerCoworkApi } from './api.js'
import { AUTHORIZATION_RESOLVE_PATH, OVERVIEW_PATH, REOPEN_PATH, RESOLVE_PATH } from './api-contract.js'
import { panelProbeRequest, panelRoutePathname } from './panel-probe.js'

export { panelRoutePathname }
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
import { M12E2ERunner, M12_E2E_RUN_PATH, M12_E2E_STATUS_PATH } from './m12-e2e.js'
import type { M12E2EHost, M12PanelProbe } from './m12-e2e.js'
import { canonicalRepoPath, isLoopbackAddress, isLoopbackHost, readPath, readQuery, requireRunId } from './probe-model.js'
import { registerPresets } from './presets.js'
import { HIDDEN_PRESET_IDS, hidePresetsFromRoster } from './preset-visibility.js'
import type { PresetRosterService } from './preset-visibility.js'
import type { S0Host, S0Identity } from './s0-probe.js'
import { EMPTY_PRESET_ID, S0Runner, THREAD_SMOKE_PRESET_ID } from './s0-probe.js'
import { ProjectStore, findProjectRoot, findProjectRootSync } from './store.js'
import { SessionSlice } from './session-slice.js'
import { createLlmRoutingPort } from './llm-port.js'
import type { HostLlmLike } from './llm-port.js'
import { DEFAULT_ISOLATION_PROVIDER, DEFAULT_REVIEWER_RECLAIM } from './tool-runtime.js'
import { NoopTopicNoticePort, TopicNoticeDispatcher } from './notices.js'
import type { CoworkToolDeps, CurrentModelRoute } from './tool-runtime.js'
import { registerCoworkTools } from './tools.js'
import { TopicEvents } from './topic-events.js'
import type { TopicEventLike, TopicEventSession } from './topic-events.js'
import { DEFAULT_IDLE_AFTER_MS, DEFAULT_RESOLVE_AFTER_MS } from './topic.js'
import { repairCoworkWorkspaces } from './workspace-repair.js'

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
  /** Silence after which a topic displays as idle (24h). */
  idleAfterMs: number
  /**
   * Deprecated and ignored: the lifecycle never resolves a topic on its own any
   * more (archiving is a user action). Kept so an existing profile still loads.
   */
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
 * The host workspace registry as DSH exposes it: the operations the shared
 * port models, plus `get(id)` for the live entity. Binding an existing session
 * is an entity operation (`attachSession`), which is why the port takes the
 * workspace id and the lookup happens here.
 */
type HostWorkspaceRegistry = CoworkToolDeps['workspaceRegistry'] & {
  get(id: string): { attachSession(sessionId: string): Promise<void> } | undefined
}

/**
 * Host services the M1 assembly reads. The plugin cannot import the app's own
 * types, so these stay structural; the shapes are the ones S0 confirmed
 * (`agentPresets.register`, `sessionController`, `workspaceRegistry`).
 */
interface CoworkAssemblyHost {
  sessionController: CoworkToolDeps['sessionController']
  workspaceRegistry: HostWorkspaceRegistry
  agentPresets: CoworkToolDeps['agentPresets']
  /** The live agent registry, read to attach the memory section to existing agents. */
  agents: { list(): readonly MemoryPromptAgent[] }
}

/** The workspace port with the entity-backed attachment the repair needs. */
interface CoworkWorkspacePorts extends Omit<CoworkToolDeps['workspaceRegistry'], 'attachSession'> {
  attachSession(workspaceId: string, sessionId: string): Promise<void>
}

/**
 * Project the host registry onto the slice's workspace port. Every other
 * operation is forwarded unchanged; `attachSession` resolves the live entity
 * first, because attaching is an operation on the workspace, not the registry.
 */
function workspacePortsOf(registry: HostWorkspaceRegistry): CoworkWorkspacePorts {
  return {
    resolveByPath: (path) => registry.resolveByPath(path),
    create: (path, title) => registry.create(path, title),
    delete: (id) => registry.delete(id),
    archiveSession: (sessionId, options) => registry.archiveSession(sessionId, options),
    attachSession: async (workspaceId, sessionId) => {
      const workspace = registry.get(workspaceId)
      if (workspace === undefined) {
        throw new Error(
          `workspace '${workspaceId}' is not registered, so it cannot own session '${sessionId}'`,
        )
      }
      await workspace.attachSession(sessionId)
    },
  }
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
  /** In-process panel API probe the M12 driver uses for its route assertions. */
  panel: M12PanelProbe
  /** Configured lifecycle thresholds; the M12 driver refuses anything but the short ones. */
  idleAfterMs: number
  resolveAfterMs: number
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
  // M12 real-host E2E: the 0.2.0 topic-session chain, run in a throwaway
  // repository under os.tmpdir(); evidence under .dsh-cowork/e2e/M12_E2E.json.
  const m12e2e = new M12E2ERunner(ctx as unknown as M12E2EHost, {
    repoPath: probeConfig.repoPath,
    promptTimeoutMs: probeConfig.promptTimeoutMs,
    idleAfterMs: options.idleAfterMs,
    resolveAfterMs: options.resolveAfterMs,
    pluginName: PLUGIN_NAME,
    pluginVersion: PLUGIN_VERSION,
    panel: options.panel,
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

  // S0: explicit plugin rows prove whether a thread-smoke preset can carry tools.
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
  }, {
    kind: 'exact',
    path: M12_E2E_RUN_PATH,
    handler: (request, response) => {
      if (!guard(request, response, 'POST')) return
      request.resume()
      try {
        // `keep=1` keeps the throwaway project for a debug run; `base=<ref>`
        // names the artifact diff base (the M12 base commit).
        const keep = readQuery(request.url, 'keep')
        const run = m12e2e.start({
          keep: keep === '1' || keep === 'true',
          baseRef: readQuery(request.url, 'base') ?? '',
        })
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
    path: M12_E2E_STATUS_PATH,
    handler: async (request, response) => {
      if (!guard(request, response, 'GET')) return
      let runId: string
      try {
        runId = requireRunId(readQuery(request.url, 'runId'))
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        return
      }
      const run = await m12e2e.resolve(runId)
      if (run === undefined) {
        sendJson(response, 404, { ok: false, error: `unknown M12 E2E runId: ${runId}` })
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
  ctx.effect(() => m12e2e.attachEvents(), 'dsh-cowork: M12 E2E session event feed')
  ctx.effect(() => () => {
    runner.dispose()
    s0.dispose()
    m2e2e.dispose()
    m3e2e.dispose()
    m12e2e.dispose()
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

/** The seven panel routes' shared ports; production and the M12 probe use the same ones. */
function createPanelPorts(
  ctx: Context,
  assembly: CoworkAssemblyHost,
  settings: Config,
  notices: { port: NoopTopicNoticePort; kick(repoPath: string): void },
): CoworkApiPorts {
  return {
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
      clock: () => new Date(),
      archiveSession: (sessionId, options) => assembly.workspaceRegistry.archiveSession(sessionId, options),
    }),
    // M11: the panel's lifecycle read point uses the same clock and threshold
    // as the tool layer, and logs a failed activity row instead of failing the
    // request. `resolveAfterMs` is no longer read: nothing auto-resolves.
    now: () => new Date(),
    idleAfterMs: settings.idleAfterMs,
    // The topic page's archive/reopen/authorization semantics need the host
    // session and notice ports; a failure is logged there, not returned.
    archiveSession: (sessionId, options) => assembly.workspaceRegistry.archiveSession(sessionId, options),
    unarchiveSession: (sessionId) => {
      const port = assembly.workspaceRegistry.unarchiveSession
      if (port === undefined) throw new Error('the host workspace registry exposes no unarchiveSession')
      return port.call(assembly.workspaceRegistry, sessionId)
    },
    promptSession: (sessionId, text) => new SessionSlice({
      sessions: assembly.sessionController,
      workspaces: assembly.workspaceRegistry,
    }).promptSession(sessionId, text),
    noticePort: notices.port,
    kickNotices: (repoPath) => notices.kick(repoPath),
    log: (message) => ctx.logger?.warn?.(`[${PLUGIN_NAME}] ${message}`),
  }
}

/**
 * In-process probe for the M12 E2E driver. A plugin has no client for the host
 * `connection` channel, so the probe registers the production panel handlers on
 * a private connection and calls them with a real `Request`. The handlers,
 * guards, store, and lifecycle read point are the shipped ones; only the host's
 * HTTP transport is bypassed, which the evidence document states.
 */
function createM12PanelProbe(ports: CoworkApiPorts): M12PanelProbe {
  const routes = new Map<string, PanelFetchRoute>()
  const connection = {
    fetch: {
      register(route: PanelFetchRoute): () => Promise<void> {
        routes.set(route.path, route)
        return async () => {}
      },
    },
  }
  const host: CoworkApiHost = {
    get: (name) => (name === 'connection' ? connection : undefined),
    effect: (execute) => {
      execute()
    },
  }
  registerCoworkApi(host, ports)
  const call = async (path: string, init: RequestInit): Promise<{ status: number; body: unknown }> => {
    const route = routes.get(panelRoutePathname(path))
    if (route === undefined) throw new Error(`M12 panel probe: no route registered for ${path}`)
    const response = await route.fetch(panelProbeRequest(path, init))
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    return { status: response.status, body }
  }
  return {
    overview: (input) => call(
      `${OVERVIEW_PATH}?sessionId=${encodeURIComponent(input.sessionId)}`,
      { method: 'GET' },
    ),
    reopen: (input) => call(REOPEN_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: input.sessionId, topicId: input.topicId }),
    }),
    resolve: (input) => call(RESOLVE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: input.sessionId, topicId: input.topicId }),
    }),
    authorizationResolve: (input) => call(AUTHORIZATION_RESOLVE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
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
  // M1 assembly services: one dependency bag for the presets and the nineteen tools.
  const assembly = ctx as unknown as CoworkAssemblyHost
  // Business repo path: identical in both dev modes and unchanged from M0-M3.
  // Only the dev probe canonicalizes it, because only the probe compares paths
  // against a host session cwd.
  const repoPath = settings.repoPath === '' ? defaultRepoPath() : resolve(settings.repoPath)
  const workspacePorts = workspacePortsOf(assembly.workspaceRegistry)
  // Topic notices (B mode): the host has no notice channel, so the port reports
  // `supported: false` and the ledger stays pending. The dispatcher is wired and
  // disposed with the fiber so an A2 adapter can replace only the port later.
  const noticePort = new NoopTopicNoticePort()
  const noticeDispatcher = new TopicNoticeDispatcher({
    storeFor: (repoPath) => new ProjectStore({
      repoPath,
      clock: () => new Date(),
      archiveSession: (sessionId, options) => assembly.workspaceRegistry.archiveSession(sessionId, options),
    }),
    port: noticePort,
    clock: () => new Date(),
    log: (message) => ctx.logger?.warn?.(`[${PLUGIN_NAME}] ${message}`),
  })
  ctx.effect(() => () => noticeDispatcher.dispose(), 'dsh-cowork: notice dispatcher')
  const noticeRuntime = {
    port: noticePort,
    kick: (repoPath: string) => noticeDispatcher.kick(repoPath),
  }

  const coworkDeps: CoworkToolDeps = {
    sessionController: assembly.sessionController,
    workspaceRegistry: workspacePorts,
    agentPresets: assembly.agentPresets,
    clock: () => new Date(),
    resolveRepoPath: () => repoPath,
    // Non-fatal degradations (for example an unbound workspace) reach the host
    // log as warnings; a tool result still reports its own failure state.
    log: (message) => ctx.logger?.warn?.(`[${PLUGIN_NAME}] ${message}`),
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
    notices: noticeRuntime,
  }

  // M11 panel: three read routes and four write routes over the host connection
  // service. The project root is derived from the session's own cwd, never from
  // the request.
  const panelPorts = createPanelPorts(ctx, assembly, settings, noticeRuntime)
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

  // Transitional (KI-39): the target is registration at cowork_project_init or
  // session creation. This startup pass only repairs records already lost; it
  // must be removed when KI-39 closes. A workspace record the registry loses is
  // not rebuilt from session headers once its domain is initialized, so a
  // healthy Cowork project can vanish from the sidebar after a restart even
  // though its index and sessions are intact. Re-create only the missing
  // records for sessions that already sit at a Cowork project root, then attach
  // those sessions. The pass is bounded and every failure is logged: a failed
  // repair must never fail plugin startup.
  ctx.effect(() => {
    let active = true
    void repairCoworkWorkspaces({
      listSessions: async () => (await assembly.sessionController.list() as {
        items: readonly HostSessionListRow[]
      }).items,
      resolveProjectRoot: findProjectRoot,
      resolveWorkspace: (path) => workspacePorts.resolveByPath(path),
      createWorkspace: (path) => workspacePorts.create(path),
      attachSession: (workspaceId, sessionId) => workspacePorts.attachSession(workspaceId, sessionId),
    }).then((result) => {
      if (!active) return
      if (result.createdWorkspaces.length > 0 || result.attachedSessions > 0) {
        ctx.logger?.info?.(
          `[${PLUGIN_NAME}] workspace repair: created ${result.createdWorkspaces.length} workspace(s), attached ${result.attachedSessions} session(s)`,
        )
      }
      for (const error of result.errors) {
        ctx.logger?.warn?.(`[${PLUGIN_NAME}] workspace repair: ${error}`)
      }
    }).catch((error) => {
      // The repair reports its own failures; this arm only guards a programming
      // error and still must not fail startup.
      ctx.logger?.warn?.(
        `[${PLUGIN_NAME}] workspace repair failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    return () => {
      active = false
    }
  }, 'dsh-cowork: workspace repair')

  // Dev surfaces are opt-in: an installed profile never exposes the probe
  // routes, the probe tools, the probe presets, or the session event feeds.
  if (settings.enableDevRoutes) {
    registerDevSurfaces(ctx, {
      repoPath,
      promptTimeoutMs: settings.promptTimeoutMs,
      storeRelativePath: settings.storeRelativePath,
      worktreeRelativePath: settings.worktreeRelativePath,
      panel: createM12PanelProbe(panelPorts),
      idleAfterMs: settings.idleAfterMs,
      resolveAfterMs: settings.resolveAfterMs,
    })
  }

  // M1: the three runtime presets and the eleven cowork tools, owned by this fiber.
  ctx.effect(() => registerPresets(coworkDeps.agentPresets).then((disposers) => async () => {
    for (const dispose of disposers) await dispose()
  }), 'dsh-cowork: cowork presets')

  // DSH 0.2.1-rc.2 has no `hidden` preset flag. Keep topic/reviewer registered
  // for sessionController.create/resume, but remove them from the remote
  // new-session roster; only the master is a manual entry point.
  ctx.effect(() => {
    try {
      return hidePresetsFromRoster(
        assembly.agentPresets as unknown as PresetRosterService,
        HIDDEN_PRESET_IDS,
      )
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`[${PLUGIN_NAME}] internal preset entries stay visible: ${detail}`)
      return () => {}
    }
  }, 'dsh-cowork: hide internal presets')

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
