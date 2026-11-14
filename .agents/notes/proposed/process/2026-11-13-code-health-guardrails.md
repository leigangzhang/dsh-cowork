# Proposal: 代码健康度守卫规则（生命周期、死代码、边界与门禁身份）

Status: proposed
Date: 2026-11-13
Class: process

## Problem

2026-11-13 的清理与优化两轮工作反复出现同一类问题：代码、文档和门禁都“看起来是绿的”，但已经不再描述当前系统。具体证据：

- **临时面没有生命周期。** M2/M3 驱动编码 v1 thread 语义，M12 交付记录已判定非验收，仍注册 6 条路由、3 条事件流；S0 是 M1 临时探针，文档写明“M1 收口应移除”，到 0.2.0 仍在。
- **测试为死代码保绿。** M2/M3 的测试只钉步骤表与 prompt 常量，不启动驱动；驱动在 v2 上首步就失败，测试仍全绿。
- **死代码分散在三种位置。** 17 处未用导入/局部、`checkoutDeps`/`TOPIC_STATUS_VALUES` 零引用、`recordActivity`/`errorActivity` 只被测试调用；host 没有 `noUnused*` 时无人发现。
- **注释、prompt 和模型指令是代码，却没有版本约束。** “19 个工具”实际 22；`routing.ts` 指向已删除的 `router.ts`；master/reviewer persona 仍教 thread 语义。
- **门禁依赖本地运行数据。** `M2_PROBE_RESULT.md` 链接 gitignored `.dsh-cowork`，干净 worktree/CI 的 `npm run check` 必红；本地因为存在该目录而一直绿。
- **结构被 50 KiB 上限驱动。** `notice-store`、`request-store`、`inbox-api`、`review-tools`、`tool-runtime` 等拆分是字节压力，不是职责边界；没有规则判断“新文件该放哪”。
- **兼容层侵入控制路径。** v1 索引看似只读兼容，但 `checkRole` 仍读 `index.threads`；删读 adapter 不等于删授权依赖。
- **质量结论与字节脱钩。** t7 的 change-scope 失败、t14 的 content-binding 警告、PR #33 base 从 cleanup 改为 main 后描述仍需重写，都是“结论没有绑定当前 artifact identity”。

这些问题的共同成本是：review 看到的是旧语义，测试证明了不存在的路径，门禁在本地绿、在干净环境红，结构改动被字节上限推着走。需要把“记得删/记得查/记得写”变成可执行规则。

## Proposal

把守卫分成三层，分别落在可执行门禁、审查清单和决策记录；不把所有内容塞进 [AGENTS.md](../../../../AGENTS.md)（它必须保持在 120 行内）。

### A. 硬门禁（机器可判红）

1. **`noUnused*` 全覆盖。** host 与 client 的 `tsconfig` 都开启 `noUnusedLocals`/`noUnusedParameters`；未用导入/局部在 typecheck/build 阶段失败。
2. **导出使用审计。** 扫描 `src/**/*.ts` 的导出名在其它生产文件的引用；零引用导出必须删除或列入显式 allowlist；只被测试引用的生产 API 必须标注理由。
3. **陈旧名称与模型文本守卫。** 对当前 `src`/`docs`/prompt 文本检查已删工具名、已删文件名、旧工具计数、旧 preset 名；model-facing 字符串（persona、tool description、错误文案）单独列白名单并随契约变更更新。
4. **干净 worktree 门禁。** 在无 `.dsh-cowork`、无本地缓存的临时 checkout 跑 `npm run check`；文档证据不得链接 gitignored 运行数据。
5. **预算门禁。** `src/**/*.ts` <50 KiB 硬线、48 KiB 软目标；`src/index.ts` ≤30 KiB；测试文件 ≤1,200 行；禁止用 `index.ts` barrel 绕过文件大小（公共入口只保留 `src/index.ts`）。
6. **架构方向测试。** 新增 `tests/architecture.test.mjs`：扫描 `src/**/*.ts` 的 import，证明 `tools → domains/platform`、`domains` 不 import 宿主/store/tools/panel、`platform → domains/store`、无环；同时断言注册工具都能映射到领域。
7. **测试发现负例。** [package.json](../../../../package.json) 的 `node --test tests/*.mjs` 与 [scripts/test-coverage.mjs](../../../../scripts/test-coverage.mjs) 的 `testFilesIn` 当前只读顶层。改为递归发现，并加一条“故意放在子目录的测试必须被跑到”的负例；先改发现，再移动测试。
8. **公共面快照。** 22 个工具名/注册顺序、10 条面板路由、3 个 preset、3 个 `exports` 键由 [tests/support/public-surface.mjs](../../../../tests/support/public-surface.mjs) 与 packaging 测试锁住；移动模块前后不变。
9. **gate artifact 与 scope 对账。** 每次集成/验证记录 HEAD、`git diff --binary base..HEAD | shasum -a 256`、`git status --porcelain`；review/verification 绑定该 identity；`npm run change-scope` 与所有实现 inScope 并集比较，例外必须写进任务契约并记录理由。
10. **工具面预算。** 22 个业务工具 schema 序列化 16,523 B 为预算；新增第 23 个工具必须显式决策并重设预算，不能静默增长。

