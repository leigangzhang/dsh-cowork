# Proposal: 主题页前端开发（列表、两行卡片、归档/恢复菜单与视图模型）

Status: proposed
Date: 2026-11-10
Class: feature

## Problem

主题页的设计已按讨论结果定稿：右侧栏只保留列表；卡片两行（主题名 + 摘要）；待授权等标记在主题名右侧，时间在摘要右侧；边框按分组着色（阻塞红、运行中绿、空闲黑、已解决灰）；⋯ 菜单只放归档或恢复；不展示决策记录和审查状态；空闲阈值是最后一次活动后 1 天；归档不弹确认、可恢复；恢复不写主会话记录。设计文档是 `docs/design/cowork-sidebar/topic-page.md`。

当前前端仍是 v1 的列表 + 详情结构。`src/client/panel.tsx` 用 `chooseLayout` 在宽度大于 480px 时并排列表和详情，详情由 `src/client/detail.tsx` 渲染工作项与评审请求；`src/client/list.tsx` 的每一行除了状态点，还渲染 `reviewLabel`（审查状态）和 `hasActiveWork`（工作项标记）。卡片字段、布局和动作都与定稿不一致：主题页不应展示审查状态、工作项数和列表/详情分栏。

后端暂停，前端不能等新接口才开始：分组、卡片、菜单、空态和错误态可以先用 fixture 做；归档/恢复可以复用现有的 `POST /api/cowork.topic.resolve` 和 `POST /api/cowork.topic.reopen`。真正缺的是"待授权"和"阻塞原因"字段：现在的 `PanelTopic` 只有 `awaitingReview`；没有新字段时，前端不能把评审状态当成权限状态，宁可不显示"待授权"和"需要你处理"。

## Proposal

**1. 范围与承载面。** 只改右侧栏 Cowork 的"主题"标签：单列列表，取消列表/详情分栏；点卡片用 `uiWorkspace.openSession(topicId)` 打开主题会话；主题页不放输入框、不放会话提醒卡、不放决策记录。分配、上报、决策提案、待授权在主会话和主题会话里的提醒由宿主会话侧实现，不属于这个页面的前端范围。demo 左侧的主会话/主题会话只作为流程参考。

**2. 视图模型。** 在 `src/client/model.ts` 增加 `buildTopicViewModel(overview)`，输出：

- `groups`: `blocked` / `running` / `idle` / `resolved` 四组，按此顺序；每组 `count`。
- `card`: `{ topicId, title, digest, updatedAt, marker, canArchive, canRestore }`。`marker` 只允许 `'authorization' | 'waiting-master' | null`；不携带 `reviewStatus`、`awaitingReview`、`workItems`、`cwd`、`scope`。
- 分组规则：`resolved` 优先；否则 `blocked`（含待授权）；否则 `status === 'idle'`；否则 `running`。
- 待授权只认新字段 `awaitingAuthorization`；没有该字段时不显示"待授权"，不用 `awaitingReview` 兜底。
- 标记规则：`awaitingAuthorization` → 待授权；`blocked && !awaitingAuthorization` 且有 `blockedReason` → 等待主会话。
- `needsYou` 只统计 `awaitingAuthorization`；已解决组默认折叠；组内按 `updatedAt` 从新到旧排序。
- 相对时间沿用现有的 60 秒时钟（`CLOCK_TICK_MS`）。

**3. 组件与文件。**

- `src/client/list.tsx`：重写为 `TopicList`、`TopicGroup`、`TopicCard`、`TopicStates`（loading / empty / error）。卡片用 `<article>`；标题和摘要组成一个主按钮（打开会话），⋯ 是它的兄弟按钮，避免按钮嵌套。菜单项只有一个状态动作：`归档` 或 `恢复`。
- `src/client/panel.tsx`：保留外壳、加载和 `needsYou` 入口；删除 `TopicDetail`、布局测量和 split/drill 分支；`needsYou` 点击调用 `openSession(topicId)`。宿主若能定位到具体提醒消息，再加锚点参数；当前只保证打开会话。
- `src/client/api.ts`：只保留 `loadOverview`、`resolveTopic`、`reopenTopic`；归档/恢复复用现有 master-only 路由，不新增接口。`loadTopic`、`moveTopic` 不再从主题页调用。
- `src/client/styles.ts`：两行卡片、分组边框、菜单（用 portal 或固定定位，避免被侧栏滚动容器裁剪）、378px 下的省略和焦点样式。颜色优先用公开主题 token，demo 里的 hex 作为 fallback。
- `src/client/contracts.ts` 或本地类型：`PanelTopic` 增加可选 `awaitingAuthorization?: boolean` 和 `blockedReason?: string`。前端先按可选字段实现，fixture 覆盖有和无两种情况。
- 去掉主题标签对 `src/client/detail.tsx` 的使用；工作项页后续是否需要其中的工作项/评审渲染，在阶段 4 决定迁移，不在本提案里保留入口。

**4. 交互与错误。**

- 卡片点击：`openSession`；失败沿用现有的打开失败提示。
- 归档/恢复：点击即执行，不弹确认；先乐观更新分组和计数，失败回滚并显示回执；`request/not-master` 映射为"只有主会话可以操作"；操作进行中禁用菜单项，防止重复提交。
- 归档后卡片进入已解决组并展开；恢复后回到运行中；不新增主会话消息（该行为由后端负责，前端不加提示条）。
- 菜单：`Escape` 关闭、点外部关闭、键盘可达、`aria-expanded` / `aria-haspopup`；在列表底部时向上翻转。
- `needsYou` 入口：只在 `awaitingAuthorization > 0` 时出现；点击打开对应主题会话；不打开独立队列。

