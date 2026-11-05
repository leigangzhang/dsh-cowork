import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  buildHandoffRecord,
  formatMasterMessage,
  replayPendingHandoffs,
  submitHandoff,
  validateHandoff,
} from '../src/handoff.ts'

const CREATED_AT = '2026-11-05T03:04:05.006Z'
const DELIVERED_AT = '2026-11-05T03:05:00.000Z'

/** A complete, valid handoff input. */
const input = (overrides = {}) => ({
  threadId: 'session-a',
  masterSessionId: 'session-master',
  subject: 'wire the store',
  status: 'awaiting_review',
  summary: 'implemented the project store and its tests',
  decisions: ['keep the store as the only writer'],
  changedPaths: ['src/store.ts', 'tests/store.test.mjs'],
  artifacts: ['.dsh-cowork/handoffs/session-a-20261105T030405006Z.json'],
  verification: [{ command: 'node --test tests/store.test.mjs', exitCode: 0, evidence: 'pass 11' }],
  openIssues: [],
  nextStep: null,
  ...overrides,
})

/** A thread entry for the fake project index. */
const thread = (overrides = {}) => ({
  threadId: 'session-a',
  subject: 'wire the store',
  status: 'new',
  cwd: '/repo',
  worktreePath: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  lastHandoffAt: null,
  ...overrides,
})

/** A project index holding one thread. */
const baseIndex = () => ({
  version: 1,
  projectId: 'github.com-owner-repo',
  masterSessionId: 'session-master',
  createdAt: CREATED_AT,
  threads: [thread()],
})

/**
 * In-memory stand-in for the store port. It records the call order, which is
 * the one property the delivery sequence is defined by, and keeps the files and
 * index the real store would have written.
 */
const createFakeStore = ({ index = baseIndex(), failWrite = false, failMark = false } = {}) => {
  const calls = []
  const files = new Map()
  let current = index
  const store = {
    calls,
    files,
    get index() {
      return current
    },
    async writeHandoff(record) {
      calls.push('writeHandoff')
      if (failWrite) throw new Error('handoff directory is read-only')
      const fileName = `${record.threadId}-${record.createdAt}.json`
      const filePath = join('/fake/handoffs', fileName)
      const file = { filePath, fileName, record: structuredClone(record) }
      files.set(filePath, file)
      return file
    },
    async mutateIndex(mutator) {
      calls.push('mutateIndex')
      current = mutator(current)
      return current
    },
    async readIndex() {
      calls.push('readIndex')
      return current
    },
    async listHandoffs() {
      calls.push('listHandoffs')
      return [...files.values()].sort(
        (left, right) => Date.parse(left.record.createdAt) - Date.parse(right.record.createdAt),
      )
    },
    async markHandoffDelivered(filePath, deliveredAt) {
      calls.push('markHandoffDelivered')
      const file = files.get(filePath)
      if (file === undefined) throw new Error(`unknown handoff: ${filePath}`)
      if (failMark) throw new Error('index is read-only')
      const next = { ...file, record: { ...file.record, deliveredAt } }
      files.set(filePath, next)
      return next
    },
  }
  return store
}

/** A master prompt recorder; `behaviour(text)` decides per message. */
const createPrompter = (behaviour = () => ({ accepted: true })) => {
  const texts = []
  return {
    texts,
    async promptMaster(text) {
      texts.push(text)
      return behaviour(text)
    },
  }
}

/** A clock that walks a fixed list of instants, repeating the last one. */
const sequenceClock = (...stamps) => {
  let at = 0
  return () => new Date(stamps[Math.min(at++, stamps.length - 1)])
}

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

