import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  SESSION,
  artifactContract,
  createHarness,
  jsonOf,
  makeFile,
  makeRecord,
  sha256,
} from '../support/artifact-fixtures.mjs'
const { rawRequest } = await import('../support/artifact-fixtures.mjs')

/** Attachment upload, serving, validation, and count rules. */
const SPEC = '# Spec\n\nfirst paragraph\nsecond paragraph\n'
const ARTIFACT = 'artifact-11111111-1111-4111-8111-111111111111'
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function specFile(content = SPEC, overrides = {}) {
  return makeFile({ size: Buffer.byteLength(content), sha256: sha256(content), fsVersion: sha256(content), ...overrides })
}

async function withSeededHarness(operation, options = {}) {
  const harness = await createHarness({ files: { 'docs/spec.md': SPEC, ...(options.files ?? {}) }, ...options })
  try {
    await harness.runtime().store.createRecord(makeRecord({ files: [specFile(options.content)] }))
    return await operation(harness)
  } finally {
    await harness.cleanup()
  }
}

function createHashForTest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}


/** Upload one attachment through the streaming route. */
async function uploadAttachment(harness, name, bytes, contentType = 'application/octet-stream') {
  return harness.routes.get('/api/cowork.artifact.upload')(rawRequest(
    '/api/cowork.artifact.upload',
    { query: { sessionId: SESSION, artifactId: ARTIFACT, name }, bytes, contentType },
  ))
}

test('an image upload is sniffed and stored without counting', async () => {
  await withSeededHarness(async (harness) => {
    const response = await uploadAttachment(harness, 'shot.png', PNG_BYTES)
    assert.equal(response.status, 200)
    const body = await jsonOf(response)
    assert.equal(body.ok, true)
    assert.equal(body.attachment.mediaType, 'image/png')
    assert.equal(body.attachment.size, PNG_BYTES.byteLength)
    assert.match(body.attachment.attachmentId, /^attachment-/)
    const stored = await harness.runtime().store.readUpload(ARTIFACT, body.attachment.attachmentId)
    assert.deepEqual([...stored], [...PNG_BYTES])
    const { createHash } = await import('node:crypto')
    assert.equal(body.attachment.sha256, createHash('sha256').update(PNG_BYTES).digest('hex'))
    // Storing bytes publishes nothing: no count, no publish row.
    const record = await harness.runtime().store.readRecord(ARTIFACT)
    assert.equal(record.attachmentCount, 0)
    assert.deepEqual(await harness.runtime().store.readAttachmentPublishes(ARTIFACT), [])

    const comment = await jsonOf(await harness.request('/api/cowork.artifact.comment', {
      method: 'POST',
      body: {
        sessionId: SESSION,
        artifactId: ARTIFACT,
        body: 'see the screenshot',
        attachments: [body.attachment],
      },
    }))
    assert.equal(comment.ok, true)
    assert.deepEqual(comment.comment.attachments, [body.attachment])
    // Referencing the upload is what publishes and counts it — once.
    assert.equal(comment.record.attachmentCount, 1)
    const publishes = await harness.runtime().store.readAttachmentPublishes(ARTIFACT)
    assert.deepEqual(publishes.map((row) => row.attachmentId), [body.attachment.attachmentId])
    assert.equal(publishes[0].source, 'user')
  })
})

test('a stored attachment is served with its media type and nosniff', async () => {
  await withSeededHarness(async (harness) => {
    const uploaded = await jsonOf(await uploadAttachment(harness, 'shot.png', PNG_BYTES))
    await harness.request('/api/cowork.artifact.comment', {
      method: 'POST',
      body: {
        sessionId: SESSION,
        artifactId: ARTIFACT,
        body: 'see attached',
        attachments: [uploaded.attachment],
      },
    })
    const response = await harness.request('/api/cowork.artifact.attachment', {
      query: { sessionId: SESSION, artifactId: ARTIFACT, attachmentId: uploaded.attachment.attachmentId },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...PNG_BYTES])
    const unknown = await harness.request('/api/cowork.artifact.attachment', {
      query: { sessionId: SESSION, artifactId: ARTIFACT, attachmentId: 'attachment-missing' },
    })
    assert.equal(unknown.status, 404)
    // A ref that exists while its bytes are gone is a 404, not a broken body.
    const { rm } = await import('node:fs/promises')
    await rm(join(harness.repoPath, '.dsh-cowork', 'artifacts', ARTIFACT, 'uploads', uploaded.attachment.attachmentId))
    const vanished = await harness.request('/api/cowork.artifact.attachment', {
      query: { sessionId: SESSION, artifactId: ARTIFACT, attachmentId: uploaded.attachment.attachmentId },
    })
    assert.equal(vanished.status, 404)
  })
})

