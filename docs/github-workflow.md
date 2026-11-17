# GitHub 协作流程

本文说明一次代码改动如何从本地分支进入 `main`，以及测试、审查、证据检查和人工合并在什么时候发生、由谁执行、覆盖什么范围。PR（Pull Request，拉取请求）是这里的合并入口。内容以 2026-11-17 的 `origin/main` 和仓库当前 GitHub 设置为准。

本文只讲代码如何通过 GitHub 进入 `main`。插件内部的 topic、work item 与 review request 如何协作，见 [routing.md](routing.md)；测试命令和证据选择见 [testing.md](testing.md)；审查方法见 [code-review](../.agents/skills/code-review/SKILL.md)。

## 1. 问题描述

一次改动从本地提交进入 `main`，需要同时回答四个问题：

1. 哪些测试和检查必须通过，而且必须针对同一个提交？
2. 谁审查代码和测试，怎样证明结论没有过期？
3. 哪个动作真正允许合并，失败后应该回到哪一步？
4. 哪些测试当前没有自动执行，PR 中怎样如实说明？

测试和审查不是同一件事。测试回答“某条命令是否在当前提交上实际运行并通过”；审查回答“代码、测试设计和证据是否足以支持合并”。两者都要在当前提交上成立，不能互相替代。

如果只看某一个 workflow 或某一份说明，容易把“本地跑过”“GitHub 上的检查通过”“有人评论过”和“允许合并”混成一件事。本文把当前实际流程按执行顺序连接起来，并分别说明测试和审查的自动部分与人工部分。

## 2. 适用范围与当前状态

| 项目 | 当前值 |
|---|---|
| 仓库 | `leigangzhang/dsh-cowork` |
| 默认分支 | `main` |
| 分支约定 | 一个工作流使用一个 `agent/<topic>` 分支；GitHub 不强制分支名 |
| 合并方式 | 人工合并提交（merge commit）；不使用 merge queue |
| 合并前必需检查 | 当前 ruleset 仍要求 `pr-gate`、`gate-artifact`；新的 `gate-artifact-v2` 先以 report mode 运行 |
| GitHub 自动测试 | `pr-gate` 的 docs lane 运行 `check`；非 docs 改动再运行 `test:coverage`。`npm test` 不再在 `pr-gate` 中重复执行 |
| 合并结果测试 | `Pre-Merge` 在 `pull_request_target` 中把当前 `main` 合到 PR HEAD，运行路径相关检查，并发布 `pre-merge` 检查 |
| Base 前进 | 不更新 PR 分支；`Policy Base` 使旧 `gate-artifact-v2` 变为 stale，维护者给 PR 加 `recheck` 标签后重新运行 pre-merge |
| 本机扩展测试 | `heavy-gate` 手动运行 `typecheck`、`build`、host smoke、分层覆盖率、keyless E2E 和 host-bash |
| E2E 证据 | `npm run test:e2e -- --record` 在干净工作区录制；`docs/**` 和 `README.md` 的后续改动不会使证据失效；`test:e2e:live` 和 `test:e2e:bash` 只做观测 |
| 代码审查 | 独立 review 给出 `review-verdict:v2`，再由 `gate-artifact-v2` 校验 |
| 自动发布 | 无；详见第 7 节 |

## 3. 总流程概览

图 1 从作者建立分支开始，到维护者人工合并为止。失败时通常回到提交，而不是直接改 `main`。

```mermaid
flowchart TD
  A["确认需求、范围和 main 基线"] --> B["建立 agent/topic 分支"]
  B --> C["小步提交，使用 Conventional Commits"]
  C --> D["本地测试、检查和证据"]
  D --> E{"本地测试和检查通过？"}
  E -- 否 --> C
  E -- 是 --> F["push 分支并创建 PR"]
  F --> G["CI / pr-gate<br/>docs lane 或 source coverage lane"]
  F --> P["Pre-Merge<br/>merge(current main, PR HEAD)"]
  G --> H{"pr-gate 通过？"}
  P --> Q{"pre-merge 通过？"}
  H -- 否 --> C
  Q -- 否 --> C
  H -- 是 --> I["独立审查者<br/>审查代码和测试，必要时复跑"]
  Q -- 是 --> I
  I --> J{"审查结论是 pass？"}
  J -- 否 --> C
  J -- 是 --> K["提交 review-verdict:v2 标记"]
  K --> L["Policy V2 / gate-artifact-v2<br/>校验 review、pr-gate、pre-merge、metadata"]
  L --> M{"gate 通过？"}
  M -- 否 --> C
  M -- 是 --> N{"main 规则集要求满足？"}
  N -- 否 --> C
  N -- 是 --> O["维护者核对后人工 merge commit"]
  O --> R["main 增加合并提交，来源分支自动删除"]

  D -. 需要本机环境时手动运行测试 .-> X["Heavy / heavy-gate<br/>当前不参与合并判定"]
```

图 1 把 review 和测试拆成两个身份：PR HEAD 上的 review 绑定作者改动；pre-merge 绑定当前 main 的临时合并结果。`main` 前进不会改变 PR HEAD，也不会自动让 review 失效；旧 `gate-artifact-v2` 会被标成 stale，重新运行 pre-merge 后再由派生 gate 重算。

### 3.1 三个自动检查

