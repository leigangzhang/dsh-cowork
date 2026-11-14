/**
 * Topic notices: the per-event 1:1 notification model of the topic page.
 *
 * One business event (assignment / report / proposal / authorization / archive)
 * becomes exactly one notice per target — the master session and, except for
 * archiving, the topic session. The event row in `activity.jsonl` is the only
 * source of the text: it carries a bounded descriptor in `details.notice`, and
 * {@link noticeFor} renders the per-target copy as a pure function. The ledger
 * (`notices.json`, v1) records delivery state only, keyed by
 * `(noticeId, target)` with `noticeId = activity.eventId`, so a replayed event
 * can never produce a second row.
 *
 * `TopicNoticePort` is the host side. DSH 0.2.1-rc.2 has no notice channel (A2
 * is unavailable), so {@link NoopTopicNoticePort} reports
 * `capabilities().supported === false` and the dispatcher leaves every row
 * `pending`: the ledger never claims a delivery that did not happen. When the
 * host ships the notice channel, only this file's port adapter needs replacing.
 *
 * The dispatcher is deliberately non-blocking: tools append the event and the
 * ledger rows, kick it, and return. A delivery failure is recorded on the row
 * (bounded retries, exponential backoff) and never rolls the topic state back.
 */
import { attemptDelivery, retryDelaySchedule } from './delivery.js'
import { isNoticeKind, type NoticeKind } from './notice-contract.js'
import { ACTIVITY_MAX_EVENTS } from './store/schema.js'
import type { ActivityEvent, ProjectIndexV2, ReadActivityResult } from './store/schema.js'

/** Default plugin id stamped on every notice. */
export const DEFAULT_NOTICE_PLUGIN_ID = '@dsh-external/dsh-cowork'

/** Every target a notice can be addressed to. */
export const NOTICE_TARGETS = ['master', 'topic'] as const
/** One side of the 1:1 delivery: the master session or the topic session. */
export type NoticeTarget = (typeof NOTICE_TARGETS)[number]

/** The notice kinds the topic page emits, re-exported from the shared vocabulary. */
export { NOTICE_KINDS } from './notice-contract.js'
export type { NoticeKind } from './notice-contract.js'

/** The decision state a notice carries. */
export const NOTICE_STATUSES = ['pending', 'allowed', 'denied', 'void'] as const
/** Decision state of one notice. */
export type NoticeStatus = (typeof NOTICE_STATUSES)[number]

/** Actions a rendered notice may offer. */
export const NOTICE_ACTIONS = ['allow', 'deny', 'open-topic', 'open-work-item'] as const
/** One offered notice action. */
export type NoticeAction = (typeof NOTICE_ACTIONS)[number]

/** Delivery states the ledger records; `void` means the event was withdrawn. */
export const NOTICE_DELIVERY_STATUSES = ['pending', 'delivered', 'failed', 'void'] as const
/** Delivery state of one ledger row. */
export type NoticeDeliveryStatus = (typeof NOTICE_DELIVERY_STATUSES)[number]

/** Version of `notices.json` this module writes. */
export const NOTICE_LEDGER_VERSION = 1
/** Most rows the ledger keeps; the oldest-by-update rows are dropped first. */
export const NOTICE_LEDGER_MAX_RECORDS = 200
/** Most delivery attempts one row gets. */
export const NOTICE_MAX_ATTEMPTS = 5
/** Backoff between failed attempts: 1 s, 5 s, 30 s, 30 s (max 5 attempts). */
export const NOTICE_RETRY_DELAYS_MS = [1000, 5000, 30000, 30000] as const

/** Longest notice title, in code points. */
export const NOTICE_TITLE_MAX_CHARS = 80
/** Longest notice summary, in code points. */
export const NOTICE_SUMMARY_MAX_CHARS = 200

/** One rendered notice as the port (and a future client card) sees it. */
export interface TopicNotice {
  noticeId: string
  pluginId: string
  topicId: string
  kind: NoticeKind
  title: string
  summary: string
  status: NoticeStatus
  actions: NoticeAction[]
  createdAt: string
  updatedAt: string
}

