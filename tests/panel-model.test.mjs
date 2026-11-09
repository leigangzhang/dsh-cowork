import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import {
  FEEDBACK_TTL_MS,
  FINDING_SEVERITY_LABELS,
  FINDING_SEVERITY_TONES,
  INBOX_TITLE_MAX_CHARS,
  LIST_COLUMN_WIDTH,
  LONG_LIST_THRESHOLD,
  LONG_SUBJECT_THRESHOLD,
  PROJECT_PATH_MAX_CHARS,
  RESOLVED_BY_LABELS,
  REVIEW_STATUS_LABELS,
  REVIEW_STATUS_TONES,
  SPLIT_WIDTH_THRESHOLD,
  TOPIC_ID_MAX_CHARS,
  TOPIC_STATUS_LABELS,
  TOPIC_STATUS_TONES,
  WORK_ITEM_STATUS_LABELS,
  WORK_ITEM_STATUS_TONES,
  actionFailureMessage,
  chooseLayout,
  copyFailureMessage,
  copySuccessMessage,
  emptyNotice,
  errorPresentation,
  findingSeverityLabel,
  findingSeverityTone,
  formatLocalTimestamp,
  formatRelativeTime,
  inboxNotice,
  isLongList,
  isLongSubject,
  masterBreadcrumbLabel,
  middleEllipsis,
  moveIntentPrefill,
  moveSuccessMessage,
  moveTargets,
  openSessionFailureMessage,
  openSessionMessage,
  openSessionUnavailableMessage,
  openTopicSteps,
  reopenSuccessMessage,
  resolveSuccessMessage,
  resolvedByLabel,
  reviewBadgeTitle,
  reviewStatusLabel,
  reviewStatusTone,
  shortCommit,
  shortTopicId,
  statusChips,
  statusLabel,
  statusTone,
  surfaceState,
  topicActions,
  topicRow,
  verificationExitLabel,
  verificationTone,
  workItemStatusLabel,
  workItemStatusTone,
} from '../src/client/model.ts'
import {
  PanelApiError,
  errorMessage,
  loadActivity,
  loadOverview,
  loadTopic,
  moveTopic,
  panelApiPath,
  parseActivity,
  parseActivityEvent,
  parseCounts,
  parseInboxItem,
  parseOverview,
  parseReopen,
  parseResolve,
  parseReviewRequest,
  parseRouteMove,
  parseTopic,
  parseTopicRow,
  parseWorkItem,
  reopenTopic,
  resolveTopic,
  toPanelError,
} from '../src/client/api.ts'

/** Fixed clock: every relative-time assertion is independent of the wall clock. */
const NOW = Date.parse('2026-11-08T12:00:00.000Z')

/** An ISO timestamp `ms` before {@link NOW}. */
function ago(ms) {
  return new Date(NOW - ms).toISOString()
}

/** A complete wire topic; each test overrides only the field it is about. */
function topic(overrides = {}) {
  return {
    topicId: 'session-aaaa1111-2222',
    title: '一个主题',
    status: 'active',
    blocked: false,
    awaitingReview: false,
    reviewStatus: null,
    latestReviewRequestId: null,
    digest: '摘要',
    scope: '范围',
    ownedPaths: [],
    lastActiveAt: ago(0),
    updatedAt: ago(0),
    lastDeliveryConfirmedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    activeWorkItems: 0,
    ...overrides,
  }
}

/** Zero-filled wire counts with per-test overrides. */
function counts(overrides = {}) {
  return {
    active: 0,
    idle: 0,
    resolved: 0,
    blocked: 0,
    awaitingReview: 0,
    pendingReview: 0,
    workItemActive: 0,
    workItemReviewing: 0,
    workItemMerged: 0,
    workItemAbandoned: 0,
    ...overrides,
  }
}

/** A complete wire work item. */
function workItem(overrides = {}) {
  return {
    workItemId: 'work-1',
    topicId: 'session-aaaa1111-2222',
    path: '/tmp/wi',
    branch: 'dsh-wt/x/wi',
    baseCommit: 'aaaaaaa1111111',
    headCommit: 'bbbbbbb2222222',
    status: 'active',
    updatedAt: ago(0),
    ...overrides,
  }
}

/** A complete wire inbox item. */
function inboxItem(overrides = {}) {
  return {
    id: 'inbox-1',
    time: ago(0),
    topicId: 'session-aaaa1111-2222',
    kind: 'merge-needed',
    summary: '合并需要处理',
    deliveredAt: null,
    ...overrides,
  }
}

/** A complete wire review request. */
function reviewRequest(overrides = {}) {
  return {
    requestId: 'req-0001',
    topicId: 'session-aaaa1111-2222',
    workItemId: null,
    purpose: '评审这次改动',
    status: 'pending',
    baseCommit: 'aaaaaaa1111111',
    headCommit: 'bbbbbbb2222222',
    changedPaths: ['src/api-contract.ts'],
    requestedAt: ago(0),
    reviewedAt: null,
    summary: null,
    findings: [],
    verification: [],
    ...overrides,
  }
}

/** A complete wire activity event. */
function activityEvent(overrides = {}) {
  return {
    eventId: 'evt-1',
    time: ago(0),
    type: 'status-changed',
    topicId: 'session-aaaa1111-2222',
    summary: '状态改为 active',
    ...overrides,
  }
}

