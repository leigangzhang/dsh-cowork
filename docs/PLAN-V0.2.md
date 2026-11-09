# dsh-cowork PLAN-V0.2：主题会话模型重构方案

- 文档状态：V0.2，对应插件 `0.2.0`
- 更新日期：2026-11-07
- 仓库：`/Users/ray/Workspace/dsh-cowork`
- 目标宿主：DeepSeek Harness `0.2.x`（本机 DSH Desktop 2.0.13 实际安装为准）
- 目标 profile：先 `web` 验证，再适配 `desktop`
- 版本关系：
  - V0.1：`docs/PLAN.md`（M0–M4 已完成，保留不覆盖）
  - V0.2：本文件（M6–M12 主题会话模型重构）
  - M5：记忆整理与检索（保持原目标，不在本文件展开）
- 执行方式：本方案的 M6–M12 是独立执行单元；用户会先执行 M6–M12。每个阶段完成后停下，等确认后再进入下一阶段。本文件不表示任何阶段已执行。

---

## 1. 项目背景

### 1.1 问题

M4 的插件已经可以在真实宿主上安装运行，但两次真实使用暴露了四个结构性问题：

1. **主会话承担了流程。** 每次交接和每次评审结论都会 `prompt` master，并留下完整文本；`cowork_project_status` 一次返回整个索引、所有 checkout 和所有最新评审。主会话内容随事件数量增长。
2. **以任务为单位创建 thread。** 每个任务新建会话，重复加载 preset、项目记忆和代码；`done` 被路由硬排除，同主题续做只能新开。
3. **评审按交接触发。** 每个 `awaiting_review` 都新建一个冷启动会话读仓库；文档改动也一样；评审成功后会话不归档，侧栏持续累积。
4. **界面把 thread 和 reviewer 当普通会话平铺。** 两个使用 case 就留下 3 个主题会话、2 个评审会话；用户注意力被分散。

此外，当前实现与已经讨论确定的模型还有差距：状态是六态而不是三态；`done` 不可续做；已解决没有自动标记；路由是纯词法；并行执行没有隔离目录与合并串行的统一模型；master preset 仍带 `fs`/`bash`。

### 1.2 目标

1. **master 只做决定。** 项目级入口、优先级、例外决定（合并/发布/阻塞/跨主题冲突）、对用户汇报；不创建或转发评审，不读代码、不跑测试。
2. **插件推进流程。** 主题三态与标记、评审请求、reviewer 创建与回收、隔离目录、活动流、master 收件箱、路由、记忆文件都由插件负责。
3. **主题会话承载任务。** 一个主题一个 DSH 会话；内部可以有多个执行单元（子代理/AgentTeams）；主题写摘要和证据，自己提交评审请求。
4. **评审按请求。** 评审单位是一次评审请求定义的改动范围；每次新建 reviewer，用完回收；只看请求范围；不合并、不解决冲突。
5. **界面按主题组织。** 左侧栏只留 master；主题列表放右侧栏 CoWork tab；打开主题只切换主区；reviewer 不出现在列表。
6. **已解决可控。** 用户手动或 master 满足条件自动标记；空闲 3 天；不撤销；用户可手动重新打开。
7. **数据可迁移。** v1 索引、旧交接/评审文件保留；旧工具名和旧 preset 名保留一个版本的别名。

### 1.3 非目标

- 不做多项目共享一个 master；仍是一项目一 master。
- 不引入 AgentTeams 运行时依赖；只在文档和评审契约层面与其共存。
- 不解决 reviewer 的硬只读沙箱（KI-15 保留）；不新增自定义只读工具。
- 不做任意字段的动态评审请求；固定 schema + `extra` 扩展。
- 不做多段会话拆分（已讨论否决：重复加载与上下文传递不可控）。
- 不做语义记忆检索；记忆整理与检索留在 M5。
- 不自动解决合并冲突；不自动合并到 `main`。
- 不上传项目源码，不读写 `viking://`。

### 1.4 与 M0–M4 的关系

M0 已证明宿主 API 风险；M1 完成主从闭环；M2 完成项目记忆与 per-thread clone；M3 完成独立 review 与面板；M4 完成单插件打包、安装与卸载。本方案保留这些基础设施中的可用部分（store 的原子写与锁、clone 隔离、review 文件、面板 tab 注册、preset 注册），替换其中的 thread 中心模型、master 编排、评审触发和面板数据。

---

## 2. 产品定义

### 2.1 角色

| 角色 | 载体 | 职责 | 不做什么 |
|---|---|---|---|
| master | 普通会话 + `cowork-master` preset | 项目级入口；定优先级、拆分主题；例外决定；对用户汇报 | 不读代码、不跑测试、不创建/转发评审、不逐条安排评审、不维护每个主题的细节 |
| 插件 | host 插件 + 右侧栏 CoWork tab | 主题三态与标记、路由、评审请求、reviewer 生命周期、隔离目录、活动流、收件箱、记忆文件 | 不做产品决定，不写代码，不判断质量，不替 master 拍板 |
| 主题会话 | 普通 DSH 会话 + `cowork-topic` preset | 一个主题的对话与执行入口；可含多个执行单元；写摘要和证据；提交评审请求 | 不向其他主题发消息，不合并别人的分支，不维护全局状态 |
| 执行单元 | 子代理 / AgentTeams 成员 | 在隔离目录里完成具体任务；提交自己的分支 | 不与主题共享对话，不直接改主仓库，不自行合并 |
| reviewer | 独立 DSH 会话 + `cowork-reviewer` preset | 按请求范围独立复核；给出通过、需要修改、驳回与具体问题 | 不改代码、不合并、不解决冲突、不安排任务、不维护状态 |
| 用户 | GUI | 决定方向；可进入任意主题；可手动标记已解决、重新打开、改投 | — |

### 2.2 核心用户流程

#### 初始化

