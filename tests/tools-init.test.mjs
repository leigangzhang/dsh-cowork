import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Contract test for the `cowork_project_init` tool wrapper: the argument
 * schema, the fail-closed default, the explicit takeover, and the response
 * shape. `src/tools.ts` value-imports its siblings as `./x.js`, which Node's
 * type stripping does not retry as `.ts`, so this test installs the same small
 * resolve hook `tests/presets.test.mjs` uses. No host is assembled: the tool
 * registry and the session/workspace ports are recording fakes, and the only
 * real collaborator is the project store on a throwaway repository.
 */
const HOOK_SOURCE = [
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier.startsWith('.') && specifier.endsWith('.js')) {",
  "    try { return await nextResolve(specifier.slice(0, -3) + '.ts', context) } catch {}",
  '  }',
  '  return nextResolve(specifier, context)',
  '}',
].join('\n')
register(`data:text/javascript,${encodeURIComponent(HOOK_SOURCE)}`)

const { registerCoworkTools } = await import('../src/tools.ts')
const { ProjectStore } = await import('../src/store.ts')
const { ERROR_CODES } = await import('../src/tool-model.ts')

const CLOCK = () => new Date('2026-11-07T10:00:00.000Z')

/** A tool registry that keeps every definition the assembly registers. */
function fakeHost() {
  const registry = new Map()
  return {
    tools: {
      register(definition) {
        registry.set(definition.name, definition)
        return () => registry.delete(definition.name)
      },
    },
    registry,
  }
}

/** The structured execution identity one tool call receives. */
function fakeExec(sessionId, cwd, agentPreset = 'router-standard') {
  return { agent: { id: sessionId, session: { header: { cwd, agentPreset } } } }
}

/** The host ports the init tool touches: only the workspace lookup, archive port, and clock. */
function fakeDeps() {
  return {
    sessionController: {
      async create() { return { sessionId: 'session-created', agentPreset: 'cowork-thread' } },
      async rename({ title }) { return { title, seq: 1 } },
      async prompt() { return { accepted: true } },
      async list() { return { items: [] } },
      async inspect(sessionId) { return { meta: { id: sessionId } } },
    },
    workspaceRegistry: {
      archiveCalls: [],
      async resolveByPath(path) { return { id: 'workspace-1', path } },
      async create(path) { return { id: 'workspace-1', path } },
      async delete() { return true },
      async archiveSession(sessionId, options) {
        this.archiveCalls.push({ sessionId, options })
      },
    },
    agentPresets: { async register() { return async () => {} } },
    clock: CLOCK,
  }
}

async function withRepo(run) {
  const repoPath = await mkdtemp(join(tmpdir(), 'dsh-cowork-init-'))
  try {
    return await run(repoPath)
  } finally {
    await rm(repoPath, { recursive: true, force: true })
  }
}

