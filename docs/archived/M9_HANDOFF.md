# M9 交接文档

> **历史文档（2026-11-08 补记）**：M9 已交付，交付结果、证据、偏差与回滚见 [M9_RESULT.md](M9_RESULT.md)。本文件保留为 M9 启动时的交接基线；文中的启动步骤、完成定义与「M9 落地后」动作都是当时的计划，已被 M9 执行完毕，不再按原文执行。

- 状态：**M9 启动文档（2026-11-08）**。M8 已交付并终审通过（[M8 交付结果](M8_RESULT.md)）；本文件写给下一个会话，用于启动 V0.2 M9（路由、工具、预设）。不重新论证 M8 的决定，也不在这里重抄 M9 需求全文。
- 适用：接手 M9 的 agent 或人。范围：M8 交付后的代码基线、M9 的启动方式、分阶段顺序与证据、陷阱、完成定义、回滚与未验证清单。
- 事实源：[PLAN-V0.2](../PLAN-V0.2.md) §2.2/§5.3/§5.7/§5.8/§5.10/§6 M9 拥有需求、工具角色表、配置默认值与验收；[M9 执行记录](../../.agents/notes/implemented/architecture/2026-11-08-m9-routing-tools-presets-plan.md) 拥有执行层决定与备选；[三层路由](../../.agents/notes/implemented/feature/2026-11-07-three-layer-routing.md) 拥有路由需求规则（两份记录已随 M9 落地迁入 implemented）；[主题会话模型](../../.agents/notes/implemented/architecture/2026-11-07-topic-session-model.md) 拥有角色边界；[索引 v2 与迁移](../../.agents/notes/implemented/architecture/2026-11-07-topic-store-v2.md) 拥有数据模型（两份记录已由 M12 迁入 implemented）；[KNOWN_ISSUES](../KNOWN_ISSUES.md) 拥有遗留问题归属。本文件只拥有「从哪继续、先验证什么、怎样算完成」。

## M8 交付后的状态（2026-11-08）

