# Decision: 主会话到主题的三层路由

Status: implemented
Date: 2026-11-07
Class: feature

## Problem

M4 的路由是纯词法：subject 命中 ×3、最新交接摘要命中 ×2、状态惩罚、时效加分，阈值 4、领先 1 分。它有三个具体缺陷：

1. **词面匹配不等于主题匹配。** 中文按两字一组切词，「资源」「页面」「详情」这类常用词容易让不相干的意图过线；准确度实际上依赖 master 起 subject 的质量，而 master 越轻越起不准。
2. **接力意图失配。** 「继续」「再改一下」「换成 B 方案」和标题没有共同词，分数为 0，直接新建主题；同主题的连续任务被拆散，上下文和缓存都丢失。
3. **没有纠正学习。** 路由错了没有记录，下一次同样的说法还会错；`done` 又被硬排除，导致已完成主题无法续接。

讨论中已经确定三层路由：先用成本最低的当前主题，再用结构化实体匹配，最后只在少数候选分不出高低时才调用模型；低置信不弹选择，选错在面板一键改投，并把这次输入写进目标主题的别名。详细阶段见 [PLAN-V0.2](../../../../docs/PLAN-V0.2.md) §2.2/§5.3。M9 已按本决定落地（执行层记录见 [M9 执行记录](../architecture/2026-11-08-m9-routing-tools-presets-plan.md)）。

## Decision

**第一层：会话局部性（`src/routing.ts`）。** `decideRoute` 先看 `RouteContext.focusTopicId`，再看 `lastRouteTopicId`；目标是 `active`/`idle` 且 `intent` 不含 `ROUTE_NEW_TOPIC_SIGNALS`（新开、新开一个、新建、换个主题、换个模块）时直接复用，不调用模型、不参与打分。`resolved` 目标被跳过，落到第二层。索引根字段 `masterFocusTopicId`/`lastRouteTopicId` 缺省 `null`；M9 只写 `lastRouteTopicId`，`masterFocusTopicId` 的写入者归 M11 面板。

**第二层：结构化匹配（`src/routing.ts`）。** `tokenize` 把 ASCII 词小写、标点切分，中文连续串切成 bigram 并保留单字。每个非 `resolved` topic 的 `scope`、`ownedPaths`、`aliases`、`title`、`digest` 与 intent token 对照打分，返回 `score` 与可解释 `reasons`（`path:`/`alias:`/`title-overlap:`/`scope:`/`digest:`/`recency:`）。常量是 `ROUTE_THRESHOLD = 4`、`ROUTE_MARGIN = 1`、`ROUTE_MAX_CANDIDATES = 3`。0 个过线→`create`；最高分过线且领先 `≥ ROUTE_MARGIN`→`reuse`；并列/紧邻→`needs_model` 并只带前 3 个候选。时效只做同分内的加分，单独不足以让候选过线；`resolved` 永不进入候选。

