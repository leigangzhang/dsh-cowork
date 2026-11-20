import test from 'node:test'
import assert from 'node:assert/strict'
import { artifactRuntime, fakeHostFs, makeRepo } from '../support/artifact-fixtures.mjs'

/**
 * The per-project runtime cache: one hub/store/file port per repository, an
 * explicit 501-only file port when the host has no `ctx.fs`, and disposal with
 * the plugin fiber.
 */
test('one runtime per repository, cached until disposed', async () => {
  const repo = await makeRepo()
  try {
    const manager = new artifactRuntime.ArtifactRuntimeManager({ hostFs: fakeHostFs() })
    const first = manager.runtimeFor(repo.repoPath)
    const second = manager.runtimeFor(repo.repoPath)
    assert.equal(first, second)
    assert.equal(first.fsAvailable, true)
    assert.equal(first.repoPath, repo.repoPath)
    first.events.publish({
      version: 1,
      seq: 1,
      eventId: 'event-1',
      type: 'artifact.updated',
      artifactId: 'artifact-1',
      time: '2026-02-01T00:00:00.000Z',
      data: {},
    })
    manager.dispose()
    const third = manager.runtimeFor(repo.repoPath)
    assert.notEqual(third, first)
    manager.dispose()
  } finally {
    await repo.remove()
  }
})

test('a host without ctx.fs degrades every file operation to 501', async () => {
  const repo = await makeRepo()
  try {
    const manager = new artifactRuntime.ArtifactRuntimeManager()
    const runtime = manager.runtimeFor(repo.repoPath)
    assert.equal(runtime.fsAvailable, false)
    for (const operation of [
      () => runtime.files.stat('docs/a.md'),
      () => runtime.files.readText('docs/a.md'),
      () => runtime.files.writeText('docs/a.md', 'x', null),
    ]) {
      await assert.rejects(operation(), (error) => {
        assert.equal(error.code, 'artifact/fs-unavailable')
        assert.equal(error.path, 'docs/a.md')
        return true
      })
    }
    // Records, comments and the event log still work.
    assert.deepEqual(await runtime.store.listRecords(), { records: [], corrupt: [], total: 0 })
    manager.dispose()
  } finally {
    await repo.remove()
  }
})
