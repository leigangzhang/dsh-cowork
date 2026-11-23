/**
 * Pure comment-anchor rules.
 *
 * A text anchor stores a 1-based line range plus the quoted lines and one line
 * of context on each side; those facts are what let the host relocate the
 * thread after an edit. Validation runs at the wire boundary, and
 * {@link deriveLineAnchor} fills the quote/context from the file the server
 * actually read instead of trusting the browser's copy.
 */
import {
  MAX_ARTIFACT_QUOTE_CHARS,
  isAnchorKind,
  type ArtifactAnchor,
  type ArtifactRegion,
} from '../../panel/artifact-contract.js'
import { normalizeArtifactPath } from './paths.js'

/** Outcome of validating one anchor. */
export type AnchorCheck =
  | { readonly ok: true; readonly anchor: ArtifactAnchor }
  | { readonly ok: false; readonly reason: string }

/** A plain object (not an array, not null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A positive integer line number. */
function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

/** A non-negative integer. */
function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** A finite number. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Cut a string to the quote cap without splitting a surrogate pair. */
export function boundQuote(text: string): string {
  const points = Array.from(text)
  return points.length <= MAX_ARTIFACT_QUOTE_CHARS ? text : points.slice(0, MAX_ARTIFACT_QUOTE_CHARS).join('')
}