/** One row of the delivery ledger (`notices.json` v1). */
export interface NoticeLedgerRecord {
  /** `activity.eventId` of the event that produced the notice. */
  noticeId: string
  topicId: string
  target: NoticeTarget
  status: NoticeDeliveryStatus
  attempts: number
  lastError: string | null
  updatedAt: string
}

/** The delivery ledger document. */
export interface NoticeLedgerV1 {
  version: 1
  notices: NoticeLedgerRecord[]
}

/** What one port implementation can do. */
export interface TopicNoticeCapabilities {
  /** Whether the host can display a notice at all. */
  supported: boolean
  /** Whether a rendered card can offer action buttons. */
  actions: boolean
  /** Whether an existing notice can be updated in place (authorization outcome). */
  updates: boolean
}

/** The fields an authorization outcome may patch on an existing notice. */
export interface TopicNoticePatch {
  status?: NoticeStatus
  summary?: string
  updatedAt?: string
}

/**
 * The host notice port. `append` is idempotent by `noticeId`; a host that
 * already has the notice answers `duplicate` so a replay cannot double-post.
 */
export interface TopicNoticePort {
  capabilities(): TopicNoticeCapabilities
  append(sessionId: string, notice: TopicNotice): Promise<'delivered' | 'duplicate'>
  update(sessionId: string, noticeId: string, patch: TopicNoticePatch): Promise<'delivered' | 'duplicate'>
}

/** The bounded descriptor an activity row embeds in `details.notice`. */
export interface ActivityNoticeDescriptor {
  kind: NoticeKind
  title: string
  summary: string
  targets: readonly NoticeTarget[]
  actions?: readonly NoticeAction[]
  status?: NoticeStatus
}

/** Cut text to at most `limit` code points without splitting a pair. */
export function clipNoticeText(text: string, limit: number): string {
  const points = Array.from(text)
  return points.length <= limit ? text : points.slice(0, limit).join('')
}

/** Build one bounded descriptor from already-validated input. */
export function noticeDescriptor(input: {
  kind: NoticeKind
  title: string
  summary: string
  targets: readonly NoticeTarget[]
  actions?: readonly NoticeAction[]
  status?: NoticeStatus
}): ActivityNoticeDescriptor {
  const descriptor: ActivityNoticeDescriptor = {
    kind: input.kind,
    title: clipNoticeText(input.title.trim(), NOTICE_TITLE_MAX_CHARS),
    summary: clipNoticeText(input.summary.trim(), NOTICE_SUMMARY_MAX_CHARS),
    targets: [...input.targets],
  }
  if (input.actions !== undefined && input.actions.length > 0) descriptor.actions = [...input.actions]
  if (input.status !== undefined) descriptor.status = input.status
  return descriptor
}

/** Whether a value is a JSON object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a value is a string `Date.parse` accepts. */
function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

/** Read the descriptor out of one event, or null when it carries none. */
export function noticeDescriptorOf(event: ActivityEvent): ActivityNoticeDescriptor | null {
  const details = event.details
  if (!isRecord(details)) return null
  const raw = details.notice
  if (!isRecord(raw)) return null
  if (!isNoticeKind(raw.kind)) return null
  if (typeof raw.title !== 'string' || typeof raw.summary !== 'string') return null
  if (!Array.isArray(raw.targets)) return null
  const targets = raw.targets.filter(
    (target): target is NoticeTarget => (NOTICE_TARGETS as readonly string[]).includes(target as string),
  )
  if (targets.length === 0 || targets.length !== raw.targets.length) return null
  const actions = Array.isArray(raw.actions)
    ? raw.actions.filter(
      (action): action is NoticeAction => (NOTICE_ACTIONS as readonly string[]).includes(action as string),
    )
    : []
  const status = (NOTICE_STATUSES as readonly string[]).includes(raw.status as string)
    ? (raw.status as NoticeStatus)
    : undefined
  const descriptor: ActivityNoticeDescriptor = {
    kind: raw.kind as NoticeKind,
    title: raw.title,
    summary: raw.summary,
    targets,
    actions,
  }
  if (status !== undefined) descriptor.status = status
  return descriptor
}

