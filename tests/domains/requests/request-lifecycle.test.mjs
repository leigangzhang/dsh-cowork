/**
 * `resolveRequest` must tell "this call's action landed" apart from "a record
 * came back": `RequestStore.update` answers a declined mutator with the current
 * record, so two concurrent resolutions of one request would otherwise both
 * report success, both write a `request-resolved` row and both wake the topic.
 *
 * The concurrency tests assert only outcomes that hold whichever call wins the
 * lock; no assertion depends on which one gets there first. The rest pin the
 * non-concurrent replay/conflict contract and the deterministic failure branches
 * (a card that vanished mid-call, refused activity and delivery writes) against
 * real stores on real files.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, unlink } from 'node:fs/promises'
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  fakeHost,
  makeSeedProject,
  makeSeedRequest,
  makeTopicFixture,
  withRepo,
} from '../../support/inbox-fixtures.mjs'

const service = await import('../../../src/domains/requests/request-service.ts')
const { authorizationResolvedActivity } = await import('../../../src/store/activity.ts')
const { applyResolution } = await import('../../../src/domains/requests/request-schema.ts')
const { RequestStore } = await import('../../../src/store/request-store.ts')
const { actionForStatus } = await import('../../../src/panel/inbox-contract.ts')

const NOW = new Date('2026-11-10T09:00:00.000Z')
const NOW_ISO = NOW.toISOString()
const MASTER = 'session-master'
const TOPIC = 'session-topic'
const REQUEST_ID = 'req-1'

const topic = makeTopicFixture({
  topicId: TOPIC,
  title: 'Inbox backend',
  scope: 'inbox',
  digest: 'working',
})

/** A topic blocked on the suite's pending authorization. */
function pendingAuthorization() {
  return topic({
    status: 'idle',
    blocked: true,
    blockedReason: 'authorization',
    blockedFromStatus: 'idle',
    blockedAt: NOW_ISO,
    authorization: { requestId: REQUEST_ID, summary: 'may I push?', requestedAt: NOW_ISO },
  })
}

const seedProject = makeSeedProject({ clock: () => NOW })
const seedRequest = makeSeedRequest({ now: NOW, topic: () => topic() })

/** The persisted card of the repository. */
function readRequest(repoPath, requestId = REQUEST_ID) {
  return new RequestStore({ repoPath }).read(requestId)
}

/** The index + caller identity one resolve call needs. */
function resolveInput(repoPath, store, host, overrides = {}) {
  return {
    store,
    repoPath,
    document: { masterSessionId: MASTER, topics: [topic()] },
    sessionId: MASTER,
    requestId: REQUEST_ID,
    action: 'pass',
    now: NOW,
    promptSession: host.promptSession,
    noticePort: host.port,
    log: () => {},
    ...overrides,
  }
}

/** A view over the real store whose first index read runs `interleave` first. */
function interleavingStore(store, interleave) {
  const wrapped = Object.create(store)
  let first = true
  wrapped.readIndexDocument = async () => {
    if (first) {
      first = false
      await interleave()
    }
    return store.readIndexDocument()
  }
  return wrapped
}

/**
 * The conflict context of one refused concurrent resolution: the losing caller
 * either sees the terminal card at its first read or loses the locked write, so
 * exactly one of the two shipped wordings must name the winning status.
 */
function concurrentConflict(error, status) {
  return error.code === 'inbox/request-resolved'
    && [
      `request req-1 was already resolved as ${status}`,
      `request req-1 was resolved concurrently as ${status}`,
    ].includes(error.message)
}

