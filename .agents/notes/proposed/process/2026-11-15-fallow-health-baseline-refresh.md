# Proposal: 刷新 fallow health 评审基线并清理 4 个浏览器 lane 函数

Status: proposed
Date: 2026-11-15
Class: process

## Problem

[fallow 决策](../../implemented/process/2026-11-14-fallow-code-health.md) 要求 `fallow health --baseline tools/fallow-health-baseline.json` 零新增 finding。实际上该基线早于 PR #38，main（`f1a4a6e`）上已有 11 条 finding 不在基线里，命令在 main 上就以 exit 1 失败；本次 layered coverage 改动 `fallow audit --base main` 的 introduced 为 0，说明这 11 条全部是 main 上的既有项，不是本分支引入。

| 位置 | 函数 | 严重度 | 类别 |
|---|---|---|---|
| [browser-panel.mjs:234](../../../../scripts/evidence/browser-panel.mjs) | `publishCoverage` | critical | CRAP |
| [browser-panel.mjs:307](../../../../scripts/evidence/browser-panel.mjs) | `main` | critical | CRAP |
| [client-coverage.mjs:236](../../../../scripts/evidence/client-coverage.mjs) | `mapFunctionCoverage` | high | CRAP |
| [client-coverage.mjs:187](../../../../scripts/evidence/client-coverage.mjs) | `buildCoverageMask` | high | cognitive/CRAP |
| [dsh-host-session.mjs:201](../../../../scripts/evidence/dsh-host-session.mjs) | `startDshHost` | moderate | cognitive |
| [client-coverage.mjs:168](../../../../scripts/evidence/client-coverage.mjs) | `buildRangeIndex` | moderate | CRAP |
| [workflow.test.mjs:45](../../../../tests/guards/workflow.test.mjs) | `tools/workflow.json declares unique surf...` | moderate | CRAP |
| [workflow.test.mjs:87](../../../../tests/guards/workflow.test.mjs) | `executable test lanes are wired to scrip...` | moderate | CRAP |
| [browser-panel.mjs:128](../../../../scripts/evidence/browser-panel.mjs) | `coverageEntryEvidence` | moderate | CRAP |
| [browser-panel.mjs:79](../../../../scripts/evidence/browser-panel.mjs) | `remoteResult` | moderate | CRAP |
| [browser-panel.mjs:142](../../../../scripts/evidence/browser-panel.mjs) | `failurePayload` | moderate | CRAP |

两个 critical 来自 CRAP 的静态估算（复杂度 × 无覆盖率数据），不是正确性缺陷；但基线不更新会让 health 门禁长期失效，新 finding 也看不见。四个浏览器 lane 函数（`publishCoverage`、`main`、`buildCoverageMask`、`mapFunctionCoverage`）确实值得拆分和补测试，问题在于它们和基线刷新混在一起会让 PR 既有行为变更又有覆盖率调整，难以评审。

## Proposal

**1. 基线刷新独立成 PR。** 在最新 main 上重新生成 `tools/fallow-health-baseline.json`，让 11 条已知 finding 进入基线；不改任何源码行为、不调整阈值、不增加 ignore。PR 只包含基线文件与必要说明，验证 `fallow health --baseline tools/fallow-health-baseline.json` 在 main 上 exit 0。

**2. 保留 new-only 闸门。** `fallow audit --base main` 继续作为变更级阻断信号；基线刷新后，任何新增 complexity/duplication/dead-code 仍必须失败。基线更新只允许在独立维护 PR 中进行，且必须逐条核对新增条目，不能整文件无脑覆盖。

**3. 拆分并补测 4 个函数。** 另开代码清理任务，不改阈值来消 finding：
- `browser-panel.mjs` 的 `main`/`publishCoverage`：把参数解析、coverage 发布、报告收尾拆成可测函数，补纯函数单测和失败报告用例。
- `client-coverage.mjs` 的 `buildCoverageMask`/`mapFunctionCoverage`：把范围索引、source 解析、映射过滤拆开，补 sourcemap 边界与越界行用例。
- `dsh-host-session.mjs` 的 `startDshHost` 与 3 个 browser-panel 小函数：随浏览器 lane 的单测一起拆分，不单独做“为降复杂度”的机械重构。
- `workflow.test.mjs` 的两个测试：若拆分后仍超阈值，再评估把矩阵断言抽成 helper；不在基线刷新 PR 中改测试行为。

