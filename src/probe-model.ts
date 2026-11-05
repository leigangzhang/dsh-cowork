/**
 * Pure M0-probe helpers: loopback admission, request parsing, turn/event
 * folding, and the on-disk store document. No host imports — the unit tests
 * run this file directly under `node --test` with type stripping.
 */

/** One session event as the probe consumes it. */
export interface ProbeEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: Record<string, unknown>
}

/** Folded view of one completed turn. */
export interface TurnSummary {
  readonly turn: number | undefined
  readonly startSeq: number | undefined
  readonly endSeq: number | undefined
  readonly reason: string | undefined
  readonly text: string
}

/** The on-disk probe store document. */
export interface StoreDocument {
  readonly runId: string
  readonly token: string
  readonly createdAt: number
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Whether a socket peer address is a loopback address. */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.has(address)
}

/** Whether a Host header names this machine (a second gate against DNS rebinding). */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false
  const bare = host.replace(/:\d+$/, '')
  return bare === '127.0.0.1' || bare === 'localhost' || bare === '[::1]' || bare === '::1'
}

/** Pathname of a request target, dropping the query. */
export function readPath(url: string | undefined): string {
  if (url === undefined || url === '') return '/'
  const at = url.indexOf('?')
  return at < 0 ? url : url.slice(0, at)
}

/** One query parameter of a request target, or undefined. */
export function readQuery(url: string | undefined, name: string): string | undefined {
  if (url === undefined) return undefined
  const at = url.indexOf('?')
  if (at < 0) return undefined
  const value = new URLSearchParams(url.slice(at + 1)).get(name)
  return value === null ? undefined : value
}

/** Validate a status query's run id. */
export function requireRunId(value: string | undefined): string {
  if (value === undefined || value.trim() === '') throw new Error('runId query parameter is required')
  return value.trim()
}

/** Narrow an unknown JSON value to one object record. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function contentText(message: unknown): string | undefined {
  const record = asRecord(message)
  const content = record?.content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const part of content) {
    const block = asRecord(part)
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.length === 0 ? undefined : parts.join('')
}

/** Assistant text carried by one `assistant/message` event. */
export function assistantText(event: ProbeEvent): string | undefined {
  if (event.type !== 'assistant/message') return undefined
  return contentText(event.data.message)
}

/** Turn-end reason kind of one `turn/end` event. */
export function turnEndKind(event: ProbeEvent): string | undefined {
  if (event.type !== 'turn/end') return undefined
  const kind = asRecord(event.data.reason)?.kind
  return typeof kind === 'string' ? kind : undefined
}

/**
 * Fold the events of one turn: the last `turn/start` opens it, the last
 * `turn/end` closes it, and every assistant text between them is joined.
 * Events at or below `fromSeq` belong to earlier turns and are skipped.
 */
export function summarizeEvents(events: readonly ProbeEvent[], fromSeq = 0): TurnSummary {
  let turn: number | undefined
  let startSeq: number | undefined
  let endSeq: number | undefined
  let reason: string | undefined
  const texts: string[] = []
  for (const event of events) {
    if (event.seq <= fromSeq) continue
    if (event.type === 'turn/start') {
      const value = event.data.turn
      if (typeof value === 'number') turn = value
      startSeq = event.seq
      texts.length = 0
    } else if (event.type === 'assistant/message') {
      const text = assistantText(event)
      if (text !== undefined) texts.push(text)
    } else if (event.type === 'turn/end') {
      endSeq = event.seq
      reason = turnEndKind(event)
    }
  }
  return { turn, startSeq, endSeq, reason, text: texts.join('\n') }
}

/** Serialize a store document with a trailing newline. */
export function buildStoreDocument(document: StoreDocument): string {
  if (document.runId === '') throw new Error('store document runId must be non-empty')
  if (document.token === '') throw new Error('store document token must be non-empty')
  return `${JSON.stringify(document)}\n`
}

/** Parse and validate a store document. */
export function parseStoreDocument(raw: string): StoreDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('store document is not valid JSON')
  }
  const record = asRecord(parsed)
  if (record === undefined) throw new Error('store document must be a JSON object')
  const { runId, token, createdAt } = record
  if (typeof runId !== 'string' || runId === '') throw new Error('store document runId must be a non-empty string')
  if (typeof token !== 'string' || token === '') throw new Error('store document token must be a non-empty string')
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) throw new Error('store document createdAt must be a finite number')
  return { runId, token, createdAt }
}
