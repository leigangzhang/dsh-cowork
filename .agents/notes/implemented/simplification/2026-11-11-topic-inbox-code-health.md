# Decision: 请求收件箱代码健康度收敛（答案落点、共享基础件与职责拆分）

Status: implemented
Date: 2026-11-11
Class: simplification

## Problem

PR #28 把右侧栏请求收件箱落成了可用功能，但静态审计发现结构债已经影响正确性和后续修改成本：

- **question 的用户答案没有落点。** `resolveRequest` 只在内存里校验 `answers`，随后 `applyResolution` 只写 `status`、`resolutionMessage`、`resolvedAt`、`resolvedBy`；`RequestRecordV1` 没有 answers 字段，主题收到的 prompt 也只是“已回答全部问题。”这一固定句。用户选择、自由文本和完整评论都没有进入持久化记录或主题上下文。
- **authorization 是双状态源，且 prompt 早于卡片终态。** 主题的 `authorization` 与 `requests/<requestId>.json` 分别保存决策状态；inbox 路径先调用 `decideAuthorization` 解锁主题、更新通知并 prompt，之后才写请求卡片。卡片写入失败时会留下“主题已解锁并继续、卡片仍 pending”的窗口。旧 `authorization.resolve` 又通过 `settleAuthorizationRequestRecord` 走另一条结算路径。
- **同一业务规则有前后端两份实现。** 服务端 `answerProblems` 与前端 `answerCoversQuestion` 各自判断“是否已答”，测试里需要用“exactly like the host”防止漂移；客户端 `client/api.ts` 已把 wire payload 解析成 typed payload，`inbox-model.ts` 又对四种 payload 做了一遍归一化。
- **store 基础件重复。** `request-store.ts` 重新定义了文件模式、目录模式、锁等待、锁文件名，并复制 `fsyncDirectory`、`readTextIfPresent` 和 JSON 原子写；这些在 `store.ts`、`notice-store.ts`、`probe-store.ts` 已有实现。锁文件名和等待时间分叉会直接影响跨 writer 的正确性。
- **测试基础设施复制严重。** 新增测试里 `withRepo` 4 份、`seedProject` 3 份、`seedRequest` 2 份、完整 `topic` fixture 3 份、TS loader 5 份；路由清单和工具名清单又分别散落在 4 个测试文件。新增一条路由或工具需要同步改多处。
- **存在只被测试引用或完全无引用的导出。** `actionOfStatus`、`actionsOfKind` 零引用；`needsYouBanner` 只被测试引用；`INBOX_COLUMN_MIN_PX`、`TOPIC_COLUMN_WIDTH_PX`、`INBOX_COLUMN_GAP_PX` 只被测试引用，实际 CSS 使用硬编码 `318px / 280px / 12px`。
- **契约词汇重复。** 8 个 inbox 错误码同时写在 `inbox-contract.ts` 和 `api-contract.ts`；通知类型在 `notices.ts`、`client/notice-model.ts`、`inbox-contract.ts` 各有一份列表，并用 cast 桥接。

这些债的直接成本是：改一条答题规则、一个请求字段或一条路由，都要在 2–4 个文件里重复修改；测试可以因为常量被测试引用而保持绿色，但生产布局或行为已经脱节；授权失败窗口还会留下用户可见的状态不一致。

## Decision

按提案的五个交付阶段完成收敛：

