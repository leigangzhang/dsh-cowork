import test from 'node:test'
import assert from 'node:assert/strict'
import { artifactEvents } from '../support/artifact-fixtures.mjs'

/**
 * The SSE half: live fan-out, `Last-Event-ID` replay, the reset frame for an
 * unusable cursor, heartbeats, and cleanup on abort/cancel. The source is a
 * plain object so the stream's ordering rules are deterministic.
 */
const decoder = new TextDecoder()

/** One event row with a sequence number. */
function event(seq, overrides = {}) {
  return {
    version: 1,
    seq,
    eventId: `event-${seq}`,
    type: 'artifact.updated',
    artifactId: 'artifact-1',
    time: '2026-02-01T00:00:00.000Z',
    data: { revision: seq },
    ...overrides,
  }
}

/** A source over a fixed event list; `readError` forces the failure path. */
function sourceOf(events = [], last = null, options = {}) {
  return {
    async readEvents(after = 0) {
      if (options.readError !== undefined) throw options.readError
      return events.filter((row) => row.seq > after)
    },
    async lastEventSeq() {
      return last ?? (events.length === 0 ? 0 : events[events.length - 1].seq)
    },
  }
}

/** Read chunks until `predicate` matches the accumulated text. */
async function readUntil(reader, predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  let buffer = ''
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now())
    const result = await Promise.race([
      reader.read(),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`timeout; got ${buffer}`)), remaining)),
    ])
    if (result.done) return buffer
    buffer += decoder.decode(result.value, { stream: true })
    if (predicate(buffer)) return buffer
  }
  return buffer
}

test('the hub filters by artifact and stops after unsubscribe', () => {
  const hub = new artifactEvents.ArtifactEventHub()
  const seen = []
  const unsubscribe = hub.subscribe({ artifactId: 'artifact-1' }, (row) => seen.push(row.seq))
  const everything = []
  const unsubscribeAll = hub.subscribe({}, (row) => everything.push(row.seq))
  hub.publish(event(1))
  hub.publish(event(2, { artifactId: 'artifact-2' }))
  assert.deepEqual(seen, [1])
  assert.deepEqual(everything, [1, 2])
  unsubscribe()
  unsubscribeAll()
  hub.publish(event(3))
  assert.deepEqual(seen, [1])
  assert.deepEqual(everything, [1, 2])
  hub.dispose()
  hub.publish(event(4))
  assert.deepEqual(everything, [1, 2])
})

test('frames carry id, event, and the event JSON', () => {
  const row = event(7, { type: 'comment.created' })
  assert.equal(
    artifactEvents.formatEventFrame(row),
    `id: 7\nevent: comment.created\ndata: ${JSON.stringify(row)}\n\n`,
  )
  const reset = artifactEvents.formatResetFrame(9)
  assert.match(reset, /id: 9/)
  assert.match(reset, /event: reset/)
  assert.match(reset, /event-log-trimmed/)
})

test('Last-Event-ID parsing accepts only a non-negative integer', () => {
  assert.equal(artifactEvents.parseLastEventId('12'), 12)
  assert.equal(artifactEvents.parseLastEventId('0'), 0)
  assert.equal(artifactEvents.parseLastEventId(null), null)
  assert.equal(artifactEvents.parseLastEventId('  '), null)
  assert.equal(artifactEvents.parseLastEventId('-1'), null)
  assert.equal(artifactEvents.parseLastEventId('1.5'), null)
  assert.equal(artifactEvents.parseLastEventId('nope'), null)
})

test('replay sends the durable tail then the ready marker', async () => {
  const hub = new artifactEvents.ArtifactEventHub()
  const controller = new AbortController()
  const response = artifactEvents.openArtifactEventStream({
    hub,
    source: sourceOf([event(1), event(2)]),
    lastEventId: 1,
    signal: controller.signal,
    heartbeatMs: 60_000,
  })
  const reader = response.body.getReader()
  const text = await readUntil(reader, (buffer) => buffer.includes(': ready'))
  assert.match(text, /id: 2/)
  assert.doesNotMatch(text, /id: 1/)
  controller.abort()
  await reader.read()
})

test('a cursor ahead of the project gets a reset frame', async () => {
  const hub = new artifactEvents.ArtifactEventHub()
  const controller = new AbortController()
  const response = artifactEvents.openArtifactEventStream({
    hub,
    source: sourceOf([], 3),
    lastEventId: 9,
    signal: controller.signal,
    heartbeatMs: 60_000,
  })
  const text = await readUntil(response.body.getReader(), (buffer) => buffer.includes(': ready'))
  assert.match(text, /event: reset/)
  controller.abort()
})

