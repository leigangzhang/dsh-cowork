# Proposal: M10 评审请求、reviewer 生命周期、工作项与串行合并

Status: proposed
Date: 2026-11-08
Class: architecture

## Problem

M9 已交付（[M9 交付结果](../../../../docs/M9_RESULT.md)）：三层路由、模型兜底、14 个工具拆到业务模块、有界 `project_status`、读取点三态评估、`cowork-topic` 预设与 memory 识别都已落地并终审通过。代码基线是 `a741e65`，`npm test` 596 pass，`src/tools.ts` 2,489 B，`src/store.ts` 48,590 B（审查线 49,152 B，余量约 562 B）。

但 M9 明确把评审请求、reviewer 生命周期、工作项、隔离合并留给 M10。今天的实现仍是 M3/M4 的链：

- **评审单位与触发。** `cowork_review_request(threadId)` 只对 `awaiting_review` 的 handoff 生效，master 或主题都能调用；reviewer 读最新 handoff 复跑命令，verdict 是独立的 verdict-only 文件（[`src/review.ts`](../../../../src/review.ts) 的 `ReviewRecord`）。没有请求范围（`purpose/baseCommit/headCommit/path/changedPaths/previousRequestId`），也没有 requestId 绑定；`pass` 也会 prompt master，主会话随评审事件增长。
- **reviewer 会话。** 每次请求新建 reviewer 已经做了，但创建/回收没有独立模块；verdict 后归档、创建后立即归档会 `blocked` 的探针结论（[M6 探针结果](../../../../docs/M6_PROBE_RESULT.md) §4）只写在注释里，没有集中到可测试的生命周期模块。
- **工作项。** `ProjectIndexV2.workItems` 从 M7 起就是空数组；没有 `cowork_work_item_create`，没有隔离目录/分支记录。`cowork_checkout_merge(threadId)` 仍按旧 thread clone（`.dsh-cowork/threads/<threadId>`、`cowork/<threadId>`）合并，靠 `reviewStatus===pass` 与 `allowUnreviewed` override，不校验同一 head，也不更新工作项。
- **M9 留下的兼容层。** `cowork_handoff` 仍接受 `awaiting_review`；`cowork_project_status` 仍跑 `reconcileIndex` + `replayPendingHandoffs`；读取点固定 `activeWorkItems: 0`；review-tools 仍用 v1 `updateThread` 写 `reviewStatus/latestReviewPath`。这些是 [KNOWN_ISSUES](../../../../docs/KNOWN_ISSUES.md) 的 KI-18（兼容层）、KI-24（工作项计数）、KI-25（旧评审链）；M10 必须收口，不能拖到 M11/M12。

需求、工具角色、数据模型与 M10 验收由 [PLAN-V0.2 §2.2/§2.3/§4.3/§4.5/§5.4/§5.5/§5.7/§5.10/§6 M10](../../../../docs/PLAN-V0.2.md) 拥有；评审模型由 [评审按请求触发](../feature/2026-11-07-review-request-model.md) 拥有，隔离与合并由 [并行执行用隔离工作项](./2026-11-07-parallel-isolation-and-merge.md) 拥有，角色由 [主题会话模型](./2026-11-07-topic-session-model.md) 拥有，文件布局由 [索引 v2 与迁移](./2026-11-07-topic-store-v2.md) 拥有。本记录只固定执行层：模块边界、文件与索引写入、工具顺序、合并目标、reviewer 回收、M9 兼容层的删除顺序与测试影响面。

## Proposal

**1) 评审请求文件（新格式；旧文件只读，不迁移）。**

新增 `ReviewRequestRecord`，一次请求一个文件：

```ts
interface ReviewRequestRecord {
  version: 1
  requestId: string
  topicId: string
  workItemId: string | null
  purpose: string
  notes: string
  extra: Record<string, JsonValue>      // 最多 20 个键，值只接受有界 JSON
  baseCommit: string
  headCommit: string
  path: string                          // 仓库根或某个工作项目录
  branch: string | null
  changedPaths: string[]                // 由 git diff base..head 派生，不接受模型伪造
  verification: ReviewVerification[]    // 请求者实际跑过的检查
  previousRequestId: string | null
  status: 'pending' | 'pass' | 'needs_revision' | 'reject'
  reviewerSessionId: string | null
  requestedAt: string
  reviewedAt: string | null
  summary: string | null
  findings: ReviewFinding[]
  reviewVerification: ReviewVerification[]
}
```

