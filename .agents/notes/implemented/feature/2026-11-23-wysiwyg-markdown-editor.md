# Decision: Typora 风格 Markdown 阅读与批注（markdown-it 阅读 + CM6 源码）

Status: implemented
Date: 2026-11-23
Class: feature

## Problem

工作项 `text` 类型的阅读态是 `source-lines.tsx` + `model.ts` 的逐行「Markdown-ish」渲染：只有标题、列表、引用和行内粗斜体/代码，没有 GFM 表格、图片、链接、任务列表和完整代码块。用户要求阅读态达到 Typora 级别的流式排版，同时保留 `line-range` anchor、批注和源码编辑。

2026-11-23 用本机可运行的 `~/Obsidian/DwKnowledge/DwKnowledge/Kanban/note.html` 核实：markdown-it 渲染 + CM6 源码编辑的阅读观感成立，选区浮动入口也可用；但该实例的 `md.render` + `innerHTML`、`==[标签]` 写回源文件、`indexOf` 定位、Obsidian 语法和无行级 anchor 都不能照搬。用户据此改选两态方案：阅读态负责阅读和批注，源码态负责行级精确编辑。

## Decision

`text` 类型采用两态方案，替换逐行阅读渲染：

- **阅读态**：`markdown-it.parse`（`html:false`、`linkify:true`、`breaks:false`）→ token → React/DOM，不经过 `innerHTML`；渲染标题、段落、列表、任务列表、引用、链接、图片、行内代码、围栏代码块、GFM 表格、分割线和 frontmatter 折叠块。原始 HTML 按字面显示。
- **源码态**：沿用 `editor.tsx` 的 CodeMirror 6 编辑器、行号、anchor 行标记、撤销/重做、保存和冲突路径。Markdown 的源码态就是编辑器；阅读↔源码切换按顶部块/行滚动，且不重载文件、不重置草稿、不触发保存。
- **块索引**：`viewers/markdown.ts` 由 token map 生成 `MarkdownBlock[]`（startLine/endLine/kind），`blockAtLine` 把 anchor 行映射到阅读态块；pin 落在块首行右侧，阅读态不设行号 gutter。
- **批注**：现有线程的 `line-range` anchor 不变；阅读态显示块级 pin；选中文字后出现浮动「批注」入口，按块范围 + 去标记文本唯一匹配生成行范围，失败回退整块范围；`selectedText` 随 anchor 保存，只用于展示与投递 prompt，不参与 `relocateLineAnchor`。
- **模式切换**：工具条「阅读/源码」保留；未保存草稿在阅读态渲染 draft，但 pin 与新建批注停在「保存后可批注」。
- **安全**：外链只允许 `http(s)` 并带 `rel="noopener noreferrer"`；图片白名单为 `http(s)`、`cowork-attachment://<id>`、项目内相对路径；拒绝 `javascript:`/`data:`/`blob:`/`file:`/`vbscript:`/绝对路径/`..` 逃逸；markdown-it 默认放行 `data:image`，渲染前由白名单覆盖；表格对齐只接受 left/center/right；不引入 `marked`/`mermaid`/`katex`/`DOMPurify`。
- **依赖**：固定 `markdown-it@15.0.3`（MIT），由 `scripts/build/build-client.mjs` 的 esbuild 内联进客户端闭包；不新增 wire 路由，渲染只消费 `ArtifactFileResponse.content`。
- **视觉**：正文 15px/1.75、纸面 920px、阅读区 padding 28/40/24/40、h1 30/39、h2 21/28.35、h3 17.25/24.15；代码块 v1 纯文本；像素规格与响应式差异由[设计文档](../../../../docs/design/work-item/wysiwyg-markdown-editor.md)拥有。

## Alternatives considered

**单表面 CodeMirror 6 hybrid（原提案，否决）。** 它的收益是「当前块就地显示源码」，代价是放弃流式段落重排：为了行号 1:1，源码换行必须保持视觉换行，标题/表格/图片只能做行级装饰或块 widget；块折叠后 gutter 行号、pin 定位、IME 组合和活动块状态机都要自写。对「阅读质量优先、批注可在源码态精确到行」的目标，这个代价不划算。只有未来把「单表面就地编辑」重新列为硬需求时才重新评估。

