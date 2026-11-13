# Decision: 主题页前端：四组两行卡片与单动作菜单

Status: implemented
Date: 2026-11-10
Class: feature

## Problem

主题页的设计定稿是右侧栏单列列表：四组（阻塞 / 运行中 / 空闲 / 已解决）、两行卡片（主题名 + 一行摘要，标记在主题名右侧、时间在摘要右侧）、边框按分组着色、⋯ 菜单只放归档或恢复、顶部「需要你处理」只统计待授权、已解决默认折叠、378px 下仍可用。设计见 [topic-page.md](../../../../docs/design/topic/topic-page.md)。

原前端仍是 v1：`src/client/panel.tsx` 在宽度大于 480px 时并排列表和详情；`detail.tsx` 渲染工作项与评审请求；`list.tsx` 每行还渲染审查状态和工作项数；卡片字段、布局和动作都与定稿不一致。分配、上报、决策提案、待授权在主会话/主题会话里的提醒卡也属于本页面的视觉体系，但由宿主 notice 通道承载；宿主没有该通道时按 B 只保留模型和 feature-detect，不注册。

## Decision

**视图模型。** [src/client/model.ts](../../../../src/client/model.ts) 的 `buildTopicViewModel(overview)` 输出四组（`blocked`/`running`/`idle`/`resolved`，固定顺序、每组 `count`；已解决 `collapsedByDefault`）与 `needsYou`。分组规则：`resolved` 优先；否则 `blocked` 或 `awaitingAuthorization`；否则 `status==='idle'` 属于空闲；其余运行中。卡片 `TopicCardView = { topicId, title, digest, updatedAt, marker, canArchive, canRestore }`，不携带 `awaitingReview`、`reviewStatus`、`workItems`、`cwd`、`scope`。`marker` 只允许 `'authorization' | 'waiting-master' | null`：`awaitingAuthorization` → 待授权；`blocked` 且有非 authorization 的 `blockedReason` → 等待主会话；没有新字段时降级为无标记，绝不用 `awaitingReview` 推断。`needsYou.count` 只统计 `awaitingAuthorization`，`topicId` 取 blocked 组里第一张待授权卡；组内按 `updatedAt` 新到旧、同时间按 topic id 稳定排序。相对时间沿用 `CLOCK_TICK_MS` 60 秒时钟。

**组件。** [src/client/list.tsx](../../../../src/client/list.tsx) 重写为 `TopicList` / `TopicGroup` / `TopicCard` / `TopicStates`。卡片是 `<article>`，标题+摘要是一个打开会话的 `<button class="cw-card-open">`，⋯ 是它的兄弟按钮，不嵌套；第一行主题名 + 标记，第二行摘要 + 时间；⋯ 菜单固定定位、单动作（归档或恢复）、`role=menu`/`menuitem`、`aria-haspopup`/`aria-expanded`、Escape 关闭并回焦、点外部关闭、窗口 resize/滚动重新定位、列表底部向上翻转。`TopicStates` 覆盖 loading / empty / error。空分组不渲染组头，但模型始终输出四组。

[src/client/panel.tsx](../../../../src/client/panel.tsx) 保留外壳、加载、刷新和「需要你处理」入口；删除 `TopicDetail`、布局测量、split/drill 分支和 v1 收件箱 chip。header 只保留项目路径、面包屑和刷新；`刷新` 按钮用 `flex:none` + `white-space:nowrap`，381px 下保持单行（收口修复 `bbb85b3`）。点卡片和 needsYou 都调用 `uiWorkspace.openSession(topicId)`（先容错 unarchive；打开失败显示回执）。归档/恢复点击即执行，不弹确认：先乐观改本地分组、请求 master-only 路由、失败回滚单张卡并显示回执；同一 topic 请求进行中禁用菜单项。`request/not-master` 映射为「只有主会话可以操作」。

[src/client/api.ts](../../../../src/client/api.ts) 只保留 `loadOverview`、`resolveTopic`、`reopenTopic`；`loadTopic`/`moveTopic` 不再从主题页调用。`WireTopic` 在 `PanelTopic` 基础上保留可选的 `awaitingAuthorization`/`blockedReason`，`parseTopicRow` 总是归一化这两个字段；主题页不读 review 字段。

**样式。** [src/client/styles.ts](../../../../src/client/styles.ts) 定义两行卡片、四组边框（阻塞红、运行中绿、空闲黑、已解决灰）、固定定位菜单、381px 下的标题/摘要单行省略（`overflow:hidden; white-space:nowrap; text-overflow:ellipsis; min-width:0`）；颜色优先公开主题 token，demo hex 作 fallback。标题和摘要都单行省略，卡片不显示生命周期、工作项数、审查状态、决策记录、id、cwd、scope。

**移除的 v1 面。** 删除 `src/client/detail.tsx` 与 `src/client/chips.tsx`；主题标签不再有列表/详情分栏、工作项/评审请求渲染、改投表单和审查状态标记。工作项页是否复用其中组件在后续页面阶段决定，本记录不保留入口。