/** The notice id an event carries: `details.noticeId` for an update, else its own id. */
export function noticeIdOf(event: ActivityEvent): string {
  const candidate = isRecord(event.details) ? event.details.noticeId : undefined
  return typeof candidate === 'string' && candidate.trim() !== '' ? candidate : event.eventId
}

/** Title per kind/target; the summary is always the event's bounded excerpt. */
const NOTICE_TITLE: Readonly<Record<NoticeKind, Readonly<Record<NoticeTarget, string>>>> = {
  assignment: { master: '新主题已分配', topic: '你收到一个新主题' },
  report: { master: '主题上报', topic: '上报已同步' },
  proposal: { master: '决策提案', topic: '决策提案已上报' },
  authorization: { master: '等待你的授权', topic: '等待授权' },
  archive: { master: '主题已归档', topic: '主题已归档' },
}

/** Default actions per kind, used only when the descriptor names none. */
const NOTICE_DEFAULT_ACTIONS: Readonly<Record<NoticeKind, readonly NoticeAction[]>> = {
  assignment: [],
  report: [],
  proposal: ['open-work-item'],
  authorization: ['allow', 'deny'],
  archive: [],
}

/** The first line of a notice summary, prefixed with the topic title. */
function noticeBody(event: ActivityEvent, descriptor: ActivityNoticeDescriptor): string {
  void event
  const subject = descriptor.title.trim() === '' ? '主题' : `「${descriptor.title.trim()}」`
  return clipNoticeText(`${subject} ${descriptor.summary}`.trim(), NOTICE_SUMMARY_MAX_CHARS)
}

/**
 * Render the notice one event gives one target, or null when that target is not
 * addressed. Pure and total: a malformed descriptor yields null, never a throw.
 * The archive event addresses the master only, which is why its topic copy is
 * unreachable.
 */
export function noticeFor(
  event: ActivityEvent,
  target: NoticeTarget,
  options: { pluginId?: string } = {},
): TopicNotice | null {
  if (target === 'topic' && event.type === 'topic-archived') return null
  const descriptor = noticeDescriptorOf(event)
  if (descriptor === null || !descriptor.targets.includes(target)) return null
  const status: NoticeStatus = descriptor.status ?? 'pending'
  const actions = descriptor.actions ?? NOTICE_DEFAULT_ACTIONS[descriptor.kind]
  return {
    noticeId: noticeIdOf(event),
    pluginId: options.pluginId ?? DEFAULT_NOTICE_PLUGIN_ID,
    topicId: event.topicId ?? '',
    kind: descriptor.kind,
    title: NOTICE_TITLE[descriptor.kind][target],
    summary: noticeBody(event, descriptor),
    status,
    actions: [...actions],
    createdAt: event.time,
    updatedAt: event.time,
  }
}

/** Every notice one event produces, in target order. */
export function noticesOf(
  event: ActivityEvent,
  options: { pluginId?: string } = {},
): TopicNotice[] {
  const descriptor = noticeDescriptorOf(event)
  if (descriptor === null) return []
  const notices: TopicNotice[] = []
  for (const target of descriptor.targets) {
    const notice = noticeFor(event, target, options)
    if (notice !== null) notices.push(notice)
  }
  return notices
}

/** An empty ledger. */
export function emptyNoticeLedger(): NoticeLedgerV1 {
  return { version: NOTICE_LEDGER_VERSION, notices: [] }
}

/** Schema problems of one ledger row, addressed as `notices[i]...`. */
function noticeRecordProblems(record: unknown, where: string): string[] {
  if (!isRecord(record)) return [`${where} must be an object`]
  const problems: string[] = []
  if (typeof record.noticeId !== 'string' || record.noticeId.trim() === '') {
    problems.push(`${where}.noticeId must be a non-empty string`)
  }
  if (typeof record.topicId !== 'string' || record.topicId.trim() === '') {
    problems.push(`${where}.topicId must be a non-empty string`)
  }
  if (!(NOTICE_TARGETS as readonly string[]).includes(record.target as string)) {
    problems.push(`${where}.target must be one of ${NOTICE_TARGETS.join('|')}`)
  }
  if (!(NOTICE_DELIVERY_STATUSES as readonly string[]).includes(record.status as string)) {
    problems.push(`${where}.status must be one of ${NOTICE_DELIVERY_STATUSES.join('|')}`)
  }
  if (!Number.isInteger(record.attempts) || (record.attempts as number) < 0) {
    problems.push(`${where}.attempts must be a non-negative integer`)
  }
  if (record.lastError !== null && typeof record.lastError !== 'string') {
    problems.push(`${where}.lastError must be a string or null`)
  }
  if (!isIsoDate(record.updatedAt)) problems.push(`${where}.updatedAt must be an ISO 8601 timestamp`)
  return problems
}

