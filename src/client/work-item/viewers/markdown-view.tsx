/**
 * Markdown reading surface for the work-item viewer.
 *
 * `markdown-it` tokens are rendered as React elements only: no HTML string and
 * no `innerHTML` reach the DOM. Every block carries its 1-based source range as
 * `data-src-*` attributes, which gives the viewer one address space for pins and
 * comment anchors while the reading view itself stays flow content without a
 * line-number gutter.
 *
 * A text selection inside the article opens the floating annotate entry; the
 * selection is mapped back to source lines by {@link lineRangeForSelection}, so
 * the created anchor is still a `line-range` over the stored Markdown.
 */
import { createElement, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { Token } from 'markdown-it'
import type { ArtifactAnchor } from '../../../panel/artifact-contract.js'
import { contentLines, type LineSelection, type WorkItemThread } from '../model.ts'
import {
  blockAtLine,
  blockKey,
  blockOfToken,
  blockPins,
  lineRangeForSelection,
  parseMarkdownBlocks,
  renderTaskMarker,
  sanitizeImageSrc,
  sanitizeLinkHref,
  splitFrontmatter,
  tableAlignment,
  tokenizeMarkdown,
  type BlockPin,
  type MarkdownBlock,
} from './markdown.ts'

/** Props of the Markdown reading surface. */
export interface MarkdownReadViewProps {
  /** Saved text, or the unsaved draft while the viewer is dirty. */
  readonly content: string
  /** Threads in rail order; the pin ordinals are their 1-based indexes. */
  readonly threads: readonly WorkItemThread[]
  /** Hide pins while the draft and the saved anchors disagree. */
  readonly pinsVisible: boolean
  /** Disable the floating annotate entry (dirty, conflict, or read-only). */
  readonly annotateDisabled: boolean
  /** Why annotating is unavailable, shown as the disabled button's title. */
  readonly annotateReason: string | null
  /** The selected thread's anchor; its block gets the highlight. */
  readonly selectedAnchor: ArtifactAnchor | null
  /** Source line to bring to the top after a source-to-read switch. */
  readonly focusLine: number | null
  /** Bumped on every focus request so the same line scrolls again. */
  readonly focusToken: number
  /** Resolve one sanitized image source to its final URL, or null. */
  readonly imageUrl: (src: string) => string | null
  /** Create a comment for the mapped line range. */
  readonly onAnnotate: (startLine: number, endLine: number, selectedText: string) => void
  /** Open the thread numbered by one block pin. */
  readonly onPickPin: (ordinal: number) => void
  /** Report the source line of the block at the top of the viewport. */
  readonly onViewportLine: (line: number) => void
  /** Clear the selected thread highlight. */
  readonly onClearThread: () => void
}

/** The state behind the floating annotate entry. */
interface SelectionDraft {
  readonly startBlock: MarkdownBlock
  readonly endBlock: MarkdownBlock
  readonly selectedText: string
  readonly range: LineSelection
  readonly rect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number }
}

/** Rendering state shared by every token renderer. */
interface RenderContext {
  readonly bodyStartLine: number
  readonly blocks: readonly MarkdownBlock[]
  readonly pins: ReadonlyMap<string, BlockPin>
  readonly pinsVisible: boolean
  readonly selectedKey: string | null
  readonly imageUrl: (src: string) => string | null
  readonly onPickPin: (ordinal: number) => void
}

/** How long the selection must rest before the entry appears. */
const SELECTION_DEBOUNCE_MS = 120

/** Nominal floating-entry box used to clamp it inside the viewport. */
const ENTRY_WIDTH = 232
const ENTRY_HEIGHT = 36
const ENTRY_GAP = 8

/** Pin tooltip and aria label: `第 3 行` or `第 3–5 行`. */
function lineRangeLabel(startLine: number, endLine: number): string {
  return startLine === endLine
    ? `第 ${String(startLine)} 行`
    : `第 ${String(startLine)}–${String(endLine)} 行`
}

/** Source-range attributes shared by every block element. */
function sourceAttrs(block: MarkdownBlock): Record<string, string> {
  return {
    'data-src-kind': block.kind,
    'data-src-start': String(block.startLine),
    'data-src-end': String(block.endLine),
  }
}

