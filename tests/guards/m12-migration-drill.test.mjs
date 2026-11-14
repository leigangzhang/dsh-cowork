import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Contract tests for tools/m12-migration-drill.mjs (M12 / KI-22).
 *
 * The drill is the real v1 → v2 migration and rollback exercise: it seeds a v1
 * index into a throwaway repository, drives `ProjectStore.updateThread`, checks
 * the v2 document, the byte-identical backup, the activity row, idempotency,
 * the failed-archive path, and the rollback. These tests only spawn it and
 * assert its exit code and evidence JSON — no host, no shared state, no clock.
 *
 * The drill imports `src/*.ts` directly, so this test needs the same dependency
 * tree `npm test` needs (`@deepseek-ai/dsh-atomic-write` for the store).
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SCRIPT = join(ROOT, 'tools', 'm12-migration-drill.mjs')

/** The steps one successful run must record, in contract order. */
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

/** Every hash the evidence document must carry. */
const HASH_KEYS = [
  'inputV1Sha256',
  'migratedIndexSha256',
  'backupSha256',
  'secondWriteIndexSha256',
  'restoredIndexSha256',
]

/** The drill finishes in well under a second; the timeout only guards a hang. */
const SCRIPT_TIMEOUT_MS = 120_000

/** Run the drill with `args`, capturing stdout/stderr. */
function runDrill(args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: SCRIPT_TIMEOUT_MS,
  })
}

/** Parse the one JSON document the drill writes to stdout. */
function evidenceOf(result) {
  assert.equal(typeof result.stdout, 'string', 'stdout must be captured as text')
  const evidence = JSON.parse(result.stdout)
  assert.equal(typeof evidence, 'object', 'stdout must be one evidence JSON object')
  return evidence
}

/** Run one test body inside a throwaway directory that is always removed. */
async function withTempDir(run) {
  const path = await mkdtemp(join(tmpdir(), 'dsh-cowork-m12-drill-test-'))
  try {
    return await run(path)
  } finally {
    await rm(path, { recursive: true, force: true })
  }
}

/** A valid v1 index with no temp paths, so two runs hash identically. */
const SEED_DOCUMENT = {
  version: 1,
  projectId: 'project-m12-drill',
  masterSessionId: 'session-master',
  createdAt: '2026-11-05T03:04:05.006Z',
  threads: [
    {
      threadId: 'seed-active',
      subject: 'seeded active thread',
      status: 'active',
      cwd: '/repo',
      checkoutPath: null,
      createdAt: '2026-11-05T03:04:05.006Z',
      updatedAt: '2026-11-07T09:00:00.000Z',
      lastHandoffAt: null,
      reviewStatus: null,
      reviewRequestedAt: null,
      reviewedAt: null,
      reviewerSessionId: null,
      latestReviewPath: null,
    },
    {
      threadId: 'seed-review',
      subject: 'seeded pending review',
      status: 'awaiting_review',
      cwd: '/repo',
      checkoutPath: null,
      createdAt: '2026-11-05T03:04:05.006Z',
      updatedAt: '2026-11-07T09:00:00.000Z',
      lastHandoffAt: null,
      reviewStatus: 'pending',
      reviewRequestedAt: '2026-11-07T09:00:00.000Z',
      reviewedAt: null,
      reviewerSessionId: 'session-reviewer',
      latestReviewPath: '/repo/.dsh-cowork/reviews/seed-review-request-1.json',
    },
  ],
}

/** A v1 index the migration must refuse: `shipped` is not a v1 status. */
const DAMAGED_SEED_DOCUMENT = {
  version: 1,
  projectId: 'project-m12-drill',
  masterSessionId: 'session-master',
  createdAt: '2026-11-05T03:04:05.006Z',
  threads: [
    {
      threadId: 'seed-broken',
      subject: 'damaged v1 thread',
      status: 'shipped',
      cwd: '/repo',
      checkoutPath: null,
      createdAt: '2026-11-05T03:04:05.006Z',
      updatedAt: '2026-11-07T09:00:00.000Z',
      lastHandoffAt: null,
    },
  ],
}

/** Find one recorded step; the id must be unique. */
function stepOf(evidence, id) {
  const steps = evidence.steps.filter((step) => step.id === id)
  assert.equal(steps.length, 1, `evidence must record exactly one step named ${id}`)
  return steps[0]
}

/** sha256 of a text file, for the rollback byte checks. */
async function sha256OfFile(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex')
}

