import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { HEAVY_COMMANDS } from '../../scripts/ci/heavy-contract.mjs'
import {
  binaryDiffSha,
  changedPaths,
  classifyPrDocsOnly,
  decideGate,
  decideLegacyGate,
  findPassingReview,
  findReviewDecision,
  GATE_DISPLAY_CHECK,
  gateStatusDescription,
  isAncestor,
  overlapPaths,
  publishGateCheck,
  publishGateStatus,
  readHeavyResult,
  readHeavyStatus,
  readPreMerge,
  REQUIRED_GATE_CONTEXT,
  requiredGateDecision,
  validateHeavyResult,
  validateReviewedIdentity,
} from '../../scripts/ci/publish-gate.mjs'

const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const diff = 'c'.repeat(64)

function review(overrides = {}) {
  return {
    state: 'COMMENTED',
    commit_id: head,
    submitted_at: '2026-11-17T00:00:00Z',
    body: `<!-- review-verdict:v2 head=${head} base=${base} diffSha=${diff} verdict=pass reviewer=agentteam model=deepseek-v4-pro -->`,
    ...overrides,
  }
}

test('findPassingReview requires a current v2 verdict and respects later change requests', () => {
  assert.equal(findPassingReview([review()], head).verdict.markerVersion, 'v2')
  const v1 = review({
    body: `<!-- review-verdict:v1 head=${head} verdict=pass reviewer=agentteam model=deepseek-v4-pro -->`,
  })
  assert.equal(findPassingReview([v1], head, { requireV2: false }).verdict.markerVersion, 'v1')
  assert.throws(() => findPassingReview([v1], head), /latest review decision is missing/)
  assert.throws(() => findPassingReview([review({ commit_id: 'd'.repeat(40) })], head), /latest review decision is missing/)
  assert.throws(
    () => findPassingReview([
      review(),
      review({ state: 'CHANGES_REQUESTED', submitted_at: '2026-11-17T00:01:00Z', body: '' }),
    ], head),
    /changes_requested/,
  )
  assert.doesNotThrow(() => findPassingReview([
    review(),
    review({ state: 'COMMENTED', submitted_at: '2026-11-17T00:01:00Z', body: 'looks good' }),
  ], head))
})

test('the latest non-pass marker blocks an older pass', () => {
  for (const verdict of ['needs_revision', 'reject']) {
    const blocked = findReviewDecision([
      review(),
      review({
        submitted_at: '2026-11-17T00:01:00Z',
        body: `<!-- review-verdict:v2 head=${head} base=${base} diffSha=${diff} verdict=${verdict} reviewer=agentteam model=deepseek-v4-pro -->`,
      }),
    ], head)
    assert.equal(blocked.status, verdict)
    assert.throws(
      () => findPassingReview([
        review(),
        review({
          submitted_at: '2026-11-17T00:01:00Z',
          body: `<!-- review-verdict:v2 head=${head} base=${base} diffSha=${diff} verdict=${verdict} reviewer=agentteam model=deepseek-v4-pro -->`,
        }),
      ], head),
      new RegExp(`latest review decision is ${verdict}`),
    )
  }
})

test('the required status and display check have distinct fixed names', () => {
  assert.equal(REQUIRED_GATE_CONTEXT, 'gate-artifact')
  assert.equal(GATE_DISPLAY_CHECK, 'gate-artifact-v2')
  assert.notEqual(REQUIRED_GATE_CONTEXT, GATE_DISPLAY_CHECK)
})

test('gateStatusDescription stays short and names the blocking reason', () => {
  assert.equal(gateStatusDescription({ pass: true, reasons: [] }, 'block'), 'block: gate passed')
  const blocked = gateStatusDescription({ pass: false, reasons: ['x'.repeat(200)] }, 'block')
  assert.match(blocked, /^blocked: /)
  assert.equal(blocked.length, 140)
})

