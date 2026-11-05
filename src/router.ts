/**
 * Pure keyword router: intent -> scored threads -> reuse/create/needs_subject.
 *
 * No I/O, no host imports, no internal clock: the caller supplies `now`, so a
 * decision is reproducible from its inputs alone. Vector/semantic routing is
 * deliberately out of scope — the thread index is small and the master model
 * writes the subjects that make keyword overlap meaningful.
 */

export type RoutableThreadStatus =
  | 'new'
  | 'active'
  | 'awaiting_review'
  | 'blocked'
  | 'done'
  | 'archived'

/** The slice of a thread the router is allowed to read. */
export interface RoutableThread {
  threadId: string
  subject: string
  status: RoutableThreadStatus
  updatedAt: string
  lastHandoffSummary?: string | null
}

/** Score components, kept so a decision can be explained after the fact. */
export interface ScoreBreakdown {
  subjectOverlap: number
  keywordOverlap: number
  statusPenalty: number
  recencyBonus: number
  total: number
}

/** One thread plus its score. */
export interface ScoredThread {
  threadId: string
  subject: string
  status: RoutableThreadStatus
  score: number
  breakdown: ScoreBreakdown
}

export interface RouteOptions {
  threshold?: number
  now?: Date
  requireMargin?: number
}

export type RouteDecision =
  | { action: 'reuse'; threadId: string; score: number; candidates: ScoredThread[] }
  | { action: 'create'; candidates: ScoredThread[] }
  | { action: 'needs_subject'; candidates: ScoredThread[] }

/** A single shared subject token is worth 3 plus the recency bonus. */
export const DEFAULT_ROUTE_THRESHOLD = 4

const SUBJECT_WEIGHT = 3
const KEYWORD_WEIGHT = 2
const RECENT_DAYS = 7
const STALE_DAYS = 30
const RECENT_BONUS = 1
const STALE_BONUS = 0.5
const DEFAULT_REQUIRE_MARGIN = 1
const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Only `blocked` and `awaiting_review` describe work that is still routable. */
const STATUS_PENALTIES: Record<RoutableThreadStatus, number> = {
  new: 0,
  active: 0,
  awaiting_review: -0.5,
  blocked: -1,
  done: 0,
  archived: 0,
}

const NON_ROUTABLE_STATUSES: ReadonlySet<RoutableThreadStatus> = new Set<RoutableThreadStatus>([
  'done',
  'archived',
])

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
 * Split text into comparable tokens: lowercase ASCII words, and adjacent
 * two-character bigrams for CJK runs (a one-character run stays itself, since
 * it has no neighbour). Duplicates are dropped but first-seen order is kept so
 * the output is deterministic and easy to assert on.
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

/** How many of the intent tokens appear in `otherText` (sets, not multisets). */
function countOverlap(intentTokens: ReadonlySet<string>, otherText: string): number {
  let count = 0
  for (const token of tokenize(otherText)) {
    if (intentTokens.has(token)) count += 1
  }
  return count
}

/**
 * A fresh thread (or a future-dated one — clock skew) earns the full bonus;
 * stale work fades rather than disappearing. An unparseable `updatedAt` earns
 * nothing, because guessing recency would make the score unpredictable.
 */
function recencyBonus(updatedAt: string, now: Date): number {
  const updatedMs = Date.parse(updatedAt)
  if (Number.isNaN(updatedMs)) return 0
  const ageDays = (now.getTime() - updatedMs) / MS_PER_DAY
  if (ageDays < 0) return RECENT_BONUS
  if (ageDays <= RECENT_DAYS) return RECENT_BONUS
  if (ageDays <= STALE_DAYS) return STALE_BONUS
  return 0
}

/** Score one thread against an intent. `now` defaults to the wall clock. */
export function scoreThread(
  intent: string,
  thread: RoutableThread,
  options?: { now?: Date },
): ScoredThread {
  const now = options?.now ?? new Date()
  const intentTokens = new Set(tokenize(intent))
  const subjectOverlap = countOverlap(intentTokens, thread.subject)
  const keywordOverlap = countOverlap(intentTokens, thread.lastHandoffSummary ?? '')
  const statusPenalty = STATUS_PENALTIES[thread.status]
  const recency = recencyBonus(thread.updatedAt, now)
  const total =
    subjectOverlap * SUBJECT_WEIGHT +
    keywordOverlap * KEYWORD_WEIGHT +
    statusPenalty +
    recency

  return {
    threadId: thread.threadId,
    subject: thread.subject,
    status: thread.status,
    score: total,
    breakdown: {
      subjectOverlap,
      keywordOverlap,
      statusPenalty,
      recencyBonus: recency,
      total,
    },
  }
}

/**
 * Score every routable thread and order it: highest score first, then threadId
 * ascending so equal scores never reorder between calls.
 */
export function rankThreads(
  intent: string,
  threads: readonly RoutableThread[],
  options?: { now?: Date },
): ScoredThread[] {
  const now = options?.now ?? new Date()
  const scored: ScoredThread[] = []
  for (const thread of threads) {
    if (NON_ROUTABLE_STATUSES.has(thread.status)) continue
    scored.push(scoreThread(intent, thread, { now }))
  }
  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    if (left.threadId === right.threadId) return 0
    return left.threadId < right.threadId ? -1 : 1
  })
  return scored
}

/**
 * Reuse the best thread only when it clears the threshold and wins by the
 * required margin; a near-tie means the intent is ambiguous, so creating a new
 * thread (or asking the master for a subject) is safer than misrouting.
 */
export function decideRoute(
  intent: string,
  threads: readonly RoutableThread[],
  options?: RouteOptions & { hasSubject?: boolean },
): RouteDecision {
  const threshold = options?.threshold ?? DEFAULT_ROUTE_THRESHOLD
  const requireMargin = options?.requireMargin ?? DEFAULT_REQUIRE_MARGIN
  const hasSubject = options?.hasSubject ?? true
  const candidates = rankThreads(intent, threads, { now: options?.now })
  const top = candidates[0]
  const runnerUp = candidates[1]
  const clearMargin = runnerUp === undefined || top.score - runnerUp.score >= requireMargin

  if (top !== undefined && top.score >= threshold && clearMargin) {
    return { action: 'reuse', threadId: top.threadId, score: top.score, candidates }
  }
  return hasSubject ? { action: 'create', candidates } : { action: 'needs_subject', candidates }
}
