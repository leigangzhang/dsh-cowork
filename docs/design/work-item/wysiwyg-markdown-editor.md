# Cowork 工作项：Markdown 阅读与批注设计

Status: implemented（2026-11-23；实现与验收见[决策记录](../../../.agents/notes/implemented/feature/2026-11-23-wysiwyg-markdown-editor.md)）

本文拥有 Markdown / PLAN 的**阅读面**：markdown-it 渲染的流式排版、块级 pin、选区批注入口、frontmatter 展示和阅读/源码切换的阅读侧。源码态沿用 [`editor.tsx`](../../../src/client/work-item/editor.tsx) 的 CodeMirror 6 编辑器与既有保存/冲突路径；页面外壳、批注栏、附件和共享视觉基线见[查看器设计](work-item-artifact-viewer.md)、[批注栏设计](work-item-rail-and-annotation.md)与[视觉验收基线](visual-acceptance.md)，保存/冲突见[前端方案](work-item-frontend.md)与[后端方案](work-item-backend.md)。方向与取舍见[决策记录](../../../.agents/notes/implemented/feature/2026-11-23-wysiwyg-markdown-editor.md)。

## 背景与调研

实现前 `text` 类型的阅读态是 [`source-lines.tsx`](../../../src/client/work-item/viewers/source-lines.tsx) + [`model.ts`](../../../src/client/work-item/model.ts) 的逐行「Markdown-ish」渲染：只有标题、列表、引用和行内粗斜体/代码，没有 GFM 表格、图片、链接、任务列表和完整代码块。用户要求阅读态达到 Typora 级别的排版，同时保留行号 anchor、批注和源码编辑。

本机已有一个可运行的参考实现，用于核实「markdown-it 渲染 + CM6 源码编辑」的实际观感与边界：

- 文件：`~/Obsidian/DwKnowledge/DwKnowledge/Kanban/note.html`
- Web：`http://127.0.0.1:8765/note.html?path=…`
- 栈：markdown-it（`html:false`、`linkify:true`、`breaks:false`）+ CodeMirror 6 + 自定义 Obsidian 行内规则；阅读态是 `md.render` 后写入 `innerHTML`。

### 参考实现实测

2026-11-23 用 Chromium（DPR 2）在 1610px 宽视口测量 `note.html`（内容视口 1610×665）；该实例保存过衬线字体和 1000px 宽度，下表是 CSS 实测值：

| 项 | 实测 | 说明 |
|---|---|---|
| 阅读列宽 | 1000px | 视口 1610，左目录 240px，阅读区 padding 44/40/96 |
| 正文 | 15px / 26.25px（1.75），系统字体或用户选择的衬线 | 颜色 `#24292e` |
| h1 | 30px / 39px，700，下边距 21px | 2em，1.3 |
| h2 | 21px / 28.35px，600，上/下边距 33.6/12.6px | 1.4em，1.35，em 按自身字号 |
| h3 | 17.25px / 30.19px，600，上/下边距 24.15/8.625px | 1.15em，line-height 继承 1.75 |
| 段落 | 15px / 26.25px，下边距 13.5px | 0.9em |
| 列表 | 左缩进 24px；项间距 3.75px | 原生 marker |
| 引用 | 左边框 3px，左 padding 15px，muted | 无背景 |
| 行内代码 | 12.9px，padding 2.4/6px，圆角 4px | 0.86em |
| 代码块 | padding 14/16px，圆角 6px，背景 `#f6f8fa`；文字 12.75px/24px | 无语法高亮，无 `<span>` |
| 表格 | 单元格 padding 6/12px，边框 1px `#d0d7de`，表头底 `#f6f8fa`；表头默认居中 | 表格宽度随内容 |
| 图片 | 最大宽 100%，圆角 6px | 无边框 |
| 分割线 | 上边框 1px，上下边距 27px | 1.8em |
| frontmatter | 折叠 `<details>`：summary 12px/21px、padding 6/12px；内容 12px/19.2px、padding 10/12px | YAML 不解析，只展示原文 |
| 选区浮动入口 | 232×40.5px，4 个按钮，距选区下方 8px，120ms debounce | `selectionchange` 触发 |
| 源码态 | CM6 14px/23.8px mono，行号 gutter 44.7px，无自动换行 | 默认浅色主题 |

### 核实结论

