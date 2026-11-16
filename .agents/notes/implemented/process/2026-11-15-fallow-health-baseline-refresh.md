# Decision: 刷新 fallow health 评审基线并清理浏览器 lane 的复杂函数

Status: implemented
Date: 2026-11-15
Class: process

## Problem

[fallow 决策](../../implemented/process/2026-11-14-fallow-code-health.md) 要求 `fallow health --baseline tools/fallow-health-baseline.json` 零新增 finding。该基线早于 PR #38；main（`20f09c9`）上已有 11 条 finding 不在基线里，命令在 main 上就以 exit 1 失败，于是新 finding 与存量 finding 无法区分，new-only 信号实际失效。

这 11 条是 `browser-panel.mjs` 的 `publishCoverage`、`main`、`coverageEntryEvidence`、`remoteResult`、`failurePayload`，`client-coverage.mjs` 的 `mapFunctionCoverage`、`buildCoverageMask`、`buildRangeIndex`，`dsh-host-session.mjs` 的 `startDshHost`，以及 `tests/guards/workflow.test.mjs` 的两个矩阵测试。两个 critical 来自 CRAP 的静态估算（复杂度 × 无覆盖率数据），不是正确性缺陷；但基线不更新会让 health 门禁长期失效。

基线还保留了一条 `scripts/evidence/host-smoke.mjs` 的 `crap_high`，当前分析已不再报告它，属于过期条目。

## Decision

- `tools/fallow-health-baseline.json` 由 fallow 3.43.0 在 main `20f09c9` 上重新生成：11 条既有 finding 进入基线，1 条过期的 host-smoke 条目被移除；没有改阈值、源码行为或 `.fallowrc.jsonc` 的 ignore。刷新后 `fallow health --baseline ...` 退出 0。
- 基线是受审的存量状态，不是豁免。`fallow health --baseline tools/fallow-health-baseline.json` 必须零新增；`fallow audit --base <base>` 继续作为变更级阻断，新增 complexity、duplication 与 dead code 会让它失败。基线刷新只在独立维护 PR 中进行，写明 CLI 版本与 HEAD，并逐条核对新增条目；不在 feature 或 cleanup PR 内刷新。若 CI 引入 fallow，使用同一 CLI 版本与基线，并作为独立 job。
- 清理把 4 个浏览器 lane 函数拆成可测的小函数，整组 finding 清零后从基线剪掉：`browser-panel.mjs` 的 `publishCoverage`/`main` 拆出 source map 获取、artifact、输出写入与 lane 生命周期，证据塑形移到 `scripts/evidence/browser-evidence.mjs`；`client-coverage.mjs` 的范围索引、覆盖掩码、函数映射各自拆开；`dsh-host-session.mjs` 的 `startDshHost` 拆出布局、环境、安装与连接阶段，spawn 后立即登记 provisional connection，使 ready 超时或 token 交换失败仍会 detach 管道并停止子进程。`tests/guards/workflow.test.mjs` 的两个矩阵测试在仍然超阈值时抽出断言 helper，断言与顺序不变。
- `scripts/evidence/browser-evidence.mjs` 归入 `tools/workflow.json` 的 `browser` surface。`AGENTS.md`、`docs/testing.md` 与 [code-review skill](../../../skills/code-review/SKILL.md) 记录上述刷新与 new-only 规则。
- 清理后基线为 41 个文件 / 157 个类别计数 / 23 个 target key（main 原基线 43 / 159 / 19）；`fallow health --baseline` 报告 116 个超阈值函数，全部在基线的受审范围内。

## Alternatives considered

**先把 11 条全部修复再刷新基线。** 否决：两个 critical 与两个 high 要拆浏览器 lane 并补单测，周期长于恢复门禁；先恢复、再清理风险更小。清理在同一工作流内完成，基线没有长期停在 169 条。

**继续让基线停在 PR #38 之前。** 否决：main 的 health 已经红了，任何 PR 都无法用它判断新增，new-only 名存实亡。

**调整 fallow 阈值或 ignore 这 11 条。** 否决：等于把已知债务藏起来，未来同类函数不会再被报告；基线的用途是记录评审过的存量，不是豁免。

**把 fallow 加入 devDependency 并在 CI 强制。** 否决：会引入约 43 MB 的平台二进制和首个 lockfile，只为换取一个评审时即可读取的本地信号；除非 CI 强制成为独立需求，保持本地 CLI。

**在基线刷新 PR 中顺手重构 4 个函数。** 否决：行为变更与基线重生成混在一起，reviewer 无法区分「接受存量」与「引入新行为」。交付拆成两个 PR：刷新只含基线与文档，清理另有代码与测试。

## Consequences

- 11 条 finding 被短期接受，但在同一工作流的清理 PR 中全部消除并从基线剪掉。刷新净增 10 个类别计数（159 → 169），清理净减 12 个（169 → 157），最终比 main 少 2 个（157 对 159）。
- 清理不改变行为：浏览器 lane 的 coverage 发布、失败证据、source map 映射与 host 生命周期由真实 `npm run test:browser` 和 host smoke 验证；新增单测只固定既有边界。
- 基线是 `count` 模式的按文件/类别计数，不是按函数身份；重命名或移动函数后需要重新刷新，行号变化本身不影响判定。若未来升级 fallow，按独立 PR 重新生成并对比差异，不静默替换。
- 基线刷新依赖本地 CLI，CI 尚未运行 fallow；因此评审采纳仍是执行方式，门禁的漂移由下一次维护 PR 暴露。新工作引入 finding 时，由引入它的 PR 负责修复或在独立维护 PR 中刷新，不能混入功能 PR。
- `workflow.test.mjs` 的两个测试只做了断言 helper 抽取；`fallow health` 不再报告它们，测试数量与断言顺序未变。

## Testing

- [A1] 在 main `20f09c9` 上重新生成基线后，`fallow health --baseline tools/fallow-health-baseline.json` 退出 0，11 条既有 finding 全部进入基线；刷新 PR 不含源码行为变更。 — `workflow`
- [A2] 合成了一个 24 分支的 `negativeControl` 函数：`fallow health --baseline` 退出 1，`fallow audit --base origin/main` 退出 1；删除后两者恢复退出 0。没有改阈值或加 ignore。 — `workflow`
- [A3] 4 个浏览器 lane 函数拆成可测小函数；新增 sourcemap 越界/嵌套/重复映射、失败报告脱敏、hostLayout/hostEnvironment、token 交换失败停止子进程的回归用例；拆分后 `fallow health` 不再报告这些 finding。 — `source`
- [A4] `workflow.test.mjs` 的两个测试在拆分后仍超阈值时抽出断言 helper；`npm test` 1041 项通过，断言与顺序未变。 — `tests`
- [A5] `AGENTS.md`、`docs/testing.md` 与 code-review skill 写明基线刷新与 new-only 闸门；CI 未引入 fallow，条件性条款已记录。 — `plan-docs`
