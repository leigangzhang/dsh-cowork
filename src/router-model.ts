/**
 * Model-backed fallback for the third routing layer (M9.2).
 *
 * The structured router (src/routing.ts) hands over 1–3 candidates and asks the
 * model to pick one (or none). This module is the *only* place the plugin asks
 * an LLM to make a routing decision, and it owns no host code: the host wires
 * its `llm` service through {@link LlmRoutingPort} in src/index.ts. That keeps
 * the guard rails (disabled / unconfigured / unavailable), the prompt budget,
 * the timeout, and the reply schema testable with a fake port and no network.
 *
 * Every failure path returns {@link ModelOutcome} with `action: 'fallback'`:
 * the caller reuses the highest structured candidate (the first element of the
 * candidate list, which M9.1 emits in descending score order) or creates a new
 * topic. This module never throws and never asks the user to choose.
 */

/** Default per-call output budget from PLAN-V0.2 §5.10. */
export const DEFAULT_ROUTING_MAX_TOKENS = 256

/** Default wall-clock budget from PLAN-V0.2 §5.10. */
export const DEFAULT_ROUTING_TIMEOUT_MS = 2000

/**
 * Reasoning is off by default. M6 probe 1 proved `'off'` is the adapter's
 * lowest effort and maps to `thinking.type="disabled"` with no `output_config`
 * (docs/M6_PROBE_RESULT.md §1), which is what a 256-token routing call wants.
 */
export const DEFAULT_REASONING_EFFORT = 'off'

/** Hard cap for the serialized intent plus candidates. */
export const ROUTING_MODEL_PROMPT_MAX_CHARS = 2000

/** Hard cap for the bounded `modelError` string on fallback. */
export const ROUTING_MODEL_ERROR_MAX_CHARS = 200

const INTENT_MAX_CHARS = 700
const TOPIC_ID_MAX_CHARS = 80
const TITLE_MAX_CHARS = 120
const SCOPE_MAX_CHARS = 240
const DIGEST_MAX_CHARS = 240
const MAX_CANDIDATES = 3

/** One request to the host LLM service; `run` returns the model's text. */
export interface RoutingModelRequest {
  provider: string
  model: string
  maxTokens: number
  /** `'off'` unless the configuration names a higher effort explicitly. */
  reasoningEffort: string
  timeoutMs: number
  systemPrompt: string
  userPrompt: string
}

/**
 * The minimal slice of the host `llm` service this module needs. `signal`
 * aborts at `timeoutMs`; an implementation may reject with the signal reason
 * or simply stop, in which case the race in {@link recommendWithModel} wins.
 */
export interface LlmRoutingPort {
  run(request: RoutingModelRequest, signal: AbortSignal): Promise<string>
}

/**
 * Routing model configuration (PLAN-V0.2 §5.10): `effort` empty means the
 * default `'off'`; `timeoutMs`/`maxTokens` non-positive fall back to the
 * documented defaults rather than failing the route.
 */
export interface RoutingModelConfig {
  enabled: boolean
  provider: string
  model: string
  effort: string
  timeoutMs: number
  maxTokens: number
}

/** One structured candidate, already scored and ordered by src/routing.ts. */
export interface ModelCandidate {
  topicId: string
  title: string
  scope: string
  digest: string
}

/** Model chose an existing candidate. */
export interface RoutingModelReuseOutcome {
  readonly action: 'reuse'
  readonly topicId: string
  readonly confidence: number
  readonly modelUsed: true
}

/** Model chose a new topic (`topicId: null`). */
export interface RoutingModelCreateOutcome {
  readonly action: 'create'
  readonly topicId: null
  readonly confidence: number
  readonly modelUsed: true
}

/**
 * No model decision: the caller reuses the highest structured candidate
 * (`topicId` non-null) or creates a topic (`topicId: null`). `modelError` is a
 * bounded, human-readable reason (`<code>: <detail>`), never a stack trace.
 */
export interface RoutingModelFallbackOutcome {
  readonly action: 'fallback'
  readonly topicId: string | null
  readonly confidence: null
  readonly modelError: string
  readonly modelUsed: false
}

export type ModelOutcome =
  | RoutingModelReuseOutcome
  | RoutingModelCreateOutcome
  | RoutingModelFallbackOutcome

/** Input of {@link recommendWithModel}. */
export interface RecommendWithModelInput {
  intent: string
  /** Ordered by score, highest first; 0–3 items in practice. */
  candidates: readonly ModelCandidate[]
  config: RoutingModelConfig
  port?: LlmRoutingPort
}

/** Stable failure codes; the route activity stores them inside `modelError`. */
export type RoutingModelErrorCode =
  | 'disabled'
  | 'unconfigured'
  | 'unavailable'
  | 'timeout'
  | 'port-error'
  | 'bad-json'
  | 'invalid-reply'
  | 'topic-not-candidate'
  | 'confidence-out-of-range'