- 文件路径 `.dsh-cowork/reviews/<topicId>-<requestId>.json`；`requestId` 由插件生成（UUID），文件名不再靠时间戳猜。
- 旧 `<topicId>-<stamp>.json` 的 verdict-only `ReviewRecord` 保留只读；不迁移、不重写。新代码不调用 `store.listReviews`/`latestReviews`/`writeReview`；旧读取器留给 M11 面板过渡与 M12 清理（同日录下的 [索引 v2 与迁移](./2026-11-07-topic-store-v2.md) 已规定旧 review 文件只读）。
- **文件 I/O 不放进 `store.ts`。** `store.ts` 只剩约 562 B 余量，M10 不得往它加评审业务代码。`review-request.ts` 接收一个窄端口：`readText(absPath)`、`writeTextAtomic(absPath, text)`、`withWriteLock(op)`、`listNames()`；前三个由 `store.ts` 现有公开方法实现，`listNames` 由 `tool-runtime.ts` 用 `node:fs/promises.readdir` 读取 `reviews/`。写仍走项目锁与原子替换；读不加锁（M7 规则）。
- 同一 topic（或同一 work item）最多一个 `pending` 请求；新请求必须先有上一轮结果或显式取消，`previousRequestId` 只在同 topic 内有效。

**2) 模块边界。**

- `src/review-request.ts`（新）：纯模型与文件层——字段校验（最小集、`extra` 上限、findings 规则）、记录构造/序列化/解析、文件名、从 request 派生 verdict、`previousRequestId` 链、`buildReviewBrief`、request→topic/work-item 的状态映射、合并前置门禁（同一 `headCommit` 的 pass）。
- `src/review-tools.ts`（重写）：只保留两个工具与流程编排；角色守卫（request 仅 topic，verdict 仅 reviewer）、创建 reviewer、写 pending、brief、失败回滚、verdict 落盘/索引/通知/归档/活动。
- `src/session-visibility.ts`（新）：reviewer 生命周期与可见性——`createReviewerSession`（preset 校验）、`archiveReviewerAfterVerdict`（`stopActivity:true`，失败保留并记录）、`reviewerSessionIds(index)`（M11 面板过滤）。主题会话保持左侧栏可见（M6 决策 (b)），本模块**不**归档主题；live reviewer 在宿主的左侧栏仍可能可见，M10 的“隐藏”指 CoWork/面板不列 reviewer，verdict 后归档。
- `src/work-item.ts`（新）：工作项领域——`createWorkItem`（clone 创建、失败回收）、`activeWorkItemCount(document, topicId)`（`active` + `reviewing` 都算进行中）、`markWorkItemReviewing/merged/abandoned`、`captureHead`、`mergeGate`（同一 head 的 pass、工作区干净、状态可合并）、工作项视图。
- `src/checkout.ts`（扩展）：把 clone 路径/分支参数化为 `IsolationTarget { id, rootRelative, branchPrefix }`，新增 `workItemCheckoutPaths`（`.dsh-cowork/workitems/<id>`、`cowork/<id>`）；旧 thread 默认值保持不变，`cowork_checkout_merge(threadId)` 兼容别名仍可合旧 clone。
- `src/checkout-tools.ts`：新增 `cowork_work_item_create`；重写 `cowork_checkout_merge`（`workItemId` 必填，`threadId` 兼容别名）。
- `src/review.ts`（删除）：`REVIEWER_PRESET_ID` 移到 `presets.ts`；legacy `ReviewRecord` 类型移到 `store-schema.ts`（`REVIEW_STATUSES`/`reviewRecordProblems` 已在）；`planMerge` 由 `work-item.ts` 的 `mergeGate` 取代。`presets.ts`、`checkout-tools.ts`、`store.ts` 的 type-only import 同步改；`tests/review.test.mjs` 改写/迁移，旧 verdict-only 工具测试合并进新套件。
- `src/tool-runtime.ts`：`evaluateProjectLifecycle` 接收 `activeWorkItemsOf(topicId)` 回调（替换固定 0）；新增 `deliverInbox` 帮助函数（Inbox 投递 + 失败保留）；review/work-item 的错误码集中到 `tool-model.ts`。
- `src/project-tools.ts`：`cowork_project_status` 删除 `reconcileIndex` + `replayPendingHandoffs` 兼容窗口；增加 `workItems` 计数与 `reviews.pending` 有界摘要；读取点用真实工作项计数。
- `src/topic-tools.ts`：`cowork_handoff` 只接受 `blocked|done`；`blocked` 写 `blocked` 收件箱并投递，`done` 写 digest/交付确认并清标记；删除 `awaiting_review` 分支与 v1 映射假设。
- `src/presets.ts`：master persona 删除 `awaiting_review`/`review_request` 编排；主题 persona 明确“完成或阻塞先 handoff，需要评审时自己调用 `cowork_review_request`”；reviewer persona 按 requestId/范围/证据工作，不读 handoff 全文。
- `src/index.ts`：Config 增加 `isolation.provider`（默认 `'clone'`）与 `reviewer.reclaim`（默认 `'after-verdict'`，M10 只支持该值）；装配新的端口与工具模块。

