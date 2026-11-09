# M12 交付结果

- 状态：**M12 已交付（2026-11-09）**。V0.2 的最后一阶段：真实全链路 E2E、v1→v2 迁移/回滚演练、0.2.0 打包与正式安装/卸载、真实 Chrome 面板与文档发布面均已完成；集成 artifact 为 `495a872`（integration-ready revision 3），独立验证（t26）五命令全绿，独立审查（t7/t8）verdict=pass。delivery 的 push/PR 与最终事实由 delivery 任务回填在本文件末尾，不在本批编造。
- 适用：接手 V0.3（0.3.0）的 agent 或人。范围：M12 的实际交付、证据指针、偏差与未验证项；不重新论证 M7–M11 的决定。
- 事实源：[PLAN-V0.2](PLAN-V0.2.md) §6 M12 与 §7（A1–A10 验收编号）拥有需求与验收；[M12_HANDOFF](M12_HANDOFF.md) 是启动交接（历史）；[KNOWN_ISSUES](KNOWN_ISSUES.md) 拥有遗留归属；[AGENTTEAM](AGENTTEAM.md) R10 拥有收口顺序。交付证据文件在 `.dsh-cowork/e2e/m12/`（gitignored，不进仓库），本文件只做指针。
- **数字口径**：integration-ready revision 3 = `495a872`；`git diff 1b0801d..HEAD | shasum -a 256` = `9fc6556f…`；`npm test` **773/773**（0 fail/skip/todo）；`lib/client.js` 89,235 B、sha256 `3b1b3588…`；安装包 `dsh-external-dsh-cowork-0.2.0.tgz` 426,110 B、sha256 `b190af8e…`。

## 交付基线

- **分支**：`feat/m12-docs-e2e-0.2.0`，从 `origin/main` 的 M11 merge commit **`1b0801d`**（PR #16 已合并）切出。
- **用户收口提交**：`54f8372`（关闭 KI-33、把记录迁移交给 M12）已在本分支祖先链上；`d6cbdc9`（M10 记录措辞）在 `docs/m10-closeout` 分支，**未并入本分支**（另一会话持有，不在 M12 基线内）。
- **初始基线**：`npm test` 732/732（0 fail/skip/todo）；`npm run typecheck`/`build`/`check` exit 0。
- **最终 artifact（integration-ready revision 3）**：commit `495a87202b365522e82f51867358f4d7d6e16bdf`；base `1b0801d`；`git diff 1b0801d..HEAD | shasum -a 256` = `9fc6556faf20bc92b39446e94e86b3846f17cb1a8c708a67e61a8790e9bbdb9d`；`git status --porcelain` 空；`package.json` version `0.2.0`；integration worktree `/private/tmp/dsh-worktrees/1af76a8c/c3d44777/m12-integration`；`builtAt` 2026-11-09T06:30:00.674Z。marker：`.dsh-cowork/e2e/m12/INTEGRATION_READY.json`（revision=3、`repairedFindings=[F1,F2,F4]`）。
- **验证基线（t26 独立复跑，与 marker 逐项一致）**：`npm test` 773/773；`npm run typecheck` exit 0；`npm run build` exit 0（`lib/client.js` 89,235 B、sha `3b1b3588…`）；`npm run check` exit 0；`npm run check:self-test` exit 0（8 违规变红）。定向 4 文件 92/92（m12-e2e + api + dev-gate + m12-migration-drill）。

## 提交序列（`1b0801d..495a872`，14 个提交）

- 用户收口（分支已在）：`ff8ddb2` docs(notes): move the M10 execution plan to implemented；`54f8372` docs(closeout): close KI-33 and hand the record migration to M12。
- t3 迁移演练：`7f6928b` feat(tools): add the v1-to-v2 migration drill and rollback → 集成 `a60d0b8`。
- t16 决策记录迁移：`a7019e5` docs(notes): migrate the topic-session and topic-store records to implemented → 集成 `ade3175`。
- t4 集成准备：`8de7df1` chore(release): bump 0.2.0 and declare the migration-drill surface → 集成 `c737175`。
- t2 真实 E2E 驱动：`7da291e` feat(e2e): add the M12 real-host chain driver → 集成 `c63caba`。
- t19 F1/F2 修复：`2ae484b` fix(e2e): match panel probe paths by pathname → 集成 `4db8619`。
- t23 F4 修复：`9508603` fix(e2e): send same-origin headers from the M12 panel probe → 集成 `495a872`（最终 artifact）。
- `dsh-worktrees: integrate …` 提交由队长在集成分支上生成（合并队长独占）。