**会话提醒卡（A2，B 降级）。** 新增 [src/client/notice-model.ts](../../../../src/client/notice-model.ts) 与 [src/client/notice.tsx](../../../../src/client/notice.tsx)：kind 为 assignment/report/proposal/authorization/archive，status 为 pending/allowed/denied/void，actions 为 allow/deny/open-topic/open-work-item；一个 notice 只渲染一张卡，`noticeId` 相同的 update 原位替换、幂等、不新增；分配/上报只读，提案带 open-work-item（目标页未实现时隐藏），待授权在主会话提供去主题入口、在主题会话提供允许/拒绝，归档只在主会话且无动作；渲染器不 prompt、不 append 记录。运行宿主没有 `ctx.sessionNotices`，`ctx.inject(['sessionNotices'], ...)` 的 feature-detect 永不触发，因此 B 下**不注册**任何聊天节点，主题页也不渲染提醒卡。

**B 模式偏离。** 由于 A2 宿主不可用，本阶段交付的是侧栏列表、菜单、needsYou 和 notice 纯模型/渲染器；主会话/主题会话的 1:1 提醒卡延期到宿主 A2 发布。A2 适配器落地时应把 `registerNoticeRenderer(ctx)` 接到宿主 notice seat，并复用同一模型测试。

## Alternatives considered

**保留列表+详情，只换卡片样式。** 否决：详情就是工作项和评审请求，保留详情会把刚移除的信息换个位置显示回来。

**把 demo 用 iframe 嵌进面板。** 否决：只能当原型；生产需要面板数据、键盘、主题色和宿主 session 导航，iframe 还要 postMessage 桥接。

**新建主区域整页。** 否决：会替换主会话，与「左侧主会话 + 右侧栏」冲突，宿主侧栏入口的公开注册方式也未核实。

**等后端字段全部定完再写前端。** 否决：分组、卡片、菜单、空态和错误态可以用现有 overview/fixture 先落地，可选字段缺失时显式降级；后来也证明并行把字段契约和 UI 的边界提前暴露了。

**在主题页再渲染一份分配/上报提醒。** 否决：提醒在会话记录里，重复一份会形成第二队列。

**把 A2 notice 做成 `user/message` 或 tool call。** 否决：`user/message` 会进入模型历史并显示成用户消息；tool call 会伪造模型工具调用，污染会话结构。

**只做侧栏，不做会话提醒卡（B）。** 本阶段因宿主能力不可得而采用；记录偏离，不在 UI 里假装提醒卡已存在。

**用 A1 的 plugin record 渲染会话卡。** 未选：宿主只授权 `packages/experimental/` 调用 `appendPluginRecord`；A2 提供一等服务和 update/actions。

**引入全局 store。** 否决：这个页面只有一个数据源和少量本地交互，`panel.tsx` 的局部状态加纯视图模型足够。

## Consequences

- 主题页现在是单列四组列表，打开卡片只切换主区；不再有详情、输入框、工作项/评审请求、审查状态或改投入口。
- 已解决组默认折叠，归档后展开并把卡移入已解决；恢复后回到运行中。菜单只有一个动作，归档/恢复不弹确认，失败可回滚。
- 381px 面板下标题和摘要单行省略；卡片不因长标题撑开侧栏。`刷新` 按钮不收缩、不换行，header 用 `flex-wrap:nowrap` 固定单行；v1 收件箱 chip 已移除（收口修复 `bbb85b3`）。
- `needsYou` 是页面顶部唯一入口，只统计待授权；v1 收件箱 chip 已移除，头部不再出现「待处理 N」（收口修复 `bbb85b3`）。
- B 模式没有主会话/主题会话提醒卡；用户只能通过主题页状态与 master 的 `cowork_notices` 感知上报/提案/待授权。A2 发布后需要补注册和真实 GUI 探针。
- 主题页移除工作项/评审入口后，用户暂时没有页面查看这些内容；工作项页实现是后续阶段的前置。
- `openTopic` 对每个卡先尝试 unarchive（live topic 会拒绝，错误被忽略）再 openSession；这是对已归档会话的容错，不是常规路径。
- 本次实测 381.5px 面板宽、卡片 369.5px；标题/摘要的 `scrollWidth > clientWidth` 与 ellipsis 计算样式通过 DOM 断言，真实 Chrome 截图见证据目录。
- 已修复的视觉偏差：header 收件箱 chip 与 381px「刷新」换行已在收口提交 `bbb85b3` 移除/固定，不再进入 KNOWN_ISSUES。
- A2 会话卡延期、工作项页未实现两条进入 [KNOWN_ISSUES](../../../../docs/KNOWN_ISSUES.md)。

## Testing

