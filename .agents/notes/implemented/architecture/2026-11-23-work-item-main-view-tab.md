# Decision: 用宿主 conversation.view 承载工作项，替代 main keyed panel

Status: implemented
Date: 2026-11-23
Class: architecture

## Problem

工作项查看器原先是 root `main` 的 keyed panel：打开时 `layout.selectPanel('cowork-work-item')` 全屏替换会话区，返回时 `selectPanel(null)`。全屏替换把会话区和输入框整个盖掉，用户查看/编辑一份交付物时必须先「返回会话」才能继续讨论，也无法在右栏快速切换多份文档。用户验收要求：在左侧会话框位置新增「Cowork / 工作项」标签页展示文档和批注；确认/编辑文档的同时能随时切回会话；默认不显示，只有打开文档时才显示；顶部显示文档对应的会话名，查看器内不重复小字面包屑；批注栏默认折叠；Cowork 标签下不显示浮动的会话输入框。

## Decision

把查看器从 `main` keyed panel 改为宿主 session 作用域 `conversation.view` 槽位（与 dsh-context 的「上下文/编队」、宿主 trajectory 同一机制）：

- 注册与注销：`src/client/index.tsx` 用 `ctx.slots.inject('conversation.view', …)` 绑定 `bindWorkItemView`（`src/client/work-item/view-registration.ts`）。单标签 `COWORK_VIEW_ID='cowork-work-item'`、`label: () => 'Cowork'`、`order: 20`、`inject: (sessionId) => ({ sessionId })`；订阅 `workItemOpenStore`，有打开项才注册，关闭即 dispose，绑定本身由插件 fiber 持有。
- 打开：右栏卡片写 `workItemOpenStore.open({ artifactId, ownerSessionId })`，再调用 `activateViewTab`（`src/client/work-item/view-tab.ts`）点击 `[data-conversation-tabs] button[role="tab"]` 中文本等于 `Cowork` 的按钮。匹配限定在 tab strip，结果以 `aria-selected` 校验；每 100 ms 轮询 10 步、最多点击 3 次，并给注册后的首帧留 2.5 s 渲染预算。失败是 typed error（`tab-missing` / `tab-not-selected`），右栏列表顶部以 `role=alert` 显示可读错误与「重试切换」。
- 打开上下文：`WorkItemOpenContext` 为 `{ artifactId, ownerSessionId }`。所有 `artifact.*` 调用固定用 `ownerSessionId` 解析项目与作用域；`inject` 给出的当前会话只用于判定跨会话与只读态。
- 跨会话只读：当前会话 ≠ owner 时，编辑、确认、回复、标记已解决、批注提交全部 `disabled` 并带可读原因；文档与批注历史仍可读。查看器第一行是 36 px 提示条（`role=status`），给出所属会话名（`detail.sessionTitle`）与「在所属会话打开」。
- 「在所属会话打开」（`src/client/work-item/session-open.ts` + `session-preference.ts`）：可选用 `uiWorkspace.unarchiveSession`，写 `dsh.conversation.<ownerSessionId>.view`（与已有 draft 记录合并，不覆盖），再 `uiWorkspace.openSession(ownerSessionId)`；以 `sessions.list` 的 `retainedBy.mainView` 轮询确认切换（≤1.5 s），成功后以同一 tab 点击兜底。任一步失败返回 typed reason，查看器保持只读并显示错误与「重试」，不静默、不假装成功。
- 顶部身份：查看器删除 `Crumbs` 行（`cwi-crumbs` 不再存在），顶部会话名由宿主 `conversation.session.header` 渲染；跨会话信息只在提示条。不注册 `conversation.session.header.lineage`（单槽，会 shadow 宿主 UI）。
- 会话 composer：`WORK_ITEM_CSS` 增加 `[data-conversation-scroll]:has(.cwi-viewer) > [data-composer-seat] { display: none }`；查看器根声明 `data-conversation-composer-overlay`，让宿主 `.viewArea` 变为自持滚动区。切到 Chat 时规则不匹配，composer 与草稿自动恢复；查看器不再预留 `--dsh-composer-height` clearance。
- 布局与层叠：`.cwi-viewer` 设 `isolation: isolate; width: 100%; height: 100%; overflow: hidden`，`.cwi-content` 与 `.cwi-rail` 各自滚动，footer 贴查看器底边。
- 批注栏：默认收起（`showRail=false`，正文满宽），工具条「批注 N」带 `aria-expanded` 展开。
- 关闭：`workItemOpenStore.close()` → dispose 注册 → 宿主 `refreshViews`/`resolveActiveView` 回退 Chat；不再依赖 `sessions.retainInfo(...).retainedBy.mainView` 自动关闭，也不再注入 `layout`。
- 契约增量：`contracts.ts` 增加 `COWORK_VIEW_ID`/`COWORK_VIEW_LABEL`、`SlotRegisterOptions.label|inject`、`SessionsService.list`（`ids` + `byId.retainedBy`），删除没有生产消费方的 `LayoutService`。后端路由零变化。

