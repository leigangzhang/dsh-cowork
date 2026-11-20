import test from 'node:test'
import assert from 'node:assert/strict'
import '../support/ts-hook.mjs'
import {
  artifactRuntime,
  fakeHostFs,
  makeComment,
  makeRecord,
  makeRepo,
  sha256,
} from '../support/artifact-fixtures.mjs'

/**
 * The dispatcher owns batching, the state machine, retries, and restart
 * recovery. Prompts and timers are injected, so a test drives every transition
 * without a model or a real clock.
 */
const { ArtifactDispatcher, buildDispatchPrompt } = await import('../../src/platform/artifact-dispatch.ts')
const ARTIFACT = 'artifact-11111111-1111-4111-8111-111111111111'

/** Poll until `predicate` holds or the deadline passes. */
async function waitUntil(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out: ${label}`)
}

/** A runtime over a temporary repo with a seeded work item. */
async function withRuntime(operation, options = {}) {
  const repo = await makeRepo({ 'docs/spec.md': '# Spec\n\nbody\n' })
  const calls = []
  const prompt = {
    async prompt(request) {
      calls.push(request)
      if (options.rejectAlways === true) throw new Error('session busy')
      if (options.rejectTimes !== undefined && calls.length <= options.rejectTimes) throw new Error('session busy')
      return { accepted: true }
    },
  }
  const manager = new artifactRuntime.ArtifactRuntimeManager({
    hostFs: fakeHostFs(),
    prompt,
    dispatch: { windowMs: 5, retryDelaysMs: [5, 10], timeoutMs: 10_000, concurrency: 2, recoverOnCreate: false, ...options.dispatch },
  })
  const runtime = manager.runtimeFor(repo.repoPath)
  const record = makeRecord({
    files: [{
      path: 'docs/spec.md', mediaType: 'text/markdown', editable: true, size: 13, sha256: sha256('# Spec\n\nbody\n'),
      revision: 1, fsVersion: sha256('# Spec\n\nbody\n'), missing: false,
    }],
  })
  await runtime.store.createRecord(record)
  try {
    return await operation({ runtime, record, calls, repo, manager, prompt })
  } finally {
    manager.dispose()
    await new Promise((resolve) => setTimeout(resolve, 30))
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await repo.remove()
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
    }
  }
}

/** One queued comment event for a thread. */
function comment(index = 1) {
  return makeComment({
    eventId: `comment-event-${index}`,
    commentId: `comment-${index}`,
    threadId: `comment-${index}`,
    body: `please fix ${index}`,
  })
}

test('a queued batch becomes sent, then follows turn and tool events', async () => {
  await withRuntime(async ({ runtime, record, calls }) => {
    const dispatcher = runtime.dispatch
    assert.ok(dispatcher)
    const dispatch = await dispatcher.enqueue({ record, commentIds: ['comment-1'], comments: [comment(1)] })
    assert.equal(dispatch.state, 'queued')
    await waitUntil(() => calls.length === 1, 'prompt called')
    await waitUntil(async () => (await runtime.store.readLatestDispatch(ARTIFACT))?.state === 'sent', 'sent')
    await dispatcher.onTurnStart('session-1')
    assert.equal((await runtime.store.readLatestDispatch(ARTIFACT)).state, 'thinking')
    await dispatcher.onToolCall('session-1')
    assert.equal((await runtime.store.readLatestDispatch(ARTIFACT)).state, 'working')
    assert.equal(await dispatcher.markReplied(dispatch.dispatchId), true)
    assert.equal((await runtime.store.readLatestDispatch(ARTIFACT)).state, 'replied')
    const stored = await runtime.store.readRecord(ARTIFACT)
    assert.equal(stored.activeDispatch.state, 'replied')
    const events = await runtime.store.readEvents()
    assert.ok(events.filter((event) => event.type === 'dispatch.updated').length >= 4)
    assert.equal(await dispatcher.markReplied(dispatch.dispatchId), false)
    assert.equal(dispatcher.inFlightFor(ARTIFACT), null)
    // The prompt carried the annotation as data and the reply instruction.
    assert.match(calls[0].content[0].text, /annotation comment-1/)
    assert.match(calls[0].content[0].text, /cowork_artifact_reply/)
    assert.equal(calls[0].requestId, dispatch.promptRequestId)
  })
})

test('two batches inside the merge window become one prompt', async () => {
  await withRuntime(async ({ runtime, record, calls }) => {
    const dispatcher = runtime.dispatch
    const window = { windowMs: 200 }
    // The shared manager options already used 5 ms; create a dedicated
    // dispatcher with a long window so both enqueues land before the flush.
    const slow = new ArtifactDispatcher({
      runtime,
      prompt: { async prompt(request) { calls.push(request); return { accepted: true } } },
      windowMs: window.windowMs,
      retryDelaysMs: [],
      recoverOnCreate: false,
    })
    const first = await slow.enqueue({ record, commentIds: ['comment-1'], comments: [comment(1)] })
    const second = await slow.enqueue({ record, commentIds: ['comment-2'], comments: [comment(2)] })
    assert.equal(second.dispatchId, first.dispatchId)
    assert.deepEqual(second.commentIds, ['comment-1', 'comment-2'])
    await waitUntil(() => calls.length === 1, 'one merged prompt')
    assert.match(calls[0].content[0].text, /annotation comment-1/)
    assert.match(calls[0].content[0].text, /annotation comment-2/)
    await waitUntil(async () => (await runtime.store.readLatestDispatch(ARTIFACT))?.state === 'sent', 'merged batch sent')
    slow.dispose()
  })
})

test('a rejected prompt retries with backoff and then succeeds', async () => {
  await withRuntime(async ({ runtime, record, calls }) => {
    const dispatch = await runtime.dispatch.enqueue({ record, commentIds: ['comment-1'], comments: [comment(1)] })
    await waitUntil(() => calls.length === 1, 'first attempt')
    await waitUntil(async () => (await runtime.store.readLatestDispatch(ARTIFACT))?.attempts >= 1, 'attempt recorded')
    await waitUntil(async () => (await runtime.store.readLatestDispatch(ARTIFACT))?.state === 'sent', 'eventually sent', 3_000)
    assert.ok(calls.length >= 2)
    assert.equal(dispatch.dispatchId, (await runtime.store.readLatestDispatch(ARTIFACT)).dispatchId)
  }, { rejectTimes: 1 })
})

test('an always-rejected prompt fails with artifact/dispatch-failed', async () => {
  await withRuntime(async ({ runtime, record }) => {
    await runtime.dispatch.enqueue({ record, commentIds: ['comment-1'], comments: [comment(1)] })
    await waitUntil(async () => (await runtime.store.readLatestDispatch(ARTIFACT))?.state === 'failed', 'failed')
    assert.equal((await runtime.store.readLatestDispatch(ARTIFACT)).errorCode, 'artifact/dispatch-failed')
  }, { rejectAlways: true, dispatch: { retryDelaysMs: [1] } })
})

test('a turn that ends without a reply fails the batch', async () => {
  await withRuntime(async ({ runtime, record, calls }) => {
    await runtime.dispatch.enqueue({ record, commentIds: ['comment-1'], comments: [comment(1)] })
    await waitUntil(() => calls.length === 1, 'prompt')
    await waitUntil(async () => (await runtime.store.readLatestDispatch(ARTIFACT))?.state === 'sent', 'sent')
    await runtime.dispatch.onTurnEnd('session-1')
    const latest = await runtime.store.readLatestDispatch(ARTIFACT)
    assert.equal(latest.state, 'failed')
    assert.equal(latest.errorCode, 'artifact/reply-missing')
  })
})

test('a blocked session marks the in-flight batch blocked', async () => {
  await withRuntime(async ({ runtime, record, calls }) => {
    await runtime.dispatch.enqueue({ record, commentIds: ['comment-1'], comments: [comment(1)] })
    await waitUntil(() => calls.length === 1, 'prompt')
    await waitUntil(async () => (await runtime.store.readLatestDispatch(ARTIFACT))?.state === 'sent', 'sent')
    await runtime.dispatch.onSessionBlocked('session-1', 'artifact/session-gone')
    const latest = await runtime.store.readLatestDispatch(ARTIFACT)
    assert.equal(latest.state, 'blocked')
    assert.equal(latest.errorCode, 'artifact/session-gone')
  })
})

test('the per-session queue cap is enforced', async () => {
  await withRuntime(async ({ runtime, record }) => {
    const dispatcher = new ArtifactDispatcher({
      runtime,
      prompt: { async prompt() { return { accepted: true } } },
      windowMs: 60_000,
      maxComments: 1,
      retryDelaysMs: [],
    })
    for (let index = 0; index < 50; index += 1) {
      await dispatcher.enqueue({ record, commentIds: [`comment-${index}`], comments: [comment(index)] })
    }
    await assert.rejects(
      dispatcher.enqueue({ record, commentIds: ['comment-50'], comments: [comment(50)] }),
      (error) => {
        assert.equal(error.code, 'artifact/dispatch-queue-full')
        return true
      },
    )
    dispatcher.dispose()
  })
})

test('recovery turns an in-flight batch stale and reschedules a queued one', async () => {
  await withRuntime(async ({ runtime, record, calls }) => {
    const base = {
      version: 1,
      dispatchId: 'dispatch-old',
      artifactId: ARTIFACT,
      sessionId: 'session-1',
      commentIds: ['comment-1'],
      state: 'sent',
      attempts: 0,
      promptRequestId: 'dispatch-old',
      errorCode: null,
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    }
    await runtime.store.appendDispatch(base)
    const recovered = new ArtifactDispatcher({
      runtime,
      prompt: { async prompt(request) { calls.push(request); return { accepted: true } } },
      windowMs: 5,
      retryDelaysMs: [],
    })
    assert.equal(await recovered.recover(), 1)
    assert.equal((await runtime.store.readLatestDispatch(ARTIFACT)).state, 'stale')

    await runtime.store.appendComment(comment(2))
    await runtime.store.appendDispatch({ ...base, dispatchId: 'dispatch-queued', state: 'queued', commentIds: ['comment-2'] })
    const second = new ArtifactDispatcher({
      runtime,
      prompt: { async prompt(request) { calls.push(request); return { accepted: true } } },
      windowMs: 5,
      retryDelaysMs: [],
    })
    assert.equal(await second.recover(), 1)
    await waitUntil(() => calls.length === 1, 'queued batch rescheduled', 2_000)
    await waitUntil(async () => (await runtime.store.readLatestDispatch(ARTIFACT))?.state === 'sent', 'rescheduled batch sent', 2_000)
    recovered.dispose()
    second.dispose()
  })
})

test('attachment images ride the prompt as image parts', async () => {
  await withRuntime(async ({ runtime, record, calls }) => {
    await runtime.store.saveUpload(ARTIFACT, 'attachment-1111', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))
    const withImage = makeComment({
      eventId: 'comment-event-image',
      commentId: 'comment-image',
      threadId: 'comment-image',
      body: 'look at this',
      attachments: [{ attachmentId: 'attachment-1111', name: 'shot.png', mediaType: 'image/png', size: 8, sha256: 'x' }],
    })
    await runtime.dispatch.enqueue({ record, commentIds: ['comment-image'], comments: [withImage] })
    await waitUntil(() => calls.length === 1, 'prompt')
    const parts = calls[0].content
    assert.equal(parts.length, 2)
    assert.equal(parts[1].type, 'image')
    assert.equal(parts[1].mediaType, 'image/png')
    assert.equal(typeof parts[1].data, 'string')
  })
})

test('dispose cancels the pending flush', async () => {
  await withRuntime(async ({ runtime, record, calls }) => {
    const dispatcher = new ArtifactDispatcher({
      runtime,
      prompt: { async prompt(request) { calls.push(request); return { accepted: true } } },
      windowMs: 5,
      retryDelaysMs: [],
    })
    await dispatcher.enqueue({ record, commentIds: ['comment-1'], comments: [comment(1)] })
    dispatcher.dispose()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(calls.length, 0)
  })
})

test('the prompt text is bounded and names the registered file', async () => {
  const text = buildDispatchPrompt({
    record: makeRecord(),
    comments: [comment(1)],
    repoPath: '/repo',
  })
  assert.match(text, /artifact-11111111/)
  assert.match(text, /docs\/spec\.md/)
  assert.match(text, /cowork_artifact_reply/)
  assert.ok(text.length <= 20_000)
})

test('non-line anchors and the prompt data split are summarized', async () => {
  await withRuntime(async ({ runtime, record, calls }) => {
    const paged = makeComment({
      eventId: 'comment-event-page', commentId: 'comment-page', threadId: 'comment-page',
      body: 'page two', anchor: { kind: 'page', path: 'docs/spec.md', page: 2 },
    })
    await runtime.dispatch.enqueue({ record, commentIds: ['comment-page'], comments: [paged] })
    await waitUntil(() => calls.length === 1, 'prompt')
    assert.match(calls[0].content[0].text, /\(page\)/)
  })
})

test('the project queue cap is enforced across sessions', async () => {
  await withRuntime(async ({ runtime, record }) => {
    const dispatcher = new ArtifactDispatcher({
      runtime,
      prompt: { async prompt() { return { accepted: true } } },
      windowMs: 60_000,
      maxComments: 1,
      maxQueuePerSession: 10,
      maxQueuePerProject: 2,
      retryDelaysMs: [],
    })
    await dispatcher.enqueue({ record, commentIds: ['c1'], comments: [comment(1)] })
    const secondRecord = { ...record, artifactId: 'artifact-22222222-2222-4222-8222-222222222222', ownerSessionId: 'session-2' }
    await runtime.store.createRecord(secondRecord)
    await dispatcher.enqueue({ record: secondRecord, commentIds: ['c2'], comments: [comment(2)] })
    await assert.rejects(
      dispatcher.enqueue({ record: { ...record, ownerSessionId: 'session-3' }, commentIds: ['c3'], comments: [comment(3)] }),
      (error) => {
        assert.equal(error.code, 'artifact/dispatch-queue-full')
        return true
      },
    )
    dispatcher.dispose()
  })
})

test('inFlightFor skips terminal batches and picks the newest live one', async () => {
  await withRuntime(async ({ runtime, record }) => {
    const dispatcher = new ArtifactDispatcher({
      runtime,
      prompt: { async prompt() { return { accepted: true } } },
      windowMs: 60_000,
      maxComments: 1,
      retryDelaysMs: [],
    })
    const first = await dispatcher.enqueue({ record, commentIds: ['c1'], comments: [comment(1)] })
    const second = await dispatcher.enqueue({ record, commentIds: ['c2'], comments: [comment(2)] })
    assert.equal(dispatcher.inFlightFor(ARTIFACT).dispatchId, second.dispatchId)
    await dispatcher.markReplied(second.dispatchId)
    assert.equal(dispatcher.inFlightFor(ARTIFACT).dispatchId, first.dispatchId)
    await dispatcher.markReplied(first.dispatchId)
    assert.equal(dispatcher.inFlightFor(ARTIFACT), null)
    dispatcher.dispose()
  })
})

test('an unanswered accepted prompt times out to failed', async () => {
  await withRuntime(async ({ runtime, record, calls }) => {
    const dispatcher = new ArtifactDispatcher({
      runtime,
      prompt: { async prompt(request) { calls.push(request); return { accepted: true } } },
      windowMs: 1,
      timeoutMs: 10,
      retryDelaysMs: [],
    })
    await dispatcher.enqueue({ record, commentIds: ['c1'], comments: [comment(1)] })
    await waitUntil(async () => (await runtime.store.readLatestDispatch(ARTIFACT))?.state === 'failed', 'timed out')
    assert.equal((await runtime.store.readLatestDispatch(ARTIFACT)).errorCode, 'artifact/dispatch-timeout')
    dispatcher.dispose()
  })
})

test('the host prompt port forwards the queue request under a timeout signal', async () => {
  const { createDispatchPromptPort } = await import('../../src/platform/artifact-dispatch.ts')
  const calls = []
  const port = createDispatchPromptPort({
    async prompt(request, signal) {
      calls.push({ request, signal })
      return { accepted: true }
    },
  }, 50)
  const result = await port.prompt({
    requestId: 'dispatch-1',
    sessionId: 'session-1',
    mode: 'queue',
    content: [{ type: 'text', text: 'hello' }],
  })
  assert.equal(result.accepted, true)
  assert.equal(calls[0].request.requestId, 'dispatch-1')
  assert.equal(calls[0].request.mode, 'queue')
  assert.ok(calls[0].signal instanceof AbortSignal)

  const refusing = createDispatchPromptPort({ async prompt() { return { accepted: false } } }, 50)
  assert.equal((await refusing.prompt({ requestId: 'r', sessionId: 's', mode: 'queue', content: [] })).accepted, false)

  const throwing = createDispatchPromptPort({
    async prompt() { throw new Error('session busy') },
  }, 50)
  await assert.rejects(throwing.prompt({ requestId: 'r', sessionId: 's', mode: 'queue', content: [] }), /session busy/)
})

test('the session listener advances only turn events for a resolvable project', async () => {
  const { createDispatchSessionListener } = await import('../../src/platform/artifact-dispatch.ts')
  const calls = []
  const dispatcher = {
    async onTurnStart(id) { calls.push(['turn/start', id]) },
    async onToolCall(id) { calls.push(['tool/call', id]) },
    async onTurnEnd(id) { calls.push(['turn/end', id]) },
  }
  const logs = []
  const listener = createDispatchSessionListener({
    async resolveRepoPath(cwd) { return cwd === '/none' ? null : '/repo' },
    runtimeFor() { return { dispatch: dispatcher } },
    log: (message) => logs.push(message),
  })
  // Missing id/cwd, unknown event types, and a non-project cwd are ignored.
  listener({}, { type: 'turn/start' })
  listener({ header: { id: '', cwd: '/repo' } }, { type: 'turn/start' })
  listener({ header: { id: 'session-1', cwd: '' } }, { type: 'turn/start' })
  listener({ header: { id: 'session-1', cwd: '/repo' } }, { type: 'assistant/message' })
  listener({ header: { id: 'session-1', cwd: '/none' } }, { type: 'turn/end' })
  listener({ header: { id: 'session-1', cwd: '/repo' } }, { type: 'turn/start' })
  listener({ header: { id: 'session-1', cwd: '/repo' } }, { type: 'tool/call' })
  listener({ header: { id: 'session-1', cwd: '/repo' } }, { type: 'turn/end' })
  await waitUntil(() => calls.length === 3, 'three dispatch events')
  assert.deepEqual(calls, [['turn/start', 'session-1'], ['tool/call', 'session-1'], ['turn/end', 'session-1']])

  // A host without a dispatcher is a no-op.
  const noDispatcher = createDispatchSessionListener({
    async resolveRepoPath() { return '/repo' },
    runtimeFor() { return { dispatch: null } },
  })
  noDispatcher({ header: { id: 'session-1', cwd: '/repo' } }, { type: 'turn/end' })

  // A failing repository lookup is logged, never thrown.
  const failing = createDispatchSessionListener({
    async resolveRepoPath() { throw new Error('lookup exploded') },
    runtimeFor() { throw new Error('must not run') },
    log: (message) => logs.push(message),
  })
  failing({ header: { id: 'session-1', cwd: '/repo' } }, { type: 'turn/end' })
  await waitUntil(() => logs.some((message) => message.includes('lookup exploded')), 'logged failure')
})

test('a settled batch ignores a late late-thinking transition', async () => {
  await withRuntime(async ({ runtime, record }) => {
    const dispatcher = new ArtifactDispatcher({
      runtime,
      prompt: { async prompt() { return { accepted: true } } },
      windowMs: 60_000,
      retryDelaysMs: [],
    })
    const dispatch = await dispatcher.enqueue({ record, commentIds: ['c1'], comments: [comment(1)] })
    // Runtime-private seam: the guard exists only to stop a race that is hard
    // to schedule deterministically from the public surface.
    const apply = dispatcher['applyTransition'].bind(dispatcher)
    const replied = await apply(dispatch, 'replied', null)
    assert.equal(replied.state, 'replied')
    const late = await apply(dispatch, 'thinking', null)
    assert.equal(late.state, 'replied')
    assert.equal((await runtime.store.readLatestDispatch(ARTIFACT)).state, 'replied')
    dispatcher.dispose()
  })
})

test('the retained terminal records are bounded', async () => {
  await withRuntime(async ({ runtime, record }) => {
    const dispatcher = new ArtifactDispatcher({
      runtime,
      prompt: { async prompt() { return { accepted: true } } },
      windowMs: 60_000,
      retryDelaysMs: [],
      maxSettled: 1,
    })
    const apply = dispatcher['applyTransition'].bind(dispatcher)
    const first = await dispatcher.enqueue({ record, commentIds: ['c1'], comments: [comment(1)] })
    const secondRecord = { ...record, artifactId: 'artifact-22222222-2222-4222-8222-222222222222' }
    await runtime.store.createRecord(secondRecord)
    const second = await dispatcher.enqueue({ record: secondRecord, commentIds: ['c2'], comments: [comment(2)] })
    await apply(first, 'replied', null)
    await apply(second, 'replied', null)
    // The oldest terminal record was pruned; a late event for it cannot be
    // suppressed, but a new transition works from its own record.
    const late = await apply(first, 'thinking', null)
    assert.equal(late.state, 'thinking')
    dispatcher.dispose()
  })
})

test('the dispose listener blocks in-flight batches and logs lookup failures', async () => {
  const { createDispatchDisposedListener } = await import('../../src/platform/artifact-dispatch.ts')
  const blocked = []
  const logs = []
  const listener = createDispatchDisposedListener({
    async resolveRepoPath(cwd) { return cwd === '/none' ? null : '/repo' },
    runtimeFor() {
      return {
        dispatch: {
          async onSessionBlocked(sessionId) { blocked.push(sessionId) },
        },
      }
    },
    log: (message) => logs.push(message),
  })
  // Missing id/cwd and a cwd outside a project are ignored.
  listener({})
  listener({ id: '', header: { cwd: '/repo' } })
  listener({ id: 'session-1', header: { cwd: '' } })
  listener({ id: 'session-1', header: { cwd: '/none' } })
  listener({ header: { id: 'session-1', cwd: '/repo' } })
  listener({ id: 'session-2', header: { cwd: '/repo' } })
  await waitUntil(() => blocked.length === 2, 'two blocked sessions')
  assert.deepEqual(blocked, ['session-1', 'session-2'])

  // A host without a dispatcher is a no-op; a failing lookup is logged.
  const noDispatcher = createDispatchDisposedListener({
    async resolveRepoPath() { return '/repo' },
    runtimeFor() { return { dispatch: null } },
  })
  noDispatcher({ id: 'session-3', header: { cwd: '/repo' } })
  const failing = createDispatchDisposedListener({
    async resolveRepoPath() { throw new Error('dispose lookup exploded') },
    runtimeFor() { throw new Error('must not run') },
    log: (message) => logs.push(message),
  })
  failing({ id: 'session-4', header: { cwd: '/repo' } })
  await waitUntil(() => logs.some((message) => message.includes('dispose lookup exploded')), 'logged dispose failure')
})
