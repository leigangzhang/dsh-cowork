import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CONTENT_B_FIXED,
  CONTENT_B_INITIAL,
  FILE_A,
  FILE_B,
  FINDING_ID,
  MASTER_DONE,
  MERGE_TOOL,
  M3_E2E_EVIDENCE_RELATIVE,
  M3_E2E_FIXTURE_RELATIVE,
  M3_E2E_POLL_MS,
  M3_E2E_RUN_PATH,
  M3_E2E_STATUS_PATH,
  M3_E2E_STEP_TIMEOUT_MS,
  M3_STEP_IDS,
  REVIEWER_PRESET_ID,
  REVIEW_FINDING,
  REVIEW_REQUEST_TOOL,
  REVIEW_VERDICT_TOOL,
  assertionForReview,
  buildRepairPrompt,
  buildReviewerNeedsRevisionPrompt,
  buildReviewerPassPrompt,
  reviewStateOf,
  stepFailureState,
} from '../src/m3-e2e.ts'

const here = dirname(fileURLToPath(import.meta.url))
const driverPath = join(here, '..', 'src', 'm3-e2e.ts')

/** The per-file budget the driver must stay under (same rule as the M2 driver). */
const FILE_BUDGET_BYTES = 50 * 1024

const reviewInput = {
  threadId: 'thread-1234',
  subject: 'M3 E2E review pass',
  repoPath: '/repo',
  checkoutPath: '/repo/.dsh-cowork/threads/thread-1234',
  fileName: FILE_A,
  verificationCommand: `test -f ${FILE_A}`,
}

test('M3_STEP_IDS is the fifteen-step M3 sequence in order', () => {
  assert.deepEqual(M3_STEP_IDS, [
    'setup',
    'thread-a-create',
    'thread-a-work',
    'review-a-request',
    'review-a-pass',
    'merge-a',
    'thread-b-create',
    'thread-b-work',
    'review-b-request',
    'review-b-needs-revision',
    'thread-b-repair',
    'review-b-request-2',
    'review-b-pass',
    'merge-b',
    'cleanup',
  ])
  assert.equal(M3_STEP_IDS.length, 15)
  assert.equal(new Set(M3_STEP_IDS).size, 15)
})

test('the two review rounds keep their gate order', () => {
  const at = (id) => M3_STEP_IDS.indexOf(id)

  // Round A: request, pass, then merge only after the pass.
  assert.equal(at('review-a-pass'), at('review-a-request') + 1)
  assert.equal(at('merge-a'), at('review-a-pass') + 1)
  // Round B: needs_revision, repair, a fresh request, pass, merge.
  assert.equal(at('thread-b-repair'), at('review-b-needs-revision') + 1)
  assert.equal(at('review-b-request-2'), at('thread-b-repair') + 1)
  assert.equal(at('review-b-pass'), at('review-b-request-2') + 1)
  assert.equal(at('merge-b'), at('review-b-pass') + 1)
  assert.equal(M3_STEP_IDS.at(-1), 'cleanup')
})

test('the driver constants name the frozen M3 surface', () => {
  assert.equal(M3_E2E_EVIDENCE_RELATIVE, '.dsh-cowork/e2e/M3_E2E.json')
  assert.equal(M3_E2E_FIXTURE_RELATIVE, '.dsh-cowork/e2e/m3-repo')
  assert.equal(M3_E2E_RUN_PATH, '/dsh-cowork/e2e/m3/run')
  assert.equal(M3_E2E_STATUS_PATH, '/dsh-cowork/e2e/m3/status')
  assert.equal(M3_E2E_STEP_TIMEOUT_MS, 180_000)
  assert.equal(M3_E2E_POLL_MS, 500)
  assert.equal(REVIEW_REQUEST_TOOL, 'cowork_review_request')
  assert.equal(REVIEW_VERDICT_TOOL, 'cowork_review_verdict')
  assert.equal(MERGE_TOOL, 'cowork_checkout_merge')
  assert.equal(REVIEWER_PRESET_ID, 'cowork-reviewer')
})

test('the pass prompt carries the thread, the tool, and verdict pass', () => {
  const prompt = buildReviewerPassPrompt(reviewInput)

  assert.equal(prompt.includes(reviewInput.threadId), true)
  assert.equal(prompt.includes(REVIEW_VERDICT_TOOL), true)
  assert.equal(prompt.includes('"verdict": "pass"'), true)
  assert.equal(prompt.includes(reviewInput.checkoutPath), true)
  assert.equal(prompt.includes(reviewInput.verificationCommand), true)
  assert.equal(prompt.includes('needs_revision'), false)
  assert.equal(prompt.includes(`${MASTER_DONE}`), true)
})

test('the pass prompt asks for a real command run, not a copied verdict', () => {
  const prompt = buildReviewerPassPrompt(reviewInput)

  assert.match(prompt, /bash tool/)
  assert.match(prompt, /real exit code/)
  assert.equal(prompt.includes('<copy the real command output here>'), true)
})