test('layout constants and the 480px split switch', () => {
  assert.equal(SPLIT_WIDTH_THRESHOLD, 480)
  assert.equal(LIST_COLUMN_WIDTH, 248)
  assert.equal(chooseLayout(648), 'split')
  assert.equal(chooseLayout(481), 'split')
  assert.equal(chooseLayout(480), 'drill')
  assert.equal(chooseLayout(320), 'drill')
  assert.equal(chooseLayout(0), 'drill')
  assert.equal(chooseLayout(-10), 'drill')
})

test('an unmeasured width stays drill (never squeeze two columns)', () => {
  assert.equal(chooseLayout(null), 'drill')
  assert.equal(chooseLayout(undefined), 'drill')
  assert.equal(chooseLayout(Number.NaN), 'drill')
  assert.equal(chooseLayout(Number.POSITIVE_INFINITY), 'drill')
})

test('list and title length states have explicit thresholds', () => {
  assert.equal(LONG_LIST_THRESHOLD, 12)
  assert.equal(isLongList(12), false)
  assert.equal(isLongList(13), true)
  assert.equal(isLongList(0), false)
  assert.equal(LONG_SUBJECT_THRESHOLD, 48)
  assert.equal(isLongSubject('x'.repeat(48)), false)
  assert.equal(isLongSubject('x'.repeat(49)), true)
})

test('middleEllipsis keeps both ends of a path', () => {
  const path = '/Users/someone/Workspace/deepseek-harness/plugins/dsh-cowork'
  const shortened = middleEllipsis(path, PROJECT_PATH_MAX_CHARS)
  assert.ok(shortened.length <= PROJECT_PATH_MAX_CHARS, `length ${shortened.length}`)
  assert.ok(shortened.startsWith('/Users/'))
  assert.ok(shortened.endsWith('dsh-cowork'))
  assert.ok(shortened.includes('…'))
  assert.equal(middleEllipsis('/tmp/short', PROJECT_PATH_MAX_CHARS), '/tmp/short')
  assert.equal(middleEllipsis('abcdef', 3), 'a…f')
})

test('shortTopicId and shortCommit truncate ids and commits', () => {
  assert.equal(TOPIC_ID_MAX_CHARS, 8)
  assert.equal(shortTopicId('session-2accc833-153c'), 'session-')
  assert.equal(shortTopicId('abc'), 'abc')
  assert.equal(shortCommit(null), '—')
  assert.equal(shortCommit(''), '—')
  assert.equal(shortCommit('abc1234'), 'abc1234')
  assert.equal(shortCommit('abc1234def5678'), 'abc1234')
})

test('surfaceState picks loading, empty, error and default', () => {
  assert.equal(surfaceState({ loading: true, error: null, topicCount: 0 }), 'loading')
  assert.equal(surfaceState({ loading: true, error: { code: 'store/corrupt', message: 'x' }, topicCount: 3 }), 'loading')
  assert.equal(surfaceState({ loading: false, error: { code: 'project/not-initialized', message: 'x' }, topicCount: 0 }), 'empty')
  assert.equal(surfaceState({ loading: false, error: { code: 'store/corrupt', message: 'x' }, topicCount: 0 }), 'error')
  assert.equal(surfaceState({ loading: false, error: null, topicCount: 0 }), 'empty')
  assert.equal(surfaceState({ loading: false, error: null, topicCount: 1 }), 'default')
})

test('topic states have Chinese labels and every state keeps visible text', () => {
  assert.deepEqual(TOPIC_STATUS_LABELS, { active: '进行中', idle: '空闲', resolved: '已解决' })
  assert.equal(statusLabel('active'), '进行中')
  assert.equal(statusLabel('idle'), '空闲')
  assert.equal(statusLabel('resolved'), '已解决')
  assert.equal(statusLabel('archived'), 'archived', 'an invented state stays visible')
  for (const status of Object.keys(TOPIC_STATUS_LABELS)) {
    assert.ok(statusLabel(status).trim().length > 0, `${status} has visible text`)
  }

  assert.deepEqual(TOPIC_STATUS_TONES, { active: 'success', idle: 'idle', resolved: 'success' })
  assert.equal(statusTone('active'), 'success')
  assert.equal(statusTone('idle'), 'idle')
  assert.equal(statusTone('resolved'), 'success')
  assert.equal(statusTone('archived'), 'idle')
})

test('resolution source labels distinguish user and automated resolves', () => {
  assert.deepEqual(RESOLVED_BY_LABELS, { user: '用户', master: '自动' })
  assert.equal(resolvedByLabel('user'), '用户')
  assert.equal(resolvedByLabel('master'), '自动')
  assert.equal(resolvedByLabel('robot'), 'robot', 'an invented source stays visible')
})

