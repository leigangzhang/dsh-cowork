import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MARKER_RELATIVE, SCREENSHOT_STATUSES, checkEvidenceMarker } from '../tools/check-evidence-marker.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const script = resolve(here, '..', 'tools', 'check-evidence-marker.mjs')
const HEAD = '0123456789abcdef0123456789abcdef01234567'

function marker(overrides = {}) {
  return {
    commit: HEAD,
    screenshots: ['.dsh-cowork/e2e/panel-m3/01-split-review-states.jpg'],
    screenshotStatus: 'verified',
    ...overrides,
  }
}

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'cowork-marker-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function writeMarker(root, body) {
  const path = join(root, MARKER_RELATIVE)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n')
}

function runCli(args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

// ---------------------------------------------------------------------------
// pure validation
// ---------------------------------------------------------------------------

test('a marker whose commit matches HEAD and lists screenshots is valid', () => {
  assert.deepEqual(checkEvidenceMarker(marker(), HEAD), [])
  assert.deepEqual(checkEvidenceMarker(marker({ screenshotStatus: 'partial' }), HEAD), [])
})

test('a stale marker commit is rejected against HEAD', () => {
  const errors = checkEvidenceMarker(marker({ commit: 'f'.repeat(40) }), HEAD)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /does not match HEAD/)
})

test('a marker without screenshots is rejected', () => {
  for (const screenshots of [[], undefined, null, ['ok.jpg', '']]) {
    const errors = checkEvidenceMarker(marker({ screenshots }), HEAD)
    assert.ok(errors.some((error) => /screenshots/.test(error)), `screenshots=${JSON.stringify(screenshots)} should fail`)
  }
})

test('an unsupported screenshot status is rejected', () => {
  assert.deepEqual(SCREENSHOT_STATUSES, ['verified', 'partial'])
  const errors = checkEvidenceMarker(marker({ screenshotStatus: 'unverified' }), HEAD)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /screenshotStatus/)
})

test('a non-object marker and an unavailable HEAD are rejected', () => {
  for (const value of [null, [], 'marker', 42]) {
    assert.deepEqual(checkEvidenceMarker(value, HEAD), ['marker must be a JSON object'])
  }
  const errors = checkEvidenceMarker(marker(), '')
  assert.ok(errors.some((error) => /HEAD/.test(error)))
})

// ---------------------------------------------------------------------------
// CLI contract: missing marker is a skip, a present-but-invalid marker is red
// ---------------------------------------------------------------------------

test('the CLI skips a missing marker with exit 0', (t) => {
  const root = tempRoot(t)
  const result = runCli(['--root', root, '--head', HEAD])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /skipped/)
})

test('the CLI accepts a valid marker with exit 0', (t) => {
  const root = tempRoot(t)
  writeMarker(root, marker())
  const result = runCli(['--root', root, '--head', HEAD])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /check-evidence-marker: ok/)
})

test('the CLI fails on a commit mismatch with exit 1', (t) => {
  const root = tempRoot(t)
  writeMarker(root, marker({ commit: 'f'.repeat(40) }))
  const result = runCli(['--root', root, '--head', HEAD])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /does not match HEAD/)
})

test('the CLI fails on empty screenshots with exit 1', (t) => {
  const root = tempRoot(t)
  writeMarker(root, marker({ screenshots: [] }))
  const result = runCli(['--root', root, '--head', HEAD])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /screenshots/)
})

test('the CLI fails on malformed JSON with exit 1', (t) => {
  const root = tempRoot(t)
  writeMarker(root, '{ not json')
  const result = runCli(['--root', root, '--head', HEAD])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /cannot parse/)
})

test('the CLI rejects an unknown argument with exit 2', () => {
  const result = runCli(['--nope'])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /unknown argument/)
})
