# M10 交付结果

- 状态：**M10 已交付（2026-11-08）**。评审请求、reviewer 生命周期、工作项与串行合并、handoff/status/persona 收口在 `feat/m10-review-request-workitems` 上落地；独立验证与隔离 review 均通过。本文件记录交付基线、清单、证据、审查与修复、偏差、回滚与未验证项，供 M11 接手。M10 启动时的交接见 [M10_HANDOFF.md](M10_HANDOFF.md)（保留启动版，状态行指向本文件）。执行层决定见 [M10 执行提案](../.agents/notes/proposed/architecture/2026-11-08-m10-review-request-workitems-plan.md)（仍 proposed）；评审规则与工作项/合并边界见已迁移的两份记录（[评审按请求触发](../.agents/notes/implemented/feature/2026-11-07-review-request-model.md)、[并行隔离与合并](../.agents/notes/implemented/architecture/2026-11-07-parallel-isolation-and-merge.md)）。
- 适用：接手 V0.2 M11（面板/API v2 与会话可见性）的 agent 或人。范围：M10 的实际交付、验证证据、偏差与未验证项；不重新论证 M10 的决定。
- 事实源：[PLAN-V0.2](PLAN-V0.2.md) §2.2/§2.3/§4.2/§4.3/§4.5/§5.4/§5.5/§5.7/§5.10/§6 M10 拥有需求、数据模型、工具角色与验收；执行层决定、备选与测试影响面由 [M10 执行提案](../.agents/notes/proposed/architecture/2026-11-08-m10-review-request-workitems-plan.md) 拥有；评审规则与隔离/合并边界由两份 implemented 记录拥有；[KNOWN_ISSUES](KNOWN_ISSUES.md) 拥有遗留归属；本文件只拥有「交付了什么、拿什么证明、从哪继续」。
- **数字口径**：下列 HEAD、diff sha、测试计数与字节是**批量修复轮之前**（代码 HEAD `e683a12`）的冻结前实测；review 后的批量修复（R1/R2）会改变 HEAD 与计数，最终数字由收口 fact-sync 按最终 artifact 修订，本文件的结构与结论不随之改写。

## 交付基线

- **分支**：`feat/m10-review-request-workitems`，从 M9 交付后的 `feat/m9-routing-tools-presets` 基线 `4e05954` 切出；未 push、未合并。
- **冻结前代码 HEAD**：`e683a1260fc583b1374e1f095b5afc61d9787a59`；`git diff 4e05954..HEAD | shasum -a 256` = `5e40f01b59a9f64071154b9c4ccfc719abe7a0abda5e5d3d4a1827293eda9dab`；验证与 review 均以该 HEAD 为身份。
- **批量修复提交（t14，冻结后、本文档提交前）**：`8b01c8a`（fix(topic): never auto-resolve a topic whose review needs revision，R1）、`a69b772`（fix(work-item): align the id pattern with the checkout path guard，R2）、`ea3bbb6`（docs(index): say fifteen tools in the assembly comment）。它们改变 HEAD 与测试计数；**最终 HEAD、diff sha、四命令与计数由收口 fact-sync 按最终 artifact 修订**，本文件其余数字仍为冻结前实测。
- **artifact 身份**：integration-ready artifact 落在 `/tmp/m10-integration-ready.json`（1,110 B，JSON 校验通过），记录同一 repo/分支/base/HEAD/diff sha 与四命令结果；verification（t9）与 review（t10）在各自副本重算身份并复跑，均与 artifact 一致。
- **提交序列（`4e05954..e683a12`，按阶段）**：
  - M10.1 纯模型/配置：`5890866`（legacy review 类型迁入 store-schema）、`1197a77`（REVIEWER_PRESET_ID 归 presets）、`49b4d73`（M10 错误码表）、`128f945`（work-item 纯模型）、`422b0ad`（review-request 纯模型与 merge gate）、`419afab`（Config isolation.provider/reviewer.reclaim + 启动 guard）、`b1b6291`（Config 默认值测试）、`7be1d1c`（复用 mergeable 判定）、`2f68f29`（记录数组解析收敛）。
  - M10.2a 隔离参数化与工作项创建：`a2c6d89`（checkout IsolationTarget）、`125c2f1`（createWorkItem/captureWorkItemHead）→ 集成 `8121992`。
  - M10.2b 合并门禁与工作项工具：`5fb3ad9`（cowork_work_item_create 与 checkout_merge(workItemId)）、`fdf559e`（合并/冲突/清理测试）→ 集成 `3ba43b4`。
  - M10.3 评审请求与 verdict 生命周期：`1df5336`（session-visibility）、`1fa4a0b`（verdict 校验与评审消息）、`77a5eda`（review-tools 切请求模型并删除 `src/review.ts`）、`b2311a4`（结果 payload 有界）。
  - M10.4a handoff/status/lifecycle/persona：`7f30a3d`（status 去重放 + 真实计数 + deliverInbox）、`c557d0f`（handoff blocked|done + 收件箱）、`bbf9ddc`（persona 与 brief）→ 集成 `a9dd037`。
  - M10.4b 工具面收口：`34d54ba`（15 工具顺序与守卫）、`65cb0fc`（移除 allowUnreviewed override）、`e683a12`（模块归属与 KI-18/24/25 断言）。
  - M10.5 文档：本提交（只改 `docs/**`、`.agents/notes/**`、`docs/publish.json`）。
