# Proposal: Cowork 右侧栏面板（只读 v0）

Status: proposed
Date: 2026-11-05
Class: feature

## Problem

M1 的主从闭环已经可用，但所有状态只存在于 `.dsh-cowork/` 与 `cowork_*` 工具的 JSON 结果里：用户看不到“项目 → thread → handoff”的整体形状，只能靠翻会话和手读文件。PLAN §6 M3 要求客户端面板，但 M0 删掉了 client 半边（旧 Slots API 已移除），仓库当前既没有 client 构建，也没有面向面板的只读数据接口。

设计已经收敛（侦察见 [PANEL_RECON](../../../../docs/PANEL_RECON.md)，静态稿见 `/tmp/cowork-panel-right/`，截图留在 `/tmp/cowork-panel-right/screens/`）：面板落右侧栏 tab；A 的列表+详情做壳、B 的状态计数做头；648px 分栏、≤480px 钻取；v0 只读并支持“打开 thread 会话”。本提案把这个设计、数据契约与客户端能力探针固定下来。

## Proposal

**落点与入口**

- 注册右侧栏 tab 类型：`ctx.sidebarRightTabs.register({ id: '@dsh-external/dsh-cowork/panel', kind: 'cowork', title: () => 'Cowork' })`；主体注册到 `sidebar.right.pane.tab`、标题到 `sidebar.right.pane.tab.title`，key 用同一个 id。tab 是 session scope；项目由该会话 `cwd` 向上找 `.dsh-cowork/index.json` 得到。
- 打开：`ctx.sidebarRight.openTab('cowork')`（会话内用 `openTabIn(sessionId, 'cowork')`）。入口两处：`sidebar.footer.action` 的 “Cowork” 图标按钮（主入口，遵循 `wide` 状态），以及 tab definition 的 `guide` entry（右侧栏 guide 页的发现位）。`sidebar.panellist` 只切主区，不使用。
- 只读：v0 不从浏览器发任何写操作；不发 `cowork_project_init`/`route`/`handoff`，不归档、不验收。

**布局（A 壳 + B 头）**

- >480px：左右分栏。左列 248px 的 thread 列表；右侧详情占剩余宽度。默认选中“最需要处理”的 thread；列表按 `awaiting_review → blocked → active → new → done` 排序，同状态按 `updatedAt` 倒序。
- ≤480px：单列钻取。先列表，点一行进入详情，详情顶部“全部 thread”返回；不出现被压缩的两栏。
- 头部：项目路径 + 刷新/更多；下一行是状态计数 chips（active / awaiting review / blocked / done / new），来自 overview。
- 列表行：状态点 + 中文状态文字 + subject（截断，`title` 给全文）+ UTC 时间与相对时间 + 有 handoff 的标记。
- 详情：subject、状态徽章、thread 短 id、更新时间；摘要；验证（每行 command / exit chip / evidence）；变更文件 chips；交接单绝对路径 + 复制按钮；`<details>` 的 “MASTER 收到的消息”（默认折叠）。
- 展开 “MASTER 收到的消息” 时，展示插件投递给 master 的**原文** `formatMasterMessage` 文本（等宽、保留换行、最大高度约为详情区 40%，超出内部滚动）。理由：这是“handoff 确实被投递并被看到”的证据，重排或摘要会削弱证据力；不做二次渲染。
- 动作：主按钮“打开 thread 会话”选中并导航到对应会话（只读的动作，不改项目状态）；次按钮“复制交接单路径”把交接单 JSON 的**绝对路径**（如 `/Users/…/.dsh-cowork/handoffs/session-…-20261105T125044236Z.json`）写入剪贴板，便于用户打开原始证据或粘到终端/其他 agent；不复制 JSON 正文。剪贴板失败时显示明确 toast，不静默。
- 状态：default / empty（未初始化，引导去 `cowork-master` 调 `cowork_project_init`）/ loading（骨架）/ error（`store/corrupt` + 路径 + 重试）/ long-list（滚动）/ no-handoff / long-subject；light/dark 跟随系统并可手动切；`prefers-reduced-motion` 关闭动效。

**数据契约（v0 只读）**

浏览器不读文件，由 host 暴露 loopback 只读 JSON（与 `webServer.register` 同一套）：

- `GET /dsh-cowork/api/overview?sessionId=<id>` → `{ ok: true, project: { repoPath, projectId, masterSessionId, createdAt }, threads: [{ threadId, subject, status, cwd, worktreePath, updatedAt, lastHandoffAt }], counts: { active, awaiting_review, blocked, done, new } }`；`project/not-initialized` 时返回 `{ok:false,error:{code}}`，面板渲染 empty。
- `GET /dsh-cowork/api/handoff?sessionId=<id>&threadId=<id>` → `{ ok: true, handoff: { record, filePath, masterMessage } }`；`masterMessage` 由 host 复用 `formatMasterMessage` 生成，保证面板显示的就是投递原文；无 handoff 返回 `handoff/not-found`。
- 仅 loopback（校验 remoteAddress 与 Host，沿用 `probe-model` 的判定）；只读 GET；响应带 `cache-control: no-store`；不返回密钥/环境变量；错误沿用 `{ok:false,error:{code,message}}`。
- 面板打开与点刷新时拉取；v0 不做 SSE/轮询。空/错误/损坏路径按返回码渲染。

**客户端构建与探针**

