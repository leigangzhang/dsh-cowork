# Proposal: 为 client-browser-coverage 设置 reviewed per-file floors

Status: proposed
Date: 2026-11-15
Class: testing

## Problem

浏览器 lane 已由 [client-browser-coverage 决策](../../implemented/testing/2026-11-13-client-browser-coverage.md) 建立，并由 [layered gate](../../implemented/testing/2026-11-13-layered-100-coverage-gate.md) 接入统一 artifact。`test:coverage:layered` 强制浏览器 lane 运行，校验 sourcemap 完整性、行数一致性与 blocked 集合；因为 `tools/coverage-browser-floors.json` 不存在，`readBrowserFloors` 返回 null，summary 只写 `observational`。checker 侧的 floors 契约已经实现并有负向测试：[coverage-check.mjs](../../../../scripts/evidence/coverage-check.mjs) 校验 `version: 1`、每个 non-blocked browser-owned 文件必须有 floor、值域 0..100、未知 key 与未知文件变红，[coverage-policy.test.mjs](../../../../tests/guards/coverage-policy.test.mjs) 覆盖了每条失败路径。缺的是 floors 数据、blocking 切换和文档。

**2026-11-15 的基线数字是测量缺陷，不是真实覆盖。** [scenarios.mjs](../../../../tests/browser/scenarios.mjs) 在 `scenarioLayoutAndFilter` 里执行 `page.reload()`；Playwright 的 `stopJSCoverage` 取的是 Chromium `Profiler.takePreciseCoverage`，导航后旧 script 不再存活，重载前执行过的代码（菜单开合、归档/恢复、筛选写入）从报告里整段消失。2026-11-19 在 `5d7a9e6` 上用同一组场景、仅去掉那次 reload 实测：`panel.tsx` line 85.61% / function 86.84%，`list.tsx` 93.24% / 81.82%，`inbox.tsx` 95.53% / 86.11%，`index.tsx` 100% / 80%，`contracts.ts` 100% / 100%；带 reload 时报 70.65% / 73.02% 与 70.27% / 50%。直接按 70% 设 floor 会把测量 bug 固化成门槛。

**修正测量后的真实缺口**（2026-11-19 无 reload 运行）：`list.tsx` 空闲/空态 notice 51-57、菜单外点关闭 276-280、菜单 Arrow/Home/End 324-334；`panel.tsx` 会话切换重置 215-217 与 250-254、恢复失败回滚 375-376、筛选二次点击关闭 398-399、无效动作 guard 424-425、打开收件箱目标 463-477、返回主会话 489-500 与面包屑渲染 559-566；`inbox.tsx` 收件箱错误块 106-108、多选提问 435-438、note 打开按钮与回执 644-662。少量行在本 lane 不可达：`panel.tsx` 446 需要能唤醒真实 Session 的 fixture，145 需要拒绝 sessionStorage 的浏览器上下文，故首版 floors 不按 100 取值。

仓库现状：unit lane 已经是 per-file 100 且 `tools/coverage-debt.json` 为空，`dev` lane 没有文件；`.github/workflows` 有 `pr-gate`、`pre-merge`、`gate-artifact`，浏览器 lane 仍只跑本地 heavy lane（[docs/testing.md](../../../../docs/testing.md)），所以 layered 依旧是 delivery gate。[workflow.test.mjs](../../../../tests/guards/workflow.test.mjs) 断言 browser surface 是 `observational`，提升 blocking 必须同时改这条守卫。

## Proposal

**1. 先修测量：跨导航合并覆盖。** 浏览器 lane 在会造成导航的场景前后分两段收集：`startJSCoverage` → 无导航场景 → `stopJSCoverage`（entries A）→ `startJSCoverage` → 含 reload 的场景 → `stopJSCoverage`（entries B），把 A、B 的 entries 一起交给 `clientCoverageFromEntries`（由现有 `clientCoverageFromEntry` 重构，复用同一 sourceByFile，按行/函数取并集）后再出报告。lane 同时记录 `framenavigated` 次数，未登记的导航让本次运行失败，避免以后新增页面跳转时覆盖再次悄悄缩水。改动落在 [client-coverage.mjs](../../../../scripts/evidence/client-coverage.mjs)、[browser-panel.mjs](../../../../scripts/evidence/browser-panel.mjs)、[scenarios.mjs](../../../../tests/browser/scenarios.mjs) 与 [coverage-map.test.mjs](../../../../tests/browser/coverage-map.test.mjs)（新增两段 entries 取并集、以及重载前交互不丢失的负向控制）。

**2. 按真实缺口补场景。** 依次补：list 空态（无 topic 的 overview）、菜单外点关闭与 Arrow/Home/End 焦点移动、恢复失败回滚（reopen 返回 500 后卡片回到 resolved 并留下 failed receipt）、筛选二次点击关闭、持久化的筛选指向已不存在的 topic 时被清除、收件箱读取失败 + 重试、多选提问、proposal note 的“查看提案”成功与失败回执、返回主会话面包屑；每条断言 DOM/ARIA 与对应 API 请求/响应，不做截图-only 断言。复用单一浏览器会话与 fixture 隔离，不以 sleep 当就绪；需要的新 fixture 只加在 [fixtures.mjs](../../../../tests/browser/fixtures.mjs) 的确定性 seed 里。

**3. 三连绿后再定 floors。** 在 clean commit、固定主机与 Chromium 上连续跑 3 次 `npm run test:coverage:layered -- --base origin/main`，记录每次 artifact identity 与 per-file line/function。三次都绿后取每文件三次最低值作为首版 floor；不要求首版 100，`notice.tsx` 保持 blocked、不设 floor。

