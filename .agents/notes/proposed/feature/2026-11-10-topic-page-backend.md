# Proposal: 主题页后端（状态、事件通知、会话投递与迁移）

Status: proposed
Date: 2026-11-10
Class: feature

## Problem

主题页的界面已经定稿：右侧栏只保留列表；卡片两行（主题名 + 摘要）；待授权等标记在主题名右侧、时间在摘要右侧；边框按分组着色；⋯ 菜单只放归档或恢复；主题页不展示决策记录和审查状态；空闲从最后一次活动起 1 天；归档不弹确认、可恢复；恢复不写主会话记录。前端提案见 [topic-page-frontend.md](2026-11-10-topic-page-frontend.md)，设计文档见 [topic-page.md](../../../../docs/design/cowork-sidebar/topic-page.md)。

现有后端与定稿有三处差距：

1. **状态不够。** `TopicRecordV2` 只有 `status: active|idle|resolved`、`awaitingReview`、`blocked`；没有待授权、阻塞原因和阻塞前状态（`src/store-schema.ts:118-139`）。`blocked` 目前只由 `cowork_handoff(blocked)` 设置，待授权没有入口。
2. **生命周期与定稿不一致。** 空闲阈值是 2 小时（`src/topic.ts:18`），3 天自动 resolved（`src/topic.ts:20,61-84`）；归档入口在菜单，自动 resolved 会绕过菜单，也不会产生归档消息。`overview` 读取时在锁内批量求值（`src/tool-runtime.ts:434`，`src/api.ts:373-384`）。
3. **事件不是 1:1 消息。** `cowork_handoff` 用 `Inbox` + `promptSession` 唤醒主会话（`src/topic-tools.ts:236-345`）：最多 5 条合批、每条 200 字符，投递会向主会话发用户 prompt 并启动模型轮次（`src/inbox.ts:16,144-181`，`src/session-slice.ts:64-72`）。这不满足“1 个事件 = 1 条消息、实时、不阻塞”。

**宿主能力是最大约束。** `dsh-session` 的 `session.append(type, data)` 只支持表面事件（`user/message`、`assistant/message`、`system/message`、`developer/message`、`tool/result`）；`appendPluginRecord` 只给 `packages/experimental/` 的包用；客户端的聊天节点按固定的 `ChatNodeKind` 分派，外部插件不能新增 kind。因此“主会话/主题会话里的提醒卡片”在当前宿主上没有“只展示、不进模型历史、不触发轮次”的 API。不能用 `user/message` 伪装：模型下一轮会读到，界面也会显示成用户自己发的消息；也不能用 inbox prompt：会合批、启动模型轮次。

## Proposal

### 1. 状态模型

在 `TopicRecordV2` 增加：

- `authorization: { requestId; summary; requestedAt } | null`：待授权请求，摘要上限 200 字符。
- `blockedReason: 'authorization' | 'handoff' | 'conflict' | null`：阻塞原因；`blocked` 保留，作为 `blockedReason !== null` 的派生布尔。
- `blockedFromStatus: 'active' | 'idle' | null`：阻塞前状态；解除时恢复。
- `blockedAt: string | null`：首次进入阻塞的时间，用于诊断和排序。

`status` 仍是 active/idle/resolved，阻塞只作为标记和分组，不新增第四种 status。`awaitingAuthorization` 不单独存，由 `authorization !== null` 派生到 wire。review 字段保留给现有评审流程，主题页不读。

### 2. 事件与通知

复用 `activity.jsonl` 作为事件源，新增活动类型：

- `topic-created`：附带分配通知（主会话 + 主题会话）。
- `topic-reported`：进度上报（每事件 1 条通知）。
- `decision-proposed`：决策提案生成（主会话 + 主题会话）。
- `authorization-requested`：待授权（主会话 + 主题会话）。
- `authorization-resolved`：授权结果，只更新原通知，不新增通知。
- `topic-archived`：归档（只主会话）。
- `topic-reopened` / `status-changed`：归档恢复和空闲迁移，不产生通知。

每种通知在 `details.notice` 里带 `{ kind, title, summary, targets, actions? }`；主会话和主题会话的文案由纯函数 `noticeFor(event, target)` 生成，测试覆盖 1:1 和文案。通知正文只用 activity 的 bounded summary，不复制完整对话或敏感字段。

新增 `.dsh-cowork/notices.json`（v1）作为投递账本：

```text
{ version: 1, notices: [
  { noticeId, topicId, target: 'master' | 'topic', status: 'pending' | 'delivered' | 'failed' | 'void', attempts, lastError, updatedAt }
] }
```

