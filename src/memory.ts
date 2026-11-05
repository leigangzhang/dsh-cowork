/**
 * Project memory module: the three markdown files (`constraints.md`,
 * `decisions.md`, `facts.md`) a cowork project keeps under
 * `.dsh-cowork/memory/`, plus the pure operations over their entries —
 * validation, parsing, rendering into a model-facing block, keyword search and
 * append under a caller-supplied lock.
 *
 * Everything here is pure logic plus an injected I/O port ({@link MemoryIo}), so
 * the whole surface runs under `node --test` without the host, a temporary
 * directory or the store. The module deliberately imports nothing but node
 * builtins: Node's TS type stripping does not rewrite `./x.js` to `./x.ts`, so a
 * value-level sibling import would make every test fail at resolution time.
 *
 * File format, exactly one entry per block:
 *
 * ```
 * ## <title>
 *
 * <text>
 *
 * (来源: <source>; <ISO 8601 UTC timestamp>)
 * ```
 *
 * Entries are separated by exactly one blank line and the file carries no
 * title of its own. A malformed entry is reported as an issue with a 1-based
 * line number instead of throwing: a single bad hand edit must not make the
 * other entries unreadable. {@link appendMemoryEntry} is the one place that
 * turns issues into a {@link MemoryCorruptError}, because appending to a file
 * it cannot fully parse would silently drop the unparsed tail.
 */

import { join } from 'node:path'

export type MemoryKind = 'constraint' | 'decision' | 'fact'

/** Tokenizer injected by the caller — the router's `tokenize` in production. */
export type Tokenize = (text: string) => readonly string[]

/** Render order as well as the canonical kind order (most to least binding). */
export const MEMORY_KINDS: readonly MemoryKind[] = ['constraint', 'decision', 'fact']

export const MEMORY_FILES: Readonly<Record<MemoryKind, string>> = {
  constraint: 'constraints.md',
  decision: 'decisions.md',
  fact: 'facts.md',
}

/** Budget for the memory block injected into a model request. */
export const DEFAULT_MEMORY_BUDGET_TOKENS = 3000

/** Longest single entry text accepted by {@link validateMemoryEntry}. */
export const MAX_ENTRY_TEXT_CHARS = 8000

export const DEFAULT_SEARCH_LIMIT = 5
export const MAX_SEARCH_LIMIT = 20

export interface MemoryEntry {
  kind: MemoryKind
  title: string
  text: string
  source: string
  createdAt: string
}

export interface MemoryFileIssue {
  /** File the issue was found in, as named by the caller. */
  file: string
  /** 1-based line number. */
  line: number
  message: string
}

export interface ParsedMemoryFile {
  entries: MemoryEntry[]
  issues: MemoryFileIssue[]
}

export interface MemoryEntryInput {
  title: string
  text: string
  source: string
}

export interface MemoryValidationIssue {
  field: 'title' | 'text' | 'source'
  message: string
}

export interface MemoryInjectInput {
  kind: MemoryKind
  entries: readonly MemoryEntry[]
}

export interface MemoryBlock {
  text: string
  truncated: boolean
  tokens: number
  entryCount: number
}

export interface MemorySearchHit {
  kind: MemoryKind
  title: string
  text: string
  source: string
  file: string
  createdAt: string
  score: number
}

export interface SearchOptions {
  tokenize: Tokenize
  limit?: number
}

export interface MemoryIo {
  readText(path: string): Promise<string | null>
  writeText(path: string, text: string): Promise<void>
  withLock<T>(operation: () => Promise<T>): Promise<T>
}

export interface LoadedMemoryFile {
  kind: MemoryKind
  file: string
  entries: MemoryEntry[]
}

export interface MemoryLoadResult {
  files: LoadedMemoryFile[]
  issues: MemoryFileIssue[]
}

const MEMORY_DIR_NAME = '.dsh-cowork'
const MEMORY_SUBDIR_NAME = 'memory'

