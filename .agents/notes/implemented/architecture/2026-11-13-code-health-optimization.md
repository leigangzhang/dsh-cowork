# Decision: 收敛代码健康度 1-11 项（入口、投递、事务与测试面）

Status: implemented
Date: 2026-11-13
Class: architecture

## Problem

2026-11-13 的架构审计在清理分支 `agent/retire-stale-code` 之后仍列出 11 项可优化点。它们不是单点缺陷，而是互相放大的结构成本：

- **入口过载。** [index.ts](../../../../src/app/apply.ts) 46,369 B / 1,126 行，同时持有 Config schema、`normalizeConfig`、368 行 dev 路由、M12 面板探针、workspace repair 与业务装配；读代码需要先跳过 dev 面。
- **剩余历史脚手架。** M2/M3/S0 已在上一轮移除，但 M0 run/status、`cowork_probe`、`cowork-probe` preset 仍注册；health 仍是 host-smoke 的必要入口。
- **文件贴 50 KiB 读上限。** [m12-e2e-support.ts](../../../../src/dev/m12-e2e-support.ts) 51,157 B、[m12-e2e.ts](../../../../src/dev/m12-e2e.ts) 50,942 B、[store.ts](../../../../src/store/project-store.ts) 49,435 B、[review-request.ts](../../../../src/domains/review/review-request.ts) 48,758 B；新增一行就可能越过 DSH 单文件读取上限。
- **投递语义四套。** inbox 批量 + `deliveredAt`、notice 1:1 账本 + 退避、request 卡片 `delivery.lastError`、review verdict 本地 `promptError`；重试/错误记录各写一遍，KI-17/KI-23 的不对称长期存在。
- **授权跨文件双写。** 主题的 `authorization` 与 `requests/<id>.json` 分两次加锁写；卡片失败会留下「主题已解锁、卡片仍 pending」窗口（KI-45）。
- **配置默认值两处。** zod schema 的 `.default()` 与 `normalizeConfig` 的 `??` 各维护一套；新增字段要改两处，漂移不会被测试发现。
- **类型循环。** [api.ts](../../../../src/panel/api.ts) 值引用 [inbox-api.ts](../../../../src/panel/inbox-api.ts)，后者 `import type` 回 api；运行时被 TS 擦除，但结构上仍是环。
- **重复 teardown。** [checkout-teardown.ts](../../../../src/domains/isolation/checkout-teardown.ts) 的 thread/work-item 两条 teardown 约 60 行几乎相同；改顺序要改两遍。
- **静态检查缺口。** host 未开 `noUnused*`（上一轮已修）；没有 lint/formatter；`console`/`debugger`/`@ts-ignore`/测试 `.skip` 无自动拦截；client TSX 没有执行 lane。
- **工具面全局注册。** 22 个工具在 profile 级 `ctx.tools` 注册，preset 不能按会话裁剪；每个 cowork 会话携带全部 schema，实测 16,523 B，新增工具线性增长。
- **测试偏科。** `tests/api.test.mjs` 2,271 行、`tests/work-item.test.mjs` 1,402 行、`tests/review-request.test.mjs` 52,680 B；单文件贴读上限，失败定位成本高；浏览器/TSX 仍靠手工。

这些项的共同成本是：读一个入口要跨过几百行 dev 代码；改一个投递/事务语义要在多个模块重复；文件预算逼迫临时拆分而不是按职责拆分；测试文件本身成为维护负担。

## Decision

按 11 项逐一收敛，全部落在 `agent/cowork-optimization`（PR #33），以 `agent/retire-stale-code` 为 base：

