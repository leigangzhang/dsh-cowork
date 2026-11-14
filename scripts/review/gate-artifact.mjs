#!/usr/bin/env node
/**
 * Bind a verification or review to one artifact identity.
 *
 * The artifact is the candidate HEAD plus the SHA-256 of the binary diff from a
 * caller-verified base, the current porcelain status, and the four
 * `change-scope` path groups. Two runs against the same base and head print the
 * same JSON; any commit, staged edit, unstaged edit, or untracked file changes
 * at least one field, so a stale report cannot be passed off as current.
 *
 * This is deliberately not a base resolver: the caller passes the live PR or
 * parent ref it verified, exactly like `change-scope`.
 *
 * Usage:
 *   node scripts/review/gate-artifact.mjs --base <ref> [--head <ref>]
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { collectChangeScope } from './change-scope.mjs'

const FORMAT_VERSION = 1
const MAX_GIT_BUFFER = 64 * 1024 * 1024

/** The flags recorded in `diff.command`; `--no-ext-diff`/`--no-textconv` keep the hash local. */
const DIFF_FLAGS = ['diff', '--no-ext-diff', '--no-textconv', '--binary']

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

/**
 * Collect one artifact identity for `base..head`.
 *
 * @param {string[]} args CLI arguments (`--base <ref>`, optional `--head <ref>`).
 * @param {string} [cwd] Repository working directory.
 * @returns {object} Versioned identity: resolved SHAs, diff command/hash/size,
 *   porcelain lines, and the committed/staged/unstaged/untracked path groups.
 */
export function collectGateArtifact(args, cwd = process.cwd()) {
  const options = parseOptions(args)
  const scope = collectChangeScope(['--base', options.base, '--head', options.head], cwd)
  const { baseSha, headSha } = scope.resolved
  const command = ['git', ...DIFF_FLAGS, `${baseSha}..${headSha}`].join(' ')
  const diff = gitBytes(scope.repositoryRoot, [...DIFF_FLAGS, `${baseSha}..${headSha}`])
  const porcelain = gitBytes(scope.repositoryRoot, ['status', '--porcelain', '--untracked-files=all'])
    .toString('utf8')
    .split('\n')
    .filter((line) => line !== '')
  return {
    formatVersion: FORMAT_VERSION,
    resolved: scope.resolved,
    diff: {
      command,
      sha256: createHash('sha256').update(diff).digest('hex'),
      bytes: diff.length,
    },
    porcelain,
    scope: scope.paths,
  }
}

/** Render the identity as stable JSON for task evidence and PR descriptions. */
export function renderGateArtifact(args, cwd = process.cwd()) {
  return `${JSON.stringify(collectGateArtifact(args, cwd), null, 2)}\n`
}

const invoked = process.argv[1]
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(renderGateArtifact(process.argv.slice(2)))
  } catch (error) {
    process.stderr.write(`gate-artifact: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
