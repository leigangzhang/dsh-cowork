# 工作项交付物：多类型文件嵌入与编辑研究

Status: research（2026-11-10；V1–V16 已核实，字体与体积决策已确认）

## 结论

1. **位置与记录。** 查看器优先放主区域；后台记录叫 `artifacts`，界面仍叫工作项；旧的代码隔离 `workItems` 不合并，保留原样。
2. **所有文本类型都能编辑。** Markdown、源码、HTML/CSS、SVG 源码、Mermaid 源码、CSV/TSV 用 **CodeMirror 6**；Doc 用 **TipTap** 做所见即所得编辑，底层文件仍是 HTML。
3. **图表用文本作为内容源。** 架构图、流程图、时序/角色交互图、ER 图、类图、状态图、思维导图、C4 统一写成 Mermaid 源码，用户和模型都改文本；预览用 **Pele**（MIT，无运行时依赖，支持 Mermaid 12.1 的全部图表类型）。
4. **自由画布内建 Excalidraw。** Excalidraw 作为懒加载块，文件仍以 `.excalidraw` 为准。实测中文字体 Xiaolai 占 13 MB，全带会使包体超过 10 MB；已确认不带 Xiaolai，中文走系统字体回退，需要手写中文字体时再提供可选字体包。draw.io、ProcessOn 等外部工具通过导入导出对接。
5. **Office 与 PDF 按“交换格式”处理。** Doc 以 HTML 为编辑源，docx 只做导入导出；表格以 CSV/TSV 为编辑源，xlsx 只做导入导出；PDF 只查看和批注，不在 HTML 里改正文。
6. **实时流程复用 discussion 脚本的数据模型，换掉轮询。** 保留追加消息、版本号、作者、附件和大小限制，改成宿主事件加 SSE；同一主题会话内串行并合并，跨主题并行。
7. **多模态双向。** 用户圈选或截图后上传；模型回复也可以带图片或文本附件。
8. **并发上限已确认。** 主题内 1.5 秒合并窗口、每批最多 10 条批注；主会话跨主题并行默认 4，可配 1–8。
9. **冲突按行加锁。** 用户和模型改到同一范围才锁；不重叠的修改自动合并。画布按整个文件锁。
10. **体积上限。** 客户端 5 MB 不再是硬门槛，允许到 100 MB 以内；包体按 10 MB 控制。实测核心依赖约 2.4 MB min、0.78 MB gzip；Excalidraw 另加 8.19 MB JS 和 0.5 MB 非中文字体，懒加载后下载约 3.4 MB，去掉 Xiaolai 后包体约 4 MB。

## 本次确认的决定

| 决定 | 内容 |
|---|---|
| 查看器位置 | 主区域优先；右栏保留工作项列表 |
| 文本编辑 | 用户可以直接在查看器里改文本，不只有批注 |
| 后台命名 | 记录用 `artifacts`，界面上仍叫工作项 |
| 旧记录 | 代码隔离 `workItems` 与交付物记录不合并 |
| 模型回复 | 支持多模态（图片或文件附件） |
| 图表范围 | 架构图、流程图、角色交互图、ER 图等用同一机制 |
| 自由画布 | 内建 Excalidraw；外部工具通过导入导出对接 |
| Office / PDF | Doc、表格在 HTML 里查看和编辑；PDF 只批注；可导出到 WPS/Office |
| 冲突处理 | 同行范围冲突才加锁；不冲突自动合并；画布整文件锁 |
| 体积上限 | 客户端 ≤100 MB（5 MB 不设硬门槛）；包体 10 MB |
| 主题合并 | 1.5 秒窗口、每批最多 10 条批注 |
| 跨主题并发 | 默认 4，可配 1–8 |

## 编辑器与渲染器选型（重点）

### 选型标准

