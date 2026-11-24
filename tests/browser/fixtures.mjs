/** Deterministic browser-lane project fixtures. */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
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

/** The seeded work item the browser scenarios open by stable id. */
export const BROWSER_ARTIFACT = 'artifact-browser-fixture'
/** The seeded project id `makeSeedProject` writes by default. */
const BROWSER_PROJECT_ID = 'p'
/** The seeded spec the work-item viewer opens. */
export const BROWSER_SPEC_PATH = 'docs/browser-spec.md'
/** The seeded spec content; line numbers in the scenario refer to this text. */
export const BROWSER_SPEC = [
  '# 浏览器交付物',
  '',
  '第一段：逐行批注。',
  '第二段：模型与用户共享的版本。',
  '第三段：刷新后批注仍在。',
].join('\n')

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
  await seedArtifact(repoPath, masterSessionId)
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
 * Seed one work item with one anchored thread.
 *
 * The owner is the real primary Session: every `artifact.*` call resolves the
 * project through `ownerSessionId`, so a synthetic id would make the viewer
 * unreadable. The record deliberately carries `fsVersion: null`: the first
 * detail read reconciles it against the host fs token, which is exactly the path
 * a real registration takes when the fs version is unavailable at create time.
 */
async function seedArtifact(repoPath, ownerSessionId) {
  await writeFile(join(repoPath, 'docs', 'browser-spec.md'), BROWSER_SPEC, 'utf8')
  const createdAt = new Date().toISOString()
  const artifactDir = join(repoPath, '.dsh-cowork', 'artifacts', BROWSER_ARTIFACT)
  await mkdir(artifactDir, { recursive: true })
  const record = {
    version: 1,
    artifactId: BROWSER_ARTIFACT,
    projectId: BROWSER_PROJECT_ID,
    ownerSessionId,
    title: '浏览器交付物',
    type: 'text',
    status: 'needs-feedback',
    files: [{
      path: BROWSER_SPEC_PATH,
      mediaType: 'text/markdown',
      editable: true,
      size: Buffer.byteLength(BROWSER_SPEC, 'utf8'),
      sha256: createHash('sha256').update(BROWSER_SPEC, 'utf8').digest('hex'),
      revision: 1,
      fsVersion: null,
      missing: false,
    }],
    primaryPath: BROWSER_SPEC_PATH,
    revision: 1,
    commentCount: 1,
    attachmentCount: 0,
    activeDispatch: null,
    createdAt,
    updatedAt: createdAt,
  }
  await writeFile(join(artifactDir, 'artifact.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  const comment = {
    version: 1,
    eventId: 'comment-event-browser-1',
    artifactId: BROWSER_ARTIFACT,
    commentId: 'comment-browser-1',
    threadId: 'comment-browser-1',
    type: 'create',
    author: 'user',
    body: '已有的浏览器批注',
    anchor: {
      kind: 'line-range',
      path: BROWSER_SPEC_PATH,
      startLine: 3,
      endLine: 3,
      quote: '第一段：逐行批注。',
      contextBefore: '',
      contextAfter: '第二段：模型与用户共享的版本。',
    },
    fileRevision: 1,
    createdAt,
  }
  await writeFile(join(artifactDir, 'comments.jsonl'), `${JSON.stringify(comment)}\n`, 'utf8')
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

/** The seeded work item whose published attachments the preview scenarios open. */
export const BROWSER_ATTACHMENT_ARTIFACT = 'artifact-browser-attachments'
/** A seeded work item with no attachments, for the empty page state. */
export const BROWSER_EMPTY_ARTIFACT = 'artifact-browser-empty'
/** The attachment work item's registered Markdown file. */
export const BROWSER_ATTACHMENT_PATH = 'docs/browser-attachments.md'
/** The empty work item's registered Markdown file. */
const BROWSER_EMPTY_PATH = 'docs/browser-empty.md'

/**
 * The published attachments of the seeded attachment work item, with the
 * natural sizes the preview assertions read back from the rendered image.
 *
 * The publish rows use the exact shape `cowork_artifact_attach` writes
 * (`source: 'model'`) and the comment refs use the shape a browser upload plus
 * comment submit writes (`source: 'user'`), so the page reads one real
 * `attachments.jsonl` instead of a mocked detail response.
 */
export const BROWSER_ATTACHMENTS = Object.freeze({
  rootThreadId: 'comment-browser-attachment-root',
  modelReplyId: 'comment-browser-attachment-model',
  userShot: Object.freeze({ attachmentId: 'attachment-browser-user-shot', name: 'shot.png', width: 640, height: 360 }),
  modelChart: Object.freeze({ attachmentId: 'attachment-browser-model-chart', name: 'model-chart.png', width: 1600, height: 400 }),
  userNote: Object.freeze({ attachmentId: 'attachment-browser-user-note', name: 'notes.txt' }),
  missing: Object.freeze({ attachmentId: 'attachment-browser-missing', name: 'missing.png', width: 320, height: 200 }),
  wide: Object.freeze({ attachmentId: 'attachment-browser-wide', name: 'wide.png', width: 2400, height: 600 }),
  long: Object.freeze({ attachmentId: 'attachment-browser-long', name: 'long.png', width: 600, height: 2400 }),
})

/** Head and tail of the seeded text attachment; the tail sits past the 64 KB preview cap. */
export const BROWSER_ATTACHMENT_TEXT_HEAD = 'BROWSER-TEXT-PREVIEW-HEAD'
export const BROWSER_ATTACHMENT_TEXT_TAIL = 'BROWSER-TEXT-PREVIEW-TAIL'

/** The Markdown the attachment work item registers; the image resolves from the publish log. */
const BROWSER_ATTACHMENT_MARKDOWN = [
  '# 附件联调',
  '',
  '模型生成的图表：',
  '',
  `![模型图表](cowork-attachment://${BROWSER_ATTACHMENTS.modelChart.attachmentId})`,
  '',
  '正文结尾。',
].join('\n')

/** One PNG chunk: length, type, payload, CRC-32. */
function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])) >>> 0)
  return Buffer.concat([length, typeBytes, data, crc])
}

