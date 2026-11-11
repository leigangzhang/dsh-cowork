# Cowork 右侧栏收件箱实现交接

- 日期：2026-11-10
- 状态：**已实现（2026-11-10）**；代码分支 `feat/topic-inbox`，交付前代码 HEAD `a26e1c5`（文档收口提交在其后），四命令与真实 Chrome 验证见下
- 分支：`feat/topic-inbox`（从 `origin/main` `2d1bfee` 建立；阶段 0 探针 `a23212a`、契约冻结 `a0331df`）
- 设计基线：`812666a`（设计文档与交接首次提交）；本轮补充见后续 docs 提交
- 设计：[topic-inbox.md](design/cowork-sidebar/topic-inbox.md)
- 决策记录：[2026-11-10-topic-inbox.md](../.agents/notes/implemented/feature/2026-11-10-topic-inbox.md)
- 交互稿：[topic-reminder-demo.html](discussion/topic-reminder-demo.html)

## 先读

1. [右侧栏收件箱设计](design/cowork-sidebar/topic-inbox.md)（§14 是实现结果）
2. [决策记录](../.agents/notes/implemented/feature/2026-11-10-topic-inbox.md)
3. [主题页设计](design/cowork-sidebar/topic-page.md)（收件箱是在它之上的扩展）
4. [跨对象决策](design/cowork-sidebar/cross-cutting-decisions.md)（旧“不新增收件箱”结论已被取代）
5. 交互稿和截图：默认宽侧栏、确认后右侧回复、PLAN 要求修改、窄侧栏、筛选
6. [术语表](glossary.md)的 `request inbox` / `user review request` / `plan request`
7. 本文件（先看 §实现结果，前面的探针与契约是实现前冻结的约定）

## 已定事实（不要重开）

- 收件箱是 Cowork tab 内部第二列，不是第五个标签，不改主区域。
- 宽侧栏 ≥620px：左主题栏固定，右收件箱独立滚动；窄侧栏 <620px 隐藏收件箱，顶部“需要你处理 N 项”。
- 四类请求：`user-review`、`authorization`、`question`、`plan`。通知型事件：分配、上报、决策提案、自动评审结果、归档。
- 请求结构固定为“左侧主题消息 + 卡片 + 解决后右侧用户回复”；两条消息由服务端持久化，前端不自己拼。
- 评审卡是**用户评审请求**，不是自动 reviewer；自动 `cowork_review_request` / `cowork_review_verdict` 不改。自动 reviewer 的 `review-verdict` 只投影成一条居中灰字记录：无链接、无动作、不进入待处理计数。
- PLAN 的“查看全文”由服务端调宿主文件浏览器打开仓库内文件；不做侧边抽屉，不接受浏览器传路径。
- 不依赖宿主 A2 / `ctx.sessionNotices`；旧 `.dsh-cowork/inbox.json` 不读、不改。
- 只有 authorization 改变主题阻塞；其他请求不改主题生命周期。
- 主题卡主体点击打开主题会话；每张主题卡新增一个独立筛选按钮，用于切换收件箱的“只看此主题”过滤。筛选按钮是兄弟控件，不嵌套、不触发展开会话。

## 实现前必须先做的宿主探针

当前宿主是 DSH 0.2.1-rc.2。先记录真实结果，再决定实现细节：

1. **右栏宽度/展开。** `ctx.layout` 或等价客户端服务能否设置右栏宽度、展开右栏或全屏右栏？如果没有，窄栏按钮按设计降级为面板内全宽收件箱，不操作宿主 DOM。
2. **文件打开。** `sessionController.openWorkspacePath({ path, action: 'reveal' })` 能否从本插件宿主调用；无桌面/远端路径的错误形状是什么。
3. **唤醒主题。** `sessionController.prompt({ sessionId, mode: 'queue', content })` 在 resolve 后是否真的启动/排队一轮；失败是否返回可记录的 error。
4. **A2。** 再次确认没有 `ctx.sessionNotices` / `notice/message`；本收件箱不得依赖它。
5. **右栏宽度实测。** 至少 648px（宿主默认）、900px（宽演示）、400px（窄）三档，记录真实内容宽度和滚动行为。

探针结果写进实现结果或本文件补充段；未核实项不得在 UI 里假装已支持。

