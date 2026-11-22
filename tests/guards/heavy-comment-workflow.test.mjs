import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const workflow = readFileSync(resolve(root, '.github/workflows/heavy-comment.yml'), 'utf8')

test('the heavy comment runs only after Heavy and resolves the tested head from trusted main', () => {
  assert.match(workflow, /^name: Heavy Comment$/m)
  assert.match(workflow, /^on:\n  workflow_run:\n    workflows: \[Heavy\]\n    types: \[completed\]$/m)
  assert.match(workflow, /^permissions:\n  contents: read\n  checks: read\n  statuses: read\n  pull-requests: write\n  actions: write$/m)
  assert.match(workflow, /^    runs-on: ubuntu-latest$/m)
  assert.match(workflow, /uses: actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/)
  assert.match(workflow, /uses: actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/)
  assert.match(workflow, /ref: main/)
  assert.match(workflow, /persist-credentials: false/)
  assert.match(workflow, /node scripts\/ci\/resolve-heavy-pr\.mjs --github-output/)
  assert.match(workflow, /HEAVY_RUN_HEAD: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/)
  assert.match(workflow, /HEAVY_RUN_BRANCH: \$\{\{ github\.event\.workflow_run\.head_branch \}\}/)
  assert.match(workflow, /DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/)
  assert.match(workflow, /HEAVY_RUN_URL: \$\{\{ github\.event\.workflow_run\.html_url \}\}/)
  assert.match(workflow, /^concurrency:\n  group: heavy-comment-\$\{\{ github\.event\.workflow_run\.id \}\}\n  cancel-in-progress: true$/m)
  assert.match(workflow, /run: node scripts\/ci\/publish-heavy-comment\.mjs/)
  assert.match(workflow, /HEAD_SHA: \$\{\{ steps\.pull\.outputs\.head \}\}/)
  assert.match(workflow, /HEAVY_CONCLUSION: \$\{\{ github\.event\.workflow_run\.conclusion \}\}/)
  assert.match(workflow, /PR_NUMBER: \$\{\{ steps\.pull\.outputs\.number \}\}/)
  assert.match(workflow, /name: Trigger derived gate/)
  assert.match(workflow, /gh workflow run gate-artifact-v2\.yml --ref main -f pr_number=/)
})

test('the heavy comment never uses the default-branch run head as the tested head', () => {
  assert.doesNotMatch(workflow, /HEAD_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/)
  assert.doesNotMatch(workflow, /commits\/\$HEAD_SHA\/pulls/)
})

test('the heavy comment has no PR checkout or status/check write scopes', () => {
  assert.doesNotMatch(workflow, /pull_request_target:/)
  assert.doesNotMatch(workflow, /ref: \$\{\{ github\.event\.pull_request/)
  assert.doesNotMatch(workflow, /statuses: write/)
  assert.doesNotMatch(workflow, /checks: write/)
  assert.doesNotMatch(workflow, /secrets\./)
  assert.doesNotMatch(workflow, /npm (ci|install|test)/)
})
