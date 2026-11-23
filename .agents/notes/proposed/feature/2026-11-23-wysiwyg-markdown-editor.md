# Proposal: Typora 风格 Markdown 阅读与批注（markdown-it 阅读 + CM6 源码）

Status: proposed
Date: 2026-11-23
Class: feature

## Problem

工作项 `text` 类型的阅读态是 `source-lines.tsx` + `model.ts` 的逐行「Markdown-ish」渲染：只有标题、列表、引用和行内粗斜体/代码，没有 GFM 表格、图片、链接、任务列表和完整代码块。用户要求阅读态达到 Typora 级别的流式排版，同时保留 `line-range` anchor、批注和源码编辑。

2026-11-23 用本机可运行的 `~/Obsidian/DwKnowledge/DwKnowledge/Kanban/note.html` 核实：markdown-it 渲染 + CM6 源码编辑的阅读观感成立，选区浮动入口也可用；但该实例的 `md.render` + `innerHTML`、`==[标签]` 写回源文件、`indexOf` 定位、Obsidian 语法和无行级 anchor 都不能照搬。用户据此改选两态方案：阅读态负责阅读和批注，源码态负责行级精确编辑。

## Proposal

采用两态方案，替换 `text` 类型现有的逐行阅读渲染：

- **阅读态**：`markdown-it.parse`（`html:false`、`linkify:true`、`breaks:false`）→ token → React/DOM，不经过 `innerHTML`；渲染标题、段落、列表、任务列表、引用、链接、图片、行内代码、围栏代码块、GFM 表格、分割线和 frontmatter 折叠块。原始 HTML 按字面显示。
- **源码态**：沿用 `editor.tsx` 的 CodeMirror 6 编辑器、行号、anchor 行标记、撤销/重做、保存和冲突路径，不改编辑器实现。
- **块索引**：由 token map 生成 `MarkdownBlock[]`（startLine/endLine/kind），用 `blockAtLine` 把 anchor 行映射到阅读态块；pin 落在块首行右侧，阅读态不设行号 gutter。
- **批注**：现有线程的 `line-range` anchor 不变；阅读态显示块级 pin；选中文字后出现浮动「批注」入口，按块范围 + 去标记文本唯一匹配生成行范围，失败回退整块范围；`selectedText` 由[批注栏设计](../../../../docs/design/work-item/work-item-rail-and-annotation.md)拥有，不写源文件，不参与 `relocateLineAnchor`。
- **模式切换**：工具条「阅读/源码」保留；阅读→源码按顶部块起始行定位 CM6，源码→阅读按顶部可见行定位块；未保存草稿在阅读态渲染 draft，但 pin/批注禁用直到保存。
- **安全**：外链只允许 `http(s)` 并带 `rel="noopener noreferrer"`；图片白名单为 `http(s)`、`cowork-attachment://<id>`、项目内相对路径；拒绝 `javascript:`/`data:`/`blob:`/`file:`/`vbscript:`/绝对路径/`..` 逃逸；markdown-it 默认放行 `data:image`，实现必须覆盖；表格对齐只接受 left/center/right；不引入 `marked`/`mermaid`/`katex`/`DOMPurify`。
- **视觉**：正文 15px/1.75、纸面 920px、阅读区 padding 28/40/24/40、h1 30/39、h2 21/28.35、h3 17.25/24.15；代码块 v1 纯文本；像素规格与响应式差异由[设计文档](../../../../docs/design/work-item/wysiwyg-markdown-editor.md)拥有，demo 见[交互稿](../../../../docs/design/work-item/assets/wysiwyg-editor-demo.html)。

不新增 wire 路由：渲染只消费 `ArtifactFileResponse.content`；保存、冲突、批注复用 `artifact.edit`、`artifact.comment`、`artifact.version-conflict`；`selectedText` 是 `line-range` 的可选字段，服务端 `deriveLineAnchor` 仍从文件重建 quote/context。

## Alternatives considered

**单表面 CodeMirror 6 hybrid（原提案，否决）。** 它的收益是「当前块就地显示源码」，代价是放弃流式段落重排：为了行号 1:1，源码换行必须保持视觉换行，标题/表格/图片只能做行级装饰或块 widget；块折叠后 gutter 行号、pin 定位、IME 组合和活动块状态机都要自写。对「阅读质量优先、批注可在源码态精确到行」的目标，这个代价不划算。只有未来把「单表面就地编辑」重新列为硬需求时才重新评估。

**参考实现 `note.html` 原样采用（否决）。** 它用 `md.render` 写 `innerHTML`，批注靠 `==[标签]` 写回源文件并用 `indexOf` 定位，文字重复或含 Markdown 标记时会拒绝；没有行级 anchor、评论线程和 Cowork 的投递闭环。它的阅读排版可借鉴，安全、批注和 Obsidian 语法不可照搬。

