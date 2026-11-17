/**
 * Versioned E2E catalog checker.
 *
 * One fact owns one place: the tools and routes come from the suite's public
 * surface snapshot, the presets and lifecycle states from their source
 * declarations, and the scenario mapping from `tests/e2e/manifest.json`. This
 * module only checks those homes agree: the manifest version must equal the
 * package version, every scenario file must exist, every public surface key must
 * be covered by a keyless scenario or recorded in `tests/e2e/coverage-debt.json`,
 * and a debt entry that has become covered (or names a removed surface) is stale
 * and red.
 *
 * The matrix proves a key was named by a scenario; it does not prove a scenario
 * asserted everything that key can do. Boundaries still belong to unit and
 * contract tests.
 */

import { existsSync } from 'node:fs'
import { BUSINESS_TOOLS, PANEL_ROUTES } from '../tests/support/public-surface.mjs'

const SCENARIO_MODES = new Set(['keyless', 'live-model'])
const HOST_LINE = /^\d+\.\d+$/
const COMMIT_SHA = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/

/**
 * Work-item states the store accepts but no shipped tool or route writes.
 *
 * `abandoned` is reachable only by reading an older or foreign document (the
 * panel counts it); there is no public abandon action, so a real-host scenario
 * cannot produce the state. The matrix checks public production, not every
 * value a parser accepts. If a producer lands, remove the entry and let the
 * normal uncovered-key rule demand a scenario.
 */
export const WORK_ITEM_STORE_ONLY_STATUSES = ['abandoned']

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Every public key the E2E matrix must cover: tools, panel routes, presets, and
 * topic/review/work-item lifecycle states. The inbox request action/status
 * enums are wire constants whose matrix would be request shapes, not host
 * capabilities; their contract tests own them.
 *
 * @returns {Promise<string[]>} Sorted, de-duplicated keys.
 */
export async function collectSurfaceKeys() {
  const presets = await import(new URL('../src/platform/presets.ts', import.meta.url))
  const schema = await import(new URL('../src/store/schema.ts', import.meta.url))
  const keys = [
    ...BUSINESS_TOOLS.map((name) => `tool:${name}`),
    ...PANEL_ROUTES.map(([path, method]) => `route:${path} ${method}`),
    ...presets.presetDefinitions().map((definition) => `preset:${definition.id}`),
    ...schema.TOPIC_STATUSES.map((status) => `topic-status:${status}`),
    ...schema.REVIEW_STATUSES.map((status) => `review-status:${status}`),
    ...schema.WORK_ITEM_STATUSES
      .filter((status) => !WORK_ITEM_STORE_ONLY_STATUSES.includes(status))
      .map((status) => `work-item-status:${status}`),
  ]
  return [...new Set(keys)].sort()
}

/**
 * Check one release evidence summary.
 *
 * The file proves a green keyless run happened for this package version from a
 * clean worktree and that every keyless scenario in the manifest was present.
 * It does not prove the run happened on this machine or at this HEAD; the
 * summary carries that identity for review.
 *
 * @param {object} input
 * @param {string} input.packageVersion Version from `package.json`.
 * @param {object|null} input.evidence Parsed `tests/e2e/evidence/<version>.json`, or null when absent.
 * @param {Set<string>} input.keylessScenarioIds Scenario ids the manifest declares keyless.
 * @param {string} input.catalogSha256 Current content digest of `tests/e2e/`.
 * @param {string[]} input.testedHosts DSH versions the manifest declares tested.
 * @param {string} input.headSha Current HEAD.
 * @param {boolean} input.evidenceHeadAncestor Whether the recorded head is an ancestor of HEAD.
 * @param {string[]} input.changedPathsSinceEvidenceHead Paths changed between the recorded head and HEAD.
 * @returns {string[]} One message per violation.
 */
