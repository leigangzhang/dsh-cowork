import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import './support/ts-hook.mjs'
import { makeTopicFixture } from './support/inbox-fixtures.mjs'
import {
  ALIAS_MAX_ITEMS,
  ALIAS_MAX_LENGTH,
  ROUTE_MAX_CANDIDATES,
  ROUTE_MARGIN,
  ROUTE_NEW_TOPIC_SIGNALS,
  ROUTE_THRESHOLD,
  TOPIC_TITLE_MAX_CHARS,
  applyRouteCorrection,
  decideExplicitRoute,
  decideRoute,
  routeCreateTitle,
  tokenize,
  withRouteTargets,
} from '../src/domains/routing/routing.ts'

/**
 * Contract tests for the pure M9.1 routing core (`src/domains/routing/routing.ts`).
 *
 * Every fixture is an in-memory v2 topic; nothing here touches `.dsh-cowork/`.
 * The scores and reasons are pinned exactly: the third layer and the panel will
 * explain decisions from these values, so a silent weight change must turn a
 * test red.
 *
 * The final block loads `src/index.ts` (Config defaults / `normalizeConfig`)
 * through the same transform hook `tests/dev-gate.test.mjs` uses: the plugin
 * assembly uses TypeScript parameter properties, which strip-only mode rejects.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const NOW_MS = Date.parse('2026-11-08T00:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()

/** A routable v2 topic; by default it is stale and matches nothing. */
const topic = makeTopicFixture({
  topicId: 'topic-a',
  title: '',
  createdAt: iso(NOW_MS - 30 * DAY_MS),
  updatedAt: iso(NOW_MS - 30 * DAY_MS),
  lastActiveAt: iso(NOW_MS - 30 * DAY_MS),
})

/** A route context with no locality hints. */
const context = (overrides = {}) => ({
  nowMs: NOW_MS,
  focusTopicId: null,
  lastRouteTopicId: null,
  ...overrides,
})

const documentV2 = (overrides = {}) => ({
  version: 2,
  projectId: 'project-1',
  masterSessionId: 'session-master',
  createdAt: '2026-11-05T03:04:05.006Z',
  topics: [],
  workItems: [],
  ...overrides,
})

test('the exported constants are the documented values', () => {
  assert.equal(ROUTE_MAX_CANDIDATES, 3)
  assert.equal(TOPIC_TITLE_MAX_CHARS, 24)
  assert.equal(ALIAS_MAX_ITEMS, 50)
  assert.ok(ROUTE_THRESHOLD > 0)
  assert.ok(ROUTE_MARGIN > 0)
})

test('tokenize lowercases ASCII words and splits on punctuation', () => {
  assert.deepEqual(tokenize('Hello, World 42!'), ['hello', 'world', '42'])
  assert.deepEqual(tokenize('foo_bar/baz'), ['foo', 'bar', 'baz'])
  assert.deepEqual(tokenize('   '), [])
  assert.deepEqual(tokenize(''), [])
  assert.deepEqual(tokenize('Bug bug BUG fix'), ['bug', 'fix'], 'dedupe keeps the first occurrence')
})

test('tokenize turns CJK runs into bigrams and keeps lone characters', () => {
  assert.deepEqual(tokenize('修复路由'), ['修复', '复路', '路由'])
  assert.deepEqual(tokenize('修复 路由'), ['修复', '路由'])
  assert.deepEqual(tokenize('看'), ['看'])
  assert.deepEqual(tokenize('修复 router bug'), ['修复', 'router', 'bug'])
})

// ---------------------------------------------------------------------------
// Layer 1: locality
// ---------------------------------------------------------------------------

test('layer 1 reuses the focus topic without scoring it', () => {
  const topics = [topic({ topicId: 'focus', title: '修复路由' })]
  const decision = decideRoute('继续', topics, context({ focusTopicId: 'focus' }))
  assert.equal(decision.action, 'reuse')
  assert.equal(decision.topicId, 'focus')
  assert.equal(decision.reason, 'layer1:focus-topic')
  assert.deepEqual(decision.candidates, [], 'the first layer does not score')
})

test('layer 1 reuses an idle focus topic', () => {
  const topics = [topic({ topicId: 'focus', status: 'idle' })]
  const decision = decideRoute('继续', topics, context({ focusTopicId: 'focus' }))
  assert.equal(decision.action, 'reuse')
  assert.equal(decision.reason, 'layer1:focus-topic')
})

