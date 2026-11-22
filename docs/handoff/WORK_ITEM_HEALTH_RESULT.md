# 工作项代码健康度回归修复结果

- 状态：完成（2026-11-21）。P0/P1 已由 PR #78 交付，见 [交接](WORK_ITEM_HEALTH_HANDOFF.md)；本记录覆盖 P2（health 基线维护）与 P3（CI 强制）。
- 基线：`main` `c9f7e84`（PR #77 合并后）。
- 工具：fallow 3.43.0。P3 把精确版本固定进 `package.json` 的 `devDependencies.fallow`；P2 的人工审阅也使用该版本。
- 分支：`agent/fallow-health-gate`。

## P2 — health 基线维护

### 身份与命令

| 命令 | 结果 |
|---|---|
| `fallow 3.43.0`，HEAD `c9f7e84` | 固定 CLI 版本与 HEAD |
| `fallow health --baseline tools/fallow-health-baseline.json`（旧基线） | exit 1：83 条剩余 finding、12 条 stale 条目 |
| `fallow health --save-baseline tools/fallow-health-baseline.json` | 写入 184 条超阈值 finding / 254 个文件×类别计数 |
| `fallow health --baseline tools/fallow-health-baseline.json`（新基线） | exit 0：254/254 matched、0 stale、0 remaining |

### 审阅范围

旧基线在 `d9d2f7e` 保存（41 个文件 / 157 个计数 / 23 个 target key）。该点到 `c9f7e84` 之间有 30 个 first-parent merge，基线没有再维护：当前 184 条超阈值 finding 中 101 条仍被旧计数覆盖，83 条已经没有覆盖，健康命令在 main 上以 exit 1 结束。

83 条的核对方法与结果：

- 以 PR #74 的 base `6413911` 做对照运行。按「路径 + 函数名」比较，`c9f7e84` 的 83 条 finding 在 `6413911` 全部存在：新增 0 条，唯一差异是 `src/client/work-item/panel.tsx` 少了一个匿名箭头函数。因此这 83 条都不是本工作流（#74/#78）引入，而是已合并 PR 留下的存量。
- 构成：27 critical / 18 high / 38 moderate。40 条至少一项复杂度阈值超限（cyclomatic、cognitive 或 file lines），43 条只有 CRAP 超限。CRAP 使用静态覆盖率估算（`coverage_source=estimated`，tier 为 none/partial/high），没有实测运行时覆盖，因此 CRAP-only finding 是提示性信号，不单独作为正确性缺陷。
- 按区域：

| 区域 | 条数 | critical | high | moderate |
|---|---|---|---|---|
| `src/client/work-item` | 25 | 7 | 5 | 13 |
| `tests/` | 21 | 4 | 8 | 9 |
| `src/platform` | 12 | 1 | 4 | 7 |
| `src/domains` | 7 | 3 | 0 | 4 |
| `tools/` | 7 | 7 | 0 | 0 |
| `src/panel` | 4 | 1 | 0 | 3 |
| `src/tools` | 3 | 3 | 0 | 0 |
| `scripts/` | 3 | 1 | 0 | 2 |
| `src/store` | 1 | 0 | 1 | 0 |

- 其中最大的几条：`WorkItemViewer`（967 行，CC 65）、`runTopicPanel`（CC 66）、`scripts/evidence/e2e.mjs` 的 `main`（265 行，CC 61）、`e2eManifestProblems`（CC 52）、`runArtifactChain`（220 行，CC 51）。这五条在 `6413911` 上已存在。

### 分类接受理由

1. **测试与 harness（21 条）**：`tests/e2e/scenarios`、`tests/e2e/support` 与 `tests/guards` 的复杂度来自线性步骤、等待/重试分支和断言编排，不是产品运行路径；critical 集中在 `topic-panel`、`artifact-chain` 与 `scripted-model`。作为测试 harness 存量接受。
2. **`src/client/work-item`（25 条）**：`WorkItemViewer` 是已知结构债（KI-61），其余是面板 handler、渲染分支与 presence 回调。作为存量接受；结构拆分写入 KI-61 的 burn-down，不再把存量当成新增。
3. **artifact 域与平台（`src/domains` 7、`src/platform` 12、`src/store` 1、`src/tools` 3、`src/panel` 4）**：复杂度集中在 anchor/merge/diff 解析、dispatch 状态机、工具入参与附件处理，属于显式的协议和合并逻辑。作为存量接受；后续改动这些函数时由 `audit` 的 introduced/worsened 继续兜底。
4. **仓库工具与证据脚本（`tools/` 7、`scripts/` 3）**：`check-invariants`、`e2e-coverage` 与证据入口的分支大多是错误收集和参数校验；作为存量接受。
5. **CRAP-only（43 条）**：见上，依赖静态覆盖率估算，不进入本轮修复。

本轮没有放宽阈值、没有加 `fallow-ignore`、没有改源码来消除 finding。

### 12 条 stale 条目

旧基线的 12 条 stale 条目（共 13 个计数，其中 `src/tools/topic.ts` 的 `crap_high` 只从 2 降到 1）逐条核对如下：

