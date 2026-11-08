import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { register } from 'node:module'

// `src/work-item.ts` imports the shared vocabularies with the build's `.js`
// specifiers, which Node's type stripping does not retry as `.ts`; this test
// installs the same small resolve hook tests/presets.test.mjs uses.
const HOOK_SOURCE = [
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier.startsWith('.') && specifier.endsWith('.js')) {",
  "    try { return await nextResolve(specifier.slice(0, -3) + '.ts', context) } catch {}",
  '  }',
  '  return nextResolve(specifier, context)',
  '}',
].join('\n')
register(`data:text/javascript,${encodeURIComponent(HOOK_SOURCE)}`)

const {
  MERGEABLE_WORK_ITEM_STATUSES,
  WORK_ITEM_STATUSES,
  activeWorkItemCount,
  buildWorkItemRecord,
  captureWorkItemHead,
  createWorkItem,
  isMergeableWorkItemStatus,
  isValidWorkItemId,
  markWorkItem,
  workItemView,
} = await import('../src/work-item.ts')
const { nodeGitRunner, workItemCheckoutPaths } = await import('../src/checkout.ts')
const { registerCheckoutTools, registerWorkItemTools } = await import('../src/checkout-tools.ts')
const { ProjectStore } = await import('../src/store.ts')
const { readCaller } = await import('../src/tool-model.ts')
const {
  buildReviewRequestRecord,
  reviewRequestFileName,
  serializeReviewRequestRecord,
  validateReviewRequestInput,
} = await import('../src/review-request.ts')

/**
 * Contract tests for the pure M10 work-item model (`src/work-item.ts`): the
 * status vocabulary, the active count a topic's "resolved" condition reads, the
 * record builder, the marker updates, and the bounded view. No clone, no git,
 * no clock.
 */

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
// vocabularies and identities
// ---------------------------------------------------------------------------

test('the work-item statuses are the four PLAN-V0.2 §4.3 states, in order', () => {
  assert.deepEqual([...WORK_ITEM_STATUSES], ['active', 'reviewing', 'merged', 'abandoned'])
  assert.deepEqual([...MERGEABLE_WORK_ITEM_STATUSES], ['reviewing'])
})

test('only reviewing work items may be merged', () => {
  assert.equal(isMergeableWorkItemStatus('reviewing'), true)
  for (const status of ['active', 'merged', 'abandoned', null, 'bogus']) {
    assert.equal(isMergeableWorkItemStatus(status), false, String(status))
  }
})

test('a work-item id is usable as a directory and branch name', () => {
  for (const valid of ['wi-1', 'wi_1.a-b', 'A'.repeat(128)]) {
    assert.equal(isValidWorkItemId(valid), true, valid)
  }
  for (const invalid of ['', 'wi 1', 'wi/1', 'wi\\1', '..', '.', 'A'.repeat(129), 42, null, undefined]) {
    assert.equal(isValidWorkItemId(invalid), false, String(invalid))
  }
})

// ---------------------------------------------------------------------------
// active counting
// ---------------------------------------------------------------------------

test('activeWorkItemCount counts active and reviewing work items of one topic', () => {
  const doc = document(
    item({ workItemId: 'wi-1', status: 'active' }),
    item({ workItemId: 'wi-2', status: 'reviewing' }),
    item({ workItemId: 'wi-3', status: 'merged' }),
    item({ workItemId: 'wi-4', status: 'abandoned' }),
    item({ workItemId: 'wi-5', topicId: 'session-other', status: 'active' }),
  )
  assert.equal(activeWorkItemCount(doc, 'session-topic'), 2)
  assert.equal(activeWorkItemCount(doc, 'session-other'), 1)
  assert.equal(activeWorkItemCount(doc, 'session-unknown'), 0)
  assert.equal(activeWorkItemCount(document(), 'session-topic'), 0)
  assert.equal(activeWorkItemCount(null, 'session-topic'), 0)
})

test('a reviewing work item keeps its topic from being resolved', () => {
  // The read point must not treat only `active` as in-flight: a topic waiting on
  // a review is still working, and resolving it has no undo.
  const doc = document(item({ status: 'reviewing' }))
  assert.ok(activeWorkItemCount(doc, 'session-topic') > 0)
})

