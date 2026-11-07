# Decision: verdict 后必须唤醒 master（review 响应投递）

Status: implemented
Date: 2026-11-07
Class: bug-fix

## Problem

master 在 `cowork_review_request` 之后按协议结束回合等 verdict；但 `cowork_review_verdict` 只写 review 文件与索引，`needs_revision` / `reject` 时把 findings 投递给原 thread，**任何 verdict 都不投递给 master**。`pass` 连 thread 都不投递，于是 master 永远等不到响应。

现场证据（session `session-744f8f70-380d-4e38-b281-d9443ec7f6cf`，2026-11-07）：master 在 10:32:03 与 10:32:51 两次调用 `cowork_review_request`；第二轮 reviewer `session-3bec35ab…` 于 10:37:08.944Z 写入 `pass`（review 文件 `.dsh-cowork/reviews/session-bc935d5b…T103708944Z.json`，索引 `done/pass`）；同一时刻 master 的 turn 5 以 `completed` 结束，最后一段推理是「end turn and wait for verdict」，之后没有任何新 prompt。第一轮 `needs_revision` 之所以没卡住，是因为退回消息唤醒了 thread，thread 重新 handoff 又唤醒了 master——这是一条偶然的间接唤醒链，`pass` 没有任何下游事件可依赖。

## Decision

每次 verdict 都向 master 投递一条结构化消息：

- `src/review.ts` 新增 `formatVerdictMessage(record, { subject, status, reviewFilePath, threadDelivered })`：包含 verdict、thread 最终状态、summary、findings（带 file:line）、review 文件路径，以及下一步指令——`pass` 提醒「有 clone 就 `cowork_checkout_merge`，共享工作区直接验收」；`needs_revision` 提醒等下一次 handoff；`reject` 提醒报告阻塞并决定是否重规划。
- `src/review-tools.ts` 在写 review 文件、更新索引、投递 thread（仅 `needs_revision`/`reject`）之后，用 `promptSession(masterSessionId, …)` 投递 master。先投 thread 再投 master，这样 master 消息能如实区分 findings 是否已送达 thread（`threadDelivered:false` 时改为提示 master 手动补投）。
- 工具响应新增 `masterDelivered` / `masterDeliveryError`；原有 `delivered` / `deliveryError` 仍是 thread 投递结果。两者失败都不回滚 verdict（索引与 review 文件已落盘），下一次 `cowork_project_status` 仍能看到 `latestReviews`。
- `src/presets.ts` 的 master persona 改为「每次 verdict 都会以消息送达，不要静默等待」，并写明 pass/needs_revision/reject 三种处置。
- 文档同步：PLAN §5.7、README 使用流程第 5/6 步、routing.md 的 verdict 时序与判决表。

## Alternatives considered

**只在 `pass` 时投递 master。** 否决：`needs_revision` 的 master 同样需要知道本轮 review 已结束；现在它靠 thread 重新 handoff 的副作用被间接唤醒，一旦 thread 不再 handoff（或投递失败）就会复现同样的等待。每次 verdict 都投递才是对称的。

**让 master 自己轮询 `cowork_project_status`。** 否决：master 已经按协议结束回合，没有定时器或后台循环；要求它「等」就是当前故障。轮询需要在 master 回合里阻塞等待，反而更慢且更贵。

**把 verdict 写成 master 可读的文件/记忆，由下一轮自然地读到。** 否决：没有事件唤醒 master，文件本身不解决「谁在什么时候叫醒它」的问题。

**本次就加 `reviewDeliveredAt` 与 `cowork_project_status` 重放。** 否决（本次范围）：观察到的缺陷是「根本没有投递尝试」，加字段、迁移、重放逻辑与面板联动会显著扩大改动面；handoff 的重放机制保留为后续对称化，记入 KI-17，触发条件是真实观测到 prompt 失败导致 master 再次长等。

**由 reviewer 在最终回复里口述结果。** 否决：reviewer 的回复不是结构化事件，也没有路由保证；master 不会收到。

## Consequences

- master 在每次 review 结束后都会被唤醒并拿到可执行的下一步；`pass` 不再需要用户手动发消息去「推」master。
- `needs_revision` / `reject` 现在会产生两条投递（thread + master）；若 thread 投递失败，master 消息会明确说 findings 未送达，而不是假装成功。
- 投递失败不回滚 verdict；master 仍可能在 prompt 失败时继续等待，直到用户发话或它自己调用 `cowork_project_status`（KI-17）。这是本次明确接受的残余风险。
- 运行中的宿主仍装载旧代码（KI-16）：本次真机未重新跑一轮 review，host-free 契约测试覆盖了投递路径；宿主重启后新逻辑生效，下一轮真实 review 即为现场验证。

## Testing

- [RV1] `formatVerdictMessage` 对 pass / needs_revision / reject 输出 verdict、状态、findings、review 路径与下一步；thread 投递失败时改为提示补投 — `source`, `tests`
- [RV2] 契约测试：`pass` verdict 只 prompt master，不 prompt thread；索引 `done/pass`，review 文件落盘 — `tests`
- [RV3] 契约测试：`needs_revision` 先 prompt thread 再 prompt master，master 消息含 findings 与「已送达 thread」 — `tests`
- [RV4] 契约测试：master prompt 抛错时 verdict 仍成功、`masterDelivered:false` 且带 `masterDeliveryError`；thread prompt 被拒时 master 消息改为「未送达」 — `tests`
- [RV5] master persona、PLAN、README、routing.md 与实现一致；`npm run check` 通过；四命令全绿 — `publication`, `packaging`