## 阶段 0 探针结果（2026-11-10）

实现分支 `feat/topic-inbox`（基线 `2d1bfee`，已在 origin/main）。以下用**已安装宿主**（DSH Desktop 2 / 运行时 0.2.1-rc.2）读契约，不把源码 checkout 当运行事实。

| # | 探针 | 证据 | 结果 | 结论 |
|---|---|---|---|---|
| 1 | 右栏宽度/展开 | 已安装 `dsh-client-ui-layout/README.zh.md:59`：`ctx.layout` 绑定 `selectPanel`、`toggleSidebar`、`openRightbar(track, fullscreen)`、`closeRightbar`；源码 `packages/client/ui-layout/src/client/service.ts` 的 `ILayout` 无宽度 setter；`setRightbar` 只存在于 root store 的拖拽 action | **没有插件可调用的右栏宽度 setter**；`openRightbar` 是右栏占用方（ui-sidebar-right）报告呈现，不是普通 tab 的请求接口 | 窄栏（<620px）按设计降级为**面板内全宽收件箱**；不操作宿主 DOM，不伪造自动展开 |
| 2 | 文件打开 | 已安装 `dsh-api-session-controller/lib/types/index.js:417` 有 `openWorkspacePath`；`lib/index.js` 注册 `canOpenWorkspacePath`/`openWorkspacePath`/`workspacePathApplications`；契约 `SessionOpenWorkspacePathRequest = { action?: 'reveal'; application?: string; path: string }`，Host 先 `verifyDesktopPath`（远端/无桌面路径会被拒绝） | 方法存在且插件 host 已注入 `sessionController`；错误是 `RemoteError('gateway/*')`，不是可读业务码 | 服务端解析仓库内文件后以绝对路径调用；缺方法或无桌面 → `inbox/open-unsupported`。**运行时打开真实文件留到阶段 3/4 在测试 profile 实测** |
| 3 | 唤醒主题 | 已安装 `SessionPromptRequest` 要求 `requestId` + `mode`（`queue`/`steer`）+ `content`；现有 `src/session-slice.ts` 的 `promptSession` 已按该形状调用，生产路径 `authorization.resolve` 与 M12 E2E 已验证 | 可队列一轮；`accepted: false` 是宿主拒收，不算异常 | resolve 后复用 `promptSession`（queue）唤醒主题；失败只写 `delivery.lastError`，不回滚终态 |
| 4 | A2 | `grep -rln "sessionNotices\|notice/message" '/Applications/DSH Desktop 2.app/Contents/Resources/app/node_modules/@deepseek-ai'` 无匹配 | 仍无 A2 | 收件箱不依赖 A2；不写 `user/message` 或 tool call |
| 5 | 右栏宽度实测 | 真实 Chrome + 隔离 fixture：窗口 1400 → Cowork 根 630（主题列 318 / 收件箱 291.5）；拖 resize handle 到宽档 900（318 / 561.5）；窗口 400 → 窄档，无收件箱列 | 三档均实测；收件箱 scrollTop=400 时主题列 `top` 保持 81.5 不变 | 宽档两列独立滚动、窄档横幅 + 面板内全宽收件箱均按设计工作；无需宿主宽度接口 |

## 契约冻结（前后端共同）

### 请求记录

`<repo>/.dsh-cowork/requests/<requestId>.json`，`RequestRecordV1`：

- `kind`：`user-review` / `authorization` / `question` / `plan`
- `status`：`pending | passed | returned | allowed | denied | answered | skipped | approved | revise | void`
- 必填：`requestId`、`projectId`、`topicId`、`title`、`summary`、`requestMessage`、`payload`、时间戳
- `resolutionMessage` 解决后写入；`delivery` 记录 prompt 成功/失败
- 同 requestId 同动作幂等，不同动作冲突
- 不改 `ProjectIndexV2` 版本；authorization 仍写主题 `authorization`

### 工具

- `cowork_user_review_request`
- `cowork_request_question`
- `cowork_request_plan`
- `cowork_authorization_request` 扩展，写请求记录并保留现有阻塞语义
- 自动 reviewer 工具保持原样

### 路由

- `GET /api/cowork.inbox`
- `POST /api/cowork.inbox.resolve`
- `POST /api/cowork.inbox.open`

