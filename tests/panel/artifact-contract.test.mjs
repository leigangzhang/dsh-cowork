import test from 'node:test'
import assert from 'node:assert/strict'
import '../support/ts-hook.mjs'

/**
 * The artifact wire contract is the one vocabulary the host routes, the
 * `cowork_artifact_*` tools and the browser half share. This suite pins the
 * frozen names, the two state axes, the complete label/status tables, and the
 * pure helpers, so a rename or a missing label fails here instead of on the
 * wire.
 */
const contract = await import('../../src/panel/artifact-contract.ts')
const apiContract = await import('../../src/panel/api-contract.ts')

test('every artifact route is an exact /api/cowork route with a unique path', () => {
  const paths = Object.entries(contract)
    .filter(([name, value]) => name.endsWith('_PATH') && typeof value === 'string')
    .map(([name, value]) => [name, value])
  assert.ok(paths.length >= 13, `expected the full route set, got ${paths.length}`)
  for (const [name, path] of paths) {
    assert.match(path, /^\/api\/cowork\.artifact\.[a-z.]+$/, `${name} has an unexpected shape`)
  }
  assert.equal(new Set(paths.map(([, path]) => path)).size, paths.length)
  assert.equal(contract.ARTIFACT_LIST_PATH, '/api/cowork.artifact.list')
  assert.equal(contract.ARTIFACT_DETAIL_PATH, '/api/cowork.artifact.detail')
  assert.equal(contract.ARTIFACT_FILE_PATH, '/api/cowork.artifact.file')
  assert.equal(contract.ARTIFACT_COMMENTS_PATH, '/api/cowork.artifact.comments')
  assert.equal(contract.ARTIFACT_COMMENT_PATH, '/api/cowork.artifact.comment')
  assert.equal(contract.ARTIFACT_COMMENT_RESOLVE_PATH, '/api/cowork.artifact.comment.resolve')
  assert.equal(contract.ARTIFACT_STATUS_PATH, '/api/cowork.artifact.status')
  assert.equal(contract.ARTIFACT_EDIT_PATH, '/api/cowork.artifact.edit')
  assert.equal(contract.ARTIFACT_PRESENCE_PATH, '/api/cowork.artifact.presence')
  assert.equal(contract.ARTIFACT_UPLOAD_PATH, '/api/cowork.artifact.upload')
  assert.equal(contract.ARTIFACT_EVENTS_PATH, '/api/cowork.artifact.events')
  assert.equal(contract.ARTIFACT_OPEN_PATH, '/api/cowork.artifact.open')
  assert.equal(contract.ARTIFACT_REBIND_PATH, '/api/cowork.artifact.rebind')
})

test('the two state axes stay distinct and complete', () => {
  assert.deepEqual(contract.ARTIFACT_TYPES, [
    'text', 'doc', 'table', 'diagram', 'canvas', 'pdf', 'image', 'html', 'other',
  ])
  assert.deepEqual(contract.ARTIFACT_STATUSES, [
    'pending-view', 'pending-confirm', 'needs-feedback', 'in-progress', 'confirmed',
  ])
  assert.deepEqual(contract.DISPATCH_STATES, [
    'queued', 'sent', 'thinking', 'working', 'replied', 'failed', 'blocked', 'stale',
  ])
  assert.deepEqual(contract.ARTIFACT_EVENT_TYPES, [
    'artifact.updated', 'file.changed', 'comment.created', 'comment.updated',
    'reply.created', 'dispatch.updated', 'reset',
  ])
  assert.deepEqual(contract.ANCHOR_KINDS, [
    'line-range', 'block', 'diagram-node', 'table-cell', 'canvas-element', 'page', 'region', 'whole',
  ])
  // No status is a delivery state: the design keeps the axes separate.
  for (const status of contract.ARTIFACT_STATUSES) {
    assert.equal(contract.DISPATCH_STATES.includes(status), false)
  }
})

