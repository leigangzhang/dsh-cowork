# Decision: M3 收口修复（面板超时、失败清理、tools 拆分与证据可复现）

Status: implemented
Date: 2026-11-05
Class: bug-fix

## Problem

M3 已交付并通过独立终审，但阶段本身留下了六项应由 M3 消化的问题：`/api/cowork.overview` 与 `handoff` 经 `sessionController.list()` 解析项目，旧 fiber 或大会话列表下可能挂 >25 s 且没有超时（KI-12）；失败的真实宿主 E2E 不执行 cleanup 步，留下含 `README.md` 的 `.dsh-cowork/e2e/m3-repo`，让 `npm run check` 与 publish 测试变红（KI-13）；`src/tools.ts` 距 DSH 单文件 50 KiB 读上限只剩 16 B（KI-14）；面板的深色主题、两个「打开会话」按钮与 ≤480 的 pass/reject 详情没有真机证据；两档截图依赖只存在于本机 gitignored 目录的 fixture 脚本；证据 marker 与 HEAD 的时序靠人记，独立复查曾读到旧 commit。这些问题的共同点是都由 M3 的实现/验证方式产生，推到 M4 会让「面板 API 可用」「检查可重复」「证据可复现」在下一个阶段重新变成前提。

## Decision

M3-FIX 在 `fix/m3-closeout`（从 `feat/m3-review-panel` 的 `cd1fe9e` 之后的最新 main）上完成，属于 M3 收口而不是 M4。

