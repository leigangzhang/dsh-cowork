import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import '../support/ts-hook.mjs'
const markdown = await import('../../src/client/work-item/viewers/markdown.ts')

/** A document that exercises every block kind the reading surface addresses. */
const DOCUMENT = [
  '# 标题',
  '',
  '第一段。',
  '',
  '- 一',
  '- 二',
  '',
  '> 引用',
  '',
  '```ts',
  'const a = 1',
  '```',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '---',
].join('\n')

test('splitFrontmatter keeps a fenced header out of the body and offsets its lines', () => {
  const split = markdown.splitFrontmatter('---\nstatus: proposed\nowner: x\n---\n# Title\n')
  assert.equal(split.frontmatter, 'status: proposed\nowner: x')
  assert.equal(split.body, '# Title\n')
  assert.equal(split.bodyStartLine, 5)
})

test('splitFrontmatter degrades to the whole file without a leading fence', () => {
  const plain = markdown.splitFrontmatter('# Title\n\nbody')
  assert.equal(plain.frontmatter, null)
  assert.equal(plain.body, '# Title\n\nbody')
  assert.equal(plain.bodyStartLine, 1)
  const unclosed = markdown.splitFrontmatter('---\nstatus: x\nbody')
  assert.equal(unclosed.frontmatter, null)
  assert.equal(unclosed.body, '---\nstatus: x\nbody')
  assert.equal(unclosed.bodyStartLine, 1)
  const empty = markdown.splitFrontmatter('---\n---\nafter')
  assert.equal(empty.frontmatter, '')
  assert.equal(empty.body, 'after')
  assert.equal(empty.bodyStartLine, 3)
})

test('tokenizeMarkdown returns block tokens with inline children', () => {
  const tokens = markdown.tokenizeMarkdown('# 标题\n\n**粗**')
  assert.equal(tokens[0].type, 'heading_open')
  const paragraphs = tokens.filter(token => token.type === 'inline')
  assert.ok(paragraphs[1].children.some(child => child.type === 'strong_open'))
})

test('parseMarkdownBlocks covers headings, paragraphs, lists, quotes, fences, tables, and rules', () => {
  assert.deepEqual(markdown.parseMarkdownBlocks(DOCUMENT), [
    { startLine: 1, endLine: 1, kind: 'heading' },
    { startLine: 3, endLine: 3, kind: 'paragraph' },
    { startLine: 5, endLine: 7, kind: 'list' },
    { startLine: 5, endLine: 5, kind: 'item' },
    { startLine: 5, endLine: 5, kind: 'paragraph' },
    { startLine: 6, endLine: 7, kind: 'item' },
    { startLine: 6, endLine: 6, kind: 'paragraph' },
    { startLine: 8, endLine: 8, kind: 'quote' },
    { startLine: 8, endLine: 8, kind: 'paragraph' },
    { startLine: 10, endLine: 12, kind: 'fence' },
    { startLine: 14, endLine: 16, kind: 'table' },
    { startLine: 18, endLine: 18, kind: 'hr' },
  ])
})

test('parseMarkdownBlocks shifts the body and adds the frontmatter block', () => {
  const blocks = markdown.parseMarkdownBlocks('# Title\n\nparagraph', 3)
  assert.deepEqual(blocks, [
    { startLine: 1, endLine: 2, kind: 'frontmatter' },
    { startLine: 3, endLine: 3, kind: 'heading' },
    { startLine: 5, endLine: 5, kind: 'paragraph' },
  ])
})

test('a setext heading owns its underline line', () => {
  assert.deepEqual(markdown.parseMarkdownBlocks('标题\n==='), [{ startLine: 1, endLine: 2, kind: 'heading' }])
})

test('an indented code block counts as a fence block', () => {
  const blocks = markdown.parseMarkdownBlocks('para\n\n    code\n    more')
  assert.deepEqual(blocks, [
    { startLine: 1, endLine: 1, kind: 'paragraph' },
    { startLine: 3, endLine: 4, kind: 'fence' },
  ])
})

