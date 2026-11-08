# Decision: M7 索引 v2 迁移采用「纯函数迁移 + store 事务入口」

Status: implemented
Date: 2026-11-07
Class: architecture

## Problem

M7 要把 `.dsh-cowork/index.json` 从 v1（六态 thread 中心）迁到 v2（`topics[]` + `workItems[]`），并补上 activity/inbox 的文件读写。数据模型、字段与状态映射由 [索引 v2 与迁移](../../proposed/architecture/2026-11-07-topic-store-v2.md) 拥有；执行层面要固定的是另一些事：模块怎么拆、迁移在哪个时点触发、备份与写入的顺序、失败如何保留现场、测试先写哪些。

M6 补的两条约束至今成立：取消在途 reviewer 必须 `archiveSession(id,{stopActivity:true})`（立即归档会让会话无法继续），且 `awaiting_review` 迁移时归档失败不能让迁移假装成功（[M6 探针结果](../../../../docs/M6_PROBE_RESULT.md) §3/§4）。没有这些约定，M7 会写成「一次性替换 `store.ts`」，既不可单测，也会顶到单文件读取上限。

## Decision

**模块拆分（按 PLAN-V0.2 §4.2）。**

- `src/store-schema.ts` 是纯类型与纯校验，无 I/O：常量 `INDEX_VERSION_V2 = 2`、`INDEX_VERSION_V1 = 1`、`ACTIVITY_MAX_EVENTS = 500`、`ACTIVITY_MAX_BYTES = 524288`、`INBOX_MAX_ITEMS = 50`；枚举 `TOPIC_STATUSES`、`WORK_ITEM_STATUSES`、`INBOX_KINDS`、`REVIEW_STATUSES`、`ACTIVITY_TYPES`、`LEGACY_THREAD_STATUSES`、`LEGACY_STATUS_MARKERS`；接口 `TopicRecordV2`、`WorkItemRecordV2`、`ProjectIndexV2`、`ActivityEvent`、`InboxItem`、`ThreadRecordV1`、`ProjectIndexV1`；函数 `normalizeProjectIndexV1`、`normalizeProjectIndexV2`、`projectIndexV1Problems`、`projectIndexV2Problems`、`activityEventProblems`、`inboxItemProblems`、`threadV1Problems`。handoff/review 记录的纯校验（`handoffRecordProblems`、`reviewRecordProblems`）也从 `store.ts` 迁到这里，为 `store.ts` 腾出预算。
- `src/store-migration.ts` 是纯函数，不读文件、不加锁、不取时间：`migrateV1ToV2(document)` 返回 `{document, report}`；`MigrationError` 的 `code` 为 `migration/unknown-status` 或 `migration/invalid`，message 带位置；`MigrationReport` 字段为 `fromVersion`、`toVersion`、`migrated`、`statusCounts`（六态逐项）、`resolvedTopics`、`pendingReviewerArchives`、`archiveFailures`、`unknownFields`、`legacyFieldsPreserved`；另有 `legacyViewOf`、`applyLegacyView`、`isLegacyIndexDocument`。
- `src/store.ts` 仍是索引、handoff、review、activity、inbox 的唯一写者：新增 `backupFile`、`activityFile`、`inboxFile`、`lastMigrationReport` getter，`ProjectStoreOptions` 新增可选 `archiveSession` 端口。
- A1 的宿主接线（`6cb294c`）：`SessionSlicePorts['workspaces'].archiveSession` 增加可选 `{stopActivity}` 并由 `SessionSlice.archiveSession` 原样转发；`src/tools.ts` 的单一 `projectStoreFor` helper（`openProject` 与 `cowork_project_init` 共用，`src/tools.ts:100-106`）与 `src/index.ts` 的 `panelPorts.createStore` 都把 `workspaceRegistry.archiveSession` 注入 `ProjectStoreOptions.archiveSession`。真实迁移取消在途评审时，执行的是宿主归档，而不是记录一次「端口缺失」。

**磁盘格式。** `index.json` 只写 `{version: 2, projectId, masterSessionId, createdAt, topics, workItems}`，不再写 `threads`。topic 字段按 PLAN-V0.2 §4.3，另加四个容忍的 v1 附加字段（`lastHandoffAt`、`reviewRequestedAt`、`reviewedAt`、`latestReviewPath`）与 `legacyStatus`（只允许 `new`/`archived`）。M7 的 `workItems` 恒为 `[]`。

