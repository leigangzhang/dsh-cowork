#!/usr/bin/env node
/**
 * M12 / KI-22 migration drill: prove a real v1 project index migrates to v2 and
 * comes back, on a throwaway repository under `os.tmpdir()`.
 *
 * The drill seeds a full-field v1 index (all six thread states, the M3 review
 * fields, and one pending review request file) into a temporary repository, then
 * drives the store the way a user does — `ProjectStore.updateThread`, which
 * re-reads the index under the write lock through the on-write migration entry
 * (`ProjectStore.readIndexForWrite`). Nothing here calls `migrateV1ToV2` or
 * writes `index.json` as v2 by hand, so the drill proves the migration path the
 * plugin actually ships.
 *
 * What one run asserts, in order (one evidence step each):
 *
 *   1. a temporary repository is created inside `os.tmpdir()`;
 *   2. the v1 input validates and its snapshot hash is recorded;
 *   3. a read projects v1 to v2 in memory and changes no byte on disk;
 *   4. the first write migrates: the report names v1 → v2 and archives the
 *      reviewer of the cancelled in-flight review;
 *   5. the on-disk document is v2 and passes `projectIndexV2Problems`;
 *   6. `index.v1.backup.json` is byte-identical to the input v1 (sha256);
 *   7. `activity.jsonl` carries the migration event with the status counts;
 *   8. a second read and a second write never migrate again and never replace
 *      the backup;
 *   9. a repo whose archive port refuses records `archiveFailures` and an
 *      activity `error` row instead of claiming the review was safely
 *      cancelled — and still commits v2 (no half-migrated index);
 *  10. restoring the backup and dropping the files the migration added returns
 *      the directory to its pre-migration bytes, and `store.readIndex` reads the
 *      old document again;
 *  11. the temporary repository is removed unless `--keep` was passed.
 *
 * Output and exit codes:
 *
 *   stdout  exactly one JSON evidence document (machine-readable, always)
 *   stderr  human-readable step lines
 *   exit 0  every assertion passed
 *   exit 1  an assertion or an operation failed (evidence is still emitted, and
 *           written to `--evidence` when given)
 *   exit 2  usage error (no drill runs, no evidence)
 *
 * Flags: `--evidence=<path>`, `--keep`, `--seed=<v1-index.json>`. `--seed`
 * replaces the built-in snapshot; the drill validates it and fails (exit 1)
 * before any store write when it is not a valid v1 document.
 *
 * Safety: every file the drill writes lives under its own `mkdtemp` root, and
 * `assertInsideTmpdir` runs before each write root is used. The drill never
 * reads or writes the real project's `.dsh-cowork/`, whose v1 `index.json`
 * would migrate on the first write.
 *
 * `src/*.ts` imports its siblings with the build's `.js` specifiers, so this
 * tool installs the same resolve hook tests/*.mjs and tools/panel-fixture.mjs
 * use; it imports the source directly and needs no built `lib/`.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const HOOK_SOURCE = [
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier.startsWith('.') && specifier.endsWith('.js')) {",
  "    try { return await nextResolve(specifier.slice(0, -3) + '.ts', context) } catch {}",
  '  }',
  '  return nextResolve(specifier, context)',
  '}',
].join('\n')
register(`data:text/javascript,${encodeURIComponent(HOOK_SOURCE)}`)

const { ProjectStore } = await import(new URL('../src/store/project-store.ts', import.meta.url).href)
const {
  INDEX_VERSION_V1,
  INDEX_VERSION_V2,
  normalizeProjectIndexV1,
  projectIndexV1Problems,
  projectIndexV2Problems,
} = await import(new URL('../src/store/schema.ts', import.meta.url).href)
const { reviewRequestRecordProblems, serializeReviewRequestRecord } = await import(
  new URL('../src/review-request.ts', import.meta.url).href
)

/** Project data directory name, the only directory the partner writes here. */
const PROJECT_DIR = '.dsh-cowork'
/** Store file names the drill compares. */
const INDEX_FILE = 'index.json'
const BACKUP_FILE = 'index.v1.backup.json'
const ACTIVITY_FILE = 'activity.jsonl'

/** Deterministic identities of the seeded project. */
const DRILL_PROJECT_ID = 'project-m12-drill'
const DRILL_MASTER_ID = 'session-master'
const CREATED_AT = '2026-11-05T03:04:05.006Z'
const UPDATED_AT = '2026-11-07T09:00:00.000Z'
/** Frozen clock: the drill's evidence must not depend on wall time. */
const FIXED_NOW = '2026-11-08T12:00:00.000Z'

