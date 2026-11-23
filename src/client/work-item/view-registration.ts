/**
 * Registration lifetime of the Cowork conversation view.
 *
 * The view exists only while a work item is open: the right-rail list writes
 * the open context, this binding registers the tab, and closing the item
 * disposes the registration so the tab disappears. The registration is
 * idempotent (one entry at a time) and its disposer is owned by the plugin
 * fiber through `slots.inject`.
 */
import {
  COWORK_VIEW_ID,
  COWORK_VIEW_LABEL,
  type SlotComponent,
  type SlotsService,
} from '../contracts.ts'
import { workItemOpenStore } from './store.ts'

/** Tab order after the host Chat (0) and trajectory (10) views. */
const COWORK_VIEW_ORDER = 20

/** Props the `conversation.view` seat injects into the viewer. */
export interface WorkItemViewProps {
  /** Session the view is rendered for; the open item's owner may differ. */
  readonly sessionId: string
}

/**
 * Bind the conversation view to the open-work-item store.
 *
 * @param slots - host slot service; the registration happens inside its
 *   `conversation.view` declaration.
 * @param view - viewer component the seat renders.
 * @returns disposer that unsubscribes and unregisters the view.
 */
export function bindWorkItemView(slots: SlotsService, view: SlotComponent): () => void {
  let dispose: (() => void) | null = null
  const sync = (): void => {
    const open = workItemOpenStore.getSnapshot().context !== null
    if (open && dispose === null) {
      dispose = slots.register({
        name: 'conversation.view',
        id: COWORK_VIEW_ID,
        order: COWORK_VIEW_ORDER,
        label: () => COWORK_VIEW_LABEL,
        inject: (sessionId: string) => ({ sessionId }),
      }, view)
      return
    }
    if (!open && dispose !== null) {
      dispose()
      dispose = null
    }
  }
  const unsubscribe = workItemOpenStore.subscribe(sync)
  sync()
  return () => {
    unsubscribe()
    dispose?.()
    dispose = null
  }
}