class RoutingModelError extends Error {
  readonly code: RoutingModelErrorCode

  constructor(code: RoutingModelErrorCode, detail: string) {
    super(detail)
    this.name = 'RoutingModelError'
    this.code = code
  }
}

/** Short, schema-first system prompt: the reply must stay machine-parseable. */
const ROUTING_SYSTEM_PROMPT = [
  'You are the routing fallback of a cowork master session.',
  'A structured matcher has already scored the candidate topics for the user intent.',
  'Choose at most one existing topic for the intent, or null when a new topic is the better fit.',
  'Do not explain, and never answer with prose or markdown.',
  'Reply with JSON only: {"topicId": string|null, "confidence": number}, where confidence is between 0 and 1.',
].join(' ')

/** Collapse whitespace so a multi-line intent cannot break the prompt layout. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Deterministic truncation with a single-character ellipsis marker. */
function truncate(value: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (value.length <= maxChars) return value
  if (maxChars === 1) return '…'
  return `${value.slice(0, maxChars - 1)}…`
}

function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0
}

/** One candidate line, trimmed to `budget` characters from the inside out. */
function formatCandidateLine(candidate: ModelCandidate, budget: number): string {
  const topicId = truncate(oneLine(candidate.topicId), TOPIC_ID_MAX_CHARS)
  const prefix = `- topicId: ${topicId}`
  if (budget <= prefix.length) return truncate(prefix, budget)

  const separators = ' | title: '.length + ' | scope: '.length + ' | digest: '.length
  const room = Math.max(0, budget - prefix.length - separators)
  const title = truncate(oneLine(candidate.title), Math.min(TITLE_MAX_CHARS, Math.floor(room * 0.25)))
  const scope = truncate(oneLine(candidate.scope), Math.min(SCOPE_MAX_CHARS, Math.floor(room * 0.35)))
  const digest = truncate(
    oneLine(candidate.digest),
    Math.min(DIGEST_MAX_CHARS, Math.max(0, room - title.length - scope.length)),
  )
  const line = `${prefix} | title: ${title} | scope: ${scope} | digest: ${digest}`
  return truncate(line, budget)
}

/**
 * Serialize the intent and candidates into the user prompt.
 *
 * Deterministic by construction: the intent keeps up to 700 characters, each
 * candidate keeps up to 3 (the structured layer's own cap), and the per-line
 * budget is `(2000 - header - line separators) / count`, so the result never
 * exceeds {@link ROUTING_MODEL_PROMPT_MAX_CHARS}. The final truncate is a
 * belt-and-braces bound; oversized inputs shrink `scope`/`digest` first.
 */
export function buildRoutingUserPrompt(intent: string, candidates: readonly ModelCandidate[]): string {
  const header = `Intent: ${truncate(oneLine(intent), INTENT_MAX_CHARS)}\nCandidates (reply with one topicId or null):`
  const picked = candidates.slice(0, MAX_CANDIDATES)
  if (picked.length === 0) {
    return truncate(`${header}\n(none)`, ROUTING_MODEL_PROMPT_MAX_CHARS)
  }
  const budget = Math.max(
    0,
    Math.floor((ROUTING_MODEL_PROMPT_MAX_CHARS - header.length - picked.length) / picked.length),
  )
  const lines = picked.map((candidate) => formatCandidateLine(candidate, budget))
  return truncate(`${header}\n${lines.join('\n')}`, ROUTING_MODEL_PROMPT_MAX_CHARS)
}

/** Strip an optional ```json fence and surrounding whitespace. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/.exec(trimmed)
  return fenced?.[1] !== undefined ? fenced[1].trim() : trimmed
}

/**
 * Validate the model reply into `{ topicId, confidence }`.
 *
 * Only the documented shape is accepted: an object with `topicId` equal to
 * `null` or one of the candidate ids, and a finite `confidence` in `[0, 1]`.
 * Everything else throws {@link RoutingModelError} and becomes a fallback.
 */
function parseRoutingReply(raw: string, candidateIds: ReadonlySet<string>): { topicId: string | null; confidence: number } {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new RoutingModelError('invalid-reply', 'the model returned no text')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripCodeFence(raw))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new RoutingModelError('bad-json', detail)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RoutingModelError('invalid-reply', 'the reply is not a JSON object')
  }
  const record = parsed as Record<string, unknown>

  const topicId = record.topicId
  if (topicId !== null && typeof topicId !== 'string') {
    throw new RoutingModelError('invalid-reply', 'topicId must be a string or null')
  }
  if (typeof topicId === 'string' && !candidateIds.has(topicId)) {
    throw new RoutingModelError('topic-not-candidate', `topicId ${truncate(topicId, 64)} is not a candidate`)
  }

  const confidence = record.confidence
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    throw new RoutingModelError('invalid-reply', 'confidence must be a finite number')
  }
  if (confidence < 0 || confidence > 1) {
    throw new RoutingModelError('confidence-out-of-range', `confidence ${confidence} is outside [0, 1]`)
  }

  return { topicId, confidence }
}

