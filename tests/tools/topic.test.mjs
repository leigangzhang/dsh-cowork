import test from 'node:test'
import assert from 'node:assert/strict'
import '../support/ts-hook.mjs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * M9.3b contract tests for the topic tools: create (+ deprecated alias), list
 * (+ alias), resolve, and the v2 handoff semantics.
 *
 * The tool registry and host ports are recording fakes; the project store is
 * the real one under `os.tmpdir()`. The deprecated aliases must share the same
 * `execute` function and parameter schema, so the two names cannot drift.
 */
import { makeSeedProject, makeTopicFixture, withRepo } from '../support/inbox-fixtures.mjs'

const { registerCoworkTools } = await import('../../src/app/tools.ts')
const { ProjectStore } = await import('../../src/store/project-store.ts')
const { TOPIC_LIST_LIMIT, TOPIC_PAGE_ERROR_CODES } = await import('../../src/tools/topic.ts')
const { authorizationResolvedActivity, decisionProposedActivity } = await import('../../src/store/activity.ts')
const { ERROR_CODES, TOPIC_ERROR_CODES } = await import('../../src/platform/tool-model.ts')
const { INBOX_SUMMARY_MAX_CHARS } = await import('../../src/store/inbox.ts')
const { deliverInbox } = await import('../../src/platform/tool-runtime.ts')

const NOW_ISO = '2026-11-07T10:00:00.000Z'
const NOW_MS = Date.parse(NOW_ISO)

function fakeHost() {
  const registry = new Map()
  return {
    tools: {
      register(definition) {
        registry.set(definition.name, definition)
        return () => registry.delete(definition.name)
      },
    },
    registry,
  }
}

function fakeExec(sessionId, cwd) {
  return { agent: { id: sessionId, session: { header: { cwd } } } }
}

/** Recording host ports: sessions, prompts, archives, and the clock. */
function fakeDeps() {
  const createCalls = []
  const promptCalls = []
  const archiveCalls = []
  let created = 0
  const deps = {
    createCalls,
    promptCalls,
    archiveCalls,
    promptAccepted: true,
    sessionController: {
      async create(options) {
        createCalls.push(options)
        created += 1
        return {
          sessionId: `session-created-${created}`,
          workspaceId: 'workspace-1',
          agentPreset: options.agentPreset,
        }
      },
      async rename({ title }) { return { title, seq: 1 } },
      async prompt(request) {
        promptCalls.push(request)
        return { accepted: deps.promptAccepted }
      },
      async list() { return { items: [] } },
      async inspect(sessionId) { return { meta: { id: sessionId } } },
    },
    workspaceRegistry: {
      async resolveByPath(path) { return { id: 'workspace-1', path } },
      async create(path) { return { id: 'workspace-1', path } },
      async delete() { return true },
      async archiveSession(sessionId, options) { archiveCalls.push({ sessionId, options }) },
    },
    agentPresets: {},
    nowMs: NOW_MS,
    clock: () => new Date(deps.nowMs),
  }
  return deps
}

/** Advance the fake clock by one second between two handoff calls. */
const fakeDepsClock = {
  advance(deps) {
    deps.nowMs += 1000
  },
}


const topic = makeTopicFixture({
  topicId: 'session-thread',
  title: 'thread topic',
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
  lastActiveAt: NOW_ISO,
})

const seedProject = makeSeedProject({ clock: () => new Date(NOW_ISO) })

function tools(deps) {
  const host = fakeHost()
  registerCoworkTools(host, deps)
  return host.registry
}

const promptText = (call) => call.content[0].text

