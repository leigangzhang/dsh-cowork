import test from 'node:test'
import assert from 'node:assert/strict'
import '../support/ts-hook.mjs'
const model = await import('../../src/client/work-item/model.ts')

/** One summary row with every field the rail reads. */
function summary(overrides = {}) {
  return {
    artifactId: 'artifact-1',
    ownerSessionId: 'session-1',
    title: 'Spec',
    type: 'text',
    status: 'pending-confirm',
    primaryPath: 'docs/spec.md',
    revision: 1,
    commentCount: 2,
    attachmentCount: 1,
    activeDispatch: null,
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    ...overrides,
  }
}

/** One comment event row. */
function comment(overrides = {}) {
  return {
    version: 1,
    eventId: 'event-1',
    artifactId: 'artifact-1',
    commentId: 'comment-1',
    threadId: 'comment-1',
    type: 'create',
    author: 'user',
    body: 'body',
    createdAt: '2026-02-01T00:00:00.000Z',
    ...overrides,
  }
}

test('the five filters map to their counts and labels', () => {
  const counts = {
    total: 6, pendingView: 1, pendingConfirm: 2, needsFeedback: 5, inProgress: 3, confirmed: 4,
  }
  assert.equal(model.filterLabel('all'), '全部')
  assert.equal(model.filterLabel('pending-confirm'), '待确认')
  for (const filter of model.WORK_ITEM_FILTERS) {
    assert.equal(typeof model.filterCount(counts, filter), 'number', filter)
  }
  assert.equal(model.filterCount(counts, 'all'), 6)
  assert.equal(model.filterCount(counts, 'pending-view'), 1)
  assert.equal(model.filterCount(counts, 'pending-confirm'), 2)
  assert.equal(model.filterCount(counts, 'needs-feedback'), 5)
  assert.equal(model.filterCount(counts, 'in-progress'), 3)
  assert.equal(model.filterCount(counts, 'confirmed'), 4)
})

test('filtering and grouping keep rail order and fold confirmed by default', () => {
  const items = [
    summary({ artifactId: 'a', status: 'confirmed' }),
    summary({ artifactId: 'b', status: 'pending-confirm' }),
    summary({ artifactId: 'c', status: 'needs-feedback' }),
    summary({ artifactId: 'd', status: 'in-progress' }),
    summary({ artifactId: 'e', status: 'pending-view' }),
  ]
  assert.equal(model.filterArtifacts(items, 'all').length, 5)
  assert.deepEqual(model.filterArtifacts(items, 'confirmed').map((item) => item.artifactId), ['a'])
  const groups = model.groupArtifacts(items)
  assert.deepEqual(groups.map((group) => group.status), [
    'pending-confirm', 'needs-feedback', 'in-progress', 'pending-view', 'confirmed',
  ])
  assert.deepEqual(groups.map((group) => group.collapsedByDefault), [false, false, false, false, true])
  assert.equal(groups[0].label, '待确认')
  assert.deepEqual(model.groupArtifacts([]), [])
})

test('the dispatch badge names all eight states', () => {
  const tones = {
    queued: ['pending', false],
    sent: ['pending', false],
    thinking: ['active', false],
    working: ['active', false],
    replied: ['done', true],
    failed: ['error', true],
    blocked: ['error', true],
    stale: ['pending', true],
  }
  for (const [state, [tone, terminal]] of Object.entries(tones)) {
    const result = model.activeDispatchSummary({
      dispatchId: 'd-1',
      state,
      updatedAt: '2026-02-01T00:00:00.000Z',
    })
    assert.equal(result.tone, tone, state)
    assert.equal(result.terminal, terminal, state)
    assert.equal(result.label, model.dispatchLabel(state))
  }
  assert.equal(model.activeDispatchSummary(null), null)
})

test('relative time covers minutes, hours, days, and older dates', () => {
  const now = new Date('2026-02-10T12:00:00.000Z')
  assert.equal(model.formatRelativeTime('2026-02-10T11:59:30.000Z', now), '刚刚')
  assert.equal(model.formatRelativeTime('2026-02-10T11:55:00.000Z', now), '5 分钟前')
  assert.equal(model.formatRelativeTime('2026-02-10T09:00:00.000Z', now), '3 小时前')
  assert.equal(model.formatRelativeTime('2026-02-08T12:00:00.000Z', now), '2 天前')
  assert.equal(model.formatRelativeTime('2026-01-20T12:00:00.000Z', now), '2026-01-20')
  assert.equal(model.formatRelativeTime('not-a-date', now), '')
})

