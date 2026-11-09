# Proposal: M12 文档、真实 E2E 与 0.2.0 发布

Status: proposed
Date: 2026-11-08
Class: architecture

## Problem

M11 已把面板与 HTTP API 切到 canonical v2（wire、读写路由、client 重写、真实 Chrome 面板验证；代码 artifact `6b7beab`，`npm test` 732/732，独立审查 pass）。0.2.0 仍缺四件互相依赖的事，缺任何一件都不能宣称可发布：

1. **没有一条真实全链路 E2E**。PLAN §6 M12 要求 master 初始化 → 路由新主题 → 主题可见并经 CoWork 打开 → 提交评审 → reviewer verdict 后归档 → master 只收合并决定 → 自动/手动 resolve 与 reopen → 活动流 → 隔离 clone 合并。现有 `src/m2-e2e.ts`/`src/m3-e2e.ts` 是 v1 thread 语义的 dev 驱动（KI-29），不能用来验证 M10/M11 的工具链；`tests/m12-e2e.test.mjs` 与 `src/m12-e2e.ts` 不存在。
2. **真实 v1 数据的迁移与回滚未演练**（KI-22）。M11 只在真实数据上观察到「首次 overview 触发生命周期写 → M7 on-write 迁移」并随即用 `index.v1.backup.json` 恢复；备份完整性、归档失败、二次读取幂等、回滚步骤都还没有一次可复现的演练。升级用户没有可依赖的迁移/回滚说明。
3. **正式安装路径未验证**（KI-31）。M11 因为宿主 client pkgMeta 与 Node ESM 缓存（KI-11/KI-16）用 dev 注入器的别名包做真机验证；`npm pack` → 新 profile add → 重启后 v2 client、六条 `/api/cowork.*` 路由与四个 preset 是否可用没有证据。0.2.0 的打包产物也从未检查过清单与版本。
4. **面向用户的文档仍是 0.1.0 形态**。`README.md` 没有 0.2.0 的破坏性变更、升级/回滚与迁移说明；`docs/routing.md`/`docs/context.md` 仍是 M4 时代的 thread 叙述；`docs/glossary.md` 没有 v2 术语（topic/work item/review request/reviewer/inbox/activity）；KI-22/29/31/32/33 未关闭或未重新指派；`docs/M12_RESULT.md` 与 0.2.0 的 release 记录都还不存在。

后果：新用户与升级用户都缺乏可执行的安装/迁移路径；评审—合并—resolve 链只有 fake host/单测证据，跨会话回归没有门禁；PR #16 之后 0.2.0 无法收口。

## Proposal

**1) 基线与阶段边界。** 新会话从 M11 交付后的 main 开 `feat/m12-docs-e2e-0.2.0`：若 M11 PR #16 已合并，用 `origin/main` 的 merge sha；未合并时用 `origin/feat/m11-http-api-panel` HEAD `c9c74f4`，记录实际 sha，不猜测、不 rebase、不 force。基线四命令 `npm test`（期望 732/732）、`npm run typecheck`、`npm run build`、`npm run check` 全绿后才改代码。M12 不新增业务工具/预设，不改 canonical v2 数据语义。

**2) 真实 E2E 驱动（M12.3）。** 新增 `src/m12-e2e.ts`（可拆 `src/m12-e2e-support.ts` 承载主流程），仿 `src/m3-e2e.ts` 的 dev 门形态：