// ---------------------------------------------------------------------------
// record builder and marker updates
// ---------------------------------------------------------------------------

test('buildWorkItemRecord stamps an active item from its base', () => {
  assert.deepEqual(
    buildWorkItemRecord(
      {
        workItemId: 'wi-1',
        topicId: 'session-topic',
        path: '/repo/.dsh-cowork/workitems/wi-1',
        branch: 'cowork/wi-1',
        baseCommit: BASE,
      },
      CREATED_AT,
    ),
    item(),
  )
})

test('buildWorkItemRecord refuses an unsafe id, path, or branch', () => {
  const opened = { workItemId: 'wi-1', topicId: 'session-topic', path: '/repo/workitems/wi-1', branch: 'cowork/wi-1', baseCommit: BASE }
  assert.throws(() => buildWorkItemRecord({ ...opened, workItemId: '../wi' }, CREATED_AT), TypeError)
  assert.throws(() => buildWorkItemRecord({ ...opened, path: '' }, CREATED_AT), TypeError)
  assert.throws(() => buildWorkItemRecord({ ...opened, branch: '' }, CREATED_AT), TypeError)
})

test('markWorkItem stamps updatedAt and the new head, keeping the rest', () => {
  const marked = markWorkItem(item(), { status: 'reviewing', headCommit: HEAD }, UPDATED_AT)
  assert.deepEqual(marked, item({ status: 'reviewing', headCommit: HEAD, updatedAt: UPDATED_AT.toISOString() }))

  // A status-only update keeps the head; a head-only update keeps the status.
  const statusOnly = markWorkItem(item({ headCommit: HEAD }), { status: 'merged' }, UPDATED_AT)
  assert.equal(statusOnly.status, 'merged')
  assert.equal(statusOnly.headCommit, HEAD)
  const headOnly = markWorkItem(item(), { headCommit: HEAD }, UPDATED_AT)
  assert.equal(headOnly.status, 'active')
  assert.equal(headOnly.headCommit, HEAD)
  assert.equal(headOnly.updatedAt, UPDATED_AT.toISOString())
})

test('markWorkItem refuses an invalid status or an empty head', () => {
  assert.throws(() => markWorkItem(item(), { status: 'bogus' }, UPDATED_AT), TypeError)
  assert.throws(() => markWorkItem(item(), { headCommit: '' }, UPDATED_AT), TypeError)
})

// ---------------------------------------------------------------------------
// bounded view
// ---------------------------------------------------------------------------

test('workItemView carries the fixed field set of a work item', () => {
  assert.deepEqual(workItemView(item({ headCommit: HEAD })), {
    workItemId: 'wi-1',
    topicId: 'session-topic',
    path: '/repo/.dsh-cowork/workitems/wi-1',
    branch: 'cowork/wi-1',
    baseCommit: BASE,
    headCommit: HEAD,
    status: 'active',
    createdAt: CREATED_AT.toISOString(),
    updatedAt: CREATED_AT.toISOString(),
  })
})

test('workItemView cuts a path or branch that would blow the status budget', () => {
  const longPath = `/repo/${'d'.repeat(5000)}`
  const longBranch = 'b'.repeat(5000)
  const view = workItemView(item({ path: longPath, branch: longBranch }))
  assert.ok(view.path.length <= 1024, `path is ${view.path.length} chars`)
  assert.ok(view.branch.length <= 256, `branch is ${view.branch.length} chars`)
  assert.ok(!view.path.includes('d'.repeat(2000)))
})

// ---------------------------------------------------------------------------
// purity
// ---------------------------------------------------------------------------

