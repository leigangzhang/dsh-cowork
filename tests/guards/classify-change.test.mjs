import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { classifyPaths, isDocsOnlyPath, runClassifier } from '../../scripts/ci/classify-change.mjs'

test('docs-only classification is limited to docs and README', () => {
  for (const path of ['docs/github-workflow.md', 'docs/design/flow.md', 'README.md']) {
    assert.equal(isDocsOnlyPath(path), true, path)
  }
  for (const path of ['AGENTS.md', '.agents/skills/code-review/SKILL.md', 'src/app/apply.ts', 'tests/guards/x.test.mjs']) {
    assert.equal(isDocsOnlyPath(path), false, path)
  }

  assert.deepEqual(classifyPaths(['docs/a.md', 'README.md']), {
    docsOnly: true,
    paths: ['docs/a.md', 'README.md'],
  })
  assert.equal(classifyPaths(['docs/a.md', 'src/a.ts']).docsOnly, false)
  assert.equal(classifyPaths([]).docsOnly, false, 'an empty diff must not skip the source lane')
  assert.deepEqual(classifyPaths(['docs/a.md', 'docs/a.md', '']), {
    docsOnly: true,
    paths: ['docs/a.md'],
  })
})

test('classifier reads the changed paths from git and writes the Actions output', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cowork-classify-'))
  try {
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.name', 'test'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    await writeFile(join(repo, 'README.md'), 'one\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'one'])
    const base = git(repo, ['rev-parse', 'HEAD']).trim()

    await writeFile(join(repo, 'README.md'), 'two\n')
    await mkdir(join(repo, 'docs'), { recursive: true })
    await writeFile(join(repo, 'docs', 'a.md'), 'docs\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'two'])

    const outputFile = join(repo, 'github-output')
    const result = runClassifier(['--base', base, '--github-output'], { cwd: repo, outputFile })
    assert.deepEqual(result, { docsOnly: true, paths: ['README.md', 'docs/a.md'] })
    assert.equal(await readFile(outputFile, 'utf8'), 'docs_only=true\n')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}