1. **和现有架构契合。** 页面内普通 React 组件，不套 iframe，不引入画布状态副本；输出能写回文件。
2. **文件是唯一内容来源。** 编辑器不能用内部私有文档模型存内容，否则模型改文件和用户改界面会变成两份内容。
3. **能定位到范围。** 文本到行，Doc 到段落/块，画布到元素或区域；批注和编辑共用坐标。
4. **许可兼容 MIT。** MIT、Apache-2.0、BSD 可以；GPL 只能在外部程序里用，不能链接进包。
5. **体积在 5–10 MB 内。** 重组件懒加载；包体按 10 MB 上限控制。
6. **维护状态。** 近期有发布、有持续维护者、有类型定义；单人低下载量的包只作备选。
7. **导出能力。** SVG、PNG、PDF、CSV、XLSX、DOCX 至少要能走通一条。

### 候选对比：文本与 Doc

| 候选 | 版本 / 许可 | 体积（min，2026-11-10 查询） | 判断 |
|---|---|---|---|
| CodeMirror 6 | 6.0.2 / MIT | 整包 373 KB（gzip 119 KB）；按需子集约 300 KB | **采用**（文本、源码、Mermaid、CSV 源码） |
| TipTap | 3.33.0 / MIT | starter-kit 344 KB（gzip 108 KB）+ react 29 KB | **采用**（Doc 所见即所得，待原型） |
| ProseMirror 裸用 | MIT | 与 TipTap 同源，集成成本更高 | 不单独选，走 TipTap |
| Quill / Slate / Lexical | MIT | 未测 | 不采用，和 TipTap 同类但生态弱于它 |
| 纯 textarea | 无依赖 | 约 0 | 不采用，没有行号、装饰和批注锚点 |

### 候选对比：表格

| 候选 | 版本 / 许可 | 体积（min，2026-11-10 查询） | 判断 |
|---|---|---|---|
| 自建网格 + read/write-excel-file | MIT | 网格约几百行；读写库较早版本约 37 KB / 126 KB | **采用**（基础查看、编辑、筛选、排序） |
| FortuneSheet | 1.0.4 / MIT | 2.67 MB（gzip 559 KB） | 备选。预算内，但功能远超第一版需要 |
| ExcelJS | 4.4.0 / MIT | 933 KB（gzip 256 KB） | 只在需要公式或多工作表时评估 |
| Handsontable / AG Grid | 商业或重依赖 | 更大 | 不采用 |

### 候选对比：图表与画布

| 候选 | 版本 / 许可 | 体积（min，2026-11-10 查询） | 判断 |
|---|---|---|---|
| Pele | 1.13.0 / MIT | 主入口 714 KB（gzip 262 KB）；支持按类型注册和 `pele/lazy` | **采用**（文本图表） |
| Excalidraw | 0.18.1 / MIT | 入口 589 KB；全部 chunk 8.19 MB（gzip 2.55 MB）；CSS 141 KB；中文字体 13 MB | **采用**（自由画布，懒加载；不带 Xiaolai） |
| mermaid | 12.3.0 / MIT | 入口 667 KB（gzip 159 KB）加大量懒加载块 | 备选。Pele 兼容出问题时切换 |
| maxGraph（draw.io 内核） | 0.25.1 / Apache-2.0 | 621 KB（gzip 168 KB） | 不采用。XML 画布状态 |
| tldraw | 5.6.0 / 商用许可 | 1.86 MB（gzip 552 KB） | 不采用。生产需要商业授权 |
| merslim | 0.2.3 / MIT | 191 KB（gzip 56 KB） | 不采用。单人维护、周下载低 |
| React Flow | 12.12.1 / MIT | 188 KB（gzip 60 KB） | 备选。只适合节点边图，内容要存 JSON |
| draw.io Desktop | 外部应用 / GPL-3.0 | 不进入包 | 外部编辑备用，只作为本机程序 |
| ProcessOn / Figma | SaaS | 不进入包 | 只做手动导入导出，见下文 |

### 采用组合