/** Schema problems of a whole notice ledger. An empty array means it is valid. */
export function noticeLedgerProblems(ledger: unknown): string[] {
  if (!isRecord(ledger)) return ['notice ledger must be a JSON object']
  const problems: string[] = []
  if (ledger.version !== NOTICE_LEDGER_VERSION) {
    problems.push(`notice ledger.version must be ${NOTICE_LEDGER_VERSION}`)
  }
  if (!Array.isArray(ledger.notices)) {
    problems.push('notice ledger.notices must be an array')
  } else {
    ledger.notices.forEach((record, position) => {
      problems.push(...noticeRecordProblems(record, `notices[${position}]`))
    })
  }
  return problems
}

/**
 * Keep the newest {@link NOTICE_LEDGER_MAX_RECORDS} rows by `updatedAt`, ties
 * resolved by the input order. The oldest rows are dropped first.
 */
export function trimNoticeLedger(records: readonly NoticeLedgerRecord[]): NoticeLedgerRecord[] {
  if (records.length <= NOTICE_LEDGER_MAX_RECORDS) return [...records]
  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      const delta = Date.parse(left.record.updatedAt) - Date.parse(right.record.updatedAt)
      if (Number.isFinite(delta) && delta !== 0) return delta
      return left.index - right.index
    })
    .slice(-NOTICE_LEDGER_MAX_RECORDS)
    .map(({ record }) => record)
}

/** The narrow store port the ledger writer needs; `ProjectStore` satisfies it. */
export interface NoticeLedgerStorePort {
  readNotices(): Promise<NoticeLedgerV1>
  writeNotices(ledger: NoticeLedgerV1): Promise<NoticeLedgerV1>
  /**
   * Locked read-modify-write. `ProjectStore` implements it; a caller that has
   * it must use it, because read + write without one lock loses concurrent rows.
   */
  mutateNotices?(mutator: (ledger: NoticeLedgerV1) => NoticeLedgerV1): Promise<NoticeLedgerV1>
}

/** One parse of `notices.json`: the value, or the JSON/validation failure. */
export interface ParsedNoticeLedger {
  ledger: NoticeLedgerV1 | null
  jsonError: string | null
  problems: string[]
}

/** Parse one ledger document without touching the file system. */
export function parseNoticeLedgerText(text: string): ParsedNoticeLedger {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ledger: null, jsonError: error instanceof Error ? error.message : String(error), problems: [] }
  }
  const problems = noticeLedgerProblems(parsed)
  if (problems.length > 0) return { ledger: null, jsonError: null, problems }
  return { ledger: parsed as NoticeLedgerV1, jsonError: null, problems: [] }
}

/** Validate a ledger before writing it and trim it to its newest rows. */
export function prepareNoticeLedger(ledger: unknown): { ledger: NoticeLedgerV1 | null; problems: string[] } {
  const problems = noticeLedgerProblems(ledger)
  if (problems.length > 0) return { ledger: null, problems }
  const value = ledger as NoticeLedgerV1
  return {
    ledger: { version: NOTICE_LEDGER_VERSION, notices: trimNoticeLedger(value.notices) },
    problems: [],
  }
}

/**
 * Append one ledger row per target of `event`. Upserts by
 * `(noticeId, target)`, so replaying the same event never grows the ledger.
 * `authorization-resolved` is an update of the original notice, not a new one:
 * it writes no row (the port is patched instead), which is what keeps the
 * 1:1 rule intact across the decision.
 */
