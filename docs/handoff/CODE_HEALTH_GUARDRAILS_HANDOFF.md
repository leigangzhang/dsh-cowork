# 代码健康度守卫执行交接

- 状态：**启动交接（2026-11-13）**。本文件写给第一个新会话，用于执行 `code-health-guardrails` 提案。它不重抄提案内容，也不预先执行任何检查；事实源是本文引用的提案与本文件。
- 适用：接手 guardrails 的 agent。范围：执行顺序、基线、每阶段停止条件、完成定义、回滚与禁止事项。**本轮不要开始 `tool-domain-modules`。**
- 提案：[2026-11-13-code-health-guardrails.md](../../.agents/notes/proposed/process/2026-11-13-code-health-guardrails.md)（commit `3e88da2`；本分支 `agent/next-work-handoffs` 已包含），状态仍是 proposed。

## 当前事实

- 基线 `main`：`a9172e1`（PR #34 已合并，清理记录在 base）。
- PR #33（`agent/cowork-optimization`，base `main`）**仍 OPEN**，head `6cd7ff6`，包含 `config.ts`、`dev-surfaces.ts`、`delivery.ts`、`api-types.ts`、m12 拆分与决策记录。开始前必须先决定：
  - **A. 先合并 #33**，以合并后的 main 为 guardrails 基线；或
  - **B. 暂不合并 #33**，在 guardrails 的映射与预算里明确排除其新增模块，并记录后续重评条件。
  两者选一，不要在两个 PR 同时改同一批文件。
- 当前没有执行 guardrails：没有新增门禁、没有移动测试、没有改 `AGENTS.md`。
- 关键约束：`AGENTS.md` 保持 ≤120 行；规则细节放 skill/check；不引入 ESLint/Prettier；不改变 22 工具/10 路由/3 preset/包入口。

## 先读什么

1. [AGENTS.md](../../AGENTS.md)、[docs/agent-teams.md](../agent-teams.md)、[docs/testing.md](../testing.md)：纪律、DAG/门禁、证据分层。
2. [code-health-guardrails 提案](../../.agents/notes/proposed/process/2026-11-13-code-health-guardrails.md)：A 硬门禁、B 审查清单、C 决策/Agent 规则、A1–A8 验收。
3. 本文件：执行顺序、停止条件、完成定义。

## 启动步骤

1. `git fetch origin`；确认 `origin/main` 与 #33 的状态，按上面的 A/B 选择基线。
2. 从选定基线创建 `agent/code-health-guardrails-impl`；不要直接改 `main`。
3. 跑基线并记录：`npm run check`、`npm test`、`npm run typecheck`、`npm run build`、`npm run test:host-smoke`（如环境允许）；记录 HEAD、diff sha、porcelain。
4. 先做 **Stage 0（规则映射）**：把提案 A/B/C 每条规则映射到现有 `tools/check-invariants.mjs`、tests、docs、skill；标出“已存在 / 待新增 / 纯判断”，不改代码。
5. 再按 Stage 1→4 执行。**Stage 1 必须先于任何测试/目录移动**；每个 Stage 单独 commit，Stage 结束跑对应门禁，不把多阶段压成一个 diff。

## 分阶段执行

### Stage 0 — 规则映射（不改代码）

产出：每条规则的归属、触发条件、失败方式、allowlist 策略；确认哪些已在 `check` 里，哪些要新增。若发现提案引用的文件/检查已不存在，先改提案或记录，不带着错误前提开工。

### Stage 1 — 测试发现与门禁身份（必须先做）

- 把 `package.json` 的 `node --test tests/*.mjs` 与 [scripts/test-coverage.mjs](../../scripts/test-coverage.mjs) 的 `testFilesIn` 改为递归发现。
- 加一条负例：在 `tests/<subdir>/` 放一个临时测试，证明 `npm test` 与 coverage 会跑到；删掉临时文件后仍全绿。
- 在不移动任何测试的情况下，证明现有测试数与通过数不变。
- 把 gate artifact（HEAD + `git diff --binary base..HEAD | shasum -a 256` + porcelain）与 `change-scope` 对账写进 AgentTeams/PR 模板或对应 check；docs-only 变更走 check + delta review。

### Stage 2 — 硬门禁试点

- `noUnused*` 已在 host/client 开启；补导出使用审计、陈旧名称/模型文本扫描、干净 worktree check（无 `.dsh-cowork`/本地缓存）。
- 新增 `tests/architecture.test.mjs`：import 方向、无环、工具→领域映射；这一步与 tool-domain 提案共享，先定义最小可执行版本。
- 每条规则至少一个负例，用 `check:self-test` 或对应测试证明会红；记录误报与 allowlist，不要为了全绿放开规则。
- 先在一个 workflow 试点，不要一次扩到全仓。

### Stage 3 — 预算与公共面

- 文件/入口/测试/工具 schema 预算：`src` 48 KiB 软目标、50 KiB 硬线；`src/index.ts` ≤30 KiB；测试 ≤1,200 行；22 工具 schema 16,523 B；禁 barrel。
- 公共面快照：[tests/support/public-surface.mjs](../../tests/support/public-surface.mjs) 与 packaging 测试锁住 22 工具/10 路由/3 preset/3 exports。
- 跑 `npm run check`、`npm test`、coverage、typecheck、build、host-smoke；记录 identity。

### Stage 4 — 审查清单与决策记录

- 把 B 清单放进 code-review skill（或新 skill）；`AGENTS.md` 只加不超过 5 行指针。
- 把 AgentTeams/PR 规则写进 [docs/agent-teams.md](../agent-teams.md)/[docs/testing.md](../testing.md)；不要在多个 home 复制同一规则。
- 只有 A1–A8 全部有证据后，才把提案从 `proposed/` 移到 `implemented/` 并改写为 Decision/Consequences/Testing；否则保持 proposed。

## 完成定义

- 提案 A1–A8 全部有可复核证据；硬门禁各有一个负例；干净 worktree 的 `npm run check` 能跑。
- `npm test`、coverage、typecheck、build、host-smoke 全绿；测试数与 public surface 不变；没有移动 `src` 目录。
- `AGENTS.md` 仍 ≤120 行；规则细节在 check/skill/docs；没有新增 ESLint/Prettier 依赖。
- 交付：分支 push + PR；PR 描述按 `pr-description` 写，Testing/Evidence 绑定最终 HEAD 与 diff sha；不自动合并。

## 禁止事项

- 不开始 tool-domain 的目录迁移；不移动 `src`/`tests` 目录；不改工具名/路由/preset/包入口。
- 不在 Stage 1 之前移动测试；不靠加大 glob 或跳过测试让门禁变绿。
- 不为了通过陈旧名称/导出审计而大规模 allowlist；每条 allowlist 要有理由与复查条件。
- 不重写历史 handoff/plan 的结论；只改失效链接目标。
- 不把规则细节塞进 `AGENTS.md`；不引入 ESLint/Prettier。

## 回滚

- 每个 Stage 单独 commit；回滚按 Stage 逆序 `git revert`，或关闭 PR/删除工作分支。
- 本提案与交接是 docs-only；回滚不涉及数据迁移或存储格式。
