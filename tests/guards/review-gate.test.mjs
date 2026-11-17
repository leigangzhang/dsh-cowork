import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseReviewVerdict } from '../../scripts/ci/review-verdict.mjs'
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
    /cannot carry a passing verdict/,
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

test('the retired legacy gate is replaced by one required publisher', () => {
  assert.equal(existsSync(resolve(root, '.github/workflows/gate-artifact.yml')), false)
  const workflow = read('.github/workflows/gate-artifact-v2.yml')
  assert.match(workflow, /^name: Policy V2$/m)
  assert.match(workflow, /^  pull_request_review:/m)
  assert.match(workflow, /^  workflow_run:/m)
  assert.match(workflow, /node scripts\/ci\/publish-gate\.mjs/)
  assert.match(workflow, /^  checks: write$/m)
  assert.doesNotMatch(workflow, /GATE_CHECK_NAME/)
  const uses = [...workflow.matchAll(/^\s+uses:\s+(\S+)(?:\s+#.*)?$/gm)].map((match) => match[1])
  for (const use of uses) {
    assert.match(use, /^[^@]+@[0-9a-f]{40}$/, `action is not pinned to a commit SHA: ${use}`)
  }
})
