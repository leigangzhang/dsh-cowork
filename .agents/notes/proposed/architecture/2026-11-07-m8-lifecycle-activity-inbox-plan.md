# Proposal: M8 主题生命周期、活动与收件箱执行提案

Status: proposed
Date: 2026-11-07
Class: architecture

## Problem

M7 把索引落到 v2（`topics[]`/`workItems[]`）、实现迁移事务与 activity/inbox 的文件 I/O，并让未改造的 v1 调用方继续通过兼容视图工作（[M7 迁移实施记录](../../implemented/architecture/2026-11-07-store-v2-migration-plan.md)）。但 M7 只拥有存储与投影：没有任何代码维护主题的生命周期与活动语义——没有 `idle`/`resolved` 判定，没有 `turn/end` 的 `lastActiveAt` 更新，没有重开，没有业务活动事件；收件箱只有文件层，没有合并、投递与重放。索引里的主题因此永远停在 `active`，v2 的 `lastActiveAt`、`digest`、`lastDeliveryConfirmedAt` 没有写入者，M9 的路由与 M11 的面板都没有可用的状态。

M8 的主需求规则由 [主题三态与已解决规则](../feature/2026-11-07-three-state-lifecycle.md) 拥有，数据模型由 [索引 v2 与迁移](2026-11-07-topic-store-v2.md) 拥有，状态机与验收见 [PLAN-V0.2](../../../../docs/PLAN-V0.2.md) §2.3/§5.1/§5.6/§6 M8。本记录只固定执行层：模块边界、store 扩展、评估时机、KI 处置与测试顺序，不重复需求规则全文。

写提案时逐条核对过代码的 M7 执行缺口：

- store 只有 v1 兼容视图：`src/store.ts` 的 `readIndex()`/`mutateIndex()` 走 `legacyViewOf`/`applyLegacyView`，没有 canonical v2 文档读写；而 M8 的规则要读 `status`、`awaitingReview`、`blocked`、`lastActiveAt`、`resolvedAt`、`lastDeliveryConfirmedAt`、`workItems` 等 v2 字段。
- `ACTIVITY_TYPES`（`src/store-schema.ts`）还没有 `topic-reopened`。
- `src/topic.ts`、`src/topic-events.ts`、`src/activity.ts`、`src/inbox.ts` 都不存在；`src/topic*.ts` 为空。
- 迁移 activity 顺序问题是 KI-20：activity 先于 index 写，activity 成功而 index 失败会让下一次写重跑迁移，重复 `archiveSession` 调用与重复事件（[KNOWN_ISSUES](../../../../docs/KNOWN_ISSUES.md) KI-20）。

## Proposal

**1) store 增加 canonical v2 读写，v1 兼容层保持只减不增。**

`src/store.ts` 新增两个公开方法，现有 v1 API 的签名与行为不变（`tools.ts`/`api.ts`/`handoff.ts`/`review-tools.ts` 仍走 v1 视图）：

- `readIndexDocument(): Promise<ProjectIndexV2>`：磁盘是 v2 时用 `normalizeProjectIndexV2` + `projectIndexV2Problems` 校验后返回；磁盘是 v1 时用 `migrateV1ToV2` 在内存投影成 v2 返回——不写盘、不备份、不归档、不改 mtime。理由：M8 的纯规则必须在 v2 字段上工作；把迁移投影留在内存，仍保持「只有第一次写才落 v2 并执行备份/归档」。
- `mutateIndexDocument(mutator: (document: ProjectIndexV2) => ProjectIndexV2 | null): Promise<ProjectIndexV2>`：在项目锁内用现有的 `readIndexForWrite()` 拿到（必要时已迁移的）v2 文档 → 调用 mutator → 返回 `null` 表示放弃本次写入 → 否则 `projectIndexV2Problems` 校验后原子写 v2 并返回。mutator 拿到的是锁内重读的文档，这就是「评估前锁内重读、期间有新活动就放弃标记」的实现点，不需要额外的 API 或后台状态。

