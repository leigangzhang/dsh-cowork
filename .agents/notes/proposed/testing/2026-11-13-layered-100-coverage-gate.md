# Proposal: 用确定性 per-file 报告实现 100% 覆盖率门禁

Status: proposed
Date: 2026-11-13
Class: testing

## Problem

`npm run test:coverage` 只给一组全局阈值（line 65 / branch 82 / function 80），统计 `src/**/*.ts` 并硬编码排除 7 个 dev 文件。它不能定位到文件，也没有回答“哪条 lane 该为这一行负责”；2026-11-14 的一次运行里，58 个被统计模块有 52 个低于 line 100。

而且报告本身不可信：

- **行归属错位。** [tests/support/ts-hook.mjs](../../../../tests/support/ts-hook.mjs) 用 `stripTypeScriptTypes(..., { mode: 'transform' })` 加载 TS；transform 会删掉注释和空行，覆盖命令又没有让 Node 使用 source map，V8 偏移于是被直接套到原始文件的行上。2026-11-14 实测：同一套测试让 hook 输出 inline source map 后，非 dev line 从 69.29%–72.77% 变成 96.37%（23,466/24,349），低于 100 的模块从 52 个变成 32 个。现有 floor 与所有 per-file 数字都建立在这个错位上。
- **汇总会整块丢测试文件。** 同一工作树连续三次运行（989 tests 全绿）line 分别是 72.77%、69.41%、69.29%；`src/store/activity.ts` 75.08→31.99、`src/domains/notices/notices.ts` 68.93→39.40、`src/domains/review/review-request.ts` 74.10→44.92。把 68 个测试文件逐个运行再取并集，行集合在两次运行中逐文件一致。
- **所有权是隐式的。** 7 个硬编码排除把生产可达的 `src/dev/panel-probe.ts` 和 6 个 M12 驱动混在一起；`src/index.ts` 因为没有测试加载而根本不进报告；`src/panel/api-types.ts` 没有运行时行；`src/client/contracts.ts` 依赖宿主提供的 `react`，Node 加载不了；5 个 `src/client/*.tsx` 没有 lane。
- **重构改变了可行 lane。** 宿主模块现在全部通过注入端口取依赖：`apply()` 由 [tests/guards/dev-gate.test.mjs](../../../../tests/guards/dev-gate.test.mjs) 的记录型 fake host 驱动，[src/platform/tool-runtime.ts](../../../../src/platform/tool-runtime.ts) 的模块注释写明 “Nothing here assembles a host”。宿主侧不存在只能由真实 DSH 进程执行的行。真正需要另一条执行 lane 的只有浏览器：5 个 TSX 和 `client/contracts.ts`。真实宿主证据继续由 `test:host-smoke` 与 E2E 承担。

## Proposal

**1. 先修 source map 行映射。** [tests/support/ts-hook.mjs](../../../../tests/support/ts-hook.mjs) 在 transform 模式同时返回 inline source map（`sourceMap: true, sourceUrl: url`）。新增一个经真实 hook 加载的 TS fixture：一行确定执行、一行确定不执行；门禁只把执行行算绿，去掉 source map 时该 fixture 必须变红。

**2. 逐文件确定性收集。** [scripts/evidence/test-coverage.mjs](../../../../scripts/evidence/test-coverage.mjs) 对每个 `*.test.mjs` 单独启动进程、写独立 LCOV，再按 `DA` 行取并集；集合合并与顺序无关。实测 68 个文件串行约 43 秒（全量并行约 11 秒），两次运行逐文件行集合一致。任一测试文件非零退出或报告缺失都失败；输出只写 `coverage/`，该目录加入 `.gitignore`。

**3. 所有者地图。** 新增 `tools/coverage-map.json`，数组形式 `{path, lane}`（重复 path 可检），每个 `src/**/*.ts` 与 `src/client/**/*.tsx` 恰好一个 lane：`unit` | `browser` | `dev`。`dev` 只允许 6 个 `src/dev/m12-e2e*.ts`，必须带 `reason` 和 `exitWhen`（versioned E2E 落地并删除时）；`panel-probe.ts` 归 `unit`。未映射、重复、未知 lane、越界 `dev` 都让 `coverage:check` 红。

**4. 类型文件与未加载文件分开处理。** 没有运行时语句的文件由机械检查放行（`stripTypeScriptTypes` 后除注释外为空），不写 allowlist；有运行时语句却不在自己 lane 报告里的文件直接红——“没加载”不能算 0%，更不能算 100%。

**5. per-file line 100，债务只能减。** `tools/coverage-debt.json` 记录每个未到 100 的文件的未覆盖行数；`coverage:check` 在三种情况下红：未列出的文件仍有未覆盖行、实际未覆盖行数超过记录、删除条目时仍有缺口。修正映射后的确定性并集基线是 37 个非 dev 模块、1,053 行（23,296/24,349，95.68%；不含从未加载的 `src/index.ts`）；一次全量运行报 96.37%/32 个/883 行，两者在两个方向都不一致，所以门禁只认逐文件口径。branch/function 先按同一份报告的 per-file 值锁基线并随债务收紧，本次不追求 100。