test('toolbar and file summaries stay one line', () => {
  assert.equal(model.revisionSummary(12, 3, 2), 'r12 · 3 条评论 · 2 个附件')
  assert.equal(model.revisionSummary(1, 0, 0), 'r1 · 0 条评论')
  assert.equal(
    model.fileSummary({ path: 'a.md', mediaType: 'text/markdown', editable: true, size: 12, sha256: 'x', revision: 1, fsVersion: 'v', missing: false }),
    'a.md · 12 B',
  )
  assert.equal(
    model.fileSummary({ path: 'b.md', mediaType: 'text/markdown', editable: true, size: 2048, sha256: 'x', revision: 1, fsVersion: 'v', missing: false }),
    'b.md · 2.0 KB',
  )
  assert.equal(model.typeLabel('image'), '图片')
})

test('threads fold create, reply, resolve, reopen, and anchor moves', () => {
  const events = [
    comment({ createdAt: '2026-02-01T00:00:00.000Z', anchor: { kind: 'line-range', path: 'a.md', startLine: 3, endLine: 4, quote: 'q' } }),
    comment({ type: 'reply', eventId: 'e2', commentId: 'comment-2', author: 'model', createdAt: '2026-02-01T01:00:00.000Z' }),
    comment({ type: 'anchor-moved', eventId: 'e3', anchor: { kind: 'line-range', path: 'a.md', startLine: 5, endLine: 5, quote: 'q2' }, anchorStatus: 'moved', createdAt: '2026-02-01T02:00:00.000Z' }),
    comment({ type: 'resolve', eventId: 'e4', createdAt: '2026-02-01T03:00:00.000Z' }),
    comment({ type: 'reopen', eventId: 'e5', createdAt: '2026-02-01T04:00:00.000Z' }),
  ]
  const threads = model.foldThreads(events)
  assert.equal(threads.length, 1)
  assert.equal(threads[0].comments.length, 2)
  assert.equal(threads[0].resolved, false)
  assert.equal(threads[0].anchorStatus, 'moved')
  assert.deepEqual(threads[0].anchor, { kind: 'line-range', path: 'a.md', startLine: 5, endLine: 5, quote: 'q2' })
  assert.equal(threads[0].latestAt, '2026-02-01T04:00:00.000Z')
})

test('orphan rows are ignored instead of inventing threads', () => {
  const threads = model.foldThreads([
    comment({ type: 'reply', eventId: 'e1' }),
    comment({ type: 'resolve', eventId: 'e2' }),
    comment({ type: 'anchor-moved', eventId: 'e3', anchor: { kind: 'whole', path: 'a.md' }, anchorStatus: 'stale' }),
    comment({ eventId: 'e4', commentId: 'comment-9', threadId: 'comment-9', anchorStatus: undefined }),
  ])
  assert.equal(threads.length, 1)
  assert.equal(threads[0].anchor, null)
  assert.equal(threads[0].anchorStatus, null)
})

test('threads sort unresolved first, then by anchor line, then newest', () => {
  const base = comment()
  const make = (threadId, resolved, anchor, latestAt) => ({
    threadId,
    root: base,
    comments: [base],
    anchor,
    resolved,
    anchorStatus: null,
    latestAt,
  })
  const threads = [
    make('resolved', true, { kind: 'line-range', path: 'a.md', startLine: 1, endLine: 1, quote: 'q' }, '2026-02-01T02:00:00.000Z'),
    make('line-9', false, { kind: 'line-range', path: 'a.md', startLine: 9, endLine: 9, quote: 'q' }, '2026-02-01T01:00:00.000Z'),
    make('whole', false, null, '2026-02-01T00:00:00.000Z'),
    make('line-2', false, { kind: 'line-range', path: 'a.md', startLine: 2, endLine: 2, quote: 'q' }, '2026-02-01T03:00:00.000Z'),
    make('same-line-newer', false, { kind: 'line-range', path: 'a.md', startLine: 9, endLine: 9, quote: 'q' }, '2026-02-01T04:00:00.000Z'),
  ]
  assert.deepEqual(model.sortThreads(threads).map((thread) => thread.threadId), [
    'line-2', 'same-line-newer', 'line-9', 'whole', 'resolved',
  ])
})

