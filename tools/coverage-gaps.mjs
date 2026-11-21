#!/usr/bin/env node
/**
 * Mechanical coverage contract and changed-file gap report.
 *
 * Two readers share this module:
 * - `npm run check` uses {@link coverageContractProblems} to reject a browser
 *   TSX surface without a reviewed floor before any heavy run starts.
 * - `npm run coverage:gaps -- --base <ref>` uses {@link collectCoverageGaps} to
 *   bind the current worktree identity to the layered coverage reports, reuse
 *   matching reports without rerunning the lanes, and print changed-file
 *   uncovered lines plus changed public surfaces missing from the E2E manifest.
 *
 * The gap report writes only the gitignored `coverage/` reports. It never edits
 * a floor, manifest, or committed evidence file.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { collectChangeScope } from '../scripts/review/change-scope.mjs'
import { collectGateArtifact } from '../scripts/review/gate-artifact.mjs'
import { CLIENT_BROWSER_BLOCKED } from '../scripts/evidence/client-coverage.mjs'
import { parseLcov, uncoveredLines } from '../scripts/evidence/coverage-lcov.mjs'
import { isTypeOnly, sourceFilesIn, validateOwnershipMap } from '../scripts/evidence/coverage-owners.mjs'
import { runScript } from '../scripts/evidence/cli-support.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** Repository root used by the CLI and the check integration. */
export const REPO_ROOT = resolve(here, '..')

/** Paths read by the gap report. */
export const COVERAGE_GAP_PATHS = Object.freeze({
  map: 'tools/coverage-map.json',
  floors: 'tools/coverage-browser-floors.json',
  unitMeta: 'coverage/unit.json',
  browserClient: 'coverage/client.json',
  layered: 'coverage/layered.json',
  unitLcov: 'coverage/unit.lcov',
  browserLcov: 'coverage/browser.lcov',
  manifest: 'tests/e2e/manifest.json',
})

const FLOOR_KEYS = new Set(['lineCoverage', 'functionCoverage'])
const SOURCE_EXTENSION = /\.(?:ts|tsx)$/
const PANEL_CONTRACT_FILES = new Set(['src/panel/api-contract.ts', 'src/panel/inbox-contract.ts'])
const PRESET_FILE = 'src/platform/presets.ts'
const SCHEMA_FILE = 'src/store/schema.ts'

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Stable JSON for identity comparison; key order must not decide evidence. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function readOptionalJson(path) {
  try {
    return readJson(path)
  } catch {
    return null
  }
}

function normalizePaths(paths) {
  return [...new Set(paths.map((path) => String(path).trim()).filter((path) => path !== ''))].sort()
}

/**
 * Validate one parsed `tools/coverage-browser-floors.json` against the owner map.
 *
 * The browser checker still applies the actual percentages to a live report;
 * this function owns the static half: every non-blocked browser-owned file has
 * a floor, every named file is browser-owned, and only reviewed numeric keys
 * are accepted.
 *
 * @param {unknown} parsed Parsed floor file, or null when it does not exist.
 * @param {Map<string, {lane: string}>} byPath Validated coverage owner map.
 * @param {{path?: string, blocked?: Record<string, object>}} [options] Labels and blocked surface set.
 * @returns {{files: Record<string, object>|null, failures: string[]}} Parsed floor map and violations.
 */
export function browserFloorFileProblems(parsed, byPath, options = {}) {
  const path = options.path ?? COVERAGE_GAP_PATHS.floors
  const blocked = options.blocked ?? CLIENT_BROWSER_BLOCKED
  const failures = []
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
    || parsed.version !== 1 || parsed.files === null || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) {
    return { files: null, failures: [`${path} must be an object with version 1 and a files map`] }
  }
  const files = parsed.files
  for (const [file, floor] of Object.entries(files)) {
    if (byPath.get(file)?.lane !== 'browser') {
      failures.push(`${path}: floor names no browser source file: ${file}`)
      continue
    }
    if (floor === null || typeof floor !== 'object' || Array.isArray(floor)) {
      failures.push(`${path}: floor for ${file} must be an object`)
      continue
    }
    for (const [key, value] of Object.entries(floor)) {
      if (!FLOOR_KEYS.has(key)) {
        failures.push(`${path}: floor for ${file} has unknown key ${key}`)
      } else if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        failures.push(`${path}: floor ${file}.${key} must be a number in 0..100`)
      }
    }
  }
  for (const [file, entry] of byPath) {
    if (entry.lane !== 'browser' || blocked[file] !== undefined) continue
    if (files[file] === undefined) failures.push(`${path}: reviewed browser floors are missing ${file}`)
  }
  return { files, failures }
}

