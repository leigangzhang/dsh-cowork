# Proposal: 用分层所有者实现 100% 覆盖率门禁

Status: proposed
Date: 2026-11-13
Class: testing

## Problem

当前 `npm run test:coverage` 是单一 Node 进程门槛：本轮报告为 line 68.55%、branch 83.13%、functions 82.53%，有 44 个 `src/**/*.ts` 模块低于 line 100%，`src/client/*.tsx` 还不在统计范围。

单一门槛无法公平覆盖所有实现：

- 纯函数、schema 和 store 分支适合 unit coverage。
- `src/index.ts`、`src/tools.ts`、`src/tool-runtime.ts`、`src/api.ts`、`src/notices.ts` 的很多分支只有在真实 DSH composition、session、workspace 和 webServer 下才执行。
- `src/client/*.tsx` 的渲染和交互只有真实浏览器能证明。
- 为了把宿主和 UI 行数塞进 Node coverage 而写 fake host/jsdom，会得到“100% 但没证明产品”的假绿。

## Proposal

**1. 每个源码文件必须有且只有一个 coverage owner。** 新增 `tools/coverage-map.json`，把 `src/**/*` 映射到 `unit`、`host-e2e`、`browser` 或显式的 `generated` / `dev-legacy`。新源码文件默认归 `unit`；没有映射或映射重复时检查变红。`dev-legacy` 只接 M2/M3/M12 这类待下线入口，必须有原因和退出条件。

**2. 三个 lane 各自产出 coverage，再统一合并。** 
- `test:coverage` 继续负责可确定执行的 host TypeScript unit 覆盖；
- 版本化 E2E harness 在真实宿主进程里对构建后的 `lib/` 收集 V8 coverage，按 sourcemap 映射回 `src/**/*.ts`，负责宿主组合与跨会话路径；
- 浏览器 lane 用 V8 precise coverage 和 `lib/client.js.map` 映射 `src/client/*.tsx` 与 client 纯逻辑。

新增 `npm run test:coverage:layered`：依次或并行运行三个 lane，写出统一的 `coverage/layered.json`；`npm run coverage:check` 读取合并结果并按文件检查。每个 lane 的结果必须带命令、退出码、源码摘要和 artifact identity，缺失 lane 不能当作 100%。

**3. 先 line 100，再逐轮收紧 branch/function。** 合并门禁先要求所有非排除文件 line 100%；branch/function 先锁定当前基线并逐轮提高。未覆盖行只有两种处置：补对应 owner 的真实测试，或删除不可达/死代码；不允许用永久 ignore/allowlist 把行藏起来。真正的防御性分支必须记录可触发的边界条件。

**4. 分层归属与提案复用。** 宿主 E2E 机制复用 [版本化 E2E harness](2026-11-13-versioned-e2e-harness.md)，client coverage 与面板交互复用 [client browser coverage](2026-11-13-client-browser-coverage.md)。本提案只定义覆盖率所有权、合并格式和 100% 门禁，不重复定义浏览器或 E2E 场景。

**5. 发布门禁形态。** 第一版只报告，建立三 lane 的稳定基线；第二版把每个 lane 单独设为阻塞；第三版把合并后的 per-file line 100 设为阻塞。CI 失败时保留合并报告和未覆盖行列表，报告必须能定位到 owner 和 lane。连续三次绿后才移除 `[observational]` 标记。

## Alternatives considered

**只把全局 threshold 提高到 100%。** 否决：已有覆盖较高的模块会掩盖低覆盖模块，而且无法区分真实 E2E/browser 覆盖和 fake host 单测。

**继续用一个 Node 进程覆盖所有源码。** 否决：真实宿主进程和浏览器不在同一个 V8 进程里；强行塞入 fake 对象只会制造假执行。

**把所有低覆盖模块列入永久排除。** 否决：这等于把风险从门禁移到运行时；排除项必须有“生成代码/已下线 legacy”理由和重估日期。

**只做 E2E 或只做浏览器 coverage。** 否决：纯函数和 schema 需要快速 unit 反馈；只跑重 lane 会让反馈过慢，也覆盖不到未导出的边界函数。

## Acceptance criteria

- [A1] `tools/coverage-map.json` 对每个 `src/**/*` 恰好分配一个 owner；新增未映射文件或重复归属时检查变红 — `workflow`
- [A2] `npm run test:coverage:layered` 能合并 unit、host E2E、browser 三份结果，并拒绝缺少任一必需 lane 的合并报告 — `tests`
- [A3] 每个 lane 都有一个故意未覆盖的 fixture，能证明该 lane 的 coverage 丢失会让最终门禁变红 — `tests`
- [A4] 合并后的 per-file line 100 门禁对任一未覆盖模块失败；排除项必须带 `reason`、owner 和重估条件 — `workflow`
- [A5] 命令、阻塞级别、合并报告路径和排除规则写入 `tools/workflow.json` 与 `docs/testing.md` — `packaging`

## Risks

- 跨进程 V8 coverage 和 sourcemap 映射容易错位；必须先用手工 fixture 验证同一行在三 lane 中确实合并，而不是只看百分比。
- 100% line 可能遇到不可达防御分支；正确处置常常是删代码或拆函数，而不是加 mock。每个排除都需要 reviewer 判断。
- host E2E 和浏览器 lane 更慢、受宿主版本影响；不能因为“100% 更重要”就取消 flaky 状态同步和资源清理规则。
- 合并报告可能被 lane 生成顺序或缺失结果影响；报告必须记录每个 lane 的退出码和源摘要。
- `src/client/*.tsx` 和真实 host 路径依赖另外两个提案；在本提案落地前，100% gate 只能对现状报告，不能宣称完成。

## Delivery stages

1. 建立 coverage map 和 owner 校验，先只报告每个模块归属和当前 lane 覆盖。
2. 把 unit lane 推到可执行的 per-file 基线；清点可删除的死代码。
3. 接入 host E2E 与 browser 两份 V8 coverage，完成合并报告和负向 fixture。
4. 逐文件提升到 line 100，连续三次绿后设为阻塞；branch/function 继续 ratchet。
