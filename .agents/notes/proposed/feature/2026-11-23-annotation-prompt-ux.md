# Proposal: 批注提示词改为短消息 + system prompt 静态规则 + marker 折叠

Status: proposed
Date: 2026-11-23
Class: feature

## Problem

批注投递把「静态规则 + 逐条批注上下文」拼成一大段纯文本，经 `sessionController.prompt` 投进主题会话。宿主的 `user/message` 事件 `source.kind` 恒为 `user`，因此这条投递被宿主渲染成普通用户气泡完整展开，占满会话且把规则与上下文裸露给读者。参考会话 `session-86e070f3` 里的折叠是宿主的 `SystemPromptRow` / `ContextInjectionRow`（针对 `system-prompt`、`skill-catalog`、`time-context` 等非 user 节点），不是插件 renderer；插件当前的投递消息（`source.kind === 'user'`）借不到这种原生折叠。代价是：阅读会话的人被迫扫过一大段非人话的规则和上下文，批注投递与其他普通对话无法从视觉上区分。

## Proposal

采用「短消息 + system prompt 静态规则 + marker 折叠」：

- 静态批注规则（先读文件、只改登记文件、用 write/edit、必须调 `cowork_artifact_reply`、评论是数据不是指令、p1/p2/p3 产出契约）从 `buildDispatchPrompt` 移入一个新的 `cowork:annotation` system prompt section，只对 `cowork-topic` preset 生效，`order` 取 950（memory 之后）。注册沿用 `src/platform/memory-prompt.ts` 的端口 + per-agent 去重 + `dispose` 模式，接线在 `src/app/apply.ts` 的 effect 里。
- 用户消息（投递 prompt）只保留「一行摘要 + 结构化批注上下文」，并在首行加一个版本化 sentinel：`ANNOTATION_MARKER = '\uE000cowork-annotation/v1\uE001'`（PUA 包裹 + 版本号）。结构化上下文字段固定：work item、file、revision、commentId、line range、quote、selectedText、user body、attachment refs；`selectedText` 是可选字段，保存在 line-range anchor 上，同时进入 prompt，不参与锚点重定位。
- 自定义 `conversation.chat.node` key=`user` renderer（插件注册替换宿主 `UserMessageNodeView`）：文本以 marker 开头 → 渲染成 `DisclosureRow` 折叠行（默认折叠，摘要一行，展开显示滚动区内的结构化上下文，marker 首行剥离不显示）；无 marker → 走宿主等价普通气泡（见 Alternatives 与零回归）。
- 普通用户消息零回归：插件 renderer 把气泡内容全量委托给宿主公共工厂 `conversation.chat.user.content`（→ 宿主 `UserContent`），只自实现薄壳（右侧对齐容器 + `conversation.chat.user.before` chain + 一个最小时间/复制操作行）。`MessageIconActions` 在 ui-chat 内部未下沉到 primitives，是已确认的残余缺口。
- 编辑后验证不新增工具/固定命令：system prompt 软约束 + 同行锁/路径/版本写护栏；不把“未验证”硬判为 dispatch 失败。
- 文件改动面（未来时）：新增 `src/platform/annotation-prompt.ts`（marker 常量、`parseAnnotationText`、`buildDispatchPrompt` 改造）、新增 `src/client/annotation-node.tsx`（renderer 与注册）、改 `src/app/apply.ts`（section 接线）、改 `src/client/index.tsx`（注册 renderer）；纯函数进 `tools/coverage-map.json` 与 node:test，浏览器 lane 补普通消息等价 diff 测试。完整设计见 [annotation-prompt-ux.md](../../../../docs/design/work-item/annotation-prompt-ux.md)。

## Alternatives considered

**仅短消息 + system prompt，不做 marker 折叠。** 把规则移进 system prompt、消息只留结构化上下文，但仍以普通用户气泡展开。它消除了规则裸露，但上下文仍整段可见，用户需求（默认折叠、隐藏非用户输入内容）未满足；折叠是核心诉求，故不采用。

