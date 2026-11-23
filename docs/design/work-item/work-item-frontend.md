# Cowork 工作项前端设计与开发方案

Status: implemented（frontend design，2026-11-10；阶段 0–5 与 demo 对齐批次 A/B 已交付 2026-11-22；Doc、表格、PDF、图片永久移出目标，按需再评估（KI-57）；结果见 [WORK_ITEM_RESULT](../../handoff/WORK_ITEM_RESULT.md)；后端设计见 [work-item-backend.md](work-item-backend.md)）

本方案把[工作项多模态交付物查看器设计](work-item-artifact-viewer.md)和[V1–V16 核实报告](work-item-artifact-verification.md)落成前端实现计划。页面结构、类型和交互以查看器设计为准；依赖体积、编辑器和限制以核实报告为准。决策和取舍见[前端开发决策](../../../.agents/notes/implemented/feature/2026-11-10-work-item-page-frontend.md)。

## 范围

做：右栏工作项列表、主区域查看器、文本/图表/画布/HTML 的查看与编辑、批注线程、模型活动状态、保存与冲突、附件和多模态回复。Doc、表格、PDF、图片永久移出目标（2026-11-22，KI-57）。

不做：旧的代码隔离 `workItems`、评审/CI 闸门、多人权限、Doc/表格/PDF/图片类型、Artifact 工作室和活动记录页（只保留标签位置）。

## 承载面与导航

```text
Cowork 右栏（session scope）
└─ 内部标签：主题 / 工作项 / 活动记录 / 项目记忆
   └─ 工作项
      └─ WorkItemList（筛选 + 分组卡片）
           └─ 点击卡片 → workItemOpenStore.open({ artifactId, ownerSessionId })

会话区 conversation.view（session scope，标签「Cowork」）
└─ WorkItemViewer
   ├─ 跨会话只读提示条（仅跨会话）
   ├─ 顶部：返回会话 / 标题 / 类型 / 状态；确认、编辑、在应用中打开、导出、更多
   ├─ 工具条：文档 / 版本（计数）/ 附件（计数）；阅读 / 源码；保存状态；批注
   ├─ 内容：当前渲染器
   ├─ 右侧：CommentRail（默认收起，窄屏为抽屉）
   └─ 底部：投递摘要 / 内容版本与更新时间
```

- 右栏工作项列表挂在 Cowork 面板的内部标签里。`src/client/panel.tsx` 有主题 / 工作项 / 活动记录 / 项目记忆四个标签：主题标签承载主题页 v2 + 收件箱（宽面板内容宽 ≥620px 时为 318px 主题列 + 独立滚动的收件箱列，窄面板为单列主题列表 + “需要你处理”横幅）；工作项标签渲染 `WorkItemList`；活动记录与项目记忆是占位。列表是 session-scoped，不新增 `sidebar.panellist` 入口。
- 查看器注册为宿主 session 作用域 `conversation.view`（单标签 `cowork-work-item`，文案 `Cowork`，order 20），有打开项才注册、关闭即注销。承载面、打开/关闭、跨会话只读与 composer 隐藏由 [work-item-main-view-tab.md](work-item-main-view-tab.md) 拥有；本页只消费它的查看器内容。
- 从列表打开时把 `{artifactId, ownerSessionId}` 写进客户端 store，再点击宿主 tab strip 切到 Cowork；所有 `artifact.*` 调用固定用 `ownerSessionId` 解析项目。
- 顶部“返回会话”关闭工作项（清空 store、注销标签），回到 Chat；关闭查看器不删除未保存草稿，切到 Chat 才卸载查看器并按现有语义持久化草稿。
- 会话切换不关闭工作项：标签注册是全局的，非 owner 会话自动降级为跨会话只读；从全新（blank）会话打开时宿主没有 view 区域，列表显示可读的 `tab-missing` 错误与重试。
- 不在 `sidebar.panellist` 再注册一个入口；工作项列表是 Cowork 面板内的标签。

## 前端模块

