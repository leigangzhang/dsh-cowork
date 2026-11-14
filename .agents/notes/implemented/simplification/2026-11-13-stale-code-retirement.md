# Decision: 退役过期代码与历史开发面

Status: implemented
Date: 2026-11-13
Class: simplification

## Problem

2026-11-13 的代码审计在 `agent/retire-stale-code` 基线上确认了几类已经失效、但仍参与构建和 dev 注册的代码：

- **M2/M3 真宿主 E2E 驱动仍在注册。** 两个驱动编码 v1 thread 语义；M12 交付记录判定它们在 v2 store 上按预期失败、不承担验收，但 `enableDevRoutes` 仍注册 4 条路由、3 条事件流，并把两个驱动编进产物。
- **S0 探针是 M1 临时设施。** [M1_S0_RESULT.md](../../../../docs/handoff/M1_S0_RESULT.md) 写明“M1 收口时应移除”；到 0.2.0 仍注册 2 条路由、1 个事件流、1 个工具和 1 个 preset。
- **死代码与陈旧指令成片。** `noUnusedLocals` 报 17 处；`recordActivity`/`errorActivity` 只被测试调用；`checkoutDeps`、`TOPIC_STATUS_VALUES`、`review/override-reason-required` 零生产引用；`resolveAfterMs`/`activeWorkItemsOf` 在自动 resolve 移除后仍被读点接收并计算。
- **注释与模型指令过期。** `index.ts` 写 19 个工具（实际 22）、`tools.ts` 声称保留给 M11/M12、`routing.ts` 指向已删除的 `router.ts`、`handoff.ts` 声称 blocked 投递 inbox、master/reviewer persona 仍用 thread 语义。
- **干净 worktree 的 `npm run check` 会红。** [M2_PROBE_RESULT.md](../../../../docs/handoff/M2_PROBE_RESULT.md) 链接到 gitignored 的 `.dsh-cowork` 运行数据，CI/新 worktree 无法通过文档门禁。

这些代码让 dev 模式暴露不可用路径，增加 tarball 与覆盖率排除噪音，并把过期语义继续交给模型。清理的直接收益是删除 5,219 行不可用/误导代码，并让静态门禁能真正拦住同类残留。

## Decision

**1. 退役 M2/M3 与 S0 开发面。** 删除 `src/m2-e2e.ts`、`src/m2-e2e-support.ts`、`src/m3-e2e.ts`、`src/m3-e2e-support.ts`、`src/s0-probe.ts` 及 3 个对应测试；[index.ts](../../../../src/app/apply.ts) 去掉对应路由、事件流、`cowork_identity_probe` 与 S0 preset。保留 M0 health/run/status 与 M12 run/status；`host-smoke` 继续消费 health。

**2. 删除死代码并打开静态门禁。** 删除只被测试使用的 activity helper、零引用导出与错误码、未用导入/局部变量；移除已失效的 `resolveAfterMs`/`activeWorkItemsOf`/`activeWorkItems` 读点传参。[tsconfig.json](../../../../tsconfig.json) 对 host 开启 `noUnusedLocals`/`noUnusedParameters`，与 client 半边一致。

**3. 修正注释与模型指令。** 工具数改为 22；删除已删文件的假引用；blocked handoff 改为 activity/notices 语义；master/reviewer persona 改用 work item / topic handoff；memory source 示例改为 topic id。

**4. 让文档门禁不依赖本地运行数据。** [M2_PROBE_RESULT.md](../../../../docs/handoff/M2_PROBE_RESULT.md) 的 `.dsh-cowork` 链接改为代码引用；历史文档中指向已删驱动的链接改为普通代码文本，不重写历史结论。

未做项保持审计时的边界：不删除 v1 索引视图、`cowork_thread_*` 别名、legacy thread clone merge 与 `workspace-repair`（KI-18/KI-39 归 0.3.0）；保留 M0 probe 的 health；不引入 ESLint/Prettier（KI-48）。

