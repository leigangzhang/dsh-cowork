#!/usr/bin/env node
/**
 * Gate a saved `fallow audit --format json` report on its attribution counters.
 *
 * `fallow audit` can exit 0 while its JSON records a line-count regression as
 * warn-level `complexity_worsened`, so the exit code alone cannot prove the
 * gate. This script asserts the machine-readable counters and binds the report
 * to the compared commit range and the pinned CLI version. It exits 0 only for
 * a complete audit report with zero introduced and zero worsened complexity
 * findings; any other shape prints every problem and exits 1.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Read the exact CLI version pinned in `devDependencies`.
 *
 * @returns {string | undefined} Pinned fallow version, if the manifest declares one.
 */
export function pinnedFallowVersion() {
  const manifest = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, 'package.json'), 'utf8'))
  const version = manifest.devDependencies?.fallow
  return typeof version === 'string' ? version : undefined
}

function attributionProblems(attribution) {
  if (attribution === null || typeof attribution !== 'object') {
    return ['audit report has no attribution counters']
  }
  const problems = []
  for (const field of ['complexity_introduced', 'complexity_worsened']) {
    const value = attribution[field]
    if (value !== 0) problems.push(`${field} is ${String(value)}, expected 0`)
  }
  return problems
}

/**
 * Compare a commit from a fallow report with the expected full SHA.
 *
 * `fallow audit --format json` reports `head_sha` with git's abbreviated form,
 * while the workflow knows the full 40-character SHA. An abbreviated value is
 * accepted only when it is a hex prefix of the expected commit.
 *
 * @param {unknown} actual Commit reported by fallow.
 * @param {string} expected Full expected commit SHA.
 * @returns {boolean} Whether the two values name the same commit.
 */
function sameCommit(actual, expected) {
  if (actual === expected) return true
  return typeof actual === 'string' && /^[0-9a-f]{7,40}$/.test(actual) && expected.startsWith(actual)
}

function identityProblems(report, expected) {
  const problems = []
  if (expected.expectVersion !== undefined && report.version !== expected.expectVersion) {
    problems.push(`CLI version ${String(report.version)} does not match the pinned ${expected.expectVersion}`)
  }
  if (expected.expectBase !== undefined && !sameCommit(report.base_ref, expected.expectBase)) {
    problems.push(`base ${String(report.base_ref)} does not match the resolved base ${expected.expectBase}`)
  }
  if (expected.expectHead !== undefined && !sameCommit(report.head_sha, expected.expectHead)) {
    problems.push(`head ${String(report.head_sha)} does not match the compared head ${expected.expectHead}`)
  }
  return problems
}

/**
 * Collect every reason a saved audit report cannot serve as gate evidence.
 *
 * @param {unknown} report Parsed `fallow audit --format json` output.
 * @param {{ expectBase?: string, expectHead?: string, expectVersion?: string }} [expected] Compared commit and CLI identity.
 * @returns {string[]} Concrete problems; an empty array passes the gate.
 */
export function fallowGateProblems(report, expected = {}) {
  if (report === null || typeof report !== 'object') return ['audit report is not a JSON object']
  const problems = []
  if (report.kind !== 'audit') problems.push(`unexpected report kind: ${String(report.kind)}`)
  problems.push(...attributionProblems(report.attribution), ...identityProblems(report, expected))
  return problems
}

function readReport(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function parseOptions(args) {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      audit: { type: 'string' },
      'expect-base': { type: 'string' },
      'expect-head': { type: 'string' },
      'expect-version': { type: 'string' },
    },
    strict: true,
  })
  const audit = values.audit
  if (audit === undefined || audit.trim() === '') throw new Error('missing required --audit <path>')
  return { audit, ...values }
}

function main() {
  const options = parseOptions(process.argv.slice(2))
  const report = readReport(options.audit)
  const problems = fallowGateProblems(report, {
    expectBase: options['expect-base'],
    expectHead: options['expect-head'],
    expectVersion: options['expect-version'] ?? pinnedFallowVersion(),
  })
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`fallow-gate: ${problem}\n`)
    process.exitCode = 1
    return
  }
  const attribution = report.attribution
  process.stdout.write(
    `fallow-gate: fallow ${String(report.version)} audit passed for base ${String(report.base_ref)} / head ${String(report.head_sha)}: ` +
      `${String(attribution.complexity_introduced)} introduced, ${String(attribution.complexity_worsened)} worsened complexity findings\n`,
  )
}

const invoked = process.argv[1]
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`fallow-gate: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
