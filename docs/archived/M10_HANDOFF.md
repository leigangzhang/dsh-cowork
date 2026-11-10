# M10 交接文档

- 状态：**M10 已交付（2026-11-08）；本文件保留为启动文档，交付事实、证据与未验证项见 [M10 交付结果](M10_RESULT.md)。** 本文件写给下一个会话，用于启动 V0.2 M10（评审请求、reviewer 生命周期、工作项、隔离合并）。不重新论证 M9 的决定，也不重抄 M10 需求全文；交付后的现状不在此回写。
- 适用：接手 M10 的 agent 或人。范围：M9 交付后的代码基线、M10 的启动方式、实施顺序与证据、陷阱、完成定义、回滚与未验证清单。
- 事实源：[PLAN-V0.2](../PLAN-V0.2.md) §2.2/§2.3/§4.2/§4.3/§4.5/§5.4/§5.5/§5.7/§5.10/§6 M10 拥有需求、数据模型、工具角色与验收；[M10 执行提案](../../.agents/notes/implemented/architecture/2026-11-08-m10-review-request-workitems-plan.md) 拥有执行层决定与备选；[评审按请求触发](../../.agents/notes/implemented/feature/2026-11-07-review-request-model.md) 拥有评审规则；[并行隔离与合并](../../.agents/notes/implemented/architecture/2026-11-07-parallel-isolation-and-merge.md) 拥有工作项与合并边界；[主题会话模型](../../.agents/notes/implemented/architecture/2026-11-07-topic-session-model.md) 拥有角色；[索引 v2 与迁移](../../.agents/notes/implemented/architecture/2026-11-07-topic-store-v2.md) 拥有文件布局（两份记录已由 M12 迁入 implemented）；[KNOWN_ISSUES](../KNOWN_ISSUES.md) 拥有遗留问题归属；本文件只拥有「从哪继续、先验证什么、怎样算完成」。

## M9 交付后的状态（2026-11-08）