test('requiredGateDecision switches the required context by mode', () => {
  const legacy = { pass: false, reasons: ['legacy'] }
  const modern = { pass: true, reasons: [] }
  assert.deepEqual(requiredGateDecision('report', legacy, modern), legacy)
  assert.deepEqual(requiredGateDecision('block', legacy, modern), modern)
})

test('decideLegacyGate keeps the current required review behavior', () => {
  assert.deepEqual(decideLegacyGate({
    reviewError: null,
    prGate: {},
    mainContainsHead: true,
    metadataError: null,
  }), { pass: true, reasons: [] })
  const decision = decideLegacyGate({
    reviewError: 'no review',
    prGate: null,
    mainContainsHead: false,
    metadataError: 'bad title',
  })
  assert.equal(decision.pass, false)
  assert.match(decision.reasons.join('\n'), /no review/)
  assert.match(decision.reasons.join('\n'), /pr-gate/)
  assert.match(decision.reasons.join('\n'), /not an ancestor/)
  assert.match(decision.reasons.join('\n'), /bad title/)
})

test('overlapPaths returns the sorted intersection of reviewed and main paths', () => {
  assert.deepEqual(overlapPaths(['src/b.ts', 'src/a.ts', 'docs/x.md'], ['src/a.ts', 'docs/x.md']), [
    'docs/x.md',
    'src/a.ts',
  ])
  assert.deepEqual(overlapPaths(['src/a.ts'], ['src/b.ts']), [])
})

test('decideGate reports missing or stale inputs', () => {
  assert.deepEqual(decideGate({ prGate: {}, preMerge: { base: 'main' }, currentMain: 'main', heavy: {} }), {
    pass: true,
    reasons: [],
  })
  const decision = decideGate({
    prGate: null,
    preMerge: { base: 'old' },
    currentMain: 'main',
    reviewError: 'no review',
    metadataError: 'bad title',
    diffError: 'bad diff',
    overlap: ['src/a.ts'],
  })
  assert.equal(decision.pass, false)
  assert.match(decision.reasons.join('\n'), /pr-gate/)
  assert.match(decision.reasons.join('\n'), /pre-merge tested base old/)
  assert.match(decision.reasons.join('\n'), /heavy-gate has not succeeded/)
  assert.match(decision.reasons.join('\n'), /delta review required/)
  assert.match(decision.reasons.join('\n'), /merge current main into the PR branch/)
})

test('decideGate rejects a pre-merge result from an older base', () => {
  const decision = decideGate({
    prGate: {},
    preMerge: { base: 'old' },
    currentMain: 'new',
    heavy: {},
  })
  assert.equal(decision.pass, false)
  assert.match(decision.reasons.join('\n'), /pre-merge tested base old/)
})

test('decideGate exempts docs-only changes from heavy and blocks a named heavy failure', () => {
  const common = { prGate: {}, preMerge: { base: 'main' }, currentMain: 'main' }
  assert.deepEqual(decideGate({ ...common, docsOnly: true }), { pass: true, reasons: [] })
  assert.match(
    decideGate({ ...common, docsOnly: false }).reasons.join('\n'),
    /heavy-gate has not succeeded/,
  )
  assert.match(
    decideGate({ ...common, docsOnly: false, heavyError: 'heavy-gate is failure: blocked: dirty' }).reasons.join('\n'),
    /heavy-gate is failure: blocked: dirty/,
  )
  assert.match(
    decideGate({ ...common, docsOnly: true, docsOnlyError: 'could not classify PR paths' }).reasons.join('\n'),
    /could not classify PR paths/,
  )
})