| 检查 | 触发方式 | 运行位置 | 是否阻止合并 | 测试和审查范围 |
|---|---|---|---|---|
| `CI / pr-gate` | PR 创建或更新，目标为 `main` | GitHub 提供的 Ubuntu 运行器 | 是 | `docs-check` 始终运行 `npm run check`；非 docs 改动再运行 `npm run test:coverage`。不运行 `npm test`、`typecheck`、`build`、host smoke、browser 或分层覆盖率 |
| `Pre-Merge / pre-merge` | PR 创建、更新、ready 或 `recheck` 标签 | GitHub 提供的 Ubuntu 运行器；`pull_request_target` | 否，供派生 gate 使用 | 把当前 `main` merge 到 PR HEAD，在临时合并结果上运行 `check` 和按路径选择的 coverage |
| `Policy V2 / gate-artifact-v2` | PR 更新、review 事件、CI/Pre-Merge 完成 | GitHub 提供的 Ubuntu 运行器；从受信任的 `main` 执行脚本 | report mode 暂不阻止；block mode 阻止 | 校验 `review-verdict:v2`、`pr-gate`、`pre-merge`、PR metadata 和 reviewed paths |
| `Policy` / `gate-artifact`（旧） | 提交或撤销 PR review | GitHub 提供的 Ubuntu 运行器 | 当前 ruleset 仍要求 | report mode 保留；`MERGE_POLICY_MODE=block` 后停止发布，由新 workflow 发布同名的 required `gate-artifact` |
| `Heavy / heavy-gate` | 有写权限的人手动启动 | 标记为 `self-hosted, heavy` 的本机运行器 | 否 | 运行 `typecheck`、`build`、host smoke、分层覆盖率、keyless E2E 和 host-bash；不审查代码 |

`gate-artifact-v2` 先在 report mode 运行，不改变当前 required checks。切换到 block mode 前，必须先验证 `pre-merge` 能稳定发布当前 base，且 base-recheck 能把旧绿色 gate 标成 stale。

`pr-gate` 变绿只表示它选中的 hosted 命令在当前提交上运行成功，不表示所有行为都已被测试覆盖。测试是否覆盖了目标行为、断言是否验证外部结果，仍要由审查者检查。

`npm run check` 会校验 `tests/e2e/manifest.json`、公开面覆盖和当前版本的 `tests/e2e/evidence/<version>.json`，但它不会运行 E2E 场景。E2E 由 heavy 本机测试运行 `npm run test:e2e` 和观测性的 `npm run test:e2e:bash`；版本或 E2E 范围变化时，作者还要在干净工作区运行 `npm run test:e2e -- --record` 更新证据。`test:e2e:live` 需要 `DEEPSEEK_API_KEY`，只作为观测结果。

### 3.2 一次改动的时序

图 2 展示测试、pre-merge、审查和派生 gate 分别在哪些步骤产生结果。

```mermaid
sequenceDiagram
  autonumber
  participant A as 作者
  participant G as GitHub 分支与 PR
  participant C as CI / pr-gate
  participant PM as Pre-Merge
  participant R as 独立审查者
  participant P as Policy V2 / gate-artifact-v2
  participant H as Heavy / heavy-gate
  participant E as E2E 证据录制
  participant M as 维护者

  A->>G: push agent/topic，创建 PR
  A->>G: 在 PR 写入实际测试命令、结果和 Not run
  G->>C: pull_request 触发
  C->>C: docs check 或 coverage lane
  C-->>G: pr-gate 结果
  G->>PM: pull_request_target 触发
  PM->>PM: merge(current main, PR HEAD)，测试临时结果
  PM-->>G: pre-merge check
  C-->>A: 失败时返回日志
  opt 改动需要本机环境
    A->>H: 手动 workflow_dispatch
    H->>H: typecheck、build、host smoke、分层覆盖率、keyless E2E、host-bash
    H-->>A: 本机测试结果
  end
  opt 版本或 E2E 范围变化
    A->>E: npm run test:e2e -- --record
    E-->>A: 场景结果和当前版本证据
  end
  A->>R: 请求审查，并提供测试证据
  R->>R: 读需求、差异和测试设计；核对断言和 E2E 证据；必要时复跑
  R->>G: 对 PR 当前提交给出 review-verdict:v2
  G->>P: PR/review/CI/pre-merge 事件触发
  P->>P: 校验 review、pr-gate、pre-merge、metadata 和 reviewed paths
  P-->>G: gate-artifact-v2 结果
  M->>G: 核对测试证据、审查结果和规则后人工 merge commit
```

### 3.3 测试和审查的分工

测试和审查回答不同问题：

- 测试：某条命令是否在当前提交上实际运行，结果是什么。
- 审查：代码、测试设计和证据是否足以支持合并。

图 3 展示作者、GitHub 自动检查、独立审查、本机 heavy 检查和证据校验之间的关系。

```mermaid
flowchart LR
  subgraph AUTH[作者]
    A["按改动范围选择测试"]
    B["记录实际命令、结果和 Not run"]
  end
  subgraph HOST[GitHub 托管检查]
    C["pr-gate<br/>docs check 或 coverage"]
    PM["pre-merge<br/>current main + PR HEAD"]
  end
  subgraph REVIEW[独立审查]
    D["读需求、差异和测试设计"]
    E["核对断言和证据，必要时复跑"]
    F["给出审查意见或 pass"]
  end
  subgraph LOCAL[本机扩展检查]
    G["heavy<br/>typecheck、build、host smoke、分层覆盖率、keyless E2E、host-bash"]
    L["E2E 证据<br/>npm run test:e2e -- --record"]
  end
  subgraph GATE[派生检查]
    H["gate-artifact-v2<br/>review + pr-gate + pre-merge + metadata"]
  end
  A --> B --> C
  A --> PM
  B --> D
  C --> D
  PM --> D
  D --> E --> F
  G -.-> D
  L -.-> D
  C --> H
  PM --> H
  F --> H
  H --> I["维护者核对后人工合并"]
```

