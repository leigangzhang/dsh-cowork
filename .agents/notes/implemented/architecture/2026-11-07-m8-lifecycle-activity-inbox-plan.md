# Decision: M8 主题生命周期、活动与收件箱采用纯规则层 + canonical v2 store

Status: implemented
Date: 2026-11-07
Class: architecture

## Problem

M7 把索引落到 v2（`topics[]`/`workItems[]`）、实现迁移事务与 activity/inbox 的文件 I/O，并让未改造的 v1 调用方继续通过兼容视图工作（[M7 迁移实施记录](./2026-11-07-store-v2-migration-plan.md)）。但 M7 只拥有存储与投影：没有任何代码维护主题的生命周期与活动语义——没有 `idle`/`resolved` 判定，没有 `turn/end` 的 `lastActiveAt` 更新，没有重开，没有业务活动事件；收件箱只有文件层，没有合并、投递与重放。索引里的主题因此永远停在 `active`，v2 的 `lastActiveAt`、`digest`、`lastDeliveryConfirmedAt` 没有写入者，M9 的路由与 M11 的面板都没有可用的状态。

M8 的主需求规则由 [主题三态与已解决规则](../feature/2026-11-07-three-state-lifecycle.md) 拥有，数据模型由 [索引 v2 与迁移](./2026-11-07-topic-store-v2.md) 拥有，状态机与验收见 [PLAN-V0.2](../../../../docs/PLAN-V0.2.md) §2.3/§5.1/§5.6/§6 M8。本记录固定执行层：模块边界、store 扩展、评估时机、KI 处置与测试归属。

写提案时核对过的 M7 执行缺口，M8 已全部补上：store 只有 v1 兼容视图而没有 canonical v2 文档读写；`ACTIVITY_TYPES` 没有 `topic-reopened`；`src/topic.ts`、`src/topic-events.ts`、`src/activity.ts`、`src/inbox.ts` 不存在；迁移 activity 先于 index 写（KI-20，已在 M8 修复并从 [KNOWN_ISSUES](../../../../docs/KNOWN_ISSUES.md) 删除）。

## Decision

**1) store 增加 canonical v2 文档读写（`src/store.ts`），v1 兼容层只减不增。**

- `readIndexDocument(): Promise<ProjectIndexV2>`：磁盘是 v2 时用 `normalizeProjectIndexV2` + `projectIndexV2Problems` 校验后返回；磁盘是 v1 时归一化并 `projectIndexV1Problems` 校验，再用 `migrateV1ToV2(normalized, { cancelInFlightReviews: false })` 在内存投影成 v2，最后对投影再跑 `projectIndexV2Problems`（投影可能因 v1 未知扩展字段撞名而违反 v2 schema，撞名即 `store/corrupt` fail closed）。全过程不写盘、不备份、不归档、不改 mtime；缺文件仍是 `store/not-found`，损坏仍是 `store/corrupt`。
- `mutateIndexDocument(mutator: (document: ProjectIndexV2) => ProjectIndexV2 | null): Promise<ProjectIndexV2>`：`ensureProjectDir` → 项目锁 → `readIndexForWrite()`（必要时先完成 M7 迁移）→ mutator（拿到锁内重读的文档）→ 返回 `null` 表示放弃，返回锁内文档且不写盘（对已是 v2 的磁盘，`index.json` 字节与 mtime 不变）→ 否则 `projectIndexV2Problems` 校验后原子写 v2 并返回。
- `readIndex()` 改为 `legacyViewOf(await this.readIndexDocument())`，v1 磁盘上仍保留 `awaiting_review`/`reviewStatus`/`reviewerSessionId` 原值；`mutateIndex()` 委托 `mutateIndexDocument` + `applyLegacyView`，冻结的旧行为（视图当完整文档、v2-only 字段由 base 继承）不变。
- `migrateV1ToV2(document, options?)` 新增 `{ cancelInFlightReviews?: boolean }`，默认 `true` 保持 M7 写语义（`awaiting_review` → active + `awaitingReview=false`、清 review 指针、reviewer 进 `pendingReviewerArchives`）；`false` 是只读投影（`awaitingReview=true`，保留 `reviewStatus`/`reviewerSessionId`，不产生归档意图）。`readIndexForWrite` 保持默认写模式。
- 已知偏差，均为有意的边界：v1 未知 thread/document 扩展字段在 v1 兼容视图中不再透出（canonical v2 文档与 `applyLegacyView` 写回仍保留，不丢数据）；v1 磁盘上 `mutateIndexDocument` 即使 mutator 返回 `null` 也已先完成 M7 迁移写盘（`readIndexForWrite` 的固有语义）。

