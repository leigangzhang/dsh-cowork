# Proposal: GitHub PR 门禁与 Review 流程

Status: proposed
Date: 2026-11-15
Class: process

## Problem

当前仓库没有 CI，`main` 未受保护，PR 没有 required checks 或 review verdict。本地检查与 PR 描述是唯一证据，无法阻止红检查、未审代码或过期证据进入 `main`。单人维护无法用第二个 GitHub 账号制造独立 approval；需要一套能在当前 DSH web/AgentTeams 环境执行、可回滚、且不引入 auto-merge 的流程。

## Proposal

**1. CI 门禁。** 新增 `.github/workflows/ci.yml`，在 `pull_request` 上用 PR head 运行 `npm ci`、`npm run check`、`npm test`、`npm run test:coverage`、`npm run typecheck`、`npm run build`。只暴露一个稳定 required check `CI / pr-gate`，任一步失败即红；成功后上传 `review-context.json`。

**2. Review。** 主审使用当前 DSH web 会话的 AgentTeams reviewer，模型为 `deepseek-v4-pro`，fresh context、只读，先 `change-scope` 再读需求、diff、调用方和 CI 证据，最终 verdict 必须在 CI 绿后对同一 HEAD 给出。高风险变更再加第二意见：使用当前 DSH web 的 AgentTeams member 或 `subagent` 调用非 DeepSeek 模型（Kimi/Qwen/GLM 等），同样 fresh、只读、advisory；不把 Codex 或 DSH Desktop 作为兜底。

**3. 证据冻结。** 新增 `.github/workflows/gate-artifact.yml`，从受信任的 base 分支运行脚本，PR head 只作为 git 数据。它校验 review 绑定当前 HEAD、`CI / pr-gate` 成功、`origin/main` 仍是记录的 base、工作区干净，并生成 `gate-artifact.json` 与 sticky comment；job 本身作为 `Policy / gate-artifact`。

**4. 强制层。** `main` 使用 ruleset 要求 `CI / pr-gate` 和 `Policy / gate-artifact`、conversation resolution、strict up-to-date，禁止 force push 和删除，不设 bypass。单人项目不配置 required approvals；review 是程序性约束，人工 merge 仍是最终动作。

**5. Heavy lane。** `test:host-smoke`、`test:browser`、`test:coverage:layered` 依赖本机 `dsh` 或 Chromium，先在本机 self-hosted runner 或手动运行；稳定后再增加独立 required check，不能把 skipped 当绿。

**6. Issue 策略 v1。** 不强制 Issue 引用；只校验 Conventional Commits 标题和 `pr-description` 要求的正文结构。不新增 `.github/pull_request_template.md`，PR 结构继续由 `pr-description` 技能单点拥有。

**7. 文档。** 设计机制与验收见 [pr-gate-flow.md](../../../../docs/design/github-flow/pr-gate-flow.md)。实现时同步更新 `AGENTS.md`、`docs/testing.md`、`pre-push-checks`、`pr-description`、`code-review` 和 `docs/design/README.md`。

## Alternatives considered

**第二个 GitHub 账号 + required approval。** 否决：单人维护需要额外身份、登录和权限管理；它只能证明“另一个账号点了 Approve”，不能提高 review 质量。当前改为只读 reviewer + `review-verdict` 的程序性独立。

**用 Codex 或 DSH Desktop 做第二意见。** 否决：用户明确不采用兜底路径；当前 DSH web 已能在 AgentTeams 或 subagent 中路由非 DeepSeek 模型，少一层 harness 和上下文搬运。

**照搬 deepseek-harness 的 weighted approval、ownership 评分和 delegation。** 否决：那套机制服务于大型多团队仓库；本仓库是单人项目，引入 reviewer 权限、blame ownership、授权撤销和 App token 只会增加维护面。

**从第一天把 heavy lane 设为 required。** 否决：`test:host-smoke` 和 `test:browser` 依赖本机 `dsh`/Chromium，GitHub-hosted runner 无此环境；直接 required 会让 PR 卡在无法分配或无法运行的任务上。先单独跑，稳定后再强制。

**在 GitHub Actions 里调用 AI review。** 否决：需要把模型 API key 放进远端 secret，并按 PR 触发付费调用；本地 DSH/AgentTeams 已能完成语义 review，CI 继续只做确定性检查。

**继续只用本地检查 + 人工 merge。** 否决：无法阻止红检查、未审代码或旧证据合并；也没有机器可核对的 HEAD/base/diff 身份。

**给 PR 增加独立模板并强制 Issue 引用。** 否决：既有 2026-11-13 决策记录已确定 `pr-description` 同时拥有结构和验证，新增模板会制造第二个 home；Issue 策略 v1 也不要求引用。

**引入 auto-merge、merge queue 或 stacked PR。** 否决：`AGENTS.md` 要求人工 merge、单工作流分支，当前没有 stack 依赖或自动合并需求。

## Acceptance criteria

- [A1] `CI / pr-gate` 在 PR head 上运行五条 core 命令，任一步非零或必需 job 被跳过即失败 — `workflow`
- [A2] `Policy / gate-artifact` 校验 review 绑定当前 HEAD、`pr-gate` 成功、base 未变、工作区干净；新 commit 使旧证据失效 — `workflow`
- [A3] 主审固定为 DSH web AgentTeams 的 `deepseek-v4-pro` reviewer，fresh/只读；第二意见仅高风险、使用非 DeepSeek 模型、advisory，不使用 Codex/Desktop 兜底 — `agent-skills`
- [A4] `main` ruleset 要求两个检查、conversation resolution、strict up-to-date，禁止 force/delete，不设 bypass；单人项目不配置 required approvals — `workflow`
- [A5] heavy lane 先独立运行，`test:host-smoke` 使用 `DSH_HOST_SMOKE_STRICT=1`，稳定后才成为 required check — `workflow`
- [A6] Issue v1 只校验 Conventional Commits 标题和 `pr-description` 正文结构，不强制 Issue 引用，不新增独立 PR 模板 — `plan-docs`
- [A7] 设计文档与决策记录可从 `docs/design/README.md` 和文档索引到达，`npm run check` 通过 — `plan-docs`

## Risks

- 单人项目没有 GitHub required approval；review 仍是程序性约束，作者可以绕过。缓解：`gate-artifact` 绑定 HEAD/base/diff，人工 merge 前核对，并在记录中明确不是硬审批。
- `npm test` 与 `npm run test:coverage` 可能重复执行；先测量，再决定是否合并为一次运行，不能删除 coverage 断言。
- heavy lane 在稳定前不是 required，host/browser 回归可能漏过；PR 的 `Not run` 必须显式记录，稳定后立即升级为 required。
- 非 DeepSeek 模型的路由和 model id 可能变化；每次使用前用 `list_subagent_models` 核实，无法路由时记录 `not run`。
- ruleset 配置错误可能阻塞所有合并；先在 report-only 阶段验证，再启用 required checks，回滚时禁用 ruleset。

## Delivery stages

1. 文档与决策记录 — 本变更。
2. `.node-version` + `CI / pr-gate` report-only — 验证五命令和 GitHub Actions 环境。
3. ruleset 要求 `CI / pr-gate` — 验证失败 PR 无法合并、force/delete 被拒绝。
4. 主审 + `Policy / gate-artifact` — 验证新 commit 使旧 review/旧证据失效。
5. heavy lane 稳定后 required — 验证 skip 不会变绿。
6. merge 设置与自动删分支 — 统一 merge commit 并清理旧分支。
