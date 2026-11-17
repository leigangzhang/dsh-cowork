/**
 * The opt-in dev surface: the loopback-only health route.
 *
 * It is registered only when `Config.enableDevRoutes` is true, so an installed
 * profile never exposes it. The registration is a fiber-owned effect: an unload
 * leaves no route and no listener behind. The versioned E2E lane covers the
 * real-host transactions; this surface exists for host smoke and readiness.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { hostname } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { canonicalRepoPath, isLoopbackAddress, isLoopbackHost } from '../panel/probe-model.js'

/** Health route: liveness, plugin identity, and the configured repository. */
export const HEALTH_PATH = '/dsh-cowork/probe/health'

/** The dev surface's dependencies, resolved from the normalized config. */
export interface DevSurfaceOptions {
  /** Configured repository path, before symlink canonicalization. */
  repoPath: string
  pluginName: string
  pluginVersion: string
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

function guard(request: IncomingMessage, response: ServerResponse, allow: string): boolean {
  if (!loopbackOnly(request)) {
    sendJson(response, 403, { ok: false, error: 'loopback requests only' })
    return false
  }
  if (request.method !== allow) {
    response.setHeader('allow', allow)
    sendJson(response, 405, { ok: false, error: 'method not allowed' })
    return false
  }
  return true
}

/**
 * Register the loopback health route. The caller owns the effect scope.
 *
 * The host canonicalizes a session cwd (/tmp → /private/tmp on macOS); the
 * health body reports the same real path the repository is resolved from.
 */
export function registerDevSurfaces(ctx: Context, options: DevSurfaceOptions): void {
  const repoPath = canonicalRepoPath(options.repoPath)
  const health = (): HealthView => ({
    ok: true,
    plugin: options.pluginName,
    version: options.pluginVersion,
    repoPath,
    host: hostname(),
  })
  const route: WebRoute = {
    kind: 'exact',
    path: HEALTH_PATH,
    handler: (request, response) => {
      if (!guard(request, response, 'GET')) return
      sendJson(response, 200, health())
    },
  }
  ctx.effect(() => ctx.webServer.register(route), `dsh-cowork: route ${HEALTH_PATH}`)
  ctx.logger?.info?.(`[${options.pluginName}] dev routes ready at ${HEALTH_PATH} (repo ${repoPath})`)
}
