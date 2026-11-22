# 工作项页阶段 0–4 与 demo 批次 A/B 交付结果

- 日期：2026-11-19（2026-11-22 增补 demo 批次 A/B）
- 状态：阶段 0–4 与 demo 对齐批次 A/B 已交付（至 2026-11-22）；KI-51/KI-52 已于 2026-11-20 在 `agent/ki-51-52`（基于 `main` `26141dd`）补修；阶段 4 于 2026-11-21 按用户调整只实现图表/画布/HTML；Doc、表格、PDF、图片自 2026-11-22 永久移出目标（KI-57）；阶段 5（收口）未开始
- 执行分支：`agent/work-item-docs-facts`（沿用交接文档指定的工作流分支）
- 交接：[WORK_ITEM_HANDOFF.md](WORK_ITEM_HANDOFF.md)；设计状态已同步为 implementing

## 交付内容

阶段 0（契约与门禁）

- `src/panel/artifact-contract.ts`：路由、wire 类型、状态/错误/上限常量；登记为纯叶契约并进入 `CONTRACT_MODULES`。
- `artifact/*` 错误码并入 `PanelErrorCode` / `PANEL_ERROR_STATUS`，与面板共用错误 envelope。

阶段 1（只读纵切）

- 存储：`src/store/artifact-{schema,store}.ts`，独立 `.write.lock`、原子记录写、JSONL 容错读、项目级事件日志。
- 平台：`artifact-files`（ctx.fs 适配、真实路径守卫、读时对账）、`artifact-events`（事件 hub、SSE 回放/心跳/reset）、`artifact-runtime`（每项目运行时缓存）。
- 路由：list / detail / file / comments / comment / comment.resolve / status / events；`cowork_artifact_create`。
- 前端：Cowork 面板内标签壳（主题/工作项/活动记录/项目记忆）、右栏 `WorkItemList`、主区域 `cowork-work-item` 查看器、逐行/范围批注与评论线程。

阶段 2（编辑、保存与同行锁）

- 修订快照（每文件最近 20 个）、`POST /edit`（直接写 + 409 冲突体）、行级三方合并 `src/domains/artifact/merge.ts`、写后事件与快照。
- `POST /presence`、`src/platform/artifact-presence.ts`、`tools.guard` 对 `write`/`edit`/`str_replace_editor` 的行范围拒绝（bash 缺口保持）。
- 前端：文本编辑器（Stage 2 为受控 textarea，2026-11-20 补为 CodeMirror 6）、800ms 防抖自动保存、保存状态、脏行 300ms 上报、409 冲突条（查看差异/加载最新/保留我的）；保存失败后重新进入编辑保留草稿，模型修改文件后只读视图重取内容、脏草稿保留旧保存基准。

阶段 3（投递、回复与多模态）

- `src/platform/artifact-dispatch.ts`：1.5s 合并窗口、每批最多 10 条、同会话同时只有一个 in-flight 批次（终态后恢复下一批）、跨会话并发、队列上限、重试 1s/4s/15s、超时、重启恢复（in-flight → stale，queued 重排）、按 turn 绑定回复/结束事件、非重入 flush、单调状态写；owner 会话 disposed 时 in-flight → blocked。
- `cowork_artifact_comments`、`cowork_artifact_reply`；评论默认投递；`POST /upload`（原始字节 + 魔数/UTF-8 校验）与 `GET /attachment`；评论附件引用。
- 前端：投递状态 chip、附件上传与缩略图、按命名事件订阅 SSE、断线三次后提示重试、重连拉取详情对账；投递入队失败在评论保存后以 `dispatchError` 显示。
- 附件安全：服务端按存储字节重新推导类型/大小/SHA-256（不信任评论或模型给的 ref），文本附件强制 `Content-Disposition: attachment` 与 CSP sandbox；图片只允许 PNG/JPEG/WebP/GIF。
- 上限与回放：评论 5000 条上限在写锁内执行；SSE 回放也按 `artifactId` 过滤。

## A+B+C 审查修复（2026-11-20）

独立审查（设计一致性 + 高危第二意见）提出 A 正确性、B 草稿安全、C 设计对齐三组问题，本轮全部落地：

