# 工作项前后端实现交接

- 日期：2026-11-19
- 状态：已实现（阶段 0–5 与 demo 对齐批次 A/B 已交付至 2026-11-22；结果见 [WORK_ITEM_RESULT](WORK_ITEM_RESULT.md)）
- 当前分支：`agent/work-item-docs-facts`（已推送），基于 `main` `3b140e3`
- 事实核对提交：`2e98886`（5 份工作项文档按当前代码校正，仅文档）
- 工作区：`/Users/ray/Workspace/dsh-cowork`
- 环境：Node `v22.22.1`；运行宿主 DSH `0.2.1-rc.2`；源码 checkout `~/Workspace/deepseek-harness`（`dsh-v0.2.2-rc.2`）
- 基线（HEAD `2e98886`，2026-11-19）：`npm run check` 全绿；`npm run typecheck` exit 0；`npm test` 1276/1276；`npm run build` exit 0；`npm run test:host-smoke` 5/5

本文件是执行交接：只记录目标、已冻结的决定、执行顺序、门禁和停点。页面细节在设计与核实文档里，不在本文件重复。

## 先读

1. [工作项查看器设计](../design/work-item/work-item-artifact-viewer.md)
2. [前端设计与开发方案](../design/work-item/work-item-frontend.md)
3. [后端调研、架构与实现设计](../design/work-item/work-item-backend.md)
4. [V1–V16 核实报告](../design/work-item/work-item-artifact-verification.md)
5. [多类型文件嵌入研究](../design/work-item/work-item-artifact-embedding-research.md)
6. 前端决策：[2026-11-10-work-item-page-frontend.md](../../.agents/notes/implemented/feature/2026-11-10-work-item-page-frontend.md)；后端决策：[2026-11-10-work-item-page-backend.md](../../.agents/notes/implemented/feature/2026-11-10-work-item-page-backend.md)
7. 相关设计：[主题页](../design/topic/topic-page.md)、[收件箱](../design/inbox/topic-inbox.md)、[Artifact 工作室与活动流](../design/artifact-studio/artifact-studio-activity-stream.md)、[项目记忆](../design/memory/project-memory-tab.md)、[跨对象决策](../design/cross-cutting/cross-cutting-decisions.md)
8. 工程面：[testing.md](../testing.md)、[agent-teams.md](../agent-teams.md)、[KNOWN_ISSUES.md](../KNOWN_ISSUES.md)、[tools/workflow.json](../../tools/workflow.json)

两份提案已按记录规则改写为 implemented（2026-11-22），其中的 `src/work-item.ts`、六条路由等是提案时的快照；实现以设计文档和当前代码为准。`agent/work-item-implementation-plan` 分支上的旧执行计划基于旧 `main` 与旧路径，不要按它执行。

## 本轮目标

实现工作项页面的前后端：右栏工作项列表、主区域多模态查看器、逐行/区域批注、文本编辑与冲突合并、模型投递与回复、附件、SSE 状态。

采用纵向切片：每阶段同时交后端和前端，跑通一条可演示链路后再扩类型。不要先做完全部后端或全部八种渲染器再联调。

## 定稿事实（不要重新讨论）

- 后台记录叫 `artifacts`，界面叫“工作项”；旧代码隔离 `workItems` 不合并、不复用字段。
- 查看器在主区域；右栏只做工作项列表和状态汇总。右栏内部标签规划为 主题 / 工作项 / 活动记录 / 项目记忆，但当前实现只有主题页 v2 + 收件箱（宽面板两列、窄面板横幅）。工作项是第二个内部标签，不新增 `sidebar.panellist` 入口。
- 查看器注册为 root `main` 的 keyed panel，key 为 `cowork-work-item`；`ctx.layout` 是可选注入，缺失时只退化打开/返回。
- 左侧栏切换会话时查看器自动关闭；用 `ctx.sessions.retainInfo(sessionId).retainedBy.mainView` 观察打开时的会话是否仍是主区域选择。
- 存储独立在 `<repo>/.dsh-cowork/artifacts/`，不改 `ProjectIndexV2`、不与项目索引共用锁。
- 工作项状态 `pending-view/pending-confirm/needs-feedback/in-progress/confirmed` 与投递状态 `queued/sent/thinking/working/replied/failed/blocked/stale` 是两条状态轴，不混用。
- 保存用版本号乐观并发；冲突先做行级三方合并，重叠才返回 409 给冲突 UI；修订快照最多 20 个/文件。
- 编辑范围每 300ms 上报、5 秒 TTL；`tools.guard` 只拦 `write`/`edit`/`str_replace_editor`，bash 绕过是已确认缺口。
- 首版创建入口只有 `cowork_artifact_create`（登记项目内已有文件）；上传只服务评论/回复附件；用户上传新建工作项后置到阶段 5。
- 不做评审/CI/多人权限/Doc、表格、PDF、图片类型（2026-11-22 永久移出目标）。Excalidraw 不带 Xiaolai 中文字体；客户端上限 100 MB，包体按 10 MB 控制。

