# M8 交接文档

> **历史文档（2026-11-08 补记）**：M8 已交付，交付结果、证据、偏差与回滚见 [M8_RESULT.md](../results/M8_RESULT.md)。本文件保留为 M8 启动时的交接基线；文中的启动步骤、429 基线与「M8 落地后」动作都是当时的计划，已被 M8 执行完毕，不再按原文执行。

- 状态：**M8 启动文档（2026-11-07）**。M7 已落地并终审通过；本文件写给下一个会话，用于启动 M8。M7 的实现事实、限制与证据在 [M7 迁移实施记录](../../../.agents/notes/implemented/architecture/2026-11-07-store-v2-migration-plan.md)；M8 的执行约定在 [M8 执行记录](../../../.agents/notes/implemented/architecture/2026-11-07-m8-lifecycle-activity-inbox-plan.md)；需求规则在 [主题三态与已解决规则](../../../.agents/notes/implemented/feature/2026-11-07-three-state-lifecycle.md)。
- 适用：接手 V0.2 M8（主题生命周期、活动、收件箱）的 agent 或人。范围：M7 交付后的代码基线、M8 的启动方式、实施顺序与证据、回滚与未验证清单。不重新论证 M7 的迁移决定。
- 事实源：[PLAN-V0.2](../../PLAN-V0.2.md) §2.3/§4.2/§4.3/§5.1/§5.6/§6 M8 拥有状态机、模块图、数据模型与验收；[M6 探针结果](../results/M6_PROBE_RESULT.md) §2/§4 拥有 `session/event` 与 reviewer 归档的实测结论；[KNOWN_ISSUES](../../KNOWN_ISSUES.md) 拥有遗留问题的归属与重估触发条件；本文件只拥有「从哪继续、先验证什么、怎样算完成」。

## M7 交付后的状态（2026-11-07）

- **提交序列**：`9eeec16`（M7 基线）→ `73d4083`（store v2 读写、迁移事务、activity/inbox I/O）→ `a262273`（store 测试拆分）→ `ffd7c7f`（M7 迁移记录转 implemented）→ `6cb294c`（A1 宿主接线与 E2E `parseIndex` v2 兼容）→ `45c7616`（M7 收口文档：M6 交接链接、implemented 记录、KNOWN_ISSUES KI-18..22）→ `d3daf89`（M8 执行提案与交接文档）→ `c1ebedf`（KNOWN_ISSUES 表格空行修复）→ 本文件所在提交（canonical 只读投影的边界说明）。
- **基线**：M7 代码基线 `45c7616`；本交接与 M8 提案在 `d3daf89` 加入、`c1ebedf` 修正 KNOWN_ISSUES 空行。**未合并时，基线 = 本文件所在 PR 分支 HEAD（≥ `c1ebedf`，启动时记录实际 sha）；合并后用 `origin/main` 的 merge sha。** 不要用 `45c7616` 作为启动基线：那里没有本交接与提案。
- **验证基线**：`npm test` 429 pass / 0 fail / 0 skip / 0 todo（在 `6cb294c` 上实测；`45c7616`、`d3daf89`、`c1ebedf` 与本次修复只改文档并复跑 `npm run check` 与 `npm test`）；`npm run typecheck`、`npm run build`、`npm run check` 均 exit 0。M8.1 新增测试后计数会增加，交接不预写未来数字。
- **代码形态**：`src/store.ts` 47,351 B（审查线 49,152 B、硬上限 51,200 B）；`src/store-schema.ts` 26,360 B、`src/store-migration.ts` 19,192 B；`src/topic.ts`、`src/topic-events.ts`、`src/activity.ts`、`src/inbox.ts` 尚不存在。
- **M7 已交付**：磁盘只写 v2（`topics[]`/`workItems[]`）、读兼容 v1；迁移事务含一次性备份 `index.v1.backup.json`（原 v1 字节、不覆盖）、归档被取消评审的 reviewer、原子写与目录 fsync、fail closed；activity.jsonl 追加/裁剪（500 条 / 524288 B）、坏行跳过、并发安全；inbox.json 读写、50 条上限、整文件损坏报 `store/corrupt`。
- **A1 已接线**：`SessionSlicePorts['workspaces'].archiveSession` 支持 `{stopActivity}`，`SessionSlice` 透传；`src/tools.ts` 的单一 `projectStoreFor` helper 与 `src/index.ts` 的 `panelPorts.createStore` 都把 `workspaceRegistry.archiveSession` 注入 `ProjectStoreOptions.archiveSession`。host-free 测试（fake registry + 真实 `ProjectStore`）证明迁移以 `(reviewer,{stopActivity:true})` 归档。
- **E2E 索引解析已兼容 v2**：`src/m2-e2e-support.ts` 与 `src/m3-e2e-support.ts` 的 `parseIndex` 对 v1 原样返回、对 v2 校验后经 `legacyViewOf` 投影；E2E 驱动本体未在真实宿主重跑。
- **canonical v2 读投影用只读模式（M8.1 落地）**：M7 的 `migrateV1ToV2` 是写语义（`awaiting_review` → active + `awaitingReview=false`、清空 review 指针、reviewer 进 `pendingReviewerArchives`），直接拿它做读投影会与 `readIndex()` 不一致，也违背 M7「纯读不迁移」的意图（[M7 迁移实施记录](../../../.agents/notes/implemented/architecture/2026-11-07-store-v2-migration-plan.md) 的「读时惰性迁移、下次写入才落盘」一段，写作时 :38）。M8.1 给 `migrateV1ToV2(document, options?)` 增加可选 `{cancelInFlightReviews?: boolean}`，**默认 `true` 保持写路径与 M7 测试不变**；`false` 时 `awaiting_review` 投影为 `active` + `awaitingReview=true`，保留 `reviewStatus`/`reviewerSessionId`，不产生待归档列表。`readIndexDocument` 用只读模式，`readIndexForWrite` 保持默认写模式。所以在 v1 磁盘上 `readIndexDocument` 与 `readIndex()` 语义一致（都保留在途评审）；只有第一次真实写入才取消评审、备份并归档 reviewer，M9 读取点可以直接使用只读投影。测试分两层：`tests/store-migration.test.mjs` 覆盖只读/写两种模式，`tests/store-v2.test.mjs` 覆盖 canonical 读写与首次写迁移。
- **未迁移的真实数据**：仓库内 `.dsh-cowork/index.json`（gitignored）仍是 v1，未做真实迁移；真实宿主 E2E 与真实数据迁移归 M12（KI-22）。
- **KI 归属**：KI-20（迁移 activity 先于 index 写）与 KI-19（迁移报告仅内存）归 M8；KI-18（兼容视图/legacy 字段）归 M9→M10→M12；KI-21（fsync 崩溃持久性）与 KI-22（真实 E2E/真实数据迁移）归 M12。

