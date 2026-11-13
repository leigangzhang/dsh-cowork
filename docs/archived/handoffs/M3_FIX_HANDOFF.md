# M3 收口修复交接

- 状态：**已完成（2026-11-06，`fix/m3-closeout`）**。M3 代码/证据基线 `cd1fe9e`（`feat/m3-review-panel`，已推送），独立终审 t11 已 pass；本文只拥有「M3 遗留清单、修复计划、下一个会话怎么开始」。行为与契约决策见 [M3 收口修复决策](../../../.agents/notes/implemented/bug-fix/2026-11-05-m3-closeout-fixes.md)（提案已按生命周期迁入 `implemented/`）；交付事实见 [M3 结果](../results/M3_RESULT.md)「M3-FIX 收口」、[PANEL_RESULT](../results/PANEL_RESULT.md)「M3-FIX 真机补验」与 [M3 决策](../../../.agents/notes/implemented/feature/2026-11-05-m3-review-panel.md)。M3L-1..6 已全部有证据；M3L-7..12 保持原归属；M3L-13（合入 `main`）需用户明确授权，本阶段未做。
- 收口证据：四条命令 `npm run check` 0、`npm test` 330/330、`npm run typecheck` 0、`npm run build` 0；真实宿主 E2E `m3-004629a6-c7de-48c1-92e9-99c474eae1a1` 15/15、`tempRepoRemoved=true`；失败路径实测 `m3-565e31d8-…`（fixture 被 finally 删除、原始 error 保留）。最终 commit 与截图见 `.dsh-cowork/e2e/M3_DOCS_READY.json`。
- 原则：**M3 自己产生的遗留，在 M3-FIX 内修完，不拖到 M4**；宿主/M4 约束不伪装成 M3 遗留，但必须写明原因与重估触发，不能只写「以后再说」。每一项都要有判定面、验证命令和独立复查。
- 基线事实：`main` 未动（`90f41cd`）；分支 HEAD `cd1fe9e`；四条命令 309/309、check/typecheck/build 0；真实宿主 E2E `m3-d06cc6a6-…` 15/15；截图在 `.dsh-cowork/e2e/panel-m3/`（gitignored）；真实 `.dsh-cowork` 数据已恢复；profile patch 已还原（`dsh-cowork` 仍是 disabled 条目）；当前进程内插件是 runtime 注入，宿主重启后需重新注入。

## 遗留清单

严重度沿用 review 口径：blocker / high / medium / low。`处置` 只有三种：**本阶段修**、**非 M3-owned（写清归属与触发）**、**已接受的设计取舍**。

