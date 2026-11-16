# GitHub PR 门禁与 Review 流程设计

Status: draft（design，2026-11-15；implementation not started）

本文件定义从 `agent/<topic>` 到 `main` 的目标交付流程。为什么这样选、放弃了什么，见[决策记录](../../../.agents/notes/proposed/process/2026-11-15-github-pr-gate-flow.md)。当前仓库尚未实现 CI、ruleset 或 `gate-artifact` workflow；本文描述目标状态和落地顺序。

## 目标与边界

目标：把本地检查、GitHub Actions、独立 review、证据冻结和人工 merge 串成一条可回退的流程，让“检查通过”和“review 通过”都绑定同一个 HEAD。

边界：

- 不引入第二个 GitHub 账号，不配置 required approvals；review 是程序性约束，不是 GitHub 强制审批。
- 不引入 auto-merge、merge queue 或 stacked PR；合并保持人工。
- 不改变单工作流分支、Conventional Commits 和现有 PR 描述技能的所有权。
- 不把 Codex 或 DSH Desktop 作为第二意见兜底；第二意见只使用当前 DSH web 会话可路由的非 DeepSeek 模型。
- Issue 策略 v1 不强制引用 Issue；只校验 PR 标题和正文结构。

## 流程

```mermaid
flowchart LR
  A["agent/topic 分支"] --> B["小步提交"]
  B --> C["本地 change-scope<br/>+ 受影响检查"]
  C --> D["push + 开 PR"]
  D --> E["CI / pr-gate<br/>check / test / coverage / typecheck / build"]
  E --> F{"同一 HEAD 通过?"}
  F -- 否 --> B
  F -- 是 --> G["主审<br/>DSH web AgentTeams reviewer<br/>deepseek-v4-pro<br/>fresh context / 只读"]
  G --> H{"verdict = pass?"}
  H -- 否 --> B
  H -- 是 --> I{"高风险变更?"}
  I -- 否 --> J["review-verdict<br/>head + base + diffSha"]
  I -- 是 --> K["第二意见<br/>非 DeepSeek 模型<br/>AgentTeams 或 subagent<br/>fresh context / 只读 / advisory"]
  K --> L{"发现 blocker?"}
  L -- 是 --> B
  L -- 否 --> J
  J --> M["Policy / gate-artifact<br/>review + pr-gate + base + clean"]
  M --> N{"ruleset<br/>pr-gate + gate-artifact<br/>对话已解决 + 分支最新"}
  N -- 否 --> B
  N -- 是 --> O["人工 merge commit"]
  O --> P["main + 自动删分支"]
```

### 节点说明

| 节点 | 机制 |
|---|---|
| 本地检查 | `change-scope` 固定范围；按 [tools/workflow.json](../../../tools/workflow.json) 选择受影响检查；CI 拥有完整五命令 |
| PR Gate | `.github/workflows/ci.yml` 的 `pr-gate` job；单稳定检查 `CI / pr-gate` |
| 主审 | DSH web AgentTeams reviewer；`deepseek-v4-pro`；fresh context；只读 |
| 第二意见 | 仅高风险；当前 DSH web 的 AgentTeams member 或 subagent；非 DeepSeek 模型；advisory |
| 证据冻结 | `Policy / gate-artifact`；校验 review、CI、base 和工作区身份 |
| 强制层 | repository ruleset 要求两个检查、对话解决、分支最新、禁止 force/delete |
| 合并 | 人工 merge commit；关闭 auto-merge；合并后自动删分支 |

## 1. 本地阶段

从 `main` 拉一个 `agent/<topic>` 分支，按 Conventional Commits 小步提交。推送前：

```sh
npm run change-scope -- --base <verified-base>
```

范围以该报告的 committed、staged、unstaged、untracked 四组路径为准，不猜 base。按 [tools/workflow.json](../../../tools/workflow.json) 选择最小证据；不要默认重复全量测试。

本地 review 与 CI 不是串行两轮：