```text
src/client/work-item/
├─ index.tsx              注册 main panel、可选快捷键、懒加载入口
├─ panel.tsx              WorkItemPanel：数据加载、工具条、内容区、评论栏
├─ list.tsx               WorkItemList：筛选、分组、卡片
├─ model.ts               纯视图模型：筛选、分组、标签、活动/保存文案
├─ store.ts               打开上下文、选中项、订阅（useSyncExternalStore）
├─ api.ts                 列表/详情/文件/批注/保存/事件/上传
├─ contracts.ts           客户端侧服务/槽位类型（wire 类型复用 panel/artifact-contract.ts）
├─ styles.ts              页面样式和 token
├─ hooks/useArtifact.ts   详情 + 文件内容 + 版本
├─ hooks/useComments.ts   线程、批注定位、状态
├─ hooks/useArtifactEvents.ts SSE/刷新、Last-Event-ID
├─ components/
│  ├─ ViewerHeader.tsx
│  ├─ ViewerToolbar.tsx
│  ├─ CommentRail.tsx
│  ├─ CommentCard.tsx
│  ├─ Composer.tsx
│  ├─ AttachmentBar.tsx
│  ├─ ActivityState.tsx
│  ├─ SaveState.tsx
│  ├─ ConflictBanner.tsx
│  └─ EmptyStates.tsx
├─ editors/
│  ├─ TextEditor.tsx      CodeMirror 6
│  ├─ RichDocEditor.tsx   TipTap + 表格扩展
│  ├─ TableEditor.tsx     自建网格 + excel 读写
│  ├─ DiagramSource.tsx   图表源码 + Pele 预览
│  ├─ CanvasEditor.tsx    Excalidraw 懒加载
│  └─ HtmlSource.tsx      HTML/CSS/JS 源码
├─ viewers/
│  ├─ PdfViewer.tsx
│  ├─ ImageViewer.tsx
│  └─ HtmlPreview.tsx
└─ lazy.ts                Excalidraw / Doc / 表格 / 图表按需加载
```

- 当前 `src/client/panel.tsx` 由 `TopicList`/`TopicStates`（`src/client/list.tsx`）和 `InboxPanel`（`src/client/inbox.tsx`）组成；主题页与收件箱的数据逻辑不改，只把它们放进第一个标签，工作项列表作为兄弟标签。
- 查看器入口在现有 `src/client/index.tsx` 里注册；当前 `export const inject = ['slots']`，可选服务用 `ctx.inject([...])`，`uiWorkspace` 已在用。`layout` 也按可选服务处理：新增 `ctx.inject(['layout'], …)` 和 `ClientContext` 类型片段，宿主没有 `layout` 时只退化打开/返回，不阻止插件加载。`dsh.client.inject` 是包级依赖的排序信息，不是服务注入，不改变这个降级。
- `store.ts` 只存“打开上下文 + 当前选中项”，不引入全局状态库；跨组件用 `useSyncExternalStore`。
- 纯函数放 `model.ts`，React-free，沿用 `node --test` 的类型剥离测试方式。

## 数据契约（拟）

### 工作项记录

```ts
interface ArtifactRecord {
  artifactId: string
  sessionId: string           // 所属主题会话
  projectId: string
  title: string
  type: 'text' | 'doc' | 'table' | 'diagram' | 'canvas' | 'pdf' | 'image' | 'html' | 'other'
  status: 'pending-view' | 'pending-confirm' | 'needs-feedback' | 'in-progress' | 'confirmed'
  paths: string[]             // 项目内相对路径
  primaryPath: string
  revision: number
  createdAt: string
  updatedAt: string
  commentCount: number
  attachmentCount: number
  activeDispatch: DispatchState | null
}
```

### 列表/详情/文件/批注/保存

以下路径是拟议接口，全部走 `connection.fetch.register` 的 exact route，沿用 Host/Origin 和浏览器认证。当前面板有 10 条 exact route（`src/panel/api.ts:970-1029`），wire 常量/类型在 `src/panel/api-contract.ts` 与 `inbox-contract.ts`；artifact 路由应新增同层 `src/panel/artifact-contract.ts` 并被客户端直接复用（现有 `src/client/api.ts` 已直接 import 两个 contract），不要手写第二份。

