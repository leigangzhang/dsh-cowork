/**
 * Pure three-layer routing core (PLAN-V0.2 §5.3, M9.1).
 *
 * This module replaces the keyword-only model of `src/router.ts` (which stays
 * until `src/tools.ts` switches its call site in M9.3b). It owns the decision
 * rules, not the side effects: no I/O, no clock read and no randomness. The
 * caller injects `context.nowMs`, so a decision is reproducible from its
 * inputs alone.
 *
 * The three layers:
 *
 * 1. Locality: an explicit `topicId` is handled by {@link decideExplicitRoute};
 *    otherwise `focusTopicId`, then `lastRouteTopicId`, is reused directly when
 *    it is still `active`/`idle` and the intent carries no new-topic signal.
 * 2. Structured match: every non-`resolved` topic is scored against the
 *    intent's title/scope/ownedPaths/aliases/digest tokens; each candidate
 *    carries the reasons that produced its score.
 * 3. Model fallback (M9.2) only receives the 1–3 candidates that layer 2 could
 *    not separate; this module never calls a model itself.
 *
 * `resolved` topics never enter the automatic candidates. Renaming intent
 * tokens into aliases ({@link applyRouteCorrection}) and automatic titles
 * ({@link routeCreateTitle}) are pure too, so the write path can call them
 * inside the project lock without re-reading anything.
 */
import type { ProjectIndexV2, TopicRecordV2 } from './store-schema.js'

/** A candidate must reach this score before it can be reused. */
export const ROUTE_THRESHOLD = 4
/** The top candidate must lead the runner-up by this much to be reused. */
export const ROUTE_MARGIN = 1
/** At most this many candidates are handed to the model layer. */
export const ROUTE_MAX_CANDIDATES = 3
/** Automatic titles keep this many Unicode code points. */
export const TOPIC_TITLE_MAX_CHARS = 24
/** A topic keeps at most this many aliases. */
export const ALIAS_MAX_ITEMS = 50
/** One alias longer than this is not a routing token. */
export const ALIAS_MAX_LENGTH = 32

/**
 * Intents that ask for a new topic. The first layer never reuses a focus or a
 * previous route when one of these phrases is present (PLAN §5.3).
 */
export const ROUTE_NEW_TOPIC_SIGNALS = [
  '新开一个',
  '新开',
  '新建',
  '换个主题',
  '换个模块',
  '另一个主题',
  '另开一个',
  '新主题',
] as const

/** What a routing decision asks the caller to do. */
export type RouteAction = 'reuse' | 'create' | 'needs_model' | 'resolved_match'

/** One scored topic plus the reasons that produced its score. */
export interface RouteCandidate {
  topicId: string
  title: string
  score: number
  reasons: string[]
}

/** What the caller knows when it routes one intent. */
export interface RouteContext {
  /** Injected clock, in epoch milliseconds; only recency reads it. */
  nowMs: number
  /** Topic the user currently has open, or null (PLAN §5.3 layer 1). */
  focusTopicId: string | null
  /** Topic the previous route picked, or null (PLAN §5.3 layer 1). */
  lastRouteTopicId: string | null
}

/** The outcome of one routing decision. */
export interface RouteDecision {
  action: RouteAction
  /** Set for `reuse`; the topic to continue. */
  topicId?: string
  /** Set for `resolved_match`; the resolved topic the intent named. */
  resolvedMatch?: { topicId: string; title: string }
  /** Human-readable explanation; always names the layer that decided. */
  reason: string
  /** Scored topics, bounded for `needs_model`; empty when nothing matched. */
  candidates: RouteCandidate[]
}

/** Where routing targets live on the v2 document envelope. */
export interface RouteTargets {
  /** Written to `masterFocusTopicId`; the panel owns this one (M11). */
  focusTopicId?: string | null
  /** Written to `lastRouteTopicId`; the route tool owns this one (M9.3b). */
  lastRouteTopicId?: string | null
}

