import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fallowGateProblems, pinnedFallowVersion } from '../../scripts/ci/fallow-gate.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const base = 'a'.repeat(40)
const head = 'b'.repeat(40)

function audit(overrides = {}) {
  return {
    kind: 'audit',
    version: '3.43.0',
    base_ref: base,
    head_sha: head,
    attribution: { complexity_introduced: 0, complexity_worsened: 0 },
    ...overrides,
  }
}

test('fallow gate accepts a clean audit report for the compared commit range', () => {
  assert.deepEqual(fallowGateProblems(audit(), {
    expectBase: base,
    expectHead: head,
    expectVersion: '3.43.0',
  }), [])
})

test('fallow gate rejects introduced and worsened complexity counters', () => {
  const problems = fallowGateProblems(audit({
    attribution: { complexity_introduced: 2, complexity_worsened: 1 },
  }))
  assert.match(problems.join('\n'), /complexity_introduced is 2, expected 0/)
  assert.match(problems.join('\n'), /complexity_worsened is 1, expected 0/)
})

test('fallow gate rejects a report that is not a complete audit', () => {
  assert.match(fallowGateProblems(null).join('\n'), /not a JSON object/)
  assert.match(fallowGateProblems(audit({ kind: 'health' })).join('\n'), /unexpected report kind: health/)
  assert.match(fallowGateProblems(audit({ attribution: undefined })).join('\n'), /no attribution counters/)
})

test('fallow gate accepts the abbreviated head sha that fallow reports', () => {
  assert.deepEqual(fallowGateProblems(audit({ head_sha: head.slice(0, 7) }), {
    expectHead: head,
  }), [])
  assert.match(
    fallowGateProblems(audit({ head_sha: 'f'.repeat(7) }), { expectHead: head }).join('\n'),
    /head f+ does not match the compared head/,
  )
})

test('fallow gate binds the report to its base, head, and CLI version', () => {
  const problems = fallowGateProblems(audit({ base_ref: 'c'.repeat(40), head_sha: 'd'.repeat(40), version: '3.42.0' }), {
    expectBase: base,
    expectHead: head,
    expectVersion: '3.43.0',
  })
  const text = problems.join('\n')
  assert.match(text, /does not match the resolved base/)
  assert.match(text, /does not match the compared head/)
  assert.match(text, /does not match the pinned 3\.43\.0/)
})

test('fallow gate CLI exits 1 with a named counter on a regression report', () => {
  const project = mkdtempSync(join(tmpdir(), 'cowork-fallow-gate-'))
  try {
    const passing = join(project, 'passing.json')
    const failing = join(project, 'failing.json')
    writeFileSync(passing, JSON.stringify(audit()))
    writeFileSync(failing, JSON.stringify(audit({
      attribution: { complexity_introduced: 0, complexity_worsened: 3 },
    })))

    const args = ['scripts/ci/fallow-gate.mjs', '--expect-version', '3.43.0', '--expect-base', base, '--expect-head', head]
    const ok = spawnSync(process.execPath, [...args, '--audit', passing], { cwd: root, encoding: 'utf8' })
    assert.equal(ok.status, 0, ok.stderr)
    assert.match(ok.stdout, /audit passed/)

    const blocked = spawnSync(process.execPath, [...args, '--audit', failing], { cwd: root, encoding: 'utf8' })
    assert.equal(blocked.status, 1)
    assert.match(blocked.stderr, /complexity_worsened is 3, expected 0/)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('package.json pins the exact fallow CLI version', () => {
  const pinned = pinnedFallowVersion()
  assert.equal(typeof pinned, 'string', 'devDependencies.fallow must pin the CLI version')
  assert.match(pinned, /^\d+\.\d+\.\d+$/, `fallow version must be exact, got ${String(pinned)}`)
})
