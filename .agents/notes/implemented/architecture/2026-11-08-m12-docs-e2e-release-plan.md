# Decision: M12 文档、真实 E2E 与 0.2.0

Status: implemented
Date: 2026-11-08
Class: architecture

## Problem

M11 把面板与 HTTP API 切到 canonical v2（wire、读写路由、client 重写、真实 Chrome 面板验证；代码 artifact `6b7beab`，`npm test` 732/732，独立审查 pass）。0.2.0 仍缺四件互相依赖的事，缺任何一件都不能宣称可发布：

1. **没有一条真实全链路 E2E**。PLAN §6 M12 要求 master 初始化 → 路由新主题 → 主题可见并经 CoWork 打开 → 提交评审 → reviewer verdict 后归档 → master 只收合并决定 → 自动/手动 resolve 与 reopen → 活动流 → 隔离 clone 合并。`src/m2-e2e.ts`/`src/m3-e2e.ts` 是 v1 thread 语义的 dev 驱动（KI-29），不能验证 M10/M11 的工具链。
2. **真实 v1 数据的迁移与回滚未演练**（KI-22）。M11 只在真实数据上观察到「首次 overview 触发生命周期写 → M7 on-write 迁移」并随即用 `index.v1.backup.json` 恢复；备份完整性、归档失败、二次读取幂等、回滚步骤都没有一次可复现的演练，升级用户没有可依赖的迁移/回滚说明。
3. **正式安装路径未验证**（KI-31）。M11 因宿主 client pkgMeta 与 Node ESM 缓存（KI-11/KI-16）用 dev 注入器的别名包做真机验证；`npm pack` → 新 profile add → 重启后 v2 client、六条 `/api/cowork.*` 路由与四个 preset 是否可用没有证据，0.2.0 的打包产物也从未检查过清单与版本。
4. **面向用户的文档仍是 0.1.0 形态**。`README.md` 没有 0.2.0 的破坏性变更、升级/回滚与迁移说明；`docs/routing.md`/`docs/context.md` 仍是 M4 时代的 thread 叙述；`docs/glossary.md` 没有 v2 术语；KI-22/29/31/32/33 未关闭或未重新指派；`docs/archived/results/M12_RESULT.md` 不存在。

后果：新用户与升级用户都缺乏可执行的安装/迁移路径；评审—合并—resolve 链只有 fake host/单测证据，跨会话回归没有门禁；0.2.0 无法收口。

## Decision

M12 按以下六部分交付。需求与验收由 [PLAN-V0.2](../../../../docs/PLAN-V0.2.md) §6 M12、§7 A1–A10 拥有；交付面、证据与偏差由 [M12_RESULT](../../../../docs/archived/results/M12_RESULT.md) 拥有；本记录只固定执行层决定。

**1) 基线与阶段边界。** 从 M11 交付后的 `origin/main` merge sha `1b0801d` 开 `feat/m12-docs-e2e-0.2.0`；基线 732/732 与四条命令全绿后才改代码。M12 不新增业务工具/预设，不改 canonical v2 数据语义。

**2) 真实全链路 E2E（M12.3）。** 新增 `src/m12-e2e.ts` 与 `src/m12-e2e-support.ts`（各 <51,200 B）：

- 路由只在 `Config.enableDevRoutes=true` 时注册：`/dsh-cowork/e2e/m12/run`（POST，`?base=` 选择 artifact 基线、`?keep=1` 保留现场）与 `/dsh-cowork/e2e/m12/status`（GET，`?runId=`）；loopback-only、exact 路由、fiber-owned effect。
- 抛掷项目（fixture）必须位于插件仓库之外；17 步链固定为 setup、route-topic、session-list、overview、work-item、work-item-commit、review-request、review-verdict、master-merge-decision、handoff-done、merge、auto-resolve、no-undo、resolved-no-receive、reopen、activity、cleanup；短阈值 `idleAfterMs=500`/`resolveAfterMs=1000` 由 config 校验，模型路由关闭；失败即停并保留已跑步骤的证据。
- 每步记录 `{ step, startedAt, endedAt, ok, evidence }`；证据 `.dsh-cowork/e2e/M12_E2E.json` 带 artifact identity（`git rev-parse HEAD`、`git diff <base>..HEAD | shasum -a 256`、`git status --porcelain`、pluginVersion）与 cleanup 报告；cleanup 归档本次创建的全部会话、删除 fixture 与 workspace。
- 面板侧断言用进程内探针：在私有 connection 上注册真实 `registerCoworkApi` handler，用 `panelProbeRequest` 显式带 `host=127.0.0.1`/`origin`（同源门要求），用 `panelRoutePathname` 按裸路径查表；`tests/m12-e2e.test.mjs` 钉住步骤清单、证据形状与 persist-before-delete 不变量，`tests/dev-gate.test.mjs`/`tests/api.test.mjs` 钉住两条探针回归（F1/F4）。