/** The block kinds a rendered element may claim. */
const BLOCK_KINDS = new Set(['heading', 'paragraph', 'list', 'item', 'quote', 'fence', 'table', 'hr', 'frontmatter'])

/** The block a rendered element belongs to, from its data attributes. */
// Attribute parsing is one guard over the block kind set.
// fallow-ignore-next-line complexity
function blockOfElement(element: Element): MarkdownBlock | null {
  const kind = element.getAttribute('data-src-kind')
  const start = Number(element.getAttribute('data-src-start'))
  const end = Number(element.getAttribute('data-src-end'))
  if (!BLOCK_KINDS.has(kind ?? '') || !Number.isInteger(start) || !Number.isInteger(end)) return null
  return { kind: kind as MarkdownBlock['kind'], startLine: start, endLine: end }
}

/** The closest source block at or above one selection endpoint. */
// Selection endpoints may be text nodes; this is the DOM walk.
// fallow-ignore-next-line complexity
function blockOfNode(node: Node | null): MarkdownBlock | null {
  const element = node instanceof Element ? node : node?.parentElement
  if (element === null || element === undefined) return null
  const block = element.closest('[data-src-kind]')
  return block === null ? null : blockOfElement(block)
}

/** The union rectangle of every line box the range covers. */
function selectionRect(range: Range): SelectionDraft['rect'] | null {
  const rects = Array.from(range.getClientRects())
  if (rects.length === 0) {
    const single = range.getBoundingClientRect()
    return single.width === 0 && single.height === 0 ? null : single
  }
  const left = Math.min(...rects.map(rect => rect.left))
  const top = Math.min(...rects.map(rect => rect.top))
  const right = Math.max(...rects.map(rect => rect.right))
  const bottom = Math.max(...rects.map(rect => rect.bottom))
  return { left, top, width: right - left, height: bottom - top }
}

/** The source line of the first block covering the viewport top. */
function visibleLineAt(article: HTMLElement, top: number): number | null {
  for (const element of article.querySelectorAll<HTMLElement>('[data-src-start]')) {
    if (element.getBoundingClientRect().bottom <= top) continue
    const line = Number(element.getAttribute('data-src-start'))
    return Number.isInteger(line) ? line : null
  }
  return null
}

/** The viewer's scroll container, addressed by the known test hook first. */
function scrollContainerOf(article: HTMLElement): HTMLElement | null {
  return article.closest<HTMLElement>('[data-testid="cwi-content"]') ?? scrollParent(article)
}

/** Scroll the block containing one source line to the viewer's top. */
function scrollBlockToTop(article: HTMLElement, blocks: readonly MarkdownBlock[], line: number): void {
  const block = blockAtLine(blocks, line)
  if (block === null) return
  const matches = article.querySelectorAll<HTMLElement>(
    `[data-src-kind="${block.kind}"][data-src-start="${String(block.startLine)}"][data-src-end="${String(block.endLine)}"]`,
  )
  const target = matches[matches.length - 1]
  const container = scrollContainerOf(article)
  if (target === undefined || container === null) return
  // Align through the scroll container directly: switching surfaces changes the
  // content height, and scroll anchoring would otherwise fight scrollIntoView.
  container.scrollTop += target.getBoundingClientRect().top - container.getBoundingClientRect().top
}

/** The scrollable ancestor the article sits in, if any. */
function scrollParent(element: HTMLElement): HTMLElement | null {
  let node = element.parentElement
  while (node !== null) {
    const overflow = window.getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return node
    node = node.parentElement
  }
  return null
}

/** Clamp the floating entry under the selection, flipping above when short. */
function entryPosition(rect: SelectionDraft['rect']): { left: number; top: number } {
  const center = rect.left + rect.width / 2
  const maxLeft = Math.max(ENTRY_GAP, window.innerWidth - ENTRY_WIDTH - ENTRY_GAP)
  const left = Math.min(Math.max(center - ENTRY_WIDTH / 2, ENTRY_GAP), maxLeft)
  const below = rect.top + rect.height + ENTRY_GAP
  const above = rect.top - ENTRY_HEIGHT - ENTRY_GAP
  const top = below >= ENTRY_GAP && below + ENTRY_HEIGHT <= window.innerHeight - ENTRY_GAP
    ? below
    : Math.max(ENTRY_GAP, Math.min(above, window.innerHeight - ENTRY_HEIGHT - ENTRY_GAP))
  return { left, top }
}

