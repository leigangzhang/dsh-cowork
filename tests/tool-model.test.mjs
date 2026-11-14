import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ERROR_CODES,
  buildThreadBrief,
  checkRole,
  claimMaster,
  failure,
  readCaller,
  success,
} from '../src/platform/tool-model.ts'

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

test('claimMaster keeps the current master and rebinds only on an explicit takeOver', () => {
  const project = index()
  assert.deepEqual(claimMaster(caller(), project), { action: 'current' })
  // The flag is redundant for the incumbent: it never causes a write.
  assert.deepEqual(claimMaster(caller(), project, { takeOver: true }), { action: 'current' })

  const stranger = caller({ sessionId: 'session-stranger' })
  const denied = claimMaster(stranger, project)
  assert.equal(denied?.ok, false)
  assert.equal(denied.error.code, ERROR_CODES.roleForbidden)
  assert.match(denied.error.message, /session-stranger/)
  assert.match(denied.error.message, /takeOver: true/)
  assert.deepEqual(denied.error.details, {
    role: 'master',
    sessionId: 'session-stranger',
    masterSessionId: 'session-master',
  })
  // An explicit false is the same refusal, not a silent takeover.
  assert.deepEqual(claimMaster(stranger, project, { takeOver: false }), denied)

  assert.deepEqual(claimMaster(stranger, project, { takeOver: true }), {
    action: 'takeover',
    previousMasterSessionId: 'session-master',
  })
})

test('a session recorded as a thread can never take over the master role', () => {
  const project = index()
  const threadCaller = caller({ sessionId: 'session-thread-1' })

  const withoutFlag = claimMaster(threadCaller, project)
  assert.equal(withoutFlag?.error.code, ERROR_CODES.roleForbidden)

  const withFlag = claimMaster(threadCaller, project, { takeOver: true })
  assert.equal(withFlag?.error.code, ERROR_CODES.roleForbidden)
  assert.match(withFlag.error.message, /thread/)
  assert.deepEqual(withFlag.error.details, {
    role: 'master',
    sessionId: 'session-thread-1',
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

test('buildThreadBrief carries the project, the topic, the intent, and the request/handoff contract', () => {
  const brief = buildThreadBrief({
    repoPath: '/repo',
    subject: 'wire the store',
    topicId: 'session-thread-1',
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
  assert.match(brief, /cowork topic session-thread-1/)
  assert.match(brief, /other topics/)
  assert.match(brief, /only inside this topic/)
  assert.match(brief, /blocked or done/)
  assert.match(brief, /cowork_review_request/)
  assert.equal(/awaiting_review/.test(brief), false)

  // No intent means no intent line, and a blank intent is dropped too.
  const withoutIntent = buildThreadBrief({ repoPath: '/repo', subject: 's', topicId: 't' })
  assert.ok(!withoutIntent.includes('User intent'), withoutIntent)
  const blankIntent = buildThreadBrief({ repoPath: '/repo', subject: 's', topicId: 't', intent: '   ' })
  assert.ok(!blankIntent.includes('User intent'), blankIntent)
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
    reviewSessionFailed: 'review/session-failed',
    reviewPromptFailed: 'review/prompt-failed',
    reviewWriteFailed: 'review/write-failed',
  })
})
