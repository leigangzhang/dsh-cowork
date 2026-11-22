import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { collectGateArtifact } from '../../scripts/review/gate-artifact.mjs'
import {
  buildHeavyResult,
  heavyDecision,
  heavyStatusDescription,
  HEAVY_COMMANDS,
  HEAVY_DISPLAY_CHECK,
  HEAVY_GATE_CONTEXT,
  MISSING_COVERAGE_GAPS,
  mergeCommandResults,
  readCommandResults,
  readCoverageGapReport,
  sanitizeCoverageGapText,
  writeHeavyResult,
} from '../../scripts/ci/publish-heavy.mjs'

const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const diff = 'c'.repeat(64)
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

function artifact(overrides = {}) {
  return {
    resolved: { baseSha: base, headSha: head },
    diff: { sha256: diff },
    porcelain: [],
    ...overrides,
  }
}

function commandsWith(overrides = {}) {
  return HEAVY_COMMANDS.map((spec) => ({ ...spec, exitCode: 0, ...(overrides[spec.name] ?? {}) }))
}

test('heavyDecision passes only for a clean matching artifact and blocking exits', () => {
  const before = artifact()
  const commands = commandsWith({ 'e2e-bash': { exitCode: 1 } })
  assert.deepEqual(heavyDecision({
    artifact: artifact(),
    beforeArtifact: before,
    expectedHead: head,
    currentMain: base,
    commands,
    baseIsAncestor: true,
  }), { pass: true, reasons: [] })

  const dirty = artifact({ porcelain: ['?? src/a.ts'] })
  const dirtyDecision = heavyDecision({
    artifact: dirty,
    beforeArtifact: before,
    expectedHead: head,
    currentMain: base,
    commands,
    baseIsAncestor: true,
  })
  assert.equal(dirtyDecision.pass, false)
  assert.match(dirtyDecision.reasons.join('\n'), /post-run worktree is dirty/)
})

test('heavyDecision rejects a dirty pre-run tree, a mismatched diff, and a non-ancestor base', () => {
  const mismatched = heavyDecision({
    artifact: artifact(),
    beforeArtifact: artifact({ diff: { sha256: 'd'.repeat(64) } }),
    expectedHead: head,
    currentMain: base,
    commands: commandsWith(),
    baseIsAncestor: false,
  })
  assert.equal(mismatched.pass, false)
  const reasons = mismatched.reasons.join('\n')
  assert.match(reasons, /pre-run diff SHA-256 does not match/)
  assert.match(reasons, /tested base is no longer an ancestor/)

  const dirtyBefore = heavyDecision({
    artifact: artifact(),
    beforeArtifact: artifact({ porcelain: [' M src/a.ts'] }),
    expectedHead: head,
    currentMain: base,
    commands: commandsWith(),
    baseIsAncestor: true,
  })
  assert.match(dirtyBefore.reasons.join('\n'), /pre-run worktree was dirty/)
})

test('heavyDecision names a missing pre-run identity and every missing or failed blocking command', () => {
  const commands = commandsWith({ typecheck: { exitCode: 1 }, 'e2e-keyless': { exitCode: null } })
  const decision = heavyDecision({
    artifact: artifact(),
    beforeArtifact: null,
    expectedHead: 'f'.repeat(40),
    currentMain: base,
    commands,
    baseIsAncestor: true,
  })
  assert.equal(decision.pass, false)
  const reasons = decision.reasons.join('\n')
  assert.match(reasons, /pre-run gate artifact is missing/)
  assert.match(reasons, /does not match HEAD_SHA/)
  assert.match(reasons, /blocking command typecheck exited 1/)
  assert.match(reasons, /blocking command e2e-keyless has no exit code/)
  assert.doesNotMatch(reasons, /e2e-bash/)
})