test('the default run drills v1 → v2 and prints machine-readable evidence', async () => {
  // The drill must never create the real project data directory. When this test
  // runs from a checkout that has no `.dsh-cowork/` yet, that absence is the
  // proof; a checkout with live data is left untouched by construction (every
  // write path is asserted to be inside os.tmpdir()).
  const realProjectDir = join(ROOT, '.dsh-cowork')
  const realProjectDirExisted = existsSync(realProjectDir)

  const result = runDrill()
  const evidence = evidenceOf(result)

  assert.equal(result.status, 0, `the drill must exit 0 (stderr: ${result.stderr})`)
  assert.equal(evidence.tool, 'm12-migration-drill')
  assert.equal(evidence.evidenceVersion, 1)
  assert.equal(evidence.ok, true)
  assert.equal(evidence.exitCode, 0)
  assert.equal(evidence.kept, false)

  // Steps: complete, ordered, and all green.
  assert.deepEqual(
    evidence.steps.map((step) => step.id),
    STEP_IDS,
  )
  for (const step of evidence.steps) {
    assert.equal(step.ok, true, `step ${step.id} must pass: ${step.error ?? ''}`)
    assert.equal(typeof step.detail, 'object', `step ${step.id} must record a detail object`)
  }
  assert.deepEqual(evidence.stepIds, STEP_IDS)

  // The v1 snapshot was hashed before the first write; the backup and the
  // rollback both reproduce it.
  for (const key of HASH_KEYS) {
    assert.match(evidence.hashes[key], /^[0-9a-f]{64}$/, `hashes.${key} must be a sha256`)
  }
  assert.equal(evidence.hashes.backupSha256, evidence.hashes.inputV1Sha256)
  assert.equal(evidence.hashes.restoredIndexSha256, evidence.hashes.inputV1Sha256)
  assert.notEqual(evidence.hashes.migratedIndexSha256, evidence.hashes.inputV1Sha256)

  // The steps carry the facts the contract requires, not only boolean flags.
  assert.equal(stepOf(evidence, 'first-write-migrates').detail.migrated, true)
  assert.equal(stepOf(evidence, 'first-write-migrates').detail.api, 'ProjectStore.updateThread')
  assert.deepEqual(stepOf(evidence, 'v2-document-shape').detail.problems, [])
  assert.equal(stepOf(evidence, 'v2-document-shape').detail.version, 2)
  assert.equal(stepOf(evidence, 'v2-document-shape').detail.workItems, 0)
  assert.equal(stepOf(evidence, 'backup-byte-identical').detail.byteIdentical, true)
  assert.equal(
    stepOf(evidence, 'activity-records-migration').detail.migration.summary,
    'migrated project index to v2',
  )
  assert.equal(stepOf(evidence, 'second-write-idempotent').detail.migrations, 1)
  assert.deepEqual(stepOf(evidence, 'reviewer-archive-failure').detail.archivedReviewers, [])
  assert.equal(stepOf(evidence, 'rollback-restores-v1').detail.treeMatchesPreMigration, true)
  assert.equal(stepOf(evidence, 'rollback-restores-v1').detail.readIndexVersion, 1)

  // Every artefact lived under os.tmpdir(); the default run cleans it up.
  assert.match(evidence.tempRoot, new RegExp(`^${tmpdir()}`))
  assert.match(evidence.repoPath, new RegExp(`^${tmpdir()}`))
  assert.equal(evidence.steps.at(-1).detail.removed, true)
  assert.equal(existsSync(evidence.repoPath), false, 'the throwaway repository must be removed')
  assert.equal(existsSync(evidence.tempRoot), false, 'the drill temp root must be removed')

  if (!realProjectDirExisted) {
    assert.equal(existsSync(realProjectDir), false, 'the drill must not create the real .dsh-cowork')
  }
})

test('--evidence writes the same JSON document to a file', async () => {
  await withTempDir(async (directory) => {
    const evidencePath = join(directory, 'm12-evidence.json')
    const result = runDrill([`--evidence=${evidencePath}`])
    assert.equal(result.status, 0, `the drill must exit 0 (stderr: ${result.stderr})`)

    const text = await readFile(evidencePath, 'utf8')
    assert.ok(text.endsWith('\n'), 'the evidence file must end with a newline')
    assert.deepEqual(JSON.parse(text), evidenceOf(result))
    assert.equal(existsSync(evidenceOf(result).repoPath), false, 'the run still cleans up its temp repo')
  })
})