/** One block pin: the ordinal, its tone, and the line range tooltip. */
function PinButton({ pin, onPickPin }: {
  readonly pin: BlockPin
  readonly onPickPin: (ordinal: number) => void
}): ReactElement {
  const range = lineRangeLabel(pin.startLine, pin.endLine)
  return (
    <button
      type="button"
      className="cwi-md-pin"
      data-testid="cwi-md-pin"
      data-tone={pin.tone}
      data-ordinal={pin.ordinal}
      aria-label={`第 ${String(pin.ordinal)} 条批注，共 ${String(pin.count)} 条，${range}`}
      onClick={(event) => {
        event.stopPropagation()
        onPickPin(pin.ordinal)
      }}
    >
      <span className="cwi-md-pin-ordinal" aria-hidden="true">{pin.ordinal}</span>
      <span className="cwi-md-pin-tip" aria-hidden="true">{range}</span>
    </button>
  )
}

/** The pin of one block, or null when the block has none. */
function pinOf(block: MarkdownBlock, ctx: RenderContext): ReactElement | null {
  if (!ctx.pinsVisible) return null
  const pin = ctx.pins.get(blockKey(block))
  return pin === undefined ? null : <PinButton pin={pin} onPickPin={ctx.onPickPin} />
}

/** Class list of one block, including the selected-thread highlight. */
function blockClass(block: MarkdownBlock, ctx: RenderContext): string {
  const selected = ctx.selectedKey !== null && ctx.selectedKey === blockKey(block)
  return selected ? 'cwi-md-block cwi-md-thread-target' : 'cwi-md-block'
}

/** One clickable link; unsafe targets keep their text but lose the anchor. */
function InlineLink({ href, children }: { readonly href: string; readonly children: ReactNode[] }): ReactElement {
  const safe = sanitizeLinkHref(href)
  if (safe === null) return <span className="cwi-md-link-text">{children}</span>
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer" className="cwi-md-link">
      {children}
    </a>
  )
}

// Three display states (resolved, failed, refused) share one figure shell.
/** One Markdown image with the failure and missing-alt placeholders. */
// fallow-ignore-next-line complexity
function MarkdownImage({ src, alt, title, imageUrl }: {
  readonly src: string
  readonly alt: string
  readonly title: string | undefined
  readonly imageUrl: (src: string) => string | null
}): ReactElement {
  const [failed, setFailed] = useState(false)
  const resolved = useMemo(() => {
    const safe = sanitizeImageSrc(src)
    return safe === null ? null : imageUrl(safe)
  }, [src, imageUrl])
  useEffect(() => { setFailed(false) }, [resolved])
  if (resolved === null) {
    return (
      <figure className="cwi-md-figure" data-testid="cwi-md-image-unavailable">
        <span className="cwi-md-image-fallback">图片地址不可用</span>
      </figure>
    )
  }
  if (failed) {
    return (
      <figure className="cwi-md-figure" data-testid="cwi-md-image-failed">
        <span className="cwi-md-image-fallback">图片加载失败</span>
        <figcaption className="cwi-md-figcaption">{alt === '' ? '未提供图片说明' : alt}</figcaption>
      </figure>
    )
  }
  return (
    <figure className="cwi-md-figure">
      <img
        className="cwi-md-image"
        data-testid="cwi-md-image"
        src={resolved}
        {...(alt === '' ? {} : { alt })}
        {...(title === undefined || title === '' ? {} : { title })}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => { setFailed(true) }}
      />
      {alt === '' ? <figcaption className="cwi-md-figcaption">未提供图片说明</figcaption> : null}
    </figure>
  )
}

/** The task checkbox of one list item; it never writes the source. */
function TaskBox({ checked }: { readonly checked: boolean }): ReactElement {
  return (
    <input
      type="checkbox"
      className="cwi-md-task-box"
      data-testid="cwi-md-task"
      checked={checked}
      disabled
      readOnly
      aria-label={checked ? '已完成' : '未完成'}
    />
  )
}

// Linear token scan; the level guard is the whole contract.
/** The token index of the opener's matching close. */
// fallow-ignore-next-line complexity
function matchingClose(tokens: readonly Token[], open: number): number {
  const level = tokens[open]?.level ?? 0
  for (let index = open + 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token !== undefined && token.level === level && token.nesting === -1) return index
  }
  return tokens.length
}

