/**
 * Loopback admission and request-target parsing shared by the panel API and the
 * dev routes. No host imports — the unit tests run this file directly under
 * `node --test` with type stripping.
 */
import { realpathSync } from 'node:fs'

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Whether a socket peer address is a loopback address. */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.has(address)
}

/** Whether a Host header names this machine (a second gate against DNS rebinding). */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false
  const bare = host.replace(/:\d+$/, '')
  return bare === '127.0.0.1' || bare === 'localhost' || bare === '[::1]' || bare === '::1'
}

/**
 * Resolve a repository path to its real path so it compares equal to a host
 * session cwd, which macOS normalizes (`/tmp` → `/private/tmp`). A path that
 * does not exist yet keeps its configured spelling: realpath cannot resolve a
 * suffix that is not on disk, and failing here would break the dev surface
 * before it reports anything.
 */
export function canonicalRepoPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Pathname of a request target, dropping the query. */
export function readPath(url: string | undefined): string {
  if (url === undefined || url === '') return '/'
  const at = url.indexOf('?')
  return at < 0 ? url : url.slice(0, at)
}

/** One query parameter of a request target, or undefined. */
export function readQuery(url: string | undefined, name: string): string | undefined {
  if (url === undefined) return undefined
  const at = url.indexOf('?')
  if (at < 0) return undefined
  const value = new URLSearchParams(url.slice(at + 1)).get(name)
  return value === null ? undefined : value
}

/** Validate a status query's run id. */
export function requireRunId(value: string | undefined): string {
  if (value === undefined || value.trim() === '') throw new Error('runId query parameter is required')
  return value.trim()
}
