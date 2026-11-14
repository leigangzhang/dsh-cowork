import test from 'node:test'
import assert from 'node:assert/strict'
import { REVIEW_TITLE_PREFIX, SessionSlice, THREAD_TITLE_PREFIX } from '../../src/platform/session-slice.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Recording fake for the two host services. Every port call is appended to
 * `calls`, so assertions can check both the arguments and whether a call was
 * made at all (for example: no workspace create on a resolve hit).
 */
function fakePorts(overrides = {}) {
  const calls = {
    resolveByPath: [],
    createWorkspace: [],
    createSession: [],
    rename: [],
    prompt: [],
    list: [],
    inspect: [],
    deleteWorkspace: [],
    archiveSession: [],
    attachSession: [],
  }
  const ports = {
    sessions: {
      async create(request) {
        calls.createSession.push(request)
        return overrides.createResult ?? { sessionId: 'session-1', agentPreset: request.agentPreset }
      },
      async rename(request) {
        calls.rename.push(request)
        return overrides.renameResult ?? { title: request.title, seq: calls.rename.length }
      },
      async prompt(request, signal) {
        calls.prompt.push({ request, signal })
        return overrides.promptResult ?? { accepted: true }
      },
      async list(request, signal) {
        calls.list.push({ request, signal })
        return overrides.listResult ?? { items: [] }
      },
      async inspect(sessionId, signal) {
        calls.inspect.push({ sessionId, signal })
        return overrides.inspectResult ?? { meta: { id: sessionId } }
      },
    },
    workspaces: {
      async resolveByPath(path) {
        calls.resolveByPath.push(path)
        return overrides.resolvedWorkspace
      },
      async create(...args) {
        calls.createWorkspace.push(args)
        return overrides.createdWorkspace ?? { id: 'workspace-new', path: args[0] }
      },
      async delete(id) {
        calls.deleteWorkspace.push(id)
        return overrides.deleteResult ?? true
      },
      async archiveSession(sessionId, options) {
        calls.archiveSession.push({ sessionId, options })
      },
      async attachSession(workspaceId, sessionId) {
        calls.attachSession.push({ workspaceId, sessionId })
        if (overrides.attachError !== undefined) throw new Error(overrides.attachError)
      },
    },
  }
  return { ports, calls }
}

test('resolveWorkspaceId returns the existing workspace id without creating one', async () => {
  const { ports, calls } = fakePorts({
    resolvedWorkspace: { id: 'workspace-existing', path: '/repo' },
  })
  const slice = new SessionSlice(ports)

  assert.equal(await slice.resolveWorkspaceId('/repo'), 'workspace-existing')
  assert.deepEqual(calls.resolveByPath, ['/repo'])
  assert.deepEqual(calls.createWorkspace, [])
})

test('resolveWorkspaceId creates a workspace without a title only when unresolved', async () => {
  const { ports, calls } = fakePorts({ createdWorkspace: { id: 'workspace-new', path: '/repo' } })
  const slice = new SessionSlice(ports)

  assert.equal(await slice.resolveWorkspaceId('/repo'), 'workspace-new')
  // Exactly one positional argument: the host derives the title from the last
  // path segment, so passing one would pin a stale label.
  assert.deepEqual(calls.createWorkspace, [['/repo']])
})

test('resolveWorkspaceId does not cache: a second call asks the registry again', async () => {
  const { ports, calls } = fakePorts({ resolvedWorkspace: undefined, createdWorkspace: { id: 'ws', path: '/repo' } })
  const slice = new SessionSlice(ports)

  await slice.resolveWorkspaceId('/repo')
  await slice.resolveWorkspaceId('/repo')
  assert.equal(calls.resolveByPath.length, 2)
  assert.equal(calls.createWorkspace.length, 2)
})

test('attachSession forwards the pair and reports success', async () => {
  const { ports, calls } = fakePorts()
  const slice = new SessionSlice(ports)

  assert.deepEqual(await slice.attachSession('workspace-1', 'session-a'), { attached: true })
  assert.deepEqual(calls.attachSession, [{ workspaceId: 'workspace-1', sessionId: 'session-a' }])
})

