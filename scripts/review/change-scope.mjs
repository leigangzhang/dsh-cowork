#!/usr/bin/env node
/**
 * Report the exact committed, staged, unstaged, and untracked paths for a
 * review, relative to a caller-verified base ref.
 *
 * This is deliberately a scope reporter, not a base resolver: the caller must
 * pass the live PR or parent ref it verified. Git is always invoked without a
 * shell and path output is parsed as NUL-delimited UTF-8.
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const FORMAT_VERSION = 1
const MAX_GIT_BUFFER = 64 * 1024 * 1024
const UTF8 = new TextDecoder('utf-8', { fatal: true })

function gitBytes(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LANG: 'C', LC_ALL: 'C' },
    maxBuffer: MAX_GIT_BUFFER,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    const detail = result.stderr.toString('utf8').trim() || `git exited with status ${String(result.status)}`
    throw new Error(`git ${args.join(' ')}: ${detail}`)
  }
  return result.stdout
}

function gitText(cwd, args) {
  return UTF8.decode(gitBytes(cwd, args))
}

function parseNulPaths(bytes) {
  const paths = []
  let start = 0
  for (let end = 0; end < bytes.length; end += 1) {
    if (bytes[end] !== 0) continue
    if (end > start) paths.push(UTF8.decode(bytes.subarray(start, end)))
    start = end + 1
  }
  return [...new Set(paths)].sort()
}

function resolveCommit(cwd, label, ref) {
  const output = gitText(cwd, [
    '-c',
    'core.warnAmbiguousRefs=true',
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${ref}^{commit}`,
  ]).trim()
  const commits = output.split(/\r?\n/u).filter(Boolean)
  if (commits.length !== 1) throw new Error(`${label} ref ${JSON.stringify(ref)} did not resolve to exactly one commit`)
  return commits[0]
}

function mergeBase(cwd, baseSha, headSha) {
  const output = gitText(cwd, ['merge-base', '--all', baseSha, headSha]).trim()
  const bases = output.split(/\r?\n/u).filter(Boolean)
  if (bases.length !== 1) throw new Error(`base and head need exactly one merge base; found ${bases.length}`)
  return bases[0]
}

function diffPaths(cwd, args) {
  return parseNulPaths(gitBytes(cwd, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--ignore-submodules=none',
    '--name-only',
    '-z',
    ...args,
    '--',
  ]))
}

function parseOptions(args) {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      base: { type: 'string' },
      head: { type: 'string', default: 'HEAD' },
    },
    strict: true,
  })
  if (values.base === undefined || values.base.trim() === '') throw new Error('missing required --base <ref>')
  return { base: values.base, head: values.head }
}

/** Collect one versioned scope report without guessing the base. */
export function collectChangeScope(args, cwd = process.cwd()) {
  const options = parseOptions(args)
  const repositoryRoot = gitText(cwd, ['rev-parse', '--show-toplevel']).trim()
  const baseSha = resolveCommit(repositoryRoot, 'base', options.base)
  const headSha = resolveCommit(repositoryRoot, 'head', options.head)
  const mergeBaseSha = mergeBase(repositoryRoot, baseSha, headSha)
  return {
    formatVersion: FORMAT_VERSION,
    repositoryRoot,
    input: options,
    resolved: { baseSha, headSha, mergeBaseSha },
    paths: {
      committed: diffPaths(repositoryRoot, [mergeBaseSha, headSha]),
      staged: diffPaths(repositoryRoot, ['--cached']),
      unstaged: diffPaths(repositoryRoot, []),
      untracked: parseNulPaths(gitBytes(repositoryRoot, ['ls-files', '--others', '--exclude-standard', '-z', '--'])),
    },
  }
}

/** Render the report as stable JSON for tools and review notes. */
export function renderChangeScope(args, cwd = process.cwd()) {
  return `${JSON.stringify(collectChangeScope(args, cwd), null, 2)}\n`
}

const invoked = process.argv[1]
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(renderChangeScope(process.argv.slice(2)))
  } catch (error) {
    process.stderr.write(`change-scope: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