// Score weights. A path or an alias is a strong signal, a title/scope token is
// medium, and a digest token is weak (the digest is a free-form summary).
const PATH_WEIGHT = 3
const ALIAS_WEIGHT = 3
const TITLE_WEIGHT = 2
const SCOPE_WEIGHT = 2
const DIGEST_WEIGHT = 1
/** A recently touched topic wins ties; this is the only clock-dependent term. */
const RECENCY_BONUS = 0.5
/** How long "recent" lasts, in milliseconds (7 days). */
const RECENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** A single correction adds at most this many aliases. */
const MAX_NEW_ALIASES_PER_CORRECTION = 8
/** Aliases shorter than this would route far too much. */
const ALIAS_MIN_LENGTH = 2

const ASCII_LOWER_A = 0x61
const ASCII_LOWER_Z = 0x7a
const ASCII_ZERO = 0x30
const ASCII_NINE = 0x39

/** Uppercase input is lowercased first, so only [a-z0-9] needs testing. */
function isAsciiAlnum(code: number): boolean {
  return (code >= ASCII_LOWER_A && code <= ASCII_LOWER_Z) || (code >= ASCII_ZERO && code <= ASCII_NINE)
}

/** BMP ideograph ranges: Ext-A, the common unified block, and compatibility. */
function isCjkIdeograph(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff)
  )
}

/**
 * Split text into comparable tokens: lowercase ASCII words plus adjacent
 * two-character bigrams for CJK runs (a one-character run stays itself, since
 * it has no neighbour). Duplicates are dropped and first-seen order kept, so
 * the output is deterministic and cheap to assert on.
 */
export function tokenize(text: string): string[] {
  const lowered = text.toLowerCase()
  const tokens: string[] = []
  const seen = new Set<string>()

  const push = (token: string): void => {
    if (token.length === 0 || seen.has(token)) return
    seen.add(token)
    tokens.push(token)
  }

  let ascii = ''
  let cjk = ''
  const flushAscii = (): void => {
    if (ascii.length === 0) return
    push(ascii)
    ascii = ''
  }
  const flushCjk = (): void => {
    if (cjk.length === 0) return
    if (cjk.length === 1) push(cjk)
    else for (let i = 0; i + 1 < cjk.length; i += 1) push(cjk.slice(i, i + 2))
    cjk = ''
  }

  for (let i = 0; i < lowered.length; i += 1) {
    const code = lowered.charCodeAt(i)
    if (isAsciiAlnum(code)) {
      flushCjk()
      ascii += lowered[i]
      continue
    }
    if (isCjkIdeograph(code)) {
      flushAscii()
      cjk += lowered[i]
      continue
    }
    flushAscii()
    flushCjk()
  }
  flushAscii()
  flushCjk()

  return tokens
}

/** Whether the intent explicitly asks for a new topic. */
function hasNewTopicSignal(intent: string): boolean {
  const lowered = intent.toLowerCase()
  return ROUTE_NEW_TOPIC_SIGNALS.some((signal) => lowered.includes(signal))
}

