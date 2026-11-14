/**
 * Shared atomic JSON primitives for every store that writes under
 * `<repo>/.dsh-cowork/`.
 *
 * The host's `writeFileAtomic` helper replaces a file by renaming a temp
 * sibling, but documents crash durability as out of scope, so every writer here
 * fsyncs the parent directory after the rename. Several stores used to restate
 * the same modes, lock wait and helpers; this module is the one definition, so
 * a change to the lock wait or file mode cannot fork per store.
 *
 * Semantics kept from the stores this module replaces: files are 0600,
 * directories 0700, a writer waits up to {@link LOCK_WAIT_MS} for the shared
 * project lock, and reads stay lock-free.
 */
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** File mode for every document these stores write (owner read/write only). */
export const FILE_MODE = 0o600

/** Directory mode for every directory these stores create. */
export const DIR_MODE = 0o700

/** How long a writer waits for the project lock before failing. */
export const LOCK_WAIT_MS = 5000

/** Name of the one writer lock shared by every store under `.dsh-cowork/`. */
export const LOCK_FILE_NAME = '.write.lock'

/** Flush a directory entry so a completed rename survives a crash. */
export async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Read a file as UTF-8 text, or `undefined` when it does not exist. */
export async function readTextIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
}

/** Write text atomically (private temp sibling, rename, then directory fsync). */
export async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: DIR_MODE })
  await writeFileAtomic(filePath, content, { mode: FILE_MODE, dirMode: DIR_MODE })
  await fsyncDirectory(dirname(filePath))
}

/** Write one JSON document atomically, with the repository's stable formatting. */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Run `operation` while holding the project writer lock, creating the project
 * directory first. This is the one lock entry point every store uses.
 */
export async function withProjectLock<T>(lockFile: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockFile), { recursive: true, mode: DIR_MODE })
  return withFileLock(lockFile, operation, { waitMs: LOCK_WAIT_MS })
}