/** Whether one token slice carries an inline token (the task marker's home). */
function hasInline(tokens: readonly Token[]): boolean {
  return tokens.some(token => token.type === 'inline')
}

/** The task marker of one list item, or null for an ordinary item. */
// Task items carry the marker in their first inline text token.
// fallow-ignore-next-line complexity
function taskMarkerOf(tokens: readonly Token[]): { checked: boolean; text: string } | null {
  const inline = tokens.find(token => token.type === 'inline')
  if (inline === undefined) return null
  const first = inline.children?.[0]
  if (first === undefined || first.type !== 'text') return null
  return renderTaskMarker(first.content)
}

// Inline emphasis/link/image dispatch over one token stream.
/** Render the inline children of one token. */
// fallow-ignore-next-line complexity
function renderInlineChildren(
  children: readonly Token[],
  ctx: RenderContext,
  keyPrefix: string,
  task: boolean,
): ReactNode[] {
  let pendingTask = task
  const nodes: ReactNode[] = []
  let index = 0
  while (index < children.length) {
    const token = children[index]!
    const key = `${keyPrefix}-${String(index)}`
    if (token.nesting === 1) {
      const close = matchingClose(children, index)
      const inner = renderInlineChildren(children.slice(index + 1, close), ctx, key, false)
      nodes.push(renderInlineContainer(token, inner, key))
      index = close + 1
      continue
    }
    if (token.nesting === -1) {
      index += 1
      continue
    }
    if (token.type === 'text') {
      let text = token.content
      if (pendingTask) {
        const marker = renderTaskMarker(text)
        if (marker !== null) {
          nodes.push(<TaskBox key={`${key}-task`} checked={marker.checked} />)
          text = marker.text
          pendingTask = false
        }
      }
      if (text !== '') nodes.push(text)
    } else if (token.type === 'softbreak') {
      nodes.push(' ')
    } else if (token.type === 'hardbreak') {
      nodes.push(<br key={key} />)
    } else if (token.type === 'code_inline') {
      nodes.push(<code key={key} className="cwi-md-code-inline">{token.content}</code>)
    } else if (token.type === 'image') {
      const src = token.attrGet('src')
      const altAttr = token.attrGet('alt')
      const title = token.attrGet('title')
      nodes.push(
        <MarkdownImage
          key={key}
          src={src === null ? '' : String(src)}
          alt={token.content !== '' ? token.content : (altAttr === null ? '' : String(altAttr))}
          title={title === null ? undefined : String(title)}
          imageUrl={ctx.imageUrl}
        />,
      )
    } else if (token.type === 'html_inline') {
      nodes.push(token.content)
    }
    index += 1
  }
  return nodes
}

/** One inline container token (strong, emphasis, strikethrough, link). */
// Inline wrapper dispatch over the four emphasis/link tokens.
// fallow-ignore-next-line complexity
function renderInlineContainer(token: Token, children: ReactNode[], key: string): ReactNode {
  switch (token.type) {
    case 'strong_open':
      return <strong key={key}>{children}</strong>
    case 'em_open':
      return <em key={key}>{children}</em>
    case 's_open':
      return <del key={key} className="cwi-md-del">{children}</del>
    case 'link_open': {
      const href = token.attrGet('href')
      return <InlineLink key={key} href={href === null ? '' : String(href)}>{children}</InlineLink>
    }
    default:
      return <span key={key}>{children}</span>
  }
}

/** One table-structure container; its tokens carry no source map of their own. */
const TABLE_PARTS = new Set(['thead_open', 'tbody_open', 'tr_open', 'th_open', 'td_open'])

// Table section/cell dispatch over five parser tokens.
/** Render one table-structure token; only the three parser align values pass. */
// fallow-ignore-next-line complexity
function renderTablePart(token: Token, children: ReactNode[], key: string): ReactNode {
  switch (token.type) {
    case 'thead_open':
      return <thead key={key}>{children}</thead>
    case 'tbody_open':
      return <tbody key={key}>{children}</tbody>
    case 'tr_open':
      return <tr key={key}>{children}</tr>
    case 'th_open':
      return <th key={key} scope="col" style={{ textAlign: tableAlignment(token.attrs) }}>{children}</th>
    default:
      return <td key={key} style={{ textAlign: tableAlignment(token.attrs) }}>{children}</td>
  }
}

