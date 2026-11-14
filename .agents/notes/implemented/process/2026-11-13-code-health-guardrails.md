# Decision: 代码健康度守卫规则（生命周期、死代码、边界与门禁身份）

Status: implemented
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

这些问题的共同成本是：review 看到的是旧语义，测试证明了不存在的路径，门禁在本地绿、在干净环境红，结构改动被字节上限推着走。守卫因此分三层落地：可执行门禁、审查清单、决策与流程规则；`AGENTS.md` 只保留指针。

## Decision

### A. 硬门禁（机器可判红）

1. **`noUnused*` 全覆盖。** 两份 `tsconfig` 开启 `noUnusedLocals`/`noUnusedParameters`，由 `npm run typecheck` 执行；[tests/typecheck-policy.test.mjs](../../../../tests/typecheck-policy.test.mjs) 让编译器真的拒绝未用局部与未用参数，并锁住两份配置的开关。
2. **导出使用审计。** [tools/check-invariants.mjs](../../../../tools/check-invariants.mjs) 只审计运行时导出：仓库内零引用的 `dead` 直接红；只被测试引用的 `testOnly` 必须出现在 [tools/export-baseline.json](../../../../tools/export-baseline.json) 的 ratchet 基线里，新增或失效都红；只在本文件内使用的 `overExported` 只报告。类型导出不参与，类型使用由 `tsc` 负责。
3. **陈旧名称与模型文本。** 同一 runner 的 `STALE_NAME_RULES` 扫描当前事实面：已删工具/preset/模块、`src/router.ts`、旧工具数、旧 preset 数与旧路由数。`docs/handoff/`、`.agents/notes/`、两份 plan 与测试负向断言不在扫描面；同一行显式标注“已删除/removed/retired”的迁移说明放行。
4. **干净 worktree 门禁。** `npm run check:clean` 把 tracked 与未忽略的 untracked 文件复制到临时目录（或 `--ref` 解包 `git archive`），确认没有 `.dsh-cowork/`、`lib/`、`node_modules/` 后运行 `npm run check`。`no-ignored-evidence-links` 检查同时禁止 Markdown 链接指向 `.dsh-cowork/`。
5. **预算门禁。** [tests/source-budget.test.mjs](../../../../tests/source-budget.test.mjs) 覆盖全部 `src/**/*.ts(x)`：50 KiB 硬线、48 KiB 软目标（只报告）、`src/index.ts` ≤30 KiB、测试文件 ≤1,200 行、宿主 `index.ts` 入口唯一；预算 helper 用合成超限条目自证会红。
6. **架构方向测试。** [tests/architecture.test.mjs](../../../../tests/architecture.test.mjs) 解析 `src` 的相对 import：全部可解析、无环、`src/index.ts` 是汇点、只有入口 import `src/tools.ts`、client 只 import client 与三个 contract、contract 不 import 宿主运行时、22 个工具各由唯一领域模块注册且 `register*Tools` 各被调用一次。每条规则都有合成坏图负例。
7. **测试发现负例。** `npm test` 用 `node --test "tests/**/*.test.mjs"`（引号让 Node 自己递归展开），`scripts/test-coverage.mjs` 的 `testFilesIn` 递归收集同一集合；[tests/coverage-policy.test.mjs](../../../../tests/coverage-policy.test.mjs) 证明子目录测试会被发现、support 模块不会被当作测试。
8. **公共面快照。** [tests/public-surface.test.mjs](../../../../tests/public-surface.test.mjs) 锁住 22 个业务工具、10 条面板路由、3 个 preset、3 个 `exports` 键与工具→领域唯一映射；[tests/support/public-surface.mjs](../../../../tests/support/public-surface.mjs) 仍是唯一列表来源。
9. **gate artifact 与 scope 对账。** `npm run gate-artifact -- --base <verified-base>` 输出 HEAD、`base..HEAD` binary diff 的 SHA-256、porcelain 与 `change-scope` 四组路径；[docs/agent-teams.md](../../../../docs/agent-teams.md) 拥有复用与 `inScope` 并集对账规则，[pr-description](../../../../.agents/skills/pr-description/SKILL.md) 引用同一命令。
10. **工具面预算。** [tests/tool-schema-budget.test.mjs](../../../../tests/tool-schema-budget.test.mjs) 继续锁 22 个工具、16,523 B 序列化 schema；“第 23 个工具即超”是它的负例。

### B. 审查清单（纯判断）

[.agents/skills/code-review/SKILL.md](../../../../.agents/skills/code-review/SKILL.md) 在 How 下新增 Code health 清单：生命周期与退役触发条件、legacy 路径是只读还是控制路径、事务/投递保证与补偿是否可观测、宿主边界是否用预算与 KI 记录、结构迁移是否有 proposed 记录与回滚、测试拆分后测试与断言数是否真的不变、模型文本是否随工具/preset 同步、文档链接是否指向现有文件。机器能判的部分不放这里。

### C. 决策与流程规则

