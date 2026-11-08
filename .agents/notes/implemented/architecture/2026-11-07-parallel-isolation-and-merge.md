# Decision: 并行执行用隔离工作项，合并串行

Status: implemented
Date: 2026-11-07
Class: architecture

## Problem

M4 的隔离单位是 thread：每个 isolated thread 一个本地 clone、一个 `cowork/<threadId>` 分支，master 在自己那边 fetch 并 merge。这个模型在「一个 thread 一个任务」时能用，但讨论确认的新模型是一个主题一个会话、主题内部可以有多个执行单元（子代理、AgentTeams 成员）。如果继续用 thread 做隔离单位，会有三个问题：

1. **没有工作项记录。** 一个主题里多个执行单元在哪些目录、哪些分支、基于哪个提交、当前 head 是什么，索引里没有位置；评审请求无法绑定范围。
2. **把「文件范围不重叠」当成安全边界。** 讨论中明确反对：文件范围只能降低冲突概率，不能防止越界；真正防止互相覆盖的是目录隔离，但目录隔离也不能消除合并冲突。
3. **合并没有唯一入口。** 谁合、按什么顺序合、冲突谁处理、什么算「已合并」都不清楚；AgentTeams 可能自带 worktree 和合并队列，容易与 cowork 重复。

本记录固定执行层的边界：隔离工作项、串行合并、master 独占合并、`main` 由人收口；评审负责人由 [评审请求模型](../feature/2026-11-07-review-request-model.md) 拥有，本记录不重复。详细字段与阶段见 [PLAN-V0.2 §4.5/§5.5](../../../../docs/PLAN-V0.2.md)。

## Decision

**工作项。** 一个隔离执行单元对应一个 `WorkItemRecord`（`src/store-schema.ts`）：`workItemId`、`topicId`、`path`、`branch`、`baseCommit`、`headCommit`、`status`（`active`/`reviewing`/`merged`/`abandoned`）、创建与更新时间。主题或 master 调用 `cowork_work_item_create` 创建；返回目录、分支、基提交。执行单元在各自目录里工作并提交。

**隔离提供方。** v1 用现有的本地 clone：`<repo>/.dsh-cowork/workitems/<workItemId>`，分支 `cowork/<workItemId>`，从 `baseRef`（默认仓库当前 HEAD）创建。`src/checkout.ts` 把 clone 参数化为 `IsolationTarget { id, rootRelative, branchPrefix }`；`createCheckout`/`inspectCheckout`/`mergeCheckout`/`removeCheckout` 同时接受 `target` 与旧的 `threadId`，路径守卫校验 id、root 与分支并 realpath 防逃逸。`isolation.provider` 默认 `'clone'`，其他值在创建前返回 `workitem/provider-unsupported`，不静默回退；worktree 适配器后置（KI-27）。隔离是「目录级」，不是硬沙箱；不把文件范围当成安全边界。

**创建与边界。** 主题是集成分支的负责人；执行单元不直接改主仓库，不自行合并。AgentTeams 成员共用父会话 cwd，进入隔离目录靠任务说明和 `cd`，是软规则；合并前主题/队长核对分支、HEAD、改动文件，合并独占。创建流程在 `src/work-item.ts`：写 `active` 记录与 `work-item-created` 活动；clone 失败、索引写失败、活动写失败逐路径清理，失败不留半截索引（`workitem/create-failed` / `workitem/cleanup-failed`）。

**评审绑定。** 评审请求可以带 `workItemId`，也可以只带 `path/baseCommit/headCommit`；请求必须绑定固定提交。评审通过后，只有同一 `headCommit` 的 verdict 才能合并；head 移动后旧通过失效，需要重新请求评审。请求前置检查拒绝越过工作项目录的路径（[评审请求模型](../feature/2026-11-07-review-request-model.md)）。

**合并。** `cowork_checkout_merge(workItemId)`（`threadId` 为兼容别名）只由 master 调用；要求工作项存在且处于 `reviewing`、工作区干净、同一 head 的评审通过；目标分支是仓库当前检出分支，`main`/`master` 等保护分支与 detached HEAD 一律拒绝（`checkout/protected-branch`）。合并用进程级 Promise 链串行化（同一 DSH 实例；跨进程不在保证范围，KI-26）。冲突时 abort 合并、保留 clone 并报告冲突文件，解决后重新请求评审。成功后按 workspace → clone/分支 → workspace 删除 → 索引更新的顺序清理，工作项 `merged`，写 `work-item-merged`；清理失败只记录，不回滚已完成的合并。共享工作区评审（`workItemId=null`）不执行合并，只确认交付。

**AgentTeams 共存。** 不引入 AgentTeams 运行时依赖。AgentTeams 可以提供自己的 worktree 和合并队列，但 cowork 只要求最终落点是工作项目录/分支；评审负责人只保留一个（cowork reviewer 终评，或采用 AgentTeams verdict），规则由评审记录拥有。

**不做的事。** 不自动解决冲突；不自动合并到 `main`；不强制要求并行任务文件范围不重叠；不把 clone 目录放在仓库外（保持 reviewer 可读与 `.gitignore` 覆盖）；不新增第二种合并队列。

