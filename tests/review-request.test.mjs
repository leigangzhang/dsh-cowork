import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { register } from 'node:module'

// `src/review-request.ts` imports its siblings with the build's `.js`
// specifiers, which Node's type stripping does not retry as `.ts`; this test
// installs the same small resolve hook tests/presets.test.mjs uses.
const HOOK_SOURCE = [
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier.startsWith('.') && specifier.endsWith('.js')) {",
  "    try { return await nextResolve(specifier.slice(0, -3) + '.ts', context) } catch {}",
  '  }',
  '  return nextResolve(specifier, context)',
  '}',
].join('\n')
register(`data:text/javascript,${encodeURIComponent(HOOK_SOURCE)}`)

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
// merge gate
// ---------------------------------------------------------------------------

const gateInput = (overrides = {}) => ({
  request: answeredRecord(),
  headCommit: HEAD,
  baseIsAncestor: true,
  workItemStatus: 'reviewing',
  workTreeClean: true,
  ...overrides,
})

test('the merge gate accepts exactly a passed review of the current head', () => {
  assert.deepEqual(mergeGate(gateInput()), { ok: true })
})

test('each merge-gate refusal carries its stable code and a message', () => {
  const cases = [
    ['no request', gateInput({ request: null }), M10_ERROR_CODES.reviewRequestNotFound],
    ['not passed', gateInput({ request: answeredRecord({ status: 'needs_revision', findings: [{ id: 'F1', severity: 'high', problem: 'p', requiredFix: 'f' }] }) }), ERROR_CODES.reviewNotPassed],
    ['another head', gateInput({ headCommit: 'c'.repeat(40) }), M10_ERROR_CODES.checkoutHeadMismatch],
    ['unknown head', gateInput({ headCommit: null }), M10_ERROR_CODES.checkoutHeadMismatch],
    ['base not an ancestor', gateInput({ baseIsAncestor: false }), M10_ERROR_CODES.reviewBaseNotAncestor],
    ['work item still active', gateInput({ workItemStatus: 'active' }), M10_ERROR_CODES.workItemNotReady],
    ['work item already merged', gateInput({ workItemStatus: 'merged' }), M10_ERROR_CODES.workItemNotReady],
    ['unknown work item', gateInput({ workItemStatus: null }), M10_ERROR_CODES.workItemNotFound],
    ['dirty checkout', gateInput({ workTreeClean: false }), M10_ERROR_CODES.reviewDirtyWorktree],
  ]
  for (const [label, input, code] of cases) {
    const gate = mergeGate(input)
    assert.equal(gate.ok, false, `${label} must be refused`)
    assert.equal(gate.failure.error.code, code, label)
    assert.ok(gate.failure.error.message.length > 0, `${label} must explain itself`)
  }

  // A shared-tree request has no work item, so there is nothing to merge.
  const shared = mergeGate(gateInput({ request: answeredRecord({ workItemId: null }), workItemStatus: null }))
  assert.equal(shared.ok, false)
  assert.equal(shared.failure.error.code, M10_ERROR_CODES.workItemNotFound)
})

// ---------------------------------------------------------------------------
// reviewer brief
// ---------------------------------------------------------------------------

test('the brief carries the request scope, the previous round, and the call to make', () => {
  const previous = answeredRecord({
    requestId: 'req-0',
    status: 'needs_revision',
    summary: 'the merge gate was skipped',
    findings: [
      {
        id: 'F1',
        severity: 'high',
        problem: 'the merge gate is skipped',
        requiredFix: 'call mergeGate before merging',
        file: 'src/review-request.ts',
        line: 42,
      },
    ],
  })
  const brief = buildReviewBrief({ request: pendingRecord(), previous })

  for (const expected of [
    'req-1',
    'review the work item change',
    BASE,
    HEAD,
    WORK_ITEM_PATH,
    'cowork/wi-1',
    'src/review-request.ts',
    'node --test tests/review-request.test.mjs',
    'req-0',
    'needs_revision',
    'the merge gate was skipped',
    'F1',
    'call mergeGate before merging',
    'cowork_review_verdict',
    'Read-only',
  ]) {
    assert.ok(brief.includes(expected), `the brief must mention ${expected}:\n${brief}`)
  }
  assert.ok(!brief.toLowerCase().includes('handoff'), 'the brief must not carry handoff text')
  assert.ok(brief.length <= REVIEW_BRIEF_MAX_CHARS)
})