test('anchor line and label cover every anchor kind', () => {
  const cases = [
    [{ kind: 'line-range', path: 'a.md', startLine: 3, endLine: 3, quote: 'q' }, 3, '第 3 行'],
    [{ kind: 'line-range', path: 'a.md', startLine: 3, endLine: 5, quote: 'q' }, 3, '第 3–5 行'],
    [{ kind: 'block', path: 'a.md', quote: 'q' }, Number.MAX_SAFE_INTEGER, '段落'],
    [{ kind: 'diagram-node', path: 'a.mmd', line: 7 }, 7, '图表节点'],
    [{ kind: 'diagram-node', path: 'a.mmd', nodeId: 'api' }, Number.MAX_SAFE_INTEGER, '图表节点'],
    [{ kind: 'table-cell', path: 'a.csv', row: 1, column: 2 }, Number.MAX_SAFE_INTEGER, '第 2 行第 3 列'],
    [{ kind: 'canvas-element', path: 'a.excalidraw', elementId: 'x' }, Number.MAX_SAFE_INTEGER, '画布元素'],
    [{ kind: 'page', path: 'a.pdf', page: 4 }, Number.MAX_SAFE_INTEGER, '第 4 页'],
    [{ kind: 'region', path: 'a.png', region: { x: 0, y: 0, width: 1, height: 1 } }, Number.MAX_SAFE_INTEGER, '区域'],
    [{ kind: 'region', path: 'a.png', page: 2, region: { x: 0, y: 0, width: 1, height: 1 } }, Number.MAX_SAFE_INTEGER, '第 2 页区域'],
    [{ kind: 'whole', path: 'a.md' }, Number.MAX_SAFE_INTEGER, '整份文件'],
  ]
  for (const [anchor, line, label] of cases) {
    assert.equal(model.anchorLine(anchor), line, anchor.kind)
    assert.equal(model.anchorLabel(anchor), label, anchor.kind)
  }
  assert.equal(model.anchorLine(null), Number.MAX_SAFE_INTEGER)
  assert.equal(model.anchorLabel(null), '整份工作项')
})

test('the line selection reducer selects and extends a range', () => {
  assert.deepEqual(model.selectLine(null, 4, false), { startLine: 4, endLine: 4 })
  assert.deepEqual(model.selectLine({ startLine: 4, endLine: 4 }, 8, true), { startLine: 4, endLine: 8 })
  assert.deepEqual(model.selectLine({ startLine: 8, endLine: 8 }, 2, true), { startLine: 2, endLine: 8 })
  assert.deepEqual(model.selectLine({ startLine: 2, endLine: 8 }, 5, false), { startLine: 5, endLine: 5 })
  assert.deepEqual(model.selectLine(null, 5, true), { startLine: 5, endLine: 5 })
  assert.equal(model.isSelected({ startLine: 2, endLine: 4 }, 3), true)
  assert.equal(model.isSelected({ startLine: 2, endLine: 4 }, 5), false)
  assert.equal(model.isSelected(null, 3), false)
})

test('content lines and comment helpers share the display rules', () => {
  assert.deepEqual(model.contentLines('a\nb\n'), ['a', 'b'])
  assert.deepEqual(model.contentLines('a\nb'), ['a', 'b'])
  assert.deepEqual(model.contentLines(''), [''])
  assert.equal(model.commentBody(comment({ body: 'hello' })), 'hello')
  assert.equal(model.commentBody(comment({ type: 'reply', body: 're' })), 're')
  assert.equal(model.commentBody(comment({ type: 'resolve' })), '')
  assert.equal(model.commentAuthor(comment()), '你')
  assert.equal(model.commentAuthor(comment({ author: 'model' })), '模型')
  assert.equal(model.commentAuthor(comment({ type: 'resolve' })), '')
  assert.equal(model.anchorStatusLabel('stale'), '位置待确认')
  assert.equal(model.anchorStatusLabel('moved'), '已重新定位')
  assert.equal(model.anchorStatusLabel(null), null)
})