/** Normalize a path for containment checks; intent text uses either slash. */
function normalizePath(value: string): string {
  return value.toLowerCase().replaceAll('\\', '/').replace(/^\.\//, '')
}

/** The score and reasons one topic earns against one intent. */
function scoreTopic(
  topic: TopicRecordV2,
  intentText: string,
  intentTokens: ReadonlySet<string>,
  nowMs: number,
): RouteCandidate {
  const reasons: string[] = []
  let score = 0

  // Paths are compared as literal substrings: an intent that names a file is
  // a stronger signal than the same words spread across the title.
  for (const path of topic.ownedPaths) {
    const normalized = normalizePath(path)
    if (normalized !== '' && intentText.includes(normalized)) {
      score += PATH_WEIGHT
      reasons.push(`path:${path}`)
    }
  }

  // An alias matches when every token of the alias appears in the intent, so a
  // stored "store" cannot be matched by "restore".
  for (const alias of topic.aliases) {
    const aliasTokens = tokenize(alias)
    if (aliasTokens.length === 0) continue
    if (!aliasTokens.every((token) => intentTokens.has(token))) continue
    score += ALIAS_WEIGHT
    reasons.push(`alias:${alias}`)
  }

  for (const token of tokenize(topic.title)) {
    if (!intentTokens.has(token)) continue
    score += TITLE_WEIGHT
    reasons.push(`title-overlap:${token}`)
  }
  for (const token of tokenize(topic.scope)) {
    if (!intentTokens.has(token)) continue
    score += SCOPE_WEIGHT
    reasons.push(`scope:${token}`)
  }
  for (const token of tokenize(topic.digest)) {
    if (!intentTokens.has(token)) continue
    score += DIGEST_WEIGHT
    reasons.push(`digest:${token}`)
  }

  // The only clock-dependent term: a topic touched within the window wins ties.
  // An unparseable `updatedAt` earns nothing rather than guessing.
  const updatedMs = Date.parse(topic.updatedAt)
  if (!Number.isNaN(updatedMs) && nowMs - updatedMs <= RECENCY_WINDOW_MS) {
    score += RECENCY_BONUS
    reasons.push('recency')
  }

  return { topicId: topic.topicId, title: topic.title, score, reasons }
}

/**
 * Score every non-`resolved` topic and rank it: highest score first, then
 * topicId ascending so equal scores never reorder between calls. Topics with no
 * match reason are omitted — recency alone is not a routing signal.
 */
function rankCandidates(
  intent: string,
  topics: readonly TopicRecordV2[],
  nowMs: number,
): RouteCandidate[] {
  const intentText = normalizePath(intent)
  const intentTokens = new Set(tokenize(intent))
  const scored: RouteCandidate[] = []
  for (const topic of topics) {
    if (topic.status === 'resolved') continue
    const candidate = scoreTopic(topic, intentText, intentTokens, nowMs)
    if (candidate.reasons.some((reason) => reason !== 'recency')) scored.push(candidate)
  }
  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    if (left.topicId === right.topicId) return 0
    return left.topicId < right.topicId ? -1 : 1
  })
  return scored
}

/** The topic a locality id may reuse: present, not `resolved`, and not stale. */
function reuseTargetOf(
  topicId: string | null,
  topics: readonly TopicRecordV2[],
): TopicRecordV2 | null {
  if (topicId === null) return null
  const topic = topics.find((entry) => entry.topicId === topicId)
  if (topic === undefined) return null
  return topic.status === 'active' || topic.status === 'idle' ? topic : null
}

/** A route decision that continues `topic` without scoring anything. */
function reuseDecision(topic: TopicRecordV2, reason: string): RouteDecision {
  return { action: 'reuse', topicId: topic.topicId, reason, candidates: [] }
}

/**
 * Route one intent onto an existing or new topic.
 *
 * Layer 1 reuses the focus topic, then the previous route target, unless the
 * intent asks for a new topic; a `resolved` or unknown target is skipped and
 * layer 2 decides. Layer 2 ranks the remaining topics; a clear winner is
 * reused, a score below {@link ROUTE_THRESHOLD} creates a new topic, and
 * anything in between asks the model layer with at most
 * {@link ROUTE_MAX_CANDIDATES} candidates.
 */
export function decideRoute(
  intent: string,
  topics: readonly TopicRecordV2[],
  context: RouteContext,
): RouteDecision {
  if (!hasNewTopicSignal(intent)) {
    const focus = reuseTargetOf(context.focusTopicId, topics)
    if (focus !== null) return reuseDecision(focus, 'layer1:focus-topic')
    const lastRoute = reuseTargetOf(context.lastRouteTopicId, topics)
    if (lastRoute !== null) return reuseDecision(lastRoute, 'layer1:last-route')
  }

  const ranked = rankCandidates(intent, topics, context.nowMs)
  const top = ranked[0]
  if (top === undefined) {
    return { action: 'create', reason: 'layer2:no-candidates', candidates: [] }
  }
  if (top.score < ROUTE_THRESHOLD) {
    return {
      action: 'create',
      reason: `layer2:below-threshold(score=${top.score})`,
      candidates: ranked,
    }
  }

  const runnerUp = ranked[1]
  const margin = runnerUp === undefined ? top.score : top.score - runnerUp.score
  if (runnerUp === undefined || margin >= ROUTE_MARGIN) {
    return {
      action: 'reuse',
      topicId: top.topicId,
      reason: `layer2:top-candidate(score=${top.score},margin=${margin})`,
      candidates: ranked,
    }
  }
  return {
    action: 'needs_model',
    reason: `layer2:ambiguous(score=${top.score},margin=${margin})`,
    candidates: ranked.slice(0, ROUTE_MAX_CANDIDATES),
  }
}

