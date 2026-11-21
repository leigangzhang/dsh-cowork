import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  collectSurfaceKeys,
  e2eEvidenceProblems,
  e2eManifestProblems,
  isEvidenceNeutralPath,
  WORK_ITEM_STORE_ONLY_STATUSES,
} from '../../tools/e2e-coverage.mjs'
import { SCENARIOS } from '../../tests/e2e/scenarios/index.mjs'
import { catalogSha256 } from '../../tests/e2e/support/catalog.mjs'
import {
  LIVE_SCENARIO_SETUP_MS,
  LIVE_TURN_OBSERVATION_MS,
  LIVE_TURN_TIMEOUT_MS,
  liveScenarioTimeout,
  scenarioTimeoutOf,
} from '../../tests/e2e/support/lane-timeouts.mjs'
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
const catalog = await catalogSha256(manifestDir)
const EVIDENCE_INPUT = {
  packageVersion,
  evidence,
  keylessScenarioIds: keylessIds,
  catalogSha256: catalog,
  testedHosts: manifest.host.tested,
  headSha: evidence.artifact.head,
  evidenceHeadAncestor: true,
  changedPathsSinceEvidenceHead: [],
}

const SURFACE_KEYS = ['preset:p', 'route:/x GET', 'tool:a', 'topic-status:active']
const SCENARIO = {
  id: 's1',
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

test('every manifest scenario id resolves to the same static module', () => {
  const manifestIds = new Set(manifest.scenarios.map((scenario) => scenario.id))
  for (const entry of manifest.scenarios) {
    const module = SCENARIOS.get(entry.id)
    assert.ok(module !== undefined, `${entry.id} has a module`)
    assert.equal(module.id, entry.id, `${entry.id} module id`)
    assert.equal(typeof module.run, 'function', `${entry.id} run function`)
  }
  for (const id of SCENARIOS.keys()) assert.ok(manifestIds.has(id), `${id} is declared in the manifest`)
})

test('a live scenario budget grows with its model turns', () => {
  assert.equal(
    liveScenarioTimeout(2),
    2 * (LIVE_TURN_TIMEOUT_MS + LIVE_TURN_OBSERVATION_MS) + LIVE_SCENARIO_SETUP_MS,
  )
  assert.ok(liveScenarioTimeout(7) > liveScenarioTimeout(2) + 300_000, 'more turns need a larger budget')
  assert.throws(() => liveScenarioTimeout(0), /positive integer/)
  assert.equal(scenarioTimeoutOf({ id: 'keyless' }, 300_000), 300_000)
  assert.equal(scenarioTimeoutOf({ id: 'live', timeoutMs: liveScenarioTimeout(7) }, 300_000), liveScenarioTimeout(7))
  assert.throws(() => scenarioTimeoutOf({ id: 'bad', timeoutMs: 0 }, 300_000), /positive integer/)
})

test('the live scenarios declare their own per-turn budget', () => {
  for (const id of ['live-master-chain', 'live-artifact-chain']) {
    const scenario = SCENARIOS.get(id)
    assert.ok(scenario !== undefined, `${id} is registered`)
    assert.ok(Number.isSafeInteger(scenario.timeoutMs) && scenario.timeoutMs > 0, `${id} declares timeoutMs`)
  }
  assert.equal(SCENARIOS.get('artifact-chain').timeoutMs, undefined, 'a keyless scenario keeps the flat budget')
})

test('the committed evidence matches the current version and every keyless scenario', () => {
  assert.deepEqual(e2eEvidenceProblems(EVIDENCE_INPUT), [])
})

test('the evidence checker rejects a missing, failed, or partial summary', () => {
  assert.ok(e2eEvidenceProblems({ ...EVIDENCE_INPUT, evidence: null })
    .some((problem) => problem.includes('is missing')))
  const failed = structuredClone(evidence)
  failed.scenarios[0].passed = false
  assert.ok(e2eEvidenceProblems({ ...EVIDENCE_INPUT, evidence: failed })
    .some((problem) => problem.includes('passed must be true')))
  const partial = structuredClone(evidence)
  partial.scenarios = partial.scenarios.slice(1)
  assert.ok(e2eEvidenceProblems({ ...EVIDENCE_INPUT, evidence: partial })
    .some((problem) => problem.includes('has no recorded result')))
})

test('the evidence checker binds the catalog, host, and recorded head', () => {
  assert.ok(e2eEvidenceProblems({ ...EVIDENCE_INPUT, catalogSha256: 'd'.repeat(64) })
    .some((problem) => problem.includes('does not match the current tests/e2e catalog')))
  assert.ok(e2eEvidenceProblems({ ...EVIDENCE_INPUT, testedHosts: ['9.9.9'] })
    .some((problem) => problem.includes('is not in manifest.host.tested')))
  assert.ok(e2eEvidenceProblems({ ...EVIDENCE_INPUT, headSha: 'd'.repeat(40), evidenceHeadAncestor: false })
    .some((problem) => problem.includes('is not an ancestor of HEAD')))
  assert.ok(e2eEvidenceProblems({ ...EVIDENCE_INPUT, headSha: 'd'.repeat(40), changedPathsSinceEvidenceHead: ['tests/e2e/manifest.json'] })
    .some((problem) => problem.includes('runtime files outside tests/e2e/evidence/')))
})

test('documentation changes do not invalidate a committed E2E evidence recording', () => {
  assert.equal(isEvidenceNeutralPath('docs/github-workflow.md'), true)
  assert.equal(isEvidenceNeutralPath('README.md'), true)
  assert.equal(isEvidenceNeutralPath('tests/e2e/evidence/0.2.0.json'), true)
  assert.equal(isEvidenceNeutralPath('.agents/notes/proposed/process/2026-11-19-version-management.md'), true)
  assert.equal(isEvidenceNeutralPath('.agents/skills/code-review/SKILL.md'), false)
  assert.equal(isEvidenceNeutralPath('src/app/apply.ts'), false)
  assert.equal(isEvidenceNeutralPath('tools/workflow.json'), false)
  assert.deepEqual(
    e2eEvidenceProblems({
      ...EVIDENCE_INPUT,
      headSha: 'd'.repeat(40),
      changedPathsSinceEvidenceHead: [
        'docs/github-workflow.md',
        'README.md',
        'tests/e2e/evidence/0.2.0.json',
        '.agents/notes/proposed/process/2026-11-19-version-management.md',
      ],
    }),
    [],
  )
  assert.ok(e2eEvidenceProblems({
    ...EVIDENCE_INPUT,
    headSha: 'd'.repeat(40),
    changedPathsSinceEvidenceHead: ['docs/github-workflow.md', 'src/app/apply.ts'],
  }).some((problem) => problem.includes('runtime files outside tests/e2e/evidence/')))
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

test('an unknown cover is red', () => {
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