// Block renderer dispatch over markdown-it token types.
/** Render one block container token. */
// fallow-ignore-next-line complexity
function renderContainer(
  token: Token,
  children: ReactNode[],
  ctx: RenderContext,
  key: string,
  slice: readonly Token[],
): ReactNode {
  if (TABLE_PARTS.has(token.type)) return renderTablePart(token, children, key)
  const block = blockOfToken(token, ctx.bodyStartLine)
  if (block === null) return <span key={key}>{children}</span>
  const pin = pinOf(block, ctx)
  const className = blockClass(block, ctx)
  const props = { ...sourceAttrs(block), className, 'data-testid': 'cwi-md-block' }
  switch (token.type) {
    case 'heading_open':
      return createElement(token.tag, { key, ...props }, pin, ...children)
    case 'paragraph_open':
      return <p key={key} {...props}>{pin}{children}</p>
    case 'bullet_list_open':
      return <ul key={key} {...props}>{pin}{children}</ul>
    case 'ordered_list_open': {
      const start = Number(token.attrGet('start'))
      return (
        <ol key={key} {...props} {...(Number.isInteger(start) && start > 1 ? { start } : {})}>
          {pin}{children}
        </ol>
      )
    }
    case 'list_item_open': {
      const task = taskMarkerOf(slice)
      return (
        <li
          key={key}
          {...props}
          className={task === null ? className : `${className} cwi-md-task`}
          data-task={task === null ? undefined : 'true'}
        >
          {pin}{children}
        </li>
      )
    }
    case 'blockquote_open':
      return <blockquote key={key} {...props}>{pin}{children}</blockquote>
    case 'table_open':
      // The outer block owns the pin; the inner scroller owns overflow, so a
      // pin is never clipped by the table's own scroll container.
      return (
        <div key={key} {...props} className={`${className} cwi-md-table-block`}>
          <div className="cwi-md-table-wrap">
            <table className="cwi-md-table">{children}</table>
          </div>
          {pin}
        </div>
      )
    default:
      return <div key={key}>{children}</div>
  }
}

// Leaf renderer dispatch over code, rule, and raw-HTML tokens.
/** Render one leaf token. */
// fallow-ignore-next-line complexity
function renderLeaf(token: Token, ctx: RenderContext, key: string, task: boolean): ReactNode {
  if (token.type === 'inline') {
    return <span key={key}>{renderInlineChildren(token.children ?? [], ctx, key, task)}</span>
  }
  const block = blockOfToken(token, ctx.bodyStartLine)
  if (block === null) {
    return token.content === '' ? null : <span key={key}>{token.content}</span>
  }
  const pin = pinOf(block, ctx)
  const className = blockClass(block, ctx)
  if (token.type === 'fence' || token.type === 'code_block') {
    const info = token.info.trim().split(/\s+/)[0] ?? ''
    const language = /^[A-Za-z0-9_+-]+$/.test(info) ? info : ''
    return (
      <div
        key={key}
        {...sourceAttrs(block)}
        className={`${className} cwi-md-fence`}
        data-testid="cwi-md-block"
      >
        <pre className="cwi-md-pre"><code className={language === '' ? undefined : `language-${language}`}>{token.content}</code></pre>
        {pin}
      </div>
    )
  }
  if (token.type === 'hr') {
    return (
      <div key={key} {...sourceAttrs(block)} className={`${className} cwi-md-hr`} data-testid="cwi-md-block">
        <hr />
        {pin}
      </div>
    )
  }
  return token.content === '' ? null : (
    <pre key={key} {...sourceAttrs(block)} className={`${className} cwi-md-html-block`} data-testid="cwi-md-block">
      {token.content}
    </pre>
  )
}