test('attachSession reports a host refusal as a value instead of throwing', async () => {
  const { ports } = fakePorts({ attachError: 'its cwd resolves elsewhere' })
  const slice = new SessionSlice(ports)

  assert.deepEqual(await slice.attachSession('workspace-1', 'session-a'), {
    attached: false,
    error: 'its cwd resolves elsewhere',
  })
})

test('attachSession reports a port without attachment instead of claiming success', async () => {
  const { ports } = fakePorts()
  delete ports.workspaces.attachSession
  const slice = new SessionSlice(ports)

  const result = await slice.attachSession('workspace-1', 'session-a')
  assert.equal(result.attached, false)
  assert.match(result.error, /attachSession/)
})

test('createThread creates the session with the resolved workspace and preset, then renames it', async () => {
  const { ports, calls } = fakePorts({
    resolvedWorkspace: { id: 'workspace-existing', path: '/repo' },
    createResult: { sessionId: 'session-9', agentPreset: 'cowork-topic' },
  })
  const slice = new SessionSlice(ports)

  const result = await slice.createThread({
    repoPath: '/repo',
    subject: 'Sub 2',
    presetId: 'cowork-topic',
  })

  assert.deepEqual(result, { sessionId: 'session-9', workspaceId: 'workspace-existing', title: 'cowork: Sub 2' })
  assert.deepEqual(calls.createSession, [{ workspaceId: 'workspace-existing', agentPreset: 'cowork-topic' }])
  assert.deepEqual(calls.rename, [{ sessionId: 'session-9', title: 'cowork: Sub 2' }])
  assert.equal(THREAD_TITLE_PREFIX, 'cowork: ')
  assert.equal(calls.list.length, 0, 'createThread must not write the index or list sessions')
})

test('createThread uses the title returned by the host, not the requested one', async () => {
  const { ports } = fakePorts({
    resolvedWorkspace: { id: 'ws', path: '/repo' },
    createResult: { sessionId: 'session-9', agentPreset: 'cowork-topic' },
    renameResult: { title: 'cowork: Sub 2 (2)', seq: 1 },
  })
  const slice = new SessionSlice(ports)

  const result = await slice.createThread({ repoPath: '/repo', subject: 'Sub 2', presetId: 'cowork-topic' })
  assert.equal(result.title, 'cowork: Sub 2 (2)')
})

test('createThread fails closed when the created session did not mount the preset', async () => {
  for (const returned of [undefined, 'standard']) {
    const { ports, calls } = fakePorts({
      resolvedWorkspace: { id: 'ws', path: '/repo' },
      createResult: { sessionId: 'session-bad', agentPreset: returned },
    })
    const slice = new SessionSlice(ports)

    await assert.rejects(
      slice.createThread({ repoPath: '/repo', subject: 'Sub', presetId: 'cowork-topic' }),
      { message: /^session\/create-preset-mismatch:/ },
      `preset ${String(returned)} must not be accepted`,
    )
    assert.equal(calls.rename.length, 0, 'a mismatched session must not be renamed')
  }
})

test('createThread creates the workspace when the path is unknown and then uses its id', async () => {
  const { ports, calls } = fakePorts({
    createdWorkspace: { id: 'workspace-created', path: '/repo' },
    createResult: { sessionId: 'session-3', agentPreset: 'cowork-topic' },
  })
  const slice = new SessionSlice(ports)

  const result = await slice.createThread({ repoPath: '/repo', subject: 'S', presetId: 'cowork-topic' })
  assert.equal(result.workspaceId, 'workspace-created')
  assert.deepEqual(calls.createSession, [{ workspaceId: 'workspace-created', agentPreset: 'cowork-topic' }])
})

