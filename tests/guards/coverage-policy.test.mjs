import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  branchTotals,
  functionTotals,
  lineTotals,
  mergeLcovRecords,
  parseLcov,
  renderLcov,
  uncoveredLines,
} from '../../scripts/evidence/coverage-lcov.mjs'
import { runCoverageCheck } from '../../scripts/evidence/coverage-check.mjs'
import { CLIENT_BROWSER_BLOCKED } from '../../scripts/evidence/client-coverage.mjs'
import { isTypeOnly, sourceFilesIn, validateOwnershipMap } from '../../scripts/evidence/coverage-owners.mjs'
import {
  childTestEnvironment,
  runUnitCoverage,
  testFilesIn,
  unitCoverageArgs,
} from '../../scripts/evidence/test-coverage.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const read = (rel) => readFileSync(resolve(root, rel), 'utf8')
const DEV_DRIVERS = []
const BROWSER_SOURCES = [
  'src/client/contracts.ts',
  'src/client/inbox.tsx',
  'src/client/index.tsx',
  'src/client/list.tsx',
  'src/client/notice.tsx',
  'src/client/panel.tsx',
  'src/client/work-item/editor.tsx',
  'src/client/work-item/list.tsx',
  'src/client/work-item/panel.tsx',
]

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** A temp repository-shaped tree for the checker; no source code is executed. */
function tempProject() {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-coverage-check-'))
  const coverage = join(dir, 'coverage')
  const tools = join(dir, 'tools')
  const sources = join(dir, 'src')
  mkdirSync(coverage, { recursive: true })
  mkdirSync(tools, { recursive: true })
  mkdirSync(sources, { recursive: true })
  const paths = {
    map: join(tools, 'coverage-map.json'),
    debt: join(tools, 'coverage-debt.json'),
    browserFloors: join(tools, 'coverage-browser-floors.json'),
    unitReport: join(coverage, 'unit.lcov'),
    unitMeta: join(coverage, 'unit.json'),
    browserClient: join(coverage, 'client.json'),
    browserLcov: join(coverage, 'browser.lcov'),
  }
  const identity = { formatVersion: 1, resolved: { baseSha: 'base', headSha: 'abc' }, diff: { sha256: 'diff' }, porcelain: [] }
  const unitArtifact = { head: 'abc', dirty: false, gitStatus: [] }
  writeFileSync(join(sources, 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(sources, 'c.ts'), 'export interface C { read(): number }\n')
  writeFileSync(join(sources, 'd.ts'), 'export const d = 1\n')
  writeFileSync(join(sources, 'b.tsx'), 'export const b = 1\n')
  writeJson(paths.map, {
    version: 1,
    files: [
      { path: 'src/a.ts', lane: 'unit' },
      { path: 'src/b.tsx', lane: 'browser' },
      { path: 'src/c.ts', lane: 'unit' },
      { path: 'src/d.ts', lane: 'unit' },
    ],
  })
  writeFileSync(paths.unitReport, [
    'TN:',
    'SF:src/a.ts',
    'DA:1,1',
    'DA:2,0',
    'BRDA:1,0,0,1',
    'BRDA:1,0,1,0',
    'FN:1,a',
    'FNDA:1,a',
    'end_of_record',
    'SF:src/d.ts',
    'DA:1,1',
    'end_of_record',
    '',
  ].join('\n'))
  writeJson(paths.unitMeta, {
    formatVersion: 1,
    lane: 'unit',
    exitCode: 0,
    artifact: unitArtifact,
    gateArtifact: identity,
  })
  writeJson(paths.debt, {
    version: 1,
    files: [{
      path: 'src/a.ts',
      uncoveredLines: [2],
      lines: { total: 2, covered: 1 },
      branches: { total: 2, covered: 1 },
      functions: { total: 1, covered: 1 },
    }],
  })
  writeJson(paths.browserClient, {
    artifact: { head: 'abc', gateArtifact: identity },
    files: [{
      file: 'src/b.tsx',
      status: 'counted',
      executableLines: 2,
      executedLines: 2,
      lineCoverage: 100,
      coveredLines: [1, 2],
      uncoveredLines: [],
      sourceLines: 2,
      totalFunctions: 1,
      executedFunctions: 1,
      functionCoverage: 100,
    }],
    summary: [],
  })
  writeFileSync(paths.browserLcov, 'TN:\nSF:src/b.tsx\nDA:1,1\nDA:2,1\nend_of_record\n')
  return {
    dir,
    paths,
    identity,
    unitArtifact,
    sourceFiles: ['src/a.ts', 'src/b.tsx', 'src/c.ts', 'src/d.ts'],
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function check(project, options = {}) {
  return runCoverageCheck({
    cwd: project.dir,
    paths: project.paths,
    sourceFiles: project.sourceFiles,
    expectedTsx: ['src/b.tsx'],
    currentWorktree: project.unitArtifact,
    ...options,
  })
}

test('testFilesIn finds only .test.mjs below tests/, recursively', () => {
  const files = testFilesIn(resolve(root, 'tests'))
  assert.ok(files.length > 0)
  assert.deepEqual(files, [...files].sort())
  assert.ok(files.every((path) => path.endsWith('.test.mjs')))
  assert.ok(files.some((path) => path === join(root, 'tests', 'guards', 'coverage-policy.test.mjs')))
})

test('testFilesIn discovers a nested test and ignores support modules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-test-discovery-'))
  try {
    mkdirSync(join(dir, 'nested', 'deeper'), { recursive: true })
    writeFileSync(join(dir, 'top.test.mjs'), "import test from 'node:test'\n")
    writeFileSync(join(dir, 'nested', 'alpha.test.mjs'), "import test from 'node:test'\n")
    writeFileSync(join(dir, 'nested', 'deeper', 'beta.test.mjs'), "import test from 'node:test'\n")
    writeFileSync(join(dir, 'nested', 'helper.mjs'), 'export const helper = 1\n')
    assert.deepEqual(testFilesIn(dir), [
      join(dir, 'nested', 'alpha.test.mjs'),
      join(dir, 'nested', 'deeper', 'beta.test.mjs'),
      join(dir, 'top.test.mjs'),
    ].sort())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('npm test points at a recursive test glob, not one top-level level', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.scripts?.test, 'node --test "tests/**/*.test.mjs"')
  assert.doesNotMatch(pkg.scripts.test, /tests\/\*\.mjs/)
})

test('unit coverage args run one file with both reporters and an absolute report', () => {
  const args = unitCoverageArgs('/repo/tests/app/entry.test.mjs', '/repo/coverage/raw/a.lcov')
  assert.ok(args.includes('--experimental-test-coverage'))
  assert.ok(args.includes('--test-coverage-include=src/**/*.ts'))
  assert.ok(args.includes('--test-reporter=lcov'))
  assert.ok(args.includes('--test-reporter-destination=/repo/coverage/raw/a.lcov'))
  assert.ok(args.includes('--test-reporter=spec'))
  assert.equal(args.filter((entry) => entry === '--test').length, 1)
  assert.deepEqual(args.slice(-1), ['/repo/tests/app/entry.test.mjs'])
})

test('the owner map classifies every source file exactly once', () => {
  const sources = sourceFilesIn(root)
  const map = JSON.parse(read('tools/coverage-map.json'))
  const result = validateOwnershipMap(map, sources)
  assert.deepEqual(result.failures, [])
  assert.equal(sources.length, 90)
  const byLane = { unit: 0, browser: 0, dev: 0 }
  for (const entry of map.files) byLane[entry.lane] += 1
  assert.deepEqual(byLane, { unit: 81, browser: 9, dev: 0 })
  assert.deepEqual(
    map.files.filter((entry) => entry.lane === 'dev').map((entry) => entry.path).sort(),
    DEV_DRIVERS,
  )
  assert.deepEqual(
    map.files.filter((entry) => entry.lane === 'browser').map((entry) => entry.path).sort(),
    BROWSER_SOURCES,
  )
  for (const entry of map.files.filter((candidate) => candidate.lane === 'dev')) {
    assert.ok(entry.reason.trim().length > 0)
    assert.ok(entry.exitWhen.trim().length > 0)
  }
})

test('the owner map rejects missing, duplicate, unknown, and invalid dev entries', () => {
  const sources = ['src/a.ts', 'src/b.tsx']
  const base = { version: 1, files: [{ path: 'src/a.ts', lane: 'unit' }, { path: 'src/b.tsx', lane: 'browser' }] }
  const missing = validateOwnershipMap({ version: 1, files: [base.files[0]] }, sources)
  assert.ok(missing.failures.some((failure) => failure.includes('src/b.tsx: source file has no coverage owner')))
  const duplicate = validateOwnershipMap({ version: 1, files: [...base.files, base.files[0]] }, sources)
  assert.ok(duplicate.failures.some((failure) => failure.includes('duplicate owner entry')))
  const unknown = validateOwnershipMap({ version: 1, files: [base.files[0], { path: 'src/b.tsx', lane: 'host' }] }, sources)
  assert.ok(unknown.failures.some((failure) => failure.includes('lane must be one of')))
  const devOutside = validateOwnershipMap({
    version: 1,
    files: [base.files[0], { path: 'src/b.tsx', lane: 'dev', reason: 'x', exitWhen: 'y' }],
  }, sources)
  assert.ok(devOutside.failures.some((failure) => failure.includes('dev lane is only for src/dev/')))
  const devNoExit = validateOwnershipMap({
    version: 1,
    files: [base.files[0], { path: 'src/dev/x.ts', lane: 'dev', reason: 'x' }],
  }, ['src/a.ts', 'src/dev/x.ts'])
  assert.ok(devNoExit.failures.some((failure) => failure.includes('dev entry needs exitWhen')))
})

test('type-only detection follows type stripping, not a hand-written allowlist', () => {
  assert.equal(isTypeOnly(resolve(root, 'src/panel/api-types.ts')), true)
  assert.equal(isTypeOnly(resolve(root, 'src/panel/api.ts')), false)
  assert.equal(isTypeOnly(resolve(root, 'src/index.ts')), false)
})

test('every src TypeScript file is strip-compatible, so the loader keeps line numbers', () => {
  const files = sourceFilesIn(root).filter((path) => path.endsWith('.ts'))
  assert.ok(files.length > 0)
  for (const file of files) {
    assert.doesNotThrow(() => stripTypeScriptTypes(read(file)), `${file} needs the transform fallback`)
  }
})

test('LCOV merge is a union and render is deterministic', () => {
  const first = parseLcov([
    'TN:',
    'SF:src/a.ts',
    'FN:1,a',
    'FNDA:1,a',
    'DA:1,1',
    'DA:2,0',
    'BRDA:2,0,0,1',
    'BRDA:2,0,1,0',
    'end_of_record',
    '',
  ].join('\n'))
  const second = parseLcov([
    'TN:',
    'SF:src/a.ts',
    'FN:1,a',
    'FNDA:2,a',
    'DA:1,1',
    'DA:2,1',
    'BRDA:2,0,0,0',
    'BRDA:2,0,1,1',
    'end_of_record',
    '',
  ].join('\n'))
  const merged = mergeLcovRecords(first, second)
  const record = merged.get('src/a.ts')
  assert.deepEqual(lineTotals(record), { total: 2, covered: 2 })
  assert.deepEqual(branchTotals(record), { total: 2, covered: 2 })
  assert.deepEqual(functionTotals(record), { total: 1, covered: 1 })
  assert.deepEqual(uncoveredLines(record), [])
  assert.equal(renderLcov(merged), renderLcov(mergeLcovRecords(second, first)))
  assert.match(renderLcov(merged), /SF:src\/a\.ts\nFN:1,a\nFNDA:2,a\nFNF:1\nFNH:1\nBRDA:2,0,0,1\nBRDA:2,0,1,1\nBRF:2\nBRH:2\nDA:1,1\nDA:2,1\nLF:2\nLH:2\n/)
  assert.throws(() => parseLcov('DA:1,1\n'), /before SF/)
  assert.throws(() => parseLcov('TN:\nSF:a.ts\nDA:x,1\n'), /invalid LCOV DA/)
  assert.throws(() => parseLcov('TN:\nSF:a.ts\nend_of_record\nSF:a.ts\nend_of_record\n'), /duplicate record/)
})

test('a runtime source that no test loads fails instead of counting as 0%', () => {
  const project = tempProject()
  try {
    writeFileSync(project.paths.unitReport, [
      'TN:',
      'SF:src/a.ts',
      'DA:1,1',
      'DA:2,0',
      'end_of_record',
      '',
    ].join('\n'))
    const result = check(project)
    assert.ok(result.failures.some((failure) => failure.includes('src/d.ts: no runtime coverage recorded')))
    assert.ok(!result.failures.some((failure) => failure.includes('src/c.ts')))
  } finally {
    project.cleanup()
  }
})

test('the baseline ratchets line coverage and refuses an unlisted gap', () => {
  const project = tempProject()
  try {
    assert.deepEqual(check(project).failures, [])
    writeFileSync(project.paths.debt, JSON.stringify({ version: 1, files: [] }))
    assert.ok(check(project).failures.some((failure) => failure.includes('no baseline entry')))
    writeJson(project.paths.debt, {
      version: 1,
      files: [{
        path: 'src/a.ts',
        uncoveredLines: [],
        lines: { total: 2, covered: 2 },
        branches: { total: 2, covered: 2 },
        functions: { total: 1, covered: 1 },
      }],
    })
    assert.ok(check(project).failures.some((failure) => failure.includes('line coverage regressed')))
    writeJson(project.paths.debt, {
      version: 1,
      files: [{
        path: 'src/a.ts',
        uncoveredLines: [1, 2],
        lines: { total: 2, covered: 0 },
        branches: { total: 2, covered: 1 },
        functions: { total: 1, covered: 1 },
      }],
    })
    assert.ok(check(project).failures.some((failure) => failure.includes('line coverage improved')))
    writeJson(project.paths.debt, {
      version: 1,
      files: [{
        path: 'src/a.ts',
        uncoveredLines: [2],
        lines: { total: 2, covered: 1 },
        branches: { total: 2, covered: 2 },
        functions: { total: 1, covered: 2 },
      }],
    })
    const advisory = check(project)
    assert.deepEqual(advisory.failures, [], 'branch and function counts are recorded, not blocking')
  } finally {
    project.cleanup()
  }
})

test('updateDebt writes the reviewed baseline from the unit report', () => {
  const project = tempProject()
  try {
    rmSync(project.paths.debt, { force: true })
    const result = check(project, { updateDebt: true })
    assert.deepEqual(result.failures, [])
    const baseline = JSON.parse(readFileSync(project.paths.debt, 'utf8'))
    // `src/d.ts` is at 100%, so it needs no baseline entry; only the module
    // with uncovered lines is recorded.
    assert.deepEqual(baseline.files.map((entry) => entry.path), ['src/a.ts'])
    assert.deepEqual(baseline.files[0].uncoveredLines, [2])
    assert.equal(baseline.files[0].branches.covered, 1)
  } finally {
    project.cleanup()
  }
})

test('the layered check requires the browser lane, completeness, and one artifact identity', () => {
  const project = tempProject()
  try {
    const base = check(project, {
      requireBrowser: true,
      expectedArtifact: project.identity,
    })
    assert.deepEqual(base.failures, [])
    assert.equal(base.browser?.floors, 'observational')

    const missingLcov = tempProject()
    try {
      rmSync(missingLcov.paths.browserLcov, { force: true })
      const result = check(missingLcov, { requireBrowser: true, expectedArtifact: missingLcov.identity })
      assert.ok(result.failures.some((failure) => failure.includes('browser.lcov is missing')))
    } finally {
      missingLcov.cleanup()
    }

    const changed = { ...project.identity, diff: { sha256: 'other' } }
    const mismatch = check(project, { requireBrowser: true, expectedArtifact: changed })
    assert.ok(mismatch.failures.some((failure) => failure.includes('unit lane artifact identity does not match')))
    assert.ok(mismatch.failures.some((failure) => failure.includes('browser lane artifact identity does not match')))
  } finally {
    project.cleanup()
  }
})

test('browser line data must stay inside the mapped source', () => {
  const project = tempProject()
  try {
    const client = JSON.parse(readFileSync(project.paths.browserClient, 'utf8'))
    client.files[0] = {
      ...client.files[0],
      coveredLines: [1],
      uncoveredLines: [],
      executableLines: 2,
      sourceLines: 10,
    }
    writeJson(project.paths.browserClient, client)
    assert.ok(check(project, { requireBrowser: true, expectedArtifact: project.identity }).failures
      .some((failure) => failure.includes('do not add up')))
    client.files[0] = { ...client.files[0], coveredLines: [1, 12], uncoveredLines: [], executableLines: 2 }
    writeJson(project.paths.browserClient, client)
    assert.ok(check(project, { requireBrowser: true, expectedArtifact: project.identity }).failures
      .some((failure) => failure.includes('maps lines outside 1..10')))
    client.files[0] = { ...client.files[0], coveredLines: [1], uncoveredLines: [2], executableLines: 2 }
    writeJson(project.paths.browserClient, client)
    writeFileSync(project.paths.browserLcov, 'TN:\nSF:src/b.tsx\nDA:1,0\nDA:2,1\nend_of_record\n')
    assert.ok(check(project, { requireBrowser: true, expectedArtifact: project.identity }).failures
      .some((failure) => failure.includes('disagree on covered lines')))
    delete client.files[0].coveredLines
    writeJson(project.paths.browserClient, client)
    assert.ok(check(project, { requireBrowser: true, expectedArtifact: project.identity }).failures
      .some((failure) => failure.includes('no line arrays')))
  } finally {
    project.cleanup()
  }
})

test('a failing test file leaves no stale merged report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-coverage-fail-'))
  try {
    const failing = join(dir, 'failing.test.mjs')
    writeFileSync(failing, "import test from 'node:test'\ntest('boom', () => { throw new Error('boom') })\n")
    const output = join(dir, 'out')
    mkdirSync(join(output, 'unit-raw'), { recursive: true })
    writeFileSync(join(output, 'unit.lcov'), 'TN:\nSF:src/stale.ts\nDA:1,1\nend_of_record\n')
    assert.throws(
      () => runUnitCoverage({ testFiles: [failing], outputDir: output, log: () => {} }),
      /unit coverage failed/,
    )
    assert.equal(existsSync(join(output, 'unit.lcov')), false, 'the stale merged report must be removed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a test process that writes no report fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-coverage-noreport-'))
  try {
    const passing = join(dir, 'passing.test.mjs')
    writeFileSync(passing, "import test from 'node:test'\ntest('passes', () => {})\n")
    const output = join(dir, 'out')
    assert.throws(
      () => runUnitCoverage({
        testFiles: [passing],
        outputDir: output,
        log: () => {},
        argsFor: () => ['--test', passing],
      }),
      /wrote no LCOV report/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a report from another worktree is stale', () => {
  const project = tempProject()
  try {
    const stale = { ...project.unitArtifact, head: 'other' }
    assert.ok(check(project, { currentWorktree: stale }).failures
      .some((failure) => failure.includes('coverage report is stale')))
  } finally {
    project.cleanup()
  }
})

