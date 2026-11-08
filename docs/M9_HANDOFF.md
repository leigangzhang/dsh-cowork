# M9 交接文档

- 状态：**M9 已交付（2026-11-08）**。三层路由、模型兜底、工具拆分/别名、主题与预设改名已在 `feat/m9-routing-tools-presets` 上落地并通过独立验证。本文件写给接手 V0.2 M10（评审请求、reviewer 生命周期、工作项）的会话；交付事实、证据、偏差与回滚以 [M9 交付结果](M9_RESULT.md) 为准，本文件只保留「从哪继续、先验证什么、不要踩什么」。启动顺序与实施顺序保留为**交付前历史**，不是待办。
- 适用：接手 M10 的 agent 或人。范围：M9 交付后的代码基线、M10 起点、仍然有效的陷阱、未验证清单与指针。
- 事实源：[PLAN-V0.2](PLAN-V0.2.md) §2.2/§5.3/§5.7/§5.8/§5.10/§6 M9/M10 拥有需求与验收；[M9 执行记录](../.agents/notes/implemented/architecture/2026-11-08-m9-routing-tools-presets-plan.md) 拥有模块边界与备选；[三层路由](../.agents/notes/implemented/feature/2026-11-07-three-layer-routing.md) 拥有路由规则；[主题会话模型](../.agents/notes/proposed/architecture/2026-11-07-topic-session-model.md) 拥有角色边界（M11 收口）；[索引 v2 与迁移](../.agents/notes/proposed/architecture/2026-11-07-topic-store-v2.md) 拥有数据模型（M10 收口）；[KNOWN_ISSUES](KNOWN_ISSUES.md) 拥有遗留问题归属。

## 交付结果（2026-11-08）

- **分支与代码 HEAD**：`feat/m9-routing-tools-presets`，代码 HEAD `569d485`（`569d485d910748769cf16a26d80185b0841c93e6`）。`6379712` 之后只追加两个只改注释/测试注释的提交：`d43c75d`+`5c856c4`（dev-gate 注释 eleven/three → fourteen/four）与 `73084b4`+`569d485`（presets 注释：新会话用 `cowork-topic`、`cowork-thread` 只服务存量会话），596 与字节不变；记录迁移、本文件与 `publish.json` 分类是其后的文档提交（只改 `.md`/`.json`）。**不要**在该分支继续开发 M10，从合并后的 `main` 或该 HEAD 新建阶段分支。
- **验证基线**：`npm test` **596 tests / 596 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo**，exit 0；`npm run typecheck`、`npm run build`、`npm run check`（`check-invariants: ok`）均 exit 0。M9 之前基线 485 pass，新增/改写 111 条。
- **代码形态（`569d485` 上复核不变）**：`src/tools.ts` **2,489 B**（只做 14 个工具的注册编排）；`src/store.ts` **48,590 B**（余量约 562 B）；`src/**/*.ts` 最大 `src/m2-e2e.ts` 49,923 B；新增 `src/routing.ts`、`src/router-model.ts`、`src/llm-port.ts`、`src/tool-runtime.ts`、`src/project-tools.ts`、`src/topic-tools.ts`、`src/route-tools.ts`、`src/memory-tools.ts`、`src/checkout-tools.ts`；删除 `src/router.ts` 与 `tests/router.test.mjs`。
- **范围**：`git diff --name-only 7b9a6a5..569d485` 恰为 39 个文件（20 src + 19 tests；`6379712..569d485` 的四个提交只改 `tests/dev-gate.test.mjs` 与 `src/presets.ts` 的注释），无 `docs/**`、`presets/**`、`src/client/**`、`src/api*.ts`。完整交付清单与 A1–A9 证据见 [M9_RESULT](M9_RESULT.md)。

## 交付后的状态（M10 的起点）