test('cowork_topic_create writes one canonical topic and records topic-created', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [])
    const deps = fakeDeps()
    const registry = tools(deps)

    const result = await registry.get('cowork_topic_create').execute({
      title: 'Billing work',
      scope: 'billing',
      ownedPaths: ['src/billing', ' src/billing ', 'src/invoices'],
      brief: 'Start with the invoice list.',
    }, fakeExec('session-master', repoPath))

    assert.equal(result.ok, true)
    assert.equal(result.title, 'Billing work')
    assert.equal(result.prompted, true)
    assert.equal(deps.createCalls.length, 1)
    assert.equal(deps.createCalls[0].agentPreset, 'cowork-topic')
    assert.equal(deps.promptCalls.length, 1)
    assert.equal(deps.promptCalls[0].sessionId, result.topic.topicId)
    assert.equal(promptText(deps.promptCalls[0]), 'Start with the invoice list.')

    assert.equal(result.topic.status, 'active')
    assert.equal(result.topic.scope, 'billing')
    assert.deepEqual(result.topic.ownedPaths, ['src/billing', 'src/invoices'])
    assert.equal(result.topic.digest, '')

    const document = await store.readIndexDocument()
    const stored = document.topics.find((entry) => entry.topicId === result.topic.topicId)
    assert.ok(stored)
    assert.equal(stored.status, 'active')
    assert.equal(stored.awaitingReview, false)
    assert.equal(stored.blocked, false)
    assert.equal(stored.createdAt, NOW_ISO)
    assert.equal(stored.updatedAt, NOW_ISO)
    assert.equal(stored.lastActiveAt, NOW_ISO)
    assert.equal(stored.cwd, repoPath)
    assert.equal(stored.lastDeliveryConfirmedAt, null)
    assert.equal(stored.resolvedAt, null)
    assert.equal(stored.resolvedBy, null)

    const activity = await store.readActivity()
    assert.ok(activity.events.some((event) => event.type === 'topic-created' && event.topicId === result.topic.topicId))
  })
})

test('cowork_thread_create is the same execute and schema as cowork_topic_create', async () => {
  await withRepo(async (repoPath) => {
    const deps = fakeDeps()
    const registry = tools(deps)
    const primary = registry.get('cowork_topic_create')
    const alias = registry.get('cowork_thread_create')
    assert.ok(primary && alias)
    assert.deepEqual(alias.parameters, primary.parameters)
    assert.match(alias.description, /deprecated/i)
    assert.ok(!('subject' in alias.parameters.properties), 'the old subject parameter is gone')
    assert.ok(!('isolated' in alias.parameters.properties), 'isolated belongs to M10 work items')

    const primaryPayload = await primary.execute({ title: 'Alias check' }, fakeExec('session-master', repoPath))
    const aliasPayload = await alias.execute({ title: 'Alias check' }, fakeExec('session-master', repoPath))
    assert.deepEqual(
      { ...primaryPayload, topic: { ...primaryPayload.topic, topicId: 'id' } },
      { ...aliasPayload, topic: { ...aliasPayload.topic, topicId: 'id' } },
      'both names must return the same payload shape and values',
    )
    assert.equal('thread' in primaryPayload, false, 'the payload uses the topic key')
  })
})

test('cowork_topic_create rejects an empty title, an empty owned path, and an over-long brief', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [])
    const registry = tools(fakeDeps())
    const create = registry.get('cowork_topic_create')

    const emptyTitle = await create.execute({ title: '   ' }, fakeExec('session-master', repoPath))
    assert.equal(emptyTitle.ok, false)
    assert.equal(emptyTitle.error.code, TOPIC_ERROR_CODES.topicTitleRequired)

    const emptyPath = await create.execute({ title: 'ok', ownedPaths: [''] }, fakeExec('session-master', repoPath))
    assert.equal(emptyPath.ok, false)
    assert.equal(emptyPath.error.code, TOPIC_ERROR_CODES.topicInvalidOwnedPaths)

    const longBrief = await create.execute({ title: 'ok', brief: 'x'.repeat(2001) }, fakeExec('session-master', repoPath))
    assert.equal(longBrief.ok, false)
    assert.equal(longBrief.error.code, TOPIC_ERROR_CODES.routeBriefTooLong)
  })
})

test('cowork_topic_list is bounded and only admits master or topic sessions', async () => {
  await withRepo(async (repoPath) => {
    const topics = Array.from({ length: TOPIC_LIST_LIMIT + 1 }, (_, index) => topic({
      topicId: `session-${String(index).padStart(3, '0')}`,
      title: `topic ${index}`,
      lastActiveAt: new Date(NOW_MS - index * 60_000).toISOString(),
    }))
    await seedProject(repoPath, topics)
    const registry = tools(fakeDeps())

    const master = await registry.get('cowork_topic_list').execute({}, fakeExec('session-master', repoPath))
    assert.equal(master.ok, true)
    assert.equal(master.total, TOPIC_LIST_LIMIT + 1)
    assert.equal(master.truncated, true)
    assert.equal(master.topics.length, TOPIC_LIST_LIMIT)
    assert.equal(master.topics[0].topicId, 'session-000', 'newest lastActiveAt first')
    assert.deepEqual(master.topics[0].ownedPaths, [])

    const alias = await registry.get('cowork_thread_list').execute({}, fakeExec('session-master', repoPath))
    assert.deepEqual(alias, master, 'the deprecated alias returns the same payload')

    const thread = await registry.get('cowork_topic_list').execute({}, fakeExec('session-001', repoPath))
    assert.equal(thread.ok, true)

    const stranger = await registry.get('cowork_topic_list').execute({}, fakeExec('session-stranger', repoPath))
    assert.equal(stranger.ok, false)
    assert.equal(stranger.error.code, ERROR_CODES.roleForbidden)
  })
})