test('update-debt refuses newly uncovered lines without an explicit acceptance', () => {
  const project = tempProject()
  try {
    writeJson(project.paths.debt, {
      version: 1,
      files: [{
        path: 'src/a.ts',
        uncoveredLines: [],
        lines: { total: 2, covered: 2 },
        branches: { total: 2, covered: 1 },
        functions: { total: 1, covered: 1 },
      }],
    })
    const rejected = check(project, { updateDebt: true })
    assert.ok(rejected.failures.some((failure) => failure.includes('update-debt would add uncovered lines')))
    const kept = JSON.parse(readFileSync(project.paths.debt, 'utf8'))
    assert.deepEqual(kept.files.find((entry) => entry.path === 'src/a.ts').uncoveredLines, [])
    const accepted = check(project, { updateDebt: true, acceptRegression: true })
    assert.deepEqual(accepted.failures, [])
    const written = JSON.parse(readFileSync(project.paths.debt, 'utf8'))
    assert.deepEqual(written.files.find((entry) => entry.path === 'src/a.ts').uncoveredLines, [2])
  } finally {
    project.cleanup()
  }
})

test('a malformed or stale baseline is reported, not a crash', () => {
  const project = tempProject()
  try {
    writeJson(project.paths.debt, { version: 1, files: {} })
    assert.ok(check(project).failures.some((failure) => failure.includes('files array')))
    writeJson(project.paths.debt, { version: 99, files: [] })
    assert.ok(check(project).failures.some((failure) => failure.includes('version 1 and a files array')))
    writeJson(project.paths.debt, {
      version: 1,
      files: [
        { path: 'src/a.ts', uncoveredLines: [2] },
        { path: 'src/a.ts', uncoveredLines: [2] },
      ],
    })
    assert.ok(check(project).failures.some((failure) => failure.includes('duplicate baseline entry')))
    writeJson(project.paths.debt, {
      version: 1,
      files: [{ path: 'src/missing.ts', uncoveredLines: [] }],
    })
    assert.ok(check(project).failures.some((failure) => failure.includes('names no unit source file')))
  } finally {
    project.cleanup()
  }
})

