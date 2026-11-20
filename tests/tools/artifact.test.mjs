import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import '../support/ts-hook.mjs'
import {
  artifactRuntime,
  fakeHostFs,
  makeRepo,
  sha256,
} from '../support/artifact-fixtures.mjs'
import { makeSeedProject, makeTopicFixture, withRepo } from '../support/inbox-fixtures.mjs'

/**
 * `cowork_artifact_create` registers an existing project file. These tests
 * cover the tool wrapper — role gate, path/type validation, idempotency, and
 * failure envelopes — against a real project index and the real artifact store.
 */
const { registerArtifactTools } = await import('../../src/tools/artifact.ts')

const NOW = new Date('2026-02-01T12:00:00.000Z')
const MASTER = 'session-master'
const THREAD = 'session-thread'
const topic = makeTopicFixture({ topicId: THREAD, title: 'Artifact thread' })
const seedProject = makeSeedProject({ clock: () => NOW })

/** A tool registry that keeps every registered definition. */
function fakeHost() {
  const registry = new Map()
  return {
    registry,
    tools: {
      register(definition) {
        registry.set(definition.name, definition)
        return () => registry.delete(definition.name)
      },
    },
  }
}

/** The structured execution identity one tool call receives. */
function fakeExec(sessionId, cwd) {
  return { agent: { id: sessionId, session: { header: { cwd } } } }
}

/** Host ports the create tool never calls. */
function baseDeps(artifactRuntimePort) {
  const logs = []
  return {
    logs,
    deps: {
      sessionController: {
        async create() { throw new Error('must not create sessions') },
        async rename() { throw new Error('must not rename sessions') },
        async prompt() { throw new Error('must not prompt sessions') },
        async list() { return { items: [] } },
        async inspect(sessionId) { return { meta: { id: sessionId } } },
      },
      workspaceRegistry: {
        async resolveByPath(path) { return { id: 'workspace-1', path } },
        async create(path) { return { id: 'workspace-1', path } },
        async delete() { return true },
        async archiveSession() {},
      },
      agentPresets: {},
      clock: () => NOW,
      log: (message) => logs.push(message),
      artifactRuntime: artifactRuntimePort,
    },
  }
}

/** Seed a project and return its runtime manager plus the create tool. */
async function setup(repoPath, options = {}) {
  await seedProject(repoPath, [topic()])
  const manager = new artifactRuntime.ArtifactRuntimeManager({
    hostFs: options.hostFs ?? fakeHostFs(),
  })
  const { deps, logs } = baseDeps({ runtimeFor: (path) => manager.runtimeFor(path) })
  const host = fakeHost()
  registerArtifactTools(host, deps)
  return { tool: host.registry.get('cowork_artifact_create'), manager, logs, deps, host }
}

test('the tool registers exactly one definition in the public order', async () => {
  await withRepo(async (repoPath) => {
    const { host } = await setup(repoPath)
    assert.deepEqual([...host.registry.keys()], ['cowork_artifact_create'])
    const tool = host.registry.get('cowork_artifact_create')
    assert.equal(typeof tool.description, 'string')
    assert.equal(tool.parameters.type, 'object')
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['path', 'title', 'type'])
  })
})

test('a text file becomes a work item and publishes one event', async () => {
  await withRepo(async (repoPath) => {
    const content = '# Spec\n\nbody\n'
    await mkdir(join(repoPath, 'docs'), { recursive: true })
    await writeFile(join(repoPath, 'docs/spec.md'), content)
    const { tool, manager } = await setup(repoPath)
    const runtime = manager.runtimeFor(repoPath)
    const published = []
    runtime.events.subscribe({}, (event) => published.push(event))

    const result = await tool.execute({ path: 'docs/spec.md' }, fakeExec(MASTER, repoPath))
    assert.equal(result.ok, true)
    assert.equal(result.created, true)
    assert.equal(result.artifact.title, 'spec')
    assert.equal(result.artifact.type, 'text')
    assert.equal(result.artifact.status, 'pending-view')
    assert.equal(result.artifact.primaryPath, 'docs/spec.md')

    const record = await runtime.store.readRecord(result.artifact.artifactId)
    assert.equal(record.files[0].sha256, sha256(content))
    assert.equal(record.files[0].editable, true)
    assert.equal(record.files[0].fsVersion, sha256(content))
    const events = await runtime.store.readEvents()
    assert.deepEqual(events.map((event) => event.type), ['artifact.updated'])
    assert.deepEqual(published.map((event) => event.type), ['artifact.updated'])

    const replay = await tool.execute({ path: 'docs/spec.md' }, fakeExec(MASTER, repoPath))
    assert.equal(replay.created, false)
    assert.equal(replay.artifact.artifactId, result.artifact.artifactId)
  })
})

test('title and type are honoured, and a bad type is refused', async () => {
  await withRepo(async (repoPath) => {
    await writeFile(join(repoPath, 'notes.txt'), 'hello\n')
    const { tool } = await setup(repoPath)
    const custom = await tool.execute(
      { path: 'notes.txt', title: '  Custom title  ', type: 'html' },
      fakeExec(THREAD, repoPath),
    )
    assert.equal(custom.ok, true)
    assert.equal(custom.artifact.title, 'Custom title')
    assert.equal(custom.artifact.type, 'html')

    await assert.rejects(
      async () => tool.execute({ path: 'notes.txt', type: 'spreadsheet' }, fakeExec(THREAD, repoPath)),
      /must be one of/,
    )
  })
})

