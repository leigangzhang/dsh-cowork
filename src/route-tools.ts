/**
 * `cowork_route` (M9.3b): wire the M9.1 pure router and the M9.2 model fallback
 * to the canonical v2 index, the project lock, and the topic sessions.
 *
 * Responsibilities kept here: the read-point lifecycle evaluation, explicit
 * `topicId` handling, the three decision layers, the v2 writes
 * (`lastRouteTopicId`, new topic, activity), the bounded payload, and the
 * correction write path M11 will call from the panel. The pure rules stay in
 * `src/routing.ts`, the single LLM call in `src/router-model.ts`, and the host
 * `llm` service is injected through `src/index.ts`; a missing or failing model
 * degrades to the structured candidates and never throws.
 *
 * `resolved` topics are never prompted: an explicit resolved `topicId` returns
 * `resolved_match`, creates a new topic, and sends the intent to the new one.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { buildActivityEvent } from './activity.js'
import { TOPIC_PRESET_ID } from './presets.js'
import {
  applyRouteCorrection,
  decideExplicitRoute,
  decideRoute,
  routeCreateTitle,
  withRouteTargets,
} from './routing.js'
import type { RouteCandidate, RouteDecision } from './routing.js'
import { recommendWithModel } from './router-model.js'
import type { ModelCandidate, ModelOutcome, RoutingModelConfig } from './router-model.js'
import type { ProjectStore } from './store.js'
import type { ActivityEvent, ProjectIndexV2, TopicRecordV2 } from './store-schema.js'
import { DEFAULT_IDLE_AFTER_MS, DEFAULT_RESOLVE_AFTER_MS } from './topic.js'
import type { CoworkToolDeps, JsonValue } from './tool-runtime.js'
import {
  BRIEF_MAX_CHARS,
  callerOf,
  evaluateProjectLifecycle,
  isFailure,
  mapError,
  nowOf,
  openProject,
  renderJson,
  toJson,
  topicView,
  truncateText,
} from './tool-runtime.js'
import { ERROR_CODES, TOPIC_ERROR_CODES, buildThreadBrief, checkRole, failure, success } from './tool-model.js'
import { activeWorkItemCount } from './work-item.js'

/** Most candidates the route payload and its activity details carry. */
const ROUTE_PAYLOAD_CANDIDATES = 3
/** Most correction tokens one `route-corrected` activity stores. */
const CORRECTION_DETAILS_MAX_TOKENS = 8

/** Build the bounded candidates the model layer and the payload receive. */
function boundedCandidates(candidates: readonly RouteCandidate[]): Array<{
  topicId: string
  title: string
  score: number
  reasons: string[]
}> {
  return candidates.slice(0, ROUTE_PAYLOAD_CANDIDATES).map((candidate) => ({
    topicId: candidate.topicId,
    title: candidate.title,
    score: candidate.score,
    reasons: [...candidate.reasons],
  }))
}

/** Map the pure router's candidates onto the model prompt rows. */
function modelCandidates(
  candidates: readonly RouteCandidate[],
  document: ProjectIndexV2,
): ModelCandidate[] {
  return candidates.slice(0, ROUTE_PAYLOAD_CANDIDATES).map((candidate) => {
    const topic = document.topics.find((entry) => entry.topicId === candidate.topicId)
    return {
      topicId: candidate.topicId,
      title: candidate.title,
      scope: topic?.scope ?? '',
      digest: topic?.digest ?? '',
    }
  })
}

/**
 * The effective model configuration: the configured routing settings, with the
 * host's current default model filling a blank provider/model. A missing
 * `routing` object stays "unconfigured", which the model module turns into a
 * structured fallback without touching the port.
 */
function effectiveRoutingConfig(deps: CoworkToolDeps): RoutingModelConfig {
  const configured = deps.routing
  let provider = configured?.provider ?? ''
  let model = configured?.model ?? ''
  if ((provider.trim() === '' || model.trim() === '') && deps.currentModelRoute !== undefined) {
    try {
      const current = deps.currentModelRoute()
      if (current !== null) {
        if (provider.trim() === '') provider = current.provider
        if (model.trim() === '') model = current.model
      }
    } catch {
      // A host service that cannot answer is the same as no default selection.
    }
  }
  return {
    enabled: configured?.enabled ?? true,
    provider,
    model,
    effort: configured?.effort ?? '',
    timeoutMs: configured?.timeoutMs ?? 0,
    maxTokens: configured?.maxTokens ?? 0,
  }
}

/** Fold a model outcome back into the structured decision it refines. */
function withModelOutcome(decision: RouteDecision, outcome: ModelOutcome): RouteDecision {
  if (outcome.action === 'reuse' && outcome.topicId !== null) {
    return { action: 'reuse', topicId: outcome.topicId, reason: 'layer3:model-reuse', candidates: decision.candidates }
  }
  if (outcome.action === 'create') {
    return { action: 'create', reason: 'layer3:model-create', candidates: decision.candidates }
  }
  return outcome.topicId !== null
    ? { action: 'reuse', topicId: outcome.topicId, reason: 'layer3:fallback-reuse', candidates: decision.candidates }
    : { action: 'create', reason: 'layer3:fallback-create', candidates: decision.candidates }
}