## 先读什么

1. [AGENTS.md](../../../AGENTS.md)：纪律、命令、文档与提交规则。
2. [PLAN-V0.2](../../PLAN-V0.2.md) §2.3（状态机）、§4.2（模块图）、§4.3（数据模型）、§5.1（生命周期）、§5.6（活动/收件箱）、§6 M8（本阶段范围与完成标准）。
3. [主题三态与已解决规则](../../../.agents/notes/implemented/feature/2026-11-07-three-state-lifecycle.md)：三态、两标记、五条件、3 天/2 小时、重开（M8 已迁移为 implemented）。
4. [M8 执行记录](../../../.agents/notes/implemented/architecture/2026-11-07-m8-lifecycle-activity-inbox-plan.md)：模块边界、store 扩展、评估时机、KI 处置、验收与分阶段顺序（M8 已迁移为 implemented）。
5. [M7 迁移实施记录](../../../.agents/notes/implemented/architecture/2026-11-07-store-v2-migration-plan.md)：M7 实际交付、限制与 Testing；不要重做它的决定。
6. [KNOWN_ISSUES](../../KNOWN_ISSUES.md)：KI-18..KI-22 的归属与重估触发条件。
7. [M6 探针结果](../results/M6_PROBE_RESULT.md) §2（`session/event` 与 500 条缓冲限制）、§4（reviewer 归档必须 after-verdict）。
8. [docs/testing.md](../../testing.md)、[docs/AGENTS.md](../../AGENTS.md)、[tools/workflow.json](../../../tools/workflow.json)：证据面、文档分类、检查映射。
9. [M6 交接](M6_HANDOFF.md)：交接骨架与历史约定；其中的启动步骤已完成，只读不重跑。

## 第一步：M8 的启动顺序

1. `git fetch origin`。工作区必须干净；先跑一次 `git status --porcelain` 确认。
2. 确定基线：M7 代码基线是 `45c7616`；本交接与 M8 提案在 `d3daf89` 加入、`c1ebedf` 修正空行。**未合并时，基线 = 本文件所在 PR 分支 HEAD（≥ `c1ebedf`，启动时记录实际 sha）；合并后用 `origin/main` 的 merge sha。** 不要用 `45c7616` 启动，那里没有本交接与提案。启动后把实际基线 sha 记进本交接或 M8 提案的交付记录，不要凭推测。
3. 从基线新建 `feat/m8-topic-lifecycle`；不要继续在 `feat/m7-store-v2` 上提交，不要 rebase/force 已有提交。
4. 在新分支跑基线四命令：`npm test`（期望 429 pass / 0 fail）、`npm run typecheck`、`npm run build`、`npm run check`，全部 exit 0 才开始改代码。任何一个失败，先停下报告，不要带着红基线进 M8。
5. 用新会话建新团队 `m8-topic-lifecycle`（`profile=impl-review`、`approval=automatic`，不复用 `m7-store-v2` 的团队状态）：implementation（写代码与测试，inScope 显式）→ verification（只跑命令，独立复跑四命令）→ review（只读终审，`reviewedTaskId`=implementation，verdict=pass 才收口）。
6. 先写会红的测试，再实现；每个最小工作单元通过检查后 local commit（Conventional Commits），不 push，等队长统一处理。

