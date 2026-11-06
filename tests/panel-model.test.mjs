import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CHIP_STATUS_ORDER,
  FEEDBACK_TTL_MS,
  FINDING_SEVERITY_LABELS,
  FINDING_SEVERITY_TONES,
  LIST_COLUMN_WIDTH,
  LONG_LIST_THRESHOLD,
  LONG_SUBJECT_THRESHOLD,
  MASTER_MESSAGE_FALLBACK_HEIGHT,
  MASTER_MESSAGE_MIN_HEIGHT,
  PROJECT_PATH_MAX_CHARS,
  REVIEW_STATUS_LABELS,
  REVIEW_STATUS_TONES,
  SPLIT_WIDTH_THRESHOLD,
  STATUS_LABELS,
  chooseLayout,
  copyFailureMessage,
  copySuccessMessage,
  emptyNotice,
  errorPresentation,
  findingSeverityLabel,
  findingSeverityTone,
  formatLocalTimestamp,
  formatRelativeTime,
  isLongList,
  isLongSubject,
  masterMessageMaxHeight,
  middleEllipsis,
  openReviewSessionFailureMessage,
  openReviewSessionMessage,
  openReviewSessionUnavailableMessage,
  openSessionFailureMessage,
  openSessionMessage,
  openSessionUnavailableMessage,
  reviewAbsentMessage,
  reviewBadgeTitle,
  reviewDetailUnavailableMessage,
  reviewOpenUnavailableMessage,
  reviewPendingMessage,
  reviewStatusLabel,
  reviewStatusTone,
  shortThreadId,
  statusChips,
  statusLabel,
  statusTone,
  surfaceState,
  verificationExitLabel,
  verificationTone,
} from '../src/client/model.ts'

/**
 * The Cowork panel is measured, not assumed: split mode starts above 480px and
 * the split column is exactly 248px. Pinning the constants here keeps the CSS
 * and the React layout branch from drifting apart.
 */
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