- **面板 API 有界等待**：`src/api-contract.ts` 的 `PanelErrorCode` 增加 `session/list-timeout`；`src/api.ts` 用导出的 `LIST_SESSIONS_TIMEOUT_MS = 30_000` 和 `listSessionsBounded()` 给 `ports.listSessions()` 加 `Promise.race` 有界等待，`finally` 清理计时器，败方 promise 预挂 `catch` 防止迟到 reject 变成 unhandled rejection；超时抛 `PanelApiError('session/list-timeout', …)`，`PANEL_ERROR_STATUS` 映射为 HTTP 504。overview 与 handoff 共用 `resolveProjectRoot` 的同一映射，错误包络仍是 `{ok:false,error:{code,message,path?}}`，成功与错误都保留 `cache-control: no-store`。`CoworkApiPorts.listSessionsTimeoutMs` 只用于测试注入，不属于 wire；不恢复 `sessionController.inspect` 降级（M2 已证明它更糟）。client 侧不新增状态：`fetchPanelJson` 保留 code，`errorPresentation` 对未知 code 返回可重试错误，`tests/panel-model.test.mjs` 钉住 `session/list-timeout` 的 code 与 retry。
- **失败 E2E 清理**：`src/m3-e2e-support.ts` 新增纯函数 `shouldRemoveFixture(state)`（`done`/`failed` 为真，`running` 为假）；`src/m3-e2e.ts` 的 `execute()` finally 顺序改为 archive → persist → 判定后 `removeFixture` → release。`removeFixture()` 用 `rm(recursive, force)` 删除 `.dsh-cowork/e2e/m3-repo`，删除失败把 `delete fixture: <message>` 追加到 `run.cleanup.errors` 后再次 persist，绝不改写 `run.state`/`run.error`；证据文件先落盘且不在删除范围内。成功 run 的 `stepCleanup`、`tempRepoRemoved`、`recordCheck` 语义不变；M2 驱动不改。
- **工具拆分与文件预算**：`src/review-tools.ts` 承载 `cowork_review_request` 与 `cowork_review_verdict` 的 `defineTool` 注册及 review 专用编排，导出 `registerReviewTools(ctx, deps)`；共享 helper 由 `src/tools.ts` 注入，无运行时循环 import。`src/tools.ts` 在 merge 工具之后调用它并展开 disposers，工具名、description、参数 schema、错误码、caller gate、写序（review 文件先于索引；request 先写 pending 再 prompt）、返回 payload 键与第 10/11 位顺序逐字保持。拆分后 `src/tools.ts` 51,184 → 42,704 B，`src/review-tools.ts` 11,795 B。`tests/source-budget.test.mjs` 递归检查 `src/**/*.ts`/`src/**/*.tsx` 单文件 ≤ 51,200 B，并额外把 `src/tools.ts` 压到 ≤ 49,152 B、断言两个 review 工具只在新文件注册。
- **可复现 fixture**：`tools/panel-fixture.mjs` 保留原 apply/restore 逻辑（apply 备份真实 index/handoffs/reviews 后写 5 thread + 3 review；restore 还原；备份仍在 `.dsh-cowork/e2e/panel-m3/backup`），仓库根由 `tools/` 路径推导；退出码 0 成功 / 1 操作失败 / 2 用法错误，且仍然只写 JSON、不写 Markdown。`docs/M3_RESULT.md` 与 `docs/PANEL_RESULT.md` 的路径同步。
- **证据 marker 校验**：`tools/check-evidence-marker.mjs` 读取 `.dsh-cowork/e2e/M3_DOCS_READY.json`，校验 `commit === HEAD`、`screenshots` 非空、`screenshotStatus ∈ {verified, partial}`；marker 缺失时打印 skipped 并 exit 0（本地证据不把 CI 弄红），存在但无效时 exit 1，未知参数 exit 2；`--root`/`--head` 只供测试注入。`tests/marker-check.test.mjs` 覆盖纯校验、三种失败、缺失跳过与 CLI 退出码。
- **面板真机补验**：真实 Chrome + 真实宿主完成三项未验证证据——深色主题下的 review 徽章/findings（`04-dark-review-states.jpg`）、≤480 的 pass 详情（`05-drill-pass-detail.jpg`）与 reject 详情（`06-drill-reject-detail.jpg`）；两个「打开会话」按钮均验证了真实导航：pending review 的「打开 review 会话」导航到 master 会话（`session-65c8337f…`，标题 `Call cowork_project_init tool` / `cowork master`），真实 thread 的「打开 thread 会话」导航到 `cowork: 路由演示`（`session-a9072f0b…`）。本部署的设置写入不可持久（点击深色后回落到浅色），因此深色证据用 DSH 自己的 `data-ds-dark-theme` 属性强制暗色 token（页面计算背景 `rgb(21,21,23)`），并在结果文档记录实际手段；没有新增 UI 代码。
- **证据与收口**：真实宿主 M3 E2E 重跑 `m3-004629a6-c7de-48c1-92e9-99c474eae1a1`，`state=done`、15/15、`tempRepoRemoved=true`、两次合并 `ee9f5a45…`/`89190c47…`；另有失败路径实测 `m3-565e31d8-08c0-4247-b3ec-d3fef52dd51d`（`thread-a-create` 因 runner disposed 失败，fixture 被 finally 删除，证据保留原始 error，`.dsh-cowork/e2e/M3_E2E.failure-cleanup.json`）。四条命令 `npm run check` / `npm test` 330/330 / `npm run typecheck` / `npm run build` 全绿；`M3_DOCS_READY.json` 在本分支最后一次提交后重写，`tools/check-evidence-marker.mjs` 通过；独立 verifier 与 reviewer 在 AgentTeams 中复核，`main` 未动、未 force push。

## Alternatives considered

**把这些留给 M4。** 否决：用户已明确「当前阶段的遗留不拖到下个阶段」；M4 的范围是单插件打包/发布，若面板 API 可用性、检查可重复性与证据可复现性仍是前提，M4 会先替 M3 还债。修复面小且都能在本阶段闭环。

**面板 API 改回 `sessionController.inspect`。** 否决：M2 已观测到 inspect 对运行中/较大会话挂死；换来的只是一个更慢、更不可控的入口。产品行为应是「有界等待 + 明确错误 + 可重试」。

**不拆 `tools.ts`，等下次真要改时再拆。** 否决：当前只剩 16 B，下一次修改会直接超读上限；拆 review 工具是纯结构移动，行为不变，且有真实 E2E 与文件预算测试兜底。

**让 `check-invariants` 忽略 `.dsh-cowork`。** 否决：这会让 check 对真实工作区里的 Markdown 视而不见，掩盖问题；失败 E2E 自己清理才是根因修复。

**fixture 继续放本机 `.dsh-cowork`。** 否决：新 clone 无法复现两档截图，面板验证退化为「作者机器上能跑」；迁到 `tools/` 后截图仍不提交，但步骤与数据形状可复现。

