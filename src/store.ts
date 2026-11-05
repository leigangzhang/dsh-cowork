/**
 * Project store: the single writer of `<repo>/.dsh-cowork/index.json` and of
 * every handoff file under `<repo>/.dsh-cowork/handoffs/`.
 *
 * Writers serialize through `withFileLock` on `.dsh-cowork/.write.lock`; each
 * replacement is `writeFileAtomic` (exclusive-create random-suffix sibling +
 * rename, mode 0600) followed by an explicit parent-directory fsync, because
 * the host helper documents crash durability as out of scope. Readers stay
 * lock-free: the rename commits complete content, so a read sees the old or
 * the new document, never a half-written one.
 *
 * Reads validate the whole document. A missing index raises
 * `store/not-found`; damaged JSON or a schema mismatch raises `store/corrupt`
 * naming the file. Nothing is rebuilt silently — an index this module cannot
 * trust is a defect the caller has to see.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir, open, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

const execFileAsync = promisify(execFile)

/** Project directory name inside the repository root. */
const PROJECT_DIR_NAME = '.dsh-cowork'
/** Index file name inside the project directory. */
const INDEX_FILE_NAME = 'index.json'
/** Handoff directory name inside the project directory. */
const HANDOFFS_DIR_NAME = 'handoffs'
/** The one writer lock every index and handoff write takes. */
const LOCK_FILE_NAME = '.write.lock'
/** Handoff file suffix. */
const HANDOFF_SUFFIX = '.json'
/** On-disk schema version this module reads and writes. */
const STORE_VERSION = 1
/** How long a writer waits for the project lock before failing. */
const LOCK_WAIT_MS = 5000
/** File mode for every file this store writes. */
const FILE_MODE = 0o600
/** Directory mode for every directory this store creates. */
const DIR_MODE = 0o700
/** Length of the repository-path project id fallback. */
const PROJECT_ID_HASH_LENGTH = 12

/** Lifecycle of one thread as recorded in the project index. */
export type ThreadStatus = 'new' | 'active' | 'awaiting_review' | 'done' | 'blocked' | 'archived'

/** One thread entry of the project index. */
export interface ThreadRecord {
  threadId: string
  subject: string
  status: ThreadStatus
  cwd: string
  /**
   * Thread's isolated clone (`<repo>/.dsh-cowork/threads/<threadId>`), or null
   * for a thread that works in the shared repository. Indexes written before
   * M2 named this field `worktreePath`; {@link normalizeThreadDocument} reads
   * that legacy name and every write emits `checkoutPath` only.
   */
  checkoutPath: string | null
  createdAt: string
  updatedAt: string
  lastHandoffAt: string | null
}

/** The project index document (`<repo>/.dsh-cowork/index.json`). */
export interface ProjectIndex {
  version: 1
  projectId: string
  masterSessionId: string
  createdAt: string
  threads: ThreadRecord[]
}

/** One verification row of a handoff. */
export interface HandoffVerification {
  command: string
  exitCode: number
  evidence: string
}

/** Status a handoff may carry. `new`/`active` are thread states, not handoff states. */
export type HandoffStatus = 'awaiting_review' | 'blocked' | 'done'

/** One handoff document (`<repo>/.dsh-cowork/handoffs/<threadId>-<stamp>.json`). */
export interface HandoffRecord {
  version: 1
  threadId: string
  masterSessionId: string
  status: HandoffStatus
  subject: string
  summary: string
  decisions: string[]
  changedPaths: string[]
  artifacts: string[]
  verification: HandoffVerification[]
  openIssues: string[]
  nextStep: string | null
  createdAt: string
  deliveredAt: string | null
}

/** A handoff record together with where it lives. */
export interface HandoffFile {
  filePath: string
  fileName: string
  record: HandoffRecord
}

/** A store failure carrying a stable code and, when relevant, the offending file. */
export class StoreError extends Error {
  readonly code: string
  readonly filePath: string | undefined

  constructor(code: string, message: string, filePath?: string) {
    super(message)
    this.name = 'StoreError'
    this.code = code
    this.filePath = filePath
  }
}

/** Construction options for {@link ProjectStore}. */
export interface ProjectStoreOptions {
  /** Repository root that owns `.dsh-cowork/`. */
  repoPath: string
  /** Injected clock; every timestamp this store writes comes from it. */
  clock?: () => Date
  /** Explicit project id; defaults to `projectIdFor(repoPath)` on first init. */
  projectId?: string
}

