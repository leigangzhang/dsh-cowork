# M2 交接文档

- 适用：在全新会话/上下文中独立实现 M2（项目记忆 + worktree）的 agent 或人。
- 状态：M1 已完成并推送（`6b99de6`）；M2 尚未开始，契约见 [M2 提案](../.agents/notes/proposed/feature/2026-11-05-m2-memory-worktree.md)。
- 事实源：[PLAN](../docs/PLAN.md) §5.5/§5.6 与 §6 M2 拥有范围与验收；[M2 提案](../.agents/notes/proposed/feature/2026-11-05-m2-memory-worktree.md) 拥有模块、数据格式、工具面与验收；[M1 结果](M1_RESULT.md) 拥有已交付的行为与限制；本文件只拥有“怎么开始、先验证什么、怎样算完成”。

## 先读什么

1. [AGENTS.md](../AGENTS.md) 的 M0/M1 纪律、命令、no-multi-orchestrator。
2. [docs/PLAN.md](../docs/PLAN.md) 的 §2.2/§4.3、§5.5 memory、§5.6 worktree、§6 M2。
3. [M2 提案](../.agents/notes/proposed/feature/2026-11-05-m2-memory-worktree.md)：模块边界、`memory/*.md` 格式、四个新工具、worktree 生命周期、P0 待核实项、验收 A1–A8。
4. [docs/M1_RESULT.md](M1_RESULT.md) 与 [docs/M0_PROBE_RESULT.md](M0_PROBE_RESULT.md)：已证的 API 与踩过的坑，不要重复验证。
5. [.agents/notes/README.md](../.agents/notes/README.md)：决策记录骨架与迁移规则。

## 现在的事实

- 仓库：`/Users/ray/Workspace/dsh-cowork`，`main` 已推送到 `6b99de6`；M1 的六个 `cowork_*` 工具、`cowork-master`/`cowork-thread` preset 已可用。
- 实现仍是 host-only；client 半边在 M0 移除、M3 才回来，M2 不要碰 UI。
- preset 是**运行时注册**，重启即消失；M2 不改变这条（持久化属于 M4）。宿主当前处于 `dev_inject_plugin` 注入态。
- 宿主：DSH Desktop 2.0.18 / 运行时 0.2.1-rc.2，web profile `http://127.0.0.1:3080`，仓库 workspaceId `70ec5443-a9e2-4368-9cce-ae06d9babb9e`。
- 构建：`npm run build` 自动从 DSH 源码 checkout（`/Users/ray/Workspace/deepseek-harness`）取类型、从已安装 app 取运行时链接；`npm run build` 会触发注入插件热重载。
- 检查：`npm run check` / `npm test` / `npm run typecheck` / `npm run build` / `npm run check:self-test` 在 M1 收口时全绿（65 tests）。
- 数据：`<repo>/.dsh-cowork/`（gitignored）已有 `index.json`、`handoffs/`、`probe/`、`e2e/`；M2 新增 `memory/` 与 `worktrees/`（后者已在 `.gitignore`）。**不要删除**已有证据。
- 本轮 M1 的 E2E 原始证据在 `.dsh-cowork/e2e/M1_E2E.json`；M0/S0 探针代码仍在 `src/`（临时证据设施，M2 不要顺手清理，避免改动已审查的装配面）。

## M2 目标与非目标

**目标**（对应提案 A1–A8）：`cowork_memory_write/search` 跨 thread 生效；新 thread 能读到项目约束；thread 落到 worktree、合并不污染主工作区；冲突保留 worktree 且索引 `blocked`；四个新工具与真实宿主 E2E；纯模块有单测；文档同步。

**非目标**：review 门禁与客户端面板（M3）、模型辅助记忆整理、向量检索、外部记忆服务（OpenViking 等）、自动冲突解决、远端推送、修改 PLAN 范围。

## 第一步：M2-P0 探针（必须先做）

M2 的最大未知是“thread 如何真正落到 worktree”与“记忆能否进 system prompt”。提案 §“记忆注入策略”“worktree 生命周期”把未知拆成四问，不要跳过直接写实现：

1. **会话 cwd / workspace 绑定**：能否先 `git worktree add`，再 `sessionController.create({cwd: worktreePath})`，并用 `workspace.attachSession(sessionId)` 让它仍出现在 `workspace.sessionIds`/侧栏？还是只能保持 M1 的仓库 cwd、按绝对路径操作 worktree？记录每条路径的真实返回值与失败信息。
2. **记忆注入时机**：preset 作用域里能否注册按 agent 项目根、按轮求值的 prompt 段落（`ctx.systemPrompt.section` 的求值时机、`agent/pre-step` 或其他钩子）？拿不到就按提案退化为 brief 注入 + 工具检索，并在文档写明。
3. **git worktree 行为**：`git worktree add -b`（路径在 `.dsh-cowork/worktrees/<threadId>`、分支 `cowork/<threadId>`）的创建/失败清理；`git merge --no-ff` 成功路径与冲突路径（失败回滚、文件列表、`--abort`）；脏 worktree 拒绝；全部用命令与 exitCode 记录。
4. **记忆可见性**：thread A 写一条约束，新建 thread B 的 brief/检索能否读到；预算截断是否符合提案。