test('the type, status, event, and anchor guards accept only known values', () => {
  for (const value of contract.ARTIFACT_TYPES) assert.equal(contract.isArtifactType(value), true)
  for (const value of contract.ARTIFACT_STATUSES) assert.equal(contract.isArtifactStatus(value), true)
  for (const value of contract.DISPATCH_STATES) assert.equal(contract.isDispatchState(value), true)
  for (const value of contract.ARTIFACT_EVENT_TYPES) assert.equal(contract.isArtifactEventType(value), true)
  for (const value of contract.ANCHOR_KINDS) assert.equal(contract.isAnchorKind(value), true)
  for (const value of ['', 'text2', null, 7, undefined]) {
    assert.equal(contract.isArtifactType(value), false)
    assert.equal(contract.isArtifactStatus(value), false)
    assert.equal(contract.isDispatchState(value), false)
    assert.equal(contract.isArtifactEventType(value), false)
    assert.equal(contract.isAnchorKind(value), false)
  }
})

test('terminal delivery states are the four the design freezes', () => {
  const terminal = contract.DISPATCH_STATES.filter((state) => contract.isTerminalDispatchState(state))
  assert.deepEqual(terminal, ['replied', 'failed', 'blocked', 'stale'])
  assert.deepEqual(contract.TERMINAL_DISPATCH_STATES, terminal)
})

test('every state and type has exactly one human label', () => {
  assert.deepEqual(Object.keys(contract.ARTIFACT_STATUS_LABELS).sort(), [...contract.ARTIFACT_STATUSES].sort())
  assert.deepEqual(Object.keys(contract.ARTIFACT_TYPE_LABELS).sort(), [...contract.ARTIFACT_TYPES].sort())
  assert.deepEqual(Object.keys(contract.DISPATCH_STATE_LABELS).sort(), [...contract.DISPATCH_STATES].sort())
  assert.equal(contract.ARTIFACT_STATUS_LABELS['pending-view'], '待查看')
  assert.equal(contract.ARTIFACT_STATUS_LABELS['needs-feedback'], '需反馈')
  assert.equal(contract.ARTIFACT_TYPE_LABELS.text, 'Markdown')
  assert.equal(contract.DISPATCH_STATE_LABELS.replied, '已回复')
})

test('the artifact error table is complete and joins the panel error table', () => {
  assert.deepEqual(
    Object.keys(contract.ARTIFACT_ERROR_STATUS).sort(),
    [...contract.ARTIFACT_ERROR_CODES].sort(),
  )
  assert.equal(contract.ARTIFACT_ERROR_STATUS['artifact/not-found'], 404)
  assert.equal(contract.ARTIFACT_ERROR_STATUS['artifact/version-conflict'], 409)
  assert.equal(contract.ARTIFACT_ERROR_STATUS['artifact/dispatch-queue-full'], 429)
  for (const code of contract.ARTIFACT_ERROR_CODES) {
    assert.equal(apiContract.PANEL_ERROR_STATUS[code], contract.ARTIFACT_ERROR_STATUS[code])
    assert.equal(apiContract.panelErrorStatus(code), contract.ARTIFACT_ERROR_STATUS[code])
  }
})

test('the record version stamps are the frozen v1 values', () => {
  assert.equal(contract.ARTIFACT_RECORD_VERSION, 1)
  assert.equal(contract.ARTIFACT_COMMENT_VERSION, 1)
  assert.equal(contract.ARTIFACT_DISPATCH_VERSION, 1)
  assert.equal(contract.ARTIFACT_EVENT_VERSION, 1)
})

