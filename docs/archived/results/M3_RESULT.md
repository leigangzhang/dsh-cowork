# M3 结果：独立 review 门禁与面板 review 呈现

- 结论：**host 侧 M3 已交付并在真实宿主验证**——`cowork_review_request` / `cowork_review_verdict`、独立 `cowork-reviewer` 会话、`reviews/` 存储、verdict 状态路由、`needs_revision` 退回、`pass` 合并门禁与显式覆盖，全部在真实宿主 E2E 中跑通（15/15 步，两次合并）。**面板侧也已在真实 Chrome 验证**：overview/handoff review 字段、review 徽章、审查详情、打开 review 会话在分栏与 ≤480 钻取两档都取得截图（`.dsh-cowork/e2e/panel-m3/01-split-review-states.jpg`、`02-drill-list.jpg`、`03-drill-needs-revision.jpg`）。**M3-FIX 收口已完成**：面板超时、失败 E2E 清理、tools 拆分、fixture/marker 工具与剩余真机证据均已关闭，详见文末「M3-FIX 收口」与 [决策记录](../../../.agents/notes/implemented/bug-fix/2026-11-05-m3-closeout-fixes.md)。
- 分支与字节：原 M3 交付分支 `feat/m3-review-panel`，代码/证据基线 `d95fb82`（含 t8）；M3-FIX 在 `fix/m3-closeout` 上收口，最终 commit 见 `.dsh-cowork/e2e/M3_DOCS_READY.json` 的 `commit`（写该 marker 时的 HEAD），四条命令 330/330。
- 依据：[M3 提案](../../../.agents/notes/implemented/feature/2026-11-05-m3-review-panel.md) 拥有范围与决策；[M3 P0 探针](M3_PROBE_RESULT.md) 拥有本轮探针与失败；[M3 交接](../handoffs/M3_HANDOFF.md) 拥有从哪继续；[KNOWN_ISSUES](../../KNOWN_ISSUES.md) 拥有明确不修项。

## 交付面

| 落点 | 职责 |
|---|---|
| [`src/review-request.ts`](../../../src/review-request.ts) | review 请求模型：输入校验、verdict→状态路由、调用者门（自审拒绝）、request 前置、merge 门禁与 override 清洗、review brief、退回消息 |
| [`src/store.ts`](../../../src/store.ts) | `reviews/` 目录与 ReviewRecord 排他写/列表/读；索引可空 review 字段（`reviewStatus` / `reviewRequestedAt` / `reviewedAt` / `reviewerSessionId` / `latestReviewPath`），旧 `worktreePath`/缺字段索引读为 null |
| [`src/tools.ts`](../../../src/tools.ts) | 第 10/11 个工具 `cowork_review_request` / `cowork_review_verdict`；`cowork_project_status` 附 `latestReviews`；`cowork_checkout_merge` 默认要求 `reviewStatus=pass`，`allowUnreviewed + overrideReason` 可覆盖 |
| [`src/session-slice.ts`](../../../src/session-slice.ts) | `createReviewSession`：主仓库 workspace + preset 校验 fail-closed + `cowork review: ` 标题 |
| [`src/presets.ts`](../../../src/presets.ts) | `cowork-reviewer` preset（persona + agent-instructions + tool-bash + tool-fs-search，**无 tool-fs**）；master persona 增加 handoff→review、禁 dev_*/host 工具、只 pass 可 merge |
| [`src/api-contract.ts`](../../../src/api-contract.ts) / [`src/api.ts`](../../../src/api.ts) | overview thread 行追加 `reviewStatus/reviewedAt/reviewerSessionId`；handoff 追加 `review:{record,filePath}\|null`；仍只读、`no-store`、只按索引指针读 |
| [`src/client/**`](../../../src/client) | review 徽章（审查中/通过/需修改/已拒绝）、审查详情（summary/findings/verifier 验证/review 文件路径）、打开 review 会话 |
| [`src/m3-e2e.ts`](../../../src/m3-e2e.ts) / [`src/m3-e2e-support.ts`](../../../src/m3-e2e-support.ts) | 真实宿主 15 步驱动：review pass→合并、needs_revision→修复→复审→合并；证据 `.dsh-cowork/e2e/M3_E2E.json` |
| [`src/index.ts`](../../../src/index.ts) | `/dsh-cowork/e2e/m3/run` / `status` 两条 loopback 路由 |
| [`tests/`](../../../tests) | `review` / `m3-e2e` / store / session-slice / api / panel-model 覆盖；全量 330 用例（M3 交付时 309；M3-FIX 新增 21） |