test('error presentation names the four known failures and a retryable default', () => {
  assert.equal(model.errorPresentation({ code: 'artifact/file-missing', message: 'x' }).title, '文件不存在')
  assert.equal(model.errorPresentation({ code: 'artifact/not-found', message: 'x' }).retryable, false)
  assert.equal(model.errorPresentation({ code: 'artifact/fs-unavailable', message: 'x' }).retryable, false)
  assert.equal(model.errorPresentation({ code: 'artifact/not-previewable', message: 'x' }).retryable, false)
  const generic = model.errorPresentation({ code: 'internal', message: 'boom' })
  assert.equal(generic.title, '加载失败')
  assert.equal(generic.detail, 'boom')
  assert.equal(generic.retryable, true)
  const empty = model.errorPresentation(null)
  assert.equal(empty.title, '加载失败')
  assert.match(empty.detail, /稍后重试/)
})

test('changed line ranges group consecutive differences and trailing inserts', () => {
  assert.deepEqual(model.changedLineRanges('a\nb\nc\n', 'a\nb\nc\n'), [])
  assert.deepEqual(model.changedLineRanges('a\nb\nc\n', 'a\nB\nc\n'), [{ startLine: 2, endLine: 2 }])
  assert.deepEqual(model.changedLineRanges('a\nb\nc\nd\n', 'A\nb\nC\nd\n'), [
    { startLine: 1, endLine: 1 },
    { startLine: 3, endLine: 3 },
  ])
  assert.deepEqual(model.changedLineRanges('a\n', 'a\nb\n'), [{ startLine: 2, endLine: 2 }])
  assert.deepEqual(model.changedLineRanges('a\nb\nc\n', 'a\nb\n'), [{ startLine: 3, endLine: 3 }])
  // An insertion at the top only reports the new line, not the whole file.
  assert.deepEqual(model.changedLineRanges('a\nb\nc\n', 'x\na\nb\nc\n'), [{ startLine: 1, endLine: 1 }])
  // A middle insertion reports only its own line; deletions report the point.
  assert.deepEqual(model.changedLineRanges('a\nb\nc\n', 'a\nx\nb\nc\n'), [{ startLine: 2, endLine: 2 }])
  assert.deepEqual(model.changedLineRanges('a\nb\nc\n', 'a\nc\n'), [{ startLine: 2, endLine: 2 }])
  assert.deepEqual(model.changedLineRanges('a\nb\nc\n', 'a\nB\nC\n'), [{ startLine: 2, endLine: 3 }])
  assert.deepEqual(model.changedLineRanges('', 'x\ny\n'), [{ startLine: 1, endLine: 2 }])
})

test('save state labels name every phase', () => {
  assert.equal(model.saveStateLabel('saved', 12), '已保存 · r12')
  assert.equal(model.saveStateLabel('saving', 12), '保存中…')
  assert.equal(model.saveStateLabel('conflict', 12), '冲突')
  assert.equal(model.saveStateLabel('failed', 12), '保存失败')
})


test('dispatchForThread picks the newest matching batch and flags retries', () => {
  const thread = model.foldThreads([comment({ commentId: 'comment-1', threadId: 'comment-1' })])[0]
  const dispatches = [
    { dispatchId: 'dispatch-1', state: 'replied', commentIds: ['comment-1'], errorCode: null, updatedAt: '2026-02-01T00:00:00.000Z' },
    { dispatchId: 'dispatch-2', state: 'failed', commentIds: ['comment-1'], errorCode: 'artifact/dispatch-unavailable', updatedAt: '2026-02-02T00:00:00.000Z' },
    { dispatchId: 'dispatch-3', state: 'queued', commentIds: ['comment-9'], errorCode: null, updatedAt: '2026-02-03T00:00:00.000Z' },
  ]
  const dispatch = model.dispatchForThread(thread, dispatches)
  assert.equal(dispatch.dispatchId, 'dispatch-2')
  assert.equal(model.dispatchForThread(thread, []), null)
  assert.equal(model.isRetryableDispatch(dispatch), true)
  assert.equal(model.isRetryableDispatch({ ...dispatch, state: 'replied' }), false)
  assert.equal(model.isRetryableDispatch({ ...dispatch, state: 'queued' }), false)
})