test('--keep leaves the rolled-back repository in place', async () => {
  const result = runDrill(['--keep'])
  const evidence = evidenceOf(result)
  try {
    assert.equal(result.status, 0, `the drill must exit 0 (stderr: ${result.stderr})`)
    assert.equal(evidence.kept, true)
    assert.equal(stepOf(evidence, 'temp-cleanup').detail.kept, true)
    assert.equal(stepOf(evidence, 'temp-cleanup').detail.removed, false)
    assert.equal(existsSync(evidence.repoPath), true, '--keep must leave the repository on disk')

    const projectDir = join(evidence.repoPath, '.dsh-cowork')
    const indexFile = join(projectDir, 'index.json')
    assert.equal(existsSync(indexFile), true, 'the kept repository must hold the restored index')
    assert.equal(JSON.parse(await readFile(indexFile, 'utf8')).version, 1, 'rollback leaves v1 on disk')
    assert.equal(await sha256OfFile(indexFile), evidence.hashes.inputV1Sha256)
    assert.equal(existsSync(join(projectDir, 'index.v1.backup.json')), false)
    assert.equal(existsSync(join(projectDir, 'activity.jsonl')), false)
  } finally {
    if (evidence.tempRoot !== null) await rm(evidence.tempRoot, { recursive: true, force: true })
  }
})

test('two --seed runs of the same v1 snapshot record identical hashes', async () => {
  await withTempDir(async (directory) => {
    const seedPath = join(directory, 'seed.json')
    await writeFile(seedPath, `${JSON.stringify(SEED_DOCUMENT, null, 2)}\n`, 'utf8')

    const first = runDrill([`--seed=${seedPath}`])
    const second = runDrill([`--seed=${seedPath}`])
    const firstEvidence = evidenceOf(first)
    const secondEvidence = evidenceOf(second)

    assert.equal(first.status, 0, `the first run must exit 0 (stderr: ${first.stderr})`)
    assert.equal(second.status, 0, `the second run must exit 0 (stderr: ${second.stderr})`)
    assert.equal(firstEvidence.fixture.source, 'seed')
    assert.deepEqual(firstEvidence.hashes, secondEvidence.hashes)
    assert.deepEqual(
      firstEvidence.steps.map((step) => step.id),
      secondEvidence.steps.map((step) => step.id),
    )
    assert.equal(firstEvidence.hashes.backupSha256, firstEvidence.hashes.inputV1Sha256)
  })
})

test('a damaged --seed fails the drill with exit 1 and reports the failed step', async () => {
  await withTempDir(async (directory) => {
    const seedPath = join(directory, 'damaged.json')
    const evidencePath = join(directory, 'failure-evidence.json')
    await writeFile(seedPath, `${JSON.stringify(DAMAGED_SEED_DOCUMENT, null, 2)}\n`, 'utf8')

    const result = runDrill([`--seed=${seedPath}`, `--evidence=${evidencePath}`])
    const evidence = evidenceOf(result)

    assert.equal(result.status, 1, 'an assertion failure must exit 1')
    assert.equal(evidence.ok, false)
    assert.equal(evidence.exitCode, 1)
    assert.equal(evidence.failedStep, 'seed-v1-index')
    assert.match(evidence.error, /status must be one of new\|active\|awaiting_review\|done\|blocked\|archived/)

    const steps = evidence.steps.map((step) => step.id)
    assert.deepEqual(steps, ['create-temp-repo', 'seed-v1-index'])
    const failed = evidence.steps.at(-1)
    assert.equal(failed.ok, false)
    assert.match(failed.error, /not a valid v1 index/)

    assert.deepEqual(JSON.parse(await readFile(evidencePath, 'utf8')), evidence)
    assert.equal(evidence.cleanup.removed, true)
    assert.equal(existsSync(evidence.tempRoot), false, 'a failed drill cleans its temp root up too')
    assert.equal(evidence.ok, false)
  })
})

test('usage errors exit 2 without running the drill', () => {
  const cases = ['--bogus', '--evidence', '--keep=yes', 'run']
  for (const argument of cases) {
    const result = runDrill([argument])
    assert.equal(result.status, 2, `${argument} must be a usage error`)
    assert.match(result.stderr, /usage: node tools\/m12-migration-drill\.mjs/, `${argument} must print usage`)
    assert.equal(result.stdout, '', `${argument} must not emit evidence`)
  }
})

test('--help exits 0 and prints the usage contract', () => {
  const result = runDrill(['--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /--evidence=<path>/)
  assert.match(result.stdout, /--keep/)
  assert.match(result.stdout, /exit codes: 0/)
})
