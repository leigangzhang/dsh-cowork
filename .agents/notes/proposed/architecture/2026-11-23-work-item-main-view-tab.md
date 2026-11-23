# Proposal: 用宿主 conversation.view 承载工作项主区，替代 layout.selectPanel 全屏替换

Status: proposed
Date: 2026-11-23
Class: architecture

## Problem

工作项查看器当前是 root `main` 的 keyed panel，打开时用 `layout.selectPanel('cowork-work-item')` 全屏替换会话区，返回时 `selectPanel(null)`（`src/client/index.tsx:36-39`、`src/client/work-item/list.tsx:207-216`、`src/client/work-item/panel.tsx:429-432`）。全屏替换把会话区和输入框整个盖掉，用户查看/编辑一份交付物时必须先「返回会话」才能继续讨论，也无法在右栏快速切换多份文档。用户明确要求（附件《工作项样式和功能优化》与 2026-11-23 验收意见）：在会话框位置新增「Cowork / 工作项」标签页展示文档和批注，默认不显示，打开文档才显示，且切回会话继续讨论不受影响；顶部显示文档对应的会话名、查看器内不再重复一行面包屑；批注栏默认折叠；Cowork 标签下不显示浮动的会话输入框。

## Proposal

把查看器从 `main` keyed panel 改为宿主 session 作用域 `conversation.view` 槽位（与 dsh-context 的「上下文/编队」、宿主 trajectory 同一机制）：

- 单标签 `COWORK_VIEW_ID = 'cowork-work-item'`，`label = () => 'Cowork'`；`ctx.slots.register({ name:'conversation.view', id, order, label, inject:(sessionId)=>({sessionId}) }, WorkItemView)`，返回的 disposer 保存下来。
- 动态注册：订阅 `workItemOpenStore`；存在打开项才注册，关闭即 dispose（幂等）。view 名册是全局的，所以存在打开项时该标签会出现在所有会话；非 owner 会话自动降级为跨会话只读，关闭后整条注册移除。
- 打开：`workItemOpenStore.open({ artifactId, ownerSessionId })`，注册 view 后用 DOM 点击 `[data-conversation-tabs] button[role="tab"]` 切标签（宿主无公开 `selectView/openView`）；失败在右栏列表显示可见错误与重试，不只藏在查看器里。
- 跨会话：`inject:(sessionId)` 给查看器当前会话；`sessionId !== ownerSessionId` 时只读预览，显示 owner 会话名与「在所属会话打开」；artifact.* API 统一用 `ownerSessionId` 解析项目。 「在所属会话打开」写 `localStorage['dsh.conversation.<ownerSessionId>'].view` + `uiWorkspace.openSession(ownerSessionId)`，失败回退 DOM 点击，再失败保持只读并提示。
- 顶部会话身份：不新增第二行面包屑。宿主 `conversation.session.header` 渲染当前会话的祖先链，普通主题会话只有一节标题；同会话打开工作项时它就是文档对应的会话名，跨会话时文档所属会话名由查看器顶部 36px 只读提示条给出。`conversation.session.header.lineage` 是单槽且会 shadow 宿主既有 UI，本决策不注册它，也不改宿主源码。
- 会话 composer：宿主固定渲染 `[data-composer-seat]`（`conversation.composer` 是 overlay 槽，fallback 始终渲染），没有按 view 隐藏的公开能力。本插件在样式表里用 `[data-conversation-scroll]:has(.cwi-viewer) > [data-composer-seat] { display: none }` 在视图挂载期间隐藏它；切到 Chat 规则失效，composer 与草稿自动恢复。查看器根保留 `data-conversation-composer-overlay`，只把它当作宿主「视图自持滚动」的布局开关；不再预留 `--dsh-composer-height` clearance。
- 批注栏：默认收起（正文满宽），工具条「批注 N」展开 336px；内部两级交互与宽度归 [work-item-rail-and-annotation](../feature/2026-11-23-work-item-rail-and-annotation.md)。
- 关闭：`workItemOpenStore.close()` → dispose 注册 → 宿主 `refreshViews`→`resolveActiveView` 回退 Chat；本插件标签消失，composer 恢复。tab strip 是否整体消失取决于宿主其余 view（dsh-context 的 context/fleet 常驻时保留）。
- 查看器根声明 `data-conversation-composer-overlay`，自持内部滚动；`isolation:isolate` 限制 z-index 溢出。
- 客户端契约增量：`store.ts` 的 `WorkItemOpenContext` 增加 `ownerSessionId`；`contracts.ts` 的 `SlotRegisterOptions` 增加 `label`/`inject`，`SessionsService` 增加 `list`。后端路由零变化。

设计全文见 [work-item-main-view-tab.md](../../../../docs/design/work-item/work-item-main-view-tab.md)。

## Alternatives considered

