# 工作项页阶段 0–3 交付结果

- 日期：2026-11-19
- 状态：阶段 0–3 已实现并提交；阶段 4（图表/表格/Doc/PDF/画布）与阶段 5（收口）未开始
- 执行分支：`agent/work-item-docs-facts`（沿用交接文档指定的工作流分支）
- 交接：[WORK_ITEM_HANDOFF.md](WORK_ITEM_HANDOFF.md)；设计状态已同步为 implementing

## 交付内容

阶段 0（契约与门禁）

- `src/panel/artifact-contract.ts`：路由、wire 类型、状态/错误/上限常量；登记为纯叶契约并进入 `CONTRACT_MODULES`。
- `artifact/*` 错误码并入 `PanelErrorCode` / `PANEL_ERROR_STATUS`，与面板共用错误 envelope。

阶段 1（只读纵切）

- 存储：`src/store/artifact-{schema,store}.ts`，独立 `.write.lock`、原子记录写、JSONL 容错读、项目级事件日志。
- 平台：`artifact-files`（ctx.fs 适配、真实路径守卫、读时对账）、`artifact-events`（事件 hub、SSE 回放/心跳/reset）、`artifact-runtime`（每项目运行时缓存）。
- 路由：list / detail / file / comments / comment / comment.resolve / status / events；`cowork_artifact_create`。
- 前端：Cowork 面板内标签壳（主题/工作项/活动记录/项目记忆）、右栏 `WorkItemList`、主区域 `cowork-work-item` 查看器、逐行/范围批注与评论线程。

阶段 2（编辑、保存与同行锁）

- 修订快照（每文件最近 20 个）、`POST /edit`（直接写 + 409 冲突体）、行级三方合并 `src/domains/artifact/merge.ts`、写后事件与快照。
- `POST /presence`、`src/platform/artifact-presence.ts`、`tools.guard` 对 `write`/`edit`/`str_replace_editor` 的行范围拒绝（bash 缺口保持）。
- 前端：文本编辑器（受控 textarea，见 KI-51）、800ms 防抖自动保存、保存状态、脏行 300ms 上报、409 冲突条（查看差异/加载最新/保留我的）。

阶段 3（投递、回复与多模态）

- `src/platform/artifact-dispatch.ts`：1.5s 合并窗口、每批最多 10 条、同会话串行/跨会话并发、队列上限、重试 1s/4s/15s、超时、重启恢复（in-flight → stale，queued 重排）、单调状态写。
- `cowork_artifact_comments`、`cowork_artifact_reply`；评论默认投递；`POST /upload`（原始字节 + 魔数/UTF-8 校验）与 `GET /attachment`；评论附件引用。
- 前端：投递状态 chip、附件上传与缩略图、按命名事件订阅 SSE、断线三次后提示重试、重连拉取详情对账。

## 验证证据

均在最终代码树上实际运行（`agent/work-item-docs-facts` HEAD）：

- `npm run check`：`check-invariants: ok`。
- `npm run typecheck`：exit 0。
- `npm test`：1494/1494 通过，0 skipped。
- `npm run test:coverage`：79 个 owner 模块，行覆盖 100%（30340/30340）。
- `npm run build`：exit 0（client bundle 约 196 KB）。
- `npm run test:host-smoke`：5/5 通过。
- `npm run test:browser`：通过；工作项链路、编辑/冲突、SSE/附件场景执行；两个新 TSX 的 reviewed floors 已登记。
- `npm run test:coverage:layered -- --base 3b140e3`：87 个 counted 文件，行覆盖 99.77%，reviewed floors 全部通过。
- `npm run test:e2e`：5 个 keyless 场景、121 checks 通过（新增 `artifact-chain`：登记 → 列表/详情/文件 → 批注 → 投递 → 模型回复 → 保存 → 上传/附件 → SSE）。

## 偏离与未核实

- 编辑器为受控 textarea，不是 CodeMirror（KI-51）；保存/合并/冲突契约不受影响。
- 右栏列表卡不订阅 SSE（KI-52），查看器实时。
- 真实模型 E2E 未跑（KI-53）：keyless lane 用脚本化模型证明接线，不能证明模型稳定调用回复工具、图片 prompt、双主题并行与重启 stale。
- `tools.guard` 的真实宿主行范围拒绝只有单测与浏览器保存/冲突链路，未在一次真实模型回合里观测拒绝与重试。
- 阶段 4/5 未开始：图表/表格/Doc/PDF/画布、`open`/字节 Range、rebind、事件裁剪、列表缓存与旧隔离 workItems 入口（KI-41）。

## 回滚

按阶段提交回退：`git revert` 阶段 1 / 阶段 2–3 的提交即可；数据目录 `.dsh-cowork/artifacts/` 是新增独立目录，删除它不影响 `index.json`、主题页或收件箱。