test('cowork_topic_resolve archives once, clears the block, and records one topic-archived', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic({ topicId: 'session-thread' })])
    const deps = fakeDeps()
    const registry = tools(deps)
    const resolve = registry.get('cowork_topic_resolve')

    const first = await resolve.execute({ topicId: 'session-thread' }, fakeExec('session-master', repoPath))
    assert.equal(first.ok, true)
    assert.deepEqual(
      deps.archiveCalls,
      [{ sessionId: 'session-thread', options: { stopActivity: true } }],
      'archiving a topic also archives its host session',
    )
    assert.equal(first.alreadyResolved, false)
    assert.equal(first.topic.status, 'resolved')
    assert.equal(first.topic.resolvedBy, 'user')
    assert.equal(first.topic.resolvedAt, NOW_ISO)

    const afterFirst = await readFile(store.indexFile, 'utf8')
    const activity = await store.readActivity()
    const archived = activity.events.find((event) => event.type === 'topic-archived')
    assert.ok(archived, 'the archive is its own event type')
    assert.equal(archived.details.by, 'user')
    assert.equal(archived.topicId, 'session-thread')
    const ledger = await store.readNotices()
    assert.deepEqual(
      ledger.notices.map((row) => [row.target, row.status]),
      [['master', 'pending']],
      'the archive notices only the master, and B mode keeps it pending',
    )

    const second = await resolve.execute({ topicId: 'session-thread' }, fakeExec('session-master', repoPath))
    assert.equal(second.ok, true)
    assert.equal(second.alreadyResolved, true)
    assert.equal(deps.archiveCalls.length, 1, 'a repeated archive does not archive the session twice')
    assert.equal(await readFile(store.indexFile, 'utf8'), afterFirst, 'an already resolved topic is not rewritten')

    const missing = await resolve.execute({ topicId: 'session-missing' }, fakeExec('session-master', repoPath))
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, TOPIC_ERROR_CODES.topicNotFound)

    const threadCall = await resolve.execute({ topicId: 'session-thread' }, fakeExec('session-thread', repoPath))
    assert.equal(threadCall.ok, false)
    assert.equal(threadCall.error.code, ERROR_CODES.roleForbidden)
  })
})

const HANDOFF_VERIFICATION = [{ command: 'npm test', exitCode: 0, evidence: 'ok' }]

test('cowork_topic_resolve describes the host-session archive it actually performs', () => {
  const resolve = tools(fakeDeps()).get('cowork_topic_resolve')
  assert.match(resolve.description, /host session is archived/)
  assert.equal(/not archived by this tool/.test(resolve.description), false)
})

test('cowork_topic_report names its own invalid-kind error code', async () => {
  assert.equal(TOPIC_PAGE_ERROR_CODES.invalidKind, 'topic/invalid-kind')
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [topic({ topicId: 'session-thread' })])
    const report = tools(fakeDeps()).get('cowork_topic_report')
    await assert.rejects(
      report.execute({ summary: 'hello', kind: 'shrug' }, fakeExec('session-thread', repoPath)),
      /must be one of \["progress","blocked"\]/,
    )
    const source = await readFile(new URL('../../src/tools/topic.ts', import.meta.url), 'utf8')
    assert.match(source, /TOPIC_PAGE_ERROR_CODES\.invalidKind, "kind must be/)
    assert.equal(/topicTitleRequired, "kind must be/.test(source), false)
  })
})

test('cowork_handoff exposes only blocked|done and no longer mentions awaiting_review', () => {
  const handoff = tools(fakeDeps()).get('cowork_handoff')
  assert.deepEqual([...handoff.parameters.properties.status.enum], ['blocked', 'done'])
  assert.match(handoff.description, /blocked or done/)
  assert.equal(/awaiting_review/.test(handoff.description), false)
})

