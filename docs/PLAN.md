# dsh-cowork 产品与实现方案

- 文档状态：已冻结，用于交接 DSH 创造模式开发
- 更新日期：2026-11-04
- 仓库：`/Users/ray/Workspace/dsh-cowork`
- 目标宿主：DeepSeek Harness `0.2.x`（本机 DSH Desktop 2.0.13，核心包以桌面端实际安装为准）
- 目标 profile：先 `web` 验证，再适配 `desktop`

---

## 1. 项目背景

### 1.1 问题

DSH 单会话长跑会出现：任务失焦、上下文退化导致推理质量下降、输出过简（语义压缩）或过冗长。Cloud Cowork 的项目模式给出了一个有效形态：项目级记忆 + 一个 master 主会话 + 多个持久 discussion thread，用户可直接进入任意 thread 对话，thread 完成/调整后向 master 汇报。

现有 DSH 生态的不足：

- AgentTeams 的 teammate 是 spawn/fork 子 Agent，用户不能在 GUI 里作为普通会话直接打开、继续对话；
- OpenViking 的召回默认偏全局，项目级隔离需要额外 peer 配置；
- 现有协作插件各覆盖一块，没有单一插件/单 profile 提供完整闭环；
- 多个协作插件并存会抢 `sessionController`、`workspaceRegistry`、子代理池，产生多主控面冲突。

### 1.2 目标

做一个单插件 `dsh-cowork`，一次安装、一个 profile 内生效，提供：

1. 每个项目一个 `master` 主会话（路由、决策、验收）；
2. 每个 Future/特性一个 `thread` 会话（普通 DSH 会话，用户可直接打开）；
3. 项目级记忆，物理隔离，不全局串；
4. master 把需求路由到最相关 thread，或新建 thread；
5. thread 完成/调整后向 master 结构化汇报；
6. thread 可落到独立的隔离 checkout（每 thread 一个本地 clone）；
7. 输出契约 + 独立 review 门禁；
8. 两个 agent preset（`cowork-master` / `cowork-thread`）；
9. 本地优先，不把项目上传到云。

### 1.3 非目标（MVP 不做）

- 不做多机/远端协作、公网访问；
- MVP 不做向量语义检索（M2 用本地关键词 + master 模型辅助路由）；去重与语义检索作为 M5 目标，见 §6；
- 不做定时后台无人值守（后续再接）；
- 不替换 DSH 官方 Plan Mode / Todo / Compaction，只在其上叠加；
- 不做复杂权限系统，继承 DSH 沙箱与审批。

---

## 2. 产品定义

### 2.1 角色

| 角色 | 载体 | 职责 |
|---|---|---|
| master | 普通会话 + `cowork-master` preset | 收需求、路由、记决策、验收、协调跨线程依赖 |
| thread | 普通会话 + `cowork-thread` preset | 只做本 Future：读 handoff、开发/测试、写 handoff、请求 review |
| reviewer | 普通会话或 AgentTeams review task | 独立复核产物与证据，给出 pass / needs_revision / reject |
| user | GUI | 可直接与 master 或任意 thread 对话 |

### 2.2 核心用户流程

#### 初始化项目

1. 用户在项目目录打开一个会话，选择 `cowork-master` preset；
2. 发一条消息或调用 `cowork_project_init`；
3. 插件在 `<repo>/.dsh-cowork/index.json` 建立项目索引，把当前会话登记为 master。

#### 路由与新建 thread

1. 用户在 master 中提出需求；
2. master 调用 `cowork_route(intent)`；
3. 插件读取项目索引 + 每个 thread 的 handoff 摘要，先做本地关键词打分，再让 master 模型在低置信时二次判断；
4. 命中：用 `sessionController.prompt` 把需求投递给该 thread；
5. 未命中：`sessionController.create({ workspaceId | cwd, sessionId?, agentPreset: 'cowork-thread' })` 新建 thread；`isolated` 时先 clone 再以 clone 建会话，写索引，注入初始 brief。

#### thread 工作与 handoff

1. thread 读项目记忆 + 自己的 handoff；
2. 用户可直接在 thread 中继续提要求；
3. 完成或阻塞时 thread 调用 `cowork_handoff`；
4. 插件把结构化 handoff 写入 `.dsh-cowork/handoffs/`，并 `sessionController.prompt` 投递到 master；
5. master 读 handoff，需要 review 时创建独立 review 会话。

#### 验收