test('layer 1 reuses the last route target when there is no focus', () => {
  const topics = [topic({ topicId: 'last', status: 'idle' })]
  const decision = decideRoute('继续', topics, context({ lastRouteTopicId: 'last' }))
  assert.equal(decision.action, 'reuse')
  assert.equal(decision.topicId, 'last')
  assert.equal(decision.reason, 'layer1:last-route')
})

test('a resolved focus topic is never continued', () => {
  const topics = [topic({ topicId: 'focus', status: 'resolved' })]
  const decision = decideRoute('继续', topics, context({ focusTopicId: 'focus' }))
  assert.equal(decision.action, 'create')
  assert.equal(decision.reason, 'layer2:no-candidates')
  assert.deepEqual(decision.candidates, [])
})

test('an unknown or null locality id falls through to layer 2', () => {
  const topics = [topic({ topicId: 'topic-a', title: '修复路由' })]
  const decision = decideRoute('修复路由', topics, context({ focusTopicId: 'missing', lastRouteTopicId: null }))
  assert.equal(decision.action, 'reuse')
  assert.equal(decision.topicId, 'topic-a')
  assert.match(decision.reason, /^layer2:/)
})

for (const signal of ['新开一个', '新建', '换个主题', '换个模块', '另一个主题']) {
  test(`the new-topic signal "${signal}" bypasses layer 1`, () => {
    const topics = [topic({ topicId: 'focus', title: '修复路由' })]
    const decision = decideRoute(`${signal} 修复路由`, topics, context({ focusTopicId: 'focus' }))
    assert.match(decision.reason, /^layer2:/, 'layer 1 must not claim a new-topic intent')
    assert.ok(ROUTE_NEW_TOPIC_SIGNALS.includes(signal))
  })
}

// ---------------------------------------------------------------------------
// Layer 2: structured scoring
// ---------------------------------------------------------------------------

test('layer 2 never offers a resolved topic as a candidate', () => {
  const topics = [
    topic({ topicId: 'done', title: '修复路由', status: 'resolved' }),
    topic({ topicId: 'live', title: '无关', status: 'active' }),
  ]
  const decision = decideRoute('修复路由', topics, context())
  assert.equal(decision.action, 'create')
  assert.deepEqual(decision.candidates, [])
})

test('a named path scores and explains itself', () => {
  const topics = [topic({ ownedPaths: ['src/store.ts'] })]
  const decision = decideRoute('修改 src/store.ts 的锁', topics, context())
  assert.equal(decision.action, 'create')
  assert.equal(decision.reason, 'layer2:below-threshold(score=3)')
  assert.equal(decision.candidates.length, 1)
  assert.equal(decision.candidates[0].score, 3)
  assert.deepEqual(decision.candidates[0].reasons, ['path:src/store.ts'])
})

test('an alias match cannot fire on a word that merely contains it', () => {
  const topics = [topic({ aliases: ['store'] })]
  const decision = decideRoute('restore the backup', topics, context())
  assert.deepEqual(decision.candidates, [], 'alias matching compares tokens, not substrings')
})

test('an alias scores and explains itself', () => {
  const topics = [topic({ aliases: ['路由'] })]
  const decision = decideRoute('路由怎么配', topics, context())
  assert.equal(decision.action, 'create')
  assert.deepEqual(decision.candidates[0].reasons, ['alias:路由'])
  assert.equal(decision.candidates[0].score, 3)
})

test('title overlap scores per token and reuses a clear winner', () => {
  const topics = [topic({ title: '修复路由' })]
  const decision = decideRoute('修复路由', topics, context())
  assert.equal(decision.action, 'reuse')
  assert.equal(decision.topicId, 'topic-a')
  assert.equal(decision.reason, 'layer2:top-candidate(score=6,margin=6)')
  assert.deepEqual(decision.candidates[0].reasons, [
    'title-overlap:修复',
    'title-overlap:复路',
    'title-overlap:路由',
  ])
})

test('scope and digest tokens score with their own reasons', () => {
  const scopeDecision = decideRoute('billing 对账', [topic({ scope: 'billing' })], context())
  assert.deepEqual(scopeDecision.candidates[0].reasons, ['scope:billing'])
  assert.equal(scopeDecision.candidates[0].score, 2)

  const digestDecision = decideRoute('发票 对账', [topic({ digest: '发票 对账' })], context())
  assert.deepEqual(digestDecision.candidates[0].reasons, ['digest:发票', 'digest:对账'])
  assert.equal(digestDecision.candidates[0].score, 2)
})