- **文本和源码**：CodeMirror 6。阅读视图用宿主 `MarkdownText`，源码视图用 CodeMirror；批注以源码行号为锚点。
- **Doc**：TipTap 所见即所得，底层文件是 HTML；保留源码切换。批注按段落/块锚定。
- **图表**：Mermaid 源码加 Pele 预览。先注册流程图、时序图、ER 图、类图、状态图、架构图六类；C4、思维导图按需加载。
- **表格**：自建网格编辑 CSV/TSV，支持查看、编辑、筛选、排序；xlsx 导入导出按需加载。
- **自由画布**：Excalidraw 内建（懒加载块），文件是 `.excalidraw`；资源路径用同源绝对地址；默认不带 Xiaolai 中文字体，外部工具通过导入导出对接。
- **PDF**：浏览器原生查看或跳宿主预览，只做批注。

### 自建编辑器的能力边界

- 文本编辑：完整。行号、区间装饰、撤销重做、多光标、查找替换、输入法、键盘操作都有。
- Doc：基本富文本。标题、段落、列表、粗斜体、链接、表格、图片；不做修订记录、复杂版式、域和宏。
- 表格：单元格级编辑，支持查看、筛选、排序；不做公式、图表、条件格式。
- 图表：源码编辑加 SVG 预览，不含鼠标拖拽布局；要拖拽就用 Excalidraw。
- 画布：Excalidraw 的常规绘图；不承诺 Figma 级设计能力。
- PDF：查看和批注，不改正文。

### 体积预算

实测值（React external，esbuild min，不含 sourcemap）：

| 项目 | 实测 min | gzip | 说明 |
|---|---|---|---|
| CodeMirror（Markdown 子集） | 520 KB | 179 KB | 行号 + 语法 + 历史 + 键位 |
| TipTap（含表格扩展） | 460 KB | 146 KB | Doc 专用；表格扩展必须单独装 |
| Pele（六类图） | 301 KB | 114 KB | 流程图、时序、ER、类、状态、架构 |
| read/write-excel-file | 123 KB | 34 KB | 表格导入导出 |
| docx + mammoth | 906 KB | 275 KB | Doc 导入导出，按需 |
| 现有客户端 | 96 KB | 约 30 KB | 当前 `lib/client.js` |
| 核心合计 | 约 2.4 MB | 约 0.78 MB | 不含 Excalidraw |
| Excalidraw JS（全部 chunk） | 8.19 MB | 2.55 MB | 懒加载 |
| Excalidraw CSS + 非中文字体 | 约 640 KB | 约 520 KB | CSS 141 KB + 其他字体 |
| Excalidraw 中文字体 Xiaolai | 13 MB | 13 MB | 不带；中文回退系统字体 |
| 含 Excalidraw、去掉 Xiaolai | 约 11 MB | 约 3.9 MB | 客户端上限 100 MB 内 |
| 含 Excalidraw 和 Xiaolai | 约 24 MB | 约 17 MB | 超过 10 MB 包体上限 |

按下载体积（gzip）口径，核心约 0.78 MB，含 Excalidraw 约 3.9 MB；按磁盘 min 产物体积口径，核心约 2.4 MB，含 Excalidraw 约 11 MB。包体按压缩 tar 估算：去掉 Xiaolai 约 4 MB，带 Xiaolai 约 17 MB。客户端验收上限已放宽到 100 MB（5 MB 不设硬门槛）；包体按 10 MB 控制，并同时记录下载体积和磁盘体积。


## 逐类型方案