**3) 迁移演练与回滚（M12.4）。** 新增 `tools/m12-migration-drill.mjs`（11 步、`--evidence`/`--keep`/`--seed`、exit 0/1/2）与 `tests/m12-migration-drill.test.mjs`：

- 内置全字段 v1 快照（六态 thread、`reviewStatus`/`reviewerSessionId`/`latestReviewPath`、pending 评审）；默认只在 `os.tmpdir()` 新建临时仓库，不写真实 `.dsh-cowork`。
- 经 `ProjectStore.updateThread` 的 on-write 路径触发迁移；断言 v2 形状（`projectIndexV2Problems`）、`index.v1.backup.json` 与输入逐字节一致、活动行、二次读/写不再迁移（`migrations=1`、备份 mtime 不变）、reviewer 归档失败进 `archiveFailures` 且 v2 仍提交、备份回滚后 `store.readIndex` 读回 v1 且目录字节回到迁移前。
- 真实项目在面板验证中两次触发 on-write 迁移并按同一路径逐字节恢复（证据 `REAL_DATA_MIGRATION_INCIDENT.json`）——这是设计内升级行为的实测，不替代演练。

**4) 打包与正式安装路径（M12.5）。** `package.json` 0.2.0；`npm run build` 后 `npm pack`，清单只含 `lib/**`、`cordis.patch.yml`、`README.md`、`LICENSE`、`package.json`；干净 `m12verify` profile 安装、独立端口 3091 宿主、boot 列表 client 来自安装包；四个 preset/15 工具/六条 `/api/cowork.*` 路由由已安装包真实 E2E 与面板已认证 200 证明（未认证 401 不作注册证据）；同一 profile 以 `enableDevRoutes: true` + 临时 fixture 跑一次真实 E2E；卸载后 `.dsh-cowork` hash 不变。仓库无 lockfile 的事实记入 M12_RESULT 而不凭空加锁文件。第二个宿主的认证使用启动输出的已认证 URL，不读取/转述 cookie/token。

**5) 文档发布面（M12.2）。** `README.md` 重写为 0.2.0 用户指南（破坏性变更、首次写路径迁移与 `index.v1.backup.json`、升级/回滚、KI-28 可见性上限）；`docs/routing.md`/`docs/context.md` 按 v2 重写；`docs/glossary.md`/`docs/plain-language.md` 补 v2 术语并把 thread 标为 0.1.0；`docs/KNOWN_ISSUES.md` 关闭 KI-22/29/31/32/33、把 KI-18/27/30/34/35/36/37/38 指派到 V0.3 或待确认；新增 `docs/archived/results/M12_RESULT.md`，`docs/archived/handoffs/M12_HANDOFF.md` 只做事实更正；`docs/publish.json` 与 `docs/README.md` 同步；两份 0.1.0 记录迁 implemented。收口顺序按 [AGENTTEAM](../../../../docs/AGENTTEAM.md) R10：实现/文档 → integration-ready → verification → review → 一次性修复 + 文档同步 → final integration → delivery。