- **验证基线（冻结前 `e683a12`，integration-ready、verification 与 review 三处独立复跑一致）**：`npm test` **698 tests / 698 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo**，exit 0（M9 基线 596；M10 新增/改写后为 698，其中 `tests/work-item.test.mjs` 与 `tests/review-request.test.mjs` 为本阶段新增/大改）；`npm run typecheck` exit 0；`npm run build` exit 0（`lib/` + `lib/client.js` 69 KB）；`npm run check` exit 0（`check-invariants: ok`）。
- **代码形态（冻结前）**：`src/tools.ts` **2,924 B**（只做 15 工具编排）；`src/store.ts` **48,560 B**（<49,152 B 审查线）；`src/review-request.ts` 48,758 B；`src/work-item.ts` 23,234 B；`src/session-visibility.ts` 4,578 B；`src/handoff.ts` 8,986 B（删除 legacy submit/replay 后缩小）；`src/**/*.ts` 最大仍是 `src/m2-e2e.ts` 49,923 B（未改，硬上限 51,200 B）。
- **范围证据**：`git diff --name-only 4e05954..e683a12` 共 **35 个文件**——`src/` 19 个、`tests/` 16 个；删除 `src/review.ts` 与 `tests/review.test.mjs`；新增 `src/review-request.ts`、`src/work-item.ts`、`src/session-visibility.ts`；无 `src/client/**`、`src/api*.ts`、`presets/**` 改动；M11/M12 模块（面板/API v2、真实 E2E、迁移演练）不存在。

## 交付清单

