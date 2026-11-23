# Cowork 工作项：右栏列表与文档批注栏/批注会话设计

Status: proposed（2026-11-23；本文与 [2026-11-23-work-item-rail-and-annotation](../../../.agents/notes/proposed/feature/2026-11-23-work-item-rail-and-annotation.md) 互链）

本文覆盖两块，写清各自边界：

- **A 右栏工作项列表**：搜索、待查看并入待确认、卡片去路径/去会话 ID 改显会话名、已完成文案与折叠卡。
- **B 文档批注栏与批注会话**：两级（历史列表 ↔ 单条会话）、右键浮动批注入口、宽度拖拽、附件预览弹层。

承载面、查看器、锚点、保存/投递、渲染器的事实以 [work-item-frontend.md](work-item-frontend.md)、[work-item-artifact-viewer.md](work-item-artifact-viewer.md)、[work-item-backend.md](work-item-backend.md) 为准，本文不复制。视觉基线以 [visual-acceptance.md](visual-acceptance.md) 为准，本文只写本页增量。

## 1. 背景、目标、非目标、范围

### 背景

右栏工作项列表现在每张卡显示 `primaryPath`（文件路径）和 `ownerSessionId`（来源会话 ID），这两项都不是用户判断“这是哪个交付物、该不该看”需要的信息，反而泄露实现细节；`title` 还被用作卡片的 `title` 属性，路径随 tooltip 再次泄露。状态里 `待查看` 与 `待确认` 对用户是同一件事（都等用户处理），分开反而增加认知负担；`已确认` 的措辞与“确认完成”的动作不一致。

查看器右侧的批注栏现在是一级：线程卡内联展示 + 底部一个全局 composer。用户要的是“先浏览历史批注，再进入某一条批注的对话”，即**历史列表 ↔ 单条会话**两级；列表态不提供回复输入，会话态才给回复框。批注栏当前固定 336px，不能拖拽；阅读/源码态默认展开，侵占了正文宽度。行内批注入口当前是 `.cwi-selection-bar` 顶部 sticky 条，离选区远，右键/菜单键没有等价入口。

### 目标

- 右栏列表卡只回答“这是什么、什么状态、来自哪个会话、什么时候更新”，不泄露路径与会话 ID。
- 待查看与待确认在 UI 上合并为“待确认”，底层状态不删（兼容历史）。
- 批注栏两级化：列表态只读、会话态回复；默认收起，点工具栏“批注 N”打开。
- 批注栏宽度可拖拽并持久化，窄屏为抽屉，不挤压正文。
- 选中行/文字后靠近选区右上角出现浮动“批注”入口，替代旧的 sticky 条；右键/菜单键等价。

### 非目标

- 不实现文档类型扩展（Doc/表格/PDF/图片仍永久移出目标，KI-57）。
- 不做服务端全文搜索、不做 `pending-view` 的存储迁移（只做 UI 投影）。
- 不新增“置顶（pin）工作项”语义；本文 A 段逐项视觉里的“pin”指卡片上的类型/状态药丸 chip，与文档行内“编号 pin”无关。
- 不做批注会话的多人实时协作；不做附件在会话里的二次编辑。
- 不改主区承载面与打开/返回机制；工作项如何挂进 `conversation.view` 由 [work-item-main-view-tab.md](work-item-main-view-tab.md) 拥有，本文只消费它的查看器内容。

### 范围

改 `src/client/work-item/` 的 `list.tsx`、`model.ts`、`panel.tsx`、`thread-list.tsx`、`thread-card.tsx`、`comment-composer.tsx`、`styles.ts` 与 `src/panel/artifact-contract.ts` 的两处契约（见 §5）；不动 `src/panel/` 的路由与存储实现（后端另由 [work-item-backend.md](work-item-backend.md) 收口）。

## 2. 页面结构

### 2.1 右栏工作项列表（A）

