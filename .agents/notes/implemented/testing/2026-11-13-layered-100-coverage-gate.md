# Decision: 用确定性 per-file 报告实现分层覆盖率门禁

Status: implemented
Date: 2026-11-13
Class: testing

## Problem

`npm run test:coverage` 曾只给一组全局阈值（line 65 / branch 82 / function 80），统计 `src/**/*.ts` 并硬编码排除 dev 文件，既不能定位到文件，也不能回答“哪条 lane 该为这一行负责”。2026-11-14 的一次运行里，58 个被统计模块有 52 个低于 line 100。

测量本身也有两个缺陷：

- **行归属错位。** [tests/support/ts-hook.mjs](../../../../tests/support/ts-hook.mjs) 用 transform 模式加载 TS，该模式会删掉注释和空行；没有 source map 时 V8 偏移被直接套到原始文件的行上。实测同一套测试在修正行映射后（一次全量运行）非 dev line 为 96.37%，而 transform 无映射报告 69.29%–72.77%。更关键的是行集不可信：一个从未执行的函数体在 transform 模式报告下会被算成已覆盖，不能作为逐行门禁。
- **聚合收集会整块丢测试文件。** 同一工作树连续三次运行（989 tests 全绿）line 分别为 72.77%、69.41%、69.29%；`activity.ts` 75.08→31.99、`notices.ts` 68.93→39.40。把 68 个测试文件逐个运行再取并集，covered/uncovered 行集合在两次运行中逐文件一致。

重构后所有权也变了：宿主模块全部通过注入端口取依赖，`apply()` 由 [tests/guards/dev-gate.test.mjs](../../../../tests/guards/dev-gate.test.mjs) 的记录型 fake host 驱动，不存在只能由真实 DSH 进程执行的行。真正需要另一条 lane 的只有浏览器：5 个 `src/client/*.tsx` 和 `src/client/contracts.ts`（依赖宿主提供的 `react`，Node 无法加载）。`src/index.ts` 当时没有测试加载，`src/panel/api-types.ts` 没有运行时行，6 个 `src/dev/m12-e2e*` 是待删除的 dev 驱动。

## Decision

**1. 行映射用 line-preserving 加载。** [tests/support/ts-hook.mjs](../../../../tests/support/ts-hook.mjs) 用 `stripTypeScriptTypes` 的 strip 模式加载 `.ts`，行号与列号保持原样；需要完整 transform 的语法回退到 transform + inline source map。`tests/guards/coverage-policy.test.mjs` 要求每个 `src` TypeScript 文件可 strip，并用真实 loader 的 fixture 证明“执行行算绿、未执行行必须红”；同一个 fixture 经过 transform-only hook 会误报未执行行，作为负向控制。

**2. 逐文件确定性收集。** [scripts/evidence/test-coverage.mjs](../../../../scripts/evidence/test-coverage.mjs) 对每个 `*.test.mjs` 单独启动进程，写独立 LCOV，再按 `DA` 行并集合并（[coverage-lcov.mjs](../../../../scripts/evidence/coverage-lcov.mjs)）。任一测试文件非零退出或未写报告即失败；子进程环境不继承父测试上下文和 `NODE_V8_COVERAGE`。合并结果与进程顺序、调度无关：两次收集的 covered/uncovered 行集合逐文件相同。

**3. 显式 owner map。** [tools/coverage-map.json](../../../../tools/coverage-map.json) 给每个源文件恰好一个 lane：`unit`、`browser` 或 `dev`。当前 73 个文件分为 unit 61、browser 6、dev 6。`dev` 只允许 `src/dev/m12-e2e*`，每条必须带 `reason` 和 `exitWhen`；browser 是 5 个 TSX 加 `client/contracts.ts`；其余归 unit（`panel-probe.ts` 与 `index.ts` 也在内）。未映射、重复、未知 lane、越界 `dev` 都是红。

**4. 类型文件与未加载文件分开。** 没有运行时语句的文件由 `stripTypeScriptTypes` 的机械检查放行（当前只有 `src/panel/api-types.ts`）；有运行时语句却不在报告里的文件直接红，“没加载”不能算 0% 或 100%。

**5. line 门禁加只减不增的基线。** [tools/coverage-debt.json](../../../../tools/coverage-debt.json) 记录每个未到 100 的 unit 模块的未覆盖行**集合**、行/分支/函数计数。门禁在三种情况下红：实际未覆盖行不在基线里、基线里的行已覆盖导致条目过期、或缺基线条目。只比较行数会漏掉“一行新增覆盖、另一行回退”的同数替换，所以基线存行号。`--update-debt` 在新增未覆盖行时拒绝写入，除非显式 `--accept-regression`；unit sidecar 记录 HEAD 与 porcelain，`coverage:check` 拒绝与当前工作树不一致的旧报告。当前基线为 60 个模块、1,055 行未覆盖（unit-owned line 95.68%），24 个模块已在 100；逐个模块清空是后续 ratchet 的目标。branch/function 计数只记录不阻断：V8 会随执行路径枚举不同的函数/区间，两次全量运行实测 branch 66.87% vs 67.02%、function 83.82% vs 83.86%，而 covered 行集合相同。

