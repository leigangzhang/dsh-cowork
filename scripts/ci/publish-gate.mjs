#!/usr/bin/env node
/**
 * Publish the derived `gate-artifact` commit status from trusted base-branch code.
 *
 * The required context is always `gate-artifact`, carried by a commit status so
 * repeated runs overwrite one context instead of accumulating same-named check
 * runs across Actions check suites. `gate-artifact-v2` is a non-required check
 * run that mirrors the decision on the Checks page.
 *
 * Report mode keeps the legacy review/pr-gate/main-ancestor gate required.
 * Block mode switches the required context to the v2 review + pre-merge gate.
 *
 * The publisher never checks out or executes pull-request code.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseReviewMarker } from './review-verdict.mjs'
import { validatePrMetadata } from './pr-metadata.mjs'

/** Required commit-status context. Never changes with policy mode. */
export const REQUIRED_GATE_CONTEXT = 'gate-artifact'
/** Non-required display check. Never add this name to required checks. */
export const GATE_DISPLAY_CHECK = 'gate-artifact-v2'

/**
 * Return the newest review-verdict marker for one head.
 *
 * A later pass does not override a newer `needs_revision` or `reject` marker.
 * A `CHANGES_REQUESTED` review with no marker also blocks an older pass.
 *
 * @param {Array<{ state: string, commit_id: string, body: string, submitted_at?: string }>} reviews
 *   GitHub review objects.
 * @param {string} headSha Current PR head.
 * @param {{ requireV2?: boolean }} [options] Whether the caller requires the v2 marker.
 * @returns {{ status: 'pass'|'needs_revision'|'reject'|'changes_requested'|'missing',
 *   review: object|null, verdict: object|null, at: number }} Newest decision.
 */
export function findReviewDecision(reviews, headSha, options = {}) {
  const requireV2 = options.requireV2 ?? true
  const markers = []
  let latestChangeRequestAt = 0
  for (const review of reviews) {
    const at = Date.parse(review.submitted_at ?? '') || 0
    if (String(review.state).toUpperCase() === 'CHANGES_REQUESTED' && at > latestChangeRequestAt) {
      latestChangeRequestAt = at
    }
    try {
      const verdict = parseReviewMarker({
        state: review.state,
        commitId: String(review.commit_id ?? ''),
        body: String(review.body ?? ''),
        headSha,
        requireV2,
      })
      markers.push({ review, verdict, at })
    } catch {
      // A comment or an older-head marker is not a decision for this head.
    }
  }
  markers.sort((left, right) => right.at - left.at)
  const latest = markers[0]
  if (latest === undefined) return { status: 'missing', review: null, verdict: null, at: 0 }
  if (latestChangeRequestAt > latest.at) {
    return { status: 'changes_requested', review: latest.review, verdict: null, at: latestChangeRequestAt }
  }
  return { status: latest.verdict.verdict, review: latest.review, verdict: latest.verdict, at: latest.at }
}

/**
 * Return the newest passing review, or throw the blocking decision.
 *
 * @param {Array<object>} reviews GitHub review objects.
 * @param {string} headSha Current PR head.
 * @param {{ requireV2?: boolean }} [options] Whether the caller requires the v2 marker.
 * @returns {{ review: object, verdict: object }} The latest passing review and marker.
 * @throws {Error} When the latest decision is missing or not `pass`.
 */
export function findPassingReview(reviews, headSha, options = {}) {
  const decision = findReviewDecision(reviews, headSha, options)
  if (decision.status !== 'pass') throw new Error(`latest review decision is ${decision.status}`)
  return { review: decision.review, verdict: decision.verdict }
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
 * Convert the v2 gate inputs into a decision.
 *
 * @param {{ prGate: object|null, preMerge: object|null, preMergeError?: string|null,
 *   reviewError?: string|null, metadataError?: string|null, diffError?: string|null,
 *   overlap?: string[], currentMain: string }} input Validated inputs.
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
    reasons.push(`delta review required: main changed reviewed paths (${input.overlap.join(', ')}); merge current main into the PR branch and review the new head`)
  }
  return { pass: reasons.length === 0, reasons }
}

