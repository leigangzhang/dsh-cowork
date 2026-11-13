# Cowork 面板侦察结论（M3 前置）

- 结论：cowork 面板可以做成**右侧栏的一个 tab**，不改主区；落点、宽度、主题 token 与打包方式都有宿主事实可依。风险不在 slot，而在客户端半边的构建/加载链路（M0 曾因 API 移除整体删掉，仓库当前没有 client 构建）。
- 证据：`cordis_inspect_query`（client `Slots`/`Theme`）与 DSH 源码 checkout（`/Users/ray/Workspace/deepseek-harness`）的只读核对；引用行号为 checkout 当前版本。宿主 DSH Desktop 2.0.18 / 核心 0.2.1-rc.2。

## 挂载点

- 右侧栏本体是 `rightbar`（single，root，已由右侧 Sidebar 占用）；会话内容在 `rightbar.session`，tab 主体在 **`sidebar.right.pane.tab`（keyed，session scope）**，chip 标题在 **`sidebar.right.pane.tab.title`**（同一 key）。
- 注册分两步（`packages/client/ui-sidebar-documentpreview/src/client/index.ts:1-130` 是标准范例）：
  1. `ctx.sidebarRightTabs.register({ id, kind, title, icon?, guide?, multiple? })` 注册 tab 类型；
  2. `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name, key: id }, Body))` 与 `.title` 注册主体和标题。
- 打开：`ctx.sidebarRight.openTab(kind)`；会话内用 `openTabIn(sessionId, kind)`。tab 的 body 拿到 `sessionId`、`useProjection`、`useResource` 等标准 props（`Slots` 的 `standardProps`）。
- 入口：`sidebar.panellist` 只切换**主区** panel（`ui-sidebar/src/client/contract/slots.ts:35`），不能用来开右侧栏；可行入口是 ①右侧栏 guide 页的 entry（注册 definition 时给 `guide`）②`sidebar.footer.action` 的图标按钮（`SidebarFooterActionOwnerProps {wide}`，点击调 `openTab`）③快捷键命令。**建议 ②+①**：底栏常驻入口 + guide 发现位。
- 已知占用（同一 keyed seat）：guide、files、terminal、documentpreview、subagent、deliverables、plan、schedule/task、agent-teams activity、dsh-context、browser-skill observation。新增 key 不冲突。

## 宽度

- `RIGHTBAR_MIN = 300`；首次打开宽度 `max(300, round(viewport × 0.45))`；上限 `viewport × 0.7`；中心区最小 400；左栏默认 280（`packages/client/ui-layout/src/client/columns.ts:17-59`、`stores.ts:132`）。
- 1440 宽下右栏约 **648px**（1440−280−400=760 可用，取 0.45×1440=648）；最小 300，可拖拽；另有全屏呈现。静态稿应按 **648 宽为主、300 宽为窄态**设计，而不是按手机的 320。
- 面板是整列 flex，tab strip 28px 高、顶 padding 10px；主体自撑满高度（`ui-dockkit/src/components/dockkit.module.css:237-247`、`ui-sidebar-right/src/client/shell/SidebarRight.module.css`）。

## 主题 token

`Theme` provider 给出的公开 token 只有 14 个，且要求 light/dark 两套值：

```text
--dsw-alias-bg-base / bg-layer-1 / bg-layer-2 / bg-overlay
--dsw-alias-border-l1 / border-l2
--dsw-alias-brand-primary
--dsw-alias-label-primary / label-secondary
--dsw-alias-state-error-primary / state-idle-primary / state-success-primary / state-warn-primary
--dsw-specific-sidebar-fill
```

实际值（`ui-theme/src/styles/design-platform.css`）：

- light：bg-base/layer-1/layer-2 = `#fff`；overlay = `rgb(233,236,242)`；border-l1 `rgba(0,0,0,.04)`、l2 `rgba(0,0,0,.1)`；brand-primary = `rgb(15,17,21)`（**近黑，不是蓝**）；label-primary `rgb(15,17,21)`、secondary `rgb(97,102,107)`；error `rgb(236,19,19)`、success `rgb(34,197,94)`、warn `rgb(245,158,11)`、idle `rgb(212,212,212)`；sidebar-fill `rgb(249,250,251)`。
- dark：bg-base `rgb(21,21,23)`、layer-1 `rgb(35,35,36)`、layer-2 `rgb(44,44,46)`、overlay `rgb(97,102,107)`；border-l1 `rgba(255,255,255,.06)`、l2 `rgba(255,255,255,.12)`；brand-primary `rgb(249,250,251)`（近白）；label-primary `rgb(249,250,251)`、secondary `rgb(207,211,214)`；error `rgb(242,90,90)`、success/warn 同浅色、idle `rgb(84,85,87)`；sidebar-fill `rgb(27,27,28)`。
- **协议外但 DSH 内部在用的**别名（`label-tertiary`、`border-l3/l4`、`interactive-bg-hover`、`radius-sm/md/xl`、`font-size-secondary`）不在公开 token 清单里；插件可以用，但要带 fallback，或只用 14 个公开 token + `color-mix` 派生。M1 mock 里自造的 `text-primary`/`border-base`/`state-warn`/`state-info`/`focus-ring`/`shadow-card`/`on-brand` 都不存在，必须替换。
- 既有组件基线：主体 13px / 1.5（`--dsh-content-font-size-secondary`）；tab strip 28px + 10px top；body header 38px、底部 0.5px `border-l3`；guide 胶囊 `bg-layer-1` + 0.5px `border-l3` + `radius-xl`，hover `interactive-bg-hover`；主按钮用 brand（浅色黑/深色白）+ 反色文字，**不要靛蓝**。

## 打包与热更新

- 外部插件客户端约定：`exports["./client"]` + `package.json` 的 `dsh.client = { platform: 'web', inject: [<client 插件包>], external: ['@deepseek-ai/dsh-client-ui-primitives'] }`（见已装的 browser-skill、agent-teams 包）。client 半边预构建成一个文件，由宿主 client module 加载。
- 仓库当前**没有 client 构建**：M0 删除了 `src/client/` 与 `tsdown.config.ts`，`scripts/build.sh` 只编译 host；`npm run build` 不会产出 client。客户端能力探针必须同时证明 ①slot 挂载 ②client bundle 构建/被加载 ③主题 token 生效；失败就降级（先只做 host 只读 API + 文档）。
- 热更新：client 改动只有在 DSH checkout 里跑着 `pnpm run dev:web` 时才免刷新重建；否则需要重新构建 client + 刷新页面。正式交付路径是 `dsh plugin add` 后重启。
- 客户端构建链的实测结论（esbuild 闭包产物、`__ModuleLoader__` 契约、同名换包缓存限制）由 [PANEL_RESULT](../results/PANEL_RESULT.md) 拥有。

## 约束与未验证

- tab body 是 session scope：项目来自该会话 `cwd`（host 侧用 `findProjectRoot`），浏览器不能读 `.dsh-cowork`；数据必须走 host 只读 API（建议 `/dsh-cowork/api/*` loopback JSON）或 client↔host service 桥。后者未验证。
- 本次宽度是公式推算，未在用户实际窗口测量；实际以右栏打开后的渲染为准。
- `sidebar.footer.action` 的点击行为、guide entry 的展开在真实 UI 未跑（只读 slot 契约 + 现有插件源码）。
- 未验证 client bundle 在**本仓库**的构建链（tsdown/JSX/类型）；这是下一步探针的主要内容。
