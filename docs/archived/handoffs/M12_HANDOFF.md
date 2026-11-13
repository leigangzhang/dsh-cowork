# M12 交接文档

- 状态：**M12 启动文档（2026-11-08）**。M11 已交付（[M11 交付结果](../results/M11_RESULT.md)）；本文件写给下一个会话，用于启动 V0.2 M12（文档、真实 E2E、0.2.0）。不重新论证 M11 的决定，也不重抄 M12 需求全文；交付证据的 home 是 [M12_RESULT](../results/M12_RESULT.md)，本文件保留启动时的计划与陷阱。
- 适用：接手 M12 的 agent 或人。范围：M11 交付后的代码基线、M12 的启动方式、分阶段实施与证据、影响面、陷阱、完成定义、回滚与未验证清单。
- 事实源：[PLAN-V0.2](../../PLAN-V0.2.md) §6 M12 与 §7 拥有需求、范围与验收编号 A1–A10；[M12 执行记录](../../../.agents/notes/implemented/architecture/2026-11-08-m12-docs-e2e-release-plan.md) 拥有执行层决定与备选（已随交付迁入 implemented）；[M11 交付结果](../results/M11_RESULT.md) 拥有 M11 的交付面与证据；[KNOWN_ISSUES](../../KNOWN_ISSUES.md) 拥有遗留归属；[AGENTTEAM](../../AGENTTEAM.md) 与 [testing](../../testing.md) 拥有流程与证据规则；交付事实、A1–A10 证据与回滚记录由 [M12_RESULT](../results/M12_RESULT.md) 拥有；本文件只拥有「从哪继续、先验证什么、怎样算完成」。

## M11 交付后的状态（2026-11-08）

