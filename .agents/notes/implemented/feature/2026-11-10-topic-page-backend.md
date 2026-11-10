# Decision: 主题页后端：24h 空闲、菜单归档与 1:1 通知账本

Status: implemented
Date: 2026-11-10
Class: feature

## Problem

主题页的界面定稿是单列列表：四组（阻塞 / 运行中 / 空闲 / 已解决）、两行卡片、待授权标记、⋯ 菜单只放归档或恢复、空闲从最后一次活动起 1 天、归档可恢复、恢复不写主会话记录。前端见 [主题页前端](2026-11-10-topic-page-frontend.md)，设计见 [topic-page.md](../../../../docs/design/cowork-sidebar/topic-page.md)。

原有后端与定稿有三处差距：

1. **状态不够。** `TopicRecordV2` 只有 `status`、`awaitingReview`、`blocked`；没有待授权、阻塞原因和阻塞前状态。`blocked` 只由 `cowork_handoff(blocked)` 设置，待授权没有入口。
2. **生命周期与定稿不一致。** 空闲阈值是 2 小时，3 天自动 resolved；自动 resolved 会绕过菜单，也不会产生归档消息。overview 读取时在锁内批量求值。
3. **事件不是 1:1 消息。** `cowork_handoff` 用 `Inbox` + `promptSession` 合批唤醒主会话，最多 5 条、每条 200 字符；不等同于「1 个事件 = 1 条主会话消息 + 主题会话 1 张提醒卡」。

宿主能力是最大约束：运行中的 DSH 0.2.1-rc.2 没有 `sessionNotices` 服务，也没有 `notice/message` 事件。`Session.append` 接受自定义事件名，但持久化读取要求未知事件带 `ignorable: true`，而唯一设置该标记的 `appendPluginRecord` 被宿主 README 明确禁止仓库外插件调用；客户端聊天节点是通用 Definition/seat，但需要先有可持续的 notice 事件。A2 因此无法在本阶段落地，按 B 降级。

## Decision

**状态模型。** `TopicRecordV2`（[src/store-schema.ts](../../../../src/store-schema.ts)）增加：

- `authorization: { requestId, summary, requestedAt } | null`，摘要上限 200 字符；
- `blockedReason: 'authorization' | 'handoff' | 'conflict' | null`；
- `blockedFromStatus: 'active' | 'idle' | null`；
- `blockedAt: string | null`。

`blocked` 保留为 `blockedReason !== null` 的派生布尔；`status` 仍是 `active/idle/resolved`，阻塞不是第四种状态。`normalizeProjectIndexV2` 读时补 `null`；旧的 `blocked=true` 文档归一化为 `handoff`，`blockedFromStatus` 取当前 status；`projectIndexV2Problems` 校验字段类型、authorization 形状与 `blocked`/`blockedReason` 一致性。不升 index 版本。

**生命周期。** [src/topic.ts](../../../../src/topic.ts) 的 `DEFAULT_IDLE_AFTER_MS` 是 24 小时；`evaluateTopicLifecycle` 只做 idle/active 迁移，不再自动 resolved；`DEFAULT_RESOLVE_AFTER_MS` 与配置 `resolveAfterMs` 保留但弃用并忽略。阻塞或待授权时 `isMarked` 阻止 idle；`blockTopic` 第一次阻塞记录 `blockedFromStatus` 与 `blockedAt`；`unblockTopic` 按 `blockedFromStatus` 恢复并清 authorization；`archiveTopicRecord` 归档时清空 block/authorization，`reopenResolvedTopic` 恢复 active。

**事件与通知账本。** `ACTIVITY_TYPES` 增加 `topic-reported`、`decision-proposed`、`authorization-requested`、`authorization-resolved`、`topic-archived`。[src/activity.ts](../../../../src/activity.ts) 在 `details.notice` 写有界描述（kind/title/summary/targets/actions/status）；`authorization-resolved` 用 `details.noticeId` 指向原 authorization 事件 id，不新增卡片。`.dsh-cowork/notices.json` v1（[src/notices.ts](../../../../src/notices.ts)、[src/notice-store.ts](../../../../src/notice-store.ts)）只记投递状态：`{ noticeId, topicId, target, status, attempts, lastError, updatedAt }`，`noticeId = activity.eventId`，最多 200 行，按 `updatedAt` 裁剪；`recordNoticesForEvent` 通过 `ProjectStore.mutateNotices` 做锁内 read-modify-write，按 `(noticeId,target)` upsert。