test('createCheckoutThread creates the workspace on the clone, then the explicit session, then renames', async () => {
  const checkoutPath = '/repo/.dsh-cowork/threads/session-x'
  const { ports, calls } = fakePorts({
    createdWorkspace: { id: 'workspace-clone', path: checkoutPath },
    createResult: { sessionId: 'session-x', agentPreset: 'cowork-topic' },
  })
  const slice = new SessionSlice(ports)

  const result = await slice.createCheckoutThread({
    repoPath: '/repo',
    checkoutPath,
    threadId: 'session-x',
    subject: 'isolated work',
    presetId: 'cowork-topic',
  })

  assert.deepEqual(result, {
    sessionId: 'session-x',
    workspaceId: 'workspace-clone',
    title: 'cowork: isolated work',
  })
  // The workspace sits on the clone, and the title is passed with it.
  assert.deepEqual(calls.createWorkspace, [[checkoutPath, 'cowork: isolated work']])
  // The caller's thread id is the session id: it names the clone and the branch.
  assert.deepEqual(calls.createSession, [{
    sessionId: 'session-x',
    workspaceId: 'workspace-clone',
    agentPreset: 'cowork-topic',
  }])
  assert.deepEqual(calls.rename, [{ sessionId: 'session-x', title: 'cowork: isolated work' }])
  assert.deepEqual(calls.resolveByPath, [], 'the checkout flow must not reuse the project workspace')
})

test('createCheckoutThread fails closed when the session did not mount the preset', async () => {
  const { ports, calls } = fakePorts({
    createdWorkspace: { id: 'workspace-clone', path: '/repo/.dsh-cowork/threads/session-x' },
    createResult: { sessionId: 'session-x', agentPreset: 'standard' },
  })
  const slice = new SessionSlice(ports)

  await assert.rejects(
    slice.createCheckoutThread({
      repoPath: '/repo',
      checkoutPath: '/repo/.dsh-cowork/threads/session-x',
      threadId: 'session-x',
      subject: 'isolated',
      presetId: 'cowork-topic',
    }),
    { message: /^session\/create-preset-mismatch:/ },
  )
  assert.equal(calls.rename.length, 0, 'a mismatched session must not be renamed')
})

test('createCheckoutThread fails closed when the host returns a different session id', async () => {
  const checkoutPath = '/repo/.dsh-cowork/threads/session-x'
  const { ports, calls } = fakePorts({
    createdWorkspace: { id: 'workspace-clone', path: checkoutPath },
    // The host minted its own id instead of honouring the requested one.
    createResult: { sessionId: 'session-host-minted', agentPreset: 'cowork-topic' },
  })
  const slice = new SessionSlice(ports)

  await assert.rejects(
    slice.createCheckoutThread({
      repoPath: '/repo',
      checkoutPath,
      threadId: 'session-x',
      subject: 'isolated',
      presetId: 'cowork-topic',
    }),
    (error) => {
      assert.match(error.message, /^session\/create-id-mismatch:/)
      // Both ids are in the message: the caller has to know which one it asked for.
      assert.match(error.message, /session-x/)
      assert.match(error.message, /session-host-minted/)
      return true
    },
  )

  // The rename is what would retitle a session that does not own the clone, and
  // the caller writes the index only after this method returns, so neither ran.
  assert.equal(calls.rename.length, 0, 'a foreign session must not be renamed')
  assert.deepEqual(
    calls.createSession,
    [{ sessionId: 'session-x', workspaceId: 'workspace-clone', agentPreset: 'cowork-topic' }],
    'the requested id is still what the host was asked for',
  )
})

test('deleteWorkspace and archiveSession delegate to the workspace registry', async () => {
  const { ports, calls } = fakePorts({ deleteResult: false })
  const slice = new SessionSlice(ports)

  assert.equal(await slice.deleteWorkspace('workspace-1'), false)
  // No options keeps the historical call shape: the port sees `undefined`.
  await slice.archiveSession('session-x')
  assert.deepEqual(calls.deleteWorkspace, ['workspace-1'])
  assert.deepEqual(calls.archiveSession, [{ sessionId: 'session-x', options: undefined }])

  // The M7 migration cancels an in-flight review and must forward the archive
  // option verbatim, otherwise the host refuses to archive a running reviewer.
  await slice.archiveSession('session-reviewer', { stopActivity: true })
  assert.deepEqual(calls.archiveSession[1], {
    sessionId: 'session-reviewer',
    options: { stopActivity: true },
  })

  const failing = fakePorts()
  failing.ports.workspaces.archiveSession = async (sessionId, options) => {
    failing.calls.archiveSession.push({ sessionId, options })
    throw new Error('session is busy')
  }
  await assert.rejects(
    new SessionSlice(failing.ports).archiveSession('session-busy', { stopActivity: true }),
    /session is busy/,
  )
})

