# M2-P0 探针结果：会话绑定、记忆注入与 thread checkout

- 结论：M2 的四问都有答案。会话 cwd 只能在创建时决定，且创建后不能重绑到父 workspace；记忆可以在 agent 作用域的 system prompt 段落里按轮注入；`git worktree` 的合并语义可用，但 **thread 在 worktree 里无法 git 写**（沙箱 EPERM）；因此隔离实现采用 **F 方案：每 thread 一个本地 clone**（`git clone --local`），该决定经用户确认。
- 宿主：DSH Desktop 2.0.18 / 运行时 0.2.1-rc.2，web profile `http://127.0.0.1:3080`；插件 `@dsh-external/dsh-cowork`（`dev_inject_plugin` 注入态）。
- 探针方法：通过 dsh-super-injector 的 staging 工具在宿主进程内执行，未修改仓库文件；git 实验在 `/tmp` 夹具里跑。
- 证据容器：[`.dsh-cowork/probe/m2-p0/P0_RESULT.json`](../../.dsh-cowork/probe/m2-p0/P0_RESULT.json)（gitignored）。下文「原始输出」均摘自该文件的对应分组，字段值未改，只省略重复结构。
- 复现：该探针没有 HTTP 路由，证据以 JSON 为准；具体分组与字段名在每节标题后给出。

## 0. 策略前提：workspace-write 是插件必须支持的最小权限

P0 的全部结论以 **workspace-write** 文件策略为前提（`P0_RESULT.json.sandboxPolicyNote`）：

> All P0 probes ran while the deployment file policy was workspace-write (the least-privilege mode a cowork thread must be able to run under). The worktree-cwd git EPERM in P0_7 is a workspace-write boundary: a linked worktree's git metadata lives outside the session cwd. Under danger-full-access the worktree option would likely work, but the plugin must not depend on full access; F (per-thread local clone) is the chosen design and works under both.

代码事实：

- 沙箱的可写根 = 会话 cwd + `/tmp` + `os.tmpdir()`：`deepseek-harness/packages/sandbox/sandbox/src/roots.ts:52-54`（`writableRoots`），Seatbelt 以这些根生成 `file-write*` 允许项：`packages/sandbox/sandbox-local/src/profiles.ts:53`。
- 会话 cwd 就是 `workspaceRoot`：M0 已证（[M0 探针 §4](M0_PROBE_RESULT.md)），`sessionController.create` 取 `workspace?.path ?? request.cwd ?? defaultCwd`（`packages/api/session-controller/src/commands.ts:119`）。

结论：任何依赖「写会话 cwd 之外路径」的方案都要额外权限；F 方案的 git 元数据在会话 cwd 内，因此在最小权限下成立。

## 1. 会话能否 live 在一个 worktree 里？（`P0_1_session_worktree_binding`）

**代码事实**

- `session.create` 只接受 `workspaceId` 或 `cwd`，两者同时传直接拒绝：`packages/api/session-controller/src/commands.ts:106-107`。
- 会话 cwd 解析：`workspace?.path ?? request.cwd ?? defaultCwd`（`commands.ts:119`），创建后没有改 cwd 的入口。
- `attachSession` 要求会话 header 的 cwd 经 realpath 归一化后 **严格等于** workspace 路径：`packages/workspace/workspace/src/entity.ts:124,143-149`。
- 侧栏会话树只列出 `workspace.sessionIds` 里的会话，且 `summary.cwd` 必须等于 workspace 路径：`packages/client/ui-workspace/src/client/navigation.ts:184-185`。

**原始输出（摘录）**（`P0_1.observed`）

