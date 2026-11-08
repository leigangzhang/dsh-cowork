# Decision: 主题三态与已解决规则

Status: implemented
Date: 2026-11-07
Class: feature

## Problem

当前索引里的 `ThreadStatus` 有六态：`new`、`active`、`awaiting_review`、`done`、`blocked`、`archived`。这六个值混了三种不同的东西：生命周期（进行中、结束）、门禁标记（待评审）、异常标记（阻塞）、以及存储层的归档。结果是一个主题可以同时「已完成」和「待评审」，路由又必须写特殊分支；`done` 被硬排除后，同主题续做只能新开会话，上下文全丢。

同时，M4 没有已解决自动标记：已完成的主题不会自动退出自动路由，也不会被整理。用户已经明确：状态只保留三种——进行中、空闲、已解决；待评审与阻塞是标记；空闲 3 天后可以由 master 自动标记为已解决；自动标记不提供撤销；用户可以手动打开已解决主题继续；已解决主题不自动接收 master 的消息。详细状态转移与字段见 [PLAN-V0.2 §2.3/§5.1](../../../../docs/PLAN-V0.2.md)。

## Decision

**状态与标记。** v2 topic 的 `status` 只有 `active`、`idle`、`resolved`（`src/store-schema.ts` 的 `TOPIC_STATUSES`），`awaitingReview` 与 `blocked` 是两个标记，不占生命周期。

**规则实现（`src/topic.ts`，纯函数、无 I/O、不读时钟）。** 模块只导出两个常量、三个函数和一个上下文类型：

- `DEFAULT_IDLE_AFTER_MS = 2 * 60 * 60 * 1000`（2 小时）与 `DEFAULT_RESOLVE_AFTER_MS = 3 * 24 * 60 * 60 * 1000`（3 天）。`TopicLifecycleContext` 注入 `nowMs`、`idleAfterMs`、`resolveAfterMs`、`activeWorkItems`。
- `evaluateTopicLifecycle(topic, context)` 逐条判定：已是 `resolved` → `{kind:'none'}`；五条件同时成立且 `nowMs - Date.parse(lastActiveAt) >= resolveAfterMs`（恰好满足）→ `resolved`，写 `status='resolved'`、`resolvedAt`/`updatedAt=ISO(nowMs)`、`resolvedBy='master'`，`lastActiveAt` 不变；resolved 判定优先于 idle；`idle` 且（`awaitingReview` 或 `blocked` 或静默 `<= idleAfterMs`）→ `active`（`updatedAt=ISO(nowMs)`）；`active` 且无标记且静默严格 `> idleAfterMs`（恰好不算）→ `idle`；其余 `none`。五个已解决条件是：`awaitingReview===false`、`blocked===false`、`activeWorkItems===0`、`lastDeliveryConfirmedAt!==null`、`digest.trim()!==''`。
- `noteTopicActivity(topic, nowMs)`：非 `resolved` → `status='active'` 且 `lastActiveAt`/`updatedAt=ISO(nowMs)`；`resolved` 原样返回（同一对象），调用方必须走重开。
- `reopenResolvedTopic(topic, nowMs)`：非 `resolved` → `null`；`resolved` → `status='active'`、`resolvedAt=null`、`resolvedBy=null`、`lastActiveAt`/`updatedAt=ISO(nowMs)`，其余字段（`digest`、`lastDeliveryConfirmedAt` 等）保留。
- 不提供撤销 API：模块没有 undo/unresolve/revert 导出。

**评估时机与写入。** M8 只在 `session/event` 的 `turn/end` 与 `user/message` 上惰性评估：`src/topic-events.ts` 先经端口解析项目根与 store，再在 `mutateIndexDocument` 的锁内重读、重查 topic，期间被其他写者改变就放弃（自动标记无撤销，必须锁内确认）。`cowork_project_status`、`cowork_route` 与面板 overview 的读取点评估留给 M9/M11，M8 不改 `src/tools.ts`/`src/api.ts`/panel。写入路径与端口见 [M8 执行记录](../architecture/2026-11-07-m8-lifecycle-activity-inbox-plan.md)。

**重开是用户动作。** `user/message` 命中 `resolved` topic 时重开并追加一条 `topic-reopened` 活动事件；已解决主题不再被 `turn/end` 刷新。面板的手动「标记已解决」（`resolvedBy='user'`）与重开入口归 M11，M8 只实现规则与事件路径。

**本阶段不做的部分。** `workItems` 在 M8 恒为 `[]`，第三个条件暂时恒真，真实计数由 M10 传入；已解决主题退出自动路由与 `resolvedMatch` 归 M9；真实宿主 E2E 与真实数据迁移归 M12。事件监听依赖 `session.header.cwd` 解析项目根，M6 探针只验证过事件类型与顶层字段，header 的稳定性未在真实宿主核实（M12 首验，见 [M8 执行记录](../architecture/2026-11-07-m8-lifecycle-activity-inbox-plan.md) 的 F2）。

## Alternatives considered

**保留六态，`awaiting_review` 和 `blocked` 继续作为状态。** 否决：状态机与门禁混在一起，路由、UI 和索引都要为组合写分支；三态加两个标记更清楚，且能直接表达「待评审但仍是进行中」。

**把 `archived` 也保留为生命周期状态。** 否决：已解决主题仍要可打开、可重开；归档是可见性操作，不是主题的结果。主题会话的隐藏由面板与会话可见性记录处理。

