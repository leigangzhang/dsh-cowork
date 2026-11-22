#!/usr/bin/env node
/**
 * Resolve the open pull request and tested head for one completed Heavy run.
 *
 * Heavy is triggered by `workflow_run`, so GitHub executes it on the default
 * branch and records the run against that branch. The Heavy run's own
 * `head_sha` is then main's tip, not the pull-request head, and the comment
 * workflow cannot resolve a pull request from it. Heavy already publishes the
 * real head: the `heavy-gate` commit status is written on the tested head with
 * the Heavy run URL as its target URL. This resolver first accepts a run head
 * that directly matches one open pull request (label and branch dispatch),
 * then matches one open pull request whose head carries this run's `heavy-gate`
 * status.
 *
 * The resolver only reads from the GitHub API; it never writes a status,
 * check, or comment.
 */
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { githubHeaders, readGithubResponse } from './github-response.mjs'
import { HEAVY_GATE_CONTEXT } from './heavy-contract.mjs'

const COMMIT_SHA = /^[0-9a-f]{40}$/
const API_TIMEOUT_MS = 15_000
const PER_PAGE = 100
const OPEN_PR_PAGE_LIMIT = 10

function api(input, path) {
  return (input.fetchImpl ?? fetch)(`${input.apiUrl}${path}`, {
    headers: githubHeaders(input.token),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  })
}

async function apiJson(input, path, label) {
  return readGithubResponse(await api(input, path), label)
}

function normalizedUrl(value) {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : ''
}

function isSameUrl(left, right) {
  const normalized = normalizedUrl(left)
  return normalized !== '' && normalized === normalizedUrl(right)
}

function openPullRequests(body) {
  return (Array.isArray(body) ? body : []).filter((pull) =>
    pull?.state === 'open'
    && typeof pull?.head?.sha === 'string'
    && COMMIT_SHA.test(pull.head.sha)
  )
}

function isDefaultBranchRun(input) {
  return typeof input.headBranch === 'string' && input.headBranch !== ''
    && typeof input.defaultBranch === 'string' && input.defaultBranch !== ''
    && input.headBranch === input.defaultBranch
}

async function directMatch(input) {
  // A run on the default branch describes main, not a pull-request head; its
  // head must never be treated as a PR head even if a stray open PR matches.
  if (isDefaultBranchRun(input)) return null
  if (typeof input.head !== 'string' || !COMMIT_SHA.test(input.head)) return null
  const body = await apiJson(
    input,
    `/repos/${input.repository}/commits/${input.head}/pulls?per_page=${String(PER_PAGE)}`,
    'listing pull requests for the heavy run head',
  )
  const matches = openPullRequests(body).filter((pull) => pull.head.sha === input.head)
  if (matches.length === 0) return null
  if (matches.length > 1) {
    throw new Error(`found ${String(matches.length)} open pull requests for heavy head ${input.head}`)
  }
  return { number: matches[0].number, head: input.head }
}

async function carriesRunStatus(input, head) {
  const body = await apiJson(
    input,
    `/repos/${input.repository}/commits/${head}/statuses?per_page=${String(PER_PAGE)}`,
    `reading heavy status for ${head}`,
  )
  return (Array.isArray(body) ? body : []).some((status) =>
    status?.context === HEAVY_GATE_CONTEXT && isSameUrl(status?.target_url, input.runUrl)
  )
}

async function openPullRequestPage(input, page) {
  const body = await apiJson(
    input,
    `/repos/${input.repository}/pulls?state=open&per_page=${String(PER_PAGE)}&page=${String(page)}`,
    'listing open pull requests',
  )
  return Array.isArray(body) ? body : []
}