// Token cursor with container/leaf handling and the task-marker handoff.
/** Render a token list, propagating a pending task marker into the first inline. */
// fallow-ignore-next-line complexity
function renderTokenList(
  tokens: readonly Token[],
  ctx: RenderContext,
  keyPrefix: string,
  task: boolean,
): ReactNode[] {
  const nodes: ReactNode[] = []
  let pendingTask = task
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    const key = `${keyPrefix}-${String(index)}`
    if (token.nesting === 1) {
      const close = matchingClose(tokens, index)
      const slice = tokens.slice(index + 1, close)
      // A task marker starts at its own list item; the inherited flag only
      // carries it through the item's paragraph into the first inline token.
      const itemTask = token.type === 'list_item_open' && taskMarkerOf(slice) !== null
      const children = renderTokenList(slice, ctx, key, itemTask || (pendingTask && hasInline(slice)))
      if (pendingTask && hasInline(slice)) pendingTask = false
      nodes.push(renderContainer(token, children, ctx, key, slice))
      index = close + 1
      continue
    }
    if (token.nesting === -1) {
      index += 1
      continue
    }
    nodes.push(renderLeaf(token, ctx, key, pendingTask && token.type === 'inline'))
    if (pendingTask && token.type === 'inline') pendingTask = false
    index += 1
  }
  return nodes
}

/**
 * Render one Markdown document as the read-only flow surface.
 * @param props - content, thread pins, selection policy, and callbacks.
 * @returns the reading surface; anchors remain source line ranges.
 */