test('promptSession queues text with the injected request id and a bounded signal', async () => {
  const { ports, calls } = fakePorts()
  const slice = new SessionSlice(ports, { requestId: () => 'req-fixed' })

  const result = await slice.promptSession('session-1', 'please continue')
  assert.deepEqual(result, { accepted: true, requestId: 'req-fixed' })
  assert.equal(calls.prompt.length, 1)
  const [{ request, signal }] = calls.prompt

  assert.deepEqual(request, {
    requestId: 'req-fixed',
    sessionId: 'session-1',
    mode: 'queue',
    content: [{ type: 'text', text: 'please continue' }],
  })
  assert.deepEqual(Object.keys(request).sort(), ['content', 'mode', 'requestId', 'sessionId'])
  assert.ok(signal instanceof AbortSignal, 'prompt must receive an AbortSignal')
  assert.equal(signal.aborted, false, 'the signal must not be aborted before the host answers')
})

test('promptSession keeps the request id stable only through the injected generator', async () => {
  const { ports, calls } = fakePorts()

  const injected = new SessionSlice(ports, { requestId: () => 'req-fixed' })
  await injected.promptSession('s', 'one')
  await injected.promptSession('s', 'two')
  assert.deepEqual(calls.prompt.map((entry) => entry.request.requestId), ['req-fixed', 'req-fixed'])

  const generated = new SessionSlice(ports)
  const first = await generated.promptSession('s', 'one')
  const second = await generated.promptSession('s', 'two')
  assert.match(first.requestId, UUID)
  assert.match(second.requestId, UUID)
  assert.notEqual(first.requestId, second.requestId, 'uninjected calls must mint distinct ids')
})

test('promptSession bounds the prompt with promptTimeoutMs', async () => {
  const { ports, calls } = fakePorts()
  const slice = new SessionSlice(ports, { promptTimeoutMs: 5 })

  await slice.promptSession('session-1', 'text')
  const { signal } = calls.prompt[0]
  assert.ok(signal instanceof AbortSignal)

  // Await the real abort event rather than sleeping: the only deterministic
  // proof that the timeout is wired through is that the signal aborts.
  await new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error('prompt signal did not abort')), 2_000)
    signal.addEventListener('abort', () => {
      clearTimeout(guard)
      resolve()
    })
  })
  assert.equal(signal.aborted, true)
})

test('promptSession returns accepted:false without throwing', async () => {
  const { ports } = fakePorts({ promptResult: { accepted: false } })
  const slice = new SessionSlice(ports)

  const result = await slice.promptSession('session-1', 'text')
  assert.equal(result.accepted, false)
  assert.match(result.requestId, UUID)
})

test('ensureSession reports true only when the list contains the session', async () => {
  const present = fakePorts({
    listResult: { items: [{ sessionId: 'session-1', running: false }, { sessionId: 'session-2', running: true }] },
  })
  const slice = new SessionSlice(present.ports)
  assert.equal(await slice.ensureSession('session-1'), true)
  assert.deepEqual(present.calls.list, [{ request: {}, signal: undefined }])

  const absent = fakePorts({ listResult: { items: [{ sessionId: 'session-2', running: true }] } })
  const slice2 = new SessionSlice(absent.ports)
  assert.equal(await slice2.ensureSession('session-1'), false)
  assert.equal(absent.calls.createSession.length, 0, 'ensureSession must never recreate a missing session')
  assert.equal(absent.calls.inspect.length, 0, 'ensureSession must not fall back to inspect')
})

