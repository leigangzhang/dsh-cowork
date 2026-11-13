# Decision: M9 用九个模块拆分路由、工具与预设

Status: implemented
Date: 2026-11-08
Class: architecture

## Problem

M8 已经把主题生命周期、活动与收件箱落到代码里（[M8 交付结果](../../../../docs/handoff/M8_RESULT.md)）：三态、`idle`/`resolved` 判定、`turn/end` 事件、锁内重读、活动上限与收件箱合并/重放都有测试；store 也提供了 canonical v2 的 `readIndexDocument`/`mutateIndexDocument`。但这些规则还没有接到用户面：

- 路由仍是 M4 的纯词法实现（`src/router.ts`，六态 v1 视图、subject×3 + handoff 摘要×2 + 时效加分，阈值 4、领先 1）；「继续」「再改一下」这类接力意图零命中，`resolved` 被硬排除，选错没有学习路径。
- `cowork_route` 仍返回 thread 形状，不能表达 `resolvedMatch`、可解释原因和候选；`cowork_project_status` 返回整个索引、全部 handoff 和最新评审，没有界；`cowork_topic_create`/`cowork_topic_list`/`cowork_topic_resolve` 不存在。
- M8 的 `evaluateTopicLifecycle` 没有读取点调用者：`project_status` 与 `cowork_route` 读取时不会惰性评估 `idle`/`resolved`，所以状态只靠 `turn/end` 与重开刷新（M8 交接已明确把读取点留给 M9/M11）。
- `src/tools.ts` 43,854 B、11 个工具与所有共享 helper 挤在一个文件；`cowork-master` 仍挂 fs/search/bash/jobs/present，`cowork-thread` 仍是唯一的主题 preset，memory 只识别 `cowork-master`/`cowork-thread`。
- `digest`、`lastDeliveryConfirmedAt`、`masterFocusTopicId` 仍没有写入者，M8 的五条件在实际数据上不会成立。

M9 的范围、工具角色表、预设与配置默认值由 [PLAN-V0.2](../../../../docs/PLAN-V0.2.md) §2.2/§5.3/§5.7/§5.8/§5.10/§6 M9 拥有；三层路由的需求规则由 [主会话到主题的三层路由](../feature/2026-11-07-three-layer-routing.md) 拥有；角色模型由 [用主题会话取代 thread](2026-11-07-topic-session-model.md) 拥有；v2 数据模型由 [索引 v2 与迁移](2026-11-07-topic-store-v2.md) 拥有。本记录固定执行层：模块边界、数据/配置扩展、读取点、工具拆分、预设与测试顺序；交付事实与证据见 [M9_RESULT](../../../../docs/handoff/M9_RESULT.md)。

## Decision

**1) 配置与索引字段（M9.1，保持向后兼容）。**

- `src/index.ts` 的 `Config` 增加 `idleAfterMs`（默认 7,200,000）、`resolveAfterMs`（默认 259,200,000）、`routing.{enabled=true, provider='', model='', effort='', timeoutMs=2,000, maxTokens=256}`；`normalizeConfig` 容忍手工构造的缺省对象。
- `src/store-schema.ts` 的 `ProjectIndexV2` 在文档根增加可选 `masterFocusTopicId: string | null` 与 `lastRouteTopicId: string | null`。缺省视为 `null`：`normalizeProjectIndexV2` 补默认，`projectIndexV2Problems` 接受 `null`/缺省、非法非空字符串报错；`initIndex` 与 `migrateV1ToV2`（含只读投影）写 `null`；`applyLegacyView` 保留文档信封。**不做数据迁移**：旧 v2 文档缺字段时按 `null` 读，第一次写入自然带上（`src/store.ts` 只增加两个 `null` 根字段，基线 48,524 → 48,590 B）。
- 写入者：M9 的 `cowork_route` 写 `lastRouteTopicId`；M11 的「打开主题」写 `masterFocusTopicId`。纯函数 `withRouteTargets(document, {focusTopicId?, lastRouteTopicId?})` 供两条路径共用，只写给定目标、拒绝空串。

**2) 路由纯层（`src/routing.ts`，替换并删除 `src/router.ts`）。**

