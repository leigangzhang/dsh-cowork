import test from 'node:test'
import assert from 'node:assert/strict'
import { buildHandoffRecord, formatMasterMessage, validateHandoff } from '../src/handoff.ts'

/**
 * M10.4 contract tests for the handoff model: the write-side status vocabulary
 * (`blocked|done` only), record building, and the readable master message.
 *
 * Reading old handoff files is deliberately wider (`awaiting_review` still
 * parses through `handoffRecordProblems` in src/store-schema.ts); the store's
 * own tests own that side. M10 removed the legacy submit/replay helpers from
 * this module, so nothing here delivers a handoff or rewrites an old file.
 */

const CREATED_AT = '2026-11-05T03:04:05.006Z'

/** A complete, valid handoff input. */
const input = (overrides = {}) => ({
  threadId: 'session-a',
  masterSessionId: 'session-master',
  subject: 'wire the store',
  status: 'blocked',
  summary: 'implemented the project store and its tests',
  decisions: ['keep the store as the only writer'],
  changedPaths: ['src/store/project-store.ts', 'tests/store.test.mjs'],
  artifacts: ['.dsh-cowork/handoffs/session-a-20261105T030405006Z.json'],
  verification: [{ command: 'node --test tests/store.test.mjs', exitCode: 0, evidence: 'pass 11' }],
  openIssues: [],
  nextStep: null,
  ...overrides,
})

// A valid result has no `errors` field; it also has no rejected fields.
const fieldsOf = (errors) => (Array.isArray(errors) ? errors.map((error) => error.field).sort() : [])

test('validateHandoff accepts a complete handoff and normalizes optional fields', () => {
  const full = validateHandoff(input())
  assert.equal(full.ok, true)
  assert.deepEqual(full.value, input())

  const minimal = validateHandoff({
    threadId: 'session-a',
    masterSessionId: 'session-master',
    subject: 'wire the store',
    status: 'done',
    summary: '  done  ',
    verification: [{ command: 'node --test', exitCode: 0, evidence: '' }],
  })
  assert.equal(minimal.ok, true)
  assert.deepEqual(minimal.value.decisions, [])
  assert.deepEqual(minimal.value.changedPaths, [])
  assert.deepEqual(minimal.value.artifacts, [])
  assert.deepEqual(minimal.value.openIssues, [])
  assert.equal(minimal.value.nextStep, null)
  // An explicit JSON null for an optional field means "not stated", not "wrong type".
  const withNulls = validateHandoff(input({ decisions: null, changedPaths: null, nextStep: null }))
  assert.equal(withNulls.ok, true)
  assert.deepEqual(withNulls.value.decisions, [])
  assert.equal(withNulls.value.nextStep, null)
})

test('validateHandoff reports every missing required field at once', () => {
  const result = validateHandoff({})
  assert.equal(result.ok, false)
  assert.deepEqual(fieldsOf(result.errors), [
    'masterSessionId',
    'status',
    'subject',
    'summary',
    'threadId',
    'verification',
  ])

  const notAnObject = validateHandoff('handoff please')
  assert.equal(notAnObject.ok, false)
  assert.deepEqual(fieldsOf(notAnObject.errors), ['input'])

  const blank = validateHandoff(
    input({ threadId: '   ', masterSessionId: '', subject: '  ', summary: '\n\t ' }),
  )
  assert.equal(blank.ok, false)
  assert.deepEqual(fieldsOf(blank.errors), ['masterSessionId', 'subject', 'summary', 'threadId'])
})

