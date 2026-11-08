# M8 交付结果

- 状态：**M8 已交付（2026-11-08）**。主题生命周期、活动与收件箱在 `feat/m8-topic-lifecycle` 上落地并终审通过；本文件记录交付基线、清单、证据、偏差与回滚，供下一个阶段（M9）接手。M8 启动时的交接见 [M8_HANDOFF.md](M8_HANDOFF.md)（已回滚为启动文档，不再承载交付记录）。执行决定见 [M8 执行记录](../.agents/notes/implemented/architecture/2026-11-07-m8-lifecycle-activity-inbox-plan.md)，需求规则见 [主题三态与已解决规则](../.agents/notes/implemented/feature/2026-11-07-three-state-lifecycle.md)。
- 适用：接手 V0.2 M9（路由、工具、预设）的 agent 或人。范围：M8 的实际交付、验证证据、已知偏差与未验证项。不重新论证 M8 的决定。
- 事实源：[PLAN-V0.2](PLAN-V0.2.md) §2.3/§4.2/§4.3/§5.1/§5.6/§6 M8 拥有状态机、模块图、数据模型与验收；[M8 执行记录](../.agents/notes/implemented/architecture/2026-11-07-m8-lifecycle-activity-inbox-plan.md) 拥有执行层的决定与备选；[KNOWN_ISSUES](KNOWN_ISSUES.md) 拥有遗留问题归属；本文件只拥有「交付了什么、拿什么证明、从哪继续」。

## 交付基线

- **分支**：`feat/m8-topic-lifecycle`（从基线 `06ff66b` 切出；M7 在 `06ff66b` 之前已合并）。
- **代码 HEAD**：`3723359`（`37233599bbead144a29d52906f724c3d8b25cddc`）。记录迁移与交接是其后的只改 `.md` 提交（本文件无法写入自身 sha）；分支已推送到 `origin/feat/m8-topic-lifecycle`，是否合并 `main` 由 PR 评审决定。
- **提交序列（`06ff66b..3723359`，按提交顺序）**：
  - M8.1：`3d5fa4f`（store canonical v2 读写）→ `2c7e489`（topic 三态纯函数）→ `d77b2e4`（v1 投影按 v2 schema fail closed）
  - M8.3（并行 worktree）：`641469d`（activity helper 移入 store-schema，腾预算）→ `19ec923`（activity 事件构造）→ `6dd8345`（inbox 合并/投递/重放）→ `2c9337d`（KI-20：先写 v2 再写迁移活动）
  - M8.2（并行 worktree）：`1352942`（事件监听）→ `c422606`（dev-gate 监听器计数）
  - 集成 merge：`aabde01`（M8.2 session event listener）→ `3723359`（M8.3 activity, inbox, KI-20）
- **验证基线（代码 HEAD 3723359 上实测）**：`npm test` 485 tests / 485 pass / 0 fail / 0 cancelled / 0 skip / 0 todo，exit 0；`npm run typecheck` exit 0；`npm run build` exit 0（`lib/` + `lib/client.js` 69 KB）；`npm run check` exit 0（`check-invariants: ok`）。485 = 429 基线 + 25（M8.1）+ 13（M8.2）+ 18（M8.3）。记录迁移后的文档提交上复核结果一致。
- **代码形态**：`src/store.ts` 48,524 B（审查线 49,152 B）；`src/**/*.ts` 最大 49,923 B（`src/m2-e2e.ts`，硬上限 51,200 B）；新增 `src/topic.ts`、`src/topic-events.ts`、`src/activity.ts`、`src/inbox.ts`。
- **范围证据**：`git diff --name-only 06ff66b..3723359` 恰为 16 个文件（8 个 `src/`、8 个 `tests/`），不含 `src/tools.ts`、`src/api.ts`、`src/api-contract.ts`、`src/client/**`、`presets/**`；M9–M12 模块（`routing`/`router-model`/`review-request`/`work-item`/`session-visibility`/`project-tools`/`topic-tools`/`route-tools`/`coverage-tools`）均不存在。

## 交付清单

- **新增模块**：`src/topic.ts`（三态、两标记、五条件、2 小时/3 天、重开、无撤销）；`src/topic-events.ts`（`session/event` 端口化监听：`turn/end` 更新活动、`user/message` 重开、锁内放弃、错误只 log）；`src/activity.ts`（`buildActivityEvent`/`recordActivity`/`topicReopenedActivity`/`statusChangedActivity`/`errorActivity`）；`src/inbox.ts`（`Inbox.enqueue`/`flush`/`replay`，批 ≤5、摘要 ≤200 字、失败保留可重放）。
- **`src/store.ts` 变化**：新增 `readIndexDocument`（v1 只读投影 + 投影后 v2 校验）与 `mutateIndexDocument`（锁内重读、`null` 不写、原子写 v2）；`readIndex`/`mutateIndex` 改为委托，v1 视图语义不变；迁移事务改为「校验 → 备份 → 归档 → 写 v2 → 写迁移活动」，活动失败记入 `MigrationReport.activityFailure`。
- **`src/store-migration.ts`**：`migrateV1ToV2(document, { cancelInFlightReviews })`，默认 `true`（M7 写语义），`false` 为只读投影。
- **`src/store-schema.ts`**：`ACTIVITY_TYPES` 增加 `topic-reopened`；activity 流 helper 从 `store.ts` 移入。
- **`src/index.ts`**：只加 `TopicEvents` 装配与 `ctx.effect` 释放（业务面常驻一个 `session/event` 监听器；`tests/dev-gate.test.mjs` 的计数随之由 0/4/4 改为 1/5/5）。
- **索引 schema 未改**：仍是 M7 的 v2（`topics[]`/`workItems[]`）；M8 只写既有 v2 字段，回滚代码不需要数据迁移。