- **M10.1 纯模型与配置（`review-request.ts`、`work-item.ts`、`store-schema.ts`、`index.ts`、`tool-model.ts`）**：`ReviewRequestRecord` 的最小字段校验（`purpose/base/head/path/verification`、`extra` ≤20 键、`changedPaths` 由 diff 派生、previous 链、合并门禁 `mergeGate`）、记录序列化/解析、请求文件名 `<topicId>-<requestId>.json`、`buildReviewBrief`；`WorkItemRecord` 建造/标记/有界视图与 `activeWorkItemCount`（`active`+`reviewing`）；legacy `ReviewRecord` 类型迁入 `store-schema.ts`；Config 增加 `isolation.provider`（默认 `clone`）与 `reviewer.reclaim`（默认/仅 `after-verdict`，启动拒绝其他值）；M10 错误码集中到 `tool-model.ts`。
- **M10.2 隔离与工作项（`checkout.ts`、`work-item.ts`、`checkout-tools.ts`、`checkout-teardown.ts`）**：`IsolationTarget { id, rootRelative, branchPrefix }` 与 `workItemCheckoutPaths`；四个 checkout 操作同时接受 `target` 与旧 `threadId`，路径守卫校验 id/root/分支并 realpath 防逃逸；`createWorkItem` 克隆、写 `active` 记录与 `work-item-created`、失败逐路径清理；`cowork_work_item_create`（topic/master）；`cowork_checkout_merge(workItemId|threadId)` 要求 `reviewing`、干净、同一 head 的 pass，保护 `main`/`master`/detached HEAD，进程级串行，冲突保留 clone，成功后 teardown 并写 `work-item-merged`；`allowUnreviewed`/`overrideReason` 从工具面移除。
- **M10.3 评审请求与 verdict（`session-visibility.ts`、`review-tools.ts`、`review-request.ts`）**：reviewer 每次新建（`cowork-reviewer`）、brief 含范围/证据/上一轮、失败按「请求文件 → 索引 → reviewer」回滚；verdict 绑定 requestId 与 reviewerSessionId、一个请求一次、先落盘后索引；`needs_revision` 只回主题、`pass` 需要合并时写 `merge-needed`、`reject` 置 blocked 并写 `review-reject`；verdict 后 `stopActivity` 归档，失败保留并记录；请求文件 I/O 走 store 的文本端口 + 项目锁。`src/review.ts` 删除，legacy 类型/预设 id 迁出。
- **M10.4 收口（`topic-tools.ts`、`project-tools.ts`、`tool-runtime.ts`、`route-tools.ts`、`presets.ts`、`tool-model.ts`）**：`cowork_handoff` 只剩 `blocked|done`（文件仍写审计、全文不再 prompt master），`blocked` 经 `deliverInbox` 写有界收件箱并 flush，`done` 写 digest（≤200）/交付确认并清标记；`project_status` 删除 `reconcileIndex`/`replayPendingHandoffs`，保留 inbox 重放，增加有界 `workItems`/`reviews` 计数与 topic 行 `activeWorkItems`/`reviewsPending`；`evaluateProjectLifecycle` 改用锁内文档的 `activeWorkItemsOf`（KI-24）；master/topic/reviewer persona 与 `buildThreadBrief` 改为请求式评审；15 工具按文档顺序注册。
- **M10.5 收口文档**：本文件、两份决策记录迁移、KNOWN_ISSUES、publish.json、M10_HANDOFF 状态指针。
- **测试**：新增 `tests/review-request.test.mjs`（41）、`tests/work-item.test.mjs`（48）、`tests/session-visibility.test.mjs`（7），重写 `tests/review-verdict.test.mjs`（12），扩展 `tests/checkout.test.mjs`（47）、`tests/project-tools.test.mjs`（11）、`tests/topic-tools.test.mjs`（11）、`tests/handoff.test.mjs`（5）、`tests/dev-gate.test.mjs`、`tests/source-budget.test.mjs`、`tests/presets.test.mjs`、`tests/tool-model.test.mjs`、`tests/m3-e2e.test.mjs`、`tests/routing.test.mjs`；删除 `tests/review.test.mjs`。括号内为冻结前该文件用例数。

## 完成定义与证据