| 环节 | 测试行为 | 审查行为 | 记录位置 | 当前是否自动强制 |
|---|---|---|---|---|
| 本地 | 作者按改动范围运行测试，失败先修复 | 作者自查，不是独立审查 | PR 的 `Testing`、`Evidence`、`Not run` | 否 |
| `pr-gate` | docs 改动运行 `check`；非 docs 改动再运行 `test:coverage` | 不审查代码和测试质量 | GitHub check 结果和运行日志 | 是 |
| `pre-merge` | 把当前 `main` merge 到 PR HEAD，运行路径选择的测试 | 不审查代码 | `pre-merge` 检查的 JSON summary | report mode 否；block mode 供 gate 使用 |
| 独立审查 | 审查者读测试设计，核对断言和证据，并按改动范围复跑针对性检查 | 给出审查意见或 pass 结论；实现者不能做最终审查 | PR review 评论和 `review-verdict:v2` | review 标记和对话解决是；测试是否实际复跑不是 |
| `heavy-gate` | 手动运行 `typecheck`、`build`、host smoke、分层覆盖率、keyless E2E 和 host-bash | 不审查代码 | workflow 日志；PR 的 `Not run` | 否 |
| 本机 E2E | heavy 运行 keyless E2E；版本或 E2E 范围变化时，作者另外用 `--record` 录制证据；host-bash 只作观测 | 审查者核对场景清单和证据 | `tests/e2e/evidence/<version>.json`；PR 的 `Testing`、`Not run` | 否；`npm run check` 校验清单和证据 |
| `gate-artifact-v2` | 不运行测试 | 校验 review v2、`pr-gate`、当前 base 的 `pre-merge`、PR metadata 和 reviewed paths | GitHub check run | report mode 否；block mode 是 |

测试范围由改动路径决定。文档改动运行 `npm run check`；源码、测试、客户端、打包和覆盖率策略改动要按 [tools/workflow.json](../tools/workflow.json) 与 [testing.md](testing.md) 选择对应测试。版本或 E2E 范围变化还要运行 `npm run test:e2e`，并在干净工作区用 `--record` 更新当前版本的证据。heavy 会运行 keyless E2E 和 host-bash，但不负责写版本证据；正式证据仍要单独录制。E2E 证据绑定录制时的提交；`docs/**` 和 `README.md` 的后续改动不再使证据失效，其他文件变化仍会要求重新录制。不要把“本地测试通过”写成 `pr-gate` 通过，也不要把 `pr-gate` 通过写成“测试范围内所有行为都已覆盖”。

审查者不需要不加选择地重跑所有 CI 命令，而要按改动范围选择针对性验证。重点是确认测试是否覆盖了 PR 声称的行为、断言是否验证外部结果、`Not run` 是否写明，以及测试结果是否属于当前提交。`review-verdict` 只记录提交、结论、审查者和模型，不记录测试命令；测试行为仍要看 PR 描述、review 内容和运行日志。

## 4. 分阶段流程

### 4.1 准备分支

从最新的 `main` 拉出一个 `agent/<topic>` 分支。一个已授权的工作流使用一个分支，不按提交、审查轮次或子任务重复开分支。分支名是团队约定，GitHub 当前不校验它。

开始写代码前，先读：

- 当前产品范围和验收：[PLAN-V0.2.md](PLAN-V0.2.md)；
- 改动涉及的检查：[tools/workflow.json](../tools/workflow.json)；
- 常驻工程规则：[AGENTS.md](../AGENTS.md)。

Issue 引用不是必需项。PR 的动机应当写清楚，需要上下文时再用 `Refs #N` 或 `Fixes #N`。

### 4.2 提交

提交信息使用 Conventional Commits，例如 `feat(scope): summary` 或 `docs(process): explain the flow`。PR 标题必须使用同一套类型前缀，当前允许的类型是 `feat`、`fix`、`docs`、`test`、`refactor`、`chore`、`perf`、`build`、`ci`，类型后可以带一个括号范围。

行为变更应同时包含对应测试。测试可以和实现放在同一个分支的多个提交里，但不能把测试留到审查通过后再补。不要提交本地构建产物、`.env`、运行数据或密钥。`lib/` 是本地构建输出，已被忽略。

### 4.3 本地测试并生成证据

本阶段由作者执行。目标是让测试覆盖当前改动，并把实际运行结果带到 PR。

先从实际改动范围选择测试：

```sh
npm run change-scope -- --base origin/main
```

这个命令列出 committed、staged、unstaged、untracked 四组路径。按 [tools/workflow.json](../tools/workflow.json) 选择最小但完整的测试范围，不要把“跑过一次全量测试”当成所有改动的默认证据。

测试范围由改动路径决定：

> - **文档改动至少运行 `npm run check`；**
> - **源码和测试改动按 [testing.md](testing.md) 选择单元测试、覆盖率和相关检查；**
> - **客户端、打包、构建或 host 相关改动还要在具备环境时运行 browser、host smoke 或分层覆盖率；**
> - **版本或 E2E 范围变化要按 [testing.md](testing.md) 运行 `npm run test:e2e`，并在干净工作区更新当前版本的证据；**
> - **需要本机 DSH 环境、Chromium 或 bash sandbox 的测试，当前通过 heavy 本机测试手动运行；其中 host-bash 和 `test:e2e:live` 只作观测，不能替代 keyless E2E 证据。**

**测试失败时先修复或补测试，不要通过放宽断言、跳过测试或删除覆盖来变绿。无法运行时，要在 PR 里写明原因，不能写成通过。**

记录当前提交对应的证据：

```sh
npm run gate-artifact -- --base origin/main
```

输出包含目标分支当前提交、PR 当前提交、差异的 SHA-256、工作区状态和四组路径。任何一次编辑、暂存或新文件都会改变这些内容；改动后必须重新生成。具体命令选择见 [testing.md](testing.md)。

本地测试通过只证明本机运行过。它不能替代 GitHub 上的 `pr-gate`，不能替代 heavy 本机测试，也不能替代 4.6 的独立审查。

### 4.4 创建 PR

向 `main` 创建 PR。标题使用 Conventional Commits；正文按 [pr-description](../.agents/skills/pr-description/SKILL.md) 的结构写，至少包含四个一级标题：

- `## Motivation`
- `## Changes`
- `## Testing`
- `## Evidence`

当前没有单独的 `.github/pull_request_template.md`，PR 结构由 [pr-description](../.agents/skills/pr-description/SKILL.md) 统一说明，自动校验脚本是 [pr-metadata.mjs](../scripts/ci/pr-metadata.mjs)。脚本当前只检查标题格式和四个一级标题是否存在，正文内容是否真实仍由审查者判断。

