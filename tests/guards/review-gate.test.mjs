import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

test('gate-artifact workflow owns the review event and required check', () => {
  const workflow = read('.github/workflows/gate-artifact.yml')
  assert.match(workflow, /^name: Policy$/m)
  assert.match(workflow, /^on:\n  pull_request_review:\n    types: \[submitted, dismissed\]$/m)
  assert.match(workflow, /vars\.MERGE_POLICY_MODE != 'block'/)
  assert.match(workflow, /^  gate-artifact:\n    name: gate-artifact$/m)
  assert.match(workflow, /REVIEW_STATE: \$\{\{ github\.event\.review\.state \}\}/)
  assert.match(workflow, /REVIEW_COMMIT_ID: \$\{\{ github\.event\.review\.commit_id \}\}/)
  assert.match(workflow, /node scripts\/ci\/review-verdict\.mjs/)
  assert.match(workflow, /node scripts\/ci\/pr-metadata\.mjs/)
  assert.match(workflow, /select\(\.name == "pr-gate" and \.conclusion == "success"\)/)
  assert.match(workflow, /git merge-base --is-ancestor origin\/main/)
  assert.match(workflow, /name: gate-artifact/)
  assert.match(workflow, /<!-- gate-artifact:v1 head=\$HEAD_SHA base=\$BASE_SHA -->/)
  assert.doesNotMatch(workflow, /pull_request_target/)

  const uses = [...workflow.matchAll(/^\s+uses:\s+(\S+)(?:\s+#.*)?$/gm)].map((match) => match[1])
  for (const use of uses) {
    assert.match(use, /^[^@]+@[0-9a-f]{40}$/, `action is not pinned to a commit SHA: ${use}`)
  }
})
