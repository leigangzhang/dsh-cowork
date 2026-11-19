import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  binaryDiffSha,
  changedPaths,
  decideGate,
  decideLegacyGate,
  findPassingReview,
  findReviewDecision,
  isAncestor,
  overlapPaths,
  publishGateCheck,
  readPreMerge,
  REPORT_GATE_CHECK,
  REQUIRED_GATE_CHECK,
  requiredGateDecision,
  validateReviewedIdentity,
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
  const v1 = review({
    body: `<!-- review-verdict:v1 head=${head} verdict=pass reviewer=agentteam model=deepseek-v4-pro -->`,
  })
  assert.equal(findPassingReview([v1], head, { requireV2: false }).verdict.markerVersion, 'v1')
  assert.throws(() => findPassingReview([v1], head), /latest review decision is missing/)
  assert.throws(() => findPassingReview([review({ commit_id: 'd'.repeat(40) })], head), /latest review decision is missing/)
  assert.throws(
    () => findPassingReview([
      review(),
      review({ state: 'CHANGES_REQUESTED', submitted_at: '2026-11-17T00:01:00Z', body: '' }),
    ], head),
    /changes_requested/,
  )
  assert.doesNotThrow(() => findPassingReview([
    review(),
    review({ state: 'COMMENTED', submitted_at: '2026-11-17T00:01:00Z', body: 'looks good' }),
  ], head))
})

test('the latest non-pass marker blocks an older pass', () => {
  for (const verdict of ['needs_revision', 'reject']) {
    const blocked = findReviewDecision([
      review(),
      review({
        submitted_at: '2026-11-17T00:01:00Z',
        body: `<!-- review-verdict:v2 head=${head} base=${base} diffSha=${diff} verdict=${verdict} reviewer=agentteam model=deepseek-v4-pro -->`,
      }),
    ], head)
    assert.equal(blocked.status, verdict)
    assert.throws(
      () => findPassingReview([
        review(),
        review({
          submitted_at: '2026-11-17T00:01:00Z',
          body: `<!-- review-verdict:v2 head=${head} base=${base} diffSha=${diff} verdict=${verdict} reviewer=agentteam model=deepseek-v4-pro -->`,
        }),
      ], head),
      new RegExp(`latest review decision is ${verdict}`),
    )
  }
})

test('the required and report contexts have distinct fixed names', () => {
  assert.equal(REQUIRED_GATE_CHECK, 'gate-artifact')
  assert.equal(REPORT_GATE_CHECK, 'gate-artifact-v2')
  assert.notEqual(REQUIRED_GATE_CHECK, REPORT_GATE_CHECK)
})

test('requiredGateDecision switches the required context by mode', () => {
  const legacy = { pass: false, reasons: ['legacy'] }
  const modern = { pass: true, reasons: [] }
  assert.deepEqual(requiredGateDecision('report', legacy, modern), legacy)
  assert.deepEqual(requiredGateDecision('block', legacy, modern), modern)
})

