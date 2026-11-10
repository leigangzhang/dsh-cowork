# 工作项交付物：多类型文件嵌入研究

Status: research（2026-11-10；结论待确认后再进设计）

## 结论

1. **文件是唯一内容来源，批注单独存放。** 工作项登记项目里已有的文件路径，不复制文档；批注、回复和协作状态写在 `.dsh-cowork/` 的记录里，每条批注带文件版本号。模型用现有的读写工具改文件，查看器读到的就是文件当前内容，不会出现两份文档。
2. **查看器放主区域。** 注册一个 root 作用域的 `main` 面板，用 `ctx.layout.selectPanel` 打开；右侧栏保留工作项列表。面板里提供「返回会话」操作（`selectPanel(null)`），用户从左侧栏打开任何会话时面板也会自动关闭。点开列表时记下当前会话 id，接口带上它，宿主按会话 cwd 校验项目根。备选是右栏全屏 tab（会话作用域，少一层状态），两种位置可以复用同一套组件。
3. **不引入大型第三方编辑器。** 文本用自建的行锚定查看器（阅读视图复用宿主的 `MarkdownText`，逐行视图显示源码行号）；图片和 SVG 用原生 DOM 加覆盖层；HTML 用宿主已经验证过的 iframe 沙箱；PDF、xlsx、Excalidraw、mermaid 第一版不自己渲染。
4. **反馈流程事件驱动，不轮询模型。** 提交批注 → 写记录 → 向工作项所属主题会话投递一条消息 → 监听会话事件和文件变化 → 用一条长连接（SSE）把状态推回浏览器。
5. **多模态从用户侧进入。** 圈选或截取的图片在浏览器裁切，上传到宿主附件服务，再作为图片内容随消息发给模型；不把图片塞进批注文本。

## 逐类型方案

| 类型 | 文件形态 | 渲染方式 | 批注方式 | 用户直接编辑 | 第一版 |
|---|---|---|---|---|---|
| PLAN / Markdown | `.md` | 阅读：原生 `MarkdownText`；逐行：源码加行号 | 行或行范围，附引用原文 | 不做，模型改文件 | 做 |
| 设计稿 | `.png` `.jpg` `.svg` | `<img>`；SVG 净化后内联 | 框选区域（归一化坐标）加 pin，可裁切截图随批注 | 不做 | 做 |
| 架构图 | `.svg`（mermaid 先导出 SVG） | 净化后内联 SVG | 元素或区域 | 不做 | 做，mermaid 源码只读 |
| Canvas / Excalidraw | `.excalidraw` JSON 或导出的图片 | 第一版按图片显示 | 区域加 pin | 不做 | 只读 |
| HTML demo | `.html` | 静态：消毒后 iframe，不执行脚本；交互：Blob 地址加 `allow-scripts`，不加 `allow-same-origin` | 静态可批注元素；交互只能按坐标加文字说明 | 不做 | 做，坐标批注 |
| 表格 | `.csv` `.xlsx` | csv 自己画表；xlsx 跳到宿主预览 | csv 支持行和单元格 | 不做 | csv 做，xlsx 跳转 |
| PDF | `.pdf` | 不在查看器里做，提供「用宿主预览打开」 | 第一版只做整体评论 | 不做 | 跳转 |

**为什么不用现成编辑器。** 画布类组件都很大，而且会引入第二份内容状态（编辑器内部模型与文件本体），和「文件是唯一内容来源」冲突。

| 包 | 版本（2026-11-10 查询） | 许可 | npm 解包大小 |
|---|---|---|---|
| `@excalidraw/excalidraw` | 0.18.1 | MIT，peer react 17/18/19 | 46.8 MB |
| `tldraw` | 5.6.0 | 商用许可，生产环境需授权，未授权带标记 | 15.6 MB |
| `mermaid` | 12.3.0 | MIT | 123.6 MB |
| `pdfjs-dist` | 6.5.438 | Apache-2.0 | 37.6 MB |

解包大小不等于打包后体积，但可以说明这几个包都不适合放进第一版查看器。之后如果需要编辑画布，单独评估 Excalidraw，不上 tldraw。

## 反馈流程

```text
用户批注 ──POST──▶ 宿主写记录 ──prompt──▶ 主题会话（排队/思考）
                                        │
        ┌───────────────────────────────┘
        ▼
 会话事件：turn/start、tool/call、turn/end
 文件变化：内容版本递增，行号重算
        │
        └──SSE──▶ 浏览器：状态变化 + 只重载变化的文件
```

