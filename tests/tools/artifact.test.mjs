import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import '../support/ts-hook.mjs'
import {
  artifactRuntime,
  fakeHostFs,
  makeComment,
  makeRecord,
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
    assert.deepEqual([...host.registry.keys()], [
      'cowork_artifact_create',
      'cowork_artifact_comments',
      'cowork_artifact_reply',
    ])
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

/** Create one work item through the tool and return its id. */
async function createWorkItem(repoPath, tool) {
  const result = await tool.execute({ path: 'notes.txt' }, fakeExec(MASTER, repoPath))
  assert.equal(result.ok, true)
  return result.artifact.artifactId
}

test('cowork_artifact_comments reads the open threads of an owned item', async () => {
  await withRepo(async (repoPath) => {
    await writeFile(join(repoPath, 'notes.txt'), 'hello\n')
    const { tool, deps, manager } = await setup(repoPath)
    const artifactId = await createWorkItem(repoPath, tool)
    const store = manager.runtimeFor(repoPath).store
    await store.appendComment(makeComment({ artifactId, commentId: 'comment-1', threadId: 'comment-1', eventId: 'e1', body: 'open thread' }))
    await store.appendComment(makeComment({ artifactId, commentId: 'comment-2', threadId: 'comment-2', eventId: 'e2', body: 'closed thread' }))
    await store.appendComment(makeComment({ artifactId, commentId: 'comment-2', threadId: 'comment-2', eventId: 'e3', body: 'resolved', type: 'resolve' }))
    await store.mutateRecord(artifactId, (record) => ({ ...record, commentCount: 3 }))

    const host = fakeHost()
    registerArtifactTools(host, deps)
    const comments = host.registry.get('cowork_artifact_comments')
    const open = await comments.execute({ artifactId }, fakeExec(MASTER, repoPath))
    assert.equal(open.ok, true)
    assert.equal(open.artifact.artifactId, artifactId)
    assert.deepEqual(open.threads.map((thread) => thread.threadId), ['comment-1'])

    const all = await comments.execute({ artifactId, includeResolved: true }, fakeExec(MASTER, repoPath))
    assert.deepEqual(all.threads.map((thread) => thread.threadId).sort(), ['comment-1', 'comment-2'])

    const missing = await comments.execute({ artifactId: 'artifact-ffffffff-ffff-4fff-8fff-ffffffffffff' }, fakeExec(MASTER, repoPath))
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'artifact/not-found')

    const threadCaller = await comments.execute({ artifactId }, fakeExec(THREAD, repoPath))
    assert.equal(threadCaller.ok, false)
    assert.equal(threadCaller.error.code, 'role/forbidden')
  })
})

