/**
 * Topic tools (M9.3b): `cowork_topic_create`, `cowork_topic_list`,
 * `cowork_topic_resolve`, and `cowork_handoff`, plus the deprecated
 * `cowork_thread_*` aliases.
 *
 * The aliases are the same `execute` function and the same parameter schema as
 * their topic counterpart, so the two names cannot drift; only the description
 * says "deprecated". This is the planned 0.2.0 rename (M9.3b); M12 records it in
 * the README, and M10 removes the aliases.
 *
 * All state is canonical v2: `readIndexDocument`/`mutateIndexDocument` replace
 * the v1 index view. In particular `cowork_handoff(done)` no longer maps the
 * old `done` thread state to `resolved`; it records the summary and delivery
 * confirmation and leaves the topic active.
 *
 * M10 narrowed the handoff to `blocked|done`: the file stays as an audit record
 * but the master is no longer prompted with its full text; a `blocked` handoff
 * only enqueues one bounded inbox item, and `done` records the digest and
 * delivery confirmation. Reviews are requested by the topic through
 * `cowork_review_request`, never by the master in response to a handoff.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { buildActivityEvent } from './activity.js'
import { buildHandoffRecord, validateHandoff } from './handoff.js'
import { INBOX_SUMMARY_MAX_CHARS } from './inbox.js'
import { TOPIC_PRESET_ID } from './presets.js'
import type { TopicRecordV2 } from './store-schema.js'
import type { CoworkToolDeps, JsonValue, ProjectRuntime } from './tool-runtime.js'
import {
  BRIEF_MAX_CHARS,
  callerOf,
  deliverInbox,
  isFailure,
  mapError,
  nowOf,
  openProject,
  renderJson,
  toJson,
  topicView,
  truncateText,
} from './tool-runtime.js'
import { ERROR_CODES, TOPIC_ERROR_CODES, checkRole, failure, success } from './tool-model.js'
import { noteTopicActivity } from './topic.js'

/** Most topics `cowork_topic_list` returns (and its deprecated alias). */
export const TOPIC_LIST_LIMIT = 100

/** Build a bounded `topic-created` / `status-changed` activity row, ignoring a write failure. */
async function recordActivityQuietly(
  runtime: ProjectRuntime,
  event: Parameters<ProjectRuntime['store']['appendActivity']>[0],
): Promise<void> {
  try {
    await runtime.store.appendActivity(event)
  } catch {
    // Activity is evidence, not state: the index write already stands, and the
    // M8 modules follow the same rule. The tool result is unaffected.
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

/** The bounded topic view used by every topic tool. */
type TopicView = ReturnType<typeof topicView>

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

    await recordActivityQuietly(opened, buildActivityEvent({
      type: 'topic-created',
      topicId: topic.topicId,
      summary: `created topic ${truncateText(title, 80)}`,
      details: {
        title: truncateText(title, 200),
        scope: truncateText(scope, 200),
        ownedPaths: ownedPaths.slice(0, 20),
        brief: brief !== '',
      },
    }, now))

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

/**
 * M10 handoff semantics: validate → write the audit file → update the canonical
 * topic → (blocked only) deliver one bounded inbox item.
 *
 * The full handoff text is never prompted into the master turn: `done` records
 * the digest and delivery confirmation, `blocked` sets the flag and wakes the
 * master through the inbox. A delivery failure leaves the item undelivered for
 * the next pass and is reported in `delivery`; it never fails the handoff,
 * because the topic state and the audit file are already committed.
 */
function blockedInboxSummary(topicId: string, summary: string): string {
  return truncateText(`topic ${topicId} blocked: ${summary}`, INBOX_SUMMARY_MAX_CHARS)
}

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
    const now = nowOf(deps)
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

    let updated: TopicRecordV2 | null = null
    await opened.store.mutateIndexDocument((current) => {
      const existing = current.topics.find((entry) => entry.topicId === caller.sessionId)
      if (existing === undefined) return null
      const active = noteTopicActivity(existing, now.getTime())
      const next: TopicRecordV2 = { ...active, awaitingReview: false }
      if (record.status === 'done') {
        next.digest = truncateText(record.summary, 200)
        next.lastDeliveryConfirmedAt = record.createdAt
        next.blocked = false
      } else {
        next.blocked = true
      }
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

    const delivery = record.status !== 'blocked'
      ? null
      : await deliverInbox({
          store: opened.store,
          events: [{
            topicId: caller.sessionId,
            kind: 'blocked',
            summary: blockedInboxSummary(caller.sessionId, record.summary),
          }],
          deliver: async (text) => {
            const prompted = await opened.slice.promptSession(document.masterSessionId, text)
            if (!prompted.accepted) throw new Error('master did not accept the inbox batch')
          },
          clock: () => now,
        })

    return toJson(success({
      status: record.status,
      filePath: file.filePath,
      record,
      topic: topicView(updated),
      delivery,
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
    const stamp = now.toISOString()
    let found = false
    let alreadyResolved = false
    let previousStatus: 'active' | 'idle' | 'resolved' | null = null
    let resolved: TopicRecordV2 | null = null
    await opened.store.mutateIndexDocument((document) => {
      const topic = document.topics.find((entry) => entry.topicId === topicId)
      if (topic === undefined) return null
      found = true
      previousStatus = topic.status
      if (topic.status === 'resolved') {
        alreadyResolved = true
        resolved = topic
        return null
      }
      const next: TopicRecordV2 = {
        ...topic,
        status: 'resolved',
        resolvedAt: stamp,
        resolvedBy: 'user',
        updatedAt: stamp,
      }
      resolved = next
      return {
        ...document,
        topics: document.topics.map((entry) => (entry.topicId === topicId ? next : entry)),
      }
    })
    if (!found || resolved === null) {
      return toJson(failure(
        TOPIC_ERROR_CODES.topicNotFound,
        `topic not found in the project index: ${topicId}`,
        { topicId },
      ))
    }
    if (!alreadyResolved && previousStatus !== null) {
      await recordActivityQuietly(opened, buildActivityEvent({
        type: 'status-changed',
        topicId,
        summary: `changed topic status from ${previousStatus} to resolved`,
        details: { topicId, from: previousStatus, to: 'resolved', by: 'user' },
      }, now))
    }
    return toJson(success({ topic: topicView(resolved), alreadyResolved }))
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
 * Register the six topic tools (including the two deprecated aliases) and
 * return their disposers, in the documented order.
 */
export function registerTopicTools(ctx: unknown, deps: CoworkToolDeps): Array<() => void> {
  const host = ctx as { tools: { register(definition: ToolDefinition): () => void } }
  const disposers: Array<() => void> = []
  const createExecute = (args: Record<string, unknown>, exec: unknown) => createTopic(args, exec, deps)
  const listExecute = (args: Record<string, unknown>, exec: unknown) => listTopics(args, exec, deps)
  const handoffExecute = (args: Record<string, unknown>, exec: unknown) => handoff(args, exec, deps)
  const resolveExecute = (args: Record<string, unknown>, exec: unknown) => resolveTopic(args, exec, deps)

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

  // 5) cowork_handoff — the only way a topic reports back.
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

  // 6) cowork_topic_resolve — master-only manual resolution.
  disposers.push(host.tools.register(defineTool({
    name: 'cowork_topic_resolve',
    description: 'Mark one topic resolved by user decision. Idempotent; resolved topics are not reopened by routing. Master only.',
    parameters: {
      topicId: { type: 'string', required: true, description: 'Topic to mark resolved.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: resolveExecute,
  })))

  return disposers
}
