# Proposal: M11 HTTP API v2 与 CoWork 面板重写

Status: proposed
Date: 2026-11-08
Class: architecture

## Problem

M10 把运行时的数据模型收口到 canonical v2（`topics`/`workItems`/评审请求文件/activity/inbox），但面板与 HTTP API 仍是 M3 的 thread 形态：

- `src/api-contract.ts` 只描述 v1：`PanelThread`、五态 `PanelThreadStatus`、`PanelHandoffRecord`、`PanelReviewPayload`，以及 `OVERVIEW_PATH`/`HANDOFF_PATH` 两条路径；评审字段来自索引里的 `reviewStatus`/`latestReviewPath`。
- `src/api.ts` 只注册 overview 与 legacy handoff 两条路由，overview 读 legacy `readIndex()`，评审卡取 `latestReviewPath`（`src/api.ts:452-463`）。M10 后新评审写请求文件、不再写 `latestReviewPath`，面板评审卡会变空（KI-18）。
- `src/client/*` 仍按 thread 列表/详情/交接单渲染：排序与计数按五态 thread，详情读 handoff；没有工作项、评审请求、活动流、已解决/重开/改投入口。
- 左侧栏与 reviewer 可见性没有在插件侧收口：M6 决策 (b) 是「主题可见、reviewer 隐藏」，但面板没有过滤 reviewer，也没有把「打开主题只切主区」的交互落地（KI-28）。

M11 的验收要求面板显示主题列表/详情/活动、无 thread 行与 reviewer 行、写路由同源可读错误、真实 Chrome 检查通过（[PLAN-V0.2 §6 M11](../../../../docs/PLAN-V0.2.md)）。数据源已经就绪，缺的是 wire、读路由、写路由与 client 重写。

## Proposal

**1) Wire v2（`src/api-contract.ts`）。** 用 v2 类型替换 thread 形态，v1 类型与 `HANDOFF_PATH` 同交付删除（0.2.0 破坏性变更，M12 README 记录）：

- `PanelTopic`：`topicId/title/status(active|idle|resolved)/blocked/awaitingReview/reviewStatus/latestReviewRequestId/digest(≤200)/scope/ownedPaths/lastActiveAt/updatedAt/lastDeliveryConfirmedAt/resolvedAt/resolvedBy/activeWorkItems`。
- `PanelWorkItem`：`workItemId/topicId/path/branch/baseCommit/headCommit/status/updatedAt`。
- `PanelReviewRequest`：`requestId/topicId/workItemId/purpose/status/baseCommit/headCommit/changedPaths(≤50)/requestedAt/reviewedAt/summary(≤200)/findings(≤20)/verification(≤10)`；不回传 reviewerSessionId 与 handoff 全文。
- `PanelActivityEvent`、`PanelInboxItem`（`id/time/topicId/kind/summary/deliveredAt`）、`PanelCounts`（五态主题、标记、pending review、work item 四态）。
- 边界：overview 主题 ≤500；activity 默认 50、上限 200；详情 workItems ≤50、reviewRequests ≤10、findings ≤20、verification ≤10、changedPaths ≤50、activity ≤50；所有 summary/digest ≤200。
- 错误信封沿用 M3 形状（`{ error: { code, message, path? } }`）；新增 `topic/not-found`、`topic/not-resolved`、`topic/already-resolved`、`route/move-invalid`，与现有 `request/*`/`session/*`/`store/*` 同表。

**2) 读路由（`src/api.ts`）。**

