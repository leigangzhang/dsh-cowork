# Decision: M11 HTTP API v2 与 CoWork 面板重写

Status: implemented
Date: 2026-11-08
Class: architecture

## Problem

M10 把运行时的数据模型收口到 canonical v2（`topics`/`workItems`/评审请求文件/activity/inbox），但面板与 HTTP API 在 M11 启动时仍是 M3 的 thread 形态：

- `src/api-contract.ts` 只描述 v1：`PanelThread`、五态 `PanelThreadStatus`、`PanelHandoffRecord`、`PanelReviewPayload`，以及 `OVERVIEW_PATH`/`HANDOFF_PATH` 两条路径；评审字段来自索引里的 `reviewStatus`/`latestReviewPath`。
- `src/api.ts` 只注册 overview 与 legacy handoff 两条路由，overview 读 legacy `readIndex()`，评审卡取 `latestReviewPath`。M10 后新评审写请求文件、不再写 `latestReviewPath`，面板评审卡会变空（KI-18）。
- `src/client/*` 仍按 thread 列表/详情/交接单渲染：排序与计数按五态 thread，详情读 handoff；没有工作项、评审请求、活动流、已解决/重开/改投入口。
- 左侧栏与 reviewer 可见性没有在插件侧收口：M6 决策 (b) 是「主题可见、reviewer 隐藏」，但面板没有过滤 reviewer，也没有把「打开主题只切主区」的交互落地（KI-28）。

M11 的验收要求面板显示主题列表/详情/活动、无 thread 行与 reviewer 行、写路由同源可读错误、真实 Chrome 检查通过（[PLAN-V0.2 §6 M11](../../../../docs/PLAN-V0.2.md)）。数据源已经就绪，缺的是 wire、读路由、写路由与 client 重写。

## Decision

**1) Wire v2（`src/api-contract.ts`，17,046 B）。** 用 v2 类型替换 thread 形态，v1 类型与 `HANDOFF_PATH` 随 M11 删除（0.2.0 破坏性变更，M12 README 记录）：

- 六条路径：`OVERVIEW_PATH`、`ACTIVITY_PATH`、`TOPIC_PATH`、`RESOLVE_PATH`、`REOPEN_PATH`、`ROUTE_MOVE_PATH`（`/api/cowork.*`）。
- `PanelTopic`：`topicId/title/status(active|idle|resolved)/blocked/awaitingReview/reviewStatus/latestReviewRequestId/digest(≤200)/scope/ownedPaths(≤50)/lastActiveAt/updatedAt/lastDeliveryConfirmedAt/resolvedAt/resolvedBy/activeWorkItems`。
- `PanelWorkItem`：`workItemId/topicId/path/branch/baseCommit/headCommit/status/updatedAt`。
- `PanelReviewRequest`：`requestId/topicId/workItemId/purpose/status/baseCommit/headCommit/changedPaths(≤50)/requestedAt/reviewedAt/summary(≤200)/findings(≤20)/verification(≤10)`；不回传 reviewerSessionId 与 handoff 全文。
- `PanelActivityEvent`、`PanelInboxItem`（`id/time/topicId/kind/summary/deliveredAt`）、`PanelCounts`（10 个扁平计数：三态主题、两个标记、pending review、工作项四态）、`PanelProject`。
- 上界常量：`MAX_PANEL_TOPICS=500`、`ACTIVITY_DEFAULT_LIMIT=50`、`ACTIVITY_MAX_LIMIT=200`、`TOPIC_ACTIVITY_LIMIT=50`、`MAX_TOPIC_WORK_ITEMS=50`、`MAX_TOPIC_REVIEW_REQUESTS=10`、`MAX_REVIEW_FINDINGS=20`、`MAX_REVIEW_VERIFICATION=10`、`MAX_REVIEW_CHANGED_PATHS=50`、`MAX_TOPIC_OWNED_PATHS=50`、`MAX_SUMMARY_CHARS=200`、`MAX_INBOX_ITEMS=20`、`MAX_REQUEST_BODY_BYTES=8192`。
- 错误信封沿用 M3 形状（`{ok:false,error:{code,message,path?}}`）；`PanelErrorCode` 收齐 17 个码（含 `request/*`、`request/not-master`、`topic/not-found`、`topic/not-resolved`、`route/move-invalid`）；`src/api.ts` 用 `Record<PanelErrorCode, number>` 映射状态，漏一个码即编译错。