## M8 实施顺序

1. **M8.1 — 纯函数与 store v2 文档 API**
   - 范围（inScope）：`src/topic.ts`（新增，纯函数）、`src/store.ts`（只加 `readIndexDocument`/`mutateIndexDocument`，不改 v1 API 行为）、`src/store-migration.ts`（`migrateV1ToV2` 增加可选 `{cancelInFlightReviews}` 只读模式，默认值保持写语义）、`tests/topic.test.mjs`（新增）、`tests/store-v2.test.mjs`（canonical 读写、首次写迁移、锁内重读）、`tests/store-migration.test.mjs`（只读投影保留在途评审）。
   - 先写：三态与两标记、idle 边界、五条件与 3 天边界（-1ms/恰好/+1ms，注入时钟）、重开清 resolved 字段、无撤销；store 的 canonical 读写（v1 只读投影保留在途评审、无备份/无归档、首次写才取消并归档）、`mutateIndexDocument` 返回 `null` 不写；`migrateV1ToV2` 的两种模式各有测试。
   - 证据：`node --test tests/topic.test.mjs tests/store-v2.test.mjs tests/store-migration.test.mjs`；`npm run typecheck`。`src/store.ts` 一旦接近 49,152 B 立即停下报告拆分方案，不压行、不删测试。
2. **M8.2 — 事件监听**
   - 范围：`src/topic-events.ts`（新增）、`tests/topic-events.test.mjs`（新增）、`src/index.ts`（只做装配与释放）。
   - 先写：`turn/end` 更新 `lastActiveAt` 并回 `active`；已解决 topic 的 `user/message` 触发重开并写 `topic-reopened`；锁内重读发现 `lastActiveAt` 已变化时放弃标记。
   - 证据：`node --test tests/topic-events.test.mjs tests/topic.test.mjs`；`npm run typecheck`。事件测试用注入端口，不挂真实宿主。
3. **M8.3 — 活动与收件箱**
   - 范围：`src/activity.ts`（新增）、`src/inbox.ts`（新增）、`src/store-schema.ts`（`ACTIVITY_TYPES` 增加 `topic-reopened`）、`src/store.ts`（KI-20 顺序修复：校验 → 备份 → 归档 → 写 v2 → 写迁移 activity；activity 失败记入 `lastMigrationReport.activityFailure`）、`tests/activity.test.mjs`、`tests/inbox.test.mjs`、`tests/store-v2.test.mjs`（KI-20 回归）。
   - 先写：活动上限/坏行（复用 M7 store I/O）、`topic-reopened` 事件；收件箱 ≤5 条合并、每条 ≤200 字、投递成功写 `deliveredAt`、失败保留并重放、50 条上限；KI-20 的「activity 写失败不使迁移失败且不重复归档」。
   - 证据：`node --test tests/activity.test.mjs tests/inbox.test.mjs tests/store-v2.test.mjs`；`npm run typecheck`。
4. **M8.4 — 阶段门禁**
   - 范围：只做收口（补齐本阶段遗漏的测试与文档指针），不新增功能。
   - 证据：`npm test`（应 ≥429 + 新增测试，0 fail / 0 skip）、`npm run typecheck`、`npm run build`、`npm run check` 全绿；记录各命令 exit code 与测试计数。
   - 停止条件：四命令全绿后停下等确认，不进入 M9（路由、工具、预设属于 M9）。

## 验证与证据

- 每条实现的最小证据：`node --test <本阶段测试文件>` + `npm run typecheck`；阶段收口：`npm test` + `npm run typecheck` + `npm run build` + `npm run check`，逐条记录 exit code，不只说「通过」。
- 测试只用 `os.tmpdir()` 夹具，不读写真实 `.dsh-cowork/`；不用固定 `sleep` 当就绪判据，等待用带截止时间的轮询或事件。
- 本阶段不跑真实宿主 E2E（M12），也不迁移真实 `.dsh-cowork/index.json`；需要跨进程的结论按 [docs/testing.md](../../testing.md) 的规则留到 M12。
- 审查：实现者 ≠ 验证者 ≠ 最终审查者；verification 独立复跑，review 只读、verdict=pass 才收口。

## 陷阱