test('cowork_handoff(done) records the summary, confirms delivery, and reports one topic-reported event', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [
      topic({
        topicId: 'session-thread',
        status: 'idle',
        blocked: true,
        awaitingReview: true,
        digest: 'old summary',
        lastActiveAt: new Date(NOW_MS - 4 * 60 * 60 * 1000).toISOString(),
      }),
    ])
    const deps = fakeDeps()
    const registry = tools(deps)

    const result = await registry.get('cowork_handoff').execute({
      status: 'done',
      summary: 'x'.repeat(250),
      verification: HANDOFF_VERIFICATION,
    }, fakeExec('session-thread', repoPath))

    assert.equal(result.ok, true)
    assert.equal(result.status, 'done')
    assert.equal(result.noticed, true, 'done reports one topic-reported event')
    assert.equal(result.topic.status, 'active', 'noteTopicActivity returns the idle topic to active')
    assert.equal(result.topic.blocked, false)
    assert.equal(result.topic.awaitingReview, false)
    assert.equal(result.topic.digest.length, 200)
    assert.notEqual(result.topic.status, 'resolved', 'done is not a resolved topic')

    const document = await store.readIndexDocument()
    assert.equal(document.topics[0].status, 'active')
    assert.equal(document.topics[0].digest.length, 200)
    assert.equal(document.topics[0].lastDeliveryConfirmedAt, NOW_ISO, 'done confirms the delivery time')

    assert.equal(deps.promptCalls.length, 0, 'the handoff text is no longer prompted into the master turn')
    assert.deepEqual(await store.readInbox(), [], 'a handoff no longer enters the inbox')
    const activity = await store.readActivity()
    const reported = activity.events.find((event) => event.type === 'topic-reported')
    assert.ok(reported, 'the handoff is a topic-reported event')
    assert.equal(reported.details.kind, 'progress')
    assert.equal(reported.details.notice.kind, 'report')
    const ledger = await store.readNotices()
    assert.deepEqual(
      ledger.notices.map((row) => row.target).sort(),
      ['master', 'topic'],
      'one notice row per target',
    )
    assert.ok(ledger.notices.every((row) => row.status === 'pending'), 'B mode never claims delivery')

    const files = await store.listHandoffs()
    assert.equal(files.length, 1)
    assert.equal(files[0].record.status, 'done')
    assert.equal(files[0].record.deliveredAt, null, 'the file is audit-only in M10, not a delivery ledger')
  })
})

test('cowork_handoff(blocked) blocks for handoff reasons and reports one topic-reported event', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic({ topicId: 'session-thread', status: 'idle' })])
    const deps = fakeDeps()
    const registry = tools(deps)
    const handoff = registry.get('cowork_handoff')

    const blocked = await handoff.execute({
      status: 'blocked',
      summary: 'waiting for input',
      verification: HANDOFF_VERIFICATION,
    }, fakeExec('session-thread', repoPath))

    assert.equal(blocked.ok, true)
    assert.equal(blocked.status, 'blocked')
    assert.equal(blocked.noticed, true)
    assert.equal(blocked.topic.status, 'active')
    assert.equal(blocked.topic.blocked, true)
    assert.equal(blocked.topic.awaitingReview, false)

    const document = await store.readIndexDocument()
    assert.equal(document.topics[0].blockedReason, 'handoff', 'a blocked handoff records its reason')
    assert.equal(document.topics[0].blockedFromStatus, 'idle', 'the block restores the idle status')
    assert.equal(document.topics[0].blockedAt, NOW_ISO)

    assert.deepEqual(await store.readInbox(), [], 'new topic events do not use the inbox')
    assert.equal(deps.promptCalls.length, 0, 'the master is not woken by a prompt any more')
    const activity = await store.readActivity()
    const reported = activity.events.find((event) => event.type === 'topic-reported')
    assert.equal(reported.details.kind, 'blocked')
    assert.equal(reported.details.notice.kind, 'report')

    // The tool boundary itself now rejects the old review status before any write.
    await assert.rejects(
      handoff.execute({
        status: 'awaiting_review',
        summary: 'please review',
        verification: HANDOFF_VERIFICATION,
      }, fakeExec('session-thread', repoPath)),
      /must be one of \["blocked","done"\]/,
    )
    assert.equal((await store.listHandoffs()).length, 1)
  })
})

