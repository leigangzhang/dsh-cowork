/**
 * Deterministic Anthropic-Messages endpoint for the versioned E2E lane.
 *
 * The host reaches this server through the plugin's public `baseURL` provider
 * setting, so the real DeepSeek adapter, retry policy, stream translator and
 * agent loop all run unchanged; only the provider bytes are scripted. It is
 * keyless and never opens a network connection.
 *
 * A scenario installs one handler. The handler sees the request role (derived
 * from the preset persona in the system prompt), the latest user text and the
 * tool results the agent loop returned, and answers with text or one tool call.
 * Every request and paired tool result is retained here, so a scenario can
 * assert what a session actually executed instead of trusting a prompt.
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

/** One scripted assistant reply: final text, or one tool call. */
export function text(value) {
  return { text: value }
}

/** One scripted tool call. */
export function tool(name, input = {}) {
  return { tool: { name, input } }
}

/** The role a request belongs to, from the persona the plugin registered. */
export function requestRole(system) {
  if (system.includes('You are the cowork master for this repository.')) return 'master'
  if (system.includes('You are one cowork topic session in this repository')) return 'topic'
  if (system.includes('You are the independent reviewer of one cowork review request')) return 'reviewer'
  return 'other'
}

/** Flatten one tool_result content value to text. */
function flattenContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
}

/** The latest user message's text, ignoring tool_result blocks. */
function latestUserText(messages) {
  for (let index = (messages ?? []).length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    return (message.content ?? [])
      .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .join('\n')
  }
  return ''
}

function sse(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

const START_MESSAGE = {
  type: 'message_start',
  message: {
    id: '',
    type: 'message',
    role: 'assistant',
    model: 'scripted-e2e',
    content: [],
    usage: { input_tokens: 10, output_tokens: 0 },
  },
}

function textEvents(value) {
  return sse([
    { ...START_MESSAGE, message: { ...START_MESSAGE.message, id: `msg_${randomUUID()}` } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ])
}

function toolEvents(id, name, input) {
  return sse([
    { ...START_MESSAGE, message: { ...START_MESSAGE.message, id: `msg_${randomUUID()}` } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ])
}

/** DeepSeek routing's JSON-only reply; unrelated to the scenario personas. */
const ROUTING_REPLY = '{"topicId":null,"confidence":0.4}'

/**
 * Start one scripted provider on a random loopback port.
 *
 * @returns {Promise<{
 *   origin: string,
 *   calls: object[],
 *   errors: Error[],
 *   setHandler: (handler: ((request: object) => ({text: string}|{tool: {name: string, input: object}}|null))|null) => void,
 *   reset: () => void,
 *   close: () => Promise<void>,
 * }>}
 */
export async function startScriptedModel() {
  const calls = []
  const errors = []
  const toolNames = new Map()
  let handler = null
  let closed = false

  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      let payload = {}
      try {
        payload = JSON.parse(body)
      } catch {
        payload = {}
      }
      const sessionId = String(request.headers['x-deepseek-harness-session-id'] ?? '')
      const system = typeof payload.system === 'string' ? payload.system : ''
      const role = requestRole(system)
      const prompt = latestUserText(payload.messages)
      const last = (payload.messages ?? []).at(-1)
      const toolResults = (last?.content ?? [])
        .filter((block) => block?.type === 'tool_result')
        .map((block) => ({
          toolName: toolNames.get(block.tool_use_id) ?? 'unknown',
          toolUseId: block.tool_use_id,
          isError: block.is_error === true,
          text: flattenContent(block.content),
        }))
      const requestRecord = {
        index: calls.length,
        sessionId,
        role,
        compact: request.headers['x-deepseek-harness-compact'] === '1',
        prompt: prompt.slice(0, 500),
        toolResults,
        tools: (payload.tools ?? []).map((definition) => definition.name),
        reply: null,
        error: null,
      }
      calls.push(requestRecord)

      let reply = null
      try {
        // The routing fallback is a plugin-internal call with no preset
        // persona; answer it before a scenario handler can shadow the JSON.
        if (system.includes('routing fallback of a cowork master session')) {
          reply = text(ROUTING_REPLY)
        } else if (handler !== null) {
          reply = handler({
            role,
            sessionId,
            prompt,
            toolResults,
            tools: requestRecord.tools,
            index: requestRecord.index,
          })
        }
      } catch (error) {
        requestRecord.error = error instanceof Error ? error.message : String(error)
        errors.push(error instanceof Error ? error : new Error(String(error)))
      }
      if (reply === null || reply === undefined) {
        reply = toolResults.length > 0 ? text('Done.') : text('Acknowledged.')
      }

      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      if (reply.tool !== undefined) {
        const id = `toolu_${randomUUID()}`
        toolNames.set(id, reply.tool.name)
        requestRecord.reply = { tool: reply.tool.name, input: reply.tool.input }
        response.end(toolEvents(id, reply.tool.name, reply.tool.input))
        return
      }
      requestRecord.reply = { text: String(reply.text ?? '') }
      response.end(textEvents(String(reply.text ?? '')))
    })
  })

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('scripted model did not get a TCP address')

  return {
    origin: `http://127.0.0.1:${address.port}`,
    calls,
    errors,
    setHandler(next) {
      handler = next
    },
    reset() {
      handler = null
      calls.length = 0
      errors.length = 0
      toolNames.clear()
    },
    close() {
      if (closed) return Promise.resolve()
      closed = true
      return new Promise((resolveClose) => server.close(() => resolveClose()))
    },
  }
}
