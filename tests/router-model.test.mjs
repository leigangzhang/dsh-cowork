import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildRoutingUserPrompt,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_ROUTING_MAX_TOKENS,
  DEFAULT_ROUTING_TIMEOUT_MS,
  recommendWithModel,
  ROUTING_MODEL_ERROR_MAX_CHARS,
  ROUTING_MODEL_PROMPT_MAX_CHARS,
} from '../src/domains/routing/router-model.ts'

const SOURCE_URL = new URL('../src/domains/routing/router-model.ts', import.meta.url)

/** A fake port records every call; it never touches a host or the network. */
function recordingPort(reply) {
  const calls = []
  const port = {
    calls,
    async run(request, signal) {
      calls.push({ request, signal })
      if (typeof reply === 'function') return reply(request, signal)
      return reply
    },
  }
  return port
}

function makeConfig(overrides = {}) {
  return {
    enabled: true,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    effort: '',
    timeoutMs: 2000,
    maxTokens: 256,
    ...overrides,
  }
}

/** Candidates arrive already ordered by the structured layer, best first. */
function makeCandidates() {
  return [
    { topicId: 'topic-a', title: 'Store v2', scope: 'src/store.ts src/store-schema.ts', digest: 'v2 index writes' },
    { topicId: 'topic-b', title: 'Panel', scope: 'src/client/panel', digest: 'overview api' },
  ]
}

const INTENT = '把路由第三层的模型兜底接上'

