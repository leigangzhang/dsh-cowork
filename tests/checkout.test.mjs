import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CHECKOUT_BRANCH_PREFIX,
  CHECKOUT_ERROR,
  CHECKOUT_ROOT_RELATIVE,
  checkoutPaths,
  createCheckout,
  inspectCheckout,
  mergeCheckout,
  removeCheckout,
} from '../src/checkout.ts'

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