**2) 读路由（`src/api.ts`，39,114 B）。**

- `GET overview?sessionId`：项目定位沿用 `sessionId` → `sessionController.list` 元数据 cwd → `findProjectRoot`，保留 30 s 列表超时与 `session/unknown`、`session/cwd-unavailable`、`session/list-timeout`、`project/not-initialized` 语义；读前在项目锁内跑 `evaluateProjectLifecycle`，传 `activeWorkItemsOf: (topicId, doc) => activeWorkItemCount(doc, topicId)`（KI-24），其 `activityErrors` 只进 `ports.log`；返回 v2 主题（≤500、面板排序）、`countPanel` 计数、≤20 条未投递 inbox，不含 thread/reviewer/handoff 字段。
- `GET activity?sessionId&limit`：`limit` 缺省 50、必须 1..200 的整数，否则 400 `request/invalid-query`；返回事件尾部与 `skippedLines`，不做生命周期评估。
- `GET topic?sessionId&topicId`：主题行 + 工作项（该主题、`updatedAt` 降序、≤50）+ 评审请求（从 `store.reviewsDir` 列 `<topicId>-*.json`，逐个 `readText` → `parseReviewRequestRecord`，文件名必须等于 `reviewRequestFileName(record.topicId, record.requestId)`，按 `requestedAt` 降序取 ≤10）+ 该主题活动（`readActivity(200)` 过滤后取最后 50 条）。
- 评审请求读取不调用 `store.listReviews`/`latestReviews`/`writeReview`，`latestReviewPath` 不再作为当前状态来源（KI-18 收口到剩余只读面）。

**3) 写路由与安全（`src/api.ts`）。**

- 统一前置：Host 必须是 loopback（`isLoopbackHost`）、存在 Origin 时必须与 Host 同源（否则 403 `request/origin`）、`content-type: application/json`（否则 415）、body ≤8 KiB（否则 413）、合法 JSON 对象（否则 400）、必填 id 非空白（否则 400）；`openWrite` 读文档并做 master 校验（403 `request/not-master`），锁内再校验一次。
- `POST resolve {sessionId,topicId}`：一次 `mutateIndexDocument` 内查找/查重；已 `resolved` 返回 200 + `alreadyResolved:true` 且不写；否则置 `status='resolved'`、`resolvedBy='user'`、`resolvedAt`/`updatedAt=now`，锁外追加 `status-changed` 活动（`details.from/to/by`）。
- `POST reopen {sessionId,topicId}`：非 `resolved` → 409 `topic/not-resolved`；`reopenResolvedTopic` 生成（清 `resolvedAt/resolvedBy`、回 `active`、刷新 `lastActiveAt/updatedAt`），锁外追加 `topic-reopened`。
- `POST route.move {sessionId,fromTopicId,toTopicId,intent}`：`from===to`、空白/超 500 字 intent、已解决目标都 400 `route/move-invalid`；from/to 都必须存在（404）；用纯函数 `applyRouteCorrection(to,intent)`（不调用会再取锁的 `applyRouteCorrectionToStore`），有变化才写回并追加 `route-corrected`（`details.added` 截 20）。
- 活动行在 `mutateIndexDocument` 之后用**独立**的 store 写锁追加（文件锁不可重入）；活动失败只 `ports.log`，不把已提交的写回滚成错误。

**4) 装配（`src/index.ts`，31,874 B）。** 只改面板端口：`listSessions`、`findProjectRoot`、`createStore`（新增 `clock`）、`now`、`idleAfterMs`、`resolveAfterMs`、`log`（`ctx.logger?.warn?.()`）。不承载业务。