test('concurrent different actions: one wins, one conflict, one prompt and one activity', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    await seedRequest(repoPath, store, { kind: 'user-review', payload: { purpose: 'review' } })
    const host = fakeHost()

    const settled = await Promise.allSettled([
      service.resolveRequest(resolveInput(repoPath, store, host, { action: 'pass' })),
      service.resolveRequest(resolveInput(repoPath, store, host, { action: 'return' })),
    ])
    const won = settled.filter((entry) => entry.status === 'fulfilled')
    const refused = settled.filter((entry) => entry.status === 'rejected')
    assert.equal(won.length, 1, 'exactly one concurrent action is applied')
    assert.equal(refused.length, 1, 'the other caller is refused instead of reported as success')

    const persisted = await readRequest(repoPath)
    assert.equal(persisted.status, won[0].value.record.status)
    assert.equal(won[0].value.changed, true)
    assert.equal(won[0].value.prompted, true)
    assert.ok(
      concurrentConflict(refused[0].reason, persisted.status),
      `the refusal names the winning status: ${refused[0].reason.message}`,
    )
    assert.equal(host.prompts.length, 1, 'the topic is woken exactly once')

    const { events } = await store.readActivity()
    const resolved = events.filter((event) => event.type === 'request-resolved')
    assert.equal(resolved.length, 1, 'one terminal write writes one activity row')
    assert.equal(resolved[0].details.status, persisted.status)
    assert.equal(resolved[0].details.action, actionForStatus(persisted.status))
  })
})

test('concurrent same action: one applies, one replays, one prompt and one activity', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    await seedRequest(repoPath, store, { kind: 'user-review', payload: { purpose: 'review' } })
    const host = fakeHost()

    const outcomes = await Promise.all([
      service.resolveRequest(resolveInput(repoPath, store, host, { action: 'pass' })),
      service.resolveRequest(resolveInput(repoPath, store, host, { action: 'pass' })),
    ])
    assert.deepEqual(
      outcomes.map((outcome) => outcome.changed).sort(),
      [false, true],
      'the action is applied once and replayed once',
    )
    const applied = outcomes.find((outcome) => outcome.changed)
    const replay = outcomes.find((outcome) => !outcome.changed)
    assert.equal(applied.prompted, true)
    assert.equal(replay.prompted, false)
    assert.equal(replay.record.status, 'passed')
    assert.equal((await readRequest(repoPath)).status, 'passed')
    assert.equal(host.prompts.length, 1, 'an idempotent replay never prompts')

    const { events } = await store.readActivity()
    const resolved = events.filter((event) => event.type === 'request-resolved')
    assert.equal(resolved.length, 1, 'an idempotent replay never writes a second row')
    assert.equal(resolved[0].details.action, 'pass')
    assert.equal(resolved[0].details.status, 'passed')
  })
})

test('sequential resolve, replay and conflict keep the documented contract', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    await seedRequest(repoPath, store, { kind: 'user-review', payload: { purpose: 'review' } })
    const host = fakeHost()

    const first = await service.resolveRequest(resolveInput(repoPath, store, host, { comment: 'ok' }))
    assert.equal(first.changed, true)
    assert.equal(first.prompted, true)
    assert.equal(first.record.status, 'passed')

    const replay = await service.resolveRequest(resolveInput(repoPath, store, host))
    assert.equal(replay.changed, false)
    assert.equal(replay.prompted, false)
    assert.equal(replay.record.delivery.promptedAt, NOW_ISO)

    await assert.rejects(
      service.resolveRequest(resolveInput(repoPath, store, host, { action: 'return' })),
      (error) => error.code === 'inbox/request-resolved'
        && error.message === 'request req-1 was already resolved as passed',
    )
    assert.equal(host.prompts.length, 1)
    assert.equal((await readRequest(repoPath)).status, 'passed')
  })
})

test('a request that disappears between the read and the write is not found', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    await seedRequest(repoPath, store, { kind: 'user-review', payload: { purpose: 'review' } })
    const host = fakeHost()
    const cardPath = join(repoPath, '.dsh-cowork', 'requests', `${REQUEST_ID}.json`)
    // The member guard is the last read before the write; removing the card
    // there is a deterministic another-writer deletion inside that window.
    const document = {
      get masterSessionId() {
        unlinkSync(cardPath)
        return MASTER
      },
      topics: [topic()],
    }

    await assert.rejects(
      service.resolveRequest(resolveInput(repoPath, store, host, { document })),
      (error) => error.code === 'inbox/request-not-found'
        && error.message === 'request req-1 vanished',
    )
    assert.deepEqual(host.prompts, [])
    assert.equal(await readRequest(repoPath), null)
  })
})