### B. 审查清单（判断项，进 review skill/checklist）

- **生命周期**：每个 dev-only/临时/兼容模块是否有 owner、退役触发条件、移除时对应的测试或 KI？
- **legacy 路径**：适配器在只读、控制还是写路径？删除是否伴随角色/事务模型迁移？
- **事务/投递**：设计写明保证什么、不保证什么；补偿失败是否有可观测字段？共享的是“尝试/重试”还是“状态/账本”？
- **宿主边界**：是否用预算/观测 + KI 记录，而不是假抽象或跳过？
- **结构迁移**：是否有 proposed 记录、目标树、import 方向、分阶段与回滚？是否先改测试发现？
- **测试拆分**：测试数与断言数是否真的不变？是否复制断言凑绿？
- **模型文本**：persona、tool description、错误文案是否随工具/preset 变更同步？
- **文档链接**：当前文档指向现有文件；历史记录只改链接目标，不改结论。

### C. 决策与流程规则

- 结构迁移先写 proposed 记录：目标树、工具→领域映射、import 方向、迁移阶段、风险、验收；未批准不搬目录。
- 一个 workflow 最多一份决策记录；proposed 与 implemented 分离，implemented 只写已落地事实、后果与 Testing。
- PR 描述在 base/head 变化后重写，不追加“round 2”；Testing/Evidence 必须绑定当前 HEAD 与 diff sha。
- AgentTeams：派单前 impact scan；并行写 worktree + 显式互斥 inScope；合并前 commit；独立 verifier/reviewer；review 绑定 artifact identity；一次 review finding 批量 repair；docs/comment-only 增量走 check + delta review。
- 门禁失败先判断“契约错”还是“代码错”；契约错用 amend/repair 记录，不绕过门禁，也不靠复跑碰运气。

### 落地位置（不执行）

- 硬门禁 1–10 落到 `tools/check-invariants.mjs`、`tests/architecture.test.mjs`、`tests/source-budget.test.mjs`、`tests/support/public-surface.mjs`、`scripts/test-coverage.mjs`、`package.json`；负例进 `check:self-test`。
- 审查清单进 `.agents/skills/code-review/SKILL.md` 或新增 `code-health-review` skill；[AGENTS.md](../../../../AGENTS.md) 只加不超过 5 行指针。
- AgentTeams/PR 规则进 [docs/agent-teams.md](../../../../docs/agent-teams.md) 与 [docs/testing.md](../../../../docs/testing.md)，不复制到多处。
- 本提案只定义规则，不新增检查、不移动文件、不改 `AGENTS.md`。

## Alternatives considered

**把所有规则写进 AGENTS.md。** 否决：AGENTS.md 已接近 120 行上下文预算；规则细节会把项目事实挤掉，且无法机器执行。AGENTS 只保留指针，细节放 skill/check。