test('the brief stays under its ceiling for a maximal request', () => {
  const huge = {
    ...answeredRecord(),
    purpose: 'p'.repeat(REVIEW_PURPOSE_MAX_CHARS),
    changedPaths: Array.from({ length: REVIEW_CHANGED_PATHS_MAX }, (_, index) => `${'d'.repeat(900)}/file-${index}.ts`),
    verification: Array.from({ length: REVIEW_VERIFICATION_MAX_ROWS }, () => ({
      command: 'c'.repeat(1900),
      exitCode: 0,
      evidence: 'e'.repeat(1900),
    })),
    findings: Array.from({ length: 50 }, (_, index) => ({
      id: `F${index}`,
      severity: 'low',
      problem: 'x'.repeat(1900),
      requiredFix: 'y'.repeat(1900),
    })),
  }
  const brief = buildReviewBrief({ request: huge, previous: huge })
  assert.ok(brief.length <= REVIEW_BRIEF_MAX_CHARS, `brief is ${brief.length} chars`)
  assert.ok(brief.includes('req-1'), 'the request id survives truncation')
  assert.ok(brief.includes('cowork_review_verdict'), 'the call to make survives truncation')
})

test('the brief without a previous round does not invent one', () => {
  const brief = buildReviewBrief({ request: pendingRecord() })
  assert.ok(!brief.includes('Previous review request'), brief)
  assert.ok(brief.includes('req-1'))
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

// ---------------------------------------------------------------------------
// the request tool, its file layer, and the deterministic pre-checks
// ---------------------------------------------------------------------------

const { registerReviewTools } = await import('../src/review-tools.ts')
const { ProjectStore } = await import('../src/store.ts')
const { failure: toolFailure, readCaller } = await import('../src/tool-model.ts')

const CLOCK = () => REQUESTED_AT

/** A tool registry that keeps every definition the assembly registers. */
function fakeHost() {
  const registry = new Map()
  return {
    registry,
    tools: {
      register(definition) {
        registry.set(definition.name, definition)
        return () => registry.delete(definition.name)
      },
    },
  }
}

/** The structured execution identity one tool call receives. */
function fakeExec(sessionId, cwd) {
  return { agent: { id: sessionId, session: { header: { cwd } } } }
}

/**
 * A git runner that answers the request pre-checks by their arguments. Every
 * option is the answer to one question, so a test changes exactly one fact.
 */
function fakeGit(options = {}) {
  const calls = []
  const runGit = async (args, cwd) => {
    calls.push({ args: [...args], cwd })
    if (options.fail !== undefined) return { code: 1, stdout: '', stderr: options.fail }
    if (args[1] === '--verify') {
      const ref = String(args[3]).replace('^{commit}', '')
      if (options.unknownRefs?.includes(ref)) return { code: 1, stdout: '', stderr: '' }
      return { code: 0, stdout: `${ref}\n`, stderr: '' }
    }
    if (args[0] === 'merge-base') return { code: options.ancestor === false ? 1 : 0, stdout: '', stderr: '' }
    if (args[0] === 'status') return { code: 0, stdout: options.dirty === true ? ' M src/one.ts\n' : '', stderr: '' }
    if (args[0] === 'diff') {
      const paths = options.changedPaths ?? ['src/review-request.ts']
      return { code: 0, stdout: paths.map((path) => `${path}\n`).join(''), stderr: '' }
    }
    if (args[1] === '--abbrev-ref') return { code: 0, stdout: `${options.branch ?? 'cowork/wi-1'}\n`, stderr: '' }
    throw new Error(`unexpected git call: git ${args.join(' ')}`)
  }
  return { calls, runGit }
}

/** A session slice that records reviewer creation, prompts, and archives. */
function fakeSlice(options = {}) {
  const calls = []
  return {
    calls,
    async createReviewSession(request) {
      calls.push({ type: 'create', request })
      return options.createResult ?? { sessionId: 'session-reviewer', workspaceId: 'workspace-1', title: 'cowork review: t' }
    },
    async promptSession(sessionId, text) {
      calls.push({ type: 'prompt', sessionId, text })
      if (options.throwFor === sessionId) throw new Error(`${sessionId} prompt failed`)
      return { accepted: options.rejectFor === sessionId ? false : true, requestId: 'prompt-1' }
    },
    async archiveSession(sessionId, archiveOptions) {
      calls.push({ type: 'archive', sessionId, options: archiveOptions })
      if (options.archiveError !== undefined) throw options.archiveError
    },
  }
}

/** Register the review tools against a real store and fake host ports. */
function setup(repoPath, options = {}) {
  const store = new ProjectStore({ repoPath, clock: CLOCK })
  const slice = options.slice ?? fakeSlice()
  const git = options.git ?? fakeGit()
  const host = fakeHost()
  registerReviewTools(host, {
    callerOf(exec) {
      return readCaller(exec) ?? toolFailure('exec/agent-unavailable', 'no caller identity')
    },
    async openProject() {
      return { repoPath, store, slice, index: await store.readIndex() }
    },
    mapError(error) {
      return toolFailure('tool/internal', error instanceof Error ? error.message : String(error))
    },
    toJson(value) {
      return JSON.parse(JSON.stringify(value))
    },
    renderJson() {
      return []
    },
    nowOf() {
      return CLOCK()
    },
    threadView(thread) {
      return thread
    },
    isFailure(value) {
      return typeof value === 'object' && value !== null && value.ok === false
    },
    git: git.runGit,
  })
  return { store, slice, git, host, request: host.registry.get('cowork_review_request') }
}

/** A canonical v2 topic for the seeded project. */
function topicFixture(repoPath, overrides = {}) {
  const stamp = REQUESTED_AT.toISOString()
  return {
    topicId: 'session-topic',
    title: 'wire the review',
    status: 'active',
    awaitingReview: false,
    blocked: false,
    scope: 'review',
    ownedPaths: [],
    aliases: [],
    digest: '',
    cwd: repoPath,
    legacyCheckoutPath: null,
    createdAt: stamp,
    updatedAt: stamp,
    lastActiveAt: stamp,
    lastDeliveryConfirmedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    latestReviewRequestId: null,
    reviewStatus: null,
    reviewerSessionId: null,
    ...overrides,
  }
}

/** A canonical v2 work item under the seeded topic. */
function workItemFixture(repoPath, overrides = {}) {
  const stamp = REQUESTED_AT.toISOString()
  return {
    workItemId: 'wi-1',
    topicId: 'session-topic',
    path: join(repoPath, '.dsh-cowork', 'workitems', 'wi-1'),
    branch: 'cowork/wi-1',
    baseCommit: BASE,
    headCommit: BASE,
    status: 'active',
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  }
}

/** Seed the canonical index with one topic and an optional work item. */
async function seedProject(store, repoPath, options = {}) {
  const topic = topicFixture(repoPath, options.topicOverrides ?? {})
  await store.initIndex('session-master')
  await store.mutateIndexDocument((document) => ({
    ...document,
    topics: [topic],
    workItems: options.workItem === undefined ? [] : [options.workItem],
  }))
  return topic
}

/** The canonical index as the tools see it. */
const canonical = (store) => store.readIndexDocument()

/** One request call input; the path default is the shared working tree. */
function toolRequest(repoPath, overrides = {}) {
  return {
    purpose: 'review the request model',
    baseCommit: BASE,
    headCommit: HEAD,
    path: repoPath,
    verification: [{ command: 'node --test tests/review-request.test.mjs', exitCode: 0, evidence: '28 pass' }],
    ...overrides,
  }
}

/** Run one request against a fresh repository and clean up afterwards. */
async function withRepo(run) {
  const repoPath = await mkdtemp(join(tmpdir(), 'cowork-review-request-'))
  try {
    return await run(repoPath)
  } finally {
    await rm(repoPath, { recursive: true, force: true })
  }
}

test('a shared-tree request writes the pending file, the index, and the brief', async () => {
  await withRepo(async (repoPath) => {
    const { store, slice, request } = setup(repoPath)
    await seedProject(store, repoPath)

    const result = await request.execute(toolRequest(repoPath), fakeExec('session-topic', repoPath))

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.status, 'pending')
    assert.equal(result.topicId, 'session-topic')
    assert.equal(result.workItemId, null)
    assert.equal(result.path, repoPath)
    assert.equal(result.baseCommit, BASE)
    assert.equal(result.headCommit, HEAD)
    assert.deepEqual(result.changedPaths, ['src/review-request.ts'])

    // The request file is the model's file, named from its own identity.
    assert.equal(result.filePath, join(repoPath, '.dsh-cowork', 'reviews', `session-topic-${result.requestId}.json`))
    const stored = JSON.parse(await readFile(result.filePath, 'utf8'))
    assert.equal(stored.status, 'pending')
    assert.equal(stored.reviewerSessionId, 'session-reviewer')
    assert.equal(stored.reviewedAt, null)
    assert.equal(stored.summary, null)
    assert.equal(stored.previousRequestId, null)
    assert.equal(stored.requestedAt, REQUESTED_AT.toISOString())
    assert.equal(stored.branch, 'cowork/wi-1')
    assert.deepEqual(stored.changedPaths, ['src/review-request.ts'])
    assert.equal(parseReviewRequestRecord(JSON.stringify(stored)).ok, true)

    // The canonical index carries the review markers and no legacy pointer.
    const document = await canonical(store)
    const topic = document.topics[0]
    assert.equal(topic.awaitingReview, true)
    assert.equal(topic.reviewStatus, 'pending')
    assert.equal(topic.latestReviewRequestId, result.requestId)
    assert.equal(topic.reviewerSessionId, 'session-reviewer')
    assert.equal(topic.latestReviewPath, null)
    assert.equal(topic.reviewRequestedAt, null)
    assert.equal(topic.reviewedAt, null)

    // One reviewer session was created and briefed with the request scope.
    const created = slice.calls.filter((call) => call.type === 'create')
    assert.equal(created.length, 1)
    assert.equal(created[0].request.presetId, 'cowork-reviewer')
    const prompts = slice.calls.filter((call) => call.type === 'prompt')
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].sessionId, 'session-reviewer')
    assert.match(prompts[0].text, new RegExp(result.requestId))
    assert.match(prompts[0].text, /review the request model/)
    assert.match(prompts[0].text, /cowork_review_verdict/)

    // The activity stream records the request.
    const activity = await store.readActivity()
    assert.ok(activity.events.some((event) => event.type === 'review-requested'))
  })
})

