import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import '../support/ts-hook.mjs'
import {
  artifactContract,
  artifactRuntime,
  fakeHostFs,
  makeRepo,
} from '../support/artifact-fixtures.mjs'
import { makeSeedProject, makeTopicFixture, withRepo } from '../support/inbox-fixtures.mjs'

/**
 * `cowork_artifact_attach` publishes a project file as a work-item attachment.
 *
 * These tests cover the tool wrapper: role gate, the lexical + realpath path
 * checks, the type/size/count limits, `source: 'model'`, and the rule that
 * attaching needs no in-flight annotation batch (unlike `cowork_artifact_reply`).
 */
const { registerArtifactTools } = await import('../../src/tools/artifact.ts')

const NOW = new Date('2026-02-01T12:00:00.000Z')
const MASTER = 'session-master'
const THREAD = 'session-thread'
const ARTIFACT_ID = 'artifact-11111111-1111-4111-8111-111111111111'
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
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

/** Host ports the attach tool never calls. */
function baseDeps(artifactRuntimePort) {
  return {
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
    log() {},
    artifactRuntime: artifactRuntimePort,
  }
}

/** Seed the project and register the artifact tools over a real runtime. */
async function setup(repoPath, options = {}) {
  await seedProject(repoPath, [topic()])
  const manager = new artifactRuntime.ArtifactRuntimeManager({
    hostFs: options.hostFs ?? fakeHostFs(),
    ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
  })
  const host = fakeHost()
  registerArtifactTools(host, baseDeps({ runtimeFor: (path) => manager.runtimeFor(path) }))
  return { host, manager, tool: host.registry.get('cowork_artifact_attach') }
}

/** Register one text work item through the create tool and return its id. */
async function createWorkItem(repoPath, host) {
  const created = await host.registry.get('cowork_artifact_create')
    .execute({ path: 'notes.txt' }, fakeExec(MASTER, repoPath))
  assert.equal(created.ok, true)
  return created.artifact.artifactId
}

test('the attach tool declares its three parameters', async () => {
  await withRepo(async (repoPath) => {
    const { tool } = await setup(repoPath)
    assert.equal(typeof tool.description, 'string')
    assert.equal(tool.parameters.type, 'object')
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['artifactId', 'name', 'sourcePath'])
    assert.deepEqual(tool.parameters.required, ['artifactId', 'sourcePath'])
  })
})

test('a project file is published as a model attachment', async () => {
  await withRepo(async (repoPath) => {
    await writeFile(join(repoPath, 'notes.txt'), 'hello\n')
    await mkdir(join(repoPath, 'docs'), { recursive: true })
    await writeFile(join(repoPath, 'docs/chart.png'), PNG_BYTES)
    const { host, manager, tool } = await setup(repoPath)
    const artifactId = await createWorkItem(repoPath, host)
    const runtime = manager.runtimeFor(repoPath)
    const published = []
    runtime.events.subscribe({}, (event) => published.push(event))

    const result = await tool.execute({ artifactId, sourcePath: 'docs/chart.png' }, fakeExec(MASTER, repoPath))
    assert.equal(result.ok, true)
    assert.equal(result.source, 'model')
    assert.equal(result.published, true)
    assert.equal(result.attachment.name, 'chart.png')
    assert.equal(result.attachment.mediaType, 'image/png')
    assert.equal(result.attachment.size, PNG_BYTES.byteLength)
    assert.equal(result.attachment.sha256, sha256Bytes(PNG_BYTES))
    assert.equal(result.record.attachmentCount, 1)
    assert.equal(result.record.artifactId, artifactId)

    const rows = await runtime.store.readAttachmentPublishes(artifactId)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].source, 'model')
    assert.equal(rows[0].attachmentId, result.attachment.attachmentId)
    const stored = await runtime.store.readUpload(artifactId, result.attachment.attachmentId)
    assert.deepEqual([...stored], [...PNG_BYTES])
    assert.ok(published.some((event) => event.type === 'artifact.updated'
      && event.data.attachmentId === result.attachment.attachmentId))
    assert.equal((await runtime.store.readRecord(artifactId)).attachmentCount, 1)
  })
})

