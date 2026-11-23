/**
 * Pure geometry and persistence rules for the comment rail and its annotate
 * entry.
 *
 * The rail width clamps against the viewer body so the document keeps a
 * readable column; the floating annotate entry sits 8px below (or above, when
 * the viewport has no room) the selection and stays inside the content box. The
 * browser lane owns pointer/keyboard event wiring; every number and branch a
 * test can assert lives here.
 */
import { MAX_ARTIFACT_QUOTE_CHARS } from '../../panel/artifact-contract.js'

/** Narrowest rail width, also the floor when the container is too narrow. */
export const RAIL_WIDTH_MIN = 280

/** Widest rail width. */
export const RAIL_WIDTH_MAX = 560

/** Width a first-time viewer starts with. */
const RAIL_WIDTH_DEFAULT = 336

/** One arrow-key (or grip nudge) step. */
export const RAIL_WIDTH_STEP = 8

/** Document columns the rail may not take away when it can avoid it. */
export const RAIL_CONTENT_MIN = 360

/** localStorage key holding the last chosen width. */
const RAIL_WIDTH_STORAGE_KEY = 'cowork.work-item.railWidth'

/** Gap between the selection edge and the floating entry. */
const ANNOTATE_POP_GAP = 8

/** Nominal floating-entry box used to clamp it inside its bounds. */
const ANNOTATE_POP_WIDTH = 232

/** Nominal floating-entry height used to clamp it inside its bounds. */
const ANNOTATE_POP_HEIGHT = 36

/** A viewport/content rectangle; every coordinate is a viewport pixel. */
export interface PopRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** The floating entry's fixed-position coordinates. */
export interface PopPosition {
  readonly left: number
  readonly top: number
}

/** The two storage methods the rail width uses. */
export interface RailWidthStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** A finite number, or the fallback when the input is not one. */
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

/**
 * Clamp one rail width to the container.
 *
 * The upper bound is `min(560, containerWidth − 360)` so the document keeps
 * {@link RAIL_CONTENT_MIN} readable pixels; a container narrower than both
 * minimums cannot satisfy that, and the rail then keeps its 280px floor.
 * @param width - requested width in pixels; non-finite values use the default.
 * @param containerWidth - viewer body width in pixels; non-positive values
 * clamp only to the fixed range (first paint, before measurement).
 * @returns the integer width the rail may take.
 */
export function railWidthClamp(width: number, containerWidth: number): number {
  const requested = finiteOr(width, RAIL_WIDTH_DEFAULT)
  const fixed = Math.min(Math.max(requested, RAIL_WIDTH_MIN), RAIL_WIDTH_MAX)
  const measured = finiteOr(containerWidth, 0)
  if (measured <= 0) return Math.round(fixed)
  const upper = Math.max(RAIL_WIDTH_MIN, Math.min(RAIL_WIDTH_MAX, measured - RAIL_CONTENT_MIN))
  return Math.round(Math.min(Math.max(requested, RAIL_WIDTH_MIN), upper))
}

/**
 * One arrow-key width adjustment on the left-edge grip.
 *
 * Left widens the rail (the grip moves left) and right narrows it, matching
 * the pointer direction on a vertical separator.
 * @param current - current width in pixels.
 * @param key - `ArrowLeft` or `ArrowRight`.
 * @param containerWidth - viewer body width in pixels.
 * @returns the clamped next width.
 */
export function railWidthAfterKey(
  current: number,
  key: 'ArrowLeft' | 'ArrowRight',
  containerWidth: number,
): number {
  const delta = key === 'ArrowLeft' ? RAIL_WIDTH_STEP : -RAIL_WIDTH_STEP
  return railWidthClamp(current + delta, containerWidth)
}

/**
 * Parse the persisted rail width.
 * @param raw - the stored string, or null when nothing was stored.
 * @returns the stored width clamped to the fixed range, or the default when
 * the value is absent or not a number.
 */
function railWidthFromStorage(raw: string | null): number {
  if (raw === null) return RAIL_WIDTH_DEFAULT
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value)) return RAIL_WIDTH_DEFAULT
  return Math.round(Math.min(Math.max(value, RAIL_WIDTH_MIN), RAIL_WIDTH_MAX))
}

/**
 * Read the persisted width; a blocked storage (privacy mode) is a default, not
 * a failure that hides the rail.
 * @param storage - the storage to read, or null when unavailable.
 * @param key - storage key; defaults to {@link RAIL_WIDTH_STORAGE_KEY}.
 * @returns the width to start from.
 */
export function readRailWidth(storage: RailWidthStorage | null, key = RAIL_WIDTH_STORAGE_KEY): number {
  if (storage === null) return RAIL_WIDTH_DEFAULT
  try {
    return railWidthFromStorage(storage.getItem(key))
  } catch {
    return RAIL_WIDTH_DEFAULT
  }
}