1. 用户在查看器选中行或区域写批注，可附截图，提交到宿主。
2. 宿主校验会话、项目根和文件路径，只允许工作项登记过的文件；写批注记录和一条活动事件。
3. 宿主组装一条消息投给工作项所属主题会话：工作项、文件、行范围、引用原文、批注编号和文字、截图（图片内容），并说明改完文件后调用回复工具。会话忙就排队，空闲会被唤醒。
4. 模型在一轮里改文件，调用 `cowork_artifact_reply` 把回复挂到批注上。
5. 宿主监听 `session/event`，把状态依次更新为 `排队`、`思考中`、`改文件中`、`已回复`；失败则停在失败状态并显示原因。
6. 宿主用 `ctx.fs.watch` 监视登记文件；版本变化后重算行数，推送新内容。
7. 浏览器只重载变化的文件，保留滚动位置和批注高亮。行号因编辑位移时用批注里存的原文引用重新定位；找不到就标「位置待确认」，不猜。
8. 模型回复显示在对应批注下；用户可以在回复下继续追问，也可以对文档提新意见。

不在这个流程里的两件事：不用轮询查模型回复；不给模型新增写文件接口，写入仍走它平时的编辑工具，避免两条写入路径。

## 对比现有方法

### 嵌入方式

| 做法 | 优点 | 问题 | 结论 |
|---|---|---|---|
| 自建 React 查看器 | 原生主题、键盘、无障碍；批注能落到行和区域；不跨 iframe | 每类文件要自己写渲染 | 采用 |
| 复用宿主文档预览 tab | 文件加载、分页、tab、刷新都是现成的 | 注册按后缀全局生效，会顶掉所有 `.md` 预览；批注界面只能塞进预览正文，主区域与列表的分工做不出来 | 不采用，只作为「打开原件」的辅助入口 |
| 嵌 HTML 页面（当前 demo 的做法） | 起得快，样式独立 | 主题、键盘、无障碍、数据通道都要重做；批注与文件内容分离 | 只用于 HTML 类型内部预览，不承载查看器 |
| 第三方编辑器 | 编辑能力强 | 体积、许可、两套内容状态 | 第一版不用 |
| 宿主浏览器 tab | 能打开 loopback 页面 | 拒绝打开应用自身 origin，无法注入批注 | 不用 |

### 批注定位方式

| 做法 | 常见例子 | 优点 | 问题 |
|---|---|---|---|
| 行号加原文引用 | 代码评审的行内评论 | 精确定位，模型容易照着改 | 编辑后行号漂移，要按引用重新定位 |
| 段落或范围 | 文档协作里的批注 | 对用户自然 | 边界模糊，大段重写后锚点很难保持 |
| pin 或区域 | 设计稿协作 | 适合画布，不需要文本 | 纯文本用不上 |
| 块级定位 | 笔记类产品的行内评论 | 稳定 | 粒度粗，做不到逐行 |

选择：文本用行号加原文引用，画布用归一化坐标区域加裁切图，HTML 交互模式用视口坐标；所有批注都带版本号。

## 本地核对

客户端槽位和服务用只读 inspect 在运行中的 GUI 上确认，其余读源码。