| 方法/路径 | 用途 | 关键输入/输出 |
|---|---|---|
| `GET /api/cowork.artifact.list?sessionId` | 右栏列表 | `{ items, counts }`；按 `updatedAt` 降序；上限 200 |
| `GET /api/cowork.artifact.detail?sessionId&artifactId` | 查看器元数据 | 记录、文件列表、版本、线程摘要 |
| `GET /api/cowork.artifact.file?...&path&version` | 文件内容 | 文本/二进制；支持 Range；带路径守卫 |
| `POST /api/cowork.artifact.comment` | 新增批注 | 锚点、引用原文、版本号；返回线程和事件序号 |
| `POST /api/cowork.artifact.edit` | 保存 | `baseVersion`、内容或 patch；冲突返回 409/合并结果 |
| `POST /api/cowork.artifact.upload` | 附件/截图 | 大小/类型校验；存到工作项目录 |
| `GET /api/cowork.artifact.events?...` | SSE | 评论、状态、模型活动、版本变化；支持 `Last-Event-ID` |

- 文件路径只允许项目内相对路径；拒绝 `..`、绝对路径、符号链接逃逸和未登记路径。
- 保存用版本号做乐观并发；409 先尝试按行三方合并，重叠才交给冲突 UI。
- 编辑范围上报走单独轻量 POST 或 SSE 上行，300ms 节流，5 秒 TTL；宿主工具守卫在 `write`/`edit`/`str_replace_editor` 前检查重叠。
- 归档/状态动作复用或新增 exact route；不恢复旧的 `workItems` 语义。
- 事件流断线用 `Last-Event-ID` 续传；失败退避 1s/4s/15s，最多 3 次，之后显示“实时更新中断，点击重试”。

### 模型工具与投递

- 主题会话内新增 `cowork_artifact_reply`：接收批注 id/回复文本/附件引用，写入线程并通知前端；模型回复支持图片或文件附件。
- 需要时增加只读 `cowork_artifact_comments`：让模型主动拉取未处理批注；没有该工具时，批注内容随投递消息进入回合。
- 主会话的跨主题投递由宿主 dispatcher 负责；前端只展示 `queued/sent/thinking/working/replied/failed/blocked/stale` 状态，不自己排队。
- 同一主题会话串行、1.5 秒合并、每批最多 10 条；跨主题默认并行 4（1–8）；队列上限 50/会话、200/项目；幂等键防重复投递。
- 投递前把批注和用户消息合并成一条 prompt；主题会话忙碌时用 `followup` 排队，不打断当前回合。
- 前端不直接调模型；失败可重试，重试沿用同一幂等键。

## 渲染器与编辑器

| 类型 | 组件 | 依赖 | 说明 |
|---|---|---|---|
| Markdown/源码 | `TextEditor` | CodeMirror 6 | 行号、选区、批注装饰、脏行上报；520 KB min |
| 图表 | `DiagramSource` + Pele 预览 | Pele | 六类图 301 KB min；渲染失败显示行号，保留源码 |
| 表格 | `TableEditor` | read/write-excel-file | 自建网格、筛选/排序视图；123 KB min；xlsx 只做交换 |
| Doc | `RichDocEditor` | TipTap + starter-kit + 表格扩展 | 460 KB min；表格扩展单独安装，所有 @tiptap 锁同一版本 |
| 画布 | `CanvasEditor` | Excalidraw | 懒加载 8.19 MB JS；不带 Xiaolai，中文回退；整文件锁 |
| PDF | `PdfViewer` | 宿主预览/浏览器原生 | 只读；整体/按页评论；页内区域后置 |
| 图片/SVG | `ImageViewer` | 无 | 区域/pin 批注；SVG 可切源码 |
| HTML/CSS | 静态预览 + `HtmlSource` | 净化 | 静态内联；脚本走沙箱 iframe，禁外部导航 |
| 其他 | 下载/外部打开 | 宿主 openWorkspacePath | 不做假预览 |

- 阅读/源码切换由工具条控制；只有文本类有源码视图。
- 图表先渲染后编辑：默认看 SVG，切源码改 Mermaid；保存后重新渲染。
- Doc 底部可切 HTML 源码；docx 导入用 mammoth，导出用 `docx/html` 的 `htmlToContent`；复杂版式给“在应用中打开”。
- 表格的筛选/排序是视图状态；导出可选“当前视图”或“原始顺序”；不承诺公式/样式往返。
- PDF 第一版不做页内区域批注；只做整体评论和按页评论。

