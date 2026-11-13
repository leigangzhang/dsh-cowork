# Proposal: 代码与文档生命周期管理（tests/tools、E2E 驱动、过期与无引用资产）

Status: proposed
Date: 2026-11-09
Class: process

## Problem

仓库已经跨过 V0.1（M0–M4）与 V0.2（M6–M12）两个阶段，积累了一批评测口径不同的代码、测试、工具与文档；目前只有零散的归属（KI-18/KI-29）、文档分类（`docs/publish.json`）与证据分层（`docs/testing.md`），没有一份统一策略回答"什么该删、什么时候删、删前要同步什么、什么只归档、什么随版本迭代保留"。现状证据：

- **E2E 驱动并存且角色不同**：`src/m12-e2e.ts`/`m12-e2e-support.ts` 是 v2 验收驱动；`src/m2-e2e.ts`/`m3-e2e.ts` 及其 support（合计约 135 KB，其中 `m2-e2e.ts` 49,923 B 逼近 51,200 B 预算）是 v1 语义的 dev-only 驱动，无产品调用，只被 `tests/m2-e2e.test.mjs`、`tests/m3-e2e.test.mjs`、`tests/e2e-index-compat.test.mjs` 引用，且已按 KI-29 标为"非验收"。
- **无产品引用或仅测试引用的代码**：`renderMemoryEntry`（`src/memory.ts:416`）与 `formatMasterMessage`（`src/handoff.ts:241`）只被测试调用；`store.listReviews/latestReviews/readReview/writeReview`（`src/store.ts:836-920`）无产品调用，`tests/api.test.mjs:971` 反而断言 store 端口不得暴露它们。
- **仍在用的兼容层**：`legacyViewOf`/`applyLegacyView`（`src/store-migration.ts`）、legacy 字段（`legacyStatus`/`lastHandoffAt`/`reviewRequestedAt`/`reviewedAt`/`latestReviewPath`/`legacyCheckoutPath`）与 `ProjectStore.readIndex`/`mutateIndex`/`updateThread` 仍是活路径（`tool-runtime.ts:300`、`project-tools.ts:177`、`checkout-tools.ts:524/546`），KI-18 只把它们指派到 V0.3，没有"移除时同步什么"的清单。
- **版本别名与阶段探针**：`cowork_thread_*` 与 `cowork-thread` preset 按"保留一版"存在；`probe-engine.ts`/`s0-probe.ts` 是 M0/M1 阶段探针，产品无依赖，但仍随 dev 门打包。
- **文档**：`docs/archived/`、M6–M12 的 HANDOFF/RESULT、`.agents/notes` 的 proposed/implemented 迁移已经形成多层历史；`publish.json` 只保证"每个文件被分类"，不回答"这个文件是否还该在"。

后果：单文件 51,200 B、AGENTS 80 行与文档预算持续承压；旧驱动/旧证据的"绿"容易被误当现状证据（KI-29 的教训）；没有退役条件与台账，资产会一直保留而无人真跑；删除时又容易伤到仍在用的兼容面或漏改测试与文档指针。

## Proposal

**1) 统一的生命周期状态与台账。** 为代码与文档引入 5 个状态：`current`（当前实现）、`compat`（兼容层，产品仍调用，绑定移除版本）、`dev-only`（维护者/阶段面，非验收）、`historical`（历史证据/记录，只读）、`dead`（无产品调用且无守卫价值）。在 `docs/testing.md`（证据与分层规则的 home）增加"生命周期与退役"一节定义状态与巡检节奏；用一个轻量台账（`docs/LIFECYCLE.md`，或 `docs/testing.md` 内一张表）逐项记录：状态、owner 阶段、替代者、退役触发条件、删除时需同步的文件。首版台账覆盖：m2/m3 驱动、m12 驱动、probe 面、legacy 视图/字段、thread 别名、维护者 tools（panel-fixture / check-evidence-marker / migration drill）、测试中的历史守卫（`e2e-index-compat`、m2/m3 源码契约测试）、历史文档与 `publish.json` 分类。

**2) 代码处置规则。**
- `dead`：无产品调用且没有独立守卫价值 → 删除代码并删除为其续命的测试（或把测试价值迁到测试夹具）；首批候选 `renderMemoryEntry`、`formatMasterMessage`、`store` 的四个旧评审文件方法（先把 `tests/store.test.mjs` 的覆盖迁到新评审请求模型）。
- `dev-only` 阶段驱动（m2/m3）：保留条件收敛为"仍守卫活兼容面或提供不可替代的反例证据"（当前只有 `e2e-index-compat` 的 `parseIndex` 守卫与 KI-29 证据）；KI-18 的读路径在 0.3.0 移除时，同一版本删除驱动、`/dsh-cowork/e2e/m2|m3` 路由、其契约测试、source-budget 断言与文档指针，并把 `parseIndex` 兼容断言迁进 store 迁移测试。
- `compat`（legacy 字段/视图、thread 别名）：只在下一次 minor/major 版本移除；移除前必须同时完成：README 破坏性变更、KNOWN_ISSUES 对应条目关闭、迁移与回滚说明、阶段 RESULT 记录；同一版本内读路径与写路径一起处理，不得只删一半。
- `dev-only` 探针（probe-engine/s0）：保留仅当仍服务诊断/health；否则归档到 `tools/legacy/` 或删除，并在阶段 RESULT 记录。
- 每次删除同步更新：单文件预算断言（`tests/source-budget.test.mjs`）、README/KNOWN_ISSUES/决策记录指针、`docs/publish.json`（若删文档）。