```text
git worktree add -b cowork/m2-p0-binding <repo>/.dsh-cowork/worktrees/m2-p0-binding HEAD   exitCode 0
workspaceRegistry.create(worktreePath)   ok true   workspaceId aa0e3e2d-…
sessionController.create({workspaceId})  sessionId session-8a27e721-…  returnedPreset router-standard
sessionController.inspect                  headerCwd .../.dsh-cowork/worktrees/m2-p0-binding  matchesWorktree true
workspace.sessionIds                       contains true
sessionController.list                     listed true, running false
repoWorkspace.attachSession(worktreeSession)  threw true
  message: cannot attach session 'session-8a27e721-…' to workspace '/Users/ray/Workspace/dsh-cowork':
           its cwd resolves to '/Users/ray/Workspace/dsh-cowork/.dsh-cowork/worktrees/m2-p0-binding'
repoWorkspace.sessionIds                   containsProbe false
```

**结论**

- (a) worktree 建好后用 `cwd: worktreePath` 建会话、再挂到仓库 workspace：**不可能**，attach 的 cwd 严格相等检查会拒绝。
- (b) thread 保持仓库 cwd、按绝对路径操作 worktree：**可行**，隔离只是行为约定——thread 仍可写主工作区，且 git 写的前提见 §4。
- (c) 把 worktree 当成独立 workspace：**可行**，会话 header cwd = worktree，且是该 workspace 的正常侧栏行；代价是 worktree 必须在建会话前存在，因为 cwd 不能重绑。
- 额外：`cowork-thread` preset 在 worktree-cwd 会话中照常挂载（`P0_2`：返回 `cowork-thread`，assembly 19 sections / 78 tools，含 `bash`、`write`、`cowork_handoff`）。

## 2. 记忆能否进 system prompt、能否按轮求值？（`P0_3_memory_prompt_seam`）

**代码事实**

- `systemPrompt.section()` 把段落注册到 **调用方 context 的作用域**，返回 Cordis effect disposer；同一层同名重复或 order 非有限数会抛：`packages/core/system-prompt/src/index.ts:454`。
- agent 作用域的 scope key 是 Agent 对象：`packages/core/agent-loop/src/agent.ts:130`（`createScope(loopCtx, this)`）；每步 assembly 用 `assembleContextFor(this, signal)`：`agent.ts:272`、`packages/core/agent/src/dispatch.ts:174`。

**原始输出（摘录）**（`P0_3.observed`）

```text
agent.ctx own symbols: ["Symbol(dsh.scope)"]
baseline assemble(scopeA):  sections 26, markerPresent false
agentA.ctx.systemPrompt.section({name:'cowork:p0-agent-probe', order:900, text:()=>marker+counter})  ok true
assemble(scopeA):            markerSection "COWORK-AGENT-SECTION-PROBE #1"
assemble(scopeA) again:      markerSection "COWORK-AGENT-SECTION-PROBE #2", reEvaluated true
assemble(scopeB):            markerPresent false
assemble({}) global:         markerPresent false
dispose section; assemble(scopeA): markerPresent false
```

**结论**：这是一个全局插件可以用的注入点。

- 可在 `agent/created` 拿到 agent 后，把它注册进**该 agent 自己的作用域**，只影响这个 agent 的 assembly；
- `text` 为函数时每次 assembly 重新求值，不需要 `agent/pre-step` 之类的钩子；
- 卸载必须自己跟踪并调用 disposer，否则热重载会在活着的 agent 上留下旧 provider（重复注册会抛同名错误）；
- 用户写的记忆应设 `interpolate: false`，避免 `$` 被当模板插值。

PLAN §5.5 的 system prompt 注入因此成立，brief 注入不再是必需的退化路径。

## 3. `git worktree` 的行为（`P0_4_git_worktree_behavior`）

**原始输出（摘录）**