**参考实现 `note.html` 原样采用（否决）。** 它用 `md.render` 写 `innerHTML`，批注靠 `==[标签]` 写回源文件并用 `indexOf` 定位，文字重复或含 Markdown 标记时会拒绝；没有行级 anchor、评论线程和 Cowork 的投递闭环。它的阅读排版可借鉴，安全、批注和 Obsidian 语法不可照搬。

**TipTap / ProseMirror 所见即所得（否决）。** 真相是 ProseMirror 文档（AST/JSON），与完整 Markdown 源文本、行号 anchor 和 quote 重定位冲突；往返序列化会破坏空白/缩进/围栏字节。富文本是 Doc 类型，已按 KI-57 移出目标。

**`codemirror-markdown-hybrid@1.2.2` fork 后净化（否决）。** 该包用 `marked` 输出直写 `innerHTML`，Mermaid `securityLevel:'loose'`，依赖树含 mermaid/katex/多个 CM 语言包；表格/任务列表是逐行启发式，不是整文档解析。fork 等于重写并长期追上游安全补丁。

**markdown-it + contenteditable 就地编辑（未采用）。** 它会变成另一套富文本编辑器，源文本保真、行号 anchor 和撤销/保存都要重做，且无法保证 Markdown 字节不变；不满足本工作项的行级锚点契约。

## Consequences

- 阅读态是流式 DOM，`line-range` anchor 仍是唯一地址空间；块索引只服务呈现与 pin 定位，不持久化。
- token map 只到块：表格单元格和 inline 子 token 没有源码行，单元格级批注不在本次范围。
- 选区行范围是启发式：去标记文本唯一命中时精确到行，重复/复杂行内格式回退整块；`selectedText` 仍准确，行范围可能比选区宽。
- frontmatter v1 只按首尾 `---` 拆分，不解析 YAML；frontmatter 内 anchor 不显示 pin。
- 大文件（>2 MB 或 20k 行）降级为编号源码视图并提示，不做无界 DOM。
- 项目内相对图片没有读取路由：白名单接受该写法，但渲染为「图片地址不可用」占位，不发伪造请求；`cowork-attachment://<id>` 走现有附件路由，`http(s)` 直连（失败显示虚线占位）。
- 代码块 v1 无语法高亮；高亮是后续独立变更。
- 旧 `source-lines.tsx` 的逐行渲染保留为非文本类型的源码面和 Markdown 降级路径；anchor、保存、批注、附件契约不变，回滚只需删阅读渲染路径。

## Testing

- [A1] 阅读态渲染标题、段落、列表、任务列表、引用、链接、图片、行内代码、围栏代码块、GFM 表格、分割线和 frontmatter；原始 HTML 按字面显示 — `tests`、`browser`。
- [A2] 渲染路径不存在 `innerHTML`/`dangerouslySetInnerHTML`；`javascript:` 链接、`data:` 图片、`<img onerror>` 原始 HTML 均被拒/转义；外链带 `rel` — `tests`、`browser`。
- [A3] token map 推导的块索引正确；`blockAtLine` 与 `lineRangeForSelection` 的单块/重复/跨块回退有单测；`line-range` anchor 仍由 `deriveLineAnchor`/`relocateLineAnchor` 处理 — `tests`。
- [A4] 阅读态选中文字出现浮动「批注」入口；创建含 `selectedText` 的 `line-range` anchor；pin 打开对应线程；dirty/冲突时 pin 与批注禁用 — `browser`。
- [A5] 阅读↔源码切换按块/行滚动且不丢 draft；源码态保存、冲突三选、跨会话只读保持 — `browser`。
- [A6] 1280/1024/768/390 四档无页面横向滚动；亮/暗主题可读 — `browser`（逐像素截图由交付闸门核对）。
- [A7] 不新增 wire 路由；图片读取复用附件路由；`selectedText` 只扩展 anchor 字段 — `source`、`tests`。
- [A8] 大文件（2 MB/20k 行）降级源码态，不阻塞编辑；frontmatter 偏移与不可批注行为有测试 — `tests`、`browser`。
