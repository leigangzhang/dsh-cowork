import test from 'node:test'
import assert from 'node:assert/strict'
import '../support/ts-hook.mjs'
/**
 * Unit tests for the startup workspace repair.
 *
 * The repair is pure orchestration over injected ports, so no DSH host is
 * assembled: the registry, the project-root lookup, and the session listing are
 * recording fakes. The module value-imports `./checkout-teardown.js`, so the
 * resolver maps a relative `.js` specifier to its `.ts` source the same way the
 * other source-level tests do.
 */

const { repairCoworkWorkspaces } = await import('../../src/platform/workspace-repair.ts')

/**
 * Recording ports. `projectRoots` maps a session cwd to the Cowork project root
 * at or above it (absent means "not a Cowork project"); `workspaces` is the
 * pre-existing registry content, keyed by project root.
 */
function repairPorts({ sessions, projectRoots = {}, workspaces = {}, attachFailures = [] } = {}) {
  const byPath = new Map(Object.entries(workspaces))
  const created = []
  const attachCalls = []
  const refused = new Set(attachFailures)
  const ports = {
    async listSessions() {
      return sessions
    },
    async resolveProjectRoot(cwd) {
      return projectRoots[cwd] ?? null
    },
    async resolveWorkspace(path) {
      const id = byPath.get(path)
      return id === undefined ? undefined : { id, path }
    },
    async createWorkspace(path) {
      const id = `workspace-created-${created.length + 1}`
      byPath.set(path, id)
      created.push({ id, path })
      return { id, path }
    },
    async attachSession(workspaceId, sessionId) {
      attachCalls.push({ workspaceId, sessionId })
      if (refused.has(sessionId)) {
        throw new Error(`attach refused for ${sessionId}`)
      }
    },
  }
  return { ports, created, attachCalls, workspaces: byPath }
}

const ROOT = '/projects/cowork'

test('a missing workspace is created and the root sessions are attached', async () => {
  const { ports, created, attachCalls } = repairPorts({
    sessions: [
      { sessionId: 'session-master', cwd: ROOT },
      { sessionId: 'session-topic', cwd: ROOT },
    ],
    projectRoots: { [ROOT]: ROOT },
  })

  const result = await repairCoworkWorkspaces(ports)

  assert.deepEqual(created, [{ id: 'workspace-created-1', path: ROOT }])
  assert.deepEqual(result.createdWorkspaces, [ROOT])
  assert.deepEqual(attachCalls, [
    { workspaceId: 'workspace-created-1', sessionId: 'session-master' },
    { workspaceId: 'workspace-created-1', sessionId: 'session-topic' },
  ])
  assert.equal(result.scannedSessions, 2)
  assert.equal(result.scannedProjects, 1)
  assert.equal(result.attachedSessions, 2)
  assert.equal(result.failed, 0)
  assert.deepEqual(result.errors, [])
  assert.equal(result.truncated, false)
})

test('an existing workspace is reused and only the sessions are attached', async () => {
  const { ports, created, attachCalls } = repairPorts({
    sessions: [{ sessionId: 'session-master', cwd: ROOT }],
    projectRoots: { [ROOT]: ROOT },
    workspaces: { [ROOT]: 'workspace-existing' },
  })

  const result = await repairCoworkWorkspaces(ports)

  assert.deepEqual(created, [], 'an existing workspace must never be created again')
  assert.deepEqual(result.createdWorkspaces, [])
  assert.deepEqual(attachCalls, [{ workspaceId: 'workspace-existing', sessionId: 'session-master' }])
  assert.equal(result.attachedSessions, 1)
})

test('a non-Cowork cwd never creates a workspace', async () => {
  const { ports, created, attachCalls } = repairPorts({
    sessions: [{ sessionId: 'session-plain', cwd: '/home/me/plain-repo' }],
  })

  const result = await repairCoworkWorkspaces(ports)

  assert.deepEqual(created, [])
  assert.deepEqual(attachCalls, [])
  assert.equal(result.scannedSessions, 1)
  assert.equal(result.scannedProjects, 0)
  assert.equal(result.skippedSessions, 1)
  assert.equal(result.failed, 0)
})