**六态映射与兼容视图。** 迁移逐态映射：`new`/`active` → `active`；`awaiting_review` → `active` 且 `awaitingReview=false`、`reviewStatus=null`、`reviewerSessionId=null`，原 reviewer 进 `pendingReviewerArchives`；`blocked` → `active` + `blocked=true`；`done`/`archived` → `resolved`，`resolvedBy='master'`、`resolvedAt` 与 `lastDeliveryConfirmedAt` 取 v1 `updatedAt`。`legacyStatus` 保留 `new`/`archived` 这两个 v2 三态无法表达的原始状态，`legacyViewOf` 优先用它还原，其余按 `resolved→done`、`blocked→blocked`、`awaitingReview→awaiting_review`、否则 `active` 派生；四个附加字段原样带回。`applyLegacyView` 把 view 当**完整文档**：view 未提及的 topic 被删除（覆盖 `src/tools.ts:386-390` 的建线程失败回滚）、legacy 新增线程按迁移默认值追加、按传入 status 同步 `awaitingReview`/`blocked`/`resolvedAt`/`resolvedBy`/`lastDeliveryConfirmedAt` 并维护 `legacyStatus`，而 `scope`、`ownedPaths`、`aliases`、`digest`、`lastActiveAt`、`latestReviewRequestId`、`workItems` 与文档信封不被 legacy 覆盖。`migrateV1ToV2` 对 v2 文档是恒等，重复调用不产生第二次备份；未知状态与损坏文档一律 fail closed。

**读写路径。** `readIndex()` 保持现有签名并返回 v1 兼容视图：v1 文档只做归一化（不迁移、不备份、不改字节与 mtime，保留 `awaiting_review`/`reviewStatus` 原值）；v2 文档归一化后经 `legacyViewOf` 派生。`initIndex`、`rebindMaster`、`mutateIndex`、`addThread`、`updateThread` 最终都只写 v2；`mutateIndex` 在锁内执行 `readIndexForWrite` → `legacyViewOf` → mutator → `applyLegacyView` → `projectIndexV2Problems` → 原子写。

**迁移事务（项目锁内，顺序固定）。** 重读原文档 → `migrateV1ToV2` → `projectIndexV2Problems` 校验 → 若 `index.v1.backup.json` 不存在，则原子写入**原 v1 文件字节**（0600，已存在绝不覆盖）→ 对 `pendingReviewerArchives` 逐个 `archiveSession(reviewerSessionId,{stopActivity:true})` → 写迁移 activity（成功一条 `status-changed`，每个归档失败一条 `error`）→ 原子写 v2 → `fsync` 目录。除归档失败外任一步失败都抛 `StoreError('store/corrupt', …)`，保留原文件与备份，不静默重建、不半写。归档失败由 store 填进 `report.archiveFailures` 后继续写 v2：reviewer 指针已清空，但迁移不得宣称「评审已安全取消」。

**锁与原子写。** index、activity、inbox、handoff、review 共用 `.write.lock` 的 `withFileLock`；写入走 `writeFileAtomic`（0600 文件、0700 目录）后 `fsyncDirectory`。`appendActivity` 在锁内读现有行（损坏行跳过并计数）→ 追加 → 按 500 条与 524288 字节裁剪最旧 → 整文件原子重写，`readActivity(limit = 50)` 返回尾部事件与 `skippedLines`。inbox 整读整写：`readInbox` 对损坏 JSON 或非法 item 抛 `store/corrupt`；`writeInbox` 逐项校验后保留最新 50 条并原子重写。M7 只做文件层，合并、投递与重放属 M8。

**测试先行与拆分。** 实现提交 `73d4083`，测试拆分提交 `a262273`，A1 接线与 E2E 索引 v2 兼容提交 `6cb294c`，基线 `9eeec16`（未 push、无 PR）。原先 `tests/store.test.mjs` 在 M7 后到 55,363 B，超过 P2 的 50 KiB 单文件读取线，因此新增的 15 组 v2 store 测试移入 `tests/store-v2.test.mjs`，原 23 条测试与断言留在 `tests/store.test.mjs`；拆分后两文件分别为 34,625 B 与 23,623 B。