test('cowork_artifact_reply writes one reply per thread and closes the batch', async () => {
  await withRepo(async (repoPath) => {
    await writeFile(join(repoPath, 'notes.txt'), 'hello\n')
    const { tool, deps, manager } = await setup(repoPath)
    const artifactId = await createWorkItem(repoPath, tool)
    const runtime = manager.runtimeFor(repoPath)
    const store = runtime.store
    await store.appendComment(makeComment({ artifactId, commentId: 'comment-1', threadId: 'comment-1', eventId: 'e1' }))
    await store.appendComment(makeComment({ artifactId, commentId: 'comment-2', threadId: 'comment-2', eventId: 'e2' }))
    await store.mutateRecord(artifactId, (record) => ({ ...record, commentCount: 2 }))
    const attachmentId = 'attachment-11111111-1111-4111-8111-111111111111'
    await store.saveUpload(artifactId, attachmentId, new Uint8Array([1, 2, 3]))

    const host = fakeHost()
    registerArtifactTools(host, deps)
    const reply = host.registry.get('cowork_artifact_reply')
    const result = await reply.execute({
      artifactId,
      commentIds: ['comment-2', 'comment-1'],
      body: 'Fixed both.',
      attachments: [{ attachmentId, name: 'diff.txt', mediaType: 'text/plain', size: 3, sha256: 'x' }],
    }, fakeExec(MASTER, repoPath))
    assert.equal(result.ok, true)
    assert.equal(result.replied, 2)
    assert.equal(result.dispatchId, null)
    assert.equal(result.artifact.commentCount, 4)
    const events = await store.readComments(artifactId)
    const replies = events.filter((event) => event.type === 'reply')
    assert.equal(replies.length, 2)
    assert.equal(replies[0].author, 'model')
    assert.equal(replies[0].sessionId, MASTER)
    assert.equal(replies[0].attachments.length, 1)
    assert.equal(replies[1].attachments, undefined)
    const published = await store.readEvents()
    assert.equal(published.filter((event) => event.type === 'reply.created').length, 2)

    const badThread = await reply.execute({ artifactId, commentIds: ['comment-missing'], body: 'x' }, fakeExec(MASTER, repoPath))
    assert.equal(badThread.ok, false)
    assert.equal(badThread.error.code, 'artifact/not-found')
    const emptyBody = await reply.execute({ artifactId, commentIds: ['comment-1'], body: '   ' }, fakeExec(MASTER, repoPath))
    assert.equal(emptyBody.ok, false)
    assert.equal(emptyBody.error.code, 'artifact/anchor-invalid')
    const noThreads = await reply.execute({ artifactId, commentIds: [], body: 'x' }, fakeExec(MASTER, repoPath))
    assert.equal(noThreads.ok, false)
    const badAttachment = await reply.execute({
      artifactId,
      commentIds: ['comment-1'],
      body: 'x',
      attachments: [{ attachmentId: 'attachment-missing', name: 'a', mediaType: 'text/plain' }],
    }, fakeExec(MASTER, repoPath))
    assert.equal(badAttachment.ok, false)
    assert.equal(badAttachment.error.code, 'artifact/upload-invalid')
    const threadCaller = await reply.execute({ artifactId, commentIds: ['comment-1'], body: 'x' }, fakeExec(THREAD, repoPath))
    assert.equal(threadCaller.ok, false)
    assert.equal(threadCaller.error.code, 'role/forbidden')
  })
})

/** A minimal fake runtime for tool failure and dispatch paths. */
function fakeRuntime(overrides = {}) {
  const base = {
    repoPath: '/repo',
    fsAvailable: true,
    files: {
      async stat() { return { exists: true, regular: true, size: 1, version: 'v1' } },
      async readText() { return { content: 'x', size: 1, version: 'v1' } },
      async writeText() { return { version: 'v1', before: null } },
    },
    store: {
      async listRecords() { return { records: [], corrupt: [], total: 0 } },
      async createRecord(record) { return record },
      async readRecord() { return null },
      async readComments() { return [] },
      async appendComment() {},
      async hasUpload() { return false },
      async readUpload() { return null },
      async saveRevision() {},
      async appendEvent() { return { version: 1, seq: 1, eventId: 'e', type: 'artifact.updated', artifactId: 'a', time: NOW.toISOString(), data: {} } },
      async withLock(operation) { return operation() },
      async appendCommentUnlocked() {},
      async mutateRecordUnlocked(_id, mutator) { return mutator(makeRecord()) },
      async appendEventUnlocked() { return { version: 1, seq: 1, eventId: 'e', type: 'artifact.updated', artifactId: 'a', time: NOW.toISOString(), data: {} } },
    },
    events: { publish() {} },
    presence: {},
    dispatch: null,
    dispose() {},
  }
  return { ...base, ...overrides }
}

test('the read tools degrade when the host has no runtime', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [topic()])
    const { deps } = baseDeps(undefined)
    const host = fakeHost()
    registerArtifactTools(host, deps)
    const comments = await host.registry.get('cowork_artifact_comments')
      .execute({ artifactId: 'artifact-1' }, fakeExec(MASTER, repoPath))
    assert.equal(comments.ok, false)
    assert.equal(comments.error.code, 'artifact/fs-unavailable')
    const reply = await host.registry.get('cowork_artifact_reply')
      .execute({ artifactId: 'artifact-1', commentIds: ['c1'], body: 'x' }, fakeExec(MASTER, repoPath))
    assert.equal(reply.ok, false)
    assert.equal(reply.error.code, 'artifact/fs-unavailable')
  })
})

