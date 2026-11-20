import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PROJECT_ID,
  artifactContract,
  artifactSchema,
  makeComment,
  makeFile,
  makeRecord,
} from '../support/artifact-fixtures.mjs'

/**
 * The schema parsers are the read-side trust boundary: a record with no
 * identity is skipped, unknown fields are dropped, and a damaged row never
 * poisons its neighbours. Each parser also normalizes what it accepts.
 */
const ARTIFACT = 'artifact-11111111-1111-4111-8111-111111111111'

test('attachment references require id, name, and media type', () => {
  assert.deepEqual(
    artifactSchema.parseAttachmentRef({ attachmentId: 'a-1', name: 'shot.png', mediaType: 'image/png', size: 3, sha256: 'abc' }),
    { attachmentId: 'a-1', name: 'shot.png', mediaType: 'image/png', size: 3, sha256: 'abc' },
  )
  assert.equal(artifactSchema.parseAttachmentRef(null), null)
  assert.equal(artifactSchema.parseAttachmentRef({ name: 'x', mediaType: 'text/plain' }), null)
  assert.equal(artifactSchema.parseAttachmentRef({ attachmentId: 'a', mediaType: 'text/plain' }), null)
  assert.equal(artifactSchema.parseAttachmentRef({ attachmentId: 'a', name: 'x' }), null)
  assert.deepEqual(
    artifactSchema.parseAttachmentRef({ attachmentId: '  a  ', name: '  x  ', mediaType: 'text/plain' }),
    { attachmentId: 'a', name: 'x', mediaType: 'text/plain', size: 0, sha256: '' },
  )
})

test('a file entry normalizes paths, defaults, and flags', () => {
  assert.deepEqual(artifactSchema.parseArtifactFile(makeFile()), makeFile())
  assert.deepEqual(
    artifactSchema.parseArtifactFile({ path: 'a.md' }),
    { path: 'a.md', mediaType: 'application/octet-stream', editable: false, size: 0, sha256: '', revision: 0, fsVersion: null, missing: false },
  )
  assert.equal(artifactSchema.parseArtifactFile({ path: '../escape.md' }), null)
  assert.equal(artifactSchema.parseArtifactFile('a.md'), null)
  assert.equal(
    artifactSchema.parseArtifactFile({ path: 'a.md', size: -1, revision: 1.5, fsVersion: '  ' }).size,
    0,
  )
  assert.equal(artifactSchema.parseArtifactFile({ path: 'a.md', missing: true }).missing, true)
  assert.equal(artifactSchema.parseArtifactFile({ path: 'a.md', editable: 'yes' }).editable, false)
})

test('a record without identity, type, status, or files is refused', () => {
  assert.equal(artifactSchema.parseArtifactRecord(null), null)
  for (const missing of ['artifactId', 'projectId', 'ownerSessionId']) {
    const record = makeRecord()
    delete record[missing]
    assert.equal(artifactSchema.parseArtifactRecord(record), null, missing)
  }
  assert.equal(artifactSchema.parseArtifactRecord(makeRecord({ type: 'nope' })), null)
  assert.equal(artifactSchema.parseArtifactRecord(makeRecord({ status: 'nope' })), null)
  assert.equal(artifactSchema.parseArtifactRecord(makeRecord({ files: [] })), null)
  assert.equal(artifactSchema.parseArtifactRecord(makeRecord({ files: [{ path: '../x' }] })), null)
})

test('a readable record normalizes defaults and drops unknown file entries', () => {
  const parsed = artifactSchema.parseArtifactRecord({
    artifactId: ARTIFACT,
    projectId: PROJECT_ID,
    ownerSessionId: 'session-1',
    type: 'text',
    status: 'pending-view',
    primaryPath: '../escape.md',
    title: '   ',
    files: [{ path: 'docs/spec.md' }, { path: '../escape.md' }, 'not-a-file'],
    revision: -2,
    commentCount: 'many',
    extra: 'ignored',
  })
  assert.equal(parsed.version, 1)
  assert.equal(parsed.title, 'docs/spec.md')
  assert.equal(parsed.primaryPath, 'docs/spec.md')
  assert.equal(parsed.files.length, 1)
  assert.equal(parsed.revision, 0)
  assert.equal(parsed.commentCount, 0)
  assert.equal(parsed.createdAt, '1970-01-01T00:00:00.000Z')
  assert.equal(parsed.updatedAt, '1970-01-01T00:00:00.000Z')
  assert.equal(parsed.activeDispatch, null)
  assert.equal('extra' in parsed, false)
})