预算：`src/store.ts` 现 47,351 B，审查线 49,152 B。新增代码必须守住 49,152 B；接近时先停下向队长报告（把纯投影/校验包装移到 `store-schema.ts`/`store-migration.ts`，或按文档 I/O 拆新模块），不压行、不删测试、不越过 51,200 B。

**2) 模块边界（按 [PLAN-V0.2 §4.2](../../../../docs/PLAN-V0.2.md)）。**

- `src/topic.ts`：纯函数，无 I/O、不读时钟（`nowMs` 由调用方注入）。输入一个 v2 topic 与上下文（`nowMs`、`idleAfterMs`、`resolveAfterMs`、`activeWorkItems`），输出需要的变更：进入 `idle`、回到 `active`、自动 `resolved`（写 `resolvedAt` 与 `resolvedBy='master'`）、重开（清 `resolvedAt`/`resolvedBy`、回 `active`）。五条件、2 小时/3 天阈值与「无撤销」由 [three-state-lifecycle](../feature/2026-11-07-three-state-lifecycle.md) 拥有，本模块只把规则翻译成可断言的纯函数。
- `src/topic-events.ts`：`session/event` 监听与写回，端口（事件订阅、store、clock、activity）注入以便单测不挂宿主。`turn/end` → 在 `mutateIndexDocument` 内更新该 topic 的 `lastActiveAt`，并把 `idle` 拉回 `active`；已解决 topic 收到 `user/message` → 重开（清 resolved 字段并写 `topic-reopened` 事件）。sessionId 与 topicId 相同（M7 迁移把 `threadId`→`topicId`，tools 用会话 id 作 topicId），监听器只在 `readIndexDocument().topics` 里存在的 id 上工作，不处理 reviewer 或外来会话。
- `src/activity.ts`：业务事件构造与记录（`topic-created`、`status-changed`、`topic-reopened`、`review-*`、`error` 等）。复用 M7 的 `appendActivity`/`readActivity` 与 500 条/524288 B 上限，不重写文件层；事件类型集合的唯一定义仍在 `src/store-schema.ts`。
- `src/inbox.ts`：待办合并与投递。输入若干待决定事件（`merge-needed`/`blocked`/`review-reject`/`cross-topic-conflict`），合并为一条摘要（≤5 条，每条 ≤200 字），经注入的 prompt 端口投递；成功把 `deliveredAt` 写回 `writeInbox`，失败保留并等重放；重放 API 在本模块，调用点（`cowork_project_status`）归 M9。50 条上限与原子重写已由 M7 store 提供。
- `src/index.ts`：只做装配接线（store 构造、activity/inbox/topic-events 实例、`ctx.effect` 注册与释放事件监听）。不改工具、api、presets、panel。

**3) 评估时机（范围决定，不是遗漏）。**

M8 只实现规则与 `turn/end` 钩子；`cowork_project_status`、`cowork_route`、面板 overview 的读取点评估显式留给 M9/M11。理由：M8 不得改 `tools.ts`/`api.ts`/panel；纯函数 + `mutateIndexDocument` 已把写入路径准备好，后续阶段只需加调用点。代价：M8 结束后，主题的 idle/resolved 只在事件发生时刷新，读取点尚未接入；交接的「未验证/范围」与 Risks 都写明这一点。

**4) 活动类型与 KI 处置。**

- `ACTIVITY_TYPES` 增加 `topic-reopened`：重开是用户动作、不是撤销，需要独立事件。不改 `ACTIVITY_MAX_EVENTS`/`ACTIVITY_MAX_BYTES`。
- **KI-20 在本阶段修复（选顺序方案）**：迁移事务改为「校验 → 备份 → 归档 → 写 v2 → 写迁移 activity」，activity 在 v2 已落盘之后写；activity 写失败不再让迁移失败，失败记入 `lastMigrationReport`（新增 `activityFailure: string | null`），v2 与备份保留。理由：原顺序在 activity 成功而 index 失败时会让下一次写重跑迁移、重复 `archiveSession` 与事件；先写 v2 使重试看到 v2、不再迁移。activity 是证据，不得反过来推翻已经提交的索引，也不得宣称归档失败已被记录（失败会写明）。
- **KI-19 保持现状**：`lastMigrationReport` 继续只在内存，重启后的证据是 activity 的 `error`/`status-changed` 事件与 `index.v1.backup.json`；M11 面板若需要归档失败明细再评估（见 Risks）。
- KI-18（兼容层）归 M9/M10/M12，KI-21/22 归 M12。M8 的新代码一律用 canonical v2 API，不新增 legacy 字段或第二套状态映射。