**3) 工具面与角色。**

| 工具 | 角色 | 参数 / 行为 |
|---|---|---|
| `cowork_work_item_create` | topic/master | `topicId?`、`baseRef?`（默认 HEAD）；clone 到 `.dsh-cowork/workitems/<id>`、分支 `cowork/<id>`，写 `WorkItemRecord` 与 `work-item-created` 活动；返回 `{workItemId,path,branch,baseCommit}`。非法/重复路径、provider 非 `clone`、clone 或索引写失败都要回滚并报 cleanup。 |
| `cowork_review_request` | **topic only** | `purpose`、`baseCommit`、`headCommit`、`path`、`verification` 必填；`workItemId?`、`previousRequestId?`、`notes?`、`extra?`。校验后创建 reviewer、写 pending、置 `awaitingReview=true`/`reviewStatus='pending'`/`latestReviewRequestId`/`reviewerSessionId`，投递 brief；失败回滚为未请求并归档半成品。 |
| `cowork_review_verdict` | **reviewer only** | `requestId`、`verdict`、`summary`、`findings`、`verification`；调用者必须等于该请求的 `reviewerSessionId`；一个请求只允许一次 verdict。先写 verdict 到请求文件，再更新 topic/work item；`needs_revision` 只投回主题；`pass` 需要合并时写收件箱 `merge-needed`；`reject` 置 blocked 并写 `review-reject`；完成后归档 reviewer。 |
| `cowork_checkout_merge` | master | `workItemId` 必填；`threadId` 兼容旧 clone；要求工作项可合并、工作区干净、同一 `headCommit` 的评审 pass；**移除 `allowUnreviewed` override**（0.2.0 破坏性变更，M12 README 记录）；串行合并；冲突保留现场并返回冲突文件；成功后清理 clone/分支/workspace/session，工作项 `merged`，写 `work-item-merged`；`main` 不被插件修改。 |
| `cowork_handoff` | topic | `blocked|done`（`awaiting_review` 删除）；`blocked` 置 blocked 并写 `blocked` 收件箱；`done` 写 digest、`lastDeliveryConfirmedAt`、清 blocked/awaitingReview；不再把全文 prompt 给 master（旧 handoff 文件继续按现状写入作审计，读取仅 legacy）。 |

注册顺序（15 个名字）：`project_init`、`project_status`、`route`、`topic_create`、`thread_create`（别名）、`topic_list`、`thread_list`（别名）、`handoff`、`topic_resolve`、`work_item_create`、`review_request`、`review_verdict`、`memory_write`、`memory_search`、`checkout_merge`。`tools.ts` 仍只做编排。

**4) 请求前置检查（确定性、先于任何写入）。**