`## Testing` 要写测试设计、实际运行过的命令和结果；未运行的测试写进 `Not run` 并说明原因。`## Evidence` 要放当前提交对应的证据，不能把旧提交的结果复制过来。审查者会对照这些内容检查测试是否覆盖了 PR 声称的行为。

### 4.5 `pr-gate`：GitHub 上的基础检查

PR 创建或更新后，`.github/workflows/ci.yml` 触发 `CI` workflow。`pr-gate` 是一个稳定的聚合检查，内部拆成：

1. `classify`：运行 `scripts/ci/classify-change.mjs`，判断是否只有 `docs/**` 和 `README.md`；
2. `docs-check`：始终执行 `npm run check`；
3. `unit`：非 docs 改动才执行 `npm run test:coverage`；
4. `pr-gate`：聚合上述结果，生成 `review-context.json` 并上传。

`npm test` 不再在 `pr-gate` 中重复执行；`test:coverage` 已经逐文件运行全部测试。`typecheck`、`build`、host smoke、browser 和分层覆盖率仍留在 heavy lane。

`pr-gate` 的 docs lane 只影响测试选择，不改变 review 要求。文档改动仍可能需要独立审查，尤其是它描述当前行为、接口或流程时。

任一步失败，`pr-gate` 就是失败。修改后重新 push，新的提交会重新运行检查，旧提交上的测试结果不再对应当前改动。

### 4.5.1 `pre-merge`：当前 main 的临时合并结果

`.github/workflows/pre-merge.yml` 使用 `pull_request_target`，workflow 定义来自受信任的 `main`。它检出 PR HEAD，把当前 `origin/main` merge 到工作区，然后在临时合并结果上运行：

- `npm run check`；
- 非 docs 改动再运行 `npm run test:coverage`。

它不会把合并结果 push 回 PR 分支。测试结果由受信任的 publisher job 发布为 `pre-merge` check，summary 记录 `head`、`base`、`currentBase`、`docsOnly` 和 `result`。

`main` 前进后，旧 `pre-merge` 的 base 已经不是当前 main。`Policy Base` 会把当前 mode 对应的绿色 gate（report 为 `gate-artifact-v2`，block 为 `gate-artifact`）标成 `action_required`。维护者给 PR 加 `recheck` 标签后重新运行 `pre-merge`；通常不需要更新 PR 分支或重审。唯一例外是 gate 报 reviewed-path overlap：此时必须把当前 main 合入 PR 分支，产生新 HEAD，再对新 merge-base 做 delta review，`recheck` 本身不能解除该状态。

### 4.6 独立审查

审查在 `pr-gate` 针对当前提交通过后进行。实现者不能担任自己改动的最终审查者。项目内使用 AgentTeams 时，审查者应使用新上下文和只读方式工作；详细规则见 [agent-teams.md](agent-teams.md) 和 [code-review](../.agents/skills/code-review/SKILL.md)。

审查的范围包括**代码是否正确、失败时如何处理、状态如何变化、安全、兼容性、测试设计、断言质量和文档是否一致**。审查者不直接修改代码；发现问题时提出审查意见，由作者修复。

审查者至少要做这些事：

> - **用 `change-scope` 固定审查范围，确认 committed、staged、unstaged、untracked 四组路径；**
> - **先读需求和验收，再读代码差异、调用方和测试；**
> - **检查测试是否覆盖了 PR 声称的行为，断言是否验证外部结果，以及测试是否会在修复前失败；**
> - **核对 PR 的 `Testing`、实际测试命令、结果和 `Not run` 是否一致；**
> - **E2E 范围或版本变化时，核对 `tests/e2e/evidence/<version>.json` 与当前版本、提交和测试清单；`test:e2e:live` 和 `test:e2e:bash` 结果不能当作发布证据；**
> - **对必要的行为变更在隔离副本中运行针对性测试；不能运行时说明这是静态审查，不能把别人的运行结果写成自己运行；**
> - **检查失败场景的测试、资源清理，以及涉及打包或加载时是否走真实启动路径；**
> - **给出 `路径:行号`、影响和修复要求；**
> - **在同一提交上给出结论。**

**GitHub 的 review 不要求审查者把所有测试不加选择地重跑一遍。审查者按 [code-review](../.agents/skills/code-review/SKILL.md) 选择最小但完整的验证：文档改动运行 `npm run check`；行为变更运行覆盖率、构建和 host smoke；交付、浏览器或 E2E 变更再核对分层覆盖率和 heavy 的 E2E 结果，并检查当前版本证据。**AgentTeams 的独立验证任务会另外运行仓库检查，见 [agent-teams.md](agent-teams.md)。

审查结论通过 GitHub review 评论提交。当前使用评论形式的标记，不使用 GitHub 的批准（`Approve`）：

```text
<!-- review-verdict:v2 head=<40 位提交 SHA> base=<40 位 merge-base SHA> diffSha=<64 位 diff SHA-256> verdict=pass reviewer=agentteam model=<模型名> -->
```

`reviewer` 只能是 `agentteam` 或 `human`，`model` 不能为空。v2 额外记录 review 时的 merge-base 和二进制 diff 的 SHA-256。迁移期 report mode 下，review 正文还要同时带一条相同 head/verdict/reviewer/model 的 v1 marker，因为当前 required 旧 workflow 只解析 v1；block mode 激活后移除 v1。新提交会让旧结论失效；base 前进但 PR HEAD 不变时，只要 main 没有修改 PR 也修改的路径，review 仍然有效。审查循环通常控制在 2–3 轮内。

### 4.7 `gate-artifact-v2`：派生检查

新的派生检查在 `.github/workflows/gate-artifact-v2.yml` 中运行，从受信任的 `main` 检出脚本，不执行 PR 代码。它监听 PR 更新、review 事件，以及 `CI`/`Pre-Merge` 完成事件，因此 review 早于 CI 不会永久卡住。

