/**
 * The opt-in dev surface: the loopback-only health route and the M12 real-host
 * E2E run/status routes.
 *
 * Everything here is registered only when `Config.enableDevRoutes` is true, so
 * an installed profile never exposes these routes. Each registration is a
 * fiber-owned effect: an unload leaves no route and no listener behind.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { hostname } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { CoworkApiHost, CoworkApiPorts, PanelFetchRoute } from './api.js'
import { registerCoworkApi } from './api.js'
import { AUTHORIZATION_RESOLVE_PATH, OVERVIEW_PATH, REOPEN_PATH, RESOLVE_PATH } from './api-contract.js'
import { M12E2ERunner, M12_E2E_RUN_PATH, M12_E2E_STATUS_PATH } from './m12-e2e.js'
import type { M12E2EHost, M12PanelProbe } from './m12-e2e.js'
import { panelProbeRequest, panelRoutePathname } from './panel-probe.js'
import { canonicalRepoPath, isLoopbackAddress, isLoopbackHost, readPath, readQuery, requireRunId } from './probe-model.js'

/** Health route: liveness, plugin identity, and the configured repository. */
export const HEALTH_PATH = '/dsh-cowork/probe/health'

/** The dev surface's dependencies, resolved from the normalized config. */
export interface DevSurfaceOptions {
  /** Configured repository path, before symlink canonicalization. */
  repoPath: string
  promptTimeoutMs: number
  /** Configured lifecycle thresholds; the M12 driver refuses anything but the short ones. */
  idleAfterMs: number
  resolveAfterMs: number
  pluginName: string
  pluginVersion: string
  /** The shipped panel ports, reused by the in-process M12 probe. */
  ports: CoworkApiPorts
}

/** The health route's body: the four host-smoke facts plus the machine name. */
export interface HealthView {
  readonly ok: true
  readonly plugin: string
  readonly version: string
  readonly repoPath: string
  readonly host: string
}

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

/**
 * In-process probe for the M12 E2E driver. A plugin has no client for the host
 * `connection` channel, so the probe registers the production panel handlers on
 * a private connection and calls them with a real `Request`. The handlers,
 * guards, store, and lifecycle read point are the shipped ones; only the host's
 * HTTP transport is bypassed, and the driver's evidence records the status and
 * body it received.
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

/**
 * Register the dev surface: the loopback health route, the M12 run/status
 * routes, and the M12 session event feed.
 */
export function registerDevSurfaces(ctx: Context, options: DevSurfaceOptions): void {
  // The host canonicalizes a session cwd (/tmp → /private/tmp on macOS); the
  // health body and the E2E driver must report/compare the same real path.
  const repoPath = canonicalRepoPath(options.repoPath)
  const m12e2e = new M12E2ERunner(ctx as unknown as M12E2EHost, {
    repoPath,
    promptTimeoutMs: options.promptTimeoutMs,
    idleAfterMs: options.idleAfterMs,
    resolveAfterMs: options.resolveAfterMs,
    pluginName: options.pluginName,
    pluginVersion: options.pluginVersion,
    panel: createM12PanelProbe(options.ports),
    log: (message) => ctx.logger?.info?.(`[${options.pluginName}] ${message}`),
  })

  const health = (): HealthView => ({
    ok: true,
    plugin: options.pluginName,
    version: options.pluginVersion,
    repoPath,
    host: hostname(),
  })

  const routes: WebRoute[] = [
    {
      kind: 'exact',
      path: HEALTH_PATH,
      handler: (request, response) => {
        if (!guard(request, response, 'GET')) return
        sendJson(response, 200, health())
      },
    },
  ]
  routes.push({
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

  ctx.effect(() => m12e2e.attachEvents(), 'dsh-cowork: M12 E2E session event feed')
  ctx.effect(() => () => m12e2e.dispose(), 'dsh-cowork: M12 E2E runner')

  ctx.logger?.info?.(`[${options.pluginName}] dev routes ready at ${HEALTH_PATH} (repo ${repoPath})`)
}
