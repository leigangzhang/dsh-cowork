import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import './support/ts-hook.mjs'
import {
  CHECKOUT_BRANCH_PREFIX,
  CHECKOUT_ERROR,
  CHECKOUT_ROOT_RELATIVE,
  STDERR_DETAIL_LIMIT,
  WORK_ITEM_BRANCH_PREFIX,
  WORK_ITEM_ROOT_RELATIVE,
  checkoutPaths,
  createCheckout,
  inspectCheckout,
  mergeCheckout,
  nodeGitRunner,
  removeCheckout,
  threadIsolationTarget,
  workItemCheckoutPaths,
  workItemIsolationTarget,
} from '../src/checkout.ts'

// `src/checkout-tools.ts` imports its siblings with the build's `.js`
// specifiers, which Node's type stripping does not retry as `.ts`; this test
// installs the same small resolve hook the other tool tests use.

const { registerCheckoutTools, serializeMerge } = await import('../src/checkout-tools.ts')
const { ProjectStore } = await import('../src/store/project-store.ts')

/** A real temporary repository root; cleanup is registered on the test. */
function makeRepo(t) {
  const repo = mkdtempSync(join(tmpdir(), 'cowork-checkout-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  return realpathSync(repo)
}

/** Create the checkout directory a merge/inspect/remove test needs. */
function makeCheckout(repo, threadId) {
  const paths = checkoutPaths(repo, threadId)
  mkdirSync(paths.path, { recursive: true })
  return paths
}

/** A git result with an optional stdout. */
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })

/** A failing git result. */
const failed = (stderr = 'boom', code = 1) => ({ code, stdout: '', stderr })

/**
 * Fake GitRunner: records every (args, cwd) pair and answers from a queue.
 * A queued function receives { args, cwd } so a test can create the directory
 * a real `git clone` would have created before simulating its failure.
 */
function fakeGit(...responses) {
  const calls = []
  let next = 0
  const runGit = async (args, cwd) => {
    calls.push({ args: [...args], cwd })
    if (next >= responses.length) {
      throw new Error(`unexpected git call: git ${args.join(' ')}`)
    }
    const response = responses[next++]
    const value = typeof response === 'function' ? response({ args, cwd }) : response
    return { code: 0, stdout: '', stderr: '', ...value }
  }
  return { calls, runGit, pending: () => responses.length - next }
}

test('checkoutPaths maps a thread id to its clone path and branch', () => {
  const paths = checkoutPaths('/repo', 'thread-A_1')
  assert.deepEqual(paths, {
    repoPath: '/repo',
    threadId: 'thread-A_1',
    path: '/repo/.dsh-cowork/threads/thread-A_1',
    branch: 'cowork/thread-A_1',
  })
  assert.equal(CHECKOUT_ROOT_RELATIVE, '.dsh-cowork/threads')
  assert.equal(CHECKOUT_BRANCH_PREFIX, 'cowork/')
})

test('createCheckout resolves HEAD, clones locally, and creates the thread branch', async (t) => {
  const repo = makeRepo(t)
  const git = fakeGit(ok('abc123\n'), ok(''), ok(''))
  const target = join(repo, CHECKOUT_ROOT_RELATIVE, 't1')

  const result = await createCheckout({ runGit: git.runGit }, { repoPath: repo, threadId: 't1' })

  assert.deepEqual(result, {
    ok: true,
    path: target,
    branch: 'cowork/t1',
    baseCommit: 'abc123',
  })
  assert.deepEqual(git.calls, [
    { args: ['rev-parse', '--verify', 'HEAD^{commit}'], cwd: repo },
    { args: ['clone', '--local', repo, target], cwd: repo },
    { args: ['checkout', '-b', 'cowork/t1', 'abc123'], cwd: target },
  ])
})

test('createCheckout resolves a caller-supplied base ref to a commit', async (t) => {
  const repo = makeRepo(t)
  const git = fakeGit(ok('def456\n'), ok(''), ok(''))

  const result = await createCheckout(
    { runGit: git.runGit },
    { repoPath: repo, threadId: 't2', baseRef: 'origin/main' },
  )

  assert.equal(result.ok, true)
  assert.equal(result.baseCommit, 'def456')
  assert.deepEqual(git.calls[0], {
    args: ['rev-parse', '--verify', 'origin/main^{commit}'],
    cwd: repo,
  })
})

test('createCheckout rejects an invalid base ref without cloning', async (t) => {
  const repo = makeRepo(t)
  const git = fakeGit(failed('fatal: Needed a single revision'))

  const result = await createCheckout(
    { runGit: git.runGit },
    { repoPath: repo, threadId: 't3', baseRef: 'missing-ref' },
  )

  assert.equal(result.ok, false)
  assert.equal(result.code, CHECKOUT_ERROR.invalidBaseRef)
  assert.match(result.message, /fatal: Needed a single revision/)
  assert.equal(result.details.baseRef, 'missing-ref')
  assert.equal(git.calls.length, 1)
})