**5) Client 重写（`src/client/*` 9 文件，合计 111,739 B，最大 `model.ts` 21,259 B）。** `contracts.ts`/`api.ts`/`model.ts` 改 v2（`model.ts` 不依赖 React，可单测）；`list.tsx` 只列主题（状态芯片、blocked/awaitingReview/reviewStatus、摘要、最近活动），无 thread 行、无 reviewer 行；`detail.tsx` 显示摘要、工作项表、评审卡（来自请求文件）、活动尾部与操作（打开/标记已解决/重新打开/移动到其他主题/复制路径）；`panel.tsx` 是右侧栏 CoWork tab，默认 tab 仍是普通会话、不自动打开、footer 入口保留；打开主题用 `uiWorkspace.openSession(topicId)` 只切主区，不新增/移除左侧栏条目、不 `archiveSession`，仅当会话已被用户预先归档时先 `unarchive` 再打开（容错路径），面包屑回 master。左侧栏策略 (b)：主题保留可见、reviewer 只在 verdict 后归档（`session-visibility.ts` 已有），live reviewer 仍可能在宿主左侧栏出现（KI-28 接受上限）。

**6) Fixture（`tools/panel-fixture.mjs`，23,226 B）。** `apply [--repo] [--master] [--live-topic]` / `restore [--repo]`：备份 index/activity/inbox/reviews 到 `<repo>/.dsh-cowork/e2e/m11/panel-fixture/backup`（已存在则拒绝）；写 7 个主题（active/idle/resolved(user)/resolved(master)/blocked+awaitingReview+pending/needs_revision/pass）、4 个工作项（四态）、10 条活动、2 条 inbox（1 未投递）、3 个评审请求文件；写前用 `projectIndexV2Problems`/`activityEventProblems`/`inboxItemProblems`/`reviewRequestRecordProblems` + `reviewRequestFileName` 自校验；restore 原子恢复并打印 index sha256 与 topic/thread 数；不写任何 Markdown。

**7) AgentTeams 边界。** 面板只展示评审请求与 verdict 事实，不触发评审、不合并；最终评审负责人仍只有一个（cowork reviewer 终评或采用 AgentTeams verdict，[评审请求模型](../feature/2026-11-07-review-request-model.md)）；M11 不引入 AgentTeams 运行时依赖。

**8) 构建与预算。** client 由 `npm run build` 预打包为 `lib/client.js`（89,235 B，sha `3b1b3588…`），仓库没有 dev watcher；`src/**/*.ts` 每个 <51,200 B（最大仍为 `src/m2-e2e.ts` 49,923 B）。

## Alternatives considered

**继续用 v1 thread 面板，增量补字段。** 否决：两套数据模型并存，`latestReviewPath`/thread 行会长期留在 wire 与 UI；KI-18 无法收口，工作项与评审请求没有位置；M11 的验收要求「无 thread 行」。

**左侧栏列出所有会话，包括 reviewer。** 否决：M6 决策 (b) 与探针 5 已确认 host 没有会话过滤接口；reviewer 是过程会话，每评审一次多一行；用户明确选择只隐藏 reviewer。列出 reviewer 会让注意力成本随评审次数增长。落地后确认：插件侧只能做到「面板不列 + verdict 后归档」，宿主左侧栏仍可能出现（KI-28）。

**面板内嵌多个面板或在主区做满页 master+主题同屏。** 否决：宿主主区同一时间只显示一个会话；分屏需要宿主持久化改动，超出插件能力；PLAN §5.9 明确「不做主题内嵌多面板」。

**引入第三方编排器（AgentTeams runtime、dsh-agent-hub、dsh-forge）。** 否决：会抢 `sessionController`/`workspaceRegistry`/子代理池；AGENTS.md 禁止 multi-orchestrator；cowork 只借隔离与评审语义，面板与 API 自己拥有。

**继续用 `latestReviewPath`/legacy review 文件渲染评审卡。** 否决：M10 已不再写该字段，新评审在 `reviews/` 请求文件里；旧文件只读；继续读会让面板在 M10 后变空，且无法绑定 requestId。落地后 `tests/api.test.mjs` 用「文件名与记录不一致即跳过」和「store 端口上没有 legacy 方法」把这条否决钉住。