test('a blocked handoff bounds the event and notice summary', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic({ topicId: 'session-thread' })])
    const deps = fakeDeps()

    const result = await tools(deps).get('cowork_handoff').execute({
      status: 'blocked',
      summary: 'y'.repeat(5000),
      verification: HANDOFF_VERIFICATION,
    }, fakeExec('session-thread', repoPath))

    assert.equal(result.ok, true)
    const activity = await store.readActivity()
    const reported = activity.events.find((event) => event.type === 'topic-reported')
    assert.ok(
      Array.from(reported.details.notice.summary).length <= 200,
      'the notice body is bounded to 200 code points',
    )
    assert.equal(reported.details.summary, reported.details.notice.summary)
  })
})

test('cowork_handoff refuses the master and never blocks the topic state on a notice failure', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic({ topicId: 'session-thread' })])
    const handoff = tools(fakeDeps()).get('cowork_handoff')

    const master = await handoff.execute({
      status: 'done',
      summary: 'master call',
      verification: HANDOFF_VERIFICATION,
    }, fakeExec('session-master', repoPath))
    assert.equal(master.ok, false)
    assert.equal(master.error.code, ERROR_CODES.roleForbidden)

    // The handoff commits the file and the topic, then reports. The notice port
    // is B mode (unsupported), which never fails the call or the topic.
    const blocked = await handoff.execute({
      status: 'blocked',
      summary: 'waiting for input',
      verification: HANDOFF_VERIFICATION,
    }, fakeExec('session-thread', repoPath))
    assert.equal(blocked.ok, true)
    assert.equal(blocked.topic.blocked, true)
    assert.equal(blocked.noticed, true)
    const files = await store.listHandoffs()
    assert.equal(files.length, 1)
    assert.equal(files[0].record.deliveredAt, null, 'the audit file is not a delivery ledger')
  })
})

test('deliverInbox reports an InboxMarkError as a value and never throws', async () => {
  const item = {
    id: 'item-1',
    time: NOW_ISO,
    topicId: 'session-thread',
    kind: 'blocked',
    summary: 'pending',
    deliveredAt: null,
  }
  let writes = 0
  const store = {
    async readInbox() { return [item] },
    async writeInbox(items) {
      writes += 1
      if (writes > 1) throw new Error('inbox is read-only')
      return items
    },
  }

  const outcome = await deliverInbox({
    store,
    events: [{ topicId: 'session-thread', kind: 'blocked', summary: 'new event' }],
    deliver: async () => {},
    clock: () => new Date(NOW_ISO),
  })

  assert.equal(outcome.delivered, 0)
  assert.equal(outcome.failed, 1)
  assert.match(outcome.error, /could not be marked delivered/)
})

// ---------------------------------------------------------------------------
// the topic-page tools: report, decision proposal, authorization, notices
// ---------------------------------------------------------------------------

test('cowork_topic_report records progress: digest, activity time, and one notice per target', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [
      topic({ topicId: 'session-thread', status: 'idle', digest: 'old', lastActiveAt: new Date(NOW_MS - 60_000).toISOString() }),
    ])
    const deps = fakeDeps()
    const report = tools(deps).get('cowork_topic_report')

    const result = await report.execute({ summary: 'wired the report tool' }, fakeExec('session-thread', repoPath))
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'progress')
    assert.equal(result.topic.status, 'active', 'a report is activity and revives an idle topic')
    assert.equal(result.topic.digest, 'wired the report tool')

    const document = await store.readIndexDocument()
    assert.equal(document.topics[0].status, 'active')
    assert.equal(document.topics[0].lastActiveAt, NOW_ISO)
    const activity = await store.readActivity()
    const reported = activity.events.find((event) => event.type === 'topic-reported')
    assert.equal(reported.details.kind, 'progress')
    assert.equal(reported.details.notice.kind, 'report')
    assert.deepEqual([...reported.details.notice.targets], ['master', 'topic'])
    const ledger = await store.readNotices()
    assert.equal(ledger.notices.length, 2, 'one ledger row per target')
    assert.deepEqual(ledger.notices.map((row) => row.target).sort(), ['master', 'topic'])
    assert.ok(ledger.notices.every((row) => row.noticeId === reported.eventId))
  })
})

