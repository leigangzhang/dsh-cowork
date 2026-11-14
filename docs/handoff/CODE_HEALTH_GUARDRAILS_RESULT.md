# 代码健康度守卫执行结果

- 状态：**执行中（2026-11-13）**。本记录是 `code-health-guardrails` 工作流的 Stage 0 映射与最终证据；规则来源是 [提案](../../.agents/notes/proposed/process/2026-11-13-code-health-guardrails.md)，执行顺序见 [交接](CODE_HEALTH_GUARDRAILS_HANDOFF.md)。
- 基线：`origin/main` = `edd777e`（PR #33 已合并），工作分支 `agent/code-health-guardrails-impl` 只在其上追加 guardrails 提案、tool-domain 提案与执行交接三份文档。
- 范围：只做代码健康度守卫。**不开始 tool-domain 目录迁移**，不移动 `src`/`tests` 目录，不改工具名、路由、preset、包入口。

## Stage 0 — 规则映射

每条规则只有一个 home；触发方式必须能用命令复核；“纯判断”项不伪装成机器检查。allowlist 政策：只有带 reason 与复查条件、且能让新增违规变红的基线才算 allowlist；历史记录（`docs/handoff/`、`.agents/notes/implemented/`）与测试里的负向断言不在扫描面上。

| 规则 | home | 触发 / 入口 | 失败方式 | 状态 |
|---|---|---|---|---|
| A1 `noUnused*` 全覆盖 | `tsconfig.json`、`tsconfig.client.json` | `npm run typecheck` | tsc 报未用局部/导入 | 已存在（host/client 均已开启） |
| A2 导出使用审计 | `tools/check-invariants.mjs` + `tools/export-baseline.json` | `npm run check` | 新增零引用导出或新增仅测试引用导出；基线失效同样红 | 待新增 |
| A3 陈旧名称/模型文本扫描 | `tools/check-invariants.mjs`（`STALE_NAME_RULES`） | `npm run check` | 当前面文本命中已删工具名、已删模块、旧计数 | 待新增 |
| A4 干净 worktree 与证据链接 | `scripts/clean-check.mjs`（`npm run check:clean`）+ `no-ignored-links` 检查 | `npm run check:clean`、`npm run check` | 干净副本里 check 失败；Markdown 链接指向 `.dsh-cowork/` | 待新增 |
| A5 预算门禁 | `tests/source-budget.test.mjs` | `npm test`、`npm run test:coverage` | 文件 >50 KiB、`src/index.ts` >30 KiB、测试 >1,200 行、新增宿主 `index.ts` | 部分存在（50 KiB 与部分文件），待补齐 |
| A6 架构方向测试 | `tests/architecture.test.mjs` | `npm test` | import 环、client 越界、工具装配反向依赖、工具→领域映射不一致 | 待新增 |
| A7 测试发现负例 | `package.json`、`scripts/test-coverage.mjs`、`tests/coverage-policy.test.mjs` | `npm test`、`npm run test:coverage` | 子目录测试不被发现；负例证明递归发现会跑到 | 待新增 |
| A8 公共面快照 | `tests/support/public-surface.mjs`、`tests/packaging.test.mjs`、`tests/presets.test.mjs`、`tests/tool-schema-budget.test.mjs` | `npm test` | 22 工具/10 路由/3 preset/3 export 键变化 | 已存在，补 3 export 键的精确断言 |
| A9 gate artifact 与 scope 对账 | `scripts/gate-artifact.mjs`、`docs/agent-teams.md`、`.agents/skills/pr-description/SKILL.md` | `npm run gate-artifact -- --base <ref>` | HEAD/diff sha/porcelain 与 scope 未被记录或无法对账 | 待新增 |
| A10 工具面预算 | `tests/tool-schema-budget.test.mjs` | `npm test` | 22 工具序列化 >16,523 B，或新增第 23 个工具 | 已存在 |
| B 审查清单（纯判断） | [code-review skill](../../.agents/skills/code-review/SKILL.md) | review 时逐条判断 | 无机器失败方式；review finding 引用条目 | 待新增 |
| C 决策与 AgentTeams 流程 | [docs/agent-teams.md](../agent-teams.md)、[pr-description](../../.agents/skills/pr-description/SKILL.md)、提案记录 | 任务契约与 PR 描述 | 缺 gate artifact、cap 复用旧证据、并行写域重叠 | 部分存在，补齐 |