- 必填字段非空；`purpose`、`verification` 有界；`extra` ≤20 键。
- `baseCommit`/`headCommit` 是 commit；`base` 是 `head` 的祖先（`git merge-base --is-ancestor`）；`base !== head`。
- `path` 规范化后必须等于仓库根或该 topic 的工作项目录；越界拒绝。
- `git -C <path> status --porcelain` 为空（工作项目录必须干净；共享工作区评审也要求干净）。
- `git diff --name-only base..head` 非空；`changedPaths` 由该命令派生，模型传入的值必须与派生结果一致（不允许只评审一部分却声明整体）。
- 该 topic/work item 没有 pending 请求；`previousRequestId`（若给）存在且属于同一 topic，且是最终状态。
- 任一失败返回稳定错误码，不创建 reviewer、不写索引。

**5) reviewer 生命周期与通知顺序。**

- 请求：检查 → 生成 requestId → 创建 reviewer 会话（隐藏/归档语义见模块边界）→ 写请求文件 pending → canonical 索引置 pending → 投递 brief。brief 失败：删除刚写的请求文件、回滚索引标记、归档 reviewer、写 `error` 活动；索引写失败同样归档 reviewer。
- verdict：校验（caller=reviewer、请求 pending）→ 写 verdict 进同名文件（先落盘，索引随后）→ canonical 索引更新（`awaitingReview=false`、`reviewStatus`、`latestReviewRequestId`、`reviewerSessionId=null`）→ topic/work item 状态与 head → `needs_revision` prompt 主题；`pass`/`reject` 通过 `Inbox.enqueue + flush` 投递 master → 归档 reviewer → `review-verdict` 活动。
- 任一投递/归档失败只记录并保留可重放状态（inbox 继续由 `project_status` 重放；reviewer 归档失败保留会话并记录），不把失败伪装成成功，也不回滚已落盘的 verdict。
- reviewer 每次新建、不复用；归档用 `archiveSession(id,{stopActivity:true})`；创建后立即归档禁止（M6 探针 4）。

**6) 工作项、隔离与合并。**

- 隔离：`clone` provider（v1）创建 `.dsh-cowork/workitems/<workItemId>`，分支 `cowork/<workItemId>`，从 `baseRef`（默认仓库当前 HEAD）创建；索引记录 `baseCommit`；后续请求/合并前刷新 `headCommit`。
- 工作项状态：`active` → `reviewing`（存在 pending 请求）→ `merged`（合并成功）或 `abandoned`；`active`/`reviewing` 都算“进行中”，用于已解决条件（KI-24）。
- 合并前置：master、工作项存在且状态允许、clone 干净、当前 head 与最近一次 pass 请求的 `headCommit` 完全一致；`base` 祖先关系再校验一次。
- 合并目标：**仓库当前检出的分支**，并强制保护默认分支——若 `git rev-parse --abbrev-ref HEAD` 是 `main`/`master`（或配置的保护分支），拒绝并返回 `checkout/protected-branch`，要求 master/用户先切到工作分支或集成分支。这样 `cowork_checkout_merge` 永远不会直接改动 `main`；人工负责最终把集成分支合入 `main`。
- 串行：`checkout-tools.ts` 内用进程级 Promise 链串行化合并（同一 DSH 实例；跨进程不在 M10 保证，风险记录）；冲突时保留 clone、工作项回到可处理状态，返回冲突文件，解决后重新请求评审。
- 成功后按 M2 的 teardown 顺序清理 clone/工作区/会话，更新工作项与主题、写活动；清理失败只记录，不回滚已完成的合并。
- 共享工作区请求（`workItemId=null`）：请求 `path=repo`，不产生工作项，不执行合并；`pass` 只确认交付，不写 merge-needed。

**7) 读取点、handoff 与 M9 遗留。**

- `evaluateProjectLifecycle` 改为按 topic 计算 `activeWorkItemsOf`：`workItems` 中该 topic 的 `active` 或 `reviewing` 计为进行中；`merged`/`abandoned` 不计。`project_status`、`route`、`turn/end`（若复用）都用同一函数（KI-24 关闭）。
- `cowork_project_status` 删除 handoff 兼容重放与 `reconcileIndex`；保留 inbox 重放；新增 `workItems` 计数与 `reviews.pending`（≤10）有界字段；payload 仍有界。
- `cowork_handoff` 删除 `awaiting_review`；旧 v1/v2 里的 `awaitingReview` 旧值不做数据迁移，由下一次 canonical 写或 verdict 覆盖（KI-25 关闭时说明未迁移的残留）。
- review 写入全部 canonical v2：不再写 `latestReviewPath`/`reviewRequestedAt`/`reviewedAt` 等 legacy 字段；`store.applyLegacyView`/`readIndex` 只留给 api、旧 clone 合并与 M11 过渡（KI-18 从 M10 后只剩读路径与 M11/M12 清理）。
- 旧 handoff/review 文件保留只读；新代码不读取旧 verdict 作为当前状态。