test('ensureSession does not consult inspect when list is empty', async () => {
  const { ports, calls } = fakePorts({
    listResult: { items: [] },
    inspectResult: { meta: { id: 'session-1' } },
  })
  const slice = new SessionSlice(ports)

  assert.equal(await slice.ensureSession('session-1'), false)
  assert.equal(calls.inspect.length, 0)
})

test('renameSession awaits the rename and propagates failures', async () => {
  const { ports, calls } = fakePorts()
  const slice = new SessionSlice(ports)

  await slice.renameSession('session-1', 'cowork: renamed')
  assert.deepEqual(calls.rename, [{ sessionId: 'session-1', title: 'cowork: renamed' }])

  const failure = new Error('rename failed: session not found')
  const failing = fakePorts()
  failing.ports.sessions.rename = async (request) => {
    failing.calls.rename.push(request)
    throw failure
  }
  await assert.rejects(new SessionSlice(failing.ports).renameSession('session-1', 'x'), failure)
  assert.deepEqual(failing.calls.rename, [{ sessionId: 'session-1', title: 'x' }])
})

// ---------------------------------------------------------------------------
// M3 reviewer session
// ---------------------------------------------------------------------------

test('createReviewSession uses the project workspace, the reviewer preset, and a review title', async () => {
  const { ports, calls } = fakePorts({
    resolvedWorkspace: { id: 'workspace-existing', path: '/repo' },
    createResult: { sessionId: 'session-reviewer', agentPreset: 'cowork-reviewer' },
  })
  const slice = new SessionSlice(ports)

  const result = await slice.createReviewSession({
    repoPath: '/repo',
    subject: 'wire the review gate',
    presetId: 'cowork-reviewer',
  })

  assert.deepEqual(result, {
    sessionId: 'session-reviewer',
    workspaceId: 'workspace-existing',
    title: 'cowork review: wire the review gate',
  })
  assert.deepEqual(calls.createSession, [
    { workspaceId: 'workspace-existing', agentPreset: 'cowork-reviewer' },
  ])
  assert.deepEqual(calls.rename, [
    { sessionId: 'session-reviewer', title: 'cowork review: wire the review gate' },
  ])
  assert.equal(REVIEW_TITLE_PREFIX, 'cowork review: ')
  assert.equal(calls.list.length, 0, 'createReviewSession writes no index and lists no sessions')
})

test('createReviewSession creates the project workspace when the registry has none', async () => {
  const { ports, calls } = fakePorts({
    resolvedWorkspace: undefined,
    createdWorkspace: { id: 'workspace-new', path: '/repo' },
    createResult: { sessionId: 'session-reviewer', agentPreset: 'cowork-reviewer' },
  })

  const result = await new SessionSlice(ports).createReviewSession({
    repoPath: '/repo',
    subject: 'review',
    presetId: 'cowork-reviewer',
  })

  assert.equal(result.workspaceId, 'workspace-new')
  assert.deepEqual(calls.createWorkspace, [['/repo']])
})

test('createReviewSession fails closed on a preset mismatch before any rename', async () => {
  const { ports, calls } = fakePorts({
    resolvedWorkspace: { id: 'workspace-existing', path: '/repo' },
    createResult: { sessionId: 'session-reviewer', agentPreset: 'cowork-topic' },
  })

  await assert.rejects(
    new SessionSlice(ports).createReviewSession({
      repoPath: '/repo',
      subject: 'review',
      presetId: 'cowork-reviewer',
    }),
    /session\/create-preset-mismatch:.*cowork-reviewer.*cowork-topic/,
  )
  assert.deepEqual(calls.rename, [], 'a session without the reviewer preset must not be renamed')
})

test('createReviewSession propagates a failed create without renaming', async () => {
  const { ports, calls } = fakePorts({ resolvedWorkspace: { id: 'workspace-existing', path: '/repo' } })
  ports.sessions.create = async (request) => {
    calls.createSession.push(request)
    throw new Error('the host refused the session')
  }

  await assert.rejects(
    new SessionSlice(ports).createReviewSession({
      repoPath: '/repo',
      subject: 'review',
      presetId: 'cowork-reviewer',
    }),
    /the host refused the session/,
  )
  assert.deepEqual(calls.rename, [])
})
