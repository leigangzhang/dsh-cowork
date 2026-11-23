# Cowork 工作项主区 View 标签集成设计

Status: proposed（design，2026-11-23）

本页只设计「工作项查看器如何挂进宿主会话区的 View 标签」，不改查看器内部的文档/批注/编辑交互，也不改右侧栏列表。查看器内部结构以 [work-item-artifact-viewer.md](work-item-artifact-viewer.md) 为准，前端承载面原方案见 [work-item-frontend.md](work-item-frontend.md)，后端契约见 [work-item-backend.md](work-item-backend.md)，视觉尺寸以共享基线 [visual-acceptance.md](visual-acceptance.md) 为准。为什么选 `conversation.view` 而放弃全屏 `selectPanel`，见决策记录 [2026-11-23-work-item-main-view-tab.md](../../../.agents/notes/proposed/architecture/2026-11-23-work-item-main-view-tab.md)。

## 1 背景、目标、非目标

### 背景

- 现状：查看器是 root `main` 的 keyed panel（`src/client/index.tsx:36-39` 注册 `main/key=cowork-work-item`；`src/client/work-item/list.tsx:207-216` 用 `layout.selectPanel('cowork-work-item')` 打开；`src/client/work-item/panel.tsx:429-432` 用 `selectPanel(null)` 返回）。全屏替换会盖住会话区，用户要回到会话必须显式「返回会话」。
- 需求（附件《工作项样式和功能优化》）：点击右栏工作项后，在左侧会话框位置新增「Cowork / 工作项」标签页展示文档和批注；用户确认/编辑文档的同时能随时切回会话继续讨论，顺序查看多个文档可从右栏快速切换；默认不显示，只有打开文档时才显示。

### 目标

- 用宿主 session 作用域 `conversation.view` 槽位承载查看器，替代 `layout.selectPanel` 全屏替换。
- 单标签：工作项共用一个标签，切换文档复用同一标签、替换内容。
- 默认不显示：只有存在打开的工作项时动态注册 view；关闭后注销，本插件标签随之消失。
- 打开文档保留当前会话，不自动切到 `ownerSessionId`。
- 跨会话工作项只读预览；只有当前会话 == owner 时才完整交互。
- **全局可见性限制**：`conversation.view` 的注册名册是全局的，不是每会话过滤；存在打开项时该标签会出现在所有会话的 tab strip。内容在非 owner 会话下自动降级为跨会话只读；关闭工作项后整条注册移除。这是宿主 slot 的边界，不在本设计里伪装成「只在 owner 会话显示」。

### 非目标

- 不新增/修改宿主源码或宿主包。
- 不改后端数据契约：本设计只消费现有 `artifact.*` 路由（[work-item-backend.md](work-item-backend.md) 的 API 表）。
- 不改右侧栏列表本身的布局/字段（列表重构属另一子任务）。
- 不恢复旧 `workItems` 语义。
- 不在用户未操作时切换会话。

## 2 页面结构

文字树（会话区，session scope）：

```text
conversation.session.header          会话 header（宿主）
├─ titleRow：面包屑 / 会话标题 / 操作
└─ [data-conversation-tabs] tab strip（role=tablist）   ← 集成点
   ├─ tab "Chat"（role=tab, aria-selected）
   └─ tab "Cowork"（role=tab, aria-selected=true）      ← 本插件动态注册

scrollBody（宿主）
├─ .viewArea（宿主，composer overlay 下 flex:1 1 0; overflow:hidden）
│  └─ WorkItemViewer（根带 data-conversation-composer-overlay）
│     ├─ 跨会话只读提示条（仅跨会话时）
│     ├─ ViewerHeader：面包屑/标题/类型/状态/操作
│     ├─ ViewerToolbar：文档/版本/附件、阅读/源码、保存状态、批注开关
│     ├─ .cwi-body
│     │  ├─ .cwi-content（文档纸面，内部滚动）
│     │  └─ .cwi-rail（批注栏，336px，窄屏为抽屉）
│     └─ ViewerFooter：投递摘要/版本/更新时间
└─ .composerSeat（宿主，data-conversation-composer-overlay 下 position:absolute; bottom:0）
   └─ 会话 composer（浮动覆盖层）
```