## 交付面

| 路径 | 角色 | 字节 |
|---|---|---|
| `src/m12-e2e.ts` | 真实 E2E 驱动：17 步链、超时/失败即停、artifact identity、cleanup 归档与 fixture 删除 | 50,961 |
| `src/m12-e2e-support.ts` | 驱动支撑：计划/断言/解析/identity 纯函数、临时仓库与 fixture 守卫 | 50,924 |
| `src/panel-probe.ts` | 面板探针叶子模块：`panelRoutePathname` + `panelProbeRequest`（显式同源 Host/Origin） | 1,742 |
| `tests/m12-e2e.test.mjs` | host-free 契约：纯函数、步骤顺序、证据形状、persist-before-delete 不变量 | 26,517 |
| `tools/m12-migration-drill.mjs` | v1→v2 迁移/回滚演练（11 步、证据 JSON、`--evidence/--keep/--seed`） | 37,796 |
| `tests/m12-migration-drill.test.mjs` | 演练脚本契约：exit code、证据形状、--keep/--evidence、确定性 | 13,043 |
| `src/index.ts` | 仅装配：`enableDevRoutes` 内的 M12 run/status 路由与进程内面板探针（exact + loopback） | 36,940 |
| `tests/dev-gate.test.mjs` | dev 门清单与 exact 匹配、F1 带查询串回归 | 14,163 |
| `tests/api.test.mjs` | F4 真实 handler 同源回归（probe 200 vs 裸 Request 403） | 65,641 |
| `package.json` | version `0.2.0` | — |
| `tools/workflow.json` | 迁移演练 surface（`tools/m12-migration-drill.mjs`）与两条证据命令 | 3,411 |

## 完成定义与证据（A1–A10）

- [A1] v1→v2 迁移、备份逐字节、幂等、回滚 — `tests`：`tests/store-migration.test.mjs`、`tests/store-v2.test.mjs`；演练 `node tools/m12-migration-drill.mjs` exit 0（11/11 步）：输入/备份/恢复 sha 均为 `1dd3cd3c…`，v2 迁移后 `f8fcd8bb…`，二次写 `migrations=1` 且 backup mtime 不变，archiveFailures 有记录不伪成功，回滚后 `readIndexVersion=1`、tree hash `78bb0d12…` 回到迁移前且新增 backup/activity 被移除。证据：`.dsh-cowork/e2e/m12/M12_MIGRATION.json`（6,350 B、sha256 `f79082a9…`）。
- [A2] 三态、标记、五条件、3 天、无撤销、重开 — `tests`：`tests/topic.test.mjs`、`tests/topic-events.test.mjs`；M12 E2E 的 `auto-resolve`/`no-undo`/`resolved-no-receive`/`reopen` 四步在真实宿主 passed（`M12_E2E.json` steps）。
- [A3] 三层路由、低置信不弹窗、失败回退、resolved、别名 — `tests`：`tests/routing.test.mjs`、`tests/router-model.test.mjs`、`tests/route-tools.test.mjs`；E2E `route-topic` 在真实宿主 passed。
- [A4] 评审请求校验、reviewer 生命周期、stale head、回收 — `tests`：`tests/review-request.test.mjs`、`tests/review-verdict.test.mjs`、`tests/work-item.test.mjs`；E2E `review-request`/`review-verdict`/`master-merge-decision` 三步 passed。
- [A5] 工具/角色/别名、preset、memory — `tests`：`tests/tools.test.mjs`、`tests/presets.test.mjs`、`tests/memory-prompt.test.mjs`、`tests/dev-gate.test.mjs`（15 工具顺序与时序）；已安装包宿主上由真实 E2E 使用 master/topic/reviewer preset 与业务工具。
- [A6] 面板契约、排序/标签/操作、写路由 + 真实 Chrome — `tests`：`tests/api.test.mjs`、`tests/api-contract.test.mjs`、`tests/panel-model.test.mjs`；真实 Chrome（已安装 0.2.0、m12verify 宿主 3091）：overview/activity/topic 200，resolve/reopen/route.move 200，负向对照 403（未绑定 master）与 404（无 `.dsh-cowork`）；fixture apply/restore 各 5 ms（≤5 s 预算），restore 后 index 逐字节回到 `f7fec0db…`；4 张截图。证据：`.dsh-cowork/e2e/m12/PANEL_EVIDENCE.json`（sha256 `0b8505c9…`）与 `panel-0[1-4]*.jpg`。
- [A7] 隔离、串行合并、冲突、清理 — `tests`：`tests/work-item.test.mjs`、`tests/checkout.test.mjs`；E2E `merge` 步在真实宿主断言 main ref 不动、合并提交双亲、clone 拆除；`cleanup` 步断言 3 个创建的会话 archived=true/error=null、workspace 删除、fixture 删除。
- [A8] 真实 E2E — `tests`：`tests/m12-e2e.test.mjs`；真实宿主一次通过（17/17 步，62 s），runId `m12-3ccfe5e4-32f0-4286-80c7-c8402d0df6fa`，artifact identity 与 `495a872`/`9fc6556f…`/status 空一致。证据：`.dsh-cowork/e2e/m12/M12_E2E.json`（106,340 B、sha256 `b44919b7…`）。
- [A9] 文档分类/检查/构建 — `plan-docs`：本文件、[M12_HANDOFF](M12_HANDOFF.md)、[KNOWN_ISSUES](KNOWN_ISSUES.md)、`docs/publish.json`、`docs/README.md`；`npm run check`/`check:self-test`/`typecheck`/`build`/`npm test` 全 exit 0（见验证基线）。
- [A10] 回滚（备份恢复 + 0.1.0 重装） — 备份恢复已两次验证：演练（tree hash 回到迁移前）与真实数据事故（`f7fec0db…` 逐字节恢复，见下节）。`0.1.0` tgz 保留在证据目录（385,662 B、sha256 `b30a9768…`），重装步骤见「回滚」；**0.1.0 重装未在 M12 内执行 → 未验证**。

