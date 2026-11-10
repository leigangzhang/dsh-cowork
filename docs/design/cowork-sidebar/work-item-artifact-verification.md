# 工作项交付物：V1–V16 核实报告

Status: verification（2026-11-10；开发前核实，结论见文末门禁）

## 范围与方法

核对对象是[多类型文件嵌入研究](work-item-artifact-embedding-research.md)里的 V1–V16。方法分三类：

- **源码核对**：DSH 源码 checkout（`~/Workspace/deepseek-harness`）和本仓库源码，确认 API、事件、工具名和限制条件。
- **依赖核对**：在 `/tmp` 建独立目录安装候选包，用 esbuild 打包称重，跑最小的读写/渲染脚本；不修改本仓库依赖。
- **浏览器核对**：用本机 headless Chromium 打开 Excalidraw 测试页，确认挂载、元素和字体资源。

环境：macOS，Node 22.22.0，npm 12.x，esbuild 0.28.2，headless Chromium（Playwright 缓存）。依赖版本以实际安装为准。

## 结论摘要

| id | 结论 | 关键结果 |
|---|---|---|
| V1 | 部分确认 | Excalidraw 能挂载、能出图；JS 8.3 MB min（gzip 2.55 MB），CSS 141 KB，字体 13 MB（Xiaolai 中文字体）。Excalidraw 资源带全部字体时约 15 MB，超过 10 MB 上限；去掉 Xiaolai 后约 2.9 MB。`EXCALIDRAW_ASSET_PATH` 必须是绝对 URL |
| V2 | 确认 | `convertToExcalidrawElements`、`getSceneElements`、`updateScene`、`serializeAsJSON` 都在公开类型/导出里；画布元素级工具可行 |
| V3 | 部分确认 | 挂载和 `onChange` 回调已确认；自动保存、版本校验、整文件锁属于插件逻辑，尚未原型 |
| V4 | 确认，有缺口 | `write`、`edit`、`str_replace_editor` 都能被 `tools.guard` 拦截，拒绝以 `Error: 原因` 返回；`bash` 仍可绕过 |
| V5 | 部分确认 | `fs.writeText` 的 `replaceIfVersion` 和 `editText` 的版本守卫存在；三方合并和编辑范围上报需要实现原型 |
| V6 | 确认 | TipTap + 表格扩展 460 KB min（gzip 146 KB）；标题、粗斜体、列表、表格往返通过；表格扩展不在 StarterKit 里，必须单独安装 |
| V7 | 确认 | read/write-excel-file 多工作表读写通过；浏览器打包 123 KB min（gzip 34 KB）；只处理值，不保留公式和样式 |
| V8 | 确认 | Pele 六类图打包 301 KB min（gzip 114 KB）；流程图、时序、ER、类、状态、架构图都能渲染；标签会转义 |
| V9 | 确认 | CodeMirror 行号+Markdown 子集 520 KB min（gzip 179 KB）；最小行号编辑器 277 KB（gzip 90 KB） |
| V10 | 部分确认 | 连接层支持逐块写出响应；浏览器认证是 HttpOnly + SameSite=Strict 的同源 cookie；EventSource 真实宿主 E2E 未跑 |
| V11 | 部分确认 | 同一会话用 `followup` 排队，会话互不共享队列；待处理输入有持久化 inbox；跨会话并行和重启恢复需要真机 E2E |
| V12 | 部分确认 | 核心依赖合计约 2.4 MB min；Excalidraw 另加约 10.7 MB min（JS+CSS+非中文字体）；包体是否超限取决于字体策略 |
| V13 | 确认（否定） | 没找到 ProcessOn 私有嵌入方式；网页嵌入依赖公开分享；只做手动导入导出 |
| V14 | 部分确认、后置 | 宿主 PDF 预览已用 pdfjs 的 TextLayerBuilder 和页面 viewport，页内区域批注可行；本版本不做 |
| V15 | 部分确认 | 图片消息和附件存储 API 确认；模型是否调用回复工具必须在实现期跑真实模型 E2E |
| V16 | 确认 | `docx/html` 的 `htmlToContent` 能读富文本 HTML；HTML→docx→HTML 往返保留标题、粗斜体、列表、表格 |

## 详细结果

### V1 Excalidraw 打包与资源