/** The bounded details every route activity stores. Never includes the intent. */
function routeDetails(
  decision: RouteDecision,
  modelUsed: boolean,
  confidence: number | null,
): Record<string, unknown> {
  const [layer, rest = ''] = decision.reason.split(':')
  return {
    topicId: decision.topicId ?? null,
    layer,
    reason: rest.split('(')[0],
    candidates: decision.candidates
      .slice(0, ROUTE_PAYLOAD_CANDIDATES)
      .map((candidate) => ({ topicId: candidate.topicId, score: candidate.score })),
    modelUsed,
    confidence,
  }
}

/** Append one route activity; evidence-only, so a failure never rolls state back. */
async function recordRouteActivity(store: ProjectStore, event: ActivityEvent): Promise<void> {
  try {
    await store.appendActivity(event)
  } catch {
    // The index write already stands. M8's topic events follow the same rule.
  }
}

/** Build one canonical topic for a route-created session. */
function newRouteTopic(input: {
  topicId: string
  title: string
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
    scope: '',
    ownedPaths: [],
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

/** The bound on one prompt (brief or generated opener). */
function boundedPrompt(text: string): string {
  return truncateText(text, BRIEF_MAX_CHARS)
}

/** `cowork_route` execute, bound to the injected deps. */
async function route(
  args: Record<string, unknown>,
  exec: unknown,
  deps: CoworkToolDeps,
): Promise<JsonValue> {
  const caller = callerOf(exec)
  if (isFailure(caller)) return toJson(caller)

  const intent = typeof args.intent === 'string' ? args.intent.trim() : ''
  if (intent === '') return toJson(failure(ERROR_CODES.intentRequired, 'intent must not be empty'))
  const forceCreate = args.forceCreate === true
  const requestedTopicId = typeof args.topicId === 'string' ? args.topicId.trim() : ''
  if (forceCreate && requestedTopicId !== '') {
    return toJson(failure(
      TOPIC_ERROR_CODES.routeArgsConflict,
      'forceCreate and topicId are mutually exclusive',
    ))
  }
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

    // Read point: settle idle/resolved before routing over the topics.
    const now = nowOf(deps)
    await evaluateProjectLifecycle(opened.store, {
      idleAfterMs: deps.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS,
      resolveAfterMs: deps.resolveAfterMs ?? DEFAULT_RESOLVE_AFTER_MS,
      now,
      activeWorkItemsOf: (topicId, document) => activeWorkItemCount(document, topicId),
    })
    const document = await opened.store.readIndexDocument()

    let decision: RouteDecision
    if (forceCreate) {
      decision = { action: 'create', reason: 'force-create', candidates: [] }
    } else if (requestedTopicId !== '') {
      const explicit = decideExplicitRoute(requestedTopicId, document.topics)
      if (explicit === null) {
        return toJson(failure(
          TOPIC_ERROR_CODES.topicNotFound,
          `topic not found in the project index: ${requestedTopicId}`,
          { topicId: requestedTopicId },
        ))
      }
      decision = explicit
    } else {
      decision = decideRoute(intent, document.topics, {
        nowMs: now.getTime(),
        focusTopicId: document.masterFocusTopicId ?? null,
        lastRouteTopicId: document.lastRouteTopicId ?? null,
      })
    }

    let modelUsed = false
    let modelError: string | undefined
    let confidence: number | null = null
    if (decision.action === 'needs_model') {
      const outcome = await recommendWithModel({
        intent,
        candidates: modelCandidates(decision.candidates, document),
        config: effectiveRoutingConfig(deps),
        port: deps.llmRoutingPort,
      })
      modelUsed = outcome.modelUsed
      if (outcome.action === 'fallback') modelError = outcome.modelError
      else confidence = outcome.confidence
      decision = withModelOutcome(decision, outcome)
    }

    const resolvedMatch = decision.action === 'resolved_match' ? decision.resolvedMatch : undefined
    const candidates = boundedCandidates(decision.candidates)

    if (decision.action === 'reuse') {
      const target = document.topics.find((entry) => entry.topicId === decision.topicId)
      if (target === undefined || decision.topicId === undefined) {
        return toJson(failure(
          TOPIC_ERROR_CODES.topicNotFound,
          `topic not found in the project index: ${String(decision.topicId)}`,
          { topicId: decision.topicId ?? null },
        ))
      }
      const promptText = boundedPrompt(brief === '' ? intent : `${intent}\n\n${brief}`)
      const prompted = await opened.slice.promptSession(target.topicId, promptText)
      await opened.store.mutateIndexDocument((current) =>
        withRouteTargets(current, { lastRouteTopicId: target.topicId }),
      )
      await recordRouteActivity(opened.store, buildActivityEvent({
        type: 'route-reused',
        topicId: target.topicId,
        summary: `reused topic ${target.topicId}`,
        details: routeDetails(decision, modelUsed, confidence),
      }, now))
      return toJson(success({
        action: 'reuse',
        topicId: target.topicId,
        title: target.title,
        reason: decision.reason,
        candidates,
        modelUsed,
        ...(modelError === undefined ? {} : { modelError }),
        prompted: prompted.accepted,
        topic: topicView(target),
      }))
    }

    // create / resolved_match: one session, one canonical write, then the prompt.
    const title = routeCreateTitle(intent)
    const created = await opened.slice.createThread({
      repoPath: opened.repoPath,
      subject: title,
      presetId: TOPIC_PRESET_ID,
    })
    const topic = newRouteTopic({
      topicId: created.sessionId,
      title,
      cwd: opened.repoPath,
      now,
    })

    try {
      await opened.store.mutateIndexDocument((current) =>
        withRouteTargets(
          { ...current, topics: [...current.topics, topic] },
          { lastRouteTopicId: topic.topicId },
        ),
      )
    } catch (error) {
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

    await recordRouteActivity(opened.store, buildActivityEvent({
      type: 'topic-created',
      topicId: topic.topicId,
      summary: `created topic ${truncateText(title, 80)}`,
      details: routeDetails(decision, modelUsed, confidence),
    }, now))
    await recordRouteActivity(opened.store, buildActivityEvent({
      type: 'route-created',
      topicId: topic.topicId,
      summary: `created topic ${truncateText(title, 80)} for the intent`,
      details: routeDetails(decision, modelUsed, confidence),
    }, now))

    const promptText = boundedPrompt(
      brief !== ''
        ? brief
        : buildThreadBrief({
          repoPath: opened.repoPath,
          subject: title,
          topicId: topic.topicId,
          intent,
        }),
    )
    const prompted = await opened.slice.promptSession(topic.topicId, promptText)

    return toJson(success({
      action: decision.action === 'resolved_match' ? 'resolved_match' : 'create',
      topicId: topic.topicId,
      title,
      ...(resolvedMatch === undefined ? {} : { resolvedMatch }),
      reason: decision.reason,
      candidates,
      modelUsed,
      ...(modelError === undefined ? {} : { modelError }),
      prompted: prompted.accepted,
      topic: topicView(topic),
    }))
  } catch (error) {
    return toJson(mapError(error))
  }
}

/**
 * Correction write path for the M11 panel: append the intent's tokens to one
 * topic's aliases and record `route-corrected`. Canonical lock-scoped write; if
 * the correction adds nothing, nothing is written and `changed` is false.
 */
export async function applyRouteCorrectionToStore(
  store: ProjectStore,
  input: { topicId: string; intent: string },
  now: Date,
): Promise<{ topicId: string; changed: boolean; added: string[]; aliases: string[] }> {
  const result = { topicId: input.topicId, changed: false, added: [] as string[], aliases: [] as string[] }
  await store.mutateIndexDocument((document) => {
    const topic = document.topics.find((entry) => entry.topicId === input.topicId)
    if (topic === undefined) return null
    const corrected = applyRouteCorrection(topic, input.intent)
    result.aliases = [...corrected.aliases]
    if (corrected === topic) return null
    result.changed = true
    result.added = corrected.aliases.slice(topic.aliases.length)
    return {
      ...document,
      topics: document.topics.map((entry) => (entry.topicId === topic.topicId ? corrected : entry)),
    }
  })
  if (result.changed) {
    await recordRouteActivity(store, buildActivityEvent({
      type: 'route-corrected',
      topicId: input.topicId,
      summary: `corrected route to topic ${input.topicId}`,
      details: {
        topicId: input.topicId,
        added: result.added.slice(0, CORRECTION_DETAILS_MAX_TOKENS),
        aliasCount: result.aliases.length,
      },
    }, now))
  }
  return result
}

/**
 * Register `cowork_route` and return its disposer. It sits after the project
 * tools and before the topic tools in the assembly order.
 */
export function registerRouteTools(ctx: unknown, deps: CoworkToolDeps): Array<() => void> {
  const host = ctx as { tools: { register(definition: ToolDefinition): () => void } }
  const disposers: Array<() => void> = []

  disposers.push(host.tools.register(defineTool({
    name: 'cowork_route',
    description:
      'Route a user intent to an existing topic, or create a new topic when nothing matches. Applies the three-layer router (focus/last route, structured match, bounded model fallback), never asks the user to choose, and never messages a resolved topic. Master only.',
    parameters: {
      intent: { type: 'string', required: true, description: 'What the user wants, verbatim.' },
      topicId: { type: 'string', description: 'Explicit target topic. A resolved target creates a new topic and reports resolvedMatch.' },
      brief: {
        type: 'string',
        description: `Optional note appended to the reuse prompt or used as the new topic brief (max ${BRIEF_MAX_CHARS} characters).`,
      },
      forceCreate: { type: 'boolean', description: 'Skip the first two layers and create a new topic; cannot be combined with topicId.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: (args, exec) => route(args, exec, deps),
  })))

  return disposers
}
