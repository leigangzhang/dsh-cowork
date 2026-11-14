#!/usr/bin/env node
/**
 * Built-artifact host smoke.
 *
 * This is the real entry path that `npm test` cannot cover: pack the current
 * lib into a tarball, install it into a throwaway DSH profile, boot `dsh web`,
 * exchange the printed token for a cookie, and read the plugin's loopback
 * health route.
 *
 * The smoke is keyless. It proves the package loads, the bundle patch inserts
 * the plugin, and the panel API rejects an unauthenticated request. The full
 * M12 chain still needs a model and remains a separate observational lane.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const READY_PATTERN = /dsh web: (http:\/\/[^\s]+)/
const READY_TIMEOUT_MS = 90_000
const COMMAND_TIMEOUT_MS = 180_000
const SHUTDOWN_TIMEOUT_MS = 5_000

/** Extract the authenticated URL without trusting the rest of the output. */
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

/** The `--patch` overlay that enables the dev health route for this smoke. */
export function profilePatch(repoPath) {
  return [
    '- id: dsh-cowork',
    '  config:',
    `    repoPath: ${JSON.stringify(repoPath)}`,
    '    enableDevRoutes: true',
    '    routing:',
    '      enabled: false',
    '',
  ].join('\n')
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

function waitForReadyUrl(child) {
  return new Promise((resolveUrl, rejectUrl) => {
    let output = ''
    let settled = false
    const finish = (error, url) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.stderr?.off('data', onData)
      child.off('exit', onExit)
      if (error !== null) rejectUrl(error)
      else resolveUrl(url)
    }
    const onData = (chunk) => {
      output += chunk.toString()
      const url = readyUrlFrom(output)
      if (url !== null) finish(null, url)
    }
    const onExit = (code) => {
      finish(new Error(`dsh web exited before printing its URL (code ${String(code)})`))
    }
    // A bounded deadline is not a readiness sleep: readiness is still the URL.
    const timer = setTimeout(() => finish(new Error('dsh web did not print its URL within 90s')), READY_TIMEOUT_MS)
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', onExit)
  })
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

async function main() {
  const dsh = process.env.DSH_BIN || 'dsh'
  const probe = spawnSync(dsh, ['--version'], { encoding: 'utf8', timeout: 15_000 })
  if (probe.error !== undefined || probe.status !== 0) {
    if (process.env.DSH_HOST_SMOKE_STRICT === '1') {
      throw new Error(`DSH_HOST_SMOKE_STRICT=1 but '${dsh} --version' is unavailable`)
    }
    console.log(`SKIP host-smoke: '${dsh}' is not available (set DSH_HOST_SMOKE_STRICT=1 to make this fatal)`)
    return
  }
  for (const path of ['lib/index.js', 'lib/client.js']) {
    if (!existsSync(resolve(root, path))) throw new Error(`${path} is missing; run npm run build first`)
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'cowork-host-smoke-'))
  const dshHome = join(tempRoot, 'dsh-home')
  const npmCache = join(tempRoot, 'npm-cache')
  const patchPath = join(tempRoot, 'dev-routes.yml')
  let child = null
  try {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    const packResult = runCommand('npm', ['pack', '--json', '--pack-destination', tempRoot], {
      cwd: root,
      env: { ...process.env, npm_config_cache: npmCache },
    })
    const packed = JSON.parse(packResult.stdout)[0]
    if (typeof packed?.filename !== 'string' || packed.filename === '') throw new Error('npm pack returned no filename')
    const tarball = join(tempRoot, packed.filename)

    runCommand(dsh, ['--profile', 'cowork-smoke', '--from-default-profile', 'web', '--dump-config'], {
      cwd: root,
      env: { ...process.env, DSH_HOME: dshHome },
    })
    runCommand(dsh, ['plugin', '--profile', 'cowork-smoke', 'add', tarball], {
      cwd: root,
      env: { ...process.env, DSH_HOME: dshHome },
    })

    const repoPath = realpathSync(root)
    writeFileSync(patchPath, profilePatch(repoPath), 'utf8')
    child = spawn(dsh, ['--profile', 'cowork-smoke', '--patch', patchPath, '--port', '0', '--no-open'], {
      cwd: root,
      env: { ...process.env, DSH_HOME: dshHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const readyUrl = await waitForReadyUrl(child)
    const origin = new URL(readyUrl).origin

    const auth = await fetch(readyUrl, { redirect: 'manual' })
    const cookie = authCookieFrom(auth.headers)
    if (auth.status !== 303 || cookie === '') {
      throw new Error(`DSH token exchange failed (status ${String(auth.status)}, cookie=${cookie === '' ? 'missing' : 'present'})`)
    }

    const [unauthApi, healthResponse] = await Promise.all([
      fetch(`${origin}/api/cowork.overview?sessionId=host-smoke-missing`, { redirect: 'manual' }),
      fetch(`${origin}/dsh-cowork/probe/health`, { headers: { cookie }, redirect: 'manual' }),
    ])
    const health = await healthResponse.json()
    const checks = hostChecks({
      healthStatus: healthResponse.status,
      health,
      unauthApiStatus: unauthApi.status,
      expectedPlugin: pkg.name,
      expectedVersion: pkg.version,
      expectedRepoPath: repoPath,
    })
    const failures = checks.filter((check) => !check.passed)
    if (failures.length > 0) {
      throw new Error(`host-smoke checks failed: ${failures.map((entry) => `${entry.name}=${entry.detail}`).join(', ')}`)
    }
    console.log(`PASS host-smoke: ${checks.length}/${checks.length} checks, plugin ${pkg.name}@${pkg.version}`)
  } finally {
    await stopChild(child)
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`FAIL host-smoke: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
