#!/usr/bin/env node
/**
 * Invalidate a previous derived-gate success after main advances.
 *
 * Without a merge queue, a PR branch may stay behind main by design. The gate
 * is valid only when `pre-merge` tested the current main. This trusted
 * post-main workflow writes a pending `gate-artifact` status on each open PR
 * whose previous gate was green, so an old success cannot be merged by mistake.
 * It also marks the non-required `gate-artifact-v2` display check stale.
 *
 * It does not notify, label, resolve, or modify any PR branch.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GATE_DISPLAY_CHECK, REQUIRED_GATE_CONTEXT } from './publish-gate.mjs'

const GATE_CONTEXTS = [REQUIRED_GATE_CONTEXT, GATE_DISPLAY_CHECK]

/**
 * Return whether this PR needs a stale-gate marker.
 *
 * @param {{ draft: boolean, statuses: Array<{ context: string, state: string }>,
 *   checkRuns: Array<{ name: string, conclusion: string }> }} input
 *   PR state, commit statuses, and check runs on the current head.
 * @param {string | string[]} contexts Gate contexts to invalidate.
 * @returns {boolean} True when the PR is open for merge and had a green gate.
 */
export function shouldInvalidateGate(input, contexts) {
  if (input.draft) return false
  const names = new Set(Array.isArray(contexts) ? contexts : [contexts])
  return input.statuses.some((status) => names.has(status.context) && status.state === 'success')
    || input.checkRuns.some((check) => names.has(check.name) && check.conclusion === 'success')
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

function headers(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

/**
 * Publish a pending required status, invalidate a legacy required check run,
 * and mark the display check stale.
 *
 * The status is the gate; the check run is best-effort UI. A failed display
 * write is reported but does not undo the stale status. A green legacy
 * `gate-artifact` check run is patched to `action_required` so a head created
 * before the status migration cannot keep a frozen success.
 *
 * @param {{ token: string, repository: string, apiUrl: string,
 *   head: string, mainSha: string, runUrl: string, fetchImpl?: typeof fetch }} input
 * @returns {Promise<void>} Resolves after the blocking status is published.
 */
export async function publishStaleGate(input) {
  const summary = JSON.stringify({
    pass: false,
    reason: 'base-advanced',
    currentMain: input.mainSha,
    head: input.head,
    requiredAction: 'run pre-merge against the current main, then let the derived gate recompute',
  })
  const fetchImpl = input.fetchImpl ?? fetch
  const statusResponse = await fetchImpl(`${input.apiUrl}/repos/${input.repository}/statuses/${input.head}`, {
    method: 'POST',
    headers: headers(input.token),
    body: JSON.stringify({
      state: 'pending',
      context: REQUIRED_GATE_CONTEXT,
      description: 'base advanced; recheck required',
      target_url: input.runUrl,
    }),
  })
  if (!statusResponse.ok) {
    const detail = await statusResponse.text()
    throw new Error(`publishing stale ${REQUIRED_GATE_CONTEXT} status failed (${String(statusResponse.status)}): ${detail}`)
  }
  const legacyResponse = await fetchImpl(
    `${input.apiUrl}/repos/${input.repository}/commits/${input.head}/check-runs?check_name=${encodeURIComponent(REQUIRED_GATE_CONTEXT)}&filter=all&per_page=100`,
    { headers: headers(input.token) },
  )
  if (!legacyResponse.ok) {
    const detail = await legacyResponse.text()
    throw new Error(`listing legacy ${REQUIRED_GATE_CONTEXT} checks failed (${String(legacyResponse.status)}): ${detail}`)
  }
  const legacy = await legacyResponse.json()
  const legacyRuns = Array.isArray(legacy.check_runs) ? legacy.check_runs : []
  for (const run of legacyRuns) {
    if (run.conclusion !== 'success') continue
    const patchResponse = await fetchImpl(`${input.apiUrl}/repos/${input.repository}/check-runs/${String(run.id)}`, {
      method: 'PATCH',
      headers: headers(input.token),
      body: JSON.stringify({
        status: 'completed',
        conclusion: 'action_required',
        details_url: input.runUrl,
        output: {
          title: 'base advanced; pre-merge recheck required',
          summary,
        },
      }),
    })
    if (!patchResponse.ok) {
      const detail = await patchResponse.text()
      throw new Error(`invalidating legacy ${REQUIRED_GATE_CONTEXT} check ${String(run.id)} failed (${String(patchResponse.status)}): ${detail}`)
    }
  }
  try {
    const checkResponse = await fetchImpl(`${input.apiUrl}/repos/${input.repository}/check-runs`, {
      method: 'POST',
      headers: headers(input.token),
      body: JSON.stringify({
        name: GATE_DISPLAY_CHECK,
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
    if (!checkResponse.ok) {
      const detail = await checkResponse.text()
      throw new Error(`publishing stale ${GATE_DISPLAY_CHECK} check failed (${String(checkResponse.status)}): ${detail}`)
    }
  } catch (error) {
    process.stderr.write(`base-recheck: display check not published: ${error instanceof Error ? error.message : String(error)}\n`)
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
      const statuses = (await github({
        token,
        apiUrl,
        path: `/repos/${repository}/commits/${pull.head.sha}/status`,
      })).statuses ?? []
      const checks = (await github({
        token,
        apiUrl,
        path: `/repos/${repository}/commits/${pull.head.sha}/check-runs?per_page=100`,
      })).check_runs
      if (!shouldInvalidateGate({ draft: pull.draft, statuses, checkRuns: checks }, GATE_CONTEXTS)) continue
      await publishStaleGate({
        token,
        repository,
        apiUrl,
        head: pull.head.sha,
        mainSha,
        runUrl,
      })
      invalidated += 1
    }
    process.stdout.write(`${JSON.stringify({ mainSha, contexts: GATE_CONTEXTS, invalidated })}\n`)
  } catch (error) {
    process.stderr.write(`base-recheck: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
