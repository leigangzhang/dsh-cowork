# Decision: 采用 fallow 作为受审的代码健康信号

Status: implemented
Date: 2026-11-14
Class: process

## Problem

仓库已经为运行时导出（export audit）、import 方向与循环（architecture test）、文件体积（source budget）、未使用的局部变量/参数（tsc）设了门禁。一次 fallow 3.43.0 运行仍发现了这些门禁看不到的类别：审计范围外的类型导出、`tools/`/`scripts/` 模块的导出、未使用的类成员、无主的开发脚本、重名符号，以及缺失的全函数复杂度与重复基线。零配置运行时还把已知噪声混进了 118 条 finding：宿主提供的 peer import、外部 `react` import，以及一条被静态图证明不是循环、却被 fallow 当作 lazy 边的 `new URL(..., import.meta.url)`。

## Decision

Fallow 是受审的本地信号，每个关注点只保留一个 owner。`.fallowrc.jsonc` 为每条 ignore 记录理由；CLI 保持本地（不加入 `devDependency`、不新增 lockfile，版本 3.43.0 记录在报告中）。

1. export audit 同时检查 host entry（`src/app/apply.ts`）的 re-export；该文件自身的声明仍豁免。
2. over-exported 计数保持 advisory，不做 ratchet。
3. `fallow dead-code --unused-types` 只作 review 证据，不设类型门禁。
4. fallow 默认 health 阈值（CC > 20、cognitive > 15、CRAP > 30、unit > 60）通过 `tools/fallow-health-baseline.json` 的评审基线覆盖所有函数；duplication 保持变更级规则。
5. `scripts/build/` 通过 `"ignorePatterns": ["!scripts/build/**"]` 纳入分析。
6. `NOTICE_TITLE_MAX_CHARS` 在 notice 契约与两个读取方中统一为 100。
7. 每个 `tools/*.mjs` 必须由 workflow surface 或脚本/测试 import 认领；无主工具会让 `npm run check` 失败。
8. `AGENTS.md` 与 code-review skill 承载 export/tool 归属规则和基线检查。

## Alternatives considered

**把 fallow 作为全仓 CI 门禁。** 否决：78 个未使用导出中有 73 个只在自己模块内使用，与现有审计已跟踪的 over-exported 重叠；零配置基线还包含已核实的误报。

**把 fallow 加为 devDependency 并运行可复现门禁。** 否决：这会给仓库引入首个 `package-lock.json`，并为每个平台增加约 43 MB 二进制，只为换取一个在 review 中即可读取的信号；只有 CI 强制成为需求时才重新考虑。

**扩展现有文本审计以覆盖类型导出。** 否决：类型使用归 `tsc` 管，而文本审计按标识符出现次数计数，无法判断实际消费的是哪个模块的 re-export；fallow 的模块图可以，因此它保持 review 证据。

## Consequences

- `fallow dead-code` 从零配置的 118 条降到 3 条已核实误报：设计资产 `docs/design/topic/assets/topic-demo.css`、由 workflow 调用的 `tools/m12-migration-drill.mjs`，以及经接口调用的 `mutateNotices` 成员。不再有未使用导出、未使用类型或重名导出。
- `fallow health` 报告 118 条全函数 finding、84.4/B。这组结果就是评审基线；`fallow health --baseline tools/fallow-health-baseline.json` 报告 0 条，出现新 finding 即失败。存量清单的 burn-down 由基线跟踪，不由本决策承担。
- CLI 保持本地，因此全函数基线无法在 CI 强制；评审采纳是唯一执行方式。若 CI 强制成为需求，重新打开此决策。
- fallow 的 60 行 unit 阈值比用户级 200 行函数规则更严；可执行的边界现在是 fallow 基线。
- `NOTICE_TITLE_MAX_CHARS` 是取值变更：客户端卡片按 100 截断（原 120），账本与 activity descriptor 按 100 截断（原 80）。
- `scripts/build/` 现在纳入分析；它的 2 条仅 CRAP 超标的 moderate finding 属于基线。

## Testing

- [A1] `.fallowrc.jsonc` 已提交，每条 ignore 有理由，`fallow doctor` 无失败检查。 — `workflow`
- [A2] `fallow dead-code` 只报告 3 条已核实误报；不再有未使用导出、类型或重名导出。 — `source`
- [A3] `fallow health --baseline tools/fallow-health-baseline.json` 退出码 0、零新增 finding；保存的基线是 118 条 / 84.4 B。 — `source`
- [A4] host-re-export 与 tools-ownership invariant 各自能拒绝一个合成坏例；`npm run check:self-test` 证明 19 个 project 负向控制。 — `workflow`
- [A5] `npm test`（989）、`npm run check`、`npm run check:self-test`、`npm run typecheck`、`npm run test:coverage`、`npm run build`、`npm run test:host-smoke` 均通过。 — `workflow`
