# Decision: 工作项后端（artifacts、批注、版本、投递与 SSE）

Status: implemented
Date: 2026-11-10
Class: feature

## Problem

工作项页面需要右栏列表、主区域查看器、逐行/区域批注、文本编辑、模型投递和多模态附件，但后端没有对应的记录、路由和状态机：旧 `workItems` 是 clone + branch + 评审状态，语义不同，不能复用；面板只有主题相关路由；没有编辑范围上报、同行锁和保存冲突合并；没有模型投递队列、回复工具和 SSE。如果按类型逐个补后端，会先做出多个孤立文件接口，再回头补记录、版本、评论和投递。需要先定 artifacts 记录与主链路，再按前端阶段扩展。

## Decision

后端按 artifacts 独立存储和 exact fetch 路由实现：

- **存储。** 数据在 `.dsh-cowork/artifacts/`：项目级 `events.jsonl` 与 `.write.lock`，每个工作项一个 `<artifactId>/` 目录，内含 `artifact.json`、`comments.jsonl`、`dispatch.jsonl`、`revisions/<revision>-<sha>.<ext>`、`uploads/<attachmentId>.<ext>`。不进 `ProjectIndexV2`，不与旧 `workItems` 共用锁或字段；记录用原子写，读方无锁。
- **模块。** 契约与 handler 在 [src/panel/artifact-contract.ts](../../../../src/panel/artifact-contract.ts)、[artifact-api.ts](../../../../src/panel/artifact-api.ts)、[artifact-edit.ts](../../../../src/panel/artifact-edit.ts)；存储在 [src/store/artifact-schema.ts](../../../../src/store/artifact-schema.ts)、[artifact-store.ts](../../../../src/store/artifact-store.ts)；平台在 `src/platform/artifact-{files,events,presence,dispatch,runtime}.ts`；纯规则在 `src/domains/artifact/`；工具在 [src/tools/artifact.ts](../../../../src/tools/artifact.ts)。
- **路由。** `list`、`detail`、`file`、`comments`、`comment`、`comment.resolve`、`edit`、`presence`、`status`、`upload`、`attachment`、`events`、`open` 已实现；`rebind` 只有契约常量，留到阶段 5。公开路由总数以 [tests/support/public-surface.mjs](../../../../tests/support/public-surface.mjs) 为准。
- **保存与锁。** 文本保存用 `replaceIfVersion`；版本冲突时用 base/current/mine 做行级三方合并，不重叠自动写，重叠返回 409。修订快照最多 20 个/文件；presence 每 300ms 上报、5s TTL；`ctx.tools.guard` 对 `write`/`edit`/`str_replace_editor` 拒绝重叠范围。画布整文件锁，过期保存直接 409，不做行合并。
- **评论与投递。** 评论带行范围锚点、引用原文和 revision，文件变化后重定位，失败标 `stale`；评论/回复只追加，不物理删除。评论默认生成 dispatch：1.5s 合并窗口、每批最多 10 条、同会话串行、跨会话并行、重试 1s/4s/15s；`dispatch.jsonl` 持久化状态机，重启时 in-flight 标 `stale`、queued 重排。只有 `cowork_artifact_reply` 成功才算 `replied`，未调用则 failed，不伪造回复。
- **工具。** `cowork_artifact_create` 登记项目内已有文件；`cowork_artifact_comments` 读取未解决批注；`cowork_artifact_reply` 写回复和附件引用。参数不含绝对路径或任意命令。
- **安全。** 路径 realpath/项目内/已登记，拒绝 `.git`、`.dsh-cowork` 和凭据文件；上传按魔数/UTF-8/大小校验；HTML/SVG 不作为可执行 inline 文档；prompt 里的评论按数据分隔并去控制字符。
- **范围。** Doc、表格、PDF、图片永久移出目标（2026-11-22，KI-57）；用户上传新建工作项、rebind、事件裁剪与列表缓存留给阶段 5。

## Alternatives considered

**把 artifacts 放进 `ProjectIndexV2`。** 否决：每次评论/文件变化都会重写项目索引，和主题/面板写争同一把锁；独立目录按 artifact 增量写，代价是列表要扫描，最多 500 条可接受。

**三方合并放在前端。** 否决：前端要拿 base/current 两份完整内容，文件大时传输翻倍；合并应在宿主侧，和版本校验、写入同一处。

**完全依赖 session inbox，不做持久化 dispatch 日志。** 否决：inbox 只表示“已排队”，不能表达 sent/thinking/working/replied/blocked，也不能在重启后知道哪些回合已接受。

**模型回复直接用 assistant/message 或 inbox 消息。** 否决：回复要落到评论线程、带 commentIds 和附件，assistant 消息没有这些结构；用 user prompt 伪装会污染模型历史和归属。

**复用旧 `workItems` 记录。** 否决：旧记录是 clone + branch + 评审状态，字段完全不同；混用会让路径、状态和评论模型互相污染。

**用 bash/Node fs 直接写入，不走 `ctx.fs`。** 否决：拿不到版本 token 和原子版本守卫；`ctx.fs` 缺失时返回 `artifact/fs-unavailable`，不用另一套语义降级。

**只在右栏做本地状态，不建项目级事件流。** 否决：列表、查看器、多标签页需要同一份状态；SSE + `events.jsonl` 才能续传和跨组件一致。

## Consequences

阶段 0–4 已交付（详见 [WORK_ITEM_RESULT](../../../../docs/handoff/WORK_ITEM_RESULT.md)）：artifacts 存储与路由、评论/锚点、修订与三方合并、presence 与工具守卫、dispatch 状态机与恢复、上传与附件、SSE 回放与 reset、`cowork_artifact_create/comments/reply`、`POST /open`。

代价与已知限制：

- 单宿主/单用户假设，不做多人权限和跨项目隔离。
- 列表每次扫描 `artifacts/*/artifact.json`（上限 500）；超预算再加摘要索引，仍不改项目索引。
- 事件日志会增长，裁剪后靠 `reset` 让客户端重拉；不假装续传。
- bash 可绕过同行锁；保存后对账只能发现，不能事前阻止。
- 模型不调用 `cowork_artifact_reply` 时批次进入 failed，需要真实模型 E2E 调整提示词与工具。
- 阶段 5 仍缺：rebind、事件裁剪参数、启动对账、列表缓存、路径/上传加固、进程级重启与失败注入（KI-53）、用户上传新建工作项。
- Doc、表格、PDF、图片永久移出目标（KI-57），数据模型里的对应 type/anchor 分支只作兼容保留。

重估条件：宿主提供二进制读取/附件保存（KI-54）或文件级 presence 时补对应能力；需要某类型富渲染时另开工作流（KI-57）；发布级重启证据需要扩展 E2E harness（KI-53）。

## Testing

- [B1] 面板路由、错误码与公开面一致，`PANEL_ROUTES` 登记完整 — `tests`
- [B2] artifacts 记录/评论/修订/事件的 schema 与上限校验、存储锁与容错读 — `tests`
- [B3] 保存走 `replaceIfVersion`，冲突先三方合并，重叠返回 409 且不写文件 — `tests`
- [B4] presence 上报与 `tools.guard` 对 `write`/`edit`/`str_replace_editor` 的重叠拒绝 — `tests`
- [B5] dispatch 状态机、合并窗口、重试、重启恢复与 `cowork_artifact_reply` 绑定 — `tests`
- [B6] 上传魔数/大小、路径守卫、附件引用与 HTML/SVG 非可执行返回 — `tests`
- [B7] 真实宿主 keyless E2E 覆盖登记 → 批注 → 投递 → 回复 → 保存合并与恢复 — `e2e`