test('a work-item request points at the checkout and marks the item reviewing', async () => {
  await withRepo(async (repoPath) => {
    const item = workItemFixture(repoPath)
    const { store, request } = setup(repoPath)
    await seedProject(store, repoPath, { workItem: item })

    const result = await request.execute(
      toolRequest(repoPath, { path: item.path, workItemId: 'wi-1' }),
      fakeExec('session-topic', repoPath),
    )

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.workItemId, 'wi-1')
    assert.equal(result.path, item.path)
    const document = await canonical(store)
    assert.equal(document.workItems[0].status, 'reviewing')
    assert.equal(document.workItems[0].headCommit, HEAD)
  })
})

test('the master cannot request a review', async () => {
  await withRepo(async (repoPath) => {
    const { store, slice, request } = setup(repoPath)
    await seedProject(store, repoPath)

    const result = await request.execute(toolRequest(repoPath), fakeExec('session-master', repoPath))

    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'role/forbidden')
    assert.equal(slice.calls.length, 0)
    const document = await canonical(store)
    assert.equal(document.topics[0].awaitingReview, false)
  })
})

test('every failed pre-check leaves no reviewer, no file, and no index change', async () => {
  const cases = [
    ['missing purpose', toolRequest('/repo', { purpose: '' }), {}, 'review/request-invalid'],
    ['base equals head', toolRequest('/repo', { headCommit: BASE }), {}, 'review/base-equals-head'],
    ['unknown commit', toolRequest('/repo'), { git: fakeGit({ unknownRefs: [BASE] }) }, 'review/request-invalid'],
    ['base not an ancestor', toolRequest('/repo'), { git: fakeGit({ ancestor: false }) }, 'review/base-not-ancestor'],
    ['dirty worktree', toolRequest('/repo'), { git: fakeGit({ dirty: true }) }, 'review/dirty-worktree'],
    ['empty diff', toolRequest('/repo'), { git: fakeGit({ changedPaths: [] }) }, 'review/empty-diff'],
    ['changedPaths mismatch', toolRequest('/repo', { changedPaths: ['src/other.ts'] }), {}, 'review/changed-paths-mismatch'],
  ]
  for (const [label, input, options, code] of cases) {
    await withRepo(async (repoPath) => {
      const git = options.git ?? fakeGit()
      const slice = fakeSlice()
      const { store, request } = setup(repoPath, { git, slice })
      await seedProject(store, repoPath)
      const scoped = { ...input, path: repoPath }

      const result = await request.execute(scoped, fakeExec('session-topic', repoPath))

      assert.equal(result.ok, false, `${label} must be refused`)
      assert.equal(result.error.code, code, label)
      assert.equal(slice.calls.length, 0, `${label} must not create a reviewer`)
      const document = await canonical(store)
      assert.equal(document.topics[0].awaitingReview, false, label)
      const files = await import('node:fs/promises').then((fs) => fs.readdir(join(repoPath, '.dsh-cowork', 'reviews')))
        .catch(() => [])
      assert.deepEqual(files, [], `${label} must not write a request file`)
    })
  }
})