test('a browser-owned file cannot invent a blocked status', () => {
  const project = tempProject()
  try {
    const client = JSON.parse(readFileSync(project.paths.browserClient, 'utf8'))
    client.files[0] = { ...client.files[0], status: 'blocked', blockedReason: 'invented' }
    writeJson(project.paths.browserClient, client)
    assert.ok(check(project, { requireBrowser: true, expectedArtifact: project.identity }).failures
      .some((failure) => failure.includes('not a known blocked surface')))
  } finally {
    project.cleanup()
  }
})

test('the reviewed browser floors cover every non-blocked browser-owned file', () => {
  const floors = JSON.parse(read('tools/coverage-browser-floors.json'))
  const map = JSON.parse(read('tools/coverage-map.json'))
  assert.equal(floors.version, 1)
  const browserOwned = map.files.filter((entry) => entry.lane === 'browser').map((entry) => entry.path)
  const expected = browserOwned.filter((file) => CLIENT_BROWSER_BLOCKED[file] === undefined).sort()
  assert.deepEqual(Object.keys(floors.files).sort(), expected, 'every non-blocked browser-owned file needs a floor')
  for (const [file, floor] of Object.entries(floors.files)) {
    assert.deepEqual(Object.keys(floor).sort(), ['functionCoverage', 'lineCoverage'], `${file} floor may only carry line and function values`)
    for (const [key, value] of Object.entries(floor)) {
      assert.ok(Number.isFinite(value) && value >= 0 && value <= 100, `${file}.${key} must be a number in 0..100`)
    }
  }
})

