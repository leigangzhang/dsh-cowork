/**
 * Cowork panel — browser half entry.
 *
 * Registers the right-Sidebar `Cowork` tab type, its body and chip title, the
 * bottom-bar entry and the guide capsule. `slots` is declared because the host's
 * static precheck and cordis both require it before `apply` may touch
 * `ctx.slots`; every newer service is injected optionally so a host without
 * them still loads the plugin and only degrades the affected action.
 *
 * The session notice node (host A2) is feature-detected: DSH 0.2.1-rc.2 has no
 * `ctx.sessionNotices`, so no node is registered (decision B) and the topic page
 * keeps no in-list reminder cards.
 */
import { ensurePanelStyles } from './styles.ts'
import { ensureWorkItemStyles } from './work-item/styles.ts'
import { WorkItemViewer } from './work-item/panel.tsx'
import { CoworkColorGlyph, CoworkFooterAction, CoworkPanel, CoworkPanelTitle } from './panel.tsx'
import { registerNoticeRenderer } from './notice.tsx'
import {
  COWORK_TAB_ID,
  COWORK_TAB_KIND,
  COWORK_TAB_TITLE,
  setClientService,
  type ClientContext,
} from './contracts.ts'

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ensurePanelStyles()
  ensureWorkItemStyles()

  // The work-item viewer is a keyed root `main` panel: the right-rail list
  // opens it through `layout.selectPanel('cowork-work-item')`. Registering the
  // slot key does not require the layout service; only opening does.
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: 'cowork-work-item',
  }, WorkItemViewer))

  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: COWORK_TAB_ID,
  }, CoworkPanel))

  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title',
    key: COWORK_TAB_ID,
  }, CoworkPanelTitle))

  // The bottom-bar entry stays registered even when the navigation service is
  // missing: the button then renders disabled with an explanatory title.
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'cowork-open',
    order: 5,
  }, CoworkFooterAction))

  ctx.inject(['sidebarRightTabs'], (scope) => {
    const tabs = scope.sidebarRightTabs
    if (tabs === undefined) return
    return tabs.register({
      id: COWORK_TAB_ID,
      kind: COWORK_TAB_KIND,
      title: () => COWORK_TAB_TITLE,
      guide: [{
        id: 'cowork-guide',
        order: 35,
        title: () => COWORK_TAB_TITLE,
        description: () => '查看主题列表、分组与待处理事项。',
        icon: CoworkColorGlyph,
      }],
    })
  })

  ctx.inject(['sidebarRight'], (scope) => {
    setClientService('sidebarRight', scope.sidebarRight)
    return () => { setClientService('sidebarRight', undefined) }
  })

  ctx.inject(['uiWorkspace'], (scope) => {
    setClientService('uiWorkspace', scope.uiWorkspace)
    return () => { setClientService('uiWorkspace', undefined) }
  })

  // Work-item navigation dependencies. Both are optional: without `layout` the
  // list explains it cannot open the main area, and without `sessions` the
  // viewer simply does not auto-close on a session switch.
  ctx.inject(['layout'], (scope) => {
    setClientService('layout', scope.layout)
    return () => { setClientService('layout', undefined) }
  })

  ctx.inject(['sessions'], (scope) => {
    setClientService('sessions', scope.sessions)
    return () => { setClientService('sessions', undefined) }
  })

  // A2 only: the optional injection never fires on a host without
  // `ctx.sessionNotices` (DSH 0.2.1-rc.2, decision B), so no conversation node
  // is registered and the feature-detect entry stays a no-op.
  ctx.inject(['sessionNotices'], (scope) => registerNoticeRenderer(scope) ?? undefined)
}