层叠关系（关键）：

- 查看器根元素声明 `data-conversation-composer-overlay`。宿主 `.scrollBody:has([data-conversation-composer-overlay])` 变为裁剪盒（`overflow-x:hidden`），`.viewArea` 变为 `flex:1 1 0; overflow:hidden`，`.composerSeat` 变为 `position:absolute; bottom:0; left:0; right:var(--dsh-scrollbar-width)`（宿主 `skeleton/ConversationRoot.module.css`）。
- 查看器自持内部滚动：`.cwi-content`（文档纸面）与 `.cwi-rail`（批注栏）各自滚动，外层 `.viewArea`/`.scrollBody` 不再滚动，避免双滚动条。
- 会话 composer 浮动在查看器底部之上（宿主 `.composerSeat` 有 `z-index:9` 与 `will-change:transform`）。查看器用 `--dsh-composer-height` 预留底部 clearance，footer 与批注 composer 不被永久遮挡。
- 查看器根设 `isolation:isolate`，把 pin/选中环/批注抽屉的 z-index 圈在 view 内，不溢出到会话 tab 行之上（轨迹视图同款，`ui-trajectory/src/client/views.module.css`）。

关键尺寸（沿用共享基线 [visual-acceptance.md](visual-acceptance.md) 第 3 节）：

- 会话 header 至少 76px（有 tab 行时）；tab 行高 25px，tab 间距 14px，tab 13px/500（active 600），active 2px 底线 accent。
- 纸面最大 920px；批注栏默认 336px；底部 clearance `calc(var(--dsh-composer-height, 152px) + 16px)`。
- 窄屏 <900px 批注栏改底部抽屉。

## 3 状态模型

| 状态 | 判定 | 界面 |
|---|---|---|
| 无打开项 | `workItemOpenStore.context === null` | view 未注册；本插件标签不出现，tab strip 是否显示由宿主其余 view 决定 |
| 加载 | context 非空，detail/file/comments 请求中 | 标题+内容骨架，`aria-busy=true` |
| 正常（同会话） | 加载成功且 `currentSession === ownerSessionId` | 完整查看器：编辑/批注/回复/保存/投递全可用 |
| 跨会话只读 | 加载成功且 `currentSession !== ownerSessionId` | 顶部只读提示条 + 编辑/批注 composer 禁用 + 「在所属会话打开」 |
| 空 | 无文件/空正文 | 单行说明 + 主操作 |
| 错误 | detail/file 请求失败、文件缺失 | 错误底 + 错误码/可读消息 + 重试 + 返回会话 |
| 文件缺失 | detail 标 `missing` | 重新绑定文件入口 |
| 保存冲突 | 编辑 409 且重叠 | 顶部冲突条 + 查看差异/加载最新/保留我的 |
| 投递失败/阻塞 | dispatch failed/blocked | 批注卡与顶部显示原因 + 重试 |
| 会话切换失败 | 「在所属会话打开」openSession 未生效 | 可见错误 + 重试 + 保持当前会话只读 |
| 窄屏 | 视口 <900px | 批注栏底部抽屉；composer overlay 不被抽屉遮挡 |

SSE：查看器与列表复用现有项目事件流（[work-item-backend.md](work-item-backend.md) SSE 节）；`file.changed`/`comment.created` 等触发 `refreshFromServer`，不改本设计的标签生命周期。

刷新后：view 是否显示取决于 `workItemOpenStore` 是否仍有打开项。该 store 是内存态，刷新即空 → 标签不注册、不显示；这是可接受的（工作项非持久打开态），见风险 R3。

## 4 交互流程

### 4.1 打开（同会话，当前会话即 owner）