test('browser floors apply only when the reviewed file exists', () => {
  const project = tempProject()
  try {
    assert.deepEqual(check(project, { requireBrowser: true, expectedArtifact: project.identity }).failures, [])
    writeFileSync(project.paths.browserFloors, JSON.stringify({
      version: 1,
      files: { 'src/b.tsx': { lineCoverage: 100, functionCoverage: 100 } },
    }))
    assert.deepEqual(check(project, { requireBrowser: true, expectedArtifact: project.identity }).failures, [])
    writeFileSync(project.paths.browserFloors, JSON.stringify({
      version: 1,
      files: { 'src/b.tsx': { lineCoverage: 101 } },
    }))
    assert.ok(check(project, { requireBrowser: true, expectedArtifact: project.identity }).failures
      .some((failure) => failure.includes('must be a number in 0..100')))
    writeFileSync(project.paths.browserFloors, JSON.stringify({
      version: 1,
      files: { 'src/b.tsx': { lineCoverage: '100' } },
    }))
    assert.ok(check(project, { requireBrowser: true, expectedArtifact: project.identity }).failures
      .some((failure) => failure.includes('must be a number in 0..100')))
    writeFileSync(project.paths.browserFloors, JSON.stringify({
      version: 1,
      files: { 'src/not-owned.tsx': { lineCoverage: 100 } },
    }))
    assert.ok(check(project, { requireBrowser: true, expectedArtifact: project.identity }).failures
      .some((failure) => failure.includes('names no browser source file')))
    writeFileSync(project.paths.browserFloors, JSON.stringify({ version: 1, files: {} }))
    assert.ok(check(project, { requireBrowser: true, expectedArtifact: project.identity }).failures
      .some((failure) => failure.includes('reviewed browser floors are missing src/b.tsx')))
    writeFileSync(project.paths.browserFloors, JSON.stringify({
      version: 1,
      files: { 'src/b.tsx': { lineCoverage: 100 } },
    }))
    const client = JSON.parse(readFileSync(project.paths.browserClient, 'utf8'))
    client.files[0] = { ...client.files[0], lineCoverage: 99 }
    writeJson(project.paths.browserClient, client)
    assert.ok(check(project, { requireBrowser: true, expectedArtifact: project.identity }).failures
      .some((failure) => failure.includes('line 99% < 100%')))
  } finally {
    project.cleanup()
  }
})