1. **入口拆分。** [config.ts](../../../../src/app/config.ts) 持有 Config 类型族、`CONFIG_DEFAULTS`、schema 与 `normalizeConfig`；[dev-surfaces.ts](../../../../src/app/dev-surfaces.ts) 持有 health、M12 run/status、M12 面板探针与 loopback guard；[index.ts](../../../../src/app/apply.ts) 只保留 apply 编排与 13 项公开再导出，21,830 B。
2. **退役剩余 M0 运行面。** 删除 run/status、`cowork_probe`、`cowork-probe` preset、`probe-engine.ts`、`probe-store.ts`；只保留 `/dsh-cowork/probe/health` 供 host-smoke，dev 面只剩 health + M12 run/status，0 个 dev 工具/preset。
3. **拆 m12 与测试贴边。** support 拆为 [m12-e2e-contract.ts](../../../../src/dev/m12-e2e-contract.ts)、[m12-e2e-prompts.ts](../../../../src/dev/m12-e2e-prompts.ts)、[m12-e2e-evidence.ts](../../../../src/dev/m12-e2e-evidence.ts)，support 只剩 463 B 再导出；driver 生命周期拆到 [m12-e2e-driver.ts](../../../../src/dev/m12-e2e-driver.ts)。所有 m12 文件 <48 KiB（最大 37,719 B），[m12-e2e.test.mjs](../../../../tests/dev/m12-e2e.test.mjs) 预算改为 49,152。
4. **统一投递尝试。** 新增 [delivery.ts](../../../../src/domains/notices/delivery.ts)：`attemptDelivery`/`retryDelaySchedule`，唯一重试循环、永不抛异常、返回 `{attempts,delivered,error}`。5 个调用点接入（inbox flush、master verdict、reviewer brief、topic wake、notices dispatcher）；各域账本保留（KI-47）。
5. **授权单锁事务。** [authorization-decision.ts](../../../../src/domains/requests/authorization-decision.ts) 只开一次 `store.withWriteLock`，内部使用免锁写 `mutateIndexDocumentUnlocked`（[store.ts](../../../../src/store/project-store.ts)）与 `RequestStore.updateUnlocked`（[request-store.ts](../../../../src/store/request-store.ts)）；index 先失败则卡片不动，卡片失败用锁内快照回写 index（补偿），补偿失败记录残余窗口（KI-45）。
6. **配置默认值单源。** `CONFIG_DEFAULTS` 同时供 schema 与 `normalizeConfig`；`Config({})` 与 `normalizeConfig({})` 深相等，routing 解析不变。
7. **拆类型循环。** 新增 [api-types.ts](../../../../src/panel/api-types.ts)；[inbox-api.ts](../../../../src/panel/inbox-api.ts) 不再 import `./api.js`；[api.ts](../../../../src/panel/api.ts) 保留全部原名导出。
8. **teardown 去重。** [checkout-teardown.ts](../../../../src/domains/isolation/checkout-teardown.ts) 只剩 `runTeardownSteps` 一份步骤序列，两个公开函数保留同名同签名；workspace 解析先于删 clone，index update 最后。
9. **静态门禁。** host 开 `noUnusedLocals`/`noUnusedParameters`；[check-invariants.mjs](../../../../tools/check-invariants.mjs) 增加 4 条源码卫生规则（src 的 `console`/`debugger`/`@ts-ignore`，tests 的 `test.skip`/`test.only`）与 11 个负例。不引入 ESLint/Prettier（KI-48）。
10. **工具面预算。** 新增 [tool-schema-budget.test.mjs](../../../../tests/guards/tool-schema-budget.test.mjs)：22 个业务工具序列化 16,523 B 为预算，第 23 个工具即红；profile 级注册的宿主限制记 KI-49。
11. **测试拆分。** `tests/api.test.mjs` 拆为 [api-read.test.mjs](../../../../tests/panel/api-read.test.mjs)、[api-write.test.mjs](../../../../tests/panel/api-write.test.mjs)、[api-auth.test.mjs](../../../../tests/panel/api-auth.test.mjs)（787/712/526 行）并抽出 [api-fixtures.mjs](../../../../tests/support/api-fixtures.mjs)；work-item 拆 3 文件、review-request 拆 2 文件，测试数与断言不变。浏览器/TSX lane 本轮不建（KI-50）。

最终实现提交 `9b40c23`（`86548ae` 为集成就绪；`9b40c23` 只改 docs 与一行 `api-contract.ts` 注释）。本记录作为 docs-only 交付记录追加到 PR #33，不改变实现字节。

## Alternatives considered

**做一个共享 outbox，把 inbox/notice/request/review 的账本合并。** 否决：四者的磁盘形状、wire 语义与重放单位不同（批量消息、1:1 通知、请求卡片、verdict 一次性），合并需要改 wire/磁盘 schema 与迁移；本轮只统一「怎么尝试一次投递」，账本仍分域（KI-47）。

**用 WAL/两阶段提交实现真正跨文件原子。** 否决：当前单锁 + 锁内快照补偿已消除常规双写窗口；补偿再失败只剩有日志的残余窗口。WAL 会引入新的持久化协议与恢复路径，超出本轮范围（KI-45）。

**引入 ESLint/Prettier 统一风格。** 否决：会新增依赖与全仓格式化 diff，掩盖行为改动；先用 tsc strict、`noUnused*` 与文本卫生规则，等规则类缺陷反复靠 review 拦截再评估（KI-48）。

**按 preset 裁剪工具 schema。** 否决：宿主工具注册是 profile 级，preset 只能追加不能按会话过滤；本轮用预算守卫把现状固定住，等宿主提供裁剪能力再改（KI-49）。

