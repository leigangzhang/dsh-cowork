# Proposal: 主题提醒：主会话一条文本，主题会话一条授权提示

Status: proposed
Date: 2026-11-10
Class: feature

## Problem

主题页 v2 已经能做到“事件写账本”，但用户在主会话和主题会话里都看不到提醒。当前运行宿主没有 A2 的 `sessionNotices` 与 `notice/message`，`TopicNoticePort` 只能是 Noop，`notices.json` 的投递行全部停在 `pending`；主会话只能主动调用 `cowork_notices`，主题会话没有可点的授权入口。用户容易漏掉分配、上报、决策提案、待授权和交接。

已经确认的展示方向是“方案 1”：主会话显示一句提醒文本，主题会话显示 ask-user 或待授权提示；用户只在主题会话授权一次，主会话那条提醒随状态自动收起。问题在于怎么落地：

- 不能在主会话里直接渲染 PLAN 里的 1:1 提醒卡；那需要宿主的 notice 通道和客户端 seat，当前没有。
- 不能用主会话 `promptSession` 发一句文本：它会启动 master 的一轮对话，并把提醒显示成用户消息，主会话会被过程事件反复唤醒。
- 不能让主会话和主题会话各自弹一个 ask-user：两个阻塞问题没有可靠的跨会话关闭接口，容易出现一边已处理、另一边还挂着。
- `cowork_authorization_request` 只负责置待授权，主题会话现在没有工具把“允许/拒绝”写回；`authorization.resolve` 是 HTTP 路由，主题模型调用不到。

## Proposal

本轮只做设计和实现计划，不写生产代码。目标是把“方案 1”落成一条可验证的链路：主会话看到一条带类型前缀的文本，主题会话用 `ask_user_question` 做唯一可操作入口，决定只落一次。

**1. 主会话提醒条。** 不写聊天消息，在 CoWork 面板顶部增加一条只读提醒条，显示最新一条未处理提醒，格式为 `[类型] 主题名 — 摘要`；右侧显示 `+N`，点整条打开对应 topic，点 `×` 收起信息型提醒。提醒条不唤醒 master，不产生模型轮次，也不进入会话历史。

**2. 类型前缀。** 主会话文本固定使用这些前缀，便于一眼识别：

| 事件 | 前缀 | 来源 |
|---|---|---|
| 新主题分配 | `[分配]` | `topic-created` 通知 |
| 进度或阻塞上报 | `[上报]` | `cowork_topic_report` |
| 交接完成或交接阻塞 | `[交接]` | `cowork_handoff` |
| 决策提案 | `[提案]` | `cowork_decision_propose` |
| 待授权 | `[授权]` | `cowork_authorization_request` |
| 归档 | `[归档]` | `topic-archived` |
| 评审 pass/reject | 不新增前缀 | 沿用现有 `inbox.json` 的 `merge-needed` / `review-reject`，不重复进提醒条 |

`cowork_handoff` 和 `cowork_topic_report` 目前共用 `topic-reported` 事件与 `report` 通知；为区分 `[交接]` 和 `[上报]`，事件详情将新增 `origin: 'report' | 'handoff'`。不新增 notice kind，不升 `notices.json` 版本。

主题会话只对 `[授权]` 显示 ask-user；其他五类由主会话提醒条显示，不在主题会话重复，因为主题会话是事件来源，重复卡片会形成第二队列。

**3. 提醒投影。** `noticeSummaries` 继续作为唯一投影函数；`OverviewResponse` 增加 `reminders`，默认取 master 目标的最近 5 条，按 `updatedAt` 倒序。每条提醒包含 `noticeId`、`topicId`、`kind`、`prefix`、`text`、`status`、`updatedAt`。只返回 `status = pending` 的提醒；`allowed`、`denied` 和普通 `void` 不返回，`archive` 例外，展示一次后由本地已读收起。这实现“授权后另一侧自动收起”。