const THREAD_STATUSES: readonly ThreadStatus[] = [
  'new',
  'active',
  'awaiting_review',
  'done',
  'blocked',
  'archived',
]

const HANDOFF_STATUSES: readonly HandoffStatus[] = ['awaiting_review', 'blocked', 'done']

/** Whether a value is a JSON object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a value is a string with non-whitespace content. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** Whether a value is a string that `Date.parse` accepts. */
function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

/** Whether a value is an array of strings. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** Schema problems of one thread record, addressed by `where`. */
function threadProblems(thread: unknown, where: string): string[] {
  if (!isRecord(thread)) return [`${where} must be an object`]
  const problems: string[] = []
  if (!isNonEmptyString(thread.threadId)) problems.push(`${where}.threadId must be a non-empty string`)
  if (typeof thread.subject !== 'string') problems.push(`${where}.subject must be a string`)
  if (!THREAD_STATUSES.includes(thread.status as ThreadStatus)) {
    problems.push(`${where}.status must be one of ${THREAD_STATUSES.join('|')}`)
  }
  if (!isNonEmptyString(thread.cwd)) problems.push(`${where}.cwd must be a non-empty string`)
  if (thread.checkoutPath !== null && typeof thread.checkoutPath !== 'string') {
    problems.push(`${where}.checkoutPath must be a string or null`)
  }
  if (!isIsoDate(thread.createdAt)) problems.push(`${where}.createdAt must be an ISO 8601 timestamp`)
  if (!isIsoDate(thread.updatedAt)) problems.push(`${where}.updatedAt must be an ISO 8601 timestamp`)
  if (thread.lastHandoffAt !== null && !isIsoDate(thread.lastHandoffAt)) {
    problems.push(`${where}.lastHandoffAt must be an ISO 8601 timestamp or null`)
  }
  return problems
}

/**
 * Read one thread record into the current shape: M2 renamed `worktreePath` to
 * `checkoutPath`, and an index written before that rename must still load. The
 * legacy key is consumed here (never copied forward), so a validated record and
 * every rewrite carry `checkoutPath` only.
 */
function normalizeThreadDocument(thread: unknown): unknown {
  if (!isRecord(thread)) return thread
  const { worktreePath, checkoutPath, ...rest } = thread
  const adopted = checkoutPath === undefined ? worktreePath : checkoutPath
  return { ...rest, checkoutPath: adopted === undefined ? null : adopted }
}

/** Normalize every thread of a raw index document; other fields pass through. */
function normalizeIndexDocument(index: unknown): unknown {
  if (!isRecord(index) || !Array.isArray(index.threads)) return index
  return { ...index, threads: index.threads.map(normalizeThreadDocument) }
}

/** Schema problems of a project index document. */
function indexProblems(index: unknown): string[] {
  if (!isRecord(index)) return ['index must be a JSON object']
  const problems: string[] = []
  if (index.version !== STORE_VERSION) problems.push(`index.version must be ${STORE_VERSION}`)
  if (!isNonEmptyString(index.projectId)) problems.push('index.projectId must be a non-empty string')
  if (!isNonEmptyString(index.masterSessionId)) {
    problems.push('index.masterSessionId must be a non-empty string')
  }
  if (!isIsoDate(index.createdAt)) problems.push('index.createdAt must be an ISO 8601 timestamp')
  if (!Array.isArray(index.threads)) {
    problems.push('index.threads must be an array')
  } else {
    index.threads.forEach((thread, position) => {
      problems.push(...threadProblems(thread, `index.threads[${position}]`))
    })
  }
  return problems
}

