import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// `src/request-schema.ts` imports its siblings with the build's `.js`
// specifiers, which Node's type stripping does not retry as `.ts`; the same
// resolve hook `tests/api.test.mjs` uses makes the module importable.
const HOOK_SOURCE = [
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier.startsWith('.') && specifier.endsWith('.js')) {",
  "    try { return await nextResolve(specifier.slice(0, -3) + '.ts', context) } catch {}",
  '  }',
  '  return nextResolve(specifier, context)',
  '}',
].join('\n')
register(`data:text/javascript,${encodeURIComponent(HOOK_SOURCE)}`)
import {
  REQUEST_MESSAGE_MAX_CHARS,
  REQUEST_PAYLOAD_MAX_BYTES,
  REQUEST_RECORD_VERSION,
  RESOLUTION_MESSAGE_MAX_CHARS,
  REVIEW_MAX_CHANGED_PATHS,
  REVIEW_MAX_VERIFICATION,
  QUESTION_MAX_OPTIONS,
  QUESTION_MAX_QUESTIONS,
  PLAN_PATH_MAX_CHARS,
  REVIEW_PURPOSE_MAX_CHARS,
} from '../src/inbox-contract.ts'

// The schema module imports its siblings with the build's `.js` specifiers, so
// it is loaded after the hook above, not by a static import.
const {
  REQUEST_DELIVERY_ERROR_MAX_CHARS,
  RequestSchemaError,
  answerProblems,
  applyResolution,
  buildRequestRecord,
  defaultSummary,
  emptyDelivery,
  isRequestId,
  isRepoRelativePosixPath,
  normalizeComment,
  normalizeQuestion,
  parseRequestRecordText,
  payloadProblems,
  requestFileName,
  requestMessage,
  requestRecordProblems,
  resolutionMessage,
} = await import('../src/request-schema.ts')

const NOW = new Date('2026-11-10T09:00:00.000Z')
const NOW_ISO = NOW.toISOString()

/** One valid user-review payload. */
const reviewPayload = (overrides = {}) => ({
  purpose: 'please review the inbox backend',
  changedPaths: ['src/request-schema.ts'],
  verification: [{ command: 'node --test', exitCode: 0, evidence: 'ok' }],
  ...overrides,
})

/** One valid question payload (ids already minted). */
const questionPayload = (overrides = {}) => ({
  questions: [
    {
      id: 'q1',
      prompt: 'Ship it?',
      mode: 'single',
      options: [{ id: 'o1', label: 'yes', recommended: true }, { id: 'o2', label: 'no' }],
      allowText: true,
    },
  ],
  ...overrides,
})

/** One plan payload. */
const planPayload = (overrides = {}) => ({ planPath: 'docs/plan.md', planTitle: 'Plan', ...overrides })

/** One valid record. */
const record = (overrides = {}) => buildRequestRecord({
  requestId: 'req-1',
  projectId: 'example.com/acme/repo',
  topicId: 'topic-1',
  kind: 'user-review',
  title: 'Inbox backend',
  payload: reviewPayload(),
  now: NOW,
  ...overrides,
})

test('buildRequestRecord writes one pending record with the persisted left message', () => {
  const built = record()
  assert.equal(built.version, REQUEST_RECORD_VERSION)
  assert.equal(built.status, 'pending')
  assert.equal(built.resolutionMessage, null)
  assert.deepEqual(built.delivery, emptyDelivery())
  assert.equal(built.createdAt, NOW_ISO)
  assert.equal(built.updatedAt, NOW_ISO)
  assert.match(built.requestMessage, /^主题「Inbox backend」请你审核：please review/)
  assert.deepEqual(requestRecordProblems(built), [])
})