- **基线分支**：M9 在 `feat/m9-routing-tools-presets` 上交付并推送，PR 为 [#14](https://github.com/leigangzhang/dsh-cowork/pull/14)。启动时先 `git fetch origin`；**如果 M9 PR 已合并**，用 `origin/main` 的 merge sha 作为基线；**未合并**时用 `origin/feat/m9-routing-tools-presets` 的 HEAD（启动时用 `git rev-parse` 记录实际 sha，不凭推测）。分支建议 `feat/m10-review-request-workitems`。
- **M9 代码 HEAD**：`a741e65`。其后的 M9 交接整理、文档回滚与 AgentTeams 规则提交只改 `.md`，不改变代码基线；M9 交付事实见 [M9_RESULT](M9_RESULT.md)。
- **验证基线**：`npm test` **596 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo**；`npm run typecheck`、`npm run build`、`npm run check` 均 exit 0（M9 终局验证与队长复跑一致）。M10 新增测试后计数会增加，不预写未来数字。
- **代码形态**：`src/tools.ts` 2,489 B（只做 14 工具编排）；`src/store.ts` **48,590 B**（审查线 49,152 B，**余量约 562 B**）；`src/**/*.ts` 最大 `src/m2-e2e.ts` 49,923 B（<51,200 B）；已存在 `routing.ts`/`router-model.ts`/`llm-port.ts`/`tool-runtime.ts`/`project-tools.ts`/`topic-tools.ts`/`route-tools.ts`/`memory-tools.ts`/`checkout-tools.ts`；**不存在** `review-request.ts`/`work-item.ts`/`session-visibility.ts`。
- **M9 留下的接口**：14 个工具、4 个预设；`cowork_handoff` 仍接受 deprecated `awaiting_review`；`cowork_project_status` 仍跑 handoff 兼容重放并固定 `activeWorkItems: 0`；`cowork_review_request(threadId)`/`cowork_review_verdict(threadId)` 仍是旧 handoff 链、verdict-only 文件、v1 索引写入；`cowork_checkout_merge(threadId)` 仍是旧 clone 与 `allowUnreviewed` override。这些是 M10 要替换的对象。
- **已知遗留（M10 必须带着走）**：KI-18（legacy 兼容层，M9 已完成 tools/presets 改写）、KI-24（`activeWorkItems=0`）、KI-25（`awaiting_review`/旧评审链）。KI-15/17/19/21/22/23 保持原归属（M12 或保持）。

## 先读什么

1. [AGENTS.md](../../AGENTS.md) 与 [docs/AGENTTEAM.md](../AGENTTEAM.md)：纪律、命令、AgentTeams 的 DAG/artifact/交付规则。
2. [PLAN-V0.2](../PLAN-V0.2.md) §2.2（主会话流程 / 评审 / 并行合并）、§2.3（状态机）、§4.2（模块图）、§4.3（评审请求与工作项字段）、§4.5（隔离路径）、§5.4/§5.5/§5.7/§5.10、§6 M10。
3. [M10 执行提案](../../.agents/notes/implemented/architecture/2026-11-08-m10-review-request-workitems-plan.md)：模块边界、文件格式、工具顺序、合并目标、M9 遗留删除顺序、测试影响面。
4. [评审按请求触发](../../.agents/notes/implemented/feature/2026-11-07-review-request-model.md) 与 [并行隔离与合并](../../.agents/notes/implemented/architecture/2026-11-07-parallel-isolation-and-merge.md)：请求字段/单评审负责人、工作项/合并/`main` 由人收口；两份记录在 M10.5 迁移为 implemented。
5. [主题会话模型](../../.agents/notes/implemented/architecture/2026-11-07-topic-session-model.md) 与 [索引 v2 与迁移](../../.agents/notes/implemented/architecture/2026-11-07-topic-store-v2.md)：角色边界、review 文件/activity/inbox 布局（M12 已迁 implemented）。
6. [M9 交付结果](M9_RESULT.md)：M9 实际交付、证据、偏差、回滚与未验证；[M9 执行记录](../../.agents/notes/implemented/architecture/2026-11-08-m9-routing-tools-presets-plan.md) 与 [三层路由](../../.agents/notes/implemented/feature/2026-11-07-three-layer-routing.md) 是正式记录。
7. [M6 探针结果](M6_PROBE_RESULT.md) §4（reviewer 创建后立即归档会 `blocked`）；[docs/testing.md](../testing.md)、[tools/workflow.json](../../tools/workflow.json)：证据面与检查映射。
8. [KNOWN_ISSUES](../KNOWN_ISSUES.md)：KI-18/24/25 的归属与重估条件。

## 第一步：M10 的启动顺序

1. `git fetch origin`；工作区必须干净（`git status --porcelain` 为空）。
2. 确定基线（见上；启动时记录实际 commit sha），新建 `feat/m10-review-request-workitems`，不在 M9 分支上继续开发，不 rebase/force。
3. 在新分支跑基线四命令：`npm test`（期望 596 pass）、`npm run typecheck`、`npm run build`、`npm run check`，全部 exit 0 才改代码。任何红先停下报告。
4. 建团队前读 [docs/AGENTTEAM.md](../AGENTTEAM.md)。使用配置 profile（`impl-review`；如需并行写用 `impl-review-parallel`），先派 **impact-scan** 任务（grep 改动符号引用的测试/guard、`wc -c` 预算），再做实现；并行写必须先 `worktree_create` 隔离、把 `worktreePath` 写进任务，合并队长独占。
5. **reviewer 必须能执行只读命令**：profile 默认 reader 的 `readonly` 策略没有 bash（M9 实测只能静态审查）。建队后用 `tool_policy="verify-only"` 加一个可执行的 reviewer（或让 verifier 复跑命令、review 明确声明静态审查）；review 在隔离 worktree/副本执行，finding 带相对路径:行号 + requiredFix。
6. 按 M10.1–M10.5 先写会红的测试再实现；每个最小工作单元通过定向检查后 commit（Conventional Commits），不 push，等队长统一处理。
7. `integration-ready` 门禁记录 `git rev-parse HEAD`、`git diff <base>..HEAD | shasum -a 256`、`git status --porcelain`；同一 artifact 复用证据，产物变化才重跑。verification 依赖 integration-ready，review 依赖 verification；代码冻结后只做 docs/记录变更与 `npm run check`；review 后一次性批量修复 finding；最后建 delivery 任务完成 merge/push/PR 并记录最终 HEAD/artifact/PR URL。

## M10 实施顺序

1. **M10.1 — 纯模型、schema、配置与 `review.ts` 退役**
   - 范围：新增 `src/review-request.ts`、`src/work-item.ts`（纯部分）；`src/store-schema.ts`（legacy `ReviewRecord` 类型迁入，必要时补 review-request 类型）；`src/index.ts` Config（`isolation.provider` 默认 `'clone'`、`reviewer.reclaim` 默认 `'after-verdict'`）；删除 `src/review.ts` 并把 `REVIEWER_PRESET_ID` 移到 `src/presets.ts`、legacy 类型 import 改到 `store-schema.ts`；`tests/review.test.mjs` 按新模型拆分/迁移。
   - 先写：请求最小字段/`extra` 上限/findings 规则/previous 链/merge gate 的纯函数测试；Config 默认值；`class`/typecheck 不受影响。
   - 证据：`node --test tests/review-request.test.mjs tests/work-item.test.mjs`；`npm run typecheck`；`src/store.ts` 字节不增。
2. **M10.2 — 工作项与 checkout 泛化**
   - 范围：`src/checkout.ts` 的 `IsolationTarget`/`workItemCheckoutPaths`/保护分支与复用旧 thread 默认；`src/work-item.ts` 的创建/清理/状态/active 计数；`src/checkout-tools.ts` 注册 `cowork_work_item_create`；`tests/work-item.test.mjs`、`tests/checkout.test.mjs` 扩展。
   - 先写：路径/分支/重复创建/非法路径/provider 非 clone/失败清理；旧 thread clone 行为不变。
   - 证据：`node --test tests/work-item.test.mjs tests/checkout.test.mjs`；`npm run typecheck`。
3. **M10.3 — 评审请求与 verdict 生命周期**
   - 范围：新增 `src/session-visibility.ts`；重写 `src/review-tools.ts`；`src/review-request.ts` 的文件层与 brief；`src/tool-runtime.ts` 的 inbox 投递 helper；`tests/review-request.test.mjs`、`tests/review-verdict.test.mjs`、`tests/session-visibility.test.mjs`。
   - 先写：必填/祖先/路径/脏目录/空 diff/重复 pending；requestId/verdict 绑定；needs_revision 不 prompt master；pass 需要合并写收件箱；reject blocked+收件箱；after-verdict 归档；brief 失败回滚。
   - 证据：`node --test tests/review-request.test.mjs tests/review-verdict.test.mjs tests/session-visibility.test.mjs`；`npm run typecheck`。
4. **M10.4 — 合并、handoff、status、lifecycle 与 persona**
   - 范围：`src/checkout-tools.ts` 的 `cowork_checkout_merge(workItemId|threadId)`、保护分支/串行/冲突/清理；`src/topic-tools.ts` 的 `cowork_handoff(blocked|done)` + 收件箱；`src/project-tools.ts` 的 status 去兼容重放 + workItems/reviews 摘要 + 真实 active 计数；`src/tool-runtime.ts` 的 `evaluateProjectLifecycle(activeWorkItemsOf)`；`src/presets.ts` persona；`src/tools.ts` 15 工具顺序；`tests/project-tools.test.mjs`、`tests/topic-tools.test.mjs`、`tests/dev-gate.test.mjs`、`tests/source-budget.test.mjs`、`tests/api.test.mjs`、`tests/presets.test.mjs` 适配。
   - 先写：workItemId 合并门禁/同 head/保护分支/冲突保留/成功清理；handoff 状态与收件箱；status 字段与无兼容重放；15 工具顺序；KI-18/24/25 收口断言。
   - 证据：定向测试 + `npm test`；`npm run typecheck`/`build`/`check`。
5. **M10.5 — 收口**
   - 证据：`npm test`（≥596 + 新增，0 fail/0 skip）、`npm run typecheck`、`npm run build`、`npm run check` 全绿；记录各 exit code、测试计数、`src/tools.ts`/`src/store.ts` 字节。
   - 记录：`review-request-model`（proposed/feature）与 `parallel-isolation-and-merge`（proposed/architecture）迁到 implemented 并按骨架重写；`topic-session-model`/`topic-store-v2` 当时保持 proposed（M11/M12 收口；M12 已迁 implemented 并按骨架重写）；写 `docs/M10_RESULT.md`（新文件，不覆盖本交接）与更新本交接为已交付（或按 M8/M9 的做法保留启动版 + 结果文件）；更新 `KNOWN_ISSUES`（KI-18 剩余 M11/M12、KI-24/25 关闭或改归属）；`publish.json` 分类；`npm run check` 通过。
   - 停：四命令全绿、review pass 后停下等确认，不进入 M11。

## 验证与证据

- 每条实现的最小证据：`node --test <本阶段测试文件>` + `npm run typecheck`；阶段收口：`npm test` + `npm run typecheck` + `npm run build` + `npm run check`，逐条记录 exit code，不只说「通过」。
- 测试只用 `os.tmpdir()` 夹具，不读写真实 `.dsh-cowork/`；不用固定 `sleep` 当就绪判据；等待用带截止时间的轮询或事件。git 行为用 fake `GitRunner` 或一次性临时仓库，不依赖本机用户配置。
- 真实宿主 E2E 与真实数据迁移仍归 M12（KI-22）；M10 的评审/合并行为若只在 fake host 上验证，明确写「未在真实宿主验证」。
- 审查：实现者 ≠ 验证者 ≠ 最终审查者；verification 独立复跑，review 在隔离副本执行并自己跑命令（M9 教训：无 bash 的 reviewer 只能声明静态审查）；队长独立复跑命令并核对 diff，不转述成员结论。
- AgentTeams 交付：integration-ready → verification → review → 一次性批量修复 → final integration → **delivery**（merge/push/PR + 最终 HEAD/artifact/PR URL）；review 通过前不进入 delivery（见 [docs/AGENTTEAM.md](../AGENTTEAM.md)）。

## 影响面（派单前先扫）

- **新文件**：`src/review-request.ts`、`src/work-item.ts`、`src/session-visibility.ts`；`tests/review-request.test.mjs`、`tests/work-item.test.mjs`、`tests/session-visibility.test.mjs`。
- **重写/改动**：`src/review.ts`（删除/迁移）、`src/review-tools.ts`、`src/checkout.ts`、`src/checkout-tools.ts`、`src/work-item.ts`、`src/tool-runtime.ts`、`src/tool-model.ts`、`src/project-tools.ts`、`src/topic-tools.ts`、`src/presets.ts`、`src/index.ts`、`src/tools.ts`；`tests/review.test.mjs`/`review-verdict.test.mjs`/`checkout.test.mjs`/`project-tools.test.mjs`/`topic-tools.test.mjs`/`dev-gate.test.mjs`/`source-budget.test.mjs`/`api.test.mjs`/`presets.test.mjs`/`tools-init.test.mjs`（如 init 依赖不变则不动）。
- **legacy dev 面**：`src/m2-e2e.ts`/`src/m3-e2e.ts` 仍写旧 thread/review 流程，但只是 dev 面且测试仅检查 runner 源码文本；M10 不改它们，在 KNOWN_ISSUES 注明由 M12 真实 E2E 取代，不要为它们保留旧工具语义。
- **预算**：`src/store.ts` 余量约 562 B，评审文件 I/O 走 `store.readText`/`writeTextAtomic`/`withWriteLock` + `tool-runtime` 的 list 端口，不把业务写回 store；`src/tools.ts` ≤49,152 B、`src/**/*.ts` <51,200 B。

## 陷阱

- **旧 review 文件与新请求文件同目录。** 新代码不调用 `store.listReviews`/`latestReviews`/`writeReview`；`api.ts` 只读旧 `latestReviewPath`，M10 后评审卡可能暂时为空，M11 切到请求文件。不要为了让旧 reader 能读而改文件名/目录（见 M10 提案的 alternatives）。
- **`review.ts` 删除是原子改动。** `presets.ts`/`checkout-tools.ts`/`store.ts` 的 import、`tests/review.test.mjs` 必须同一提交处理；不要留下两套 verdict 模型。
- **`awaiting_review` 与 handoff 兼容窗口。** 删除后旧 v1/v2 文档里的 `awaitingReview` 旧值不迁移；新写入覆盖或保持只读；`project_status` 不再跑 `reconcileIndex`/`replayPendingHandoffs`；KI-25 的“旧文件只读”要写清。
- **读取点工作项计数。** `active` 与 `reviewing` 都算进行中；只数 `active` 会让评审中的主题被自动 resolved（无撤销）。`evaluateProjectLifecycle` 的 `activeWorkItemsOf` 必须在锁内重读的文档上计算。
- **合并目标。** 只允许合入仓库当前分支，且 `main`/`master` 保护分支必须拒绝（`checkout/protected-branch`）；`main` 由人收口。detached HEAD/无 remote 时以名单兜底。
- **reviewer 回收。** 创建后立即归档会让 turn `blocked`；必须 after-verdict。归档失败保留会话并记录，不假装成功。
- **串行合并。** 进程级队列只保证同一 DSH 实例；不要把“串行”误解为跨进程锁。
- **工具面与测试。** 15 个工具（新增 work_item_create）、角色变化（review_request 仅 topic、verdict 仅 reviewer、merge 仅 master）、`allowUnreviewed` 移除都是破坏性变更；`dev-gate`/`source-budget`/`project-tools` 的注册顺序断言必须同一批更新。
- **文档。** `.dsh-cowork` 禁 `.md`；新文件必须在 `docs/publish.json` 分类；记录迁移后跑 `npm run check`；M10_RESULT 不要覆盖 M10_HANDOFF。

## 完成定义

- **M10（本阶段）**：评审请求按最小字段校验（purpose/base/head/path/verification），base 是 head 祖先、路径在仓库或工作项目录、工作区干净、范围内有改动、无重复 pending；请求文件 `<topicId>-<requestId>.json`；每次请求新建 reviewer、brief 含范围/证据/上一轮，失败回滚；verdict 绑定 requestId + reviewerSessionId、一个请求一次 verdict、`needs_revision` 只回主题、`pass` 需要合并写 merge-needed、`reject` blocked + review-reject、verdict 后归档；`cowork_work_item_create` 创建 `.dsh-cowork/workitems/<id>` 与 `cowork/<id>` 并写 v2 记录；`cowork_checkout_merge(workItemId)` 要求同一 head 的 pass、工作区干净、保护分支拒绝、串行、冲突保留、成功清理、`main` 不动；`cowork_handoff` 只剩 blocked/done 并接收件箱；`cowork_project_status` 去 handoff 兼容重放、接真实 active 工作项计数、有界；15 工具顺序与角色按 PLAN §5.7；四命令全绿；`src/tools.ts` ≤49,152 B、`src/**/*.ts` <51,200 B、`src/store.ts` 不越过 49,152 B；无 M11/M12 模块；`review-request`/`parallel-isolation` 迁 implemented；`docs/M10_RESULT.md`、`docs/M10_HANDOFF.md`、KNOWN_ISSUES 更新；`npm run check` 通过；阶段结束停下等确认。
- **不做**：面板/API v2、会话可见性 UI、真实 E2E、真实数据迁移、0.2.0 发布、worktree 适配器（都不属于 M10，分别归 M11/M12）。

## 回滚

- **代码**：按 M10 提交序列 `git revert`。M10 会删除 `review.ts`、改 review 文件格式、新增 workItems；回滚后 M9 代码可以读 v2 索引（`workItems` 字段本来就有，M9 忽略），但**旧代码的 `store.listReviews` 会尝试按旧 schema 读新请求文件并失败**。回滚前必须把 M10 写的新格式 `reviews/<topicId>-<requestId>.json` 移出 `reviews/`（或恢复 `.dsh-cowork` 备份），再 revert；旧 review 文件保持只读。
- **数据**：M10 只写 `topics` 的 review 字段、`workItems`、activity/inbox 与新的 review 文件；不迁移旧数据，不删除旧 handoff/review 文件。清理 `.dsh-cowork/workitems/` 下的 clone 与索引 `workItems` 条目按 M10_RESULT 的回滚说明做。
- **文档/记录**：`git revert` 对应文档提交；两份记录回到 `proposed/`。不要 force-push。

## 未验证

- 真实宿主 E2E 全链路（评审请求→reviewer→verdict→收件箱/主题→工作项→合并）归 M12（KI-22）；M10 的 fake-host 通过不等于真机可用。
- 真实 clone 成本/磁盘（KI-1）、跨进程合并串行、真实 base/head 竞态、reviewer 只读约定（KI-15）没有新增证据。
- `session-visibility` 的“隐藏”依赖宿主没有会话过滤接口这一事实；live reviewer 在左侧栏可见是已知上限，M11 面板过滤、M12 真机验证。
- 真实旧 v1/v2 数据（带 `awaitingReview`/legacy review 指针/旧 handoff 文件）在 M10 代码下的读取与回滚演练未跑（M12）。
- 模型/评审质量与成本未测量；M10 不新增模型调用（reviewer 是独立会话，成本属真实使用观察）。

## 指针

- M9 交付结果与证据：[M9_RESULT.md](M9_RESULT.md)。
- M9 启动交接（历史）：[M9_HANDOFF.md](M9_HANDOFF.md)。
- M10 执行提案：[2026-11-08-m10-review-request-workitems-plan.md](../../.agents/notes/implemented/architecture/2026-11-08-m10-review-request-workitems-plan.md)。
- 评审规则（M10.5 迁 implemented）：[2026-11-07-review-request-model.md](../../.agents/notes/implemented/feature/2026-11-07-review-request-model.md)。
- 工作项与合并（M10.5 迁 implemented）：[2026-11-07-parallel-isolation-and-merge.md](../../.agents/notes/implemented/architecture/2026-11-07-parallel-isolation-and-merge.md)。
- 角色模型（implemented）：[2026-11-07-topic-session-model.md](../../.agents/notes/implemented/architecture/2026-11-07-topic-session-model.md)。
- 索引与文件布局（implemented）：[2026-11-07-topic-store-v2.md](../../.agents/notes/implemented/architecture/2026-11-07-topic-store-v2.md)。
- M9 执行记录与三层路由（implemented）：[M9 执行记录](../../.agents/notes/implemented/architecture/2026-11-08-m9-routing-tools-presets-plan.md)、[三层路由](../../.agents/notes/implemented/feature/2026-11-07-three-layer-routing.md)。
- 遗留问题与归属：[KNOWN_ISSUES.md](../KNOWN_ISSUES.md)。
