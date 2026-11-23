/**
 * Attachment validation shared by the upload route, comments, replies, and the
 * attachment reader.
 *
 * The stored bytes are the only trusted source: a comment or reply may name a
 * media type, but it never decides how the bytes are served. Images are
 * recognized by magic bytes (SVG is deliberately absent), text must be valid
 * UTF-8, and anything else is a generic download. The same rules decide what
 * may be published, so a stored-but-unpublished upload is never shown.
 */
import { MAX_ARTIFACT_ATTACHMENT_NAME_CHARS } from '../../panel/artifact-contract.js'
import { ArtifactDomainError } from './errors.js'

/** The image types the viewer may render inline. */
export const INLINE_IMAGE_MEDIA_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Whether one media type is an inline-renderable image. */
export function isInlineImageMediaType(mediaType: string): boolean {
  return INLINE_IMAGE_MEDIA_TYPES.includes(mediaType)
}

/** Detect a supported image from its first bytes; SVG is not an image type here. */
export function sniffImageMediaType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6
    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return null
}

/** Whether a byte sequence is valid UTF-8 (and therefore safe as text). */
export function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/**
 * Derive the canonical media type of one upload from its name and bytes.
 *
 * Throws `artifact/upload-invalid` when an image extension carries non-image
 * bytes or a text file is not UTF-8; unsupported extensions are refused.
 */
export function attachmentMediaType(name: string, bytes: Uint8Array): string {
  const lower = name.toLowerCase()
  if (/\.(png|jpe?g|webp|gif)$/.test(lower)) {
    const sniffed = sniffImageMediaType(bytes)
    if (sniffed === null) throw new ArtifactDomainError('artifact/upload-invalid', 'image bytes do not match a supported type', name)
    return sniffed
  }
  if (/\.(txt|md|markdown|csv|tsv|json)$/.test(lower) || !lower.includes('.')) {
    if (!isUtf8(bytes)) throw new ArtifactDomainError('artifact/upload-invalid', 'text attachment is not valid UTF-8', name)
    return lower.endsWith('.md') || lower.endsWith('.markdown') ? 'text/markdown' : 'text/plain'
  }
  throw new ArtifactDomainError('artifact/upload-invalid', 'only image and text attachments are accepted', name)
}

/**
 * Normalize one attachment display name.
 *
 * The name is display and type-inference data, never a path: control characters
 * are stripped, the result is trimmed and capped at
 * {@link MAX_ARTIFACT_ATTACHMENT_NAME_CHARS}. An absent or blank name falls back
 * to the caller's substitute (an upload id or a source basename).
 */
export function sanitizeAttachmentName(name: unknown, fallback: string): string {
  if (typeof name !== 'string') return fallback
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return cleaned === '' ? fallback : cleaned.slice(0, MAX_ARTIFACT_ATTACHMENT_NAME_CHARS)
}

/**
 * The canonical media type of one browser-published attachment.
 *
 * The upload display name is optional, so a name without an extension lets the
 * stored bytes decide: a sniffed image type, else UTF-8 text. When the name
 * carries an extension, {@link attachmentMediaType} stays strict — an unknown
 * extension (SVG, HTML, PDF, DOCX) or bytes that do not match it are still
 * `artifact/upload-invalid`.
 */
export function publishedAttachmentMediaType(name: string, bytes: Uint8Array): string {
  const base = name.slice(name.lastIndexOf('/') + 1)
  if (base.lastIndexOf('.') <= 0) {
    const imageType = sniffImageMediaType(bytes)
    if (imageType !== null) return imageType
    if (isUtf8(bytes)) return 'text/plain'
    throw new ArtifactDomainError('artifact/upload-invalid', 'only image and text attachments are accepted', name)
  }
  return attachmentMediaType(name, bytes)
}