**5. 样式。** 卡片只有两行文字；标题和摘要都单行省略，`min-width: 0`。边框：阻塞沿用当前红色，运行中绿色，空闲黑色，已解决灰色，与 demo 一致。不显示生命周期、工作项数、审查状态、决策记录字段，也不显示 id、cwd、scope。

## Demo

- 列表、主会话/主题会话流程参考：[topic-demo-v2.html](../../../../docs/discussion/topic-demo-v2.html)，样式 [topic-demo-v2.css](../../../../docs/discussion/topic-demo-v2.css)
- 截图：[topic-demo-v2.png](../../../../docs/discussion/topic-demo-v2.png)、[topic-demo-v2-overview.png](../../../../docs/discussion/topic-demo-v2-overview.png)、[topic-demo-v2-archive.png](../../../../docs/discussion/topic-demo-v2-archive.png)
- 卡片样式：[topic-card-style.html](../../../../docs/discussion/topic-card-style.html)，[topic-card-style.png](../../../../docs/discussion/topic-card-style.png)
- 设计文档：[topic-page.md](../../../../docs/design/cowork-sidebar/topic-page.md)
- 阅读顺序：先看 `topic-card-style.png` 和 `topic-demo-v2.png` 的右侧栏；左侧主会话和主题会话里的提醒卡是后端会话侧的实现参考，不在本页面前端范围内。

## Alternatives considered

**保留现有列表 + 详情，只换卡片样式。** 否决：详情里就是工作项和评审请求，定稿已经明确主题页不展示决策记录和审查状态；保留详情会把刚移除的信息换个位置显示回来。

**把 demo 用 iframe 嵌进面板，作为实现。** 否决：只能当原型。生产实现需要面板数据、键盘、主题色和宿主 session 导航，iframe 还要 `postMessage` 桥接，样式和可访问性都难与原生一致。

**新建一个主区域整页。** 否决：会替换主会话，和"左侧主会话 + 右侧栏"的布局冲突；宿主侧栏入口的公开注册方式也未核实。

**等后端把字段和归档行为全部定完再写前端。** 否决：列表、卡片、分组和菜单可以用 fixture 和现有 resolve/reopen 路由先落地；把可选字段的缺失做成明确的降级，比等接口更能提前发现问题。

**在主题页里再渲染一份分配/上报提醒。** 否决：提醒在会话记录里，重复一份会形成第二队列，也违反"需要你处理只是入口"的定稿。

**引入全局 store。** 否决：这个页面只有一个数据源和少量本地交互，`panel.tsx` 的局部状态加视图模型足够。

## Acceptance criteria

- [F1] `buildTopicViewModel` 输出四组、组内计数、卡片标记和 `needsYou`；卡片字段不含 `awaitingReview`、`reviewStatus`、`workItems`、`cwd`、`scope` — `source`
- [F2] 卡片只有两行：主题名 + 摘要；标记在主题名右侧、时间在摘要右侧；边框颜色按分组与 demo 一致；378px 下标题和摘要单行省略 — `source`
- [F3] 卡片 ⋯ 菜单只有当前状态的一个动作；归档/恢复不弹确认，走现有 resolve/reopen 路由，乐观更新失败可回滚，重复点击不会重复提交 — `source`
- [F4] 点卡片和 `needsYou` 都调用 `openSession`；主题页不渲染详情、输入框、决策记录和会话提醒 — `source`
- [F5] 视图模型测试覆盖四组归类、计数、标记、`needsYou`、已解决折叠、空态和错误态、相对时间 — `tests`
- [F6] 没有 `awaitingAuthorization` 字段时，页面不显示待授权标记和 `needsYou`，也不从 `awaitingReview` 推断 — `tests`
- [F7] `npm run typecheck`、`npm run build`、`npm test` 全部通过，客户端包能注册并渲染主题标签 — `source`
- [F8] 设计文档、demo 截图和实现后的卡片/菜单一致；README 索引仍指向最新 demo — `plan-docs`

## Risks

- 待授权、阻塞原因和归档/恢复的会话行为还在后端设计里；字段名或语义变了，视图模型要跟着改。前端先把它们做成可选字段，缺字段时明确降级，不猜。
- 移除详情会暂时失去工作项/评审查看入口；主题页不展示它们是定稿，但工作项页还没实现，需要和后端/工作项页排期一起上线，避免用户没有地方看。
- 现有 `resolve`/`reopen` 路由能支撑按钮，但"归档只留一条主会话消息、恢复不写消息、归档使待授权失效"属于后端；前端可以先把交互做出来，端到端验收要等后端确认。
- 菜单在 378px 侧栏里容易被滚动容器裁剪；按钮嵌套、长标题、键盘焦点和对比度都要在实现时单独检查。demo 是原型，不是可直接使用的组件。
- demo 左侧的主会话/主题会话容易让人以为也归这个页面做；实现和验收时只按右侧栏的主题列表检查。
- 需要重估的条件：后端把会话提醒做成由这个面板渲染，或宿主提供"定位到具体提醒消息"的接口；两者都会改变本提案的边界。

## Delivery stages

1. 视图模型、fixture、列表/卡片、空态/错误态和测试——不依赖后端字段，先把两行卡片和分组做对。
2. 卡片菜单与归档/恢复——复用现有 resolve/reopen 路由，做乐观更新、回滚和 master-only 错误处理。
3. 实时刷新和 `needsYou` 入口——加载时/回到前台刷新，入口打开主题会话；`awaitingAuthorization` 有则显示，没有则降级。
4. 移除旧的详情/审查入口，更新交互稿截图和设计文档，跑 `typecheck`/`build`/`test` 收口。