1. 右栏卡片 `onClick` → `workItemOpenStore.open({ artifactId, ownerSessionId })`（写 store，触发订阅）。
2. store 订阅回调：若 view 尚未注册，`ctx.slots.register({ name:'conversation.view', id:COWORK_VIEW_ID, label, inject }, WorkItemView)`；已注册则跳过（幂等）。
3. 切到 Cowork 标签：DOM 点击（见 4.5），校验 `aria-selected`；失败在右栏列表顶部显示 `role=alert` 错误与「重试切换」，不把错误藏在尚未显示的查看器里。
4. 查看器 `inject:(sessionId)` 收到当前会话；`crossSession = sessionId !== ownerSessionId` 为 false → 完整交互；**所有 artifact.* API 统一用 `ownerSessionId` 解析项目和作用域**，因此跨会话也能源数据；加载 detail/file/comments。

### 4.2 切换文档（复用标签）

1. 右栏点另一卡片 → `workItemOpenStore.open({...新 artifact...})`。
2. view 已注册，标签已选中，不重复注册、不重复切标签；查看器因 context 变化重载内容（`panel.tsx` 现有 `context` effect 已按 `contextKey` 判重载）。
3. 切换前持久化旧草稿（现有 `persistDraftRef`），防止丢失。

### 4.3 关闭标签 / 返回会话

1. 查看器「返回会话」或 Esc/关闭 → 持久化草稿 → `workItemOpenStore.close()`。
2. store 订阅回调：dispose 注册（`slots.register` 返回的 disposer）。
3. 宿主 `refreshViews`（监听 `conversation.view` 变化）→ `restoreView` → `resolveActiveView` 找不到已注销 view → 回退 Chat；本插件标签消失。**tab strip 是否整体消失取决于宿主其余 view**：安装 dsh-context 时「上下文/编队」仍注册，tab strip 保留；没有其它 view 时才回到单 Chat 的隐藏态。
4. 可选清理：若 `localStorage['dsh.conversation.<sessionId>'].view` 仍指向本 view，写回 `'chat'`（或删 key），避免下次会话绑定时读到过期偏好。

### 4.4 跨会话只读 + 「在所属会话打开」

打开时 `currentSession !== ownerSessionId`：

- 只读态：编辑入口、批注 composer、回复、确认、保存全部禁用（不渲染假按钮）；文档/批注历史仍可读；pin/选中环/附件预览保留只读交互。
- 顶部提示条显示 owner 会话名（`detailMeta` 的 `sessionTitle`）与「在所属会话打开」。

「在所属会话打开」流程（不自动切换，只有用户点击才切换）：

1. 若 owner 会话已归档且 `uiWorkspace.unarchiveSession` 可用 → 先 unarchive；不可用则继续尝试。
2. 写偏好：把 `localStorage['dsh.conversation.<ownerSessionId>'].view` 设为 `COWORK_VIEW_ID`（与现有 draft 合并，不覆盖）。
3. `uiWorkspace.openSession(ownerSessionId)`（fire-and-forget，宿主切会话）。
4. 校验：轮询宿主会话列表（扩展 `SessionsService.list`）确认当前会话变为 owner，且本 view 标签 `aria-selected==='true'`；超时（≤1.5s）未达成 → 走 4.5 的 DOM 点击回退。
5. 仍失败 → 可见错误 + 「重试」+「保持当前会话只读」，不回静默。

### 4.5 DOM 点击切标签（selector / 校验 / 重试 / 上限）

宿主无公开 `selectView/openView`（`ctx.uiConversation` 不暴露；`conversation.view` 的 `openView` 只注入给 view 自身，列表侧拿不到）。同会话切换只能点击 tab strip：

```
selector：'[data-conversation-tabs] button[role="tab"]'
匹配：   textContent.trim() === COWORK_VIEW_LABEL（'Cowork'）
动作：   若 aria-selected === 'true' → 已选中，成功；
        否则 click()，再以 requestAnimationFrame + 100ms 步进轮询
        aria-selected 变为 'true'（上限 10 次 ≈ 1s）。
重试：   轮询超时未选中 → 重新 click，最多 2 次。
失败：   抛可观察失败；**右栏列表顶部的列表错误区**显示 `role=alert` 的可读错误与「重试切换」按钮，不能只依赖尚未显示的查看器错误条；可选同时把打开上下文保留为「待重试」。
```