## Alternatives considered

**一次性重写 `store.ts`，不拆 schema/migration 模块。** 否决：迁移必须用真文件系统与锁才能测，一次性重写无法单测；`store.ts` 当时已 42 KB，再加 v2 逻辑会越过 50 KiB 读取上限。实现后确认拆分还带来一个额外好处：`migrateV1ToV2` 的六态、幂等、未知字段容忍和视图投影能在纯内存里逐条钉住。

**读时惰性迁移、下次写入才落盘。** 否决：会出现「内存 v2、磁盘 v1」的双事实与竞争窗口。实现后进一步收敛为更严格的规则：纯读取连内存迁移都不做，直接按 v1 归一化返回，只有写路径在锁内迁移并落盘；这样一次读取不会产生未备份、未归档 reviewer 的半迁移状态。

**保留 v1 字段、只增补 v2（双写）。** 否决：thread 中心 schema 已在 topic-store-v2 被否；双写制造两个事实源和竞争条件。实现后确认，兼容视图不是可选过渡层：M7 不允许改 `tools.ts`/`api.ts`/`handoff.ts`/`review-tools.ts`，它们仍消费 v1 形状；没有 `legacyViewOf`/`applyLegacyView`，就只能改调用方或双写，而双写会重造两个事实源。

**把 reviewer 归档放进纯迁移函数。** 否决：迁移函数要可单测，宿主归档是异步 I/O 且会失败，必须由调用方执行并把失败写进报告。实现后确认端口化还让三条路径都能测：成功调用、抛错、未接线。

**迁移时自动解决所有状态、不 fail closed。** 否决：未知状态或损坏文档自动重建会掩盖数据问题；计划要求报 `store/corrupt` 并保留现场。实现中把这条扩到 v2：写路径上校验失败的 v2 文档同样不覆盖原文件。

**M7 同时建 `activity.ts`/`inbox.ts` 空壳。** 否决：规则在 M8 才定义，空壳会制造「已存在」的错觉并增加类型面。实现后确认 M7 只需要文件 I/O：上限、坏行、原子重写在这里；合并与投递留在 M8。

**兼容视图保留 view 未提及的 topic（实现中否决的初版）。** 否决：`src/tools.ts:386-390` 用 `mutateIndex` 过滤线程来回滚失败的建线程；若视图当补丁合并，磁盘会留下孤儿 topic。视图必须当完整文档，删除即删除。

## Consequences

- 新增约束：写只写 v2，读兼容 v1。迁移后不再有 v1 写者；回滚只能恢复 `index.v1.backup.json` 并重装 `0.1.0`（M12 文档化）。
- **A1 的宿主接线已补齐（`6cb294c`）**：`SessionSlicePorts['workspaces'].archiveSession` 支持 `{stopActivity}`，`SessionSlice` 透传；`src/tools.ts` 的单一 `projectStoreFor` helper 与 `src/index.ts` 的 `panelPorts.createStore` 都注入 `workspaceRegistry.archiveSession`。证据是 host-free 的 tool 层测试：`tests/tools-init.test.mjs` 用 fake `workspaceRegistry` + 真实 `ProjectStore`，在 v1 `awaiting_review` 索引上执行 `takeOver`，断言端口收到 `(reviewerSessionId,{stopActivity:true})`、磁盘写成 v2、备份等于原 v1 字节。仍真实的限制：归档调用失败时 store 只记录、不重试，旧 reviewer 会话可能悬挂；迁移报告只留在内存（KI-19）、activity 先于 index 写（KI-20）、真实宿主 E2E 与真实 v1 数据迁移未跑（KI-22）。
- `lastMigrationReport` 只在内存里保留最近一次迁移报告；进程重启后证据只剩 activity 的 `error`/`status-changed` 事件与备份文件，无法回放 `archiveFailures` 的完整形状（[KNOWN_ISSUES](../../../../docs/KNOWN_ISSUES.md) KI-19）。
- `recordMigrationActivity` 在写 `index.json` 之前执行：若 activity 写成功而 index 写失败，原文件与备份都保留，但下一次写入会重新迁移，从而重复调用 `archiveSession` 并追加重复的活动事件（KI-20）。
- `fsyncDirectory` 的崩溃持久性只有代码路径证据（`src/store.ts` 的 `writeJson`/`writeMigrationBackup`/`appendActivityLocked`），没有可观测断言，真机断电行为未验证（KI-21）。
- 未知 v1 状态、损坏的 v1/v2 文档一律 `store/corrupt` 且保留原文件；项目不会静默重建索引。代价是损坏文件需要人工处理，而不是自动恢复。
- `workItems` 在 M7 恒为 `[]`，删除 topic 不级联清理工作项；生命周期与级联清理属 M8/M10。旧 `checkoutPath` 只保留为 `legacyCheckoutPath`，旧隔离 clone 不自动转工作项。
- 纯读取 v1 时视图保留 `awaiting_review` 与 `reviewStatus` 原值（迁移尚未发生）；只有第一次写才取消在途评审。调用方若在迁移前读到 `awaiting_review`，看到的是磁盘事实，而不是迁移后的状态。
- 范围：M7 不动工具、UI 与默认行为。E2E 的 `parseIndex` 已兼容 v2（`src/m2-e2e-support.ts`、`src/m3-e2e-support.ts` 用 `normalizeProjectIndexV2` + `projectIndexV2Problems` 校验后经 `legacyViewOf` 投影，v1 原样返回），但驱动本体未在真实宿主重跑，真实 v1 数据迁移也未演练，测试只用 `os.tmpdir()` 夹具（KI-22）。

