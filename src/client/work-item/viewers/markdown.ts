/**
 * Pure Markdown reading model for the work-item viewer.
 *
 * The reading surface renders `markdown-it` tokens as React elements; this
 * module owns everything that can be decided without the DOM: frontmatter
 * splitting, the block index derived from token maps, selection-to-line-range
 * mapping, the URL allowlists, task-marker decoding, and the large-file
 * fallback. React-free on purpose so `node --test` covers it with the
 * line-preserving TypeScript loader.
 *
 * The stored source text stays the only address space: blocks, pins, and line
 * ranges are presentations of 1-based source lines, never a second model.
 */
import MarkdownIt, { type Token } from 'markdown-it'
import {
  MAX_ARTIFACT_TEXT_LINES,
  type ArtifactAnchor,
} from '../../../panel/artifact-contract.js'
import type { LineSelection } from '../model.ts'

/** The block kinds the reading surface can address. */
const MARKDOWN_BLOCK_KINDS = [
  'heading',
  'paragraph',
  'list',
  'item',
  'quote',
  'fence',
  'table',
  'hr',
  'frontmatter',
] as const

/** One addressable block kind. */
export type MarkdownBlockKind = (typeof MARKDOWN_BLOCK_KINDS)[number]

/** One block of the reading surface, in 1-based source lines. */
export interface MarkdownBlock {
  readonly startLine: number
  /** Inclusive. */
  readonly endLine: number
  readonly kind: MarkdownBlockKind
}

/** Frontmatter display text plus the body offset its token maps need. */
export interface FrontmatterSplit {
  /** YAML text between the fences; null when the file has no frontmatter. */
  readonly frontmatter: string | null
  readonly body: string
  /** 1-based source line of the body's first line. */
  readonly bodyStartLine: number
}

/** One thread pin attached to a block, with the block-local thread facts. */
export interface BlockPin {
  /** Ordinal of the earliest thread anchored in the block. */
  readonly ordinal: number
  /** Threads anchored in the block; the rest are reachable from the rail. */
  readonly count: number
  readonly tone: 'open' | 'stale' | 'resolved'
  /** Source range of the earliest thread, for the pin's tooltip. */
  readonly startLine: number
  readonly endLine: number
}

/** The thread facts block pins need; the rail's fold satisfies this shape. */
export interface PinThread {
  readonly anchor: ArtifactAnchor | null
  readonly resolved: boolean
  readonly anchorStatus: 'moved' | 'stale' | null
}

/** Link schemes the reading surface renders as an anchor. */
const LINK_SCHEMES = ['http:', 'https:']

/** Image sources the reading surface may build an `<img>` for. */
const IMAGE_SRC_SCHEMES = ['http', 'https', 'cowork-attachment', 'relative'] as const

/** One accepted image location family. */
export type ImageScheme = (typeof IMAGE_SRC_SCHEMES)[number]

/** Bytes above which the reading surface degrades to the source lines. */
export const MARKDOWN_READ_MAX_BYTES = 2 * 1024 * 1024

/** The shared parser: raw HTML stays literal, bare URLs become links. */
const MARKDOWN = new MarkdownIt({ html: false, linkify: true, breaks: false })

const TEXT_ENCODER = new TextEncoder()

/** Token types that open a container or stand alone as a block. */
const BLOCK_TOKEN_KINDS: Readonly<Record<string, MarkdownBlockKind>> = {
  heading_open: 'heading',
  paragraph_open: 'paragraph',
  bullet_list_open: 'list',
  ordered_list_open: 'list',
  list_item_open: 'item',
  blockquote_open: 'quote',
  fence: 'fence',
  code_block: 'fence',
  table_open: 'table',
  hr: 'hr',
}

/**
 * Split optional frontmatter from the Markdown body.
 *
 * Only a leading `---` line with a later closing `---` counts; YAML is not
 * parsed, so a malformed header still displays as text. Without a closing
 * fence the whole file is body, which keeps a stray thematic break readable.
 * @param content - complete stored file text.
 * @returns the YAML text (without fences), body text, and body line offset.
 */
export function splitFrontmatter(content: string): FrontmatterSplit {
  const lines = content.split('\n')
  if (lines[0]?.trim() !== '---') return { frontmatter: null, body: content, bodyStartLine: 1 }
  let close = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === '---') {
      close = index
      break
    }
  }
  if (close === -1) return { frontmatter: null, body: content, bodyStartLine: 1 }
  return {
    frontmatter: lines.slice(1, close).join('\n'),
    body: lines.slice(close + 1).join('\n'),
    bodyStartLine: close + 2,
  }
}