| 类型 | 内容源 | 查看 | 编辑 | 批注 | 导出 / 外部编辑 |
|---|---|---|---|---|---|
| Markdown / PLAN | `.md` | 渲染视图 + 源码行号 | CodeMirror | 行、行范围、引用原文 | 导出 `.md` / `.html` / `.pdf` |
| Doc | `.html`（导入 docx 时转换） | 富文本渲染 | TipTap；可切源码 | 段落、块、范围 | 导出 `.docx` / `.pdf`；原始 docx 保留附件 |
| 表格 | `.csv` / `.tsv`（xlsx 导入导出） | 网格 | 网格编辑，筛选、排序 | 行、列、单元格 | 导出 `.csv` / `.xlsx` |
| 流程图 / 时序图 / ER / 类图 / 状态图 / 思维导图 / C4 / 架构图 | `.mmd` | Pele 渲染 SVG | CodeMirror 改源码 | 行、节点、区域 | 导出 `.svg` / `.png`；可复制到 ProcessOn / draw.io |
| 设计稿（HTML/CSS） | `.html` / `.css` | 静态净化后内联；带脚本用沙箱 iframe | CodeMirror | 静态页到元素；交互页按坐标 | 导出 `.html` / `.png` |
| 设计稿（图片 / SVG） | `.png` `.jpg` `.svg` | `<img>` 或净化后的内联 SVG | SVG 可改源码；位图不改 | 区域、pin、裁切截图 | 外部工具编辑后放回 |
| 自由画布 | `.excalidraw` | Excalidraw 内建 | Excalidraw | 元素、区域、pin | 导出 PNG/SVG；导入/导出 draw.io、ProcessOn |
| PDF | `.pdf` | 浏览器原生或宿主预览 | 只做批注 | 先整体或按页，页内区域后置 | 用 WPS / 预览 / Office 编辑 |
| 其他 | 任意 | 下载或打开原件 | 外部应用 | 整体评论 | 下载、在本地应用打开 |

## 文本编辑与并发

### 保存协议

1. 用户编辑后 800 ms 防抖自动保存；失焦、关闭标签、切换工作项时立即保存。
2. 保存请求带 `baseVersion`。
3. 宿主用 `fs.writeText` 的 `replaceIfVersion` 原子写入：版本一致就成功；不一致返回 409 和当前内容。
4. 409 时先做三方合并：对比 base、当前文件、用户内容的改动行集合。
   - 改动行不重叠：自动把用户改动合并到新版本，再保存一次。
   - 改动行重叠：显示冲突界面，选择保留我的、加载最新或并排对比。
5. 大文件限制：可编辑文件不超过 5 MB 或 20000 行（随预算放宽上调）；超过则只读并提示用外部应用编辑。具体阈值实现时验证。

### 同行冲突加锁

- 浏览器把正在编辑的行范围（起止行、文件）每 300 ms 报给宿主，带 5 秒有效期。
- 宿主维护每个文件的活跃编辑范围。
- 模型调用写文件工具时，插件用 `tools.guard` 检查目标范围：
  - `write` 类工具按整篇算；
  - `edit` / 替换类工具根据 `oldString` 在当前文件中的位置算出目标行范围。
  - 与用户活跃范围重叠就拒绝，并告诉模型“用户正在编辑第 X–Y 行，稍后重试”；不重叠就放行。
- 用户保存和模型编辑不重叠时，走上面的自动合并；重叠时进冲突界面。
- 画布没有行概念，按整个 `.excalidraw` 文件锁：用户正在编辑时，模型改画布被拒绝。
- 限制：如果模型用 bash 改文件会绕过工具检查；第一版靠提示词要求用编辑工具，待后续加文件级校验。

### 批注锚点

- 文本锚点存路径、起止行、引用原文、前后各一行、revision。
- 文件变化后，先在原行附近 ±20 行找原文；找不到再全文找唯一匹配；仍找不到标“位置待确认”。
- Doc 锚点按段落标识加文本引用；TipTap 的块 id 不写进文件，保存后重新匹配。
- 画布锚点存元素 id 或归一化坐标；元素被删时标“位置待确认”。
- 批注和回复只追加，不物理删除；标记已解决即可。

## 图表与画布

### 文本图表（Mermaid + Pele）

- 内容是 `.mmd` 文本，用户和模型都改文本；普通 diff 就能看改了什么。
- Pele 输出 SVG，按主题 CSS 变量着色；渲染失败时显示错误行号，保留源码可编辑。
- 导出 SVG/PNG；需要继续加工时复制到 ProcessOn、draw.io 或 Figma。
- 图表阶段先开六类（含架构图），其他类型提示“暂不支持预览，可编辑源码或导出”。

