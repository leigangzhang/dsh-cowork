#!/usr/bin/env node
/**
 * Per-file coverage gate for the layered coverage policy.
 *
 * Inputs:
 * - `tools/coverage-map.json` assigns every TypeScript source file under
 *   `src/` (client TSX included) exactly one lane: `unit`, `browser`, or `dev`.
 * - `coverage/unit.lcov` + `coverage/unit.json` come from `test:coverage`.
 * - `coverage/client.json` + `coverage/browser.lcov` come from `test:browser`.
 * - `tools/coverage-debt.json` records the reviewed baseline: uncovered line
 *   set plus branch/function counts per unit module. The line rule fails when
 *   a module regresses, when an unlisted module is not at line 100, and when an
 *   entry is stale after an intentional improvement.
 *
 * Branch and function counts are recorded for the next ratchet but do not fail
 * the gate: V8 enumerates functions and ranges differently depending on the
 * executed paths, so those totals are not stable enough to compare exactly.
 *
 * Ownership is exclusive: a file's verdict is computed from its own lane only.
 * A unit test cannot make a browser-owned file pass, and browser execution is
 * not second-owner evidence for a unit-owned module.
 *
 * `--update-debt` is the only writer of the baseline and exists for intentional
 * coverage changes; the gate itself never updates it.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  branchTotals,
  functionTotals,
  lineTotals,
  parseLcov,
  uncoveredLines,
} from './coverage-lcov.mjs'
import {
  isTypeOnly,
  sourceFilesIn,
  validateOwnershipMap,
} from './coverage-owners.mjs'
import { CLIENT_BROWSER_BLOCKED, CLIENT_BROWSER_TSX, coverageCompletenessFailures, coverageGateFailures } from './client-coverage.mjs'
import { browserFloorFileProblems } from '../../tools/coverage-gaps.mjs'
import { runScript } from './cli-support.mjs'
import { gitState } from './git-state.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const REPO_ROOT = resolve(here, '../..')

const COVERAGE_PATHS = Object.freeze({
  map: 'tools/coverage-map.json',
  debt: 'tools/coverage-debt.json',
  browserFloors: 'tools/coverage-browser-floors.json',
  unitReport: 'coverage/unit.lcov',
  unitMeta: 'coverage/unit.json',
  browserClient: 'coverage/client.json',
  browserLcov: 'coverage/browser.lcov',
})

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Stable JSON for identity comparison; key order must not decide evidence. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sameArtifact(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function missingMessage(path, command, error) {
  return error?.code === 'ENOENT'
    ? `${path} is missing; run ${command}`
    : `${path} is unreadable: ${error instanceof Error ? error.message : String(error)}`
}

/** The sidecar must describe the tree the gate is judging now. */
function freshnessFailures({ unitMeta, paths, currentWorktree }) {
  if (unitMeta === null || unitMeta.artifact === undefined || unitMeta.artifact === null) {
    return [`${paths.unitMeta} carries no worktree identity; rerun npm run test:coverage`]
  }
  const recorded = unitMeta.artifact
  if (recorded.head !== currentWorktree.head
    || JSON.stringify(recorded.gitStatus ?? []) !== JSON.stringify(currentWorktree.gitStatus)) {
    return [`${paths.unitMeta}: coverage report is stale; rerun npm run test:coverage`]
  }
  return []
}

