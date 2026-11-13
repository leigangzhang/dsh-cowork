# Cowork 面板交接文档（M3 前端）

- 适用：在全新会话/上下文中实现 Cowork 右侧栏只读面板的 agent 或人。
- 状态：**已交付**（2026-11-05）。交付面、真实宿主证据、未验证项与合并注意见 [PANEL_RESULT](../results/PANEL_RESULT.md)；决策记录见 [implemented 提案](../../../.agents/notes/implemented/feature/2026-11-05-cowork-panel.md)。本文件保留为实施入口与陷阱清单。
- 事实源：[PANEL_RECON](../recon/PANEL_RECON.md) 拥有宿主 slot/宽度/token/打包事实；[implemented 提案](../../../.agents/notes/implemented/feature/2026-11-05-cowork-panel.md) 拥有布局、数据契约、验收；[PANEL_RESULT](../results/PANEL_RESULT.md) 拥有交付证据；本文件只拥有“怎么开始、先验证什么、怎样算完成”。

## 先读什么

1. [AGENTS.md](../../../AGENTS.md) 的纪律、命令、no-multi-orchestrator。
2. [docs/archived/recon/PANEL_RECON.md](../recon/PANEL_RECON.md)：右侧栏 tab 的挂载、14 个公开 token、宽度公式、client 打包约定。
3. [面板决策](../../../.agents/notes/implemented/feature/2026-11-05-cowork-panel.md)：布局/数据/验收；尤其 `## Proposal` 的“数据契约”和“客户端构建与探针”。
4. [docs/archived/results/M1_RESULT.md](../results/M1_RESULT.md)：`index.json`、handoffs 与现有工具行为。
5. [.agents/notes/README.md](../../../.agents/notes/README.md)、[docs/AGENTS.md](../../AGENTS.md)：记录迁移与发布分类。

## 现在的事实

- 仓库：`/Users/ray/Workspace/dsh-cowork`，`main` 已推送；M1 六个 `cowork_*` 工具与两个运行时 preset 可用；M2 的后端提案已写（[M2_HANDOFF](M2_HANDOFF.md)），前端不依赖 M2 才有数据，但字段只增不改。
- **没有 client 半边**：M0 删除了 `src/client/` 与 `tsdown.config.ts`；`scripts/build.sh` 只构建 host；`package.json` 没有 `./client` 导出与 `dsh.client`。这是本交付的第一风险。
- 宿主：DSH Desktop 2.0.18 / 运行时 0.2.1-rc.2；web profile `http://127.0.0.1:3080`；插件当前是 `dev_inject_plugin` 注入态。
- 右侧栏事实（[PANEL_RECON](../recon/PANEL_RECON.md)）：`sidebar.right.pane.tab`（keyed，session scope）+ `.title`；`ctx.sidebarRight.openTab(kind)`；底栏入口 `sidebar.footer.action`；`sidebar.panellist` 不能开右栏。右栏最小 300、首次打开 `max(300, 45% viewport)`、上限 70%；tab strip 28px+10px、正文 13px/1.5。
- 主题只认 14 个公开 token：`bg-base / bg-layer-1 / bg-layer-2 / bg-overlay / border-l1 / border-l2 / brand-primary / label-primary / label-secondary / state-error-primary / state-idle-primary / state-success-primary / state-warn-primary / specific-sidebar-fill`；`brand-primary` 浅色近黑、深色近白。内部别名（`label-tertiary`/`border-l3`/`interactive-bg-hover`/`radius-*`/`font-size-secondary`）可用但必须带 fallback。
- 设计稿：`/tmp/cowork-panel-right/`（`open /tmp/cowork-panel-right/index.html`；`?state=&theme=&w=648|480|320&view=detail&master=open`），截图在 `/tmp/cowork-panel-right/screens/`。**/tmp 可能被清理**；设计以提案为准，截图只作对照。
- 命令：`npm run check` / `npm test` / `npm run typecheck` / `npm run build` / `npm run check:self-test`；`npm run build` 会热重载注入插件。
- 浏览器自动化可用：`bsk_*`（browser-skill）；真实渲染验证用它截图。

## 目标与非目标

**目标**（提案 P1–P8）：右侧栏 `Cowork` tab（底栏入口 + guide entry）；>480 分栏、≤480 钻取；状态 chips、优先级排序/默认选中；详情（summary/verification/changedPaths/交接单路径/MASTER 原文折叠）；只读两个 API；复制交接单绝对路径；打开 thread 会话；七状态 + light/dark；客户端探针通过。

**非目标**：验收/归档/派活等写操作、review verdict、worktree/memory 编辑、SSE、多项目、主区满页、桌面 profile 特化。

## 第一步：客户端能力探针（必须先做）

M0 的 client 半边已删除，**不要直接写完整面板**。先做一个最小 client：