/** Schema problems of a handoff record this store is asked to persist. */
function handoffProblems(record: unknown): string[] {
  if (!isRecord(record)) return ['handoff must be a JSON object']
  const problems: string[] = []
  if (record.version !== STORE_VERSION) problems.push(`handoff.version must be ${STORE_VERSION}`)
  if (!isNonEmptyString(record.threadId)) problems.push('handoff.threadId must be a non-empty string')
  if (!isNonEmptyString(record.masterSessionId)) {
    problems.push('handoff.masterSessionId must be a non-empty string')
  }
  if (!HANDOFF_STATUSES.includes(record.status as HandoffStatus)) {
    problems.push(`handoff.status must be one of ${HANDOFF_STATUSES.join('|')}`)
  }
  if (!isNonEmptyString(record.subject)) problems.push('handoff.subject must be a non-empty string')
  if (!isNonEmptyString(record.summary)) problems.push('handoff.summary must be a non-empty string')
  for (const field of ['decisions', 'changedPaths', 'artifacts', 'openIssues'] as const) {
    if (!isStringArray(record[field])) problems.push(`handoff.${field} must be an array of strings`)
  }
  if (!Array.isArray(record.verification) || record.verification.length === 0) {
    problems.push('handoff.verification must be a non-empty array')
  } else {
    record.verification.forEach((row, position) => {
      const where = `handoff.verification[${position}]`
      if (!isRecord(row)) {
        problems.push(`${where} must be an object`)
        return
      }
      if (!isNonEmptyString(row.command)) problems.push(`${where}.command must be a non-empty string`)
      if (!Number.isInteger(row.exitCode)) problems.push(`${where}.exitCode must be an integer`)
      if (typeof row.evidence !== 'string') problems.push(`${where}.evidence must be a string`)
    })
  }
  if (record.nextStep !== null && typeof record.nextStep !== 'string') {
    problems.push('handoff.nextStep must be a string or null')
  }
  if (!isIsoDate(record.createdAt)) problems.push('handoff.createdAt must be an ISO 8601 timestamp')
  if (record.deliveredAt !== null && !isIsoDate(record.deliveredAt)) {
    problems.push('handoff.deliveredAt must be an ISO 8601 timestamp or null')
  }
  return problems
}

/** The error message body for a set of schema problems. */
function problemMessage(prefix: string, filePath: string, problems: string[]): string {
  return `${prefix} (${filePath}): ${problems.join('; ')}`
}

/** Flush a directory entry so a completed rename survives a crash. */
async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Read a file as UTF-8 text, or `undefined` when it does not exist. */
async function readTextIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
}

/**
 * Read a document this store owns. A missing file is `store/not-found`; any
 * other read failure (a directory where the document belongs, a permission
 * change) is a damaged store and is reported with the path.
 */
async function readDocument(filePath: string, label: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    const failure = error as NodeJS.ErrnoException
    if (failure.code === 'ENOENT' || failure.code === 'ENOTDIR') {
      throw new StoreError('store/not-found', `${label} not found: ${filePath}`, filePath)
    }
    throw new StoreError('store/corrupt', `${filePath}: unreadable (${failure.message})`, filePath)
  }
}

/** Format a timestamp as the handoff filename stamp `YYYYMMDDTHHmmssSSSZ` in UTC. */
function handoffStamp(createdAt: Date): string {
  if (Number.isNaN(createdAt.getTime())) {
    throw new StoreError('store/invalid-time', 'handoff createdAt is not a valid Date')
  }
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return [
    pad(createdAt.getUTCFullYear(), 4),
    pad(createdAt.getUTCMonth() + 1),
    pad(createdAt.getUTCDate()),
    'T',
    pad(createdAt.getUTCHours()),
    pad(createdAt.getUTCMinutes()),
    pad(createdAt.getUTCSeconds()),
    pad(createdAt.getUTCMilliseconds(), 3),
    'Z',
  ].join('')
}

export class ProjectStore {
  /** Repository root that owns the project directory. */
  readonly repoPath: string
  /** `<repo>/.dsh-cowork`. */
  readonly projectDir: string
  /** `<repo>/.dsh-cowork/handoffs`. */
  readonly handoffsDir: string
  /** `<repo>/.dsh-cowork/index.json`. */
  readonly indexFile: string
  /** `<repo>/.dsh-cowork/.write.lock` (the writers' lock; `withFileLock` owns the sibling). */
  readonly lockFile: string
  private readonly clock: () => Date
  private readonly explicitProjectId: string | undefined

  constructor(options: ProjectStoreOptions) {
    this.repoPath = resolve(options.repoPath)
    this.projectDir = join(this.repoPath, PROJECT_DIR_NAME)
    this.handoffsDir = join(this.projectDir, HANDOFFS_DIR_NAME)
    this.indexFile = join(this.projectDir, INDEX_FILE_NAME)
    this.lockFile = join(this.projectDir, LOCK_FILE_NAME)
    this.clock = options.clock ?? ((): Date => new Date())
    this.explicitProjectId = options.projectId
  }

  /** Value of the injected clock, used for every timestamp this store stamps. */
  private now(): Date {
    return this.clock()
  }

  /** Whether the project index file exists. */
  async hasIndex(): Promise<boolean> {
    try {
      const info = await stat(this.indexFile)
      return info.isFile()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return false
      throw error
    }
  }