export async function recordNoticesForEvent(
  store: NoticeLedgerStorePort,
  event: ActivityEvent,
  now: Date,
  pluginId: string = DEFAULT_NOTICE_PLUGIN_ID,
): Promise<NoticeLedgerRecord[]> {
  void pluginId
  if (event.type === 'authorization-resolved') return []
  if (event.topicId === null) return []
  const descriptor = noticeDescriptorOf(event)
  if (descriptor === null) return []
  const noticeId = noticeIdOf(event)
  const updatedAt = now.toISOString()
  let written: NoticeLedgerRecord[] = []
  /** Upsert one row per target; returns the ledger the locked writer persists. */
  const apply = (ledger: NoticeLedgerV1): NoticeLedgerV1 => {
    const rows = [...ledger.notices]
    written = []
    for (const target of descriptor.targets) {
      const at = rows.findIndex((row) => row.noticeId === noticeId && row.target === target)
      if (at >= 0) {
        rows[at] = { ...rows[at], updatedAt }
        written.push(rows[at])
        continue
      }
      const record: NoticeLedgerRecord = {
        noticeId,
        topicId: event.topicId ?? '',
        target,
        status: 'pending',
        attempts: 0,
        lastError: null,
        updatedAt,
      }
      rows.push(record)
      written.push(record)
    }
    return { version: NOTICE_LEDGER_VERSION, notices: rows }
  }
  // The locked path is the only safe one under concurrent events; the plain
  // read+write branch exists for a hand-built port in tests.
  if (store.mutateNotices !== undefined) {
    await store.mutateNotices(apply)
    return written
  }
  await store.writeNotices(apply(await store.readNotices()))
  return written
}

/**
 * Withdraw the notice of a pending authorization because the topic was
 * archived: the request can no longer be decided, so its ledger rows become
 * `void` and the master-facing listing stops showing a pending request. A host
 * channel that already delivered the card (A2) is patched to `void` on the same
 * noticeId — the archive must not leave a live allow/deny button behind.
 */
export async function findAuthorizationNoticeId(
  store: { readActivity?(limit?: number): Promise<ReadActivityResult> },
  topicId: string,
  requestId: string,
): Promise<string | null> {
  if (store.readActivity === undefined) return null
  const { events } = await store.readActivity(ACTIVITY_MAX_EVENTS)
  const requested = events.find((event) => {
    if (event.type !== 'authorization-requested' || event.topicId !== topicId) return false
    const details = isRecord(event.details) ? event.details : {}
    return details.requestId === requestId
  })
  return requested?.eventId ?? null
}

export async function voidAuthorizationNotice(input: {
  store: NoticeLedgerStorePort & { readActivity?(limit?: number): Promise<ReadActivityResult> }
  document: ProjectIndexV2
  topicId: string
  requestId: string
  now: Date
  port?: TopicNoticePort
  /** Known id, when the caller already found it for the archive event. */
  noticeId?: string | null
  pluginId?: string
}): Promise<{ noticeId: string | null; voided: number }> {
  const { store } = input
  if (store.readNotices === undefined) {
    return { noticeId: null, voided: 0 }
  }
  const noticeId = input.noticeId ?? await findAuthorizationNoticeId(store, input.topicId, input.requestId)
  if (noticeId === null) return { noticeId: null, voided: 0 }
  const updatedAt = input.now.toISOString()
  let voided = 0
  const apply = (ledger: NoticeLedgerV1): NoticeLedgerV1 => {
    voided = 0
    const notices = ledger.notices.map((row) => {
      if (row.noticeId !== noticeId) return row
      // A row the host already delivered keeps that delivery fact; only the
      // still-pending rows are voided. The card itself is patched below.
      if (row.status === 'delivered') return { ...row, updatedAt }
      voided += 1
      return { ...row, status: 'void' as const, updatedAt }
    })
    return { version: NOTICE_LEDGER_VERSION, notices }
  }
  if (store.mutateNotices !== undefined) {
    await store.mutateNotices(apply)
  } else if (store.writeNotices !== undefined) {
    await store.writeNotices(apply(await store.readNotices()))
  }
  const port = input.port
  if (port !== undefined && port.capabilities().supported) {
    for (const target of NOTICE_TARGETS) {
      const sessionId = target === 'master' ? input.document.masterSessionId : input.topicId
      try {
        await port.update(sessionId, noticeId, { status: 'void', updatedAt })
      } catch {
        // The ledger already says void; a host patch failure is delivery noise.
      }
    }
  }
  return { noticeId, voided }
}