### Allowlist 与误报策略

- **导出审计**分三档：`dead`（仓库内零引用）直接红，不设 allowlist；`testOnly`（只被测试引用）用 ratchet 基线记录，新增即红、基线条目失效也红；`overExported`（只在本文件内使用）只报告，不红。
- **陈旧名称**只扫描当前事实面（`src/**`、`README.md`、`AGENTS.md`、`.agents/skills/**`、`docs/*.md`，排除两份 plan），不扫描历史记录与测试负向断言；基线阶段不做 allowlist。
- **预算**的 48 KiB 是软目标：超过只报告，50 KiB 才失败；阈值调整必须同时改测试并在交付记录写明理由。

## 基线证据（工作分支起点 `3ca921c`，base `edd777e`）

| 命令 | 结果 |
|---|---|
| `npm run check` | exit 0（含 `source-hygiene`） |
| `npm test` | 963 tests / 963 pass / 0 fail |
| `npm run test:coverage` | all files 67.59 lines / 83.50 branches / 84.27 functions，exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `npm run test:host-smoke` | 5/5 PASS |
| `git diff --binary origin/main..HEAD \| shasum -a 256` | `567e37aef75dbf7f8222a6d8979d0a2211d11cec1ca3b2ef96365410e3967b5a` |
| `git status --porcelain` | 0 行 |

## Stage 1 — 测试发现与门禁身份

**递归发现。** `npm test` 改为 `node --test "tests/**/*.test.mjs"`（引号让 Node 自己展开，shell 只展开一层时子目录会漏跑）；`scripts/test-coverage.mjs` 的 `testFilesIn` 改为递归收集 `*.test.mjs`。负例分两层：`tests/coverage-policy.test.mjs` 在临时目录里断言子目录测试被发现、support 模块不被当作测试；执行时另放一个临时 `tests/tmp-discovery-negative/nested-discovery.test.mjs`，`npm test` 与 `npm run test:coverage` 都跑到 969/969，删除后回到 968/968。测试文件没有移动。

**Gate artifact。** `npm run gate-artifact -- --base <verified-base>` 输出 `resolved`（base/head/merge-base）、`diff`（命令、SHA-256、字节数）、`porcelain` 与 `change-scope` 四组路径；`tests/gate-artifact.test.mjs` 在临时 git 仓库中核对 diff SHA 与真实 git 输出一致、四组路径分组正确、未知 base 失败。`docs/agent-teams.md` 拥有复用与 inScope 对账规则，`docs/testing.md` 与 `pr-description` 只引用该命令。

| 命令 | 结果 |
|---|---|
| `npm test`（无临时探针） | 968/968 pass，0 fail |
| `npm run test:coverage` | 968/968 pass，floors 通过 |
| `npm run check` / `npm run check:self-test` | exit 0；self-test 10 kinds + 11 project controls |
| `npm run typecheck` / `npm run build` / `npm run test:host-smoke` | 均 exit 0；host smoke 5/5 |

## Stage 2 — 硬门禁试点

试点就是本工作流：规则只在这一个分支上先跑通，同批没有目录迁移，也没有把 tool-domain 提案的 import 方向提前落实。误报与 allowlist 记录如下。