- A：跨会话 turn 绑定清理按 session 过滤；恢复读取每个 artifact 的全部 dispatch 行（不只最后一行）；SSE 先按 artifact 过滤再截断，落后/截断发 reset，客户端 open/reset 重取文件；reconcile 只在记录仍是观察版本时应用，避免并发保存被回退；回复工具校验 commentIds 属于当前批次；非法 `after` 返回 400。
- B：未保存草稿写入 localStorage（带 baseRevision/baseVersion），关闭、切会话、切工作项、刷新后重新打开均恢复；保存成功/加载最新后清理；失败草稿保留。
- C：文件保存/对账后按 quote+context 重定位批注（±20 行优先、歧义标 stale），写 `anchor-moved` + `comment.updated`；用户可在线程内回复；线程卡显示投递状态/错误与重试入口（新增 `POST /api/cowork.artifact.dispatch.retry`）；dispatcher 进入 in-progress、终态回 needs-feedback，查看器有“确认完成”；查看器补文档/版本/附件 tabs、阅读/源码切换、行内 pin、批注卡定位、已解决折叠、附件元数据/下载；列表卡补状态与来源、已确认组默认折叠、错误保留旧列表、骨架与空态动作；评论请求取满 200；dispatch prompt 带 quote/context 且有图片总字节上限；retry 服务端幂等（同批单飞、superseded 检查、合并去重），重试后刷新 dispatch 摘要。

仍未做（已记 KI）：模型回复不能携带新附件（KI-54，宿主无二进制读取）、附件无删除/重命名（KI-55）；进程级重启/失败注入、真实模型 guard 拒绝重试见 KI-53。

## KI-51 / KI-52 补修（2026-11-20）

- **KI-51（编辑器）**：`src/client/work-item/editor.tsx` 用 CodeMirror 6 取代受控 textarea。Markdown 语法高亮、行号 gutter、括号匹配、默认键位与历史键位、受控值同步（只有外部值与编辑器文档不同才替换，未变化的草稿不重置编辑状态），以及未解决批注的逐行装饰（标记随文本映射，不按固定行号重算）；失焦仍触发一次保存，编辑器卸载时的失焦不再重复保存。deps `@codemirror/{state,view,language,commands,lang-markdown}` 以精确版本进 devDependencies 与 `package-lock.json`（官方 registry）。构建仍是单文件 CJS 闭包，CodeMirror 随主包加载（当前构建不能分块），client bundle 从约 196 KB 增至 1.17 MB（未压缩），仍在 100 MB 客户端上限与 10 MB 包体预算内。
- **KI-52（列表实时）**：`src/client/work-item/list.tsx` 订阅同一项目 SSE 流，250 ms 合并窗口触发一次列表读取；卡片评论数、状态 chip、投递摘要与筛选计数随事件更新，分组折叠状态不重置；连续 3 次连接失败后保留已加载列表并显示“实时更新中断，点击重试”，重试重新建立 EventSource。
- **测试**：浏览器 lane 新增 CodeMirror 行号/高亮/批注行装饰断言，以及列表 SSE 断线→重试→实时评论计数链路；`npm run test:browser` 通过（19 个报告文件，1 个 blocked）。

## 阶段 4：图表、画布与 HTML（2026-11-21）

用户把类型扩展收敛为图表（Mermaid）、画布（Excalidraw）和 HTML 页面；Doc、表格、PDF、图片本轮不做，保持源码行视图。三种类型都是文本文件，复用既有文件路由、文本保存、版本冲突和行范围锚点，没有新增面板路由、工具或存储。

- 查看器分派：`src/client/work-item/viewers/document.ts` 的 `viewerKindOf` 与 `parseCanvasScene`；`panel.tsx` 按类型渲染，源码行列表抽到 `source-lines.tsx`。
- 图表：`diagram.tsx` 用 Pele 把 Mermaid 源码渲染为 SVG；链接和图片关闭，不进网络；渲染失败显示行/列与源码片段。源码视图可编辑（CodeMirror `plain`），行批注照旧。
- HTML：`html.tsx` 在 opaque iframe 中预览。默认静态模式 `sandbox=""`、CSP 禁止脚本、外链资源和表单；切到交互模式后 `sandbox="allow-scripts"`，仍禁止同源、表单、嵌套框架和 top navigation，但 frame 自身导航无法被现行 CSP/sandbox 阻止（KI-60）。源码视图用 CodeMirror `html` 高亮。
- 画布：`canvas.tsx` 挂载 Excalidraw，阅读模式只读、编辑模式上报序列化场景；Excalidraw CSS 以文本进入客户端闭包并注入 `<style>`；`validateEmbeddable={false}` 阻止场景文件加载第三方框架。用户在画布编辑期间（进入编辑即开始，不等到第一次修改）按整文件行范围上报 presence，结构化模型写入与范围重叠会被 `tools.guard` 拒绝；`src/panel/artifact-api.ts` 对 canvas 的过期底座直接 409，不做行级三方合并。自动保存使用稳定的编辑 key，不重建 Excalidraw 实例，撤销历史保留；只有 `加载最新` 或外部文件替换才显式重置场景。
- 失败回退：无效 Mermaid 保留源码入口；无效 `.excalidraw` JSON 显示原因并回退到源码编辑器，避免把用户困在错误面板。

### 阶段 4 证据（`agent/work-item-stage4`，基于 `main` `c78a9cb`）

