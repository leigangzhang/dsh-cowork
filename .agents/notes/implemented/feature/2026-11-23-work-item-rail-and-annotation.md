# Decision: 右栏工作项列表去路径/合并状态，批注栏两级化与浮动批注入口

Status: implemented
Date: 2026-11-23
Class: feature

## Problem

右栏工作项列表每张卡显示文件路径和来源会话 ID，两项都不是用户决策所需，反而泄露实现细节，标题属性还会把路径再泄露一次。`待查看` 与 `待确认` 对用户是同一件事却分成两组，`已确认` 措辞与「确认完成」动作不一致。查看器右侧批注栏是单级：线程卡内联展示 + 底部全局回复框，无法先浏览历史再进单条会话；栏宽固定不能拖拽，阅读/源码态默认展开挤压正文；行内批注入口是顶部 sticky 条，离选区远，右键/菜单键无等价入口。详见 [设计文档](../../../../docs/design/work-item/work-item-rail-and-annotation.md)。

## Decision

- **列表投影**：`src/client/work-item/list.tsx` 的卡片只渲染类型、状态、标题、评论数、附件数、投递状态、更新时间和来源行；来源行由 `model.ts` 的 `sourceLabel` 输出 `来源：{sessionTitle ?? '未命名会话'}`，`title` 属性只取 `cardTitle(item)`（即标题）；`primaryPath` 与 `ownerSessionId` 不上卡面。`ArtifactSummaryV1` 与 `ArtifactDetailResponse` 带可选 `sessionTitle`；`GET artifact.list` 通过 `ports.sessionTitles()` 一次取全项目会话标题（宿主 `listSessionsBounded`），缺失的登记为 `null`。`ARTIFACT_STATUS_LABELS.confirmed` 是 `'已完成'`。
- **状态合并**：`src/panel/artifact-contract.ts` 的 `WORK_ITEM_RAIL_STATUSES`、`railStatusOf`、`railStatusLabel`、`artifactStatusMatches` 是唯一投影：`pending-view` 在筛选、分组、计数和卡片标签上一律显示为「待确认」，存储状态不改。`src/client/work-item/model.ts` 的 `WORK_ITEM_FILTERS` 与 `WORK_ITEM_GROUP_ORDER` 没有独立的 `pending-view`；`filterCount` 的 `pendingConfirm` 是两种存储状态之和。
- **服务端搜索**：`GET artifact.list` 接受 `status` 与 `q`（≤ `MAX_ARTIFACT_SEARCH_CHARS` 100 字符），整项目扫描（上限 `MAX_ARTIFACTS_PER_PROJECT` 500）后在服务端匹配标题、类型中文标签和 `sessionTitle`，从不匹配 path；按更新时间倒序返回最多 `ARTIFACT_LIST_MAX_LIMIT` 200 条，`truncated` 同时覆盖「扫描被上限截断」和「命中超过 200」。右栏搜索按钮展开 `type=search` 内联输入，`LIST_SEARCH_DEBOUNCE_MS` 150ms 防抖后发一次请求，×/Esc 清空并收起，无结果时回显查询词并提供「清除搜索」。
- **已完成折叠**：`confirmed` 组默认折叠为整行卡「已完成 N 个工作项」，展开后是组标题 + 普通卡片，组标题可再次折叠；其他组默认展开。
- **批注栏两级**：`src/client/work-item/rail-state.ts` 的 `RailState`（`list` | `session`）与纯函数 `railSessionState`/`railBackToList`/`railAfterContextChange`/`railSessionThread`/`railOrdinal`/`railListProjection` 是导航与列表投影模型；`src/client/work-item/rail.tsx` 的 `useRailNavigation` 持有 `showRail`（默认 false）、级别和活动线程。工具条「批注 N」展开列表态；列表态只读（摘要卡、筛选、定位、投递状态），没有 composer；点卡或 pin 进入会话态；会话头「← 返回批注列表」回列表且保留草稿；切换工作项重置级别与目标。
- **浮动批注入口**：`src/client/work-item/annotation-pop.tsx` 的 `AnnotationPop` 是阅读态与源码态共用的 `.cwi-annotate-pop` 入口，位置由 `rail-geometry.ts` 的 `annotationPopPosition` 在滚动/缩放后重算并 clamp 在内容盒内；右键与 Shift+F10 打开同一入口并聚焦「批注」按钮；取不到选区矩形时回退为行右侧内联入口。部分文字选区的原文写入 line-range anchor 的可选 `selectedText`，只用于展示与会话头引用，不参与 `relocateLineAnchor`。
- **宽度拖拽**：`src/client/work-item/rail-geometry.ts` 定义 `RAIL_WIDTH_MIN` 280、`RAIL_WIDTH_MAX` 560、默认 336、键盘步长 8 与 `RAIL_CONTENT_MIN` 360；`railWidthClamp` 的上界是 `min(560, containerWidth − 360)`，容器过窄时保底 280；指针拖拽写 `localStorage` 键 `cowork.work-item.railWidth`，←/→ 每次 8px，存储不可用时回退默认；窄屏是抽屉且不显示 grip。
- **附件预览入口**：附件页行和 thread 缩略图都经 `AttachmentPreviewProvider` 打开预览弹层，Esc、遮罩、关闭按钮三条关闭路径都恢复触发点焦点；图片/文本/未知类型的内部规格由 [attachment-pipeline.md](../../../../docs/design/work-item/attachment-pipeline.md) §9.2 拥有。
- **面板拆分**：批注栏级别、导航与宽度从 `panel.tsx` 拆到 `rail-state.ts`/`rail.tsx`（KI-61 的 burn-down）；`panel.tsx` 只保留查看器编排与接线。