落盘方式：沿用 M0/S0 的模式——临时探针代码单独提交或放在独立 worktree，证据写进提案（若与假设冲突就改提案）与 `docs/M2_PROBE_RESULT.md`（新增时同步 `docs/publish.json`）。探针清单一律给原始 JSON/命令输出，不写“已验证”。

## 实施顺序

按提案 Delivery stages；每阶段独立提交、可回退：

1. **M2-1 memory**：`src/memory.ts` + `tests/memory.test.mjs`（解析、校验、预算截断、检索评分、损伤文件）。
2. **M2-2 worktree**：`src/worktree.ts` + `tests/worktree.test.mjs`（命令构造、错误映射、索引状态、冲突与脏树）。
3. **M2-3 工具与装配**：`src/tools.ts` 四个新工具、`src/presets.ts`/brief 注入、`cowork_project_status` 的 worktree 摘要；六个既有工具行为不变。
4. **M2-4 真实宿主 E2E**：memory 跨 thread、worktree 创建/合并/冲突/重试、角色越权；证据含 sessionId、git 命令输出、索引快照。
5. **M2-5 文档**：M2 结果与限制入 docs、`docs/publish.json` 分类、提案迁入 `implemented/` 并按 note 规则改写。

**并行写建议**：M2-1 与 M2-2 的模块文件互不相交，可分给两个成员并行（用 `worktree_create` 隔离，合并队长独占）；M2-3 依赖二者；E2E 与文档串行。

## 陷阱（M0/M1 实测，按需回看）

- `sessionController.create` 只有传 `workspaceId` 才挂 workspace；`create({cwd})` 的会话不进 `workspace.sessionIds`（M1-A2 依赖它）。P0 必须回答 worktree 模式会不会破坏这一点。
- 会话 header 的 cwd 在创建时决定，没有已知的“改 cwd”API；不要假设能重绑，先探针。
- 运行时 preset 重启消失；`npm run build` 会热重载并清空进程内状态，磁盘文件仍在。
- 原子写用 `withFileLock` + `writeFileAtomic` + 目录 fsync；锁 target 旁边会出现 `<target>.lock`（M1 S1 实测）。
- 索引与 handoff 写入顺序是硬契约（文件 → 索引 → 投递）；M2 改索引时沿用 `ProjectStore`，不要另起一套 writer。
- git 操作用参数数组 + 显式 cwd + 超时；不要拼 shell 字符串，不要 `--force`/rebase 自动解决冲突。
- 工具执行面拿不到 `exec.agent` 时 fail closed 返回 `exec/agent-unavailable`，不猜项目。
- 文档新增/改名必须在 `docs/publish.json` 分类；note 记录标题/头部/章节/criterion id 都有门禁。
- 不要删除 `.dsh-cowork/` 下的既有证据；不要修改 `docs/PLAN.md`；不要修改 `~/.dsh` 下无关配置。

## 验证与证据

- 每个阶段：`npm run check` + `npm test`；source 变更加 `npm run typecheck` + `npm run build`。
- M2 E2E：真实宿主跑提案 A1–A5（memory 跨 thread、brief 注入、worktree 创建、合并、冲突/重试）；跨会话/跨进程断言不得用同进程 mock。
- 证据文档：`docs/M2_RESULT.md`（新增时分类）、探针结论、git 命令原始输出、索引快照、sessionId。
- 审查：实现者 ≠ 验证者 ≠ 最终审查者；审查者读源码与原始证据，不只看自述。

## 未决问题（实现前先确认）

1. P0 的 worktree 会话绑定结论：走 `cwd + attachSession` 还是“仓库 cwd + 绝对路径”？
2. P0 的记忆注入结论：system prompt 每轮注入，还是 brief + 检索？
3. worktree 合并的入口：只允许 master，还是允许 thread 在 `awaiting_review` 时请求？（提案按 master only，若 P0/产品需要再改。）
4. merge 成功后的 thread 状态：提案保持 `awaiting_review`/`done` 不变；review（M3）才置 `done`。若你需要合并即 `done`，先改提案。
5. 记忆去重/更新：M2 只追加；更新与删除留给后续，不要顺手加。
6. 是否保留 M0/S0 探针代码：M2 不动，避免影响已审查的装配面；清理另开交付。

## 完成定义

- 提案 M2A1–M2A8 全部有真实证据；PLAN §6 M2 的四条 E2E 全过。
- `npm run check` / `test` / `typecheck` / `build` / `check:self-test` 全绿。
- M2 结果与限制写入 docs；提案迁移到 `implemented/` 并保持 current。
- 不进入 M3；不引入第三方协作运行时；不修改 `docs/PLAN.md`。

## 清理与回滚

- 代码回退：按提交 revert；M2 的模块与工具是新文件/增量改动。
- 运行时：`dev_uninject_plugin dsh-cowork` 移除注入；`.dsh-cowork/` 是项目数据，除非确认不要，不要删。
- worktree：只删本插件在 `.dsh-cowork/worktrees/` 下创建且已合并的目录；删除前先 `git worktree list` 对照，保留冲突现场交人处理。