**custom root main tab shell（自建主区标签壳）。** 保留 `main` panel，但在 panel 内部自画一套「会话 / 工作项」标签和双视图切换。放弃原因：会话区是宿主的，自建壳要么复制会话渲染（拿不到宿主会话组件），要么只能包住查看器这一侧、无法真正并排「会话 + 工作项」，等于换壳不换实质，还多维护一套 tab 语义。

**扩展 host selectView API（给 `ctx.uiConversation` 加公开切 view 服务）。** 最干净，但需改宿主源码/新增宿主能力，违背本仓库「不修改宿主源码」与「Local only / 不新增宿主包」的约束；且升级宿主要回归，收益与耦合不成比例。放弃，改为 DOM 点击 + 可观察失败降级。

**常驻 view 标签（启动即注册，不动态装卸）。** 实现最简单，但违背用户「默认不显示，打开文档才显示」的明确要求，还让所有会话常驻一个空标签、污染 tab strip。放弃。

**当前全屏 selectPanel 方案（维持现状）。** 无需改动，但直接违反用户需求：盖住会话、无法并排、切换文档要反复进出全屏。作为回滚点保留，但不作为前进方案。

**保留浮动会话 composer（覆盖在查看器底部）。** 用户明确要求 Cowork 标签下不显示该输入框；保留它会让文档底部长期被 152px 覆盖层占用，也暗示「在这里发消息」但实际上下文是文档。放弃，改为切到 Chat 输入。

**注册 `conversation.composer` 条目来替换/移除宿主 composer。** 该槽是 additive：插件条目与 fallback 同时渲染，无法移除 fallback；`priority` 只影响顺序。放弃，改为样式表隐藏宿主 seat。

**注册 `conversation.session.header.lineage` 在顶部追加文档所属会话名。** 该槽是单槽，dsh-client-ui-subagent 已占用，注册会 shadow 宿主既有标题渲染（`replaceRisk: shadows-shipped-ui`）。放弃，跨会话信息放在查看器提示条。

## Acceptance criteria

- [A1] 只有存在打开的工作项时 `conversation.view` 注册，关闭即注销；本插件标签出现/消失与 store 状态一致，宿主其余 view 不受影响 — `tests`
- [A2] 打开跨会话工作项不切换会话、只读禁用编辑/批注；artifact API 仍用 ownerSessionId 读到同一工作项；「在所属会话打开」才切换；顶部会话名仍是当前会话 — `source`
- [A3] DOM 点击限定 `[data-conversation-tabs] button[role="tab"]`、校验 `aria-selected`、超时/重试上限、失败在右栏显示可见错误 — `source`
- [A4] Cowork 视图挂载期间宿主 `[data-composer-seat]` 不可见，切到 Chat 恢复；查看器自持滚动、footer 贴底且无 clearance — `source` / `browser`
- [A5] 与宿主既有 view（chat/trajectory/context/fleet）并存不顶替，真实宿主回归通过 — `browser`
- [A6] 查看器不渲染第二行面包屑；顶部只有宿主会话名；跨会话提示条给出所属会话名与跳转 — `source` / `browser`
- [A7] 批注栏默认收起，工具条「批注 N」展开；切 Chat 再切回仍按默认收起 — `source` / `browser`

## Risks

- DOM 点击依赖 tab strip 结构与文案，宿主升级可能破坏；用固定短文案 + 限定 selector + 重试上限 + 可见错误兜底，破坏时降级为 localStorage+openSession。
- `conversation.view` 名册全局：存在打开项时标签会出现在所有会话；非 owner 会话必须只读，不能把跨会话只读当成「只在 owner 会话显示」。宿主没有按会话隐藏 view 的公开能力。
- `localStorage` 只读偏好只在会话首次绑定/打开时生效，已打开会话不重读；跨会话路径以 openSession 触发重读为主，DOM 点击为回退。
- 刷新丢打开态（store 内存态），标签随之消失；可接受，若要持久打开态再另做，不属本决策。
- 隐藏 composer 依赖宿主 DOM hook `[data-conversation-scroll]` / `[data-composer-seat]`，不是公开 API；宿主改结构后 composer 会重新出现，浏览器 lane 的 computed-style 断言会把回归变成红灯。长期方案是向宿主申请按 view 隐藏 composer 的公开能力。
- 顶部会话 header 不能替换成文档所属会话名；跨会话信息只在查看器提示条。若用户要求「顶部始终显示所属会话」，需要宿主提供 header 插槽，另立决策。
- 触发重访条件：宿主公开了稳定 `selectView/openView` 服务，或 `conversation.view` / composer seat 的 DOM 结构被宿主重命名导致点击或隐藏长期失效，或宿主提供 header 插槽。

## Delivery stages

1. 注册/注销与 store 扩展 — 让「右栏 → 标签出现 → 关闭 → 标签消失」先闭环；删除查看器面包屑行。
2. 跨会话只读 + 「在所属会话打开」（localStorage + openSession + DOM 点击回退）；顶部会话身份按宿主现状收口。
3. 隐藏会话 composer + 内部滚动 + footer 贴底 + 批注栏默认收起 + 窄屏抽屉验收。