test('the primary path is kept when valid and the title is capped', () => {
  const parsed = artifactSchema.parseArtifactRecord(makeRecord({
    title: 't'.repeat(artifactContract.MAX_ARTIFACT_TITLE_CHARS + 5),
    files: [makeFile({ path: 'a.md' }), makeFile({ path: 'docs/spec.md' })],
    primaryPath: 'a.md',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  }))
  assert.equal(parsed.title.length, artifactContract.MAX_ARTIFACT_TITLE_CHARS)
  assert.equal(parsed.primaryPath, 'a.md')
  assert.equal(parsed.updatedAt, '2026-01-02T00:00:00.000Z')
  assert.equal(parsed.files.length, 2)
})

test('the active dispatch summary is kept only when it is complete', () => {
  const valid = artifactSchema.parseArtifactRecord(makeRecord({
    activeDispatch: { dispatchId: 'd-1', state: 'queued', updatedAt: '2026-02-01T00:00:00.000Z' },
  }))
  assert.deepEqual(valid.activeDispatch, {
    dispatchId: 'd-1', state: 'queued', updatedAt: '2026-02-01T00:00:00.000Z',
  })
  const noId = artifactSchema.parseArtifactRecord(makeRecord({ activeDispatch: { state: 'queued' } }))
  assert.equal(noId.activeDispatch, null)
  const badState = artifactSchema.parseArtifactRecord(makeRecord({ activeDispatch: { dispatchId: 'd-1', state: 'nope' } }))
  assert.equal(badState.activeDispatch, null)
  const notAnObject = artifactSchema.parseArtifactRecord(makeRecord({ activeDispatch: 'queued' }))
  assert.equal(notAnObject.activeDispatch, null)
})

test('comment create and reply rows require an author and a body', () => {
  const create = artifactSchema.parseCommentEvent({
    ...makeComment(),
    sessionId: 'session-1',
    quote: 'q'.repeat(5000),
    fileRevision: 2,
    anchor: { kind: 'line-range', path: 'docs/spec.md', startLine: 1, endLine: 1 },
    attachments: [{ attachmentId: 'a-1', name: 'x', mediaType: 'text/plain' }],
  })
  assert.equal(create.type, 'create')
  assert.equal(create.sessionId, 'session-1')
  assert.equal(create.quote.length, artifactContract.MAX_ARTIFACT_QUOTE_CHARS)
  assert.equal(create.fileRevision, 2)
  assert.equal(create.attachments.length, 1)

  const reply = artifactSchema.parseCommentEvent(makeComment({
    type: 'reply', commentId: 'comment-2', threadId: 'comment-1', attachments: [],
  }))
  assert.equal(reply.type, 'reply')
  assert.equal('attachments' in reply, false)

  assert.equal(artifactSchema.parseCommentEvent(makeComment({ author: 'robot' })), null)
  assert.equal(artifactSchema.parseCommentEvent(makeComment({ body: '   ' })), null)
  assert.equal(artifactSchema.parseCommentEvent(makeComment({ anchor: 'nope' })), null)
  assert.equal(artifactSchema.parseCommentEvent(makeComment({ anchor: { kind: 'whole', path: '../x' } })), null)
  assert.equal(artifactSchema.parseCommentEvent(makeComment({ attachments: 'x' })).attachments, undefined)
  assert.equal(artifactSchema.parseCommentEvent(makeComment({ sessionId: '  ' })).sessionId, undefined)
  assert.equal(artifactSchema.parseCommentEvent(makeComment({ fileRevision: 1.5 })).fileRevision, undefined)
})

test('comment rows keep their identity and drop unknown types', () => {
  for (const field of ['eventId', 'artifactId', 'commentId', 'threadId']) {
    const comment = makeComment()
    delete comment[field]
    assert.equal(artifactSchema.parseCommentEvent(comment), null, field)
  }
  assert.equal(artifactSchema.parseCommentEvent(makeComment({ type: 'deleted' })), null)
  assert.equal(artifactSchema.parseCommentEvent(null), null)
  const noTime = artifactSchema.parseCommentEvent({ ...makeComment(), createdAt: undefined })
  assert.equal(noTime.createdAt, '1970-01-01T00:00:00.000Z')
})