const TITLE_PREFIX = '## '
const SECTION_PREFIX = '### '
const TRUNCATION_MARKER = '[memory truncated]'
const CHARS_PER_TOKEN = 4

const TITLE_WEIGHT = 3
const TEXT_WEIGHT = 2
const SOURCE_WEIGHT = 1

/**
 * Trailing provenance line. `(.+)` is greedy so a source may itself contain
 * `; `; the timestamp is anchored to an ISO 8601 date prefix, and
 * {@link parseMemoryFile} additionally rejects a value `Date.parse` cannot read
 * (for example month 13, which still satisfies the shape).
 */
const SOURCE_LINE = /^\(来源: (.+); (\d{4}-\d{2}-\d{2}T[^)]+)\)$/

/**
 * C0 controls and DEL. A newline inside an entry field would let the value
 * forge a provenance line or a new `## ` heading, so all three fields are
 * single-line and the rendered block always re-parses to the same entry.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/** Whether a value is a JSON object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a value names one of the three memory kinds. */
function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value)
}

/**
 * Build one structured validation issue. The public `field` union is frozen to
 * the three entry fields, yet an unknown `kind` still has to be reported as a
 * structured issue rather than thrown, so the cast keeps the readable name.
 */
function validationIssue(
  field: MemoryValidationIssue['field'] | 'kind',
  message: string,
): MemoryValidationIssue {
  return { field: field as MemoryValidationIssue['field'], message }
}

/** Number of tokens the injected tokenizer reports for `text`, as a set. */
function tokenSet(tokenize: Tokenize, text: string): Set<string> {
  const tokens = new Set<string>()
  for (const token of tokenize(text)) {
    if (typeof token === 'string' && token.length > 0) tokens.add(token)
  }
  return tokens
}

/** How many distinct query tokens appear in the field's token set. */
function overlap(queryTokens: ReadonlySet<string>, fieldTokens: ReadonlySet<string>): number {
  let count = 0
  for (const token of queryTokens) {
    if (fieldTokens.has(token)) count += 1
  }
  return count
}

/** `Date.parse` in milliseconds, with unparseable timestamps sorting oldest. */
function timeOf(value: string): number {
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms
}

/** The three fields plus a timestamp, i.e. one complete on-disk entry. */
interface RenderedEntry {
  title: string
  text: string
  source: string
  createdAt: string
}

/** Render one entry exactly as the file format specifies. */
function renderEntry(entry: RenderedEntry): string {
  return `## ${entry.title}\n\n${entry.text}\n\n(来源: ${entry.source}; ${entry.createdAt})`
}

/** Section heading for one kind: the plural file stem, e.g. `### constraints`. */
function sectionTitle(kind: MemoryKind): string {
  return MEMORY_FILES[kind].replace(/\.md$/, '')
}

/** Append `block` to an existing file body, keeping exactly one blank line. */
function composeFileContent(existing: string, block: string): string {
  const body = existing.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  return body.length === 0 ? `${block}\n` : `${body}\n\n${block}\n`
}

/** Clamp a search limit to 1..20, falling back to the default when invalid. */
function normalizeLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SEARCH_LIMIT
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.trunc(value)))
}

/** Clamp an injected budget, falling back to the default when invalid. */
function normalizeBudget(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MEMORY_BUDGET_TOKENS
  }
  return Math.floor(value)
}

/** Compare two search hits: score desc, createdAt desc, title asc. */
function compareHits(a: MemorySearchHit, b: MemorySearchHit): number {
  if (a.score !== b.score) return b.score - a.score
  const aTime = timeOf(a.createdAt)
  const bTime = timeOf(b.createdAt)
  const aMissing = aTime === Number.NEGATIVE_INFINITY
  const bMissing = bTime === Number.NEGATIVE_INFINITY
  if (aMissing !== bMissing) return aMissing ? 1 : -1
  if (aTime !== bTime) return bTime - aTime
  if (a.title < b.title) return -1
  if (a.title > b.title) return 1
  return 0
}

