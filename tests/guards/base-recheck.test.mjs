import test from 'node:test'
import assert from 'node:assert/strict'

import { publishStaleGate, shouldInvalidateGate } from '../../scripts/ci/base-recheck.mjs'

const head = 'a'.repeat(40)
const contexts = ['gate-artifact', 'gate-artifact-v2']

test('only a non-draft PR with a previous green status or display check is invalidated', () => {
  const greenStatus = [{ context: 'gate-artifact', state: 'success' }]
  const greenCheck = [{ name: 'gate-artifact-v2', conclusion: 'success' }]
  assert.equal(shouldInvalidateGate({ draft: false, statuses: greenStatus, checkRuns: [] }, contexts), true)
  assert.equal(shouldInvalidateGate({ draft: false, statuses: [], checkRuns: greenCheck }, contexts), true)
  assert.equal(shouldInvalidateGate({ draft: true, statuses: greenStatus, checkRuns: greenCheck }, contexts), false)
  assert.equal(shouldInvalidateGate({
    draft: false,
    statuses: [{ context: 'gate-artifact', state: 'pending' }],
    checkRuns: [],
  }, contexts), false)
  assert.equal(shouldInvalidateGate({
    draft: false,
    statuses: [],
    checkRuns: [{ name: 'other', conclusion: 'success' }],
  }, contexts), false)
})

test('publishStaleGate writes a pending required status and an action_required display check', async () => {
  const requests = []
  await publishStaleGate({
    token: 'token',
    repository: 'owner/repo',
    apiUrl: 'https://api.example',
    head,
    mainSha: 'b'.repeat(40),
    runUrl: 'https://example.test/run',
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) })
      return { ok: true, text: async () => '' }
    },
  })
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, `https://api.example/repos/owner/repo/statuses/${head}`)
  assert.deepEqual(requests[0].body, {
    state: 'pending',
    context: 'gate-artifact',
    description: 'base advanced; recheck required',
    target_url: 'https://example.test/run',
  })
  assert.equal(requests[1].url, 'https://api.example/repos/owner/repo/check-runs')
  assert.equal(requests[1].body.name, 'gate-artifact-v2')
  assert.equal(requests[1].body.head_sha, head)
  assert.equal(requests[1].body.conclusion, 'action_required')
  assert.match(requests[1].body.output.summary, /base-advanced/)
})
