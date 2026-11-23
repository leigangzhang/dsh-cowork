/**
 * Local, hand-written type surface for the Cowork panel's browser half.
 *
 * The client bundle cannot import `@deepseek-ai/dsh-client-*`: those packages are
 * host modules, not published types this repository can depend on, and the M0
 * removal took the generated client declarations with it. So the small slice of
 * the client contract the panel actually touches is restated here — the same
 * approach the wire contract in `src/panel/api-contract.ts` takes for the host API.
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
import type { ComponentType, ReactNode } from 'react'

/** Tab implementation identity; also the key its body and title register under. */
export const COWORK_TAB_ID = '@dsh-external/dsh-cowork/panel'

/** Tab type discriminator; what `sidebarRight.openTab` names. */
export const COWORK_TAB_KIND = 'cowork'

/** Tab chip and guide entry title. */
export const COWORK_TAB_TITLE = 'Cowork'

/**
 * Conversation view identity: the registered view id, its tab id, and the value
 * the host stores in `dsh.conversation.<sessionId>.view`.
 */
export const COWORK_VIEW_ID = 'cowork-work-item'

/**
 * Conversation tab label. The host has no `selectView` service, so opening the
 * view from the right rail means clicking the tab whose text equals this label;
 * the value is fixed and short so a narrow tab never truncates it.
 */
export const COWORK_VIEW_LABEL = 'Cowork'

/** Icon component a guide entry may contribute; the host supplies size and class. */
export type GuideIcon = ComponentType<{ readonly size?: number; readonly className?: string }>