- **基线分支**：`feat/m8-topic-lifecycle`（从 `origin/main` 的 `06ff66b` 切出）。代码交付点 `3723359`；其后是只改 `.md` 的记录迁移、M8 交付结果与 M9 规划提交。分支已 push 到 `origin`，M8 PR 为 [#12](https://github.com/leigangzhang/dsh-cowork/pull/12)；**不要**在 M8 分支上继续开发。
- **启动基线**：如果 M8 PR 已合并，用 `origin/main` 的 merge sha；未合并时，用 `origin/feat/m8-topic-lifecycle` 的 HEAD（启动时用 `git rev-parse` 记录实际 sha，不凭推测）。分支命名建议 `feat/m9-routing-tools-presets`。
- **验证基线**：`npm test` **485 pass / 0 fail / 0 skip / 0 todo**；`npm run typecheck`、`npm run build`、`npm run check` 均 exit 0（M8 代码 HEAD 与文档提交上各跑过一次）。M9 新增测试后计数会增加，不预写未来数字。
- **代码形态**：`src/store.ts` 48,524 B（审查线 49,152 B）；`src/tools.ts` 43,854 B（M9 必须拆分）；`src/router.ts` 7,660 B（M9 重写为 `src/routing.ts`）；`src/presets.ts` 8,460 B；`src/memory-prompt.ts` 7,519 B；`src/index.ts` 24,638 B。
- **M8 已交付**：`src/topic.ts`（三态纯函数）、`src/topic-events.ts`（`turn/end`/重开/锁内放弃/错误只 log，`src/index.ts` 常驻装配）、`src/activity.ts`（业务活动构造）、`src/inbox.ts`（≤5 条/≤200 字/失败保留/replay）；store 新增 `readIndexDocument`/`mutateIndexDocument` 与迁移 activity 顺序修复（KI-20）。**M9 的新代码一律用 canonical v2 读写**，不要再经过 `readIndex()`/`mutateIndex()` 的 v1 视图写状态。
- **M8 已知偏差/未验证（M9 必须带着走）**：F1 `activity.ts` builder 暂无生产调用者、`topic-events.ts` 内联 `topic-reopened`（M9 接 activity 时统一）；F2 事件监听依赖 `session.header.cwd`，真实宿主未验证（M12）；F3 `Inbox.flush` 先投递后写 `deliveredAt` 的 at-least-once 重复风险（M9 接重放前处理）；真实宿主 E2E 与真实 v1 数据迁移归 M12（KI-22）；`workItems` 恒空，M9 的评估固定传 `activeWorkItems: 0`，M10 再传真实计数。
- **M8 读取点未接**：`cowork_project_status`/`cowork_route` 尚未调用 `evaluateTopicLifecycle`；M9 必须接上（M11 接面板）。

## 先读什么

1. [AGENTS.md](../../AGENTS.md)：纪律、命令、文档与提交规则。
2. [PLAN-V0.2](../PLAN-V0.2.md) §2.2（主会话路由流程）、§5.3（三层路由）、§5.7（工具与角色）、§5.8（预设与记忆）、§5.10（配置默认值）、§6 M9（范围与完成标准）。
3. [M9 执行记录](../../.agents/notes/implemented/architecture/2026-11-08-m9-routing-tools-presets-plan.md)：模块边界、数据/配置扩展、读取点、工具拆分、验收与分阶段顺序（M9 已落地并迁入 implemented）。
4. [三层路由](../../.agents/notes/implemented/feature/2026-11-07-three-layer-routing.md)：第一/二/三层、低置信不弹窗、resolvedMatch、别名纠正（M9 已落地并迁入 implemented）。
5. [主题会话模型](../../.agents/notes/implemented/architecture/2026-11-07-topic-session-model.md)：master/插件/主题/reviewer 的角色边界与旧 thread 别名（M12 已迁 implemented）。
6. [M8 交付结果](M8_RESULT.md)：M8 实际交付、证据、偏差、回滚；[M8 执行记录](../../.agents/notes/implemented/architecture/2026-11-07-m8-lifecycle-activity-inbox-plan.md) 与 [三态规则](../../.agents/notes/implemented/feature/2026-11-07-three-state-lifecycle.md) 是 M8 的正式记录。
7. [M6 探针结果](M6_PROBE_RESULT.md) §1（LLM prepareCall/关闭推理）、§5（preset 工具面与 per-agent restrict 边界）、§2（session/event）。
8. [docs/testing.md](../testing.md)、[docs/documentation.md](../documentation.md)、[tools/workflow.json](../../tools/workflow.json)：证据面、文档分类、检查映射。
9. [KNOWN_ISSUES](../KNOWN_ISSUES.md)：KI-18（兼容层，M9→M10→M12）、KI-19/21/22。

## 第一步：M9 的启动顺序

1. `git fetch origin`；工作区必须干净（`git status --porcelain` 为空）。
2. 确定基线（见上）；从基线新建 `feat/m9-routing-tools-presets`，不要继续在 M8 分支上提交，不要 rebase/force 已有提交。
3. 在新分支跑基线四命令：`npm test`（期望 485 pass）、`npm run typecheck`、`npm run build`、`npm run check`，全部 exit 0 才改代码。任何红先停下报告。
4. 建新团队 `m9-routing-tools-presets`（`profile=impl-review`、`approval=automatic`，不复用 M8 团队）：implementation（写代码与测试，inScope 显式）→ verification（只跑命令，独立复跑四命令）→ review（只读终审，`reviewedTaskId`=实现，verdict=pass 才收口）。并行写先 `worktree_create` 隔离、合并队长独占；集成后先 `integration-ready` 再 verification/review。
5. 先写会红的测试，再实现；每个最小工作单元通过检查后 commit（Conventional Commits），不 push，等队长统一处理。
6. 启动时用最小探针确认插件上下文能拿到宿主 `llm` 服务（M6 探针 1 只在注入工具带里验证过）；拿不到就把 `routing.enabled=false` 的确定性路径做完整，并把第三层记入未验证，不假装可用。

## M9 实施顺序

1. **M9.1 — 配置、索引字段与纯路由**
   - 范围：`src/index.ts`（Config 增加 idle/resolve/routing.*，带默认值；测试手动构造 Config 时 apply 要容忍缺省）、`src/store-schema.ts`（`ProjectIndexV2` 增加 `masterFocusTopicId`/`lastRouteTopicId`，normalize 补 null、problems 容忍 null/缺省）、`src/store-migration.ts`（迁移写 null）、新增 `src/routing.ts`（tokenize/结构化评分/第一二层/`applyRouteCorrection`/`routeCreateTitle`）、删除 `src/router.ts`、`tests/routing.test.mjs`、`tests/store-schema.test.mjs` 扩展。
   - 先写：第一层命中不调模型；第二层排除 resolved、分数与 reasons；1–3 候选才 needs_model；`applyRouteCorrection` 去重/50 条/长度上限；标题 24 字；旧 v2 文档缺字段按 null 读、非法值报错。
   - 证据：`node --test tests/routing.test.mjs tests/store-schema.test.mjs`；`npm run typecheck`。`src/store.ts` 不应增加字节。
2. **M9.2 — 模型兜底**
   - 范围：新增 `src/router-model.ts`、`tests/router-model.test.mjs`、`src/route-tools.ts` 的第三层接线（M9.3 落地前可先只在模型模块内测）。
   - 先写：输入 ≤2k、输出 schema 校验、maxTokens/超时/关闭推理参数、失败/超时/坏输出回退、`routing.enabled=false` 不调用；fake llm，不挂真实宿主。
   - 证据：`node --test tests/router-model.test.mjs tests/routing.test.mjs`；`npm run typecheck`。
3. **M9.3 — 工具拆分、新工具名/别名、读取点与有界状态**
   - 范围：新增 `src/tool-runtime.ts`、`src/project-tools.ts`、`src/topic-tools.ts`、`src/route-tools.ts`、`src/memory-tools.ts`、`src/checkout-tools.ts`；`src/tools.ts` 只做编排；`src/index.ts` 只装配；`tests/tools.test.mjs`、`tests/tools-init.test.mjs`、`tests/api.test.mjs` 适配，新增 `tests/project-tools.test.mjs`、`tests/topic-tools.test.mjs`、`tests/route-tools.test.mjs`。
   - 先写：`cowork_topic_create`/`cowork_topic_list` 与 `cowork_thread_*` 别名同结果；`cowork_topic_resolve`；`cowork_handoff(done)` 写 digest/lastDeliveryConfirmedAt、`blocked` 置标记、`awaiting_review` 标 deprecated；`cowork_route` 返回 action/topicId/resolvedMatch/reason/candidates/modelUsed；读取点评估锁内无变化不写；`project_status` 有界 + inbox replay；activity 只写有界摘要。
   - 证据：`node --test tests/project-tools.test.mjs tests/topic-tools.test.mjs tests/route-tools.test.mjs tests/tools.test.mjs tests/tools-init.test.mjs tests/api.test.mjs`；`npm run typecheck`。`src/tools.ts` ≤ 49,152 B。
4. **M9.4 — 预设与记忆**
   - 范围：`src/presets.ts`（master 行去 fs/fs-search/bash/jobs/present；新增 `cowork-topic`；`cowork-thread` 同行别名；reviewer persona 加边界）、`src/memory-prompt.ts`（识别 master/topic/thread，不注入 reviewer）、`tests/presets.test.mjs`、`tests/memory-prompt.test.mjs`。
   - 证据：`node --test tests/presets.test.mjs tests/memory-prompt.test.mjs`；`npm run typecheck`。
5. **M9.5 — 收口**
   - 证据：`npm test`（应 ≥485 + 新增，0 fail/0 skip）、`npm run typecheck`、`npm run build`、`npm run check` 全绿；记录各命令 exit code 与测试计数；记录 `src/tools.ts`、`src/store.ts` 字节数。
   - 记录：`three-layer-routing`（proposed/feature）迁到 implemented 并按骨架重写；`topic-session-model` 与 `topic-store-v2` 当时仍 proposed（M11/M10 各自收口；M12 已迁 implemented）；写 `docs/M9_RESULT.md`（新文件，不要覆盖本交接）并更新本交接为已交付；`npm run check` 通过，无未分类 `.md`。
   - 停：四命令全绿后停下等确认，不进入 M10（评审请求、reviewer、隔离、合并属于 M10）。

## 验证与证据

- 每条实现的最小证据：`node --test <本阶段测试文件>` + `npm run typecheck`；阶段收口：`npm test` + `npm run typecheck` + `npm run build` + `npm run check`，逐条记录 exit code，不只说「通过」。
- 测试只用 `os.tmpdir()` 夹具，不读写真实 `.dsh-cowork/`；不用固定 `sleep` 当就绪判据；等待用带截止时间的轮询或事件。
- 真实宿主 E2E 与真实数据迁移仍归 M12（KI-22）；M9 的模型路径若只能在 fake llm 上验证，明确写「未在真实宿主验证」。
- 审查：实现者 ≠ 验证者 ≠ 最终审查者；verification 独立复跑，review 只读、verdict=pass 才收口；队长独立复跑命令并核对 diff，不转述成员结论。

## 陷阱

- **`src/store.ts` 余量只有约 628 B**：M9 不应往 store 加业务代码；新字段校验放 `store-schema.ts`。任何 store 侧新增先停下报告拆分方案，不压行、不删测试。
- **`src/tools.ts` 必须先拆再改**：当前 43,854 B（审查线 49,152 B），M9 要加新工具与别名；拆分是 M9 的验收项，不是收尾项。
- **v1 兼容层只减不增**：M9 的新工具/路由/状态一律用 canonical v2 API；`readIndex()`/`mutateIndex()` 只留给 M10 前的 review/checkout 兼容路径。不要给 legacy 字段加新写入者。
- **读取点写放大**：`evaluateProjectLifecycle` 必须在锁内跑、无变化返回 `null`；不要每次 status 都写盘，也不要用 `readIndex` 后再 `mutateIndex`（会丢并发）。
- **`masterFocusTopicId` 的写入者**：M9 写 `lastRouteTopicId`，M11 才写 focus；M9 的测试用注入值覆盖第一层，不要假装面板已接。
- **别名污染**：纠正 token 有上限（≤50、长度上限、去重）；不要把整句 intent 写进 aliases，也不要把敏感内容写进 activity。
- **预设工具面**：preset 只追加自己的行，profile 级全局工具始终可见（M6 探针 5）；master 的 fs/bash 移除是 preset 行层面，不是硬隔离，文档不要夸大。
- **`awaiting_review` 兼容**：M9 保留它一个版本，M10 的评审请求落地后移除；不要在本阶段改 review-tools 的语义或工作项。
- **事件监听**：M8 已在 `src/index.ts` 装配常驻 `session/event`；M9 不要重复注册，也不要把它塞进 dev-only 分支。
- **文档**：`.dsh-cowork` 禁 `.md`；新文件必须在 `docs/publish.json` 分类；记录迁移后跑 `npm run check`。

## 完成定义

- **M9（本阶段）**：三层路由（第一层焦点/上次目标、第二层结构化 + reasons、第三层 1–3 候选模型兜底）、低置信不弹窗、失败/超时回退、resolved 不进自动候选、显式 resolved 返回 `resolvedMatch` 并新建、别名纠正纯函数与 `route-corrected` 事件；`cowork_topic_create`/`cowork_topic_list`/`cowork_topic_resolve` 与旧 `cowork_thread_*` 别名同结果；`cowork_handoff(done)` 写 digest/交付确认；`project_status`/`cowork_route` 读取点惰性评估三态、status 有界、inbox 重放；master preset 去 fs/search/bash/jobs/present，`cowork-topic` 与 `cowork-thread` 别名、memory 识别三种 preset；配置默认值按 §5.10；索引 focus/route 字段向后兼容；四命令全绿；`src/tools.ts` ≤ 49,152 B、`src/**` < 51,200 B、`src/store.ts` 不越过 49,152 B；无 M10–M12 模块；`three-layer-routing` 迁 implemented；`docs/M9_RESULT.md` 与交接更新；`npm run check` 通过；阶段结束停下等确认。
- **不做**：评审请求、reviewer 生命周期、工作项、隔离合并、面板/API v2、会话可见性、真实 E2E、真实数据迁移、0.2.0 发布；都不属于 M9。

## 回滚

- **代码**：按 M9 提交序列 `git revert`；M9 只扩展索引可选字段、不改已有 schema 语义，回滚代码不需要数据迁移（旧文档的 focus/route 字段会被 M8 代码忽略）。
- **数据**：M9 只写 `lastRouteTopicId`/`masterFocusTopicId`（M11 起）、`digest`/`lastDeliveryConfirmedAt`、activity 与 inbox；回滚后 v2 文档仍可被 M8 代码读取。
- **文档/记录**：`git revert` 对应文档提交；`three-layer-routing` 的迁移是记录变更，可随提交回滚。不要 force-push。

## 未验证

- 真实宿主 `llm` 调用（插件上下文）与 M9 第三层路由的真实延迟/成本；M6 探针 1 只在注入工具带里验证过 prepareCall/关闭推理。
- 真实宿主 E2E 全链路（M12）；M9 的模型路径与 `resolvedMatch` 在真实会话中的行为未验证。
- `session.header.cwd` 的稳定性（M8 F2，M12 首验）；500 条事件缓冲上限。
- 真实旧 v2 文档缺 `masterFocusTopicId`/`lastRouteTopicId` 的读取与首次写回（M9 用 os.tmpdir 测试，真实数据演练在 M12）。
- `workItems` 恒空：M9 的评估固定 `activeWorkItems: 0`；M10 必须传入真实 active 计数，否则五条件可能误判。
- 宿主 profile 全局工具对 master 仍可见（M6 探针 5）；M9 只保证 preset 行与工具入口校验。

## 指针

- M8 交付结果与证据：[M8_RESULT.md](M8_RESULT.md)。
- M8 启动交接（历史）：[M8_HANDOFF.md](M8_HANDOFF.md)。
- M9 执行记录（implemented）：[2026-11-08-m9-routing-tools-presets-plan.md](../../.agents/notes/implemented/architecture/2026-11-08-m9-routing-tools-presets-plan.md)。
- 路由需求规则（implemented）：[2026-11-07-three-layer-routing.md](../../.agents/notes/implemented/feature/2026-11-07-three-layer-routing.md)。
- 角色模型（implemented）：[2026-11-07-topic-session-model.md](../../.agents/notes/implemented/architecture/2026-11-07-topic-session-model.md)。
- M8 执行记录与三态规则（implemented）：[M8 执行记录](../../.agents/notes/implemented/architecture/2026-11-07-m8-lifecycle-activity-inbox-plan.md)、[主题三态与已解决规则](../../.agents/notes/implemented/feature/2026-11-07-three-state-lifecycle.md)。
- 遗留问题与归属：[KNOWN_ISSUES](../KNOWN_ISSUES.md)。
