import test from 'node:test'
import assert from 'node:assert/strict'
import {
  authCookieFrom,
  hostChecks,
  profilePatch,
  readyUrlFrom,
} from '../scripts/host-smoke.mjs'

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
