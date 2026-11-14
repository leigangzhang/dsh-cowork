import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `noUnusedLocals`/`noUnusedParameters` are the executable half of the dead
 * code rule. This test pins both halves: the repository configs keep the flags,
 * and the compiler actually rejects an unused local and parameter when they are
 * on. A negative control that only reads the config could pass while the flags
 * are misspelled, so the compiler runs for real against a temporary file.
 */
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')

/**
 * A local `npm install` puts the compiler in `node_modules/typescript`; a
 * linked development checkout may instead expose it through `.bin/tsc`. Both
 * entry points are executable scripts, so they are spawned directly.
 */
const TSC_CANDIDATES = [
  resolve(root, 'node_modules/typescript/bin/tsc'),
  resolve(root, 'node_modules/.bin/tsc'),
]
const tsc = TSC_CANDIDATES.find((candidate) => existsSync(candidate))
const COMPILER_FLAGS = [
  '--noEmit',
  '--strict',
  '--noUnusedLocals',
  '--noUnusedParameters',
  '--target',
  'ES2023',
  '--module',
  'ESNext',
  '--moduleResolution',
  'Bundler',
  '--skipLibCheck',
]

function compile(directory, file) {
  if (tsc === undefined) throw new Error('no tsc entry point found; install dependencies before this test')
  return spawnSync(tsc, [...COMPILER_FLAGS, file], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 120_000,
  })
}

test('both TypeScript configs keep the noUnused flags', () => {
  for (const file of ['tsconfig.json', 'tsconfig.client.json']) {
    const config = JSON.parse(readFileSync(resolve(root, file), 'utf8'))
    assert.equal(config.compilerOptions?.noUnusedLocals, true, `${file} must enable noUnusedLocals`)
    assert.equal(config.compilerOptions?.noUnusedParameters, true, `${file} must enable noUnusedParameters`)
  }
})

test('the compiler rejects an unused local and an unused parameter', () => {
  assert.ok(tsc !== undefined, 'no tsc entry point found; run npm install before the typecheck policy test')
  const directory = mkdtempSync(join(tmpdir(), 'cowork-typecheck-policy-'))
  try {
    writeFileSync(join(directory, 'unused.ts'), [
      'const unusedLocal = 1',
      'export function keep(unusedParameter: number): number {',
      '  return 2',
      '}',
      '',
    ].join('\n'))
    const result = compile(directory, 'unused.ts')
    assert.notEqual(result.status, 0, 'tsc accepted a file with an unused local and parameter')
    assert.match(`${result.stdout}\n${result.stderr}`, /never read|never used/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the compiler accepts a clean file under the same flags', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cowork-typecheck-policy-clean-'))
  try {
    writeFileSync(join(directory, 'clean.ts'), [
      'export function keep(value: number): number {',
      '  return value',
      '}',
      '',
    ].join('\n'))
    const result = compile(directory, 'clean.ts')
    assert.equal(result.status, 0, `tsc rejected clean source\n${result.stdout}\n${result.stderr}`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