1. reviewer 先用 `change-scope` 对 diff 做语义和正确性 review；
2. CI 在同一个 HEAD 上产出 test、coverage、typecheck、build 证据；
3. 最终 `verdict=pass` 必须在 CI 绿后、对同一个 HEAD 给出，并同时核对 diff 与 CI 结果。

`lib/` 是本地构建产物；`test:host-smoke` 前先 `npm run build`，并设置 `DSH_HOST_SMOKE_STRICT=1`，缺 `dsh` 时失败而不是 skip。

## 2. PR Gate

目标文件：`.github/workflows/ci.yml`，workflow 名 `CI`，job 名 `pr-gate`。

- 触发：`pull_request`，目标 `main`；
- 权限：`contents: read`，不接收 secret；
- 并发：同 PR 新 push 取消旧 run；
- checkout：PR head，`fetch-depth: 0`；
- 运行时：新增 `.node-version` 固定 Node 版本；
- 步骤：`npm ci`，然后依次执行：

```sh
npm run check
npm test
npm run test:coverage
npm run typecheck
npm run build
```

任一步非零即失败；job 本身是唯一 required check `CI / pr-gate`，不把矩阵腿逐个写进 ruleset。成功后上传 `review-context.json`，记录 `baseSha`、`headSha`、`diff.sha256` 和 `scope`，供 review 与 `gate-artifact` 使用。

核心 CI 跑在当前仓库的 GitHub Actions 标准 runner 上；仓库是 public 且 Actions 已开启，不需要额外购买 larger runner。`npm test` 与 `npm run test:coverage` 目前会重复执行测试；P1 先按流程全跑，测量后再决定是否合并为一次运行，不能删除 coverage 门。

## 3. Review

### 主审

- 载体：当前 DSH web 会话的 AgentTeams reviewer；fresh context；只读 tool policy；
- 模型：`deepseek-v4-pro`；
- 顺序：先 `change-scope`，再读需求、diff、调用方、测试和 CI 证据；
- 实现者不得担任主审，主审不继承实现者的对话和结论；
- finding 格式：`path:line + 严重度 + 影响 + requiredFix`；
- 输出 `review-verdict`，至少包含 `baseSha`、`headSha`、`diffSha256`、`verdict`、`findings`；
- 新 commit 后旧 verdict 失效，只对 delta 重审，最多 2–3 轮。

### 第二意见

只在高风险变更上启用，例如认证/授权、持久化或迁移、公共 API/tool schema、review/merge 流程、发布/打包、安全边界。

- 载体：当前 DSH web 会话的 AgentTeams member 或 `subagent`；fresh context；只读 tool policy；
- 模型：非 DeepSeek 模型，例如 Kimi 2.7、Qwen 3.8、GLM 5.3；实际 model id 先用 `list_subagent_models` 核实；
- 输出与主审相同的 head/base/diff 绑定字段，并标记 `advisory: true`；
- 它不进入 required checks，只作为高风险变更的附加证据；
- 无法路由非 DeepSeek 模型时记录 `not run`，不能默认通过；
- 不使用 Codex 或 DSH Desktop 兜底。

### GitHub 侧

单人账号不配置 required approvals；GitHub 原生 approval 不是硬门禁。review 的独立性由 AgentTeams 的 fresh context、独立 reviewer 和 `review-verdict` 保证，属于程序性约束。最终人工 merge 仍由人负责。

## 4. Gate artifact

目标文件：`.github/workflows/gate-artifact.yml`，workflow 名 `Policy`，job 名 `gate-artifact`。

- 触发：`pull_request_review` submitted/dismissed；必要时加 `pull_request_target` 的 synchronize 用于显示等待 review 的状态；
- 权限：`contents: read`、`pull-requests: write`；
- 运行受信任的 base 分支脚本；PR head 只作为 git 数据 fetch，不执行 PR 代码；
- 校验：
  1. review verdict 或 native approval 的 `commit_id` 等于当前 PR head；
  2. `CI / pr-gate` 在同一 head 上成功；
  3. `origin/main` 仍是 `review-context` 记录的 base；
  4. 临时 worktree 的 `git status --porcelain` 为空；
  5. PR 标题符合 Conventional Commits，正文包含 `pr-description` 要求的段落；