- `noticeId` = activity `eventId`；最多 200 条，按更新时间裁剪。
- 账本只记投递状态，不重复存正文；正文从 activity 按 `noticeId` 读取。activity 上限 500 条，账本 200 条；读不到就标记 failed 并记日志，不猜测。
- 同一事件对同一 target 只投递一次；不合并、不批量。

### 3. 投递端口与调度

定义 `TopicNoticePort`：

- `append(sessionId, notice): Promise<'delivered' | 'duplicate'>`，按 `noticeId` 幂等；`update(sessionId, noticeId, patch)` 更新授权结果；`capabilities()` 报告是否支持 action 按钮。
- 实现一：宿主 notice 适配器（见第 4 节）。
- 实现二：Fixture/Noop，用于没有宿主扩展的开发和测试；只写账本，不假装消息已送达。

`TopicNoticeDispatcher`：

- 每个项目一个串行队列，按 activity seq 顺序投递。
- 工具/路由在锁内写 activity + 账本，然后 `void dispatcher.kick()` 并返回；投递失败不回滚状态、不阻塞主题。
- 失败按 1s/5s/30s 指数退避，最多 5 次；`apply` 时 replay 未完成项；插件卸载时清定时器。
- 宿主按 `noticeId` 去重才能做到 exactly-once；如果宿主不支持幂等，只能保证 at-least-once，必须在设计里写清“显示可能重复一次”的降级。

### 4. 宿主通知卡（门禁）

**路径 A（推荐）**：在 DSH 宿主增加 display-only notice 能力，dsh-cowork 通过端口接入。

- `dsh-session` 增加 `notice/message` 事件：非 surface、不进 `deriveMessages`、不触发轮次；按 `noticeId` 去重/更新；resume/fork 保留；数据 bounded。
- 宿主提供 `ctx.sessionNotices.append/update` 或等价的公开服务，外部插件可调用，不受 `appendPluginRecord` 限制。
- 客户端 `conversation.chat.node` 增加 `notice` kind 和对应席位；dsh-cowork 的客户端插件注册卡片渲染器，按钮把 `allow/deny/open` 动作回传给插件路由。
- M0/M6 风格的真实宿主探针：两张卡分别出现在主会话和主题会话；不进模型历史、不触发 turn；按 noticeId 更新状态；归档/恢复后仍在。探针失败则停止 A，转 B。

**路径 B（宿主不改）**：主题页列表、状态、菜单、待授权标记照常实现；主会话和主题会话的提醒卡片延期；真正需要用户动作的待授权/阻塞仍走现有 inbox + prompt（会启动模型轮次、会合批，明确是临时降级），其余事件只写 activity，由新增的 master 只读工具 `cowork_notices` 提供给主会话 agent。B 会偏离已确认的“1:1 会话消息”设计，需要用户明确接受。

不采用：把事件 append 成 `user/message`（模型会读到、界面误归因），或用 tool call/系统消息伪装（污染模型历史和会话结构）。

### 5. 工具与路由

新增主题会话工具（topic preset）：

- `cowork_topic_report({ summary, kind?: 'progress' | 'blocked' })`：更新 digest/lastActiveAt；`blocked` 时设置 `blocked=true`、`blockedReason='handoff'`、`blockedFromStatus`（若还没阻塞）；写 `topic-reported` activity + 通知；不写 inbox。
- `cowork_decision_propose({ title, summary })`：写 `.dsh-cowork/proposals/<proposalId>.json`（`DecisionProposalV1`：proposalId/topicId/title/summary/createdAt/status=open）和 `decision-proposed` activity + 通知；主题页只拿摘要，不展示记录。
- `cowork_authorization_request({ summary })`：设置 authorization/blocked/blockedFromStatus/blockedAt，写 `authorization-requested` activity + 通知，返回 requestId；主题进入阻塞。

新增/调整路由：

- `POST /api/cowork.authorization.resolve`：`{ sessionId, topicId, requestId, decision: 'allow' | 'deny' }`。调用方必须是 master 或该 topic 自己的会话；校验 requestId；清 authorization，按 blockedFromStatus 恢复 status，清 blockedReason（若为 authorization），写 `authorization-resolved` activity，更新原通知，并给主题会话发一条短 prompt 让 agent 继续；主会话不新增消息。同一 requestId 幂等，冲突决定报错。
- `resolve`（归档）：master-only；置 resolved、清 authorization/blocked/blockedFromStatus、写 `topic-archived` activity + 只给主会话的通知；归档宿主主题会话（`archiveSession(topicId, { stopActivity: true })`）；失败只记日志，不回滚索引；已 resolved 幂等，不重复通知。
- `reopen`（恢复）：master-only；清 resolved 字段、status=active、unarchive 宿主主题会话；写 `topic-reopened` activity，不产生通知。
- `cowork_topic_resolve` 工具与 resolve 路由共享同一个 `archiveTopic` 核心；`cowork_route`/`cowork_topic_create` 共享 `assignment` 通知；`cowork_handoff` 的 done/blocked 改为写 `topic-reported` 通知，不再走 inbox（inbox 只留 merge-needed/review-reject/cross-topic 等既有事件）。

