# Decision: M10 评审请求、reviewer 生命周期、工作项与串行合并

Status: implemented
Date: 2026-11-08
Class: architecture

## Problem

M9 已交付（[M9 交付结果](../../../../docs/archived/M9_RESULT.md)）：三层路由、模型兜底、14 个工具拆到业务模块、有界 `project_status`、读取点三态评估、`cowork-topic` 预设与 memory 识别都已落地并终审通过。代码基线是 `a741e65`，`npm test` 596 pass，`src/tools.ts` 2,489 B，`src/store.ts` 48,590 B（审查线 49,152 B，余量约 562 B）。

但 M9 明确把评审请求、reviewer 生命周期、工作项、隔离合并留给 M10。当时的实现仍是 M3/M4 的链：

- **评审单位与触发。** `cowork_review_request(threadId)` 只对 `awaiting_review` 的 handoff 生效，master 或主题都能调用；reviewer 读最新 handoff 复跑命令，verdict 是独立的 verdict-only 文件（`src/review.ts` 的 `ReviewRecord`）。没有请求范围（`purpose/baseCommit/headCommit/path/changedPaths/previousRequestId`），也没有 requestId 绑定；`pass` 也会 prompt master，主会话随评审事件增长。
- **reviewer 会话。** 每次请求新建 reviewer 已经做了，但创建/回收没有独立模块；verdict 后归档、创建后立即归档会 `blocked` 的探针结论（[M6 探针结果](../../../../docs/archived/M6_PROBE_RESULT.md) §4）只写在注释里，没有集中到可测试的生命周期模块。
- **工作项。** `ProjectIndexV2.workItems` 从 M7 起就是空数组；没有 `cowork_work_item_create`，没有隔离目录/分支记录。`cowork_checkout_merge(threadId)` 仍按旧 thread clone（`.dsh-cowork/threads/<threadId>`、`cowork/<threadId>`）合并，靠 `reviewStatus===pass` 与 `allowUnreviewed` override，不校验同一 head，也不更新工作项。
- **M9 留下的兼容层。** `cowork_handoff` 仍接受 `awaiting_review`；`cowork_project_status` 仍跑 `reconcileIndex` + `replayPendingHandoffs`；读取点固定 `activeWorkItems: 0`；review-tools 仍用 v1 `updateThread` 写 `reviewStatus/latestReviewPath`。这些是 [KNOWN_ISSUES](../../../../docs/KNOWN_ISSUES.md) 的 KI-18（兼容层）、KI-24（工作项计数）、KI-25（旧评审链）；M10 必须收口，不能拖到 M11/M12。

需求、工具角色、数据模型与 M10 验收由 [PLAN-V0.2 §2.2/§2.3/§4.2/§4.3/§4.5/§5.4/§5.5/§5.7/§5.10/§6 M10](../../../../docs/PLAN-V0.2.md) 拥有；评审模型由 [评审按请求触发](../feature/2026-11-07-review-request-model.md) 拥有，隔离与合并由 [并行执行用隔离工作项](./2026-11-07-parallel-isolation-and-merge.md) 拥有，角色由 [主题会话模型](./2026-11-07-topic-session-model.md) 拥有，文件布局由 [索引 v2 与迁移](./2026-11-07-topic-store-v2.md) 拥有。

## Decision

**评审请求（`src/review-request.ts` 纯模型）。** 一次请求一个 `ReviewRequestRecord`：`requestId`（插件生成 UUID）、`topicId`、`workItemId`（可空）、`purpose`、`notes`、`extra`（≤20 键、有界 JSON）、`baseCommit`、`headCommit`、`path`、`branch`、`changedPaths`（由 `git diff --name-only base..head` 派生，模型值必须一致）、`verification`（≤50 行）、`previousRequestId`、`status`、`reviewerSessionId`、`requestedAt`、`reviewedAt`、`summary`、`findings`（≤200 行）、`reviewVerification`。请求文件是 `.dsh-cowork/reviews/<topicId>-<requestId>.json`（`reviewRequestFilePath`）；旧 `<topicId>-<stamp>.json` 的 verdict-only 文件保留只读，新代码不调用 `store.listReviews`/`latestReviews`/`writeReview`。纯模型负责 `validateReviewRequestInput`、`validateReviewVerdictInput`、`buildReviewRequestRecord`、`serialize`/`parse`、`reviewRequestRecordProblems`、`previousRequestId` 链、`deriveReviewOutcome`、`mergeGate`、`buildReviewBrief`、`buildRevisionMessage`/`buildRejectMessage`，以及旧 thread clone 的 `checkLegacyThreadMerge` 门禁。