**4. 主题授权流程。** 主题调用 `cowork_authorization_request` 后，按 persona 指引调用 `ask_user_question`，问题提供“允许”和“拒绝”两个选项；拿到回答后调用新工具 `cowork_authorization_decide({ requestId, decision })`。新工具与 `POST /api/cowork.authorization.resolve` 共用同一个核心函数：校验调用者是该 topic 自己的会话、`requestId` 幂等、同一决定重放成功、不同决定报冲突；清空 `authorization`、按 `blockedFromStatus` 恢复、写 `authorization-resolved`、更新原通知，不再新增第二张提醒。

**5. 唯一入口与自动收起。** 主会话提醒条只读，点击只打开 topic，不提供允许/拒绝；主题会话的 ask-user 是唯一授权入口。授权完成后：

- `authorization` 清空，`blockedReason` 消失；
- 原通知更新为 `allowed` / `denied`；
- 主会话提醒条在下次 overview 刷新时不再返回该条；
- 不再给 master 发第二条消息，也不在主题会话再弹第二个问题。

归档待授权主题时，归档路径继续把原通知置 `void`，提醒条同样收起。

**6. 已读与收起。** 本阶段不新增 `notices.json` 的已读字段。信息型提醒（分配、上报、交接、提案、归档）由客户端按 `noticeId` 记在本地已读集合里，点 `×` 或打开 topic 后收起；待授权提醒不能手动收起，只能通过决定或归档结束。刷新页面后未收起的旧信息提醒可能重新出现，这是本阶段接受的限制；需要持久化时再补账本 `readAt`。

**7. 客户端位置。** 新增 `src/client/reminder.tsx`，在 `src/client/panel.tsx` 的四组列表上方渲染；`src/client/model.ts` 增加 `buildReminderView(reminders, dismissed)`，只负责选最新一条、算 `+N` 和前缀，保持纯函数；样式在 `src/client/styles.ts` 新增一条单行省略的提醒条，沿用现有面板主题 token。提醒条不放进 `TopicCard`，避免和主题卡争空间。

**8. 宿主边界。** 不新增后台线程、不启用轮询、不修改宿主；`TopicNoticePort` 仍是 Noop，`notices.json` 仍是投递账本。以后宿主提供 A2 时，`reminders` 可以直接映射到原生 notice 卡，主会话提醒条作为降级视图保留。

## Alternatives considered

**方案 2：主会话和主题会话都弹 ask-user。** 否决：两个阻塞问题各自挂在一个会话里，当前没有可靠的跨会话关闭接口；用户在一个会话回答后，另一个仍要人工取消。还会让 master 多一个待处理项。

**方案 3：都弹 ask-user，主会话延迟显示。** 否决：延迟只错开出现时间，不解决两边并存、关闭和过期；如果用户在主题会话先处理，主会话的延迟问题还会在稍后弹出，需要额外的状态检查。

**主会话用 `promptSession` 发一句文本。** 否决：会启动 master 的一轮对话，把提醒显示成用户消息，过程事件会反复唤醒 master；这不是“只显示一句文本”，也会污染会话历史。

**等宿主 A2 的 1:1 提醒卡。** 这是长期方向，不是本阶段可交付的方案：当前宿主没有 `ctx.sessionNotices`、`notice/message` 和客户端 notice seat；继续等会让主会话和主题会话都保持无提醒。

**主会话后台线程轮询账本再生成提醒卡。** 否决：master 没有创建后台会话或定时任务的工具，账本没有推送接口；即使另起会话轮询，也只能读账本，不能把卡片渲染进主会话。

**主会话提醒条也放允许/拒绝按钮。** 否决：这会回到两个可操作入口，必须补跨会话关闭和竞态处理；方案 1 明确让主题会话做唯一授权入口。

**新建一个全局提醒存储。** 否决：`notices.json` 已经按事件记录目标、状态和投递；再建一套会分叉事实。提醒投影只是读取视图，不新增状态源。