test('path and existence failures keep their stable codes', async () => {
  await withRepo(async (repoPath) => {
    await mkdir(join(repoPath, 'docs'), { recursive: true })
    const { tool } = await setup(repoPath)
    const cases = [
      [{ path: '../escape.md' }, 'artifact/path-not-allowed'],
      [{ path: '/etc/passwd' }, 'artifact/path-not-allowed'],
      [{ path: 'docs/missing.md' }, 'artifact/file-missing'],
      [{ path: 'docs' }, 'artifact/path-not-allowed'],
    ]
    for (const [args, code] of cases) {
      const result = await tool.execute(args, fakeExec(MASTER, repoPath))
      assert.equal(result.ok, false, JSON.stringify(args))
      assert.equal(result.error.code, code, JSON.stringify(args))
    }
  })
})

test('a non-regular path reported by the port is refused', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [topic()])
    const runtime = {
      store: {
        async listRecords() {
          return { records: [], corrupt: [], total: 0 }
        },
      },
      files: {
        async stat() {
          return { exists: true, regular: false, size: 0, version: null }
        },
      },
      events: { publish() {} },
    }
    const { deps } = baseDeps({ runtimeFor: () => runtime })
    const host = fakeHost()
    registerArtifactTools(host, deps)
    const result = await host.registry.get('cowork_artifact_create')
      .execute({ path: 'docs/folder' }, fakeExec(MASTER, repoPath))
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'artifact/path-not-allowed')
  })
})

test('a binary file is registered read-only with no text hash', async () => {
  await withRepo(async (repoPath) => {
    await writeFile(join(repoPath, 'plot.png'), 'fake-png-bytes')
    const { tool, manager } = await setup(repoPath)
    const result = await tool.execute({ path: 'plot.png' }, fakeExec(MASTER, repoPath))
    assert.equal(result.ok, true)
    assert.equal(result.artifact.type, 'image')
    const record = await manager.runtimeFor(repoPath).store.readRecord(result.artifact.artifactId)
    assert.equal(record.files[0].editable, false)
    assert.equal(record.files[0].sha256, '')
    assert.equal(record.files[0].size, Buffer.byteLength('fake-png-bytes'))
  })
})

test('the role gate and caller identity fail closed', async () => {
  await withRepo(async (repoPath) => {
    await writeFile(join(repoPath, 'notes.txt'), 'hello\n')
    const { tool } = await setup(repoPath)
    const forbidden = await tool.execute({ path: 'notes.txt' }, fakeExec('stranger-session', repoPath))
    assert.equal(forbidden.ok, false)
    assert.equal(forbidden.error.code, 'role/forbidden')
    const noAgent = await tool.execute({ path: 'notes.txt' }, {})
    assert.equal(noAgent.ok, false)
    assert.equal(noAgent.error.code, 'exec/agent-unavailable')
  })
})

test('a project without an index and a host without a runtime are explicit', async () => {
  const repo = await makeRepo()
  try {
    await writeFile(join(repo.repoPath, 'notes.txt'), 'hello\n')
    const { deps } = baseDeps(undefined)
    const host = fakeHost()
    registerArtifactTools(host, deps)
    const tool = host.registry.get('cowork_artifact_create')
    const noProject = await tool.execute({ path: 'notes.txt' }, fakeExec(MASTER, repo.repoPath))
    assert.equal(noProject.ok, false)
    assert.equal(noProject.error.code, 'project/not-initialized')
  } finally {
    await repo.remove()
  }

  await withRepo(async (seeded) => {
    await seedProject(seeded, [topic()])
    await writeFile(join(seeded, 'notes.txt'), 'hello\n')
    const { deps } = baseDeps(undefined)
    const host = fakeHost()
    registerArtifactTools(host, deps)
    const tool = host.registry.get('cowork_artifact_create')
    const noRuntime = await tool.execute({ path: 'notes.txt' }, fakeExec(MASTER, seeded))
    assert.equal(noRuntime.ok, false)
    assert.equal(noRuntime.error.code, 'artifact/fs-unavailable')
  })
})

test('a file that cannot be read keeps its filesystem failure code', async () => {
  const repo = await makeRepo({ 'docs/spec.md': 'x\n' })
  try {
    const real = await import('node:fs/promises').then((fs) => fs.realpath(join(repo.repoPath, 'docs/spec.md')))
    const hostFs = fakeHostFs({ failures: new Map([[real, 'FS_TOO_LARGE']]) })
    const { tool } = await setup(repo.repoPath, { hostFs })
    const result = await tool.execute({ path: 'docs/spec.md' }, fakeExec(MASTER, repo.repoPath))
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'artifact/file-too-large')
  } finally {
    await repo.remove()
  }
})

test('an event log that cannot be written does not fail the registration', async () => {
  await withRepo(async (repoPath) => {
    await writeFile(join(repoPath, 'notes.txt'), 'hello\n')
    // A directory named events.jsonl makes the append fail deterministically.
    await mkdir(join(repoPath, '.dsh-cowork', 'artifacts', 'events.jsonl'), { recursive: true })
    const { tool, logs } = await setup(repoPath)
    const result = await tool.execute({ path: 'notes.txt' }, fakeExec(MASTER, repoPath))
    assert.equal(result.ok, true)
    assert.equal(result.created, true)
    assert.ok(logs.some((message) => message.includes('artifact create event was not recorded')))
  })
})