**请求文件 I/O 在 `src/review-tools.ts`，不进 `store.ts`。** `RequestFiles` 端口（`review-tools.ts:246-283`）组合 store 的 `readText`/`writeTextAtomic`/`withWriteLock` 与本地 `unlink`/`readdir` 的 `listNames`：写走项目锁 + 原子替换，读不加锁，删除忽略 ENOENT。`store.ts` 保持 48,560 B，未越过 49,152 B。

**前置检查先于任何写入。** 必填字段非空；`base` 是 `head` 祖先且 `base !== head`；`path` 规范化后是仓库根或该 topic 的工作项目录；`git status --porcelain` 为空；`git diff` 非空且与 `changedPaths` 一致；同一 topic/work item 无 pending 请求；`previousRequestId` 存在、同 topic、已终结。任一失败返回稳定错误码，不创建 reviewer、不写文件、不写索引。

**reviewer 生命周期（`src/session-visibility.ts`）。** `createReviewerSession` 用 `cowork-reviewer` 预设新建会话并校验返回的 preset；每次请求新建，不复用；`archiveReviewerAfterVerdict` 在 verdict 后用 `archiveSession(id,{stopActivity:true})` 归档，失败返回错误并保留会话；`reviewerSessionIds` 供 M11 面板过滤。主题会话不归档（M6 决策 (b)）。请求流程：校验 → 生成 requestId → 创建 reviewer → 写 pending 文件 → canonical 索引置 `awaitingReview=true`/`reviewStatus='pending'`/`latestReviewRequestId`/`reviewerSessionId` → 投递 brief（范围、证据、上一轮）。brief 失败按「请求文件 → 索引 → reviewer 归档」回滚并写 `error` 活动。

**verdict。** `cowork_review_verdict({requestId, verdict, summary, findings, verification})` 只接受该请求登记的 `reviewerSessionId`，一个请求一次；先写请求文件，再更新 canonical 索引；`needs_revision` 只 prompt 主题，`pass` 在工作项需要合并时写 `merge-needed` 收件箱，`reject` 置 blocked 并写 `review-reject`；verdict 后归档 reviewer；索引写失败保留已落盘 verdict 并报告；投递失败保留未投递项。

**工作项（`src/work-item.ts`）。** `createWorkItem` 从 `baseRef`（默认仓库当前 HEAD）克隆到 `.dsh-cowork/workitems/<workItemId>`、分支 `cowork/<workItemId>`，写 `active` 记录与 `work-item-created` 活动；非法/重复 id、目标目录已存在、provider 非 clone、clone/索引/活动写失败逐路径清理（`workitem/create-failed` / `workitem/cleanup-failed`），失败不留半截索引。`WORK_ITEM_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/`（`src/work-item.ts:41`）比 checkout 的 `TARGET_ID_PATTERN = /^[A-Za-z0-9_-]+$/`（`src/checkout.ts:64`，无长度上界）更严：两者都只接受字母、数字、`_`、`-`，都拒绝 `.`/`..` 与路径分隔符，work-item 另加 128 字符上限；`captureWorkItemHead` 在 canonical clone 内 `git rev-parse HEAD` 并只在 head 变化时更新 `headCommit/updatedAt`；`activeWorkItemCount` 把 `active`+`reviewing` 计为进行中。

