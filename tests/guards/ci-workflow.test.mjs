import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (rel) => readFileSync(resolve(root, rel), 'utf8')

const workflow = read('.github/workflows/ci.yml')

test('CI workflow has one PR-owned pr-gate job', () => {
  assert.match(workflow, /^name: CI$/m)
  assert.match(workflow, /^on:\n  pull_request:$/m)
  assert.match(workflow, /^    branches: \[main\]$/m)
  assert.doesNotMatch(workflow, /pull_request_target/)
  assert.match(workflow, /^permissions:\n  contents: read$/m)
  assert.match(workflow, /^concurrency:\n  group: ci-pr-\$\{\{ github\.event\.pull_request\.number \}\}\n  cancel-in-progress: true$/m)
  assert.match(workflow, /^  pr-gate:\n    name: pr-gate$/m)
  assert.match(workflow, /^    runs-on: ubuntu-latest$/m)
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) {
    assert.ok(workflow.includes(`${key}:`), `missing git identity for temporary test commits: ${key}`)
  }
})

test('CI workflow runs the five core gates from the PR head', () => {
  const commands = [
    'npm ci',
    'npm run check',
    'npm test',
    'npm run test:coverage',
    'npm run typecheck',
    'npm run build',
  ]
  let previous = -1
  for (const command of commands) {
    const index = workflow.indexOf(`run: ${command}`)
    assert.ok(index > previous, `missing or out-of-order command: ${command}`)
    previous = index
  }
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/)
  assert.match(workflow, /fetch-depth: 0/)
  assert.match(workflow, /git fetch --no-tags origin "\$\{\{ github\.base_ref \}\}"/)
  assert.match(workflow, /node-version-file: \.node-version/)
  assert.match(workflow, /node scripts\/review\/gate-artifact\.mjs/)
  assert.match(workflow, /name: review-context/)
})

test('CI workflow pins actions to commit SHAs and carries no secrets', () => {
  const uses = [...workflow.matchAll(/^\s+uses:\s+(\S+)(?:\s+#.*)?$/gm)].map((match) => match[1])
  assert.ok(uses.length >= 3, 'expected checkout, setup-node, and upload-artifact')
  for (const use of uses) {
    assert.match(use, /^[^@]+@[0-9a-f]{40}$/, `action is not pinned to a commit SHA: ${use}`)
  }
  assert.doesNotMatch(workflow, /secrets\./)
  assert.doesNotMatch(workflow, /write-all/)
})

test('the Node version file is an exact supported version', () => {
  const version = read('.node-version').trim()
  assert.match(version, /^22\.\d+\.\d+$/)
})