- **路由**：`cowork_route` 已是三层（`src/routing.ts` 纯函数：第一层 focus/lastRoute、第二层结构化评分 + reasons、第三层 1–3 候选模型兜底），读取前在锁内惰性评估 `idle`/`resolved`，写 `lastRouteTopicId` 与有界活动；显式 `resolved` 返回 `resolved_match` 并新建主题；`resolved` 不进自动候选。模型端口在 `src/router-model.ts`，宿主 `llm` 装配在 `src/index.ts`，流式形状在 `src/llm-port.ts`。
- **工具**：14 个工具由 `tools.ts` 编排、五个业务模块注册；`cowork_topic_create`/`cowork_topic_list`/`cowork_topic_resolve` 为 canonical，`cowork_thread_create`/`cowork_thread_list` 为同 schema/同 payload 的弃用别名；`cowork_route` 参数为 `intent`/`topicId?`/`brief?`/`forceCreate?`（旧的 `subject`/`isolated` 已移除）。
- **读取点**：`cowork_project_status` 与 `cowork_route` 都调用 `src/tool-runtime.ts` 的 `evaluateProjectLifecycle`（锁内、无变化返回 `null` 不写盘）；`project_status` 有界（≤50 topic、digest ≤200、活动尾部 20、`truncated`）并重放未投递 inbox。A5 的 route 读取点回归在 `tests/route-tools.test.mjs` 末尾两条用例。
- **交接**：`cowork_handoff` 只保留 `blocked`/`done`（`awaiting_review` 保留一版、description 标 deprecated）；`done` 写 `digest`（≤200 字）与 `lastDeliveryConfirmedAt`、清 `blocked`，不再把主题标 resolved。M10 的评审请求落地后**必须**替换 `awaiting_review` 与 legacy review 兼容（KI-25）。
- **预设与记忆**：`cowork-master` 只挂 persona/agent-instructions/time-context/ask-user/todo；`cowork-topic` 是完整主题预设（10 行），`cowork-thread` 为逐行相同的弃用别名；reviewer 行不变、persona 有「只看请求范围，不合并、不解决冲突」边界；memory 识别 master/topic/thread，不注入 reviewer。
- **配置**：`idleAfterMs`/`resolveAfterMs`/`routing.{enabled,provider,model,effort,timeoutMs,maxTokens}` 默认值按 [PLAN-V0.2](PLAN-V0.2.md) §5.10；索引根字段 `masterFocusTopicId`/`lastRouteTopicId` 缺省 `null`，无迁移。
- **留给后续阶段**：M10——评审请求与 reviewer 生命周期、工作项、隔离合并、`cowork_handoff` 的 `awaiting_review` 替换、读取点传真实 `activeWorkItems`（KI-24）；M11——面板/API v2、会话可见性、写 `masterFocusTopicId`、面板改投调用 `applyRouteCorrectionToStore`；M12——真实宿主 E2E、真实数据迁移、0.2.0 文档收口（KI-22/KI-18/KI-23）。

## 交付前历史：M9 启动顺序（已完成，不要照做）

以下步骤在 M9 启动时执行过，保留为历史；M10 应按下个阶段自己的交接建立顺序。

1. `git fetch origin`；工作区干净（`git status --porcelain` 为空）。
2. 确定基线（M9 用 `origin/main` 的 M8 合并提交 `7b9a6a5`），新建 `feat/m9-routing-tools-presets`，不在旧分支继续提交。
3. 在新分支跑基线四命令（M9 期望 485 pass），全部 exit 0 才改代码。
4. 建 AgentTeams 团队（implementation → verification → review；并行写先 worktree 隔离、合并队长独占；集成后先 integration-ready 再 verification/review）。
5. 先写会红的测试再实现；每个最小单元通过检查后 commit（Conventional Commits），不 push。
6. 启动时用最小探针确认插件上下文能拿到宿主 `llm`（M9 已做，结论见 [M9_RESULT](M9_RESULT.md) §真实宿主探针证据：可达、`reasoningOff`、真实流 `M9_LLM_OK`；但 `cowork-topic` 因 web profile 禁用插件未能 live 验证）。

## 交付前历史：M9 实施顺序（已完成）

M9.1 配置/索引字段/纯路由（`030cd36`）→ M9.2 模型兜底 + M9.4 预设/记忆（`96db9dc`）→ M9.3a 工具运行时/有界 status/读取点（`28c9fcf`）→ M9.3b topic/route 工具、handoff v2、删除 `router.ts`、宿主 llm 端口（`627f426` + `f8241ca`）→ A5 读取点回归（`e2a887f`）→ 收口（本文件与记录迁移）。注意实际偏差：`router.ts` 的删除挪到 M9.3b 原子完成，不在 M9.1。

## 陷阱（交付后仍然有效）