## 当前代码与宿主基线

仓库事实：

- 面板 API 当前为 24 条 exact route；25 个业务工具；3 个 preset；3 个 exports（以 `tests/support/public-surface.mjs` 为准）。新增路由/工具会同时触动 `tests/support/public-surface.mjs`、`tests/guards/tool-schema-budget.test.mjs`。
- `src/` 只能按 `app/platform/store/domains/tools/panel/dev` 分层，根只有 `src/index.ts`；`tests/guards/architecture.test.mjs` 执行 import 方向，`tests/guards/source-budget.test.mjs` 执行 50 KiB 与嵌套 `index.ts` 限制。
- 工具 schema 预算以 `tests/guards/tool-schema-budget.test.mjs` 为准（25 个工具/18,546 B）；新增工具必须显式提高这个数字。
- 源文件覆盖率按 `tools/coverage-map.json` 的唯一 owner 逐文件 100% 行覆盖；`tools/coverage-debt.json` 是空的审核例外表。
- 客户端构建是 `scripts/build/build-client.mjs` 用 esbuild 打的单文件 CJS 闭包（externals 为 `react`/`react-dom`/`@deepseek-ai/*`），当前不能产出分块；宿主 `client-modules` 的 `require.async` 分块由 tsdown 构建消费。
- 交接时（2026-11-19）客户端 build 输出 138,237 B（gzip 29,206 B；esbuild min 89,118 B）；后续实测值见 [WORK_ITEM_RESULT](WORK_ITEM_RESULT.md)。

宿主能力（行号按 checkout `dsh-v0.2.2-rc.2`，运行宿主 0.2.1-rc.2 行号不同，见[后端设计](../design/work-item/work-item-backend.md)的“宿主调研”）：

- `main` 是 root keyed 槽位，`ctx.layout.selectPanel(key)` 切换，未注册 key 抛错。
- `ctx.sessions.retainInfo(id).retainedBy.mainView` 可观察会话是否仍是主区域选择。
- `ctx.fs` 提供 `resolve/readText/writeText/editText/watch`，写入支持 `replaceIfVersion`；`ctx.tools.guard` 可在执行前拒绝工具调用。
- 连接层支持逐块写 `Response.body`，HMR 的 `/plugins/events` 是同源 SSE 先例。
- 附件、`openWorkspacePath`、`sessionController.prompt` 的 `queue`/`followup` 能力已有源码依据。

## 执行顺序

### 阶段 0：契约与门禁（约 1 天）

后端：

- 新增 `src/panel/artifact-contract.ts`：路由常量、wire 类型、错误码、上限；登记到 `tests/guards/architecture.test.mjs` 的 `CONTRACT_MODULES` 纯叶白名单，客户端才可直接 import。
- 冻结记录/状态/锚点/评论事件/投递/事件/上限的形状；以[后端设计](../design/work-item/work-item-backend.md)的“数据模型（v1）”为准。前端 `ArtifactRecord` 视为投影，wire 真值用 `ArtifactRecordV1.files[]`。
- 按切片创建模块，不留空文件；阶段 1 先落 `src/store/artifact-{schema,store}.ts`、`src/panel/artifact-api.ts`、`src/tools/artifact.ts`，阶段 2/3 再加 `src/platform/artifact-{files,presence,events,dispatch}.ts` 和 `src/domains/artifact/`。位置与接线见[后端设计](../design/work-item/work-item-backend.md)的“模块与文件”。
- 为 store/fs/session/clock 定义端口，route 和 domain 不直接拿 `ctx` 或 `node:fs`。

