# Decision: Cowork 右侧栏请求收件箱与四类行动卡片

Status: implemented
Date: 2026-11-10
Class: feature

## Problem

Cowork 右栏原本只有主题列表。需要用户行动的事件分散在主题会话、主会话和文件里，用户必须回到对应会话才能处理：

- 权限审批只存在于主题索引和 `cowork_notices` 通知里；宿主 A2 会话卡不可用，侧栏没有处理入口。
- `ask_user_question` 是宿主会话内的模态弹窗，无法异步转发到侧栏，也无法在会话外回答。
- PLAN 只存在于会话上下文，用户没有稳定的“同意/要求修改”记录；重新打开会话才能继续。
- 评审只有自动 reviewer 的 `cowork_review_request` / `cowork_review_verdict`，没有面向用户的评审请求；自动 reviewer 的 verdict 也没有稳定的侧栏记录。
- 旧 `.dsh-cowork/inbox.json` 是 master 的合并/退回队列；投递会唤醒 master 一轮对话，不是逐项、可停留在侧栏处理的请求。

设计见 [topic-inbox.md](../../../../docs/design/inbox/topic-inbox.md)，交互稿见 [topic-reminder-demo.html](../../../../docs/design/inbox/assets/topic-reminder-demo.html)。运行中的宿主 DSH 0.2.1-rc.2 没有 `ctx.sessionNotices` 和 `notice/message`，所以本方案不等待 A2，也不把提醒伪装成 `user/message` 或 tool call。

## Decision

按设计文档实现“主题栏 + 收件箱”的 Cowork 右侧栏扩展。请求记录、工具、HTTP 路由、客户端视图模型和真实 GUI 验证在同一交付里落地；实现后的行为如下：

**1. 独立请求记录。** `<repo>/.dsh-cowork/requests/<requestId>.json` 保存 `RequestRecordV1`，四种 kind：`user-review`、`authorization`、`question`、`plan`。不改 `ProjectIndexV2` 版本。请求保存状态、payload、`requestMessage`、`resolutionMessage`、解决人和投递错误；左右消息由服务端生成并持久化，刷新后仍在。记录 0600、原子写、项目锁内写入；扫描上限 200，损坏文件跳过并记录，不删历史。归档主题把未决请求置 `void` 并记 `request-resolved`（不唤醒）。实现：[request-schema.ts](../../../../src/domains/requests/request-schema.ts)、[request-store.ts](../../../../src/store/request-store.ts)、[inbox-contract.ts](../../../../src/panel/inbox-contract.ts)。

**2. 用户可见的请求工具。** `cowork_user_review_request`、`cowork_request_question`、`cowork_request_plan` 创建三类请求；`cowork_authorization_request` 扩展可选 `command`，在同一 `requestId` 上同时写主题 authorization 与请求记录，保留阻塞语义。自动 reviewer 的 `cowork_review_request` / `cowork_review_verdict` 不变；它的 `review-verdict` 活动由收件箱投影成居中灰字记录（无链接、无动作、不进入待处理计数、不写 `notices.json` 行）。实现：[request-tools.ts](../../../../src/tools/request.ts)、[activity.ts](../../../../src/store/activity.ts)、[topic-tools.ts](../../../../src/tools/topic.ts)。

**3. 统一解决 API。** `GET /api/cowork.inbox`、`POST /api/cowork.inbox.resolve`、`POST /api/cowork.inbox.open`（[inbox-api.ts](../../../../src/panel/inbox-api.ts)）。GET 合并请求（≤50）+ master 通知（assignment/report/proposal/archive，抑制 authorization）+ review-verdict 投影；counts 只算 pending 并细分；`truncated` 反映请求文件 >200 或合并 >50；`topicId` 只过滤 items。resolve 只允许 master 或该主题会话，动作按 kind 校验，同动作幂等、异动作 409；终态写 `resolutionMessage`/delivery 后以 `sessionController.prompt({ mode: 'queue' })` 唤醒主题，prompt 失败只记 `delivery.lastError`、不回滚终态。open 只按 `requestId`/`noticeId` 解析仓库内路径（拒绝绝对路径、`..`、符号链接逃逸、非普通文件与 >1MiB），先校验成员，再调宿主 `sessionController.openWorkspacePath({ path, action: 'reveal' })`；宿主没有该能力时返回 `inbox/open-unsupported`。实现：[request-service.ts](../../../../src/domains/requests/request-service.ts)、[inbox-api.ts](../../../../src/panel/inbox-api.ts)；port 接线在 [index.ts](../../../../src/app/apply.ts)。

