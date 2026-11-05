/**
 * Local, hand-written type surface for the Cowork panel's browser half.
 *
 * The client bundle cannot import `@deepseek-ai/dsh-client-*`: those packages are
 * host modules, not published types this repository can depend on, and the M0
 * removal took the generated client declarations with it. So the small slice of
 * the client contract the panel actually touches is restated here — the same
 * approach the wire contract in `src/api-contract.ts` takes for the host API.
 *
 * The service handles below mirror the host (DSH runtime 0.2.1-rc.2) contract:
 * `sidebarRightTabs.register({ id, kind, title, guide })`, the keyed
 * `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` slot registrations,
 * `sidebar.footer.action`, `sidebarRight.openTab(kind)`, and
 * `uiWorkspace.openSession(sessionId)`. Everything the panel needs is optional
 * except `slots`, so a host without the newer services still loads the plugin
 * and degrades to disabled actions instead of failing to apply.
 */
import { useSyncExternalStore } from 'react'
import type { ComponentType } from 'react'

/** Tab implementation identity; also the key its body and title register under. */
export const COWORK_TAB_ID = '@dsh-external/dsh-cowork/panel'

/** Tab type discriminator; what `sidebarRight.openTab` names. */
export const COWORK_TAB_KIND = 'cowork'

/** Tab chip and guide entry title. */
export const COWORK_TAB_TITLE = 'Cowork'

/** One capsule the right Sidebar guide page offers for this tab type. */
export interface GuideEntry {
  readonly id: string
  readonly order: number
  readonly title: () => string
  readonly description?: () => string
}

/** One registered right Sidebar tab type. */
export interface SidebarRightTabDefinition {
  readonly id: string
  readonly kind: string
  readonly title: () => string
  readonly guide?: readonly GuideEntry[]
}

/** Registry of tab types; calling `register` returns its disposer. */
export interface SidebarRightTabsService {
  register(definition: SidebarRightTabDefinition): () => void
}

/** The right Sidebar's navigation controller. */
export interface SidebarRightService {
  openTab(kind: string): void
}

/** Workspace navigation: selects a Session and shows its Conversation. */
export interface UiWorkspaceService {
  openSession(sessionId: string): void
}

/** Options accepted by `slots.register`; only the fields the panel uses. */
export interface SlotRegisterOptions {
  readonly name: string
  readonly key?: string
  readonly id?: string
  readonly order?: number
}

/** A slot component as the registration accepts it (props are owned by the seat). */
/** The seat owns the props, so the registration accepts the framework's shape. */
export type SlotComponent = ComponentType<any>

/** The slot framework service. */
export interface SlotsService {
  register(options: SlotRegisterOptions, component: SlotComponent): () => void
  inject(name: string, callback: () => void | (() => void)): () => void
}

/**
 * The client context the panel is applied with. Only `slots` is required: the
 * plugin's `inject` array names it, so the host guarantees it before `apply`.
 */
export interface ClientContext {
  readonly slots: SlotsService
  readonly sidebarRight?: SidebarRightService
  readonly sidebarRightTabs?: SidebarRightTabsService
  readonly uiWorkspace?: UiWorkspaceService
  /** Optional dependency injection: runs `callback` only once `services` exist. */
  inject(services: readonly string[], callback: (scope: ClientContext) => void | (() => void)): void
}

/** Props the session-scoped `sidebar.right.pane.tab` seat passes to a body. */
export interface TabBodyProps {
  readonly sessionId: string
}

/** Owner props of the `sidebar.footer.action` seat. */
export interface FooterActionOwnerProps {
  readonly wide: boolean
}

/** Normalized error the panel renders; mirrors the wire error envelope. */
export interface PanelErrorInfo {
  readonly code: string
  readonly message: string
  readonly path?: string
}

/**
 * Live handles to the optional services. The host provides them as plugins, so
 * the panel/footer read them through this tiny external store: a registered
 * component re-renders when a handle arrives (or goes away) instead of keeping
 * a stale disabled state.
 */
export interface ClientServices {
  sidebarRight?: SidebarRightService
  uiWorkspace?: UiWorkspaceService
}

let currentServices: ClientServices = {}
const listeners = new Set<() => void>()

/** Publish one service handle; `undefined` clears it on plugin disposal. */
export function setClientService<K extends keyof ClientServices>(name: K, service: ClientServices[K]): void {
  if (currentServices[name] === service) return
  currentServices = { ...currentServices, [name]: service }
  for (const listener of listeners) listener()
}

/** Current handles, stable between changes (safe for `useSyncExternalStore`). */
export function getClientServices(): ClientServices {
  return currentServices
}

/** Subscribe to handle changes. */
export function subscribeClientServices(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Read the optional service handles from a registered component. */
export function useClientServices(): ClientServices {
  return useSyncExternalStore(subscribeClientServices, getClientServices, getClientServices)
}
