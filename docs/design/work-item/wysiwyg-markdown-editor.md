# Cowork 工作项：WYSIWYG Markdown 编辑器设计

Status: proposed（2026-11-23）

本文把[工作项多模态交付物查看器设计](work-item-artifact-viewer.md)中「Markdown / PLAN 的阅读与编辑」落成 Typora 式混合单态编辑器设计。页面外壳、保存冲突、批注投递、附件契约沿用[前端方案](work-item-frontend.md)与[后端方案](work-item-backend.md)；本文只拥有**渲染层与当前块源码态**这一件事。决策与取舍见[决策记录](../../../.agents/notes/proposed/feature/2026-11-23-wysiwyg-markdown-editor.md)。

## 背景

当前 `text` 类型有两套互相独立的表面：阅读态是 `source-lines.tsx` + `model.ts` 的逐行「Markdown-ish」渲染（只有标题/列表/引用/行内粗斜体/行内代码，无 GFM 表格/图片/链接/任务列表），源码态是 `editor.tsx` 的 CodeMirror 6 编辑器。用户要的是 Typora 式**单一表面**：块级渲染 + 当前块显示 Markdown 源码，就地编辑，而非「阅读/源码」两态切换。

已确认方向（共同简报决策 1）：表格/图片默认渲染，表格/图片的编辑通过源码或属性面板，不做 Notion 式块级可视化编辑；底层始终是完整 Markdown 源文本，保留 `line-range` anchor 与 quote 重定位。

## 目标

- 一个 CodeMirror 6 `EditorView` 承载整个文档：非活动块渲染，活动块显示原始 Markdown 源码并接受输入。
- 底层文档永远是完整 Markdown 源文本；撤销/重做、自动保存、版本冲突、anchor 重定位都在源文本上发生。
- 标题、列表、任务列表、引用、链接、粗体/斜体/行内代码、围栏代码块、表格、图片全部渲染；原始 HTML 在渲染态按字面显示（转义），不解析。
- 行号 gutter 与源码行一一对应；pin/选中环/anchor 序号/行级 diff 底色继续绑定源码行。
- 不引入未净化 `innerHTML`、不引入 `marked`/`mermaid`/`katex`/`DOMPurify`。

## 非目标

- 不做 Notion 式结构化块数据模型；不把 AST/JSON 作为唯一真相。
- 不做 Doc 富文本（TipTap）；Doc/表格/PDF/图片类型已永久移出目标（KI-57），本设计只改 `text` 类型的 Markdown 渲染。
- 不做表格单元格级网格编辑；表格编辑 = 整块切源码或属性面板。
- 不直接采用 `codemirror-markdown-hybrid@1.2.2`（安全与依赖原因，见决策记录 Alternatives）。
- 不改容器外壳（`conversation.view` 标签）、跨会话只读判定、附件 `cowork_artifact_attach`、prompt 折叠；这些是兄弟子任务，本文只引用。

## 渲染层选型

复用 `package.json` 已有的 `@codemirror/state` `6.7.6`、`@codemirror/view` `6.43.15`、`@codemirror/lang-markdown` `6.5.2`、`@codemirror/language` `6.13.1`、`@codemirror/commands` `6.11.1`。**不新增依赖**：GFM 语法（表格/任务列表/删除线/自动链接）由 `@lezer/markdown` 的 `GFM` 扩展提供（当前 `1.8.1`，`@codemirror/lang-markdown` 已 re-export），用于推导块范围与内联范围。**不引入** `marked`、`mermaid`、`katex`、`DOMPurify`、`codemirror-markdown-hybrid`。

渲染只产出 DOM 节点（`document.createElement` / `textContent` / `className`），任何源码片段都不经 `innerHTML` 注入。语法树（`@lezer`）只作为**呈现提示**，不是持久化真相；文件字节始终是真相。

### 两类装饰，都不改变行号地址空间

