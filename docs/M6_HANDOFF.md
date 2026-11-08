# M6 阶段交接

- 状态：M6 完成。M6 探针交付已提交为 `66b5d5c`（分支 `agent/archive-completed-docs`，未推远端）；本交接与决策记录随后单独提交。团队 `m6-probes` 保留未删。
- 范围：PLAN-V0.2 §6 M6——7 项宿主探针、7 份 proposed 记录一致性、发布分类；未改 `src/`、未做 M7–M12。

## 交付物

| 路径 | 内容 |
|---|---|
| [M6_PROBE_RESULT.md](M6_PROBE_RESULT.md) | 7 项探针的结论、证据命令、原始输出摘录、证据文件路径、限制、M7–M12 影响 |
| [M6_HANDOFF.md](M6_HANDOFF.md) | 本文件：交付、决策、验证、回滚、M7 前置 |
| [2026-11-07-topic-visibility-fallback.md](../.agents/notes/proposed/feature/2026-11-07-topic-visibility-fallback.md) | M11 采用降级方案 (b) 的决定、代价与验收 |
| [2026-11-07-store-v2-migration-plan.md](../.agents/notes/proposed/architecture/2026-11-07-store-v2-migration-plan.md) | M7 执行提案（数据模型仍归 `2026-11-07-topic-store-v2.md`） |
| 7 份 2026-11-07 记录 | 按探针结论修订，仍 `Status: proposed` |
| docs/publish.json、docs/README.md | 新文档的 internal 分类与索引 |

## 七项结论（一句话）

1. LLM：最低档 `off` 等价关闭推理（thinking disabled、不发 output_config）；`ctx.get('llm')` 缺失时的回退运行时未验证。
2. 事件：生产插件 apply 期两轮收到 user/message、turn/start、turn/end；500 条缓冲上限未验证。
3. archive：默认与 `stopActivity:true` 两种模式归档后 prompt 都被 `blocked`、消息不落盘；unarchive 才恢复；无替代过滤接口。
4. reviewer：创建后立即归档会 `blocked`，verdict 后归档正常 → `reviewer.reclaim = after-verdict`。
5. preset/工具面：master 去 fs/bash 仍工作；preset 行 + per-agent `restrict` 叠加，边界是不能掩 agent 自身注册的工具（视图需 `schemas(agent)`）。
6. 面板写路由：真实 Chrome 同源 JSON POST 200；错误 Origin/Content-Type/Host 被拒；认证后 `/api` POST 未验证，验收方式留 M11。
7. clone：reviewer 可读隔离 clone；worktree 不作 v1 提供方。

## 决策与计划改动

- **M11 采用降级方案 (b)**（用户 2026-11-07 决定）：主题会话保留左侧栏、只隐藏 reviewer；CoWork 仍是主题列表与打开入口；插件不用 `archiveSession` 隐藏主题，`archiveSession` 只用于 reviewer 回收。见上表决策记录。
- PLAN-V0.2 已按 (b) 修正 §2.2/§2.4/§3.1/§3.2/§5.9/§5.10/§6（M11/M12）/§8/§10.1 的相关表述；`docs/PLAN.md` 未改。
- 7 份决策记录保持 `proposed`；M11 实现完成后按记录生命周期移入 `implemented/`。

## 证据与复跑

- 证据目录：`.dsh-cowork/m6-probe/runs/`（gitignored）。每个探针至少一个 `ok=true` JSON；`index.json` 的 latest 可能是 verifier 复跑产生的 run，canonical run 也在同一目录。
- 复跑：注入 `<repo>/.dsh-cowork/m6-probe/toolbelt` → `GET /dsh-cowork/m6/health` → `POST /dsh-cowork/m6/run`，命令见 [M6_PROBE_RESULT.md](M6_PROBE_RESULT.md) §10。
- 收尾状态：30 个探针会话已归档（`workspace.json.global.archivedSessionIds` 已核）；临时工具带已卸载（`/dsh-cowork/m6/health` 现在 404）。

## 验证（M6 交付时）

- `npm run check`、`npm run check:self-test`、`npm test`（356 pass）、`npm run typecheck`、`npm run build` 全部 exit 0，由独立 verifier 复跑。
- M6 交付中 `src/`、`docs/PLAN.md`、`docs/PLAN-V0.2.md`、根 `package.json` 无 diff；本交接之后的计划修正单独提交。
- 终审 reviewer（只读）verdict=`pass`：核对 20+ 处宿主源码 file:line 与 7 份证据断言；两条非阻塞观察见下。

## 未验证与遗留

- 认证后的 `/api` POST（宿主 launch token 属凭据，未读取）；`openSession` 真实 UI 与 `clearArchivedCurrent` 的实际行为；worktree 适配器运行时证据；`restrict({allow})` 白名单与跨 agent 隔离；`session/event` 500 条缓冲上限。
- 宿主版本漂移：PLAN 写 2.0.13，实测 2.0.18；已在 M6 文档记录，未改 PLAN 版本行。
- 终审两条非阻塞观察：`M6_PROBE_RESULT.md` 开头「只引用 index 指向的 run」在 verifier 复跑后与 index 现状不完全一致（canonical 文件仍存在且 ok=true）；P5 引用的 `packages/core/**` TS 源码路径在 app checkout 不可达（运行时 lib 与活体复跑已佐证）。

## 下一阶段（M7）

1. 先读 [M7 执行提案](../.agents/notes/proposed/architecture/2026-11-07-store-v2-migration-plan.md)，再读它的设计事实来源 [索引 v2 与迁移](../.agents/notes/proposed/architecture/2026-11-07-topic-store-v2.md) 与 PLAN-V0.2 §6 M7。
2. M7 范围：`src/store-schema.ts`、`src/store-migration.ts`、`src/store.ts`；v1→v2 迁移、备份、fail closed、activity/inbox 文件 I/O、测试与 typecheck/build。
3. 迁移要用的 M6 结论：取消在途 reviewer 必须 `archiveSession(id,{stopActivity:true})`；reviewer 回收是 after-verdict。M7 不接 session/event。
4. 按 PLAN-V0.2 §6 执行规则：M7 完成即停，等确认后再进 M8。

## 回滚

`git revert` M6 与本交接的提交即可回到 M6 前状态。探针工具带与证据都在 gitignored 的 `.dsh-cowork/`，删除该目录不影响仓库；工具带已卸载，宿主侧无需回滚。