/** The pending review request the v1 snapshot carries. */
const REVIEW_TOPIC_ID = 'topic-review'
const REVIEW_REQUEST_ID = 'request-1'
const REVIEWER_SESSION_ID = 'session-reviewer'
/** What the failing archive port raises in the second scenario. */
const ARCHIVE_FAILURE_MESSAGE = 'drill: the host refused to archive the reviewer'

/** The steps one successful run records, in contract order. */
const STEP_IDS = [
  'create-temp-repo',
  'seed-v1-index',
  'read-does-not-migrate',
  'first-write-migrates',
  'v2-document-shape',
  'backup-byte-identical',
  'activity-records-migration',
  'second-write-idempotent',
  'reviewer-archive-failure',
  'rollback-restores-v1',
  'temp-cleanup',
]

/** A usage problem: exit code 2, no drill. */
class UsageError extends Error {}

/** The CLI contract printed by `--help` and on a usage error. */
const USAGE = [
  'usage: node tools/m12-migration-drill.mjs [--evidence=<path>] [--keep] [--seed=<v1-index.json>]',
  '',
  'Drill the v1 → v2 project-index migration and its rollback on a throwaway',
  'repository under os.tmpdir(); the real .dsh-cowork is never read or written.',
  '  --evidence=<path>  also write the machine-readable evidence JSON to this path',
  '  --keep            keep the throwaway repository instead of removing it',
  '  --seed=<path>     drill a v1 index file instead of the built-in snapshot',
  '',
  'exit codes: 0 every assertion passed, 1 an assertion failed, 2 usage error',
].join('\n')

/** sha256 of bytes or text, lowercase hex. */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** A failure message that never carries a stack or a secret. */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Throw unless `condition`; the step runner records the message. */
function check(condition, message) {
  if (!condition) throw new Error(message)
}

/** Refuse a path outside `os.tmpdir()` before the drill writes under it. */
function assertInsideTmpdir(target) {
  const root = resolve(tmpdir())
  const inside = relative(root, resolve(target))
  check(
    inside !== '' && !inside.startsWith('..') && !isAbsolute(inside),
    `refusing to write outside os.tmpdir(): ${target}`,
  )
}

/** Parse the CLI flags; unknown or malformed flags are usage errors. */
function parseArgs(argv) {
  const options = { evidence: null, seed: null, keep: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }
    if (argument === '--keep') {
      options.keep = true
      continue
    }
    const match = /^--(evidence|seed)(?:=(.*))?$/.exec(argument)
    if (match === null) {
      if (argument.startsWith('--keep=')) throw new UsageError('--keep takes no value')
      throw new UsageError(`unexpected argument: ${argument}`)
    }
    const name = match[1]
    let value = match[2]
    if (value === undefined) {
      index += 1
      value = argv[index]
      if (value === undefined) throw new UsageError(`--${name} needs a value`)
    }
    if (value.trim() === '') throw new UsageError(`--${name} needs a non-empty value`)
    options[name] = resolve(value)
  }
  return options
}

/** One v1 thread record carrying every v1 field, as the pre-M7 store wrote it. */
function v1Thread(overrides) {
  return {
    threadId: '',
    subject: '',
    status: 'active',
    cwd: '/repo',
    checkoutPath: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    lastHandoffAt: null,
    reviewStatus: null,
    reviewRequestedAt: null,
    reviewedAt: null,
    reviewerSessionId: null,
    latestReviewPath: null,
    ...overrides,
  }
}

/** The built-in full-field v1 snapshot: all six thread states in one document. */
function builtinV1Index(reviewRequestPath) {
  return {
    version: INDEX_VERSION_V1,
    projectId: DRILL_PROJECT_ID,
    masterSessionId: DRILL_MASTER_ID,
    createdAt: CREATED_AT,
    threads: [
      v1Thread({ threadId: 'topic-new', subject: 'draft the wireframe', status: 'new' }),
      v1Thread({
        threadId: 'topic-active',
        subject: 'wire the store',
        status: 'active',
        checkoutPath: '/repo/.dsh-cowork/threads/topic-active',
        lastHandoffAt: UPDATED_AT,
      }),
      v1Thread({
        threadId: REVIEW_TOPIC_ID,
        subject: 'ship the review path',
        status: 'awaiting_review',
        reviewStatus: 'pending',
        reviewRequestedAt: UPDATED_AT,
        reviewerSessionId: REVIEWER_SESSION_ID,
        latestReviewPath: reviewRequestPath,
      }),
      v1Thread({ threadId: 'topic-blocked', subject: 'blocked on the merge', status: 'blocked' }),
      v1Thread({
        threadId: 'topic-done',
        subject: 'land the store',
        status: 'done',
        reviewStatus: 'pass',
        reviewedAt: UPDATED_AT,
      }),
      v1Thread({ threadId: 'topic-archived', subject: 'retire the old thread', status: 'archived' }),
    ],
  }
}

