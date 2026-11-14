import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOOL_DOMAINS } from './support/public-surface.mjs'

/**
 * The DSH read tool stops at 50 KiB per file, so a source file at or above this
 * size cannot be read in one call by any agent (P2's hard line, KI-14). This
 * test is the executable form of that limit: src/tools.ts used to sit 16 B below
 * it, so a structural split — not another paragraph — is the only fix.
 *
 * Deterministic and read-only: it walks `src/` and stats files; nothing is
 * written. A failure names every offending path with its byte count.
 */
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const srcRoot = resolve(root, 'src')

/** DSH's single-file read ceiling, in bytes (50 KiB). */
const READ_LIMIT_BYTES = 51_200

/** Soft target for source files: at or below this, the file is comfortable to read. */
const SOURCE_SOFT_TARGET_BYTES = 49_152

/** The host entry point budget; a bigger entry means the assembly is doing work. */
const HOST_ENTRY_LIMIT_BYTES = 30_720

/** Test files stop being readable in one agent context above this many lines. */
const TEST_FILE_MAX_LINES = 1_200

/** Headroom the tools split must keep on src/tools.ts; 48 KiB leaves 2 KiB. */
const TOOLS_SPLIT_HEADROOM_BYTES = 49_152

/** The M12 E2E split target: every m12-e2e module keeps 48 KiB, not just 50. */
const M12_SPLIT_HEADROOM_BYTES = 49_152

/** Every `.ts`/`.tsx` file under `dir`, recursively, as repo-relative POSIX paths. */
function sourceFiles(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path))
      continue
    }
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue
    found.push(relative(root, path).split(sep).join('/'))
  }
  return found.sort()
}

/** Every `*.test.mjs` under `tests/`, recursively, as repo-relative POSIX paths. */
function testFiles() {
  const found = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
        found.push(relative(root, full).split(sep).join('/'))
      }
    }
  }
  visit(resolve(root, 'tests'))
  return found.sort()
}

/** Bytes on disk for one repo-relative path. */
function bytesOf(file) {
  return statSync(resolve(root, file)).size
}

/** Line count for a text, counting a missing trailing newline as one line. */
function linesOf(text) {
  if (text === '') return 0
  return (text.match(/\n/g) ?? []).length + (text.endsWith('\n') ? 0 : 1)
}

/** Files over a byte limit, as human-readable violations. */
function budgetProblems(entries, limit) {
  return entries
    .filter(({ bytes }) => bytes > limit)
    .map(({ file, bytes }) => `${file}: ${bytes} B, over ${limit} B`)
}

/** Files over a line limit, as human-readable violations. */
function lineBudgetProblems(entries, limit) {
  return entries
    .filter(({ lines }) => lines > limit)
    .map(({ file, lines }) => `${file}: ${lines} lines, over ${limit}`)
}

/** Nested host `index.ts` files: the public entry is `src/index.ts` and only it. */
function hostEntryBarrels(files) {
  return files.filter((file) => file !== 'src/index.ts' && file.endsWith('/index.ts'))
}

test('every src/**/*.ts and src/**/*.tsx file stays under the 50 KiB read limit', () => {
  const files = sourceFiles(srcRoot)
  assert.ok(files.length > 0, 'no .ts/.tsx files found under src/')
  const entries = files.map((file) => ({ file, bytes: bytesOf(file) }))
  const soft = budgetProblems(entries, SOURCE_SOFT_TARGET_BYTES)
  // Visible on every run: the soft target is a nudge to split, not a failure.
  if (soft.length > 0) {
    console.log(`# above the ${SOURCE_SOFT_TARGET_BYTES} B soft target (hard line ${READ_LIMIT_BYTES} B): ${soft.join(', ')}`)
  }
  assert.deepEqual(budgetProblems(entries, READ_LIMIT_BYTES), [])
})

test('the host entry stays at or below 30 KiB', () => {
  const bytes = bytesOf('src/index.ts')
  console.log(`# src/index.ts: ${bytes} B / ${HOST_ENTRY_LIMIT_BYTES} B`)
  assert.ok(bytes <= HOST_ENTRY_LIMIT_BYTES, `src/index.ts is ${bytes} B, over the ${HOST_ENTRY_LIMIT_BYTES} B budget`)
})

