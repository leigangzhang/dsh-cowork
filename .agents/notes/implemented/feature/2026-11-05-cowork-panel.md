# Decision: Cowork 右侧栏面板（只读 v0）

Status: implemented
Date: 2026-11-05
Class: feature

## Problem

M1 的主从闭环已经可用，但所有状态只存在于 `.dsh-cowork/` 与 `cowork_*` 工具的 JSON 结果里：用户看不到「项目 → thread → handoff」的整体形状，只能靠翻会话和手读文件。PLAN §6 M3 要求客户端面板，而 M0 删掉了 client 半边（旧 Slots API 已移除），交付前仓库既没有 client 构建，也没有面向面板的只读数据接口。设计已收敛（[PANEL_RECON](../../../../docs/handoff/PANEL_RECON.md)）：面板落右侧栏 tab；648 分栏、≤480 钻取；v0 只读并支持「打开 thread 会话」。

## Decision

面板是右侧栏的一个 session scope tab，配两个只读 HTTP 端点与一个自建的客户端构建链；只读，不写项目状态。

**落点与入口**

- 注册 tab 类型：`ctx.sidebarRightTabs.register({ id: '@dsh-external/dsh-cowork/panel', kind: 'cowork', title: () => 'Cowork', guide: [1 条] })`；主体注册到 keyed 的 `sidebar.right.pane.tab`、标题到 `sidebar.right.pane.tab.title`，key 用同一 id。tab 是 session scope，项目由该会话 `cwd` 经 host 侧 `findProjectRoot` 得到。
- 入口两处：`sidebar.footer.action` 的「打开 Cowork 面板」图标按钮（主入口，遵循 `wide`）与 tab definition 的 guide entry。`sidebar.panellist` 只切主区，不使用。
- 打开 tab 用 `ctx.sidebarRight.openTab('cowork')`；「打开 thread 会话」用 `ctx.uiWorkspace.openSession(threadId)`（client service 缺失时按钮禁用并给提示）。

**布局（A 壳 + B 头）**

- `>480px`：左右分栏，左列 248px 的 thread 列表，右侧详情；默认选中「最需要处理」的 thread；排序 `awaiting_review → blocked → active → new → done`，同状态按 `updatedAt` 倒序。
- `≤480px`：单列钻取，先列表、点行进详情、详情顶部「全部 thread」返回。
- 头部：项目路径 + 刷新；下一行状态计数 chips（active / awaiting review / blocked / done / new）。
- 列表行：状态点 + 中文状态 + subject（截断，`title` 给全文）+ 相对时间 + 有 handoff 的标记。
- 详情：subject、状态徽章、thread 短 id、更新时间；摘要；验证（command / exit chip / evidence）；变更文件 chips；交接单绝对路径 + 复制按钮；`<details>` 的「MASTER 收到的消息」（默认折叠，等宽、保留换行、最大高度约详情区 40%、内部滚动，内容与 host 的 `formatMasterMessage` 原文逐字一致）。
- 状态：default / empty（未初始化，引导去 `cowork-master` 调 `cowork_project_init`）/ loading（骨架）/ error（`store/corrupt` + 路径 + 重试）/ long-list（滚动）/ no-handoff / long-subject；light/dark 跟随系统；`prefers-reduced-motion` 关动效。
- 只消费 Theme provider 的 14 个公开 token；内部别名（`border-l3`/`interactive-bg-hover`/`radius-sm`）带 fallback；不自造色板。`brand-primary` 浅色近黑、深色近白，主按钮用单色 + 反色文字。

**数据契约（v0 只读）**

浏览器不读文件；host 在 `connection` 服务的 Exact Fetch 通道上暴露两条路由（继承 Host/Origin 围栏与浏览器 cookie，不再另写 loopback 检查；无 cookie 返回 401）：