1. 用户在仓库目录打开一个会话，选择 `cowork-master`；
2. 调用 `cowork_project_init`（或发消息触发）；插件写 `index.json` v2，登记 master；
3. 插件登记 master；主题会话保留在左侧栏可见（2026-11-07 决策 (b)：archive 后会话无法继续对话），reviewer 隐藏；插件不调用 `archiveSession` 隐藏主题；
4. 右侧栏 CoWork tab 可打开项目概览；默认 tab 仍是普通会话。

#### 主会话输入与路由

1. 用户在 master 中输入需求。
2. 插件按三层判断：
   - 会话局部性：`masterFocusTopicId` 或上次路由目标；
   - 结构化匹配：路径、模块、符号、产品术语匹配 `scope/ownedPaths/aliases`；
   - 模型兜底：只剩 1–3 个候选且分不出高低时，调用 `ctx.llm.prepareCall`，关闭推理、短超时、小输出。
3. 明确命中：把用户原话和可选 `brief` 投给该主题；不新建。
4. 没有命中：插件自动起标题、新建主题会话并投递；必要时带 1–3 句背景说明。
5. 唯一命中是 `resolved`：不向已解决主题发消息；新建主题并在结果中返回 `resolvedMatch`，master 告知用户可打开旧主题。
6. master 只显示一条简短结果（交给哪个主题/新建了哪个），不接收全文。

#### 主题内工作

1. 用户在 CoWork 里点开主题；主区切换到该主题会话；master 仍在左侧栏。
2. 用户可以直接在主题内输入；不经过路由。
3. 需要并行时，主题创建一个或多个隔离工作项（`cowork_work_item_create`）；执行单元在各自目录里工作并提交。
4. 主题汇总证据，必要时调用 `cowork_handoff({status:'done'|'blocked'})`；`done` 写摘要与 `lastDeliveryConfirmedAt`，`blocked` 置标记。
5. 需要评审时，主题调用 `cowork_review_request`，提交范围、位置、证据、目标。

#### 评审

1. 插件做确定性检查：范围内有改动、提交存在、`base` 是 `head` 祖先、工作区干净、路径在仓库或该主题的隔离目录内、`verification` 非空。
2. 检查通过：写评审请求文件，新建 reviewer 会话（隐藏），投递评审说明；`awaitingReview=true`。
3. reviewer 自己读代码、跑必要检查，调用 `cowork_review_verdict({requestId, verdict, findings, verification})`。
4. `needs_revision`：插件把 findings 投回主题；不唤醒 master；主题修复后重新请求（新 reviewer，新请求，带上一轮请求 id）。
5. `pass`：插件更新主题；如果工作项需要合并，写入 master 收件箱 `merge-needed`；master 决定是否合并。
6. `reject`：主题置 `blocked`，写入收件箱；master 决定是否重规划。
7. reviewer 会话在 verdict 后归档；失败则保留并记录。

#### 已解决与重新打开

1. 用户可随时在面板标记已解决；master 也可在条件满足时自动标记。
2. 自动条件（同时满足）：没有进行中的工作、最后一次交付已确认、主题有摘要、空闲满 3 天、未阻塞。没有撤销。
3. 已解决主题不再被自动路由；master 遇到相关新任务时新建主题或提示用户打开旧主题。
4. 用户点开已解决主题并输入；插件把状态置回 `active`，清空 `resolvedAt/resolvedBy`，写 `topic-reopened` 事件。

#### 并行、隔离与合并

1. 代码改动默认走隔离工作项：`cowork_work_item_create` 用现有 clone 提供方创建目录与 `cowork/<workItemId>` 分支。
2. 执行单元在各自目录工作并提交；主题是集成分支的负责人。
3. 评审请求绑定 `baseCommit/headCommit/path`；评审通过后，master 调用 `cowork_checkout_merge(workItemId)`；合并串行，冲突保留现场由发起方处理。
4. `main` 不由插件碰；合并到 `main` 由人完成。
5. 如果 AgentTeams 自带 worktree 和 review，主题只保留一个最终评审负责人：AgentTeams 内部 review 算自检，cowork reviewer 做最终评审；不两层全量评审。

### 2.3 状态机

```
active ⇄ idle
active|idle → resolved
resolved → active（用户手动打开并输入）
```

| 状态/标记 | 含义 | 进入条件 | 离开条件 |
|---|---|---|---|
| `active` | 进行中 | 新建、复用、重开、有新活动 | 空闲阈值到 → `idle`；满足已解决条件 → `resolved` |
| `idle` | 空闲 | 无活动超过 `idleAfterMs`（默认 2h）且无待评审/阻塞 | 新活动 → `active`；满足已解决条件 → `resolved` |
| `resolved` | 已解决 | 用户手动，或 master 自动（五条件） | 用户手动打开并输入 → `active` |
| `awaitingReview` | 待评审标记 | 评审请求被接受 | verdict 记录 |
| `blocked` | 阻塞标记 | `handoff(blocked)` 或评审 `reject` | `handoff(done)` 或新的评审通过 |

`resolved` 不是归档；主题仍在 CoWork 列表中，仍可打开。`idle` 是展示状态，不阻止路由。

### 2.4 界面与会话可见性

- 左侧栏：master 与主题会话都保留可见（M6 决策 (b)：archive 后不能继续对话，宿主也没有会话过滤接口）；reviewer 隐藏。
- 右侧栏：CoWork 是一个 tab，默认 tab 仍是普通会话；tab 里是主题列表 + 详情 + 活动。
- 主区：同一时间只显示一个会话。打开主题是切换主区，不是浮层，不是新窗口；master 保留在左侧栏，点它或面包屑返回。
- reviewer 不作为列表行出现；评审结果以评审卡挂在主题详情。
- 主题操作：打开、标记已解决、重新打开、移动到其他主题、复制路径。
- 已解决主题仍显示；状态芯片带「用户/自动」来源。

---

## 3. 技术调研结论

### 3.1 已核验

