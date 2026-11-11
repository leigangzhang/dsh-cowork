import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  REQUEST_ACTIONS_BY_KIND,
  REQUEST_PENDING_LABELS,
  REQUEST_STATUS_LABELS,
  REQUEST_STATUSES,
} from '../src/inbox-contract.ts'
import {
  INBOX_ALL_TOPICS_LABEL,
  INBOX_ARCHIVED_TOPIC_LABEL,
  INBOX_EMPTY_LABEL,
  INBOX_NOTE_LABELS,
  INBOX_COLUMN_GAP_PX,
  INBOX_COLUMN_MIN_PX,
  NEEDS_YOU_DETAIL_LABELS,
  NEEDS_YOU_DETAIL_ORDER,
  REQUEST_ACTION_LABELS,
  TOPIC_COLUMN_WIDTH_PX,
  WIDE_PANEL_MIN_PX,
  applyInboxItemUpdate,
  buildInboxViewModel,
  inboxNeedsYouTitle,
  needsYouBanner,
} from '../src/client/inbox-model.ts'
import {
  PanelApiError,
  loadInbox,
  openInboxTarget,
  parseInboxCounts,
  parseInboxResolveResponse,
  parseInboxResponse,
  parseInboxRow,
  parseInboxRequestItem,
  resolveInboxRequest,
} from '../src/client/api.ts'

/** Fixed clock: relative-time labels never depend on the wall clock. */
const NOW = Date.parse('2026-11-08T12:00:00.000Z')

/** An ISO timestamp `ms` before {@link NOW}. */
function ago(ms) {
  return new Date(NOW - ms).toISOString()
}

/** Empty server counts with per-test overrides. */
function counts(overrides = {}) {
  return { pending: 0, review: 0, authorization: 0, question: 0, plan: 0, ...overrides }
}

/** Default payload per request kind. */
function payloadOf(kind) {
  switch (kind) {
    case 'user-review':
      return {
        purpose: '把个人主页 Bio 的首版合并进主线。',
        changedPaths: ['src/client/bio.tsx', 'src/client/styles.ts'],
        verification: [{ command: 'npm test', exitCode: 0, evidence: '845 passed' }],
      }
    case 'authorization':
      return { summary: '允许本次操作使用 danger-full-access 权限。', command: 'echo probe > /tmp/probe.txt' }
    case 'question':
      return {
        questions: [
          {
            id: 'scope',
            prompt: '这次先动哪些？',
            mode: 'multi',
            options: [
              { id: 'ui', label: '只看 UI' },
              { id: 'perm', label: '看权限弹窗', recommended: true, description: '允许分支' },
            ],
            allowText: true,
          },
          { id: 'when', prompt: '什么时候做？', mode: 'single' },
        ],
      }
    case 'plan':
      return { planPath: 'docs/design/plan.md', planTitle: '把弹窗验证固化成留档' }
    default:
      throw new Error(`unknown kind ${kind}`)
  }
}

/** One wire request row. */
function request(kind, overrides = {}) {
  return {
    kind: 'request',
    requestId: `req-${kind}`,
    requestKind: kind,
    topicId: 'topic-1',
    topicTitle: '主题一',
    status: 'pending',
    title: '主题一',
    summary: '一行摘要',
    requestMessage: `主题「主题一」在等${REQUEST_PENDING_LABELS[kind]}`,
    resolutionMessage: null,
    actions: [...REQUEST_ACTIONS_BY_KIND[kind]],
    payload: payloadOf(kind),
    createdAt: ago(0),
    updatedAt: ago(0),
    ...overrides,
  }
}

/** One wire notification row. */
function notification(overrides = {}) {
  return {
    kind: 'notification',
    noticeId: 'notice-1',
    noticeKind: 'assignment',
    topicId: 'topic-1',
    topicTitle: '主题一',
    summary: '已分配主题「主题一」',
    createdAt: ago(0),
    updatedAt: ago(0),
    canOpen: false,
    ...overrides,
  }
}

/** A parsed inbox body carrying these items. */
function inboxOf(items, overrides = {}) {
  return parseInboxResponse({
    ok: true,
    items,
    counts: counts(overrides.counts),
    truncated: overrides.truncated === true,
  })
}