test('validateHandoff accepts only blocked|done and rejects awaiting_review and thread states', () => {
  for (const status of ['new', 'active', 'archived', 'awaiting', 'awaiting_review']) {
    const result = validateHandoff(input({ status }))
    assert.equal(result.ok, false, status)
    assert.deepEqual(fieldsOf(result.errors), ['status'], status)
    assert.match(result.errors[0].message, /status must be one of blocked\|done/)
  }
  assert.equal(validateHandoff(input({ status: 'blocked' })).ok, true)
  assert.equal(validateHandoff(input({ status: 'done' })).ok, true)
  assert.equal(validateHandoff(input({ status: undefined })).ok, false)

  assert.deepEqual(fieldsOf(validateHandoff(input({ verification: [] })).errors), ['verification'])
  assert.deepEqual(fieldsOf(validateHandoff(input({ verification: 'node --test' })).errors), ['verification'])
  assert.deepEqual(fieldsOf(validateHandoff(input({ verification: [null] })).errors), ['verification[0]'])

  const rowProblems = (row) => fieldsOf(validateHandoff(input({ verification: [row] })).errors)
  assert.deepEqual(rowProblems({ command: '  ', exitCode: 0, evidence: '' }), ['verification[0].command'])
  assert.deepEqual(rowProblems({ command: 'node', exitCode: 1.5, evidence: '' }), ['verification[0].exitCode'])
  assert.deepEqual(rowProblems({ command: 'node', exitCode: '0', evidence: '' }), ['verification[0].exitCode'])
  assert.deepEqual(rowProblems({ command: 'node', exitCode: 0, evidence: null }), ['verification[0].evidence'])
  assert.deepEqual(rowProblems({ command: 'node', exitCode: 0, evidence: '' }), [])

  // Every problem of a multi-row verification is reported, not just the first.
  const several = validateHandoff(
    input({
      verification: [
        { command: '', exitCode: 0, evidence: '' },
        { command: 'node', exitCode: 0, evidence: 7 },
      ],
    }),
  )
  assert.deepEqual(fieldsOf(several.errors), ['verification[0].command', 'verification[1].evidence'])

  for (const field of ['decisions', 'changedPaths', 'artifacts', 'openIssues']) {
    assert.deepEqual(fieldsOf(validateHandoff(input({ [field]: 'nope' })).errors), [field], field)
    assert.deepEqual(fieldsOf(validateHandoff(input({ [field]: ['ok', 7] })).errors), [field], field)
  }
  assert.deepEqual(fieldsOf(validateHandoff(input({ nextStep: 3 })).errors), ['nextStep'])
  assert.equal(validateHandoff(input({ nextStep: 'run typecheck' })).value?.nextStep, 'run typecheck')
})

test('buildHandoffRecord stamps version, createdAt and the undelivered state', () => {
  const draft = validateHandoff(input())
  assert.equal(draft.ok, true)
  const record = buildHandoffRecord(draft.value, new Date(CREATED_AT))
  assert.equal(record.version, 1)
  assert.equal(record.createdAt, CREATED_AT)
  assert.equal(record.deliveredAt, null)
  assert.deepEqual(record.verification, input().verification)
  // Arrays are copied, so a later edit of the draft cannot rewrite the record.
  draft.value.changedPaths.push('src/late.ts')
  assert.deepEqual(record.changedPaths, ['src/store/project-store.ts', 'tests/store.test.mjs'])

  // Missing optional arrays normalize instead of throwing.
  const normalized = buildHandoffRecord(
    { threadId: 't', masterSessionId: 'm', subject: 's', status: 'done', summary: 'x', verification: [] },
    new Date(CREATED_AT),
  )
  assert.deepEqual(normalized.decisions, [])
  assert.deepEqual(normalized.openIssues, [])
  assert.equal(normalized.nextStep, null)
})

test('formatMasterMessage is readable text with the handoff facts, not JSON', () => {
  const record = buildHandoffRecord(
    validateHandoff(
      input({
        openIssues: ['worktree cleanup is manual'],
        verification: [
          { command: 'node --test tests/store.test.mjs', exitCode: 0, evidence: 'pass 11' },
          { command: 'node --test tests/handoff.test.mjs', exitCode: 1, evidence: '' },
        ],
      }),
    ).value,
    new Date(CREATED_AT),
  )
  const message = formatMasterMessage(record, '/repo/.dsh-cowork/handoffs/h.json')

  for (const expected of [
    'session-a',
    'status: blocked',
    'subject: wire the store',
    'implemented the project store and its tests',
    'node --test tests/store.test.mjs (exit 0)',
    'pass 11',
    'node --test tests/handoff.test.mjs (exit 1)',
    'src/store/project-store.ts',
    'tests/store.test.mjs',
    'worktree cleanup is manual',
    '/repo/.dsh-cowork/handoffs/h.json',
  ]) {
    assert.ok(message.includes(expected), `missing ${expected} in:\n${message}`)
  }
  assert.ok(!message.includes('"version"'), 'message must not embed the record JSON')
  assert.ok(!message.includes('{'), 'message must not embed JSON braces')

  // Empty sections are omitted rather than rendered empty.
  const bare = formatMasterMessage(
    buildHandoffRecord(
      validateHandoff(
        input({ changedPaths: [], openIssues: [], verification: [{ command: 'true', exitCode: 0, evidence: '' }] }),
      ).value,
      new Date(CREATED_AT),
    ),
    '/repo/h.json',
  )
  assert.ok(!bare.includes('changed paths:'), bare)
  assert.ok(!bare.includes('open issues:'), bare)
  assert.match(bare, /true \(exit 0\)/)
})