- **`src/store.ts` 余量约 1.8 KB**：新增方法 + KI-20 顺序修改会同时吃预算。接近 49,152 B 时先停下报告拆分方案；不要把逻辑压进一行，不要删测试或放宽断言。
- **v1 兼容层只减不增**：M8 的新代码一律用 canonical v2 读写；不要给 legacy 字段加新的写入者，也不要在 `topic.ts` 里复制一套 v1↔v2 状态映射（映射只在 `store-migration.ts`）。
- **两种读语义在 v1 上一致**：`readIndex()` 和 `readIndexDocument()` 都保留在途评审（`awaiting_review`、`reviewStatus`、`reviewerSessionId` 原样）；`readIndexDocument` 只是在内存投影成 v2 形状，不写盘、不备份、不归档。只有 `readIndexForWrite`（默认 `cancelInFlightReviews:true`）在第一次真实写入时取消评审并归档。默认参数必须保持不变，否则写路径会漏归档；两种模式都要有测试（`tests/store-migration.test.mjs` 与 `tests/store-v2.test.mjs`）。
- **锁内重读**：所有自动标记都必须走 `mutateIndexDocument`，并在 mutator 内比较 `lastActiveAt`；不要先读后写（会与用户新消息竞争，而自动标记无撤销）。
- **`workItems` 在 M8 恒为 `[]`**：五条件里的「无 active 工作项」暂时恒真；M10 引入工作项时必须把真实计数传进 `topic.ts` 的评估输入，否则可能误标已解决。
- **不要用后台定时器**：2 小时/3 天按惰性评估；读取点（project_status/route/面板）属于 M9/M11，M8 不改工具与面板。
- **`.dsh-cowork` 禁 `.md`**：check-invariants 会扫该目录；测试临时数据只用 `os.tmpdir()`。
- **事件字段**：M6 探针 2 记录 `user/message` 字段在顶层、`userMessageSeen` helper 不可靠；判断用户输入一律以事件类型为准。
- **归档语义**：reviewer 必须 after-verdict 归档（M6 探针 4）；迁移取消评审时用 `archiveSession(id,{stopActivity:true})`，A1 已接线，不要绕过 store 端口。
- **记录生命周期**：M8 落地后把 `three-state-lifecycle`（proposed/feature）与 M8 执行提案（proposed/architecture）移到 `implemented/` 并按 implemented 骨架重写；`topic-store-v2` 仍保持 proposed（含 M10 工作项与评审请求规则）。移动后跑 `npm run check`。

## 完成定义

- **M8（本阶段）**：三态与两标记、idle 2 小时边界、已解决五条件与 3 天边界（-1ms/恰好/+1ms）、无撤销、重开清 resolved 字段、`turn/end` 更新 `lastActiveAt`、锁内重读放弃标记、活动上限与坏行、收件箱合并/投递失败保留/重放、KI-20 修复，都有命名测试；四命令全绿；`src/store.ts` < 49,152 B；`src/` 单文件 < 51,200 B；无 M9–M12 模块；阶段结束停下等确认。
- **记录**：M8 提案与 three-state-lifecycle 按生命周期迁移并重写；`topic-store-v2` 仍 proposed；`npm run check` 通过；无新增未分类 `.md`。

## 回滚

- **代码**：`git revert` M8 的提交（按提交序列逐条）；M8 不改索引 schema，回滚不需要数据迁移。`index.v1.backup.json` 与 v2 索引的迁移回滚仍按 M7 记录：恢复备份并重装 0.1.0（M12 文档化）。
- **数据**：M8 只改 `.dsh-cowork/index.json` 的 v2 字段（`lastActiveAt`/`status`/`resolved*`）并追加 activity/inbox；回滚代码后旧的 v1 调用方仍能通过兼容视图读取 v2。若需要回到 M7 基线，用 `git revert` 并用备份恢复索引。
- **文档/记录**：`git revert` 对应文档提交；M8 落地后记录迁移也按提交回滚。

## 未验证

- 真实宿主 E2E（M12）：`turn/end`/`user/message` 只在 M6 探针的宿主进程内验证过，每会话 500 条缓冲上限未验证（[M6 探针结果](../results/M6_PROBE_RESULT.md) §2）。
- 真实 `.dsh-cowork/index.json` 的迁移与回滚演练（M12，KI-22）。
- `workItems` 条件在 M10 引入工作项后的行为（M8 恒为空）。
- 读取点评估（`project_status`/`route`/面板 overview）由 M9/M11 接入，M8 内无法验证。
- `fsync` 崩溃持久性（KI-21，M12）。
- 只读投影与写路径两种模式在真实 v1 数据上的行为：M8.1 用 `os.tmpdir()` 测试覆盖，真实迁移演练在 M12（KI-22）。