1. `src/client/index.ts` + 一个最小 React 组件：注册 `sidebarRightTabs.register({ id, kind, title })`、`sidebar.right.pane.tab`/`.title`，以及 `sidebar.footer.action` 按钮调 `ctx.sidebarRight.openTab(kind)`；组件只显示 `Cowork / token 名 / 当前 sessionId`。
2. 补齐 client 构建：`tsdown.config.ts`、`package.json` 的 `exports["./client"]`、`dsh.client`、peerDeps、`scripts/build.sh` 的 client 步骤、`typecheck` 覆盖。
3. 在真实宿主验证：tab 出现、底栏按钮能打开、`--dsw-alias-label-primary` 生效（深浅切换）、client bundle 被加载；记录构建/加载/HMR 的具体路径与限制。
4. 若构建链或加载链失败：记录失败证据，**降级**为“只交付 host 只读 API + 文档”，不硬做 UI（提案 Risks 已写）。

结论写进 `docs/archived/recon/PANEL_RECON.md` 的补充节或新的 `docs/PANEL_PROBE_RESULT.md`（新增时同步 `docs/publish.json`），给原始命令/输出。

## 实施顺序

1. **P0 客户端探针**（上节）。
2. **P1 只读 API**：`/dsh-cowork/api/overview?sessionId=`、`/dsh-cowork/api/handoff?sessionId=&threadId=`；loopback + 只读 + `cache-control: no-store`；复用 `ProjectStore`/`findProjectRoot`/`formatMasterMessage`；错误码映射；单测。
3. **P2 面板**：列表/详情/钻取/状态/主题/键盘/a11y；只读，不写 index。
4. **P3 真实宿主 E2E**：`bsk_*` 打开面板，覆盖七种状态、648/480 两宽度、light/dark；截图对照设计稿；失败项如实记录。
5. **P4 文档**：面板结果与限制、提案迁入 implemented、`docs/publish.json`、M3 交接更新。

## 陷阱

- token 名必须用公开 14 个；`text-primary`/`border-base`/`state-warn`/`state-info`/`focus-ring`/`shadow-card`/`on-brand` 都不存在。主按钮是单色（浅黑/深白）+ 反色文字，不是蓝色。
- 右栏宽度不要写死 648：从 `computeColumns` 的 `RIGHTBAR_MIN=300`、`45%` 默认、`70%` 上限与中心 400 最小推导；480 是**我们**的钻取阈值，不是宿主值。
- tab 是 session scope；项目必须由该会话 `cwd` 用 `findProjectRoot` 推，不要让浏览器传任意路径；API 必须校验 `sessionId` 对应的会话真实存在。
- `masterMessage` 由宿主用 `formatMasterMessage` 生成，面板原样展示（等宽、保留换行、最大高度约 40% + 内部滚动）；不要重排成卡片。
- “复制交接单路径”复制**绝对路径**，不是 JSON；剪贴板在非安全上下文可能被拒，必须有失败提示。
- `sidebar.panellist` 不能打开右侧栏；入口用 `sidebar.footer.action` + guide entry。
- 浏览器不能读 `.dsh-cowork`；数据只走 host API。
- HMR：只有 DSH checkout 里跑着 `pnpm run dev:web` 时才免刷新；否则重建 client + 刷新页面。正式安装路径是 `dsh plugin add` 后重启。
- 文档新增/改名必须在 `docs/publish.json` 分类；note 与链接有门禁。
- 不要顺手改 M2 的 memory/worktree 代码；不要修改 `docs/PLAN.md`；不要删除 `.dsh-cowork/` 证据。

## 验证与证据

- 每阶段：`npm run check` + `npm test`；client/host 变更加 `npm run typecheck` + `npm run build`。
- P0/P3 必须真实宿主：tab 挂载、打开、主题生效、七状态渲染；截图存 `docs/` 或说明落点；跨进程/跨层不用同进程 mock 代替。
- a11y：键盘可达、`aria-selected`/`aria-expanded`、焦点环；写一个零依赖对比度脚本按 WCAG 计算正文/次要文字/按钮（目标 AA 4.5:1），把结果写进验收。
- 审查：实现者 ≠ 验证者 ≠ 最终审查者。

## 未决问题（实现前先确认）

1. 数据通道：默认 loopback 只读 JSON；若 P1 发现 bridge 更合适，先改提案再实现。
2. “打开 thread 会话”的导航 API：用客户端 `uiSession`/session controller 的哪个方法？确认后写进提案。
3. guide entry 的标题与描述（“Cowork / 项目协作总览”？）与底栏按钮文案（已定 “Cowork”）。
4. `masterMessage` 的服务端生成时机：读 handoff 时现生成，还是把投递文本落盘？默认现生成 + 记录格式器版本。
5. 面板是否需要在 thread 列表显示 checkout 状态（M2 字段）？v0 可只显示 `checkoutPath` 有/无，不展开。

## 完成定义

- 提案 P1–P8 全部有真实证据；七状态与两宽度在真实宿主通过。
- `npm run check` / `test` / `typecheck` / `build` / `check:self-test` 全绿（含 client）。
- 面板结果与限制写入 docs；提案迁移到 `implemented/` 并保持 current。
- 不进入 M4；不引入第三方协作运行时；不修改 `docs/PLAN.md`。

## 清理与回滚

- 代码：按提交 revert；client 与 host 改动分开提交。
- 运行时：`dev_uninject_plugin dsh-cowork`；`.dsh-cowork/` 是项目数据，保留。
- 设计稿：`/tmp/cowork-panel-right/` 是临时件，可整目录删除；设计以提案为准。
