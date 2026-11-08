# M9 交付结果

- 状态：**M9 已交付（2026-11-08）**。三层路由、模型兜底、工具拆分/别名、主题与预设改名在 `feat/m9-routing-tools-presets` 上落地并通过独立验证；本文件记录交付基线、清单、证据、偏差、探针结论、回滚与未验证项，供下一个阶段（M10）接手。M9 启动时的交接见 [M9_HANDOFF.md](M9_HANDOFF.md)（已改为交付后版本，启动顺序保留为历史）。执行层的决定见 [M9 执行记录](../.agents/notes/implemented/architecture/2026-11-08-m9-routing-tools-presets-plan.md)，路由需求规则见 [主会话到主题的三层路由](../.agents/notes/implemented/feature/2026-11-07-three-layer-routing.md)。
- 适用：接手 V0.2 M10（评审请求、reviewer 生命周期、工作项）的 agent 或人。范围：M9 的实际交付、验证证据、已知偏差与未验证项；不重新论证 M9 的决定。
- 事实源：[PLAN-V0.2](PLAN-V0.2.md) §2.2/§5.3/§5.7/§5.8/§5.10/§6 M9 拥有需求、工具角色表、配置默认值与验收；[M9 执行记录](../.agents/notes/implemented/architecture/2026-11-08-m9-routing-tools-presets-plan.md) 拥有模块边界与备选；[三层路由记录](../.agents/notes/implemented/feature/2026-11-07-three-layer-routing.md) 拥有路由规则；[KNOWN_ISSUES](KNOWN_ISSUES.md) 拥有遗留问题归属；本文件只拥有「交付了什么、拿什么证明、从哪继续」。

## 交付基线

- **分支**：`feat/m9-routing-tools-presets`，从 `origin/main` 的 M8 合并提交 `7b9a6a5` 切出。
- **代码 HEAD**：`6379712`（`63797128ef5eaf3540defcffa62d8595486bcbe6`）。记录迁移、本文件、交接更新与 `publish.json` 分类是其后的文档提交（只改 `.md`/`.json`；本文件无法写入自身 sha）。
- **提交序列（`7b9a6a5..6379712`，按提交顺序）**：
  - M9.2 + M9.4：`96db9dc`（`router-model.ts` 模型兜底；`cowork-topic` 预设、`cowork-thread` 别名、master 行收窄、memory 识别三预设）
  - `cd4ed33`（dev-gate 预设常量接受 `cowork-topic`）→ `b4dfedf`（集成 M9.2/M9.4）
  - M9.1：`030cd36`（`src/routing.ts` 纯路由、Config 默认值、索引 focus/route 字段）→ `5fe7731`（集成 M9.1；t1 的范围契约缺口由 repair t4 在同一提交上收口，无新提交）
  - M9.3a：`28c9fcf`（`tool-runtime`/`project-tools`/`memory-tools`/`checkout-tools` 拆分、有界 status、读取点、M8 F1/F3 处置）→ `543b0da`（集成 M9.3a）
  - M9.3b：`627f426`（`topic-tools`/`route-tools`、handoff v2、删除 `router.ts`、宿主 llm 端口）→ `f8241ca`（复核修复：llm GenerateOptions 形状、死代码、topic 文案）→ `fd21021`（集成 M9.3b + 修复）
  - A5 证据补强：`e2a887f`（`cowork_route` 读取点 idle/resolved 回归测试）→ `6379712`（集成 A5）
- **验证基线（代码 HEAD `6379712` 上实测）**：`npm test` **596 tests / 596 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo**，exit 0；`npm run typecheck` exit 0；`npm run build` exit 0（`lib/` + `lib/client.js` 69 KB）；`npm run check` exit 0（`check-invariants: ok`）。596 = M8 基线 485 + 111（M9 新增/改写）。定向 `node --test tests/dev-gate.test.mjs tests/source-budget.test.mjs` 11 pass / 0 fail，exit 0。记录迁移后的文档提交上复核 `npm run check` 与 `npm test` 结果一致。
- **代码形态**：`src/tools.ts` **2,489 B**（M8 交付时 43,854 B，审查线 49,152 B）；`src/store.ts` **48,590 B**（M8 48,524 B，M9.1 只 +66 B 写两个 `null` 根字段）；`src/**/*.ts` 最大仍是 `src/m2-e2e.ts` 49,923 B（未改，硬上限 51,200 B）；新增模块 `src/routing.ts` 15,855、`src/router-model.ts` 14,793、`src/llm-port.ts` 4,209、`src/tool-runtime.ts` 15,974、`src/project-tools.ts` 11,359、`src/topic-tools.ts` 19,678、`src/route-tools.ts` 16,817、`src/memory-tools.ts` 5,369、`src/checkout-tools.ts` 7,556 B。
- **范围证据**：`git diff --name-only 7b9a6a5..6379712` 恰为 **39 个文件（20 个 `src/`、19 个 `tests/`）**，无 `docs/**`、`presets/**`、`src/client/**`、`src/api*.ts`；新增 9 个模块，删除 `src/router.ts` 与 `tests/router.test.mjs`；工作树干净。M10–M12 模块（review-request、work-item、session-visibility、coverage）不存在。