- 结构迁移先写 proposed 记录（目标树、工具→领域映射、import 方向、阶段、风险、验收），未批准不搬目录；本轮 guardrails 明确不启动 tool-domain 迁移。
- 一个 workflow 最多一份决策记录；proposed 与 implemented 分离，implemented 只写已落地事实、后果与 Testing。
- PR 描述在 base/head 变化后重写，不追加“round 2”；Testing/Evidence 绑定当前 HEAD、diff sha 与 scope 组。
- AgentTeams：派单前 impact scan；并行写 worktree + 显式互斥 `inScope`；验证/审查绑定 gate artifact；一次 review finding 批量 repair；门禁失败先判断“契约错”还是“代码错”，契约错用 amend 记录，不绕过也不靠复跑碰运气。
- `AGENTS.md` 保持 ≤120 行，只放指针；规则细节在 skill/check/docs。
- 不引入 ESLint/Prettier；文本卫生、导出、预算是本仓库自己的无依赖门禁（KI-48）。

## Alternatives considered

**把所有规则写进 AGENTS.md。** 否决：AGENTS.md 已接近 120 行上下文预算；规则细节会把项目事实挤掉，且无法机器执行。AGENTS 只保留指针，细节放 skill/check。

**只写一份 docs 规则页，不加门禁。** 否决：本轮已经证明“文档写了”不等于“会执行”；M1 文档写明移除 S0，S0 仍活到 0.2.0。至少 1–10 中可自动化的部分必须进 `npm run check` 或测试。

**一次性把所有检查加上，不做 pilot。** 否决：陈旧名称/导出审计容易误报；直接全仓红会制造噪音并诱发 allowlist 滥用。先选一个真实 workflow 试点，证明规则能红也能放行，再扩大。

**引入 ESLint/Prettier 作为统一入口。** 否决为本轮默认：会新增依赖与全仓格式化 diff，掩盖行为改动；先完成无依赖的 tsc/文本卫生/架构方向门禁，规则类缺陷反复出现时再评估（KI-48）。

**继续只靠 review 记忆。** 否决：本轮的 4 个影响面缺口、2 个越界路径、1 个 content-binding 警告都是“记忆不可靠”的直接证据；review 应判断风险，不应替代机械检查。

**导出审计直接红掉全部 142 个 test-only 导出。** 否决：这些导出是测试钉住的契约值或测试缝，一次性删除会引入大范围行为风险；采用带 `why`/`reviewBy` 的 ratchet 基线，新增即红、基线条目失效也红，让存量只能收缩。

## Consequences

- 存量债务被显式记录而不是假装清零：142 条 test-only 基线条目、72 条 `overExported` 报告、`src/store.ts` 超 48 KiB 软目标 831 B。三者都只有收缩路径，没有自动放宽路径。
- 导出审计按标识符文本计数：注释命中会算引用，类型导出不在范围内。它能阻止新增死代码，不能证明存量全部干净；这由 review 与后续清理承接。
- `check:clean` 在测试里多一次全量复制与 `npm run check`（约 1.8 s），换来干净环境可见性。
- gate artifact 让验证/审查必须绑定一个可复核的 identity；base/head 变化后旧证据失效，需要重新记录。
- 未引入 ESLint/Prettier，风格类与复杂度问题仍靠 review（KI-48 保持）。

## Testing

- [A1] 两份 tsconfig 的 `noUnused*` 开启，编译器会拒绝未用局部与参数 — `source`：[tsconfig.json](../../../../tsconfig.json)、[tsconfig.client.json](../../../../tsconfig.client.json)、[tests/typecheck-policy.test.mjs](../../../../tests/typecheck-policy.test.mjs)
- [A2] 导出审计的 dead、新增 testOnly、失效基线三类都能红；`--print-export-audit` 只读输出 — `workflow`：[tools/check-invariants.mjs](../../../../tools/check-invariants.mjs)、[tools/export-baseline.json](../../../../tools/export-baseline.json)
- [A3] 陈旧名称扫描命中已删工具/模块/旧计数会红，显式 removed 的迁移说明与历史记录放行 — `workflow`：[tools/check-invariants.mjs](../../../../tools/check-invariants.mjs)、`npm run check:self-test`
- [A4] 干净副本里 `npm run check` 通过，Markdown 链接指向 `.dsh-cowork/` 会红 — `workflow`：[scripts/clean-check.mjs](../../../../scripts/clean-check.mjs)、[tests/workflow.test.mjs](../../../../tests/workflow.test.mjs)
- [A5] 50 KiB 硬线、30 KiB 入口、1,200 行测试与唯一入口都有可失败的断言 — `tests`：[tests/source-budget.test.mjs](../../../../tests/source-budget.test.mjs)
- [A6] import 环、client 越界、入口反向依赖与工具映射不一致都会红 — `tests`：[tests/architecture.test.mjs](../../../../tests/architecture.test.mjs)
- [A7] 子目录测试被 `npm test` 与 coverage 发现；删除临时探针后测试数回到基线 — `tests`：[tests/coverage-policy.test.mjs](../../../../tests/coverage-policy.test.mjs)
- [A8] 22 工具/10 路由/3 preset/3 exports 的快照与映射一致 — `tests`：[tests/public-surface.test.mjs](../../../../tests/public-surface.test.mjs)、[tests/support/public-surface.mjs](../../../../tests/support/public-surface.mjs)
- [A9] gate artifact 在真实临时仓库中核对 HEAD、diff SHA、porcelain 与四组路径 — `decisions`：[docs/agent-teams.md](../../../../docs/agent-teams.md)、[tests/gate-artifact.test.mjs](../../../../tests/gate-artifact.test.mjs)
- [A10] 22 工具 16,523 B schema 预算与第 23 个工具负例 — `tests`：[tests/tool-schema-budget.test.mjs](../../../../tests/tool-schema-budget.test.mjs)
