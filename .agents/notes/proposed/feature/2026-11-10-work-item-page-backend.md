# Proposal: 工作项后端（artifacts、批注、版本、投递与 SSE）

Status: proposed
Date: 2026-11-10
Class: feature

## Problem

工作项页面的前端方案已经定稿：右栏列表、主区域查看器、逐行/区域批注、文本编辑、模型投递、多模态附件和各类型渲染。前端设计见 [work-item-frontend.md](../../../../docs/design/work-item/work-item-frontend.md)，页面设计见 [work-item-artifact-viewer.md](../../../../docs/design/work-item/work-item-artifact-viewer.md)。

后端还没有这项工作：

- 没有 artifacts 记录、文件清单、评论、修订、投递和事件流；`src/work-item.ts` 是旧的代码隔离工作项，字段和语义都不同，不能复用。
- 面板只有主题相关的六条 exact route（`src/api.ts:961-1004`），没有工作项路由。
- 没有编辑范围上报、同行锁、保存冲突合并；`ctx.fs` 的版本守卫和 `tools.guard` 还没有接到工作项。
- 没有模型投递队列、回复工具、SSE；会话 prompt/event 能力存在，但没有和工作项批注连起来。

如果按类型逐个补后端，会先做出多个孤立文件接口，再回头补记录、版本、评论和投递。需要先定 artifacts 记录和主链路，再按前端阶段扩展。

## Proposal

按[后端设计](../../../../docs/design/work-item/work-item-backend.md)实现；本轮只写设计，不写生产代码。

**1. 独立 artifacts 存储。** 数据放在 `<repo>/.dsh-cowork/artifacts/<artifactId>/`，包含 `artifact.json`、`comments.jsonl`、`dispatch.jsonl`、`revisions/`、`uploads/`；项目级 `events.jsonl`。不改 `ProjectIndexV2`，不与旧 `workItems` 共用锁或字段。artifacts 使用独立 `.write.lock`、原子记录写、读方无锁。

**2. 记录与文件。** `ArtifactRecordV1` 带 owner 会话、类型、状态（待查看/待确认/需反馈/进行中/已确认）、文件清单、revision 和计数；文件路径只允许项目内已登记相对路径。列表扫描最多 500 个记录并缓存；详情/文件/评论分页；SSE 带 seq 和 `Last-Event-ID`。

**3. 保存与锁。** 文本保存用 `ctx.fs.resolve/readText/writeText` 的 `replaceIfVersion`；版本冲突时用 base/current/mine 做后端行级三方合并，不重叠自动写，重叠返回 409。修订快照最多 20 个/文件。编辑范围每 300ms 上报、5s TTL；`ctx.tools.guard` 对 `write`/`edit`/`str_replace_editor` 按路径和行范围拒绝重叠；画布整文件锁。bash 绕过作为确认缺口，靠提示词和保存后核对降低风险。

**4. 评论与锚点。** 文本行范围 + 引用原文 + revision；Doc 块指纹、表格 cell、图表行/节点、画布元素/区域、PDF/图片 page/region、整体评论。保存/文件变化后后端重定位，失败标 `stale`，不丢内容和回复。评论只追加，解决/重开也追加事件。

**5. 投递。** 评论默认生成 dispatch；1.5 秒合并、最多 10 条、同会话串行、跨主题默认并行 4。`dispatch.jsonl` 持久化状态机 `queued→sent→thinking→working→replied`，失败/阻塞/超时/重启分别进入 `failed/blocked/stale`。用 `sessionController.prompt` 的 queue 模式；模型必须调用 `cowork_artifact_reply` 才算 replied，未调用则 failed，不伪造回复。

**6. 工具。** 主题会话/主会话可 `cowork_artifact_create` 登记项目文件；`cowork_artifact_comments` 读取未解决批注；`cowork_artifact_reply` 写回复和附件。工具内校验 owner/role、路径、commentIds 和大小。

**7. 安全。** 路径 realpath/项目内/已登记；拒绝 `.git`、`.dsh-cowork` 内部和凭据文件；上传按魔数/UTF-8/大小/数量校验；HTML/SVG 不作为可执行 inline 文档；沿用 connection 的 Host/Origin 和浏览器 cookie；prompt 里的评论按数据分隔并去控制字符。

**8. 阶段。** 后端阶段 1 只读（记录/列表/详情/文件/评论/SSE/创建工具）；阶段 2 编辑/保存/合并/守卫/投递/回复/上传；阶段 3 图表/表格复用；阶段 4 Doc/PDF/画布字节和整文件锁；阶段 5 恢复/安全/性能/E2E。与前端五阶段一一对应，阶段 1 先让前端用只读接口联调。

**9. 不在本提案。** 旧 `workItems` 合并、多人权限、跨项目工作项、PDF 页内区域批注、复杂 Office 版式、Artifact 工作室和活动记录页。用户“上传文件新建工作项”也后置：首版由主题会话 `cowork_artifact_create` 登记项目内已有文件，上传只服务评论/回复附件。

