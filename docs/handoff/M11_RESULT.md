# M11 交付结果

- 状态：**M11 已交付（2026-11-08）**。HTTP API v2（wire/读路由/写路由/同源安全）、CoWork 面板 v2 重写与 v2 面板 fixture 已在 `feat/m11-http-api-panel` 上落地；独立验证（t5）与独立审查（t6，verdict=pass）通过，代码 artifact 为 `6b7beab`（`npm test` 732/732）。delivery 的最终 HEAD/PR 见后续 delivery 小节。本文件记录交付基线、交付面、A1–A10 证据、审查结论、已知偏差、回滚与未验证项，供 M12 接手。M11 启动时的交接见 [M11_HANDOFF.md](M11_HANDOFF.md)（保留启动版，顶部状态块指向本文件）。
- 适用：接手 V0.2 M12（文档、真实 E2E、0.2.0）的 agent 或人。范围：M11 的实际交付、验证证据、偏差与未验证项；不重新论证 M11 的决定。
- 事实源：[PLAN-V0.2](../PLAN-V0.2.md) §2.2/§2.3/§2.4/§4.2/§5.3/§5.6/§5.9/§5.10/§6 M11 拥有需求与验收；执行层决定与备选由 [M11 决策记录](../../.agents/notes/implemented/architecture/2026-11-08-m11-http-api-panel.md) 拥有；面板交互与可见性由两份 implemented 记录拥有（[面板与会话可见性](../../.agents/notes/implemented/feature/2026-11-07-panel-and-session-visibility.md)、[可见性降级决策](../../.agents/notes/implemented/feature/2026-11-07-topic-visibility-fallback.md)）；[KNOWN_ISSUES](../KNOWN_ISSUES.md) 拥有遗留归属；本文件只拥有「交付了什么、拿什么证明、从哪继续」。
- **数字口径**：最终数字来自集成 commit `6b7beab`（t5 复验）：`npm test` **732/732**、`git diff 6a5310e..HEAD | shasum -a 256` = `e1e0f88d…`、四命令 exit 0。review 阶段（t6）读的是同一 HEAD；本批文档提交只改 `docs/**` 与 `.agents/notes/**`，代码 artifact 不变。

## 交付基线

- **分支**：`feat/m11-http-api-panel`，从 M10 交付后的 `main`（`6a5310e`）切出；未 push、未合并。
- **代码 artifact（integration-ready，2026-11-09T04:08Z）**：HEAD `6b7beab01ddd4d1ff1370187802a965a5019e1fd`；base `6a5310e`；`git diff 6a5310e..HEAD | shasum -a 256` = `e1e0f88dabf4eff5390ea6203b84bb06899a7d6870f15553f96a972b22e85669`；`git status --porcelain` 空；`lib/client.js` sha256 `3b1b3588a72b7b0ad7608511149e9f10b52cfd271007b8dd2896bc59c896ab47`（多份 marker/run 记录一致）。
- **提交序列（`6a5310e..6b7beab`，17 个路径：`src/` 12、`tests/` 4、`tools/` 1）**：
  - `b956497` feat(api): rewrite the panel wire contract to v2（`src/api-contract.ts` + `tests/api-contract.test.mjs`）。
  - `bb2f56d` feat(api): serve the M11 panel v2 read and write routes（`src/api.ts`、`src/index.ts`、`tests/api.test.mjs`、`tests/dev-gate.test.mjs`、`tools/panel-fixture.mjs`）→ 集成 `46dd1c0`。
  - `3d553b5` feat(client): rewrite the CoWork panel for the v2 topic wire（`src/client/*` 9 文件 + `tests/panel-model.test.mjs`）→ 集成 `6b7beab`。
- **验证基线（`6b7beab`，t5 独立复跑，与集成 marker 逐项一致）**：`npm test` **732 tests / 732 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo**，exit 0（M10 基线 701）；`npm run typecheck` exit 0；`npm run build` exit 0（`lib/client.js` 89,235 B，构建前后 sha 一致）；`npm run check` exit 0（`check-invariants: ok`）。
- **范围证据**：`git diff --name-only 6a5310e..6b7beab` 共 17 个路径；无 `presets/**`、无 `src/store.ts`/`src/route-tools.ts`/`src/review-request.ts` 改动（只读引用）；`src/**/*.ts` 最大仍为 `src/m2-e2e.ts` 49,923 B（<51,200 B）。