- `GET /api/cowork.overview?sessionId=` → `{ok:true, project:{repoPath,projectId,masterSessionId,createdAt}, counts:{new,active,awaiting_review,blocked,done}, threads:[{threadId,subject,status,cwd,checkoutPath,createdAt,updatedAt,lastHandoffAt,hasHandoff}]}`。`archived` 不返回；排序即面板优先级；上限 500。
- `GET /api/cowork.handoff?sessionId=&threadId=` → `{ok:true, handoff:{record, filePath, masterMessage, formatterVersion}}`；`masterMessage` 由 host 复用 `formatMasterMessage` 读时生成，保证面板显示的就是投递原文。
- 错误沿用 `{ok:false,error:{code,message,path?}}`；HTTP 400（缺参 / `session/unknown` / `session/cwd-unavailable`）、404（`project/not-initialized` / `handoff/not-found`）、500（`store/corrupt` 带 path、`internal`）；成功与错误都带 `cache-control: no-store`。
- 项目根只由 `sessionId → 会话元数据 cwd → findProjectRoot` 推出：host 用 `sessionController.list()`（不读会话事件日志，故对运行中会话不阻塞），绝不接受浏览器传入的路径。
- 面板打开与点刷新时拉取；v0 不做 SSE/轮询。

**客户端构建与探针**

- 新增 client 半边：`src/client/`（React + TSX）、`package.json` 的 `exports["./client"]` 与 `dsh.client = { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-sidebar-right','@deepseek-ai/dsh-client-ui-workspace'], external: [] }`。
- 构建链不新增 npm 依赖：`scripts/build-client.mjs` 用 DSH 源码 checkout 的 esbuild 产出单文件 CJS `lib/client.js`，banner/footer 满足 `window.__ModuleLoader__.load({ id, factory })`，`react` / `react/jsx-runtime` 保持外部 require；`scripts/build.sh` 在 host 编译后调用它，`--no-emit` 同时 typecheck client（`tsconfig.client.json`）。
- 类型策略：client 只用本地契约（`src/client/contracts.ts`）与 checkout 的 `@types/react` 做类型检查；host 继续用 checkout 编译出的真类型。

**可访问性**：列表 `role=listbox/option` + `aria-selected` + roving tabindex（ArrowUp/Down/Home/End）；详情 `role=region`；按钮有可访问名称；`:focus-visible` 2px 焦点环；状态不只靠颜色；对比度用脚本按 WCAG 计算并写进结果文档。

**不在 v0**：验收/归档/派活等写操作、review verdict、worktree/memory 的编辑、文件预览、SSE 实时刷新、多项目切换、主区满页面板、桌面 profile 特化。

## Alternatives considered

**主区满页 + 侧栏图标（A/B 原始稿）。** 否决：用户已定「右侧栏面板」；主区会让位给会话，且与 DSH 的右侧栏信息架构不一致。

**只做卡片流（纯 B）。** 否决：648px 下列表与详情同屏的对照效率更高；B 的卡片流保留为窄态（≤480）的钻取形态。

**面板直接读 `.dsh-cowork` 文件。** 否决：浏览器拿不到宿主文件系统；必须经 host 只读 API，且这样能复用 M1 的 store 兼容性检查。

**用 client↔host service 桥代替 HTTP。** 暂缓：桥的可用性未验证；connection 的 Exact Fetch 与现有 `/api` 通道同源、可 curl 验证，M4 打包时再评估。

**v0 就带验收/归档写操作。** 否决：会绑死尚未落地的 review 契约（M3），并让只读面板承担状态机风险。

**展开 MASTER 消息时重新排版成卡片。** 否决：投递证据的价值在「原文」；重排会引入解释层，且与 `formatMasterMessage` 的真相源分叉。

**用 `sidebar.panellist` 做入口。** 否决：该 slot 只能切主区 panel，无法打开右侧栏 tab。

**为面板新增 tsdown 依赖。** 否决：仓库已依赖 DSH checkout 提供 tsc 类型；同一 checkout 的 esbuild 已足够产出闭包形态，避免新增依赖与锁文件。

## Consequences

