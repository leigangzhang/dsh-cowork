#!/usr/bin/env node
/**
 * Deterministic unit coverage lane and its gate entry point.
 *
 * The aggregate `node --test` coverage report is not reproducible: the runner's
 * per-child collection intermittently drops a whole test file, which is fatal
 * for a per-file gate. This lane runs every `*.test.mjs` in its own process,
 * writes one LCOV report per process, and merges the reports by union. Set
 * union makes the merged line set independent of process order and scheduling.
 *
 * Scope: TypeScript files under `src/`; the owner map decides which lane owns
 * each file. The client TSX files are browser-rendered surfaces owned by
 * `test:browser`, and the six legacy M12 drivers are explicit `dev` entries.
 *
 * `npm run test:coverage` collects and then runs `coverage-check.mjs`; use
 * `--update-debt` after an intentional coverage change to refresh the reviewed
 * baseline. The gate itself never writes the baseline.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeLcovRecords, parseLcov, renderLcov, totalsOf } from './coverage-lcov.mjs'
import { failureTail, runScript } from './cli-support.mjs'
import { gitState } from './git-state.mjs'
import { filesIn } from './file-walk.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** Repository root, used as the coverage working directory. */
export const REPO_ROOT = resolve(here, '../..')

/** Directory holding generated reports; it is gitignored. */
const COVERAGE_DIR = join(REPO_ROOT, 'coverage')

/** Merged unit report consumed by `coverage:check`. */
const UNIT_REPORT = join(COVERAGE_DIR, 'unit.lcov')

/** Upper bound for one test-file process, including a booting host smoke. */
const TEST_FILE_TIMEOUT_MS = 300_000

/**
 * Environment for one child test process.
 *
 * A collector can itself run inside `node --test` (the guard tests do); the
 * child runner must start fresh instead of inheriting the parent's
 * `NODE_TEST_*` context. A parent coverage run's `NODE_V8_COVERAGE` must not
 * receive the child's raw files either; the child writes its own LCOV report.
 */
export function childTestEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(
    ([key]) => !key.startsWith('NODE_TEST_') && key !== 'NODE_V8_COVERAGE',
  ))
}

/**
 * Every `*.test.mjs` below `directory`, recursively, as sorted absolute paths.
 *
 * This mirrors `node --test tests/`: moving a test into a subdirectory must not
 * silently drop it from the coverage lane. Support modules are not test files
 * and stay excluded by the `*.test.mjs` suffix.
 */
export function testFilesIn(directory) {
  return filesIn(directory, (name) => name.endsWith('.test.mjs'))
}

/**
 * Node argv for one test file's LCOV report.
 *
 * The spec reporter stays on stdout so a failing file still explains itself;
 * the lcov reporter owns the per-process report file.
 *
 * @param {string} testFile Absolute test file path.
 * @param {string} reportPath Absolute LCOV destination.
 * @returns {string[]}
 */
export function unitCoverageArgs(testFile, reportPath) {
  return [
    '--experimental-test-coverage',
    '--test-coverage-include=src/**/*.ts',
    '--test-reporter=lcov',
    `--test-reporter-destination=${reportPath}`,
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test',
    testFile,
  ]
}

/**
 * Read the layered identity passed by `test:coverage:layered`.
 *
 * A malformed value fails closed: a lane must never report an identity it did
 * not receive.
 */
export function gateArtifactFromEnv(environment = process.env) {
  const raw = environment.COVERAGE_GATE_ARTIFACT
  if (raw === undefined || raw === '') return null
  const parsed = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('COVERAGE_GATE_ARTIFACT must hold a JSON object')
  }
  return parsed
}

function reportSlug(index, testFile, cwd) {
  const relativePath = relative(cwd, testFile).split(/[^A-Za-z0-9._-]+/).join('_')
  return `${String(index).padStart(2, '0')}-${relativePath}.lcov`
}

/**
 * Run every test file in its own process and merge the LCOV reports.
 *
 * @param {object} [options]
 * @param {string} [options.cwd] Repository root.
 * @param {string[]} [options.testFiles] Override discovery, in run order.
 * @param {string} [options.outputDir] Report directory, including `unit-raw`.
 * @param {(message: string) => void} [options.log] Progress sink.
 * @param {object|null} [options.gateArtifact] Identity bound by the layered runner.
 * @param {(testFile: string, reportPath: string) => string[]} [options.argsFor] Argv seam for the missing-report control.
 * @returns {{reportPath: string, metaPath: string, meta: object, records: Map}}
 * @throws {Error} when a test process fails or writes no report.
 */