- 纯函数、无 I/O、不读时钟：`tokenize`、`decideRoute`、`decideExplicitRoute`、`applyRouteCorrection`、`routeCreateTitle`、`withRouteTargets`；常量 `ROUTE_THRESHOLD=4`、`ROUTE_MARGIN=1`、`ROUTE_MAX_CANDIDATES=3`、`TOPIC_TITLE_MAX_CHARS=24`、`ALIAS_MAX_ITEMS=50`、`ALIAS_MAX_LENGTH=32`。
- 第一层：显式 `topicId` 由工具层先处理；否则 `focusTopicId`、再 `lastRouteTopicId`，`active`/`idle` 且不含新主题信号时直接复用。第二层：路径/别名/标题/`scope`/`digest` 打分与 `reasons`，排除 `resolved`，0 个过线→`create`，明确领先→`reuse`，并列/紧邻→`needs_model` 且只带前 3 个候选。第三层只接收这 1–3 个候选。
- 修正学习：`applyRouteCorrection` 只改 `aliases`（去重、单次 ≤8、列表 ≤50、单条 ≤32 字符）；自动标题取前 24 码点并折叠空白。
- 实现时把 `src/router.ts` 的删除与 tools 调用点切换挪到 M9.3b 原子完成（原计划在 M9.1），否则中间态 typecheck 红、`simplify` 的旧调用者仍在；`tests/router.test.mjs` 随同一提交删除。

**3) 模型兜底与宿主端口（`src/router-model.ts`、`src/llm-port.ts`）。**

- `src/router-model.ts` 是唯一新增的路由 LLM 调用点且 host-free：`LlmRoutingPort.run(request, signal)`、`RoutingModelConfig`、`ModelCandidate`、`ModelOutcome`、`recommendWithModel`、`buildRoutingUserPrompt`。请求带 `maxTokens`/`timeoutMs`/默认 `reasoningEffort='off'`（`effort` 非空覆盖）；`AbortSignal.timeout` + 具名 guard 计时器；prompt ≤2,000 字符（意图优先、逐候选截断）；输出只接受 `{topicId: string|null, confidence: 0..1}`。`enabled=false`、provider/model 空白、端口缺失时不调用端口并返回 `disabled`/`unconfigured`/`unavailable` fallback；坏 JSON/类型错/未知 topic/越界/超时/端口异常回退最高结构化候选或新建，`modelError` ≤200 字符，不抛错、不弹窗。
- `src/llm-port.ts` 用 `ctx.get('llm')` 装配真实端口：`buildRoutingStreamOptions` 产出顶层 `system` + `messages=[{role:'user',content:[{type:'text',text}]}]` + `signal`（DSH `GenerateOptions` 形状），`prepareCall` 参数按 request，`text-delta` 拼接，`finish` 为 `error`/`aborted` 抛有界错误；`src/index.ts` 只做装配，不内联消息（M9.3b 复核把内联实现收进本模块）。

**4) 工具面与模块拆分（PLAN §5.7/§6 M9）。**

- `src/tools.ts` 只剩 **2,489 B** 注册编排；共享 helper 移到 `src/tool-runtime.ts`（`callerOf`、`openProject`、`evaluateProjectLifecycle`、index/mutate 包装、错误映射、有界视图、`BRIEF_MAX_CHARS=2000`）。
- 新模块：`src/project-tools.ts`（`cowork_project_init`/`cowork_project_status`）、`src/topic-tools.ts`（`cowork_topic_create`/`cowork_topic_list`/`cowork_topic_resolve`/`cowork_handoff`）、`src/route-tools.ts`（`cowork_route`）、`src/memory-tools.ts`（两个 memory 工具）、`src/checkout-tools.ts`（`cowork_checkout_merge` 原样迁移；工作项在 M10）；`src/review-tools.ts` 原样保留，语义变更属 M10。共 14 个工具。
- 别名：`cowork_topic_create`/`cowork_topic_list` 是 canonical 名；`cowork_thread_create`/`cowork_thread_list` 是同 execute、同 schema、同 payload（topic 键）的弃用别名，description 标 deprecated。`cowork_route` 移除旧 `subject`/`isolated` 参数。
- `cowork_handoff` 只保留 `blocked`/`done`，`awaiting_review` 保留一个版本并标 deprecated（M10 替换）；`done` 写 `digest`（≤200 字）与 `lastDeliveryConfirmedAt`、清 `blocked`，不再把主题标 resolved；`blocked` 置标记；投递失败保持可重放。
- 角色守卫：`cowork_route`/`cowork_topic_*`/`cowork_handoff` 维持 master/topic 规则；reviewer 仍只能用 review verdict 与搜索/命令（M10 再收紧）；`cowork_project_status` 允许 master/topic，返回有界摘要。

**5) 读取点评估、收件箱与有界状态。**

