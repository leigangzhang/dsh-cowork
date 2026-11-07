import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_OVERRIDE_REASON_LENGTH,
  REVIEWER_PRESET_ID,
  REVIEW_SEVERITIES,
  REVIEW_STATUSES,
  REVIEW_VERDICTS,
  buildReviewBrief,
  buildReviewRecord,
  checkMergeGate,
  checkReviewRequest,
  checkVerdictCaller,
  formatRevisionMessage,
  formatVerdictMessage,
  latestReviewFor,
  overrideCommitSuffix,
  planMerge,
  prepareVerdict,
  validateReviewInput,
  verdictTransition,
} from '../src/review.ts'

const CREATED_AT = new Date('2026-11-05T03:04:05.006Z')

/** A valid draft with the given overrides. */
const draft = (overrides = {}) => ({
  threadId: 'session-thread',
  reviewerSessionId: 'session-reviewer',
  verdict: 'pass',
  summary: 'the work holds up',
  findings: [],
  verification: [],
  ...overrides,
})

/** A well-formed finding with the given overrides. */
const finding = (overrides = {}) => ({
  id: 'F1',
  severity: 'high',
  problem: 'the merge gate can be skipped',
  requiredFix: 'route the merge through checkMergeGate',
  ...overrides,
})

/** The rejected field names of an invalid input. */
function refusedFields(input) {
  const result = validateReviewInput(input)
  assert.equal(result.ok, false, 'input was expected to be rejected')
  return result.errors.map((error) => error.field)
}

// ---------------------------------------------------------------------------
// constants and validation
// ---------------------------------------------------------------------------

test('review vocabularies are the frozen M3 ones', () => {
  assert.equal(REVIEWER_PRESET_ID, 'cowork-reviewer')
  assert.deepEqual([...REVIEW_STATUSES], ['pending', 'pass', 'needs_revision', 'reject'])
  assert.deepEqual([...REVIEW_VERDICTS], ['pass', 'needs_revision', 'reject'])
  assert.deepEqual([...REVIEW_SEVERITIES], ['blocker', 'high', 'medium', 'low'])
})

test('a minimal pass is valid and absent arrays default to empty', () => {
  const input = draft()
  delete input.findings
  delete input.verification

  const result = validateReviewInput(input)

  assert.deepEqual(result, {
    ok: true,
    value: {
      threadId: 'session-thread',
      reviewerSessionId: 'session-reviewer',
      verdict: 'pass',
      summary: 'the work holds up',
      findings: [],
      verification: [],
    },
  })
})

test('a non-object input is rejected once', () => {
  assert.deepEqual(refusedFields('pass'), ['input'])
  assert.deepEqual(refusedFields(null), ['input'])
  assert.deepEqual(refusedFields([]), ['input'])
})

test('missing identity fields and verdict are all reported', () => {
  assert.deepEqual(
    refusedFields({ verdict: 'pass' }),
    ['threadId', 'reviewerSessionId', 'summary'],
  )
  assert.deepEqual(refusedFields({ ...draft(), threadId: '  ' }), ['threadId'])
  assert.deepEqual(refusedFields({ ...draft(), reviewerSessionId: '' }), ['reviewerSessionId'])
  assert.deepEqual(refusedFields({ ...draft(), summary: '  ' }), ['summary'])
  assert.deepEqual(refusedFields({ ...draft(), verdict: undefined }), ['verdict'])
  // `pending` is a request state, never a verdict.
  assert.deepEqual(refusedFields({ ...draft(), verdict: 'pending' }), ['verdict'])
  assert.deepEqual(refusedFields({ ...draft(), verdict: 'merge' }), ['verdict'])
})