## 批注与线程

锚点类型：

- 文本：`line-range`（起止行、引用原文、前后各一行、revision）。
- Doc：`block`（块 id/文本指纹 + revision）。
- 图表：`diagram-node` 或行范围；无法定位时保留区域坐标。
- 表格：`cell`/`row`/`column`。
- 画布：`element-id` 或归一化区域。
- PDF/图片：`page`/`region`/`pin`。
- 整体：`whole`。

规则：

- 批注存路径、锚点、引用原文、版本号、作者、时间、线程状态；不物理删除。
- 原文变化后先按引用文本和上下文重定位；失败标“位置待确认”，保留内容和回复，不猜位置。
- 评论栏按锚点位置排序；点批注卡定位文档，点行内 pin 选中线程；已解决线程折叠一行。
- 输入框支持文本、图片、文件；发送后先显示 `queued`，事件流推进状态；失败可重试。
- 选中行/区域后出现“批注”入口；不自动弹输入框，避免打断阅读。

## 保存、冲突与锁

- 进入编辑态后 800ms 防抖自动保存；失焦、切换工作项、关闭页面立即保存。
- 保存状态固定显示：已保存 · r12 / 保存中 / 冲突 / 保存失败。
- 用户编辑范围每 300ms 上报，5 秒过期；模型写入前由 `tools.guard` 检查重叠，重叠等待或拒绝，不重叠放行。
- 保存 409：先用 base/current/mine 做行级三方合并；不重叠自动合入并提示“已合并模型修改”；重叠弹冲突界面，提供查看差异、加载最新、保留我的。
- 画布按整文件锁：用户画布编辑未保存时，模型改画布排队；模型修改时前端禁用画布输入并显示锁。
- bash 绕过工具守卫是残余风险：主题会话提示词要求用编辑工具；保存后校验文件是否仍在登记路径内，发现越界写入时标记冲突并提示。
- 用户未保存的草稿不因模型回复丢失；切换工作项前保存或明确提示。

## 实时状态

查看器、列表卡、批注卡共享同一组状态：

```text
queued → sent → thinking → working → replied
                    ↘ failed
                    ↘ blocked
                    ↘ stale
```

- SSE 事件：`comment.created`、`comment.updated`、`dispatch.updated`、`artifact.updated`、`revision.created`、`reply.created`。
- 断线重连按 `Last-Event-ID`；重连后拉一次详情对账，避免丢事件。
- 列表卡的模型活动只显示一个摘要状态；查看器顶部显示当前活动，失败/阻塞给原因和重试。
- 网络错误不把状态改成失败；只有宿主明确回执才进入 `failed/blocked`。

## 多模态与附件

- 用户上传图片/文件走 `artifact.upload`；限制类型、大小和数量，文件名净化，存工作项目录，不覆盖已有文件。
- 图片在批注和模型回复里显示缩略图，可点开大图；附件条显示文件名、大小、类型、删除/下载。
- 模型回复带附件时，宿主保存到工作项目录并写入线程；前端只接受登记过的附件 id/path。
- 图片作为 prompt 内容时走现有 `image` content part；不支持图片的模型在发送前提示，不静默丢弃。

## 状态与错误

| 状态 | 界面 |
|---|---|
| 列表加载 | 3 张骨架卡 |
| 列表空 | “还没有工作项”+ 说明；不显示假卡片 |
| 列表错误 | 错误消息 + 重试；保留上次列表 |
| 查看器加载 | 标题骨架 + 内容骨架 |
| 文件缺失 | 显示路径和“文件不存在/已移动”，可刷新或打开所在目录 |
| 不支持类型 | 下载/外部打开，不渲染空白 |
| 只读 | 显示原因（权限/二进制/未知类型）；编辑按钮禁用 |
| 保存冲突 | 顶部冲突条 + 差异入口，不遮住正文 |
| 投递失败 | 批注卡和顶部都显示原因，可重试 |
| 会话不可用 | 显示“主题会话已归档/不可用”，保留批注 |