test('resolve, reopen and anchor-moved parse their own payloads', () => {
  for (const type of ['resolve', 'reopen']) {
    const parsed = artifactSchema.parseCommentEvent(makeComment({ type }))
    assert.equal(parsed.type, type)
    assert.equal(parsed.author, 'user')
  }
  assert.equal(artifactSchema.parseCommentEvent(makeComment({ type: 'resolve', author: 'bot' })), null)
  const moved = artifactSchema.parseCommentEvent(makeComment({
    type: 'anchor-moved',
    anchor: { kind: 'line-range', path: 'docs/spec.md', startLine: 1, endLine: 2 },
    anchorStatus: 'stale',
  }))
  assert.equal(moved.type, 'anchor-moved')
  assert.equal(moved.anchorStatus, 'stale')
  assert.equal(artifactSchema.parseCommentEvent(makeComment({ type: 'anchor-moved', anchorStatus: 'stale' })), null)
  assert.equal(artifactSchema.parseCommentEvent(makeComment({
    type: 'anchor-moved', anchor: { kind: 'whole', path: 'a.md' }, anchorStatus: 'nope',
  })), null)
})

test('a dispatch record requires identity, state, and comment ids', () => {
  const base = {
    dispatchId: 'd-1',
    artifactId: ARTIFACT,
    sessionId: 'session-1',
    commentIds: ['comment-1'],
    state: 'queued',
    attempts: 0,
    promptRequestId: 'd-1',
    errorCode: null,
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
  }
  assert.equal(artifactSchema.parseDispatchRecord(base).state, 'queued')
  for (const field of ['dispatchId', 'artifactId', 'sessionId', 'promptRequestId']) {
    const record = { ...base, [field]: '  ' }
    assert.equal(artifactSchema.parseDispatchRecord(record), null, field)
  }
  assert.equal(artifactSchema.parseDispatchRecord({ ...base, state: 'nope' }), null)
  assert.equal(artifactSchema.parseDispatchRecord({ ...base, commentIds: 'comment-1' }), null)
  assert.equal(artifactSchema.parseDispatchRecord(null), null)
  assert.deepEqual(
    artifactSchema.parseDispatchRecord({ ...base, commentIds: [1, 'comment-1', ''], attempts: -1, errorCode: 'e' }),
    {
      version: 1,
      dispatchId: 'd-1',
      artifactId: ARTIFACT,
      sessionId: 'session-1',
      commentIds: ['comment-1'],
      state: 'queued',
      attempts: 0,
      promptRequestId: 'd-1',
      errorCode: 'e',
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    },
  )
})

test('an event row needs a sequence, identity, and a known type', () => {
  const base = {
    seq: 3,
    eventId: 'event-1',
    type: 'artifact.updated',
    artifactId: ARTIFACT,
    time: '2026-02-01T00:00:00.000Z',
    data: { revision: 1 },
  }
  assert.equal(artifactSchema.parseArtifactEvent(base).seq, 3)
  assert.equal(artifactSchema.parseArtifactEvent({ ...base, seq: 0 }), null)
  assert.equal(artifactSchema.parseArtifactEvent({ ...base, seq: 1.5 }), null)
  assert.equal(artifactSchema.parseArtifactEvent({ ...base, seq: '3' }), null)
  assert.equal(artifactSchema.parseArtifactEvent({ ...base, eventId: ' ' }), null)
  assert.equal(artifactSchema.parseArtifactEvent({ ...base, artifactId: ' ' }), null)
  assert.equal(artifactSchema.parseArtifactEvent({ ...base, type: 'nope' }), null)
  assert.equal(artifactSchema.parseArtifactEvent(null), null)
  assert.deepEqual(artifactSchema.parseArtifactEvent({ ...base, data: 'nope' }).data, {})
  assert.equal(artifactSchema.parseArtifactEvent({ ...base, time: '' }).time, '1970-01-01T00:00:00.000Z')
})