1. reviewer 读 handoff 与真实产物，运行验证命令；
2. 输出 verdict + findings；
3. pass → master 把 thread 标记 done，更新项目记忆；needs_revision → 退回原 thread 修复。

### 2.3 thread 状态机

```
new → active → awaiting_review → done
              ↘ blocked → active（解除后）
              ↘ archived（用户手动归档）
```

状态记录在 `index.json` 的 thread 记录里，UI 用徽章展示。

---

## 3. 技术调研结论

### 3.1 关键 API（已本地核验）

本机桌面端包路径：
`/Applications/DSH Desktop 2.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js`

已确认存在：

- `sessionController.create({ workspaceId | cwd, sessionId?, agentPreset? }) → { sessionId, agentPreset? }`；
- `sessionController.prompt({ sessionId, mode: 'queue' | 'steer', content, requestId? }) → { accepted }`：实现里 `resolveAgent` 后调用 `agent.followup` / `agent.steer`，具备唤醒冷会话的实现基础；
- `sessionController.rename / selectModel / cancel`；
- `workspaceRegistry`：`resolveByPath / get / list / attachSession / archivedSessionIds`；
- `ctx.slots.inject / ctx.slots.register`（客户端 UI）；
- preset 注册面：DSH 0.1.7+ 的 `@deepseek-ai/dsh-agent-preset` 走 profile patch 声明行；插件内动态注册需在探针阶段确认 `ctx.agentPresets.register` 的当前签名。

### 3.2 仍需端到端验证（M0 必须回答）

1. `session.prompt` 是否真的唤醒 idle 会话并跑一轮；
2. `session.create` 出的会话是否立即出现在侧栏并挂到 workspace；
3. preset 注册后，新建会话是否可选且 `agentPreset` 是否生效；
4. worktree 路径是否在 DSH 允许根内（M0 实测：宿主没有 `allowedRoots`，可写根是会话 cwd + 临时目录；见 [M0 结果](M0_PROBE_RESULT.md) §4）；
5. web profile `patchReload=None` 的热重载限制。

### 3.3 现有插件调研结论（摘要）

| 插件 | 可借鉴 | 不整包依赖的原因 |
|---|---|---|
| `LittleAlety/dsh-team-conductor` | `session` 引擎把成员建为普通会话、sidecar 名册、任务板 CAS、完成→审议、上下文压力 | 无 npm、面向 `0.2.0-rc.2`、81KB 大而全 |
| `00080000/dsh-project-memory` | 项目级 `.dsh-project-memory/`、TaskBridge、path:line 证据、经验笔记 | 只做记忆，不管理会话 |
| `kenz1117/dsh-engram` | 按 git origin 分项目、SQLite + FTS5/向量、证据门 | 需要本地向量/较重；MVP 先不用 |
| `Letter2025/dsh-task-worktree` | per-repo manifest、首条消息建 worktree、统一分支前缀 | 只做 worktree |
| `HeathHe/dsh-worktree-panel` | 项目→worktree→会话 侧栏层级 | 0.1.x pin，需 fork 才能 0.2.x |
| `alex04130/dsh-forge` | 跨会话邮箱、wake 限速、teamhub | 15 个 host 插件过重，与 dsh-cowork 主控面冲突 |
| `jax629321/dsh-agent-hub` | 群聊式决策/验收/群记忆 | 自带 Python 后端，成员不是 DSH 原生会话 |
| `zenghaili0901/dsh-bot-mode` | Bot 浮窗直接对话 | 验证性项目，无任务板/项目记忆/路由 |

结论：**只取“已验证的 API 用法和工程模式”，不把任何第三方协作插件作为运行时依赖**。记忆以“适配器接口”预留，checkout 用自研轻量实现。

---

## 4. 总体架构

### 4.1 单插件形态

`dsh-cowork` 是一个 bundle patch 插件：

- host 半边注册 `CoworkService`，注入 `cowork_*` 工具、system prompt 段、回环 HTTP 路由；
- 客户端半边注册侧栏项目面板（`ctx.slots.inject`）；
- 包内附带两个 preset 声明（`cowork-master` / `cowork-thread`），如宿主 preset 机制不支持包内声明，则改为 profile patch 声明行。

### 4.2 模块图

