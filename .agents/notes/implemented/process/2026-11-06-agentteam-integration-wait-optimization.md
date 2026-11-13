# Decision: 集成后台等待优化（AgentTeams 集成与 E2E）

Status: implemented
Date: 2026-11-06
Class: process

## Problem

M3 的主会话 + 5 个 AgentTeams 子会话里，verifier 有 **1,080.3s** 在等待后台任务：其中 **694.5s** 在等集成 marker（首次 591.1s、t8 后 103.4s），**385.8s** 在等 E2E 跑完；两次失败 E2E 占 301.5s，最终成功一次占 84.3s。根因不是测试慢，而是：

- verifier 在集成 commit 可构建前就被调度，只能每 10s 轮询 marker；
- 一次集成变更在多个 worktree、feature 分支和 verifier 之间重复跑全量四命令；
- review 竞态/旧 tool schema 这类问题用真机 E2E 才发现，失败后原样重跑；
- 每次集成都 build + inject，旧 fiber 还会触发 clean uninject→inject；
- 文档-only 变更也可能触发完整 E2E。

团队的“等待/后台”因此达到 1,453.6s，成为最大工具耗时类别；真正写代码只有 323.1s（4.6%）。这不是某次执行失误，而是缺少一条可复用的集成/验证流程规则。

## Decision

项目现在把集成与 E2E 的等待流程写成可执行的规则，而不是依赖队长临场判断：

- 新增 [AgentTeams 集成与 E2E 规则](../../../../docs/agent-teams.md)（项目级，Class 文档分类为 internal），包含 R1–R7、DAG 模板、反模式与指标目标。
- [AGENTS.md](../../../../AGENTS.md) 的 `## AgentTeams` 段要求在创建计划前读该规则，并明确：`verification` 依赖 `integration-ready` 工作/构建门禁任务（merge → build → inject/health → marker → 通知），禁止 10s marker 轮询；一份集成变更只跑一次全量四命令；真机 E2E 前先跑快速契约测试；docs-only 不跑 E2E。
- 规则把 `integration-ready` 与质量模式里的 `integration` 质量任务区分开：前者是验证前的构建就绪门禁，后者仍是 review 之后的最终集成质量任务。
- 规则要求 `verification` / `review` 的 `dependencies` 显式包含 `integration-ready`；若必须轮询 marker，单次 ≤60s 并记录原因。
- 规则要求收口记录 marker 等待、E2E 尝试与耗时、四命令次数、inject 次数和失败原因；目标为 verifier 等待 ≤300s（基线 1,080.3s）、团队“等待/后台”≤800s（基线 1,453.6s）。

这不是 AgentTeams profile 的修改；profile 仍是部署配置。项目规则通过 AGENTS.md 被后续队长加载，作用于本仓库新会话/新团队。

## Alternatives considered

**保留 10s marker 轮询，只把间隔调短或加超时。** 否决：轮询解决不了“verifier 在集成 commit 可构建前就被调度”的依赖缺失；更短的间隔只会增加请求和日志，591s 的等待仍在。正确修法是把就绪变成任务依赖/事件。

**继续用真机 E2E 当第一道测试，失败后原样重跑。** 否决：M3 的两次失败 E2E（118.1s + 183.4s）没有产出回归测试，只是重复同一形状；AGENTS.md 已明确“两次失败同一证据要重查门禁”，真机失败应先固化成确定性测试。

**在每个 worktree/feature 分支/verifier 都跑全量四命令。** 否决：覆盖率没有增加，只是重复。保留 verifier 的独立一次四命令 + 一次真机 E2E，主会话只在集成 commit 跑一次门禁，才能既独立又不重复。

**只用 fake-host 测试，不再跑真实宿主 E2E。** 否决：M3 的核心证据就是真实宿主上的 review/handoff/merge 与插件装载；去掉真机等于去掉独立证据。规则只把失败重跑前移，不取消最终真机一次通过。

**不改规则，只靠队长在任务描述里临场提醒。** 否决：M3 已经证明这种软约束会漂移；规则必须落到 AGENTS.md 的必读入口和可检查的任务依赖上，下一任队长不必重新发明。

## Consequences

收益：新团队有一条可执行的集成/验证顺序；verifier 不再被提前调度；失败 E2E 被固化成快速测试；重复全量、重复 inject 和 docs-only E2E 被明确禁止；收口有指标可复盘。代价：计划多一个 `integration-ready` 任务和 `fast-contract` 任务，首次要为已知竞态补测试；队长要记录指标；若规则没有降低等待，需要记录原因而不是假装改善。

没有改变：AgentTeams 协议/质量门禁、`verification`/`review` 的独立性、最终真机 E2E 的证据要求；没有改部署 profile，也没有改产品代码。规则只在本项目生效；按项目约定，稳定运行两个阶段后再考虑提升到用户级 AGENTS 或 skill。若事件机制不可用、或下一个阶段验证等待没有下降，回到本记录重估，而不是继续加轮询。

## Testing

- [W1] AGENTS.md 的 `## AgentTeams` 段存在，链接规则文档，并写明 `verification` 依赖 `integration-ready`、禁止 10s 轮询 — `context-rules`
- [W2] 规则文档在 `docs/publish.json` 中被分类为 internal，且包含 R1–R7、DAG 模板与指标目标 — `publication`
- [W3] 规则明确区分 `integration-ready` 构建门禁与质量模式的 `integration` 任务 — `decisions`
- [W4] 下一个 AgentTeams 收口的 verifier 等待、marker 等待、失败 E2E 次数有记录并可对照基线 — `decisions`（下一次运行前 unpinned；当前没有自动化检查能证明团队实际遵守流程，收口报告是证据）
