/**
 * @dsh-external/dsh-cowork — M0 probe host plugin.
 *
 * The plugin exists to prove the five API risks in docs/PLAN.md §3.2 against
 * the live host: a runtime agent preset, two queued wake turns, session and
 * workspace visibility, an atomic cross-session store, a worktree-backed
 * session, and the patchReload facts. It registers one read-only tool and
 * three loopback-only routes; probe runs are started and polled over HTTP.
 */
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import type { HealthView, ProbeConfig, ProbeHost } from './probe-engine.js'
import { PROBE_PRESET_ID, ProbeRunner } from './probe-engine.js'
import { isLoopbackAddress, isLoopbackHost, readPath, readQuery, requireRunId } from './probe-model.js'
import type { S0Host, S0Identity } from './s0-probe.js'
import { EMPTY_PRESET_ID, S0Runner, THREAD_SMOKE_PRESET_ID } from './s0-probe.js'

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

/** Lossless JSON value accepted by the tool result boundary. */
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

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
}

export const Config: z<Config> = z.object({
  repoPath: z.string().default(''),
  promptTimeoutMs: z.number().min(30_000).max(600_000).default(120_000),
  storeRelativePath: z.string().default('.dsh-cowork/probe/store.json'),
  worktreeRelativePath: z.string().default('.dsh-cowork/worktrees/probe'),
})

/** Host services this plugin cannot activate without. */
export const inject = ['webServer', 'tools', 'agentPresets', 'sessionController', 'workspaceRegistry']

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

/** Register the probe preset, tool, routes, and event feed; clean all of them up on dispose. */
export function apply(ctx: Context, config: Config): void {
  const host = ctx as unknown as ProbeHost
  const probeConfig: ProbeConfig = {
    repoPath: config.repoPath === '' ? defaultRepoPath() : resolve(config.repoPath),
    promptTimeoutMs: config.promptTimeoutMs,
    storeRelativePath: config.storeRelativePath,
    worktreeRelativePath: config.worktreeRelativePath,
  }
  const runner = new ProbeRunner(host, probeConfig, PLUGIN_NAME, PLUGIN_VERSION)
  const s0 = new S0Runner(ctx as unknown as S0Host, {
    repoPath: probeConfig.repoPath,
    promptTimeoutMs: probeConfig.promptTimeoutMs,
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
  })

  for (const route of routes) {
    ctx.effect(() => ctx.webServer.register(route), `dsh-cowork: route ${readPath(route.path)}`)
  }

  ctx.effect(() => runner.attachEvents(), 'dsh-cowork: session event feed')
  ctx.effect(() => s0.attachEvents(), 'dsh-cowork: S0 session event feed')
  ctx.effect(() => () => {
    runner.dispose()
    s0.dispose()
  }, 'dsh-cowork: probe runners')

  ctx.logger?.info?.(`[${PLUGIN_NAME}] M0 probe ready at ${HEALTH_PATH} (repo ${probeConfig.repoPath})`)
  ctx.logger?.info?.(`[${PLUGIN_NAME}] M1 S0 probe ready at ${S0_RUN_PATH}`)
}
