# Cowork 批注提示词与折叠 UX 设计

Status: design proposal（2026-11-23）

本页设计「批注投递」的用户提示词形态：短消息 + system prompt 静态规则 + marker 折叠。它与[工作项前端设计](work-item-frontend.md)（批注、投递、渲染器）和[工作项后端设计](work-item-backend.md)（dispatcher、prompt、`cowork_artifact_reply`）交叉，但只拥有「投递到主题会话的那条消息如何组织、如何折叠、如何不破坏普通用户消息」这一件事。视觉尺寸/间距/颜色以[共享视觉验收基线](visual-acceptance.md)为准，本页只写增量项。决策与取舍见[决策记录](../../../.agents/notes/proposed/feature/2026-11-23-annotation-prompt-ux.md)。

宿主源码行号与机制按本地 checkout `~/Workspace/deepseek-harness`（`dsh-v0.2.2-rc.2`）记录；本机运行宿主是 `0.2.1-rc.2`，实现期以运行宿主为准（与 [work-item-backend.md](work-item-backend.md) §宿主调研 同口径）。

## 1. 背景、目标、非目标

### 背景

- 批注创建后由 [artifact-dispatch.ts](../../../src/platform/artifact-dispatch.ts) 合并进一条 prompt，经 `sessionController.prompt({ mode: 'queue' })` 投递到工作项所属主题会话。当前 `buildDispatchPrompt` 把「静态规则 + 逐条批注块」拼成一大段纯文本，作为普通 user message 显示在会话里。
- 宿主对 `user/message` 事件的 `source.kind` 判定在宿主 `packages/client/ui-chat/src/client/conversation-nodes/message.ts`（`source.kind !== 'user'` 才走 context 节点）；`sessionController.prompt` 产出的消息 `source.kind` 恒为 `user`，因此宿主不会把这条投递折叠成 `SystemPromptRow`/`ContextInjectionRow`，它被当作普通用户气泡完整展示——整段规则和上下文会占满会话。
- 参考会话 `session-86e070f3` 的折叠（用户需求附件第 116 行所引）是宿主的 `SystemPromptRow`（会话日志里 25 条 `kind:"system-prompt"`）和 `ContextInjectionRow`（`skill-catalog`/`time-context`/`agent-instructions` 等非 user 上下文节点），不是插件 renderer；普通 user message 不折叠。

### 目标

- 投递消息默认只显示一行摘要；展开才看到完整结构化批注上下文。
- 静态批注规则移入 cowork-topic 的 system prompt section，用户消息只保留「结构化上下文 + marker」。
- 无 marker 的普通用户消息保持宿主默认表现，零回归。
- 模型侧仍收到完整信息（system prompt 规则 + 结构化上下文），p1/p2/p3 三处产出契约清楚。

### 非目标

- 不改变投递队列/合并/状态机（[artifact-dispatch.ts](../../../src/platform/artifact-dispatch.ts) 的状态机不动）。
- 不改变 `cowork_artifact_reply` / `cowork_artifact_comments` 的工具语义。
- 不做「模型回复消息」的折叠（那是 assistant 侧，本页只处理投递进来的 user 侧消息）。
- 不折叠普通用户消息、不折叠宿主已有的 system prompt / context injection 行。

## 2. 参考会话机制与当前 gap

- 宿主把非 `user` 来源的 `user/message` 投影成 `context` 节点（宿主 `packages/client/ui-chat/src/client/conversation-nodes/message.ts` 的 `start`），由宿主 `packages/client/ui-chat/src/client/chat/ContextInjectionRow.tsx` 用 `DisclosureRow` 折叠；`system-prompt` 节点由宿主 `packages/client/ui-chat/src/client/chat/SystemPromptRow.tsx` 折叠。折叠行有 icon + 标题 + chevron，展开体是「141px 代码块滚动区」的 `OpaqueBody`。
- gap：插件投递的批注 prompt 是 `source.kind === 'user'`，走宿主 `packages/client/ui-chat/src/client/chat/MessageItem.tsx` 的 `UserMessageNodeView`，渲染成右侧普通气泡，不折叠、且把静态规则和批注上下文整段裸露。`sessionController.prompt` 不暴露 `source`，无法把 `source.kind` 改成非 `user` 来借用宿主原生折叠。

