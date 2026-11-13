# Decision: 本地化审查与交付技能并去掉 dsh 前缀

Status: implemented
Date: 2026-11-13
Class: process

## Problem

本仓库原先只有 `dsh-cowork-review` 一份审查技能。deepseek-harness 已经把 code review、pre-push 取证、PR 描述、stacked PR 合并和 find-simplifications 拆成可加载的技能，但直接照搬会带来两个问题：

- 技能名带 `dsh-`/`dsh-cowork-` 前缀，和本项目其他技能（`write-docs`、`prose-standard`、`trim-cot-leakage`）的命名不一致，用户明确要求去掉。
- 源技能假设 pnpm monorepo、原生 GitHub stack、完整 CI 和多包发布；本项目是单包、npm、lib 跟踪、host smoke 本地优先。逐字复制会把不存在的基础设施写成事实。

## Decision

**1. review 技能改名为 `code-review`。** [.agents/skills/code-review/SKILL.md](../../../../.agents/skills/code-review/SKILL.md) 保留本项目的 `change-scope`、AgentTeams verdict、独立审查和 finding 格式；description 仍以 `Use when` 开头。所有技能目录不得以 `dsh-` 开头，[tests/workflow.test.mjs](../../../../tests/workflow.test.mjs) 固定该规则。

**2. 新增 `pre-push-checks`。** [.agents/skills/pre-push-checks/SKILL.md](../../../../.agents/skills/pre-push-checks/SKILL.md) 先确认 live base、跑 `change-scope`，再按 [tools/workflow.json](../../../../tools/workflow.json) 选取最小证据。它明确保留本项目的严格限制：不使用 force/force-with-lease，不跳过 `check:lib-sync`，只在跨仓库、诊断 CI 或用户明确要求时做完整本地预演。

**3. 新增 `pr-description`。** [.agents/skills/pr-description/SKILL.md](../../../../.agents/skills/pr-description/SKILL.md) 以 [.github/pull_request_template.md](../../../../.github/pull_request_template.md) 为唯一骨架，固定 Motivation / Changes / Testing / Evidence。Testing 先写 test design，再列实际运行的 test entries 和未运行项；不复制完整 AI Usage 评分。

**4. 新增 `merging-stacked-prs`。** [.agents/skills/merging-stacked-prs/SKILL.md](../../../../.agents/skills/merging-stacked-prs/SKILL.md) 只在真实 A←B←C 依赖链时使用 GitHub 原生 stack；先核对 official stack、live heads、review 和 checks，再通过 `gh stack merge` 合并。无 stack 需求时继续单主题分支，不手工 retarget 多个 PR。

**5. 新增 `find-simplifications`。** [.agents/skills/find-simplifications/SKILL.md](../../../../.agents/skills/find-simplifications/SKILL.md) 以移除维护义务为目标，要求 producer/consumer 证据、能力损失、兼容与失败语义；候选包括 legacy M2/M3/M12 dev 面、过期 `.dsh-cowork/e2e` 运行材料、重复 gate 逻辑和无人读取的配置。

**6. 索引与文档同步。** [.agents/skills/README.md](../../../../.agents/skills/README.md) 和 [docs/README.md](../../../../docs/README.md) 路由到五个技能；根 [AGENTS.md](../../../../AGENTS.md) 按 description 加载它们；docs/agent-teams 的 review 段指向 `code-review`。

## Alternatives considered

**保留 `dsh-` 前缀。** 否决：用户明确要求去掉，而且本项目已有无前缀技能；同一加载面里两套命名只会增加歧义。

**把五个来源技能逐字复制。** 否决：会把 pnpm、CI、多包 stack 和完整 AI Usage 规则带进来，和本项目的 npm/lib/host-smoke 事实冲突。

**做一个万能 review skill。** 否决：审查、预推送、PR 描述、stack 合并和简化调查的触发条件与输出不同；合并会让 loader 无法按任务选择正确流程。

**只改 review 名称，不新增其他技能。** 否决：pre-push 和 PR 模板已经存在，但缺少可加载的操作流程；simplification 也需要独立的证据标准。

## Consequences

- 五个技能都是加载指导，不是执行器；`npm run check` 只证明结构、触发描述和索引，不能证明模型实际遵守流程。
- `pre-push-checks` 的命令选择仍依赖 `change-scope` 与 workflow surface；路径报告不能替代语义审查。
- `merging-stacked-prs` 依赖 GitHub 原生 stack 扩展；本仓库没有 CI 强制，也没有必须使用 stack 的现状，因此它是条件性流程。
- `find-simplifications` 可能把“本地无调用者”误判为可删；技能要求先证明生产者、消费者、兼容性和能力损失。
- 当前没有 CI/自动 PR 检查；技能不会阻止远端分支在缺少证据时被推送。

## Testing

- [A1] `code-review` 取代 `dsh-cowork-review`，所有技能目录不再以 `dsh-` 开头，索引和文档引用同步 — `agent-skills`：`tests/workflow.test.mjs`、`npm run check`
- [A2] `pre-push-checks` 使用 change-scope/workflow 选证据，并明确禁止 force 与重复全量预演 — `agent-skills`：`npm run check`、`tests/workflow.test.mjs`
- [A3] `pr-description` 与 PR 模板一致；`merging-stacked-prs` 只在真实依赖链用官方 stack；`find-simplifications` 要求 producer/consumer 与能力损失证据 — `agent-skills`：`npm run check`
- [A4] docs/README、skills README 和 AGENTS 都路由到五个技能，workflow 契约测试通过 — `workflow`：`tests/workflow.test.mjs`、`npm run check:self-test`