// Block/selection/scroll wiring; the browser lane owns the interactions.
// fallow-ignore-next-line complexity
export function MarkdownReadView(props: MarkdownReadViewProps): ReactElement {
  const articleRef = useRef<HTMLElement | null>(null)
  const entryRef = useRef<HTMLDivElement | null>(null)
  const [draft, setDraft] = useState<SelectionDraft | null>(null)
  const debounceRef = useRef<number | null>(null)
  const viewportLineRef = useRef(-1)
  const onViewportLineRef = useRef(props.onViewportLine)
  const onClearThreadRef = useRef(props.onClearThread)
  const blocksRef = useRef<readonly MarkdownBlock[]>([])
  onViewportLineRef.current = props.onViewportLine
  onClearThreadRef.current = props.onClearThread

  const lines = useMemo(() => contentLines(props.content), [props.content])
  const split = useMemo(() => splitFrontmatter(props.content), [props.content])
  const tokens = useMemo(() => tokenizeMarkdown(split.body), [split.body])
  const blocks = useMemo(
    () => parseMarkdownBlocks(split.body, split.bodyStartLine),
    [split.body, split.bodyStartLine],
  )
  const pins = useMemo(() => blockPins(blocks, props.threads), [blocks, props.threads])
  blocksRef.current = blocks
  const selectedKey = useMemo(() => {
    if (props.selectedAnchor === null || props.selectedAnchor.kind !== 'line-range') return null
    const block = blockAtLine(blocks, props.selectedAnchor.startLine)
    return block === null ? null : blockKey(block)
  }, [blocks, props.selectedAnchor])
  const ctx = useMemo<RenderContext>(() => ({
    bodyStartLine: split.bodyStartLine,
    blocks,
    pins,
    pinsVisible: props.pinsVisible,
    selectedKey,
    imageUrl: props.imageUrl,
    onPickPin: props.onPickPin,
  }), [split.bodyStartLine, blocks, pins, props.pinsVisible, selectedKey, props.imageUrl, props.onPickPin])

  // A new document or surface state invalidates a selection that addressed the
  // previous text; the entry must not linger over stale lines.
  useEffect(() => { setDraft(null) }, [props.content, props.annotateDisabled])

  // Selection → source lines, debounced so a drag does not compute per pixel.
  useEffect(() => {
    const article = articleRef.current
    if (article === null) return
    // Selection normalization: every early return is one unusable selection.
    // fallow-ignore-next-line complexity
    const compute = (): void => {
      const selection = window.getSelection()
      if (selection === null || selection.isCollapsed) {
        setDraft(null)
        return
      }
      const range = selection.getRangeAt(0)
      if (!article.contains(range.startContainer) || !article.contains(range.endContainer)) {
        setDraft(null)
        return
      }
      const startBlock = blockOfNode(range.startContainer)
      const endBlock = blockOfNode(range.endContainer)
      const selectedText = selection.toString()
      if (startBlock === null || endBlock === null || selectedText.trim() === '') {
        setDraft(null)
        return
      }
      // Frontmatter is a read-only header: it has no pin and no anchor.
      if (startBlock.kind === 'frontmatter' || endBlock.kind === 'frontmatter') {
        setDraft(null)
        return
      }
      const rect = selectionRect(range)
      // A selection that is entirely outside the viewport has no usable entry
      // position; treat it as closed instead of pinning a control off-screen.
      if (rect === null || rect.top + rect.height < 0 || rect.top > window.innerHeight
        || rect.left + rect.width < 0 || rect.left > window.innerWidth) {
        setDraft(null)
        return
      }
      setDraft({
        startBlock,
        endBlock,
        selectedText,
        range: lineRangeForSelection(blocks, lines, startBlock, endBlock, selectedText),
        rect,
      })
    }
    const schedule = (): void => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
      debounceRef.current = window.setTimeout(compute, SELECTION_DEBOUNCE_MS)
    }
    const onPointerDown = (event: PointerEvent): void => {
      const entry = entryRef.current
      if (entry !== null && event.target instanceof Node && entry.contains(event.target)) return
      setDraft(null)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setDraft(null)
      onClearThreadRef.current()
    }
    // A scroll or resize moves the selection rectangle away from the entry.
    const onViewportChange = (): void => { setDraft(null) }
    document.addEventListener('selectionchange', schedule)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onViewportChange)
    document.addEventListener('scroll', onViewportChange, true)
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
      document.removeEventListener('selectionchange', schedule)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onViewportChange)
      document.removeEventListener('scroll', onViewportChange, true)
    }
  }, [blocks, lines])

  // Report the block at the top of the scroll container so a source switch can
  // land on the same place. The container is the viewer content, not the page.
  useEffect(() => {
    const article = articleRef.current
    if (article === null) return
    const container = scrollContainerOf(article)
    if (container === null) return
    let frame = 0
    const report = (): void => {
      frame = 0
      const line = visibleLineAt(article, container.getBoundingClientRect().top + 4)
      // Exposed for the browser lane's read↔source handoff assertion; it has no
      // other reader and mirrors the line the switch will use.
      article.dataset.viewportLine = line === null ? '' : String(line)
      if (line === null || line === viewportLineRef.current) return
      viewportLineRef.current = line
      onViewportLineRef.current(line)
    }
    const schedule = (): void => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(report)
    }
    container.addEventListener('scroll', schedule, { passive: true })
    const initial = window.requestAnimationFrame(report)
    return () => {
      container.removeEventListener('scroll', schedule)
      window.cancelAnimationFrame(initial)
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
  }, [blocks])

  // Source → read: bring the block that contains the editor's top line up.
  // The token makes a repeated request for the same line scroll again, and a
  // content refresh must not re-apply an old focus request.
  useEffect(() => {
    if (props.focusLine === null || articleRef.current === null) return
    scrollBlockToTop(articleRef.current, blocksRef.current, props.focusLine)
  }, [props.focusLine, props.focusToken])

  const position = draft === null ? null : entryPosition(draft.rect)
  return (
    <article
      className="cwi-md-read"
      data-testid="cwi-md-read"
      ref={articleRef}
      aria-label="Markdown 文档"
      onClick={(event) => { if (event.target === event.currentTarget) onClearThreadRef.current() }}
    >
      {split.frontmatter === null ? null : (
        <details
          className="cwi-md-frontmatter"
          data-testid="cwi-md-frontmatter"
          data-src-kind="frontmatter"
          data-src-start="1"
          data-src-end={String(split.bodyStartLine - 1)}
        >
          <summary>文档元数据（frontmatter，只读保护）</summary>
          <pre className="cwi-md-frontmatter-body">{split.frontmatter}</pre>
        </details>
      )}
      {renderTokenList(tokens, ctx, 'md', false)}
      {draft === null || position === null ? null : (
        <div
          className="cwi-md-selection"
          data-testid="cwi-md-selection"
          ref={entryRef}
          role="group"
          aria-label="选区批注"
          style={{ left: position.left, top: position.top }}
        >
          <span className="cwi-md-selection-range">{lineRangeLabel(draft.range.startLine, draft.range.endLine)}</span>
          <button
            type="button"
            className="cwi-primary cwi-md-selection-button"
            data-testid="cwi-annotate"
            disabled={props.annotateDisabled}
            title={props.annotateReason ?? '对所选内容创建批注'}
            onMouseDown={(event) => { event.preventDefault() }}
            onClick={() => {
              props.onAnnotate(draft.range.startLine, draft.range.endLine, draft.selectedText)
              setDraft(null)
            }}
          >
            批注
          </button>
        </div>
      )}
    </article>
  )
}
