# Proposal: 工作项前端开发（主区域查看器、右栏列表、编辑/批注/投递）

Status: proposed
Date: 2026-11-10
Class: feature

## Problem

工作项查看器的设计、技术选型和 V1–V16 核实已经完成，用户也确认了设计：查看器在主区域，右栏只做列表；所有文本可编辑；批注投递后模型思考并修改；Excalidraw 不带中文字体，客户端允许到 100 MB。设计见 [work-item-artifact-viewer.md](../../../../docs/design/cowork-sidebar/work-item-artifact-viewer.md)，核实见 [work-item-artifact-verification.md](../../../../docs/design/cowork-sidebar/work-item-artifact-verification.md)。

当前插件还没有这项工作：

- 右栏只有主题列表/详情（`src/client/panel.tsx`），没有工作项标签，也没有主区域查看器。
- 没有 `artifacts` 记录、批注、版本、投递队列、SSE 和文件路由；现有 `workItems` 是代码隔离记录，语义不同，不能复用。
- 文本编辑器、TipTap、Pele、Excel、docx、Excalidraw 只做过独立原型，没有接进插件构建和宿主资源路由。
- 用户改文件和模型改文件可能重叠；工具守卫能拦 `write`/`edit`/`str_replace_editor`，但 bash 仍可绕过。

如果直接按类型逐个开发，会先做出一堆孤立预览器，再回头补主链路、保存和投递。需要先把“列表 → 主区域 → 批注 → 版本 → 投递”打通，再扩类型。

## Proposal

按[工作项前端设计与开发方案](../../../../docs/design/cowork-sidebar/work-item-frontend.md)分五阶段实现；第一阶段只做基础与只读，后续再扩编辑、实时、图表/表格、Doc/PDF/画布。

**1. 承载面。** 在 Cowork 面板内部加标签壳（主题/工作项/活动记录/项目记忆），工作项标签渲染 `WorkItemList`；主区域注册 keyed panel `cowork-work-item`，从列表用 `ctx.layout.selectPanel` 打开，顶部“返回会话”用 `selectPanel(null)` 关闭。列表标签是 session-scoped，打开时把 `{sessionId, artifactId}` 写进客户端 store；主区域查看器从 store 取上下文。宿主没有 `layout` 时显示无法打开，不退回右栏全屏。

**2. 数据与路由。** 新增 `artifacts` 记录（目录 `.dsh-cowork/artifacts/<id>/`）和 exact fetch 路由：列表、详情、文件（Range）、批注、保存、上传、SSE。全部走现有 `connection.fetch.register`，沿用 Host/Origin 和浏览器认证；路径只允许项目内已登记相对路径。保存用 `baseVersion` 做乐观并发，409 先做行级三方合并，重叠才进冲突 UI。

**3. 前端模块。** 新增 `src/client/work-item/`：`index.tsx` 注册、`panel.tsx` 查看器、`list.tsx` 列表、`model.ts` 纯视图模型、`store.ts` 打开上下文、`api.ts`/`contracts.ts`、编辑器/查看器/评论组件、`styles.ts`、`lazy.ts`。`model.ts` 保持 React-free，沿用 `node --test` 的类型剥离测试。不引入全局状态库。

**4. 编辑器与依赖。** 文本 CodeMirror 6；Doc TipTap + 表格扩展（所有 @tiptap 锁同一版本）；图表 Pele 六类；表格自建网格 + read/write-excel-file；docx 用 mammoth 导入、`docx/html` 导出；画布 Excalidraw 0.18.1，懒加载，不带 Xiaolai，资源走同源授权路由，`EXCALIDRAW_ASSET_PATH` 用绝对 URL。构建从单文件 CJS 扩展为主包 + 按需 chunk。

**5. 投递与实时。** 宿主 dispatcher 按主题会话串行、1.5 秒合并、每批最多 10 条，跨主题默认并行 4（1–8）；重试用幂等键和退避。主题会话内新增 `cowork_artifact_reply`（文本 + 附件引用），需要时加只读的 `cowork_artifact_comments`。前端通过 SSE 展示 `queued/sent/thinking/working/replied/failed/blocked/stale`，不自己排队。

**6. 工具守卫。** 对 `write`、`edit`、`str_replace_editor` 注册同行范围守卫：用户脏行 300ms 上报、5 秒 TTL；模型写入范围与用户范围重叠时拒绝或等待。bash 绕过作为残余风险，靠提示词约束和保存后二次校验，不宣称完全阻止。

**7. 不在本提案。** 旧 `workItems` 合并、评审/CI、多人权限、PDF 正文编辑、复杂 Word/Excel 保真、Activity 工作室和项目记忆页；右栏只保留标签位置，后两者可先占位。

## Alternatives considered

**复用宿主现有的文档预览作为查看器。** 否决：它只解决只读预览，不能逐行批注、编辑、保存冲突、按类型投递，也不能接模型回复；PDF 可以借用它的渲染经验，但查看器本身要新建。

**把 demo 用 iframe 嵌进主区域。** 否决：demo 是静态原型，没有宿主会话、保存、SSE 和权限；iframe 还要 `postMessage` 桥接，键盘、主题色和焦点都难统一。

**工作项只在右栏全屏打开，不注册主区域。** 否决：设计已经定为主区域；右栏全屏会挤压评论栏和工具条，也和“主区域查看器 + 右栏列表”的信息结构冲突。