**8) 配置。**

- `isolation.provider`：默认 `'clone'`；M10 只实现 clone，未知值在 `cowork_work_item_create` 返回明确错误（不静默回退）。
- `reviewer.reclaim`：默认 `'after-verdict'`；M10 只支持该值，配其他值启动即报错（避免声称支持 immediate）。

**9) 测试与预算影响面（派单前必须扫描）。**

- 新测试：`tests/review-request.test.mjs`（校验、记录、文件、previous 链、merge gate）、`tests/work-item.test.mjs`（路径/分支/创建回滚/active 计数/状态/merge 前置）、`tests/session-visibility.test.mjs`（创建、after-verdict 归档、失败保留）。
- 重写/更新：`tests/review.test.mjs`（review.ts 删除后按新模型拆分）、`tests/review-verdict.test.mjs`（requestId/verdict 绑定、inbox、归档）、`tests/checkout.test.mjs`（target 参数化、protected branch、旧 thread 兼容）、`tests/project-tools.test.mjs`（status 字段、active 计数、移除 compat replay、15 工具顺序）、`tests/topic-tools.test.mjs`（handoff blocked/done、inbox、不再 awaiting_review）、`tests/dev-gate.test.mjs`（15 工具、presets 不变）、`tests/source-budget.test.mjs`（新模块归属、tools.ts ≤49,152）、`tests/api.test.mjs`（legacy review fixtures 与 M11 过渡）、`tests/presets.test.mjs`（`REVIEWER_PRESET_ID` 来源）、`tests/tools-init.test.mjs`（若 init 依赖不变则不动）。
- `src/m2-e2e.ts`/`src/m3-e2e.ts` 的旧 thread/review 流程不再与新工具面一致，但它们只是 dev 面且测试只检查 runner 源码文本；M10 不改它们，在 KNOWN_ISSUES 注明“legacy dev E2E 由 M12 真实 E2E 取代”，不要为它们保留旧工具语义。
- 预算：`src/store.ts` 不增长（review 文件 I/O 走文本端口；若必须改 store，先停下报告拆分方案）；`src/tools.ts` ≤49,152 B；所有 `src/**/*.ts` <51,200 B；`npm run check`/`typecheck`/`build`/`test` 全绿。

## Alternatives considered

**继续按 handoff 触发评审、由 master 在链路里推进。** 否决：handoff 是主题总结，不是可复核范围；master 每次 verdict 都多一次唤醒，评审的机械推进不需要模型；M10 的验收要求请求字段、requestId 绑定与 needs_revision 不唤醒 master。

**保留 `review.ts` 的 verdict-only 模型并在其上叠加请求字段。** 否决：会同时存在两套 verdict 语义（旧 handoff 链与新请求链），review-tools 与 api 继续写/读 legacy 字段，KI-18/KI-25 无法关闭；模块图（[PLAN §4.2](../../../../docs/PLAN-V0.2.md)）也没有 `review.ts`，应把纯模型收进 `review-request.ts`，删除旧文件并把 legacy 读取留在 store。

**把新请求文件放到 `reviews/requests/` 或换后缀以避开旧 reader。** 否决：偏离 [索引 v2 与迁移](./2026-11-07-topic-store-v2.md) 规定的 `<topicId>-<requestId>.json`，M11 面板与 M12 文档都要再做一次迁移；旧 `store.listReviews` 在新代码中已无生产调用者，M11 会切到新模型，风险可用测试锁住。

**把评审文件 I/O 加进 `store.ts`。** 否决：余量约 562 B，新增读写/校验必然越过 49,152 B；而且会让 store 重新承担业务规则。使用现有 `readText`/`writeTextAtomic`/`withWriteLock` + 一个 list 端口即可。