test('readHeavyStatus selects the newest status and names a non-success state', () => {
  const statuses = [
    { context: 'other', state: 'success', created_at: '2026-11-19T00:00:00Z' },
    { context: 'heavy-gate', state: 'failure', description: 'old failure', created_at: '2026-11-19T00:00:00Z' },
    { context: 'heavy-gate', state: 'success', description: 'heavy: passed', created_at: '2026-11-19T01:00:00Z' },
  ]
  assert.equal(readHeavyStatus(statuses, head).value.state, 'success')
  assert.match(
    readHeavyStatus([{ context: 'heavy-gate', state: 'failure', description: 'dirty' }], head).error,
    /heavy-gate is failure: dirty/,
  )
  assert.match(readHeavyStatus([], head).error, /has not been published/)
})

test('readHeavyResult requires a successful check with a JSON object summary', () => {
  const summary = { formatVersion: 1, head, result: 'pass' }
  const checks = [
    { name: 'heavy-gate-result', conclusion: 'failure', completed_at: '2026-11-19T00:00:00Z' },
    {
      name: 'heavy-gate-result',
      conclusion: 'success',
      completed_at: '2026-11-19T01:00:00Z',
      output: { summary: JSON.stringify(summary) },
    },
  ]
  assert.deepEqual(readHeavyResult(checks, head).value, summary)
  assert.match(
    readHeavyResult([{ name: 'heavy-gate-result', conclusion: 'failure' }], head).error,
    /conclusion is failure/,
  )
  assert.match(
    readHeavyResult([{ name: 'heavy-gate-result', conclusion: 'success', output: { summary: 'not json' } }], head).error,
    /not valid JSON/,
  )
  assert.match(
    readHeavyResult([{ name: 'heavy-gate-result', conclusion: 'success', output: { summary: '[]' } }], head).error,
    /must be a JSON object/,
  )
})

