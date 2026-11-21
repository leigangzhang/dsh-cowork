# Heavy runner 运维手册

本文只回答三件事：怎么触发一次 heavy run、怎么确认 observe 结果绑定到了正确 head，以及接入派生 gate 前要满足什么。流程背景见 [pr-gate-flow.md](design/github-flow/pr-gate-flow.md)。

## 前提

- heavy 仍是 **manual-only**：只通过 `workflow_dispatch` 启动，不接 PR 事件。
- workflow 在 `github.sha` 上发布 `heavy-gate` commit status 和 `heavy-gate-result` display check；`heavy-result.json` 记录 head、base、current main、diff SHA-256、porcelain 和每个命令的退出码。
- `heavy-gate` 当前是 **observe 模式**，不是 required context。`main` ruleset 仍只要求 `gate-artifact`；不要直接把 `heavy-gate` 加进 ruleset。
- 在把 heavy 结果接入 `gate-artifact` 之前，先在同一个 head 上观察一个绿色周期。

## 触发一次 heavy run

在本机 runner 已在线时执行：

```sh
gh workflow run heavy.yml \
  --ref agent/<topic> \
  -f base=main \
  -f repo_path="$HOME/Workspace/dsh-cowork"
```

`--ref` 决定 `$GITHUB_SHA`，publisher 绑定这个 head。`base` 可以是分支名或 commit SHA；workflow 会先 fetch 再解析成 SHA，body 的 coverage、pre-run identity 和 publisher 都使用这个 SHA。`repo_path` 必须指向包含 `.git` 的本地 checkout；workflow 从该路径 clone 当前 `$GITHUB_SHA`，不下载任何 action。

查看最近一次运行：

```sh
gh run list --workflow=heavy.yml --limit 5 \
  --json databaseId,status,conclusion,headBranch,createdAt \
  --jq '.[] | [.databaseId,.status,.conclusion,.headBranch,.createdAt] | @tsv'
```

## 查看 observe 结果

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

## 判定一个绿色观察周期

以下条件必须同时满足：

- 运行是 `success`，且 `heavy-gate` 在同一个 `HEAD_SHA` 上发布 `state: success`；
- `heavy-result.json` 的 `head`、`base`、`diffSha256` 与本次运行的 pre-run artifact 一致，`porcelain` 为空；
- 所有 blocking 命令退出码为 0；`e2e-bash` 可以非 0，但必须作为 observational 结果保留；
- `base` 仍是 head 的祖先，`currentMain` 已记录；
- 新 commit 后旧 status 不能沿用，必须在新的 head 上重新 dispatch。

满足一个绿色观察周期后，下一步才是把 `heavy-gate` 接入 `gate-artifact` 的派生决策。ruleset 不增加第二个 required context；docs-only PR 的重型豁免也属于那一步。

## 回滚

因为 `heavy-gate` 不在 ruleset 中，回滚不需要改规则：

1. 回退 `.github/workflows/heavy.yml`、`scripts/ci/publish-heavy.mjs` 或相关测试；
2. 在同一 head 上重新运行 publisher 会原地覆盖 `heavy-gate` status；
3. 如果只需撤销某个错误状态，重新 dispatch 该 head，不要删除 ruleset。

## 常见错误

- **把 job 绿色当成 heavy 绿色**：测试失败时 publisher 仍可能发布一个成功的 failure status；job 退出码和 status 是两件事。
- **把 `heavy-gate` 加进 ruleset**：它会变成所有 PR 的无条件 required check，违背 observe-first 和 docs-only 豁免设计。
- **工作区不干净**：runner 上的未跟踪文件会进入 `porcelain`，publisher 必须发布 failure。
- **只验证 workflow_dispatch 的 job check**：真正要读的是 head 上的 `heavy-gate` commit status 和 `heavy-result.json` 身份。
- **复用旧 head 的绿色结果**：新 commit 或新 diff 必须重新运行；publisher 会拒绝 head/diff 不匹配的结果。