**5) 不在本阶段做。**

不接路由、不改 `tools.ts`/`api.ts`/`presets`/panel、不建 work item/review-request/session-visibility 模块、不跑真实 E2E 或真实数据迁移（M12）。

## Alternatives considered

**只读时惰性迁移、或直接用 v1 兼容视图，不加 canonical v2 API。** 否决：M8 的规则全部作用在 v2 字段上；v1 视图把 `resolvedAt`/`resolvedBy`/`legacyStatus` 折成 v1 状态，规则层若自己反推会复制一套状态映射，写回还要再造投影。canonical 读写把「锁内重读」「迁移投影只在内存」集中在 store 一处。

**用后台定时器在 2 小时/3 天整点主动评估。** 否决：定时器增加后台状态、跨重启与并发复杂度；PLAN §5.1 已定惰性评估，`turn/end` 与后续阶段的读取点覆盖常用时机。重审条件：用户要求离线也按时标记，或面板长期不打开。

**把活动/收件箱业务规则塞进 `store.ts`。** 否决：store 是文件 I/O 与锁的单一写者；M7 已把 activity/inbox 的规则显式推迟到 M8，塞回去会让 store 超出 49,152 B 审查线，也让业务规则无法脱离文件系统单测。

**在 M8 就接 `cowork_project_status`/`cowork_route`/面板的读取点评估。** 否决：这些调用点分别属于 M9 的工具与 M11 的面板，M8 不得改它们；提前改会让 M8 越过阶段边界，也把尚未稳定的工具/面板接口拖进生命周期实现。纯函数 + `mutateIndexDocument` 已为后续调用点准备好唯一写入口。

**保持 KI-20 的顺序、只把 activity 失败变成致命（或在失败后重试 activity）。** 否决：致命会把已经写好或待写好的索引拖回失败态；重试 activity 仍无法消除「activity 成功、index 失败」后的重复迁移与重复归档调用。顺序改成先写 v2 才是根因修复。

**评估时不重读 `lastActiveAt`，直接按调用方快照写 resolved。** 否决：用户新消息与自动标记会竞争，可能把刚活跃的主题标成已解决（无撤销）；锁内重读是唯一低成本的一致性点。

## Acceptance criteria