## Alternatives considered

**要求并行任务按文件范围不重叠。** 否决：这只能降低冲突概率，不能防止越界；用户明确不认同把它当安全边界。隔离目录是主边界，合并且串行、合并前核对是补充。

**立即用 git worktree 替换 clone。** 否决：M2 已经证明 linked worktree 的 git 元数据在会话 cwd 之外，workspace-write 下 thread 侧 git 写会被拒；现有 clone 已验证可用。worktree 需要单独探针与提供方，作为后续适配器，不在 v1 阻塞。

**自动合并或自动解决冲突。** 否决：冲突需要业务判断，自动解决会掩盖错误；冲突保留现场由发起方处理，合并串行。

**让主题自己合并。** 否决：合并需要唯一入口与串行队列；master 独占合并，主题只准备可合并的分支。master 的决定权还包括发布；这与「master 只做决定」一致。

**依赖 AgentTeams 运行时。** 否决：会抢 `sessionController`、`workspaceRegistry` 和子代理池；本插件只借隔离/合并语义。

**每个并行任务新建一个 thread 会话。** 否决：thread 已被取消；并行应由主题内的执行单元与工作项解决，避免会话数量与冷启动成本。

## Consequences

- clone 成本：每个隔离工作项一次完整 checkout，磁盘与时间随并行数增长；大仓库可能明显。重审条件：并行数成为常态，clone 时间影响使用，或 worktree 探针通过（KI-1、KI-27）。
- 软规则越界：执行单元可能不 `cd` 到工作项目录；合并前核对与 `git -C` 检查是补充，不是硬隔离。重审条件：观察到越界写入主工作树。
- 合并冲突：隔离不消除冲突；冲突由发起方处理，可能拖慢推进。重审条件：冲突频率高或成为常态。
- 串行只在单进程内：进程级 Promise 链只保证同一 DSH 实例的合并顺序，多个宿主同时对同一仓库合并不在保证范围（KI-26）。
- 保护分支识别：无 remote 或 detached HEAD 时以 `main`/`master` 名单和「无法判定即拒绝」兜底。重审条件：真实仓库出现误拒/误放行。
- 共享工作区评审：工作区可能包含用户未提交的改动；要求干净且提交范围明确，否则拒绝。重审条件：用户频繁在同一工作区并行编辑。
- AgentTeams 双重合并/双重评审：只靠文档规则与人工约定，插件不能自动检测。重审条件：出现两份 verdict 或两个合并入口。
- 隔离提供方只有 clone：`isolation.provider` 的配置形状已经存在，但实际实现只有 `'clone'`；worktree 适配器需要单独探针与记录（KI-27）。
- 本记录取代原 `proposed/architecture/2026-11-07-parallel-isolation-and-merge.md`；实现与证据见 [M10 交付结果](../../../../docs/M10_RESULT.md)。

## Testing

- [A1] `cowork_work_item_create` 为每个隔离执行单元创建目录与分支，返回并记录 `path/branch/baseCommit`；重复创建/非法路径/provider 非 clone/失败清理被拒且不留半截记录 — `tests`：`tests/work-item.test.mjs`（`createWorkItem clones, writes the active record, and records the activity`、`createWorkItem refuses an unsupported isolation provider before any work`、`createWorkItem refuses a duplicate record or an existing clone before cloning`、`createWorkItem maps a failed clone to create-failed and reports the cleanup`、`createWorkItem removes the clone and branch when the index write fails`、`cowork_work_item_create clones, records, and activates a work item`、`the master must name an existing topic; a topic creates only for itself`）；`tests/checkout.test.mjs`（`createCheckout with a work-item target clones under workitems and branches cowork/<id>`、`createCheckout refuses a target whose root escapes the repository`）
- [A2] 评审请求绑定 `baseCommit/headCommit`；合并要求同一 head 的 pass；head 移动后旧通过不可合并 — `tests`：`tests/work-item.test.mjs`（`a head that moved after the review is refused without merging`、`a work item without a passed review cannot be merged`）；`tests/review-request.test.mjs`（`the merge gate accepts exactly a passed review of the current head`）
- [A3] `cowork_checkout_merge` 只由 master 调用，合并串行；冲突保留现场，解决后重新评审；`main` 不被插件修改 — `tests`：`tests/work-item.test.mjs`（`the merge tool is master only`、`main and a detached HEAD are protected merge targets`、`a conflicting merge keeps the clone and reports the conflict files`、`serializeMerge runs merges in order and survives a rejected operation`）
- [A4] 合并成功后清理 clone 与分支、更新工作项/主题、写活动；清理失败只记录，不回滚合并结果 — `tests`：`tests/work-item.test.mjs`（`a passed work item merges into the current branch and is torn down`、`a cleanup failure is reported without failing the finished merge`）
- [A5] AgentTeams 场景只保留一个评审负责人；不引入 AgentTeams 运行时依赖；规则写进文档 — `decisions`：本记录、[评审请求模型](../feature/2026-11-07-review-request-model.md)、[M10 交付结果](../../../../docs/M10_RESULT.md)