## 真实全链路 E2E（A8）

- **运行**：已安装 0.2.0 的 m12verify 宿主（端口 3091、pid 88754）上 `POST /dsh-cowork/e2e/m12/run?base=1b0801d`；2026-11-09T06:32:00.693Z → 06:33:02.678Z（约 62 s）。
- **结果**：runId `m12-3ccfe5e4-32f0-4286-80c7-c8402d0df6fa`，state `done`，17/17 步 `passed`（setup、route-topic、session-list、overview、work-item、work-item-commit、review-request、review-verdict、master-merge-decision、handoff-done、merge、auto-resolve、no-undo、resolved-no-receive、reopen、activity、cleanup），无 error。
- **身份**：`artifactIdentity` = head `495a8720…`、base `1b0801d`、diffSha256 `9fc6556f…`、statusPorcelain 空、pluginVersion `0.2.0`、repoPath 指向集成 worktree。
- **cleanup**：master `session-321d0961…`、topic `session-3bfec598…`、topic-resolved-match `session-ca9de1c7…` 全部 `archived=true`/`error=null`；`archiveErrors=[]`；workspace `36155c15…` 删除；临时仓库 `/private/var/.../dsh-cowork-m12-mlKgnL` 删除；`errors=[]`。
- **证据**：`.dsh-cowork/e2e/m12/M12_E2E.json`（sha256 `b44919b7…`，106,340 B）。

## 迁移演练与回滚（A1/A10）

- `node tools/m12-migration-drill.mjs` exit 0（11/11 步），`node --test tests/m12-migration-drill.test.mjs` 7/7；不读写真实 `.dsh-cowork`，全部在 `os.tmpdir()` 临时仓库，结束后清理（`--keep` 可保留）。
- 断言链：输入 v1 快照 sha → 只读不迁移 → 首次写经 `ProjectStore.updateThread` 的 on-write 路径迁移 → v2 形状经 `projectIndexV2Problems` 校验 → `index.v1.backup.json` 与输入逐字节一致（`1dd3cd3c…`）→ activity 迁移事件 → 二读/二写不再迁移（`migrations=1`、backup mtime 不变）→ reviewer 归档失败进 `archiveFailures` 且 v2 仍提交（`v2Written=true`）→ 备份回滚后 `store.readIndex` 读回 v1、目录字节回到迁移前。
- 证据：`.dsh-cowork/e2e/m12/M12_MIGRATION.json`（sha256 `f79082a9…`）。

