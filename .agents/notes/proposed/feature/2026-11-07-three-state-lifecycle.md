# Proposal: 主题三态与已解决规则

Status: proposed
Date: 2026-11-07
Class: feature

## Problem

当前索引里的 `ThreadStatus` 有六态：`new`、`active`、`awaiting_review`、`done`、`blocked`、`archived`。这六个值混了三种不同的东西：生命周期（进行中、结束）、门禁标记（待评审）、异常标记（阻塞）、以及存储层的归档。结果是一个主题可以同时「已完成」和「待评审」，路由又必须写特殊分支；`done` 被硬排除后，同主题续做只能新开会话，上下文全丢。

同时，M4 没有已解决自动标记：已完成的主题不会自动退出自动路由，也不会被整理。用户已经明确：状态只保留三种——进行中、空闲、已解决；待评审与阻塞是标记；空闲 3 天后可以由 master 自动标记为已解决；自动标记不提供撤销；用户可以手动打开已解决主题继续；已解决主题不自动接收 master 的消息。详细状态转移与字段见 [PLAN-V0.2 §2.3/§5.1](../../../../docs/PLAN-V0.2.md)。

## Proposal

**状态与标记。**

- `active`：进行中。新建、复用、重开、有新活动都进入这里。
- `idle`：空闲。无活动超过 `idleAfterMs`（默认 2 小时）且没有待评审、没有阻塞时进入；有新活动回 `active`。`idle` 是展示状态，不阻止路由。
- `resolved`：已解决。用户手动随时可标记；master 只能在五个条件同时满足时自动标记。
- `awaitingReview`：评审请求被接受时置位，verdict 记录时清除；不单独占生命周期。
- `blocked`：`cowork_handoff(blocked)` 或评审 `reject` 置位；`cowork_handoff(done)` 或新的评审通过清除；不单独占生命周期。

**已解决的五个条件（必须同时满足）。**

1. `awaitingReview=false`，没有在途评审。
2. `blocked=false`，没有阻塞标记。
3. 没有 `active` 状态的工作项，也没有正在运行的执行单元。
4. `lastDeliveryConfirmedAt` 非空：最近一次交付已经确认（`handoff(done)` 或评审通过）。
5. `digest` 非空，且 `now - lastActiveAt >= resolveAfterMs`（默认 3 天）。

**自动评估的时机与写入。** 在 `cowork_project_status`、`cowork_route`、面板 overview 读取时，以及会话事件监听器收到 `turn/end` 后惰性评估；不新增后台定时器。写入前在项目锁内重读 `lastActiveAt`，若期间有新活动则放弃本次自动标记。自动标记写 `resolvedBy='master'` 与 `resolvedAt`，不写撤销入口。

**用户手动。** 面板「标记已解决」随时可调用，不检查五条件；写 `resolvedBy='user'`。用户手动标记与自动标记都不提供撤销。

**已解决之后。** 已解决主题不参与自动路由；master 遇到相关新任务时新建主题并在结果里返回 `resolvedMatch`，不向已解决主题发消息。用户可以在 CoWork 里打开已解决主题并输入；插件把状态置回 `active`，清空 `resolvedAt/resolvedBy`，写 `topic-reopened` 事件。这条路径是用户手动动作，不是系统撤销。

**不做多段会话。** 已解决主题不拆成多段会话，也不做段间上下文传递；同一主题只保留一个会话。续接的成本由用户打开旧会话时明确承担，或由 master 新建主题承担。

## Alternatives considered

**保留六态，`awaiting_review` 和 `blocked` 继续作为状态。** 否决：状态机与门禁混在一起，路由、UI 和索引都要为组合写分支；讨论已确认三态加两个标记更清楚，且能直接表达「待评审但仍是进行中」。

**把 `archived` 也保留为生命周期状态。** 否决：已解决主题仍要可打开、可重开；归档是可见性操作，不是主题的结果。主题会话的隐藏由面板与会话可见性记录处理。

