# Heavy runner 运维手册

本文只回答两件事：怎么确认 heavy run 的连续 green 次数，以及累计到 20 次后怎么把 `heavy-gate` 加入 `main` 的 ruleset。流程背景见 [pr-gate-flow.md](design/github-flow/pr-gate-flow.md)。

## 前提

- heavy 是 **manual-only**：只通过 `workflow_dispatch` 启动，不接 PR 事件。
- 只有连续 green 才算数；出现 `failure` 或 `cancelled` 就从下一次重新计数。
- 当前 `heavy-gate` 还不是 PR head 上的 required check。**不要直接把它加进 ruleset**；先完成本文“head-bound check publisher”检查。

## 触发一次 heavy run

在本机 runner 已在线时执行：

```sh
gh workflow run heavy.yml \
  --ref main \
  -f base=main \
  -f repo_path="$HOME/Workspace/dsh-cowork"
```

`repo_path` 必须指向包含 `.git` 的本地 checkout；workflow 会从该路径 clone 当前 `$GITHUB_SHA`，不下载任何 action。

查看最近一次运行：

```sh
gh run list --workflow=heavy.yml --limit 5 \
  --json databaseId,status,conclusion,headBranch,createdAt \
  --jq '.[] | [.databaseId,.status,.conclusion,.headBranch,.createdAt] | @tsv'
```

## 查看累计次数

列出已完成运行的明细：

```sh
gh run list --workflow=heavy.yml --limit 50 --status completed \
  --json databaseId,conclusion,headBranch,createdAt \
  --jq '.[] | [.databaseId,.conclusion,.headBranch,.createdAt] | @tsv'
```

直接计算“从最新一次往回数，连续 success 的次数”：

```sh
gh run list --workflow=heavy.yml --limit 50 --status completed \
  --json conclusion \
  --jq '[.[].conclusion]
    | reduce .[] as $c ({streak: 0, stop: false};
        if .stop or $c != "success" then .stop = true
        else .streak += 1
        end)
    | .streak'
```

输出就是当前连续 green 次数；遇到第一个非 `success` 停止。若 streak 超过 50，提高 `--limit`。计数到 20 时，把 20 个 `databaseId`、`headBranch`、`createdAt` 记录下来，确认没有 failure/cancelled 混在中间。

## 达到 20 次后先验证 publisher

`workflow_dispatch` 的 job check 不绑定 PR head，不能直接作为 required check。先确认存在一个受信任的 publisher，能在 PR head 上创建名为 `heavy-gate` 的 check：

```sh
gh api repos/leigangzhang/dsh-cowork/commits/<pr-head-sha>/check-runs \
  --jq '.check_runs[] | select(.name == "heavy-gate")
    | {name, app_id: .app.id, status, conclusion}'
```

只有以下条件全部满足才继续：

- 测试 PR 的 head 上能看到 `heavy-gate`；
- docs-only PR 也能得到明确的 `success`（`not-needed`）或策略允许的状态，不能因为 check 不存在而阻塞；
- 新 commit 后旧 check 失效，新 head 会重新发布；
- `app.id` 是实际发布者的 integration id。

如果 publisher 还不存在，停在 manual-only，不要改 ruleset。

## 加入 ruleset

先备份当前 ruleset：

```sh
RULESET_ID="$(gh api repos/leigangzhang/dsh-cowork/rulesets \
  --jq '.[] | select(.name == "main-pr-gate") | .id')"
gh api "repos/leigangzhang/dsh-cowork/rulesets/$RULESET_ID" > /tmp/main-pr-gate.json
```

确认 publisher 的 integration id，再用 `jq` 追加 `heavy-gate`：

```sh
HEAVY_APP_ID=15368   # 替换为 publisher 的 app.id
jq --argjson app "$HEAVY_APP_ID" '
  .rules |= map(
    if .type == "required_status_checks"
    then .parameters.required_status_checks |=
      (if any(.[]; .context == "heavy-gate")
       then .
       else . + [{"context": "heavy-gate", "integration_id": $app}]
       end)
    else . end
  )
' /tmp/main-pr-gate.json > /tmp/main-pr-gate-heavy.json

diff -u /tmp/main-pr-gate.json /tmp/main-pr-gate-heavy.json
```

确认 diff 只增加 `heavy-gate` 后应用：

```sh
gh api --method PUT \
  "repos/leigangzhang/dsh-cowork/rulesets/$RULESET_ID" \
  --input /tmp/main-pr-gate-heavy.json
```

验证：

```sh
gh api "repos/leigangzhang/dsh-cowork/rulesets/$RULESET_ID" \
  --jq '.rules[] | select(.type == "required_status_checks")
    | .parameters.required_status_checks'
```

## 回滚

恢复备份即可：

```sh
gh api --method PUT \
  "repos/leigangzhang/dsh-cowork/rulesets/$RULESET_ID" \
  --input /tmp/main-pr-gate.json
```

回滚后确认 `heavy-gate` 已从 required checks 消失。不要用删除 ruleset 作为常规回滚，除非同时准备好恢复 `pr-gate` 和 `gate-artifact`。

## 常见错误

- **把 20 次 total success 当成连续 20 次**：必须从最新一次往回数，中间有 failure 就重置。
- **publisher 未覆盖 docs-only PR**：required check 缺失会阻塞所有 PR；先验证 `not-needed` 策略。
- **直接把 workflow_dispatch 的 job check 加进 ruleset**：它不是 PR head 状态，会让所有 PR 一直等待。
- **使用错误 integration id**：同名 check 可能来自其他集成；用实际 `check_runs[].app.id`。
- **只验证 source PR，不验证新 commit**：新 head 必须重新发布 `heavy-gate`，否则证据会过期。
