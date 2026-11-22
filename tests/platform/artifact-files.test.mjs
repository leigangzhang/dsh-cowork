import test from 'node:test'
import assert from 'node:assert/strict'
import { realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  artifactErrors,
  artifactFiles,
  fakeHostFs,
  linkInside,
  makeFile,
  makeRepo,
  sha256,
} from '../support/artifact-fixtures.mjs'

/**
 * The filesystem adapter is where a project-relative path becomes a real file:
 * it must prove the real path stays inside the repository, delegate content and
 * version to `ctx.fs`, and map every host failure onto one artifact code. The
 * reconcile helper keeps a record truthful after an external/model write.
 */
async function withFixtureRepo(files, operation) {
  const repo = await makeRepo(files)
  try {
    return await operation(repo)
  } finally {
    await repo.remove()
  }
}

test('stat and readText observe a registered file through the host service', async () => {
  await withFixtureRepo({ 'docs/spec.md': '# Spec\n\nbody\n' }, async (repo) => {
    const host = fakeHostFs()
    const port = artifactFiles.createHostArtifactFiles(host, repo.repoPath)
    const observed = await port.stat('docs/spec.md')
    assert.equal(observed.exists, true)
    assert.equal(observed.regular, true)
    assert.equal(observed.size, 13)
    assert.equal(observed.version, sha256('# Spec\n\nbody\n'))
    const read = await port.readText('docs/spec.md')
    assert.equal(read.content, '# Spec\n\nbody\n')
    assert.equal(read.size, 13)
    assert.equal(read.version, sha256('# Spec\n\nbody\n'))
    // The host fs is reached through an absolute resolved path.
    assert.ok(host.calls.some(([kind, path]) => kind === 'resolve' && path.endsWith('/docs/spec.md')))
  })
})

test('a missing path reports absence on stat and fails a read', async () => {
  await withFixtureRepo({}, async (repo) => {
    const port = artifactFiles.createHostArtifactFiles(fakeHostFs(), repo.repoPath)
    assert.deepEqual(await port.stat('docs/none.md'), { exists: false, regular: false, size: 0, version: null })
    await assert.rejects(port.readText('docs/none.md'), (error) => {
      assert.equal(error.code, 'artifact/file-missing')
      return true
    })
    await assert.rejects(port.writeText('docs/none.md', 'x', null), (error) => {
      assert.equal(error.code, 'artifact/file-missing')
      return true
    })
  })
})

test('a host stat that turns absent reports absence', async () => {
  await withFixtureRepo({ 'docs/spec.md': 'x' }, async (repo) => {
    const host = fakeHostFs()
    const absentHost = { ...host, stat: async () => undefined }
    const port = artifactFiles.createHostArtifactFiles(absentHost, repo.repoPath)
    assert.deepEqual(await port.stat('docs/spec.md'), { exists: false, regular: false, size: 0, version: null })
  })
})

test('writes are guarded by the opaque version token', async () => {
  await withFixtureRepo({ 'docs/spec.md': 'one\n' }, async (repo) => {
    const port = artifactFiles.createHostArtifactFiles(fakeHostFs(), repo.repoPath)
    const current = await port.stat('docs/spec.md')
    const written = await port.writeText('docs/spec.md', 'two\n', current.version)
    assert.equal(written.version, sha256('two\n'))
    assert.equal(written.before, 'one\n')
    const unguarded = await port.writeText('docs/spec.md', 'three\n', null)
    assert.equal(unguarded.version, sha256('three\n'))
    await assert.rejects(port.writeText('docs/spec.md', 'four\n', current.version), (error) => {
      assert.equal(error.code, 'artifact/version-conflict')
      return true
    })
    assert.equal(await repo.read('docs/spec.md'), 'three\n')
  })
})

test('a symlink out of the repository and a directory are refused', async () => {
  await withFixtureRepo({ 'docs/spec.md': 'x', 'outside/target.md': 'secret' }, async (repo) => {
    const outside = await makeRepo({ 'target.md': 'secret' })
    try {
      await linkInside(repo.repoPath, 'docs/escape.md', join(outside.repoPath, 'target.md'))
      const port = artifactFiles.createHostArtifactFiles(fakeHostFs(), repo.repoPath)
      await assert.rejects(port.readText('docs/escape.md'), (error) => {
        assert.equal(error.code, 'artifact/path-not-allowed')
        return true
      })
      await assert.rejects(port.writeText('docs/escape.md', 'x', null), (error) => {
        assert.equal(error.code, 'artifact/path-not-allowed')
        return true
      })
      await assert.rejects(port.readText('docs'), (error) => {
        assert.equal(error.code, 'artifact/path-not-allowed')
        return true
      })
    } finally {
      await outside.remove()
    }
  })
})