- 包：`@excalidraw/excalidraw@0.18.1`，MIT，peer React 17/18/19；React 18.3.1 可用。
- CJS 打包（React external、Excalidraw 全部依赖内联）：**8,303,368 B**，`require("react")` 保留。
- 分包打包：入口 **589,468 B**，全部 chunk **8,194,431 B**；所有 JS gzip 合计 **2,551,983 B**。
- CSS：`dist/prod/index.css` 141 KB，gzip 22.9 KB。
- 字体：`dist/prod/fonts` 共 13 MB，其中 `Xiaolai`（中文字体）13 MB，其余字体约 0.5 MB。
- 压缩包估算：JS chunk + CSS + 全部字体约 **15 MB**；去掉 `Xiaolai` 后约 **2.9 MB**。
- 浏览器测试：页面能挂载 Excalidraw，矩形、箭头和中文文本都能渲染。`EXCALIDRAW_ASSET_PATH` 必须写成绝对 URL（如 `http://127.0.0.1:8767/node_modules/.../dist/prod/`）；相对路径在出现文本元素时报 `TypeError: Failed to construct 'URL': Invalid base URL`。
- 去掉 `Xiaolai` 后页面和默认字体下的中文文本仍能渲染（回退），但“手动选择 Xiaolai”时的表现未验证。

结论：技术上可行，但中文字体资源的包体是硬约束。推荐做法：

1. Excalidraw 作为**懒加载 chunk**，不进入首屏主包。
2. **不随包携带 Xiaolai**，中文走系统字体回退；需要手写中文字体时提供可选字体包。
3. 字体和 CSS 通过插件的同源授权路由提供，`EXCALIDRAW_ASSET_PATH` 指向该路由的绝对 URL。
4. 若必须携带完整 Xiaolai，包体会到 15 MB 左右，超过当前 10 MB 上限，需要放宽上限或把画布拆成独立可选包。

### V2 画布场景与元素级工具

- 公开的 imperative API 在 `@excalidraw/excalidraw/dist/types/excalidraw/types.d.ts:603-635`：`updateScene`、`getSceneElements`、`getSceneElementsIncludingDeleted`、`onChange`、`addFiles`、`setActiveTool`、`scrollToContent` 等。
- 根入口导出 `convertToExcalidrawElements`、`exportToSvg`、`serializeAsJSON`、`restore`、`restoreElements` 等（`dist/prod/index.js` 的 export 列表）。
- 浏览器里用 `convertToExcalidrawElements` 生成矩形（带中文 label）、箭头和文本，渲染通过。

结论：元素级模型工具可行。建议工具面：读取场景、按 id 增加/修改/删除元素、改文字/颜色/位置、保存后递增版本；不直接让模型改整份 JSON。场景格式兼容性要在实现期用真实元素语料回归。

### V3 自动保存、版本与整文件锁

- `onChange` 回调提供当前 elements、appState、files；适合做 800ms 防抖保存。
- 版本、锁和冲突合并是插件自己的逻辑，不是 Excalidraw 内建；本次没有做真实编辑的保存/锁原型。

结论：API 够用；自动保存、版本校验、整文件锁需要在实现期用真实浏览器跑一次“用户编辑→模型等待→保存→模型改元素”的流程。

### V4 工具守卫覆盖写文件工具

- 工具名和参数：
  - `write`：`packages/fs/tool-fs/src/write.ts:73`，参数 `file_path`、`content`，整篇覆盖。
  - `edit`：`packages/fs/tool-fs/src/edit.ts:85`，参数 `file_path`、`old_string`、`new_string`、`replace_all`。
  - `str_replace_editor`：`packages/fs/tool-str-replace-editor/src/index.ts:430`，命令 `create` / `str_replace` / `insert`。
- `tools.guard` 类型和注册：`packages/core/tools/src/index.ts:731`、`:1136`；执行上下文带 `name`、`arguments`、`agent`（`:326-352`、`:393-398`）。
- 拒绝结果：`packages/core/tools/src/index.ts:1519-1530`，返回 `Error: <reason>`，`isError: true`，模型能看到原因。
- 工作项相关的主题会话确实有 `tool-fs` 和 `tool-bash`（`src/presets.ts` 的 `topicRows`）；master 没有 `tool-fs`，reviewer 没有 `tool-fs`、只有 bash。
- 缺口：topic 的 `tool-bash` 可以改文件，`tools.guard` 看不到 bash 内部的写入。第一版只能在提示词里要求用 `edit`/`write`，并在文件变化后做冲突/范围校验，不能完全阻止 bash 绕过。

结论：同行锁能用 `tools.guard` 对 `write`、`edit`、`str_replace_editor` 落地；bash 是残余风险，需要在实现期决定是否对主题会话收紧 bash 或增加写入后的二次校验。