- client 半边重新进入仓库，构建链依赖 DSH 源码 checkout 的 esbuild（与既有 tsc 依赖同一前提）；找不到 checkout 时构建带清晰报错。重审条件：宿主改用可失效的包扫描或提供官方外部插件构建器。
- `client-modules` 按「loader name + baseUrl」缓存包元数据且不失效：同一进程内把同名包从「无 `dsh.client`」换成「有」不会生效，真机验证因此使用临时改名包（loader id 同步改名）。交付物保持原名，正常安装（`dsh plugin add` 后重启）不受影响。
- 面板的 thread 字段跟随 M2 的 `checkoutPath`（合并 M2 时已同步 `src/api-contract.ts` 与 host/client 两处映射）；M2 store 读兼容旧索引的 `worktreePath`，面板不做跨分支垫片。
- `masterMessage` 原样返回、读时生成并带 `formatterVersion`；大小由落盘的 handoff 文件决定，不加截断（截断会破坏「master 看到了什么」的证据）。
- 只读 API 的 `sessionId` 解析依赖宿主 `sessionController.list()` 的元数据形状；重审条件：宿主会话服务变化。
- 主题只保证 14 个公开 token；内部别名一旦被宿主移除只退化为 fallback 色，不报错。

## Testing

- [P1] 右侧栏出现 `Cowork` tab，可从底栏按钮打开；tab 是 session scope；guide entry 注册 — `source`：真实宿主截图 `01`（tab + 底栏按钮 + 面板打开）；注册面由 `src/client/index.tsx` 与 `tests/panel-model.test.mjs` 覆盖；guide 条目未在真机点击。
- [P2] `>480px` 左右分栏（列表 248px + 详情）、`≤480px` 单列钻取；状态 chips 与优先级排序/默认选中符合契约 — `source`、`tests`：截图 `01`/`03`（分栏、chips、排序、默认选中）；断点与排序由 `tests/panel-model.test.mjs` 与 `tests/api-contract.test.mjs` 钉住；**钻取态未在真实宿主验证**（宽度操作被 BrowserSkill strict-observation 闸门挡住）。
- [P3] 详情展示 summary / verification / changedPaths / 交接单路径；MASTER 消息默认折叠，展开内容与 host 的 `formatMasterMessage` 原文逐字一致 — `source`：截图 `01`/`02`/`03`；`pre.cw-master` 文本长度 889 与 `formatMasterMessage` 输出一致。
- [P4] 「复制交接单路径」复制绝对路径并在失败时给明确提示；「打开 thread 会话」导航到对应会话 — `source`：源码与 `tests/panel-model.test.mjs` 覆盖提示文案；真机只点过复制按钮，**成功提示与导航未逐项截图**。
- [P5] 七种状态与 light/dark 可复现；只消费公开 token 或带 fallback 的内部别名 — `source`、`tests`：截图 `01`（default）、`04`（error）、`05`（empty）、`06`（long-list）、`03`（long-subject 行、no-handoff 行）；loading 骨架与 no-handoff 文案在源码；**深色主题未在真机切换**，对比度由脚本按 token 实际值计算（light 18.90/5.80/18.90，dark 17.45/12.11/17.45）。
- [P6] `/api/cowork.overview` 与 `/api/cowork.handoff` 仅经认证通道、只读、有界；`project/not-initialized`、`handoff/not-found`、`store/corrupt` 映射到对应 UI 状态 — `source`：真实宿主 `401`（无 cookie）与 `store/corrupt`/`project/not-initialized` 的 UI 截图 `04`/`05`；错误码与 `no-store` 由 `tests/api.test.mjs` 逐条断言。
- [P7] 客户端能力探针通过：client bundle 被加载、tab 挂载、token 生效、构建路径写进文档；`typecheck`/`build`（含 client）通过 — `packaging`：`npm run build` 产出 `lib/client.js`（53,033 B）并被宿主 `/plugins` 服务加载；`npm run typecheck` 覆盖 host+client；限制写进 [PANEL_RESULT](../../../../docs/handoff/PANEL_RESULT.md)。
- [P8] 文档同步：结果与限制入 docs、`docs/publish.json` 分类、M3 交接文档更新，`npm run check` 通过 — `publication`：`docs/handoff/PANEL_RESULT.md` 与 `docs/handoff/PANEL_HANDOFF.md` 已分类；`npm run check` 通过。