/**
 * Convert the legacy report-mode gate inputs into a decision.
 *
 * @param {{ reviewError?: string|null, prGate: object|null, mainContainsHead: boolean,
 *   metadataError?: string|null }} input Validated inputs.
 * @returns {{ pass: boolean, reasons: string[] }} Legacy gate decision.
 */
export function decideLegacyGate(input) {
  const reasons = []
  if (input.reviewError) reasons.push(input.reviewError)
  if (input.prGate === null) reasons.push('pr-gate has not succeeded on the PR head')
  if (!input.mainContainsHead) reasons.push('current main is not an ancestor of the PR head')
  if (input.metadataError) reasons.push(input.metadataError)
  return { pass: reasons.length === 0, reasons }
}

/**
 * Return the decision that owns the required `gate-artifact` context.
 *
 * @param {'report'|'block'} mode Policy mode.
 * @param {{ pass: boolean, reasons: string[] }} legacy Legacy decision.
 * @param {{ pass: boolean, reasons: string[] }} modern V2 decision.
 * @returns {{ pass: boolean, reasons: string[] }} Required decision.
 */
export function requiredGateDecision(mode, legacy, modern) {
  return mode === 'block' ? modern : legacy
}

/**
 * Build a short commit-status description from the gate decision.
 *
 * @param {{ pass: boolean, reasons: string[] }} decision Gate decision.
 * @param {'report'|'block'} mode Policy mode.
 * @returns {string} Description of at most 140 characters.
 */
export function gateStatusDescription(decision, mode) {
  const text = decision.pass
    ? `${mode}: gate passed`
    : `blocked: ${decision.reasons[0] ?? 'gate decision blocked'}`
  return text.length <= 140 ? text : `${text.slice(0, 137)}...`
}

/**
 * Publish the required gate as one commit status on the PR head.
 *
 * The Statuses API replaces the previous value for the same context, so a
 * later evaluation cannot leave a stale success hidden in a different check
 * suite. The commit status is the merge gate; the Checks API is display-only.
 *
 * @param {{ token: string, repository: string, apiUrl: string, head: string,
 *   state: 'success'|'failure'|'error'|'pending', description: string,
 *   detailsUrl: string, context?: string, fetchImpl?: typeof fetch }} input
 * @returns {Promise<{ context: string, state: string }>} Published status identity.
 */
export async function publishGateStatus(input) {
  const context = input.context ?? REQUIRED_GATE_CONTEXT
  const description = input.description.slice(0, 140)
  const response = await (input.fetchImpl ?? fetch)(`${input.apiUrl}/repos/${input.repository}/statuses/${input.head}`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${input.token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      state: input.state,
      context,
      description,
      target_url: input.detailsUrl,
    }),
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`publishing ${context} status failed (${String(response.status)}): ${detail}`)
  }
  return { context, state: input.state }
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

/**
 * Return whether `ancestor` is an ancestor of `descendant` in the local repo.
 *
 * @param {string} cwd Repository root.
 * @param {string} ancestor Candidate ancestor SHA.
 * @param {string} descendant Candidate descendant SHA.
 * @returns {boolean} True when the ancestry relation holds.
 */
export function isAncestor(cwd, ancestor, descendant) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd })
  if (result.error !== undefined) throw result.error
  if (result.status === 0) return true
  if (result.status === 1) return false
  const detail = String(result.stderr ?? '').trim() || `git exited with status ${String(result.status)}`
  throw new Error(`git merge-base --is-ancestor ${ancestor} ${descendant}: ${detail}`)
}

