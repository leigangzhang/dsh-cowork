import test from 'node:test'
import assert from 'node:assert/strict'

import { decideGate, findPassingReview, overlapPaths, publishGateCheck } from '../../scripts/ci/publish-gate.mjs'

const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const diff = 'c'.repeat(64)

function review(overrides = {}) {
  return {
    state: 'COMMENTED',
    commit_id: head,
    submitted_at: '2026-11-17T00:00:00Z',
    body: `<!-- review-verdict:v2 head=${head} base=${base} diffSha=${diff} verdict=pass reviewer=agentteam model=deepseek-v4-pro -->`,
    ...overrides,
  }
}

test('findPassingReview requires a current v2 verdict and respects later change requests', () => {
  assert.equal(findPassingReview([review()], head).verdict.markerVersion, 'v2')
  assert.throws(() => findPassingReview([review({ commit_id: 'd'.repeat(40) })], head), /no passing/)
  assert.throws(
    () => findPassingReview([
      review(),
      review({ state: 'CHANGES_REQUESTED', submitted_at: '2026-11-17T00:01:00Z', body: '' }),
    ], head),
    /CHANGES_REQUESTED/,
  )
  assert.doesNotThrow(() => findPassingReview([
    review(),
    review({ state: 'COMMENTED', submitted_at: '2026-11-17T00:01:00Z', body: 'looks good' }),
  ], head))
})

test('overlapPaths returns the sorted intersection of reviewed and main paths', () => {
  assert.deepEqual(overlapPaths(['src/b.ts', 'src/a.ts', 'docs/x.md'], ['src/a.ts', 'docs/x.md']), [
    'docs/x.md',
    'src/a.ts',
  ])
  assert.deepEqual(overlapPaths(['src/a.ts'], ['src/b.ts']), [])
})

test('decideGate reports missing or stale inputs', () => {
  assert.deepEqual(decideGate({ prGate: {}, preMerge: { base: 'main' }, currentMain: 'main' }), {
    pass: true,
    reasons: [],
  })
  const decision = decideGate({
    prGate: null,
    preMerge: { base: 'old' },
    currentMain: 'main',
    reviewError: 'no review',
    metadataError: 'bad title',
    diffError: 'bad diff',
    overlap: ['src/a.ts'],
  })
  assert.equal(decision.pass, false)
  assert.match(decision.reasons.join('\n'), /pr-gate/)
  assert.match(decision.reasons.join('\n'), /pre-merge tested base old/)
  assert.match(decision.reasons.join('\n'), /delta review required/)
})

test('publishGateCheck sends one completed check run', async () => {
  const requests = []
  const result = await publishGateCheck({
    token: 'token',
    repository: 'owner/repo',
    apiUrl: 'https://api.example',
    head,
    name: 'gate-artifact-v2',
    conclusion: 'success',
    title: 'REPORT: gate would pass',
    summary: '{}',
    detailsUrl: 'https://github.com/owner/repo/actions/runs/1',
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) })
      return { ok: true, json: async () => ({ id: 7 }) }
    },
  })
  assert.deepEqual(result, { id: 7, conclusion: 'success' })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].body.head_sha, head)
  assert.equal(requests[0].body.output.title, 'REPORT: gate would pass')
})