结论：折叠必须由插件自己的 `conversation.chat.node` key=`user` renderer 完成（见 §5），靠 marker 识别插件消息、靠「无 marker 走宿主等价渲染」保住普通消息。

## 3. 完整数据流（短消息 + system prompt + marker 折叠）

```text
用户在工作项上新建批注
  └─ POST /api/cowork.artifact.comment （work item、file、revision、commentId、
       line range、quote、selectedText、body、attachment refs）
       └─ dispatcher.enqueue 合并（1.5s 窗口、最多 10 条）          [不变]
            └─ buildDispatchPrompt 改写：
                 ├─ 静态规则 → 不进消息（在 system prompt section，§6.3）
                 └─ 消息文本 = MARKER + 一行摘要 + 结构化批注上下文（§4/§6）
            └─ sessionController.prompt({ mode:'queue', content:[{text: 消息}] })
                 └─ 宿主记为 user/message，source.kind='user'（普通 user 节点）
                      ├─ 模型看到：system prompt(人格+记忆+批注规则) + 消息文本
                      └─ 聊天视图：conversation.chat.node key='user' → 插件 renderer
                           ├─ 文本以 MARKER 开头 → 折叠 disclosure（摘要行 + 展开体）
                           └─ 无 MARKER → 宿主等价普通气泡（§5.3 零回归）
模型回复（受 system prompt 规则约束，§7）：
  p1 会话内一句话摘要（软） → p2 cowork_artifact_reply 详细回复（硬） → p3 文档内直接修改（半强制）
```

- 消息文本总长度仍受现有 `slice(0, 20_000)` 上限约束；摘要一行有独立上限（§6.2）。
- marker 只用于前端折叠判定，模型也会看到这行（PUA 包裹的可见性极低，且不含敏感信息）；不把 marker 展示给用户由 renderer 剥离保证（§4.5）。

## 4. marker 设计

### 4.1 唯一前缀与版本

常量（dispatcher 与 renderer 共享，两侧各一处声明）：

```ts
/** 批注投递消息的首行 sentinel；PUA 包裹 + 版本号，避免与正常文本碰撞。 */
export const ANNOTATION_MARKER = '\uE000cowork-annotation/v1\uE001'
```

- 组成：`U+E000`（私有区，键盘不可输入）+ ASCII 核心 `cowork-annotation/v1`（含版本号）+ `U+E001`。版本号让未来格式演进可向后兼容（renderer 按 `startsWith` 前缀识别，未来可 `v2` 并保留 `v1` 解析）。
- marker 独占消息首行（后面跟 `\n`），便于 `startsWith` 判定和按行剥离；不内联进摘要行，避免剥离后残留。

### 4.2 消息线格式

```text
<MARKER>
<summary>                       # 一行摘要，≤ 140 字符
                                # 空行
<structured-context>            # §6 的结构化批注上下文（bounded）
```

- renderer 解析只做前缀判定 + 按行切分：`startsWith(MARKER + '\n')` → 第二行是摘要，第四行起是展开体。
- 若第二行缺失/为空，展开体与摘要都回退到通用文案「批注投递」，不抛错。

### 4.3 转义与健壮性

- marker 是前缀判定，正文里出现同样的 PUA 串不影响（只查首行）。
- PUA 字符是 BMP 私有区，UTF-8/UTF-16 往返和 `.trim()`/空白折叠都不会剥掉；dispatcher 现有「去控制字符」的清洗必须把 `U+E000/U+E001` 加入白名单，不得当作控制字符删除。
- 摘要与上下文字段仍沿用现有 bounded/去控制字符/不拼接未转义 HTML 规则（[work-item-backend.md](work-item-backend.md) §投递）。

