import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * Contract tests for the host `llm` adapter (M9.3b F1).
 *
 * The previous inline adapter put the system prompt into a `messages` entry and
 * used a string user body; `@deepseek-ai/dsh-llm`'s `GenerateOptions` expects a
 * top-level `system` string and a user message whose `content` is a text-block
 * array. These cases pin that shape with a fake service; no host module is
 * imported.
 */
const { buildRoutingStreamOptions, createLlmRoutingPort } = await import('../../src/platform/llm-port.ts')

const REQUEST = {
  provider: 'provider-a',
  model: 'model-a',
  maxTokens: 256,
  reasoningEffort: 'off',
  timeoutMs: 2000,
  systemPrompt: 'route this intent',
  userPrompt: 'Intent: wire the store',
}

/** An async iterable over the given chunks. */
async function* streamOf(chunks) {
  for (const chunk of chunks) yield chunk
}

/** A fake host service that captures the prepare and stream arguments. */
function fakeLlm(chunks, options = {}) {
  const capture = {}
  return {
    capture,
    async prepareCall(config, signal) {
      capture.prepare = { config, signal }
      if (options.prepareError !== undefined) throw options.prepareError
      return {
        config: options.preparedConfig ?? { temperature: 0.2, stop: ['END'] },
        stream(streamOptions) {
          capture.stream = streamOptions
          if (options.streamError !== undefined) throw options.streamError
          return streamOf(chunks)
        },
      }
    },
  }
}

test('buildRoutingStreamOptions uses the host message shape and the request route fields', () => {
  const signal = new AbortController().signal
  const prepared = {
    provider: 'prepared-provider',
    model: 'prepared-model',
    maxTokens: 999,
    reasoningEffort: 'high',
    temperature: 0.2,
    stop: ['END'],
  }
  const options = buildRoutingStreamOptions(REQUEST, prepared, signal)

  assert.equal(options.provider, 'provider-a', 'the request route wins over the prepared config')
  assert.equal(options.model, 'model-a')
  assert.equal(options.maxTokens, 256)
  assert.equal(options.reasoningEffort, 'off')
  assert.equal(options.system, 'route this intent', 'the system prompt is top-level')
  assert.deepEqual(options.messages, [
    { role: 'user', content: [{ type: 'text', text: 'Intent: wire the store' }] },
  ])
  assert.equal(options.signal, signal, 'the abort signal is forwarded')
  assert.equal(options.temperature, 0.2, 'other prepared fields survive')
  assert.deepEqual(options.stop, ['END'])
})

test('createLlmRoutingPort returns undefined for a missing or unusable service', () => {
  assert.equal(createLlmRoutingPort(undefined), undefined)
  assert.equal(createLlmRoutingPort(null), undefined)
  assert.equal(createLlmRoutingPort({}), undefined, 'a service without prepareCall is unusable')
})

test('the port prepares the call, forwards the signal, and joins text deltas', async () => {
  const llm = fakeLlm([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'hello ' },
    { type: 'text-delta', index: 0, text: 'world' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const port = createLlmRoutingPort(llm)
  const signal = new AbortController().signal

  const text = await port.run(REQUEST, signal)

  assert.equal(text, 'hello world')
  assert.deepEqual(llm.capture.prepare.config, {
    provider: 'provider-a',
    model: 'model-a',
    maxTokens: 256,
    reasoningEffort: 'off',
  })
  assert.equal(llm.capture.prepare.signal, signal)
  assert.equal(llm.capture.stream.system, REQUEST.systemPrompt)
  assert.deepEqual(llm.capture.stream.messages, [
    { role: 'user', content: [{ type: 'text', text: REQUEST.userPrompt }] },
  ])
  assert.equal(llm.capture.stream.signal, signal)
})

test('a finish with kind error throws the model failure message', async () => {
  const llm = fakeLlm([
    { type: 'text-delta', index: 0, text: 'partial' },
    { type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded' } } },
  ])
  await assert.rejects(createLlmRoutingPort(llm).run(REQUEST, new AbortController().signal), /provider exploded/)
})

test('a finish with kind aborted throws a bounded error', async () => {
  const llm = fakeLlm([
    { type: 'finish', reason: { kind: 'aborted', failure: {} } },
  ])
  await assert.rejects(createLlmRoutingPort(llm).run(REQUEST, new AbortController().signal), /aborted/)
})

test('a stop finish without text returns an empty string', async () => {
  const llm = fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }])
  assert.equal(await createLlmRoutingPort(llm).run(REQUEST, new AbortController().signal), '')
})

test('prepareCall and stream failures propagate to the caller', async () => {
  const prepareFailure = fakeLlm([], { prepareError: new Error('no adapter') })
  await assert.rejects(
    createLlmRoutingPort(prepareFailure).run(REQUEST, new AbortController().signal),
    /no adapter/,
  )

  const streamFailure = fakeLlm([], { streamError: new Error('stream refused') })
  await assert.rejects(
    createLlmRoutingPort(streamFailure).run(REQUEST, new AbortController().signal),
    /stream refused/,
  )
})