test('the needs_revision prompt carries the finding as a JSON literal', () => {
  const prompt = buildReviewerNeedsRevisionPrompt({
    ...reviewInput,
    fileName: FILE_B,
    verificationCommand: `test -f ${FILE_B}`,
    finding: REVIEW_FINDING,
  })

  assert.equal(prompt.includes(reviewInput.threadId), true)
  assert.equal(prompt.includes(REVIEW_VERDICT_TOOL), true)
  assert.equal(prompt.includes('"verdict": "needs_revision"'), true)
  assert.equal(prompt.includes(FINDING_ID), true)
  assert.equal(prompt.includes('"severity": "high"'), true)
  assert.equal(prompt.includes(CONTENT_B_INITIAL), true)
  assert.equal(prompt.includes(`rewrite ${FILE_B} to content ${CONTENT_B_FIXED}`), true)
})

test('the repair prompt carries the finding and the re-handoff requirement', () => {
  const prompt = buildRepairPrompt({
    threadId: 'thread-b',
    checkoutPath: '/repo/.dsh-cowork/threads/thread-b',
    fileName: FILE_B,
    fixedContent: CONTENT_B_FIXED,
    finding: REVIEW_FINDING,
  })

  assert.equal(prompt.includes('thread-b'), true)
  assert.equal(prompt.includes(FINDING_ID), true)
  assert.equal(prompt.includes(REVIEW_FINDING.problem), true)
  assert.equal(prompt.includes(REVIEW_FINDING.requiredFix), true)
  assert.equal(prompt.includes(CONTENT_B_FIXED), true)
  assert.equal(prompt.includes('cowork_handoff'), true)
  assert.equal(prompt.includes('awaiting_review'), true)
})

test('reviewStateOf returns null when the index or the thread is absent', () => {
  assert.equal(reviewStateOf(undefined, 't1'), null)
  assert.equal(reviewStateOf(null, 't1'), null)
  assert.equal(reviewStateOf({ masterSessionId: 'm', threads: [] }, 't1'), null)
})

test('reviewStateOf normalises missing review fields to null', () => {
  const index = {
    masterSessionId: 'm',
    threads: [{ threadId: 't1', status: 'awaiting_review', checkoutPath: '/clone' }],
  }
  const state = reviewStateOf(index, 't1')

  assert.deepEqual(state, {
    threadId: 't1',
    status: 'awaiting_review',
    checkoutPath: '/clone',
    reviewStatus: null,
    reviewerSessionId: null,
    reviewedAt: null,
    latestReviewPath: null,
  })
})

test('reviewStateOf returns the review fields the index stores', () => {
  const index = {
    masterSessionId: 'm',
    threads: [{
      threadId: 't2',
      status: 'done',
      checkoutPath: null,
      reviewStatus: 'pass',
      reviewerSessionId: 'reviewer-1',
      reviewedAt: '2026-01-01T00:00:00.000Z',
      latestReviewPath: '/repo/.dsh-cowork/reviews/t2-1.json',
    }],
  }
  const state = reviewStateOf(index, 't2')

  assert.equal(state.reviewStatus, 'pass')
  assert.equal(state.reviewerSessionId, 'reviewer-1')
  assert.equal(state.reviewedAt, '2026-01-01T00:00:00.000Z')
  assert.equal(state.latestReviewPath, '/repo/.dsh-cowork/reviews/t2-1.json')
  assert.equal(state.checkoutPath, null)
})

test('assertionForReview passes equal durable values and fails different ones', () => {
  const pass = assertionForReview('review file verdict', 'pass', 'pass')
  assert.equal(pass.name, 'review file verdict')
  assert.equal(pass.ok, true)
  assert.equal(pass.evidence.includes('expected="pass"'), true)

  const fail = assertionForReview('review file verdict', 'pass', 'needs_revision')
  assert.equal(fail.ok, false)
  assert.equal(fail.evidence.includes('actual="needs_revision"'), true)
})

test('a step error maps to the terminal failed state with its step id', () => {
  assert.deepEqual(stepFailureState('review-a-pass', new Error('boom')), {
    state: 'failed',
    error: 'step review-a-pass: boom',
  })
  assert.deepEqual(stepFailureState('merge-b', 'plain text'), {
    state: 'failed',
    error: 'step merge-b: plain text',
  })
})

test('the runner exposes start, resolve, attachEvents, and dispose', () => {
  const source = readFileSync(driverPath, 'utf8')

  for (const member of ['start():', 'resolve(runId', 'attachEvents():', 'dispose():', 'private async execute(']) {
    assert.equal(source.includes(member), true, `driver is missing ${member}`)
  }
  // One run at a time: a second start while running is rejected.
  assert.match(source, /still running/)
  // Evidence is written atomically, not with a bare writeFile.
  assert.match(source, /writeEvidenceAtomic/)
  assert.match(source, /rename\(temp, file\)/)
})

test('the driver keeps only built-in runtime imports so node --test can load it', () => {
  const lines = readFileSync(driverPath, 'utf8').split('\n')
  const valueImports = lines.filter((line) => /^import \{/.test(line))
  for (const line of valueImports) {
    assert.equal(/from 'node:/.test(line), true, `unexpected runtime import: ${line}`)
  }
})

test('the driver stays within the per-file budget', () => {
  const size = statSync(driverPath).size
  assert.ok(size > 0, driverPath)
  assert.ok(size <= FILE_BUDGET_BYTES, `${driverPath} is ${size} bytes, above ${FILE_BUDGET_BYTES}`)
})