test('src/work-item.ts keeps host, clock, and raw filesystem I/O out of itself', () => {
  const source = readFileSync(new URL('../src/work-item.ts', import.meta.url), 'utf8')
  // The creation flow now reuses src/checkout.ts for git and cleanup, so the
  // checkout import is expected; what must stay out is everything the injected
  // ports exist to provide.
  for (const forbidden of [/node:fs/, /node:child_process/, /from '\.\/store\.js'/, /Math\.random/, /new Date\(/, /process\./]) {
    assert.equal(forbidden.test(source), false, `work-item.ts must not contain ${forbidden}`)
  }
  for (const forbidden of [/rmSync\(/, /mkdirSync\(/, /writeFileSync\(/]) {
    assert.equal(forbidden.test(source), false, `work-item.ts must go through checkout.ts, not ${forbidden}`)
  }
  assert.match(source, /from '\.\/checkout\.js'/)
})

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

// ---------------------------------------------------------------------------
// the work-item tool surface (M10.2b)
// ---------------------------------------------------------------------------

const TOOL_NOW = new Date('2026-11-08T04:00:00.000Z')

/** Run git synchronously in a test repository; throws on a non-zero exit. */
function gitSync(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/**
 * A real temporary repository with one commit on `main` and an `integration`
 * branch checked out: the tool merges into the checked-out branch, and main is
 * protected, so every merge test starts here.
 */
function initGitProject(t) {
  const repo = makeRepo(t)
  gitSync(repo, ['init', '-q'])
  gitSync(repo, ['config', 'user.email', 'cowork-test@example.invalid'])
  gitSync(repo, ['config', 'user.name', 'Cowork Test'])
  writeFileSync(join(repo, '.gitignore'), '.dsh-cowork/\n')
  writeFileSync(join(repo, 'app.ts'), 'export const value = 1\n')
  gitSync(repo, ['add', '.gitignore', 'app.ts'])
  gitSync(repo, ['commit', '-q', '-m', 'base'])
  gitSync(repo, ['checkout', '-q', '-b', 'integration'])
  return { repo, base: gitSync(repo, ['rev-parse', 'HEAD']) }
}

/** A clone at the canonical work-item path, with one commit on cowork/<id>. */
function makeWorkItemClone(repo, workItemId, base) {
  const path = join(repo, '.dsh-cowork', 'workitems', workItemId)
  mkdirSync(dirname(path), { recursive: true })
  gitSync(repo, ['clone', '-q', '--local', repo, path])
  gitSync(path, ['checkout', '-q', '-b', `cowork/${workItemId}`, base])
  writeFileSync(join(path, 'work.ts'), 'export const work = 1\n')
  gitSync(path, ['add', 'work.ts'])
  gitSync(path, ['commit', '-q', '-m', 'work item change'])
  return { path, head: gitSync(path, ['rev-parse', 'HEAD']) }
}

/** Commit one more change inside the clone (moves its head). */
function commitInClone(path, file, content) {
  writeFileSync(join(path, file), content)
  gitSync(path, ['add', file])
  gitSync(path, ['commit', '-q', '-m', `change ${file}`])
  return gitSync(path, ['rev-parse', 'HEAD'])
}

/** A canonical v2 topic. */
function toolTopic(repo, overrides = {}) {
  const stamp = TOOL_NOW.toISOString()
  return {
    topicId: 'session-topic',
    title: 'wire the work item',
    status: 'active',
    awaitingReview: false,
    blocked: false,
    scope: '',
    ownedPaths: [],
    aliases: [],
    digest: '',
    cwd: repo,
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
    ...overrides,
  }
}

/** A canonical v2 work item. */
function toolWorkItem(repo, base, overrides = {}) {
  const stamp = TOOL_NOW.toISOString()
  return {
    workItemId: 'wi-1',
    topicId: 'session-topic',
    path: join(repo, '.dsh-cowork', 'workitems', 'wi-1'),
    branch: 'cowork/wi-1',
    baseCommit: base,
    headCommit: base,
    status: 'reviewing',
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  }
}

/** Seed the canonical index for one project. */
async function seedToolStore(repo, options = {}) {
  const store = new ProjectStore({ repoPath: repo, clock: () => TOOL_NOW })
  await store.initIndex('session-master')
  await store.mutateIndexDocument((doc) => ({
    ...doc,
    topics: options.topics ?? [toolTopic(repo)],
    workItems: options.workItems ?? [],
  }))
  return store
}

/** A tool registry that keeps every definition the assembly registers. */
function toolHost() {
  const registry = new Map()
  return {
    registry,
    tools: {
      register(definition) {
        registry.set(definition.name, definition)
        return () => registry.delete(definition.name)
      },
    },
  }
}

/** The structured execution identity one tool call receives. */
function toolExec(sessionId, cwd) {
  return { agent: { id: sessionId, session: { header: { cwd } } } }
}

/** The host ports a tool call needs, recorded so tests can assert on them. */
function toolDeps(overrides = {}) {
  const calls = []
  const deps = {
    sessionController: {
      list: async () => ({ items: [] }),
    },
    workspaceRegistry: {
      resolveByPath: async (path) => overrides.workspaceId === undefined
        ? undefined
        : { id: overrides.workspaceId, path },
      create: async () => ({ id: 'workspace-created', path: '/repo' }),
      delete: async (id) => {
        calls.push({ type: 'delete-workspace', id })
        return true
      },
      archiveSession: async (id, options) => {
        calls.push({ type: 'archive-session', id, options })
      },
    },
    agentPresets: { register: async () => async () => {} },
    clock: () => TOOL_NOW,
    ...overrides.extra,
  }
  return { deps, calls }
}

/** Register both isolation tools against one dependency bag. */
function registerToolSet(deps) {
  const host = toolHost()
  registerWorkItemTools(host, deps)
  registerCheckoutTools(host, deps)
  return { create: host.registry.get('cowork_work_item_create'), merge: host.registry.get('cowork_checkout_merge') }
}

/** Write one stored review request for the work item. */
function writeStoredRequest(repo, options = {}) {
  const workItemId = options.workItemId ?? 'wi-1'
  const itemPath = join(repo, '.dsh-cowork', 'workitems', workItemId)
  const scope = {
    topicId: 'session-topic',
    workItemId,
    repoPath: repo,
    workItemPath: itemPath,
    branch: `cowork/${workItemId}`,
    changedPaths: ['work.ts'],
  }
  const input = {
    purpose: 'review the work item change',
    baseCommit: options.baseCommit,
    headCommit: options.headCommit,
    path: itemPath,
    verification: [{ command: 'git diff --stat', exitCode: 0, evidence: 'work.ts changed' }],
  }
  const validated = validateReviewRequestInput(input, scope)
  assert.equal(validated.ok, true, JSON.stringify(validated.ok ? {} : validated.errors))
  const pending = buildReviewRequestRecord(validated.value, {
    requestId: options.requestId ?? 'req-1',
    reviewerSessionId: 'session-reviewer',
    requestedAt: TOOL_NOW,
  })
  const status = options.status ?? 'pass'
  const record = status === 'pending'
    ? pending
    : {
        ...pending,
        status,
        reviewedAt: TOOL_NOW.toISOString(),
        summary: 'reviewed',
        findings: status === 'pass'
          ? []
          : [{ id: 'F1', severity: 'medium', problem: 'p', requiredFix: 'f' }],
      }
  const directory = join(repo, '.dsh-cowork', 'reviews')
  mkdirSync(directory, { recursive: true })
  const fileName = reviewRequestFileName('session-topic', record.requestId)
  writeFileSync(join(directory, fileName), serializeReviewRequestRecord(record))
  return record
}

/** A mergeable project: clone + reviewing record + passed request for its head. */
async function seedMergeableProject(t, options = {}) {
  const { repo, base } = initGitProject(t)
  const clone = makeWorkItemClone(repo, 'wi-1', base)
  const store = await seedToolStore(repo, {
    workItems: [toolWorkItem(repo, base, {
      headCommit: clone.head,
      status: options.workItemStatus ?? 'reviewing',
    })],
  })
  if (options.request !== false) {
    writeStoredRequest(repo, {
      baseCommit: base,
      headCommit: clone.head,
      status: options.requestStatus ?? 'pass',
    })
  }
  return { repo, base, clone, store }
}

// --- work_item_create -------------------------------------------------------

test('cowork_work_item_create clones, records, and activates a work item', async (t) => {
  const { repo, base } = initGitProject(t)
  const store = await seedToolStore(repo)
  const { deps } = toolDeps()
  const tools = registerToolSet(deps)

  const result = await tools.create.execute({}, toolExec('session-topic', repo))

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.match(result.workItemId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal(result.topicId, 'session-topic')
  assert.equal(result.path, join(repo, '.dsh-cowork', 'workitems', result.workItemId))
  assert.equal(result.branch, `cowork/${result.workItemId}`)
  assert.equal(result.baseCommit, base)
  assert.equal(result.status, 'active')
  assert.equal(existsSync(result.path), true, 'the clone exists on disk')

  const document = await store.readIndexDocument()
  const row = document.workItems.find((entry) => entry.workItemId === result.workItemId)
  assert.equal(row.status, 'active')
  assert.equal(row.baseCommit, base)
  assert.equal(row.headCommit, base)
  assert.equal(row.topicId, 'session-topic')

  const activity = await store.readActivity()
  assert.ok(activity.events.some(
    (event) => event.type === 'work-item-created' && event.details.workItemId === result.workItemId,
  ))
})

test('the master must name an existing topic; a topic creates only for itself', async (t) => {
  const { repo } = initGitProject(t)
  await seedToolStore(repo)
  const { deps } = toolDeps()
  const tools = registerToolSet(deps)

  const noTopic = await tools.create.execute({}, toolExec('session-master', repo))
  assert.equal(noTopic.ok, false)
  assert.equal(noTopic.error.code, 'workitem/create-failed')
  assert.match(noTopic.error.message, /must pass the topicId/)

  const unknownTopic = await tools.create.execute({ topicId: 'session-missing' }, toolExec('session-master', repo))
  assert.equal(unknownTopic.ok, false)
  assert.equal(unknownTopic.error.code, 'topic/not-found')

  const foreignTopic = await tools.create.execute({ topicId: 'session-other' }, toolExec('session-topic', repo))
  assert.equal(foreignTopic.ok, false)
  assert.equal(foreignTopic.error.code, 'role/forbidden')

  const stranger = await tools.create.execute({}, toolExec('session-stranger', repo))
  assert.equal(stranger.ok, false)
  assert.equal(stranger.error.code, 'role/forbidden')

  // The master names the topic explicitly and succeeds.
  const created = await tools.create.execute({ topicId: 'session-topic' }, toolExec('session-master', repo))
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal(created.topicId, 'session-topic')
})

test('an unsupported isolation provider is refused before any work', async (t) => {
  const { repo } = initGitProject(t)
  await seedToolStore(repo)
  const { deps } = toolDeps()
  const tools = registerToolSet({ ...deps, isolationProvider: 'worktree' })

  const result = await tools.create.execute({}, toolExec('session-topic', repo))

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'workitem/provider-unsupported')
  assert.equal(existsSync(join(repo, '.dsh-cowork', 'workitems')), false)
})

test('a duplicate work-item id is refused without a second clone', async (t) => {
  const { repo, base } = initGitProject(t)
  await seedToolStore(repo, {
    workItems: [toolWorkItem(repo, base, {
      workItemId: 'wi-fixed',
      path: join(repo, '.dsh-cowork', 'workitems', 'wi-fixed'),
      branch: 'cowork/wi-fixed',
    })],
  })
  const { deps } = toolDeps()
  const tools = registerToolSet({ ...deps, newWorkItemId: () => 'wi-fixed' })

  const result = await tools.create.execute({}, toolExec('session-topic', repo))

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'workitem/already-exists')
  assert.equal(existsSync(join(repo, '.dsh-cowork', 'workitems', 'wi-fixed')), false)
})

test('an unusable generated id is refused before any clone', async (t) => {
  const { repo } = initGitProject(t)
  const store = await seedToolStore(repo)
  const { deps } = toolDeps()
  const tools = registerToolSet({ ...deps, newWorkItemId: () => '../wi' })

  const result = await tools.create.execute({}, toolExec('session-topic', repo))

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'checkout/path-guard')
  const document = await store.readIndexDocument()
  assert.deepEqual(document.workItems, [])
  assert.equal(existsSync(join(repo, '.dsh-cowork', 'workitems')), false)
})

test('a clone failure leaves no clone and no index record', async (t) => {
  const { repo } = initGitProject(t)
  const store = await seedToolStore(repo)
  const { deps } = toolDeps()
  const tools = registerToolSet({
    ...deps,
    runGit: async (args, cwd) => (args[0] === 'clone'
      ? { code: 128, stdout: '', stderr: 'clone refused by the test' }
      : nodeGitRunner(args, cwd)),
  })

  const result = await tools.create.execute({}, toolExec('session-topic', repo))

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'workitem/create-failed')
  assert.match(result.error.message, /clone refused by the test/)
  const document = await store.readIndexDocument()
  assert.deepEqual(document.workItems, [])
  const workitemsDir = join(repo, '.dsh-cowork', 'workitems')
  assert.deepEqual(existsSync(workitemsDir) ? readdirNames(workitemsDir) : [], [])
})

/** Names inside a directory ([] when it is missing). */
function readdirNames(directory) {
  try {
    return execFileSync('ls', ['-A', directory], { encoding: 'utf8' }).split('\n').filter((name) => name !== '')
  } catch {
    return []
  }
}

// --- checkout_merge on a work item -----------------------------------------

test('a passed work item merges into the current branch and is torn down', async (t) => {
  const { repo, clone, store } = await seedMergeableProject(t)
  const { deps } = toolDeps({ workspaceId: 'workspace-1' })
  const tools = registerToolSet(deps)

  const result = await tools.merge.execute({ workItemId: 'wi-1' }, toolExec('session-master', repo))

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.merged, true)
  assert.equal(result.workItemId, 'wi-1')
  assert.equal(result.headCommit, clone.head)
  assert.equal(result.reviewRequestId, 'req-1')
  assert.deepEqual(result.cleanupErrors, [])
  assert.equal(result.cleanup.removed, true)
  assert.equal(result.cleanup.branchDeleted, true)
  assert.equal(result.cleanup.workspaceId, 'workspace-1')
  assert.equal(result.workItem.status, 'merged')

  // The merge landed on the checked-out branch, not on main.
  assert.equal(gitSync(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'integration')
  assert.equal(existsSync(join(repo, 'work.ts')), true)
  assert.throws(() => gitSync(repo, ['rev-parse', '--verify', 'refs/heads/cowork/wi-1']))

  // The clone is gone, and the index says merged.
  assert.equal(existsSync(clone.path), false)
  const document = await store.readIndexDocument()
  assert.equal(document.workItems[0].status, 'merged')
  assert.equal(document.workItems[0].headCommit, clone.head)

  const activity = await store.readActivity()
  assert.ok(activity.events.some(
    (event) => event.type === 'work-item-merged' && event.details.workItemId === 'wi-1',
  ))
})

test('a head that moved after the review is refused without merging', async (t) => {
  const { repo, base, clone } = await seedMergeableProject(t)
  const moved = commitInClone(clone.path, 'later.ts', 'export const later = 1\n')
  const { deps } = toolDeps()
  const tools = registerToolSet(deps)

  const result = await tools.merge.execute({ workItemId: 'wi-1' }, toolExec('session-master', repo))

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'checkout/head-mismatch')
  assert.deepEqual(result.error.details.reviewedHeads, [clone.head])
  assert.equal(result.error.details.headCommit, moved)
  assert.equal(existsSync(join(repo, 'work.ts')), false, 'nothing was merged')
  assert.equal(existsSync(clone.path), true, 'the clone stays')
})

test('a work item without a passed review cannot be merged', async (t) => {
  for (const request of [false, 'pending']) {
    const { repo } = await seedMergeableProject(t, request === false ? { request: false } : { requestStatus: 'pending' })
    const { deps } = toolDeps()
    const tools = registerToolSet(deps)

    const result = await tools.merge.execute({ workItemId: 'wi-1' }, toolExec('session-master', repo))

    assert.equal(result.ok, false, String(request))
    assert.equal(result.error.code, 'review/not-passed')
    assert.equal(existsSync(join(repo, 'work.ts')), false)
  }
})

test('a dirty work-item clone is refused before the merge', async (t) => {
  const { repo, clone } = await seedMergeableProject(t)
  writeFileSync(join(clone.path, 'uncommitted.ts'), 'export const wip = 1\n')
  const { deps } = toolDeps()
  const tools = registerToolSet(deps)

  const result = await tools.merge.execute({ workItemId: 'wi-1' }, toolExec('session-master', repo))

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'review/dirty-worktree')
  assert.equal(existsSync(join(repo, 'work.ts')), false)
})