test('review states, finding severities and work-item states all have labels and tones', () => {
  assert.deepEqual(REVIEW_STATUS_LABELS, {
    pending: '审查中',
    pass: '审查通过',
    needs_revision: '需修改',
    reject: '已拒绝',
  })
  assert.equal(reviewStatusLabel('needs_revision'), '需修改')
  assert.equal(reviewStatusLabel('unknown'), 'unknown')
  assert.equal(reviewStatusTone('pending'), 'warn')
  assert.equal(reviewStatusTone('pass'), 'success')
  assert.equal(reviewStatusTone('needs_revision'), 'warn')
  assert.equal(reviewStatusTone('reject'), 'error')
  assert.equal(reviewStatusTone('unknown'), 'idle')
  assert.deepEqual(Object.keys(REVIEW_STATUS_TONES).sort(), ['needs_revision', 'pass', 'pending', 'reject'])

  assert.deepEqual(FINDING_SEVERITY_LABELS, {
    blocker: '阻断', high: '高', medium: '中', low: '低',
  })
  assert.equal(findingSeverityLabel('blocker'), '阻断')
  assert.equal(findingSeverityLabel('critical'), 'critical')
  assert.equal(findingSeverityTone('blocker'), 'error')
  assert.equal(findingSeverityTone('high'), 'error')
  assert.equal(findingSeverityTone('medium'), 'warn')
  assert.equal(findingSeverityTone('low'), 'idle')
  assert.equal(findingSeverityTone('critical'), 'idle')
  assert.deepEqual(Object.keys(FINDING_SEVERITY_TONES).sort(), ['blocker', 'high', 'low', 'medium'])

  assert.deepEqual(WORK_ITEM_STATUS_LABELS, {
    active: '进行中', reviewing: '审查中', merged: '已合并', abandoned: '已放弃',
  })
  assert.equal(workItemStatusLabel('reviewing'), '审查中')
  assert.equal(workItemStatusLabel('weird'), 'weird')
  assert.equal(workItemStatusTone('merged'), 'idle')
  assert.equal(workItemStatusTone('abandoned'), 'error')
  assert.equal(workItemStatusTone('weird'), 'idle')
  assert.deepEqual(Object.keys(WORK_ITEM_STATUS_TONES).sort(), ['abandoned', 'active', 'merged', 'reviewing'])
})

test('header chips follow the fixed order, labels and current counts', () => {
  const chips = statusChips(counts({ active: 2, idle: 1, resolved: 3, blocked: 4, awaitingReview: 5 }))
  assert.deepEqual(chips.map(chip => chip.key), ['active', 'idle', 'resolved', 'blocked', 'awaitingReview'])
  assert.deepEqual(chips.map(chip => chip.label), ['进行中', '空闲', '已解决', '受阻', '待评审'])
  assert.deepEqual(chips.map(chip => chip.count), [2, 1, 3, 4, 5])
  assert.deepEqual(chips.map(chip => chip.tone), ['success', 'idle', 'success', 'error', 'warn'])
  for (const chip of chips) assert.ok(chip.label.trim().length > 0)

  const missing = statusChips({})
  assert.deepEqual(missing.map(chip => chip.count), [0, 0, 0, 0, 0], 'missing counts read as zero')
})

test('topicRow carries state, markers, review badge and resolution source', () => {
  const plain = topicRow(topic({ digest: '改了路由', activeWorkItems: 2 }))
  assert.equal(plain.statusLabel, '进行中')
  assert.equal(plain.statusTone, 'success')
  assert.deepEqual(plain.markers, [])
  assert.equal(plain.reviewLabel, null)
  assert.equal(plain.reviewTone, null)
  assert.equal(plain.reviewTitle, null)
  assert.equal(plain.digest, '改了路由')
  assert.equal(plain.resolvedByLabel, null)
  assert.equal(plain.hasActiveWork, true)

  const marked = topicRow(topic({ blocked: true, awaitingReview: true, reviewStatus: 'needs_revision' }))
  assert.deepEqual(marked.markers, [
    { label: '受阻', tone: 'error' },
    { label: '待评审', tone: 'warn' },
  ])
  assert.equal(marked.reviewLabel, '需修改')
  assert.equal(marked.reviewTone, 'warn')
  assert.equal(marked.reviewTitle, '需修改')
  assert.equal(marked.hasActiveWork, false)

  assert.equal(topicRow(topic({ status: 'resolved', resolvedBy: 'user' })).resolvedByLabel, '用户')
  assert.equal(topicRow(topic({ status: 'resolved', resolvedBy: 'master' })).resolvedByLabel, '自动')
  assert.equal(topicRow(topic({ reviewStatus: 'pass' })).reviewLabel, '审查通过')
})

test('topicActions allow the right action per state and warn before resolving open work', () => {
  const active = topicActions(topic({ status: 'active', activeWorkItems: 0 }))
  assert.deepEqual(active, { canResolve: true, canReopen: false, canMove: true, resolveWarning: null })

  const busy = topicActions(topic({ status: 'idle', activeWorkItems: 3 }))
  assert.equal(busy.canResolve, true)
  assert.equal(busy.canMove, true)
  assert.equal(busy.resolveWarning, '该主题仍有 3 个工作项在跑；标记已解决后不可撤销')

  const resolved = topicActions(topic({ status: 'resolved' }))
  assert.deepEqual(resolved, { canResolve: false, canReopen: true, canMove: false, resolveWarning: null })
})

test('moveTargets keeps the overview order and drops self and resolved topics', () => {
  const self = topic({ topicId: 'self' })
  const open = topic({ topicId: 'open' })
  const idle = topic({ topicId: 'idle', status: 'idle' })
  const done = topic({ topicId: 'done', status: 'resolved' })
  const targets = moveTargets([self, open, done, idle], 'self')
  assert.deepEqual(targets.map(entry => entry.topicId), ['open', 'idle'])
  assert.deepEqual(moveTargets([self], 'self'), [])
  assert.deepEqual(moveTargets([], 'self'), [])
})