限定到 `[data-conversation-tabs]` 的原因：宿主其他地方（如右侧栏）也有 `button[role="tab"]`，全局选择会误点；dsh-context 的现做法是全局 `button[role="tab"]` 匹配文本（`dsh-context/lib/client.js` 的 `y_`），本设计收窄到 tab strip，并额外校验 `aria-selected`。

### 4.6 刷新后 / 当前会话切换

- 刷新：store 为空 → view 不注册；不做持久恢复（R3）。
- 会话切换（已打开工作项）：view 是 session 作用域，宿主切会话后 view 在新会话重挂载，`inject:(sessionId)` 返回新 sessionId；`crossSession` 重新计算。artifact API 始终用 ownerSessionId 解析项目，所以切到其它会话（包括其它项目）仍能加载同一工作项，只是进入跨会话只读；「在所属会话打开」仍可用。若 owner session 本身被移除/归档且 API 无法解析，显示错误 + 重试。
- 与旧方案的差异：不再依赖 `sessions.retainInfo(...).retainedBy.mainView` 自动关闭；view 生命周期由宿主会话切换自然驱动。

## 5 数据 / 接口 / 契约变化

后端路由零变化（只消费现有 `artifact.*`）。变化集中在客户端本地契约：

### 5.1 打开上下文（`src/client/work-item/store.ts`）

```ts
export interface WorkItemOpenContext {
  readonly artifactId: string
  readonly ownerSessionId: string   // 新增：工作项所属主题会话；所有 artifact.* API 的作用域
}
```

- artifact.* API 统一用 `ownerSessionId` 解析项目与权限；当前会话只用于判断 `crossSession` 和 UI 只读态，不参与 API 作用域。这样跨会话预览不会因为当前会话属于另一项目而读 404。
- 列表 `open()` 从 `ArtifactSummaryV1` 取 `ownerSessionId`；当前会话由 view 的 `inject(sessionId)` 提供，不写进打开上下文。
- `open()` 语义不变：同 artifact 幂等跳过；不同 artifact 替换 context 并触发订阅。

### 5.2 客户端槽位/服务契约（`src/client/contracts.ts`）

- `SlotRegisterOptions` 增加 `label?: () => string` 与 `inject?: (sessionId: string) => Readonly<Record<string, unknown>>`（`conversation.view` 注册需要 id/order/label/inject）。
- `SessionsService` 增加 `list`（当前会话列表快照与订阅），供「在所属会话打开」校验当前会话是否已切换。
- `LayoutService` 保留为可选（其它路径仍可能用），但查看器打开/返回不再依赖 `selectPanel`。

### 5.3 常量

- `COWORK_VIEW_ID = 'cowork-work-item'`（同时是 tab id）。
- `COWORK_VIEW_LABEL = 'Cowork'`（tab 文案，与 DOM 点击匹配共用同一常量；不用易截断的长文案）。

### 5.4 错误与恢复

- 无新错误码；查看器复用 `errorPresentation`（`model.ts`）渲染。
- DOM 点击失败与 openSession 失败是本页新增的两条可观察失败，用 `role=alert` 可见错误条承载，均有「重试」动作。

## 6 可访问性

- 标签语义由宿主保证：`[data-conversation-tabs]` 是 `role="tablist"`，每个 tab 是 `button[role="tab"]` 且带 `aria-selected`（`ConversationSession.tsx`）。本插件不重复造 tab 语义，只读/写 `aria-selected`。
- tab 键盘：宿主 tab 按钮是原生 button，Left/Right 不自动切换（宿主未实现 roving tabindex）；本页不擅自接管宿主 tab 键盘，键盘用户可用 Tab 聚焦后 Enter/Space 切换。若宿主后续补 roving tabindex，本插件无需改动。
- 焦点返回：窄屏批注抽屉关闭后焦点回到「批注开关」按钮（现有 `RailEscape`）；「在所属会话打开」触发会话切换后，焦点落在新会话 header，由宿主接管。
- 跨会话只读：禁用的编辑/批注控件用 `disabled` + 可读原因，不只用颜色；只读提示条为 `role="status"` 或普通区域文本（非 `alert`，避免打断）。
- 对比度与 focus-visible 沿用共享基线 [visual-acceptance.md](visual-acceptance.md) 第 7 节；`prefers-reduced-motion:reduce` 下关闭状态脉冲，文案保留。