- `cowork_project_status` 与 `cowork_route` 在读取前调用同一个 `evaluateProjectLifecycle`：项目锁内对每个 topic 跑 `evaluateTopicLifecycle`（`activeWorkItems: 0`，M10 传真实计数），有变化才写回并追加 `status-changed`；无变化返回 `null`，不产生写盘。A5 的 route 读取点起初只有实现没有回归测试，M9 收口前由 `tests/route-tools.test.mjs` 末尾两条用例补齐（3h 静默→idle 后 reuse；4d 完成态→resolved 后 forceCreate），并临时删调用验证过会红。
- `cowork_project_status` 返回 `project` 信息、按状态计数、≤50 个 topic（每个 `digest` 截 200 字）、待决定 inbox 摘要、最近活动尾部 20 条、`truncated`；不再返回全部 handoff/review 全文。
- `cowork_project_status` 通过 `Inbox.replay()` 重放未投递项；M8 F1 的统一（`topic-reopened` 改走 `activity.ts` builder）与 F3 的处置（`deliveredAt` 写失败 3 次立即重试 + 具名 `InboxMarkError`）在 M9.3a 落地。
- `cowork_route` 返回 `{action, topicId?, title?, resolvedMatch?, reason, candidates, modelUsed, modelError?}`；`resolved_match` 时新建主题并在结果里带旧主题 id/标题，不向已解决主题发消息。每次路由写 `route-reused`/`route-created`/`route-corrected`，details 只放有界候选/分数/是否调用模型/`confidence`/是否被纠正，不写完整 intent。

**6) 预设与记忆（`src/presets.ts`、`src/memory-prompt.ts`）。**

- `cowork-master` 行改为 persona、agent-instructions、time-context、tool-ask-user、tool-todo；移除 tool-fs/tool-fs-search/tool-bash/tool-jobs/present（M6 探针 5 已证明去 fs/bash 仍可工作）。
- 新增 `cowork-topic`（行与旧 thread 相同：persona、agent-instructions、time-context、bash、fs、fs-search、jobs、ask-user、todo、present；persona 改为「一个主题一个会话、可含多个执行单元、自己提交评审请求、写摘要与证据、结束/阻塞必须 cowork_handoff」）；`cowork-thread` 保留为逐行相同的弃用别名一个版本。
- `cowork-reviewer` 行不变，persona 增加「只看请求范围，不合并、不解决冲突」。
- `COWORK_MEMORY_PRESETS` 识别 `cowork-master`/`cowork-topic`/`cowork-thread`；reviewer 与未知 preset 不注入。记忆语义与预算不在 M9 改动。

**7) 不做与阶段边界。** 不实现评审请求/reviewer 生命周期/工作项/隔离合并（M10）；不接面板、HTTP API v2、会话可见性（M11）；不做真实宿主 E2E、真实数据迁移、0.2.0 打包（M12）；不引入后台定时器；不改 M8 的 topic/事件/活动/收件箱语义。

## Alternatives considered

**继续在 `src/router.ts` 上加关键词和阈值。** 否决：接力意图没有共同词，调阈值只能改变误命中方向；PLAN §5.3 已定「先结构化、后模型」，先做分数与原因才能解释与纠正。实现后补强：`src/router.ts` 最终在 M9.3b 与调用点切换一起删除，静态回归由 `tests/source-budget.test.mjs` 的 `the legacy keyword router is gone and nothing imports it` 钉住。

**每个意图都调用模型。** 否决：成本与延迟随每次输入增长，且难解释；第一/二层已能覆盖大多数场景，模型只做 1–3 个候选的兜底。

**低置信时弹窗让用户选。** 否决：用户明确要求不弹选择；选错由 M11 的「移动到其他主题」写别名纠正，M9 先把纯函数与事件准备好。

**`masterFocusTopicId`/`lastRouteTopicId` 放内存或独立 focus 文件。** 否决：内存跨重启丢失；独立文件会制造第二个事实源，还要与索引并发写协调。放索引根字段最符合 PLAN §5.3「索引记录」，缺省 `null` 向后兼容，不需要迁移。

**把 `lastRouteTopicId` 从 activity 尾部推导、不加字段。** 否决：activity 只是证据流、会被 500 条上限裁剪，且每次路由都解析历史；路由目标需要稳定、可原子写，索引字段更直接。

**先保持 `tools.ts` 单文件，M10 再拆。** 否决：M9 要新增 topic/route/project 工具并接读取点，继续堆会越过 50 KiB 读取线与 P2 预算；M9 正是拆分的自然时点，`tools.ts` 只留编排才能给 M10/M11 腾空间。实现结果：43,854 → 2,489 B，14 个工具分布在五个业务模块。