错误码至少：`inbox/request-not-found`、`inbox/request-resolved`、`inbox/action-not-allowed`、`inbox/invalid-answer`、`inbox/invalid-comment`、`inbox/path-missing`、`inbox/open-unsupported`、`inbox/not-member`。

### 计数

- 横幅/需要你处理：只算 pending 请求；细分待授权/待审核/待回答/待确认。
- 收件箱标题：当前筛选下请求 + 通知总数。
- 通知不计入待处理。

## 实现顺序

### 阶段 0：探针

按上一节跑；记录命令、返回、未核实项。不要先写 UI 或批量改 `panel.tsx`。

### 阶段 1：后端请求存储

拟新增：

- `src/request-schema.ts`：记录、payload、状态组合、长度、消息生成、校验
- 收件箱读层还需投影 `review-verdict` activity 为普通通知注释；不写 `notices.json` 行
- `src/request-store.ts`：`requests/` 读写、锁、原子写、扫描上限
- `src/request-service.ts`：create/resolve/open、authorization 桥接、prompt
- `src/request-tools.ts`：四个工具
- `src/activity.ts`：`request-created` / `request-resolved`
- `src/index.ts`：接线

测试：`tests/request-schema.test.mjs`、`tests/request-store.test.mjs`、`tests/request-tools.test.mjs`；更新 `tests/activity.test.mjs`。

### 阶段 2：只读 API 与前端

拟新增/修改：

- `src/inbox-contract.ts`、`src/inbox-api.ts`：路由、wire 类型、错误码、通知合并
- `src/index.ts`：注册 inbox 路由
- `src/client/api.ts`：`loadInbox` / 解析
- `src/client/inbox-model.ts`、`src/client/inbox.tsx`：视图模型和组件
- `src/client/panel.tsx`：宽度测量、两列/窄栏、独立滚动、筛选状态
- `src/client/list.tsx`：主题卡筛选按钮（兄弟控件，不打开会话）
- `src/client/styles.ts`：卡片/对话/注释样式

测试：`tests/inbox-model.test.mjs`、`tests/inbox-api.test.mjs`；更新 `tests/panel-model.test.mjs`。测试要覆盖主题卡筛选按钮不打开会话、自动评审结果无动作。

### 阶段 3：动作、回复和文件打开

- `POST /api/cowork.inbox.resolve`：四类动作、角色、幂等、prompt
- `POST /api/cowork.inbox.open`：服务端解析路径 + 宿主 `openWorkspacePath`
- 前端动作、输入、右侧回复、错误回执；自动评审结果保持只读
- 主题卡筛选按钮、活动状态和清除筛选
- authorization 解锁/通知更新桥接
- 测试：解决矩阵、并发冲突、prompt 失败、路径守卫、文件打开失败

### 阶段 4：真实 GUI 与收口

- 648/900/400px 三档真实 Chrome；验证主题栏固定、收件箱滚动、窄栏 fallback
- 四类请求全流程：创建 → 收件箱 → 动作 → 右侧回复 → 主题被唤醒
- PLAN 文件浏览器打开；失败路径
- `npm run check`、`npm run typecheck`、`npm run build`、`npm test`
- 更新设计/决策记录/交接/索引/feature-todos；记录未核实项

## 命令与验收

先记录基线：

```sh
npm run check
npm test
```

实现完成后必须全部通过：

```sh
npm run check
npm run typecheck
npm run build
npm test
```

真实 GUI 证据至少包含：

- 宽侧栏两列 + 收件箱滚动时主题栏不动；
- 窄侧栏横幅计数正确，点击进入收件箱（或宿主宽度接口成功）；
- 四类请求各解决一次，右侧回复出现，主题会话继续；
- PLAN/提案文件打开成功，宿主不支持时明确报错；
- 刷新后左右消息和状态仍在。

## 实现结果（2026-11-10）