test('a path outside the work-item checkout is refused', async () => {
  await withRepo(async (repoPath) => {
    const item = workItemFixture(repoPath)
    const { store, request } = setup(repoPath)
    await seedProject(store, repoPath, { workItem: item })

    const result = await request.execute(
      toolRequest(repoPath, { path: repoPath, workItemId: 'wi-1' }),
      fakeExec('session-topic', repoPath),
    )
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'review/path-outside')

    // A shared-tree request must use the repository root, not a subdirectory.
    const shared = await request.execute(
      toolRequest(repoPath, { path: item.path }),
      fakeExec('session-topic', repoPath),
    )
    assert.equal(shared.ok, false)
    assert.equal(shared.error.code, 'review/path-outside')
  })
})

test('a work item must exist, belong to the topic, and be reviewable', async () => {
  await withRepo(async (repoPath) => {
    const { store, request } = setup(repoPath)
    await seedProject(store, repoPath)
    const missing = await request.execute(
      toolRequest(repoPath, { workItemId: 'wi-404' }),
      fakeExec('session-topic', repoPath),
    )
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'workitem/not-found')
  })
  await withRepo(async (repoPath) => {
    const item = workItemFixture(repoPath, { status: 'merged' })
    const { store, request } = setup(repoPath)
    await seedProject(store, repoPath, { workItem: item })
    const merged = await request.execute(
      toolRequest(repoPath, { path: item.path, workItemId: 'wi-1' }),
      fakeExec('session-topic', repoPath),
    )
    assert.equal(merged.ok, false)
    assert.equal(merged.error.code, 'workitem/not-ready')
  })
  await withRepo(async (repoPath) => {
    const item = workItemFixture(repoPath, { topicId: 'session-other' })
    const { store, request } = setup(repoPath)
    await seedProject(store, repoPath, { workItem: item })
    const foreign = await request.execute(
      toolRequest(repoPath, { path: item.path, workItemId: 'wi-1' }),
      fakeExec('session-topic', repoPath),
    )
    assert.equal(foreign.ok, false)
    assert.equal(foreign.error.code, 'workitem/not-found')
  })
})