### V5 编辑范围上报与三方合并

- `fs.writeText` 支持 `{ kind: 'replaceIfVersion', version }`（`packages/fs/fs/src/types.ts:123-126`）；`fs.editText` 支持 `expected.version`（`:147-154`）。
- 编辑范围从 CodeMirror transaction 的 changes 取行区间是可行路径；当前仓库没有三方合并实现。
- 本次只做源码核对，没有合并算法原型；重叠判定、误报和冲突 UI 需要在实现期验证。

结论：基础写入守卫可用；三方合并和范围上报属于实现期验证项，不是外部依赖风险。

### V6 TipTap 与 HTML 往返

- 依赖版本：`@tiptap/react`、`@tiptap/starter-kit`、`@tiptap/pm` 均为 3.33.0；表格扩展安装到 `@tiptap/extension-table@3.33.0`、`extension-table-cell@3.33.0`、`extension-table-header@3.33.0`，但 `extension-table-row` 解析到 3.32.3，peer 要 `@tiptap/pm@3.32.3`，需要 `--legacy-peer-deps` 才能装。**正式依赖必须把所有 @tiptap 包锁到同一版本。**
- 体积（React external，esbuild min）：不含表格 412,521 B（gzip 130,987）；含表格 459,857 B（gzip 145,735）。
- 往返测试（happy-dom + `@tiptap/html`）：标题、粗体/斜体、列表、表格都保留。不含表格扩展时，`<table>` 被压成纯文本，所以 Doc 必须带表格扩展。
- 输出会在列表项和单元格里加 `<p>`，表格带 `colgroup` 和 `min-width` 样式；`docx/html` 能接受。

结论：Doc 方案可行，但依赖要整体锁版本，并且明确启用表格扩展。

### V7 表格库

- `read-excel-file@9.3.14`、`write-excel-file@4.1.1`，均 MIT。
- 多工作表写入和读取通过：写入 2 个工作表，默认读取返回全部工作表；`readSheet(file, { sheet: '字段' })` 可读指定表。
- 浏览器打包（读 + 写）122,598 B min（gzip 33,627）。
- 只处理单元格值；不保留公式、样式、合并单元格。筛选和排序是自建网格的视图逻辑，库不提供，也不需要。

结论：满足“查看、编辑、筛选、排序”的基础表格；xlsx 作为交换格式够用。

### V8 Pele

- `pele@1.13.0`，MIT，无运行时依赖。
- 全量入口 716,212 B min（gzip 268,055）；按类型注册六类（流程图、时序、ER、类、状态、架构）301,494 B min（gzip 113,561）。
- 六类样例全部渲染成 SVG；架构图需要正确语法（`service api(server)[API]` + `api:R --> L:db`）。
- 标签中的 `<script>`、`onerror` 被转义；`javascript:` 字符串作为文本出现，不构成脚本执行。
- Pele 的 `render` 在 Node 里可直接用，不依赖 DOM；`mount` 需要 DOM。

结论：图表渲染方案可行，六类图体积可控；建议在实现期补一份模型常写语法与 Pele 的兼容语料。

### V9 CodeMirror

- 依赖：`@codemirror/state@6.7.6`、`@codemirror/view@6.43.15`、`@codemirror/language@6.13.1`、`@codemirror/commands@6.11.1`、`@codemirror/lang-markdown@6.5.2`。
- 行号 + Markdown + 语法高亮 + 括号匹配 + 历史 + 键位：519,531 B min（gzip 178,846）。
- 只保留行号 + 历史 + 键位：277,478 B min（gzip 90,239）。
- 没有做浏览器交互测试；构建产物正常，无 Node 内置依赖。

结论：在 5 MB 客户端预算内，可按需选子集。

### V10 SSE/EventSource

- 连接层把 `Response.body` 逐块写给 HTTP 响应（`packages/client/connection/src/http-bridge.ts:103`）。
- 浏览器认证是签名 cookie：`HttpOnly; SameSite=Strict; Path=/`（`packages/client/connection/src/browser-auth.ts:120-123`），`isAuthenticated` 校验 Host 绑定和过期（`:287-300`）。
- 连接层 exact Fetch 路由会经过 Host/Origin 和浏览器认证（`packages/client/connection/src/rpc-host.ts:96-100`）。
- EventSource 同源请求会自动携带 cookie；真实宿主上的 SSE 认证、心跳、`Last-Event-ID` 续传还没跑。

结论：传输层可行；实现期先做一个最小 SSE 路由，在真实 GUI 里验证认证和断线重连。