**把评审也复制进提醒条。** 否决：评审 pass/reject 已经通过 `inbox.json` 唤醒 master 并给出可操作项；再显示一条只读提醒会形成第二队列。评审保留现有入口，提醒条只覆盖主题事件。

## Acceptance criteria

- [R1] master 目标的提醒投影最多 5 条，按 `updatedAt` 倒序，带 `noticeId/topicId/kind/prefix/text/status`；`allowed/denied` 和普通 `void` 不返回，`archive` 例外 — `source` / `tests`
- [R2] 六类主题事件的前缀分别是 `[分配]`、`[上报]`、`[交接]`、`[提案]`、`[授权]`、`[归档]`，`handoff` 与 `report` 通过 `details.origin` 区分 — `source` / `tests`
- [R3] CoWork 面板顶部只显示最新一条提醒和 `+N`，点击打开 topic，`×` 只收起信息型提醒，`[授权]` 不能手动收起 — `tests`
- [R4] 主题会话按“request → ask-user → decide”完成授权；`cowork_authorization_decide` 只接受该 topic 自己的会话，`requestId` 幂等，冲突决定报错 — `source` / `tests`
- [R5] 决定后清空 `authorization`、按 `blockedFromStatus` 恢复状态、原通知更新为 `allowed/denied`，不新增第二条通知 — `tests`
- [R6] overview 的下一次读取不再返回已决定的授权提醒；归档待授权主题时原提醒置 `void` 并收起 — `tests`
- [R7] 主会话没有新增聊天消息、没有后台轮询、`inbox.json` 不因主题提醒新增条目；评审仍走现有 inbox — `source` / `tests`
- [R8] 主题 persona、README、主题页设计文档和 `docs/decision-and-handoff.md` 同步说明这条链路 — `plan-docs`
- [R9] `npm run check`、`npm run typecheck`、`npm run build`、`npm test` 在集成 HEAD 上通过 — `tests` / `source`

## Risks

- 主会话提醒条是侧栏 UI，不是会话聊天消息；如果用户要求必须出现在聊天记录里，只能等宿主 A2 或接受 `promptSession` 唤醒 master，后者本提案明确不选。
- 主题模型可能忘记调用 ask-user 或 decide；persona、工具返回提示和测试只能降低概率，不能保证。授权请求会保持 pending，用户可重新打开 topic 再处理。
- 信息型提醒的已读状态只在本地，换浏览器或清理本地存储后会丢失，旧提醒可能重新出现；这是为了不在本阶段改 `notices.json` schema 的取舍。需要跨刷新/多端时补 `readAt`。
- `ask_user_question` 是宿主工具，主题会话的 preset 已包含它；如果未来 preset 移除该行，授权链路会断，需要 feature-detect 并给出明确错误。
- 提醒条只显示最新一条，多个主题同时有待授权时依赖 `+N` 和点击进入列表；如果用户只扫列表不点开，仍可能漏掉较旧的授权。
- 授权仍在主题会话完成，主会话用户需要先打开 topic；这是方案 1 的已知代价，换来的是没有两个阻塞入口。

## Delivery stages

1. **投影与 API。** 增加 `PanelReminder`、overview `reminders`、`details.origin` 和前缀映射；测试覆盖六类前缀、最多 5 条、状态过滤。
2. **主会话提醒条。** 新增 `reminder.tsx`、纯函数视图模型、单行样式和本地已读；测试覆盖最新一条、`+N`、打开、收起和授权不可收起。
3. **主题授权闭环。** 新增 `cowork_authorization_decide`、共享授权核心、persona 指引；测试覆盖幂等、冲突、状态恢复、通知更新。
4. **收口。** 同步设计文档、README、`docs/decision-and-handoff.md` 和测试；跑四命令，确认真实面板宽度下提醒条不挤压主题卡。