/**
 * Parse one Markdown body into block tokens.
 * @param body - body text (frontmatter already removed).
 * @returns the parser's token list; inline children carry the text tokens.
 */
export function tokenizeMarkdown(body: string): readonly Token[] {
  return MARKDOWN.parse(body, {})
}

/**
 * Read the block one token addresses.
 *
 * Only tokens whose `map` is populated have a source range; table cells and
 * inline children return null and stay unaddressable.
 * @param token - one parser token.
 * @param bodyStartLine - 1-based source line of the body's first line.
 * @returns the block in 1-based inclusive source lines, or null.
 */
export function blockOfToken(token: Token, bodyStartLine = 1): MarkdownBlock | null {
  const kind = BLOCK_TOKEN_KINDS[token.type]
  if (kind === undefined || token.map === null) return null
  return {
    startLine: token.map[0] + bodyStartLine,
    endLine: token.map[1] + bodyStartLine - 1,
    kind,
  }
}

/**
 * Read the block index out of a token list.
 *
 * The frontmatter is one leading block so a pin never lands inside it.
 * @param tokens - tokens from {@link tokenizeMarkdown}.
 * @param bodyStartLine - 1-based source line of the body's first line.
 * @returns blocks in token order, with 1-based inclusive source ranges.
 */
function blocksFromTokens(tokens: readonly Token[], bodyStartLine: number): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  if (bodyStartLine > 1) blocks.push({ startLine: 1, endLine: bodyStartLine - 1, kind: 'frontmatter' })
  for (const token of tokens) {
    const block = blockOfToken(token, bodyStartLine)
    if (block !== null) blocks.push(block)
  }
  return blocks
}

/**
 * Derive the block index for one body.
 * @param content - body text (frontmatter already removed).
 * @param bodyStartLine - 1-based source line of the body's first line.
 * @returns the blocks in token order.
 */
export function parseMarkdownBlocks(content: string, bodyStartLine = 1): MarkdownBlock[] {
  return blocksFromTokens(tokenizeMarkdown(content), bodyStartLine)
}

/** The number of source lines one block spans. */
function blockSpan(block: MarkdownBlock): number {
  return block.endLine - block.startLine
}

/**
 * Find the deepest block containing one source line.
 *
 * Depth is the smallest containing range; equal ranges keep the later token
 * (a list item's paragraph sits inside the item). This is the one mapping pin
 * placement and anchor highlighting use.
 * @param blocks - block index in token order.
 * @param line - 1-based source line.
 * @returns the containing block, or null outside every block.
 */
export function blockAtLine(blocks: readonly MarkdownBlock[], line: number): MarkdownBlock | null {
  let best: MarkdownBlock | null = null
  for (const block of blocks) {
    if (line < block.startLine || line > block.endLine) continue
    const better = best === null
      || block.startLine > best.startLine
      || (block.startLine === best.startLine && blockSpan(block) <= blockSpan(best))
    if (better) best = block
  }
  return best
}

/** The stable key one block uses in the pin map and DOM attributes. */
export function blockKey(block: MarkdownBlock): string {
  return `${block.kind}:${String(block.startLine)}:${String(block.endLine)}`
}

/**
 * Group line-range threads into the block-level pins the reading surface shows.
 *
 * Threads arrive in rail order, so the first thread seen in a block is its
 * lowest ordinal. Frontmatter is not annotatable and never gets a pin.
 * @param blocks - block index in token order.
 * @param threads - folded threads in rail order (ordinals are 1-based indexes).
 * @returns one pin per rendered block, keyed by {@link blockKey}.
 */
export function blockPins(
  blocks: readonly MarkdownBlock[],
  threads: readonly PinThread[],
): ReadonlyMap<string, BlockPin> {
  const pins = new Map<string, BlockPin>()
  threads.forEach((thread, index) => {
    const anchor = thread.anchor
    if (anchor === null || anchor.kind !== 'line-range') return
    const block = blockAtLine(blocks, anchor.startLine)
    if (block === null || block.kind === 'frontmatter') return
    const key = blockKey(block)
    const existing = pins.get(key)
    if (existing !== undefined) {
      pins.set(key, { ...existing, count: existing.count + 1 })
      return
    }
    pins.set(key, {
      ordinal: index + 1,
      count: 1,
      tone: thread.resolved ? 'resolved' : (thread.anchorStatus === 'stale' ? 'stale' : 'open'),
      startLine: anchor.startLine,
      endLine: anchor.endLine,
    })
  })
  return pins
}