test('attaching the same source path twice mints a new id', async () => {
  await withRepo(async (repoPath) => {
    await writeFile(join(repoPath, 'notes.txt'), 'hello\n')
    await writeFile(join(repoPath, 'chart.png'), PNG_BYTES)
    const { host, manager, tool } = await setup(repoPath)
    const artifactId = await createWorkItem(repoPath, host)
    const first = await tool.execute({ artifactId, sourcePath: 'chart.png' }, fakeExec(MASTER, repoPath))
    const second = await tool.execute({ artifactId, sourcePath: 'chart.png' }, fakeExec(MASTER, repoPath))
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.notEqual(second.attachment.attachmentId, first.attachment.attachmentId)
    assert.equal(second.record.attachmentCount, 2)
    assert.equal((await manager.runtimeFor(repoPath).store.readAttachmentPublishes(artifactId)).length, 2)
  })
})

test('the display name is sanitized and defaults to the file base name', async () => {
  await withRepo(async (repoPath) => {
    await writeFile(join(repoPath, 'notes.txt'), 'hello\n')
    await writeFile(join(repoPath, 'chart.png'), PNG_BYTES)
    const { host, tool } = await setup(repoPath)
    const artifactId = await createWorkItem(repoPath, host)
    const custom = await tool.execute({
      artifactId,
      sourcePath: 'chart.png',
      name: `  Growth\u0000 ${'名'.repeat(300)}  `,
    }, fakeExec(MASTER, repoPath))
    assert.equal(custom.ok, true)
    assert.equal(custom.attachment.name.includes('\u0000'), false)
    assert.equal([...custom.attachment.name].length, artifactContract.MAX_ARTIFACT_ATTACHMENT_NAME_CHARS)
    assert.equal(custom.attachment.name.startsWith('Growth'), true)
    // The display name never decides the media type; the source path does.
    assert.equal(custom.attachment.mediaType, 'image/png')
  })
})

test('lexical path rules and the credential list are enforced', async () => {
  await withRepo(async (repoPath) => {
    await writeFile(join(repoPath, 'notes.txt'), 'hello\n')
    const { host, tool } = await setup(repoPath)
    const artifactId = await createWorkItem(repoPath, host)
    for (const sourcePath of ['../secret.png', '/etc/passwd', 'docs\\chart.png', '.git/config', '.dsh-cowork/x', 'id_rsa', '.env']) {
      const result = await tool.execute({ artifactId, sourcePath }, fakeExec(MASTER, repoPath))
      assert.equal(result.ok, false, sourcePath)
      assert.equal(result.error.code, 'artifact/path-not-allowed', sourcePath)
    }
    const missing = await tool.execute({ artifactId, sourcePath: 'docs/absent.png' }, fakeExec(MASTER, repoPath))
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'artifact/file-missing')
    // A missing sourcePath never reaches the handler: the tool schema refuses it.
    await assert.rejects(
      async () => tool.execute({ artifactId }, fakeExec(MASTER, repoPath)),
      /missing required property "sourcePath"/,
    )
  })
})

test('a symlink that resolves outside the repository is refused', async () => {
  await withRepo(async (repoPath) => {
    await writeFile(join(repoPath, 'notes.txt'), 'hello\n')
    const outside = await makeRepo({ 'secret.png': PNG_BYTES })
    try {
      await mkdir(join(repoPath, 'docs'), { recursive: true })
      await symlink(join(outside.repoPath, 'secret.png'), join(repoPath, 'docs/leak.png'))
      const { host, tool } = await setup(repoPath)
      const artifactId = await createWorkItem(repoPath, host)
      const result = await tool.execute({ artifactId, sourcePath: 'docs/leak.png' }, fakeExec(MASTER, repoPath))
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'artifact/path-not-allowed')
    } finally {
      await outside.remove()
    }
  })
})

test('unsupported types, mismatched bytes, and oversized files are refused', async () => {
  await withRepo(async (repoPath) => {
    await writeFile(join(repoPath, 'notes.txt'), 'hello\n')
    await writeFile(join(repoPath, 'chart.svg'), PNG_BYTES)
    await writeFile(join(repoPath, 'page.html'), '<b>x</b>\n')
    await writeFile(join(repoPath, 'chart.png'), 'not-a-png\n')
    await writeFile(join(repoPath, 'big.png'), Buffer.alloc(artifactContract.MAX_ARTIFACT_ATTACHMENT_BYTES + 1))
    const { host, tool } = await setup(repoPath)
    const artifactId = await createWorkItem(repoPath, host)
    for (const sourcePath of ['chart.svg', 'page.html', 'chart.png']) {
      const result = await tool.execute({ artifactId, sourcePath }, fakeExec(MASTER, repoPath))
      assert.equal(result.ok, false, sourcePath)
      assert.equal(result.error.code, 'artifact/upload-invalid', sourcePath)
    }
    const oversized = await tool.execute({ artifactId, sourcePath: 'big.png' }, fakeExec(MASTER, repoPath))
    assert.equal(oversized.ok, false)
    assert.equal(oversized.error.code, 'artifact/file-too-large')

    await writeFile(join(repoPath, 'empty.txt'), '')
    const empty = await tool.execute({ artifactId, sourcePath: 'empty.txt' }, fakeExec(MASTER, repoPath))
    assert.equal(empty.ok, false)
    assert.equal(empty.error.code, 'artifact/upload-invalid')
  })
})