### 自由画布（Excalidraw 内建）

- 文件是 `.excalidraw`，Excalidraw 负责编辑和渲染；插件把它懒加载成独立块，避免拖慢首屏。
- 用户编辑时自动保存到文件，保存走版本校验；模型改画布与用户编辑重叠时整文件加锁。
- 批注层叠在画布上方，用元素 id 或归一化坐标定位；选中批注时高亮对应元素或区域。
- 模型改画布优先用插件提供的元素级工具（增加、修改、删除元素、改文字、改颜色），不直接改整份 JSON；工具设计要按 Excalidraw 场景格式核实。
- 导入导出：支持 `.excalidraw`、PNG、SVG；对接 draw.io 时用 SVG/PNG 中转，对接 ProcessOn 时手动导出导入。
- 打包注意：Excalidraw 有 CSS、字体和资源路径；`EXCALIDRAW_ASSET_PATH` 必须是绝对 URL，否则出现文本元素时构建 URL 失败。CJS/chunk 接入和资源授权路由还需要实现原型。

### 外部工具（备用）

- draw.io Desktop（官方 Electron，GPL-3.0）只作为外部程序，不链接代码；文件保存后监视刷新。
- ProcessOn 嵌入依赖公开分享，不集成登录或云同步；只做手动导出导入。
- Excalidraw 网页端可作为没有内建包时的备用编辑方式；内建后不再是主路径。

## Office 与 PDF

### Doc

- 可编辑源是 `.html`；TipTap 负责所见即所得，保留源码切换。
- 导入 `.docx`：mammoth 转 HTML，原 docx 保留为附件。
- 导出 `.docx`：docx 9.15.3 的 `docx/html` 已确认可用，`htmlToContent` 直接读富文本 HTML；基本格式往返已通过。
- 保真度目标：标题、段落、列表、粗斜体、链接、表格、图片。修订记录、复杂版式、域、宏不保证。
- 需要在 WPS/Office 里看原版式时，用“在本地应用打开”。

### 表格

- 可编辑源是 `.csv` / `.tsv`，自建网格支持查看、编辑、筛选、排序。
- 筛选和排序是视图状态，默认不写回文件；导出时可选“按当前视图”或“按原始顺序”。
- 导入 `.xlsx`：轻量读取库转网格；多工作表先取第一个，其他表保留附件。
- 导出 `.xlsx`：轻量写入库生成；不保证公式、样式、合并单元格。
- 需要完整 Excel 能力时，本地应用打开 xlsx。

### PDF

- 查看：浏览器原生 PDF 查看器或宿主预览，不引入 pdf.js。
- 编辑：只做批注，不做正文编辑；页内区域批注后置。
- 导出：先导出原件；带批注的副本后置（需要 pdf-lib 叠加）。

### 导出与本地打开

- 下载：宿主按登记文件返回字节，带 `Content-Disposition`。
- 在本地应用打开：宿主调用 `sessionController.openWorkspacePath`，可列关联应用。
- 打开前宿主校验路径确实映射到本机文件，不能用浏览器传来的任意路径。

## 实时反馈与并发

### 从讨论原型复用和替换

复用：

- 消息模型：`author`、`text`、`attachments`、时间、版本号。
- 限制：正文 4000 字、附件最多 5 个、单文件 5 MB、只收图片和文本、图片按魔数校验、附件 URL 只允许 `/uploads/`。
- 追加式记录、原子替换写文件、读时校验。

替换：

- 轮询改为会话事件、文件监视和 SSE。
- 单进程锁只保护写入，不把投递模型的过程放在锁里。
- 状态改为追加日志加事件序号，支持断线重连。

### 投递状态

```text
用户批注 ──▶ queued ──▶ sent ──▶ thinking ──▶ working ──▶ replied
                              └──────────▶ failed / blocked / stale
```

