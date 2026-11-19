import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseReviewMarker, parseReviewVerdict } from '../../scripts/ci/review-verdict.mjs'
import { validatePrMetadata } from '../../scripts/ci/pr-metadata.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (rel) => readFileSync(resolve(root, rel), 'utf8')
const head = '0123456789abcdef0123456789abcdef01234567'

test('review verdict must name the reviewed head and pass', () => {
  const body = `Reviewed the diff.\n<!-- review-verdict:v1 head=${head} verdict=pass reviewer=agentteam model=deepseek-v4-pro -->`
  assert.deepEqual(
    parseReviewVerdict({ state: 'commented', commitId: head, body, headSha: head }),
    { markerVersion: 'v1', headSha: head, verdict: 'pass', reviewer: 'agentteam', model: 'deepseek-v4-pro' },
  )
  assert.throws(
    () => parseReviewVerdict({ state: 'commented', commitId: 'f'.repeat(40), body, headSha: head }),
    /does not match PR head/,
  )
  assert.throws(
    () => parseReviewVerdict({ state: 'changes_requested', commitId: head, body, headSha: head }),
    /cannot carry a review verdict/,
  )
  assert.throws(
    () => parseReviewVerdict({ state: 'commented', commitId: head, body: 'no marker', headSha: head }),
    /no review-verdict/,
  )
})

test('v2 review verdict binds the reviewed base and binary diff', () => {
  const base = '1'.repeat(40)
  const diffSha = '2'.repeat(64)
  const body = `Reviewed.\n<!-- review-verdict:v2 head=${head} base=${base} diffSha=${diffSha} verdict=pass reviewer=human model=manual -->`
  assert.deepEqual(
    parseReviewVerdict({ state: 'commented', commitId: head, body, headSha: head, requireV2: true }),
    { markerVersion: 'v2', headSha: head, baseSha: base, diffSha, verdict: 'pass', reviewer: 'human', model: 'manual' },
  )
  assert.throws(
    () => parseReviewVerdict({
      state: 'commented',
      commitId: head,
      body: `<!-- review-verdict:v1 head=${head} verdict=pass reviewer=agentteam model=deepseek-v4-pro -->`,
      headSha: head,
      requireV2: true,
    }),
    /no review-verdict:v2/,
  )
})

test('non-pass markers are readable and never satisfy the pass parser', () => {
  const base = '1'.repeat(40)
  const diffSha = '2'.repeat(64)
  for (const verdict of ['needs_revision', 'reject']) {
    const body = `<!-- review-verdict:v2 head=${head} base=${base} diffSha=${diffSha} verdict=${verdict} reviewer=agentteam model=deepseek-v4-pro -->`
    assert.equal(parseReviewMarker({ state: 'commented', commitId: head, body, headSha: head, requireV2: true }).verdict, verdict)
    assert.throws(
      () => parseReviewVerdict({ state: 'commented', commitId: head, body, headSha: head, requireV2: true }),
      new RegExp(`review-verdict is ${verdict}, not pass`),
    )
  }
})

test('PR metadata requires a conventional title and four sections', () => {
  const body = [
    '## Motivation',
    'Explain the problem.',
    '## Changes',
    'Explain the change.',
    '## Testing',
    'Explain the checks.',
    '## Evidence',
    'Link the evidence.',
  ].join('\n')
  assert.doesNotThrow(() => validatePrMetadata({ title: 'ci(gate): add review gate', body }))
  assert.throws(
    () => validatePrMetadata({ title: 'add review gate', body }),
    /Conventional Commits/,
  )
  assert.throws(
    () => validatePrMetadata({ title: 'ci(gate): add review gate', body: body.replace('## Evidence', '## Proof') }),
    /missing required heading: ## Evidence/,
  )
})

test('the legacy publisher stays until the replacement publisher is on main', () => {
  // A pull_request_review run executes the workflow file from the PR head. The
  // replacement workflow checks out main and runs scripts/ci/publish-gate.mjs,
  // so deleting the legacy workflow before that script reaches main leaves the
  // PR with no publisher for the required gate-artifact context. The follow-up
  // PR that deletes this workflow must replace this guard with an assertion
  // that the replacement publisher is the only one.
  const legacyPath = '.github/workflows/gate-artifact.yml'
  assert.ok(
    existsSync(resolve(root, legacyPath)),
    `${legacyPath} must stay on the PR head until scripts/ci/publish-gate.mjs is on main`,
  )
  const legacy = read(legacyPath)
  assert.match(legacy, /^name: Policy$/m)
  assert.match(legacy, /^  pull_request_review:\n    types: \[submitted, dismissed\]$/m)
  assert.match(legacy, /^  gate-artifact:\n    name: gate-artifact$/m)
  assert.match(legacy, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/)
  assert.match(legacy, /node scripts\/ci\/review-verdict\.mjs/)
  assert.match(legacy, /scripts\/review\/gate-artifact\.mjs/)

  const replacement = read('.github/workflows/gate-artifact-v2.yml')
  assert.match(replacement, /^name: Policy V2$/m)
  assert.match(replacement, /ref: main/)
  assert.match(replacement, /node scripts\/ci\/publish-gate\.mjs/)
})
