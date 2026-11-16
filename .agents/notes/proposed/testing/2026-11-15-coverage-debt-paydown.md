# Proposal: 分批偿还 1,055 行覆盖率基线债务

Status: proposed
Date: 2026-11-15
Class: testing

## Problem

逐文件覆盖率门禁已落地（[决策记录](../../implemented/testing/2026-11-13-layered-100-coverage-gate.md)，提交 `30f05e1`）。unit 侧当前有 60 个模块，24 个已到行 100%，36 个仍有缺口，合计 1,055 行未覆盖，记录在 [coverage-debt.json](../../../../tools/coverage-debt.json)。按目录：`src/tools` 387、`src/domains` 311、`src/app` 139、`src/store` 94、`src/platform` 67、`src/client` 34、`src/panel` 23。最大模块是 `tools/topic.ts` 97、`tools/review.ts` 87、`app/apply.ts` 77、`tools/memory.ts` 68、`app/dev-surfaces.ts` 62、`tools/isolation.ts` 58。

缺口主要是错误、清理、校验分支和未被 unit 调用的 handler，而不是正常主路径：topic 创建失败后的归档回滚、git/工具失败映射、apply 的未知 workspace 与 memory 读取降级、M12 dev route 的成功/status 路径、review extra 字段 JSON 校验、store corrupt/migration 回退。

基线是逐行集合 ratchet：新增未覆盖行失败，已覆盖行使条目过期；`--update-debt` 默认拒绝新增未覆盖行，只有 `--accept-regression` 才能写入。当前没有按风险分批偿还的计划；如果每个功能 PR 顺带修改这些文件，基线会反复刷新，diff 噪声会掩盖真实回归。

## Proposal

**1. 按风险和依赖分批，不按行数排序。** 每批只碰一个域，批内先做状态机/安全边界，再做错误映射，最后做 dev/admin 表面。

| 批次 | 范围 | 缺口 | 优先模块 |
|---|---|---|---|
| B1 | `src/domains` | 311 | review-request、request-lifecycle、authorization-decision、isolation/work-item、checkout |
| B2 | `src/tools` | 387 | topic、review、isolation、request、memory；先补失败路径与回滚 |
| B3 | `src/app` + `src/store` + `src/platform` | 300 | apply、dev-surfaces、project-store、tool-runtime |
| B4 | `src/client` + `src/panel` | 57 | model/notice-model/panel 的边界分支；与浏览器 owner 分开 |

**2. 每个缺口的处理顺序。** 先判断分支是否可达：不可达的防御代码删除，并让既有架构/契约测试继续证明删除安全；可达的错误路径用注入的 fake 依赖补行为测试，断言错误码、上下文和清理结果，不写只为覆盖率的空断言。禁止 coverage ignore、`/* c8 ignore */`、删除断言或放宽类型来消债。

**3. 基线更新只随批次 PR 发生。** 修改带债文件后，在该 PR 内运行 `npm run test:coverage -- --update-debt`，人工核对 removed（改善）与 added（回归）。`--accept-regression` 仅用于已评审的、确实必须新增未覆盖代码的例外；PR 描述必须写明原因和后续偿还条目，未写明不得使用。

**4. 每批完成定义。** 基线总行数严格下降；本批触及的每个 unit-owned、非 type-only 模块达到行 100%；新增/修改行为都有对应测试；`npm run test:coverage` 在不加 `--update-debt` 时通过；`npm run check` 通过。

**5. 不纳入本提案。** `src/dev/m12-e2e*` 等 dev 例外随 versioned E2E 删除，不投入覆盖率；`notice.tsx` 由 KI-40 与浏览器 lane 处理；branch/function 仍是 advisory，不在本提案内收紧。

**6. 收口。** 四个批次完成后，[coverage-debt.json](../../../../tools/coverage-debt.json) 的 `files` 为空数组，所有 unit-owned 非 type-only 模块行 100%；[docs/testing.md](../../../../docs/testing.md) 与 [AGENTS.md](../../../../AGENTS.md) 删除“按基线偿还”的临时说明，只保留 per-file 100 规则。

## Alternatives considered

**一次性把 1,055 行全部补齐再合并门禁。** 否决：门禁机制已经可用，等待全量清债会让机制长期停在未合并状态；分批还能让每批的失败模式单独评审。

**继续把清债混进功能 PR。** 否决：功能 PR 的 diff 会被基线刷新和错误分支测试撑大，review 无法区分行为变更与覆盖率补丁。

**用 `--accept-regression` 批量接受现有缺口。** 否决：这会把基线降级成快照，失去 ratchet 的意义；例外必须逐个评审并写明偿还计划。

**把 `src/client` 的 `.ts` 交叉数据算进浏览器 lane。** 否决：owner map 已规定这些文件归 unit；算进浏览器会制造第二个 owner，且浏览器场景无法覆盖 Node-only 分支。

**为达标删除测试或加 ignore 注释。** 否决：违反“测试描述行为”和“不靠删除断言变绿”；缺口要么补行为测试，要么删除确实不可达的代码。

## Acceptance criteria

- [A1] 按 B1–B4 分四批完成；每批 PR 的基线总数严格下降，且本批触及的 unit-owned 非 type-only 模块行覆盖率为 100% — `tests`
- [A2] 每个新增的失败路径测试断言可观察行为（错误码/上下文/清理/状态），不出现只为覆盖率的空断言；删除的代码有架构或契约测试证明不可达 — `tests`
- [A3] 任何 `--accept-regression` 使用都在 PR 描述中记录原因与后续偿还项，并经 reviewer 明确同意 — `workflow`
- [A4] 收口时 `coverage-debt.json` 的 `files` 为空数组，`npm run test:coverage` 在不带 `--update-debt` 时通过，`npm run check` 通过 — `workflow`
- [A5] 收口后 `docs/testing.md` 与 `AGENTS.md` 只保留 per-file 100 规则，不再引用债务批次 — `plan-docs`

## Risks

- 部分防御分支可能永远不可达；错误地补测试会制造伪行为。缓解：先用架构/类型/调用方证据证明不可达，再删除。
- 覆盖率驱动的测试可能只执行不判断。缓解：A2 要求断言可观察结果，review 按行为测试标准检查。
- 修改带债文件会移动行号，基线刷新可能掩盖回归。缓解：每次更新人工核对 added/removed，并在 PR 描述贴出总行数变化。
- 批次跨度过大导致 review 疲劳。缓解：每批再按模块拆成多个小 PR，单个 PR 只做 1–2 个模块。
- `--accept-regression` 被滥用。缓解：默认拒绝 + PR 描述强制记录 + reviewer 明确同意；收口前审计所有使用记录。

## Delivery stages

1. B1 `src/domains`，先状态机与失败回滚。
2. B2 `src/tools`，先 topic/review 的失败与清理。
3. B3 `src/app` + `src/store` + `src/platform`，先 apply 与 store 回退。
4. B4 `src/client` + `src/panel`，最后清剩余行。
5. 收口：空债务文件、文档收敛、`--accept-regression` 使用审计。