test('scoring is deterministic and breaks ties by topicId', () => {
  const topics = [
    topic({ topicId: 'topic-b', title: '修复路由' }),
    topic({ topicId: 'topic-a', title: '修复路由' }),
  ]
  const first = decideRoute('修复路由', topics, context())
  const second = decideRoute('修复路由', topics, context())
  assert.deepEqual(first, second)
  assert.deepEqual(first.candidates.map((candidate) => candidate.topicId), ['topic-a', 'topic-b'])
})

test('a score below the threshold creates instead of reusing', () => {
  const decision = decideRoute('src/store.ts', [topic({ ownedPaths: ['src/store.ts'] })], context())
  assert.ok(decision.candidates[0].score < ROUTE_THRESHOLD)
  assert.equal(decision.action, 'create')
})

test('a tie above the threshold asks the model with the tied candidates', () => {
  const topics = [
    topic({ topicId: 'topic-b', title: 'alpha beta' }),
    topic({ topicId: 'topic-a', title: 'alpha beta' }),
  ]
  const decision = decideRoute('alpha beta', topics, context())
  assert.equal(decision.action, 'needs_model')
  assert.equal(decision.reason, 'layer2:ambiguous(score=4,margin=0)')
  assert.deepEqual(decision.candidates.map((candidate) => candidate.topicId), ['topic-a', 'topic-b'])
  assert.deepEqual(decision.candidates.map((candidate) => candidate.score), [4, 4])
})

test('the model layer receives at most three candidates', () => {
  const topics = ['t1', 't2', 't3', 't4', 't5'].map((topicId) =>
    topic({ topicId, title: 'alpha beta' }),
  )
  const decision = decideRoute('alpha beta', topics, context())
  assert.equal(decision.action, 'needs_model')
  assert.equal(decision.candidates.length, ROUTE_MAX_CANDIDATES)
  assert.deepEqual(decision.candidates.map((candidate) => candidate.topicId), ['t1', 't2', 't3'])
})

test('recency is the only clock term: it wins a tie inside the window', () => {
  const recent = topic({
    topicId: 'recent',
    title: 'alpha beta',
    updatedAt: iso(NOW_MS - 1 * DAY_MS),
  })
  const stale = topic({
    topicId: 'stale',
    title: 'alpha beta',
    updatedAt: iso(NOW_MS - 30 * DAY_MS),
  })
  const decision = decideRoute('alpha beta', [stale, recent], context())
  assert.equal(decision.action, 'needs_model', 'half a point is less than the margin')
  assert.deepEqual(
    decision.candidates.map((candidate) => [candidate.topicId, candidate.score, candidate.reasons]),
    [
      ['recent', 4.5, ['title-overlap:alpha', 'title-overlap:beta', 'recency']],
      ['stale', 4, ['title-overlap:alpha', 'title-overlap:beta']],
    ],
  )

  const staleOnly = decideRoute('alpha beta', [stale], context())
  assert.deepEqual(staleOnly.candidates[0].reasons, ['title-overlap:alpha', 'title-overlap:beta'])
})

test('recency alone never makes a candidate', () => {
  const topics = [topic({ topicId: 'fresh', updatedAt: iso(NOW_MS - 1 * DAY_MS) })]
  const decision = decideRoute('完全无关', topics, context())
  assert.equal(decision.action, 'create')
  assert.deepEqual(decision.candidates, [])
})

// ---------------------------------------------------------------------------
// Explicit topic id
// ---------------------------------------------------------------------------

test('an explicit topic that does not exist returns null', () => {
  assert.equal(decideExplicitRoute('missing', [topic()]), null)
})

test('an explicit resolved topic is reported as resolved_match', () => {
  const topics = [topic({ topicId: 'done', title: '修复路由', status: 'resolved' })]
  const decision = decideExplicitRoute('done', topics)
  assert.equal(decision.action, 'resolved_match')
  assert.equal(decision.topicId, undefined)
  assert.deepEqual(decision.resolvedMatch, { topicId: 'done', title: '修复路由' })
  assert.equal(decision.reason, 'explicit:resolved')
  assert.deepEqual(decision.candidates, [])
})