test('markdownLine strips common markers without touching other text', () => {
  assert.deepEqual(model.markdownLine('# Title'), { kind: 'h1', text: 'Title' })
  assert.deepEqual(model.markdownLine('## Sub'), { kind: 'h2', text: 'Sub' })
  assert.deepEqual(model.markdownLine('### Deep'), { kind: 'h3', text: 'Deep' })
  assert.deepEqual(model.markdownLine('- item'), { kind: 'list', text: 'item' })
  assert.deepEqual(model.markdownLine('> quoted'), { kind: 'quote', text: 'quoted' })
  assert.deepEqual(model.markdownLine('plain'), { kind: 'text', text: 'plain' })
})

test('inlineMarkdown separates strong, emphasis, and code runs', () => {
  assert.deepEqual(model.inlineMarkdown(''), [])
  assert.deepEqual(model.inlineMarkdown('plain'), [{ kind: 'text', text: 'plain' }])
  assert.deepEqual(model.inlineMarkdown('a **b** c'), [
    { kind: 'text', text: 'a ' },
    { kind: 'strong', text: 'b' },
    { kind: 'text', text: ' c' },
  ])
  assert.deepEqual(model.inlineMarkdown('`code` and *em*'), [
    { kind: 'code', text: 'code' },
    { kind: 'text', text: ' and ' },
    { kind: 'em', text: 'em' },
  ])
  assert.deepEqual(model.inlineMarkdown('**unclosed'), [{ kind: 'text', text: '**unclosed' }])
  assert.deepEqual(model.inlineMarkdown('**a** `b`'), [
    { kind: 'strong', text: 'a' },
    { kind: 'text', text: ' ' },
    { kind: 'code', text: 'b' },
  ])
})

test('persisted drafts round-trip, drop malformed entries, and clear', () => {
  const storage = new Map()
  const savedWindow = globalThis.window
  globalThis.window = {
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value) },
      removeItem: (key) => { storage.delete(key) },
    },
  }
  try {
    model.savePersistedDraft('artifact-1', { content: 'draft', baseRevision: 3, baseVersion: 'v3', savedAt: 'now' })
    assert.deepEqual(model.readPersistedDraft('artifact-1'), { content: 'draft', baseRevision: 3, baseVersion: 'v3', savedAt: 'now' })
    storage.set('cowork.work-item.draft.' + 'artifact-2', '{"content":1}')
    assert.equal(model.readPersistedDraft('artifact-2'), null)
    assert.equal(storage.has('cowork.work-item.draft.' + 'artifact-2'), false)
    model.removePersistedDraft('artifact-1')
    assert.equal(model.readPersistedDraft('artifact-1'), null)
  } finally {
    globalThis.window = savedWindow
  }
})

test('formatBytes names bytes, kilobytes, and megabytes', () => {
  assert.equal(model.formatBytes(12), '12 B')
  assert.equal(model.formatBytes(2048), '2.0 KB')
  assert.equal(model.formatBytes(2 * 1024 * 1024), '2.0 MB')
})

test('draft storage survives disabled or throwing storage', () => {
  const savedWindow = globalThis.window
  globalThis.window = {
    localStorage: {
      getItem() { throw new Error('disabled') },
      setItem() { throw new Error('full') },
      removeItem() { throw new Error('disabled') },
    },
  }
  try {
    model.savePersistedDraft('artifact-1', { content: 'x', baseRevision: 1, baseVersion: null, savedAt: '' })
    assert.equal(model.readPersistedDraft('artifact-1'), null)
    model.removePersistedDraft('artifact-1')
  } finally {
    globalThis.window = savedWindow
  }
})

test('draft storage drops a JSON null entry', () => {
  const savedWindow = globalThis.window
  const storage = new Map([['cowork.work-item.draft.artifact-1', 'null']])
  globalThis.window = {
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value) },
      removeItem: (key) => { storage.delete(key) },
    },
  }
  try {
    assert.equal(model.readPersistedDraft('artifact-1'), null)
    assert.equal(storage.has('cowork.work-item.draft.artifact-1'), false)
  } finally {
    globalThis.window = savedWindow
  }
})

