#!/usr/bin/env node
/**
 * Validate the PR title and description structure required by the repository's
 * pr-description skill. This is metadata-only; it never executes PR code.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TITLE = /^(?:feat|fix|docs|test|refactor|chore|perf|build|ci)(?:\([^)]+\))?: \S/u
const HEADINGS = ['## Motivation', '## Changes', '## Testing', '## Evidence']

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * @param {{ title: string, body: string }} input The PR title and body.
 * @returns {{ title: string, headings: string[] }} The validated metadata.
 * @throws {Error} When the title or one of the required headings is missing.
 */
export function validatePrMetadata({ title, body }) {
  if (!TITLE.test(String(title ?? ''))) {
    throw new Error('PR title must follow Conventional Commits, for example "feat(scope): summary"')
  }
  const text = String(body ?? '')
  for (const heading of HEADINGS) {
    const pattern = new RegExp(`^${escapeRegExp(heading)}[ \\t]*$`, 'mu')
    if (!pattern.test(text)) {
      throw new Error(`PR body is missing required heading: ${heading}`)
    }
  }
  return { title, headings: HEADINGS }
}

const invoked = process.argv[1]
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  try {
    validatePrMetadata({
      title: process.env.PR_TITLE ?? '',
      body: process.env.PR_BODY ?? '',
    })
    process.stdout.write('pr-metadata: ok\n')
  } catch (error) {
    process.stderr.write(`pr-metadata: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
