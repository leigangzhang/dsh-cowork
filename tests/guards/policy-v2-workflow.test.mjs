import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (rel) => readFileSync(resolve(root, rel), 'utf8')

test('derived gate recalculates from PR, review, and CI/pre-merge events', () => {
  const workflow = read('.github/workflows/gate-artifact-v2.yml')
  assert.match(workflow, /^name: Policy V2$/m)
  assert.match(workflow, /^  pull_request_target:/m)
  assert.match(workflow, /^  pull_request_review:/m)
  assert.match(workflow, /^  workflow_run:\n    workflows: \[CI, Pre-Merge\]\n    types: \[completed\]$/m)
  assert.match(workflow, /^  workflow_dispatch:\n    inputs:\n      pr_number:$/m)
  assert.match(workflow, /INPUT_PR_NUMBER: \$\{\{ github\.event\.inputs\.pr_number \}\}/)
  assert.match(workflow, /^permissions:\n  contents: read\n  pull-requests: read\n  checks: write\n  statuses: write$/m)
  assert.match(workflow, /^  policy-gate:\n    name: policy-gate$/m)
  assert.match(workflow, /ref: main/)
  assert.match(workflow, /node scripts\/ci\/publish-gate\.mjs/)
  assert.match(workflow, /GATE_CHECK_TOKEN:/)
  assert.match(workflow, /actions\/create-github-app-token@[0-9a-f]{40}/)
  assert.match(workflow, /POLICY_MODE:/)
  assert.match(workflow, /commits\/\$WORKFLOW_RUN_HEAD_SHA\/pulls/)
  assert.match(workflow, /if length == 1 then .\[0\]\.number elif length == 0 then "none" else "multiple" end/)
  assert.match(workflow, /No open pull request for this run; skipping gate publication/)
  assert.match(workflow, /steps\.event\.outputs\.pr_number != ''/)
  assert.doesNotMatch(workflow, /GATE_CHECK_NAME/)
  assert.doesNotMatch(workflow, /run: npm /)
  assert.doesNotMatch(workflow, /pull-requests: write/)
})

test('base recheck invalidates old gates without notifying or editing PRs', () => {
  const workflow = read('.github/workflows/base-recheck.yml')
  assert.match(workflow, /^name: Policy Base$/m)
  assert.match(workflow, /^on:\n  push:\n    branches: \[main\]$/m)
  assert.match(workflow, /^permissions:\n  contents: read\n  pull-requests: read\n  checks: write\n  statuses: write$/m)
  assert.match(workflow, /node scripts\/ci\/base-recheck\.mjs/)
  assert.doesNotMatch(workflow, /pull-requests: write/)
  assert.doesNotMatch(workflow, /gh pr comment/)
  assert.doesNotMatch(workflow, /merge-conflict/)
  assert.doesNotMatch(workflow, /GATE_CHECK_NAME/)
  assert.doesNotMatch(workflow, /POLICY_MODE/)
})

test('policy workflows pin actions to commit SHAs', () => {
  for (const file of ['.github/workflows/gate-artifact-v2.yml', '.github/workflows/base-recheck.yml']) {
    const workflow = read(file)
    const uses = [...workflow.matchAll(/^\s+uses:\s+(\S+)(?:\s+#.*)?$/gm)].map((match) => match[1])
    assert.ok(uses.length >= 1, `${file} must use checkout`)
    for (const use of uses) {
      assert.match(use, /^[^@]+@[0-9a-f]{40}$/, `${file}: action is not pinned to a commit SHA: ${use}`)
    }
  }
})