### V11 会话并发与恢复

- `sessionController.prompt` 的 `mode: 'queue'` 走 `agent.followup`，`steer` 走 `agent.steer`（`packages/api/session-controller/src/commands.ts:364-366`）。
- 每个 Agent 有独立 inbox；待处理输入从持久化 inbox 重建（`packages/core/agent/src/types.ts:42-65`）。
- 同一会话按 inbox 队列串行；不同会话是不同 Agent，没有共享队列。
- 本次没有启动真实宿主做“两个会话同时投递”的 E2E；模型提供方限流、宿主重启后的投递恢复也还没有实测。

结论：并发模型和设计一致；实现期必须补“双主题并行投递 + 一个失败 + 重启恢复”的端到端验证。

### V12 包体

按本次实测的 min 体积（React external，不含 sourcemap）：

| 部分 | min | gzip |
|---|---|---|
| CodeMirror（Markdown 子集） | 520 KB | 179 KB |
| TipTap（含表格） | 460 KB | 146 KB |
| Pele（六类图） | 301 KB | 114 KB |
| read/write-excel-file | 123 KB | 34 KB |
| docx + mammoth | 906 KB | 275 KB |
| 现有客户端 | 96 KB | 约 30 KB |
| **核心合计（不含 Excalidraw）** | **约 2.4 MB** | **约 0.78 MB** |
| Excalidraw JS（全部 chunk） | 8.19 MB | 2.55 MB |
| Excalidraw CSS | 141 KB | 23 KB |
| Excalidraw 非中文字体 | 约 0.5 MB | 约 0.5 MB |
| Excalidraw 中文字体 Xiaolai | 13 MB | 13 MB |
| **含 Excalidraw、去掉中文字体** | **约 11 MB** | **约 3.9 MB** |
| **含 Excalidraw 和中文字体** | **约 24 MB** | **约 17 MB** |

- 若“客户端 5 MB”指下载体积（gzip）：核心约 0.8 MB，Excalidraw 懒加载后另约 2.6 MB，总量约 3.4 MB，可接受。
- 若指磁盘上的 min 产物：核心 2.4 MB，Excalidraw 后约 11 MB，超过 5 MB。
- 包体按压缩 tar 估算：去掉 Xiaolai 的 Excalidraw 资源约 2.9 MB，核心约 1 MB 级，总计约 4 MB；带 Xiaolai 约 17 MB，超过 10 MB。

结论：核心方案在预算内；Excalidraw 的包体取决于中文字体策略。推荐“Excalidraw 懒加载 + 不带 Xiaolai 字体”，把首屏客户端控制在 5 MB 以内，包体控制在 10 MB 以内。

### V13 ProcessOn

- 搜索到的公开资料一致说明：网页嵌入需要先把文件设为公开分享，再拿 `/embed/` 开头的 iframe 链接；未公开分享会显示无权访问。
- 没有找到官方私有部署或本地嵌入方式；找到的 ProcessOn 相关 API/MCP 是“生成思维导图”一类的能力，不是画布嵌入。
- 结论：不接受把项目资料公开到第三方云端；只做手动导出/导入，不集成登录、云同步或 iframe。

### V14 PDF 页内批注

- 宿主文档预览已经用 `pdfjs-dist` 的 `TextLayerBuilder` 和 `PageViewport` 渲染文本层（`packages/client/ui-sidebar-documentpreview/src/client/pdf/text.ts:2-30`），页内坐标和选区是现成能力。
- 叠加批注可用 `pdf-lib` 画矩形/文本；本版本不做，作为后续项。
- 结论：技术可行，但不是第一版交付；PDF 第一版保持“查看 + 整体/按页评论”。

### V15 模型回复工具与多模态

- 会话 prompt 支持 `image` content part（`packages/api/session-controller/src/types.ts:89-97`），带图片时校验模型输入能力（`src/commands.ts:336-348`）。
- 图片可以持久保存（`ctx.attachments.saveImages`，`packages/attachment/attachment/src/index.ts:98`）。
- 回复工具本身还没实现；“模型是否稳定调用回复工具、是否按批注编号回复”必须等实现后用真实模型跑 E2E；这次不能验证。
- 结论：输入侧和存储侧有依据；模型行为是剩余风险。

### V16 docx 的 HTML 入口

