/**
 * Opening context of the work-item viewer.
 *
 * One browser tab can have at most one viewer open; the right-rail list writes
 * the context and asks the host layout to select the main panel. The store is a
 * tiny external store so the panel component re-renders when the context
 * changes (or closes), with no global state library.
 */
/** The `{sessionId, artifactId}` pair the viewer was opened with. */
export interface WorkItemOpenContext {
  readonly sessionId: string
  readonly artifactId: string
}

/** One store snapshot; `context: null` means no viewer is open. */
export interface WorkItemStoreSnapshot {
  readonly context: WorkItemOpenContext | null
}

/** External store for the open work item. */
export class WorkItemOpenStore {
  private snapshot: WorkItemStoreSnapshot = { context: null }
  private readonly listeners = new Set<() => void>()

  /** Open one work item, or refresh the context when it is already open. */
  open(context: WorkItemOpenContext): void {
    if (
      this.snapshot.context !== null
      && this.snapshot.context.sessionId === context.sessionId
      && this.snapshot.context.artifactId === context.artifactId
    ) {
      return
    }
    this.snapshot = { context }
    this.emit()
  }

  /** Close the viewer; the work item itself is untouched. */
  close(): void {
    if (this.snapshot.context === null) return
    this.snapshot = { context: null }
    this.emit()
  }

  /** Current stable snapshot. */
  getSnapshot(): WorkItemStoreSnapshot {
    return this.snapshot
  }

  /** Subscribe one listener; the returned function unsubscribes it. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/** The plugin's single open-work-item store. */
export const workItemOpenStore = new WorkItemOpenStore()
