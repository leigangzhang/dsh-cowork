import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import './support/ts-hook.mjs'

const {
  AUTHORIZATION_COMMAND_MAX_CHARS,
  INBOX_ERROR_CODES,
  INBOX_MAX_ITEMS,
  INBOX_MAX_REQUEST_FILES,
  INBOX_NOTIFICATION_KINDS,
  INBOX_OPEN_PATH,
  INBOX_PATH,
  INBOX_RESOLVE_PATH,
  OPEN_FILE_MAX_BYTES,
  PLAN_PATH_MAX_CHARS,
  PLAN_TITLE_MAX_CHARS,
  QUESTION_MAX_OPTIONS,
  QUESTION_MAX_QUESTIONS,
  QUESTION_OPTION_DESCRIPTION_MAX_CHARS,
  QUESTION_OPTION_LABEL_MAX_CHARS,
  QUESTION_PROMPT_MAX_CHARS,
  QUESTION_TEXT_MAX_CHARS,
  REQUEST_ACTIONS,
  REQUEST_ACTIONS_BY_KIND,
  REQUEST_ACTION_STATUS,
  REQUEST_COMMENT_MAX_CHARS,
  REQUEST_COUNT_FIELD,
  REQUEST_KINDS,
  REQUEST_MESSAGE_MAX_CHARS,
  REQUEST_PAYLOAD_MAX_BYTES,
  REQUEST_PENDING_LABELS,
  REQUEST_RECORD_VERSION,
  REQUEST_STATUSES,
  REQUEST_STATUS_LABELS,
  REQUEST_SUMMARY_MAX_CHARS,
  REQUEST_TITLE_MAX_CHARS,
  RESOLUTION_MESSAGE_MAX_CHARS,
  REVIEW_MAX_CHANGED_PATHS,
  REVIEW_MAX_VERIFICATION,
  REVIEW_PURPOSE_MAX_CHARS,
  REVIEW_TEXT_MAX_CHARS,
  actionAllowed,
  actionForStatus,
  actionsForKind,
  emptyInboxCounts,
  isInboxNotificationKind,
  isRequestAction,
  isRequestKind,
  isRequestStatus,
  isTerminalStatus,
  statusForAction,
} = await import('../src/inbox-contract.ts')
const { PANEL_ERROR_STATUS } = await import('../src/api-contract.ts')

/** The one place the four kinds are restated: this frozen contract test. */
const KINDS = ['user-review', 'authorization', 'question', 'plan']

test('the three route paths are the frozen ones', () => {
  assert.deepEqual([INBOX_PATH, INBOX_RESOLVE_PATH, INBOX_OPEN_PATH], [
    '/api/cowork.inbox',
    '/api/cowork.inbox.resolve',
    '/api/cowork.inbox.open',
  ])
  for (const path of [INBOX_PATH, INBOX_RESOLVE_PATH, INBOX_OPEN_PATH]) {
    assert.equal(path.startsWith('/api/'), true, `${path} stays below /api`)
  }
  assert.equal(new Set([INBOX_PATH, INBOX_RESOLVE_PATH, INBOX_OPEN_PATH]).size, 3)
})

test('the four kinds are exactly the design kinds, in order', () => {
  assert.deepEqual([...REQUEST_KINDS], KINDS)
  assert.deepEqual([...REQUEST_STATUSES], [
    'pending', 'passed', 'returned', 'allowed', 'denied',
    'answered', 'skipped', 'approved', 'revise', 'void',
  ])
  assert.deepEqual([...REQUEST_ACTIONS], [
    'pass', 'return', 'allow', 'deny', 'submit', 'skip', 'approve', 'revise',
  ])
})

