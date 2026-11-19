/** Deterministic browser-lane project fixtures. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeSeedProject, makeSeedRequest, makeTopicFixture } from '../support/inbox-fixtures.mjs'

const { buildActivityEvent, decisionProposedActivity } = await import('../../src/store/activity.ts')

/** Topics the browser scenarios address by stable id. */
export const BROWSER_TOPICS = Object.freeze({
  blocked: 'session-browser-blocked',
  running: 'session-browser-running',
  idle: 'session-browser-idle',
  resolved: 'session-browser-resolved',
  inbox: 'session-browser-inbox',
  authDeny: 'session-browser-auth-deny',
  authAllow: 'session-browser-auth-allow',
})

/** Request ids the browser scenarios address by stable id. */
export const BROWSER_REQUESTS = Object.freeze({
  reviewReturn: 'req-browser-review-return',
  reviewPass: 'req-browser-review-pass',
  authDeny: 'req-browser-auth-deny',
  authAllow: 'req-browser-auth-allow',
  questionSkip: 'req-browser-question-skip',
  questionSubmit: 'req-browser-question-submit',
  questionMulti: 'req-browser-question-multi',
  planRevise: 'req-browser-plan-revise',
  planApprove: 'req-browser-plan-approve',
  error: 'req-browser-error',
})

const REVIEW_PAYLOAD = {
  purpose: '浏览器 lane 要验证用户评审卡的通过和退回路径。',
  changedPaths: ['src/client/panel.tsx', 'src/client/inbox.tsx'],
  verification: [{ command: 'npm run check', exitCode: 0, evidence: 'check-invariants: ok' }],
}

const AUTH_PAYLOAD = {
  summary: '允许浏览器 lane 在临时 fixture 仓库里写入证据。',
  command: 'echo browser-fixture',
}

const QUESTION_PAYLOAD = {
  questions: [
    {
      id: 'q1',
      prompt: '第一题：选择发布节奏',
      mode: 'single',
      options: [
        { id: 'o1', label: '立即发布', recommended: true },
        { id: 'o2', label: '下一轮发布' },
      ],
    },
    {
      id: 'q2',
      prompt: '第二题：补充说明',
      mode: 'single',
      allowText: true,
    },
  ],
}

const QUESTION_MULTI_PAYLOAD = {
  questions: [
    {
      id: 'qm1',
      prompt: '多选题：选择要纳入的范围',
      mode: 'multi',
      options: [
        { id: 'm1', label: '面板' },
        { id: 'm2', label: '收件箱' },
        { id: 'm3', label: '路由' },
      ],
    },
  ],
}

const PLAN_PAYLOAD = {
  planPath: 'docs/browser-plan.md',
  planTitle: '浏览器 lane 计划',
}

/**
 * Seed the primary browser fixture: four topic groups, eight actionable
 * requests (two per kind), one write-error request and one review-verdict note.
 */