## 7 视觉保真与像素验收

共享基线 [visual-acceptance.md](visual-acceptance.md) 已拥有：tab strip 尺寸/间距/active 下划线（§3）、pin/选中环/anchor 序号/附件 chip/评论筛选/活动时长/行级 diff/版本计数（§5）、状态与错误（§6）、键盘（§7）、响应式（§8）。本页只写「标签集成」带来的增量项：

| 元素 | 增量规格 |
|---|---|
| view 根 | `isolation:isolate; width:100%; height:100%; overflow:hidden; display:flex; flex-direction:column` |
| 底部 clearance | `calc(var(--dsh-composer-height, 152px) + 16px)`，作用于查看器底部 padding（footer 之上），保证 footer/批注 composer 不被浮动 composer 遮挡 |
| viewArea 与 composer 间距 | composer 覆盖时与查看器内容底边留 ≥16px 空隙；composer 左/右对齐会话内容列 |
| 跨会话只读提示条 | 高 36px；`danger-soft`/`warn-soft` 底；文案「当前会话不是该工作项所属会话」+ owner 名 + 「在所属会话打开」按钮 |
| 批注栏宽度 | 默认 336px；可拖（现有）280–560px；窄屏抽屉最大高度 `min(72%, 560px)`，不得遮挡 composer |
| tab strip | 出现/消失不引起 header 高度跳动（无 tab 时按宿主规则收缩） |

四档验收：1280 / 1024 / 768 / 390；关键布局盒（tab strip、viewArea、header、toolbar、paper、rail、composer、footer）位置容差 ±2px；不得出现非预期横向滚动；1280/1024 下 composer 覆盖层不盖住最后一行正文或 footer。亮/暗两套各核对。

## 8 Demo 计划与资产

- 交互稿：[work-item-main-tab-demo.html](assets/work-item-main-tab-demo.html)（`?state=same|cross|loading|error|narrow`）。
- 截图：[work-item-main-tab-demo.png](assets/work-item-main-tab-demo.png)（headless Chromium，`deviceScaleFactor=2`，3840×1800 拼接（3×2 状态板）；已用 DOM 断言 + 像素分析核对；队长已用 read_image 目检状态板并通过，像素级 ±2px 需实现期截图比对）。
- 390px 响应式：[work-item-main-tab-narrow-390.png](assets/work-item-main-tab-narrow-390.png)（`read_image` 已目检：tab 仍可见、批注栏下移、composer 覆盖不遮正文）。
- 状态：①同会话完整交互（tab strip + 完整查看器 + composer overlay + clearance）；②跨会话只读（只读提示条 + 禁用 composer + 「在所属会话打开」）；③加载/错误（骨架 / 错误条 + 重试）；④窄屏（768，批注抽屉 + composer overlay 不被遮挡）；⑤像素/状态对照板。

## 9 测试与验收

每条可执行、可观察；标注哪个检查会红。