test('the limits match the frozen design numbers', () => {
  assert.equal(contract.MAX_ARTIFACTS_PER_PROJECT, 500)
  assert.equal(contract.ARTIFACT_LIST_MAX_LIMIT, 200)
  assert.equal(contract.MAX_ARTIFACT_FILES, 20)
  assert.equal(contract.MAX_ARTIFACT_COMMENT_CHARS, 4000)
  assert.equal(contract.MAX_ARTIFACT_COMMENTS, 5000)
  assert.equal(contract.ARTIFACT_COMMENTS_DEFAULT_LIMIT, 50)
  assert.equal(contract.ARTIFACT_COMMENTS_MAX_LIMIT, 200)
  assert.equal(contract.MAX_ARTIFACT_TEXT_BYTES, 5 * 1024 * 1024)
  assert.equal(contract.MAX_ARTIFACT_TEXT_LINES, 20_000)
  assert.equal(contract.MAX_ARTIFACT_ATTACHMENTS_PER_COMMENT, 5)
  assert.equal(contract.MAX_ARTIFACT_ATTACHMENT_BYTES, 5 * 1024 * 1024)
  assert.equal(contract.MAX_ARTIFACT_REVISIONS_PER_FILE, 20)
  assert.equal(contract.ARTIFACT_DISPATCH_WINDOW_MS, 1500)
  assert.equal(contract.MAX_COMMENTS_PER_DISPATCH, 10)
  assert.equal(contract.MAX_DISPATCH_QUEUE_PER_SESSION, 50)
  assert.equal(contract.MAX_DISPATCH_QUEUE_PER_PROJECT, 200)
  assert.deepEqual(contract.ARTIFACT_DISPATCH_RETRY_DELAYS_MS, [1000, 4000, 15000])
  assert.equal(contract.ARTIFACT_DISPATCH_TIMEOUT_MS, 600_000)
  assert.equal(contract.ARTIFACT_DISPATCH_CONCURRENCY, 4)
  assert.equal(contract.ARTIFACT_PRESENCE_REPORT_INTERVAL_MS, 300)
  assert.equal(contract.ARTIFACT_PRESENCE_TTL_MS, 5000)
  assert.equal(contract.ARTIFACT_SAVE_DEBOUNCE_MS, 800)
  assert.equal(contract.ARTIFACT_EVENT_HEARTBEAT_MS, 15_000)
  assert.equal(contract.ARTIFACT_EVENT_LOG_MAX_LINES, 2000)
  assert.equal(contract.MAX_ARTIFACT_ATTACHMENTS, 200)
})

test('an empty tally grows one state at a time', () => {
  let counts = contract.emptyArtifactCounts()
  assert.deepEqual(counts, {
    total: 0, pendingView: 0, pendingConfirm: 0, needsFeedback: 0, inProgress: 0, confirmed: 0,
  })
  for (const status of contract.ARTIFACT_STATUSES) counts = contract.addArtifactToCounts(counts, status)
  assert.deepEqual(counts, {
    total: 5, pendingView: 1, pendingConfirm: 1, needsFeedback: 1, inProgress: 1, confirmed: 1,
  })
})

test('the list projection carries every rail field and no file list', () => {
  const record = {
    version: 1,
    artifactId: 'artifact-1',
    projectId: 'project-1',
    ownerSessionId: 'session-1',
    title: 'spec',
    type: 'text',
    status: 'pending-confirm',
    files: [{ path: 'docs/spec.md', mediaType: 'text/markdown', editable: true, size: 10, sha256: 'a', revision: 1, fsVersion: 'v1', missing: false }],
    primaryPath: 'docs/spec.md',
    revision: 3,
    commentCount: 2,
    attachmentCount: 1,
    activeDispatch: { dispatchId: 'd-1', state: 'queued', updatedAt: '2026-01-01T00:00:00.000Z' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  }
  assert.deepEqual(contract.artifactSummaryOf(record), {
    artifactId: 'artifact-1',
    ownerSessionId: 'session-1',
    title: 'spec',
    type: 'text',
    status: 'pending-confirm',
    primaryPath: 'docs/spec.md',
    revision: 3,
    commentCount: 2,
    attachmentCount: 1,
    activeDispatch: { dispatchId: 'd-1', state: 'queued', updatedAt: '2026-01-01T00:00:00.000Z' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  })
})
