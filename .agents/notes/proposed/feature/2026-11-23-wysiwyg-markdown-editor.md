# Proposal: Typora 式混合单态 Markdown 编辑器（安全自研 CodeMirror 6 hybrid）

Status: proposed
Date: 2026-11-23
Class: feature

## Problem

工作项 `text` 类型当前是两套表面：阅读态 `source-lines.tsx` + `model.ts` 只做逐行「Markdown-ish」渲染（无 GFM 表格/图片/链接/任务列表），源码态是 `editor.tsx` 的 CodeMirror 6。用户要求 Typora 式单表面——块级渲染 + 当前块显示 Markdown 源码并就地编辑，同时底层始终是完整 Markdown 源文本，以保住 `line-range` anchor 与 quote 重定位。现有「阅读/源码」两态切换不能满足这个目标，而现成的 `codemirror-markdown-hybrid@1.2.2` 存在未净化 `innerHTML`、Mermaid `securityLevel:'loose'` 和巨大依赖（mermaid + katex + 5 个 CM 语言包），不能直接采用。

## Proposal

新增一个 CodeMirror 6 `EditorView` 作为 `text` 类型的唯一表面（替换 `editor.tsx` 与 `source-lines.tsx` 的读态渲染）：

- 文档 = 完整 Markdown 源文本，是唯一持久化真相；撤销/重做、自动保存、冲突、anchor 重定位都在源文本上发生。
- 非活动块用 `Decoration.line` + 内联 `Decoration.replace` 渲染；围栏代码块/表格/图片用 `Decoration.replace({ block: true })` 渲染。
- 活动块（光标所在块）显示原始 Markdown 源码并接受输入；`Esc`/`Mod+Enter`/点击其它块切换。
- 渲染只用 `document.createElement` / `textContent`，任何源码片段不经 `innerHTML`；原始 HTML 按字面转义显示。
- 语法树用 `@lezer/markdown` 的 `GFM` 扩展（`@codemirror/lang-markdown` 已 re-export，无新依赖）推导块范围，作为呈现提示，不是真相。
- anchor 与 pin 永远存源码行号（沿用 `ArtifactAnchor` + `deriveLineAnchor`/`relocateLineAnchor`）；新增块索引 `MarkdownBlock[]` 做「源码行 → 视觉位置」换算；服务端零改动。
- 表格/图片默认渲染，编辑通过整块切源码或属性面板（表格属性面板 v1.1）。
- 安全：外链 `target=_blank rel=noopener noreferrer`；图片 URL 白名单仅 `http(s)://`、`cowork-attachment://<id>` 已发布附件、以及项目内相对路径（相对 owner session cwd 解析、规范化后仍在项目内、经宿主 `/api/file` 读取）；拒绝 `javascript:`/`data:`/`blob:`/`file:`/绝对路径/`..` 逃逸；不引入 `marked`/`mermaid`/`katex`/`DOMPurify`。

设计文档见[WYSIWYG Markdown 编辑器](../../../../docs/design/work-item/wysiwyg-markdown-editor.md)。

## Alternatives considered

**安全自研 CodeMirror 6 hybrid（采用）。** 复用仓库已有 `@codemirror/*` 与 `@lezer/markdown` 依赖（GFM 扩展现成，无新依赖）；渲染层可审计、DOM 安全、行号与 anchor 语义完全受控。代价是要自写块解析/装饰/活动块状态机。

**`codemirror-markdown-hybrid@1.2.2` fork 后净化（否决）。** 该包 `lib/utils/markdown.js` 用 `marked`（`gfm:true`、无 sanitizer）且输出直写 `innerHTML`（`hybrid-preview.js:143/300/635/686/730/939`），Mermaid `securityLevel:'loose'`（`:115`），还直接 `innerHTML` 注入 Mermaid 错误消息（`:688`）；依赖树含 `mermaid@11`（dist 24 MB，mermaid-parser.core 507 KB、cytoscape 637 KB）、`katex`、5 个 CM 语言包；表格/任务列表是逐行启发式（`markdown.js:119-151`），不是整文档解析。要 fork 就得删掉 marked/mermaid/katex、把渲染全部改成 DOM 安全、维护 1609 行插件 + 四套主题 + keymaps，等于重写，还得长期追上游安全补丁。不划算。