1. **P0 正确性。** `src/inbox-contract.ts` 增加 `RequestResolution`（`comment?` + `answers?`）并挂到 `RequestRecordV1.resolution`（additive optional，version 仍是 1）；`applyResolution` 写入完整答案和 comment，`resolutionMessage` 保持 ≤200 字符并包含答案摘要；新增 `resolutionPrompt(record)` 重建主题 prompt（题目、选项 label、自由文本、完整 comment），旧记录回退到 `resolutionMessage`。`resolveAuthorizationDecision` 增加 `deferPrompt` 和 `promptText`：先提交解锁、通知和 activity，返回 prompt 文本；inbox 路由与旧 `authorization.resolve` 路由都在卡片进入终态之后才调用 `promptRequestTopic`，投递结果用 `RequestStore.recordDelivery` 补写，prompt 失败只进 `delivery.lastError`。
2. **P1 共享规则与单层解析。** `answerCoversQuestion` 移入 `src/inbox-contract.ts`，服务端 `answerProblems` 与前端 submit gate 共用；`InboxRequestItem` 改为按 `requestKind` 判别的联合类型，`src/client/api.ts` 是唯一 wire parser，`src/client/inbox-model.ts` 删除四份重复 payload 归一化。
3. **P1 契约词汇。** 新增 `src/notice-contract.ts`（`NOTICE_KINDS`/`NoticeKind`/`isNoticeKind`），`notices.ts`、`client/notice-model.ts` 与 `inbox-contract.ts` 从同一列表派生（inbox 去掉 authorization、追加 `review-verdict`）；`PanelErrorCode` 并入 `InboxErrorCode`，inbox 错误码和 HTTP 状态只由 `inbox-contract.ts` 的 `INBOX_ERROR_STATUS` 定义，`api-contract.ts` 用 spread 复用。
4. **P1 基础件与测试收口。** 新增 `src/atomic-json.ts`（文件/目录模式、锁等待、锁文件名、目录 fsync、`readTextIfPresent`、`writeJsonAtomic`/`writeTextAtomic`、项目锁入口），`store.ts`、`notice-store.ts`、`request-store.ts`、`probe-store.ts` 复用同一实现；新增 `tests/support/ts-hook.mjs`、`tests/support/inbox-fixtures.mjs`、`tests/support/public-surface.mjs`，各测试套件只绑定自己的默认值；删除 `actionOfStatus`/`actionsOfKind`/`needsYouBanner`，把布局常量移入 `src/client/inbox-layout.ts` 并由 `styles.ts` 插值进 `PANEL_CSS`，`toInboxRequestItem`、`normalizeOptions` 不再导出。
5. **P2 结构拆分。** `src/request-service.ts`（拆分前 34.4 KB）退化为 1.4 KB 的薄再导出；实现按职责迁到 `src/request-lifecycle.ts`、`src/authorization-decision.ts`、`src/request-open.ts`，共享错误、store port 与成员守卫放在 `src/request-support.ts`。公共导出名保持不变。

未做项保持提案的范围：不删除旧 `.dsh-cowork/inbox.json` 与旧 `authorization.resolve` 路由，不把请求记录合并进 `ProjectIndexV2`，不新增请求类型，不改旧路由响应形状；authorization 的 index/request/activity 单锁事务仍未实现（见 Consequences 与 KI-45）。

## Alternatives considered

- **只修 question 答案，不收敛重复代码。** 否决：答案落点是正确性前置项，但不是完整方案；如果止步于此，答题规则、客户端解析、store 基础件和测试 fixture 仍会继续漂移。
- **把 request 记录合并进 `ProjectIndexV2`，用单一状态源消除双写。** 否决：每次回答、授权解决或通知更新都会重写项目索引，和主题/面板写争同一把锁；还要升级 schema、迁移旧记录并混入 `workItems`/review 语义。独立 `requests/` 文件是按请求增量写的正确边界，本次只把用户可见顺序改成“卡片先终态、主题后唤醒”。
- **删除旧 `.dsh-cowork/inbox.json` 和旧 `authorization.resolve` 路由。** 否决：两者仍是活跃兼容面；旧 inbox 服务 merge-needed/review-reject/blocked 等队列，旧授权路由仍保留给兼容调用方和 M12 probe。删除是兼容性决策，不是代码健康清理。
- **把所有共享逻辑都塞进 `inbox-contract.ts`。** 否决：contract 会继续膨胀成 god module，并混入文件 I/O、状态机和宿主 prompt；只把纯词汇和纯判定放进去，I/O 与编排留在各自模块。
- **让每个测试文件继续自带 fixture。** 否决：`withRepo`/`seedProject`/`topic`/loader 已经出现多份副本，新增字段时漏改的风险已经具体存在；共享模块只放无断言的 setup，测试专属断言和失败注入留在原文件。
- **继续用源码字符串断言来 pin CSS 和几何常量。** 否决：测试断言常量等于 318/280/12，但生产 CSS 用的是另一份硬编码；常量删掉测试仍可能绿，布局却已变。改为让 `styles.ts` 真正消费同一常量，并在测试里同时断言插值源码和最终 CSS。
- **一次性重写 `request-service.ts`。** 否决：模块同时承载生命周期、授权核心、旧路由桥接和文件打开，直接重写会把行为回归和结构改动混在一起；先完成 P0 正确性和共享规则，再按职责拆分。

