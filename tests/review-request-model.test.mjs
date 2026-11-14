import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import './support/ts-hook.mjs'
// `src/review-request.ts` imports its siblings with the build's `.js`
// specifiers, which Node's type stripping does not retry as `.ts`; this test
// installs the same small resolve hook tests/presets.test.mjs uses.
import { withRepo } from './support/inbox-fixtures.mjs'

const {
  REVIEW_BRIEF_MAX_CHARS,
  REVIEW_CHANGED_PATHS_MAX,
  REVIEW_EXTRA_MAX_BYTES,
  REVIEW_EXTRA_MAX_DEPTH,
  REVIEW_EXTRA_MAX_KEYS,
  REVIEW_NOTES_MAX_CHARS,
  REVIEW_PATH_MAX_CHARS,
  REVIEW_PURPOSE_MAX_CHARS,
  REVIEW_REQUEST_ID_PATTERN,
  REVIEW_SUMMARY_MAX_CHARS,
  REVIEW_VERIFICATION_MAX_ROWS,
  buildReviewBrief,
  buildReviewRequestRecord,
  checkPreviousRequest,
  deriveReviewOutcome,
  isValidReviewRequestId,
  mergeGate,
  parseReviewRequestRecord,
  reviewRequestFileName,
  reviewRequestFilePath,
  reviewRequestRecordProblems,
  serializeReviewRequestRecord,
  validateReviewRequestInput,
} = await import('../src/review-request.ts')
const { ERROR_CODES, M10_ERROR_CODES } = await import('../src/tool-model.ts')
const { REVIEWER_PRESET_ID: PRESETS_REVIEWER_ID } = await import('../src/presets.ts')
const schema = await import('../src/store-schema.ts')

/**
 * Contract tests for the pure M10 review-request model (`src/review-request.ts`):
 * field validation, the request record on disk, the previous-request chain, the
 * verdict outcome, the merge gate, and the reviewer brief. Everything here is
 * in memory: no `.dsh-cowork/`, no git, no clock.
 */

const REPO = '/repo/project'
const WORK_ITEM_PATH = '/repo/project/.dsh-cowork/workitems/wi-1'
const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const REQUESTED_AT = new Date('2026-11-08T00:00:00.000Z')
const REVIEWED_AT = '2026-11-08T01:00:00.000Z'

/** A complete valid request input; overrides replace one field at a time. */
const requestInput = (overrides = {}) => ({
  purpose: 'review the work item change',
  baseCommit: BASE,
  headCommit: HEAD,
  path: WORK_ITEM_PATH,
  verification: [{ command: 'node --test tests/review-request.test.mjs', exitCode: 0, evidence: '6 pass' }],
  notes: 'ready for the independent review',
  extra: { requestTag: 'wi-1' },
  previousRequestId: null,
  ...overrides,
})

/** The trusted scope the tool derives from the index and git, never the model. */
const requestScope = (overrides = {}) => ({
  topicId: 'session-topic',
  workItemId: 'wi-1',
  repoPath: REPO,
  workItemPath: WORK_ITEM_PATH,
  branch: 'cowork/wi-1',
  changedPaths: ['src/review-request.ts', 'tests/review-request.test.mjs'],
  ...overrides,
})

/** Validate a request input against the default scope. */
const validate = (input = requestInput(), scope = requestScope()) =>
  validateReviewRequestInput(input, scope)

/** The rejected field names of an invalid input. */
function refusedFields(input, scope = requestScope()) {
  const result = validate(input, scope)
  assert.equal(result.ok, false, 'the input was expected to be rejected')
  return result.errors.map((error) => error.field)
}

/** One nested object `levels` containers deep. */
function nested(levels) {
  let value = 'leaf'
  for (let index = 0; index < levels; index += 1) value = { next: value }
  return value
}

/** The validated draft every record fixture starts from. */
function draft() {
  const result = validate()
  assert.equal(result.ok, true, 'the default request fixture must validate')
  return result.value
}

/** A pending record as the review-request tool writes it. */
function pendingRecord(overrides = {}) {
  return buildReviewRequestRecord(draft(), {
    requestId: 'req-1',
    reviewerSessionId: 'session-reviewer',
    requestedAt: REQUESTED_AT,
    ...overrides,
  })
}

