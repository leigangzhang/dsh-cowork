#!/usr/bin/env node
/**
 * Publish the trusted `pre-merge` check run after the read-only pre-merge test
 * job. The publisher never checks out or executes pull-request code.
 *
 * The written summary is the integration artifact the derived gate reads:
 * `{ head, base, currentBase, docsOnly, result, staleBase }`.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Map a GitHub Actions job result to a check conclusion.
 *
 * @param {string} result `success`, `failure`, `cancelled`, or another job result.
 * @param {boolean} staleBase Whether the tested base is no longer the current main.
 * @returns {'success' | 'failure' | 'cancelled' | 'action_required'} Check conclusion.
 */
export function conclusionForResult(result, staleBase) {
  if (staleBase) return 'action_required'
  if (result === 'success') return 'success'
  if (result === 'cancelled') return 'cancelled'
  return 'failure'
}

/**
 * Build the machine-readable summary stored on the `pre-merge` check run.
 *
 * @param {{ head: string, base: string, currentBase: string, docsOnly: boolean,
 *   result: string, runUrl: string }} input Check identity.
 * @returns {string} Stable JSON summary.
 */
export function buildPreMergeSummary(input) {
  return JSON.stringify({
    head: input.head,
    base: input.base,
    currentBase: input.currentBase,
    docsOnly: input.docsOnly,
    result: input.result,
    staleBase: input.base !== input.currentBase,
    run: input.runUrl,
  })
}

/**
 * Publish one check run on the PR head through the Checks API.
 *
 * @param {{ token: string, repository: string, apiUrl: string, head: string, base: string,
 *   currentBase: string, docsOnly: boolean, result: string, runUrl: string,
 *   checkName: string, fetchImpl?: typeof fetch }} input Publication inputs.
 * @returns {Promise<{ id: number, conclusion: string, summary: string }>} Published check identity.
 */
export async function publishPreMerge(input) {
  const staleBase = input.base !== input.currentBase
  const conclusion = conclusionForResult(input.result, staleBase)
  const summary = buildPreMergeSummary({
    head: input.head,
    base: input.base,
    currentBase: input.currentBase,
    docsOnly: input.docsOnly,
    result: input.result,
    runUrl: input.runUrl,
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
      conclusion,
      details_url: input.runUrl,
      output: {
        title: staleBase ? 'pre-merge: base advanced; recheck required' : `pre-merge: ${input.result}`,
        summary,
      },
    }),
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`publishing pre-merge check failed (${String(response.status)}): ${detail}`)
  }
  const body = await response.json()
  return { id: body.id, conclusion, summary }
}

function requiredEnv(name) {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is not set`)
  return value
}

async function currentMainSha({ token, repository, apiUrl }) {
  const response = await fetch(`${apiUrl}/repos/${repository}/git/ref/heads/main`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`reading current main failed (${String(response.status)}): ${detail}`)
  }
  const body = await response.json()
  return body.object.sha
}

const invoked = process.argv[1]
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  try {
    const token = requiredEnv('GH_TOKEN')
    const repository = requiredEnv('GITHUB_REPOSITORY')
    const head = requiredEnv('HEAD_SHA')
    const base = requiredEnv('BASE_SHA')
    const result = requiredEnv('RESULT')
    const docsOnly = process.env.DOCS_ONLY === 'true'
    const runUrl = process.env.RUN_URL ?? ''
    const checkName = process.env.CHECK_NAME ?? 'pre-merge'
    const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com'
    const currentBase = await currentMainSha({ token, repository, apiUrl })
    const published = await publishPreMerge({
      token,
      repository,
      apiUrl,
      head,
      base,
      currentBase,
      docsOnly,
      result,
      runUrl,
      checkName,
    })
    process.stdout.write(`${JSON.stringify(published)}\n`)
  } catch (error) {
    process.stderr.write(`publish-pre-merge: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
