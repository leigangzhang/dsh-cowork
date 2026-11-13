# M0 API 探针结果

- 结论：PLAN §3.2 的五项风险全部通过，证据来自真实宿主运行而非只在源码里核对；其中第 4 项的方案假设被实测推翻（见 §4）。
- 宿主：DSH Desktop 2.0.18（`Contents/Info.plist` 与 `app/package.json` 均为 2.0.18），运行时包 0.2.1-rc.2，web profile `http://127.0.0.1:3080`。
- 插件：`@dsh-external/dsh-cowork`（host-only；`dev_inject_plugin` 热注入）。
- 引用运行：`run-80e3683b-fd76-42a0-a08b-96a9d3206698`，6 个阶段全 `passed`，创建 5 个会话（两个 store reader）。
- 持久化：每次运行结束写 `.dsh-cowork/probe/last-run.json` 与 `.dsh-cowork/probe/runs/<runId>.json`；`/status?runId=` 在宿主重载后仍可按文件回读（旧 `run-6b5498b5-…` 已实测 200）。
- 复跑：`curl -sS -X POST http://127.0.0.1:3080/dsh-cowork/probe/run`，再轮询 `GET /dsh-cowork/probe/status?runId=<id>`；下文“原始输出”均为该接口 `phases[].evidence` 的原文摘录。

## 1. `session.prompt` 唤醒 idle 会话（§3.2-1）

**结论：通过。** 同一会话在 idle 后连续两轮 `queue` prompt，各自出现 `turn/start` 与 `turn/end(reason=completed)`，两轮 assistant 文本都是 `COWORK_PROBE_WAKE_OK`。

**证据命令**：`curl -sS 'http://127.0.0.1:3080/dsh-cowork/probe/status?runId=run-80e3683b-fd76-42a0-a08b-96a9d3206698'`

**原始输出（摘录）**（`phases[id=wake].evidence`）：

```json
{"sessionId":"session-34817d4b-0021-4485-9da6-6e5afc5b6eb2",
 "rounds":[{"turn":1,"start":5,"end":23,"reason":"completed","text":"COWORK_PROBE_WAKE_OK"},
           {"turn":2,"start":25,"end":32,"reason":"completed","text":"COWORK_PROBE_WAKE_OK"}]}
```

**限制**：两轮之间以 `turn/end` 作为 idle 边界，事件来自 `ctx.on('session/event')`；单轮上限 `promptTimeoutMs=120000`。

## 2. `session.create` 的侧栏可见性（§3.2-2）

**结论：通过（数据层）。** `sessionController.list` 返回该行（`running=false`、`cwd` 等于仓库路径），`workspaceRegistry` 的 `sessionIds` 含该会话；这正是侧栏行的两个数据源。真实 UI 渲染未验证。

**原始输出（摘录）**（`phases[id=visibility].evidence`）：

```json
{"sessionId":"session-34817d4b-0021-4485-9da6-6e5afc5b6eb2","workspaceId":"70ec5443-a9e2-4368-9cce-ae06d9babb9e",
 "listed":true,"running":false,"blank":false,"cwd":"/Users/ray/Workspace/dsh-cowork",
 "workspacePath":"/Users/ray/Workspace/dsh-cowork","attached":true,"workspaceSessionCount":25}
```

**限制**：只证明 API/持久化层，未截取浏览器侧栏 DOM；`list` 的过滤受 `remoteAccess` 影响。

## 3. preset 运行时注册与选择（§3.2-3）

**结论：通过。** `apply` 中 `ctx.agentPresets.register({id:'cowork-probe', plugins:[]})` 成功；`list()` 含它；`create({agentPreset:'cowork-probe'})` 的返回值与会话 header 都记录为 `cowork-probe`。

**原始输出（摘录）**（`phases[id=preset].evidence`）：

```json
{"presetId":"cowork-probe","registered":true,"broken":null,
 "presetIds":["standard","ptc","minimal","cordis","router-standard","cowork-probe"],
 "sessionId":"session-0e6cc5fd-51b4-4e86-a818-07a91947d43d","createReturnedPreset":"cowork-probe",
 "headerPreset":"cowork-probe","headerCwd":"/Users/ray/Workspace/dsh-cowork"}
```

**限制**：空 `plugins` 的 preset 可注册、可被选中；preset 内容（persona/工具）属 M1，不在 M0 验证。

## 4. worktree 路径可写（§3.2-4）

**结论：通过；方案假设被实测推翻。** DSH Desktop 2.0.18（核心 0.2.1-rc.2）**没有 `allowedRoots`**（`grep -rn allowedRoots packages apps` 0 命中）；可写根是会话 `cwd`（`sandbox-policy` 以 `session.header.cwd` 为 `workspaceRoot`，`writableRoots` 见 `/Users/ray/Workspace/deepseek-harness/packages/sandbox/sandbox/src/roots.ts:52`，再加 `/tmp` 与 `os.tmpdir()`）。`create({cwd:worktree})` 的普通会话读到 `marker.txt` 并写出 `out.txt`；`git worktree list` 前后对照如下，跑完已清理。

**原始输出**（`phases[id=worktree].evidence` 摘录）：

