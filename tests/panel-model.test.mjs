import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import './support/ts-hook.mjs'

const {
  CARD_MENU_GAP,
  CARD_MENU_HEIGHT,
  CARD_MENU_WIDTH,
  CLOCK_TICK_MS,
  FEEDBACK_TTL_MS,
  NOT_MASTER_MESSAGE,
  PROJECT_PATH_MAX_CHARS,
  TOPIC_ACTION_LABELS,
  TOPIC_GROUP_LABELS,
  TOPIC_GROUP_ORDER,
  TOPIC_ID_MAX_CHARS,
  TOPIC_MARKER_LABELS,
  archiveSuccessMessage,
  buildTopicViewModel,
  emptyNotice,
  errorPresentation,
  formatLocalTimestamp,
  formatRelativeTime,
  masterBreadcrumbLabel,
  masterBreadcrumbTarget,
  middleEllipsis,
  openSessionFailureMessage,
  openSessionMessage,
  openSessionUnavailableMessage,
  openTopicSteps,
  placeCardMenu,
  restoreSuccessMessage,
  shortTopicId,
  surfaceState,
  topicCardAction,
  topicGroupLabel,
  topicMarkerLabel,
  writeFailureMessage,
} = await import('../src/client/model.ts')
const api = await import('../src/client/api.ts')
const {
  PanelApiError,
  errorMessage,
  loadOverview,
  panelApiPath,
  parseCounts,
  parseOverview,
  parseReopen,
  parseResolve,
  parseTopicRow,
  reopenTopic,
  resolveTopic,
  toPanelError,
} = await import('../src/client/api.ts')

/** Fixed clock: every relative-time assertion is independent of the wall clock. */
const NOW = Date.parse('2026-11-08T12:00:00.000Z')

/** An ISO timestamp `ms` before {@link NOW}. */
function ago(ms) {
  return new Date(NOW - ms).toISOString()
}

/**
 * A topic as the wire sends it. Only the fields the topic page reads are
 * required; the authorization fields stay optional so a host without them can
 * be covered explicitly.
 */