/**
 * Parse one memory file. Never throws for malformed content: each bad block
 * becomes an issue carrying the 1-based line the reader has to look at, and the
 * well-formed blocks are still returned so one hand edit cannot hide the rest.
 * CRLF (and stray CR) is normalised before splitting, so a Windows checkout
 * parses identically.
 */
export function parseMemoryFile(
  kind: MemoryKind,
  fileName: string,
  content: string,
): ParsedMemoryFile {
  const entries: MemoryEntry[] = []
  const issues: MemoryFileIssue[] = []
  const normalized = (typeof content === 'string' ? content : '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')

  const blockStarts: number[] = []
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith(TITLE_PREFIX)) blockStarts.push(i)
  }

  const firstBlock = blockStarts.length === 0 ? lines.length : blockStarts[0]
  for (let i = 0; i < firstBlock; i += 1) {
    if (lines[i].trim().length > 0) {
      issues.push({
        file: fileName,
        line: i + 1,
        message: 'memory files carry no preamble; content before the first "## " heading is ignored',
      })
      break
    }
  }

  for (let b = 0; b < blockStarts.length; b += 1) {
    const start = blockStarts[b]
    const end = b + 1 < blockStarts.length ? blockStarts[b + 1] : lines.length
    const title = lines[start].slice(TITLE_PREFIX.length).trim()
    if (title.length === 0) {
      issues.push({ file: fileName, line: start + 1, message: 'entry title is empty' })
      continue
    }

    let lastLine = end - 1
    while (lastLine > start && lines[lastLine].trim().length === 0) lastLine -= 1
    if (lastLine === start) {
      issues.push({
        file: fileName,
        line: start + 1,
        message: 'entry is missing the "(来源: <source>; <ISO 8601 timestamp>)" line',
      })
      continue
    }

    const match = SOURCE_LINE.exec(lines[lastLine])
    if (match === null) {
      issues.push({
        file: fileName,
        line: lastLine + 1,
        message: 'entry must end with "(来源: <source>; <ISO 8601 timestamp>)"',
      })
      continue
    }

    const source = match[1].trim()
    const createdAt = match[2]
    if (source.length === 0) {
      issues.push({ file: fileName, line: lastLine + 1, message: 'entry source is empty' })
      continue
    }
    if (Number.isNaN(Date.parse(createdAt))) {
      issues.push({
        file: fileName,
        line: lastLine + 1,
        message: `entry timestamp "${createdAt}" is not a valid ISO 8601 date`,
      })
      continue
    }

    // Multi-line bodies are allowed on disk: only the trailing provenance line
    // is special, so an entry may wrap its text over several lines.
    const text = lines.slice(start + 1, lastLine).join('\n').trim()
    if (text.length === 0) {
      issues.push({ file: fileName, line: start + 1, message: 'entry text is empty' })
      continue
    }

    entries.push({ kind, title, text, source, createdAt })
  }

  return { entries, issues }
}

/**
 * Validate untrusted entry input before it is rendered or written. Returns
 * every problem at once so a caller can show them together; `kind` itself is
 * part of the input because appending to the wrong file must be caught here,
 * not by the file parser.
 */