test('a decision committed between the read and the lock replays idempotently', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [pendingAuthorization()])
    await seedRequest(repoPath, store, { kind: 'authorization', payload: { summary: 'may I push?' } })
    const host = fakeHost()
    const other = fakeHost()
    const racing = interleavingStore(store, async () => {
      // The same action wins first; this call must observe it as a replay.
      await service.resolveRequest(resolveInput(repoPath, store, other, { action: 'allow' }))
    })

    const outcome = await service.resolveRequest(resolveInput(repoPath, racing, host, { action: 'allow' }))
    assert.equal(outcome.changed, false)
    assert.equal(outcome.prompted, false)
    assert.equal(outcome.record.status, 'allowed')
    assert.equal(host.prompts.length, 0, 'the replay never prompts a second time')
    assert.equal(other.prompts.length, 1)
    assert.equal((await readRequest(repoPath)).status, 'allowed')
    const { events } = await store.readActivity()
    assert.equal(events.filter((event) => event.type === 'request-resolved').length, 1)
  })
})

test('a replay whose card vanished after the decision is reported as not found', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [pendingAuthorization()])
    await seedRequest(repoPath, store, { kind: 'authorization', payload: { summary: 'may I push?' } })
    const host = fakeHost()
    const other = fakeHost()
    const cardPath = join(repoPath, '.dsh-cowork', 'requests', `${REQUEST_ID}.json`)
    const racing = interleavingStore(store, async () => {
      // Another caller commits the same decision, then its card is removed
      // before this replay re-reads it; a vanished card is a not-found failure,
      // not a success report for an action that is no longer persisted.
      await service.resolveRequest(resolveInput(repoPath, store, other, { action: 'allow' }))
      await unlink(cardPath)
    })

    await assert.rejects(
      service.resolveRequest(resolveInput(repoPath, racing, host, { action: 'allow' })),
      (error) => error.code === 'inbox/request-not-found'
        && error.message === 'request req-1 vanished',
    )
    assert.deepEqual(host.prompts, [])
    assert.equal(other.prompts.length, 1)
    assert.equal(await readRequest(repoPath), null)
  })
})

test('a decision whose card vanished before the transaction is reported, not recreated', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [pendingAuthorization()])
    await seedRequest(repoPath, store, { kind: 'authorization', payload: { summary: 'may I push?' } })
    const host = fakeHost()
    const cardPath = join(repoPath, '.dsh-cowork', 'requests', `${REQUEST_ID}.json`)
    const racing = interleavingStore(store, () => unlink(cardPath))

    await assert.rejects(
      service.resolveRequest(resolveInput(repoPath, racing, host, { action: 'allow' })),
      (error) => error.code === 'inbox/request-resolved'
        && /^request req-1 has no card to settle with its authorization decision$/.test(error.message),
    )
    assert.deepEqual(host.prompts, [])
    assert.equal(await readRequest(repoPath), null)
    const document = await store.readIndexDocument()
    assert.equal(document.topics[0].authorization, null, 'the unlock was already committed')
  })
})

test('a card settled with a different action while the decision is in flight is a conflict', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    await seedRequest(repoPath, store, { kind: 'authorization', payload: { summary: 'may I push?' } })
    // The index already records this action's decision; only the card file,
    // written separately, was settled with the other one.
    await store.appendActivity(authorizationResolvedActivity(topic(), {
      requestId: REQUEST_ID,
      noticeId: '',
      decision: 'allow',
      summary: 'may I push?',
    }, NOW))
    const host = fakeHost()
    const racing = interleavingStore(store, () => new RequestStore({ repoPath }).update(
      REQUEST_ID,
      (current) => applyResolution(current, { status: 'denied', resolvedBy: 'user', now: NOW }),
    ))

    await assert.rejects(
      service.resolveRequest(resolveInput(repoPath, racing, host, { action: 'allow' })),
      (error) => error.code === 'inbox/request-resolved'
        && error.message === 'request req-1 was resolved concurrently as denied',
    )
    assert.deepEqual(host.prompts, [])
    assert.equal((await readRequest(repoPath)).status, 'denied')
  })
})