- `GET /api/cowork.overview`：读前在项目锁内跑 `evaluateProjectLifecycle`，传 `activeWorkItemsOf: (topicId, doc) => activeWorkItemCount(doc, topicId)`（M10 的读取点约定，KI-24）；返回 v2 主题、计数、≤500 行，不返回 thread/reviewer/handoff 字段。
- `GET /api/cowork.activity?limit=`：活动尾部与 `skippedLines`。
- `GET /api/cowork.topic?id=`：主题行 + 工作项 + 该主题的评审请求（用 store 的文本端口读 `reviews/<topicId>-<requestId>.json`，用 `review-request.ts` 的 parse）+ 该主题活动尾部；reviewer 会话与 handoff 全文不出现。
- 评审请求读取不调用 `store.listReviews`/`latestReviews`/`writeReview`，`latestReviewPath` 不再作为当前状态来源（KI-18 收口）。

**3) 写路由（`src/api.ts`）。**

- `POST /api/cowork.topic.resolve`：`{sessionId, topicId}`；只允许该项目 master；锁内幂等置 `resolved/ resolvedBy='user'/resolvedAt`，写 `status-changed` 活动（`by:'user'`）。
- `POST /api/cowork.topic.reopen`：只允许 master；只有 `resolved` 可重开；清 `resolvedAt/resolvedBy`、回 `active`、写 `topic-reopened`；面板随后 `openSession`。
- `POST /api/cowork.route.move`：`{sessionId, fromTopicId, toTopicId, intent?}`；复用 `applyRouteCorrectionToStore` 的别名规则（去重、≤50、单条 ≤32），写 `route-corrected`；拒绝已解决目标。
- 安全：沿用宿主 loopback；插件侧增加 `Origin`/`Host` 同源与 `content-type: application/json` 检查（M6 探针 6 已验证该组合，缺 content-type 415、坏来源 403）；请求体 ≤8 KiB；错误码映射 HTTP 状态，错误文案可读。

**4) Client 重写（`src/client/*`）。**

- `contracts.ts`/`api.ts`/`model.ts` 改 v2：主题列表按状态与最近活动排序（已解决仍列出），计数覆盖五态与标记；详情模型含工作项、评审请求、活动、操作可用性。
- `list.tsx`：主题行（状态芯片、blocked/awaitingReview/reviewStatus、摘要、最近活动），无 thread 行、无 reviewer 行。
- `detail.tsx`：摘要、工作项表、评审卡（请求范围/verdict/findings/verification，来自请求文件）、活动尾部、操作（打开/标记已解决/重新打开/移动到其他主题/复制路径）。
- `panel.tsx`：CoWork 右侧栏 tab；默认 tab 仍是普通会话，不自动打开；footer 入口保留。
- 打开主题：`uiWorkspace.openSession(topicId)` 只切主区；不新增/移除左侧栏条目、不新开窗口、不切右侧栏；面包屑/左侧栏回 master。主题被用户预先归档时，打开前容错 unarchive（非常规路径）。
- 左侧栏策略 (b)：插件不对主题调用 `archiveSession`；reviewer 仅 verdict 后归档（`session-visibility.ts` 已有），面板不列 reviewer；live reviewer 仍可能在宿主左侧栏出现，是接受的上限（KI-28）。
- 已解决主题：仍显示，状态芯片区分 `user`/`master` 来源；重开清空解决字段。

**5) AgentTeams 边界。** 面板只展示评审请求与 verdict 事实，不触发评审、不合并；最终评审负责人仍只有一个（cowork reviewer 终评或采用 AgentTeams verdict，[评审请求模型](../../implemented/feature/2026-11-07-review-request-model.md)）；M11 不引入 AgentTeams 运行时依赖。

**6) 预算与构建。** 新 client 按 §4.2 拆分为 contracts/api/model/list/detail/panel/chips/styles；单文件 <51,200 B。client 由 `npm run build` 预打包为 `lib/client.js`，仓库没有 dev watcher；改 client 后必须重跑构建并在真实 Chrome 验证加载的 bundle。

## Alternatives considered

**继续用 v1 thread 面板，增量补字段。** 否决：两套数据模型并存，`latestReviewPath`/thread 行会长期留在 wire 与 UI；KI-18 无法收口，工作项与评审请求没有位置；M11 的验收要求「无 thread 行」。

