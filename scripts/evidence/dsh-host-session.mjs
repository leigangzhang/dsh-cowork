#!/usr/bin/env node
/**
 * Shared temporary DSH host lifecycle for evidence lanes.
 *
 * The host smoke and the browser panel lane both need the same security and
 * cleanup contract: pack the current `lib/` artifact, install it into a fresh
 * `DSH_HOME`, start `dsh web` on a random loopback port, exchange the printed
 * one-time URL for a session cookie, and remove every temporary path when the
 * lane stops. This module owns that lifecycle so the two lanes cannot drift.
 *
 * The cookie is returned in memory only. It is never logged, persisted, or
 * placed in an error message. `lib/` is local build output; callers must run
 * `npm run build` before starting this helper.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '../..')

/** The URL line `dsh web` prints when it is ready for the one-time exchange. */
const READY_PATTERN = /dsh web: (http:\/\/[^\s]+)/
const READY_TIMEOUT_MS = 90_000
const COMMAND_TIMEOUT_MS = 180_000
const SHUTDOWN_TIMEOUT_MS = 5_000
const HOST_LOG_TAIL_CHARS = 64 * 1024

/** Extract the authenticated URL without trusting the rest of the host output. */
export function readyUrlFrom(output) {
  return READY_PATTERN.exec(output)?.[1] ?? null
}

/** Fold one or more Set-Cookie headers into a single request Cookie header. */
export function authCookieFrom(headers) {
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter((value) => value !== null)
  return values
    .filter((value) => typeof value === 'string' && value.trim() !== '')
    .map((value) => value.split(';', 1)[0])
    .join('; ')
}

/**
 * The `--patch` overlay the evidence hosts use.
 *
 * `repoPath` is the repository the plugin points at; `enableDevRoutes` adds the
 * loopback health route used by readiness checks. Routing is disabled so the
 * host never asks a model to classify fixture intents. `idleAfterMs` and
 * `extraEntries` exist for the E2E lane, which pins a lifecycle threshold and
 * replaces the model provider with its scripted endpoint; both are appended to
 * the same patch so the plugin entry stays the first row.
 */
export function profilePatch(repoPath, options = {}) {
  const enableDevRoutes = options.enableDevRoutes ?? true
  const routing = options.routing ?? false
  const extraEntries = options.extraEntries ?? []
  const lines = [
    '- id: dsh-cowork',
    '  config:',
    `    repoPath: ${JSON.stringify(repoPath)}`,
    `    enableDevRoutes: ${enableDevRoutes ? 'true' : 'false'}`,
    '    routing:',
    `      enabled: ${routing ? 'true' : 'false'}`,
  ]
  if (options.idleAfterMs !== undefined) lines.push(`    idleAfterMs: ${String(options.idleAfterMs)}`)
  if (extraEntries.length > 0) lines.push('', ...extraEntries)
  lines.push('')
  return lines.join('\n')
}

/** Pure facts checked after the host answers; tests pin the failure shape. */
export function hostChecks({ healthStatus, health, unauthApiStatus, expectedPlugin, expectedVersion, expectedRepoPath }) {
  return [
    {
      name: 'health returns 200',
      passed: healthStatus === 200,
      detail: String(healthStatus),
    },
    {
      name: 'health reports the installed plugin',
      passed: health?.plugin === expectedPlugin,
      detail: String(health?.plugin),
    },
    {
      name: 'health reports the package version',
      passed: health?.version === expectedVersion,
      detail: String(health?.version),
    },
    {
      name: 'health reports the canonical repoPath',
      passed: health?.repoPath === expectedRepoPath,
      detail: String(health?.repoPath),
    },
    {
      name: 'unauthenticated panel API is refused',
      passed: unauthApiStatus === 401 || unauthApiStatus === 403,
      detail: String(unauthApiStatus),
    },
  ]
}