export function e2eEvidenceProblems({
  packageVersion,
  evidence,
  keylessScenarioIds,
  catalogSha256,
  testedHosts,
  headSha,
  evidenceHeadAncestor,
  changedPathsSinceEvidenceHead,
}) {
  const label = `tests/e2e/evidence/${packageVersion}.json`
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return [`${label} is missing; run the keyless lane with --record from a clean worktree before release`]
  }
  const problems = []
  if (evidence.formatVersion !== 1) problems.push(`${label}: formatVersion must be 1`)
  if (evidence.pluginVersion !== packageVersion) problems.push(`${label}: pluginVersion must be ${packageVersion}`)
  if (evidence.result !== 'pass') problems.push(`${label}: result must be pass`)
  if (!isNonEmptyString(evidence.catalogSha256) || !SHA256.test(evidence.catalogSha256)) {
    problems.push(`${label}: catalogSha256 must be a SHA-256 of the current tests/e2e catalog`)
  } else if (evidence.catalogSha256 !== catalogSha256) {
    problems.push(`${label}: catalogSha256 does not match the current tests/e2e catalog; re-record the lane`)
  }
  if (!testedHosts.includes(String(evidence.dshVersion ?? ''))) {
    problems.push(`${label}: dshVersion ${String(evidence.dshVersion)} is not in manifest.host.tested`)
  }
  const artifact = evidence.artifact
  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
    problems.push(`${label}: artifact must be an object`)
  } else {
    if (!COMMIT_SHA.test(String(artifact.head ?? ''))) problems.push(`${label}: artifact.head must be a full commit SHA`)
    if (headSha !== '' && artifact.head !== headSha) {
      if (!evidenceHeadAncestor) {
        problems.push(`${label}: artifact.head is not an ancestor of HEAD`)
      } else if (changedPathsSinceEvidenceHead.some((path) => !path.startsWith('tests/e2e/evidence/'))) {
        problems.push(`${label}: files outside tests/e2e/evidence/ changed after artifact.head; re-record the lane`)
      }
    }
    if (artifact.dirty !== false) problems.push(`${label}: artifact.dirty must be false (record from a clean worktree)`)
    if (!SHA256.test(String(artifact.tarballSha256 ?? ''))) problems.push(`${label}: artifact.tarballSha256 must be a SHA-256`)
  }
  const rows = Array.isArray(evidence.scenarios) ? evidence.scenarios : null
  if (rows === null || rows.length === 0) {
    problems.push(`${label}: scenarios must be a non-empty array`)
  } else {
    const seen = new Set()
    for (const [index, row] of rows.entries()) {
      const where = `${label}: scenarios[${index}]`
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        problems.push(`${where} must be an object`)
        continue
      }
      if (!isNonEmptyString(row.id)) problems.push(`${where}.id must be a non-empty string`)
      else if (seen.has(row.id)) problems.push(`${where}.id repeats ${row.id}`)
      else seen.add(row.id)
      if (row.mode !== 'keyless') problems.push(`${where}.mode must be keyless`)
      if (row.passed !== true) problems.push(`${where}.passed must be true`)
      if (!Array.isArray(row.checks) || row.checks.length === 0 || row.checks.some((check) => check?.passed !== true)) {
        problems.push(`${where}.checks must be a non-empty all-passed array`)
      }
    }
    for (const id of keylessScenarioIds) {
      if (!seen.has(id)) problems.push(`${label}: keyless scenario ${id} has no recorded result; re-record the full lane`)
    }
    for (const id of seen) {
      if (!keylessScenarioIds.has(id)) problems.push(`${label}: scenario ${id} is not a keyless manifest scenario`)
    }
  }
  return problems
}

/**
 * Check one manifest + debt pair against the live public surface.
 *
 * @param {object} input
 * @param {string} input.packageVersion Version from `package.json`.
 * @param {object} input.manifest Parsed `tests/e2e/manifest.json`.
 * @param {object} input.debt Parsed `tests/e2e/coverage-debt.json`.
 * @param {string[]} input.surfaceKeys Output of {@link collectSurfaceKeys}.
 * @returns {string[]} One message per violation.
 */
