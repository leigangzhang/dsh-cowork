import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ERROR_CODES,
  buildThreadBrief,
  checkRole,
  failure,
  readCaller,
  routePayload,
  success,
} from '../src/tool-model.ts'

const execWith = ({ id, cwd, agentPreset } = {}) => ({
  agent: {
    id,
    session: { header: { cwd, agentPreset } },
  },
})

const caller = (overrides = {}) => ({ sessionId: 'session-master', cwd: '/repo', ...overrides })
const index = (overrides = {}) => ({
  masterSessionId: 'session-master',
  threads: [{ threadId: 'session-thread-1' }, { threadId: 'session-thread-2' }],
  ...overrides,
})

test('readCaller returns null unless both the session id and the cwd are non-empty strings', () => {
  assert.equal(readCaller(null), null)
  assert.equal(readCaller(undefined), null)
  assert.equal(readCaller('exec'), null)
  assert.equal(readCaller({}), null)
  assert.equal(readCaller({ agent: null }), null)
  assert.equal(readCaller({ agent: {} }), null)
  assert.equal(readCaller({ agent: { id: 'session-a' } }), null)
  assert.equal(readCaller({ agent: { id: 'session-a', session: {} } }), null)
  assert.equal(readCaller({ agent: { id: 'session-a', session: { header: {} } } }), null)
  // An id but no cwd is not a usable identity: the project root would be a guess.
  assert.equal(readCaller(execWith({ id: 'session-a' })), null)
  // A cwd but no id is just as unusable.
  assert.equal(readCaller(execWith({ cwd: '/repo' })), null)
  assert.equal(readCaller(execWith({ id: '   ', cwd: '/repo' })), null)
  assert.equal(readCaller(execWith({ id: 'session-a', cwd: '  ' })), null)

  assert.deepEqual(readCaller(execWith({ id: 'session-a', cwd: '/repo' })), {
    sessionId: 'session-a',
    cwd: '/repo',
  })
  assert.deepEqual(readCaller(execWith({ id: 'session-a', cwd: '/repo', agentPreset: 'cowork-master' })), {
    sessionId: 'session-a',
    cwd: '/repo',
    agentPreset: 'cowork-master',
  })
  // A blank preset is treated as absent rather than as a preset named "".
  assert.deepEqual(readCaller(execWith({ id: 'session-a', cwd: '/repo', agentPreset: '  ' })), {
    sessionId: 'session-a',
    cwd: '/repo',
  })
})

test('checkRole allows exactly the sessions the role names', () => {
  const project = index()
  assert.equal(checkRole('master', caller(), project), null)
  assert.equal(checkRole('thread', caller(), project)?.error.code, ERROR_CODES.roleForbidden)
  assert.equal(checkRole('master-or-thread', caller(), project), null)

  assert.equal(checkRole('master', caller({ sessionId: 'session-thread-1' }), project)?.error.code, 'role/forbidden')
  assert.equal(checkRole('thread', caller({ sessionId: 'session-thread-1' }), project), null)
  assert.equal(checkRole('master-or-thread', caller({ sessionId: 'session-thread-2' }), project), null)

  assert.equal(checkRole('thread', caller({ sessionId: 'session-stranger' }), project)?.error.code, 'role/forbidden')
  assert.equal(checkRole('master-or-thread', caller({ sessionId: 'session-stranger' }), project)?.error.code, 'role/forbidden')
})

test('a role refusal names the role, the caller, and the registered master', () => {
  const denied = checkRole('master', caller({ sessionId: 'session-stranger' }), index())
  assert.ok(denied !== null)
  assert.equal(denied.ok, false)
  assert.equal(denied.error.code, 'role/forbidden')
  assert.match(denied.error.message, /master/)
  assert.match(denied.error.message, /session-stranger/)
  assert.deepEqual(denied.error.details, {
    role: 'master',
    sessionId: 'session-stranger',
    masterSessionId: 'session-master',
  })
})

test('failure and success build the one envelope shape the tools return', () => {
  assert.deepEqual(failure('route/intent-required', 'intent must not be empty'), {
    ok: false,
    error: { code: 'route/intent-required', message: 'intent must not be empty' },
  })
  assert.deepEqual(failure('role/forbidden', 'nope', { role: 'thread' }), {
    ok: false,
    error: { code: 'role/forbidden', message: 'nope', details: { role: 'thread' } },
  })
  // details stays absent instead of becoming `undefined`, so the JSON is clean.
  assert.equal('details' in failure('x', 'y').error, false)

  assert.deepEqual(success({ threads: [] }), { ok: true, threads: [] })
  const merged = success({ delivered: false, filePath: '/repo/h.json' })
  assert.equal(merged.ok, true)
  assert.equal(merged.filePath, '/repo/h.json')
})