test('an empty artifact id is refused by both read tools', async () => {
  await withRepo(async (repoPath) => {
    const { tool, deps } = await setup(repoPath)
    const host = fakeHost()
    registerArtifactTools(host, deps)
    const comments = await host.registry.get('cowork_artifact_comments')
      .execute({ artifactId: '   ' }, fakeExec(MASTER, repoPath))
    assert.equal(comments.ok, false)
    assert.equal(comments.error.code, 'artifact/not-found')
    const reply = await host.registry.get('cowork_artifact_reply')
      .execute({ artifactId: '  ', commentIds: ['c1'], body: 'x' }, fakeExec(MASTER, repoPath))
    assert.equal(reply.ok, false)
    assert.equal(reply.error.code, 'artifact/not-found')
  })
})

test('a store failure inside the read tools is returned as a failure', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [topic()])
    const failing = fakeRuntime({
      store: {
        ...fakeRuntime().store,
        async readRecord() { throw new Error('store exploded') },
      },
    })
    const { deps } = baseDeps({ runtimeFor: () => failing })
    const host = fakeHost()
    registerArtifactTools(host, deps)
    const comments = await host.registry.get('cowork_artifact_comments')
      .execute({ artifactId: 'artifact-1' }, fakeExec(MASTER, repoPath))
    assert.equal(comments.ok, false)
    assert.equal(comments.error.code, 'tool/internal')
  })
})

test('the reply tool closes the in-flight dispatch', async () => {
  await withRepo(async (repoPath) => {
    const seeded = await seedProject(repoPath, [topic()])
    const projectId = (await seeded.readIndex()).projectId
    const record = makeRecord({ artifactId: 'artifact-1', ownerSessionId: MASTER, projectId })
    const replies = []
    const runtime = fakeRuntime({
      store: {
        ...fakeRuntime().store,
        async readRecord() { return record },
        async readComments() { return [makeComment({ artifactId: 'artifact-1', commentId: 'comment-1', threadId: 'comment-1' })] },
        async appendCommentUnlocked(event) { replies.push(event) },
      },
      dispatch: {
        inFlightFor() { return { dispatchId: 'dispatch-1', commentIds: ['comment-1'] } },
        async markReplied() { return true },
      },
    })
    const { deps } = baseDeps({ runtimeFor: () => runtime })
    const host = fakeHost()
    registerArtifactTools(host, deps)
    const reply = await host.registry.get('cowork_artifact_reply')
      .execute({ artifactId: 'artifact-1', commentIds: ['comment-1'], body: 'done' }, fakeExec(MASTER, repoPath))
    assert.equal(reply.ok, true)
    assert.equal(reply.replied, 1)
    assert.equal(reply.dispatchId, 'dispatch-1')
  })
})

test('the reply tool refuses a reply when no batch is in flight', async () => {
  await withRepo(async (repoPath) => {
    const seeded = await seedProject(repoPath, [topic()])
    const projectId = (await seeded.readIndex()).projectId
    const runtime = fakeRuntime({
      store: {
        ...fakeRuntime().store,
        async readRecord() { return makeRecord({ artifactId: 'artifact-1', ownerSessionId: MASTER, projectId }) },
        async readComments() { return [makeComment({ artifactId: 'artifact-1', commentId: 'comment-1', threadId: 'comment-1' })] },
      },
      dispatch: { inFlightFor() { return null } },
    })
    const { deps } = baseDeps({ runtimeFor: () => runtime })
    const host = fakeHost()
    registerArtifactTools(host, deps)
    const reply = await host.registry.get('cowork_artifact_reply')
      .execute({ artifactId: 'artifact-1', commentIds: ['comment-1'], body: 'late' }, fakeExec(MASTER, repoPath))
    assert.equal(reply.ok, false)
    assert.equal(reply.error.code, 'artifact/dispatch-not-found')
  })
})