/** One capsule the right Sidebar guide page offers for this tab type. */
export interface GuideEntry {
  readonly id: string
  readonly order: number
  readonly title: () => string
  readonly description?: () => string
  readonly icon?: GuideIcon
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

/** One row of the host session list; only the retention ledger is read here. */
export interface SessionListRow {
  readonly retainedBy?: Readonly<Record<string, number | undefined>>
}

/** The host `sessions.list` snapshot: ids plus their retention rows. */
export interface SessionListSnapshot {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, SessionListRow | undefined>>
}

/** Read-only snapshot source of the host session list (`sessions.list`). */
export interface SessionListSource {
  getSnapshot(): SessionListSnapshot
  subscribe(listener: () => void): () => void
}

/** The host session service slice the work-item viewer observes. */
export interface SessionsService {
  /**
   * The live session catalog. The retention ledger is how the viewer tells
   * whether a session is the one the main area is showing: `mainView > 0`.
   */
  readonly list: SessionListSource
}

/** Workspace navigation: selects a Session and shows its Conversation. */
export interface UiWorkspaceService {
  openSession(sessionId: string): void
  /**
   * Re-enables a Session the user archived by hand. Optional because only newer
   * hosts expose it; the panel uses it as a tolerance when opening a topic that
   * was already archived (the normal case needs no unarchive).
   */
  unarchiveSession?(sessionId: string): Promise<void>
}

/**
 * The host service the A2 notice contract adds (`ctx.sessionNotices`).
 * Optional because the running host (DSH 0.2.1-rc.2) does not expose it: the
 * plugin detects it and, without it, registers no conversation node (decision
 * B). The append/update shapes are the frozen A2 contract, not live here.
 */
export interface SessionNoticesService {
  append(notice: Readonly<Record<string, unknown>>): Promise<void>
  update(noticeId: string, patch: Readonly<Record<string, unknown>>): Promise<void>
}

/** Options accepted by `slots.register`; only the fields the panel uses. */
export interface SlotRegisterOptions {
  readonly name: string
  readonly key?: string
  readonly id?: string
  readonly order?: number
  /**
   * Cell shadowing rank for a keyed/single entry: ascending, default 0, and the
   * lowest rank renders. A second entry for the same key at the same rank is
   * rejected, so a replacement must pick a smaller value than the host's 0.
   */
  readonly priority?: number
  /** Node kind a conversation-chat seat matches (A2 only; unused under B). */
  readonly kind?: string
  /**
   * Tab text for a `conversation.view` entry. The host resolves a function at
   * read time, following the active locale; the value must stay short.
   */
  readonly label?: () => string
  /**
   * Props injected into a session-scoped entry. `conversation.view` receives
   * the current session id; the seat merges the result under its own props.
   */
  readonly inject?: (sessionId: string) => Readonly<Record<string, unknown>>
  /**
   * Child slots this registration renders itself. Declaring one makes the seat
   * pass the matching `renderSlot`/`renderSlotChain` prop to the component.
   */
  readonly children?: Readonly<Record<string, SlotChildDeclaration>>
}

/** One child-slot declaration carried by a keyed registration. */
export interface SlotChildDeclaration {
  readonly kind: 'single' | 'chain' | 'keyed' | 'list'
  readonly scope: 'root' | 'session' | 'session-maybe'
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
 * Payload of one durable user message; the seat hands it to the renderer as
 * `node.data`.
 *
 * The host passes a `ContentBlock[]` array, but a rendering projection may hand
 * a plain string, so the type stays open and the renderer narrows at runtime.
 * `referenceLabels`/`skillNames` come from the adjacent recall and
 * skill-invocation projections.
 */
export interface ChatUserMessageData {
  /** Durable identity; absent only in synthetic projections. */
  readonly messageId?: string
  readonly seq?: number
  /** Unix epoch ms from the source session event. */
  readonly time?: number
  readonly content?: unknown
  /** Durable message source the `conversation.chat.user.before` chain elects on. */
  readonly source?: unknown
  readonly referenceLabels?: readonly string[]
  readonly skillNames?: readonly string[]
}

/** The keyed `user` Chat node; the message payload lives under `data`. */
export interface ChatUserMessageNode {
  readonly kind: 'user'
  readonly data: ChatUserMessageData
}

/** One user-message attachment in the host content factory's display shape. */
export interface UserContentAttachmentView {
  readonly type: 'image' | 'file'
  readonly image?: unknown
  readonly file?: unknown
}

/** Prepared user contents the host `conversation.chat.user.content` factory accepts. */
export interface UserContentDataView {
  readonly text: string
  readonly attachments: readonly UserContentAttachmentView[]
  readonly extraBlocks: readonly unknown[]
  readonly referenceLabels?: readonly string[]
}

/** Render one host Component Factory occurrence (only the user-content seat is used). */
export interface RenderFactorySlotView {
  (name: string, props: Readonly<Record<string, unknown>>, options?: { readonly fallback?: ReactNode }): ReactNode
}

/** Render a declared chain child slot from a keyed node renderer. */
export interface RenderSlotChainView {
  (key: string, owner: Readonly<Record<string, unknown>>, options?: { readonly fallback?: ReactNode }): ReactNode
}

/**
 * Props the host's keyed `conversation.chat.node` seat passes to a `user`
 * renderer: the durable node, the render seats, and the shared image loader.
 * Everything is optional except `node`, so a host that omits a seat degrades to
 * the renderer's own fallback instead of throwing.
 */
export interface ChatUserNodeProps {
  readonly node: ChatUserMessageNode
  readonly renderFactorySlot?: RenderFactorySlotView
  readonly renderSlotChain?: RenderSlotChainView
  readonly loadImage?: unknown
}

/**
 * The client context the panel is applied with. Only `slots` is required: the
 * plugin's `inject` array names it, so the host guarantees it before `apply`.
 */
export interface ClientContext {
  readonly slots: SlotsService
  /** Cordis' built-in logger; optional so a minimal host still applies. */
  readonly logger?: { warn?(message: string): void }
  readonly sidebarRight?: SidebarRightService
  readonly sidebarRightTabs?: SidebarRightTabsService
  readonly uiWorkspace?: UiWorkspaceService
  readonly sessions?: SessionsService
  readonly sessionNotices?: SessionNoticesService
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
  /** Session catalog; absent hosts cannot verify "open in the owning session". */
  sessions?: SessionsService
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