## 环境与加载方式

- 宿主：DSH web profile，URL `http://127.0.0.1:3080`；browser-skill 0.4.2；`enableDevRoutes=false`（`/dsh-cowork/probe/*` 404 属预期，不是路线缺失）。
- **插件加载**：dev 注入器 + 别名包 `@dsh-external/dsh-cowork-alias-v1`（从集成 commit 构建的临时副本）。原因：dev 注入路径下宿主按 loader name + baseUrl 缓存 client 元数据（KI-11 pkgMeta）与 Node ESM 模块（KI-16），同名包/同 URL 会命中旧 bundle。**交付包名不变**（`@dsh-external/dsh-cowork`），别名只用于真机验证。
- 未认证 `curl` 对 `/api/cowork.*` 返回 401（宿主 trust fence），但 **401 不是路由注册证据**：未认证访问任意未知 `/api/*` 路径同样返回 401（本次用未知路径验证过）。路由注册与六条路由行为的证据是面板内已认证 same-origin `fetch`：overview/topic/activity 200，写路由 200/403/415/400（A8）。

## 交付面

| 路径 | 角色 | 字节 |
|---|---|---|
| `src/api-contract.ts` | v2 wire：6 条路径、13 条上界常量、`PanelTopic/WorkItem/ReviewRequest/ActivityEvent/InboxItem/Counts/Project`、17 个 `PanelErrorCode`；v1 `PanelThread`/`PanelHandoffRecord`/`HANDOFF_PATH` 删除 | 17,046 |
| `src/api.ts` | 六条路由（overview/activity/topic + resolve/reopen/route.move）、生命周期读取点、同源与 JSON 安全、错误状态表 `Record<PanelErrorCode, number>` | 39,114 |
| `src/index.ts` | 只改装配段：`clock`、`now`、`idleAfterMs`、`resolveAfterMs`、`log` 端口 | 31,874 |
| `src/client/`（9 文件） | `contracts/api/model/list/detail/panel/chips/styles/index`；最大 `model.ts` 21,259 B，合计 111,739 B；`model.ts` 不依赖 React，可单测 | 111,739 |
| `tests/api-contract.test.mjs` | v2 契约、上界、错误码、纯函数 | 18,480 |
| `tests/api.test.mjs` | 读/写路由、边界、安全、真实 `ProjectStore` 集成（真实文件锁） | 63,878 |
| `tests/dev-gate.test.mjs` | 装配门禁：六条 fetch 路由 | 12,451 |
| `tests/panel-model.test.mjs` | client 纯模型：排序/计数/`openTopicSteps`/操作可用性 | 38,104 |
| `tools/panel-fixture.mjs` | v2 fixture：apply/restore、备份/原子恢复、写前自校验、`--repo/--master/--live-topic` | 23,226 |
| `lib/client.js` | `npm run build` 预打包产物（不提交） | 89,235 |

## 完成定义与证据

