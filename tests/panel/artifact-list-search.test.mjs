import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  PROJECT_ID,
  SESSION,
  artifactApi,
  artifactContract,
  createHarness,
  jsonOf,
  makeRecord,
  request,
} from '../support/artifact-fixtures.mjs'

/**
 * Server-side search of the right-rail list: `GET artifact.list` scans the
 * whole project (not the first page), filters by `status` through the merged
 * rail projection and by `q` over title, type label, and owning session title,
 * and never over a project-relative path. The per-state counts stay
 * project-wide, and session titles come from one batched port call.
 *
 * The route is also driven with hand-built ports where the harness cannot vary
 * them (a missing or failing title port, and a call counter), because those
 * branches are about host capability, not about the wiring `api.ts` supplies.
 */
const LIST = artifactContract.ARTIFACT_LIST_PATH


/** One request against the registered list route of a harness. */
async function listOf(harness, query = {}) {
  return jsonOf(await harness.request(LIST, { query: { sessionId: SESSION, ...query } }))
}

/** The artifact ids a list response carries, in response order. */
function idsOf(body) {
  return body.items.map((item) => item.artifactId)
}

/**
 * List route built directly over `ports`, bypassing `api.ts` so a test can
 * supply, omit, or count the optional title port. `kit` mirrors the panel
 * plumbing the real composition root provides.
 */
function directList(ports, { repoPath, projectId = PROJECT_ID }) {
  const kit = {
    openProject: async () => ({ repoPath, projectId }),
    readJsonBody: async () => ({}),
    jsonResponse: (status, payload) => new Response(JSON.stringify(payload), { status }),
    serve: (handler) => handler,
    fail: (code, message) => Object.assign(new Error(message), { code }),
  }
  const routes = artifactApi.artifactPanelRoutes(ports, kit)
  const route = routes.find((candidate) => candidate.path === LIST)
  assert.ok(route !== undefined, 'the direct route set must carry the list route')
  return (init) => route.fetch(request(LIST, init))
}

/** One seeded project: a title hit, a type-label hit, a foreign session, and a path-only name. */
async function seedSearchProject() {
  const harness = await createHarness({ sessionTitle: 'Spec 主题' })
  const store = harness.runtime().store
  await store.createRecord(makeRecord({
    artifactId: 'artifact-search-title',
    title: 'Alpha Spec',
    type: 'text',
    status: 'pending-view',
    primaryPath: 'docs/alpha.md',
    ownerSessionId: SESSION,
    updatedAt: '2026-02-01T04:00:00.000Z',
  }))
  await store.createRecord(makeRecord({
    artifactId: 'artifact-search-table',
    title: 'Quarterly numbers',
    type: 'table',
    status: 'pending-confirm',
    primaryPath: 'docs/quarterly.md',
    ownerSessionId: SESSION,
    updatedAt: '2026-02-01T03:00:00.000Z',
  }))
  await store.createRecord(makeRecord({
    artifactId: 'artifact-search-foreign',
    title: 'Call notes',
    type: 'text',
    status: 'needs-feedback',
    primaryPath: 'docs/call.md',
    ownerSessionId: 'session-2',
    updatedAt: '2026-02-01T02:00:00.000Z',
  }))
  await store.createRecord(makeRecord({
    artifactId: 'artifact-search-path',
    title: 'Hidden plan',
    type: 'html',
    status: 'confirmed',
    primaryPath: 'docs/secret-plan.md',
    ownerSessionId: 'session-2',
    updatedAt: '2026-02-01T01:00:00.000Z',
  }))
  return harness
}

test('q matches title, type label, and session title, and never a path', async () => {
  const harness = await seedSearchProject()
  try {
    assert.deepEqual(idsOf(await listOf(harness, { q: 'alpha' })), ['artifact-search-title'])
    assert.deepEqual(idsOf(await listOf(harness, { q: 'ALPHA' })), ['artifact-search-title'])
    assert.deepEqual(idsOf(await listOf(harness, { q: '表格' })), ['artifact-search-table'])
    // Both items owned by the titled session match; ownership is projected in.
    assert.deepEqual(idsOf(await listOf(harness, { q: '主题' })), [
      'artifact-search-title', 'artifact-search-table',
    ])
    for (const needle of ['secret-plan', 'secret', 'docs/']) {
      assert.deepEqual(idsOf(await listOf(harness, { q: needle })), [], `${needle} must not match a path`)
    }

    const all = await listOf(harness)
    const foreign = all.items.find((item) => item.artifactId === 'artifact-search-foreign')
    assert.equal(foreign.sessionTitle, null)
    const titled = all.items.find((item) => item.artifactId === 'artifact-search-title')
    assert.equal(titled.sessionTitle, 'Spec 主题')
  } finally {
    await harness.cleanup()
  }
})

