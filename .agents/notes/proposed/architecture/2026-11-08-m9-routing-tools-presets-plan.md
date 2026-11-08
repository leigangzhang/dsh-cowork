# Proposal: M9 路由、工具与预设执行提案

Status: proposed
Date: 2026-11-08
Class: architecture

## Problem

M8 已经把主题生命周期、活动与收件箱落到代码里（[M8 交付结果](../../../../docs/M8_RESULT.md)）：三态、`idle`/`resolved` 判定、`turn/end` 事件、锁内重读、活动上限与收件箱合并/重放都有测试；store 也提供了 canonical v2 的 `readIndexDocument`/`mutateIndexDocument`。但这些规则还没有接到用户面：

- 路由仍是 M4 的纯词法实现（`src/router.ts`，六态 v1 视图、subject×3 + handoff 摘要×2 + 时效加分，阈值 4、领先 1）；「继续」「再改一下」这类接力意图零命中，`resolved` 被硬排除，选错没有学习路径。
- `cowork_route` 仍返回 thread 形状，不能表达 `resolvedMatch`、可解释原因和候选；`cowork_project_status` 返回整个索引、全部 handoff 和最新评审，没有界；`cowork_topic_create`/`cowork_topic_list`/`cowork_topic_resolve` 不存在。
- M8 的 `evaluateTopicLifecycle` 没有读取点调用者：`project_status` 与 `cowork_route` 读取时不会惰性评估 `idle`/`resolved`，所以状态只靠 `turn/end` 与重开刷新（M8 交接已明确把读取点留给 M9/M11）。
- `src/tools.ts` 43,854 B、11 个工具与所有共享 helper 挤在一个文件；`cowork-master` 仍挂 fs/search/bash/jobs/present，`cowork-thread` 仍是唯一的主题 preset，memory 只识别 `cowork-master`/`cowork-thread`。
- `digest`、`lastDeliveryConfirmedAt`、`masterFocusTopicId` 仍没有写入者，M8 的五条件在实际数据上不会成立。

M9 的范围、工具角色表、预设与配置默认值由 [PLAN-V0.2](../../../../docs/PLAN-V0.2.md) §2.2/§5.3/§5.7/§5.8/§5.10/§6 M9 拥有；三层路由的需求规则由 [主会话到主题的三层路由](../feature/2026-11-07-three-layer-routing.md) 拥有；角色模型由 [用主题会话取代 thread](../architecture/2026-11-07-topic-session-model.md) 拥有；v2 数据模型由 [索引 v2 与迁移](../architecture/2026-11-07-topic-store-v2.md) 拥有。本记录只固定执行层：模块边界、数据/配置扩展、读取点、工具拆分、预设与测试顺序，不重抄需求全文。

## Proposal

**1) 配置与索引字段（M9.1 一起落地，保持向后兼容）。**

- `Config` 增加：`idleAfterMs`（默认 7,200,000 = 2h）、`resolveAfterMs`（默认 259,200,000 = 3d）、`routing.enabled`（默认 `true`）、`routing.provider`/`routing.model`/`routing.effort`（默认未设）、`routing.timeoutMs`（默认 2,000）、`routing.maxTokens`（默认 256）。`reviewer.reclaim` 属 M10，不在 M9 加。
- `ProjectIndexV2` 在文档根增加可选字段 `masterFocusTopicId: string | null` 与 `lastRouteTopicId: string | null`（PLAN §5.3 第一层）。缺省视为 `null`：`normalizeProjectIndexV2` 补默认、`projectIndexV2Problems` 接受 `null`/缺省（非法非空字符串才报错）、`initIndex` 与 `migrateV1ToV2` 写 `null`、`applyLegacyView` 保留文档信封。**不做数据迁移**：旧 v2 文档缺字段时按 `null` 读，第一次写入自然会带上。
- 写入者：M9 的 `cowork_route` 写 `lastRouteTopicId`；M11 的「打开主题」写 `masterFocusTopicId`。M9 提供纯函数 `withRouteTargets(document, {focusTopicId?, lastRouteTopicId?})` 供两条路径共用，避免各写一套。

