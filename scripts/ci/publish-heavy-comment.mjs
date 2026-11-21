#!/usr/bin/env node
/**
 * Publish one idempotent heavy summary comment on the open pull request that
 * owns the heavy run head.
 *
 * The workflow is deliberately separate from the heavy test job: it checks out
 * trusted main, reads the already-published status and check run, and receives
 * only `pull-requests: write`. It never executes pull-request code, so a branch
 * cannot alter the comment publisher or run commands under the write token.
 */
import { githubHeaders, readGithubResponse } from './github-response.mjs'
import { readHeavyResult, readHeavyStatus } from './publish-gate.mjs'

export const HEAVY_SUMMARY_MARKER = '<!-- heavy-gate-summary -->'
const API_TIMEOUT_MS = 15_000

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

async function resolvePullRequest(config) {
  if (config.prNumber !== undefined && config.prNumber !== null && String(config.prNumber) !== '') {
    return Number(config.prNumber)
  }
  const body = await apiJson(
    config,
    `/repos/${config.repository}/commits/${config.head}/pulls?per_page=100`,
    'resolving the heavy pull request',
  )
  const matches = (Array.isArray(body) ? body : [])
    .filter((pull) => pull?.state === 'open' && pull?.head?.sha === config.head)
  if (matches.length === 0) return null
  if (matches.length > 1) {
    throw new Error(`found ${String(matches.length)} open pull requests for heavy head ${config.head}`)
  }
  return matches[0].number
}

function commandTable(result) {
  if (result === null || result === undefined || !Array.isArray(result.commands) || result.commands.length === 0) return []
  const rows = result.commands.map((command) => (
    `| ${String(command.name)} | ${command.blocking === true ? 'yes' : 'no'} | ${String(command.exitCode)} |`
  ))
  return ['', '| Command | Blocking | Exit |', '| --- | --- | --- |', ...rows]
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
  const lines = [
    HEAVY_SUMMARY_MARKER,
    `## Heavy lane: ${verdict}`,
    '',
    `- Head: \`${input.head}\``,
  ]
  if (input.result !== null && input.result !== undefined) {
    lines.push(`- Base: \`${String(input.result.base)}\``)
    lines.push(`- Current main: \`${String(input.result.currentMain)}\``)
    lines.push(`- Diff SHA-256: \`${String(input.result.diffSha256)}\``)
    lines.push(`- Worktree: ${input.result.clean === true ? 'clean' : 'dirty'}`)
  }
  if (input.status !== null && input.status !== undefined) {
    lines.push(`- Status: ${String(input.status.state)}${input.status.description ? ` (${String(input.status.description)})` : ''}`)
  }
  if (Array.isArray(input.result?.reasons) && input.result.reasons.length > 0) {
    lines.push(`- Reasons: ${input.result.reasons.join('; ')}`)
  }
  if (input.statusError !== null && input.statusError !== undefined) {
    lines.push(`- Status problem: ${input.statusError}`)
  }
  if (input.resultError !== null && input.resultError !== undefined) {
    lines.push(`- Result problem: ${input.resultError}`)
  }
  lines.push(...commandTable(input.result))
  lines.push('', `- Run: [workflow logs](${input.runUrl})`)
  return `${lines.join('\n')}\n`
}

/**
 * Create or update the single heavy summary comment for one run head.
 *
 * @param {{token: string, repository: string, head: string, runUrl: string,
 *   conclusion?: string, prNumber?: string|number, apiUrl?: string,
 *   fetchImpl?: typeof fetch}} config Comment publisher inputs.
 * @returns {Promise<{action: 'created'|'updated', prNumber: number}|{skipped: string}>}
 *   Comment action, or the reason the run has no comment.
 * @throws {Error} When GitHub returns an unexpected response or multiple open PRs match.
 */
export async function publishHeavyComment(config) {
  const prNumber = await resolvePullRequest(config)
  if (prNumber === null) return { skipped: 'no-open-pr' }

  const [statuses, checks] = await Promise.all([
    apiJson(config, `/repos/${config.repository}/commits/${config.head}/statuses?per_page=100`, 'reading heavy status'),
    apiJson(config, `/repos/${config.repository}/commits/${config.head}/check-runs?per_page=100`, 'reading heavy checks'),
  ])
  const status = readHeavyStatus(statuses, config.head)
  const result = readHeavyResult(checks?.check_runs ?? [], config.head)
  if (config.conclusion === 'success' && status.value === null && result.value === null) {
    return { skipped: 'no-heavy-result' }
  }

  const body = formatHeavySummary({
    head: config.head,
    conclusion: config.conclusion,
    runUrl: config.runUrl,
    status: status.value,
    result: result.value,
    statusError: status.error,
    resultError: result.error,
  })
  const comments = await apiJson(
    config,
    `/repos/${config.repository}/issues/${String(prNumber)}/comments?per_page=100`,
    'listing pull request comments',
  )
  const existing = (Array.isArray(comments) ? comments : [])
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
    head: process.env.HEAD_SHA ?? '',
    runUrl: process.env.HEAVY_RUN_URL ?? '',
    conclusion: process.env.HEAVY_CONCLUSION ?? '',
    prNumber: process.env.PR_NUMBER,
    apiUrl: process.env.GITHUB_API_URL ?? 'https://api.github.com',
  }
  try {
    if (config.token === '' || config.repository === '' || config.head === '' || config.runUrl === '') {
      throw new Error('GH_TOKEN, GITHUB_REPOSITORY, HEAD_SHA, and HEAVY_RUN_URL are required')
    }
    const outcome = await publishHeavyComment(config)
    process.stdout.write(`${JSON.stringify(outcome)}\n`)
  } catch (error) {
    process.stderr.write(`publish-heavy-comment: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