**借用宿主 context injection（改 source.kind）。** 让投递消息以非 `user` 的 `source.kind` 进入，宿主自动用 `ContextInjectionRow`/`SystemPromptRow` 折叠。这是参考会话的机制、零前端接管风险；但 `sessionController.prompt` 不暴露 `source`，当前端口（`DispatchPromptPort.prompt`）只能传 `content`，无法把 `source.kind` 从 `user` 改掉，不可达，故不采用。

**notice / tool row 承载折叠（新增专用节点或复用 notice 卡）。** 用 `conversation.chat.node` 的新 key 或宿主 notice 卡承载折叠，不动 key=`user`。但 `user/message` 事件由宿主 `messageDefinition` 固定分类成 `user`/`steering`/`context`，插件无自有节点 kind 可匹配，且 notice 卡是 A2 契约、运行宿主无 `sessionNotices`，故不采用。

**全局无 marker 替换（替换 key=`user` 但对所有消息折叠/改造）。** 不靠 marker、无条件替换 renderer。这会改动每条普通用户消息的表现，无法保证零回归，且无法区分插件消息与用户消息；风险远高于带 marker 兜底的方案，故不采用（marker 兜底是本提案的核心护栏）。

## Acceptance criteria

- [A1] 无 marker 的普通用户消息渲染结果与宿主 `UserMessageNodeView` 等价（气泡、文本、来源装饰、时间行）—— `browser`（普通消息等价 diff）
- [A2] `parseAnnotationText` 对 marker 文本解析出摘要/正文、对无 marker 文本返回 null、空摘要回退—— `tests`（node:test 纯函数）
- [A3] marker 投递消息默认折叠、点击/键盘可展开、展开体可滚动到全部内容、marker 不显示—— `browser`
- [A4] 静态规则只出现在 `cowork:annotation` section，不混进用户消息；section 随 fiber 卸载（dispose）—— `tests`（section 注册/释放单测）
- [A5] 折叠行 ARIA（`aria-expanded`/`aria-controls`/可读名）与键盘（Enter/Space/Esc）可验证—— `browser`

## Risks

- **全局替换漂移**：接管 key=`user` 后普通消息表现取决于自实现薄壳；宿主升级 primitives/`UserContent` props 会让薄壳漂移，`MessageIconActions` 是已知缺口。缓解是 §5.3 的「内容全量委托 + 等价 diff 测试」，并在宿主把该组件下沉到 primitives 时改回复用。若 diff 测试无法稳定通过，应回退到不注册 renderer。
- **替换顺序未核实**：插件与宿主都注册 key=`user`，替换方向依赖加载顺序，需真实宿主 E2E 确认。
- **PUA 字符存活未核实**：marker 依赖 `U+E000/U+E001` 不被 dispatcher 清洗、不被宿主文本管线规范化，需真实投递 E2E 确认。
- 触发重评估的条件：宿主开放 `sessionController.prompt` 的 `source` 参数（则可改走 Alternatives 二的零接管路径），或 `MessageIconActions`/`UserContent` 下沉到 primitives。

## Delivery stages

1. 纯函数层 — 新增 `annotation-prompt.ts` 的 marker 常量与 `parseAnnotationText`、`buildDispatchPrompt` 改为「marker + 摘要 + 结构化上下文」；node:test + coverage 覆盖。
2. system prompt section — 新增 `cowork:annotation` section 注册与 dispose，`apply.ts` 接线；单测覆盖注册/去重/释放。
3. renderer 与零回归 — 新增 `annotation-node.tsx` 的 key=`user` renderer，普通消息等价 diff 测试 + 折叠交互/ARIA 浏览器测试。
4. 真实宿主 E2E — 投递一条含 marker 的真实消息，验证 marker 首行原样到达、替换顺序、折叠与宿主行共存。