/** A terminal (answered) version of the pending record. */
function answeredRecord(overrides = {}) {
  return {
    ...pendingRecord(),
    status: 'pass',
    reviewedAt: REVIEWED_AT,
    summary: 'the change holds up',
    findings: [],
    reviewVerification: [{ command: 'node --test tests/review-request.test.mjs', exitCode: 0, evidence: 'pass' }],
    ...overrides,
  }
}


const gateInput = (overrides = {}) => ({
  request: answeredRecord(),
  headCommit: HEAD,
  baseIsAncestor: true,
  workItemStatus: 'reviewing',
  workTreeClean: true,
  ...overrides,
})

/**
 * Contract tests for the M10 review-request model (`src/review-request.ts`):
 * input validation, the record layer, the previous-round chain, the verdict
 * table, and the one home of the review vocabularies. No host, no tool, no git.
 * The merge gate, the reviewer brief and the review tool surface live in
 * `review-request-gate.test.mjs`.
 */
// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

test('a complete request validates and keeps every field', () => {
  const result = validate()
  assert.equal(result.ok, true, JSON.stringify(result.ok ? {} : result.errors))
  assert.deepEqual(result.value, {
    topicId: 'session-topic',
    workItemId: 'wi-1',
    purpose: 'review the work item change',
    notes: 'ready for the independent review',
    extra: { requestTag: 'wi-1' },
    baseCommit: BASE,
    headCommit: HEAD,
    path: WORK_ITEM_PATH,
    branch: 'cowork/wi-1',
    changedPaths: ['src/review-request.ts', 'tests/review-request.test.mjs'],
    verification: [{ command: 'node --test tests/review-request.test.mjs', exitCode: 0, evidence: '6 pass' }],
    previousRequestId: null,
  })
})

test('purpose, base, head, path, and verification are required', () => {
  for (const field of ['purpose', 'baseCommit', 'headCommit', 'path', 'verification']) {
    const input = requestInput()
    delete input[field]
    const result = validate(input)
    assert.equal(result.ok, false, `${field} must be required`)
    assert.equal(result.code, M10_ERROR_CODES.reviewRequestInvalid)
    assert.ok(
      result.errors.some((error) => error.field === field),
      `the refusal must name ${field}: ${JSON.stringify(result.errors)}`,
    )
  }
})

test('blank strings do not satisfy a required field', () => {
  assert.deepEqual(refusedFields(requestInput({ purpose: '   ' })), ['purpose'])
  assert.deepEqual(refusedFields(requestInput({ baseCommit: '' })), ['baseCommit'])
  assert.deepEqual(refusedFields(requestInput({ headCommit: '' })), ['headCommit'])
})

test('base and head must name different commits and stable commit ids', () => {
  const same = validate(requestInput({ headCommit: BASE }))
  assert.equal(same.ok, false)
  assert.equal(same.code, M10_ERROR_CODES.reviewBaseEqualsHead)

  for (const field of ['baseCommit', 'headCommit']) {
    const result = validate(requestInput({ [field]: 'HEAD' }))
    assert.equal(result.ok, false, `${field} must reject a non-sha value`)
    assert.ok(result.errors.some((error) => error.field === field), JSON.stringify(result.errors))
  }
})

test('the path must stay inside the repository or the work-item checkout', () => {
  // The repository root, a subdirectory of it, and the work-item clone are all
  // allowed; anything else is a refusal with its own error code.
  for (const path of [REPO, `${REPO}/src`, WORK_ITEM_PATH]) {
    assert.equal(validate(requestInput({ path })).ok, true, `${path} must be allowed`)
  }
  for (const path of ['/repo/other', `${WORK_ITEM_PATH}/../../../../etc/passwd`, 'src', '/']) {
    const result = validate(requestInput({ path }))
    assert.equal(result.ok, false, `${path} must be refused`)
    assert.equal(result.code, M10_ERROR_CODES.reviewPathOutside, `code for ${path}`)
    assert.ok(result.errors.some((error) => error.field === 'path'), JSON.stringify(result.errors))
  }
  // A missing path is a shape problem, not an escape attempt.
  const missing = validate(requestInput({ path: '' }))
  assert.equal(missing.ok, false)
  assert.equal(missing.code, M10_ERROR_CODES.reviewRequestInvalid)
  // A path with a NUL or control character never reaches git.
  const control = validate(requestInput({ path: `${REPO}/src\u0000.ts` }))
  assert.equal(control.ok, false)
  assert.equal(control.code, M10_ERROR_CODES.reviewPathOutside)
})

