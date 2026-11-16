import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  collectSurfaceKeys,
  e2eEvidenceProblems,
  e2eManifestProblems,
  WORK_ITEM_STORE_ONLY_STATUSES,
} from '../../tools/e2e-coverage.mjs'
import { hostSupport, parseHostVersion } from '../../tests/e2e/support/versions.mjs'

/**
 * The E2E catalog is two homes that must agree: the manifest declares what the
 * suite runs and covers, and the live public surface says what exists. This test
 * proves the real repository agrees, that each scenario file exports the
 * manifest's id and mode, and that the checker's negatives really fail.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const manifestDir = resolve(root, 'tests/e2e')
const manifest = JSON.parse(readFileSync(resolve(manifestDir, 'manifest.json'), 'utf8'))
const debt = JSON.parse(readFileSync(resolve(manifestDir, 'coverage-debt.json'), 'utf8'))
const packageVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
const evidence = JSON.parse(readFileSync(resolve(manifestDir, 'evidence', `${packageVersion}.json`), 'utf8'))
const keylessIds = new Set(manifest.scenarios.filter((scenario) => scenario.mode === 'keyless').map((scenario) => scenario.id))

const SURFACE_KEYS = ['preset:p', 'route:/x GET', 'tool:a', 'topic-status:active']
const SCENARIO = {
  id: 's1',
  file: 'scenarios/s1.mjs',
  mode: 'keyless',
  summary: 'fixture',
  covers: [...SURFACE_KEYS],
}
const BASE_MANIFEST = {
  formatVersion: 1,
  pluginVersion: '1.0.0',
  host: { tested: ['1.0.0'], compatibleMajorMinor: '1.0' },
  scenarios: [SCENARIO],
}

/** Evaluate one synthetic catalog; every scenario file exists. */
function problems(overrides = {}) {
  return e2eManifestProblems({
    packageVersion: '1.0.0',
    manifest: BASE_MANIFEST,
    debt: { entries: [] },
    surfaceKeys: SURFACE_KEYS,
    manifestDir: '/fixture/tests/e2e',
    fileExists: () => true,
    ...overrides,
  })
}

test('the matrix excludes only store-only work-item states', async () => {
  const schema = await import('../../src/store/schema.ts')
  assert.deepEqual(WORK_ITEM_STORE_ONLY_STATUSES, ['abandoned'])
  for (const status of WORK_ITEM_STORE_ONLY_STATUSES) assert.ok(schema.WORK_ITEM_STATUSES.includes(status))
  const surfaceKeys = await collectSurfaceKeys()
  for (const status of schema.WORK_ITEM_STATUSES) {
    assert.equal(
      surfaceKeys.includes(`work-item-status:${status}`),
      !WORK_ITEM_STORE_ONLY_STATUSES.includes(status),
      `matrix membership for ${status}`,
    )
  }
})

test('the live repository catalog is green against the derived public surface', async () => {
  const surfaceKeys = await collectSurfaceKeys()
  assert.equal(new Set(surfaceKeys).size, surfaceKeys.length, 'surface keys must be unique')
  assert.deepEqual(
    e2eManifestProblems({
      packageVersion,
      manifest,
      debt,
      surfaceKeys,
      manifestDir,
    }),
    [],
  )
})

test('every manifest scenario file exports the same id and a run function', async () => {
  for (const entry of manifest.scenarios) {
    const module = await import(resolve(manifestDir, entry.file))
    assert.equal(module.id, entry.id, `${entry.file} id`)
    assert.equal(typeof module.run, 'function', `${entry.file} run export`)
  }
})

test('the committed evidence matches the current version and every keyless scenario', () => {
  assert.deepEqual(e2eEvidenceProblems({ packageVersion, evidence, keylessScenarioIds: keylessIds }), [])
})

