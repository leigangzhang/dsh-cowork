# Decision: 主题索引 v2、评审请求文件、活动流与收件箱

Status: implemented
Date: 2026-11-07
Class: architecture

## Problem

M4 的 `.dsh-cowork/index.json` 是 thread 中心：`threads[]`、六态、`checkoutPath`、review 字段直接挂在 thread 上。评审文件是 verdict-only，没有请求范围；没有活动流，也没有 master 收件箱。用户需要三态主题、评审请求、活动流与收件箱，但这些事实在现有数据模型里没有位置。

迁移也不能简单改字段：v1 的 `awaiting_review` 有在途 reviewer，`done/archived` 是结果而不是进行中，`checkoutPath` 是旧 clone。直接覆盖会让旧数据不可读、评审会话悬挂、旧 clone 失联。本记录固定 v2 存储、文件布局与 v1 迁移策略；评审请求的业务规则由 [评审请求模型](../feature/2026-11-07-review-request-model.md) 拥有，状态规则由 [三态生命周期](../feature/2026-11-07-three-state-lifecycle.md) 拥有。详细字段见 [PLAN-V0.2 §4.3/§5.2](../../../../docs/PLAN-V0.2.md)。

## Decision

**索引 v2。** `index.json` 写 `version: 2`、`topics[]`、`workItems[]`。`TopicRecord` 字段：`topicId/title/status/awaitingReview/blocked/scope/ownedPaths/aliases/digest/cwd/legacyCheckoutPath/createdAt/updatedAt/lastActiveAt/lastDeliveryConfirmedAt/resolvedAt/resolvedBy/latestReviewRequestId/reviewStatus/reviewerSessionId`。`WorkItemRecord` 字段见 [并行隔离与合并](./2026-11-07-parallel-isolation-and-merge.md)。写只写 v2；读兼容 v1，内存里归一化。

**评审请求文件。** `reviews/<topicId>-<requestId>.json` 保存请求与 verdict 在同一文件：请求字段、`status`、`reviewerSessionId`、`requestedAt`、`reviewedAt`、`verdict`。一次请求一个文件，verdict 后不再新建文件；上一轮通过 `previousRequestId` 关联。旧的 `reviews/<threadId>-<stamp>.json` 保留只读，不重写。

**活动流。** `.dsh-cowork/activity.jsonl`，每行一个事件：`eventId/time/type/topicId/summary/details`。最多 500 条或 512 KiB，超出删最旧；读取尾部。事件类型包括主题创建、路由复用/新建/纠正、状态变化、评审请求/结论、工作项创建/合并、错误。

**master 收件箱。** `.dsh-cowork/inbox.json`，最多 50 条：`id/time/topicId/kind/summary/deliveredAt`。`kind` 只允许 `merge-needed`、`blocked`、`review-reject`、`cross-topic-conflict`。投递成功写 `deliveredAt`；失败保留，`cowork_project_status` 重放；不丢事件。

**迁移。** 首次读取 v1 后写 v2 前，复制 `.dsh-cowork/index.v1.backup.json`。映射：

| v1 | v2 |
|---|---|
| `threads[]` | `topics[]` |
| `new` / `active` | `active` |
| `awaiting_review` | `active`；取消在途评审，归档旧 reviewer，`awaitingReview=false`，`reviewStatus=null` |
| `blocked` | `active` + `blocked=true` |
| `done` / `archived` | `resolved`；`resolvedBy='master'`，`resolvedAt=updatedAt`，`lastDeliveryConfirmedAt=updatedAt` |
| `threadId` / `subject` | `topicId` / `title` |
| `checkoutPath` | `legacyCheckoutPath`（旧 clone 不自动转 work item） |
| 旧 `handoffs/`、`reviews/` | 保留只读，不重写 |

**归档在途 reviewer。** 迁移与回收里归档 reviewer 必须用 `archiveSession(id,{stopActivity:true})`：默认参数要求会话不活跃，运行中的 reviewer 会被拒绝（`WorkspaceActiveSessionError`；`dsh-workspace/lib/index.js:531-533`），而 `stopActivity` 会先停活动再写归档。新建 reviewer 的回收仍必须 after-verdict：创建后立即归档会让 turn 以 `blocked` 结束、拿不到 verdict（M6 探针 4，见 [M6 探针结果](../../../../docs/M6_PROBE_RESULT.md) §4）。

迁移失败保留备份并报 `store/corrupt`，不静默重建。迁移是单向的；回滚靠恢复备份并重装 `0.1.0`。

**兼容别名。** 旧工具 `cowork_thread_create/list`、`cowork_checkout_merge(threadId)`、`cowork_review_request(threadId)` 保留一个版本，内部映射到 v2；旧 preset `cowork-thread` 保留，指向 topic 行。版本升到 `0.2.0`；README 与 M12 交接写明破坏性变更与迁移。