test('the four kinds each get their own left-hand sentence', () => {
  assert.match(requestMessage('authorization', 'T', { summary: 'may I?' }), /等待你的授权：may I\?/)
  assert.match(
    requestMessage('question', 'T', { questions: [{ id: 'q1', prompt: 'one?', mode: 'single' }] }),
    /请你回答：one\?/,
  )
  assert.match(
    requestMessage('question', 'T', {
      questions: [
        { id: 'q1', prompt: 'one?', mode: 'single' },
        { id: 'q2', prompt: 'two?', mode: 'multi' },
      ],
    }),
    /（共 2 个问题）/,
  )
  assert.match(requestMessage('plan', 'T', { planPath: 'docs/plan.md', planTitle: 'PLAN' }), /请你确认计划《PLAN》/)
  assert.match(requestMessage('plan', 'T', { planPath: 'docs/plan.md' }), /请你确认计划：docs\/plan\.md/)
})

test('an over-long left message and right reply stay inside their caps', () => {
  const message = requestMessage('user-review', 'topic', { purpose: 'p'.repeat(REVIEW_PURPOSE_MAX_CHARS) })
  assert.ok(Array.from(message).length <= REQUEST_MESSAGE_MAX_CHARS)
  const reply = resolutionMessage('returned', 'c'.repeat(5000))
  assert.ok(Array.from(reply).length <= RESOLUTION_MESSAGE_MAX_CHARS)
  assert.ok(reply.endsWith('…'))
  assert.match(resolutionMessage('passed'), /已通过评审/)
  assert.match(resolutionMessage('void'), /作废/)
  assert.throws(() => resolutionMessage('pending'), RequestSchemaError)
})

test('defaultSummary derives a bounded list line from every payload', () => {
  assert.equal(defaultSummary('user-review', reviewPayload()), 'please review the inbox backend')
  assert.equal(defaultSummary('authorization', { summary: 'may I?' }), 'may I?')
  assert.equal(defaultSummary('question', questionPayload()), 'Ship it?')
  assert.equal(
    defaultSummary('plan', planPayload({ planTitle: undefined })),
    'docs/plan.md',
  )
})

test('payloadProblems accepts each kind and reports the malformed ones', () => {
  assert.deepEqual(payloadProblems('user-review', reviewPayload()), [])
  assert.deepEqual(payloadProblems('authorization', { summary: 'x', command: 'git push' }), [])
  assert.deepEqual(payloadProblems('question', questionPayload()), [])
  assert.deepEqual(payloadProblems('plan', planPayload()), [])

  assert.deepEqual(payloadProblems('user-review', null), ['payload must be a JSON object'])
  assert.match(payloadProblems('user-review', { purpose: '' })[0], /purpose/)
  assert.match(
    payloadProblems('user-review', { purpose: 'x', changedPaths: Array.from({ length: REVIEW_MAX_CHANGED_PATHS + 1 }, () => 'a') })[0],
    /changedPaths/,
  )
  assert.match(
    payloadProblems('user-review', {
      purpose: 'x',
      verification: Array.from({ length: REVIEW_MAX_VERIFICATION + 1 }, () => ({ command: 'c', exitCode: 0, evidence: 'e' })),
    })[0],
    /verification/,
  )
  assert.match(payloadProblems('user-review', { purpose: 'x', verification: [{ command: 'c', exitCode: 1.5, evidence: 'e' }] })[0], /exitCode/)
  assert.match(payloadProblems('authorization', { summary: 'x', command: 'c'.repeat(301) })[0], /command/)
  assert.match(payloadProblems('question', { questions: [] })[0], /between 1 and/)
  assert.match(
    payloadProblems('question', {
      questions: Array.from({ length: QUESTION_MAX_QUESTIONS + 1 }, (_, index) => ({
        id: `q${index}`, prompt: 'p', mode: 'single',
      })),
    })[0],
    /between 1 and/,
  )
  assert.match(
    payloadProblems('question', {
      questions: [{ id: 'q1', prompt: 'p', mode: 'single', options: Array.from({ length: QUESTION_MAX_OPTIONS + 1 }, (_, index) => ({ id: `o${index}`, label: 'l' })) }],
    })[0],
    /options/,
  )
  assert.match(payloadProblems('question', { questions: [{ id: 'q1', prompt: 'p', mode: 'sometimes' }] })[0], /mode/)
  assert.match(payloadProblems('plan', { planPath: '/etc/passwd' })[0], /planPath/)
  assert.match(payloadProblems('plan', { planPath: 'docs/../etc/passwd' })[0], /planPath/)
  assert.match(payloadProblems('plan', { planPath: 'docs\\plan.md' })[0], /planPath/)
  assert.match(payloadProblems('plan', { planPath: 'docs/plan.md', planTitle: 'x'.repeat(121) })[0], /planTitle/)
  assert.match(
    payloadProblems('authorization', { summary: 's', command: 'x'.repeat(REQUEST_PAYLOAD_MAX_BYTES) })[0],
    /bytes|command/,
  )
})