## Alternatives considered

**保留 M2/M3 作为 dev-only 历史驱动。** 否决：它们在 v2 store 上按预期失败，文档已确认非验收；保留只会让 dev 路由继续指向不可用路径，并让覆盖率排除名单与测试维持死代码。

**把 M2/M3 修到 v2 再保留。** 否决：M12 已是 0.2.0 的当前真宿主链；把 v1 thread 驱动改造成 v2 等于重写一套重复 E2E。冲突与 needs_revision 场景的覆盖缺口单独记为 KI-46，不靠复活旧驱动。

**现在就删除 v1 兼容层。** 否决：0.2.0 仍承诺 0.1.0 升级/回滚窗口；`store-migration`、v1 视图、thread 别名与 legacy merge 是 KI-18 划定的 0.3.0 范围。

**保留测试专用 helper/导出以维持测试绿。** 否决：测试专用生产 API 会掩盖“没有生产调用者”的事实；应删代码并删对应测试，或把 helper 移到测试侧。

**在清理同时引入 ESLint/Prettier。** 否决为本轮范围：会引入新依赖与全仓格式化 diff，掩盖行为改动；静态门禁先用 tsc strict + [check-invariants.mjs](../../../../tools/check-invariants.mjs) 的源码卫生规则，后续单独评估（KI-48）。

## Consequences

- `src/` 从 71 个文件降到 66 个；dev 路由 11→5、事件流 5→2、dev 工具 2→1、dev preset 2→1；测试 993→940。
- M2/M3 原覆盖的冲突与 `needs_revision` 真宿主 E2E 不再存在；已记入 [KI-46](../../../../docs/KNOWN_ISSUES.md)，留给 V0.3 移植进 M12 或明确接受。
- M0 probe 的 health/run/status、`cowork_probe` 与 `cowork-probe` preset 仍保留；health 被 `host-smoke` 依赖，不属于失效面。
- `noUnused*` 现在是 host 编译失败条件；新增未用符号会在 typecheck/build 阶段红，而不是等到 review。
- 干净 worktree/CI 的 `npm run check` 不再依赖 gitignored `.dsh-cowork`；历史 handoff 中的旧测试文件名仍是纯文本引用，不改成链接。
- 该分支是后续代码健康度优化（PR #33，`agent/cowork-optimization`）的 base；优化记录单独落盘，不把两轮决策混成一份。
- 回滚：`git revert c148c99 a929850 14e8b0c` 可恢复文件与旧注释；`lib/` 为 gitignored 构建产物，回滚后需 `npm run build`。

## Testing

- [A1] M2/M3/S0 驱动、`src/probe-engine.ts`、`src/probe-store.ts` 与对应测试已删除；dev 面只剩 health + M12 run/status — `source`：[index.ts](../../../../src/app/apply.ts)、[dev-gate.test.mjs](../../../../tests/guards/dev-gate.test.mjs)
- [A2] `noUnusedLocals`/`noUnusedParameters` 在 host 开启且 17 处未用符号清零；`recordActivity`/`errorActivity`/`checkoutDeps`/`TOPIC_STATUS_VALUES`/`review/override-reason-required` 无生产引用 — `source`：[tsconfig.json](../../../../tsconfig.json)、[tool-runtime.ts](../../../../src/platform/tool-runtime.ts)、[tool-model.ts](../../../../src/platform/tool-model.ts)
- [A3] 940 个测试通过；coverage 66.42/83.11/83.19（floor 65/82/80）；typecheck/build 通过 — `tests`、`packaging`
- [A4] 无 `.dsh-cowork` 的干净 worktree 上 `npm run check` 通过；`host-smoke` 5/5 通过 — `workflow`、`packaging`
- [A5] 本记录落在 `.agents/notes/implemented/simplification/` 并通过 `npm run check` 的 decisions 规则 — `decisions`：[stale-code-retirement.md](2026-11-13-stale-code-retirement.md)
