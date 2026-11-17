/**
 * Content identity of the E2E catalog.
 *
 * The evidence summary must not survive an edit to the manifest, a scenario
 * body, the coverage debt, or a support helper: those files define what the
 * recorded run actually executed. The digest covers every file under
 * `tests/e2e/` except the `evidence/` directory (recording evidence must not
 * change the identity it records).
 */

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/**
 * @param {string} testsE2eDir Absolute `tests/e2e` directory.
 * @returns {Promise<string>} Sorted-content SHA-256, 64 lowercase hex.
 */
export async function catalogSha256(testsE2eDir) {
  const files = await collectFiles(testsE2eDir, testsE2eDir)
  const hash = createHash('sha256')
  for (const rel of files) {
    hash.update(`${rel}\0`)
    hash.update(await readFile(join(testsE2eDir, rel)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function collectFiles(root, current) {
  const entries = await readdir(current, { withFileTypes: true })
  const found = []
  for (const entry of entries) {
    const full = join(current, entry.name)
    if (entry.isDirectory()) {
      if (current === root && entry.name === 'evidence') continue
      found.push(...await collectFiles(root, full))
    } else if (entry.isFile()) {
      found.push(relative(root, full).split(sep).join('/'))
    }
  }
  return found.sort()
}