**代码落点。** 后端 `src/inbox-contract.ts`、`src/request-schema.ts`、`src/request-store.ts`、`src/request-service.ts`、`src/request-tools.ts`、`src/inbox-api.ts`、`src/activity.ts`、`src/store-schema.ts`、`src/topic-tools.ts`、`src/tool-runtime.ts`、`src/tools.ts`、`src/api.ts`、`src/api-contract.ts`、`src/index.ts`；前端 `src/client/inbox-model.ts`、`src/client/inbox.tsx`、`src/client/api.ts`、`src/client/panel.tsx`、`src/client/list.tsx`、`src/client/styles.ts`。测试新增 `tests/request-{schema,store,service,tools}.test.mjs`、`tests/inbox-api.test.mjs`、`tests/inbox-contract.test.mjs`、`tests/inbox-model.test.mjs`、`tests/open-port.test.mjs`，并更新 `api`/`api-contract`/`activity`/`store-schema`/`dev-gate`/`project-tools`/`source-budget`/`panel-model`。

**提交序列。** 阶段 0 探针 `a23212a` → 契约冻结 `a0331df` → 后端 `811558e` + 前端 `90bb75a` → 集成门禁 `cfe038b` → 审查修复批次 `07e83af`（合并 `1a82918`）→ 注释清理 `75fcbc3` → GUI 修复批次 `f31a341`（合并 `a26e1c5`）→ 收口文档提交在其后。

**门禁。** 集成门禁与修复后 `npm run check` / `npm run typecheck` / `npm run build` 均 exit 0；`npm test` 从基线 946 增至最终 **962/962**（946 + 修复回归测试）。gate artifact 记录在 `/tmp/topic-inbox-verify/GATE*.json`；交付前另有一次针对最终 HEAD 的独立复验。

**真实 GUI 证据（`inboxqa` profile + `/private/tmp/cowork-topic-page-fixture` + 真实 Chrome）。**

- 三档宽度：默认 630（主题列 318 / 收件箱 291.5，窗口 1400）、宽 900（318 / 561.5，拖 handle）、窄 400（无收件箱列，横幅「需要你处理 4 项」+ 副文案正确，点入面板内全宽收件箱并可返回）；收件箱 `scrollTop=400` 时主题列 `top` 仍为 81.5（固定）。
- 四类请求全流程：真实 master/topic 会话调用四个工具创建 → 4 条请求记录分别 `allowed` / `answered` / `passed` / `revise`，`resolutionMessage` 与 `delivery.promptedAt` 落盘、`pending=0`；右侧「你」的回复可见、按钮消失；主题会话随后继续（重新提交 plan `2f2420d8` 并 `topic_report`）。
- 定向复验（修复后）：PLAN「查看全文」→ HTTP `200 {ok:true,opened:true}`，Finder 窗口定位到 `docs`（修复前同一路径 501）；未答提示随部分作答显示「还有 N 题未回答」且提交禁用，全答后恢复；主题筛选写入 sessionStorage、刷新后保留、清除恢复全量、无效过滤自动清除；plan 要求修改后内联框消失、authorization 允许后主题卡「待授权」角标与阻塞计数自动消失。
- 清理：四类请求的测试会话已归档；fixture workspace 记录在测试宿主停止后移除。注意：宿主重启会从 session 目录重建该 `/tmp` fixture 的 workspace 记录（KI-39）——删除会话目录属删除数据，未执行，需要时由用户确认。

**与设计的偏差与修复（均为本阶段内闭环）。**

1. `openWorkspacePath` 真实宿主需要 `(request, signal)` 双参：首次 GUI 已验证 501，修复为 `createOpenWorkspacePathPort` 传 `AbortSignal.timeout(10s)` 并补 `tests/open-port.test.mjs`；复验真实桌面打开成功。
2. 旧 `POST /api/cowork.authorization.resolve` 决策后不收敛请求卡：已让它把同 `topicId`+`requestId` 的 authorization 记录收敛到终态（仅 pending→终态追加一次 `request-resolved`，响应形状不变）。
3. `POST /api/cowork.inbox.open` 补 master/主题成员校验（`inbox/not-member`，在解析路径与调用宿主 opener 之前）。
4. question 卡按“每题必答”启用提交并显示未答数量；主题筛选按 `sessionId` 持久化；plan 解决后收起内联框；authorization 解决后重拉 overview。