- 生成 `gate-artifact.json`，更新 sticky PR comment，job 本身作为 `Policy / gate-artifact` check。

新 commit、base 前进、review 失效或工作区不干净都会让该 check 失效或失败，流程回到提交/CI/review。

## 5. Ruleset 与合并

`main` 使用 repository ruleset：

| 设置 | 值 |
|---|---|
| Require pull request | on |
| Required checks | `CI / pr-gate`、`Policy / gate-artifact` |
| Required approvals | 0（单人项目，review 为程序性约束） |
| Require conversation resolution | on |
| Require branches up to date | on |
| Block force push / deletion | on |
| Bypass actors | 空 |

仓库设置：

- merge commit only；
- `allow_auto_merge=false`；
- `delete_branch_on_merge=true`；
- `allow_update_branch=true`。

不启用 required linear history，因为历史使用 merge commit。

## 6. Heavy lane

`test:host-smoke`、`test:browser`、`test:coverage:layered` 依赖本机 `dsh` 或 Chromium，不能直接放进 GitHub-hosted runner 的核心五命令。

- 先作为独立 workflow 在本机 self-hosted runner 或手动运行；
- `lib/` 必须先 build；`test:host-smoke` 使用 `DSH_HOST_SMOKE_STRICT=1`；
- 稳定前不作为 required check，PR 的 `Not run` 必须明确写出；
- 稳定后增加独立 required check，并按 affected paths 选择；不能把 skipped 当绿。

## 7. PR 元数据 v1

- PR 标题使用 Conventional Commits；
- 正文按 [pr-description](../../../.agents/skills/pr-description/SKILL.md) 的 `Motivation`、`Changes`、`Testing`、`Evidence` 结构；
- 不强制 Issue 引用；
- 不新增 `.github/pull_request_template.md`；PR 结构仍由 `pr-description` 技能单点拥有。`gate-artifact` 负责最终校验；可选的 `Policy / pr-metadata` 只做早期反馈，不设为 required。

## 8. 失败与回环

| 事件 | 结果 | 回到 |
|---|---|---|
| 任一 core 命令失败 | `CI / pr-gate` 红 | 提交 |
| 主审 verdict 非 pass | 不生成成功 `gate-artifact` | 提交 |
| review 后 push 新 commit | 旧 verdict/旧 check 失效 | PR Gate |
| main 前进 | strict up-to-date 阻止合并 | 更新分支后 PR Gate |
| 有未解决对话 | ruleset 阻止合并 | review |
| force push / 直接 push main | ruleset 拒绝 | — |
| `gate-artifact` 发现 base/head 变化 | check 失败 | PR Gate |

## 9. 落地顺序

1. 文档与决策记录（本次变更）。
2. `.node-version` + `CI / pr-gate` report-only；验证五命令在干净 checkout 下可运行。
3. ruleset 要求 `CI / pr-gate`，开启 conversation resolution 和 strict up-to-date，禁止 force/delete。
4. 接入主审与 `Policy / gate-artifact`，验证新 commit 会使旧 review/旧证据失效。
5. 稳定后接 heavy lane；最后统一 merge 设置与自动删分支。

## 10. 验收

- 故意失败一个测试：`CI / pr-gate` 红，merge 不可用。
- 没有 review verdict：`Policy / gate-artifact` 不成功，merge 被阻止。
- review 后 push 新 commit：旧 verdict 和旧 check 失效，必须重新 review。
- main 前进：strict up-to-date 阻止合并；更新分支后所有检查重跑。
- 有未解决 conversation：merge 被阻止。
- 直接 push main、force push、删除 main：全部拒绝。
- `gate-artifact` 的 `headSha` 等于 PR head，`diff.sha256` 与 sticky comment 一致。
- 合并后分支自动删除，main 上是 merge commit。