```text
before:    worktree /Users/ray/Workspace/dsh-cowork | branch refs/heads/main
afterAdd:  worktree /Users/ray/Workspace/dsh-cowork
           worktree /Users/ray/Workspace/dsh-cowork/.dsh-cowork/worktrees/probe | branch refs/heads/cowork/probe-m0
reply:     marker.txt 的精确内容 … 已原样写入 out.txt（cmp 退出码 0）
sessionCwd: /Users/ray/Workspace/dsh-cowork/.dsh-cowork/worktrees/probe（header.cwd 断言通过）
outFile:   out.txt 内容 = COWORK_PROBE_WORKTREE_OK（outFileWroteMarker=true）
cleanup:   git worktree remove --force + branch -D cowork/probe-m0（worktree list 恢复只剩主工作区）
```

**限制**：worktree 会话用 `cwd` 创建、未 attach workspace（不需要）；该会话记录保留，其 cwd 已被清理，父目录 `.dsh-cowork/worktrees/` 为空目录保留。

## 5. `patchReload` 与重启（§3.2-5）

**结论：** 方案假设「patchReload=None 的热重载限制」被实测推翻——web profile 的 `cordis.patch.yml` 没有 `patchReload`（死配置），宿主运行时也没有该键；热重载能力由 `dsh-hmr` 提供（已安装，但不在 profile bundles 中）。`dev_inject_plugin` 注入后立即 `GET /health` 200（**无需重启**）；正式安装（写 profile `package.json`/bundles 的 `plugin_manager install_bundle` 或 `dsh plugin add`）在下次启动才装配——两者不是同一条通道。

**证据命令与输出**（`<app>` = `/Applications/DSH Desktop 2.app/Contents/Resources/app`）：

```text
$ grep -c patchReload /Users/ray/.dsh/profiles/web/cordis.patch.yml
0
$ grep -rn patchReload "<app>/lib" "<app>/cordis.patch.yml"
(no output)
$ grep -c '@deepseek-ai/dsh-hmr' /Users/ray/.dsh/profiles/web/package.json
0
$ ls -d "<app>/node_modules/@deepseek-ai/dsh-hmr"
<app>/node_modules/@deepseek-ai/dsh-hmr
$ curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/dsh-cowork/probe/health
200（注入后免重启，未重启宿主）
```

**限制**：仅 web profile 实测；desktop profile 与未来版本可能不同。

## 原子 store（M0 验收 4）

**结论：通过。** 插件用 `@deepseek-ai/dsh-atomic-write` 的 `withFileLock` + `writeFileAtomic`（随机后缀临时文件、同目录 rename），随后 `fsync` 父目录；随后新建**两个**普通会话，分别被 prompt 读取同一文件并回复 token（写者是宿主进程，不是会话）；目录里没有 `.tmp` 残留，文件模式 `0600`。

**原始输出（摘录）**（`phases[id=store].evidence`）：

```json
{"storePath":"/Users/ray/Workspace/dsh-cowork/.dsh-cowork/probe/store.json",
 "token":"COWORK_PROBE_STORE_335478c8","storeReadBack":true,"tempSiblings":[],
 "readers":[{"sessionId":"session-e67955ea-4420-47cc-a9cb-a5f19f328dbc","round":{"turn":1,"reason":"completed","text":"…335478c8"}},
            {"sessionId":"session-fdb2d530-2930-45d5-9b68-543ce5d07cbb","round":{"turn":1,"reason":"completed","text":"…335478c8"}}],
 "replyContainsToken":true}
```

**限制**：`writeFileAtomic` 自身不 fsync（源码注明 crash durability 不在范围内），目录 fsync 由探针补；跨主机共享文件不在支持范围。

## 构建与注入

- `npm run typecheck` / `npm run build` 均 exit 0，无需调用者设置 `DSH_CHECKOUT`：`scripts/build.sh` 自动探测 DSH 源码 checkout（类型）与已安装 app（运行时），链接进 `node_modules`（`--no-emit` 供 typecheck 复用）。构建类型来自 checkout 0.2.0-rc.2、运行时来自 app 0.2.1-rc.2，二者小版本漂移未展开。
- client 半边在 M0 移除（`src/client/`、`tsdown.config.ts`、`dsh.client` 一并删除）：其调用点用的是已移除的 `SlotsService`/`slot.inject` API，属 M3 重写范围。
- 注入：`dev_inject_plugin /Users/ray/Workspace/dsh-cowork` → `host ✓`；对外可核证据是 health 200 与 `buildTag`（fiber 状态只能由注入器工具面读取，验证者无该工具）。清理命令（留到验证之后）：`dev_uninject_plugin dsh-cowork`。

## 未验证 / 限制

- 侧栏真实 DOM 渲染未验证（只到 `session.list` + `workspace.sessionIds` 数据层）。
- 探针创建的 5 个会话保留在会话存储中作为证据，未删除。
- 旧 `run-6b5498b5-…` 的 JSON 是 t4 实时抓取、t7 收尾时补存到 `runs/`，仅用于让旧命令可重跑；本次引用运行由路由自动持久化。