/** One TS fixture with a line that always runs and a body that never does. */
function mappingFixture(dir) {
  const fixture = join(dir, 'fixture.ts')
  writeFileSync(fixture, [
    '// one',
    'export const value = 41',
    'export function used(n: number): number {',
    '  return n + value - 40',
    '}',
    'export function unused(): number {',
    '  return 99',
    '}',
    'export const executed = used(1)',
    '',
  ].join('\n'))
  return { fixture }
}

function runFixtureCoverage(hookPath, dir) {
  const report = join(dir, `report-${Date.now()}.lcov`)
  const relativeFixture = relative(root, join(dir, 'fixture.ts'))
  mkdirSync(dir, { recursive: true })
  const testFile = join(dir, `run-${basenameOf(hookPath)}.test.mjs`)
  writeFileSync(testFile, [
    "import test from 'node:test'",
    "test('loads', async () => {",
    `  await import(${JSON.stringify(`file://${hookPath}`)})`,
    "  const m = await import('./fixture.ts')",
    "  if (m.executed !== 2) throw new Error('bad fixture')",
    '})',
    '',
  ].join('\n'))
  const result = spawnSync(process.execPath, [
    '--experimental-test-coverage',
    `--test-coverage-include=${relativeFixture}`,
    '--test-reporter=lcov',
    `--test-reporter-destination=${report}`,
    '--test',
    testFile,
  ], { cwd: root, encoding: 'utf8', timeout: 30_000, env: childTestEnvironment(process.env) })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const records = parseLcov(readFileSync(report, 'utf8'))
  return [...records.values()][0]
}

