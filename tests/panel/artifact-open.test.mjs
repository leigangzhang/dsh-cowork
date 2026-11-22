import test from 'node:test'
import assert from 'node:assert/strict'
import { realpath, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  SESSION,
  createHarness,
  jsonOf,
  makeFile,
  makeRecord,
  sha256,
} from '../support/artifact-fixtures.mjs'
const { createOpenWorkspacePathPort } = await import('../../src/app/apply.ts')

/** Route behavior for "open in app": host handoff, path, and unsupported host. */
const SPEC = '# Spec\n\nfirst paragraph\nsecond paragraph\n'
const ARTIFACT = 'artifact-11111111-1111-4111-8111-111111111111'

/** One seeded work item with its file registered. */
async function withSeededHarness(operation, options = {}) {
  const harness = await createHarness({ files: { 'docs/spec.md': SPEC }, sessionTitle: 'Spec 主题', ...options })
  try {
    await harness.runtime().store.createRecord(makeRecord({
      files: [makeFile({ size: Buffer.byteLength(SPEC), sha256: sha256(SPEC), fsVersion: sha256(SPEC) })],
    }))
    return await operation(harness)
  } finally {
    await harness.cleanup()
  }
}

test('detail carries kept revision numbers and the open route hands the file to the host', async () => {
  const opened = []
  await withSeededHarness(async (harness) => {
    await harness.runtime().store.saveRevision(ARTIFACT, 1, SPEC)
    await harness.runtime().store.saveRevision(ARTIFACT, 2, `${SPEC}two\n`)
    const detail = await jsonOf(await harness.request('/api/cowork.artifact.detail', {
      query: { sessionId: SESSION, artifactId: ARTIFACT },
    }))
    assert.deepEqual(detail.revisions, [2, 1])

    const response = await harness.request('/api/cowork.artifact.open', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await jsonOf(response), { ok: true })
    assert.equal(opened.length, 1)
    assert.match(opened[0], /docs\/spec\.md$/)
    assert.ok(opened[0].startsWith(await realpath(harness.repoPath)))
  }, { openWorkspacePath: async (path) => { opened.push(path) } })
})

test('the open route answers unsupported without a host file opener', async () => {
  await withSeededHarness(async (harness) => {
    const response = await harness.request('/api/cowork.artifact.open', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT },
    })
    assert.equal(response.status, 501)
    const body = await jsonOf(response)
    assert.equal(body.error.code, 'artifact/open-unsupported')
  })
})

test('a failed session title lookup degrades the breadcrumb to null', async () => {
  await withSeededHarness(async (harness) => {
    const detail = await jsonOf(await harness.request('/api/cowork.artifact.detail', {
      query: { sessionId: SESSION, artifactId: ARTIFACT },
    }))
    assert.equal(detail.sessionTitle, null)
    assert.ok(harness.logs.some((message) => message.includes('session title lookup failed')))
  }, { listFailsAfterCalls: 1 })
})

test('a failed revision listing degrades to no snapshots', async () => {
  await withSeededHarness(async (harness) => {
    harness.runtime().store.listRevisions = async () => { throw new Error('revision read failed') }
    const detail = await jsonOf(await harness.request('/api/cowork.artifact.detail', {
      query: { sessionId: SESSION, artifactId: ARTIFACT },
    }))
    assert.deepEqual(detail.revisions, [])
    assert.ok(harness.logs.some((message) => message.includes('revision listing failed')))
  })
})

test('a host opener failure maps to artifact/io-error', async () => {
  await withSeededHarness(async (harness) => {
    const response = await harness.request('/api/cowork.artifact.open', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT },
    })
    assert.equal(response.status, 500)
    const body = await jsonOf(response)
    assert.equal(body.error.code, 'artifact/io-error')
  }, { openWorkspacePath: async () => { throw new Error('opener unavailable') } })
})

test('a real assembly with a host that has no opener maps to 501', async () => {
  await withSeededHarness(async (harness) => {
    const response = await harness.request('/api/cowork.artifact.open', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT },
    })
    assert.equal(response.status, 501)
    assert.equal((await jsonOf(response)).error.code, 'artifact/open-unsupported')
  }, { openWorkspacePath: createOpenWorkspacePathPort(undefined) })
})

test('open rejects a symlink that escapes the repository', async () => {
  await withSeededHarness(async (harness) => {
    const target = join(harness.repoPath, 'docs/spec.md')
    await rm(target)
    await symlink('/etc/hosts', target)
    const response = await harness.request('/api/cowork.artifact.open', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT },
    })
    assert.equal(response.status, 400)
    assert.equal((await jsonOf(response)).error.code, 'artifact/path-not-allowed')
  }, { openWorkspacePath: async () => {} })
})

test('open reports a missing file instead of a fake success', async () => {
  await withSeededHarness(async (harness) => {
    await rm(join(harness.repoPath, 'docs/spec.md'))
    const response = await harness.request('/api/cowork.artifact.open', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT },
    })
    assert.equal(response.status, 404)
    assert.equal((await jsonOf(response)).error.code, 'artifact/file-missing')
  }, { openWorkspacePath: async () => {} })
})
