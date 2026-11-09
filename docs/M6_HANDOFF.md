# M6 交接文档

- 状态：**M6 与 M11 可见性决策已完成（2026-11-07）**。7 项宿主探针都有真实宿主证据；7 份 proposed 记录已与结论对齐；用户拍板 M11 采用降级方案 (b)；M7 执行提案已就绪。M6 主体经 PR #10 合并进 `origin/main`（`739f7e9`），本交接在其后补充 M7 执行摘要。团队 `m6-probes` 保留未删。
- 当前事实（M7 收尾）：M7 已落地并终审通过——实现提交 `73d4083`、测试拆分 `a262273`、迁移记录转 implemented `ffd7c7f`、A1 宿主接线与 E2E 索引 v2 兼容 `6cb294c`（均在 `feat/m7-store-v2`，未 push）。A1 的 `archiveSession` 宿主端口已补齐（SessionSlicePorts 透传 → `tools.ts` 单一构造 helper → `index.ts` 的 `createStore`），M7 遗留与归属见 [KNOWN_ISSUES](KNOWN_ISSUES.md)；本文件其余内容保留为 M6 历史记录。
- 适用：接手 V0.2 后续阶段（M7 起）的 agent 或人。范围：M6 的探针结论与证据位置、已定决策、未验证项，以及 M7 的启动方式；不重新论证探针。
- 事实源：[PLAN-V0.2](PLAN-V0.2.md) §3/§5/§6 拥有阶段、架构与验收；[M6 探针结果](M6_PROBE_RESULT.md) 拥有 7 项结论、证据命令与限制；[M11 可见性降级决策](../.agents/notes/implemented/feature/2026-11-07-topic-visibility-fallback.md) 拥有 (b) 的决定、代价与验收；[M7 迁移实施记录](../.agents/notes/implemented/architecture/2026-11-07-store-v2-migration-plan.md) 拥有 M7 的执行顺序、迁移事务与测试先行；[索引 v2 与迁移](../.agents/notes/implemented/architecture/2026-11-07-topic-store-v2.md) 拥有数据模型与六态映射（M12 已迁 implemented）；[面板与会话可见性](../.agents/notes/implemented/feature/2026-11-07-panel-and-session-visibility.md) 拥有面板交互。本文件只拥有「从哪继续、先验证什么、怎样算完成」。

## 交付后状态（2026-11-07）

- **代码/证据基线**：`origin/main` = `739f7e9`；探针提交 `66b5d5c`、决策/交接提交 `2b3ebcd`。M6 没有改 `src/`：`git diff HEAD -- src docs/PLAN.md package.json` 为空；PLAN-V0.2 的可见性修正属于决策提交，不属于探针交付。
- **已交付**：[M6 探针结果](M6_PROBE_RESULT.md)（结论、证据、限制、M7–M12 影响）；7 份 2026-11-07 记录按结论修订（当时仍 `Status: proposed`；其中 `topic-session-model` / `topic-store-v2` 已由 M12 迁 implemented）；M11 决策记录与 panel 记录改采 (b)；M7 执行提案；`docs/publish.json` 与 `docs/README.md` 的索引/分类；PLAN-V0.2 的 §2.2/§2.4/§3.1/§3.2/§5.9/§5.10/§6(M11/M12)/§8/§10.1 按 (b) 修正。
- **结论落点（详见 M6 结果 §0–§7）**：探针 1–3 结论明确（`off` 等价关闭推理；`session/event` 两轮齐全；archive 后 prompt 被 `blocked`、消息不落盘、无替代过滤接口）；4–6 有结论（reviewer 必须 verdict 后归档；preset 行 + per-agent `restrict` 叠加；真实 Chrome 同源 POST 可用且围栏拒绝错误来源）；7 有记录（reviewer 可读隔离 clone；worktree 不作 v1 提供方）。
- **改变计划的发现**：archive 不是「隐藏但可继续」。M11 由用户定为降级 (b)：主题会话保留左侧栏、只隐藏 reviewer；打开主题不需要 unarchive（仅会话已被归档时容错先 unarchive）。见 M11 决策记录。
- **真机/环境**：DSH Desktop **2.0.18**（PLAN 头写 2.0.13，属漂移，只在 M6 文档记录）；Chrome 156；web profile `http://127.0.0.1:3080`。
- **收尾状态**：临时探针工具带已卸载（`/dsh-cowork/m6/health` 现 404）；30 个探针会话已归档（`workspace.json.global.archivedSessionIds` 已核）；证据与工具带保留在 `.dsh-cowork/m6-probe/`（gitignored，删除不影响仓库）。
- **验证**：独立 verifier 复跑 `npm run check`、`npm run check:self-test`、`npm test`（356 pass）、`npm run typecheck`、`npm run build` 全部 exit 0；reviewer 只读终审 verdict=`pass`。