**4. 版本与重新生成时点。** 基线由 fallow CLI 3.43.0 生成，PR/记录中写明版本与运行时的 HEAD。建议在本覆盖门禁 PR 合并后、main 上重新生成一次，确保新文件没有引入 finding；若未来升级 fallow 版本，按独立 PR 重新生成并对比差异，不静默替换。

**5. 文档与检查。** 更新 [AGENTS.md](../../../../AGENTS.md)、[docs/testing.md](../../../../docs/testing.md) 与 [code-review skill](../../../skills/code-review/SKILL.md)，写明：health 基线是受审的存量状态，new-only 是阻断闸门；基线更新与代码清理分开。若 CI 引入 fallow，使用同一版本和基线，并把 health 作为独立 job，避免与覆盖率 gate 混跑。

## Alternatives considered

**先把 11 条全部修复再刷新基线。** 否决：两个 critical 和两个 high 涉及拆分浏览器 lane 与补单测，周期远长于门禁失效的修复；先恢复 health 闸门，再做清理，风险更小。

**继续让基线停在 PR #38 之前。** 否决：main 的 health 已经是红的，任何 PR 都无法用它判断新增；这会让 new-only 闸门名存实亡。

**调整 fallow 阈值或 ignore 这 11 条。** 否决：等于把已知债务藏起来，未来同类函数不会再被报告；现有决策明确基线是评审状态，不是豁免。

**把 fallow 加入 devDependency 并在 CI 强制。** 否决：现有决策已拒绝为约 43 MB 的平台二进制和首个 lockfile 增加依赖；除非 CI 强制成为独立需求，否则保持本地 CLI。

**在基线刷新 PR 中顺手重构 4 个函数。** 否决：行为变更与基线重生成混在一起，reviewer 无法区分“接受存量”与“引入新行为”；拆分和补测应独立评审。

## Acceptance criteria

- [A1] 在最新 main 上重新生成基线后，`fallow health --baseline tools/fallow-health-baseline.json` exit 0，11 条既有 finding 全部在基线中；基线 PR 不包含源码行为变更 — `workflow`
- [A2] 基线刷新后，一个合成的复杂度/重复新增 finding 仍使 `fallow audit --base main` 失败（负向控制）；没有通过改阈值或 ignore 消除 finding — `workflow`
- [A3] 4 个浏览器 lane 函数拆分为可测函数，并补 sourcemap 边界/失败报告/映射过滤单测；拆分后 fallow health 不再报告这些 finding — `source`
- [A4] `workflow.test.mjs` 的两个测试只有在拆分后仍超阈值时才重构，且不改变其断言的行为 — `tests`
- [A5] `AGENTS.md`、`docs/testing.md`、code-review skill 写明基线更新与 new-only 闸门；如果 CI 引入 fallow，使用同一 CLI 版本和基线 — `plan-docs`

## Risks

- 刷新基线会一次性接受 11 条存量 finding；若其中混入新问题，会被一起“洗白”。缓解：逐条核对来源与 main 历史，PR 描述列出每个条目及 main 上的既有证据。
- fallow 版本升级会改变 finding 集合与行号。缓解：记录 3.43.0，升级走独立 PR 并对比基线差异，不静默替换。
- 拆分函数可能引入行为变化。缓解：A3 要求先补行为测试再拆分，拆分 PR 单独跑浏览器 lane/单测；不以“复杂度下降”作为唯一验收。
- 基线文件与行号绑定，源码修改后条目会移动。缓解：基线按函数名/路径记录，刷新时核对重命名；行号变化本身不改变判定。
- health 与 coverage 两套门禁都依赖本地工具，CI 未落地前可能再次漂移。缓解：本提案只恢复本地 health；CI 引入时按 A5 固定版本并单独 job。

## Delivery stages

1. 在最新 main 上刷新 fallow health 基线，确认 exit 0，提交独立 PR。
2. 拆分 `browser-panel` 的 `main`/`publishCoverage`，补失败报告与发布路径单测。
3. 拆分 `client-coverage` 的 `buildCoverageMask`/`mapFunctionCoverage`，补 sourcemap 边界/越界行单测。
4. 处理 `dsh-host-session.startDshHost` 与 3 个 browser-panel 小函数，按浏览器 lane 单测一起拆分。
5. 复核 `workflow.test.mjs` 两个测试；确认 health 与 audit new-only 均绿后收口。