export function runUnitCoverage({
  cwd = REPO_ROOT,
  testFiles = testFilesIn(join(cwd, 'tests')),
  outputDir = COVERAGE_DIR,
  log = (message) => console.log(message),
  gateArtifact = gateArtifactFromEnv(),
  argsFor = unitCoverageArgs,
} = {}) {
  mkdirSync(outputDir, { recursive: true })
  const reportPath = join(outputDir, 'unit.lcov')
  const metaPath = join(outputDir, 'unit.json')
  rmSync(reportPath, { force: true })
  rmSync(metaPath, { force: true })
  const rawDir = join(outputDir, 'unit-raw')
  rmSync(rawDir, { recursive: true, force: true })
  mkdirSync(rawDir, { recursive: true })
  const startedAt = new Date()
  const started = Date.now()
  const reports = []
  for (const [index, testFile] of testFiles.entries()) {
    const reportPath = join(rawDir, reportSlug(index, testFile, cwd))
    const result = spawnSync(process.execPath, argsFor(testFile, reportPath), {
      cwd,
      encoding: 'utf8',
      timeout: TEST_FILE_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: childTestEnvironment(),
    })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) {
      throw new Error(
        `unit coverage failed for ${relative(cwd, testFile)} (exit ${String(result.status)})\n${failureTail(result)}`,
      )
    }
    if (!existsSync(reportPath)) {
      throw new Error(`unit coverage for ${relative(cwd, testFile)} wrote no LCOV report`)
    }
    reports.push(parseLcov(readFileSync(reportPath, 'utf8')))
    if ((index + 1) % 10 === 0 || index + 1 === testFiles.length) {
      log(`unit coverage: ${index + 1}/${testFiles.length} test files`)
    }
  }
  const records = mergeLcovRecords(...reports)
  const reportText = renderLcov(records)
  writeFileSync(`${reportPath}.tmp`, reportText)
  renameSync(`${reportPath}.tmp`, reportPath)
  const meta = {
    formatVersion: 1,
    lane: 'unit',
    command: 'node scripts/evidence/test-coverage.mjs',
    exitCode: 0,
    testFiles: testFiles.length,
    nodeVersion: process.version,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - started,
    artifact: gitState(cwd),
    gateArtifact,
    report: 'coverage/unit.lcov',
    totals: totalsOf(records),
    modules: records.size,
  }
  writeFileSync(`${metaPath}.tmp`, `${JSON.stringify(meta, null, 2)}\n`)
  renameSync(`${metaPath}.tmp`, metaPath)
  return { reportPath, metaPath, meta, records }
}

function percentage(covered, total) {
  return total === 0 ? '100.00' : ((covered / total) * 100).toFixed(2)
}

/** Line totals over the gate's unit-owned files, excluding dev records. */
function ownerTotals(files) {
  const owned = files.filter((file) => file.lane === 'unit' && file.lines !== undefined)
  const total = owned.reduce((sum, file) => sum + file.lines.total, 0)
  const covered = owned.reduce((sum, file) => sum + file.lines.covered, 0)
  return { files: owned.length, total, covered }
}

async function main() {
  const argv = process.argv.slice(2)
  const updateDebt = argv.includes('--update-debt')
  const acceptRegression = argv.includes('--accept-regression')
  const { meta } = runUnitCoverage()
  const totals = meta.totals
  console.log(
    `all src records: ${meta.modules} modules, line ${percentage(totals.lines.covered, totals.lines.total)}% `
      + `(${totals.lines.covered}/${totals.lines.total}), branch ${percentage(totals.branches.covered, totals.branches.total)}%, `
      + `function ${percentage(totals.functions.covered, totals.functions.total)}%`,
  )
  console.log(`unit coverage: report ${relative(REPO_ROOT, UNIT_REPORT)} in ${String(meta.durationMs)} ms`)
  const { runCoverageCheck } = await import('./coverage-check.mjs')
  const result = runCoverageCheck({ cwd: REPO_ROOT, updateDebt, acceptRegression })
  const owned = ownerTotals(result.files)
  console.log(
    `unit coverage (owner map): ${owned.files} files, line ${percentage(owned.covered, owned.total)}% `
      + `(${owned.covered}/${owned.total})`,
  )
  for (const failure of result.failures) console.error(`coverage: ${failure}`)
  if (!result.ok) process.exitCode = 1
}

runScript(import.meta.url, main, 'test-coverage')