test('decideLegacyGate keeps the current required review behavior', () => {
  assert.deepEqual(decideLegacyGate({
    reviewError: null,
    prGate: {},
    mainContainsHead: true,
    metadataError: null,
  }), { pass: true, reasons: [] })
  const decision = decideLegacyGate({
    reviewError: 'no review',
    prGate: null,
    mainContainsHead: false,
    metadataError: 'bad title',
  })
  assert.equal(decision.pass, false)
  assert.match(decision.reasons.join('\n'), /no review/)
  assert.match(decision.reasons.join('\n'), /pr-gate/)
  assert.match(decision.reasons.join('\n'), /not an ancestor/)
  assert.match(decision.reasons.join('\n'), /bad title/)
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

test('validateReviewedIdentity rejects wrong diffs, non-ancestor bases, and reports overlap', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cowork-gate-review-'))
  try {
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.name', 'test'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    await writeFile(join(repo, 'a.txt'), 'base\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'base'])
    const baseCommit = git(repo, ['rev-parse', 'HEAD']).trim()

    await writeFile(join(repo, 'a.txt'), 'main\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'main'])
    const mainCommit = git(repo, ['rev-parse', 'HEAD']).trim()

    git(repo, ['checkout', '-qb', 'head', baseCommit])
    await writeFile(join(repo, 'a.txt'), 'head\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'head'])
    const headCommit = git(repo, ['rev-parse', 'HEAD']).trim()
    const diffSha = binaryDiffSha(repo, baseCommit, headCommit)
    const review = { baseSha: baseCommit, diffSha }

    const valid = validateReviewedIdentity({
      cwd: repo,
      head: headCommit,
      currentMain: mainCommit,
      review,
      ensure: () => {},
    })
    assert.equal(valid.mainContainsHead, false)
    assert.equal(valid.diffError, null)
    assert.deepEqual(valid.overlap, ['a.txt'])

    const wrongDiff = validateReviewedIdentity({
      cwd: repo,
      head: headCommit,
      currentMain: mainCommit,
      review: { ...review, diffSha: '0'.repeat(64) },
      ensure: () => {},
    })
    assert.match(wrongDiff.diffError, /does not match current authored diff/)

    const nonAncestor = validateReviewedIdentity({
      cwd: repo,
      head: headCommit,
      currentMain: mainCommit,
      review: { ...review, baseSha: mainCommit },
      ensure: () => {},
    })
    assert.match(nonAncestor.diffError, /not an ancestor of the PR head/)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('main-side renames still overlap the reviewed path', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cowork-gate-rename-'))
  try {
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.name', 'test'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    await writeFile(join(repo, 'old.txt'), 'base\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'base'])
    const baseCommit = git(repo, ['rev-parse', 'HEAD']).trim()

    git(repo, ['mv', 'old.txt', 'new.txt'])
    git(repo, ['commit', '-qm', 'rename'])
    const mainCommit = git(repo, ['rev-parse', 'HEAD']).trim()

    git(repo, ['checkout', '-qb', 'head', baseCommit])
    await writeFile(join(repo, 'old.txt'), 'head\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'head'])
    const headCommit = git(repo, ['rev-parse', 'HEAD']).trim()
    const diffSha = binaryDiffSha(repo, baseCommit, headCommit)

    const identity = validateReviewedIdentity({
      cwd: repo,
      head: headCommit,
      currentMain: mainCommit,
      review: { baseSha: baseCommit, diffSha },
      ensure: () => {},
    })
    assert.equal(identity.diffError, null)
    assert.ok(identity.overlap.includes('old.txt'), JSON.stringify(identity.overlap))
    assert.deepEqual(changedPaths(repo, baseCommit, mainCommit).sort(), ['new.txt', 'old.txt'])
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('readPreMerge rejects malformed or stale summaries', () => {
  const head = 'a'.repeat(40)
  assert.deepEqual(readPreMerge([], head), { value: null, error: null })
  assert.match(readPreMerge([{ name: 'pre-merge', conclusion: 'success', output: { summary: 'not json' } }], head).error, /not valid JSON/)
  assert.match(readPreMerge([{
    name: 'pre-merge',
    conclusion: 'success',
    output: { summary: JSON.stringify({ head, base: 'old', result: 'success', staleBase: true }) },
  }], head).error, /older base/)
  assert.match(readPreMerge([{
    name: 'pre-merge',
    conclusion: 'failure',
    completed_at: '2026-11-17T00:02:00Z',
    output: { summary: JSON.stringify({ head, base: 'main', result: 'success' }) },
  }], head).error, /conclusion is failure/)
})

test('the publisher job stays green when it publishes a blocked decision', () => {
  // A failed job marks the app's check suite failed; a GitHub ruleset then
  // treats the required check as expected even after a later success. The
  // required check run carries the blocked verdict, so the CLI must not fail
  // the job for a published decision.
  const source = readFileSync(new URL('../../scripts/ci/publish-gate.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /if \(!required\.pass\) process\.exitCode = 1/)
  assert.match(source, /check suite/)
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