test('cowork_project_init keeps a different session fail-closed until takeOver is explicit', async () => {
  await withRepo(async (repoPath) => {
    const host = fakeHost()
    registerCoworkTools(host, fakeDeps())
    const init = host.registry.get('cowork_project_init')
    assert.ok(init, 'the assembly must register cowork_project_init')

    // The parameter is optional and declared as a boolean, so a model can omit it.
    assert.equal(init.parameters.properties.takeOver.type, 'boolean')
    assert.ok(!(init.parameters.required ?? []).includes('takeOver'))

    const first = await init.execute({}, fakeExec('session-a', repoPath))
    assert.equal(first.ok, true)
    assert.equal(first.created, true)
    assert.equal(first.rebound, false)
    assert.equal(first.masterSessionId, 'session-a')
    assert.equal(first.previousMasterSessionId, 'session-a')

    const denied = await init.execute({}, fakeExec('session-b', repoPath))
    assert.equal(denied.ok, false)
    assert.equal(denied.error.code, ERROR_CODES.roleForbidden)
    assert.match(denied.error.message, /takeOver: true/)
    assert.deepEqual(denied.error.details, {
      role: 'master',
      sessionId: 'session-b',
      masterSessionId: 'session-a',
    })

    // A thread record must survive the takeover untouched.
    const store = new ProjectStore({ repoPath, clock: CLOCK })
    await store.addThread({
      threadId: 'session-thread',
      subject: 'keep me',
      status: 'new',
      cwd: repoPath,
      checkoutPath: null,
      createdAt: '2026-11-07T09:00:00.000Z',
      updatedAt: '2026-11-07T09:00:00.000Z',
      lastHandoffAt: null,
      reviewStatus: null,
      reviewRequestedAt: null,
      reviewedAt: null,
      reviewerSessionId: null,
      latestReviewPath: null,
    })
    const before = await store.readIndex()

    const taken = await init.execute({ takeOver: true }, fakeExec('session-b', repoPath))
    assert.equal(taken.ok, true)
    assert.equal(taken.created, false)
    assert.equal(taken.rebound, true)
    assert.equal(taken.masterSessionId, 'session-b')
    assert.equal(taken.previousMasterSessionId, 'session-a')
    assert.equal(taken.projectId, before.projectId)
    assert.equal(taken.index.createdAt, before.createdAt)
    assert.deepEqual(taken.index.threads.map((entry) => entry.threadId), ['session-thread'])
    assert.equal(taken.workspaceId, 'workspace-1')

    const onDisk = JSON.parse(await readFile(join(repoPath, '.dsh-cowork', 'index.json'), 'utf8'))
    assert.equal(onDisk.masterSessionId, 'session-b')
    assert.equal(onDisk.version, 2)
    assert.deepEqual(onDisk.topics.map((topic) => topic.topicId), ['session-thread'])
    assert.equal('threads' in onDisk, false)

    // A session the index records as a thread can never take over.
    const threadDenied = await init.execute({ takeOver: true }, fakeExec('session-thread', repoPath))
    assert.equal(threadDenied.ok, false)
    assert.equal(threadDenied.error.code, ERROR_CODES.roleForbidden)
    assert.match(threadDenied.error.message, /thread/)

    // The schema is enforced for real calls, not just declared.
    await assert.rejects(init.execute({ takeOver: 'yes' }, fakeExec('session-c', repoPath)), /takeOver/)
  })
})

test('cowork_project_init migrates a v1 index and archives the cancelled reviewer', async () => {
  await withRepo(async (repoPath) => {
    const store = new ProjectStore({ repoPath, clock: CLOCK, projectId: 'p' })
    const original = `${JSON.stringify({
      version: 1,
      projectId: 'p',
      masterSessionId: 'session-a',
      createdAt: '2026-11-07T09:00:00.000Z',
      threads: [
        {
          threadId: 'session-thread',
          subject: 'in flight',
          status: 'awaiting_review',
          cwd: repoPath,
          checkoutPath: null,
          createdAt: '2026-11-07T09:00:00.000Z',
          updatedAt: '2026-11-07T09:00:00.000Z',
          lastHandoffAt: '2026-11-07T09:00:00.000Z',
          reviewStatus: 'pending',
          reviewRequestedAt: '2026-11-07T09:00:00.000Z',
          reviewedAt: null,
          reviewerSessionId: 'session-reviewer',
          latestReviewPath: null,
        },
      ],
    })}\n`
    await mkdir(join(repoPath, '.dsh-cowork'), { recursive: true })
    await writeFile(store.indexFile, original, 'utf8')

    const host = fakeHost()
    const deps = fakeDeps()
    registerCoworkTools(host, deps)
    const init = host.registry.get('cowork_project_init')

    // Takeover is the write that migrates; the archive port must see the
    // cancellation with stopActivity so a running reviewer is not refused.
    const taken = await init.execute({ takeOver: true }, fakeExec('session-b', repoPath))
    assert.equal(taken.ok, true)
    assert.equal(taken.rebound, true)
    assert.deepEqual(deps.workspaceRegistry.archiveCalls, [
      { sessionId: 'session-reviewer', options: { stopActivity: true } },
    ])

    const onDisk = JSON.parse(await readFile(store.indexFile, 'utf8'))
    assert.equal(onDisk.version, 2)
    assert.equal('threads' in onDisk, false)
    assert.equal(onDisk.masterSessionId, 'session-b')
    assert.equal(onDisk.topics[0].reviewerSessionId, null)
    assert.equal(onDisk.topics[0].awaitingReview, false)

    // The backup is the byte-exact v1 document, written once before v2.
    assert.equal(await readFile(store.backupFile, 'utf8'), original)
    assert.equal(taken.index.threads[0].status, 'active', 'the cancelled review reads as active')
  })
})