```text
Cowork 面板 → 工作项标签（session scope，右栏宽约 300–420px）
└─ .cwi-list
   ├─ 顶栏 .cwi-list-toolbar（sticky）
   │  ├─ 筛选行 .cwi-filter-row：全部 / 待确认 / 需反馈 / 进行中 / 已完成
   │  └─ 搜索 .cwi-search（右侧）：「搜索」按钮 ⇄ 内联输入框
   ├─ SSE 断线提示 / 打开失败提示（role=alert，按需）
   ├─ 分组 .cwi-group（组顺序：待确认 → 需反馈 → 进行中 → 已完成）
   │  ├─ 待确认/需反馈/进行中：组标题 + 卡片
   │  └─ 已完成：折叠时整行卡「已完成 N 个工作项」；展开后组标题 + 卡片
   ├─ 空态 / 无结果态 / 错误态（互斥）
   └─ 截断提示「仅显示最近 200 个工作项；搜索只在已加载范围内生效」
```

关键尺寸：列表自身 `padding 8px 10px 18px`，`gap 6px`；顶栏 sticky 在 `top:0`；卡片高约 92–108px（随 meta 换行）。

### 2.2 查看器与批注栏（B）

```text
主区域 → conversation.view 内容（承载面见 [work-item-main-view-tab.md](work-item-main-view-tab.md)）
├─ ViewerHeader / RebindFileEntry / ViewerToolbar
│  └─ 工具条右侧「批注 N」开关（data-testid=cwi-rail-toggle）
├─ .cwi-body（flex row）
│  ├─ .cwi-content（正文，flex:1；随批注栏拖拽伸缩，有最小可读宽度）
│  │  └─ 文档纸面 .cwi-paper
│  │     ├─ 行 .cwi-line（左侧行号 gutter，右侧编号 pin）
│  │     └─ 选区浮动入口 .cwi-annotate-pop（靠近选区右上角）
│  └─ .cwi-rail（批注栏，默认宽 336px，可拖拽）
│     ├─ 宽度手柄 .cwi-rail-grip（左缘 6px）
│     ├─ 列表态 .cwi-rail-list（默认）
│     │  ├─ 头：批注 [N] / 按位置排序 / 收起（抽屉）
│     │  ├─ 筛选：全部评论 / 待处理 / 已解决 + 只看待处理
│     │  ├─ 线程摘要卡（只读；#N chip、选中环、投递状态、定位）
│     │  └─ 无回复按钮、无输入框
│     └─ 会话态 .cwi-rail-session（点线程/选区进入，覆盖列表）
│        ├─ 头：← 返回批注列表 / #N / anchor
│        ├─ 消息记录（用户批注、模型回复、附件缩略图、投递状态/重试）
│        └─ 回复 composer（文字/粘贴图片/上传附件/换行/提交）
└─ ViewerFooter
```

层叠关系：正文 `z` 基底；行内 pin `z:1`；浮动批注入口 `z:10`（正文滚动容器内定位）；附件预览弹层 `z:40`（portal，盖正文+批注栏）；窄屏抽屉 `z:31`、遮罩 `z:30`（沿用现有 `.cwi-rail-backdrop`）。

## 3. 状态模型

### 3.1 右栏列表（A）

| 状态 | 呈现 |
|---|---|
| 加载 | 3 张骨架卡，`aria-busy=true` |
| 空（无工作项） | 「还没有工作项」+ 说明 + 刷新 |
| 无结果（筛选/搜索后为空） | 「这个筛选下没有工作项」/「没有匹配「q」的工作项」+ 清除搜索 |
| 错误 | 错误码/可读消息 + 重试，保留上次列表 |
| SSE 断线 | 「实时更新中断，点击重试」+ 重试，不清空列表 |
| 截断 | `truncated=true` 时显示 200 条限制提示；搜索仅覆盖已加载窗口 |
| 跨会话/只读 | 列表不感知（打开动作由查看器判断） |

搜索与筛选是 **AND** 叠加：搜索在「当前状态筛选」的结果内做子串匹配；分组标题随匹配结果隐去空组。

### 3.2 批注栏（B）

| 状态 | 呈现 |
|---|---|
| 默认收起 | `showRail=false`；正文满宽；工具条「批注 N」仍显示计数 |
| 列表态 | `railView='list'`；只读摘要卡，无 composer |
| 会话态 | `railView='session'`，`activeThreadId` 非空；消息 + composer |
| 加载（详情） | 会话态头部骨架 |
| 空（无批注） | 「还没有批注。选中行后点「批注」，或直接写整体批注。」 |
| 投递状态 | `queued → sent → thinking → working → replied` 与 failed/blocked/stale；失败/阻塞给原因+重试 |
| 跨会话只读 | 顶部 36px 提示条；批注 composer 禁用；只读 |
| 窄屏（<900px） | 批注栏为底部抽屉；遮罩点击/Esc 收起 |

