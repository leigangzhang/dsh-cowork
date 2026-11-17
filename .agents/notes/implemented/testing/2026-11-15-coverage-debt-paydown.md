# Decision: 分批清零逐文件覆盖率债务

Status: implemented
Date: 2026-11-15
Class: testing

## Problem

逐文件覆盖率门禁已落地（[决策记录](2026-11-13-layered-100-coverage-gate.md)），unit 侧 60 个模块中 24 个已到行 100%，其余 36 个合计 1,055 行未覆盖，记录在 [coverage-debt.json](../../../../tools/coverage-debt.json)。缺口集中在错误、清理、校验分支和未被 unit 调用的 handler：topic 创建失败后的归档回滚、git/工具失败映射、apply 的未知 workspace 与 memory 读取降级、review extra 字段校验、store corrupt/migration 回退，而不是正常主路径。

基线是逐行集合 ratchet：新增未覆盖行失败，已覆盖行使条目过期；`--update-debt` 默认拒绝新增未覆盖行。没有按风险分批的计划时，功能 PR 顺带修改带债文件会让基线反复刷新，diff 噪声掩盖真实回归；同时 1,055 行的缺口长期停在门禁豁免里，等于门禁对三分之二的 unit 模块没有约束力。

## Decision

**1. 按风险和依赖分四批，不按行数排序。** B1 `src/domains`（状态机/安全边界优先）、B2 `src/tools`（失败路径与回滚）、B3 `src/app` + `src/store` + `src/platform`、B4 `src/client` + `src/panel`。每批独立分支、独立 PR、独立 reviewer；批内先补可达失败路径，再处理 dev/admin 表面。

**2. 每个缺口先判可达性。** 不可达的防御代码删除，并让既有架构/契约测试继续证明删除安全；可达分支用注入的 fake 依赖补行为测试，断言错误码、上下文和清理结果。禁止 `/* c8 ignore */`、删除断言或放宽类型来消债。

**3. 基线只随批次 PR 更新。** 每批在 PR 内运行 `npm run test:coverage -- --update-debt`，人工核对 removed/added。`--accept-regression` 仅用于已评审、确需新增未覆盖代码的例外；PR 描述必须写明原因与后续偿还项。整个清债过程只有 B2 使用过一次：为 `topic.ts` 增加 `createProjectStore` 测试缝导致 `tool-runtime.ts` 的 40 条既有未覆盖行整体搬移，逐条内容核对一致、总数不变，后续随 B3 偿还；reviewer 明确同意。

**4. 每批完成定义。** 基线总数严格下降；本批触及的 unit-owned 非 type-only 模块行 100%；新增/修改行为有测试；`npm run test:coverage` 不带 `--update-debt` 通过；`npm run check` 通过。

**5. 不纳入范围。** `src/dev/m12-e2e*` 等 dev 例外随 versioned E2E 删除（PR #54 已退役 M12 驱动，`dev-surfaces.ts` 只剩 health 路由并达到 100%）；`src/client/notice.tsx` 由 KI-40 与浏览器 lane 处理；branch/function 保持 advisory。

**6. 收口。** [coverage-debt.json](../../../../tools/coverage-debt.json) 的 `files` 为空数组；`buildBaseline` 只记录仍有未覆盖行的模块，已到 100% 的模块不再生成条目（否则每次改善都留下过期条目）；[docs/testing.md](../../../../docs/testing.md) 与 [AGENTS.md](../../../../AGENTS.md) 只保留 per-file 100 规则，不再引用债务批次。

最终状态：unit 侧 60 个 owner 模块行覆盖 100%（24,209/24,209），`coverage-debt.json` 为 `{ "version": 1, "files": [] }`。四个批次分别由 PR #49（B1）、#53（B2）、#55（B3）与本轮收口 PR（B4 + 收口）交付。

## Alternatives considered

**一次性把 1,055 行全部补齐再合并门禁。** 否决：门禁机制已经可用，等待全量清债会让机制长期停在未合并状态；分批还能让每批的失败模式单独评审。

**继续把清债混进功能 PR。** 否决：功能 PR 的 diff 会被基线刷新和错误分支测试撑大，review 无法区分行为变更与覆盖率补丁。

**用 `--accept-regression` 批量接受现有缺口。** 否决：这会把基线降级成快照，失去 ratchet 的意义；例外必须逐个评审并写明偿还计划。

**把 `src/client` 的 `.ts` 交叉数据算进浏览器 lane。** 否决：owner map 已规定这些文件归 unit；算进浏览器会制造第二个 owner，且浏览器场景无法覆盖 Node-only 分支。

**为达标删除测试或加 ignore 注释。** 否决：违反“测试描述行为”和“不靠删除断言变绿”；缺口要么补行为测试，要么删除确实不可达的代码。

**保留 100% 模块的空基线条目。** 否决：空条目只重复门禁已经保证的事实，还会在后续改动行号时制造无意义的 stale 刷新；基线只记录债务，不记录覆盖率快照。

## Consequences

- 覆盖率门禁现在对全部 unit-owned 模块都是同一规则：行 100%，或基线里一条经评审的例外；当前例外集为空。
- 删除分支的安全性依赖既有架构/契约测试与领域不变量；review 仍需检查“删除的是不是唯一防线”，删除记录在各 PR 描述与提交信息中。
- 清债过程新增的测试主要覆盖失败/清理/回滚路径，正常路径的回归保护来自原有测试；`apply` 的异步就绪等待改为带失败上限的让步轮询（慢 CI 上 `setImmediate` 循环会耗尽）。
- `--accept-regression` 的唯一一次使用已在 B2 PR 与 reviewer 记录中闭环，收口时审计无遗漏。
- branch/function 仍是 advisory；未来若要收紧，需要单独决策记录与稳定度量方式。

## Testing

- [A1] B1–B4 四批完成；每批 PR 的基线总数严格下降，本批触及的 unit-owned 非 type-only 模块行 100% — `tests`
- [A2] 新增失败路径测试断言可观察行为（错误码/上下文/清理/状态），删除代码有架构或契约测试证明不可达 — `tests`
- [A3] `--accept-regression` 的使用记录原因与后续偿还项，并经 reviewer 明确同意（仅 B2 一次，已在 PR #53 记录） — `workflow`
- [A4] `coverage-debt.json` 为 `{ "version": 1, "files": [] }`；`npm run test:coverage` 不带 `--update-debt` 通过；`npm run coverage:check` 与 `npm run check` 通过 — `workflow`
- [A5] `docs/testing.md` 与 `AGENTS.md` 只保留 per-file 100 规则，不再引用债务批次 — `plan-docs`