function loadOwnership({ cwd, paths, discovered }) {
  const failures = []
  let map = null
  try {
    map = readJson(resolve(cwd, paths.map))
  } catch (error) {
    failures.push(`tools/coverage-map.json is unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
  const validation = map === null
    ? { failures: [], byPath: new Map() }
    : validateOwnershipMap(map, discovered)
  failures.push(...validation.failures)
  return { failures, validation }
}

function loadUnitLane({ cwd, paths }) {
  const failures = []
  let unitRecords = null
  try {
    unitRecords = parseLcov(readFileSync(resolve(cwd, paths.unitReport), 'utf8'))
  } catch (error) {
    failures.push(missingMessage(paths.unitReport, 'npm run test:coverage', error))
  }
  let unitMeta = null
  try {
    unitMeta = readJson(resolve(cwd, paths.unitMeta))
  } catch (error) {
    failures.push(missingMessage(paths.unitMeta, 'npm run test:coverage', error))
  }
  return { failures, unitRecords, unitMeta }
}

function browserFilesOf(client) {
  return Array.isArray(client?.files) ? client.files : []
}

function loadBrowserLane({ cwd, paths, expectedTsx }) {
  const failures = []
  let browserClient = null
  try {
    browserClient = readJson(resolve(cwd, paths.browserClient))
    if (!Array.isArray(browserClient?.files)) {
      failures.push(`${paths.browserClient} must carry a files array`)
    }
    failures.push(...coverageCompletenessFailures(browserClient, expectedTsx))
  } catch (error) {
    failures.push(missingMessage(paths.browserClient, 'npm run test:browser', error))
  }
  let browserLcov = null
  try {
    browserLcov = parseLcov(readFileSync(resolve(cwd, paths.browserLcov), 'utf8'))
  } catch (error) {
    failures.push(missingMessage(paths.browserLcov, 'npm run test:browser', error))
  }
  return { failures, browserClient, browserLcov }
}

/** Load the map, reports, sidecars, and browser completeness failures. */
function loadInputs({ cwd, paths, requireBrowser, expectedTsx, sourceFiles }) {
  const discovered = sourceFiles ?? sourceFilesIn(cwd)
  const ownership = loadOwnership({ cwd, paths, discovered })
  const unit = loadUnitLane({ cwd, paths })
  const browser = requireBrowser
    ? loadBrowserLane({ cwd, paths, expectedTsx })
    : { failures: [], browserClient: null, browserLcov: null }
  return {
    failures: [...ownership.failures, ...unit.failures, ...browser.failures],
    validation: ownership.validation,
    unitRecords: unit.unitRecords,
    unitMeta: unit.unitMeta,
    browserClient: browser.browserClient,
    browserLcov: browser.browserLcov,
  }
}

function unitHeadFailures(unitMeta, expectedArtifact) {
  const head = unitMeta?.artifact?.head
  const expectedHead = expectedArtifact?.resolved?.headSha
  if (head === undefined || expectedHead === undefined || head === expectedHead) return []
  return ['unit lane HEAD does not match the layered artifact']
}

function unitIdentityFailures(unitMeta, expectedArtifact) {
  if (unitMeta === null || unitMeta.gateArtifact === null || unitMeta.gateArtifact === undefined) {
    return ['unit lane carries no layered artifact identity; run test:coverage:layered']
  }
  const identity = sameArtifact(unitMeta.gateArtifact, expectedArtifact)
    ? []
    : ['unit lane artifact identity does not match the layered runner']
  return [...identity, ...unitHeadFailures(unitMeta, expectedArtifact)]
}

function browserIdentityFailures(browserClient, expectedArtifact) {
  if (browserClient === null) return []
  if (browserClient.artifact?.gateArtifact === undefined || browserClient.artifact?.gateArtifact === null) {
    return ['browser lane carries no layered artifact identity; run test:browser with the layered env']
  }
  return sameArtifact(browserClient.artifact.gateArtifact, expectedArtifact)
    ? []
    : ['browser lane artifact identity does not match the layered runner']
}

/** Layered runner identity: both lanes must have measured the same artifact. */
function artifactFailures({ unitMeta, browserClient, expectedArtifact }) {
  return [
    ...unitIdentityFailures(unitMeta, expectedArtifact),
    ...browserIdentityFailures(browserClient, expectedArtifact),
  ]
}

/**
 * Build the reviewed baseline from unit records that still have uncovered
 * lines. A fully covered module needs no entry: leaving it out keeps `files`
 * empty once the debt is paid, and an entry that just restates 100% would turn
 * every improvement into a stale record to refresh.
 */
function buildBaseline({ byPath, unitRecords }) {
  const files = []
  for (const [path, entry] of byPath) {
    if (entry.lane !== 'unit') continue
    const record = unitRecords.get(path)
    if (record === undefined) continue
    const uncovered = uncoveredLines(record)
    if (uncovered.length === 0) continue
    const lines = lineTotals(record)
    files.push({
      path,
      uncoveredLines: uncovered,
      lines: { total: lines.total, covered: lines.covered },
      branches: branchTotals(record),
      functions: functionTotals(record),
    })
  }
  files.sort((left, right) => left.path.localeCompare(right.path))
  return { version: 1, files }
}

function writeBaselineFile({ cwd, path, baseline, log }) {
  writeFileSync(resolve(cwd, path), `${JSON.stringify(baseline, null, 2)}\n`)
  log(`coverage baseline written: ${String(baseline.files.length)} files in ${path}`)
}

function loadBaselineFile({ cwd, path, failures }) {
  try {
    return readJson(resolve(cwd, path))
  } catch (error) {
    failures.push(error?.code === 'ENOENT'
      ? `${path} is missing; create it with npm run test:coverage -- --update-debt`
      : `${path} is unreadable: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function baselineEntryFailures(entry, path, byPath) {
  if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string') {
    return [`${path}: baseline entry needs a path`]
  }
  const failures = []
  if (byPath.get(entry.path)?.lane !== 'unit') {
    failures.push(`${path}: baseline entry ${entry.path} names no unit source file`)
  }
  if (!Array.isArray(entry.uncoveredLines)) {
    failures.push(`${path}: baseline entry ${entry.path} has no uncovered line list`)
  }
  return failures
}

function baselineShapeFailure(baseline, path, failures) {
  const valid = baseline !== null && typeof baseline === 'object' && !Array.isArray(baseline)
    && baseline.version === 1 && Array.isArray(baseline.files)
  if (!valid) failures.push(`${path} must be an object with version 1 and a files array`)
  return !valid
}

function validBaseline(baseline, path, byPath, failures) {
  if (baselineShapeFailure(baseline, path, failures)) return false
  const seen = new Set()
  for (const entry of baseline.files) {
    failures.push(...baselineEntryFailures(entry, path, byPath))
    if (typeof entry?.path === 'string') {
      if (seen.has(entry.path)) failures.push(`${path}: duplicate baseline entry for ${entry.path}`)
      seen.add(entry.path)
    }
  }
  return true
}

function readBaseline({ cwd, path, failures, byPath }) {
  const baseline = loadBaselineFile({ cwd, path, failures })
  if (baseline === null) return null
  return validBaseline(baseline, path, byPath, failures) ? baseline : null
}

/** Newly uncovered lines relative to the previous baseline, per module. */
function baselineRegressions(previous, next) {
  if (previous === null) return []
  const oldLines = new Map(previous.files.map((entry) => [entry.path, Array.isArray(entry.uncoveredLines) ? entry.uncoveredLines : []]))
  const regressions = []
  for (const entry of next.files) {
    const before = new Set(oldLines.get(entry.path) ?? [])
    const added = entry.uncoveredLines.filter((line) => !before.has(line))
    if (added.length > 0) regressions.push({ path: entry.path, lines: added })
  }
  return regressions
}

/** One unit record as a report entry plus its uncovered line set. */
function unitVerdict(path, record) {
  const lines = lineTotals(record)
  const uncovered = uncoveredLines(record)
  return {
    file: {
      path,
      lane: 'unit',
      status: uncovered.length === 0 ? 'covered' : 'debt',
      lines: { total: lines.total, covered: lines.covered, uncovered: uncovered.length },
      branches: branchTotals(record),
      functions: functionTotals(record),
    },
    uncovered,
  }
}

function debtFailures(path, uncovered, debt) {
  if (debt === undefined) {
    return uncovered.length > 0
      ? [`${path}: ${String(uncovered.length)} uncovered lines (${uncovered.join(', ')}) and no baseline entry`]
      : []
  }
  if (!Array.isArray(debt.uncoveredLines)) {
    return [`${path}: baseline entry has no uncovered line list; regenerate it with npm run test:coverage -- --update-debt`]
  }
  const baseline = new Set(debt.uncoveredLines)
  const actual = new Set(uncovered)
  const added = [...actual].filter((line) => !baseline.has(line))
  const removed = [...baseline].filter((line) => !actual.has(line))
  const failures = []
  if (added.length > 0) failures.push(`${path}: line coverage regressed; new uncovered lines ${added.join(', ')}`)
  if (removed.length > 0) failures.push(`${path}: line coverage improved; lines now covered ${removed.join(', ')}; update the baseline`)
  return failures
}

/** Apply the line rule to every unit-owned source file. */
function unitFileVerdicts({ cwd, byPath, unitRecords, baselineByPath, failures }) {
  const files = []
  for (const [path, entry] of byPath) {
    if (entry.lane !== 'unit') continue
    const record = unitRecords.get(path)
    if (record === undefined) {
      if (isTypeOnly(resolve(cwd, path))) {
        files.push({ path, lane: 'unit', status: 'type-only' })
        continue
      }
      failures.push(`${path}: no runtime coverage recorded; load it from a test`)
      files.push({ path, lane: 'unit', status: 'unloaded' })
      continue
    }
    const verdict = unitVerdict(path, record)
    files.push(verdict.file)
    failures.push(...debtFailures(path, verdict.uncovered, baselineByPath.get(path)))
  }
  return files
}

function loadFloorsFile({ cwd, path, failures }) {
  try {
    return readJson(resolve(cwd, path))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    failures.push(`${path} is unreadable: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function readBrowserFloors({ cwd, path, failures, byPath }) {
  const parsed = loadFloorsFile({ cwd, path, failures })
  if (parsed === null) return null
  const result = browserFloorFileProblems(parsed, byPath, { path, blocked: CLIENT_BROWSER_BLOCKED })
  failures.push(...result.failures)
  return result.failures.length === 0 ? result.files : null
}

function lineCountConsistencyFailure(path, file, covered, uncovered) {
  if (covered === null || uncovered === null || !Number.isInteger(file.executableLines)) return []
  return covered.length + uncovered.length === file.executableLines
    ? []
    : [`${path}: browser line counts do not add up to executableLines`]
}

function lineRangeConsistencyFailures(path, file, lines) {
  if (!Number.isInteger(file.sourceLines) || file.sourceLines <= 0) return []
  const outside = lines.filter((line) => !Number.isInteger(line) || line < 1 || line > file.sourceLines)
  return outside.length > 0
    ? [`${path}: browser report maps lines outside 1..${String(file.sourceLines)}`]
    : []
}

/** Line numbers must stay inside the mapped source and add up to the total. */
function browserLineConsistencyFailures(path, file) {
  const covered = Array.isArray(file.coveredLines) ? file.coveredLines : null
  const uncovered = Array.isArray(file.uncoveredLines) ? file.uncoveredLines : null
  return [
    ...lineCountConsistencyFailure(path, file, covered, uncovered),
    ...lineRangeConsistencyFailures(path, file, [...(covered ?? []), ...(uncovered ?? [])]),
  ]
}

function executableLineFailures(path, file) {
  if (file.status === 'blocked') return []
  if (Number.isInteger(file.executableLines) && file.executableLines > 0) return []
  return [`${path}: browser report mapped no executable lines`]
}

/** One browser-owned file verdict; blocked entries keep their reason. */
function browserVerdict(path, file, failures) {
  failures.push(...executableLineFailures(path, file))
  failures.push(...browserLineConsistencyFailures(path, file))
  return {
    path,
    lane: 'browser',
    status: file.status,
    lines: {
      total: file.executableLines ?? 0,
      covered: file.executedLines ?? 0,
      uncovered: file.uncoveredLines?.length ?? 0,
    },
    branches: { total: 0, covered: 0 },
    functions: { total: file.totalFunctions ?? 0, covered: file.executedFunctions ?? 0 },
    ...(file.status === 'blocked' ? { blockedReason: file.blockedReason } : {}),
  }
}

function sameLineSet(left, right) {
  if (left.size !== right.size) return false
  for (const line of left) if (!right.has(line)) return false
  return true
}

function browserLcovFailures(browserLcov, byPath, browserClient) {
  if (browserLcov === null) return []
  const failures = []
  const byFile = new Map(browserFilesOf(browserClient).map((entry) => [entry.file, entry]))
  for (const [path, entry] of byPath) {
    if (entry.lane !== 'browser') continue
    const record = browserLcov.get(path)
    if (record === undefined) {
      failures.push(`${path}: browser LCOV has no record`)
      continue
    }
    const file = byFile.get(path)
    if (file === undefined) continue
    if (!Array.isArray(file.coveredLines) || !Array.isArray(file.uncoveredLines)) {
      failures.push(`${path}: browser client report has no line arrays`)
      continue
    }
    const lcovCovered = new Set([...record.lines].filter(([, count]) => count > 0).map(([line]) => line))
    if (!sameLineSet(lcovCovered, new Set(file.coveredLines))) {
      failures.push(`${path}: browser LCOV and client report disagree on covered lines`)
    }
  }
  return failures
}

function browserBlockedFailures(path, file) {
  const known = CLIENT_BROWSER_BLOCKED[path]
  if (known !== undefined && file.status !== 'blocked') {
    return [`${path}: expected blocked (${known.issue}), got ${String(file.status)}`]
  }
  if (known === undefined && file.status === 'blocked') {
    return [`${path}: not a known blocked surface; remove the blocked status`]
  }
  return []
}

function browserOwnerVerdicts({ byPath, byFile, failures }) {
  const files = []
  for (const [path, entry] of byPath) {
    if (entry.lane !== 'browser') continue
    const file = byFile.get(path)
    if (file === undefined) {
      failures.push(`${path}: browser-owned file is missing from the browser coverage report`)
      continue
    }
    failures.push(...browserBlockedFailures(path, file))
    files.push(browserVerdict(path, file, failures))
  }
  return files
}

/** Apply browser completeness, LCOV presence, and reviewed floors. */
function browserFileVerdicts({ cwd, byPath, browserClient, browserLcov, paths, failures }) {
  const floors = readBrowserFloors({ cwd, path: paths.browserFloors, failures, byPath })
  if (floors !== null && Array.isArray(browserClient.files)) {
    failures.push(...coverageGateFailures(browserClient, floors))
  }
  const byFile = new Map(browserFilesOf(browserClient).map((entry) => [entry.file, entry]))
  const files = browserOwnerVerdicts({ byPath, byFile, failures })
  failures.push(...browserLcovFailures(browserLcov, byPath, browserClient))
  return {
    files,
    summary: {
      client: paths.browserClient,
      lcov: paths.browserLcov,
      floors: floors === null ? 'observational' : 'reviewed',
      counted: browserFilesOf(browserClient).filter((entry) => entry.status === 'counted').length,
    },
  }
}

function resolveWorktree({ cwd, currentWorktree, failures }) {
  if (currentWorktree !== null) return currentWorktree
  try {
    return gitState(cwd)
  } catch (error) {
    failures.push(`coverage worktree identity is unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function readPreviousBaseline({ cwd, path, failures }) {
  let previous = null
  try {
    previous = readJson(resolve(cwd, path))
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      failures.push(`${path} is unreadable: ${error instanceof Error ? error.message : String(error)}`)
    }
    return null
  }
  if (previous === null || typeof previous !== 'object' || previous.version !== 1 || !Array.isArray(previous.files)) {
    failures.push(`${path} must be an object with version 1 and a files array`)
    return null
  }
  return previous
}

function acceptOrWriteBaseline({ cwd, path, previous, next, acceptRegression, failures, log }) {
  const regressions = baselineRegressions(previous, next)
  if (regressions.length > 0 && !acceptRegression) {
    for (const regression of regressions) {
      failures.push(`${regression.path}: update-debt would add uncovered lines ${regression.lines.join(', ')}; pass --accept-regression to record a reviewed regression`)
    }
    return false
  }
  writeBaselineFile({ cwd, path, baseline: next, log })
  for (const regression of regressions) {
    log(`coverage baseline accepted regression: ${regression.path} +${regression.lines.join(',')}`)
  }
  return true
}

/** Write a reviewed baseline, refusing newly uncovered lines by default. */
function prepareBaseline({ cwd, paths, updateDebt, acceptRegression, inputs, failures, log }) {
  if (!updateDebt) {
    return readBaseline({ cwd, path: paths.debt, failures, byPath: inputs.validation.byPath })
  }
  const previous = readPreviousBaseline({ cwd, path: paths.debt, failures })
  if (failures.length > 0) return null
  const next = buildBaseline({ byPath: inputs.validation.byPath, unitRecords: inputs.unitRecords })
  return acceptOrWriteBaseline({ cwd, path: paths.debt, previous, next, acceptRegression, failures, log })
    ? next
    : null
}

/** Unit and browser verdicts for the current reports. */
function collectVerdicts({ cwd, requireBrowser, paths, inputs, baselineByPath, failures }) {
  const files = inputs.unitRecords === null
    ? []
    : unitFileVerdicts({
      cwd,
      byPath: inputs.validation.byPath,
      unitRecords: inputs.unitRecords,
      baselineByPath,
      failures,
    })
  if (!requireBrowser || inputs.browserClient === null) return { files, browser: null }
  const verdicts = browserFileVerdicts({
    cwd,
    byPath: inputs.validation.byPath,
    browserClient: inputs.browserClient,
    browserLcov: inputs.browserLcov,
    paths,
    failures,
  })
  files.push(...verdicts.files)
  return { files, browser: verdicts.summary }
}

/**
 * Check the current reports against the owner map and baseline.
 *
 * @param {object} [options]
 * @param {string} [options.cwd] Repository root.
 * @param {boolean} [options.requireBrowser] Require the browser lane and apply its floors.
 * @param {object|null} [options.expectedArtifact] Identity every lane sidecar must carry.
 * @param {boolean} [options.updateDebt] Rewrite the baseline from the unit report.
 * @param {boolean} [options.acceptRegression] Allow --update-debt to add uncovered lines.
 * @param {object|null} [options.currentWorktree] Live worktree identity (tests inject it).
 * @param {object} [options.paths] Override input paths (tests use temp files).
 * @param {string[]|null} [options.sourceFiles] Override source discovery (tests use a synthetic tree).
 * @param {readonly string[]} [options.expectedTsx] Expected browser TSX surfaces.
 * @param {(message: string) => void} [options.log]
 * @returns {{ok: boolean, failures: string[], files: object[], baseline: object|null, browser: object|null}}
 */
export function runCoverageCheck({
  cwd = REPO_ROOT,
  requireBrowser = false,
  expectedArtifact = null,
  updateDebt = false,
  acceptRegression = false,
  currentWorktree = null,
  paths = COVERAGE_PATHS,
  sourceFiles = null,
  expectedTsx = CLIENT_BROWSER_TSX,
  log = (message) => console.log(message),
} = {}) {
  const inputs = loadInputs({ cwd, paths, requireBrowser, expectedTsx, sourceFiles })
  const failures = [...inputs.failures]
  const liveWorktree = resolveWorktree({ cwd, currentWorktree, failures })
  if (liveWorktree !== null) {
    failures.push(...freshnessFailures({ unitMeta: inputs.unitMeta, paths, currentWorktree: liveWorktree }))
  }
  if (updateDebt && (inputs.unitRecords === null || failures.length > 0)) {
    return { ok: false, failures, files: [], baseline: null, browser: inputs.browserClient }
  }
  if (expectedArtifact !== null) {
    failures.push(...artifactFailures({
      unitMeta: inputs.unitMeta,
      browserClient: inputs.browserClient,
      expectedArtifact,
    }))
  }
  const baseline = prepareBaseline({ cwd, paths, updateDebt, acceptRegression, inputs, failures, log })
  if (updateDebt && baseline === null) {
    return { ok: false, failures, files: [], baseline: null, browser: inputs.browserClient }
  }
  const baselineByPath = new Map((baseline?.files ?? []).map((entry) => [entry.path, entry]))
  const { files, browser } = collectVerdicts({ cwd, requireBrowser, paths, inputs, baselineByPath, failures })
  return { ok: failures.length === 0, failures, files, baseline, browser }
}

async function main() {
  const { values } = parseArgs({
    options: {
      'update-debt': { type: 'boolean', default: false },
      'accept-regression': { type: 'boolean', default: false },
      'require-browser': { type: 'boolean', default: false },
      base: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  })
  if (values.help) {
    console.log('usage: npm run coverage:check [-- --require-browser --base <ref> | --update-debt [--accept-regression]]')
    return
  }
  let expectedArtifact = null
  if (values.base !== undefined) {
    const { collectGateArtifact } = await import('../review/gate-artifact.mjs')
    expectedArtifact = collectGateArtifact(['--base', values.base], REPO_ROOT)
  }
  const result = runCoverageCheck({
    cwd: REPO_ROOT,
    requireBrowser: values['require-browser'],
    expectedArtifact,
    updateDebt: values['update-debt'],
    acceptRegression: values['accept-regression'],
  })
  for (const failure of result.failures) console.error(`coverage: ${failure}`)
  if (!result.ok) process.exitCode = 1
}

runScript(import.meta.url, main, 'coverage-check')
