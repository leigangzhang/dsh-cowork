# 主题页前后端实现交接

- 日期：2026-11-10
- 状态：设计已确认，实现未开始
- 设计分支：`agent/topic-page-flow-design`；设计提交到 `b7e29f7`（已推送），本交接文档另有一个提交
- 写这份交接时最新 main 是 `616c9e3`（工作项前端计划已合并）。设计分支基于更早的 `105c0bd`；开始实现前先 `git fetch` 确认 main，再合到最新 main，检查 README、design 索引和 feature-todos 的冲突
- 工作区：`/Users/ray/Workspace/dsh-cowork`；目前只改过文档，`src/` 未动
- 设计相关提交：`3db3c01`（卡片颜色与交互稿）、`815fb7a`（前后端提案）、`3850914`（宿主探针）、`b7e29f7`（选定 A2）

## 先读

1. [主题页设计](design/cowork-sidebar/topic-page.md)
2. [前端开发提案](../.agents/notes/proposed/feature/2026-11-10-topic-page-frontend.md)
3. [后端设计提案](../.agents/notes/proposed/feature/2026-11-10-topic-page-backend.md)
4. [交互稿](discussion/topic-demo-v2.html)、[交互稿样式](discussion/topic-demo-v2.css)、[列表截图](discussion/topic-demo-v2.png)
5. [卡片样式](discussion/topic-card-style.png)、[总览截图](discussion/topic-demo-v2-overview.png)、[归档菜单截图](discussion/topic-demo-v2-archive.png)
6. 本文件

旧的 `topic-session-page.md` 和 `topic-session-demo.*` 是已废弃的左右分栏方案，不要按它实现。

## 定稿事实（不要重新讨论）

- 主题页是右侧栏列表：阻塞 / 运行中 / 空闲 / 已解决四组；“需要你处理”只统计待授权；已解决默认折叠。
- 卡片两行：主题名 + 摘要；待授权等标记在主题名右侧，时间在摘要右侧；边框：阻塞红、运行中绿、空闲黑、已解决灰；⋯ 菜单只有归档或恢复。
- 卡片不显示生命周期、工作项数、审查状态和决策记录；列表不出现 id、cwd、scope。
- 归档不弹确认、可撤回；归档后主会话只留一条“xx主题已归档”，主题会话没有归档通知；恢复不写主会话记录；归档使待授权失效。
- 归档/恢复 master-only；待授权的处理允许 master 或该主题自己的会话。
- 待授权 = 阻塞 + 标记；决策提案不阻塞；空闲从最后一次活动起 1 天；移除 3 天自动 resolved。
- 会话提醒：分配、上报、决策提案、待授权都是 1 个事件 = 主会话 1 条消息 + 主题会话 1 张提醒卡；实时、不阻塞、同一事件只打印一次；归档只给主会话。
- 决策记录只在主题会话生成并上报；查看和提意见在工作项 / Artifact 工作室，不在主题页实现。工作项页是后续页面。
- 宿主 notice 选定 **A2**：新增 `notice/message` 事件、`ctx.sessionNotices.append/update`、客户端 `notice` kind 和 seat。A1（复用 plugin record）不采用；B（不改宿主）是宿主拒绝 A2 时的备选。

## 当前实现状态

前端仍是 v1：

- `src/client/panel.tsx`：`chooseLayout` 在宽度大于 480px 时分列表/详情；详情用 `TopicDetail`。
- `src/client/list.tsx`：每行渲染 `reviewLabel`、`hasActiveWork`；`src/client/detail.tsx` 渲染工作项和评审请求。
- `src/client/model.ts`：`SPLIT_WIDTH_THRESHOLD = 480`、布局测量和现有动作文案。
- `src/client/api.ts`：`loadOverview`/`loadTopic`/`resolveTopic`/`reopenTopic`/`moveTopic`。

后端仍是 v1 语义：

- `src/store-schema.ts`：`TopicRecordV2` 只有 status/awaitingReview/blocked，没有待授权、阻塞原因、阻塞前状态。
- `src/topic.ts`：空闲 2 小时、3 天自动 resolved；`evaluateTopicLifecycle` 在 overview 读取时执行。
- `src/api.ts`：overview/topic/resolve/reopen/move；resolve 不清 blocked，也不归档宿主会话。
- `src/topic-tools.ts`：handoff 用 `Inbox` + `promptSession` 通知主会话（合批、启动模型轮次）。
- `src/api-contract.ts`：`PanelTopic` 有 blocked/awaitingReview/reviewStatus；排序把 awaitingReview 置前。
- 测试：`npm test` 790 项全绿；`npm run check` 通过。

## 宿主 A2（最大前置）

- 探针结论：外部插件可 inject `ctx.sessions` 并 append 非 surface 事件，但客户端没有 notice kind/seat，不会渲染；`appendPluginRecord` 可做到不进模型、不触发 turn、resume/fork 保留，但 README 只授权 `packages/experimental/` 的包。
- A2 契约（后端提案第 4 节）：
  - `dsh-session` 新增 `notice/message`：非 surface、不进 `deriveMessages`、不触发 turn、持久化、resume/fork 保留、按 `noticeId` 幂等/更新。
  - 宿主公开 `ctx.sessionNotices.append/update`，外部插件可调用。
  - 客户端 `conversation.chat.node` 增加 `notice` kind/seat；dsh-cowork 注册渲染器，按钮回调插件路由。
  - notice 字段：noticeId、pluginId、topicId、kind、title、summary、status、actions、createdAt、updatedAt；kind 为 assignment/report/proposal/authorization/archive，status 为 pending/allowed/denied/void。
