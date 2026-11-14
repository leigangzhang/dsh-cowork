import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COVERAGE_FLOORS,
  DEV_ONLY_COVERAGE_EXCLUDES,
  coverageArgs,
  testFilesIn,
} from '../scripts/test-coverage.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

test('coverage floors are the reviewed 2026-11-13 baseline', () => {
  assert.deepEqual(COVERAGE_FLOORS, { lines: 65, branches: 82, functions: 80 })
})

test('coverage exclusions are explicit, existing dev-only drivers', () => {
  assert.deepEqual(DEV_ONLY_COVERAGE_EXCLUDES, [
    'src/m12-e2e.ts',
    'src/m12-e2e-contract.ts',
    'src/m12-e2e-evidence.ts',
    'src/m12-e2e-prompts.ts',
    'src/m12-e2e-driver.ts',
    'src/m12-e2e-support.ts',
    'src/panel-probe.ts',
  ])
  for (const path of DEV_ONLY_COVERAGE_EXCLUDES) {
    assert.ok(existsSync(resolve(root, path)), `${path} must exist`)
    assert.match(path, /(?:e2e|probe)/, `${path} is not a dev-only driver`)
  }
})

test('coverage args carry the include, every exclusion, and every floor', () => {
  const args = coverageArgs(['/tmp/a.test.mjs', '/tmp/b.test.mjs'])
  assert.ok(args.includes('--experimental-test-coverage'))
  assert.ok(args.includes('--test-coverage-include=src/**/*.ts'))
  for (const path of DEV_ONLY_COVERAGE_EXCLUDES) {
    assert.ok(args.includes(`--test-coverage-exclude=${path}`), `missing exclusion for ${path}`)
  }
  assert.ok(args.includes('--test-coverage-lines=65'))
  assert.ok(args.includes('--test-coverage-branches=82'))
  assert.ok(args.includes('--test-coverage-functions=80'))
  assert.equal(args.filter((entry) => entry === '--test').length, 1)
  assert.deepEqual(args.slice(-2), ['/tmp/a.test.mjs', '/tmp/b.test.mjs'])
})

test('testFilesIn finds only .test.mjs below tests/, recursively', () => {
  const files = testFilesIn(resolve(root, 'tests'))
  assert.ok(files.length > 0)
  assert.deepEqual(files, [...files].sort())
  assert.ok(files.every((path) => path.endsWith('.test.mjs')))
  // The suite is flat today; this assertion is what makes a future move into a
  // subdirectory visible instead of silently dropping the file.
  assert.ok(files.some((path) => path === join(root, 'tests', 'source-budget.test.mjs')))
})

test('testFilesIn discovers a nested test and ignores non-test modules in its directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-test-discovery-'))
  try {
    mkdirSync(join(dir, 'nested', 'deeper'), { recursive: true })
    writeFileSync(join(dir, 'top.test.mjs'), "import test from 'node:test'\n")
    writeFileSync(join(dir, 'nested', 'alpha.test.mjs'), "import test from 'node:test'\n")
    writeFileSync(join(dir, 'nested', 'deeper', 'beta.test.mjs'), "import test from 'node:test'\n")
    writeFileSync(join(dir, 'nested', 'helper.mjs'), 'export const helper = 1\n')
    writeFileSync(join(dir, 'nested', 'support.mjs'), 'export const support = 1\n')

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
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts?.test, 'node --test "tests/**/*.test.mjs"')
  // Node expands the quoted glob itself; a shell-expanded `tests/*.mjs` stops at
  // the first level, and a test placed in tests/<subdir>/ would silently not run.
  assert.doesNotMatch(pkg.scripts.test, /tests\/\*\.mjs/)
})

test('the coverage floor mechanism can fail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-coverage-gate-'))
  try {
    writeFileSync(join(dir, 'probe.mjs'), [
      'export function covered() { return 1 }',
      'export function uncovered() {',
      '  return 2',
      '}',
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'probe.test.mjs'), [
      "import test from 'node:test'",
      "import assert from 'node:assert/strict'",
      "import { covered } from './probe.mjs'",
      '',
      "test('covers only one export', () => assert.equal(covered(), 1))",
      '',
    ].join('\n'))
    const result = spawnSync(process.execPath, [
      '--experimental-test-coverage',
      '--test-coverage-include=probe.mjs',
      '--test-coverage-functions=100',
      '--test',
      'probe.test.mjs',
    ], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30_000,
      // node:test exports a child context; a nested runner must start fresh.
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_'))),
    })
    assert.notEqual(
      result.status,
      0,
      `an uncovered function must fail the 100% floor (status=${String(result.status)}, signal=${String(result.signal)})\n${result.stdout}\n${result.stderr}`,
    )
    assert.match(`${result.stdout}\n${result.stderr}`, /coverage/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