test('validateHandoff rejects thread states and malformed verification rows', () => {
  for (const status of ['new', 'active', 'archived', 'awaiting']) {
    const result = validateHandoff(input({ status }))
    assert.equal(result.ok, false, status)
    assert.deepEqual(fieldsOf(result.errors), ['status'], status)
    assert.match(result.errors[0].message, /awaiting_review\|blocked\|done/)
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
  assert.deepEqual(record.changedPaths, ['src/store.ts', 'tests/store.test.mjs'])

  // Missing optional arrays normalize instead of throwing.
  const normalized = buildHandoffRecord(
    { threadId: 't', masterSessionId: 'm', subject: 's', status: 'done', summary: 'x', verification: [] },
    new Date(CREATED_AT),
  )
  assert.deepEqual(normalized.decisions, [])
  assert.deepEqual(normalized.openIssues, [])
  assert.equal(normalized.nextStep, null)
})

test('submitHandoff writes the file, then the index, then prompts the master', async () => {
  const store = createFakeStore()
  const prompter = createPrompter()
  const promptMaster = async (text) => {
    store.calls.push('promptMaster')
    return prompter.promptMaster(text)
  }
  const ports = { store, promptMaster, clock: sequenceClock(CREATED_AT, DELIVERED_AT) }

  const result = await submitHandoff(ports, input({ status: 'blocked', subject: 'blocked on types' }))
  assert.equal(result.ok, true)
  assert.equal(result.delivered, true)
  assert.equal(result.record.createdAt, CREATED_AT)
  assert.equal(result.record.deliveredAt, DELIVERED_AT)
  assert.equal(result.record.status, 'blocked')
  assert.equal(result.filePath, '/fake/handoffs/session-a-2026-11-05T03:04:05.006Z.json')

  assert.deepEqual(store.calls, ['writeHandoff', 'mutateIndex', 'promptMaster', 'markHandoffDelivered'])
  assert.deepEqual([...store.files.keys()], [result.filePath])
  assert.equal(store.files.get(result.filePath).record.deliveredAt, DELIVERED_AT)

  const entry = store.index.threads[0]
  assert.equal(entry.status, 'blocked')
  assert.equal(entry.lastHandoffAt, CREATED_AT)
  assert.equal(entry.updatedAt, CREATED_AT)
  assert.equal(entry.subject, 'wire the store')
  assert.equal(store.index.masterSessionId, 'session-master')

  const message = prompter.texts[0]
  assert.match(message, /blocked on types/)
  assert.match(message, /status: blocked/)
  assert.match(message, /node --test tests\/store\.test\.mjs/)
  assert.match(message, /exit 0/)
  assert.ok(message.includes(result.filePath), 'message names the handoff file')
})

test('submitHandoff rejects invalid input without touching the store', async () => {
  const store = createFakeStore()
  const prompter = createPrompter()
  const result = await submitHandoff({ store, promptMaster: prompter.promptMaster }, input({ status: 'active' }))
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'handoff/invalid')
  assert.deepEqual(fieldsOf(result.error.errors), ['status'])
  assert.match(result.error.message, /status/)
  assert.deepEqual(store.calls, [])
  assert.equal(store.files.size, 0)
  assert.deepEqual(prompter.texts, [])
})

test('submitHandoff keeps the file and index when delivery fails', async () => {
  const throwing = createFakeStore()
  const throwingResult = await submitHandoff(
    {
      store: throwing,
      promptMaster: async () => {
        throwing.calls.push('promptMaster')
        throw new Error('master session is gone')
      },
      clock: sequenceClock(CREATED_AT),
    },
    input(),
  )
  assert.equal(throwingResult.ok, true)
  assert.equal(throwingResult.delivered, false)
  assert.equal(throwingResult.deliveryError, 'master session is gone')
  assert.deepEqual(throwing.calls, ['writeHandoff', 'mutateIndex', 'promptMaster'])
  assert.equal(throwing.files.size, 1)
  assert.equal([...throwing.files.values()][0].record.deliveredAt, null)
  assert.equal(throwing.index.threads[0].status, 'awaiting_review')
  assert.equal(throwing.index.threads[0].lastHandoffAt, CREATED_AT)

  const refusing = createFakeStore()
  const refusingResult = await submitHandoff(
    {
      store: refusing,
      promptMaster: async () => {
        refusing.calls.push('promptMaster')
        return { accepted: false }
      },
      clock: sequenceClock(CREATED_AT),
    },
    input(),
  )
  assert.equal(refusingResult.ok, true)
  assert.equal(refusingResult.delivered, false)
  assert.match(refusingResult.deliveryError, /did not accept/)
  assert.deepEqual(refusing.calls, ['writeHandoff', 'mutateIndex', 'promptMaster'])
  assert.equal(refusing.files.size, 1)
  assert.equal([...refusing.files.values()][0].record.deliveredAt, null)
})

