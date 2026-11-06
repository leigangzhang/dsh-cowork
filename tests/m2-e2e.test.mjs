import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MAX_ASSISTANT_TEXT,
  MEMORY_TEXT,
  STEP_IDS,
  evidenceDocument,
  memoryVisibilityChecks,
  statusView,
} from '../src/m2-e2e-support.ts'

const here = dirname(fileURLToPath(import.meta.url))
const driverPath = join(here, '..', 'src', 'm2-e2e.ts')
const supportPath = join(here, '..', 'src', 'm2-e2e-support.ts')

/** The per-file budget both halves of the driver must stay under. */
const FILE_BUDGET_BYTES = 50 * 1024

/** A minimal run shaped like the runner's internal state. */
function makeRun(overrides = {}) {
  return {
    runId: 'm2-00000000-0000-0000-0000-000000000000',
    state: 'done',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:01:00.000Z',
    steps: [
      {
        id: 'setup',
        status: 'passed',
        evidence: {
          startedAt: '2026-01-01T00:00:00.000Z',
          endedAt: '2026-01-01T00:00:01.000Z',
          prompts: [],
          observations: {},
          assertions: [],
        },
      },
    ],
    finalIndex: null,
    cleanup: {},
    ...overrides,
  }
}

test('STEP_IDS is the eleven-step M2 sequence in order', () => {
  assert.deepEqual(STEP_IDS, [
    'setup',
    'memory-write',
    'isolated-thread',
    'thread-work',
    'memory-visible',
    'memory-cross-thread',
    'merge-success',
    'conflict-thread',
    'conflict-merge',
    'conflict-retry',
    'cleanup',
  ])
  assert.equal(STEP_IDS.length, 11)
})

test('memory-visible sits between thread-work and memory-cross-thread', () => {
  const visible = STEP_IDS.indexOf('memory-visible')
  assert.equal(visible, STEP_IDS.indexOf('thread-work') + 1)
  assert.equal(visible + 1, STEP_IDS.indexOf('memory-cross-thread'))
})

test('both driver files stay within the per-file budget', () => {
  for (const path of [driverPath, supportPath]) {
    const size = statSync(path).size
    assert.ok(size > 0, path)
    assert.ok(
      size <= FILE_BUDGET_BYTES,
      `${path} is ${size} bytes, above ${FILE_BUDGET_BYTES}`,
    )
  }
})

test('driver sources keep the evidence document free of a hostname field', () => {
  for (const path of [driverPath, supportPath]) {
    const text = readFileSync(path, 'utf8')
    assert.equal(/readonly hostname/.test(text), false, `${path} declares a hostname field`)
    assert.equal(/hostname\(\)/.test(text), false, `${path} calls hostname()`)
    assert.equal(/from 'node:os'/.test(text), false, `${path} imports node:os`)
  }
})

test('the evidence document has host identity by role and no machine name', () => {
  const document = evidenceDocument(
    { pluginName: '@dsh-external/dsh-cowork', pluginVersion: '0.0.1', repoPath: '/repo' },
    makeRun(),
  )

  assert.deepEqual(Object.keys(document.host), [
    'plugin',
    'pluginVersion',
    'node',
    'platform',
    'arch',
    'repoPath',
  ])
  assert.equal('hostname' in document.host, false)
  const serialized = JSON.stringify(document)
  assert.equal(serialized.includes(hostname()), false)
  assert.equal(serialized.includes('hostname'), false)
})

test('memoryVisibilityChecks accepts an exact, tool-free reply', () => {
  const checks = memoryVisibilityChecks(MEMORY_TEXT, 0)

  assert.equal(checks.length, 2)
  assert.deepEqual(checks.map((check) => check.passed), [true, true])
  assert.equal(checks[0].detail, MEMORY_TEXT)
})

test('memoryVisibilityChecks rejects a reply that misses the constraint text', () => {
  const checks = memoryVisibilityChecks('我没有看到这条约束。', 0)

  assert.equal(checks[0].passed, false)
  assert.equal(checks[1].passed, true)
  assert.ok(checks[0].detail.length <= MAX_ASSISTANT_TEXT + 1)
})

test('memoryVisibilityChecks rejects a reply that called a tool', () => {
  const checks = memoryVisibilityChecks(MEMORY_TEXT, 1)

  assert.equal(checks[0].passed, true)
  assert.equal(checks[1].passed, false)
  assert.equal(checks[1].detail, 'toolCalls=1')
})

test('statusView deep-clones the run and names the evidence file', () => {
  const run = makeRun()
  const view = statusView(run, '/repo/.dsh-cowork/e2e/M2_E2E.json')

  assert.equal(view.evidenceFile, '/repo/.dsh-cowork/e2e/M2_E2E.json')
  assert.equal(view.steps.length, 1)

  view.steps[0].status = 'failed'
  assert.equal(run.steps[0].status, 'passed')
})