- `queued`：已写入，等待投递。
- `sent`：宿主已接受 prompt。
- `thinking`：目标会话 `turn/start`。
- `working`：出现工具调用或文件变化。
- `replied`：回复工具带回了批注编号。
- `failed` / `blocked` / `stale`：失败、会话不可用、回复基于旧版本。

### 主题会话内：串行 + 合并

- 同一主题会话同时只允许一个在途投递；宿主对同一会话本来就是队列处理。
- 1.5 秒合并窗口，最多 10 条批注合成一条消息；模型一次回复多条。
- 合并只在同一工作项内；跨工作项不合并。
- 第一版不用 `steer`。

### 跨主题：并行 + 上限

- 主会话一次操作可以要求多个主题的多个工作项处理批注，并行发送到多个会话。
- 每会话仍串行；全局同时投递默认 4，可配 1–8。
- 每会话队列上限 50 条，项目待处理上限 200 条；超过拒绝并提示。
- 主会话工具调用立即返回投递编号；全部结束或超时后一条摘要回报。
- 失败分类：会话不存在或已归档不重试；宿主拒绝或超时按 1s、4s、15s 退避，最多 3 次。
- 投递记录持久化；重启后未回复的标 `stale` 或重新排队，不重复创建评论。

### 事件流与多模态

- 每个项目一条 `artifact-events.jsonl`，事件带递增序号；SSE 支持 `Last-Event-ID` 续传，心跳 15 秒。
- 事件：批注新增、投递状态变化、文件版本变化、回复新增、批注位置失效。
- 浏览器只重载变化的文件；滚动位置按行文本恢复。
- 用户附件：圈选或截图裁切，上传后存到工作项上传目录，作为图片内容发给模型。
- 模型附件：回复工具接受图片或文本附件路径，宿主校验路径和大小后登记。
- EventSource 同源带 cookie，但还没在真实宿主验证；备选 fetch 流式读取。

## 对比现有方法

### 嵌入方式

| 做法 | 优点 | 问题 | 结论 |
|---|---|---|---|
| 自建 React 查看器 | 原生主题、键盘、无障碍；批注能落到行和区域 | 每类文件要自己写渲染 | 采用 |
| 复用宿主文档预览 tab | 文件加载、分页、tab、刷新现成 | 注册按后缀全局生效；主区域与列表分工做不出来 | 只作为“打开原件”的辅助入口 |
| 嵌 HTML 页面 | 起得快，样式独立 | 主题、键盘、无障碍、数据通道都要重做 | 不承载查看器 |
| 内建画布编辑器 | 编辑体验完整 | 体积、许可、第二份内容状态 | 采用 Excalidraw，控制体积和锁 |
| 外部桌面/网页工具 | 功能最强，零集成成本 | 要手动切换，不能实时双向同步 | 作为导入导出和备用编辑 |
| 宿主浏览器 tab | 能打开 loopback 页面 | 拒绝打开应用自身 origin | 不用 |

### 批注定位方式

| 做法 | 常见例子 | 优点 | 问题 |
|---|---|---|---|
| 行号加原文引用 | 代码评审的行内评论 | 精确定位，模型容易照着改 | 编辑后行号漂移，要重新定位 |
| 段落或范围 | 文档协作批注 | 对用户自然 | 大段重写后锚点难保持 |
| pin 或区域 | 设计稿协作 | 适合画布 | 纯文本用不上 |
| 块级定位 | 笔记类产品 | 稳定 | 粒度粗，做不到逐行 |

选择：文本用行号加原文引用；Doc 用段落加文本引用；画布用元素 id 或归一化坐标；所有批注带版本号。

## 本地核对

客户端槽位和服务用只读 inspect 在运行中的 GUI 上确认，其余读源码。