## Alternatives considered

**把 artifacts 放进 `ProjectIndexV2`。** 否决：每次评论/文件变化都会重写项目索引，和主题/面板写争同一把锁；还要升 schema、做迁移，并承担旧 `workItems` 语义混淆。独立目录可以按 artifact 增量写，读方无锁。代价是列表要扫描，最多 500 条可接受；超预算再加 artifacts 自身摘要索引。

**三方合并放在前端。** 否决：前端要拿到 base/current 两份完整内容，文件大时传输翻倍；保存的权威合并应该在宿主，版本校验和写入在同一侧。前端只展示合并结果和冲突范围。

**完全依赖 session inbox，不做持久化 dispatch 日志。** 否决：inbox 只表示“消息已排队”，不能表达 sent/thinking/working/replied/blocked，也不能在重启后知道哪些回合已经接受；会把重复投递和状态丢失留到用户侧。

**模型回复直接用 assistant/message 或 inbox 消息。** 否决：回复要落到工作项评论线程、带 commentIds 和附件，assistant 消息没有这些结构；用 user prompt 伪装会污染模型历史和归属。用 `cowork_artifact_reply` 工具能校验、幂等和触发事件。

**复用旧 `workItems` 记录。** 否决：旧记录是 clone + branch + 评审状态，字段和新交付物完全不同；混用会让路径、状态和评论模型互相污染。

**用 bash/Node fs 直接做所有写入，不走 `ctx.fs`。** 否决：拿不到版本 token 和原子版本守卫，保存冲突只能靠时间戳；`ctx.fs` 缺失时单独返回 `artifact/fs-unavailable`，而不是用另一套语义悄悄降级。

**只在右栏做本地状态，不建项目级事件流。** 否决：列表/查看器/多标签页需要同一份状态；SSE + `events.jsonl` 才能续传和跨组件一致。

## Acceptance criteria

- [B1] 设计逐项覆盖前端五阶段；每个能力都有后端模块/路由，没有无落点的项 — `plan-docs`
- [B2] artifacts 独立存储、记录/评论/修订/投递/事件 schema、API、错误码完整；明确不复用旧 `workItems` — `plan-docs`
- [B3] 保存版本/409/三方合并/修订保留、presence/工具守卫/画布整文件锁的规则和失败路径明确 — `plan-docs`
- [B4] 投递状态机、合并窗口、并发/队列上限、prompt 格式、回复工具、重启恢复明确 — `plan-docs`
- [B5] 路径/上传/HTML-SVG/认证/prompt 注入边界明确 — `plan-docs`
- [B6] 每阶段有测试计划和真实宿主 E2E 门禁；未核实项单独列出 — `plan-docs`
- [B7] 提案含真实备选方案；README、feature 待办、前端设计互相链接；`npm run check` 通过 — `plan-docs`

## Risks

- SSE、图片 prompt、工具守卫和重启恢复仍未在真实宿主验证；实现阶段第一步必须跑 E2E。
- bash 绕过同行锁是确定缺口；只能提示词 + 保存后核对，不能宣称完全阻止。
- artifacts 列表扫描 500 条在慢盘上可能超预算；先测，再决定是否加摘要索引。
- 事件日志会增长；裁剪后用 `reset` 让客户端重拉，不能假装续传。
- 模型可能不调用回复工具；设计选择 failed 而不是伪造回复，需要真实模型调优。
- 单宿主/单用户假设；本版不做多人权限和跨项目隔离。
- `ctx.fs` 或 `connection` 缺失时路由/保存要明确降级，不能使插件加载失败。

## Delivery stages

1. **只读闭环。** 记录/存储、列表/详情/文件、评论/锚点、SSE 基础、`cowork_artifact_create`、fixture 和路由测试。对应前端阶段 1。
2. **编辑与投递。** 修订/保存/合并、presence/守卫、dispatch/重试/恢复、`cowork_artifact_reply`、上传/多模态、真实宿主 E2E。对应前端阶段 2。
3. **图表与表格。** 复用文本保存/文件路由；图片/SVG 上传与导出。对应前端阶段 3。
4. **Doc、PDF 与画布。** 字节/Range、在应用中打开、画布整文件锁、docx/xlsx 原件/下载。对应前端阶段 4。
5. **收口。** 事件裁剪、重启恢复、rebind、性能缓存、安全、完整 E2E。对应前端阶段 5。

## Documents

- 设计：[work-item-backend.md](../../../../docs/design/work-item/work-item-backend.md)
- 前端方案：[work-item-frontend.md](../../../../docs/design/work-item/work-item-frontend.md)
- 页面设计：[work-item-artifact-viewer.md](../../../../docs/design/work-item/work-item-artifact-viewer.md)
- 核实：[work-item-artifact-verification.md](../../../../docs/design/work-item/work-item-artifact-verification.md)