test('a symlink resolving inside the repo to a forbidden path is refused', async () => {
  await withFixtureRepo({
    'docs/spec.md': 'x',
    '.git/config': '[remote "origin"]\n',
    '.env': 'TOKEN=secret\n',
    '.dsh-cowork/index.json': '{}\n',
  }, async (repo) => {
    const links = [
      ['docs/git.md', '.git/config'],
      ['docs/env.md', '.env'],
      ['docs/state.md', '.dsh-cowork/index.json'],
    ]
    for (const [link, target] of links) {
      await linkInside(repo.repoPath, link, join(repo.repoPath, target))
    }
    const port = artifactFiles.createHostArtifactFiles(fakeHostFs(), repo.repoPath)
    for (const [link] of links) {
      // The linker path is lexically fine; only the resolved target is forbidden,
      // so detail/file/open/edit cannot be tricked into serving these bytes.
      await assert.rejects(port.stat(link), (error) => {
        assert.equal(error.code, 'artifact/path-not-allowed')
        return true
      })
      await assert.rejects(port.readText(link), (error) => {
        assert.equal(error.code, 'artifact/path-not-allowed')
        return true
      })
      await assert.rejects(port.writeText(link, 'x', null), (error) => {
        assert.equal(error.code, 'artifact/path-not-allowed')
        return true
      })
    }
    // A normal registered file is unchanged by the resolved-path rule.
    assert.equal((await port.stat('docs/spec.md')).exists, true)
  })
})

test('a symlink loop is an io error, not a missing file', async () => {
  await withFixtureRepo({}, async (repo) => {
    await linkInside(repo.repoPath, 'docs/loop.md', 'loop.md')
    const port = artifactFiles.createHostArtifactFiles(fakeHostFs(), repo.repoPath)
    await assert.rejects(port.readText('docs/loop.md'), (error) => {
      assert.equal(error.code, 'artifact/io-error')
      return true
    })
  })
})

test('the host failure taxonomy maps to the artifact codes', async () => {
  await withFixtureRepo({ 'docs/spec.md': 'x' }, async (repo) => {
    const path = 'docs/spec.md'
    const cases = [
      ['FS_STALE_VERSION', 'artifact/version-conflict'],
      ['ENOENT', 'artifact/file-missing'],
      ['ENOTDIR', 'artifact/file-missing'],
      ['FS_NOT_FOUND', 'artifact/file-missing'],
      ['FS_TOO_LARGE', 'artifact/file-too-large'],
      ['EACCES', 'artifact/io-error'],
    ]
    for (const [code, expected] of cases) {
      const mapped = artifactFiles.mapFsError(Object.assign(new Error(code), { code }), path)
      assert.equal(mapped.code, expected, code)
    }
    assert.equal(artifactFiles.mapFsError('plain string', path).code, 'artifact/io-error')
    const existing = new artifactErrors.ArtifactDomainError('artifact/not-found', 'kept')
    assert.equal(artifactFiles.mapFsError(existing, path), existing)

    const real = await realpath(join(repo.repoPath, path))
    const failing = fakeHostFs({ failures: new Map([[real, 'FS_TOO_LARGE']]) })
    const port = artifactFiles.createHostArtifactFiles(failing, repo.repoPath)
    await assert.rejects(port.stat(path), (error) => {
      assert.equal(error.code, 'artifact/file-too-large')
      return true
    })
    await assert.rejects(port.readText(path), (error) => {
      assert.equal(error.code, 'artifact/file-too-large')
      return true
    })
    await assert.rejects(port.writeText(path, 'x', null), (error) => {
      assert.equal(error.code, 'artifact/file-too-large')
      return true
    })
  })
})

test('sha256Hex is the lowercase hex digest', () => {
  assert.equal(
    artifactFiles.sha256Hex('hello'),
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  )
})

