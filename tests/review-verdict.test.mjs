import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Contract test for `cowork_review_verdict`'s delivery: the fix for a master
 * that ends its turn after `cowork_review_request` and otherwise never learns
 * the review finished. Every verdict must prompt the master; only
 * needs_revision/reject may also prompt the thread. A failed prompt must be
 * reported, never turn the already-persisted verdict into a failure.
 *
 * `src/review-tools.ts` value-imports its siblings as `./x.js`, so this test
 * installs the same resolve hook tests/tools-init.test.mjs uses. The tool is
 * driven through a fake host registry with a real ProjectStore in a temp repo.
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

const { registerReviewTools } = await import('../src/review-tools.ts')
const { ProjectStore } = await import('../src/store.ts')
const { failure, readCaller } = await import('../src/tool-model.ts')

const NOW = new Date('2026-11-07T10:37:08.944Z')
const CLOCK = () => NOW

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
function fakeExec(sessionId, cwd) {
  return { agent: { id: sessionId, session: { header: { cwd, agentPreset: 'cowork-reviewer' } } } }
}

/** A session slice that records prompts and can be told to fail one recipient. */
function fakeSlice(options = {}) {
  const calls = []
  return {
    calls,
    async promptSession(sessionId, text) {
      calls.push({ sessionId, text })
      if (options.throwFor === sessionId) throw new Error(`${sessionId} prompt failed`)
      const accepted = options.rejectFor === sessionId ? false : true
      return { accepted, requestId: 'request-1' }
    },
    async archiveSession() {},
  }
}

/** Register the review tools against a real store in `repoPath`. */
function setup(repoPath, slice = fakeSlice()) {
  const store = new ProjectStore({ repoPath, clock: CLOCK })
  const host = fakeHost()
  registerReviewTools(host, {
    callerOf(exec) {
      const caller = readCaller(exec)
      return caller ?? failure('exec/agent-unavailable', 'no caller identity')
    },
    async openProject() {
      return { repoPath, store, slice, index: await store.readIndex() }
    },
    mapError(error) {
      return failure('tool/internal', error instanceof Error ? error.message : String(error))
    },
    toJson(value) {
      return JSON.parse(JSON.stringify(value))
    },
    renderJson() {
      return []
    },
    nowOf() {
      return NOW
    },
    threadView(thread) {
      return thread
    },
    isFailure(value) {
      return typeof value === 'object' && value !== null && value.ok === false
    },
  })
  return { host, store, slice, verdict: host.registry.get('cowork_review_verdict') }
}

/** Seed one project with a single thread that is awaiting an independent review. */
async function seedThread(store, repoPath) {
  await store.initIndex('session-master')
  await store.addThread({
    threadId: 'session-thread',
    subject: 'review me',
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
  })
}

function finding(overrides = {}) {
  return {
    id: 'F1',
    severity: 'high',
    problem: 'the merge gate can be skipped',
    requiredFix: 'route the merge through the gate',
    file: 'src/tools.ts',
    line: 42,
    ...overrides,
  }
}

async function withRepo(run) {
  const repoPath = await mkdtemp(join(tmpdir(), 'dsh-cowork-verdict-'))
  try {
    return await run(repoPath)
  } finally {
    await rm(repoPath, { recursive: true, force: true })
  }
}

test('a pass verdict wakes the master and leaves the finished thread alone', async () => {
  await withRepo(async (repoPath) => {
    const { store, slice, verdict } = setup(repoPath)
    await seedThread(store, repoPath)

    const result = await verdict.execute(
      { threadId: 'session-thread', verdict: 'pass', summary: 'holds up' },
      fakeExec('session-reviewer', repoPath),
    )

    assert.equal(result.ok, true)
    assert.equal(result.verdict, 'pass')
    assert.equal(result.status, 'done')
    assert.equal(result.delivered, false, 'a pass is not sent back to the thread')
    assert.equal(result.masterDelivered, true)
    assert.equal(result.masterDeliveryError, null)

    // The exact regression: the master must be prompted, the thread must not.
    assert.equal(slice.calls.length, 1)
    assert.equal(slice.calls[0].sessionId, 'session-master')
    assert.match(slice.calls[0].text, /returned pass/)
    assert.match(slice.calls[0].text, /review me/)
    assert.match(slice.calls[0].text, /cowork_checkout_merge/)
    assert.equal(existsSync(result.reviewFilePath), true)

    const index = await store.readIndex()
    assert.equal(index.threads[0].status, 'done')
    assert.equal(index.threads[0].reviewStatus, 'pass')
    assert.equal(index.threads[0].reviewedAt, NOW.toISOString())
  })
})

test('a needs_revision verdict wakes the thread with findings and informs the master', async () => {
  await withRepo(async (repoPath) => {
    const { store, slice, verdict } = setup(repoPath)
    await seedThread(store, repoPath)

    const result = await verdict.execute(
      {
        threadId: 'session-thread',
        verdict: 'needs_revision',
        summary: 'one fix before merge',
        findings: [finding()],
      },
      fakeExec('session-reviewer', repoPath),
    )

    assert.equal(result.ok, true)
    assert.equal(result.status, 'active')
    assert.equal(result.delivered, true)
    assert.equal(result.masterDelivered, true)
    assert.deepEqual(slice.calls.map((call) => call.sessionId), ['session-thread', 'session-master'])
    assert.match(slice.calls[0].text, /cowork_handoff again with status awaiting_review/)
    assert.match(slice.calls[1].text, /findings were delivered to the thread/)
    assert.match(slice.calls[1].text, /F1 \[high\].*src\/tools\.ts:42/)
  })
})

test('a failed master prompt is reported without failing the recorded verdict', async () => {
  await withRepo(async (repoPath) => {
    const { store, slice, verdict } = setup(repoPath, fakeSlice({ throwFor: 'session-master' }))
    await seedThread(store, repoPath)

    const result = await verdict.execute(
      { threadId: 'session-thread', verdict: 'pass', summary: 'holds up' },
      fakeExec('session-reviewer', repoPath),
    )

    assert.equal(result.ok, true)
    assert.equal(result.masterDelivered, false)
    assert.match(result.masterDeliveryError, /session-master prompt failed/)
    const index = await store.readIndex()
    assert.equal(index.threads[0].reviewStatus, 'pass')
  })
})

test('a failed thread prompt is named in the master message', async () => {
  await withRepo(async (repoPath) => {
    const { store, slice, verdict } = setup(repoPath, fakeSlice({ rejectFor: 'session-thread' }))
    await seedThread(store, repoPath)

    const result = await verdict.execute(
      {
        threadId: 'session-thread',
        verdict: 'needs_revision',
        summary: 'one fix before merge',
        findings: [finding()],
      },
      fakeExec('session-reviewer', repoPath),
    )

    assert.equal(result.ok, true)
    assert.equal(result.delivered, false)
    assert.match(result.deliveryError, /did not accept/)
    assert.equal(result.masterDelivered, true)
    assert.match(slice.calls[1].text, /could not be delivered to the thread/)
  })
})