**4. 侧栏 UI。** Cowork tab 内容宽 ≥620px 时显示左主题栏（318px 固定）+ 右收件箱（`minmax(280px, 1fr)`，独立滚动）；窄侧栏隐藏收件箱，顶部显示“需要你处理 N 项”，点击进入面板内全宽收件箱，不操作宿主布局。请求按“左侧主题消息 + 卡片 + 解决后的右侧用户回复”渲染；四类卡与通知灰字按设计复刻；主题卡主体点击打开会话，主题卡上的筛选按钮是主体按钮的兄弟控件，只切换收件箱过滤（`aria-pressed`、跨刷新按 `sessionId` 持久化到 sessionStorage、无效过滤自动清除）。实现：[inbox-model.ts](../../../../src/client/inbox-model.ts)、[inbox.tsx](../../../../src/client/inbox.tsx)、[panel.tsx](../../../../src/client/panel.tsx)、[list.tsx](../../../../src/client/list.tsx)。

**5. 权限与文件边界。** 请求和通知均由宿主生成，浏览器只传 `requestId`/`noticeId`；PLAN 和提案的“查看全文/查看提案”由服务端解析仓库内路径后交宿主文件浏览器，不在侧栏内嵌 PLAN 抽屉。宿主缺方法、拒绝打开或路径离开仓库时明确失败，不伪造打开。

**6. 旧 inbox 不动。** `.dsh-cowork/inbox.json` 继续服务 merge-needed、review-reject、blocked、cross-topic-conflict；新收件箱不读它、不改它、不依赖它唤醒 master。

**7. 宿主依赖与降级。** 运行宿主没有右栏宽度 setter，窄栏只能降级为面板内全宽收件箱；`openWorkspacePath` 需要 `(request, AbortSignal)` 双参，已在 port 适配并加超时（真实桌面打开已在 GUI 验证）；A2 仍不可用，收件箱不依赖它。GUI 中验证四类请求的创建、解决、右侧回复与主题唤醒；筛选、窄栏、独立滚动与刷新持久化在真实 Chrome 三档宽度验证。

## Alternatives considered

**等宿主 A2 的会话 notice 卡。** 否决：运行中的 DSH 0.2.1-rc.2 没有 `sessionNotices`/`notice/message`；A2 是另一个宿主版本的前置条件，不能作为当前侧栏 fallback。

**复用 `.dsh-cowork/inbox.json`。** 否决：它是 master-only 合批队列，投递会启动 master 一轮对话，摘要最多 5 条/批、没有逐项状态、没有回答/计划路径/左右对话；把新请求塞进去会破坏旧语义并让 master 被无谓唤醒。

**只用 `notices.json` + activity，不建请求存储。** 否决：通知账本只记投递状态，事件里只有有界描述；无法表达问题选项、自由文本、PLAN 路径、评审 payload、用户回复和幂等解决。读时反推会让每个 UI 重新实现业务状态。

**新增第五个收件箱标签。** 否决：四个标签布局已稳定，用户要的是主题与收件箱并排；新标签无法同时看主题和待办，也与窄侧栏横幅冲突。

**复用自动 reviewer 的 `cowork_review_request`。** 否决：自动 reviewer 的 verdict 属于独立 reviewer 会话，用户通过/退回会分叉两套终态；本方案的“评审”是用户评审请求，必须独立建模。自动 reviewer 的 verdict 只作为普通灰字记录，不生成可操作卡。

**把主题筛选做成收件箱标题旁的选择器，或让主题卡点击直接筛选。** 否决：前者增加一次跳转；后者会改变主题卡点击打开会话的既有行为。改为在主题卡上增加独立筛选按钮，主体点击仍打开会话。

**复用宿主 `ask_user_question` 弹窗。** 否决：它是会话内同步模态，不能在侧栏异步展示、分页或稍后回答；把弹窗结果轮询到侧栏会改变宿主工具语义。