## review 门禁（现在为真）

- `cowork_review_request(threadId)`：master 或本项目 thread 调用；要求 thread `awaiting_review`；重复 pending 拒绝；建 `cowork-reviewer` 会话（cwd 主仓库、标题 `cowork review: <subject>`、preset 不符 fail-closed）；**先写索引 pending 再 prompt**，prompt 失败回滚三个字段并归档会话；brief 含 handoff 路径、changedPaths、verification、checkoutPath/分支。
- `cowork_review_verdict(threadId, verdict, summary, findings?, verification?)`：**只接受该 thread 索引里的 `reviewerSessionId`**；master/thread 调用被显式拒绝（自审）；`needs_revision`/`reject` 至少一条 finding；**先写 review 文件再写索引**；`pass→done`、`needs_revision→active` 并把 findings 投递给原 thread、`reject→blocked` 并投递；投递失败只进 `deliveryError`。
- 合并：默认要求 `reviewStatus=pass`；`allowUnreviewed:true` 必须配非空 `overrideReason`，理由清洗后追加进合并提交信息并回显；M2 teardown 语义未改。
- 工具计数：9 → 11（另有 2 个探针工具，运行中 `Tool.listTools` 可见 13 个 cowork_*）。

## 真实宿主 E2E（通过）

- 证据：`.dsh-cowork/e2e/M3_E2E.json`，run `m3-d06cc6a6-3a97-4d3d-8cfc-92a2220ad1f7`，`state=done`、`error` 缺失、**15/15 步 passed**；证据 124,666 B。
- 关键证据字段：thread A pass review 文件 + 索引 `done/pass` + merge commit `2aa02856ba903cd8e72705a561cae19a2f89a926` + 主仓 `e2e-a.txt=M3-E2E-PASS`；thread B 首轮 `needs_revision`（finding `M3-E2E-1`）+ 索引 `active` + findings 投递，修复后二轮 `pass` + merge commit `6981bb94aced9b60fe390a944775f4f5e31e0417` + `e2e-b.txt=M3-E2E-FIXED`；cleanup 存档 3 个 reviewer session、review 文件原文、最终索引与 2 条 merge commit、`tempRepoRemoved=true`。
- 观察到的产品行为：t8 人格更新后，master 在收到 handoff 的自主回合里**自己调用** `cowork_review_request`；E2E 用 `planReviewRequest` adopt 它，未重复请求；reviewer 的确定性 verdict 指令以 `mode:'steer'` 在首轮判定前送达。

## 面板（真机验证：分栏与 ≤480 钻取）

- 字段：`/api/cowork.overview` 返回 `reviewStatus/reviewedAt/reviewerSessionId`；`/api/cowork.handoff` 返回 `review.record/filePath`；缺字段/指针文件删除为 null，坏文档 `store/corrupt`；仍只读、无 POST。
- 客户端：徽章带可见文本与 title 时间；详情审查区展示 verdict、reviewedAt、reviewer 短 id、summary、findings（severity/problem/requiredFix/file:line）、reviewer verification、review 文件绝对路径；`reviewerSessionId` 存在时「打开 review 会话」可用（`uiWorkspace.openSession`）。
- 真机：重启宿主并 clean re-inject 后，原包 client 在真实 Chrome 加载成功（底栏「打开 Cowork 面板」出现）；应用 fixture 后 overview 返回 5 个 thread 与 chips（进行中 2 / 待审查 1 / 受阻 1 / 已完成 1 / 新建 0），列表同时显示「审查中 / 已拒绝 / 需修改 / 审查通过」徽章；needs_revision 详情显示 summary、两条 findings（severity/problem/requiredFix/file:line）、reviewer 验证、review 文件绝对路径与「打开 review 会话」。截图见 `.dsh-cowork/e2e/panel-m3/`：`01-split-review-states.jpg`（分栏列表 + pending review 区）、`02-drill-list.jpg`（≤480 列表）、`03-drill-needs-revision.jpg`（≤480 详情 + findings）。