function runCommand(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    ...options,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${String(result.status)}\n${result.stdout}\n${result.stderr}`)
  }
  return result
}

/**
 * Consume the host pipes for its whole lifetime and retain a bounded tail.
 *
 * Removing the listeners after readiness leaves the child writing into an
 * unread pipe, which can block a long browser run and drops host-side failures
 * from the evidence. This keeps one bounded buffer and resolves readiness from
 * the same stream.
 */
function attachHostOutput(child) {
  let output = ''
  let settled = false
  let resolveReady
  let rejectReady
  const ready = new Promise((resolveUrl, rejectUrl) => {
    resolveReady = resolveUrl
    rejectReady = rejectUrl
  })
  const finish = (error, url) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (error !== null) rejectReady(error)
    else resolveReady(url)
  }
  const onData = (chunk) => {
    output += chunk.toString()
    if (output.length > HOST_LOG_TAIL_CHARS) output = output.slice(-HOST_LOG_TAIL_CHARS)
    if (!settled) {
      const url = readyUrlFrom(output)
      if (url !== null) finish(null, url)
    }
  }
  const onExit = (code) => {
    finish(new Error(`dsh web exited before printing its URL (code ${String(code)})`))
  }
  // A bounded deadline is not a readiness sleep: readiness is still the URL.
  const timer = setTimeout(() => finish(new Error('dsh web did not print its URL within 90s')), READY_TIMEOUT_MS)
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  child.once('exit', onExit)
  return {
    ready,
    tail: () => output,
    detach: () => {
      child.stdout?.off('data', onData)
      child.stderr?.off('data', onData)
      child.off('exit', onExit)
      clearTimeout(timer)
    },
  }
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolveExit) => child.once('exit', () => resolveExit()))
}

async function stopChild(child) {
  if (child === null) return
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  let timer
  try {
    const graceful = await Promise.race([
      waitForExit(child).then(() => true),
      new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), SHUTDOWN_TIMEOUT_MS)
      }),
    ])
    if (!graceful && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await waitForExit(child)
    }
  } finally {
    clearTimeout(timer)
  }
}

const ARTIFACT_FILES = ['lib/index.js', 'lib/client.js']

function assertArtifact(root) {
  for (const path of ARTIFACT_FILES) {
    if (!existsSync(resolve(root, path))) {
      throw new Error(`${path} is missing; run \`npm run build\` first`)
    }
  }
}

/**
 * The paths one temporary host owns, all derived from one `mkdtemp` root so
 * `stop` can remove the whole tree without tracking each file separately.
 *
 * @param {object} [options] The same options `startDshHost` accepts.
 * @param {string} [root] Package root the artifact and tarball come from.
 * @returns {{root: string, patchRepoPath: string, cwd: string, profileName: string, tempRoot: string, dshHome: string, npmCache: string, patchPath: string}}
 */
export function hostLayout(options = {}, root = packageRoot) {
  const prefix = options.prefix ?? 'cowork-host-session-'
  const tempRoot = mkdtempSync(join(tmpdir(), prefix))
  return {
    root,
    patchRepoPath: options.patchRepoPath ?? root,
    cwd: options.cwd ?? root,
    profileName: options.profileName ?? 'cowork-evidence',
    tempRoot,
    dshHome: join(tempRoot, 'dsh-home'),
    npmCache: join(tempRoot, 'npm-cache'),
    patchPath: join(tempRoot, 'profile-patch.yml'),
  }
}

/**
 * The child environment: the caller's values with an isolated DSH home and npm
 * cache, so a lane never reads or writes the user's real profile.
 *
 * @param {{dshHome: string, npmCache: string}} layout
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] Extra environment for every child.
 * @returns {NodeJS.ProcessEnv}
 */
export function hostEnvironment(layout, options = {}) {
  return {
    ...process.env,
    ...(options.env ?? {}),
    DSH_HOME: layout.dshHome,
    npm_config_cache: layout.npmCache,
  }
}