**一致性与锁。** index、activity、inbox、review 文件共用 `.write.lock`；每次替换先 temp + rename，再 fsync 目录；读不加锁，看到旧或新完整文档。activity 追加后裁剪；inbox 原子重写。

## Alternatives considered

**保留 thread 中心 schema，只加字段。** 否决：六态、thread 命名、review 字段直接挂会话会把旧模型带进新代码；迁移与路由都会不断写兼容分支。v2 用 topics/workItems 两个清晰实体。

**评审请求与 verdict 分成两个文件。** 否决：一次请求一个文件更容易保证 request/verdict 绑定，UI 与测试也只读一个位置；分开会增加两个写入点与不一致窗口。

**把活动流放进 index.json 的数组。** 否决：活动是追加型高频数据，会让索引持续变大并每次整写；独立 JSONL 可以追加、裁剪、按尾部读取。

**只把待决定事件作为 prompt，不落收件箱。** 否决：投递失败就丢事件（KI-17 的同类问题）；落盘 + `deliveredAt` + status 重放才能保证不丢。

**不做备份，迁移直接覆盖。** 否决：迁移涉及状态与路径语义，失败会让项目不可读；备份是回滚的唯一入口。

**同时读写 v1 和 v2（双写）。** 否决：双写会制造两个事实源和竞争条件；0.2.0 是一次单向迁移，回滚靠备份与重装。

**把旧 handoff/review 文件改写成 v2。** 否决：历史证据不该被改写；新代码只读新布局，旧文件保留只读，M12 文档说明。

## Consequences

- 迁移数据丢失：备份 + fail closed + 逐状态测试；迁移前不删旧文件。重审条件：出现无法映射的状态或字段。
- 旧 clone 失联：`legacyCheckoutPath` 只保留路径，不自动转工作项；旧隔离主题需要人工处理。重审条件：用户有未合并的旧 isolated thread。
- 活动/收件箱文件损坏：损坏行跳过并记录；整文件损坏时报错，不静默覆盖。重审条件：出现并发写入或磁盘错误。
- schema 漂移：v2 字段只在 `store-schema.ts` 定义；新增字段必须带默认值和迁移说明。重审条件：出现第二个写索引的模块。
- 版本兼容：0.2.0 不能读回 v1 的运行时；回滚必须恢复备份并重装。重审条件：需要双向迁移。
- 落地路径：M6 探针 3/4 已确认 archive 语义与 reviewer 回收时机（见 [M6 探针结果](../../../../docs/M6_PROBE_RESULT.md) §3/§4）；M7 落地 v2 schema、迁移、备份与 activity/inbox 文件读写和锁（见 [M7 执行记录](./2026-11-07-store-v2-migration-plan.md)）；M8 把活动流裁剪、收件箱合并/重放接入生命周期（见 [M8 交付结果](../../../../docs/M8_RESULT.md)）；M10 落地评审请求文件写入与 verdict 合并（见 [M10 交付结果](../../../../docs/M10_RESULT.md)）；M12 完成迁移/回滚的真实 E2E 与文档收口。
- 本记录由 M12 从 `proposed/architecture/` 下的同名提案迁入 `implemented/architecture/` 并按 implemented 骨架重写；交付事实与证据见 [M8 交付结果](../../../../docs/M8_RESULT.md) 与 [M10 交付结果](../../../../docs/M10_RESULT.md)。

## Testing

- [A1] v1 六态逐条迁移到 v2；`awaiting_review` 取消在途评审并归档旧 reviewer；`done/archived` 转 resolved — `tests`：`tests/store-v2.test.mjs`
- [A2] 迁移前写 `index.v1.backup.json`；迁移失败保留备份并报 `store/corrupt`，不静默重建 — `tests`：`tests/store-v2.test.mjs`
- [A3] v2 round-trip 读写稳定；写只写 v2，读兼容 v1；索引/活动/收件箱共用锁 — `tests`：`tests/store-v2.test.mjs`、`tests/store.test.mjs`
- [A4] 活动流上限 500 条/512 KiB 并裁剪最旧；收件箱投递失败保留并可重放 — `tests`：`tests/activity.test.mjs`、`tests/inbox.test.mjs`
- [A5] 旧工具/preset 别名映射到 v2；`0.2.0` 的迁移、回滚与别名写进 README 与 M12 交接 — `decisions`：本记录、[PLAN-V0.2](../../../../docs/PLAN-V0.2.md) §4.3/§5.2、[README](../../../../README.md)、[M12 交接](../../../../docs/M12_HANDOFF.md)