export function validateMemoryEntry(
  kind: unknown,
  input: unknown,
): { ok: true; kind: MemoryKind; value: MemoryEntryInput } | { ok: false; issues: MemoryValidationIssue[] } {
  const issues: MemoryValidationIssue[] = []

  if (!isMemoryKind(kind)) {
    issues.push(
      validationIssue('kind', `kind must be one of ${MEMORY_KINDS.map((k) => `"${k}"`).join(', ')}`),
    )
  }

  const record = isRecord(input) ? input : {}
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  const text = typeof record.text === 'string' ? record.text.trim() : ''
  const source = typeof record.source === 'string' ? record.source.trim() : ''

  if (title.length === 0) {
    issues.push(validationIssue('title', 'title must be a non-empty string'))
  } else if (CONTROL_CHARS.test(title)) {
    issues.push(validationIssue('title', 'title must not contain control characters'))
  }

  if (text.length === 0) {
    issues.push(validationIssue('text', 'text must be a non-empty string'))
  } else if (CONTROL_CHARS.test(text)) {
    issues.push(validationIssue('text', 'text must not contain control characters'))
  } else if (text.length > MAX_ENTRY_TEXT_CHARS) {
    issues.push(
      validationIssue('text', `text must be at most ${MAX_ENTRY_TEXT_CHARS} characters`),
    )
  }

  if (source.length === 0) {
    issues.push(validationIssue('source', 'source must be a non-empty string'))
  } else if (CONTROL_CHARS.test(source)) {
    issues.push(validationIssue('source', 'source must not contain control characters'))
  }

  if (issues.length > 0 || !isMemoryKind(kind)) return { ok: false, issues }
  return { ok: true, kind, value: { title, text, source } }
}

/**
 * Render one entry in file format. The public signature carries no clock, so
 * this convenience stamps the wall clock; {@link appendMemoryEntry} uses the
 * internal renderer with its injected clock instead, which is why the tests
 * assert the timestamp's shape rather than an exact value here.
 */
export function renderMemoryEntry(entry: MemoryEntryInput): string {
  return renderEntry({ ...entry, createdAt: new Date().toISOString() })
}

/** Token estimate: four characters per token, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Render the memory block injected into a model request: one `### <kind>s`
 * section (`### constraints` …) per non-empty kind, in constraints → decisions →
 * facts order, with
 * whole entries only. The first entry that does not fit stops the block and
 * appends {@link TRUNCATION_MARKER}; `tokens` is measured on the final text, so
 * it can exceed the budget by the marker itself.
 */
export function renderMemoryBlock(
  files: readonly MemoryInjectInput[],
  budgetTokens: number = DEFAULT_MEMORY_BUDGET_TOKENS,
): MemoryBlock {
  const budget = normalizeBudget(budgetTokens)
  let text = ''
  let entryCount = 0
  let truncated = false

  outer: for (const kind of MEMORY_KINDS) {
    for (const file of files) {
      if (file.kind !== kind) continue
      let sectionStarted = false
      for (const entry of file.entries) {
        const block = renderEntry(entry)
        const chunk = sectionStarted ? block : `${SECTION_PREFIX}${sectionTitle(kind)}\n\n${block}`
        const tentative = text.length === 0 ? chunk : `${text}\n\n${chunk}`
        if (estimateTokens(tentative) > budget) {
          truncated = true
          break outer
        }
        text = tentative
        sectionStarted = true
        entryCount += 1
      }
    }
  }

  if (truncated) {
    text = text.length === 0 ? TRUNCATION_MARKER : `${text}\n${TRUNCATION_MARKER}`
  }

  return { text, truncated, tokens: estimateTokens(text), entryCount }
}

/**
 * Rank entries against a query with the injected tokenizer. Score is 3×title
 * hits + 2×text hits + 1×source hits over distinct tokens; zero scores are
 * dropped because a weak hit is noise in a 3000-token block. Ties fall back to
 * newest first, then title ascending, so the output is deterministic. The
 * tokenizer owns normalisation (case folding, CJK bigrams), which is why the
 * field text is tokenized by the same function rather than substring-matched.
 */
export function searchMemory(
  entries: readonly { kind: MemoryKind; file: string; entry: MemoryEntry }[],
  query: string,
  options: SearchOptions,
): MemorySearchHit[] {
  const tokenize = options?.tokenize
  if (typeof tokenize !== 'function' || typeof query !== 'string') return []

  const queryTokens = tokenSet(tokenize, query)
  if (queryTokens.size === 0) return []

  const hits: MemorySearchHit[] = []
  for (const item of entries) {
    const entry = item.entry
    const score =
      TITLE_WEIGHT * overlap(queryTokens, tokenSet(tokenize, entry.title)) +
      TEXT_WEIGHT * overlap(queryTokens, tokenSet(tokenize, entry.text)) +
      SOURCE_WEIGHT * overlap(queryTokens, tokenSet(tokenize, entry.source))
    if (score === 0) continue
    hits.push({
      kind: item.kind,
      title: entry.title,
      text: entry.text,
      source: entry.source,
      file: item.file,
      createdAt: entry.createdAt,
      score,
    })
  }

  hits.sort(compareHits)
  return hits.slice(0, normalizeLimit(options.limit))
}

