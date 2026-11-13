# Decision: 用 change-scope、review skill 与 PR 模板固定审查入口

Status: implemented
Date: 2026-11-13
Class: process

## Problem

本项目的审查规则分散在 [AGENTS.md](../../../../AGENTS.md)、[docs/agent-teams.md](../../../../docs/agent-teams.md)、[tools/workflow.json](../../../../tools/workflow.json) 和用户级工程规则里，但没有一个可执行的“本次改动范围”报告，也没有项目自己的 review 过程文件和 PR 描述骨架。

具体缺口：

- 审查者只能自己猜 base/head 和改动面；`tools/workflow.json` 能按路径给证据，但没有命令把 committed、staged、unstaged、untracked 分开列出。
- `docs/agent-teams.md` 定义了独立审查和 verdict，但没有一份加载即用的审查步骤；每次 review 依赖会话记忆和模型习惯。
- 没有 PR 模板，PR 容易只写“改了什么”，缺少测试设计、实际运行的命令、未运行项和证据。

## Decision

**1. `change-scope` 是审查的固定入口。** [scripts/change-scope.mjs](../../../../scripts/change-scope.mjs) 接收已验证的 `--base <ref>` 和可选 `--head <ref>`，解析 base/head/merge-base，输出 `formatVersion: 1` 的 JSON，包含 committed、staged、unstaged、untracked 四组路径。路径用 NUL 分隔解析，base 不可解析或 merge-base 不唯一时非零退出。`npm run change-scope -- --base <verified-base>` 已加入 [AGENTS.md](../../../../AGENTS.md)、[README.md](../../../../README.md) 和 [docs/testing.md](../../../../docs/testing.md)。

**2. 项目 review skill 拥有审查过程。** [.agents/skills/code-review/SKILL.md](../../../../.agents/skills/code-review/SKILL.md) 固定“固定范围 → 读需求 → 按优先级审查 → 验证证据 → 报告 finding → 独立 verdict”的流程。Finding 必须带 `path:line`、影响、证据和 required fix；blocker 与 suggestion 分开；实现者不得给自己的实现最终 verdict。[docs/agent-teams.md](../../../../docs/agent-teams.md) 只保留 DAG/verdict 所有权，并指向该 skill。

**3. PR 模板固定四个事实段落。** [.github/pull_request_template.md](../../../../.github/pull_request_template.md) 包含 `## Motivation`、`## Changes`、`## Testing`、`## Evidence`；Changes 区分 interface/behavior，Testing 先写 test design 再列实际运行的 test entries 和未运行项，Evidence 只放可复核的命令、计数、artifact identity、截图或外部状态。`docs/kinds.json` 将它归为 `template`，`docs/publish.json` 将 `.github/*` 归为 internal。

**4. 指针与索引同步。** 根 [AGENTS.md](../../../../AGENTS.md) 和 [docs/README.md](../../../../docs/README.md) 指向 review skill；[.agents/skills/README.md](../../../../.agents/skills/README.md) 增加“如何审查/准备 PR”的入口；[tests/workflow.test.mjs](../../../../tests/workflow.test.mjs) 固定 PR 模板 section、script、skill 和索引的一致性。

## Alternatives considered

**只写 prose 规则，不加 change-scope。** 否决：路径列表和 base/head 固定是审查最容易出错、也最适合机械化的部分；没有命令，规则仍靠记忆。

**直接照搬 deepseek-harness 的完整 code-review skill。** 否决：那套 skill 面向多包、ADR、defensive patterns、i18n、projection 和大量专门 gate；本项目需要更短、能指向现有 docs/agent-teams 和 workflow 的审查过程。

**照搬完整 PR 描述技能和 AI Usage 评分。** 否决：AI Usage 的 5 阶段百分比和徽章对当前单人、小仓库维护成本过高；先解决证据和测试描述缺失。

**继续没有 PR 模板，靠作者自由发挥。** 否决：模板能让“测试没跑”和“只写了实现细节”变得显眼；即使没有远端 PR，也可用于交接和结果记录。

## Consequences

- `change-scope` 只报告路径，不理解语义影响；审查者仍必须读需求、diff 和调用方。
- base 必须由审查者从 live PR/父分支验证；命令不自动 fetch，也不自动猜 base。
- 当前没有 CI，review skill 和 PR 模板不会被远端机器人强制执行；它们先作为 agent/human 的加载入口和 review 证据骨架，后续 CI 再引用。
- 完整 AI Usage 评分、stacked PR 流程和发布 workflow 未进入本决定；需要时另写记录。
- PR 模板会增加填写成本；证据、未运行项和 review focus 的收益高于这部分成本。

## Testing

- [A1] `npm run change-scope -- --base <ref>` 输出 base/head/merge-base 与四组路径；未知 base 非零退出 — `tests`：`tests/change-scope.test.mjs`、`npm run change-scope -- --base <verified-base>`
- [A2] review skill 的 description 是加载触发器，正文包含 When to use / How / Verification / Anti-patterns，并进入 docs/技能索引 — `agent-skills`：`npm run check`、`tests/workflow.test.mjs`
- [A3] PR 模板恰好匹配一种文档 kind 和一种发布分类，包含四个固定 section 与 `Not run` — `publication`：`tests/workflow.test.mjs`、`npm run check`
- [A4] AGENTS、README、testing 与 agent-teams 指向 change-scope/review skill，不复制其过程 — `workflow`：`tests/workflow.test.mjs`、`npm run check`