test('command results reject duplicate and unknown names and preserve missing exits', () => {
  const project = mkdtempSync(join(tmpdir(), 'cowork-heavy-commands-'))
  try {
    const path = join(project, 'commands.jsonl')
    writeFileSync(path, [
      '{"name":"typecheck","exitCode":0}',
      '{"name":"build","exitCode":2}',
      '',
    ].join('\n'))
    const exits = readCommandResults(path)
    assert.deepEqual([...exits.entries()], [['typecheck', 0], ['build', 2]])
    const merged = mergeCommandResults(exits)
    assert.equal(merged.find((command) => command.name === 'typecheck').exitCode, 0)
    assert.equal(merged.find((command) => command.name === 'build').exitCode, 2)
    assert.equal(merged.find((command) => command.name === 'host-smoke').exitCode, null)

    writeFileSync(path, '{"name":"typecheck","exitCode":0}\n{"name":"typecheck","exitCode":1}\n')
    assert.throws(() => readCommandResults(path), /appears more than once/)
    writeFileSync(path, '{"name":"unknown","exitCode":0}\n')
    assert.throws(() => mergeCommandResults(readCommandResults(path)), /unknown command/)
    assert.deepEqual(readCommandResults(join(project, 'missing.jsonl')), new Map())
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('buildHeavyResult records the result identity and every command exit', () => {
  const commands = commandsWith({ 'e2e-bash': { exitCode: 1 } })
  const decision = { pass: true, reasons: [] }
  const coverageGaps = { available: true, text: 'changed uncovered lines:\n  none', truncated: false }
  const result = buildHeavyResult({
    artifact: artifact(),
    currentMain: base,
    commands,
    decision,
    baseIsAncestor: true,
    coverageGaps,
  })
  assert.equal(result.formatVersion, 1)
  assert.equal(result.head, head)
  assert.equal(result.base, base)
  assert.equal(result.currentMain, base)
  assert.equal(result.diffSha256, diff)
  assert.equal(result.clean, true)
  assert.equal(result.result, 'pass')
  assert.equal(result.commands.length, HEAVY_COMMANDS.length)
  assert.equal(result.commands.find((command) => command.name === 'e2e-bash').exitCode, 1)
  assert.equal(result.commands.find((command) => command.name === 'e2e-bash').blocking, false)
  assert.deepEqual(result.coverageGaps, coverageGaps)
  assert.equal(result.commands.find((command) => command.name === 'coverage-gaps').blocking, false)
})

test('the gap report is bounded, strips terminal controls, and never blocks publication', () => {
  const project = mkdtempSync(join(tmpdir(), 'cowork-heavy-gaps-'))
  try {
    const reportPath = join(project, 'coverage-gaps.txt')
    writeFileSync(reportPath, `\u001B[31mchanged\u001B[0m\r\n${'x'.repeat(13_000)}\n`)
    const report = readCoverageGapReport(reportPath)
    assert.equal(report.available, true)
    assert.doesNotMatch(report.text, /\u001B/)
    assert.match(report.text, /^changed\n/)
    assert.equal(report.truncated, true)
    assert.ok(report.text.length <= 12_000)

    assert.deepEqual(readCoverageGapReport(join(project, 'missing.txt')), MISSING_COVERAGE_GAPS)
    assert.equal(sanitizeCoverageGapText('a\u0000b\nc').text, 'ab\nc')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('writeHeavyResult writes one stable JSON artifact', () => {
  const project = mkdtempSync(join(tmpdir(), 'cowork-heavy-result-'))
  try {
    const path = join(project, 'nested', 'heavy-result.json')
    const result = { formatVersion: 1, result: 'pass' }
    writeHeavyResult(path, result)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), result)
    assert.equal(readFileSync(path, 'utf8').endsWith('\n'), true)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('heavyStatusDescription names the heavy verdict and stays within 140 characters', () => {
  assert.equal(heavyStatusDescription({ pass: true, reasons: [] }), 'heavy: passed')
  const blocked = heavyStatusDescription({ pass: false, reasons: ['x'.repeat(200)] })
  assert.match(blocked, /^blocked: /)
  assert.equal(blocked.length, 140)
})

test('the heavy workflow runs every command, keeps host-bash observational, and publishes from trusted main', () => {
  const workflow = readFileSync(resolve(repoRoot, '.github/workflows/heavy.yml'), 'utf8')
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /workflow_run:/)
  assert.match(workflow, /pull_request_target:/)
  assert.match(workflow, /group: heavy-\$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/)
  assert.match(workflow, /statuses: write/)
  assert.match(workflow, /checks: write/)
  assert.match(workflow, /HEAVY_BEFORE_ARTIFACT/)
  assert.match(workflow, /HEAVY_GAP_REPORT: \$\{\{ runner\.temp \}\}\/coverage-gaps\.txt/)
  assert.match(workflow, /HEAVY_RESULT_PATH/)
  assert.match(workflow, /npm run coverage:gaps -- --base/)
  assert.match(workflow, /node "\$RUNNER_TEMP\/heavy-trusted\/scripts\/ci\/publish-heavy\.mjs"/)
  assert.match(workflow, /if: \$\{\{ always\(\) && steps\.classify\.outputs\.docs_only != 'true' \}\}/)
  assert.match(workflow, /name: Versioned host-bash E2E \(observational\)[\s\S]*?continue-on-error: true/)
  for (const command of HEAVY_COMMANDS) {
    assert.ok(workflow.includes(`"name":"${command.name}"`), `workflow does not record ${command.name}`)
  }
})

const prFixture = {
  repo: '',
  baseSha: '',
  headSha: '',
  beforeArtifact: null,
}

async function createPublisherFixture(project) {
  const repo = join(project, 'repo')
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.name', 'test'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-qm', 'base'])
  const baseSha = git(repo, ['rev-parse', 'HEAD']).trim()
  writeFileSync(join(repo, 'head.txt'), 'head\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-qm', 'head'])
  const headSha = git(repo, ['rev-parse', 'HEAD']).trim()
  const beforeArtifact = collectGateArtifact(['--base', baseSha, '--head', headSha], repo)
  const beforePath = join(project, 'before.json')
  writeFileSync(beforePath, `${JSON.stringify(beforeArtifact, null, 2)}\n`)
  const commandsPath = join(project, 'commands.jsonl')
  writeFileSync(commandsPath, HEAVY_COMMANDS.map((command) => JSON.stringify({
    name: command.name,
    exitCode: command.name === 'e2e-bash' ? 1 : 0,
  })).join('\n') + '\n')
  const gapReportPath = join(project, 'coverage-gaps.txt')
  writeFileSync(gapReportPath, 'coverage gaps: base fixture head fixture\n\nchanged uncovered lines:\n  none\n')
  return {
    repo,
    baseSha,
    headSha,
    beforePath,
    commandsPath,
    gapReportPath,
    resultPath: join(project, 'heavy-result.json'),
  }
}

function makeHandler({ fixture, requests, mainSha, failCheck = false }) {
  return async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = raw === '' ? undefined : JSON.parse(raw)
    requests.push({ method: request.method, path: url.pathname, body })
    const json = (value, status = 200) => {
      response.statusCode = status
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(value))
    }
    if (request.method === 'GET' && url.pathname === '/repos/owner/repo/git/ref/heads/main') {
      return json({ object: { sha: mainSha } })
    }
    if (request.method === 'POST' && url.pathname === `/repos/owner/repo/statuses/${fixture.headSha}`) {
      return json({ state: body.state })
    }
    if (request.method === 'POST' && url.pathname === '/repos/owner/repo/check-runs') {
      if (failCheck) return json({ message: 'checks unavailable' }, 503)
      return json({ id: 7 })
    }
    return json({ error: `${request.method} ${url.pathname}` }, 404)
  }
}

async function startServer(handler) {
  const server = createServer(handler)
  await new Promise((resolveServer, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveServer)
  })
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` }
}

async function stopServer(server) {
  await new Promise((resolveServer) => server.close(resolveServer))
}

function runPublisher(env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['scripts/ci/publish-heavy.mjs'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GH_TOKEN: 'token',
        GITHUB_REPOSITORY: 'owner/repo',
        HEAD_SHA: prFixture.headSha,
        HEAVY_WORKSPACE: prFixture.repo,
        HEAVY_BASE_REF: prFixture.baseSha,
        HEAVY_COMMANDS_FILE: prFixture.commandsPath,
        HEAVY_BEFORE_ARTIFACT: prFixture.beforePath,
        HEAVY_GAP_REPORT: prFixture.gapReportPath,
        HEAVY_RESULT_PATH: prFixture.resultPath,
        RUN_URL: 'https://example.test/run',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolveRun({ code, stdout, stderr }))
  })
}

test('the publisher writes a clean success status and display check for the dispatched head', async () => {
  const project = mkdtempSync(join(tmpdir(), 'cowork-heavy-publish-'))
  const requests = []
  let server
  try {
    const fixture = await createPublisherFixture(project)
    Object.assign(prFixture, fixture)
    const started = await startServer(makeHandler({ fixture, requests, mainSha: fixture.baseSha }))
    server = started.server
    const result = await runPublisher({ GITHUB_API_URL: started.baseUrl })
    assert.equal(result.code, 0, result.stderr)
    const body = JSON.parse(readFileSync(fixture.resultPath, 'utf8'))
    assert.equal(body.result, 'pass')
    assert.equal(body.head, fixture.headSha)
    assert.equal(body.base, fixture.baseSha)
    assert.equal(body.currentMain, fixture.baseSha)
    assert.equal(body.commands.find((command) => command.name === 'e2e-bash').exitCode, 1)
    assert.equal(body.coverageGaps.available, true)
    assert.match(body.coverageGaps.text, /changed uncovered lines/)
    const status = requests.find((request) => request.method === 'POST' && request.path.includes('/statuses/'))
    assert.equal(status.body.context, HEAVY_GATE_CONTEXT)
    assert.equal(status.body.state, 'success')
    const check = requests.find((request) => request.method === 'POST' && request.path === '/repos/owner/repo/check-runs')
    assert.equal(check.body.name, HEAVY_DISPLAY_CHECK)
    assert.equal(check.body.conclusion, 'success')
    assert.equal(JSON.parse(check.body.output.summary).result, 'pass')
  } finally {
    if (server !== undefined) await stopServer(server)
    Object.assign(prFixture, { repo: '', baseSha: '', headSha: '', beforeArtifact: null })
    rmSync(project, { recursive: true, force: true })
  }
})

test('the publisher writes a failure status for a dirty tree and leaves the workflow exit clean', async () => {
  const project = mkdtempSync(join(tmpdir(), 'cowork-heavy-publish-dirty-'))
  const requests = []
  let server
  try {
    const fixture = await createPublisherFixture(project)
    Object.assign(prFixture, fixture)
    writeFileSync(join(fixture.repo, 'unexpected.txt'), 'dirty\n')
    const started = await startServer(makeHandler({ fixture, requests, mainSha: fixture.baseSha }))
    server = started.server
    const result = await runPublisher({ GITHUB_API_URL: started.baseUrl })
    assert.equal(result.code, 0, result.stderr)
    const body = JSON.parse(readFileSync(fixture.resultPath, 'utf8'))
    assert.equal(body.result, 'fail')
    assert.match(body.reasons.join('\n'), /worktree is dirty/)
    const status = requests.find((request) => request.method === 'POST' && request.path.includes('/statuses/'))
    assert.equal(status.body.context, HEAVY_GATE_CONTEXT)
    assert.equal(status.body.state, 'failure')
  } finally {
    if (server !== undefined) await stopServer(server)
    Object.assign(prFixture, { repo: '', baseSha: '', headSha: '', beforeArtifact: null })
    rmSync(project, { recursive: true, force: true })
  }
})

test('a missing structured display check turns the published status into an error', async () => {
  const project = mkdtempSync(join(tmpdir(), 'cowork-heavy-publish-check-fail-'))
  const requests = []
  let server
  try {
    const fixture = await createPublisherFixture(project)
    Object.assign(prFixture, fixture)
    const started = await startServer(makeHandler({
      fixture,
      requests,
      mainSha: fixture.baseSha,
      failCheck: true,
    }))
    server = started.server
    const result = await runPublisher({ GITHUB_API_URL: started.baseUrl })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /display check not published/)
    const statuses = requests.filter((request) =>
      request.method === 'POST' && request.path.includes('/statuses/'))
    assert.equal(statuses.at(-1).body.state, 'error')
    assert.match(statuses.at(-1).body.description, /publisher failed/)
  } finally {
    if (server !== undefined) await stopServer(server)
    Object.assign(prFixture, { repo: '', baseSha: '', headSha: '', beforeArtifact: null })
    rmSync(project, { recursive: true, force: true })
  }
})

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}