- [A1] `api-contract.ts` 提供 v2 wire 与上界；v1 `PanelThread`/`PanelHandoffRecord`/`HANDOFF_PATH` 删除；错误信封保持 M3 形状 — `tests`：`tests/api-contract.test.mjs`（19/19）；路径/常量见 `src/api-contract.ts:16-70`，17 个错误码映射见 `src/api.ts:203-221`。
- [A2] overview 读前在锁内评估生命周期并传真实 `activeWorkItemsOf`；返回 v2 主题与计数（≤500），不含 thread/reviewer/handoff 字段 — `tests`：`tests/api.test.mjs`（生命周期用例：有 `reviewing` 工作项的主题不被 resolved、无工作项的被 resolved；501→500；精确键集无 thread/reviewer/handoff）；真实 Chrome overview 200/254 ms、7 主题、counts `active 4/idle 1/resolved 2/blocked 1/awaitingReview 1/pendingReview 1`、`workItem*` 各 1。
- [A3] activity 与 topic 详情有界（activity 默认 50、上限 200；workItems ≤50、reviewRequests ≤10、findings ≤20、verification ≤10、changedPaths ≤50、topic 活动 ≤50），评审请求从 `reviews/*.json` 读取 — `tests`：`tests/api.test.mjs`（含真实 tmpdir 请求文件、坏 JSON/文件名不匹配/legacy 判决文件被跳过、12→10 截断）；真实 Chrome topic 200/200 ms、1 条评审请求（`req-fixture-pass`，1 finding、1 verification）、活动 1 条；activity 200（`requestedLimit=10`，流内 14 条取最新 10、`skippedLines 0`）。
- [A4] resolve/reopen/route.move 只允许 master、要求 `sessionId`、锁内原子且幂等，并写对应活动；缺 content-type 415、坏 Origin/Host 403、body>8KiB 413、坏 JSON 400、错误码可读 — `tests`：`tests/api.test.mjs`（幂等 `alreadyResolved`、reopen 409、route.move 拒绝同主题/空 intent/已解决目标、非 master 403 零写、真实 `ProjectStore` 全链路、活动失败只记日志）；真实 Chrome：resolve 200（`alreadyResolved:false`）→ 二次 200（`true`）；reopen 200（`active`、`resolvedBy:null`）；route.move 200（`changed:true`、首次 added 8、二次 added 5）；`403 request/not-master`（真实非 master 会话）、`415 request/content-type`、`400 request/invalid-body`、`400 session/unknown`、未知路径 404。
- [A5] 左侧栏策略 (b)：主题保留可见、reviewer 不作为行、插件不对主题 `archiveSession`；打开主题只切主区，不新增/移除左侧栏条目，面包屑回 master；预归档主题才 unarchive — `tests`：`tests/panel-model.test.mjs`（`openTopicSteps` 钉死 unarchive→openSession 顺序与「不 archive」）；真实 Chrome 截图 05/06（主区切到主题会话、左侧栏行数不变、面包屑回 master）；预归档会话未在真实 Chrome 覆盖（偏差 D4）。
- [A6] CoWork 是右侧栏 tab，默认 tab 仍是普通会话、不自动打开、footer 入口可用；列表/详情/活动/操作齐全，已解决主题仍列出并显示来源 — `tests`：`tests/panel-model.test.mjs`；真实 Chrome 截图 01–04、06（列表+详情、标记已解决、重新打开、改投表单、面包屑）。
- [A7] 评审卡来自请求文件（requestId/范围/verdict/findings），legacy `latestReviewPath` 不再是当前状态来源；旧 review/handoff 文件只读 — `tests`：`tests/api.test.mjs`（`reviewRequestFileName` 文件名与记录不一致即跳过；`listReviews`/`latestReviews`/`writeReview`/`readReview` 不在 store 端口上）、`tests/source-budget.test.mjs`；`grep -n "latestReviewPath\|listReviews\|latestReviews\|writeReview" src/api.ts` 无匹配；真实 Chrome 评审卡显示 `req-fixture-pass`。
- [A8] 真实 Chrome：同源写路由在已认证面板上下文返回 200 且回显 body；R8 预算、R9 fixture（apply/restore ≤5 s、真实 index hash 恢复）；截图与 run 记录进入本交付记录 — `decisions`：`.dsh-cowork/e2e/m11/panel-run.json`、6 张 jpg、`INTEGRATION_READY.json`（均在 gitignored 目录，不进仓库）。fixture apply 8 ms / 5 ms、restore 5 ms / 5 ms；恢复后 index sha256 `f7fec0db…` 与 pre-fixture 完全一致，reviews 3 个文件还原，activity/inbox 恢复为不存在；`bsk_session` start 3 / stop 1、>60 s 等待 0。
- [A9] `npm run typecheck`/`build`/`check` 通过；`lib/client.js` 由 `npm run build` 产出；`src/**/*.ts` <51,200 B，client 按模块拆分 — `source`：`tests/source-budget.test.mjs`、`scripts/build.sh`；四命令 exit 0（732/732）；`lib/client.js` 89,235 B、sha `3b1b3588…`。
- [A10] M11 收口：M11_RESULT/HANDOFF/KNOWN_ISSUES/publish.json/README/PLAN-V0.2 更新；3 份决策记录迁移为 implemented；AgentTeams 单一评审负责人边界写入记录 — `plan-docs`：本文件、[M11_HANDOFF](M11_HANDOFF.md)、[KNOWN_ISSUES](../KNOWN_ISSUES.md)、`docs/publish.json`、`docs/README.md`、[PLAN-V0.2](../PLAN-V0.2.md)、3 份 implemented 记录。

