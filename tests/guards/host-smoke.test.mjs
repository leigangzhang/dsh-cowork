import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  authCookieFrom,
  hostChecks,
  profilePatch,
  readyUrlFrom,
} from '../../scripts/evidence/host-smoke.mjs'
import { hostEnvironment, hostLayout, startDshHost } from '../../scripts/evidence/dsh-host-session.mjs'

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

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

test('startDshHost stops a spawned host when the token exchange fails', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'cowork-host-failure-'))
  const pidFile = join(fixture, 'host.pid')
  let server
  let pid
  try {
    // Accept the connection and destroy it before any HTTP response, so the
    // token fetch rejects while the spawned host is still alive.
    server = createServer()
    server.on('connection', (socket) => { socket.destroy() })
    await new Promise((resolveListen) => { server.listen(0, '127.0.0.1', resolveListen) })
    const { port } = server.address()
    const fakeDsh = join(fixture, 'fake-dsh.sh')
    writeFileSync(fakeDsh, [
      '#!/bin/sh',
      'case "$*" in',
      '  *--dump-config*) exit 0 ;;',
      '  *"plugin"*"add"*) exit 0 ;;',
      'esac',
      'echo $$ > "$PID_FILE"',
      `echo "dsh web: http://127.0.0.1:${port}/?token=test"`,
      "trap 'exit 0' TERM INT",
      'while :; do sleep 0.2; done',
      '',
    ].join('\n'))
    chmodSync(fakeDsh, 0o755)
    writeFileSync(
      join(fixture, 'package.json'),
      `${JSON.stringify({ name: 'cowork-host-failure', version: '0.0.0', private: true })}\n`,
    )
    mkdirSync(join(fixture, 'lib'))
    writeFileSync(join(fixture, 'lib/index.js'), '')
    writeFileSync(join(fixture, 'lib/client.js'), '')

    await assert.rejects(
      startDshHost({
        packageRoot: fixture,
        patchRepoPath: fixture,
        cwd: fixture,
        profileName: 'cowork-test',
        prefix: 'cowork-host-failure-',
        env: { DSH_BIN: fakeDsh, PID_FILE: pidFile },
      }),
      /fetch failed/,
    )
    pid = Number(readFileSync(pidFile, 'utf8'))
    assert.equal(processAlive(pid), false, 'a failed token exchange must stop the spawned host')
  } finally {
    if (server !== undefined) await new Promise((resolveClose) => { server.close(resolveClose) })
    if (pid !== undefined && processAlive(pid)) process.kill(pid, 'SIGKILL')
    rmSync(fixture, { recursive: true, force: true })
  }
})
