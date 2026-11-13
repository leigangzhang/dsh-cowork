import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUILD_INFO_FILE,
  buildInfoFor,
  buildInfoProblem,
} from '../scripts/lib-build-info.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('the committed lib build-info matches the current src', () => {
  assert.equal(buildInfoProblem(root), null)
})

test('a missing build-info fails closed', () => {
  const temp = mkdtempSync(join(tmpdir(), 'cowork-lib-sync-missing-'))
  try {
    writeFileSync(join(temp, 'package.json'), '{"version":"0.0.1"}\n')
    mkdirSync(join(temp, 'src'))
    writeFileSync(join(temp, 'src', 'index.ts'), 'export const x = 1\n')
    assert.match(String(buildInfoProblem(temp)), /cannot read/)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('editing src without rebuilding fails with a sourceHash drift', () => {
  const temp = mkdtempSync(join(tmpdir(), 'cowork-lib-sync-drift-'))
  try {
    writeFileSync(join(temp, 'package.json'), '{"version":"0.0.1"}\n')
    mkdirSync(join(temp, 'src', 'client'), { recursive: true })
    writeFileSync(join(temp, 'src', 'index.ts'), 'export const x = 1\n')
    writeFileSync(join(temp, 'src', 'client', 'view.tsx'), 'export const View = () => null\n')
    mkdirSync(join(temp, 'lib'), { recursive: true })
    writeFileSync(join(temp, BUILD_INFO_FILE), `${JSON.stringify(buildInfoFor(temp), null, 2)}\n`)
    assert.equal(buildInfoProblem(temp), null)
    writeFileSync(join(temp, 'src', 'index.ts'), 'export const x = 2\n')
    assert.match(String(buildInfoProblem(temp)), /sourceHash does not match/)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('changing package.json version without rebuilding fails', () => {
  const temp = mkdtempSync(join(tmpdir(), 'cowork-lib-sync-version-'))
  try {
    writeFileSync(join(temp, 'package.json'), '{"version":"0.0.1"}\n')
    mkdirSync(join(temp, 'src'))
    writeFileSync(join(temp, 'src', 'index.ts'), 'export const x = 1\n')
    mkdirSync(join(temp, 'lib'), { recursive: true })
    writeFileSync(join(temp, BUILD_INFO_FILE), `${JSON.stringify(buildInfoFor(temp), null, 2)}\n`)
    writeFileSync(join(temp, 'package.json'), '{"version":"0.0.2"}\n')
    assert.match(String(buildInfoProblem(temp)), /package is 0\.0\.2/)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