test('a second pending request for the same topic and work item is refused', async () => {
  await withRepo(async (repoPath) => {
    const { store, request } = setup(repoPath)
    await seedProject(store, repoPath)

    const first = await request.execute(toolRequest(repoPath), fakeExec('session-topic', repoPath))
    assert.equal(first.ok, true)
    const second = await request.execute(toolRequest(repoPath), fakeExec('session-topic', repoPath))

    assert.equal(second.ok, false)
    assert.equal(second.error.code, 'review/already-pending', JSON.stringify(second.error))
    assert.equal(second.error.details.requestId, first.requestId)
  })
})

test('a legacy verdict-only file never counts as a pending request', async () => {
  await withRepo(async (repoPath) => {
    const { store, request } = setup(repoPath)
    await seedProject(store, repoPath)
    const reviewsDir = join(repoPath, '.dsh-cowork', 'reviews')
    await import('node:fs/promises').then((fs) => fs.mkdir(reviewsDir, { recursive: true }))
    await writeFile(join(reviewsDir, 'session-topic-20261107T090000000Z.json'), JSON.stringify({
      version: 1,
      threadId: 'session-topic',
      reviewerSessionId: 'session-old-reviewer',
      verdict: 'pass',
      summary: 'the old model',
      findings: [],
      verification: [],
      createdAt: '2026-11-07T09:00:00.000Z',
    }))

    const result = await request.execute(toolRequest(repoPath), fakeExec('session-topic', repoPath))

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.skippedFiles.length, 1)
    assert.equal(result.skippedFiles[0].fileName, 'session-topic-20261107T090000000Z.json')
  })
})

