#!/usr/bin/env node
/**
 * Invalidate previous derived-gate success after main advances.
 *
 * Without a merge queue, a PR branch may stay behind main by design. The gate
 * is valid only when `pre-merge` tested the current main. This trusted
 * post-main workflow publishes a blocking `gate-artifact` state on each open PR
 * whose previous gate was green, so an old success cannot be merged by mistake.
 *
 * It does not notify, label, resolve, or modify any PR branch.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Return whether this PR needs a stale-gate marker.
 *
 * @param {{ draft: boolean, checkRuns: Array<{ name: string, conclusion: string }> }} input
 *   PR state and check runs on the current head.
 * @param {string} checkName Required gate context.
 * @returns {boolean} True when the PR is open for merge and had a green gate.
 */
export function shouldInvalidateGate(input, checkName) {
  if (input.draft) return false
  return input.checkRuns.some((check) => check.name === checkName && check.conclusion === 'success')
}

async function github({ token, apiUrl, path, method = 'GET', body }) {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      'X-GitHub-Api-Version': '2022-11-28',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`GitHub API ${method} ${path} failed (${String(response.status)}): ${detail}`)
  }
  return response.json()
}

/**
 * Publish an action-required check run on a PR head.
 *
 * @param {{ token: string, repository: string, apiUrl: string, checkName: string,
 *   head: string, mainSha: string, runUrl: string, fetchImpl?: typeof fetch }} input
 * @returns {Promise<void>} Resolves after the blocking check is published.
 */
export async function publishStaleGate(input) {
  const summary = JSON.stringify({
    pass: false,
    reason: 'base-advanced',
    currentMain: input.mainSha,
    head: input.head,
    requiredAction: 'run pre-merge against the current main, then let the derived gate recompute',
  })
  const response = await (input.fetchImpl ?? fetch)(`${input.apiUrl}/repos/${input.repository}/check-runs`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${input.token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      name: input.checkName,
      head_sha: input.head,
      status: 'completed',
      conclusion: 'action_required',
      details_url: input.runUrl,
      output: {
        title: 'base advanced; pre-merge recheck required',
        summary,
      },
    }),
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`publishing stale ${input.checkName} failed (${String(response.status)}): ${detail}`)
  }
}

function requiredEnv(name) {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is not set`)
  return value
}

const invoked = process.argv[1]
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  try {
    const token = requiredEnv('GH_TOKEN')
    const repository = requiredEnv('GITHUB_REPOSITORY')
    const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com'
    const mode = process.env.POLICY_MODE === 'block' ? 'block' : 'report'
    const checkName = process.env.GATE_CHECK_NAME ?? (mode === 'block' ? 'gate-artifact' : 'gate-artifact-v2')
    const runUrl = process.env.RUN_URL ?? ''
    const mainSha = (await github({
      token,
      apiUrl,
      path: `/repos/${repository}/git/ref/heads/main`,
    })).object.sha
    const pulls = await github({
      token,
      apiUrl,
      path: `/repos/${repository}/pulls?state=open&per_page=100`,
    })
    let invalidated = 0
    for (const pull of pulls) {
      const checks = (await github({
        token,
        apiUrl,
        path: `/repos/${repository}/commits/${pull.head.sha}/check-runs?per_page=100`,
      })).check_runs
      if (!shouldInvalidateGate({ draft: pull.draft, checkRuns: checks }, checkName)) continue
      await publishStaleGate({
        token,
        repository,
        apiUrl,
        checkName,
        head: pull.head.sha,
        mainSha,
        runUrl,
      })
      invalidated += 1
    }
    process.stdout.write(`${JSON.stringify({ mainSha, checkName, mode, invalidated })}\n`)
  } catch (error) {
    process.stderr.write(`base-recheck: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