test('requestRecordProblems validates the kind/status/payload combination and the pair', () => {
  assert.deepEqual(requestRecordProblems(record()), [])
  assert.match(requestRecordProblems({ ...record(), version: 2 })[0], /version/)
  assert.match(requestRecordProblems({ ...record(), requestId: '../escape' })[0], /requestId/)
  assert.match(requestRecordProblems({ ...record(), kind: 'other' })[0], /kind/)
  assert.match(requestRecordProblems({ ...record(), status: 'done' })[0], /status/)
  assert.match(
    requestRecordProblems({ ...record(), status: 'allowed' })[0],
    /not a terminal state of kind user-review/,
  )
  assert.match(
    requestRecordProblems({ ...record(), status: 'passed' })[0],
    /resolutionMessage|resolvedAt|resolvedBy/,
  )
  const resolved = applyResolution(record(), { status: 'passed', resolvedBy: 'user', now: NOW })
  assert.deepEqual(requestRecordProblems(resolved), [])
  assert.match(
    requestRecordProblems({ ...record(), resolutionMessage: 'too early' })[0],
    /must be null while the request is pending/,
  )
  assert.match(requestRecordProblems({ ...record(), createdAt: 'later' })[0], /createdAt/)
  assert.match(requestRecordProblems({ ...record(), delivery: { promptedAt: 'later', lastError: null } })[0], /promptedAt/)
  assert.match(
    requestRecordProblems({
      ...record(),
      delivery: { promptedAt: null, lastError: 'e'.repeat(REQUEST_DELIVERY_ERROR_MAX_CHARS + 1) },
    })[0],
    /lastError/,
  )
  assert.match(requestRecordProblems({ ...record(), title: 't'.repeat(121) })[0], /title/)
  assert.match(requestRecordProblems(null)[0], /JSON object/)
})

test('applyResolution writes the reply, the resolver and the timestamps', () => {
  const resolved = applyResolution(record(), {
    status: 'returned',
    comment: 'the dispatch table is not covered',
    resolvedBy: 'user',
    now: NOW,
  })
  assert.equal(resolved.status, 'returned')
  assert.equal(resolved.resolvedAt, NOW_ISO)
  assert.equal(resolved.resolvedBy, 'user')
  assert.match(resolved.resolutionMessage, /已退回评审/)
  assert.match(resolved.resolutionMessage, /dispatch table/)
  assert.throws(
    () => applyResolution(resolved, { status: 'passed', resolvedBy: 'user', now: NOW }),
    RequestSchemaError,
  )
})

test('answerProblems validates questions, options, single mode and free text', () => {
  const payload = questionPayload()
  assert.deepEqual(answerProblems(payload, [{ questionId: 'q1', selected: ['o1'] }]), [])
  assert.deepEqual(answerProblems(payload, [{ questionId: 'q1', text: 'yes please' }]), [])
  assert.match(answerProblems(payload, undefined)[0], /array/)
  assert.match(answerProblems(payload, [])[0], /was not answered/)
  assert.match(answerProblems(payload, [{ questionId: 'q9', selected: ['o1'] }])[0], /unknown question/)
  assert.match(answerProblems(payload, [{ questionId: 'q1', selected: ['o9'] }])[0], /unknown option/)
  assert.match(
    answerProblems(
      { questions: [{ id: 'q1', prompt: 'p', mode: 'single', options: [{ id: 'o1', label: 'a' }, { id: 'o2', label: 'b' }] }] },
      [{ questionId: 'q1', selected: ['o1', 'o2'] }],
    )[0],
    /accepts one selection/,
  )
  assert.match(
    answerProblems({ questions: [{ id: 'q1', prompt: 'p', mode: 'single' }] }, [{ questionId: 'q1', text: 'x'.repeat(501) }])[0],
    /at most 500/,
  )
  assert.match(
    answerProblems({ questions: [{ id: 'q1', prompt: 'p', mode: 'single' }] }, [{ questionId: 'q1', text: 'x' }])[0],
    /does not accept a free-text/,
  )
  assert.match(answerProblems(payload, [{ questionId: 'q1' }])[0], /has no answer/)
})