test('validateHeavyResult binds head, base ancestry, clean state, commands, and diff', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cowork-heavy-gate-'))
  try {
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.name', 'test'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    await writeFile(join(repo, 'base.txt'), 'base\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'base'])
    const baseSha = git(repo, ['rev-parse', 'HEAD']).trim()
    await writeFile(join(repo, 'main.txt'), 'main\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'main'])
    const mainSha = git(repo, ['rev-parse', 'HEAD']).trim()
    git(repo, ['checkout', '-qb', 'head', baseSha])
    await writeFile(join(repo, 'head.txt'), 'head\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'head'])
    const headSha = git(repo, ['rev-parse', 'HEAD']).trim()
    const diffSha = binaryDiffSha(repo, baseSha, headSha)
    git(repo, ['remote', 'add', 'origin', repo])
    const result = {
      formatVersion: 1,
      head: headSha,
      base: baseSha,
      currentMain: mainSha,
      diffSha256: diffSha,
      clean: true,
      porcelain: [],
      commands: HEAVY_COMMANDS.map((command) => ({
        ...command,
        exitCode: command.name === 'e2e-bash' ? 1 : 0,
      })),
      reasons: [],
      result: 'pass',
    }
    const status = { context: 'heavy-gate', state: 'success' }
    assert.equal(validateHeavyResult({ cwd: repo, head: headSha, currentMain: mainSha, status, result }).value, result)

    assert.match(validateHeavyResult({
      cwd: repo,
      head: headSha,
      currentMain: mainSha,
      status,
      result: { ...result, diffSha256: 'd'.repeat(64) },
    }).error, /does not match current authored diff/)
    assert.match(validateHeavyResult({
      cwd: repo,
      head: headSha,
      currentMain: mainSha,
      status,
      result: { ...result, clean: false, porcelain: ['?? dirty.txt'] },
    }).error, /dirty worktree/)
    assert.match(validateHeavyResult({
      cwd: repo,
      head: headSha,
      currentMain: mainSha,
      status,
      result: { ...result, base: headSha, diffSha256: binaryDiffSha(repo, headSha, headSha) },
    }).error, /not an ancestor of current main/)
    assert.match(validateHeavyResult({
      cwd: repo,
      head: headSha,
      currentMain: mainSha,
      status,
      result: {
        ...result,
        commands: result.commands.map((command) => command.name === 'typecheck'
          ? { ...command, exitCode: 1 }
          : command),
      },
    }).error, /blocking heavy command typecheck is missing or did not pass/)
    assert.match(validateHeavyResult({
      cwd: repo,
      head: headSha,
      currentMain: mainSha,
      status,
      result: { ...result, commands: result.commands.filter((command) => command.name !== 'build') },
    }).error, /blocking heavy command build is missing or did not pass/)
    assert.match(validateHeavyResult({
      cwd: repo,
      head: headSha,
      currentMain: mainSha,
      status: { context: 'heavy-gate', state: 'failure' },
      result,
    }).error, /state is failure/)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('docs-only classification follows the shared path classifier at the merge base', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cowork-gate-docs-'))
  try {
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.name', 'test'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    await writeFile(join(repo, 'src.txt'), 'base\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'base'])
    const baseSha = git(repo, ['rev-parse', 'HEAD']).trim()
    await writeFile(join(repo, 'src.txt'), 'main\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'main'])
    const mainSha = git(repo, ['rev-parse', 'HEAD']).trim()
    git(repo, ['checkout', '-qb', 'docs', baseSha])
    await writeFile(join(repo, 'README.md'), 'docs\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'docs'])
    const docsHead = git(repo, ['rev-parse', 'HEAD']).trim()
    assert.equal(classifyPrDocsOnly({
      cwd: repo,
      head: docsHead,
      currentMain: mainSha,
      ensure: () => {},
    }).docsOnly, true)

    git(repo, ['checkout', '-qb', 'source', baseSha])
    await writeFile(join(repo, 'src.txt'), 'head\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'source'])
    const sourceHead = git(repo, ['rev-parse', 'HEAD']).trim()
    assert.equal(classifyPrDocsOnly({
      cwd: repo,
      head: sourceHead,
      currentMain: mainSha,
      ensure: () => {},
    }).docsOnly, false)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('git identity helpers bind the reviewed diff and ancestry', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cowork-gate-identity-'))
  try {
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.name', 'test'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    await writeFile(join(repo, 'a.txt'), 'base\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'base'])
    const baseCommit = git(repo, ['rev-parse', 'HEAD']).trim()
    await writeFile(join(repo, 'a.txt'), 'head\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'head'])
    const headCommit = git(repo, ['rev-parse', 'HEAD']).trim()
    const first = binaryDiffSha(repo, baseCommit, headCommit)
    assert.match(first, /^[0-9a-f]{64}$/)
    assert.deepEqual(changedPaths(repo, baseCommit, headCommit), ['a.txt'])
    assert.equal(isAncestor(repo, baseCommit, headCommit), true)
    assert.equal(isAncestor(repo, headCommit, baseCommit), false)

    await writeFile(join(repo, 'a.txt'), 'head two\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'head two'])
    const secondCommit = git(repo, ['rev-parse', 'HEAD']).trim()
    assert.notEqual(binaryDiffSha(repo, baseCommit, secondCommit), first)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('validateReviewedIdentity rejects wrong diffs, non-ancestor bases, and reports overlap', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cowork-gate-review-'))
  try {
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.name', 'test'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    await writeFile(join(repo, 'a.txt'), 'base\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'base'])
    const baseCommit = git(repo, ['rev-parse', 'HEAD']).trim()

    await writeFile(join(repo, 'a.txt'), 'main\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'main'])
    const mainCommit = git(repo, ['rev-parse', 'HEAD']).trim()

    git(repo, ['checkout', '-qb', 'head', baseCommit])
    await writeFile(join(repo, 'a.txt'), 'head\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'head'])
    const headCommit = git(repo, ['rev-parse', 'HEAD']).trim()
    const diffSha = binaryDiffSha(repo, baseCommit, headCommit)
    const review = { baseSha: baseCommit, diffSha }

    const valid = validateReviewedIdentity({
      cwd: repo,
      head: headCommit,
      currentMain: mainCommit,
      review,
      ensure: () => {},
    })
    assert.equal(valid.mainContainsHead, false)
    assert.equal(valid.diffError, null)
    assert.deepEqual(valid.overlap, ['a.txt'])

    const wrongDiff = validateReviewedIdentity({
      cwd: repo,
      head: headCommit,
      currentMain: mainCommit,
      review: { ...review, diffSha: '0'.repeat(64) },
      ensure: () => {},
    })
    assert.match(wrongDiff.diffError, /does not match current authored diff/)

    const nonAncestor = validateReviewedIdentity({
      cwd: repo,
      head: headCommit,
      currentMain: mainCommit,
      review: { ...review, baseSha: mainCommit },
      ensure: () => {},
    })
    assert.match(nonAncestor.diffError, /not an ancestor of the PR head/)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('main-side renames still overlap the reviewed path', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cowork-gate-rename-'))
  try {
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.name', 'test'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    await writeFile(join(repo, 'old.txt'), 'base\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'base'])
    const baseCommit = git(repo, ['rev-parse', 'HEAD']).trim()

    git(repo, ['mv', 'old.txt', 'new.txt'])
    git(repo, ['commit', '-qm', 'rename'])
    const mainCommit = git(repo, ['rev-parse', 'HEAD']).trim()

    git(repo, ['checkout', '-qb', 'head', baseCommit])
    await writeFile(join(repo, 'old.txt'), 'head\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'head'])
    const headCommit = git(repo, ['rev-parse', 'HEAD']).trim()
    const diffSha = binaryDiffSha(repo, baseCommit, headCommit)

    const identity = validateReviewedIdentity({
      cwd: repo,
      head: headCommit,
      currentMain: mainCommit,
      review: { baseSha: baseCommit, diffSha },
      ensure: () => {},
    })
    assert.equal(identity.diffError, null)
    assert.ok(identity.overlap.includes('old.txt'), JSON.stringify(identity.overlap))
    assert.deepEqual(changedPaths(repo, baseCommit, mainCommit).sort(), ['new.txt', 'old.txt'])
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('readPreMerge rejects malformed or stale summaries', () => {
  const head = 'a'.repeat(40)
  assert.deepEqual(readPreMerge([], head), { value: null, error: null })
  assert.match(readPreMerge([{ name: 'pre-merge', conclusion: 'success', output: { summary: 'not json' } }], head).error, /not valid JSON/)
  assert.match(readPreMerge([{
    name: 'pre-merge',
    conclusion: 'success',
    output: { summary: JSON.stringify({ head, base: 'old', result: 'success', staleBase: true }) },
  }], head).error, /older base/)
  assert.match(readPreMerge([{
    name: 'pre-merge',
    conclusion: 'failure',
    completed_at: '2026-11-17T00:02:00Z',
    output: { summary: JSON.stringify({ head, base: 'main', result: 'success' }) },
  }], head).error, /conclusion is failure/)
})

test('the publisher job stays green when the required status carries a blocked decision', () => {
  // The commit status carries the blocked verdict, so the publisher job does
  // not need to fail a second time; only unexpected errors use exit code 1.
  const source = readFileSync(new URL('../../scripts/ci/publish-gate.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /if \(!required\.pass\) process\.exitCode = 1/)
  assert.match(source, /publishGateStatus/)
  assert.match(source, /state: finalRequired\.pass \? 'success' : 'failure'/)
})

test('publishGateStatus writes the required commit status on the head', async () => {
  const requests = []
  const detailsUrl = 'https://github.com/owner/repo/actions/runs/1'
  const result = await publishGateStatus({
    token: 'token',
    repository: 'owner/repo',
    apiUrl: 'https://api.example',
    head,
    state: 'failure',
    description: 'blocked: pre-merge missing',
    detailsUrl,
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) })
      return { ok: true }
    },
  })
  assert.deepEqual(result, { context: 'gate-artifact', state: 'failure' })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, `https://api.example/repos/owner/repo/statuses/${head}`)
  assert.deepEqual(requests[0].body, {
    state: 'failure',
    context: 'gate-artifact',
    description: 'blocked: pre-merge missing',
    target_url: detailsUrl,
  })
})

test('publishGateCheck sends one completed display check run', async () => {
  const requests = []
  const result = await publishGateCheck({
    token: 'token',
    repository: 'owner/repo',
    apiUrl: 'https://api.example',
    head,
    name: 'gate-artifact-v2',
    conclusion: 'success',
    title: 'gate-artifact: pass',
    summary: '{}',
    detailsUrl: 'https://github.com/owner/repo/actions/runs/1',
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) })
      return { ok: true, json: async () => ({ id: 7 }) }
    },
  })
  assert.deepEqual(result, { id: 7, conclusion: 'success' })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].body.name, 'gate-artifact-v2')
  assert.equal(requests[0].body.head_sha, head)
  assert.equal(requests[0].body.output.title, 'gate-artifact: pass')
})

test('the publisher main path writes pending then success and mirrors the display check', async () => {
  const fixture = await createGateFixture()
  const requests = []
  const { server, baseUrl } = await startGateServer(makeGateHandler({
    requests,
    fixture,
    mainShas: [fixture.mainSha, fixture.mainSha],
  }))
  try {
    const result = await runPublisher({
      GITHUB_API_URL: baseUrl,
      GATE_WORKSPACE: fixture.repo,
      POLICY_MODE: 'block',
    })
    assert.equal(result.code, 0, result.stderr)
    const statuses = requests.filter((request) =>
      request.method === 'POST' && request.path.startsWith('/repos/owner/repo/statuses/'))
    assert.equal(statuses.length, 2)
    assert.equal(statuses[0].body.state, 'pending')
    assert.equal(statuses[1].body.state, 'success')
    assert.match(statuses[1].body.description, /gate passed/)
    const display = requests.find((request) =>
      request.method === 'POST' && request.path === '/repos/owner/repo/check-runs')
    assert.equal(display.body.name, 'gate-artifact-v2')
    assert.equal(display.body.conclusion, 'success')
  } finally {
    await stopGateServer(server)
    await rm(fixture.repo, { recursive: true, force: true })
  }
})

test('a non-docs PR is blocked when heavy-gate is missing', async () => {
  const fixture = await createGateFixture()
  const requests = []
  const { server, baseUrl } = await startGateServer(makeGateHandler({
    requests,
    fixture,
    mainShas: [fixture.mainSha, fixture.mainSha],
    heavyStatus: null,
  }))
  try {
    const result = await runPublisher({
      GITHUB_API_URL: baseUrl,
      GATE_WORKSPACE: fixture.repo,
      POLICY_MODE: 'block',
    })
    assert.equal(result.code, 0, result.stderr)
    const statuses = requests.filter((request) =>
      request.method === 'POST' && request.path.startsWith('/repos/owner/repo/statuses/'))
    assert.equal(statuses.length, 2)
    assert.equal(statuses[1].body.state, 'failure')
    assert.match(statuses[1].body.description, /heavy-gate has not been published/)
    const display = requests.find((request) =>
      request.method === 'POST' && request.path === '/repos/owner/repo/check-runs')
    assert.equal(display.body.conclusion, 'action_required')
  } finally {
    await stopGateServer(server)
    await rm(fixture.repo, { recursive: true, force: true })
  }
})

test('a docs-only PR passes without heavy-gate', async () => {
  const fixture = await createGateFixture({ headFile: 'README.md' })
  const requests = []
  const { server, baseUrl } = await startGateServer(makeGateHandler({
    requests,
    fixture,
    mainShas: [fixture.mainSha, fixture.mainSha],
    heavyStatus: null,
  }))
  try {
    const result = await runPublisher({
      GITHUB_API_URL: baseUrl,
      GATE_WORKSPACE: fixture.repo,
      POLICY_MODE: 'block',
    })
    assert.equal(result.code, 0, result.stderr)
    const statuses = requests.filter((request) =>
      request.method === 'POST' && request.path.startsWith('/repos/owner/repo/statuses/'))
    assert.equal(statuses.length, 2)
    assert.equal(statuses[1].body.state, 'success')
    assert.match(statuses[1].body.description, /gate passed/)
    const display = requests.find((request) =>
      request.method === 'POST' && request.path === '/repos/owner/repo/check-runs')
    assert.equal(display.body.conclusion, 'success')
    assert.equal(JSON.parse(display.body.output.summary).docsOnly, true)
  } finally {
    await stopGateServer(server)
    await rm(fixture.repo, { recursive: true, force: true })
  }
})

test('a failed final status write publishes error and exits non-zero', async () => {
  const fixture = await createGateFixture()
  const requests = []
  const { server, baseUrl } = await startGateServer(makeGateHandler({
    requests,
    fixture,
    mainShas: [fixture.mainSha, fixture.mainSha],
    failStatusAt: 2,
  }))
  try {
    const result = await runPublisher({
      GITHUB_API_URL: baseUrl,
      GATE_WORKSPACE: fixture.repo,
      POLICY_MODE: 'block',
    })
    assert.equal(result.code, 1)
    const statuses = requests.filter((request) =>
      request.method === 'POST' && request.path.startsWith('/repos/owner/repo/statuses/'))
    assert.equal(statuses.length, 3)
    assert.equal(statuses[1].body.state, 'success')
    assert.equal(statuses[2].body.state, 'error')
    assert.match(result.stderr, /publishing gate-artifact status failed/)
  } finally {
    await stopGateServer(server)
    await rm(fixture.repo, { recursive: true, force: true })
  }
})

test('a main advance during evaluation turns the final status into a failure', async () => {
  const fixture = await createGateFixture()
  const requests = []
  const { server, baseUrl } = await startGateServer(makeGateHandler({
    requests,
    fixture,
    mainShas: [fixture.mainSha, 'f'.repeat(40)],
  }))
  try {
    const result = await runPublisher({
      GITHUB_API_URL: baseUrl,
      GATE_WORKSPACE: fixture.repo,
      POLICY_MODE: 'block',
    })
    assert.equal(result.code, 0, result.stderr)
    const statuses = requests.filter((request) =>
      request.method === 'POST' && request.path.startsWith('/repos/owner/repo/statuses/'))
    assert.equal(statuses.length, 2)
    assert.equal(statuses[1].body.state, 'failure')
    assert.match(statuses[1].body.description, /main advanced during gate evaluation/)
    const display = requests.find((request) =>
      request.method === 'POST' && request.path === '/repos/owner/repo/check-runs')
    assert.equal(display.body.conclusion, 'action_required')
  } finally {
    await stopGateServer(server)
    await rm(fixture.repo, { recursive: true, force: true })
  }
})

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const prBody = '## Motivation\nx\n\n## Changes\nx\n\n## Testing\nx\n\n## Evidence\nx\n'

async function createGateFixture({ headFile = 'head.txt' } = {}) {
  const repo = await mkdtemp(join(tmpdir(), 'cowork-gate-run-'))
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.name', 'test'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  await writeFile(join(repo, 'base.txt'), 'base\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-qm', 'base'])
  const baseSha = git(repo, ['rev-parse', 'HEAD']).trim()

  await writeFile(join(repo, 'main.txt'), 'main\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-qm', 'main'])
  const mainSha = git(repo, ['rev-parse', 'HEAD']).trim()

  git(repo, ['checkout', '-qb', 'head', baseSha])
  await writeFile(join(repo, headFile), 'head\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-qm', 'head'])
  const headSha = git(repo, ['rev-parse', 'HEAD']).trim()
  git(repo, ['remote', 'add', 'origin', repo])
  const diffSha = binaryDiffSha(repo, baseSha, headSha)
  const heavyResult = {
    formatVersion: 1,
    head: headSha,
    base: baseSha,
    currentMain: mainSha,
    diffSha256: diffSha,
    porcelain: [],
    clean: true,
    baseIsAncestor: true,
    commands: HEAVY_COMMANDS.map((command) => ({ ...command, exitCode: 0 })),
    result: 'pass',
    reasons: [],
  }
  return { repo, baseSha, mainSha, headSha, diffSha, heavyResult }
}