export async function seedBrowserProject(repoPath, masterSessionId) {
  const now = new Date()
  const recent = now.toISOString()
  const idleAt = new Date(now.getTime() - 25 * 60 * 60_000).toISOString()
  const resolvedAt = new Date(now.getTime() - 30 * 60_000).toISOString()
  const makeTopic = makeTopicFixture()
  const topics = [
    makeTopic({
      topicId: BROWSER_TOPICS.blocked,
      title: '浏览器阻塞主题',
      status: 'active',
      blocked: true,
      blockedReason: 'handoff',
      blockedFromStatus: 'active',
      blockedAt: recent,
      digest: '等待主会话处理',
      updatedAt: recent,
      lastActiveAt: recent,
    }),
    makeTopic({
      topicId: BROWSER_TOPICS.running,
      title: '浏览器运行主题',
      status: 'active',
      digest: '正在执行浏览器 lane',
      updatedAt: recent,
      lastActiveAt: recent,
    }),
    makeTopic({
      topicId: BROWSER_TOPICS.idle,
      title: '浏览器空闲主题',
      status: 'idle',
      digest: '等待后续动作',
      updatedAt: idleAt,
      lastActiveAt: idleAt,
    }),
    makeTopic({
      topicId: BROWSER_TOPICS.inbox,
      title: '浏览器收件箱主题',
      status: 'active',
      digest: '承载四类请求 fixture',
      updatedAt: recent,
      lastActiveAt: recent,
    }),
    makeTopic({
      topicId: BROWSER_TOPICS.authDeny,
      title: '浏览器授权拒绝主题',
      status: 'active',
      blocked: true,
      blockedReason: 'authorization',
      blockedFromStatus: 'active',
      blockedAt: recent,
      authorization: {
        requestId: BROWSER_REQUESTS.authDeny,
        summary: AUTH_PAYLOAD.summary,
        requestedAt: recent,
      },
      digest: '等待用户拒绝授权',
      updatedAt: recent,
      lastActiveAt: recent,
    }),
    makeTopic({
      topicId: BROWSER_TOPICS.authAllow,
      title: '浏览器授权允许主题',
      status: 'active',
      blocked: true,
      blockedReason: 'authorization',
      blockedFromStatus: 'active',
      blockedAt: recent,
      authorization: {
        requestId: BROWSER_REQUESTS.authAllow,
        summary: AUTH_PAYLOAD.summary,
        requestedAt: recent,
      },
      digest: '等待用户允许授权',
      updatedAt: recent,
      lastActiveAt: recent,
    }),
    makeTopic({
      topicId: BROWSER_TOPICS.resolved,
      title: '浏览器已解决主题',
      status: 'resolved',
      digest: '已完成',
      updatedAt: resolvedAt,
      lastActiveAt: resolvedAt,
      resolvedAt,
      resolvedBy: 'user',
    }),
  ]
  const byId = new Map(topics.map(entry => [entry.topicId, entry]))
  const seed = makeSeedProject({ clock: () => now })
  const store = await seed(repoPath, topics, { master: masterSessionId })
  const inboxTopic = byId.get(BROWSER_TOPICS.inbox) ?? topics[1]
  const seedRequest = makeSeedRequest({ now, topic: inboxTopic, projectId: 'browser-fixture' })
  const requestSpecs = [
    { id: BROWSER_REQUESTS.reviewReturn, kind: 'user-review', payload: REVIEW_PAYLOAD, topicId: BROWSER_TOPICS.inbox },
    { id: BROWSER_REQUESTS.reviewPass, kind: 'user-review', payload: REVIEW_PAYLOAD, topicId: BROWSER_TOPICS.inbox },
    { id: BROWSER_REQUESTS.authDeny, kind: 'authorization', payload: AUTH_PAYLOAD, topicId: BROWSER_TOPICS.authDeny },
    { id: BROWSER_REQUESTS.authAllow, kind: 'authorization', payload: AUTH_PAYLOAD, topicId: BROWSER_TOPICS.authAllow },
    { id: BROWSER_REQUESTS.questionSkip, kind: 'question', payload: QUESTION_PAYLOAD, topicId: BROWSER_TOPICS.inbox },
    { id: BROWSER_REQUESTS.questionSubmit, kind: 'question', payload: QUESTION_PAYLOAD, topicId: BROWSER_TOPICS.inbox },
    { id: BROWSER_REQUESTS.questionMulti, kind: 'question', payload: QUESTION_MULTI_PAYLOAD, topicId: BROWSER_TOPICS.inbox },
    { id: BROWSER_REQUESTS.planRevise, kind: 'plan', payload: PLAN_PAYLOAD, topicId: BROWSER_TOPICS.inbox },
    { id: BROWSER_REQUESTS.planApprove, kind: 'plan', payload: PLAN_PAYLOAD, topicId: BROWSER_TOPICS.inbox },
    { id: BROWSER_REQUESTS.error, kind: 'authorization', payload: AUTH_PAYLOAD, topicId: BROWSER_TOPICS.inbox },
  ]
  for (const spec of requestSpecs) {
    await seedRequest(repoPath, store, {
      requestId: spec.id,
      topic: byId.get(spec.topicId) ?? inboxTopic,
      kind: spec.kind,
      payload: spec.payload,
      summary: `浏览器 fixture：${spec.kind}`,
    })
  }
  await mkdir(join(repoPath, 'docs'), { recursive: true })
  await writeFile(join(repoPath, 'docs', 'browser-plan.md'), '# Browser lane plan\n\nFixture only.\n', 'utf8')
  await store.appendActivity(buildActivityEvent({
    type: 'review-verdict',
    topicId: BROWSER_TOPICS.inbox,
    summary: '自动评审通过',
    details: { requestId: 'req-browser-auto', verdict: 'pass' },
  }, now))
  await store.appendActivity(decisionProposedActivity(inboxTopic, {
    proposalId: 'prob-browser-1',
    proposalPath: 'docs/browser-plan.md',
    title: '浏览器提案',
    summary: '提案：把浏览器 lane 的场景补齐到 floors 可评审',
  }, now))
  return {
    repoPath,
    masterSessionId,
    topics: Object.fromEntries(topics.map(entry => [entry.topicId, entry])),
    requests: BROWSER_REQUESTS,
    requestSpecs,
    now,
  }
}

/**
 * Seed a second workspace whose topic is the selected session itself, so the
 * panel renders the "back to master" breadcrumb (a topic session whose master
 * is a different, real session).
 */
export async function seedSecondaryProject(repoPath, { masterSessionId, topicId }) {
  const now = new Date().toISOString()
  const topic = makeTopicFixture()({
    topicId,
    title: '第二个浏览器会话',
    status: 'active',
    digest: '来自第二个 workspace',
    updatedAt: now,
    lastActiveAt: now,
  })
  const seed = makeSeedProject({ clock: () => new Date() })
  await seed(repoPath, [topic], { master: masterSessionId })
  return { repoPath, masterSessionId, topic }
}
