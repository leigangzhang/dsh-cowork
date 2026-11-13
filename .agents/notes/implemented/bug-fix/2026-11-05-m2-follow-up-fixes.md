# Decision: M2 收口修复（review 遗留缺陷、证据补强与设施整理）

Status: implemented
Date: 2026-11-05
Class: bug-fix

## Problem

M2 已交付九个工具、记忆注入、thread checkout 隔离与真实宿主 E2E，但独立审查留下了 1 条 medium 与 15 条 low 缺陷/观察，且全部落在 M2 自己的范围内：合并 teardown 不是事务、冲突路径与 sessionId 校验缺失、memory/checkout/memory-prompt 三模块的边界与类型债、E2E 驱动超过单文件指引且证据含 hostname。另有一处证据缺口：E2E 只证明了「另一个 thread 能检索到记忆」，没有证明「记忆块真的进入模型可见的 system prompt」。按阶段归属约定，这些必须在 M2 收口前修掉。原始审查与交付背景见 [M2 结果](../../../../docs/archived/results/M2_RESULT.md) 与 [M2 implemented note](../feature/2026-11-05-m2-memory-checkout.md)。

## Decision

修复按三条互不重叠的流实现，并在 worktree 中并行完成；队长串行合并后重跑门禁与真实宿主 E2E。

**R1：merge teardown 与工具/会话边界**

- `cowork_checkout_merge` 在 `git merge` 成功后把 `resolveByPath`、`removeCheckout`、`deleteWorkspace`、`archiveSession`、`updateThread` 编排为有序步骤；每步独立捕获异常，索引更新最后且无条件执行，工具始终返回 `ok:true`、`cleanupErrors` 携带失败明细。merge 已经落地，因此 teardown 失败不能改报为 merge 失败，也不能诱发第二次 merge。
- 抽取 host-free 的 [`src/checkout-teardown.ts`](../../../../src/checkout-teardown.ts) 承载上述编排，`src/tools.ts` 只注入宿主端口；这样故障注入可以在 `node --test` 下覆盖，不依赖 `@deepseek-ai/dsh-tools`。
- 冲突路径的 `updateThread` 失败保留 `checkout/merge-conflict` 主结果，并在 `details.statusUpdateError` 暴露索引错误。
- `createCheckoutThread` 在 rename 前校验宿主返回的 `sessionId` 与请求的 `threadId` 一致；不一致立即失败，不 rename、不写索引。

**R2：checkout 错误映射与 E2E 证据设施**

- `mergeCheckout` 在冲突和 `MERGE_HEAD` 两条路径都检查 `git merge --abort` 的退出码；abort 失败返回 `checkout/git-failed`，`details` 标明 `stage='abort'`、`mergeStage`、双方 stderr 与 exitCode，不谎报清理完成。
- 所有 `details.stderr` 经统一上限（`STDERR_DETAIL_LIMIT = 2000`）截断并标记 `stderrTruncated`；`mkdirSync` 失败映射为 `checkout/create-failed`。
- E2E 驱动拆成 [`src/m2-e2e.ts`](../../../../src/m2-e2e.ts) 与 [`src/m2-e2e-support.ts`](../../../../src/m2-e2e-support.ts) 两个文件，各自 ≤50 KB。证据 host 块移除 hostname。
- 新增第 5 步 `memory-visible`：prompt 只给约束标题与来源说明，不包含期望文本；约束值带固定 nonce `M2-E2E-CONSTRAINT-7F3A`，断言 thread 回复包含该文本且本步工具调用为 0。这样回复只能来自 system prompt 中的记忆块。

**R3：memory-prompt 与契约**

- `renderMemory` 返回 `null` 时清空 per-agent 缓存，恢复渲染后不返回旧文本。
- `duplicateSkipped()` 按唯一 agent 计数，同一 agent 的重复失败事件不重复计数。
- PLAN §5.6 的成功 teardown 顺序改为实现实际顺序，并写明 `resolveByPath` 必须先于 `removeCheckout` 的 realpath 原因；`PANEL_HANDOFF` 已是 `checkoutPath`，无需改动。

**收口**

- 三条流合并后运行 `npm test`、`npm run typecheck`、`npm run build`、`npm run check`，再在最终字节上运行真实宿主 M2 E2E。
- 提案移入 `implemented/bug-fix/`；[M2 结果](../../../../docs/archived/results/M2_RESULT.md)、[M2 交接](../../../../docs/archived/handoffs/M2_HANDOFF.md)、[修复交接](../../../../docs/archived/handoffs/M2_FIX_HANDOFF.md) 与 [KNOWN_ISSUES](../../../../docs/KNOWN_ISSUES.md) 同步。已修项不再写入 `KNOWN_ISSUES`。

## Alternatives considered

**只修 medium（I1），其余 low 记入 KNOWN_ISSUES。** 否决：这些 low 都在 M2 自己的文件与契约里，修复是局部改动；留到 M3 等于让下一阶段替本阶段清账。

