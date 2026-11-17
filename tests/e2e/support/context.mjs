/**
 * Scenario context for the versioned E2E lane.
 *
 * One scenario gets a fresh fixture, the real-host client, and the scripted
 * model's recorded calls. All synchronization is a bounded poll on that
 * observable state; a failed check carries the claim, the observed detail and
 * the scenario id, so the runner can write exact evidence without a stack
 * trace as the only artifact.
 */

import { waitUntil } from './host-client.mjs'
import { readActivity, readIndex, readInbox, readJsonDirectory, readText } from './fixture.mjs'

/** Parse a tool result's JSON payload; renders may wrap it in prose. */
export function parseToolPayload(resultText) {
  const text = typeof resultText === 'string' ? resultText : ''
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return undefined
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
}

/**
 * @param {object} input
 * @param {string} input.scenarioId
 * @param {{path: string}} input.fixture
 * @param {object} input.client `createHostClient` result.
 * @param {object} input.model `startScriptedModel` result.
 * @returns {object} Helpers used by scenario modules.
 */
export function createScenarioContext({ scenarioId, fixture, client, model }) {
  const checks = []
  const context = {
    scenarioId,
    fixture,
    client,
    model,
    checks,

    /** Record one passing check; a false claim fails the scenario. */
    check(name, condition, detail = '') {
      if (condition) {
        checks.push({ name, passed: true, detail })
        return
      }
      const failure = { name, passed: false, detail: String(detail) }
      checks.push(failure)
      throw new Error(`${scenarioId}: ${name}${detail === '' ? '' : ` (${String(detail)})`}`)
    },

    waitUntil(label, predicate, options) {
      return waitUntil(`${scenarioId}: ${label}`, predicate, options)
    },

    /** All model calls since `sinceIndex`. */
    callsSince(sinceIndex) {
      return model.calls.slice(sinceIndex)
    },

    /**
     * The latest non-error tool result for `toolName` in `sessionId`, waiting
     * until the agent loop has reported one.
     */
    async waitToolResult(sessionId, toolName, options = {}) {
      const sinceIndex = options.sinceIndex ?? 0
      const matches = (row) => row.toolName === toolName && (options.acceptError === true || row.isError === false)
      const call = await waitUntil(`${scenarioId}: ${toolName} tool result`, () =>
        model.calls
          .slice(sinceIndex)
          .find((entry) => entry.sessionId === sessionId
            && entry.toolResults.some(matches)), options)
      const result = call.toolResults.find(matches)
      const payload = parseToolPayload(result.text)
      if (options.expectOk === true) {
        if (payload === undefined || payload.ok !== true) {
          throw new Error(
            `${scenarioId}: ${toolName} did not report ok=true; result=${result.text.slice(0, 500)}`,
          )
        }
      }
      return { ...result, payload }
    },

    /** Prompt one session, wait for the named tool result, then wait for idle. */
    async promptForTool(sessionId, instruction, toolName, options = {}) {
      const sinceIndex = model.calls.length
      const before = await client.sessionState(sessionId)
      await client.prompt(sessionId, instruction)
      const result = await context.waitToolResult(sessionId, toolName, {
        sinceIndex,
        expectOk: options.expectOk ?? true,
        acceptError: options.acceptError === true,
        timeoutMs: options.timeoutMs,
      })
      await client.waitIdle(sessionId, { afterUpdatedAt: before?.updatedAt })
      return result
    },

    /** Prompt one session whose turn makes no tool call (an acknowledgement). */
    async promptForText(sessionId, instruction) {
      const sinceIndex = model.calls.length
      const before = await client.sessionState(sessionId)
      await client.prompt(sessionId, instruction)
      const call = await waitUntil(`${scenarioId}: a model turn for ${sessionId}`, () =>
        model.calls.slice(sinceIndex).find((entry) => entry.sessionId === sessionId))
      await client.waitIdle(sessionId, { afterUpdatedAt: before?.updatedAt })
      return call
    },

    /** Wait for the initial brief a route/topic/review tool delivered. */
    async waitBriefedSession(role, options = {}) {
      const call = await waitUntil(`${scenarioId}: a ${role} session turn`, () =>
        model.calls.find((entry) => entry.role === role && entry.sessionId !== '')
          ?? undefined, options)
      await client.waitIdle(call.sessionId, {})
      return call.sessionId
    },

    index() {
      return readIndex(fixture.path)
    },

    inbox() {
      return readInbox(fixture.path)
    },

    proposals() {
      return readJsonDirectory(fixture.path, 'proposals')
    },

    reviews() {
      return readJsonDirectory(fixture.path, 'reviews')
    },

    handoffs() {
      return readJsonDirectory(fixture.path, 'handoffs')
    },

    activity() {
      return readActivity(fixture.path)
    },

    readText(relativePath) {
      return readText(`${fixture.path}/${relativePath}`)
    },

    panelGet(path) {
      return client.panelGet(path)
    },

    panelPost(path, body) {
      return client.panelPost(path, body)
    },
  }
  return context
}
