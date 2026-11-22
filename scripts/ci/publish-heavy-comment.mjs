#!/usr/bin/env node
/**
 * Publish one idempotent heavy summary comment on the pull request resolved for
 * a heavy run.
 *
 * The comment workflow resolves the tested head and pull request first with
 * `resolve-heavy-pr.mjs`: a `workflow_run`-triggered heavy run records the
 * default branch, so its own `head_sha` is not the pull-request head. This
 * publisher receives that resolution, reads the already-published status and
 * check run for the tested head, and writes the summary.
 *
 * The workflow is deliberately separate from the heavy test job: it checks out
 * trusted main and receives only `pull-requests: write`. It never executes
 * pull-request code, so a branch cannot alter the comment publisher or run
 * commands under the write token.
 */
import { githubHeaders, readGithubResponse } from './github-response.mjs'
import { HEAVY_DISPLAY_CHECK, HEAVY_GATE_CONTEXT } from './heavy-contract.mjs'
import { readHeavyResult, readHeavyStatus } from './publish-gate.mjs'

export const HEAVY_SUMMARY_MARKER = '<!-- heavy-gate-summary -->'
const API_TIMEOUT_MS = 15_000
const COMMIT_SHA = /^[0-9a-f]{40}$/

function api(config, path, init = {}) {
  return (config.fetchImpl ?? fetch)(`${config.apiUrl}${path}`, {
    ...init,
    headers: githubHeaders(config.token, init.body !== undefined),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  })
}

async function apiJson(config, path, label, init = {}) {
  return readGithubResponse(await api(config, path, init), label)
}

async function listComments(config, prNumber) {
  const comments = []
  for (let page = 1; page <= 20; page += 1) {
    const batch = await apiJson(
      config,
      `/repos/${config.repository}/issues/${String(prNumber)}/comments?per_page=100&page=${String(page)}`,
      'listing pull request comments',
    )
    const rows = Array.isArray(batch) ? batch : []
    comments.push(...rows)
    if (rows.length < 100) break
  }
  return comments
}

function validatedPrNumber(config) {
  const prNumber = Number(config.prNumber)
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error('prNumber must be a positive integer')
  }
  if (typeof config.head !== 'string' || !COMMIT_SHA.test(config.head)) {
    throw new Error('head must be a full commit SHA')
  }
  return prNumber
}

function commandTable(result) {
  if (result === null || result === undefined || !Array.isArray(result.commands) || result.commands.length === 0) return []
  const rows = result.commands.map((command) => (
    `| ${String(command.name)} | ${command.blocking === true ? 'yes' : 'no'} | ${String(command.exitCode)} |`
  ))
  return ['', '| Command | Blocking | Exit |', '| --- | --- | --- |', ...rows]
}

function resultIdentityLines(result) {
  if (result === null || result === undefined) return []
  return [
    `- Base: \`${String(result.base)}\``,
    `- Current main: \`${String(result.currentMain)}\``,
    `- Diff SHA-256: \`${String(result.diffSha256)}\``,
    `- Worktree: ${result.clean === true ? 'clean' : 'dirty'}`,
  ]
}

function statusLine(status) {
  if (status === null || status === undefined) return []
  return [`- Status: ${String(status.state)}${status.description ? ` (${String(status.description)})` : ''}`]
}

function reasonLine(result) {
  if (!Array.isArray(result?.reasons) || result.reasons.length === 0) return []
  return [`- Reasons: ${result.reasons.join('; ')}`]
}

function problemLines(input) {
  const lines = []
  if (input.statusError !== null && input.statusError !== undefined) {
    lines.push(`- Status problem: ${input.statusError}`)
  }
  if (input.resultError !== null && input.resultError !== undefined) {
    lines.push(`- Result problem: ${input.resultError}`)
  }
  return lines
}

/**
 * Format the PR-readable heavy summary.
 *
 * @param {{head: string, conclusion?: string, runUrl: string, status?: object|null,
 *   result?: object|null, statusError?: string|null, resultError?: string|null}} input Summary inputs.
 * @returns {string} Comment body with the idempotency marker.
 */