- [A1] 请求最小字段校验；缺字段、base 不是 head 祖先、base=head、路径越界、工作树脏、diff 为空、changedPaths 与 git 派生不一致、已有 pending 请求都返回稳定错误且不创建 reviewer/不写索引 — `tests`：`tests/review-request.test.mjs`（`a complete request validates and keeps every field`、`purpose, base, head, path, and verification are required`、`base and head must name different commits and stable commit ids`、`the path must stay inside the repository or the work-item checkout`、`every failed pre-check leaves no reviewer, no file, and no index change`、`a second pending request for the same topic and work item is refused`、`the previous request must exist, belong to the same chain, and be answered`）
- [A2] 请求文件按 `<topicId>-<requestId>.json` 写 `pending`；reviewer 每次新建并由 `reviewerSessionId` 绑定；brief 失败按顺序回滚请求文件、索引与 reviewer，并写 error 活动；同一 topic 同时只有一个 pending — `tests`：`tests/review-request.test.mjs`（`the request file is <topicId>-<requestId>.json under reviews/`、`a shared-tree request writes the pending file, the index, and the brief`、`a brief failure rolls the request back in order and records it`、`an index write failure archives the reviewer and removes the file`）、`tests/session-visibility.test.mjs`（创建/归档/失败保留 7 条）
- [A3] verdict 只接受登记的 reviewer 与 pending requestId；先落盘后更新索引；`needs_revision` 只 prompt 主题，`pass` 需要合并时写 merge-needed 收件箱，`reject` 置 blocked 并写 review-reject；verdict 后归档 reviewer，归档失败保留并记录 — `tests`：`tests/review-verdict.test.mjs`（`a pass verdict with a work item records, merges, and archives`、`a pass verdict on a shared work tree wakes nobody and writes no inbox`、`needs_revision goes back to the topic only, never to the master`、`a reject verdict blocks the topic and wakes the master`、`only the recorded reviewer may answer the request`、`a request accepts exactly one verdict`、`a failed reviewer archive is reported, not turned into a failed verdict`、`a failed inbox delivery keeps the item undelivered and reports it`）
- [A4] 工作项创建产出 `.dsh-cowork/workitems/<id>` 与 `cowork/<id>`，写入 `WorkItemRecord`（path/branch/baseCommit/status）与活动；非法/重复路径、provider 非 clone、失败清理可断言；role 为 topic/master — `tests`：`tests/work-item.test.mjs`（`createWorkItem clones, writes the active record, and records the activity`、`createWorkItem refuses an unsupported isolation provider before any work`、`an unsupported isolation provider is refused before any work`、`createWorkItem removes the clone and branch when the index write fails`、`cowork_work_item_create clones, records, and activates a work item`、`the master must name an existing topic; a topic creates only for itself`、`activeWorkItemCount counts active and reviewing work items of one topic`）、`tests/checkout.test.mjs`（`workItemCheckoutPaths maps a work-item id to its clone path and branch`、`createCheckout with a work-item target clones under workitems and branches cowork/<id>`）
- [A5] 合并要求 master、工作项可合并、工作树干净、同一 headCommit 的 pass；拒绝 main/master 保护分支；串行；冲突保留 clone 与现场，解决后重新请求；成功后清理 clone/分支/workspace/session、工作项 merged、写活动，main 不被改动 — `tests`：`tests/work-item.test.mjs`（`a passed work item merges into the current branch and is torn down`、`a head that moved after the review is refused without merging`、`a work item without a passed review cannot be merged`、`a dirty work-item clone is refused before the merge`、`main and a detached HEAD are protected merge targets`、`a conflicting merge keeps the clone and reports the conflict files`、`a cleanup failure is reported without failing the finished merge`、`the merge gate refuses unknown, non-reviewing, and non-master work items`、`the work-item id wins over the deprecated threadId`、`serializeMerge runs merges in order and survives a rejected operation`）
- [A6] `cowork_handoff` 只剩 blocked/done；blocked 写收件箱，done 写 digest/交付确认并清标记；`project_status` 删除 handoff 兼容重放、使用真实 active 工作项计数；review 写入 canonical v2（不再写 legacy 字段）；KI-18/24/25 在本阶段收口或明确剩余归属 — `tests`：`tests/topic-tools.test.mjs`（`cowork_handoff exposes only blocked|done and no longer mentions awaiting_review`、`cowork_handoff(done) records the summary and delivery confirmation without prompting the master`、`cowork_handoff(blocked) sets the flag and wakes the master through one bounded inbox item`、`a blocked handoff bounds the inbox summary`、`deliverInbox reports an InboxMarkError as a value and never throws`）、`tests/project-tools.test.mjs`（`project_status reports work-item and review counts and no handoff replay`、`project_status keeps a topic with active or reviewing work items from resolving (KI-24)`、`project_init no longer reconciles a stale handoff into the index`、`the compatibility replay and the fixed work-item count are gone from the sources`）、`tests/source-budget.test.mjs`（`KI-25/KI-18: no legacy review writes, and the legacy read-only surface stays`）
- [A7] 15 个工具按文档顺序注册；review_request 仅 topic、review_verdict 仅 reviewer、work_item_create topic/master、checkout_merge master；`tools.ts` 只编排；`dev-gate` 与角色拒绝测试覆盖 — `tests`：`tests/project-tools.test.mjs`（`the assembly registers the fifteen tools in the documented order`）、`tests/dev-gate.test.mjs`（`the business surface registers exactly fifteen tools in the documented order`、`cowork_handoff accepts exactly blocked and done (KI-25)`、`cowork_checkout_merge no longer accepts an unreviewed override (KI-25)`）、`tests/review-verdict.test.mjs`（`only the recorded reviewer may answer the request`）、`tests/work-item.test.mjs`（`the merge tool is master only`、`the master must name an existing topic; a topic creates only for itself`）、`tests/source-budget.test.mjs`（`the tool split owns every tool name and keeps tools.ts orchestration-only`）
- [A8] `src/tools.ts` ≤49,152 B、`src/store.ts` 不越过 49,152 B、`src/**/*.ts` <51,200 B；不新增 M11/M12 模块（api-contract/client/面板、真实 E2E、迁移演练不在 M10）；`npm run check`/`typecheck`/`build`/`test` 全绿 — `source`：冻结前 `tools.ts` 2,924 B、`store.ts` 48,560 B、最大 `m2-e2e.ts` 49,923 B；`tests/source-budget.test.mjs`（`every src/**/*.ts and src/**/*.tsx file stays under the 50 KiB read limit`、`the tool split owns every tool name and keeps tools.ts orchestration-only`、`the work-item, review-request, and session modules own rules, not tool names`）；四命令 exit 0（见「验证基线」）
- [A9] M10 收口：`review-request` 与 `parallel-isolation` 两份记录迁到 implemented 并按骨架重写；`topic-store-v2` 与 `topic-session-model` 仍在 M11/M12 收口；写 `docs/M10_RESULT.md` 与交接并更新 `KNOWN_ISSUES` 归属；`npm run check` 无未分类 `.md` — `decisions`：本文件、M10_HANDOFF 状态指针、[KNOWN_ISSUES](KNOWN_ISSUES.md)、`docs/publish.json`、两份 implemented 记录