## Consequences

- `resolution` 是 `RequestRecordV1` 的 additive optional 字段，仍标 version 1；旧版本读取会忽略它，回滚会丢失结构化答案但不会破坏请求状态。将来需要强校验或迁移时，再单独升 version 并保留 v1 reader。
- 双写窗口没有被完全消除：主题解锁与请求卡片仍是两次写，本记录只保证用户可见的 prompt 在卡片终态之后。若真实宿主出现“主题已解锁、卡片 pending”事例，应升级到单锁事务或补偿队列（已记入 KI-45）。
- 旧 `authorization.resolve` 的响应形状保持不变；prompt 推迟后仍只唤醒主题会话，master 不重复收到消息。卡片由旧路由结算时先以空 delivery 进入终态，prompt 后再补 `delivery`。
- `api-contract.ts` 不再“零依赖”：它 import 纯 `inbox-contract`（后者 import 纯 `notice-contract`），仍在浏览器 bundle 的安全面内；新增错误码必须先在 `INBOX_ERROR_CODES`/`INBOX_ERROR_STATUS` 里定义。
- `notice-contract.ts` 和 `inbox-contract.ts` 的共享面扩大后可能变成新的 god module；约束仍是只放纯常量/类型/纯函数，文件超过 20 KB 或出现 I/O 依赖时拆回。
- 测试支持层只收口了记录级 `topic` fixture；`tests/api-contract.test.mjs` 与 `tests/panel-model.test.mjs` 仍各自持有 wire/UI 形状的 `topic`，`tests/review-request.test.mjs` 仍有 store-first 的 `seedReviewProject`——它们建模的是不同对象，强行合并会把两种契约混成一份。
- `request-service.ts` 拆分只按职责做，没有顺手重命名或改协议；入口保持再导出，调用方无需改动。
- 重估条件不变：出现新的 request kind；`inbox-contract.ts` 超过 20 KB；双写失败被真实观测；旧 `authorization.resolve` 计划移除；或共享 helper 引入循环依赖。

## Testing

- [A1] question submit 把完整 `answers` 和 comment 写入 `RequestRecordV1.resolution`；缺少 `resolution` 的旧记录仍能解析，非法 `resolution` 被拒绝 — `tests`
- [A2] question 的主题 prompt 包含所选选项 label、自由文本和完整 comment；右侧 `resolutionMessage` 包含答案摘要；prompt 回调读取请求文件时能看到终态和答案 — `tests`
- [A3] inbox 与旧 authorization 路由都在请求卡片进入终态之后才调用 `promptSession`；prompt 失败只写 `delivery.lastError`，重试不重复 prompt — `tests`
- [A4] `answerCoversQuestion` 只在 `src/inbox-contract.ts` 定义一次，服务端 `answerProblems` 与前端 submit gate 都引用它；生产代码不再有第二份“是否已答”判定 — `source`
- [A5] `client/api.ts` 是唯一 wire payload parser；`inbox-model.ts` 不再包含 `reviewPayloadOf`/`authorizationPayloadOf`/`questionPayloadOf`/`planPayloadOf` — `source`
- [A6] `store.ts`、`notice-store.ts`、`request-store.ts`、`probe-store.ts` 都从 `atomic-json` 导入文件模式、锁常量和原子写/fsync helper，不再各自定义 — `source`
- [A7] `withRepo`、`seedProject`、`seedRequest`、`topic` 模板、`HOOK_SOURCE`、面板路由清单和业务工具清单各只有一个定义；相关测试全部导入同一份 — `tests`
- [A8] 删除 `actionOfStatus`/`actionsOfKind`/`needsYouBanner`；布局常量由 `styles.ts` 实际消费，测试同时断言插值源码和最终 CSS 值 — `tests`
- [A9] `request-service.ts` 为 1.4 KB 薄再导出（拆分前 34.4 KB，目标 ≤30 KB），实现按生命周期/授权/文件打开拆分；所有 `src/**/*.ts`/`*.tsx` 仍在 50 KiB 读上限内 — `source`
- [A10] 本记录移动到 `.agents/notes/implemented/simplification/` 并改写为 Decision/Consequences/Testing；`npm run check` 通过 — `decisions`
- [C1] 四命令证据：`npm run typecheck`、`npm run build`、`npm test`（977/977）、`npm run check` 与 `npm run check:self-test` 全部通过 — `tests`