test('an explicit live topic is reused even when its score would be low', () => {
  const topics = [topic({ topicId: 'live', title: '完全无关', status: 'idle' })]
  const decision = decideExplicitRoute('live', topics)
  assert.equal(decision.action, 'reuse')
  assert.equal(decision.topicId, 'live')
  assert.equal(decision.reason, 'explicit:topic')
})

// ---------------------------------------------------------------------------
// Correction learning
// ---------------------------------------------------------------------------

test('a correction appends intent tokens to aliases only', () => {
  const original = topic({ aliases: ['路由'], updatedAt: iso(NOW_MS - 2 * DAY_MS) })
  const corrected = applyRouteCorrection(original, '修复路由 bug')
  assert.deepEqual(corrected.aliases, ['路由', '修复', '复路', 'bug'])
  assert.deepEqual(original.aliases, ['路由'], 'the input topic is never mutated')
  assert.deepEqual({ ...corrected, aliases: original.aliases }, original, 'every other field is untouched')
  assert.equal(corrected.updatedAt, original.updatedAt)
  assert.equal(corrected.status, original.status)
})

test('a correction skips aliases that are already known or too short', () => {
  const original = topic({ aliases: ['bug', '修复'] })
  const corrected = applyRouteCorrection(original, 'bug 修复 a 复路')
  assert.deepEqual(corrected.aliases, ['bug', '修复', '复路'])
})

test('a correction bounds one alias by its maximum length', () => {
  const longEnough = 'x'.repeat(ALIAS_MAX_LENGTH)
  const tooLong = 'y'.repeat(ALIAS_MAX_LENGTH + 1)
  const corrected = applyRouteCorrection(topic(), `${longEnough} ${tooLong}`)
  assert.deepEqual(corrected.aliases, [longEnough])
})

test('a correction adds at most eight aliases per call', () => {
  const intent = Array.from({ length: 12 }, (_, index) => `word${index}`).join(' ')
  const corrected = applyRouteCorrection(topic(), intent)
  assert.equal(corrected.aliases.length, 8)
})

test('a correction never grows the alias list past its maximum', () => {
  const full = Array.from({ length: ALIAS_MAX_ITEMS - 1 }, (_, index) => `old${index}`)
  const corrected = applyRouteCorrection(topic({ aliases: full }), 'one two three')
  assert.equal(corrected.aliases.length, ALIAS_MAX_ITEMS)
  assert.deepEqual(corrected.aliases.slice(-1), ['one'])

  const alreadyFull = topic({ aliases: Array.from({ length: ALIAS_MAX_ITEMS }, (_, index) => `old${index}`) })
  assert.equal(applyRouteCorrection(alreadyFull, 'new-token'), alreadyFull, 'no room means no change')
})

// ---------------------------------------------------------------------------
// Automatic titles
// ---------------------------------------------------------------------------

test('an automatic title folds whitespace and keeps 24 code points', () => {
  assert.equal(routeCreateTitle('  第一行\n\n第二行\t第三行  '), '第一行 第二行 第三行')
  assert.equal(routeCreateTitle('a\nb'), 'a b')
  assert.equal(routeCreateTitle('一'.repeat(30)), '一'.repeat(24))
  assert.equal(Array.from(routeCreateTitle('😀'.repeat(30))).length, 24, 'surrogate pairs are not split')
})

test('an empty intent gets a fixed title', () => {
  assert.equal(routeCreateTitle(''), '未命名主题')
  assert.equal(routeCreateTitle(' \n\t '), '未命名主题')
})

// ---------------------------------------------------------------------------
// Routing targets on the document envelope
// ---------------------------------------------------------------------------

test('withRouteTargets sets only the given targets and keeps the envelope', () => {
  const base = documentV2({ writer: '0.1.0' })
  const next = withRouteTargets(base, { focusTopicId: 'topic-a', lastRouteTopicId: 'topic-b' })
  assert.equal(next.masterFocusTopicId, 'topic-a')
  assert.equal(next.lastRouteTopicId, 'topic-b')
  assert.equal(next.projectId, base.projectId)
  assert.equal(next.masterSessionId, base.masterSessionId)
  assert.equal(next.createdAt, base.createdAt)
  assert.deepEqual(next.topics, base.topics)
  assert.deepEqual(next.workItems, base.workItems)
  assert.equal(next.writer, '0.1.0')
  assert.equal('masterFocusTopicId' in base, false, 'the input document is not mutated')
})