/**
 * A solid-colour RGB PNG with the requested natural size.
 *
 * The lane needs real decodable images with known dimensions so the preview's
 * fit and zoom assertions can read back the natural size from `naturalWidth`.
 */
function makePng(width, height) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = 0x2f
    row[2 + x * 3] = 0x6f
    row[3 + x * 3] = 0xd0
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** The attachment ref one comment event and one publish row carry. */
function attachmentRefOf(spec, bytes) {
  return {
    attachmentId: spec.attachmentId,
    name: spec.name,
    mediaType: spec.name.endsWith('.png') ? 'image/png' : 'text/plain',
    size: bytes === null ? 0 : bytes.byteLength,
    sha256: bytes === null ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'),
  }
}

/** One publish row in the exact shape the attach tool writes. */
function publishRowOf(ref, source, publishedAt) {
  return {
    version: 1,
    attachmentId: ref.attachmentId,
    name: ref.name,
    mediaType: ref.mediaType,
    size: ref.size,
    sha256: ref.sha256,
    source,
    publishedAt,
  }
}

/** Write one upload byte file under the artifact directory. */
async function writeUpload(artifactDir, attachmentId, bytes) {
  const uploads = join(artifactDir, 'uploads')
  await mkdir(uploads, { recursive: true })
  await writeFile(join(uploads, attachmentId), bytes)
}

/**
 * Seed the published-attachment work item and the empty work item.
 *
 * The attachment item carries one user comment with an image, one model reply
 * with a second image, a text file past the preview cap, an image whose bytes
 * are deliberately absent (the missing state), and a wide/long image pair for
 * the fit assertions. The empty item has no publish log, comments, or uploads.
 * Both are seeded late by the browser scenario so the earlier scenarios keep
 * their own list counts.
 */