- 新增 client 半边：`src/client/`（React + TSX）、`tsdown.config.ts`、`package.json` 的 `exports["./client"]` 与 `dsh.client = { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-sidebar-right', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-session'], external: ['@deepseek-ai/dsh-client-ui-primitives'] }`；`scripts/build.sh` 增加 client 构建，`npm run typecheck` 同时覆盖 client。
- 先做客户端能力探针（类似 M0/S0，不写完整面板）：最小 client 注册一个 tab + 一个 footer action，证明 ①真能挂进右侧栏并打开 ②`--dsw-alias-*` 生效 ③client bundle 被宿主加载 ④热更新路径（有 `pnpm run dev:web` 时免刷新，否则重建+刷新）。失败就降级为“只做 host API + 文档”，不硬做 UI。
- 主题只用 Theme provider 公布的 14 个 token；派生色用 `color-mix` 或带 fallback 的内部别名（`label-tertiary`/`border-l3`/`interactive-bg-hover`/`radius-*`）；不自造 `state-info`/`on-brand`/`focus-ring`/`shadow-card`。`brand-primary` 在浅色是近黑、深色是近白，主按钮用单色 + 反色文字，不用靛蓝。

**可访问性**

列表用 roving tabindex 的 listbox/option（或等价的 button 列表，按 DSH 现有惯例），`aria-selected`；详情区 `role="region"`；复制/刷新/返回都有可访问名称；`:focus-visible` 2px 焦点环；状态不只靠颜色（点 + 文字）；文字对比度用脚本按 WCAG 计算并写进验收（不靠目测）。

**不在 v0**

验收/归档/派活等写操作、review verdict、worktree/memory 的编辑、文件预览、SSE 实时刷新、多项目切换、主区满页面板、桌面 profile 特化。

## Alternatives considered

**主区满页 + 侧栏图标（A/B 原始稿）。** 否决：用户已定“右侧栏面板”；主区会让位给会话，且与 DSH 的右侧栏信息架构不一致。

**只做卡片流（纯 B）。** 否决：648px 下列表与详情同屏的对照效率更高；B 的卡片流保留为窄态（≤480）的钻取形态。

**面板直接读 `.dsh-cowork` 文件。** 否决：浏览器拿不到宿主文件系统；必须经 host 只读 API，且这样能复用 M1 的 store 兼容性检查。

**用 client↔host service 桥代替 HTTP。** 暂缓：桥的可用性未验证；loopback 只读 JSON 与现有 probe 路由同源、可 curl 验证，M4 打包时再评估。

**v0 就带验收/归档写操作。** 否决：会绑死尚未落地的 review 契约（M3），并让只读面板承担状态机风险；写操作等 review 语义稳定后另开提案。

**展开 MASTER 消息时重新排版成卡片。** 否决：投递证据的价值在“原文”；重排会引入解释层，且与 `formatMasterMessage` 的真相源分叉。

**用 `sidebar.panellist` 做入口。** 否决：该 slot 只能切主区 panel，无法打开右侧栏 tab。

## Acceptance criteria

- [P1] 右侧栏出现 `Cowork` tab，可从底栏 “Cowork” 按钮与 guide entry 打开；tab 是 session scope，标题与图标符合设计 — `source`
- [P2] >480px 左右分栏、≤480px 钻取；状态计数 chips 与优先级排序/默认选中符合契约 — `source`、`tests`
- [P3] 详情展示 summary / verification / changedPaths / 交接单路径；MASTER 消息默认折叠，展开内容与 host 的 `formatMasterMessage` 原文逐字一致 — `source`
- [P4] “复制交接单路径”复制绝对路径并在失败时给明确提示；“打开 thread 会话”导航到对应会话 — `source`
- [P5] 七种状态与 light/dark 全部可复现；只消费公开 token 或带 fallback 的内部别名，不自造色板 — `source`、`tests`
- [P6] `/dsh-cowork/api/overview` 与 `/api/handoff` 仅 loopback、只读、有界；`project/not-initialized`、`handoff/not-found`、`store/corrupt` 映射到对应 UI 状态 — `source`
- [P7] 客户端能力探针通过：client bundle 被加载、tab 挂载、token 生效、HMR/重建路径写进文档；`npm run typecheck` / `npm run build`（含 client）通过 — `packaging`
- [P8] 文档同步：面板结果与限制入 docs、`docs/publish.json` 分类、M3 交接文档更新，`npm run check` 通过 — `publication`

## Risks

- 客户端构建链在仓库内不存在（M0 删除）→ 先做探针；失败则只交付 host API 与文档，不硬做 UI。重审条件：宿主 client API 变化。
- 右侧栏 slot/宽度/入口 API 可能随版本变化 → 探针锁定版本事实；宽度从 `computeColumns` 公式读取，不写死 648。
- 公开 token 只有 14 个，内部别名不在契约里 → 只用 14 个 + `color-mix`/fallback；新增视觉前先查 Theme provider。重审条件：宿主扩充公开 token。
- 只读 API 与 M2 的 worktree/memory 字段并行演进 → 字段只增不改；面板对未知字段忽略。
- 会话 cwd 不在项目根时面板应显示 empty，而不是猜项目 → host 用 `findProjectRoot` 判定。
- `masterMessage` 由服务端生成，若与投递时刻的格式器版本不一致会漂移 → 记录生成版本/时间，文档写明。

## Delivery stages

1. P0 客户端能力探针：最小 tab + footer action，证明挂载/token/构建/热更新，记录限制。
2. P1 只读 API：`/api/overview`、`/api/handoff` + 单测（loopback、错误码、有界）。
3. P2 面板实现：列表/详情/状态/动作/主题/键盘与 a11y。
4. P3 真实宿主 E2E：用 browser-skill 打开右侧栏，覆盖七状态与两宽度，截图对照设计稿；失败项如实记录。
5. P4 文档：面板结果、限制、未验证项；提案迁入 implemented。