## 验证与审查

- **独立验证（t5，`6b7beab`）**：四命令 exit 0（`npm test` 732/732、typecheck/build/check 0）；gate artifact 与队长记录逐项一致（HEAD、diff sha、status 空、bundle sha）；定向 4 文件 111 pass；fixture tmp 冒烟（apply→真实 store 读回 7 topics/4 workItems/10 activity/2 inbox/3 reviews；restore 后 sha 回到原值；二次 apply/restore exit 1；非法参数 exit 2）；6 张截图的 bytes/sha 与 `panel-run.json` 一致，状态码/counts/耗时/R8 预算全部对上。findings：F1 medium=A10 文档未收口（由本批关闭）；F2/F3 为 run 记录字段缺口，修复后不复现。
- **独立审查（t6，verdict=pass）**：reviewer 与实现者不同成员，在隔离副本只读执行；A1–A9 逐条 pass（wire 六路径与上界、overview 锁内生命周期与真实计数、activity/topic 有界、写路由 master-only 与幂等、活动行独立取锁、同源/content-type/体积/JSON 校验、client 打开主题与面包屑、fixture 隔离与幂等）；A10 未做即 F1（本批关闭）。R1–R7 全部接受（route.move 追加式收敛、unarchive 仅容错、Origin 只能单测、右栏关闭属宿主行为、复制路径=repoPath、`CoworkStorePort.appendActivity`、PanelCounts 扁平 + inbox）。
- **审查后修复**：F1 由本批文档提交补全；无代码改动、无行为变更，故未重跑全量（本批只跑 `npm run check`、`npm test`、`tests/workflow.test.mjs`）。

## 已知偏差与接受项

- **D1 resolve 幂等**：提案写的是 `topic/already-resolved` 错误码，实际返回 200 + `alreadyResolved:true`（A4 明确要求幂等，错误码会让面板把重复点击显示为失败）；`PanelErrorCode` 未包含该码。
- **D2 route.move 追加式**：重复提交同一 intent 会继续追加剩余 token（每次 ≤8、总数 ≤50、单条 ≤32），不是严格幂等；UI 是一次性操作，`changed/added` 让结果可见（KI-32）。
- **D3 v1 项目首次 overview 触发设计中的迁移**：overview 的读取点在锁内调用 `mutateIndexDocument`，v1 磁盘走 M7 的 on-write 迁移（写 v2 + `index.v1.backup.json` + 生命周期活动）。这是升级行为，不是缺陷；M12 的升级文档必须写「打开面板即迁移」。
- **D4 预归档主题 unarchive 未在真实 Chrome 覆盖**：无真实「已归档且有 repo cwd」的会话，且为测试而归档用户会话会改用户状态；由 `tests/panel-model.test.mjs` 的 `openTopicSteps` 与代码 try/catch 钉住，归 M12 真实 E2E。
- **D5 「复制路径」复制项目 `repoPath`**（按钮 title 已说明），不是主题 cwd；剪贴板写入未断言。
- **D6 `CoworkStorePort` 新增 `appendActivity`**：写路由的活动行与 `evaluateProjectLifecycle` 的 `LifecycleStorePort` 都需要；`ProjectStore` 结构满足。其余端口为 `hasIndex/readIndexDocument/mutateIndexDocument/readActivity/readInbox/readText/reviewsDir`。
- **D7 `PanelCounts` 扁平字段 + overview 带未投递 inbox**：counts 为 10 个扁平计数（非嵌套），overview 还返回 ≤20 条未投递 inbox（面板「待处理」chip）；评审状态与计数同源，不为每种状态单独开字段。
- **D8 打开主题后宿主右栏可能关闭**：新会话没有右栏历史，宿主按会话记忆右栏状态；不是插件调用，左侧栏无增删（R4）。
- **reopen 不清 `reviewStatus`/`latestReviewRequestId`**：重开只清 `resolvedAt/resolvedBy` 并回 `active`；评审事实保留（历史可审计），面板按字段区分展示。

## 交付记录（2026-11-08）