```
dsh-cowork/
├── package.json            # dsh.bundle.patch + dsh.client + engines
├── cordis.patch.yml        # insert: dsh-cowork
├── presets/
│   ├── cowork-master.yml
│   └── cowork-thread.yml
├── src/
│   ├── index.ts            # 装配：注册 service/tools/presets/routes
│   ├── session-slice.ts    # sessionController 薄封装（create/prompt/rename/selectModel/cancel）
│   ├── store.ts            # .dsh-cowork 索引/handoff 原子读写
│   ├── router.ts           # 关键词打分 + 模型辅助路由
│   ├── handoff.ts          # handoff 结构校验与投递
│   ├── memory.ts           # 项目记忆读写（默认 markdown 文件）
│   ├── memory-prompt.ts    # 记忆块注入 agent 作用域的 system prompt
│   ├── checkout.ts         # git CLI thread checkout 适配器（本地 clone）
│   ├── review.ts           # review 会话生命周期
│   ├── tools.ts            # cowork_* 工具定义
│   ├── routes.ts           # loopback HTTP API（/dsh-cowork/*）
│   └── client.ts           # 客户端面板
├── test/
│   ├── store.test.ts
│   ├── router.test.ts
│   └── handoff.test.ts
└── docs/
```

### 4.3 数据模型

项目根：`<repo>/.dsh-cowork/`（默认 `.gitignore` 忽略，可配置为 `$DSH_HOME/dsh-cowork/projects/<projectHash>/`）。

`index.json`：

```json
{
  "version": 1,
  "projectId": "github.com-leigangzhang-dsh-cowork",
  "masterSessionId": "session-...",
  "createdAt": "2026-11-04T00:00:00Z",
  "threads": [
    {
      "threadId": "session-...",
      "subject": "下载队列重构",
      "status": "active",
      "cwd": "/Users/ray/Workspace/dsh-cowork",
      "checkoutPath": null,
      "createdAt": "2026-11-04T00:00:00Z",
      "updatedAt": "2026-11-04T00:00:00Z",
      "lastHandoffAt": "2026-11-04T00:00:00Z"
    }
  ]
}
```

`handoffs/<threadId>-<timestamp>.json`：

```json
{
  "version": 1,
  "threadId": "session-...",
  "masterSessionId": "session-...",
  "status": "awaiting_review",
  "subject": "下载队列重构",
  "summary": "完成...",
  "decisions": ["采用...", "否决..."],
  "changedPaths": ["src/download.ts"],
  "artifacts": ["docs/下载队列重构.md"],
  "verification": [
    {"command": "pnpm test", "exitCode": 0, "evidence": "120 passed"}
  ],
  "openIssues": ["需要确认..."],
  "nextStep": "review 后合并到 main"
}
```

`memory/`：

- `memory/constraints.md`：硬约束与用户反复纠正；
- `memory/decisions.md`：已确认决策（含变更历史）；
- `memory/facts.md`：项目事实、统计口径、精确数字；
- 每项必须带来源：`(来源: thread X / user Y / 文件:行)`。

---

## 5. 详细设计

### 5.1 session-slice

封装 DSH 会话服务，只允许：

- `createThread({cwd, subject})`：`sessionController.create` + `rename` 标题为 `cowork: <subject>`；
- `promptThread(threadId, content)`：`sessionController.prompt`，`mode: 'queue'`；
- `promptMaster(projectId, content)`：投递结构化 handoff；
- `ensureSession(sessionId)`：查询/恢复冷会话。

### 5.2 store

- 所有写操作用 `tmp + rename` 原子替换；
- 同目录文件锁（`.write.lock`）保护并发；
- `index.json` 与单个 thread/handoff 文件分离，避免大文件整写；
- 提供 `readProject / writeThread / appendHandoff / listHandoffs`。

### 5.3 router

输入：master 会话 id + 用户需求文本。

```
score = title/subject 命中 * 3
      + keywords 命中 * 2
      + status 惩罚（done/archived 排除，blocked -1）
      + 最近活跃时间衰减
```

- 本地 score 最高且 ≥ 阈值 → 命中；
- 否则将「索引 + 最近 handoff 摘要」交给 master 模型辅助选择；
- 模型仍判断无相关 → 创建新 thread。

MVP 阈值可配置，默认先保守：命中优先，避免错误复用。

### 5.4 handoff

- `cowork_handoff` 工具由 thread 调用；
- 校验必填字段：`status / summary / verification`；
- 写 handoff 文件 → 更新索引 → `promptMaster`；
- 投递失败只记录，不丢 handoff 文件；master 下次 `cowork_project_status` 时可重放。

### 5.5 memory

