#!/usr/bin/env node
/**
 * Coverage ownership policy: which lane owns which source file.
 *
 * Every TypeScript source under `src/` (client TSX included) has exactly one
 * owner: `unit`, `browser`, or `dev`. The map is data (`tools/coverage-map.json`)
 * and this module is its only validator. `dev` is reserved for legacy drivers
 * under `src/dev/`; each such entry must state why it is not gated and when it
 * leaves the lane. A file with no runtime statements is detected by type
 * stripping, not by a hand-written allowlist.
 */
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { filesIn } from './file-walk.mjs'

/** Closed set of coverage lanes. */
export const LANES = Object.freeze(['unit', 'browser', 'dev'])

/** Repository-relative POSIX path for an absolute path inside `cwd`. */
function relativePath(cwd, absolutePath) {
  const base = resolve(cwd)
  return resolve(absolutePath).startsWith(`${base}${sep}`)
    ? absolutePath.slice(base.length + 1).split(sep).join('/')
    : absolutePath.split(sep).join('/')
}

/** Every source file the owner map must classify, repo-relative POSIX. */
export function sourceFilesIn(cwd = process.cwd()) {
  return filesIn(join(cwd, 'src'), (name) => name.endsWith('.ts') || name.endsWith('.tsx'))
    .map((file) => relativePath(cwd, file))
    .sort()
}

/**
 * A file with no runtime statements: type stripping leaves only comments and
 * blank lines. Such a file cannot appear in a V8 coverage report and must not
 * be treated as "unloaded". A file that needs the transform pass is executable.
 */
export function isTypeOnly(absolutePath) {
  let stripped
  try {
    stripped = stripTypeScriptTypes(readFileSync(absolutePath, 'utf8'))
  } catch {
    return false
  }
  const withoutComments = stripped.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  return withoutComments.split('\n').every((line) => line.trim() === '')
}

function validateDevEntry(path, entry, failures) {
  if (!path.startsWith('src/dev/')) failures.push(`${path}: dev lane is only for src/dev/`)
  if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
    failures.push(`${path}: dev entry needs a reason`)
  }
  if (typeof entry.exitWhen !== 'string' || entry.exitWhen.trim() === '') {
    failures.push(`${path}: dev entry needs exitWhen`)
  }
}

/** Validate one map entry and add it to `byPath` when usable. */
function validateEntry(entry, index, byPath, failures) {
  const where = `tools/coverage-map.json files[${String(index)}]`
  if (entry === null || typeof entry !== 'object') {
    failures.push(`${where}: entry must be an object`)
    return
  }
  if (typeof entry.path !== 'string' || entry.path.trim() === '') {
    failures.push(`${where}: path must be a non-empty string`)
    return
  }
  if (!LANES.includes(entry.lane)) {
    failures.push(`${entry.path}: lane must be one of ${LANES.join(', ')}`)
    return
  }
  if (byPath.has(entry.path)) {
    failures.push(`${entry.path}: duplicate owner entry`)
    return
  }
  if (entry.lane === 'dev') validateDevEntry(entry.path, entry, failures)
  byPath.set(entry.path, entry)
}

/**
 * Validate the owner map against the source tree.
 *
 * @param {unknown} map Parsed `tools/coverage-map.json`.
 * @param {string[]} sourceFiles Every source path the map must cover.
 * @returns {{failures: string[], byPath: Map<string, object>}}
 */
export function validateOwnershipMap(map, sourceFiles) {
  const failures = []
  const byPath = new Map()
  if (map === null || typeof map !== 'object' || Array.isArray(map) || map.version !== 1) {
    failures.push('tools/coverage-map.json must be an object with version 1')
    return { failures, byPath }
  }
  if (!Array.isArray(map.files)) {
    failures.push('tools/coverage-map.json must carry a files array')
    return { failures, byPath }
  }
  map.files.forEach((entry, index) => validateEntry(entry, index, byPath, failures))
  const sources = new Set(sourceFiles)
  for (const file of sourceFiles) {
    if (!byPath.has(file)) failures.push(`${file}: source file has no coverage owner`)
  }
  for (const file of byPath.keys()) {
    if (!sources.has(file)) failures.push(`${file}: owner entry names no source file`)
  }
  return { failures, byPath }
}