/**
 * Hash the binary diff for one base..head range with a fixed algorithm.
 *
 * @param {string} cwd Repository root.
 * @param {string} base Base commit SHA.
 * @param {string} head Head commit SHA.
 * @returns {string} SHA-256 of the binary diff.
 */
export function binaryDiffSha(cwd, base, head) {
  const diff = git(['-c', 'diff.algorithm=myers', 'diff', '--no-ext-diff', '--no-textconv', '--binary', `${base}..${head}`], cwd)
  return createHash('sha256').update(diff).digest('hex')
}

/**
 * List repository-relative paths changed in one commit range.
 *
 * @param {string} cwd Repository root.
 * @param {string} base Base commit SHA.
 * @param {string} head Head commit SHA.
 * @returns {string[]} Changed paths.
 */
export function changedPaths(cwd, base, head) {
  return git(['diff', '--name-only', '--no-renames', '-z', `${base}..${head}`], cwd)
    .toString('utf8')
    .split('\0')
    .filter((path) => path !== '')
}

export function readPreMerge(checks, head) {
  const check = [...checks]
    .filter((entry) => entry.name === 'pre-merge')
    .sort((left, right) => String(right.completed_at ?? '').localeCompare(String(left.completed_at ?? '')))[0]
  if (check === undefined) return { value: null, error: null }
  if (check.conclusion !== 'success') {
    return { value: null, error: `pre-merge conclusion is ${String(check.conclusion)}` }
  }
  try {
    const value = JSON.parse(check.output?.summary ?? '')
    if (value.head !== head) return { value: null, error: 'pre-merge summary belongs to a different head' }
    if (value.result !== 'success') return { value: null, error: `pre-merge result is ${String(value.result)}` }
    if (value.staleBase === true) return { value: null, error: 'pre-merge tested an older base' }
    return { value, error: null }
  } catch {
    return { value: null, error: 'pre-merge summary is not valid JSON' }
  }
}

/**
 * Validate the reviewed git identity and current-main relationship.
 *
 * @param {{ cwd: string, head: string, currentMain: string, review: object|null,
 *   ensure?: (cwd: string, sha: string) => void }} input Identity inputs.
 * @returns {{ mainContainsHead: boolean, diffError: string|null, overlap: string[] }}
 *   Validated relationship and any blocking diff error.
 */
export function validateReviewedIdentity(input) {
  const ensure = input.ensure ?? ensureCommit
  let mainContainsHead = false
  let diffError = null
  let overlap = []
  try {
    ensure(input.cwd, input.head)
    ensure(input.cwd, input.currentMain)
    mainContainsHead = isAncestor(input.cwd, input.currentMain, input.head)
    if (input.review !== null) {
      ensure(input.cwd, input.review.baseSha)
      if (!isAncestor(input.cwd, input.review.baseSha, input.head)) {
        throw new Error('review base is not an ancestor of the PR head')
      }
      if (!isAncestor(input.cwd, input.review.baseSha, input.currentMain)) {
        throw new Error('review base is not an ancestor of current main')
      }
      const diff = binaryDiffSha(input.cwd, input.review.baseSha, input.head)
      if (diff !== input.review.diffSha) {
        throw new Error(`reviewed diffSha ${input.review.diffSha} does not match current authored diff ${diff}`)
      }
      overlap = overlapPaths(
        changedPaths(input.cwd, input.review.baseSha, input.head),
        changedPaths(input.cwd, input.review.baseSha, input.currentMain),
      )
    }
  } catch (error) {
    diffError = error instanceof Error ? error.message : String(error)
  }
  return { mainContainsHead, diffError, overlap }
}