**让模型按会话内容判断是否已解决。** 否决：内容判断不稳定，也难解释；已解决采用可观察条件（评审状态、阻塞、工作项、交付确认、摘要、时间）。模型只能通过 `cowork_handoff` 或评审结果提供这些事实。

**允许撤销自动标记。** 否决：用户明确要求不提供撤销；误标的恢复路径是用户手动打开并输入，效果等同回到进行中，但不算撤销。实现后确认这条边界落在两个地方：`noteTopicActivity` 对 resolved 原样返回，`evaluateTopicLifecycle` 对 resolved 直接 `none`，只有显式 `reopenResolvedTopic` 能改变状态。

**已解决主题继续接收 master 的路由消息。** 否决：恢复一个很大的会话会把原对话重新发给模型，小任务也要付大成本；默认不接消息，用户手动打开或新建主题。

**把已解决主题拆成多段会话以控制上下文。** 否决：段与段之间仍要重复加载和传递上下文，成本会继续增长，且没有验证过；不做。

**用后台定时器精确在 3 天整点标记。** 否决：定时器增加后台状态与并发复杂度；惰性评估在同一套锁里完成，读取和事件已经覆盖常用时机。重审条件：用户要求离线也按时标记，或面板长期不打开。

## Consequences

- `active`/`idle` 的转移只由 `lastActiveAt` 与 `idleAfterMs` 决定，边界是严格大于；`idle` 只是展示状态，不阻止路由。M8 只有 `turn/end` 会刷新它，读取点（`project_status`/`route`/面板）尚未接入，主题可能显示旧 `idle` 或已满足条件但未标记，直到 M9/M11。
- 自动标记 resolved 依赖 `lastDeliveryConfirmedAt` 与 `digest`：主题完成时没有写 `handoff(done)` 就不会自动标记，会长期停在 `idle`。这是有意的保守：宁可漏标，不可误标。
- 没有撤销。用户误开自动标记只能手动重开；重开会清空 `resolvedAt`/`resolvedBy` 并写 `topic-reopened`，历史仍留在 activity。重审条件：用户要求撤销或需要审计两者差异。
- 时间全部走注入时钟（`nowMs`），生产由 `ProjectStore` 的 clock 与 `src/index.ts` 的 `clock: () => new Date()` 提供；跨时区不影响 ISO 比较。重审条件：宿主提供独立时钟服务。
- 事件路径的已知限制（均记入 [M8 交付记录](../../../../docs/M8_HANDOFF.md) 的偏差段，不阻塞 M8）：`turn/end`/`user/message` 只在 M6 探针的宿主进程内验证过，每会话 500 条缓冲上限未验证；`session.header.cwd` 的依赖未在真实宿主核实（M12 首验）。若宿主不再发事件，`lastActiveAt` 退回按工具调用与读取更新并在文档标注，不假装准确。
- `workItems` 恒为 `[]`，第三个已解决条件在 M8 恒真；M10 引入工作项时必须把真实 active 计数传入 `evaluateTopicLifecycle`，否则可能把仍有进行中工作的主题标成已解决。
- 迁移兼容性沿用 M7：v1 的 `done`/`archived` 迁移为 `resolved`（`resolvedBy='master'`，时间取 `updatedAt`），`awaiting_review` 在写路径取消在途评审。v1 的未知扩展字段在 v1 兼容视图里不再透出，但 canonical v2 文档与 legacy 写回仍保留，不丢数据；详见 [M8 执行记录](../architecture/2026-11-07-m8-lifecycle-activity-inbox-plan.md)。
- 本记录取代原 `proposed/feature/2026-11-07-three-state-lifecycle.md`；状态迁移、标记清理与兼容性同时写入 [M8 交付记录](../../../../docs/M8_HANDOFF.md)，遗留项见 [KNOWN_ISSUES](../../../../docs/KNOWN_ISSUES.md)。

## Testing

- [A1] `active ↔ idle` 只由 `lastActiveAt` 与 `idleAfterMs` 决定（-1ms/恰好/严格超过），两标记抑制 idle 且能把 idle 拉回 active — `tests`：`tests/topic.test.mjs`（`an active topic turns idle only after the two-hour window`、`awaitingReview and blocked suppress idle and pull an idle topic back to active`、`new activity moves an idle topic back to active`）
- [A2] 五个已解决条件逐条缺失都不标记，全部满足写 `resolvedBy='master'`/`resolvedAt`，且模块无撤销导出 — `tests`：`tests/topic.test.mjs`（`a topic is resolved only when all five conditions hold`、`the module exposes no undo path`）
- [A3] 3 天边界用注入时钟（-1ms/恰好/+1ms），锁内重读到新状态时放弃标记 — `tests`：`tests/topic.test.mjs`（`the three-day threshold is inclusive and wins over idle`）与 `tests/topic-events.test.mjs`（`a reopen abandoned under the lock writes nothing and records no event`）
- [A4] 重开清空 `resolvedAt`/`resolvedBy`、回 `active` 并写一条 `topic-reopened`；`resolved` 不再被评估或新活动改变 — `tests`：`tests/topic.test.mjs`（`reopening clears the resolution fields and returns to active`、`a resolved topic never changes through evaluation or new activity`）与 `tests/topic-events.test.mjs`（`user/message reopens a resolved topic and records one topic-reopened event`）
- [A5] 状态、标记与迁移兼容性写入交付记录 — `decisions`：本记录、[M8 执行记录](../architecture/2026-11-07-m8-lifecycle-activity-inbox-plan.md)、[M8 交付记录](../../../../docs/M8_HANDOFF.md)、[KNOWN_ISSUES](../../../../docs/KNOWN_ISSUES.md)