**端口与投递。** `TopicNoticePort` 定义 `append(sessionId, notice)` / `update(sessionId, noticeId, patch)` / `capabilities()`；`NoopTopicNoticePort` 与 `FixtureTopicNoticePort` 都报告 `supported:false`，不声称送达。`TopicNoticeDispatcher` 每个项目串行、按 activity 顺序、失败按 1s/5s/30s 退避、最多 5 次、`replay` 不重复、失败不回滚主题状态、不阻塞工具；`dispose` 清定时器。`store.readActivity(ACTIVITY_MAX_EVENTS)` 覆盖 500 条，账本里更旧的 pending 事件不会因默认 50 条尾部而被误判丢失。

**工具与路由。** [src/topic-tools.ts](../../../../src/topic-tools.ts) 新增：

- `cowork_topic_report({summary, kind?: 'progress'|'blocked'})`：更新 digest/lastActiveAt；`blocked` 设 `blockedReason='handoff'` 与 `blockedFromStatus`；每事件一条 `topic-reported` 通知。
- `cowork_decision_propose({title, summary})`：写 `.dsh-cowork/proposals/<proposalId>.json`（`DecisionProposalV1`）并写 `decision-proposed` 事件与通知；主题页只拿摘要。
- `cowork_authorization_request({summary})`：阻塞主题为 authorization，写 `authorization-requested`，返回 `requestId`。
- `cowork_notices({topicId?, limit?})`：master 只读，默认 20、最多 100，按 `updatedAt` 倒序；已归档的待授权显示 `void` 且无 actions。

`cowork_handoff` 的 `blocked/done` 改走 `topic-reported` 通知，不再写 inbox；inbox 只保留 merge-needed / review-reject / cross-topic 等既有事件。`cowork_route` 新建主题与 `cowork_topic_create` 共享 `assignmentNotice`（master+topic）；复用已有主题不重复发分配通知。

[src/api.ts](../../../../src/api.ts) 新增 `POST /api/cowork.authorization.resolve`（body：sessionId/topicId/requestId/decision=allow|deny）：调用方必须是 master 或该 topic 自己的会话；requestId 幂等，同一决定重放 200、不同决定 `authorization/mismatch`；清 authorization、按 `blockedFromStatus` 恢复、写 `authorization-resolved`、更新原 notice，并在 master 决定时给 topic 一条短 prompt，主会话不新增消息。`resolve` 路由改为归档语义：master-only、幂等、清 block/authorization、写 `topic-archived`（只给 master 通知）、通过 `workspaceRegistry.archiveSession(topicId,{stopActivity:true})` 归档宿主主题会话（失败只记日志）；`reopen` 清 resolved、status=active、`workspaceRegistry.unarchiveSession(topicId)`、写 `topic-reopened` 不产生通知。`cowork_topic_resolve` 工具共享 archive 核心并同样归档宿主会话。

**Panel 契约。** `PanelTopic`（[src/api-contract.ts](../../../../src/api-contract.ts)）增加 `awaitingAuthorization` 与 `blockedReason`；`PanelCounts` 增加 `awaitingAuthorization`；`sortTopicsForPanel` 先 blocked、再 awaitingAuthorization，然后 active/idle/resolved，`awaitingReview` 不再置前；错误码增加 `authorization/not-found`、`authorization/mismatch`、`authorization/not-allowed`。主题页不读 `awaitingReview`/`reviewStatus`，这两个字段保留给现有评审流程。

**A2 / B 选择：B。** 本阶段没有宿主 notice 通道，`TopicNoticePort` 用 Noop，账本照写并保持 `pending`，主会话/主题会话没有提醒卡；`cowork_notices` 是 master 读取通知的唯一入口。宿主 A2 版发布后只需替换端口适配器并按 noticeId 更新/void 原通知，不需要改状态模型和工具契约。A1（复用 plugin record）不采用：宿主只授权 `packages/experimental/` 调用 `appendPluginRecord`。

**迁移与兼容。** 旧 v2 索引读时补默认，不因缺字段失败；`blocked=true` 的旧主题按 handoff 语义读取。`notices.json` 缺省为空；旧版本忽略该文件。`resolveAfterMs` 配置保留但不再生效。M12 E2E 驱动从「自动 resolved」改为通过真实 resolve 路由归档，并断言 `topic-archived`。

## Alternatives considered

**把事件 append 成 `user/message`。** 否决：模型会读到，界面会显示成用户消息，改变模型上下文并错误归因。

**继续用 inbox + prompt。** 否决：合批、200 字符上限、启动模型轮次，与「1 事件 = 1 消息、实时、不阻塞」冲突；inbox 只保留既有 merge/review/cross-topic 事件。

