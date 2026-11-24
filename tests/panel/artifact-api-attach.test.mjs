import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  SESSION,
  artifactContract,
  artifactRuntime,
  createHarness,
  jsonOf,
  makeComment,
  makeFile,
  makeRecord,
  rawRequest,
  sha256,
} from '../support/artifact-fixtures.mjs'

/**
 * Browser publication of a work-item attachment: upload stores bytes only, and
 * `POST artifact.attach` publishes one stored upload into `attachments.jsonl`,
 * which is what makes it count, list, and become readable. A record without
 * that log falls back to its comment refs.
 */
const SPEC = '# Spec\n\nfirst paragraph\nsecond paragraph\n'
const ARTIFACT = 'artifact-11111111-1111-4111-8111-111111111111'
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const ATTACH = artifactContract.ARTIFACT_ATTACH_PATH
const UPLOAD = artifactContract.ARTIFACT_UPLOAD_PATH
const DETAIL = artifactContract.ARTIFACT_DETAIL_PATH
const ATTACHMENT = artifactContract.ARTIFACT_ATTACHMENT_PATH

/** Lowercase hex SHA-256 of raw bytes. */
function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** A registered file entry whose sha/version match the fake host fs token. */
function specFile() {
  return makeFile({ size: Buffer.byteLength(SPEC), sha256: sha256(SPEC), fsVersion: sha256(SPEC) })
}

/** Create the harness plus one registered work item. */
async function withSeededHarness(operation) {
  const harness = await createHarness({ files: { 'docs/spec.md': SPEC } })
  try {
    await harness.runtime().store.createRecord(makeRecord({ files: [specFile()] }))
    return await operation(harness)
  } finally {
    await harness.cleanup()
  }
}

/** Upload one attachment's bytes through the streaming route. */
async function uploadAttachment(harness, name, bytes, contentType = 'application/octet-stream') {
  return harness.routes.get(UPLOAD)(rawRequest(UPLOAD, {
    query: { sessionId: SESSION, artifactId: ARTIFACT, name },
    bytes,
    contentType,
  }))
}

/** Publish one stored upload id; an omitted name exercises the byte fallback. */
async function attachUpload(harness, attachmentId, name) {
  return harness.request(ATTACH, {
    method: 'POST',
    body: {
      sessionId: SESSION,
      artifactId: ARTIFACT,
      attachmentId,
      ...(name === undefined ? {} : { name }),
    },
  })
}

/** Read the work item's detail body. */
async function detailOf(harness) {
  return jsonOf(await harness.request(DETAIL, { query: { sessionId: SESSION, artifactId: ARTIFACT } }))
}

test('publishing a stored upload counts it once and the detail lists it', async () => {
  await withSeededHarness(async (harness) => {
    const uploaded = await jsonOf(await uploadAttachment(harness, 'shot.png', PNG_BYTES))
    const before = await detailOf(harness)
    assert.deepEqual(before.publishedAttachments, [])
    assert.equal(before.record.attachmentCount, 0)

    const response = await attachUpload(harness, uploaded.attachment.attachmentId, 'Chart')
    assert.equal(response.status, 200)
    const body = await jsonOf(response)
    assert.equal(body.ok, true)
    assert.equal(body.source, 'user')
    assert.equal(body.published, true)
    assert.equal(body.attachment.attachmentId, uploaded.attachment.attachmentId)
    assert.equal(body.attachment.name, 'Chart')
    assert.equal(body.attachment.mediaType, 'image/png')
    assert.equal(body.attachment.size, PNG_BYTES.byteLength)
    assert.equal(body.attachment.sha256, sha256Bytes(PNG_BYTES))

    const after = await detailOf(harness)
    assert.equal(after.record.attachmentCount, 1)
    assert.equal(after.publishedAttachments.length, 1)
    assert.equal(after.publishedAttachments[0].source, 'user')
    assert.equal(after.publishedAttachments[0].name, 'Chart')
    assert.equal(after.publishedAttachments[0].version, 1)

    // The publish row is durable: a later request reads the same list.
    const again = await detailOf(harness)
    assert.deepEqual(
      again.publishedAttachments.map((row) => row.attachmentId),
      [uploaded.attachment.attachmentId],
    )
    const events = await harness.runtime().store.readEvents()
    assert.ok(events.some((event) => event.type === 'artifact.updated'
      && event.data.attachmentId === uploaded.attachment.attachmentId))
  })
})