- `npm run test:coverage`：81 个 owner 模块，行覆盖 100%（31338/31338）；`tests/panel/artifact-canvas-edit.test.mjs` 覆盖画布过期底座 409 与当前底座直接保存。
- `npm run test:coverage:layered -- --base c78a9cb`：94 个 counted 文件，行覆盖 99.88%（34249/34290），reviewed browser floors 全部通过。
- `npm run test:browser`：通过，23 个 counted client 文件、24 个报告文件（dirty worktree）；`diagram.tsx`、`html.tsx`、`source-lines.tsx`、`canvas.tsx` 行/函数覆盖 100%，`work-item/panel.tsx` 98.62%/93.69%。场景覆盖图表 SVG 与错误定位、HTML 静态/交互两种沙箱、画布进入编辑即上报 presence、手绘矩形自动保存到 r2、第二次保存保持同一 Excalidraw 实例后到 r3、源码、损坏画布源码回退。
- `npm run build`：exit 0；client 15,469,940 B（gzip 3,681,571 B）；`npm pack --dry-run` 9,894,811 B（unpacked 42,467,588 B），只保留 `lib/client.js.map`。
- `npm run test:host-smoke`：5/5 通过。
- `npm run typecheck`：exit 0。`npm run check`：`check-invariants: ok`。

### 阶段 4 偏离与未核实

- Doc、表格、PDF、图片没有渲染器，仍是编号源码行；2026-11-22 起永久移出目标，未来按需再评估（KI-57）。图表节点级批注、画布元素级模型工具同样按需。
- Excalidraw 字体未随包发布，画布含文本时走上游 CDN 回退，离线回退系统字体（KI-58）。
- 画布整文件锁用行范围表达，覆盖当前行数；bash 和末行之后的追加仍可能绕过（KI-59）。编辑会话从进入编辑到退出持续持有锁。
- Excalidraw CSS/字体资源路由、画布元素工具、导出 PNG/SVG 与阶段 4 原设计相比未完成。图表导出按文本保留，HTML 导出不在本轮范围。
- HTML 预览的 CSP 阻止外链 CSS、图片、字体、脚本、表单和 `fetch`/XHR，`eval` 也不执行；自包含的内联页面正常。交互模式只放开内联脚本，但 iframe 仍可自行导航到外部 URL，只应打开可信页面（KI-60）。
- 单文件 CJS 闭包不能做 Excalidraw 懒加载；分块方案仍需改构建并在真实宿主验证。

## demo 对齐批次 A/B（2026-11-22）

PR #81（`agent/work-item-demo-style`，base `791955b`，head `8cdde73`，merge `a6c074e`）按前端设计的「视觉验收项」交付批次 A 与批次 B。

- 批次 A：文本行右侧编号 pin、线程卡 anchor 编号/选中蓝环/投递状态行/动作行、已解决紧凑卡、评论栏排序与待处理开关、文档头尾附件 chip、查看器底部投递摘要；亮色主题切到 demo 色板，暗色继续用宿主 token。
- 批次 B：详情响应补 `sessionTitle` 与 `revisions`；新增 `POST /api/cowork.artifact.open`，宿主无 opener 时返回 501 `artifact/open-unsupported`；头部补面包屑与确认/编辑/在应用中打开/导出/⋯ 动作；版本 tab 显示保留快照；评论栏增加三态筛选与已解决线程单行摘要；文本阅读补 fenced code 与 stale 行样式。公开面板路由由 23 条增加到 24 条。
- 结构调整：抽出 `viewer-header.tsx`、`viewer-footer.tsx`、`viewer-side-tabs.tsx`、`thread-list.tsx`、`comment-composer.tsx`、`viewer-toolbar.tsx`，`panel.tsx` 从 52.4 KB 降到 42.4 KB。
- 证据（PR #81 记录）：`npm test` exit 0；`npm run test:coverage` 100.00%（32306/32306）；`npm run test:browser` PASS（32 个 counted client 文件）；`npm run fallow:audit -- --base 791955b` 与 `npm run fallow:health` 均为 0 introduced / 0 worsened；`npm run test:e2e -- --record` 6 场景 / 140 检查；`npm run test:host-smoke` 5/5；`npm run typecheck`、`npm run build`、`npm run check` exit 0。
- 未核实：`npm run test:e2e:live` 未跑（无 `DEEPSEEK_API_KEY`）；浏览器中未点击“在应用中打开/导出”（会触发桌面/下载动作），由路由与 adapter 测试覆盖；暗色主题只做代码层 token 覆盖，未做视觉截图。`artifact.open` 按 `inbox.open` 先例登记 keyless debt（`tests/e2e/coverage-debt.json`）。

## 验证证据

均在最终代码树上实际运行（`agent/work-item-docs-facts` HEAD）：