- 主区域面板：`main` 是 root 作用域的 keyed 槽位，key 自取；`ctx.layout.selectPanel` 切换（`packages/client/ui-layout/src/client/service.ts:36,72`）。左侧栏入口用 `sidebar.panellist`（`packages/client/ui-sidebar/README.zh.md`「全局面板入口」）。
- 平台模块表允许第三方客户端包 require 宿主组件（`packages/client/web/src/platform.ts`、`packages/client/web/src/seed.ts:24-38`）；可复用 `MarkdownText`（`packages/client/ui-primitives/src/app/apply.ts:104`）和 `ImageLightbox`（`:113`）。
- 文件写入带版本校验：`FsWriteIntent` 的 `replaceIfVersion`（`packages/fs/fs/src/types.ts:123-126`），编辑带 `expected.version`（`:147-154`）。
- 工具调用可以在执行前拒绝：`ToolGuard`（`packages/core/tools/src/app/apply.ts:731`）和 `ctx.tools.guard`（`:1136`）；执行上下文带工具名、参数和 agent（`:326-352`、`:393-398`）。这是“同行冲突加锁”的落点。
- 文件监听：宿主 `fs.watch`；`workspaceFiles` 的文件读取和变化监听可以指向工作区外路径（`packages/api/workspace-files/README.zh.md`）。
- 会话消息可带图片：`PromptContentPart` 支持 `image`（`packages/api/session-controller/src/types.ts:89-97`），带图片时校验模型输入能力（同包 `src/commands.ts:336-348`）。
- 图片附件：`ctx.attachments.saveImages`（`packages/attachment/attachment/src/app/apply.ts:98`）。
- 会话事件：`session/event` 含 `turn/start`、`turn/end`、`tool/call`、`tool/result`、`assistant/message`（宿主 Event inspect 契约）。
- 长连接：连接层逐块写 `Response.body`（`packages/client/connection/src/http-bridge.ts:103`）；HMR 已有同源 SSE 先例（`packages/client/hmr/src/app/apply.ts` 的 `/plugins/events`）。
- 在本地应用打开：`sessionController.openWorkspacePath`（`packages/api/session-controller/src/app/apply.ts:339-350`）、`canOpenWorkspacePath`（`:319`）、`workspacePathApplications`（`:369-382`）；打开前校验路径。
- HTML 隔离参考：静态 `sandbox=""`、交互 Blob 加 `sandbox="allow-scripts"`（`packages/client/ui-sidebar-documentpreview/src/client/html/HtmlBody.tsx:68,102`），静态页面经 DOMPurify 和 CSP（同包 `html/basic-document.ts:13` 起）。
- 现有面板请求方式：同源 fetch 带 `credentials: 'same-origin'`（`src/client/api.ts:408`），路由经 `connection.fetch.register`（`src/panel/api.ts:1003`）。

组件版本、许可和体积来自 npm registry 与 bundlephobia（查询日期 2026-11-10）。体积是打包器估算，不等于本仓库产物；以原型构建为准。

## 待核实清单（V1–V16 已核实）

详细结果、命令和证据见[核实报告](work-item-artifact-verification.md)。结论：

| id | 结论 | 摘要 |
|---|---|---|
| V1 | 部分确认 | 可挂载、可出图；JS 8.19 MB min / 2.55 MB gzip；CSS 141 KB；已确认不带 Xiaolai，中文回退。`EXCALIDRAW_ASSET_PATH` 必须绝对 URL |
| V2 | 确认 | `convertToExcalidrawElements`、`getSceneElements`、`updateScene`、`serializeAsJSON` 可用 |
| V3 | 部分确认 | 挂载和 `onChange` 已确认；自动保存、版本、锁需要实现原型 |
| V4 | 确认，有缺口 | write/edit/str_replace_editor 可拦截；bash 绕过未解决 |
| V5 | 部分确认 | `replaceIfVersion` 和 `expected.version` 存在；三方合并需实现原型 |
| V6 | 确认 | TipTap + 表格 460 KB / 146 KB gzip；基本 HTML 往返通过；所有 @tiptap 包必须锁同一版本 |
| V7 | 确认 | 多工作表读写通过；浏览器 123 KB / 34 KB gzip；只处理值 |
| V8 | 确认 | 六类图 301 KB / 114 KB gzip；六类样例渲染通过；标签转义 |
| V9 | 确认 | CodeMirror Markdown 子集 520 KB / 179 KB gzip；最小 277 KB / 90 KB gzip |
| V10 | 部分确认 | 流式响应和同源 cookie 有源码依据；真实宿主 SSE 未跑 |
| V11 | 部分确认 | 同会话 `followup` 排队、inbox 持久化；跨会话并行和重启未跑 E2E |
| V12 | 部分确认 | 核心约 2.4 MB min；Excalidraw 另加约 11 MB min；客户端上限 100 MB，包体按 10 MB。 |
| V13 | 确认（否定） | 没有私有嵌入；ProcessOn 嵌入依赖公开分享，只做手动导入导出 |
| V14 | 部分确认、后置 | 宿主 PDF 预览已有文本层和 viewport；页内批注可做，本版本不做 |
| V15 | 部分确认 | 图片消息和附件存储确认；模型回复工具采用率需真实模型 E2E |
| V16 | 确认 | `docx/html` 的 `htmlToContent` 可用；HTML→docx→HTML 基本格式保留 |

