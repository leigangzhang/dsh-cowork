import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const workflow = readFileSync(resolve(root, '.github/workflows/heavy.yml'), 'utf8')

test('heavy workflow is manual-only and targets the local heavy runner', () => {
  assert.match(workflow, /^name: Heavy$/m)
  assert.match(workflow, /^on:\n  workflow_dispatch:$/m)
  assert.doesNotMatch(workflow, /pull_request/)
  assert.match(workflow, /^permissions:\n  contents: read$/m)
  assert.match(workflow, /^    runs-on: \[self-hosted, heavy\]$/m)
  assert.match(workflow, /^  heavy-gate:\n    name: heavy-gate$/m)
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/)
  assert.match(workflow, /git fetch --no-tags origin "\$\{\{ inputs\.base \}\}"/)
})

test('heavy workflow runs its prerequisites in order', () => {
  const commands = [
    'test "$(node --version)" = "v$(cat .node-version)"',
    'npm ci',
    'npx playwright install chromium',
    'npm run typecheck',
    'npm run build',
    'DSH_HOST_SMOKE_STRICT=1 npm run test:host-smoke',
    'npm run test:coverage:layered',
  ]
  let previous = -1
  for (const command of commands) {
    const index = workflow.indexOf(command)
    assert.ok(index > previous, `heavy workflow is missing or out of order: ${command}`)
    previous = index
  }
  assert.match(workflow, /coverage\/layered\.json/)
})

test('heavy workflow uses only pinned actions and carries no secrets', () => {
  const uses = [...workflow.matchAll(/^\s+uses:\s+(\S+)(?:\s+#.*)?$/gm)].map((match) => match[1])
  assert.deepEqual(uses, ['actions/checkout@11d5960a326750d5838078e36cf38b85af677262'])
  assert.doesNotMatch(workflow, /actions\/setup-node/)
  assert.doesNotMatch(workflow, /actions\/upload-artifact/)
  assert.doesNotMatch(workflow, /secrets\./)
})