- `npm run check`：`check-invariants: ok`。
- `npm run typecheck`：exit 0。
- `npm test`：1537/1537 通过，0 skipped。
- `npm run test:coverage`：80 个 owner 模块，行覆盖 100%（31114/31114）。
- `npm run build`：exit 0（client bundle 约 196 KB）。
- `npm run test:host-smoke`：5/5 通过。
- `npm run test:browser`：通过；工作项链路，直接保存 + 非重叠自动合并 + 409 后“加载最新”与“保留我的”，失败草稿关闭/重开后恢复并保存，会话切换自动关闭查看器，文档/版本/附件 tabs、阅读/源码切换、pin/线程定位、失败批次重试、确认动作、图片/文本附件与 SSE 实时更新均在真实 Chromium 中执行；两个新 TSX 的 reviewed floors 已登记。
- `npm run test:coverage:layered -- --base 3b140e3`：88 个 counted 文件，行覆盖 99.81%（33629/33694），reviewed floors 全部通过。
- `npm run test:e2e`：6 个 keyless 场景、137 checks 通过。`artifact-chain`（23 checks）覆盖登记 → 列表/详情/文件 → 批注 → 投递 → 模型回复 → 直接保存 → 非重叠三方自动合并 → SSE 回放 → 上传/附件 → `tools.guard` 拒绝重叠模型写入；`artifact-recovery`（10 checks）在真实宿主里从预置的 dispatch 日志执行恢复：in-flight → `stale` 且不再提示，queued 重新投递并由脚本化模型回复，failed 批次经 `POST /api/cowork.artifact.dispatch.retry` 重新投递并得到回复。
- `npm run test:e2e:live -- --scenario live-master-chain --scenario live-artifact-chain`：2 个真实模型场景、21 checks 通过。`live-artifact-chain` 观测到：master 与 routed topic 各自登记工作项；两条批注同时处于投递中（`overlap=true`）并都到达 `replied`；红色图片批注的模型回复包含「红」，证明图片 prompt 已到达模型；两个线程的回复均为 `author:"model"`。

### KI-51/52 补修证据（`agent/ki-51-52`，基于 `26141dd`）

- `npm run check`：`check-invariants: ok`。
- `npm run typecheck`：exit 0。
- `npm test`：1541/1541 通过，0 skipped。
- `npm run test:coverage`：80 个 owner 模块，行覆盖 100%（31118/31118）。
- `npm run build`：exit 0（client bundle 1,197,447 B，gzip 303,538 B）。
- `npm run test:host-smoke`：5/5 通过。
- `npm run test:browser`：通过；报告含 19 个 client 源文件（18 个 counted；`src/client/notice.tsx` 因宿主无 `ctx.sessionNotices` 被标 blocked，KI-40）。`src/client/work-item/editor.tsx` 行/函数覆盖 100%，列表 SSE 断线/重试/实时计数与 CodeMirror 行号、高亮、批注行装饰、插入行后标记跟随（该断言在未 map 的旧 handler 上先红、修复后绿）、加载最新后标记重建均在真实 Chromium 中执行。
- `npm run test:coverage:layered -- --base 26141dd`：通过；89 个 counted 文件，行覆盖 99.88%（33815/33856），reviewed browser floors 全部通过。

## 偏离与未核实

- 真实模型 E2E 已跑通核心链路（KI-53 已收窄）：两个会话并行投递、图片 prompt、回复工具采用均通过。恢复路径由 keyless `artifact-recovery` 覆盖“预置日志 → 真实宿主启动恢复”，但仍未做同一 `DSH_HOME` 的进程级重启；真实模型回合被 `tools.guard` 拒绝后的重试、prompt 拒绝触发的退避重试、队列满与 SSE 重连仍只有单测/浏览器片段证据，bash 绕过保持。
- `tools.guard` 的重叠拒绝已由 keyless `artifact-chain` 在真实宿主 + 脚本化模型回合中观测；仍未在一次真实模型回合里观测拒绝后重试。
- 保存请求在途时的并发编辑与“退出编辑”双发保存是 textarea 时代既有竞态，本轮未改（KI-56）。
- 阶段 4 已按调整后的范围完成图表/画布/HTML；`open` 已由批次 B 交付，字节 Range 与图表节点/画布元素工具仍未做（KI-57）；Doc/表格/PDF/图片永久移出目标。阶段 5（rebind、事件裁剪、列表缓存与旧隔离 workItems 入口，KI-41）未开始。

## 回滚

按阶段提交回退：`git revert` 阶段 1 / 阶段 2–3 / 阶段 4 的提交即可；阶段 4 只改客户端查看器、构建脚本、测试和文档，回退后画布/图表/HTML 退回源码行视图。数据目录 `.dsh-cowork/artifacts/` 是新增独立目录，删除它不影响 `index.json`、主题页或收件箱。