## 四条命令（M3-FIX 最终代码字节）

`npm run check` exit 0；`npm test` **330/330**；`npm run typecheck` exit 0；`npm run build` exit 0（`lib/client.js` 69 KB）；构建后 health 200、M3 路由对未知 runId 返回 404。M3 交付时这四条为 309/309，M3-FIX 新增 21 个用例。

## 验收对照

| id | 结果 | 证据 |
|---|---|---|
| M3A1 request 建独立 review 会话、brief 含四类字段 | 通过 | `m3-e2e` review-a-request / review-b-request（master 自主请求 + adopt）；`tests/review.test.mjs` |
| M3A2 verdict 只认 reviewer，自审拒绝；文件先于索引 | 通过 | `src/review.ts` 调用者门；`src/tools.ts` 写序；`tests/review.test.mjs` + E2E review 文件 |
| M3A3 pass/needs_revision/reject 路由与 findings 投递 | 通过 | E2E thread A/B；`tests/review.test.mjs` |
| M3A4 合并默认 pass + 显式覆盖 | 通过（host 行为） | `src/tools.ts` merge 门禁；`tests/review.test.mjs`；E2E 两次 pass 合并 |
| M3A5 reviewer preset 可创建、无 tool-fs、真实跑验证 | 通过 | E2E reviewer 运行 `test -f` 并写 verdict；`src/presets.ts` |
| M3A6 overview/handoff review 字段、旧索引兼容、面板徽章/详情/跳转 | 通过 | `tests/api*.test.mjs`、`tests/panel-model.test.mjs`；真机截图 `01`/`02`/`03`（review 徽章、findings、review 文件、打开 review 会话按钮） |
| M3A7 真实宿主 E2E：pass→合并、needs_revision→修复→复审→合并 | 通过 | 上面的 run 15/15 |
| M3A8 两档真实 Chrome 截图 | 通过 | `.dsh-cowork/e2e/panel-m3/01-split-review-states.jpg`（1458×824 分栏）、`02-drill-list.jpg` 与 `03-drill-needs-revision.jpg`（900×900 下右侧栏 <480 钻取） |
| M3A9 文档与发布 | 通过 | 本文、`M3_PROBE_RESULT`、PLAN/KNOWN_ISSUES/PANEL_RESULT/M3_HANDOFF 同步、publish 分类、提案迁入 implemented |

## 限制（不修项见 KNOWN_ISSUES）

1. **旧 fiber 会让面板 API 悬挂**：首次重试时 self-heal/reload 留下了 pre-M3/旧 fiber，`/api/cowork.overview` 等请求 >25 s 不返回；clean uninject → clear routes → inject 后同一进程内 API 立即恢复（本次截图的 overview/handoff 都来自真实宿主）。宿主会话列表本身约 1.2 MB、冷启动约 17 s，仍偏慢。**M3-FIX 已加 30 s 有界等待与 `session/list-timeout` 504（KI-12 关闭）。**
2. **同名包 client 不生效**：`client-modules` 的 pkgMeta 缓存按 loader name+baseUrl 缓存且不失效；本轮用临时改名包加载 client，交付包在当前进程内仍可能不加载 client，正式安装/重启后正常。
3. **reviewer 仍可用 bash 写文件**：工具面已无 write/edit，但 bash 能写；靠 persona 与 review 文件证据约束，不是只读沙箱（KI-15）。
4. **merge 覆盖可绕过 review**：默认 pass 门禁 + 显式 `allowUnreviewed+overrideReason`（理由进提交信息）；这是已定的可操作性取舍，不是审批流。
5. **cowork 会话能看到 profile 全局 dev_*/host 工具**：master 在 t4 的自主回合里用过 `dev_plugin_status`/`dev_reload_package`；已用 persona 明令禁止并让 E2E 通过，但工具面没有硬限制（M1 S0 事实）。
6. ~~**失败 E2E 留下夹具**~~：M3-FIX 起 `execute()` finally 在 done/failed 后删除 `.dsh-cowork/e2e/m3-repo`，删除失败只进 `cleanup.errors`；真实失败 run 已实测（KI-13 关闭）。
7. ~~`src/tools.ts` 51,184 B~~：M3-FIX 拆出 `src/review-tools.ts` 后 42,704 B，并新增 `tests/source-budget.test.mjs` 的 51,200 B 上限（KI-14 关闭）。

