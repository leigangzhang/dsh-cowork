# Decision: 为 client-browser-coverage 设置 reviewed per-file floors

Status: implemented
Date: 2026-11-15
Class: testing

## Problem

浏览器 lane 已由 [client-browser-coverage 决策](2026-11-13-client-browser-coverage.md) 建立，并由 [layered gate](2026-11-13-layered-100-coverage-gate.md) 接入统一 artifact。`test:coverage:layered` 强制浏览器 lane 运行，校验 sourcemap 完整性、行数一致性与 blocked 集合；但 `tools/coverage-browser-floors.json` 不存在时 `readBrowserFloors` 返回 null、summary 只写 `observational`，panel/list 的大幅回退不会让门禁变红。checker 侧的 floors 契约（`version: 1`、每个 non-blocked browser-owned 文件必须有 floor、0..100 值域、未知 key/未知文件变红）早已实现并有负向测试。

测量本身还有缺陷。[scenarios.mjs](../../../../tests/browser/scenarios.mjs) 在 filter persistence 场景里执行 `page.reload()`；Playwright 的 `stopJSCoverage` 取的是 Chromium `Profiler.takePreciseCoverage`，导航后旧 script 不再存活，重载前执行过的代码（菜单开合、归档/恢复、筛选写入）整段消失。2026-11-19 在 `5d7a9e6` 上实测：带 reload 时 `panel.tsx` 70.65% / 73.02%、`list.tsx` 70.27% / 50%，同一组场景去掉 reload 后是 85.61% / 86.84% 与 93.24% / 81.82%。直接按旧数字设 floor 会把测量 bug 固化成门槛。

修正测量后的真实缺口是具体而有限的：list 空态、菜单外点与键盘导航；panel 恢复失败回滚、筛选二次点击、收件箱错误、note 打开、返回 master、卡片打开；inbox 多选提问。少量行在本 lane 不可达：`panel.tsx` 446 需要能唤醒真实 Session 的 fixture，145 需要拒绝 sessionStorage 的浏览器上下文，424-425 是 UI 不渲染的防御分支。

## Decision

**1. 跨导航合并覆盖。** [client-coverage.mjs](../../../../scripts/evidence/client-coverage.mjs) 的 `clientCoverageFromEntries` 把多段 Playwright entries 映射进同一份 per-source 集合，行与函数取并集；[browser-panel.mjs](../../../../scripts/evidence/browser-panel.mjs) 在含 reload 的场景前后分两段 `startJSCoverage`/`stopJSCoverage` 并合并结果，只用插件 bundle 的 entries 做映射。lane 记录 `framenavigated` 次数：第一段必须为 0，第二段必须恰好 1 次 reload，未登记的导航直接让运行失败，避免以后新增页面跳转时覆盖再次悄悄缩水。

**2. 按真实缺口补场景。** [scenarios.mjs](../../../../tests/browser/scenarios.mjs) 新增 list 空态（空 workspace 新建会话）、菜单外点关闭与 Arrow/Home/End 焦点、恢复失败回滚、筛选二次点击与 inbox 清除按钮、持久化筛选重载恢复、收件箱读取失败与重试、多选提问、proposal note 打开成功/失败、返回 master 面包屑、卡片打开。每条断言 DOM/ARIA 与对应 API 请求/响应，不以截图或 sleep 当就绪；需要的新 fixture 加在 [fixtures.mjs](../../../../tests/browser/fixtures.mjs) 的确定性 seed 里。proposal note 的 reveal 在 lane 内被 stub，避免每次运行弹出用户的文件浏览器；host route 自身由 `tests/panel` 覆盖。

**3. floors 取三次最低值。** 在 clean `d684167`、`dsh 0.2.1-rc.2`、同一 Chromium 上连续跑 3 次 `npm run test:coverage:layered -- --base origin/main`，全部绿且 per-file 数值完全一致（artifact diff `d5a6c930`）。[coverage-browser-floors.json](../../../../tools/coverage-browser-floors.json) 取三次最低值：`contracts.ts` 100/100、`inbox.tsx` 100/91.67、`index.tsx` 100/80、`list.tsx` 100/90.91、`panel.tsx` 95.89/97.37；`notice.tsx` 保持 blocked（KI-40），不设 floor。

**4. 提升为阻断。** floors 文件合入后，layered 的浏览器部分从 observational 提升为 blocking：低于 floor、缺少 floor、floors 文件畸形都失败；standalone `npm run test:browser` 仍是 observational 诊断。[workflow.json](../../../../tools/workflow.json) 的 browser surface 改为 `blocking` 并要求 layered 证据，[workflow.test.mjs](../../../../tests/guards/workflow.test.mjs) 断言该状态与 floors 文件存在，[coverage-policy.test.mjs](../../../../tests/guards/coverage-policy.test.mjs) 校验真实 floors 文件覆盖每个 non-blocked browser-owned 文件。

