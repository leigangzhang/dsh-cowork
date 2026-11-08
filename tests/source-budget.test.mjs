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
  const domains = [
    ['src/project-tools.ts', source('src/project-tools.ts'), ['cowork_project_init', 'cowork_project_status']],
    ['src/topic-tools.ts', source('src/topic-tools.ts'), ['cowork_topic_create', 'cowork_thread_create', 'cowork_topic_list', 'cowork_thread_list', 'cowork_handoff', 'cowork_topic_resolve']],
    ['src/route-tools.ts', source('src/route-tools.ts'), ['cowork_route']],
    ['src/memory-tools.ts', source('src/memory-tools.ts'), ['cowork_memory_write', 'cowork_memory_search']],
    ['src/checkout-tools.ts', source('src/checkout-tools.ts'), ['cowork_work_item_create', 'cowork_checkout_merge']],
    ['src/review-tools.ts', source('src/review-tools.ts'), ['cowork_review_request', 'cowork_review_verdict']],
  ]
  for (const [file, domainSource, names] of domains) {
    for (const name of names) {
      assert.ok(domainSource.includes(`name: '${name}'`), `${file} must register ${name}`)
      assert.ok(!toolsSource.includes(`name: '${name}'`), `src/tools.ts must not register ${name} directly`)
    }
  }
  for (const call of ['registerProjectTools', 'registerRouteTools', 'registerTopicTools', 'registerWorkItemTools', 'registerReviewTools', 'registerMemoryTools', 'registerCheckoutTools']) {
    assert.match(toolsSource, new RegExp(`${call}\\(`), `src/tools.ts must call ${call}`)
  }

  const budgets = [
    ['src/tools.ts', TOOLS_SPLIT_HEADROOM_BYTES],
    ['src/tool-runtime.ts', READ_LIMIT_BYTES],
    ['src/llm-port.ts', READ_LIMIT_BYTES],
    ['src/project-tools.ts', READ_LIMIT_BYTES],
    ['src/topic-tools.ts', READ_LIMIT_BYTES],
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

test('KI-24: the read point counts real work items, not a fixed zero', () => {
  const source = (file) => readFileSync(resolve(root, file), 'utf8')
  const projectSource = source('src/project-tools.ts')
  const routeSource = source('src/route-tools.ts')
  const runtimeSource = source('src/tool-runtime.ts')

  assert.match(projectSource, /activeWorkItemsOf/)
  assert.match(routeSource, /activeWorkItemsOf/)
  assert.match(runtimeSource, /activeWorkItemsOf/)
  for (const [file, text] of [['src/project-tools.ts', projectSource], ['src/route-tools.ts', routeSource], ['src/tool-runtime.ts', runtimeSource]]) {
    assert.equal(/activeWorkItems: 0/.test(text), false, `${file} must not pass a fixed zero`)
    assert.equal(/activeWorkItems\?: number/.test(text), false, `${file} must not take a fixed count option`)
  }
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

  // Legacy readers and dev runners stay until M11/M12 replace them.
  for (const file of ['src/api.ts', 'src/api-contract.ts', 'src/m2-e2e.ts', 'src/m3-e2e.ts', 'src/store-migration.ts']) {
    assert.equal(existsSync(resolve(root, file)), true, `${file} must stay for M11/M12`)
  }
  assert.match(source('src/tools.ts'), /M11/)
  assert.match(source('src/tools.ts'), /M12/)
})