- [F1] `buildTopicViewModel` 输出四组、组内计数、卡片标记和 needsYou；卡片字段不含 awaitingReview/reviewStatus/workItems/cwd/scope — `tests`：`tests/panel-model.test.mjs`（`four groups always come out in fixed order with labels, counts and fold state`、`cards carry exactly the contract fields and never the retired ones`、`needsYou counts only awaitingAuthorization and points at the newest waiting topic`）
- [F2] 卡片只有两行：主题名 + 摘要；标记在主题名右侧、时间在摘要右侧；边框颜色按分组与 demo 一致；381px 下标题和摘要单行省略 — `source` / `tests`：`src/client/list.tsx`、`src/client/styles.ts`；真实 Chrome 381.5px 面板 DOM 测量（titleClient 327/titleScroll 1050、digestClient 281/digestScroll 1320、ellipsis/nowrap/hidden）与截图
- [F3] 卡片 ⋯ 菜单只有当前状态的一个动作；归档/恢复不弹确认，走现有 resolve/reopen 路由，乐观更新失败可回滚，重复点击不会重复提交 — `source` / `tests`：`tests/panel-model.test.mjs`（`a card offers exactly one action derived from its state`、`archive and restore receipts name the topic; a master-only refusal is fixed copy`、`the card menu stays on screen and flips above a button near the bottom`）；真实 Chrome 归档→resolved/恢复→active 的索引与活动证据
- [F4] 点卡片和 needsYou 都调用 openSession；主题页不渲染详情、输入框、决策记录和会话提醒 — `source` / `tests`：`tests/panel-model.test.mjs`（`opening a topic has fixed steps and a master breadcrumb only for topic sessions`、`the topic page API module keeps only overview, archive and restore`）；真实 Chrome 点击真实 topic 卡后主区标题变为 `cowork: GUI 验证主题`
- [F5] 视图模型测试覆盖四组归类、计数、标记、needsYou、已解决折叠、空态和错误态、相对时间 — `tests`：`tests/panel-model.test.mjs`（`grouping: resolved wins, authorization blocks, idle only when unblocked, active runs`、`markers: authorization first, waiting-master only with a blocked reason, never from review`、`cards sort newest first inside a group and fall back to a stable id order`、`an empty overview still yields the four groups and no needs-you entry`、`surfaceState separates loading, empty, error and the list`、`relative time covers minutes, hours, days and the absolute fallback`）
- [F6] 没有 awaitingAuthorization 字段时，页面不显示待授权标记和 needsYou，也不从 awaitingReview 推断 — `tests`：`tests/panel-model.test.mjs`（`no awaitingAuthorization field means no marker and no needs-you entry`、`parseTopicRow keeps the optional authorization fields and degrades invented values`）
- [F7] `npm run typecheck`、`npm run build`、`npm test` 全部通过，客户端包能注册并渲染主题标签 — `tests`：集成 HEAD `442312a`，`npm test` 845/845、`npm run typecheck`/`npm run build`/`npm run check` exit 0；真实 profile 加载 `lib/client.js` 并渲染 Cowork 标签
- [F8] 设计文档、demo 截图和实现后的卡片/菜单一致；README 索引仍指向最新 demo — `plan-docs`：[topic-page.md](../../../../docs/design/topic/topic-page.md)、[README.md](../../../../README.md)、[docs/design/topic/assets/topic-demo.html](../../../../docs/design/topic/assets/topic-demo.html)；真实 Chrome 截图见证据目录，已知偏差记录在 KNOWN_ISSUES
- [F9] A2 notice 渲染器按 kind 渲染 1 张卡：分配/上报只读，提案带 open-work-item，授权带 allow/deny 或 open-topic，归档只主会话；status 更新原卡不新增；不触发 prompt — `source`：`src/client/notice-model.ts`、`src/client/notice.tsx` 与 `tests/notice-model.test.mjs`。**B 下不注册**，真实会话卡未出现；F9 的会话呈现部分延期到宿主 A2 阶段
- [F10] notice 模型测试覆盖 kind/status/actions、主会话/主题会话差异、update 幂等和无目标动作隐藏 — `tests`：`tests/notice-model.test.mjs`（`kind, status and action labels cover the frozen contract`、`authorization differs per audience: master opens the topic, the topic allows or denies`、`one notice renders one card; duplicate ids keep the last state in the first position`、`an update replaces the original card in place and is idempotent`、`an open action without a target is hidden`、`the notice renderer never prompts the model or appends records`）
- [F11] A2 不可用时 notice 渲染器不注册并走 B，偏离记录在设计文档与 KNOWN_ISSUES；真实 GUI 探针结果归档 — `decisions`：`tests/notice-model.test.mjs`（`B feature detection: no host session-notice service means no registration`）、[topic-page.md](../../../../docs/design/topic/topic-page.md)、[KNOWN_ISSUES](../../../../docs/KNOWN_ISSUES.md)、`/tmp/topic-page-verify/GUI_EVIDENCE.json`
