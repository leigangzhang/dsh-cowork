/**
 * Artifact store: the only writer of `<repo>/.dsh-cowork/artifacts/`.
 *
 * The layout is one directory per work item (`artifact.json`, `comments.jsonl`,
 * `dispatch.jsonl`, `revisions/`, `uploads/`) plus a project-level
 * `events.jsonl`, all under an independent `.write.lock` so work-item traffic
 * never queues behind the project index. Records and events are replaced
 * atomically; comment/dispatch rows are append-only. Readers stay lock-free:
 * a rename or a complete line is the commit, so a read sees old or new.
 *
 * A damaged record fails its own read as `artifact/corrupt`; a damaged row in a
 * JSONL file is skipped, and the rest of the file stays readable.
 */
import { appendFile, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ARTIFACT_EVENT_LOG_MAX_LINES,
  ARTIFACT_EVENT_VERSION,
  MAX_ARTIFACTS_PER_PROJECT,
  type ArtifactEventV1,
  type ArtifactRecordV1,
  type CommentEventV1,
  type DispatchRecordV1,
} from '../panel/artifact-contract.js'
import { DIR_MODE, FILE_MODE, readTextIfPresent, withProjectLock, writeJsonAtomic } from './atomic-json.js'
import {
  parseArtifactEvent,
  parseArtifactRecord,
  parseCommentEvent,
  parseDispatchRecord,
} from './artifact-schema.js'
import { ArtifactDomainError } from '../domains/artifact/errors.js'

/** Project directory name inside the repository root. */
const PROJECT_DIR_NAME = '.dsh-cowork'
/** Artifact directory name inside the project directory. */
const ARTIFACTS_DIR_NAME = 'artifacts'
/** Per-work-item record file. */
const RECORD_FILE_NAME = 'artifact.json'
/** Per-work-item comment log. */
const COMMENTS_FILE_NAME = 'comments.jsonl'
/** Per-work-item dispatch log. */
const DISPATCH_FILE_NAME = 'dispatch.jsonl'
/** Project-level event log. */
const EVENTS_FILE_NAME = 'events.jsonl'
/** Artifact ids are directory names, so only a safe character set is accepted. */
const SAFE_ARTIFACT_ID = /^artifact-[A-Za-z0-9-]+$/

/** One work-item store failure the routes map onto the shared error envelope. */
export class ArtifactStoreError extends ArtifactDomainError {}

/** What a project scan found: readable records plus the ids that failed to parse. */
export interface ArtifactScan {
  /** Newest-first records, already cut to the requested limit. */
  readonly records: readonly ArtifactRecordV1[]
  readonly corrupt: readonly string[]
  /** Readable records before the limit was applied; drives `truncated`. */
  readonly total: number
}

/** One work-item store rooted at a repository. */
export class ArtifactStore {
  readonly repoPath: string
  readonly root: string
  private readonly lockFile: string

  constructor(repoPath: string) {
    this.repoPath = repoPath
    this.root = join(repoPath, PROJECT_DIR_NAME, ARTIFACTS_DIR_NAME)
    this.lockFile = join(this.root, '.write.lock')
  }

  /** The directory of one work item; the id is validated first. */
  artifactDir(artifactId: string): string {
    assertArtifactId(artifactId)
    return join(this.root, artifactId)
  }

  /** The record path of one work item. */
  recordPath(artifactId: string): string {
    return join(this.artifactDir(artifactId), RECORD_FILE_NAME)
  }