**用 archive 隐藏主题以缩小左侧栏。** 否决：M6 探针 3 证明归档后 turn `blocked`、消息不落盘，unarchive 才恢复；决策 (b) 已放弃该路径。M11 只在打开已归档主题时容错 unarchive。

**把写路由做成多个 HTTP 动词（PUT/PATCH/DELETE）。** 未采用：宿主的 Exact Fetch 通道与 M6 探针只验证了 GET/POST，面板只需要三个动作；保留三条 POST 路由让同源与 content-type 检查集中在一处。

**在同一次锁里写索引和活动行。** 否决：项目锁是文件锁、不可重入；`mutateIndexDocument` 内再调 `appendActivity` 会二次取锁并超时。实际实现为锁内事务、锁外活动，活动失败只记日志。

## Consequences

- **破坏性 wire 变更。** v1 `PanelThread`/`PanelHandoffRecord`/`HANDOFF_PATH` 删除，host 与 `lib/client.js` 必须同批升级/回滚；旧 client 配新 host（或反之）不可用。外部消费方与升级说明归 M12 README（KI-6）。
- **KI-18 只剩只读面。** 面板/API 已切到请求文件；`store.readIndex`/`mutateIndex` 与 `applyLegacyView` 仍服务 `project_init` 载荷与旧 thread clone 合并，旧 review/handoff 文件只读；移除此兼容面归 M12。
- **resolve 幂等（D1）。** 提案原写 `topic/already-resolved` 错误码，落地为 200 + `alreadyResolved:true`：A4 要求幂等，错误码会让面板把重复点击显示为失败；`PanelErrorCode` 因此不含该码。
- **route.move 追加式（D2/KI-32）。** `applyRouteCorrection` 每次最多加 8 个 token、只对已有别名去重，重复提交同一 intent 会继续追加剩余 token（总数 ≤50、单条 ≤32）。`changed/added` 让结果可见；严格幂等键未实现。
- **重开不清评审事实。** reopen 只清 `resolvedAt`/`resolvedBy` 并回 `active`；`reviewStatus`/`latestReviewRequestId` 保留为历史，面板按字段区分展示。
- **生命周期读取点会迁移 v1 磁盘（D3）。** overview 在锁内 `mutateIndexDocument`，v1 项目首次打开面板即执行 M7 的 on-write 迁移（写 v2 + `index.v1.backup.json` + 生命周期活动）。这是设计中的升级行为，M12 升级文档必须写明「打开面板即迁移」及其回滚路径。
- **`CoworkStorePort` 增加 `appendActivity`（D6）。** 写路由的活动行与 `evaluateProjectLifecycle` 的 `LifecycleStorePort` 都需要；其余端口为 `hasIndex/readIndexDocument/mutateIndexDocument/readActivity/readInbox/readText/reviewsDir`。
- **计数与 inbox 形状（D7）。** `PanelCounts` 是 10 个扁平字段（非嵌套），overview 另带 ≤20 条未投递 inbox 驱动面板「待处理」chip；评审状态与计数同源，不为每态单开字段。
- **打开主题的边界（D4/D5/D8）。** 打开只切主区；预归档主题的 unarchive 只在单测（`openTopicSteps`）与代码 try/catch 中钉住，未在真实 Chrome 覆盖（无「已归档且有 repo cwd」的会话），归 M12 真实 E2E；「复制路径」复制项目 `repoPath`（按钮 title 说明），剪贴板写入未断言；打开主题后宿主可能关闭右栏，是宿主按会话记忆右栏状态（R4），不是插件调用，左侧栏无增删。
- **reviewer 可见性上限未变（KI-28）。** 面板不列 reviewer、verdict 后归档已实现；宿主左侧栏仍可能可见，无过滤接口。重估条件：宿主提供会话过滤/分组接口。
- **正式安装路径未验证（KI-31）。** 真实 Chrome 用 dev 注入器 + 别名包（`@dsh-external/dsh-cowork-alias-v1`）绕过 pkgMeta/ESM 缓存（KI-11/KI-16）；交付包名不变，`npm pack` → profile add → 重启的 v2 验证归 M12。
- **重审条件。** 出现仓库外 API 消费方、面板与 host 版本错配、真实 v1 数据迁移失败、面板请求出现跨源误伤、或宿主提供会话过滤接口时，重新评估本决定。

