import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildStoreDocument,
  canonicalRepoPath,
  isLoopbackAddress,
  isLoopbackHost,
  parseStoreDocument,
  readPath,
  readQuery,
  requireRunId,
  summarizeEvents,
} from '../src/probe-model.ts'

const event = (seq, type, data) => ({ type, seq, time: 1_700_000_000_000 + seq, data })

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

test('request parsing drops the query and validates the run id', () => {
  assert.equal(readPath('/dsh-cowork/probe/status?runId=abc'), '/dsh-cowork/probe/status')
  assert.equal(readPath(undefined), '/')
  assert.equal(readQuery('/dsh-cowork/probe/status?runId=abc&x=1', 'runId'), 'abc')
  assert.equal(readQuery('/dsh-cowork/probe/status', 'runId'), undefined)
  assert.equal(requireRunId(' abc '), 'abc')
  assert.throws(() => requireRunId(undefined), /runId query parameter is required/)
  assert.throws(() => requireRunId('   '), /runId query parameter is required/)
})

test('summarizeEvents folds one turn and skips earlier turns', () => {
  const events = [
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'old' }] } }),
    event(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    event(4, 'turn/start', { turn: 2 }),
    event(5, 'assistant/message', { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'COWORK_PROBE_WAKE_OK' }] } }),
    event(6, 'assistant/message', { turn: 2, step: 1, message: { content: [{ type: 'text', text: '!' }] } }),
    event(7, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
  ]
  const summary = summarizeEvents(events, 3)
  assert.equal(summary.turn, 2)
  assert.equal(summary.startSeq, 4)
  assert.equal(summary.endSeq, 7)
  assert.equal(summary.reason, 'completed')
  assert.equal(summary.text, 'COWORK_PROBE_WAKE_OK\n!')
  const first = summarizeEvents(events.slice(0, 3), 0)
  assert.equal(first.turn, 1)
  assert.equal(first.text, 'old')
})

test('summarizeEvents reports an error turn without inventing text', () => {
  const summary = summarizeEvents([
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'turn/end', { turn: 1, reason: { kind: 'error' } }),
  ])
  assert.equal(summary.reason, 'error')
  assert.equal(summary.text, '')
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

test('the store document round-trips and rejects malformed input', () => {
  const document = { runId: 'run-1', token: 'COWORK_PROBE_STORE_abcd1234', createdAt: 1_700_000_000_000 }
  const raw = buildStoreDocument(document)
  assert.equal(raw.endsWith('\n'), true)
  assert.deepEqual(parseStoreDocument(raw), document)
  assert.throws(() => parseStoreDocument('not json'), /not valid JSON/)
  assert.throws(() => parseStoreDocument('[]'), /must be a JSON object/)
  assert.throws(() => parseStoreDocument('{"runId":"","token":"x","createdAt":1}'), /runId/)
  assert.throws(() => parseStoreDocument('{"runId":"r","token":"","createdAt":1}'), /token/)
  assert.throws(() => parseStoreDocument('{"runId":"r","token":"t","createdAt":"now"}'), /createdAt/)
  assert.throws(() => buildStoreDocument({ runId: '', token: 't', createdAt: 1 }), /runId must be non-empty/)
})