/** Build the view over one parsed inbox. */
function viewOf(items, options = {}) {
  return buildInboxViewModel({
    inbox: inboxOf(items, { counts: options.counts, truncated: options.truncated }),
    topics: options.topics ?? [{ topicId: 'topic-1', title: '主题一' }],
    selectedTopicId: options.selectedTopicId ?? null,
    nowMs: NOW,
  })
}

/** The request view of one row id. */
function row(view, id) {
  const found = view.items.find(item => item.kind === 'request' && item.requestId === id)
  assert.ok(found, `row ${id} must be in the view`)
  return found
}

test('pending requests come first, newest first; resolved rows and notes mix by updatedAt', () => {
  const view = viewOf([
    request('user-review', { requestId: 'resolved', status: 'passed', resolutionMessage: '通过。', updatedAt: ago(5 * 60_000) }),
    request('authorization', { requestId: 'pending-old', updatedAt: ago(30 * 60_000) }),
    request('plan', { requestId: 'pending-new', updatedAt: ago(2 * 60_000) }),
    notification({ noticeId: 'note-newest', updatedAt: ago(60_000) }),
  ])
  assert.deepEqual(
    view.items.map(item => item.kind === 'request' ? item.requestId : item.noticeId),
    ['pending-new', 'pending-old', 'note-newest', 'resolved'],
  )
  assert.equal(view.items[0].pending, true)
  assert.equal(view.items[2].kind, 'notification')
  assert.equal(view.items[3].pending, false)
})

test('invalid timestamps sort after valid rows and ties break on the row id', () => {
  const view = viewOf([
    request('question', { requestId: 'bad-a', status: 'skipped', updatedAt: 'not-a-date' }),
    request('question', { requestId: 'bad-b', status: 'skipped', updatedAt: 'not-a-date' }),
    request('question', { requestId: 'valid', status: 'skipped', updatedAt: ago(10_000) }),
  ])
  assert.deepEqual(view.items.map(item => item.requestId), ['valid', 'bad-a', 'bad-b'])
})

test('the topic filter drops other topics, keeps the count and keeps the server counts', () => {
  const view = viewOf(
    [
      request('user-review', { requestId: 'topic-a-1', topicId: 'topic-a', topicTitle: '主题 A' }),
      request('authorization', { requestId: 'topic-b-1', topicId: 'topic-b', topicTitle: '主题 B' }),
      notification({ noticeId: 'topic-a-note', topicId: 'topic-a', topicTitle: '主题 A' }),
    ],
    {
      selectedTopicId: 'topic-a',
      counts: { pending: 2, review: 1, authorization: 1 },
      topics: [{ topicId: 'topic-a', title: '主题 A' }, { topicId: 'topic-b', title: '主题 B' }],
    },
  )
  assert.deepEqual(
    view.items.map(item => item.kind === 'request' ? item.requestId : item.noticeId),
    ['topic-a-1', 'topic-a-note'],
  )
  assert.equal(view.titleCount, 2)
  assert.equal(view.totalCount, 3)
  assert.equal(view.selectedTopicId, 'topic-a')
  assert.equal(view.filterTopicTitle, '主题 A')
  assert.deepEqual(view.counts, counts({ pending: 2, review: 1, authorization: 1 }))

  const cleared = viewOf([request('plan', { requestId: 'only' })], { selectedTopicId: null })
  assert.equal(cleared.filterTopicTitle, null)
  assert.equal(cleared.titleCount, cleared.totalCount)
  assert.equal(INBOX_ALL_TOPICS_LABEL, '全部类型')
})

test('the filter title degrades to the row title and then to the archived-topic placeholder', () => {
  const fromRow = viewOf(
    [request('plan', { requestId: 'p1', topicId: 'gone', topicTitle: '已归档项目主题' })],
    { selectedTopicId: 'gone', topics: [] },
  )
  assert.equal(fromRow.filterTopicTitle, '已归档项目主题')

  const empty = viewOf([], { selectedTopicId: 'gone', topics: [] })
  assert.equal(empty.filterTopicTitle, INBOX_ARCHIVED_TOPIC_LABEL)
  assert.equal(empty.empty, true)
  assert.equal(empty.titleCount, 0)
  assert.equal(INBOX_EMPTY_LABEL, '收件箱为空')
})