宽度状态：`railWidth` 初始 336px，钳制 `[280, min(560, containerWidth − 360)]`；拖拽/键盘调整后写 localStorage，重开查看器恢复。

## 4. 交互流程

### 4.1 右栏列表（A）

**搜索。** 点右上「搜索」按钮 → 内联输入框展开并聚焦（`aria-label=搜索工作项`）；输入触发 150ms 防抖后本地过滤；匹配范围 `title`、`type` 中文标签、`sessionTitle`（大小写不敏感的拉丁子串 + 中文子串），**不匹配 `path`**；清空输入或点「×」恢复全量并收起。Esc 收起输入并清空。无结果给空态与「清除搜索」。

**待查看并入待确认。** `model.ts` 提供 `railStatusOf(status)`（`pending-view → pending-confirm`，其余原样）与 `railStatusLabel(status)`（两者都返回「待确认」）。筛选、分组、计数、卡片标签全部走合并语义；底层 `data-status` 属性保留原始值（`pending-view` 或 `pending-confirm`）供测试与兼容，展示标签用合并文案。

**卡片。** 展示：类型 chip、状态 chip、标题（单行/双行省略）、meta chip（评论数/附件数/投递摘要）、更新时间、来源会话名。删除 `.cwi-path` 与来源会话 ID 行；来源行改为 `来源：{sessionTitle ?? '未命名会话'}`。移除卡片 `title={primaryPath}`，改 `title={item.title}` 或去掉。

**已完成折叠。** `confirmed` 组默认折叠，折叠态渲染一张整行卡「已完成 N 个工作项」（chevron + 计数），点击展开为组标题 + 正常卡片；再点组标题可收起回折叠卡。展开/折叠是组件本地状态，切换工作项重置。

### 4.2 批注栏两级（B）

**打开。** 工具条「批注 N」→ `showRail=true` 且 `railView='list'`。阅读/源码态默认 `showRail=false`。

**列表 → 会话。** 点线程摘要卡（或点文档行内编号 pin、或点选区浮动入口新建）→ `railView='session'`、`activeThreadId` 定位；正文滚动到 anchor 行、线程选中环出现。

**列表态操作。** 定位（滚动到 anchor）、筛选切换（全部/待处理/已解决）、已解决折叠；投递失败/阻塞卡显示原因 + 重试。**无**回复按钮、**无** composer。

**会话态操作。** composer 输入文字，Enter 换行，点「提交批注/提交回复」发送；可粘贴图片、上传附件（沿用白名单）；发送后消息立即入列显示 `queued`，SSE 推进状态，失败可重试；「← 返回批注列表」回到列表态（草稿保留在会话态，不丢失）。

**选区浮动入口。** 选中一行或行内部分文字 → 计算选区 top-right，在选区右上角约 `top:-34px`（或选区上方 8px，clamp 到内容盒内）渲染 `.cwi-annotate-pop`「批注」按钮；不遮挡文字。点击 → 以选区构造 `line-range` anchor（整行 quote + 可选 `selectedText` 保存部分文字原文），打开新会话。右键（contextmenu）在选中文字/行上 → 同样的浮动入口。菜单键 / Shift+F10 → 焦点落到浮动入口（等价）。`selectedText` 只用于展示与投递 prompt，不参与 `relocateLineAnchor` 重定位。

**已有入口替换。** 现行 `.cwi-selection-bar`（顶部 sticky 选中条）被浮动入口替代并移除；若某渲染器（画布/HTML）无法可靠取选区 DOM 矩形，回退到「行右侧内联批注按钮」（pin 同侧右移），不保留旧 sticky 条。

**宽度拖拽。** 拖 `.cwi-rail-grip` 水平调整；实时钳制；松手写 localStorage。焦点在 grip 时 ←/→ 每次 8px 调整。窄屏无拖拽（抽屉固定）。正文 `min-width` 保底，不因拉宽批注栏而不可读。

**附件预览弹层。** 点会话消息里的图片/文本附件缩略图 → 打开 [attachment-pipeline.md](attachment-pipeline.md) §9 定义的预览弹层；本页只负责触发、焦点返回和窄屏不遮挡，不重复定义图片缩放/文本预览规格。

