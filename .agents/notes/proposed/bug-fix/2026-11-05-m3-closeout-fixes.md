# Proposal: M3 收口修复（面板超时、E2E 清理、tools 拆分与证据可复现）

Status: proposed
Date: 2026-11-05
Class: bug-fix

## Problem

M3 已交付并通过独立终审（代码/真实宿主 E2E/文档/截图），但阶段本身留下了六项应由 M3 消化的问题。按仓库的阶段原则，这些不能在 M4 再还；宿主/M4 约束与已接受设计取舍另列，不混进本修复。

1. **面板 API 可能无限 loading**：`/api/cowork.overview` / `handoff` 依赖 `sessionController.list()` 解析 sessionId→cwd；该调用在旧 fiber 下会挂 >25 s，冷启动会话列表约 1.2 MB / 17 s。API 没有超时，client 只能一直显示骨架（[M3 结果](../../../../docs/M3_RESULT.md) 限制 1、KI-12）。
2. **失败 E2E 留下 Markdown fixture**：run 失败时不走 cleanup 步，`.dsh-cowork/e2e/m3-repo/README.md` 会让 `npm run check` 与 publish 测试变红（KI-13）。
3. **`src/tools.ts` 贴读上限**：51,184 B，距 DSH 单文件 50 KiB 只差 16 B；下一次修改就可能让 agent 无法一次读完（KI-14）。
4. **面板还有三项真机未验证**：深色主题下的 review 徽章/findings、两个「打开会话」按钮的点击导航、≤480 下的 pass/reject 详情；它们不是代码缺陷，但会让“两档可复现”缺少最后证据（[PANEL_RESULT](../../../../docs/PANEL_RESULT.md)）。
5. **面板 fixture 不可复现**：生成器只存在于本机 gitignored `.dsh-cowork/e2e/panel-m3/fixture.mjs`；新 clone 无法按文档重截两档图。
6. **证据 marker 与 HEAD 时序靠人记**：t11 曾读到旧 `M3_DOCS_READY.json`（4c79fa1 vs HEAD 3fe072f）；文档提交后忘记重写 marker 会让复审误判。

这些问题的共同点：都由 M3 的实现/验证方式产生，修复面小、判定面清楚；把它们推到 M4 会让“panel API 可用”“检查可重复”“证据可复现”在下一个阶段重新变成前提。

## Proposal

**M3-FIX 在 `fix/m3-closeout`（从 `feat/m3-review-panel` 的 `cd1fe9e`）上完成，属于 M3 收口，不是 M4。** 操作步骤与 runbook 见 [M3 修复交接](../../../../docs/M3_FIX_HANDOFF.md)；本节只定行为与契约。

- **面板 API 有界等待**：`src/api-contract.ts` 增加 `session/list-timeout` 错误码（wire 只有一套错误包络，未知码对旧客户端是普通失败）；`src/api.ts` 给 `listSessions()` 加约 30 s 的有界等待，超时映射为 HTTP 504 + 该码；overview/handoff 都走同一映射，仍带 `cache-control: no-store`。不做 `sessionController.inspect` 降级：M2 已证明 inspect 对运行中大会话会挂，用一个更差的入口替换慢入口只会缩短探测窗口、不解决问题。client 复用现有 error 态与「重试」，不新增状态。
- **失败 E2E 清理**：`src/m3-e2e.ts` 在 `finally` 中先持久化证据，再无条件尝试删除 `.dsh-cowork/e2e/m3-repo`；删除失败只进 `cleanup.errors`，不改写 run 的原始 error/state。把“该不该删”抽成纯 helper 供单测覆盖 done/failed/running 三态。M2 驱动不改（M2 阶段已关闭；它的同类行为不在本修复范围，避免顺手扩范围）。
- **拆 `tools.ts`**：新建 `src/review-tools.ts`，承载 `cowork_review_request` / `cowork_review_verdict` 的注册与 review 相关编排，导出 `registerReviewTools(ctx, deps)`；`src/tools.ts` 只调用它。工具名、参数 schema、错误码、返回值、调用者门与读写顺序逐字不变；改动后必须重跑真实 M3 E2E，因为工具注册路径变了。新增 `tests/source-budget.test.mjs`：遍历 `src/**/*.{ts,tsx}`，断言单文件 ≤ 51,200 B，把 P2 变成可执行检查。
- **fixture 迁入仓库**：把生成器迁到 `tools/panel-fixture.mjs`（`apply` 备份真实 `.dsh-cowork` 数据并写 5 thread / 3 review，`restore` 还原；退出码明确）；截图仍是 gitignored 本地产物，但生成步骤可复现。`docs/M3_RESULT.md` / `PANEL_RESULT.md` 的路径同步更新。
- **补面板真机证据**：深色主题、两个打开按钮的点击导航、≤480 下 pass/reject 详情；能截就截，不能截就记录不可得原因与实际手段。发现真实 UI 缺陷才改 `src/client/**`，并在同一交付重截；不把“环境不行”当默认结论。
- **marker 校验**：新增 `tools/check-evidence-marker.mjs`：读取本地 `M3_DOCS_READY.json`，校验 `commit === HEAD`、`screenshots` 非空、`screenshotStatus` 合理；marker 不存在时打印提示并 exit 0（本地证据不参与 CI 的假红）。收口前运行，每次文档提交后重写 marker。
- **收口**：写一条 `implemented/bug-fix/` 记录（面板超时错误码与失败清理行为属于契约变化）；更新 `M3_RESULT`/`PANEL_RESULT`/`KNOWN_ISSUES`/`M3_HANDOFF`/`docs/publish.json`；四条命令 + 真实 E2E 15/15 + 独立 verifier/reviewer（实现者不自审，2–3 轮上限）；`fix/m3-closeout` 推送，`main` 只在用户明确授权后合并。

