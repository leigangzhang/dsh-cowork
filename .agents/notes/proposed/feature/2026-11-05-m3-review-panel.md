# Proposal: M3 review 门禁与只读面板（预案）

Status: proposed
Date: 2026-11-05
Class: feature

## Problem

M2 交付了记忆与 thread checkout 隔离，但「谁验收 thread」仍是 master 自己：master 收到 handoff 后自行判断、自行合并，实现者与验收者是同一方，PLAN §5.7 与 §6 M3 要求的独立 review 会话、`needs_revision` 退回、以及侧栏「项目 → thread」视图都还不存在。thread 又是用户可直接打开、可交互的普通会话（[PLAN](../../../../docs/PLAN.md) §1/§2），没有面板时用户只能翻会话与手读 JSON。面板设计已有独立提案（[cowork-panel](../feature/2026-11-05-cowork-panel.md)）、侦察（[PANEL_RECON](../../../../docs/PANEL_RECON.md)）与交接（[PANEL_HANDOFF](../../../../docs/PANEL_HANDOFF.md)）；本提案只定 M3 这一阶段的**组合范围与相互约束**，不复制面板细节。

**本提案是预案**：M2 收口修复（[M2 修复提案](../bug-fix/2026-11-05-m2-follow-up-fixes.md)）会改变合并 teardown 语义与 E2E 证据；下列标「待 M2 修复后定」的决策必须在 M2 收口后再定稿。

## Proposal

**review 门禁（host）**

- 新增 `cowork_review_request(threadId)`（master 或 thread 调用，角色门沿用 `check-model`）：校验 thread 有 handoff 且状态为 `awaiting_review`，创建独立 review 会话（普通 `sessionController.create`，preset `cowork-reviewer`），cwd 用主仓库（不是 clone；reviewer 需要看合并后的真实仓库与分支差异），把 handoff、`changedPaths`、verification 命令与 checkout 分支写进首条 prompt。
- 新增 `cowork-review_verdict(threadId, verdict, findings?, evidence?)`（仅 review 会话可调）：`pass | needs_revision | reject`；写入 `<repo>/.dsh-cowork/reviews/<threadId>-<timestamp>.json`，索引追加 `reviewStatus` / `reviewedAt` / `reviewerSessionId`（数据模型扩展，`version` 仍为 1）。
- 状态机：`awaiting_review` → review → `done`（pass）或退回 `active`（needs_revision，findings 作为 prompt 投给原 thread）；`reject` 保持 `blocked`。**实现者不得自审**：review 会话 id 与 thread id 不同，且 `cowork_review_verdict` 拒绝 thread 自己调用。
- 合并前置（待 M2 修复后定）：M3 拟把 `cowork_checkout_merge` 的前置从 `{awaiting_review, done}` 收紧为「review pass 或显式用户覆盖」，避免绕过门禁合并。

**面板（客户端，v0 只读）**

- 面板设计、布局、数据契约以 [cowork-panel](../feature/2026-11-05-cowork-panel.md) 为准；M3 只在其 `/api/overview`、`/api/handoff` 上**追加 review 字段**（`reviewStatus`、`reviewedAt`、`reviewerSessionId`、最近 verdict 摘要），未知字段忽略，不改既有字段语义。
- 面板入口与线程树、状态徽章、handoff 预览沿用面板提案的验收；M3 追加：review 状态徽章、pass/needs_revision 的可读展示、跳转 review 会话。
- v0 仍只读：不在面板发起 review，也不写 verdict。

**preset 与工具面**

- 新增 `cowork-reviewer` preset：persona 要求独立、只读源码与证据、运行 verification 命令、不修改实现文件；工具面 = read/glob/grep/bash + `cowork_project_status`/`cowork_thread_list`/`cowork_review_verdict`，不给写实现文件的工具（与 M1 master 的软限制不同，这里用工具面硬限制）。
- 工具计数：M1 六个 + M2 三个 + `cowork_review_request`/`cowork_review_verdict` = 11；`cowork_project_status` 返回 review 摘要。

