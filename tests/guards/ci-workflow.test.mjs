import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (rel) => readFileSync(resolve(root, rel), 'utf8')

const workflow = read('.github/workflows/ci.yml')

test('CI workflow keeps one stable PR-owned pr-gate verdict', () => {
  assert.match(workflow, /^name: CI$/m)
  assert.match(workflow, /^on:\n  pull_request:\n    branches: \[main\]$/m)
  assert.doesNotMatch(workflow, /pull_request_target/)
  assert.match(workflow, /^permissions:\n  contents: read$/m)
  assert.match(workflow, /^concurrency:\n  group: ci-pr-\$\{\{ github\.event\.pull_request\.number \}\}\n  cancel-in-progress: true$/m)
  assert.match(workflow, /^  pr-gate:\n    name: pr-gate$/m)
  assert.match(workflow, /^    needs: \[classify, docs-check, unit, code-health\]$/m)
  assert.match(workflow, /^    if: \$\{\{ always\(\) \}\}$/m)
})

test('CI splits documentation conventions from the source coverage lane', () => {
  for (const job of ['classify', 'docs-check', 'unit', 'code-health']) {
    assert.match(workflow, new RegExp(`^  ${job}:\\n`, 'm'), `missing job ${job}`)
  }
  assert.match(workflow, /node scripts\/ci\/classify-change\.mjs/)
  assert.match(workflow, /needs\.classify\.outputs\.docs_only != 'true'/)
  assert.match(workflow, /run: npm run check/)
  assert.match(workflow, /run: npm run test:coverage/)
  assert.doesNotMatch(workflow, /run: npm test/)
  assert.doesNotMatch(workflow, /run: npm run typecheck/)
  assert.doesNotMatch(workflow, /run: npm run build/)
})

test('pr-gate rejects failed or incorrectly skipped lanes before writing review context', () => {
  for (const check of [
    'classification did not succeed',
    'docs-check did not succeed',
    'unit did not succeed for a source change',
    'unit ran or failed although the change was classified as docs-only',
    'code-health did not succeed for a source change',
    'code-health ran or failed although the change was classified as docs-only',
  ]) {
    assert.ok(workflow.includes(check), `missing aggregate guard: ${check}`)
  }
  assert.match(workflow, /node scripts\/review\/gate-artifact\.mjs/)
  assert.match(workflow, /name: review-context/)
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/)
  assert.match(workflow, /fetch-depth: 0/)
  assert.match(workflow, /git fetch --no-tags origin "\$\{\{ github\.base_ref \}\}"/)
  assert.match(workflow, /node-version-file: \.node-version/)
})

test('code-health audits the merge base and gates the JSON attribution counters', () => {
  assert.match(workflow, /^  code-health:\n    name: code-health$/m)
  assert.match(workflow, /^    needs: classify$/m)
  assert.match(workflow, /needs\.classify\.outputs\.docs_only != 'true'/)
  assert.match(workflow, /git merge-base "origin\/\$\{\{ github\.base_ref \}\}" "\$\{\{ github\.event\.pull_request\.head\.sha \}\}"/)
  assert.match(workflow, /run: npm ci/)
  assert.match(workflow, /npm run --silent fallow:audit --\n\s+--base "\$\{\{ steps\.base\.outputs\.sha \}\}"/)
  assert.match(workflow, /node scripts\/ci\/fallow-gate\.mjs/)
  assert.match(workflow, /--expect-base "\$\{\{ steps\.base\.outputs\.sha \}\}"/)
  assert.match(workflow, /--expect-head "\$\{\{ github\.event\.pull_request\.head\.sha \}\}"/)
  assert.match(workflow, /run: npm run fallow:health/)
  assert.match(workflow, /fetch-depth: 0/)
  assert.match(workflow, /complexity_worsened/)
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