它检查：

1. 存在绑定当前 PR HEAD 的 `review-verdict:v2`，且没有更晚的 `CHANGES_REQUESTED`；
2. marker 的 `base` 是当前 PR HEAD 和当前 main 的祖先；
3. `base..head` 的二进制 diff SHA-256 与 marker 一致；
4. `pr-gate` 在当前 PR HEAD 上成功；
5. `pre-merge` 成功，且它的 `base` 等于当前 main；
6. PR 标题符合 Conventional Commits，正文包含 `## Motivation`、`## Changes`、`## Testing`、`## Evidence`；
7. main 自 review base 以来修改的路径，与 PR 修改的路径没有重叠；有重叠时要求 delta review。

迁移期行为：

- `MERGE_POLICY_MODE` 未设置时按 `report` 处理；
- report mode 发布 `gate-artifact-v2`，结论为 success，但 summary 写明 would-fail 的原因；这个名字只用于观察，不能加入 required checks；
- block mode 发布 required `gate-artifact`，真实 success/failure；旧 `gate-artifact.yml` 在 block mode 下停止发布，避免两个发布者。

`Policy Base` 在 main push 时把当前 mode 对应的绿色 gate 标成 `action_required`，防止旧 base 上的成功被误合并。它只更新检查状态，不评论、不打标签、不修改 PR 分支。

**激活顺序：**

1. 合并 workflow 代码，保持 report mode，确认 `gate-artifact-v2` summary 和 pre-merge 结果正确。
2. 设置 `MERGE_POLICY_MODE=block`；旧 `gate-artifact.yml` 自动停止发布，新 workflow 开始发布 required `gate-artifact`。
3. 在一个失败 PR 上确认 required gate 变红，在通过 PR 上确认变绿。
4. 最后才移除 ruleset 的 strict up-to-date。

**回滚顺序：**

1. 先恢复 ruleset 的 strict up-to-date，挡住旧 base。
2. 把 `MERGE_POLICY_MODE` 切回 `report`；旧 workflow 恢复发布，`gate-artifact-v2` 回到 report-only。
3. 用一次新的 review 事件重新生成 required gate；不要沿用 block mode 留下的 success。

实现细节见 [gate-artifact-v2.yml](../.github/workflows/gate-artifact-v2.yml)、[publish-gate.mjs](../scripts/ci/publish-gate.mjs)、[base-recheck.yml](../.github/workflows/base-recheck.yml)。旧的 [gate-artifact.yml](../.github/workflows/gate-artifact.yml) 在迁移完成前保留。

### 4.8 `main` 规则集与人工合并

`main` 使用名为 `main-pr-gate` 的 GitHub 分支保护规则集（ruleset）。当前设置如下：

| 设置 | 当前值 |
|---|---|
| 必须通过 PR | 是 |
| GitHub 要求的批准数 | 0 |
| 必需检查 | `pr-gate`、`gate-artifact`（required context 不变；`gate-artifact-v2` 只用于 report，永不加入 required checks） |
| 必须解决所有 review 对话（conversation） | 是 |
| 分支必须包含最新 `main` | 是（迁移期保留；切换到 pre-merge gate 后移除） |
| 允许的合并方式 | 仅合并提交（merge commit） |
| 阻止强制推送（force push） | 是 |
| 阻止删除 `main` | 是 |
| 绕过规则的角色 | 无 |
| 自动合并 | 关闭 |
| 合并后删除来源分支 | 开启 |
| 允许更新分支 | 开启 |
| 要求线性历史 | 否 |

批准数为 0 表示 GitHub 不会用第二个账号的 `Approve` 来强制独立审查；独立审查由 `review-verdict` 和派生 gate 共同记录。维护者仍然手动合并，不使用 auto-merge、merge queue 或 merge train。

迁移到 pre-merge 模型后，移除“分支必须包含最新 `main`”，改由 `pre-merge` 证明当前 main 的合并结果；`Policy Base` 负责让旧 gate 在 main 前进后失效。required context 始终是 `gate-artifact`：report mode 由旧 workflow 发布，block mode 由新 workflow 发布；`gate-artifact-v2` 永远不能被列为 required。激活和回滚顺序见 §4.7。

规则集能强制 `pr-gate` 和派生 gate 通过，但不能判断测试是否覆盖了目标行为，也不能判断审查者是否认真检查了测试。下面这些内容仍要由审查者和维护者阅读：

- `## Testing` 中的测试设计和实际命令；
- `Not run` 中未运行项及原因；
- review 是否指出测试缺失、断言不足或证据不一致；
- heavy 本机测试是否在目标提交上运行。

## 5. Heavy 本机测试

`Heavy` workflow 是独立的本机测试流程，不会在 PR 创建或更新时自动运行。它只接受 `workflow_dispatch`，运行在标签为 `self-hosted` 和 `heavy` 的机器上，主要步骤是：

```text
npm ci
npx playwright install chromium
npm run typecheck
npm run build
DSH_HOST_SMOKE_STRICT=1 npm run test:host-smoke
npm run test:coverage:layered -- --base origin/<base>
npm run test:e2e
npm run test:e2e:bash
```

workflow 会从 `repo_path` 指向的本地仓库目录克隆 `$GITHUB_SHA`，检查 Node 是否匹配 `.node-version`，并使用临时环境运行。默认 `repo_path` 是维护者本机路径，换机器时要显式传入正确路径。

`heavy-gate` 覆盖 `typecheck`、构建、打包后 host smoke、分层覆盖率、keyless E2E 和主机 bash 检查。它不运行 `pr-gate`，不审查代码，也不判断测试断言是否有效。它不能替代 `pr-gate`；`pr-gate` 也不能替代它。需要本机 DSH 环境、Chromium 或 bash sandbox 才能发现的构建、加载和浏览器问题，只能由 heavy 本机测试或等价的真实环境提供证据。