function requiredEnv(name) {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is not set`)
  return value
}

const invoked = process.argv[1]
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  let mode = 'report'
  let statusContext = null
  try {
    const token = requiredEnv('GH_TOKEN')
    const repository = requiredEnv('GITHUB_REPOSITORY')
    const prNumber = requiredEnv('PR_NUMBER')
    const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com'
    mode = process.env.POLICY_MODE === 'block' ? 'block' : 'report'
    const detailsUrl = process.env.RUN_URL ?? ''
    const checkToken = process.env.GATE_CHECK_TOKEN || token
    const cwd = process.env.GATE_WORKSPACE ?? process.cwd()
    const currentMain = (await github({
      token,
      apiUrl,
      path: `/repos/${repository}/git/ref/heads/main`,
    })).object.sha
    const pull = await github({ token, apiUrl, path: `/repos/${repository}/pulls/${prNumber}` })
    const head = pull.head.sha
    statusContext = { token, repository, apiUrl, head, detailsUrl }
    await publishGateStatus({
      ...statusContext,
      state: 'pending',
      description: `${mode}: evaluating gate`,
    })
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
    const preMerge = readPreMerge(checks, head)

    let legacyReviewError = null
    try {
      findPassingReview(reviews, head, { requireV2: false })
    } catch (error) {
      legacyReviewError = error instanceof Error ? error.message : String(error)
    }
    let modernReview = null
    let modernReviewError = null
    try {
      modernReview = findPassingReview(reviews, head, { requireV2: true }).verdict
    } catch (error) {
      modernReviewError = error instanceof Error ? error.message : String(error)
    }

    let metadataError = null
    try {
      validatePrMetadata({ title: pull.title, body: pull.body ?? '' })
    } catch (error) {
      metadataError = error instanceof Error ? error.message : String(error)
    }

    const identity = validateReviewedIdentity({
      cwd,
      head,
      currentMain,
      review: modernReview,
    })

    const legacy = decideLegacyGate({
      reviewError: legacyReviewError,
      prGate,
      mainContainsHead: identity.mainContainsHead,
      metadataError,
    })
    const modern = decideGate({
      prGate,
      preMerge: preMerge.value,
      preMergeError: preMerge.error,
      currentMain,
      reviewError: modernReviewError,
      metadataError,
      diffError: identity.diffError,
      overlap: identity.overlap,
    })
    const required = requiredGateDecision(mode, legacy, modern)
    const requiredSummary = JSON.stringify({
      mode,
      pass: required.pass,
      reasons: required.reasons,
      legacy: mode === 'report' ? legacy : null,
      modern,
      head,
      currentMain,
      review: modernReview === null ? null : {
        markerVersion: modernReview.markerVersion,
        base: modernReview.baseSha,
        diffSha: modernReview.diffSha,
        reviewer: modernReview.reviewer,
        model: modernReview.model,
      },
    })
    const requiredPublished = await publishGateStatus({
      ...statusContext,
      state: required.pass ? 'success' : 'failure',
      description: gateStatusDescription(required, mode),
    })
    let displayPublished = null
    try {
      displayPublished = await publishGateCheck({
        token: checkToken,
        repository,
        apiUrl,
        head,
        name: GATE_DISPLAY_CHECK,
        conclusion: required.pass ? 'success' : 'action_required',
        title: required.pass ? 'gate-artifact: pass' : 'gate-artifact: blocked',
        summary: requiredSummary,
        detailsUrl,
      })
    } catch (error) {
      process.stderr.write(`publish-gate: display check not published: ${error instanceof Error ? error.message : String(error)}\n`)
    }
    process.stdout.write(`${JSON.stringify({ mode, required: requiredPublished, display: displayPublished, decision: required })}\n`)
    // A blocked decision is carried by the required commit status. Keep the
    // publisher job green for a published decision; only unexpected errors use
    // exit code 1.
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`publish-gate: ${message}\n`)
    if (statusContext !== null) {
      try {
        await publishGateStatus({
          ...statusContext,
          state: 'error',
          description: `${mode}: gate publisher failed`,
        })
      } catch (statusError) {
        process.stderr.write(`publish-gate: error status not published: ${statusError instanceof Error ? statusError.message : String(statusError)}\n`)
      }
    }
    process.exitCode = 1
  }
}
