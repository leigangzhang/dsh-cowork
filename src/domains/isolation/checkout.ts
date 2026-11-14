/**
 * Isolated checkout: one local git clone per thread or work item, not a git
 * worktree.
 *
 * A thread gets its own working copy at `<repo>/.dsh-cowork/threads/<threadId>`
 * and commits there on branch `cowork/<threadId>`; a work item gets
 * `<repo>/.dsh-cowork/workitems/<workItemId>` on the same `cowork/` branch
 * prefix. Both are described by one {@link IsolationTarget}, so the operations
 * below do not know which kind of owner they serve: the legacy `threadId` input
 * is still accepted and resolves to the thread target, which keeps the M4
 * callers and their tests unchanged. The repository's own working tree is never
 * touched until `mergeCheckout` fetches that branch and merges it. A clone
 * (instead of a linked worktree) keeps each owner's HEAD, index, and working
 * tree fully private, so a dirty checkout cannot block another one.
 *
 * All git access goes through the injected {@link GitRunner}; this module has
 * no value-level imports besides Node built-ins, so it can be unit-tested with
 * a fake runner under plain `node --test`. Every failure is mapped to a stable
 * {@link CheckoutErrorCode} instead of leaking a raw exception, except for
 * {@link inspectCheckout}, whose fixed return type cannot carry an error and
 * therefore documents a conservative degradation instead.
 *
 * Commands are always argument arrays with an explicit cwd and a timeout:
 * thread ids and repository paths are untrusted input, and a shell string
 * would turn either into command injection.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Result of one git invocation. Non-zero exits are values, not exceptions. */
export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

/** Runs git with an argument array in an explicit working directory. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitResult>

/** Directory (relative to the repository root) that holds thread clones. */
export const CHECKOUT_ROOT_RELATIVE = '.dsh-cowork/threads'

/** Directory (relative to the repository root) that holds work-item clones. */
export const WORK_ITEM_ROOT_RELATIVE = '.dsh-cowork/workitems'

/** Branch prefix for a checkout's private commits. */
export const CHECKOUT_BRANCH_PREFIX = 'cowork/'

/** Branch prefix for a work item's private commits (same namespace as threads). */
export const WORK_ITEM_BRANCH_PREFIX = CHECKOUT_BRANCH_PREFIX

/**
 * Isolation provider this module implements. `src/platform/tool-runtime.ts` owns the
 * configured default; M10 implements `clone` only and `src/domains/isolation/work-item.ts`
 * refuses every other value instead of silently falling back.
 */
export const CLONE_ISOLATION_PROVIDER = 'clone'

/** Timeout for one git invocation. No git call is retried automatically. */
export const GIT_TIMEOUT_MS = 30_000

/** Ids become path segments and branch suffixes, so keep them narrow. */
const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]+$/

/** Branch names this module is willing to create or delete. */
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

/** Upper bound on captured git output; a runaway diff should fail, not OOM. */
const GIT_MAX_BUFFER = 8 * 1024 * 1024

/**
 * Upper bound on stderr copied into an outcome's `details`.
 *
 * Failure details travel to a model-facing tool result, so a verbose git error
 * must never become an unbounded string. Anything longer is truncated and
 * marked; the marker is part of the value, so a reader cannot mistake a clipped
 * message for the complete one.
 */
export const STDERR_DETAIL_LIMIT = 2000

/** The branch a fresh checkout starts from unless the caller names another. */
const DEFAULT_BASE_REF = 'HEAD'

/** Default merge commit message prefix; the thread id is appended. */
const DEFAULT_MERGE_MESSAGE_PREFIX = 'cowork: merge '

/** Git ignores a trailing `-q` only when it follows `--verify`; keep it separate. */
const MERGE_HEAD_REF = 'MERGE_HEAD'

/** Mode for directories this module creates. */
const DIR_MODE = 0o700

/** The paths and branch a thread id maps to. */
export interface CheckoutPaths {
  repoPath: string
  threadId: string
  path: string
  branch: string
}

/** The paths and branch a work-item id maps to. */
export interface WorkItemCheckoutPaths {
  repoPath: string
  workItemId: string
  path: string
  branch: string
}

/**
 * One isolation target: the id that names the clone, the directory under the
 * repository root that holds it, and the branch prefix it commits on. Making
 * this a value (instead of a thread-only signature) is what lets M10 add work
 * items without a second clone implementation.
 */