- 文件实现：`<repo>/.dsh-cowork/memory/{constraints,decisions,facts}.md`，每条一个 `## ` 块，正文后接 `(来源: …; ISO 时间)`。
- 注入机制：插件在 agent 作用域注册 system prompt 段落 `cowork:memory`（order 900、`interpolate:false`）；`text` 是函数，每次 prompt assembly 重新读取三个文件。只对 `agentPreset` 为 `cowork-master` / `cowork-thread`、且 cwd 向上能找到 `.dsh-cowork/index.json` 的 agent 注册；段落只在该 agent 的 assembly 可见。
- 预算：默认 3000 tokens（`ceil(chars/4)` 估算），按 constraints → decisions → facts 整条拼接，超出即停止并追加 `[memory truncated]`。digest 不变时复用上次文本，写入新记忆后下一次 assembly 即重新求值读取。
- 写入与检索：`cowork_memory_write` 追加一条带来源的记忆（单条正文 ≤8000 字符，目录锁 + 原子替换，损坏文件带行号报错且不改写）；`cowork_memory_search` 用与 router 相同的 `tokenize`（ASCII 词 + CJK bigram）打分，limit 默认 5、上限 20。
- 生命周期：agent 创建时注册、插件卸载时释放 section disposer；同名重复注册只计数并记录，不影响其他 agent。
- 适配器接口：`recall(projectId, query, budget) / save(projectId, entry)`；后续适配器：`dsh-project-memory`、`dsh-engram`、OpenViking peer。
- 整理与检索（M5 目标）：去重/合并/更新/删除、按相关性装填预算、可选的语义检索（放在上面的适配器 seam 后）；M2 的追加式关键词实现是兼容基线，见 §6 M5。

### 5.6 thread checkout（每 thread 本地 clone）

隔离实现采用 **F 方案：每个 thread 一个本地 clone**，经用户确认；不用 `git worktree`。MVP 直接用 `git` CLI，不依赖第三方 worktree 插件：

- 路径 `<repo>/.dsh-cowork/threads/<threadId>`，分支 `cowork/<threadId>`；`cowork_route` / `cowork_thread_create` 传 `isolated: true` 时才创建，M1 行为保持。
- 创建顺序：生成 `threadId` → `git clone --local <repo> <clone>` → `git checkout -b cowork/<threadId>` → `workspace.create(clone)` → `session.create({sessionId, workspaceId, agentPreset})`；thread 会话 cwd 就是 clone 路径，因此 `.git` 在会话沙箱根内，thread 可以自己 `git add/commit`。
- 索引：thread 记录字段 `checkoutPath` 是唯一事实源，存宿主规范化后的 clone 路径；任一步失败补偿删除索引记录、clone 与本次创建的 workspace。
- master 独占合并 `cowork_checkout_merge`：前置 thread 状态 ∈ `{awaiting_review, done}` 且 clone `git status --porcelain` 为空（含 untracked）；执行 `git fetch <clone> +refs/heads/cowork/<id>:refs/heads/cowork/<id>`，再 `git merge --no-ff`。
- 成功 teardown 顺序（`cowork_checkout_merge`）：`workspaceRegistry.resolveByPath(checkoutPath)` 取到 clone 对应的 workspace → `removeCheckout` 删 clone 与分支 → `deleteWorkspace` → `archiveSession(threadId)` → 最后写索引 `checkoutPath=null`、`status='done'`。**`resolveByPath` 必须排在 `removeCheckout` 之前**：宿主先把路径 realpath 规范化再按路径匹配 workspace（`/tmp` → `/private/tmp`，[M2-P0 结果](M2_PROBE_RESULT.md) §6），clone 目录不存在就匹配不到——删完 clone 再查只会拿到 `undefined`，workspace 永久残留。索引最后写且无条件执行：merge 已经落地，teardown 各步失败只记录到 `cleanupErrors`，不回滚索引、也不把已完成的 merge 改报为失败。merge 失败时保留现场并返回稳定错误码。
- 冲突：`git merge --abort`、保留 clone 与分支、索引置 `blocked` 并返回冲突文件；thread 在 clone 内 fetch 主分支、解决并提交后重新 handoff，master 重试成功。
- 为什么不是 `git worktree`：linked worktree 的 git 元数据在 `<repo>/.git/worktrees/`，位于 thread 会话 cwd 之外；workspace-write 策略下 thread 侧 `git add/commit` 被沙箱拒绝（`index.lock: Operation not permitted`，exitCode 128）。workspace-write 是插件必须支持的最小权限，`danger-full-access` 下 worktree 也许可用，但 F 不依赖全权限（[M2-P0 结果](M2_PROBE_RESULT.md) §4–§5）。

### 5.7 review