test('createCheckout refuses an existing checkout without running git', async (t) => {
  const repo = makeRepo(t)
  makeCheckout(repo, 't4')
  const git = fakeGit()

  const result = await createCheckout({ runGit: git.runGit }, { repoPath: repo, threadId: 't4' })

  assert.equal(result.ok, false)
  assert.equal(result.code, CHECKOUT_ERROR.alreadyExists)
  assert.equal(git.calls.length, 0)
})

test('createCheckout and removeCheckout reject unsafe thread ids before any git', async (t) => {
  const repo = makeRepo(t)
  for (const threadId of ['../escape', 'a/b', '', '.hidden', 'a b', 'a;rm']) {
    const git = fakeGit()

    const created = await createCheckout({ runGit: git.runGit }, { repoPath: repo, threadId })
    assert.equal(created.ok, false, threadId)
    assert.equal(created.code, CHECKOUT_ERROR.pathGuard, threadId)
    assert.equal(git.calls.length, 0, threadId)

    const removed = await removeCheckout({ runGit: git.runGit }, { repoPath: repo, threadId })
    assert.equal(removed.ok, false, threadId)
    assert.equal(removed.code, CHECKOUT_ERROR.pathGuard, threadId)
    assert.equal(git.calls.length, 0, threadId)
  }
})