### 4.4 不可伪造

- 诚实的边界：marker 是前端**识别**而非**鉴权**；`sessionController.prompt` 没有签名通道（`source.kind` 固定为 `user`），客户端无法拿到不可伪造证明。
- 防误判靠两点：PUA 字符无法从 composer 键入、也几乎不会出现在粘贴文本；ASCII 核心带版本号，正常对话不会以 `cowork-annotation/v1` 开头。
- 用户若故意粘贴完全相同的首行，最坏后果是**把自己这条消息折叠成摘要行**（摘要/正文原样按用户所写展示），无越权、无数据外泄、不影响其他会话。这是可接受的自伤，不构成安全边界。

### 4.5 不显示给用户 / 兜底 / 历史分页

- renderer 剥离 marker 首行后才渲染；折叠态与展开态都不出现 PUA 行。
- **普通消息兜底**：任何不以 `MARKER` 开头的消息走宿主等价渲染（§5.3），PUA 串对它们完全无影响。
- **解析失败兜底**：marker 识别失败（如未来版本不兼容、文本被宿主规范化）时，整条消息按普通气泡原样展示（marker 首行可能显示为占位符/空白），不抛错、不破坏消息。
- **刷新/历史/分页**：marker 随消息文本持久化，刷新/重开/翻历史重渲染都只做一次 `startsWith` 前缀判定，确定、无跨消息状态；旧会话里无 marker 的消息自动走宿主默认，无迁移。

## 5. 自定义 user renderer 挂点选择

### 5.1 候选

| 挂点 | 能力 | 结论 |
|---|---|---|
| `conversation.chat.node` key=`user` 替换 | 整条 user 节点替换，可折叠整行 | **采用**（全局，必须 marker 兜底） |
| `conversation.user.text` 工厂 / `conversation.user.text.node` 规则 | 只对文本**区间**做装饰（宿主 `packages/client/ui-conversation/src/client/contract/user-text.ts`），不能隐藏气泡、不能折叠整行 | 不采用 |
| `conversation.chat.user.before` chain（message-source seat） | 只装饰气泡上方，不能折叠气泡内容 | 不采用 |
| 改 `source.kind` 借用宿主 context 折叠 | `sessionController.prompt` 不暴露 source，`source.kind` 恒为 `user` | 不可达 |

- 宿主对 `conversation.chat.node` key=`user` 的注册是 `UserMessageNodeView`（宿主 `packages/client/ui-chat/src/client/chat/register-node-renderers.ts`）。「复用同一 key 替换该节点 renderer」（宿主 `packages/client/ui-chat/src/client/contract/slots.ts` 对 `conversation.chat.node` 的注释）。插件用 `ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name:'conversation.chat.node', key:'user' }, CwUserNode))` 注册自己的 renderer。
- 插件 renderer 只接管 key=`user`，不动 key=`steering`（steering 行不可能是批注投递，保持宿主 `UserMessageNodeView` 原样）。

### 5.2 renderer 组件职责

```text
CwUserNode(props)
  ├─ text = 由 node.data.content 提取的文本
  ├─ parseAnnotation(text) === null ? 普通消息路径（§5.3）
  │                                    : 折叠路径（§8 折叠 disclosure）
  └─ 两者共用同一行外壳
```

- 组件类型在仓库内本地 restate（沿用 [contracts.ts](../../../src/client/contracts.ts) 的做法：`@deepseek-ai/dsh-client-*` 类型不可作为仓库依赖，运行时作为 esbuild externals 从宿主解析）。
- 运行时从 `@deepseek-ai/dsh-client-ui-primitives` 引入 `DisclosureRow`（折叠 chrome，宿主同款）、`UserMessageBubble`（普通气泡）、`JsonBlock`（未知块兜底）等；这些都是 primitives 公共导出，宿主 `packages/client/ui-chat/src/client/chat/UserContent.tsx` 与 `SystemPromptRow.tsx` 均已用，宿主已提供。

