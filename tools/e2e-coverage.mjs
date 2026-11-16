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
import { resolve } from 'node:path'
import { BUSINESS_TOOLS, PANEL_ROUTES } from '../tests/support/public-surface.mjs'

const SCENARIO_MODES = new Set(['keyless', 'live-model'])
const FILE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/
const HOST_LINE = /^\d+\.\d+$/

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Every public key the E2E matrix must cover.
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
    ...schema.WORK_ITEM_STATUSES.map((status) => `work-item-status:${status}`),
  ]
  return [...new Set(keys)].sort()
}

/**
 * Check one manifest + debt pair against the live public surface.
 *
 * @param {object} input
 * @param {string} input.packageVersion Version from `package.json`.
 * @param {object} input.manifest Parsed `tests/e2e/manifest.json`.
 * @param {object} input.debt Parsed `tests/e2e/coverage-debt.json`.
 * @param {string[]} input.surfaceKeys Output of {@link collectSurfaceKeys}.
 * @param {string} input.manifestDir Absolute directory that scenario files resolve against.
 * @param {(path: string) => boolean} [input.fileExists] File probe, for tests.
 * @returns {string[]} One message per violation.
 */
export function e2eManifestProblems({
  packageVersion,
  manifest,
  debt,
  surfaceKeys,
  manifestDir,
  fileExists = existsSync,
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
    if (!isNonEmptyString(scenario.file) || !FILE_PATH.test(scenario.file)) {
      problems.push(`${where}.file must be a contained repo-relative path`)
    } else if (!fileExists(resolve(manifestDir, scenario.file))) {
      problems.push(`${where}.file does not exist: tests/e2e/${scenario.file}`)
    }
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