| # | 验收 | 检查面 |
|---|---|---|
| T1 | 右栏点击 → 注册 `conversation.view`，tab strip 出现「Chat / Cowork」，`aria-selected` 与 active 下划线同步切到 Cowork | 浏览器 lane |
| T2 | 关闭 → dispose 注册 → 本插件标签消失；有其它 view（context/fleet）时 tab strip 保留并回退 Chat | 浏览器 lane |
| T3 | 切换文档 → 标签不重建、内容替换、旧草稿持久化 | 浏览器 lane |
| T4 | DOM 点击 selector 精确、`aria-selected` 校验、超时/重试上限、失败在右栏显示可见错误 | 单测（纯函数）+ 浏览器 lane |
| T5 | 跨会话只读：编辑/批注/回复禁用，「在所属会话打开」写 localStorage + openSession，成功后变完整交互 | 浏览器 lane + 真实宿主 |
| T6 | openSession 失败 → 可见错误 + 重试 + 保持只读，不静默 | 浏览器 lane |
| T7 | 刷新后 view 不显示（store 空） | 浏览器 lane |
| T8 | 切换会话：`crossSession` 重算；artifact API 仍用 ownerSessionId 读到同一工作项；只读而非 404 | 浏览器 lane + 真实宿主 |
| T9 | SSE：`file.changed`/`comment.created` 触发刷新，标签不重建 | 浏览器 lane |
| T10 | composer overlay：footer/最后一行正文不被遮挡；批注栏内滚；窄屏抽屉不遮 composer | 浏览器 lane（截图）+ 视觉核对 |
| T11 | 可访问性：tablist/tab/tabpanel ARIA、focus-visible、Esc 关抽屉、对比度、`prefers-reduced-motion` | 浏览器 lane + 人工/图像核对 |
| T12 | dsh-context 兼容：与宿主既有 `conversation.view`（context/fleet、trajectory）并存，不互相顶替 | 真实宿主 |

会红的检查：T4 的单测（DOM 点击纯函数失败分支）；T10 的截图核对（composer 遮挡正文即红）；T12 的真实宿主（view 注册冲突）。后端路由不变，`npm run check` / `typecheck` 只覆盖新增的纯函数与契约。

## 10 风险、未核实项、回滚 / 降级

### 风险

- R1 DOM 点击脆弱：依赖 tab strip 结构与文案 `textContent`。缓解：限定 `[data-conversation-tabs]` + 校验 `aria-selected` + 重试上限 + 可见错误；标签用固定短文案 `Cowork`。
- R2 localStorage 只读语义：`dsh.conversation.<sessionId>.view` 只在会话首次绑定/打开时由宿主 `readConversationViewPreference` 读取，已打开会话不重读。缓解：跨会话「在所属会话打开」先写偏好再 openSession，并配 DOM 点击回退（4.5）。
- R3 刷新丢打开态：`workItemOpenStore` 是内存态，刷新后标签消失。可接受（工作项非持久打开态）；若后续要持久，再加 session 级恢复，不属本页。
- R4 跨项目会话切换：artifact API 固定用 ownerSessionId 解析，因此仍能读同一工作项；当前会话只影响只读态。若 owner session 本身不可用，降级为错误 + 重试 + 「在所属会话打开」，不自动关。
- R5 openSession 无回执：`uiWorkspace.openSession` 是 void，无法 await 成败。用 `SessionsService.list` 轮询校验 + 超时 + 回退。

### 未核实（实现期 E2E 门禁）

- 真实宿主 `SessionsService.list` 的精确快照形状（当前契约只写了 `retainInfo`）。
- 已绑定会话上 openSession 是否触发 `restoreView` 重读 localStorage（决定跨会话回退是否必需）。
- tab `textContent` 在极窄宽度省略下是否仍保留完整文本（`ViewTabLabel` 用 CSS 省略，DOM `textContent` 理论保留全文，需实测）。
- 卸载 `conversation.view` 注册后宿主 `refreshViews`→`resolveActiveView` 是否稳定回退 Chat（源码路径已核对，真机回归确认）。

### 回滚 / 降级

- 降级一：DOM 点击失败 → 回退 `localStorage` 写偏好 + `uiWorkspace.openSession`。
- 降级二：两者都失败 → 保持当前会话、只读预览 + 可见错误 + 重试，不静默、不假装成功。
- 回滚：还原 `src/client/index.tsx` 的 `main` keyed panel 注册与 `list.tsx` 的 `layout.selectPanel` 路径，删除 `conversation.view` 注册与 store/contract 增量，即可回到全屏查看器；后端与查看器内部零改动，回滚面小。

## 相关文档

- [决策记录](../../../.agents/notes/proposed/architecture/2026-11-23-work-item-main-view-tab.md)
- [共享视觉基线](visual-acceptance.md)
- [查看器设计](work-item-artifact-viewer.md)
- [前端设计](work-item-frontend.md)
- [后端设计](work-item-backend.md)