- **阅读体验成立**：markdown-it 的块级 DOM + CSS 已能做出流式段落、标题层级、表格、代码块、引用和 frontmatter，视觉上接近 Typora；不需要逐行布局或块级 widget。
- **代码块没有高亮**：参考实现只有 `<pre><code class="language-*">` 纯文本；本文 v1 保持纯文本，高亮留到后续，不把阅读体验验收绑定在未引入的高亮依赖上。
- **任务列表不是 GFM 默认行为**：markdown-it 默认把 `- [ ]` 渲染成字面 `[ ]`；需要自定义 list item 规则。
- **行级位置只到块**：实测 token map 覆盖 `heading_open`、`paragraph_open`、`list_item_open`、`blockquote_open`、`fence`、`table_open`、`tr_open`；`th`/`td` 和 inline 子 token 没有 map。块级 pin 可靠，块内行级位置不可直接得到。
- **参考实现的批注不可照搬**：它把选中的文字用 `==[标签] 文本==` 写回源文件，靠 `indexOf` 定位；文字重复或含 Markdown 标记时会拒绝或定位失败。Cowork 的批注是独立评论线程，必须走 `line-range` anchor + `selectedText`，不能写源文件。
- **安全不能照搬**：参考实现用 `md.render` + `innerHTML`；`html:false` 能转义原始 HTML，`validateLink` 能拒绝 `javascript:`，但 `data:image` 仍会放行。Cowork 用 token → DOM/React 渲染，不引入 `innerHTML`。
- **参考实现是桌面单栏**：目录 240px、padding 40px 固定，没有移动端策略；Cowork 的 390/768 档必须自己定义响应式，不复制它的固定尺寸。

### 采用与不采用

| 采用 | 不采用 / 调整为 |
|---|---|
| 15px / 1.75 的正文比例、标题层级、列表/引用/代码/表格的间距比例 | 1000px 阅读列：Cowork 纸面最大 920px；44/40/96 padding：改为纸面内 28/40/24/40 |
| 流式段落、GFM 表格、图片、frontmatter 折叠 | `md.render` + `innerHTML`、`data:image`、Obsidian `==`/`[[ ]]`/`![[ ]]` 语法 |
| 选区浮动「批注」入口和 120ms debounce | 参考实现的 `indexOf` 写回标记；Cowork 用 block range + `selectedText` |
| CM6 源码编辑与行号（沿用现有 `editor.tsx`） | 参考实现的 14px CM 和默认浅色主题；Cowork 沿用现有源码态样式 |
| 阅读态无行号 gutter | 参考实现的目录/字体/主题设置面板；Cowork v1 不提供阅读设置 |

## 目标

- 一个**阅读面**：markdown-it 将完整源文本渲染为流式 React 元素；标题、段落、列表、任务列表、引用、链接、粗体/斜体/删除线、行内代码、围栏代码块、表格、图片、分割线、frontmatter 全部呈现。
- 一个**源码面**：保留现有 CM6 编辑器；文档、撤销/重做、自动保存、版本冲突、`line-range` anchor 和 quote 重定位都以完整 Markdown 源文本为真相。
- 阅读面可批注：块级 pin 定位现有线程；选中文字后出现浮动「批注」入口，创建 `line-range` anchor（整行 quote + 可选 `selectedText`），不写源文件。
- 阅读面不伪造逐行行号：块级 pin 和行范围提示；精确到源码行的操作在源码态完成。
- 渲染只建 DOM/React 节点，原始 HTML 按字面显示，不引入未净化 `innerHTML`。
- 阅读态和源码态共享同一份 draft、同一套保存/冲突状态；切换不丢内容。

## 非目标

- 不做单表面就地编辑：阅读态只读，不出现「当前块显示源码」的状态机。
- 不做 Notion 式结构化块模型；不把 AST/JSON 作为唯一真相。
- 不做表格单元格网格编辑、表格属性面板；表格编辑 = 切源码。
- 不做 Doc 富文本（TipTap）；Doc/表格/PDF/图片类型按 KI-57 已移出目标。
- 不解析原始 HTML、Obsidian `==`/`[[ ]]`/`![[ ]]`、Mermaid、KaTeX；这些按字面文本显示。
- 不做阅读态 TOC、字体/主题设置、打印/导出改造。
- v1 不做行级 diff 底色：没有可靠 diff 数据时不伪造，落到源码态看版本/冲突区。
- 不新增 wire 路由；不引入 `marked`、`mermaid`、`katex`、`DOMPurify`。

## 渲染层与数据流

```text
ArtifactFileResponse.content（完整源文本）
        │
        ├─ splitFrontmatter ──▶ frontmatter 文本 + body + bodyStartLine
        │
        ├─ markdown-it.parse(body, { html:false, linkify:true, breaks:false })
        │       └─ token[] ──▶ React 元素/DOM（textContent、createElement，绝不 innerHTML）
        │              ├─ 块元素带 data-src-start / data-src-end / data-src-kind
        │              ├─ frontmatter <details>
        │              └─ 图片/链接/任务列表/表格按白名单渲染
        │
        └─ CM6 源码态（editor.tsx，完整 content，含 frontmatter）
```