## Alternatives considered

**master 自己 review。** 否决：实现者与验收者同一方，违反 PLAN §5.7；M2 已证明 master 会接受 fixture 内容，独立会话才有多视角。

**在 thread 内自审。** 否决：thread 有写权限，无法证明它没有改过被审对象；且「改完即审」会绕过分状态机。

**面板作为独立插件交付。** 否决：M4 才做单插件打包；M3 先在同一包内恢复 client 半边，避免两条装配路径。

**跳过面板、只做 review。** 否决：PLAN §6 M3 明确要求侧栏视图；且用户可交互的 thread 没有面板时无法发现阻塞。

**用 AgentTeams 承担 review。** 否决：仓库纪律禁止引入多编排运行时（AGENTS「No multi-orchestrator」）；只借语义，不借包。

## Acceptance criteria

- [M3A1] `cowork_review_request` 为 `awaiting_review` 的 thread 创建独立 review 会话，首条 prompt 含 handoff、changedPaths、verification 与 checkout 分支 — `source`
- [M3A2] `cowork_review_verdict` 只接受 review 会话调用，写入 reviews 文件与索引；thread 自审被拒绝 — `source`, `tests`
- [M3A3] verdict 路由：pass → thread `done`；needs_revision → 退回 `active` 并把 findings 投递给原 thread；reject → `blocked` — `source`, `tests`
- [M3A4] 合并前置与 review 结果一致（待 M2 修复后定稿）：未 pass 的 thread 不能被 master 合并，除非显式覆盖 — `source`
- [M3A5] `cowork-reviewer` preset 可创建、工具面不含写实现文件的工具，真实宿主会话能跑 verification 命令 — `source`
- [M3A6] 面板 `/api/overview`、`/api/handoff` 追加 review 字段且只读；未知字段忽略；review 状态在三档宽度与七状态可复现 — `source`, `tests`
- [M3A7] 真实宿主 E2E 覆盖：请求 review → pass 合并 → 再建 thread → needs_revision 退回 → 修复后复审 pass；证据含 sessionId、verdict 文件与索引快照 — `tests`
- [M3A8] 文档与发布：M3 结果、面板结果与限制入 docs，`docs/publish.json` 分类，M3 交接更新，`npm run check` 通过 — `publication`

## Risks

- 客户端构建链自 M0 移除，右侧栏 slot/HMR/宽度未验证（[PANEL_RECON](../../../../docs/PANEL_RECON.md)）→ 先做客户端能力探针，失败就只交付 host 与 review，不硬做 UI。
- review 会话的模型成本与延迟 → 一次 review 一轮，不自动多轮；超时与 verdict 缺失按失败处理，不静默放行。
- verdict 权威性：谁有资格 pass → 只有 review 会话；M3 v0 不允许 master 覆盖 verdict，用户覆盖作为显式操作留待后续。
- M2 的合并 teardown 与 checkout 生命周期会改动（见修复提案）→ 本提案中「合并前置」与「reviewer 看哪里」必须在 M2 收口后复核。
- 运行时 preset 重启消失（M4）→ review 会话的 preset 同样受此限制；M3 E2E 不承诺跨重启。
- 并发写者：面板与 review 都会改索引结构，改动只增字段；面板对未知字段忽略。

## Delivery stages

1. P0 探针：客户端构建与右侧栏 tab 挂载；review 会话创建/提示/verdict 写回（最小闭环）。
2. P1 host review 门禁：工具、存储、状态路由、角色门 + 单测。
3. P2 面板 API 与 UI：在面板提案的骨架上追加 review 字段与状态。
4. P3 真实宿主 E2E（含两轮 review 与退回）与截图。
5. P4 文档：M3 结果、限制、提案迁移；面板提案同步更新。
