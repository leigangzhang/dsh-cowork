#!/usr/bin/env node
/**
 * Validate that a GitHub review carries a passing review-verdict marker for the
 * exact commit under review.
 *
 * The single-account setup cannot use GitHub's own approval state, so the
 * independent reviewer posts a review comment instead. This module owns the
 * marker syntax and the head/state checks that make a stale review unusable.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MARKER = /<!--\s*review-verdict:v1\s+head=([0-9a-f]{40})\s+verdict=(pass|needs_revision|reject)\s+reviewer=([a-z0-9._-]+)\s+model=([^\s>]+)\s*-->/iu

/**
 * @param {{ state: string, commitId: string, body: string, headSha: string }} input
 *   The GitHub review state, reviewed commit, review body, and current PR head.
 * @returns {{ headSha: string, verdict: 'pass', reviewer: string, model: string }}
 *   The validated verdict identity.
 * @throws {Error} When the review is not a passing verdict for this head.
 */
export function parseReviewVerdict({ state, commitId, body, headSha }) {
  const normalizedState = String(state ?? '').toLowerCase()
  if (normalizedState !== 'approved' && normalizedState !== 'commented') {
    throw new Error(`review state ${normalizedState || '<empty>'} cannot carry a passing verdict`)
  }
  if (commitId !== headSha) {
    throw new Error(`review commit ${commitId || '<empty>'} does not match PR head ${headSha || '<empty>'}`)
  }
  const match = String(body ?? '').match(MARKER)
  if (match === null) {
    throw new Error('review body has no review-verdict:v1 marker')
  }
  const [, markerHead, verdict, reviewer, model] = match
  if (markerHead.toLowerCase() !== headSha.toLowerCase()) {
    throw new Error(`review-verdict head ${markerHead} does not match PR head ${headSha}`)
  }
  if (verdict !== 'pass') {
    throw new Error(`review-verdict is ${verdict}, not pass`)
  }
  if (reviewer !== 'agentteam' && reviewer !== 'human') {
    throw new Error(`reviewer ${reviewer} must be agentteam or human`)
  }
  if (model.trim() === '') {
    throw new Error('review-verdict model must not be empty')
  }
  return { headSha, verdict, reviewer, model }
}

const invoked = process.argv[1]
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  try {
    const verdict = parseReviewVerdict({
      state: process.env.REVIEW_STATE ?? '',
      commitId: process.env.REVIEW_COMMIT_ID ?? '',
      body: process.env.REVIEW_BODY ?? '',
      headSha: process.env.HEAD_SHA ?? '',
    })
    process.stdout.write(`${JSON.stringify(verdict)}\n`)
  } catch (error) {
    process.stderr.write(`review-verdict: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