export function e2eManifestProblems({
  packageVersion,
  manifest,
  debt,
  surfaceKeys,
}) {
  const problems = []
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return ['tests/e2e/manifest.json must be a JSON object']
  if (manifest.formatVersion !== 1) problems.push(`manifest.formatVersion must be 1, got ${JSON.stringify(manifest.formatVersion)}`)
  if (!isNonEmptyString(manifest.pluginVersion)) problems.push('manifest.pluginVersion must be a non-empty string')
  else if (manifest.pluginVersion !== packageVersion) {
    problems.push(`manifest.pluginVersion ${manifest.pluginVersion} does not match package.json ${packageVersion}`)
  }

  const host = manifest.host
  if (host === null || typeof host !== 'object' || Array.isArray(host)) problems.push('manifest.host must be an object')
  else {
    if (!Array.isArray(host.tested) || host.tested.length === 0 || host.tested.some((value) => !isNonEmptyString(value))) {
      problems.push('manifest.host.tested must be a non-empty string array')
    } else if (new Set(host.tested).size !== host.tested.length) {
      problems.push('manifest.host.tested must not repeat a version')
    }
    if (!isNonEmptyString(host.compatibleMajorMinor) || !HOST_LINE.test(host.compatibleMajorMinor)) {
      problems.push('manifest.host.compatibleMajorMinor must be "major.minor"')
    }
  }

  const known = new Set(surfaceKeys)
  const scenarios = Array.isArray(manifest.scenarios) ? manifest.scenarios : null
  if (scenarios === null || scenarios.length === 0) problems.push('manifest.scenarios must be a non-empty array')
  const ids = new Set()
  const keylessCovered = new Set()
  let hasKeyless = false
  for (const [index, scenario] of (scenarios ?? []).entries()) {
    const where = `manifest.scenarios[${index}]`
    if (scenario === null || typeof scenario !== 'object' || Array.isArray(scenario)) {
      problems.push(`${where} must be an object`)
      continue
    }
    if (!isNonEmptyString(scenario.id)) problems.push(`${where}.id must be a non-empty string`)
    else if (ids.has(scenario.id)) problems.push(`${where}.id repeats ${scenario.id}`)
    else ids.add(scenario.id)
    if (!SCENARIO_MODES.has(scenario.mode)) problems.push(`${where}.mode must be keyless or live-model`)
    if (!isNonEmptyString(scenario.summary)) problems.push(`${where}.summary must be a non-empty string`)
    if (!Array.isArray(scenario.covers) || scenario.covers.length === 0) {
      problems.push(`${where}.covers must be a non-empty array`)
      continue
    }
    for (const key of scenario.covers) {
      if (!known.has(key)) problems.push(`${where}.covers names unknown public key: ${String(key)}`)
      else if (scenario.mode === 'keyless') keylessCovered.add(key)
    }
    if (scenario.mode === 'keyless') hasKeyless = true
  }
  if (!hasKeyless) problems.push('manifest must declare at least one keyless scenario')

  const entries = Array.isArray(debt?.entries) ? debt.entries : null
  if (entries === null) problems.push('tests/e2e/coverage-debt.json must declare an entries array')
  const debtKeys = new Set()
  for (const [index, entry] of (entries ?? []).entries()) {
    const where = `coverage-debt.entries[${index}]`
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`${where} must be an object`)
      continue
    }
    if (!isNonEmptyString(entry.key)) problems.push(`${where}.key must be a non-empty string`)
    else if (debtKeys.has(entry.key)) problems.push(`${where}.key repeats ${entry.key}`)
    else debtKeys.add(entry.key)
    if (!isNonEmptyString(entry.reason)) problems.push(`${where}.reason must be a non-empty string`)
    if (!isNonEmptyString(entry.exitCondition)) problems.push(`${where}.exitCondition must be a non-empty string`)
    if (!known.has(entry.key)) problems.push(`${where}.key names no live public surface: ${String(entry.key)}`)
    else if (keylessCovered.has(entry.key)) problems.push(`${where}.key is already covered by a keyless scenario; delete the stale entry`)
  }

  for (const key of surfaceKeys) {
    if (!keylessCovered.has(key) && !debtKeys.has(key)) {
      problems.push(`public key has no keyless scenario and no reviewed debt entry: ${key}`)
    }
  }
  return problems
}