## Testing

- [A1] v2 wire 提供六条路径、13 条上界与 17 个错误码，v1 `PanelThread`/`PanelHandoffRecord`/`HANDOFF_PATH` 不存在 — `tests`：`tests/api-contract.test.mjs`（19/19）
- [A2] overview 读前在锁内评估生命周期并传真实工作项计数；主题 ≤500、排序正确、无 thread/reviewer/handoff 字段；inbox 只列未投递 — `tests`：`tests/api.test.mjs`（生命周期/上限/排序/键集/inbox 用例）与真实 Chrome overview 200（`docs/archived/M11_RESULT.md` A2）
- [A3] activity 默认 50/上限 200/非法 400 且透出 `skippedLines`；topic 详情 workItems ≤50、reviewRequests ≤10、findings ≤20、verification ≤10、changedPaths ≤50、活动 ≤50；评审请求只从 `reviews/*.json` 读取（坏 JSON、文件名不匹配、legacy 判决文件被跳过） — `tests`：`tests/api.test.mjs`（真实 tmpdir 请求文件与截断用例）
- [A4] resolve/reopen/route.move 只允许 master、要求 `sessionId`、锁内原子且幂等，写对应活动且活动失败不失败请求；415/413/400/403 与错误码可读 — `tests`：`tests/api.test.mjs`（幂等/409/route.move 拒绝/非 master/真实 `ProjectStore` 全链路/安全矩阵）与真实 Chrome 写路由 200 与 403/415/400（`docs/archived/M11_RESULT.md` A4）
- [A5] 主题保留可见、reviewer 不作为行、插件不对主题 `archiveSession`；打开主题只切主区、面包屑回 master；预归档主题才 unarchive — `tests`：`tests/panel-model.test.mjs`（`openTopicSteps`）与真实 Chrome 截图 05/06；unarchive 真机路径未覆盖（`docs/archived/M11_RESULT.md` D4）
- [A6] CoWork 是右侧栏 tab、默认不自动打开、footer 入口可用；列表/详情/活动/操作齐全，已解决主题仍列出并显示来源 — `tests`：`tests/panel-model.test.mjs` 与真实 Chrome 截图 01–04、06
- [A7] 评审卡来自请求文件（requestId/范围/verdict/findings/verification），legacy `latestReviewPath`/`listReviews`/`latestReviews`/`writeReview` 不再是读取面 — `tests`：`tests/api.test.mjs`、`tests/source-budget.test.mjs`；`grep -n "latestReviewPath\|listReviews\|latestReviews\|writeReview" src/api.ts` 无匹配
- [A8] 真实 Chrome：已认证同源写路由 200 且回显 body；R8 预算（`bsk_session` 3 次 start、>60 s 等待 0）；R9 fixture apply/restore ≤5 s、真实 index hash 恢复 — `decisions`：`.dsh-cowork/e2e/m11/panel-run.json`、6 张 jpg、`INTEGRATION_READY.json`（gitignored），摘要见 `docs/archived/M11_RESULT.md` A8
- [A9] `typecheck`/`build`/`check` 通过；`lib/client.js` 由构建产出；`src/**/*.ts` <51,200 B，client 按模块拆分 — `source`：`tests/source-budget.test.mjs`、`scripts/build.sh`；`npm test` 732/732
- [A10] M11 收口：M11_RESULT/HANDOFF/KNOWN_ISSUES/publish.json/README/PLAN-V0.2 更新；3 份决策记录迁为 implemented；单一评审负责人边界写入文档 — `plan-docs`：`docs/archived/M11_RESULT.md`、`docs/PLAN-V0.2.md`、`docs/KNOWN_ISSUES.md`、`docs/publish.json`、`docs/README.md`