**一次性把九种类型全做完再联调。** 否决：主链路（列表、打开、批注、版本、投递）没打通时，类型越多联调面越大；先 Markdown 跑通再扩图表/表格/Doc/画布。

**把 Excalidraw 做成独立可选包。** 暂不采用：客户端上限已放宽到 100 MB，Excalidraw 可以懒加载进主包；包体去掉 Xiaolai 后约 4 MB，仍在 10 MB 内。若后续构建或资源路由证明不可行，再退回可选包。

**继续用旧的 `workItems` 记录。** 否决：旧记录是代码隔离和评审状态，字段和语义都不是交付物；混用会让状态、路径和评论模型互相污染。

## Acceptance criteria

- [W1] 右栏 Cowork 出现“工作项”标签，列表按状态分组/筛选，卡片只有类型、状态、评论数、附件数、更新时间；不出现旧 `workItems` 的代码字段 — `source`
- [W2] 点卡片打开主区域查看器并带上 `{sessionId, artifactId}`；“返回会话”关闭并回到会话；宿主无 `layout` 时显示明确提示而不是死按钮 — `source`
- [W3] Markdown 能阅读、逐行/行范围批注、刷新后线程仍在；原文改动后定位失败标“位置待确认”且不丢内容 — `tests`
- [W4] 文本能编辑并自动保存；版本冲突先尝试行级合并，重叠才弹冲突；用户脏行与模型写入重叠时被守卫拒绝/等待；bash 残余风险在文档里写明 — `tests`
- [W5] 批注投递有 `queued` 到 `replied` 的状态；同会话串行、跨会话并行、重试幂等；真实宿主跑通一次 SSE 和重连 — `tests` + E2E evidence
- [W6] 图表六类、表格、Doc、画布、PDF 至少各有可打开的查看器；表格导入导出 xlsx、Doc 导入导出 docx、画布导出 PNG/SVG 走通 — `source` + browser check
- [W7] 上传图片/文件、模型回复带附件、路径守卫和 HTML/SVG 净化有测试；越权路径和伪造类型被拒绝 — `tests`
- [W8] 构建产出主包 + 按需 chunk，Excalidraw 资源可加载；`npm run check`、`npm run typecheck`、`npm run build`、`npm test` 全部通过，`npm pack` 检查包体 — `source`
- [W9] 设计、核实报告、提案、README 索引和 v3 demo 截图互相链接；不出现 v2 demo 当最新稿 — `plan-docs`

## Risks

- **跨层改动大。** 同时动客户端面板、主区域注册、宿主路由、存储、投递和工具；阶段 1 主链路不先打通，后续会被联调拖住。
- **Excalidraw 资源和 chunk 接入未原型。** 客户端上限 100 MB 解决了体积顾虑，但 CSS/字体授权路由、CJS/chunk 和绝对资源路径仍是第一实现风险。
- **SSE/并发/模型回复未真机验证。** 源码支持不等于端到端可用；阶段 2 必须先跑真实宿主，再扩类型。
- **同行锁可被 bash 绕过。** 守卫只覆盖结构化写工具；提示词和保存后校验只能降低风险，不能完全阻止。
- **依赖版本和包体。** TipTap 表格扩展不在 StarterKit，版本解析有偏差；Excalidraw 升级要重跑体积/字体检查；新增依赖要提交锁文件并核对许可证。
- **右栏标签壳碰主题页。** 主题页前端如果并行改 `panel.tsx`，两边要先约定标签壳接口，避免互相重写。
- **安全边界。** 上传、预览、HTML/SVG 内联、沙箱 iframe 都要过路径守卫和净化；沙箱 iframe 不能拿到宿主权限。

## Delivery stages

1. **基础与只读。** artifacts 存储/列表/详情/文件路由、标签壳、主区域壳、列表、Markdown 阅读、批注线程、fixture；可演示“右栏 → 主区域 → 逐行批注”。
2. **文本编辑与实时。** CodeMirror 编辑、自动保存、409/三方合并、脏行上报、工具守卫；SSE/dispatcher/`cowork_artifact_reply`/多模态附件；跑真实宿主 E2E。
3. **图表与表格。** Pele 六类图 + 源码编辑；表格网格 + xlsx 导入导出 + 筛选/排序；节点/区域批注。
4. **Doc、PDF 与画布。** TipTap + docx 导入导出；PDF 查看/按页评论；Excalidraw 懒加载、元素级工具、整文件锁、导出。
5. **收口。** 窄屏/键盘/空错态/性能/包体、真实模型 E2E、文档和截图同步、旧详情入口迁移。

## Demo

- 主查看器：[work-item-demo-v3.png](../../../../docs/discussion/work-item-demo-v3.png)
- 画布与区域批注：[work-item-demo-v3-canvas.png](../../../../docs/discussion/work-item-demo-v3-canvas.png)
- Doc/表格/PDF/状态/多模态：[work-item-demo-v3-details.png](../../../../docs/discussion/work-item-demo-v3-details.png)
- 交互稿：[work-item-demo-v3.html](../../../../docs/discussion/work-item-demo-v3.html)（`?view=text|canvas|details`）
- 设计：[work-item-artifact-viewer.md](../../../../docs/design/cowork-sidebar/work-item-artifact-viewer.md)
- 前端设计方案：[work-item-frontend.md](../../../../docs/design/cowork-sidebar/work-item-frontend.md)