### 5.3 普通用户消息零回归方案

普通消息路径必须复现宿主 `UserStyleBubble`（宿主 `packages/client/ui-chat/src/client/chat/MessageItem.tsx`）的**组成**，尽量只做薄壳、把内容委托给宿主的公共工厂：

1. **气泡内容全量委托**：调用 `renderFactorySlot('conversation.chat.user.content', prepared)`。该工厂由宿主注册（宿主 `packages/client/ui-chat/src/client/apply.ts` 的 `conversation.chat.user.content` → `UserContent`），内部再走 `conversation.user.text` 工厂 + `UserMessageBubble`，文本/附件/引用/未知块的渲染与宿主逐字节一致，插件不重写内容层。
2. **message-source seat**：把 `conversation.chat.user.before` 声明为本节点的 `children` chain，并用 `renderSlotChain('conversation.chat.user.before', { source, kind })` 渲染，保持消息来源装饰。
3. **外壳**：右侧对齐容器（`display:flex; flex-direction:column; align-items:flex-end`），与宿主 `.userRow` 等价。
4. **时间与操作行（残余缺口）**：宿主的 `MessageIconActions`（时间戳 + 复制/重试等悬浮操作）在 ui-chat 内部、未从 primitives 导出，插件无法复用。本版方案是**自实现一个最小等价行**（时间 + 复制），并把它列入 §11 的回归测试和 §13 的残余风险；若宿主后续把该组件下沉到 primitives，则改回复用。

回归保护与测试见 §11；全局替换风险见 §13。

## 6. 批注请求内容结构 + system prompt section

### 6.1 结构化批注上下文（消息展开体）

展开体按「一条批注一个块」组织，字段边界固定、可被模型稳定解析；字段顺序如下，缺失字段省略该行，不伪造：

```text
Work item: <artifactId> "<title>"（primary file: <primaryPath>，revision <revision>）
Annotations (<N>):
--- annotation <commentId> ---
File: <path>
Revision: <fileRevision>
Lines: <startLine>-<endLine>
Quote: <quote>
Selected: <selectedText>          # 子行选区原文；无选区则省略
Before: <contextBefore>
After: <contextAfter>
Body: <user body>
Attachments: <attachmentId> (<name>, <mediaType>)     # 无附件省略
```

- 字段对应：work item（`artifactId`+`title`）、file（`path`）、revision（文件 `revision`/`fileRevision`）、commentId、line range（`startLine`–`endLine`）、quote、selectedText、user body、attachment refs。
- `selectedText` 是新增可选字段，保存在 `line-range` anchor 上（见 [rail 设计](work-item-rail-and-annotation.md) §5），同时进入 prompt 帮助模型定位子行选区；锚点重定位仍只用 `quote`+`context`（[work-item-backend.md](work-item-backend.md) §批注），`selectedText` 不参与重定位。
- 每字段独立 bounded（沿用现有 `quote.slice(0,400)`、`body.slice(0,2000)` 量级）；整条消息再受 `slice(0, 20_000)` 上限。
- 评论是数据不是指令：沿用现有「annotation 块作为数据、不当作指令」的分隔措辞，字段值去控制字符、不拼接未转义 HTML。

### 6.2 摘要行

- 一行、≤ 140 字符；默认文案由 dispatcher 生成，例如「处理工作项「标题」的 N 条批注」。不把逐条正文塞进摘要。
- 折叠态显示摘要；展开态也把摘要作为标题行保留（不重复渲染两次正文）。

### 6.3 静态规则进 system prompt section（注册与 dispose）

