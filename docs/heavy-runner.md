# Heavy runner 运维手册

本文回答 heavy 的触发方式、head-bound 结果如何进入 `gate-artifact`，以及失败时怎么排查和回滚。流程背景见 [pr-gate-flow.md](design/github-flow/pr-gate-flow.md)。

## 前提

- heavy 有三个入口：同仓库 `agent/*` PR 的 CI 成功后由 `workflow_run` 自动触发，维护者给同仓库 PR 加 `heavy` label，或用 `workflow_dispatch` 手动触发。fork PR 永远跳过 self-hosted job。
- workflow 在目标 `HEAD_SHA` 上发布 `heavy-gate` commit status 和 `heavy-gate-result` display check；`heavy-result.json` 记录 head、base、current main、diff SHA-256、porcelain 和每个命令的退出码。
- 结果 publisher、pre-run 身份记录和 docs-only classifier 都从本地 checkout 的 `refs/remotes/origin/main` 导出到临时目录后执行，不执行 PR checkout 里的同名脚本；PR checkout 只用于测试命令和 git 身份读取。
- `gate-artifact` 现在是唯一 required context；docs-only PR 豁免 heavy，其他 PR 需要同 head 的 `heavy-gate` success 才能通过。
- ruleset 仍不直接要求 `heavy-gate`。它是 `gate-artifact` 的输入，不是第二个 required check。
- 新 commit 必须在新的 head 上重新产生结果；旧 status 不会自动迁移。

## 触发方式

自动触发在 workflow 文件进入默认分支后才会生效；首次落地前用 `workflow_dispatch` 验证。

给同仓库 PR 加标签：

```sh
gh pr edit <pr-number> --add-label heavy
```

手动触发：

```sh
gh workflow run heavy.yml \
  --ref agent/<topic> \
  -f repo_path="$HOME/Workspace/dsh-cowork"
```

`--ref` 决定手动运行的 `HEAD_SHA`。workflow 先从 `repo_path` 对应的 checkout fetch `refs/heads/*` 到 `refs/remotes/origin/*`，并记录 `refs/remotes/origin/main` 的 SHA；不传 `base` 时用这个 SHA 与 `HEAD_SHA` 的 merge-base，显式传 `-f base=<branch-or-sha>` 时在同一个 checkout 中解析成固定 SHA。`repo_path` 必须指向包含 `.git`、且 `origin` 指向仓库的本地 checkout；workflow 再从本地 clone 目标 head，不下载任何 action。这样自动触发的同仓库 PR head 不要求事先手工更新本地 checkout，base 也不会取到本地未刷新的 `main` 分支。

查看最近一次运行：

```sh
gh run list --workflow=heavy.yml --limit 5 \
  --json databaseId,status,conclusion,headBranch,headSha,createdAt \
  --jq '.[] | [.databaseId,.status,.conclusion,.headBranch,.headSha,.createdAt] | @tsv'
```

## 查看结果

先取运行对应的 head：

```sh
HEAD_SHA="$(gh api repos/leigangzhang/dsh-cowork/actions/runs/<database-id> --jq .head_sha)"
gh api "repos/leigangzhang/dsh-cowork/commits/$HEAD_SHA/statuses" \
  --jq '.[] | select(.context == "heavy-gate")
    | {context, state, description, target_url, created_at}'
gh api "repos/leigangzhang/dsh-cowork/commits/$HEAD_SHA/check-runs" \
  --jq '.check_runs[] | select(.name == "heavy-gate-result")
    | {name, app_id: .app.id, status, conclusion, output}'
```

`heavy-result.json` 在 runner workspace 中生成、被 `.gitignore` 忽略；workflow 的 `Show coverage evidence` 步骤会把内容打印到日志。不要提交这个文件，也不要把它当 release evidence。

## gate 如何消费结果

`publish-gate.mjs` 读取 head 上最新的 `heavy-gate` status 和 `heavy-gate-result` 的 JSON summary，并验证：

- status 是 `success`，summary 的 `result` 是 `pass`；
- summary head 等于当前 PR head；
- `porcelain` 为空、`clean: true`，所有 blocking 命令退出码为 0；
- base 同时是 head 和 current main 的祖先；
- 用 base..head 重新计算的 diff SHA-256 与 summary 一致。

docs-only PR 由可信 main 树里的共享 path classifier 判定；判定为 docs-only 时 heavy workflow 只做 refresh、checkout、base、classify，不安装依赖、不跑测试、不发布 heavy 结果。任何一项不满足，`gate-artifact` 都会 blocked 并给出具名原因。`Heavy` workflow 完成后也会触发派生 gate 重算，避免 CI 先跑、heavy 后跑造成永久 pending。

## 判定绿色周期

以下条件必须同时满足：

- 运行是 `success`，且 `heavy-gate` 在同一个 `HEAD_SHA` 上发布 `state: success`；
- `heavy-gate-result` 是 `success`，其 summary 可以被 gate 解析并通过上面的身份检查；
- 所有 blocking 命令退出码为 0；`e2e-bash` 可以非 0，但必须作为 observational 结果保留；
- `base` 仍是 head 的祖先，`currentMain` 已记录；
- 新 commit 后旧 status 不能沿用，必须自动或手动重新产生。

## 回滚

因为 `heavy-gate` 不在 ruleset 中，回滚不需要改规则：

1. 回退 `.github/workflows/heavy.yml`、`.github/workflows/gate-artifact-v2.yml`、`scripts/ci/publish-gate.mjs`、`scripts/ci/publish-heavy.mjs` 或相关测试；
2. 在同一 head 上重新运行 publisher 会原地覆盖 `heavy-gate` status；
3. 如果只需撤销某个错误状态，重新 dispatch 该 head，不要删除 ruleset。

## 常见错误

- **把 job 绿色当成 heavy 绿色**：测试失败时 publisher 仍可能发布一个失败 state；job 退出码和 status 是两件事。
- **把 `heavy-gate` 加进 ruleset**：它会变成所有 PR 的无条件 required check，违背 docs-only 豁免和单 required context 设计。
- **依赖旧 head 的绿色结果**：新 commit 没有 `heavy-gate`，gate 会 blocked；必须重新运行。
- **只看 commit status 不看 result check**：status 是粗粒度裁决，base/diff/porcelain 身份在 `heavy-gate-result` summary 中。
- **工作区不干净**：runner 上的未跟踪文件会进入 `porcelain`，publisher 必须发布 failure。
- **让 PR checkout 执行 publisher**：分支可以改写 `publish-heavy.mjs` 来伪造 success；publisher、pre-run 身份记录和 classifier 必须从可信 main 树的临时导出执行。
- **在默认分支还没有新 workflow 时期待自动触发**：`workflow_run` 使用默认分支上的 workflow 文件；合并前只能手动 dispatch。