function makeGateHandler({ requests, fixture, mainShas, failStatusAt = 0, heavyStatus = 'success' }) {
  let mainIndex = 0
  let statusCount = 0
  return async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = raw === '' ? undefined : JSON.parse(raw)
    requests.push({ method: request.method, path: url.pathname, search: url.search, body })
    const json = (value, status = 200) => {
      response.statusCode = status
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(value))
    }
    if (request.method === 'GET' && url.pathname === '/repos/owner/repo/git/ref/heads/main') {
      const sha = mainShas[Math.min(mainIndex, mainShas.length - 1)]
      mainIndex += 1
      return json({ object: { sha } })
    }
    if (request.method === 'GET' && url.pathname === '/repos/owner/repo/pulls/1') {
      return json({ head: { sha: fixture.headSha }, title: 'ci(test): gate', body: prBody })
    }
    if (request.method === 'GET' && url.pathname === '/repos/owner/repo/pulls/1/reviews') {
      return json([{
        state: 'COMMENTED',
        commit_id: fixture.headSha,
        submitted_at: '2026-11-19T00:00:00Z',
        body: `<!-- review-verdict:v2 head=${fixture.headSha} base=${fixture.baseSha} diffSha=${fixture.diffSha} verdict=pass reviewer=agentteam model=test -->`,
      }])
    }
    if (request.method === 'GET' && url.pathname === `/repos/owner/repo/commits/${fixture.headSha}/check-runs`) {
      return json({
        check_runs: [
          { name: 'pr-gate', conclusion: 'success' },
          {
            name: 'pre-merge',
            conclusion: 'success',
            completed_at: '2026-11-19T00:00:00Z',
            output: { summary: JSON.stringify({ head: fixture.headSha, base: fixture.mainSha, result: 'success' }) },
          },
          {
            name: 'heavy-gate-result',
            conclusion: heavyStatus === 'success' ? 'success' : 'failure',
            completed_at: '2026-11-19T00:00:00Z',
            output: { summary: JSON.stringify(fixture.heavyResult) },
          },
        ],
      })
    }
    if (request.method === 'GET' && url.pathname === `/repos/owner/repo/commits/${fixture.headSha}/statuses`) {
      return json(heavyStatus === null ? [] : [{
        context: 'heavy-gate',
        state: heavyStatus,
        description: heavyStatus === 'success' ? 'heavy: passed' : 'blocked: dirty worktree',
        created_at: '2026-11-19T00:00:00Z',
      }])
    }
    if (request.method === 'POST' && url.pathname === `/repos/owner/repo/statuses/${fixture.headSha}`) {
      statusCount += 1
      if (statusCount === failStatusAt) return json({ message: 'forbidden' }, 403)
      return json({ state: body.state })
    }
    if (request.method === 'POST' && url.pathname === '/repos/owner/repo/check-runs') {
      return json({ id: 7 })
    }
    return json({ error: `${request.method} ${url.pathname}` }, 404)
  }
}

async function startGateServer(handler) {
  const server = createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` }
}

async function stopGateServer(server) {
  await new Promise((resolve) => server.close(resolve))
}

function runPublisher(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/ci/publish-gate.mjs'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GH_TOKEN: 'token',
        GITHUB_REPOSITORY: 'owner/repo',
        PR_NUMBER: '1',
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
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}