test('moveIntentPrefill uses the digest, falling back to the title', () => {
  assert.equal(moveIntentPrefill(topic({ digest: '把路由改到别的主题' })), '把路由改到别的主题')
  assert.equal(moveIntentPrefill(topic({ digest: '   ', title: '一个主题' })), '一个主题')
  assert.equal(moveIntentPrefill(topic({ digest: '', title: '只有标题' })), '只有标题')
})

test('opening a topic has fixed steps and a master breadcrumb', () => {
  assert.deepEqual([...openTopicSteps()], ['unarchive', 'open'])
  assert.equal(masterBreadcrumbLabel(), '返回 master')
})

test('inboxNotice counts waiting items and shows at most five summaries', () => {
  assert.equal(inboxNotice([]), null)

  const one = inboxNotice([inboxItem({ summary: '合并需要处理' })])
  assert.deepEqual(one, { count: 1, label: '待处理 1', title: '合并需要处理' })

  const two = inboxNotice([
    inboxItem({ id: 'a', summary: '第一条' }),
    inboxItem({ id: 'b', summary: '第二条' }),
  ])
  assert.equal(two.count, 2)
  assert.equal(two.label, '待处理 2')
  assert.equal(two.title, '第一条 · 第二条')

  const many = inboxNotice(Array.from({ length: 7 }, (_, index) => inboxItem({
    id: `i${index}`,
    summary: `摘要 ${index + 1}`,
  })))
  assert.equal(many.count, 7)
  assert.equal(many.label, '待处理 7')
  assert.equal(many.title, '摘要 1 · 摘要 2 · 摘要 3 · 摘要 4 · 摘要 5')
  assert.equal(many.title.includes('摘要 6'), false, 'only the first five summaries are joined')

  const long = inboxNotice(Array.from({ length: 2 }, (_, index) => inboxItem({
    id: `long${index}`,
    summary: 'x'.repeat(200),
  })))
  assert.ok(long.title.length <= INBOX_TITLE_MAX_CHARS, `title length ${long.title.length}`)
  assert.ok(long.title.includes('…'))

  const blank = inboxNotice([inboxItem({ summary: '   ' }), inboxItem({ id: 'b', summary: '' })])
  assert.equal(blank.title, '有未投递的收件箱条目')
})

test('errorPresentation covers the five named codes and a retryable generic one', () => {
  const notInitialized = errorPresentation({ code: 'project/not-initialized', message: 'no project' })
  assert.equal(notInitialized.kind, 'empty')
  assert.equal(notInitialized.retry, false)
  assert.equal(notInitialized.code, 'project/not-initialized')
  assert.equal(notInitialized.hint, 'cowork_project_init')
  assert.match(notInitialized.detail, /cowork_project_init/)

  const notFound = errorPresentation({ code: 'topic/not-found', message: 'gone' })
  assert.equal(notFound.kind, 'empty')
  assert.equal(notFound.retry, true)
  assert.equal(notFound.code, 'topic/not-found')
  assert.match(notFound.title, /主题/)

  const corrupt = errorPresentation({
    code: 'store/corrupt',
    message: 'index.json unreadable',
    path: '/repo/.dsh-cowork/index.json',
  })
  assert.equal(corrupt.kind, 'error')
  assert.equal(corrupt.code, 'store/corrupt')
  assert.equal(corrupt.path, '/repo/.dsh-cowork/index.json')
  assert.equal(corrupt.detail, 'index.json unreadable')
  assert.equal(corrupt.retry, true)

  const notMaster = errorPresentation({ code: 'request/not-master', message: 'x' })
  assert.equal(notMaster.kind, 'error')
  assert.equal(notMaster.retry, false)
  assert.match(notMaster.title, /master/)

  const origin = errorPresentation({ code: 'request/origin', message: 'x' })
  assert.equal(origin.kind, 'error')
  assert.equal(origin.retry, false)
  assert.equal(origin.code, 'request/origin')

  const generic = errorPresentation({ code: 'internal', message: 'boom' })
  assert.equal(generic.kind, 'error')
  assert.equal(generic.code, 'internal')
  assert.equal(generic.retry, true)

  const missing = errorPresentation(null)
  assert.equal(missing.kind, 'error')
  assert.equal(missing.code, null)
  assert.equal(missing.retry, true)
})

test('an empty project points at cowork_topic_create', () => {
  const notice = emptyNotice('no-topics')
  assert.equal(notice.kind, 'empty')
  assert.equal(notice.code, null)
  assert.equal(notice.retry, true)
  assert.equal(notice.hint, 'cowork_topic_create')
  assert.match(notice.title, /主题/)
  assert.match(notice.detail, /cowork_topic_create/)
})