| 能力 | 事实 | 证据 |
|---|---|---|
| 创建会话 | `sessionController.create({ workspaceId, agentPreset })` 创建普通会话并挂到 workspace | M0 结果、`src/session-slice.ts` |
| 唤醒会话 | `sessionController.prompt({ sessionId, mode:'queue', content })` | M0/M1 E2E |
| 重命名 | `sessionController.rename` | `src/session-slice.ts` |
| 归档/隐藏 | `archiveSession` 是展示过滤且 `archivedSessionIds` 可读，但归档后 `prompt` 的 turn 以 `blocked` 结束、消息不落盘；unarchive 才恢复 | `dsh-workspace/lib/index.js`、[M6 探针结果](M6_PROBE_RESULT.md) §3 |
| 打开会话 | 客户端 `uiWorkspace.openSession(sessionId)` 切换主区 | `src/client/contracts.ts` |
| 面板 | 右侧栏 tab、`sidebar.right.pane.tab`、footer action 已可用 | `docs/archived/PANEL_RESULT.md` |
| 会话事件 | 插件可订阅 `session/event`（E2E 已用） | `src/m3-e2e.ts` |
| 模型调用 | `ctx.llm.prepareCall` 已由 `dsh-session-title-llm` 使用；可设 `maxTokens`、`reasoningEffort`、超时 | `dsh-session-title-llm/lib/index.js` |
| 隔离 clone | 现有 per-thread clone 可用，路径在仓库内，reviewer 可读 | M2 结果、`src/checkout.ts` |

### 3.2 M6 探针问题（结论见 [M6 探针结果](M6_PROBE_RESULT.md)）

1. 插件通过 `ctx.get('llm')` 调用 `prepareCall` 的最小可用参数；最低 `reasoningEffort` 是否等价于关闭推理；没有服务时的回退。
2. 生产插件能否稳定收到 `session/event` 的 `turn/start`/`turn/end` 和用户消息。
3. `archiveSession` 后 `openSession` 能否继续对话、`prompt` 能否正常流式运行；是否有比 archive 更好的宿主/插件过滤接口。**M6 结论：不能继续（turn `blocked`、消息不落盘），unarchive 才恢复；没有 archive 之外的过滤接口——已导致 §2.2/§2.4/§5.9 改为降级方案 (b)。**
4. reviewer 创建后立即归档能否继续跑完；不行则 verdict 后归档。
5. master preset 去掉 `fs`/`bash` 后能否正常工作；全局工具是否仍可见；宿主是否有 per-agent tool policy。
6. 面板同源 POST 写路由在真实 Chrome 中可用，且 CSRF/loopback 检查不误伤。
7. 现有 clone 路径对 reviewer 可读；worktree 提供方作为可选适配器另行评估。

### 3.3 生态结论

- `dsh-plugin-worktrees` 的目录隔离与串行合并语义可以借鉴，但它只提供 `worktreesEngine` 面向 DAG 的接口，不是 cowork 可直接调用的通用服务；本方案 v1 继续用现有 clone 作为隔离提供方，worktree 作为后续可选适配器。
- AgentTeams 成员共用父会话 cwd；进入隔离目录靠任务说明和 `cd`，是软规则。cowork 不依赖 AgentTeams 运行时；只要求主题在提交评审请求前确认改动落在隔离目录与分支上。
- 两层评审只能保留一个负责人；否则会多花一份成本并可能得到不一致结论。

---

## 4. 总体架构

### 4.1 单插件形态

`dsh-cowork` 仍是一个 bundle patch 插件：host 半边注册 `CoworkService`、`cowork_*` 工具、system prompt 记忆段和 loopback HTTP 路由；client 半边注册右侧栏 CoWork tab；包内声明 `cowork-master`、`cowork-topic`、`cowork-thread`（别名）、`cowork-reviewer` 四个 preset。

### 4.2 模块图

```
src/
├── index.ts              # 装配：服务/工具/presets/路由/配置
├── topic.ts              # 三态、已解决判定、重开（纯函数）
├── topic-events.ts       # session/event 监听 → lastActiveAt / active / idle
├── store-schema.ts       # v2 类型与校验
├── store-migration.ts    # v1 → v2 迁移
├── store.ts              # index/activity/inbox/review 文件 I/O 与锁
├── activity.ts           # 活动流追加、裁剪、读取
├── inbox.ts              # master 收件箱：合并、投递、重放
├── routing.ts            # 三层路由（原 router.ts 重写）
├── router-model.ts       # ctx.llm 调用、关闭推理、超时/回退
├── review-request.ts     # 请求校验、文件、状态
├── review-tools.ts       # cowork_review_request / cowork_review_verdict
├── work-item.ts          # 隔离工作项（clone provider）
├── checkout.ts           # merge / 冲突 / 清理（复用）
├── session-visibility.ts # 隐藏/恢复主题与 reviewer
├── presets.ts            # 四个 preset
├── memory.ts / memory-prompt.ts # 记忆（M5 前不改语义）
├── project-tools.ts      # init/status
├── topic-tools.ts        # topic create/list/resolve/handoff
├── route-tools.ts        # route
├── checkout-tools.ts     # checkout merge
├── memory-tools.ts       # memory write/search
├── tools.ts              # 只做注册编排
├── api-contract.ts       # 面板 wire v2
├── api.ts                # GET/POST 路由
└── client/               # 右侧栏 tab（列表/详情/活动/操作）
```

### 4.3 数据模型

```ts
type TopicStatus = 'active' | 'idle' | 'resolved'

interface TopicRecord {
  topicId: string; title: string; status: TopicStatus
  awaitingReview: boolean; blocked: boolean
  scope: string; ownedPaths: string[]; aliases: string[]; digest: string
  cwd: string; legacyCheckoutPath: string | null
  createdAt: string; updatedAt: string; lastActiveAt: string
  lastDeliveryConfirmedAt: string | null
  resolvedAt: string | null; resolvedBy: 'user' | 'master' | null
  latestReviewRequestId: string | null
  reviewStatus: 'pending' | 'pass' | 'needs_revision' | 'reject' | null
  reviewerSessionId: string | null
}

interface WorkItemRecord {
  workItemId: string; topicId: string
  path: string; branch: string
  baseCommit: string | null; headCommit: string | null
  status: 'active' | 'reviewing' | 'merged' | 'abandoned'
  createdAt: string; updatedAt: string
}

interface ProjectIndexV2 {
  version: 2; projectId: string; masterSessionId: string
  createdAt: string; topics: TopicRecord[]; workItems: WorkItemRecord[]
}
```

