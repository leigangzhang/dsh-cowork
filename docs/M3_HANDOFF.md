# M3 交接文档

- 状态：**预案，可开始**。M2 收口已按 [M2 修复交接](M2_FIX_HANDOFF.md) 完成：F1–F8 有证据，真实宿主 E2E 11/11 步通过，四条命令在最终字节上全绿（见 [M2 结果](M2_RESULT.md)）。
- 适用：接手 M3 的 agent 或人。范围：review 门禁 + 只读面板 + review 状态在面板的呈现。
- 事实源：[PLAN](PLAN.md) §5.7/§5.8/§6 M3 拥有范围与验收；[M3 提案预案](../.agents/notes/proposed/feature/2026-11-05-m3-review-panel.md) 拥有本阶段范围与待定决策；[面板提案](../.agents/notes/proposed/feature/2026-11-05-cowork-panel.md)、[PANEL_RECON](PANEL_RECON.md)、[PANEL_HANDOFF](PANEL_HANDOFF.md) 拥有面板设计与客户端事实；[M2 结果](M2_RESULT.md) 拥有已交付行为；[KNOWN_ISSUES](KNOWN_ISSUES.md) 拥有不修项；本文件只拥有「从哪开始、先验证什么、怎样算完成」。

## 先读什么

1. [AGENTS.md](../AGENTS.md)：纪律、命令、no-multi-orchestrator。
2. [PLAN](PLAN.md) §5.7 review、§5.8 工具面、§6 M3。
3. [M3 提案预案](../.agents/notes/proposed/feature/2026-11-05-m3-review-panel.md)：范围、验收 id、待 M2 修复后定的决策。
4. [M2 结果](M2_RESULT.md)、[M2 修复交接](M2_FIX_HANDOFF.md)、[KNOWN_ISSUES](KNOWN_ISSUES.md)：M2 的真实行为、收口修复、明确不修项。
5. [面板提案](../.agents/notes/proposed/feature/2026-11-05-cowork-panel.md)、[PANEL_RECON](PANEL_RECON.md)、[PANEL_HANDOFF](PANEL_HANDOFF.md)：面板落点、数据契约、客户端构建事实。
6. [M1 结果](M1_RESULT.md)、[M0 探针](M0_PROBE_RESULT.md)：已证 API，不要重复验证。

## 现在的事实

- `main` 从 M2 收口后的提交开始；工具面 9 个（M1 六个 + `cowork_memory_write` / `cowork_memory_search` / `cowork_checkout_merge`），`cowork_route` / `cowork_thread_create` 有 `isolated?: boolean`。
- thread 是用户可直接打开、可交互的普通会话（PLAN §1/§2），隔离为每 thread 一个本地 clone；reviewer 需要看主仓库与分支差异，**不要**把 reviewer 的 cwd 设成 clone。
- client 半边自 M0 移除；面板设计稿与右侧栏事实已在 [PANEL_RECON](PANEL_RECON.md)；仓库当前没有 client 构建链。
- preset 仍是运行时注册（M4 才做持久化）；`npm run build` 热重载会清空进程内状态。
- 检查：`npm run check` / `npm test` / `npm run typecheck` / `npm run build`；真实宿主在 `http://127.0.0.1:3080`。

## 第一步：P0 探针（先做，别写完整面板）

1. **客户端能力探针**：最小 client 注册一个右侧栏 tab + footer action，证明 bundle 被宿主加载、`--dsw-alias-*` 生效、tab 能打开；记录 HMR/重建路径。失败就降级为只交付 host API 与 review，不硬做 UI。
2. **review 会话闭环**：用现有 `sessionController.create` 建独立会话、投递 handoff prompt、验证它能读主仓库、跑 verification 命令、把 verdict 写回（先用手写文件模拟存储）。
3. **面板数据契约**：`/api/overview`、`/api/handoff` 的 loopback 只读 JSON 能返回 review 字段；旧字段语义不变、未知字段忽略。

探针结论与原始输出写进 M3 提案与 `docs/M3_PROBE_RESULT.md`（新增时同步 `docs/publish.json`）；与假设冲突就改提案，不带着假设写实现。

## 实施顺序

1. P1 host review 门禁：`cowork_review_request` / `cowork_review_verdict`、`cowork-reviewer` preset、reviews 存储、状态路由、角色门（含 thread 自审拒绝）+ 单测。
2. P2 面板 API 与 UI：在面板提案的骨架上追加 review 字段、状态徽章、跳转 review 会话；v0 只读。
3. P3 真实宿主 E2E：请求 review → pass → 合并；再建 thread → needs_revision 退回 → 修复 → 复审 pass；证据含 sessionId、verdict 文件、索引快照、面板截图。
4. P4 文档：M3 结果与限制、面板结果、提案迁入 `implemented/`、publish 分类、更新本交接。

**M2 修复后必须复核的决策**（见 M3 提案）：合并前置是否收紧为「review pass 或显式覆盖」、reviewer 看合并前还是合并后、review 会话的 preset 工具面、reviews 存储格式与索引字段。

## 验证与证据

- 每条实现：`npm test` + `npm run typecheck`；装配与构建：加 `npm run build` + health 200。
- 跨会话/跨角色行为：必须真实宿主 E2E，不能用同进程 mock 代替；证据落盘 `.dsh-cowork/e2e/M3_E2E.json`（含 verdict 文件与索引快照）。
- 面板：按 PANEL 提案的七状态与两档宽度截图对照；未验证项如实写进结果文档。
- 审查：实现者 ≠ 验证者 ≠ 最终审查者；review 实现者不得参与自己的 verdict 路径。

## 陷阱

- **client 构建链不存在**：恢复 client 半边要同时改 `package.json` 的 `exports`/`dsh.client`、`tsdown.config.ts`、`scripts/build.sh` 与 `npm run typecheck`；先探针再铺开。
- **右侧栏 API 与版本绑定**：slot 名、宽度公式、公开 token 数量都是宿主版本事实（见 PANEL_RECON），写死会在升级时坏。
- **reviewer 权限**：用工具面硬限制（不给 write/edit），不要只靠 persona；reviewer 需要 bash 跑验证命令，靠 protocol 约束不改文件。
- **verdict 不可自证**：verdict 文件必须由 review 会话写，thread/master 不能代写；工具层拒绝自审。
- **needs_revision 退回**：退回要 prompt 原 thread 并把 findings 带过去，不能只改索引状态。
- **M2 已知限制**：合并 teardown 不是事务、冲突需人工解决、clone 成本与读边界（[KNOWN_ISSUES](KNOWN_ISSUES.md)）——review 流程要覆盖这些失败路径。
- **并发写者**：动手前 `git fetch`；面板与 review 都改索引结构，只增字段、不重排；另一个会话可能在同步推进文档。
- **no-multi-orchestrator**：review 语义借 AgentTeams，但不引入其运行时或子会话机制。

## 完成定义

- M3A1–M3A8 全部有证据；PLAN §6 M3 三条验收全过（独立 review verdict、needs_revision 退回、侧栏项目/thread 树与状态徽章、handoff 预览）。
- 四条命令全绿；真实宿主 E2E 通过；面板七状态与两档宽度可复现。
- M3 结果与限制入 docs；提案迁入 `implemented/` 并保持 current；`docs/publish.json` 分类正确。

## 回滚

- 代码：按提交 revert；client 半边与 host API 分开提交，面板可单独回退。
- 运行时：`dev_uninject_plugin dsh-cowork`；已创建的 review 会话不影响项目数据。
- 数据：reviews 文件与索引字段只增；回滚代码不清数据，旧字段忽略。
