import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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

test('the replacement publisher is the only one after the legacy workflow retires', () => {
  // PR #57 landed scripts/ci/publish-gate.mjs together with the keep-alive
  // guard for the legacy workflow. This follow-up retires the legacy publisher
  // only after that script is on main: a pull_request_review run executes the
  // head workflow, which now must publish the required gate-artifact context
  // itself. Reintroducing a second publisher needs a deliberate test change.
  assert.equal(
    existsSync(resolve(root, '.github/workflows/gate-artifact.yml')),
    false,
    'the legacy gate-artifact workflow is retired; keep it only if the replacement publisher is not on main',
  )
  const workflows = readdirSync(resolve(root, '.github/workflows'))
    .filter((name) => name.endsWith('.yml'))
    .sort()
  const publishers = workflows.filter((name) => read(`.github/workflows/${name}`).includes('scripts/ci/publish-gate.mjs'))
  assert.deepEqual(publishers, ['gate-artifact-v2.yml'], 'the required gate-artifact publisher must stay unique')

  const replacement = read('.github/workflows/gate-artifact-v2.yml')
  assert.match(replacement, /^name: Policy V2$/m)
  assert.match(replacement, /^  pull_request_review:/m)
  assert.match(replacement, /^  workflow_run:/m)
  assert.match(replacement, /^  checks: write$/m)
  assert.match(replacement, /^  statuses: write$/m)
  assert.match(replacement, /ref: main/)
  assert.doesNotMatch(replacement, /GATE_CHECK_NAME/)
  const uses = [...replacement.matchAll(/^\s+uses:\s+(\S+)(?:\s+#.*)?$/gm)].map((match) => match[1])
  for (const use of uses) {
    assert.match(use, /^[^@]+@[0-9a-f]{40}$/, `action is not pinned to a commit SHA: ${use}`)
  }
})