test('an unbounded path is refused', () => {
  const long = `${REPO}/${'a'.repeat(REVIEW_PATH_MAX_CHARS)}`
  const result = validate(requestInput({ path: long }))
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.field === 'path'), JSON.stringify(result.errors))
})

test('verification must be a non-empty bounded array of complete rows', () => {
  assert.deepEqual(refusedFields(requestInput({ verification: [] })), ['verification'])
  assert.deepEqual(refusedFields(requestInput({ verification: 'npm test' })), ['verification'])

  const rows = Array.from({ length: REVIEW_VERIFICATION_MAX_ROWS + 1 }, (_, index) => ({
    command: `npm run check #${index}`,
    exitCode: 0,
    evidence: 'ok',
  }))
  assert.deepEqual(refusedFields(requestInput({ verification: rows })), ['verification'])

  for (const row of [
    { command: '', exitCode: 0, evidence: 'ok' },
    { command: 'npm test', exitCode: 0.5, evidence: 'ok' },
    { command: 'npm test', exitCode: 0 },
    { command: 'npm test', exitCode: 0, evidence: 'x'.repeat(2001) },
  ]) {
    const result = validate(requestInput({ verification: [row] }))
    assert.equal(result.ok, false, JSON.stringify(row))
    assert.ok(result.errors.some((error) => error.field.startsWith('verification')), JSON.stringify(result.errors))
  }
})

test('purpose, notes, summary, and branch are bounded', () => {
  assert.deepEqual(refusedFields(requestInput({ purpose: 'x'.repeat(REVIEW_PURPOSE_MAX_CHARS + 1) })), ['purpose'])
  assert.deepEqual(refusedFields(requestInput({ notes: 'x'.repeat(REVIEW_NOTES_MAX_CHARS + 1) })), ['notes'])
  assert.deepEqual(refusedFields(requestInput({ extra: 'not-an-object' })), ['extra'])
  assert.deepEqual(refusedFields(requestInput(), requestScope({ branch: 42 })), ['branch'])
  assert.deepEqual(refusedFields(requestInput({ previousRequestId: 'not a request id' })), ['previousRequestId'])

  // The summary belongs to the verdict, so the record layer bounds it instead.
  const longSummary = answeredRecord({ summary: 'x'.repeat(REVIEW_SUMMARY_MAX_CHARS + 1) })
  assert.ok(
    reviewRequestRecordProblems(longSummary).some((problem) => problem.includes('summary')),
    'a stored summary must be bounded',
  )
})

test('extra is capped at 20 keys of bounded JSON', () => {
  const tooMany = Object.fromEntries(
    Array.from({ length: REVIEW_EXTRA_MAX_KEYS + 1 }, (_, index) => [`key${index}`, index]),
  )
  assert.deepEqual(refusedFields(requestInput({ extra: tooMany })), ['extra'])

  for (const value of [Number.NaN, undefined, () => 1, Number.POSITIVE_INFINITY]) {
    const result = validate(requestInput({ extra: { bad: value } }))
    assert.equal(result.ok, false, `${String(value)} must be refused`)
    assert.ok(result.errors.some((error) => error.field === 'extra.bad'), JSON.stringify(result.errors))
  }

  // Depth 4 is inside the bound; depth 5 is not.
  assert.equal(validate(requestInput({ extra: { deep: nested(REVIEW_EXTRA_MAX_DEPTH) } })).ok, true)
  assert.deepEqual(
    refusedFields(requestInput({ extra: { deep: nested(REVIEW_EXTRA_MAX_DEPTH + 1) } })),
    ['extra.deep'],
  )

  // A value whose serialization exceeds the byte bound is refused.
  const big = validate(requestInput({ extra: { big: 'x'.repeat(REVIEW_EXTRA_MAX_BYTES) } }))
  assert.equal(big.ok, false)
  assert.ok(big.errors.some((error) => error.field === 'extra.big'), JSON.stringify(big.errors))

  // A value just under the bound is fine.
  const small = validate(requestInput({ extra: { big: 'x'.repeat(REVIEW_EXTRA_MAX_BYTES - 10) } }))
  assert.equal(small.ok, true)

  // The stored record applies the same rule to a value JSON would silently drop.
  const problems = reviewRequestRecordProblems(answeredRecord({ extra: { cb: () => 1 } }))
  assert.ok(problems.some((problem) => problem.includes('review.extra.cb')), problems.join('\n'))
})