test('action receipts are visible, specific and never silent', () => {
  const topicId = 'session-abcdef12-3456'
  const short = shortTopicId(topicId)
  assert.match(openSessionMessage(topicId), new RegExp(short))
  assert.match(openSessionMessage(topicId), /已切换/)
  assert.match(openSessionUnavailableMessage(), /无法打开/)
  assert.match(openSessionFailureMessage(''), /打开主题失败/)
  assert.match(openSessionFailureMessage('navigating'), /navigating/)

  assert.match(resolveSuccessMessage(topicId), new RegExp(short))
  assert.match(resolveSuccessMessage(topicId), /已解决/)
  assert.match(reopenSuccessMessage(topicId), new RegExp(short))
  assert.match(reopenSuccessMessage(topicId), /重新打开/)

  assert.match(moveSuccessMessage({ changed: true, addedCount: 3 }), /新增 3 个别名/)
  assert.match(moveSuccessMessage({ changed: false, addedCount: 0 }), /没有改动/)

  assert.match(actionFailureMessage('标记已解决', 'boom'), /标记已解决失败/)
  assert.match(actionFailureMessage('标记已解决', 'boom'), /boom/)
  assert.match(actionFailureMessage('重新打开', ''), /重新打开失败$/)

  assert.match(copySuccessMessage(), /复制/)
  assert.match(copyFailureMessage('权限被拒绝'), /复制失败/)
  assert.match(copyFailureMessage('权限被拒绝'), /权限被拒绝/)
  assert.ok(FEEDBACK_TTL_MS >= 1000)
})