前端：

- 只做接口确认：`src/client/work-item/` 目录、客户端复用 `artifact-contract.ts`、`ctx.inject(['layout'])` 的可选注入方案。
- 确认内部标签壳不会改写主题页/收件箱数据逻辑；标签 1 原样承载现有 `CoworkPanel` 内容。

退出标准：`npm run check`、`npm run typecheck` 绿；contract 单测通过；没有注册新路由或工具（工具预算不动）。

### 阶段 1：只读纵切（第一个可演示里程碑）

后端：

- `artifact-schema`/`artifact-store`：记录、评论、锚点、列表/详情、`.dsh-cowork/artifacts/` 布局与独立锁。
- 路由：`GET /api/cowork.artifact.list|detail|file|comments|events`、`POST /api/cowork.artifact.comment`（`dispatch:false`）、`POST /api/cowork.artifact.comment.resolve`、`POST /api/cowork.artifact.status`（`view`）。
- `cowork_artifact_create`；路径守卫、文件缺失、分页和上限；SSE 基础事件（`comment.created`/`comment.updated`/`artifact.updated`）。
- 测试：schema/store 单测、`tests/panel/artifact-api.test.mjs` 路由测试（复用 `tests/support/api-fixtures.mjs` 的临时仓库和 connection probe）、工具测试。

前端：

- 右栏标签壳：标签 1 现状，标签 2 `WorkItemList`，活动记录/项目记忆占位；不改变 620px 两列/窄栏横幅行为。
- `main` keyed panel `cowork-work-item`、打开上下文 store、返回会话、会话切换自动关闭。
- `WorkItemList`（状态分组、类型/评论数/附件数/更新时间）、查看器壳（标题/类型/状态、文档/版本/附件工具条）、Markdown 只读、行/行范围批注、评论栏、`queued` 前的普通评论状态。
- 空态/加载/错误/文件缺失；评论线程只显示本地评论/回复，不接投递状态。
- fixture 先行，再接真实路由。

验收：真实宿主里演示「右栏工作项标签 → 主区域 → 选行批注 → 刷新后线程仍在」；路由测试 + 客户端 model 测试 + 一次真实 Chromium 面板检查。SSE 认证、文件读取或路径守卫任一项在真实宿主失败，停下来先修，不进入阶段 2。

### 阶段 2：编辑、保存与同行锁

后端：

- 修订快照、`POST /edit`（`baseVersion`、200 合并结果、409 `conflictRanges`）、行级三方合并；`POST /presence`；`tools.guard` 同行判断与拒绝原因。
- 非文本/画布：版本不一致直接 409，不做行合并。

前端：

- CodeMirror 文本编辑器、800ms 防抖自动保存、保存状态、脏行 300ms 上报、409 冲突界面（查看差异/加载最新/保留我的）、合并成功回执。
- 画布编辑放到阶段 4，不在本阶段接 Excalidraw。

验收：用户改一段、模型改另一段能自动合并；同行冲突被守卫拒绝并在真实宿主可重试；保存失败不丢草稿。`tools.guard` 的真实参数/cwd 解析不成立就停止后续投递开发。

### 阶段 3：投递、回复与多模态

后端：

- dispatcher：1.5 秒合并窗口、每批最多 10 条、同会话串行、跨主题默认并行 4、队列上限、重试（1s/4s/15s，最多 3 次）、重启恢复（`sent/thinking/working` → `stale`）。
- `cowork_artifact_comments`、`cowork_artifact_reply`；评论默认投递；上传路由与附件引用；prompt 内容 bounded、评论按数据分隔、图片 content part。
- SSE `dispatch.updated`/`reply.created`；错误码与失败原因。

前端：

- 批注卡/列表卡/查看器顶部共享 `queued→…→replied` 状态，失败/阻塞可重试；附件条、图片缩略图、模型回复附件。
- 重连按 `Last-Event-ID`，重连后拉一次详情对账。

验收：真实宿主跑通一次「批注 → SSE 状态 → 模型修文件 → reply 工具 → 线程回复」；真实模型 E2E 记录看到图片 prompt、reply 采用率、双主题并行和重启 `stale`。prompt 带图片或 reply 工具持续不被调用时停下来调提示词/工具，不伪造回复。

### 阶段 4：类型扩展（2026-11-21 用户调整）