1. **行级装饰**（`Decoration.line` + 内联 `Decoration.replace`）——标题、列表、任务列表、引用、段落内联。保持「一行源码 = 一行视觉」，行号 1:1。
   - 隐藏块标记：`# `、`## `、`- `/`* `/`1. `、`> `、`- [ ] ` 用零宽替换或 `::before` 圆点/序号呈现。
   - 内联：`**b**`→strong、`*e*`→em、`` `c` ``→code、`[t](https://example.com)`→`<a>`（DOM 节点，`target="_blank" rel="noopener noreferrer"`）。
2. **块级 widget**（`Decoration.replace({ block: true })`）——仅围栏代码块、表格、图片这三种多行原子块。
   - 围栏代码块 → `<pre><code>`（用 `@codemirror/language` 高亮，文本安全）。
   - 表格 → `<table>`（从语法树行重建，不信任源码拼 HTML）。
   - 图片 → `<figure><img>`，`src` 经图片 URL 白名单过滤。
   - Mermaid/其它语言围栏：v1 不渲染成图，作为普通围栏代码块显示源码（可编辑）。

块级 widget 会折叠多条源码行为一条视觉行。因此：

### 块索引与行号映射（anchor 兼容核心）

编辑器维护一个由语法树派生的**块索引**：

```ts
interface MarkdownBlock {
  readonly startLine: number   // 1-based 源码行
  readonly endLine: number
  readonly kind: 'heading' | 'list' | 'task' | 'quote' | 'fence' | 'table' | 'image' | 'paragraph'
  readonly renderedAs: 'line' | 'block'
}
```

- anchor 与 pin 永远存**源码行号**，沿用 `ArtifactAnchor` 的 `line-range` 与服务端 `deriveLineAnchor` / `relocateLineAnchor`（[anchor.ts](../../../src/domains/artifact/anchor.ts)），服务端零改动。
- 文档定位 `scrollIntoView` 与 pin 放置按「源码行 → 块索引 → 视觉位置」换算：落在 `renderedAs:'line'` 块内直接定位行；落在 `renderedAs:'block'` 块内时，不显示行内 pin，改为在该块首行显示 pin 并把该块切到源码态，使 pin 落到真实源码行。
- 每次编辑后 debounce 重算块索引（或按需在保存/锚点重定位时重算）；插入/删除行后，行级 pin 沿用 `editor.tsx` 现有 `anchoredLineMarkers` 的 map-through-changes 机制跟随，最终以服务端 `relocateLineAnchor` 为准。
- **源码行号是 anchor 的唯一地址空间；渲染投影（含块折叠）只是呈现，绝不成为 anchor 的真相。**
- 块级 widget 折叠源码行后，CodeMirror gutter 可能只显示块首行号。这是 PoC 必须验证的显示项：若无法保留块内逐行号，块头显示 `Lx–Ly` 行范围，块内行号灰显或折叠；任何情况下点击 pin 都必须把该块切到源码态，pin 才能落到真实源码行。不得用视觉行号冒充源码行号。

## 页面结构

```text
EditorView（单一 CodeMirror 表面，替换 editor.tsx 的 TextEditor 与 source-lines.tsx 的读态渲染）
├─ 行号 gutter（源码行号 1:1，不变）
├─ 文档内容 = 完整 Markdown 源文本
│  ├─ 非活动块：行级装饰 / 块级 widget 渲染
│  └─ 活动块：原始 Markdown 源码 + @codemirror/lang-markdown 高亮
├─ 行级 pin（.cwi-line-pin，右侧，源码行定位）
├─ 选中环 / 选中行底（.cwi-line[data-selected]）
├─ 行级 diff 底色（.cwi-line[data-diff]，仅在有 diff 数据时）
└─ 当前块源码态：边框 + 背景（.cwi-md-source-block）
```

关键尺寸沿用 `styles.ts`：纸面最大 920px、正文行高阅读态 1.65、gutter 60px、pin 右留 40px；当前块源码态在 `.cwi-md-source-block` 上叠 `1px accent` 边框 + `accent-soft` 底，内缩 2px，不改变行高。