## 5. 数据 / 接口 / 契约变化

以下三条落 `src/panel/artifact-contract.ts`（客户端与宿主共享的唯一词表），其余为客户端纯投影：

1. `ARTIFACT_STATUS_LABELS.confirmed`：`'已确认'` → `'已完成'`。影响 `filterLabel`、组标题、卡片状态 chip；宿主不依赖该展示文案。
2. `ArtifactSummaryV1` 增加 `sessionTitle?: string | null`（与 `ArtifactDetailResponse.sessionTitle` 同义）。`GET /api/cowork.artifact.list` 对每条的 `ownerSessionId` 批量解析会话标题，解析不到给 `null`；客户端回退「未命名会话」。**未核实**：列表路由是否有批量会话标题查询能力（详情路由已有单会话解析，列表需按 distinct ownerSessionId 批量解析，或退化为逐条 `ctx.sessions` 读取），实现期需在 [work-item-backend.md](work-item-backend.md) 定确切的宿主调用面。
3. `line-range` anchor 增加可选 `selectedText?: string`（与 `quote` 同受 `MAX_ARTIFACT_QUOTE_CHARS` 限制）：保存用户实际选中的部分文字，供会话详情与投递 prompt 展示；`deriveLineAnchor` 仍从文件全文推导 `quote/context`，`relocateLineAnchor` 不使用 `selectedText`。无部分选区时省略，旧 anchor 不变。

**不新增路由**：搜索是客户端对已加载 ≤200 条的投影；两级批注栏是客户端视图状态；宽度持久化走 `localStorage`（键 `cowork.work-item.railWidth`）；新建会话复用现有 `POST /api/cowork.artifact.comment`；附件预览复用 `GET /api/cowork.artifact.attachment`。

**model.ts 纯函数新增**：`railStatusOf`、`railStatusLabel`、`WORK_ITEM_RAIL_STATUSES`/`WORK_ITEM_RAIL_ORDER`、合并后的 `filterArtifacts`/`filterCount`/`groupArtifacts`，以及搜索投影 `searchArtifacts(items, query)`（title/type/sessionTitle 匹配，不含 path）。这些函数 React-free，`node --test` 直接覆盖。

**权限边界不变**：列表只读；批注写入沿用既有 session/artifact 权限与 `artifact/session-mismatch`；附件路径守卫与白名单沿用既有上传路由。

## 6. 可访问性

- **焦点顺序**（查看器）：会话 header tabs → 工作项 header 操作 → 工具栏「批注 N」→ 正文 → 行内 pin/浮动批注入口 → 批注栏 → composer → footer。批注栏列表态无 composer 时，Tab 从列表尾回到正文。
- **列表**：筛选 chip 是 `role=group` 内按钮，`aria-pressed` 表示激活；搜索输入 `type=search` + `aria-label`；空态/错误 `role=status`/`role=alert`。
- **两级批注栏**：列表态线程卡是按钮，Enter 进入会话；会话态「返回列表」是 Esc 的默认行为，Esc 在列表态回到正文并把焦点还给触发 pin/卡。
- **浮动入口**：`role=button` + `aria-label=批注所选内容`；可见时进入 Tab 序；菜单键/Shift+F10 聚焦它。
- **宽度手柄**：`role=separator` + `aria-orientation=vertical` + `aria-valuemin=280 aria-valuemax=560 aria-valuenow=<width>`；←/→ 调整并播报。
- **附件预览弹层**：`role=dialog` + `aria-modal=true`，打开时焦点移入、Tab 循环、Esc 关闭焦点还原；图片有 `alt`，未知类型给文件名。
- **对比度/颜色**：状态 chip 除颜色外带文字（待确认/已完成/需反馈/进行中）；选中环与 hover 区别（见 §7）；`prefers-reduced-motion` 关闭脉冲/过渡。

## 7. 视觉保真与像素验收（本页增量）

共享基线见 [visual-acceptance.md](visual-acceptance.md)（画板 1280×900、App 1208×828、±2px 关键盒、整数 px、`--cwi-*`/暗色 `--dsw-alias-*`、1280/1024/768/390 四档、WCAG AA）。本页增量：