export function formatHeavySummary(input) {
  const passed = input.result?.result === 'pass' && input.status?.state === 'success'
  const verdict = passed ? 'passed' : input.conclusion === 'failure' ? 'failed' : 'blocked'
  return [
    HEAVY_SUMMARY_MARKER,
    `## Heavy lane: ${verdict}`,
    '',
    `- Head: \`${input.head}\``,
    ...resultIdentityLines(input.result),
    ...statusLine(input.status),
    ...reasonLine(input.result),
    ...problemLines(input),
    ...commandTable(input.result),
    '',
    `- Run: [workflow logs](${input.runUrl})`,
    '',
  ].join('\n')
}

/**
 * Create or update the single heavy summary comment for one resolved run.
 *
 * @param {{token: string, repository: string, head: string, prNumber: string|number,
 *   runUrl: string, conclusion?: string, apiUrl?: string,
 *   fetchImpl?: typeof fetch}} config Comment publisher inputs. `head` is the
 *   tested pull-request head resolved by `resolve-heavy-pr.mjs`.
 * @returns {Promise<{action: 'created'|'updated', prNumber: number}|{skipped: 'no-heavy-result'}>}
 *   Comment action, or the reason this run has no summary to publish.
 * @throws {Error} When the resolved inputs are invalid or GitHub returns an
 *   unexpected response.
 */
export async function publishHeavyComment(config) {
  const prNumber = validatedPrNumber(config)

  const [statuses, checks] = await Promise.all([
    apiJson(config, `/repos/${config.repository}/commits/${config.head}/statuses?per_page=100`, 'reading heavy status'),
    apiJson(config, `/repos/${config.repository}/commits/${config.head}/check-runs?per_page=100`, 'reading heavy checks'),
  ])
  const statusRows = Array.isArray(statuses) ? statuses : []
  const checkRows = Array.isArray(checks?.check_runs) ? checks.check_runs : []
  const hasHeavyStatus = statusRows.some((entry) => entry?.context === HEAVY_GATE_CONTEXT)
  const hasHeavyResult = checkRows.some((entry) => entry?.name === HEAVY_DISPLAY_CHECK)
  if (config.conclusion === 'success' && !hasHeavyStatus && !hasHeavyResult) {
    return { skipped: 'no-heavy-result' }
  }
  const status = readHeavyStatus(statusRows, config.head)
  const result = readHeavyResult(checkRows, config.head)

  const body = formatHeavySummary({
    head: config.head,
    conclusion: config.conclusion,
    runUrl: config.runUrl,
    status: status.value,
    result: result.value,
    statusError: status.error,
    resultError: result.error,
  })
  const comments = await listComments(config, prNumber)
  const existing = comments
    .find((comment) => String(comment?.body ?? '').includes(HEAVY_SUMMARY_MARKER))
  if (existing === undefined) {
    await apiJson(config, `/repos/${config.repository}/issues/${String(prNumber)}/comments`, 'creating heavy summary comment', {
      method: 'POST',
      body: JSON.stringify({ body }),
    })
    return { action: 'created', prNumber }
  }
  await apiJson(config, `/repos/${config.repository}/issues/comments/${String(existing.id)}`, 'updating heavy summary comment', {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  })
  return { action: 'updated', prNumber }
}

const invoked = process.argv[1]
if (invoked !== undefined && invoked.endsWith('/publish-heavy-comment.mjs')) {
  const config = {
    token: process.env.GH_TOKEN ?? '',
    repository: process.env.GITHUB_REPOSITORY ?? '',
    head: (process.env.HEAD_SHA ?? '').trim(),
    runUrl: process.env.HEAVY_RUN_URL ?? '',
    conclusion: process.env.HEAVY_CONCLUSION ?? '',
    prNumber: (process.env.PR_NUMBER ?? '').trim(),
    apiUrl: process.env.GITHUB_API_URL ?? 'https://api.github.com',
  }
  try {
    if (config.token === '' || config.repository === '' || config.runUrl === '') {
      throw new Error('GH_TOKEN, GITHUB_REPOSITORY, and HEAVY_RUN_URL are required')
    }
    if (config.prNumber === '' && config.head === '') {
      process.stdout.write(`${JSON.stringify({ skipped: 'no-open-pr' })}\n`)
    } else {
      const outcome = await publishHeavyComment(config)
      process.stdout.write(`${JSON.stringify(outcome)}\n`)
    }
  } catch (error) {
    process.stderr.write(`publish-heavy-comment: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