test('a blank q is ignored, a padded q is trimmed, and an over-long q is refused', async () => {
  const harness = await seedSearchProject()
  try {
    const all = await listOf(harness)
    assert.equal(all.items.length, 4)
    assert.deepEqual(idsOf(await listOf(harness, { q: '' })), idsOf(all))
    assert.deepEqual(idsOf(await listOf(harness, { q: '   ' })), idsOf(all))
    assert.deepEqual(idsOf(await listOf(harness, { q: '  alpha  ' })), ['artifact-search-title'])

    const atLimit = await listOf(harness, { q: 'a'.repeat(artifactContract.MAX_ARTIFACT_SEARCH_CHARS) })
    assert.deepEqual(atLimit.items, [])
    assert.equal(atLimit.counts.total, 4)
    const response = await harness.request(LIST, {
      query: { sessionId: SESSION, q: 'a'.repeat(artifactContract.MAX_ARTIFACT_SEARCH_CHARS + 1) },
    })
    assert.equal(response.status, 400)
    assert.equal((await jsonOf(response)).error.code, 'request/invalid-query')
  } finally {
    await harness.cleanup()
  }
})

test('q and status are ANDed, and the merged status keeps both pending states', async () => {
  const harness = await seedSearchProject()
  try {
    // 待确认 also matches a stored 待查看 record.
    assert.deepEqual(idsOf(await listOf(harness, { status: 'pending-confirm' })), [
      'artifact-search-title', 'artifact-search-table',
    ])
    // The status filter narrows a q hit down to its own records.
    assert.deepEqual(idsOf(await listOf(harness, { q: 'plan', status: 'confirmed' })), ['artifact-search-path'])
    assert.deepEqual(idsOf(await listOf(harness, { q: 'Alpha Spec', status: 'confirmed' })), [])

    const searched = await listOf(harness, { q: 'alpha', status: 'pending-confirm' })
    assert.deepEqual(idsOf(searched), ['artifact-search-title'])
    // Counts describe the project, never the filtered view.
    const all = await listOf(harness)
    assert.deepEqual(searched.counts, all.counts)
    assert.equal(searched.counts.total, 4)
    assert.equal(searched.counts.pendingView, 1)
    assert.equal(searched.counts.pendingConfirm, 1)
    assert.equal(searched.counts.needsFeedback, 1)
    assert.equal(searched.counts.confirmed, 1)
  } finally {
    await harness.cleanup()
  }
})

test('a work item past the first 200 is searchable and the response reports truncation', async () => {
  const harness = await createHarness()
  try {
    const root = join(harness.repoPath, '.dsh-cowork', 'artifacts')
    const idOf = (index) => `artifact-s${String(index).padStart(7, '0')}-0000-4000-8000-000000000000`
    const base = Date.parse('2026-01-01T00:00:00.000Z')
    const total = 205
    for (let index = 0; index < total; index += 1) {
      const artifactId = idOf(index)
      await mkdir(join(root, artifactId), { recursive: true })
      await writeFile(join(root, artifactId, 'artifact.json'), JSON.stringify(makeRecord({
        artifactId,
        title: index === 200 ? 'Far Target' : `Entry ${index}`,
        // Newest first: index 0 is the most recently updated.
        updatedAt: new Date(base + (total - index) * 1000).toISOString(),
      })))
    }

    const page = await listOf(harness)
    assert.equal(page.items.length, 200)
    assert.equal(page.truncated, true)
    assert.equal(page.items[199].artifactId, idOf(199))
    assert.equal(idsOf(page).includes(idOf(200)), false)

    const found = await listOf(harness, { q: 'far target' })
    assert.deepEqual(idsOf(found), [idOf(200)])
    // One match is not a truncated result, even in a 205-item project.
    assert.equal(found.truncated, false)
  } finally {
    await harness.cleanup()
  }
})