- 主区域面板：`main` 是 root 作用域的 keyed 槽位，key 自取；`ctx.layout.selectPanel` 切换（`packages/client/ui-layout/src/client/service.ts:36,72`）。左侧栏入口用 `sidebar.panellist`，同一个 id 对应 `main` 的 key（`packages/client/ui-sidebar/README.zh.md`「全局面板入口」）。当前 GUI 里 `main` 已有 `conversation`、`plugins` 等占用者，说明普通客户端插件可以注册。
- 第三方客户端包能直接 require 宿主组件：平台模块表（`PLATFORM_MODULES`）含 `react`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`，启动时写入模块表（`packages/client/web/src/platform.ts`、`packages/client/web/src/seed.ts:24-38`）。这让我们能复用 `MarkdownText`（`packages/client/ui-primitives/src/index.ts:104`）和 `ImageLightbox`（同文件 `:113`），不用自己实现 Markdown 和图片放大。类型仍按仓库现有做法手写（`src/client/contracts.ts`）。
- 文档预览扩展点和 HTML 隔离：`packages/client/ui-sidebar-documentpreview/src/client/document/registry.ts`（按后缀注册、优先级档位）；HTML 静态预览用 `sandbox=""`，交互预览用 Blob 地址加 `sandbox="allow-scripts"`（同包 `html/HtmlBody.tsx:68,102`），静态页面先经 DOMPurify 和 CSP 处理（同包 `html/basic-document.ts:13` 起）。
- 会话消息可带图片：`PromptContentPart` 支持 `image`（`packages/api/session-controller/src/types.ts:89-97`），`SessionPromptRequest` 见同文件 `:333-341`；带图片时会校验当前模型是否支持图片输入（同包 `src/commands.ts:336-348`）。
- 图片附件可持久保存：`ctx.attachments.saveImages`（`packages/attachment/attachment/src/index.ts:98`）。
- 文件监听和读取：宿主 `fs.watch(target, changed, signal)`；`workspaceFiles` 的文件读取和变化监听可以指向工作区外路径（`packages/api/workspace-files/README.zh.md`）。
- 长连接可行：连接层把 `Response.body` 逐块写给 HTTP 响应（`packages/client/connection/src/http-bridge.ts:103`），HMR 已有同源 SSE 先例（`packages/client/hmr/src/index.ts` 的 `/plugins/events`）。
- 会话事件：`session/event` 追加事件流，含 `turn/start`、`turn/end`、`tool/call`、`tool/result`、`assistant/message`（宿主 Event inspect 契约）。
- 现有面板的请求方式可以照用：同源 fetch 带 `credentials: 'same-origin'`（`src/client/api.ts:408`），路由经 `connection.fetch.register` 挂在已做 Host/Origin 校验和浏览器认证的通道上（`src/api.ts:1003`）。

## 风险与未核实

- **主区域面板拿不到当前会话。** `sidebarRight.mounted` 在全局面板占用主区域时是 `undefined`（`packages/client/ui-sidebar-right/src/client/service.ts:196` 的语义说明）。所以只能点开列表时记下会话 id，存进插件自己的客户端状态；页面刷新后面板选择会丢，需要用户重新从右栏进入。这一点是否可接受未核实。
- **行号会漂移。** 模型大段重写时，引用原文可能找不到；只能标「位置待确认」。真实改写幅度未核实，需要拿实际模型输出验证重定位成功率。
- **HTML 交互模式读不到内部 DOM。** 父页面拿不到 iframe 里的元素，批注只能按坐标；要做到元素级批注，就得改成「静态净化加 Shadow DOM 内联」，样式隔离要自己保证。
- **大文件。** 文本分页加载，模型可能一次改完整篇；查看器要按视口附近加载，不能整份塞进内存。具体上限要在实现时定。
- **模型是否稳定调用回复工具未验证。** 如果不调用，只能从「turn 结束加文件变化」推断完成，回复就挂不到具体批注上。
- **主题会话不可用时投递失败。** 会话被归档、正在执行别的任务、或宿主拒绝排队时，批注需要有明确的失败状态和重试入口。
- **与现有 v2 `workItems` 语义冲突。** 代码里的工作项是代码隔离 clone（`src/work-item.ts`），设计里的工作项是交付物。建议新记录放 `artifacts`，用户界面仍叫工作项；旧记录先保留，是否合并另定。
- 附件大小和数量、批注条数上限、上传类型校验都还没定，实现时必须限类型和字节，不能只信扩展名。

## 分阶段

**第一版（先跑通一种类型加整条流程）**

1. 记录和路由：artifact 记录（topicId、类型、文件列表、状态、时间）；记录放 `.dsh-cowork/artifacts/<id>/`，包含 `artifact.json`、`comments.jsonl` 和附件目录；读元数据和文件字节；提交批注；一条 SSE 事件流。
2. 查看器：Markdown 阅读和逐行两种视图、行批注、评论列表、截图上传、回复显示；主区域面板和右栏列表入口。
3. 模型流程：消息投递、`cowork_artifact_reply` 工具、会话事件状态、文件变化刷新。
4. 第二类文件：图片和 SVG 的区域批注，与文本共用批注模型和存储。
5. 之后：HTML 元素级批注、csv 表格、PDF 跳转、版本对比。

**验收**

- 单元测试：记录校验、路径守卫、锚点重定位、SSE 帧序列化。
- 浏览器端到端：真实 GUI 里建工作项、加批注，看到「已送达」「思考中」「已回复」；文件被改后查看器自动更新且批注仍在。沿用 M12 的面板探针方式扩展，不新写一套驱动。
- 安全：越权路径、超大请求、跨源请求都被拒绝。

## 开放问题

- 查看器放主区域，还是右栏全屏？设计文档写主区域；右栏全屏状态更少，但和「右栏只放列表」的分工不一致。
- 用户是否需要在查看器里直接改文本？如果要，用文件版本号做乐观锁（宿主 `fs.editText` 支持 expected version），但会和模型并发修改冲突。
- 旧的代码隔离工作项记录与新的交付物记录如何命名、是否合并。
- 模型回复里是否允许带图片（目前只处理用户输入的图片）。