test('buildThreadBrief carries the project, the thread, the intent, and the handoff contract', () => {
  const brief = buildThreadBrief({
    repoPath: '/repo',
    subject: 'wire the store',
    threadId: 'session-thread-1',
    intent: 'add a project store',
  })
  assert.match(brief, /\/repo/)
  assert.match(brief, /session-thread-1/)
  assert.match(brief, /wire the store/)
  assert.match(brief, /add a project store/)
  assert.match(brief, /cowork_handoff/)
  assert.match(brief, /status/)
  assert.match(brief, /summary/)
  assert.match(brief, /verification/)
  assert.match(brief, /other threads/)
  assert.match(brief, /only inside this thread/)

  // No intent means no intent line, and a blank intent is dropped too.
  const withoutIntent = buildThreadBrief({ repoPath: '/repo', subject: 's', threadId: 't' })
  assert.ok(!withoutIntent.includes('User intent'), withoutIntent)
  const blankIntent = buildThreadBrief({ repoPath: '/repo', subject: 's', threadId: 't', intent: '   ' })
  assert.ok(!blankIntent.includes('User intent'), blankIntent)
})

test('routePayload maps the three router decisions onto the tool payload', () => {
  const candidates = [
    { threadId: 'session-a', subject: 'store', status: 'active', score: 10 },
    { threadId: 'session-b', subject: 'router', status: 'awaiting_review', score: 9 },
  ]

  const routed = routePayload({ action: 'reuse', threadId: 'session-a', score: 10, candidates })
  assert.deepEqual(routed, {
    action: 'routed',
    threadId: 'session-a',
    score: 10,
    candidates: [
      { threadId: 'session-a', subject: 'store', status: 'active', score: 10 },
      { threadId: 'session-b', subject: 'router', status: 'awaiting_review', score: 9 },
    ],
  })

  // `create` carries no thread id: the tool adds it once the session exists.
  const created = routePayload({ action: 'create', candidates })
  assert.equal(created.action, 'created')
  assert.deepEqual(created.candidates, candidates)

  const needsSubject = routePayload({ action: 'needs_subject', candidates })
  assert.deepEqual(needsSubject, { action: 'needs_subject', candidates })

  // Candidates are copied, so the caller cannot mutate a payload after the fact.
  const payload = routePayload({ action: 'create', candidates })
  candidates[0].score = 99
  assert.equal(payload.candidates[0].score, 10)
})

test('ERROR_CODES keeps the wire strings stable', () => {
  assert.deepEqual(ERROR_CODES, {
    agentUnavailable: 'exec/agent-unavailable',
    roleForbidden: 'role/forbidden',
    projectNotInitialized: 'project/not-initialized',
    handoffInvalid: 'handoff/invalid',
    intentRequired: 'route/intent-required',
    sessionMissing: 'thread/session-missing',
    storeCorrupt: 'store/corrupt',
    memoryInvalid: 'memory/invalid',
    memoryWriteFailed: 'memory/write-failed',
    threadNotFound: 'thread/not-found',
    checkoutNotFound: 'checkout/not-found',
    checkoutAlreadyExists: 'checkout/already-exists',
    checkoutCreateFailed: 'checkout/create-failed',
    checkoutInvalidBaseRef: 'checkout/invalid-base-ref',
    checkoutPathGuard: 'checkout/path-guard',
    checkoutDirty: 'checkout/dirty',
    checkoutMergeConflict: 'checkout/merge-conflict',
    checkoutMergeFailed: 'checkout/merge-failed',
    checkoutGitFailed: 'checkout/git-failed',
    checkoutNotReady: 'checkout/not-ready',
    reviewNotReady: 'review/not-ready',
    reviewAlreadyPending: 'review/already-pending',
    reviewNotReviewer: 'review/not-reviewer',
    reviewSelfReview: 'review/self-review',
    reviewVerdictInvalid: 'review/verdict-invalid',
    reviewNotPassed: 'review/not-passed',
    reviewOverrideReasonRequired: 'review/override-reason-required',
    reviewSessionFailed: 'review/session-failed',
    reviewPromptFailed: 'review/prompt-failed',
    reviewWriteFailed: 'review/write-failed',
  })
})