test('relative times cover minutes, hours, days and the absolute fallback', () => {
  const minute = 60 * 1000
  assert.equal(formatRelativeTime(ago(30 * 1000), NOW), '刚刚')
  assert.equal(formatRelativeTime(ago(5 * minute), NOW), '5 分钟前')
  assert.equal(formatRelativeTime(ago(3 * 60 * minute), NOW), '3 小时前')
  assert.equal(formatRelativeTime(ago(2 * 24 * 60 * minute), NOW), '2 天前')
  assert.match(formatRelativeTime(ago(30 * 24 * 60 * minute), NOW), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.equal(formatRelativeTime('not-a-date', NOW), '时间未知')
  assert.equal(formatRelativeTime(ago(-minute), NOW), '刚刚', 'a future timestamp reads as just now')
})

test('absolute timestamps are padded and never invented', () => {
  assert.match(formatLocalTimestamp('2026-01-02T03:04:05.000Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.equal(formatLocalTimestamp('nope'), '时间未知')
})

test('verification rows distinguish success from failure by text and tone', () => {
  assert.equal(verificationExitLabel(0), 'exit 0')
  assert.equal(verificationExitLabel(1), 'exit 1')
  assert.equal(verificationTone(0), 'success')
  assert.equal(verificationTone(1), 'error')
  assert.equal(verificationTone(127), 'error')
})

test('the review badge title carries the absolute time and the finding count', () => {
  assert.equal(reviewBadgeTitle('pass', null), '审查通过')
  const withTime = reviewBadgeTitle('needs_revision', '2026-01-02T03:04:05.000Z')
  assert.match(withTime, /^需修改 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.equal(reviewBadgeTitle('reject', null, 3), '已拒绝 · 3 条 finding')
  assert.equal(reviewBadgeTitle('pass', 'not-a-date'), '审查通过 · 时间未知')
  assert.equal(reviewBadgeTitle('pending', '  '), '审查中', 'a blank time adds nothing')
})

test('parseOverview drops unusable rows but keeps the usable ones', () => {
  const body = {
    ok: true,
    project: {
      repoPath: '/repo',
      projectId: 'proj-1',
      masterSessionId: 'session-master',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    counts: counts({ active: 2, idle: 1, resolved: 1, blocked: 1, awaitingReview: 1, pendingReview: 1, workItemActive: 3 }),
    topics: [
      topic(),
      topic({ topicId: 'bad-status', status: 'archived' }),
      { topicId: '', status: 'active' },
      { title: '缺少 id', status: 'active' },
      'nonsense',
      null,
    ],
    inbox: [
      inboxItem({ id: 'i1' }),
      { id: '', summary: '缺少 id' },
      null,
    ],
  }
  const parsed = parseOverview(body)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.project.masterSessionId, 'session-master')
  assert.equal(parsed.topics.length, 1)
  assert.equal(parsed.topics[0].topicId, 'session-aaaa1111-2222')
  assert.equal(parsed.inbox.length, 1)
  assert.equal(parsed.inbox[0].id, 'i1')
  assert.deepEqual(parsed.counts, counts({
    active: 2, idle: 1, resolved: 1, blocked: 1, awaitingReview: 1, pendingReview: 1, workItemActive: 3,
  }))
})

test('parseOverview rejects a body without the required envelope and arrays', () => {
  assert.throws(() => parseOverview(null), (reason) => reason instanceof PanelApiError && reason.code === 'internal')
  assert.throws(() => parseOverview({ ok: false }), (reason) => reason instanceof PanelApiError)
  const base = { ok: true, project: {}, counts: {}, inbox: [] }
  assert.throws(() => parseOverview(base), (reason) => reason instanceof PanelApiError && /topics/.test(reason.message))
})

test('parseTopicRow keeps the load-bearing id and state, degrades the rest', () => {
  const parsed = parseTopicRow({
    ...topic(),
    reviewStatus: 'needs_revision',
    resolvedBy: 'master',
    resolvedAt: '2026-11-01T00:00:00.000Z',
    ownedPaths: ['src/a.ts', 42, null, 'src/b.ts'],
    activeWorkItems: -2,
    blocked: 'yes',
    awaitingReview: 1,
  })
  assert.equal(parsed.reviewStatus, 'needs_revision')
  assert.equal(parsed.resolvedBy, 'master')
  assert.deepEqual(parsed.ownedPaths, ['src/a.ts', 'src/b.ts'])
  assert.equal(parsed.activeWorkItems, 0)
  assert.equal(parsed.blocked, false, 'only a real true counts as blocked')
  assert.equal(parsed.awaitingReview, false)

  assert.equal(parseTopicRow({ ...topic(), status: 'archived' }), null)
  assert.equal(parseTopicRow({ ...topic(), topicId: '  ' }), null)
  assert.equal(parseTopicRow({ ...topic(), resolvedBy: 'robot' }).resolvedBy, null)
  assert.equal(parseTopicRow({ ...topic(), reviewStatus: 'invented' }).reviewStatus, null)
  assert.equal(parseTopicRow('nope'), null)
})

test('parseWorkItem and parseReviewRequest drop only the broken rows', () => {
  const item = parseWorkItem(workItem())
  assert.equal(item.workItemId, 'work-1')
  assert.equal(item.status, 'active')
  assert.equal(item.baseCommit, 'aaaaaaa1111111')
  assert.equal(parseWorkItem(workItem({ status: 'weird' })), null)
  assert.equal(parseWorkItem(workItem({ workItemId: '' })), null)
  assert.equal(parseWorkItem(workItem({ topicId: '' })), null)
  assert.equal(parseWorkItem(workItem({ baseCommit: '' })).baseCommit, null)

  const request = parseReviewRequest(reviewRequest({
    summary: '整体可用',
    findings: [
      { id: 'F1', severity: 'blocker', problem: 'p', requiredFix: 'fix', file: 'src/a.ts', line: 7 },
      { id: 'F2', severity: 'critical', problem: 'p', requiredFix: 'fix' },
      { id: '', severity: 'high', problem: 'p', requiredFix: 'fix' },
    ],
    verification: [
      { command: 'npm test', exitCode: 0, evidence: 'ok' },
      { command: 'npm run build', exitCode: 1.5, evidence: 'bad' },
      { command: '', exitCode: 0, evidence: 'bad' },
    ],
  }))
  assert.equal(request.findings.length, 1)
  assert.equal(request.findings[0].file, 'src/a.ts')
  assert.equal(request.findings[0].line, 7)
  assert.equal(request.verification.length, 1)
  assert.equal(request.verification[0].command, 'npm test')
  assert.equal(request.summary, '整体可用')
  assert.equal(parseReviewRequest(reviewRequest({ status: 'done' })), null)
  assert.equal(parseReviewRequest(reviewRequest({ requestId: '' })), null)
  assert.equal(parseReviewRequest(reviewRequest({ summary: 42 })).summary, null)
})

test('parseActivity, parseActivityEvent and parseInboxItem drop unusable rows', () => {
  const event = parseActivityEvent(activityEvent())
  assert.equal(event.eventId, 'evt-1')
  assert.equal(event.type, 'status-changed')
  assert.equal(parseActivityEvent({ eventId: 'e', time: '' }), null)
  assert.equal(parseActivityEvent({ time: ago(0) }), null)
  assert.equal(parseActivityEvent({ eventId: 'e', time: ago(0), type: 42 }).type, '')

  const parsed = parseActivity({
    ok: true,
    events: [activityEvent(), { eventId: '', time: ago(0) }, null],
    skippedLines: 3,
  })
  assert.equal(parsed.events.length, 1)
  assert.equal(parsed.skippedLines, 3)
  assert.equal(parseActivity({ ok: true, events: [], skippedLines: 'x' }).skippedLines, 0)
  assert.throws(() => parseActivity({ ok: true }), (reason) => reason instanceof PanelApiError)

  const item = parseInboxItem(inboxItem())
  assert.equal(item.id, 'inbox-1')
  assert.equal(item.deliveredAt, null)
  assert.equal(parseInboxItem({ id: '' }), null)
  assert.equal(parseInboxItem(null), null)
})

test('parseTopic composes the detail arrays and rejects an unusable topic', () => {
  const parsed = parseTopic({
    ok: true,
    topic: topic(),
    workItems: [workItem(), workItem({ workItemId: '' }), workItem({ status: 'weird' })],
    reviewRequests: [reviewRequest(), reviewRequest({ requestId: '' })],
    activity: [activityEvent(), { eventId: '', time: ago(0) }],
  })
  assert.equal(parsed.topic.topicId, 'session-aaaa1111-2222')
  assert.equal(parsed.workItems.length, 1)
  assert.equal(parsed.reviewRequests.length, 1)
  assert.equal(parsed.activity.length, 1)
  assert.throws(() => parseTopic({ ok: true, topic: { topicId: 'x', status: 'nope' }, workItems: [], reviewRequests: [], activity: [] }))
  assert.throws(() => parseTopic({ ok: true, topic: topic(), workItems: [], reviewRequests: [] }), (reason) => /activity/.test(reason.message))
})

test('parseResolve, parseReopen and parseRouteMove narrow the write responses', () => {
  const resolved = parseResolve({
    ok: true,
    topic: topic({ status: 'resolved', resolvedBy: 'user', resolvedAt: ago(0) }),
    alreadyResolved: true,
  })
  assert.equal(resolved.alreadyResolved, true)
  assert.equal(resolved.topic.status, 'resolved')
  assert.equal(parseResolve({ ok: true, topic: topic() }).alreadyResolved, false)

  const reopened = parseReopen({ ok: true, topic: topic() })
  assert.equal(reopened.topic.status, 'active')

  const moved = parseRouteMove({
    ok: true,
    topic: topic(),
    changed: true,
    added: ['alias-1', 42],
    aliases: ['alias-1', 'alias-2'],
  })
  assert.equal(moved.changed, true)
  assert.deepEqual(moved.added, ['alias-1'])
  assert.deepEqual(moved.aliases, ['alias-1', 'alias-2'])
  assert.deepEqual(parseRouteMove({ ok: true, topic: topic() }).added, [])
})

test('parseCounts zero-fills missing and invented fields', () => {
  assert.deepEqual(parseCounts({ active: 2, idle: 'x', resolved: -1, blocked: 1.5, awaitingReview: 4 }), counts({
    active: 2, awaitingReview: 4,
  }))
  assert.deepEqual(parseCounts(null), counts())
})

test('panelApiPath encodes query values', () => {
  assert.equal(
    panelApiPath('/api/cowork.topic', { sessionId: 'a b', topicId: 'x&y' }),
    '/api/cowork.topic?sessionId=a+b&topicId=x%26y',
  )
  assert.equal(panelApiPath('/api/cowork.overview', {}), '/api/cowork.overview')
})

/** Run `run` with a captured global fetch; returns every request it saw. */
async function captureFetch(run, respond) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} })
    return respond()
  }
  try {
    await run()
  } finally {
    globalThis.fetch = original
  }
  return calls
}

