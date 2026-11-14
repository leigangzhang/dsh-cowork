# 工具 → 领域模块执行交接

- 状态：**启动交接（2026-11-13）**。本文件写给第二个新会话，用于执行 `tool-domain-modules` 提案；**只有 guardrails 已落地后才能开始**。它不重抄提案内容，执行细节以提案与 guardrails 交接为准。
- 适用：接手目录/模块迁移的 agent。范围：前置条件、启动、阶段顺序、完成定义、回滚与禁止事项。
- 提案：[2026-11-13-tool-domain-modules.md](../../.agents/notes/implemented/architecture/2026-11-13-tool-domain-modules.md)（commit `b3146c8`；本分支 `agent/next-work-handoffs` 已包含），状态仍是 proposed。
- 前置交接：[CODE_HEALTH_GUARDRAILS_HANDOFF.md](CODE_HEALTH_GUARDRAILS_HANDOFF.md)。

## 前置条件（缺一不可）

1. **guardrails 已合并到 main**：递归测试发现 + 子目录负例、干净 worktree 的 `npm run check`、import 方向/预算守卫已经存在。若这些还不存在，停止本交接，先回去执行 guardrails。
2. **PR #33 已合并或已明确排除**：提案的目标树引用 `config.ts`、`dev-surfaces.ts`、`delivery.ts`、`api-types.ts`、`m12-e2e-*` 等 post-#33 文件。若 #33 仍 OPEN，先决定“先合 #33”或“显式排除其新增模块”；不要一边迁移一边让 #33 改同一批路径。
3. **当前 main 是迁移基线**：不要用本交接分支的旧 `a9172e1` 直接迁移；先 `git fetch`，从当前 `origin/main` 建工作分支，并记录 HEAD/diff sha。
4. 提案的 **Stage 0** 必须完成：每个 `src`/`tests`/`scripts` 文件的去向、工具→领域映射、测试发现、公共面清单都已登记。

## 先读什么

1. [AGENTS.md](../../AGENTS.md)、[docs/agent-teams.md](../agent-teams.md)、[docs/testing.md](../testing.md)：纪律、门禁、证据。
2. [tool-domain-modules 提案](../../.agents/notes/implemented/architecture/2026-11-13-tool-domain-modules.md)：目标树、工具→领域映射、import 方向、A1–A10 验收、风险。
3. [guardrails 交接](CODE_HEALTH_GUARDRAILS_HANDOFF.md)：哪些门禁应当已经存在。
4. [handoff 索引](README.md) 与 [package.json](../../package.json)、[scripts/test-coverage.mjs](../../scripts/evidence/test-coverage.mjs)：现有命令入口。

## 启动步骤

1. 运行前置检查：确认递归测试发现、干净 worktree check、architecture test/预算守卫存在；确认 #33 状态；跑 `npm run check` 与 `npm test` 基线。
2. 从当前 `origin/main` 创建 `agent/tool-domain-modules`；不要直接在 `main` 上搬目录。
3. 记录基线 HEAD、`git diff --binary base..HEAD | shasum -a 256`、`git status --porcelain`。
4. 按提案 Stage 0→5 串行执行。**每个 Stage 单独 commit/PR**；不把 80+ 文件压成一个 diff。
5. 第一个 Stage（映射）只产出目标树/去向/测试发现确认，不移动代码。

## 阶段顺序

- **Stage 0 — 映射与测试发现**：登记每个文件去向；确认 guardrails 的递归发现与子目录负例已存在；确认 22 工具/10 路由/3 preset/3 exports 的公共面快照。
- **Stage 1 — store 与 platform**：移动持久化与宿主适配，机械更新 import；跑 `npm test` 与 `npm run check`。不要先动 tools/domains。
- **Stage 2 — domains**：把纯规则落目录；扩展 `tests/architecture.test.mjs` 的 import 方向/无环/工具→领域断言；跑领域测试。
- **Stage 3 — tools 与 tests**：工具族模块、测试镜像、public-surface 更新；`npm test` + coverage；工具名/顺序/路由/preset 不变。
- **Stage 4 — scripts 与命令**：`build/`、`evidence/`、`review/` 分组；`package.json`、`tools/workflow.json`、[docs/testing.md](../testing.md) 同步；build + host-smoke。
- **Stage 5 — 清理与文档**：删旧路径；更新当前文档链接；历史 handoff/notes 只改链接目标，不改结论；`npm run check` 全绿。

每一阶段结束都必须有：测试/检查结果、changed paths、identity（HEAD/diff sha/porcelain）；不带着红色阶段进入下一阶段。

## 完成定义

- 提案 A1–A10 全部有证据：目标树/去向、import 方向测试、公共面不变、递归测试发现、scripts/命令同步、build/host-smoke、50 KiB、文档链接、分阶段回滚。
- `npm test`、coverage、typecheck、build、host-smoke、`npm run check` 全绿；测试数与 public surface 与迁移前一致。
- 提案从 `proposed/` 移到 `implemented/` 并改写为 Decision/Consequences/Testing；更新 [handoff 索引](README.md) 与 `docs/publish.json`（如新增文件需要）。
- 交付：分支 push + PR；PR 描述按 `pr-description` 写，Evidence 绑定最终 HEAD/diff sha；不自动合并。

## 禁止事项

- 不在 guardrails 未落地时开始；不在 #33 未决时并发改同一批路径。
- 不先移动测试再改递归发现；不把测试放进子目录却仍只跑顶层 glob。
- 不做一次性大迁移；不用 `index.ts` barrel 绕过 50 KiB。
- 不改工具名/注册顺序/路由/preset/包入口；不改存储格式或行为。
- 不重写历史 handoff/plan 的结论；只改失效链接目标。
- 不靠 allowlist/跳过测试让门禁变绿；不自动合并 PR。

## 回滚

- 每个 Stage 单独 commit/PR；回滚按 Stage 逆序 `git revert`，或关闭 PR/删除工作分支。
- 移动只改路径与 import；回滚不涉及数据迁移。若 Stage 4 改了 `package.json`/workflow，回滚时同步恢复命令入口。
- 迁移分支与 #33 的冲突在合并前解决；不要用 force-push 改写已审查历史。
