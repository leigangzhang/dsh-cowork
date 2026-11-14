# Decision: 统一 review、PR 与技能工作流

Status: implemented
Date: 2026-11-13
Class: process

## Problem

审查、PR 描述和技能复刻原本落成了三份相邻决策记录，内容互相引用又分别维护：`change-scope`、`code-review`、PR 结构、技能命名和 dsh 迁移差异被拆在三个文件里。继续按这个粒度记录，会让同一条工作流出现多个事实源，也让每个小改动都诱导创建新记录或新分支。

同时，`merging-stacked-prs` 技能假设本仓库需要 native GitHub stack，但当前没有真实依赖链，也没有自动化 merge 需求。保留它会把“人工 merge”的实际策略误写成 stack 流程。

## Decision

**1. 审查范围由 `change-scope` 固定。** [scripts/change-scope.mjs](../../../../scripts/review/change-scope.mjs) 接收已验证的 `--base <ref>` 和可选 `--head <ref>`，输出 base/head/merge-base 与 committed、staged、unstaged、untracked 四组路径。未知 base、歧义 ref 或 merge-base 不唯一时非零退出；审查者不得猜 base。

**2. `code-review` 是唯一审查技能。** [.agents/skills/code-review/SKILL.md](../../../../.agents/skills/code-review/SKILL.md) 先冻结范围、读需求和 owning surface，再按 correctness、lifecycle、security、test、docs 的顺序审查。Finding 必须带相对 `path:line`、影响、证据和 required fix；blocker 与 suggestion 分开；实现者不得给自己的实现最终 verdict。

**3. PR 结构由 `pr-description` 技能声明。** [.agents/skills/pr-description/SKILL.md](../../../../.agents/skills/pr-description/SKILL.md) 内含 `## Motivation`、`## Changes`（interface / behavior / review focus）、`## Testing`（test design / test entries / not run）、`## Evidence` 的骨架。不再维护 `.github/pull_request_template.md`，PR 结构只有一个 home。

**4. 技能使用无 `dsh-` 前缀的本地名称。** 当前审查与交付技能为 `code-review`、`pre-push-checks`、`pr-description` 和 `find-simplifications`；[.agents/skills/README.md](../../../../.agents/skills/README.md) 与 [docs/README.md](../../../../docs/README.md) 必须路由到它们。`merging-stacked-prs` 不复制：合并保持人工执行，需要时由人使用 `gh pr merge` 或 GitHub UI；不自动 merge，不引入新的 stack 技能。

**5. 决策记录与分支都按工作流粒度创建。** 一个用户授权的工作流尽量使用一个记录和一个分支；不要把同一主题拆成 review、PR、skill 等多个细粒度记录或分支。未经用户明确要求，不自动创建决策记录；只有公共工具/格式/preset、架构选择、持久契约或用户要求的设计记录才值得新建。

**6. 当前 review/PR/skill 改动使用同一分支。** 本工作流的提交位于 `agent/project-skills`，后续相关改动也推送到该分支；不为每个子步骤新建分支，除非用户明确要求或一个独立工作流需要隔离。

## Alternatives considered

**保留三份 review/PR/skill 决策记录。** 否决：它们描述同一个工作流，互相 supersede 后仍留下三个入口；合并后 skill、PR 结构和范围报告只有一个当前事实源。

**保留 `merging-stacked-prs` 技能。** 否决：本仓库没有真实 A←B←C 依赖链，也没有自动 merge 需求；保留 native stack 步骤会把人工 merge 误写成默认流程。

**继续使用独立 `.github/pull_request_template.md`。** 否决：技能应同时声明触发条件、结构和验证方式；独立模板没有消费方，还会制造 docs kind/publish 的额外维护面。

**保留 `dsh-` 前缀。** 否决：用户明确要求去掉，且本项目已有无前缀技能；两套命名会增加 loader 选择歧义。

**为每个子步骤创建新分支和决策记录。** 否决：当前问题正是 review/PR/skill 被拆得过细；分支和记录应跟随一个可交付工作流，而不是跟随每次编辑。

## Consequences

- 审查入口是 `change-scope` + `code-review`；PR 入口是 `pr-description`；两者都不再依赖独立模板。
- 合并保持人工，不使用 `gh stack` 技能或自动 merge；需要 stack 时应先获得用户明确要求并重新评估。
- 本记录合并并取代此前 2026-11-13 的三份 review/PR/skill 记录；之后不为同一主题再拆新记录。
- 未来的简化调查仍需 producer/consumer、兼容性和能力损失证据；它可能创建自己的记录，但必须符合第 5 条粒度规则。
- 当前没有 CI 或自动 PR gate；这些技能是 agent/human 的流程入口，不是远端强制执行器。

## Deltas from deepseek-harness

| Skill | What changed or was dropped | Why |
|---|---|---|
| `code-review` | 去掉多包、ADR、defensive-patterns、Cordis ownership、client i18n、projection、snapshot 和 GUI review loop；改用本项目的 `change-scope`、workflow surface、AgentTeams verdict、lib sync 与 host smoke。 | 这些是 dsh monorepo 的架构门禁，本项目没有对应包结构。 |
| `pre-push-checks` | 去掉 pnpm/Vitest 专用命令、`gh stack sync` 后的 force 例外、CI `gh pr checks` 流程；保留最小证据选择、`change-scope`、`check:lib-sync` 和远端 HEAD 核对。 | 本项目使用 npm/node:test，用户规则禁止 force；当前关键是本地 host smoke 与 lib 同步。 |
| `pr-description` | 删除 AI Usage 的 5 阶段百分比、徽章、完整 disclosure 表；保留四段结构并把模板放进技能。 | 当前没有评分基础设施；技能应同时声明触发条件、结构和验证方式。 |
| `merging-stacked-prs` | 完全不复制；不保留 stack 技能。 | 本仓库没有真实 stack 需求，合并保持人工执行。 |
| `find-simplifications` | 删除 dsh 专属历史模式、LLM/persistence 保护项、subagent 分工和 archived-notes 流程；保留 producer/consumer 追踪、能力损失、兼容/失败语义和提案骨架。 | 原技能历史案例属于 dsh 代码库；本项目的候选主要是 legacy M2/M3/M12、过期 `.dsh-cowork/e2e` 材料和重复 gate。 |

## Testing

- [A1] `npm run change-scope -- --base <ref>` 输出 base/head/merge-base 与四组路径；未知 base 非零退出 — `tests`：`tests/change-scope.test.mjs`
- [A2] `code-review` 具备加载触发器、四段结构、finding 格式和独立 verdict 规则 — `agent-skills`：`npm run check`、`tests/workflow.test.mjs`
- [A3] `pr-description` 自身声明 PR 四段结构，独立 `.github/pull_request_template.md` 不存在 — `publication`：`tests/workflow.test.mjs`、`npm run check`
- [A4] 技能目录无 `dsh-` 前缀，`merging-stacked-prs` 不存在，docs/README 与技能索引可达 — `agent-skills`：`tests/workflow.test.mjs`、`npm run check`
- [A5] 审查、PR、技能相关改动使用同一 `agent/project-skills` 分支；AGENTS 和 notes README 写明记录/分支粒度规则 — `workflow`：`npm run check`、`npm run check:self-test`