- **依赖**：新增 `markdown-it@15.0.3`（MIT），固定版本并随锁文件提交。GFM 表格、删除线、自动链接由内核提供；任务列表由渲染层识别首个文本标记实现，不引入插件。代码高亮 v1 不做，不引入 highlighter。
- **不做 HTML 字符串**：`md.render` 只用于参考实现对比；Cowork 用 `md.parse` 的 token 树渲染 React 元素，所有文本由 React 转义，图片/链接在创建节点前过 URL 白名单。
- **token 渲染覆盖**：heading、paragraph、bullet/ordered list、list item、blockquote、fence、code、table/thead/tbody/tr/th/td、inline（text/strong/em/del/code/link/image/softbreak/hardbreak/html_inline）、hr、html_block（按字面）。
- **块属性**：`data-src-start`、`data-src-end` 来自 token.map；`data-src-kind` 取 `heading`/`paragraph`/`list`/`item`/`quote`/`fence`/`table`/`hr`/`frontmatter`。容器和叶子都带属性，pin 取包含 anchor 行的**最深叶子块**。图片是段落内的 inline token，不单独成块，pin 落到所在段落。
- **frontmatter**：仅当 body 以 `---` 开头并存在闭合 `---` 时拆分；不解析 YAML；`bodyStartLine = 闭合行号 + 1`，body 的 token map 加上该偏移。frontmatter 行仍属于源码，但不可批注。
- **任务列表**：list item 的首个 inline token 以 `[ ] ` 或 `[x] `/`[X] ` 开头时，去掉前缀并渲染 disabled checkbox；勾选不写回，源码态修改。
- **表格**：按 token 的 `text-align` 属性应用 left/center/right；只接受这三个值，不接受任意 style 字符串。

## 块索引与行号映射

### 数据结构

```ts
interface MarkdownBlock {
  readonly startLine: number   // 1-based 源码行，含 frontmatter 偏移
  readonly endLine: number     // 1-based，含
  readonly kind: 'heading' | 'paragraph' | 'list' | 'item' | 'quote' | 'fence' | 'table' | 'hr' | 'frontmatter'
  readonly renderedAs: 'flow'  // 阅读态全部是流式块
}
```

`parseMarkdownBlocks(content)` 由 markdown-it token 树推导块列表；`blockAtLine(blocks, line)` 返回包含该行的**最深**块。块索引只服务呈现与 pin 定位，不持久化。

### token map 实测

| token | `map` | 用途 |
|---|---|---|
| `heading_open`（ATX / setext） | 有；setext 含下划线行 | 标题块与 pin |
| `paragraph_open` | 有 | 段落块与 pin |
| `list_item_open` | 有；嵌套项各自有 | 列表项 pin |
| `blockquote_open` | 有 | 引用块与 pin |
| `fence` | 有 | 代码块与 pin |
| `table_open` / `thead_open` / `tbody_open` / `tr_open` | 有 | 表格块/表头/行 |
| `hr` | 有 | 分割线块 |
| `th_open` / `td_open` | 无 | 单元格不设源码行地址 |
| `inline` 的子 token | 无 | 块内行级位置不可由 token 得到 |

### anchor 与 pin 规则

- `ArtifactAnchor` 始终存源码行号；沿用 [`deriveLineAnchor`](../../../src/domains/artifact/anchor.ts) / `relocateLineAnchor`，服务端零改动。
- 线程 anchor 的 `startLine` → `blockAtLine` → 块；pin 落在该块首行右侧。跨块的 anchor 取起始块，rail 卡显示完整行范围。
- 一个块有多条线程时，pin 显示最早线程序号；其余线程通过批注栏访问；`aria-label` 写「第 N 条批注，共 M 条，第 S–E 行」。
- anchor 落在 frontmatter、空行或没有渲染块的区域时不显示 pin；rail 卡仍保留，点击「在源码中查看」定位。
- 源码行号是 anchor 的唯一地址空间；阅读态的块、pin、行范围提示都是呈现，不是新的地址空间。
- 阅读态**没有**行号 gutter；块首 pin 的 hover/focus 显示 `第 S–E 行` 范围提示，不冒充逐行行号。

### 选区 → 行范围

