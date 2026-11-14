/**
 * The notice delivery ledger file (`<repo>/.dsh-cowork/notices.json`).
 *
 * Its own module on purpose: `src/store/project-store.ts` sits at the repository's 50 KiB
 * read cap, and the ledger is a small, orthogonal document. The file lives
 * under the same project lock and atomic-write helper as the index, so a ledger
 * write can never interleave with another writer; the reader stays lock-free
 * like every other store read.
 *
 * Errors are values with a stable code; `src/store/project-store.ts` maps them onto its own
 * `StoreError`, which is what the tool and route layers already understand.
 */
import {
  readTextIfPresent,
  withProjectLock,
  writeJsonAtomic,
} from './atomic-json.js'
import { emptyNoticeLedger, parseNoticeLedgerText, prepareNoticeLedger } from '../notices.js'
import type { NoticeLedgerV1 } from '../notices.js'

/** A ledger read/write failure carrying a stable code and the offending file. */
export class NoticeFileError extends Error {
  readonly code: 'corrupt' | 'invalid'
  readonly filePath: string

  constructor(code: 'corrupt' | 'invalid', message: string, filePath: string) {
    super(message)
    this.name = 'NoticeFileError'
    this.code = code
    this.filePath = filePath
  }
}

/** The ledger document as the store reads and writes it. */
export class NoticeLedgerFile {
  readonly projectDir: string
  readonly noticesFile: string
  readonly lockFile: string

  constructor(projectDir: string, noticesFile: string, lockFile: string) {
    this.projectDir = projectDir
    this.noticesFile = noticesFile
    this.lockFile = lockFile
  }

  /** Read the ledger: a missing file is empty, damage is `corrupt`. */
  async read(): Promise<NoticeLedgerV1> {
    const text = await readTextIfPresent(this.noticesFile)
    if (text === undefined) return emptyNoticeLedger()
    const parsed = parseNoticeLedgerText(text)
    if (parsed.jsonError !== null) {
      throw new NoticeFileError('corrupt', `invalid JSON (${parsed.jsonError})`, this.noticesFile)
    }
    if (parsed.ledger === null) {
      throw new NoticeFileError('corrupt', parsed.problems.join('; '), this.noticesFile)
    }
    return parsed.ledger
  }

  /** Validate, trim, and persist a ledger under the project lock. */
  async write(ledger: NoticeLedgerV1): Promise<NoticeLedgerV1> {
    const prepared = prepareNoticeLedger(ledger)
    if (prepared.ledger === null) {
      throw new NoticeFileError('invalid', prepared.problems.join('; '), this.noticesFile)
    }
    const kept = prepared.ledger
    return this.withLock(async () => {
      await this.persist(kept)
      return kept
    })
  }

  /** Locked read-modify-write: concurrent appends must not lose each other. */
  async mutate(mutator: (ledger: NoticeLedgerV1) => NoticeLedgerV1): Promise<NoticeLedgerV1> {
    return this.withLock(async () => {
      const prepared = prepareNoticeLedger(mutator(await this.read()))
      if (prepared.ledger === null) {
        throw new NoticeFileError('invalid', prepared.problems.join('; '), this.noticesFile)
      }
      await this.persist(prepared.ledger)
      return prepared.ledger
    })
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    return withProjectLock(this.lockFile, operation)
  }

  private async persist(ledger: NoticeLedgerV1): Promise<void> {
    await writeJsonAtomic(this.noticesFile, ledger)
  }
}