  /** Read and validate the project index. Never rebuilds a missing or damaged index. */
  async readIndex(): Promise<ProjectIndex> {
    const text = await readDocument(this.indexFile, 'project index')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new StoreError(
        'store/corrupt',
        `${this.indexFile}: invalid JSON (${(error as Error).message})`,
        this.indexFile,
      )
    }
    const normalized = normalizeIndexDocument(parsed)
    const problems = indexProblems(normalized)
    if (problems.length > 0) {
      throw new StoreError(
        'store/corrupt',
        problemMessage('project index is invalid', this.indexFile, problems),
        this.indexFile,
      )
    }
    return normalized as ProjectIndex
  }

  /**
   * Create the index for `masterSessionId` once. An existing index wins and its
   * `masterSessionId` is never replaced; a damaged one raises `store/corrupt`.
   */
  async initIndex(masterSessionId: string): Promise<{ index: ProjectIndex; created: boolean }> {
    if (!isNonEmptyString(masterSessionId)) {
      throw new StoreError('store/invalid', 'masterSessionId must be a non-empty string')
    }
    if (await this.hasIndex()) return { index: await this.readIndex(), created: false }
    await this.ensureProjectDir()
    return this.withLock(async () => {
      // Re-check under the lock: another writer may have initialized meanwhile.
      if (await this.hasIndex()) return { index: await this.readIndex(), created: false }
      const projectId = this.explicitProjectId ?? (await projectIdFor(this.repoPath))
      const index: ProjectIndex = {
        version: STORE_VERSION,
        projectId,
        masterSessionId,
        createdAt: this.now().toISOString(),
        threads: [],
      }
      await this.writeJson(this.indexFile, index)
      return { index, created: true }
    })
  }

  /**
   * Run `mutator` against the current index under the project lock and persist
   * its result in one atomic write. Concurrent callers are serialized, so no
   * read-modify-write cycle can resurrect a replaced state.
   */
  async mutateIndex(mutator: (index: ProjectIndex) => ProjectIndex): Promise<ProjectIndex> {
    await this.ensureProjectDir()
    return this.withLock(async () => {
      const current = await this.readIndex()
      const next = mutator(current)
      const problems = indexProblems(next)
      if (problems.length > 0) {
        throw new StoreError(
          'store/invalid',
          problemMessage('mutated project index is invalid', this.indexFile, problems),
          this.indexFile,
        )
      }
      await this.writeJson(this.indexFile, next)
      return next
    })
  }

  /** Append one thread record; a duplicate `threadId` is rejected. */
  async addThread(record: ThreadRecord): Promise<ProjectIndex> {
    const problems = threadProblems(record, 'thread')
    if (problems.length > 0) {
      throw new StoreError('store/invalid-thread', problemMessage('thread record is invalid', this.indexFile, problems), this.indexFile)
    }
    return this.mutateIndex((index) => {
      if (index.threads.some((thread) => thread.threadId === record.threadId)) {
        throw new StoreError(
          'store/thread-exists',
          `thread already exists in ${this.indexFile}: ${record.threadId}`,
          this.indexFile,
        )
      }
      return { ...index, threads: [...index.threads, record] }
    })
  }

  /** Merge `patch` into one thread and stamp `updatedAt` from the clock. */
  async updateThread(
    threadId: string,
    patch: Partial<
      Pick<ThreadRecord, 'subject' | 'status' | 'cwd' | 'checkoutPath' | 'updatedAt' | 'lastHandoffAt'>
    >,
  ): Promise<ProjectIndex> {
    return this.mutateIndex((index) => {
      const position = index.threads.findIndex((thread) => thread.threadId === threadId)
      if (position < 0) {
        throw new StoreError(
          'store/thread-not-found',
          `thread not found in ${this.indexFile}: ${threadId}`,
          this.indexFile,
        )
      }
      const current = index.threads[position]
      // Undefined patch values mean "leave as is", so a caller can pass a sparse object.
      const merged: ThreadRecord = {
        threadId: current.threadId,
        subject: patch.subject ?? current.subject,
        status: patch.status ?? current.status,
        cwd: patch.cwd ?? current.cwd,
        checkoutPath: patch.checkoutPath === undefined ? current.checkoutPath : patch.checkoutPath,
        createdAt: current.createdAt,
        updatedAt: patch.updatedAt ?? this.now().toISOString(),
        lastHandoffAt: patch.lastHandoffAt === undefined ? current.lastHandoffAt : patch.lastHandoffAt,
      }
      const threads = index.threads.map((thread, at) => (at === position ? merged : thread))
      return { ...index, threads }
    })
  }

  /**
   * Read arbitrary text this project owns (the memory files). A missing file is
   * `null`; every other failure propagates, because an append must not treat an
   * unreadable file as empty and overwrite it.
   */
  async readText(absPath: string): Promise<string | null> {
    const text = await readTextIfPresent(absPath)
    return text === undefined ? null : text
  }

  /**
   * Write arbitrary text (the memory files) through the same atomic path as the
   * index: exclusive-create temp sibling, rename, then fsync the parent.
   * The caller holds {@link withWriteLock} across its read-modify-write cycle;
   * this method never takes the lock itself, so nesting cannot deadlock.
   */
  async writeTextAtomic(absPath: string, content: string): Promise<void> {
    await mkdir(dirname(absPath), { recursive: true, mode: DIR_MODE })
    await writeFileAtomic(absPath, content, { mode: FILE_MODE, dirMode: DIR_MODE })
    await fsyncDirectory(dirname(absPath))
  }

  /**
   * Run an arbitrary read-modify-write cycle under the project write lock, the
   * same serialization every index and handoff writer uses.
   */
  async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.withLock(operation)
  }

  /** Every handoff file, ordered by `createdAt` epoch (then by file name). */
  async listHandoffs(): Promise<HandoffFile[]> {
    let names: string[]
    try {
      names = await readdir(this.handoffsDir)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return []
      throw error
    }
    const files: HandoffFile[] = []
    for (const fileName of names.filter((name) => name.endsWith(HANDOFF_SUFFIX)).sort()) {
      const filePath = join(this.handoffsDir, fileName)
      files.push({ filePath, fileName, record: await this.readHandoff(filePath) })
    }
    // File names only guarantee uniqueness; ordering is the record's own timestamp.
    return files.sort((left, right) => {
      const delta = Date.parse(left.record.createdAt) - Date.parse(right.record.createdAt)
      if (delta !== 0) return delta
      return left.fileName.localeCompare(right.fileName)
    })
  }

  /** Read and validate one handoff file. */
  async readHandoff(filePath: string): Promise<HandoffRecord> {
    const absolute = isAbsolute(filePath) ? filePath : resolve(this.repoPath, filePath)
    const text = await readDocument(absolute, 'handoff file')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new StoreError(
        'store/corrupt',
        `${absolute}: invalid JSON (${(error as Error).message})`,
        absolute,
      )
    }
    const problems = handoffProblems(parsed)
    if (problems.length > 0) {
      throw new StoreError(
        'store/corrupt',
        problemMessage('handoff is invalid', absolute, problems),
        absolute,
      )
    }
    return parsed as HandoffRecord
  }

  /**
   * Write one handoff file under the project lock. The default file name comes
   * from the record's own `createdAt`, so the file name is predictable; a
   * second write to the same name is rejected instead of overwriting a source
   * of truth.
   */
  async writeHandoff(record: HandoffRecord, fileName?: string): Promise<HandoffFile> {
    const problems = handoffProblems(record)
    if (problems.length > 0) {
      throw new StoreError(
        'store/invalid-handoff',
        problemMessage('handoff record is invalid', this.handoffsDir, problems),
        this.handoffsDir,
      )
    }
    const name = fileName ?? handoffFileName(record.threadId, new Date(record.createdAt))
    if (basename(name) !== name || !name.endsWith(HANDOFF_SUFFIX)) {
      throw new StoreError('store/invalid', `handoff file name must be a plain <name>.json: ${name}`)
    }
    await this.ensureProjectDir()
    return this.withLock(async () => {
      const filePath = join(this.handoffsDir, name)
      if ((await readTextIfPresent(filePath)) !== undefined) {
        throw new StoreError('store/handoff-exists', `handoff file already exists: ${filePath}`, filePath)
      }
      await this.writeJson(filePath, record)
      return { filePath, fileName: name, record }
    })
  }

  /** Record successful delivery by rewriting `deliveredAt` in place. */
  async markHandoffDelivered(filePath: string, deliveredAt: string): Promise<HandoffFile> {
    if (!isIsoDate(deliveredAt)) {
      throw new StoreError('store/invalid', `deliveredAt must be an ISO 8601 timestamp: ${deliveredAt}`)
    }
    const absolute = isAbsolute(filePath) ? filePath : resolve(this.repoPath, filePath)
    await this.ensureProjectDir()
    return this.withLock(async () => {
      const record = await this.readHandoff(absolute)
      const next: HandoffRecord = { ...record, deliveredAt }
      await this.writeJson(absolute, next)
      return { filePath: absolute, fileName: basename(absolute), record: next }
    })
  }

  /** Create the project directory once, before any lock or write touches it. */
  private async ensureProjectDir(): Promise<void> {
    await mkdir(this.projectDir, { recursive: true, mode: DIR_MODE })
  }

  /** Run `operation` while holding the project write lock. */
  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    return withFileLock(this.lockFile, operation, { waitMs: LOCK_WAIT_MS })
  }

  /** Write one JSON document atomically, then flush its directory entry. */
  private async writeJson(filePath: string, value: unknown): Promise<void> {
    const content = `${JSON.stringify(value, null, 2)}\n`
    await writeFileAtomic(filePath, content, { mode: FILE_MODE, dirMode: DIR_MODE })
    await fsyncDirectory(dirname(filePath))
  }
}