**2) 纯规则模块（`src/topic.ts`）。** 三态判定、2 小时/3 天阈值（idle 严格 `>`、resolve `>=`）、五个已解决条件、无撤销、重开清 `resolvedAt`/`resolvedBy` 全部是纯函数；函数与默认值见 [主题三态与已解决规则](../feature/2026-11-07-three-state-lifecycle.md)，此处不重复。

**3) 事件监听（`src/topic-events.ts`，host-free、端口注入）。**

- `TopicEvents` 的端口是 `onSessionEvent`、`resolveRepoPath`、`storeFor`、`clock`、`log`；`attach()` 幂等并返回幂等 disposer。
- `turn/end`：解析项目根 → `readIndexDocument` → 只有 `topicId === session.id` 的 known topic 才继续 → `mutateIndexDocument` 内重新查找并 `noteTopicActivity`，返回同一对象（resolved）时返回 `null` 放弃；不写活动事件，不处理 master/reviewer/外来会话。
- `user/message`：只对 `resolved` topic 生效；锁内再次确认仍 `resolved` 才 `reopenResolvedTopic`，并追加一条 `topic-reopened` 事件（`eventId`、`time`、`topicId`、`summary`、`details` 取旧 `resolvedAt`/`resolvedBy`）；mutate 返回 `null`（并发已重开/已不存在）时不追加事件，多条消息只产生一条事件。
- 监听器整体不向宿主事件总线抛错：read/mutate/append 任何失败只经 `log` 记录；活动 append 失败时索引保持已重开，不回滚。
- `src/index.ts` 只做装配：`ctx.on('session/event', …)`、`session.header.cwd` → `findProjectRoot`、按 repo 构造 `ProjectStore`（注入 `workspaceRegistry.archiveSession`）、`ctx.effect(() => topicEvents.attach(), 'dsh-cowork: topic lifecycle events')`。
- 依赖与限制：`turn/end`/`user/message` 的宿主行为来自 [M6 探针结果](../../../../docs/M6_PROBE_RESULT.md) §2；`session.header.cwd` 解析项目根依赖 header 的稳定性，M6 未验证、M12 真实 E2E 首验（F2，未核实）。

**4) 业务活动（`src/activity.ts`）。** 导出 `buildActivityEvent(input, now)`、`recordActivity(sink, input, now)`、`topicReopenedActivity(topic, now)`、`statusChangedActivity(...)`、`errorActivity(...)`；只构造与记录事件，文件 I/O 与 500 条 / 524288 B 上限、坏行跳过仍由 `src/store.ts` 的 `appendActivity`/`readActivity` 提供。`ACTIVITY_TYPES`（`src/store-schema.ts`）增加 `topic-reopened`。
已知偏差（F1）：M8.2 在 `src/topic-events.ts` 内联构造 `topic-reopened`，未复用 `topicReopenedActivity`，两处形状/摘要不同（都经 store 校验）；这是 M8.1/M8.2 并行 worktree 的边界产物，当前不视为缺陷，M9 接线 `activity`/`cowork_project_status` 时统一。

**5) 收件箱（`src/inbox.ts`）。** `Inbox` 构造注入 store、prompt 端口与 clock；`enqueue(events)` 合并待办（每次 `INBOX_MAX_BATCH = 5`，摘要 `INBOX_SUMMARY_MAX_CHARS = 200`），`flush()` 逐批投递，成功把 `deliveredAt` 写回 `writeInbox`，失败保留未投递项；`replay()` 即再次 `flush()`。50 条上限与原子重写由 M7 store 的 `writeInbox` 提供。调用点（`cowork_project_status`）归 M9。
已知偏差（F3）：`flush` 先投递成功、后 `writeInbox` 失败时，重放会重复投递（at-least-once）；M9 接线时需幂等/去重或在 prompt 端口处理，M8 只记录不修。

**6) KI-20 顺序修复（`src/store.ts` 的迁移事务）。** 顺序改为「校验 → 备份 → 归档 → 写 v2 → 写迁移 activity」：v2 落盘之后才追加迁移活动；activity 写失败不再让迁移失败，原因记入 `MigrationReport.activityFailure`，v2 与备份保留。重试看到的已是 v2，走 pass-through，不重复迁移、不重复 `archiveSession`、不重复事件。