test('replayPendingHandoffs retries each undelivered handoff once and marks only successes', async () => {
  const store = createFakeStore()
  const seed = (overrides) => {
    const file = {
      filePath: `/fake/handoffs/${overrides.subject}.json`,
      fileName: `${overrides.subject}.json`,
      record: buildHandoffRecord(validateHandoff(input(overrides)).value, new Date(overrides.createdAt)),
    }
    store.files.set(file.filePath, file)
    return file
  }
  const alpha = seed({ subject: 'alpha', createdAt: '2026-11-05T03:00:01.000Z' })
  const bravo = seed({ subject: 'bravo', createdAt: '2026-11-05T03:00:02.000Z' })
  const charlie = seed({
    subject: 'charlie',
    createdAt: '2026-11-05T03:00:03.000Z',
    status: 'done',
  })
  store.files.set(charlie.filePath, {
    ...charlie,
    record: { ...charlie.record, deliveredAt: '2026-11-05T03:00:04.000Z' },
  })
  store.calls.length = 0

  const prompter = createPrompter((text) => {
    if (text.includes('bravo')) throw new Error('master session is gone')
    return { accepted: true }
  })

  const result = await replayPendingHandoffs({
    store,
    promptMaster: prompter.promptMaster,
    clock: sequenceClock(DELIVERED_AT, '2026-11-05T03:06:00.000Z'),
  })

  assert.deepEqual(result, {
    attempted: 2,
    delivered: 1,
    failed: 1,
    failures: [{ threadId: 'session-a', filePath: bravo.filePath, error: 'master session is gone' }],
  })
  assert.equal(prompter.texts.length, 2)
  assert.match(prompter.texts[0], /alpha/)
  assert.match(prompter.texts[1], /bravo/)
  assert.equal(store.files.get(alpha.filePath).record.deliveredAt, DELIVERED_AT)
  assert.equal(store.files.get(bravo.filePath).record.deliveredAt, null)
  assert.equal(store.files.get(charlie.filePath).record.deliveredAt, '2026-11-05T03:00:04.000Z')
  assert.equal(store.calls.filter((call) => call === 'markHandoffDelivered').length, 1)
})

test('replayPendingHandoffs counts a refused master and never blocks the rest', async () => {
  const store = createFakeStore()
  const seed = (subject) => {
    const record = buildHandoffRecord(
      validateHandoff(input({ subject })).value,
      new Date(`2026-11-05T03:00:0${subject.length}.000Z`),
    )
    const file = { filePath: `/fake/handoffs/${subject}.json`, fileName: `${subject}.json`, record }
    store.files.set(file.filePath, file)
    return file
  }
  const one = seed('one')
  const two = seed('two')
  const prompter = createPrompter((text) => ({ accepted: !text.includes('one') }))

  const result = await replayPendingHandoffs({ store, promptMaster: prompter.promptMaster, clock: sequenceClock(DELIVERED_AT) })
  assert.equal(result.attempted, 2)
  assert.equal(result.delivered, 1)
  assert.equal(result.failed, 1)
  assert.match(result.failures[0].error, /did not accept/)
  assert.equal(result.failures[0].filePath, one.filePath)
  assert.equal(store.files.get(one.filePath).record.deliveredAt, null)
  assert.equal(store.files.get(two.filePath).record.deliveredAt, DELIVERED_AT)
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
    'status: awaiting_review',
    'subject: wire the store',
    'implemented the project store and its tests',
    'node --test tests/store.test.mjs (exit 0)',
    'pass 11',
    'node --test tests/handoff.test.mjs (exit 1)',
    'src/store.ts',
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