async function scanOpenPullRequests(input) {
  const matches = []
  const statusByHead = new Map()
  for (let page = 1; page <= OPEN_PR_PAGE_LIMIT; page += 1) {
    const rows = await openPullRequestPage(input, page)
    for (const pull of openPullRequests(rows)) {
      if (pull.head.repo?.full_name !== input.repository) continue
      const head = pull.head.sha
      if (!statusByHead.has(head)) statusByHead.set(head, await carriesRunStatus(input, head))
      if (statusByHead.get(head)) matches.push({ number: pull.number, head })
    }
    if (rows.length < PER_PAGE) return matches
  }
  throw new Error(`open pull request scan exceeded ${String(OPEN_PR_PAGE_LIMIT)} pages`)
}

/**
 * Resolve the open pull request and tested head that own one Heavy run.
 *
 * @param {{token: string, repository: string, apiUrl: string, head: string,
 *   headBranch?: string, defaultBranch?: string, runUrl: string,
 *   fetchImpl?: typeof fetch}} input Run and API inputs.
 * @returns {Promise<{number: number, head: string}|null>} The unique open pull
 *   request and its tested head, or null when this run owns no open PR.
 * @throws {Error} When more than one open pull request matches or the API
 *   request fails. More than one match is a contract violation, not a guess.
 */
export async function resolveHeavyPullRequest(input) {
  if (typeof input.token !== 'string' || input.token === '') throw new Error('token is required')
  if (typeof input.repository !== 'string' || input.repository === '') throw new Error('repository is required')
  if (typeof input.apiUrl !== 'string' || input.apiUrl === '') throw new Error('apiUrl is required')
  if (normalizedUrl(input.runUrl) === '') throw new Error('runUrl is required')
  const direct = await directMatch(input)
  if (direct !== null) return direct
  const matches = await scanOpenPullRequests(input)
  if (matches.length === 0) return null
  if (matches.length > 1) {
    throw new Error(`found ${String(matches.length)} open pull requests carrying heavy run ${input.runUrl}`)
  }
  return matches[0]
}

function parseOptions(args) {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      'github-output': { type: 'boolean', default: false },
    },
    strict: true,
  })
  return { githubOutput: values['github-output'] }
}

/**
 * Run the resolver from environment values and optionally publish step outputs.
 *
 * The workflow calls this once to resolve both the tested head and the pull
 * request number; the summary publisher consumes the same values so it never
 * re-derives a head from the run.
 *
 * @param {string[]} args CLI arguments.
 * @param {{ env?: Record<string, string|undefined>, outputFile?: string,
 *   fetchImpl?: typeof fetch }} [environment] Injectable seams for tests.
 * @returns {Promise<{number: number, head: string}|null>} Resolution.
 */
export async function runResolver(args, environment = {}) {
  const options = parseOptions(args)
  const env = environment.env ?? process.env
  for (const name of ['GH_TOKEN', 'GITHUB_REPOSITORY', 'HEAVY_RUN_HEAD', 'HEAVY_RUN_URL']) {
    if (env[name] === undefined || env[name] === '') throw new Error(`${name} is not set`)
  }
  const resolved = await resolveHeavyPullRequest({
    token: env.GH_TOKEN,
    repository: env.GITHUB_REPOSITORY,
    apiUrl: env.GITHUB_API_URL ?? 'https://api.github.com',
    head: env.HEAVY_RUN_HEAD,
    headBranch: env.HEAVY_RUN_BRANCH,
    defaultBranch: env.DEFAULT_BRANCH,
    runUrl: env.HEAVY_RUN_URL,
    fetchImpl: environment.fetchImpl,
  })
  if (options.githubOutput) {
    const outputFile = environment.outputFile ?? process.env.GITHUB_OUTPUT
    if (outputFile === undefined || outputFile === '') throw new Error('GITHUB_OUTPUT is not set')
    const number = resolved === null ? '' : String(resolved.number)
    const head = resolved === null ? '' : resolved.head
    appendFileSync(outputFile, `number=${number}\nhead=${head}\n`)
  }
  return resolved
}

const invoked = process.argv[1]
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  try {
    const resolved = await runResolver(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(resolved)}\n`)
  } catch (error) {
    process.stderr.write(`resolve-heavy-pr: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