主会话感知：新增 `cowork_notices`（master 只读，最近 N 条，按 topic 过滤），主会话 agent 在需要时读取；通知卡是用户可见面，不替代 agent 的读取工具。

### 6. API/前端契约

- `PanelTopic` 加 `awaitingAuthorization: boolean`、`blockedReason: 'authorization' | 'handoff' | 'conflict' | null`；`toPanelTopic` 从 `authorization`/`blockedReason` 映射。
- `PanelCounts` 加 `awaitingAuthorization`；`countPanel` 统计；旧的 review 计数保留给其他页面，但主题页不使用。
- `sortTopicsForPanel` 排序改为 blocked/awaitingAuthorization 优先，然后按 status；不再把 awaitingReview 置前。
- `resolve`/`reopen` 响应不变；`authorization.resolve` 新增成功/错误码（`authorization/not-found`、`authorization/mismatch`、`authorization/not-allowed`）。
- 前端提案里的 `awaitingAuthorization`/`blockedReason` 从可选转为后端保证；字段缺失时前端继续降级。

### 7. 生命周期

- `DEFAULT_IDLE_AFTER_MS` 改为 24 小时；空闲从 `lastActiveAt`（最后一次活动）起算，overview 读取时惰性求值，不新增后台定时器。
- 移除自动 resolved：`evaluateTopicLifecycle` 只保留 idle/active 迁移，删除 resolve 分支和 `resolveAfterMs` 配置（或保留配置但标 deprecated 且忽略）；归档只能从菜单/工具发起。
- 阻塞/待授权时跳过 idle 迁移；解除后按 `blockedFromStatus` 恢复；`noteTopicActivity` 在报告、授权申请、授权结果时更新 `lastActiveAt`。
- 主题会话内用户消息触发的现有 reopen 保留（等价于菜单恢复，不产生通知）。

### 8. 迁移与兼容

- 新字段按“读时补默认、写时齐全”处理：`authorization=null`、`blockedReason=null`、`blockedFromStatus=null`、`blockedAt=null`；已有 `blocked=true` 的主题标成 `handoff`，`blockedFromStatus` 取当前 status；不升 index 版本，避免 v3 迁移。
- `topicV2Problems` 增加字段校验；`normalizeProjectIndexV2` 补默认；旧版本插件读新索引时忽略未知字段，活动类型不认识的行会进 `skippedLines`，不崩溃。
- `notices.json` 缺省为空；旧版本忽略该文件。
- 新增活动类型、工具、路由、配置变更同步 README/PLAN/预设说明。

### 9. 分阶段落地

1. 状态与生命周期：新字段、归一化/校验、idle 24h、移除自动 resolved、`blockedFromStatus` 恢复；更新 `tests/topic.test.mjs`、`tests/store-schema.test.mjs`、`tests/api.test.mjs`。
2. 事件、账本与投递：活动类型、`notices.json`、`TopicNoticePort`/dispatcher、1:1 与重试/去重测试；工具先接 Fixture port。
3. 工具与路由：report/proposal/authorization 工具、authorization.resolve、resolve/reopen 的归档/恢复语义、宿主会话 archive/unarchive、预设与 `cowork_notices`；更新 `tests/topic-tools.test.mjs`、`tests/api.test.mjs`、`tests/presets.test.mjs`。
4. 前端契约：PanelTopic/Counts/sort/toPanelTopic；`tests/api-contract.test.mjs`、`tests/panel-model.test.mjs`。
5. 宿主通知卡（门禁）：按探针结果走 A 或 B；A 需要 DSH 宿主的 notice 事件/API/客户端席位；B 记录偏离并延期会话卡片。
6. 验证：`npm run check`、`npm run typecheck`、`npm run build`、`npm test`；真实宿主探针记录；前端 demo/截图同步。

## Alternatives considered

**把事件 append 成 `user/message`。** 否决：模型会在下一轮读到，界面会显示成用户自己发的消息；这既改变模型上下文，也把系统提醒误归因给用户。

**继续用 inbox + prompt。** 否决：最多 5 条合批、每条 200 字符，会启动模型轮次；与“1 事件 = 1 消息、实时、不阻塞”直接冲突。inbox 只保留合并/评审/跨主题冲突这些既有事件。

**只把事件展示在 Cowork 面板，不碰会话。** 否决：定稿要求主会话和主题会话都能看到提醒卡片；只放在侧栏等于把设计改成另一套。