test('a session nested below the project root is skipped, not attached', async () => {
  const nested = `${ROOT}/src`
  const { ports, created, attachCalls } = repairPorts({
    sessions: [
      { sessionId: 'session-root', cwd: ROOT },
      { sessionId: 'session-nested', cwd: nested },
    ],
    // findProjectRoot walks up, so both cwds resolve to the same project root.
    projectRoots: { [ROOT]: ROOT, [nested]: ROOT },
  })

  const result = await repairCoworkWorkspaces(ports)

  assert.deepEqual(created, [{ id: 'workspace-created-1', path: ROOT }])
  assert.deepEqual(attachCalls, [{ workspaceId: 'workspace-created-1', sessionId: 'session-root' }])
  assert.equal(result.attachedSessions, 1)
  assert.equal(result.skippedSessions, 1, 'the host would reject a nested cwd as the workspace path')
})

test('one failed attach is reported and does not stop another project', async () => {
  const other = '/projects/other'
  const { ports } = repairPorts({
    sessions: [
      { sessionId: 'session-refused', cwd: ROOT },
      { sessionId: 'session-other', cwd: other },
    ],
    projectRoots: { [ROOT]: ROOT, [other]: other },
    attachFailures: ['session-refused'],
  })

  const result = await repairCoworkWorkspaces(ports)

  assert.equal(result.attachedSessions, 1)
  assert.equal(result.failed, 1)
  assert.equal(result.scannedProjects, 2)
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /session-refused/)
  assert.match(result.errors[0], /attach refused for session-refused/)
})

test('the session scan is bounded and reports truncation', async () => {
  const sessions = Array.from({ length: 5 }, (_, index) => ({
    sessionId: `session-${index}`,
    cwd: ROOT,
  }))
  const { ports, attachCalls } = repairPorts({
    sessions,
    projectRoots: { [ROOT]: ROOT },
  })

  const result = await repairCoworkWorkspaces(ports, { maxSessions: 2 })

  assert.equal(result.scannedSessions, 2)
  assert.equal(result.truncated, true)
  assert.equal(attachCalls.length, 2, 'a session past the bound must not be attached')
  assert.deepEqual(attachCalls.map((call) => call.sessionId), ['session-0', 'session-1'])
})

test('the project scan is bounded and reports truncation', async () => {
  const first = '/projects/first'
  const second = '/projects/second'
  const { ports, created } = repairPorts({
    sessions: [
      { sessionId: 'session-first', cwd: first },
      { sessionId: 'session-second', cwd: second },
    ],
    projectRoots: { [first]: first, [second]: second },
  })

  const result = await repairCoworkWorkspaces(ports, { maxProjects: 1 })

  assert.equal(result.truncated, true)
  assert.equal(result.scannedProjects, 1)
  assert.deepEqual(created.map((entry) => entry.path), [first])
})

test('invalid session rows are skipped without failing the pass', async () => {
  const { ports, created } = repairPorts({
    sessions: [
      { sessionId: 'session-no-cwd' },
      { sessionId: 'session-empty-cwd', cwd: '' },
      { sessionId: 'session-root', cwd: ROOT },
    ],
    projectRoots: { [ROOT]: ROOT },
  })

  const result = await repairCoworkWorkspaces(ports)

  assert.equal(result.skippedSessions, 2)
  assert.equal(result.attachedSessions, 1)
  assert.equal(result.failed, 0)
  assert.deepEqual(created, [{ id: 'workspace-created-1', path: ROOT }])
})

test('E2E and probe roots inside .dsh-cowork are not repaired', async () => {
  const fixture = '/projects/app/.dsh-cowork/e2e/m3-repo'
  const { ports, created, attachCalls } = repairPorts({
    sessions: [{ sessionId: 'session-fixture', cwd: fixture }],
    projectRoots: { [fixture]: fixture },
  })

  const result = await repairCoworkWorkspaces(ports)

  assert.deepEqual(created, [], 'cleaned-up test workspaces must stay gone')
  assert.deepEqual(attachCalls, [])
  assert.equal(result.skippedSessions, 1)
  assert.equal(result.scannedProjects, 0)
  assert.equal(result.failed, 0)
})

test('a failing session listing returns an error result instead of throwing', async () => {
  const { ports } = repairPorts({ sessions: [] })
  ports.listSessions = async () => {
    throw new Error('session store unavailable')
  }

  const result = await repairCoworkWorkspaces(ports)

  assert.equal(result.failed, 1)
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /session store unavailable/)
  assert.equal(result.scannedSessions, 0)
})