## 风险

- **Excalidraw 的资源和接入仍是最大风险。** V1 已确认能挂载、能出图，字体策略已定；CJS/chunk 接入和资源授权路由还要原型。V2 已确认 API，V3 的自动保存和整文件锁需要在实现期验证。
- **同行锁的覆盖范围。** 工具守卫能拦截常规编辑工具，但 bash 改文件绕不过；需要在提示词和校验两层补。
- **TipTap 引入第二套文档模型。** 文件仍是 HTML，但编辑时是 ProseMirror 模型；往返和批注锚点要测试。
- **docx/xlsx 保真度。** 只承诺基本查看、编辑、筛选、排序；复杂版式、公式、样式、修订不保证。
- **PDF 正文编辑不可行。** 只做批注。
- **并发假设。** 同一会话串行、跨会话并行需要在真实宿主验证；失败恢复依赖日志补偿。
- **体积。** 客户端上限已放宽到 100 MB；Excalidraw 懒加载、不带 Xiaolai 后包体约 4 MB，仍在 10 MB 内。

## 分阶段

**第一版：文本闭环**

1. `artifacts` 记录、索引摘要、评论和事件日志。
2. 主区域查看器：Markdown/源码编辑（CodeMirror）、阅读视图、行批注、评论列表、截图上传、模型回复显示。
3. 保存协议、三方合并、同行锁、批注重定位。
4. 投递：会话队列、合并窗口、跨会话并发、SSE、失败重试。
5. 模型回复工具和多模态回复。

**第二版：图表与表格**

1. Mermaid 源码编辑加 Pele 预览（先六类），导出 SVG/PNG。
2. CSV/TSV 网格编辑、筛选、排序；xlsx 导入导出。
3. 图片/SVG 区域批注。

**第三版：Doc、画布与外部工具**

1. TipTap Doc 编辑、docx 导入导出、PDF 查看与批注。
2. Excalidraw 内建，元素级模型工具，整文件锁。
3. draw.io、ProcessOn 导入导出流程；本地应用打开和文件监视。
4. PDF 页内区域批注和带批注副本。

**验收**

- 单元测试：记录校验、路径守卫、版本冲突、三方合并、同行锁判定、投递状态机、事件序号。
- 浏览器端到端：编辑保存、制造同行冲突被锁、非重叠修改自动合并、批注投递和回复、模型改文件后刷新。
- 并发端到端：主会话向两个主题并行投递，一个失败时状态可区分。
- 画布端到端：Excalidraw 打开、编辑保存、模型改元素、锁生效。
- 安全：越权路径、超大请求、跨源请求、伪造附件类型都被拒绝。

## 已确认

- Excalidraw 不带 Xiaolai 中文字体，中文走系统字体回退；需要手写中文字体时再做可选字体包。
- 客户端不设 5 MB 硬门槛，允许到 100 MB 以内；包体按 10 MB 控制。
- Doc 用 TipTap 所见即所得，表格扩展必须单独安装并锁版本。
