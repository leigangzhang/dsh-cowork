#!/usr/bin/env node
/**
 * Layered coverage evidence: run both lanes against one artifact identity.
 *
 * Usage:
 *   npm run test:coverage:layered -- --base <verified-base>
 *
 * The unit lane runs every test file in its own process. The browser lane packs
 * the current `lib/`, boots a temporary DSH host, drives Chromium, and maps the
 * served combo source map back to client sources. Both lanes receive the same
 * gate artifact (HEAD, base, binary diff SHA-256, porcelain) and write it into
 * their sidecars; the checker refuses a report whose identity does not match.
 *
 * The browser lane is strict here: a missing `dsh`, Chromium, or Playwright is a
 * failure, never a skip that could be mistaken for a green layered gate.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { collectGateArtifact } from '../review/gate-artifact.mjs'
import { runScript, failureTail } from './cli-support.mjs'
import { runCoverageCheck } from './coverage-check.mjs'
import { REPO_ROOT, runUnitCoverage } from './test-coverage.mjs'

const BROWSER_TIMEOUT_MS = 15 * 60_000
const MAX_BUFFER = 64 * 1024 * 1024
const BUILD_TIMEOUT_MS = 5 * 60_000
const BUILD = Object.freeze({ command: 'bash scripts/build/build.sh' })
const FILES = Object.freeze({
  unitReport: 'coverage/unit.lcov',
  unitMeta: 'coverage/unit.json',
  browserClient: 'coverage/client.json',
  browserLcov: 'coverage/browser.lcov',
  layered: 'coverage/layered.json',
})

function requireBase(values) {
  if (values.base === undefined || values.base.trim() === '') {
    throw new Error('missing required --base <verified-base>')
  }
  return values.base
}

/** Rebuild `lib/` so the browser lane measures the current source, not a stale artifact. */
function runBuild() {
  const result = spawnSync('bash', ['scripts/build/build.sh'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: BUILD_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`build failed (exit ${String(result.status)})\n${failureTail(result, 30)}`)
  }
}

function runBrowserLane(artifact) {
  const result = spawnSync(process.execPath, ['scripts/evidence/browser-panel.mjs'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: BROWSER_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    env: {
      ...process.env,
      DSH_BROWSER_STRICT: '1',
      COVERAGE_GATE_ARTIFACT: JSON.stringify(artifact),
    },
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`browser lane failed (exit ${String(result.status)})\n${failureTail(result, 40)}`)
  }
}

function readBrowserClient() {
  try {
    return JSON.parse(readFileSync(resolve(REPO_ROOT, FILES.browserClient), 'utf8'))
  } catch {
    return null
  }
}

function ownerTotals(files, lane) {
  const owned = files.filter((file) => file.lane === lane && file.lines !== undefined)
  const total = owned.reduce((sum, file) => sum + file.lines.total, 0)
  const covered = owned.reduce((sum, file) => sum + file.lines.covered, 0)
  return { files: owned.length, total, covered }
}

function unitLane(unit, check) {
  return {
    report: FILES.unitReport,
    meta: FILES.unitMeta,
    testFiles: unit.meta.testFiles,
    durationMs: unit.meta.durationMs,
    totals: ownerTotals(check.files, 'unit'),
  }
}

function browserLane(browserClient) {
  const client = browserClient ?? {}
  return {
    client: FILES.browserClient,
    lcov: FILES.browserLcov,
    artifact: client.artifact ?? null,
    summary: client.summary ?? null,
  }
}

function policy(check) {
  return {
    line: 'per-file 100, or the reviewed uncovered-line baseline',
    branch: 'recorded in the reviewed baseline; not yet blocking',
    function: 'recorded in the reviewed baseline; not yet blocking',
    browser: check.browser?.floors ?? 'observational',
    ownership: 'exclusive: each file is judged by its owner lane only',
  }
}

function buildReport({ artifact, unit, browserClient, check }) {
  return {
    formatVersion: 1,
    artifact,
    lanes: { unit: unitLane(unit, check), browser: browserLane(browserClient) },
    build: { ...BUILD, ok: true },
    policy: policy(check),
    files: check.files,
    ok: check.ok,
    failures: check.failures,
  }
}

function writeReport(report) {
  mkdirSync(resolve(REPO_ROOT, 'coverage'), { recursive: true })
  writeFileSync(resolve(REPO_ROOT, 'coverage', 'layered.json'), `${JSON.stringify(report, null, 2)}\n`)
}

function printSummary(report, check) {
  const counted = report.files.filter((file) => file.status !== 'blocked')
  const lines = counted.reduce((total, file) => total + (file.lines?.total ?? 0), 0)
  const covered = counted.reduce((total, file) => total + (file.lines?.covered ?? 0), 0)
  const percent = lines === 0 ? '100.00' : ((covered / lines) * 100).toFixed(2)
  console.log(`layered coverage: ${counted.length} counted files, line ${percent}% (${String(covered)}/${String(lines)})`)
  console.log('layered coverage: report coverage/layered.json')
  for (const failure of check.failures) console.error(`coverage: ${failure}`)
}

/** Run the unit lane and stop before the browser cost when it is already red. */
function runUnitGate(artifact) {
  const unit = runUnitCoverage({ cwd: REPO_ROOT, gateArtifact: artifact })
  const check = runCoverageCheck({ cwd: REPO_ROOT })
  if (check.ok) return { unit, check }
  const report = buildReport({ artifact, unit, browserClient: null, check })
  writeReport(report)
  printSummary(report, check)
  throw new Error(`unit coverage gate failed (${String(check.failures.length)} findings)`)
}

function runBrowserGate(artifact, unit, unitCheck) {
  try {
    runBrowserLane(artifact)
    return readBrowserClient()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const check = { ok: false, files: unitCheck.files, failures: [`browser lane failed: ${message}`], browser: null }
    const report = buildReport({ artifact, unit, browserClient: null, check })
    writeReport(report)
    printSummary(report, check)
    throw error
  }
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
    console.log('usage: npm run test:coverage:layered -- --base <verified-base>')
    return
  }
  const artifact = collectGateArtifact(['--base', requireBase(values)], REPO_ROOT)
  process.env.COVERAGE_GATE_ARTIFACT = JSON.stringify(artifact)
  runBuild()
  const unitGate = runUnitGate(artifact)
  const browserClient = runBrowserGate(artifact, unitGate.unit, unitGate.check)
  const check = runCoverageCheck({ cwd: REPO_ROOT, requireBrowser: true, expectedArtifact: artifact })
  const report = buildReport({ artifact, unit: unitGate.unit, browserClient, check })
  writeReport(report)
  printSummary(report, check)
  if (!check.ok) process.exitCode = 1
}

runScript(import.meta.url, main, 'coverage-layered')