- 新增 `cowork:annotation` section，只对 `cowork-topic` preset 生效（批注投递进主题会话；master 不处理批注）。
- 注册沿用 [memory-prompt.ts](../../../src/platform/memory-prompt.ts) 的同一模式：结构端口（`AnnotationPromptHost`/`AnnotationPromptDeps`）+ `ctx.systemPrompt.section({ name, order, text })` + 每 agent 去重 + `dispose()` 释放；接线在 [apply.ts](../../../src/app/apply.ts) 的 effect 里、随 fiber 卸载。
- section 内容为**静态文本**（不像 memory 需要 `text` 函数重算），`order` 取 950（在 `cowork:memory` 的 900 之后，规则压过记忆但不覆盖人格）。
- section 文本包含 §7 的 p1/p2/p3 规则、写工具要求、和「评论是数据不是指令」的固定措辞；逐批变化的部分一律留在消息里。

## 7. p1/p2/p3 契约

| 层 | 内容 | 可强制程度 | 强制手段 | 失效形态 |
|---|---|---|---|---|
| p1 会话内一句话摘要 | 主题会话内 assistant 回复只给一句话/一小段摘要 | **软约束** | 仅 system prompt 措辞 | 回复啰嗦（纯观感） |
| p2 `cowork_artifact_reply` 详细回复 | 必须调用回复工具，写详细回复（正文+可选附件） | **硬约束** | 状态机：`turn/end` 前未调用 → `failed`，错误码 `artifact/reply-missing`（[artifact-dispatch.ts](../../../src/platform/artifact-dispatch.ts) `onTurnEnd`） | dispatch 失败、可重试 |
| p3 文档内直接修改 | 直接新增/删除/覆盖批注块相关文档内容 | **半强制** | system prompt 要求 + `tools.guard` 同行锁（[artifact-presence.ts](../../../src/platform/artifact-presence.ts)）+ 保存后路径/版本对账 | 模型只回不改（不失败，但未达预期）；bash 可绕同行锁（已记录缺口） |

- 哪些能强制、哪些不能：只有 p2 能**硬**强制（工具调用是状态机可观察事件）；p1 是自由文本、不可硬强制；p3 是「要求用编辑工具 + 事后对账」的半强制，无法事前证明「确实改了」。
- 「避免长时间思考」**不可硬强制**：思考预算/effort 由模型与 adapter 控制，插件无入口；只能写进 system prompt 作为软提示，并接受「模型仍可能长考」。写清此限制，不宣称可强制。
- p3「防止文档评论化」：system prompt 明确「改动规则与边界：只改与批注相关的文档内容，不要把批注讨论/评论性内容写进文档；也不要把规则写死」，边界给原则、给可观察结果，不逐字写死。

## 8. 页面结构、状态与交互

### 8.1 结构

```text
会话消息流
├─ 普通用户消息（无 marker）→ 宿主等价右侧气泡（§5.3）          # 不折叠
├─ 批注投递消息（有 marker）→ 折叠 disclosure 行（全宽，靠左，同宿主 context 行）
│    ├─ 折叠态：[icon 14px] 批注投递 · <summary>  [chevron]
│    └─ 展开态：标题行 + <pre> 结构化上下文，最大高度滚动区
└─ 宿主 system prompt / context injection 行（不归插件，保持原样）
```

- 折叠行与宿主 `ContextInjectionRow` 同型：`DisclosureRow` + `expandOnRowClick`，全宽靠左，与右侧用户气泡明确区分。
- 展开体用 `pre` 保留真实换行（与 `OpaqueBody` 同思路），最大高度 + 内部滚动，**展开后内容不被截断**（截断仅指滚动区内可滚动到全部内容，不是 `overflow:hidden` 丢失）。

### 8.2 状态

| 状态 | 表现 |
|---|---|
| 折叠（默认） | 一行摘要 + chevron；`aria-expanded=false` |
| 展开 | 摘要标题 + 滚动体；`aria-expanded=true` |
| 普通用户消息 | 宿主等价气泡，无折叠 chrome |
| 系统提示/上下文注入 | 宿主 `SystemPromptRow`/`ContextInjectionRow`，插件不介入 |
| 加载/历史/刷新 | marker 随文本持久化，重渲染判定确定；无异步加载态，翻历史只做前缀判定 |
| 解析失败 | 原样普通气泡，不折叠、不破坏 |