## 状态模型

| 状态 | 触发 | 表现 |
|---|---|---|
| 阅读态 | 打开文档、无活动块 | 全部块渲染，无源码块；单击/方向键移入块 → 当前块源码态 |
| 当前块源码态 | 光标落入某块 | 该块显示 Markdown 源码；其余块保持渲染；`Esc`/点击其它块/`Mod+Enter` 退出 |
| 编辑态（隐性） | 当前块内输入 | 与源码态同体；无独立「编辑」开关，输入即编辑 |
| 只读态 | 跨会话预览 / `editable=false` / 二进制 | 块不进入源码态；点击只选中用于批注；composer 禁用（跨会话见共同简报决策 3） |
| 保存中 | 800ms 防抖后请求中 | 蓝点脉冲，文案「保存中」；源码块可继续输入 |
| 冲突 | `artifact/version-conflict` | 冲突条 + 查看差异/加载最新/保留我的；源码块暂停进入，输入保留在内存草稿 |
| 跨会话只读 | `sessionId !== ownerSessionId` | 顶部 36px 提示条 +「在所属会话打开」；禁用编辑与批注 |
| 错误/缺失文件 | detail/file 失败或 `missing` | 沿用 `panel.tsx` 的 `ViewerPlaceholder` / `RebindFileEntry`；不渲染编辑器 |
| 窄屏 | < 900px | 批注栏改底部抽屉（见 `styles.ts` media）；编辑器正文不被永久压缩 |

活动块是**单一**的：同时最多一个块显示源码；选区跨块时按光标所在块为准。

## 交互流程

### 进入/退出源码块

1. 单击块内渲染区，或方向键移入块 → 该块切源码（光标落在块内对应字符位置）。
2. `Mod+Enter` 显式进入/退出当前块。
3. `Esc`（无选区）退出源码块，焦点回到块首渲染态。
4. 失焦到块外、点击另一块 → 原块重渲染，新块进入源码。
5. 块源码在退出时校验：表格/围栏语法损坏则降级为普通文本行渲染，不阻塞编辑、不丢内容。

### 选中与批注

1. 阅读态下单击选中一行，Shift 点击扩展行范围；右键选中的行/文字弹出「批注」入口（右上角，尽量不遮文字）。
2. 「批注」→ 沿用 `panel.tsx` 的 `annotateRange`：`lineRangeAnnotation` 从源码行取 quote，`deriveLineAnchor` 在服务端补齐 context。
3. 行内 pin 点击 → 打开对应批注会话详情，文档滚动到 anchor 源码行，线程选中环出现（`focusThread`）。
4. 选中文字（字符级选区，非整行）右键批注 → 仍映射到所在行范围；选区原文存入该 `line-range` anchor 的可选 `selectedText`，用于会话/批注详情展示与投递 prompt，不参与 `relocateLineAnchor` 的重定位。无选区时省略该字段。

### 表格 / 图片 / 任务列表 / 代码块 / 链接

- 表格：默认渲染 `<table>`；单击表格块 → 整块切源码（显示 `|…|` 行）；属性面板（v1.1）显示行/列与单元格编辑，编辑结果写回源码。
- 图片：默认渲染 `<figure>`；单击 → 切源码显示 `![alt](https://example.com/a.png)`；alt 缺失时图片块显示占位标题（不伪造 alt 文字）。
- 任务列表：渲染 `[x]/[ ]`；**不可点击勾选**（点击进入源码块改 `[ ]`↔`[x]`）。
- 代码块：渲染 `<pre><code>`；单击 → 切源码编辑代码；v1 不内嵌运行。
- 链接：渲染 `<a target=_blank rel=noopener noreferrer>`；单击不跳转（进入源码态）；`Mod+Click` 打开链接（经外链白名单）。

### 复制粘贴图片/文件

