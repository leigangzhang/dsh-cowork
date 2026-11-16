#!/usr/bin/env node
/**
 * Shared CLI plumbing for the evidence scripts.
 *
 * The scripts are both importable modules (tests call the functions) and command
 * entry points. This helper keeps the entry guard and the child-process failure
 * summary in one place, so a new script cannot drift into a different exit
 * convention or drop the useful tail of a failing process.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Run `main` only when the module is the process entry point.
 *
 * Errors become a non-zero exit and one actionable line; the stack stays out of
 * the default output because a gate report is read by CI and operators.
 *
 * @param {string} importMetaUrl `import.meta.url` of the calling script.
 * @param {() => Promise<void>|void} main Entry function.
 * @param {string} label Stable failure prefix, e.g. `test-coverage`.
 */
export function runScript(importMetaUrl, main, label) {
  if (process.argv[1] === undefined || resolve(process.argv[1]) !== fileURLToPath(importMetaUrl)) return
  Promise.resolve()
    .then(main)
    .catch((error) => {
      console.error(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    })
}

/**
 * The last lines of a child process, for a bounded failure message.
 *
 * @param {{stdout?: string, stderr?: string}} result `spawnSync` result.
 * @param {number} [maxLines] Keep the last N lines.
 * @returns {string}
 */
export function failureTail(result, maxLines = 25) {
  return [result.stdout, result.stderr]
    .filter((value) => typeof value === 'string' && value.trim() !== '')
    .join('\n')
    .trim()
    .split('\n')
    .slice(-maxLines)
    .join('\n')
}