**6. 两层门禁与同一 artifact。** `test:coverage` 是每次 `src/**` 变更的阻塞门禁。[scripts/evidence/coverage-layered.mjs](../../../../scripts/evidence/coverage-layered.mjs) 的 `test:coverage:layered -- --base <ref>` 再跑浏览器 lane，把同一个 gate artifact（HEAD、base、二进制 diff SHA-256、porcelain）写进两份 sidecar，缺失 lane、身份不一致、浏览器报告不完整或 browser LCOV 缺文件都失败；报告写 `coverage/layered.json`。浏览器 lane 在 layered 命令里强制 strict，缺 `dsh`/Chromium 不能被当成通过。

**7. 浏览器覆盖归 browser lane。** `test:browser` 现在除 `coverage/client.json` 外还写 `coverage/browser.lcov`，并记录 `gateArtifact`。`src/client/notice.tsx` 因 KI-40 以 blocked 状态存在并跳过；其余 TSX 与 `client/contracts.ts` 必须出现在报告里。per-file line/function 门槛等有 reviewed 的 `tools/coverage-browser-floors.json` 才生效，且该文件必须覆盖每个 non-blocked 的 browser-owned 文件；当前没有该文件，浏览器百分比仍是 observational。

**8. 真实宿主证据不并入覆盖率。** 没有 host coverage lane：覆盖率只回答“源文件的每一行是否被执行”，真实宿主的组合、会话、HTTP 与面板行为继续由 `test:host-smoke` 和 E2E 承担。`coverage/` 是 gitignored 报告目录；`test:coverage -- --update-debt` 是唯一写基线的入口，门禁自身从不改基线。

## Alternatives considered

**把全局 floor 提高到 100。** 否决：聚合数不能定位文件；在修好行映射前它本身是错的，修好后也会掩盖单文件回归，且全仓 100 无法分批落地。

**继续用 transform + source map 修正行号。** 否决：Node 内置 source-map coverage 会把缩进函数体里的零覆盖区间映射到行首，未执行行仍可能算成已覆盖（fixture 已复现）；line-preserving strip 更简单且没有这个偏差。

**保留三 lane（unit + host E2E + browser）。** 否决：重构后宿主模块全部可注入，host lane 不改变任何文件的判定，只增加 dsh 依赖和 sourcemap 映射；真实宿主证据已由 host-smoke/E2E 承担。

**把 TSX 与 contracts.ts 塞进 Node 或 jsdom。** 否决：`react` 由宿主提供，jsdom 不渲染真实布局、焦点和滚动；那是假执行。

**引入 c8/istanbul 或自建插桩。** 否决：Node 已能输出 per-file LCOV，缺的是 line-preserving 加载和确定性收集，不是新的覆盖率引擎；新依赖还要顺带决定 lockfile 政策。

**立即 per-file 100、不设基线。** 否决：修正测量后仍有约 1,055 行缺口分布在 60 个模块，一次性提交会鼓励删断言或加 ignore；基线是 ratchet，不是永久排除。

**把低覆盖模块永久排除。** 否决：把风险从门禁移到运行时；`dev` 类只接 6 个待删除的 M12 驱动。

## Consequences

- `test:coverage` 现在会阻塞 line 回归，但全仓 per-file 100 尚未达到；1,055 行缺口按模块偿还，基线只能收缩。新增源文件默认没有基线条目，必须在 100% 或先补基线（需要评审）。
- 浏览器 lane 的 per-file 门槛仍未启用；`notice.tsx` 继续由 KI-40 阻塞。`test:browser` 的 Chromium/`dsh` 缺失在普通运行里仍是具名 skip，在 `test:coverage:layered` 里是失败；standalone strict 仍要求 clean worktree，layered 则用 artifact 绑定 dirty 树。dirty 树的内容不进 artifact 哈希，所以 dirty layered 只作评审证据；发布证据在 clean commit 上重跑。
- branch/function 只记录；等 V8 枚举稳定或换成稳定的 branch 指标后再启用阻断。
- line-preserving 加载要求新源文件保持 strip 兼容；需要 transform 的新语法会让 coverage guard 红，必须先决定是改写还是接受映射回退。
- 报告不提交；没有 CI 配置，因此“本地绿”不等于远端矩阵绿。真实宿主行为仍由 host-smoke/E2E 证明，不能被覆盖率替代。

## Testing

- [A1] 真实 loader 的 TS fixture 只把确定执行的行算绿；transform-only hook 会误报未执行行，映射检查能红 — `tests`
- [A2] 同一工作树两次逐文件收集的 covered/uncovered 行集合一致；任一测试文件非零退出或未写报告时失败 — `tests`
- [A3] `tools/coverage-map.json` 对 73 个源文件各分配一次；未映射、重复、未知 lane、越界 `dev`、缺 `reason`/`exitWhen` 都红 — `tests`
- [A4] 类型文件可缺席；有运行时语句却缺席的文件红；`src/index.ts` 由 entry test 加载 — `tests`
- [A5] 未覆盖行集合与基线不一致、缺条目或条目过期都红；`--update-debt` 写出 reviewed 基线 — `tests`
- [A6] `test:coverage:layered` 要求 unit + browser 报告与一致 artifact 身份；缺 lane、缺 browser LCOV、或浏览器报告不完整时红 — `workflow`
- [A7] 命令、阻塞级别、报告路径、owner map 与基线写进 [tools/workflow.json](../../../../tools/workflow.json)、[docs/testing.md](../../../../docs/testing.md)、[AGENTS.md](../../../../AGENTS.md)，`coverage/` 进 `.gitignore` — `workflow`
