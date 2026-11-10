#!/usr/bin/env node
/**
 * Reproducible local fixture for the M11 CoWork panel (wire v2).
 *
 * Modes:
 *   node tools/panel-fixture.mjs apply [--repo=<path>] [--master=<sessionId>]
 *                                      [--live-topic=<sessionId>]
 *       Back up the project's data directory, then write one v2 fixture that
 *       covers every state the panel has to render: active, idle,
 *       resolved-by-user, resolved-by-master, blocked + awaiting review with a
 *       pending request, needs_revision with findings, and pass with findings.
 *       `--live-topic` replaces the active topic's id with a real session id so
 *       the "open topic" path can be verified against a session the host knows.
 *   node tools/panel-fixture.mjs restore [--repo=<path>]
 *       Put the backed-up index/activity/inbox/reviews back, atomically, then
 *       drop the backup. Idempotent while the backup exists; the restored index
 *       hash and the topic/thread counts are printed as proof.
 *
 * Exit codes: 0 success, 1 operation failure, 2 usage error.
 *
 * R9 rules this script follows: it only touches `<repo>/.dsh-cowork` (plus its
 * own backup under `e2e/m11/panel-fixture/backup`), writes files directly
 * instead of calling a host API, never takes the project lock (the host must be
 * stopped or pointed at a fixture repo while a fixture is applied), backs data
 * up before writing, and writes no Markdown into the data directory (KI-13).
 *
 * Every fixture document is self-checked against the code's own validators
 * before a byte is written: the index with `projectIndexV2Problems`, activity
 * rows with `activityEventProblems`, inbox rows with `inboxItemProblems`, and
 * review requests with `reviewRequestRecordProblems` plus
 * `reviewRequestFileName`. A fixture that the plugin would refuse to read is a
 * failed apply, not a screenshot surprise.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { register } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// `src/*.ts` imports its siblings with the build's `.js` specifiers; the tool
// runs under Node's type stripping, so a resolve hook retries relative `.js`
// specifiers as `.ts`. Only the validators are imported — this script never
// loads the store or the host.
const HOOK_SOURCE = [
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier.startsWith('.') && specifier.endsWith('.js')) {",
  "    try { return await nextResolve(specifier.slice(0, -3) + '.ts', context) } catch {}",
  '  }',
  '  return nextResolve(specifier, context)',
  '}',
].join('\n')
register(`data:text/javascript,${encodeURIComponent(HOOK_SOURCE)}`)

const { reviewRequestFileName, reviewRequestRecordProblems } = await import(
  new URL('../src/review-request.ts', import.meta.url).href
)
const {
  activityEventProblems,
  inboxItemProblems,
  projectIndexV2Problems,
} = await import(new URL('../src/store-schema.ts', import.meta.url).href)

const HERE = dirname(fileURLToPath(import.meta.url))
/** Repository root by default; `--repo` overrides it for a throwaway smoke run. */
const DEFAULT_REPO = resolve(HERE, '..')
const PROJECT_DIR_NAME = '.dsh-cowork'
const BACKUP_RELATIVE = 'e2e/m11/panel-fixture/backup'
/** The fixture is expected to finish apply/restore inside this budget (R9). */
const BUDGET_MS = 5_000

/** A failure the user can act on; it maps to exit code 1. */
class FixtureError extends Error {}

/** Usage problem; it maps to exit code 2. */
class UsageError extends Error {}

const USAGE = [
  'usage: node tools/panel-fixture.mjs apply [--repo=<path>] [--master=<sessionId>] [--live-topic=<sessionId>]',
  '       node tools/panel-fixture.mjs restore [--repo=<path>]',
].join('\n')

/** Parse `--key=value` and `--key value` flags; unknown flags are usage errors. */
function parseFlags(argv, allowed) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) throw new UsageError(`unexpected argument: ${argument}`)
    const at = argument.indexOf('=')
    const name = at < 0 ? argument.slice(2) : argument.slice(2, at)
    if (!allowed.includes(name)) throw new UsageError(`unknown flag: --${name}`)
    let value
    if (at >= 0) value = argument.slice(at + 1)
    else {
      index += 1
      value = argv[index]
      if (value === undefined) throw new UsageError(`flag --${name} needs a value`)
    }
    if (value.trim() === '') throw new UsageError(`flag --${name} needs a non-empty value`)
    flags[name] = value
  }
  return flags
}