| 文件 | 旧计数 | 处理 |
|---|---|---|
| `src/dev/m12-e2e-evidence.ts` | `complexity_moderate` 1、`complexity_high` 1 | 文件在 `c9e06fc` 退役，条目删除 |
| `src/dev/m12-e2e.ts` | `complexity_critical` 2、`crap_critical` 2、`crap_high` 2、`crap_moderate` 2 | 同一退役提交删除，条目删除 |
| `src/domains/requests/request-open.ts` | `crap_moderate` 1 | `resolveOpenableFile` 不再超阈值，条目删除 |
| `src/tools/topic.ts` | `crap_high` 2 | `requestAuthorization` 从 high 降到 moderate，保留 1 个计数 |
| `tests/domains/review/review-request-gate.test.mjs` | `crap_moderate` 1 | `runGit` 变为 high（cognitive + CRAP），旧 moderate 条目失效；新 finding 进入本轮审阅并接受 |

### 基线变化

| 项目 | 旧基线（`d9d2f7e`） | 新基线（`c9f7e84`） |
|---|---|---|
| 文件 | 41 | 69 |
| 文件×类别计数 | 157 | 254 |
| target key | 23 | 41 |

剪掉 13 个 stale 计数、增加 110 个计数后，新基线覆盖全部 184 条 finding，`fallow health --baseline` 退出 0。逐条核对的 83 条 finding 与分类理由如上；target key 从 23 增加到 41（fallow 生成的重构目标标识），随同一次刷新保存。

## P3 — CI 强制

P3 改变了「fallow 只做本地信号」的历史决策，新增 [decision record](../../.agents/notes/implemented/process/2026-11-21-fallow-health-ci-gate.md)。

- `package.json` 精确固定 `devDependencies.fallow = 3.43.0`，新增 `fallow:health`（`fallow health --baseline tools/fallow-health-baseline.json`）与 `fallow:audit`（`fallow audit --worsened error`）脚本；本地和 CI 跑同一命令。
- `package-lock.json` 只新增 154 行：fallow、`detect-libc` 与 8 个平台 optional dependency，`resolved` 全部指向 `https://registry.npmjs.org/`。
- `.github/workflows/ci.yml` 新增独立 `code-health` job，只在非 docs-only 的 PR 上运行。步骤：`npm ci` → `git merge-base` 解析 PR 的 base sha → `npm run --silent fallow:audit -- --base <sha> --format json` → `node scripts/ci/fallow-gate.mjs` → `npm run fallow:health`。`pr-gate` 把 `code-health` 纳入必需 lane，并像 `unit` 一样拒绝 docs-only 变更里意外运行的 lane。
- `scripts/ci/fallow-gate.mjs` 断言 `attribution.complexity_introduced` 与 `complexity_worsened` 都为 0，并把报告绑定到 kind、CLI 版本（默认读 `package.json` 的 pin）、base 和 head（接受 fallow 输出的短 SHA 前缀）。负例在 `tests/guards/fallow-gate.test.mjs`，job 结构断言在 `tests/guards/ci-workflow.test.mjs`。
- `--worsened error` 仍是 audit 的失败条件；JSON 断言补上退出码看不到的 warn 级 line-count 增长。health 对 stale 条目仍只警告：启用 `--fail-on-stale-baseline` 会让「删除函数」的普通 PR 变红，与「只在维护 PR 刷新基线」冲突。
- `--baseline-mode identity` 已评估并否决：按函数身份匹配会让每次拆分或重命名都要求刷新基线；变更级回归继续由 `fallow audit` 的 introduced/worsened 覆盖。`--fail-on-baseline-growth` 本次不启用，因为维护 PR 的任务就是新增基线键，启用会让迁移本身失败。

## 验收

| 命令 | 结果 |
|---|---|
| `npm run check` | exit 0（含 export audit、docs 与 publish 检查） |
| `npm run check:self-test` | exit 0：10 kinds + 35 project negative controls |
| `npm test` | 1615/1615 pass（首次在并发安装负载下 1614/1615，未记录失败用例；随后两次复跑均全绿） |
| `npm run test:coverage` | exit 0：83 modules，line 100.00%（31609/31609） |
| `npm run typecheck` | exit 0（host + client） |
| `npm run build` | exit 0（lib/client.js 15,168 KB） |
| `npm run test:host-smoke` | exit 0：5/5 PASS |
| `npm run test:coverage:layered -- --base c9f7e84` | exit 0：97 counted files，line 99.88% |
| `npm run fallow:health` | exit 0：254/254 matched、0 stale、0 remaining |
| `npm run test:e2e -- --record` | exit 0：6 个 keyless 场景 / 140 项检查，证据重录到 `292088b` |
| `npm run fallow:audit -- --base c9f7e84 --format json` + gate | exit 0：verdict pass，16 个变更文件，`complexity_introduced=0`、`complexity_worsened=0`；gate 在 `25ee373` 上通过 |
| `npm run change-scope -- --base c9f7e84` | exit 0：committed 16，staged / unstaged / untracked 均为 0 |