E2E 在 heavy 中运行 `npm run test:e2e` 和观测性的 `npm run test:e2e:bash`；版本或 E2E 范围变化时，作者还要在干净工作区用 `npm run test:e2e -- --record` 录制当前版本的证据。keyless E2E 的当前版本证据由 `npm run check` 校验；`test:e2e:live` 和 host-bash 只作观测。

审查者可以引用在目标提交上运行的 heavy 结果，但必须核对提交、命令和日志；如果 heavy 没有在目标提交上运行，就按 `Not run` 处理，不能引用在 `main` 或其他提交上的结果。

当前 `heavy-gate` 不是 PR 当前提交上的必需检查，也不能拿一次在 `main` 上的运行结果证明某个 PR。它要成为必需检查，需要先满足两个条件：

1. 连续 20 次没有基础设施失败的 green 运行；
2. 有一个能在 PR 当前提交上发布 `heavy-gate` check 的受信任机制。

计数、升级和回滚步骤见 [heavy-runner.md](heavy-runner.md)。在它成为必需检查前，PR 的 `Not run` 必须如实列出没有运行的 heavy 检查。

## 6. 合并前检查清单

- [ ] PR 指向 `main`，标题符合 Conventional Commits。
- [ ] 正文包含 `## Motivation`、`## Changes`、`## Testing`、`## Evidence`。
- [ ] `## Testing` 记录了实际运行的测试命令和结果，`Not run` 写明了未运行项和原因。
- [ ] `pr-gate` 在 PR 当前提交上成功，失败项已经修复，而不是被跳过。
- [ ] 审查者检查了测试设计、断言和证据，而不只是看 `pr-gate` 是否通过。
- [ ] 独立审查在同一个提交上给出 `review-verdict:v2 verdict=pass`。
- [ ] `pre-merge` 在当前 main 上成功；main 前进后已经重新运行 `recheck`。
- [ ] 派生 gate 成功：report mode 检查 `gate-artifact-v2` 的 summary；block mode 检查 required `gate-artifact`。
- [ ] 所有 review 对话（conversation）已解决。
- [ ] 迁移期 ruleset 仍要求分支包含 `origin/main`；激活 pre-merge 模型后，以 `pre-merge.base == current main` 代替分支更新。
- [ ] heavy 检查已在该提交上运行，或在 `Not run` 中写明原因。
- [ ] E2E 范围或版本变化时，`npm run test:e2e` 已通过，`tests/e2e/evidence/<version>.json` 对应当前版本和提交；录制后只有 `docs/**` 或 `README.md` 变化时不需要重录；`test:e2e:live` 和 host-bash 未当作发布证据。
- [ ] 维护者核对了测试证据和审查结果，然后手动合并，不使用 auto-merge、merge queue 或 merge train。

## 7. 合并之后与发布

人工合并后，`main` 得到一个 merge commit，来源分支自动删除。`Policy Base` 会在 main push 时使其他 PR 的旧派生 gate 失效；`pre-merge` 负责重新验证当前 main 的临时合并结果。合并后仍没有单独的自动测试或审查 workflow，因此合并后的真实结果不等于 PR 阶段的临时合并结果。

合并到 `main` 不等于发布。当前仓库没有发布 tag、GitHub Release 或 npm 发布 workflow；`package.json` 是 `private: true`，README 只承诺 tarball 安装。需要构建 tarball 时，按 [README.md](../README.md) 执行：

```sh
npm run build
npm pack
```

发布前还需要当前版本的 keyless E2E 证据：`tests/e2e/evidence/<version>.json` 必须由 `npm run test:e2e -- --record` 在干净工作区生成，并通过 `npm run check`。`test:e2e:live` 的真实模型结果和 `test:e2e:bash` 的 host-bash 结果只作观测，不作为发布证据。

发布流程若以后加入 GitHub Actions，应单独说明触发条件、版本来源和回滚方式，不应默认认为合并后就会自动发布。

## 8. 失败后从哪里继续

图 4 展示常见状态和返回位置。

```mermaid
stateDiagram-v2
  state "本地测试、修改与证据" as Local
  state "pr-gate" as PRGate
  state "pre-merge" as PreMerge
  state "独立审查" as Review
  state "派生 gate" as Gate
  state "可以合并" as Ready
  state "已合并" as Merged

  [*] --> Local
  Local --> PRGate: push 并创建 PR
  Local --> PreMerge: push 并创建 PR
  PRGate --> Local: pr-gate 失败
  PreMerge --> Local: 冲突或测试失败
  PRGate --> Review: pr-gate 通过
  PreMerge --> Review: pre-merge 通过
  Review --> Local: 代码或测试审查意见
  Review --> Gate: review-verdict:v2 pass
  Gate --> Local: 新提交或 review 失效
  Gate --> Ready: gate-artifact-v2 通过
  Ready --> Local: main 前进，旧 pre-merge 过期
  Ready --> Merged: 人工 merge
  Merged --> [*]
```