## 交付清单

- **配置（`src/index.ts`）**：`Config` 增加 `idleAfterMs`（默认 7,200,000）、`resolveAfterMs`（默认 259,200,000）、`routing.{enabled=true, provider='', model='', effort='', timeoutMs=2,000, maxTokens=256}`；`normalizeConfig` 容忍手工构造的缺省对象（测试手动构造 Config 时 apply 不炸）。
- **索引字段（`src/store-schema.ts`、`src/store-migration.ts`）**：`ProjectIndexV2` 根级可选 `masterFocusTopicId`/`lastRouteTopicId`（缺省 `null`）；normalize 补 `null`，校验接受 `null`/缺省/合法字符串、拒绝非法非空目标；`initIndex` 与 `migrateV1ToV2`（含只读投影）写 `null`；**不做数据迁移**——旧 v2 文档缺字段按 `null` 读，第一次写入自然带上。
- **纯路由（`src/routing.ts`）**：`tokenize`（ASCII 词 + 中文 bigram）；`decideRoute` 第一层（focus → lastRoute，`active`/`idle` 且无「新开/新建/换个主题/换个模块」信号才复用）、第二层（路径/别名/标题/scope/digest 打分与 `reasons`，排除 `resolved`）、`ROUTE_THRESHOLD=4`、`ROUTE_MARGIN=1`、`ROUTE_MAX_CANDIDATES=3`；`decideExplicitRoute`（不存在→`null`、resolved→`resolved_match`、live→reuse）；`applyRouteCorrection`（去重、单次 ≤8、列表 ≤50、单条 ≤32 字符、只改 `aliases`）；`routeCreateTitle`（前 24 码点、折叠空白）；`withRouteTargets`（只写给定目标、拒绝空串）。
- **模型兜底（`src/router-model.ts`）**：唯一路由 LLM 调用点、host-free。`LlmRoutingPort.run(request, signal)`；`RoutingModelConfig`/`ModelCandidate`/`ModelOutcome`；`recommendWithModel` 在 `enabled=false`、provider/model 空白、port 缺失时**不调用**并返回带原因码（`disabled`/`unconfigured`/`unavailable`）的 `fallback`；请求带 `maxTokens`、`timeoutMs`、默认 `reasoningEffort='off'`（`effort` 非空时覆盖），`AbortSignal.timeout` + 具名 guard 计时器；`buildRoutingUserPrompt` 序列化 ≤2,000 字符（意图优先、逐候选截断 scope/digest）；回复只接受 `{topicId: string|null, confidence: 0..1}`（容忍 ```json 围栏），坏 JSON/类型错/未知 topic/越界/超时/端口异常全部回退最高结构化候选或新建，`modelError` 有界 ≤200 字符，绝不抛给调用方、绝不弹窗。
- **宿主 llm 端口（`src/llm-port.ts`）**：`createLlmRoutingPort(ctx.get('llm'))`——`buildRoutingStreamOptions` 产出顶层 `system` + `messages=[{role:'user',content:[{type:'text',text}]}]` + `signal`（DSH `GenerateOptions` 形状）；`prepareCall` 参数按 `RoutingModelRequest`，`text-delta` 拼接，`finish` 为 `error`/`aborted` 时抛有界错误；`src/index.ts` 只装配，不内联消息。
- **路由工具（`src/route-tools.ts`）**：`cowork_route` 读取前在锁内跑 `evaluateProjectLifecycle`（无变化不写盘）；显式 `topicId`、`resolved_match`（新建主题、不向已解决主题发消息）、`forceCreate`、`brief` ≤2,000 字；结果 `{action, topicId?, title?, resolvedMatch?, reason, candidates, modelUsed, modelError?}`；写 `lastRouteTopicId` 与 `route-reused`/`route-created`/`route-corrected` 活动（只存有界候选/分数/是否用模型/confidence，不写 intent）；`applyRouteCorrectionToStore` 供 M11 面板改投。
- **工具拆分（`src/tools.ts` + 五个新模块、`src/tool-runtime.ts`）**：`tools.ts` 只剩 2,489 B 注册编排，14 个工具由 `project-tools`（`cowork_project_init`/`cowork_project_status`）、`topic-tools`（`cowork_topic_create`/`cowork_topic_list`/`cowork_topic_resolve`/`cowork_handoff`）、`route-tools`（`cowork_route`）、`memory-tools`（两个 memory 工具）、`checkout-tools`（`cowork_checkout_merge` 原样迁移）与保留的 `review-tools`（两个评审工具）注册；`cowork_thread_create`/`cowork_thread_list` 为同 schema/同 payload 的弃用别名（payload 用 topic 键）。`tool-runtime.ts` 承载共享 helper：`callerOf`/`openProject`/`evaluateProjectLifecycle`/`index`+`mutateIndexDocument` 包装/错误映射/有界视图，`evaluateProjectLifecycle` 锁内评估、只写变化项并追加 `status-changed`。
- **有界状态与收件箱（`project-tools` + `inbox.ts`）**：`cowork_project_status` 返回按状态计数、≤50 个 topic（digest 截 200 字）、活动尾部 20 条、`truncated`；不再返回全部 handoff/review 全文；通过 `Inbox.replay()` 重放未投递项（失败保留）。M8 F1 统一为 `activity.ts` builder；F3 投递后写 `deliveredAt` 失败改为 3 次立即重试 + 具名 `InboxMarkError`。
- **handoff v2（`topic-tools`）**：`cowork_handoff` 只保留 `blocked`/`done`（`awaiting_review` 保留一个版本并标 deprecated，M10 移除）；`done` 写 `digest`（summary ≤200 字）与 `lastDeliveryConfirmedAt`、清 `blocked`，不再把主题标 resolved；`blocked` 置标记；投递失败保持可重放。
- **预设与记忆（`src/presets.ts`、`src/memory-prompt.ts`）**：`presetDefinitions()` 返回 4 个预设（master 第一）——`cowork-master` 行仅 persona/agent-instructions/time-context/ask-user/todo（移除 fs/fs-search/bash/jobs/present）；`cowork-topic` 为完整 10 行主题预设；`cowork-thread` 为逐行相同的弃用别名（name/description 标明 deprecated）；`cowork-reviewer` 行不变、persona 增加「只看请求范围，不合并、不解决冲突」。`COWORK_MEMORY_PRESETS=['cowork-master','cowork-topic','cowork-thread']`，reviewer 与未知 preset 不注入。
- **测试**：新增/改写 `tests/routing.test.mjs`、`tests/router-model.test.mjs`、`tests/llm-port.test.mjs`、`tests/project-tools.test.mjs`、`tests/topic-tools.test.mjs`、`tests/route-tools.test.mjs`，删除 `tests/router.test.mjs`；扩展 `presets`/`memory-prompt`/`store-schema`/`store-migration`/`dev-gate`/`source-budget`/`tools*`/`api` 等回归面。

## 完成定义与证据

- [A1] 第一层（焦点/上次路由）命中不调用模型；第二层结构化匹配先于模型；只有 1–3 个候选且分不出高低才进入第三层 — `tests/routing.test.mjs`（`layer 1 reuses the focus topic without scoring it`、`layer 1 reuses an idle focus topic`、`layer 1 reuses the last route target when there is no focus`、`a tie above the threshold asks the model with the tied candidates`、`the model layer receives at most three candidates`）、`tests/route-tools.test.mjs`（`layer 1 reuses the focus topic and never calls the model`、`layer 2 reuses a clear structured winner`、`needs_model sends at most three candidates and reuses the model choice`）。
- [A2] 请求带 `maxTokens`/2s 超时/默认关闭推理（`reasoningEffort='off'`）；未配置/失败/超时/坏 JSON/类型错/未知 topic/confidence 越界都回退到最高结构化候选或新建，不弹窗 — `tests/router-model.test.mjs`（`the request carries provider, model, maxTokens, timeoutMs, and reasoning off by default`、`a slow port is aborted at timeoutMs…`、`bad JSON falls back…`、`a topicId outside the candidate list falls back`、`a confidence outside 0..1 falls back`、`a disabled configuration never calls the port…`、`a blank provider or model never calls the port…`、`a missing port never throws and reports unavailable`）、`tests/llm-port.test.mjs`（`buildRoutingStreamOptions uses the host message shape…`、`the port prepares the call, forwards the signal, and joins text deltas`、`a finish with kind error throws…`）、`tests/route-tools.test.mjs`（`a failing model port falls back…`、`routing.enabled=false keeps the port untouched…`、`an unconfigured model falls back…`、`a blank provider/model is filled from the host default model route`）。
- [A3] 低置信不产生用户选择请求；`applyRouteCorrection` 写别名（去重、≤50、单条长度上限）并记录 `route-corrected`，不改其他字段 — `tests/routing.test.mjs`（`a correction appends intent tokens to aliases only`、`a correction skips aliases that are already known or too short`、`a correction bounds one alias by its maximum length`、`a correction adds at most eight aliases per call`、`a correction never grows the alias list past its maximum`）、`tests/route-tools.test.mjs`（`applyRouteCorrectionToStore writes aliases and one route-corrected activity`；`route activity details are bounded and never contain the intent`）。
- [A4] `resolved` 不进入自动候选；显式指定已解决主题返回 `resolved_match` 并新建，不向已解决主题发消息 — `tests/routing.test.mjs`（`a resolved focus topic is never continued`、`layer 2 never offers a resolved topic as a candidate`、`an explicit resolved topic is reported as resolved_match`）、`tests/route-tools.test.mjs`（`an explicit resolved topic returns resolved_match and never prompts the old topic`）。
- [A5] `cowork_project_status` 与 `cowork_route` 的读取点惰性评估三态（锁内、无变化不写）；status 有界（≤50 topic、digest ≤200、活动尾部 20、`truncated`）并重放未投递 inbox — `tests/project-tools.test.mjs`（`project_status lazily marks a three-hour silent topic idle and does not rewrite on no change`、`project_status resolves a three-day silent topic that meets every condition`、`project_status bounds 60 topics…`、`project_status replays undelivered inbox items once and stamps deliveredAt`）、`tests/route-tools.test.mjs`（`cowork_route settles a three-hour silent focus topic to idle before reuse (A5 read point)`、`cowork_route resolves a four-day settled topic before force-creating a new one (A5 read point)`；临时删去 `evaluateProjectLifecycle` 调用后这两条会红，见 §探针证据后的变异验证）、`tests/inbox.test.mjs`（`a failed delivery keeps every item and replay delivers it later`、`a transient deliveredAt write failure is retried without delivering twice`、`a persistent deliveredAt write failure throws InboxMarkError and keeps the items`）。
- [A6] 工具名/角色/别名按 §5.7：`cowork_topic_create`/`cowork_topic_list` 与弃用别名同 schema/同结果；`cowork_handoff(done)` 写 `digest`/`lastDeliveryConfirmedAt`，`blocked` 置标记；`tools.ts` 只做编排 — `tests/project-tools.test.mjs`（`the assembly registers the fourteen tools in the documented order`）、`tests/topic-tools.test.mjs`（`cowork_thread_create is the same execute and schema as cowork_topic_create`、`cowork_handoff(done) records the summary and delivery proof without resolving the topic`、`cowork_handoff(blocked) sets blocked and clears awaitingReview; awaiting_review is the reverse`、`cowork_handoff refuses the master and keeps a failed delivery replayable`）、`tests/source-budget.test.mjs`（`the tool split owns every tool name and keeps tools.ts orchestration-only`）、`tests/dev-gate.test.mjs`（两种 gate 模式下业务预设/工具集合）。
- [A7] `cowork-master` 去 fs/fs-search/bash/jobs/present；`cowork-topic` 与 `cowork-thread` 别名可用；memory 识别三种业务 preset 且不注入 reviewer — `tests/presets.test.mjs`（四个定义与顺序、master 行精确集合、topic 10 行、thread 与 topic 行相同且 deprecated、reviewer 行与 persona 边界）、`tests/memory-prompt.test.mjs`（`cowork-topic` 与 `cowork-thread` 注册、reviewer 与未知 preset 不注册）。
- [A8] 配置默认值按 §5.10，不硬编码；索引新增 focus/route 字段缺省 `null`，旧 v2 文档可读、无迁移 — `tests/routing.test.mjs`（`the Config schema defaults match PLAN-V0.2 §5.10`、`the Config schema keeps explicit values and fills nested defaults`、`normalizeConfig tolerates a hand-built partial config`）、`tests/store-schema.test.mjs`（`v2 normalization defaults the routing targets to null`、`v2 validation accepts null, absent, and present routing targets`、`v2 validation rejects a broken routing target`）、`tests/store-migration.test.mjs`（`a v1 migration writes both routing targets as null`、`the read-only v1 projection also carries both null routing targets`）。
- [A9] `src/tools.ts` ≤49,152 B、`src/**/*.ts` <51,200 B；不改 M9 范围外文件；`npm run typecheck`/`build`/`check` 通过 — `tests/source-budget.test.mjs`（`every src/**/*.ts and src/**/*.tsx file stays under the 50 KiB read limit`、`the review-tool split keeps src/tools.ts well below the limit`、`the legacy keyword router is gone and nothing imports it`、`the host LLM adapter lives in src/llm-port.ts`）；`npm test` 596 pass / 0 fail / 0 skip / 0 todo exit 0，`npm run typecheck`、`npm run build`、`npm run check` 均 exit 0；`src/tools.ts` 2,489 B、`src/store.ts` 48,590 B、`src` 最大 49,923 B；`git diff --name-only 7b9a6a5..6379712` 恰为 39 个 `src`/`tests` 文件。

## 真实宿主探针证据

注入临时探针插件 `dsh-cowork-m9-probe`（工具带写在 gitignored `.dsh-cowork/m9-probe/**`，证据随后已 `dev_uninject`，未改跟踪文件或 profile）：

- `run1`：`.dsh-cowork/m9-probe/runs/m9-probe-1794132880116-896e4ec3.json`
  - `ctx.get` 可取 `llm` / `agentDefaultModel` / `sessionController` / `workspaceRegistry`（全部 true）。
  - `prepareCall` 解析出 `reasoningEffort="off"`（最低档）；真实 stream：`text=M9_LLM_OK`、`durationMs=856`、`reasoningChars=0`、`outputTokens=6`、`finish=stop`。
  - `sessionController.create({agentPreset:'cowork-topic'})` 失败 `Unknown agent preset`；真实原因：用户 web profile 的 `cordis.patch.yml` 把 `dsh-cowork` 设为 `disabled: true`，该 profile 不装配 cowork 插件（不是 M9 代码缺陷）。
- `run2`：`.dsh-cowork/m9-probe/runs/m9-probe-1794133162379-cd319481.json`
  - stream：`text=M9_LLM_OK`、`durationMs=1469`、`reasoningChars=0`、`outputTokens=6`。
  - `cowork-topic` 仍为 Unknown；探针改用临时预设 `m9-probe-session` 创建测试会话 `session-e03e1cc2-ede3-44c7-86aa-a1f1c3ff4207`，`archiveSession(stopActivity:true)` 后 `archivedSessionIds` 校验 `archived=true`；cleanup 返回 `archived:[该 id]`、`remaining:0`，临时预设 dispose 无错。

**结论边界**：宿主 `llm` 可达、`reasoningEffort='off'` 与真实流式调用已在插件上下文验证；`cowork-topic` 的 live 创建与归档**未在真实宿主验证**（本机 web profile 禁用 cowork 插件），会话创建/自动归档只在一个临时预设上验证。路由工具的真实 E2E、模型的真实延迟/成本/路由质量仍归 M12（KI-22）。

**A5 变异验证**（补证据时执行）：临时删去 `src/route-tools.ts` 的 `evaluateProjectLifecycle` 调用，`node --test tests/route-tools.test.mjs` 里两条 A5 读取点用例变红（15 pass / 2 fail）；`git checkout -- src/route-tools.ts` 还原后 17 pass，产品文件无改动。

## 偏差与未验证

- **已知并接受的偏差**：
  - `src/router.ts` 的删除与 tools 调用点切换从计划的 M9.1 挪到 M9.3b 原子完成（否则中间态 typecheck 红）；`tests/router.test.mjs` 随同一提交删除。
  - `cowork_route` 移除旧 `subject`/`isolated` 参数；`cowork_thread_*` 别名返回与 `cowork_topic_*` 相同的 payload（topic 键，无 thread 键）。属 0.2.0 计划内破坏性改名，M12 README 统一记录。
  - `cowork_handoff` 的 `awaiting_review` 保留一个版本并标 deprecated；M10 的评审请求落地后替换（KI-25）。
  - M8 F1（`topic-events` 内联 `topic-reopened`）已统一走 `activity.ts` builder；F3（inbox 投递后 `deliveredAt` 写失败）改为 3 次立即重试 + 具名 `InboxMarkError`，残余「交付成功后进程崩溃」窗口是 at-least-once（KI-23，M12）。
  - A5 的 `cowork_route` 读取点最初只有实现没有回归测试，由 `e2a887f` 以两条用例补齐，并做上面的变异验证。
- **未验证**：
  - 真实宿主端到端（`cowork_route` 三层、`resolved_match`、`cowork_project_status` 读取点）——M12（KI-22）；本机 web profile 禁用 `dsh-cowork`，插件会在真实会话里如何装配未验证。
  - `cowork-topic` 预设的真实创建/归档（探针只验证了 llm 与临时预设）。
  - 模型第三层的真实延迟/成本/路由质量与调用率；`llm-port` 的 `prepareCall`/`stream` 形状按 DSH 声明与真实流验证，但真实路由调用未跑。
  - 真实旧 v1/v2 数据的迁移与回滚演练；M9 的索引字段只扩展可选根字段，测试用 `os.tmpdir()` 夹具（KI-22）。
  - `workItems` 恒空：读取点固定 `activeWorkItems: 0`，M10 必须传真实 active 计数（KI-24）。
  - 面板/API v2 与会话可见性（M11）；宿主 profile 全局工具对 master 仍可见（M6 探针 5）。

## 遗留问题指针

见 [KNOWN_ISSUES](KNOWN_ISSUES.md)：KI-18（兼容层，M9 已完成 tools/presets 改写，剩余 M10→M12）、KI-22（真实 E2E/迁移，M12，含本次探针已验证与未验证的边界）、KI-23（inbox at-least-once 崩溃窗口，M12）、KI-24（`activeWorkItems=0`，M10）、KI-25（`awaiting_review`/legacy review 兼容，M10）。KI-15/17/19/21 保持原状。

## 回滚

- **代码**：按提交序列逆序 `git revert`（`6379712`、`e2a887f`、`fd21021`、`f8241ca`、`627f426`、`543b0da`、`28c9fcf`、`5fe7731`、`030cd36`、`b4dfedf`、`cd4ed33`、`96db9dc`）。M9 只扩展索引可选根字段、不改已有 schema 语义，回滚代码不需要数据迁移；旧文档的 `masterFocusTopicId`/`lastRouteTopicId` 会被 M8 代码忽略。
- **数据**：M9 只写 `lastRouteTopicId`（`masterFocusTopicId` 留给 M11）、handoff 的 `digest`/`lastDeliveryConfirmedAt`/`blocked`/`awaitingReview`、activity 与 inbox（重放标记）；回滚后 v2 文档仍可被 M8 代码读取。
- **文档/记录**：`git revert` 对应的文档提交（只改 `.md`/`.json`）；两份记录回到 `proposed/`，`docs/publish.json` 与 `PLAN-V0.2` §8 的路径随提交回滚。不要 force-push。

## 指针

- M9 启动交接（历史 → 已交付版）：[M9_HANDOFF.md](M9_HANDOFF.md)。
- M9 执行记录与备选：[2026-11-08-m9-routing-tools-presets-plan.md](../.agents/notes/implemented/architecture/2026-11-08-m9-routing-tools-presets-plan.md)。
- 路由需求规则：[2026-11-07-three-layer-routing.md](../.agents/notes/implemented/feature/2026-11-07-three-layer-routing.md)。
- 角色模型（仍 proposed，M11 收口）：[2026-11-07-topic-session-model.md](../.agents/notes/proposed/architecture/2026-11-07-topic-session-model.md)。
- 索引 v2 与迁移（仍 proposed，M10 收口）：[2026-11-07-topic-store-v2.md](../.agents/notes/proposed/architecture/2026-11-07-topic-store-v2.md)。
- 宿主能力证据：[M6_PROBE_RESULT.md](M6_PROBE_RESULT.md) §1（`prepareCall`/关闭推理）、§5（preset 工具面）。
- M8 交付结果：[M8_RESULT.md](M8_RESULT.md)。
- 遗留问题与归属：[KNOWN_ISSUES](KNOWN_ISSUES.md)。