test('server counts become the fixed-order, non-zero narrow banner copy', () => {
  const view = viewOf([], {
    counts: { pending: 5, authorization: 2, review: 1, question: 0, plan: 2 },
  })
  assert.deepEqual(NEEDS_YOU_DETAIL_ORDER, ['authorization', 'review', 'question', 'plan'])
  assert.deepEqual(NEEDS_YOU_DETAIL_LABELS, {
    authorization: '待授权',
    review: '待审核',
    question: '待回答',
    plan: '待确认',
  })
  assert.deepEqual(view.needsYou, { count: 5, detail: '待授权 2 · 待审核 1 · 待确认 2' })
  assert.equal(inboxNeedsYouTitle(view.needsYou.count), '需要你处理 5 项')
  assert.deepEqual(needsYouBanner(view), {
    title: '需要你处理 5 项',
    detail: '待授权 2 · 待审核 1 · 待确认 2',
  })

  const zero = viewOf([], { counts: { pending: 0 } })
  assert.deepEqual(zero.needsYou, { count: 0, detail: '' })
  assert.equal(inboxNeedsYouTitle(0), '需要你处理 0 项')
})

test('all four pending cards carry their kind actions, labels and pending status text', () => {
  for (const kind of Object.keys(REQUEST_ACTIONS_BY_KIND)) {
    const view = viewOf([request(kind, { requestId: `pending-${kind}` })])
    const item = row(view, `pending-${kind}`)
    assert.equal(item.pending, true)
    assert.equal(item.statusText, REQUEST_PENDING_LABELS[kind])
    assert.deepEqual(item.actions, REQUEST_ACTIONS_BY_KIND[kind])
    for (const action of item.actions) assert.ok(REQUEST_ACTION_LABELS[action], `label for ${action}`)
  }
  assert.deepEqual(REQUEST_ACTION_LABELS, {
    pass: '通过',
    return: '退回',
    allow: '允许一次',
    deny: '拒绝',
    submit: '提交',
    skip: '跳过',
    approve: '同意执行',
    revise: '要求修改',
  })
})

test('every terminal status and void render no actions and keep the status label', () => {
  for (const status of REQUEST_STATUSES) {
    if (status === 'pending') continue
    const view = viewOf([
      request('authorization', {
        requestId: `terminal-${status}`,
        status,
        actions: ['allow', 'deny'],
        resolutionMessage: null,
      }),
    ])
    const item = row(view, `terminal-${status}`)
    assert.equal(item.pending, false)
    assert.deepEqual(item.actions, [], `${status} must not offer an action`)
    assert.equal(item.statusText, REQUEST_STATUS_LABELS[status])
  }
})

test('pending actions are validated against the kind; an empty wire list falls back to the contract', () => {
  const filtered = viewOf([request('authorization', { requestId: 'filtered', actions: ['submit', 'allow'] })])
  assert.deepEqual(row(filtered, 'filtered').actions, ['allow'])

  const fallback = viewOf([request('plan', { requestId: 'fallback', actions: [] })])
  assert.deepEqual(row(fallback, 'fallback').actions, ['revise', 'approve'])
})

test('the right-hand reply only shows for a persisted non-empty resolutionMessage', () => {
  const pending = viewOf([request('user-review', { requestId: 'no-reply', resolutionMessage: null })])
  assert.equal(row(pending, 'no-reply').showsResolution, false)
  assert.equal(row(pending, 'no-reply').resolutionMessage, null)

  const blank = viewOf([request('user-review', { requestId: 'blank', status: 'passed', resolutionMessage: '   ' })])
  assert.equal(row(blank, 'blank').showsResolution, false)
  assert.equal(row(blank, 'blank').resolutionMessage, null)

  const replied = viewOf([request('user-review', {
    requestId: 'replied',
    status: 'passed',
    resolutionMessage: '通过这次评审，可以合并。',
  })])
  assert.equal(row(replied, 'replied').showsResolution, true)
  assert.equal(row(replied, 'replied').resolutionMessage, '通过这次评审，可以合并。')
})