test('createRequest persists the request when its created activity is refused', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [topic()])
    const logs = []
    const record = await service.createRequest({
      store: {
        appendActivity: async () => {
          throw new Error('activity sink full')
        },
      },
      repoPath,
      projectId: 'p',
      topic: topic(),
      kind: 'user-review',
      payload: { purpose: 'review' },
      requestId: REQUEST_ID,
      now: NOW,
      log: (message) => logs.push(message),
    })

    assert.equal(record.status, 'pending')
    assert.equal((await readRequest(repoPath)).requestId, REQUEST_ID)
    assert.deepEqual(logs, ['request req-1 created, activity not recorded: activity sink full'])
  })
})

test('createRequest propagates a non-schema build failure instead of mapping it to invalid-body', async () => {
  await withRepo(async (repoPath) => {
    await seedProject(repoPath, [topic()])

    await assert.rejects(
      service.createRequest({
        store: { appendActivity: async () => {} },
        repoPath,
        projectId: 'p',
        topic: topic(),
        kind: 'user-review',
        payload: { purpose: 'review' },
        requestId: REQUEST_ID,
        // A failed clock read breaks record building before validation, which is
        // not a schema error; the catch must rethrow it, not map it to
        // `request/invalid-body`.
        now: new Date(Number.NaN),
      }),
      (error) => error instanceof RangeError && error.code !== 'request/invalid-body',
    )
    assert.equal(await readRequest(repoPath), null)
  })
})

test('resolveRequest keeps the terminal state when its resolved activity is refused', async () => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    await seedRequest(repoPath, store, { kind: 'user-review', payload: { purpose: 'review' } })
    const host = fakeHost()
    const logs = []
    const refused = {
      appendActivity: async (event) => {
        if (event.type === 'request-resolved') throw new Error('activity sink full')
      },
    }

    const outcome = await service.resolveRequest(resolveInput(repoPath, refused, host, {
      log: (message) => logs.push(message),
    }))
    assert.equal(outcome.changed, true)
    assert.equal(outcome.prompted, true)
    assert.equal((await readRequest(repoPath)).status, 'passed')
    assert.deepEqual(logs, ['request req-1 resolved, activity not recorded: activity sink full'])
  })
})

test('a prompt whose delivery facts cannot be persisted is still reported and logged', async (t) => {
  await withRepo(async (repoPath) => {
    const store = await seedProject(repoPath, [topic()])
    await seedRequest(repoPath, store, { kind: 'user-review', payload: { purpose: 'review' } })
    const host = fakeHost()
    const logs = []
    const requestsDir = join(repoPath, '.dsh-cowork', 'requests')
    const restore = async () => {
      try {
        await chmod(requestsDir, 0o755)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    t.after(restore)

    const outcome = await service.resolveRequest(resolveInput(repoPath, store, host, {
      log: (message) => logs.push(message),
      promptSession: async (sessionId, text) => {
        // The prompt is a host call; refusing later card writes leaves the
        // terminal state durable and the delivery facts unrecorded.
        await chmod(requestsDir, 0o555)
        return host.promptSession(sessionId, text)
      },
    }))
    await restore()

    assert.equal(outcome.prompted, true)
    assert.equal(outcome.promptError, null)
    assert.equal(outcome.record.status, 'passed')
    assert.equal(host.prompts.length, 1)
    assert.equal((await readRequest(repoPath)).delivery.promptedAt, null)
    assert.ok(logs.some((line) => /delivery was not recorded/.test(line)), logs.join('\n'))
  })
})
