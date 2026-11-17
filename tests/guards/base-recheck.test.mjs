import test from 'node:test'
import assert from 'node:assert/strict'

import { publishStaleGate, shouldInvalidateGate } from '../../scripts/ci/base-recheck.mjs'

const head = 'a'.repeat(40)

test('only a non-draft PR with a previous green gate is invalidated', () => {
  const green = [{ name: 'gate-artifact-v2', conclusion: 'success' }]
  assert.equal(shouldInvalidateGate({ draft: false, checkRuns: green }, 'gate-artifact-v2'), true)
  assert.equal(shouldInvalidateGate({ draft: true, checkRuns: green }, 'gate-artifact-v2'), false)
  assert.equal(shouldInvalidateGate({ draft: false, checkRuns: [{ name: 'gate-artifact-v2', conclusion: 'failure' }] }, 'gate-artifact-v2'), false)
  assert.equal(shouldInvalidateGate({ draft: false, checkRuns: [{ name: 'other', conclusion: 'success' }] }, 'gate-artifact-v2'), false)
})

test('publishStaleGate writes an action_required check without modifying the PR', async () => {
  const requests = []
  await publishStaleGate({
    token: 'token',
    repository: 'owner/repo',
    apiUrl: 'https://api.example',
    checkName: 'gate-artifact-v2',
    head,
    mainSha: 'b'.repeat(40),
    runUrl: 'https://example.test/run',
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) })
      return { ok: true, text: async () => '' }
    },
  })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].body.head_sha, head)
  assert.equal(requests[0].body.conclusion, 'action_required')
  assert.match(requests[0].body.output.summary, /base-advanced/)
})
