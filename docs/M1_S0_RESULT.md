# M1 S0 探针结果

- 结论：三个 S0 问题都有真实宿主证据。空 `plugins` preset 能完成一轮，但只能看到 profile 级全局工具，没有 bash/fs 等 preset-scoped 工具，因此不能直接当作 thread；`standard` 的 `plugins` 只能以 YAML 文本读到，结构化数组不可得；`exec.agent` 在 standard 与空 preset 两种组合下都可用。
- 阅读顺序：[M1 交接](M1_HANDOFF.md) 的“第一步：S0 探针”；契约见 [M1 提案](../.agents/notes/proposed/feature/2026-11-05-m1-master-thread-loop.md)。
- 宿主：DSH Desktop 2.0.18 / 运行时 0.2.1-rc.2，web profile `http://127.0.0.1:3080`，仓库 workspaceId `70ec5443-a9e2-4368-9cce-ae06d9babb9e`。
- 引用运行：`s0-90864021-c5e9-421f-97b3-2d436ad7e482`，4 个阶段全 `passed`，创建 4 个会话。
- 运行方式：`POST /dsh-cowork/probe/s0`，再 `GET /dsh-cowork/probe/s0-status?runId=<id>` 轮询；运行结束把 `last-s0-run.json` 与 `s0-runs/<runId>.json` 写入 `.dsh-cowork/probe/`（已 gitignore）。下文“原始输出”均摘自该接口的 `phases[].evidence`。

## 1. 空 `plugins` preset：能跑一轮，但没有 thread 需要的工具

**问题 (a) 能完成一轮：能。** `create({workspaceId, agentPreset:'cowork-probe'})` 的会话 `session-cadf086a-8351-4306-86a6-844e6eee9331` 跑完一轮，`turn 1`、`turn/end reason=completed`（`startSeq=4`、`endSeq=19`），assistant 首行是 `COWORK_PROBE_PRESET_OK`；create 返回值与会话 header 都记录 `cowork-probe`。

**问题 (b) 实际能看到哪些工具：只有全局工具。** 会话自报的工具清单共 46 项，全部是 profile 级（全局注册）工具：

```text
agent_teams_* / code_review_* / cowork_* / dev_* / working_directory / worktree_*
（原始逐行清单在 phases[empty-turn].evidence.round.text；这里不复制整份目录）
```

清单里没有 `bash`、`read`、`write`、`edit`、`glob`、`grep` 等 preset-scoped 工具，`round.toolCalls` 为空——模型只是把工具名念了出来，没有可调用的文件能力。这与部署事实一致：这些工具挂在 preset 的 `plugins` 行里，而空 preset 一行都没有。

**影响：** `cowork-thread` 不能使用空 `plugins` preset；必须显式声明工具行。

## 2. 克隆 `standard`：结构化 `plugins` 不可得，只能拿到 YAML 文本

- `agentPresets.resolve('standard')` 返回 `{"id":"standard"}`，没有 `plugins` 字段；`list()` 的每行只有 `id/order/name/description`，`hasPluginsProperty=false`。
- `agentPresets.readDocument('standard')` 返回 `{agentPreset:'standard', content:'…'}`：`content` 是 5310 字节的 YAML 文本，首行 `- id: persona`，含 `disabled: !!js process.platform === 'win32'` 这类 Loader 方言表达式；`contentHasJsExpressions=true`。没有任何结构化数组字段。
- `agentPresets.compositionInventory()` 只给每行的 `entryId/moduleName/enabled`（如 `tool-pwsh` 在 macOS 上 `enabled=false`），不含 `config`。

**结论：** 结构化 `plugins` 拿不到；YAML 文本要变成可注册数组需要重新引入 Loader 的 `!!js` 解析（js-yaml + include 方言），M1 不做。按提案退回“显式声明完整 preset 行”。M1 在**运行时注册显式行**（不改 profile patch，不污染用户环境），M4 再把同一份行迁到 bundle patch。

**显式行可用的证据：** 探针注册了只含 `persona + agent-instructions + tool-bash + tool-fs + tool-fs-search` 的 `cowork-thread-s0`，`list()` 中 `broken=null`；用它创建的会话 `session-96d03cd3-ff84-4df2-9c3c-418308a32c22`（`headerPreset=cowork-thread-s0`）实际调用 `read` 工具读取 `package.json`，回复 `THREAD_TOOLS_OK @dsh-external/dsh-cowork`（`turn 1`，`startSeq=4`，`endSeq=26`，`toolCalls=[read]`）。

## 3. 调用者身份：`exec.agent` 在两种 preset 组合下都可用

临时工具 `cowork_identity_probe` 分别在 standard preset 会话（模拟 master）与空 preset 会话（模拟 thread）中各调用一次：

```json
{"token":"master","agentId":"session-67611699-597c-472e-9d7d-e5ee09825027",
 "cwd":"/Users/ray/Workspace/dsh-cowork","agentPreset":"standard",
 "execKeys":["agent","arguments","callId","concludeTurn","deferContext","name","rootCallId","signal","token"],
 "hasAgent":true}
{"token":"thread","agentId":"session-4003e69c-ba5e-43ba-87f5-b0260d559573",
 "cwd":"/Users/ray/Workspace/dsh-cowork","agentPreset":"cowork-probe",
 "execKeys":["agent","arguments","callId","concludeTurn","deferContext","name","rootCallId","signal","token"],
 "hasAgent":true}
```

两例的 `exec.agent.id` 等于会话 id，`exec.agent.session.header.cwd` 等于 workspace path；`exec` 上还有 `concludeTurn/deferContext`。**结论：** 项目发现用 `exec.agent.id` + `exec.agent.session.header.cwd`；`exec.agent` 缺失时 fail closed。master 身份必须来自索引登记（init 的调用会话），不能只凭 preset id 推断。

## 对 M1 实现的影响

1. `cowork-master` / `cowork-thread` 都用显式行注册；M1 只挑选 thread 工作所需的最小集（persona、agent-instructions、time-context、bash、fs、fs-search、jobs、ask-user、todo、present），不复制 standard 的 planning/compaction/delegation/web 组。
2. 角色边界以工具内校验为主：thread 只能为自己的 `threadId` handoff，master 才能 init/route/thread_create；`ctx.tools.restrict` 只在 `agent.ctx` 上可用，M1 没有 preset-scoped 插件模块去调用它，因此**不硬限制 master 的写工具**，文档如实写明。
3. 扁平化后的显式行清单可用于 M4 的 bundle patch；M1 不解析 `readDocument` 的 YAML。
4. S0 的“模拟 master”用的是 standard preset；真实 `cowork-master` 的 E2E 在 S5 之后用注册的 preset 重跑（提案 A1–A4）。

## 未验证 / 限制

- 侧栏 UI 渲染未验证（只到 `session.list` 与 `workspace.sessionIds` 数据层，与 M0 相同）。
- `exec.agent` 在 PTC `run_code` 内层 dispatch 路径未单独验证；模型直接调用工具的路径已证。
- 空 preset 的 46 项工具清单与当前 web profile 的全局配置绑定，换 profile 可能不同。
- S0 探针代码与 `cowork_identity_probe` 工具是临时证据设施，M1 收口时应移除（见提案“不在 M1”与交接“未决问题 6”）。
