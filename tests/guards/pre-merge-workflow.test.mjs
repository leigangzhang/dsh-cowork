import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (rel) => readFileSync(resolve(root, rel), 'utf8')
const workflow = read('.github/workflows/pre-merge.yml')

test('pre-merge runs from trusted base code and only on PR updates or recheck', () => {
  assert.match(workflow, /^name: Pre-Merge$/m)
  assert.match(workflow, /^on:\n  pull_request_target:\n    branches: \[main\]\n    types: \[opened, synchronize, reopened, ready_for_review, labeled\]$/m)
  assert.match(workflow, /github\.event\.action != 'labeled' \|\| github\.event\.label\.name == 'recheck'/)
  assert.match(workflow, /^permissions:\n  contents: read$/m)
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/)
  assert.match(workflow, /git fetch --no-tags origin main/)
})

test('pre-merge tests the temporary merge result, not the PR head alone', () => {
  const merge = workflow.indexOf('git merge --no-ff --no-edit')
  const install = workflow.indexOf('run: npm ci')
  const check = workflow.indexOf('run: npm run check')
  const coverage = workflow.indexOf('run: npm run test:coverage')
  assert.ok(merge > 0, 'pre-merge must merge current main')
  assert.ok(install > merge, 'dependencies must be installed after the merge')
  assert.ok(check > install, 'conventions must run on the merged tree')
  assert.ok(coverage > check, 'coverage must run after conventions')
  assert.match(workflow, /steps\.classify\.outputs\.docs_only != 'true'/)
  assert.match(workflow, /node scripts\/ci\/classify-change\.mjs/)
  assert.match(workflow, /git diff --name-only --diff-filter=U/)
})

test('pre-merge publishes only a trusted check and does not notify or label conflicts', () => {
  assert.match(workflow, /^  publish:\n    name: pre-merge$/m)
  assert.match(workflow, /^      checks: write$/m)
  assert.match(workflow, /node scripts\/ci\/publish-pre-merge\.mjs/)
  assert.doesNotMatch(workflow, /pull-requests: write/)
  assert.doesNotMatch(workflow, /merge-conflict/)
  assert.doesNotMatch(workflow, /gh pr comment/)
  assert.doesNotMatch(workflow, /gh pr edit/)
  assert.doesNotMatch(workflow, /@author/)
})

test('pre-merge test and publish jobs keep separate trust boundaries', () => {
  const testJob = jobSection('pre-merge-test')
  assert.match(testJob, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/)
  assert.match(testJob, /permissions:\n      contents: read/)
  assert.doesNotMatch(testJob, /checks: write/)

  const publishJob = jobSection('publish')
  assert.match(publishJob, /ref: main/)
  assert.match(publishJob, /permissions:\n      contents: read\n      checks: write/)
  assert.match(publishJob, /node scripts\/ci\/publish-pre-merge\.mjs/)
  assert.doesNotMatch(publishJob, /npm ci/)
})

function jobSection(name) {
  const marker = `\n  ${name}:\n`
  const start = workflow.indexOf(marker)
  assert.ok(start >= 0, `missing job ${name}`)
  const rest = workflow.slice(start + 1)
  const next = rest.search(/\n  [a-z0-9-]+:\n/)
  return next === -1 ? rest : rest.slice(0, next)
}

test('pre-merge actions are pinned to commit SHAs', () => {
  const uses = [...workflow.matchAll(/^\s+uses:\s+(\S+)(?:\s+#.*)?$/gm)].map((match) => match[1])
  assert.ok(uses.length >= 2)
  for (const use of uses) {
    assert.match(use, /^[^@]+@[0-9a-f]{40}$/, `action is not pinned to a commit SHA: ${use}`)
  }
})