test('test files stay at or below 1,200 lines', () => {
  const entries = testFiles().map((file) => ({ file, lines: linesOf(readFileSync(resolve(root, file), 'utf8')) }))
  assert.ok(entries.length > 0, 'no test files found under tests/')
  assert.deepEqual(lineBudgetProblems(entries, TEST_FILE_MAX_LINES), [])
})

test('the host has one index.ts entry and no nested index barrels', () => {
  const files = sourceFiles(srcRoot)
  assert.ok(files.includes('src/index.ts'), 'src/index.ts must stay the host entry')
  assert.deepEqual(hostEntryBarrels(files), [])
})

test('the budget helpers reject synthetic overruns', () => {
  // A limit is inclusive: a file exactly at the budget passes, one byte over fails.
  assert.deepEqual(budgetProblems([{ file: 'src/fits.ts', bytes: READ_LIMIT_BYTES }], READ_LIMIT_BYTES), [])
  assert.equal(budgetProblems([{ file: 'src/over.ts', bytes: READ_LIMIT_BYTES + 1 }], READ_LIMIT_BYTES).length, 1)
  assert.deepEqual(lineBudgetProblems([{ file: 'tests/fits.test.mjs', lines: TEST_FILE_MAX_LINES }], TEST_FILE_MAX_LINES), [])
  assert.equal(lineBudgetProblems([{ file: 'tests/over.test.mjs', lines: TEST_FILE_MAX_LINES + 1 }], TEST_FILE_MAX_LINES).length, 1)
  assert.deepEqual(hostEntryBarrels(['src/index.ts', 'src/client/index.tsx']), [])
  assert.deepEqual(hostEntryBarrels(['src/index.ts', 'src/feature/index.ts']), ['src/feature/index.ts'])
})

test('every src/m12-e2e module stays under the 48 KiB split target', () => {
  // Dynamic on purpose: a new module born from the M12 split is covered without
  // editing this list, so the budget cannot silently stop applying to it.
  const files = sourceFiles(srcRoot).filter((file) => /(^|\/)m12-e2e[^/]*\.ts$/.test(file))
  assert.ok(files.length >= 6, `expected the M12 e2e modules, found: ${files.join(', ')}`)
  for (const file of files) {
    const bytes = bytesOf(file)
    console.log(`# ${file}: ${bytes} B / ${M12_SPLIT_HEADROOM_BYTES} B`)
    assert.ok(bytes <= M12_SPLIT_HEADROOM_BYTES, `${file} is ${bytes} B, over the ${M12_SPLIT_HEADROOM_BYTES} B split target`)
  }
})

test('the review-tool split keeps src/tools.ts well below the limit', () => {
  const toolsBytes = bytesOf('src/tools.ts')
  const reviewBytes = bytesOf('src/review-tools.ts')
  // Visible in the test output so the budget is observable, not just asserted.
  console.log(`# src/tools.ts: ${toolsBytes} B / ${READ_LIMIT_BYTES} B`)
  console.log(`# src/review-tools.ts: ${reviewBytes} B / ${READ_LIMIT_BYTES} B`)
  assert.ok(
    reviewBytes <= READ_LIMIT_BYTES,
    `src/review-tools.ts is ${reviewBytes} B, over the ${READ_LIMIT_BYTES} B read limit`,
  )
  assert.ok(
    toolsBytes <= TOOLS_SPLIT_HEADROOM_BYTES,
    `src/tools.ts is ${toolsBytes} B, expected at most ${TOOLS_SPLIT_HEADROOM_BYTES} B after the review-tool split`,
  )
})