1. 选区起止节点落在阅读面内；取起点所在块和终点所在块。
2. 单块：把块内源码行去掉行内标记后拼成纯文本（粗体/斜体/行内代码标记去掉，链接只保留显示文本，列表/引用前缀去掉），在纯文本中查找规范化后的 `selectedText`；唯一命中时把字符区间换算成起止行，得到精确行范围。
3. 未命中/重复/跨块：回退到块范围（跨块取首块起、末块止）。
4. 生成 `lineRangeAnnotation(lines, file, primaryPath, start, end)`（[model.ts](../../../src/client/work-item/model.ts)），由服务端 `deriveLineAnchor` 从文件重新取 quote/context；`selectedText` 截断到 `MAX_ARTIFACT_QUOTE_CHARS`，只用于展示与投递 prompt，不参与重定位。

## 页面结构

```text
工作项查看器
├─ 工具条：文档 / 版本 / 附件；阅读/源码 segmented；保存状态；批注 N
├─ 纸面（max-width 920px）
│  ├─ 纸面头 42px：MD 图标、plan.md、Markdown · rN、附件 chip
│  ├─ 阅读态 .cwi-md-read
│  │  ├─ frontmatter <details>（可折叠，只读）
│  │  ├─ 流式正文（标题/段落/列表/引用/代码/表格/图片/任务/链接/hr）
│  │  ├─ 块级 pin（absolute，右侧 6px，随块滚动）
│  │  ├─ 选中线程块底（accent-soft + inset 2px accent）
│  │  └─ 选区浮动「批注」入口（fixed，选区下方 8px）
│  ├─ 源码态 .cwi-editor-host（CM6，现有）
│  └─ 纸面脚 36px：附件 chip、保存/版本信息
└─ 右侧批注栏（336px，沿用 rail 设计）
```

阅读态不渲染行号 gutter；`.cwi-md-read` 的左右 padding 为 24px / 40px，右侧 40px 同时给 pin 留位。源码态沿用现有 editor 区域、行号 gutter 和 anchor 行标记。

## 状态模型

| 状态 | 触发 | 表现 |
|---|---|---|
| 阅读态 | `readMode=true`，无未保存草稿 | 流式渲染；块级 pin；选区批注；只读 |
| 源码态 | `readMode=false` | CM6 编辑器；行号、anchor 行标记、保存/冲突；可编辑 |
| 未保存草稿 | 源码态输入后切回阅读 | 阅读态渲染 draft；块级 pin 暂时隐藏，批注入口禁用，提示「保存后可批注」；保存成功后恢复 |
| 保存中 | 800ms 防抖请求中 | 保存点脉冲，文案「保存中」；阅读态仍渲染 draft；源码态可继续输入 |
| 冲突 | `artifact/version-conflict` | 冲突条 + 查看差异/加载最新/保留我的；阅读态显示冲突条并禁用批注；源码态保留草稿 |
| 跨会话只读 | `sessionId !== ownerSessionId` | 顶部 36px 提示条 +「在所属会话打开」；阅读态只读；编辑与批注 composer 禁用 |
| 错误/缺失文件 | detail/file 失败或 `missing` | 沿用 `ViewerPlaceholder` / `RebindFileEntry`；不渲染阅读面 |
| 窄屏 < 900px | 视口 | 批注栏改底部抽屉；纸面满宽；阅读 padding 按响应式表 |
| 大文件 | 超过 2 MB 或 20k 行，或渲染超时 | 阅读态降级为源码态 + 提示；不阻塞编辑，不伪造渲染 |

## 交互流程

### 阅读 / 源码切换

1. 工具条 segmented 切换 `readMode`；`aria-pressed` 与文案保持。
2. 阅读 → 源码：取阅读面当前顶部可见块的 `startLine`，切到源码态后把 CM6 滚到该行，聚焦编辑器。
3. 源码 → 阅读：取 CM6 当前顶部可见行，切到阅读态后把包含该行的块滚到视口顶部；无匹配块时滚到文首。
4. 只切换表面，不重载文件、不重置 draft、不触发保存。

### 选区批注

1. 在阅读面选中文字；120ms debounce 后在选区下方 8px 出现浮动入口：左侧 9px「第 S–E 行」只读 chip，右侧「批注」按钮；选区跨行/跨块同样显示。
2. 点击「批注」→ 按上节「选区 → 行范围」生成 anchor；打开批注栏会话 composer，显示 `第 S–E 行` 和 `selectedText` 单行摘要。
3. 提交走现有 `artifact.comment`；失败保留草稿并给可读错误；成功后线程出现在 rail，阅读面出现/更新 pin。
4. 点击 pin → 打开对应线程会话，滚动到 anchor 块，块底高亮；Esc/点击其它块取消。
5. 选区工具栏在滚动、缩放、选区收起、Esc、点击外部时关闭；不改变焦点顺序。

### 链接、图片、表格、任务列表、代码块