- 路由只在 `Config.enableDevRoutes=true` 时注册：`/dsh-cowork/e2e/m12/run`（启动一次 run，立即返回 runId）与 `/dsh-cowork/e2e/m12/status`（轮询 `state`、`steps[]`、`error`）。
- 运行在**临时仓库**（配置的 `repoPath`，默认 `os.tmpdir()` 下新建），不碰真实 `.dsh-cowork`；run 结束按 `cleanup` 归档本次创建的 master/topic/reviewer 会话、删除临时仓库（可 `keep` 留证）。
- 按 PLAN §6 M12 的顺序执行并逐步断言：`cowork_project_init` → `cowork_route` 新建主题 → 左侧栏可见（宿主 `sessionController.list` 含该会话）→ 面板 `sessionId` → topic 打开语义（`uiWorkspace.openSession` 的宿主侧等价断言 + `/api/cowork.overview` 含该主题）→ `cowork_review_request`（pending 请求文件）→ reviewer verdict（绑定 requestId、reviewer 在 verdict 后归档、master 只收到合并决定）→ `cowork_work_item_create` + 隔离 clone 内提交 → `cowork_checkout_merge` 成功且 main 不动 → 自动 resolve（短阈值 `idleAfterMs=500`、`resolveAfterMs=1000`）→ 不撤销 → 手动 `cowork_topic_reopen` → resolved 主题不再自动接收 → `activity.jsonl` 事件齐全。
- 每一步记录 `{ step, startedAt, endedAt, ok, evidence }`，run 结束写 `<repoPath>/.dsh-cowork/e2e/M12_E2E.json`（带 artifact identity：`git rev-parse HEAD`、`git diff <base>..HEAD | shasum -a 256`、`git status --porcelain` 空、pluginVersion）。面板侧断言优先用宿主内 `connection.fetch` 的 `/api` 通道（`ctx.connection.createSharedFetchHandler('/api')` 或 browserPeer 的进程内调用），避免 cookie/token；不可用时退回 store 级映射断言，并在结果里标「未核实」。
- 新增 `tests/m12-e2e.test.mjs`：host-free 契约测试钉住步骤清单与顺序、每步的断言面、`M12_E2E.json` 形状、失败即停与 cleanup 语义；不启动真实宿主。

**3) 迁移演练与回滚（M12.4）。** 新增 `tools/m12-migration-drill.mjs`（或并入 m12 驱动的一个阶段）：
- 输入一份 v1 index 快照（真实数据脱敏副本或 `tests` 里构造的全字段 v1 文档，含 `reviewStatus/reviewerSessionId/latestReviewPath` 与一条 pending 评审），复制进临时仓库；
- 触发首次写（overview 生命周期或 `cowork_project_init`/resolve），断言：v2 文档形状、`index.v1.backup.json` 与原始 v1 逐字节一致、活动行、第二次读/写不再迁移（幂等）、reviewer 归档失败时记录 `archiveFailures` 而非伪成功（KI-19 的边界）；
- 回滚演练：用备份恢复 index 后，删掉的 `activity.jsonl`/`inbox.json` 与 reviews 文件集合回到迁移前，`store.readIndex` 能重新读旧文档；
- 输出 JSON 证据（时间、hash、steps），归入 `.dsh-cowork/e2e/M12_E2E.json` 或独立 `M12_MIGRATION.json`；同时在 `docs/M12_RESULT.md` 写清「用户首次打开面板即迁移」的升级行为（M11 D3）。

**4) 正式安装路径与 0.2.0 打包（M12.5）。**
- `package.json` 版本升到 `0.2.0`（README/发布记录同步）；仓库无 lockfile（项目只有 devDependencies，`npm pack` 产物不含锁文件），在 M12_RESULT 记录这个事实而不是凭空加锁文件。
- `npm run build` 后 `npm pack`，检查 tarball 清单只含 `lib/**`、`cordis.patch.yml`、`README.md`、`LICENSE`、`package.json`；在新 profile（`dsh --profile m12verify --from-default-profile web`）执行 `dsh plugin --profile m12verify add <tgz>`，重启一个独立端口宿主（如 3091），记录启动 URL。
- 在该宿主上验证：四个 preset 可选、15 个业务工具存在、六条 `/api/cowork.*` 路由已注册（面板内已认证 fetch 200；未认证 401 不能作为注册证据，见 M11_RESULT 的更正）、v2 client 出现在 boot 列表、真实 Chrome 打开面板并截图。
- 用同一 profile patch 的 `enableDevRoutes: true` 与临时 `repoPath` 跑一次 M12 真实 E2E，证明「已安装包」而非 dev 注入；结束后卸载（`dsh plugin --profile m12verify remove`）并确认 `.dsh-cowork` 数据保留。
- 认证边界：第二个宿主的浏览器认证使用其启动输出里的已认证 URL；不读取、不写入、不转述 cookie/token；建立不了认证就记录为未验证，不用 curl 绕过。