test('review-verdict notes are read-only: no action, no link, no count', () => {
  const view = viewOf([
    notification({
      noticeId: 'verdict',
      noticeKind: 'review-verdict',
      summary: '自动评审 · 通过 · 个人主页 Bio',
      canOpen: true,
      proposalPath: 'reviews/verdict.json',
    }),
  ], { counts: { pending: 0 } })
  const note = view.items[0]
  assert.equal(note.kind, 'notification')
  assert.equal(note.noteLabel, INBOX_NOTE_LABELS['review-verdict'])
  assert.equal(note.noteLabel, '自动评审')
  assert.equal(note.canOpen, false, 'a verdict never links anywhere')
  assert.equal('actions' in note, false, 'a note carries no actions field at all')
  assert.equal(view.needsYou.count, 0, 'a notification never counts as pending')
})

test('notification canOpen is preserved for proposals and forced off for verdicts', () => {
  const view = viewOf([
    notification({ noticeId: 'proposal', noticeKind: 'proposal', proposalPath: 'docs/proposal.md', canOpen: true }),
    notification({ noticeId: 'proposal-off', noticeKind: 'proposal', proposalPath: 'docs/proposal.md', canOpen: false }),
    notification({ noticeId: 'verdict', noticeKind: 'review-verdict', canOpen: true }),
    notification({ noticeId: 'archive', noticeKind: 'archive', canOpen: true }),
  ])
  const byId = new Map(view.items.map(item => [item.noticeId, item]))
  assert.equal(byId.get('proposal').canOpen, true)
  assert.equal(byId.get('proposal').proposalPath, 'docs/proposal.md')
  assert.equal(byId.get('proposal-off').canOpen, false)
  assert.equal(byId.get('verdict').canOpen, false)
  assert.equal(byId.get('archive').canOpen, true)
  assert.deepEqual(INBOX_NOTE_LABELS, {
    assignment: '分配',
    report: '上报',
    proposal: '提案',
    'review-verdict': '自动评审',
    archive: '归档',
  })
})

test('applying a resolved item replaces the row and moves only pending counts', () => {
  const before = inboxOf(
    [
      request('authorization', { requestId: 'auth', actions: ['allow', 'deny'] }),
      request('plan', { requestId: 'plan', status: 'approved', resolutionMessage: '同意执行这个计划。' }),
    ],
    { counts: { pending: 1, authorization: 1, plan: 1 } },
  )
  const resolved = request('authorization', {
    requestId: 'auth',
    status: 'allowed',
    actions: [],
    resolutionMessage: '允许一次。',
  })
  const after = applyInboxItemUpdate(before, resolved)
  assert.equal(after.items.length, 2)
  assert.deepEqual(after.items.find(item => item.requestId === 'auth'), resolved)
  assert.deepEqual(after.counts, counts({ pending: 0, authorization: 0, plan: 1 }))

  const replayed = applyInboxItemUpdate(after, resolved)
  assert.deepEqual(replayed.counts, after.counts, 'an already-resolved row never decrements twice')

  const unknown = applyInboxItemUpdate(before, request('plan', { requestId: 'absent', status: 'approved' }))
  assert.deepEqual(unknown.counts, before.counts)
  assert.equal(unknown.items.length, 2)
})

