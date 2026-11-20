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
async function waitUntil(predicate, label, timeoutMs = 10_000) {
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
    assert.equal((await runtime.store.readRecord(ARTIFACT)).status, 'in-progress')
    await dispatcher.onToolCall('session-1')
    assert.equal((await runtime.store.readLatestDispatch(ARTIFACT)).state, 'working')
    assert.equal(await dispatcher.markReplied(dispatch.dispatchId), true)
    assert.equal((await runtime.store.readLatestDispatch(ARTIFACT)).state, 'replied')
    const stored = await runtime.store.readRecord(ARTIFACT)
    assert.equal(stored.status, 'needs-feedback')
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

test('the prompt carries the anchor quote and its surrounding lines', () => {
  const text = buildDispatchPrompt({
    record: makeRecord(),
    comments: [makeComment({
      eventId: 'comment-event-anchor', commentId: 'comment-anchor', threadId: 'comment-anchor',
      body: 'please fix',
      anchor: {
        kind: 'line-range', path: 'docs/spec.md', startLine: 2, endLine: 2,
        quote: 'body', contextBefore: '# Spec', contextAfter: '',
      },
    })],
    repoPath: '/repo',
  })
  assert.match(text, /Quote: body/)
  assert.match(text, /Before: # Spec/)
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

test('inFlightFor reports only an accepted, non-terminal batch', async () => {
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
    // Queued batches are not in flight; only the accepted batch is.
    assert.equal(dispatcher.inFlightFor(ARTIFACT), null)
    dispatcher.dispose()
    void first
    void second
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
    async onTurnStart(id, turn) { calls.push(['turn/start', id, turn]) },
    async onToolCall(id, turn) { calls.push(['tool/call', id, turn]) },
    async onTurnEnd(id, turn) { calls.push(['turn/end', id, turn]) },
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
  listener({ header: { id: 'session-1', cwd: '/repo' } }, { type: 'turn/start', data: { turn: 7 } })
  listener({ header: { id: 'session-1', cwd: '/repo' } }, { type: 'tool/call', data: { turn: 7 } })
  listener({ header: { id: 'session-1', cwd: '/repo' } }, { type: 'turn/end', data: { turn: 'seven' } })
  listener({ header: { id: 'session-1', cwd: '/repo' } }, { type: 'turn/end', data: null })
  await waitUntil(() => calls.length === 4, 'four dispatch events')
  assert.deepEqual(calls, [
    ['turn/start', 'session-1', 7],
    ['tool/call', 'session-1', 7],
    ['turn/end', 'session-1', undefined],
    ['turn/end', 'session-1', undefined],
  ])

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

test('a session keeps one in-flight batch and a re-entrant flush never duplicates a prompt', async () => {
  await withRuntime(async ({ runtime, record, calls }) => {
    const dispatcher = runtime.dispatch
    const first = await dispatcher.enqueue({ record, commentIds: ['c1'], comments: [comment(1)] })
    await waitUntil(() => calls.length === 1, 'first prompt')
    await waitUntil(async () => (await runtime.store.readLatestDispatch(ARTIFACT))?.state === 'sent', 'first sent')
    // A comment arriving while the first batch is in flight must wait.
    const second = await dispatcher.enqueue({ record, commentIds: ['c2'], comments: [comment(2)] })
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(calls.length, 1, 'the second batch must not be sent while the first is in flight')
    assert.equal(dispatcher.inFlightFor(ARTIFACT)?.state, 'sent')
    assert.equal(dispatcher.inFlightFor(ARTIFACT)?.dispatchId, first.dispatchId)

    await dispatcher.markReplied(first.dispatchId)
    await waitUntil(() => calls.length === 2, 'second prompt after reply')
    await waitUntil(async () => (await runtime.store.readLatestDispatch(ARTIFACT))?.state === 'sent', 'second sent')
    await dispatcher.markReplied(second.dispatchId)
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(calls.length, 2, 'no duplicate prompt')
    assert.equal((await runtime.store.readRecord(ARTIFACT)).activeDispatch?.state, 'replied')
  })
})

test('turn events only affect the batch of that turn', async () => {
  await withRuntime(async ({ runtime, record, calls }) => {
    const dispatcher = runtime.dispatch
    const dispatch = await dispatcher.enqueue({ record, commentIds: ['c1'], comments: [comment(1)] })
    await waitUntil(() => calls.length === 1, 'prompt')
    await waitUntil(async () => (await runtime.store.readLatestDispatch(ARTIFACT))?.state === 'sent', 'sent')
    // A user turn ending before the batch's turn starts must not fail it.
    await dispatcher.onTurnEnd('session-1', 4)
    assert.equal((await runtime.store.readLatestDispatch(ARTIFACT)).state, 'sent')
    await dispatcher.onTurnStart('session-1', 7)
    assert.equal((await runtime.store.readLatestDispatch(ARTIFACT)).state, 'thinking')
    await dispatcher.onTurnEnd('session-1', 4)
    assert.equal((await runtime.store.readLatestDispatch(ARTIFACT)).state, 'thinking')
    await dispatcher.onToolCall('session-1', 4)
    assert.equal((await runtime.store.readLatestDispatch(ARTIFACT)).state, 'thinking')
    await dispatcher.onToolCall('session-1', 7)
    assert.equal((await runtime.store.readLatestDispatch(ARTIFACT)).state, 'working')
    await dispatcher.markReplied(dispatch.dispatchId)
    await dispatcher.onTurnEnd('session-1', 7)
    assert.equal((await runtime.store.readLatestDispatch(ARTIFACT)).state, 'replied')
  })
})

test('a bound turn that ends without a reply fails only that batch', async () => {
  await withRuntime(async ({ runtime, record, calls }) => {
    const dispatcher = runtime.dispatch
    await dispatcher.enqueue({ record, commentIds: ['c1'], comments: [comment(1)] })
    await waitUntil(() => calls.length === 1, 'prompt')
    await waitUntil(async () => (await runtime.store.readLatestDispatch(ARTIFACT))?.state === 'sent', 'sent')
    await dispatcher.onTurnStart('session-1', 9)
    await dispatcher.onTurnEnd('session-1', 9)
    const latest = await runtime.store.readLatestDispatch(ARTIFACT)
    assert.equal(latest.state, 'failed')
    assert.equal(latest.errorCode, 'artifact/reply-missing')
  })
})

test('a flush without a queue is a no-op, and a comment during a flush only marks it pending', async () => {
  await withRuntime(async ({ runtime, record }) => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    let prompts = 0
    const dispatcher = new ArtifactDispatcher({
      runtime,
      prompt: {
        async prompt() {
          prompts += 1
          await gate
          return { accepted: true }
        },
      },
      windowMs: 1,
      retryDelaysMs: [],
    })
    // Private seam: a timer can fire after the queue was drained.
    await dispatcher['flush']('session-without-queue')
    const first = await dispatcher.enqueue({ record, commentIds: ['c1'], comments: [comment(1)] })
    await waitUntil(() => prompts === 1, 'first prompt in flight')
    // The flush is awaiting the prompt; this enqueue must only mark it pending.
    await dispatcher.enqueue({ record, commentIds: ['c2'], comments: [comment(2)] })
    release()
    await waitUntil(async () => (await runtime.store.readRecord(ARTIFACT)).activeDispatch?.state === 'sent', 'first sent')
    assert.equal(prompts, 1, 'one in-flight prompt')
    await dispatcher.markReplied(first.dispatchId)
    await waitUntil(() => prompts === 2, 'second prompt after reply')
    dispatcher.dispose()
  })
})

test('turn numbers are per session: ending one session turn keeps another binding', async () => {
  await withRuntime(async ({ runtime, record, calls }) => {
    const dispatcher = runtime.dispatch
    const otherArtifact = 'artifact-22222222-2222-4222-8222-222222222222'
    const secondRecord = { ...record, artifactId: otherArtifact, ownerSessionId: 'session-2' }
    await runtime.store.createRecord(secondRecord)
    await dispatcher.enqueue({ record, commentIds: ['c1'], comments: [comment(1)] })
    await dispatcher.enqueue({ record: secondRecord, commentIds: ['c2'], comments: [comment(2)] })
    await waitUntil(() => calls.length === 2, 'both prompts')
    await waitUntil(async () => (await runtime.store.readLatestDispatch(ARTIFACT))?.state === 'sent', 'first sent')
    await waitUntil(async () => (await runtime.store.readLatestDispatch(otherArtifact))?.state === 'sent', 'second sent')
    await dispatcher.onTurnStart('session-1', 1)
    await dispatcher.onTurnStart('session-2', 1)
    assert.equal((await runtime.store.readLatestDispatch(ARTIFACT)).state, 'thinking')
    assert.equal((await runtime.store.readLatestDispatch(otherArtifact)).state, 'thinking')

    await dispatcher.onTurnEnd('session-1', 1)
    assert.equal((await runtime.store.readLatestDispatch(ARTIFACT)).state, 'failed')
    // Session 2 also has turn 1; its binding must survive session 1's cleanup.
    assert.equal((await runtime.store.readLatestDispatch(otherArtifact)).state, 'thinking')
    await dispatcher.onTurnEnd('session-2', 1)
    assert.equal((await runtime.store.readLatestDispatch(otherArtifact)).state, 'failed')
  })
})

test('a bound turn that ends without a reply fails only that batch', async () => {
  await withRuntime(async ({ runtime, record, calls }) => {
    const dispatcher = runtime.dispatch
    await dispatcher.enqueue({ record, commentIds: ['c1'], comments: [comment(1)] })
    await waitUntil(() => calls.length === 1, 'prompt')
    await waitUntil(async () => (await runtime.store.readLatestDispatch(ARTIFACT))?.state === 'sent', 'sent')
    await dispatcher.onTurnStart('session-1', 9)
    await dispatcher.onTurnEnd('session-1', 9)
    const latest = await runtime.store.readLatestDispatch(ARTIFACT)
    assert.equal(latest.state, 'failed')
    assert.equal(latest.errorCode, 'artifact/reply-missing')
  })
})

test('recover replays every queued batch, not only the latest', async () => {
  await withRuntime(async ({ runtime, record, calls }) => {
    const dispatcher = runtime.dispatch
    await runtime.store.appendComment(comment(1))
    await runtime.store.appendComment(comment(2))
    const base = {
      version: 1, artifactId: ARTIFACT, sessionId: 'session-1', attempts: 0,
      promptRequestId: 'prompt-recovered', errorCode: null,
    }
    await runtime.store.appendDispatch({
      ...base, dispatchId: 'dispatch-1', commentIds: ['comment-1'], state: 'queued',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    })
    await runtime.store.appendDispatch({
      ...base, dispatchId: 'dispatch-2', commentIds: ['comment-2'], state: 'queued',
      createdAt: '2026-01-01T00:00:01.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
    })
    const recovering = dispatcher.recover()
    assert.equal(await dispatcher.recover(), 2)
    assert.equal(await recovering, 2)
    await waitUntil(() => calls.length === 1, 'first recovered batch')
    assert.match(calls[0].content[0].text, /please fix 1/)
    const first = dispatcher.inFlightFor(ARTIFACT)
    assert.ok(first)
    await dispatcher.markReplied(first.dispatchId)
    await waitUntil(() => calls.length === 2, 'second recovered batch')
    assert.match(calls[1].content[0].text, /please fix 2/)
    await waitUntil(async () => {
      const states = (await runtime.store.readDispatches(ARTIFACT)).map((row) => row.state)
      return states.includes('replied') && states.includes('sent')
    }, 'both batches reached a terminal or sent state')
    const states = (await runtime.store.readDispatches(ARTIFACT)).map((row) => row.state)
    assert.deepEqual(states.sort(), ['replied', 'sent'])
  })
})

test('retry re-enqueues only a failed, blocked, or stale batch', async () => {
  await withRuntime(async ({ runtime, record }) => {
    const dispatcher = runtime.dispatch
    const failed = {
      version: 1, dispatchId: 'dispatch-failed', artifactId: ARTIFACT, sessionId: 'session-1',
      commentIds: ['comment-1'], state: 'failed', attempts: 3, promptRequestId: 'request-failed',
      errorCode: 'artifact/dispatch-unavailable', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }
    await runtime.store.appendDispatch(failed)
    await runtime.store.appendComment(comment(1))
    const retried = await dispatcher.retry(record, 'dispatch-failed')
    assert.notEqual(retried.dispatchId, failed.dispatchId)
    assert.equal(retried.state, 'queued')
    assert.deepEqual(retried.commentIds, ['comment-1'])
    await assert.rejects(() => dispatcher.retry(record, 'dispatch-failed'), (error) => error.code === 'artifact/duplicate')

    const replied = { ...failed, dispatchId: 'dispatch-replied', state: 'replied', promptRequestId: 'request-replied' }
    await runtime.store.appendDispatch(replied)
    await assert.rejects(() => dispatcher.retry(record, 'dispatch-replied'), (error) => error.code === 'artifact/dispatch-not-retryable')
    await assert.rejects(() => dispatcher.retry(record, 'dispatch-missing'), (error) => error.code === 'artifact/dispatch-not-found')

    const incomplete = { ...failed, dispatchId: 'dispatch-incomplete', promptRequestId: 'request-incomplete', commentIds: ['comment-missing'] }
    await runtime.store.appendDispatch(incomplete)
    await assert.rejects(() => dispatcher.retry(record, 'dispatch-incomplete'), (error) => error.code === 'artifact/corrupt')
  }, { dispatch: { windowMs: 10_000 } })
})


test('the total image bytes of one prompt are capped', async () => {
  await withRuntime(async ({ runtime, record, calls }) => {
    const attachments = [0, 1, 2, 3].map((index) => ({
      attachmentId: `attachment-${String(index)}`, name: `${String(index)}.png`, mediaType: 'image/png', size: 5 * 1024 * 1024, sha256: 'x',
    }))
    for (const attachment of attachments) {
      await runtime.store.saveUpload(ARTIFACT, attachment.attachmentId, new Uint8Array(attachment.size))
    }
    const annotated = makeComment({
      eventId: 'comment-event-images', commentId: 'comment-images', threadId: 'comment-images',
      body: 'four images', attachments,
    })
    await runtime.dispatch.enqueue({ record, commentIds: ['comment-images'], comments: [annotated] })
    await waitUntil(() => calls.length === 1, 'prompt')
    const images = calls[0].content.filter((part) => part.type === 'image')
    assert.equal(images.length, 1)
  })
})

test('a reply-only batch carries its thread anchor context', async () => {
  const reply = makeComment({
    eventId: 'comment-event-reply', commentId: 'comment-reply', threadId: 'comment-root',
    type: 'reply', body: 'what changed?',
  })
  const text = buildDispatchPrompt({
    record: makeRecord(),
    comments: [reply],
    repoPath: '/repo',
    threadAnchors: new Map([['comment-root', {
      kind: 'line-range', path: 'docs/spec.md', startLine: 2, endLine: 2,
      quote: 'body', contextBefore: '# Spec',
    }]]),
  })
  assert.match(text, /annotation comment-reply \(lines 2-2\)/)
  assert.match(text, /Quote: body/)
})

test('enqueue proceeds when a lazy recovery already rejected', async () => {
  await withRuntime(async ({ runtime, record }) => {
    const dispatcher = runtime.dispatch
    const rejected = Promise.reject(new Error('recovery boom'))
    rejected.catch(() => {})
    dispatcher['recoverPromise'] = rejected
    const dispatch = await dispatcher.enqueue({ record, commentIds: ['comment-1'], comments: [comment(1)] })
    assert.equal(dispatch.state, 'queued')
  })
})

test('retry refuses a batch that a newer overlapping dispatch already superseded', async () => {
  await withRuntime(async ({ runtime, record }) => {
    const dispatcher = runtime.dispatch
    await runtime.store.appendComment(comment(1))
    const base = {
      version: 1, artifactId: ARTIFACT, sessionId: 'session-1', attempts: 0,
      promptRequestId: 'prompt-retry', errorCode: null, commentIds: ['comment-1'],
    }
    await runtime.store.appendDispatch({
      ...base, dispatchId: 'dispatch-old', state: 'failed',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    })
    await runtime.store.appendDispatch({
      ...base, dispatchId: 'dispatch-new', state: 'failed',
      createdAt: '2026-01-01T00:00:01.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
    })
    await assert.rejects(() => dispatcher.retry(record, 'dispatch-old'), (error) => error.code === 'artifact/duplicate')
  })
})

test('a retry whose enqueue fails releases its single-flight marker', async () => {
  await withRuntime(async ({ runtime, record }) => {
    const dispatcher = runtime.dispatch
    await runtime.store.appendComment(comment(1))
    const failed = {
      version: 1, artifactId: ARTIFACT, dispatchId: 'dispatch-disposed', sessionId: 'session-1',
      commentIds: ['comment-1'], state: 'failed', attempts: 1, promptRequestId: 'prompt-disposed',
      errorCode: 'artifact/dispatch-unavailable',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }
    await runtime.store.appendDispatch(failed)
    dispatcher.dispose()
    await assert.rejects(() => dispatcher.retry(record, 'dispatch-disposed'), (error) => error.code === 'artifact/dispatch-unavailable')
  })
})

test('ending a turn whose batch was settled prunes its stale turn binding', async () => {
  await withRuntime(async ({ runtime, record, calls }) => {
    const dispatcher = runtime.dispatch
    const dispatch = await dispatcher.enqueue({ record, commentIds: ['comment-1'], comments: [comment(1)] })
    await waitUntil(() => calls.length === 1, 'prompt')
    await waitUntil(async () => (await runtime.store.readLatestDispatch(ARTIFACT))?.state === 'sent', 'sent')
    await dispatcher.onTurnStart('session-1', 3)
    await dispatcher.markReplied(dispatch.dispatchId)
    await dispatcher.onTurnEnd('session-1', 3)
    assert.equal((await runtime.store.readLatestDispatch(ARTIFACT)).state, 'replied')
  })
})

test('ending a turn prunes a stale binding whose active batch is gone', async () => {
  await withRuntime(async ({ runtime, record, calls }) => {
    const dispatcher = runtime.dispatch
    await dispatcher.enqueue({ record, commentIds: ['comment-1'], comments: [comment(1)] })
    await waitUntil(() => calls.length === 1, 'prompt')
    await dispatcher.onTurnStart('session-1', 7)
    // Simulate a batch removed out of band; the turn-end sweep must still drop
    // its binding instead of leaking it for the rest of the session.
    dispatcher['active'].delete('nonexistent-dispatch')
    dispatcher['turnOfDispatch'].set('nonexistent-dispatch', 7)
    await dispatcher.onTurnEnd('session-1', 7)
    assert.equal(dispatcher['turnOfDispatch'].has('nonexistent-dispatch'), false)
  })
})