test('the published attachment cap is enforced before the bytes are stored', async () => {
  await withRepo(async (repoPath) => {
    await writeFile(join(repoPath, 'notes.txt'), 'hello\n')
    await writeFile(join(repoPath, 'chart.png'), PNG_BYTES)
    const { host, manager, tool } = await setup(repoPath)
    const artifactId = await createWorkItem(repoPath, host)
    const store = manager.runtimeFor(repoPath).store
    await store.mutateRecord(artifactId, (record) => ({
      ...record,
      attachmentCount: artifactContract.MAX_ARTIFACT_ATTACHMENTS,
    }))
    const result = await tool.execute({ artifactId, sourcePath: 'chart.png' }, fakeExec(MASTER, repoPath))
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'artifact/limit-reached')
    // Refused before any bytes were stored: no orphan upload, no publish row.
    assert.deepEqual(await store.readAttachmentPublishes(artifactId), [])
    assert.equal(await store.hasUpload(artifactId, result.attachment?.attachmentId ?? ''), false)
  })
})

test('the role and work-item gates fail closed', async () => {
  await withRepo(async (repoPath) => {
    await writeFile(join(repoPath, 'notes.txt'), 'hello\n')
    await writeFile(join(repoPath, 'chart.png'), PNG_BYTES)
    const { host, tool } = await setup(repoPath)
    const artifactId = await createWorkItem(repoPath, host)
    const stranger = await tool.execute({ artifactId, sourcePath: 'chart.png' }, fakeExec('stranger-session', repoPath))
    assert.equal(stranger.ok, false)
    assert.equal(stranger.error.code, 'role/forbidden')
    const otherThread = await tool.execute({ artifactId, sourcePath: 'chart.png' }, fakeExec(THREAD, repoPath))
    assert.equal(otherThread.ok, false)
    assert.equal(otherThread.error.code, 'role/forbidden')
    const unknown = await tool.execute({ artifactId: ARTIFACT_ID, sourcePath: 'chart.png' }, fakeExec(MASTER, repoPath))
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, 'artifact/not-found')
    const blank = await tool.execute({ artifactId: '  ', sourcePath: 'chart.png' }, fakeExec(MASTER, repoPath))
    assert.equal(blank.ok, false)
    assert.equal(blank.error.code, 'artifact/not-found')
  })
})

test('a host without a runtime answers fs-unavailable', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [topic()])
    await writeFile(join(repoPath, 'notes.txt'), 'hello\n')
    await writeFile(join(repoPath, 'chart.png'), PNG_BYTES)
    const host = fakeHost()
    registerArtifactTools(host, baseDeps(undefined))
    const result = await host.registry.get('cowork_artifact_attach')
      .execute({ artifactId: ARTIFACT_ID, sourcePath: 'chart.png' }, fakeExec(MASTER, repoPath))
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'artifact/fs-unavailable')
  })
})

test('attaching needs no in-flight annotation batch', async () => {
  await withRepo(async (repoPath) => {
    await writeFile(join(repoPath, 'notes.txt'), 'hello\n')
    await writeFile(join(repoPath, 'chart.png'), PNG_BYTES)
    const { host, manager, tool } = await setup(repoPath, {
      prompt: { async prompt() { return { accepted: true } } },
    })
    const runtime = manager.runtimeFor(repoPath)
    assert.notEqual(runtime.dispatch, null)
    const artifactId = await createWorkItem(repoPath, host)
    const result = await tool.execute({ artifactId, sourcePath: 'chart.png' }, fakeExec(MASTER, repoPath))
    assert.equal(result.ok, true)
    assert.equal(result.published, true)
    assert.equal(runtime.dispatch.inFlightFor(artifactId), null)
  })
})

/** Lowercase hex SHA-256 of raw bytes. */
function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