**2) 路由纯层（`src/routing.ts`，替换 `src/router.ts`）。**

- 纯函数、无 I/O、不读时钟；输入 `TopicRecordV2[]`、`intent`、`RouteContext { nowMs, focusTopicId, lastRouteTopicId }`；输出 `RouteDecision`（`reuse` / `create` / `needs_model` / `resolved_match`）与 `candidates`（每个带 `score`、`reasons: string[]`）。
- 第一层：显式 `topicId` 由工具层先处理（不存在 → 明确错误；是 `resolved` → `resolved_match`）；否则 `focusTopicId`、再 `lastRouteTopicId`，若仍是 `active`/`idle` 且 `intent` 不含「新开/新建/换个主题/换个模块」等新主题信号，直接复用，不调用模型。
- 第二层：从 intent 取路径、模块、符号、产品术语，与每个非 `resolved` topic 的 `scope`/`ownedPaths`/`aliases`/`title`/`digest` 对照打分；返回分数和可解释 `reasons`（如 `path:src/store.ts`、`alias:路由`、`title-overlap:…`）。排除 `resolved`。阈值与领先幅度是常量，测试钉死边界。
- 第三层只接收第二层给出的 1–3 个候选：`needs_model` 只在「最高分过底线但领先不足」或「2–3 个候选同分/紧邻」时出现；0 个过线直接 `create`，一个候选明确领先直接 `reuse`。
- 修正学习：`applyRouteCorrection(topic, intent, nowMs)` 从原 intent 抽取有限 token 追加到目标 topic 的 `aliases`（去重、最多 50 条、每条长度上限），返回新 topic；不修改其他字段。面板「移动到其他主题」在 M11 调用它；M9 只实现并测试纯函数与活动事件写入路径。
- 自动标题：`routeCreateTitle(intent)` 取前 24 字、折叠换行（PLAN §5.3）。

**3) 模型兜底（`src/router-model.ts`，唯一新增的 LLM 调用点）。**

- 端口化：`LlmRoutingPort` 只暴露「准备一次调用并拿到文本」的最小面（实现由 `src/index.ts` 用宿主 `llm` 服务装配）；输入为 intent 与候选的标题/范围/摘要（序列化后 ≤2k 字），输出用 schema 校验 `{ topicId: string | null, confidence: number }`。
- 参数：`maxTokens` 默认 256、超时默认 2,000 ms、关闭推理（`reasoningEffort="off"`；M6 探针 1 已确认等价于 adapter `thinking.type="disabled"` 且不发送 `output_config`，见 [M6 探针结果](../../../../docs/M6_PROBE_RESULT.md) §1）。`routing.enabled=false`、未配置可用 provider/model、调用失败或超时，一律回退：最高结构化候选过底线则复用，否则新建；不弹窗、不阻塞。
- 结果校验失败（非 JSON、topicId 不在候选、confidence 越界）按调用失败处理，并把原因写进路由活动详情的 `modelError`。

**4) 工具面与模块拆分（PLAN §5.7/§6 M9）。**

