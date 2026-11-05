# <title>

- Class: feature | bug-fix | simplification | architecture | process | testing
- Date: YYYY-MM-DD
- Status: proposed

## Proposal

Why do this, and what does done look like. Do not write implementation steps here.

- 背景与要解决的问题：<一段话>
- 提案内容：<接口、数据格式、行为变化>
- 完成定义：<可以被独立复核的结果>

## Alternatives considered

What was rejected and why. This section may not be empty.

- 方案 A（已否决）：<描述>。否决理由：<代价、风险或不满足的验收标准>
- 方案 B（已否决，如无则删除此行）：<描述>。否决理由：<…>

## Acceptance criteria

Each criterion carries a stable id (`AC-1`) and names, inside backticks, the check or surface in `tools/workflow.json` that will go red when it breaks.

- AC-1: <criterion> — `npm test`
- AC-2: <criterion> — `npm run typecheck`
- AC-3: <criterion> — `npm run build`

## Risks

What can go wrong, and what the fallback is.

- 风险 1：<描述> → 缓解/回退：<具体动作>
- 风险 2：<描述> → 缓解/回退：<具体动作>