**让模型按会话内容判断是否已解决。** 否决：内容判断不稳定，也难解释；已解决采用可观察条件（评审状态、阻塞、工作项、交付确认、摘要、时间）。模型只能通过 `cowork_handoff` 或评审结果提供这些事实。

**允许撤销自动标记。** 否决：用户明确要求不提供撤销；误标的恢复路径是用户手动打开并输入，效果等同回到进行中，但不算撤销。

**已解决主题继续接收 master 的路由消息。** 否决：恢复一个很大的会话会把原对话重新发给模型，小任务也要付大成本；默认不接消息，用户手动打开或新建主题。

**把已解决主题拆成多段会话以控制上下文。** 否决：段与段之间仍要重复加载和传递上下文，成本会继续增长，且没有验证过；讨论已明确不做。

**用后台定时器精确在 3 天整点标记。** 否决：定时器增加后台状态与并发复杂度；惰性评估在同一套锁里完成，读取和事件已经覆盖常用时机。重审条件：用户要求离线也按时标记，或面板长期不打开。

## Acceptance criteria

- [A1] `active ↔ idle` 只由 `lastActiveAt` 与 `idleAfterMs` 决定；`idle` 不阻止路由 — `tests`
- [A2] 五个已解决条件逐条缺失都不自动标记；全部满足时写 `resolvedBy='master'`、`resolvedAt`，不提供撤销 — `tests`
- [A3] 3 天边界用注入时钟测试；评估写入前在锁内重读 `lastActiveAt`，新活动会放弃标记 — `tests`
- [A4] 已解决主题不被自动路由；用户打开并输入后回到 `active`，清空 resolved 字段并写事件 — `tests`
- [A5] 状态迁移、标记清理与迁移兼容性写进 `docs/PLAN-V0.2.md` 与 M8 交接 — `decisions`

## Risks

- 自动标记误判：条件依赖 `lastDeliveryConfirmedAt` 与 `digest`，若主题没有写 `handoff(done)`，已解决不会被自动标记；这会让主题长期停在 idle。缓解：主题 persona 要求在完成时写 handoff；面板显示「未确认交付」。
- 没有撤销：用户误开自动标记只能手动重开；重开会清空 resolved 字段并写事件，历史仍保留在 activity。重审条件：用户要求撤销或审计差异。
- 会话事件总线已由 M6 探针 2 确认可用于 `turn/end`：standard 会话连续两轮都收到 `turn/start`、`turn/end(completed)` 与 assistant 文本，`seq` 单调（限制：仅宿主进程内、每会话 500 条缓冲上限未验证，见 [M6 探针结果](../../../../docs/M6_PROBE_RESULT.md) §2）。若宿主变更导致收不到，`lastActiveAt` 退回按工具调用与读取更新，并在文档标注，不假装准确。
- 时间与时钟：测试与生产都用注入时钟；跨时区不影响 ISO 比较。重审条件：宿主提供独立时钟服务。
- 迁移：v1 的 `done/archived` 直接转 `resolved`，`awaiting_review` 取消在途评审；迁移前必须备份。相关决定见 [索引 v2 与迁移](../architecture/2026-11-07-topic-store-v2.md)。

## Delivery stages

- M6：探针 2 已确认 `session/event` 可用于 `turn/end`，探针 3 已确认 archive 的「不可继续」语义；结论见 [M6 探针结果](../../../../docs/M6_PROBE_RESULT.md)。
- M8：实现三态、标记、五条件、3 天/2 小时、重开、事件监听与锁内重读；新增 `tests/topic.test.mjs`。
- M9：路由排除 resolved、返回 `resolvedMatch`；主题状态影响路由候选。
- M11：面板显示状态、来源、已解决/重开操作。
- M12：真实 E2E 用短阈值（`idleAfterMs=500`、`resolveAfterMs=1000`）验证自动标记与重开。