- `src/tools.ts` 只做注册编排；共享执行 helper（`callerOf`、`openProject`、`index`/`mutateIndexDocument` 包装、错误映射、有界视图）移到 `src/tool-runtime.ts`（实现层 helper，不改变 §4.2 的业务模块边界）。
- 新模块：`src/project-tools.ts`（`cowork_project_init`、`cowork_project_status`）、`src/topic-tools.ts`（`cowork_topic_create`、`cowork_topic_list`、`cowork_topic_resolve`、`cowork_handoff`）、`src/route-tools.ts`（`cowork_route`）、`src/memory-tools.ts`（两个 memory 工具）、`src/checkout-tools.ts`（`cowork_checkout_merge` 原样迁移；工作项在 M10）。`src/review-tools.ts` 原样保留，语义变更属 M10。
- 别名：新名 `cowork_topic_create`/`cowork_topic_list`；`cowork_thread_create`/`cowork_thread_list` 保留为同实现的弃用别名（返回同样结果，description 标 deprecated）。`cowork_handoff` 继续接受 `awaiting_review` 一个版本（M10 的评审请求落地后再移除），`done` 现在写 `digest`（summary，≤200 字）与 `lastDeliveryConfirmedAt`（now）、清 `blocked`，`blocked` 置 `blocked=true`；状态与 v2 标记通过 `mutateIndexDocument` 写。
- 角色守卫：`cowork_route`/`cowork_topic_create`/`cowork_topic_resolve`/`cowork_handoff` 维持 master/topic 规则；reviewer 仍只能用 review verdict 与搜索/命令（M10 再收紧）。`cowork_project_status` 允许 master/topic，返回有界摘要。

**5) 读取点评估、收件箱与有界状态。**

- `cowork_project_status` 与 `cowork_route` 在读取前调用同一个 helper（`evaluateProjectLifecycle`）：在项目锁内对每个 topic 跑 `evaluateTopicLifecycle`（`activeWorkItems: 0`，M10 传真实计数；`idleAfterMs`/`resolveAfterMs` 来自 Config），有变化才写回并写 `status-changed` 活动事件；无变化返回 `null`，**不产生写盘**（M8 的锁内重读语义）。
- `cowork_project_status` 返回：`project` 基本信息、按状态计数、最多 50 个 topic（每个 `digest` 截到 200 字）、待决定 inbox 摘要、最近活动尾部（默认 20 条）、`truncated` 标志；不再返回全部 handoff/review 全文。
- `cowork_project_status` 通过 `src/inbox.ts` 的 `Inbox.replay()` 重放未投递项（注入 prompt 端口）；失败保留，不丢事件。M10 产生 inbox 事件，M9 只接重放路径。
- `cowork_route` 返回 `{ action, topicId?, title?, resolvedMatch?, reason, candidates, modelUsed, modelError? }`；`resolved_match` 时新建主题并在结果里带旧主题 id/标题，不向已解决主题发消息。
- 每次路由写 activity：`route-reused`/`route-created`/`route-corrected`，details 只放有界候选 id、分数、是否调用模型、confidence、是否被纠正；不写完整 intent。

**6) 预设与记忆（`src/presets.ts`、`src/memory-prompt.ts`）。**

- `cowork-master`：行改为 persona、agent-instructions、time-context、ask-user、todo；移除 fs/fs-search/bash/jobs/present（M6 探针 5 已证明去 fs/bash 仍可工作）。
- 新增 `cowork-topic`（行与当前 thread 相同，persona 改为「一个主题一个会话，可含多个执行单元，自己提交评审请求、写摘要与证据」）；`cowork-thread` 保留为同行的弃用别名一个版本。
- `cowork-reviewer` 行不变，persona 增加「只看请求范围，不合并、不解决冲突」。
- `COWORK_MEMORY_PRESETS` 识别 `cowork-master`/`cowork-topic`/`cowork-thread`；reviewer 不注入。记忆语义与预算不在 M9 改动。
- 工具创建主题时用 `cowork-topic`（新会话），旧 `cowork-thread` 只服务存量会话。

**7) 不做。** 不实现评审请求/reviewer 生命周期/工作项/隔离合并（M10）；不接面板、HTTP API v2、会话可见性（M11）；不做真实宿主 E2E、真实数据迁移、0.2.0 打包（M12）；不引入后台定时器；不改 M8 的 topic/事件/活动/收件箱语义。

## Alternatives considered

**继续在 `src/router.ts` 上加关键词和阈值。** 否决：接力意图没有共同词，调阈值只能改变误命中方向；PLAN §5.3 已定「先结构化、后模型」，先做分数与原因才能解释与纠正。

