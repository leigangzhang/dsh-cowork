# Proposal: 右栏工作项列表去路径/合并状态，批注栏两级化与浮动批注入口

Status: proposed
Date: 2026-11-23
Class: feature

## Problem

右栏工作项列表每张卡显示文件路径和来源会话 ID，两项都不是用户决策所需，反而泄露实现细节，标题属性还会把路径再泄露一次。`待查看` 与 `待确认` 对用户是同一件事却分成两组，`已确认` 措辞与「确认完成」动作不一致。查看器右侧批注栏是单级：线程卡内联展示 + 底部全局回复框，无法先浏览历史再进单条会话；栏宽固定不能拖拽，阅读/源码态默认展开挤压正文；行内批注入口是顶部 sticky 条，离选区远，右键/菜单键无等价入口。详见 [设计文档](../../../../docs/design/work-item/work-item-rail-and-annotation.md)。

## Proposal

在 `src/client/work-item/` 与 `src/panel/artifact-contract.ts` 落以下改动（未来时）：

- **列表投影**：卡片删除 `primaryPath` 与 `ownerSessionId` 的展示，来源行改为 `来源：{sessionTitle ?? '未命名会话'}`；移除 `title={primaryPath}`。`ArtifactSummaryV1` 增加 `sessionTitle?: string | null`，列表路由按 `ownerSessionId` 批量解析会话标题。`ARTIFACT_STATUS_LABELS.confirmed` 改 `'已完成'`。
- **状态合并**：`model.ts` 新增 `railStatusOf`/`railStatusLabel`，`pending-view` 在筛选/分组/计数/卡片标签全部投影为 `pending-confirm`（「待确认」）；底层 `data-status` 保留原始值。`WORK_ITEM_FILTERS`/`GROUP_ORDER` 移除独立 `pending-view`。
- **搜索**：右上搜索按钮展开内联输入，150ms 防抖调用现有 `GET artifact.list?sessionId&q=&status=`；服务端扫描项目全部工作项（≤500）并匹配 `title`/`type` 中文标签/`sessionTitle`（不含 path），返回最多 200 条匹配；截断时提示「匹配结果超过 200 条」。不新增路由。
- **已完成折叠**：`confirmed` 组折叠态渲染整行卡「已完成 N 个工作项」，展开为组标题 + 正常卡片。
- **批注栏两级**：`railView='list' | 'session'`。列表态只读摘要卡（#N chip、选中环、筛选、定位、投递状态），无回复输入；会话态消息记录 + 回复 composer（文字/粘贴图片/上传附件/换行）。工具条「批注 N」打开列表态；默认 `showRail=false`。
- **浮动批注入口**：选中行/文字（含右键、菜单键/Shift+F10）在选区右上角出现 `.cwi-annotate-pop`「批注」按钮，替代旧 `.cwi-selection-bar`；取不到选区矩形的渲染器回退行右侧内联入口。部分文字选区原文写入 `line-range` anchor 的可选 `selectedText`（不参与重定位）。
- **宽度拖拽**：`.cwi-rail-grip` 左缘 6px，钳制 [280, 560]，`min(560, container − 360)` 保正文可读；键盘 ←/→ 每步 8px；写 `localStorage` 键 `cowork.work-item.railWidth`；窄屏仍为底部抽屉。
- **附件预览弹层**：触发、焦点返回与窄屏不遮挡由本文验收；图片缩放/文本预览规格由 [附件设计](../../../../docs/design/work-item/attachment-pipeline.md) 拥有。
- **主区承载面**：查看器挂进 `conversation.view` 由 [主区 View 设计](../../../../docs/design/work-item/work-item-main-view-tab.md) 拥有，本文不重复。

## Alternatives considered

**单栏列表 + 回复混排。** 保留现状的一级批注栏（线程卡内联 + 底部全局回复框），只加一个“折叠回复”开关。否决：用户明确要「历史列表 ↔ 单条会话」两级，混排让“浏览”和“回复”在同一屏抢焦点，长线程会把列表淹没；两级把只读浏览与写会话分开，也满足“列表态不提供回复输入”。