/** Rewrite `[text](url)` and `![alt](url)` to their visible text. */
function stripLinks(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
}

/** Drop the inline Markdown markers a rendered sentence no longer shows. */
function stripInlineMarkers(text: string): string {
  return stripLinks(text)
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
}

/** Drop the block prefix a rendered block no longer shows. */
function stripBlockPrefix(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^(?:\s{0,3}>\s?)+/, '')
    .replace(/^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/, '')
    .replace(/^\s{0,3}\[[ xX]\]\s+/, '')
    .replace(/^\s{0,3}(?:---+|\*\*\*+|___+)\s*$/, '')
}

/** The visible text of one source line inside a block. */
function visibleLine(line: string): string {
  return stripInlineMarkers(stripBlockPrefix(line))
}

/** Collapse every whitespace run to one space and trim. */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** A block's visible text with a source-line index for every character. */
interface MappedText {
  readonly text: string
  /** `lines[index]` is the 0-based offset inside the block for the character. */
  readonly lines: readonly number[]
}

/** Build the normalized visible text and its per-character line mapping. */
function mappedText(lines: readonly string[], block: MarkdownBlock): MappedText {
  const chars: string[] = []
  const lineOf: number[] = []
  const push = (char: string, line: number): void => {
    if (char === ' ' && chars[chars.length - 1] === ' ') return
    chars.push(char)
    lineOf.push(line)
  }
  const blockLines = lines.slice(block.startLine - 1, block.endLine)
  blockLines.forEach((line, index) => {
    if (index > 0) push(' ', index - 1)
    for (const char of visibleLine(line)) push(/\s/.test(char) ? ' ' : char, index)
  })
  let start = 0
  while (start < chars.length && chars[start] === ' ') start += 1
  let end = chars.length - 1
  while (end >= 0 && chars[end] === ' ') end -= 1
  if (start > end) return { text: '', lines: [] }
  return { text: chars.slice(start, end + 1).join(''), lines: lineOf.slice(start, end + 1) }
}

/** The unique occurrence of one needle, or null when absent or ambiguous. */
function uniqueOccurrence(haystack: string, needle: string): number | null {
  const first = haystack.indexOf(needle)
  if (first === -1) return null
  return haystack.indexOf(needle, first + 1) === -1 ? first : null
}

/**
 * Map a selection to the source lines its anchor should carry.
 *
 * Cross-block selections fall back to the union of both block ranges. Inside
 * one block the visible text is searched for the normalized selection; only a
 * unique hit refines to exact lines. A repeated, absent, or partially marked
 * hit keeps the whole block range, because a wrong narrow range is worse than
 * a wide one: the server derives the quote from the range it receives.
 * @param blocks - block index in token order.
 * @param lines - complete source lines.
 * @param startBlock - block (or container) the selection starts in.
 * @param endBlock - block the selection ends in.
 * @param selectedText - the browser's selected text; may span lines.
 * @returns one 1-based inclusive line range inside the source.
 */
export function lineRangeForSelection(
  blocks: readonly MarkdownBlock[],
  lines: readonly string[],
  startBlock: MarkdownBlock,
  endBlock: MarkdownBlock,
  selectedText: string,
): LineSelection {
  // DOM endpoints are leaves already; resolving them again keeps container
  // callers honest (the start endpoint is its first line, the end its last).
  const start = blockAtLine(blocks, startBlock.startLine) ?? startBlock
  const end = blockAtLine(blocks, endBlock.endLine) ?? endBlock
  if (start.kind !== end.kind || start.startLine !== end.startLine || start.endLine !== end.endLine) {
    return { startLine: start.startLine, endLine: end.endLine }
  }
  const mapped = mappedText(lines, start)
  const needle = normalizeWhitespace(selectedText)
  if (needle === '') return { startLine: start.startLine, endLine: start.endLine }
  const at = uniqueOccurrence(mapped.text, needle)
  if (at === null) return { startLine: start.startLine, endLine: start.endLine }
  const firstLine = mapped.lines[at]
  const lastLine = mapped.lines[at + needle.length - 1]
  return {
    startLine: Math.min(start.startLine + firstLine, start.endLine),
    endLine: Math.min(start.startLine + lastLine, start.endLine),
  }
}

