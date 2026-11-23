# Proposal: 用宿主 conversation.view 承载工作项主区，替代 layout.selectPanel 全屏替换

Status: proposed
Date: 2026-11-23
Class: architecture

## Problem

工作项查看器当前是 root `main` 的 keyed panel，打开时用 `layout.selectPanel('cowork-work-item')` 全屏替换会话区，返回时 `selectPanel(null)`（`src/client/index.tsx:36-39`、`src/client/work-item/list.tsx:207-216`、`src/client/work-item/panel.tsx:429-432`）。全屏替换把会话区和输入框整个盖掉，用户查看/编辑一份交付物时必须先「返回会话」才能继续讨论，也无法在右栏快速切换多份文档。用户明确要求（附件《工作项样式和功能优化》）：在会话框位置新增「Cowork / 工作项」标签页展示文档和批注，默认不显示，打开文档才显示，且切回会话继续讨论不受影响。

## Proposal

把查看器从 `main` keyed panel 改为宿主 session 作用域 `conversation.view` 槽位（与 dsh-context 的「上下文/编队」、宿主 trajectory 同一机制）：

- 单标签 `COWORK_VIEW_ID = 'cowork-work-item'`，`label = () => 'Cowork'`；`ctx.slots.register({ name:'conversation.view', id, order, label, inject:(sessionId)=>({sessionId}) }, WorkItemView)`，返回的 disposer 保存下来。
- 动态注册：订阅 `workItemOpenStore`；存在打开项才注册，关闭即 dispose（幂等）。view 名册是全局的，所以存在打开项时该标签会出现在所有会话；非 owner 会话自动降级为跨会话只读，关闭后整条注册移除。
- 打开：`workItemOpenStore.open({ artifactId, ownerSessionId })`，注册 view 后用 DOM 点击 `[data-conversation-tabs] button[role="tab"]` 切标签（宿主无公开 `selectView/openView`）；失败在右栏列表显示可见错误与重试，不只藏在查看器里。
- 跨会话：`inject:(sessionId)` 给查看器当前会话；`sessionId !== ownerSessionId` 时只读预览，显示 owner 会话名与「在所属会话打开」；artifact.* API 统一用 `ownerSessionId` 解析项目。 「在所属会话打开」写 `localStorage['dsh.conversation.<ownerSessionId>'].view` + `uiWorkspace.openSession(ownerSessionId)`，失败回退 DOM 点击，再失败保持只读并提示。
- 关闭：`workItemOpenStore.close()` → dispose 注册 → 宿主 `refreshViews`→`resolveActiveView` 回退 Chat；本插件标签消失。tab strip 是否整体消失取决于宿主其余 view（dsh-context 的 context/fleet 常驻时保留）。
- 查看器根声明 `data-conversation-composer-overlay`，自持内部滚动，预留 `--dsh-composer-height` clearance。
- 客户端契约增量：`store.ts` 的 `WorkItemOpenContext` 增加 `ownerSessionId`；`contracts.ts` 的 `SlotRegisterOptions` 增加 `label`/`inject`，`SessionsService` 增加 `list`。后端路由零变化。

设计全文见 [work-item-main-view-tab.md](../../../../docs/design/work-item/work-item-main-view-tab.md)。

## Alternatives considered

**custom root main tab shell（自建主区标签壳）。** 保留 `main` panel，但在 panel 内部自画一套「会话 / 工作项」标签和双视图切换。放弃原因：会话区是宿主的，自建壳要么复制会话渲染（拿不到宿主会话组件），要么只能包住查看器这一侧、无法真正并排「会话 + 工作项」，等于换壳不换实质，还多维护一套 tab 语义。

**扩展 host selectView API（给 `ctx.uiConversation` 加公开切 view 服务）。** 最干净，但需改宿主源码/新增宿主能力，违背本仓库「不修改宿主源码」与「Local only / 不新增宿主包」的约束；且升级宿主要回归，收益与耦合不成比例。放弃，改为 DOM 点击 + 可观察失败降级。

**常驻 view 标签（启动即注册，不动态装卸）。** 实现最简单，但违背用户「默认不显示，打开文档才显示」的明确要求，还让所有会话常驻一个空标签、污染 tab strip。放弃。

**当前全屏 selectPanel 方案（维持现状）。** 无需改动，但直接违反用户需求：盖住会话、无法并排、切换文档要反复进出全屏。作为回滚点保留，但不作为前进方案。

## Acceptance criteria

- [A1] 只有存在打开的工作项时 `conversation.view` 注册，关闭即注销；本插件标签出现/消失与 store 状态一致，宿主其余 view 不受影响 — `tests`
- [A2] 打开跨会话工作项不切换会话、只读禁用编辑/批注；artifact API 仍用 ownerSessionId 读到同一工作项；「在所属会话打开」才切换 — `source`
- [A3] DOM 点击限定 `[data-conversation-tabs] button[role="tab"]`、校验 `aria-selected`、超时/重试上限、失败在右栏显示可见错误 — `source`
- [A4] 查看器根声明 `data-conversation-composer-overlay` 且 footer/正文不被浮动 composer 遮挡 — `source`
- [A5] 与宿主既有 view（chat/trajectory/context/fleet）并存不顶替，真实宿主回归通过 — `browser`

## Risks

- DOM 点击依赖 tab strip 结构与文案，宿主升级可能破坏；用固定短文案 + 限定 selector + 重试上限 + 可见错误兜底，破坏时降级为 localStorage+openSession。
- `conversation.view` 名册全局：存在打开项时标签会出现在所有会话；非 owner 会话必须只读，不能把跨会话只读当成“只在 owner 会话显示”。宿主没有按会话隐藏 view 的公开能力。
- `localStorage` 只读偏好只在会话首次绑定/打开时生效，已打开会话不重读；跨会话路径以 openSession 触发重读为主，DOM 点击为回退。
- 刷新丢打开态（store 内存态），标签随之消失；可接受，若要持久打开态再另做，不属本决策。
- 触发重访条件：宿主公开了稳定 `selectView/openView` 服务，或 `conversation.view` 的 tab 文案/结构被宿主重命名导致 DOM 点击长期失效。

## Delivery stages

1. 注册/注销与 store 扩展 — 让「右栏 → 标签出现 → 关闭 → 标签消失」先闭环。
2. 跨会话只读 + 「在所属会话打开」（localStorage + openSession + DOM 点击回退）。
3. composer overlay + 内部滚动 + clearance + 窄屏抽屉验收。