test('blockAtLine picks the deepest containing block and ignores gaps', () => {
  const blocks = markdown.parseMarkdownBlocks(DOCUMENT)
  assert.deepEqual(markdown.blockAtLine(blocks, 1), { startLine: 1, endLine: 1, kind: 'heading' })
  assert.deepEqual(markdown.blockAtLine(blocks, 5), { startLine: 5, endLine: 5, kind: 'paragraph' })
  assert.deepEqual(markdown.blockAtLine(blocks, 8), { startLine: 8, endLine: 8, kind: 'paragraph' })
  assert.equal(markdown.blockAtLine(blocks, 2), null)
  assert.equal(markdown.blockAtLine(blocks, 99), null)
  assert.equal(markdown.blockAtLine([], 1), null)
})

test('blockAtLine keeps the later token when two blocks share a range', () => {
  const blocks = [
    { startLine: 3, endLine: 5, kind: 'list' },
    { startLine: 3, endLine: 5, kind: 'item' },
  ]
  assert.equal(markdown.blockAtLine(blocks, 4).kind, 'item')
})

test('blockKey identifies a block by kind and source range', () => {
  assert.equal(markdown.blockKey({ startLine: 3, endLine: 4, kind: 'paragraph' }), 'paragraph:3:4')
})

/** Folded threads shaped like the rail's view model. */
function thread(anchor, options = {}) {
  return { anchor, resolved: false, anchorStatus: null, ...options }
}

test('blockPins groups threads by their deepest block and counts them', () => {
  const blocks = markdown.parseMarkdownBlocks(DOCUMENT)
  const pins = markdown.blockPins(blocks, [
    thread({ kind: 'line-range', path: 'a.md', startLine: 3, endLine: 3, quote: '' }),
    thread({ kind: 'whole', path: 'a.md' }),
    thread({ kind: 'line-range', path: 'a.md', startLine: 6, endLine: 6, quote: '' }, { resolved: true }),
    thread({ kind: 'line-range', path: 'a.md', startLine: 6, endLine: 6, quote: '' }),
    thread({ kind: 'line-range', path: 'a.md', startLine: 6, endLine: 6, quote: '' }, { anchorStatus: 'stale' }),
    { anchor: null, resolved: false, anchorStatus: null },
  ])
  assert.deepEqual(pins.get('paragraph:3:3'), {
    ordinal: 1, count: 1, tone: 'open', startLine: 3, endLine: 3,
  })
  assert.deepEqual(pins.get('paragraph:6:6'), {
    ordinal: 3, count: 3, tone: 'resolved', startLine: 6, endLine: 6,
  })
  assert.equal(pins.size, 2)
})

test('blockPins gives an open stale thread the warn tone and never pins frontmatter', () => {
  const blocks = markdown.parseMarkdownBlocks('# Title', 3)
  const pins = markdown.blockPins(blocks, [
    thread({ kind: 'line-range', path: 'a.md', startLine: 1, endLine: 1, quote: '' }, { anchorStatus: 'stale' }),
    thread({ kind: 'line-range', path: 'a.md', startLine: 3, endLine: 3, quote: '' }, { anchorStatus: 'stale' }),
  ])
  assert.equal(pins.size, 1)
  assert.equal(pins.get('heading:3:3').tone, 'stale')
})

test('lineRangeForSelection refines a unique single-line match', () => {
  const text = 'alpha beta gamma\nsecond line'
  const blocks = markdown.parseMarkdownBlocks(text)
  assert.deepEqual(
    markdown.lineRangeForSelection(blocks, text.split('\n'), blocks[0], blocks[0], 'beta'),
    { startLine: 1, endLine: 1 },
  )
  assert.deepEqual(
    markdown.lineRangeForSelection(blocks, text.split('\n'), blocks[0], blocks[0], 'gamma'),
    { startLine: 1, endLine: 1 },
  )
  const twoLine = 'first\nsecond\nthird'
  const twoBlocks = markdown.parseMarkdownBlocks(twoLine)
  assert.deepEqual(
    markdown.lineRangeForSelection(twoBlocks, twoLine.split('\n'), twoBlocks[0], twoBlocks[0], 'first second'),
    { startLine: 1, endLine: 2 },
  )
})

