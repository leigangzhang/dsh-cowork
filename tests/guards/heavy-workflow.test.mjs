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
  assert.match(workflow, /^permissions:\n  contents: read\n  statuses: write\n  checks: write$/m)
  assert.match(workflow, /^    runs-on: \[self-hosted, heavy\]$/m)
  assert.match(workflow, /^  heavy-gate:\n    name: heavy-gate$/m)
  assert.match(workflow, /inputs\.repo_path/)
  assert.match(workflow, /git clone --no-hardlinks --no-checkout "\$LOCAL_REPO" \./)
  assert.match(workflow, /git checkout --detach "\$GITHUB_SHA"/)
  assert.match(workflow, /git fetch --no-tags origin "\$\{\{ inputs\.base \}\}"/)
  assert.match(workflow, /id: base/)
  assert.match(workflow, /steps\.base\.outputs\.sha/)
  assert.match(workflow, /git config --global init\.defaultBranch main/)
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) {
    assert.ok(workflow.includes(`${key}:`), `missing git identity for temporary test commits: ${key}`)
  }
})

test('heavy workflow runs its prerequisites in order', () => {
  const commands = [
    'test "$(node --version)" = "v$(cat .node-version)"',
    'npm ci',
    'npx playwright install chromium',
    'npm run typecheck',
    'npm run build',
    'npm run test:host-smoke',
    'npm run test:coverage:layered -- --base',
    'npm run test:e2e',
    'npm run test:e2e:bash',
    'node scripts/ci/publish-heavy.mjs',
  ]
  let previous = -1
  for (const command of commands) {
    const index = workflow.indexOf(command)
    assert.ok(index > previous, `heavy workflow is missing or out of order: ${command}`)
    previous = index
  }
  assert.match(workflow, /DSH_HOST_SMOKE_STRICT: "1"/)
  assert.match(workflow, /coverage\/layered\.json/)
  assert.match(workflow, /HEAVY_BEFORE_ARTIFACT/)
  assert.match(workflow, /HEAVY_RESULT_PATH/)
  assert.match(workflow, /if: \$\{\{ always\(\) \}\}/)
})

test('heavy workflow downloads no actions and carries no secrets', () => {
  const uses = [...workflow.matchAll(/^\s+uses:\s+(\S+)(?:\s+#.*)?$/gm)].map((match) => match[1])
  assert.deepEqual(uses, [])
  assert.doesNotMatch(workflow, /^\s+uses:\s+actions\//m)
  assert.doesNotMatch(workflow, /secrets\./)
})