/** Resolve the paths one run touches. */
function locate(repo) {
  const data = join(repo, PROJECT_DIR_NAME)
  return {
    repo,
    data,
    index: join(data, 'index.json'),
    activity: join(data, 'activity.jsonl'),
    inbox: join(data, 'inbox.json'),
    reviews: join(data, 'reviews'),
    backup: join(data, BACKUP_RELATIVE),
    manifest: join(data, BACKUP_RELATIVE, 'manifest.json'),
  }
}

/** Read and parse one JSON file, with a readable failure when it is missing. */
async function readJson(filePath, label) {
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new FixtureError(
        `${label} not found at ${filePath}; run this inside an initialized CoWork project`,
      )
    }
    throw error
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new FixtureError(`${label} is not valid JSON (${filePath}): ${error.message}`)
  }
}

/** sha256 of a file's bytes, or null when it does not exist. */
async function sha256Of(filePath) {
  try {
    return createHash('sha256').update(await readFile(filePath)).digest('hex')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/** ISO timestamp `minutes` before now (negative values are in the past). */
function minutesAgo(now, minutes) {
  return new Date(now.getTime() - minutes * 60_000).toISOString()
}

/**
 * The fixture's topics. The first one takes `--live-topic` when given, so the
 * "open topic" path can target a real session without touching the other ids.
 */
function buildTopics({ repo, liveTopicId, now }) {
  const active = liveTopicId ?? 'topic-fixture-active'
  const idle = 'topic-fixture-idle'
  const resolvedUser = 'topic-fixture-resolved-user'
  const resolvedMaster = 'topic-fixture-resolved-master'
  const blocked = 'topic-fixture-blocked'
  const needsRevision = 'topic-fixture-needs-revision'
  const passed = 'topic-fixture-pass'
  const recent = minutesAgo(now, 5)
  const older = minutesAgo(now, 40)
  const idleSince = minutesAgo(now, 3 * 60)
  const resolvedAt = minutesAgo(now, 90)
  const base = {
    title: '',
    awaitingReview: false,
    blocked: false,
    blockedReason: null,
    blockedFromStatus: null,
    blockedAt: null,
    authorization: null,
    scope: '',
    ownedPaths: [],
    aliases: [],
    digest: '',
    cwd: repo,
    legacyCheckoutPath: null,
    createdAt: minutesAgo(now, 24 * 60),
    updatedAt: recent,
    lastActiveAt: recent,
    lastDeliveryConfirmedAt: recent,
    resolvedAt: null,
    resolvedBy: null,
    latestReviewRequestId: null,
    reviewStatus: null,
    reviewerSessionId: null,
  }
  const topics = [
    {
      ...base,
      topicId: active,
      title: 'M11 面板读取点：主题列表与详情',
      status: 'active',
      scope: 'src/api.ts / src/api-contract.ts 的读路由与 wire 映射',
      ownedPaths: ['src/api.ts', 'src/api-contract.ts'],
      digest: '读路由已接入 v2 wire；正在补真实 Chrome 证据',
      updatedAt: recent,
      lastActiveAt: recent,
    },
    {
      ...base,
      topicId: idle,
      title: 'M11 评审卡：从请求文件读取',
      status: 'idle',
      scope: '面板评审卡与 reviews/ 请求文件',
      ownedPaths: ['src/client/detail.tsx'],
      digest: '等待下一轮客户端改动',
      updatedAt: idleSince,
      lastActiveAt: idleSince,
      lastDeliveryConfirmedAt: idleSince,
    },
    {
      ...base,
      topicId: resolvedUser,
      title: 'M10 收尾：合并队列记录',
      status: 'resolved',
      scope: 'docs/M10_RESULT.md',
      ownedPaths: ['docs'],
      digest: '用户已确认交付',
      updatedAt: resolvedAt,
      lastActiveAt: resolvedAt,
      resolvedAt,
      resolvedBy: 'user',
    },
    {
      ...base,
      topicId: resolvedMaster,
      title: 'M9 路由第三层：阈值收口',
      status: 'resolved',
      scope: 'src/routing.ts',
      ownedPaths: ['src/routing.ts'],
      digest: 'master 在静默 3 天后自动解决',
      updatedAt: resolvedAt,
      lastActiveAt: resolvedAt,
      resolvedAt,
      resolvedBy: 'master',
    },
    {
      ...base,
      topicId: blocked,
      title: 'M11 写路由：resolve/reopen/route.move',
      status: 'active',
      blocked: true,
      blockedReason: 'authorization',
      blockedFromStatus: 'active',
      blockedAt: older,
      authorization: {
        requestId: 'req-fixture-auth',
        summary: '写路由是否允许该主题会话自行决定？',
        requestedAt: older,
      },
      awaitingReview: true,
      scope: 'src/api.ts 写路由与同源校验',
      ownedPaths: ['src/api.ts'],
      digest: '等待独立评审：写路由已就绪',
      reviewStatus: 'pending',
      latestReviewRequestId: 'req-fixture-pending',
      reviewerSessionId: 'session-fixture-reviewer',
      updatedAt: older,
      lastActiveAt: older,
      lastDeliveryConfirmedAt: older,
    },
    {
      ...base,
      topicId: needsRevision,
      title: 'M11 面板活动流分页',
      status: 'active',
      scope: 'src/client/list.tsx 的活动流',
      ownedPaths: ['src/client/list.tsx'],
      digest: '评审退回：活动流缺少上界测试',
      reviewStatus: 'needs_revision',
      latestReviewRequestId: 'req-fixture-needs',
      reviewerSessionId: 'session-fixture-reviewer',
      updatedAt: older,
      lastActiveAt: older,
      lastDeliveryConfirmedAt: older,
    },
    {
      ...base,
      topicId: passed,
      title: 'M11 wire v2 契约',
      status: 'active',
      scope: 'src/api-contract.ts',
      ownedPaths: ['src/api-contract.ts'],
      digest: '评审通过：契约与测试一致',
      reviewStatus: 'pass',
      latestReviewRequestId: 'req-fixture-pass',
      reviewerSessionId: 'session-fixture-reviewer',
      updatedAt: older,
      lastActiveAt: older,
      lastDeliveryConfirmedAt: older,
    },
  ]
  return { topics, ids: { active, idle, resolvedUser, resolvedMaster, blocked, needsRevision, passed } }
}

/** The four work-item states, one per fixture topic. */
function buildWorkItems({ repo, ids, now }) {
  const item = (workItemId, topicId, status, minutes) => ({
    workItemId,
    topicId,
    path: join(repo, PROJECT_DIR_NAME, 'workitems', workItemId),
    branch: `cowork/${workItemId}`,
    baseCommit: '8f1c2a4',
    headCommit: status === 'active' ? null : 'c5d6e7f',
    status,
    createdAt: minutesAgo(now, 24 * 60),
    updatedAt: minutesAgo(now, minutes),
  })
  return [
    item('wi-fixture-active', ids.active, 'active', 5),
    item('wi-fixture-reviewing', ids.blocked, 'reviewing', 30),
    item('wi-fixture-merged', ids.resolvedUser, 'merged', 90),
    item('wi-fixture-abandoned', ids.idle, 'abandoned', 120),
  ]
}

/** Ten valid activity rows, newest last (the stream is oldest-first on disk). */
function buildActivity({ ids, now }) {
  const rows = [
    ['topic-created', ids.active, 'created topic M11 面板读取点', 12],
    ['route-reused', ids.active, 'routed an intent to the read point', 40],
    ['work-item-created', ids.active, 'created work item wi-fixture-active', 60],
    ['review-requested', ids.blocked, 'requested review req-fixture-pending', 120],
    ['review-verdict', ids.needsRevision, 'recorded needs_revision for req-fixture-needs', 150],
    ['review-verdict', ids.passed, 'recorded pass for req-fixture-pass', 180],
    ['status-changed', ids.idle, 'changed topic status from active to idle', 200],
    ['work-item-merged', ids.resolvedUser, 'merged work item wi-fixture-merged', 240],
    ['status-changed', ids.resolvedUser, 'changed topic status from active to resolved', 250],
    ['status-changed', ids.resolvedMaster, 'changed topic status from active to resolved', 260],
  ]
  return rows.map(([type, topicId, summary, minutes], index) => ({
    eventId: `event-fixture-${String(index + 1).padStart(2, '0')}`,
    time: minutesAgo(now, minutes),
    type,
    topicId,
    summary,
    details: { topicId },
  }))
}

/** Two inbox rows: one already delivered, one waiting for the master. */
function buildInbox({ ids, now }) {
  return [
    {
      id: 'inbox-fixture-delivered',
      time: minutesAgo(now, 200),
      topicId: ids.idle,
      kind: 'merge-needed',
      summary: 'merged work item wi-fixture-merged; merge the branch',
      deliveredAt: minutesAgo(now, 190),
    },
    {
      id: 'inbox-fixture-pending',
      time: minutesAgo(now, 30),
      topicId: ids.blocked,
      kind: 'blocked',
      summary: 'topic is blocked on a review verdict',
      deliveredAt: null,
    },
  ]
}

/** One review-request record; the caller supplies the state under test. */
function reviewRequest({ repo, topicId, requestId, status, minutes, findings, summary, workItemId = null, now }) {
  const reviewed = status !== 'pending'
  return {
    version: 1,
    requestId,
    topicId,
    workItemId,
    purpose: '独立评审 M11 面板改动：读路由、写路由与同源校验。',
    notes: '',
    extra: {},
    baseCommit: '8f1c2a4',
    headCommit: 'c5d6e7f',
    path: repo,
    branch: 'feat/m11-http-api-panel',
    changedPaths: ['src/api.ts', 'tests/api.test.mjs'],
    verification: [
      { command: 'node --test tests/api.test.mjs', exitCode: 0, evidence: '39 passed' },
      { command: 'node --check tools/panel-fixture.mjs', exitCode: 0, evidence: 'syntax ok' },
    ],
    previousRequestId: null,
    status,
    reviewerSessionId: 'session-fixture-reviewer',
    requestedAt: minutesAgo(now, minutes),
    reviewedAt: reviewed ? minutesAgo(now, minutes - 10) : null,
    summary: reviewed ? summary : null,
    findings: reviewed ? findings : [],
    reviewVerification: reviewed
      ? [{ command: 'node --test tests/api.test.mjs', exitCode: 0, evidence: '39 passed' }]
      : [],
  }
}

/** The three request files: pending, pass with a finding, needs_revision with findings. */
function buildReviewRequests({ repo, ids, now }) {
  return [
    reviewRequest({
      repo,
      now,
      topicId: ids.blocked,
      requestId: 'req-fixture-pending',
      status: 'pending',
      minutes: 120,
      findings: [],
      summary: null,
      workItemId: 'wi-fixture-reviewing',
    }),
    reviewRequest({
      repo,
      now,
      topicId: ids.passed,
      requestId: 'req-fixture-pass',
      status: 'pass',
      minutes: 180,
      summary: '独立审查通过：读路由边界与写路由幂等均有测试覆盖。',
      findings: [{
        id: 'F1',
        severity: 'low',
        problem: 'README 的 API 小节尚未更新到 v2',
        requiredFix: 'M12 文档收口时统一更新 README',
        file: 'README.md',
        line: 42,
      }],
    }),
    reviewRequest({
      repo,
      now,
      topicId: ids.needsRevision,
      requestId: 'req-fixture-needs',
      status: 'needs_revision',
      minutes: 150,
      summary: '需要一轮修复：活动流缺少上界测试。',
      findings: [
        {
          id: 'F1',
          severity: 'high',
          problem: 'activity 路由的 200 上限没有测试',
          requiredFix: '在 tests/api.test.mjs 断言 limit=200 与非法 limit',
          file: 'tests/api.test.mjs',
          line: 120,
        },
        {
          id: 'F2',
          severity: 'medium',
          problem: 'skippedLines 未透出',
          requiredFix: '把 store.readActivity 的 skippedLines 放进响应',
          file: 'src/api.ts',
          line: 640,
        },
      ],
    }),
  ]
}

/** Fail the run with every schema problem, so a bad fixture never lands. */
function assertValid(problems, label) {
  if (problems.length > 0) {
    throw new FixtureError(`fixture ${label} is invalid: ${problems.join('; ')}`)
  }
}

/** Back up the data the fixture replaces. The manifest records what existed. */
async function backup(paths) {
  if (existsSync(paths.backup)) {
    throw new FixtureError(
      `a fixture backup already exists at ${paths.backup}; run \`restore\` first`,
    )
  }
  const manifest = {
    repo: paths.repo,
    createdAt: new Date().toISOString(),
    hadIndex: existsSync(paths.index),
    hadActivity: existsSync(paths.activity),
    hadInbox: existsSync(paths.inbox),
    hadReviews: existsSync(paths.reviews),
  }
  await mkdir(paths.backup, { recursive: true })
  await cp(paths.index, join(paths.backup, 'index.json'))
  if (manifest.hadActivity) await cp(paths.activity, join(paths.backup, 'activity.jsonl'))
  if (manifest.hadInbox) await cp(paths.inbox, join(paths.backup, 'inbox.json'))
  if (manifest.hadReviews) await cp(paths.reviews, join(paths.backup, 'reviews'), { recursive: true })
  await writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

/** Replace a file in one atomic step (temp sibling, then rename). */
async function writeFileAtomic(filePath, content) {
  const temp = `${filePath}.fixture-tmp`
  await writeFile(temp, content)
  await rename(temp, filePath)
}

/** Replace a directory in one atomic step: drop the old one, rename the staging copy. */
async function replaceDirectory(target, staged) {
  await rm(target, { recursive: true, force: true })
  await rename(staged, target)
}

async function apply(flags) {
  const repo = flags.repo === undefined ? DEFAULT_REPO : resolve(flags.repo)
  const paths = locate(repo)
  if (existsSync(paths.backup)) {
    throw new FixtureError(`a fixture backup already exists at ${paths.backup}; run \`restore\` first`)
  }
  if (!existsSync(paths.index)) {
    throw new FixtureError(
      `no project index at ${paths.index}; initialize the project (or copy a minimal v2 index) first`,
    )
  }
  const real = await readJson(paths.index, 'project index')
  const master = flags.master ?? real.masterSessionId
  if (typeof master !== 'string' || master.trim() === '') {
    throw new FixtureError('the project index has no masterSessionId; pass --master=<sessionId>')
  }
  const now = new Date()
  const build = buildTopics({ repo, liveTopicId: flags['live-topic'], now })
  const ids = build.ids
  const document = {
    version: 2,
    projectId: typeof real.projectId === 'string' && real.projectId !== '' ? real.projectId : 'fixture/project',
    masterSessionId: master,
    createdAt: typeof real.createdAt === 'string' && real.createdAt !== '' ? real.createdAt : minutesAgo(now, 24 * 60),
    masterFocusTopicId: null,
    lastRouteTopicId: null,
    topics: build.topics,
    workItems: buildWorkItems({ repo, ids, now }),
  }
  const activity = buildActivity({ ids, now })
  const inbox = buildInbox({ ids, now })
  const requests = buildReviewRequests({ repo, ids, now })

  // Self-check with the code's own validators before touching the data dir.
  assertValid(projectIndexV2Problems(document), 'index')
  activity.forEach((event, position) => {
    assertValid(activityEventProblems(event), `activity[${position}]`)
  })
  inbox.forEach((item, position) => {
    assertValid(inboxItemProblems(item), `inbox[${position}]`)
  })
  const reviewFiles = requests.map((record) => {
    assertValid(reviewRequestRecordProblems(record), `review ${record.requestId}`)
    const fileName = reviewRequestFileName(record.topicId, record.requestId)
    if (fileName === null) throw new FixtureError(`review ${record.requestId} is not file-name safe`)
    return { fileName, record }
  })

  const startedAt = Date.now()
  const manifest = await backup(paths)
  await mkdir(paths.data, { recursive: true })
  await writeFileAtomic(paths.index, `${JSON.stringify(document, null, 2)}\n`)
  await writeFileAtomic(
    paths.activity,
    activity.map((event) => `${JSON.stringify(event)}\n`).join(''),
  )
  await writeFileAtomic(paths.inbox, `${JSON.stringify(inbox, null, 2)}\n`)
  const stagedReviews = `${paths.reviews}.fixture-tmp`
  await mkdir(stagedReviews, { recursive: true })
  for (const { fileName, record } of reviewFiles) {
    await writeFile(join(stagedReviews, fileName), `${JSON.stringify(record, null, 2)}\n`)
  }
  await replaceDirectory(paths.reviews, stagedReviews)
  const elapsedMs = Date.now() - startedAt
  console.log(JSON.stringify({
    mode: 'apply',
    repo,
    backup: paths.backup,
    indexSha256: await sha256Of(paths.index),
    topics: document.topics.length,
    workItems: document.workItems.length,
    activity: activity.length,
    inbox: inbox.length,
    reviews: reviewFiles.map(({ fileName }) => fileName),
    liveTopic: ids.active,
    hadReviews: manifest.hadReviews,
    elapsedMs,
    withinBudget: elapsedMs <= BUDGET_MS,
  }, null, 2))
}

async function restore(flags) {
  const repo = flags.repo === undefined ? DEFAULT_REPO : resolve(flags.repo)
  const paths = locate(repo)
  if (!existsSync(paths.manifest)) {
    throw new FixtureError(`no fixture backup at ${paths.backup}; run \`apply\` first`)
  }
  const manifest = await readJson(paths.manifest, 'fixture manifest')
  const startedAt = Date.now()
  await writeFileAtomic(paths.index, await readFile(join(paths.backup, 'index.json')))
  if (manifest.hadActivity) {
    await writeFileAtomic(paths.activity, await readFile(join(paths.backup, 'activity.jsonl')))
  } else {
    await rm(paths.activity, { force: true })
  }
  if (manifest.hadInbox) {
    await writeFileAtomic(paths.inbox, await readFile(join(paths.backup, 'inbox.json')))
  } else {
    await rm(paths.inbox, { force: true })
  }
  if (manifest.hadReviews) {
    const stagedReviews = `${paths.reviews}.restore-tmp`
    await rm(stagedReviews, { recursive: true, force: true })
    await cp(join(paths.backup, 'reviews'), stagedReviews, { recursive: true })
    await replaceDirectory(paths.reviews, stagedReviews)
  } else {
    await rm(paths.reviews, { recursive: true, force: true })
  }
  const restored = await readJson(paths.index, 'restored project index')
  const elapsedMs = Date.now() - startedAt
  const indexSha256 = await sha256Of(paths.index)
  await rm(paths.backup, { recursive: true, force: true })
  console.log(JSON.stringify({
    mode: 'restore',
    repo,
    indexSha256,
    topics: Array.isArray(restored.topics) ? restored.topics.length : 0,
    threads: Array.isArray(restored.threads) ? restored.threads.length : 0,
    elapsedMs,
    withinBudget: elapsedMs <= BUDGET_MS,
  }, null, 2))
}

async function main(argv) {
  const mode = argv[0]
  if (mode === 'apply') await apply(parseFlags(argv.slice(1), ['repo', 'master', 'live-topic']))
  else if (mode === 'restore') await restore(parseFlags(argv.slice(1), ['repo']))
  else {
    console.error(USAGE)
    process.exit(2)
  }
}

try {
  await main(process.argv.slice(2))
} catch (error) {
  console.error(`panel-fixture: ${error instanceof Error ? error.message : String(error)}`)
  if (error instanceof UsageError) {
    console.error(USAGE)
    process.exit(2)
  }
  process.exit(1)
}