test('the evidence checker rejects a missing, failed, or partial summary', () => {
  assert.ok(e2eEvidenceProblems({ packageVersion, evidence: null, keylessScenarioIds: keylessIds })
    .some((problem) => problem.includes('is missing')))
  const failed = structuredClone(evidence)
  failed.scenarios[0].passed = false
  assert.ok(e2eEvidenceProblems({ packageVersion, evidence: failed, keylessScenarioIds: keylessIds })
    .some((problem) => problem.includes('passed must be true')))
  const partial = structuredClone(evidence)
  partial.scenarios = partial.scenarios.slice(1)
  assert.ok(e2eEvidenceProblems({ packageVersion, evidence: partial, keylessScenarioIds: keylessIds })
    .some((problem) => problem.includes('has no recorded result')))
})

test('the manifest covers the complete public tool and route surface', async () => {
  const surfaceKeys = await collectSurfaceKeys()
  const keyless = new Set(manifest.scenarios
    .filter((scenario) => scenario.mode === 'keyless')
    .flatMap((scenario) => scenario.covers))
  const uncovered = surfaceKeys.filter((key) => !keyless.has(key))
  const debtKeys = new Set(debt.entries.map((entry) => entry.key))
  assert.deepEqual(uncovered.filter((key) => !debtKeys.has(key)), [], 'every uncovered key needs reviewed debt')
  for (const key of debtKeys) assert.ok(surfaceKeys.includes(key), `debt ${key} names a live surface`)
})

test('the checker rejects a version mismatch', () => {
  assert.ok(problems({ packageVersion: '2.0.0' }).some((problem) => problem.includes('does not match package.json')))
})

test('the checker rejects an uncovered surface key', () => {
  assert.ok(problems({ surfaceKeys: [...SURFACE_KEYS, 'tool:new'] })
    .some((problem) => problem.includes('tool:new') && problem.includes('no keyless scenario')))
})

test('a live-model scenario does not satisfy keyless coverage', () => {
  const cases = problems({
    manifest: { ...BASE_MANIFEST, scenarios: [{ ...SCENARIO, mode: 'live-model', covers: ['tool:new'] }] },
    surfaceKeys: [...SURFACE_KEYS, 'tool:new'],
  })
  assert.ok(cases.some((problem) => problem.includes('public key has no keyless scenario') && problem.includes('tool:new')))
})

test('a covered or unknown debt entry is stale', () => {
  const covered = problems({ debt: { entries: [{ key: 'tool:a', reason: 'r', exitCondition: 'e' }] } })
  assert.ok(covered.some((problem) => problem.includes('already covered')))
  const unknown = problems({ debt: { entries: [{ key: 'tool:gone', reason: 'r', exitCondition: 'e' }] } })
  assert.ok(unknown.some((problem) => problem.includes('no live public surface')))
})

test('a missing scenario file or unknown cover is red', () => {
  const missing = problems({ fileExists: () => false })
  assert.ok(missing.some((problem) => problem.includes('file does not exist')))
  const unknown = problems({ manifest: { ...BASE_MANIFEST, scenarios: [{ ...SCENARIO, covers: ['tool:gone'] }] } })
  assert.ok(unknown.some((problem) => problem.includes('unknown public key')))
})

test('host support accepts the tested patch and rejects another minor line', () => {
  const host = { tested: ['0.2.1-rc.2'], compatibleMajorMinor: '0.2' }
  assert.deepEqual(parseHostVersion('0.2.1-rc.2'), { major: 0, minor: 2, patch: 1, text: '0.2.1-rc.2' })
  assert.equal(hostSupport(host, '0.2.1-rc.2').supported, true)
  assert.equal(hostSupport(host, '0.2.1-rc.2').tested, true)
  assert.equal(hostSupport(host, '0.2.9').supported, true)
  assert.equal(hostSupport(host, '0.2.9').tested, false)
  assert.equal(hostSupport(host, '0.3.0').supported, false)
  assert.equal(hostSupport(host, 'unknown').supported, false)
})
