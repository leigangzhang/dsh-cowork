/**
 * Throwaway git fixture for one E2E scenario.
 *
 * The fixture is a real repository on a non-protected branch (`e2e-work`), the
 * same invariant the work-item/merge tools require; `main` is only an ancestor
 * ref. It carries the three files the scenarios touch: README, PLAN for the
 * plan request, and a `.gitignore` that keeps `.dsh-cowork/` out of git.
 */

import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

/**
 * @param {string} parent Directory the fixture is created under.
 * @returns {Promise<{path: string, branch: string, mainRef: string, head: string}>}
 */
export async function createFixture(parent) {
  const path = await mkdtemp(join(parent, 'fixture-'))
  git(path, ['init', '-b', 'main'])
  git(path, ['config', 'user.email', 'e2e@dsh-cowork.invalid'])
  git(path, ['config', 'user.name', 'dsh-cowork e2e'])
  await writeFile(join(path, 'README.md'), '# dsh-cowork E2E fixture\n')
  await writeFile(join(path, '.gitignore'), '.dsh-cowork/\n')
  await writeFile(join(path, 'PLAN.md'), '# Fixture plan\n\n1. Keep the fixture deterministic.\n')
  git(path, ['add', 'README.md', '.gitignore', 'PLAN.md'])
  git(path, ['commit', '-m', 'init'])
  const mainRef = git(path, ['rev-parse', 'refs/heads/main'])
  git(path, ['checkout', '-b', 'e2e-work'])
  return { path, branch: 'e2e-work', mainRef, head: git(path, ['rev-parse', 'HEAD']) }
}

/** Remove the fixture tree; safe when it was already removed. */
export async function removeFixture(path) {
  await rm(path, { recursive: true, force: true })
}

/** Read one JSON file, or `undefined` while the writer has not created it yet. */
export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** The project index at `<fixture>/.dsh-cowork/index.json`. */
export function readIndex(fixture) {
  return readJson(join(fixture, '.dsh-cowork', 'index.json'))
}

/** The project request inbox at `<fixture>/.dsh-cowork/inbox.json`. */
export function readInbox(fixture) {
  return readJson(join(fixture, '.dsh-cowork', 'inbox.json'))
}

/** Every `.json` file directly under one `.dsh-cowork` subdirectory, parsed. */
export async function readJsonDirectory(fixture, subdirectory) {
  const directory = join(fixture, '.dsh-cowork', subdirectory)
  let names
  try {
    names = await readdir(directory)
  } catch {
    return []
  }
  const rows = []
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    const value = await readJson(join(directory, name))
    if (value !== undefined) rows.push({ name, value })
  }
  return rows
}

/**
 * Write one file into an isolated clone and commit it, returning the new HEAD.
 * The keyless lane cannot rely on the host bash sandbox, so the reviewed range
 * is prepared by the harness process; the review and merge under test stay real.
 */
export async function commitFile(repositoryPath, fileName, content, message) {
  await writeFile(join(repositoryPath, fileName), `${content}\n`)
  git(repositoryPath, ['add', fileName])
  git(repositoryPath, ['commit', '-m', message])
  return git(repositoryPath, ['rev-parse', 'HEAD'])
}

/** Resolve one commit in a real repository, e.g. the clone HEAD after a commit. */
export function readGitHead(repositoryPath, ref = 'HEAD') {
  return git(repositoryPath, ['rev-parse', ref])
}

/** Parse the activity JSONL, skipping invalid lines the store would skip too. */
export async function readActivity(fixture) {
  const text = await readText(join(fixture, '.dsh-cowork', 'activity.jsonl'))
  if (text === undefined) return []
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // The panel's store reader also skips malformed lines; a scenario that
      // needs them must assert that skip separately.
    }
  }
  return events
}

/** Read a text file, or `undefined`. */
export async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}