| 场景 | 命令 | exitCode / 结果 |
|---|---|---|
| happy path | `worktree add -b` → worktree 内提交 → `merge --no-ff` → `worktree remove` → `branch -d` | 0/0/0/0/0；主分支 a.txt 更新，无残留 |
| merge 冲突 | 主分支与 thread 改同一文件后 merge | merge header exit 1；`UU a.txt`；`merge --abort` exit 0；主工作区恢复干净；worktree 与分支**保留** |
| thread 侧解决后重试 | clone/worktree 内 `merge --no-ff main` → 解决 → 提交 → master 重试 | 重试 merge exit 0，产生一个 merge commit |
| 脏 worktree 删除 | 含 untracked 文件执行 `worktree remove` | exit 128：`fatal: contains modified or untracked files, use --force`；只有 ignored 文件时可删 |
| 创建失败 | 分支已存在 / 目标目录非空 | exit **255** / exit **128**；失败不留下目录（`duplicateBranchLeftDirectory false`） |
| 主工作区脏时 merge | `merge --no-ff` | exit 2：`error: Your local changes to the following files would be overwritten by merge: other.txt` |

**结论**

1. 合并前「干净」判定必须包含 **untracked** 文件，不能只看 `git diff`；
2. 失败映射要按 stderr/exitCode 分类（add 失败返回 128 与 255）；
3. merge 冲突、`--abort`、保留现场、解决后重试的 git 语义与提案假设一致。

## 4. thread 在 worktree 里能 git 写吗？——不能（`P0_7_thread_side_git_under_both_bindings`）

**代码事实**：沙箱只允许写会话 cwd、`/tmp`、`os.tmpdir()`（§0）；linked worktree 的 git 元数据在 `<repo>/.git/worktrees/<id>`，位于会话 cwd（worktree 路径）之外，且没有 `.git` 例外。

**原始输出（摘录）**

选项 C：thread 会话 cwd = worktree（preset `cowork-thread`，session `session-6d905e89-…`）

```text
bash: printf ... > p0-git.txt && git add ... && git commit ...
exitCode: 128
stderr: fatal: Unable to create '/Users/ray/Workspace/dsh-cowork/.git/worktrees/m2-p0-git/index.lock': Operation not permitted
thread-side git status --porcelain: ?? p0-git.txt（本轮的只读 status 可用）
host-side git log in worktree: 仍为 058acd0（没有提交）
```

选项 B：thread 会话 cwd = 仓库根（session `session-8a6cfb50-…`）

```text
bash: printf ... > .dsh-cowork/worktrees/m2-p0-optb/optb.txt && git -C .dsh-cowork/worktrees/m2-p0-optb add optb.txt && git -C ... commit -m 'p0 optb probe'
exitCode: 0
stdout: [cowork/m2-p0-optb 31f4125] p0 optb probe
host-side git log: 31f4125 p0 optb probe；host-side status: clean
```

**结论**

- 选项 C（worktree cwd + 强制隔离）与 thread 自己提交**不能共存**：文件能改，git 写被拒。要保住强制隔离，提交必须由插件侧代做；
- 选项 B 能提交，但 `.git` 在仓库根内，隔离退化为行为约定：同一会话也能写主工作区；
- 因此需要一个 **`.git` 在会话 cwd 内**、且由 master 合并的方案 → F。

## 5. F 方案：每 thread 一个本地 clone（`P0_8_option_F_per_thread_clone`）

**原始输出（摘录）**

live host 部分（仓库 `/Users/ray/Workspace/dsh-cowork`，clone 到 `<repo>/.dsh-cowork/threads/m2-p0-clone`）：

```text
git clone --local <repo> <clonePath>                          exitCode 0   durationMs 101
git -C clone checkout -b cowork/m2-p0-clone HEAD              exitCode 0
workspaces.create(clonePath) + sessionController.create({sessionId, workspaceId, agentPreset:'cowork-thread'})
  sessionId session-6b142578-…   headerCwd .../.dsh-cowork/threads/m2-p0-clone   cwdIsClone true
thread bash: printf > clone.txt && git add && git commit       hostSideLog "5d6def3 p0 clone probe"   hostSideStatus "(clean)"
clone/.git is a directory: true
```

`/tmp` 夹具里的合并链路：

