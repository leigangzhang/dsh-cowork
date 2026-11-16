# Proposal: 为 client-browser-coverage 设置 reviewed per-file floors

Status: proposed
Date: 2026-11-15
Class: testing

## Problem

浏览器 lane 已由 [client-browser-coverage 决策](../../implemented/testing/2026-11-13-client-browser-coverage.md) 建立，并由 [layered gate](../../implemented/testing/2026-11-13-layered-100-coverage-gate.md) 接入统一 artifact。当前 `test:coverage:layered` 会强制浏览器 lane 运行、校验 sourcemap 完整性/行数一致性/blocked 集合，但 per-file line/function 百分比仍是 observational：`tools/coverage-browser-floors.json` 不存在，[coverage-check.mjs](../../../../scripts/evidence/coverage-check.mjs) 的 `readBrowserFloors` 返回 null，summary 只写 `observational`。

2026-11-15 clean headless layered 运行的实际值：`src/client/panel.tsx` 70.65%（378/535）、`src/client/list.tsx` 70.27%（208/296）、`src/client/inbox.tsx` 95.53%（449/470）、`src/client/index.tsx` 100%（46/46）、`src/client/contracts.ts` 100%（22/22）、`src/client/notice.tsx` blocked（KI-40：宿主无 `ctx.sessionNotices`）。`notice-model.ts` 33.6%、`model.ts` 67.65% 是报告里的 `.ts` 交叉数据，归 unit lane，不是浏览器门禁。没有 floors 时，panel/list 的大幅回退不会让门禁变红。

## Proposal

**1. 先补场景，不定门槛。** 按未覆盖区间补行为场景，优先 `panel.tsx` 79-99（布局/底栏/空态/错误变体）和 `list.tsx` 51-57、115、250-262（筛选、空态、错误、菜单）；断言 DOM/ARIA 与对应 API 请求/响应，不做截图-only 断言。复用 [tests/browser/scenarios.mjs](../../../../tests/browser/scenarios.mjs) 的单一浏览器会话和 fixture 隔离，不以 sleep 当就绪。

**2. 三连绿后再定 floors。** 在 clean commit、固定主机与 Chromium 上连续跑 3 次 `npm run test:coverage:layered -- --base origin/main`，记录每次 artifact identity、per-file line/function 和与上次的差异。三次都绿且差异只来自页面数据后，取每文件三次最低值作为首版 floor；不要求首版 100。

**3. floors 文件契约。** 新增 `tools/coverage-browser-floors.json`，`version: 1`，`files` 必须覆盖每个 non-blocked browser-owned 文件；值只允许 `lineCoverage`、`functionCoverage`，范围 0..100。`notice.tsx` 保持 blocked，不设 floor；KI-40 解除后按同一流程补场景并加入 floors。部分覆盖、未知 key、越界值继续由 checker 当红处理（现有 `readBrowserFloors` 已实现）。

**4. 提升为阻断。** floors 文件合入后，`test:coverage:layered` 的浏览器部分从 observational 提升为 blocking：低于 floor、缺少 floor、floors 文件畸形都失败；standalone `npm run test:browser` 仍是 observational 诊断。更新 [docs/testing.md](../../../../docs/testing.md)、[tools/workflow.json](../../../../tools/workflow.json)、[AGENTS.md](../../../../AGENTS.md) 与决策记录，明确 only layered 是 delivery gate。

**5. 只向上 ratchet。** 每次 floors 只允许在连续绿运行后上调；下调必须单独 PR、说明原因并经 reviewer 同意。branch/function 的全局门禁仍保持关闭；本提案只对 browser-owned 文件启用 per-file function floor，因为浏览器报告已给出该文件的精确函数覆盖。

## Alternatives considered

**直接把所有 browser TSX 设为 100%。** 否决：panel/list 的 70% 包含大量错误态与布局变体，先补场景再定门槛才能避免用 ignore 或空断言凑数；首版 100 会迫使 reviewer 接受不可达分支的伪测试。

**继续 observational，只靠 code review。** 否决：没有机制阻止 panel/list 从 70% 掉到 50%；reviewer 无法在 diff 里稳定看到覆盖回归。

**用 jsdom 单测替代真实浏览器。** 否决：client 的布局、焦点、滚动和 host 注入依赖真实浏览环境；已有决策要求真实浏览器 lane 作为 owner。

**把 `.ts` 交叉数据也设 floor。** 否决：`model.ts`/`notice-model.ts` 归 unit lane，浏览器报告只是交叉校验；两个 owner 会让失败定位和偿还责任不清。

**先启用全局 branch/function 门禁。** 否决：V8 精确覆盖的 range/function 枚举随执行路径变化，当前没有稳定 branch 语义；先在浏览器 per-file function 上建立可复现的 ratchet。

## Acceptance criteria

- [A1] 连续 3 次 clean headless `test:coverage:layered` 全绿，三次使用同一 Chromium/主机，记录 artifact identity 与 per-file 数值 — `workflow`
- [A2] `tools/coverage-browser-floors.json` 覆盖每个 non-blocked browser-owned 文件；`notice.tsx` 保持 blocked；畸形或部分文件使 layered 失败 — `workflow`
- [A3] 首版 floors 取三次最低值，不高于当前观测；后续只升不降，下调有单独 PR 与 reviewer 同意 — `workflow`
- [A4] panel/list 新增场景断言 DOM/ARIA 和 API 行为，不以截图或 sleep 作为验证 — `tests`
- [A5] `test:coverage:layered` 在低于 floor 的合成用例上变红（负向控制），standalone `test:browser` 仍为 observational — `tests`
- [A6] `docs/testing.md`、`tools/workflow.json`、`AGENTS.md` 明确 layered 是浏览器 blocking gate，`notice.tsx` 的 KI-40 退出条件保留 — `plan-docs`

## Risks

- 首版 floors 可能定得过高，正常 UI 改动频繁触发红。缓解：取三次最低值，先留余量，后续再 ratchet；下调走单独评审。
- 浏览器/宿主版本漂移会让数值波动。缓解：固定 Chromium 与 `dsh` 版本，记录 artifact identity，连续三次同环境；CI 稳定前只在 delivery 运行。
- 补场景时容易写出只验证渲染、不验证行为的测试。缓解：A4 要求 DOM/ARIA 与 API 行为双断言，复用现有场景风格。
- `notice.tsx` 的 blocked 例外可能长期存在。缓解：保留 KI-40 退出条件；blocked 集合由 `CLIENT_BROWSER_BLOCKED` 固定，报告不能自报 blocked。
- floors 文件与 sourcemap 行号绑定，源码大改会移动行号。缓解：floors 只存百分比，不存行号；行号变化由 client report 重新生成。

## Delivery stages

1. 补 panel/list 未覆盖场景，先跑 3 次 clean headless layered 记录数值。
2. 新增 `tools/coverage-browser-floors.json` 与 checker 的 blocking 切换，补负向控制。
3. 更新 docs/workflow/AGENTS 与决策记录，确认 delivery gate 生效。
4. 后续每次上调 floors 单独 PR；KI-40 解除后补 notice 场景并移除 blocked。
