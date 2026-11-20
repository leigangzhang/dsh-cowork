import test from 'node:test'
import assert from 'node:assert/strict'
import '../../support/ts-hook.mjs'

const attachments = await import('../../../src/domains/artifact/attachments.ts')

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0, 0])
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0, 0])
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])

test('image magic types are recognized and no other bytes are images', () => {
  assert.equal(attachments.sniffImageMediaType(PNG), 'image/png')
  assert.equal(attachments.sniffImageMediaType(JPEG), 'image/jpeg')
  assert.equal(attachments.sniffImageMediaType(GIF), 'image/gif')
  assert.equal(attachments.sniffImageMediaType(WEBP), 'image/webp')
  assert.equal(attachments.sniffImageMediaType(Uint8Array.from([0x3c, 0x73, 0x76, 0x67])), null)
  assert.equal(attachments.sniffImageMediaType(new Uint8Array()), null)
  assert.equal(attachments.isInlineImageMediaType('image/png'), true)
  assert.equal(attachments.isInlineImageMediaType('text/html'), false)
})

test('UTF-8 validity is strict', () => {
  assert.equal(attachments.isUtf8(new TextEncoder().encode('hello 世界')), true)
  assert.equal(attachments.isUtf8(Uint8Array.from([0xff, 0x50, 0x4e, 0x47])), false)
})

test('the canonical media type comes from the name and bytes', () => {
  assert.equal(attachments.attachmentMediaType('shot.PNG', PNG), 'image/png')
  assert.equal(attachments.attachmentMediaType('notes.md', new TextEncoder().encode('# notes')), 'text/markdown')
  assert.equal(attachments.attachmentMediaType('data.json', new TextEncoder().encode('{}')), 'text/plain')
  assert.equal(attachments.attachmentMediaType('README', new TextEncoder().encode('text')), 'text/plain')
  assert.throws(() => attachments.attachmentMediaType('shot.png', Uint8Array.from([1, 2, 3])), /image bytes/)
  assert.throws(() => attachments.attachmentMediaType('notes.md', Uint8Array.from([0xff])), /UTF-8/)
  assert.throws(() => attachments.attachmentMediaType('page.html', new TextEncoder().encode('<script>')), /only image and text/)
})