## 审查与修复

- **独立验证（t9，PASS）**：在独立副本重算 HEAD/diff sha（与 artifact 一致，`git status` 前后 0 行），四命令 exit 0：`npm test` 698/698（0 fail/cancelled/skipped/todo）、`typecheck` 0、`build` 0、`check` 0；A1–A8 逐项复跑通过。
- **独立 review（t10，verdict=pass）**：reviewer 与 implementer 不同成员，在 `/tmp` 隔离副本执行，四命令独立复跑全绿（698/698）。核对通过：请求前置检查零副作用、requestId/reviewerSessionId 绑定与一次性 verdict、合并门禁/保护分支/串行/冲突/清理、工作项失败清理、handoff/status 收口、15 工具顺序与角色、无第二套 verdict 模型。
- **批量修复轮的 findings（t10 提出，t14 已修复）**：
  - **R1（medium）**：共享工作树评审（`workItemId=null`）`needs_revision` 后主题没有「不可自动 resolve」守卫——`deriveReviewOutcome` 把 `awaitingReview`/`blocked` 置 false 且无工作项，`isResolvable`（`src/topic.ts:38-46`）不读 `reviewStatus`；主题静默超时后会不可撤销地自动 resolved。requiredFix：`isResolvable` 增加 `reviewStatus` 非 `pending`/`needs_revision` 的条件，并补 `tests/topic.test.mjs` 用例。
  - **R2（low）**：`WORK_ITEM_ID_PATTERN`（`src/work-item.ts:36`）允许 `.`，而 checkout 的 `TARGET_ID_PATTERN`（`src/checkout.ts:64`）拒绝 `.`；带点 id 会通过 `isValidWorkItemId` 却在 `resolveIsolationTarget` 以 `checkout/path-guard` 被拒。requiredFix：统一两处模式，并断言同一 id 集合判定一致。
  - **修复状态（t14，已落地）**：R1 由 `8b01c8a` 修复（`isResolvable` 排除 `needs_revision`；`pending` 由 `awaitingReview` 覆盖，并用 `tests/topic.test.mjs`/`tests/project-tools.test.mjs` 用例锁定）；R2 由 `a69b772` 修复（两处 id 模式统一，并断言同一 id 集合判定一致）；`src/index.ts` 的 "fourteen tools" 注释由 `ea3bbb6` 一并修正。修复后的四命令与测试计数由收口 fact-sync 按最终 artifact 复跑并补入本文件；在 fact-sync 之前，上文计数仍是冻结前（`e683a12`）值。

