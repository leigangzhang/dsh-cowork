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
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  authCookieFrom,
  hostChecks,
  profilePatch,
  readyUrlFrom,
  startDshHost,
} from './dsh-host-session.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')

// Kept as named exports because the host-free guard imports these directly.
export { authCookieFrom, hostChecks, profilePatch, readyUrlFrom }

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

  const repoPath = realpathSync(root)
  const host = await startDshHost({
    patchRepoPath: repoPath,
    cwd: root,
    profileName: 'cowork-smoke',
    prefix: 'cowork-host-smoke-',
  })
  try {
    const [unauthApi, healthResponse] = await Promise.all([
      fetch(`${host.origin}/api/cowork.overview?sessionId=host-smoke-missing`, { redirect: 'manual' }),
      fetch(`${host.origin}/dsh-cowork/probe/health`, {
        headers: { cookie: host.cookie },
        redirect: 'manual',
      }),
    ])
    const health = await healthResponse.json()
    const checks = hostChecks({
      healthStatus: healthResponse.status,
      health,
      unauthApiStatus: unauthApi.status,
      expectedPlugin: host.packageJson.name,
      expectedVersion: host.packageJson.version,
      expectedRepoPath: repoPath,
    })
    const failures = checks.filter((check) => !check.passed)
    if (failures.length > 0) {
      throw new Error(`host-smoke checks failed: ${failures.map((entry) => `${entry.name}=${entry.detail}`).join(', ')}`)
    }
    console.log(`PASS host-smoke: ${checks.length}/${checks.length} checks, plugin ${host.packageJson.name}@${host.packageJson.version}`)
  } finally {
    await host.stop()
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`FAIL host-smoke: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