## 打包、安装、面板与卸载（PLAN §6 M12）

- **安装包**：`npm pack` 产出 0.2.0 tgz（426,110 B、sha256 `b190af8e…`、135 文件：`lib/**` 131 + 4 个根文件），无 `src/tests/docs/tools/scripts/.dsh-cowork` 路径；同路径重复安装命中 "Already up to date"，故 remove + add 强制重装（`lib/panel-probe.js` 存在，`lib/index.js` 含 `panelProbeRequest`）。证据：`INSTALL_EVIDENCE.json`（sha256 `f1261921…`）。
- **profile 与宿主**：`m12verify`（web 模板 + cowork），安装 0.2.0；宿主 3091 `/health` 200（`version=0.2.0`）；dev 路由关闭时 `GET /run` 405、`GET /status`（无 runId）400；浏览器 boot bundle 中的 cowork client 来自安装包（`lib/client.js` sha `3b1b3588…`）。预设/15 工具/六路由由已安装包真实 E2E 与 `tests/dev-gate.test.mjs` 覆盖。
- **面板（A6）**：六条路由在真实 Chrome 已认证同源上下文 200；负向对照 403/404；截图为列表+详情、已解决、重开、改投表单；reviewer 不作为行出现（决策 b，KI-28 上限）；fixture 不残留（restore 后 index `f7fec0db…`、activity/inbox 移除、reviews 恢复 3 个原文件）。
- **卸载（A7 数据保留半边）**：`dsh plugin --profile m12verify remove @dsh-external/dsh-cowork` exit 0；bundles 回到 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`，`@dsh-external` 为空、dump-config 中 cowork 行数 0；卸载前后真实数据 `index.json` 与 `m7-execution-prompt.txt` hash 完全一致。证据：`UNINSTALL_EVIDENCE.json`（sha256 `f1b33455…`）。

## 真实数据迁移副作用与恢复

- 在已安装包宿主上打开 CoWork 面板（真实项目 session）触发了 M7 的 on-write 迁移，发生 2 次；每次均按备份恢复：迁移后 v2 `185870cd…`，`index.v1.backup.json` 与原始 v1 `f7fec0db…` 逐字节一致，activity `7f548ed5…`（`status-changed`：fromVersion=1、done=3、archivedReviewers=[]）；恢复 = `cp backup index.json` + 删除 backup/activity，恢复后 `f7fec0db…` 逐字节一致、v1 `threads=3`、reviews 未动。
- **处置**：真实项目留在 v1；后续只在 panel fixture 上操作并立即 restore。这是设计内的升级行为（打开面板即迁移），不是缺陷；README 0.2.0 必须写明升级与回滚。证据：`REAL_DATA_MIGRATION_INCIDENT.json`（sha256 `793c16a2…`）。

## 验证与审查

- **t26 独立验证（v3）**：隔离副本 `/tmp/m12-verify` @ `495a872`；身份（HEAD/diff sha/status 空）与 marker revision 3 逐项一致；五命令全绿（773/773）；定向 4 文件 92/92；迁移演练 11/11；真实 E2E 17/17（62 s）；cleanup 断言全过。
- **t7 审查（E2E 驱动与真实证据，verdict=pass）**：A2/A3/A4/A5 行为断言与 dev 门边界（exact、loopback、失败即停、超时不写真实数据）成立；低危 finding：`src/index.ts` 注释称证据文档写明「HTTP transport 绕过」，但 `M12_E2E.json` 只记录 status/body（KI-35）。
- **t8 审查（迁移演练，verdict=pass）**：A1 逐条成立；archiveFailures 不伪成功；隔离性与 exit code 契约成立。
- **修复轮**：F1（带查询串的面板探针查表，`2ae484b`）、F2（失败路径也记录归档/fixture 清理，同提交）、F4（探针显式同源 Host/Origin，`9508603`）；每轮重新集成并升 marker（revision 1→2→3），之后只在 docs 变更时按 R10 只跑 `npm run check` 与定向测试。

## 已知偏差与接受项

- **D1 打开真实项目面板即迁移**：0.2.0 的单向升级行为（M11 D3）；M12 验证中在真实项目上触发 2 次并逐字节恢复；README 与本节都要求用户升级前备份/知晓回滚。
- **D2 route.move 追加式非严格幂等**：重复 intent 会继续追加剩余 token（每次 ≤8、总数 ≤50）；面板一次性操作，`changed/added` 可见；按 KI-32 评估后接受并在本阶段关闭（证据：PANEL_EVIDENCE route.move 200）。
- **D3 legacy m2/m3 驱动保留但非验收**：它们编码 v1 thread 语义，在 v2 store 上按预期失败（m3 run `m3-42268d7a…`，首步 `thread-a-create` 180 s 超时）；保留为 dev-only，KI-29 关闭。证据：`KI29_M3_DRIVER_NOT_ACCEPTANCE.json`（sha256 `5f37b4f7…`）。
- **D4 reviewer 左侧栏可见**：决策 b 的接受上限（KI-28）；插件不归档用户会话。
- **D5 「打开未归档主题」未在真实 Chrome 实测**：本轮只验证了列表/详情/解决/重开/改投；打开语义由 M12 E2E 在进程内覆盖（PANEL_EVIDENCE `unverified`）。
- **D6 空白 host 会话无法从 UI 归档**：切换工作区产生的空白会话（非 cowork 创建）在宿主 UI 没有归档入口；记录为 KI-34（V0.3）。
- **D7 真实 LLM 路由质量/成本未评估**：E2E 按 PLAN §7 关闭模型路由；记录为 KI-36（V0.3）。
- **D8 注释与证据不一致**：`src/index.ts` 的探针注释声称证据文档写明 transport 绕过；记录为 KI-35（V0.3 注释清理）。
- **D9 测试数变化**：基线 732 → 最终 773 = +7 迁移演练 +32 m12-e2e +1 dev-gate F1 +1 api F4。

## 回滚

- **代码**：按提交逆序 `git revert`；0.2.0 → 0.1.0 用 0.1.0 tgz（sha256 `b30a9768…`）在干净 profile 重装（`dsh plugin remove/add`），host 与 `lib/client.js` 必须同批回滚。**该重装步骤未在 M12 内执行（未验证）**。
- **数据**：用 `index.v1.backup.json` 恢复 `index.json`，删除迁移新增的 `activity.jsonl`（迁移前不存在时）；review 文件保持只读。演练与真实数据事故均按此路径恢复到逐字节一致的 v1。
- **文档/记录**：revert 对应文档提交；`docs/publish.json` 条目随提交回滚；不 force-push、不改写已推送历史。

## 未验证

- GitHub Release/tag、对外发布与部署生产（需用户另行确认）。
- 0.1.0 重装回滚路径未执行（见 A10/回滚）。
- 移动端、多窗口、headless、Windows/跨平台路径。
- 真实 LLM 路由质量与成本（KI-36）；KI-28（宿主侧栏过滤）、KI-27（worktree provider）、KI-23（跨重启 inbox 幂等）、KI-21（断电持久性）保持。
- 真实 Chrome 下对未归档主题执行「打开主题」（D5，仅进程内覆盖）。

## 最终交付事实

> 由 delivery 任务（push/PR）填写；在此之前不编造 PR URL、最终分支 HEAD 之外的推送状态。

- push 分支 / PR：
- 交付 HEAD（delivery 时）：
- `git diff 1b0801d..HEAD | shasum -a 256`：
- `git status --porcelain`：
- tgz sha256 / 文件数：
- PR URL：

## 指针

- 启动交接（历史）：[M12_HANDOFF.md](M12_HANDOFF.md)。
- 需求与验收：[PLAN-V0.2](PLAN-V0.2.md) §6 M12、§7 A1–A10。
- 遗留与归属：[KNOWN_ISSUES](KNOWN_ISSUES.md)。
- 流程/证据规则：[AGENTTEAM](AGENTTEAM.md)（R10 收口顺序）、[testing](testing.md)。
- 证据目录（gitignored）：`.dsh-cowork/e2e/m12/` —— `INTEGRATION_READY.json`、`INSTALL_EVIDENCE.json`、`PANEL_EVIDENCE.json`、`UNINSTALL_EVIDENCE.json`、`M12_E2E.json`、`M12_MIGRATION.json`、`REAL_DATA_MIGRATION_INCIDENT.json`、`KI29_M3_DRIVER_NOT_ACCEPTANCE.json`、4 张 panel jpg、0.1.0/0.2.0 tgz。
- M11 交付结果：[M11_RESULT.md](M11_RESULT.md)。