**6. 合并与身份。** unit lane 写 `coverage/unit.lcov` 和 sidecar（命令、exitCode、HEAD、diff sha256、porcelain、Node 版本）；browser lane 写 `coverage/browser.lcov` 和 sidecar。`npm run test:coverage:layered -- --base <ref>` 运行并合并两条 lane；任一 lane 缺失、sidecar 身份不一致、或非 dev/type-only 文件仍有缺口都失败；`coverage/layered.json` 记录两份 sidecar 和合并规则。同一行被两条 lane 覆盖只计一次。

**7. 阻塞级别。** `test:coverage`（unit lane）保持每次 `src/**` 变更的阻塞门禁；`test:coverage:layered` 在交付/合并前阻塞。浏览器 per-file 100 先 observational，连续三次绿后并入阻塞；`test:host-smoke` 与 E2E 的阻塞级别不变。命令、级别、报告路径写入 [tools/workflow.json](../../../../tools/workflow.json) 和 [docs/testing.md](../../../../docs/testing.md)。

## Alternatives considered

**把全局 floor 提高到 100。** 否决：聚合数不能定位到文件；修正映射前它本身是错的，修正后也会掩盖单文件回归；全仓 100 无法分批落地。

**保留三 lane（unit + host E2E + browser）。** 否决：重构后宿主模块全部可注入，host lane 不改变任何文件的判定，只增加 dsh 依赖和 sourcemap 映射；真实宿主证据已由 host-smoke/E2E 承担。

**把 TSX 与 contracts.ts 塞进 Node 或 jsdom。** 否决：`react` 由宿主提供，jsdom 不渲染真实布局、焦点和滚动；那是假执行。

**引入 c8/istanbul 或自建插桩。** 否决：Node 已能输出 per-file LCOV，缺的是 source map 与确定性收集，不是新的覆盖率引擎；新依赖还要顺带决定 lockfile 政策。

**立即 per-file 100、不设债务列表。** 否决：修正映射后仍有约 1,000 行缺口分布在 37 个模块，一次性提交会鼓励删断言或加 ignore；债务列表是 ratchet，不是永久排除。

**把低覆盖模块永久排除。** 否决：把风险从门禁移到运行时；`dev` 类只接 6 个待删除的 M12 驱动。

## Acceptance criteria

- [A1] 经真实 hook 加载的 TS fixture 只把确定执行的行算绿；去掉 inline source map 时该检查红 — `tests`
- [A2] 同一工作树连续两次 unit lane 的 per-file 行集合与未覆盖行数逐文件一致；删除一个测试文件的报告或让它非零退出时检查红 — `tests`
- [A3] `tools/coverage-map.json` 对 73 个源文件（68 TS + 5 TSX）各分配一次；未映射、重复、未知 lane、越界 `dev` 或缺 `reason`/`exitWhen` 时红 — `tests`
- [A4] 类型文件可缺席；有运行时语句却缺席的文件红；`src/index.ts` 至少被一个测试加载 — `tests`
- [A5] 未列出的未覆盖行、超过记录的未覆盖行、债务清零后仍存在的缺口都红；债务总数只能下降 — `tests`
- [A6] `test:coverage:layered` 要求 unit + browser 两份报告与一致 sidecar 身份；缺 lane 或身份不一致红；同一行两 lane 覆盖只计一次 — `workflow`
- [A7] 命令、阻塞级别、报告路径与 mapping 前置写进 `tools/workflow.json` 与 `docs/testing.md`，`coverage/` 进 `.gitignore`；`npm run check` 通过 — `workflow`

## Risks

- Node 的 source-map 行归属在跨行语句上可能多算或少算；fixture 只证明已知样例。浏览器 lane 的映射精度由 client-browser-coverage 提案先验证，未验证前不能把 TSX 门槛设为阻塞。
- 逐文件收集把 lane 从约 11 秒拉长到约 43 秒；可以加并发，但不能退回聚合收集，否则会重新丢覆盖。异步子进程仍可能影响结果，测试必须等待自己创建的子进程（沿用现有 determinism 规则）。
- 债务列表可能长期不清零；门禁只能防增长，收缩要靠评审和里程碑。真正不可达的分支应删代码，不能加 ignore 或例外。
- Node 的 TS 加载仍带实验标记；升级 Node 或改 loader 都可能改变行归属，升级时必须重跑映射 fixture 并重测基线。
- 浏览器 lane 依赖 Playwright/Chromium 和依赖锁定；仓库目前没有 lockfile，这条 lane 的复现性由 client-browser-coverage 提案决定。它落地前，layered 只对 unit 文件成立，不能宣称全仓 100%。
- 去掉 host coverage lane 后，覆盖率不再证明构建产物中的执行；host-smoke/E2E 缺位时这个风险不能被覆盖率补上。

## Delivery stages

1. 修 hook 映射和 TS fixture 负向控制；用逐文件并集重测并公布修正后的基线（预计非 dev line 约 95%–96%）。
2. owner map、类型/未加载规则、逐文件收集和 `coverage:check` 报告模式（observational）；证明同树两次一致、删除报告会红。
3. unit lane per-file 规则设为阻塞，落地只减不增的债务列表；按最大缺口（tools/*、apply、dev-surfaces、contracts 等）分批补测试或删死代码。
4. 接 browser lane 与合并门禁（observational → 三次绿后阻塞），补齐 TSX 缺口。
5. 债务清零后全仓 per-file line 100 阻塞；branch/function ratchet；versioned E2E 落地后删除 6 个 M12 驱动并清空 `dev` 类。