- `cowork_review_request(threadId)`：master 或本项目 thread 调用；要求 thread `awaiting_review`；建独立 `cowork-reviewer` 会话（cwd 是主仓库，preset 校验 fail-closed，标题 `cowork review: <subject>`）；索引先写 `reviewStatus=pending` / `reviewerSessionId` / `reviewRequestedAt`，再投 review brief；prompt 失败回滚这三个字段并归档会话。
- `cowork_review_verdict(threadId, verdict, summary, findings?, verification?)`：只接受该 thread 索引里的 `reviewerSessionId`；master/thread 调用被显式拒绝（自审）；review 文件 `<repo>/.dsh-cowork/reviews/<threadId>-<stamp>.json` 先写，再写索引 `reviewStatus` / `reviewedAt` / `latestReviewPath`。
- verdict 路由：`pass → done`；`needs_revision → active` 并把 findings 投递给原 thread；`reject → blocked` 并投递；投递失败只进 `deliveryError`，不回滚 verdict。
- 合并前置：`cowork_checkout_merge` 默认要求 `reviewStatus=pass`；master 用 `allowUnreviewed:true` + 非空 `overrideReason` 显式覆盖，理由清洗后进合并提交信息与响应。
- `cowork-reviewer` preset 不挂 `tool-fs`（没有 read/write/edit），只给 bash + glob/grep；实现者不得自审（借 AgentTeams 语义，不引入其运行时）。

### 5.8 工具面

| 工具 | 谁可用 | 作用 |
|---|---|---|
| `cowork_project_init` | master | 初始化项目索引 |
| `cowork_project_status` | master/thread | 项目与线程概览，含各 thread checkout 摘要 |
| `cowork_route` | master | 路由需求到 thread；`isolated: true` 时建 clone |
| `cowork_thread_create` | master | 显式新建 thread；`isolated: true` 时建 clone |
| `cowork_thread_list` | master/thread | 列出 thread |
| `cowork_handoff` | thread | 结构化汇报 |
| `cowork_memory_search` | master/thread | 搜索项目记忆 |
| `cowork_memory_write` | master/thread | 写项目记忆 |
| `cowork_checkout_merge` | master | 合并 thread 分支并清理 clone/workspace/会话；默认要求 review pass，可显式覆盖 |
| `cowork_review_request` | master/thread | 为 `awaiting_review` 的 thread 建独立 review 会话并写 pending |
| `cowork_review_verdict` | 该 thread 的 review 会话 | 写 review 文件与索引，路由 pass/needs_revision/reject |

共 11 个工具；运行中另有 `cowork_probe` / `cowork_identity_probe` 两个探针工具，所以 `Tool.listTools` 能看到 13 个 `cowork_*`。

### 5.9 presets

- `cowork-master`：路由者 persona，只读项目代码为主，禁止直接改实现文件，负责索引/决策/验收；
- `cowork-thread`：feature owner persona，只做本 thread 范围，写代码前读 handoff，完成后必须 handoff；
- `cowork-reviewer`：独立 review persona，只读实现、实际运行验证命令、只调用一次 `cowork_review_verdict`；工具面只有 persona/agent-instructions/bash/搜索，没有 `tool-fs`。

---

## 6. 实现计划

### M0：API 探针（先做，决定架构风险）

范围：最小 host 插件 + 一个测试工具。

验收：

1. `sessionController.create({cwd, agentPreset})` 创建普通会话并在侧栏可见；
2. `sessionController.prompt` 唤醒 idle 会话；
3. preset 注册并可被新建会话选中；
4. `.dsh-cowork` 原子写可被两个会话读；
5. 输出 `M0_PROBE_RESULT.md`，记录每项 evidence 命令与结果。

### M1：MVP 主从闭环

范围：session-slice + store + router + handoff + 两个 preset + 工具。

验收（E2E）：

- 初始化项目 → 生成 `index.json` 且 master 正确；
- master 发需求 → 自动新建 thread 且出现在侧栏；
- 再次发相关需求 → 路由到已有 thread；
- thread 调 `cowork_handoff` → master 收到结构化 handoff；
- 无第三方协作插件参与。

### M2：项目记忆 + thread checkout（F 方案经用户确认）

验收：