function removeTempRoot(tempRoot, keep) {
  if (keep !== true) rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

async function stopConnection(connection) {
  if (connection === null) return
  connection.output.detach()
  await stopChild(connection.child)
}

/** Install the current package artifact into the temporary profile. */
function installHostPackage({ layout, hostEnv, dsh }) {
  const manifest = JSON.parse(readFileSync(resolve(layout.root, 'package.json'), 'utf8'))
  const packResult = runCommand('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', layout.tempRoot], {
    cwd: layout.root,
    env: hostEnv,
  })
  const packed = JSON.parse(packResult.stdout)[0]
  if (typeof packed?.filename !== 'string' || packed.filename === '') throw new Error('npm pack returned no filename')
  const tarball = join(layout.tempRoot, packed.filename)
  runCommand(dsh, ['--profile', layout.profileName, '--from-default-profile', 'web', '--dump-config'], {
    cwd: layout.cwd,
    env: hostEnv,
  })
  runCommand(dsh, ['plugin', '--profile', layout.profileName, 'add', tarball], {
    cwd: layout.cwd,
    env: hostEnv,
  })
  return { manifest, tarball }
}

/** Spawn the host process and attach its bounded output. */
function spawnHostProcess({ layout, hostEnv, dsh }) {
  const child = spawn(dsh, ['--profile', layout.profileName, '--patch', layout.patchPath, '--port', '0', '--no-open'], {
    cwd: layout.cwd,
    env: hostEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { child, output: attachHostOutput(child) }
}

/**
 * Wait for the printed URL and exchange it for a cookie.
 *
 * The caller owns the spawned child; a failure here leaves cleanup to the
 * caller's stop path, which has the provisional connection.
 */
async function authenticateHost({ output }) {
  const authenticatedUrl = await output.ready
  const origin = new URL(authenticatedUrl).origin
  const auth = await fetch(authenticatedUrl, { redirect: 'manual' })
  const cookie = authCookieFrom(auth.headers)
  if (auth.status !== 303 || cookie === '') {
    throw new Error(`DSH token exchange failed (status ${String(auth.status)}, cookie=${cookie === '' ? 'missing' : 'present'})`)
  }
  return { origin, authenticatedUrl, cookie }
}

/**
 * Start one throwaway DSH host from the current package artifact.
 *
 * @param {object} [options]
 * @param {string} [options.patchRepoPath] Repository path written into the plugin patch.
 * @param {string} [options.cwd] Host process working directory.
 * @param {string} [options.profileName] Temporary profile name.
 * @param {NodeJS.ProcessEnv} [options.env] Extra environment for every child.
 * @param {boolean} [options.keep] Keep the temporary tree after stop.
 * @param {string} [options.prefix] mkdtemp prefix.
 * @param {object} [options.patchOptions] Optional `profilePatch` fields (idle threshold and extra entries).
 * @returns {Promise<{packageJson: object, tarball: string, tempRoot: string, dshHome: string, npmCache: string, origin: string, authenticatedUrl: string, cookie: string, child: import('node:child_process').ChildProcess, logTail: () => string, stop: () => Promise<void>}>}
 */
export async function startDshHost(options = {}) {
  const root = options.packageRoot ?? packageRoot
  assertArtifact(root)
  const layout = hostLayout(options, root)
  const hostEnv = hostEnvironment(layout, options)
  const dsh = hostEnv.DSH_BIN ?? 'dsh'
  let stopped = false
  let connection = null
  const stop = async () => {
    if (stopped) return
    stopped = true
    await stopConnection(connection)
    removeTempRoot(layout.tempRoot, options.keep)
  }
  try {
    const { manifest, tarball } = installHostPackage({ layout, hostEnv, dsh })
    writeFileSync(layout.patchPath, profilePatch(layout.patchRepoPath, options.patchOptions), 'utf8')
    connection = spawnHostProcess({ layout, hostEnv, dsh })
    const auth = await authenticateHost(connection)
    return {
      packageJson: manifest,
      tarball,
      tempRoot: layout.tempRoot,
      dshHome: layout.dshHome,
      npmCache: layout.npmCache,
      origin: auth.origin,
      authenticatedUrl: auth.authenticatedUrl,
      cookie: auth.cookie,
      child: connection.child,
      logTail: () => connection?.output?.tail() ?? '',
      stop,
    }
  } catch (error) {
    await stop()
    throw error
  }
}