/** What one `updateAuthorizationNotice` call reports. */
export type NoticeUpdateOutcome = 'updated' | 'unsupported' | 'failed'

/**
 * Patch the original authorization notice on both targets after a decision.
 * Never throws: an unsupported host (B) and a failed update are both values, so
 * the route can keep the committed decision and log the delivery problem.
 */
export async function updateAuthorizationNotice(input: {
  port: TopicNoticePort
  document: ProjectIndexV2
  topicId: string
  noticeId: string
  decision: 'allow' | 'deny'
  now: Date
  pluginId?: string
}): Promise<NoticeUpdateOutcome> {
  const { port } = input
  if (!port.capabilities().supported) return 'unsupported'
  const patch: TopicNoticePatch = {
    status: input.decision === 'allow' ? 'allowed' : 'denied',
    updatedAt: input.now.toISOString(),
  }
  let failed = false
  for (const target of NOTICE_TARGETS) {
    const sessionId = target === 'master' ? input.document.masterSessionId : input.topicId
    try {
      await port.update(sessionId, input.noticeId, patch)
    } catch {
      failed = true
    }
  }
  return failed ? 'failed' : 'updated'
}

/**
 * The B-mode port: DSH 0.2.1-rc.2 exposes no notice channel. It reports
 * `supported: false` and refuses to pretend; the dispatcher never calls it
 * while unsupported, so the ledger stays `pending`.
 */
export class NoopTopicNoticePort implements TopicNoticePort {
  capabilities(): TopicNoticeCapabilities {
    return { supported: false, actions: false, updates: false }
  }

  async append(): Promise<'delivered' | 'duplicate'> {
    throw new Error('the host exposes no topic notice channel; the notice ledger stays pending')
  }

  async update(): Promise<'delivered' | 'duplicate'> {
    throw new Error('the host exposes no topic notice channel; the notice ledger stays pending')
  }
}

/**
 * A fixture port for development and tests: it records what a delivery would
 * have sent and still reports `supported: false`, so it exercises the B path
 * (ledger stays pending) without a host.
 */
export class FixtureTopicNoticePort implements TopicNoticePort {
  readonly appended: Array<{ sessionId: string; notice: TopicNotice }> = []
  readonly updated: Array<{ sessionId: string; noticeId: string; patch: TopicNoticePatch }> = []

  capabilities(): TopicNoticeCapabilities {
    return { supported: false, actions: false, updates: false }
  }

  async append(sessionId: string, notice: TopicNotice): Promise<'delivered' | 'duplicate'> {
    this.appended.push({ sessionId, notice })
    return 'duplicate'
  }

  async update(sessionId: string, noticeId: string, patch: TopicNoticePatch): Promise<'delivered' | 'duplicate'> {
    this.updated.push({ sessionId, noticeId, patch })
    return 'duplicate'
  }
}

/** The store operations the dispatcher needs; `ProjectStore` satisfies it. */
export interface NoticeDispatchStorePort extends NoticeLedgerStorePort {
  readActivity(limit?: number): Promise<ReadActivityResult>
  readIndexDocument(): Promise<ProjectIndexV2>
}

/** Everything the dispatcher needs; the host wires the production values. */
export interface TopicNoticeDispatcherOptions {
  storeFor(repoPath: string): NoticeDispatchStorePort
  port: TopicNoticePort
  clock(): Date
  log?(message: string): void
  /** Injected backoff so a test does not wait 66 s. */
  sleep?(ms: number): Promise<void>
  pluginId?: string
  /** Delivery attempts per row; defaults to {@link NOTICE_MAX_ATTEMPTS}. */
  maxAttempts?: number
}