test('createCheckout rejects a checkout path that realpath resolves outside the threads root', async (t) => {
  const repo = makeRepo(t)
  const outside = mkdtempSync(join(tmpdir(), 'cowork-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  const root = join(repo, CHECKOUT_ROOT_RELATIVE)
  mkdirSync(root, { recursive: true })
  symlinkSync(outside, join(root, 'escape'))

  const git = fakeGit()
  const result = await createCheckout({ runGit: git.runGit }, { repoPath: repo, threadId: 'escape' })

  assert.equal(result.ok, false)
  assert.equal(result.code, CHECKOUT_ERROR.pathGuard)
  assert.equal(git.calls.length, 0)
})

test('createCheckout cleans up when clone fails', async (t) => {
  const repo = makeRepo(t)
  const target = join(repo, CHECKOUT_ROOT_RELATIVE, 't5')
  const git = fakeGit(ok('abc123\n'), ({ args }) => {
    mkdirSync(args[3], { recursive: true })
    return failed('fatal: clone failed')
  })

  const result = await createCheckout({ runGit: git.runGit }, { repoPath: repo, threadId: 't5' })

  assert.equal(result.ok, false)
  assert.equal(result.code, CHECKOUT_ERROR.createFailed)
  assert.match(result.message, /fatal: clone failed/)
  assert.equal(result.details.stderr, 'fatal: clone failed')
  assert.equal(existsSync(target), false)
  assert.equal(git.calls.length, 2)
})

test('createCheckout cleans up when the branch checkout fails', async (t) => {
  const repo = makeRepo(t)
  const target = join(repo, CHECKOUT_ROOT_RELATIVE, 't6')
  const git = fakeGit(ok('abc123\n'), ({ args }) => {
    mkdirSync(args[3], { recursive: true })
    return ok('')
  }, failed('fatal: invalid reference: abc123'))

  const result = await createCheckout({ runGit: git.runGit }, { repoPath: repo, threadId: 't6' })

  assert.equal(result.ok, false)
  assert.equal(result.code, CHECKOUT_ERROR.createFailed)
  assert.equal(result.details.branch, 'cowork/t6')
  assert.match(result.message, /fatal: invalid reference/)
  assert.equal(existsSync(target), false)
  assert.equal(git.calls.length, 3)
})

test('inspectCheckout reports an all-empty status for a missing checkout', async (t) => {
  const repo = makeRepo(t)
  const git = fakeGit()

  const status = await inspectCheckout({ runGit: git.runGit }, { repoPath: repo, threadId: 'none' })

  assert.deepEqual(status, {
    exists: false,
    dirty: false,
    branch: null,
    head: null,
    commitsAhead: null,
  })
  assert.equal(git.calls.length, 0)
})

test('inspectCheckout reports a clean checkout and commits ahead of the base', async (t) => {
  const repo = makeRepo(t)
  const paths = makeCheckout(repo, 't7')
  const git = fakeGit(ok(''), ok('cowork/t7\n'), ok('deadbeef\n'), ok('3\n'))

  const status = await inspectCheckout(
    { runGit: git.runGit },
    { repoPath: repo, threadId: 't7', baseCommit: 'base123' },
  )

  assert.deepEqual(status, {
    exists: true,
    dirty: false,
    branch: 'cowork/t7',
    head: 'deadbeef',
    commitsAhead: 3,
  })
  assert.deepEqual(git.calls, [
    { args: ['status', '--porcelain'], cwd: paths.path },
    { args: ['branch', '--show-current'], cwd: paths.path },
    { args: ['rev-parse', 'HEAD'], cwd: paths.path },
    { args: ['rev-list', '--count', 'base123..HEAD'], cwd: paths.path },
  ])
})

test('inspectCheckout reports dirty and leaves commitsAhead null without a base', async (t) => {
  const repo = makeRepo(t)
  const paths = makeCheckout(repo, 't8')
  const git = fakeGit(ok(' M src/a.ts\n'), ok('cowork/t8\n'), ok('cafebabe\n'))

  const status = await inspectCheckout({ runGit: git.runGit }, { repoPath: repo, threadId: 't8' })

  assert.deepEqual(status, {
    exists: true,
    dirty: true,
    branch: 'cowork/t8',
    head: 'cafebabe',
    commitsAhead: null,
  })
  assert.equal(git.calls.length, 3)
  assert.equal(git.calls[0].cwd, paths.path)
})

test('inspectCheckout degrades conservatively when status fails', async (t) => {
  const repo = makeRepo(t)
  makeCheckout(repo, 't9')
  const git = fakeGit(failed('fatal: not a git repository'))

  const status = await inspectCheckout({ runGit: git.runGit }, { repoPath: repo, threadId: 't9' })

  assert.deepEqual(status, {
    exists: true,
    dirty: true,
    branch: null,
    head: null,
    commitsAhead: null,
  })
  assert.equal(git.calls.length, 1)
})

test('inspectCheckout rejects an unsafe thread id instead of inspecting outside the root', async (t) => {
  const repo = makeRepo(t)
  const git = fakeGit()

  await assert.rejects(
    inspectCheckout({ runGit: git.runGit }, { repoPath: repo, threadId: '../repo' }),
    /checkout\/path-guard/,
  )
  assert.equal(git.calls.length, 0)
})

test('mergeCheckout reports notFound for a missing checkout', async (t) => {
  const repo = makeRepo(t)
  const git = fakeGit()

  const result = await mergeCheckout({ runGit: git.runGit }, { repoPath: repo, threadId: 'gone' })

  assert.equal(result.ok, false)
  assert.equal(result.code, CHECKOUT_ERROR.notFound)
  assert.equal(git.calls.length, 0)
})

test('mergeCheckout refuses a dirty checkout without fetching or merging', async (t) => {
  const repo = makeRepo(t)
  const paths = makeCheckout(repo, 't10')
  const git = fakeGit(ok(' M README.md\n'))

  const result = await mergeCheckout({ runGit: git.runGit }, { repoPath: repo, threadId: 't10' })

  assert.equal(result.ok, false)
  assert.equal(result.code, CHECKOUT_ERROR.dirty)
  assert.equal(result.details.path, paths.path)
  assert.deepEqual(git.calls, [{ args: ['status', '--porcelain'], cwd: paths.path }])
})

test('mergeCheckout replaces a stale repo branch, fetches, and merges with the default message', async (t) => {
  const repo = makeRepo(t)
  const paths = makeCheckout(repo, 't11')
  const git = fakeGit(
    ok(''),
    ok('refs/heads/cowork/t11\n'),
    ok(''),
    ok(''),
    ok(''),
    ok('merge123\n'),
  )

  const result = await mergeCheckout({ runGit: git.runGit }, { repoPath: repo, threadId: 't11' })

  assert.deepEqual(result, {
    ok: true,
    merged: true,
    commit: 'merge123',
    conflictFiles: [],
    branch: 'cowork/t11',
  })
  assert.deepEqual(git.calls, [
    { args: ['status', '--porcelain'], cwd: paths.path },
    { args: ['rev-parse', '--verify', 'refs/heads/cowork/t11'], cwd: repo },
    { args: ['branch', '-D', 'cowork/t11'], cwd: repo },
    { args: ['fetch', paths.path, '+refs/heads/cowork/t11:refs/heads/cowork/t11'], cwd: repo },
    { args: ['merge', '--no-ff', 'cowork/t11', '-m', 'cowork: merge t11'], cwd: repo },
    { args: ['rev-parse', 'HEAD'], cwd: repo },
  ])
})

test('mergeCheckout skips branch deletion when no stale branch exists and honors a custom message', async (t) => {
  const repo = makeRepo(t)
  const paths = makeCheckout(repo, 't12')
  const git = fakeGit(ok(''), failed('', 1), ok(''), ok(''), ok('new456\n'))

  const result = await mergeCheckout(
    { runGit: git.runGit },
    { repoPath: repo, threadId: 't12', message: 'custom merge message' },
  )

  assert.deepEqual(result, {
    ok: true,
    merged: true,
    commit: 'new456',
    conflictFiles: [],
    branch: 'cowork/t12',
  })
  assert.equal(git.calls.some((call) => call.args[0] === 'branch'), false)
  assert.deepEqual(git.calls[3].args, [
    'merge',
    '--no-ff',
    'cowork/t12',
    '-m',
    'custom merge message',
  ])
  assert.equal(git.calls[3].cwd, repo)
})

test('mergeCheckout reports mergeFailed when fetch fails', async (t) => {
  const repo = makeRepo(t)
  makeCheckout(repo, 't13')
  const git = fakeGit(ok(''), failed('', 1), failed('fatal: could not fetch'))

  const result = await mergeCheckout({ runGit: git.runGit }, { repoPath: repo, threadId: 't13' })

  assert.equal(result.ok, false)
  assert.equal(result.code, CHECKOUT_ERROR.mergeFailed)
  assert.equal(result.details.stage, 'fetch')
  assert.equal(result.details.stderr, 'fatal: could not fetch')
  assert.equal(git.calls.length, 3)
  assert.equal(git.calls.some((call) => call.args[0] === 'merge'), false)
})

test('mergeCheckout aborts a conflicted merge and reports the unmerged files', async (t) => {
  const repo = makeRepo(t)
  makeCheckout(repo, 't14')
  const git = fakeGit(
    ok(''),
    failed('', 1),
    ok(''),
    failed('CONFLICT (content): Merge conflict in src/a.ts'),
    ok('src/a.ts\nsrc/b.ts\n'),
    ok(''),
  )

  const result = await mergeCheckout({ runGit: git.runGit }, { repoPath: repo, threadId: 't14' })

  assert.equal(result.ok, false)
  assert.equal(result.code, CHECKOUT_ERROR.mergeConflict)
  assert.deepEqual(result.details.conflictFiles, ['src/a.ts', 'src/b.ts'])
  assert.equal(result.details.branch, 'cowork/t14')
  assert.deepEqual(git.calls.at(-1), { args: ['merge', '--abort'], cwd: repo })
  assert.equal(git.calls.some((call) => call.args[0] === 'branch'), false)
})

test('mergeCheckout aborts a non-conflict failure only when MERGE_HEAD exists', async (t) => {
  const repo = makeRepo(t)
  makeCheckout(repo, 't15')
  const git = fakeGit(
    ok(''),
    failed('', 1),
    ok(''),
    failed('fatal: refusing to merge unrelated histories'),
    ok(''),
    ok('MERGE_HEAD\n'),
    ok(''),
  )

  const result = await mergeCheckout({ runGit: git.runGit }, { repoPath: repo, threadId: 't15' })

  assert.equal(result.ok, false)
  assert.equal(result.code, CHECKOUT_ERROR.mergeFailed)
  assert.equal(result.details.aborted, true)
  assert.deepEqual(git.calls.at(-1), { args: ['merge', '--abort'], cwd: repo })
})

test('mergeCheckout preserves the repository when no merge is in progress', async (t) => {
  const repo = makeRepo(t)
  makeCheckout(repo, 't16')
  const git = fakeGit(
    ok(''),
    failed('', 1),
    ok(''),
    failed('fatal: refusing to merge unrelated histories'),
    ok(''),
    failed('', 1),
  )

  const result = await mergeCheckout({ runGit: git.runGit }, { repoPath: repo, threadId: 't16' })

  assert.equal(result.ok, false)
  assert.equal(result.code, CHECKOUT_ERROR.mergeFailed)
  assert.equal(result.details.aborted, false)
  assert.equal(git.calls.length, 6)
  assert.equal(git.calls.some((call) => call.args[0] === 'merge' && call.args[1] === '--abort'), false)
})

test('removeCheckout deletes the directory and the repository branch', async (t) => {
  const repo = makeRepo(t)
  const paths = makeCheckout(repo, 't17')
  const git = fakeGit(ok('refs/heads/cowork/t17\n'), ok(''))

  const result = await removeCheckout({ runGit: git.runGit }, { repoPath: repo, threadId: 't17' })

  assert.deepEqual(result, { ok: true, removed: true, branchDeleted: true })
  assert.equal(existsSync(paths.path), false)
  assert.deepEqual(git.calls, [
    { args: ['rev-parse', '--verify', 'refs/heads/cowork/t17'], cwd: repo },
    { args: ['branch', '-D', 'cowork/t17'], cwd: repo },
  ])
})

test('removeCheckout reports a missing directory but still deletes the branch', async (t) => {
  const repo = makeRepo(t)
  const git = fakeGit(ok('refs/heads/cowork/t18\n'), ok(''))

  const result = await removeCheckout({ runGit: git.runGit }, { repoPath: repo, threadId: 't18' })

  assert.deepEqual(result, { ok: true, removed: false, branchDeleted: true })
})

test('removeCheckout leaves a missing branch alone and reports branchDeleted false', async (t) => {
  const repo = makeRepo(t)
  const paths = makeCheckout(repo, 't19')
  const git = fakeGit(failed('', 1))

  const result = await removeCheckout({ runGit: git.runGit }, { repoPath: repo, threadId: 't19' })

  assert.deepEqual(result, { ok: true, removed: true, branchDeleted: false })
  assert.equal(existsSync(paths.path), false)
  assert.equal(git.calls.length, 1)
})

test('removeCheckout reports gitFailed when the branch cannot be deleted', async (t) => {
  const repo = makeRepo(t)
  makeCheckout(repo, 't20')
  const git = fakeGit(ok('refs/heads/cowork/t20\n'), failed('error: cannot delete branch'))

  const result = await removeCheckout({ runGit: git.runGit }, { repoPath: repo, threadId: 't20' })

  assert.equal(result.ok, false)
  assert.equal(result.code, CHECKOUT_ERROR.gitFailed)
  assert.equal(result.details.branch, 'cowork/t20')
})

test('mergeCheckout reports gitFailed when aborting a conflicted merge fails', async (t) => {
  const repo = makeRepo(t)
  makeCheckout(repo, 't21')
  const git = fakeGit(
    ok(''),
    failed('', 1),
    ok(''),
    failed('CONFLICT (content): Merge conflict in src/a.ts'),
    ok('src/a.ts\n'),
    failed('fatal: could not abort the merge'),
  )

  const result = await mergeCheckout({ runGit: git.runGit }, { repoPath: repo, threadId: 't21' })

  assert.equal(result.ok, false)
  assert.equal(result.code, CHECKOUT_ERROR.gitFailed)
  assert.equal(result.details.stage, 'abort')
  assert.equal(result.details.mergeStage, 'conflict')
  assert.equal(result.details.aborted, false)
  assert.deepEqual(result.details.conflictFiles, ['src/a.ts'])
  assert.match(result.details.stderr, /could not abort the merge/)
  assert.match(result.message, /merge --abort failed/)
  assert.equal(result.details.exitCode, 1)
  assert.equal(result.details.mergeExitCode, 1)
  assert.match(result.details.mergeStderr, /Merge conflict in src\/a.ts/)
})

test('mergeCheckout reports gitFailed when aborting a MERGE_HEAD failure fails', async (t) => {
  const repo = makeRepo(t)
  makeCheckout(repo, 't22')
  const git = fakeGit(
    ok(''),
    failed('', 1),
    ok(''),
    failed('fatal: refusing to merge unrelated histories'),
    ok(''),
    ok('MERGE_HEAD\n'),
    failed('fatal: could not abort the merge'),
  )

  const result = await mergeCheckout({ runGit: git.runGit }, { repoPath: repo, threadId: 't22' })

  assert.equal(result.ok, false)
  assert.equal(result.code, CHECKOUT_ERROR.gitFailed)
  assert.equal(result.details.stage, 'abort')
  assert.equal(result.details.mergeStage, 'merge')
  assert.equal(result.details.aborted, false)
  assert.match(result.details.stderr, /could not abort the merge/)
  assert.match(result.details.mergeStderr, /refusing to merge unrelated histories/)
  assert.match(result.message, /merge --abort failed/)
})

test('mergeCheckout truncates oversized stderr and marks it', async (t) => {
  const repo = makeRepo(t)
  makeCheckout(repo, 't23')
  const huge = 'e'.repeat(STDERR_DETAIL_LIMIT + 500)
  const git = fakeGit(ok(''), failed('', 1), failed(huge))

  const result = await mergeCheckout({ runGit: git.runGit }, { repoPath: repo, threadId: 't23' })

  assert.equal(result.ok, false)
  assert.equal(result.code, CHECKOUT_ERROR.mergeFailed)
  assert.equal(result.details.stderrTruncated, true)
  assert.equal(result.details.stderr.length, STDERR_DETAIL_LIMIT + '…[truncated 500 chars]'.length)
  assert.match(result.details.stderr, /\[truncated 500 chars\]/)
  assert.equal(result.message.includes(huge), false)
})

test('mergeCheckout marks a short stderr as not truncated', async (t) => {
  const repo = makeRepo(t)
  makeCheckout(repo, 't24')
  const git = fakeGit(ok(''), failed('', 1), failed('fatal: short'))

  const result = await mergeCheckout({ runGit: git.runGit }, { repoPath: repo, threadId: 't24' })

  assert.equal(result.details.stderr, 'fatal: short')
  assert.equal(result.details.stderrTruncated, false)
})

test('createCheckout maps a mkdirSync failure to createFailed without throwing', async (t) => {
  const repo = makeRepo(t)
  const target = join(repo, CHECKOUT_ROOT_RELATIVE, 't25')
  // A file where the checkout root must be a directory makes mkdirSync throw.
  writeFileSync(join(repo, '.dsh-cowork'), 'not a directory\n')
  const git = fakeGit(ok('abc123\n'))

  const result = await createCheckout({ runGit: git.runGit }, { repoPath: repo, threadId: 't25' })

  assert.equal(result.ok, false)
  assert.equal(result.code, CHECKOUT_ERROR.createFailed)
  assert.equal(result.details.path, target)
  assert.equal(result.details.parentPath, join(repo, CHECKOUT_ROOT_RELATIVE))
  assert.match(result.details.reason, /ENOTDIR/)
  assert.equal(existsSync(target), false)
  assert.equal(git.calls.length, 1)
})

// ---------------------------------------------------------------------------
// isolation targets: work items share the clone implementation with threads
// ---------------------------------------------------------------------------

test('workItemCheckoutPaths maps a work-item id to its clone path and branch', () => {
  assert.deepEqual(workItemCheckoutPaths('/repo', 'wi-A_1'), {
    repoPath: '/repo',
    workItemId: 'wi-A_1',
    path: '/repo/.dsh-cowork/workitems/wi-A_1',
    branch: 'cowork/wi-A_1',
  })
  assert.equal(WORK_ITEM_ROOT_RELATIVE, '.dsh-cowork/workitems')
  assert.equal(WORK_ITEM_BRANCH_PREFIX, 'cowork/')
})

test('threadIsolationTarget keeps the M4 thread defaults', () => {
  assert.deepEqual(threadIsolationTarget('t1'), {
    id: 't1',
    rootRelative: '.dsh-cowork/threads',
    branchPrefix: 'cowork/',
  })
  assert.deepEqual(workItemIsolationTarget('wi-1'), {
    id: 'wi-1',
    rootRelative: '.dsh-cowork/workitems',
    branchPrefix: 'cowork/',
  })
})

test('createCheckout with a work-item target clones under workitems and branches cowork/<id>', async (t) => {
  const repo = makeRepo(t)
  const git = fakeGit(ok('abc123\n'), ok(''), ok(''))
  const target = join(repo, WORK_ITEM_ROOT_RELATIVE, 'wi-1')

  const result = await createCheckout(
    { runGit: git.runGit },
    { repoPath: repo, target: workItemIsolationTarget('wi-1') },
  )

  assert.deepEqual(result, {
    ok: true,
    path: target,
    branch: 'cowork/wi-1',
    baseCommit: 'abc123',
  })
  assert.deepEqual(git.calls, [
    { args: ['rev-parse', '--verify', 'HEAD^{commit}'], cwd: repo },
    { args: ['clone', '--local', repo, target], cwd: repo },
    { args: ['checkout', '-b', 'cowork/wi-1', 'abc123'], cwd: target },
  ])
})

test('an explicit thread target is the same request as the legacy threadId', async (t) => {
  const repo = makeRepo(t)
  const git = fakeGit(ok('abc123\n'), ok(''), ok(''))

  const result = await createCheckout(
    { runGit: git.runGit },
    { repoPath: repo, target: threadIsolationTarget('t1') },
  )

  assert.deepEqual(result, {
    ok: true,
    path: join(repo, CHECKOUT_ROOT_RELATIVE, 't1'),
    branch: 'cowork/t1',
    baseCommit: 'abc123',
  })
})

test('createCheckout refuses a target whose root escapes the repository', async (t) => {
  const repo = makeRepo(t)
  for (const rootRelative of ['../outside', '/tmp/outside', '', '.']) {
    const git = fakeGit()
    const result = await createCheckout(
      { runGit: git.runGit },
      { repoPath: repo, target: { id: 'wi-1', rootRelative, branchPrefix: 'cowork/' } },
    )
    assert.equal(result.ok, false, rootRelative)
    assert.equal(result.code, CHECKOUT_ERROR.pathGuard, rootRelative)
    assert.equal(git.calls.length, 0, rootRelative)
  }
})

test('checkout operations reject an invalid target id or an ambiguous selector', async (t) => {
  const repo = makeRepo(t)
  for (const target of [workItemIsolationTarget('../escape'), workItemIsolationTarget('a/b'), workItemIsolationTarget('')]) {
    const git = fakeGit()
    const created = await createCheckout({ runGit: git.runGit }, { repoPath: repo, target })
    assert.equal(created.ok, false, target.id)
    assert.equal(created.code, CHECKOUT_ERROR.pathGuard, target.id)
    assert.equal(git.calls.length, 0, target.id)
  }

  const ambiguous = await createCheckout(
    { runGit: fakeGit().runGit },
    { repoPath: repo, threadId: 't1', target: workItemIsolationTarget('wi-1') },
  )
  assert.equal(ambiguous.ok, false)
  assert.equal(ambiguous.code, CHECKOUT_ERROR.pathGuard)
  assert.match(ambiguous.message, /either threadId or target/)

  const missing = await removeCheckout({ runGit: fakeGit().runGit }, { repoPath: repo })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, CHECKOUT_ERROR.pathGuard)
  assert.match(missing.message, /threadId or target is required/)
})

test('createCheckout rejects a work-item checkout path that realpath escapes the workitems root', async (t) => {
  const repo = makeRepo(t)
  const outside = mkdtempSync(join(tmpdir(), 'cowork-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  const root = join(repo, WORK_ITEM_ROOT_RELATIVE)
  mkdirSync(root, { recursive: true })
  symlinkSync(outside, join(root, 'escape'))

  const git = fakeGit()
  const result = await createCheckout(
    { runGit: git.runGit },
    { repoPath: repo, target: workItemIsolationTarget('escape') },
  )

  assert.equal(result.ok, false)
  assert.equal(result.code, CHECKOUT_ERROR.pathGuard)
  assert.equal(git.calls.length, 0)
})

test('inspectCheckout reads a work-item clone through its target', async (t) => {
  const repo = makeRepo(t)
  const paths = workItemCheckoutPaths(repo, 'wi-2')
  mkdirSync(paths.path, { recursive: true })
  const git = fakeGit(ok(''), ok('cowork/wi-2\n'), ok('deadbeef\n'), ok('2\n'))

  const status = await inspectCheckout(
    { runGit: git.runGit },
    {
      repoPath: repo,
      target: workItemIsolationTarget('wi-2'),
      baseCommit: 'base123',
    },
  )

  assert.deepEqual(status, {
    exists: true,
    dirty: false,
    branch: 'cowork/wi-2',
    head: 'deadbeef',
    commitsAhead: 2,
  })
  assert.equal(git.calls[0].cwd, paths.path)
  assert.deepEqual(git.calls.at(-1), { args: ['rev-list', '--count', 'base123..HEAD'], cwd: paths.path })
})

test('mergeCheckout merges a work-item branch with the id in the default message', async (t) => {
  const repo = makeRepo(t)
  const paths = workItemCheckoutPaths(repo, 'wi-3')
  mkdirSync(paths.path, { recursive: true })
  const git = fakeGit(ok(''), failed('', 1), ok(''), ok(''), ok('merge789\n'))

  const result = await mergeCheckout(
    { runGit: git.runGit },
    { repoPath: repo, target: workItemIsolationTarget('wi-3') },
  )

  assert.deepEqual(result, {
    ok: true,
    merged: true,
    commit: 'merge789',
    conflictFiles: [],
    branch: 'cowork/wi-3',
  })
  assert.deepEqual(git.calls[2].args, [
    'fetch',
    paths.path,
    '+refs/heads/cowork/wi-3:refs/heads/cowork/wi-3',
  ])
  assert.deepEqual(git.calls[3].args, ['merge', '--no-ff', 'cowork/wi-3', '-m', 'cowork: merge wi-3'])
})

test('removeCheckout deletes a work-item clone and its branch through its target', async (t) => {
  const repo = makeRepo(t)
  const paths = workItemCheckoutPaths(repo, 'wi-4')
  mkdirSync(paths.path, { recursive: true })
  const git = fakeGit(ok('refs/heads/cowork/wi-4\n'), ok(''))

  const result = await removeCheckout(
    { runGit: git.runGit },
    { repoPath: repo, target: workItemIsolationTarget('wi-4') },
  )

  assert.deepEqual(result, { ok: true, removed: true, branchDeleted: true })
  assert.equal(existsSync(paths.path), false)
  assert.deepEqual(git.calls, [
    { args: ['rev-parse', '--verify', 'refs/heads/cowork/wi-4'], cwd: repo },
    { args: ['branch', '-D', 'cowork/wi-4'], cwd: repo },
  ])
})

// ---------------------------------------------------------------------------
// the merge tool: the legacy thread path and the serial queue (M10.2b)
// ---------------------------------------------------------------------------

const TOOL_NOW = new Date('2026-11-08T05:00:00.000Z')

/** Run git synchronously in a test repository; throws on a non-zero exit. */
function gitSync(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** A real repository whose `integration` branch is checked out (main is protected). */
function initLegacyProject(t) {
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

/** The legacy thread clone at `.dsh-cowork/threads/<id>` with one commit. */
function makeLegacyClone(repo, threadId, base) {
  const path = join(repo, '.dsh-cowork', 'threads', threadId)
  mkdirSync(dirname(path), { recursive: true })
  gitSync(repo, ['clone', '-q', '--local', repo, path])
  gitSync(path, ['checkout', '-q', '-b', `cowork/${threadId}`, base])
  writeFileSync(join(path, 'legacy.ts'), 'export const legacy = 1\n')
  gitSync(path, ['add', 'legacy.ts'])
  gitSync(path, ['commit', '-q', '-m', 'legacy change'])
  return path
}

/** A v2 topic that the legacy view still exposes as a thread. */
function legacyTopic(repo, overrides = {}) {
  const stamp = TOOL_NOW.toISOString()
  return {
    topicId: 'legacy-1',
    title: 'legacy thread',
    status: 'resolved',
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
    resolvedAt: stamp,
    resolvedBy: 'master',
    latestReviewRequestId: null,
    reviewStatus: 'pass',
    reviewerSessionId: null,
    ...overrides,
  }
}

/** Seed the canonical index with one topic that maps to a legacy thread. */
async function seedLegacyStore(repo, topic) {
  const store = new ProjectStore({ repoPath: repo, clock: () => TOOL_NOW })
  await store.initIndex('session-master')
  await store.mutateIndexDocument((doc) => ({ ...doc, topics: [topic], workItems: [] }))
  return store
}

/** The tool registry a tool call goes through. */
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

/** Host ports for the legacy merge, recording workspace and session cleanup. */
function legacyDeps(overrides = {}) {
  const calls = []
  return {
    calls,
    deps: {
      sessionController: { list: async () => ({ items: [] }) },
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
    },
  }
}

/** Register the merge tool against one dependency bag. */
function registerMergeTool(deps) {
  const host = toolHost()
  registerCheckoutTools(host, deps)
  return host.registry.get('cowork_checkout_merge')
}

test('the merge tool schema no longer accepts an unreviewed override', async () => {
  const { deps } = legacyDeps()
  const tool = registerMergeTool(deps)
  const properties = tool.parameters.properties
  assert.equal('allowUnreviewed' in properties, false)
  assert.equal('overrideReason' in properties, false)
  assert.deepEqual(Object.keys(properties).sort(), ['message', 'threadId', 'workItemId'])
})

test('a legacy thread clone with a passed review merges and is torn down', async (t) => {
  const { repo, base } = initLegacyProject(t)
  const clonePath = makeLegacyClone(repo, 'legacy-1', base)
  await seedLegacyStore(repo, legacyTopic(repo, { legacyCheckoutPath: clonePath }))
  const { deps, calls } = legacyDeps({ workspaceId: 'workspace-legacy' })

  const result = await registerMergeTool(deps).execute({ threadId: 'legacy-1' }, toolExec('session-master', repo))

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.merged, true)
  assert.equal(result.threadId, 'legacy-1')
  assert.deepEqual(result.cleanupErrors, [])
  assert.equal(result.cleanup.removed, true)
  assert.equal(result.cleanup.branchDeleted, true)
  assert.equal(result.cleanup.sessionArchived, true)
  assert.equal(result.cleanup.workspaceDeleted, true)
  assert.equal(result.thread.checkoutPath, null)
  assert.equal(result.thread.status, 'done')

  assert.equal(gitSync(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'integration')
  assert.equal(existsSync(join(repo, 'legacy.ts')), true)
  assert.equal(existsSync(clonePath), false)
  assert.throws(() => gitSync(repo, ['rev-parse', '--verify', 'refs/heads/cowork/legacy-1']))
  assert.deepEqual(
    calls.filter((call) => call.type === 'archive-session').map((call) => call.id),
    ['legacy-1'],
  )
})

test('a legacy thread without a passed review is refused, with or without a reason', async (t) => {
  for (const reviewStatus of ['pending', 'needs_revision', null]) {
    const { repo, base } = initLegacyProject(t)
    const clonePath = makeLegacyClone(repo, 'legacy-1', base)
    await seedLegacyStore(repo, legacyTopic(repo, { legacyCheckoutPath: clonePath, reviewStatus }))
    const { deps } = legacyDeps()

    // The historical override arguments are gone; the extra keys are ignored.
    const result = await registerMergeTool(deps).execute(
      { threadId: 'legacy-1', allowUnreviewed: true, overrideReason: 'hotfix' },
      toolExec('session-master', repo),
    )

    assert.equal(result.ok, false, String(reviewStatus))
    assert.equal(result.error.code, 'review/not-passed')
    assert.equal(existsSync(join(repo, 'legacy.ts')), false)
    assert.equal(existsSync(clonePath), true)
  }
})

test('a legacy thread clone on main is refused as a protected branch', async (t) => {
  const { repo, base } = initLegacyProject(t)
  const clonePath = makeLegacyClone(repo, 'legacy-1', base)
  await seedLegacyStore(repo, legacyTopic(repo, { legacyCheckoutPath: clonePath }))
  gitSync(repo, ['checkout', '-q', 'main'])
  const { deps } = legacyDeps()

  const result = await registerMergeTool(deps).execute({ threadId: 'legacy-1' }, toolExec('session-master', repo))

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'checkout/protected-branch')
  assert.equal(result.error.details.branch, 'main')
  assert.equal(existsSync(join(repo, 'legacy.ts')), false)
})

test('the merge tool is master only', async (t) => {
  const { repo, base } = initLegacyProject(t)
  const clonePath = makeLegacyClone(repo, 'legacy-1', base)
  await seedLegacyStore(repo, legacyTopic(repo, { legacyCheckoutPath: clonePath }))
  const { deps } = legacyDeps()

  const result = await registerMergeTool(deps).execute({ threadId: 'legacy-1' }, toolExec('legacy-1', repo))

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'role/forbidden')
})

test('serializeMerge runs merges in order and survives a rejected operation', async () => {
  const order = []
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })

  const first = serializeMerge(async () => {
    order.push('first:start')
    await firstGate
    order.push('first:end')
    return 'first'
  })
  await Promise.resolve()
  const second = serializeMerge(async () => {
    order.push('second:start')
    return 'second'
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(order, ['first:start'], 'the second merge waits for the first')

  releaseFirst()
  assert.equal(await first, 'first')
  assert.equal(await second, 'second')
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start'])

  // A rejected merge does not poison the queue.
  await assert.rejects(
    serializeMerge(async () => { throw new Error('merge refused') }),
    /merge refused/,
  )
  assert.equal(await serializeMerge(async () => 'after-failure'), 'after-failure')
})
