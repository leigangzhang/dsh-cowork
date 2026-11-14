import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderGateArtifact } from '../scripts/gate-artifact.mjs'

/**
 * The gate artifact is the identity a verification or review binds to. These
 * tests run it against a real temporary repository so the SHA comes from git,
 * not from a mock of the thing being measured.
 */
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function withRepo(fn) {
  const repo = mkdtempSync(join(tmpdir(), 'cowork-gate-artifact-'))
  try {
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.email', 'review@example.invalid'])
    git(repo, ['config', 'user.name', 'Gate Artifact Test'])
    writeFileSync(join(repo, 'tracked.txt'), 'base\n')
    git(repo, ['add', 'tracked.txt'])
    git(repo, ['commit', '-q', '-m', 'base'])
    return fn(repo, git(repo, ['rev-parse', 'HEAD']))
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

test('the gate artifact binds HEAD, the binary diff hash, porcelain, and the scope groups', () => {
  withRepo((repo, base) => {
    git(repo, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(repo, 'committed.txt'), 'committed\n')
    git(repo, ['add', 'committed.txt'])
    git(repo, ['commit', '-q', '-m', 'feature'])
    writeFileSync(join(repo, 'staged.txt'), 'staged\n')
    git(repo, ['add', 'staged.txt'])
    writeFileSync(join(repo, 'tracked.txt'), 'modified\n')
    writeFileSync(join(repo, 'untracked.txt'), 'untracked\n')
    const head = git(repo, ['rev-parse', 'HEAD'])

    const artifact = JSON.parse(renderGateArtifact(['--base', base], repo))
    assert.equal(artifact.formatVersion, 1)
    assert.deepEqual(artifact.resolved, { baseSha: base, headSha: head, mergeBaseSha: base })
    assert.equal(artifact.diff.command, `git diff --no-ext-diff --no-textconv --binary ${base}..${head}`)

    const expectedDiff = execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', '--binary', `${base}..${head}`], {
      cwd: repo,
      maxBuffer: 64 * 1024 * 1024,
    })
    assert.equal(artifact.diff.sha256, createHash('sha256').update(expectedDiff).digest('hex'))
    assert.equal(artifact.diff.bytes, expectedDiff.length)

    assert.deepEqual(artifact.porcelain, ['A  staged.txt', ' M tracked.txt', '?? untracked.txt'])
    assert.deepEqual(artifact.scope, {
      committed: ['committed.txt'],
      staged: ['staged.txt'],
      unstaged: ['tracked.txt'],
      untracked: ['untracked.txt'],
    })
  })
})

test('the gate artifact is stable for the same base and head', () => {
  withRepo((repo, base) => {
    const first = renderGateArtifact(['--base', base], repo)
    const second = renderGateArtifact(['--base', base], repo)
    assert.equal(first, second)
  })
})

test('the gate artifact fails closed for an unknown base', () => {
  withRepo((repo) => {
    assert.throws(
      () => renderGateArtifact(['--base', 'does-not-exist'], repo),
      /does not resolve|rev-parse|git/,
    )
    assert.throws(() => renderGateArtifact([], repo), /--base/)
  })
})
