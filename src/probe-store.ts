/**
 * Atomic probe store: the host's cross-process writer lock plus its
 * random-suffix temp + rename replacement, then an explicit directory fsync
 * because `writeFileAtomic` documents crash durability as out of scope.
 */
import { open, readFile, readdir } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** Write `content` to `file` atomically and durably (file via rename, then the parent directory). */
export async function writeStoreAtomic(file: string, content: string): Promise<void> {
  await withFileLock(file, async () => {
    await writeFileAtomic(file, content, { mode: 0o600, dirMode: 0o700 })
    await fsyncDirectory(dirname(file))
  }, { waitMs: 5000 })
}

/** Read the store's raw UTF-8 text. */
export async function readStoreText(file: string): Promise<string> {
  return readFile(file, 'utf8')
}

/** Flush a directory entry so a rename survives a crash. */
export async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Temp siblings `writeFileAtomic` would leave behind on failure (empty after success). */
export async function listAtomicTempSiblings(file: string): Promise<string[]> {
  const prefix = `${basename(file)}.`
  const names = await readdir(dirname(file))
  return names.filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'))
}
