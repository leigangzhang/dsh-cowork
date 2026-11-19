import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPreMergeSummary,
  conclusionForResult,
  publishPreMerge,
} from '../../scripts/ci/publish-pre-merge.mjs'

const head = 'a'.repeat(40)
const base = 'b'.repeat(40)

test('pre-merge publication maps failures and stale bases to blocking conclusions', () => {
  assert.equal(conclusionForResult('success', false), 'success')
  assert.equal(conclusionForResult('failure', false), 'failure')
  assert.equal(conclusionForResult('cancelled', false), 'cancelled')
  assert.equal(conclusionForResult('success', true), 'action_required')
})

test('pre-merge summary is the integration identity consumed by the gate', () => {
  assert.deepEqual(JSON.parse(buildPreMergeSummary({
    head,
    base: 'old',
    currentBase: 'main',
    docsOnly: false,
    result: 'failure',
    runUrl: 'https://example.test/run',
  })), {
    head,
    base: 'old',
    currentBase: 'main',
    docsOnly: false,
    result: 'failure',
    staleBase: true,
    run: 'https://example.test/run',
  })
  assert.equal(conclusionForResult('success', false), 'success')
  assert.equal(conclusionForResult('success', true), 'action_required')
})

test('publishPreMerge writes one check run on the PR head', async () => {
  const requests = []
  const result = await publishPreMerge({
    token: 'token',
    repository: 'owner/repo',
    apiUrl: 'https://api.example',
    head,
    base,
    currentBase: base,
    docsOnly: true,
    result: 'success',
    runUrl: 'https://example.test/run',
    checkName: 'pre-merge',
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) })
      return { ok: true, json: async () => ({ id: 9 }) }
    },
  })
  assert.equal(result.conclusion, 'success')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].body.head_sha, head)
  assert.equal(requests[0].body.name, 'pre-merge')
  assert.equal(JSON.parse(requests[0].body.output.summary).head, head)
})
