#!/usr/bin/env node
/**
 * Publish the idempotent heavy summary and coverage-gap comments for one
 * resolved heavy run.
 *
 * The comment workflow resolves the tested head and pull request first with
 * `resolve-heavy-pr.mjs`: a `workflow_run`-triggered heavy run records the
 * default branch, so its own `head_sha` is not the pull-request head. This
 * publisher receives that resolution, reads the already-published status and
 * check run for the tested head, and writes one heavy summary. When a published
 * heavy result exists it also writes one separate coverage-gap comment.
 *
 * The workflow is deliberately separate from the heavy test job: it checks out
 * trusted main and receives only `pull-requests: write`. It never executes
 * pull-request code. The gap report text originated in the heavy job, so it is
 * treated as untrusted data: bounded, stripped of terminal controls, and placed
 * inside a code fence rather than spliced into Markdown.
 */
import { githubHeaders, readGithubResponse } from './github-response.mjs'
import { HEAVY_DISPLAY_CHECK, HEAVY_GATE_CONTEXT } from './heavy-contract.mjs'
import { readHeavyResult, readHeavyStatus } from './publish-gate.mjs'

export const HEAVY_SUMMARY_MARKER = '<!-- heavy-gate-summary -->'
export const COVERAGE_GAP_MARKER = '<!-- coverage-gap-report -->'
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
 * Put untrusted report text in a fenced block that no line in the report can
 * close. Markdown fences need to be longer than any backtick run in the body.
 *
 * @param {string} text Sanitized report text.
 * @returns {string} A `text` code fence.
 */
function fencedText(text) {
  const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length))
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return `${fence}text\n${text === '' ? '(report is empty)' : text}\n${fence}`
}

/**
 * Format the separate observational coverage-gap PR comment.
 *
 * @param {{head: string, runUrl: string,
 *   coverageGaps?: {available?: boolean, reason?: string, text?: string, truncated?: boolean}|null}} input
 *   Comment inputs.
 * @returns {string} Comment body with the idempotency marker.
 */
export function formatCoverageGapComment(input) {
  const gaps = input.coverageGaps
  const available = gaps?.available === true
  const lines = [
    COVERAGE_GAP_MARKER,
    '## Coverage gap report',
    '',
    `- Head: \`${input.head}\``,
    `- Observational: this comment audits coverage gaps; it does not change \`heavy-gate\`.`,
  ]
  if (available) {
    lines.push('', fencedText(typeof gaps.text === 'string' ? gaps.text : ''))
    if (gaps.truncated === true) lines.push('', '- Truncated to fit the PR comment budget.')
  } else {
    lines.push('', `- Report: ${String(gaps?.reason ?? 'coverage gap report is unavailable')}`)
  }
  lines.push('', `- Run: [workflow logs](${input.runUrl})`, '')
  return lines.join('\n')
}

/**
 * Read the newest display-check summary for audit comments, regardless of the
 * check conclusion. The gate still requires a successful check; a blocked
 * heavy run should still show its command exits and coverage-gap report on the
 * pull request.
 *
 * @param {Array<{name: string, output?: {summary?: string}, completed_at?: string, id?: number}>} checks
 *   Check runs for the tested head.
 * @returns {object|null} Parsed summary object, or null when unavailable.
 */
function latestAuditResult(checks) {
  const candidate = (Array.isArray(checks) ? checks : [])
    .filter((check) => check?.name === HEAVY_DISPLAY_CHECK)
    .sort((left, right) => (
      Date.parse(String(right.completed_at ?? '')) - Date.parse(String(left.completed_at ?? ''))
      || Number(right.id ?? 0) - Number(left.id ?? 0)
    ))[0]
  if (candidate === undefined) return null
  try {
    const parsed = JSON.parse(candidate.output?.summary ?? '')
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function upsertComment(config, comments, marker, body, label) {
  const existing = comments.find((comment) => String(comment?.body ?? '').includes(marker))
  if (existing === undefined) {
    await apiJson(config, `/repos/${config.repository}/issues/${String(config.prNumber)}/comments`, `creating ${label}`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    })
    return 'created'
  }
  await apiJson(config, `/repos/${config.repository}/issues/comments/${String(existing.id)}`, `updating ${label}`, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  })
  return 'updated'
}

/**
 * Create or update the heavy summary and coverage-gap comments for one run.
 *
 * @param {{token: string, repository: string, head: string, prNumber: string|number,
 *   runUrl: string, conclusion?: string, apiUrl?: string,
 *   fetchImpl?: typeof fetch}} config Comment publisher inputs. `head` is the
 *   tested pull-request head resolved by `resolve-heavy-pr.mjs`.
 * @returns {Promise<{action: 'created'|'updated', gapAction?: 'created'|'updated',
 *   prNumber: number}|{skipped: 'no-heavy-result'}>}
 *   Comment actions, or the reason this run has no summary to publish.
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
  const auditResult = result.value ?? latestAuditResult(checkRows)

  const body = formatHeavySummary({
    head: config.head,
    conclusion: config.conclusion,
    runUrl: config.runUrl,
    status: status.value,
    result: auditResult,
    statusError: status.error,
    resultError: result.error,
  })
  const comments = await listComments(config, prNumber)
  const action = await upsertComment(config, comments, HEAVY_SUMMARY_MARKER, body, 'heavy summary comment')
  if (auditResult === null) return { action, prNumber }
  const gapBody = formatCoverageGapComment({
    head: config.head,
    runUrl: config.runUrl,
    coverageGaps: auditResult.coverageGaps,
  })
  const gapAction = await upsertComment(config, comments, COVERAGE_GAP_MARKER, gapBody, 'coverage gap comment')
  return { action, gapAction, prNumber }
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
