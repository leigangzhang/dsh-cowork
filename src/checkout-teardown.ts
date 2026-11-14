/**
 * Post-merge teardown of one isolated clone, as an ordered step list.
 *
 * Once `git merge` has landed, the merge cannot be taken back: a clone that
 * fails to delete, a workspace the registry refuses to drop, or a session that
 * will not archive are all *cleanup* problems. Turning them into a failed tool
 * result would tell the model the branch was not merged while it actually was,
 * and the retry would then merge twice. So every step is caught on its own, the
 * error text is collected, and the index update — the step that clears
 * `checkoutPath` — always runs last, whatever happened before it.
 *
 * A thread and a work item tear down the same way; the thread owns a session
 * and archives it, a work item owns none. `runTeardownSteps` is that one step
 * sequence, and both public functions are adapters onto it.
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

/** The cleanup counters shared by both teardowns, in their reported order. */
interface TeardownCleanup {
  removed: boolean
  branchDeleted: boolean
  workspaceId: string | null
  workspaceDeleted: boolean
}

/** The one step the thread teardown runs and a work item does not. */
interface TeardownSessionStep {
  /** Prefix for a caught error, e.g. `session`. */
  readonly label: string
  archive(): Promise<void>
}

interface TeardownStepPorts<TRecord> {
  resolveWorkspace(path: string): Promise<{ id: string } | undefined>
  removeCheckout(): Promise<CheckoutRemoval>
  deleteWorkspace(workspaceId: string): Promise<boolean>
  /** Runs after the workspace is deleted and before the index write. */
  session?: TeardownSessionStep
  updateRecord(): Promise<{ record: TRecord | null }>
}

interface TeardownStepOutcome<TRecord> {
  cleanup: TeardownCleanup
  sessionArchived: boolean
  cleanupErrors: string[]
  record: TRecord | null
}

/**
 * The teardown step sequence, once.
 *
 * Fixed order, and the reason it is fixed: the workspace must be resolved
 * before the clone directory is deleted (the host canonicalises the path with
 * realpath, so a deleted path no longer matches), and the index update must be
 * last, because it is the only step that records the merge as finished.
 */
async function runTeardownSteps<TRecord>(
  checkoutPath: string,
  ports: TeardownStepPorts<TRecord>,
): Promise<TeardownStepOutcome<TRecord>> {
  const cleanup: TeardownCleanup = {
    removed: false,
    branchDeleted: false,
    workspaceId: null,
    workspaceDeleted: false,
  }
  const cleanupErrors: string[] = []

  // Resolve the workspace while the clone still exists.
  let workspaceId: string | null = null
  try {
    const workspace = await ports.resolveWorkspace(checkoutPath)
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

  let sessionArchived = false
  if (ports.session !== undefined) {
    try {
      await ports.session.archive()
      sessionArchived = true
    } catch (error) {
      cleanupErrors.push(`${ports.session.label}: ${describeError(error)}`)
    }
  }

  // Last and unconditional: the merge landed, so the index must stop claiming
  // the clone is still there. A failure here is reported, never rethrown.
  let record: TRecord | null = null
  try {
    record = (await ports.updateRecord()).record
  } catch (error) {
    cleanupErrors.push(`index: ${describeError(error)}`)
  }

  return { cleanup, sessionArchived, cleanupErrors, record }
}

/**
 * Tear the clone down after a successful merge.
 *
 * The thread adapter onto {@link runTeardownSteps}: it adds the session archive
 * step and reports `sessionArchived` in its cleanup payload.
 */
export async function teardownMergedCheckout<TThread>(
  plan: MergeTeardownPlan,
  ports: MergeTeardownPorts<TThread>,
): Promise<MergeTeardownResult<TThread>> {
  const outcome = await runTeardownSteps(plan.checkoutPath, {
    resolveWorkspace: (path) => ports.resolveWorkspace(path),
    removeCheckout: () => ports.removeCheckout(),
    deleteWorkspace: (workspaceId) => ports.deleteWorkspace(workspaceId),
    session: { label: 'session', archive: () => ports.archiveSession(plan.threadId) },
    updateRecord: async () => ({ record: (await ports.updateThread(plan.threadId)).thread }),
  })
  return {
    cleanup: { ...outcome.cleanup, sessionArchived: outcome.sessionArchived },
    cleanupErrors: outcome.cleanupErrors,
    thread: outcome.record,
  }
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

// ---------------------------------------------------------------------------
// work-item teardown (M10.2b)
// ---------------------------------------------------------------------------

/** What one work-item teardown left behind, reported as `cleanup`. */
export interface WorkItemCleanup {
  removed: boolean
  branchDeleted: boolean
  workspaceId: string | null
  workspaceDeleted: boolean
}

/** The ports one work-item teardown needs; they match the thread teardown shape. */
export interface WorkItemTeardownPorts<TWorkItem> {
  resolveWorkspace(path: string): Promise<{ id: string } | undefined>
  removeCheckout(): Promise<CheckoutRemoval>
  deleteWorkspace(workspaceId: string): Promise<boolean>
  updateWorkItem(): Promise<{ workItem: TWorkItem | null }>
}

export interface WorkItemTeardownPlan {
  checkoutPath: string
  workItemId: string
}

export interface WorkItemTeardownResult<TWorkItem> {
  cleanup: WorkItemCleanup
  /** One entry per failed step, prefixed with the step name; empty on a clean run. */
  cleanupErrors: string[]
  /** The updated work-item view, or null when the index write itself failed. */
  workItem: TWorkItem | null
}

/**
 * Tear one work item's clone down after a successful merge.
 *
 * The same rule as {@link teardownMergedCheckout}: once the branch is merged the
 * merge cannot be taken back, so a clone that will not delete, a workspace the
 * registry refuses to drop, or an index write that fails are *cleanup*
 * problems — they are collected, never turned into a failed merge result that
 * would invite a second merge.
 *
 * A work item owns no session (execution units work in the clone without a DSH
 * session of their own), so it passes no session step: everything else is the
 * shared sequence.
 */
export async function teardownMergedWorkItem<TWorkItem>(
  plan: WorkItemTeardownPlan,
  ports: WorkItemTeardownPorts<TWorkItem>,
): Promise<WorkItemTeardownResult<TWorkItem>> {
  const outcome = await runTeardownSteps(plan.checkoutPath, {
    resolveWorkspace: (path) => ports.resolveWorkspace(path),
    removeCheckout: () => ports.removeCheckout(),
    deleteWorkspace: (workspaceId) => ports.deleteWorkspace(workspaceId),
    updateRecord: async () => ({ record: (await ports.updateWorkItem()).workItem }),
  })
  return {
    cleanup: outcome.cleanup,
    cleanupErrors: outcome.cleanupErrors,
    workItem: outcome.record,
  }
}