/** One pending v1 review request file the migration must leave alone. */
function pendingReviewRequest(repoPath) {
  return {
    version: 1,
    requestId: REVIEW_REQUEST_ID,
    topicId: REVIEW_TOPIC_ID,
    workItemId: null,
    purpose: 'M12 drill: a v1 review request still pending when the index migrates',
    notes: 'seeded before migration; the drill proves this file survives byte for byte',
    extra: {},
    baseCommit: 'a1b2c3d',
    headCommit: 'a1b2c3d',
    path: repoPath,
    branch: null,
    changedPaths: [],
    verification: [
      { command: 'node tools/m12-migration-drill.mjs', exitCode: 0, evidence: 'fixture row' },
    ],
    previousRequestId: null,
    status: 'pending',
    reviewerSessionId: REVIEWER_SESSION_ID,
    requestedAt: UPDATED_AT,
    reviewedAt: null,
    summary: null,
    findings: [],
    reviewVerification: [],
  }
}

/** Schema problems of a v1 index text, addressed the way the store reads it. */
function v1ProblemsOfText(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return [`the seed is not valid JSON (${describe(error)})`]
  }
  return projectIndexV1Problems(normalizeProjectIndexV1(parsed))
}

/** The six-state counts the migration report and activity row must carry. */
function statusCountsOf(threads) {
  const counts = { new: 0, active: 0, awaiting_review: 0, done: 0, blocked: 0, archived: 0 }
  for (const thread of threads) counts[thread.status] += 1
  return counts
}

/** The reviewers the write-path migration must report for archiving. */
function pendingArchivesOf(threads) {
  return threads
    .filter((thread) => thread.status === 'awaiting_review' && thread.reviewerSessionId !== null)
    .map((thread) => ({ topicId: thread.threadId, reviewerSessionId: thread.reviewerSessionId }))
}

/** sha256 of every regular file under `root`, keyed by POSIX relative path. */
async function snapshotTree(root) {
  const files = {}
  const walk = async (directory, prefix) => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(absolute, relativePath)
      else if (entry.isFile()) files[relativePath] = sha256(await readFile(absolute))
      else files[relativePath] = 'not-a-regular-file'
    }
  }
  await walk(root, '')
  return { files, hash: sha256(JSON.stringify(files)) }
}

/**
 * Seed one temporary repository with the v1 index (and, for the built-in
 * snapshot, the pending review request it points at).
 *
 * `--seed` is written byte for byte so the backup comparison stays honest; the
 * built-in snapshot is serialized once. Both are validated with the store's own
 * v1 validator before the drill proceeds.
 */