test('parse drops unusable rows but keeps the usable ones and degrades payload fields', () => {
  const parsed = parseInboxResponse({
    ok: true,
    counts: { pending: 'x', review: 2, authorization: -1, question: 1.5, plan: 3 },
    truncated: true,
    items: [
      request('user-review', { requestId: 'keep-request' }),
      notification({ noticeId: 'keep-note' }),
      request('user-review', { requestId: 'bad-kind', requestKind: 'review' }),
      request('user-review', { requestId: 'bad-status', status: 'done' }),
      request('user-review', { requestId: 'bad-topic', topicId: '' }),
      { kind: 'request', requestId: 'missing-fields' },
      { kind: 'invented' },
      'not-an-object',
      notification({ noticeId: 'bad-note', noticeKind: 'review' }),
    ],
  })
  assert.deepEqual(
    parsed.items.map(item => item.kind === 'request' ? item.requestId : item.noticeId),
    ['keep-request', 'keep-note'],
  )
  assert.deepEqual(parsed.counts, counts({ review: 2, plan: 3 }))
  assert.equal(parsed.truncated, true)

  const degraded = parseInboxRequestItem(request('user-review', {
    requestId: 'degraded',
    topicTitle: '',
    payload: { purpose: 42, changedPaths: ['a.ts', 7], verification: [{ command: '', exitCode: 0 }, { command: 'npm test', exitCode: 'oops', evidence: 'ok' }] },
  }))
  assert.ok(degraded)
  assert.equal(degraded.topicTitle, INBOX_ARCHIVED_TOPIC_LABEL)
  assert.deepEqual(degraded.payload.changedPaths, ['a.ts'])
  assert.deepEqual(degraded.payload.verification, [{ command: 'npm test', exitCode: 0, evidence: 'ok' }])

  const noPayload = parseInboxRequestItem(request('plan', { requestId: 'no-payload', payload: undefined }))
  assert.ok(noPayload)
  assert.deepEqual(noPayload.payload, { planPath: '' })

  const noQuestions = parseInboxRequestItem(request('question', { requestId: 'no-questions', payload: {} }))
  assert.ok(noQuestions)
  assert.deepEqual(noQuestions.payload, { questions: [] })
})

test('terminal rows never keep wire actions and foreign actions are filtered', () => {
  const parsed = parseInboxRequestItem(request('user-review', {
    status: 'passed',
    actions: ['return', 'pass', 'allow'],
  }))
  assert.ok(parsed)
  assert.deepEqual(parsed.actions, [])

  const pending = parseInboxRequestItem(request('authorization', {
    actions: ['allow', 'submit', 'invented'],
  }))
  assert.ok(pending)
  assert.deepEqual(pending.actions, ['allow'])
})

test('parseInboxResponse rejects a missing envelope or items array', () => {
  assert.throws(() => parseInboxResponse(null), PanelApiError)
  assert.throws(() => parseInboxResponse({ items: [], counts: counts() }), /ok: true/)
  assert.throws(() => parseInboxResponse({ ok: true, counts: counts() }), /items/)
})

test('parseInboxRow narrows one row without an envelope and drops unknown kinds', () => {
  assert.equal(parseInboxRow(request('plan')).requestId, 'req-plan')
  assert.equal(parseInboxRow(notification()).noticeId, 'notice-1')
  assert.equal(parseInboxRow({ kind: 'other' }), null)
  assert.equal(parseInboxRow(null), null)
  assert.deepEqual(parseInboxCounts(null), counts())
})

test('parseInboxResolveResponse keeps the reply and the prompt outcome', () => {
  const parsed = parseInboxResolveResponse({
    ok: true,
    item: request('user-review', { requestId: 'r', status: 'passed', resolutionMessage: '通过。', actions: [] }),
    changed: true,
    prompted: false,
    promptError: 'session-busy',
  })
  assert.equal(parsed.item.resolutionMessage, '通过。')
  assert.equal(parsed.changed, true)
  assert.equal(parsed.prompted, false)
  assert.equal(parsed.promptError, 'session-busy')
  assert.throws(() => parseInboxResolveResponse({ ok: true, item: null }), /收件箱项/)
})

test('loadInbox sends a same-origin uncached GET and encodes an optional topic filter', async () => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} })
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, items: [], counts: counts(), truncated: false }),
    }
  }
  try {
    await loadInbox('session-master')
    await loadInbox('session-master', 'topic-1')
    await loadInbox('session-master', null)
  } finally {
    globalThis.fetch = original
  }
  assert.equal(calls[0].url, '/api/cowork.inbox?sessionId=session-master')
  assert.equal(calls[1].url, '/api/cowork.inbox?sessionId=session-master&topicId=topic-1')
  assert.equal(calls[2].url, '/api/cowork.inbox?sessionId=session-master')
  for (const call of calls) {
    assert.equal(call.init.method, 'GET')
    assert.equal(call.init.credentials, 'same-origin')
    assert.equal(call.init.cache, 'no-store')
    assert.equal(call.init.headers.accept, 'application/json')
  }
})