- 链接：`http(s)` 外链渲染 `<a target="_blank" rel="noopener noreferrer">`，点击直接打开；相对路径/锚点/其它 scheme 渲染为普通文字（v1 不支持站内跳转）。
- 图片：`http(s)` 直连；`cowork-attachment://<id>` 走现有附件读取路由；项目内相对路径通过白名单但在 v1 没有读取路由，渲染为 11px「图片地址不可用」占位；加载失败显示虚线占位块，不显示破图；alt 缺失时不伪造 alt，figure 下显示 11px「未提供图片说明」。
- 表格：渲染完整表格；点击单元格不进入编辑；窄屏横向滚动在表格容器内，不撑破纸面；编辑切源码。
- 任务列表：checkbox 14×14、disabled、不可点击；`[x]` 有勾，`[ ]` 为空；修改切源码。
- 代码块：`<pre><code class="language-*">`，无高亮；横向滚动在块内；点击不进入编辑。
- frontmatter：默认折叠；summary「文档元数据（frontmatter，只读保护）」；展开只读原文；不可批注。

### 键盘、IME、滚动

- 阅读态是只读 DOM：方向键/PageUp/PageDown 走浏览器滚动；Tab 按焦点顺序经过 pin、批注入口、rail；`Esc` 关闭选区工具栏/线程选中。
- 选区批注入口可点击；键盘选中文字同样触发 `selectionchange`；右键/菜单键不新增一套入口（沿用 rail 设计的右键等价要求，由 rail 负责）。
- 源码态：CM6 原生 IME composition、撤销/重做、`Mod-s`；阅读态不接收输入，不做 decoration 重算。
- 图片加载/字体加载/窗口缩放后，pin 位置随块重新布局，不需要手工重算坐标（pin 在块内，absolute 相对块）。

### 保存、冲突、跨会话

- 保存/冲突沿用现有 `panel.tsx` 路径；阅读态只读，不触发保存。
- 未保存草稿切到阅读态：渲染 draft；pin 隐藏、批注禁用；保存成功后重新映射 anchor。
- 冲突时阅读态显示冲突条并禁用批注；用户切源码处理三选。
- 跨会话只读：阅读态可看，pin 可打开已有线程，composer 禁用；源码态禁用编辑。

## 数据 / 接口 / 契约变化

- 不新增 wire 路由；渲染只消费 `ArtifactFileResponse.content`，保存/冲突/批注复用 `artifact.edit` / `artifact.comment` / `artifact.version-conflict`。
- `line-range` anchor 增加可选 `selectedText?: string`（由[批注栏设计](work-item-rail-and-annotation.md)拥有）；`deriveLineAnchor` 仍从文件全文推导 quote/context，`relocateLineAnchor` 不使用 `selectedText`。
- 客户端新增纯函数（`src/client/work-item/viewers/markdown.ts`，React-free，`node --test` 覆盖）；渲染组件在 `viewers/markdown-view.tsx`，阅读态样式在 `reading-styles.ts`：
  - `splitFrontmatter(content): { frontmatter: string | null; body: string; bodyStartLine: number }`
  - `parseMarkdownBlocks(content, bodyStartLine): MarkdownBlock[]`
  - `blockAtLine(blocks, line): MarkdownBlock | null`
  - `lineRangeForSelection(blocks, lines, startBlock, endBlock, selectedText): { startLine; endLine }`
  - `sanitizeLinkHref(href): string | null`
  - `sanitizeImageSrc(src, allow): string | null`
  - `renderTaskMarker(text): { checked: boolean; text: string } | null`
  - `readFallbackReason(content): string | null`（2 MB / 20k 行降级判断）
- 图片 URL 解析复用既有附件读取路由；无新路由。项目内相对图片没有宿主读取入口，v1 只保留白名单校验与占位，不伪造请求。
- 版本/冲突/附件 chip/活动时长沿用现有契约；不添加 diff 字段（v1 无行级 diff）。
- 权限边界不变：编辑写权限沿用 `artifact/edit` 的 `editable` + owner 校验；跨会话只读由 `ownerSessionId` 判定。

## 安全