/**
 * Deliver pending notices per project, one event at a time.
 *
 * `kick(repoPath)` schedules a drain and returns immediately; drains for one
 * project are chained so events are delivered in ledger order. A drain never
 * throws: a failed read or write is logged, and a failed delivery is recorded on
 * the row. Replaying is safe: delivered rows are skipped and the port answers
 * `duplicate` by `noticeId`, so an at-least-once host cannot double-post.
 */
export class TopicNoticeDispatcher {
  private readonly options: TopicNoticeDispatcherOptions
  private readonly chains = new Map<string, Promise<void>>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private disposed = false

  constructor(options: TopicNoticeDispatcherOptions) {
    this.options = options
  }

  /** Schedule one drain for `repoPath`; never throws into the caller. */
  kick(repoPath: string): void {
    void this.drain(repoPath).catch((error: unknown) => {
      this.log(`notice drain failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** Queue one drain behind the previous one for the same project and await it. */
  drain(repoPath: string): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const previous = this.chains.get(repoPath) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => this.run(repoPath))
    this.chains.set(repoPath, next)
    void next.finally(() => {
      if (this.chains.get(repoPath) === next) this.chains.delete(repoPath)
    })
    return next
  }

  /** How many projects currently have a drain in flight or queued. */
  pending(): number {
    return this.chains.size
  }

  /** Stop scheduling and clear any backoff timer this dispatcher owns. */
  dispose(): void {
    this.disposed = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.chains.clear()
  }

  private async run(repoPath: string): Promise<void> {
    if (this.disposed) return
    try {
      const port = this.options.port
      if (!port.capabilities().supported) return
      const store = this.options.storeFor(repoPath)
      const ledger = await store.readNotices()
      const pending = ledger.notices.filter((row) => row.status === 'pending')
      if (pending.length === 0) return
      // Cover the whole activity stream the ledger can point at: the default
      // read is 50 rows, so an older pending notice would look "not found".
      const snapshot = await store.readActivity(ACTIVITY_MAX_EVENTS)
      const byId = new Map(snapshot.events.map((event) => [event.eventId, event]))
      const document = await store.readIndexDocument()
      let changed = false
      for (const record of ledger.notices) {
        if (record.status !== 'pending') continue
        const event = byId.get(record.noticeId)
        if (event === undefined) {
          record.status = 'failed'
          record.lastError = 'activity event not found'
          record.updatedAt = this.options.clock().toISOString()
          changed = true
          continue
        }
        const notice = noticeFor(event, record.target, { pluginId: this.options.pluginId })
        if (notice === null) {
          record.status = 'void'
          record.lastError = `event ${record.noticeId} does not address ${record.target}`
          record.updatedAt = this.options.clock().toISOString()
          changed = true
          continue
        }
        const sessionId = record.target === 'master'
          ? document.masterSessionId
          : record.topicId
        if (await this.deliver(sessionId, notice, record)) {
          record.status = 'delivered'
          record.lastError = null
          changed = true
        } else {
          changed = true
        }
      }
      if (changed) await store.writeNotices(ledger)
    } catch (error) {
      this.log(`notice drain failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * One row's delivery loop: up to `maxAttempts` appends with the documented
   * backoff. `true` means delivered (or the host already had it); `false` means
   * the row exhausted its attempts and stays on the ledger as `failed`.
   */
  private async deliver(
    sessionId: string,
    notice: TopicNotice,
    record: NoticeLedgerRecord,
  ): Promise<boolean> {
    const maxAttempts = Math.max(1, this.options.maxAttempts ?? NOTICE_MAX_ATTEMPTS)
    const result = await attemptDelivery(
      () => this.options.port.append(sessionId, notice),
      {
        maxAttempts,
        retryDelaysMs: retryDelaySchedule(maxAttempts, NOTICE_RETRY_DELAYS_MS),
        sleep: (ms) => this.wait(ms),
        onAttempt: (attempt) => {
          record.attempts = attempt
          record.updatedAt = this.options.clock().toISOString()
        },
      },
    )
    // `append` resolves with 'delivered' or 'duplicate'; both count as delivery.
    if (result.delivered) return true
    record.lastError = result.error
    record.status = 'failed'
    return false
  }

  private wait(ms: number): Promise<void> {
    if (this.options.sleep !== undefined) return this.options.sleep(ms)
    return new Promise<void>((settle) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        settle()
      }, ms)
      this.timers.add(timer)
    })
  }

  private log(message: string): void {
    this.options.log?.(message)
  }
}

/** One notice row as the master-facing `cowork_notices` tool reports it. */
export interface NoticeSummary {
  noticeId: string
  topicId: string
  kind: NoticeKind
  title: string
  summary: string
  status: NoticeStatus
  actions: NoticeAction[]
  createdAt: string
  updatedAt: string
  delivery: {
    status: NoticeDeliveryStatus
    attempts: number
    lastError: string | null
  }
  /** Proposal id carried by a `decision-proposed` event. */
  proposalId?: string
  /** Repo-relative proposal file path, when the event carries it. */
  proposalPath?: string
}

/**
 * Project the activity tail onto one row per `(noticeId, target)`, newest event
 * winning. An `authorization-resolved` row points at the original notice id, so
 * the decision overwrites the pending row instead of adding a second one; the
 * ledger supplies the delivery state of the same id. Pure: no I/O, no clock.
 */
export function noticeSummaries(
  events: readonly ActivityEvent[],
  ledger: NoticeLedgerV1,
  options: { pluginId?: string; target?: NoticeTarget } = {},
): NoticeSummary[] {
  const target = options.target ?? 'master'
  // An archive withdraws a pending authorization; a card the host already
  // delivered keeps its delivery row, so the event carries the withdrawn id.
  const voidedIds = new Set<string>()
  for (const event of events) {
    if (event.type !== 'topic-archived') continue
    const details = isRecord(event.details) ? event.details : {}
    if (typeof details.voidedAuthorizationNoticeId === 'string') {
      voidedIds.add(details.voidedAuthorizationNoticeId)
    }
  }
  const byId = new Map<string, TopicNotice>()
  const detailsById = new Map<string, Record<string, unknown>>()
  for (const event of events) {
    const notice = noticeFor(event, target, { pluginId: options.pluginId })
    if (notice === null) continue
    detailsById.set(notice.noticeId, isRecord(event.details) ? event.details : {})
    const previous = byId.get(notice.noticeId)
    if (previous !== undefined && Date.parse(previous.updatedAt) > Date.parse(notice.updatedAt)) continue
    // An update (the authorization decision) replaces the state but keeps the
    // notice's original creation time: the card is the same card.
    byId.set(
      notice.noticeId,
      previous === undefined ? notice : { ...notice, createdAt: previous.createdAt },
    )
  }
  const rows: NoticeSummary[] = []
  for (const notice of byId.values()) {
    const ledgerRow = ledger.notices.find(
      (row) => row.noticeId === notice.noticeId && row.target === target,
    )
    // A row the ledger voided (archiving wipes a pending authorization) is a
    // withdrawn notice: it keeps its history but can no longer be acted on.
    const voided = ledgerRow?.status === 'void' || voidedIds.has(notice.noticeId)
    const details = detailsById.get(notice.noticeId) ?? {}
    const proposalId = typeof details.proposalId === 'string' && details.proposalId !== ''
      ? details.proposalId
      : undefined
    const proposalPath = typeof details.proposalPath === 'string' && details.proposalPath !== ''
      ? details.proposalPath
      : undefined
    rows.push({
      noticeId: notice.noticeId,
      topicId: notice.topicId,
      kind: notice.kind,
      title: notice.title,
      summary: notice.summary,
      status: voided ? 'void' : notice.status,
      actions: voided ? [] : notice.actions,
      createdAt: notice.createdAt,
      updatedAt: notice.updatedAt,
      delivery: {
        status: ledgerRow?.status ?? 'pending',
        attempts: ledgerRow?.attempts ?? 0,
        lastError: ledgerRow?.lastError ?? null,
      },
      ...(proposalId === undefined ? {} : { proposalId }),
      ...(proposalPath === undefined ? {} : { proposalPath }),
    })
  }
  return rows.sort((left, right) => {
    const delta = Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    if (delta !== 0 && Number.isFinite(delta)) return delta
    return left.noticeId < right.noticeId ? -1 : left.noticeId > right.noticeId ? 1 : 0
  })
}