## 偏差与未验证

- **已知并接受的偏差**：
  - `HandoffStatus` 的**读取**枚举仍保留 `awaiting_review`（`src/store-schema.ts` 的 `HANDOFF_RECORD_STATUSES`），以便旧 handoff 文件可读；只有**写入**校验收窄为 `blocked|done`（`src/handoff.ts`）。旧文件不迁移、不重写。
  - 评审文件的 I/O 落在 `src/review-tools.ts` + store 的文本端口，而不是提案 §2 写的 `review-request.ts`；`review-request.ts` 保留纯模型、校验、序列化与 brief。原因：store.ts 余量仅约 562 B，业务写入不再进 store。
  - `cowork_project_init` 的 payload 仍返回只读 legacy 视图（`index.threads`），以保持既有调用方与 `tests/tools-init.test.mjs` 兼容；兼容**写回**（`reconcileIndex`）已删除。
  - handoff 文件不再写 `deliveredAt`（审计文件恒 `null`）；legacy `submitHandoff`/`replayPendingHandoffs` 已删除，KI-25 的「旧文件只读」由此成立。
  - reviewer 在宿主左侧栏仍可能可见（宿主没有会话过滤接口）；M10 的「隐藏」指 CoWork/面板不列 reviewer，verdict 后归档；面板过滤归 M11（KI-28）。
  - isolation provider 只实现 `clone`；`isolation.provider` 配置形状已存在，worktree 适配器后置（KI-27）。
  - 评审分级（L0–L3）与用户手动评审 provenance 未实现（KI-30）；M10 只实现「主题显式请求 → 建 reviewer」。
  - `reviews.pending`/`reviewsPending` 以 `topic.reviewStatus === 'pending'` 计数（每 topic 至多一个 pending），不直接列 review 文件（无 list 端口）；M11 面板可改数据源。
  - `deliverInbox` 的未知异常分支返回 `failed: 0`（计数未知），仅防御性路径；正常投递失败与 `InboxMarkError` 均返回准确计数。
  - `src/tool-model.ts` 保留 `review/override-reason-required` 码（pinned 表未删，现无调用者）；`src/m2-e2e.ts`/`src/m3-e2e.ts` 旧 dev 面仍含 `awaiting_review`/`allowUnreviewed` 文本（KI-29，M12 取代）。（`src/index.ts` 的 "fourteen tools" 注释已由 t14 的 `ea3bbb6` 修正，不再是偏差。）
  - 文档指针：`docs/PLAN-V0.2.md` §8（`proposed/feature`/`proposed/architecture` 两行）与仍 proposed 的 `topic-store-v2`/`topic-session-model`、M10 执行提案中仍引用两份记录的 `proposed/` 路径；本次收口只改 inScope 文件，M11/M12 收口文档时一并修正。
