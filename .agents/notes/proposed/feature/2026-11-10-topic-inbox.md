# Proposal: Cowork 右侧栏请求收件箱与四类行动卡片

Status: proposed
Date: 2026-11-10
Class: feature

## Problem

当前 Cowork 右栏只有主题列表。需要用户行动的事件分散在主题会话、主会话和文件里，用户必须回到对应会话才能处理：

- 权限审批只存在于主题索引和 `cowork_notices` 通知里；宿主 A2 会话卡不可用，侧栏没有处理入口。
- `ask_user_question` 是宿主会话内的模态弹窗，无法异步转发到侧栏，也无法在会话外回答。
- PLAN 只存在于会话上下文，用户没有稳定的“同意/要求修改”记录；重新打开会话才能继续。
- 评审只有自动 reviewer 的 `cowork_review_request` / `cowork_review_verdict`，没有面向用户的评审请求。
- 旧 `.dsh-cowork/inbox.json` 是 master 的合并/退回队列；投递会唤醒 master 一轮对话，不是逐项、可停留在侧栏处理的请求。

设计见 [topic-inbox.md](../../../../docs/design/cowork-sidebar/topic-inbox.md)，交互稿见 [topic-reminder-demo.html](../../../../docs/discussion/topic-reminder-demo.html)。当前宿主 DSH 0.2.1-rc.2 没有 `ctx.sessionNotices` 和 `notice/message`，所以本方案不等待 A2，也不把提醒伪装成 `user/message` 或 tool call。

## Proposal

按设计文档实现“主题栏 + 收件箱”的 Cowork 右侧栏扩展。本轮交付的是设计、提案和交接；生产代码在后续会话按阶段实现。

**1. 独立请求记录。** 在 `<repo>/.dsh-cowork/requests/<requestId>.json` 保存 `RequestRecordV1`，四种 kind：`user-review`、`authorization`、`question`、`plan`。不改 `ProjectIndexV2` 版本。请求保存状态、payload、`requestMessage`、`resolutionMessage`、解决人和投递错误；刷新后左右对话仍在。

**2. 用户可见的请求工具。** 新增 `cowork_user_review_request`、`cowork_request_question`、`cowork_request_plan`；扩展现有 `cowork_authorization_request` 同步写 authorization 请求记录。自动 reviewer 的 `cowork_review_request` / `cowork_review_verdict` 不变；两个“评审”概念在工具描述和文档中区分。

**3. 统一解决 API。** 新增 `GET /api/cowork.inbox`、`POST /api/cowork.inbox.resolve`、`POST /api/cowork.inbox.open`。解决动作按 kind 校验，caller 必须是 master 或该主题会话；同 requestId 同动作幂等，不同动作冲突。解决后写 `request-resolved` 活动，用 `sessionController.prompt({ mode: 'queue' })` 唤醒主题；prompt 失败只记录，不回滚终态。

**4. 侧栏 UI。** Cowork tab 宽度 ≥620px 时显示左主题栏 + 右收件箱；收件箱独立滚动，主题栏固定。窄侧栏隐藏收件箱，显示“需要你处理 N 项”。每条请求渲染为左侧主题消息、请求卡、解决后的右侧用户回复。四类卡按设计复刻；通知用居中灰字，提案带文件打开链接。

**5. 权限与文件边界。** 请求和通知均由宿主生成，浏览器只传 `requestId`/`noticeId`。PLAN 和提案的“查看全文/查看提案”由服务端解析仓库内路径，调用 `sessionController.openWorkspacePath({ path, action: 'reveal' })`；不在侧栏内嵌 PLAN 抽屉，不接受浏览器传路径。宿主无该能力时返回 `inbox/open-unsupported`。

**6. 旧 inbox 不动。** `.dsh-cowork/inbox.json` 继续服务 merge-needed、review-reject、blocked、cross-topic-conflict；新收件箱不读它、不改它、不依赖它唤醒 master。

**7. 放宽的边界。** 只有 authorization 改变主题阻塞状态；question/plan/user-review 是收件箱请求，不改主题生命周期。当前侧栏宽度自动展开和宿主文件打开是待探针的宿主能力；不能自动展开时用面板内全宽收件箱降级，不伪造已支持。

## Alternatives considered

**等宿主 A2 的会话 notice 卡。** 否决：运行中的 DSH 0.2.1-rc.2 没有 `sessionNotices`/`notice/message`；A2 是另一个宿主版本的前置条件，不能作为当前侧栏 fallback。

**复用 `.dsh-cowork/inbox.json`。** 否决：它是 master-only 合批队列，投递会启动 master 一轮对话，摘要最多 5 条/批、没有逐项状态、没有回答/计划路径/左右对话；把新请求塞进去会破坏旧语义并让 master 被无谓唤醒。