function topic(overrides = {}) {
  return {
    topicId: 'session-aaaa1111-2222',
    title: '一个主题',
    status: 'active',
    blocked: false,
    digest: '摘要',
    updatedAt: ago(0),
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

/** One inbox row. */
function inboxItem(overrides = {}) {
  return {
    id: 'inbox-1',
    time: ago(0),
    topicId: 'session-aaaa1111-2222',
    kind: 'merge-needed',
    summary: '工作项等待合并',
    deliveredAt: null,
    ...overrides,
  }
}

/** The view model of one list of topics. */
function view(topics) {
  return buildTopicViewModel({ topics })
}

/** One group by key, failing loudly when the group is missing. */
function group(model, key) {
  const found = model.groups.find(entry => entry.key === key)
  assert.ok(found, `group ${key} must exist`)
  return found
}

test('four groups always come out in fixed order with labels, counts and fold state', () => {
  const model = view([
    topic({ topicId: 'blocked-1', blocked: true, blockedReason: 'handoff' }),
    topic({ topicId: 'running-1', updatedAt: ago(1000) }),
    topic({ topicId: 'idle-1', status: 'idle' }),
    topic({ topicId: 'resolved-1', status: 'resolved' }),
  ])
  assert.deepEqual(model.groups.map(entry => entry.key), [...TOPIC_GROUP_ORDER])
  assert.deepEqual(model.groups.map(entry => entry.label), TOPIC_GROUP_ORDER.map(key => TOPIC_GROUP_LABELS[key]))
  assert.deepEqual(model.groups.map(entry => entry.count), [1, 1, 1, 1])
  assert.deepEqual(model.groups.map(entry => entry.collapsedByDefault), [false, false, false, true])
  assert.equal(model.total, 4)
  assert.deepEqual(model.groups.map(entry => entry.cards.length), [1, 1, 1, 1])
})

test('grouping: resolved wins, authorization blocks, idle only when unblocked, active runs', () => {
  const model = view([
    topic({ topicId: 'resolved-blocked', status: 'resolved', blocked: true }),
    topic({ topicId: 'auth-idle', status: 'idle', awaitingAuthorization: true }),
    topic({ topicId: 'blocked-active', status: 'active', blocked: true, blockedReason: 'conflict' }),
    topic({ topicId: 'plain-idle', status: 'idle' }),
    topic({ topicId: 'plain-active', status: 'active' }),
    topic({ topicId: 'invented', status: 'archived' }),
  ])
  assert.deepEqual(group(model, 'resolved').cards.map(card => card.topicId), ['resolved-blocked'])
  assert.deepEqual(
    group(model, 'blocked').cards.map(card => card.topicId).sort(),
    ['auth-idle', 'blocked-active'],
  )
  assert.deepEqual(group(model, 'idle').cards.map(card => card.topicId), ['plain-idle'])
  assert.deepEqual(
    group(model, 'running').cards.map(card => card.topicId).sort(),
    ['invented', 'plain-active'],
  )
})

test('cards carry exactly the contract fields and never the retired ones', () => {
  const model = view([topic({
    awaitingAuthorization: true,
    awaitingReview: true,
    reviewStatus: 'pending',
    activeWorkItems: 3,
    cwd: '/repo',
    scope: 'src/client',
  })])
  const card = group(model, 'blocked').cards[0]
  assert.deepEqual(
    Object.keys(card).sort(),
    ['canArchive', 'canRestore', 'digest', 'marker', 'title', 'topicId', 'updatedAt'],
  )
  for (const retired of ['awaitingReview', 'reviewStatus', 'workItems', 'cwd', 'scope', 'activeWorkItems']) {
    assert.equal(retired in card, false, `card must not carry ${retired}`)
  }
  assert.equal(JSON.stringify(card).includes('reviewStatus'), false)
})

test('markers: authorization first, waiting-master only with a blocked reason, never from review', () => {
  const model = view([
    topic({ topicId: 'auth', blocked: true, blockedReason: 'authorization', awaitingAuthorization: true }),
    topic({ topicId: 'handoff', blocked: true, blockedReason: 'handoff' }),
    topic({ topicId: 'conflict', blocked: true, blockedReason: 'conflict' }),
    topic({ topicId: 'legacy-blocked', blocked: true }),
    topic({ topicId: 'review-only', awaitingReview: true }),
    topic({ topicId: 'half-written', blocked: true, blockedReason: 'authorization' }),
    topic({ topicId: 'resolved-auth', status: 'resolved', awaitingAuthorization: true }),
  ])
  const markers = new Map(
    model.groups.flatMap(entry => entry.cards).map(card => [card.topicId, card.marker]),
  )
  assert.equal(markers.get('auth'), 'authorization')
  assert.equal(markers.get('handoff'), 'waiting-master')
  assert.equal(markers.get('conflict'), 'waiting-master')
  assert.equal(markers.get('legacy-blocked'), null)
  assert.equal(markers.get('review-only'), null, 'awaitingReview must never become a marker')
  assert.equal(markers.get('half-written'), null, 'a missing boolean is not guessed from the reason')
  assert.equal(markers.get('resolved-auth'), null)
  assert.deepEqual(TOPIC_MARKER_LABELS, { authorization: '待授权', 'waiting-master': '等待主会话' })
})

test('needsYou counts only awaitingAuthorization and points at the newest waiting topic', () => {
  const model = view([
    topic({ topicId: 'auth-old', awaitingAuthorization: true, updatedAt: ago(60_000) }),
    topic({ topicId: 'auth-new', awaitingAuthorization: true, updatedAt: ago(1000) }),
    topic({ topicId: 'review', awaitingReview: true }),
    topic({ topicId: 'resolved-auth', status: 'resolved', awaitingAuthorization: true }),
  ])
  assert.deepEqual(model.needsYou, { count: 2, topicId: 'auth-new' })
  assert.equal(model.needsYou.count, 2, 'awaitingReview and resolved rows never count')
})

test('no awaitingAuthorization field means no marker and no needs-you entry', () => {
  const model = view([
    topic({ topicId: 'review-only', awaitingReview: true, blocked: true, blockedReason: 'authorization' }),
    topic({ topicId: 'plain' }),
  ])
  assert.equal(model.needsYou.count, 0)
  assert.equal(model.needsYou.topicId, null)
  assert.equal(group(model, 'blocked').cards[0].marker, null)
})

test('cards sort newest first inside a group and fall back to a stable id order', () => {
  const model = view([
    topic({ topicId: 'b-running', updatedAt: ago(10_000) }),
    topic({ topicId: 'a-running', updatedAt: ago(20_000) }),
    topic({ topicId: 'c-tied', updatedAt: 'not-a-date' }),
    topic({ topicId: 'd-tied', updatedAt: 'not-a-date' }),
  ])
  assert.deepEqual(group(model, 'running').cards.map(card => card.topicId), [
    'b-running',
    'a-running',
    'c-tied',
    'd-tied',
  ])
})

test('a card offers exactly one action derived from its state', () => {
  const model = view([
    topic({ topicId: 'open' }),
    topic({ topicId: 'done', status: 'resolved' }),
  ])
  const open = group(model, 'running').cards[0]
  const done = group(model, 'resolved').cards[0]
  assert.deepEqual([open.canArchive, open.canRestore], [true, false])
  assert.deepEqual([done.canArchive, done.canRestore], [false, true])
  assert.equal(topicCardAction(open), 'archive')
  assert.equal(topicCardAction(done), 'restore')
  assert.deepEqual(TOPIC_ACTION_LABELS, { archive: '归档', restore: '恢复' })
})

test('an empty overview still yields the four groups and no needs-you entry', () => {
  const model = view([])
  assert.equal(model.total, 0)
  assert.deepEqual(model.groups.map(entry => entry.count), [0, 0, 0, 0])
  assert.deepEqual(model.groups.map(entry => entry.cards), [[], [], [], []])
  assert.deepEqual(model.needsYou, { count: 0, topicId: null })
})

test('group and marker labels stay readable for invented values', () => {
  assert.equal(topicGroupLabel('blocked'), '阻塞')
  assert.equal(topicGroupLabel('running'), '运行中')
  assert.equal(topicGroupLabel('idle'), '空闲')
  assert.equal(topicGroupLabel('resolved'), '已解决')
  assert.equal(topicGroupLabel('invented'), 'invented')
  assert.equal(topicMarkerLabel('authorization'), '待授权')
  assert.equal(topicMarkerLabel('invented'), 'invented')
})

test('surfaceState separates loading, empty, error and the list', () => {
  assert.equal(surfaceState({ loading: true, error: null, topicCount: 3 }), 'loading')
  assert.equal(surfaceState({ loading: false, error: null, topicCount: 0 }), 'empty')
  assert.equal(surfaceState({ loading: false, error: null, topicCount: 2 }), 'default')
  assert.equal(
    surfaceState({ loading: false, error: { code: 'project/not-initialized', message: 'x' }, topicCount: 0 }),
    'empty',
  )
  assert.equal(
    surfaceState({ loading: false, error: { code: 'store/corrupt', message: 'x' }, topicCount: 2 }),
    'error',
  )
})

test('empty and error states carry the copy the page renders', () => {
  const empty = emptyNotice()
  assert.equal(empty.kind, 'empty')
  assert.equal(empty.title, '这个项目还没有主题')
  assert.equal(empty.retry, false)

  const notInitialized = errorPresentation({ code: 'project/not-initialized', message: 'missing' })
  assert.equal(notInitialized.kind, 'empty')
  assert.equal(notInitialized.hint, 'cowork_project_init')

  const notMaster = errorPresentation({ code: 'request/not-master', message: '只有主会话可以操作' })
  assert.equal(notMaster.kind, 'error')
  assert.match(notMaster.title, /只有主会话/)
  assert.equal(notMaster.retry, false)

  const corrupt = errorPresentation({ code: 'store/corrupt', message: '坏文件', path: '.dsh-cowork/index.json' })
  assert.equal(corrupt.title, '项目记录已损坏')
  assert.equal(corrupt.path, '.dsh-cowork/index.json')

  const generic = errorPresentation({ code: 'internal', message: 'boom' })
  assert.equal(generic.retry, true)
  assert.equal(errorPresentation(null).retry, true)
})

test('archive and restore receipts name the topic; a master-only refusal is fixed copy', () => {
  assert.match(archiveSuccessMessage('五子棋'), /已归档「五子棋」/)
  assert.match(archiveSuccessMessage('五子棋'), /已解决/)
  assert.match(restoreSuccessMessage('五子棋'), /已恢复「五子棋」/)
  assert.equal(
    writeFailureMessage('归档', { code: 'request/not-master', message: '只有 master 可以操作' }),
    NOT_MASTER_MESSAGE,
  )
  assert.equal(NOT_MASTER_MESSAGE, '只有主会话可以操作')
  assert.equal(writeFailureMessage('恢复', { code: 'internal', message: 'boom' }), '恢复失败（boom）')
  assert.equal(writeFailureMessage('归档', { code: 'internal', message: '  ' }), '归档失败')
})

test('relative time covers minutes, hours, days and the absolute fallback', () => {
  assert.equal(CLOCK_TICK_MS, 60_000)
  assert.equal(formatRelativeTime(ago(30_000), NOW), '刚刚')
  assert.equal(formatRelativeTime(ago(5 * 60_000), NOW), '5 分钟前')
  assert.equal(formatRelativeTime(ago(3 * 3_600_000), NOW), '3 小时前')
  assert.equal(formatRelativeTime(ago(2 * 86_400_000), NOW), '2 天前')
  assert.equal(formatRelativeTime(ago(8 * 86_400_000), NOW), formatLocalTimestamp(ago(8 * 86_400_000)))
  assert.equal(formatRelativeTime('nope', NOW), '时间未知')
  assert.equal(formatLocalTimestamp('nope'), '时间未知')
  assert.match(formatLocalTimestamp(ago(0)), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
})

test('the card menu stays on screen and flips above a button near the bottom', () => {
  const flipped = placeCardMenu(
    { top: 542, bottom: 560, right: 370 },
    { width: 378, height: 600 },
  )
  assert.equal(flipped.flipped, true)
  assert.equal(flipped.top, 542 - CARD_MENU_GAP - CARD_MENU_HEIGHT)
  assert.equal(flipped.left, 370 - CARD_MENU_WIDTH)

  const below = placeCardMenu(
    { top: 40, bottom: 58, right: 370 },
    { width: 378, height: 600 },
  )
  assert.equal(below.flipped, false)
  assert.equal(below.top, 58 + CARD_MENU_GAP)
  assert.equal(below.left, 370 - CARD_MENU_WIDTH)

  const clamped = placeCardMenu(
    { top: 40, bottom: 58, right: 60 },
    { width: 378, height: 600 },
  )
  assert.equal(clamped.left, 8, 'a narrow anchor keeps the menu inside the viewport')

  const narrowViewport = placeCardMenu(
    { top: 40, bottom: 58, right: 60 },
    { width: 90, height: 600 },
  )
  assert.equal(narrowViewport.left, 8)
})

test('opening a topic has fixed steps and a master breadcrumb only for topic sessions', () => {
  assert.deepEqual(openTopicSteps(), ['unarchive', 'open'])
  assert.equal(shortTopicId('session-aaaa1111-2222'), 'session-')
  assert.match(openSessionMessage('session-aaaa1111-2222'), /已切换到主题 session-/)
  assert.match(openSessionUnavailableMessage(), /无法打开主题/)
  assert.match(openSessionFailureMessage('denied'), /打开主题失败（denied）/)
  assert.equal(masterBreadcrumbLabel(), '返回 master')

  assert.equal(masterBreadcrumbTarget({
    currentSessionId: 'topic-1',
    masterSessionId: 'master-1',
    topics: [{ topicId: 'topic-1' }],
  }), 'master-1')
  assert.equal(masterBreadcrumbTarget({
    currentSessionId: 'master-1',
    masterSessionId: 'master-1',
    topics: [{ topicId: 'topic-1' }],
  }), null)
  assert.equal(masterBreadcrumbTarget({
    currentSessionId: 'topic-1',
    masterSessionId: 'master-1',
    topics: [],
  }), null)
  assert.equal(masterBreadcrumbTarget({
    currentSessionId: 'topic-1',
    masterSessionId: '  ',
    topics: [{ topicId: 'topic-1' }],
  }), null)
})

test('header helpers keep the project path bounded', () => {
  assert.equal(PROJECT_PATH_MAX_CHARS, 44)
  assert.match(middleEllipsis('/a/very/long/project/path/that/keeps/going', 16), /…/)
  assert.equal(shortTopicId('short'), 'short')
  assert.equal(shortTopicId('session-aaaa1111-2222').length, TOPIC_ID_MAX_CHARS)

  assert.equal(FEEDBACK_TTL_MS, 5000)
})

test('the topic page header offers no inbox hint and keeps the refresh control on one line', async () => {
  const modelModule = await import('../src/client/model.ts')
  for (const retired of ['inboxNotice', 'InboxNotice', 'INBOX_TITLE_MAX_CHARS', 'INBOX_TITLE_SUMMARIES']) {
    assert.equal(retired in modelModule, false, `${retired} must leave the topic page model`)
  }
  const clientUrl = new URL('../src/client/', import.meta.url)
  const panelSource = await readFile(new URL('panel.tsx', clientUrl), 'utf8')
  assert.equal(panelSource.includes('inboxHint'), false, 'the header no longer computes an inbox hint')
  assert.equal(panelSource.includes('cw-inbox-chip'), false, 'the header no longer renders the v1 chip')
  assert.equal(panelSource.includes('待处理'), false, 'no v1 "待处理 N" copy remains in the page shell')
  assert.match(panelSource, /className="cw-icon-button"[\s\S]*?刷新/, 'the refresh control stays a labelled button')
  assert.match(panelSource, /aria-label="刷新 Cowork 项目"/, 'the refresh control stays keyboard reachable')

  const stylesSource = await readFile(new URL('styles.ts', clientUrl), 'utf8')
  assert.equal(stylesSource.includes('.cw-inbox-chip'), false, 'the inbox chip style is gone')
  assert.equal(stylesSource.includes('.cw-chip {'), false, 'the generic chip style left with its only user')
  assert.match(stylesSource, /\.cw-header \{[\s\S]*?flex-wrap: nowrap/, 'the header never wraps')
  assert.match(stylesSource, /\.cw-icon-button \{\n  flex: none;\n  white-space: nowrap;/, 'refresh cannot shrink or wrap at 381px')
})

test('parseTopicRow keeps the optional authorization fields and degrades invented values', () => {
  const full = parseTopicRow(topic({
    awaitingAuthorization: true,
    blockedReason: 'authorization',
  }))
  assert.equal(full.awaitingAuthorization, true)
  assert.equal(full.blockedReason, 'authorization')

  const invented = parseTopicRow(topic({
    awaitingAuthorization: 'yes',
    blockedReason: 'invented-reason',
  }))
  assert.equal(invented.awaitingAuthorization, false)
  assert.equal(invented.blockedReason, null)

  const missing = parseTopicRow(topic())
  assert.equal(missing.awaitingAuthorization, false)
  assert.equal(missing.blockedReason, null)

  assert.equal(parseTopicRow({ topicId: 'x', status: 'invented' }), null)
  assert.equal(parseTopicRow(null), null)
})

test('the wire authorization fields survive parseOverview into the view model', () => {
  const parsed = parseOverview({
    ok: true,
    project: { repoPath: '/repo', projectId: 'p', masterSessionId: 'm', createdAt: ago(0) },
    counts: counts({ awaitingAuthorization: 1 }),
    topics: [
      topic({ topicId: 'waiting', awaitingAuthorization: true, blocked: true, blockedReason: 'authorization' }),
      topic({ topicId: 'plain', updatedAt: ago(1000) }),
    ],
    inbox: [],
  })
  const model = buildTopicViewModel(parsed)
  assert.deepEqual(model.needsYou, { count: 1, topicId: 'waiting' })
  assert.equal(group(model, 'blocked').cards[0].marker, 'authorization')
})

test('parseOverview drops unusable rows but keeps the usable ones', () => {
  const parsed = parseOverview({
    ok: true,
    project: { repoPath: '/repo', projectId: 'p', masterSessionId: 'm', createdAt: ago(0) },
    counts: counts({ active: 1 }),
    topics: [
      topic({ topicId: 'keep-b', updatedAt: ago(1000) }),
      topic({ topicId: 'keep-a', updatedAt: ago(2000) }),
      { topicId: 'bad-status', status: 'invented' },
      { title: 'no id' },
      'not-an-object',
    ],
    inbox: [inboxItem({ id: 'i-1' }), { summary: 'no id' }],
  })
  assert.deepEqual(parsed.topics.map(entry => entry.topicId), ['keep-b', 'keep-a'])
  assert.equal(parsed.inbox.length, 1)
  assert.equal(parsed.counts.active, 1)
})

test('parseOverview rejects a body without the required envelope and arrays', () => {
  assert.throws(() => parseOverview(null))
  assert.throws(() => parseOverview({ project: {}, counts: counts(), topics: [], inbox: [] }))
  assert.throws(() => parseOverview({ ok: true, project: {}, counts: counts(), inbox: [] }), /topics/)
  assert.throws(() => parseOverview({ ok: true, project: {}, counts: counts(), topics: [] }), /inbox/)
})

test('parseResolve and parseReopen narrow the write responses', () => {
  const resolved = parseResolve({
    ok: true,
    topic: topic({ status: 'resolved', resolvedAt: ago(0), resolvedBy: 'user' }),
    alreadyResolved: true,
  })
  assert.equal(resolved.alreadyResolved, true)
  assert.equal(resolved.topic.status, 'resolved')
  assert.equal(parseResolve({ ok: true, topic: topic() }).alreadyResolved, false)

  const reopened = parseReopen({ ok: true, topic: topic() })
  assert.equal(reopened.topic.status, 'active')

  assert.throws(() => parseResolve({ ok: true, topic: { topicId: 'x', status: 'nope' } }))
  assert.throws(() => parseReopen({ ok: true }), /主题/)
})

test('parseCounts zero-fills missing and invented fields', () => {
  assert.deepEqual(parseCounts({ active: 2, idle: 'x', resolved: -1, blocked: 1.5, awaitingReview: 4 }), counts({
    active: 2,
    awaitingReview: 4,
  }))
  assert.deepEqual(parseCounts(null), counts())
})

test('the topic page API module keeps only overview, archive and restore', () => {
  for (const name of ['loadOverview', 'resolveTopic', 'reopenTopic', 'parseOverview', 'parseTopicRow']) {
    assert.equal(typeof api[name], 'function', `${name} must be exported`)
  }
  for (const retired of ['loadTopic', 'moveTopic', 'loadActivity', 'parseTopic', 'parseRouteMove']) {
    assert.equal(retired in api, false, `${retired} must not be part of the topic page API`)
  }
})

test('loadOverview sends a same-origin, uncached GET with the session id', async () => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} })
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        project: { repoPath: '/repo', projectId: 'p', masterSessionId: 'session-master', createdAt: ago(0) },
        counts: counts(),
        topics: [],
        inbox: [],
      }),
    }
  }
  try {
    await loadOverview('session-master')
  } finally {
    globalThis.fetch = original
  }
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/cowork.overview?sessionId=session-master')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.credentials, 'same-origin')
  assert.equal(calls[0].init.cache, 'no-store')
  assert.equal(calls[0].init.headers.accept, 'application/json')
  assert.equal(calls[0].init.body, undefined)
})