- **未验证**：
  - 真实宿主端到端全链路（评审请求 → reviewer 创建 → verdict → 收件箱/主题 → 工作项 → 合并）——M12（KI-22）；M10 只跑到 fake host + 真实 store 文件，`fake-host` 通过不等于真机可用。
  - 本机 web profile 仍把 `dsh-cowork` 设为 `disabled: true`；插件在启用 cowork 的 profile 里的真实装配未验证（M12）。
  - 跨进程合并串行（M10 只有进程级 Promise 链，KI-26）；真实 clone 成本/磁盘（KI-1）；reviewer 只读约定（KI-15）。
  - 真实旧 v1/v2 数据（含 `awaitingReview`/legacy review 指针/旧 handoff 文件）在 M10 代码下的读取与回滚演练（KI-22）；M10 写出的新格式 review 文件在旧代码下的行为只做了代码级判断。
  - 模型/评审质量与成本未测量；reviewer 是独立会话，成本属真实使用观察。

## 回滚

- **代码**：按提交序列逆序 `git revert`：先本次文档提交，再 t14 修复提交（`ea3bbb6`、`a69b772`、`8b01c8a`），再 `e683a12` … `5890866`（含集成提交）。回滚后 M9 代码可读 v2 索引（`workItems` 字段在 M9 已存在并被忽略）。
- **数据（顺序重要）**：M10 会写新格式 `<topicId>-<requestId>.json`。**回滚代码前必须先把这些新文件移出 `.dsh-cowork/reviews/`**（或恢复 `.dsh-cowork` 备份），否则旧代码的 `store.listReviews` 会按旧 schema 读取并失败。旧 handoff/review 文件保持只读、不迁移、不删除。`.dsh-cowork/workitems/` 下的 clone 与索引 `workItems` 条目按工作项逐个 `cowork_checkout_merge` 完成，或人工删除 clone 目录并从索引移除条目；不要留下指向已删目录的记录。
- **文档/记录**：revert 本收口提交（只改 `.md`/`.json`）；两份记录回到 `proposed/`，`docs/publish.json` 的 M10_RESULT 条目随之回滚。不要 force-push。
- **activity/inbox**：M10 新增的活动与未投递收件箱条目在回滚后无害（M9 读取器忽略未知 kind 之外的字段），但不会自动清理。

## 遗留问题指针

见 [KNOWN_ISSUES](KNOWN_ISSUES.md)：本阶段**关闭** KI-24（读取点接真实 `active`+`reviewing` 计数）与 KI-25（工具面只剩 `blocked|done`；旧 handoff 文件只读，未迁移残留写明）；**修订** KI-18（只剩读路径与 M11/M12 清理）与 KI-22（补 M10 未验证边界）；**新增** KI-26（合并串行仅单进程）、KI-27（isolation provider 仅 clone）、KI-28（reviewer 左侧栏可见至 M11）、KI-29（legacy dev E2E m2/m3 由 M12 取代）、KI-30（评审分级与用户评审 provenance 未实现）。KI-15/17/19/21/23 保持原归属。

## 指针

- M10 启动交接（保留启动版）：[M10_HANDOFF.md](M10_HANDOFF.md)。
- 执行层决定与备选（仍 proposed）：[2026-11-08-m10-review-request-workitems-plan.md](../.agents/notes/proposed/architecture/2026-11-08-m10-review-request-workitems-plan.md)。
- 评审规则（implemented）：[2026-11-07-review-request-model.md](../.agents/notes/implemented/feature/2026-11-07-review-request-model.md)。
- 工作项与合并边界（implemented）：[2026-11-07-parallel-isolation-and-merge.md](../.agents/notes/implemented/architecture/2026-11-07-parallel-isolation-and-merge.md)。
- 角色模型（仍 proposed，M11 收口）：[2026-11-07-topic-session-model.md](../.agents/notes/proposed/architecture/2026-11-07-topic-session-model.md)。
- 索引 v2 与迁移（仍 proposed，M11/M12 收口）：[2026-11-07-topic-store-v2.md](../.agents/notes/proposed/architecture/2026-11-07-topic-store-v2.md)。
- M9 交付结果：[M9_RESULT.md](M9_RESULT.md)。
- 遗留问题与归属：[KNOWN_ISSUES](KNOWN_ISSUES.md)。