**每个意图都调用模型。** 否决：成本与延迟随每次输入增长，且难解释；第一/二层已能覆盖大多数场景，模型只做 1–3 个候选的兜底。

**低置信时弹窗让用户选。** 否决：用户明确要求不弹选择；选错由 M11 的「移动到其他主题」写别名纠正，M9 先把纯函数与事件准备好。

**`masterFocusTopicId`/`lastRouteTopicId` 放内存或独立 focus 文件。** 否决：内存跨重启丢失；独立文件会制造第二个事实源，还要与索引并发写协调。放索引根字段最符合 PLAN §5.3「索引记录」，缺省 `null` 向后兼容，不需要迁移。

**把 `lastRouteTopicId` 从 activity 尾部推导、不加字段。** 否决：activity 只是证据流、会被 500 条上限裁剪，且每次路由都解析历史；路由目标需要稳定、可原子写，索引字段更直接。

**先保持 `tools.ts` 单文件，M10 再拆。** 否决：M9 要新增 topic/route/project 工具并接读取点，继续堆会越过 50 KiB 读取线与 P2 预算；M9 正是拆分的自然时点，`tools.ts` 只留编排才能给 M10/M11 腾空间。

**现在就移除 `cowork_handoff` 的 `awaiting_review`。** 否决：M9 不实现评审请求，移除会让 M4 时代的旧评审链在 M10 落地前断裂；保留一个版本并在 description 标 deprecated，M10 一并替换。

**读取点用后台定时器评估 `idle`/`resolved`。** 否决：M8 已定惰性评估；定时器增加后台状态、跨重启与锁竞争。读取点与 `turn/end` 覆盖常用时机。

**在 legacy v1 视图上写路由/生命周期字段。** 否决：M8 明确新代码一律用 canonical v2 API；`applyLegacyView` 会以 v1 语义覆盖状态，容易丢 v2 标记。

## Acceptance criteria

- [A1] 第一层（焦点/上次路由）命中不调用模型；第二层结构化匹配先于模型；只有 1–3 个候选且分不出高低才进入第三层 — `tests`
- [A2] 模型调用限制 `maxTokens`、2s 超时、关闭推理；未配置/失败/超时/坏输出回退到结构化候选或新建，不弹窗 — `tests`
- [A3] 低置信不产生用户选择请求；`applyRouteCorrection` 写别名（去重、≤50、长度上限）并记录 `route-corrected`，不修改其他主题字段 — `tests`
- [A4] `resolved` 不进入自动候选；显式指定已解决主题返回 `resolved_match` 并新建，不向已解决主题发消息 — `tests`
- [A5] `cowork_project_status` 与 `cowork_route` 的读取点会惰性评估三态（锁内、无变化不写）；status 有界（≤50 topic、digest≤200、活动尾部、`truncated`）并重放未投递 inbox — `tests`
- [A6] 工具名/角色/别名按 §5.7：`cowork_topic_create`/`cowork_topic_list` 与弃用别名同结果；`cowork_handoff(done)` 写 `digest`/`lastDeliveryConfirmedAt`，`blocked` 置标记；`tools.ts` 只做编排 — `tests`
- [A7] `cowork-master` 去 fs/fs-search/bash/jobs/present；`cowork-topic` 与 `cowork-thread` 别名可用；memory 识别三种业务 preset 且不注入 reviewer — `tests`
- [A8] 配置默认值按 §5.10（idle/resolve/routing.*），不硬编码；索引新增 focus/route 字段缺省为 null，旧 v2 文档可读、无迁移 — `tests`
- [A9] `src/tools.ts` ≤ 49,152 B、`src/**/*.ts` < 51,200 B；不改 tools 之外的 M9 范围外文件；`npm run typecheck`/`build`/`check` 通过 — `source`

## Risks

