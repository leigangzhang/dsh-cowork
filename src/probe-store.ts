/**
 * Atomic probe store: the host's cross-process writer lock plus the shared
 * atomic text replacement from `src/atomic-json.ts` (rename, then an explicit
 * directory fsync, because `writeFileAtomic` documents crash durability as out
 * of scope).
 */
import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { LOCK_WAIT_MS, writeTextAtomic } from './atomic-json.js'

/** Write `content` to `file` atomically and durably (file via rename, then the parent directory). */
export async function writeStoreAtomic(file: string, content: string): Promise<void> {
  await withFileLock(file, () => writeTextAtomic(file, content), { waitMs: LOCK_WAIT_MS })
}

/** Read the store's raw UTF-8 text. */
export async function readStoreText(file: string): Promise<string> {
  return readFile(file, 'utf8')
}

/** Temp siblings `writeFileAtomic` would leave behind on failure (empty after success). */
export async function listAtomicTempSiblings(file: string): Promise<string[]> {
  const prefix = `${basename(file)}.`
  const names = await readdir(dirname(file))
  return names.filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'))
}