评审请求：`reviews/<topicId>-<requestId>.json`，包含 `requestId/topicId/workItemId/purpose/notes/extra/baseCommit/headCommit/path/branch/changedPaths/verification/previousRequestId/status/reviewerSessionId/requestedAt/reviewedAt/verdict`。最小必需字段：`purpose`、`baseCommit`、`headCommit`、`path`、`verification`；`extra` 允许模型加字段（最多 20 项）。

活动流：`.dsh-cowork/activity.jsonl`，最多 500 条或 512 KiB，超出删最旧。收件箱：`.dsh-cowork/inbox.json`，最多 50 条，字段 `id/time/topicId/kind/summary/deliveredAt`；`kind` 只允许 `merge-needed`、`blocked`、`review-reject`、`cross-topic-conflict`。

迁移前备份 `index.v1.backup.json`。旧 `handoffs/`、`reviews/` 文件保留只读，不重写。

### 4.4 数据流

```
用户 → master：需求
master → 插件：cowork_route(intent, brief?)
插件 → 主题会话：新建/复用 + 原话 + brief
主题 → 插件：cowork_handoff(blocked|done) 或 cowork_review_request
插件 → reviewer：范围 + 证据 + 历史（新建会话）
reviewer → 插件：verdict + findings
插件 → 主题：needs_revision 时投回问题
插件 → 收件箱：pass 需合并 / reject / blocked
收件箱 → master：合并摘要（仅决定事件）
master → 插件：cowork_checkout_merge(workItemId)
```

### 4.5 会话与隔离

| 会话 | 位置 | 可见性 | 工作目录 |
|---|---|---|---|
| master | 左侧栏 | 可见 | 主仓库 |
| 主题会话 | CoWork tab | 左侧栏可见（决策 b：主题保留可打开） | 主仓库或该主题的隔离目录 |
| 执行单元 | 由主题/AgentTeams 创建 | 不出现在左侧栏 | 各自隔离工作项目录 |
| reviewer | 由插件创建 | 隐藏；面板不列，verdict 后归档；宿主左侧栏可能仍可见（KI-28） | 主仓库（读取工作项路径） |

隔离 v1 用现有 clone：`<repo>/.dsh-cowork/workitems/<workItemId>`，分支 `cowork/<workItemId>`；合并串行；`main` 由人收口。worktree 适配器后置。

---

## 5. 详细设计

### 5.1 主题生命周期与已解决

- `active ↔ idle`：`lastActiveAt` 超过 `idleAfterMs`（默认 2h）且无 `awaitingReview`/`blocked` 时为 `idle`；有新事件回 `active`。在读取和 `turn/end` 时惰性评估。
- `resolved`：
  - 用户手动：随时；`resolvedBy='user'`。
  - master 自动：`awaitingReview=false`、`blocked=false`、没有 `active` 工作项、`lastDeliveryConfirmedAt` 非空、`digest` 非空、`now - lastActiveAt >= resolveAfterMs`（默认 3 天）。全部满足才写；不提供撤销。
  - 自动评估在 `project_status`、`route`、面板 overview 读取时和 `turn/end` 后执行；不新增后台定时器。写入前在项目锁内重读 `lastActiveAt`，避免与用户新消息竞争。
  - `resolved` 不再被自动路由；用户手动打开并输入后回到 `active`，清空 `resolvedAt/resolvedBy`。
- `awaitingReview`：评审请求接受时置位，verdict 时清除。
- `blocked`：`handoff(blocked)` 或评审 `reject` 置位；`handoff(done)` 或新的评审通过清除。

### 5.2 store v2 与迁移

- `src/store-schema.ts`：v2 类型、状态/标记校验、未知字段容忍策略；`src/store-migration.ts`：v1→v2 纯函数。
- 映射：`new/active`→`active`；`awaiting_review`→`active` 且取消在途评审（归档旧 reviewer，`awaitingReview=false`，`reviewStatus=null`）；`blocked`→`active`+`blocked`；`done/archived`→`resolved`（`resolvedBy='master'`，`resolvedAt=updatedAt`，`lastDeliveryConfirmedAt=updatedAt`）；`threadId`→`topicId`；`subject`→`title`；`checkoutPath`→`legacyCheckoutPath`。
- 迁移前复制 `index.v1.backup.json`；迁移失败保留备份并报 `store/corrupt`，不静默重建。
- 写只写 v2；读兼容 v1。
- activity/inbox 同用项目锁；activity 追加后裁剪；inbox 原子重写。

### 5.3 路由

- 第一层：`masterFocusTopicId`（面板打开主题时写）或上次路由目标；默认续接。
- 第二层：路径、模块、符号、产品术语匹配 `scope/ownedPaths/aliases`；返回分数与原因；排除 `resolved`。
- 第三层：1–3 个候选且前两层分不出高低时，调用 `ctx.llm.prepareCall`；输入只有意图和候选标题/范围/摘要（≤2k 字）；输出 `{topicId|null, confidence}`；`maxTokens` 小、超时 2 秒、关闭推理（最低 `reasoningEffort` 或适配器 thinking=false，以探针为准）。失败/超时回退：最高结构化候选过底线则复用，否则新建。
- 低置信不弹选择：模型选择即执行；选错在面板「移动到其他主题」纠正，把原意图写进目标 `aliases`，记录 `route-corrected`。
- 明确指定：`cowork_route` 接受可选 `topicId`；目标是 `resolved` 时返回 `resolvedMatch` 并新建主题，不向已解决主题发消息。
- 新建标题：意图前 24 字、去换行；master 可显式 `cowork_topic_create`。

