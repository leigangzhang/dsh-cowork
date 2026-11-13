import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The installable-bundle contract (M4): `dsh plugin add <tarball>` reads
 * `dsh.bundle.patch` from the installed copy and mounts the rows it names, so
 * the patch file, the published file list, and the package entry points must
 * agree with each other and keep existing after a future refactor.
 *
 * Deterministic and read-only: it reads two tracked files and asks npm for a
 * dry-run pack manifest; nothing is written to the repository.
 */
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/** The published file list, exactly — npm's `files` whitelist is a set. */
const PUBLISHED_FILES = ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE']

/** Paths the tarball must never contain: build/test/docs inputs and artifacts. */
const FORBIDDEN_PACK_PREFIXES = ['src/', 'tests/', 'docs/', '.dsh-cowork/', '.agents/', 'scripts/', 'tools/']
const FORBIDDEN_PACK_EXTENSIONS = ['.tgz', '.tsbuildinfo']

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const patchText = readFileSync(resolve(root, pkg.dsh?.bundle?.patch ?? 'cordis.patch.yml'), 'utf8')

test('package.json keeps the identity and entry points a bundle install relies on', () => {
  assert.equal(pkg.name, '@dsh-external/dsh-cowork')
  assert.equal(pkg.version, '0.2.0')
  assert.equal(pkg.private, true, 'the package stays unpublished by default')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, './lib/index.js')
  assert.equal(pkg.types, './lib/types/index.d.ts')
  assert.equal(pkg.exports?.['.']?.default, './lib/index.js')
  assert.equal(pkg.exports?.['.']?.types, './lib/types/index.d.ts')
  assert.equal(pkg.exports?.['./client']?.default, './lib/client.js', 'the client entry must stay exported')
  assert.equal(pkg.exports?.['./package.json'], './package.json')
})

test('dsh.client declares the web platform and its sidebar/workspace injections', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.deepEqual(pkg.dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-sidebar-right',
    '@deepseek-ai/dsh-client-ui-workspace',
  ])
})

test('dsh.bundle.patch names the tracked patch file that ships in the tarball', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.ok(existsSync(resolve(root, 'cordis.patch.yml')), 'cordis.patch.yml must exist at the package root')
})

test('the published file list is exactly lib/, the patch, README and LICENSE', () => {
  assert.ok(Array.isArray(pkg.files), 'package.json must declare a files whitelist')
  assert.deepEqual(
    [...pkg.files].sort(),
    [...PUBLISHED_FILES].sort(),
    'files must whitelist exactly lib, cordis.patch.yml, README.md and LICENSE',
  )
  for (const name of ['README.md', 'LICENSE']) {
    assert.ok(existsSync(resolve(root, name)), `${name} is whitelisted and must exist`)
  }
})

test('the built lib artifact is present and not ignored', () => {
  const ignoreLines = readFileSync(resolve(root, '.gitignore'), 'utf8').split(/\r?\n/)
  assert.equal(ignoreLines.includes('lib/'), false, '.gitignore must not ignore the committed lib artifact')
  for (const rel of ['lib/index.js', 'lib/client.js', 'lib/types/index.d.ts']) {
    assert.ok(existsSync(resolve(root, rel)), `${rel} must be committed for tarball and host-smoke use`)
  }
})

test('cordis.patch.yml has one insert row: id dsh-cowork under the installed name', () => {
  const insertLines = patchText.split('\n').filter((line) => /^\s*-\s*insert:\s*$/.test(line))
  assert.equal(insertLines.length, 1, 'the bundle patch must declare exactly one insert block')

  const ids = [...patchText.matchAll(/^\s*(?:-\s*)?id:\s*(.+?)\s*$/gm)].map((match) => match[1].replace(/^['"]|['"]$/g, ''))
  assert.deepEqual(ids, ['dsh-cowork'], 'exactly one loader id, and it is dsh-cowork')

  const names = [...patchText.matchAll(/^\s*(?:-\s*)?name:\s*(.+?)\s*$/gm)].map((match) =>
    match[1].replace(/^['"]|['"]$/g, ''),
  )
  assert.deepEqual(names, [pkg.name], 'the inserted row resolves the installed package by its own name')
})

test('npm pack ships only the runtime files, never sources, tests, docs or artifacts', () => {
  // npm writes to its cache even for a dry run. Keep that cache inside the
  // test so a root-owned or otherwise broken user cache cannot decide this
  // repository's packaging result.
  const cache = mkdtempSync(join(tmpdir(), 'cowork-npm-cache-'))
  try {
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      env: { ...process.env, npm_config_cache: cache },
    })
    const manifest = JSON.parse(raw)[0]
    const paths = manifest.files.map((file) => file.path)

    assert.ok(paths.length > 0, 'npm pack reported no files')
    assert.ok(paths.includes('package.json'), 'npm always packs package.json')
    assert.ok(paths.some((path) => path.startsWith('lib/')), 'npm pack must include the tracked lib artifact')

    const unexpected = paths.filter(
      (path) =>
        !(path === 'package.json' || path === 'cordis.patch.yml' || path === 'README.md' || path === 'LICENSE' || path.startsWith('lib/')),
    )
    assert.deepEqual(unexpected, [], `npm pack included files outside the contract: ${unexpected.join(', ')}`)

    const forbidden = paths.filter(
      (path) =>
        FORBIDDEN_PACK_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
        FORBIDDEN_PACK_EXTENSIONS.some((extension) => path.endsWith(extension)),
    )
    assert.deepEqual(forbidden, [], `npm pack included development paths: ${forbidden.join(', ')}`)

    for (const entry of manifest.files) {
      assert.ok(entry.size > 0, `${entry.path} must not be empty in the tarball`)
    }
  } finally {
    rmSync(cache, { recursive: true, force: true })
  }
})