**5) 文档发布面（M12.2）。**
- `README.md`：0.2.0 用户指南——它是什么/装什么、preset 选择、主题与 reviewer 可见性（决策 b，KI-28 上限）、安装/升级/卸载、首次打开的迁移与 `index.v1.backup.json`、0.2.0 破坏性变更（v1 thread wire、`/api/cowork.handoff` 移除、面板改为 v2）、回滚（revert + 恢复备份 + 重装 0.1.0）。
- `docs/routing.md`、`docs/context.md`：按 v2 术语重写（topic、work item、review request、reviewer、inbox、activity、route correction）；旧 thread 图只保留在 `docs/archived/`（若要保留历史，先归档再写新页，不在同一页混两代语义）。
- `docs/glossary.md`：补 topic/work item/review request/reviewer/inbox/activity/resolved(reopen)/route correction 等术语与出处（链接源码/PLAN，不复制接口）。
- `docs/KNOWN_ISSUES.md`：关闭 KI-22/29/31/32/33（给出证据指针）或改归属；保持 KI-28 等接受上限；新增 M12 期间发现的遗留必须写完成阶段。
- `docs/M12_RESULT.md`（新）：A1–A10 证据、真实 E2E run、迁移演练、安装/卸载、破坏性变更与回滚、偏差、未验证项。
- `docs/M12_HANDOFF.md`（新）：下一阶段的启动交接；`docs/publish.json` 为两个新文件各加 internal 条目；`docs/README.md` 加 M12 行。
- 收口顺序按 `docs/AGENTTEAM.md` R10：实现/文档 → integration-ready → verification → review → 一次性修复 + 文档同步 → final integration → delivery（PR）。

**6) 不发布 GitHub Release、不部署生产。** 0.2.0 的 tag/Release 与对外发布需用户另行确认；M12 只交付可安装的 tgz 与 PR。

## Alternatives considered

**继续用 `src/m2-e2e.ts`/`src/m3-e2e.ts` 当验收。** 否决：它们编码 v1 thread/review/allowUnreviewed 语义（KI-29），跑通也不证明 M10/M11 的工具链；照旧跑会得到误导性的绿色。

**只在 fake host/单测里验证，不做真实 E2E。** 否决：PLAN §7 明确要求跨会话/跨进程改动必须真实 DSH E2E；reviewer→verdict→inbox→resolve 的投递与 session 生命周期在 fake host 里没有等价物。

**真实 E2E 直接跑在用户 web profile / 真实 `.dsh-cowork`。** 否决：会创建/归档用户会话并可能触发真实数据迁移（R9 与 KI-13 的同类风险）；用临时仓库 + 独立 `m12verify` profile 才能重复且可回滚。

**继续用 dev 注入器别名包验证 0.2.0 面板。** 否决：KI-31 要验证的正是 `npm pack` → 安装 → 重启路径；别名包绕过的恰是待验证的缓存与装配环节。

**只写文档、把真实 E2E 与迁移演练再推给下一个阶段。** 否决：0.2.0 是 V0.2 的收口阶段；KI-22 已从 M7 挂到 M10、M11，再推会让发布带着未验证的跨会话链路。M12 之后没有既定的下一阶段可承接。

**给仓库补 lockfile、上 npm 发布。** 否决：插件是 `private: true` 的 bundle 包，只有 devDependencies，发布形态是 profile 安装；补 lockfile 与 npm 发布都超出 0.2.0 的范围。

## Acceptance criteria