### 5.4 评审请求与 reviewer

- 请求校验：`purpose`、`baseCommit`、`headCommit`、`path`、`verification` 必填；`base` 是 `head` 祖先；`path` 在仓库或该主题的隔离目录内；隔离目录工作区干净；范围内有改动。
- 创建：写请求文件（`pending`）→ 新建 reviewer 会话（隐藏）→ 投递评审说明；失败则回滚为未请求并归档半成品。
- reviewer 说明：`requestId`、范围、路径、分支、改动文件、证据、上一轮请求/问题；不粘贴完整仓库。
- verdict：只能由该请求登记的 reviewer 会话调用；写 verdict；`needs_revision` 只投回主题，不唤醒 master；`pass` 更新主题与收件箱（如需合并）；`reject` 置 blocked 并写收件箱；verdict 后归档 reviewer。
- 每次请求新建 reviewer，不复用；上一轮记录随请求带过去。

### 5.5 工作项、隔离与合并

- `cowork_work_item_create`（主题/master）用现有 clone 提供方创建目录与分支，返回 `workItemId/path/branch/baseCommit`。
- 执行单元在各自目录里 `cd` 工作并提交；主题是集成分支负责人。
- `cowork_checkout_merge(workItemId)` 只由 master 调用；要求同一 `headCommit` 的评审通过；工作区干净；串行合并；冲突保留现场，主题解决后重新评审；`main` 不动；合并后清理 clone 与分支、更新工作项与主题、写活动。
- 共享工作区评审：`workItemId=null`，`path=repo`，要求工作区干净且提交范围明确；不执行合并，只确认交付。

### 5.6 活动流与 master 收件箱

- 所有状态、路由、评审、合并、错误都写 activity；面板读取尾部。
- 只有 `merge-needed`、`blocked`、`review-reject`、`cross-topic-conflict` 写 inbox 并 `prompt` master；多条待办合并成一条摘要（≤5 条，每条 ≤200 字）。
- 投递成功写 `deliveredAt`；失败保留，`cowork_project_status` 重放；不丢事件。
- master 的状态查询有界：计数、最多 50 个主题、每主题摘要 ≤200 字、待决定事件、活动尾部；超出标 `truncated`。

### 5.7 工具与角色

| 工具 | 角色 | 说明 |
|---|---|---|
| `cowork_project_init` | master | 初始化/接管；同步会话可见性 |
| `cowork_project_status` | master/topic | v2 有界摘要 |
| `cowork_route` | master | 三层路由；`intent`、`topicId?`、`brief?`、`forceCreate?` |
| `cowork_topic_create` | master | 新主题；`title/scope?/ownedPaths?/brief?` |
| `cowork_thread_create` | master | 弃用别名 |
| `cowork_topic_list` | master/topic | 有界列表 |
| `cowork_thread_list` | master/topic | 弃用别名 |
| `cowork_handoff` | topic | 只留 `blocked/done`；`done` 写交付确认与摘要 |
| `cowork_review_request` | topic only | 新 schema；master 调用被拒 |
| `cowork_review_verdict` | reviewer | 增加 `requestId`；只接受登记的 reviewer |
| `cowork_work_item_create` | topic/master | 创建隔离目录与分支 |
| `cowork_checkout_merge` | master | 按 `workItemId` 合并；`threadId` 兼容别名 |
| `cowork_topic_resolve` | master | 手动标记已解决 |
| `cowork_memory_write/search` | master/topic | 不变 |

角色守卫按会话 id 与索引记录判断；master 调用 `cowork_review_request` 返回明确拒绝；reviewer 只能调用 verdict 与搜索/命令。

### 5.8 预设与记忆

- `cowork-master`：persona、agent-instructions、time-context、ask-user、todo；移除 fs/search/bash/jobs/present。persona 明确不做流程编排。
- `cowork-topic`：替换 `cowork-thread`；行与当前 thread 相同；persona 改为「一个主题一个会话，可含多个执行单元，自己提交评审请求，写摘要与证据」。
- `cowork-thread`：保留一个版本别名，行与 topic 相同。
- `cowork-reviewer`：行不变；persona 增加「只看请求范围，不合并、不解决冲突」。
- `cowork:memory` 段落识别 `cowork-master`、`cowork-topic`、`cowork-thread`；reviewer 不注入。记忆语义与预算不在本方案改动；M5 再做整理/检索。

### 5.9 HTTP API 与面板

- `GET /api/cowork.overview`：v2 主题列表与计数；最多 500。
- `GET /api/cowork.activity?limit=50`：活动尾部。
- `GET /api/cowork.topic?id=`：主题详情（工作项、评审请求、活动）。
- `POST /api/cowork.topic.resolve`、`POST /api/cowork.topic.reopen`、`POST /api/cowork.route.move`：面板写操作；请求体含当前 `sessionId`；只允许该项目 master；沿用 loopback，增加 `Origin`/`Host` 同源与 JSON content-type 检查。
- 面板：主题列表（状态/标记/摘要/最近活动）、详情（摘要、工作项、评审请求、活动、操作）、操作「打开/标记已解决/重新打开/移动到其他主题」；reviewer 不列出；评审卡挂详情。
- 打开主题：`uiWorkspace.openSession(topicId)`；主区切换，不新增/移除左侧栏条目（主题本来可见）；master 保留；面包屑返回。会话已被用户归档时先 unarchive 再打开（容错，非常规路径）。
- 右侧栏默认 tab 仍是普通会话；CoWork 不自动打开；footer 入口保留。
- 左侧栏策略：主题会话保留左侧栏（2026-11-07 决策 (b)：archive 后无法继续对话，且无会话过滤接口）；插件不用 `archiveSession` 隐藏主题；打开主题不需要 unarchive。
- reviewer 隐藏：verdict 后归档（M6 探针 4：创建后立即归档会让 turn `blocked`）；失败记录，不假装成功。