/**
 * Call the port once, bounded by `AbortSignal.timeout`.
 *
 * `AbortSignal.timeout` owns the cancellation the port observes, but its timer
 * is unref'd: an otherwise idle event loop could drain before it fires. A
 * ref'd guard timer races alongside it so the bound also holds for short-lived
 * callers and unit tests. The race covers a port that ignores the signal; the
 * port promise keeps a no-op rejection handler so a late abort rejection never
 * becomes unhandled, and both timers/listeners are released when the call ends.
 */
async function callPort(port: LlmRoutingPort, request: RoutingModelRequest): Promise<string> {
  const signal = AbortSignal.timeout(request.timeoutMs)
  let removeAbortListener = (): void => undefined
  let guard: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_resolve, reject) => {
    const fail = (): void => {
      reject(new RoutingModelError('timeout', `the model call exceeded ${request.timeoutMs} ms`))
    }
    if (signal.aborted) {
      fail()
      return
    }
    guard = setTimeout(fail, request.timeoutMs)
    signal.addEventListener('abort', fail, { once: true })
    removeAbortListener = () => signal.removeEventListener('abort', fail)
  })

  let call: Promise<string>
  try {
    call = Promise.resolve(port.run(request, signal))
  } catch (error) {
    if (guard !== undefined) clearTimeout(guard)
    removeAbortListener()
    throw error
  }
  call.catch(() => undefined)
  try {
    return await Promise.race([call, timedOut])
  } finally {
    if (guard !== undefined) clearTimeout(guard)
    removeAbortListener()
  }
}

/** Turn any thrown value into a bounded `<code>: <detail>` string. */
function describeFailure(error: unknown): string {
  let code: RoutingModelErrorCode = 'port-error'
  if (error instanceof RoutingModelError) {
    code = error.code
  } else if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    // The port may surface the abort before the race does; both are a timeout.
    code = 'timeout'
  }
  const detail = error instanceof Error ? error.message : String(error)
  return truncate(`${code}: ${detail}`, ROUTING_MODEL_ERROR_MAX_CHARS)
}

/**
 * Ask the model to choose between structured candidates, never throwing.
 *
 * Guards run before any port call: disabled configuration, a missing
 * provider/model, and an unwired port all return `fallback` and leave the port
 * untouched. A valid reply yields `reuse` (a candidate id) or `create` (null);
 * every other outcome — bad JSON, wrong types, an unknown topic, an
 * out-of-range confidence, a timeout, or a port error — returns `fallback`
 * with the highest structured candidate as the reuse target.
 */
export async function recommendWithModel(input: RecommendWithModelInput): Promise<ModelOutcome> {
  const candidates = Array.isArray(input?.candidates) ? input.candidates : []
  const config = input?.config
  const highestTopicId =
    candidates.length > 0 && typeof candidates[0]?.topicId === 'string' ? candidates[0].topicId : null

  const fallback = (modelError: string): ModelOutcome => ({
    action: 'fallback',
    topicId: highestTopicId,
    confidence: null,
    modelError: truncate(modelError, ROUTING_MODEL_ERROR_MAX_CHARS),
    modelUsed: false,
  })

  if (config?.enabled !== true) {
    return fallback('disabled: routing.enabled is false')
  }
  if (isBlank(config.provider) || isBlank(config.model)) {
    return fallback('unconfigured: routing.provider and routing.model must both be set')
  }
  if (input.port === undefined || input.port === null) {
    return fallback('unavailable: no llm routing port is wired')
  }

  const request: RoutingModelRequest = {
    provider: config.provider.trim(),
    model: config.model.trim(),
    maxTokens: positiveOr(config.maxTokens, DEFAULT_ROUTING_MAX_TOKENS),
    reasoningEffort: isBlank(config.effort) ? DEFAULT_REASONING_EFFORT : config.effort.trim(),
    timeoutMs: positiveOr(config.timeoutMs, DEFAULT_ROUTING_TIMEOUT_MS),
    systemPrompt: ROUTING_SYSTEM_PROMPT,
    userPrompt: buildRoutingUserPrompt(input.intent, candidates),
  }

  try {
    const reply = await callPort(input.port, request)
    const parsed = parseRoutingReply(reply, new Set(candidates.map((candidate) => candidate.topicId)))
    if (parsed.topicId === null) {
      return { action: 'create', topicId: null, confidence: parsed.confidence, modelUsed: true }
    }
    return { action: 'reuse', topicId: parsed.topicId, confidence: parsed.confidence, modelUsed: true }
  } catch (error) {
    return fallback(describeFailure(error))
  }
}