test('publishing the same upload twice is idempotent', async () => {
  await withSeededHarness(async (harness) => {
    const uploaded = await jsonOf(await uploadAttachment(harness, 'shot.png', PNG_BYTES))
    const first = await jsonOf(await attachUpload(harness, uploaded.attachment.attachmentId, 'Chart'))
    const second = await jsonOf(await attachUpload(harness, uploaded.attachment.attachmentId, 'Chart'))
    assert.equal(first.published, true)
    assert.equal(second.published, false)
    assert.deepEqual(second.attachment, first.attachment)
    assert.equal((await detailOf(harness)).record.attachmentCount, 1)
    assert.equal((await harness.runtime().store.readAttachmentPublishes(ARTIFACT)).length, 1)
  })
})

test('publishing an upload that is not stored is refused', async () => {
  await withSeededHarness(async (harness) => {
    const missing = await attachUpload(harness, 'attachment-missing')
    assert.equal(missing.status, 400)
    assert.equal((await jsonOf(missing)).error.code, 'artifact/upload-invalid')

    const omitted = await harness.request(ATTACH, {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT },
    })
    assert.equal(omitted.status, 400)
    assert.equal((await jsonOf(omitted)).error.code, 'request/invalid-body')
  })
})

test('an upload stays invisible until it is published', async () => {
  await withSeededHarness(async (harness) => {
    const uploaded = await jsonOf(await uploadAttachment(harness, 'shot.png', PNG_BYTES))
    const body = await detailOf(harness)
    assert.equal(body.record.attachmentCount, 0)
    assert.deepEqual(body.publishedAttachments, [])
    const serving = await harness.request(ATTACHMENT, {
      query: { sessionId: SESSION, artifactId: ARTIFACT, attachmentId: uploaded.attachment.attachmentId },
    })
    assert.equal(serving.status, 404)
    assert.equal((await jsonOf(serving)).error.code, 'artifact/not-found')
  })
})

test('a record without the publish log falls back to its comment refs', async () => {
  await withSeededHarness(async (harness) => {
    const attachmentId = 'attachment-legacy-0000-4000-8000-000000000000'
    const ref = {
      attachmentId,
      name: 'legacy.png',
      mediaType: 'image/png',
      size: PNG_BYTES.byteLength,
      sha256: sha256Bytes(PNG_BYTES),
    }
    await harness.runtime().store.saveUpload(ARTIFACT, attachmentId, PNG_BYTES)
    await harness.runtime().store.appendComment(makeComment({ author: 'model', attachments: [ref] }))
    await harness.runtime().store.mutateRecord(ARTIFACT, (record) => ({ ...record, attachmentCount: 1 }))

    const body = await detailOf(harness)
    assert.equal(body.publishedAttachments.length, 1)
    assert.equal(body.publishedAttachments[0].attachmentId, attachmentId)
    assert.equal(body.publishedAttachments[0].source, 'model')
    assert.equal(body.publishedAttachments[0].publishedAt, makeComment().createdAt)

    // The fallback is a read: it writes no log and changes no count.
    const logPath = join(harness.repoPath, '.dsh-cowork', 'artifacts', ARTIFACT, 'attachments.jsonl')
    assert.equal(existsSync(logPath), false)
    assert.equal((await harness.runtime().store.readRecord(ARTIFACT)).attachmentCount, 1)

    const serving = await harness.request(ATTACHMENT, {
      query: { sessionId: SESSION, artifactId: ARTIFACT, attachmentId },
    })
    assert.equal(serving.status, 200)
    assert.equal(serving.headers.get('content-type'), 'image/png')
  })
})