test('without a cursor the whole retained window replays', async () => {
  const hub = new artifactEvents.ArtifactEventHub()
  const controller = new AbortController()
  const response = artifactEvents.openArtifactEventStream({
    hub,
    source: sourceOf([event(1), event(2)]),
    lastEventId: null,
    signal: controller.signal,
    heartbeatMs: 60_000,
  })
  const text = await readUntil(response.body.getReader(), (buffer) => buffer.includes(': ready'))
  assert.match(text, /id: 1/)
  assert.match(text, /id: 2/)
  controller.abort()
})

test('live events reach a subscribed stream after replay', async () => {
  const hub = new artifactEvents.ArtifactEventHub()
  const controller = new AbortController()
  const response = artifactEvents.openArtifactEventStream({
    hub,
    source: sourceOf([event(1)]),
    lastEventId: 0,
    signal: controller.signal,
    heartbeatMs: 60_000,
  })
  const reader = response.body.getReader()
  await readUntil(reader, (buffer) => buffer.includes(': ready'))
  hub.publish(event(2))
  const text = await readUntil(reader, (buffer) => buffer.includes('id: 2'))
  assert.match(text, /id: 2/)
  controller.abort()
})

test('an event published while replay is pending is queued, not lost', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const hub = new artifactEvents.ArtifactEventHub()
  const controller = new AbortController()
  const source = {
    async readEvents() {
      await gate
      return []
    },
    async lastEventSeq() {
      return 0
    },
  }
  const response = artifactEvents.openArtifactEventStream({
    hub,
    source,
    lastEventId: null,
    signal: controller.signal,
    heartbeatMs: 60_000,
  })
  const reader = response.body.getReader()
  hub.publish(event(5))
  release()
  const text = await readUntil(reader, (buffer) => buffer.includes('id: 5') && buffer.includes(': ready'))
  assert.match(text, /id: 5/)
  assert.match(text, /: ready/)
  controller.abort()
})

test('a heartbeat keeps an idle stream alive', async () => {
  const hub = new artifactEvents.ArtifactEventHub()
  const controller = new AbortController()
  const response = artifactEvents.openArtifactEventStream({
    hub,
    source: sourceOf([]),
    lastEventId: null,
    signal: controller.signal,
    heartbeatMs: 5,
  })
  const text = await readUntil(response.body.getReader(), (buffer) => buffer.includes(': ping'))
  assert.match(text, /: ping/)
  controller.abort()
})

test('a failing source sends an error frame and closes the stream', async () => {
  const hub = new artifactEvents.ArtifactEventHub()
  const controller = new AbortController()
  const response = artifactEvents.openArtifactEventStream({
    hub,
    source: sourceOf([], 0, { readError: new Error('event log unavailable') }),
    lastEventId: null,
    signal: controller.signal,
    heartbeatMs: 60_000,
  })
  const text = await readUntil(response.body.getReader(), (buffer) => buffer.includes('event: error'))
  assert.match(text, /event log unavailable/)
  controller.abort()
})

test('a source failure after the reader cancelled does not throw', async () => {
  let rejectRead
  const gate = new Promise((_resolve, reject) => { rejectRead = reject })
  const hub = new artifactEvents.ArtifactEventHub()
  const controller = new AbortController()
  const response = artifactEvents.openArtifactEventStream({
    hub,
    source: { readEvents: () => gate, lastEventSeq: async () => 0 },
    lastEventId: null,
    signal: controller.signal,
    heartbeatMs: 60_000,
  })
  const reader = response.body.getReader()
  await reader.cancel()
  rejectRead('not an Error')
  await new Promise((resolve) => setTimeout(resolve, 10))
  controller.abort()
})

test('an aborted consumer unsubscribes and closing twice is harmless', async () => {
  const hub = new artifactEvents.ArtifactEventHub()
  const controller = new AbortController()
  const response = artifactEvents.openArtifactEventStream({
    hub,
    source: sourceOf([event(1)]),
    lastEventId: 0,
    signal: controller.signal,
    heartbeatMs: 60_000,
  })
  const reader = response.body.getReader()
  await readUntil(reader, (buffer) => buffer.includes(': ready'))
  controller.abort()
  controller.abort()
  const done = await reader.read()
  assert.equal(done.done, true)
  hub.publish(event(2))
})

test('cancelling the reader cleans up without throwing', async () => {
  const hub = new artifactEvents.ArtifactEventHub()
  const controller = new AbortController()
  const response = artifactEvents.openArtifactEventStream({
    hub,
    source: sourceOf([]),
    lastEventId: null,
    signal: controller.signal,
    heartbeatMs: 60_000,
  })
  const reader = response.body.getReader()
  await readUntil(reader, (buffer) => buffer.includes(': ready'))
  await reader.cancel()
  hub.publish(event(3))
})