test('archive and restore POST JSON with content-type and keep same-origin/no-store', async () => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} })
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        topic: topic({ status: url === '/api/cowork.topic.resolve' ? 'resolved' : 'active' }),
        alreadyResolved: false,
      }),
    }
  }
  try {
    await resolveTopic('s-master', 'topic-1')
    await reopenTopic('s-master', 'topic-1')
  } finally {
    globalThis.fetch = original
  }
  assert.equal(calls[0].url, '/api/cowork.topic.resolve')
  assert.equal(calls[1].url, '/api/cowork.topic.reopen')
  for (const call of calls) {
    assert.equal(call.init.method, 'POST')
    assert.equal(call.init.credentials, 'same-origin')
    assert.equal(call.init.cache, 'no-store')
    assert.equal(call.init.headers['content-type'], 'application/json')
    assert.equal(call.init.headers.accept, 'application/json')
    assert.deepEqual(JSON.parse(call.init.body), { sessionId: 's-master', topicId: 'topic-1' })
  }
})

test('panelApiPath encodes query values', () => {
  assert.equal(
    panelApiPath('/api/cowork.topic', { sessionId: 'a b', topicId: 'x&y' }),
    '/api/cowork.topic?sessionId=a+b&topicId=x%26y',
  )
  assert.equal(panelApiPath('/api/cowork.overview', {}), '/api/cowork.overview')
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

test('non-JSON, non-ok and network failures surface as internal errors', async () => {
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

test('the panel measures its own width, renders two independent columns and a narrow banner', async () => {
  const clientUrl = new URL('../src/client/', import.meta.url)
  const panelSource = await readFile(new URL('panel.tsx', clientUrl), 'utf8')
  const stylesSource = await readFile(new URL('styles.ts', clientUrl), 'utf8')
  const inboxModel = await import('../src/client/inbox-model.ts')

  assert.equal(inboxModel.WIDE_PANEL_MIN_PX, 620)
  assert.match(panelSource, /new ResizeObserver/)
  assert.match(panelSource, /WIDE_PANEL_MIN_PX/)
  assert.match(panelSource, /getBoundingClientRect\(\)\.width/)
  assert.match(panelSource, /data-width-mode=/)
  assert.match(panelSource, /className="cw-body cw-columns"/)
  assert.match(panelSource, /className="cw-topic-column"/)
  assert.match(panelSource, /className="cw-inbox-column"/)
  assert.match(panelSource, /data-testid="cw-inbox-focus"/)
  assert.match(panelSource, /data-testid="cw-inbox-back"/)
  assert.match(panelSource, /data-testid="cw-needs-you-banner"/)
  assert.match(panelSource, /loadInbox\(/)
  assert.match(panelSource, /resolveInboxRequest\(/)
  assert.match(panelSource, /openInboxTarget\(/)
  assert.match(panelSource, /selectedFilterTopicId=\{selectedInboxTopicId\}/)
  assert.match(panelSource, /onToggleFilter=\{toggleInboxFilter\}/)
  assert.match(panelSource, /item\.actions\.includes\(action\)/)
  assert.match(panelSource, /pendingRequestRef\.current\.has/)
  assert.match(panelSource, /已记录，但主题会话未唤醒/)
  assert.match(panelSource, /applyInboxItemUpdate/)
  assert.equal(panelSource.includes('needsYouTopicId'), false, 'the topic-based entry is replaced by the inbox banner')

  assert.match(stylesSource, /\.cw-columns \{[\s\S]*?grid-template-columns: 318px minmax\(280px, 1fr\)/)
  assert.match(stylesSource, /\.cw-columns \{[\s\S]*?gap: 12px/)
  assert.match(stylesSource, /\.cw-topic-column \{[\s\S]*?overflow-y: auto/)
  assert.match(stylesSource, /\.cw-inbox-list \{[\s\S]*?overflow-y: auto/)
  assert.match(stylesSource, /\.cw-inbox-focus \{[\s\S]*?flex-direction: column/)
})

test('the client sources carry no detail/list-split or review vocabulary', async () => {
  const clientUrl = new URL('../src/client/', import.meta.url)
  const entries = await readdir(clientUrl, { withFileTypes: true })
  const names = entries.filter(entry => entry.isFile()).map(entry => entry.name)
  assert.equal(names.includes('detail.tsx'), false, 'the detail pane is deleted, not just unused')
  assert.equal(names.includes('chips.tsx'), false, 'detail-only chips are deleted')
  assert.ok(names.includes('notice.tsx') && names.includes('notice-model.ts'))

  const sources = new Map()
  for (const entry of entries) {
    if (!entry.isFile() || (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx'))) continue
    sources.set(entry.name, await readFile(new URL(entry.name, clientUrl), 'utf8'))
  }
  const all = [...sources.values()].join('\n')
  const retired = ['chooseLayout', 'SPLIT_WIDTH_THRESHOLD', 'TopicDetail', 'reviewLabel', 'cw-row', 'cw-detail-pane', 'LIST_COLUMN_WIDTH']
  for (const word of retired) {
    assert.equal(all.includes(word), false, `${word} must be gone from the topic page`)
  }
  assert.equal(/from ['"]react-dom['"]/.test(all), false, 'the menu uses fixed positioning, no react-dom dependency')

  const modelSource = sources.get('model.ts')
  assert.equal(/from ['"]react['"]/.test(modelSource), false, 'model.ts stays React-free')
  assert.equal(/<\/[a-z]/.test(modelSource), false, 'model.ts carries no JSX closing tags')

  const listSource = sources.get('list.tsx')
  assert.match(listSource, /<article/, 'a card is an article')
  assert.match(listSource, /export function TopicStates/, 'loading/empty/error states live in the list module')
  assert.match(listSource, /aria-haspopup="menu"/)
  assert.match(listSource, /aria-expanded=\{menuOpen\}/)
  assert.match(listSource, /event\.key !== 'Escape'/)
  assert.match(listSource, /pointerdown/)
  assert.match(listSource, /cw-card-menu/)
  assert.equal(listSource.includes('position: fixed'), false, 'positioning lives in the stylesheet')

  const panelSource = sources.get('panel.tsx')
  assert.match(panelSource, /buildTopicViewModel/)
  assert.match(panelSource, /openSession/)
  assert.match(panelSource, /data-testid="cw-needs-you-banner"/)
  assert.match(panelSource, /archiveTopic/)
  assert.match(panelSource, /restoreTopic/)
  assert.equal(panelSource.includes('loadTopic'), false)
  assert.equal(panelSource.includes('moveTopic'), false)
  assert.equal(panelSource.includes('输入'), false)
  assert.equal(panelSource.includes('决策记录'), false)

  const indexSource = sources.get('index.tsx')
  assert.match(indexSource, /ctx\.inject\(\['sessionNotices'\], \(scope\) => registerNoticeRenderer\(scope\) \?\? undefined\)/)
  assert.equal(/export const inject = \[[^\]]*sessionNotices/.test(indexSource), false, 'sessionNotices stays an optional injection')

  const stylesSource = sources.get('styles.ts')
  assert.match(stylesSource, /\.cw-card-line \{[\s\S]*?min-width: 0/)
  assert.match(stylesSource, /\.cw-card-title \{[\s\S]*?text-overflow: ellipsis/)
  assert.match(stylesSource, /\.cw-card-digest \{[\s\S]*?text-overflow: ellipsis/)
  assert.match(stylesSource, /\.cw-card\[data-group="blocked"\] \{[\s\S]*?state-error-primary/)
  assert.match(stylesSource, /\.cw-card\[data-group="running"\] \{[\s\S]*?state-success-primary/)
  assert.match(stylesSource, /\.cw-card\[data-group="idle"\] \{[\s\S]*?label-primary/)
  assert.match(stylesSource, /\.cw-card\[data-group="resolved"\] \{[\s\S]*?border-l2/)
  assert.match(stylesSource, /\.cw-card-menu \{[\s\S]*?position: fixed/)
  assert.match(stylesSource, /\.cw-footer-slot \{[\s\S]*?width: calc\(100% \+ 4px\)[\s\S]*?margin: 4px -2px/)
  assert.match(stylesSource, /\.cw-footer-button \{[\s\S]*?height: 42px/)
  assert.match(stylesSource, /data-wide='false'[\s\S]*?width: 36px/)
})

test('the question card gates submit on every answer and renders the unanswered hint', async () => {
  const clientUrl = new URL('../src/client/', import.meta.url)
  const inboxSource = await readFile(new URL('inbox.tsx', clientUrl), 'utf8')
  const modelSource = await readFile(new URL('inbox-model.ts', clientUrl), 'utf8')
  const model = await import('../src/client/inbox-model.ts')

  // The gate and its copy live in the model (React-free), not in the component;
  // the decided rule itself is shared with the host in the frozen contract.
  const contractSource = await readFile(new URL('../src/inbox-contract.ts', import.meta.url), 'utf8')
  assert.match(contractSource, /export function answerCoversQuestion\(/)
  assert.match(modelSource, /answerCoversQuestion,/)
  assert.equal(modelSource.includes('function answerCoversQuestion('), false)
  assert.match(modelSource, /export function unansweredQuestionCount\(/)
  assert.match(modelSource, /export function answersComplete\(/)
  assert.equal(model.answersComplete([{ id: 'q1', prompt: 'p', mode: 'single', options: [{ id: 'o1', label: 'a' }] }], {}), false)
  assert.equal(model.unansweredAnswerHint(2), '还有 2 题未回答')

  // The card uses the model's verdict and never re-derives "any answer".
  assert.match(inboxSource, /unansweredQuestionCount\(questions, answers\)/)
  assert.match(inboxSource, /answersComplete\(questions, answers\)/)
  assert.match(inboxSource, /isDisabled=\{action => action === 'submit' && !allAnswered\}/)
  assert.equal(inboxSource.includes('questions.some('), false)
  assert.match(inboxSource, /data-testid="cw-inbox-answer-hint"/)
  assert.match(inboxSource, /unansweredAnswerHint\(unanswered\)/)
  assert.match(inboxSource, /role="status"/)
  assert.match(inboxSource, /aria-live="polite"/)
  // The hint only shows while a submit is possible but blocked.
  assert.match(inboxSource, /shouldShowUnansweredHint\(item\.actions\.length, pending, unanswered\)/)
  assert.equal(inboxSource.includes('!pending || unanswered === 0'), false)
})

test('the panel persists the topic filter per session and refreshes the overview after a resolve', async () => {
  const clientUrl = new URL('../src/client/', import.meta.url)
  const panel = await readFile(new URL('panel.tsx', clientUrl), 'utf8')
  const inbox = await readFile(new URL('inbox.tsx', clientUrl), 'utf8')

  // Restore on mount and on a session switch; persist/clear on the toggle.
  assert.match(panel, /useState<string \| null>\s*\(\s*\(\) => readStoredFilter\(browserFilterStorage\(\), sessionId\)/)
  assert.match(panel, /setSelectedInboxTopicId\(readStoredFilter\(browserFilterStorage\(\), sessionId\)\)/)
  assert.match(panel, /writeStoredFilter\(browserFilterStorage\(\), sessionId, topicId\)/)
  assert.match(panel, /clearStoredFilter\(browserFilterStorage\(\), sessionId\)/)

  // A stored filter naming a topic the overview no longer lists is cleared.
  assert.match(panel, /result\.topics\.some\(topic => topic\.topicId === current\)/)

  // The resolve success path refreshes the overview (topic block marker/counts)
  // and the refresh sits before the catch, so a failed write cannot fake it.
  const resolveStart = panel.indexOf('const resolveRequest = useCallback')
  const depsAt = panel.indexOf('}, [putReceipt, refresh, sessionId])', resolveStart)
  assert.ok(resolveStart > 0 && depsAt > resolveStart, 'the resolve callback is found')
  const resolveBody = panel.slice(resolveStart, depsAt + '}, [putReceipt, refresh, sessionId])'.length)
  const okReceipt = resolveBody.indexOf("text: '已提交'")
  const refreshCall = resolveBody.indexOf('refresh()')
  const catchAt = resolveBody.indexOf('} catch (reason) {')
  assert.ok(okReceipt > 0 && refreshCall > okReceipt, 'the refresh follows the committed resolve')
  assert.ok(catchAt > refreshCall, 'the refresh is on the success path only')
  assert.match(resolveBody, /\[putReceipt, refresh, sessionId\]/, 'the callback closes over refresh')

  // The plan card stops rendering its inline revise editor once terminal.
  assert.match(inbox, /\{revising && item\.pending \? \(/)
  assert.equal(inbox.includes('{revising ? ('), false, 'the editor is not rendered on a resolved card')
})