test('lineRangeForSelection falls back to the block range when the match is not unique', () => {
  const text = 'same words here\nsame words there'
  const blocks = markdown.parseMarkdownBlocks(text)
  assert.deepEqual(
    markdown.lineRangeForSelection(blocks, text.split('\n'), blocks[0], blocks[0], 'same words'),
    { startLine: 1, endLine: 2 },
  )
  assert.deepEqual(
    markdown.lineRangeForSelection(blocks, text.split('\n'), blocks[0], blocks[0], 'missing'),
    { startLine: 1, endLine: 2 },
  )
  assert.deepEqual(
    markdown.lineRangeForSelection(blocks, text.split('\n'), blocks[0], blocks[0], '   '),
    { startLine: 1, endLine: 2 },
  )
})

test('lineRangeForSelection spans different blocks and resolves container endpoints', () => {
  const blocks = markdown.parseMarkdownBlocks(DOCUMENT)
  const list = blocks.find(block => block.kind === 'list')
  const quote = blocks.find(block => block.kind === 'quote')
  assert.deepEqual(
    markdown.lineRangeForSelection(blocks, DOCUMENT.split('\n'), list, quote, '第一段。'),
    { startLine: 5, endLine: 8 },
  )
  // A container endpoint resolves through blockAtLine; a loose list item keeps
  // its trailing blank line, so the end bound is the list's last line.
  const heading = blocks[0]
  assert.deepEqual(
    markdown.lineRangeForSelection(blocks, DOCUMENT.split('\n'), list, list, '一 二'),
    { startLine: 5, endLine: 7 },
  )
  assert.deepEqual(
    markdown.lineRangeForSelection(blocks, DOCUMENT.split('\n'), heading, heading, '标题'),
    { startLine: 1, endLine: 1 },
  )
})

test('lineRangeForSelection strips block and inline markers before matching', () => {
  const text = ['# 标题', '', '- 列表项 with **粗体** and `code`', '> 引用 [链接](https://example.com) 结尾'].join('\n')
  const blocks = markdown.parseMarkdownBlocks(text)
  const lines = text.split('\n')
  const item = blocks.find(block => block.kind === 'paragraph' && block.startLine === 3)
  assert.deepEqual(markdown.lineRangeForSelection(blocks, lines, item, item, '粗体'), { startLine: 3, endLine: 3 })
  assert.deepEqual(markdown.lineRangeForSelection(blocks, lines, item, item, 'code'), { startLine: 3, endLine: 3 })
  const quote = blocks.find(block => block.kind === 'paragraph' && block.startLine === 4)
  assert.deepEqual(markdown.lineRangeForSelection(blocks, lines, quote, quote, '链接 结尾'), { startLine: 4, endLine: 4 })
})

test('lineRangeForSelection keeps a match inside a multi-line block on its own line', () => {
  const text = 'first line\nsecond line\nthird line'
  const lines = text.split('\n')
  const blocks = markdown.parseMarkdownBlocks(text)
  assert.deepEqual(blocks, [{ startLine: 1, endLine: 3, kind: 'paragraph' }])
  assert.deepEqual(
    markdown.lineRangeForSelection(blocks, lines, blocks[0], blocks[0], 'second line'),
    { startLine: 2, endLine: 2 },
  )
})

test('sanitizeLinkHref accepts only absolute http and https links', () => {
  assert.equal(markdown.sanitizeLinkHref('https://example.com/a?b=1'), 'https://example.com/a?b=1')
  assert.equal(markdown.sanitizeLinkHref('HTTP://example.com'), 'HTTP://example.com')
  for (const href of ['', '   ', './relative.md', '#anchor', 'javascript:alert(1)', 'data:text/html,x', 'ftp://x', 'https://', 'https://a\u0000b']) {
    assert.equal(markdown.sanitizeLinkHref(href), null, href)
  }
})