test('the previous request must exist, belong to the same chain, and be answered', async () => {
  await withRepo(async (repoPath) => {
    const { store, request } = setup(repoPath)
    await seedProject(store, repoPath)

    const missing = await request.execute(
      toolRequest(repoPath, { previousRequestId: 'req-404' }),
      fakeExec('session-topic', repoPath),
    )
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'review/previous-invalid')
  })
  await withRepo(async (repoPath) => {
    const { store, request } = setup(repoPath)
    await seedProject(store, repoPath)
    const first = await request.execute(toolRequest(repoPath), fakeExec('session-topic', repoPath))
    assert.equal(first.ok, true)

    // The first request is still pending: a second request for the same pair is
    // refused before the chain check, so no second reviewer is created.
    const pendingPrevious = await request.execute(
      toolRequest(repoPath, { previousRequestId: first.requestId }),
      fakeExec('session-topic', repoPath),
    )
    assert.equal(pendingPrevious.ok, false)
    assert.equal(pendingPrevious.error.code, 'review/already-pending')
  })
  // A terminal predecessor is accepted and bound into the new request.
  await withRepo(async (repoPath) => {
    const { store, request } = setup(repoPath)
    await seedProject(store, repoPath)
    const first = await request.execute(toolRequest(repoPath), fakeExec('session-topic', repoPath))
    assert.equal(first.ok, true)
    const filePath = first.filePath
    const answered = JSON.parse(await readFile(filePath, 'utf8'))
    answered.status = 'needs_revision'
    answered.reviewedAt = REQUESTED_AT.toISOString()
    answered.summary = 'one fix before merge'
    answered.findings = [{ id: 'F1', severity: 'high', problem: 'p', requiredFix: 'f' }]
    await writeFile(filePath, `${JSON.stringify(answered, null, 2)}\n`)

    const second = await request.execute(
      toolRequest(repoPath, { previousRequestId: first.requestId }),
      fakeExec('session-topic', repoPath),
    )

    assert.equal(second.ok, true, JSON.stringify(second))
    const stored = JSON.parse(await readFile(second.filePath, 'utf8'))
    assert.equal(stored.previousRequestId, first.requestId)
    assert.equal(stored.status, 'pending')
  })
})

test('a brief failure rolls the request back in order and records it', async () => {
  await withRepo(async (repoPath) => {
    const slice = fakeSlice({ rejectFor: 'session-reviewer' })
    const { store, request } = setup(repoPath, { slice })
    await seedProject(store, repoPath)

    const result = await request.execute(toolRequest(repoPath), fakeExec('session-topic', repoPath))

    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'review/prompt-failed', JSON.stringify(result.error))
    // No request file and no pending markers remain.
    const reviewsDir = join(repoPath, '.dsh-cowork', 'reviews')
    const files = await import('node:fs/promises').then((fs) => fs.readdir(reviewsDir)).catch(() => [])
    assert.deepEqual(files, [])
    const document = await canonical(store)
    assert.equal(document.topics[0].awaitingReview, false)
    assert.equal(document.topics[0].reviewStatus, null)
    assert.equal(document.topics[0].reviewerSessionId, null)
    // The half-created reviewer is archived, and the failure is in activity.
    const archives = slice.calls.filter((call) => call.type === 'archive')
    assert.deepEqual(archives.map((call) => call.sessionId), ['session-reviewer'])
    assert.deepEqual(archives[0].options, { stopActivity: true })
    const activity = await store.readActivity()
    assert.ok(activity.events.some((event) => event.type === 'error'))
  })
})