**左侧栏列出所有会话，包括 reviewer。** 否决：M6 决策 (b) 与探针 5 已确认 host 没有会话过滤接口；reviewer 是过程会话，每评审一次多一行；用户明确选择只隐藏 reviewer。列出 reviewer 会让注意力成本随评审次数增长。

**面板内嵌多个面板或在主区做满页 master+主题同屏。** 否决：宿主主区同一时间只显示一个会话；分屏需要宿主持久化改动，超出插件能力；PLAN §5.9 明确「不做主题内嵌多面板」。

**引入第三方编排器（AgentTeams runtime、dsh-agent-hub、dsh-forge）。** 否决：会抢 `sessionController`/`workspaceRegistry`/子代理池；AGENTS.md 禁止 multi-orchestrator；cowork 只借隔离与评审语义，面板与 API 自己拥有。

**继续用 `latestReviewPath`/legacy review 文件渲染评审卡。** 否决：M10 已不再写该字段，新评审在 reviews/ 请求文件里；旧文件只读；继续读会让面板在 M10 后变空，且无法绑定 requestId。

**用 archive 隐藏主题以缩小左侧栏。** 否决：M6 探针 3 证明归档后 turn `blocked`、消息不落盘，unarchive 才恢复；决策 (b) 已放弃该路径。

## Acceptance criteria

- [A1] `api-contract.ts` 提供 v2 wire（主题/工作项/评审请求/活动/inbox/计数）与上界；v1 `PanelThread`/`PanelHandoffRecord`/`HANDOFF_PATH` 删除；错误信封保持 M3 形状 — `tests`：`tests/api-contract.test.mjs`
- [A2] overview 读前在锁内评估生命周期并传真实 `activeWorkItemsOf`；返回 v2 主题与计数（≤500），不含 thread/reviewer/handoff 字段 — `tests`：`tests/api.test.mjs`
- [A3] activity 与 topic 详情路由有界（activity ≤50、reviewRequests ≤10、findings ≤20、verification ≤10、changedPaths ≤50、workItems ≤50），评审请求从 `reviews/*.json` 读取 — `tests`：`tests/api.test.mjs`
- [A4] resolve/reopen/route.move 只允许 master、要求 `sessionId`、锁内原子且幂等，并写对应活动；缺 content-type 415、坏 Origin/Host 403、错误码可读 — `tests`：`tests/api.test.mjs`
- [A5] 左侧栏策略 (b)：主题保留可见、reviewer 不作为行、插件不对主题 `archiveSession`；打开主题只切主区，不新增/移除左侧栏条目，面包屑回 master；预归档主题才 unarchive — `tests`：`tests/panel-model.test.mjs`
- [A6] CoWork 是右侧栏 tab，默认 tab 仍是普通会话、不自动打开、footer 入口可用；列表/详情/活动/操作齐全，已解决主题仍列出并显示来源 — `tests`：`tests/panel-model.test.mjs`
- [A7] 评审卡来自请求文件（requestId/范围/verdict/findings），legacy `latestReviewPath` 不再是当前状态来源；旧 review/handoff 文件只读 — `tests`：`tests/api.test.mjs`、`tests/source-budget.test.mjs`
- [A8] 真实 Chrome：同源写路由在已认证面板上下文返回 200 且回显 body；R8 预算（`bsk_session` ≤10、无 >60s 等待）、R9 fixture（apply/restore ≤5s、真实 index hash/主题数恢复）；截图与 run 记录进入 M11 交付记录 — `decisions`：`docs/M11_RESULT.md` 与面板 run 记录
- [A9] `npm run typecheck`/`build`/`check` 通过；`lib/client.js` 由 `npm run build` 产出；`src/**/*.ts` <51,200 B，client 文件按模块拆分 — `source`：`tests/source-budget.test.mjs`、`scripts/build.sh`
- [A10] M11 收口：M11_RESULT/HANDOFF/KNOWN_ISSUES/publish.json 更新；AgentTeams 单一评审负责人边界写入文档；PLAN §4.5 的过时「主题隐藏」行修正或标注 — `plan-docs`：`docs/M11_RESULT.md`、`docs/PLAN-V0.2.md`、`docs/KNOWN_ISSUES.md`