| 情况 | 结果 | 下一步 |
|---|---|---|
| 本地测试失败 | 没有新的本地测试证据 | 修复后重新运行受影响测试 |
| `pr-gate` 失败 | 当前提交不能合并 | 修复并 push；新提交重新运行 |
| 审查发现测试不足或断言不验证行为 | 没有通过的 review 标记 | 补测试或改断言，重新运行 `pr-gate` 后再审查 |
| 审查结论为 `needs_revision` 或 `reject` | 没有通过的 review 标记 | 按审查意见修复，再审查 |
| PR 描述中的测试结果与日志不一致 | 派生 gate 不会自动发现 | 重新运行命令，修正 `Testing`、`Evidence` 或 `Not run`，再审查 |
| 审查者没有运行测试却给出 pass | 派生 gate 仍可能通过 | 这是审查质量问题；维护者要读 review 内容，必要时要求重新审查 |
| `pr-gate` 还没通过就提交 review | `gate-artifact-v2` 先报 waiting，CI 完成后自动重算 | 不需要重新提交 review；等 CI 完成后看 gate 结果 |
| 审查后又 push 新提交 | 旧 review v2 不再对应当前提交 | 重新运行 `pr-gate`，重新审查 |
| `main` 前进 | PR HEAD 不变；旧 `pre-merge` 的 base 过期 | 加 `recheck` 标签重跑 `pre-merge`；通常不需要更新分支或重审 |
| 有未解决的 review 对话（conversation） | 合并被阻止 | 解决对话并确认结果 |
| heavy 没运行 | 没有本机测试证据 | 在需要的提交上运行，或在 PR 写 `Not run` |
| `npm run test:e2e` 失败 | E2E 范围没有通过 | 修复后重新运行；从干净工作区重新录制证据 |
| `npm run test:e2e:bash` 失败 | host-bash 观测没有通过，但不等于 keyless E2E 没有通过 | 记录为观测结果；修复环境或代码后重跑；不要把它当成 keyless E2E 证据 |
| E2E 证据与当前版本、清单或提交不一致 | `npm run check` 失败，`pr-gate` 也会失败 | 重新运行 `npm run test:e2e -- --record`，确认证据对应当前版本和干净提交 |
| 直接推送、强制推送或删除 `main` | 规则集拒绝 | 改用 PR 流程 |

## 9. 当前流程的优点

1. **Review 和集成测试分开。** `review-verdict:v2` 绑定作者 HEAD 和 diff；`pre-merge` 绑定当前 main 的临时合并结果。base 前进不会自动让 review 失效。
2. **测试分层清楚。** 作者在本地运行受影响测试，`pr-gate` 在 GitHub 上运行 docs 或 coverage lane，heavy 本机测试补充真实环境、真实浏览器、keyless E2E 和 host-bash。
3. **审查范围包含测试本身。** 审查者不只看实现，还检查测试设计、断言、失败场景测试和 `Not run`，因此可以发现“代码能跑但测试没有验证目标行为”的问题。
4. **`main` 不靠人工记忆保护。** 直接推送、强制推送、删除分支、未通过测试、未解决对话和旧 base gate 都会被规则集或派生 gate 阻止。
5. **GitHub 上的基础测试可重复。** Node 版本来自 `.node-version`，依赖使用 `npm ci`，GitHub Actions 固定到具体版本，`pr-gate` 只读仓库内容且不使用 secret。
6. **人工合并保留最终决定权。** 没有自动合并、merge queue 或 merge train，维护者可以检查测试证据和审查内容。
7. **文档改动有单独测试范围。** docs-only 只跑 `npm run check`，不再重复执行全部测试；review 仍然存在。
8. **E2E 证据绑定版本和运行时变更。** `npm run check` 会拒绝版本不符、场景缺失或录制后运行时文件变化的证据；`docs/**` 和 `README.md` 不触发重录。
9. **合并后自动清理来源分支。** 减少遗留分支，规则集同时阻止删除 `main`。

## 10. 可能存在的挑战

| 挑战 | 当前影响 | 可以做的处理 |
|---|---|---|
| 批准数为 0，独立审查是程序性要求 | GitHub 不会强制第二个账号批准；派生 gate 只校验 marker、提交、diff 和检查状态，不能证明审查者确实独立，也不能证明审查者运行了测试 | 坚持实现者不担任最终审查者；审查使用新上下文和只读方式；维护者合并前读 review 内容；对高风险改动增加独立验证 |
| `pr-gate` 只运行 docs check 或 coverage lane | 类型检查、构建、host smoke、browser 和分层覆盖率可能没有在 PR 提交上运行 | 在需要的提交上手动运行 heavy 本机测试；PR 的 `Not run` 写清原因；满足稳定性条件后再把 heavy 检查升级为必需检查 |
| 测试通过不等于行为被覆盖 | 逐文件行覆盖率可以通过，但断言可能只检查实现细节，或者没有覆盖用户可见结果 | 审查者检查测试是否会在修复前失败、是否验证外部结果；维护者不要把覆盖率当成行为覆盖率的替代品 |
| `review-verdict` 没有测试记录字段 | 审查标记只记录提交、base、diff、结论、审查者和模型，派生 gate 无法判断审查者是否运行过测试 | 审查者在 review 正文写实际运行命令和结论；维护者阅读 review；高风险改动使用 AgentTeams 独立验证；需要更强保证时再增加机器可校验的测试证据 |
| PR 正文校验只检查四个一级标题 | `Testing` 和 `Evidence` 可能内容缺失或与当前提交不一致，派生 gate 不会判断文字是否真实 | 审查者对照实际命令和日志检查；维护者合并前阅读 PR；需要更强保证时增加可执行的内容校验 |
| `heavy-gate` 不是必需检查 | 类型检查、构建、host smoke、分层覆盖率、keyless E2E 和 host-bash 可能在合并前没有运行 | 在需要的提交上手动运行；PR 的 `Not run` 写清原因；满足 20 次 green 和 PR 提交发布检查的条件后再升级 |
| E2E 不在 GitHub 托管运行 | `pr-gate` 只读取 E2E 清单和证据，不重新运行场景；heavy 是本机手动流程，当前也不是必需检查；本地录制环境和 DSH 版本仍可能和审查者预期不同 | E2E 变化或版本变化时在目标提交上运行 `npm run test:e2e` 并更新证据；审查者核对证据；`test:e2e:live` 和 host-bash 只作观测 |
| E2E 证据绑定运行时变更 | 在证据提交之后修改运行时文件，`npm run check` 会失败并要求重新录制；`docs/**` 和 `README.md` 不触发重录 | 把 E2E 录制放在最后；运行时改动后重新运行 `npm run test:e2e -- --record`；不要手工修改证据头部来绕过检查 |
| host-bash 依赖本机 bash sandbox | 环境不可用时不能产生结果，而且它只作观测，不能替代 keyless E2E 证据 | 在 PR 里写明观测结果或 `Not run`；不要用 host-bash 替代 keyless E2E 证据 |
| 本地测试和 CI 测试的环境不同 | 本地通过可能在 GitHub 托管环境中失败，或者 CI 通过但本机打包和浏览器路径没有运行 | 以 `pr-gate` 作为 GitHub 环境的测试结果；需要真实 host 或浏览器的行为用 heavy 本机测试补证据；不要互相替代 |
| PR 描述中的测试证据会过期 | 任何编辑、暂存或未跟踪文件都会改变工作区状态；旧的 `Testing`、`change-scope` 和 `gate-artifact` 输出不能继续使用 | 最后一次修改后重新运行并更新 PR；审查者对照当前提交检查命令和结果 |
| 迁移期双 gate | required context 始终是 `gate-artifact`；`gate-artifact-v2` 只做 report。block mode 后旧 workflow 停止发布，避免两个发布者 | 按 §4.7 的顺序激活；回滚先恢复 strict up-to-date，再切回 report |
| base-recheck 是异步的 | main 前进到旧 gate 被标 stale 之间有短暂窗口 | 激活前验证 main push workflow 的时效；保留 strict up-to-date 直到稳定；长期用 merge queue 才能消除该窗口 |
| 没有合并后自动测试或审查 | `main` 上的 merge commit 没有对应的自动测试、审查或证据记录 | 依赖严格的 up-to-date 规则和人工合并；需要更强保证时新增合并后或者定时测试 |
| docs-only 判断错误 | 混合改动若被误判为 docs-only，会跳过 coverage | 分类器对空 diff 和非 `docs/**`/`README.md` 路径返回 false；混合改动走完整 lane |
| 规则集不在仓库文件里 | GitHub 设置和本文可能发生偏差，`npm run check` 无法发现远端规则变化 | 改规则集前先备份；定期在 GitHub Settings → Rules → `main-pr-gate` 核对，并同步本文 |
| 没有自动发布 | 合并到 `main` 不产生 tag、GitHub Release 或 npm 包 | 把发布保持为独立人工步骤；需要时按 README 构建和发布 tarball |

