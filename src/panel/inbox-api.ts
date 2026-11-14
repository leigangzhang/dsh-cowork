/**
 * HTTP surface of the Cowork request inbox (topic inbox, 2026-11-10).
 *
 * Three Exact Fetch routes — `GET /api/cowork.inbox`, `POST
 * /api/cowork.inbox.resolve` and `POST /api/cowork.inbox.open` — live here
 * rather than in `src/panel/api.ts`, which sits at the repository's 50 KiB read cap.
 * The module owns only the wire projection: which request files and activity
 * rows become inbox rows, how the counts are computed, and how one resolution
 * is rendered. The state machine is `src/domains/requests/request-service.ts`; the vocabulary is
 * `src/panel/inbox-contract.ts`.
 *
 * Reads report facts and never write: the GET route does not run the lifecycle,
 * does not touch the notice ledger, and does not wake a model. Notifications are
 * a projection of the activity tail — no ledger row is created for this view —
 * and the automatic reviewer's `review-verdict` row is a centered grey note
 * with no action and no open target, never a request card.
 */
import {
  INBOX_MAX_ITEMS,
  INBOX_OPEN_PATH,
  INBOX_PATH,
  INBOX_RESOLVE_PATH,
  actionsForKind,
  emptyInboxCounts,
  isRequestAction,
  isTerminalStatus,
} from './inbox-contract.js'
import { truncateSummary } from './api-contract.js'
import type {
  AuthorizationPayload,
  InboxCounts,
  InboxItem,
  InboxNotificationItem,
  InboxOpenResponse,
  InboxRequestItem,
  InboxResolveResponse,
  InboxResponse,
  PlanPayload,
  QuestionPayload,
  RequestRecordV1,
  ReviewPayload,
} from './inbox-contract.js'
import type { PanelErrorCode } from './api-contract.js'
import { emptyNoticeLedger, noticeSummaries } from '../domains/notices/notices.js'
import type { NoticeLedgerV1, NoticeSummary } from '../domains/notices/notices.js'
import type { NoticeKind } from './notice-contract.js'
import { PanelServiceError, openRequestTarget, resolveRequest } from '../domains/requests/request-service.js'
import { RequestStore } from '../store/request-store.js'
import { ACTIVITY_MAX_EVENTS } from '../store/schema.js'
import type { ActivityEvent, ProjectIndexV2 } from '../store/schema.js'
import type { CoworkApiPorts, CoworkStorePort, PanelFetchRoute } from './api-types.js'

/** Placeholder topic title for a topic the index no longer lists. */
export const INBOX_ARCHIVED_TOPIC_TITLE = '已归档主题'

/** Text of one automatic-review note, per verdict. */
const REVIEW_VERDICT_LABEL: Readonly<Record<string, string>> = {
  pass: '通过',
  needs_revision: '需修改',
  reject: '拒绝',
}

/**
 * The route plumbing `src/panel/api.ts` already owns: project discovery from a
 * session id, the bounded JSON body reader, the one JSON response, and the
 * same-origin + error-envelope wrapper. Injected as a value (not imported) so
 * this module imports neither `src/panel/api.ts` nor its implementation; the shared
 * port/route types come from `src/panel/api-types.ts`.
 */
export interface InboxApiKit {
  openProject(sessionId: string): Promise<{ store: CoworkStorePort; repoPath: string }>
  readJsonBody(request: Request): Promise<Record<string, unknown>>
  jsonResponse(status: number, payload: unknown): Response
  serve(handler: (request: Request) => Promise<Response>): (request: Request) => Promise<Response>
}

/** The store methods the inbox read needs; `ProjectStore` satisfies them. */
type InboxStore = CoworkStorePort & {
  readNotices?(): Promise<NoticeLedgerV1>
}