test('the display name is sanitized and the bytes decide the served type', async () => {
  await withSeededHarness(async (harness) => {
    const png = await jsonOf(await uploadAttachment(harness, 'shot.png', PNG_BYTES))
    const longName = `chart\u0000${'名'.repeat(300)}`
    const body = await jsonOf(await attachUpload(harness, png.attachment.attachmentId, longName))
    assert.equal(body.attachment.name.includes('\u0000'), false)
    assert.equal([...body.attachment.name].length, artifactContract.MAX_ARTIFACT_ATTACHMENT_NAME_CHARS)

    const image = await harness.request(ATTACHMENT, {
      query: { sessionId: SESSION, artifactId: ARTIFACT, attachmentId: png.attachment.attachmentId },
    })
    assert.equal(image.headers.get('content-type'), 'image/png')
    assert.match(image.headers.get('content-disposition') ?? '', /^inline;/)
    assert.equal(image.headers.get('x-content-type-options'), 'nosniff')
    assert.match(image.headers.get('content-security-policy') ?? '', /sandbox/)

    // No display name: the media type comes from the bytes, and text stays a
    // forced download even when its content looks like markup.
    const text = await jsonOf(await uploadAttachment(harness, 'notes.txt', Buffer.from('<b>x</b>\n')))
    const unnamed = await jsonOf(await attachUpload(harness, text.attachment.attachmentId))
    assert.equal(unnamed.attachment.name, text.attachment.attachmentId)
    assert.equal(unnamed.attachment.mediaType, 'text/plain')
    const served = await harness.request(ATTACHMENT, {
      query: { sessionId: SESSION, artifactId: ARTIFACT, attachmentId: text.attachment.attachmentId },
    })
    assert.equal(served.headers.get('content-type'), 'text/plain; charset=utf-8')
    assert.match(served.headers.get('content-disposition') ?? '', /^attachment;/)
  })
})

test('publishing past the attachment cap is refused', async () => {
  await withSeededHarness(async (harness) => {
    const attachmentId = 'attachment-capped-0000-4000-8000-000000000000'
    await harness.runtime().store.saveUpload(ARTIFACT, attachmentId, PNG_BYTES)
    await harness.runtime().store.mutateRecord(ARTIFACT, (record) => ({
      ...record,
      attachmentCount: artifactContract.MAX_ARTIFACT_ATTACHMENTS,
    }))
    const response = await attachUpload(harness, attachmentId, 'shot.png')
    assert.equal(response.status, 409)
    assert.equal((await jsonOf(response)).error.code, 'artifact/limit-reached')
    // The upload route keeps orphan bytes out once the cap is reached too.
    const upload = await uploadAttachment(harness, 'shot.png', PNG_BYTES)
    assert.equal(upload.status, 409)
  })
})

test('an empty stored upload and a blank display name are handled', async () => {
  await withSeededHarness(async (harness) => {
    const emptyId = 'attachment-empty-0000-4000-8000-000000000000'
    await harness.runtime().store.saveUpload(ARTIFACT, emptyId, new Uint8Array())
    const empty = await attachUpload(harness, emptyId)
    assert.equal(empty.status, 400)
    assert.equal((await jsonOf(empty)).error.code, 'artifact/upload-invalid')

    const text = await jsonOf(await uploadAttachment(harness, 'notes.txt', Buffer.from('x\n')))
    const blank = await jsonOf(await attachUpload(harness, text.attachment.attachmentId, '   '))
    assert.equal(blank.attachment.name, text.attachment.attachmentId)
  })
})

test('publishing for a vanished record is a stable not-found', async () => {
  await withSeededHarness(async (harness) => {
    const runtime = harness.manager.runtimeFor(harness.repoPath)
    await assert.rejects(
      artifactRuntime.publishAttachmentUnlocked(runtime, {
        artifactId: 'artifact-missing',
        attachment: {
          attachmentId: 'attachment-x',
          name: 'x.png',
          mediaType: 'image/png',
          size: 1,
          sha256: 'a'.repeat(64),
        },
        source: 'user',
        now: new Date('2026-02-01T00:00:00.000Z'),
      }),
      (error) => error.code === 'artifact/not-found',
    )
  })
})

test('referencing the same upload in two comments publishes it once', async () => {
  await withSeededHarness(async (harness) => {
    const uploaded = await jsonOf(await uploadAttachment(harness, 'shot.png', PNG_BYTES))
    for (const body of ['first', 'second']) {
      const response = await harness.request('/api/cowork.artifact.comment', {
        method: 'POST',
        body: { sessionId: SESSION, artifactId: ARTIFACT, body, attachments: [uploaded.attachment] },
      })
      assert.equal(response.status, 200)
    }
    assert.equal((await detailOf(harness)).record.attachmentCount, 1)
    assert.equal((await harness.runtime().store.readAttachmentPublishes(ARTIFACT)).length, 1)
  })
})

test('a work item from another project is refused', async () => {
  const harness = await createHarness()
  try {
    await harness.runtime().store.createRecord(makeRecord({ projectId: 'other-project' }))
    const response = await attachUpload(harness, 'attachment-missing')
    assert.equal(response.status, 403)
    assert.equal((await jsonOf(response)).error.code, 'artifact/session-mismatch')
  } finally {
    await harness.cleanup()
  }
})