  /** Run `operation` while holding the artifact writer lock. */
  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    return withProjectLock(this.lockFile, operation)
  }

  /**
   * Scan every readable work item, newest `updatedAt` first.
   *
   * The scan is bounded at {@link MAX_ARTIFACTS_PER_PROJECT}; a project holding
   * more is reported as truncated by the caller's comparison. A record that
   * fails to parse is named in `corrupt` and does not hide its neighbours.
   */
  async listRecords(limit: number = MAX_ARTIFACTS_PER_PROJECT): Promise<ArtifactScan> {
    let entries
    try {
      entries = await readdir(this.root, { withFileTypes: true })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return { records: [], corrupt: [], total: 0 }
      throw error
    }
    const records: ArtifactRecordV1[] = []
    const corrupt: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_ARTIFACT_ID.test(entry.name)) continue
      const text = await readTextIfPresent(join(this.root, entry.name, RECORD_FILE_NAME))
      if (text === undefined) continue
      const parsed = parseJson(text)
      const record = parseArtifactRecord(parsed)
      if (record === null) {
        corrupt.push(entry.name)
        continue
      }
      records.push(record)
    }
    records.sort((left, right) => {
      const order = right.updatedAt.localeCompare(left.updatedAt)
      return order !== 0 ? order : left.artifactId.localeCompare(right.artifactId)
    })
    return { records: records.slice(0, limit), corrupt, total: records.length }
  }

  /**
   * Read one work item.
   *
   * A missing file returns null; a file that exists but cannot be parsed
   * throws `artifact/corrupt`, because silently treating it as absent would let
   * the next create overwrite a damaged record.
   */
  async readRecord(artifactId: string): Promise<ArtifactRecordV1 | null> {
    const filePath = this.recordPath(artifactId)
    const text = await readTextIfPresent(filePath)
    if (text === undefined) return null
    const record = parseArtifactRecord(parseJson(text))
    if (record === null) {
      throw new ArtifactStoreError('artifact/corrupt', `artifact record is unreadable: ${filePath}`, filePath)
    }
    return record
  }

  /** Create the first record of a work item; duplicate ids and the cap are errors. */
  async createRecord(record: ArtifactRecordV1): Promise<ArtifactRecordV1> {
    return this.withLock(async () => {
      const scan = await this.listRecords(MAX_ARTIFACTS_PER_PROJECT + 1)
      if (scan.records.some((entry) => entry.artifactId === record.artifactId)) {
        throw new ArtifactStoreError('artifact/duplicate', `artifact already exists: ${record.artifactId}`)
      }
      if (scan.records.length >= MAX_ARTIFACTS_PER_PROJECT) {
        throw new ArtifactStoreError(
          'artifact/limit-reached',
          `project already holds ${MAX_ARTIFACTS_PER_PROJECT} work items`,
        )
      }
      await mkdir(this.artifactDir(record.artifactId), { recursive: true, mode: DIR_MODE })
      await writeJsonAtomic(this.recordPath(record.artifactId), record)
      return record
    })
  }

  /**
   * Read-modify-write one record under the artifact lock.
   *
   * A mutator returning null means "no change": the current record is returned
   * without a write, so a no-op status action cannot bump `updatedAt`.
   */
  async mutateRecord(
    artifactId: string,
    mutator: (record: ArtifactRecordV1) => ArtifactRecordV1 | null,
  ): Promise<ArtifactRecordV1> {
    return this.withLock(() => this.mutateRecordUnlocked(artifactId, mutator))
  }

  /**
   * The no-lock half of {@link mutateRecord}; only valid inside
   * {@link withLock}, and it exists so one transaction can update the record,
   * append a comment, and append the event together.
   */
  async mutateRecordUnlocked(
    artifactId: string,
    mutator: (record: ArtifactRecordV1) => ArtifactRecordV1 | null,
  ): Promise<ArtifactRecordV1> {
    const current = await this.readRecord(artifactId)
    if (current === null) {
      throw new ArtifactStoreError('artifact/not-found', `unknown artifact: ${artifactId}`)
    }
    const next = mutator(current)
    if (next === null) return current
    await writeJsonAtomic(this.recordPath(artifactId), next)
    return next
  }

  /** Append one comment row; the file may not exist yet. */
  async appendComment(event: CommentEventV1): Promise<void> {
    await this.withLock(() => this.appendCommentUnlocked(event))
  }

  /** The no-lock half of {@link appendComment}; only valid inside {@link withLock}. */
  async appendCommentUnlocked(event: CommentEventV1): Promise<void> {
    await this.appendLine(COMMENTS_FILE_NAME, event.artifactId, event)
  }

  /** Every parseable comment row of one work item, in file order. */
  async readComments(artifactId: string): Promise<CommentEventV1[]> {
    return this.readJsonLines(COMMENTS_FILE_NAME, artifactId, parseCommentEvent)
  }

  /** Append one dispatch-state snapshot. */
  async appendDispatch(record: DispatchRecordV1): Promise<void> {
    await this.withLock(() => this.appendDispatchUnlocked(record))
  }

  /** The no-lock half of {@link appendDispatch}; only valid inside {@link withLock}. */
  async appendDispatchUnlocked(record: DispatchRecordV1): Promise<void> {
    await this.appendLine(DISPATCH_FILE_NAME, record.artifactId, record)
  }

  /** The newest parseable dispatch snapshot of one work item, or null. */
  async readLatestDispatch(artifactId: string): Promise<DispatchRecordV1 | null> {
    const rows = await this.readJsonLines(DISPATCH_FILE_NAME, artifactId, parseDispatchRecord)
    return rows.length === 0 ? null : rows[rows.length - 1]
  }

  /**
   * Append one project event, assigning the next `seq` under the lock.
   *
   * Seq is derived from the last parseable line, so a torn trailing line from a
   * crash does not reuse a sequence number.
   */
  async appendEvent(event: Omit<ArtifactEventV1, 'version' | 'seq'>): Promise<ArtifactEventV1> {
    return this.withLock(() => this.appendEventUnlocked(event))
  }

  /** The no-lock half of {@link appendEvent}; only valid inside {@link withLock}. */
  async appendEventUnlocked(event: Omit<ArtifactEventV1, 'version' | 'seq'>): Promise<ArtifactEventV1> {
    const rows = await this.readJsonLines(EVENTS_FILE_NAME, undefined, parseArtifactEvent)
    const last = rows.length === 0 ? 0 : rows[rows.length - 1].seq
    const next: ArtifactEventV1 = { version: ARTIFACT_EVENT_VERSION, seq: last + 1, ...event }
    await this.appendLine(EVENTS_FILE_NAME, undefined, next)
    return next
  }

  /** Event rows after `afterSeq`, capped at the log's line budget. */
  async readEvents(afterSeq = 0): Promise<ArtifactEventV1[]> {
    const rows = await this.readJsonLines(EVENTS_FILE_NAME, undefined, parseArtifactEvent)
    return rows.filter((row) => row.seq > afterSeq).slice(0, ARTIFACT_EVENT_LOG_MAX_LINES)
  }

  /** The newest event sequence of the project, or 0 when the log is empty. */
  async lastEventSeq(): Promise<number> {
    const rows = await this.readJsonLines(EVENTS_FILE_NAME, undefined, parseArtifactEvent)
    return rows.length === 0 ? 0 : rows[rows.length - 1].seq
  }

  /** Append one JSON line to a work-item (or project) log. */
  private async appendLine(
    fileName: string,
    artifactId: string | undefined,
    row: unknown,
  ): Promise<void> {
    const filePath = artifactId === undefined
      ? join(this.root, fileName)
      : join(this.artifactDir(artifactId), fileName)
    await mkdir(artifactId === undefined ? this.root : this.artifactDir(artifactId), {
      recursive: true,
      mode: DIR_MODE,
    })
    await appendFile(filePath, `${JSON.stringify(row)}\n`, { mode: FILE_MODE })
  }

  /** Parse the complete lines of one JSONL log, skipping damaged rows. */
  private async readJsonLines<T>(
    fileName: string,
    artifactId: string | undefined,
    parse: (value: unknown) => T | null,
  ): Promise<T[]> {
    const filePath = artifactId === undefined
      ? join(this.root, fileName)
      : join(this.artifactDir(artifactId), fileName)
    const text = await readTextIfPresent(filePath)
    if (text === undefined) return []
    const rows: T[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      const parsed = parse(parseJson(line))
      if (parsed !== null) rows.push(parsed)
    }
    return rows
  }
}

/** Parse one JSON text, returning a sentinel for damaged input. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Reject an artifact id that is not a safe directory name. */
function assertArtifactId(artifactId: string): void {
  if (!SAFE_ARTIFACT_ID.test(artifactId)) {
    throw new ArtifactStoreError('artifact/not-found', `unknown artifact: ${artifactId}`)
  }
}