- [A1] 真实 v1→v2 迁移演练：临时仓库上触发首次写后得到 v2、`index.v1.backup.json` 与原始 v1 逐字节一致、第二次写不再迁移、用备份回滚后读回旧文档 — `tests`（`tests/m12-e2e.test.mjs`）+ `node tools/m12-migration-drill.mjs` exit 0 与证据 JSON + `plan-docs`（M12_RESULT 指针）。
- [A2] 真实全链路 E2E 在真实宿主上通过一次，逐步证据写入 `.dsh-cowork/e2e/M12_E2E.json` — `source`（`src/m12-e2e.ts` 的 run/status 路由）+ `tests`（步骤契约）+ `plan-docs`（M12_RESULT A8）。
- [A3] reviewer 生命周期：请求 pending → verdict 绑定 `requestId`/`reviewerSessionId` → verdict 后 reviewer 归档 → master 只收到合并决定 — `tests`（M12 E2E 步骤断言 + `tests/review-verdict.test.mjs` 回归）。
- [A4] resolve/reopen 边界在真实 E2E 中成立：自动 resolve、手动 resolve 不撤销、reopen 清 `resolvedAt/resolvedBy`、resolved 主题不再自动接收 — `tests`（M12 E2E 步骤 + `tests/topic.test.mjs` 回归）。
- [A5] 隔离 clone 全链路：`cowork_work_item_create` → clone 内提交 → `cowork_review_request` → pass → `cowork_checkout_merge` 成功且 main 不动 → 清理 — `tests`（M12 E2E 步骤 + `tests/checkout.test.mjs` 回归）。
- [A6] 正式安装路径：`npm pack` 清单正确；干净 profile add + 重启后 preset/工具/六条路由/v2 client 可用；真实 Chrome 面板打开并截图 — `packaging`（`tests/packaging.test.mjs` 与 `package.json` 版本）+ `plan-docs`（M12_RESULT 安装证据）。
- [A7] 卸载保留 `.dsh-cowork` 数据；README 的升级/回滚步骤可执行 — `packaging`（安装/卸载记录）+ `plan-docs`（README 审阅）。
- [A8] README 写明 0.2.0 破坏性变更、首次打开即迁移（含备份文件）、回滚与 KI-28 限制 — `plan-docs` + `publication`（`npm run check` 的分类与链接门禁）。
- [A9] `docs/routing.md`/`docs/context.md` 按 v2 重写或归档、glossary 更新、KNOWN_ISSUES 的 KI-22/29/31/32/33 关闭或转归属、`docs/M12_RESULT.md`/`docs/M12_HANDOFF.md` 分类进 `docs/publish.json` — `publication`（`npm run check` 未分类 .md 会红）+ `tests`（`tests/workflow.test.mjs`）。
- [A10] 最终 HEAD 上 `npm test`、`npm run typecheck`、`npm run build`、`npm run check`、`npm run check:self-test` 全绿；`src/**/*.ts(x)` <51,200 B；`package.json` 版本 0.2.0；delivery 记录 HEAD/diff sha/status/PR — `source`（`tests/source-budget.test.mjs`）+ `workflow`（`npm run check:self-test`）+ `plan-docs`（M12_RESULT）。

## Risks

- **真实 E2E 的模型调用成本与不稳定性。** 每个 reviewer 会话都是一次真实 LLM 回合；用短阈值、事件等待、固定步骤与「只保留最终一次通过」控制成本（R2/R5）；失败重跑前先把失败固化成 host-free 断言。
- **迁移演练的归档依赖。** v1 的 pending 评审在迁移时会尝试归档 reviewer；失败会进 `archiveFailures`，演练必须覆盖并如实记录，不能把失败写成成功。
- **第二个宿主的浏览器认证。** 独立端口/新 profile 的认证 URL 可能拿不到；拿不到就记录未验证，不改配置去放宽认证，不读 cookie/token。
- **文档双真相源。** README 面向用户、M12_RESULT 面向证据、PLAN 面向范围；同一事实只放一处，其余链接。旧 thread 图若与新页并存必须归档，不得留在当前文档里。
- **KI-11/KI-16 的缓存**。安装路径理论上不复现，但验证时仍要先确认 boot 列表里的 client id/URL 是安装包的 `lib/client.js`，再下结论。
- **范围蔓延。** M12 不做移动端、多窗口、headless 差异、词义以外的新功能；发布 Release 需用户确认。重审条件：真实 E2E 单次通过超过 30 分钟，或迁移演练需要改动 store 语义。

## Delivery stages

1. **基线 + 文档骨架**：分支、四命令基线、README 0.2.0 初稿、M12_HANDOFF 的启动段；先让文档与验收面可见。
2. **m12-e2e 驱动 + 契约测试**：`src/m12-e2e.ts`（dev 门）、`tests/m12-e2e.test.mjs`；先 fake-host 绿，再真实宿主跑一次。
3. **迁移演练与回滚**：`tools/m12-migration-drill.mjs` + 证据 JSON；覆盖 pending reviewer 归档失败与二次写幂等。
4. **打包与安装路径**：0.2.0 版本、`npm pack`、`m12verify` profile、独立端口宿主、真实 Chrome 面板、跑已安装包版 E2E、卸载。
5. **收口**：M12_RESULT、M12_HANDOFF、KNOWN_ISSUES、publish/README/routing/context/glossary；四命令 + check:self-test；verification → review → 一次性修复 → delivery PR；不发布 Release。