## Testing

- [A1] v1 六态逐条迁移，`awaiting_review` 取消在途评审并归档旧 reviewer，`done`/`archived` 转 resolved，未知状态 fail closed — `tests`：`tests/store-migration.test.mjs`（`v1 status new migrates…`、`v1 awaiting_review cancels…`、`v1 blocked migrates…`、`v1 done migrates…`、`v1 archived migrates…`、`an unknown v1 status fails closed…`）、`tests/store-v2.test.mjs`（`every v1 state migrates…`、`an archive failure is recorded…`）、`tests/tools-init.test.mjs`（`cowork_project_init migrates a v1 index and archives the cancelled reviewer`，真实 ProjectStore + fake registry 断言 `{stopActivity:true}`）与 `tests/session-slice.test.mjs`（`archiveSession` 的 options 透传与无参 `undefined`）。真实 v1 数据迁移与真实宿主 E2E unpinned：KI-22 / M12。
- [A2] 迁移前写 `index.v1.backup.json`（原字节、已存在不覆盖），迁移失败保留备份与原文件并报 `store/corrupt`，v2 幂等不二次备份 — `tests`：`tests/store-v2.test.mjs`（`the first write migrates…`、`an unknown v1 status fails closed…`、`a v2 index round-trips…`）与 `tests/store-migration.test.mjs`（`migrating an already valid v2 document is an identity`、`a migrated document is a fixed point…`）。`fsync` 崩溃持久性 unpinned：仅代码路径，无可观测断言。
- [A3] 写只写 v2、读兼容 v1、索引/活动/收件箱共用项目锁 — `tests`：`tests/store-v2.test.mjs`（`a v1 index is read as…`、`concurrent activity appends lose nothing`）、`tests/store.test.mjs`（`initIndex creates…`、`readIndex reads a pre-M2 index…`、`concurrent writers serialize…`）与 `tests/store-schema.test.mjs`（`v1 normalization adopts the pre-M2 worktreePath name`、`the exported constants…`）。
- [A4] 归档失败写进迁移报告与 activity、不静默成功；activity 上限与坏行、inbox 原子重写与损坏处理 — `tests`：`tests/store-v2.test.mjs`（`an archive failure is recorded…`、`activity keeps the newest 500 events`、`activity trims by serialized bytes…`、`activity skips damaged lines…`、`appendActivity rejects an invalid event…`、`inbox writes, reads…`、`inbox damage fails closed…`）。
- [A5] 模块边界与 source budget 保持，typecheck/build 通过 — `source`：在 A1 接线提交 `6cb294c` 上实际运行 `npm test`（429 pass / 0 fail / 0 skip / 0 todo）、`npm run typecheck`、`npm run build`、`npm run check`，均 exit 0；`src/store.ts` 47,351 B，`src/**/*.ts` 最大 49,923 B（`src/m2-e2e.ts`，均 < 51,200 B），`src/` 无 M8–M12 模块。