test('changedPaths is derived, bounded, and path-shaped', () => {
  const tooMany = Array.from({ length: REVIEW_CHANGED_PATHS_MAX + 1 }, (_, index) => `src/file-${index}.ts`)
  assert.deepEqual(refusedFields(requestInput(), requestScope({ changedPaths: tooMany })), ['changedPaths'])
  assert.deepEqual(refusedFields(requestInput(), requestScope({ changedPaths: ['src/ok.ts', ''] })), ['changedPaths'])
})

test('the topic and work-item ids must be usable in a file name', () => {
  for (const scope of [
    requestScope({ topicId: 'session/topic' }),
    requestScope({ topicId: '..' }),
    requestScope({ workItemId: 'wi 1' }),
  ]) {
    const result = validate(requestInput(), scope)
    assert.equal(result.ok, false, JSON.stringify(scope))
    assert.equal(result.code, M10_ERROR_CODES.reviewRequestInvalid)
  }
  assert.equal(validate(requestInput(), requestScope({ workItemId: null, workItemPath: null })).ok, true)
})

test('validation is deterministic: the same input yields the same refusal twice', () => {
  const input = requestInput({ purpose: '', headCommit: BASE })
  assert.deepEqual(validate(input), validate(input))
})

// ---------------------------------------------------------------------------
// record layer
// ---------------------------------------------------------------------------

test('buildReviewRequestRecord stamps a pending record', () => {
  assert.deepEqual(pendingRecord(), {
    version: 1,
    requestId: 'req-1',
    topicId: 'session-topic',
    workItemId: 'wi-1',
    purpose: 'review the work item change',
    notes: 'ready for the independent review',
    extra: { requestTag: 'wi-1' },
    baseCommit: BASE,
    headCommit: HEAD,
    path: WORK_ITEM_PATH,
    branch: 'cowork/wi-1',
    changedPaths: ['src/review-request.ts', 'tests/review-request.test.mjs'],
    verification: [{ command: 'node --test tests/review-request.test.mjs', exitCode: 0, evidence: '6 pass' }],
    previousRequestId: null,
    status: 'pending',
    reviewerSessionId: 'session-reviewer',
    requestedAt: REQUESTED_AT.toISOString(),
    reviewedAt: null,
    summary: null,
    findings: [],
    reviewVerification: [],
  })
})

test('a record cannot be built with an unsafe request id or an empty reviewer', () => {
  assert.throws(() => pendingRecord({ requestId: '../req-1' }), TypeError)
  assert.throws(() => pendingRecord({ requestId: '' }), TypeError)
  assert.throws(() => pendingRecord({ reviewerSessionId: '' }), TypeError)
})

test('a record survives serialize → parse unchanged', () => {
  const record = pendingRecord()
  const parsed = parseReviewRequestRecord(serializeReviewRequestRecord(record))
  assert.equal(parsed.ok, true, JSON.stringify(parsed.ok ? {} : parsed.problems))
  assert.deepEqual(parsed.record, record)

  const answered = answeredRecord()
  const roundTrip = parseReviewRequestRecord(serializeReviewRequestRecord(answered))
  assert.equal(roundTrip.ok, true, JSON.stringify(roundTrip.ok ? {} : roundTrip.problems))
  assert.deepEqual(roundTrip.record, answered)
})

/** One record with a top-level field removed. */
function without(record, field) {
  const copy = { ...record }
  delete copy[field]
  return copy
}

test('parse refuses every broken record instead of guessing', () => {
  const cases = [
    ['a record without extra', without(answeredRecord(), 'extra')],
    ['a record without changedPaths', without(answeredRecord(), 'changedPaths')],
    ['a record without reviewVerification', without(answeredRecord(), 'reviewVerification')],
    ['version 2', answeredRecord({ version: 2 })],
    ['an unknown status', answeredRecord({ status: 'approved' })],
    ['pending with a review timestamp', { ...pendingRecord(), reviewedAt: REVIEWED_AT }],
    ['pending without a reviewer session', { ...pendingRecord(), reviewerSessionId: '' }],
    ['a terminal record without reviewedAt', answeredRecord({ reviewedAt: null })],
    ['a terminal record without a summary', answeredRecord({ summary: '' })],
    ['a non-pass verdict without findings', answeredRecord({ status: 'needs_revision', findings: [] })],
    ['a wrong-shaped verification row', { ...pendingRecord(), verification: [{ command: 'npm test' }] }],
    ['an unsafe request id', { ...pendingRecord(), requestId: 'req/1' }],
    ['an unsafe topic id', { ...pendingRecord(), topicId: '../topic' }],
  ]
  for (const [label, record] of cases) {
    const parsed = parseReviewRequestRecord(JSON.stringify(record))
    assert.equal(parsed.ok, false, `${label} must be refused`)
    assert.ok(parsed.problems.length > 0, `${label} must name its problems`)
  }
  assert.equal(parseReviewRequestRecord('{not json').ok, false)
})