test('cowork_topic_report(kind blocked) blocks for handoff reasons and keeps the restore status', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic({ topicId: 'session-thread', status: 'idle' })])
    const report = tools(fakeDeps()).get('cowork_topic_report')

    const result = await report.execute(
      { summary: 'need a decision on the schema', kind: 'blocked' },
      fakeExec('session-thread', repoPath),
    )
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'blocked')
    assert.equal(result.topic.blocked, true)
    const document = await store.readIndexDocument()
    assert.equal(document.topics[0].blockedReason, 'handoff')
    assert.equal(document.topics[0].blockedFromStatus, 'idle')
    assert.equal(document.topics[0].blockedAt, NOW_ISO)
    assert.equal(document.topics[0].status, 'active')
  })
})

test('cowork_topic_report validates its input and refuses non-topic callers', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [topic({ topicId: 'session-thread' })])
    const report = tools(fakeDeps()).get('cowork_topic_report')

    const empty = await report.execute({ summary: '   ' }, fakeExec('session-thread', repoPath))
    assert.equal(empty.ok, false)
    assert.equal(empty.error.code, TOPIC_PAGE_ERROR_CODES.summaryRequired)

    const long = await report.execute({ summary: 'x'.repeat(2001) }, fakeExec('session-thread', repoPath))
    assert.equal(long.ok, false)
    assert.equal(long.error.code, TOPIC_PAGE_ERROR_CODES.summaryRequired)

    const master = await report.execute({ summary: 'hello' }, fakeExec('session-master', repoPath))
    assert.equal(master.ok, false)
    assert.equal(master.error.code, ERROR_CODES.roleForbidden)

    // The tool boundary itself rejects an invented kind before any write.
    await assert.rejects(
      report.execute({ summary: 'hello', kind: 'shrug' }, fakeExec('session-thread', repoPath)),
      /must be one of \["progress","blocked"\]/,
    )
  })
})

test('cowork_decision_propose stores the proposal file and reports one event', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic({ topicId: 'session-thread' })])
    const deps = fakeDeps()
    const registry = tools(deps)
    const propose = registry.get('cowork_decision_propose')

    const result = await propose.execute({
      title: 'choose the schema',
      summary: 'Use index v2 with a notices ledger.',
    }, fakeExec('session-thread', repoPath))
    assert.equal(result.ok, true)
    assert.equal(result.proposal.status, 'open')
    assert.equal(result.proposal.topicId, 'session-thread')
    assert.equal(result.filePath, `.dsh-cowork/proposals/${result.proposal.proposalId}.json`)
    const stored = JSON.parse(await readFile(join(repoPath, result.filePath), 'utf8'))
    assert.deepEqual(stored, result.proposal)
    assert.equal(stored.version, 1)

    const activity = await store.readActivity()
    const proposed = activity.events.find((event) => event.type === 'decision-proposed')
    assert.equal(proposed.details.proposalId, result.proposal.proposalId)
    assert.equal(proposed.details.proposalPath, result.filePath)
    assert.equal(proposed.details.notice.kind, 'proposal')
    const ledger = await store.readNotices()
    assert.equal(ledger.notices.length, 2)

    const listed = await registry.get('cowork_notices').execute({}, fakeExec('session-master', repoPath))
    const proposalNotice = listed.notices.find((notice) => notice.kind === 'proposal')
    assert.equal(proposalNotice.proposalId, result.proposal.proposalId)
    assert.equal(proposalNotice.proposalPath, result.filePath)

    // Events written before proposalPath was added still expose the path,
    // derived from the proposal id they already carry.
    const legacy = decisionProposedActivity(
      (await store.readIndexDocument()).topics[0],
      { proposalId: 'legacy-proposal', title: 'legacy', summary: 'legacy' },
      new Date(NOW_MS),
    )
    await store.appendActivity(legacy)
    const legacyListed = await registry.get('cowork_notices').execute({}, fakeExec('session-master', repoPath))
    const legacyNotice = legacyListed.notices.find((notice) => notice.proposalId === 'legacy-proposal')
    assert.equal(legacyNotice.proposalPath, '.dsh-cowork/proposals/legacy-proposal.json')

    const missingTitle = await propose.execute({ title: '', summary: 'x' }, fakeExec('session-thread', repoPath))
    assert.equal(missingTitle.ok, false)
    assert.equal(missingTitle.error.code, TOPIC_PAGE_ERROR_CODES.proposalTitleRequired)
  })
})