## Alternatives considered

**单栏列表 + 回复混排（否决）。** 保留一级批注栏（线程卡内联 + 底部全局回复框），只加一个「折叠回复」开关。浏览与回复在同一屏抢焦点，长线程会把列表淹没；落地的两级把只读浏览与写会话分开，列表态因此能不提供回复输入。

**每线程浮动卡片（否决）。** 点行内 pin 时在正文旁弹出线程小卡片。卡片会被正文滚动裁切、遮挡文字、与附件预览弹层抢层级；右侧栏内会话态与列表态共享同一栏，焦点与 Esc 语义一致，窄屏抽屉也能复用。

**固定宽度批注栏（否决）。** 只保留收起/展开。不同正文宽度下 336px 固定会浪费或挤压空间；落地按容器钳制并持久化，拖拽成本低。

**保留路径/会话 ID 展示（否决）。** 路径对「看哪个交付物」无信息量且泄露项目结构；会话 ID 是机器标识。改为显示会话名并保留可选 `sessionTitle` 字段，缺失时回退「未命名会话」。

**仅客户端搜索（已加载 ≤200 条，否决）。** 项目上限 500，只搜已加载的 200 条会漏掉第 201 条以后的命中。落地在现有 list 路由加 `q`/`status` 查询参数，服务端扫描全项目后再截断，不新增路由。

## Consequences

- 卡片不再暴露 path、记录 id 与 owner session ID；搜索也不再按 path 命中，因此同目录同名文件的区分只能靠标题。`title` tooltip 只显示标题。
- 服务端搜索是大小写不敏感的子串匹配，不是全文检索或模糊匹配；单条查询上限 100 字符，结果上限 200 条，超出时界面明说「匹配结果超过 200 条，仅显示前 200 条」，不把截断当全量。
- 列表的每状态计数始终描述整个项目，不随筛选或搜索变化；搜索与筛选只收窄返回的卡片。
- `pending-view` 仍以原值存储、仍可被状态接口写入；它只在展示与筛选投影上并入「待确认」，因此没有数据迁移，也没有合并前的历史计数统计。
- 会话标题依赖宿主会话列表：宿主无该能力、列表失败或被截断时，卡片回退「未命名会话」，搜索该条只按标题与类型命中，不影响列表与计数。
- 已完成折叠是视图状态：切换会话或重新挂载列表会回到折叠默认，不持久化展开状态。
- 批注栏列表态没有回复入口，新建批注从会话态开始（新批注在提交前没有 thread）；composer 草稿存在查看器，列表/会话往返不清空；切换工作项会清空。
- 宽度拖拽在窄容器里会被钳到 280（正文保底 360 优先于用户宽度）；窄屏抽屉不可拖拽；禁止 localStorage 的浏览环境回退 336。
- 附件预览弹层在 390px 的「指针打开」未验证：浏览器 lane 为绕过宿主窄屏壳层，先在 1440 打开再缩到 390 测公式与遮挡，未在 390 直接点击触发。暗色主题沿用既有 token 覆盖，未新增逐像素核对。
- 右键/Shift+F10 在阅读态有断言；源码态与图表态走同一入口，但菜单键只按阅读态验证。画布/HTML 取不到行矩形时按设计回退行右侧内联入口，不做选区定位。
- `panel.tsx` 拆分后仍为 1,288 行、50,171 B（约 49.0 KiB）；距 51,200 B 硬顶 1,029 B，仍高于 49,152 B 软目标，KI-61 的 burn-down 继续有效。
- 重估条件：用户要求按 path 搜索、全文检索或模糊匹配时，重开搜索决策；宿主提供会话标题之外的来源标识或宽度 setter 时，重评列表来源行与窄屏抽屉。

## Testing

- [A1] `railStatusOf('pending-view') === 'pending-confirm'`，`railStatusLabel` 对两者都返回「待确认」 — `source`
- [A2] `artifactStatusMatches('pending-confirm', …)` 同时保留 `pending-view` 与 `pending-confirm`；`filterCount.pendingConfirm` 等于两者之和；分组顺序无独立待查看 — `tests`
- [A3] 卡片不渲染 path、记录 id 与 owner session ID，来源行显示会话名（回退「未命名会话」），`title` 属性只含标题 — `browser`
- [A4] `ARTIFACT_STATUS_LABELS.confirmed === '已完成'`；`ArtifactSummaryV1` 与详情带可选 `sessionTitle` — `source`
- [A5] `q` 命中标题/类型标签/`sessionTitle`、不命中 path；q+status 同时生效；第 201 条可被搜到；命中超过 200 条时 `truncated=true` — `tests`
- [A6] `confirmed` 组折叠为「已完成 N 个工作项」整行卡，展开显示卡片、组标题可再折叠 — `browser`（折叠默认的纯模型断言在 `tests`）
- [A7] 批注栏默认收起；工具条「批注 N」打开列表态；列表态无 composer/回复；点卡进会话态；返回列表；草稿跨往返保留 — `browser`
- [A8] 宽度拖拽与 ←/→ 步进钳制在 [280, 560]（上界 `container − 360`），写 `localStorage` 且重开恢复；窄屏抽屉无 grip — `browser`（几何纯函数在 `tests`）
- [A9] 选中/右键/Shift+F10 出现靠近选区的浮动「批注」入口并替代旧 sticky 条；部分文字选区写入 `selectedText` 且不参与重定位 — `browser` + `tests`
- [A10] 附件预览弹层可从附件页与 thread 缩略图触发，Esc/遮罩/关闭按钮关闭并焦点返回，弹层填满可用视口 — `browser`
- [A11] 设计文档、决策记录与设计索引互链，`npm run check` 通过 — `plan-docs`