/** The file name of one handoff: `<threadId>-YYYYMMDDTHHmmssSSSZ.json` in UTC. */
export function handoffFileName(threadId: string, createdAt: Date): string {
  return `${threadId}-${handoffStamp(createdAt)}${HANDOFF_SUFFIX}`
}

/** The `git remote get-url origin` value, or `undefined` when there is no usable remote. */
async function readOriginRemote(repoPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoPath,
      encoding: 'utf8',
    })
    const remote = String(stdout).trim()
    return remote === '' ? undefined : remote
  } catch {
    // No repository, no remote, or no git binary all mean "fall back to the path hash".
    return undefined
  }
}

/**
 * Normalize a git remote URL into a `<host>-<path>` project id.
 *
 * The host keeps its dots (`github.com`) and loses any port; path segments are
 * lowercased, joined with `-`, and anything outside `[a-z0-9-]` becomes `-`.
 * `https://github.com/Owner/Repo.git` and `git@github.com:Owner/Repo.git` both
 * yield `github.com-owner-repo`. An unparseable remote yields `''` so the
 * caller can fall back to the path hash.
 */
function normalizeRemoteUrl(remote: string): string {
  const value = remote.trim()
  if (value === '') return ''
  let host: string
  let path: string
  const scpLike = /^[^/@\s]+@([^:/\s]+):(.+)$/.exec(value)
  if (scpLike !== null && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    host = scpLike[1]
    path = scpLike[2]
  } else {
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      return ''
    }
    host = parsed.hostname
    path = parsed.pathname
  }
  host = host
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '')
  const segments = path
    .split('/')
    .map((segment) => segment.trim().toLowerCase())
    .filter((segment) => segment !== '')
    .map((segment) => segment.replace(/\.git$/, ''))
    .map((segment) => segment.replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, ''))
    .filter((segment) => segment !== '')
  const parts = [...(host === '' ? [] : [host]), ...segments]
  const normalized = parts.join('-').replace(/[^a-z0-9.-]/g, '-').replace(/^-+|-+$/g, '')
  return normalized
}