test('every kind offers its own two actions, deny/allow order included', () => {
  assert.deepEqual(REQUEST_ACTIONS_BY_KIND, {
    'user-review': ['return', 'pass'],
    authorization: ['deny', 'allow'],
    question: ['skip', 'submit'],
    plan: ['revise', 'approve'],
  })
  for (const kind of REQUEST_KINDS) {
    const actions = actionsForKind(kind)
    assert.equal(actions.length, 2, kind)
    for (const action of actions) assert.equal(actionAllowed(kind, action), true, `${kind}/${action}`)
  }
  // Every action belongs to exactly one kind, so the eight actions partition.
  const owned = REQUEST_KINDS.flatMap((kind) => [...REQUEST_ACTIONS_BY_KIND[kind]])
  assert.equal(new Set(owned).size, REQUEST_ACTIONS.length)
})

test('the action/status tables are inverses and every terminal status has its action', () => {
  assert.deepEqual(REQUEST_ACTION_STATUS, {
    pass: 'passed',
    return: 'returned',
    allow: 'allowed',
    deny: 'denied',
    submit: 'answered',
    skip: 'skipped',
    approve: 'approved',
    revise: 'revise',
  })
  for (const action of REQUEST_ACTIONS) {
    const status = statusForAction(action)
    assert.equal(status, REQUEST_ACTION_STATUS[action])
    assert.equal(actionForStatus(status), action, 'the same action round-trips')
    assert.equal(isTerminalStatus(status), true)
  }
  assert.equal(actionForStatus('pending'), null)
  assert.equal(actionForStatus('void'), null, 'void is not produced by any action')
  assert.equal(isTerminalStatus('pending'), false)
  assert.equal(isTerminalStatus('void'), true)
})

test('the status and pending labels cover every state and kind', () => {
  assert.deepEqual(Object.keys(REQUEST_STATUS_LABELS).sort(), [...REQUEST_STATUSES].sort())
  assert.deepEqual(REQUEST_PENDING_LABELS, {
    'user-review': '等待审核',
    authorization: '等待审批',
    question: '问题',
    plan: '计划待审',
  })
  for (const label of Object.values(REQUEST_STATUS_LABELS)) assert.equal(label.length > 0, true)
})

test('the count field maps each kind onto one InboxCounts key', () => {
  assert.deepEqual(REQUEST_COUNT_FIELD, {
    'user-review': 'review',
    authorization: 'authorization',
    question: 'question',
    plan: 'plan',
  })
  assert.deepEqual(emptyInboxCounts(), { pending: 0, review: 0, authorization: 0, question: 0, plan: 0 })
  const counts = emptyInboxCounts()
  for (const field of Object.values(REQUEST_COUNT_FIELD)) {
    assert.equal(Object.hasOwn(counts, field), true, field)
    assert.equal(field === 'pending', false, 'pending is the total, not a kind')
  }
})

test('the notification kinds cover the four note events plus the reviewer verdict', () => {
  assert.deepEqual([...INBOX_NOTIFICATION_KINDS], [
    'assignment', 'report', 'proposal', 'archive', 'review-verdict',
  ])
  assert.equal(INBOX_NOTIFICATION_KINDS.includes('authorization'), false, 'authorization is a request card')
  for (const kind of INBOX_NOTIFICATION_KINDS) assert.equal(isInboxNotificationKind(kind), true, kind)
  assert.equal(isInboxNotificationKind('authorization'), false)
  assert.equal(isInboxNotificationKind(''), false)
  assert.equal(isInboxNotificationKind(null), false)
})

test('the guards accept only the frozen vocabulary', () => {
  for (const kind of KINDS) assert.equal(isRequestKind(kind), true, kind)
  assert.equal(isRequestKind('review'), false)
  assert.equal(isRequestKind(3), false)
  for (const status of REQUEST_STATUSES) assert.equal(isRequestStatus(status), true, status)
  assert.equal(isRequestStatus('done'), false)
  for (const action of REQUEST_ACTIONS) assert.equal(isRequestAction(action), true, action)
  assert.equal(isRequestAction('approve-all'), false)
  assert.equal(isRequestAction(undefined), false)
})