- 在源码块内粘贴剪贴板图片 → 拦截 `paste`，先走 `artifact.upload` 落盘、再走浏览器 `artifact.attach` 发布（source=user），最后插入 `![name](cowork-attachment://<attachmentId>)` 到光标；任一步失败给出可读错误并保留光标，不写入假 URL。
- 拖拽图片/文件到块 → 同上传路径；超出类型/大小/数量上限按 `artifact/upload-invalid` 提示，不静默丢弃。
- 粘贴纯文本 → CodeMirror 默认行为（插入 Markdown 源码）。

### 中文 IME

- 组合输入只发生在源码块内，CodeMirror 6 原生处理 composition；渲染层不在 `compositionstart`→`compositionend` 之间重算块装饰，避免组合中 widget 撕裂。用 `EditorView.inputState.composing` 门控重算。

### 撤销/重做

- `history()` 作用于源码文档；装饰是派生状态（独立 StateField/ViewPlugin），撤销/重做只改变源文本，不把块重渲染写入撤销历史。

### 保存

- 输入 → `onChange`（doc → `editDraft`）→ 800ms 防抖 `saveDraft`（沿用 `panel.tsx`）。
- 手动保存：头部按钮 + `Mod-s`（CM keymap 绑定 `onSaveDraft` + `preventDefault`）。
- 冲突：`artifact/version-conflict` → `setConflict` 停自动保存，冲突条提供三选（沿用 `panel.tsx`）；源码块输入保留在 `PersistedDraft`。

## 数据/接口/契约变化

本编辑器不新增 wire 路由；图片粘贴/发布复用附件设计新增的浏览器 `POST /api/cowork.artifact.attach`（owner: [attachment-pipeline.md](attachment-pipeline.md)），图片读取复用 `artifact.attachment` 与宿主 `/api/file`。渲染层是纯前端；沿用：

- `ArtifactFileResponse.content`（完整源文本）——渲染层唯一输入。
- `ArtifactAnchor` / `CommentEventV1`（[artifact-contract.ts](../../../src/panel/artifact-contract.ts)）——anchor 存源码行；`line-range` 增加可选 `selectedText`（部分文字选区原文，不参与重定位）。
- `artifact.edit` / `artifact.upload` / `artifact.attach` / `artifact.presence`——保存、图片上传/发布、编辑范围上报；`artifact.upload` 仍只落字节，发布走 `artifact.attach`。
- 图片资源解析器：`conversation.view` 槽的 `useSessions` 按 `ownerSessionId` 取 cwd，传给查看器构造项目内绝对路径；取不到 cwd 或不在项目内时显示 alt 占位，不请求宿主文件路由。
- `parseMarkdownBlocks`/`sanitizeImageSrc`/`blockAtLine` 等纯函数仍为客户端新增。

新增仅客户端纯函数（拟，实现在 `src/client/work-item/` 下，React-free 走 `node --test`）：

- `parseMarkdownBlocks(content): MarkdownBlock[]`——从 `@lezer/markdown` 的 `GFM` 扩展语法树推导块索引。
- `blockAtLine(blocks, line): MarkdownBlock | null`——行号 → 块。
- `sanitizeImageSrc(url, allow): string | null`——图片 URL 白名单，失败返回 null。
- `renderedWidgetFor(block, content): Decoration`——块 → 安全 DOM widget。

权限边界不变：编辑写权限沿用 `artifact/edit` 的 `editable` + owner 校验；跨会话只读由 `ownerSessionId` 判定（兄弟子任务）。

## 安全