/** A query parameter, or null when absent or blank. */
function queryParam(request: Request, name: string): string | null {
  const value = new URL(request.url).searchParams.get(name)
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** A required query parameter; a blank value is missing, not empty. */
function requireQueryParam(request: Request, name: string, code: PanelErrorCode): string {
  const value = queryParam(request, name)
  if (value === null) throw new PanelServiceError(code, `query parameter ${name} is required`)
  return value
}

/** One required non-blank string field of a write body. */
function requireBodyString(body: Record<string, unknown>, name: string, code: PanelErrorCode): string {
  const value = body[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PanelServiceError(code, `body field ${name} is required`)
  }
  return value.trim()
}

/** The topic title, or the archived placeholder when the index lost the topic. */
function topicTitleOf(titles: ReadonlyMap<string, string>, topicId: string): string {
  return titles.get(topicId) ?? INBOX_ARCHIVED_TOPIC_TITLE
}

/**
 * One persisted request as the inbox row the browser renders. The record schema
 * already validated `payload` against `kind`, so the cast only restores the
 * discriminated-union narrowing TypeScript cannot infer from a flat record.
 */
function toInboxRequestItem(record: RequestRecordV1, topicTitle: string): InboxRequestItem {
  const base = {
    kind: 'request' as const,
    requestId: record.requestId,
    topicId: record.topicId,
    topicTitle,
    status: record.status,
    title: record.title,
    summary: truncateSummary(record.summary),
    requestMessage: record.requestMessage,
    resolutionMessage: record.resolutionMessage,
    actions: isTerminalStatus(record.status) ? [] : actionsForKind(record.kind),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
  switch (record.kind) {
    case 'user-review':
      return { ...base, requestKind: 'user-review', payload: record.payload as ReviewPayload }
    case 'authorization':
      return { ...base, requestKind: 'authorization', payload: record.payload as AuthorizationPayload }
    case 'question':
      return { ...base, requestKind: 'question', payload: record.payload as QuestionPayload }
    case 'plan':
      return { ...base, requestKind: 'plan', payload: record.payload as PlanPayload }
  }
}

/** One notice row as a read-only inbox note; the openable file is a proposal's. */
function toNotificationItem(
  row: InboxNoteSummary,
  titles: ReadonlyMap<string, string>,
): InboxNotificationItem {
  const proposalPath = row.kind === 'proposal' ? row.proposalPath : undefined
  const item: {
    kind: 'notification'
    noticeId: string
    noticeKind: InboxNotificationItem['noticeKind']
    topicId: string
    topicTitle: string
    summary: string
    createdAt: string
    updatedAt: string
    proposalPath?: string
    canOpen: boolean
  } = {
    kind: 'notification',
    noticeId: row.noticeId,
    noticeKind: row.kind,
    topicId: row.topicId,
    topicTitle: topicTitleOf(titles, row.topicId),
    summary: truncateSummary(row.summary),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    canOpen: proposalPath !== undefined,
  }
  if (proposalPath !== undefined) item.proposalPath = proposalPath
  return item
}

/** A notice row the inbox carries: authorization has a card, never a note. */
type InboxNoteSummary = NoticeSummary & { readonly kind: Exclude<NoticeKind, 'authorization'> }

/** The notice kinds the inbox note stream carries; authorization has a card. */
function noteRows(events: readonly ActivityEvent[], ledger: NoticeLedgerV1): InboxNoteSummary[] {
  return noticeSummaries(events, ledger, { target: 'master' })
    .filter((row): row is InboxNoteSummary => row.kind !== 'authorization')
}

/**
 * Project the automatic reviewer's `review-verdict` rows onto read-only notes.
 * They never become request cards: no action, no open target, and no entry in
 * the pending counts.
 */
function reviewVerdictNotes(
  events: readonly ActivityEvent[],
  titles: ReadonlyMap<string, string>,
): InboxNotificationItem[] {
  const notes: InboxNotificationItem[] = []
  for (const event of events) {
    if (event.type !== 'review-verdict') continue
    const details = event.details as Record<string, unknown>
    const verdict = typeof details.verdict === 'string' ? details.verdict : ''
    const label = REVIEW_VERDICT_LABEL[verdict] ?? verdict
    notes.push({
      kind: 'notification',
      noticeId: event.eventId,
      noticeKind: 'review-verdict',
      topicId: event.topicId ?? '',
      topicTitle: topicTitleOf(titles, event.topicId ?? ''),
      summary: truncateSummary(label === '' ? '自动评审已完成' : `自动评审结果：${label}`),
      createdAt: event.time,
      updatedAt: event.time,
      canOpen: false,
    })
  }
  return notes
}

/** Newest `updatedAt` first; unparseable timestamps sort last, ties by id. */
function compareItems(left: InboxItem, right: InboxItem): number {
  const leftTime = Date.parse(left.updatedAt)
  const rightTime = Date.parse(right.updatedAt)
  const leftValue = Number.isFinite(leftTime) ? leftTime : Number.NEGATIVE_INFINITY
  const rightValue = Number.isFinite(rightTime) ? rightTime : Number.NEGATIVE_INFINITY
  if (leftValue !== rightValue) return leftValue > rightValue ? -1 : 1
  const leftId = left.kind === 'request' ? left.requestId : left.noticeId
  const rightId = right.kind === 'request' ? right.requestId : right.noticeId
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
}

/** The pending-only counts, split by kind; notifications never count. */
function countRequests(records: readonly RequestRecordV1[]): InboxCounts {
  const counts = { ...emptyInboxCounts() }
  for (const record of records) {
    if (isTerminalStatus(record.status)) continue
    counts.pending += 1
    if (record.kind === 'user-review') counts.review += 1
    else if (record.kind === 'authorization') counts.authorization += 1
    else if (record.kind === 'question') counts.question += 1
    else counts.plan += 1
  }
  return counts
}

/** The topic titles the rows show; the index is the only source. */
function topicTitles(document: ProjectIndexV2): Map<string, string> {
  return new Map(document.topics.map((topic) => [topic.topicId, topic.title]))
}

/** `GET /api/cowork.inbox`: requests, master notes, counts, truncation. */
async function handleInboxRead(
  request: Request,
  ports: CoworkApiPorts,
  kit: InboxApiKit,
): Promise<Response> {
  const sessionId = requireQueryParam(request, 'sessionId', 'request/session-required')
  const topicFilter = queryParam(request, 'topicId')
  const { store, repoPath } = await kit.openProject(sessionId)
  const document = await store.readIndexDocument()
  const titles = topicTitles(document)
  const requestStore = new RequestStore({ repoPath, log: ports.log })
  const scan = await requestStore.readAll()
  const activity = await store.readActivity(ACTIVITY_MAX_EVENTS)
  const ledgerStore = store as InboxStore
  const ledger = ledgerStore.readNotices === undefined ? emptyNoticeLedger() : await ledgerStore.readNotices()
  const requestItems = scan.records.map((record) => toInboxRequestItem(record, topicTitleOf(titles, record.topicId)))
  const noteItems = noteRows(activity.events, ledger).map((row) => toNotificationItem(row, titles))
  const verdictItems = reviewVerdictNotes(activity.events, titles)
  const merged = [...requestItems, ...noteItems, ...verdictItems].sort(compareItems)
  const visible = topicFilter === null ? merged : merged.filter((item) => item.topicId === topicFilter)
  const body: InboxResponse = {
    ok: true,
    items: visible.slice(0, INBOX_MAX_ITEMS),
    counts: countRequests(scan.records),
    truncated: scan.truncated || merged.length > INBOX_MAX_ITEMS,
  }
  return kit.jsonResponse(200, body)
}

/** `POST /api/cowork.inbox.resolve`: decide one request and wake its topic. */
async function handleInboxResolve(
  request: Request,
  ports: CoworkApiPorts,
  kit: InboxApiKit,
): Promise<Response> {
  const body = await kit.readJsonBody(request)
  const sessionId = requireBodyString(body, 'sessionId', 'request/session-required')
  const requestId = requireBodyString(body, 'requestId', 'request/invalid-body')
  const action = body.action
  if (!isRequestAction(action)) {
    throw new PanelServiceError(
      'inbox/action-not-allowed',
      `action must be one of the eight resolving actions, got ${String(action)}`,
    )
  }
  if (body.answers !== undefined && !Array.isArray(body.answers)) {
    throw new PanelServiceError('inbox/invalid-answer', 'answers must be an array of answers')
  }
  const { store, repoPath } = await kit.openProject(sessionId)
  const document = await store.readIndexDocument()
  const now = ports.now?.() ?? new Date()
  const outcome = await resolveRequest({
    store,
    repoPath,
    document,
    sessionId,
    requestId,
    action,
    answers: body.answers,
    comment: body.comment,
    now,
    promptSession: ports.promptSession,
    noticePort: ports.noticePort,
    kickNotices: ports.kickNotices,
    log: (message) => ports.log?.(`panel inbox: ${message}`),
  })
  const response: InboxResolveResponse = {
    ok: true,
    item: toInboxRequestItem(outcome.record, topicTitleOf(topicTitles(document), outcome.record.topicId)),
    changed: outcome.changed,
    prompted: outcome.prompted,
    promptError: outcome.promptError,
  }
  return kit.jsonResponse(200, response)
}

/** `POST /api/cowork.inbox.open`: reveal one plan/proposal file by id. */
async function handleInboxOpen(
  request: Request,
  ports: CoworkApiPorts,
  kit: InboxApiKit,
): Promise<Response> {
  const body = await kit.readJsonBody(request)
  const sessionId = requireBodyString(body, 'sessionId', 'request/session-required')
  const requestId = typeof body.requestId === 'string' && body.requestId.trim() !== ''
    ? body.requestId.trim()
    : null
  const noticeId = typeof body.noticeId === 'string' && body.noticeId.trim() !== ''
    ? body.noticeId.trim()
    : null
  if ((requestId === null) === (noticeId === null)) {
    throw new PanelServiceError(
      'request/invalid-body',
      'exactly one of requestId and noticeId is required',
    )
  }
  const { store, repoPath } = await kit.openProject(sessionId)
  // The member check needs the index: open is master-or-owning-topic, the same
  // rule resolve uses, so a repository session cannot reveal another topic's
  // plan or proposal by guessing an id.
  const document = await store.readIndexDocument()
  await openRequestTarget({
    store,
    repoPath,
    document,
    sessionId,
    ...(requestId === null ? {} : { requestId }),
    ...(noticeId === null ? {} : { noticeId }),
    ...(ports.openWorkspacePath === undefined ? {} : { openWorkspacePath: ports.openWorkspacePath }),
  })
  const response: InboxOpenResponse = { ok: true, opened: true }
  return kit.jsonResponse(200, response)
}

/** The three inbox routes, in contract order: read, resolve, open. */
export function inboxPanelRoutes(ports: CoworkApiPorts, kit: InboxApiKit): PanelFetchRoute[] {
  return [
    {
      path: INBOX_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: kit.serve((request) => handleInboxRead(request, ports, kit)),
    },
    {
      path: INBOX_RESOLVE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: kit.serve((request) => handleInboxResolve(request, ports, kit)),
    },
    {
      path: INBOX_OPEN_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: kit.serve((request) => handleInboxOpen(request, ports, kit)),
    },
  ]
}
