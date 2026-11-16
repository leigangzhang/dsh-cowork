import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  authCookieFrom,
  hostChecks,
  profilePatch,
  readyUrlFrom,
} from '../../scripts/evidence/host-smoke.mjs'
import { hostEnvironment, hostLayout } from '../../scripts/evidence/dsh-host-session.mjs'

test('readyUrlFrom extracts only the printed dsh web URL', () => {
  const url = 'http://127.0.0.1:50978/?token=abc_DEF-123'
  assert.equal(readyUrlFrom(`booting...\ndsh web: ${url}\n`), url)
  assert.equal(readyUrlFrom('dsh web: not-a-url'), null)
  assert.equal(readyUrlFrom('no URL here'), null)
})

test('authCookieFrom folds Set-Cookie headers into one Cookie header', () => {
  const headers = new Headers()
  headers.append('set-cookie', 'dsh-auth-one=v1; Path=/; HttpOnly')
  headers.append('set-cookie', 'dsh-auth-two=v2; Path=/; SameSite=Strict')
  assert.equal(authCookieFrom(headers), 'dsh-auth-one=v1; dsh-auth-two=v2')
})

test('profilePatch quotes the repo path and enables only the dev smoke surface', () => {
  const patch = profilePatch('/tmp/a path/with spaces')
  assert.match(patch, /^- id: dsh-cowork$/m)
  assert.match(patch, /^    repoPath: "\/tmp\/a path\/with spaces"$/m)
  assert.match(patch, /^    enableDevRoutes: true$/m)
  assert.match(patch, /^    routing:$/m)
  assert.match(patch, /^      enabled: false$/m)
})

test('hostChecks accepts the expected health shape and rejects each mismatch', () => {
  const expected = {
    expectedPlugin: '@dsh-external/dsh-cowork',
    expectedVersion: '0.2.0',
    expectedRepoPath: '/tmp/repo',
  }
  const health = {
    ok: true,
    plugin: expected.expectedPlugin,
    version: expected.expectedVersion,
    repoPath: expected.expectedRepoPath,
  }
  assert.deepEqual(
    hostChecks({ ...expected, healthStatus: 200, health, unauthApiStatus: 401 }).map((check) => check.passed),
    [true, true, true, true, true],
  )
  assert.equal(hostChecks({ ...expected, healthStatus: 200, health: { ...health, version: '0.0.0' }, unauthApiStatus: 401 })[2].passed, false)
  assert.equal(hostChecks({ ...expected, healthStatus: 200, health: { ...health, repoPath: '/tmp/other' }, unauthApiStatus: 401 })[3].passed, false)
  assert.equal(hostChecks({ ...expected, healthStatus: 200, health, unauthApiStatus: 200 })[4].passed, false)
})

test('hostLayout places the profile, home, and cache under one temporary root', () => {
  const layout = hostLayout({ prefix: 'cowork-layout-test-', profileName: 'cowork-test' }, '/repo')
  try {
    assert.equal(layout.root, '/repo')
    assert.equal(layout.patchRepoPath, '/repo')
    assert.equal(layout.cwd, '/repo')
    assert.equal(layout.profileName, 'cowork-test')
    assert.ok(layout.tempRoot.startsWith(join(tmpdir(), 'cowork-layout-test-')))
    assert.equal(layout.dshHome, join(layout.tempRoot, 'dsh-home'))
    assert.equal(layout.npmCache, join(layout.tempRoot, 'npm-cache'))
    assert.equal(layout.patchPath, join(layout.tempRoot, 'profile-patch.yml'))
  } finally {
    rmSync(layout.tempRoot, { recursive: true, force: true })
  }
})

test('hostEnvironment keeps caller values but isolates DSH_HOME and npm cache', () => {
  const env = hostEnvironment(
    { dshHome: '/tmp/lane-home', npmCache: '/tmp/lane-cache' },
    { env: { DSH_BIN: '/opt/dsh' } },
  )
  assert.equal(env.DSH_HOME, '/tmp/lane-home')
  assert.equal(env.npm_config_cache, '/tmp/lane-cache')
  assert.equal(env.DSH_BIN, '/opt/dsh')
  assert.equal(env.PATH, process.env.PATH)
})