test('an index write failure archives the reviewer and removes the file', async () => {
  await withRepo(async (repoPath) => {
    const { store, slice, request } = setup(repoPath)
    await seedProject(store, repoPath)
    const broken = Object.create(store)
    broken.mutateIndexDocument = async () => {
      throw new Error('index write refused')
    }
    // Re-register against a store whose index write fails after the file write.
    const host = fakeHost()
    registerReviewTools(host, {
      callerOf: (exec) => readCaller(exec) ?? toolFailure('exec/agent-unavailable', 'no caller'),
      openProject: async () => ({ repoPath, store: broken, slice, index: await store.readIndex() }),
      mapError: (error) => toolFailure('tool/internal', String(error)),
      toJson: (value) => JSON.parse(JSON.stringify(value)),
      renderJson: () => [],
      nowOf: () => CLOCK(),
      threadView: (thread) => thread,
      isFailure: (value) => typeof value === 'object' && value !== null && value.ok === false,
      git: fakeGit().runGit,
    })
    const tool = host.registry.get('cowork_review_request')

    const result = await tool.execute(toolRequest(repoPath), fakeExec('session-topic', repoPath))

    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'tool/internal')
    assert.match(result.error.message, /could not be recorded in the index/)
    const reviewsDir = join(repoPath, '.dsh-cowork', 'reviews')
    const files = await import('node:fs/promises').then((fs) => fs.readdir(reviewsDir)).catch(() => [])
    assert.deepEqual(files, [])
    // The file and reviewer were cleaned up; restoring the index is the one step
    // the failing store cannot do, and that is reported instead of hidden.
    assert.equal(result.error.details.cleanupErrors.length, 1)
    assert.match(result.error.details.cleanupErrors[0], /^index: index write refused/)
    const archives = slice.calls.filter((call) => call.type === 'archive')
    assert.deepEqual(archives.map((call) => call.sessionId), ['session-reviewer'])
  })
})

// ---------------------------------------------------------------------------
// the legacy thread merge gate and the topic messages
// ---------------------------------------------------------------------------

test('the legacy thread merge gate keeps the M8 behaviour exactly', async () => {
  const { checkLegacyThreadMerge, cleanOverrideReason, MAX_OVERRIDE_REASON_LENGTH } =
    await import('../src/review-request.ts')

  assert.deepEqual(checkLegacyThreadMerge({ threadId: 't1', reviewStatus: 'pass' }), {
    ok: true,
    suffix: '',
    reason: null,
  })

  const overridden = checkLegacyThreadMerge(
    { threadId: 't1', reviewStatus: 'needs_revision' },
    { allowUnreviewed: true, overrideReason: '  hotfix\nfor the release  ' },
  )
  assert.deepEqual(overridden, { ok: true, suffix: ' (unreviewed: hotfix for the release)', reason: 'hotfix for the release' })

  const noReason = checkLegacyThreadMerge(
    { threadId: 't1', reviewStatus: null },
    { allowUnreviewed: true, overrideReason: '   ' },
  )
  assert.equal(noReason.ok, false)
  assert.equal(noReason.failure.error.code, 'review/override-reason-required')

  const notPassed = checkLegacyThreadMerge({ threadId: 't1', reviewStatus: 'pending' })
  assert.equal(notPassed.ok, false)
  assert.equal(notPassed.failure.error.code, 'review/not-passed')

  // The reason is cleaned and bounded; a pass is never labelled unreviewed.
  assert.equal(cleanOverrideReason('a'.repeat(MAX_OVERRIDE_REASON_LENGTH + 50)).length, MAX_OVERRIDE_REASON_LENGTH)
  assert.equal(cleanOverrideReason('a\u0000b\nc'), 'a b c')
})

test('a topic message stays bounded even with many long findings', async () => {
  const { REVIEW_MESSAGE_MAX_CHARS, buildRejectMessage, buildRevisionMessage } =
    await import('../src/review-request.ts')
  const many = {
    ...answeredRecord({
      status: 'needs_revision',
      summary: 's'.repeat(REVIEW_SUMMARY_MAX_CHARS),
      findings: Array.from({ length: 60 }, (_, index) => ({
        id: `F${index}`,
        severity: 'low',
        problem: 'p'.repeat(1900),
        requiredFix: 'r'.repeat(1900),
      })),
    }),
  }
  for (const message of [buildRevisionMessage(many), buildRejectMessage(many)]) {
    assert.ok(message.length <= REVIEW_MESSAGE_MAX_CHARS, `message is ${message.length} chars`)
    assert.match(message, /needs_revision|reject/)
    assert.match(message, /F0/)
  }
})