**TipTap / ProseMirror 所见即所得（否决）。** 它的真相是 ProseMirror 文档（AST/JSON），与「Markdown 源文本保真 + 行号 + anchor 重定位」冲突；往返序列化会破坏空白/缩进/围栏精确字节，行号 anchor 无法稳定存活。且富文本是 Doc 类型，已永久移出目标（KI-57）。仅当未来需要真正富文本块级编辑时再评估。

**两态预览（阅读/源码切换，现状）（否决）。** 现有实现无法「当前块就地显示源码」；表格/图片/链接/任务列表无 GFM 渲染。保留为逃生门降级路径，不作为目标。

## Acceptance criteria

- [A1] 渲染路径不存在未净化 `innerHTML`；原始 HTML 按字面转义显示 — `source`（静态检查 + 单测）
- [A2] 图片 `src` 拒绝 `javascript:`/`data:`/`blob:`/`file:`，外链带 `rel=noopener noreferrer` — `tests`（`sanitizeImageSrc` 单测）
- [A3] `line-range` anchor 始终存源码行号；插入/删除行后 `relocateLineAnchor` 重定位、失败标 `stale` — `tests`（`tests/domains/artifact/anchor.test.mjs`）
- [A4] 点击块进入源码、`Esc`/`Mod+Enter` 退出、IME 组合不撕裂、撤销/重做只动源文本 — `browser`（`npm run test:browser`）
- [A5] 自动保存 800ms 防抖 + `Mod-s` 手动保存 + 冲突三选停保存 — `browser`（复用 `panel.tsx` 保存路径）
- [A6] 1280/1024/768/390 四档无横向滚动、当前块源码态边框/背景可见、行号不漂移 — `browser` + 截图交付闸门
- [A7] 编辑器不新增 wire 路由；图片发布复用附件设计的浏览器 `artifact.attach`，图片读取复用 `artifact.attachment` 与宿主 `/api/file` — `source`（`tests/support/public-surface.mjs` 只增加附件路由，不增加编辑器路由）

## Risks

- `@lezer/markdown` 的 `GFM` 扩展已在 `node_modules`（`1.8.1`）确认，但表格/任务列表块范围的实现期精度待逐档核对；不可靠则退化为手写 GFM 探测，不降低安全要求。
- 块级 widget 折叠源码行造成视觉行号与源码行不一致，是最主要的实现/验收风险；以「源码行 = anchor 地址空间 + 块索引换算」缓解，仍需逐档核对。
- IME 组合中装饰重算导致光标跳动是 CM6 混合编辑器已知风险；用 `composing` 门控，真实宿主验证中文长句。
- 大文件性能：>2 MB 降级只读逐行。条件：若用户反馈大文档编辑卡顿，重新评估虚拟化或分页渲染。

## Delivery stages

1. 块解析与安全渲染内核：`parseMarkdownBlocks` + `sanitizeImageSrc` + 行级/块级装饰；阅读态覆盖标题/列表/任务/引用/内联/围栏/表格/图片/链接。可演示：只读渲染 + 行号不漂移。
2. 活动块源码态与编辑：单击/方向键/Esc/Mod+Enter、IME、撤销重做、粘贴图片上传、`Mod-s` 手动保存；复用现有自动保存与冲突。可演示：就地编辑 + 保存 + 冲突。
3. 批注联动与收口：pin/选中环/anchor 序号落到源码行、块折叠内 pin 强制切源码、窄屏/键盘/截图验收、包体核对。