顺序：图表 → 画布 → HTML。Doc、表格、PDF、图片不在范围：2026-11-22 用户决定永久移出目标，未来按需再评估（KI-57）。

- 图表：Pele 渲染 Mermaid 源码 + CodeMirror 源码编辑；阅读/源码切换；行范围批注。节点级批注后置。
- 画布：Excalidraw 内建、整文件锁、自动保存；按当前单文件闭包构建随主包加载，不单独分块。元素级模型工具后置。
- HTML：静态沙箱预览（默认，不跑脚本）、可切换交互预览（`sandbox="allow-scripts"`，无同源权限）、CodeMirror 源码编辑；内容策略禁网络、表单和嵌套框架。
- 后端：类型推断已就位，本阶段不新增路由或存储；画布整文件锁复用 presence，编辑会话期间报告整个文件的行范围，`tools.guard` 对结构化写入的拒绝语义不变；画布过期保存直接 409，不做行级合并。
- 验收：真实 Chromium 面板分别打开三种类型，图表出 SVG/错误带行号、HTML 两种预览、画布可编辑保存且模型结构化写入被整文件锁拒绝；行批注在图表/HTML 源码视图可用。

阶段 1–2 期间并行做 Excalidraw spike（1–2 天）：验证 CJS/chunk、CSS/字体资源路由、`EXCALIDRAW_ASSET_PATH` 绝对 URL。结论决定单包还是改构建分块；不要拖到阶段 4 才试。不能改构建就把画布作为后续可选包并记录偏离。

### 阶段 5：收口

- 后端：`POST /rebind`、事件裁剪/reset、启动对账、列表缓存、路径/上传加固。→ 已交付；启动全量文件扫描未做，维持 detail/file 读时对账；event replay 静默丢事件已修。
- 前端：窄屏/键盘/焦点/空错态/性能/包体；工作项列表 200 条、线程 200 条折叠。→ 已交付；线程改为最近 200 条 + 加载更早。
- 文档：更新设计状态、README/索引、demo 截图与 KNOWN_ISSUES；两份提案已于 2026-11-22 改写为 implemented。→ 已交付。
- 全量门禁 + 真实 E2E；记录回滚方式和未核实项。→ 已交付（keyless E2E；live E2E 未跑，见结果记录的未核实项）。

并行与集成：契约冻结后，后端和前端可以两条线并行，同一分支内按切片合并；不要按层各做一套再对接。若使用 AgentTeams，按 [agent-teams.md](../agent-teams.md) 的 worktree、评审和交付门禁执行，写成员各自隔离，队长串行合并，不把并行写直接落进主工作区。

## 阶段 0 需要冻结的契约

- **共享契约**：`src/panel/artifact-contract.ts`；客户端直接 import，不手写第二份。
- **记录真值**：`ArtifactRecordV1`（`files[]`、`primaryPath`、`revision`、状态、计数）；前端投影可以叫 `ArtifactRecord`，但字段冲突时以 wire 为准。
- **路由分期**：阶段 1 `list/detail/file/comments/comment/comment.resolve/status/events`；阶段 2 `edit/presence`；阶段 3 `upload` + 默认投递；阶段 4 `open`；阶段 5 `rebind`。阶段 1 的 `comment` 只接受 `dispatch:false`，阶段 3 再接默认投递，默认值要显式写进契约，不静默变化。
- **工具分期**：阶段 1 `cowork_artifact_create`（22→23）；阶段 3 `cowork_artifact_comments`、`cowork_artifact_reply`（→25）；每次同步 `BUSINESS_TOOL_ORDER`/`TOOL_DOMAINS` 和工具 schema 预算。
- **存储**：`<repo>/.dsh-cowork/artifacts/` 下的 `artifact.json`、`comments.jsonl`、`dispatch.jsonl`、`revisions/`、`uploads/`、项目级 `events.jsonl`；独立 `.write.lock`。
- **SSE 事件**：`artifact.updated`、`file.changed`、`comment.created`、`comment.updated`、`reply.created`、`dispatch.updated`、`reset`。
- **错误码**：按后端设计的 `artifact/*` 清单；HTTP 状态与错误 envelope 沿用 `PanelApiError`/`PanelErrorBody`。
- **不改现有行为**：现有 10 条面板路由、22 个工具、旧 `workItems` 语义保持不变；新增路由/工具只做加法。