**TipTap / ProseMirror 所见即所得（否决）。** 真相是 ProseMirror 文档（AST/JSON），与完整 Markdown 源文本、行号 anchor 和 quote 重定位冲突；往返序列化会破坏空白/缩进/围栏字节。富文本是 Doc 类型，已按 KI-57 移出目标。

**`codemirror-markdown-hybrid@1.2.2` fork 后净化（否决）。** 该包用 `marked` 输出直写 `innerHTML`，Mermaid `securityLevel:'loose'`，依赖树含 mermaid/katex/多个 CM 语言包；表格/任务列表是逐行启发式，不是整文档解析。fork 等于重写并长期追上游安全补丁。

**markdown-it + contenteditable 就地编辑（未采用）。** 它会变成另一套富文本编辑器，源文本保真、行号 anchor 和撤销/保存都要重做，且无法保证 Markdown 字节不变；不满足本工作项的行级锚点契约。

## Acceptance criteria

- [A1] 阅读态渲染标题、段落、列表、任务列表、引用、链接、图片、行内代码、围栏代码块、GFM 表格、分割线和 frontmatter；原始 HTML 按字面显示 — `browser` + `tests`（`tests/client/work-item-*`）
- [A2] 渲染路径不存在 `innerHTML`/`dangerouslySetInnerHTML`；`javascript:` 链接、`data:` 图片、`<img onerror>` 原始 HTML 均被拒/转义；外链带 `rel` — `source`（静态检查）+ `tests`
- [A3] token map 推导的块索引正确；`blockAtLine` 与 `lineRangeForSelection` 的单块/重复/跨块回退有单测；`line-range` anchor 仍由 `deriveLineAnchor`/`relocateLineAnchor` 处理 — `tests`（`tests/client/*`、`tests/domains/artifact/anchor.test.mjs`）
- [A4] 阅读态选中文字出现浮动「批注」入口；创建含 `selectedText` 的 `line-range` anchor；pin 打开对应线程；dirty/冲突时 pin 与批注禁用 — `browser`
- [A5] 阅读↔源码切换按块/行滚动且不丢 draft；源码态保存、`Mod-s`、冲突三选、跨会话只读保持 — `browser`（复用 `panel.tsx` 路径）
- [A6] 1280/1024/768/390 四档无页面横向滚动；纸面、正文、pin、选区入口、表格/代码块的尺寸在 ±2px 内；亮/暗主题可读 — `browser` + 截图交付闸门
- [A7] 不新增 wire 路由；图片读取复用附件/宿主文件路由；`selectedText` 只扩展 anchor 字段 — `source`（`tests/support/public-surface.mjs`）
- [A8] 大文件（2 MB/20k 行）降级源码态，不阻塞编辑；frontmatter 偏移与不可批注行为有测试 — `tests` + `browser`

## Risks

- token map 对表格单元格和 inline 子 token 不提供位置：单元格级批注不在本次范围；块内精确行范围依赖「去标记文本唯一匹配」，重复/复杂行内格式会回退整块范围，需 fixture 语料核对准确率。
- frontmatter 的边界（YAML 内含 `---`、文件首行不是 `---`）需要单独测试；v1 只按首尾 `---` 拆分，不解析 YAML。
- 新增 `markdown-it` 依赖需要核对版本、锁文件、许可证和打包体积；不安装未锁定版本。
- 代码块 v1 没有语法高亮，视觉上弱于 Typora；高亮是后续独立变更，不阻塞阅读/批注验收。若用户把高亮视为阅读体验硬需求，重新评估 highlighter 依赖。
- 阅读态是完整 DOM 渲染，20k 行/大表格的节点数可能成为瓶颈；超过 2 MB 或 20k 行降级源码态，后续再评估分块渲染。
- dirty 时阅读态渲染 draft 但禁用批注，用户可能想边改边批注；这是 anchor 与已保存版本一致性的取舍，提示文案必须明确。
- 源码态的 CM6 暗色主题、滚动定位 API、跨会话只读下已有 pin 的可点击性未在实现前核实。
- 回滚：保留旧 `source-lines.tsx` 阅读路径作为逃生门；锚点、保存、批注、附件契约不变，出问题可切回旧路径。

## Delivery stages

1. **渲染内核**：markdown-it 依赖、token→React 渲染、`splitFrontmatter`、`parseMarkdownBlocks`、`blockAtLine`、URL 白名单、任务列表、阅读态样式；可演示：完整阅读态 + 原始 HTML 字面 + 安全单测。
2. **批注与切换**：块级 pin、选区浮动入口、`lineRangeForSelection`、`selectedText`、阅读↔源码滚动、dirty/冲突/跨会话状态；可演示：选区创建批注 + pin 打开线程 + 模式切换。
3. **收口**：四档像素/亮暗截图、a11y、浏览器回归、demo 双板截图、包体核对；可演示：交付闸门通过。代码高亮和行级 diff 不在本阶段。
