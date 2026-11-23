/**
 * Opening context of the work-item viewer.
 *
 * One browser tab can have at most one work item open. The right-rail list
 * writes the context; the plugin's `conversation.view` binding registers the
 * Cowork tab while a context exists and unregisters it on close. The store is a
 * tiny external store so the viewer component and the tab binding re-render
 * when the context changes, with no global state library.
 */
/**
 * The open work item. `ownerSessionId` is the topic session the work item
 * belongs to and the scope every `artifact.*` call resolves its project with,
 * so a viewer opened from another session still reads the same record.
 */
export interface WorkItemOpenContext {
  readonly artifactId: string
  readonly ownerSessionId: string
}

/** One store snapshot; `context: null` means no viewer is open. */
export interface WorkItemStoreSnapshot {
  readonly context: WorkItemOpenContext | null
}

/** External store for the open work item. */
export class WorkItemOpenStore {
  private snapshot: WorkItemStoreSnapshot = { context: null }
  private readonly listeners = new Set<() => void>()

  /**
   * Open one work item, or replace the context when another is open.
   * Re-opening the same pair is a no-op and never emits.
   */
  open(context: WorkItemOpenContext): void {
    if (
      this.snapshot.context !== null
      && this.snapshot.context.ownerSessionId === context.ownerSessionId
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