**6) 发布边界。** 不发布 GitHub Release、不打 tag、不部署生产；只交付可安装 tgz 与 PR（[PR #18](https://github.com/leigangzhang/dsh-cowork/pull/18)），合并等用户确认。

## Alternatives considered

**继续用 `src/m2-e2e.ts`/`src/m3-e2e.ts` 当验收。** 否决：它们编码 v1 thread/review/allowUnreviewed 语义（KI-29），跑通也不证明 M10/M11 的工具链；M12 实测在 v2 store 上首步即超时失败（`KI29_M3_DRIVER_NOT_ACCEPTANCE.json`），照旧跑会得到误导性的绿色。

**只在 fake host/单测里验证，不做真实 E2E。** 否决：PLAN §7 要求跨会话/跨进程改动必须真实 DSH E2E；reviewer→verdict→inbox→resolve 的投递与 session 生命周期在 fake host 里没有等价物。

**真实 E2E 直接跑在用户 web profile / 真实 `.dsh-cowork`。** 否决：会创建/归档用户会话并可能触发真实数据迁移（R9 与 KI-13 的同类风险）；用临时 fixture + 独立 `m12verify` profile 才能重复且可回滚。

**继续用 dev 注入器别名包验证 0.2.0 面板。** 否决：KI-31 要验证的正是 `npm pack` → 安装 → 重启路径；别名包绕过的恰是待验证的缓存与装配环节。

**只写文档、把真实 E2E 与迁移演练再推给下一个阶段。** 否决：0.2.0 是 V0.2 收口阶段；KI-22 已从 M7 挂到 M10、M11，再推会让发布带着未验证的跨会话链路，M12 之后没有既定下一阶段可承接。

**给仓库补 lockfile、上 npm 发布。** 否决：插件是 `private: true` 的 bundle 包，只有 devDependencies，发布形态是 profile 安装；补 lockfile 与 npm 发布都超出 0.2.0 的范围。

## Consequences

- **交付面**：新增 `src/m12-e2e.ts`（50,961 B）、`src/m12-e2e-support.ts`（50,924 B）、`src/panel-probe.ts`（1,742 B）、`tests/m12-e2e.test.mjs`、`tools/m12-migration-drill.mjs`（37,796 B）与测试；`package.json` 0.2.0；测试 732 → 773；client 未改（`lib/client.js` 89,235 B、sha256 `3b1b3588…`）。
- **与提案的执行差异**：面板探针没有走提案假设的 `connection.fetch` 共享 handler（插件没有该 client 通道），改为注册真实 handler 后用 `Request` 直接调用。真机首跑因此暴露两个探针缺陷：F1（用带查询串的完整 path 查路由表）、F4（构造的 `Request` 不带 Host/Origin 被同源门 403）；两者都补 host-free 回归后修复并重跑真实 E2E 通过。F2 让失败路径也记录自动归档与 fixture 清理结果。
- **dev 面遗留**：m2/m3 驱动保留为 dev-only、非验收（KI-29 关闭）。
- **升级行为**：首次写路径（含打开 CoWork 面板的 overview）执行 on-write 迁移并写 `index.v1.backup.json`；README 写明升级/回滚，真实数据事故记录见 M12_RESULT。
- **保持项不变**：KI-28（reviewer 宿主侧栏可见是接受上限）、KI-27（隔离只实现 clone）、KI-23（收件箱 at-least-once）、KI-19/KI-21/KI-26/KI-30 的既有边界不因本阶段改变。
- **未验证**：0.1.0 重装回滚路径、GitHub Release/tag、移动端/多窗口/headless/Windows、真实 LLM 路由质量与成本（KI-36）。
- **指针**：A1–A10 证据与偏差见 [M12_RESULT](../../../../docs/archived/results/M12_RESULT.md)；启动交接见 [M12_HANDOFF](../../../../docs/archived/handoffs/M12_HANDOFF.md)；遗留归属见 [KNOWN_ISSUES](../../../../docs/KNOWN_ISSUES.md)。

## Testing

- [A1] 真实 v1→v2 迁移/备份逐字节/幂等/回滚演练可复现 — `tests`：`tests/m12-migration-drill.test.mjs`、`tests/store-migration.test.mjs`、`tests/store-v2.test.mjs`；`drill`：`node tools/m12-migration-drill.mjs`（11/11 步，备份 `1dd3cd3c…`==输入==恢复，`migrations=1`，archiveFailures 有记录，回滚 `readIndexVersion=1`）；证据 `.dsh-cowork/e2e/m12/M12_MIGRATION.json`
- [A2] 已安装包宿主上真实全链路 E2E 一次通过，逐步证据写入 `M12_E2E.json` — `source`：`src/m12-e2e.ts`、`src/m12-e2e-support.ts` 的 run/status 路由与 17 步链；`tests`：`tests/m12-e2e.test.mjs`（步骤/证据/cleanup 契约）；`plan-docs`：`docs/archived/results/M12_RESULT.md` A8（runId `m12-3ccfe5e4…`，17/17、62 s，artifactIdentity 与 `495a872`/`9fc6556f…` 一致）
- [A3] reviewer 生命周期：请求 pending → verdict 绑定 `requestId`/`reviewerSessionId` → verdict 后归档 → master 只收到合并决定 — `tests`：M12 E2E 的 `review-request`/`review-verdict`/`master-merge-decision` 步断言与 `tests/review-verdict.test.mjs`、`tests/review-request.test.mjs`
- [A4] resolve/reopen 边界：自动 resolve、手动 resolve 不撤销、reopen 清 `resolvedAt/resolvedBy`、resolved 主题不再自动接收 — `tests`：M12 E2E 的 `auto-resolve`/`no-undo`/`resolved-no-receive`/`reopen` 步断言与 `tests/topic.test.mjs`、`tests/topic-events.test.mjs`
- [A5] 隔离 clone 全链路：`cowork_work_item_create` → clone 内提交 → `cowork_review_request` → pass → `cowork_checkout_merge` 成功且 main 不动 → 清理 — `tests`：M12 E2E 的 `work-item`/`work-item-commit`/`merge`/`cleanup` 步断言与 `tests/checkout.test.mjs`、`tests/work-item.test.mjs`
- [A6] 正式安装路径：`npm pack` 清单正确；干净 profile 安装并重启后 preset/工具/六路由/v2 client 可用；真实 Chrome 面板打开并截图 — `packaging`：`tests/packaging.test.mjs`、`package.json` 0.2.0、`INSTALL_EVIDENCE.json`（tgz 426,110 B、sha256 `b190af8e…`、135 文件）；`plan-docs`：`docs/archived/results/M12_RESULT.md` 打包/安装/面板节（六路由已认证 200、4 张截图、R9 fixture apply/restore 各 5 ms、index 恢复 `f7fec0db…`）
- [A7] 卸载保留 `.dsh-cowork` 数据；README 的升级/回滚步骤可执行 — `packaging`：`UNINSTALL_EVIDENCE.json`（remove exit 0、bundles 回退、前后 `index.json`/`m7-execution-prompt.txt` hash 一致）；`plan-docs`：`README.md`「升级到 0.2.0：迁移与回滚」与 `docs/archived/results/M12_RESULT.md` 回滚节
- [A8] README 写明 0.2.0 破坏性变更、首次写路径迁移（含备份文件）、回滚与 KI-28 限制 — `publication`：`docs/publish.json` 分类与 `npm run check` 链接门禁；`plan-docs`：`README.md` 的破坏性变更/迁移/回滚/可见性节
- [A9] `docs/routing.md`/`docs/context.md` 按 v2 重写、glossary 更新、KNOWN_ISSUES 关闭或转归属、M12 文档分类进 `docs/publish.json` — `publication`：`npm run check` exit 0（未分类 `.md` 会红）、`docs/publish.json`、`docs/README.md`；`tests`：`tests/workflow.test.mjs`
- [A10] 最终 HEAD 上五命令全绿、`src/**/*.ts(x)` <51,200 B、`package.json` 0.2.0、delivery 记录 HEAD/diff sha/status/PR — `source`：`tests/source-budget.test.mjs`（773/773、`npm run typecheck`/`build`/`check` exit 0）；`workflow`：`npm run check:self-test` exit 0；`plan-docs`：`docs/archived/results/M12_RESULT.md`「最终交付事实」（artifact `0899d27`、diff `50f2ce81…`、PR #18、tgz `b190af8e…`）
