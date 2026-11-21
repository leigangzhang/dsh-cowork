import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  HEAVY_SUMMARY_MARKER,
  formatHeavySummary,
  publishHeavyComment,
} from '../../scripts/ci/publish-heavy-comment.mjs'

const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const currentMain = 'c'.repeat(40)
const diffSha256 = 'd'.repeat(64)
const runUrl = 'https://github.com/owner/repo/actions/runs/7'

function summary(overrides = {}) {
  return {
    formatVersion: 1,
    head,
    base,
    currentMain,
    diffSha256,
    porcelain: [],
    clean: true,
    commands: [
      { name: 'typecheck', command: 'npm run typecheck', blocking: true, exitCode: 0 },
      { name: 'e2e-bash', command: 'npm run test:e2e:bash', blocking: false, exitCode: 1 },
    ],
    result: 'pass',
    reasons: [],
    ...overrides,
  }
}

function status(state = 'success') {
  return {
    context: 'heavy-gate',
    state,
    description: state === 'success' ? 'heavy: passed' : 'heavy: blocked',
    created_at: '2026-11-21T00:00:00Z',
  }
}

function check(summaryValue = summary(), conclusion = 'success') {
  return {
    name: 'heavy-gate-result',
    conclusion,
    completed_at: '2026-11-21T00:00:00Z',
    output: { summary: JSON.stringify(summaryValue) },
  }
}

function json(response, value, statusCode = 200) {
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(value))
}

