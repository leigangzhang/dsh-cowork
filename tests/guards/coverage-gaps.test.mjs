import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  browserFloorFileProblems,
  changedFileGaps,
  changedSurfaceKeys,
  collectCoverageGaps,
  coverageContractProblems,
  formatCoverageGaps,
  missingManifestCovers,
  reportsMatchArtifact,
} from '../../tools/coverage-gaps.mjs'

const artifact = {
  formatVersion: 1,
  resolved: { baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40) },
  diff: { sha256: 'c'.repeat(64) },
  porcelain: [],
  scope: {},
}

function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), 'cowork-coverage-gaps-'))
  mkdirSync(join(root, 'coverage'), { recursive: true })
  mkdirSync(join(root, 'tests', 'e2e'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function writeReusableReports(root, identity) {
  writeJson(join(root, 'coverage', 'layered.json'), { artifact: identity, ok: true })
  writeJson(join(root, 'coverage', 'unit.json'), { gateArtifact: identity })
  writeJson(join(root, 'coverage', 'client.json'), { artifact: { gateArtifact: identity } })
  writeFileSync(join(root, 'coverage', 'unit.lcov'), [
    'TN:',
    'SF:src/a.ts',
    'DA:1,1',
    'DA:2,0',
    'end_of_record',
    '',
  ].join('\n'))
  writeFileSync(join(root, 'coverage', 'browser.lcov'), 'TN:\n')
}

test('the static browser floor contract accepts complete floors and rejects every gap shape', () => {
  const byPath = new Map([
    ['src/client/a.tsx', { lane: 'browser' }],
    ['src/client/blocked.tsx', { lane: 'browser' }],
    ['src/client/model.ts', { lane: 'unit' }],
  ])
  const blocked = { 'src/client/blocked.tsx': { reason: 'host capability missing' } }
  const complete = {
    version: 1,
    files: {
      'src/client/a.tsx': { lineCoverage: 100, functionCoverage: 90 },
    },
  }
  assert.deepEqual(browserFloorFileProblems(complete, byPath, { blocked }).failures, [])

  const missing = browserFloorFileProblems({ version: 1, files: {} }, byPath, { blocked })
  assert.ok(missing.failures.some((failure) => failure.includes('reviewed browser floors are missing src/client/a.tsx')))
  assert.equal(missing.failures.some((failure) => failure.includes('blocked.tsx')), false)

  const malformed = browserFloorFileProblems({
    version: 1,
    files: {
      'src/client/a.tsx': { lineCoverage: 101, extra: true },
      'src/client/model.ts': { lineCoverage: 100 },
    },
  }, byPath, { blocked })
  assert.ok(malformed.failures.some((failure) => failure.includes('floor src/client/a.tsx.lineCoverage must be a number in 0..100')))
  assert.ok(malformed.failures.some((failure) => failure.includes('floor for src/client/a.tsx has unknown key extra')))
  assert.ok(malformed.failures.some((failure) => failure.includes('floor names no browser source file: src/client/model.ts')))
})

test('the real repository passes the static coverage contract', () => {
  assert.deepEqual(coverageContractProblems(resolve(import.meta.dirname, '../..')), [])
})

test('changed-file gaps union declared lanes, name missing records, and skip type-only files', () => {
  const project = tempRepo()
  try {
    writeFileSync(join(project.root, 'src', 'a.ts'), 'export const a = 1\nexport const b = 2\n')
    writeFileSync(join(project.root, 'src', 'type-only.ts'), 'export interface Shape { read(): number }\n')
    const unitRecords = new Map([
      ['src/a.ts', { lines: new Map([[1, 1], [2, 0], [5, 0]]) }],
    ])
    const browserRecords = new Map([
      ['src/a.ts', { lines: new Map([[5, 0], [6, 1]]) }],
    ])
    const gaps = changedFileGaps({
      cwd: project.root,
      changedPaths: ['src/a.ts', 'src/type-only.ts', 'src/missing.tsx', 'docs/testing.md'],
      unitRecords,
      browserRecords,
    })
    assert.deepEqual(gaps, [
      { file: 'src/a.ts', hasRecord: true, lines: [2, 5] },
      { file: 'src/missing.tsx', hasRecord: false, lines: [] },
    ])
  } finally {
    project.cleanup()
  }
})

test('report reuse requires the exact gate-artifact identity and both LCOV files', () => {
  const project = tempRepo()
  try {
    writeReusableReports(project.root, artifact)
    assert.equal(reportsMatchArtifact({ cwd: project.root, artifact }), true)
    assert.equal(reportsMatchArtifact({
      cwd: project.root,
      artifact: { ...artifact, porcelain: ['?? src/a.ts'] },
    }), false)
    rmSync(join(project.root, 'coverage', 'browser.lcov'))
    assert.equal(reportsMatchArtifact({ cwd: project.root, artifact }), false)
  } finally {
    project.cleanup()
  }
})

test('the gap report reuses matching reports, prints both lists, and only runs the lane when identity changes', async () => {
  const project = tempRepo()
  try {
    writeFileSync(join(project.root, 'src', 'a.ts'), 'export const a = 1\nexport const b = 2\n')
    writeReusableReports(project.root, artifact)
    writeJson(join(project.root, 'tests', 'e2e', 'manifest.json'), {
      scenarios: [{ id: 'covered', mode: 'keyless', covers: ['tool:covered'] }],
    })
    let runs = 0
    const reused = await collectCoverageGaps({
      base: 'main',
      cwd: project.root,
      artifact,
      changedPaths: ['src/a.ts'],
      surfaceKeys: ['tool:covered', 'tool:missing'],
      runLayered: () => {
        runs += 1
        return { status: 0 }
      },
    })
    assert.equal(runs, 0)
    assert.equal(reused.reused, true)
    assert.equal(reused.exitCode, 0)
    assert.equal(reused.coverageOk, true)
    assert.deepEqual(reused.fileGaps, [{ file: 'src/a.ts', hasRecord: true, lines: [2] }])
    assert.deepEqual(reused.missingSurfaces, ['tool:missing'])
    const rendered = formatCoverageGaps(reused)
    assert.match(rendered, /reused existing reports/)
    assert.match(rendered, /src\/a\.ts: 2/)
    assert.match(rendered, /tool:missing/)

    const changedIdentity = { ...artifact, porcelain: ['?? src/a.ts'] }
    const fresh = await collectCoverageGaps({
      base: 'main',
      cwd: project.root,
      artifact: changedIdentity,
      changedPaths: ['src/a.ts'],
      surfaceKeys: ['tool:covered'],
      runLayered: () => {
        runs += 1
        return { status: 0 }
      },
    })
    assert.equal(runs, 1)
    assert.equal(fresh.reused, false)
  } finally {
    project.cleanup()
  }
})

test('manifest coverage is a set-membership check over every scenario mode', () => {
  const manifest = {
    scenarios: [
      { mode: 'keyless', covers: ['tool:a'] },
      { mode: 'live-model', covers: ['tool:b'] },
    ],
  }
  assert.deepEqual(missingManifestCovers(manifest, ['tool:a', 'tool:b', 'tool:c']), ['tool:c'])
})

test('a changed tool owner maps to its public surface key', async () => {
  const keys = await changedSurfaceKeys(['src/tools/route.ts'])
  assert.ok(keys.includes('tool:cowork_route'))
})