### 8.3 交互

- 点击折叠行任意处切换（`expandOnRowClick`）；chevron 旋转指示。
- 键盘：折叠行是可聚焦按钮（`button`），Enter/Space 切换；Esc 折叠并把焦点还给触发行。
- 屏幕阅读器：见 §9。
- 默认折叠；同一批投递的多条消息各自独立折叠状态，互不影响。

## 9. 可访问性

- 折叠行为 `<button>`（`DisclosureRow` 自带），带 `aria-expanded`，`aria-controls` 指向展开体容器 id（id 用 `node.messageId` 派生，会话内唯一）。
- 焦点：Tab 进折叠行，Enter/Space 切换；展开后焦点留在折叠行，Tab 进滚动体；Esc 折叠并回到折叠行。
- 展开体 `role="region"` + `aria-label="批注上下文"`（或复用标题文案），滚动区可键盘滚动（原生 `overflow:auto`）。
- 对比度：摘要/正文用 `--cwi-*`/`--dsw-alias-*` token，达到 WCAG AA（正文 ≥4.5:1）；颜色不是唯一状态，chevron + `aria-expanded` 双通道。
- `prefers-reduced-motion: reduce`：关闭 chevron 旋转/高度过渡，只瞬时切换。
- marker 的 PUA 字符只存在于剥离前的文本，剥离后不进入 DOM，不进无障碍树。

## 10. 视觉保真与像素验收（增量）

引用[共享视觉验收基线](visual-acceptance.md) §1/§2/§7/§8/§9。本页增量：

- 折叠行高：32px；左右 padding 8px；icon 14px（`IconBrowseOutlineRegular`，与宿主 `ContextInjectionRow` 同源）；标题 12px/500；摘要 11.5px `--cwi-muted` 单行省略（最大宽 300px）；chevron 居中 12px。
- 展开体：`max-height` 360px；`overflow:auto`；`pre` 等宽、行高 1.6、`white-space: pre-wrap`；底色 `--cwi-surface-muted`；内边距 8px 10px。
- 与普通用户气泡的差异：折叠行**全宽靠左**（不是右侧气泡）、无气泡底、无时间/操作行；这是「这是一条被折叠的投递上下文」的视觉信号。
- 普通用户气泡：右侧对齐、气泡底、时间行（§5.3 自实现等价行）。
- 四档宽度 1280/1024/768/390，关键盒容差 ±2px；窄屏（<640）折叠行摘要缩短、展开体 `max-height` 降到 `min(50vh, 360px)`；不得出现横向滚动、不遮挡 composer。
- 亮/暗各一套；截图必须实际生成并人工/图像复核（§12）。

## 11. 测试与验收

每条写清「若破坏它，哪个检查变红」。

| 检查 | 断言 | 变红面 |
|---|---|---|
| marker 兜底 | `parseAnnotationText` 对无 marker 文本返回 null；对 marker 文本解析出摘要/正文；空摘要回退 | `npm test`（`tests/` node:test 纯函数） |
| 普通消息回归 | 无 marker 的 user 消息渲染出的 DOM 与宿主 `UserMessageNodeView` 等价（快照/结构 diff：气泡、文本、时间行、来源装饰） | `npm run test:browser`（真实宿主 + Chromium lane） |
| 刷新保持 | 含 marker 的消息刷新/翻历史后仍折叠，状态确定 | `npm run test:browser` |
| 展开/折叠 | 默认折叠；点击/Enter/Space 展开；再点折叠 | `npm run test:browser` |
| 键盘/ARIA | `aria-expanded`/`aria-controls` 正确；Esc 折叠回焦 | `npm run test:browser` |
| 屏幕阅读器 | 折叠行可聚焦按钮有可读名；展开体 `region` 可命名 | `npm run test:browser`（可读名断言） |
| 历史分页 | 翻页重渲染只做 `startsWith`，无跨消息状态、无额外网络 | `npm test` + `npm run test:browser` |
| 系统提示折叠不受影响 | 宿主 `SystemPromptRow`/`ContextInjectionRow` 仍折叠 | `npm run test:browser`（回归快照） |