test('parseRequestRecordText round-trips and refuses damaged documents', () => {
  const parsed = parseRequestRecordText(JSON.stringify(record()))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.record.requestId, 'req-1')
  assert.equal(parseRequestRecordText('{not json').ok, false)
  assert.match(parseRequestRecordText('{not json').problems[0], /invalid JSON/)
  const invalid = parseRequestRecordText(JSON.stringify({ ...record(), status: 'passed' }))
  assert.equal(invalid.ok, false)
})

test('ids, file names, comments and repo-relative paths are guarded', () => {
  assert.equal(isRequestId('2b7f2a1e-0d3c-4d5e-8f90-abcdefabcdef'), true)
  assert.equal(isRequestId('req-1'), true)
  assert.equal(isRequestId('../escape'), false)
  assert.equal(isRequestId('req.1'), false)
  assert.equal(isRequestId(''), false)
  assert.equal(requestFileName('req-1'), 'req-1.json')
  assert.throws(() => requestFileName('../x'), RequestSchemaError)

  assert.equal(normalizeComment(undefined), null)
  assert.equal(normalizeComment('  '), null)
  assert.equal(normalizeComment('  why  '), 'why')
  assert.equal(normalizeComment(3), 'invalid')
  assert.equal(normalizeComment('x'.repeat(2001)), 'invalid')

  assert.equal(isRepoRelativePosixPath('docs/plan.md', PLAN_PATH_MAX_CHARS), true)
  assert.equal(isRepoRelativePosixPath('/abs/plan.md', PLAN_PATH_MAX_CHARS), false)
  assert.equal(isRepoRelativePosixPath('a/../b', PLAN_PATH_MAX_CHARS), false)
  assert.equal(isRepoRelativePosixPath('a//b', PLAN_PATH_MAX_CHARS), false)
  assert.equal(isRepoRelativePosixPath('C:/x', PLAN_PATH_MAX_CHARS), false)
  assert.equal(isRepoRelativePosixPath('', PLAN_PATH_MAX_CHARS), false)
})

test('normalizeQuestion mints the ids the resolve route validates against', () => {
  const question = normalizeQuestion({ prompt: '  pick  ', mode: 'multi', options: [{ label: ' one ', recommended: true }, { label: 'two', description: 'second' }], allowText: true }, 0)
  assert.equal(question.id, 'q1')
  assert.equal(question.prompt, 'pick')
  assert.equal(question.mode, 'multi')
  assert.deepEqual(question.options.map((option) => option.id), ['o1', 'o2'])
  assert.deepEqual(question.options[0], { id: 'o1', label: 'one', recommended: true })
  assert.deepEqual(question.options[1], { id: 'o2', label: 'two', description: 'second' })
  assert.equal(question.allowText, true)
  const fallback = normalizeQuestion({}, 2)
  assert.equal(fallback.id, 'q3')
  assert.equal(fallback.mode, 'single')
  assert.equal(fallback.options, undefined)
})

test('buildRequestRecord refuses an invalid input instead of persisting it', () => {
  assert.throws(
    () => record({ payload: { purpose: '' } }),
    (error) => error instanceof RequestSchemaError && error.problems.length > 0,
  )
  assert.throws(
    () => record({ requestId: 'bad id' }),
    RequestSchemaError,
  )
})