test('loadOverview sends a same-origin, uncached GET with the session id', async () => {
  const calls = await captureFetch(
    () => loadOverview('session-master'),
    () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        project: { repoPath: '/repo', projectId: 'p', masterSessionId: 'session-master', createdAt: ago(0) },
        counts: counts(),
        topics: [],
        inbox: [],
      }),
    }),
  )
  assert.equal(calls.length, 1)
  const [call] = calls
  assert.equal(call.url, '/api/cowork.overview?sessionId=session-master')
  assert.equal(call.init.method, 'GET')
  assert.equal(call.init.credentials, 'same-origin')
  assert.equal(call.init.cache, 'no-store')
  assert.equal(call.init.headers.accept, 'application/json')
  assert.equal(call.init.body, undefined)
})

test('loadTopic and loadActivity send the documented query keys', async () => {
  const topicCalls = await captureFetch(
    () => loadTopic('s-master', 'topic-1'),
    () => ({ ok: true, status: 200, json: async () => ({ ok: true, topic: topic(), workItems: [], reviewRequests: [], activity: [] }) }),
  )
  assert.equal(topicCalls[0].url, '/api/cowork.topic?sessionId=s-master&topicId=topic-1')

  const activityCalls = await captureFetch(
    () => loadActivity('s-master', 999),
    () => ({ ok: true, status: 200, json: async () => ({ ok: true, events: [], skippedLines: 0 }) }),
  )
  assert.equal(activityCalls[0].url, '/api/cowork.activity?sessionId=s-master&limit=200', 'the limit is clamped to the wire maximum')
})

test('write routes POST JSON with content-type and keep same-origin/no-store', async () => {
  const resolveCalls = await captureFetch(
    () => resolveTopic('s-master', 'topic-1'),
    () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, topic: topic({ status: 'resolved', resolvedBy: 'user' }), alreadyResolved: false }),
    }),
  )
  const resolveCall = resolveCalls[0]
  assert.equal(resolveCall.url, '/api/cowork.topic.resolve')
  assert.equal(resolveCall.init.method, 'POST')
  assert.equal(resolveCall.init.credentials, 'same-origin')
  assert.equal(resolveCall.init.cache, 'no-store')
  assert.equal(resolveCall.init.headers['content-type'], 'application/json')
  assert.equal(resolveCall.init.headers.accept, 'application/json')
  assert.deepEqual(JSON.parse(resolveCall.init.body), { sessionId: 's-master', topicId: 'topic-1' })

  const reopenCalls = await captureFetch(
    () => reopenTopic('s-master', 'topic-1'),
    () => ({ ok: true, status: 200, json: async () => ({ ok: true, topic: topic() }) }),
  )
  assert.equal(reopenCalls[0].url, '/api/cowork.topic.reopen')
  assert.deepEqual(JSON.parse(reopenCalls[0].init.body), { sessionId: 's-master', topicId: 'topic-1' })

  const moveCalls = await captureFetch(
    () => moveTopic('s-master', 'from-1', 'to-1', '  这条路由属于另一个主题  '),
    () => ({ ok: true, status: 200, json: async () => ({ ok: true, topic: topic(), changed: true, added: ['a'], aliases: ['a'] }) }),
  )
  assert.equal(moveCalls[0].url, '/api/cowork.route.move')
  assert.deepEqual(JSON.parse(moveCalls[0].init.body), {
    sessionId: 's-master',
    fromTopicId: 'from-1',
    toTopicId: 'to-1',
    intent: '这条路由属于另一个主题',
  })
})