test('needs_revision and reject require at least one finding; pass may carry none', () => {
  assert.deepEqual(refusedFields({ ...draft(), verdict: 'needs_revision' }), ['findings'])
  assert.deepEqual(refusedFields({ ...draft(), verdict: 'reject' }), ['findings'])
  assert.equal(validateReviewInput({ ...draft(), verdict: 'needs_revision', findings: [finding()] }).ok, true)
  assert.equal(validateReviewInput({ ...draft(), verdict: 'reject', findings: [finding()] }).ok, true)
  assert.equal(validateReviewInput({ ...draft(), verdict: 'pass' }).ok, true)
})

test('every malformed finding field is reported and the row is dropped', () => {
  const fields = refusedFields({
    ...draft(),
    verdict: 'needs_revision',
    findings: [finding({ id: '', severity: 'fatal', problem: '', requiredFix: '' })],
  })
  assert.deepEqual(fields, [
    'findings[0].id',
    'findings[0].severity',
    'findings[0].problem',
    'findings[0].requiredFix',
    'findings',
  ])

  assert.deepEqual(refusedFields({ ...draft(), findings: [finding({ file: '' })] }), ['findings[0].file'])
  assert.deepEqual(refusedFields({ ...draft(), findings: [finding({ line: 0 })] }), ['findings[0].line'])
  assert.deepEqual(refusedFields({ ...draft(), findings: [finding({ line: -2 })] }), ['findings[0].line'])
  assert.deepEqual(refusedFields({ ...draft(), findings: [finding({ line: 1.5 })] }), ['findings[0].line'])
  assert.deepEqual(refusedFields({ ...draft(), findings: ['F1'] }), ['findings[0]'])
  assert.deepEqual(refusedFields({ ...draft(), findings: 'F1' }), ['findings'])
  assert.deepEqual(refusedFields({ ...draft(), findings: [finding({ line: '3' })] }), ['findings[0].line'])
})