- **M11 代码 artifact**：HEAD `6b7beab01ddd4d1ff1370187802a965a5019e1fd`；`git diff 6a5310e..6b7beab | shasum -a 256` = `e1e0f88dabf4eff5390ea6203b84bb06899a7d6870f15553f96a972b22e85669`；`npm test` **732 / 732**、四命令 exit 0；`lib/client.js` 89,235 B、sha256 `3b1b3588a72b7b0ad7608511149e9f10b52cfd271007b8dd2896bc59c896ab47`（构建可复现）。
- **M11 分支与 PR**：`feat/m11-http-api-panel`，PR [#16](https://github.com/leigangzhang/dsh-cowork/pull/16)（base `main`）**已合并**；M12 的基线是 `origin/main` 上的 merge commit `1b0801d`（合并提交信息见 `git log --oneline -1 1b0801d`）。分支 tip `c9c74f4` 是 M11 交付记录之后的文档提交；M12 不再以 M11 分支 HEAD 为基线。
- **M11 交付面**：`src/api-contract.ts`（v2 wire，17,046 B）、`src/api.ts`（六条路由 + 同源安全，39,114 B）、`src/index.ts`（仅装配端口）、`src/client/*`（9 文件，主题面板）、`tools/panel-fixture.mjs`（v2 fixture）、4 个测试文件重写/扩展；细节见 M11_RESULT「交付面」。未新增工具/预设，未改 canonical v2 store/schema 语义。
- **面板/API 现状（`6b7beab` 实测）**：六条路由 `/api/cowork.overview`、`/activity`、`/topic`（GET）与 `/topic.resolve`、`/topic.reopen`、`/route.move`（POST，master-only + Host/Origin/content-type/8 KiB 校验）；面板显示主题列表/详情/工作项/评审请求（来自 `reviews/<topicId>-<requestId>.json`）/活动/操作；打开主题只切主区、面包屑回 master、footer 入口保留；reviewer 不列为行（KI-28：宿主左侧栏仍可能可见）。
- **数据模型**：canonical v2（`topics[]`/`workItems[]`、`activity.jsonl`、`inbox.json`、评审请求文件）；真实项目 `.dsh-cowork` 目前仍是 v1（`index.json` sha256 `f7fec0dba4aa6378ee0c591ecc18276ddd5a75c7091d285331c70ae7a3bdbc24`，3 threads、reviews 3 个旧文件、无 activity/inbox/backup）——M11 验证期间触发过一次 on-write 迁移，已用 `index.v1.backup.json` 恢复。
- **必须知道的 M11 行为**：对 v1 项目第一次调用 `overview`（或任何触发生命周期写的路径）会执行 M7 的 on-write 迁移：写 v2 index + `index.v1.backup.json` + 生命周期活动。`docs/M12_RESULT.md` 与 README 升级说明必须写「打开面板即迁移」，并给出回滚步骤（M11_RESULT D3）。
- **证据落点（gitignored）**：`.dsh-cowork/e2e/m11/` 的 `panel-run.json`、6 张 `*.jpg`、`INTEGRATION_READY.json`、`pre-fixture.json`；它们支撑 M11_RESULT A8，不复制进新文档。

## M12 要承接的遗留

- **KI-22**：真实全链路 E2E 与真实 v1 数据迁移/回滚演练 → M12。
- **KI-29**：legacy dev E2E（m2/m3）仍是 v1 语义，不能当验收；M12 用新驱动替代其验收角色。
- **KI-31**：v2 面板/API 未在正式 bundle 安装路径验证 → M12 打包/安装/卸载验收。
- **KI-32**：`route.move` 重复 intent 会继续追加别名（每次 ≤8，非严格幂等，已接受）→ M12 文档说明或评估。
- **KI-33（已关闭，不再承接）**：`docs/README.md` 已补 `M10_RESULT` 行；M6 文档与 `topic-session-model`/`topic-store-v2` 的旧 `proposed/` 链接已修；M10 执行提案已迁 implemented。剩余「`topic-session-model`/`topic-store-v2` 仍 proposed」由 M12 文档发布面承接。
- 保持项不要改语义：KI-28（reviewer 左侧栏可见是接受上限）、KI-27（isolation 只有 clone）、KI-23（inbox at-least-once）、KI-19（迁移报告只在内存）、KI-21（fsync 无崩溃注入证据）、KI-26（合并串行只在本进程）、KI-30（评审分级未实现，M12 视需要）。

## 先读什么

1. [AGENTS.md](../../../AGENTS.md) 与 [docs/AGENTTEAM.md](../../AGENTTEAM.md)：纪律、R8 浏览器验证、R9 fixture、DAG/artifact/交付规则。
2. [PLAN-V0.2](../../PLAN-V0.2.md) §6 M12（范围/完成标准/证据/不做）、§7（测试与验收总则与 A1–A10）、§2.1–§2.4（角色、流程、状态机、可见性）、§5.1–§5.6（生命周期、store、路由、评审、工作项、活动/收件箱）。
3. [M12 执行记录](../../../.agents/notes/implemented/architecture/2026-11-08-m12-docs-e2e-release-plan.md)：E2E 驱动、迁移演练、安装路径、文档发布面的执行决定与备选（已迁 implemented）。
4. [M11 交付结果](../results/M11_RESULT.md)：交付面、A1–A10 证据、偏差 D1–D8、回滚与未验证项；不要复制它的证据。
5. [KNOWN_ISSUES](../../KNOWN_ISSUES.md)：KI-22/29/31/32 与保持项（含 KI-30）的重估条件。
6. [docs/testing.md](../../testing.md)（tiers、commands、fixture 规则）、[M6 探针结果](../results/M6_PROBE_RESULT.md) §3/§4/§6（archive 后行为、reviewer 回收、同源 POST 限制）、[M4 交付结果](../results/M4_RESULT.md)（安装/卸载路径与 15/15 真实 flow 的做法）。
7. [M11 交接文档](M11_HANDOFF.md)（历史启动版，只读）与 [M11 决策记录](../../../.agents/notes/implemented/architecture/2026-11-08-m11-http-api-panel.md)。

## 第一步：M12 启动顺序

1. `git fetch origin`；工作区必须干净（`git status --porcelain` 为空）。
2. 定基线：M11 PR #16 已合并，基线是 `origin/main` 的 merge sha `1b0801d`；从它新建 M12 分支，不 rebase、不 force。
3. 新建 `feat/m12-docs-e2e-0.2.0`（不在 M11 分支上继续开发）。
4. 先跑基线四命令：`npm test`（实际基线 **732/732**）、`npm run typecheck`、`npm run build`、`npm run check`，全部 exit 0 才改代码；任何红先停下报告。M12 最终为 **773/773**（新增迁移演练 7 + m12-e2e 32 + dev-gate 1 + api 1）。
5. 建团队前读 [docs/AGENTTEAM.md](../../AGENTTEAM.md)，用已配置 profile；先派 **impact-scan** 任务：
   `grep -rn "m2-e2e\|m3-e2e\|M12\|archived\|thread\|handoff" src tests tools docs/README.md README.md | head -80`、`wc -c src/*.ts`、核对 `tests/workflow.test.mjs`/`tests/source-budget.test.mjs` 对文件与预算的既有断言、核对 `package.json` 版本与 `docs/publish.json` 分类。
6. 并行的写任务用 `worktree_create` 隔离并把 `worktreePath` 写进任务；合并由队长独占；verifier/reviewer 用 `verify-only` 只读策略且不得由实现者自审（M11 的做法）。
7. **真实宿主前置不放到最后**：M12 的验证对象是「已安装包」而不是 dev 注入。先准备 `m12verify` profile + 独立端口宿主 + 认证明方式，再写面板/安装无关的代码。

## M12 实施顺序

1. **基线、文档骨架与影响面**：分支与四命令基线；README 0.2.0 初稿（破坏性变更/迁移/回滚/可见性上限）；`docs/M12_HANDOFF.md` 的启动段；impact-scan 报告（含 m2/m3 的去留决定与所有需要同步修改的测试/文档）。
2. **真实 E2E 驱动（M12.3）**：新增 `src/m12-e2e.ts`（可拆 `src/m12-e2e-support.ts`）与 `tests/m12-e2e.test.mjs`；dev 门 `Config.enableDevRoutes` 下的 `/dsh-cowork/e2e/m12/run`、`/status`；临时仓库运行；按 PLAN §6 M12 的步骤逐步断言并写 `.dsh-cowork/e2e/M12_E2E.json`（带 artifact identity）。先 host-free 契约测试绿，再真实宿主跑一次；模型路由在 E2E 中关闭（PLAN §7）。
3. **迁移演练与回滚（M12.4）**：`tools/m12-migration-drill.mjs`（或驱动的一个阶段）；v1 快照 → 首次写 → v2 + `index.v1.backup.json` 逐字节一致 → 幂等 → 备份回滚；覆盖 pending reviewer 归档失败进 `archiveFailures` 的边界；证据 JSON。
4. **打包与安装路径（M12.5）**：`package.json` 0.2.0；`npm run build` 后 `npm pack` 并检查清单；`m12verify` profile 安装、独立端口宿主重启、四 preset/15 工具/六路由/v2 client 验证、真实 Chrome 面板截图；在同一 profile 用 `enableDevRoutes: true` + 临时 `repoPath` 跑已安装包版 E2E；卸载并确认 `.dsh-cowork` 保留。
5. **文档发布面**：README 0.2.0 定稿；`docs/routing.md`/`docs/context.md` 按 v2 重写或归档旧 thread 页；`docs/glossary.md` 补 v2 术语；`docs/KNOWN_ISSUES.md` 关闭/转归属 KI-22/29/31/32 并保持接受项；`docs/M12_RESULT.md`（A1–A10 证据、安装/迁移/回滚、偏差、未验证）；`docs/publish.json` 为两个新文件各加 internal 条目；`docs/README.md` 加 M12 行。同时把 `topic-session-model`/`topic-store-v2` 迁 implemented 并按骨架重写（二者 Delivery stages 均写 M12 文档收口）；若决定保持 proposed，必须在本阶段记录里写明理由。
6. **收口**：四命令 + `npm run check:self-test`；AgentTeams R10（integration-ready → verification → review → 一次性修复 + 文档同步 → final integration → delivery PR）；`docs/M12_RESULT.md` 记录最终 HEAD、diff sha、status、tgz 清单、PR；**停等确认，不发布 GitHub Release、不部署生产。**

## 影响面（派单前先扫）

- **新增**：`src/m12-e2e.ts`（+ 可选 support）、`tests/m12-e2e.test.mjs`、`tools/m12-migration-drill.mjs`、`docs/M12_RESULT.md`；本文件是 M12 的启动交接，交付记录写在 M12_RESULT（M11 的收口方式），不要把交付证据回填进本文件。
- **修改**：`src/index.ts`（仅 dev 门内注册 M12 run/status 路由，参照 `M3_E2E_RUN_PATH` 的装配方式）、`package.json`（version 0.2.0）、`README.md`、`docs/routing.md`、`docs/context.md`、`docs/glossary.md`、`docs/KNOWN_ISSUES.md`、`docs/publish.json`、`docs/README.md`。
- **可能移除/降级（需记录决定）**：`src/m2-e2e.ts`、`src/m3-e2e.ts` 及其测试与 source-budget/workflow 引用（KI-29）；若保留必须显式标注「dev 面、非验收」，不能让后来者再拿它们验证 M10+ 行为。
- **只读引用**：`store.readIndexDocument/mutateIndexDocument/withWriteLock/readActivity/readInbox/reviewsDir`、`store-migration`、`review-request`/`review-tools`、`work-item`/`checkout*`、`topic`/`topic-events`、`session-visibility`、`api-contract`/`api`、`presets`/`tools`。
- **预算**：每个 `src/**/*.ts(x)` <51,200 B（`tests/source-budget.test.mjs` 会红）；新增 E2E 驱动尽量拆 support；测试文件不计入该守卫，但单文件仍要能被一次读完。
- **文档分类**：新增任何 `.md` 必须进 `docs/publish.json`（`npm run check` 会抓未分类）；不要复制 PLAN/README 里的同一事实，链接即可。

## 陷阱

- **真实数据不要碰**。真实 `.dsh-cowork` 目前是 v1（`f7fec0db…`）；real E2E 与迁移演练都在临时仓库/独立 profile。任何在真实项目上的第一次 overview/写都会迁移数据；要演练迁移就用副本，演练完回滚到逐字节一致的 v1。
- **迁移不是无感**。首次打开面板会写 `index.v1.backup.json` 与活动；README 与 M12_RESULT 必须写明，回滚步骤要能执行。
- **reviewer 可见性**。面板不列 reviewer、verdict 后归档，但宿主左侧栏仍可能短暂可见（KI-28）；不得声称已隐藏，也不得为验证去归档用户会话。
- **resolve 无撤销**。real E2E 必须走 reopen 路径；不要为了测试给 resolve 加撤销语义。
- **真实 E2E 成本与稳定性**。一次完整 run 含真实 LLM reviewer 回合；用短阈值、事件等待与固定步骤，失败先写成 host-free 断言再重跑（R2/R5）；同一形状连续两次失败就停下查因，不要原样重试第三次。
- **第二个宿主的认证**。独立端口/profile 的认证用启动输出里的已认证 URL；不读取/不写入/不转述 cookie/token，不用 curl 绕过。拿不到认证就记录「未验证」，附证据。
- **安装路径的缓存**。`npm pack` 前先 `npm run build`；验证时确认浏览器 boot 列表里是安装包的 `lib/client.js`（id/URL），别把旧 bundle 的通过当新证据（KI-11/KI-16）。
- **旧文档双真相源**。`docs/routing.md`/`docs/context.md` 是 M4 时代 thread 叙述；要么按 v2 重写，要么归档到 `docs/archived/` 再写新页，不能在当前页混两代语义。
- **旧文档指针已修（M10 遗留收口）**：`docs/README` 已补 `M10_RESULT` 行，M6 文档与 `topic-session-model`/`topic-store-v2` 的旧 `proposed/` 链接、M10 执行提案已修；但 `npm run check` 仍只校验 AGENTS.md/README.md/docs/README.md 的链接，后续新增文档的链接仍要手工核对。
- **版本与发布边界**。`package.json` 0.2.0 与 README/发布记录必须一致；`private: true`、无 lockfile 是现状，不擅自改为 npm 发布；GitHub Release 需用户确认。

## 验证与证据

- **定向**：`node --test tests/m12-e2e.test.mjs tests/api.test.mjs tests/api-contract.test.mjs tests/panel-model.test.mjs`；阶段收口 `npm test`（732 + 新增）、`npm run typecheck`、`npm run build`、`npm run check`、`npm run check:self-test`，逐条记录 exit code。
- **真实 E2E（R2/R5）**：先 host-free 契约测试绿，再真实宿主跑；只保留最终一次通过；`M12_E2E.json` 记录 runId、steps、artifact identity、cleanup 结果；失败尝试必须产出 finding + 回归测试。
- **迁移演练**：输入/输出 hash、`index.v1.backup.json` 逐字节比对、二次写幂等、回滚后 `store.readIndex` 读回；证据 JSON + M12_RESULT 指针。
- **安装/卸载**：tarball 清单与字节、profile 版本、重启后 preset/工具/路由/client 的断言、真实 Chrome 截图、卸载后 `.dsh-cowork` 未变（hash）。
- **面板（R8/R9）**：一次验证复用一个长生命周期会话/tab；`bsk_session` ≤10、无 >60s 等待；fixture apply/restore ≤5s 且真实数据 hash 恢复；未认证 401 不是路由注册证据（M11_RESULT 更正），用已认证 fetch 200 下结论。
- **AgentTeams 流程**：impact-scan → 并行写（worktree 隔离，e2e 驱动与文档/迁移脚本分线）→ 队长串行合并 → `integration-ready`（HEAD + `git diff <base>..HEAD | shasum -a 256` + `git status --porcelain` + build/install + marker）→ verification → review（reviewedTaskId=实现，reviewer 可只读执行）→ 一次性批量修复 + 文档 → final integration → delivery（PR）。docs-only 变更只跑 `npm run check` 与定向测试。

## 完成定义

- PLAN §6 M12 完成标准全部满足，A1–A10 逐条有证据：真实全链路 E2E 一次通过、真实 v1 迁移与回滚演练、正式安装路径（含真实 Chrome 面板）、README 0.2.0（破坏性变更/迁移/升级/回滚/限制）、`npm test`（0 fail/skip/todo）、typecheck/build/check/check:self-test 全绿。
- `docs/M12_RESULT.md` 与 `docs/M12_HANDOFF.md` 完成并分类进 `docs/publish.json`；KNOWN_ISSUES 的 KI-22/29/31/32/33 关闭或转归属，保持项有重估条件。
- 交付：分支 push + PR；最终 HEAD、diff sha、status、tgz 清单与 PR URL 记录在 M12_RESULT；**不发布 GitHub Release、不部署生产**，停等用户确认。

## 回滚

- **代码**：按提交逆序 `git revert`；0.2.0 → 0.1.0 用旧 tgz 重装在干净 profile（记录版本与文件名）；wire 与 client 是成对变更，host 与 `lib/client.js` 必须同批回滚。
- **数据**：若真实项目在验证/使用中已迁移，用 `index.v1.backup.json` 恢复 index 并删除迁移新增的 `activity.jsonl`/`inbox.json`（如果迁移前不存在），review 文件保持只读；M12 的演练必须验证这条路径。
- **文档/记录**：revert 对应文档提交；`docs/publish.json` 条目随提交回滚；不要 force-push，不改写已推送历史。

## 未验证（不在 M12 或需另确认）

- GitHub Release、tag、对外发布与部署生产（需用户另行确认）。
- 移动端、多窗口、headless 差异、跨平台（Windows）路径。
- 真实 LLM 路由质量与成本（E2E 中关闭模型路由；另做观测性探针，不做质量断言）。
- KI-28 的宿主会话过滤接口；KI-27 的 worktree provider；KI-23 的跨重启 inbox 幂等；KI-21 的断电持久性。

## 指针

- M12 执行记录：[2026-11-08-m12-docs-e2e-release-plan.md](../../../.agents/notes/implemented/architecture/2026-11-08-m12-docs-e2e-release-plan.md)。
- M11 交付结果与证据：[M11_RESULT.md](../results/M11_RESULT.md)、[M11_HANDOFF.md](M11_HANDOFF.md)。
- 需求与验收：[PLAN-V0.2](../../PLAN-V0.2.md) §6 M12、§7 A1–A10。
- 流程与证据：[AGENTTEAM](../../AGENTTEAM.md)、[testing](../../testing.md)。
- 遗留与归属：[KNOWN_ISSUES](../../KNOWN_ISSUES.md)。
- 历史参考：[M4 交付结果](../results/M4_RESULT.md)（安装/卸载与真实 flow 的做法）、[M6 探针结果](../results/M6_PROBE_RESULT.md)（可见性与同源限制）、[M10 交付结果](../results/M10_RESULT.md)（评审/工作项/合并的边界）。
