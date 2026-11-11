# Cowork 右侧栏收件箱实现交接

- 日期：2026-11-10
- 状态：设计完成，未实现；本文件只改文档，`src/`、`presets/`、`tests/` 未动
- 分支：`agent/decision-handoff-doc`
- 设计基线：`812666a`（设计文档与交接首次提交）；本轮补充见后续 docs 提交
- 设计：[topic-inbox.md](design/cowork-sidebar/topic-inbox.md)
- 提案：[2026-11-10-topic-inbox.md](../.agents/notes/proposed/feature/2026-11-10-topic-inbox.md)
- 交互稿：[topic-reminder-demo.html](discussion/topic-reminder-demo.html)

## 先读

1. [右侧栏收件箱设计](design/cowork-sidebar/topic-inbox.md)
2. [决策提案](../.agents/notes/proposed/feature/2026-11-10-topic-inbox.md)
3. [主题页设计](design/cowork-sidebar/topic-page.md)（收件箱是在它之上的扩展）
4. [跨对象决策](design/cowork-sidebar/cross-cutting-decisions.md)（旧“不新增收件箱”结论已被取代）
5. 交互稿和截图：默认宽侧栏、确认后右侧回复、PLAN 要求修改、窄侧栏、筛选
6. [术语表](glossary.md)的 `request inbox` / `user review request` / `plan request`
7. 本文件

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
- 更新设计/提案/交接/索引/feature-todos；记录未核实项

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

## 回滚

- 本次交付只有文档，回滚就是回退文档提交。
- 后续实现新增 `requests/` 文件，不改 index 版本；旧版本忽略该目录。回滚代码不会删除已有 `requests/` 数据。
- 若 authorization 桥接出问题，保留现有 `authorization.resolve` 路由，不删除旧路径。

## 不做

- 不改宿主 A2，不把提醒写成 `user/message` 或 tool call。
- 不改自动 reviewer 的 `cowork_review_request` / verdict。
- 不删除旧 `.dsh-cowork/inbox.json`，不改变 merge-needed/review-reject 语义。
- 不做工作项页、diff 查看器、Artifact 工作室、项目记忆页。
- 不做多人权限、跨项目收件箱、移动端专用布局。
- 不在浏览器里接受任意文件路径；不做侧边 PLAN 抽屉。

## 新会话启动清单

- [ ] `git fetch`，确认当前分支和最新 main；本分支只改文档，先合到实现分支。
- [ ] 跑 `npm run check`、`npm test`，记录基线。
- [ ] 读设计、提案、主题页、跨对象决策、术语表、本文件。
- [ ] 跑宿主探针，记录宽度/文件打开/prompt/A2 结果。
- [ ] 冻结请求记录和 API 契约；阶段 1 的后端测试先红后绿。
- [ ] 阶段 2 只读 UI 用 fixture 打通；再接真实数据。
- [ ] 阶段 3 动作和文件打开；阶段 4 真实 GUI 与全量检查。
- [ ] 收口：更新设计/提案/交接/索引/feature-todos，记录证据和遗留。
- [ ] 汇报四项：改了什么（路径）、验证命令和结果、回滚方式、未核实项。

## 已确认与仍需核实

已确认：

1. “评审”卡是**用户评审请求**；自动 reviewer 的 verdict 只是普通灰字记录，不做可操作卡。
2. 主题卡主体点击打开会话；筛选按钮单独放在主题卡上。

仍需实现前核实：

1. 宿主没有宽度 setter 时，窄栏按钮只做面板内全宽收件箱；真正的自动展开是宿主依赖，不假装已支持。
2. 当前 `authorization` 请求摘要可能没有 demo 里的 command 字段；实现时给工具增加可选 `command`，不改旧摘要语义。
3. `review-verdict` 活动的真实 details 形状需按现有 `review-tools` 事件确认，再决定 note 文案。