test('loadInbox keeps the host error envelope code, message and path', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({
      ok: false,
      error: { code: 'inbox/not-member', message: '不是该主题的成员', path: 'requests/r1.json' },
    }),
  })
  try {
    await assert.rejects(
      () => loadInbox('session-master'),
      (reason) => reason instanceof PanelApiError
        && reason.code === 'inbox/not-member'
        && reason.message === '不是该主题的成员'
        && reason.path === 'requests/r1.json',
    )
  } finally {
    globalThis.fetch = original
  }
})

test('resolveInboxRequest posts the action, comment and answers and parses the item', async () => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} })
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        item: request('question', {
          requestId: 'req-question',
          status: 'answered',
          actions: [],
          resolutionMessage: '已选择：15×15。',
        }),
        changed: true,
        prompted: true,
        promptError: null,
      }),
    }
  }
  try {
    const result = await resolveInboxRequest({
      sessionId: 'session-master',
      requestId: 'req-question',
      action: 'submit',
      answers: [{ questionId: 'scope', selected: ['ui'], text: '先看 UI' }],
    })
    await resolveInboxRequest({
      sessionId: 'session-master',
      requestId: 'req-review',
      action: 'return',
      comment: '  请补测试  ',
    })
    assert.equal(result.item.status, 'answered')
    assert.equal(result.prompted, true)
    assert.equal(result.promptError, null)
  } finally {
    globalThis.fetch = original
  }
  assert.equal(calls[0].url, '/api/cowork.inbox.resolve')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    sessionId: 'session-master',
    requestId: 'req-question',
    action: 'submit',
    answers: [{ questionId: 'scope', selected: ['ui'], text: '先看 UI' }],
  })
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    sessionId: 'session-master',
    requestId: 'req-review',
    action: 'return',
    comment: '请补测试',
  })
})

test('openInboxTarget sends ids only and refuses a target without one', async () => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} })
    return { ok: true, status: 200, json: async () => ({ ok: true, opened: true }) }
  }
  try {
    await openInboxTarget({ sessionId: 'session-master', requestId: 'req-plan' })
    await openInboxTarget({ sessionId: 'session-master', noticeId: 'notice-proposal' })
    await assert.rejects(() => openInboxTarget({ sessionId: 'session-master' }), PanelApiError)
  } finally {
    globalThis.fetch = original
  }
  assert.equal(calls[0].url, '/api/cowork.inbox.open')
  assert.deepEqual(JSON.parse(calls[0].init.body), { sessionId: 'session-master', requestId: 'req-plan' })
  assert.deepEqual(JSON.parse(calls[1].init.body), { sessionId: 'session-master', noticeId: 'notice-proposal' })
})

test('the geometry constants are the frozen 620 / 280 / 318 values', () => {
  assert.equal(WIDE_PANEL_MIN_PX, 620)
  assert.equal(INBOX_COLUMN_MIN_PX, 280)
  assert.equal(TOPIC_COLUMN_WIDTH_PX, 318)
  assert.equal(INBOX_COLUMN_GAP_PX, 12)
})