**把全部遗留推到 M3。** 否决：违反阶段归属约定，M3 的 review 门禁与面板会被无关噪音拖慢，且 M3 没有 M2 的上下文。

**重写 E2E 驱动而不是拆分。** 否决：拆分不改变行为；重写会丢掉已验证的竞态处理（handoff 唤醒、幂等 merge、状态轮询），收益不抵风险。

**为「模型可见性」另起一个独立探针。** 否决：复用现有场景加一步最便宜，证据落在同一份 JSON 里，便于一个文件复核。

**保留内嵌期望文本的 memory-visible prompt。** 否决：prompt 自带答案时，模型无需读取 system prompt 也能复述，证明是循环的。改为标题+来源提法，并使用不可猜 nonce。

## Consequences

- merge 成功后 teardown 失败不再表现为 merge 失败；调用方读 `cleanupErrors` 分辨「已合并但未清理干净」的现场，不应重试 merge。
- `cowork_checkout_merge` 的冲突响应可能多出 `statusUpdateError`；这是向后兼容的附加字段。
- sessionId 不一致的 isolated thread 创建现在会在 rename/索引前失败；补偿清理仍由工具层负责。
- E2E 证据从 10 步变为 11 步，hostname 不再落盘；最终证据文件仍位于 gitignored 的 `.dsh-cowork/e2e/M2_E2E.json`。
- 固定 nonce 在源码中可见，但 E2E thread 的 prompt 与工具通道都不包含它；它以「不可由常识猜中」作为模型可见性的证据门槛，不作为密钥。
- 为保持本地可追溯性，证据中仍保留 `repoPath` 与 fixture 绝对路径；该文件不提交、不发布。若未来证据需要对外流转，应另起脱敏提案。

## Testing

- [F1] merge 成功后的 teardown 任一步失败：工具仍返回 `ok:true` 且 `cleanupErrors` 非空，索引更新被执行 — `source`、`tests`：[`tests/tools.test.mjs`](../../../../tests/tools.test.mjs) 覆盖 resolve/remove/delete/archive/index 各步故障注入；[`tests/session-slice.test.mjs`](../../../../tests/session-slice.test.mjs) 覆盖会话创建边界；E2E `merge-success` 在最终宿主上返回 `cleanupErrors:[]`。
- [F2] 冲突路径 updateThread 失败不吞错；createCheckoutThread 在宿主返回不同 sessionId 时报错且不写索引 — `source`、`tests`：[`tests/session-slice.test.mjs`](../../../../tests/session-slice.test.mjs) 断言 mismatch 时 rename 0 次；[`tests/tools.test.mjs`](../../../../tests/tools.test.mjs) 覆盖 `applyThreadStatus` 的失败明细；E2E `conflict-merge`/`conflict-retry` 覆盖真实冲突与重试。
- [F3] memory：来源时间策略写进契约与测试；`MemoryValidationIssue.field` 含 `'kind'` 且无 cast；`renderMemoryEntry` 使用注入时钟 — `source`、`tests`：[`tests/memory.test.mjs`](../../../../tests/memory.test.mjs)。
- [F4] checkout：abort 失败返回 `checkout/git-failed`；`details.stderr` 截断并标注；`mkdirSync` 失败映射 `checkout/create-failed` — `source`、`tests`：[`tests/checkout.test.mjs`](../../../../tests/checkout.test.mjs)。
- [F5] memory-prompt：`renderMemory` 返回 null 后缓存清空；`duplicateSkipped` 按 agent 计数 — `source`、`tests`：[`tests/memory-prompt.test.mjs`](../../../../tests/memory-prompt.test.mjs)。
- [F6] E2E：驱动每个文件 ≤50 KB；证据不含 hostname；新增「模型复述约束」步骤且断言回复包含该约束 — `source`、`tests`：[`tests/m2-e2e.test.mjs`](../../../../tests/m2-e2e.test.mjs) 锁定 11 步顺序、文件预算、host 字段与 prompt 不含答案；真实宿主 run `m2-a91984c0-4840-4bc0-bcd1-74fe22d0e679` 的 `memory-visible` 3/3 断言通过，`toolCalls=0`。
- [F7] 契约与文档：PLAN §5.6 teardown 顺序与实现一致；`PANEL_HANDOFF` 用 `checkoutPath`；M2_RESULT/M2_HANDOFF/KNOWN_ISSUES 交叉链接且无重复 — `publication`：`npm run check` 通过。
- [F8] 全部门禁与真实宿主 E2E 在最终字节上重跑通过：`npm test` 227/227、`npm run typecheck` exit 0、`npm run build` exit 0、`npm run check` exit 0；E2E 11/11 步通过，最终索引两条 thread 均为 `done`/`checkoutPath=null`，fixture 已清理 — `packaging`、`publication`、`source`。

## Delivery stages

1. R1/R2/R3 三个 worktree 并行修复，独立 review 与交叉验证 — 已完成。
2. 队长串行合并、主树四条命令、真实宿主 E2E — 已完成。
3. 文档收口、独立最终复审与审阅分支推送 — 已交付。
