import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveHeavyPullRequest, runResolver } from '../../scripts/ci/resolve-heavy-pr.mjs'

const runUrl = 'https://github.com/owner/repo/actions/runs/7'
const otherRunUrl = 'https://github.com/owner/repo/actions/runs/8'
const mainHead = 'a'.repeat(40)
const testedHead = 'b'.repeat(40)
const otherHead = 'c'.repeat(40)
const mainBranch = 'main'

function pull(number, sha, { repo = 'owner/repo', state = 'open' } = {}) {
  return { number, state, head: { sha, repo: { full_name: repo } } }
}

function status(targetUrl, context = 'heavy-gate') {
  return { context, state: 'success', target_url: targetUrl }
}

function json(response, value, statusCode = 200) {
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(value))
}

async function fixtureServer({ commitPulls = [], openPrPages = [[]], statusesByHead = {} } = {}) {
  const requests = []
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    requests.push({ method: request.method, path: url.pathname, search: url.search })
    if (/^\/repos\/owner\/repo\/commits\/[0-9a-f]{40}\/pulls$/.test(url.pathname)) {
      return json(response, commitPulls)
    }
    if (url.pathname === '/repos/owner/repo/pulls') {
      const page = Number(url.searchParams.get('page') ?? '1')
      return json(response, openPrPages[page - 1] ?? [])
    }
    const statusesMatch = url.pathname.match(/^\/repos\/owner\/repo\/commits\/([0-9a-f]{40})\/statuses$/)
    if (statusesMatch !== null) return json(response, statusesByHead[statusesMatch[1]] ?? [])
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
    apiUrl: server.url,
    head: mainHead,
    headBranch: mainBranch,
    defaultBranch: mainBranch,
    runUrl,
    ...overrides,
  }
}

function hex(value) {
  return value.toString(16).padStart(40, '0')
}

test('a branch run resolves the open pull request whose head matches the run head', async () => {
  const server = await fixtureServer({ commitPulls: [pull(7, testedHead)] })
  try {
    const resolved = await resolveHeavyPullRequest(config(server, {
      head: testedHead,
      headBranch: 'agent/topic',
    }))
    assert.deepEqual(resolved, { number: 7, head: testedHead })
    assert.equal(server.requests.some((request) => request.path === '/repos/owner/repo/pulls'), false)
  } finally {
    await server.close()
  }
})

test('a default-branch run resolves through the heavy status published on the tested head', async () => {
  const server = await fixtureServer({
    openPrPages: [[pull(74, testedHead), pull(75, otherHead)]],
    statusesByHead: {
      [testedHead]: [status(`${runUrl}/`)],
      [otherHead]: [status(otherRunUrl)],
    },
  })
  try {
    const resolved = await resolveHeavyPullRequest(config(server))
    assert.deepEqual(resolved, { number: 74, head: testedHead })
    assert.equal(
      server.requests.some((request) => request.path === `/repos/owner/repo/commits/${mainHead}/pulls`),
      false,
      'the default-branch run head must not be treated as a pull-request head',
    )
    assert.equal(server.requests.filter((request) => request.path.endsWith('/statuses')).length, 2)
  } finally {
    await server.close()
  }
})

test('a run with no status match resolves to no pull request', async () => {
  const server = await fixtureServer({
    openPrPages: [[pull(74, testedHead)]],
    statusesByHead: {
      [testedHead]: [status(otherRunUrl), status(runUrl, 'other-context')],
    },
  })
  try {
    assert.equal(await resolveHeavyPullRequest(config(server)), null)
  } finally {
    await server.close()
  }
})

test('multiple open pull requests carrying the same heavy run fail closed', async () => {
  const server = await fixtureServer({
    openPrPages: [[pull(74, testedHead), pull(75, otherHead)]],
    statusesByHead: {
      [testedHead]: [status(runUrl)],
      [otherHead]: [status(runUrl)],
    },
  })
  try {
    await assert.rejects(
      resolveHeavyPullRequest(config(server)),
      /found 2 open pull requests carrying heavy run/,
    )
  } finally {
    await server.close()
  }
})

test('fork pull requests are ignored without a status request', async () => {
  const server = await fixtureServer({
    openPrPages: [[pull(74, testedHead, { repo: 'someone/fork' })]],
    statusesByHead: { [testedHead]: [status(runUrl)] },
  })
  try {
    assert.equal(await resolveHeavyPullRequest(config(server)), null)
    assert.equal(server.requests.some((request) => request.path.endsWith('/statuses')), false)
  } finally {
    await server.close()
  }
})

test('the open pull request scan pages until it finds the matching head', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    pull(index + 1, hex(index + 1), { repo: 'someone/fork' }))
  const server = await fixtureServer({
    openPrPages: [firstPage, [pull(74, testedHead)]],
    statusesByHead: { [testedHead]: [status(runUrl)] },
  })
  try {
    const resolved = await resolveHeavyPullRequest(config(server))
    assert.deepEqual(resolved, { number: 74, head: testedHead })
    assert.equal(server.requests.filter((request) => request.path === '/repos/owner/repo/pulls').length, 2)
  } finally {
    await server.close()
  }
})

test('the resolver writes the resolved number and head to the Actions output', async () => {
  const server = await fixtureServer({
    openPrPages: [[pull(74, testedHead)]],
    statusesByHead: { [testedHead]: [status(runUrl)] },
  })
  const directory = await mkdtemp(join(tmpdir(), 'cowork-resolve-heavy-'))
  try {
    const outputFile = join(directory, 'github-output')
    const resolved = await runResolver(['--github-output'], {
      env: {
        GH_TOKEN: 'test-token',
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_API_URL: server.url,
        HEAVY_RUN_HEAD: mainHead,
        HEAVY_RUN_BRANCH: mainBranch,
        DEFAULT_BRANCH: mainBranch,
        HEAVY_RUN_URL: runUrl,
      },
      outputFile,
    })
    assert.deepEqual(resolved, { number: 74, head: testedHead })
    assert.equal(await readFile(outputFile, 'utf8'), `number=74\nhead=${testedHead}\n`)
  } finally {
    await rm(directory, { recursive: true, force: true })
    await server.close()
  }
})

test('the resolver writes empty outputs when no pull request resolves', async () => {
  const server = await fixtureServer({ openPrPages: [[]] })
  const directory = await mkdtemp(join(tmpdir(), 'cowork-resolve-heavy-'))
  try {
    const outputFile = join(directory, 'github-output')
    const resolved = await runResolver(['--github-output'], {
      env: {
        GH_TOKEN: 'test-token',
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_API_URL: server.url,
        HEAVY_RUN_HEAD: mainHead,
        HEAVY_RUN_BRANCH: mainBranch,
        DEFAULT_BRANCH: mainBranch,
        HEAVY_RUN_URL: runUrl,
      },
      outputFile,
    })
    assert.equal(resolved, null)
    assert.equal(await readFile(outputFile, 'utf8'), 'number=\nhead=\n')
  } finally {
    await rm(directory, { recursive: true, force: true })
    await server.close()
  }
})
