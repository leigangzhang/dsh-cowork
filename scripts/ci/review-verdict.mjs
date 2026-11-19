#!/usr/bin/env node
/**
 * Validate that a GitHub review carries a passing review-verdict marker for the
 * exact commit under review.
 *
 * v2 adds the review base and the binary-diff SHA-256. The derived gate uses
 * those fields to prove that a base advance did not silently change the
 * reviewed patch. v1 remains accepted by the legacy review workflow during the
 * rollout so existing open PRs do not lose their recorded verdict.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const V1 = /<!--\s*review-verdict:v1\s+head=([0-9a-f]{40})\s+verdict=(pass|needs_revision|reject)\s+reviewer=([a-z0-9._-]+)\s+model=([^\s>]+)\s*-->/iu
const V2 = /<!--\s*review-verdict:v2\s+head=([0-9a-f]{40})\s+base=([0-9a-f]{40})\s+diffSha=([0-9a-f]{64})\s+verdict=(pass|needs_revision|reject)\s+reviewer=([a-z0-9._-]+)\s+model=([^\s>]+)\s*-->/iu

/**
 * Parse one review-verdict marker without requiring a passing verdict.
 *
 * @param {{ state: string, commitId: string, body: string, headSha: string, requireV2?: boolean }} input
 *   The GitHub review state, reviewed commit, review body, current PR head, and
 *   whether the caller requires the v2 marker.
 * @returns {{ markerVersion: 'v1' | 'v2', headSha: string, baseSha?: string, diffSha?: string,
 *   verdict: 'pass' | 'needs_revision' | 'reject', reviewer: string, model: string }}
 *   The validated review marker.
 * @throws {Error} When the review does not carry a marker for this head.
 */
export function parseReviewMarker({ state, commitId, body, headSha, requireV2 = false }) {
  const normalizedState = String(state ?? '').toLowerCase()
  if (normalizedState !== 'approved' && normalizedState !== 'commented') {
    throw new Error(`review state ${normalizedState || '<empty>'} cannot carry a review verdict`)
  }
  if (commitId !== headSha) {
    throw new Error(`review commit ${commitId || '<empty>'} does not match PR head ${headSha || '<empty>'}`)
  }
  const text = String(body ?? '')
  const v2 = text.match(V2)
  if (v2 !== null) {
    const [, markerHead, baseSha, diffSha, verdict, reviewer, model] = v2
    if (markerHead.toLowerCase() !== headSha.toLowerCase()) {
      throw new Error(`review-verdict head ${markerHead} does not match PR head ${headSha}`)
    }
    validateReviewerAndModel(reviewer, model)
    return { markerVersion: 'v2', headSha, baseSha, diffSha, verdict, reviewer, model }
  }

  if (requireV2) throw new Error('review body has no review-verdict:v2 marker')
  const v1 = text.match(V1)
  if (v1 === null) throw new Error('review body has no review-verdict:v1 or v2 marker')
  const [, markerHead, verdict, reviewer, model] = v1
  if (markerHead.toLowerCase() !== headSha.toLowerCase()) {
    throw new Error(`review-verdict head ${markerHead} does not match PR head ${headSha}`)
  }
  validateReviewerAndModel(reviewer, model)
  return { markerVersion: 'v1', headSha, verdict, reviewer, model }
}

/**
 * Parse one passing review-verdict marker.
 *
 * @param {{ state: string, commitId: string, body: string, headSha: string, requireV2?: boolean }} input
 *   The review identity and marker inputs.
 * @returns {{ markerVersion: 'v1' | 'v2', headSha: string, baseSha?: string, diffSha?: string,
 *   verdict: 'pass', reviewer: string, model: string }} The validated passing verdict.
 * @throws {Error} When the review marker is missing, malformed, or not `pass`.
 */
export function parseReviewVerdict(input) {
  const marker = parseReviewMarker(input)
  if (marker.verdict !== 'pass') {
    throw new Error(`review-verdict is ${marker.verdict}, not pass`)
  }
  return marker
}

function validateReviewerAndModel(reviewer, model) {
  if (reviewer !== 'agentteam' && reviewer !== 'human') {
    throw new Error(`reviewer ${reviewer} must be agentteam or human`)
  }
  if (model.trim() === '') throw new Error('review-verdict model must not be empty')
}

const invoked = process.argv[1]
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  try {
    const verdict = parseReviewVerdict({
      state: process.env.REVIEW_STATE ?? '',
      commitId: process.env.REVIEW_COMMIT_ID ?? '',
      body: process.env.REVIEW_BODY ?? '',
      headSha: process.env.HEAD_SHA ?? '',
      requireV2: process.env.REQUIRE_REVIEW_V2 === '1',
    })
    process.stdout.write(`${JSON.stringify(verdict)}\n`)
  } catch (error) {
    process.stderr.write(`review-verdict: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