**不做宿主 notice，先按路径 B 上线。** 这是可接受的降级，不是首选：主题页列表/状态/菜单可以完整；提醒卡片延期，待授权和阻塞仍走 prompt。选择 B 需要用户明确接受，且要在设计文档里标注偏离。

**把提醒做成 tool call 卡片。** 否决：需要伪造模型工具调用/结果，污染会话结构和模型历史，且外部插件无法新增聊天节点。

**保留 3 天自动 resolved。** 否决：归档入口在菜单，自动 resolved 会绕过菜单，也没有主会话归档消息；如果产品仍要自动归档，应复用同一 `topic-archived` 通知并明确 resolvedBy。

**给主题页新建全局 store 或第二个事件源。** 否决：activity 已经是项目事件流，新增 `notices.json` 只记投递状态；再建一套会分叉事实。

## Acceptance criteria

- [B1] TopicRecordV2 增加 authorization/blockedReason/blockedFromStatus/blockedAt，读时补默认、写时齐全，旧索引不迁移也能读；已有 blocked 主题标成 handoff — `source`
- [B2] idle 阈值是最后一次活动后 1 天，自动 resolved 移除；阻塞/待授权不进入 idle，解除后按 blockedFromStatus 恢复 — `source`
- [B3] 归档走菜单/工具：清 authorization/blocked、归档宿主主题会话、只写主会话一条通知；恢复清 resolved、unarchive、不写通知；两者幂等 — `source`
- [B4] 新增 report / decision propose / authorization request 工具和 authorization.resolve 路由；权限只允许 master 或该 topic 自己的会话，requestId 幂等 — `source`
- [B5] activity 的每个通知事件对每个 target 只生成一条 notices.json 记录，不合并、不批量；authorization-resolved 更新原通知而不是新增 — `source`
- [B6] dispatcher 按事件顺序投递，失败指数退避最多 5 次，重放不重复；工具在投递失败时不回滚状态、不阻塞 — `tests`
- [B7] PanelTopic 增加 awaitingAuthorization/blockedReason，PanelCounts 增加 awaitingAuthorization，排序按 blocked 优先且不再把 awaitingReview 置前 — `tests`
- [B8] 宿主 notice 探针通过：卡片出现在主会话和主题会话，不进模型历史、不触发 turn，按 noticeId 更新；失败则走 B 并在设计里标注 — `decisions`
- [B9] `npm run typecheck`、`npm run build`、`npm test` 全部通过；新增状态/事件/投递/路由测试覆盖上述规则 — `tests`
- [B10] 设计文档、前端提案、demo 截图和接口字段同步；README/PLAN/预设说明更新 — `plan-docs`

## Risks

- 宿主 notice 是最大依赖：A 需要 DSH 宿主改动，超出 dsh-cowork 仓库；B 会丢失已确认的 1:1 会话卡片。实施前必须先做真实宿主探针并选定 A/B。
- 自动归档：本设计按“归档只从菜单发起”处理，移除 3 天自动 resolved；如果产品仍要自动归档，应复用同一 `topic-archived` 通知并明确 resolvedBy。
- 归档/恢复的会话权限：保持 master-only；前端菜单在非 master 会话应禁用并给出原因；授权决定允许 topic 会话处理自己的请求。
- 决策提案：本轮只做生成/存储/上报，不在主题页展示；工作项/Artifact 的查看与评审是后续页面。
- 精确一次投递：依赖宿主按 `noticeId` 幂等；没有幂等就只能至少一次，需在设计里写清显示重复的降级。
- 收件箱：新报告/提案/授权通知不走 inbox；inbox 只保留既有 merge/review/cross-topic 事件，避免两套队列。
- 需要重估的条件：宿主提供 notice 能力后 A 成立；宿主拒绝且用户接受 B 时，主题页照常上线，会话卡片延期。

## Delivery stages

1. 设计文档与探针方案（本轮）：写本提案、设计文档链接和宿主探针通过标准；`npm run check` 通过；不改 `src/`。
2. 状态与生命周期：字段、归一化/校验、idle 24h、移除自动 resolved、恢复语义；测试。
3. 事件、账本与投递：活动类型、notices.json、端口/dispatcher、1:1/重试/去重；测试。
4. 工具与路由：report/proposal/authorization、authorization.resolve、归档/恢复、宿主会话 archive/unarchive、预设、cowork_notices；测试。
5. 前端契约与文档：PanelTopic/Counts/sort、前端字段转必选、demo/截图同步。
6. 宿主通知卡：探针后走 A 或 B；A 的宿主改动单独交付，B 记录偏离。
7. 收口：四条命令全绿，真实宿主探针证据归档。