**只把事件展示在 Cowork 面板，不碰会话。** 否决：定稿要求主会话与主题会话都能看到提醒；只放侧栏等于改设计。

**A1 复用 plugin record。** 否决：宿主只允许 `packages/experimental/` 调用 `appendPluginRecord`；客户端 node 契约仍要补，A2 同时解决并多出 update/actions。

**不做宿主 notice，先按 B 上线。** 这是可接受的降级，不是首选：本阶段实际采用的方案；列表、状态、菜单、账本和 `cowork_notices` 完整，1:1 会话卡延期到宿主 A2 发布，偏离记录在设计文档与 KNOWN_ISSUES。

**把提醒做成 tool call 卡片。** 否决：需要伪造模型工具调用/结果，污染会话结构与模型历史，外部插件也无法新增聊天节点。

**保留 3 天自动 resolved。** 否决：归档入口在菜单，自动 resolved 会绕过菜单且没有主会话归档消息。

**给主题页新建全局 store 或第二个事件源。** 否决：activity 已经是项目事件流，`notices.json` 只记投递状态；再建一套会分叉事实。

**把 idle 阈值继续设为 2 小时。** 否决：定稿明确「最后一次活动后 1 天」；24 小时由 `DEFAULT_IDLE_AFTER_MS` 与测试钉住。

## Consequences

- 主题页状态由 `blockedReason/authorization/blockedFromStatus` 表达；只改 `blocked` 或只写 authorization 的不一致文档会被校验拒绝。
- 归档是唯一进入 resolved 的路径（用户菜单或工具）；不存在后台自动 resolved。空闲只在最后一次活动后超过 24 小时且无标记时发生。
- 归档会清空待授权并把原授权通知置 `void`，同时归档宿主主题会话；恢复会 unarchive，且不产生通知、不恢复已失效的授权。
- 通知严格 1:1：每个事件对每个 target 只写一条账本行；`authorization-resolved` 只更新原行。B 模式下所有行保持 `pending`，不会假装 delivered；A2 落地前用户看不到会话卡，只能由 master 通过 `cowork_notices` 读取。
- 投递失败不会被当作主题状态失败；工具/路由在账本写失败时仍返回成功并记录日志。at-least-once 的去重依赖宿主 noticeId 幂等；A2 未落地前不承诺 exactly-once 显示。
- `cowork_handoff` 不再唤醒 master；master 需要主动读 `cowork_notices`。这与「别等、别轮询」的 persona 一致，但模型需要按 persona 调用工具，否则会漏看上报。
- `PanelTopic.awaitingAuthorization/blockedReason` 在 TypeScript 里仍是可选（为了旧客户端编译），但 `toPanelTopic` 总是写出；主题页在缺字段时降级为不显示待授权。
- A2 会话卡延期、工作项/评审查看入口移出主题页，这两条进入 [KNOWN_ISSUES](../../../../docs/KNOWN_ISSUES.md)；工作项页实现前用户暂时不能从主题页看工作项和评审详情。
- 重启后账本 pending 行不会自动补投；宿主 A2 适配器上线时应按 noticeId replay，且要处理已归档主题的 void 行。

## Testing