**隔离与合并（`src/checkout.ts`、`src/checkout-tools.ts`）。** `checkout.ts` 引入 `IsolationTarget { id, rootRelative, branchPrefix }` 与 `workItemCheckoutPaths`，`createCheckout`/`inspectCheckout`/`mergeCheckout`/`removeCheckout` 同时接受 `target` 与旧 `threadId`，路径守卫 realpath 防逃逸。`registerWorkItemTools` 注册 `cowork_work_item_create`（topic/master），`registerCheckoutTools`（合并工具注册器）重写 `cowork_checkout_merge(workItemId|threadId)`（master only）：要求工作项 `reviewing`、工作区干净、同一 `headCommit` 的 pass；`main`/`master` 保护分支与 detached HEAD 拒绝；`serializeMerge` 用进程级 Promise 链串行；冲突 abort 并保留 clone、报告冲突文件；成功后按 workspace → clone/分支 → 索引更新 teardown，工作项 `merged`，写 `work-item-merged`；清理失败只记录，`main` 不被插件改动。`allowUnreviewed`/`overrideReason` 从合并工具 schema 移除。

**工具面（`src/tools.ts`）。** 15 个工具按文档顺序注册：`project_init`、`project_status`、`route`、`topic_create`、`thread_create`（别名）、`topic_list`、`thread_list`（别名）、`handoff`、`topic_resolve`、`work_item_create`、`review_request`、`review_verdict`、`memory_write`、`memory_search`、`checkout_merge`；`tools.ts` 2,924 B，只做编排。

**`src/review.ts` 在 M10.3 原子删除。** `REVIEWER_PRESET_ID` 已迁到 `src/presets.ts`，legacy `ReviewRecord` 类型与词表迁到 `src/store-schema.ts`，`planMerge` 由 `mergeGate` 取代；`presets.ts`、`checkout-tools.ts`、`store.ts` 的 type-only import 同步改。没有留下第二套 verdict 模型（`store.writeReview` 无生产调用者，`api.ts` 只读旧文件）。

**读取点、handoff 与 M9 遗留收口。** `evaluateProjectLifecycle` 接收 `activeWorkItemsOf(topicId, document)`，在锁内重读文档上按 topic 计算 `active`+`reviewing`（`tool-runtime.ts:417`）；`project-tools` 与 `route-tools` 都传 `activeWorkItemCount`。`cowork_project_status` 删除 `reconcileIndex`/`replayPendingHandoffs`，保留 inbox 重放，新增有界 `workItems`/`reviews` 计数与 topic 行 `activeWorkItems`/`reviewsPending`。`cowork_handoff` 写入只接受 `blocked|done`：`done` 写 digest（≤200）/`lastDeliveryConfirmedAt` 并清标记，`blocked` 置标记并经 `deliverInbox`（`tool-runtime.ts:178`）写一条有界收件箱并 flush；handoff 文件仍写审计，但不再 prompt master 全文，也不再写 `deliveredAt`。persona 与 `buildThreadBrief` 改为请求式评审（master 不再编排评审，主题自行请求，reviewer 按 requestId/范围/证据工作）。Config 增加 `isolation.provider`（默认 `clone`）与 `reviewer.reclaim`（默认/仅 `after-verdict`，启动 guard 拒绝其他值）。

## Alternatives considered

**继续按 handoff 触发评审、由 master 在链路里推进。** 否决：handoff 是主题总结，不是可复核范围；master 每次 verdict 都多一次唤醒，评审的机械推进不需要模型；M10 的验收要求请求字段、requestId 绑定与 needs_revision 不唤醒 master。

**保留 `review.ts` 的 verdict-only 模型并在其上叠加请求字段。** 否决：会同时存在两套 verdict 语义（旧 handoff 链与新请求链），review-tools 与 api 继续写/读 legacy 字段，KI-18/KI-25 无法关闭；模块图（[PLAN §4.2](../../../../docs/PLAN-V0.2.md)）也没有 `review.ts`，应把纯模型收进 `review-request.ts`，删除旧文件并把 legacy 读取留在 store。实际删除在 M10.3 与 review-tools 重写同一提交完成，避免中间态 typecheck 红。