/**
 * Run the static half of the coverage contract used by `npm run check`.
 *
 * A changed TSX surface cannot exist without a browser owner and a reviewed
 * floor: the owner map is validated against the whole source tree, then the
 * floor file is validated against that map. A type-only source file needs no
 * runtime floor and is left to the owner map's type-only rule.
 *
 * @param {string} [cwd] Repository root.
 * @returns {string[]} One message per contract violation.
 */
export function coverageContractProblems(cwd = REPO_ROOT) {
  const failures = []
  let parsedMap = null
  try {
    parsedMap = readJson(resolve(cwd, COVERAGE_GAP_PATHS.map))
  } catch (error) {
    failures.push(`${COVERAGE_GAP_PATHS.map} is unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
  const discovered = sourceFilesIn(cwd)
  const ownership = parsedMap === null
    ? { failures: [], byPath: new Map() }
    : validateOwnershipMap(parsedMap, discovered)
  failures.push(...ownership.failures)

  let parsedFloors = null
  try {
    parsedFloors = readJson(resolve(cwd, COVERAGE_GAP_PATHS.floors))
  } catch (error) {
    if (error?.code === 'ENOENT') failures.push(`${COVERAGE_GAP_PATHS.floors} is missing`)
    else failures.push(`${COVERAGE_GAP_PATHS.floors} is unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsedFloors !== null) {
    failures.push(...browserFloorFileProblems(parsedFloors, ownership.byPath, { path: COVERAGE_GAP_PATHS.floors }).failures)
  }
  return failures
}

/**
 * Build the current public-surface owner map used to turn changed source paths
 * into changed surface keys. The live key list comes from the suite snapshot;
 * this mapping only decides which changed source file owns which key.
 *
 * @returns {Promise<{keys: string[], byFile: Map<string, string[]>}>} Surface keys and file owners.
 */
async function surfaceOwners() {
  const publicSurface = await import(new URL('../tests/support/public-surface.mjs', import.meta.url))
  const { collectSurfaceKeys } = await import(new URL('./e2e-coverage.mjs', import.meta.url))
  const keys = await collectSurfaceKeys()
  const byFile = new Map()
  const add = (file, key) => {
    const owned = byFile.get(file) ?? []
    owned.push(key)
    byFile.set(file, owned)
  }
  for (const [file, tools] of publicSurface.TOOL_DOMAINS) {
    for (const tool of tools) add(file, `tool:${tool}`)
  }
  for (const file of PANEL_CONTRACT_FILES) {
    for (const [route, method] of publicSurface.PANEL_ROUTES) add(file, `route:${route} ${method}`)
  }
  for (const key of keys) {
    if (key.startsWith('preset:')) add(PRESET_FILE, key)
    else if (key.startsWith('topic-status:') || key.startsWith('review-status:') || key.startsWith('work-item-status:')) {
      add(SCHEMA_FILE, key)
    }
  }
  for (const owned of byFile.values()) owned.sort()
  return { keys, byFile }
}

/**
 * Return changed public surface keys whose owner source file changed.
 *
 * @param {string[]} changedPaths Repository-relative paths.
 * @returns {Promise<string[]>} Sorted, de-duplicated surface keys.
 */
export async function changedSurfaceKeys(changedPaths) {
  const { byFile } = await surfaceOwners()
  const keys = new Set()
  for (const path of normalizePaths(changedPaths)) {
    for (const key of byFile.get(path) ?? []) keys.add(key)
  }
  return [...keys].sort()
}

/**
 * Return changed surface keys absent from every E2E scenario's `covers` list.
 *
 * A debt entry is a reviewed exception for the static manifest gate; this
 * report intentionally still names the missing scenario so a human can see the
 * gap rather than only the exception.
 *
 * @param {{scenarios?: Array<{covers?: string[]}>}} manifest Parsed E2E manifest.
 * @param {string[]} keys Changed surface keys.
 * @returns {string[]} Missing keys, sorted.
 */
export function missingManifestCovers(manifest, keys) {
  const covered = new Set()
  for (const scenario of manifest?.scenarios ?? []) {
    for (const key of scenario?.covers ?? []) covered.add(key)
  }
  return [...new Set(keys)].filter((key) => !covered.has(key)).sort()
}

/**
 * Report uncovered lines for changed TypeScript/TSX files.
 *
 * A file that changed but has no coverage record is a gap unless it is
 * type-only, which cannot produce executable lines. Unit and browser records
 * are unioned defensively even though the owner map makes them exclusive.
 *
 * @param {{changedPaths: string[], unitRecords: Map<string, object>,
 *   browserRecords: Map<string, object>, cwd?: string}} input Reports and paths.
 * @returns {Array<{file: string, hasRecord: boolean, lines: number[]}>} Per-file gaps.
 */
export function changedFileGaps({ changedPaths, unitRecords, browserRecords, cwd = REPO_ROOT }) {
  const gaps = []
  for (const file of normalizePaths(changedPaths)) {
    if (!file.startsWith('src/') || !SOURCE_EXTENSION.test(file)) continue
    const records = [unitRecords.get(file), browserRecords.get(file)].filter((record) => record !== undefined)
    if (records.length === 0) {
      if (existsSync(resolve(cwd, file)) && isTypeOnly(resolve(cwd, file))) continue
      gaps.push({ file, hasRecord: false, lines: [] })
      continue
    }
    const lines = new Set()
    for (const record of records) {
      for (const line of uncoveredLines(record)) lines.add(line)
    }
    gaps.push({ file, hasRecord: true, lines: [...lines].sort((left, right) => left - right) })
  }
  return gaps
}

/**
 * Return changed paths from every worktree group: committed, staged, unstaged,
 * and untracked. The gap report must describe the tree the report identity
 * describes, not only the last commit.
 *
 * @param {string} cwd Repository root.
 * @param {string} base Caller-verified base ref.
 * @returns {string[]} Sorted repository-relative paths.
 */
export function changedWorktreePaths(cwd, base) {
  const scope = collectChangeScope(['--base', base], cwd)
  return normalizePaths(Object.values(scope.paths).flat())
}

/**
 * Return whether the existing layered reports were produced for this exact
 * artifact identity (HEAD, base, diff, and porcelain).
 *
 * @param {{cwd?: string, artifact: object|null}} input Identity and root.
 * @returns {boolean} True when both lanes and the layered sidecar match.
 */
export function reportsMatchArtifact({ cwd = REPO_ROOT, artifact }) {
  if (artifact === null || typeof artifact !== 'object') return false
  const layered = readOptionalJson(resolve(cwd, COVERAGE_GAP_PATHS.layered))
  const unitMeta = readOptionalJson(resolve(cwd, COVERAGE_GAP_PATHS.unitMeta))
  const browserClient = readOptionalJson(resolve(cwd, COVERAGE_GAP_PATHS.browserClient))
  if (layered === null || unitMeta === null || browserClient === null) return false
  if (!sameJson(layered.artifact, artifact)) return false
  if (!sameJson(unitMeta.gateArtifact, artifact)) return false
  if (!sameJson(browserClient.artifact?.gateArtifact, artifact)) return false
  return existsSync(resolve(cwd, COVERAGE_GAP_PATHS.unitLcov))
    && existsSync(resolve(cwd, COVERAGE_GAP_PATHS.browserLcov))
}

function runLayeredCoverage({ cwd, base }) {
  const result = spawnSync(process.execPath, ['scripts/evidence/coverage-layered.mjs', '--base', base], {
    cwd,
    stdio: 'inherit',
    timeout: 60 * 60_000,
    env: process.env,
  })
  if (result.error !== undefined) throw result.error
  return { status: result.status ?? 1 }
}

function readReports(cwd) {
  let unitRecords
  let browserRecords
  try {
    unitRecords = parseLcov(readFileSync(resolve(cwd, COVERAGE_GAP_PATHS.unitLcov), 'utf8'))
    browserRecords = parseLcov(readFileSync(resolve(cwd, COVERAGE_GAP_PATHS.browserLcov), 'utf8'))
  } catch (error) {
    throw new Error(`coverage reports are not readable; run npm run test:coverage:layered -- --base <ref>: ${error instanceof Error ? error.message : String(error)}`)
  }
  const layered = readOptionalJson(resolve(cwd, COVERAGE_GAP_PATHS.layered))
  return { unitRecords, browserRecords, coverageOk: layered?.ok ?? null }
}

function shortSha(sha) {
  return typeof sha === 'string' ? sha.slice(0, 12) : 'unknown'
}

/**
 * Collect one gap report, reusing matching layered reports and otherwise
 * running the layered lane before reading them.
 *
 * @param {object} [options]
 * @param {string} options.base Caller-verified base ref.
 * @param {string} [options.cwd] Repository root.
 * @param {object|null} [options.artifact] Precomputed gate artifact (tests).
 * @param {string[]} [options.changedPaths] Precomputed changed paths (tests).
 * @param {string[]|null} [options.surfaceKeys] Precomputed changed surface keys (tests).
 * @param {(input: {cwd: string, base: string}) => Promise<{status: number}>|{status: number}} [options.runLayered]
 *   Coverage runner seam.
 * @returns {Promise<{artifact: object, changedPaths: string[], reused: boolean,
 *   exitCode: number, coverageOk: boolean|null, fileGaps: Array<object>,
 *   missingSurfaces: string[]}>} Gap report.
 */
export async function collectCoverageGaps({
  base,
  cwd = REPO_ROOT,
  artifact = null,
  changedPaths = null,
  surfaceKeys = null,
  runLayered = runLayeredCoverage,
}) {
  const identity = artifact ?? collectGateArtifact(['--base', base], cwd)
  const paths = changedPaths ?? changedWorktreePaths(cwd, base)
  const reused = reportsMatchArtifact({ cwd, artifact: identity })
  let exitCode = 0
  if (!reused) {
    const result = await runLayered({ cwd, base })
    exitCode = Number.isInteger(result?.status) ? result.status : 1
  }
  const { unitRecords, browserRecords, coverageOk } = readReports(cwd)
  if (coverageOk === false && exitCode === 0) exitCode = 1
  const manifest = readJson(resolve(cwd, COVERAGE_GAP_PATHS.manifest))
  const surfaces = surfaceKeys ?? await changedSurfaceKeys(paths)
  return {
    artifact: identity,
    changedPaths: paths,
    reused,
    exitCode,
    coverageOk,
    fileGaps: changedFileGaps({ changedPaths: paths, unitRecords, browserRecords, cwd }),
    missingSurfaces: missingManifestCovers(manifest, surfaces),
  }
}

/**
 * Render the two lists in a stable, comment-friendly form.
 *
 * @param {Awaited<ReturnType<typeof collectCoverageGaps>>} report Gap report.
 * @returns {string} Human-readable report.
 */
export function formatCoverageGaps(report) {
  const lines = [
    `coverage gaps: base ${shortSha(report.artifact.resolved?.baseSha)} head ${shortSha(report.artifact.resolved?.headSha)} (${report.reused ? 'reused existing reports' : 'ran layered coverage'})`,
    '',
    'changed uncovered lines:',
  ]
  const gaps = report.fileGaps.filter((gap) => !gap.hasRecord || gap.lines.length > 0)
  if (gaps.length === 0) {
    lines.push('  none')
  } else {
    for (const gap of gaps) {
      lines.push(gap.hasRecord
        ? `  ${gap.file}: ${gap.lines.join(', ')}`
        : `  ${gap.file}: no coverage record`)
    }
  }
  lines.push('', 'changed surfaces missing from tests/e2e/manifest.json covers:')
  if (report.missingSurfaces.length === 0) lines.push('  none')
  else for (const key of report.missingSurfaces) lines.push(`  ${key}`)
  if (report.coverageOk === false) lines.push('', 'coverage gate: red; the layered report still describes the gaps above.')
  return `${lines.join('\n')}\n`
}

async function main() {
  const { values } = parseArgs({
    options: {
      base: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  })
  if (values.help) {
    console.log('usage: npm run coverage:gaps -- --base <verified-base>')
    return
  }
  if (values.base === undefined || values.base.trim() === '') throw new Error('missing required --base <verified-base>')
  const report = await collectCoverageGaps({ base: values.base, cwd: REPO_ROOT })
  process.stdout.write(formatCoverageGaps(report))
  if (report.exitCode !== 0) process.exitCode = report.exitCode
}

runScript(import.meta.url, main, 'coverage-gaps')
