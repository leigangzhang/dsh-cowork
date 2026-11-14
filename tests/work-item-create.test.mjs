import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import './support/ts-hook.mjs'

/**
 * The M10 work-item creation flow and its head capture: a real temporary
 * directory layout with a fake git runner and a fake store port, so every
 * clone, rollback and lock-race path runs without a host or a real git. The
 * pure model lives in `work-item-model.test.mjs`; the tool and merge flow in
 * `work-item-merge.test.mjs`.
 */
const { captureWorkItemHead, createWorkItem, workItemView } = await import('../src/domains/isolation/work-item.ts')
const { workItemCheckoutPaths } = await import('../src/domains/isolation/checkout.ts')

const CREATED_AT = new Date('2026-11-08T00:00:00.000Z')
const UPDATED_AT = new Date('2026-11-08T02:00:00.000Z')
const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)

/** One work item as the index stores it. */
const item = (overrides = {}) => ({
  workItemId: 'wi-1',
  topicId: 'session-topic',
  path: '/repo/.dsh-cowork/workitems/wi-1',
  branch: 'cowork/wi-1',
  baseCommit: BASE,
  headCommit: BASE,
  status: 'active',
  createdAt: CREATED_AT.toISOString(),
  updatedAt: CREATED_AT.toISOString(),
  ...overrides,
})

/** A document-shaped object carrying work items. */
const document = (...workItems) => ({ workItems })
// ---------------------------------------------------------------------------
// creation flow: temp repository + fake git runner + fake store port
// ---------------------------------------------------------------------------

/** A real temporary repository root; cleanup is registered on the test. */
function makeRepo(t) {
  const repo = mkdtempSync(join(tmpdir(), 'cowork-work-item-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  return realpathSync(repo)
}

/** A git result with an optional stdout. */
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })

/** A failing git result. */
const failed = (stderr = 'boom', code = 1) => ({ code, stdout: '', stderr })

/**
 * Fake GitRunner: records every (args, cwd) pair and answers from a queue.
 * A queued function receives { args, cwd }, so `cloneOk` can create the
 * directory the real `git clone --local` would have created.
 */
function makeGit(...responses) {
  const calls = []
  let next = 0
  const runGit = async (args, cwd) => {
    calls.push({ args: [...args], cwd })
    if (next >= responses.length) throw new Error(`unexpected git call: git ${args.join(' ')}`)
    const response = responses[next++]
    const value = typeof response === 'function' ? response({ args, cwd }) : response
    return { code: 0, stdout: '', stderr: '', ...value }
  }
  return { calls, runGit }
}

/** The response a successful `git clone --local <repo> <target>` would leave. */
const cloneOk = () => ({ args }) => {
  mkdirSync(args[3], { recursive: true })
  return ok('')
}

/**
 * Fake store port: one in-memory v2 document, recorded activity events, and
 * queued failures. `mutateSeesExtra` simulates a concurrent writer whose row
 * only appears inside the lock (the duplicate race `createWorkItem` guards).
 */
function fakeStore(document, options = {}) {
  const state = {
    document,
    mutations: 0,
    events: [],
    mutateFailures: [...(options.mutateFailures ?? [])],
    activityError: options.activityError ?? null,
  }
  const seenDocument = () =>
    options.mutateSeesExtra === undefined
      ? state.document
      : { ...state.document, workItems: [...state.document.workItems, ...options.mutateSeesExtra] }
  return {
    state,
    store: {
      async readIndexDocument() {
        return state.document
      },
      async mutateIndexDocument(mutator) {
        state.mutations += 1
        const failure = state.mutateFailures.shift()
        if (failure) throw new Error(failure)
        const next = mutator(seenDocument())
        if (next !== null) state.document = next
        return state.document
      },
      async appendActivity(event) {
        if (state.activityError !== null) throw new Error(state.activityError)
        state.events.push(event)
      },
    },
  }
}

