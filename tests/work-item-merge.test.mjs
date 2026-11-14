import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import './support/ts-hook.mjs'

/**
 * The work-item tool surface (M10.2b): `cowork_work_item_create` and
 * `cowork_checkout_merge` driven against real temporary git repositories and
 * the canonical project store. The pure model lives in
 * `work-item-model.test.mjs`; the in-process creation flow in
 * `work-item-create.test.mjs`.
 */
const { nodeGitRunner } = await import('../src/checkout.ts')
const { registerCheckoutTools, registerWorkItemTools } = await import('../src/checkout-tools.ts')
const { ProjectStore } = await import('../src/store.ts')
const {
  buildReviewRequestRecord,
  reviewRequestFileName,
  serializeReviewRequestRecord,
  validateReviewRequestInput,
} = await import('../src/review-request.ts')

function makeRepo(t) {
  const repo = mkdtempSync(join(tmpdir(), 'cowork-work-item-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  return realpathSync(repo)
}

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
  for (const generated of ['../wi', 'wi.1']) {
    const { repo } = initGitProject(t)
    const store = await seedToolStore(repo)
    const { deps } = toolDeps()
    const tools = registerToolSet({ ...deps, newWorkItemId: () => generated })

    const result = await tools.create.execute({}, toolExec('session-topic', repo))

    assert.equal(result.ok, false, generated)
    assert.equal(result.error.code, 'checkout/path-guard', generated)
    assert.match(result.error.message, /not usable as a directory and branch name/)
    const document = await store.readIndexDocument()
    assert.deepEqual(document.workItems, [])
    assert.equal(existsSync(join(repo, '.dsh-cowork', 'workitems')), false)
  }
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