test('source stays pure: no host imports, no network, no dynamic import', () => {
  const source = readFileSync(SOURCE_URL, 'utf8')
  assert.doesNotMatch(source, /^\s*import\s/m)
  assert.doesNotMatch(source, /\brequire\s*\(/)
  assert.doesNotMatch(source, /\bimport\s*\(/)
  assert.doesNotMatch(source, /\bfetch\s*\(/)
  assert.doesNotMatch(source, /@deepseek-ai\//)
  assert.doesNotMatch(source, /from\s+['"]node:/)
})

test('a disabled configuration never calls the port and falls back to the highest candidate', async () => {
  const port = recordingPort('{"topicId":"topic-b","confidence":0.9}')
  const outcome = await recommendWithModel({
    intent: INTENT,
    candidates: makeCandidates(),
    config: makeConfig({ enabled: false }),
    port,
  })

  assert.equal(port.calls.length, 0)
  assert.equal(outcome.action, 'fallback')
  assert.equal(outcome.modelUsed, false)
  assert.equal(outcome.topicId, 'topic-a')
  assert.equal(outcome.confidence, null)
  assert.match(outcome.modelError, /^disabled:/)
})

test('a blank provider or model never calls the port and reports unconfigured', async () => {
  for (const overrides of [{ provider: '  ' }, { model: '' }]) {
    const port = recordingPort('{"topicId":null,"confidence":0.5}')
    const outcome = await recommendWithModel({
      intent: INTENT,
      candidates: makeCandidates(),
      config: makeConfig(overrides),
      port,
    })

    assert.equal(port.calls.length, 0, `config ${JSON.stringify(overrides)} must not call the port`)
    assert.equal(outcome.action, 'fallback')
    assert.match(outcome.modelError, /^unconfigured:/)
  }
})

test('a missing port never throws and reports unavailable', async () => {
  const outcome = await recommendWithModel({
    intent: INTENT,
    candidates: makeCandidates(),
    config: makeConfig(),
  })

  assert.equal(outcome.action, 'fallback')
  assert.equal(outcome.topicId, 'topic-a')
  assert.match(outcome.modelError, /^unavailable:/)
})

test('a valid candidate reply reuses that candidate and records confidence', async () => {
  const port = recordingPort('{"topicId":"topic-b","confidence":0.42}')
  const outcome = await recommendWithModel({
    intent: INTENT,
    candidates: makeCandidates(),
    config: makeConfig(),
    port,
  })

  assert.equal(port.calls.length, 1)
  assert.deepEqual(outcome, { action: 'reuse', topicId: 'topic-b', confidence: 0.42, modelUsed: true })
})

test('a null topicId becomes a create decision with the recorded confidence', async () => {
  const port = recordingPort('{"topicId":null,"confidence":0.25}')
  const outcome = await recommendWithModel({
    intent: INTENT,
    candidates: makeCandidates(),
    config: makeConfig(),
    port,
  })

  assert.deepEqual(outcome, { action: 'create', topicId: null, confidence: 0.25, modelUsed: true })
})

test('a fenced or padded reply is accepted', async () => {
  const port = recordingPort('\n```json\n{"topicId": "topic-a", "confidence": 1}\n```\n')
  const outcome = await recommendWithModel({
    intent: INTENT,
    candidates: makeCandidates(),
    config: makeConfig(),
    port,
  })

  assert.equal(outcome.action, 'reuse')
  assert.equal(outcome.topicId, 'topic-a')
  assert.equal(outcome.confidence, 1)
})

test('the request carries provider, model, maxTokens, timeoutMs, and reasoning off by default', async () => {
  const port = recordingPort('{"topicId":null,"confidence":0.1}')
  await recommendWithModel({
    intent: INTENT,
    candidates: makeCandidates(),
    config: makeConfig({ maxTokens: 64, timeoutMs: 1500 }),
    port,
  })

  const { request, signal } = port.calls[0]
  assert.equal(request.provider, 'deepseek-official')
  assert.equal(request.model, 'deepseek-flash')
  assert.equal(request.maxTokens, 64)
  assert.equal(request.timeoutMs, 1500)
  assert.equal(request.reasoningEffort, 'off')
  assert.equal(request.reasoningEffort, DEFAULT_REASONING_EFFORT)
  assert.equal(typeof request.systemPrompt, 'string')
  assert.notEqual(request.systemPrompt.trim(), '')
  assert.equal(request.userPrompt, buildRoutingUserPrompt(INTENT, makeCandidates()))
  assert.ok(request.userPrompt.includes(INTENT))
  assert.ok(signal instanceof AbortSignal)
  assert.equal(signal.aborted, false)
})

test('an explicit effort overrides the off default', async () => {
  const port = recordingPort('{"topicId":null,"confidence":0.1}')
  await recommendWithModel({
    intent: INTENT,
    candidates: makeCandidates(),
    config: makeConfig({ effort: 'low' }),
    port,
  })

  assert.equal(port.calls[0].request.reasoningEffort, 'low')
})

test('non-positive numeric config falls back to the documented defaults', async () => {
  const port = recordingPort('{"topicId":null,"confidence":0.1}')
  await recommendWithModel({
    intent: INTENT,
    candidates: makeCandidates(),
    config: makeConfig({ maxTokens: 0, timeoutMs: -5 }),
    port,
  })

  assert.equal(port.calls[0].request.maxTokens, DEFAULT_ROUTING_MAX_TOKENS)
  assert.equal(port.calls[0].request.timeoutMs, DEFAULT_ROUTING_TIMEOUT_MS)
})

test('bad JSON falls back to the highest candidate without throwing', async () => {
  const port = recordingPort('sure, I think topic-a fits')
  const outcome = await recommendWithModel({
    intent: INTENT,
    candidates: makeCandidates(),
    config: makeConfig(),
    port,
  })

  assert.equal(port.calls.length, 1)
  assert.equal(outcome.action, 'fallback')
  assert.equal(outcome.topicId, 'topic-a')
  assert.match(outcome.modelError, /^bad-json:/)
})

test('wrong field types fall back as invalid replies', async () => {
  for (const reply of [
    '{"topicId":7,"confidence":0.5}',
    '{"topicId":"topic-a","confidence":"high"}',
    '{"confidence":0.5}',
    '{"topicId":"topic-a"}',
    '[]',
  ]) {
    const port = recordingPort(reply)
    const outcome = await recommendWithModel({
      intent: INTENT,
      candidates: makeCandidates(),
      config: makeConfig(),
      port,
    })

    assert.equal(outcome.action, 'fallback', `reply ${reply} must fall back`)
    assert.match(outcome.modelError, /^invalid-reply:/, `reply ${reply} must be invalid-reply`)
    assert.equal(outcome.topicId, 'topic-a')
  }
})

test('a topicId outside the candidate list falls back', async () => {
  const port = recordingPort('{"topicId":"topic-zzz","confidence":0.99}')
  const outcome = await recommendWithModel({
    intent: INTENT,
    candidates: makeCandidates(),
    config: makeConfig(),
    port,
  })

  assert.equal(outcome.action, 'fallback')
  assert.equal(outcome.topicId, 'topic-a')
  assert.match(outcome.modelError, /^topic-not-candidate:/)
})

test('a confidence outside 0..1 falls back', async () => {
  for (const confidence of [-0.01, 1.01, 42]) {
    const port = recordingPort(`{"topicId":"topic-b","confidence":${confidence}}`)
    const outcome = await recommendWithModel({
      intent: INTENT,
      candidates: makeCandidates(),
      config: makeConfig(),
      port,
    })

    assert.equal(outcome.action, 'fallback')
    assert.match(outcome.modelError, /^confidence-out-of-range:/)
  }
})

test('a port error falls back and keeps modelError bounded', async () => {
  const port = recordingPort(() => {
    throw new Error('socket hang up '.repeat(200))
  })
  const outcome = await recommendWithModel({
    intent: INTENT,
    candidates: makeCandidates(),
    config: makeConfig(),
    port,
  })

  assert.equal(outcome.action, 'fallback')
  assert.equal(outcome.modelUsed, false)
  assert.equal(outcome.topicId, 'topic-a')
  assert.match(outcome.modelError, /^port-error:/)
  assert.ok(outcome.modelError.length <= ROUTING_MODEL_ERROR_MAX_CHARS)
})

test('a slow port is aborted at timeoutMs and falls back in well under a second', async () => {
  const port = {
    calls: 0,
    run(_request, signal) {
      this.calls += 1
      // Abort-aware but never resolves on its own: the timeout must win.
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    },
  }
  const startedAt = Date.now()
  const outcome = await recommendWithModel({
    intent: INTENT,
    candidates: makeCandidates(),
    config: makeConfig({ timeoutMs: 25 }),
    port,
  })
  const elapsedMs = Date.now() - startedAt

  assert.equal(port.calls, 1)
  assert.equal(outcome.action, 'fallback')
  assert.equal(outcome.topicId, 'topic-a')
  assert.match(outcome.modelError, /^timeout:/)
  assert.ok(elapsedMs < 1000, `timeout must be bounded by the timer, took ${elapsedMs} ms`)
})

test('a port that ignores the abort signal still falls back at timeoutMs', async () => {
  const port = {
    run() {
      return new Promise((resolve) => setTimeout(() => resolve('{"topicId":null,"confidence":0.2}'), 500))
    },
  }
  const startedAt = Date.now()
  const outcome = await recommendWithModel({
    intent: INTENT,
    candidates: makeCandidates(),
    config: makeConfig({ timeoutMs: 20 }),
    port,
  })
  const elapsedMs = Date.now() - startedAt

  assert.equal(outcome.action, 'fallback')
  assert.match(outcome.modelError, /^timeout:/)
  assert.ok(elapsedMs < 1000, `race must win over the slow port, took ${elapsedMs} ms`)
})

test('without candidates a fallback targets a new topic', async () => {
  const port = recordingPort('not json')
  const outcome = await recommendWithModel({
    intent: INTENT,
    candidates: [],
    config: makeConfig(),
    port,
  })

  assert.equal(outcome.action, 'fallback')
  assert.equal(outcome.topicId, null)
})

test('buildRoutingUserPrompt keeps the intent and every candidate id inside 2000 chars', () => {
  const longIntent = `  ${'打开面板并检查主题列表\n'.repeat(400)}  `
  const candidates = [0, 1, 2].map((index) => ({
    topicId: `topic-${index}`,
    title: `Title ${index} `.repeat(200),
    scope: `src/module-${index}/file.ts `.repeat(300),
    digest: `digest ${index} `.repeat(300),
  }))

  const prompt = buildRoutingUserPrompt(longIntent, candidates)

  assert.ok(prompt.length <= ROUTING_MODEL_PROMPT_MAX_CHARS, `prompt is ${prompt.length} chars`)
  // The per-candidate budget is actually spent instead of dropping candidates.
  assert.ok(prompt.length > 1500, `prompt is only ${prompt.length} chars`)
  assert.ok(prompt.startsWith('Intent: '))
  assert.ok(prompt.includes('打开面板并检查主题列表'))
  for (const candidate of candidates) {
    assert.ok(prompt.includes(candidate.topicId), `prompt must name ${candidate.topicId}`)
  }
  assert.ok(prompt.includes('…'), 'oversized fields must be truncated with an ellipsis marker')
  // Deterministic: the same input always yields the same bytes.
  assert.equal(buildRoutingUserPrompt(longIntent, candidates), prompt)
})

test('buildRoutingUserPrompt caps the candidate list at three and tolerates empty input', () => {
  const candidates = [0, 1, 2, 3, 4].map((index) => ({
    topicId: `topic-${index}`,
    title: `t${index}`,
    scope: 'src/',
    digest: 'd',
  }))
  const prompt = buildRoutingUserPrompt('route me', candidates)

  assert.ok(prompt.includes('topic-2'))
  assert.equal(prompt.includes('topic-3'), false)
  assert.ok(buildRoutingUserPrompt('', []).length <= ROUTING_MODEL_PROMPT_MAX_CHARS)
  assert.ok(buildRoutingUserPrompt('', []).includes('(none)'))
})

test('a normal prompt stays well under the cap and shows the candidate fields', () => {
  const prompt = buildRoutingUserPrompt(INTENT, makeCandidates())

  assert.ok(prompt.length <= ROUTING_MODEL_PROMPT_MAX_CHARS)
  assert.ok(prompt.includes('topicId: topic-a'))
  assert.ok(prompt.includes('Store v2'))
  assert.ok(prompt.includes('src/client/panel'))
  assert.ok(prompt.includes('v2 index writes'))
})