test('a well-formed finding keeps its location and null arrays are empty', () => {
  const result = validateReviewInput({
    ...draft(),
    verdict: 'needs_revision',
    findings: [finding({ file: 'src/tools.ts', line: 42 })],
    verification: null,
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.value.findings, [
    {
      id: 'F1',
      severity: 'high',
      problem: 'the merge gate can be skipped',
      requiredFix: 'route the merge through checkMergeGate',
      file: 'src/tools.ts',
      line: 42,
    },
  ])
  assert.deepEqual(result.value.verification, [])
})

test('verification rows are validated field by field, and an empty array is allowed', () => {
  const verification = (overrides = {}) => ({
    command: 'node --test tests/review.test.mjs',
    exitCode: 0,
    evidence: 'pass 20',
    ...overrides,
  })

  assert.deepEqual(refusedFields({ ...draft(), verification: 'ran' }), ['verification'])
  assert.deepEqual(
    refusedFields({ ...draft(), verification: [verification({ command: ' ', exitCode: 0.5, evidence: 7 })] }),
    ['verification[0].command', 'verification[0].exitCode', 'verification[0].evidence'],
  )
  assert.deepEqual(refusedFields({ ...draft(), verification: [null] }), ['verification[0]'])
  assert.equal(validateReviewInput({ ...draft(), verification: [verification()] }).ok, true)
  assert.equal(validateReviewInput({ ...draft(), verification: [] }).ok, true)
})

// ---------------------------------------------------------------------------
// record and transition
// ---------------------------------------------------------------------------

test('buildReviewRecord stamps the version and the ISO createdAt', () => {
  const result = validateReviewInput({ ...draft(), verdict: 'needs_revision', findings: [finding()] })
  assert.equal(result.ok, true)

  assert.deepEqual(buildReviewRecord(result.value, CREATED_AT), {
    version: 1,
    threadId: 'session-thread',
    reviewerSessionId: 'session-reviewer',
    verdict: 'needs_revision',
    summary: 'the work holds up',
    findings: [finding()],
    verification: [],
    createdAt: '2026-11-05T03:04:05.006Z',
  })
})

test('the verdict decides the thread status and whether the thread is woken', () => {
  assert.deepEqual(verdictTransition('pass'), { status: 'done', deliverToThread: false })
  assert.deepEqual(verdictTransition('needs_revision'), { status: 'active', deliverToThread: true })
  assert.deepEqual(verdictTransition('reject'), { status: 'blocked', deliverToThread: true })
})

// ---------------------------------------------------------------------------
// verdict caller gate
// ---------------------------------------------------------------------------

const CALLER = { sessionId: 'session-reviewer', cwd: '/repo' }
const THREAD = { threadId: 'session-thread', reviewerSessionId: 'session-reviewer' }

test('the reviewer session is the only accepted verdict caller', () => {
  assert.equal(checkVerdictCaller({ caller: CALLER, thread: THREAD, masterSessionId: 'session-master' }), null)
})

test('the master reviewing its own project thread is refused as self-review', () => {
  const denied = checkVerdictCaller({
    caller: { sessionId: 'session-master', cwd: '/repo' },
    thread: THREAD,
    masterSessionId: 'session-master',
  })

  assert.equal(denied.error.code, 'review/self-review')
  assert.equal(denied.error.details.role, 'master')
  assert.equal(denied.error.details.threadId, 'session-thread')
})

test('the thread reviewing itself is refused as self-review', () => {
  const denied = checkVerdictCaller({
    caller: { sessionId: 'session-thread', cwd: '/repo' },
    thread: THREAD,
    masterSessionId: 'session-master',
  })

  assert.equal(denied.error.code, 'review/self-review')
  assert.equal(denied.error.details.role, 'thread')
})

test('a stranger and a thread without a reviewer are both not-reviewer', () => {
  const stranger = checkVerdictCaller({
    caller: { sessionId: 'session-other', cwd: '/repo' },
    thread: THREAD,
    masterSessionId: 'session-master',
  })
  assert.equal(stranger.error.code, 'review/not-reviewer')
  assert.equal(stranger.error.details.reviewerSessionId, 'session-reviewer')

  const unreviewed = checkVerdictCaller({
    caller: CALLER,
    thread: { threadId: 'session-thread', reviewerSessionId: null },
    masterSessionId: 'session-master',
  })
  assert.equal(unreviewed.error.code, 'review/not-reviewer')
  assert.equal(unreviewed.error.details.reviewerSessionId, null)
})

// ---------------------------------------------------------------------------
// review request gate
// ---------------------------------------------------------------------------

test('only an awaiting_review thread may request a review', () => {
  const denied = checkReviewRequest({
    threadId: 'session-thread',
    status: 'active',
    reviewStatus: null,
    reviewerSessionId: null,
  })

  assert.equal(denied.error.code, 'review/not-ready')
  assert.equal(denied.error.details.status, 'active')
  assert.equal(
    checkReviewRequest({ threadId: 'session-thread', status: 'done', reviewStatus: 'pass', reviewerSessionId: 'r' })
      .error.code,
    'review/not-ready',
  )
})

test('a pending review is refused and names the session already reviewing', () => {
  const denied = checkReviewRequest({
    threadId: 'session-thread',
    status: 'awaiting_review',
    reviewStatus: 'pending',
    reviewerSessionId: 'session-reviewer',
  })

  assert.equal(denied.error.code, 'review/already-pending')
  assert.equal(denied.error.details.reviewerSessionId, 'session-reviewer')
})

test('an awaiting_review thread without a pending request may be reviewed again', () => {
  for (const reviewStatus of [null, 'pass', 'needs_revision', 'reject']) {
    assert.equal(
      checkReviewRequest({
        threadId: 'session-thread',
        status: 'awaiting_review',
        reviewStatus,
        reviewerSessionId: null,
      }),
      null,
    )
  }
})

// ---------------------------------------------------------------------------
// merge gate and override
// ---------------------------------------------------------------------------

const GATE_THREAD = (reviewStatus) => ({ threadId: 'session-thread', reviewStatus })

test('a passed review is the only state that merges without an override', () => {
  assert.equal(checkMergeGate(GATE_THREAD('pass')), null)
})

test('every non-passed state is refused with the observed state in details', () => {
  for (const reviewStatus of [null, 'pending', 'needs_revision', 'reject']) {
    const denied = checkMergeGate(GATE_THREAD(reviewStatus))
    assert.equal(denied.error.code, 'review/not-passed', String(reviewStatus))
    assert.equal(denied.error.details.reviewStatus, reviewStatus)
    assert.equal(denied.error.details.threadId, 'session-thread')
  }
})

test('allowUnreviewed needs a non-empty override reason', () => {
  assert.equal(checkMergeGate(GATE_THREAD('reject'), { allowUnreviewed: true, overrideReason: 'legacy lane' }), null)
  assert.equal(checkMergeGate(GATE_THREAD(null), { allowUnreviewed: true, overrideReason: 'legacy lane' }), null)

  const missing = checkMergeGate(GATE_THREAD('reject'), { allowUnreviewed: true })
  assert.equal(missing.error.code, 'review/override-reason-required')

  const blank = checkMergeGate(GATE_THREAD('reject'), { allowUnreviewed: true, overrideReason: ' \n\t ' })
  assert.equal(blank.error.code, 'review/override-reason-required')

  // A reason without the explicit override flag does not merge anything.
  assert.equal(checkMergeGate(GATE_THREAD('reject'), { overrideReason: 'legacy lane' }).error.code, 'review/not-passed')
})

test('the commit suffix cleans line breaks and control characters', () => {
  assert.equal(overrideCommitSuffix(''), '')
  assert.equal(overrideCommitSuffix('   \n\t '), '')
  assert.equal(overrideCommitSuffix('M2 lane\npredates\t\tthe gate'), ' (unreviewed: M2 lane predates the gate)')
  assert.equal(overrideCommitSuffix('bad\u0000\u0007reason'), ' (unreviewed: bad reason)')
  assert.equal(
    overrideCommitSuffix('  spaced   out  '),
    ' (unreviewed: spaced out)',
  )
})

test('the override reason is truncated to the fixed budget', () => {
  const long = 'x'.repeat(MAX_OVERRIDE_REASON_LENGTH + 50)

  assert.equal(
    overrideCommitSuffix(long),
    ` (unreviewed: ${'x'.repeat(MAX_OVERRIDE_REASON_LENGTH)})`,
  )
})

// ---------------------------------------------------------------------------
// brief and revision message
// ---------------------------------------------------------------------------

const BRIEF = {
  repoPath: '/repo',
  subject: 'wire the review gate',
  threadId: 'session-thread',
  handoffFilePath: '/repo/.dsh-cowork/handoffs/session-thread-1.json',
  changedPaths: ['src/review.ts', 'tests/review.test.mjs'],
  verification: [{ command: 'node --test tests/review.test.mjs', exitCode: 0, evidence: 'pass 20' }],
  checkoutPath: '/repo/.dsh-cowork/threads/session-thread',
  baseRef: 'abc123',
}

test('the isolated review brief carries the clone, the base diff, and the handoff evidence', () => {
  const brief = buildReviewBrief(BRIEF)

  assert.match(brief, /session-thread/)
  assert.match(brief, /\/repo/)
  assert.match(brief, /wire the review gate/)
  assert.match(brief, /\/repo\/\.dsh-cowork\/handoffs\/session-thread-1\.json/)
  assert.match(brief, /src\/review\.ts, tests\/review\.test\.mjs/)
  assert.match(brief, /node --test tests\/review\.test\.mjs \(exit 0\): pass 20/)
  assert.match(brief, /cowork\/session-thread/)
  assert.match(brief, /git -C \/repo\/\.dsh-cowork\/threads\/session-thread diff abc123\.\.\.HEAD/)
  assert.match(brief, /Do not modify implementation files/)
  assert.match(brief, /cowork_review_verdict exactly once/)
  assert.match(brief, /run the verification commands yourself/)
})

test('the review brief falls back to origin/HEAD and the shared tree without a clone', () => {
  const cloned = buildReviewBrief({ ...BRIEF, baseRef: null })
  assert.match(cloned, /diff origin\/HEAD\.\.\.HEAD/)

  const shared = buildReviewBrief({
    ...BRIEF,
    handoffFilePath: null,
    changedPaths: [],
    verification: [],
    checkoutPath: null,
  })
  assert.equal(shared.includes('git -C'), false)
  assert.match(shared, /shared repository working tree at \/repo/)
  assert.match(shared, /Latest handoff: none recorded/)
  assert.match(shared, /Changed paths reported by the thread: none recorded/)
})

test('the revision message lists every finding with file:line and asks for a new handoff', () => {
  const record = buildReviewRecord(
    draft({
      verdict: 'needs_revision',
      summary: 'two fixes before merge',
      findings: [
        finding({ file: 'src/tools.ts', line: 42 }),
        finding({ id: 'F2', severity: 'low', problem: 'typo in the brief', requiredFix: 'fix the wording' }),
      ],
    }),
    CREATED_AT,
  )

  const message = formatRevisionMessage(record, 'session-thread')

  assert.match(message, /session-thread returned needs_revision/)
  assert.match(message, /two fixes before merge/)
  assert.match(message, /Findings \(2\)/)
  assert.match(message, /F1 \[high\] the merge gate can be skipped \| required fix: route the merge through checkMergeGate \| at src\/tools\.ts:42/)
  assert.match(message, /F2 \[low\] typo in the brief/)
  assert.match(message, /cowork_handoff again with status awaiting_review/)
  assert.match(message, /\.dsh-cowork\/reviews\//)
})

test('the verdict message tells the master the outcome, the findings, and the next step', () => {
  const passed = buildReviewRecord(draft({ verdict: 'pass' }), CREATED_AT)
  const passMessage = formatVerdictMessage(passed, {
    subject: 'review me',
    status: 'done',
    reviewFilePath: '/repo/.dsh-cowork/reviews/session-thread-1.json',
  })
  assert.match(passMessage, /session-thread \("review me"\) returned pass/)
  assert.match(passMessage, /Thread status is now done/)
  assert.match(passMessage, /Findings: none\./)
  assert.match(passMessage, /cowork_checkout_merge/)
  assert.match(passMessage, /\/repo\/\.dsh-cowork\/reviews\/session-thread-1\.json/)

  const revised = buildReviewRecord(
    draft({ verdict: 'needs_revision', findings: [finding({ file: 'src/tools.ts', line: 42 })] }),
    CREATED_AT,
  )
  const delivered = formatVerdictMessage(revised, {
    subject: 'review me',
    status: 'active',
    reviewFilePath: '/repo/r.json',
    threadDelivered: true,
  })
  assert.match(delivered, /returned needs_revision/)
  assert.match(delivered, /F1 \[high\].*src\/tools\.ts:42/)
  assert.match(delivered, /findings were delivered to the thread/)

  const undelivered = formatVerdictMessage(revised, {
    subject: 'review me',
    status: 'active',
    reviewFilePath: '/repo/r.json',
    threadDelivered: false,
  })
  assert.match(undelivered, /could not be delivered to the thread/)

  const rejected = buildReviewRecord(draft({ verdict: 'reject', findings: [finding()] }), CREATED_AT)
  const blocked = formatVerdictMessage(rejected, {
    subject: 'review me',
    status: 'blocked',
    reviewFilePath: '/repo/r.json',
    threadDelivered: true,
  })
  assert.match(blocked, /returned reject/)
  assert.match(blocked, /Thread status is now blocked/)
  assert.match(blocked, /thread is blocked/)
})

test('latestReviewFor returns the newest record of one thread', () => {
  const older = buildReviewRecord(draft({ verdict: 'needs_revision', findings: [finding()] }), new Date('2026-11-01T00:00:00.000Z'))
  const newer = buildReviewRecord(draft({ verdict: 'pass' }), new Date('2026-11-02T00:00:00.000Z'))
  const other = buildReviewRecord(draft({ threadId: 'session-other' }), new Date('2026-11-03T00:00:00.000Z'))
  const files = [older, other, newer].map((record) => ({ record }))

  assert.equal(latestReviewFor(files, 'session-thread').verdict, 'pass')
  assert.equal(latestReviewFor(files, 'session-other').verdict, 'pass')
  assert.equal(latestReviewFor(files, 'session-missing'), null)
})

// ---------------------------------------------------------------------------
// merged planning (gate + commit suffix in one place)
// ---------------------------------------------------------------------------

test('planMerge carries the gate refusal through unchanged', () => {
  const plan = planMerge(GATE_THREAD('needs_revision'))
  assert.equal(plan.ok, false)
  assert.equal(plan.failure.error.code, 'review/not-passed')
  assert.equal(planMerge(GATE_THREAD('reject'), { allowUnreviewed: true }).failure.error.code, 'review/override-reason-required')
})

test('planMerge returns the cleaned override suffix and reason, never for a passed review', () => {
  assert.deepEqual(planMerge(GATE_THREAD('pass')), { ok: true, suffix: '', reason: null })
  assert.deepEqual(planMerge(GATE_THREAD('pass'), { allowUnreviewed: true, overrideReason: 'x' }), {
    ok: true,
    suffix: '',
    reason: null,
  })
  assert.deepEqual(planMerge(GATE_THREAD(null), { allowUnreviewed: true, overrideReason: 'M2\nlane' }), {
    ok: true,
    suffix: ' (unreviewed: M2 lane)',
    reason: 'M2 lane',
  })
})

// ---------------------------------------------------------------------------
// verdict preparation (status + caller + validation + identity)
// ---------------------------------------------------------------------------

const AWAITING = { threadId: 'session-thread', status: 'awaiting_review', reviewerSessionId: 'session-reviewer', reviewStatus: 'pending' }

test('prepareVerdict refuses a thread that is not awaiting_review', () => {
  const result = prepareVerdict({
    thread: { ...AWAITING, status: 'active' },
    caller: CALLER,
    masterSessionId: 'session-master',
    review: draft({ verdict: 'pass' }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.failure.error.code, 'review/not-ready')
})

test('prepareVerdict keeps the self-review and not-reviewer gates', () => {
  const selfReview = prepareVerdict({
    thread: AWAITING,
    caller: { sessionId: 'session-master', cwd: '/repo' },
    masterSessionId: 'session-master',
    review: draft({ verdict: 'pass' }),
  })
  assert.equal(selfReview.failure.error.code, 'review/self-review')
  const stranger = prepareVerdict({
    thread: AWAITING,
    caller: { sessionId: 'session-other', cwd: '/repo' },
    masterSessionId: 'session-master',
    review: draft({ verdict: 'pass' }),
  })
  assert.equal(stranger.failure.error.code, 'review/not-reviewer')
})

test('prepareVerdict injects the indexed identity and reports invalid input', () => {
  const prepared = prepareVerdict({
    thread: AWAITING,
    caller: CALLER,
    masterSessionId: 'session-master',
    review: { ...draft({ verdict: 'pass' }), threadId: 'session-forged', reviewerSessionId: 'session-forged' },
  })
  assert.equal(prepared.ok, true)
  assert.equal(prepared.draft.threadId, 'session-thread')
  assert.equal(prepared.draft.reviewerSessionId, 'session-reviewer')

  const invalid = prepareVerdict({
    thread: AWAITING,
    caller: CALLER,
    masterSessionId: 'session-master',
    review: { verdict: 'needs_revision', summary: 'no findings' },
  })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.failure.error.code, 'review/verdict-invalid')
  assert.equal(invalid.failure.error.details.errors[0].field, 'findings')
})
