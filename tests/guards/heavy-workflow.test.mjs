import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const workflow = readFileSync(resolve(root, '.github/workflows/heavy.yml'), 'utf8')

test('heavy workflow runs automatically for same-repository PR heads and supports a label dispatch', () => {
  assert.match(workflow, /^name: Heavy$/m)
  assert.match(workflow, /^on:\n  workflow_dispatch:$/m)
  assert.match(workflow, /^  workflow_run:\n    workflows: \[CI\]\n    types: \[completed\]\n    branches:\n      - 'agent\/\*\*'$/m)
  assert.match(workflow, /^  pull_request_target:\n    types: \[labeled\]\n    branches: \[main\]$/m)
  assert.match(workflow, /github\.event\.workflow_run\.event == 'pull_request'/)
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/)
  assert.match(workflow, /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/)
  assert.match(workflow, /github\.event\.label\.name == 'heavy'/)
  assert.match(workflow, /github\.event\.pull_request\.state == 'open'/)
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/)
  assert.match(workflow, /group: heavy-\$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/)
  assert.match(workflow, /HEAD_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/)
  assert.match(workflow, /git checkout --detach "\$HEAD_SHA"/)
  assert.match(workflow, /LOCAL_REPO: \$\{\{ inputs\.repo_path \|\| '\/Users\/ray\/Workspace\/dsh-cowork' \}\}/)
  assert.match(workflow, /^permissions:\n  contents: read\n  statuses: write\n  checks: write$/m)
  assert.match(workflow, /^    runs-on: \[self-hosted, heavy\]$/m)
  assert.match(workflow, /^  heavy-gate:\n    name: heavy-gate$/m)
  assert.match(workflow, /name: Refresh source branch refs/)
  assert.match(workflow, /id: source/)
  assert.match(workflow, /git -C "\$LOCAL_REPO" fetch --no-tags origin '\+refs\/heads\/\*:refs\/remotes\/origin\/\*'/)
  assert.match(workflow, /echo "main=\$\(git -C "\$LOCAL_REPO" rev-parse refs\/remotes\/origin\/main\)" >> "\$GITHUB_OUTPUT"/)
  assert.match(workflow, /git clone --no-hardlinks --no-checkout "\$LOCAL_REPO" \./)
  assert.match(workflow, /name: Prepare trusted source/)
  assert.match(workflow, /git -C "\$LOCAL_REPO" archive --format=tar refs\/remotes\/origin\/main \| tar -x -C "\$TRUSTED_ROOT"/)
  assert.match(workflow, /name: Classify changed paths/)
  assert.match(workflow, /node "\$RUNNER_TEMP\/heavy-trusted\/scripts\/ci\/classify-change\.mjs"/)
  assert.match(workflow, /git config --global init\.defaultBranch main/)
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) {
    assert.ok(workflow.includes(`${key}:`), `missing git identity for temporary test commits: ${key}`)
  }
})

test('heavy workflow resolves one fixed base SHA for the identity, coverage, and publisher', () => {
  assert.match(workflow, /default: ''/)
  assert.match(workflow, /BASE_INPUT: \$\{\{ inputs\.base \}\}/)
  assert.match(workflow, /TRUSTED_MAIN: \$\{\{ steps\.source\.outputs\.main \}\}/)
  assert.match(workflow, /git -C "\$LOCAL_REPO" cat-file -e "\$\{BASE_INPUT\}\^\{commit\}"/)
  assert.match(workflow, /git -C "\$LOCAL_REPO" fetch --no-tags origin "\$BASE_INPUT"/)
  assert.match(workflow, /git -C "\$LOCAL_REPO" merge-base "\$TRUSTED_MAIN" "\$HEAD_SHA"/)
  assert.match(workflow, /id: base/)
  assert.match(workflow, /steps\.base\.outputs\.sha/)
  assert.match(workflow, /--base "\$\{\{ steps\.base\.outputs\.sha \}\}"\n          --head "\$HEAD_SHA"/)
  assert.match(workflow, /npm run test:coverage:layered -- --base "\$\{\{ steps\.base\.outputs\.sha \}\}"/)
  assert.match(workflow, /HEAVY_BASE_REF: \$\{\{ steps\.base\.outputs\.sha \}\}/)
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
    'node "$RUNNER_TEMP/heavy-trusted/scripts/ci/publish-heavy.mjs"',
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
  assert.match(workflow, /if: \$\{\{ always\(\) && steps\.classify\.outputs\.docs_only != 'true' \}\}/)
  assert.match(workflow, /if: steps\.classify\.outputs\.docs_only != 'true'/)
  assert.match(workflow, /node "\$RUNNER_TEMP\/heavy-trusted\/scripts\/review\/gate-artifact\.mjs"/)
})

test('heavy workflow downloads no actions and carries no secrets', () => {
  const uses = [...workflow.matchAll(/^\s+uses:\s+(\S+)(?:\s+#.*)?$/gm)].map((match) => match[1])
  assert.deepEqual(uses, [])
  assert.doesNotMatch(workflow, /^\s+uses:\s+actions\//m)
  assert.doesNotMatch(workflow, /secrets\./)
})