### 5.10 配置默认值

| 配置 | 默认 | 说明 |
|---|---|---|
| `idleAfterMs` | 2h | 空闲展示阈值 |
| `resolveAfterMs` | 3d | 已解决自动阈值（用户确认） |
| `routing.enabled` | true | 第三层模型开关 |
| `routing.provider/model/effort` | 未设 | 未设时用 master 会话路由或跳过第三层 |
| `routing.timeoutMs` | 2000 | 模型兜底超时 |
| `routing.maxTokens` | 256 | 模型兜底输出上限 |
| `isolation.provider` | clone | clone v1；worktree 后置 |
| `reviewer.reclaim` | after-verdict | M6 探针 4：立即归档会让 turn 变成 blocked |

主题会话可见性不再有配置项：M6 决策 (b) 固定为保留左侧栏、只隐藏 reviewer。

---

## 6. 实施计划

**执行规则：**本节每个 M6–M12 是一个独立执行单元；完成一个就停下，等确认后再进入下一个。禁止一次执行多个阶段。每个阶段结束都必须跑该阶段的测试；全量 E2E 在 M12。

**记录与阶段的主归属：**下表说明每条决策记录主要在哪个阶段被消费。「主记录」表示该阶段负责实现并在阶段结束时关闭这条决定；其他阶段只消费，不重新决定。这不是严格的 1 对 1：M6 和 M12 是闸门，没有专属记录；M10 主归属两条；主题会话模型跨多个阶段。

| 阶段 | 主记录 | 同时消费 |
|---|---|---|
| M6 探针与决策记录 | 无（探针/记录核对闸门） | 主题会话模型、索引 v2 |
| M7 数据模型与迁移 | 索引 v2 与迁移 | 并行隔离与合并（工作项 schema）、主题会话模型 |
| M8 主题生命周期、活动、收件箱 | 三态生命周期 | 索引 v2（活动/收件箱） |
| M9 路由、工具、预设 | 三层路由 | 主题会话模型（preset/工具）、三态生命周期（状态） |
| M10 评审请求、reviewer、隔离、合并 | 评审请求、并行隔离与合并 | 主题会话模型、索引 v2 |
| M11 HTTP API 与面板 | 面板与会话可见性 | 主题会话模型、三态生命周期、评审请求 |
| M12 文档、真实 E2E、0.2.0 | 无（文档/E2E/发布闸门） | 全部 7 条 |

### M6 探针与决策记录

- 范围：核对 7 份 proposed 决策记录（见 §8）与探针结论一致，必要时补充；执行 §3.2 的 7 项探针，写 `docs/M6_PROBE_RESULT.md`。本文件与 7 份记录已保存；不重写 `docs/PLAN.md`。
- 依赖：无。
- 完成标准：
  - 7 份记录存在，含非空 `## Alternatives considered`，且与探针结论一致。
  - 探针 1–3 结论明确（LLM、session/event、archive 后打开/prompt）；4–6 有结论；7 记录。
  - `docs/PLAN-V0.2.md` 已存在且阶段为 M6–M12；`docs/PLAN.md` 保持 V0.1 不变。
  - `npm run check` 通过（新文件已分类）。
- 证据：`docs/M6_PROBE_RESULT.md`、7 份 proposed 记录、`npm run check`。
- 不做：不改 `src/`；不执行 M7–M12。

### M7 数据模型与迁移

- 范围：`src/store-schema.ts`、`src/store-migration.ts`、`src/store.ts`；v1→v2 映射；备份；activity/inbox 文件读写；类型与 store 测试。
- 依赖：M6（顺序）。
- 完成标准：
  - v1 六态全部可迁移；`awaiting_review` 在途评审被取消并归档旧 reviewer；`done/archived` 转 resolved。
  - 迁移前写 `index.v1.backup.json`；损坏/未知状态 fail closed。
  - `npm test` 中 store-migration/round-trip 通过；`npm run typecheck`/`build` 通过。
- 证据：`tests/store-migration.test.mjs`、`tests/store.test.mjs`。
- 不做：不改工具、不改 UI、不切默认行为。

### M8 主题生命周期、活动、收件箱

- 范围：`src/topic.ts`、`src/topic-events.ts`、`src/activity.ts`、`src/inbox.ts`；三态、标记、已解决五条件、3 天/2 小时、重开、活动裁剪、收件箱合并/重放。
- 依赖：M7。
- 完成标准：
  - 五条件逐条缺失都不自动标记；3 天边界正确；无撤销；重开清空 resolved 字段。
  - `turn/end` 更新 `lastActiveAt`；已解决主题收到用户输入回到 active；锁内重读避免竞争。
  - 活动流上限与损坏行处理；收件箱投递失败保留并可重放。
  - 测试通过；`npm run typecheck`/`build` 通过。
- 证据：`tests/topic.test.mjs`、`tests/activity.test.mjs`、`tests/inbox.test.mjs`。
- 不做：不接模型路由，不改工具。

### M9 路由、工具、预设

- 范围：重写 `src/router.ts` → `src/routing.ts`；新增 `src/router-model.ts`；新增 `src/project-tools.ts`/`topic-tools.ts`/`route-tools.ts`，`src/tools.ts` 只编排；`src/presets.ts`、`src/memory-prompt.ts`；工具别名。
- 依赖：M7、M8、M6 探针 1/2。
- 完成标准：
  - 三层路由；低置信不弹窗；模型失败回退；resolved 不自动接；别名纠正写入。
  - 工具名/角色/别名按 §5.7；master preset 去 fs/bash；topic/thread 别名可用；memory 注入识别。
  - `project_status` 有界；`cowork_route` 返回可解释原因。
  - 测试通过；source budget 通过。
- 证据：`tests/router*.test.mjs`、`tests/tools.test.mjs`、`tests/presets.test.mjs`、`npm test`。
- 不做：不实现评审请求与合并；不接面板。