function basenameOf(path) {
  return path.split('/').pop().replaceAll('.', '-')
}

test('the real hook maps executed and unexecuted lines exactly; a transform-only hook does not', () => {
  mkdirSync(join(root, 'coverage'), { recursive: true })
  const dir = mkdtempSync(join(root, 'coverage', 'mapping-probe-'))
  try {
    mappingFixture(dir)
    const mapped = runFixtureCoverage(resolve(root, 'tests/support/ts-hook.mjs'), dir)
    assert.equal(mapped.lines.get(4), 1, 'the called function body is covered')
    assert.equal(mapped.lines.get(7), 0, 'the uncalled function body is not covered')
    assert.equal(mapped.lines.get(8), 0, 'the uncalled function closing line is not covered')
    assert.equal(mapped.lines.get(9), 1, 'the executed assignment is covered')

    const noMapHook = join(dir, 'transform-hook.mjs')
    writeFileSync(noMapHook, [
      "import { register } from 'node:module'",
      "register('data:text/javascript,' + encodeURIComponent(`",
      "import { readFileSync } from 'node:fs'",
      "import { stripTypeScriptTypes } from 'node:module'",
      "import { fileURLToPath } from 'node:url'",
      'export async function load(url, context, nextLoad) {',
      "  if (url.startsWith('file:') && url.endsWith('.ts')) {",
      "    const source = readFileSync(fileURLToPath(url), 'utf8')",
      "    return { format: 'module', shortCircuit: true, source: stripTypeScriptTypes(source, { mode: 'transform' }) }",
      '  }',
      '  return nextLoad(url, context)',
      '}',
      '`))',
      '',
    ].join('\n'))
    const noMap = runFixtureCoverage(noMapHook, dir)
    assert.ok(noMap.lines.get(7) > 0, 'transform-only loading misattributes the uncalled line')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the unit collector produces an identical merged report twice', () => {
  const files = [
    resolve(root, 'tests/app/entry.test.mjs'),
    resolve(root, 'tests/domains/topic/handoff.test.mjs'),
  ]
  const first = mkdtempSync(join(tmpdir(), 'cowork-coverage-first-'))
  const second = mkdtempSync(join(tmpdir(), 'cowork-coverage-second-'))
  try {
    const left = runUnitCoverage({ testFiles: files, outputDir: first, log: () => {} })
    const right = runUnitCoverage({ testFiles: files, outputDir: second, log: () => {} })
    const normalized = (path) => {
      const records = parseLcov(readFileSync(path, 'utf8'))
      const result = {}
      for (const [file, record] of records) {
        result[file] = {
          covered: [...record.lines].filter(([, count]) => count > 0).map(([line]) => line).sort(),
          uncovered: uncoveredLines(record),
        }
      }
      return result
    }
    assert.deepEqual(normalized(left.reportPath), normalized(right.reportPath))
    assert.ok(left.meta.modules > 0)
  } finally {
    rmSync(first, { recursive: true, force: true })
    rmSync(second, { recursive: true, force: true })
  }
})