export interface IsolationTarget {
  id: string
  rootRelative: string
  branchPrefix: string
}

/** Map a thread id to its isolation target (the M4 default). */
export function threadIsolationTarget(threadId: string): IsolationTarget {
  return { id: threadId, rootRelative: CHECKOUT_ROOT_RELATIVE, branchPrefix: CHECKOUT_BRANCH_PREFIX }
}

/** Map a work-item id to its isolation target. */
export function workItemIsolationTarget(workItemId: string): IsolationTarget {
  return { id: workItemId, rootRelative: WORK_ITEM_ROOT_RELATIVE, branchPrefix: WORK_ITEM_BRANCH_PREFIX }
}

/**
 * Map a repository path and thread id to the checkout's location and branch.
 * Pure: no filesystem access, no validation (see the path guard used by the
 * operations). `repoPath` is resolved to an absolute path so the result does
 * not depend on the caller's cwd.
 */
export function checkoutPaths(repoPath: string, threadId: string): CheckoutPaths {
  const root = resolve(repoPath)
  return {
    repoPath: root,
    threadId,
    path: join(root, CHECKOUT_ROOT_RELATIVE, threadId),
    branch: `${CHECKOUT_BRANCH_PREFIX}${threadId}`,
  }
}

/**
 * Map a repository path and work-item id to the clone's location and branch.
 * Pure, like {@link checkoutPaths}; validation happens in the path guard.
 */
export function workItemCheckoutPaths(repoPath: string, workItemId: string): WorkItemCheckoutPaths {
  const root = resolve(repoPath)
  return {
    repoPath: root,
    workItemId,
    path: join(root, WORK_ITEM_ROOT_RELATIVE, workItemId),
    branch: `${WORK_ITEM_BRANCH_PREFIX}${workItemId}`,
  }
}

/** Stable error codes callers can branch on without parsing messages. */
export const CHECKOUT_ERROR = {
  notFound: 'checkout/not-found',
  alreadyExists: 'checkout/already-exists',
  createFailed: 'checkout/create-failed',
  invalidBaseRef: 'checkout/invalid-base-ref',
  pathGuard: 'checkout/path-guard',
  dirty: 'checkout/dirty',
  mergeConflict: 'checkout/merge-conflict',
  mergeFailed: 'checkout/merge-failed',
  gitFailed: 'checkout/git-failed',
} as const

/** Union of every value in {@link CHECKOUT_ERROR}. */
export type CheckoutErrorCode = (typeof CHECKOUT_ERROR)[keyof typeof CHECKOUT_ERROR]

/** Discriminated result of a checkout operation. */
export type CheckoutOutcome<T> =
  | ({ ok: true } & T)
  | { ok: false; code: CheckoutErrorCode; message: string; details?: Record<string, unknown> }

/** Injected git runner; the only I/O this module performs through git. */
export interface CheckoutDeps {
  runGit: GitRunner
}

/** What one thread checkout currently looks like. */
export interface CheckoutStatus {
  exists: boolean
  dirty: boolean
  branch: string | null
  head: string | null
  commitsAhead: number | null
}

/** Successful path-guard resolution of one isolation target. */
export interface IsolationTargetSuccess {
  ok: true
  /** Target the resolution was for (id, root, branch prefix). */
  target: IsolationTarget
  repoPath: string
  rootPath: string
  checkoutPath: string
  branch: string
}

/** Rejected path-guard resolution; no git command may run after this. */
export interface IsolationTargetFailure {
  ok: false
  message: string
}

/** Result of {@link resolveIsolationTarget}: a guarded checkout or the reason. */
export type IsolationTargetResolution = IsolationTargetSuccess | IsolationTargetFailure

/**
 * Everything the checkout operations accept instead of a bare thread id: either
 * the legacy `threadId` (resolved to the thread target) or an explicit
 * {@link IsolationTarget}. Exactly one of the two must be present.
 */
export interface CheckoutTargetSelector {
  repoPath: string
  /** Legacy thread id; resolves to the thread target when `target` is absent. */
  threadId?: string
  /** Explicit isolation target (work items, future providers). */
  target?: IsolationTarget
}