/** Directory holding the project memory files. */
export function memoryDirOf(repoPath: string): string {
  return join(repoPath, MEMORY_DIR_NAME, MEMORY_SUBDIR_NAME)
}

/** Absolute path of one memory file. */
export function memoryFilePath(repoPath: string, kind: MemoryKind): string {
  return join(memoryDirOf(repoPath), MEMORY_FILES[kind])
}

/**
 * Read all memory files through the injected port. A missing file is simply
 * absent from `files`; a malformed one is reported in `issues` while its
 * well-formed entries are still returned, so one broken file does not blank the
 * whole memory.
 */
export async function loadMemory(
  io: Pick<MemoryIo, 'readText'>,
  repoPath: string,
): Promise<MemoryLoadResult> {
  const files: LoadedMemoryFile[] = []
  const issues: MemoryFileIssue[] = []

  for (const kind of MEMORY_KINDS) {
    const file = MEMORY_FILES[kind]
    const content = await io.readText(memoryFilePath(repoPath, kind))
    if (content === null) continue
    const parsed = parseMemoryFile(kind, file, content)
    files.push({ kind, file, entries: parsed.entries })
    issues.push(...parsed.issues)
  }

  return { files, issues }
}

/** A memory file that cannot be parsed, so appending would lose entries. */
export class MemoryCorruptError extends Error {
  readonly file: string
  readonly issues: MemoryFileIssue[]

  constructor(file: string, issues: MemoryFileIssue[]) {
    super(
      `memory file "${file}" is corrupt: ${issues
        .map((issue) => `line ${issue.line}: ${issue.message}`)
        .join('; ')}`,
    )
    this.name = 'MemoryCorruptError'
    this.file = file
    this.issues = issues
  }
}

/**
 * Append one entry under the injected lock. Read → parse → fail on issues →
 * compose → re-parse whole file → write: the re-parse is the guard that the
 * composed content still parses (it also catches an entry whose text would let
 * it forge structure, though validation normally rejects that first). The
 * timestamp comes from the injected clock so tests stay deterministic.
 */
export async function appendMemoryEntry(
  io: MemoryIo,
  repoPath: string,
  kind: MemoryKind,
  input: MemoryEntryInput,
  clock: () => Date,
): Promise<{ file: string; filePath: string; entry: MemoryEntry }> {
  if (!isMemoryKind(kind)) throw new TypeError(`unknown memory kind: ${String(kind)}`)

  const file = MEMORY_FILES[kind]
  const filePath = memoryFilePath(repoPath, kind)

  return io.withLock(async () => {
    const existing = (await io.readText(filePath)) ?? ''
    const parsed = parseMemoryFile(kind, filePath, existing)
    if (parsed.issues.length > 0) throw new MemoryCorruptError(filePath, parsed.issues)

    const validated = validateMemoryEntry(kind, input)
    if (!validated.ok) {
      const detail = validated.issues.map((issue) => `${issue.field}: ${issue.message}`).join('; ')
      throw new TypeError(`invalid ${kind} memory entry: ${detail}`)
    }

    const entry: MemoryEntry = {
      kind,
      title: validated.value.title,
      text: validated.value.text,
      source: validated.value.source,
      createdAt: clock().toISOString(),
    }

    const next = composeFileContent(existing, renderEntry(entry))
    const check = parseMemoryFile(kind, filePath, next)
    if (check.issues.length > 0) throw new MemoryCorruptError(filePath, check.issues)

    await io.writeText(filePath, next)
    return { file, filePath, entry }
  })
}