test('cowork_authorization_request blocks with a pending request and returns its id', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic({ topicId: 'session-thread' })])
    const deps = fakeDeps()
    const request = tools(deps).get('cowork_authorization_request')

    const result = await request.execute({ summary: 'may I rewrite the index?' }, fakeExec('session-thread', repoPath))
    assert.equal(result.ok, true)
    assert.equal(typeof result.requestId, 'string')
    assert.equal(result.topic.blocked, true)

    const document = await store.readIndexDocument()
    const row = document.topics[0]
    assert.equal(row.blockedReason, 'authorization')
    assert.equal(row.blockedFromStatus, 'active')
    assert.equal(row.blockedAt, NOW_ISO)
    assert.deepEqual(row.authorization, {
      requestId: result.requestId,
      summary: 'may I rewrite the index?',
      requestedAt: NOW_ISO,
    })

    const activity = await store.readActivity()
    const requested = activity.events.find((event) => event.type === 'authorization-requested')
    assert.equal(requested.details.requestId, result.requestId)
    assert.equal(requested.details.notice.status, 'pending')
    const ledger = await store.readNotices()
    assert.equal(ledger.notices.length, 2)
  })
})

test('cowork_notices lists the master notices, filtered and bounded, and folds the decision in place', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [
      topic({ topicId: 'session-thread' }),
      topic({ topicId: 'session-other', title: 'other topic' }),
    ])
    const deps = fakeDeps()
    const registry = tools(deps)
    await registry.get('cowork_authorization_request').execute(
      { summary: 'may I proceed?' },
      fakeExec('session-thread', repoPath),
    )
    const requested = (await store.readActivity()).events.find(
      (event) => event.type === 'authorization-requested',
    )
    const resolved = authorizationResolvedActivity(
      (await store.readIndexDocument()).topics.find((entry) => entry.topicId === 'session-thread'),
      { requestId: requested.details.requestId, noticeId: requested.eventId, decision: 'allow', summary: 'may I proceed?' },
      new Date(NOW_MS),
    )
    await store.appendActivity(resolved)

    const notices = registry.get('cowork_notices')
    const all = await notices.execute({}, fakeExec('session-master', repoPath))
    assert.equal(all.ok, true)
    assert.equal(all.total, 1, 'the resolved event updates the original notice instead of adding one')
    assert.equal(all.notices[0].noticeId, requested.eventId)
    assert.equal(all.notices[0].status, 'allowed')
    assert.equal(all.notices[0].delivery.status, 'pending', 'B mode stays pending')

    const filtered = await notices.execute({ topicId: 'session-other' }, fakeExec('session-master', repoPath))
    assert.equal(filtered.total, 0)
    const bounded = await notices.execute({ limit: 1 }, fakeExec('session-master', repoPath))
    assert.equal(bounded.notices.length, 1)

    const thread = await notices.execute({}, fakeExec('session-thread', repoPath))
    assert.equal(thread.ok, false)
    assert.equal(thread.error.code, ERROR_CODES.roleForbidden)
  })
})

test('archiving a topic withdraws its pending authorization from cowork_notices', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic({ topicId: 'session-thread' })])
    const deps = fakeDeps()
    const registry = tools(deps)
    const request = await registry.get('cowork_authorization_request').execute(
      { summary: 'may I archive?' },
      fakeExec('session-thread', repoPath),
    )
    assert.equal(request.ok, true)
    const before = await registry.get('cowork_notices').execute({}, fakeExec('session-master', repoPath))
    assert.equal(before.notices[0].status, 'pending')

    const archived = await registry.get('cowork_topic_resolve').execute(
      { topicId: 'session-thread' },
      fakeExec('session-master', repoPath),
    )
    assert.equal(archived.ok, true)

    const after = await registry.get('cowork_notices').execute({}, fakeExec('session-master', repoPath))
    const authorization = after.notices.find((row) => row.kind === 'authorization')
    assert.equal(authorization.status, 'void', 'the request can no longer be decided')
    assert.deepEqual(authorization.actions, [])
    assert.equal(
      after.notices.some((row) => row.kind === 'authorization' && row.status === 'pending'),
      false,
      'the pending authorization is gone from the master view',
    )
    assert.equal(
      after.notices.some((row) => row.kind === 'archive' && row.status === 'void'),
      true,
      'the archive itself is notified to the master',
    )
    assert.equal(deps.archiveCalls.length, 1)
  })
})
