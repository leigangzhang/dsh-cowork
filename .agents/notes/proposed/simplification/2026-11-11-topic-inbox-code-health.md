# Proposal: 请求收件箱代码健康度收敛（答案落点、单一规则、共享基础件与测试收口）

Status: proposed
Date: 2026-11-11
Class: simplification

## Problem

PR #28 把右侧栏请求收件箱落成了可用功能，但静态审计发现结构债已经影响正确性和后续修改成本。以下问题都是当前代码事实，不是风格偏好：

- **question 的用户答案没有落点。** `resolveRequest` 只在内存里校验 `answers`，随后 `applyResolution` 只写 `status`、`resolutionMessage`、`resolvedAt`、`resolvedBy`；`RequestRecordV1` 没有 answers 字段，主题收到的 prompt 也只是“已回答全部问题。”这一固定句。用户选择、自由文本和完整评论都没有进入持久化记录或主题上下文。[request-service.ts](../../../../src/request-service.ts#L203-L223)、[request-schema.ts](../../../../src/request-schema.ts#L500-L524)、[inbox-contract.ts](../../../../src/inbox-contract.ts#L265-L283)、[inbox.tsx](../../../../src/client/inbox.tsx#L403-L416)
- **authorization 是双状态源，且 prompt 早于卡片终态。** 主题的 `authorization` 与 `requests/<requestId>.json` 分别保存决策状态；inbox 路径先调用 `decideAuthorization` 解锁主题、更新通知并 prompt，之后才写请求卡片。卡片写入失败时会留下“主题已解锁并继续、卡片仍 pending”的窗口。旧 `authorization.resolve` 又通过 `settleAuthorizationRequestRecord` 走另一条结算路径。[topic-tools.ts](../../../../src/topic-tools.ts#L585-L606)、[request-service.ts](../../../../src/request-service.ts#L211-L224)、[request-service.ts](../../../../src/request-service.ts#L599-L659)
- **同一业务规则有前后端两份实现。** 服务端 `answerProblems` 与前端 `answerCoversQuestion` 各自判断“是否已答”，测试里需要用“exactly like the host”防止漂移；客户端 `client/api.ts` 已把 wire payload 解析成 typed payload，`inbox-model.ts` 又对四种 payload 做了一遍归一化。[request-schema.ts](../../../../src/request-schema.ts#L306-L364)、[inbox-model.ts](../../../../src/client/inbox-model.ts#L320-L352)、[client/api.ts](../../../../src/client/api.ts#L286-L365)、[inbox-model.ts](../../../../src/client/inbox-model.ts#L227-L305)
- **store 基础件重复。** `request-store.ts` 重新定义了文件模式、目录模式、锁等待、锁文件名，并复制 `fsyncDirectory`、`readTextIfPresent` 和 JSON 原子写；这些在 `store.ts`、`notice-store.ts`、`probe-store.ts` 已有实现。锁文件名和等待时间分叉会直接影响跨 writer 的正确性。[request-store.ts](../../../../src/request-store.ts#L35-L62)、[request-store.ts](../../../../src/request-store.ts#L247-L253)、[store.ts](../../../../src/store.ts#L81-L91)、[notice-store.ts](../../../../src/notice-store.ts#L19-L24)
- **测试基础设施复制严重。** 新增测试里 `withRepo` 4 份、`seedProject` 3 份、`seedRequest` 2 份、完整 `topic` fixture 3 份、TS loader `HOOK_SOURCE` 5 份；路由清单和工具名清单又分别散落在 4 个测试文件。新增一条路由或工具需要同步改多处。[request-store.test.mjs](../../../../tests/request-store.test.mjs#L41-L48)、[request-service.test.mjs](../../../../tests/request-service.test.mjs#L100-L132)、[request-tools.test.mjs](../../../../tests/request-tools.test.mjs#L105-L122)、[inbox-api.test.mjs](../../../../tests/inbox-api.test.mjs#L67-L87)、[dev-gate.test.mjs](../../../../tests/dev-gate.test.mjs#L55-L115)、[source-budget.test.mjs](../../../../tests/source-budget.test.mjs#L110-L132)
- **存在只被测试引用或完全无引用的导出。** `actionOfStatus`、`actionsOfKind` 零引用；`needsYouBanner` 只被测试引用；`INBOX_COLUMN_MIN_PX`、`TOPIC_COLUMN_WIDTH_PX`、`INBOX_COLUMN_GAP_PX` 只被测试引用，实际 CSS 使用硬编码 `318px / 280px / 12px`。[request-schema.ts](../../../../src/request-schema.ts#L610-L623)、[inbox-model.ts](../../../../src/client/inbox-model.ts#L41-L51)、[inbox-model.ts](../../../../src/client/inbox-model.ts#L601-L607)、[styles.ts](../../../../src/client/styles.ts#L654-L657)
- **契约词汇重复。** 8 个 inbox 错误码同时写在 `inbox-contract.ts` 和 `api-contract.ts`；通知类型在 `notices.ts`、`client/notice-model.ts`、`inbox-contract.ts` 各有一份列表，并用 cast 桥接。[inbox-contract.ts](../../../../src/inbox-contract.ts#L373-L385)、[api-contract.ts](../../../../src/api-contract.ts#L341-L348)、[inbox-api.ts](../../../../src/inbox-api.ts#L143-L145)、[notices.ts](../../../../src/notices.ts#L34-L37)、[notice-model.ts](../../../../src/client/notice-model.ts#L19-L23)

这些债的直接成本是：改一条答题规则、一个请求字段或一条路由，都要在 2–4 个文件里重复修改；测试可以因为常量被测试引用而保持绿色，但生产布局或行为已经脱节；授权失败窗口还会留下用户可见的状态不一致。PR #28 的修复批次已经为旧授权路由补过一次桥接，说明双路径成本不是假想。

本提案只创建决策记录，不写生产代码。实现按下面四个阶段分步落地，每个阶段独立可验证。

## Proposal

**1. 补齐 question 的解决载荷，并让 prompt 携带答案。** 在 [src/inbox-contract.ts](../../../../src/inbox-contract.ts) 增加纯数据类型：

```ts
export interface RequestResolution {
  readonly comment?: string
  readonly answers?: readonly InboxAnswerInput[]
}
```

`RequestRecordV1` 增加可选字段 `resolution?: RequestResolution`；保持 `REQUEST_RECORD_VERSION = 1`，旧记录没有该字段时仍按原样解析，新记录写入完整 comment 和 answers。`ResolutionPatchInput` 增加 `answers?`，`applyResolution` 把答案写入 `resolution`，`resolutionMessage` 仍保持 ≤200 字符的展示摘要；新增 `resolutionPrompt(record): string`（建议放在 `src/request-schema.ts`）把问题文本、选项 label、自由文本和完整 comment 拼成主题 prompt，而不是只发“已回答全部问题。”。`resolveRequest` 在 question submit 时把 `input.answers` 传给 `applyResolution`，`promptTopic` 对有 `resolution` 的记录使用 `resolutionPrompt`。旧记录缺少 `resolution` 时继续使用现有 `resolutionMessage`。

**2. 把 authorization prompt 推迟到卡片终态之后。** 在 [src/request-service.ts](../../../../src/request-service.ts) 的 `AuthorizationDecisionInput` 增加 `deferPrompt?: boolean`，`AuthorizationDecisionOutcome` 增加 `promptText: string | null`。`deferPrompt` 为真时只提交主题解锁、通知和 activity，返回 prompt 文本，不调用 `promptSession`；`resolveRequest` 在 `store.update` 把卡片写成终态、追加 `request-resolved` 之后，再调用 `promptTopic(input, next, decision.promptText)`。旧 `authorization.resolve` 路由也改成“先 `deferPrompt` 决策，再 `settleAuthorizationRequestRecord`，再 prompt”，并用 `RequestStore.recordDelivery` 补投递结果，保持原响应形状。

这不能消除两个 state 源，但把用户可见的顺序改成“卡片先终态、主题后唤醒”。如果卡片写入失败，主题已解锁但不会被 prompt；重试时 `resolveAuthorizationDecision` 会从 activity 读到已记录决策并返回幂等结果，卡片可以继续收敛。完整的单锁事务留给第 4 阶段评估，不在本阶段承诺。

**3. 收口共享规则与单层解析。** 把 `answerCoversQuestion` 移到 [src/inbox-contract.ts](../../../../src/inbox-contract.ts) 作为纯函数；服务端 `answerProblems` 和前端 `inbox-model.ts` 都调用它，删除前端重复实现。把 `InboxRequestItem` 改成按 `requestKind` 判别的联合类型，使 `payload` 能随 kind 收窄；[src/client/api.ts](../../../../src/client/api.ts) 仍是唯一的 wire parser，`inbox-model.ts` 删除 `reviewPayloadOf`、`authorizationPayloadOf`、`questionPayloadOf`、`planPayloadOf` 等重复归一化函数，直接消费 `item.payload`。

**4. 抽出共享原子 JSON 存储层。** 新增 `src/atomic-json.ts`（或同等命名）导出 `FILE_MODE`、`DIR_MODE`、`LOCK_WAIT_MS`、`LOCK_FILE_NAME`、`fsyncDirectory`、`readTextIfPresent`、`writeJsonAtomic`；[src/store.ts](../../../../src/store.ts)、[src/notice-store.ts](../../../../src/notice-store.ts)、[src/request-store.ts](../../../../src/request-store.ts)、[src/probe-store.ts](../../../../src/probe-store.ts) 改为复用同一实现。`request-store.ts` 只保留请求目录、扫描、排序和请求 schema 相关逻辑。共享层必须保持现有 0600/0700、目录 fsync 和 5 秒锁等待语义。

**5. 收口契约词汇。** 新增 `src/notice-contract.ts` 存放 `NOTICE_KINDS`/`NoticeKind` 等纯词汇；[src/notices.ts](../../../../src/notices.ts)、[src/client/notice-model.ts](../../../../src/client/notice-model.ts) 和 `inbox-contract.ts` 从这里导入，`INBOX_NOTIFICATION_KINDS` 由共享列表派生并追加 `review-verdict`。`PanelErrorCode` 改为包含 `InboxErrorCode`，`PANEL_ERROR_STATUS` 用 `Record<PanelErrorCode, number>` 保证完整性；删除 `api-contract.ts` 里手写的 8 个 inbox code 副本。

**6. 建立测试支持层。** 新增 `tests/support/ts-hook.mjs`、`tests/support/inbox-fixtures.mjs`、`tests/support/public-surface.mjs`。前者只注册 TS loader；中者提供 `NOW`、`MASTER`、`TOPIC`、`topic()`、`withRepo()`、`seedProject()`、`seedRequest()`、`fakeHost()` 等 fixture；后者提供唯一一份面板路由清单和业务工具清单（可同时供 `dev-gate`、`api`、`api-contract`、`project-tools`、`source-budget` 使用）。只共享完全相同的 setup，测试专属断言仍留在各测试文件。

**7. 清理死导出与布局常量。** 删除 `actionOfStatus`、`actionsOfKind`、`needsYouBanner`；把 `INBOX_COLUMN_MIN_PX`、`TOPIC_COLUMN_WIDTH_PX`、`INBOX_COLUMN_GAP_PX` 移到 `src/client/inbox-layout.ts`，由 `styles.ts` 插值进 `PANEL_CSS`，由 `panel.tsx`/测试导入，避免测试断言与生产 CSS 脱节。`INBOX_ERROR_CODES` 保留为唯一 code 列表；`InboxErrorCode` 成为 `PanelErrorCode` 的组成部分；不再从 `inbox-api.ts` 导出仅内部使用的 `toInboxRequestItem`，不再从 `request-schema.ts` 导出仅内部使用的 `normalizeOptions`。

**8. 结构拆分（条件执行）。** 如果第 1–2 阶段完成后 [src/request-service.ts](../../../../src/request-service.ts) 仍超过 30 KB，则按职责拆为 `src/request-lifecycle.ts`（create/resolve/prompt）、`src/authorization-decision.ts`（授权决策与旧路由结算）、`src/request-open.ts`（文件打开与路径守卫）；`request-service.ts` 退化为薄再导出，避免一次性改所有调用方。拆分以行为测试通过为前提，不做顺手重命名。

**不在本提案范围：** 删除旧 `.dsh-cowork/inbox.json` 或旧 `authorization.resolve` 路由（它们仍是活跃兼容面）；把请求记录合并进 `ProjectIndexV2`；重做收件箱 UI；新增请求类型；把旧路由的响应形状改成新协议。

## Alternatives considered

**只修 question 答案，不收敛重复代码。** 这是第 1 阶段的内容，但不是完整方案。答案落点是正确性前置项，必须最先做；如果止步于此，答题规则、客户端解析、store 基础件和测试 fixture 仍会继续漂移，下一次改 question/authorization 还要重复付成本。

**把 request 记录合并进 `ProjectIndexV2`，用单一状态源消除双写。** 否决：每次 question 回答、授权解决或通知更新都会重写项目索引，和主题/面板写争同一把锁；还需要升级 schema、迁移旧记录，并把旧 `workItems`/review 语义混进来。独立 `requests/` 文件是按请求增量写的正确边界；本提案用“先卡片终态、后 prompt”缩小窗口，完整单锁事务另行评估。

**删除旧 `.dsh-cowork/inbox.json` 和旧 `authorization.resolve` 路由。** 否决：两者仍是活跃兼容面，旧 inbox 服务 merge-needed/review-reject/blocked 等队列，旧授权路由仍保留给兼容调用方和 M12 probe；删除是兼容性决策，不是代码健康清理。

**把所有共享逻辑都塞进 `inbox-contract.ts`。** 否决：contract 会从 442 行继续膨胀成 god module，并混入文件 I/O、状态机和宿主 prompt；只把纯词汇和纯判定（如 `answerCoversQuestion`）放进去，I/O 与编排留在各自模块。

**让每个测试文件继续自带 fixture，避免跨测试 import。** 否决：当前 `withRepo`/`seedProject`/`topic`/`HOOK_SOURCE` 已经出现 3–5 份副本，新增字段时漏改的风险已经具体存在；共享模块只放无断言的 setup，不会降低测试独立性。

**继续用源码字符串断言来 pin CSS 和几何常量。** 否决：现有测试断言常量等于 318/280/12，但生产 CSS 用的是另一份硬编码；常量删掉测试仍可能绿，布局却已变。改为让 `styles.ts` 真正消费同一常量，并保留少量 data-testid 契约断言。

**一次性重写 `request-service.ts`。** 否决：795 行、31.4 KB 的模块同时承载生命周期、授权核心、旧路由桥接和文件打开，直接重写会把行为回归和结构改动混在一起；先完成 P0 正确性和共享规则，再按第 4 阶段拆分。

## Acceptance criteria

- [A1] question submit 把完整 `answers` 和 comment 写入 `RequestRecordV1.resolution`；缺少 `resolution` 的旧记录仍能解析，非法 `resolution` 被拒绝 — `tests`
- [A2] question 的主题 prompt 包含所选选项 label、自由文本和完整 comment；右侧 `resolutionMessage` 包含答案摘要；prompt 回调读取请求文件时能看到终态和答案 — `tests`
- [A3] inbox 与旧 authorization 路由都在请求卡片进入终态之后才调用 `promptSession`；prompt 失败只写 `delivery.lastError`，重试不重复 prompt — `tests`
- [A4] `answerCoversQuestion` 只在 `src/inbox-contract.ts` 定义一次，服务端 `answerProblems` 与前端 submit gate 都引用它；生产代码不再有第二份“是否已答”判定 — `source`
- [A5] `client/api.ts` 是唯一 wire payload parser；`inbox-model.ts` 不再包含 `reviewPayloadOf`/`authorizationPayloadOf`/`questionPayloadOf`/`planPayloadOf` 等重复归一化 — `source`
- [A6] `store.ts`、`notice-store.ts`、`request-store.ts` 都从共享 `atomic-json` 层导入文件模式、锁常量和原子写/fsync helper；三处不再各自定义 `fsyncDirectory`/`readTextIfPresent`/`FILE_MODE`/`LOCK_WAIT_MS` — `source`
- [A7] `withRepo`、`seedProject`、`seedRequest`、`topic`、`HOOK_SOURCE`、面板路由清单和业务工具清单各只有一个定义；相关测试全部导入同一份 — `tests`
- [A8] 删除 `actionOfStatus`/`actionsOfKind`/`needsYouBanner`；布局常量由 `styles.ts` 实际消费，测试不再只断言常量字面量 — `tests`
- [A9] `request-service.ts` 不超过 30 KB，或按生命周期/授权/文件打开拆分；所有 `src/**/*.ts`/`*.tsx` 仍在 50 KiB 读上限内；`npm run typecheck`、`npm run build`、`npm test`、`npm run check` 全部通过 — `source` + `tests`
- [A10] 实现落地时本记录移动到 `.agents/notes/implemented/simplification/`，改写为 `## Decision`、`## Consequences`、`## Testing`，并保留 criteria id 到 `## Testing`；`npm run check` 通过 — `decisions`

## Risks

- `resolution` 是 `RequestRecordV1` 的 additive optional 字段，仍标 version 1；旧版本读取会忽略它，回滚会丢失结构化答案但不会破坏请求状态。如果未来需要强校验或迁移，再单独升 version 并保留 v1 reader。
- 把 authorization prompt 推迟到卡片终态之后会改变事件顺序；旧路由必须保持响应形状和 `prompted`/`promptError` 语义，测试要覆盖“卡片写失败不 prompt、重试只 prompt 一次”。
- 双写窗口没有被完全消除：主题解锁与请求卡片仍是两次写；本提案只保证用户可见的 prompt 在卡片终态之后。若真实宿主出现“主题已解锁、卡片 pending”事例，应升级到单锁事务或补偿队列。
- `notice-contract.ts` 和 `inbox-contract.ts` 的共享面扩大后可能变成新的 god module；约束是只放纯常量/类型/纯函数，文件超过 20 KB 或出现 I/O 依赖时拆回。
- 抽 `atomic-json` 层时如果改变 mode、fsync 或锁等待语义，会影响所有 store；实现必须先用现有 `tests/request-store.test.mjs`、`tests/notice-model.test.mjs`、`tests/store.test.mjs` 证明行为不变。
- 测试 fixture 共享可能掩盖各层真正不同的 setup；只共享完全相同的临时目录、索引 seed 和 fake host，测试专属断言和失败注入留在原文件。
- `request-service.ts` 拆分只按职责做，不顺手重命名或改协议；否则会和 P0 行为变更混在一起，难以回滚。
- 重估条件：出现新的 request kind；`inbox-contract.ts` 超过 20 KB；双写失败被真实观测；旧 `authorization.resolve` 计划移除；或共享 helper 引入循环依赖。

## Delivery stages

1. **P0 正确性。** 增加 `RequestResolution`/`resolution`，持久化 question answers 和完整 comment，prompt 携带答案；authorization prompt 改为卡片终态后执行，inbox 与旧路由各补顺序/失败/幂等测试。对应 A1–A3。
2. **P1 共享规则与单层解析。** `answerCoversQuestion` 进入 `inbox-contract.ts`；`InboxRequestItem` 改成按 kind 判别的联合；删除 `inbox-model.ts` 重复 parser；错误码与通知类型收口。对应 A4–A5 和第 5 项提案。
3. **P1 基础件与测试收口。** 抽 `atomic-json` 层并迁移三个 store；建立 `tests/support/*`，合并 fixture 与公共 surface 清单；删除死导出，布局常量接入 CSS。对应 A6–A8。
4. **P2 结构拆分与事务评估。** 按需拆 `request-service.ts`；评估把 authorization 的 index、request、activity 写进同一项目锁的可行性和回滚方案。对应 A9。
5. **收口。** 把本提案移动到 `implemented/simplification/`，记录实际改动、测试证据、回滚方式和未做项；确认 A10。

## Links

- PR #28：<https://github.com/leigangzhang/dsh-cowork/pull/28>
- 收件箱设计：[topic-inbox.md](../../../../docs/design/cowork-sidebar/topic-inbox.md)
- 已实现决策：[2026-11-10-topic-inbox.md](../../implemented/feature/2026-11-10-topic-inbox.md)
- 实现交接：[TOPIC_INBOX_HANDOFF.md](../../../../docs/TOPIC_INBOX_HANDOFF.md)
- 测试策略：[testing.md](../../../../docs/testing.md)
- 既有遗留：[KNOWN_ISSUES.md](../../../../docs/KNOWN_ISSUES.md)