## Risks

- **旧 API 消费方（KI-6）。** 删除 v1 thread 字段与 `/api/cowork.handoff` 是破坏性 wire 变更；仓库外无已知消费方，但 M12 README 必须记录升级与回退。重审条件：出现外部调用方或面板与 host 版本错配。
- **真实数据（KI-22）。** 面板要读 canonical v2 与旧文件只读；真实 v1/v2 索引、`awaitingReview` 与 legacy review 指针只在 `os.tmpdir()` 夹具上验证过，真实数据演练归 M12。重审条件：真实仓库打开面板报错或显示空评审卡。
- **Fixture 隔离（R9）。** 面板验证必须用独立 fixture repo/DSH_HOME/port，apply/restore 一次完成并校验 hash；不能在宿主服务 panel 请求时改真实 `.dsh-cowork`。重审条件：出现真实数据被 fixture 覆盖或 restore 超 5s。
- **Client 构建与缓存（KI-11/KI-16）。** `lib/client.js` 是预打包产物；注入器/profile 的 pkgMeta 与 Node ESM 缓存可能提供旧 bundle，表现为「源码已改、真机仍旧」。重审条件：真实 Chrome 行为与源码不一致时，先核对 bundle hash/重启宿主。
- **同源与认证（M6 探针 6 限制）。** Origin/Host/content-type 已在探针验证；认证后的 `/api` POST 未验证（401 与 cookie 属宿主认证，不读取/不绕过）。M11 要在真实已认证面板上下文补证据；错误文案必须可读。
- **reviewer 可见性（KI-28）。** 宿主没有会话过滤接口，live reviewer 仍可能在左侧栏出现；面板不列、verdict 后归档是接受的上限。重审条件：宿主提供隐藏/过滤接口。
- **文件预算。** api-contract/api/client 重写会接近 50 KiB 单文件上限；按模块拆分，预算由 `tests/source-budget.test.mjs` 锁定。
- **PLAN 文档不一致。** PLAN §4.5 的会话表仍写「主题会话 | 隐藏」，与 §2.4/§5.9/§5.10 的决策 (b) 冲突；M11 以实现与验收为准（主题可见、reviewer 隐藏），M12 文档收口时修正。
- **真实 Chrome 与 headless 差异、无移动端。** M11 只承诺真实 Chrome 已有布局；移动端、多窗口与 headless 差异不在范围。

## Delivery stages

1. **Wire v2 与契约测试**：重写 `api-contract.ts` 的类型/上界/错误码，删除 v1 thread 类型；同步 `tests/api-contract.test.mjs` 与 client 解析类型。
2. **读路由与读取点**：overview（锁内生命周期、真实工作项计数）、activity、topic 详情（工作项/评审请求/活动）；`tests/api.test.mjs` 覆盖边界与 legacy 读取移除。
3. **写路由与安全**：resolve/reopen/route.move；master-only、sessionId、Origin/Host/content-type、幂等与活动；测试覆盖 403/415/只有 master。
4. **Client 模型与列表**：contracts/api/model 改 v2；列表、状态芯片、摘要与计数；无 thread/reviewer 行。
5. **详情、评审卡与操作**：工作项表、评审卡、活动尾部、打开/已解决/重开/改投；面包屑与左侧栏行为（决策 (b)）；`tests/panel-model.test.mjs` 覆盖。
6. **真实 Chrome 与收口**：R8/R9 验证、截图与 run 记录；M11_RESULT/HANDOFF/KNOWN_ISSUES/publish.json；四命令全绿后停等确认，不进入 M12。