- **分支与 PR**：`origin/feat/m11-http-api-panel` 已推送；PR [#16](https://github.com/leigangzhang/dsh-cowork/pull/16)（base `main`，未合并，等待确认；不进入 M12）。
- **代码 artifact 不变**：`6b7beab`（本文件、`KNOWN_ISSUES`/`HANDOFF`/`publish.json`/`README`/`PLAN-V0.2` 与 3 篇决策记录的迁移在 `f60e187`；本交付记录与 `f60e187` 一样只改文档，不改变代码 artifact）。
- **最终门禁**：文档提交后在分支 tip 上跑 `npm run typecheck`/`build`/`test`/`check` 全部 exit 0（`npm test` 732/732）；`npm run check`（publish 分类、notes 骨架、链接）与 `node --test tests/workflow.test.mjs` 通过；`git status --porcelain` 空。
- **运行环境清理**：临时别名包（`@dsh-external/dsh-cowork-alias-v1`）已从宿主卸载、junction 与临时目录删除；宿主 profile patch 中本次新增的别名条目已移除（保留原有 `dsh-cowork`/`dsh-cowork-panel` disabled 行）；两个实现 worktree 已清理（分支已合并）。真实 `.dsh-cowork` 数据保持 v1 预验证状态（`index.json` sha256 `f7fec0db…`，3 threads，reviews 3 个旧文件，无 activity/inbox/backup）。
- **遗留**：KI-31（正式 bundle 安装路径未验证）、KI-32（route.move 追加式）、KI-33（文档索引漂移）由 M12 处理；KI-18/KI-22/KI-28 已更新。

## 回滚

- **代码**：按提交逆序 `git revert`（`6b7beab` 集成 → `3d553b5`、`46dd1c0` → `bb2f56d`、`b956497`）。wire 与 client 是成对破坏性变更：host 与 `lib/client.js` 必须同批回滚/重装，旧 client 配新 host（或反之）不可用。
- **数据**：M11 只读 canonical v2 与评审请求文件；写路由只写 `resolved/resolvedBy/resolvedAt`、`reopened`、`aliases` 与对应活动。回滚代码不需要数据迁移；已写入的业务状态与活动保留。若真实 v1 项目已被首次 overview 迁移（D3），回滚前用 `index.v1.backup.json` 还原 index 并删除新增的 activity（本次验证即按此路径恢复）。
- **文档/记录**：revert 本批文档提交；3 份记录回到 `proposed/`，`docs/publish.json` 的 M11_RESULT 条目随之回滚。不要 force-push。

## 未验证（归 M12 / 后续）

- 正式 bundle 安装路径（`npm pack` → profile add → 重启）未验证 v2 client；本次用 dev 注入器 + 别名包绕过宿主缓存（KI-31）。
- 真实 v1 数据的迁移与回滚演练（备份、归档失败、回滚）仍归 M12（KI-22）；本次只观察到首次 overview 触发迁移并恢复。
- 真实 Chrome 的 Origin 伪造（浏览器 forbidden header，只能单测）、剪贴板写入、移动端/多窗口/headless 差异未验证。
- live reviewer 在宿主左侧栏仍可能可见（KI-28 接受上限）；无会话过滤接口。
- 跨会话全链路 E2E（路由→主题→评审→verdict→合并→已解决→重开→活动流）归 M12（KI-22）；M11 只验证面板/API 自身。

## 指针

- M11 决策记录（implemented）：[2026-11-08-m11-http-api-panel.md](../../.agents/notes/implemented/architecture/2026-11-08-m11-http-api-panel.md)。
- 面板交互与可见性（implemented）：[2026-11-07-panel-and-session-visibility.md](../../.agents/notes/implemented/feature/2026-11-07-panel-and-session-visibility.md)、[2026-11-07-topic-visibility-fallback.md](../../.agents/notes/implemented/feature/2026-11-07-topic-visibility-fallback.md)。
- M11 启动交接（历史）：[M11_HANDOFF.md](M11_HANDOFF.md)；M10 交付结果：[M10_RESULT.md](M10_RESULT.md)。
- 需求与验收：[PLAN-V0.2](../PLAN-V0.2.md) §2.4/§5.9/§6 M11；流程与证据：[agent-teams](../agent-teams.md)、[testing](../testing.md)。
- 真实 Chrome 证据（gitignored）：`.dsh-cowork/e2e/m11/panel-run.json`、6 张 `*.jpg`、`INTEGRATION_READY.json`、`pre-fixture.json`。
