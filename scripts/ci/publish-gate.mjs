#!/usr/bin/env node
/**
 * Publish the derived `gate-artifact` check run from trusted base-branch code.
 *
 * The gate is a summary, not a test runner:
 * - `pr-gate` proves the PR head passed the hosted source lane;
 * - `pre-merge` proves the current main plus PR head passed integration;
 * - `review-verdict:v2` proves an independent review covered the authored diff;
 * - this process verifies PR metadata and rejects a stale review when main has
 *   changed a path the PR also changed.
 *
 * The publisher never checks out or executes pull-request code.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseReviewVerdict } from './review-verdict.mjs'
import { validatePrMetadata } from './pr-metadata.mjs'

/**
 * Find the newest passing v2 review for the exact head, unless a later
 * changes-requested review blocks it.
 *
 * @param {Array<{ state: string, commit_id: string, body: string, submitted_at?: string }>} reviews
 *   GitHub review objects.
 * @param {string} headSha Current PR head.
 * @returns {{ review: object, verdict: object }} The latest passing review and marker.
 * @throws {Error} When no current passing review exists or a later change request blocks it.
 */
export function findPassingReview(reviews, headSha) {
  const passes = []
  let latestChangeRequest = { at: 0 }
  for (const review of reviews) {
    const at = Date.parse(review.submitted_at ?? '') || 0
    if (String(review.state).toUpperCase() === 'CHANGES_REQUESTED' && at > latestChangeRequest.at) {
      latestChangeRequest = { at }
    }
    try {
      const verdict = parseReviewVerdict({
        state: review.state,
        commitId: String(review.commit_id ?? ''),
        body: String(review.body ?? ''),
        headSha,
        requireV2: true,
      })
      passes.push({ review, verdict, at })
    } catch {
      // A comment or an older-head verdict is not a passing review for this head.
    }
  }
  passes.sort((left, right) => right.at - left.at)
  const latest = passes[0]
  if (latest === undefined) throw new Error('no passing review-verdict:v2 review exists for the current PR head')
  if (latestChangeRequest.at > latest.at) {
    throw new Error('the latest review is CHANGES_REQUESTED; a newer passing review is required')
  }
  return { review: latest.review, verdict: latest.verdict }
}

/**
 * Return the sorted intersection of two path lists.
 *
 * @param {string[]} left Paths changed by the PR.
 * @param {string[]} right Paths changed on main since the reviewed base.
 * @returns {string[]} Overlapping paths.
 */
export function overlapPaths(left, right) {
  const rightSet = new Set(right)
  return [...new Set(left.filter((path) => rightSet.has(path)))].sort()
}

/**
 * Convert collected gate inputs into the check conclusion and human-readable reasons.
 *
 * @param {{ prGate: object|null, preMerge: object|null, reviewError?: string|null,
 *   metadataError?: string|null, diffError?: string|null, overlap?: string[],
 *   currentMain: string }} input Validated inputs.
 * @returns {{ pass: boolean, reasons: string[] }} Gate decision.
 */
export function decideGate(input) {
  const reasons = []
  if (input.prGate === null) reasons.push('pr-gate has not succeeded on the PR head')
  if (input.preMerge === null) {
    reasons.push(input.preMergeError ?? 'pre-merge has not succeeded on the current main and PR head')
  } else if (input.preMerge.base !== input.currentMain) {
    reasons.push(`pre-merge tested base ${input.preMerge.base}, not current main ${input.currentMain}`)
  }
  if (input.reviewError) reasons.push(input.reviewError)
  if (input.metadataError) reasons.push(input.metadataError)
  if (input.diffError) reasons.push(input.diffError)
  if (input.overlap !== undefined && input.overlap.length > 0) {
    reasons.push(`delta review required: main changed reviewed paths: ${input.overlap.join(', ')}`)
  }
  return { pass: reasons.length === 0, reasons }
}

/**
 * Publish one check run on the PR head through the Checks API.
 *
 * @param {{ token: string, repository: string, apiUrl: string, head: string,
 *   name: string, conclusion: 'success'|'failure'|'action_required',
 *   title: string, summary: string, detailsUrl: string, fetchImpl?: typeof fetch }} input
 * @returns {Promise<{ id: number, conclusion: string }>} Published check identity.
 */
export async function publishGateCheck(input) {
  const response = await (input.fetchImpl ?? fetch)(`${input.apiUrl}/repos/${input.repository}/check-runs`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${input.token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      name: input.name,
      head_sha: input.head,
      status: 'completed',
      conclusion: input.conclusion,
      details_url: input.detailsUrl,
      output: { title: input.title, summary: input.summary },
    }),
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`publishing ${input.name} failed (${String(response.status)}): ${detail}`)
  }
  const body = await response.json()
  return { id: body.id, conclusion: input.conclusion }
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

function git(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LANG: 'C', LC_ALL: 'C' },
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    const detail = String(result.stderr ?? '').trim() || `git exited with status ${String(result.status)}`
    throw new Error(`git ${args.join(' ')}: ${detail}`)
  }
  return result.stdout
}

function ensureCommit(cwd, sha) {
  git(['fetch', '--no-tags', 'origin', sha], cwd)
  git(['cat-file', '-e', `${sha}^{commit}`], cwd)
}