> 下面「交付前的事实」「第一步：M7 的启动顺序」「M7 实施顺序」是交接时写给下一位的记录；探针结论与证据以 [M6 探针结果](M6_PROBE_RESULT.md) 为准，不在本文件重复。

## 先读什么

1. [AGENTS.md](../AGENTS.md)：纪律、命令、no-multi-orchestrator。
2. [PLAN-V0.2](PLAN-V0.2.md) §2.2/§2.4、§3、§5.2/§5.9、§6 M6/M7：阶段、架构与验收。
3. [M6 探针结果](M6_PROBE_RESULT.md)：7 项结论、证据命令、限制、M7–M12 影响。
4. [M11 可见性降级决策](../.agents/notes/implemented/feature/2026-11-07-topic-visibility-fallback.md)：为什么是 (b)、代价、验收。
5. [M7 迁移实施记录](../.agents/notes/implemented/architecture/2026-11-07-store-v2-migration-plan.md)：M7 的执行顺序、事务与测试先行。
6. [索引 v2 与迁移](../.agents/notes/implemented/architecture/2026-11-07-topic-store-v2.md)：数据模型、字段与六态映射（M12 已迁 implemented）。
7. [docs/testing.md](testing.md)、[docs/documentation.md](documentation.md)、[tools/workflow.json](../tools/workflow.json)：证据面、文档分类与检查映射。
8. 本机可选：`.dsh-cowork/m6-probe/toolbelt` 与 `runs/`（gitignored）；复跑方法见 M6 结果 §10。

## 交付前的事实（历史）

- M6 开始时，§3.2 的 7 项能力只有设计假设与 7 份 proposed 记录，没有真实宿主证据；计划假设 archive 是展示过滤、主题隐藏后仍可打开。
- 代码停在 M4：v1 六态 thread 中心索引；`src/store.ts` = 42,578 B / 1069 行，`tests/store.test.mjs` = 772 行，`npm test` 356 pass；`src/store-schema.ts`、`src/store-migration.ts` 不存在。
- 宿主实测 2.0.18（PLAN 写 2.0.13）。M6 按「真实宿主而不是源码猜测」取证，探针 3/4 的否定结论正来自这一点。

## 第一步：M7 的启动顺序（已完成，保留为历史）

1. `git fetch origin`；从含本交接的分支新建 `feat/m7-store-v2`（若本交接已合并进 main，则从 `origin/main`）。工作区必须干净；不要 rebase/force，不要继续在旧 `docs/v0.2-m6-results` 上提交。
2. 读 [M7 实施记录](../.agents/notes/implemented/architecture/2026-11-07-store-v2-migration-plan.md) 与 [topic-store-v2](../.agents/notes/implemented/architecture/2026-11-07-topic-store-v2.md)；确认模块尚不存在、`src/store.ts` 余量约 8.6 KB。
3. 先写会红的测试（`tests/store-migration.test.mjs`；更新 `tests/store.test.mjs`），再实现。
4. 迁移要用的 M6 结论：取消在途 reviewer 必须 `archiveSession(id,{stopActivity:true})`；reviewer 回收是 after-verdict；M7 不接 `session/event`。

## M7 实施顺序（已完成，保留为历史）

1. **M7.1**：`src/store-schema.ts` + `src/store-migration.ts` 纯函数与测试（六态映射、取消评审、幂等、fail closed）。
2. **M7.2**：`src/store.ts` 迁移入口、备份、锁内重读、`store/corrupt` 路径。
3. **M7.3**：activity/inbox 文件 I/O、上限与损坏行测试（业务规则留 M8）。
4. **M7.4**：`npm test`、`npm run typecheck`、`npm run build`、`npm run check` 全绿；阶段结束停下等确认。