/** Why the checkout was cleaned up after a failed step (best effort). */
function removeCheckoutDir(path: string): string | null {
  try {
    rmSync(path, { recursive: true, force: true })
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** Resolve a path that may not exist yet: realpath when possible, else resolve. */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** Whether `child` lives strictly below `parent` (both absolute, no trailing sep). */
function isStrictlyInside(parent: string, child: string): boolean {
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
}

/**
 * Validate one isolation target and prove both its root directory and (when it
 * already exists) the checkout itself stay inside that root.
 *
 * The repository root is canonicalised first, so a symlinked repository path
 * still resolves to one stable location. The target root must not itself be a
 * symlink pointing elsewhere: otherwise a clone would silently land outside
 * the project. An existing checkout is realpath-checked for the same reason.
 * The root is also required to stay below the repository root, so a target
 * cannot name `../..` as its root; the id and branch are pattern-checked before
 * either becomes a path segment or a git ref.
 */
function guardTarget(repoPath: string, target: IsolationTarget): IsolationTargetResolution {
  if (!TARGET_ID_PATTERN.test(target.id)) {
    return {
      ok: false,
      message: `isolation target id "${target.id}" must match [A-Za-z0-9_-]+`,
    }
  }

  const repoRoot = canonicalPath(repoPath)
  const rootRelative = target.rootRelative
  if (rootRelative.trim() === '' || isAbsolute(rootRelative)) {
    return {
      ok: false,
      message: `isolation root "${rootRelative}" must be a relative directory below the repository root`,
    }
  }
  const rootPath = join(repoRoot, rootRelative)
  if (rootPath === repoRoot || !isStrictlyInside(repoRoot, rootPath)) {
    return {
      ok: false,
      message: `isolation root "${rootRelative}" escapes the repository root (${rootPath})`,
    }
  }
  const rootReal = canonicalPath(rootPath)
  if (rootReal !== rootPath) {
    return {
      ok: false,
      message: `checkout root ${rootPath} resolves outside its expected location (${rootReal})`,
    }
  }

  const branch = `${target.branchPrefix}${target.id}`
  if (!BRANCH_PATTERN.test(branch) || branch.includes('..')) {
    return { ok: false, message: `isolation branch "${branch}" is not a usable branch name` }
  }

  const checkoutPath = join(rootPath, target.id)
  if (existsSync(checkoutPath)) {
    const checkoutReal = canonicalPath(checkoutPath)
    if (!isStrictlyInside(rootPath, checkoutReal)) {
      return {
        ok: false,
        message: `checkout ${checkoutPath} resolves outside the ${rootRelative} root (${checkoutReal})`,
      }
    }
  }

  return { ok: true, target, repoPath: repoRoot, rootPath, checkoutPath, branch }
}

/** Resolve the selector to exactly one target; both or neither is a path error. */
function selectTarget(input: CheckoutTargetSelector): { ok: true; target: IsolationTarget } | IsolationTargetFailure {
  if (input.target !== undefined) {
    if (input.threadId !== undefined) {
      return { ok: false, message: 'pass either threadId or target, not both' }
    }
    return { ok: true, target: input.target }
  }
  if (input.threadId !== undefined) {
    return { ok: true, target: threadIsolationTarget(input.threadId) }
  }
  return { ok: false, message: 'threadId or target is required' }
}

/**
 * Resolve one target's clone path and branch under the path guard, without
 * touching git. `src/domains/isolation/work-item.ts` uses this to read inside a work item's clone
 * with the same canonical/realpath rules every checkout operation applies.
 */
export function resolveIsolationTarget(
  repoPath: string,
  target: IsolationTarget,
): IsolationTargetResolution {
  return guardTarget(repoPath, target)
}

/** Message of an unknown thrown value, for outcomes that map a real error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** stderr bounded for `details`, with an explicit marker when text was dropped. */
function detailStderr(stderr: string): { stderr: string; stderrTruncated: boolean } {
  const text = stderr.trim()
  if (text.length <= STDERR_DETAIL_LIMIT) return { stderr: text, stderrTruncated: false }
  const dropped = text.length - STDERR_DETAIL_LIMIT
  return {
    stderr: `${text.slice(0, STDERR_DETAIL_LIMIT)}…[truncated ${dropped} chars]`,
    stderrTruncated: true,
  }
}

/** Human-readable stderr, never an empty string and never unbounded. */
function describeFailure(result: GitResult): string {
  const stderr = detailStderr(result.stderr).stderr
  return stderr.length > 0 ? stderr : `git exited with code ${result.code}`
}

/** Build a path-guard failure outcome for an operation with an outcome type. */
function pathGuardFailure(
  message: string,
  target: IsolationTarget | null,
): CheckoutOutcome<never> {
  return {
    ok: false,
    code: CHECKOUT_ERROR.pathGuard,
    message,
    details: target === null ? {} : { targetId: target.id, rootRelative: target.rootRelative },
  }
}

/**
 * Resolve the selector and run the path guard for one operation. Every git
 * command of every operation runs after this returns success.
 */
function resolveGuarded(
  input: CheckoutTargetSelector,
): { ok: true; guard: IsolationTargetSuccess } | { ok: false; target: IsolationTarget | null; message: string } {
  const selected = selectTarget(input)
  if (!selected.ok) return { ok: false, target: null, message: selected.message }
  const guard = guardTarget(input.repoPath, selected.target)
  if (!guard.ok) return { ok: false, target: selected.target, message: guard.message }
  return { ok: true, guard }
}

/**
 * Create one target's clone from `baseRef` and switch it to the target branch.
 *
 * Order is load-bearing: guard → existing check → resolve the base ref in the
 * source repository → create the parent directory → clone → create the target
 * branch. The base ref is resolved to a commit before cloning so the checkout
 * is pinned to one commit even if the ref moves mid-flight. Any failure after
 * the clone starts removes the directory this function created; the source
 * repository is never modified.
 */
export async function createCheckout(
  deps: CheckoutDeps,
  input: CheckoutTargetSelector & { baseRef?: string },
): Promise<CheckoutOutcome<{ path: string; branch: string; baseCommit: string }>> {
  const resolvedTarget = resolveGuarded(input)
  if (!resolvedTarget.ok) return pathGuardFailure(resolvedTarget.message, resolvedTarget.target)
  const guard = resolvedTarget.guard

  if (existsSync(guard.checkoutPath)) {
    return {
      ok: false,
      code: CHECKOUT_ERROR.alreadyExists,
      message: `checkout already exists at ${guard.checkoutPath}`,
      details: { path: guard.checkoutPath },
    }
  }

  const baseRef = input.baseRef ?? DEFAULT_BASE_REF
  const resolved = await deps.runGit(['rev-parse', '--verify', `${baseRef}^{commit}`], guard.repoPath)
  if (resolved.code !== 0) {
    return {
      ok: false,
      code: CHECKOUT_ERROR.invalidBaseRef,
      message: `cannot resolve base ref "${baseRef}": ${describeFailure(resolved)}`,
      details: { baseRef, ...detailStderr(resolved.stderr), exitCode: resolved.code },
    }
  }
  const baseCommit = resolved.stdout.trim()
  if (baseCommit.length === 0) {
    return {
      ok: false,
      code: CHECKOUT_ERROR.invalidBaseRef,
      message: `base ref "${baseRef}" resolved to an empty commit id`,
      details: { baseRef },
    }
  }

  const parentPath = dirname(guard.checkoutPath)
  try {
    mkdirSync(parentPath, { recursive: true, mode: DIR_MODE })
  } catch (error) {
    return {
      ok: false,
      code: CHECKOUT_ERROR.createFailed,
      message: `cannot create checkout directory ${parentPath}: ${messageOf(error)}`,
      details: {
        path: guard.checkoutPath,
        parentPath,
        reason: messageOf(error),
      },
    }
  }

  const cloned = await deps.runGit(
    ['clone', '--local', guard.repoPath, guard.checkoutPath],
    guard.repoPath,
  )
  if (cloned.code !== 0) {
    const cleanupError = removeCheckoutDir(guard.checkoutPath)
    return {
      ok: false,
      code: CHECKOUT_ERROR.createFailed,
      message: `git clone --local failed: ${describeFailure(cloned)}`,
      details: {
        path: guard.checkoutPath,
        ...detailStderr(cloned.stderr),
        exitCode: cloned.code,
        ...(cleanupError === null ? {} : { cleanupError }),
      },
    }
  }

  const switched = await deps.runGit(
    ['checkout', '-b', guard.branch, baseCommit],
    guard.checkoutPath,
  )
  if (switched.code !== 0) {
    const cleanupError = removeCheckoutDir(guard.checkoutPath)
    return {
      ok: false,
      code: CHECKOUT_ERROR.createFailed,
      message: `git checkout -b ${guard.branch} failed: ${describeFailure(switched)}`,
      details: {
        path: guard.checkoutPath,
        branch: guard.branch,
        ...detailStderr(switched.stderr),
        exitCode: switched.code,
        ...(cleanupError === null ? {} : { cleanupError }),
      },
    }
  }

  return { ok: true, path: guard.checkoutPath, branch: guard.branch, baseCommit }
}

/**
 * Inspect one checkout.
 *
 * This signature cannot carry an error, so git failures degrade conservatively
 * instead of throwing: a failed `status` reports `dirty: true` (assume the
 * checkout is unsafe to merge), a failed `branch`/`rev-parse` reports `null`,
 * and a failed commit count reports `null`. A missing directory is not an
 * error and reports an all-empty status. Only an invalid/path-escaping target
 * id throws, because continuing would inspect an unrelated directory.
 */
export async function inspectCheckout(
  deps: CheckoutDeps,
  input: CheckoutTargetSelector & { baseCommit?: string },
): Promise<CheckoutStatus> {
  const resolvedTarget = resolveGuarded(input)
  if (!resolvedTarget.ok) {
    throw new Error(`${CHECKOUT_ERROR.pathGuard}: ${resolvedTarget.message}`)
  }
  const guard = resolvedTarget.guard

  if (!existsSync(guard.checkoutPath)) {
    return { exists: false, dirty: false, branch: null, head: null, commitsAhead: null }
  }

  const status = await deps.runGit(['status', '--porcelain'], guard.checkoutPath)
  if (status.code !== 0) {
    return { exists: true, dirty: true, branch: null, head: null, commitsAhead: null }
  }
  const dirty = status.stdout.trim().length > 0

  const currentBranch = await deps.runGit(['branch', '--show-current'], guard.checkoutPath)
  const branch =
    currentBranch.code === 0 ? currentBranch.stdout.trim() || null : null

  const headResult = await deps.runGit(['rev-parse', 'HEAD'], guard.checkoutPath)
  const head = headResult.code === 0 ? headResult.stdout.trim() || null : null

  let commitsAhead: number | null = null
  if (input.baseCommit !== undefined) {
    const count = await deps.runGit(
      ['rev-list', '--count', `${input.baseCommit}..HEAD`],
      guard.checkoutPath,
    )
    if (count.code === 0) {
      const parsed = Number.parseInt(count.stdout.trim(), 10)
      commitsAhead = Number.isFinite(parsed) ? parsed : null
    }
  }

  return { exists: true, dirty, branch, head, commitsAhead }
}

/**
 * Fetch one target's branch into the source repository and merge it with
 * `--no-ff`. The repository's branch of the same name is recreated from the
 * checkout on every merge, so a stale branch left by an earlier interrupted
 * run is deleted first; the checkout's own branch is never touched here.
 *
 * A dirty checkout is refused before any fetch/merge. On conflict the
 * conflicted merge is aborted, the files are reported, and the thread branch
 * is kept so the thread can resolve and retry. Any other merge failure aborts
 * only when a merge is actually in progress (`MERGE_HEAD` exists), preserving
 * the repository state otherwise.
 *
 * The abort itself is checked: a failed `git merge --abort` leaves the main
 * repository mid-merge, so it is reported as {@link CHECKOUT_ERROR.gitFailed}
 * with the abort stage and both stderr values, never as a clean conflict or
 * merge failure. Every stderr copied into `details` is truncated to
 * {@link STDERR_DETAIL_LIMIT} and marked when text was dropped.
 */
export async function mergeCheckout(
  deps: CheckoutDeps,
  input: CheckoutTargetSelector & { message?: string },
): Promise<
  CheckoutOutcome<{
    merged: boolean
    commit: string | null
    conflictFiles: string[]
    branch: string
  }>
> {
  const resolvedTarget = resolveGuarded(input)
  if (!resolvedTarget.ok) return pathGuardFailure(resolvedTarget.message, resolvedTarget.target)
  const guard = resolvedTarget.guard

  if (!existsSync(guard.checkoutPath)) {
    return {
      ok: false,
      code: CHECKOUT_ERROR.notFound,
      message: `no checkout at ${guard.checkoutPath}`,
      details: { path: guard.checkoutPath },
    }
  }

  const status = await deps.runGit(['status', '--porcelain'], guard.checkoutPath)
  if (status.code !== 0) {
    return {
      ok: false,
      code: CHECKOUT_ERROR.gitFailed,
      message: `git status failed in ${guard.checkoutPath}: ${describeFailure(status)}`,
      details: { path: guard.checkoutPath, ...detailStderr(status.stderr), exitCode: status.code },
    }
  }
  if (status.stdout.trim().length > 0) {
    return {
      ok: false,
      code: CHECKOUT_ERROR.dirty,
      message: `checkout ${guard.checkoutPath} has uncommitted changes`,
      details: { path: guard.checkoutPath, status: status.stdout },
    }
  }

  const staleBranch = await deps.runGit(
    ['rev-parse', '--verify', `refs/heads/${guard.branch}`],
    guard.repoPath,
  )
  if (staleBranch.code === 0) {
    const deleted = await deps.runGit(['branch', '-D', guard.branch], guard.repoPath)
    if (deleted.code !== 0) {
      return {
        ok: false,
        code: CHECKOUT_ERROR.mergeFailed,
        message: `cannot delete stale branch ${guard.branch}: ${describeFailure(deleted)}`,
        details: { branch: guard.branch, stage: 'delete-stale-branch', ...detailStderr(deleted.stderr) },
      }
    }
  }

  const fetched = await deps.runGit(
    ['fetch', guard.checkoutPath, `+refs/heads/${guard.branch}:refs/heads/${guard.branch}`],
    guard.repoPath,
  )
  if (fetched.code !== 0) {
    return {
      ok: false,
      code: CHECKOUT_ERROR.mergeFailed,
      message: `cannot fetch ${guard.branch} from ${guard.checkoutPath}: ${describeFailure(fetched)}`,
      details: {
        branch: guard.branch,
        stage: 'fetch',
        ...detailStderr(fetched.stderr),
        exitCode: fetched.code,
      },
    }
  }

  const message =
    input.message !== undefined && input.message.length > 0
      ? input.message
      : `${DEFAULT_MERGE_MESSAGE_PREFIX}${guard.target.id}`

  const merged = await deps.runGit(
    ['merge', '--no-ff', guard.branch, '-m', message],
    guard.repoPath,
  )
  if (merged.code === 0) {
    const head = await deps.runGit(['rev-parse', 'HEAD'], guard.repoPath)
    // The merge already happened; a failed rev-parse only costs the commit id.
    const commit = head.code === 0 ? head.stdout.trim() || null : null
    return { ok: true, merged: true, commit, conflictFiles: [], branch: guard.branch }
  }

  const unmerged = await deps.runGit(
    ['diff', '--name-only', '--diff-filter=U'],
    guard.repoPath,
  )
  const conflictFiles =
    unmerged.code === 0
      ? unmerged.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      : []

  if (conflictFiles.length > 0) {
    const aborted = await deps.runGit(['merge', '--abort'], guard.repoPath)
    if (aborted.code !== 0) {
      // Reporting a conflict here would claim a cleanup that did not happen.
      const abortStderr = detailStderr(aborted.stderr)
      const mergeStderr = detailStderr(merged.stderr)
      return {
        ok: false,
        code: CHECKOUT_ERROR.gitFailed,
        message: `merge of ${guard.branch} conflicts in ${conflictFiles.length} file(s) and git merge --abort failed: ${describeFailure(aborted)}`,
        details: {
          branch: guard.branch,
          stage: 'abort',
          mergeStage: 'conflict',
          aborted: false,
          conflictFiles,
          stderr: abortStderr.stderr,
          stderrTruncated: abortStderr.stderrTruncated,
          exitCode: aborted.code,
          mergeExitCode: merged.code,
          mergeStderr: mergeStderr.stderr,
          mergeStderrTruncated: mergeStderr.stderrTruncated,
        },
      }
    }
    return {
      ok: false,
      code: CHECKOUT_ERROR.mergeConflict,
      message: `merge of ${guard.branch} conflicts in ${conflictFiles.length} file(s): ${conflictFiles.join(', ')}`,
      details: {
        branch: guard.branch,
        conflictFiles,
        ...detailStderr(merged.stderr),
        exitCode: merged.code,
      },
    }
  }

  const mergeHead = await deps.runGit(
    ['rev-parse', '--verify', '-q', MERGE_HEAD_REF],
    guard.repoPath,
  )
  const mergeInProgress = mergeHead.code === 0
  if (mergeInProgress) {
    const aborted = await deps.runGit(['merge', '--abort'], guard.repoPath)
    if (aborted.code !== 0) {
      // The merge is still in progress in the main repository; say so instead
      // of reporting a clean merge failure.
      const abortStderr = detailStderr(aborted.stderr)
      const mergeStderr = detailStderr(merged.stderr)
      return {
        ok: false,
        code: CHECKOUT_ERROR.gitFailed,
        message: `git merge --no-ff ${guard.branch} failed and git merge --abort failed: ${describeFailure(aborted)}`,
        details: {
          branch: guard.branch,
          stage: 'abort',
          mergeStage: 'merge',
          aborted: false,
          stderr: abortStderr.stderr,
          stderrTruncated: abortStderr.stderrTruncated,
          exitCode: aborted.code,
          mergeExitCode: merged.code,
          mergeStderr: mergeStderr.stderr,
          mergeStderrTruncated: mergeStderr.stderrTruncated,
        },
      }
    }
  }
  return {
    ok: false,
    code: CHECKOUT_ERROR.mergeFailed,
    message: `git merge --no-ff ${guard.branch} failed: ${describeFailure(merged)}`,
    details: {
      branch: guard.branch,
      stage: 'merge',
      aborted: mergeInProgress,
      ...detailStderr(merged.stderr),
      exitCode: merged.code,
    },
  }
}

/**
 * Remove one target's checkout directory and its repository-side branch.
 *
 * A missing directory or branch is not an error: removal is used both to clean
 * up and to assert absence, and asking twice is harmless. The path guard runs
 * first so a bad target id can never delete something outside its root.
 */
export async function removeCheckout(
  deps: CheckoutDeps,
  input: CheckoutTargetSelector,
): Promise<CheckoutOutcome<{ removed: boolean; branchDeleted: boolean }>> {
  const resolvedTarget = resolveGuarded(input)
  if (!resolvedTarget.ok) return pathGuardFailure(resolvedTarget.message, resolvedTarget.target)
  const guard = resolvedTarget.guard

  let removed = false
  if (existsSync(guard.checkoutPath)) {
    try {
      rmSync(guard.checkoutPath, { recursive: true, force: true })
      removed = true
    } catch (error) {
      return {
        ok: false,
        code: CHECKOUT_ERROR.gitFailed,
        message: `cannot remove ${guard.checkoutPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        details: { path: guard.checkoutPath },
      }
    }
  }

  const branchRef = await deps.runGit(
    ['rev-parse', '--verify', `refs/heads/${guard.branch}`],
    guard.repoPath,
  )
  let branchDeleted = false
  if (branchRef.code === 0) {
    const deleted = await deps.runGit(['branch', '-D', guard.branch], guard.repoPath)
    if (deleted.code !== 0) {
      return {
        ok: false,
        code: CHECKOUT_ERROR.gitFailed,
        message: `cannot delete branch ${guard.branch}: ${describeFailure(deleted)}`,
        details: { branch: guard.branch, ...detailStderr(deleted.stderr), exitCode: deleted.code },
      }
    }
    branchDeleted = true
  }

  return { ok: true, removed, branchDeleted }
}

/** Extract a numeric exit code from an execFile error. */
function exitCodeOf(error: unknown): number {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'number') return code
  }
  return 1
}

/**
 * Default {@link GitRunner}: `git` with an argument array, explicit cwd, a
 * 30-second timeout, and no shell. Non-zero exits and spawn failures are
 * reported as values so callers map them to checkout error codes.
 */
export const nodeGitRunner: GitRunner = (args, cwd) =>
  new Promise<GitResult>((settle) => {
    execFile(
      'git',
      [...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error === null) {
          settle({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '' })
          return
        }
        const code = exitCodeOf(error)
        settle({
          code,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr:
            typeof stderr === 'string' && stderr.length > 0 ? stderr : (error as Error).message,
        })
      },
    )
  })
