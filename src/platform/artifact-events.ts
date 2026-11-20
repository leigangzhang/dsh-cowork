/**
 * Project event hub and SSE response for the work-item surface.
 *
 * The host `connection` can stream a `Response.body` chunk by chunk (the HMR
 * stream is the in-repo precedent), so the artifact stream is one exact Fetch
 * route that answers `text/event-stream`. Events are durable in
 * `events.jsonl`; this module only broadcasts live rows and formats the wire.
 *
 * Reconnect contract: `Last-Event-ID` names the last `seq` the client saw. The
 * stream subscribes *before* replaying, so an event appended between replay and
 * subscription is queued and sent afterwards instead of lost. A client whose
 * id is older than the retained log receives `reset`; the browser then reloads
 * the detail instead of pretending the gap did not happen.
 */
import { randomUUID } from 'node:crypto'
import {
  ARTIFACT_EVENT_HEARTBEAT_MS,
  ARTIFACT_EVENT_VERSION,
  type ArtifactEventV1,
} from '../panel/artifact-contract.js'

/** What the stream needs from the event log. */
export interface ArtifactEventSource {
  readEvents(afterSeq?: number): Promise<ArtifactEventV1[]>
  lastEventSeq(): Promise<number>
  /** Optional filtered window with gap metadata; preferred when available. */
  readEventsWindow?(
    afterSeq: number,
    artifactId?: string,
  ): Promise<{ events: ArtifactEventV1[]; truncated: boolean; newest: number }>
}

/** One live subscription filter; an absent field matches every event. */
export interface ArtifactEventFilter {
  readonly artifactId?: string
}

/** One live subscriber. */
type Subscriber = (event: ArtifactEventV1) => void

/** In-process fan-out of appended project events. */
export class ArtifactEventHub {
  private readonly subscribers = new Set<Subscriber>()

  /** Subscribe one listener; the returned function unsubscribes it. */
  subscribe(filter: ArtifactEventFilter, listener: Subscriber): () => void {
    const artifactId = filter.artifactId
    const subscriber: Subscriber = (event) => {
      if (artifactId !== undefined && event.artifactId !== artifactId) return
      listener(event)
    }
    this.subscribers.add(subscriber)
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  /** Broadcast one already-appended event to live subscribers. */
  publish(event: ArtifactEventV1): void {
    for (const subscriber of [...this.subscribers]) subscriber(event)
  }

  /** Drop every subscription; the plugin fiber calls this on unload. */
  dispose(): void {
    this.subscribers.clear()
  }
}

/** Build one event row ready for `store.appendEventUnlocked`. */
export function createEventRow(
  artifactId: string,
  type: ArtifactEventV1['type'],
  now: Date,
  data: Readonly<Record<string, unknown>>,
): Omit<ArtifactEventV1, 'version' | 'seq'> {
  return {
    eventId: `event-${randomUUID()}`,
    type,
    artifactId,
    time: now.toISOString(),
    data,
  }
}

/** Format one event as an SSE frame; `id` drives the browser's Last-Event-ID. */
export function formatEventFrame(event: ArtifactEventV1): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

/** Format the `reset` frame a client behind the retained log receives. */
export function formatResetFrame(seq: number): string {
  const event: ArtifactEventV1 = {
    version: ARTIFACT_EVENT_VERSION,
    seq,
    eventId: `reset-${seq}`,
    type: 'reset',
    artifactId: '',
    time: '1970-01-01T00:00:00.000Z',
    data: { reason: 'event-log-trimmed' },
  }
  return formatEventFrame(event)
}

/** Parse a `Last-Event-ID` header; a malformed value starts from the beginning. */
export function parseLastEventId(value: string | null): number | null {
  if (value === null || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

/** What one stream needs. */
export interface ArtifactStreamOptions {
  readonly hub: ArtifactEventHub
  readonly source: ArtifactEventSource
  readonly filter?: ArtifactEventFilter
  /** Last sequence the client already has; null means "from the replay window". */
  readonly lastEventId: number | null
  readonly signal: AbortSignal
  /** Overridable for tests; production uses the contract's 15 s heartbeat. */
  readonly heartbeatMs?: number
}

/** SSE headers every panel stream answers with. */
const STREAM_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  'x-accel-buffering': 'no',
}

/**
 * Build the streaming response for one subscriber.
 *
 * Replay is bounded by the event log; live rows then flow until the request
 * aborts. A heartbeat comment keeps a proxy from closing an idle stream. The
 * reader cancelling the body unsubscribes and clears the timer.
 */
export function openArtifactEventStream(options: ArtifactStreamOptions): Response {
  const encoder = new TextEncoder()
  const heartbeatMs = options.heartbeatMs ?? ARTIFACT_EVENT_HEARTBEAT_MS
  let unsubscribe: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let closed = false
  let sentSeq = options.lastEventId ?? 0
  let ready = false
  const queued: ArtifactEventV1[] = []
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null

  const cleanup = (): void => {
    if (closed) return
    closed = true
    unsubscribe?.()
    unsubscribe = null
    if (heartbeat !== null) clearInterval(heartbeat)
    heartbeat = null
  }

  const send = (frame: string): void => {
    if (closed || controller === null) return
    controller.enqueue(encoder.encode(frame))
  }

  const sendEvent = (event: ArtifactEventV1): void => {
    if (event.seq <= sentSeq) return
    sentSeq = event.seq
    send(formatEventFrame(event))
  }

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController
      unsubscribe = options.hub.subscribe(options.filter ?? {}, (event) => {
        if (ready) sendEvent(event)
        else queued.push(event)
      })
      options.signal.addEventListener('abort', () => {
        cleanup()
        try {
          streamController.close()
        } catch {
          // Already closed by the reader; closing twice is not a failure.
        }
      })
      void replay()
    },
    cancel() {
      cleanup()
    },
  })

  /** Replay the durable window, then flush what arrived while replaying. */
  async function replay(): Promise<void> {
    try {
      const after = options.lastEventId ?? 0
      const window = options.source.readEventsWindow === undefined
        ? {
            events: options.source.readEvents
              ? await options.source.readEvents(after)
              : [],
            truncated: false,
            newest: await options.source.lastEventSeq(),
          }
        : await options.source.readEventsWindow(after, options.filter?.artifactId)
      const newest = window.newest
      // A cursor older than the retained log, or ahead of the project, gets a
      // reset instead of a silently incomplete history. The browser reloads
      // the detail (and file) on `reset`.
      if (after > 0 && (window.truncated || (window.events.length === 0 && newest < after))) {
        send(formatResetFrame(newest))
      }
      for (const event of window.events) sendEvent(event)
      ready = true
      queued.sort((left, right) => left.seq - right.seq)
      for (const event of queued) sendEvent(event)
      queued.length = 0
      send(': ready\n\n')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      send(`event: error\ndata: ${JSON.stringify({ message })}\n\n`)
      cleanup()
      try {
        controller?.close()
      } catch {
        // The reader already went away.
      }
    }
  }

  heartbeat = setInterval(() => {
    send(': ping\n\n')
  }, heartbeatMs)
  // The stream must not keep a Node process alive on its own.
  heartbeat.unref?.()

  return new Response(stream, { status: 200, headers: STREAM_HEADERS })
}