- [A1] store 增加 canonical v2 读写：`readIndexDocument` 对 v1 文档只在内存投影（磁盘字节/mtime 不变、无备份、无归档），`mutateIndexDocument` 首次写触发真实迁移并写 v2；mutator 返回 `null` 时不产生任何写盘 — `tests`：`tests/store-v2.test.mjs`（v2 读写/迁移投影）与派生到 `tests/store-document.test.mjs`
- [A2] 三态与两标记：`idle` 只在 `lastActiveAt` 超过 `idleAfterMs` 且无 `awaitingReview`/`blocked` 时生效；2 小时边界 -1ms/恰好/+1ms；新活动回 `active` — `tests`：`tests/topic.test.mjs`
- [A3] 已解决五条件逐条缺失都不标记；全部满足才写 `resolvedBy='master'`、`resolvedAt`；3 天边界 -1ms/恰好/+1ms（注入时钟）；不提供撤销入口 — `tests`：`tests/topic.test.mjs`
- [A4] 重开清空 `resolvedAt`/`resolvedBy`、回 `active` 并写 `topic-reopened`；`turn/end` 更新 `lastActiveAt` 并回 `active`；锁内重读到新 `lastActiveAt` 时放弃标记 — `tests`：`tests/topic.test.mjs`、`tests/topic-events.test.mjs`、`tests/activity.test.mjs`
- [A5] 活动业务事件含 `topic-reopened`；追加/读取复用 M7 的 500 条/524288 B 上限，损坏行仍跳过并计数 — `tests`：`tests/activity.test.mjs`
- [A6] 收件箱：≤5 条合并、每条 ≤200 字、投递成功写 `deliveredAt`、失败保留并可重放、50 条上限与原子重写 — `tests`：`tests/inbox.test.mjs`
- [A7] 迁移 activity 顺序修复：v2 落盘后 activity 失败不使迁移失败，`lastMigrationReport.activityFailure` 记录原因；重试不再重复归档或重复事件 — `tests`：`tests/store-v2.test.mjs`
- [A8] 模块边界与预算：新模块按 §4.2；`src/store.ts` < 49,152 B；`npm run typecheck`/`build` 通过；不改 `tools.ts`/`api.ts`/`presets`/panel — `source`

## Risks

- 事件监听依赖 `session/event`：M6 探针 2 只在宿主进程内验证过 `turn/end`，每会话 500 条缓冲上限未验证（[M6 探针结果](../../../../docs/M6_PROBE_RESULT.md) §2）。若宿主变更导致收不到，`lastActiveAt` 退回按工具调用与读取更新并在文档标注，不假装准确。重审条件：升级宿主后事件缺失，或缓冲上限丢事件被观测到。
- 读取点评估延后：M8 结束后只有 `turn/end` 与重开路径刷新状态，`project_status`/`route`/面板读取时要等 M9/M11。主题可能长期显示旧 `idle`，或已满足条件但未标记。重审条件：M9 未按计划接入读取点，或用户报告状态长期不更新。
- 已解决条件里的「无 active 工作项」在 M8 恒真：`workItems` 由 M7 固定为 `[]`，工作项到 M10 才存在。M10 必须把真实计数传入 `topic.ts` 的评估输入，否则自动标记可能在有进行中工作时误触发。重审条件：M10 落地，或出现带 `active` 工作项却被标记 resolved 的主题。
- KI-20 修复后，activity 写失败会被记录但不会重试；如果写 activity 的磁盘故障持续，面板与交接会缺少迁移事件（v2 索引与备份仍完整）。重审条件：真实环境出现 activity 持续写失败。
- KI-19 保持内存报告：重启后无法回放 `archiveFailures` 的形状。M11 若要做归档失败明细，需要在 M11 重新评估（本阶段不落盘）。
- 重开判定依赖 `user/message` 事件：探针 2 记录该事件字段在顶层、`userMessageSeen` helper 不可靠，实现必须以事件类型为准。重审条件：宿主改变 `user/message` 形状或不再发该事件。
- 预算：`src/store.ts` 只余约 1.8 KB 到审查线；同时新增 store 方法与 KI-20 顺序修改可能触线。触线时停下报告拆分方案，不在本模块内压行。

## Delivery stages

1. **M8.1**：`src/topic.ts` 纯函数 + `src/store.ts` canonical v2 读写 + `tests/topic.test.mjs`、`tests/store-v2.test.mjs` 扩展；`npm test`/`typecheck` 绿，`store.ts` 仍 < 49,152 B。
2. **M8.2**：`src/topic-events.ts` + `tests/topic-events.test.mjs`；`turn/end`、重开、锁内重读都有测试；不挂真实宿主。
3. **M8.3**：`src/activity.ts`（含 `topic-reopened` 与 `ACTIVITY_TYPES` 变更）+ `src/inbox.ts` + `tests/activity.test.mjs`、`tests/inbox.test.mjs` + KI-20 顺序修复及测试。
4. **M8.4**：`npm test`、`npm run typecheck`、`npm run build`、`npm run check` 全绿；阶段结束停下等确认，不进 M9。
