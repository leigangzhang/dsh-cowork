#!/usr/bin/env node
/**
 * Run the executable conventions in a tree that has no local runtime data.
 *
 * `npm run check` must pass in a fresh checkout or CI, not only on a machine
 * that happens to have `.dsh-cowork/`, `lib/`, or `node_modules/` next to the
 * sources. This copies every tracked or untracked-but-not-ignored file (or
 * extracts `git archive <ref>`) into a temporary directory, proves the ignored
 * trees are absent, and runs `tools/check-invariants.mjs` there.
 *
 * Usage:
 *   node scripts/evidence/clean-check.mjs             # copy the working tree
 *   node scripts/evidence/clean-check.mjs --ref HEAD  # verify a committed tree
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const MAX_BUFFER = 64 * 1024 * 1024

/** Directory prefixes that must never be part of the clean copy. */
export const LOCAL_ONLY_PREFIXES = [
  '.dsh-cowork/',
  'lib/',
  'node_modules/',
  'dist/',
  '.agent-teams/',
  '.marklingo/',
  '.fallow/',
]

function git(cwd, args, options = {}) {
  const result = spawnSync('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], {
    maxBuffer: MAX_BUFFER,
    ...options,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    const detail = result.stderr?.toString('utf8').trim() || `git exited with status ${String(result.status)}`
    throw new Error(`git ${args.join(' ')}: ${detail}`)
  }
  return result.stdout
}

/**
 * Every worktree file git would include in a checkout: tracked plus untracked,
 * minus anything matched by `.gitignore`.
 *
 * @param {string} [cwd] Repository root.
 * @returns {string[]} Sorted repo-relative POSIX paths that currently exist.
 */
export function collectWorktreeFiles(cwd = root) {
  const listed = git(cwd, ['ls-files', '-z', '-co', '--exclude-standard']).toString('utf8')
  return [...new Set(listed.split('\0').filter(Boolean))]
    .filter((rel) => existsSync(join(cwd, rel)))
    .sort()
}

function isLocalOnly(rel) {
  return LOCAL_ONLY_PREFIXES.some((prefix) => rel === prefix.slice(0, -1) || rel.startsWith(prefix))
}

/** Copy one working tree into `destination`, preserving relative paths. */
export function copyWorktree(destination, cwd = root) {
  const files = collectWorktreeFiles(cwd)
  const ignored = files.filter(isLocalOnly)
  if (ignored.length > 0) throw new Error(`git listed ignored paths: ${ignored.join(', ')}`)
  for (const rel of files) {
    const target = join(destination, rel)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(cwd, rel), target)
  }
  return files
}

/** Number of regular files below `directory`, recursively. */
function countFiles(directory) {
  let total = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countFiles(join(directory, entry.name))
    else if (entry.isFile()) total += 1
  }
  return total
}

/** Extract `git archive <ref>` into `destination` and return its file count. */
export function extractArchive(destination, ref, cwd = root) {
  const archive = git(cwd, ['archive', '--format=tar', ref])
  const result = spawnSync('tar', ['-x', '-C', destination], { input: archive, maxBuffer: MAX_BUFFER })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`tar exited with status ${String(result.status)}`)
  return countFiles(destination)
}

function assertCleanTree(directory) {
  const problems = []
  for (const prefix of LOCAL_ONLY_PREFIXES) {
    const local = join(directory, prefix.slice(0, -1))
    if (existsSync(local)) problems.push(`local-only path present: ${prefix.slice(0, -1)}/`)
  }
  if (!existsSync(join(directory, 'tools/check-invariants.mjs'))) problems.push('tools/check-invariants.mjs is missing')
  return problems
}

function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: false,
    options: { ref: { type: 'string' } },
    strict: true,
  })
  const directory = mkdtempSync(join(tmpdir(), 'cowork-clean-check-'))
  try {
    const count = values.ref === undefined ? copyWorktree(directory).length : extractArchive(directory, values.ref)
    const problems = assertCleanTree(directory)
    if (problems.length > 0) {
      console.error('FAIL check:clean')
      for (const problem of problems) console.error(`  ${problem}`)
      process.exitCode = 1
      return
    }
    const result = spawnSync(process.execPath, ['tools/check-invariants.mjs'], {
      cwd: directory,
      stdio: 'inherit',
    })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) {
      console.error(`FAIL check:clean: npm run check failed in the clean tree (exit ${String(result.status)})`)
      process.exitCode = 1
      return
    }
    console.log(`PASS check:clean: ${count} files${values.ref === undefined ? ' from the worktree' : ` from ${values.ref}`} without .dsh-cowork/ or lib/`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const invoked = process.argv[1]
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`check:clean: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