test('a forged attachment ref is canonicalized and text is a forced download', async () => {
  await withSeededHarness(async (harness) => {
    const bytes = Buffer.from('<script>alert(1)</script>\n')
    const uploaded = await jsonOf(await uploadAttachment(harness, 'notes.txt', bytes))
    const forged = {
      ...uploaded.attachment,
      mediaType: 'text/html',
      size: 1,
      sha256: '0'.repeat(64),
    }
    const comment = await jsonOf(await harness.request('/api/cowork.artifact.comment', {
      method: 'POST',
      body: { sessionId: SESSION, artifactId: ARTIFACT, body: 'forged ref', attachments: [forged] },
    }))
    assert.equal(comment.ok, true)
    assert.equal(comment.comment.attachments[0].mediaType, 'text/plain')
    assert.equal(comment.comment.attachments[0].size, bytes.byteLength)
    assert.equal(comment.comment.attachments[0].sha256, createHashForTest(bytes))
    const response = await harness.request('/api/cowork.artifact.attachment', {
      query: { sessionId: SESSION, artifactId: ARTIFACT, attachmentId: uploaded.attachment.attachmentId },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8')
    assert.match(response.headers.get('content-disposition') ?? '', /^attachment;/)
    assert.match(response.headers.get('content-security-policy') ?? '', /sandbox/)
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...bytes])
  })
})

test('a text upload is accepted and stored as text/markdown', async () => {
  await withSeededHarness(async (harness) => {
    const bytes = new TextEncoder().encode('# note\n')
    const body = await jsonOf(await uploadAttachment(harness, 'note.md', bytes, 'text/markdown'))
    assert.equal(body.attachment.mediaType, 'text/markdown')
  })
})

test('upload validation keeps its stable codes', async () => {
  await withSeededHarness(async (harness) => {
    const cases = [
      ['shot.png', new Uint8Array([1, 2, 3]), 400, 'artifact/upload-invalid'],
      ['notes.bin', new Uint8Array([1]), 400, 'artifact/upload-invalid'],
      ['shots.png', new Uint8Array(), 400, 'artifact/upload-invalid'],
      ['text.txt', new Uint8Array([0xff, 0xfe]), 400, 'artifact/upload-invalid'],
      ['a'.repeat(201), PNG_BYTES, 400, 'request/invalid-query'],
    ]
    for (const [name, bytes, status, code] of cases) {
      const response = await uploadAttachment(harness, name, bytes)
      assert.equal(response.status, status, name)
      assert.equal((await jsonOf(response)).error.code, code, name)
    }
    const tooLarge = new Uint8Array(artifactContract.MAX_ARTIFACT_ATTACHMENT_BYTES + 1)
    const oversized = await uploadAttachment(harness, 'big.png', tooLarge)
    assert.equal(oversized.status, 413)
    const noBody = await harness.routes.get('/api/cowork.artifact.upload')(new Request(
      `http://127.0.0.1:3080/api/cowork.artifact.upload?sessionId=${SESSION}&artifactId=${ARTIFACT}&name=shot.png`,
      { method: 'POST', headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } },
    ))
    assert.equal(noBody.status, 400)
    assert.equal((await jsonOf(noBody)).error.code, 'request/invalid-body')
    const declaredTooLarge = await harness.routes.get('/api/cowork.artifact.upload')(new Request(
      `http://127.0.0.1:3080/api/cowork.artifact.upload?sessionId=${SESSION}&artifactId=${ARTIFACT}&name=shot.png`,
      {
        method: 'POST',
        headers: {
          host: '127.0.0.1:3080',
          origin: 'http://127.0.0.1:3080',
          'content-length': String(artifactContract.MAX_ARTIFACT_ATTACHMENT_BYTES + 1),
        },
      },
    ))
    assert.equal(declaredTooLarge.status, 413)
  })
})

test('a comment refuses an unknown attachment ref and more than five', async () => {
  await withSeededHarness(async (harness) => {
    const unknown = await harness.request('/api/cowork.artifact.comment', {
      method: 'POST',
      body: {
        sessionId: SESSION,
        artifactId: ARTIFACT,
        body: 'x',
        attachments: [{ attachmentId: 'attachment-missing', name: 'x.png', mediaType: 'image/png', size: 1, sha256: 'x' }],
      },
    })
    assert.equal(unknown.status, 400)
    assert.equal((await jsonOf(unknown)).error.code, 'artifact/upload-invalid')
    const tooMany = await harness.request('/api/cowork.artifact.comment', {
      method: 'POST',
      body: {
        sessionId: SESSION,
        artifactId: ARTIFACT,
        body: 'x',
        attachments: Array.from({ length: 6 }, () => ({ attachmentId: 'attachment-1', name: 'x', mediaType: 'image/png' })),
      },
    })
    assert.equal(tooMany.status, 400)
  })
})

test('the upload attachment cap is enforced', async () => {
  await withSeededHarness(async (harness) => {
    await harness.runtime().store.mutateRecord(ARTIFACT, (record) => ({
      ...record,
      attachmentCount: artifactContract.MAX_ARTIFACT_ATTACHMENTS,
    }))
    const response = await uploadAttachment(harness, 'shot.png', PNG_BYTES)
    assert.equal(response.status, 409)
    assert.equal((await jsonOf(response)).error.code, 'artifact/limit-reached')
  })
})

