#!/usr/bin/env node
/**
 * Working-tree identity shared by the coverage lanes and their checker.
 *
 * The lane records the state it measured; the gate refuses a report whose
 * recorded HEAD or porcelain set no longer matches the live tree, so a stale
 * report cannot be presented as current evidence.
 */
import { spawnSync } from 'node:child_process'

/**
 * @param {string} cwd Repository working directory.
 * @returns {{head: string, dirty: boolean, gitStatus: string[]}}
 * @throws {Error} when git is unavailable or the directory is not a work tree.
 */
export function gitState(cwd) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' })
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' })
  if (head.error !== undefined) throw head.error
  if (status.error !== undefined) throw status.error
  if (head.status !== 0 || status.status !== 0) {
    throw new Error('coverage artifact: git state is unavailable')
  }
  const porcelain = status.stdout.split('\n').filter((line) => line !== '')
  return {
    head: head.stdout.trim(),
    dirty: porcelain.length > 0,
    gitStatus: porcelain.slice(0, 200),
  }
}