test('withRouteTargets leaves relative targets unchanged', () => {
  const base = documentV2({ masterFocusTopicId: 'focus-a', lastRouteTopicId: 'last-b' })
  const next = withRouteTargets(base, { lastRouteTopicId: 'last-c' })
  assert.equal(next.masterFocusTopicId, 'focus-a')
  assert.equal(next.lastRouteTopicId, 'last-c')
  assert.notEqual(next, base)

  const untouched = withRouteTargets(base, {})
  assert.deepEqual(untouched, base)
})

test('withRouteTargets clears a target with null', () => {
  const base = documentV2({ masterFocusTopicId: 'focus-a', lastRouteTopicId: 'last-b' })
  const next = withRouteTargets(base, { focusTopicId: null, lastRouteTopicId: null })
  assert.equal(next.masterFocusTopicId, null)
  assert.equal(next.lastRouteTopicId, null)
})

test('withRouteTargets refuses an empty or non-string target', () => {
  for (const value of ['', '   ', 42, {}, []]) {
    assert.throws(
      () => withRouteTargets(documentV2(), { focusTopicId: value }),
      /focusTopicId must be a non-empty string or null/,
    )
    assert.throws(
      () => withRouteTargets(documentV2(), { lastRouteTopicId: value }),
      /lastRouteTopicId must be a non-empty string or null/,
    )
  }
})

// ---------------------------------------------------------------------------
// Purity and configuration defaults
// ---------------------------------------------------------------------------

test('src/domains/routing/routing.ts reads no clock, no randomness, and no I/O', () => {
  const source = readFileSync(new URL('../src/domains/routing/routing.ts', import.meta.url), 'utf8')
  for (const forbidden of [/Date\.now\s*\(/, /new\s+Date\s*\(/, /Math\.random\s*\(/, /node:/, /from ['"]fs['"]/, /process\./]) {
    assert.equal(forbidden.test(source), false, `routing.ts must not contain ${forbidden}`)
  }
})

const { Config, normalizeConfig } = await import('../src/index.ts')

test('the Config schema defaults match PLAN-V0.2 §5.10', () => {
  const parsed = Config({})
  assert.equal(parsed.repoPath, '')
  assert.equal(parsed.enableDevRoutes, false)
  assert.equal(parsed.idleAfterMs, 86_400_000, 'the topic page idles after one day')
  // Deprecated and ignored by the lifecycle, but still accepted by the schema so
  // an existing profile keeps loading.
  assert.equal(parsed.resolveAfterMs, 259_200_000)
  assert.deepEqual(parsed.routing, {
    enabled: true,
    provider: '',
    model: '',
    effort: '',
    timeoutMs: 2_000,
    maxTokens: 256,
  })
})

test('the Config schema keeps explicit values and fills nested defaults', () => {
  const parsed = Config({ idleAfterMs: 5, routing: { enabled: false } })
  assert.equal(parsed.idleAfterMs, 5)
  assert.equal(parsed.routing.enabled, false)
  assert.equal(parsed.routing.timeoutMs, 2_000, 'a partial routing object still gets its defaults')
  assert.equal(parsed.routing.maxTokens, 256)
})

test('normalizeConfig tolerates a hand-built partial config', () => {
  const normalized = normalizeConfig({})
  assert.deepEqual(normalized, {
    repoPath: '',
    promptTimeoutMs: 120_000,
    storeRelativePath: '.dsh-cowork/probe/store.json',
    worktreeRelativePath: '.dsh-cowork/worktrees/probe',
    enableDevRoutes: false,
    idleAfterMs: 86_400_000,
    resolveAfterMs: 259_200_000,
    routing: {
      enabled: true,
      provider: '',
      model: '',
      effort: '',
      timeoutMs: 2_000,
      maxTokens: 256,
    },
    // M10.1: the isolation and reviewer settings carry their own defaults.
    isolation: { provider: 'clone' },
    reviewer: { reclaim: 'after-verdict' },
  })

  const partial = normalizeConfig({ repoPath: '/repo', promptTimeoutMs: 60_000, routing: null })
  assert.equal(partial.repoPath, '/repo')
  assert.equal(partial.promptTimeoutMs, 60_000)
  assert.equal(partial.routing.enabled, true)
  assert.equal(partial.routing.timeoutMs, 2_000)
})