- **默认转义原始 HTML**：渲染只建 DOM 节点、绝不 `innerHTML`；源码里的 `<script>`/`<img onerror>` 在渲染态按字面字符显示，不解析。
- **外链 `target`/`rel`**：所有 `[text](https://example.com)` 渲染为 `target="_blank" rel="noopener noreferrer"`；`Mod+Click` 打开前过外链白名单（`http`/`https`）。
- **图片 URL 白名单**：只接受三类来源：`http(s)://` 远程图片；`cowork-attachment://<attachmentId>` 已发布附件（解析为 `artifact.attachment` 路由）；项目相对路径（相对 owner session 的 cwd 解析，规范化后必须仍在项目内，再经宿主 `/api/file?path=` 读取，禁止绝对路径、`..` 逃逸、反斜杠和控制字符）。拒绝 `javascript:` / `data:` / `blob:` / `file:` / `vbscript:`。项目相对图片在 v1 只读渲染，不写入 anchor；用户粘贴图片先走 `artifact.upload` + 浏览器 `artifact.attach` 发布，再写入 `cowork-attachment://<attachmentId>`。`data:` 在 Markdown 图片中禁用（与 HTML 预览 CSP 允许 `data:` 不同，本文范围更严）。
- **禁止未净化 innerHTML**：渲染路径、表格重建、代码高亮全部走 `createElement`/`textContent`。
- **Mermaid 不支持**：v1 不把 Mermaid 围栏渲染成图，按代码块显示；若后续引入，必须 `securityLevel:'strict'` 并说明 CSP（`script-src`/`worker-src` 收窄、禁止 `unsafe-eval`），且只接受 `@lezer` 解析出的围栏内容，不接受任意源码。

## 可访问性

- 焦点顺序沿用 `visual-acceptance.md` §7：header tabs → header 操作 → 工具栏 → 文档 → pin/批注栏 → composer → footer。
- 键盘：方向键在块间/行间移动；`Enter` 进入行尾块源码或批注当前行；`Esc` 退出源码块并还焦；`Mod+Enter` 切换块；`Tab` 不劫持（交给宿主焦点环）。
- 当前块源码态设 `role="textbox"` + `aria-multiline="true"` + `aria-label`；活动块用 `aria-current="true"` 或 focus 指示，不依赖颜色表达。
- 屏幕阅读器：渲染态块有隐含文本（textContent），图片 `alt` 缺失时读占位文本，不读 URL。
- `prefers-reduced-motion: reduce`：关闭保存点脉冲/活动脉冲（沿用 `styles.ts` media）。
- 对比度：源码块边框/背景与文字对比达 WCAG AA；pin/选中环状态另有文字或 `aria-label`，颜色不是唯一状态。

## 视觉保真与像素验收

共享基线见[visual-acceptance.md](visual-acceptance.md)（pin、选中环、anchor 序号、附件 chip、评论筛选、活动时长、行级 diff、版本计数、1280/1024/768/390 四档、±2px 关键盒容差）。本文增量项：

| 元素 | 规格 |
|---|---|
| 阅读态正文行宽 | 纸面内左右 padding 24px；等宽字号下约 50–52 字/行（对齐 `visual-acceptance.md` 密度） |
| 标题 h1/h2/h3 | 沿用 `--dsw-font-markdown-h*-*` 宿主 token；h1 块首 padding-top 12px |
| 列表/任务列表 | 圆点/序号 8px 占位；任务 checkbox 14×14 圆角 3px、1px border、只读 |
| 引用 | 左 2px border、padding-left 10px、muted 文字 |
| 表格 | 边框 1px `border-soft`；表头 `surface-muted` 底；单元格 padding 4px 8px；整块圆角 6px |
| 图片 | 最大宽 100%、圆角 8px、1px border；加载失败显示占位块，不显示破图 |
| 代码块 | mono 12px/20px、`surface-muted` 底、圆角 6px、横向可滚动 |
| 当前块源码态 | 1px accent 边框 + accent-soft 底，内缩 2px；`.cm-content` 字号 13px/22px mono |
| 行号 gutter | 60px；源码行号 10.5px mono；折叠块首行号高亮，其余折叠行号灰显 |
| 行级 diff 底色 | 数据依赖 `changedLineRanges`/版本快照；无 diff 数据不伪造（沿用 `visual-acceptance.md` §5.7） |
| 保存状态 | 已保存绿点 `已保存 · rN` / 保存中蓝点脉冲 / 冲突红点（沿用 `styles.ts` `.cwi-save`） |
| 附件 chip / 版本计数 / 活动时长 | 沿用 `visual-acceptance.md` §5.4/5.8/5.6 |

