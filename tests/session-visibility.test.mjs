import test from 'node:test'
import assert from 'node:assert/strict'
import './support/ts-hook.mjs'
/**
 * Contract tests for the reviewer lifecycle module (M10.3): creation with a
 * preset check, after-verdict archival that never throws, and the reviewer ids
 * a panel filters by. Everything runs against recording fakes.
 */

const {
  ReviewerPresetError,
  archiveReviewerAfterVerdict,
  createReviewerSession,
  reviewerSessionIds,
} = await import('../src/platform/session-visibility.ts')
const { REVIEWER_PRESET_ID } = await import('../src/platform/presets.ts')

/** A session-slice fake that records create/archive calls. */
function fakePorts(options = {}) {
  const created = []
  const archived = []
  return {
    created,
    archived,
    async createReviewSession(request) {
      created.push(request)
      if (options.createError !== undefined) throw options.createError
      return options.createResult ?? { sessionId: 'session-reviewer', workspaceId: 'workspace-1', title: 'cowork review: s' }
    },
    async archiveSession(sessionId, archiveOptions) {
      archived.push({ sessionId, options: archiveOptions })
      if (options.archiveError !== undefined) throw options.archiveError
    },
  }
}

test('the reviewer session is created with the reviewer preset and its id', async () => {
  const ports = fakePorts()
  const created = await createReviewerSession(ports, { repoPath: '/repo', subject: 'review me' })

  assert.deepEqual(created, { sessionId: 'session-reviewer', workspaceId: 'workspace-1', title: 'cowork review: s' })
  assert.deepEqual(ports.created, [{ repoPath: '/repo', subject: 'review me', presetId: REVIEWER_PRESET_ID }])
  assert.equal(REVIEWER_PRESET_ID, 'cowork-reviewer')
})

test('a non-reviewer preset is refused before any session is created', async () => {
  const ports = fakePorts()
  await assert.rejects(
    () => createReviewerSession(ports, { repoPath: '/repo', subject: 's', presetId: 'cowork-topic' }),
    ReviewerPresetError,
  )
  assert.equal(ports.created.length, 0, 'no session may be created with the wrong preset')
})

test('a create failure propagates and the host preset mismatch is not hidden', async () => {
  const ports = fakePorts({ createError: new Error('session/create-preset-mismatch: expected cowork-reviewer') })
  await assert.rejects(() => createReviewerSession(ports, { repoPath: '/repo', subject: 's' }), /preset-mismatch/)
  assert.equal(ports.archived.length, 0)
})

test('an empty reviewer session id is refused instead of recorded', async () => {
  const ports = fakePorts({ createResult: { sessionId: '  ', workspaceId: 'w', title: 't' } })
  await assert.rejects(() => createReviewerSession(ports, { repoPath: '/repo', subject: 's' }), /session id/)
})

test('after a verdict the reviewer is archived with stopActivity', async () => {
  const ports = fakePorts()
  assert.deepEqual(await archiveReviewerAfterVerdict(ports, 'session-reviewer'), { archived: true, error: null })
  assert.deepEqual(ports.archived, [{ sessionId: 'session-reviewer', options: { stopActivity: true } }])
})

test('an archive failure is reported and never throws or drops the verdict', async () => {
  const ports = fakePorts({ archiveError: new Error('host refused to archive') })
  const result = await archiveReviewerAfterVerdict(ports, 'session-reviewer')
  assert.equal(result.archived, false)
  assert.match(result.error, /host refused to archive/)
  assert.equal(ports.archived.length, 1, 'the session is left in place for a later attempt')
})

test('reviewerSessionIds lists each recorded reviewer once and skips empty values', () => {
  const document = {
    topics: [
      { reviewerSessionId: 'session-r1' },
      { reviewerSessionId: null },
      { reviewerSessionId: '' },
      { reviewerSessionId: 'session-r1' },
      { reviewerSessionId: 'session-r2' },
    ],
  }
  assert.deepEqual(reviewerSessionIds(document), ['session-r1', 'session-r2'])
  assert.deepEqual(reviewerSessionIds({ topics: [] }), [])
  assert.deepEqual(reviewerSessionIds(null), [])
})
