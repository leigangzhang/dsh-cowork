#!/usr/bin/env node
/**
 * Coverage gate for the host half.
 *
 * The repository uses node:test, and Node 22 already ships coverage. Keep the
 * policy in named constants so the floor and the dev-only exclusions are
 * reviewable in one place instead of being buried in a package.json string.
 *
 * Scope: TypeScript files under src/ (the include pattern lives in
 * coverageArgs). The five client TSX components are browser-rendered surfaces;
 * Node tests cannot execute them honestly, so they need a browser lane rather
 * than a coverage number here.
 */
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/** Global floors, set below the observed 2026-11-13 host baseline. */
export const COVERAGE_FLOORS = Object.freeze({
  lines: 65,
  branches: 82,
  functions: 80,
})

/**
 * Dev-only probe and E2E drivers. They are shipped in the bundle behind
 * enableDevRoutes, but their live branches execute only against a real host;
 * the ordinary unit suite pins their pure contracts separately.
 */
export const DEV_ONLY_COVERAGE_EXCLUDES = Object.freeze([
  'src/m2-e2e.ts',
  'src/m2-e2e-support.ts',
  'src/m3-e2e.ts',
  'src/m3-e2e-support.ts',
  'src/m12-e2e.ts',
  'src/m12-e2e-support.ts',
  'src/s0-probe.ts',
  'src/probe-engine.ts',
  'src/probe-store.ts',
  'src/panel-probe.ts',
])

/** Build the node argv without relying on shell glob expansion. */
export function coverageArgs(testFiles) {
  return [
    '--experimental-test-coverage',
    '--test-coverage-include=src/**/*.ts',
    ...DEV_ONLY_COVERAGE_EXCLUDES.map((path) => `--test-coverage-exclude=${path}`),
    `--test-coverage-lines=${COVERAGE_FLOORS.lines}`,
    `--test-coverage-branches=${COVERAGE_FLOORS.branches}`,
    `--test-coverage-functions=${COVERAGE_FLOORS.functions}`,
    '--test',
    ...testFiles,
  ]
}

/** Test files are passed explicitly so a shell cannot silently drop one. */
export function testFilesIn(directory) {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.mjs'))
    .sort()
    .map((name) => join(directory, name))
}

function main() {
  const args = coverageArgs(testFilesIn(join(root, 'tests')))
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  process.exit(result.status ?? 1)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
