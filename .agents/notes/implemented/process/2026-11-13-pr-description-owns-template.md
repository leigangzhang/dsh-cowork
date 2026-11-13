# Decision: 由 pr-description 技能拥有 PR 结构

Status: implemented
Date: 2026-11-13
Class: process

## Problem

PR 结构原先放在独立的 `.github/pull_request_template.md`，而 [.agents/skills/pr-description/SKILL.md](../../../../.agents/skills/pr-description/SKILL.md) 只描述“如何填模板”。这与技能复刻的目标相反：

- 技能应该声明“什么场景用、怎么组织内容、如何验证”；模板只是技能的一部分，拆成独立文件会让 skill 与 template 的规则分离。
- 删除或移动模板时，必须同时改 docs kind、publish manifest、README、review skill 和 contract test；维护面比内容本身更大。
- 当前没有 GitHub PR 模板消费方，单独文件没有额外价值，却让 `pr-description` 无法完整表达 PR 结构。

## Decision

**1. `pr-description` 技能同时拥有结构和内容。** [.agents/skills/pr-description/SKILL.md](../../../../.agents/skills/pr-description/SKILL.md) 内含固定的 fenced Markdown skeleton：`## Motivation`、`## Changes`（interface / behavior / review focus）、`## Testing`（test design / test entries / not run）、`## Evidence`。技能还声明触发条件、更新方式和验证要求。

**2. 删除独立模板。** `.github/pull_request_template.md` 已删除；[docs/kinds.json](../../../../docs/kinds.json) 的 `template` 只保留 `.agents/notes/*/TEMPLATE.md`，[docs/publish.json](../../../../docs/publish.json) 不再声明 `.github/*`。空 `.github/` 目录不进入 git。

**3. 引用改指技能。** [.agents/skills/code-review/SKILL.md](../../../../.agents/skills/code-review/SKILL.md) 指向 `pr-description`，[README.md](../../../../README.md) 说明 PR 结构由该技能声明，[tests/workflow.test.mjs](../../../../tests/workflow.test.mjs) 检查技能包含四个 section、`### Not run`、`change-scope` 命令，并断言独立模板文件不存在。

**4. 部分 supersedes。** 本记录只取代 [2026-11-13-review-scope-and-pr-template](2026-11-13-review-scope-and-pr-template.md) 中的独立模板决定；`change-scope`、review skill 和 PR 内容要求仍然有效。[2026-11-13-review-and-delivery-skills](2026-11-13-review-and-delivery-skills.md) 中“从模板文件取骨架”的细节也由本记录更新。

## Alternatives considered

**保留独立模板，只在 pr-description 中引用。** 否决：这正是当前状态，规则被拆成两个 home，且模板没有独立消费方；技能复刻的目的就是让技能声明场景和完整用法。

**把模板放进 docs/ 再链接。** 否决：PR 描述结构是 agent 执行流程的一部分，不是用户文档；放进 docs 只会增加分类和发布负担。

**保留模板但删除 docs 分类。** 否决：任何 tracked Markdown 都必须有 kind 和 publish 分类；绕过分类会破坏 `npm run check` 的单一事实源。

## Consequences

- 没有独立模板时，GitHub 或宿主不会自动把骨架插入 PR 编辑框；作者必须加载 `pr-description` 技能。
- 技能文本和实际 PR 仍可能漂移；contract test 只检查 section 名称和关键命令，不能检查内容质量。
- 历史决策记录保留当时的模板事实，并通过本记录标注 supersession；不再保留已删除模板的链接。
- PR 模板的 docs kind、publish 分类和 `.github/*` internal 规则被移除；未来如果引入 GitHub Actions，可重新创建非 Markdown 的 `.github` 文件，但不要把 PR 结构再拆出去。

## Testing

- [A1] `pr-description` 技能包含 Motivation / Changes / Testing / Evidence 骨架和三层子结构，并说明使用与更新规则 — `agent-skills`：`npm run check`、`tests/workflow.test.mjs`
- [A2] `.github/pull_request_template.md` 不存在；docs kind 与 publish 中不再有它的分类 — `publication`：`npm run check`、`tests/workflow.test.mjs`
- [A3] `code-review`、README 和测试都指向 pr-description 技能，不再引用独立模板 — `workflow`：`tests/workflow.test.mjs`
- [A4] 新旧决策记录通过 supersession 链接互相对应，链接不悬空 — `workflow`：`npm run check`