test('parse refuses the legacy verdict-only review record', () => {
  // The M3/M9 file shape: verdict-only, no requestId and no status. Old files
  // stay read-only and must never be mistaken for a review request.
  const legacyRecord = {
    version: 1,
    threadId: 'session-topic',
    reviewerSessionId: 'session-reviewer',
    verdict: 'pass',
    summary: 'the old model',
    findings: [],
    verification: [],
    createdAt: REQUESTED_AT.toISOString(),
  }
  const parsed = parseReviewRequestRecord(JSON.stringify(legacyRecord))
  assert.equal(parsed.ok, false)
  const problems = parsed.problems.join('\n')
  assert.match(problems, /requestId/)
  assert.match(problems, /status/)
})

test('the request file is <topicId>-<requestId>.json under reviews/', () => {
  assert.equal(reviewRequestFileName('session-topic', 'req-1'), 'session-topic-req-1.json')
  assert.equal(reviewRequestFilePath('/repo/.dsh-cowork/reviews', 'session-topic', 'req-1'),
    join('/repo/.dsh-cowork/reviews', 'session-topic-req-1.json'))

  for (const [topicId, requestId] of [['session/topic', 'req-1'], ['session-topic', '../req'], ['', 'req-1'], ['..', 'req-1']]) {
    assert.equal(reviewRequestFileName(topicId, requestId), null, `${topicId} / ${requestId}`)
    assert.equal(reviewRequestFilePath('/reviews', topicId, requestId), null)
  }
  assert.equal(isValidReviewRequestId('req-1'), true)
  assert.equal(isValidReviewRequestId('req.1_a-b'), true)
  assert.equal(isValidReviewRequestId('req 1'), false)
  assert.equal(REVIEW_REQUEST_ID_PATTERN.test('req-1'), true)
})

// ---------------------------------------------------------------------------
// previous request chain
// ---------------------------------------------------------------------------

test('previousRequestId must name a terminal request of the same topic and work item', () => {
  const previous = answeredRecord()
  assert.equal(checkPreviousRequest({ previousRequestId: null, previous: null, topicId: 'session-topic', workItemId: 'wi-1' }), null)
  assert.equal(
    checkPreviousRequest({ previousRequestId: 'req-1', previous, topicId: 'session-topic', workItemId: 'wi-1' }),
    null,
  )

  const refusals = [
    ['a missing previous request', { previousRequestId: 'req-1', previous: null, topicId: 'session-topic', workItemId: 'wi-1' }],
    ['a different topic', { previousRequestId: 'req-1', previous, topicId: 'session-other', workItemId: 'wi-1' }],
    ['a different work item', { previousRequestId: 'req-1', previous, topicId: 'session-topic', workItemId: 'wi-2' }],
    ['a still-pending previous request', { previousRequestId: 'req-1', previous: pendingRecord(), topicId: 'session-topic', workItemId: 'wi-1' }],
  ]
  for (const [label, input] of refusals) {
    const refusal = checkPreviousRequest(input)
    assert.ok(refusal !== null, `${label} must be refused`)
    assert.equal(refusal.error.code, M10_ERROR_CODES.reviewPreviousInvalid, label)
  }
})

// ---------------------------------------------------------------------------
// verdict outcome
// ---------------------------------------------------------------------------