| id | 问题 | 证据 / 影响 | 处置 |
|---|---|---|---|
| M3L-1 | 面板 API 在旧 fiber 或大会话列表下可能长时间不返回（KI-12） | `/api/cowork.overview`/`handoff` 依赖 `sessionController.list()`；`reload` 不换服务实例时会挂 >25 s，冷启动列表约 1.2 MB / 17 s；面板无限 loading | **本阶段修**：加超时与明确错误，client 显示可重试错误态 |
| M3L-2 | 失败的 M3 E2E 会留下带 `README.md` 的 `.dsh-cowork/e2e/m3-repo`（KI-13） | 失败时不走 cleanup 步；`npm run check`/publish 测试会扫到该 Markdown 而变红 | **本阶段修**：失败路径 `finally` 删除 fixture 并记录 cleanupErrors |
| M3L-3 | `src/tools.ts` 51,184 B，距 DSH 单文件 50 KiB 读上限仅 16 B（KI-14） | 下一次修改该文件就会让任何 agent 无法一次读完；M3 已把 `m3-e2e` 拆过一次，tools 还没拆 | **本阶段修**：拆出 review 工具注册 + 加文件预算守卫 |
| M3L-4 | 面板还有三项真机未验证 | 深色主题下的 review 徽章/findings；两个「打开会话」按钮的导航；≤480 下的 pass/reject 详情 | **本阶段修（验证为主）**：补截图/点击记录；只有发现真实缺陷才改代码 |
| M3L-5 | 面板 fixture 生成器只存在于本机 `.dsh-cowork/e2e/panel-m3/fixture.mjs` | 仓库 clone 到新机器后无法复现两档截图；截图本身 gitignored 是既定模式 | **本阶段修**：脚本迁入 `tools/`，文档写清 apply/restore |
| M3L-6 | 证据 marker 与 HEAD 的时序靠人记 | t11 曾读到 `M3_DOCS_READY.json` 的旧 commit（4c79fa1 vs HEAD 3fe072f）；每次文档提交后必须重写 marker | **本阶段修（流程+脚本）**：收口清单 + 一个可选校验命令，避免再犯 |
| M3L-7 | reviewer 仍可用 bash 写被审文件 | 工具面已无 write/edit，但 bash 能改文件；只读性靠 protocol | **已接受的设计取舍**：review 需要 bash 跑验证；只读沙箱会阻断测试临时写入。触发：实际观测到 reviewer 改被审文件，或 review 变成对外信任边界 |
| M3L-8 | cowork 会话能看到 profile 全局 `dev_*` / host 工具（KI-10） | master 在 t4 自主回合里用过 `dev_plugin_status`/`dev_reload_package`；persona 已禁止，工具面没硬限制 | **非 M3-owned**：preset 只追加行、全局工具始终可见（M1 S0 事实）；重估在 M4 打包/宿主工具白名单 |
| M3L-9 | 同名包 client 在旧进程内不生效；runtime 注入重启即消失（KI-11） | `client-modules` 按 loader name+baseUrl 缓存 pkgMeta；M3 真机靠重启 + clean re-inject 才加载原名 client | **非 M3-owned**：注入器/宿主缓存 + M4 持久安装；触发见 KI-11 |
| M3L-10 | merge override 可绕过 review | `allowUnreviewed + overrideReason` 是用户选定的可操作性取舍；理由进合并提交 | **已接受的产品决策**：不是缺陷；改变它需要新决策记录 |
| M3L-11 | merge 冲突需人工/thread 解决；sandbox 前提是 workspace-write（KI-4/KI-5） | 设计取舍与部署前提，M3 未引入新问题 | **非 M3-owned**：保持；重估触发见 KNOWN_ISSUES |
| M3L-12 | 质量门禁自动生成的 t8/t10 标题是 `repair-round-2`，不可读 | 违反仓库「门禁生成任务要有可读 subject」的纪律；当时靠 amend 合同补救 | **非代码，流程**：下个会话若用 AgentTeams，生成后立即 amend/重建可读标题；本阶段不新增门禁机制 |
| M3L-13 | `feat/m3-review-panel` 尚未合入 `main` | 交付分支已推送；合并需要用户明确授权 | **交接动作**：修复完成后按队长的 push/merge 规则处理，不擅自推 `main` |

## 修复计划（建议顺序）

先做会「让检查假绿/假红」的两项（M3L-1、M3L-2），再做结构整理（M3L-3、M3L-5），最后补验证与文档。每一步单独 commit，四项命令在每步后至少跑受影响面。

### Stage 0：基线与分支

- 从 `feat/m3-review-panel` 的 `cd1fe9e` 开 `fix/m3-closeout`；不改写 `main`，不 force push。
- 复跑基线：`npm run check` / `npm test` / `npm run typecheck` / `npm run build`；真实宿主 health 200，确认插件已注入（必要时 `dev_inject_plugin /Users/ray/Workspace/dsh-cowork`）。
- 先读本文、[M3 结果](../results/M3_RESULT.md)、[PLAN](../../PLAN.md) §5.7–§5.9、[KNOWN_ISSUES](../../KNOWN_ISSUES.md)、[M3 决策](../../../.agents/notes/implemented/feature/2026-11-05-m3-review-panel.md)。

### Stage 1：M3L-1 面板 API 超时 + M3L-2 失败 E2E 清理

**M3L-1（`src/api.ts`、`src/api-contract.ts`、`tests/api.test.mjs`）**

- 给 `CoworkApiPorts.listSessions()` 加有界等待：超过约 30 s 抛 `PanelApiError('session/list-timeout', …)`，overview/handoff 映射为 HTTP 504 与现有 `{ok:false,error:{code,message}}` 包络；仍带 `cache-control: no-store`。是否降级到 `sessionController.inspect` 先不做——M2 已证明 inspect 对运行中大会话会挂，别用一个更差的入口替换慢入口。
- client 的 `toPanelError`/`errorPresentation` 不需要新分支；确认 504 + `session/list-timeout` 会进入现有 error 态并显示「重试」。加测试：fake port 永挂 → 504 稳定 code；慢但可返回 → 成功；成功路径不变。
- 新错误码算 wire 契约变化：在同一次交付写一条 `.agents/notes/implemented/bug-fix/…` 记录（Problem/Decision/Consequences/Testing），不要只改代码。

**M3L-2（`src/m3-e2e.ts`、`tests/m3-e2e.test.mjs`）**