## 完成定义与证据

- 三态、两标记、idle 2 小时边界（-1ms/恰好/+1ms）、五条件、3 天边界、无撤销、重开清 resolved 字段 — `tests/topic.test.mjs`。
- `turn/end` 更新 `lastActiveAt` 并回 `active`、`user/message` 重开并写一条 `topic-reopened`、锁内重读放弃标记、错误不外抛、dispose 幂等 — `tests/topic-events.test.mjs`。
- 活动上限（500 条/524288 B）、坏行跳过、`topic-reopened` 被真实活动流接受 — `tests/activity.test.mjs`、`tests/store-schema.test.mjs`。
- 收件箱合并（≤5 条/≤200 字）、投递写 `deliveredAt`、失败保留与重放、50 条上限 — `tests/inbox.test.mjs`。
- canonical v2 读写：v1 只读投影（字节/mtime 不变、无备份、无归档、在途评审保留）、投影按 v2 schema fail closed、`mutateIndexDocument(null)` 不写、首次写触发真实迁移 — `tests/store-v2.test.mjs`。
- `migrateV1ToV2` 写/只读两种模式与默认值 — `tests/store-migration.test.mjs`。
- KI-20：v2 落盘后 activity 失败不推翻迁移、`activityFailure` 记录原因、重试不重复归档 — `tests/store-v2.test.mjs`。
- 预算与范围：`npm test` 485 pass、`npm run typecheck`/`build`/`check` exit 0；`src/store.ts` 48,524 B；diff 16 文件且不含禁改路径 — 见「交付基线」。

## 偏差与未验证

- **已知并接受的偏差**（均不阻塞 M8，归属已定）：
  - v1 文档的未知 thread/document 扩展字段在 v1 兼容视图中不再透出；canonical v2 文档与 `applyLegacyView` 写回仍保留，不丢数据。
  - v1 磁盘上 `mutateIndexDocument` 即使 mutator 返回 `null`，也已先完成 M7 迁移写盘（`readIndexForWrite` 的固有语义；对已是 v2 的磁盘才是严格「不写」）。
  - F1（low）：`src/activity.ts` 的 builder（含 `topicReopenedActivity`）暂无生产调用者，M8.2 在 `src/topic-events.ts` 内联构造 `topic-reopened`，两处形状/摘要不同（事件仍经 store 校验）；M8.1/M8.2 并行 worktree 的边界产物，M9 接线 activity/`cowork_project_status` 时统一，当前不视为缺陷。
  - F2（low）：`session/event` 监听依赖 `session.header.cwd` 解析项目根；M6 探针只验证事件类型与顶层字段，header 在真实宿主的稳定性未核实，M12 真实 E2E 首验。
  - F3（low）：`Inbox.flush` 先投递成功、后 `writeInbox` 失败时，重放会重复投递（at-least-once）；M9 接线时需幂等/去重或在 prompt 端口处理，M8 只记录不修。
- **未验证**：
  - 真实宿主 E2E 与真实 `.dsh-cowork/index.json` 迁移/回滚演练（KI-22，M12）。
  - `session/event` 的每会话 500 条缓冲上限（M6 探针未验证）；`turn/end`/`user/message` 只在 M6 的宿主进程内与 host-free fake 事件源上验证过。
  - `session.header.cwd` 的真实宿主稳定性（F2）。
  - `workItems` 的第三个已解决条件：M8 恒为 `[]`，该条件恒真；M10 必须传入真实 active 计数。
  - 读取点评估（`cowork_project_status`/`cowork_route`/面板 overview）未接入，属 M9/M11。
- **记录链接**：`docs/PLAN-V0.2.md:545` 与 `topic-store-v2` 中指向两份已迁移记录的路徑已更新为 `implemented/`，跨生命周期链接不再断。

## 回滚

- **代码**：按提交顺序 `git revert`（`3723359`、`2c9337d`、`6dd8345`、`19ec923`、`aabde01`、`c422606`、`1352942`、`641469d`、`d77b2e4`、`2c7e489`、`3d5fa4f`）。M8 不改索引 schema，回滚代码不需要数据迁移。
- **数据**：M8 只写 v2 既有字段（`status`/`resolved*`/`lastActiveAt`/`awaitingReview` 等）并追加 activity/inbox；回滚代码后 v1 调用方仍能通过兼容视图读取 v2。
- **回到 M7 之前**：恢复 `index.v1.backup.json`（原 v1 字节）并重装 `0.1.0`；真实迁移与回滚演练仍归 M12（KI-22）。
- **文档**：`git revert` 本交付的记录迁移与交接提交；两份记录回到 `proposed/`。

## 指针

- M8 启动交接（历史）：[M8_HANDOFF.md](M8_HANDOFF.md)。
- 需求规则与三态决定：[主题三态与已解决规则](../.agents/notes/implemented/feature/2026-11-07-three-state-lifecycle.md)。
- 执行层决定与备选：[M8 执行记录](../.agents/notes/implemented/architecture/2026-11-07-m8-lifecycle-activity-inbox-plan.md)。
- M7 迁移事实与限制：[M7 迁移实施记录](../.agents/notes/implemented/architecture/2026-11-07-store-v2-migration-plan.md)。
- 遗留问题与归属：[KNOWN_ISSUES](KNOWN_ISSUES.md)（KI-19、KI-21、KI-22 保持；KI-20 已在 M8 修复并删除）。