```text
git fetch <clonePath> cowork/<id>:refs/heads/cowork/<id>   exitCode 0   主仓出现该分支
git merge --no-ff cowork/<id> -m ...                       exitCode 0   merge commit
git branch -d cowork/<id> + rm -rf clone                   exitCode 0 / 0
冲突：merge exit 1，conflictFiles ["a.txt"]，merge --abort exit 0
thread 在 clone 内 fetch 主分支 + merge + 解决 + 提交        exitCode 0
master 重试 fetch + merge --no-ff                           exitCode 0   resolved 内容合入，主分支 3 个提交
```

**代价与约束**（`P0_8.costs_and_constraints`）

- clone 成本：本仓库 `--local` 约 101 ms（对象硬链接），磁盘约为 tracked 工作树；
- clone 只含已提交文件：`node_modules`、ignored 文件、`.dsh-cowork` 都不在 clone 里，thread 需要依赖时得自己安装；
- thread 读不到主仓库工作区（沙箱根 = clone），master 侧审查用 `git -C <clone>` 或 fetch 后看；
- 清理必须带路径守卫：只删 `<repo>/.dsh-cowork/threads/<threadId>` 与分支 `cowork/<threadId>`。

**结论**：F 同时满足「强制隔离」与「thread 自己能提交」，合并命令与 worktree 流程只多一步 `fetch`。**用户已确认采用 F 方案**；它不是全权限环境下的唯一解，而是在 workspace-write 下成立的解。

## 6. 显式 sessionId 与路径规范化（`P0_6_explicit_session_id`）

**原始输出（摘录）**

```text
sessionController.create({sessionId:'session-95e66f7a-…', workspaceId})   returned session-95e66f7a-…   match true
inspect(header): id session-95e66f7a-…, cwd /private/tmp/cowork-p0-explicitid
repeat create with the same id + workspaceId                            returned session-95e66f7a-…   adopt true
```

**结论**：顺序 `生成 threadId → git clone/checkout -b cowork/<threadId> → workspace.create → session.create({sessionId, workspaceId})` 成立；重复创建同 id 是幂等采用。宿主会把 cwd 规范化（`/tmp` → `/private/tmp`），索引必须存规范化后的 clone 路径，否则 workspace 匹配与清理会落空。

## 7. 侧栏可见性与清理（`P0_5_sidebar_and_cleanup`）

**代码事实**：侧栏会话树只包含 `workspace.sessionIds` 的成员（`navigation.ts:184-185`）；`workspaceRegistry.delete` 只删 workspace 记录、不删会话（`packages/workspace/workspace/src/index.ts:309`）。

**原始输出（摘录）**

```text
workspaces.delete(probeWorkspace)              deleted true
workspaceRegistry.archiveSession(probeSession) ok true
git worktree remove --force + branch -D + prune  exitCodes [0,0,0]
final: workspaceCount 10；git worktree list 只剩主工作区；worktreesDir []
```

**结论**：合并后删 workspace 会把 thread 从侧栏移走（会话日志仍在存储里，可用 `archiveSession` 归档）；这是可逆的清理路径。

## 未验证 / 限制

- 跨 thread 的记忆可见性在 P0 阶段没有端到端跑（当时没有 memory 模块）；seam 证明止于 assembly，模型可见的一轮由 M2 E2E 补（[M2 结果](M2_RESULT.md)）。
- 侧栏真实 DOM 未截取：只到 `sessionController.list` 与 `workspace.sessionIds` 数据层。
- 宿主重启 / 恢复后的 worktree workspace 行为、preset 记忆注册未验证。
- 并发记忆写与锁竞争未验证。
- agent 作用域的 section 在插件热重载后是否残留旧注册未独立验证；实现必须自己跟踪 disposer（`src/memory-prompt.ts`）。
- 探针创建过 4 个临时会话并已归档、workspace 记录已删；仓库文件未改动，探针结束时 `git status` 干净（`P0_RESULT.json.side_effects`）。
