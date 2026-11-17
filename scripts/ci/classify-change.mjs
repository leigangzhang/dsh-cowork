#!/usr/bin/env node
/**
 * Classify the outgoing PR paths so CI can choose the smallest hosted lane.
 *
 * A docs-only change is a change to `docs/` or the repository README. The
 * classification is deliberately narrow: agent rules, workflows, scripts, and
 * tests still take the full source lane. The result controls test selection,
 * not review; a documentation change may still describe a current behavior and
 * must be reviewed like any other change.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

/**
 * Return whether one repository-relative path belongs to the docs-only lane.
 *
 * @param {string} path Repository-relative path using `/` separators.
 * @returns {boolean} True for `docs/**` and the repository README.
 */
export function isDocsOnlyPath(path) {
  return path === 'README.md' || path.startsWith('docs/')
}

/**
 * Classify a list of repository-relative changed paths.
 *
 * Empty input is not docs-only: a PR with no changed paths has nothing that
 * can justify skipping the source lane.
 *
 * @param {string[]} paths Repository-relative paths.
 * @returns {{ docsOnly: boolean, paths: string[] }} Stable classification.
 */
export function classifyPaths(paths) {
  const normalized = [...new Set(paths.map((path) => String(path).trim()).filter((path) => path !== ''))]
  return {
    docsOnly: normalized.length > 0 && normalized.every(isDocsOnlyPath),
    paths: normalized,
  }
}

/**
 * Read changed paths from `git diff --name-only <base>...<head>`.
 *
 * @param {{ base: string, head?: string, cwd?: string }} input Comparison refs.
 * @returns {string[]} Repository-relative changed paths.
 * @throws {Error} When git exits non-zero or cannot be started.
 */
export function changedPaths({ base, head = 'HEAD', cwd = process.cwd() }) {
  const result = spawnSync('git', ['diff', '--name-only', `${base}...${head}`], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    const detail = String(result.stderr ?? '').trim() || `git exited with status ${String(result.status)}`
    throw new Error(`git diff --name-only ${base}...${head}: ${detail}`)
  }
  return result.stdout.split('\n').filter((path) => path !== '')
}

function parseOptions(args) {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      base: { type: 'string' },
      head: { type: 'string', default: 'HEAD' },
      'github-output': { type: 'boolean', default: false },
    },
    strict: true,
  })
  if (values.base === undefined || values.base.trim() === '') throw new Error('missing required --base <ref>')
  return { base: values.base, head: values.head, githubOutput: values['github-output'] }
}

/**
 * Run the classifier and optionally publish GitHub Actions step outputs.
 *
 * @param {string[]} args CLI arguments.
 * @param {{ cwd?: string, outputFile?: string }} [environment] Injectable seams for tests.
 * @returns {{ docsOnly: boolean, paths: string[] }} Classification.
 */
export function runClassifier(args, environment = {}) {
  const options = parseOptions(args)
  const result = classifyPaths(changedPaths({
    base: options.base,
    head: options.head,
    cwd: environment.cwd ?? process.cwd(),
  }))
  if (options.githubOutput) {
    const outputFile = environment.outputFile ?? process.env.GITHUB_OUTPUT
    if (outputFile === undefined || outputFile === '') throw new Error('GITHUB_OUTPUT is not set')
    appendFileSync(outputFile, `docs_only=${String(result.docsOnly)}\n`)
  }
  return result
}

const invoked = process.argv[1]
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  try {
    const result = runClassifier(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`classify-change: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
