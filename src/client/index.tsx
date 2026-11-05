/**
 * Cowork panel — browser half entry.
 *
 * Registers the right-Sidebar `Cowork` tab type, its body and chip title, the
 * bottom-bar entry and the guide capsule. `slots` is declared because the host's
 * static precheck and cordis both require it before `apply` may touch
 * `ctx.slots`; every newer service is injected optionally so a host without
 * them still loads the plugin and only degrades the affected action.
 */
import { ensurePanelStyles } from './styles.ts'
import { CoworkFooterAction, CoworkPanel, CoworkPanelTitle } from './panel.tsx'
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
        description: () => '查看 Cowork 项目总览、thread 列表与交接单原文。',
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
}