/** A normalized rectangle: finite, non-negative origin, positive size. */
function parseRegion(value: unknown): ArtifactRegion | null {
  if (!isRecord(value)) return null
  const { x, y, width, height } = value
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return null
  if (x < 0 || y < 0 || width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

/** An optional non-empty string, or null when the field is absent or invalid. */
function optionalName(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * Validate one anchor object from the wire and normalize its path.
 *
 * The path check is lexical only; the route separately proves the path is one
 * of the work item's registered files. Unknown extra fields are ignored.
 */
export function parseArtifactAnchor(value: unknown): AnchorCheck {
  if (!isRecord(value)) return { ok: false, reason: 'anchor must be an object' }
  const kind = value.kind
  if (!isAnchorKind(kind)) return { ok: false, reason: 'anchor.kind is unknown' }
  const pathCheck = normalizeArtifactPath(value.path)
  if (!pathCheck.ok) return { ok: false, reason: `anchor.path: ${pathCheck.reason}` }
  const path = pathCheck.path
  switch (kind) {
    case 'line-range': {
      const { startLine, endLine } = value
      if (!isPositiveInt(startLine) || !isPositiveInt(endLine)) {
        return { ok: false, reason: 'line-range anchor needs positive startLine and endLine' }
      }
      if (endLine < startLine) return { ok: false, reason: 'line-range anchor endLine is before startLine' }
      const quote = typeof value.quote === 'string' ? boundQuote(value.quote) : ''
      // The sub-line selection is display data. An empty or non-string value
      // degrades to "no selection" instead of rejecting the whole anchor.
      const selectedText = typeof value.selectedText === 'string' && value.selectedText.trim() !== ''
        ? boundQuote(value.selectedText)
        : null
      const anchor: Extract<ArtifactAnchor, { kind: 'line-range' }> = {
        kind,
        path,
        startLine,
        endLine,
        quote,
        ...(typeof value.contextBefore === 'string' ? { contextBefore: boundQuote(value.contextBefore) } : {}),
        ...(typeof value.contextAfter === 'string' ? { contextAfter: boundQuote(value.contextAfter) } : {}),
        ...(selectedText === null ? {} : { selectedText }),
      }
      return { ok: true, anchor }
    }
    case 'block': {
      if (typeof value.quote !== 'string' || value.quote.trim() === '') {
        return { ok: false, reason: 'block anchor needs a quote' }
      }
      const blockId = optionalName(value.blockId)
      return {
        ok: true,
        anchor: { kind, path, quote: boundQuote(value.quote), ...(blockId === null ? {} : { blockId }) },
      }
    }
    case 'diagram-node': {
      const nodeId = optionalName(value.nodeId)
      const line = isPositiveInt(value.line) ? value.line : null
      if (nodeId === null && line === null) {
        return { ok: false, reason: 'diagram-node anchor needs nodeId or line' }
      }
      return {
        ok: true,
        anchor: {
          kind,
          path,
          ...(nodeId === null ? {} : { nodeId }),
          ...(line === null ? {} : { line }),
        },
      }
    }
    case 'table-cell': {
      if (!isNonNegativeInt(value.row) || !isNonNegativeInt(value.column)) {
        return { ok: false, reason: 'table-cell anchor needs non-negative row and column' }
      }
      return { ok: true, anchor: { kind, path, row: value.row, column: value.column } }
    }
    case 'canvas-element': {
      const elementId = optionalName(value.elementId)
      const region = value.region === undefined ? null : parseRegion(value.region)
      if (elementId === null && region === null) {
        return { ok: false, reason: 'canvas-element anchor needs elementId or region' }
      }
      return {
        ok: true,
        anchor: {
          kind,
          path,
          ...(elementId === null ? {} : { elementId }),
          ...(region === null ? {} : { region }),
        },
      }
    }
    case 'page': {
      if (!isPositiveInt(value.page)) return { ok: false, reason: 'page anchor needs a positive page' }
      return { ok: true, anchor: { kind, path, page: value.page } }
    }
    case 'region': {
      const region = parseRegion(value.region)
      if (region === null) return { ok: false, reason: 'region anchor needs a positive region rectangle' }
      if (value.page !== undefined && !isPositiveInt(value.page)) {
        return { ok: false, reason: 'region anchor page must be a positive integer' }
      }
      return {
        ok: true,
        anchor: { kind, path, ...(value.page === undefined ? {} : { page: value.page }), region },
      }
    }
    case 'whole':
      return { ok: true, anchor: { kind, path } }
  }
}

/** Content split into display lines; a trailing newline is not an extra line. */
export function contentLines(content: string): string[] {
  const lines = content.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Outcome of deriving a line anchor from a file body. */
export type LineAnchorResult =
  | { readonly ok: true; readonly anchor: Extract<ArtifactAnchor, { kind: 'line-range' }> }
  | { readonly ok: false; readonly reason: string }

/**
 * Build a line-range anchor from the file's current text.
 *
 * The range must fall inside the file. The quote and the one line of context on
 * each side come from this text, not from the browser, so a stale client cannot
 * pin a thread to unrelated lines.
 */
export function deriveLineAnchor(
  content: string,
  path: string,
  startLine: number,
  endLine: number,
): LineAnchorResult {
  const lines = contentLines(content)
  if (!isPositiveInt(startLine) || !isPositiveInt(endLine) || endLine < startLine) {
    return { ok: false, reason: 'line range must be a positive, ordered range' }
  }
  if (startLine > lines.length) {
    return { ok: false, reason: `line ${startLine} is outside the file (${lines.length} lines)` }
  }
  const lastLine = Math.min(endLine, lines.length)
  const before = startLine > 1 ? lines[startLine - 2] : undefined
  const after = lastLine < lines.length ? lines[lastLine] : undefined
  return {
    ok: true,
    anchor: {
      kind: 'line-range',
      path,
      startLine,
      endLine: lastLine,
      quote: boundQuote(lines.slice(startLine - 1, lastLine).join('\n')),
      ...(before === undefined ? {} : { contextBefore: boundQuote(before) }),
      ...(after === undefined ? {} : { contextAfter: boundQuote(after) }),
    },
  }
}

/** Outcome of relocating one thread after a file edit. */
export interface AnchorRelocation {
  readonly status: 'unchanged' | 'moved' | 'stale'
  readonly anchor: ArtifactAnchor
}

/** One candidate occurrence of the quoted lines in the new content. */
interface QuoteCandidate {
  readonly start: number
  readonly end: number
  readonly contextBefore: boolean
  readonly contextAfter: boolean
}

/**
 * Re-anchor a line-range comment after its file changed.
 *
 * The quote is the primary key: it is searched first within 20 lines of the old
 * position, then in the whole file. One line of stored context on each side
 * breaks ties. A quote found in several equally good places is reported
 * `stale` rather than guessed, and an unchanged position needs no new event.
 */
export function relocateLineAnchor(content: string, anchor: ArtifactAnchor): AnchorRelocation {
  if (anchor.kind !== 'line-range') return { status: 'unchanged', anchor }
  const lines = contentLines(content)
  const quoteLines = anchor.quote === '' ? [] : anchor.quote.split('\n')
  if (quoteLines.length === 0) return { status: 'stale', anchor }
  const candidates: QuoteCandidate[] = []
  for (let start = 0; start + quoteLines.length <= lines.length; start += 1) {
    let matches = true
    for (let offset = 0; offset < quoteLines.length; offset += 1) {
      if (lines[start + offset] !== quoteLines[offset]) {
        matches = false
        break
      }
    }
    if (!matches) continue
    candidates.push({
      start: start + 1,
      end: start + quoteLines.length,
      contextBefore: anchor.contextBefore !== undefined && start > 0 && lines[start - 1] === anchor.contextBefore,
      contextAfter: anchor.contextAfter !== undefined
        && start + quoteLines.length < lines.length
        && lines[start + quoteLines.length] === anchor.contextAfter,
    })
  }
  if (candidates.length === 0) return { status: 'stale', anchor }
  const near = candidates.filter((candidate) => Math.abs(candidate.start - anchor.startLine) <= 20)
  const pool = near.length > 0 ? near : candidates
  const contextScore = (candidate: QuoteCandidate): number =>
    (candidate.contextBefore ? 1 : 0) + (candidate.contextAfter ? 1 : 0)
  const best = Math.max(...pool.map(contextScore))
  const winners = pool.filter((candidate) => contextScore(candidate) === best)
  if (winners.length !== 1) return { status: 'stale', anchor }
  const winner = winners[0]!
  const derived = deriveLineAnchor(content, anchor.path, winner.start, winner.end)
  if (!derived.ok) return { status: 'stale', anchor }
  // A stored anchor may omit context (older comments or a client that only
  // sent lines); an absent context cannot prove the thread moved. Only a
  // present, different context counts as evidence of a relocation.
  const sameContext = (stored: string | undefined, current: string | undefined): boolean =>
    stored === undefined || stored === current
  const unchanged = derived.anchor.startLine === anchor.startLine
    && derived.anchor.endLine === anchor.endLine
    && derived.anchor.quote === anchor.quote
    && sameContext(anchor.contextBefore, derived.anchor.contextBefore)
    && sameContext(anchor.contextAfter, derived.anchor.contextAfter)
  // The derived anchor addresses the new lines; the stored sub-line selection
  // is display data about the same quote, so a move keeps it.
  const relocated: ArtifactAnchor = anchor.selectedText === undefined
    ? derived.anchor
    : { ...derived.anchor, selectedText: anchor.selectedText }
  return { status: unchanged ? 'unchanged' : 'moved', anchor: relocated }
}