**4. floors 文件与阻断。** 新增 `tools/coverage-browser-floors.json`（`version: 1`，`files` 覆盖每个 non-blocked browser-owned 文件，仅 `lineCoverage`、`functionCoverage`）。文件合入后 layered 的浏览器部分从 observational 提升为 blocking：低于 floor、缺少 floor、floors 文件畸形都失败；standalone `npm run test:browser` 仍是 observational 诊断。同步更新 [workflow.json](../../../../tools/workflow.json) 的 browser surface、[workflow.test.mjs](../../../../tests/guards/workflow.test.mjs) 的 mode 断言、[docs/testing.md](../../../../docs/testing.md)、[AGENTS.md](../../../../AGENTS.md)。

**5. 只向上 ratchet。** 每次 floors 只允许在连续绿运行后上调；下调必须单独 PR、说明原因并经 reviewer 同意。branch/function 的全局门禁仍保持关闭；本提案只对 browser-owned 文件启用 per-file function floor。

## Alternatives considered

**沿用 2026-11-15 的 70% 数字直接设 floor。** 否决：那些数字包含被 reload 丢掉的覆盖，等于把测量 bug 固化成门槛；补齐场景前设 floor 会奖励“多写场景”，而实际缺口并不在菜单和归档路径上。

**把 reload 场景挪到最前面来避坑。** 否决：损失由最后一次导航决定，换个顺序仍是同一类丢失；页面顺序成为承重点，以后任何场景新增跳转都会让数值静默缩水，且没有检查能发现。

**重载后重跑一遍交互补齐覆盖。** 否决：场景重复执行、运行时间翻倍，而且只覆盖重载前本来就可执行的代码，无法证明重载前路径被覆盖。

**直接把所有 browser TSX 设为 100%。** 否决：panel 的 446 与 145 在当前 lane 不可达，首版 100 会迫使 reviewer 接受伪测试或 ignore。

**继续 observational，只靠 code review。** 否决：没有机制阻止 panel/list 大幅回退；reviewer 无法在 diff 里稳定看到覆盖回归。

**用 jsdom 单测替代真实浏览器。** 否决：client 的布局、焦点、滚动和 host 注入依赖真实浏览环境；已有决策要求真实浏览器 lane 作为 owner。

**先启用全局 branch/function 门禁。** 否决：V8 精确覆盖的 range/function 枚举随执行路径变化，当前没有稳定 branch 语义。

## Acceptance criteria

- [A0] 跨导航合并：两段 entries 的行/函数取并集；重载前-only 的交互在最终报告里仍算覆盖；未登记导航让 lane 失败 — `tests`
- [A1] 连续 3 次 clean headless `test:coverage:layered` 全绿，同一 Chromium/主机，记录 artifact identity 与 per-file 数值 — `workflow`
- [A2] `tools/coverage-browser-floors.json` 覆盖每个 non-blocked browser-owned 文件；`notice.tsx` 保持 blocked；畸形或部分文件使 layered 失败 — `workflow`
- [A3] 首版 floors 取三次最低值，不高于当前观测；后续只升不降，下调有单独 PR 与 reviewer 同意 — `workflow`
- [A4] 新增场景断言 DOM/ARIA 和 API 行为，不以截图或 sleep 作为验证 — `tests`
- [A5] `test:coverage:layered` 在低于 floor 的合成用例上变红（负向控制），standalone `test:browser` 仍为 observational — `tests`
- [A6] `docs/testing.md`、`tools/workflow.json`、`AGENTS.md` 与 `workflow.test.mjs` 明确 layered 是浏览器 blocking gate，`notice.tsx` 的 KI-40 退出条件保留 — `plan-docs`

## Risks

- 测量修正后 per-file 值仍会随浏览器/宿主版本漂移。缓解：固定 Chromium 与 `dsh` 版本，记录 artifact identity，连续三次同环境后取最低值。
- 以后新增页面跳转再次丢失覆盖。缓解：A0 的导航守卫让未登记导航直接失败，而不是静默缩小可测面。
- 首版 floors 定得过高会让正常 UI 改动频繁红。缓解：取三次最低值、不要求 100，先留余量，后续单独 PR ratchet。
- 补场景时写出只验证渲染的测试。缓解：A4 要求 DOM/ARIA 与 API 行为双断言。
- `notice.tsx` 的 blocked 例外可能长期存在。缓解：保留 KI-40 退出条件；blocked 集合由 `CLIENT_BROWSER_BLOCKED` 固定，报告不能自报 blocked。
- floors 只存百分比、不存行号，源码大改不动 floors；但行号变化需要重新生成 client report，靠 layered 的 artifact 身份确认报告对应当前工作树。

## Delivery stages

1. 修测量：两段 entries 合并、导航守卫、单测与负向控制；确认无 reload 运行的数值在带 reload 时保持一致。
2. 补真实缺口场景（list 空态与菜单键盘、恢复失败回滚、筛选边界、收件箱错误与多选、note 打开、返回主会话），跑 3 次 clean headless layered 记录数值。
3. 新增 `tools/coverage-browser-floors.json`，切换 blocking，补负向控制与 workflow 守卫。
4. 更新 docs/workflow/AGENTS 与决策记录，移入 `implemented/`，确认 delivery gate 生效。
5. 后续每次上调 floors 单独 PR；KI-40 解除后补 notice 场景并移除 blocked。
