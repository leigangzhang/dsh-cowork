import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderChangeScope } from '../../scripts/review/change-scope.mjs'

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

test('change-scope separates committed, staged, unstaged, and untracked paths', () => {
  const repo = mkdtempSync(join(tmpdir(), 'cowork-change-scope-'))
  try {
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.email', 'review@example.invalid'])
    git(repo, ['config', 'user.name', 'Review Test'])
    writeFileSync(join(repo, 'tracked.txt'), 'base\n')
    git(repo, ['add', 'tracked.txt'])
    git(repo, ['commit', '-q', '-m', 'base'])
    const base = git(repo, ['rev-parse', 'HEAD'])

    git(repo, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(repo, 'committed.txt'), 'committed\n')
    git(repo, ['add', 'committed.txt'])
    git(repo, ['commit', '-q', '-m', 'feature'])
    writeFileSync(join(repo, 'staged.txt'), 'staged\n')
    git(repo, ['add', 'staged.txt'])
    writeFileSync(join(repo, 'tracked.txt'), 'modified\n')
    writeFileSync(join(repo, 'untracked.txt'), 'untracked\n')

    const report = JSON.parse(renderChangeScope(['--base', base], repo))
    assert.equal(report.formatVersion, 1)
    assert.equal(report.resolved.mergeBaseSha, base)
    assert.equal(report.resolved.baseSha, base)
    assert.deepEqual(report.paths.committed, ['committed.txt'])
    assert.deepEqual(report.paths.staged, ['staged.txt'])
    assert.deepEqual(report.paths.unstaged, ['tracked.txt'])
    assert.deepEqual(report.paths.untracked, ['untracked.txt'])
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('change-scope fails closed for an unknown base', () => {
  const repo = mkdtempSync(join(tmpdir(), 'cowork-change-scope-bad-'))
  try {
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.email', 'review@example.invalid'])
    git(repo, ['config', 'user.name', 'Review Test'])
    writeFileSync(join(repo, 'tracked.txt'), 'base\n')
    git(repo, ['add', 'tracked.txt'])
    git(repo, ['commit', '-q', '-m', 'base'])
    assert.throws(
      () => renderChangeScope(['--base', 'does-not-exist'], repo),
      /does not resolve|rev-parse|git/,
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