### M10 评审请求、reviewer、隔离、合并

- 范围：`src/review-request.ts`、`src/review-tools.ts`、`src/review.ts`、`src/work-item.ts`、`src/checkout.ts`、`src/session-visibility.ts`；请求校验、reviewer 生命周期、隐藏、合并。
- 依赖：M7、M8、M9、M6 探针 3/4。
- 完成标准：
  - 请求必填校验；base 祖先；脏目录拒绝；路径越界拒绝。
  - 每次新建 reviewer；verdict 绑定 requestId/reviewerSessionId；needs_revision 不唤醒 master；pass/reject 进收件箱；verdict 后归档。
  - 合并要求同一 head 的 pass；串行；冲突保留；清理；main 不动。
  - 测试通过；`npm run typecheck`/`build` 通过。
- 证据：`tests/review-request.test.mjs`、`tests/work-item.test.mjs`、`tests/checkout.test.mjs`。
- 不做：不写面板；不做 worktree 适配器。

### M11 HTTP API 与面板

- 范围：`src/api-contract.ts` v2、`src/api.ts` 读写路由、`src/client/*` 重写；左侧栏策略（决策 (b)：主题保留可见、reviewer 隐藏）、CoWork tab、打开/已解决/重开/改投。
- 依赖：M9、M10、M6 探针 5/6。
- 完成标准：
  - 面板显示主题列表/详情/活动；无 thread 行、无 reviewer 行；reviewer 评审卡挂详情。
  - 打开主题切换主区；面包屑回 master；打开不新增/移除左侧栏条目；已归档会话先 unarchive 再打开。
  - 写路由同源/loopback 校验；错误状态可读。
  - 真实 Chrome 面板检查通过。
- 证据：`tests/api-contract.test.mjs`、`tests/panel-model.test.mjs`、面板截图与 run 记录。
- 不做：不做主题内嵌多面板；不做移动端新布局。
- M11 已交付：代码 artifact `6b7beab`，证据与验收见 [M11_RESULT](M11_RESULT.md)。

### M12 文档、真实 E2E、0.2.0

- 范围：`README.md`、`docs/routing.md`、`docs/context.md`、`docs/glossary.md`、`docs/KNOWN_ISSUES.md`、`docs/publish.json`、`docs/M12_RESULT.md`、`docs/M12_HANDOFF.md`；`src/m12-e2e.ts`、`tests/m12-e2e.test.mjs`；版本 0.2.0；打包与本地安装/卸载。
- 依赖：M7–M11。
- 完成标准：
  - 真实 E2E 全链路：master 初始化 → 路由新主题 → 主题在左侧栏可见并经 CoWork 打开（决策 (b)） → 提交评审 → reviewer verdict 后归档 → master 只收合并决定 → 已解决自动标记 → 无撤销 → 手动重开 → 已解决不自动接收 → 活动流 → 隔离 clone 合并。
  - 面板真实 Chrome 验证。
  - `npm run check`、`npm run check:self-test`、`npm test`、`npm run typecheck`、`npm run build` 全绿；`npm pack` 与本地 profile 安装/卸载通过。
  - README 写明 0.2.0 破坏性变更、迁移、回滚。
- 证据：`docs/M12_RESULT.md`、`.dsh-cowork/e2e/M12_E2E.json`、面板截图、打包清单。
- 不做：不发布 GitHub Release，除非用户另行确认。

---

## 7. 测试与验收总则

- 每个成功标准必须有可复现命令；跨会话/跨进程的改动必须跑真实 DSH E2E，不允许只用同进程 mock 代替。
- 不用固定 `sleep`；等待状态或事件，用有截止时间的重试。
- 单元/契约：store 迁移、主题状态、活动/收件箱、路由/模型、评审请求、工作项/合并、工具/预设、API/面板模型。
- 真实 E2E：M12 全链路；配置短阈值（`idleAfterMs=500`、`resolveAfterMs=1000`）；模型路由在 E2E 中关闭，另做观测性探针。
- 面板：真实 Chrome；先修宿主健康与 overview API，再驱动 UI；复用浏览器会话；fixture 隔离。
- 检查：`npm run check`、`npm run check:self-test`、`npm test`、`npm run typecheck`、`npm run build`。
- 证据：`docs/M6_PROBE_RESULT.md`、`docs/M12_RESULT.md`、`docs/M12_HANDOFF.md`、`.dsh-cowork/e2e/M12_E2E.json`、面板截图。
- source budget：`src/tools.ts` ≤ 49,152 B；所有 `src/**/*.ts` < 51,200 B；拆分为 §4.2 的模块。

验收编号：

- `[A1]` v1→v2 迁移、备份、幂等 — `tests`（store-migration）。
- `[A2]` 三态、标记、五条件、3 天、无撤销、重开 — `tests`（topic）。
- `[A3]` 三层路由、低置信不弹窗、失败回退、resolved、别名 — `tests`（routing/router-model）。
- `[A4]` 评审请求校验、reviewer 生命周期、stale head、回收 — `tests`（review-request/work-item）。
- `[A5]` 工具/角色/别名、preset、memory — `tests`（tools/presets/memory-prompt）。
- `[A6]` 面板契约、排序/标签/操作、写路由 — `tests` + 真实 Chrome。
- `[A7]` 隔离、串行合并、冲突、清理 — `tests`（work-item/checkout）。
- `[A8]` 真实 E2E — `tests`（m12-e2e）+ `docs/M12_RESULT.md`。
- `[A9]` 文档分类/检查/构建 — `npm run check`、`check:self-test`、`typecheck`、`build`。
- `[A10]` 回滚（备份恢复 + 0.1.0 重装） — `docs/M12_RESULT.md`。

---

## 8. 风险与决策记录

