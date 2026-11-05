# Proposal: M2 收口修复（review 遗留缺陷、证据补强与设施整理）

Status: proposed
Date: 2026-11-05
Class: bug-fix

## Problem

M2 已交付（9 个工具、记忆注入、thread checkout 隔离、真实宿主 E2E），但独立审查留下了 1 条 medium 与 15 条 low 缺陷/观察，且**全部落在 M2 自己的范围内**：合并 teardown 不是事务、冲突路径与 sessionId 校验缺失、memory/checkout/memory-prompt 三模块的边界与类型债、E2E 驱动超单文件指引且证据含 hostname。另有一处证据缺口：E2E 只证明了「另一个 thread 能检索到记忆」，没有证明「记忆块真的进入模型可见的 system prompt」。按「阶段内问题不拖到下阶段」的约定，这些必须在 M2 收口前修掉，而不是记进 M3 的交接。证据：[M2 结果](../../../../docs/M2_RESULT.md) 的限制段、集成审查与 E2E 审查的 findings（I1/I2/I3、C1–C4、P1/P2、E1/E2）、[implemented M2 note](../../implemented/feature/2026-11-05-m2-memory-checkout.md)。

## Proposal

三条互不重叠的修复流，各自在 worktree 里完成，队长串行合并：

**R1 集成与工具（`src/tools.ts`、`src/session-slice.ts`、`src/memory.ts`）。** `cowork_checkout_merge` 在 `git merge` 成功后的 teardown（`resolveByPath`、`removeCheckout`、`deleteWorkspace`、`archiveSession`、`updateThread`）整体包 try/catch：任一步失败时**仍返回 `ok:true`**、把失败收进 `cleanupErrors` 明细，不改变已发生的 merge 结果；冲突路径的 `updateThread` 同样包住。`createCheckoutThread` 对宿主返回的 sessionId fail-closed：与请求不一致时报错且不写索引。`src/memory.ts` 把来源时间校验策略二选一（保留 `Date.parse` 并写进契约，或退回纯正则）并补测试；`MemoryValidationIssue.field` 联合类型扩展 `'kind'`，删除 cast；`renderMemoryEntry` 接受注入时钟。

**R2 checkout 与 E2E 设施（`src/checkout.ts`、`src/m2-e2e.ts`）。** checkout 模块检查 `git merge --abort` 的退出码（失败返回 `checkout/git-failed`）；`details.stderr` 截断到固定长度并标注；`mkdirSync` 失败映射为 `checkout/create-failed`。E2E 驱动拆成两个 ≤50 KB 的文件（runner 与 step 实现），证据写入前脱敏 hostname；新增一步：让 thread 在回复里逐字复述 master 写入的一条约束，断言回复包含该文本——把「注入可见」从 assembly 证据升级为模型可见证据。

**R3 memory-prompt 与契约（`src/memory-prompt.ts`、`docs/PLAN.md`、`docs/PANEL_HANDOFF.md`）。** `renderMemory` 返回 null 时清空缓存并补测试；`duplicateSkipped` 按 agent 计数。PLAN §5.6 的 teardown 顺序文字与实现对齐（先 `resolveByPath` 再 `removeCheckout`，理由写进注释）；`docs/PANEL_HANDOFF.md` 的 `worktreePath` 改为 `checkoutPath`。

**收口。** 三条流合并后重跑 `npm test` / `npm run typecheck` / `npm run build` / `npm run check` 与真实宿主 E2E；最终复审绑定最终字节；更新 `M2_RESULT`（限制段改为链接 [KNOWN_ISSUES](../../../../docs/KNOWN_ISSUES.md) 与本提案）、`M2_HANDOFF`（标注收口）；追加提交并推送到审阅分支 `feat/m2-memory-checkout`（不重写历史）。门禁规则同步收紧为「medium 必须在阶段内修复」，写进 [M2 修复交接](../../../../docs/M2_FIX_HANDOFF.md)，不改运行时。

## Alternatives considered

**只修 medium（I1），其余 low 记入 KNOWN_ISSUES。** 否决：这些 low 都在 M2 自己的文件与契约里，修复是局部改动；留到 M3 等于让下一阶段替本阶段清账。

**把全部遗留推到 M3。** 否决：违反阶段归属约定，M3 的 review 门禁与面板会被无关噪音拖慢，且 M3 没有 M2 的上下文。

**重写 E2E 驱动而不是拆分。** 否决：拆分不改变行为；重写会丢掉已验证的竞态处理（handoff 唤醒、幂等 merge、状态轮询），收益不抵风险。

**为「模型可见性」另起一个独立探针。** 否决：复用现有 10 步场景加一步最便宜，证据落在同一份 JSON 里，便于一个文件复核。

## Acceptance criteria

- [F1] merge 成功后的 teardown 任一步失败：工具仍返回 `ok:true` 且 `cleanupErrors` 非空，索引已更新；故障注入单测覆盖 — `source`, `tests`
- [F2] 冲突路径 `updateThread` 失败不吞错；`createCheckoutThread` 在宿主返回不同 sessionId 时报错且不写索引 — `source`, `tests`
- [F3] memory：来源时间策略写进契约与测试；`MemoryValidationIssue.field` 含 `'kind'` 且无 cast；`renderMemoryEntry` 使用注入时钟 — `source`, `tests`
- [F4] checkout：abort 失败返回 `checkout/git-failed`；`details.stderr` 截断并标注；`mkdirSync` 失败映射 `checkout/create-failed` — `source`, `tests`
- [F5] memory-prompt：`renderMemory` 返回 null 后缓存清空；`duplicateSkipped` 按 agent 计数 — `source`, `tests`
- [F6] E2E：驱动每个文件 ≤50 KB；证据不含 hostname；新增「模型复述约束」步骤且断言回复包含该约束 — `source`, `tests`
- [F7] 契约与文档：PLAN §5.6 teardown 顺序与实现一致；`PANEL_HANDOFF` 用 `checkoutPath`；`M2_RESULT`/`M2_HANDOFF`/`KNOWN_ISSUES` 交叉链接且无重复 — `publication`
- [F8] 全部门禁与真实宿主 E2E 在最终字节上重跑通过：`npm test`、`npm run typecheck`、`npm run build`、`npm run check` exit 0，新证据写入 `.dsh-cowork/e2e/M2_E2E.json` — `packaging`, `publication`

## Risks

- E2E 重跑受宿主与模型波动影响：同一失败最多重试一次，仍失败按失败收口，不用单测替代端到端。
- 拆分驱动会改变字节：必须先拆分再跑 E2E，证据只认最终字节。
- 范围蔓延：只修本提案列出的项；新发现进 KNOWN_ISSUES 或另开提案，不顺手改。
- 并发写者：开始前先 fetch 并确认 main 没有未合并的他人改动；改动只碰任务 inScope 列出的文件。
- 审查轮次上限：修复后一轮复审；第二轮仍不通过就升级给人，不无限循环。

## Delivery stages

1. R1 / R2 / R3 三个 worktree 并行修复（各自单测）→ 队长串行合并。
2. 主树复验（四条命令）+ E2E 重跑（拆分后的驱动与新增可见性步骤）。
3. 最终复审（绑定最终字节）→ 文档更新 → 追加提交并推送审阅分支。