**现在就移除 `cowork_handoff` 的 `awaiting_review`。** 否决：M9 不实现评审请求，移除会让 M4 时代的旧评审链在 M10 落地前断裂；保留一个版本并在 description 标 deprecated，M10 一并替换（KI-25）。

**读取点用后台定时器评估 `idle`/`resolved`。** 否决：M8 已定惰性评估；定时器增加后台状态、跨重启与锁竞争。读取点与 `turn/end` 覆盖常用时机。

**在 legacy v1 视图上写路由/生命周期字段。** 否决：M8 明确新代码一律用 canonical v2 API；`applyLegacyView` 会以 v1 语义覆盖状态，容易丢 v2 标记。

**把 prompt/stream 形状内联在 `src/index.ts`。** 否决（实现中收回的初版）：宿主 `GenerateOptions` 的消息形状与 `prepareCall` 参数需要独立回归面；M9.3b 复核把内联实现收进 `src/llm-port.ts`，由 `tests/llm-port.test.mjs` 钉住，`index.ts` 只装配。

## Consequences

- M9 之后 14 个工具由 `src/tools.ts` 编排、五个业务模块 + 保留的 `review-tools` 注册；`cowork-topic` 成为 canonical 主题预设，`cowork-thread` 只服务存量会话一个版本；master 的 preset 行不再挂 fs/fs-search/bash/jobs/present。
- `cowork_route` 从 thread 形状换到 topic 三层形状：`subject`/`isolated` 参数移除、`resolved_match` 与 `candidates`/`modelUsed`/`modelError` 出现；`cowork_thread_*` 别名返回与 `cowork_topic_*` 相同的 topic payload。这是 0.2.0 计划内破坏性改名，M12 README 统一记录（KI-18 的收口路径不变）。
- 读取点接上后，`idle`/`resolved` 会在 `project_status`/`cowork_route` 读取时惰性落地；`workItems` 恒空使第三个已解决条件恒真，M10 必须传真实 active 计数，否则可能误自动 resolved（KI-24）。
- 模型路径：M9 用 fake port 测试覆盖守卫/超时/回退/坏输出；真实宿主探针验证了 `ctx.get('llm')` 可达、最低档 `off`、真实流 `M9_LLM_OK`（[M9_RESULT](../../../../docs/handoff/M9_RESULT.md)），但 `cowork-topic` 因本机 web profile 禁用 `dsh-cowork` 插件未能 live 创建，三层路由的真实 E2E 与模型的真实延迟/成本仍归 M12（KI-22）。若真实路由此后失败，关闭第三层仍保留确定性路径。
- 索引兼容：`masterFocusTopicId`/`lastRouteTopicId` 缺省 `null`、无迁移；真实旧 v2 文档的读取/首次写回演练归 M12。
- 预算与范围：`src/tools.ts` 2,489 B、`src/store.ts` 48,590 B（余量约 562 B）、`src/**/*.ts` 最大 49,923 B；`git diff --name-only 7b9a6a5..6379712` 恰为 39 个 `src`/`tests` 文件，不含 `docs/**`、`presets/**`、`src/client/**`、`src/api*.ts`；M10–M12 模块不存在。
- 残余遗留：`awaiting_review` 与 legacy review 兼容保留一版（KI-25，M10）；inbox 的 at-least-once 崩溃窗口（KI-23，M12）；兼容视图与 legacy 字段仍在（KI-18，M10→M12）；真实宿主 E2E/迁移（KI-22，M12）。

## Testing