function isAncestor(cwd, ancestor, descendant) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd })
  if (result.error !== undefined) throw result.error
  if (result.status === 0) return true
  if (result.status === 1) return false
  const detail = String(result.stderr ?? '').trim() || `git exited with status ${String(result.status)}`
  throw new Error(`git merge-base --is-ancestor ${ancestor} ${descendant}: ${detail}`)
}

function binaryDiffSha(cwd, base, head) {
  const diff = git(['diff', '--no-ext-diff', '--no-textconv', '--binary', `${base}..${head}`], cwd)
  return createHash('sha256').update(diff).digest('hex')
}

function changedPaths(cwd, base, head) {
  return git(['diff', '--name-only', `${base}..${head}`], cwd)
    .toString('utf8')
    .split('\n')
    .filter((path) => path !== '')
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
    const prNumber = requiredEnv('PR_NUMBER')
    const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com'
    const mode = process.env.POLICY_MODE === 'block' ? 'block' : 'report'
    const checkName = process.env.GATE_CHECK_NAME ?? (mode === 'block' ? 'gate-artifact' : 'gate-artifact-v2')
    const detailsUrl = process.env.RUN_URL ?? ''
    const cwd = process.env.GATE_WORKSPACE ?? process.cwd()
    const currentMain = (await github({
      token,
      apiUrl,
      path: `/repos/${repository}/git/ref/heads/main`,
    })).object.sha
    const pull = await github({ token, apiUrl, path: `/repos/${repository}/pulls/${prNumber}` })
    const head = pull.head.sha
    const reviews = await github({
      token,
      apiUrl,
      path: `/repos/${repository}/pulls/${prNumber}/reviews?per_page=100`,
    })
    const checks = (await github({
      token,
      apiUrl,
      path: `/repos/${repository}/commits/${head}/check-runs?per_page=100`,
    })).check_runs

    const prGate = checks.find((check) => check.name === 'pr-gate' && check.conclusion === 'success') ?? null
    let preMerge = null
    let preMergeError = null
    const preMergeCheck = [...checks]
      .filter((check) => check.name === 'pre-merge' && check.conclusion === 'success')
      .sort((left, right) => String(right.completed_at ?? '').localeCompare(String(left.completed_at ?? '')))[0]
    if (preMergeCheck !== undefined) {
      try {
        preMerge = JSON.parse(preMergeCheck.output?.summary ?? '')
        if (preMerge.head !== head) preMergeError = 'pre-merge summary belongs to a different head'
        else if (preMerge.result !== 'success') preMergeError = `pre-merge result is ${String(preMerge.result)}`
        else if (preMerge.staleBase === true) preMergeError = 'pre-merge tested an older base'
      } catch {
        preMergeError = 'pre-merge summary is not valid JSON'
      }
      if (preMergeError !== null) preMerge = null
    }

    let reviewError = null
    let verdict = null
    try {
      const found = findPassingReview(reviews, head)
      verdict = found.verdict
    } catch (error) {
      reviewError = error instanceof Error ? error.message : String(error)
    }

    let metadataError = null
    try {
      validatePrMetadata({ title: pull.title, body: pull.body ?? '' })
    } catch (error) {
      metadataError = error instanceof Error ? error.message : String(error)
    }

    let diffError = null
    let overlap = []
    if (verdict !== null) {
      try {
        ensureCommit(cwd, head)
        ensureCommit(cwd, verdict.baseSha)
        ensureCommit(cwd, currentMain)
        if (!isAncestor(cwd, verdict.baseSha, head)) {
          throw new Error('review base is not an ancestor of the PR head')
        }
        if (!isAncestor(cwd, verdict.baseSha, currentMain)) {
          throw new Error('review base is not an ancestor of current main')
        }
        const diff = binaryDiffSha(cwd, verdict.baseSha, head)
        if (diff !== verdict.diffSha) {
          throw new Error(`reviewed diffSha ${verdict.diffSha} does not match current authored diff ${diff}`)
        }
        overlap = overlapPaths(
          changedPaths(cwd, verdict.baseSha, head),
          changedPaths(cwd, verdict.baseSha, currentMain),
        )
      } catch (error) {
        diffError = error instanceof Error ? error.message : String(error)
      }
    }

    const decision = decideGate({
      prGate,
      preMerge,
      preMergeError,
      currentMain,
      reviewError,
      metadataError,
      diffError,
      overlap,
    })
    const summary = JSON.stringify({
      pass: decision.pass,
      reasons: decision.reasons,
      head,
      currentMain,
      review: verdict === null ? null : {
        markerVersion: verdict.markerVersion,
        base: verdict.baseSha,
        diffSha: verdict.diffSha,
        reviewer: verdict.reviewer,
        model: verdict.model,
      },
    })
    const conclusion = mode === 'report' || decision.pass ? 'success' : 'failure'
    const title = mode === 'report'
      ? (decision.pass ? 'REPORT: gate would pass' : 'REPORT: gate would fail')
      : (decision.pass ? 'gate-artifact: pass' : 'gate-artifact: blocked')
    const published = await publishGateCheck({
      token,
      repository,
      apiUrl,
      head,
      name: checkName,
      conclusion,
      title,
      summary,
      detailsUrl,
    })
    process.stdout.write(`${JSON.stringify({ ...published, mode, decision })}\n`)
    if (mode === 'block' && !decision.pass) process.exitCode = 1
  } catch (error) {
    process.stderr.write(`publish-gate: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
