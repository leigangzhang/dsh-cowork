# M2 交接文档

- 状态：M2 已交付并收口。F1–F8 在最终字节上全绿，收口决策与证据见 [implemented bug-fix note](../../../.agents/notes/implemented/bug-fix/2026-11-05-m2-follow-up-fixes.md) 与 [M2 修复交接](M2_FIX_HANDOFF.md)；不修项见 [KNOWN_ISSUES](../../KNOWN_ISSUES.md)。交付面与证据在 [M2 结果](../results/M2_RESULT.md)，调研结论在 [M2-P0 结果](../results/M2_PROBE_RESULT.md)，M2 功能决策在 [implemented feature note](../../../.agents/notes/implemented/feature/2026-11-05-m2-memory-checkout.md)。
- 适用：接手 M2 之后的维护者，或开始 M3（review 门禁 + 客户端面板）的 agent。
- 事实源：[PLAN](../../PLAN.md) §5.5/§5.6/§5.8 与 §6 M2 拥有范围与验收；[M2 结果](../results/M2_RESULT.md) 拥有已交付行为、证据与限制；[M2-P0 结果](../results/M2_PROBE_RESULT.md) 拥有环境事实与原始输出；本文件只拥有“现在从哪开始、哪些坑已踩过、怎样算完成”。

## 先读什么

1. [AGENTS.md](../../../AGENTS.md) 的纪律与命令。
2. [PLAN](../../PLAN.md) §5.5 memory、§5.6 thread checkout、§5.8 工具面、§6 M2。
3. [M2 结果](../results/M2_RESULT.md)：9 个工具、记忆注入、状态机、E2E 证据、限制与回滚。
4. [M2-P0 结果](../results/M2_PROBE_RESULT.md)：会话绑定、记忆注入 seam、worktree/EPERM、clone 方案与合并链路。
5. [M1 结果](../results/M1_RESULT.md) 与 [M0 探针](../results/M0_PROBE_RESULT.md)：已证 API，不要重复验证。
6. [M2 修复交接](M2_FIX_HANDOFF.md) 与 [KNOWN_ISSUES](../../KNOWN_ISSUES.md)：已完成的收口记录与明确不修项。
7. [.agents/notes/README.md](../../../.agents/notes/README.md)：决策记录的骨架与迁移规则。

## 现在的事实

- 仓库：`/Users/ray/Workspace/dsh-cowork`；`main` 已包含 M2。宿主：DSH Desktop 2.0.18 / 运行时 0.2.1-rc.2，web profile `http://127.0.0.1:3080`；插件以 `dev_inject_plugin` 注入。
- 工具面 9 个：M1 六个 + `cowork_memory_write`、`cowork_memory_search`、`cowork_checkout_merge`。`cowork_route` / `cowork_thread_create` 增加 `isolated?: boolean`。`cowork_review_request` 仍属 M3。
- 隔离采用 F 方案（用户确认）：每 thread 一个 `git clone --local`，路径 `<repo>/.dsh-cowork/threads/<threadId>`、分支 `cowork/<threadId>`、会话 cwd = clone；不是 `git worktree`。
- 记忆在 agent 作用域的 system prompt 段落 `cowork:memory`（order 900、`interpolate:false`、按轮求值）注入，覆盖 master 与 thread；数据在 `<repo>/.dsh-cowork/memory/*.md`。
- preset 仍是运行时注册，重启即消失（M4 解决）；构建 `npm run build` 会热重载并清空进程内状态，磁盘文件仍在。
- 检查：最终字节上 `npm test`（227 用例）、`npm run check`、`npm run typecheck`、`npm run build` 均 exit 0；真实宿主 E2E 11/11 步通过。驱动路由 `POST /dsh-cowork/e2e/m2/run` + `GET .../status?runId=`。
- 数据：`.dsh-cowork/` 下已有 `index.json`、`handoffs/`、`memory/`、`threads/`、`probe/`、`e2e/`；**不要删除**已有证据。
- 探针与 E2E 设施是临时证据代码：M0/S0 探针与 `src/m2-e2e.ts` + `src/m2-e2e-support.ts` 留在 `src/`，清理另开交付。

## 已决问题（原 M2 未决清单）