test('each verdict decides one topic state and one inbox kind', () => {
  assert.deepEqual(deriveReviewOutcome('pass', 'wi-1'), {
    reviewStatus: 'pass',
    blocked: false,
    awaitingReview: false,
    deliverToTopic: false,
    inboxKind: 'merge-needed',
    mergeNeeded: true,
  })
  assert.deepEqual(deriveReviewOutcome('pass', null), {
    reviewStatus: 'pass',
    blocked: false,
    awaitingReview: false,
    deliverToTopic: false,
    inboxKind: null,
    mergeNeeded: false,
  })
  assert.deepEqual(deriveReviewOutcome('needs_revision', 'wi-1'), {
    reviewStatus: 'needs_revision',
    blocked: false,
    awaitingReview: false,
    deliverToTopic: true,
    inboxKind: null,
    mergeNeeded: false,
  })
  assert.deepEqual(deriveReviewOutcome('reject', 'wi-1'), {
    reviewStatus: 'reject',
    blocked: true,
    awaitingReview: false,
    deliverToTopic: true,
    inboxKind: 'review-reject',
    mergeNeeded: false,
  })
})


// ---------------------------------------------------------------------------
// purity, error codes, and the legacy vocabulary
// ---------------------------------------------------------------------------

test('src/review-request.ts is host-free and clock-free', () => {
  const source = readFileSync(new URL('../src/review-request.ts', import.meta.url), 'utf8')
  for (const forbidden of [/node:fs/, /node:os/, /node:child_process/, /from '\.\/store\.js'/, /Math\.random/, /new Date\(/, /process\./]) {
    assert.equal(forbidden.test(source), false, `review-request.ts must not contain ${forbidden}`)
  }
  assert.ok(source.includes("from 'node:path'"), 'path joins are allowed through node:path')
})

test('M10.1 adds every M10 wire code in one table', () => {
  assert.deepEqual(M10_ERROR_CODES, {
    reviewRequestInvalid: 'review/request-invalid',
    reviewPathOutside: 'review/path-outside',
    reviewBaseNotAncestor: 'review/base-not-ancestor',
    reviewBaseEqualsHead: 'review/base-equals-head',
    reviewDirtyWorktree: 'review/dirty-worktree',
    reviewEmptyDiff: 'review/empty-diff',
    reviewChangedPathsMismatch: 'review/changed-paths-mismatch',
    reviewRequestNotFound: 'review/request-not-found',
    reviewNotPending: 'review/not-pending',
    reviewAlreadyReviewed: 'review/already-reviewed',
    reviewPreviousInvalid: 'review/previous-invalid',
    workItemNotFound: 'workitem/not-found',
    workItemAlreadyExists: 'workitem/already-exists',
    workItemProviderUnsupported: 'workitem/provider-unsupported',
    workItemCreateFailed: 'workitem/create-failed',
    workItemCleanupFailed: 'workitem/cleanup-failed',
    workItemNotReady: 'workitem/not-ready',
    checkoutProtectedBranch: 'checkout/protected-branch',
    checkoutHeadMismatch: 'checkout/head-mismatch',
  })
  // Every code this module can return is in a central table: the M10 one, or
  // the long-stable ERROR_CODES table when the code predates M10.
  assert.equal(ERROR_CODES.reviewNotPassed, 'review/not-passed')
  const table = new Set([...Object.values(M10_ERROR_CODES), ...Object.values(ERROR_CODES)])
  for (const code of [
    validate(requestInput({ purpose: '' }, requestScope())).code,
    validate(requestInput({ path: '/elsewhere' })).code,
    validate(requestInput({ headCommit: BASE })).code,
    checkPreviousRequest({ previousRequestId: 'req-1', previous: null, topicId: 'session-topic', workItemId: 'wi-1' }).error.code,
    mergeGate(gateInput({ request: null })).failure.error.code,
    mergeGate(gateInput({ request: answeredRecord({ status: 'reject', findings: [{ id: 'F1', severity: 'high', problem: 'p', requiredFix: 'f' }] }) })).failure.error.code,
    mergeGate(gateInput({ headCommit: null })).failure.error.code,
    mergeGate(gateInput({ workItemStatus: 'active' })).failure.error.code,
  ]) {
    assert.ok(table.has(code), `${code} must live in M10_ERROR_CODES`)
  }
})

test('the review vocabularies have one home in store-schema and one preset id', () => {
  assert.deepEqual([...schema.REVIEW_STATUSES], ['pending', 'pass', 'needs_revision', 'reject'])
  assert.deepEqual([...schema.REVIEW_VERDICTS], ['pass', 'needs_revision', 'reject'])
  assert.deepEqual([...schema.REVIEW_SEVERITIES], ['blocker', 'high', 'medium', 'low'])
  assert.equal(PRESETS_REVIEWER_ID, 'cowork-reviewer')
})