- **导出审计**（`tools/check-invariants.mjs`）：运行时导出分 `dead` / `testOnly` / `overExported` 三档，类型导出不参与。`dead` 与新增 `testOnly` 直接红；`testOnly` 用 `tools/export-baseline.json` 做 ratchet 基线（文件内写 `why` 与 `reviewBy`，共 142 条），基线条目失效也红；`overExported` 只报告（当前 72 条）。`--print-export-audit` 只读输出当前分类，避免写一个会自我放行的生成器。审计按标识符文本计数，注释命中会算引用，因此它可能漏报、不会凭空判定；类型使用由 `tsc` 负责。首次运行时删除唯一真正死导出 `MAX_FILE_TEXT`（`src/m12-e2e-contract.ts`）。
- **陈旧名称**（同一 runner 的 `STALE_NAME_RULES`）：覆盖已删工具/preset/模块、`src/router.ts`、旧工具数（19/15）、旧 preset 数（4）与旧路由数（6）。扫描面是 `src`、根 `README.md`/`AGENTS.md`、`.agents/skills` 和 `docs/*.md`；排除两份 plan、`docs/handoff/`、`docs/design/` 与 `docs/plain-language.md`（后者刻意引用退役措辞）。首次运行发现 README 与 glossary 的 “已删除” 说明被误报，因此新增规则：同一行显式标注 `已删除/removed/retired` 的是迁移说明，放行；自检各有一条命中与放行负例。
- **干净树**：`npm run check:clean` 把 tracked + 未忽略的 untracked 文件复制到临时目录（或 `--ref` 解包 `git archive`），确认没有 `.dsh-cowork/`、`lib/`、`node_modules/` 后在那里跑 `npm run check`；同时新增 `no-ignored-evidence-links` 检查，Markdown 链接指向 `.dsh-cowork/` 即红。负例在 `tests/workflow.test.mjs`（链接命中 vs 纯代码提法）。
- **架构方向**：`tests/architecture.test.mjs` 断言行内 import 全部可解析、无环、`src/index.ts` 是汇点、只有入口 import `src/tools.ts`、client 只 import client 与三个 contract、contract 不 import 宿主运行时、22 个工具各由唯一领域模块注册且 register 函数各被调用一次。每条规则都用合成坏图证明会红。
- **noUnused 负例**：`tests/typecheck-policy.test.mjs` 先在临时目录编译一个含未用局部与未用参数的文件，断言失败且输出含 `never read`，再用同样 flags 编译干净文件断言成功；另一个测试锁住两份 tsconfig 的开关。

| 命令 | 结果 |
|---|---|
| `npm test` | 980/980 pass，0 fail |
| `npm run test:coverage` | 980/980 pass，all files 69.15 / 83.50 / 84.27 |
| `npm run check` / `npm run check:self-test` | exit 0；self-test 17 条 project 负例 |
| `npm run check:clean` | exit 0，303 个文件，无 `.dsh-cowork/` 或 `lib/` |
| `npm run typecheck` / `npm run build` / `npm run test:host-smoke` | 均 exit 0；host smoke 5/5 |

## Stage 3 — 预算与公共面

- **文件预算**：所有 `src/**/*.ts(x)` 以 50 KiB 为硬线、48 KiB 为软目标；软目标只打印不失败，硬线失败。当前最大文件 `src/store.ts` 49,983 B，超过软目标 831 B，距硬线 1,217 B；`src/review-request.ts` 48,758 B 在软目标内。
- **入口预算**：`src/index.ts` 21,830 B ≤ 30 KiB；`src/` 下没有第二个宿主 `index.ts`，公共入口保持唯一（`src/client/index.tsx` 是 client bundle 入口，不是宿主 barrel）。
- **测试预算**：所有 `tests/**/*.test.mjs` ≤ 1,200 行；当前最大 `tests/checkout.test.mjs` 1,051 行。
- **工具面**：`tests/tool-schema-budget.test.mjs` 继续锁 22 个工具、16,523 B，并用“第 23 个工具即超”作负例。
- **公共面快照**：新增 `tests/public-surface.test.mjs`，把 22 工具 / 10 路由 / 3 preset / 3 个 `exports` 键与工具→领域唯一映射放在同一处；任一数量变化都会让这次改动在一个 diff 里需要显式评审。`package.json` 的 exports 键也由该测试精确断言。
- **负例**：`tests/source-budget.test.mjs` 新增 `budgetProblems` / `lineBudgetProblems` / `hostEntryBarrels` 的合成超限用例（阈值含等号，超 1 B/1 行即红）。

| 命令 | 结果 |
|---|---|
| `npm test` | 986/986 pass，0 fail |
| `npm run test:coverage` | 986/986 pass，floors 通过 |
| `npm run check` / `npm run check:self-test` / `npm run check:clean` | exit 0；self-test 17 条 project 负例；clean 303 文件 |
| `npm run typecheck` / `npm run build` / `npm run test:host-smoke` | 均 exit 0；host smoke 5/5 |

## Stage 4 — 审查清单与决策记录

（收口阶段；最终 HEAD、diff sha 与各命令结果在此记录。）