- **原始 HTML 按字面**：markdown-it `html:false`；token 渲染只写 `textContent`/React children；源码里的 `<script>`、`<img onerror>` 显示为文本。
- **无 innerHTML**：渲染路径不出现 `dangerouslySetInnerHTML`/`innerHTML`；表格、代码、链接、图片全部建节点。
- **链接**：只接受 `http`/`https`；带 `target="_blank"` + `rel="noopener noreferrer"`；`javascript:`/`vbscript:`/`file:`/`data:` 一律不渲染为链接。
- **图片**：白名单 `http(s)://`、`cowork-attachment://<id>`、项目内相对路径；拒绝 `javascript:`/`data:`/`blob:`/`file:`/`vbscript:`/绝对路径/`..` 逃逸/反斜杠/控制字符。markdown-it 默认放行 `data:image`，实现必须在建 `<img>` 前覆盖该判断。
- **表格对齐**：只接受 `left|center|right` 三个 token 属性值，不拼接原始 style。
- **frontmatter**：只展示原文，不解析 YAML，不执行/求值。
- **任务列表**：只读 checkbox；点击不修改源文本。
- **资源上限**：沿用 `MAX_ARTIFACT_TEXT_BYTES` / `MAX_ARTIFACT_TEXT_LINES`；超限降级源码态，不做无界 DOM。
- **测试**：原始 HTML 字面、`javascript:` 链接、`data:` 图片、外链 `rel`、表格对齐注入、超长 quote/selectedText。

## 可访问性

- 语义 HTML：`article`、`h1–h6`、`ul/ol/li`、`blockquote`、`table/th/td`、`pre/code`；表格 `th` 带 `scope="col"`；图片使用作者 alt，缺失时 figure 下有可见说明。
- pin 是 `<button>`，`aria-label` 含线程序号、总数、行范围；`focus-visible` 2px ink outline，offset 1px。
- 选区「批注」入口是可聚焦按钮；打开 composer 后焦点进入输入框；Esc 关闭并把焦点还给触发位置。
- 焦点顺序沿用[视觉基线](visual-acceptance.md) §7：header tabs → header 操作 → 工具栏 → 阅读正文 → pin/选区入口 → 批注栏 → composer → footer。
- 颜色不是唯一状态：pin 的 resolved/stale 有 `aria-label` 文字；diff 色（后续）有文字说明。
- `prefers-reduced-motion: reduce` 关闭脉冲/过渡；正文对比度达 WCAG AA；暗色用宿主 alias token。
- 源码态继续使用现有 CM6 的 `aria-label` 和键盘行为。

## 视觉保真与像素验收

### 口径

- 参考画板 1280×900，App 内容盒 1208×828；纸面最大 920px，左右居中；右栏 336px（窄屏 280/抽屉）。1280 视口 + 336px 批注栏时纸面约 825px、正文列约 761px；920px 只在更宽视口或批注栏收起时出现。
- 截图为 Chromium headless、DPR 2；关键布局盒容差 ±2px，文字基线/边框 ±1px。
- 下表的 px 是 15px 基准下的计算值；CSS 用 em 表达 Markdown 节奏，UI chrome 用整数 px。
- 颜色来自 `--cwi-*` / 暗色 `--dsw-alias-*`；不新增硬编码亮色值，pin tone 沿用基线。

### 桌面规格（≥1024px，纸面 920px）