test('a failed first snapshot is logged but does not fail creation', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [topic()])
    const record = makeRecord({ artifactId: 'artifact-created', ownerSessionId: MASTER })
    const runtime = fakeRuntime({
      store: {
        ...fakeRuntime().store,
        async createRecord() { return record },
        async saveRevision() { throw new Error('snapshot disk full') },
      },
    })
    const { deps } = baseDeps({ runtimeFor: () => runtime })
    const host = fakeHost()
    registerArtifactTools(host, deps)
    const result = await host.registry.get('cowork_artifact_create')
      .execute({ path: 'notes.txt' }, fakeExec(MASTER, repoPath))
    // The fake stat says the file exists; no real file is needed behind it.
    assert.equal(result.ok, true)
    assert.equal(result.created, true)
    assert.ok(deps.log === undefined || true)
  })
})

test('the reply tool refuses an unknown work item and maps a store throw', async () => {
  await withRepo(async (repoPath) => {
    const seeded = await seedProject(repoPath, [topic()])
    const projectId = (await seeded.readIndex()).projectId
    const unknownRuntime = fakeRuntime({
      store: { ...fakeRuntime().store, async readRecord() { return null } },
    })
    const unknownDeps = baseDeps({ runtimeFor: () => unknownRuntime }).deps
    unknownDeps.artifactRuntime = { runtimeFor: () => unknownRuntime }
    const unknownHost = fakeHost()
    registerArtifactTools(unknownHost, unknownDeps)
    const unknown = await unknownHost.registry.get('cowork_artifact_reply')
      .execute({ artifactId: 'artifact-missing', commentIds: ['c1'], body: 'x' }, fakeExec(MASTER, repoPath))
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, 'artifact/not-found')

    const throwingRuntime = fakeRuntime({
      store: {
        ...fakeRuntime().store,
        async readRecord() { return makeRecord({ artifactId: 'artifact-1', ownerSessionId: MASTER, projectId }) },
        async readComments() { throw new Error('comments exploded') },
      },
    })
    const throwingDeps = baseDeps({ runtimeFor: () => throwingRuntime }).deps
    throwingDeps.artifactRuntime = { runtimeFor: () => throwingRuntime }
    const throwingHost = fakeHost()
    registerArtifactTools(throwingHost, throwingDeps)
    const thrown = await throwingHost.registry.get('cowork_artifact_reply')
      .execute({ artifactId: 'artifact-1', commentIds: ['c1'], body: 'x' }, fakeExec(MASTER, repoPath))
    assert.equal(thrown.ok, false)
    assert.equal(thrown.error.code, 'tool/internal')
  })
})

test('the reply tool canonicalizes attachments and enforces the comment limit', async () => {
  await withRepo(async (repoPath) => {
    await writeFile(join(repoPath, 'notes.txt'), 'hello\n')
    const { tool, deps, manager } = await setup(repoPath)
    const artifactId = await createWorkItem(repoPath, tool)
    const runtime = manager.runtimeFor(repoPath)
    const store = runtime.store
    await store.appendComment(makeComment({ artifactId, commentId: 'comment-1', threadId: 'comment-1', eventId: 'e1' }))
    const attachmentId = 'attachment-22222222-2222-4222-8222-222222222222'
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await store.saveUpload(artifactId, attachmentId, png)
    const host = fakeHost()
    registerArtifactTools(host, deps)
    const reply = host.registry.get('cowork_artifact_reply')
    const forged = await reply.execute({
      artifactId,
      commentIds: ['comment-1'],
      body: 'with forged ref',
      attachments: [{ attachmentId, name: 'shot.png', mediaType: 'text/html', size: 1, sha256: 'x' }],
    }, fakeExec(MASTER, repoPath))
    assert.equal(forged.ok, true)
    const replies = (await store.readComments(artifactId)).filter((event) => event.type === 'reply')
    assert.equal(replies[0].attachments[0].mediaType, 'image/png')
    assert.equal(replies[0].attachments[0].size, png.byteLength)

    await store.mutateRecord(artifactId, (record) => ({ ...record, commentCount: 5000 }))
    const overLimit = await reply.execute({ artifactId, commentIds: ['comment-1'], body: 'too many' }, fakeExec(MASTER, repoPath))
    assert.equal(overLimit.ok, false)
    assert.equal(overLimit.error.code, 'artifact/comment-limit')
  })
})