| 风险 | 等级 | 处理 | 重新评估触发条件 |
|---|---|---|---|
| `ctx.llm` 接口或关闭推理方式不符 | 高 | M6 探针；关闭第三层或降级；模型路由不作为阻塞 | 模型路由不可用，或适配器变更 |
| `session/event` 不向插件暴露 | 高 | 降级为工具/读取时更新；精度下降并记录 | 真实宿主收不到 turn 事件 |
| archive 后不能打开/继续 | 高 | M6 探针 3 证实；用户 2026-11-07 决定采用降级 (b)：主题保留左侧栏、只隐藏 reviewer（见决策记录） | 宿主提供会话过滤接口，或侧栏噪音不可接受 |
| master 全局工具无法硬隔离 | 中 | preset 去 fs/bash；文档；探针 host tool policy | master 调用宿主工具 |
| 迁移丢数据 | 高 | 备份、fail closed、逐状态测试 | 迁移失败或用户报告 |
| E2E 不稳定 | 中 | 事件驱动等待；短阈值；不用 sleep | 连续两次 flaky |
| 面板重写范围大 | 中 | 先 API/类型后组件；真实 Chrome；拆分 styles | 面板无法加载或状态不一致 |
| 评审/合并破坏工作区 | 高 | 隔离目录、串行合并、冲突保留；main 不自动动 | 出现非预期主仓库改动 |
| 0.2.0 破坏旧会话 | 中 | 别名 + 迁移 + README；旧 preset 保留一版 | 旧会话无法继续 |
| 与 AgentTeams 双重评审 | 中 | 文档规则：单一评审负责人；不引入运行时 | 出现两份结论冲突 |

决策记录（M6 核对，每个议题一份）：

- `.agents/notes/proposed/architecture/2026-11-07-topic-session-model.md`
- `.agents/notes/implemented/feature/2026-11-07-three-state-lifecycle.md`
- `.agents/notes/implemented/feature/2026-11-07-review-request-model.md`
- `.agents/notes/implemented/feature/2026-11-07-three-layer-routing.md`
- `.agents/notes/implemented/architecture/2026-11-07-parallel-isolation-and-merge.md`
- `.agents/notes/implemented/feature/2026-11-07-panel-and-session-visibility.md`
- `.agents/notes/implemented/feature/2026-11-07-topic-visibility-fallback.md`
- `.agents/notes/implemented/architecture/2026-11-08-m11-http-api-panel.md`
- `.agents/notes/implemented/architecture/2026-11-08-m10-review-request-workitems-plan.md`
- `.agents/notes/proposed/architecture/2026-11-07-topic-store-v2.md`

记录与阶段的主归属见 §6 的「记录与阶段的主归属」表。

每份 proposed 记录必须有 `## Problem`、`## Proposal`、非空 `## Alternatives considered`、`## Acceptance criteria`、`## Risks`、`## Delivery stages`；已落地的 implemented 记录按同一交付重写为 `## Problem`、`## Decision`、非空 `## Alternatives considered`、`## Consequences`、`## Testing`（criterion id 保留）。替代方案至少记录：保留 thread、master 继续编排评审、复用 reviewer 会话、多段会话、低置信弹窗、纯词法路由、立即替换 worktree、讨论型主题独立成类。

---

## 9. 参考与许可

- DSH 核心包：`/Applications/DSH Desktop 2.app/Contents/Resources/app/node_modules/@deepseek-ai/`（`dsh-api-session-controller`、`dsh-api-workspace-controller`、`dsh-llm`、`dsh-client-ui-workspace`）。
- `dsh-plugin-worktrees@0.1.2`：目录隔离与串行合并语义；本机文档 `~/dsh-playgroud/dsh-config/worktree-task-contract.md`、`~/dsh-playgroud/dsh-config/agent-teams.runbook.md` §9。
- AgentTeams：只借语义，不引入运行时；`docs/AGENTTEAM.md`。
- 本插件 MIT。借鉴第三方代码时必须保留原许可声明。

---

## 10. 文档与交接

### 10.1 文档更新

- 本文件 `docs/PLAN-V0.2.md` 是 V0.2 的阶段计划；`docs/PLAN.md` 保持 V0.1（M0–M4），不覆盖；M5 记忆整理保留在 V0.1 与 `KNOWN_ISSUES` 中。
- `docs/README.md` 与 `docs/publish.json` 在保存 V0.2 时已加入索引与 internal 分类；后续文档更新按 M12 执行。
- `README.md`、`docs/routing.md`、`docs/context.md`、`docs/glossary.md`、`docs/KNOWN_ISSUES.md` 在 M12 按 V0.2 更新；`AGENTS.md` 的 thread→topic 表述在 M12 由用户确认后更新。
- M6 已产出 `docs/M6_PROBE_RESULT.md` 与 `docs/M6_HANDOFF.md`；M11 的会话可见性按 2026-11-07 决策 (b) 执行（主题保留左侧栏）。
- 历史交接 `docs/archived/M4_HANDOFF.md` 不改正文；新的 `docs/M12_HANDOFF.md` 说明 V0.2 起点与回滚。

### 10.2 交接说明

1. 本文件与 7 份 proposed 记录已保存；开始 M6 时先核对记录与探针结论，再执行探针、写 `docs/M6_PROBE_RESULT.md`；完成后停下。
2. M7–M12 一次只做一个；每个阶段结束报告：改了什么、验证命令与结果、如何回滚、遗留风险；等确认后再进入下一阶段。
3. 工作目录固定 `/Users/ray/Workspace/dsh-cowork`；先读 `AGENTS.md`、`docs/documentation.md`、`docs/testing.md`、本文件。
4. 不修改 `~/.agents/AGENTS.md`、`~/.dsh` 下无关配置；不发布到远端，不上传源码。
5. 任何阶段发现宿主前提被推翻，停下来报告已知事实和 2–3 个选项，不绕过。
6. 真实 E2E 与面板验收通过后，才宣布 M12 完成；未跑的命令必须在报告中明确列出。
7. M5 记忆整理与检索不在本文件范围；本文件不改变 M5 的目标与验收。