/**
 * Validate one link target for the reading surface.
 *
 * Only absolute `http(s)` links are clickable; relative paths, anchors, and
 * script-capable schemes stay visible text instead of becoming a navigation
 * target.
 * @param href - the token's `href` attribute.
 * @returns the href when it is an absolute http(s) URL, otherwise null.
 */
export function sanitizeLinkHref(href: string): string | null {
  const value = href.trim()
  if (value === '' || /[\u0000-\u001f\u007f]/.test(value)) return null
  if (!/^https?:\/\//i.test(value)) return null
  try {
    const url = new URL(value)
    return LINK_SCHEMES.includes(url.protocol) ? value : null
  } catch {
    return null
  }
}

/**
 * Validate one image source before an `<img>` is created.
 *
 * `markdown-it` accepts `data:image` by default; this allowlist replaces that
 * judgement: only `http(s)`, `cowork-attachment://<id>`, and project-relative
 * paths can produce an image. Absolute paths, `..` escapes, backslashes,
 * control characters, and every other scheme are refused.
 * @param src - the image token's `src` attribute.
 * @param allow - accepted location families, defaulting to all four.
 * @returns the source to render, or null when it is not allowed.
 */
export function sanitizeImageSrc(
  src: string,
  allow: readonly ImageScheme[] = IMAGE_SRC_SCHEMES,
): string | null {
  const value = src.trim()
  if (value === '' || /[\u0000-\u001f\u007f\\]/.test(value) || /\s/.test(value)) return null
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)
  if (scheme !== null) {
    const name = scheme[1]!.toLowerCase()
    if (name === 'http' || name === 'https') {
      if (!allow.includes(name)) return null
      try {
        const url = new URL(value)
        return url.protocol === `${name}:` ? value : null
      } catch {
        return null
      }
    }
    if (name === 'cowork-attachment') {
      if (!allow.includes('cowork-attachment')) return null
      return /^cowork-attachment:\/\/[A-Za-z0-9_-]+$/.test(value) ? value : null
    }
    return null
  }
  if (value.startsWith('//') || value.startsWith('/')) return null
  if (value.split('/').includes('..')) return null
  return allow.includes('relative') ? value : null
}

/**
 * Decode one task-list marker from a list item's first text token.
 * @param text - the item's leading text content.
 * @returns the checked flag and remaining text, or null when it is not a task.
 */
export function renderTaskMarker(text: string): { checked: boolean; text: string } | null {
  const match = /^\[([ xX])\](?:\s+([\s\S]*))?$/.exec(text)
  if (match === null) return null
  return { checked: match[1] !== ' ', text: match[2] ?? '' }
}

/**
 * Pick one table-cell alignment from a token's attributes.
 *
 * Only the three literal values the parser emits are accepted; any other
 * value (including an injected style string) degrades to left alignment.
 * @param attrs - the token's attributes.
 * @returns the alignment the cell renders with.
 */
export function tableAlignment(
  attrs: readonly (readonly [string, string | number])[] | null,
): 'left' | 'center' | 'right' {
  const style = attrs?.find(([name]) => name === 'style')?.[1]
  const text = style === undefined ? '' : String(style)
  const match = /^text-align:(left|center|right)$/.exec(text.trim())
  if (match === null || match[1] === undefined) return 'left'
  return match[1] as 'left' | 'center' | 'right'
}

/**
 * Decide whether a file is too large to render as flow content.
 *
 * The threshold protects the DOM from unbounded node counts; the viewer then
 * shows the numbered source lines and keeps the editor reachable.
 * @param content - complete stored file text.
 * @returns the user-facing reason to degrade, or null when readable.
 */
export function readFallbackReason(content: string): string | null {
  if (TEXT_ENCODER.encode(content).byteLength > MARKDOWN_READ_MAX_BYTES) {
    return '文件超过 2 MB，已切换为源码视图'
  }
  if (content.split('\n').length > MAX_ARTIFACT_TEXT_LINES) {
    return `文件超过 ${String(MAX_ARTIFACT_TEXT_LINES)} 行，已切换为源码视图`
  }
  return null
}