test('layout treats an unmeasured width as drill (never squeeze two columns)', () => {
  assert.equal(chooseLayout(null), 'drill')
  assert.equal(chooseLayout(undefined), 'drill')
  assert.equal(chooseLayout(Number.NaN), 'drill')
  assert.equal(chooseLayout(Number.POSITIVE_INFINITY), 'drill')
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

test('shortThreadId keeps the first eight characters', () => {
  const id = 'session-2accc833-153c-4713-b9b2-3e6141e4e997'
  assert.equal(shortThreadId(id), 'session-')
  assert.equal(shortThreadId('abc'), 'abc')
})

test('relative times cover minutes, hours, days and the absolute fallback', () => {
  const now = Date.parse('2026-11-05T12:00:00.000Z')
  const ago = (ms) => new Date(now - ms).toISOString()
  assert.equal(formatRelativeTime(ago(30 * 1000), now), '刚刚')
  assert.equal(formatRelativeTime(ago(5 * 60 * 1000), now), '5 分钟前')
  assert.equal(formatRelativeTime(ago(3 * 60 * 60 * 1000), now), '3 小时前')
  assert.equal(formatRelativeTime(ago(2 * 24 * 60 * 60 * 1000), now), '2 天前')
  const old = formatRelativeTime(ago(30 * 24 * 60 * 60 * 1000), now)
  assert.match(old, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.equal(formatRelativeTime('not-a-date', now), '时间未知')
  assert.equal(formatRelativeTime(ago(-60 * 1000), now), '刚刚')
})

test('absolute timestamps are zero padded', () => {
  assert.match(formatLocalTimestamp('2026-01-02T03:04:05.000Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.equal(formatLocalTimestamp('nope'), '时间未知')
})

test('all five statuses have Chinese labels and never rely on color alone', () => {
  assert.equal(statusLabel('new'), '新建')
  assert.equal(statusLabel('active'), '进行中')
  assert.equal(statusLabel('awaiting_review'), '待审查')
  assert.equal(statusLabel('blocked'), '受阻')
  assert.equal(statusLabel('done'), '已完成')
  assert.equal(statusLabel('unknown'), 'unknown')
  for (const status of Object.keys(STATUS_LABELS)) {
    assert.ok(statusTone(status) in { success: true, warn: true, error: true, idle: true })
  }
  assert.equal(statusTone('unknown'), 'idle')
  assert.equal(statusTone('blocked'), 'error')
})

test('header chips follow the proposal order and the current counts', () => {
  assert.deepEqual(CHIP_STATUS_ORDER, ['active', 'awaiting_review', 'blocked', 'done', 'new'])
  const chips = statusChips({ new: 1, active: 2, awaiting_review: 3, blocked: 4, done: 5 })
  assert.deepEqual(chips.map(chip => chip.status), ['active', 'awaiting_review', 'blocked', 'done', 'new'])
  assert.deepEqual(chips.map(chip => chip.count), [2, 3, 4, 5, 1])
  assert.deepEqual(chips.map(chip => chip.label), ['进行中', '待审查', '受阻', '已完成', '新建'])
  const missing = statusChips({ new: 0, active: 0, awaiting_review: 0 })
  assert.deepEqual(missing.map(chip => chip.count), [0, 0, 0, 0, 0])
})

test('verification exit chips distinguish success from failure by text', () => {
  assert.equal(verificationExitLabel(0), 'exit 0')
  assert.equal(verificationExitLabel(1), 'exit 1')
  assert.equal(verificationTone(0), 'success')
  assert.equal(verificationTone(1), 'error')
  assert.equal(verificationTone(127), 'error')
})

test('surfaceState picks loading, empty, error and default', () => {
  assert.equal(surfaceState({ loading: true, error: null, threadCount: 0 }), 'loading')
  assert.equal(surfaceState({ loading: true, error: { code: 'store/corrupt', message: 'x' }, threadCount: 3 }), 'loading')
  assert.equal(surfaceState({ loading: false, error: { code: 'project/not-initialized', message: 'x' }, threadCount: 0 }), 'empty')
  assert.equal(surfaceState({ loading: false, error: { code: 'store/corrupt', message: 'x' }, threadCount: 0 }), 'error')
  assert.equal(surfaceState({ loading: false, error: null, threadCount: 0 }), 'empty')
  assert.equal(surfaceState({ loading: false, error: null, threadCount: 1 }), 'default')
})

test('project/not-initialized is an empty state that names the init command', () => {
  const notice = errorPresentation({ code: 'project/not-initialized', message: 'no project' })
  assert.equal(notice.kind, 'empty')
  assert.equal(notice.retry, false)
  assert.equal(notice.code, 'project/not-initialized')
  assert.match(notice.detail, /cowork_project_init/)
  assert.equal(notice.hint, 'cowork_project_init')
})

test('an empty project with zero threads explains that no thread exists yet', () => {
  const notice = emptyNotice('no-threads')
  assert.equal(notice.kind, 'empty')
  assert.equal(notice.code, null)
  assert.equal(notice.retry, true)
  assert.match(notice.title, /thread/)
})

test('store/corrupt keeps the code, the path and the retry action', () => {
  const notice = errorPresentation({
    code: 'store/corrupt',
    message: 'index.json unreadable',
    path: '/repo/.dsh-cowork/index.json',
  })
  assert.equal(notice.kind, 'error')
  assert.equal(notice.code, 'store/corrupt')
  assert.equal(notice.path, '/repo/.dsh-cowork/index.json')
  assert.equal(notice.detail, 'index.json unreadable')
  assert.equal(notice.retry, true)
})

test('handoff/not-found maps to the no-handoff empty state', () => {
  const notice = errorPresentation({ code: 'handoff/not-found', message: 'no handoff' })
  assert.equal(notice.kind, 'empty')
  assert.equal(notice.retry, true)
  assert.match(notice.title, /交接单/)
})

test('unknown and missing errors stay retryable generic errors', () => {
  const generic = errorPresentation({ code: 'internal', message: 'boom' })
  assert.equal(generic.kind, 'error')
  assert.equal(generic.code, 'internal')
  assert.equal(generic.retry, true)
  const missing = errorPresentation(null)
  assert.equal(missing.kind, 'error')
  assert.equal(missing.retry, true)
  assert.equal(missing.code, null)
})

test('list and subject length states have explicit thresholds', () => {
  assert.equal(LONG_LIST_THRESHOLD, 12)
  assert.equal(isLongList(12), false)
  assert.equal(isLongList(13), true)
  assert.equal(LONG_SUBJECT_THRESHOLD, 48)
  assert.equal(isLongSubject('x'.repeat(48)), false)
  assert.equal(isLongSubject('x'.repeat(49)), true)
})

test('clipboard receipts are visible in both directions', () => {
  const ok = copySuccessMessage()
  assert.ok(ok.length > 0)
  assert.match(ok, /复制/)
  const failed = copyFailureMessage('权限被拒绝')
  assert.match(failed, /复制失败/)
  assert.match(failed, /权限被拒绝/)
  assert.ok(FEEDBACK_TTL_MS >= 1000)
})

test('open-session receipts name the target and never fail silently', () => {
  assert.match(openSessionMessage('session-deadbeef-0000'), /session-/)
  assert.match(openSessionFailureMessage(''), /打开 thread 会话失败/)
  assert.match(openSessionFailureMessage('navigating'), /navigating/)
  assert.match(openSessionUnavailableMessage(), /无法打开/)
})

test('MASTER message height is about 40% of the measured area, clamped', () => {
  assert.equal(masterMessageMaxHeight(1000), 400)
  assert.equal(masterMessageMaxHeight(648), 259)
  assert.equal(masterMessageMaxHeight(200), MASTER_MESSAGE_MIN_HEIGHT)
  assert.equal(masterMessageMaxHeight(0), MASTER_MESSAGE_FALLBACK_HEIGHT)
  assert.equal(masterMessageMaxHeight(Number.NaN), MASTER_MESSAGE_FALLBACK_HEIGHT)
  assert.equal(MASTER_MESSAGE_FALLBACK_HEIGHT, 240)
})

test('the four review states have visible labels and distinct tones', () => {
  assert.deepEqual(REVIEW_STATUS_LABELS, {
    pending: '审查中',
    pass: '审查通过',
    needs_revision: '需修改',
    reject: '已拒绝',
  })
  assert.equal(reviewStatusLabel('pending'), '审查中')
  assert.equal(reviewStatusLabel('pass'), '审查通过')
  assert.equal(reviewStatusLabel('needs_revision'), '需修改')
  assert.equal(reviewStatusLabel('reject'), '已拒绝')
  assert.equal(reviewStatusLabel('unknown'), 'unknown', 'an invented state stays visible')

  assert.equal(reviewStatusTone('pending'), 'warn')
  assert.equal(reviewStatusTone('pass'), 'success')
  assert.equal(reviewStatusTone('needs_revision'), 'warn')
  assert.equal(reviewStatusTone('reject'), 'error')
  assert.equal(reviewStatusTone('unknown'), 'idle')
  assert.deepEqual(Object.keys(REVIEW_STATUS_TONES).sort(), ['needs_revision', 'pass', 'pending', 'reject'])

  // Status is never color-only: every review state carries non-empty text.
  for (const status of Object.keys(REVIEW_STATUS_LABELS)) {
    assert.ok(reviewStatusLabel(status).length > 0, `${status} has visible text`)
  }
})

test('finding severities map to labels and tones, blockers and highs are errors', () => {
  assert.deepEqual(FINDING_SEVERITY_LABELS, {
    blocker: '阻断',
    high: '高',
    medium: '中',
    low: '低',
  })
  assert.equal(findingSeverityLabel('blocker'), '阻断')
  assert.equal(findingSeverityLabel('high'), '高')
  assert.equal(findingSeverityLabel('medium'), '中')
  assert.equal(findingSeverityLabel('low'), '低')
  assert.equal(findingSeverityLabel('critical'), 'critical')

  assert.equal(findingSeverityTone('blocker'), 'error')
  assert.equal(findingSeverityTone('high'), 'error')
  assert.equal(findingSeverityTone('medium'), 'warn')
  assert.equal(findingSeverityTone('low'), 'idle')
  assert.equal(findingSeverityTone('critical'), 'idle')
  assert.deepEqual(Object.keys(FINDING_SEVERITY_TONES).sort(), ['blocker', 'high', 'low', 'medium'])
})

test('the review badge title carries the time and the finding count', () => {
  assert.equal(reviewBadgeTitle('pass', null), '审查通过')
  const withTime = reviewBadgeTitle('needs_revision', '2026-01-02T03:04:05.000Z')
  assert.match(withTime, /^需修改 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  const withFindings = reviewBadgeTitle('needs_revision', '2026-01-02T03:04:05.000Z', 2)
  assert.equal(withFindings, `${withTime} · 2 条 finding`)
  assert.equal(reviewBadgeTitle('pass', 'not-a-date'), '审查通过 · 时间未知')
  assert.equal(reviewBadgeTitle('pending', '  '), '审查中', 'a blank time adds nothing')
  assert.equal(reviewBadgeTitle('pass', null, 0), '审查通过')
})

test('review messages explain the absent, pending and open-session states', () => {
  assert.match(reviewAbsentMessage(), /尚无 review/)
  assert.match(reviewAbsentMessage(), /cowork_review_request/)
  assert.match(reviewPendingMessage(), /审查中/)
  assert.match(reviewDetailUnavailableMessage('pass'), /review 详情不可用/)
  assert.match(reviewDetailUnavailableMessage('pass'), /审查通过/)
  assert.match(reviewDetailUnavailableMessage('reject'), /已拒绝/)
  assert.match(reviewOpenUnavailableMessage(), /review 会话/)
  assert.match(reviewOpenUnavailableMessage(), /cowork_review_request/)

  assert.match(openReviewSessionMessage('session-deadbeef-0000'), /review 会话/)
  assert.match(openReviewSessionMessage('session-deadbeef-0000'), /session-/)
  assert.match(openReviewSessionFailureMessage(''), /打开 review 会话失败/)
  assert.match(openReviewSessionFailureMessage('navigating'), /navigating/)
  assert.match(openReviewSessionUnavailableMessage(), /无法打开 review 会话/)

  // The thread-session messages stay distinct from the review ones.
  assert.notEqual(openReviewSessionMessage('abc'), openSessionMessage('abc'))
  assert.notEqual(openReviewSessionUnavailableMessage(), openSessionUnavailableMessage())
})

test('the review badge does not change the 480px layout switch', () => {
  assert.equal(chooseLayout(648), 'split')
  assert.equal(chooseLayout(481), 'split')
  assert.equal(chooseLayout(480), 'drill')
  // The badge always renders text, so both layouts keep a readable state.
  for (const status of Object.keys(REVIEW_STATUS_LABELS)) {
    assert.ok(reviewStatusLabel(status).trim().length > 0)
  }
})