与提案的差异：提案把 `LayoutService` 保留为可选，实际改动后没有任何生产调用方，按死代码规则删除；提案未预见宿主对 blank 会话不渲染任何 view（无 tab strip、无 `.viewArea`），因此「从新建会话直接打开工作项」会得到 `tab-missing` 可见错误，浏览器 lane 与真实使用都需要先开始一轮对话。浏览器 lane 因此改用 scripted provider 先发一轮消息，并把 fixture 工作项的 owner 改成真实 primary 会话——`artifact.*` 现在按 owner 解析项目，合成 session id 会得到 `unknown session`。

## Alternatives considered

**custom root main tab shell（自建主区标签壳）。** 保留 `main` panel，但在 panel 内部自画一套「会话 / 工作项」标签和双视图切换。放弃原因：会话区是宿主的，自建壳要么复制会话渲染（拿不到宿主会话组件），要么只能包住查看器这一侧、无法真正并排「会话 + 工作项」，等于换壳不换实质，还多维护一套 tab 语义。

**扩展 host selectView API（给 `ctx.uiConversation` 加公开切 view 服务）。** 最干净，但需改宿主源码/新增宿主能力，违背本仓库「不修改宿主源码」与「Local only / 不新增宿主包」的约束；且升级宿主要回归，收益与耦合不成比例。放弃，改为 DOM 点击 + 可观察失败降级。

**常驻 view 标签（启动即注册，不动态装卸）。** 实现最简单，但违背用户「默认不显示，打开文档才显示」的明确要求，还让所有会话常驻一个空标签、污染 tab strip。放弃。

**当前全屏 selectPanel 方案（维持现状）。** 无需改动，但直接违反用户需求：盖住会话、无法并排、切换文档要反复进出全屏。作为回滚点保留，但不作为前进方案。

**保留浮动会话 composer（覆盖在查看器底部）。** 用户明确要求 Cowork 标签下不显示该输入框；保留它会让文档底部长期被 152px 覆盖层占用，也暗示「在这里发消息」但实际上下文是文档。放弃，改为切到 Chat 输入。

**注册 `conversation.composer` 条目来替换/移除宿主 composer。** 该槽是 additive：插件条目与 fallback 同时渲染，无法移除 fallback；`priority` 只影响顺序。放弃，改为样式表隐藏宿主 seat。

**注册 `conversation.session.header.lineage` 在顶部追加文档所属会话名。** 该槽是单槽，dsh-client-ui-subagent 已占用，注册会 shadow 宿主既有标题渲染（`replaceRisk: shadows-shipped-ui`）。放弃，跨会话信息放在查看器提示条。

## Consequences

- 右栏点卡片后工作项出现在会话区标签里，切到 Chat 不关闭工作项；关闭标签后本插件标签消失、composer 恢复。tab strip 是否整体消失取决于宿主其余 view（trajectory / context / fleet 常驻时保留）。
- `conversation.view` 的名册是全局的：存在打开项时，每个已开始对话的会话都会出现 Cowork 标签，非 owner 会话自动降级为跨会话只读。这是宿主 slot 的边界，不伪装成「只在 owner 会话显示」。
- 刷新丢打开态（store 是内存态），标签随之消失；不做持久恢复。
- blank 会话没有 view 区域：从全新会话打开工作项时列表显示 `tab-missing` 错误与重试，需要先发一条消息。
- 隐藏 composer 依赖宿主 DOM hook `[data-conversation-scroll]` / `[data-composer-seat]`，不是公开 API；宿主改结构后 composer 会重新出现，浏览器 lane 的 computed-style 断言会把回归变红。长期方案是向宿主申请按 view 隐藏 composer 的能力。
- 顶部不能替换成文档所属会话名；跨会话时顶部仍是当前会话。若宿主提供 header 插槽，再评估把所属会话名提升到顶部。
- 回滚：还原 `src/client/index.tsx` 的 `main` keyed panel 与 `list.tsx`/`panel.tsx` 的 `selectPanel` 路径，删除 view 注册、composer 隐藏规则与 store/contract 增量即可回到全屏查看器；后端与查看器内部零改动。

## Testing

- [A1] 只有存在打开项时注册 `conversation.view`，关闭即注销，标签随 store 出现/消失 — `tests`
- [A2] 右栏点击卡片后标签出现且 `aria-selected` 切到 Cowork；关闭后本插件标签消失并回退 Chat — `browser`
- [A3] 跨会话只读禁用编辑/确认/回复/批注提交，`artifact.*` 仍用 `ownerSessionId` 读到同一记录，「在所属会话打开」切换后恢复可编辑 — `browser`
- [A4] DOM 点击限定 tab strip、校验 `aria-selected`、超时与点击上限、失败在右栏可见并带重试 — `tests`
- [A5] Cowork 激活期 `[data-composer-seat]` 的 computed `display` 为 `none`，切回 Chat 后可见 — `browser`
- [A6] 查看器不渲染 `cwi-crumbs`；跨会话提示条给出所属会话名与跳转 — `browser`
- [A7] 批注栏默认收起，切 Chat 再切回仍按默认收起 — `browser`
- [A8] 「在所属会话打开」写入偏好、切换会话并校验；失败保持只读并显示错误 — `tests`
- [A9] 构建、类型检查与 host smoke 仍通过 — `packaging`
- [A10] 设计文档、前端承载面文档与本记录同步更新 — `decisions`