/** One v2 topic record; the fake store does not validate, but keep it honest. */
const topicRecord = (overrides = {}) => ({
  topicId: 'session-topic',
  title: 'Topic',
  status: 'active',
  awaitingReview: false,
  blocked: false,
  scope: '',
  ownedPaths: [],
  aliases: [],
  digest: '',
  cwd: '/repo',
  legacyCheckoutPath: null,
  createdAt: CREATED_AT.toISOString(),
  updatedAt: CREATED_AT.toISOString(),
  lastActiveAt: CREATED_AT.toISOString(),
  lastDeliveryConfirmedAt: null,
  resolvedAt: null,
  resolvedBy: null,
  ...overrides,
})

/** A minimal canonical v2 document. */
const projectDocument = (overrides = {}) => ({
  version: 2,
  projectId: 'proj-1',
  masterSessionId: 'master-session',
  createdAt: CREATED_AT.toISOString(),
  topics: [topicRecord()],
  workItems: [],
  ...overrides,
})

/** The dependency bag `createWorkItem`/`captureWorkItemHead` receive. */
const depsFor = (store, git, overrides = {}) => ({
  runGit: git.runGit,
  store,
  now: () => CREATED_AT,
  newWorkItemId: () => 'wi-generated',
  ...overrides,
})

/** One stored work-item record pointing at its canonical clone path. */
const storedWorkItem = (repo, overrides = {}) => {
  const workItemId = overrides.workItemId ?? 'wi-1'
  const paths = workItemCheckoutPaths(repo, workItemId)
  return {
    workItemId,
    topicId: 'session-topic',
    path: paths.path,
    branch: paths.branch,
    baseCommit: BASE,
    headCommit: BASE,
    status: 'active',
    createdAt: CREATED_AT.toISOString(),
    updatedAt: CREATED_AT.toISOString(),
    ...overrides,
  }
}

test('createWorkItem clones, writes the active record, and records the activity', async (t) => {
  const repo = makeRepo(t)
  const paths = workItemCheckoutPaths(repo, 'wi-1')
  const git = makeGit(ok(`${BASE}\n`), cloneOk(), ok(''))
  const { store, state } = fakeStore(projectDocument())

  const result = await createWorkItem(depsFor(store, git), {
    repoPath: repo,
    topicId: 'session-topic',
    workItemId: 'wi-1',
    isolationProvider: 'clone',
  })

  const record = {
    workItemId: 'wi-1',
    topicId: 'session-topic',
    path: paths.path,
    branch: 'cowork/wi-1',
    baseCommit: BASE,
    headCommit: BASE,
    status: 'active',
    createdAt: CREATED_AT.toISOString(),
    updatedAt: CREATED_AT.toISOString(),
  }
  assert.deepEqual(result, { ok: true, workItem: workItemView(record) })
  assert.deepEqual(state.document.workItems, [record])
  assert.equal(existsSync(paths.path), true)
  assert.equal(state.mutations, 1)

  assert.equal(state.events.length, 1)
  const [event] = state.events
  assert.equal(typeof event.eventId, 'string')
  assert.equal(event.time, CREATED_AT.toISOString())
  assert.equal(event.type, 'work-item-created')
  assert.equal(event.topicId, 'session-topic')
  assert.equal(event.summary, 'created work item wi-1')
  assert.deepEqual(event.details, {
    workItemId: 'wi-1',
    topicId: 'session-topic',
    path: paths.path,
    branch: 'cowork/wi-1',
    baseCommit: BASE,
  })

  assert.deepEqual(git.calls, [
    { args: ['rev-parse', '--verify', 'HEAD^{commit}'], cwd: repo },
    { args: ['clone', '--local', repo, paths.path], cwd: repo },
    { args: ['checkout', '-b', 'cowork/wi-1', BASE], cwd: paths.path },
  ])
})

