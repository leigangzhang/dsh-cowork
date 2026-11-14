/**
 * The shared setup of the request-inbox and topic-tool suites.
 *
 * Only setup lives here: the v2 topic record template, the throwaway repository,
 * the seeded project index, one persisted request and the fake host ports. The
 * assertions stay in each test file, because a shared assertion is a test that
 * cannot fail for the reason its name claims.
 *
 * The module registers the TypeScript loader hook itself, so importing it is
 * enough; it loads `src` modules with a dynamic import after that hook is in
 * place.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import './ts-hook.mjs'

const { ProjectStore } = await import('../../src/store/project-store.ts')
const requestService = await import('../../src/request-service.ts')

/**
 * One v2 topic record with every field the schema requires. Suites bind their
 * own identity defaults through {@link makeTopicFixture}; the record shape
 * exists once so a new required field is added in one place.
 */
const TOPIC_TEMPLATE = {
  topicId: 'session-topic',
  title: 'Topic',
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
  cwd: '/repo',
  legacyCheckoutPath: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  lastActiveAt: '2026-11-01T00:00:00.000Z',
  lastDeliveryConfirmedAt: null,
  resolvedAt: null,
  resolvedBy: null,
  latestReviewRequestId: null,
  reviewStatus: null,
  reviewerSessionId: null,
}

/**
 * Bind a suite's identity defaults to the one record template. The returned
 * `topic(overrides)` keeps the call shape the suites already use.
 */
export function makeTopicFixture(defaults = {}) {
  return (overrides = {}) => ({ ...TOPIC_TEMPLATE, ...defaults, ...overrides })
}

/** Run one test against a fresh temporary repository, always removed. */
export async function withRepo(run, prefix = 'dsh-cowork-test') {
  const repoPath = await mkdtemp(join(tmpdir(), prefix))
  try {
    return await run(repoPath)
  } finally {
    await rm(repoPath, { recursive: true, force: true })
  }
}

/**
 * Bind the one `seedProject` implementation to a suite's clock and roles.
 * Per-call options may still override work items, extra index fields, clock or
 * the master session.
 */
export function makeSeedProject(defaults = {}) {
  return async function seedProject(repoPath, topics, options = {}) {
    const settings = { ...defaults, ...options }
    const workItems = settings.workItems ?? []
    const overrides = settings.overrides ?? {}
    const store = new ProjectStore({
      repoPath,
      clock: settings.clock ?? (() => new Date()),
      projectId: settings.projectId ?? 'p',
    })
    await store.initIndex(settings.master ?? 'session-master')
    if (topics.length > 0 || workItems.length > 0) {
      await store.mutateIndexDocument((document) => ({
        ...document,
        ...overrides,
        topics: topics.map((entry) => ({ ...entry, cwd: repoPath })),
        workItems: [...document.workItems, ...workItems],
      }))
    }
    return store
  }
}

/**
 * Bind `seedRequest` to one suite's clock and topic. The bound topic may be a
 * record or a function of the request input (so a suite can seed a request for
 * another topic); `input.topic` overrides it outright.
 */
export function makeSeedRequest({ now, topic, projectId = 'p' }) {
  return async function seedRequest(repoPath, store, input) {
    return requestService.createRequest({
      store,
      repoPath,
      projectId,
      topic: input.topic ?? (typeof topic === 'function' ? topic(input) : topic),
      now,
      requestId: input.requestId ?? 'req-1',
      kind: input.kind,
      payload: input.payload,
      summary: input.summary,
    })
  }
}

/**
 * Fake host ports: the queue prompt and the notice channel, recording every
 * call. `accepted`/`promptError` shape the prompt outcome.
 */
export function fakeHost({ accepted = true, promptError = null } = {}) {
  const prompts = []
  const updates = []
  const port = {
    capabilities: () => ({ supported: true, actions: true, updates: true }),
    append: async () => 'delivered',
    update: async (sessionId, noticeId, patch) => {
      updates.push({ sessionId, noticeId, patch })
      return 'delivered'
    },
  }
  return {
    prompts,
    updates,
    port,
    promptSession: async (sessionId, text) => {
      prompts.push({ sessionId, text })
      if (promptError !== null) throw new Error(promptError)
      return { accepted }
    },
  }
}
