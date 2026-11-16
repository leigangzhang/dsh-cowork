#!/usr/bin/env node
/**
 * One recursive file walker for the evidence scripts.
 *
 * Discovery rules differ only by suffix (test files, TypeScript sources); the
 * directory traversal and sort order must not drift between them.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @param {string} directory Directory to walk.
 * @param {(name: string) => boolean} accept Basename predicate.
 * @returns {string[]} Sorted absolute file paths.
 */
export function filesIn(directory, accept) {
  const found = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile() && accept(entry.name)) found.push(full)
    }
  }
  visit(directory)
  return found.sort()
}