- **`src/store.ts` 余量只剩约 562 B**：M10 不应往 store 加业务代码；新字段校验放 `store-schema.ts`。任何 store 侧新增先停下报告拆分方案，不压行、不删测试。
- **`src/tools.ts` 现在是 2,489 B 的编排层**：新工具加到对应业务模块并只在 `tools.ts` 注册；保持「`tools.ts` 只编排」的 source-budget 断言。
- **v1 兼容层只减不增**：新代码一律用 canonical v2 API（`readIndexDocument`/`mutateIndexDocument`）；`readIndex()`/`mutateIndex()` 只留给 M10 前的 review/checkout 兼容路径；不要给 legacy 字段加新写入者（KI-18）。
- **读取点写放大**：`evaluateProjectLifecycle` 必须在锁内跑、无变化 `return null`；不要每次 status/route 都写盘，也不要 `readIndex` 后再 `mutateIndex`（会丢并发）。
- **`activeWorkItems` 恒 0**：`evaluateProjectLifecycle` 当前固定 `activeWorkItems: 0`，M10 引入工作项后必须传真实 active 计数，否则可能误自动 resolved（KI-24）。
- **`awaiting_review` 兼容**：保留一版并标 deprecated；M10 的评审请求落地后替换/移除，并同步 `topic-tools` 与测试（KI-25）。不要在本阶段改 review-tools 语义却不替换旧链。
- **别名污染**：纠正 token 有上限（单次 ≤8、列表 ≤50、单条 ≤32 字符、去重）；不要把整句 intent 写进 aliases，也不要把 intent 或敏感内容写进 activity。
- **预设工具面**：preset 只追加自己的行，profile 级全局工具始终可见（M6 探针 5）；master 去 fs/bash 是 preset 行层面，不是硬隔离，文档不要夸大。
- **模型兜底**：第三层只在 `needs_model` 时调用；`routing.enabled=false`、provider/model 未配置、端口缺失都不得调用端口；超时 2,000 ms、默认 `reasoningEffort='off'`；任何失败回退最高结构化候选或新建，不弹窗、不抛错。
- **文档**：`.dsh-cowork` 禁 `.md`；新 `.md` 必须在 `docs/publish.json` 分类；记录迁移后跑 `npm run check`。

## 未验证

- 真实宿主端到端（三层路由、`resolved_match`、读取点、面板）——M12（KI-22）；本机 web profile 的 `cordis.patch.yml` 把 `dsh-cowork` 设为 `disabled: true`，插件在真实会话中的装配未验证。
- `cowork-topic` 预设的真实创建与归档；探针只在一个临时预设上验证了会话创建/归档（`session-e03e1cc2-…`）。
- 模型第三层的真实延迟/成本/路由质量与调用率；`llm-port` 形状有真实流证据，但真实路由调用未跑。
- 真实旧 v1/v2 数据的迁移与回滚演练（KI-22）；M9 的索引字段只扩展可选根字段。
- `session.header.cwd` 的稳定性（M8 F2，M12 首验）；500 条事件缓冲上限。
- 面板/API v2 与会话可见性（M11）；宿主 profile 全局工具对 master 仍可见（M6 探针 5）。

## 回滚

- **代码**：按 [M9_RESULT](M9_RESULT.md) §回滚 的提交序列逆序 `git revert`；M9 只扩展可选根字段，回滚代码不需要数据迁移。
- **数据**：M9 只写 `lastRouteTopicId`、handoff 摘要/交付确认/标记、activity 与 inbox；回滚后 v2 文档仍可被 M8 代码读取。
- **文档/记录**：`git revert` 对应只改 `.md` 的提交；`three-layer-routing` 与 M9 执行记录回到 `proposed/`，`publish.json` 与 `PLAN-V0.2` §8 路径随提交回滚。不要 force-push。

## 指针

- M9 交付结果与证据：[M9_RESULT.md](M9_RESULT.md)。
- M9 执行记录（implemented）：[2026-11-08-m9-routing-tools-presets-plan.md](../.agents/notes/implemented/architecture/2026-11-08-m9-routing-tools-presets-plan.md)。
- 路由需求规则（implemented）：[2026-11-07-three-layer-routing.md](../.agents/notes/implemented/feature/2026-11-07-three-layer-routing.md)。
- 角色模型（proposed，M11 收口）：[2026-11-07-topic-session-model.md](../.agents/notes/proposed/architecture/2026-11-07-topic-session-model.md)。
- 索引 v2 与迁移（proposed，M10 收口）：[2026-11-07-topic-store-v2.md](../.agents/notes/proposed/architecture/2026-11-07-topic-store-v2.md)。
- M8 交付结果：[M8_RESULT.md](M8_RESULT.md)；M8 执行记录：[2026-11-07-m8-lifecycle-activity-inbox-plan.md](../.agents/notes/implemented/architecture/2026-11-07-m8-lifecycle-activity-inbox-plan.md)；三态规则：[2026-11-07-three-state-lifecycle.md](../.agents/notes/implemented/feature/2026-11-07-three-state-lifecycle.md)。
- 宿主能力证据：[M6_PROBE_RESULT.md](M6_PROBE_RESULT.md) §1/§5。
- 遗留问题与归属：[KNOWN_ISSUES](KNOWN_ISSUES.md)（KI-18、KI-22、KI-23、KI-24、KI-25 与 M9 相关）。