**7) 评估时机与阶段边界。** M8 只实现规则与 `turn/end`/重开钩子；`cowork_project_status`、`cowork_route`、面板 overview 的读取点评估显式留给 M9/M11。M8 不改 `src/tools.ts`、`src/api.ts`、`src/api-contract.ts`、`src/client/**`、`presets/**`，不建 work item / review-request / session-visibility 模块，不跑真实宿主 E2E 或真实数据迁移（M12）。

## Alternatives considered

**只读时惰性迁移、或直接用 v1 兼容视图，不加 canonical v2 API。** 否决：M8 的规则全部作用在 v2 字段上；v1 视图把 `resolvedAt`/`resolvedBy`/`legacyStatus` 折成 v1 状态，规则层若自己反推会复制一套状态映射，写回还要再造投影。canonical 读写把「锁内重读」「迁移投影只在内存」集中在 store 一处。实现后补强了一点：只读投影必须用 `cancelInFlightReviews:false`，否则读会假装评审已被取消，并与 `readIndex()` 不一致。

**用后台定时器在 2 小时/3 天整点主动评估。** 否决：定时器增加后台状态、跨重启与并发复杂度；PLAN §5.1 已定惰性评估，`turn/end` 与后续阶段的读取点覆盖常用时机。重审条件：用户要求离线也按时标记，或面板长期不打开。

**把活动/收件箱业务规则塞进 `store.ts`。** 否决：store 是文件 I/O 与锁的单一写者；M7 已把 activity/inbox 的规则显式推迟到 M8，塞回去会让 store 超出 49,152 B 审查线，也让业务规则无法脱离文件系统单测。实现中确实触线（M8.1 后 49,024 B），最后把 activity 流 helper 移到 `store-schema.ts` 才降到 48,524 B。

**在 M8 就接 `cowork_project_status`/`cowork_route`/面板的读取点评估。** 否决：这些调用点分别属于 M9 的工具与 M11 的面板，M8 不得改它们；提前改会让 M8 越过阶段边界，也把尚未稳定的工具/面板接口拖进生命周期实现。纯函数 + `mutateIndexDocument` 已为后续调用点准备好唯一写入口。

**保持 KI-20 的顺序、只把 activity 失败变成致命（或在失败后重试 activity）。** 否决：致命会把已经写好或待写好的索引拖回失败态；重试 activity 仍无法消除「activity 成功、index 失败」后的重复迁移与重复归档调用。顺序改成先写 v2 才是根因修复。

**评估时不重读 `lastActiveAt`，直接按调用方快照写 resolved。** 否决：用户新消息与自动标记会竞争，可能把刚活跃的主题标成已解决（无撤销）；锁内重读是唯一低成本的一致性点。`mutateIndexDocument` 的 mutator 就是这条规则的落点。

**读投影直接复用写语义的 `migrateV1ToV2`（实现中否决的初版）。** 否决：写语义会取消 `awaiting_review` 并产生归档意图，读路径既会与 `readIndex()` 不一致，也违背 M7「纯读不迁移」的意图；因此加 `cancelInFlightReviews`，默认值保持写路径不变。

**事件构造统一走 `activity.ts`（实现中未能采用的初版）。** 否决原因不是设计判断，而是 M8.1/M8.2 并行 worktree 的边界：`topic-events.ts` 先落地，`activity.ts` 在另一分支，合并后两处都能构造 `topic-reopened`。两者都经 store 校验，事件语义一致；统一留给 M9 接线 activity 时处理（F1）。

## Consequences

