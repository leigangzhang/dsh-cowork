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
- 前端：文本编辑器（受控 textarea，见 KI-51）、800ms 防抖自动保存、保存状态、脏行 300ms 上报、409 冲突条（查看差异/加载最新/保留我的）；保存失败后重新进入编辑保留草稿，模型修改文件后只读视图重取内容、脏草稿保留旧保存基准。

阶段 3（投递、回复与多模态）

- `src/platform/artifact-dispatch.ts`：1.5s 合并窗口、每批最多 10 条、同会话同时只有一个 in-flight 批次（终态后恢复下一批）、跨会话并发、队列上限、重试 1s/4s/15s、超时、重启恢复（in-flight → stale，queued 重排）、按 turn 绑定回复/结束事件、非重入 flush、单调状态写；owner 会话 disposed 时 in-flight → blocked。
- `cowork_artifact_comments`、`cowork_artifact_reply`；评论默认投递；`POST /upload`（原始字节 + 魔数/UTF-8 校验）与 `GET /attachment`；评论附件引用。
- 前端：投递状态 chip、附件上传与缩略图、按命名事件订阅 SSE、断线三次后提示重试、重连拉取详情对账；投递入队失败在评论保存后以 `dispatchError` 显示。
- 附件安全：服务端按存储字节重新推导类型/大小/SHA-256（不信任评论或模型给的 ref），文本附件强制 `Content-Disposition: attachment` 与 CSP sandbox；图片只允许 PNG/JPEG/WebP/GIF。
- 上限与回放：评论 5000 条上限在写锁内执行；SSE 回放也按 `artifactId` 过滤。

## 验证证据

均在最终代码树上实际运行（`agent/work-item-docs-facts` HEAD）：

- `npm run check`：`check-invariants: ok`。
- `npm run typecheck`：exit 0。
- `npm test`：1508/1508 通过，0 skipped。
- `npm run test:coverage`：80 个 owner 模块，行覆盖 100%（30591/30591）。
- `npm run build`：exit 0（client bundle 约 196 KB）。
- `npm run test:host-smoke`：5/5 通过。
- `npm run test:browser`：通过；工作项链路，直接保存 + 非重叠自动合并 + 409 后“加载最新”与“保留我的”，脏草稿返回拦截，会话切换自动关闭查看器，图片/文本附件，SSE 实时更新与重试均在真实 Chromium 中执行；两个新 TSX 的 reviewed floors 已登记。
- `npm run test:coverage:layered -- --base 3b140e3`：88 个 counted 文件，行覆盖 99.84%（32808/32859），reviewed floors 全部通过。
- `npm run test:e2e`：6 个 keyless 场景、134 checks 通过。`artifact-chain`（23 checks）覆盖登记 → 列表/详情/文件 → 批注 → 投递 → 模型回复 → 直接保存 → 非重叠三方自动合并 → SSE 回放 → 上传/附件 → `tools.guard` 拒绝重叠模型写入；`artifact-recovery`（7 checks）在真实宿主里从预置的 dispatch 日志执行恢复：in-flight → `stale` 且不再提示，queued 重新投递并由脚本化模型回复。
- `npm run test:e2e:live -- --scenario live-master-chain --scenario live-artifact-chain`：2 个真实模型场景、21 checks 通过。`live-artifact-chain` 观测到：master 与 routed topic 各自登记工作项；两条批注同时处于投递中（`overlap=true`）并都到达 `replied`；红色图片批注的模型回复包含「红」，证明图片 prompt 已到达模型；两个线程的回复均为 `author:"model"`。

## 偏离与未核实

- 编辑器为受控 textarea，不是 CodeMirror（KI-51）；保存/合并/冲突契约不受影响。
- 右栏列表卡不订阅 SSE（KI-52），查看器实时。
- 真实模型 E2E 已跑通核心链路（KI-53 已收窄）：两个会话并行投递、图片 prompt、回复工具采用均通过。恢复路径由 keyless `artifact-recovery` 覆盖“预置日志 → 真实宿主启动恢复”，但仍未做同一 `DSH_HOME` 的进程级重启；真实模型回合被 `tools.guard` 拒绝后的重试、prompt 拒绝触发的退避重试、队列满与 SSE 重连仍只有单测/浏览器片段证据，bash 绕过保持。
- `tools.guard` 的重叠拒绝已由 keyless `artifact-chain` 在真实宿主 + 脚本化模型回合中观测；仍未在一次真实模型回合里观测拒绝后重试。
- 阶段 4/5 未开始：图表/表格/Doc/PDF/画布、`open`/字节 Range、rebind、事件裁剪、列表缓存与旧隔离 workItems 入口（KI-41）。

## 回滚

按阶段提交回退：`git revert` 阶段 1 / 阶段 2–3 的提交即可；数据目录 `.dsh-cowork/artifacts/` 是新增独立目录，删除它不影响 `index.json`、主题页或收件箱。