| 元素 | 规格 |
|---|---|
| 纸面 | max-width 920px；border 1px `--cwi-border`；圆角 12px；纸面头 42px；纸面脚 36px |
| 阅读区 | padding 28px 40px 40px 24px（上/右/下/左）；正文列宽 856px；无行号 gutter |
| 正文 | 15px / 26.25px（1.75）；系统字体栈；`--cwi-ink`；字距 0 |
| 段落 | 下边距 13.5px（0.9em）；无首行缩进 |
| h1 | 30px / 39px，700，下边距 21px（0.7em）；首个元素上边距 0 |
| h2 | 21px / 28.35px（1.35），600，上/下边距 33.6/12.6px（1.6em/0.6em，em 按 h2 字号） |
| h3 | 17.25px / 24.15px（1.4），600，上/下边距 24.15/8.625px（1.4em/0.5em） |
| h4–h6 | 15px / 24px，600，上/下边距 21/9px；不缩字号 |
| 粗体 / 斜体 / 删除线 | 650 / italic / line-through；删除线颜色 muted |
| 链接 | `--cwi-accent`，无默认下划线，hover 下划线；外链新窗口 |
| 行内代码 | 12.9px mono，padding 2px 6px，圆角 4px，背景 `--cwi-surface-muted`，颜色 ink |
| 列表 | `ul/ol` 下边距 13.5px、左缩进 24px（1.6em）；`li` 上下 4px；嵌套列表下边距 0 |
| 任务列表 | `list-style:none`；左 padding 22px；checkbox 14×14、圆角 3px、1px `--cwi-border`、右间距 8px；选中底 `--cwi-success-soft`、边框 `--cwi-success`、勾 8px；disabled |
| 引用 | 左边框 3px `--cwi-border`，左 padding 15px，上下 2px，颜色 `--cwi-muted`，下边距 15px；无背景 |
| 代码块 | 背景 `--cwi-surface-muted`；padding 14px 16px；圆角 6px；下边距 15px；`code` 12.75px / 24px mono；块内横向滚动；无高亮 |
| 表格 | 容器下边距 15px、圆角 6px、横向滚动；表格宽 100%、列宽随内容；单元格 padding 6px 12px、1px `--cwi-border`、左对齐、顶部对齐、15px/26.25px；表头底 `--cwi-surface-muted`、600 |
| 图片 | `img` max-width 100%、height auto、圆角 8px、1px `--cwi-border-soft`；figure 下边距 15px；caption 11px/18px、`--cwi-soft`、上边距 6px；失败占位虚线 1px、圆角 8px、最小高度 96px、11px 说明 |
| 分割线 | 1px `--cwi-border-soft`；上下边距 27px |
| frontmatter | 下边距 20px；border 1px；圆角 6px；summary 12px/21px、padding 6px 12px、`--cwi-muted`；展开内容 12px/19.2px mono、padding 10px 12px、上边框 1px、最大高 240px、纵向滚动 |
| 块级 pin | 17×17px、padding 0 4px、2px 纸面底色描边、圆角 999px、8px/800、白字、accent 底、shadow `0 1px 3px #1018282e`；块内 `right:-33px`、`top:2px`；hover/focus 用 tooltip 显示 `第 S–E 行`（9px/700、padding 1px 5px、圆角 4px、accent-soft/accent），不参与常驻布局 |
| 选中线程块 | `background:--cwi-accent-soft` + `box-shadow: inset 2px 0 0 var(--cwi-accent)`；不改变块尺寸 |
| 选区 | `::selection` 背景 `#b2ddff`（暗色品牌 24%），文字 inherit |
| 选区工具栏 | 高 36px、padding 4px 8px、圆角 10px、border 1px、背景 surface、shadow `0 8px 24px rgba(16,24,40,.16)`；左侧 9px/600「第 S–E 行」只读 chip、颜色 `--cwi-soft`、padding 0 3px；按钮高 26px、padding 0 12px、圆角 7px、11.5px/600、accent 底白字；距选区下方 8px，空间不足翻到上方 8px，左右/上下 clamp 8px |

### 响应式差异

| 宽度 | 阅读区 padding | 纸面/正文 | 标题 | pin / 其他 |
|---|---|---|---|---|
| 900–1023 | 24px 32px 40px 20px | 纸面 max 920；正文列宽 = 纸面 − 52px | h1 30 / h2 21 / h3 17.25 | pin `right:-25px`；rail 280px |
| 640–899 | 24px 28px 40px 20px | 纸面满宽；正文列宽 = 纸面 − 48px | h1 28/36、h2 20/27、h3 16/22 | pin `right:-21px`；rail 底部抽屉；表格/代码容器内滚动 |
| < 640 | 20px 24px 32px 16px | 纸面满宽；正文列宽 = 纸面 − 40px | h1 26/34、h2 19/26、h3 16/22；正文 15/25 | pin `right:-17px`；`<390` 无页面横向滚动；toolbar 可换行 |

### 暗色

- 正文/标题/边框/纸面用宿主 alias：`--dsw-alias-label-primary`、`label-secondary`、`border-l2`、`bg-layer-1`；代码底优先 `--dsw-alias-markdown-code-block`，回退 `--cwi-surface-muted`。
- pin 颜色沿用基线（accent/success/warn）在暗色的 host 版本；选区背景用品牌 24% 混色；表格 `th` 底用 `bg-layer-2`。
- 亮/暗对比度均需 WCAG AA；暗色下不出现白底代码块或亮色 gutter。

### 容差

- 纸面宽度/阅读区 padding/块首 pin 位置/表格列宽：±2px。
- 正文基线、标题基线、边框宽度、pin 圆心：±1px。
- 同一 15px 字号在不同字体栈下的行高不视为偏差；以 computed line-height 26.25px 为准。
- 没有真实截图证据的「看起来差不多」不作为验收。

## Demo

- [交互稿](assets/wysiwyg-editor-demo.html)（双板：阅读态首屏 + 续页；首屏含 frontmatter、标题、段落/链接/行内代码、列表、表格、选区浮动批注、块级 pin；续页含引用、代码块、任务列表、图片、链接和 stale pin；批注栏、保存状态、附件 chip、版本计数沿用共享外壳。源码态沿用现有 `editor.tsx`，不在本 demo 重画）
- 截图：[wysiwyg-editor-demo.png](assets/wysiwyg-editor-demo.png)（Chromium headless 实际生成，2560×3600；两块各 1280×900 逻辑尺寸，DPR 2；实现期按上表 ±2px 核对）

## 测试与验收

