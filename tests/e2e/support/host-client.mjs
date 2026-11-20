/**
 * Real-host client for the versioned E2E lane.
 *
 * Two transports are used, both against the throwaway host started by
 * `scripts/evidence/dsh-host-session.mjs`:
 *
 * - the host Remote API (`/api/<method>`) with the one-time session cookie, for
 *   creating and prompting real sessions and for reading their list state;
 * - the plugin panel API (`/api/cowork.*`) with the same cookie and a matching
 *   Origin header, for the routes the panel calls.
 *
 * Readiness is always a bounded poll on observable state. There is no fixed
 * sleep in this module.
 */

import { randomUUID } from 'node:crypto'

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_POLL_MS = 200

/**
 * Poll until `predicate` returns a truthy value.
 *
 * @param {string} label What is being waited for; used in the timeout message.
 * @param {() => unknown} predicate Bounded observation.
 * @param {{timeoutMs?: number, pollMs?: number}} [options]
 * @returns {Promise<any>} The first truthy value.
 */
export async function waitUntil(label, predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await predicate()
      if (value) return value
      lastError = null
    } catch (error) {
      lastError = error
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs))
  }
  const suffix = lastError === null ? '' : `; last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${label}${suffix}`)
}

/** The host Remote envelope the browser and evidence lanes use. */
function remoteRequest(method, request) {
  const args = method === 'session/list' ? { _request: {} } : { request }
  return {
    type: 'client-request',
    rpcId: randomUUID(),
    method,
    payload: { args },
  }
}

/**
 * @param {object} host The object returned by `startDshHost`.
 * @returns {object} Session, panel, and polling helpers.
 */
export function createHostClient(host) {
  const headers = { cookie: host.cookie }

  async function remote(method, request) {
    const response = await fetch(`${host.origin}/api/${method}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(remoteRequest(method, request)),
    })
    const body = await response.json().catch(() => null)
    if (body?.result?.ok !== true) {
      throw new Error(`${method} failed (HTTP ${String(response.status)}): ${JSON.stringify(body?.result?.error ?? body)}`)
    }
    return body.result.value
  }

  async function listSessions() {
    const value = await remote('session/list', {})
    return Array.isArray(value?.items) ? value.items : []
  }

  async function sessionState(sessionId) {
    return (await listSessions()).find((item) => item.sessionId === sessionId)
  }

  async function waitIdle(sessionId, options = {}) {
    const afterUpdatedAt = options.afterUpdatedAt
    return waitUntil(`session ${sessionId} to finish its turn`, async () => {
      const state = await sessionState(sessionId)
      if (state === undefined) return undefined
      if (state.running) return undefined
      if (afterUpdatedAt !== undefined && !(state.updatedAt > afterUpdatedAt)) return undefined
      return state
    }, { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS })
  }

  async function createSession(request) {
    return remote('session/create', request)
  }

  async function prompt(sessionId, content, mode = 'queue') {
    return remote('session/prompt', {
      requestId: randomUUID(),
      sessionId,
      mode,
      content: [{ type: 'text', text: content }],
    })
  }

  /** Prompt one session and wait for the whole turn, tool calls included. */
  async function promptAndWait(sessionId, content, options = {}) {
    const before = await sessionState(sessionId)
    await prompt(sessionId, content)
    return waitIdle(sessionId, { afterUpdatedAt: before?.updatedAt, timeoutMs: options.timeoutMs })
  }

  async function panelJson(path, init = {}) {
    const response = await fetch(`${host.origin}${path}`, {
      ...init,
      headers: {
        ...headers,
        origin: host.origin,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.headers ?? {}),
      },
    })
    const body = await response.json().catch(() => null)
    return { status: response.status, body }
  }

  /** Raw panel fetch: streaming bodies, uploads, and attachment bytes. */
  async function panelFetch(path, init = {}) {
    return fetch(`${host.origin}${path}`, {
      ...init,
      headers: {
        ...headers,
        origin: host.origin,
        ...(init.headers ?? {}),
      },
    })
  }

  function panelGet(path) {
    return panelJson(path, { method: 'GET' })
  }

  function panelPost(path, body) {
    return panelJson(path, { method: 'POST', body: JSON.stringify(body) })
  }

  return {
    rpc: remote,
    listSessions,
    sessionState,
    waitIdle,
    createSession,
    prompt,
    promptAndWait,
    panelFetch,
    panelGet,
    panelPost,
  }
}