/**
 * Handle the explicit `topicId` form of `cowork_route`.
 *
 * `null` means the id names no topic (the caller reports an explicit error).
 * A `resolved` topic is reported as `resolved_match` so the caller creates a
 * new topic instead of messaging a finished one. Anything else is reused; an
 * explicit id bypasses both scoring and the new-topic signals.
 */
export function decideExplicitRoute(
  topicId: string,
  topics: readonly TopicRecordV2[],
): RouteDecision | null {
  const topic = topics.find((entry) => entry.topicId === topicId)
  if (topic === undefined) return null
  if (topic.status === 'resolved') {
    return {
      action: 'resolved_match',
      resolvedMatch: { topicId: topic.topicId, title: topic.title },
      reason: 'explicit:resolved',
      candidates: [],
    }
  }
  return reuseDecision(topic, 'explicit:topic')
}

/**
 * Learn from a misroute: append the intent tokens to the topic's aliases.
 *
 * Only `aliases` changes — the status, timestamps and every other field are
 * copied unchanged. Tokens are deduplicated (against existing aliases too),
 * bounded in length ({@link ALIAS_MAX_LENGTH}), added at most
 * {@link MAX_NEW_ALIASES_PER_CORRECTION} at a time, and the list never grows
 * past {@link ALIAS_MAX_ITEMS}. A correction that adds nothing returns the
 * topic itself.
 */
export function applyRouteCorrection(topic: TopicRecordV2, intent: string): TopicRecordV2 {
  const room = ALIAS_MAX_ITEMS - topic.aliases.length
  if (room <= 0) return topic

  const known = new Set(topic.aliases)
  const additions: string[] = []
  for (const token of tokenize(intent)) {
    if (additions.length >= MAX_NEW_ALIASES_PER_CORRECTION || additions.length >= room) break
    if (token.length < ALIAS_MIN_LENGTH || token.length > ALIAS_MAX_LENGTH) continue
    if (known.has(token)) continue
    known.add(token)
    additions.push(token)
  }
  if (additions.length === 0) return topic
  return { ...topic, aliases: [...topic.aliases, ...additions] }
}

/**
 * The automatic title of a new topic: all whitespace folded to one space,
 * trimmed, and cut to {@link TOPIC_TITLE_MAX_CHARS} Unicode code points so an
 * emoji is never split in half. An empty intent has a fixed fallback.
 */
export function routeCreateTitle(intent: string): string {
  const collapsed = intent.replace(/\s+/gu, ' ').trim()
  if (collapsed === '') return '未命名主题'
  const title = Array.from(collapsed).slice(0, TOPIC_TITLE_MAX_CHARS).join('').trim()
  return title === '' ? '未命名主题' : title
}

/** Validate one routing target; the document must never hold a broken id. */
function requireRouteTarget(name: string, value: string | null): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string or null`)
  }
  return value
}

/**
 * Return a copy of the v2 document with the given routing targets changed.
 *
 * `undefined` leaves a target as it was, `null` clears it, and a string sets
 * it; an empty/whitespace string or a non-string throws. The rest of the
 * document envelope (`projectId`, `masterSessionId`, unknown fields, …) is
 * copied untouched, so `mutateIndexDocument` sees a complete document.
 */
export function withRouteTargets(document: ProjectIndexV2, targets: RouteTargets): ProjectIndexV2 {
  const next = { ...(document as unknown as Record<string, unknown>) }
  if (targets.focusTopicId !== undefined) {
    next.masterFocusTopicId = requireRouteTarget('focusTopicId', targets.focusTopicId)
  }
  if (targets.lastRouteTopicId !== undefined) {
    next.lastRouteTopicId = requireRouteTarget('lastRouteTopicId', targets.lastRouteTopicId)
  }
  return next as unknown as ProjectIndexV2
}