async function fixtureServer({ prs = [], statuses = [], checks = [], comments = [] } = {}) {
  const requests = []
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = raw === '' ? undefined : JSON.parse(raw)
    requests.push({ method: request.method, path: url.pathname, body })
    if (request.method === 'GET' && url.pathname === `/repos/owner/repo/commits/${head}/pulls`) {
      return json(response, prs)
    }
    if (request.method === 'GET' && url.pathname === `/repos/owner/repo/commits/${head}/statuses`) {
      return json(response, statuses)
    }
    if (request.method === 'GET' && url.pathname === `/repos/owner/repo/commits/${head}/check-runs`) {
      return json(response, { total_count: checks.length, check_runs: checks })
    }
    if (request.method === 'GET' && url.pathname === '/repos/owner/repo/issues/7/comments') {
      const pages = Array.isArray(comments[0]) ? comments : [comments]
      const page = Number(url.searchParams.get('page') ?? '1')
      return json(response, pages[page - 1] ?? [])
    }
    if (request.method === 'POST' && url.pathname === '/repos/owner/repo/issues/7/comments') {
      return json(response, { id: 100, body: body.body })
    }
    if (request.method === 'PATCH' && url.pathname === '/repos/owner/repo/issues/comments/99') {
      return json(response, { id: 99, body: body.body })
    }
    return json(response, { error: `${request.method} ${url.pathname}` }, 404)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function config(server, overrides = {}) {
  return {
    token: 'test-token',
    repository: 'owner/repo',
    head,
    runUrl,
    conclusion: 'success',
    apiUrl: server.url,
    ...overrides,
  }
}

test('the heavy comment creates one marked summary with identity and command exits', async () => {
  const server = await fixtureServer({
    prs: [{ number: 7, state: 'open', head: { sha: head } }],
    statuses: [status()],
    checks: [check()],
  })
  try {
    const outcome = await publishHeavyComment(config(server))
    assert.deepEqual(outcome, { action: 'created', prNumber: 7 })
    const post = server.requests.find((request) => request.method === 'POST')
    assert.ok(post !== undefined)
    assert.ok(post.body.body.includes(HEAVY_SUMMARY_MARKER))
    assert.ok(post.body.body.includes(head))
    assert.ok(post.body.body.includes(base))
    assert.ok(post.body.body.includes(diffSha256))
    assert.ok(post.body.body.includes('typecheck'))
    assert.ok(post.body.body.includes('e2e-bash'))
    assert.ok(post.body.body.includes(runUrl))
  } finally {
    await server.close()
  }
})

test('the heavy comment updates the existing marked comment instead of adding another', async () => {
  const server = await fixtureServer({
    prs: [{ number: 7, state: 'open', head: { sha: head } }],
    statuses: [status()],
    checks: [check()],
    comments: [{ id: 99, body: `${HEAVY_SUMMARY_MARKER}\nold summary` }],
  })
  try {
    const outcome = await publishHeavyComment(config(server))
    assert.deepEqual(outcome, { action: 'updated', prNumber: 7 })
    assert.equal(server.requests.filter((request) => request.method === 'POST').length, 0)
    const patch = server.requests.find((request) => request.method === 'PATCH')
    assert.ok(patch !== undefined)
    assert.ok(patch.body.body.includes('typecheck'))
  } finally {
    await server.close()
  }
})

test('the heavy comment skips a run with no open pull request', async () => {
  const server = await fixtureServer({ prs: [] })
  try {
    const outcome = await publishHeavyComment(config(server))
    assert.deepEqual(outcome, { skipped: 'no-open-pr' })
    assert.equal(server.requests.filter((request) => request.path.includes('/issues/')).length, 0)
  } finally {
    await server.close()
  }
})

test('a failed heavy run without a result still posts a failure summary', async () => {
  const server = await fixtureServer({
    prs: [{ number: 7, state: 'open', head: { sha: head } }],
    statuses: [],
    checks: [],
  })
  try {
    const outcome = await publishHeavyComment(config(server, { conclusion: 'failure' }))
    assert.deepEqual(outcome, { action: 'created', prNumber: 7 })
    const post = server.requests.find((request) => request.method === 'POST')
    assert.ok(post !== undefined)
    assert.ok(post.body.body.includes('Heavy lane: failed'))
    assert.ok(post.body.body.includes(runUrl))
  } finally {
    await server.close()
  }
})

test('a blocked heavy run with failure status and check still posts a summary', async () => {
  const server = await fixtureServer({
    prs: [{ number: 7, state: 'open', head: { sha: head } }],
    statuses: [status('failure')],
    checks: [check(summary({ result: 'fail', reasons: ['blocking command failed'] }), 'failure')],
  })
  try {
    const outcome = await publishHeavyComment(config(server))
    assert.deepEqual(outcome, { action: 'created', prNumber: 7 })
    const post = server.requests.find((request) => request.method === 'POST')
    assert.ok(post !== undefined)
    assert.ok(post.body.body.includes('Status problem:'))
    assert.ok(post.body.body.includes('Result problem:'))
  } finally {
    await server.close()
  }
})

test('the heavy comment finds a marker beyond the first hundred comments', async () => {
  const pageOne = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: `comment ${String(index)}` }))
  const server = await fixtureServer({
    prs: [{ number: 7, state: 'open', head: { sha: head } }],
    statuses: [status()],
    checks: [check()],
    comments: [pageOne, [{ id: 99, body: `${HEAVY_SUMMARY_MARKER}\nexisting` }]],
  })
  try {
    const outcome = await publishHeavyComment(config(server))
    assert.deepEqual(outcome, { action: 'updated', prNumber: 7 })
    assert.equal(server.requests.filter((request) => request.method === 'POST').length, 0)
    const pages = server.requests.filter((request) => request.path.endsWith('/issues/7/comments'))
    assert.equal(pages.length, 2)
  } finally {
    await server.close()
  }
})

test('a successful docs-only run with no heavy result is skipped', async () => {
  const server = await fixtureServer({
    prs: [{ number: 7, state: 'open', head: { sha: head } }],
    statuses: [],
    checks: [],
  })
  try {
    const outcome = await publishHeavyComment(config(server))
    assert.deepEqual(outcome, { skipped: 'no-heavy-result' })
    assert.equal(server.requests.filter((request) => request.method === 'POST').length, 0)
  } finally {
    await server.close()
  }
})

test('the summary keeps a failed status and reasons readable without a result', () => {
  const body = formatHeavySummary({
    head,
    conclusion: 'failure',
    runUrl,
    status: null,
    result: null,
    statusError: 'heavy-gate is failure: blocked: dirty worktree',
    resultError: 'heavy-gate-result has not been published',
  })
  assert.match(body, /^<!-- heavy-gate-summary -->/m)
  assert.match(body, /Heavy lane: failed/)
  assert.match(body, /dirty worktree/)
  assert.match(body, /workflow logs/)
})
