# M2 修复交接文档

- 状态：**已完成**（2026-11-05）。F1–F8 在最终字节上全绿，真实宿主 E2E 11/11 步通过；本文件保留为执行记录。修复决策与逐项证据归 [implemented bug-fix note](../../.agents/notes/implemented/bug-fix/2026-11-05-m2-follow-up-fixes.md)，遗留（不修）归 [KNOWN_ISSUES](../KNOWN_ISSUES.md)，已交付行为与证据归 [M2 结果](M2_RESULT.md)。
- 适用：接手 M2 之后的维护者，或开始 M3 的 agent（见 [M3 交接](M3_HANDOFF.md)）。
- 起点：交接编写时 `main` 为 `44ec861`；实际执行时 `main` 已前进到 `234c084`（包含后续面板合并），远程也没有旧的 `feat/m2-memory-checkout`。因此本轮从最新 `main@234c084` 建本地审阅分支 `fix/m2-closeout`，以**追加提交**交付；未重写历史，也未推 `main`。

## 先读什么

1. [AGENTS.md](../../AGENTS.md) 的纪律与命令。
2. [M2 收口修复 note](../../.agents/notes/implemented/bug-fix/2026-11-05-m2-follow-up-fixes.md)：修复决策、验收 id、测试证据与结果。
3. [M2 结果](M2_RESULT.md) 与 [M2-P0 结果](M2_PROBE_RESULT.md)：已交付行为、E2E 证据与环境事实，不要重复验证。
4. [KNOWN_ISSUES](../KNOWN_ISSUES.md)：哪些问题明确**不修**，不要在本轮顺手处理。
5. [.agents/notes/README.md](../../.agents/notes/README.md)：修复完成后提案迁入 `implemented/` 的规则。

## 现在的事实

- 工具面 9 个（M1 六个 + `cowork_memory_write` / `cowork_memory_search` / `cowork_checkout_merge`）；`cowork_route` / `cowork_thread_create` 有 `isolated?: boolean`；`cowork_review_request` 属 M3。
- 隔离：每 thread 一个 `git clone --local`，路径 `<repo>/.dsh-cowork/threads/<threadId>`、分支 `cowork/<threadId>`，会话 cwd = clone。
- 记忆：agent 作用域的 system prompt 段 `cowork:memory`（order 900、`interpolate:false`、按 assembly 重算）。
- E2E：`POST /dsh-cowork/e2e/m2/run` 启动，`GET /dsh-cowork/e2e/m2/status?runId=` 轮询；证据 `.dsh-cowork/e2e/M2_E2E.json`。
- 门禁：`npm run check`、`npm test`、`npm run typecheck`、`npm run build`；文档/契约改动只跑前两个。

## 执行顺序

1. **R1 / R2 / R3 并行**，各用独立 worktree（`worktree_create`，路径写进任务契约），写范围按三条流：R1 = `src/tools.ts` + `src/session-slice.ts` + `src/memory.ts` + `src/checkout-teardown.ts`；R2 = `src/checkout.ts` + `src/m2-e2e.ts` + `src/m2-e2e-support.ts`；R3 = `src/memory-prompt.ts` + `docs/PLAN.md`。`docs/handoff/PANEL_HANDOFF.md` 实际已使用 `checkoutPath`，本轮无需改动。
2. **队长串行合并** worktree，再在主树复验四条命令。
3. **E2E 重跑**：先完成 R2 的驱动拆分与脱敏，再构建并跑一次；新增的「模型复述约束」步骤必须通过，证据以最终字节为准。
4. **最终复审**：独立审查者绑定最终字节（代码 + 证据 + 文档），无 blocker/high 才算通过。
5. **文档**：提案迁入 `.agents/notes/implemented/bug-fix/`（present tense），更新 `M2_RESULT` 限制段（改为链接 KNOWN_ISSUES 与本提案）、`M2_HANDOFF`（标注收口）、`KNOWN_ISSUES`（删除已修项，保留 KI 条目）。
6. **推送**：追加提交到审阅分支 `fix/m2-closeout` 并推送该分支；不 force、不改写已推送历史，不推 `main`（`main` 推送需用户明确授权）。

## 验证与证据

- 每条修复流：`npm test`（模块单测必须覆盖新行为）+ `npm run typecheck`。
- 合并后：`npm test`、`npm run typecheck`、`npm run build`、`npm run check` 全绿；构建后 `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/dsh-cowork/probe/health` 应为 200。
- E2E：`POST` 后轮询到终态；核对 10+1 步全过、证据 JSON 合法、`git status` 为空、临时 fixture 已清理。
- 审查：实现者 ≠ 验证者 ≠ 最终审查者；审查者读源码与原始证据，不只看报告。

## 陷阱

- **字节绑定**：拆分驱动或改任何 `src/` 后，旧 E2E 证据失效；先改完再跑，不要先跑再改。
- **worktree 里没有 `node_modules`**：模块级 `node --test` 可以跑；项目级 `npm run typecheck` 要在主树跑。
- **完成闸门只看 inScope**：新增/改写测试文件必须在任务 inScope 里；入口文件（如 `src/index.ts`）被两个任务共享时，必须显式串行依赖，否则闸门拒绝。
- **medium 必须在阶段内修复**：审查门禁不接受「medium 记入文档后 pass」；本轮的门禁规则以本文件为准。
- **并发写者**：动手前 `git fetch` 并确认 `main` 没有未合并的他人改动；`docs/handoff/PANEL_HANDOFF.md` 属另一会话，实际已使用 `checkoutPath`，本轮不要顺手重写。
- **推送**：外层仓库有他人同时在用；只推审阅分支，不推 `main`（`main` 推送需用户明确授权）。
- **E2E hostname**：写证据前脱敏，文档与提交不得出现机器标识。

## 完成定义

- 收口 note 的 F1–F8 全部有证据；真实宿主 E2E run `m2-a91984c0-4840-4bc0-bcd1-74fe22d0e679` 11/11 步通过；`npm test` 227/227、`npm run typecheck`、`npm run build`、`npm run check` 均在最终字节上 exit 0。
- 收口 note 位于 `implemented/bug-fix/`，`npm run check` 通过；`KNOWN_ISSUES` 只保留明确不修的条目。
- 审阅分支 `fix/m2-closeout` 已推送；`main` 保持原样（其后续面板提交不在本轮授权范围内）。

## 回滚

- 代码：按提交 revert 本轮修复提交；已交付的 M2 提交不动。
- 运行时：`dev_uninject_plugin dsh-cowork` 移除注入；记忆 section 由 dispose 释放。
- 数据：只删本轮创建的 clone/workspace；`.dsh-cowork/` 既有证据保留。