test('elapsed time and wall-clock time follow the demo labels', () => {
  const now = new Date('2026-02-10T12:00:00.000Z')
  assert.equal(model.formatElapsed('2026-02-10T11:59:42.000Z', now), '18 秒')
  assert.equal(model.formatElapsed('2026-02-10T11:57:00.000Z', now), '3 分钟')
  assert.equal(model.formatElapsed('2026-02-10T09:00:00.000Z', now), '3 小时')
  assert.equal(model.formatElapsed('2026-02-08T12:00:00.000Z', now), '2 天')
  assert.equal(model.formatElapsed('not-a-date', now), '')
  const local = new Date(2026, 1, 10, 14, 32)
  assert.equal(model.formatClock(local.toISOString()), '14:32')
  assert.equal(model.formatClock('not-a-date'), '')
})

test('dispatch detail labels keep the thinking and file-work phrasing', () => {
  assert.equal(model.dispatchDetailLabel('thinking'), '已送达 · 模型思考中')
  assert.equal(model.dispatchDetailLabel('working'), '模型改文件中')
  for (const state of ['queued', 'sent', 'replied', 'failed', 'blocked', 'stale']) {
    assert.equal(model.dispatchDetailLabel(state), model.dispatchLabel(state), state)
  }
})

test('thread ordinals and line pins follow the sorted rail', () => {
  const late = {
    threadId: 'late', root: null, comments: [], resolved: false, anchorStatus: null,
    latestAt: '2026-02-01T02:00:00.000Z',
    anchor: { kind: 'line-range', path: 'a.md', startLine: 8, endLine: 8, quote: '' },
  }
  const early = {
    threadId: 'early', root: null, comments: [], resolved: false, anchorStatus: null,
    latestAt: '2026-02-01T01:00:00.000Z',
    anchor: { kind: 'line-range', path: 'a.md', startLine: 2, endLine: 3, quote: '' },
  }
  const stale = { ...late, threadId: 'stale', anchorStatus: 'stale', anchor: { kind: 'line-range', path: 'a.md', startLine: 9, endLine: 9, quote: '' } }
  const done = { ...early, threadId: 'done', resolved: true }
  const threads = model.sortThreads([late, early, stale, done])
  assert.deepEqual([...model.threadOrdinals(threads).entries()], [
    ['early', 1], ['late', 2], ['stale', 3], ['done', 4],
  ])
  assert.deepEqual([...model.threadLinePins(threads).entries()], [
    [2, { ordinal: 1, tone: 'open' }],
    [8, { ordinal: 2, tone: 'open' }],
    [9, { ordinal: 3, tone: 'stale' }],
  ])
  assert.deepEqual([...model.threadLinePins([done]).entries()], [[2, { ordinal: 1, tone: 'resolved' }]])
  assert.equal(model.threadLinePins([]).size, 0)
})

test('dispatch ownership and the footer delivery summary use rail ordinals', () => {
  const threads = [
    {
      threadId: 't1', root: null, resolved: false, anchorStatus: null,
      latestAt: '2026-02-01T01:00:00.000Z',
      anchor: { kind: 'line-range', path: 'a.md', startLine: 3, endLine: 3, quote: '' },
      comments: [comment({ commentId: 'c1', threadId: 't1' })],
    },
    {
      threadId: 't2', root: null, resolved: false, anchorStatus: 'stale',
      latestAt: '2026-02-01T02:00:00.000Z',
      anchor: { kind: 'line-range', path: 'a.md', startLine: 9, endLine: 9, quote: '' },
      comments: [comment({ commentId: 'c2', threadId: 't2' })],
    },
    {
      threadId: 't3', root: null, resolved: false, anchorStatus: null,
      latestAt: '2026-02-01T03:00:00.000Z',
      anchor: { kind: 'line-range', path: 'a.md', startLine: 12, endLine: 12, quote: '' },
      comments: [comment({ commentId: 'c3', threadId: 't3' })],
    },
  ]
  const dispatches = [
    { dispatchId: 'd1', state: 'replied', commentIds: ['c1'], errorCode: null, updatedAt: '2026-02-01T01:00:00.000Z' },
    { dispatchId: 'd3', state: 'thinking', commentIds: ['c3'], errorCode: null, updatedAt: '2026-02-01T03:00:00.000Z' },
  ]
  assert.equal(model.threadForDispatch('d3', dispatches, threads)?.threadId, 't3')
  assert.equal(model.threadForDispatch('missing', dispatches, threads), null)
  assert.equal(model.deliverySummary(threads, dispatches), '模型已回复 #1 · #3 思考中 · #2 位置待确认')
  assert.equal(model.deliverySummary([], []), '还没有模型回复')
})