/**
 * Persist one rail width; storage failures never block resizing.
 * @param storage - the storage to write, or null when unavailable.
 * @param width - the width to remember.
 * @param key - storage key; defaults to {@link RAIL_WIDTH_STORAGE_KEY}.
 */
export function saveRailWidth(storage: RailWidthStorage | null, width: number, key = RAIL_WIDTH_STORAGE_KEY): void {
  if (storage === null) return
  try {
    storage.setItem(key, String(Math.round(width)))
  } catch {
    // A full or blocked storage leaves the current width in memory only.
  }
}

/**
 * The browser's localStorage, or null when the host blocks it.
 * @returns a storage the width hook can use, or null outside a browser.
 */
export function browserRailStorage(): RailWidthStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/**
 * Intersect two rectangles.
 * @param left - first rectangle.
 * @param right - second rectangle.
 * @returns the overlap; an empty overlap collapses to the second rectangle so
 * callers always have usable bounds.
 */
export function intersectRects(left: PopRect, right: PopRect): PopRect {
  const x = Math.max(left.left, right.left)
  const y = Math.max(left.top, right.top)
  const width = Math.min(left.left + left.width, right.left + right.width) - x
  const height = Math.min(left.top + left.height, right.top + right.height) - y
  return width <= 0 || height <= 0 ? right : { left: x, top: y, width, height }
}

/**
 * Place the floating annotate entry next to the selection.
 *
 * The entry centres on the selection's top edge, 8px below it; when the bounds
 * have no room below it moves 8px above. Either axis clamps to the bounds, so
 * the entry never covers the selected text or leaves the content box.
 * @param selection - the selection's client rectangle.
 * @param bounds - the content box or viewport the entry must stay inside.
 * @param pop - nominal entry size; defaults to the shared constants.
 * @param gap - distance from the selection edge.
 * @returns fixed-position coordinates in viewport pixels.
 */
export function annotationPopPosition(
  selection: PopRect,
  bounds: PopRect,
  pop: { readonly width: number; readonly height: number } = {
    width: ANNOTATE_POP_WIDTH,
    height: ANNOTATE_POP_HEIGHT,
  },
  gap = ANNOTATE_POP_GAP,
): PopPosition {
  const maxLeft = Math.max(bounds.left, bounds.left + bounds.width - pop.width)
  const left = Math.min(
    Math.max(selection.left + selection.width / 2 - pop.width / 2, bounds.left),
    maxLeft,
  )
  const maxTop = Math.max(bounds.top, bounds.top + bounds.height - pop.height)
  const below = selection.top + selection.height + gap
  const above = selection.top - pop.height - gap
  if (below + pop.height <= bounds.top + bounds.height) {
    return { left: Math.round(left), top: Math.round(below) }
  }
  if (above >= bounds.top) {
    return { left: Math.round(left), top: Math.round(above) }
  }
  // Neither side fits: keep the entry inside the bounds, closest to the
  // selection's bottom edge, rather than dropping it off-screen.
  return { left: Math.round(left), top: Math.round(Math.min(Math.max(below, bounds.top), maxTop)) }
}

/**
 * The user's sub-line selection, trimmed and capped like the anchor quote.
 * @param selection - a browser Selection, or null.
 * @param maxChars - code-point cap; defaults to the shared quote cap.
 * @returns the selected text, or undefined for a collapsed/blank selection.
 */
export function selectedTextOf(
  selection: { toString(): string } | null,
  maxChars = MAX_ARTIFACT_QUOTE_CHARS,
): string | undefined {
  if (selection === null) return undefined
  const text = selection.toString().trim()
  if (text === '') return undefined
  const points = Array.from(text)
  return points.length <= maxChars ? text : points.slice(0, maxChars).join('')
}

/**
 * Whether one key event is the equivalent of a context-menu request.
 * @param event - keyboard event fields the menu keys carry.
 * @returns true for the menu key (ContextMenu/Apps) and Shift+F10.
 */
export function isMenuKey(event: { readonly key: string; readonly shiftKey?: boolean }): boolean {
  if (event.key === 'ContextMenu' || event.key === 'Apps') return true
  return event.key === 'F10' && event.shiftKey === true
}

/**
 * The entry's read-only range chip: `第 3 行` or `第 3–5 行`.
 * @param startLine - 1-based first line.
 * @param endLine - 1-based last line.
 */
export function lineRangeLabel(startLine: number, endLine: number): string {
  return startLine === endLine
    ? `第 ${String(startLine)} 行`
    : `第 ${String(startLine)}–${String(endLine)} 行`
}
