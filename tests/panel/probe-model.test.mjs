import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalRepoPath,
  isLoopbackAddress,
  isLoopbackHost,
} from '../../src/panel/probe-model.ts'

test('loopback admission accepts only loopback peers and hosts', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackAddress(address), true, address)
  }
  for (const address of [undefined, '', '192.168.1.20', '10.0.0.2', '::ffff:192.168.1.20']) {
    assert.equal(isLoopbackAddress(address), false, String(address))
  }
  for (const host of ['127.0.0.1', '127.0.0.1:3080', 'localhost', 'localhost:3080', '[::1]:3080']) {
    assert.equal(isLoopbackHost(host), true, host)
  }
  for (const host of [undefined, '', 'example.com', '192.168.1.20:3080']) {
    assert.equal(isLoopbackHost(host), false, String(host))
  }
})

test('canonicalRepoPath resolves a symlink and passes a missing path through', () => {
  // A fresh temp directory per run keeps the fixture deterministic; the
  // expectation is realpath(real), not the literal path, because macOS also
  // canonicalizes the temp root itself (`/var` → `/private/var`).
  const root = mkdtempSync(join(tmpdir(), 'dsh-cowork-canonical-'))
  try {
    const real = join(root, 'real')
    mkdirSync(real)
    const link = join(root, 'link')
    symlinkSync(real, link)
    assert.equal(canonicalRepoPath(link), realpathSync(real))
    assert.equal(canonicalRepoPath(link), realpathSync(link))
    const missing = join(root, 'not-created-yet')
    assert.equal(canonicalRepoPath(missing), missing)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