async function seedV1(repoPath, seedPath) {
  const projectDir = join(repoPath, PROJECT_DIR)
  const reviewsDir = join(projectDir, 'reviews')
  assertInsideTmpdir(projectDir)
  await mkdir(reviewsDir, { recursive: true, mode: 0o700 })

  if (seedPath !== null) {
    const text = await readFile(seedPath, 'utf8')
    const problems = v1ProblemsOfText(text)
    check(problems.length === 0, `the --seed document is not a valid v1 index: ${problems.join('; ')}`)
    const threads = normalizeProjectIndexV1(JSON.parse(text)).threads
    await writeFile(join(projectDir, INDEX_FILE), text, { mode: 0o600 })
    return {
      source: 'seed',
      seedPath,
      text,
      sha256: sha256(text),
      threads,
      requestPath: null,
      requestSha256: null,
      detail: {
        source: 'seed',
        seedPath,
        indexFile: INDEX_FILE,
        sha256: sha256(text),
        threads: threads.length,
        statuses: threads.map((thread) => thread.status),
        validator: 'projectIndexV1Problems',
        problems: [],
        reviewRequestFile: null,
      },
    }
  }

  const requestPath = join(reviewsDir, `${REVIEW_TOPIC_ID}-${REVIEW_REQUEST_ID}.json`)
  const request = pendingReviewRequest(repoPath)
  const requestProblems = reviewRequestRecordProblems(request)
  check(
    requestProblems.length === 0,
    `the drill fixture's review request is invalid: ${requestProblems.join('; ')}`,
  )
  const requestText = serializeReviewRequestRecord(request)
  const index = builtinV1Index(requestPath)
  const threads = normalizeProjectIndexV1(index).threads
  const problems = projectIndexV1Problems(normalizeProjectIndexV1(index))
  check(problems.length === 0, `the drill fixture is not a valid v1 index: ${problems.join('; ')}`)
  const text = `${JSON.stringify(index, null, 2)}\n`
  await writeFile(requestPath, requestText, { mode: 0o600 })
  await writeFile(join(projectDir, INDEX_FILE), text, { mode: 0o600 })
  return {
    source: 'builtin',
    text,
    sha256: sha256(text),
    threads,
    requestPath,
    requestSha256: sha256(requestText),
    detail: {
      source: 'builtin',
      indexFile: INDEX_FILE,
      sha256: sha256(text),
      threads: threads.length,
      statuses: threads.map((thread) => thread.status),
      validator: 'projectIndexV1Problems',
      problems: [],
      reviewRequestFile: `${REVIEW_TOPIC_ID}-${REVIEW_REQUEST_ID}.json`,
      reviewRequestSha256: sha256(requestText),
    },
  }
}

/** One drill run: builds the evidence document and records each step. */
class Drill {
  constructor(options) {
    this.options = options
    this.tempRoot = null
    this.failedStep = null
    this.evidence = {
      tool: 'm12-migration-drill',
      evidenceVersion: 1,
      ok: false,
      exitCode: 1,
      kept: options.keep,
      fixture: { source: options.seed === null ? 'builtin' : 'seed', threads: 0 },
      tempRoot: null,
      repoPath: null,
      steps: [],
      hashes: {},
      safety: { writesRestrictedToTmpdir: true },
    }
  }

  /** Run one step; a failure is recorded, then rethrown for the CLI to report. */
  async step(id, operation) {
    try {
      const detail = await operation()
      this.evidence.steps.push({ id, ok: true, detail })
      process.stderr.write(`ok   ${id}\n`)
      return detail
    } catch (error) {
      this.failedStep = id
      this.evidence.steps.push({ id, ok: false, error: describe(error) })
      process.stderr.write(`FAIL ${id}: ${describe(error)}\n`)
      throw error
    }
  }

  /** Remove the throwaway repository (unless `--keep`); safe to call twice. */
  async cleanup() {
    if (this.options.keep || this.tempRoot === null) {
      return { kept: this.options.keep, removed: false }
    }
    await rm(this.tempRoot, { recursive: true, force: true })
    return { kept: false, removed: !existsSync(this.tempRoot) }
  }

