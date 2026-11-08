import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

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

/** Headroom the tools split must keep on src/tools.ts; 48 KiB leaves 2 KiB. */
const TOOLS_SPLIT_HEADROOM_BYTES = 49_152

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

/** Bytes on disk for one repo-relative path. */
function bytesOf(file) {
  return statSync(resolve(root, file)).size
}

test('every src/**/*.ts and src/**/*.tsx file stays under the 50 KiB read limit', () => {
  const files = sourceFiles(srcRoot)
  assert.ok(files.length > 0, 'no .ts/.tsx files found under src/')
  const over = files
    .map((file) => ({ file, bytes: bytesOf(file) }))
    .filter(({ bytes }) => bytes > READ_LIMIT_BYTES)
  const detail = over.map(({ file, bytes }) => `${file}: ${bytes} B`).join(', ')
  assert.deepEqual(
    over.map(({ file }) => file),
    [],
    `${over.length} source file(s) exceed the ${READ_LIMIT_BYTES} B read limit: ${detail}`,
  )
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
  // A one-way dependency: review-tools receives its helpers, it never imports them.
  assert.ok(
    !reviewSource.includes("'./tools.js'"),
    'src/review-tools.ts must not import src/tools.ts (would create a runtime cycle)',
  )
})

test('the tool split owns every tool name and keeps tools.ts orchestration-only', () => {
  const source = (file) => readFileSync(resolve(root, file), 'utf8')
  const toolsSource = source('src/tools.ts')
  const domains = [
    ['src/project-tools.ts', source('src/project-tools.ts'), ['cowork_project_init', 'cowork_project_status']],
    ['src/topic-tools.ts', source('src/topic-tools.ts'), ['cowork_topic_create', 'cowork_thread_create', 'cowork_topic_list', 'cowork_thread_list', 'cowork_handoff', 'cowork_topic_resolve']],
    ['src/route-tools.ts', source('src/route-tools.ts'), ['cowork_route']],
    ['src/memory-tools.ts', source('src/memory-tools.ts'), ['cowork_memory_write', 'cowork_memory_search']],
    ['src/checkout-tools.ts', source('src/checkout-tools.ts'), ['cowork_checkout_merge']],
  ]
  for (const [file, domainSource, names] of domains) {
    for (const name of names) {
      assert.ok(domainSource.includes(`name: '${name}'`), `${file} must register ${name}`)
      assert.ok(!toolsSource.includes(`name: '${name}'`), `src/tools.ts must not register ${name} directly`)
    }
  }
  for (const call of ['registerProjectTools', 'registerTopicTools', 'registerRouteTools', 'registerMemoryTools', 'registerCheckoutTools', 'registerReviewTools']) {
    assert.match(toolsSource, new RegExp(`${call}\\(`), `src/tools.ts must call ${call}`)
  }

  const budgets = [
    ['src/tools.ts', TOOLS_SPLIT_HEADROOM_BYTES],
    ['src/tool-runtime.ts', READ_LIMIT_BYTES],
    ['src/project-tools.ts', READ_LIMIT_BYTES],
    ['src/topic-tools.ts', READ_LIMIT_BYTES],
    ['src/route-tools.ts', READ_LIMIT_BYTES],
    ['src/memory-tools.ts', READ_LIMIT_BYTES],
    ['src/checkout-tools.ts', READ_LIMIT_BYTES],
  ]
  for (const [file, limit] of budgets) {
    const bytes = bytesOf(file)
    console.log(`# ${file}: ${bytes} B / ${limit} B`)
    assert.ok(bytes <= limit, `${file} is ${bytes} B, over the ${limit} B budget`)
  }
})

test('the legacy keyword router is gone and nothing imports it', () => {
  assert.equal(existsSync(resolve(root, 'src/router.ts')), false, 'src/router.ts must be deleted')
  for (const file of sourceFiles(srcRoot)) {
    const text = readFileSync(resolve(root, file), 'utf8')
    assert.ok(!text.includes("'./router.js'"), `${file} still imports ./router.js`)
    assert.ok(!text.includes("'../src/router.ts'"), `${file} still imports src/router.ts`)
  }
})