**只用 `notices.json` + activity，不建请求存储。** 否决：通知账本只记投递状态，事件里只有有界描述；无法表达问题选项、自由文本、PLAN 路径、评审 payload、用户回复和幂等解决。读时反推会让每个 UI 重新实现业务状态。

**新增第五个收件箱标签。** 否决：四个标签布局已稳定，用户要的是主题与收件箱并排；新标签无法同时看主题和待办，也与窄侧栏横幅冲突。

**复用自动 reviewer 的 `cowork_review_request`。** 否决：自动 reviewer 的 verdict 属于独立 reviewer 会话，用户通过/退回会分叉两套终态；本方案的“评审”是用户评审请求，必须独立建模。

**复用宿主 `ask_user_question` 弹窗。** 否决：它是会话内同步模态，不能在侧栏异步展示、分页或稍后回答；把弹窗结果轮询到侧栏会改变宿主工具语义。

**只做客户端本地队列 / localStorage。** 否决：跨会话、刷新、角色校验、幂等和主题唤醒都需要宿主状态；本地队列会在重启后丢失，也会和主会话/主题状态分叉。

**继续用 PLAN 侧边抽屉。** 否决：用户明确要求打开系统文件浏览器；侧边抽屉是重复阅读器，不解决“打开 PLAN 文件”的需求，也增加一个需要维护的视图。

## Acceptance criteria

- [R1] 设计文档覆盖四类请求、通知、左右对话、宽/窄布局、固定主题栏、独立滚动和宿主降级路径，未实现项明确标注 — `plan-docs`
- [R2] 请求记录、工具、解决 API、错误码、角色、幂等、路径和旧 inbox 边界完整，前后端字段一一对应 — `plan-docs`；实现期 `tests/request-*.test.mjs`
- [R3] 前端视图模型能排序、筛选、计数、显示左右消息和动作可用性；窄栏只统计 pending 请求 — `plan-docs`；实现期 `tests/inbox-model.test.mjs`
- [R4] PLAN/提案只按 requestId/noticeId 打开仓库内文件；宿主无打开能力时明确失败，不出现侧边抽屉 — `plan-docs`；实现期 `tests/inbox-api.test.mjs` + GUI
- [R5] authorization 仍维持主题阻塞/解锁和通知更新；新请求不依赖 A2，旧 `.dsh-cowork/inbox.json` 不被读写 — `plan-docs`；实现期 `tests/request-tools.test.mjs`
- [R6] 交接文档包含宿主探针、实现顺序、命令、验收和回滚；新会话无需本会话上下文即可启动 — `plan-docs`
- [R7] 设计、提案、交接、demo、主题页/术语表的链接一致；`npm run check` 通过 — `publication`

## Risks

- **宿主宽度接口未确认。** 如果 `ctx.layout` 没有宽度 setter，窄栏只能切到面板内全宽收件箱，达不到真正的“展开宽侧栏”；必须先探针并在交接里记录。
- **文件打开依赖原生桌面。** `openWorkspacePath` 在无桌面或远端路径下会失败；UI 必须给出错误，不假装打开。
- **评审语义。** 本提案按用户评审请求设计；如果实际目标是转发自动 reviewer verdict，需要替换请求来源和动作语义。
- **主题状态分叉。** 只有 authorization 改主题阻塞；其他 pending 请求时主题仍可能显示运行中。后续若要求统一阻塞，需要另一次状态模型变更。
- **重复来源。** authorization 同时有主题记录、请求记录和通知账本；实现必须抑制通知流重复卡。
- **宽度/滚动回归。** 两列加固定主题栏可能挤压原有主题卡；381px 以下和 648px 默认宽度都要真机验证。
- **请求量增长。** 每项目最多 200 个请求文件；超出后需要归档/裁剪策略，首版只拒绝新增或显示截断，不静默删除。
- **A2 仍延期。** 本方案不解决主会话/主题会话的 1:1 会话提醒卡（KI-40）。

## Delivery stages

1. **宿主探针。** 确认宽度控制、`openWorkspacePath`、`prompt` 行为，记录 A2 不可用；先不改代码。
2. **后端存储与工具。** request schema/store/service/tools、activity、authorization 桥接；单测覆盖幂等、冲突、角色、路径。
3. **API 与只读前端。** inbox 契约/路由、客户端 API、视图模型、宽窄布局、pending 卡片和通知；先不接动作。
4. **动作与对话。** resolve/open、四类卡动作、右侧回复、错误回执、文件打开和主题唤醒。
5. **真实 GUI 与收口。** 648/900/400px 宽度、滚动、筛选、完整四类请求、全量检查、文档和 feature-todos 更新。

## Links

- [设计](../../../../docs/design/cowork-sidebar/topic-inbox.md)
- [交接](../../../../docs/TOPIC_INBOX_HANDOFF.md)
- [主题页](../../../../docs/design/cowork-sidebar/topic-page.md)
- [收件箱交互稿](../../../../docs/discussion/topic-reminder-demo.html)