**引入 Playwright 建浏览器 lane。** 否决为本轮范围：需要真实宿主、Chrome 驱动与稳定 fixture，成本高于测试拆分；先拆大文件并保持手工 Chrome 证据，浏览器 lane 记 KI-50。

**继续保留 2k 行测试单体。** 否决：单文件接近读上限，失败定位与 review diff 都被迫整文件加载；拆分后测试数与断言不变，才是可验证的等价重构。

## Consequences

- [index.ts](../../../../src/app/apply.ts) 21,830 B（≤30 KiB），Config/dev 面各有单一归属；M0 运行面只剩 health。
- 所有 `src/m12-e2e*.ts` <48 KiB，最大 37,719 B；support 是纯 barrel；M12 step/prompt/evidence 不变。
- 投递尝试只有一份实现，但跨重启送达与统一审计仍未实现（KI-17/KI-23/KI-47）。
- authorization 的 index/card 常规双写窗口消除；补偿失败仍有「topic unlocked, card pending」日志窗口（KI-45）。
- 22 个工具仍是 profile 级全局注册；预算守卫只防增长，不降低现状（KI-49）。
- 963 个测试、coverage 69.60/83.52/84.27、六个命令全绿；四层独立审查在 `86548ae` 全部 pass。最终 docs/comment 增量在 `9b40c23` 后重跑六命令，但未重新走四层 review；t14 的 content-binding 警告仍记录在案。
- 浏览器/TSX lane 仍未建立；`test:coverage` 不统计 TSX，面板交互仍靠手工 Chrome（KI-50）。
- M12 真宿主模型链未在本轮跑；host-smoke 是真实 dsh+tarball 跨进程证据，retired `/probe/run` 404 只有 fake-host 路由清单证据。
- PR #33 保持 OPEN，合并由人工决定；回滚可按 8 个提交 revert，或关闭 PR/删除分支。base 分支 `agent/retire-stale-code` 已包含上一轮清理记录。

## Testing

- [A1] [index.ts](../../../../src/app/apply.ts) ≤30 KiB 且只做编排；`CONFIG_DEFAULTS` 单源，`Config({})` 与 `normalizeConfig({})` 深相等 — `source`：[dev-gate.test.mjs](../../../../tests/guards/dev-gate.test.mjs)、[config.ts](../../../../src/app/config.ts)
- [A2] 所有 `src/m12-e2e*.ts` <48 KiB；support 只再导出；m12 step/prompt/evidence 不变 — `source`：[m12-e2e-support.ts](../../../../src/dev/m12-e2e-support.ts)、[source-budget.test.mjs](../../../../tests/guards/source-budget.test.mjs)
- [A3] [delivery.ts](../../../../src/domains/notices/delivery.ts) 是唯一投递重试实现，5 个调用点接入；成功/重试/耗尽/不抛异常有测试 — `source`、`tests`：[delivery.test.mjs](../../../../tests/domains/notices/delivery.test.mjs)
- [A4] authorization 两路径单次 `withWriteLock`，两种失败顺序与补偿窗口有测试；幂等 replay 不重复 prompt — `tests`：[authorization-transaction.test.mjs](../../../../tests/domains/requests/authorization-transaction.test.mjs)
- [A5] [inbox-api.ts](../../../../src/panel/inbox-api.ts) 不再 import `./api.js`；[api-types.ts](../../../../src/panel/api-types.ts) 无环且 api 导出兼容 — `source`：[api-types.test.mjs](../../../../tests/panel/api-types.test.mjs)
- [A6] [checkout-teardown.ts](../../../../src/domains/isolation/checkout-teardown.ts) 只剩一份步骤序列，两个公开函数签名/顺序不变 — `source`：[tools.test.mjs](../../../../tests/domains/isolation/teardown.test.mjs)
- [A7] 22 个工具 schema 序列化 ≤16,523 B，第 23 个工具使测试变红 — `tests`：[tool-schema-budget.test.mjs](../../../../tests/guards/tool-schema-budget.test.mjs)
- [A8] api 拆为 787/712/526 行、work-item 3 文件、review-request 2 文件，测试数与断言不变 — `tests`：[api-read.test.mjs](../../../../tests/panel/api-read.test.mjs)、[work-item-model.test.mjs](../../../../tests/domains/isolation/work-item-model.test.mjs)、[review-request-model.test.mjs](../../../../tests/domains/review/review-request-model.test.mjs)
- [A9] 六命令全 exit 0（check/test/coverage/typecheck/build/host-smoke），host-smoke 5/5 — `packaging`、`tests`
- [A10] 本记录落在 `.agents/notes/implemented/architecture/` 并通过 `npm run check`；PR #33 记录交付身份 — `decisions`：[code-health-optimization.md](2026-11-13-code-health-optimization.md)