export async function seedAttachmentArtifacts(repoPath, ownerSessionId) {
  const createdAt = new Date().toISOString()
  await mkdir(join(repoPath, 'docs'), { recursive: true })
  await writeFile(join(repoPath, BROWSER_ATTACHMENT_PATH), BROWSER_ATTACHMENT_MARKDOWN, 'utf8')
  await writeFile(join(repoPath, BROWSER_EMPTY_PATH), '# 空附件\n\n还没有附件。\n', 'utf8')

  const artifactDir = join(repoPath, '.dsh-cowork', 'artifacts', BROWSER_ATTACHMENT_ARTIFACT)
  await mkdir(artifactDir, { recursive: true })
  const shotBytes = makePng(BROWSER_ATTACHMENTS.userShot.width, BROWSER_ATTACHMENTS.userShot.height)
  const chartBytes = makePng(BROWSER_ATTACHMENTS.modelChart.width, BROWSER_ATTACHMENTS.modelChart.height)
  const wideBytes = makePng(BROWSER_ATTACHMENTS.wide.width, BROWSER_ATTACHMENTS.wide.height)
  const longBytes = makePng(BROWSER_ATTACHMENTS.long.width, BROWSER_ATTACHMENTS.long.height)
  const noteBytes = Buffer.from(`${BROWSER_ATTACHMENT_TEXT_HEAD}\n${'x'.repeat(70_000)}\n${BROWSER_ATTACHMENT_TEXT_TAIL}\n`, 'utf8')
  const shotRef = attachmentRefOf(BROWSER_ATTACHMENTS.userShot, shotBytes)
  const chartRef = attachmentRefOf(BROWSER_ATTACHMENTS.modelChart, chartBytes)
  const noteRef = attachmentRefOf(BROWSER_ATTACHMENTS.userNote, noteBytes)
  const missingRef = attachmentRefOf(BROWSER_ATTACHMENTS.missing, null)
  const wideRef = attachmentRefOf(BROWSER_ATTACHMENTS.wide, wideBytes)
  const longRef = attachmentRefOf(BROWSER_ATTACHMENTS.long, longBytes)

  const file = {
    path: BROWSER_ATTACHMENT_PATH,
    mediaType: 'text/markdown',
    editable: true,
    size: Buffer.byteLength(BROWSER_ATTACHMENT_MARKDOWN, 'utf8'),
    sha256: createHash('sha256').update(BROWSER_ATTACHMENT_MARKDOWN, 'utf8').digest('hex'),
    revision: 1,
    fsVersion: null,
    missing: false,
  }
  const record = {
    version: 1,
    artifactId: BROWSER_ATTACHMENT_ARTIFACT,
    projectId: BROWSER_PROJECT_ID,
    ownerSessionId,
    title: '附件与预览',
    type: 'text',
    status: 'needs-feedback',
    files: [file],
    primaryPath: BROWSER_ATTACHMENT_PATH,
    revision: 1,
    commentCount: 2,
    attachmentCount: 6,
    activeDispatch: null,
    createdAt,
    updatedAt: createdAt,
  }
  await writeFile(join(artifactDir, 'artifact.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')

  const root = {
    version: 1,
    eventId: 'comment-event-browser-attachment-root',
    artifactId: BROWSER_ATTACHMENT_ARTIFACT,
    commentId: BROWSER_ATTACHMENTS.rootThreadId,
    threadId: BROWSER_ATTACHMENTS.rootThreadId,
    type: 'create',
    author: 'user',
    body: '模型生成了附件图表',
    anchor: {
      kind: 'line-range',
      path: BROWSER_ATTACHMENT_PATH,
      startLine: 3,
      endLine: 3,
      quote: '模型生成的图表：',
      contextBefore: '# 附件联调',
      contextAfter: '![模型图表]',
    },
    fileRevision: 1,
    attachments: [shotRef],
    createdAt,
  }
  const reply = {
    version: 1,
    eventId: 'comment-event-browser-attachment-model',
    artifactId: BROWSER_ATTACHMENT_ARTIFACT,
    commentId: BROWSER_ATTACHMENTS.modelReplyId,
    threadId: BROWSER_ATTACHMENTS.rootThreadId,
    type: 'reply',
    author: 'model',
    body: '已生成图表并挂到文档。',
    attachments: [chartRef],
    createdAt,
  }
  await writeFile(join(artifactDir, 'comments.jsonl'), `${JSON.stringify(root)}\n${JSON.stringify(reply)}\n`, 'utf8')

  const publishes = [
    publishRowOf(shotRef, 'user', createdAt),
    publishRowOf(chartRef, 'model', createdAt),
    publishRowOf(noteRef, 'user', createdAt),
    publishRowOf(missingRef, 'user', createdAt),
    publishRowOf(wideRef, 'user', createdAt),
    publishRowOf(longRef, 'user', createdAt),
  ]
  await writeFile(join(artifactDir, 'attachments.jsonl'), `${publishes.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8')

  await writeUpload(artifactDir, shotRef.attachmentId, shotBytes)
  await writeUpload(artifactDir, chartRef.attachmentId, chartBytes)
  await writeUpload(artifactDir, noteRef.attachmentId, noteBytes)
  await writeUpload(artifactDir, wideRef.attachmentId, wideBytes)
  await writeUpload(artifactDir, longRef.attachmentId, longBytes)

  const emptyFile = {
    path: BROWSER_EMPTY_PATH,
    mediaType: 'text/markdown',
    editable: true,
    size: Buffer.byteLength('# 空附件\n\n还没有附件。\n', 'utf8'),
    sha256: createHash('sha256').update('# 空附件\n\n还没有附件。\n', 'utf8').digest('hex'),
    revision: 1,
    fsVersion: null,
    missing: false,
  }
  const emptyDir = join(repoPath, '.dsh-cowork', 'artifacts', BROWSER_EMPTY_ARTIFACT)
  await mkdir(emptyDir, { recursive: true })
  const emptyRecord = {
    version: 1,
    artifactId: BROWSER_EMPTY_ARTIFACT,
    projectId: BROWSER_PROJECT_ID,
    ownerSessionId,
    title: '空附件',
    type: 'text',
    status: 'needs-feedback',
    files: [emptyFile],
    primaryPath: BROWSER_EMPTY_PATH,
    revision: 1,
    commentCount: 0,
    attachmentCount: 0,
    activeDispatch: null,
    createdAt,
    updatedAt: createdAt,
  }
  await writeFile(join(emptyDir, 'artifact.json'), `${JSON.stringify(emptyRecord, null, 2)}\n`, 'utf8')
}