## 验收与命令

- 文档改动：`npm run check`。
- 每个实现切片：`npm run test:coverage`、`npm run typecheck`、`npm run build`、`npm run check`；涉及客户端 TSX 再跑 `npm run test:browser` 与 `npm run test:coverage:layered -- --base <verified-base>`。
- 交付前：`npm run test:host-smoke`；真实宿主 E2E（SSE、guard、图片 prompt、双主题、重启）。
- 真实宿主验证：优先用 `npm run test:browser`/测试 profile；需要手工 GUI 时用 dev 注入器与隔离 fixture repo，证据放 gitignored 目录，不写用户 profile 数据。浏览器/面板验证按 [testing.md](../testing.md) 与 R8/R9 规则：先修宿主健康与 overview API，再驱动 UI，复用浏览器会话，不用 sleep 当就绪。
- 推送前按 [pre-push-checks](../../.agents/skills/pre-push-checks/SKILL.md) 选证据，并用 `npm run change-scope -- --base <verified-base>` 确认范围。
- 详细验收条目见前端提案 `[W1]`–`[W9]` 与后端提案 `[B1]`–`[B7]`；它们是设计闸门，实现时拆进各阶段测试。

## 停点与风险

- SSE 认证/心跳/续传、`tools.guard` 真实参数、图片 prompt、reply 工具采用率是未真机验证项；对应阶段第一件事是跑真实宿主，失败就停。
- Excalidraw 的 CJS/chunk 与资源路由是最大实现风险；spike 不成立就记录偏离，不阻塞阶段 1–3。
- bash 可绕过同行锁；只能提示词约束 + 保存后校验，不能宣称完全阻止。
- 当前构建不能产出分块；懒加载 Excalidraw 需要先改构建或改方案。
- 列表扫描 500 条在慢盘可能超预算；先测再加 artifacts 摘要索引，仍不改 `ProjectIndexV2`。
- 会话切换自动关闭依赖 `retainedBy.mainView` 的宿主实现语义，不是专门事件；升级宿主时回归。
- 工作项页实现前用户没有工作项查看入口（[KI-41](../KNOWN_ISSUES.md)）；页面可用后同步处理入口。
- 运行宿主 0.2.1-rc.2 与源码 checkout 0.2.2-rc.2 行号不同；实现以运行宿主行为为准，文档引用只是指路。

## 新会话启动清单

- [ ] `git fetch`；`git status --short --branch` 确认在 `agent/work-item-docs-facts`、HEAD `2e98886`（或本文件提交后的 HEAD），工作区干净。
- [ ] 确认 `origin/main` 是否前进；不要仅为追平 main 改写实现分支，冲突按 pre-merge 规则处理。
- [ ] 跑基线：`npm run check`、`npm run typecheck`、`npm test`、`npm run build`、`npm run test:host-smoke`；记录实际结果。
- [ ] 读本文件 + 第 1–4 篇设计与核实文档；确认阶段 0 契约冻结清单。
- [ ] 阶段 0：contract、端口、门禁；单独提交。
- [ ] 阶段 1：后端只读 + 前端壳/列表/查看器；用真实宿主演示后再进阶段 2。
- [ ] 每个切片一个 commit；只 `git add` 本切片文件；提交信息用 Conventional Commits。
- [ ] 汇报：改了什么（路径）、验证命令和结果、回滚方式、遗留风险与未核实项。

## 不要做

- 不要按“后端全做完再前端”或“八种类型全做完再联调”推进；先打通只读主链路。
- 不要为每个阶段另建分支；当前 `agent/work-item-docs-facts` 就是本工作流的实现分支。不要自动合并 PR，合并是人工步骤。
- 不要把新模块平铺到 `src/` 根；不要新增嵌套 `index.ts`；不要把产物写进 `ProjectIndexV2`。
- 不要复用旧 `workItems` 的字段/状态；不要给工作项另注册一个 `sidebar.panellist` 入口。
- 不要为阶段 1 提前接编辑、presence、dispatch、上传；这些各有自己的阶段和门禁。
- 不要在未验证真实宿主 SSE/guard 前扩大投递范围；不要伪造 `replied`。
- 不要为了让门禁变绿而降低测试、放宽预算或跳过浏览器 lane。