## 布局、响应式与无障碍

- 查看器占满会话视图区；批注栏默认收起，展开 336px，窄屏（<900px）改为底部抽屉，内容区不被挤压。
- 工具条允许换行；标题单行省略，类型/状态不换行。
- 焦点顺序：返回 → 标题操作 → 工具条 → 正文 → 评论栏 → 输入框；打开抽屉后焦点进入抽屉，关闭后回到触发按钮。
- 行/元素/区域批注有键盘入口；颜色不是唯一状态提示；对比度满足 WCAG AA。
- 减少动态效果时不播放状态脉冲；错误和保存状态用文字。
- 图片有 alt；按钮有 aria-label；菜单支持 Escape/焦点返回。

## 视觉验收项（demo 对齐）

视觉基准是[交互稿](assets/work-item-demo.html)和三张截图。它是 1208×828 的参考板，不是逐像素契约：对齐的是结构、元素位置、层级、间距比例、色板和状态细节；真实面板保持宿主可读字号，不照搬 mock 的 8.5–11px。

### 对齐规则

- **按渲染宽度等比**：demo 文档正文约 500px / 10px ≈ 50 字/行，实现文档约 775px / 14px ≈ 51 字/行，密度一致即可；面板更宽时不放大字号，也不为凑 mock 数值缩小可读字号。
- **亮色用 demo 色板**：`--cwi-*` 默认值取 demo 的 #101828 / #175cd3 / #2e90fa / #eef1f5 / #f2f4f7 / #e4e7ec 等；暗色主题整组覆盖为宿主 alias token，保证对比度。
- **不复制参考稿外壳**：`.stage`、`.board`、`.badge`、details board 的九张说明卡、固定画板尺寸属于展示稿，不进入产品。
- **不伪造未实现动作**：画布元素编辑不在本版范围；导出与在应用中打开按批次 B 的契约实现，宿主无对应能力时明确失败。

### 批次 A：现有数据上的样式与结构

- 文本行内批注 pin 放到行右侧，显示线程序号与状态色（对应 demo `.pin`）；选中/锚定行仍保留左侧标记。
- 线程卡补 `#N` anchor chip、选中蓝环、底部动作行（回复 / 定位 / 标记已解决 ✓），并补投递状态行（状态 + 已用时长）与“位置待确认”样式。
- 已解决线程显示为紧凑行，保留展开入口和评论数。
- 评论栏头部补“按位置排序”说明与“只看待处理”开关。
- 文档头与页脚补附件 chip（最多 2 个，超出显示 +N）。
- 查看器底部补状态条：模型已回复的线程号、待处理/待确认项、内容版本与更新时间。
- 评论输入区补说明行（选中行批注或整体评论）。
- 亮色主题切换到 demo 色值，暗色主题继续使用宿主 token。

### 批次 B：契约扩展与剩余细节

- 详情响应补 `sessionTitle`（工作项所属会话的标题）：跨会话只读提示条显示“所属：主题「…」”；宿主没有标题时只显示只读说明。同会话时顶部会话名由宿主 header 提供，查看器不再重复面包屑。
- 详情响应补 `revisions`（保留的快照版本号，最新在前）：版本 tab 显示计数，版本页显示保留快照列表。
- 新增 `POST /api/cowork.artifact.open`：把登记的主文件交给宿主 `openWorkspacePath`；宿主没有该能力时返回 501，不伪造成功。
- 头部补“在应用中打开 / 导出 / ⋯”：导出是浏览器下载当前文本文件；“⋯”提供复制路径与刷新。
- 评论栏补“全部评论 / 待处理 / 已解决”下拉和“只看待处理”开关；已解决线程合并为单行摘要（demo `.resolved-line`），展开后显示完整线程卡。
- 文本阅读补 fenced code 行样式和 stale 行底色；`hl` / 行级 `diff` 仍缺行级差异数据，保留为后续项。

### 批次 C：不属于样式层

- Doc、表格、PDF、图片渲染器：2026-11-22 永久移出目标，未来按需再评估（KI-57）；批次 A/B 不为其补样式。
- 画布元素级批注与自绘工具栏：保留 Excalidraw 自带 UI，按需再评估（KI-57）。

