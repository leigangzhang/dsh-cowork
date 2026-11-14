import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOCAL_ONLY_PREFIXES, collectWorktreeFiles } from '../../scripts/evidence/clean-check.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')

test('the clean copy lists tracked files and excludes local-only trees', () => {
  const files = collectWorktreeFiles(root)
  assert.ok(files.length > 0)
  assert.ok(files.includes('tools/check-invariants.mjs'))
  assert.ok(files.includes('docs/publish.json'))
  assert.ok(files.includes('package.json'))
  const local = files.filter((rel) => LOCAL_ONLY_PREFIXES.some((prefix) => rel === prefix.slice(0, -1) || rel.startsWith(prefix)))
  assert.deepEqual(local, [])
})

test('check:clean runs the executable conventions without .dsh-cowork/ or lib/', () => {
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/evidence/clean-check.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
  })
  assert.equal(
    result.status,
    0,
    `check:clean must pass in a clean tree\n${result.stdout}\n${result.stderr}`,
  )
  assert.match(result.stdout, /check-invariants: ok/)
  assert.match(result.stdout, /PASS check:clean:/)
})