test('the title port is asked once per request and projects every item', async () => {
  const harness = await seedSearchProject()
  try {
    let calls = 0
    const titles = new Map([
      [SESSION, 'Spec 主题'],
      ['session-2', 'Call 会话'],
    ])
    const route = directList({
      runtimeFor: (repoPath) => harness.manager.runtimeFor(repoPath),
      log: (message) => harness.logs.push(message),
      sessionTitles: async () => {
        calls += 1
        return titles
      },
    }, { repoPath: harness.repoPath })
    const body = await jsonOf(await route({ query: { sessionId: SESSION } }))
    assert.equal(calls, 1)
    assert.equal(body.items.length, 4)
    assert.equal(body.items.find((item) => item.artifactId === 'artifact-search-foreign').sessionTitle, 'Call 会话')
    // The search reads the same map: only session-2's records match its title.
    const searched = await jsonOf(await route({ query: { sessionId: SESSION, q: 'Call 会话' } }))
    assert.equal(calls, 2)
    assert.deepEqual(idsOf(searched), ['artifact-search-foreign', 'artifact-search-path'])
  } finally {
    await harness.cleanup()
  }
})

test('a host without the title port still lists and searches by title and type', async () => {
  const harness = await seedSearchProject()
  try {
    const route = directList({
      runtimeFor: (repoPath) => harness.manager.runtimeFor(repoPath),
      log: (message) => harness.logs.push(message),
    }, { repoPath: harness.repoPath })
    const body = await jsonOf(await route({ query: { sessionId: SESSION } }))
    assert.equal(body.items.length, 4)
    assert.equal(body.items.every((item) => item.sessionTitle === null), true)
    assert.deepEqual(idsOf(await jsonOf(await route({ query: { sessionId: SESSION, q: 'alpha' } }))), ['artifact-search-title'])
    assert.deepEqual(idsOf(await jsonOf(await route({ query: { sessionId: SESSION, q: '主题' } }))), [])
    assert.ok(harness.logs.some((message) => message.includes('no session-title listing')))
  } finally {
    await harness.cleanup()
  }
})

test('a failing title listing degrades the list instead of failing it', async () => {
  const harness = await seedSearchProject()
  try {
    const route = directList({
      runtimeFor: (repoPath) => harness.manager.runtimeFor(repoPath),
      log: (message) => harness.logs.push(message),
      sessionTitles: async () => {
        throw new Error('host listing unavailable')
      },
    }, { repoPath: harness.repoPath })
    const before = harness.logs.length
    const body = await jsonOf(await route({ query: { sessionId: SESSION } }))
    assert.equal(body.items.length, 4)
    assert.equal(body.items.every((item) => item.sessionTitle === null), true)
    assert.equal(body.counts.total, 4)
    const failureLogs = harness.logs
      .slice(before)
      .filter((message) => message.includes('session titles lookup failed'))
    assert.equal(failureLogs.length, 1, `expected one failure log, got ${JSON.stringify(failureLogs)}`)
  } finally {
    await harness.cleanup()
  }
})

test('the list answers newest first and refuses an out-of-range status', async () => {
  const harness = await seedSearchProject()
  try {
    const response = await harness.request(LIST, { query: { sessionId: SESSION, status: 'pending-view ' } })
    // A padded status is trimmed, so it is accepted and matches only its own record.
    assert.equal(response.status, 200)
    assert.deepEqual(idsOf(await jsonOf(response)), ['artifact-search-title'])
    const bad = await harness.request(LIST, { query: { sessionId: SESSION, status: 'unknown' } })
    assert.equal(bad.status, 400)
    assert.equal((await jsonOf(bad)).error.code, 'request/invalid-query')
    const all = await listOf(harness)
    assert.deepEqual(all.items.map((item) => item.updatedAt), [
      '2026-02-01T04:00:00.000Z',
      '2026-02-01T03:00:00.000Z',
      '2026-02-01T02:00:00.000Z',
      '2026-02-01T01:00:00.000Z',
    ])
  } finally {
    await harness.cleanup()
  }
})
