#!/usr/bin/env node
/**
 * Local evidence-marker check for the M3 closeout.
 *
 * The marker (`.dsh-cowork/e2e/M3_DOCS_READY.json`) is local-only evidence: it
 * records the commit the docs/screenshots were written against, the evidence
 * file, and the screenshot list. The failure this tool exists for is temporal:
 * a reviewer once read a marker whose `commit` was older than `HEAD`, so the
 * green check proved an older tree than the one being reviewed.
 *
 * Usage: node tools/check-evidence-marker.mjs [--root <dir>] [--head <sha>]
 *
 * Exit codes:
 *   0  marker is valid, or it does not exist (local evidence is optional; a
 *      missing marker must not turn CI red)
 *   1  marker exists but is invalid, unreadable, or HEAD cannot be resolved
 *   2  usage error
 *
 * Screenshots are listed but their bytes are not checked here: the marker is
 * written after the screenshots land, and the repository deliberately keeps
 * them out of git (see docs/archived/results/M3_RESULT.md).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Marker path relative to the project root. */
export const MARKER_RELATIVE = '.dsh-cowork/e2e/M3_DOCS_READY.json'

/**
 * Statuses that are acceptable on a closeout marker. `unverified` is not: a
 * closeout marker with no verified screenshot set would contradict the
 * acceptance it is supposed to record.
 */
export const SCREENSHOT_STATUSES = ['verified', 'partial']

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Validate one parsed marker against the current HEAD. Pure: the caller reads
 * the file and resolves HEAD, so tests can cover mismatch and empty screenshots
 * without a git repository.
 */
export function checkEvidenceMarker(marker, headCommit) {
  const errors = []
  if (typeof marker !== 'object' || marker === null || Array.isArray(marker)) {
    return ['marker must be a JSON object']
  }
  if (!isNonEmptyString(headCommit)) errors.push('HEAD commit is unavailable; cannot verify the marker')
  if (!isNonEmptyString(marker.commit)) errors.push('marker.commit must be a non-empty string')
  else if (isNonEmptyString(headCommit) && marker.commit !== headCommit) {
    errors.push(`marker.commit ${marker.commit} does not match HEAD ${headCommit}; rewrite the marker after the last commit`)
  }
  if (!Array.isArray(marker.screenshots) || marker.screenshots.length === 0) {
    errors.push('marker.screenshots must be a non-empty array')
  } else {
    const bad = marker.screenshots.findIndex((entry) => !isNonEmptyString(entry))
    if (bad >= 0) errors.push(`marker.screenshots[${bad}] must be a non-empty path`)
  }
  if (!SCREENSHOT_STATUSES.includes(marker.screenshotStatus)) {
    errors.push(`marker.screenshotStatus must be one of ${SCREENSHOT_STATUSES.join('|')}, got ${JSON.stringify(marker.screenshotStatus)}`)
  }
  return errors
}

function parseArgs(argv) {
  const options = { root: resolve(dirname(fileURLToPath(import.meta.url)), '..'), head: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--root' || arg === '--head') {
      const value = argv[index + 1]
      if (!isNonEmptyString(value)) throw new Error(`${arg} needs a value`)
      options[arg.slice(2)] = value
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function resolveHead(root) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
}

function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`check-evidence-marker: ${error.message}`)
    console.error('usage: node tools/check-evidence-marker.mjs [--root <dir>] [--head <sha>]')
    return 2
  }
  if (options.help === true) {
    console.log('usage: node tools/check-evidence-marker.mjs [--root <dir>] [--head <sha>]')
    console.log('exit 0 when the marker is valid or missing; exit 1 when it exists and is invalid')
    return 0
  }

  const markerPath = join(options.root, MARKER_RELATIVE)
  if (!existsSync(markerPath)) {
    console.log(`check-evidence-marker: skipped (no marker at ${markerPath})`)
    return 0
  }

  let marker
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8'))
  } catch (error) {
    console.error(`check-evidence-marker: cannot parse ${markerPath}: ${error.message}`)
    return 1
  }

  let head
  try {
    head = options.head ?? resolveHead(options.root)
  } catch (error) {
    console.error(`check-evidence-marker: cannot resolve HEAD in ${options.root}: ${error.message}`)
    return 1
  }

  const errors = checkEvidenceMarker(marker, head)
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`)
    console.error(`check-evidence-marker: ${errors.length} violation(s)`)
    return 1
  }
  const screenshots = marker.screenshots.length
  console.log(`check-evidence-marker: ok (commit ${String(marker.commit).slice(0, 8)}; ${screenshots} screenshot(s); status=${marker.screenshotStatus})`)
  return 0
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exit(main(process.argv.slice(2)))
}
