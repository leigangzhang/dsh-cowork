import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  assertGateCheckName,
  binaryDiffSha,
  changedPaths,
  decideGate,
  findPassingReview,
  gateCheckNameForMode,
  gateConclusionForMode,
  isAncestor,
  overlapPaths,
  publishGateCheck,
} from '../../scripts/ci/publish-gate.mjs'

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

test('policy modes cannot publish the other mode\'s gate context', () => {
  assert.equal(gateCheckNameForMode('report'), 'gate-artifact-v2')
  assert.equal(gateCheckNameForMode('block'), 'gate-artifact')
  assert.equal(assertGateCheckName('report', 'gate-artifact-v2'), 'gate-artifact-v2')
  assert.equal(assertGateCheckName('block', 'gate-artifact'), 'gate-artifact')
  assert.throws(() => assertGateCheckName('report', 'gate-artifact'), /must publish gate-artifact-v2/)
  assert.throws(() => assertGateCheckName('block', 'gate-artifact-v2'), /must publish gate-artifact/)
})

test('report mode stays green and block mode fails a failed decision', () => {
  assert.equal(gateConclusionForMode('report', false), 'success')
  assert.equal(gateConclusionForMode('block', false), 'failure')
  assert.equal(gateConclusionForMode('block', true), 'success')
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
  assert.match(decision.reasons.join('\n'), /merge current main into the PR branch/)
})

test('decideGate rejects a pre-merge result from an older base', () => {
  const decision = decideGate({
    prGate: {},
    preMerge: { base: 'old' },
    currentMain: 'new',
  })
  assert.equal(decision.pass, false)
  assert.match(decision.reasons.join('\n'), /pre-merge tested base old/)
})

test('git identity helpers bind the reviewed diff and ancestry', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cowork-gate-identity-'))
  try {
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.name', 'test'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    await writeFile(join(repo, 'a.txt'), 'base\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'base'])
    const baseCommit = git(repo, ['rev-parse', 'HEAD']).trim()
    await writeFile(join(repo, 'a.txt'), 'head\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'head'])
    const headCommit = git(repo, ['rev-parse', 'HEAD']).trim()
    const first = binaryDiffSha(repo, baseCommit, headCommit)
    assert.match(first, /^[0-9a-f]{64}$/)
    assert.deepEqual(changedPaths(repo, baseCommit, headCommit), ['a.txt'])
    assert.equal(isAncestor(repo, baseCommit, headCommit), true)
    assert.equal(isAncestor(repo, headCommit, baseCommit), false)

    await writeFile(join(repo, 'a.txt'), 'head two\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'head two'])
    const secondCommit = git(repo, ['rev-parse', 'HEAD']).trim()
    assert.notEqual(binaryDiffSha(repo, baseCommit, secondCommit), first)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
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

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}