- `docx@9.15.3` 提供 `docx/html`，导出 `htmlToContent` 和 `htmlToRuns`；官方文档说明能读富文本编辑器、Markdown、Word/Google Docs 的 HTML，支持标题、列表、表格、图片、链接、脚注等。
- 实测：把 TipTap 生成的 HTML（标题、粗斜体、列表、表格）用 `htmlToContent` 写成 docx，再用 mammoth 转回 HTML，标题、粗斜体、列表、表格都保留，没有警告。生成的 docx 约 9.9 KB。
- 限制：CSS 布局（flex/grid、非图片浮动、定位）、视频/iframe/canvas 不读；复杂版式不保证。

结论：Doc 的“HTML 编辑、导出 docx”路径可行，基本格式保真；复杂 Word 版式仍需本地应用打开。

## 对方案的影响

1. **Excalidraw 字体策略必须先定。** 推荐懒加载、不带 Xiaolai、中文走系统回退；如果要手写中文字体，做可选字体包，或者把画布拆成独立可选包。
2. **TipTap 依赖要整体锁版本。** 表格扩展不在 StarterKit 里；`extension-table-row` 当前解析到 3.32.3，必须把所有 @tiptap 包锁到同一版本，不能靠 `--legacy-peer-deps`。
3. **包体解释要对齐。** 按下载体积（gzip）核心约 0.8 MB、含画布约 3.4 MB；按磁盘 min 产物体积含画布约 11 MB。建议按“首屏下载 ≤5 MB、包体 ≤10 MB”验收，并把这一点写进验收标准。
4. **工具守卫只覆盖结构化写文件工具。** bash 绕过是残余风险；实现期要么收紧主题会话的 bash，要么在写入后做二次范围校验。
5. **SSE、并发和模型回复必须真机 E2E。** 源码和 API 都支持，但本次没有在运行宿主上验证认证、心跳、双主题并行、重启恢复和模型工具调用。
6. **ProcessOn 只做导入导出；PDF 页内批注后置。**

## 开发前置门禁

- 确认 Excalidraw 中文字体策略：不带 Xiaolai（推荐）或可选字体包/独立画布包。
- 确认“客户端 5 MB”是下载体积还是磁盘 min 产物；建议按下载体积验收，同时在文档里写明两者。
- 确认依赖锁定和许可证检查方式：本仓库目前没有运行时依赖，新增依赖要提交锁文件，并核对 MIT/Apache-2.0 许可。
- 在实现前补三个最小原型：Excalidraw 的 CJS/chunk + 资源路由；SSE 路由在真实 GUI 的认证与续传；`tools.guard` 的同行锁拒绝与模型重试。
- 给 TipTap、Excalidraw、Pele、Excel 各写一个小样本测试，作为后续升级的回归基线。

## 复现要点

原型目录都在 `/tmp`，不进入仓库：

- `/tmp/v-cm`：CodeMirror 打包（`entry.js` / `entry-min.js`）。
- `/tmp/v-pele`：Pele 六类打包和 `render-test.mjs`。
- `/tmp/v-excel`：多工作表往返（`roundtrip.mjs`）和浏览器打包。
- `/tmp/v-tiptap`：TipTap 打包和 HTML 往返（`roundtrip-table.mjs`）。
- `/tmp/v-docx`：HTML→docx→HTML 往返（`roundtrip.mjs`）。
- `/tmp/v-excalidraw`：CJS/分包打包、`page.html` 浏览器挂载、字体目录对比。

## 参考资料

- docx 的 HTML 入口与能力说明：<https://docx.js.org/usage/html.md>
- ProcessOn 嵌入依赖公开分享的公开教程（第三方资料，未找到官方私有嵌入文档）：<http://www.php.cn/faq/2756015.html>
- ProcessOn 相关 MCP 包（生成能力，不是画布嵌入）：<https://www.npmjs.com/package/@processon/mcp-server-processon-node>
- pdf-lib（后续页内批注叠加）：<https://pdf-lib.js.org/>
- Excalidraw 包信息：<https://registry.npmjs.org/@excalidraw/excalidraw/latest>
- Pele 包信息：<https://registry.npmjs.org/pele/latest>

## 未核实或需实现期验证

- 真实宿主上的 SSE 认证、心跳、断线续传。
- 两个主题并行投递、一个失败、宿主重启后的恢复。
- 模型稳定调用回复工具、按批注编号回复、回复带附件。
- 用户与模型同时编辑时的三方合并、范围重叠判定和冲突 UI。
- Excalidraw 完整中文字体缺失时，用户显式选择 Xiaolai 的回退表现。
- Excalidraw 的 CJS/chunk 接入、CSS/字体授权路由、包体最终值。
- 复杂 docx 版式、xlsx 公式/样式的实际丢失范围。