- [A1] 第一层（焦点/上次路由）命中不调用模型；第二层结构化匹配先于模型；只有 1–3 个候选且分不出高低才进入第三层 — `tests`：`tests/routing.test.mjs`（`layer 1 reuses the focus topic without scoring it`、`a tie above the threshold asks the model with the tied candidates`、`the model layer receives at most three candidates`）与 `tests/route-tools.test.mjs`（`layer 1 reuses the focus topic and never calls the model`、`needs_model sends at most three candidates and reuses the model choice`）。
- [A2] 模型调用限制 `maxTokens`、2s 超时、关闭推理；未配置/失败/超时/坏输出回退到结构化候选或新建，不弹窗 — `tests`：`tests/router-model.test.mjs`（请求参数、超时、坏 JSON、未知 topic、confidence 越界、禁用/未配置/端口缺失）、`tests/llm-port.test.mjs`（宿主消息形状、signal 转发、error/aborted finish）、`tests/route-tools.test.mjs`（`a failing model port falls back to the highest structured candidate`、`routing.enabled=false keeps the port untouched and uses the fallback`、`an unconfigured model falls back without touching the port`）。
- [A3] 低置信不产生用户选择请求；`applyRouteCorrection` 写别名（去重、≤50、长度上限）并记录 `route-corrected`，不修改其他主题字段 — `tests`：`tests/routing.test.mjs` 的五条 correction 用例与 `tests/route-tools.test.mjs`（`applyRouteCorrectionToStore writes aliases and one route-corrected activity`）。
- [A4] `resolved` 不进入自动候选；显式指定已解决主题返回 `resolved_match` 并新建，不向已解决主题发消息 — `tests`：`tests/routing.test.mjs`（`a resolved focus topic is never continued`、`layer 2 never offers a resolved topic as a candidate`、`an explicit resolved topic is reported as resolved_match`）与 `tests/route-tools.test.mjs`（`an explicit resolved topic returns resolved_match and never prompts the old topic`）。
- [A5] `cowork_project_status` 与 `cowork_route` 的读取点会惰性评估三态（锁内、无变化不写）；status 有界（≤50 topic、digest≤200、活动尾部、`truncated`）并重放未投递 inbox — `tests`：`tests/project-tools.test.mjs`（`project_status lazily marks a three-hour silent topic idle and does not rewrite on no change`、`project_status resolves a three-day silent topic that meets every condition`、`project_status bounds 60 topics, counts flags, and truncates a long digest`、`project_status replays undelivered inbox items once and stamps deliveredAt`）、`tests/route-tools.test.mjs`（`cowork_route settles a three-hour silent focus topic to idle before reuse (A5 read point)`、`cowork_route resolves a four-day settled topic before force-creating a new one (A5 read point)`）。
- [A6] 工具名/角色/别名按 §5.7：`cowork_topic_create`/`cowork_topic_list` 与弃用别名同结果；`cowork_handoff(done)` 写 `digest`/`lastDeliveryConfirmedAt`，`blocked` 置标记；`tools.ts` 只做编排 — `tests`：`tests/project-tools.test.mjs`（`the assembly registers the fourteen tools in the documented order`）、`tests/topic-tools.test.mjs`（`cowork_thread_create is the same execute and schema as cowork_topic_create`、`cowork_handoff(done) records the summary and delivery proof without resolving the topic`、`cowork_handoff(blocked) sets blocked and clears awaitingReview; awaiting_review is the reverse`）、`tests/source-budget.test.mjs`（`the tool split owns every tool name and keeps tools.ts orchestration-only`）。
- [A7] `cowork-master` 去 fs/fs-search/bash/jobs/present；`cowork-topic` 与 `cowork-thread` 别名可用；memory 识别三种业务 preset 且不注入 reviewer — `tests`：`tests/presets.test.mjs` 与 `tests/memory-prompt.test.mjs`。
- [A8] 配置默认值按 §5.10（idle/resolve/routing.*），不硬编码；索引新增 focus/route 字段缺省为 null，旧 v2 文档可读、无迁移 — `tests`：`tests/routing.test.mjs`（`the Config schema defaults match PLAN-V0.2 §5.10`、`the Config schema keeps explicit values and fills nested defaults`、`normalizeConfig tolerates a hand-built partial config`）、`tests/store-schema.test.mjs`（`v2 normalization defaults the routing targets to null`、`v2 validation accepts null, absent, and present routing targets`、`v2 validation rejects a broken routing target`）、`tests/store-migration.test.mjs`（`a v1 migration writes both routing targets as null`、`the read-only v1 projection also carries both null routing targets`）。
- [A9] `src/tools.ts` ≤ 49,152 B、`src/**/*.ts` < 51,200 B；不改 M9 范围外文件；`npm run typecheck`/`build`/`check` 通过 — `source`：`tests/source-budget.test.mjs`（`every src/**/*.ts and src/**/*.tsx file stays under the 50 KiB read limit`、`the review-tool split keeps src/tools.ts well below the limit`、`the legacy keyword router is gone and nothing imports it`、`the host LLM adapter lives in src/llm-port.ts`）；`npm test` 596 pass / 0 fail / 0 skip / 0 todo exit 0，`npm run typecheck`、`npm run build`、`npm run check` 均 exit 0；`src/tools.ts` 2,489 B、`src/store.ts` 48,590 B、`src` 最大 49,923 B；范围 diff 见 [M9_RESULT](../../../../docs/handoff/M9_RESULT.md)。