**用文档 checklist 代替 marker 脚本。** 否决：独立复查已证明人会忘；脚本把「commit==HEAD、截图非空」变成命令，成本低；marker 缺失时 exit 0，不污染 CI。

**现在给 reviewer 加只读沙箱。** 否决：需要宿主提供只读文件系统或自定义 tool surface，超出本阶段；review 仍需要 bash 跑验证。保留为已知限制。

## Consequences

- 面板 API 在 30 s 内一定返回；超时是明确的 504 + 稳定 code，不是静默成功。旧客户端遇到未知 code 会落入普通错误，成功响应不变。30 s 对极大仓库/极慢宿主可能偏短，常量集中在 `src/api.ts`，调大是一处改动。
- 失败 E2E 不再留下 Markdown fixture，因此事后现场只剩 `.dsh-cowork/e2e/M3_E2E.json`（先落盘）与其中的 cleanup 记录；删除失败只进 `cleanup.errors`，不会把成功 run 改成失败，也不会掩盖原始错误。`running` 状态的 run 不删 fixture。
- 工具面契约不变；`src/tools.ts` 拆分后余量 8,496 B，`tests/source-budget.test.mjs` 让 P2 的 50 KiB 规则成为可执行检查（`src/` 之外的文件不在其覆盖范围）。真实 E2E 仍必须重跑，因为工具注册路径变了。
- `tools/panel-fixture.mjs` 会改真实 `.dsh-cowork`，必须显式 apply 并在结束后 restore；备份目录与截图仍是 gitignored 的本地产物。marker 是本地证据工具，缺失时 exit 0，CI 不应依赖它变红。
- 面板深色证据依赖手动 `data-ds-dark-theme` 属性，因为本部署的 DSH 设置写入不持久；这证明的是暗色 token 下的渲染，不是「主题切换持久化」本身。真实 thread/review 会话可用时两个打开按钮导航正常；当 fixture 指向已被清理的会话时，点击会让主工作区回到「选择一个工作区」，这是宿主对不存在会话的行为，未在面板侧加假校验（面板无法知道会话是否仍存在）。
- 运行中的宿主热重载只换 entry 模块 URL，静态依赖仍命中 Node ESM 缓存：本次为了让新 host 代码生效，给 `lib/*.js` 的相对 import 加了 `?dshfix1` 查询串后重载（构建产物是 gitignored 的本地文件），最终验收后重新构建并记录该环境事实。宿主重启可避免这一缓存；这不改变插件源码契约。
- 面板 API 超时与失败清理都是有意的行为变化，需要新记录（本文）而不是只改代码；提案已按仓库生命周期迁入本目录。

## Testing

- [M3F1] `listSessions` 永挂时 overview/handoff 在注入的小超时内返回 504 + `session/list-timeout` 且带 `no-store`；慢但可返回时成功；计时器清理、迟到 reject 不 unhandled；client 保留 code 且 retry=true — `source`, `tests`
- [M3F2] 失败 run 结束后 `.dsh-cowork/e2e/m3-repo` 不存在，证据先落盘且保留原始 error，删除失败只进 `cleanup.errors`；helper 覆盖 done/failed/running — `source`, `tests`
- [M3F3] `src/review-tools.ts` 注册两个 review 工具，`src/tools.ts` 只装配调用；工具名/schema/错误码/门禁/写序/顺序不变；source-budget 通过且真实 M3 E2E 15/15 — `source`, `tests`, `packaging`
- [M3F4] `tools/panel-fixture.mjs` apply/restore 可运行并恢复真实 `.dsh-cowork`；文档路径同步 — `source`, `publication`
- [M3F5] marker 脚本对 commit 不匹配、空 screenshots、非法 status 变红，缺失时 exit 0；tests/marker-check.test.mjs 通过且收口前实际运行 — `source`, `tests`
- [M3F6] 深色 review 状态、两个打开按钮导航、≤480 pass/reject 详情有截图或可复核记录；无 UI 回归 — `source`, `publication`
- [M3F7] `npm run check`、`npm test` 330/330、`npm run typecheck`、`npm run build` 全绿；真实 E2E 15/15；独立 verifier/reviewer 复核；提案迁入 implemented 且 publish 分类不变 — `packaging`, `publication`