**把新请求文件放到 `reviews/requests/` 或换后缀以避开旧 reader。** 否决：偏离 [索引 v2 与迁移](./2026-11-07-topic-store-v2.md) 规定的 `<topicId>-<requestId>.json`，M11 面板与 M12 文档都要再做一次迁移；旧 `store.listReviews` 在新代码中已无生产调用者，M11 会切到新模型，风险可用测试锁住。

**把评审文件 I/O 加进 `store.ts`。** 否决：余量约 562 B，新增读写/校验必然越过 49,152 B；而且会让 store 重新承担业务规则。最终 I/O 落在 `review-tools.ts` 的窄端口上，`store.ts` 只提供文本与锁能力。

**工作项继续复用 `.dsh-cowork/threads/` 与旧 thread 分支。** 否决：`legacyCheckoutPath` 与旧 clone 是 M2 兼容面；新工作项需要独立的根/分支与记录，否则合并校验无法区分“旧 clone”和“本轮工作项”，清理也会互相影响。`threadId` 只作为旧 clone 的兼容别名保留在 merge 工具参数里。

**直接上 git worktree 适配器。** 否决：M6 探针 7 只证实 reviewer 可读 clone，worktree 的 git 元数据与会话 cwd 关系未验证；M10 先复用 clone，worktree 作为后续适配器（KI-27）。

**保留 `allowUnreviewed` 合并 override。** 否决：M10 的合并门禁是“同一 head 的 pass”；保留 override 等于把绕过评审写进公开工具面。M8/M9 的 override 是为旧评审链过渡，M10 已移除（0.2.0 破坏性变更由 M12 README 记录）。

**创建 reviewer 后立即归档以“隐藏”会话。** 否决：M6 探针 4 已证明会让 turn 以 `blocked` 结束、拿不到 verdict；回收必须 after-verdict，live reviewer 在宿主左侧栏可见是接受的上限，M11 面板过滤（KI-28）。

**合并直接落到 `main` 或自动解决冲突。** 否决：`main` 由人收口（PLAN §2.2/§5.5）；冲突需要业务判断，自动解决会掩盖错误；M10 用保护分支 + 保留现场。

## Consequences

**已交付。** 评审请求、reviewer 生命周期、工作项、串行合并、handoff/status/lifecycle/persona 都在 `feat/m10-review-request-workitems` 落地并通过独立验证与 review；最终代码 artifact HEAD `e25a36f`，`npm test` 701/701，四命令 exit 0；证据、提交序列与回滚见 [M10 交付结果](../../../../docs/archived/M10_RESULT.md)。KI-24（真实工作项计数）与 KI-25（`awaiting_review` 工具面）关闭；KI-18 收窄为剩余只读路径（`api.ts` 的 `latestReviewPath`、`readIndex`/`applyLegacyView`、旧文件只读）。

**接受的偏差。** ① `HandoffStatus` 的读取枚举仍在 `src/store-schema.ts:567` 保留 `awaiting_review`（旧 handoff 文件可读），只有写入校验收窄为 `blocked|done`（`src/handoff.ts:51`）。② 评审文件 I/O 在 `review-tools.ts:246-283`，不在 `review-request.ts`；后者保持纯模型。③ `cowork_project_init` 的 payload 仍返回只读 legacy 视图（`index.threads`），以保持既有调用方；兼容写回 `reconcileIndex` 已删除。④ handoff 文件不再写 `deliveredAt`（审计文件恒 null），legacy submit/replay 已删；旧文件只读。⑤ `src/tool-model.ts:39` 保留 `review/override-reason-required` 码（长稳定错误码表按设计未删，现无调用者）。⑥ `isolation.provider` 只实现 `clone`，worktree 适配器后置（KI-27）。⑦ 评审分级（L0–L3）与用户手动评审 provenance 未实现：PLAN §5.4 无硬需求、M10 验收不含，归属 KI-30（M12 视需要或保持）。⑧ `api.ts` 与面板仍是 v1 thread 形态，M10 的评审请求与工作项要等 M11 切 wire（KI-18 剩余、KI-28）。

