/**
 * Topic tools (M9.3b; extended for the topic page 2026-11-10).
 *
 * - `cowork_topic_create` / `cowork_thread_create` (deprecated alias)
 * - `cowork_topic_list` / `cowork_thread_list` (deprecated alias)
 * - `cowork_handoff` (blocked|done; now reports through `topic-reported`)
 * - `cowork_topic_resolve` (the shared archive core, idempotent)
 * - `cowork_topic_report`, `cowork_decision_propose`,
 *   `cowork_authorization_request` (topic side of the topic page)
 * - `cowork_notices` (master-only, read-only view of the notification ledger)
 *
 * The aliases are the same `execute` function and the same parameter schema as
 * their topic counterpart, so the two names cannot drift; only the description
 * says "deprecated". All state is canonical v2.
 *
 * Notifications follow the frozen 1:1 rule: one event row in `activity.jsonl`,
 * one ledger row per target, no batching, no inbox for new topic events. A
 * `done`/`blocked` handoff keeps its audit file and topic state but reports via
 * `topic-reported` instead of waking the master with an inbox prompt. The inbox
 * keeps only the pre-existing merge/review/cross-topic events.
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  assignmentNotice,
  authorizationRequestedActivity,
  buildActivityEvent,
  decisionProposedActivity,
  topicReportedActivity,
} from './store/activity.js'
import { buildHandoffRecord, validateHandoff } from './handoff.js'
import { noticeSummaries } from './notices.js'
import { AUTHORIZATION_COMMAND_MAX_CHARS, REQUEST_SUMMARY_MAX_CHARS } from './inbox-contract.js'
import { createRequest } from './request-service.js'
import { REQUEST_TOOL_ERROR_CODES } from './request-tools.js'
import { TOPIC_PRESET_ID } from './platform/presets.js'
import { ACTIVITY_MAX_EVENTS } from './store/schema.js'
import type { TopicRecordV2 } from './store/schema.js'
import type { CoworkToolDeps, JsonValue, ProjectRuntime } from './platform/tool-runtime.js'
import {
  BRIEF_MAX_CHARS,
  archiveTopic,
  callerOf,
  isFailure,
  mapError,
  nowOf,
  openProject,
  recordNoticeEvent,
  renderJson,
  toJson,
  topicView,
  truncateText,
} from './platform/tool-runtime.js'
import { ERROR_CODES, TOPIC_ERROR_CODES, checkRole, failure, success } from './platform/tool-model.js'
import { blockTopic, noteTopicActivity, unblockTopic } from './topic.js'

/** Most topics `cowork_topic_list` returns (and its deprecated alias). */
export const TOPIC_LIST_LIMIT = 100

/** Most notices `cowork_notices` returns in one call. */
export const TOPIC_NOTICES_MAX_LIMIT = 100
/** Notices `cowork_notices` returns when the call names no limit. */
export const TOPIC_NOTICES_DEFAULT_LIMIT = 20

/** Longest report/proposal summary a topic tool accepts. */
export const TOPIC_SUMMARY_MAX_CHARS = 2000

/**
 * Wire codes owned by the topic-page tools. Kept here (not in the pinned
 * `tool-model` tables) so this task's scope stays one module.
 */
export const TOPIC_PAGE_ERROR_CODES = {
  summaryRequired: 'topic/summary-required',
  summaryTooLong: 'topic/summary-too-long',
  proposalTitleRequired: 'topic/proposal-title-required',
  proposalWriteFailed: 'topic/proposal-write-failed',
  invalidKind: 'topic/invalid-kind',
} as const

/** The bounded topic view used by every topic tool. */
type TopicView = ReturnType<typeof topicView>

/** A non-empty trimmed string argument, or null. */
function requiredText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '' || Array.from(text).length > limit) return null
  return text
}

/** One canonical topic created by `cowork_topic_create` or `cowork_route`. */
function newTopicRecord(input: {
  topicId: string
  title: string
  scope: string
  ownedPaths: string[]
  cwd: string
  now: Date
}): TopicRecordV2 {
  const stamp = input.now.toISOString()
  return {
    topicId: input.topicId,
    title: input.title,
    status: 'active',
    awaitingReview: false,
    blocked: false,
    blockedReason: null,
    blockedFromStatus: null,
    blockedAt: null,
    authorization: null,
    scope: input.scope,
    ownedPaths: input.ownedPaths,
    aliases: [],
    digest: '',
    cwd: input.cwd,
    legacyCheckoutPath: null,
    createdAt: stamp,
    updatedAt: stamp,
    lastActiveAt: stamp,
    lastDeliveryConfirmedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    latestReviewRequestId: null,
    reviewStatus: null,
    reviewerSessionId: null,
  }
}