**未核实 / 遗留。** 自动评审 `review-verdict` 灰字只在单测/API 投影与源码断言覆盖，未在真实 GUI 跑自动 reviewer（[KI-44](KNOWN_ISSUES.md)）；`open` 的 404/403 存在性差异为信息级（[KI-43](KNOWN_ISSUES.md)）；宿主没有右栏宽度 setter，窄栏只能面板内降级（[KI-42](KNOWN_ISSUES.md)）；A2 提醒卡仍延期（[KI-40](KNOWN_ISSUES.md)）。Finding 之外的两条审查观察（`open-port` 测试名与“hang”不符、适配器忽略宿主返回值）不影响行为，记录在审查报告里，未改代码。

## 回滚

- 回退 `feat/topic-inbox` 上的实现提交（保留文档与探针提交也可单独回退）；重新跑四命令并按 README 的 tarball 安装/卸载流程重装旧包。
- 新增 `requests/` 文件不改 index 版本；旧版本忽略该目录。回滚代码不会删除已有 `requests/` 数据。
- 旧 `authorization.resolve` 路由保留且已收敛请求卡；若桥接出问题，可只回退 `src/index.ts` 的 open port 适配，路由仍返回明确错误。
- 回滚代码不删除 `.dsh-cowork/requests/`、不改变旧 `.dsh-cowork/inbox.json` 语义。

## 不做

- 不改宿主 A2，不把提醒写成 `user/message` 或 tool call。
- 不改自动 reviewer 的 `cowork_review_request` / verdict。
- 不删除旧 `.dsh-cowork/inbox.json`，不改变 merge-needed/review-reject 语义。
- 不做工作项页、diff 查看器、Artifact 工作室、项目记忆页。
- 不做多人权限、跨项目收件箱、移动端专用布局。
- 不在浏览器里接受任意文件路径；不做侧边 PLAN 抽屉。

## 新会话启动清单（2026-11-10 已完成）

- [x] `git fetch`，从 `origin/main` `2d1bfee` 建 `feat/topic-inbox`，先记基线。
- [x] `npm run check`、`npm test` 基线（946 pass）。
- [x] 读设计、决策记录、主题页、跨对象决策、术语表、本文件。
- [x] 跑宿主探针并记录宽度/文件打开/prompt/A2（见阶段 0 探针结果）。
- [x] 冻结 `src/inbox-contract.ts` 请求记录与 API 契约；后端测试先红后绿。
- [x] 阶段 2 只读 UI 用 fixture 模型打通；阶段 3 动作与文件打开。
- [x] 阶段 4 真实 GUI 三档宽度、四类请求、筛选、文件打开与全量检查。
- [x] 收口：设计/决策记录/交接/索引/feature-todos/KNOWN_ISSUES 更新，记录证据与遗留。
- [x] 汇报：改了什么、验证命令与结果、回滚方式、未核实项（见实现结果与本文件收口段）。

## 已确认与仍需核实

已确认（实现后）：

1. “评审”卡是**用户评审请求**；自动 reviewer 的 verdict 只是普通灰字记录，不做可操作卡。
2. 主题卡主体点击打开会话；筛选按钮单独放在主题卡上，只过滤收件箱。
3. 宿主没有右栏宽度 setter；窄栏按设计降级为面板内全宽收件箱，不操作宿主 DOM。
4. `openWorkspacePath({ path, action: 'reveal' })` 需要第二个 `AbortSignal` 参数；插件 host 已注入 `sessionController`，桌面打开已验证，远端/无桌面返回 `inbox/open-unsupported`。
5. `prompt({ mode: 'queue' })` 接受后主题会话继续；`accepted:false` 是宿主拒收，只写 `delivery.lastError`。
6. A2 仍不可用；收件箱不依赖 `ctx.sessionNotices`。

实现后仍未核实 / 遗留：

1. 自动评审 `review-verdict` 灰字未在真实 GUI 覆盖（[KI-44](KNOWN_ISSUES.md)）；展示层有单测与投影断言，但没有跑一次真实自动 reviewer 流程。
2. `open` 对未知 id（404）与已知非成员 id（403）存在状态差异，属存在性 oracle；UUID 不可枚举，记录为信息级（[KI-43](KNOWN_ISSUES.md)）。
3. 宿主重启会从 session 目录重建 `/tmp` fixture workspace 记录（[KI-39](KNOWN_ISSUES.md)）；测试遗留的空会话已归档，删除会话目录需用户确认。
4. 多标签同时打开时筛选隔离、Finder 是否高亮具体文件而非仅打开目录，未在本次验证中覆盖。