- [B1] `TopicRecordV2` 新字段读时补默认、写时齐全、旧索引可读，已有 blocked 文档归一化为 handoff，校验拒绝非法值 — `source` / `tests`：`tests/store-schema.test.mjs`（`v2 normalization defaults the block and authorization fields an older document predates`、`v2 normalization marks a legacy blocked topic as a handoff block`、`v2 validation names every broken topic field`）；`tests/store-v2.test.mjs`
- [B2] idle 阈值 24 小时，自动 resolved 移除；阻塞/待授权抑制 idle，解除后按 blockedFromStatus 恢复 — `tests`：`tests/topic.test.mjs`（`the idle threshold is one day; the old resolve threshold is only kept for compatibility`、`an active topic turns idle only after the 24-hour window`、`the lifecycle never resolves a topic on its own, however stale it is`、`awaitingReview, a block, and a pending authorization suppress idle`、`unblockTopic restores the recorded status and clears the authorization`）；`tests/route-tools.test.mjs` 的 3 小时/4 天用例
- [B3] 归档走菜单/工具：清 authorization/block、归档宿主主题会话、只写主会话一条通知、待授权通知置 void；恢复清 resolved、unarchive、不写通知；两者幂等 — `source` / `tests`：`tests/api.test.mjs`（`resolve archives the host session, clears the pending authorization, and voids its notice`、`a refused host archive is logged and never fails or rolls back the resolve`、`reopen restores the host session and logs a refused restore`、`resolve marks a topic resolved once and is idempotent afterwards`、`reopen clears the resolution and records topic-reopened`）；`tests/topic-tools.test.mjs`（`cowork_topic_resolve archives once, clears the block, and records one topic-archived`）
- [B4] report / decision propose / authorization request 工具与 authorization.resolve 路由；权限只允许 master 或该 topic 自己的会话，requestId 幂等，冲突决定报错 — `source` / `tests`：`tests/topic-tools.test.mjs`（`cowork_topic_report records progress: digest, activity time, and one notice per target`、`cowork_topic_report(kind blocked) blocks for handoff reasons and keeps the restore status`、`cowork_decision_propose stores the proposal file and reports one event`、`cowork_authorization_request blocks with a pending request and returns its id`）；`tests/api.test.mjs`（`authorization.resolve allows the master to decide, restores the status, and prompts the topic only`、`authorization.resolve is idempotent for the same decision and conflicts on a different one`、`authorization.resolve rejects a wrong request id, a foreign session, and a missing request`）
- [B5] 每个通知事件对每个 target 只生成一条 notices.json 记录，不合并、不批量；authorization-resolved 更新原通知而非新增 — `tests`：`tests/notices.test.mjs`（`recordNoticesForEvent writes exactly one row per target and upserts on replay`、`an authorization event is pending with allow/deny, and the decision patches the same id`、`noticeSummaries folds the decision into the original row and reads the ledger state`、`archiving withdraws a pending authorization notice instead of leaving it pending`）
- [B6] dispatcher 按事件顺序投递，失败指数退避最多 5 次，重放不重复；投递失败不回滚状态、不阻塞 — `tests`：`tests/notices.test.mjs`（`the dispatcher delivers a pending notice once and keeps the ledger honest`、`delivery retries with the documented backoff and succeeds on a later attempt`、`a row that never delivers is marked failed after five attempts and the drain never throws`、`drains for one project are serialized, so events arrive in ledger order`、`a >50-row activity tail does not hide an older pending notice`、`B mode leaves every row pending and never calls the port`）
- [B7] `PanelTopic` 加 awaitingAuthorization/blockedReason、`PanelCounts` 加 awaitingAuthorization；排序按 blocked/awaitingAuthorization 优先，不再把 awaitingReview 置前 — `tests`：`tests/api-contract.test.mjs`（`sortTopicsForPanel ranks blocked, awaitingAuthorization, then active/idle/resolved`、`countPanel zero-fills every wire field`）；`tests/api.test.mjs`（`toPanelTopic derives the authorization marker and surfaces the blocked reason`、`overview counts the topics that await an authorization`）
- [B8] A2 契约未在本阶段确认；运行宿主没有 `sessionNotices`/`notice/message`，`appendPluginRecord` 不允许仓库外插件；实现按 B 留好端口 — `decisions`：本记录、[docs/TOPIC_PAGE_HANDOFF.md](../../../../docs/TOPIC_PAGE_HANDOFF.md)、[KNOWN_ISSUES](../../../../docs/KNOWN_ISSUES.md)
- [B9] 真实 GUI 探针：B 模式下没有会话提醒卡，`notices.json` 按事件写入且保持 pending；主题页归档/恢复与四组在真实 Chrome 验证 — `decisions`：`.dsh-cowork/e2e/topic-page/integration-ready.json`、`/tmp/topic-page-verify/GUI_EVIDENCE.json` 与截图（本阶段证据目录，不进入仓库）；A2 卡的真实 GUI 探针延期到宿主 A2 阶段
- [B10] `npm run typecheck`、`npm run build`、`npm test`、`npm run check` 在集成 HEAD 上通过；新增状态/事件/投递/路由测试覆盖上述规则 — `tests`：集成 HEAD `b6b4a06`，`npm test` 843/843、`npm run typecheck`/`npm run build`/`npm run check` exit 0
- [B11] 设计文档、前端提案/决策、README、PLAN 指针与 KNOWN_ISSUES 同步；旧 `resolveAfterMs` 语义标为弃用 — `plan-docs`：[topic-page.md](../../../../docs/design/cowork-sidebar/topic-page.md)、[README.md](../../../../README.md)、[PLAN-V0.2.md](../../../../docs/PLAN-V0.2.md)、[KNOWN_ISSUES.md](../../../../docs/KNOWN_ISSUES.md)