**工作项继续复用 `.dsh-cowork/threads/` 与旧 thread 分支。** 否决：`legacyCheckoutPath` 与旧 clone 是 M2 兼容面；新工作项需要独立的根/分支与记录，否则合并校验无法区分“旧 clone”和“本轮工作项”，清理也会互相影响。

**直接上 git worktree 适配器。** 否决：M6 探针 7 只证实 reviewer 可读 clone，worktree 的 git 元数据与会话 cwd 关系未验证；M10 先复用 clone，worktree 作为后续适配器（见 [并行隔离与合并](./2026-11-07-parallel-isolation-and-merge.md)）。

**保留 `allowUnreviewed` 合并 override。** 否决：M10 的合并门禁是“同一 head 的 pass”；保留 override 等于把绕过评审写进公开工具面。M8/M9 的 override 是为旧评审链过渡，M10 必须移除（破坏性变更 M12 记录）。

**创建 reviewer 后立即归档以“隐藏”会话。** 否决：M6 探针 4 已证明会让 turn 以 `blocked` 结束、拿不到 verdict；回收必须 after-verdict，live reviewer 在宿主左侧栏可见是接受的上限，M11 面板过滤。

**合并直接落到 `main` 或自动解决冲突。** 否决：`main` 由人收口（PLAN §2.2/§5.5）；冲突需要业务判断，自动解决会掩盖错误；M10 用保护分支 + 保留现场。

## Acceptance criteria

- [A1] 请求最小字段校验；缺字段、base 不是 head 祖先、base=head、路径越界、工作树脏、diff 为空、changedPaths 与 git 派生不一致、已有 pending 请求都返回稳定错误且不创建 reviewer/不写索引 — `tests`
- [A2] 请求文件按 `<topicId>-<requestId>.json` 写 `pending`；reviewer 每次新建并由 `reviewerSessionId` 绑定；brief 失败按顺序回滚请求文件、索引与 reviewer，并写 error 活动；同一 topic 同时只有一个 pending — `tests`
- [A3] verdict 只接受登记的 reviewer 与 pending requestId；先落盘后更新索引；`needs_revision` 只 prompt 主题，`pass` 需要合并时写 merge-needed 收件箱，`reject` 置 blocked 并写 review-reject；verdict 后归档 reviewer，归档失败保留并记录— `tests`
- [A4] 工作项创建产出 `.dsh-cowork/workitems/<id>` 与 `cowork/<id>`，写入 `WorkItemRecord`（path/branch/baseCommit/status）与活动；非法/重复路径、provider 非 clone、失败清理可断言；role 为 topic/master — `tests`
- [A5] 合并要求 master、工作项可合并、工作树干净、同一 headCommit 的 pass；拒绝 main/master 保护分支；串行；冲突保留 clone 与现场，解决后重新请求；成功后清理 clone/分支/workspace/session、工作项 merged、写活动，main 不被改动 — `tests`
- [A6] `cowork_handoff` 只剩 blocked/done；blocked 写收件箱，done 写 digest/交付确认并清标记；`project_status` 删除 handoff 兼容重放、使用真实 active 工作项计数；review 写入 canonical v2（不再写 legacy 字段）；KI-18/24/25 在本阶段收口或明确剩余归属 — `tests`
- [A7] 15 个工具按文档顺序注册；review_request 仅 topic、review_verdict 仅 reviewer、work_item_create topic/master、checkout_merge master；`tools.ts` 只编排；`dev-gate` 与角色拒绝测试覆盖 — `tests`
- [A8] `src/tools.ts` ≤49,152 B、`src/store.ts` 不越过 49,152 B、`src/**/*.ts` <51,200 B；不新增 M11/M12 模块（api-contract/client/面板、真实 E2E、迁移演练不在 M10）；`npm run check`/`typecheck`/`build`/`test` 全绿 — `source`
- [A9] M10 收口：`review-request` 与 `parallel-isolation` 两份记录迁到 implemented 并按骨架重写；`topic-store-v2` 与 `topic-session-model` 仍在 M11/M12 收口；写 `docs/M10_RESULT.md` 与交接并更新 `KNOWN_ISSUES` 归属；`npm run check` 无未分类 `.md` — `decisions`

