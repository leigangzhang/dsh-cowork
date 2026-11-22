# Decision: 工作项前端（主区域查看器、右栏列表、编辑/批注/投递）

Status: implemented
Date: 2026-11-10
Class: feature

## Problem

工作项页要回答的是“这份交付物现在是什么、我要在哪一行提意见、模型改到哪一步”。主题页只回答“有哪些主题、什么状态、要处理去哪里”；旧的代码隔离 `workItems` 记录 clone、branch 和评审状态。两者都不能承载逐行批注、编辑保存和模型投递。查看器设计与 V1–V16 核实已经定下页面结构、编辑器选型和体积上限，缺的是把“列表 → 主区域 → 批注 → 版本 → 投递”连成一条可演示的链路；按类型逐个开发则会先得到一组孤立预览器，再回头补主链路。

## Decision

工作项前端落在 `src/client/work-item/`，在 [src/client/index.tsx](../../../../src/client/index.tsx) 注册 keyed `main` panel `cowork-work-item`；右栏工作项列表挂在 [src/client/panel.tsx](../../../../src/client/panel.tsx) 的“工作项”内部标签里。

- **承载面。** `CoworkPanel` 有主题 / 工作项 / 活动记录 / 项目记忆四个标签：主题标签承载主题页 v2 + 收件箱，工作项标签渲染 `WorkItemList`，活动记录与项目记忆是占位。列表用 `ctx.layout.selectPanel('cowork-work-item')` 打开主区域，返回会话用 `selectPanel(null)`。宿主没有 `layout` 时显示无法打开，不降级为右栏全屏。列表是 session-scoped，不新增 `sidebar.panellist` 入口。
- **查看器。** [panel.tsx](../../../../src/client/work-item/panel.tsx) 持有加载、保存、SSE 与评论状态，展示拆到 `viewer-header.tsx`、`viewer-toolbar.tsx`、`viewer-footer.tsx`、`viewer-side-tabs.tsx`、`thread-list.tsx`、`thread-card.tsx`、`comment-composer.tsx`；纯视图投影在 `model.ts`。
- **类型与渲染器。** 实现 `text`、`diagram`、`canvas`、`html` 四类（`viewers/`）：文本与图表/HTML 源码用 CodeMirror 6，图表用 Pele 渲染 SVG，HTML 用 opaque iframe 沙箱预览，画布用 Excalidraw。`doc`、`table`、`pdf`、`image` 自 2026-11-22 永久移出目标（KI-57），只保留源码行/下载路径。
- **编辑与投递。** 文本 800ms 防抖自动保存、脏行 300ms 上报 presence、版本冲突先做行级三方合并、重叠才进 409 冲突条；画布整文件锁。批注默认投递到主题会话，前端只展示 `queued → sent → thinking → working → replied` 与失败/阻塞/过期状态，不自己排队。
- **构建。** 客户端仍是 [scripts/build/build-client.mjs](../../../../scripts/build/build-client.mjs) 的单文件 CJS 闭包；CodeMirror 与 Excalidraw 随主包加载，不做按需 chunk。

## Alternatives considered

**复用宿主现有的文档预览作为查看器。** 否决：它只解决只读预览，不能逐行批注、编辑、保存冲突、按类型投递，也不能接模型回复。

**把 demo 用 iframe 嵌进主区域。** 否决：demo 是静态原型，没有宿主会话、保存、SSE 和权限；iframe 还要 `postMessage` 桥接，键盘、主题色和焦点都难统一。

**工作项只在右栏全屏打开，不注册主区域。** 否决：设计和用户确认都是主区域查看器 + 右栏列表；右栏全屏会挤压评论栏和工具条。

**一次性把九种类型全做完再联调。** 否决：主链路没打通时，类型越多联调面越大。实际按阶段先做文本，再做图表/画布/HTML；Doc、表格、PDF、图片在 2026-11-22 被用户永久移出目标，未进入实现。

**把 Excalidraw 做成独立可选包。** 暂不采用：客户端上限已放宽到 100 MB，Excalidraw 随主包加载；单文件闭包构建暂时不能分块。构建支持 chunk 后可以重新评估。

**继续用旧的 `workItems` 记录。** 否决：旧记录是代码隔离和评审状态，字段和语义都不是交付物；混用会让状态、路径和评论模型互相污染。

## Consequences

阶段 0–4 与 demo 对齐批次 A/B 已交付（详见 [WORK_ITEM_RESULT](../../../../docs/handoff/WORK_ITEM_RESULT.md)）：右栏标签与列表、主区域查看器、Markdown 逐行批注、CodeMirror 编辑与 409 合并、投递状态、附件、图表/画布/HTML 查看器、头部面包屑/版本/打开/导出与评论筛选。阶段 5 的窄屏/键盘/空错态/性能/包体收口与真实模型 E2E 仍待做。

代价与已知限制：

- 客户端产物是单文件 CJS 闭包，CodeMirror 与 Excalidraw 不能懒加载；client bundle 约 15.5 MB，`npm pack` 约 9.9 MB。
- bash 可绕过同行锁；守卫只覆盖 `write`/`edit`/`str_replace_editor`。
- Excalidraw 字体未本地化，画布含文本时走上游 CDN（KI-58）；HTML 交互预览的 iframe 可自行导航（KI-60）。
- 图表节点级批注与画布元素级模型工具未实现（KI-57）；`WorkItemViewer` 仍是较大的单函数（KI-61）。
- 暗色主题只做 token 覆盖，未做视觉截图核对。

重估条件：需要 Doc/表格/PDF/图片中的某类型时另开工作流（KI-57）；构建需要分块或包体需要压缩时重新评估 Excalidraw 加载方式；查看器下一次行为变更时按 KI-61 继续拆分。

## Testing

- [W1] 工作项标签按状态分组/筛选，卡片只显示类型、状态、评论数、附件数、更新时间 — `source`
- [W2] 列表打开 `cowork-work-item` 主区域并带 `{sessionId, artifactId}`；返回会话关闭；无 `layout` 时给出提示 — `tests`
- [W3] 文本可逐行/范围批注，刷新后线程仍在；原文改动后锚点重定位失败标“位置待确认”且保留内容 — `tests`
- [W4] 文本编辑自动保存；版本冲突先做行级合并，重叠才进冲突条；脏行 presence 阻止结构化模型写入 — `tests`
- [W5] 批注投递展示 queued 到 replied；SSE 断线后重连并拉详情对账 — `e2e`
- [W6] 图表、画布、HTML 各有查看器与源码编辑；Doc、表格、PDF、图片不在范围（KI-57） — `browser`
- [W7] 上传图片/文件、附件引用和路径守卫有测试 — `tests`
- [W8] 客户端单文件闭包构建通过，宿主 smoke 消费当前 `lib/` — `packaging`
- [W9] 设计、决策、交接与 demo 链接一致，`npm run check` 通过 — `plan-docs`