test('a text file that changed externally gets a new hash and revision', async () => {
  await withFixtureRepo({ 'docs/spec.md': 'one\n' }, async (repo) => {
    const port = artifactFiles.createHostArtifactFiles(fakeHostFs(), repo.repoPath)
    const observed = await port.stat('docs/spec.md')
    const file = makeFile({
      size: 4,
      sha256: sha256('one\n'),
      fsVersion: observed.version,
      revision: 3,
    })
    const unchanged = await artifactFiles.reconcileArtifactFile(port, file)
    assert.equal(unchanged.changed, false)
    assert.equal(unchanged.file, file)

    await repo.write('docs/spec.md', 'one\ntwo\n')
    const changed = await artifactFiles.reconcileArtifactFile(port, file)
    assert.equal(changed.changed, true)
    assert.equal(changed.file.sha256, sha256('one\ntwo\n'))
    assert.equal(changed.file.size, 8)
    assert.equal(changed.file.revision, 4)
    assert.equal(changed.file.missing, false)
  })
})

test('a vanished file is marked missing and keeps its record', async () => {
  await withFixtureRepo({ 'docs/spec.md': 'one\n' }, async (repo) => {
    const port = artifactFiles.createHostArtifactFiles(fakeHostFs(), repo.repoPath)
    const file = makeFile({ sha256: sha256('one\n'), fsVersion: sha256('one\n') })
    await rm(join(repo.repoPath, 'docs/spec.md'))
    const gone = await artifactFiles.reconcileArtifactFile(port, file)
    assert.equal(gone.changed, true)
    assert.equal(gone.file.missing, true)
    const stillGone = await artifactFiles.reconcileArtifactFile(port, gone.file)
    assert.equal(stillGone.changed, false)
  })
})

test('a read or stat failure marks the file missing instead of blocking the view', async () => {
  const base = makeFile({ sha256: 'abc', fsVersion: 'v1' })
  const statFailure = {
    async stat() {
      throw new Error('boom')
    },
    async readText() {
      return { content: '', size: 0, version: null }
    },
    async writeText() {
      return { version: null, before: null }
    },
  }
  const missing = await artifactFiles.reconcileArtifactFile(statFailure, base)
  assert.equal(missing.changed, true)
  assert.equal(missing.file.missing, true)

  const readFailure = {
    async stat() {
      return { exists: true, regular: true, size: 4, version: 'v1' }
    },
    async readText() {
      throw new Error('cannot read')
    },
    async writeText() {
      return { version: null, before: null }
    },
  }
  const unreadable = await artifactFiles.reconcileArtifactFile(readFailure, base)
  assert.equal(unreadable.changed, true)
  assert.equal(unreadable.file.missing, true)
  const alreadyMissing = await artifactFiles.reconcileArtifactFile(readFailure, { ...base, missing: true })
  assert.equal(alreadyMissing.changed, false)
})

test('a version-only change refreshes the token without a revision bump', async () => {
  const file = makeFile({ sha256: sha256('same'), fsVersion: 'v1', revision: 2 })
  const versionOnly = {
    async stat() {
      return { exists: true, regular: true, size: 4, version: 'v2' }
    },
    async readText() {
      return { content: 'same', size: 4, version: 'v2' }
    },
    async writeText() {
      return { version: null, before: null }
    },
  }
  const result = await artifactFiles.reconcileArtifactFile(versionOnly, file)
  assert.equal(result.changed, true)
  assert.equal(result.file.fsVersion, 'v2')
  assert.equal(result.file.revision, 2)
})

test('a non-text file reconciles on size or version and keeps its hash', async () => {
  const file = makeFile({ path: 'docs/diagram.png', mediaType: 'image/png', editable: false, size: 10, fsVersion: 'v1', revision: 1 })
  const unchangedPort = {
    async stat() {
      return { exists: true, regular: true, size: 10, version: 'v1' }
    },
    async readText() {
      throw new Error('must not read a binary file')
    },
    async writeText() {
      return { version: null, before: null }
    },
  }
  assert.equal((await artifactFiles.reconcileArtifactFile(unchangedPort, file)).changed, false)

  const grownPort = {
    ...unchangedPort,
    async stat() {
      return { exists: true, regular: true, size: 20, version: 'v2' }
    },
  }
  const grown = await artifactFiles.reconcileArtifactFile(grownPort, file)
  assert.equal(grown.changed, true)
  assert.equal(grown.file.size, 20)
  assert.equal(grown.file.fsVersion, 'v2')
  assert.equal(grown.file.revision, 2)
  assert.equal(grown.file.sha256, file.sha256)
})