- runner 的 `finally`（现在是 archive + persist）增加 `safeRemoveFixture()`：只在 run 结束（done/failed）后删除 `.dsh-cowork/e2e/m3-repo`，失败也删；删除错误写入 `cleanup.errors`，不掩盖 run 的原始 error；证据仍然落盘。
- 把「是否应删除 fixture」抽成纯 helper（例如 `failureCleanupPlan(state)`），单测覆盖 done/failed 两态与「run 还在 running 不删」；如果删除失败只记录，不把成功 run 改成 failed。
- 验证：人为制造失败 run（例如临时改坏一步）后 `ls .dsh-cowork/e2e/m3-repo` 不存在、`npm run check` 绿；再跑一次成功 run 证据仍写。

### Stage 2：M3L-3 拆 `tools.ts` + 文件预算守卫

- 新建 `src/review-tools.ts`：把 `cowork_review_request` / `cowork_review_verdict` 的注册、`openProject`/`callerOf` 等复用点或参数化依赖移过去，导出 `registerReviewTools(ctx, deps)`；`src/tools.ts` 只调用它。保持工具名、参数、错误码、返回值逐字不变。
- 新增 `tests/source-budget.test.mjs`：遍历 `src/**/*.{ts,tsx}`，断言单文件 ≤ 50 KiB（51,200 B），并把当前 `tools.ts` 体积打印出来；这是把 P2 规则变成可执行检查，防止下一次再贴边。
- 验证：`node --test tests/source-budget.test.mjs`；`npm run typecheck`；`npm test`；`npm run build`；M3 E2E 重跑一次（工具注册路径变了，必须真实跑）。

### Stage 3：M3L-5 fixture 工具迁入 + M3L-4 补真机验证

- 把 `.dsh-cowork/e2e/panel-m3/fixture.mjs` 迁到 `tools/panel-fixture.mjs`（逻辑不变：apply 备份真实数据→写入 5 thread/3 review；restore 还原；退出码明确）。同步更新 `docs/archived/results/M3_RESULT.md`/`PANEL_RESULT.md` 的路径。
- 用 `tools/panel-fixture.mjs apply` 后，按 [M3 结果](../results/M3_RESULT.md) 的真机步骤补：
  1. 深色主题：优先用 DSH 主题切换；若 BrowserSkill 无法改 `prefers-color-scheme`，用系统外观切换并记录实际手段，截 `04-dark-review-states.jpg`；
  2. 点击两个「打开会话」按钮，记录是否导航到目标会话（失败/不可用时的 toast 也算证据）；
  3. 900 宽（右栏 <480）下点 pass/reject 行，截 `05-drill-pass-detail.jpg`、`06-drill-reject-detail.jpg`；
  4. 结束后 `restore`，确认真实 `.dsh-cowork` 恢复、`git status` 只出现 ignored 运行数据。
- 如果点击发现真实缺陷（不是环境限制），修 UI 并在 Stage 4 重截；不要用「环境不行」掩盖可复现的代码问题。

### Stage 4：M3L-6 marker 校验、文档、四命令、E2E、独立复查

- **M3L-6**：新增 `tools/check-evidence-marker.mjs`（读 `.dsh-cowork/e2e/M3_DOCS_READY.json`，断言 `commit === git rev-parse HEAD`、`screenshots` 非空、`screenshotStatus` 合理；marker 不存在时打印提示并 exit 0，避免 CI 因本地证据缺失误红）。在独立复查前运行一次；每次文档提交后重跑并重写 marker。
- 文档：更新 `M3_RESULT`（限制项变少/关闭）、`PANEL_RESULT`、`KNOWN_ISSUES`（KI-12/13/14 从「已转」关闭或改为保持；KI-15 保留）、`M3_HANDOFF`（标记 M3-FIX 完成）、`docs/publish.json`（新文档分类）、新增 `implemented/bug-fix` 记录（M3L-1 的 wire 变化与 M3L-2 的清理行为）。
- 四条命令：`npm run check` / `npm test` / `npm run typecheck` / `npm run build` 全绿；`health` 200。
- 真实宿主 M3 E2E 重跑：`POST /dsh-cowork/e2e/m3/run` → 轮询 `status` 到 done，15/15；证据 `.dsh-cowork/e2e/M3_E2E.json`，失败也能自清理（M3L-2）。
- 独立复查：实现者不得自审；至少一个独立 verifier（跑命令）+ 一个独立 reviewer（读代码/证据/文档），轮数上限 2–3，第一轮走全链路，第二轮只增量；blocker/high/medium 必须关，low 可记录但要写触发。
- 提交与推送：按 Stage 分 commit；全绿后 push `fix/m3-closeout`；**`main` 的合并/推送需用户明确授权**。
- 收口（已完成）：`2026-11-05-m3-closeout-fixes.md` 已按生命周期从 `proposed/` 迁入 `implemented/` 并改写为现在时；`M3_DOCS_READY.json` 在最终提交后重写（commit 等于 HEAD、screenshots 非空、记录实际手段与未核实项），再让 reviewer 复审。