- 实现阶段另按 [tools/workflow.json](../../../tools/workflow.json) 的 source/browser surface 跑 `npm run test:coverage`、`typecheck`、`build`、`test:host-smoke`、`test:coverage:layered`；纯函数（`parseAnnotationText`/`buildDispatchPrompt` 改造）要进 `tools/coverage-map.json` 100% 行覆盖。
- 公开面：无新路由/新工具；system prompt section 常量放进 `src/platform/annotation-prompt.ts`（与 memory-prompt 并列），守 50 KiB 读上限。

## 12. Demo 计划与资产

- 交互稿：[prompt-collapse-demo.html](assets/prompt-collapse-demo.html)，覆盖至少 4 个状态：折叠批注行、展开批注行、普通用户消息（无 marker）、宿主 system prompt 折叠/展开、窄屏（390）。
- 截图：[prompt-collapse-demo.png](assets/prompt-collapse-demo.png)，Chromium headless 实际生成，`deviceScaleFactor=2`，2560×1800；已做可解码/尺寸/窄屏无横向滚动的程序化核对；队长已用 read_image 目检缩略图并通过，像素级 ±2px 需实现期截图比对。
- demo 只演示聊天消息流的折叠关系与视觉规格，不承载真实交互逻辑；真实交互在浏览器 lane 验证（§11）。

## 13. 风险、未核实项、回滚/降级

### 风险

- **全局 renderer 替换**：插件接管 key=`user` 后，普通用户消息的视觉完全取决于 §5.3 的薄壳复现；`MessageIconActions`（时间/操作行）是已确认的残余缺口，宿主下沉该组件前需自实现等价行。若宿主升级改变 `UserMessageBubble`/`UserContent`/`DisclosureRow` 的 props，薄壳会漂移。缓解：浏览器 lane 做宿主等价 diff 测试（§11）。
- **替换优先级/顺序**：插件与宿主各自注册 key=`user`，「复用即替换」依赖加载顺序；若宿主晚于插件重注册，替换方向反转。需在真实宿主 E2E 确认（未核实）。
- **PUA 字符存活**：marker 依赖 `U+E000/U+E001` 不被 dispatcher 清洗、不被宿主文本管线规范化；需真实投递 E2E 确认首行原样到达 renderer（未核实）。

### 未核实项

- 真实宿主 `conversation.chat.node` key=`user` 替换的生效顺序与 `DisclosureRow`/`UserMessageBubble` 在当前运行宿主（DSH 0.2.1-rc.2）的 primitives 版本是否具备。
- `sessionController.prompt` 消息文本是否被 adapter/宿主 trim 或折叠首行。
- 浏览器 lane 对「普通消息 DOM 与宿主等价」的 diff 可行性（取决于宿主快照工具）。

### 回滚/降级

- **关闭 renderer**：不注册 key=`user`（feature flag off）→ 所有 user 消息回宿主默认；marker 消息退化为普通气泡（PUA 首行显示为占位符/空白，摘要与上下文仍可读），不破坏消息。
- **marker 解析失败**：`parseAnnotationText` 返回 null → 走 §5.3 普通气泡，原样显示，不抛错。
- **system prompt section 注册失败**：沿用 memory-prompt 的 per-agent 容错，失败只计日志、不阻断插件加载；最坏后果是模型少了静态规则（p2 硬约束仍由状态机兜底）。

## 14. 相关文档

- [共享视觉验收基线](visual-acceptance.md)、[工作项前端设计](work-item-frontend.md)、[工作项后端设计](work-item-backend.md)
- [决策记录](../../../.agents/notes/proposed/feature/2026-11-23-annotation-prompt-ux.md)