test('main and a detached HEAD are protected merge targets', async (t) => {
  for (const checkout of [['checkout', '-q', 'main'], ['checkout', '-q', '--detach']]) {
    const { repo } = await seedMergeableProject(t)
    gitSync(repo, checkout)
    const { deps } = toolDeps()
    const tools = registerToolSet(deps)

    const result = await tools.merge.execute({ workItemId: 'wi-1' }, toolExec('session-master', repo))

    assert.equal(result.ok, false, checkout.join(' '))
    assert.equal(result.error.code, 'checkout/protected-branch')
    assert.equal(existsSync(join(repo, 'work.ts')), false)
  }
})

test('a conflicting merge keeps the clone and reports the conflict files', async (t) => {
  const { repo, clone } = await seedMergeableProject(t)
  writeFileSync(join(repo, 'work.ts'), 'export const conflict = 2\n')
  gitSync(repo, ['add', 'work.ts'])
  gitSync(repo, ['commit', '-q', '-m', 'conflicting change'])
  const { deps } = toolDeps()
  const tools = registerToolSet(deps)

  const result = await tools.merge.execute({ workItemId: 'wi-1' }, toolExec('session-master', repo))

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'checkout/merge-conflict')
  assert.deepEqual(result.error.details.conflictFiles, ['work.ts'])
  assert.equal(result.error.details.conflictFilesTotal, 1)
  assert.equal(result.error.details.status, 'reviewing')
  assert.equal(existsSync(clone.path), true, 'the clone is kept for the resolution')
  // The failed merge was aborted; the repository is not left mid-merge.
  assert.throws(() => gitSync(repo, ['rev-parse', '--verify', '-q', 'MERGE_HEAD']))
  assert.equal(gitSync(repo, ['status', '--porcelain']), '')
})