**明确不做。** 不迁移旧 handoff/review 数据，不删除旧文件，不自动解决冲突，不自动合并到 `main`，不引入 worktree provider，不做真实宿主 E2E 与真实数据迁移（M12）。`src/m2-e2e.ts`/`src/m3-e2e.ts` 的旧 thread/review 文本保留（KI-29，M12 取代）。

**代价与重估条件。** 合并串行只在进程内保证（KI-26）；每个工作项一次完整 clone 的磁盘/时间成本仍在（KI-1/KI-27）；合并冲突必须人工/发起方处理；`reviewing` 计入进行中会让已解决更保守（延迟自动 resolved 是有意取舍）；reviewer 只读仍是约定不是沙箱（KI-15）；旧会话/旧文件需要 M12 README 统一说明升级与回滚。出现跨进程并发合并、工作项被误自动 resolved、或真实旧数据在 M10 代码下不可读时，重审本决定。

## Testing

- [A1] 请求最小字段校验；缺字段、base 不是 head 祖先、base=head、路径越界、工作树脏、diff 为空、changedPaths 与 git 派生不一致、已有 pending 请求都返回稳定错误且不创建 reviewer/不写索引 — `tests`：`tests/review-request.test.mjs`（`a complete request validates and keeps every field`、`purpose, base, head, path, and verification are required`、`base and head must name different commits and stable commit ids`、`the path must stay inside the repository or the work-item checkout`、`every failed pre-check leaves no reviewer, no file, and no index change`、`a second pending request for the same topic and work item is refused`、`the previous request must exist, belong to the same chain, and be answered`）
- [A2] 请求文件按 `<topicId>-<requestId>.json` 写 `pending`；reviewer 每次新建并由 `reviewerSessionId` 绑定；brief 失败按「请求文件 → 索引 → reviewer」回滚并写 error 活动；同一 topic 同时只有一个 pending — `tests`：`tests/review-request.test.mjs`（`the request file is <topicId>-<requestId>.json under reviews/`、`a shared-tree request writes the pending file, the index, and the brief`、`a brief failure rolls the request back in order and records it`、`an index write failure archives the reviewer and removes the file`）、`tests/session-visibility.test.mjs`（`the reviewer session is created with the reviewer preset and its id`、`after a verdict the reviewer is archived with stopActivity`、`an archive failure is reported and never throws or drops the verdict`）
- [A3] verdict 只接受登记的 reviewer 与 pending requestId；先落盘后更新索引；`needs_revision` 只 prompt 主题，`pass` 需要合并时写 merge-needed 收件箱，`reject` 置 blocked 并写 review-reject；verdict 后归档 reviewer，归档失败保留并记录 — `tests`：`tests/review-verdict.test.mjs`（`a pass verdict with a work item records, merges, and archives`、`needs_revision goes back to the topic only, never to the master`、`a reject verdict blocks the topic and wakes the master`、`only the recorded reviewer may answer the request`、`a request accepts exactly one verdict`、`a failed reviewer archive is reported, not turned into a failed verdict`、`a failed inbox delivery keeps the item undelivered and reports it`）
- [A4] 工作项创建产出 `.dsh-cowork/workitems/<id>` 与 `cowork/<id>`，写入 `WorkItemRecord`（path/branch/baseCommit/status）与活动；非法/重复路径、provider 非 clone、失败清理可断言；role 为 topic/master — `tests`：`tests/work-item.test.mjs`（`createWorkItem clones, writes the active record, and records the activity`、`createWorkItem refuses an unsupported isolation provider before any work`、`createWorkItem refuses a duplicate record or an existing clone before cloning`、`createWorkItem removes the clone and branch when the index write fails`、`cowork_work_item_create clones, records, and activates a work item`、`the master must name an existing topic; a topic creates only for itself`）、`tests/checkout.test.mjs`（`workItemCheckoutPaths maps a work-item id to its clone path and branch`、`createCheckout with a work-item target clones under workitems and branches cowork/<id>`）
- [A5] 合并要求 master、工作项可合并、工作树干净、同一 headCommit 的 pass；拒绝 main/master 保护分支；串行；冲突保留 clone 与现场，解决后重新请求；成功后清理 clone/分支/workspace/session、工作项 merged、写活动，main 不被改动 — `tests`：`tests/work-item.test.mjs`（`a passed work item merges into the current branch and is torn down`、`a head that moved after the review is refused without merging`、`a dirty work-item clone is refused before the merge`、`main and a detached HEAD are protected merge targets`、`a conflicting merge keeps the clone and reports the conflict files`、`a cleanup failure is reported without failing the finished merge`、`the merge gate refuses unknown, non-reviewing, and non-master work items`、`serializeMerge runs merges in order and survives a rejected operation`）、`tests/checkout.test.mjs`（`the merge tool schema no longer accepts an unreviewed override`、`a legacy thread clone with a passed review merges and is torn down`）
- [A6] `cowork_handoff` 只剩 blocked/done；blocked 写收件箱，done 写 digest/交付确认并清标记；`project_status` 删除 handoff 兼容重放、使用真实 active 工作项计数；review 写入 canonical v2（不再写 legacy 字段）；KI-18/24/25 收口或明确剩余归属 — `tests`：`tests/topic-tools.test.mjs`（`cowork_handoff exposes only blocked|done and no longer mentions awaiting_review`、`cowork_handoff(done) records the summary and delivery confirmation without prompting the master`、`cowork_handoff(blocked) sets the flag and wakes the master through one bounded inbox item`）、`tests/project-tools.test.mjs`（`project_status reports work-item and review counts and no handoff replay`、`project_status keeps a topic with active or reviewing work items from resolving (KI-24)`、`project_init no longer reconciles a stale handoff into the index`）、`tests/source-budget.test.mjs`（`KI-25/KI-18: no legacy review writes, and the legacy read-only surface stays`）
- [A7] 15 个工具按文档顺序注册；review_request 仅 topic、review_verdict 仅 reviewer、work_item_create topic/master、checkout_merge master；`tools.ts` 只编排；`dev-gate` 与角色拒绝测试覆盖 — `tests`：`tests/project-tools.test.mjs`（`the assembly registers the fifteen tools in the documented order`）、`tests/dev-gate.test.mjs`（`the business surface registers exactly fifteen tools in the documented order`、`cowork_handoff accepts exactly blocked and done (KI-25)`、`cowork_checkout_merge no longer accepts an unreviewed override (KI-25)`）、`tests/review-verdict.test.mjs`（`only the recorded reviewer may answer the request`）、`tests/work-item.test.mjs`（`the merge tool is master only`）
- [A8] `src/tools.ts` ≤49,152 B、`src/store.ts` 不越过 49,152 B、`src/**/*.ts` <51,200 B；不新增 M11/M12 模块；`npm run check`/`typecheck`/`build`/`test` 全绿 — `source`：`tests/source-budget.test.mjs`（`every src/**/*.ts and src/**/*.tsx file stays under the 50 KiB read limit`、`the tool split owns every tool name and keeps tools.ts orchestration-only`、`the work-item, review-request, and session modules own rules, not tool names`）；最终 `tools.ts` 2,924 B、`store.ts` 48,560 B、最大 `m2-e2e.ts` 49,923 B；`npm test` 701/701、`npm run typecheck`/`build`/`check` exit 0（[M10 交付结果](../../../../docs/archived/M10_RESULT.md)）
- [A9] M10 收口：`review-request` 与 `parallel-isolation` 两份记录迁 implemented 并按骨架重写；`topic-store-v2` 与 `topic-session-model` 已于 M12 迁 implemented 并按骨架重写；写 `docs/archived/M10_RESULT.md` 与交接并更新 `KNOWN_ISSUES` 归属；`npm run check` 无未分类 `.md` — `decisions`：本记录、[评审按请求触发](../feature/2026-11-07-review-request-model.md)、[并行执行用隔离工作项](./2026-11-07-parallel-isolation-and-merge.md)、[M10 交付结果](../../../../docs/archived/M10_RESULT.md)、[KNOWN_ISSUES](../../../../docs/KNOWN_ISSUES.md)、`docs/publish.json`