## 11. 如何核对和维护

本文只记录当前状态，GitHub 上的实际设置仍以远端页面为准。核对时按下面顺序看：

1. workflow 和命令：`.github/workflows/`、[tools/workflow.json](../tools/workflow.json)；
2. review 和 PR 校验：`.github/workflows/gate-artifact-v2.yml`、`.github/workflows/pre-merge.yml`、`.github/workflows/base-recheck.yml`、[review-verdict.mjs](../scripts/ci/review-verdict.mjs)、[publish-gate.mjs](../scripts/ci/publish-gate.mjs)、[pr-metadata.mjs](../scripts/ci/pr-metadata.mjs)；
3. heavy 本机测试：`.github/workflows/heavy.yml`、[heavy-runner.md](heavy-runner.md)；
4. E2E 和 host-bash：`tests/e2e/manifest.json`、`tests/e2e/scenarios/topic-bash.mjs`、`tests/e2e/evidence/<version>.json`、[package.json](../package.json)、[testing.md](testing.md)；
5. GitHub 远端设置：仓库 Settings → Rules → `main-pr-gate`；
6. 测试策略和审查规则：[testing.md](testing.md)、[agent-teams.md](agent-teams.md)、[code-review](../.agents/skills/code-review/SKILL.md)。

workflow、脚本或 ruleset 改动后，同步更新本文，并按 [tools/workflow.json](../tools/workflow.json) 运行对应检查；只改文档时至少运行 `npm run check`。测试分层或审查要求变化时，先更新 [testing.md](testing.md) 或 [code-review](../.agents/skills/code-review/SKILL.md)，再同步本文。如果新流程引入了新的文档页面，还要在 [docs/README.md](README.md)、[docs/kinds.json](kinds.json) 和 [docs/publish.json](publish.json) 中登记。

## 12. 事实来源

| 事实 | 来源 |
|---|---|
| PR 基础检查 | [.github/workflows/ci.yml](../.github/workflows/ci.yml) |
| 合并结果检查 | [.github/workflows/pre-merge.yml](../.github/workflows/pre-merge.yml)、[publish-pre-merge.mjs](../scripts/ci/publish-pre-merge.mjs) |
| 派生 gate 和 base stale | [.github/workflows/gate-artifact-v2.yml](../.github/workflows/gate-artifact-v2.yml)、[.github/workflows/base-recheck.yml](../.github/workflows/base-recheck.yml)、[publish-gate.mjs](../scripts/ci/publish-gate.mjs)、[review-verdict.mjs](../scripts/ci/review-verdict.mjs) |
| 旧 review 和证据检查 | [.github/workflows/gate-artifact.yml](../.github/workflows/gate-artifact.yml)（迁移期保留） |
| PR 标题和正文结构 | [pr-metadata.mjs](../scripts/ci/pr-metadata.mjs)、[pr-description](../.agents/skills/pr-description/SKILL.md) |
| 本地证据记录 | [gate-artifact.mjs](../scripts/review/gate-artifact.mjs)、[change-scope.mjs](../scripts/review/change-scope.mjs) |
| heavy 本机测试 | [.github/workflows/heavy.yml](../.github/workflows/heavy.yml)、[heavy-runner.md](heavy-runner.md) |
| 版本化 E2E 和 host-bash | [.github/workflows/heavy.yml](../.github/workflows/heavy.yml)、[tests/e2e/manifest.json](../tests/e2e/manifest.json)、`tests/e2e/scenarios/topic-bash.mjs`、`tests/e2e/evidence/<version>.json`、[package.json](../package.json)、[testing.md](testing.md) |
| 测试分层和命令 | [testing.md](testing.md) |
| 审查流程和独立审查 | [agent-teams.md](agent-teams.md)、[code-review](../.agents/skills/code-review/SKILL.md) |
| 分支到合并的设计背景 | [pr-gate-flow.md](design/github-flow/pr-gate-flow.md) |
| 合并和发布设置 | GitHub 仓库的 Rules、General 和 Actions 页面；[README.md](../README.md) 的安装与构建说明 |
