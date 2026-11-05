# <title>

- Class: feature | bug-fix | simplification | architecture | process | testing
- Date: YYYY-MM-DD
- Status: implemented

## Decision

Present-tense statement of what landed and why.

- 已落地：<接口、数据格式、行为>
- 理由：<为什么选它而不是 Alternatives 里被否决的方案>

## Consequences

What the code and the workflow now require; which previous state this replaced.

- 新增约束：<后续开发者必须遵守的规则或路径>
- 替代关系：<这个决策取代了哪个旧方案/旧文件>
- 移除或迁移：<是否有旧记录、旧字段需要迁移>

## Testing

What was verified, keeping the original acceptance-criterion ids (`AC-1`, …), and what was not verified.

- AC-1: 已验证 — 证据命令 `npm test`，对应 surface：`tests`。结果：<pass/fail + 关键证据>
- AC-2: 未验证 — 原因：<依赖未构建 / 需要真实 DSH 会话 / 外部环境缺失>；对应 surface：`source`
- 未运行项：<列出没有跑的东西，不要写“都通过了”>