| 元素 | 规格 |
|---|---|
| 搜索按钮/输入 | 高 26px；圆角 7px；输入 `padding 3px 8px`；展开宽约 168px；placeholder 11.5px；清空「×」24px 热区 |
| 筛选 chip | 沿用 `.cwi-filter`（11.5px，圆角 999px，`padding 2px 10px`）；激活 accent-soft/accent |
| 合并状态 chip | `pending-view` 与 `pending-confirm` 同色 accent-soft/accent，文案均「待确认」 |
| 已完成折叠卡 | 整行高约 34px；圆角 10px；1px `border` dashed；左侧 ✓ 圆点（15px，success-soft/success）；文案「已完成 N 个工作项」11px；chevron |
| 来源行 | 9.5px，`--cwi-soft`；图标（会话）8×8 + 会话名单行省略；不显示 path/ID |
| 卡片高度 | 单行 meta 约 96px，双行约 112px；`padding 10px 12px`；圆角 10px；边框 1px `--cwi-border` |
| 时间 | 10.5px `--cwi-soft`，右对齐 `margin-left:auto`；格式沿用 `formatRelativeTime` |
| 类型/状态药丸（pin 形 chip） | 类型 10px/750 圆角 4px；状态 10px/650 圆角 999px `padding 1px 7px` |
| 浮动批注入口 | 高 26px；圆角 7px；accent 底白字（或 surface+accent 描边）；`box-shadow 0 2px 8px`；距选区右上 `top:-34px`，clamp 内容盒；不遮挡选区文字 |
| 部分文字选区 | 浏览器原生 selection 高亮；批注入口出现时不改变选区；会话头显示 `selectedText` 单行省略（最大 240px），无 `selectedText` 时显示整行 quote |
| 批注栏宽度 | 默认 336px，范围 280–560px（`min(560, container − 360)`）；grip 左缘 6px 宽，hover/focus accent |
| 列表态摘要卡 | 紧凑卡：`#N` chip 9px/700、`padding 1px 5px` 圆角 4px；选中环 `0 0 0 2px accent-soft`；无 composer |
| 会话态消息 | 用户消息 surface 底；模型回复 `--cwi-model-soft` 底 + `--cwi-model-border` 边框；附件缩略图 max 220×160 圆角 8px |
| 附件预览弹层 | 规格由 [attachment-pipeline.md](attachment-pipeline.md) §11 拥有；本页只验收触发、Esc/遮罩关闭、焦点返回和窄屏不遮 composer |

**验收四档**：1280 并排（正文 + 批注栏 336px）；1024 批注栏可缩 280px；768 抽屉；390 单列无横向滚动、附件 chip 最多 1 个 + `+N`。拖拽到 560px 时正文仍 ≥360px 可读；≥1024 档批注栏默认收起时正文满宽。

**行级 diff 底色**：共享基线 §5.7 已定新增/删除/修改底色；本文**不伪造 diff 数据**——当前没有可靠的逐行 diff 源，版本/冲突区明确标注「行级差异数据不可用」，普通行按正常渲染。数据依赖（未来按版本快照逐行比对产生 `add/delete/modify` 三类行）写为降级项，实现前不渲染任何红/绿底。

## 8. demo 计划与资产

- 交互稿：[annotation-rail-demo.html](assets/annotation-rail-demo.html)，截图：[annotation-rail-demo.png](assets/annotation-rail-demo.png)。
- 覆盖场景（5 个，均为同一 HTML 内的标注 board，实际截图）：
  1. 右栏工作项列表（搜索框、待查看合并进待确认、已完成折叠卡、来源会话名、无路径/无 ID）。
  2. 批注历史列表（只读摘要、#N chip、选中环、筛选、无回复输入）+ 行内编号 pin。
  3. 批注会话详情（消息记录、模型回复、附件缩略图、回复 composer、投递状态）。
  4. 右键浮动「批注」入口（靠近选区右上角，不遮文字）。
  5. 窄屏抽屉（批注栏为底部抽屉，遮罩 + 收起）。
- 截图用 headless Chromium，`deviceScaleFactor=2`，亮色 1280 宽整页；已做程序化核对（尺寸、非纯色、文本覆盖）；队长已用 read_image 目检整板缩略图并通过，像素级需按单板 1280×900 截图在实现期比对。
- 390px 抽屉：[annotation-rail-narrow-390.png](assets/annotation-rail-narrow-390.png)（`read_image` 已目检：抽屉占底部、列表无 composer、正文在遮罩后仍可辨）。