## 下个会话怎么开始（runbook）

1. **读**：本文 → [M3 结果](../results/M3_RESULT.md) → [M3 决策](../../../.agents/notes/implemented/feature/2026-11-05-m3-review-panel.md) → [PANEL_RESULT](../results/PANEL_RESULT.md) → [KNOWN_ISSUES](../../KNOWN_ISSUES.md)。不要重读 M0/M1/M2 的探针。
2. **环境**：`pwd` 确认仓库；`git fetch`；`git switch -c fix/m3-closeout cd1fe9e`；`git status` 应只有 ignored。宿主 `http://127.0.0.1:3080`；插件可能因宿主重启未加载：
   - `curl /dsh-cowork/probe/health` 404 → `dev_inject_plugin /Users/ray/Workspace/dsh-cowork`；
   - 页面 boot 里没有 client / 底栏没有「打开 Cowork 面板」→ 先 `dev_reload_package dsh-cowork`；仍不行就 clean `dev_uninject_plugin` → `dev_clear_routes /dsh-cowork` → `dev_inject_plugin`；不要用 reload 后的旧 fiber 下结论（M3 已踩过）。
   - profile patch 的 `- id: dsh-cowork disabled: true` 是原始配置；真机跑面板时按需临时注释，结束后还原（备份 `/tmp/cordis.patch.yml.m3bak` 可能已不在，直接按当前文件注释/还原）。
3. **先跑基线**四条命令；再按 Stage 1→4 做。每改一步跑受影响测试；Stage 2 之后必须重跑真实 E2E。
4. **fixture 与截图**：`node tools/panel-fixture.mjs apply`；打开 Chrome（BrowserSkill 会话），确认底栏「打开 Cowork 面板」→ 打开面板；`bsk_assist({action:'resize',width:900,height:900})` 可把右栏压到 <480（先 sync 再 resize；M3 已实测）。截图用 `bsk_inspect screenshot`，把附件复制到 `.dsh-cowork/e2e/panel-m3/`；结束后 `restore`。
5. **不要做**：不改 `.agent-teams` 状态文件；不引 AgentTeams 运行时/多编排；不把 `.dsh-cowork` 或截图提交；不推 `main`；不用 `--force`。
6. **收尾**：更新 marker；独立 reviewer pass；push 分支；向用户报告四件事（改了什么、验证证据、回滚、未核实项）。

## 非本阶段项（不排进 M3-FIX）

- M4：preset 持久化（KI-3）、单插件打包与正式安装（同时解决 client 缓存与重启后注入）。入口见 [M4 交接](M4_HANDOFF.md) 与 [M4 决策](../../../.agents/notes/implemented/feature/2026-11-05-m4-packaging.md)；M4 必须先过 M3-FIX。
- 宿主/工具面：profile 全局 `dev_*` 工具（KI-10）、`client-modules` pkgMeta 不失效（KI-11）、merge 冲突人工解决（KI-4）、workspace-write 前提（KI-5）。
- 已接受设计：reviewer 的 bash 写能力（M3L-7）、merge override（M3L-10）、截图/证据 gitignored（M3L-5 只保证可复现，不改变存储模式）。
- 这些不是「忘了修」，而是归属明确；重估触发已写在各行/KNOWN_ISSUES，满足「不拖延」要求：本阶段只承接自己造成的问题。

## 完成定义

- M3L-1..6 全部有证据（代码/测试/截图/文档），M3L-7..12 保持有归属说明；没有新的未归类遗留。
- 四条命令全绿；真实宿主 M3 E2E 15/15；面板深色、两个打开按钮、≤480 pass/reject 详情都有证据或明确的不可得原因。
- 独立 reviewer 给 pass；`M3_DOCS_READY.json` commit==HEAD、screenshots 非空；分支已推送，`main` 未擅动。
- 更新 `M3_HANDOFF`：M3 与 M3-FIX 都已完成，下一位只需看 M4/PLAN。

## 回滚

- 代码：按 Stage 提交 revert；M3 交付提交不动。
- 运行时：`dev_uninject_plugin dsh-cowork`；真实 `.dsh-cowork` 数据在 fixture restore 后应与 apply 前一致，若不一致从 `panel-m3/backup` 恢复。
- 证据：截图与 E2E 证据是本地文件；删除它们不影响项目数据。