/**
 * The project's stable identity: the normalized `origin` remote when the
 * repository has one, otherwise `sha256(realpath(repoPath))` truncated to 12
 * hex characters (a path with no remote still gets a stable id).
 */
export async function projectIdFor(repoPath: string): Promise<string> {
  const resolved = resolve(repoPath)
  const remote = await readOriginRemote(resolved)
  if (remote !== undefined) {
    const normalized = normalizeRemoteUrl(remote)
    if (normalized !== '') return normalized
  }
  return createHash('sha256').update(await realpath(resolved)).digest('hex').slice(0, PROJECT_ID_HASH_LENGTH)
}

/** Walk up from `startPath` to the nearest directory holding `.dsh-cowork/index.json`. */
export async function findProjectRoot(startPath: string): Promise<string | null> {
  let current = resolve(startPath)
  try {
    const info = await stat(current)
    if (info.isFile()) current = dirname(current)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
  }
  for (;;) {
    if ((await readTextIfPresent(join(current, PROJECT_DIR_NAME, INDEX_FILE_NAME))) !== undefined) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * Synchronous {@link findProjectRoot}: walk up from `startPath` to the nearest
 * directory holding `.dsh-cowork/index.json`. The system-prompt section asks
 * this on every prompt assembly, where an async lookup is not available.
 */
export function findProjectRootSync(startPath: string): string | null {
  let current = resolve(startPath)
  try {
    if (statSync(current).isFile()) current = dirname(current)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
  }
  for (;;) {
    if (existsSync(join(current, PROJECT_DIR_NAME, INDEX_FILE_NAME))) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}