  async run() {
    const options = this.options
    const evidence = this.evidence

    await this.step('create-temp-repo', async () => {
      this.tempRoot = await mkdtemp(join(tmpdir(), 'dsh-cowork-m12-drill-'))
      assertInsideTmpdir(this.tempRoot)
      const repoPath = join(this.tempRoot, 'repo')
      assertInsideTmpdir(repoPath)
      await mkdir(repoPath, { recursive: true, mode: 0o700 })
      evidence.tempRoot = this.tempRoot
      evidence.repoPath = repoPath
      return { tempRoot: this.tempRoot, repoPath, insideTmpdir: true }
    })

    const repoPath = join(this.tempRoot, 'repo')
    const projectDir = join(repoPath, PROJECT_DIR)

    let input
    await this.step('seed-v1-index', async () => {
      input = await seedV1(repoPath, options.seed)
      evidence.fixture = {
        source: input.source,
        threads: input.threads.length,
        statuses: input.threads.map((thread) => thread.status),
      }
      evidence.hashes.inputV1Sha256 = input.sha256
      return input.detail
    })

    const archived = []
    const store = new ProjectStore({
      repoPath,
      clock: () => new Date(FIXED_NOW),
      projectId: DRILL_PROJECT_ID,
      async archiveSession(sessionId, archiveOptions) {
        archived.push({ sessionId, options: archiveOptions })
      },
    })

    let preWriteTree
    await this.step('read-does-not-migrate', async () => {
      preWriteTree = await snapshotTree(projectDir)
      const view = await store.readIndex()
      const projected = await store.readIndexDocument()
      const afterRead = await snapshotTree(projectDir)
      check(view.version === INDEX_VERSION_V1, `readIndex must report the v1 view, got version ${view.version}`)
      check(
        view.threads.length === input.threads.length,
        `readIndex must report every v1 thread (${input.threads.length}), got ${view.threads.length}`,
      )
      check(projected.version === INDEX_VERSION_V2, 'readIndexDocument must project v1 as v2')
      check(
        projected.topics.length === input.threads.length,
        'the read-only projection must carry every thread as a topic',
      )
      check(afterRead.hash === preWriteTree.hash, 'a read must not change one byte on disk')
      check(!existsSync(store.backupFile), 'a read must not create index.v1.backup.json')
      check(!existsSync(store.activityFile), 'a read must not create activity.jsonl')
      check(store.lastMigrationReport === null, 'a read must not run the write-path migration')
      return {
        readIndexVersion: view.version,
        threads: view.threads.length,
        projectedVersion: projected.version,
        treeSha256: afterRead.hash,
        backupWritten: false,
        migrationReport: null,
      }
    })

    const firstThreadId = input.threads.length > 0 ? input.threads[0].threadId : null
    const expectedCounts = statusCountsOf(input.threads)
    const expectedArchives = pendingArchivesOf(input.threads)
    // A real write: rename the first legacy thread. An empty v1 index has no
    // thread to rename, so a plain document write triggers the same entry.
    const writeOnce = async (subject) =>
      firstThreadId === null
        ? store.mutateIndexDocument((document) => document)
        : store.updateThread(firstThreadId, { subject })

    await this.step('first-write-migrates', async () => {
      await writeOnce('m12 drill: first write')
      const report = store.lastMigrationReport
      check(report !== null, 'the first write must run the store migration entry')
      check(report.migrated === true, 'the first write must report a migration')
      check(report.fromVersion === INDEX_VERSION_V1, `the migration must start at v1, got ${report.fromVersion}`)
      check(report.toVersion === INDEX_VERSION_V2, `the migration must end at v2, got ${report.toVersion}`)
      check(isDeepStrictEqual(report.statusCounts, expectedCounts), 'the report must count every v1 state')
      check(
        isDeepStrictEqual(report.pendingReviewerArchives, expectedArchives),
        'the report must name every reviewer the migration cancels',
      )
      check(report.archiveFailures.length === 0, 'a wired archive port must not report a failure')
      check(report.activityFailure === null, 'the migration activity must be writable')
      check(
        isDeepStrictEqual(
          archived,
          expectedArchives.map((entry) => ({
            sessionId: entry.reviewerSessionId,
            options: { stopActivity: true },
          })),
        ),
        'every cancelled reviewer must be archived through the injected host port',
      )
      return {
        api: firstThreadId === null ? 'ProjectStore.mutateIndexDocument' : 'ProjectStore.updateThread',
        threadId: firstThreadId,
        migrated: report.migrated,
        fromVersion: report.fromVersion,
        toVersion: report.toVersion,
        statusCounts: report.statusCounts,
        pendingReviewerArchives: report.pendingReviewerArchives,
        archiveFailures: report.archiveFailures,
        archivedReviewers: archived.map((entry) => entry.sessionId),
      }
    })

    let migratedText
    await this.step('v2-document-shape', async () => {
      migratedText = await readFile(store.indexFile, 'utf8')
      const document = JSON.parse(migratedText)
      const problems = projectIndexV2Problems(document)
      check(problems.length === 0, `the migrated document must pass projectIndexV2Problems: ${problems.join('; ')}`)
      check(document.version === INDEX_VERSION_V2, `index.version must be ${INDEX_VERSION_V2}`)
      check(Array.isArray(document.topics), 'a v2 document must carry topics[]')
      check(
        document.topics.length === input.threads.length,
        `every v1 thread must become a topic (${input.threads.length}), got ${document.topics.length}`,
      )
      check(Array.isArray(document.workItems), 'a v2 document must carry workItems[]')
      check(document.workItems.length === 0, 'a migrated project has no work items yet')
      check(!Object.hasOwn(document, 'threads'), 'a v2 document must not keep threads[]')
      const byId = new Map(document.topics.map((topic) => [topic.topicId, topic]))
      for (const thread of input.threads) {
        check(byId.has(thread.threadId), `topic ${thread.threadId} must survive the migration`)
      }
      for (const thread of input.threads) {
        if (thread.status !== 'awaiting_review') continue
        const topic = byId.get(thread.threadId)
        check(topic.awaitingReview === false, `topic ${thread.threadId} must have its in-flight review cancelled`)
        check(topic.reviewStatus === null, `topic ${thread.threadId} must not keep the cancelled review status`)
        check(topic.reviewerSessionId === null, `topic ${thread.threadId} must clear the reviewer pointer`)
      }
      evidence.hashes.migratedIndexSha256 = sha256(migratedText)
      return {
        version: document.version,
        versionField: 'version',
        validator: 'projectIndexV2Problems',
        problems,
        topics: document.topics.length,
        workItems: document.workItems.length,
        threadsKeyPresent: false,
      }
    })

    let backupSha256
    let backupMtimeMs
    await this.step('backup-byte-identical', async () => {
      const backupText = await readFile(store.backupFile, 'utf8')
      backupSha256 = sha256(backupText)
      backupMtimeMs = (await stat(store.backupFile)).mtimeMs
      check(backupText === input.text, 'index.v1.backup.json must carry exactly the input v1 bytes')
      check(backupSha256 === input.sha256, 'the backup sha256 must equal the input snapshot hash')
      evidence.hashes.backupSha256 = backupSha256
      return {
        file: BACKUP_FILE,
        sha256: backupSha256,
        inputSha256: input.sha256,
        byteIdentical: true,
      }
    })

    await this.step('activity-records-migration', async () => {
      const activity = await store.readActivity(100)
      check(activity.skippedLines === 0, 'every activity line must be a valid event')
      const raw = await readFile(store.activityFile, 'utf8')
      const lines = raw.split('\n').filter((line) => line.trim() !== '')
      check(lines.length === activity.events.length, 'every activity line must parse into an event')
      const migrations = activity.events.filter(
        (event) => event.type === 'status-changed' && event.summary === `migrated project index to v${INDEX_VERSION_V2}`,
      )
      check(migrations.length === 1, 'the migration must append exactly one migration event')
      const event = migrations[0]
      check(event.topicId === null, 'the migration event belongs to the project, not a topic')
      check(
        isDeepStrictEqual(event.details.statusCounts, expectedCounts),
        'the migration event must record the six-state counts',
      )
      check(
        isDeepStrictEqual(
          event.details.archivedReviewers,
          expectedArchives.map((entry) => entry.reviewerSessionId),
        ),
        'the migration event must record the archived reviewers',
      )
      check(
        !activity.events.some((row) => row.type === 'error'),
        'a clean migration must not append an error event',
      )
      return {
        lines: lines.length,
        types: activity.events.map((row) => row.type),
        skippedLines: activity.skippedLines,
        migration: {
          summary: event.summary,
          fromVersion: event.details.fromVersion,
          toVersion: INDEX_VERSION_V2,
          statusCounts: event.details.statusCounts,
          archivedReviewers: event.details.archivedReviewers,
        },
      }
    })

    await this.step('second-write-idempotent', async () => {
      const reportBefore = store.lastMigrationReport
      const readBack = await store.readIndexDocument()
      check(readBack.version === INDEX_VERSION_V2, 'the second read must see v2')
      await writeOnce('m12 drill: second write')
      check(
        store.lastMigrationReport === reportBefore,
        'a second write must not re-enter the migration entry',
      )
      const backupText = await readFile(store.backupFile, 'utf8')
      check(sha256(backupText) === backupSha256, 'the backup must not be rewritten')
      check(
        (await stat(store.backupFile)).mtimeMs === backupMtimeMs,
        'the backup mtime must not change on a second write',
      )
      const activity = await store.readActivity(100)
      const migrations = activity.events.filter(
        (event) => event.summary === `migrated project index to v${INDEX_VERSION_V2}`,
      )
      check(migrations.length === 1, 'a second write must not append a second migration event')
      const text = await readFile(store.indexFile, 'utf8')
      const document = JSON.parse(text)
      check(document.version === INDEX_VERSION_V2, 'the index must stay v2')
      check(projectIndexV2Problems(document).length === 0, 'the index must stay valid after a second write')
      evidence.hashes.secondWriteIndexSha256 = sha256(text)
      return {
        migrations: migrations.length,
        backupSha256: sha256(backupText),
        backupMtimeUnchanged: true,
        version: document.version,
      }
    })

    await this.step('reviewer-archive-failure', async () => {
      const failureRepo = join(this.tempRoot, 'repo-archive-failure')
      assertInsideTmpdir(failureRepo)
      await mkdir(failureRepo, { recursive: true, mode: 0o700 })
      const failureInput = await seedV1(failureRepo, null)
      const calls = []
      const failureStore = new ProjectStore({
        repoPath: failureRepo,
        clock: () => new Date(FIXED_NOW),
        projectId: DRILL_PROJECT_ID,
        async archiveSession(sessionId, archiveOptions) {
          calls.push({ sessionId, options: archiveOptions })
          throw new Error(ARCHIVE_FAILURE_MESSAGE)
        },
      })
      await failureStore.updateThread(failureInput.threads[0].threadId, {
        subject: 'm12 drill: archive failure write',
      })
      const report = failureStore.lastMigrationReport
      check(report !== null && report.migrated === true, 'the failing-archive repo must still migrate')
      check(calls.length === 1, 'the migration must try to archive the cancelled review reviewer')
      check(report.pendingReviewerArchives.length === 1, 'the migration must report the pending archive')
      check(report.archiveFailures.length === 1, 'a refused archive must be recorded, not swallowed')
      const failure = report.archiveFailures[0]
      check(failure.topicId === REVIEW_TOPIC_ID, 'the archive failure must name the topic')
      check(failure.reviewerSessionId === REVIEWER_SESSION_ID, 'the archive failure must name the reviewer')
      check(
        failure.message.includes(ARCHIVE_FAILURE_MESSAGE),
        'the archive failure must carry the host error message',
      )
      const document = JSON.parse(await readFile(failureStore.indexFile, 'utf8'))
      check(
        projectIndexV2Problems(document).length === 0,
        'the migration must commit a valid v2 document instead of leaving a half-migrated index',
      )
      const reviewTopic = document.topics.find((topic) => topic.topicId === REVIEW_TOPIC_ID)
      check(reviewTopic !== undefined, 'the review topic must survive the failed archive')
      check(reviewTopic.awaitingReview === false, 'the cancelled review must not stay awaiting')
      check(reviewTopic.reviewStatus === null, 'the cancelled review must not keep a status')
      check(reviewTopic.reviewerSessionId === null, 'the cancelled review must clear the reviewer pointer')
      const activity = await failureStore.readActivity(100)
      const migration = activity.events.find(
        (event) => event.summary === `migrated project index to v${INDEX_VERSION_V2}`,
      )
      check(migration !== undefined, 'the failing-archive migration must still record its event')
      check(
        isDeepStrictEqual(migration.details.archivedReviewers, []),
        'a failed archive must not be reported as an archived reviewer',
      )
      const errors = activity.events.filter((event) => event.type === 'error')
      check(errors.length === 1, 'a failed archive must append exactly one error event')
      check(errors[0].topicId === REVIEW_TOPIC_ID, 'the error event must name the topic')
      check(
        String(errors[0].details.message).includes(ARCHIVE_FAILURE_MESSAGE),
        'the error event must carry the host error message',
      )
      return {
        repo: 'repo-archive-failure',
        archiveFailures: report.archiveFailures.map((entry) => ({
          topicId: entry.topicId,
          reviewerSessionId: entry.reviewerSessionId,
          message: entry.message,
        })),
        archivedReviewers: migration.details.archivedReviewers,
        activityError: {
          type: errors[0].type,
          topicId: errors[0].topicId,
          message: errors[0].details.message,
        },
        v2Written: true,
      }
    })

    await this.step('rollback-restores-v1', async () => {
      const migratedTree = await snapshotTree(projectDir)
      const addedFiles = Object.keys(migratedTree.files)
        .filter((path) => !Object.hasOwn(preWriteTree.files, path))
        .sort()
      check(
        isDeepStrictEqual(addedFiles, [BACKUP_FILE, ACTIVITY_FILE].sort()),
        `the migration must add exactly the backup and the activity stream, got ${addedFiles.join(', ')}`,
      )
      const changedExisting = Object.keys(preWriteTree.files)
        .filter((path) => Object.hasOwn(migratedTree.files, path) && migratedTree.files[path] !== preWriteTree.files[path])
        .sort()
      check(
        isDeepStrictEqual(changedExisting, [INDEX_FILE]),
        `the migration must only rewrite index.json, got ${changedExisting.join(', ')}`,
      )
      if (input.requestPath !== null) {
        check(
          migratedTree.files[`reviews/${REVIEW_TOPIC_ID}-${REVIEW_REQUEST_ID}.json`] === input.requestSha256,
          'the pending review request must survive the migration byte for byte',
        )
      }

      // The rollback step an operator would run: put the v1 backup back and drop
      // the files the migration added. The store is not asked to do this, so a
      // broken backup cannot hide behind a helper.
      const backupText = await readFile(store.backupFile, 'utf8')
      await copyFile(store.backupFile, store.indexFile)
      await rm(store.backupFile, { force: true })
      await rm(store.activityFile, { force: true })
      const restoredTree = await snapshotTree(projectDir)
      check(
        restoredTree.hash === preWriteTree.hash,
        'the project directory must return to its pre-migration files and bytes',
      )
      check(!existsSync(store.backupFile), 'the migration backup must be gone after rollback')
      check(!existsSync(store.activityFile), 'the migration activity must be gone after rollback')
      const restoredText = await readFile(store.indexFile, 'utf8')
      const restoredSha256 = sha256(restoredText)
      check(restoredText === input.text, 'the restored index must be the input v1 bytes')
      check(restoredSha256 === input.sha256, 'the restored index must hash to the input snapshot hash')
      check(backupText === input.text, 'the rollback source must be the v1 backup')
      const view = await store.readIndex()
      check(view.version === INDEX_VERSION_V1, `readIndex must read v1 after rollback, got ${view.version}`)
      check(
        isDeepStrictEqual(
          view.threads.map((thread) => [thread.threadId, thread.status]),
          input.threads.map((thread) => [thread.threadId, thread.status]),
        ),
        'readIndex must return every thread with its original v1 status',
      )
      for (const thread of input.threads) {
        const restored = view.threads.find((entry) => entry.threadId === thread.threadId)
        check(restored !== undefined, `thread ${thread.threadId} must be readable after rollback`)
        check(restored.reviewStatus === thread.reviewStatus, `thread ${thread.threadId} reviewStatus must be restored`)
        check(
          restored.reviewerSessionId === thread.reviewerSessionId,
          `thread ${thread.threadId} reviewer pointer must be restored`,
        )
        check(
          restored.latestReviewPath === thread.latestReviewPath,
          `thread ${thread.threadId} latestReviewPath must be restored`,
        )
      }
      const freshStore = new ProjectStore({
        repoPath,
        clock: () => new Date(FIXED_NOW),
        projectId: DRILL_PROJECT_ID,
      })
      const freshView = await freshStore.readIndex()
      check(freshView.version === INDEX_VERSION_V1, 'a fresh store must read the restored index as v1')
      check(
        freshView.threads.length === input.threads.length,
        'a fresh store must read every restored thread',
      )
      check(!existsSync(store.lockFile), 'no writer lock may be left behind')
      evidence.hashes.restoredIndexSha256 = restoredSha256
      return {
        restoredFrom: BACKUP_FILE,
        sha256: restoredSha256,
        inputSha256: input.sha256,
        byteIdentical: true,
        addedFilesRemoved: addedFiles,
        treeSha256: restoredTree.hash,
        treeMatchesPreMigration: true,
        readIndexVersion: view.version,
        threads: view.threads.length,
      }
    })

    await this.step('temp-cleanup', async () => {
      if (options.keep) {
        return { kept: true, removed: false, tempRoot: this.tempRoot }
      }
      await rm(this.tempRoot, { recursive: true, force: true })
      check(!existsSync(this.tempRoot), 'the temporary repository must be removed')
      return { kept: false, removed: true, tempRoot: this.tempRoot }
    })

    evidence.ok = true
    evidence.exitCode = 0
    evidence.stepIds = STEP_IDS
  }
}

/** Run the CLI and return its exit code. */
async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${USAGE}\n\n${error.message}\n`)
      return 2
    }
    throw error
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  const drill = new Drill(options)
  let exitCode = 0
  try {
    await drill.run()
  } catch (error) {
    exitCode = 1
    drill.evidence.ok = false
    drill.evidence.exitCode = 1
    drill.evidence.failedStep = drill.failedStep
    drill.evidence.error = describe(error)
    drill.evidence.cleanup = await drill.cleanup()
  }

  if (exitCode === 0 && options.keep) {
    process.stderr.write(`kept the drill repository at ${drill.tempRoot}\n`)
  }
  const text = `${JSON.stringify(drill.evidence, null, 2)}\n`
  if (options.evidence !== null) {
    try {
      await mkdir(dirname(options.evidence), { recursive: true })
      await writeFile(options.evidence, text, { mode: 0o600 })
    } catch (error) {
      process.stderr.write(`could not write the --evidence file: ${describe(error)}\n`)
      return 1
    }
  }
  process.stdout.write(text)
  return exitCode
}

process.exitCode = await main()