## Risks

- **旧 review 文件与新请求文件同目录。** 新代码不再调用 `store.listReviews`/`latestReviews`/`writeReview`，但 api.ts 与 M3 旧路径仍读 `latestReviewPath`；新请求不会写该字段，旧评审卡在 M10 后可能暂时为空，M11 切到请求文件。重审条件：api 测试或面板读取到新格式文件而报错。
- **store 预算。** 余量 562 B 是硬约束；如果合并前发现必须改 store，先停下来做文件拆分（把 legacy review 读取移出 store），不要在 M10 里压行。
- **合并串行只在单进程内。** M10 用进程级 Promise 链保证同一 DSH 实例的合并顺序；多个宿主同时对同一仓库合并不在保证范围（与 worktrees 插件的已知边界一致）。重审条件：出现跨进程并发合并或重复合并。
- **合入目标与保护分支。** 若当前仓库在 main/master 上，M10 拒绝合并并提示切分支；真实使用要求主题/用户在集成分支上工作。重审条件：用户频繁在 main 上操作，或真实 E2E 发现保护分支识别不可靠（remote HEAD 缺失时以 main/master 名单兜底，需要写清）。
- **评审期间 head 移动。** 请求绑定固定 head；合并前重新核对同一 head，旧 pass 失效；reviewer 读到的就是请求时的 head。重审条件：出现过期 verdict 被合并。
- **reviewer 只读是约定不是沙箱（KI-15）。** bash 仍能写；M10 不引入只读沙箱；reviewer 可能改文件的风险保持并记录。
- **active 工作项分类。** `reviewing` 计入进行中会让已解决更保守（不误标），但可能延迟自动 resolved；这是有意的取舍。重审条件：出现工作项已合并但主题长期不 resolved，或反之误 resolved。
- **working tree 保护分支识别。** 无 remote 或 detached HEAD 时的默认分支判定可能不准；以 `main`/`master` 名单 + 无法判定时拒绝合并为兜底。重审条件：真实仓库出现误拒/误放行。
- **clone 成本与磁盘。** 每个工作项一次完整 clone（已知 KI-1）；M10 不解决，worktree 适配器后置。
- **M9 遗留清理的破坏性。** `awaiting_review`、`allowUnreviewed`、legacy review 写入被移除；旧会话/旧文件保持只读，M12 README 统一说明升级与回滚。

## Delivery stages

1. **M10.1 纯模型、schema、配置与 review.ts 退役**：`review-request.ts`/`work-item.ts` 的纯部分与测试；`REVIEWER_PRESET_ID`/legacy 类型迁移；Config 加 `isolation.provider`/`reviewer.reclaim`；删除 `review.ts` 并改 import；`npm test`/typecheck 绿。
2. **M10.2 工作项与 checkout 泛化**：`checkout.ts` target/路径/分支参数化，`work-item.ts` 创建流程与失败清理，`checkout-tools.ts` 注册 `cowork_work_item_create`；新 `tests/work-item.test.mjs`，扩展 `tests/checkout.test.mjs`；旧 thread clone 测试保持绿。
3. **M10.3 评审请求与 verdict 生命周期**：`session-visibility.ts`、`review-tools.ts` 重写、请求前置检查与文件/索引写入、brief、rollback、inbox 通知与 reviewer 归档；`tests/review-request.test.mjs`、`tests/review-verdict.test.mjs`、`tests/session-visibility.test.mjs`；api 过渡面保持绿。
4. **M10.4 合并、handoff、status、lifecycle 与 persona**：`cowork_checkout_merge(workItemId|threadId)`、保护分支、串行/冲突/清理；`cowork_handoff` blocked/done + 收件箱；`project_status` 去兼容重放 + workItems/reviews 摘要；真实 active 计数；15 工具顺序与 dev-gate/presets/source-budget 更新；定向与全量测试绿。
5. **M10.5 收口**：`review-request`、`parallel-isolation` 迁 implemented 并按骨架重写；`docs/M10_RESULT.md`、`docs/M10_HANDOFF.md`、`KNOWN_ISSUES`、`publish.json`；四命令全绿、artifact 身份绑定、review pass 后停等确认，不进入 M11。
