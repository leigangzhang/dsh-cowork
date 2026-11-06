/**
 * Post-merge teardown of one thread's isolated clone, as an ordered step list.
 *
 * Once `git merge` has landed, the merge cannot be taken back: a clone that
 * fails to delete, a workspace the registry refuses to drop, or a session that
 * will not archive are all *cleanup* problems. Turning them into a failed tool
 * result would tell the model the branch was not merged while it actually was,
 * and the retry would then merge twice. So every step is caught on its own, the
 * error text is collected, and the index update — the step that clears
 * `checkoutPath` — always runs last, whatever happened before it.
 *
 * The module deliberately imports nothing: the host services arrive as ports,
 * so this orchestration runs under `node --test` with recording fakes and no
 * DSH host, no `@deepseek-ai/dsh-tools` and no git.
 */

/** What one teardown left behind, reported as the tool's `cleanup` payload. */
export interface MergeCleanup {
  removed: boolean
  branchDeleted: boolean
  workspaceId: string | null
  workspaceDeleted: boolean
  sessionArchived: boolean
}

/** The checkout module's removal outcome, narrowed to what teardown needs. */
export type CheckoutRemoval =
  | { ok: true; removed: boolean; branchDeleted: boolean }
  | { ok: false; message: string }

/**
 * Host services, as functions. `updateThread` is the index write that drops
 * `checkoutPath` and marks the thread done; it is expected to run even when the
 * steps above it failed, and it receives the id rather than a path so the
 * caller can rebuild its own store handle.
 */
export interface MergeTeardownPorts<TThread> {
  resolveWorkspace(path: string): Promise<{ id: string } | undefined>
  removeCheckout(): Promise<CheckoutRemoval>
  deleteWorkspace(workspaceId: string): Promise<boolean>
  archiveSession(threadId: string): Promise<void>
  updateThread(threadId: string): Promise<{ thread: TThread | null }>
}

export interface MergeTeardownPlan {
  checkoutPath: string
  threadId: string
}

export interface MergeTeardownResult<TThread> {
  cleanup: MergeCleanup
  /** One entry per failed step, prefixed with the step name; empty on a clean run. */
  cleanupErrors: string[]
  /** The updated index record, or null when the index write itself failed. */
  thread: TThread | null
}

/** Error text for a caught value; never a stack trace. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Tear the clone down after a successful merge.
 *
 * Fixed order, and the reason it is fixed: the workspace must be resolved
 * before the clone directory is deleted (the host canonicalises the path with
 * realpath, so a deleted path no longer matches), and the index update must be
 * last, because it is the only step that records the merge as finished.
 */
export async function teardownMergedCheckout<TThread>(
  plan: MergeTeardownPlan,
  ports: MergeTeardownPorts<TThread>,
): Promise<MergeTeardownResult<TThread>> {
  const cleanup: MergeCleanup = {
    removed: false,
    branchDeleted: false,
    workspaceId: null,
    workspaceDeleted: false,
    sessionArchived: false,
  }
  const cleanupErrors: string[] = []

  // Resolve the workspace while the clone still exists.
  let workspaceId: string | null = null
  try {
    const workspace = await ports.resolveWorkspace(plan.checkoutPath)
    workspaceId = workspace === undefined ? null : workspace.id
  } catch (error) {
    cleanupErrors.push(`workspace lookup: ${describeError(error)}`)
  }
  cleanup.workspaceId = workspaceId

  try {
    const removed = await ports.removeCheckout()
    if (removed.ok) {
      cleanup.removed = removed.removed
      cleanup.branchDeleted = removed.branchDeleted
    } else {
      cleanupErrors.push(`checkout: ${removed.message}`)
    }
  } catch (error) {
    cleanupErrors.push(`checkout: ${describeError(error)}`)
  }

  // A workspace id we failed to resolve leaves nothing to delete; the missing
  // entry is already reported as `workspace lookup` above.
  if (workspaceId !== null) {
    try {
      cleanup.workspaceDeleted = await ports.deleteWorkspace(workspaceId)
    } catch (error) {
      cleanupErrors.push(`workspace: ${describeError(error)}`)
    }
  }

  try {
    await ports.archiveSession(plan.threadId)
    cleanup.sessionArchived = true
  } catch (error) {
    cleanupErrors.push(`session: ${describeError(error)}`)
  }

  // Last and unconditional: the merge landed, so the index must stop claiming
  // the thread still owns a clone. A failure here is reported, never rethrown.
  let thread: TThread | null = null
  try {
    thread = (await ports.updateThread(plan.threadId)).thread
  } catch (error) {
    cleanupErrors.push(`index: ${describeError(error)}`)
  }

  return { cleanup, cleanupErrors, thread }
}

/**
 * Run one index write and report its own failure instead of letting it escape.
 *
 * The merge-conflict path uses this: the conflict result is the real answer,
 * and an index write that fails afterwards must be visible in that same
 * failure payload (`statusUpdateError`) rather than replacing it with a
 * generic internal error.
 */
export async function applyThreadStatus<TThread>(
  update: () => Promise<{ thread: TThread | null }>,
): Promise<{ thread: TThread | null; error: string | null }> {
  try {
    const updated = await update()
    return { thread: updated.thread, error: null }
  } catch (error) {
    return { thread: null, error: describeError(error) }
  }
}
