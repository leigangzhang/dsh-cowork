import test from 'node:test'
import assert from 'node:assert/strict'
import './support/ts-hook.mjs'
// `src/index.ts` imports its siblings with the build's `.js` specifiers, and
// its transitively loaded runners use TypeScript parameter properties, which
// strip-only mode rejects. The hook is the one `tests/dev-gate.test.mjs` uses:
// resolve `.js` siblings as `.ts` and transform (not strip) the source.

const { createOpenWorkspacePathPort, OPEN_WORKSPACE_PATH_TIMEOUT_MS } = await import('../src/index.ts')

test('the open port hands the host a path request and an AbortSignal', async () => {
  const calls = []
  const port = createOpenWorkspacePathPort({
    async openWorkspacePath(request, signal) {
      calls.push({ request, signal, args: arguments.length })
      // The installed host does exactly this before touching the filesystem;
      // with a missing signal it throws "… reading 'aborted'" (t13 F-GUI-1).
      signal.throwIfAborted()
      return { opened: true }
    },
  })
  await port('/repo/docs/PLAN_DEMO.md')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].request, { path: '/repo/docs/PLAN_DEMO.md', action: 'reveal' })
  assert.equal(calls[0].signal instanceof AbortSignal, true, 'the host receives a real AbortSignal')
  assert.equal(calls[0].signal.aborted, false)
  assert.equal(calls[0].args, 2, 'the host contract is (request, signal)')
  assert.equal(OPEN_WORKSPACE_PATH_TIMEOUT_MS, 10_000)
})

test('the port aborts a hung host call after its timeout signal', async () => {
  let captured
  const port = createOpenWorkspacePathPort({
    async openWorkspacePath(_request, signal) {
      captured = signal
      return undefined
    },
  }, 25)
  await port('/repo/docs/PLAN.md')
  assert.equal(captured.aborted, false)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(captured.aborted, true, 'AbortSignal.timeout aborts without blocking the port')
})

test('a missing host method and a rejected native open are reported, not swallowed', async () => {
  const missing = createOpenWorkspacePathPort(undefined)
  await assert.rejects(missing('/repo/docs/PLAN.md'), /exposes no openWorkspacePath/)

  const blank = createOpenWorkspacePathPort({})
  await assert.rejects(blank('/repo/docs/PLAN.md'), /exposes no openWorkspacePath/)

  const refused = createOpenWorkspacePathPort({
    async openWorkspacePath() {
      throw new Error('no desktop session')
    },
  })
  await assert.rejects(refused('/repo/docs/PLAN.md'), /no desktop session/)
})

test('the port forwards the action the inbox route asks for', async () => {
  const requests = []
  const port = createOpenWorkspacePathPort({
    openWorkspacePath: async (request, signal) => {
      signal.throwIfAborted()
      requests.push(request)
      return undefined
    },
  })
  await port('/repo/a.md')
  await port('/repo/b.md')
  assert.deepEqual(requests.map((row) => row.action), ['reveal', 'reveal'])
  assert.deepEqual(requests.map((row) => row.path), ['/repo/a.md', '/repo/b.md'])
})