**每线程浮动卡片。** 点行内 pin 时在该行旁边弹出线程小卡片，而不是在右侧栏内进入会话。否决：卡片会被正文滚动裁切、遮挡文字、与附件预览弹层抢层级；右侧栏内会话态与列表态共享同一栏，焦点与 Esc 语义更一致，窄屏抽屉也能复用。

**固定宽度批注栏。** 只保留收起/展开，不做拖拽。否决：不同正文宽度下 336px 固定会浪费或挤压空间，用户明确要“可左右拖动改变宽度”；拖拽成本低且可持久化，固定宽度是让用户承担不适配的代价。

**保留路径/会话 ID 展示。** 卡片继续显示文件路径和来源会话 ID。否决：路径对“看哪个交付物”无信息量且泄露项目结构；会话 ID 是机器标识，用户要的是会话名。改为显示会话名并保留 `sessionTitle` 字段做向前兼容，既不丢信息也不泄露 ID。

**仅客户端搜索（已加载 ≤200 条）。** 否决：用户要求搜索全部工作项；项目上限 500，只搜已加载 200 条会漏掉第 201 条以后的匹配。改为现有 list 路由增加 `q`/`status` 查询参数，服务端扫描项目全部工作项后再截断，不新增路由。

## Acceptance criteria

- [A1] `railStatusOf('pending-view') === 'pending-confirm'` 且 `railStatusLabel` 两者皆「待确认」— `source`
- [A2] `filterArtifacts(items,'pending-confirm')` 同时保留 `pending-view` 与 `pending-confirm`；`filterCount` 的 pendingConfirm 等于两者之和 — `tests`
- [A3] 卡片不渲染 path 与 ownerSessionId，来源行显示会话名（回退「未命名会话」），标题属性不含 path — `tests`
- [A4] `ARTIFACT_STATUS_LABELS.confirmed === '已完成'`；`ArtifactSummaryV1` 含 `sessionTitle?` — `source`
- [A5] 服务端 `q` 搜索命中 title/type/sessionTitle、不命中 path；q+status 同时生效，项目第 201 条可被搜到，超过 200 条时 `truncated=true` — `tests`
- [A6] `confirmed` 组折叠态渲染「已完成 N 个工作项」整行卡 — `tests`
- [A7] 批注栏默认收起；列表态无 composer；点卡进会话态；返回列表 — `tests`
- [A8] 宽度拖拽/键盘钳制 [280,560] 并持久化，窄屏为抽屉 — `browser`
- [A9] 选中/右键/菜单键出现浮动「批注」入口并替代旧 sticky 条；部分文字选区写入可选 `selectedText`，不参与重定位 — `browser` + `tests`
- [A10] 附件预览弹层可触发、Esc/遮罩关闭、焦点返回；图片/文本细节以附件设计验收为准 — `browser`
- [A11] 设计文档与决策记录互链，设计资产可解析 — `plan-docs`

## Risks

- 列表批量解析会话标题通过 `sessionTitles` 端口复用 `listSessionsBounded(ports)` 一次读取，避免 N+1；宿主列表截断时缺失标题回退 null。
- 浮动入口在滚动容器里定位易失效，画布/HTML 取不到行矩形 → 回退行右侧内联入口。
- `panel.tsx` 已是大函数（KI-61），新增 `railView`/`activeThreadId`/`railWidth` 会继续增肥，实现时按 KI-61 拆分。
- 服务端搜索扫描项目全部工作项（≤500）后仍只返回 200 条匹配；截断文案必须说清，避免把截断当成全量结果。搜索只做子串匹配，不是全文检索。
- 重估条件：用户要求搜索 path、全文检索或模糊匹配时，重开本决策。

## Delivery stages

1. **列表投影 + 状态合并 + 服务端搜索 + 已完成折叠** — 卡片去路径/去 ID、显会话名、`railStatusOf` 投影、list `q`/`status` 搜索、折叠卡；`ArtifactSummaryV1.sessionTitle` 契约。
2. **批注栏两级 + 浮动入口 + 宽度拖拽** — `railView` 两级、只读列表卡、会话 composer、浮动「批注」入口替代 sticky 条、grip 拖拽与持久化。
3. **附件预览弹层 + 收口** — 图片/文本/未知类型预览弹层、焦点锁定/下载、窄屏抽屉回归、四档截图与暗色核对。