**编排建议**：用 AgentTeams 时新建 M7 团队（不复用 `m6-probes`），`profile=impl-review`、`approval=required`：implementation（implementer，code，inScope 显式路径）→ verification（verifier，verify-only，独立复跑四条命令）→ review（reviewer，readonly，pro，`reviewedTaskId`=implementation，verdict=pass 才收口）；失败走 repair+复审。单写者串行，不需要 worktree。

## 验证与证据

- 每条实现：`npm test` + `npm run typecheck`；装配与构建：加 `npm run build` + `npm run check`；每条都记录 exit code，不只说「通过」。
- M6 的证据在 [M6 探针结果](M6_PROBE_RESULT.md) §1–§7；原始 JSON 在 `.dsh-cowork/m6-probe/runs/`（gitignored），复跑见 §10。跨会话/跨进程的结论以真实宿主为准，不用同进程 mock 代替。
- 审查：实现者 ≠ 验证者 ≠ 最终审查者。M6 由 verifier 独立复跑、reviewer 只读终审；M7 沿用。
- 未验证清单（不得当成已验证）：认证后的 `/api` POST（launch token 属凭据）、`openSession` 真实 UI 与 `clearArchivedCurrent`、worktree 运行时、`restrict({allow})` 与跨 agent 隔离、`session/event` 500 条上限、宿主版本漂移行。

## 陷阱

- **`src/store.ts` 只剩约 8.6 KB**：接近 51,200 B 上限时停下报告拆分方案，不压行、不删测试、不擅自扩大模块范围。
- **`.dsh-cowork` 禁 `.md`**：check-invariants 会扫该目录（`.gitignore` 只挡 git，不挡扫描）；测试临时数据用 `os.tmpdir()`，不要拿真实 `.dsh-cowork/index.json` 当夹具。
- **不用固定 sleep**：等待用带截止时间的重试；跨会话/跨进程的结论以真实宿主证据为准。
- **凭据**：launch token / cookie 不读取、不回显；认证态面板验证留 M11。
- **archive 后不能继续对话**（M6 探针 3）：不要用 `archiveSession` 隐藏主题；`archiveSession` 只用于 reviewer 回收（verdict 后、`stopActivity:true`）。
- **记录生命周期**：M7 落地后把 `2026-11-07-store-v2-migration-plan.md` 移到 `implemented/architecture/` 并按 implemented 骨架重写（Problem/Decision/Alternatives/Consequences/Testing）；`topic-store-v2` 当时保持 proposed（含 M8/M10 未落地规则），M12 已迁 implemented 并按骨架重写。移动后跑 `npm run check`。
- **单文件上限**：所有 `src/**/*.ts` < 51,200 B；`src/tools.ts` 另有 49,152 B 警戒。
- **`npm test`** = `node --test tests/*.mjs`，新测试文件名会自动纳入；不要用跳过测试或放宽断言来收口。

## 完成定义

- **M6（已达成）**：探针 1–3 结论明确、4–6 有结论、7 有记录；7 份记录六节非空且与结论一致；新文档发布分类恰好一次；`npm run check` 绿；M6 交付未改 `src/`、`docs/PLAN.md`、根 `package.json`；reviewer 终审 pass。
- **M7（交接判据）**：四条命令全绿；六态映射、取消在途评审、备份不覆盖、幂等、fail closed、activity/inbox 文件 I/O 与裁剪都有测试；无 M8–M12 产物；`src` 单文件 < 51,200 B；阶段结束停下等确认。

## 回滚

- **文档/记录**：`git revert` 对应提交（M6 主体 `66b5d5c`、决策与交接 `2b3ebcd`、本交接更新）。
- **运行时**：探针工具带已卸载，无需回滚；探针会话已归档，可在宿主里 unarchive。
- **数据**：M6 没有改 `.dsh-cowork/index.json` 的语义；探针证据在 gitignored 目录，删除不影响仓库。M7 的回滚按 `index.v1.backup.json`（迁移前备份）并重装 0.1.0。