- 宿主改动在 DSH 仓库，不在 dsh-cowork；没有宿主 A2 时，`TopicNoticePort` 用 Fixture/Noop，账本照写，会话卡片不显示（B）。
- 真实 GUI 探针还没跑。A2 落地前要补：临时 client plugin 注册 Definition+renderer、host plugin 向专用测试会话 append，验证卡片显示、不进模型历史、不触发 turn、按 noticeId 更新、按钮回调。
- 不要用 `user/message` 伪装提醒，也不要用 inbox prompt 充当 1:1 消息。

## 实现顺序

0. **基线**：`git fetch`，从设计分支或最新 main 建实现分支；确认设计分支已合到最新 main；跑 `npm run check`、`npm test`，记录基线。
1. **后端状态**：`TopicRecordV2` 加 `authorization`、`blockedReason`、`blockedFromStatus`、`blockedAt`；归一化/校验；idle 24h；移除自动 resolved；阻塞/待授权跳过 idle，解除后恢复。测试 `tests/topic.test.mjs`、`tests/store-schema.test.mjs`、`tests/api.test.mjs`。
2. **后端事件与投递**：activity 新类型；`notices.json` 账本；`TopicNoticePort`/dispatcher；1:1、顺序、重试、去重、非阻塞。新测试 `tests/notices.test.mjs`。
3. **工具与路由**：`cowork_topic_report`、`cowork_decision_propose`、`cowork_authorization_request`；`authorization.resolve`；resolve/reopen 的归档/恢复语义；宿主会话 archive/unarchive；`cowork_notices`；预设。测试 `topic-tools`、`api`、`presets`。
4. **API 契约**：`PanelTopic` 加 `awaitingAuthorization`/`blockedReason`；`PanelCounts` 加 `awaitingAuthorization`；排序/计数；`toPanelTopic`。测试 `api-contract`、`api`。
5. **前端列表**：`buildTopicViewModel`、两行卡片、四组、标记、菜单、空态/错误态、378px；删除列表/详情分栏和 review/work-item 渲染。测试 `panel-model`。
6. **A2 会话提醒卡**：`src/client/notice.tsx`、`notice-model.ts`；注册 `notice` kind；1 卡/notice、状态更新原卡、动作回调；A2 不可用时不注册（B）。GUI 探针。
7. **收口**：四条命令全绿；把两份提案移到 `.agents/notes/implemented/feature/` 并按 note 规则改写（Proposal→Decision，验收进 Testing）；更新 `docs/discussion/cowork-feature-todos.json`、README/PLAN/预设说明；前端截图同步。

后端和前端可以在接口契约冻结后并行：前端先用 fixture 做列表/卡片，后端按第 1–4 步落地，再接真实数据。

## 契约冻结（前后端共同）

- `PanelTopic`：`awaitingAuthorization: boolean`、`blockedReason: 'authorization' | 'handoff' | 'conflict' | null`；主题页不读 `awaitingReview`/`reviewStatus`。
- `PanelCounts`：新增 `awaitingAuthorization`；排序 blocked/awaitingAuthorization 优先。
- 路由：`POST /api/cowork.topic.resolve` 归档；`POST /api/cowork.topic.reopen` 恢复；`POST /api/cowork.authorization.resolve`。
- notice：字段、kind、status、actions、noticeId 幂等/update 语义按 A2。
- 改任何字段或语义，前后端两份提案和设计文档一起改，不能只改一侧。

## 验收与命令

- `npm run check`
- `npm run typecheck`
- `npm run build`（宿主构建；客户端如需单独构建用 `npm run build:client`）
- `npm test`
- A2 GUI 探针 + 前端主会话/主题会话截图
- 详细验收见后端提案 `[B1]`–`[B11]` 和前端提案 `[F1]`–`[F11]`；这 22 条是实现的闸门。

## 风险与遗留

- A2 宿主契约未确认、GUI 未验证；B 会丢失 1:1 会话卡片，只有在宿主拒绝 A2 时启用并记录偏离。
- 最新 main 已合并工作项前端计划；设计分支基于旧 main，先合再实现，避免客户端文件被覆盖。
- 移除列表/详情会暂时失去工作项/评审查看入口；这是定稿，但工作项页未实现，需要排期。
- 归档/恢复 master-only；授权决定允许主题会话处理自己的请求；别把两个权限混在一起。
- notice 精确一次依赖宿主按 noticeId 幂等；没有幂等只能至少一次，需写清显示重复的降级。
- 决策提案的查看页（工作项/Artifact）未实现；`open-work-item` 动作在目标页可用前要隐藏或标不可用。
- 工作区可能被其他会话切换到别的分支；动手前 `git status --short --branch`，确认在实现分支。
- 收件箱保留给 merge-needed/review-reject/cross-topic 等既有事件；新主题通知不走 inbox。

## 新会话启动清单

- [ ] `git fetch`，确认分支和最新 main；合并设计分支或建新的实现分支。
- [ ] 跑 `npm run check`、`npm test`，记录基线。
- [ ] 读本文件 + 设计文档 + 前后端提案；确认 A2 / B 的选择。
- [ ] 冻结 API/notice 契约；后端状态和前端 fixture 可以并行。
- [ ] 后端第 1–4 步；前端第 5 步；A2 可用后第 6 步。
- [ ] A2 GUI 探针或 B 偏离记录。
- [ ] 全量检查；提案移到 implemented；更新 feature-todos、README、截图。
- [ ] 汇报：改了什么（路径）、验证命令和结果、回滚方式、遗留风险与未核实项。