## 9. 测试与验收标准

- 纯函数（`node --test`）：`railStatusOf`/`railStatusLabel` 合并映射；`filterArtifacts` 在 `pending-confirm` 下同时保留 `pending-view` 与 `pending-confirm`；`filterCount` 的 `pendingConfirm = pendingConfirm + pendingView`；`groupArtifacts` 无独立 `pending-view` 组且顺序正确；`searchArtifacts` 命中 title/type/sessionTitle、不命中 path、大小写与空串语义。— `source`
- 卡片投影：卡片渲染来源会话名（`sessionTitle ?? '未命名会话'`），不渲染 path 与 ownerSessionId，标题属性不含 path。— `tests`
- 已完成：`confirmed` 文案「已完成」；折叠态渲染「已完成 N 个工作项」整行卡，展开为正常卡片。— `tests`
- 批注栏两级：默认 `showRail=false`；工具条「批注 N」打开列表态；列表态无 composer/回复；点卡进会话态；返回列表。— `tests`
- 宽度：拖拽/键盘调整钳制 [280, 560]，写 `localStorage`，重开恢复；窄屏抽屉。— `browser`
- 浮动入口：选中/右键/菜单键出现靠近选区右上角的「批注」按钮，替代旧 sticky 条；点击新建会话。— `browser`
- 附件预览：图片/文本/未知类型弹层，焦点锁定、Esc/遮罩关闭、下载。— `browser`
- 契约：`ARTIFACT_STATUS_LABELS.confirmed === '已完成'`；`ArtifactSummaryV1` 含 `sessionTitle?`。— `source`
- 文档：`npm run check` 通过；设计文档与决策记录互链。— `docs`

验收口径：上述每一行都可落到一条断言/截图；改动会让对应 surface（`source`/`tests`/`browser`/`docs`）变红。

## 10. 风险、未核实项、回滚/降级

**风险**

- **列表批量会话标题解析**：列表最多 200 条，逐条解析 ownerSessionId 标题有 N+1 风险；需批量/缓存，未核实宿主是否有批量会话列表接口。
- **浮动入口定位**：正文是滚动容器，选区矩形随滚动失效；需在每次滚动/选择时重算并 clamp，画布/HTML 渲染器可能取不到行矩形 → 回退行右侧内联入口。
- **两级视图与现有状态耦合**：`panel.tsx` 已是大函数（KI-61），新增 `railView`/`activeThreadId`/`railWidth` 状态会继续增肥，实现时按 KI-61 拆分。
- **宽度拖拽与正文可读**：拉到 560px 时窄正文可能换行过多，需 `min(560, container − 360)` 兜底并保底正文最小宽。
- **本地搜索与截断**：搜索只在已加载 ≤200 条内生效，截断时可能漏掉未加载的匹配项；提示文案必须说清，避免误解为服务端全文检索。

**未核实**

- 列表路由批量解析 `sessionTitle` 的宿主能力（§5 第 2 条）。
- 暗色主题 `--dsw-alias-*` 具体取值未对真实宿主核对（沿用现有 `styles.ts` 的覆盖，仅做了 token 名引用）。
- 菜单键/Shift+F10 在正文编辑器（CodeMirror）里是否被编辑器自身拦截，实现期需实测。
- `pending-view` 的历史记录数量分布（决定合并后「待确认」计数是否显著变大）。

**回滚/降级**

- 两条契约改动是纯展示 + 一个可选字段，向前兼容：去掉 `sessionTitle` 字段回退「未命名会话」；`confirmed` 文案改回只需恢复 `ARTIFACT_STATUS_LABELS` 一行。
- 合并投影在 `model.ts` 一层：若要恢复「待查看」独立展示，还原 `WORK_ITEM_FILTERS`/`GROUP_ORDER` 与映射函数即可，底层状态从未改动。
- 浮动入口若定位不可靠，降级为行右侧内联「批注」按钮（§4.2 的既有回退），不阻塞批注功能。
- 宽度持久化失败（localStorage 禁用/满）时回退默认 336px，不阻断打开批注栏。