**5. 只向上 ratchet。** 每次 floors 只允许在连续绿运行后上调；下调必须单独 PR、说明原因并经 reviewer 同意。branch/function 的全局门禁仍保持关闭；本决策只对 browser-owned 文件启用 per-file function floor。

## Alternatives considered

**沿用 2026-11-15 的 70% 数字直接设 floor。** 否决：那些数字包含被 reload 丢掉的覆盖，等于把测量 bug 固化成门槛；实际缺口并不在菜单和归档路径上。

**把 reload 场景挪到最前面来避坑。** 否决：损失由最后一次导航决定，换个顺序仍是同一类丢失；页面顺序成为承重点，以后任何场景新增跳转都会让数值静默缩水，且没有检查能发现。

**重载后重跑一遍交互补齐覆盖。** 否决：场景重复执行、运行时间翻倍，而且只覆盖重载前本来就可执行的代码，无法证明重载前路径被覆盖。

**直接把所有 browser TSX 设为 100%。** 否决：panel 的 446 与 145 在当前 lane 不可达，首版 100 会迫使 reviewer 接受伪测试或 ignore。

**继续 observational，只靠 code review。** 否决：没有机制阻止 panel/list 大幅回退；reviewer 无法在 diff 里稳定看到覆盖回归。

**用 jsdom 单测替代真实浏览器。** 否决：client 的布局、焦点、滚动和 host 注入依赖真实浏览环境；已有决策要求真实浏览器 lane 作为 owner。

**先启用全局 branch/function 门禁。** 否决：V8 精确覆盖的 range/function 枚举随执行路径变化，当前没有稳定 branch 语义。

## Consequences

- 浏览器 lane 的 per-file line/function 现在阻断 delivery：任何文件低于 floor 都会让 `test:coverage:layered` 变红；standalone 运行只作诊断，不承担 delivery verdict。
- 覆盖现在对导航免疫：两段 entries 取并集，未登记的导航让 lane 失败而不是静默缩小可测面。多段收集让每次运行多一次 `startJSCoverage`，运行时间影响可忽略。
- 首版 floors 取三次最低值，正常 UI 改动若新增未覆盖代码会触发红；上调 floors 走单独 PR，下调需 reviewer 同意。sourcemap 行号随源码移动，但 floors 只存百分比。
- Chromium/宿主版本漂移可能改变函数枚举；固定 `dsh 0.2.1-rc.2` 与仓库锁定的 Playwright 1.65.1，靠三次同环境运行确认稳定后再取最低值。
- `notice.tsx` 继续由 KI-40 阻塞；blocked 集合由 `CLIENT_BROWSER_BLOCKED` 固定，报告不能自报 blocked。
- 浏览器 lane 仍只跑本地 heavy lane；CI 接入留在 [KI-50](../../../../docs/KNOWN_ISSUES.md)，在此之前 layered 是本地 delivery gate。

## Testing

- [A0] 两段 entries 的行/函数取并集；重载前-only 的交互在最终报告里仍算覆盖；未登记导航让 lane 失败 — `tests`（`coverage-map.test.mjs` 的 phase union 用例含单段负向控制；`browser-panel.mjs` 的 `navigationPhaseGuard`）
- [A1] 连续 3 次 clean headless `test:coverage:layered -- --base origin/main` 全绿且 per-file 数值一致 — `workflow`（2026-11-19，HEAD `d684167`，diff `d5a6c930`）
- [A2] floors 文件覆盖每个 non-blocked browser-owned 文件；`notice.tsx` 保持 blocked；畸形或部分文件使 layered 失败 — `workflow`（`coverage-policy.test.mjs` 的真实 floors 校验与合成负向用例）
- [A3] 首版 floors 取三次最低值；后续只升不降 — `workflow`（`tools/coverage-browser-floors.json`）
- [A4] 新增场景断言 DOM/ARIA 与 API 行为，不以截图或 sleep 作为验证 — `tests`（`tests/browser/scenarios.mjs`）
- [A5] layered 在低于 floor 的合成用例上变红，standalone `test:browser` 仍为 observational — `tests`（`coverage-policy.test.mjs` 的 `line 99% < 100%` 用例）
- [A6] `docs/testing.md`、`tools/workflow.json`、`AGENTS.md` 与 `workflow.test.mjs` 明确 layered 是浏览器 blocking gate，KI-40 退出条件保留 — `plan-docs`