四档验收（1280/1024/768/390）：阅读态块渲染完整、当前块源码态边框/背景可见、行号不漂移、无横向滚动、窄屏批注栏抽屉不遮 composer。

## Demo

- [交互稿](assets/wysiwyg-editor-demo.html)（单板：阅读态 + 当前块源码 + 表格 + 图片 + 代码块 + 任务列表 + 引用 + 链接 + pin/选中环 + 保存状态 + 附件 chip + 版本计数 + 冲突条；跨会话只读态由主区 View demo 覆盖）
- 截图：[wysiwyg-editor-demo.png](assets/wysiwyg-editor-demo.png)（headless Chrome 实际生成，2560×1800；已用 Playwright 核对 16 个必需状态渲染、尺寸与非空白；队长已用 read_image 目检缩略图并通过，像素级 ±2px 需实现期截图比对）

## 测试与验收

| 层 | 检查 | 哪个会红 |
|---|---|---|
| 单测（`node --test`） | `parseMarkdownBlocks` 块范围、`sanitizeImageSrc` 白名单、`blockAtLine`、`renderedWidgetFor` 不产 innerHTML | 安全转义/白名单/块索引错误 → `tests/domains/artifact/*` 或新增 `tests/client/*` 红 |
| 单测 | anchor 重定位、插入/删除行后行号映射、无法定位 stale | 复用/扩展 `tests/domains/artifact/anchor.test.mjs` 红 |
| 浏览器（`npm run test:browser`） | 点击块进源码、IME 组合不撕裂、撤销重做、`Mod-s` 保存、键盘进出块、Esc | 交互回归 → 浏览器 lane 红 |
| 浏览器 | 自动保存/冲突三选、跨会话只读禁用 | `tests/client/work-item/*` + `test:browser` 红 |
| 真实宿主 | 图片粘贴上传 → 附件引用 → 渲染；保存 → anchor 重定位 | `test:host-smoke` / 真机 E2E |
| 截图 | 四档宽度 + 亮暗各一，`±2px` 关键盒 | 交付闸门 `delivery_check` page-verify + `dev_visual_check` |

明确会红的安全项：原始 HTML 注入（`<img onerror>` 在渲染态只显示字面文本）、`javascript:` 图片被拒、未净化 `innerHTML` 在渲染路径不存在（静态 + 单测双保险）。

## 风险、未核实、降级/回滚

- **GFM 块范围解析精度**：`@lezer/markdown` 的 `GFM` 扩展已在本仓库 `node_modules`（`1.8.1`）确认存在，但表格/任务列表的块范围能否稳定落到源码行、嵌套列表边界是否正确，需实现期用真实文档逐档核对；退化方案是沿用现有 `model.ts` 的手写 GFM 探测，不降低安全要求。
- **块折叠与行号对齐**：块级 widget 折叠源码行是最大实现风险；已用「源码行 = anchor 地址空间 + 块索引换算」缓解，但视觉行高与源码行不一致需在浏览器 lane 逐档核对。
- **IME 与装饰重算**：组合中重算导致输入点跳动是已知 CM6 混合编辑器风险；用 `composing` 门控，需真实宿主验证中文长句。
- **性能**：大文件（>2 MB）不整篇进 DOM；块索引按需/防抖重算；超阈值降级为只读逐行（沿用 `MAX_ARTIFACT_TEXT_BYTES`）。
- **回滚**：渲染层是 `editor.tsx`/`source-lines.tsx` 的替换实现，不删旧路径前保持可切回；旧「阅读/源码」两态可降级保留为逃生门。
- **未核实**：`conversation.view` 标签容器（兄弟子任务）与编辑器的焦点/滚动交互；跨会话只读判定字段的最终形态；`artifact.upload` 粘贴图片的真实宿主行为。