**只做客户端本地队列 / localStorage。** 否决：跨会话、刷新、角色校验、幂等和主题唤醒都需要宿主状态；本地队列会在重启后丢失，也会和主会话/主题状态分叉。

**继续用 PLAN 侧边抽屉。** 否决：用户明确要求打开系统文件浏览器；侧边抽屉是重复阅读器，不解决“打开 PLAN 文件”的需求，也增加一个需要维护的视图。

## Consequences

收益：用户不离开 Cowork 右栏就能处理四类请求，解决后能看到自己的回复并让主题会话继续；请求状态、左右消息和投递结果都持久化，刷新与重启后可恢复；自动评审结果有了稳定但只读的侧栏记录；旧 `.dsh-cowork/inbox.json` 的语义没有被改写。代价与边界：

- **只有 authorization 改变主题生命周期。** question/plan/user-review 处于 pending 时主题仍可能显示运行中；统一阻塞需要另一次状态模型变更。
- **宿主能力决定降级路径。** 右栏宽度没有插件 setter，窄栏只能面板内全宽（[KI-42](../../../../docs/KNOWN_ISSUES.md)）；文件打开只在桌面宿主可用，远端/无桌面返回 `inbox/open-unsupported`。
- **两条评审线。** 用户评审请求有卡片和动作；自动 reviewer 的 verdict 只投影为灰字记录，不写 `reviews/` verdict、不进入计数。真实 GUI 验证没有跑自动 reviewer 流程（[KI-44](../../../../docs/KNOWN_ISSUES.md)）。
- **请求量上限。** 每项目最多 200 个请求文件；超出后收件箱显示截断，不静默删除。
- **信息性边界。** `open` 对未知 id 返回 404、对已知但非成员返回 403，理论上构成 requestId 存在性差异；UUID 不可枚举，记录为信息级（[KI-43](../../../../docs/KNOWN_ISSUES.md)）。
- **A2 仍延期。** 本方案不解决主会话/主题会话的 1:1 会话提醒卡（[KI-40](../../../../docs/KNOWN_ISSUES.md)）。
- **回滚。** 回退代码不删除已有 `requests/` 数据，旧版本忽略该目录；旧 `authorization.resolve` 路由保留并已收敛请求记录，不删除旧路径。

## Testing

- [R1] 设计文档覆盖四类请求、五类通知（含自动评审结果）、左右对话、宽/窄布局、固定主题栏、独立滚动、主题卡筛选按钮和宿主降级路径，未实现项明确标注 — `plan-docs`
- [R2] 请求记录、工具、解决 API、错误码、角色、幂等、路径和旧 inbox 边界完整，前后端字段一一对应；`RequestRecordV1`/`InboxResponse` 由 `src/inbox-contract.ts` 一处定义 — `tests` + `source`
- [R3] 前端视图模型能排序、筛选、计数、显示左右消息和动作可用性；主题卡筛选按钮不触发展开会话；窄栏只统计 pending 请求 — `tests`
- [R4] PLAN/提案只按 `requestId`/`noticeId` 打开仓库内文件；宿主无打开能力时明确失败，不出现侧边抽屉；真实 Chrome 下 `{ ok: true, opened: true }` 已验证 — `tests` + `plan-docs`
- [R5] authorization 仍维持主题阻塞/解锁和通知更新；旧 `authorization.resolve` 路由决策后收敛请求卡终态；自动评审结果只投影为无动作灰字；新请求不依赖 A2，旧 `.dsh-cowork/inbox.json` 不被读写 — `tests`
- [R6] 交接文档包含宿主探针、实现顺序、命令、验收和回滚；新会话无需本会话上下文即可启动 — `plan-docs`
- [R7] 设计、提案、交接、demo、主题页/术语表的链接一致；`docs/publish.json` 分类完整，`npm run check` 通过 — `publication`

## Links

- [设计](../../../../docs/design/inbox/topic-inbox.md)
- [交接](../../../../docs/handoff/TOPIC_INBOX_HANDOFF.md)
- [主题页](../../../../docs/design/topic/topic-page.md)
- [收件箱交互稿](../../../../docs/design/inbox/assets/topic-reminder-demo.html)