**第三层：模型兜底（`src/router-model.ts` + `src/llm-port.ts`）。** 只有 `needs_model` 才调用；`recommendWithModel` 是唯一的路由 LLM 调用点，host-free，端口 `LlmRoutingPort.run(request, signal)` 由 `src/llm-port.ts` 的 `createLlmRoutingPort` 用宿主 `llm` 服务装配，`src/index.ts` 只接线。请求带 `maxTokens`（默认 256）、`timeoutMs`（默认 2,000）、默认 `reasoningEffort='off'`（`routing.effort` 非空时覆盖）；`buildRoutingStreamOptions` 产出 DSH `GenerateOptions` 形状（顶层 `system` + `messages` + `signal`），`prepareCall` 参数按 request，`text-delta` 拼接，`finish` 为 `error`/`aborted` 抛有界错误。输入是 intent 与候选标题/scope/digest，`buildRoutingUserPrompt` 序列化 ≤2,000 字符（意图优先、逐候选截断）。输出只接受 `{topicId: string|null, confidence: 0..1}`，容忍 ```json 围栏；坏 JSON、类型错、topicId 不在候选、confidence 越界、超时、端口异常一律 `fallback` 到最高结构化候选或新建，`modelError` 有界 ≤200 字符，不抛给调用方、不弹窗。`routing.enabled=false`、provider/model 空白、端口缺失时不调用端口。

**低置信不弹选择。** 模型给出选择就执行；一次路由只回 `{action, topicId?, resolvedMatch?, reason, candidates, modelUsed, modelError?}`。选错由 M11 面板「移动到其他主题」调用 `applyRouteCorrectionToStore`→`applyRouteCorrection`：从原 intent 抽取 token 追加到目标 topic 的 `aliases`（去重、单次 ≤8、列表 ≤50、单条 ≤32 字符），只改 `aliases`，并写一条 `route-corrected` 活动。

**已解决与显式指定。** `cowork_route` 接受可选 `topicId`：不存在返回明确错误；`resolved` 返回 `resolved_match` 并在新主题上投递，不向已解决主题发消息。自动候选排除 `resolved`。

**新建与背景。** 没有命中的意图用 `routeCreateTitle` 起标题（前 24 码点、折叠空白）；`brief` 上限 2,000 字符。

**记录。** 每次路由写 `route-reused`/`route-created`/`route-corrected` 活动，details 只含有界候选 id/分数/是否调用模型/confidence/是否被纠正，不写完整 intent；活动流沿用 M8 的 500 条 / 524288 B 上限。

**读取点。** `cowork_route` 与 `cowork_project_status` 在读取前调用 `src/tool-runtime.ts` 的 `evaluateProjectLifecycle`：项目锁内对每个 topic 跑 `evaluateTopicLifecycle`，有变化才写回并追加 `status-changed`，无变化返回 `null`、不产生写盘。

## Alternatives considered

**继续纯词法路由。** 否决：中文常用词误命中、接力意图零命中、无法学习；调阈值只能改变误差方向，不能解决「按什么判断」的问题。

**每个意图都调用模型做主题分类。** 否决：成本与延迟随每次输入增长，且难解释；大多数意图在第一、二层已经能确定。模型只做少数候选的兜底。

**低置信时弹窗让用户选择。** 否决：用户明确要求不弹选择；频繁打断会抵消自动路由的价值。选错由一键改投纠正。

**现在引入向量/语义检索。** 否决：M5 才处理记忆与检索；当前主题范围是短文本，中文 bigram 已能提供部分信号；先做结构化和纠正学习，收益更直接，也避免新增向量依赖。

**让 master 模型自己做路由，不经过插件。** 否决：master 上下文会随候选列表增长；路由需要固定分数、排除规则和可解释记录，插件更适合。master 仍可以显式指定 `topicId`。

**用每个任务的提交或消息生成标题，再靠标题匹配。** 否决：标题是给人看的，不是路由索引；主题范围和负责文件才是可比较的信号。

**把已解决主题重新加入自动候选。** 否决：已解决默认不接消息，避免恢复大会话的成本；master 只能建议用户打开或新建主题。

## Consequences

- 主题路由不再依赖 subject 或 handoff 摘要：第一层覆盖连续对话，第二层给出可解释分数，第三层只在 1–3 个候选分不出高低时调用模型；`subject`/`isolated` 参数已从 `cowork_route` 移除（0.2.0 计划内破坏性改名，M12 README 收口）。
- `resolved` 不再被硬排除在「显式目标」之外：显式指定会得到 `resolved_match` 并新建，不向旧主题发消息；自动候选仍排除 `resolved`。
- 纠正学习只写 `aliases`，上限与去重防止别名污染；活动的 details 不落 intent，意图中的敏感内容不进本地证据文件。
- 模型调用增加延迟与成本：只在 `needs_model` 时调用，限制输入/输出与 2 秒超时；真实使用中需要观测调用率。重审条件：调用率持续偏高或每次路由明显变慢。
- 失败一律回退，不阻塞路由：关闭第三层（`routing.enabled=false`）、未配置 provider/model、端口不存在、坏输出或超时都退回结构化候选/新建。真实宿主探针已验证宿主 `llm` 可达、最低档 `off` 与真实流（[M9_RESULT](../../../../docs/handoff/M9_RESULT.md)）；但 `cowork-topic` 未能在本机 web profile live 创建，三层路由的真实 E2E 仍归 M12。
- 别名污染、焦点过期与意图敏感仍是接受的残余风险，分别由上界/显式覆盖/有界活动缓解；同一别名引发多次误路由、或焦点长期过期时重审。
- 预算：`src/routing.ts` 15,855 B、`src/router-model.ts` 14,793 B、`src/llm-port.ts` 4,209 B，均独立成文件；`src/store.ts` 只增加两个 `null` 根字段（48,590 B，余量约 562 B）。

## Testing

- [A1] 第一层命中不调用模型；第二层先于模型；只有 1–3 个候选且分不出高低才进入第三层 — `tests`：`tests/routing.test.mjs`（`layer 1 reuses the focus topic without scoring it`、`layer 1 reuses an idle focus topic`、`layer 1 reuses the last route target when there is no focus`、`a tie above the threshold asks the model with the tied candidates`、`the model layer receives at most three candidates`）与 `tests/route-tools.test.mjs`（`layer 1 reuses the focus topic and never calls the model`、`layer 2 reuses a clear structured winner`、`needs_model sends at most three candidates and reuses the model choice`）。
- [A2] 模型调用用 `reasoningEffort="off"` 关闭推理、限制 `maxTokens`、有 2 秒超时；失败/超时/未配置按最高结构化候选或新建回退，不弹窗 — `tests`：`tests/router-model.test.mjs`（`the request carries provider, model, maxTokens, timeoutMs, and reasoning off by default`、`a slow port is aborted at timeoutMs and falls back in well under a second`、`bad JSON falls back to the highest candidate without throwing`、`a topicId outside the candidate list falls back`、`a confidence outside 0..1 falls back`、`a disabled configuration never calls the port and falls back to the highest candidate`、`a blank provider or model never calls the port and reports unconfigured`、`a missing port never throws and reports unavailable`）、`tests/llm-port.test.mjs`、`tests/route-tools.test.mjs`（`a failing model port falls back to the highest structured candidate`、`routing.enabled=false keeps the port untouched and uses the fallback`、`an unconfigured model falls back without touching the port`、`a blank provider/model is filled from the host default model route`）。
- [A3] 低置信不产生用户选择请求；面板改投写入目标主题 `aliases` 并记录 `route-corrected` — `tests`：`tests/routing.test.mjs`（`a correction appends intent tokens to aliases only`、`a correction skips aliases that are already known or too short`、`a correction bounds one alias by its maximum length`、`a correction adds at most eight aliases per call`、`a correction never grows the alias list past its maximum`）与 `tests/route-tools.test.mjs`（`applyRouteCorrectionToStore writes aliases and one route-corrected activity`）。
- [A4] `resolved` 不进入自动候选；显式指定已解决主题时返回 `resolved_match` 并新建，不向已解决主题发消息 — `tests`：`tests/routing.test.mjs`（`a resolved focus topic is never continued`、`layer 2 never offers a resolved topic as a candidate`、`an explicit resolved topic is reported as resolved_match`）与 `tests/route-tools.test.mjs`（`an explicit resolved topic returns resolved_match and never prompts the old topic`）。
- [A5] 路由/状态事件只保存有界摘要；`brief` 有长度上限；不把整个意图写进活动或 master 上下文 — `source`：`src/route-tools.ts` 的 `boundedPrompt`（`BRIEF_MAX_CHARS = 2000`）与活动 details 只含有界候选/分数/`modelUsed`/`confidence`，`src/router-model.ts` 的 prompt ≤2,000 字符与 `modelError` ≤200 字符；`tests/route-tools.test.mjs`（`route activity details are bounded and never contain the intent`、`an explicit missing topic, an over-long brief, and forceCreate+topicId fail closed`）把它钉成回归；读取点的无变化不写盘由 `tests/route-tools.test.mjs` 的 A5 两条用例覆盖。