test('every cap is the frozen positive integer', () => {
  assert.equal(INBOX_MAX_ITEMS, 50)
  assert.equal(INBOX_MAX_REQUEST_FILES, 200)
  assert.equal(REQUEST_RECORD_VERSION, 1)
  assert.equal(REQUEST_TITLE_MAX_CHARS, 120)
  assert.equal(REQUEST_SUMMARY_MAX_CHARS, 500)
  assert.equal(REQUEST_MESSAGE_MAX_CHARS, 400)
  assert.equal(RESOLUTION_MESSAGE_MAX_CHARS, 200)
  assert.equal(REQUEST_COMMENT_MAX_CHARS, 2000)
  assert.equal(REQUEST_PAYLOAD_MAX_BYTES, 8192)
  assert.equal(REVIEW_PURPOSE_MAX_CHARS, 500)
  assert.equal(REVIEW_MAX_CHANGED_PATHS, 50)
  assert.equal(REVIEW_MAX_VERIFICATION, 10)
  assert.equal(REVIEW_TEXT_MAX_CHARS, 300)
  assert.equal(AUTHORIZATION_COMMAND_MAX_CHARS, 300)
  assert.equal(QUESTION_MAX_QUESTIONS, 5)
  assert.equal(QUESTION_MAX_OPTIONS, 10)
  assert.equal(QUESTION_PROMPT_MAX_CHARS, 500)
  assert.equal(QUESTION_OPTION_LABEL_MAX_CHARS, 80)
  assert.equal(QUESTION_OPTION_DESCRIPTION_MAX_CHARS, 200)
  assert.equal(QUESTION_TEXT_MAX_CHARS, 500)
  assert.equal(PLAN_PATH_MAX_CHARS, 500)
  assert.equal(PLAN_TITLE_MAX_CHARS, 120)
  assert.equal(OPEN_FILE_MAX_BYTES, 1_048_576)
  assert.ok(RESOLUTION_MESSAGE_MAX_CHARS <= REQUEST_MESSAGE_MAX_CHARS)
  assert.ok(INBOX_MAX_ITEMS <= INBOX_MAX_REQUEST_FILES)
})

test('the notice kinds have one home in notice-contract.ts and the inbox derives from it', async () => {
  const noticeContract = await readFile(new URL('../src/notice-contract.ts', import.meta.url), 'utf8')
  const notices = await readFile(new URL('../src/notices.ts', import.meta.url), 'utf8')
  const noticeModel = await readFile(new URL('../src/client/notice-model.ts', import.meta.url), 'utf8')
  const inboxContract = await readFile(new URL('../src/inbox-contract.ts', import.meta.url), 'utf8')
  assert.equal((noticeContract.match(/export const NOTICE_KINDS =/g) ?? []).length, 1)
  for (const [name, source] of [['notices.ts', notices], ['client/notice-model.ts', noticeModel]]) {
    assert.equal(source.includes("= ['assignment'"), false, `${name} must not restate the notice kinds`)
    assert.match(source, /notice-contract/)
  }
  assert.match(inboxContract, /NOTICE_KINDS\.filter\(/)
  assert.match(inboxContract, /INBOX_NOTIFICATION_KINDS = \[\.\.\.INBOX_NOTICE_KINDS, 'review-verdict'\] as const/)
})

test('the eight inbox error codes are ordinary panel codes with a decided status', () => {
  assert.deepEqual([...INBOX_ERROR_CODES], [
    'inbox/request-not-found',
    'inbox/request-resolved',
    'inbox/action-not-allowed',
    'inbox/invalid-answer',
    'inbox/invalid-comment',
    'inbox/path-missing',
    'inbox/open-unsupported',
    'inbox/not-member',
  ])
  for (const code of INBOX_ERROR_CODES) {
    assert.equal(Object.hasOwn(PANEL_ERROR_STATUS, code), true, `${code} must map to a status`)
    assert.equal(Number.isInteger(PANEL_ERROR_STATUS[code]), true, code)
  }
  assert.equal(PANEL_ERROR_STATUS['inbox/request-not-found'], 404)
  assert.equal(PANEL_ERROR_STATUS['inbox/request-resolved'], 409)
  assert.equal(PANEL_ERROR_STATUS['inbox/not-member'], 403)
  assert.equal(PANEL_ERROR_STATUS['inbox/open-unsupported'], 501)
})