test('a blank move intent is omitted instead of sent as an empty string', async () => {
  const calls = await captureFetch(
    () => moveTopic('s-master', 'from-1', 'to-1', '   '),
    () => ({ ok: true, status: 200, json: async () => ({ ok: true, topic: topic(), changed: false, added: [], aliases: [] }) }),
  )
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    sessionId: 's-master',
    fromTopicId: 'from-1',
    toTopicId: 'to-1',
  })
})

test('a host error envelope becomes a PanelApiError with code, message and path', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    json: async () => ({
      ok: false,
      error: { code: 'request/not-master', message: '只有 master 可以操作', path: 'topic-1' },
    }),
  })
  try {
    await assert.rejects(
      () => loadOverview('session-master'),
      (reason) => {
        assert.ok(reason instanceof PanelApiError)
        assert.equal(reason.code, 'request/not-master')
        assert.equal(reason.message, '只有 master 可以操作')
        assert.equal(reason.path, 'topic-1')
        return true
      },
    )
    await assert.rejects(
      () => resolveTopic('session-master', 'topic-1'),
      (reason) => reason instanceof PanelApiError && reason.code === 'request/not-master',
    )
  } finally {
    globalThis.fetch = original
  }
})

test('non-JSON and non-ok bodies without an envelope become internal errors', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('bad json') },
    })
    await assert.rejects(
      () => loadOverview('s'),
      (reason) => reason instanceof PanelApiError && reason.code === 'internal' && /不是 JSON/.test(reason.message),
    )

    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ unexpected: true }) })
    await assert.rejects(
      () => loadOverview('s'),
      (reason) => reason instanceof PanelApiError && reason.code === 'internal' && /HTTP 500/.test(reason.message),
    )
  } finally {
    globalThis.fetch = original
  }
})

test('network failures and malformed payloads surface as internal errors', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () => { throw new TypeError('connection refused') }
    await assert.rejects(
      () => loadOverview('s'),
      (reason) => reason instanceof PanelApiError && reason.code === 'internal' && /connection refused/.test(reason.message),
    )

    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, project: {} }) })
    await assert.rejects(
      () => loadOverview('s'),
      (reason) => reason instanceof PanelApiError && reason.code === 'internal' && /topics/.test(reason.message),
    )
  } finally {
    globalThis.fetch = original
  }
})

test('toPanelError and errorMessage preserve the wire code and stay readable', () => {
  const wire = new PanelApiError('request/origin', '来源不被接受', 'topic-1')
  const normalized = toPanelError(wire)
  assert.equal(normalized.code, 'request/origin')
  assert.equal(normalized.message, '来源不被接受')
  assert.equal(normalized.path, 'topic-1')
  assert.equal(toPanelError(new Error('boom')).code, 'internal')
  assert.equal(toPanelError('boom').message, 'boom')
  assert.equal(errorMessage(new Error('boom')), 'boom')
  assert.equal(errorMessage('plain'), 'plain')
})

test('the client sources carry no v1 vocabulary and never archive a topic', async () => {
  const clientUrl = new URL('../src/client/', import.meta.url)
  const entries = await readdir(clientUrl, { withFileTypes: true })
  const files = entries.filter(entry => entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')))
  assert.ok(files.length > 0, 'the client half must have source files')
  const sources = new Map()
  for (const entry of files) {
    sources.set(entry.name, await readFile(new URL(entry.name, clientUrl), 'utf8'))
  }
  // Assembled here so a project-wide grep for the retired vocabulary stays clean
  // while the assertion still pins every client file.
  const retiredWords = [['thr', 'ead'].join(''), ['交接', '单'].join(''), ['review', 'er'].join('')]
  for (const [name, source] of sources) {
    for (const word of retiredWords) {
      assert.equal(new RegExp(word, 'i').test(source), false, `${name} must not mention the retired vocabulary`)
    }
  }
  const all = [...sources.values()].join('\n')
  assert.equal(/\barchiveSession\b/.test(all), false, 'the panel never archives a topic')
  assert.match(all, /unarchiveSession/, 'opening a pre-archived topic uses the tolerant unarchive')

  const modelSource = sources.get('model.ts')
  assert.equal(/from ['"]react['"]/.test(modelSource), false, 'model.ts stays React-free')
  assert.equal(/<\/[a-z]/.test(modelSource), false, 'model.ts carries no JSX closing tags')
  assert.equal(modelSource.includes('React.createElement'), false, 'model.ts never builds elements')

  const panelSource = sources.get('panel.tsx')
  const footerOpens = panelSource.match(/openTab\(COWORK_TAB_KIND\)/g) ?? []
  assert.equal(footerOpens.length, 1, 'the panel only opens itself from the footer entry, never on mount')
  assert.match(panelSource, /masterSessionId/, 'the breadcrumb returns to the master session')

  const listSource = sources.get('list.tsx')
  assert.match(listSource, /cw-resolved-by/, 'resolved rows show their resolution source')

  const contractsSource = sources.get('contracts.ts')
  assert.match(contractsSource, /COWORK_TAB_ID = '@dsh-external\/dsh-cowork\/panel'/)
  assert.match(contractsSource, /COWORK_TAB_KIND = 'cowork'/)

  const indexSource = sources.get('index.tsx')
  assert.match(indexSource, /主题列表、详情与活动/)
  assert.match(indexSource, /sidebar\.footer\.action/)
})
