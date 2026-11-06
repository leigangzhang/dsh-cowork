#!/usr/bin/env node
/**
 * Reproducible local fixture for the Cowork panel screenshots.
 *
 * Modes:
 *   node tools/panel-fixture.mjs apply     back up the real .dsh-cowork data,
 *                                          then write a five-thread fixture with
 *                                          pass / needs_revision / pending /
 *                                          reject / no-review states
 *   node tools/panel-fixture.mjs restore   put the real index/handoffs/reviews back
 *
 * Exit codes: 0 success, 1 operation failure, 2 usage error.
 *
 * The fixture lives only in the local data directory (gitignored); the script
 * itself is committed so a fresh clone can reproduce the screenshots. Markdown
 * is deliberately not written into the data directory: a failed M3 E2E fixture
 * once broke `npm run check` that way (KI-13). The backup sibling directory is
 * also local-only, and `restore` is idempotent as long as the backup exists.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const DATA = join(REPO, '.dsh-cowork')
const BACKUP = join(DATA, 'e2e', 'panel-m3', 'backup')
const INDEX = join(DATA, 'index.json')
const HANDOFFS = join(DATA, 'handoffs')
const REVIEWS = join(DATA, 'reviews')

const real = JSON.parse(await readFile(INDEX, 'utf8'))
const MASTER = real.masterSessionId
const STAMP = '20261106T034500000Z'
const STAMP2 = '20261106T034505000Z'
const STAMP3 = '20261106T034510000Z'
const NOW = '2026-11-06T03:45:00.000Z'

const PASS = 'session-0fadc8d5-2307-443e-82bc-de680e43c609'
const NEEDS = 'session-39bdce74-e978-4e5a-880d-28544d220998'
const PENDING = 'session-m3fixture-pending-0001'
const REJECT = 'session-m3fixture-reject-0002'
const NONE = 'session-m3fixture-none-0003'
const REVIEWER_PASS = 'session-efbcc625-3b76-4e90-8063-024af318043a'
const REVIEWER_NEEDS = 'session-6d543f4e-2439-4bab-83ef-f579cd4530be'
const REVIEWER_REJECT = 'session-d6ee97e3-6a6c-448a-9b16-772d7358e672'
const REVIEWER_PENDING = MASTER

function thread(id, subject, status, reviewStatus, extra = {}) {
  return {
    threadId: id,
    subject,
    status,
    cwd: REPO,
    checkoutPath: null,
    createdAt: '2026-11-06T03:30:00.000Z',
    updatedAt: extra.updatedAt ?? NOW,
    lastHandoffAt: NOW,
    reviewStatus,
    reviewRequestedAt: reviewStatus === null ? null : '2026-11-06T03:44:00.000Z',
    reviewedAt: reviewStatus === 'pending' || reviewStatus === null ? null : NOW,
    reviewerSessionId: extra.reviewerSessionId ?? null,
    latestReviewPath: extra.latestReviewPath ?? null,
  }
}

function handoff(threadId, status, summary, verification, changedPaths) {
  return {
    version: 1,
    threadId,
    masterSessionId: MASTER,
    status,
    subject: 'M3 panel fixture',
    summary,
    decisions: ['review 数据来自 M3 E2E 证据与本地 fixture'],
    changedPaths,
    artifacts: [],
    verification,
    openIssues: [],
    nextStep: null,
    createdAt: NOW,
    deliveredAt: NOW,
  }
}

function review(threadId, reviewerSessionId, verdict, summary, findings, verification) {
  return { version: 1, threadId, reviewerSessionId, verdict, summary, findings, verification, createdAt: NOW }
}

const passReview = review(PASS, REVIEWER_PASS, 'pass', '独立审查通过：改动存在、验证命令实跑 exit 0、clone 工作树干净。', [], [
  { command: 'test -f e2e-a.txt', exitCode: 0, evidence: 'exit 0；文件内容为 M3-E2E-PASS' },
  { command: 'git -C <checkout> diff origin/HEAD...HEAD', exitCode: 0, evidence: '仅新增 e2e-a.txt，无越界改动' },
])
const needsReview = review(NEEDS, REVIEWER_NEEDS, 'needs_revision', '需要一轮修复：目标文件仍保留初始标记，且缺少对修复结果的验证命令。', [
  {
    id: 'M3-E2E-1',
    severity: 'high',
    problem: 'e2e-b.txt 仍是 M3-E2E-NEEDS-REPAIR，缺少修复后内容',
    requiredFix: '把 e2e-b.txt 改成 M3-E2E-FIXED 并重新 handoff',
    file: 'e2e-b.txt',
    line: 1,
  },
  {
    id: 'M3-E2E-2',
    severity: 'medium',
    problem: 'verification 只检查文件存在，没有检查内容',
    requiredFix: '增加 grep -qx M3-E2E-FIXED e2e-b.txt 验证',
    file: 'e2e-b.txt',
  },
], [
  { command: 'test -f e2e-b.txt', exitCode: 0, evidence: 'exit 0；文件存在但内容是初始标记' },
])
const rejectReview = review(REJECT, REVIEWER_REJECT, 'reject', '改动与需求不符，且验证命令失败；拒绝进入合并。', [
  {
    id: 'M3-FIXTURE-R1',
    severity: 'blocker',
    problem: '验证命令 exit 1，提交无法证明行为正确',
    requiredFix: '先修复验证失败，再重新提交 review',
    file: 'src/fixture.ts',
    line: 42,
  },
], [
  { command: 'npm test', exitCode: 1, evidence: '1 failing：fixture.test.ts' },
])

const reviewFiles = [
  [`${PASS}-${STAMP}.json`, passReview],
  [`${NEEDS}-${STAMP2}.json`, needsReview],
  [`${REJECT}-${STAMP3}.json`, rejectReview],
]
const reviewPaths = new Map(reviewFiles.map(([name, record]) => [record.threadId, join(REVIEWS, name)]))

const threads = [
  thread(PENDING, 'M3 审查中示例：侧栏 review 状态', 'awaiting_review', 'pending', {
    reviewerSessionId: REVIEWER_PENDING,
    updatedAt: '2026-11-06T03:44:30.000Z',
  }),
  thread(REJECT, 'M3 已拒绝示例：合并前缺少验证', 'blocked', 'reject', {
    reviewerSessionId: REVIEWER_REJECT,
    latestReviewPath: reviewPaths.get(REJECT),
    updatedAt: '2026-11-06T03:44:20.000Z',
  }),
  thread(NEEDS, 'M3 E2E review repair', 'active', 'needs_revision', {
    reviewerSessionId: REVIEWER_NEEDS,
    latestReviewPath: reviewPaths.get(NEEDS),
    updatedAt: '2026-11-06T03:44:10.000Z',
  }),
  thread(NONE, 'M3 无 review 示例：普通活动 thread', 'active', null, {
    updatedAt: '2026-11-06T03:44:00.000Z',
  }),
  thread(PASS, 'M3 E2E review pass', 'done', 'pass', {
    reviewerSessionId: REVIEWER_PASS,
    latestReviewPath: reviewPaths.get(PASS),
    updatedAt: '2026-11-06T03:43:50.000Z',
  }),
]

const fixtureIndex = {
  version: 1,
  projectId: real.projectId,
  masterSessionId: MASTER,
  createdAt: real.createdAt,
  threads,
}

const handoffs = [
  handoff(PENDING, 'awaiting_review', '等待独立 review；尚未产生 verdict。', [
    { command: 'test -f e2e-pending.txt', exitCode: 0, evidence: '文件存在' },
  ], ['e2e-pending.txt']),
  handoff(REJECT, 'awaiting_review', '验证失败，review 拒绝了这次合并。', [
    { command: 'npm test', exitCode: 1, evidence: '1 failing：fixture.test.ts' },
  ], ['src/fixture.ts']),
  handoff(NEEDS, 'awaiting_review', '首轮 review 退回；thread 正在修复 findings。', [
    { command: 'test -f e2e-b.txt', exitCode: 0, evidence: '文件存在，内容仍是初始标记' },
  ], ['e2e-b.txt']),
  handoff(NONE, 'awaiting_review', '一次尚未请求 review 的普通 handoff。', [
    { command: 'test -f e2e-none.txt', exitCode: 0, evidence: '文件存在' },
  ], ['e2e-none.txt']),
  handoff(PASS, 'done', 'review 通过，已合并。', [
    { command: 'test -f e2e-a.txt', exitCode: 0, evidence: '文件内容为 M3-E2E-PASS' },
  ], ['e2e-a.txt']),
]

async function apply() {
  if (existsSync(BACKUP)) await rm(BACKUP, { recursive: true, force: true })
  await mkdir(BACKUP, { recursive: true })
  await cp(INDEX, join(BACKUP, 'index.json'))
  if (existsSync(HANDOFFS)) await cp(HANDOFFS, join(BACKUP, 'handoffs'), { recursive: true })
  const hadReviews = existsSync(REVIEWS)
  if (hadReviews) await cp(REVIEWS, join(BACKUP, 'reviews'), { recursive: true })
  await writeFile(join(BACKUP, 'manifest.json'), JSON.stringify({ hadReviews, repo: REPO }, null, 2) + '\n')

  await rm(HANDOFFS, { recursive: true, force: true })
  await mkdir(HANDOFFS, { recursive: true })
  await rm(REVIEWS, { recursive: true, force: true })
  await mkdir(REVIEWS, { recursive: true })

  await writeFile(INDEX, JSON.stringify(fixtureIndex, null, 2) + '\n')
  for (const record of handoffs) {
    await writeFile(join(HANDOFFS, `${record.threadId}-${STAMP}.json`), JSON.stringify(record, null, 2) + '\n')
  }
  for (const [name, record] of reviewFiles) {
    await writeFile(join(REVIEWS, name), JSON.stringify(record, null, 2) + '\n')
  }
  console.log(JSON.stringify({ mode: 'apply', repo: REPO, threads: threads.length, reviews: reviewFiles.length, backup: BACKUP }, null, 2))
}

async function restore() {
  if (!existsSync(join(BACKUP, 'manifest.json'))) {
    throw new Error(`no fixture backup at ${BACKUP}; run apply first`)
  }
  const manifest = JSON.parse(await readFile(join(BACKUP, 'manifest.json'), 'utf8'))
  await rm(HANDOFFS, { recursive: true, force: true })
  await rm(REVIEWS, { recursive: true, force: true })
  await cp(join(BACKUP, 'index.json'), INDEX)
  if (existsSync(join(BACKUP, 'handoffs'))) await cp(join(BACKUP, 'handoffs'), HANDOFFS, { recursive: true })
  if (manifest.hadReviews && existsSync(join(BACKUP, 'reviews'))) await cp(join(BACKUP, 'reviews'), REVIEWS, { recursive: true })
  console.log(JSON.stringify({ mode: 'restore', index: JSON.parse(await readFile(INDEX, 'utf8')).threads.length, hadReviews: manifest.hadReviews }, null, 2))
}

const mode = process.argv[2]
// The backup manifest is the only proof that restore can run; fail loudly
// instead of silently deleting the fixture directories when it is missing.
if (mode === 'apply') await apply()
else if (mode === 'restore') await restore()
else {
  console.error('usage: node tools/panel-fixture.mjs apply|restore')
  process.exit(2)
}
