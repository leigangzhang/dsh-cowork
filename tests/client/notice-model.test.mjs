import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  NOTICE_ACTION_LABELS,
  NOTICE_ACTION_TONES,
  NOTICE_KIND_LABELS,
  NOTICE_STATUS_LABELS,
  NOTICE_SUMMARY_MAX_CHARS,
  NOTICE_TITLE_MAX_CHARS,
  buildNoticeCards,
  canRegisterNoticeRenderer,
  isNoticeActionType,
  isNoticeKind,
  isNoticeStatus,
  noticeActionInputs,
  noticeActions,
  noticeCard,
  noticeKindLabel,
  noticeStatusLabel,
  upsertNoticeCard,
} from '../../src/client/notice-model.ts'

const MASTER = { audience: 'master' }
const TOPIC = { audience: 'topic' }

/** One notice with per-test overrides. */
function notice(overrides = {}) {
  return {
    noticeId: 'event-1',
    pluginId: '@dsh-external/dsh-cowork',
    topicId: 'topic-1',
    kind: 'report',
    title: '初版完成',
    summary: '棋盘 15×15 可以落子',
    status: 'pending',
    actions: [],
    createdAt: '2026-11-10T01:00:00.000Z',
    updatedAt: '2026-11-10T01:00:00.000Z',
    ...overrides,
  }
}

test('kind, status and action labels cover the frozen contract', () => {
  assert.deepEqual(NOTICE_KIND_LABELS, {
    assignment: '分配',
    report: '上报',
    proposal: '决策提案',
    authorization: '待授权',
    archive: '归档',
  })
  assert.deepEqual(NOTICE_STATUS_LABELS, {
    pending: '待处理',
    allowed: '已允许',
    denied: '已拒绝',
    void: '已失效',
  })
  assert.deepEqual(NOTICE_ACTION_LABELS, {
    allow: '允许',
    deny: '拒绝',
    'open-topic': '去主题会话处理',
    'open-work-item': '去工作项查看',
  })
  assert.equal(NOTICE_ACTION_TONES.allow, 'success')
  assert.equal(NOTICE_ACTION_TONES.deny, 'error')
  assert.equal(noticeKindLabel('assignment'), '分配')
  assert.equal(noticeStatusLabel('void'), '已失效')
  assert.equal(noticeKindLabel('invented'), 'invented')
  assert.equal(noticeStatusLabel('invented'), 'invented')
})

test('B feature detection: no host session-notice service means no registration', () => {
  assert.equal(canRegisterNoticeRenderer({}), false)
  assert.equal(canRegisterNoticeRenderer({ sessionNotices: undefined }), false)
  assert.equal(canRegisterNoticeRenderer({ sessionNotices: { append() {}, update() {} } }), true)
})

test('assignment and report are read-only, even when the wire asks for actions', () => {
  for (const kind of ['assignment', 'report']) {
    const input = notice({ kind, actions: ['allow', 'open-topic'] })
    for (const context of [MASTER, TOPIC]) {
      const card = noticeCard(input, context)
      assert.equal(card.kind, kind)
      assert.deepEqual(card.actions, [])
    }
  }
})

test('an archive notice exists only in the master session and has no action', () => {
  const input = notice({ kind: 'archive', title: '五子棋主题已归档', actions: ['open-topic'] })
  assert.equal(noticeCard(input, TOPIC), null)
  const master = noticeCard(input, MASTER)
  assert.equal(master.kind, 'archive')
  assert.equal(master.kindLabel, '归档')
  assert.deepEqual(master.actions, [])
})

test('a proposal shows open-work-item only with a real target and an implemented page', () => {
  const withTarget = notice({
    kind: 'proposal',
    actions: [{ type: 'open-work-item', target: 'wi-1' }],
  })
  assert.deepEqual(
    noticeCard(withTarget, { audience: 'master', workItemPageAvailable: true }).actions.map(action => action.type),
    ['open-work-item'],
  )
  assert.deepEqual(
    noticeCard(withTarget, MASTER).actions,
    [],
    'the work-item page is not implemented yet, so the dead action stays hidden',
  )

  const withoutTarget = notice({ kind: 'proposal', actions: ['open-work-item'] })
  assert.deepEqual(
    noticeCard(withoutTarget, { audience: 'master', workItemPageAvailable: true }).actions,
    [],
    'no target means no action',
  )

  const contextTarget = notice({ kind: 'proposal', actions: ['open-work-item'] })
  const card = noticeCard(contextTarget, {
    audience: 'master',
    workItemPageAvailable: true,
    workItemId: 'wi-2',
  })
  assert.equal(card.actions[0].target, 'wi-2')
})

test('authorization differs per audience: master opens the topic, the topic allows or denies', () => {
  const input = notice({ kind: 'authorization', actions: ['open-topic', 'allow', 'deny'] })
  const master = noticeCard(input, MASTER)
  assert.deepEqual(master.actions.map(action => action.type), ['open-topic'])
  assert.equal(master.actions[0].target, 'topic-1')
  assert.equal(master.actions[0].label, '去主题会话处理')

  const topic = noticeCard(input, TOPIC)
  assert.deepEqual(topic.actions.map(action => action.type), ['allow', 'deny'])
  assert.deepEqual(topic.actions.map(action => action.target), [null, null])
  assert.equal(topic.actions[0].disabled, false)
})

test('authorization actions disappear once the request is not pending', () => {
  for (const status of ['allowed', 'denied', 'void']) {
    const input = notice({ kind: 'authorization', status, actions: ['open-topic', 'allow', 'deny'] })
    assert.deepEqual(noticeCard(input, MASTER).actions, [])
    assert.deepEqual(noticeCard(input, TOPIC).actions, [])
    assert.equal(noticeStatusLabel(status), NOTICE_STATUS_LABELS[status])
  }
})