本阶段自己产生的遗留与修复顺序见 [M3 修复交接](../handoffs/M3_FIX_HANDOFF.md)：M3L-1..6 已在 M3-FIX 内关闭，只有 M4/宿主约束与已接受设计取舍留在 KNOWN_ISSUES。

## M3-FIX 收口（2026-11-06）

- 范围与决策：见 [M3 收口修复决策](../../../.agents/notes/implemented/bug-fix/2026-11-05-m3-closeout-fixes.md)（本目录的提案已按生命周期迁入 implemented）。
- 代码：`src/api.ts` / `src/api-contract.ts` 的 30 s 有界等待与 `session/list-timeout` 504；`src/m3-e2e-support.ts` 的 `shouldRemoveFixture` 与 `src/m3-e2e.ts` 失败清理；`src/review-tools.ts` + `src/tools.ts` 装配；`tests/source-budget.test.mjs`。
- 工具：`tools/panel-fixture.mjs`（apply/restore；备份在 `.dsh-cowork/e2e/panel-m3/backup`）与 `tools/check-evidence-marker.mjs`（commit==HEAD、screenshots 非空、status 合法；marker 缺失 exit 0）。
- 真实宿主 E2E：`m3-004629a6-c7de-48c1-92e9-99c474eae1a1`，`state=done`、15/15、`tempRepoRemoved=true`、两次合并 `ee9f5a45605a69c5a9fa14db71245df625aa5643` / `89190c478e9a5c80b4ef0a12565c419cf4281cec`；失败路径 `m3-565e31d8-08c0-4247-b3ec-d3fef52dd51d` 在 `thread-a-create` 因 runner disposed 失败，fixture 被 finally 删除且证据保留原始 error（本地副本 `.dsh-cowork/e2e/M3_E2E.failure-cleanup.json`）。
- 面板真机补验：`04-dark-review-states.jpg`（深色下 review 徽章与 findings；本部署设置写入不持久，用 `data-ds-dark-theme` 强制暗色 token，计算背景 `rgb(21,21,23)`，实际手段如实记录）、`05-drill-pass-detail.jpg`（≤480 pass 详情）、`06-drill-reject-detail.jpg`（≤480 reject 详情，含 blocker finding 与 exit 1 chip）。两个打开按钮：pending review 的「打开 review 会话」导航到真实 master 会话（`session-65c8337f…`，`cowork master`）；真实 thread「路由演示」的「打开 thread 会话」导航到 `cowork: 路由演示`（`session-a9072f0b…`）。fixture 中指向已归档会话的按钮会让主工作区回到「选择一个工作区」，这是宿主对不存在会话的行为，面板无法预判，记录为观察到的限制。
- 证据 marker：`.dsh-cowork/e2e/M3_DOCS_READY.json` 在最终提交后重写，`node tools/check-evidence-marker.mjs` exit 0；旧 marker 的 commit 失配已被脚本当场拦下。
- 独立复查：见 `.dsh-cowork/e2e/M3_DOCS_READY.json` 的 `m3FixReview`（AgentTeams verifier + reviewer 的结论与轮次）。

## 回滚

- 代码：按提交 revert M3 的 host、panel、E2E 三个合并提交；`main` 未改动。
- 数据：reviews/ 与索引 review 字段只增；回滚代码不清数据，旧字段忽略。
- 运行时：`dev_uninject_plugin dsh-cowork`；已创建的 review 会话不影响项目数据。
- 面板：client bundle 与 host API 分开提交，可单独回退。
