/**
 * @dsh-external/dsh-cowork host plugin entry point.
 *
 * This module assembles the business surface — the panel API, the twenty-two
 * cowork tools, the three presets, and the project-memory prompt section — and
 * starts the opt-in dev surface when `Config.enableDevRoutes` is true. The
 * configuration schema and its one defaults table live in `src/config.ts`; the
 * dev routes (loopback health plus the M12 E2E run/status pair) live in
 * `src/dev-surfaces.ts`.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { CoworkApiHost, CoworkApiPorts } from './api.js'
import { registerCoworkApi } from './api.js'
import { panelRoutePathname } from './panel-probe.js'

export { panelRoutePathname }
export { Config, CONFIG_DEFAULTS, normalizeConfig } from './config.js'
export type { IsolationConfig, ReviewerConfig, RoutingConfig } from './config.js'
import { CONFIG_DEFAULTS, normalizeConfig } from './config.js'
import type { Config } from './config.js'
import { registerDevSurfaces } from './dev-surfaces.js'
import { MEMORY_FILES, MEMORY_KINDS, memoryFilePath, parseMemoryFile, renderMemoryBlock } from './memory.js'
import type { MemoryInjectInput } from './memory.js'
import { registerMemoryPrompt } from './memory-prompt.js'
import type { MemoryPromptAgent, MemoryPromptDeps, MemoryPromptHost, MemoryRender } from './memory-prompt.js'
import { registerPresets } from './presets.js'
import { HIDDEN_PRESET_IDS, hidePresetsFromRoster } from './preset-visibility.js'
import type { PresetRosterService } from './preset-visibility.js'
import { ProjectStore, findProjectRoot, findProjectRootSync } from './store.js'
import { SessionSlice } from './session-slice.js'
import { createLlmRoutingPort } from './llm-port.js'
import type { HostLlmLike } from './llm-port.js'
import { NoopTopicNoticePort, TopicNoticeDispatcher } from './notices.js'
import type { CoworkToolDeps, CurrentModelRoute } from './tool-runtime.js'
import { registerCoworkTools } from './tools.js'
import { TopicEvents } from './topic-events.js'
import type { TopicEventLike, TopicEventSession } from './topic-events.js'
import { repairCoworkWorkspaces } from './workspace-repair.js'

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { name: string; version: string }

const PLUGIN_NAME = packageJson.name
const PLUGIN_VERSION = packageJson.version

/** Host services this plugin cannot activate without. */
export const inject = ['webServer', 'tools', 'agentPresets', 'sessionController', 'workspaceRegistry', 'agents']

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
 * types, so these stay structural; the shapes are the ones the M1 S0 probe
 * confirmed (docs/handoff/M1_S0_RESULT.md): `agentPresets.register`,
 * `sessionController`, and `workspaceRegistry`.
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

/** How long the host desktop opener may take before the call is aborted. */
export const OPEN_WORKSPACE_PATH_TIMEOUT_MS = 10_000

/**
 * The host session controller's desktop file-browser method (stage-0 probe 2).
 * Structural because the plugin cannot import the app's own session types; a
 * host without it answers `inbox/open-unsupported` at the open route.
 *
 * The installed host (DSH 0.2.1-rc.2) reads `signal.throwIfAborted()` before
 * touching the filesystem, so the second argument is mandatory at this
 * boundary: calling it with only the request object threw
 * "Cannot read properties of undefined (reading 'aborted')" and every real
 * "查看全文" turned into `inbox/open-unsupported` (t13 F-GUI-1).
 */
export interface HostSessionOpener {
  openWorkspacePath?(
    request: { path: string; action?: 'reveal' },
    signal: AbortSignal,
  ): Promise<unknown>
}

/**
 * Build the panel's `openWorkspacePath` port from one host session controller.
 *
 * The route passes an absolute path inside the repository; this adapter binds
 * the host's two-argument contract and a bounded timeout signal. A host
 * without the method, or a host that rejects the native open, throws and the
 * open route maps that onto `inbox/open-unsupported` — never a faked success.
 */
export function createOpenWorkspacePathPort(
  opener: HostSessionOpener | undefined,
  timeoutMs: number = OPEN_WORKSPACE_PATH_TIMEOUT_MS,
): (path: string) => Promise<void> {
  return async (path: string): Promise<void> => {
    const open = opener?.openWorkspacePath
    if (typeof open !== 'function') {
      throw new Error('the host session controller exposes no openWorkspacePath')
    }
    await open.call(opener, { path, action: 'reveal' }, AbortSignal.timeout(timeoutMs))
  }
}

/** The ten panel routes' shared ports; production and the M12 probe use the same ones. */
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
    // M11: the panel's lifecycle read point uses the same clock and idle
    // threshold as the tool layer, and logs a failed activity row instead of
    // failing the request.
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
    // The inbox open route is the only caller: the browser sends a request or
    // notice id, the host file browser is handed the resolved absolute path.
    // The adapter supplies the AbortSignal the installed host requires.
    openWorkspacePath: createOpenWorkspacePathPort(
      assembly.sessionController as unknown as HostSessionOpener,
    ),
    noticePort: notices.port,
    kickNotices: (repoPath) => notices.kick(repoPath),
    log: (message) => ctx.logger?.warn?.(`[${PLUGIN_NAME}] ${message}`),
  }
}

/** Register the business surface, plus the opt-in dev surface when enabled. */
export function apply(ctx: Context, config: Config): void {
  // One normalized view of the settings: a hand-built partial config (tests,
  // embedders) must not crash routing because `routing` is absent.
  const settings = normalizeConfig(config)
  // M10 supports exactly one reviewer reclaim mode. Any other value fails
  // startup instead of quietly pretending to support it (PLAN §5.4, M10 §8).
  if (settings.reviewer.reclaim !== CONFIG_DEFAULTS.reviewer.reclaim) {
    throw new Error(
      `${PLUGIN_NAME}: reviewer.reclaim must be '${CONFIG_DEFAULTS.reviewer.reclaim}' (M10 supports only after-verdict); got '${settings.reviewer.reclaim}'`,
    )
  }
  // M1 assembly services: one dependency bag for the presets and the twenty-two tools.
  const assembly = ctx as unknown as CoworkAssemblyHost
  // Business repo path: the dev surface canonicalizes its own copy, because
  // only it compares paths against a host session cwd.
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
    isolationProvider: settings.isolation.provider,
    reviewerReclaim: settings.reviewer.reclaim,
    routing: settings.routing,
    // M9.3b: the only host LLM entry point. Missing services leave the third
    // layer on its structured fallback; they never fail a route.
    llmRoutingPort: createLlmRoutingPort(hostService<HostLlmLike>(ctx, 'llm')),
    currentModelRoute: hostCurrentModelRoute(ctx),
    notices: noticeRuntime,
  }

  // M11 panel: four read routes and six write routes over the host connection
  // service (the request inbox adds its read, resolve, and open routes). The project root is derived from the session's own cwd, never from
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

  // Dev surfaces are opt-in: an installed profile never exposes the dev
  // routes or the M12 session event feed.
  if (settings.enableDevRoutes) {
    registerDevSurfaces(ctx, {
      repoPath,
      promptTimeoutMs: settings.promptTimeoutMs,
      idleAfterMs: settings.idleAfterMs,
      resolveAfterMs: settings.resolveAfterMs,
      pluginName: PLUGIN_NAME,
      pluginVersion: PLUGIN_VERSION,
      ports: panelPorts,
    })
  }

  // M1: the three runtime presets and the twenty-two cowork tools, owned by this fiber.
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
