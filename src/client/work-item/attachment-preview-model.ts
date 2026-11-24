/**
 * Pure sizing and copy rules for the attachment preview overlay.
 *
 * The dialog itself is a thin DOM shell; every decision a test can pin down —
 * which renderer a media type gets, how a long image picks its default fit, the
 * zoom clamp, and how much text a preview shows — lives here without React.
 */
import type { AttachmentDisplayRow } from './model.ts'

/** The renderer one attachment gets. */
export type AttachmentPreviewKind = 'image' | 'text' | 'other'

/** How the image fills the stage. */
export type PreviewFit = 'contain' | 'width'

/** The smallest zoom the controls allow. */
export const PREVIEW_ZOOM_MIN = 10

/** The largest zoom the controls allow. */
export const PREVIEW_ZOOM_MAX = 400

/** One `+`/`-` press. */
export const PREVIEW_ZOOM_STEP = 10

/** The reset zoom, and the initial one. */
export const PREVIEW_ZOOM_RESET = 100

/** How many bytes of a text attachment a preview loads visibly. */
export const PREVIEW_TEXT_MAX_BYTES = 64 * 1024

/** Height ratio above which an image defaults to width-fit (long screenshot). */
export const PREVIEW_LONG_IMAGE_RATIO = 2

/** Media types rendered as a read-only text preview. */
const TEXT_MEDIA_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'application/json',
])

/** Extensions rendered as text when the stored media type is generic. */
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json'])

/** The lower-case extension of a file name, or ''. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * Choose the preview renderer for one attachment.
 * @param mediaType - stored media type, possibly with parameters.
 * @param name - stored file name, used for the extension fallback.
 * @returns image for `image/*`, text for the whitelist, other otherwise.
 */
export function previewKindOf(mediaType: string, name: string): AttachmentPreviewKind {
  if (mediaType.startsWith('image/')) return 'image'
  const type = mediaType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (TEXT_MEDIA_TYPES.has(type)) return 'text'
  return TEXT_EXTENSIONS.has(extensionOf(name)) ? 'text' : 'other'
}

/**
 * The default fit for one loaded image.
 *
 * A long screenshot (more than two stages tall) should be readable, so it
 * starts width-fit and scrolls; every other image starts contain and is never
 * upscaled by the fit mode.
 * @param naturalHeight - decoded image height.
 * @param stageHeight - visible stage height.
 */
export function defaultFitForImage(naturalHeight: number, stageHeight: number): PreviewFit {
  if (naturalHeight <= 0 || stageHeight <= 0) return 'contain'
  return naturalHeight > PREVIEW_LONG_IMAGE_RATIO * stageHeight ? 'width' : 'contain'
}

/** Toggle between the two fit modes. */
export function nextFit(fit: PreviewFit): PreviewFit {
  return fit === 'contain' ? 'width' : 'contain'
}

/** The footer label of one fit mode. */
export function fitLabel(fit: PreviewFit): string {
  return fit === 'contain' ? '适应页面' : '适合宽度'
}

/** Clamp one zoom percentage to the control range. */
function zoomClamp(percent: number): number {
  if (!Number.isFinite(percent)) return PREVIEW_ZOOM_RESET
  return Math.round(Math.min(Math.max(percent, PREVIEW_ZOOM_MIN), PREVIEW_ZOOM_MAX))
}

/** One `+`/`-` zoom press: a 10% step, clamped. */
export function zoomStep(percent: number, direction: 1 | -1): number {
  return zoomClamp(percent + direction * PREVIEW_ZOOM_STEP)
}

/** One rendered image box at the current fit and zoom. */
export interface ImageDisplaySize {
  readonly width: number
  readonly height: number
}

/** Everything the image box calculation reads. */
export interface ImageDisplayInput {
  readonly naturalWidth: number
  readonly naturalHeight: number
  readonly stageWidth: number
  readonly stageHeight: number
  readonly fit: PreviewFit
  readonly zoomPercent: number
}

/**
 * The pixel box an image occupies in the stage.
 *
 * Contain never upscales a small image (scale ≤ 1); width-fit fills the stage
 * width and may upscale a long screenshot. Zoom multiplies either base scale,
 * and the stage scrolls around the enlarged box.
 * @param input - natural size, stage size, fit, and zoom.
 * @returns integer width/height for the image element.
 */
export function imageDisplaySize(input: ImageDisplayInput): ImageDisplaySize {
  const naturalWidth = Math.max(1, input.naturalWidth)
  const naturalHeight = Math.max(1, input.naturalHeight)
  const stageWidth = Math.max(1, input.stageWidth)
  const stageHeight = Math.max(1, input.stageHeight)
  const base = input.fit === 'width'
    ? stageWidth / naturalWidth
    : Math.min(1, stageWidth / naturalWidth, stageHeight / naturalHeight)
  const scale = base * (zoomClamp(input.zoomPercent) / PREVIEW_ZOOM_RESET)
  return {
    width: Math.max(1, Math.round(naturalWidth * scale)),
    height: Math.max(1, Math.round(naturalHeight * scale)),
  }
}

/** One text preview slice plus what was left out. */
export interface TextPreview {
  readonly text: string
  readonly truncated: boolean
  /** UTF-8 bytes not shown because they exceed the preview cap. */
  readonly omittedBytes: number
}

/**
 * The first `maxBytes` UTF-8 bytes of one text attachment.
 * @param text - the full stored text.
 * @param maxBytes - preview cap; defaults to {@link PREVIEW_TEXT_MAX_BYTES}.
 * @returns the slice, whether it was cut, and how many bytes remain.
 */
export function textPreview(text: string, maxBytes = PREVIEW_TEXT_MAX_BYTES): TextPreview {
  const encoder = new TextEncoder()
  const total = encoder.encode(text).byteLength
  if (total <= maxBytes) return { text, truncated: false, omittedBytes: 0 }
  const points = Array.from(text)
  let used = 0
  let end = 0
  for (let index = 0; index < points.length; index += 1) {
    const bytes = encoder.encode(points[index]).byteLength
    if (used + bytes > maxBytes) break
    used += bytes
    end = index + 1
  }
  return { text: points.slice(0, end).join(''), truncated: true, omittedBytes: total - used }
}

/** The dialog title for one attachment. */
export function previewTitle(attachment: Pick<AttachmentDisplayRow, 'name'>): string {
  return `附件预览：${attachment.name}`
}

/**
 * Give focus back to the element that opened the dialog.
 * @param trigger - the focused element captured at open, or null.
 * @returns whether focus was restored.
 */
export function restoreFocus(trigger: { focus(): void } | null): boolean {
  if (trigger === null) return false
  trigger.focus()
  return true
}