test('inbox-model stays React-free and carries no JSX', async () => {
  const source = await readFile(new URL('../src/client/inbox-model.ts', import.meta.url), 'utf8')
  assert.equal(/from ['"]react['"]/.test(source), false)
  assert.equal(/<\/[a-z]/.test(source), false)
  assert.equal(/React\./.test(source), false)
})

test('the client sources carry every data-testid the GUI verification drives', async () => {
  const clientUrl = new URL('../src/client/', import.meta.url)
  const inbox = await readFile(new URL('inbox.tsx', clientUrl), 'utf8')
  const panel = await readFile(new URL('panel.tsx', clientUrl), 'utf8')
  const list = await readFile(new URL('list.tsx', clientUrl), 'utf8')
  const required = [
    'cw-inbox',
    'cw-inbox-item',
    'cw-inbox-request-message',
    'cw-inbox-request-card',
    'cw-inbox-action',
    'cw-inbox-comment',
    'cw-inbox-answer',
    'cw-inbox-option',
    'cw-inbox-open',
    'cw-inbox-resolution',
    'cw-inbox-note',
    'cw-inbox-empty',
    'cw-inbox-error',
    'cw-inbox-title-count',
    'cw-inbox-filter-clear',
  ]
  for (const id of required) {
    assert.match(inbox, new RegExp(`data-testid="${id}"`), `${id} must be rendered`)
  }
  for (const id of ['cw-inbox-focus', 'cw-inbox-back', 'cw-needs-you-banner']) {
    assert.match(panel, new RegExp(`data-testid="${id}"`), `${id} must be rendered by the panel`)
  }
  assert.match(inbox, /data-item-kind="request"/)
  assert.match(inbox, /data-item-kind="notification"/)
  assert.match(inbox, /data-request-id=\{item\.requestId\}/)
  assert.match(inbox, /data-request-kind=\{item\.requestKind\}/)
  assert.match(inbox, /data-status=\{item\.status\}/)
  assert.match(inbox, /data-pending=\{item\.pending \? 'true' : 'false'\}/)
  assert.match(inbox, /data-action=\{action\}/)
  assert.match(inbox, /data-option-id=\{option\.id\}/)
  assert.match(inbox, /data-notice-kind=\{item\.noticeKind\}/)
  assert.match(list, /data-testid="cw-topic-filter"/)
  assert.match(list, /data-topic-id=\{card\.topicId\}/)
  assert.match(list, /aria-pressed=\{filterActive\}/)
})

test('the topic filter button is a sibling of the open button and never opens the session', async () => {
  const source = await readFile(new URL('../src/client/list.tsx', import.meta.url), 'utf8')
  const openStart = source.indexOf('className="cw-card-open"')
  const openEnd = source.indexOf('</button>', openStart)
  assert.ok(openStart > 0 && openEnd > openStart)
  const filterStart = source.indexOf('className="cw-card-filter"')
  assert.ok(filterStart > openEnd, 'the filter button renders after the open button closes')
  const filterEnd = source.indexOf('</button>', filterStart)
  assert.ok(filterEnd > filterStart)
  const openBlock = source.slice(openStart, openEnd)
  assert.equal(openBlock.includes('cw-card-filter'), false, 'the filter button is not nested in cw-card-open')
  const filterBlock = source.slice(filterStart, filterEnd)
  assert.match(filterBlock, /onClick=\{\(\) => \{ onToggleFilter\(card\.topicId\) \}\}/)
  assert.equal(filterBlock.includes('onOpenTopic'), false)
  assert.equal(filterBlock.includes('onArchive'), false)
  assert.equal(filterBlock.includes('onRestore'), false)
  assert.match(source, /onToggleFilter: \(topicId: string\) => void/)
  for (const forbidden of ['openSession', 'loadOverview', 'resolveTopic']) {
    assert.equal(source.includes(forbidden), false, `list.tsx must not call ${forbidden}`)
  }
})

test('the request inbox styles never reuse the topic card class and keep focus visible', async () => {
  const styles = await readFile(new URL('../src/client/styles.ts', import.meta.url), 'utf8')
  assert.match(styles, /\.cw-req-card \{/)
  assert.match(styles, /\.cw-columns \{[\s\S]*?grid-template-columns: 318px minmax\(280px, 1fr\)/)
  assert.match(styles, /\.cw-columns \{[\s\S]*?gap: 12px/)
  assert.match(styles, /\.cw-topic-column \{[\s\S]*?overflow-y: auto/)
  assert.match(styles, /\.cw-inbox-list \{[\s\S]*?overflow-y: auto/)
  assert.match(styles, /\.cw-inbox-note \{[\s\S]*?text-align: center/)
  assert.match(styles, /\.cw-root :focus-visible \{[\s\S]*?outline: 2px solid/)
  assert.match(styles, /\.cw-card-filter\[data-active="true"\]/)
  assert.equal(styles.includes('.cw-inbox .cw-card'), false, 'the inbox never styles the topic card class')
})