test('a cleanup failure is reported without failing the finished merge', async (t) => {
  const { repo } = await seedMergeableProject(t)
  const { deps } = toolDeps()
  const tools = registerToolSet({
    ...deps,
    runGit: async (args, cwd) => (args[0] === 'branch' && args[1] === '-D'
      ? { code: 1, stdout: '', stderr: 'branch cannot be deleted' }
      : nodeGitRunner(args, cwd)),
  })

  const result = await tools.merge.execute({ workItemId: 'wi-1' }, toolExec('session-master', repo))

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.merged, true)
  // The directory removal and the branch deletion are one domain outcome: the
  // failed branch delete is reported in cleanupErrors, and the merge stands.
  assert.equal(result.cleanup.removed, false)
  assert.equal(result.cleanup.branchDeleted, false)
  assert.ok(
    result.cleanupErrors.some((entry) => entry.includes('branch cannot be deleted')),
    JSON.stringify(result.cleanupErrors),
  )
  assert.equal(result.workItem.status, 'merged')
  assert.equal(existsSync(join(repo, 'work.ts')), true)
})

test('the merge gate refuses unknown, non-reviewing, and non-master work items', async (t) => {
  {
    const { repo } = await seedMergeableProject(t)
    const { deps } = toolDeps()
    const tools = registerToolSet(deps)
    const missing = await tools.merge.execute({ workItemId: 'wi-404' }, toolExec('session-master', repo))
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'workitem/not-found')
  }
  {
    const { repo } = await seedMergeableProject(t, { workItemStatus: 'active' })
    const { deps } = toolDeps()
    const tools = registerToolSet(deps)
    const notReady = await tools.merge.execute({ workItemId: 'wi-1' }, toolExec('session-master', repo))
    assert.equal(notReady.ok, false)
    assert.equal(notReady.error.code, 'workitem/not-ready')
  }
  {
    const { repo } = await seedMergeableProject(t)
    const { deps } = toolDeps()
    const tools = registerToolSet(deps)
    const denied = await tools.merge.execute({ workItemId: 'wi-1' }, toolExec('session-topic', repo))
    assert.equal(denied.ok, false)
    assert.equal(denied.error.code, 'role/forbidden')
  }
  {
    const { repo } = await seedMergeableProject(t)
    const { deps } = toolDeps()
    const tools = registerToolSet(deps)
    const noSelector = await tools.merge.execute({}, toolExec('session-master', repo))
    assert.equal(noSelector.ok, false)
    assert.equal(noSelector.error.code, 'checkout/not-ready')
  }
})

test('the work-item id wins over the deprecated threadId', async (t) => {
  const { repo } = await seedMergeableProject(t)
  const { deps } = toolDeps()
  const tools = registerToolSet(deps)

  const result = await tools.merge.execute(
    { workItemId: 'wi-1', threadId: 'legacy-thread' },
    toolExec('session-master', repo),
  )

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.workItemId, 'wi-1')
})