**只写一份 docs 规则页，不加门禁。** 否决：本轮已经证明“文档写了”不等于“会执行”；M1 文档写明移除 S0，S0 仍活到 0.2.0。至少 1–10 中可自动化的部分必须进 `npm run check` 或测试。

**一次性把所有检查加上，不做 pilot。** 否决：陈旧名称/导出审计容易误报；直接全仓红会制造噪音并诱发 allowlist 滥用。先选一个真实 workflow 试点，证明规则能红也能放行，再扩大。

**引入 ESLint/Prettier 作为统一入口。** 否决为本轮默认：会新增依赖与全仓格式化 diff，掩盖行为改动；先完成无依赖的 tsc/文本卫生/架构方向门禁，规则类缺陷反复出现时再评估（KI-48）。

**继续只靠 review 记忆。** 否决：本轮的 4 个影响面缺口、2 个越界路径、1 个 content-binding 警告都是“记忆不可靠”的直接证据；review 应判断风险，不应替代机械检查。

## Acceptance criteria

- [A1] 每条规则都有归属（硬门禁/审查清单/决策记录）、触发条件和可复核的失败方式 — `workflow`、`decisions`
- [A2] `noUnused*`、导出审计、陈旧名称扫描、预算检查都有可执行入口，并且至少各有一个负例证明会红 — `source`、`tests`
- [A3] 测试发现改为递归后，子目录测试负例通过；移动测试时不会静默漏跑 — `tests`
- [A4] 新增架构方向测试：import 方向、无环、工具→领域映射；反向依赖会红 — `tests`
- [A5] 干净 worktree/CI 的 `npm run check` 通过；文档链接不再依赖 gitignored 数据 — `workflow`
- [A6] gate artifact（HEAD/diff sha/porcelain）与 scope 对账进入 AgentTeams 任务与 PR 证据；越界路径必须显式例外 — `decisions`
- [A7] `AGENTS.md` 只增指针且仍 ≤120 行；规则细节在 skill/check，不重复 — `workflow`
- [A8] 先在一个 workflow 试点，误报与 allowlist 有记录；试点通过后再推广 — `tests`、`decisions`

## Risks

- **误报与 allowlist 滥用**：陈旧名称/导出审计会命中历史文案或测试专用 API；必须要求 allowlist 带理由与复查日期，否则规则会被掏空。
- **门禁疲劳**：所有规则同时上线会让 PR 长期红；按 Stage 0–4 分批，先试点再扩大。
- **测试发现改动本身有风险**：递归发现若写错会少跑测试；必须先加“子目录负例”，再移动任何测试。
- **AGENTS 预算**：规则细节不能进 AGENTS；只放指针，否则会挤压项目事实。
- **结构迁移与进行中的 PR 冲突**：PR #33 与工具→领域提案都改路径；迁移顺序必须显式，不能同时搬目录。
- **无法自动化的部分**：生命周期、legacy 控制路径、事务保证范围仍需 review 判断；规则只提供清单，不替代判断。
- **过度检查**：预算/架构测试可能把正常的小改动变红；阈值要按观测基线设置，并保留调整记录。

## Delivery stages

1. **Stage 0 — 规则冻结**：把 A/B/C 规则映射到现有 `check`/测试/文档，标出已存在、待新增、纯判断项；不改代码。
2. **Stage 1 — 发现与身份**：递归测试发现 + 子目录负例；gate artifact/scope 对账进 AgentTeams/PR 模板。
3. **Stage 2 — 硬门禁试点**：在一个 workflow 上加 `noUnused`、导出审计、陈旧名称、干净 worktree、架构方向测试；记录误报与 allowlist。
4. **Stage 3 — 预算与公共面**：入口/文件/测试/工具 schema 预算，公共面快照；扩大到所有 src 变更。
5. **Stage 4 — 审查清单与决策记录**：把 B 清单进 code-review skill；proposed/implemented 与 PR 描述规则进 docs；清理旧规则重复。