| 层 | 检查 | 哪个会红 |
|---|---|---|
| 单测（`node --test`） | `splitFrontmatter` 偏移、`parseMarkdownBlocks` 的 token map（标题/段落/列表项/引用/围栏/表格行）、`blockAtLine`、`lineRangeForSelection` 唯一命中/重复/跨块回退、`sanitizeLinkHref`、`sanitizeImageSrc`、任务标记、降级阈值 | `tests/client/work-item-markdown.test.mjs` 红 |
| 单测 | 渲染路径无 `innerHTML`/`dangerouslySetInnerHTML`；原始 HTML 字面；`javascript:`/`data:` 拒绝；表格对齐只接受三值 | 安全单测/静态检查红；浏览器 `scenarioWorkItemMarkdown` 断言 |
| 浏览器（`npm run test:browser`） | 阅读态构造渲染（表格/任务/代码/图片成功与失败占位/data: 拒绝/frontmatter）、块级 pin（含 table 外置容器）与 Escape 清除高亮、选区浮动入口与同任务内不出现的 debounce 断言、阅读↔源码滚动位置、dirty 时 pin/批注禁用与保存恢复、跨会话可切到只读源码面、不可进入编辑、1024/768/820/390 无横向溢出、降级提示 | `tests/browser/scenarios.mjs` 的 `scenarioWorkItemMarkdown` 与跨会话/草稿场景红 |
| 浏览器 | 保存/冲突三选、跨会话只读、图片失败占位、任务列表不可勾选 | 浏览器 lane 红 |
| 真实宿主 | 图片粘贴上传 → 附件引用 → 阅读态渲染；保存 → anchor 重定位 | `test:host-smoke` / 真机 E2E |
| 截图 | 1280/1024/768/390 亮暗各一；关键盒 ±2px；双板 demo 实际生成 | 交付闸门 `page-verify` + `dev_visual_check` |

明确会红的安全项：`<img onerror>` 在阅读态只显示字面文本；`javascript:` 链接不生成 `<a>`；`data:` 图片被拒；外链带 `rel`；任务列表 checkbox 不可触发源文本修改。

## 风险、未核实、降级/回滚

- **token map 覆盖**：实测 `th/td` 无 map；表格单元格不设行级地址。若后续要单元格批注，走 `table-cell` anchor（契约已有 kind，但当前无创建/重定位路径），不在本次实现。
- **选区行范围启发式**：去标记纯文本匹配在复杂行内格式/重复文本上会回退整块；`selectedText` 仍准确，行范围可能比选区宽。实现期用 fixture 语料核对准确率，必要时在 composer 显示「整块范围」提示。
- **frontmatter 边界**：YAML 内出现 `---` 行、文件不以 `---` 开头等场景需 fixture；v1 只按首尾 `---` 拆分，不解析 YAML。
- **阅读 DOM 性能**：大文件/长表格的节点数；按 2 MB / 20k 行阈值降级为编号源码视图（保留 Markdown-ish 行内样式），不做无界渲染。降级路径的 2 MB 浏览器 fixture 布局很慢，浏览器 lane 只断言降级分支挂载与提示文案。
- **新增依赖**：`markdown-it@15.0.3`（MIT），由客户端 esbuild 闭包内联；版本固定在 `package.json`，锁文件随依赖提交。代码高亮未引入。
- **代码高亮缺失**：v1 代码块纯文本，视觉上弱于 Typora；高亮作为后续独立变更，不阻塞阅读/批注验收。
- **dirty 时禁批注**：用户可能期望边改边批注；这是 anchor 与已保存版本一致性的取舍，提示文案必须清楚。
- **源码态暗色**：CM6 仍用默认浅色高亮，未随宿主暗色重写；这是既有行为，不在本文重写编辑器。阅读态复用宿主 alias token，但浏览器 lane 没有暗色截图，暗色可读性仍属未核实。
- **项目内相对图片**：白名单接受该写法，但当前没有宿主读取路由，渲染为占位；需要真实开发时另加受控读取入口，不给 `<img>` 直接拼宿主路径。
- **大文件/超长行**：无自动换行的源码态是既有行为；阅读态流式换行不受影响。
- **回滚**：阅读态是新增渲染路径，旧 `source-lines.tsx` 的逐行阅读保留为逃生门（也是大文件降级面）；出问题切回旧路径，不改 anchor/保存/批注契约。删除旧路径前必须完成浏览器 lane 与四档截图验收。
- **未核实**：跨会话只读下已有 pin 的可点击性（浏览器 lane 只断言了批注入口禁用）；390 档表格/长链接的截断与四档逐像素截图；CM6 在超长行下的滚动定位手感。