test('the two review tools register from src/review-tools.ts, not src/tools.ts', () => {
  const toolsSource = readFileSync(resolve(root, 'src/tools.ts'), 'utf8')
  const reviewSource = readFileSync(resolve(root, 'src/review-tools.ts'), 'utf8')
  assert.match(toolsSource, /registerReviewTools\(/, 'src/tools.ts must call registerReviewTools')
  for (const name of ['cowork_review_request', 'cowork_review_verdict']) {
    assert.ok(
      reviewSource.includes(`name: '${name}'`),
      `src/review-tools.ts must register ${name}`,
    )
    assert.ok(
      !toolsSource.includes(`name: '${name}'`),
      `src/tools.ts must not register ${name} directly any more`,
    )
  }
  // A one-way dependency: review-tools receives its helpers, it never imports
  // them; the request model (not the retired review.ts) is its one review import.
  assert.ok(
    !reviewSource.includes("'./tools.js'"),
    'src/review-tools.ts must not import src/tools.ts (would create a runtime cycle)',
  )
  assert.ok(
    !reviewSource.includes("'./review.js'"),
    'src/review-tools.ts must not import the retired review.js',
  )
  assert.ok(
    reviewSource.includes("'./review-request.js'"),
    'the review tools must use the request model',
  )
})

test('the tool split owns every tool name and keeps tools.ts orchestration-only', () => {
  const source = (file) => readFileSync(resolve(root, file), 'utf8')
  const toolsSource = source('src/tools.ts')
  const domains = TOOL_DOMAINS.map(([file, names]) => [file, source(file), names])
  for (const [file, domainSource, names] of domains) {
    for (const name of names) {
      assert.ok(domainSource.includes(`name: '${name}'`), `${file} must register ${name}`)
      assert.ok(!toolsSource.includes(`name: '${name}'`), `src/tools.ts must not register ${name} directly`)
    }
  }
  for (const call of ['registerProjectTools', 'registerRouteTools', 'registerTopicTools', 'registerRequestTools', 'registerWorkItemTools', 'registerReviewTools', 'registerMemoryTools', 'registerCheckoutTools']) {
    assert.match(toolsSource, new RegExp(`${call}\\(`), `src/tools.ts must call ${call}`)
  }

  const budgets = [
    ['src/tools.ts', TOOLS_SPLIT_HEADROOM_BYTES],
    ['src/tool-runtime.ts', READ_LIMIT_BYTES],
    ['src/llm-port.ts', READ_LIMIT_BYTES],
    ['src/project-tools.ts', READ_LIMIT_BYTES],
    ['src/topic-tools.ts', READ_LIMIT_BYTES],
    ['src/request-tools.ts', READ_LIMIT_BYTES],
    ['src/request-service.ts', READ_LIMIT_BYTES],
    ['src/request-store.ts', READ_LIMIT_BYTES],
    ['src/request-schema.ts', READ_LIMIT_BYTES],
    ['src/inbox-api.ts', READ_LIMIT_BYTES],
    ['src/route-tools.ts', READ_LIMIT_BYTES],
    ['src/memory-tools.ts', READ_LIMIT_BYTES],
    ['src/checkout-tools.ts', READ_LIMIT_BYTES],
    ['src/checkout-teardown.ts', READ_LIMIT_BYTES],
    ['src/work-item.ts', READ_LIMIT_BYTES],
    ['src/review-request.ts', READ_LIMIT_BYTES],
    ['src/review-tools.ts', READ_LIMIT_BYTES],
    ['src/session-visibility.ts', READ_LIMIT_BYTES],
  ]
  for (const [file, limit] of budgets) {
    const bytes = bytesOf(file)
    console.log(`# ${file}: ${bytes} B / ${limit} B`)
    assert.ok(bytes <= limit, `${file} is ${bytes} B, over the ${limit} B budget`)
  }
})

test('the request-service split keeps its entry point a thin re-export', () => {
  const entry = readFileSync(resolve(root, 'src/request-service.ts'), 'utf8')
  assert.ok(
    Buffer.byteLength(entry, 'utf8') <= 30 * 1024,
    `src/request-service.ts is ${Buffer.byteLength(entry, 'utf8')} B; the split target is 30 KiB`,
  )
  const lifecycle = readFileSync(resolve(root, 'src/request-lifecycle.ts'), 'utf8')
  const open = readFileSync(resolve(root, 'src/request-open.ts'), 'utf8')
  const decision = readFileSync(resolve(root, 'src/authorization-decision.ts'), 'utf8')
  assert.match(lifecycle, /export async function createRequest\(/)
  assert.match(lifecycle, /export async function resolveRequest\(/)
  assert.match(decision, /export async function resolveAuthorizationDecision\(/)
  assert.match(decision, /export async function settleAuthorizationRequestRecord\(/)
  assert.match(open, /export async function openRequestTarget\(/)
  // The entry point only re-exports: no implementation lives there any more.
  assert.equal(/\basync function |\bfunction /m.test(entry), false, 'src/request-service.ts holds no implementation')
  assert.match(entry, /export \{ createRequest, promptRequestTopic, resolveRequest \}/)
  assert.match(entry, /export \{ openRequestTarget \}/)
  assert.match(entry, /export \{\s*\n  resolveAuthorizationDecision,\s*\n  settleAuthorizationRequestRecord,/)
})

test('the legacy keyword router is gone and nothing imports it', () => {
  assert.equal(existsSync(resolve(root, 'src/router.ts')), false, 'src/router.ts must be deleted')
  for (const file of sourceFiles(srcRoot)) {
    const text = readFileSync(resolve(root, file), 'utf8')
    assert.ok(!text.includes("'./router.js'"), `${file} still imports ./router.js`)
    assert.ok(!text.includes("'../src/router.ts'"), `${file} still imports src/router.ts`)
  }
})


test('the host LLM adapter lives in src/llm-port.ts', () => {
  const source = (file) => readFileSync(resolve(root, file), 'utf8')
  const indexSource = source('src/index.ts')
  const portSource = source('src/llm-port.ts')

  assert.match(indexSource, /createLlmRoutingPort\(/, 'src/index.ts must use the extracted adapter')
  assert.ok(
    !indexSource.includes("role: 'system'") && !indexSource.includes("role: 'user'"),
    'src/index.ts must not build model messages inline',
  )
  assert.match(portSource, /system: request\.systemPrompt/, 'the system prompt is top-level')
  assert.match(portSource, /content: \[\{ type: 'text', text: request\.userPrompt \}\]/, 'the user body is a text block array')
  assert.match(portSource, /signal,/)
})

// ---------------------------------------------------------------------------
// M10.4b ownership and the KI-18/24/25 close-out guards
// ---------------------------------------------------------------------------

test('the work-item, review-request, and session modules own rules, not tool names', () => {
  const source = (file) => readFileSync(resolve(root, file), 'utf8')
  const ownerships = [
    ['src/work-item.ts', ['createWorkItem', 'captureWorkItemHead', 'activeWorkItemCount']],
    ['src/review-request.ts', ['validateReviewRequestInput', 'mergeGate', 'buildReviewBrief']],
    ['src/session-visibility.ts', ['createReviewerSession', 'archiveReviewerAfterVerdict', 'reviewerSessionIds']],
  ]
  for (const [file, symbols] of ownerships) {
    const text = source(file)
    for (const symbol of symbols) {
      assert.match(
        text,
        new RegExp(`export (async )?(function|const) ${symbol}\\b`),
        `${file} must export ${symbol}`,
      )
    }
    assert.equal(/name: 'cowork_/.test(text), false, `${file} must not register a tool (src/checkout-tools.ts does)`)
  }
  // The two isolation tools are registered by the module that also owns the
  // merge flow, not by their domain modules.
  assert.match(source('src/checkout-tools.ts'), /export function registerWorkItemTools\(/)
  assert.match(source('src/checkout-tools.ts'), /export function registerCheckoutTools\(/)
})

test('KI-25/KI-18: no legacy review writes, and the legacy read-only surface stays', () => {
  const source = (file) => readFileSync(resolve(root, file), 'utf8')
  const reviewTools = source('src/review-tools.ts')

  // The legacy index/thread review attachment fields are never written by the
  // new tools. (`reviewedAt` does exist on the request record itself, which is
  // the file this model owns, so only the legacy pointer fields are pinned.)
  assert.equal(reviewTools.includes('latestReviewPath'), false)
  assert.equal(reviewTools.includes('reviewRequestedAt'), false)
  assert.equal(/awaiting_review/.test(reviewTools), false)

  // The handoff state machine is narrowed, and the personas carry no legacy
  // review orchestration or merge override.
  assert.match(source('src/topic-tools.ts'), /enum: \['blocked', 'done'\]/)
  assert.equal(/awaiting_review/.test(source('src/topic-tools.ts')), false)
  assert.equal(/awaiting_review/.test(source('src/presets.ts')), false)
  assert.equal(/allowUnreviewed|overrideReason/.test(source('src/presets.ts')), false)
  assert.equal(/checkLegacyThreadMerge[\s\S]*allowUnreviewed/.test(source('src/review-request.ts')), false)

  // Legacy readers stay through the 0.2.0 compatibility window (KI-18).
  for (const file of ['src/api.ts', 'src/api-contract.ts', 'src/store-migration.ts']) {
    assert.equal(existsSync(resolve(root, file)), true, `${file} must stay for the 0.2.0 window`)
  }
})