/** Normalize/validate `ownedPaths`: non-empty trimmed strings, first occurrence wins. */
function ownedPathsOf(value: unknown): string[] | null {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return null
  const seen = new Set<string>()
  const paths: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') return null
    const path = entry.trim()
    if (path === '') return null
    if (seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return paths
}

/** The shared execute of `cowork_topic_create` and its deprecated alias. */
async function createTopic(args: Record<string, unknown>, exec: unknown, deps: CoworkToolDeps): Promise<JsonValue> {
  const caller = callerOf(exec)
  if (isFailure(caller)) return toJson(caller)

  const title = typeof args.title === 'string' ? args.title.trim() : ''
  if (title === '') {
    return toJson(failure(TOPIC_ERROR_CODES.topicTitleRequired, 'title must be a non-empty string'))
  }
  const ownedPaths = ownedPathsOf(args.ownedPaths)
  if (ownedPaths === null) {
    return toJson(failure(
      TOPIC_ERROR_CODES.topicInvalidOwnedPaths,
      'ownedPaths must be an array of non-empty strings',
    ))
  }
  const scope = typeof args.scope === 'string' ? args.scope : ''
  const brief = typeof args.brief === 'string' ? args.brief.trim() : ''
  if (Array.from(brief).length > BRIEF_MAX_CHARS) {
    return toJson(failure(
      TOPIC_ERROR_CODES.routeBriefTooLong,
      `brief must be at most ${BRIEF_MAX_CHARS} characters`,
    ))
  }

  try {
    const opened = await openProject(caller, deps)
    if (isFailure(opened)) return toJson(opened)
    const denied = checkRole('master', caller, opened.index)
    if (denied !== null) return toJson(denied)

    const now = nowOf(deps)
    const created = await opened.slice.createThread({
      repoPath: opened.repoPath,
      subject: title,
      presetId: TOPIC_PRESET_ID,
    })
    const topic = newTopicRecord({
      topicId: created.sessionId,
      title,
      scope,
      ownedPaths,
      cwd: opened.repoPath,
      now,
    })

    try {
      await opened.store.mutateIndexDocument((document) => ({
        ...document,
        topics: [...document.topics, topic],
      }))
    } catch (error) {
      // The session exists but the index does not: archive it so a failed
      // creation leaves no half topic behind, and report the cleanup.
      let archived = false
      let archiveError: string | null = null
      try {
        await opened.slice.archiveSession(created.sessionId)
        archived = true
      } catch (cleanupError) {
        archiveError = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      }
      const mapped = mapError(error)
      return toJson(failure(mapped.error.code, mapped.error.message, {
        ...(typeof mapped.error.details === 'object' && mapped.error.details !== null
          ? (mapped.error.details as Record<string, unknown>)
          : {}),
        topicId: created.sessionId,
        cleanup: { archived, error: archiveError },
      }))
    }

    // Assignment is itself a 1:1 event: one master message and one topic card.
    await recordNoticeEvent(opened.store, buildActivityEvent({
      type: 'topic-created',
      topicId: topic.topicId,
      summary: `created topic ${truncateText(title, 80)}`,
      details: {
        title: truncateText(title, 200),
        scope: truncateText(scope, 200),
        ownedPaths: ownedPaths.slice(0, 20),
        brief: brief !== '',
        notice: assignmentNotice(topic, brief === '' ? scope : brief),
      },
    }, now), now, deps.notices, opened.repoPath)

    let prompted = false
    if (brief !== '') {
      const result = await opened.slice.promptSession(topic.topicId, brief)
      prompted = result.accepted
    }

    return toJson(success({ topic: topicView(topic), title, prompted }))
  } catch (error) {
    return toJson(mapError(error))
  }
}

/** The shared execute of `cowork_topic_list` and its deprecated alias. */
async function listTopics(_args: Record<string, unknown>, exec: unknown, deps: CoworkToolDeps): Promise<JsonValue> {
  const caller = callerOf(exec)
  if (isFailure(caller)) return toJson(caller)
  try {
    const opened = await openProject(caller, deps)
    if (isFailure(opened)) return toJson(opened)
    const denied = checkRole('master-or-thread', caller, opened.index)
    if (denied !== null) return toJson(denied)

    const document = await opened.store.readIndexDocument()
    const sorted = [...document.topics].sort((left, right) => {
      const leftAt = Date.parse(left.lastActiveAt)
      const rightAt = Date.parse(right.lastActiveAt)
      if (leftAt !== rightAt) return rightAt - leftAt
      if (left.topicId === right.topicId) return 0
      return left.topicId < right.topicId ? -1 : 1
    })
    const topics: TopicView[] = sorted.slice(0, TOPIC_LIST_LIMIT).map(topicView)
    return toJson(success({
      total: document.topics.length,
      truncated: document.topics.length > TOPIC_LIST_LIMIT,
      topics,
    }))
  } catch (error) {
    return toJson(mapError(error))
  }
}

/** The topic of the calling session, or a failure envelope. */
async function openCallerTopic(
  caller: { sessionId: string; cwd: string },
  deps: CoworkToolDeps,
): Promise<{ opened: ProjectRuntime; topic: TopicRecordV2 } | { failure: JsonValue }> {
  const opened = await openProject(caller, deps)
  if (isFailure(opened)) return { failure: toJson(opened) }
  const denied = checkRole('thread', caller, opened.index)
  if (denied !== null) return { failure: toJson(denied) }
  const document = await opened.store.readIndexDocument()
  const topic = document.topics.find((entry) => entry.topicId === caller.sessionId)
  if (topic === undefined) {
    return {
      failure: toJson(failure(
        TOPIC_ERROR_CODES.topicNotFound,
        `topic ${caller.sessionId} is not in the project index`,
      )),
    }
  }
  return { opened, topic }
}

/**
 * M10 handoff semantics, extended by the topic page: validate → write the audit
 * file → update the canonical topic → record one `topic-reported` event and its
 * notices. The full handoff text is never prompted into the master turn, and no
 * inbox item is created; a delivery failure is the dispatcher's problem and
 * never fails the handoff, because the file and the topic state are committed.
 */
async function handoff(args: Record<string, unknown>, exec: unknown, deps: CoworkToolDeps): Promise<JsonValue> {
  const caller = callerOf(exec)
  if (isFailure(caller)) return toJson(caller)
  try {
    const opened = await openProject(caller, deps)
    if (isFailure(opened)) return toJson(opened)
    const denied = checkRole('thread', caller, opened.index)
    if (denied !== null) return toJson(denied)

    const document = await opened.store.readIndexDocument()
    const topic = document.topics.find((entry) => entry.topicId === caller.sessionId)
    if (topic === undefined) {
      return toJson(failure(
        TOPIC_ERROR_CODES.topicNotFound,
        `topic ${caller.sessionId} is not in the project index`,
      ))
    }
    if (topic.status === 'resolved') {
      return toJson(failure(TOPIC_ERROR_CODES.topicNotFound, `topic ${caller.sessionId} is archived`))
    }
    const now = nowOf(deps)
    const nowMs = now.getTime()
    const validation = validateHandoff({
      threadId: caller.sessionId,
      masterSessionId: document.masterSessionId,
      subject: topic.title,
      status: args.status,
      summary: args.summary,
      verification: args.verification,
      decisions: args.decisions,
      changedPaths: args.changedPaths,
      artifacts: args.artifacts,
      openIssues: args.openIssues,
      nextStep: args.nextStep,
    })
    if (!validation.ok) {
      const summary = validation.errors.map((error) => `${error.field}: ${error.message}`).join('; ')
      return toJson(failure(ERROR_CODES.handoffInvalid, `handoff is invalid: ${summary}`, {
        errors: validation.errors,
      }))
    }

    const record = buildHandoffRecord(validation.value, now)
    // Written before the index so a failed tool call never loses the report it
    // was handed; the file is audit-only in M10.
    const file = await opened.store.writeHandoff(record)
    const digest = truncateText(record.summary, 200)

    let updated: TopicRecordV2 | null = null
    await opened.store.mutateIndexDocument((current) => {
      const existing = current.topics.find((entry) => entry.topicId === caller.sessionId)
      if (existing === undefined || existing.status === 'resolved') return null
      const next: TopicRecordV2 = record.status === 'done'
        // Releasing a block restores the status it interrupted, then new
        // activity (the handoff itself) brings the topic back to active.
        ? { ...noteTopicActivity(unblockTopic(existing, nowMs), nowMs), digest, awaitingReview: false, lastDeliveryConfirmedAt: record.createdAt }
        // A blocked handoff blocks for handoff reasons; a pending authorization
        // cannot survive a different reason (the pair is validated on write).
        : { ...blockTopic(existing, 'handoff', nowMs), digest, awaitingReview: false, authorization: null }
      updated = next
      return {
        ...current,
        topics: current.topics.map((entry) => (entry.topicId === caller.sessionId ? next : entry)),
      }
    })
    if (updated === null) {
      return toJson(failure(
        TOPIC_ERROR_CODES.topicNotFound,
        `topic ${caller.sessionId} disappeared while the handoff was written`,
      ))
    }

    const event = topicReportedActivity(updated, {
      summary: record.summary,
      kind: record.status === 'blocked' ? 'blocked' : 'progress',
    }, now)
    const notified = await recordNoticeEvent(opened.store, event, now, deps.notices, opened.repoPath)

    return toJson(success({
      status: record.status,
      filePath: file.filePath,
      record,
      topic: topicView(updated),
      noticed: notified,
    }))
  } catch (error) {
    return toJson(mapError(error))
  }
}

/**
 * `cowork_topic_report`: a progress report or a handoff-style block from the
 * topic. Both update the digest and activity time; `blocked` also blocks for
 * handoff reasons. Exactly one `topic-reported` event and its notices.
 */
async function reportTopic(args: Record<string, unknown>, exec: unknown, deps: CoworkToolDeps): Promise<JsonValue> {
  const caller = callerOf(exec)
  if (isFailure(caller)) return toJson(caller)
  const summary = requiredText(args.summary, TOPIC_SUMMARY_MAX_CHARS)
  if (summary === null) {
    return toJson(failure(
      TOPIC_PAGE_ERROR_CODES.summaryRequired,
      `summary must be a non-empty string of at most ${TOPIC_SUMMARY_MAX_CHARS} characters`,
    ))
  }
  const kind = args.kind === undefined ? 'progress' : args.kind
  if (kind !== 'progress' && kind !== 'blocked') {
    return toJson(failure(TOPIC_PAGE_ERROR_CODES.invalidKind, "kind must be 'progress' or 'blocked'"))
  }
  try {
    const opened = await openCallerTopic(caller, deps)
    if ('failure' in opened) return opened.failure
    if (opened.topic.status === 'resolved') {
      return toJson(failure(TOPIC_ERROR_CODES.topicNotFound, `topic ${caller.sessionId} is archived`))
    }
    const now = nowOf(deps)
    const nowMs = now.getTime()
    let updated: TopicRecordV2 | null = null
    await opened.opened.store.mutateIndexDocument((document) => {
      const existing = document.topics.find((entry) => entry.topicId === caller.sessionId)
      if (existing === undefined || existing.status === 'resolved') return null
      const next: TopicRecordV2 = kind === 'blocked'
        ? { ...blockTopic(existing, 'handoff', nowMs), digest: truncateText(summary, 200), authorization: null }
        : { ...noteTopicActivity(existing, nowMs), digest: truncateText(summary, 200) }
      updated = next
      return {
        ...document,
        topics: document.topics.map((entry) => (entry.topicId === caller.sessionId ? next : entry)),
      }
    })
    if (updated === null) {
      return toJson(failure(TOPIC_ERROR_CODES.topicNotFound, `topic ${caller.sessionId} changed while reporting`))
    }
    const event = topicReportedActivity(updated, { summary, kind }, now)
    const notified = await recordNoticeEvent(opened.opened.store, event, now, deps.notices, opened.opened.repoPath)
    return toJson(success({ topic: topicView(updated), summary: truncateText(summary, 200), kind, noticed: notified }))
  } catch (error) {
    return toJson(mapError(error))
  }
}

/** One stored decision proposal (`<repo>/.dsh-cowork/proposals/<id>.json`). */
export interface DecisionProposalV1 {
  version: 1
  proposalId: string
  topicId: string
  title: string
  summary: string
  status: 'open'
  createdAt: string
}

/** `cowork_decision_propose`: store one proposal and report it, never display it. */
async function proposeDecision(args: Record<string, unknown>, exec: unknown, deps: CoworkToolDeps): Promise<JsonValue> {
  const caller = callerOf(exec)
  if (isFailure(caller)) return toJson(caller)
  const title = requiredText(args.title, 200)
  if (title === null) {
    return toJson(failure(TOPIC_PAGE_ERROR_CODES.proposalTitleRequired, 'title must be a non-empty string'))
  }
  const summary = requiredText(args.summary, TOPIC_SUMMARY_MAX_CHARS)
  if (summary === null) {
    return toJson(failure(
      TOPIC_PAGE_ERROR_CODES.summaryRequired,
      `summary must be a non-empty string of at most ${TOPIC_SUMMARY_MAX_CHARS} characters`,
    ))
  }
  try {
    const opened = await openCallerTopic(caller, deps)
    if ('failure' in opened) return opened.failure
    if (opened.topic.status === 'resolved') {
      return toJson(failure(TOPIC_ERROR_CODES.topicNotFound, `topic ${caller.sessionId} is archived`))
    }
    const now = nowOf(deps)
    const proposalId = randomUUID()
    const relativePath = join('.dsh-cowork', 'proposals', `${proposalId}.json`)
    const proposal: DecisionProposalV1 = {
      version: 1,
      proposalId,
      topicId: caller.sessionId,
      title,
      summary,
      status: 'open',
      createdAt: now.toISOString(),
    }
    try {
      await opened.opened.store.withWriteLock(async () => {
        await opened.opened.store.writeTextAtomic(
          join(opened.opened.repoPath, relativePath),
          `${JSON.stringify(proposal, null, 2)}\n`,
        )
      })
    } catch (error) {
      return toJson(failure(
        TOPIC_PAGE_ERROR_CODES.proposalWriteFailed,
        `could not write the decision proposal: ${error instanceof Error ? error.message : String(error)}`,
      ))
    }

    let updated: TopicRecordV2 | null = null
    await opened.opened.store.mutateIndexDocument((document) => {
      const existing = document.topics.find((entry) => entry.topicId === caller.sessionId)
      if (existing === undefined) return null
      const next = noteTopicActivity(existing, now.getTime())
      updated = next
      return {
        ...document,
        topics: document.topics.map((entry) => (entry.topicId === caller.sessionId ? next : entry)),
      }
    })
    if (updated === null) {
      return toJson(failure(TOPIC_ERROR_CODES.topicNotFound, `topic ${caller.sessionId} changed while proposing`))
    }
    const event = decisionProposedActivity(updated, { proposalId, proposalPath: relativePath, title, summary }, now)
    const notified = await recordNoticeEvent(opened.opened.store, event, now, deps.notices, opened.opened.repoPath)
    return toJson(success({
      proposal,
      filePath: relativePath,
      topic: topicView(updated),
      noticed: notified,
    }))
  } catch (error) {
    return toJson(mapError(error))
  }
}

/**
 * `cowork_authorization_request`: block the topic on a pending authorization
 * and ask the user. The returned `requestId` is what the decision route needs;
 * the block restores the status the topic had before it.
 *
 * The topic `authorization` record and the request-inbox record share the one
 * requestId. The inbox record is written after the block is committed (the
 * block is the state that must not be lost): a failed request-file write is
 * logged and reported as `requestRecorded: false` instead of pretending the
 * card exists.
 */
async function requestAuthorization(args: Record<string, unknown>, exec: unknown, deps: CoworkToolDeps): Promise<JsonValue> {
  const caller = callerOf(exec)
  if (isFailure(caller)) return toJson(caller)
  const summary = requiredText(args.summary, TOPIC_SUMMARY_MAX_CHARS)
  if (summary === null) {
    return toJson(failure(
      TOPIC_PAGE_ERROR_CODES.summaryRequired,
      `summary must be a non-empty string of at most ${TOPIC_SUMMARY_MAX_CHARS} characters`,
    ))
  }
  const command = args.command === undefined ? null : requiredText(args.command, AUTHORIZATION_COMMAND_MAX_CHARS)
  if (args.command !== undefined && command === null) {
    return toJson(failure(
      REQUEST_TOOL_ERROR_CODES.payloadInvalid,
      `command must be a non-empty string of at most ${AUTHORIZATION_COMMAND_MAX_CHARS} characters`,
    ))
  }
  try {
    const opened = await openCallerTopic(caller, deps)
    if ('failure' in opened) return opened.failure
    if (opened.topic.status === 'resolved') {
      return toJson(failure(TOPIC_ERROR_CODES.topicNotFound, `topic ${caller.sessionId} is archived`))
    }
    const now = nowOf(deps)
    const nowMs = now.getTime()
    const requestId = randomUUID()
    const trimmed = truncateText(summary, 200)
    let updated: TopicRecordV2 | null = null
    await opened.opened.store.mutateIndexDocument((document) => {
      const existing = document.topics.find((entry) => entry.topicId === caller.sessionId)
      if (existing === undefined || existing.status === 'resolved') return null
      const next: TopicRecordV2 = {
        ...blockTopic(existing, 'authorization', nowMs),
        authorization: { requestId, summary: trimmed, requestedAt: now.toISOString() },
      }
      updated = next
      return {
        ...document,
        topics: document.topics.map((entry) => (entry.topicId === caller.sessionId ? next : entry)),
      }
    })
    if (updated === null) {
      return toJson(failure(TOPIC_ERROR_CODES.topicNotFound, `topic ${caller.sessionId} changed while requesting authorization`))
    }
    let requestRecorded = false
    try {
      const document = await opened.opened.store.readIndexDocument()
      const payload = command === null
        ? { summary: truncateText(summary, REQUEST_SUMMARY_MAX_CHARS) }
        : { summary: truncateText(summary, REQUEST_SUMMARY_MAX_CHARS), command }
      await createRequest({
        store: opened.opened.store,
        repoPath: opened.opened.repoPath,
        projectId: document.projectId,
        topic: updated,
        kind: 'authorization',
        payload,
        summary: trimmed,
        requestId,
        now,
        log: deps.log,
      })
      requestRecorded = true
    } catch (error) {
      deps.log?.(`cowork_authorization_request: request ${requestId} was not recorded: ${error instanceof Error ? error.message : String(error)}`)
    }
    const event = authorizationRequestedActivity(updated, { requestId, summary }, now)
    const notified = await recordNoticeEvent(opened.opened.store, event, now, deps.notices, opened.opened.repoPath)
    return toJson(success({ requestId, topic: topicView(updated), noticed: notified, requestRecorded }))
  } catch (error) {
    return toJson(mapError(error))
  }
}

/** `cowork_notices`: the master's read-only view of recent topic notices. */
async function listNotices(args: Record<string, unknown>, exec: unknown, deps: CoworkToolDeps): Promise<JsonValue> {
  const caller = callerOf(exec)
  if (isFailure(caller)) return toJson(caller)
  const topicId = typeof args.topicId === 'string' && args.topicId.trim() !== '' ? args.topicId.trim() : null
  const rawLimit = args.limit === undefined ? TOPIC_NOTICES_DEFAULT_LIMIT : args.limit
  const limit = typeof rawLimit === 'number' && Number.isInteger(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, TOPIC_NOTICES_MAX_LIMIT)
    : TOPIC_NOTICES_DEFAULT_LIMIT
  try {
    const opened = await openProject(caller, deps)
    if (isFailure(opened)) return toJson(opened)
    const denied = checkRole('master', caller, opened.index)
    if (denied !== null) return toJson(denied)
    const document = await opened.store.readIndexDocument()
    // Read the whole stream: a notice may point at an event older than 50 rows.
    const { events } = await opened.store.readActivity(ACTIVITY_MAX_EVENTS)
    const ledger = await opened.store.readNotices()
    const rows = noticeSummaries(events, ledger)
      .filter((row) => topicId === null || row.topicId === topicId)
      .map((row) => {
        const proposalPath = row.proposalPath ?? (
          row.proposalId === undefined
            ? undefined
            : join('.dsh-cowork', 'proposals', `${row.proposalId}.json`)
        )
        return {
          ...row,
          title: truncateText(row.title, 200),
          summary: truncateText(row.summary, 200),
          ...(proposalPath === undefined ? {} : { proposalPath }),
        }
      })
    return toJson(success({
      total: rows.length,
      truncated: rows.length > limit,
      notices: rows.slice(0, limit),
      topics: document.topics.length,
    }))
  } catch (error) {
    return toJson(mapError(error))
  }
}

/** The shared execute of `cowork_topic_resolve`. */
async function resolveTopic(args: Record<string, unknown>, exec: unknown, deps: CoworkToolDeps): Promise<JsonValue> {
  const caller = callerOf(exec)
  if (isFailure(caller)) return toJson(caller)
  const topicId = typeof args.topicId === 'string' ? args.topicId.trim() : ''
  if (topicId === '') {
    return toJson(failure(TOPIC_ERROR_CODES.topicNotFound, 'topicId must be a non-empty string'))
  }
  try {
    const opened = await openProject(caller, deps)
    if (isFailure(opened)) return toJson(opened)
    const denied = checkRole('master', caller, opened.index)
    if (denied !== null) return toJson(denied)
    const now = nowOf(deps)
    const outcome = await archiveTopic(opened.store, topicId, {
      now,
      repoPath: opened.repoPath,
      by: 'user',
      runtime: deps.notices,
      log: (message) => deps.log?.(message),
    })
    if (outcome.changed) {
      // Archiving hides the topic session too. The index is already committed,
      // so a refused host archive is logged instead of rolling the archive back.
      try {
        await opened.slice.archiveSession(topicId, { stopActivity: true })
      } catch (error) {
        deps.log?.(
          `cowork_topic_resolve: host session ${topicId} was not archived: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    if (outcome.topic === null) {
      return toJson(failure(TOPIC_ERROR_CODES.topicNotFound, `topic not found in the project index: ${topicId}`, { topicId }))
    }
    return toJson(success({ topic: topicView(outcome.topic), alreadyResolved: !outcome.changed }))
  } catch (error) {
    return toJson(mapError(error))
  }
}

/** The public parameter schema shared by `cowork_topic_create` and its alias. */
const CREATE_PARAMETERS = {
  title: { type: 'string', required: true, description: 'Short topic title the new session owns.' },
  scope: { type: 'string', description: 'One-line scope statement; defaults to empty.' },
  ownedPaths: {
    type: 'array',
    items: { type: 'string' },
    description: 'Paths this topic owns; duplicates are removed and empty strings are rejected.',
  },
  brief: { type: 'string', description: `Optional first message for the new topic (max ${BRIEF_MAX_CHARS} characters).` },
} as const

/**
 * Register the topic tools and return their disposers, in the documented order.
 */
export function registerTopicTools(ctx: unknown, deps: CoworkToolDeps): Array<() => void> {
  const host = ctx as { tools: { register(definition: ToolDefinition): () => void } }
  const disposers: Array<() => void> = []
  const createExecute = (args: Record<string, unknown>, exec: unknown) => createTopic(args, exec, deps)
  const listExecute = (args: Record<string, unknown>, exec: unknown) => listTopics(args, exec, deps)
  const handoffExecute = (args: Record<string, unknown>, exec: unknown) => handoff(args, exec, deps)
  const resolveExecute = (args: Record<string, unknown>, exec: unknown) => resolveTopic(args, exec, deps)
  const reportExecute = (args: Record<string, unknown>, exec: unknown) => reportTopic(args, exec, deps)
  const proposeExecute = (args: Record<string, unknown>, exec: unknown) => proposeDecision(args, exec, deps)
  const authorizationExecute = (args: Record<string, unknown>, exec: unknown) => requestAuthorization(args, exec, deps)
  const noticesExecute = (args: Record<string, unknown>, exec: unknown) => listNotices(args, exec, deps)

  // 1-2) cowork_topic_create + the deprecated cowork_thread_create alias.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_topic_create',
    description:
      'Create a cowork topic session for a given title, record it in the v2 index, and optionally send its first brief. Master only.',
    parameters: CREATE_PARAMETERS,
    output: { schema: { type: 'json' }, render: renderJson },
    execute: createExecute,
  })))
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_thread_create',
    description:
      'Deprecated alias of cowork_topic_create (same schema and result). Kept for one version; use cowork_topic_create.',
    parameters: CREATE_PARAMETERS,
    output: { schema: { type: 'json' }, render: renderJson },
    execute: createExecute,
  })))

  // 3-4) cowork_topic_list + the deprecated cowork_thread_list alias.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_topic_list',
    description: 'List the cowork topics recorded in the project index, bounded to 100. Master or topic.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    execute: listExecute,
  })))
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_thread_list',
    description:
      'Deprecated alias of cowork_topic_list (same result). Kept for one version; use cowork_topic_list.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    execute: listExecute,
  })))

  // 5) cowork_handoff — the topic's completion/blocked report.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_handoff',
    description:
      'Report this topic result to the master: status blocked or done, a summary, and the verification you ran. Topic only; a topic that stops without this has not finished. Request reviews separately with cowork_review_request.',
    parameters: {
      status: {
        type: 'string',
        required: true,
        enum: ['blocked', 'done'],
        description: 'Topic state after this handoff: done when finished, blocked when waiting for input.',
      },
      summary: { type: 'string', required: true, description: 'What was done, in one paragraph.' },
      verification: {
        type: 'array',
        required: true,
        description: 'One row per check actually run.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            command: { type: 'string', required: true, description: 'Exact command that was run.' },
            exitCode: { type: 'integer', required: true, description: 'Exit code the command returned.' },
            evidence: { type: 'string', required: true, description: 'Short output or result that proves it.' },
          },
        },
      },
      decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions the master should know.' },
      changedPaths: { type: 'array', items: { type: 'string' }, description: 'Files this topic changed.' },
      artifacts: { type: 'array', items: { type: 'string' }, description: 'Paths the master may want to open.' },
      openIssues: { type: 'array', items: { type: 'string' }, description: 'What is still open.' },
      nextStep: { type: 'string', description: 'What should happen next.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: handoffExecute,
  })))

  // 6) cowork_topic_resolve — master-only manual archive.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_topic_resolve',
    description:
      'Archive one topic by user decision: the topic moves to resolved and its host session is archived too (idempotent). Master only.',
    parameters: {
      topicId: { type: 'string', required: true, description: 'Topic to archive.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: resolveExecute,
  })))

  // 7) cowork_topic_report — one progress/blocked event, one notice per target.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_topic_report',
    description:
      'Report progress on this topic (or report it blocked) without handing off. Updates the digest and activity time and notifies the master once per event. Topic only.',
    parameters: {
      summary: { type: 'string', required: true, description: `What happened, in one line (max ${TOPIC_SUMMARY_MAX_CHARS} characters).` },
      kind: {
        type: 'string',
        enum: ['progress', 'blocked'],
        description: "Defaults to 'progress'; 'blocked' also blocks the topic for handoff reasons.",
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: reportExecute,
  })))

  // 8) cowork_decision_propose — store a proposal and report it; the topic page does not show it.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_decision_propose',
    description:
      'Record one decision proposal for this topic under .dsh-cowork/proposals/ and report it to the master and this topic. The topic page shows the summary only. Topic only.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short proposal title the master can scan.' },
      summary: { type: 'string', required: true, description: `What is being decided, in one paragraph (max ${TOPIC_SUMMARY_MAX_CHARS} characters).` },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: proposeExecute,
  })))

  // 9) cowork_authorization_request — block on a user decision and return its id.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_authorization_request',
    description:
      'Ask the user to authorize something: blocks this topic with an authorization marker, writes the same requestId into the Cowork request inbox, and returns that id. Topic only.',
    parameters: {
      summary: { type: 'string', required: true, description: `What needs authorization, in one paragraph (max ${TOPIC_SUMMARY_MAX_CHARS} characters).` },
      command: {
        type: 'string',
        description: `Optional command line the authorization is about, shown monospaced (max ${AUTHORIZATION_COMMAND_MAX_CHARS} characters).`,
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: authorizationExecute,
  })))

  // 10) cowork_notices — master-only read of the recent notification ledger.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_notices',
    description:
      'Read the most recent topic notices (one per event) from the delivery ledger, optionally filtered by topic. Proposal notices also carry proposalId and proposalPath. Master only; read-only.',
    parameters: {
      topicId: { type: 'string', description: 'Only return notices of this topic.' },
      limit: { type: 'integer', description: `Most rows to return (default ${TOPIC_NOTICES_DEFAULT_LIMIT}, max ${TOPIC_NOTICES_MAX_LIMIT}).` },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: noticesExecute,
  })))

  return disposers
}