**不在本修复**：reviewer 的 bash 写能力（KI-15，已接受取舍；需要只读沙箱/自定义工具）、merge override（产品决策）、profile 全局 `dev_*` 工具（KI-10，宿主/M4）、同名包 client 缓存与 runtime 注入（KI-11，M4 安装）、preset 持久化（KI-3）、merge 冲突人工解决（KI-4）、workspace-write 前提（KI-5）。这些有归属与重估触发，不是“忘了修”。

## Alternatives considered

**把这些留给 M4。** 否决：用户已明确“当前阶段的遗留不拖到下个阶段”；M4 的范围是单插件打包/发布，若面板 API 可用性、检查可重复性与证据可复现性仍是前提，M4 会先替 M3 还债。修复面小且都能在本阶段闭环。

**面板 API 改回 `sessionController.inspect`。** 否决：M2 已观测到 inspect 对运行中/较大会话挂死；换来的是一个更慢、更不可控的入口。正确的产品行为是“有界等待 + 明确错误 + 可重试”。

**不拆 `tools.ts`，等下次真要改时再拆。** 否决：当前只剩 16 B，下一次修改会直接超读上限；拆 review 工具是纯结构移动，行为不变，且有 E2E 与文件预算测试兜底。

**让 `check-invariants` 忽略 `.dsh-cowork`。** 否决：这会让 check 对真实工作区里的 Markdown 视而不见，掩盖本次问题；失败 E2E 自己清理才是根因修复。

**fixture 继续放本机 `.dsh-cowork`。** 否决：新 clone 无法复现两档截图，面板验证退化为“作者机器上能跑”。迁到 `tools/` 后截图仍不提交，但步骤与数据形状可复现。

**用文档 checklist 代替 marker 脚本。** 否决：t11 已经证明人会忘；脚本把“commit==HEAD、截图非空”变成命令，成本低。marker 是本地证据，脚本在缺失时 exit 0，不污染 CI。

**现在给 reviewer 加只读沙箱。** 否决：需要宿主提供只读文件系统或自定义 tool surface，超出本阶段；review 仍需要 bash 跑验证。保留为 KI-15，触发条件是实际观测到 reviewer 改被审文件。

## Acceptance criteria

- [M3F1] `listSessions` 永不返回时，overview/handoff 在约 30 s 内返回 504 + `session/list-timeout`；慢但可返回时成功；成功路径与 `no-store` 不变；client 进入可重试 error 态 — `source`, `tests`
- [M3F2] 失败的 M3 E2E 结束后 `.dsh-cowork/e2e/m3-repo` 不存在，证据仍落盘且保留原始 error，删除失败只进 `cleanup.errors` — `source`, `tests`
- [M3F3] `src/tools.ts` 拆出 `src/review-tools.ts`，工具名/参数/错误码/门禁/写序逐字不变；`tests/source-budget.test.mjs` 通过且真实 M3 E2E 15/15 — `source`, `tests`, `packaging`
- [M3F4] `tools/panel-fixture.mjs` 的 apply/restore 可运行，真实数据恢复；结果/面板文档路径同步 — `source`, `publication`
- [M3F5] marker 校验脚本在 commit 不匹配/截图为空时失败，marker 缺失时明确跳过；收口前实际运行 — `source`, `tests`
- [M3F6] 面板深色主题、两个打开按钮、≤480 pass/reject 详情有截图或不可得原因；无回归 — `source`, `publication`
- [M3F7] 四条命令全绿、`npm run check` 通过、真实 E2E 15/15、独立 reviewer pass、提案迁入 `implemented/` 且 `publish.json` 分类正确 — `packaging`, `publication`

## Risks

- 30 s 超时对极大仓库/极慢宿主可能偏短；常量集中定义，测试覆盖慢返回；超时是明确失败而不是静默成功。
- 新错误码进入 wire：仓库内只有 panel client，旧客户端遇到未知码会落入普通错误；不改变成功响应。
- 失败 E2E 删除 fixture 会减少事后现场；证据 JSON 先落盘，且失败的错误/清理信息都在证据里。只删 gitignored 运行目录，不删 evidence。
- 拆 `tools.ts` 可能误改注册顺序/依赖；以工具 schema、单测、真实 E2E 三重验证。
- fixture 脚本会改真实 `.dsh-cowork`；强制备份/还原、apply 需显式调用，绝不提交数据。
- marker 脚本是本地证据工具，不能让 CI 因本地文件缺失变红；缺失时 exit 0。
- 面板补验可能发现真实缺陷，时间不可控；发现即修并重截，不把缺陷留到 M4。
- 实现者不得自审；高/中 finding 必须在同一轮修完，low 可记录但要写触发。

## Delivery stages

1. 面板超时（`src/api.ts`/`api-contract.ts`/`tests/api.test.mjs`）+ 失败 E2E 清理（`src/m3-e2e.ts`/tests）+ 新错误码记录。
2. 拆 `src/review-tools.ts` + `tests/source-budget.test.mjs` + 真实 M3 E2E 重跑。
3. `tools/panel-fixture.mjs` 迁入 + 面板深色/点击/≤480 pass-reject 取证。
4. `tools/check-evidence-marker.mjs` + 文档/marker + 四条命令 + 独立复查 + 推送；`main` 合并按用户授权。