1. **thread 如何落到隔离目录**：F 方案，clone 作为独立 workspace 建会话；`cwd + attachSession` 挂回仓库 workspace 不可行（attach 要求 cwd 严格相等）。证据：[M2-P0 §1/§5](../results/M2_PROBE_RESULT.md)。
2. **记忆注入时机**：agent 作用域的 system prompt 段落，每次 assembly 重新求值；brief 注入不再是退化路径。证据：[M2-P0 §2](../results/M2_PROBE_RESULT.md)、`tests/memory-prompt.test.mjs`。
3. **合并入口**：只允许 master，且 thread 状态 ∈ `{awaiting_review, done}`；冲突保留 clone、置 `blocked`，thread 解决后重试。证据：[M2 结果 · E2E](../results/M2_RESULT.md)。
4. **merge 后的 thread 状态**：`done` 且 `checkoutPath=null`（与提案早期“状态不变”不同，以实际交付为准）。证据：E2E `finalIndex` 两条线程均 `done`/`null`。
5. **记忆去重/更新**：M2 只追加；去重、更新、删除、压缩已定为 M5 目标（[PLAN](../../PLAN.md) §6），不要顺手加。
6. **是否保留 M0/S0 探针代码**：保留，避免改动已审查的装配面。

## 陷阱（M2 实测）

- **策略前提**：全部结论以 workspace-write 为前提。沙箱可写根 = 会话 cwd + `/tmp` + `os.tmpdir()`；linked worktree 的 git 元数据在 cwd 外，thread 侧 `git add/commit` 报 `index.lock: Operation not permitted`（exitCode 128）。不要试图把 thread 重新绑到 worktree。
- **canonical path**：宿主会 realpath 规范化 cwd（`/tmp` → `/private/tmp`）。索引存 clone 路径前必须用宿主返回的路径；清理 workspace 要在删 clone **之前** `resolveByPath`，否则匹配不到。
- **显式 sessionId**：clone 目录与分支名都来自 `threadId`，所以顺序必须是 `先定 id → clone → workspace → session.create({sessionId, workspaceId})`；宿主对同 id 重复创建是幂等采用。
- **干净判定包含 untracked**：`git status --porcelain` 非空即拒绝 merge；P0 实测 untracked 会让 `worktree remove` 失败，M2 的 merge 前置因此直接拒绝。
- **先订阅、再补注册**：记忆 section 先接 `agent/created` 再遍历 `listAgents()`，否则热重载/后注册场景会漏 agent；dispose 必须释放所有 section disposer，否则热重载后旧 provider 残留。
- **handoff 唤醒竞态**：thread handoff 会 prompt master；构造冲突场景时要在 thread 提交后立刻改主仓，避免 master 抢先合入（E2E 驱动已处理）。
- **merge 已落地后 teardown 失败不可逆**：`cowork_checkout_merge` 仍返回 `ok:true`，失败步骤只进 `cleanupErrors`；不要因为清理错误重试 merge。用 `cowork_project_status` 对照残留现场（修复决策见 [implemented note](../../../.agents/notes/implemented/bug-fix/2026-11-05-m2-follow-up-fixes.md)）。

## 验证与证据

- 文档/契约改动：`npm run check` + `npm test`。
- 源码改动：另加 `npm run typecheck` + `npm run build`；构建后 curl `/dsh-cowork/probe/health` 应为 200。
- 跨会话/跨进程行为：必须跑真实宿主 E2E，不能用同进程 mock 代替；M2 驱动与原始证据在 `.dsh-cowork/e2e/M2_E2E.json`。
- 审查：实现者 ≠ 验证者 ≠ 最终审查者；审查者读源码与原始证据，不只读自述。

## 完成定义

- M2 交付与收口完成：F1–F8 全绿，最终真实宿主 E2E run `m2-a91984c0-4840-4bc0-bcd1-74fe22d0e679` 11/11 步通过（M2A1–M2A8 的证据见 [M2 结果](../results/M2_RESULT.md) 与 [feature note](../../../.agents/notes/implemented/feature/2026-11-05-m2-memory-checkout.md)；收口证据见 [bug-fix note](../../../.agents/notes/implemented/bug-fix/2026-11-05-m2-follow-up-fixes.md)）。
- 后续改动若触碰记忆/checkout：先读 [M2 结果 · 限制](../results/M2_RESULT.md)，不要用单测通过替代真实宿主 E2E。
- 不进入 M3 范围（review 门禁、客户端面板）；不引入第三方协作运行时；不改 `.dsh-cowork/` 已有证据。

## 清理与回滚

- 代码：按提交 revert（`5ace705` → `9db9cbe` → `2a4bdc0`，模块可单独 revert）；文档与 publish 分类在同一提交内成对回退。
- 运行时：`dev_uninject_plugin dsh-cowork` 移除注入；记忆 section 由 `registerMemoryPrompt` 的 dispose 释放。
- 数据：`.dsh-cowork/` 是项目数据，除非确认不要，不要删；clone 只删自己创建且已合并的 `<repo>/.dsh-cowork/threads/<threadId>` 与分支 `cowork/<threadId>`。