### 验收方式

- 浏览器 lane 截取文本、图表、HTML、画布、列表五张图，与 demo 等宽并排核对结构、位置、色值和状态细节。
- 保持既有 `data-testid` 与交互路径；新增细节不改变批注、保存、投递语义。
- 批次 B 的接口改动同步更新[后端设计](work-item-backend.md)与契约测试。

## 性能

- 当前客户端构建仍是单文件 CJS 闭包：CodeMirror、Pele、Excalidraw 都随主包加载，首屏成本由整个闭包决定；构建改为可加载的 ESM chunk 后再做按需加载（[WORK_ITEM_RESULT](../../handoff/WORK_ITEM_RESULT.md)）。
- 大文件分块/Range 读取；超过 2 MB 的文本不整篇塞进 DOM，按需分页或只读预览。
- 列表最多 200 条，分组渲染；评论线程超过 200 条折叠“加载更多”。
- 编辑器输入不触发整页重渲染；保存状态和活动状态用局部 store。
- 图片缩略图限制尺寸；附件下载按需。

## 构建与依赖

- 依赖进 `package.json` 并提交锁文件；全部 MIT/Apache-2.0 兼容。
- 当前 `scripts/build/build-client.mjs` 仍用 esbuild 打一个 CJS 闭包（externals 为 react、react/jsx-runtime、react-dom、react-dom/client、@deepseek-ai/*）。分块需要 ESM 输出和宿主可加载的 chunk，先改构建并在真实宿主验证，不能只加 `--splitting`。
- Excalidraw 样式用 `--loader:.css=text` 以字符串进入闭包，首次挂载时注入一个 `<style>`；构建因此要带 `--conditions=production`。字体资源没有随包发布：宿主 package-asset 路由只接受 svg/png/webp/jpg/jpeg，Excalidraw 文本字体走上游回退，离线时回退系统字体；不带 Xiaolai。
- Pele 渲染 Mermaid 源码，主入口包含全部图表类型；链接和图片在查看器里关闭，SVG 不发起网络请求。
- 客户端上限 100 MB（5 MB 不设硬门槛）；包体按 10 MB 控制。当前客户端 build 输出 15,469,940 B（gzip 3,681,571 B）；`npm pack --dry-run` 报告 9,894,811 B（unpacked 42,467,588 B），低于 10 MB。包内只保留 `lib/client.js.map` 供浏览器覆盖映射，宿主模块的 sourcemap 留在本地构建。

## 测试与验收

- 纯函数：列表筛选/分组、状态文案、活动状态、保存状态、锚点重定位降级；`node --test` + `tests/support/ts-hook.mjs` 的类型剥离。
- 宿主契约：列表/详情/文件/批注/保存/事件路由的认证、路径守卫、版本冲突、幂等；`node --test`，沿用 `tests/panel/api-*.test.mjs` 的临时仓库和 connection probe。
- 前端交互：用 fixture 跑列表、查看器、批注、保存冲突、失败回滚；客户端 TSX 走真实宿主 + Chromium 的 `npm run test:browser` 与 layered coverage（见 [testing.md](../../testing.md)）。
- 端到端：真实主题会话里投递批注 → SSE 状态 → 模型回复 → 文档定位；真实模型 E2E 单独记录。
- 画布：打开、编辑保存、模型改元素、整文件锁；单独浏览器检查。
- 工程：文档改动跑 `npm run check`；实现改动按 `tools/workflow.json` 的 source/browser surface 跑 `npm run test:coverage`、`npm run typecheck`、`npm run build`、`npm run test:host-smoke`，客户端另跑 `npm run test:browser` 与 `npm run test:coverage:layered -- --base <verified-base>`；`npm pack` 检查包体。
- 公开面：新增路由/工具要同步 `tests/support/public-surface.mjs` 的 `PANEL_ROUTES`/`BUSINESS_TOOL_ORDER`/`TOOL_DOMAINS`；工具预算以 `tests/guards/tool-schema-budget.test.mjs` 为准，新增工具必须显式提高。
- 文档：设计、核实报告、提案、demo 截图互相链接。

## 开发阶段

1. **基础与只读。** 工作项记录/列表/详情/文件路由、Cowork 内部标签壳、主区域壳、`WorkItemList`、文本阅读、批注线程、fixture；不做编辑和投递。可演示：从右栏打开一份 Markdown，逐行批注。
2. **文本编辑与实时。** CodeMirror 编辑、自动保存、版本/409/三方合并、脏行上报、工具守卫；SSE、dispatcher、`cowork_artifact_reply`、多模态附件；可演示：用户改一段、模型改另一段自动合并、同行冲突被锁。
3. **图表。** Pele 渲染 Mermaid 源码 + CodeMirror 源码编辑；阅读/源码切换；行范围批注。节点级批注留到后续。
4. **画布与 HTML。** Excalidraw 内建（当前单文件闭包构建随主包加载，不单独分块）、整文件锁、自动保存；HTML 静态沙箱预览、可切换交互预览，CodeMirror 源码编辑。Doc、表格、PDF、图片按 2026-11-21 的范围调整后置。
5. **收口。** 窄屏/键盘/空错态/性能/包体、真实模型 E2E、文档和截图同步。

每阶段可独立合并；阶段 1 先证明“列表 → 主区域 → 批注”的主链路，再扩类型。阶段 4 的三种类型都是文本文件，复用既有文件路由、保存与批注锚点，不新增存储。

## 风险

- **跨层改动大。** 这项工作同时改客户端面板、主区域注册、宿主路由、存储、投递和工具；阶段 1 不先打通主链路，后面会被联调拖住。
- **Excalidraw 资源和 chunk 接入未原型。** 客户端上限已放宽到 100 MB，但 CJS/chunk、CSS/字体授权路由、`EXCALIDRAW_ASSET_PATH` 仍是实现期第一风险。
- **SSE/并发/模型回复未真机验证。** 源码支持不代表端到端可用；阶段 2 必须先在真实宿主跑通再扩类型。
- **同行锁可被 bash 绕过。** 工具守卫只覆盖结构化写工具；需要提示词约束 + 保存后二次校验，不能宣称完全阻止。
- **会话切换感知。** 打开态由客户端 store 持有，宿主切会话后视图重挂载并按 `ownerSessionId` 判定只读；跨会话「在所属会话打开」依赖 `sessions.list` 的 `retainedBy.mainView` 校验切换结果，升级宿主时要回归。
- **TipTap/Excalidraw 依赖版本。** TipTap 表格扩展不在 StarterKit，当前版本解析有偏差；Excalidraw 锁定 0.18.1，升级要重跑体积和字体检查。
- **主题页/收件箱已实现。** 右栏当前是主题页 v2 + 收件箱（宽面板两列、窄面板横幅入口；`src/client/panel.tsx`、`list.tsx`、`inbox.tsx`）；工作项标签壳要在现有 Cowork tab body 上加，改动集中在壳这一处，避免重写主题列表和收件箱的数据逻辑。
- **旧 `workItems` 语义。** 新功能用 `artifacts` 记录；不复用代码隔离工作项的字段和状态，避免语义混淆。
- **附件和路径安全。** 上传、预览、HTML/ SVG 内联都必须过路径守卫和净化；沙箱 iframe 不能拿到宿主权限。

## Demo

![工作项主查看器](assets/work-item-demo.png)

![画布与区域批注](assets/work-item-demo-canvas.png)

![Doc、表格、PDF、状态与多模态细节](assets/work-item-demo-details.png)

- 交互稿：[work-item-demo.html](assets/work-item-demo.html)（`?view=text|canvas|details`）
- 设计：[work-item-artifact-viewer.md](work-item-artifact-viewer.md)
- 研究与核实：[work-item-artifact-embedding-research.md](work-item-artifact-embedding-research.md)、[work-item-artifact-verification.md](work-item-artifact-verification.md)
- 决策：[2026-11-10-work-item-page-frontend.md](../../../.agents/notes/implemented/feature/2026-11-10-work-item-page-frontend.md)
- 实现交接：[WORK_ITEM_HANDOFF.md](../../handoff/WORK_ITEM_HANDOFF.md)