test('createWorkItem generates the id and resolves a caller base ref', async (t) => {
  const repo = makeRepo(t)
  const paths = workItemCheckoutPaths(repo, 'wi-generated')
  const git = makeGit(ok(`${BASE}\n`), cloneOk(), ok(''))
  const { store, state } = fakeStore(projectDocument())

  const result = await createWorkItem(depsFor(store, git), {
    repoPath: repo,
    topicId: 'session-topic',
    baseRef: 'origin/main',
    isolationProvider: 'clone',
  })

  assert.equal(result.ok, true)
  assert.equal(result.workItem.workItemId, 'wi-generated')
  assert.equal(state.document.workItems[0].path, paths.path)
  assert.deepEqual(git.calls[0], {
    args: ['rev-parse', '--verify', 'origin/main^{commit}'],
    cwd: repo,
  })
})

test('createWorkItem refuses an unsupported isolation provider before any work', async (t) => {
  const repo = makeRepo(t)
  const git = makeGit()
  const { store, state } = fakeStore(projectDocument())

  const result = await createWorkItem(depsFor(store, git), {
    repoPath: repo,
    topicId: 'session-topic',
    workItemId: 'wi-1',
    isolationProvider: 'worktree',
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'workitem/provider-unsupported')
  assert.equal(git.calls.length, 0)
  assert.equal(state.mutations, 0)
  assert.equal(state.events.length, 0)
})

test('createWorkItem rejects an unusable id before any git or index read', async (t) => {
  const repo = makeRepo(t)
  const git = makeGit()
  const { store, state } = fakeStore(projectDocument())

  for (const workItemId of ['../escape', 'a/b', '', '..']) {
    const result = await createWorkItem(depsFor(store, git), {
      repoPath: repo,
      topicId: 'session-topic',
      workItemId,
      isolationProvider: 'clone',
    })
    assert.equal(result.ok, false, workItemId)
    assert.equal(result.code, 'checkout/path-guard', workItemId)
  }
  assert.equal(git.calls.length, 0)
  assert.equal(state.mutations, 0)
})

test('createWorkItem refuses a topic that is not in the index', async (t) => {
  const repo = makeRepo(t)
  const git = makeGit()
  const { store, state } = fakeStore(projectDocument({ topics: [] }))

  const result = await createWorkItem(depsFor(store, git), {
    repoPath: repo,
    topicId: 'session-missing',
    workItemId: 'wi-1',
    isolationProvider: 'clone',
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'topic/not-found')
  assert.equal(git.calls.length, 0)
  assert.equal(state.mutations, 0)
})

test('createWorkItem refuses a duplicate record or an existing clone before cloning', async (t) => {
  const repo = makeRepo(t)
  const git = makeGit()
  const { store, state } = fakeStore(projectDocument({ workItems: [storedWorkItem(repo)] }))

  const duplicate = await createWorkItem(depsFor(store, git), {
    repoPath: repo,
    topicId: 'session-topic',
    workItemId: 'wi-1',
    isolationProvider: 'clone',
  })
  assert.equal(duplicate.ok, false)
  assert.equal(duplicate.code, 'workitem/already-exists')
  assert.equal(git.calls.length, 0)
  assert.equal(state.mutations, 0)

  const paths = workItemCheckoutPaths(repo, 'wi-2')
  mkdirSync(paths.path, { recursive: true })
  const { store: secondStore, state: secondState } = fakeStore(projectDocument())
  const existing = await createWorkItem(depsFor(secondStore, git), {
    repoPath: repo,
    topicId: 'session-topic',
    workItemId: 'wi-2',
    isolationProvider: 'clone',
  })
  assert.equal(existing.ok, false)
  assert.equal(existing.code, 'workitem/already-exists')
  assert.equal(git.calls.length, 0)
  assert.equal(secondState.mutations, 0)
})

test('createWorkItem reports an unresolvable base ref without cloning', async (t) => {
  const repo = makeRepo(t)
  const git = makeGit(failed('fatal: bad revision'))
  const { store, state } = fakeStore(projectDocument())

  const result = await createWorkItem(depsFor(store, git), {
    repoPath: repo,
    topicId: 'session-topic',
    workItemId: 'wi-1',
    baseRef: 'missing-ref',
    isolationProvider: 'clone',
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'checkout/invalid-base-ref')
  assert.match(result.message, /fatal: bad revision/)
  assert.equal(git.calls.length, 1)
  assert.equal(state.mutations, 0)
  assert.equal(state.events.length, 0)
})

test('createWorkItem maps a failed clone to create-failed and reports the cleanup', async (t) => {
  const repo = makeRepo(t)
  const paths = workItemCheckoutPaths(repo, 'wi-1')
  const git = makeGit(ok(`${BASE}\n`), ({ args }) => {
    mkdirSync(args[3], { recursive: true })
    return failed('fatal: clone failed')
  })
  const { store, state } = fakeStore(projectDocument())

  const result = await createWorkItem(depsFor(store, git), {
    repoPath: repo,
    topicId: 'session-topic',
    workItemId: 'wi-1',
    isolationProvider: 'clone',
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'workitem/create-failed')
  assert.match(result.message, /fatal: clone failed/)
  assert.deepEqual(result.details.cleanup, { attempted: true, error: null })
  assert.equal(result.details.workItemId, 'wi-1')
  assert.equal(existsSync(paths.path), false)
  assert.equal(state.mutations, 0)
  assert.equal(state.events.length, 0)
})

test('createWorkItem cleans up when the work-item branch cannot be created', async (t) => {
  const repo = makeRepo(t)
  const paths = workItemCheckoutPaths(repo, 'wi-1')
  const git = makeGit(ok(`${BASE}\n`), cloneOk(), failed('fatal: invalid reference'))
  const { store, state } = fakeStore(projectDocument())

  const result = await createWorkItem(depsFor(store, git), {
    repoPath: repo,
    topicId: 'session-topic',
    workItemId: 'wi-1',
    isolationProvider: 'clone',
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'workitem/create-failed')
  assert.equal(result.details.cleanup.attempted, true)
  assert.equal(result.details.branch, 'cowork/wi-1')
  assert.equal(existsSync(paths.path), false)
  assert.equal(state.mutations, 0)
})

test('createWorkItem removes the clone and branch when the index write fails', async (t) => {
  const repo = makeRepo(t)
  const paths = workItemCheckoutPaths(repo, 'wi-1')
  const git = makeGit(
    ok(`${BASE}\n`),
    cloneOk(),
    ok(''),
    ok('refs/heads/cowork/wi-1\n'),
    ok(''),
  )
  const { store, state } = fakeStore(projectDocument(), { mutateFailures: ['store/invalid: disk full'] })

  const result = await createWorkItem(depsFor(store, git), {
    repoPath: repo,
    topicId: 'session-topic',
    workItemId: 'wi-1',
    isolationProvider: 'clone',
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'workitem/create-failed')
  assert.match(result.details.indexError, /disk full/)
  assert.deepEqual(result.details.cleanup, { removed: true, branchDeleted: true, error: null })
  assert.deepEqual(state.document.workItems, [])
  assert.equal(state.events.length, 0)
  assert.equal(existsSync(paths.path), false)
})

test('createWorkItem reports cleanup-failed when the failed index write cannot be undone', async (t) => {
  const repo = makeRepo(t)
  const git = makeGit(
    ok(`${BASE}\n`),
    cloneOk(),
    ok(''),
    ok('refs/heads/cowork/wi-1\n'),
    failed('error: cannot delete branch'),
  )
  const { store, state } = fakeStore(projectDocument(), { mutateFailures: ['store/invalid: disk full'] })

  const result = await createWorkItem(depsFor(store, git), {
    repoPath: repo,
    topicId: 'session-topic',
    workItemId: 'wi-1',
    isolationProvider: 'clone',
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'workitem/cleanup-failed')
  assert.match(result.details.cleanup.error, /cannot delete branch/)
  assert.deepEqual(state.document.workItems, [])
  assert.equal(state.events.length, 0)
})

test('createWorkItem loses a duplicate race inside the lock and removes its fresh clone', async (t) => {
  const repo = makeRepo(t)
  const paths = workItemCheckoutPaths(repo, 'wi-1')
  const git = makeGit(
    ok(`${BASE}\n`),
    cloneOk(),
    ok(''),
    ok('refs/heads/cowork/wi-1\n'),
    ok(''),
  )
  const { store, state } = fakeStore(projectDocument(), {
    mutateSeesExtra: [storedWorkItem(repo)],
  })

  const result = await createWorkItem(depsFor(store, git), {
    repoPath: repo,
    topicId: 'session-topic',
    workItemId: 'wi-1',
    isolationProvider: 'clone',
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'workitem/already-exists')
  assert.match(result.message, /concurrently/)
  assert.deepEqual(result.details.cleanup, { removed: true, branchDeleted: true, error: null })
  assert.deepEqual(state.document.workItems, [])
  assert.equal(state.events.length, 0)
  assert.equal(existsSync(paths.path), false)
})

test('createWorkItem rolls back the record and clone when the activity write fails', async (t) => {
  const repo = makeRepo(t)
  const paths = workItemCheckoutPaths(repo, 'wi-1')
  const git = makeGit(
    ok(`${BASE}\n`),
    cloneOk(),
    ok(''),
    ok('refs/heads/cowork/wi-1\n'),
    ok(''),
  )
  const { store, state } = fakeStore(projectDocument(), { activityError: 'activity sink full' })

  const result = await createWorkItem(depsFor(store, git), {
    repoPath: repo,
    topicId: 'session-topic',
    workItemId: 'wi-1',
    isolationProvider: 'clone',
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'workitem/create-failed')
  assert.match(result.details.activityError, /activity sink full/)
  assert.deepEqual(result.details.cleanup, { removed: true, branchDeleted: true, error: null })
  assert.deepEqual(state.document.workItems, [])
  assert.equal(state.events.length, 0)
  assert.equal(state.mutations, 2)
  assert.equal(existsSync(paths.path), false)
})

test('createWorkItem reports cleanup-failed when the activity rollback is itself partial', async (t) => {
  const repo = makeRepo(t)
  const git = makeGit(
    ok(`${BASE}\n`),
    cloneOk(),
    ok(''),
    ok('refs/heads/cowork/wi-1\n'),
    failed('error: cannot delete branch'),
  )
  const { store, state } = fakeStore(projectDocument(), {
    mutateFailures: [null, 'store/invalid: cannot rewrite'],
    activityError: 'activity sink full',
  })

  const result = await createWorkItem(depsFor(store, git), {
    repoPath: repo,
    topicId: 'session-topic',
    workItemId: 'wi-1',
    isolationProvider: 'clone',
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'workitem/cleanup-failed')
  assert.equal(result.details.rollbackErrors.length, 2)
  assert.match(result.details.rollbackErrors[0], /cannot rewrite/)
  assert.match(result.details.rollbackErrors[1], /cannot delete branch/)
  assert.equal(state.events.length, 0)
})

// ---------------------------------------------------------------------------
// head capture
// ---------------------------------------------------------------------------

test('captureWorkItemHead reads HEAD in the clone and moves headCommit with updatedAt', async (t) => {
  const repo = makeRepo(t)
  const paths = workItemCheckoutPaths(repo, 'wi-1')
  const git = makeGit(ok(`${HEAD}\n`))
  const { store, state } = fakeStore(projectDocument({ workItems: [storedWorkItem(repo)] }))

  const result = await captureWorkItemHead(
    { runGit: git.runGit, store, now: () => UPDATED_AT },
    { repoPath: repo, workItemId: 'wi-1' },
  )

  assert.equal(result.ok, true)
  assert.equal(result.workItem.headCommit, HEAD)
  assert.equal(result.workItem.updatedAt, UPDATED_AT.toISOString())
  assert.equal(result.workItem.createdAt, CREATED_AT.toISOString())
  assert.equal(state.document.workItems[0].headCommit, HEAD)
  assert.equal(state.document.workItems[0].updatedAt, UPDATED_AT.toISOString())
  assert.deepEqual(git.calls, [{ args: ['rev-parse', 'HEAD'], cwd: paths.path }])
})

test('captureWorkItemHead does not write when the head did not move', async (t) => {
  const repo = makeRepo(t)
  const git = makeGit(ok(`${HEAD}\n`))
  const { store, state } = fakeStore(
    projectDocument({ workItems: [storedWorkItem(repo, { headCommit: HEAD })] }),
  )

  const result = await captureWorkItemHead(
    { runGit: git.runGit, store, now: () => UPDATED_AT },
    { repoPath: repo, workItemId: 'wi-1' },
  )

  assert.equal(result.ok, true)
  assert.equal(result.workItem.headCommit, HEAD)
  assert.equal(result.workItem.updatedAt, CREATED_AT.toISOString())
  assert.equal(state.mutations, 0)
})

test('captureWorkItemHead reports a missing work item without reading git', async (t) => {
  const repo = makeRepo(t)
  const git = makeGit()
  const { store } = fakeStore(projectDocument())

  const result = await captureWorkItemHead(
    { runGit: git.runGit, store, now: () => UPDATED_AT },
    { repoPath: repo, workItemId: 'wi-missing' },
  )

  assert.equal(result.ok, false)
  assert.equal(result.code, 'workitem/not-found')
  assert.equal(git.calls.length, 0)
})

test('captureWorkItemHead refuses a record whose path is not its canonical clone', async (t) => {
  const repo = makeRepo(t)
  const git = makeGit()
  const { store, state } = fakeStore(
    projectDocument({ workItems: [storedWorkItem(repo, { path: '/elsewhere/wi-1' })] }),
  )

  const result = await captureWorkItemHead(
    { runGit: git.runGit, store, now: () => UPDATED_AT },
    { repoPath: repo, workItemId: 'wi-1' },
  )

  assert.equal(result.ok, false)
  assert.equal(result.code, 'checkout/path-guard')
  assert.match(result.message, /not its canonical clone/)
  assert.equal(git.calls.length, 0)
  assert.equal(state.mutations, 0)
})

test('captureWorkItemHead refuses an id that escapes the workitems root', async (t) => {
  const repo = makeRepo(t)
  const git = makeGit()
  const { store } = fakeStore(
    projectDocument({ workItems: [storedWorkItem(repo, { workItemId: '../escape' })] }),
  )

  const result = await captureWorkItemHead(
    { runGit: git.runGit, store, now: () => UPDATED_AT },
    { repoPath: repo, workItemId: '../escape' },
  )

  assert.equal(result.ok, false)
  assert.equal(result.code, 'checkout/path-guard')
  assert.equal(git.calls.length, 0)
})

test('captureWorkItemHead maps a git failure to checkout/git-failed without writing', async (t) => {
  const repo = makeRepo(t)
  const git = makeGit(failed('fatal: not a git repository'))
  const { store, state } = fakeStore(projectDocument({ workItems: [storedWorkItem(repo)] }))

  const result = await captureWorkItemHead(
    { runGit: git.runGit, store, now: () => UPDATED_AT },
    { repoPath: repo, workItemId: 'wi-1' },
  )

  assert.equal(result.ok, false)
  assert.equal(result.code, 'checkout/git-failed')
  assert.equal(result.details.exitCode, 1)
  assert.match(result.details.stderr, /not a git repository/)
  assert.equal(state.mutations, 0)
})

test('captureWorkItemHead accepts a symlinked repository path for a canonical record', async (t) => {
  const repo = makeRepo(t)
  const linkParent = mkdtempSync(join(tmpdir(), 'cowork-link-'))
  t.after(() => rmSync(linkParent, { recursive: true, force: true }))
  const linkedRepo = join(linkParent, 'repo-link')
  symlinkSync(repo, linkedRepo)
  const git = makeGit(ok(`${HEAD}\n`))
  const { store } = fakeStore(projectDocument({ workItems: [storedWorkItem(repo)] }))

  const result = await captureWorkItemHead(
    { runGit: git.runGit, store, now: () => UPDATED_AT },
    { repoPath: linkedRepo, workItemId: 'wi-1' },
  )

  assert.equal(result.ok, true)
  assert.equal(result.workItem.headCommit, HEAD)
  assert.equal(git.calls[0].cwd, workItemCheckoutPaths(repo, 'wi-1').path)
})