- M8 之后主题有真实生命周期：`turn/end` 刷新 `lastActiveAt` 并把 `idle` 拉回 `active`；用户重新打开已解决主题会重开并留 `topic-reopened` 证据。自动 resolved 只在五个条件全部满足时发生，且写 `resolvedBy='master'`/`resolvedAt`，不提供撤销。
- 读取点尚未接入：`cowork_project_status`/`cowork_route`/面板读取不会主动评估，主题可能显示旧 `idle` 或满足条件却未标记，直到 M9/M11。重审条件：M9 未按计划接入读取点，或用户报告状态长期不更新。
- `workItems` 在 M8 恒为 `[]`，第三个已解决条件恒真；M10 必须把真实 active 工作项计数传入 `evaluateTopicLifecycle`，否则可能误标还在进行的主题。
- KI-20 已修复：迁移先写 v2 再写活动，`MigrationReport.activityFailure` 记录活动失败且不推翻迁移，重试不再重复归档或重复事件；KI-20 行已从 [KNOWN_ISSUES](../../../../docs/KNOWN_ISSUES.md) 删除。KI-19（`lastMigrationReport` 只在内存）保持不变，重启后证据仍是 activity 与 `index.v1.backup.json`。
- 预算：`src/store.ts` 48,524 B（< 49,152 B）；`src/**/*.ts` 最大 49,923 B（`src/m2-e2e.ts`，< 51,200 B）；新增模块 `src/topic.ts`、`src/topic-events.ts`、`src/activity.ts`、`src/inbox.ts` 都独立成文件，`src/store.ts` 只保留存储与锁。
- v1 兼容层继续存在，M8 的新代码一律用 canonical v2 API；v1 未知扩展字段在 v1 兼容视图里不再透出（canonical v2 文档与 legacy 写回仍保留，不丢数据）；v1 磁盘上 `mutateIndexDocument(null)` 仍先完成 M7 迁移写盘。
- 已知 low 级偏差（均不阻塞 M8，归属已定）：F1 `activity.ts` builder 暂时无生产调用者、`topic-events.ts` 内联同名事件，M9 统一；F2 事件监听的 `session.header.cwd` 依赖未在 M6 探针记录，M12 真实 E2E 首验；F3 `Inbox.flush` 的 at-least-once 重复投递风险，M9 接线前处理。
- 范围与未验证：不改 tools/api/api-contract/presets/panel；不建 M9–M12 模块；真实宿主 E2E 与真实 v1 数据迁移未跑（KI-22，M12）；`turn/end`/`user/message` 的宿主行为只在 M6 探针的进程内与 host-free fake 事件源上验证过（每会话 500 条缓冲上限未验证）。

## Testing

- [A1] canonical v2 读写：v1 只读投影不写盘/不备份/不归档且投影按 v2 schema fail closed，`mutateIndexDocument` 首次写迁移并归档、`null` 不写盘 — `tests`：`tests/store-v2.test.mjs`（`readIndexDocument projects a v1 index without writing the migration`、`readIndexDocument fails closed when a v1 extension collides with a v2 field`、`mutateIndexDocument returning null writes nothing`、`the first mutateIndexDocument write migrates a v1 index for real`）
- [A2] 三态与两标记、2 小时边界、flags 抑制 idle、新活动回 active — `tests`：`tests/topic.test.mjs`（`an active topic turns idle only after the two-hour window`、`awaitingReview and blocked suppress idle…`）
- [A3] 五条件逐条缺失不标记、3 天边界、无撤销 — `tests`：`tests/topic.test.mjs`（`a topic is resolved only when all five conditions hold`、`the three-day threshold is inclusive and wins over idle`、`the module exposes no undo path`）
- [A4] `turn/end` 锁内更新并回 active；`user/message` 重开且只写一条事件；锁内放弃不写不发事件 — `tests`：`tests/topic-events.test.mjs`（`turn/end returns an idle topic to active…`、`user/message reopens a resolved topic and records one topic-reopened event`、`a reopen abandoned under the lock writes nothing and records no event`）
- [A5] 活动类型含 `topic-reopened`，文件层复用 500 条/524288 B 与坏行跳过 — `tests`：`tests/activity.test.mjs` 与 `tests/store-schema.test.mjs`（`the exported enumerations match PLAN-V0.2 §4.3`）
- [A6] 收件箱合并/投递/重放/50 条上限 — `tests`：`tests/inbox.test.mjs`
- [A7] KI-20 顺序：v2 落盘后 activity 失败记录 `activityFailure` 且不推翻迁移，重试不重复归档 — `tests`：`tests/store-v2.test.mjs` 的迁移顺序用例
- [A8] 模块边界、预算与不改 tools/api/presets/panel — `source`：`npm test`（485 pass / 0 fail / 0 skip / 0 todo）、`npm run typecheck`、`npm run build`、`npm run check` 均 exit 0；`src/store.ts` 48,524 B，`src` 最大 49,923 B；`git diff --name-only 06ff66b..HEAD` 不含 `src/tools.ts`、`src/api.ts`、`src/api-contract.ts`、`src/client/**`、`presets/**`
- [A9] `migrateV1ToV2` 两种模式：默认写模式取消评审并产生待归档列表；只读模式保留指针且不产生归档意图；v1 上 `readIndexDocument` 与 `readIndex()` 一致 — `tests`：`tests/store-migration.test.mjs`（`the default migration mode is the write mode`、`the read-only mode keeps an in-flight review in place`、`both modes agree on every state except the in-flight review`）与 `tests/store-v2.test.mjs`（`readIndex matches the read-only document projection on v1 and v2`）