test('an open action without a target is hidden', () => {
  const masterNoTopic = notice({ kind: 'authorization', topicId: '  ', actions: ['open-topic'] })
  assert.deepEqual(noticeCard(masterNoTopic, MASTER).actions, [])

  const proposalNoTarget = notice({ kind: 'proposal', actions: [{ type: 'open-work-item', target: '   ' }] })
  assert.deepEqual(
    noticeCard(proposalNoTarget, { audience: 'master', workItemPageAvailable: true }).actions,
    [],
  )
})

test('the wire actions normalize strings and objects and drop unknown types', () => {
  const input = notice({
    kind: 'authorization',
    actions: ['allow', { type: 'deny', target: 'x' }, 'invented', { type: 'open-topic' }, 42],
  })
  assert.deepEqual(noticeActionInputs(input), [
    { type: 'allow', target: null },
    { type: 'deny', target: 'x' },
    { type: 'open-topic', target: null },
  ])
  assert.deepEqual(noticeActions(input, TOPIC).map(action => action.type), ['allow', 'deny'])
  assert.equal(isNoticeActionType('allow'), true)
  assert.equal(isNoticeActionType('invented'), false)
})

test('a card is one notice: title/summary are bounded, kind and status are validated', () => {
  const card = noticeCard(notice({
    title: '长'.repeat(NOTICE_TITLE_MAX_CHARS + 50),
    summary: '摘要'.repeat(NOTICE_SUMMARY_MAX_CHARS),
  }), MASTER)
  assert.ok(card.title.length <= NOTICE_TITLE_MAX_CHARS)
  assert.ok(card.title.endsWith('…'))
  assert.ok(card.summary.length <= NOTICE_SUMMARY_MAX_CHARS)
  assert.ok(card.summary.endsWith('…'))
  assert.equal(card.noticeId, 'event-1')
  assert.equal(card.title.includes('\n'), false)

  assert.equal(noticeCard(notice({ noticeId: '  ' }), MASTER), null)
  assert.equal(noticeCard(notice({ kind: 'invented' }), MASTER), null)
  assert.equal(noticeCard(notice({ status: 'invented' }), MASTER), null)
  assert.equal(isNoticeKind('proposal'), true)
  assert.equal(isNoticeKind('invented'), false)
  assert.equal(isNoticeStatus('pending'), true)
  assert.equal(isNoticeStatus('invented'), false)
})

test('one notice renders one card; duplicate ids keep the last state in the first position', () => {
  const cards = buildNoticeCards([
    notice({ noticeId: 'a', title: '第一条' }),
    notice({ noticeId: 'b', title: '第二条' }),
    notice({ noticeId: 'a', title: '第一条更新', status: 'allowed' }),
  ], MASTER)
  assert.equal(cards.length, 2)
  assert.deepEqual(cards.map(card => card.noticeId), ['a', 'b'])
  assert.equal(cards[0].title, '第一条更新')
  assert.equal(cards[0].status, 'allowed')
})

test('buildNoticeCards filters invisible archive cards for the topic session', () => {
  const cards = buildNoticeCards([
    notice({ noticeId: 'archive-1', kind: 'archive' }),
    notice({ noticeId: 'report-1' }),
  ], TOPIC)
  assert.deepEqual(cards.map(card => card.noticeId), ['report-1'])
})

test('an update replaces the original card in place and is idempotent', () => {
  const first = buildNoticeCards([
    notice({ noticeId: 'a', status: 'pending' }),
    notice({ noticeId: 'b' }),
  ], TOPIC)

  const update = notice({ noticeId: 'a', status: 'allowed', title: '已允许', actions: ['allow'] })
  const once = upsertNoticeCard(first, update, TOPIC)
  const twice = upsertNoticeCard(once, update, TOPIC)
  assert.deepEqual(once, twice, 'applying the same update twice must not change the list')
  assert.equal(once.length, 2)
  assert.deepEqual(once.map(card => card.noticeId), ['a', 'b'])
  assert.equal(once[0].status, 'allowed')
  assert.deepEqual(once[0].actions, [], 'a resolved authorization shows no buttons')

  const appended = upsertNoticeCard(once, notice({ noticeId: 'c' }), TOPIC)
  assert.deepEqual(appended.map(card => card.noticeId), ['a', 'b', 'c'])
})

test('an update that becomes invisible removes its card and stays idempotent', () => {
  const master = buildNoticeCards([notice({ noticeId: 'archive-1', kind: 'archive' })], MASTER)
  assert.equal(master.length, 1)
  const topicView = upsertNoticeCard(master, notice({ noticeId: 'archive-1', kind: 'archive' }), TOPIC)
  assert.deepEqual(topicView, [])
  assert.deepEqual(upsertNoticeCard(topicView, notice({ noticeId: 'archive-1', kind: 'archive' }), TOPIC), [])
})

test('the notice renderer never prompts the model or appends records', async () => {
  const source = await readFile(new URL('../../src/client/notice.tsx', import.meta.url), 'utf8')
  assert.equal(/promptSession|\.prompt\(/.test(source), false, 'rendering a notice must not prompt')
  assert.equal(/\.append\(/.test(source), false, 'rendering must not append events')
  assert.match(source, /canRegisterNoticeRenderer\(\{ sessionNotices: ctx\.sessionNotices \}\)/)
  assert.match(source, /return null/)
})