test('sanitizeImageSrc allows http(s), attachment ids, and safe relative paths', () => {
  assert.equal(markdown.sanitizeImageSrc('https://example.com/a.png'), 'https://example.com/a.png')
  assert.equal(markdown.sanitizeImageSrc('http://example.com/a.png'), 'http://example.com/a.png')
  assert.equal(markdown.sanitizeImageSrc('cowork-attachment://abc_DEF-123'), 'cowork-attachment://abc_DEF-123')
  assert.equal(markdown.sanitizeImageSrc('./images/a.png'), './images/a.png')
  assert.equal(markdown.sanitizeImageSrc('images/a.png'), 'images/a.png')
})

test('sanitizeImageSrc refuses unsafe schemes, escapes, and disallowed families', () => {
  for (const src of [
    '', '  ', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'blob:http://x/y',
    'file:///etc/passwd', 'vbscript:x', 'cowork-attachment://', 'cowork-attachment://a/b',
    '/absolute/a.png', '//evil.example/a.png', '../outside.png', 'images/../x.png',
    'images\\a.png', 'images/a b.png', 'images/a\u0000.png', 'https://', 'http://',
  ]) {
    assert.equal(markdown.sanitizeImageSrc(src), null, src)
  }
  assert.equal(markdown.sanitizeImageSrc('https://example.com/a.png', ['relative']), null)
  assert.equal(markdown.sanitizeImageSrc('./a.png', ['https']), null)
  assert.equal(markdown.sanitizeImageSrc('cowork-attachment://abc', ['relative']), null)
  assert.equal(markdown.sanitizeImageSrc('relative.png', ['relative']), 'relative.png')
})

test('renderTaskMarker decodes the two task markers and nothing else', () => {
  assert.deepEqual(markdown.renderTaskMarker('[ ] todo'), { checked: false, text: 'todo' })
  assert.deepEqual(markdown.renderTaskMarker('[x] done'), { checked: true, text: 'done' })
  assert.deepEqual(markdown.renderTaskMarker('[X] done'), { checked: true, text: 'done' })
  assert.deepEqual(markdown.renderTaskMarker('[ ]'), { checked: false, text: '' })
  assert.deepEqual(markdown.renderTaskMarker('[ ]  multi\nline'), { checked: false, text: 'multi\nline' })
  assert.equal(markdown.renderTaskMarker('[x]not a task'), null)
  assert.equal(markdown.renderTaskMarker('plain'), null)
  assert.equal(markdown.renderTaskMarker('[y] nope'), null)
})

test('tableAlignment accepts only the three parser values', () => {
  assert.equal(markdown.tableAlignment([['style', 'text-align:left']]), 'left')
  assert.equal(markdown.tableAlignment([['style', 'text-align:center']]), 'center')
  assert.equal(markdown.tableAlignment([['style', 'text-align:right']]), 'right')
  assert.equal(markdown.tableAlignment([['style', 'text-align:center;background:url(x)']]), 'left')
  assert.equal(markdown.tableAlignment([['class', 'x']]), 'left')
  assert.equal(markdown.tableAlignment(null), 'left')
})

test('readFallbackReason degrades only oversized content', () => {
  assert.equal(markdown.readFallbackReason('# small'), null)
  const bytes = 'x'.repeat(markdown.MARKDOWN_READ_MAX_BYTES + 1)
  assert.match(markdown.readFallbackReason(bytes), /2 MB/)
  const lines = 'line\n'.repeat(20_001)
  assert.match(markdown.readFallbackReason(lines), /20000 行/)
})

test('the reading renderer never writes an HTML string', () => {
  const files = [
    'src/client/work-item/viewers/markdown-view.tsx',
    'src/client/work-item/viewers/markdown.ts',
    'src/client/work-item/reading-surface.ts',
  ]
  for (const file of files) {
    const source = readFileSync(resolve(import.meta.dirname, '../..', file), 'utf8')
    // Doc comments may name the rule; executable code must not pass HTML.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    assert.equal(/innerHTML|dangerouslySetInnerHTML/.test(code), false, file)
  }
})