- **LLM 可达性未在插件上下文验证。** M6 探针 1 只在注入工具带里验证过 `prepareCall`/关闭推理；插件自己的 `llm` 服务入口要在 M9 启动时用最小探针确认。若不可达，`routing.enabled=false` 仍能跑确定性路径，第三层降级为结构化，不阻塞 M9。重审条件：真实宿主路由调用失败，或 M12 E2E 需要模型路径。
- **别名污染。** 修正写入的 token 可能过宽；用去重、数量/长度上限、只从原 intent 提取，面板可查看（M11）。重审条件：同一别名引发多次误路由。
- **索引字段扩展的兼容。** 旧 v2 文档缺 `masterFocusTopicId`/`lastRouteTopicId` 必须按 null 读；若校验过严会让现有项目 fail closed。测试要覆盖缺省/非法/写回三种情况。重审条件：真实旧文档读取失败。
- **工具拆分回归。** 11 个工具 + 2 个别名、角色守卫、错误码与 payload 形状都要保持；`tests/tools.test.mjs`/`tools-init.test.mjs`/`api.test.mjs` 是回归面。重审条件：拆分后出现 payload/角色差异。
- **读取点写放大与锁竞争。** 每次 status/route 都可能在锁内评估；无变化必须 `return null`。若真实项目 topic 很多，评估本身要 O(n) 且只写变化项。重审条件：status 延迟明显或出现锁等待。
- **master 工具面的宿主全局工具仍可见。** M6 探针 5 证明 preset 行只追加，profile 级全局工具始终存在；`restrict` 只能按名掩蔽继承工具，且不是声明式白名单。M9 只能保证 preset 行与工具入口校验，不能保证硬隔离。
- **评审链兼容。** M9 保留 `awaiting_review` 一个版本，M10 必须替换为评审请求；若 M10 拖延，旧语义会继续出现在 handoff 文件与 v1 视图里。
- **预算。** M9 会改 `store-schema.ts`（新字段校验）与 `presets.ts`/`memory-prompt.ts`/`index.ts`（配置与装配），但不应再往 `store.ts` 加业务代码；当前 `store.ts` 48,524 B，接近 49,152 审查线，任何 store 侧新增先报告拆分方案。

## Delivery stages

1. **M9.1**：配置与索引字段（`src/index.ts`、`src/store-schema.ts`、`src/store-migration.ts`、`src/tools.ts` 的 `initIndex` 调用点）+ 纯路由 `src/routing.ts`（含 tokenize/评分/第一二层/`applyRouteCorrection`/`routeCreateTitle`）+ 删除 `src/router.ts`；测试 `tests/routing.test.mjs`、`tests/store-schema.test.mjs` 扩展。`npm test`/`typecheck` 绿，`store.ts` 不变。
2. **M9.2**：`src/router-model.ts`（LLM 端口、schema 校验、超时/回退）+ 测试（fake llm）；`cowork_route` 接第三层。
3. **M9.3**：`src/tool-runtime.ts` 与 `src/project-tools.ts`/`topic-tools.ts`/`route-tools.ts`/`memory-tools.ts`/`checkout-tools.ts` 拆分；新工具名 + 别名；`cowork_handoff` 写 digest/交付确认；读取点评估 + `project_status` 有界 + inbox 重放；测试 `tests/tools.test.mjs`、`tests/project-tools.test.mjs`、`tests/topic-tools.test.mjs`、`tests/route-tools.test.mjs` 更新。
4. **M9.4**：`src/presets.ts`（master 行、topic/thread 预设、reviewer persona）与 `src/memory-prompt.ts`；测试 `tests/presets.test.mjs`、`tests/memory-prompt.test.mjs`。
5. **M9.5**：收口：`npm test`/`typecheck`/`build`/`check`；`three-layer-routing` 迁 implemented 并重写，`topic-session-model` 与 `topic-store-v2` 保持 proposed；写 `docs/M9_RESULT.md`（新文件，不覆盖 `docs/M9_HANDOFF.md`）并把 M9 交接更新为交付后的状态，停等确认，不进入 M10。