- `cowork_memory_write/search` 跨 thread 生效；新建与已存在的 cowork agent 在其 system prompt 中看到预算内记忆块；
- `isolated: true` 的 thread 落到 `<repo>/.dsh-cowork/threads/<threadId>`、分支 `cowork/<threadId>`，索引记录 `checkoutPath`，thread 能在 clone 内提交；
- master 合并 thread 分支后主工作区没有该 thread 的未提交改动，clone 与分支被清理、索引 `checkoutPath=null`；
- 冲突场景保留 clone 与分支、索引状态为 `blocked`，解决后重试合并成功；脏 clone 被拒绝。

### M3：review 门禁 + 客户端面板

验收：

- 独立 review 会话产出 verdict；
- `needs_revision` 能退回原 thread；
- 侧栏显示项目 → thread 树、状态徽章、handoff 预览。

### M4：单插件打包与发布

方案与验证路径见 [M4 提案](../.agents/notes/proposed/feature/2026-11-05-m4-packaging.md) 与 [M4 交接](M4_HANDOFF.md)。

验收：

- 一个新 profile 只安装 `dsh-cowork` 一个包即可获得全部能力；
- `dsh plugin --profile web add <path or npm>` 后重启可用；
- README 含安装、使用、卸载、数据落点说明。

### M5：记忆整理与检索

目标（方案与评测口径在 M5 规划时再定）：

- 记忆可去重、合并、更新、删除，重复与过时约束不再无界累积；
- 注入按相关性而非固定文件顺序装填预算，预算内的条目可解释；
- 语义检索作为可选能力通过适配器接入，检索质量有可复现的评测集与指标；
- 与 M2 的追加式实现兼容：既有 `memory/*.md` 与工具行为是迁移基线。

---

## 7. 测试与验收总则

- 每个成功标准必须有一条可复现命令；
- 涉及跨会话、跨进程的改动必须跑真实 DSH E2E，不允许只跑单测；
- 插件不得读取/写入 `viking://`，不得上传项目源码，不得记录密钥；
- 所有 loopback 路由必须同源/回环校验；
- 卸载后除 `.dsh-cowork/` 项目数据外，不残留插件副作用。

---

## 8. 风险与决策记录

| 风险 | 等级 | 决策 |
|---|---|---|
| `session.prompt` 不唤醒 idle 会话 | 高 | M0 最先验证；失败则 handoff 退化为「投递 + UI 红点 + 用户点开」 |
| preset 包内动态注册不可用 | 中 | 回退 profile patch 声明行 |
| worktree 路径不在可写根 | 低 | M0 实测无 `allowedRoots`，可写根 = 会话 cwd + 临时目录；linked worktree 的 git 元数据在 cwd 外，thread 侧 git 写被拒（M2-P0）。隔离改用每 thread 本地 clone，见 §5.6 |
| 与 OpenViking 记忆双写 | 中 | dsh-cowork 默认只读自己的 `.dsh-cowork`，不接 OpenViking |
| 与 AgentTeams 并存 | 低 | dsh-cowork 不使用 AgentTeams 运行时；review 只借其语义 |
| 多项目共享一个 master | 高 | MVP 一项目一 master；多项目各自索引 |

---

## 9. 参考与许可

- [dsh-team-conductor](https://github.com/LittleAlety/dsh-team-conductor) — MIT，参考 session 引擎与任务板语义；
- [dsh-project-memory](https://github.com/00080000/dsh-project-memory) — MIT，参考项目记忆模型；
- [dsh-engram](https://github.com/kenz1117/dsh-engram) — 参考项目隔离与证据门；
- [dsh-task-worktree](https://github.com/Letter2025/dsh-task-worktree) — 参考 worktree manifest；
- [dsh-plugin-worktrees](https://github.com/.../) — 已装插件，作为 worktree 适配器的可选集成目标；
- DSH core: `/Applications/DSH Desktop 2.app/Contents/Resources/app/node_modules/@deepseek-ai/*`。

本插件采用 MIT 许可。借鉴第三方代码时必须保留原许可声明；不建议整文件复制协作插件实现，优先写自研实现或仅引用其 API 用法。

---

## 10. 交接给 DSH 创造模式的说明

1. 工作目录固定为 `/Users/ray/Workspace/dsh-cowork`；
2. 先读本文件与 `README.md`；
3. 从 M0 探针开始，不要跳步；
4. 每个里程碑完成后运行 E2E 并写 `docs/VERIFICATION.md`；
5. 使用中文写提交信息，遵循 Conventional Commits；
6. 不要修改 `~/.agents/AGENTS.md`、`~/.dsh` 下无关配置；
7. 不要上传源码到第三方仓库，除非用户明确授权；
8. 遇到 M0 的五个 API 验证点失败，停下来报告，不要绕过。