**3) 测试与工具规则。** `tests/` 只保留三类：当前行为契约、活兼容守卫、仓库自身规则；为死代码续命的测试随代码一起删；真实 E2E 驱动作为验收 harness 按版本更新或重写，不被单测替代（继承 `docs/testing.md` 的分层）。`tools/` 的维护者工具（panel-fixture、check-evidence-marker、migration drill）登记 owner 与适用版本；drill 类一次性发布工具在对应发布线关闭后归档，除非它已成为低成本的永久回归。

**4) 文档规则。** 遵循 `docs/AGENTS.md` 的 kind 与 one-home：当前行为文档（README/routing/context/glossary）只描述现状；阶段交接/结果与 `docs/archived/` 文档为 `historical`，只允许追加指针或事实更正，不回填交付证据；每个阶段收口（RESULT）做一次台账巡检；`docs/README` 索引不列已删除的 home；`publish.json` 仍只负责分类，不替代生命周期判断（删文档时同步删条目）。

**5) 节奏与版本策略。** 每个里程碑收口 + 每次 minor 发布前做一次 prune 巡检（建议 ≤30 分钟：grep 引用、跑 source-budget/packaging、读台账）；版本策略：patch 保留兼容；minor（如 0.3.0）移除已到期的 `compat`/`dev-only` 资产；major 才允许语义重写。巡检结论写进该阶段 RESULT（不新开文档）；未处理项转 KNOWN_ISSUES 并指派完成阶段。

**6) 可选的自动化（先报告，不拦截）。** 新增只读脚本 `tools/lifecycle-report.mjs`：输出"无产品引用/仅测试引用、dev-only 路由、已过期 KI 对应文件"的清单，作为巡检输入；先不并入 `npm run check` 硬门禁（静态零引用有误报，会诱导改测试绕过），等规则稳定两个版本后再评估。

**7) 边界。** 不自动删代码（人工确认）；不删历史证据（gitignored 证据按保留策略处理）；不改写已推送历史；不为了"清零"把测试改成夹具了事。

## Alternatives considered

**只删不归档。** 否决：删掉阶段驱动会同时丢掉 KI-29 的反例证据与 v1/v2 读兼容守卫；应先迁移守卫价值再删。

**只归档不删。** 否决：仓库已有约 135 KB 旧驱动与多份历史文档，预算与认知成本继续上升；归档只适合证据/记录，不适合仍有 dev 路由与测试引用的代码。

**把静态死代码扫描直接并入 `npm run check` 当硬门禁。** 否决：静态"零引用"有误报（动态导入、字符串工具名、测试夹具），硬门禁会诱导改测试绕过；先用只读报告积累两个版本再决定。

**靠 KNOWN_ISSUES 逐条处理作为唯一策略。** 否决：KI 只记录已知问题，不覆盖"仍健康但已过期"的阶段资产；缺少台账与节奏会继续漏。

**每个大版本整体重写/重命名。** 否决：破坏历史可追溯性与证据链；按状态与触发条件增量退役成本更低。

## Acceptance criteria

- [A1] `docs/testing.md` 增加"生命周期与退役"一节（5 状态定义 + prune 节奏），并有一份台账逐项记录状态/owner/替代者/退役触发/同步文件 — `plan-docs`
- [A2] 三个 `dead` 候选（`renderMemoryEntry`、`formatMasterMessage`、store 四个旧评审方法）进台账并按规则处置；删除时同步测试与 source-budget 断言 — `source`
- [A3] 0.3.0 退役包在同一版本移除 m2/m3 驱动、dev 路由、契约测试与相关断言，`parseIndex` 兼容断言迁入 store 迁移测试，删除后 `npm run check`/`npm test` 全绿 — `tests`
- [A4] legacy 视图/字段与 thread 别名的移除与 README 破坏性变更、KNOWN_ISSUES 关闭、阶段 RESULT 记录在同一发布中完成 — `publication`
- [A5] 可选的 `tools/lifecycle-report.mjs` 只读报告能列出无产品引用/仅测试引用/dev-only 路由清单，且不并入硬门禁 — `workflow`
- [A6] 每个阶段收口的 RESULT 记录本次台账巡检结论；未处理项转 KNOWN_ISSUES 并指派阶段 — `plan-docs`
- [A7] 真实 E2E 驱动的状态（current/dev-only）、替代者与退役条件进入台账，后续按"语义更换即换驱动"执行 — `decisions`

## Risks

- 误删仍被动态引用或字符串工具名引用的代码 → 先标 `deprecated` 一个发布周期，删除前 grep 并跑全量检查。
- 台账变成第二份文档而漂移 → 台账只放状态与指针，细节仍归 `docs/testing.md`/KNOWN_ISSUES，阶段巡检校验一致性。
- 自动报告误报导致绕过 → 先只读、两个版本后再评估门禁。
- 重估条件：出现多团队并行贡献（需要更强交接），或单文件/文档预算再次逼近上限。

## Delivery stages

1. 台账与规则落地（`docs/testing.md` 一节 + 台账 + 首批 `dead` 登记）——不删代码，只立规则与清单。
2. 首批 `dead` 清理（`renderMemoryEntry`、`formatMasterMessage`、store 旧评审方法及其测试/断言）——可独立发布。
3. 0.3.0 退役包（legacy 读路径 + m2/m3 驱动 + thread 别名 + README/KNOWN_ISSUES/RESULT）——与 KI-18 同批。
4. 可选：`tools/lifecycle-report.mjs` 只读报告与首个巡检周期。
