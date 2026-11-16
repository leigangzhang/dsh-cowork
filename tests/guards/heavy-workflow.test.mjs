import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const workflow = readFileSync(resolve(root, '.github/workflows/heavy.yml'), 'utf8')

test('heavy workflow targets the local heavy runner only on demand', () => {
  assert.match(workflow, /^name: Heavy$/m)
  assert.match(workflow, /^on:\n  workflow_dispatch:$/m)
  assert.match(workflow, /^  pull_request_target:\n    types: \[labeled\]$/m)
  assert.doesNotMatch(workflow, /^  pull_request:$/m)
  assert.match(workflow, /github\.event\.label\.name == 'run-heavy'/)
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/)
  assert.match(workflow, /^    runs-on: \[self-hosted, heavy\]$/m)
  assert.match(workflow, /^  heavy-gate:\n    name: heavy-gate$/m)
})

test('heavy workflow runs the local DSH and browser prerequisites', () => {
  for (const command of [
    'npm ci',
    'npx playwright install chromium',
    'npm run typecheck',
    'npm run build',
    'DSH_HOST_SMOKE_STRICT=1 npm run test:host-smoke',
    'npm run test:coverage:layered',
  ]) {
    assert.ok(workflow.includes(command), `heavy workflow is missing: ${command}`)
  }
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/)
  assert.match(workflow, /node-version-file: \.node-version/)
  assert.match(workflow, /name: heavy-coverage/)
})

test('heavy workflow pins actions and carries no secrets', () => {
  const uses = [...workflow.matchAll(/^\s+uses:\s+(\S+)(?:\s+#.*)?$/gm)].map((match) => match[1])
  assert.ok(uses.length >= 3, 'expected checkout, setup-node, and upload-artifact')
  for (const use of uses) {
    assert.match(use, /^[^@]+@[0-9a-f]{40}$/, `action is not pinned to a commit SHA: ${use}`)
  }
  assert.doesNotMatch(workflow, /secrets\./)
})
