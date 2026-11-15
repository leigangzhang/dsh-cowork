# Decision: 用真实浏览器覆盖 client TSX 与面板交互

Status: implemented
Date: 2026-11-13
Class: testing

## Problem

`npm run test:coverage` 的 include 是 `src/**/*.ts`，因此五个 React TSX（`src/client/index.tsx`、`panel.tsx`、`list.tsx`、`inbox.tsx`、`notice.tsx`）没有执行覆盖率。2026-11-14 的 `origin/main`（`e95060e`）基线中，`npm run test:coverage` 运行 989/989 通过，全局为 line 69.42% / branch 83.52% / function 84.42%；client 纯逻辑仍偏低：`src/client/model.ts` 50.29%、`src/client/inbox-model.ts` 55.53%、`src/client/api.ts` 68.96%、`src/client/inbox-layout.ts` 35.29%。

现有证据没有补上这段执行面：

- `tests/client/panel-model.test.mjs`、`inbox-model.test.mjs`、`notice-model.test.mjs` 主要加载纯模型并匹配源码片段；`tests/panel/*.test.mjs` 在进程内调用路由 handler。两者都不渲染 React。
- `src/dev/m12-e2e*` 与 `src/dev/panel-probe.ts` 让 M12 驱动在宿主进程内调用生产 panel handler，绕过真实 HTTP 传输和 DOM。
- `npm run test:host-smoke` 会从当前 `lib/` 打包并在临时 `DSH_HOME` 启动真实宿主，但只检查 health 与未认证 API 被拒绝，不打开浏览器。

因此，侧栏注入、面板宽窄布局、菜单焦点、键盘操作、滚动容器、宿主会话切换和 ARIA 回归仍只能靠人工 Chrome。`tools/workflow.json` 也没有匹配 `src/client/**/*.tsx` 的 surface；[KI-50](../../../../docs/KNOWN_ISSUES.md) 记录了这个缺口。另一个边界是 `src/client/notice.tsx`：它只在宿主提供 `ctx.sessionNotices` 时注册，而当前 DSH 0.2.1-rc.2 不提供该服务（[KI-40](../../../../docs/KNOWN_ISSUES.md)），所以不能假装真实宿主已经执行它。

## Decision

**1. 隔离的真实浏览器 lane 从构建产物启动。** `npm run test:browser` 运行 [browser-panel.mjs](../../../../scripts/evidence/browser-panel.mjs)。它要求当前 `lib/` 存在，从已安装的 tarball 启动临时 DSH web profile，在临时 `DSH_HOME`、临时 workspace/session、临时 fixture 仓库和随机端口上工作；认证 cookie 只留在内存，浏览器、host、profile、cache、fixture 目录都在 `finally` 清理。共享的拉取、认证、profile patch 和关停逻辑在 [dsh-host-session.mjs](../../../../scripts/evidence/dsh-host-session.mjs)，`host-smoke` 与浏览器 lane 使用同一份实现。

**2. 覆盖率来自宿主组合后的真实 bundle。** 浏览器覆盖映射的入口是 [client-coverage.mjs](../../../../scripts/evidence/client-coverage.mjs)：它读取 Playwright 的 JSCoverage `source` 与函数区间，用宿主返回的 combo indexed source map（由已安装包的 `lib/client.js.map` section 组成）和 Node 内置 `module.SourceMap.findOrigin` 映射回 `src/client/**`。`coverage/client.json` 记录 per-file line/function、未覆盖行、插件版本、HEAD、`lib/client.js` 与 `lib/client.js.map` 的 SHA-256，以及实际使用的 combo map URL。

`src/client/**/*.ts` 仍由 Node `test:coverage` 负责；浏览器 lane 首版只报告可达 TSX 的 per-file line/function，并先断言预期 TSX 集存在；连续三次 green 后再设 per-file 门槛。`.ts` 数据作为交叉信号报告，不伪造 branch。`src/client/notice.tsx` 必须以 `blocked` 状态存在于报告，并从计数和门槛中跳过；宿主提供 `ctx.sessionNotices`（KI-40 退休）后必须重新纳入。

**3. 场景按用户结果组织。** [scenarios.mjs](../../../../tests/browser/scenarios.mjs) 覆盖：底栏入口与默认面板、四组主题、resolved 折叠、菜单键盘焦点与 Escape 回位、真实归档/恢复 POST、失败回滚、宽/窄宿主布局、`sessionStorage` 主题筛选跨重载恢复、四类收件箱请求的八个动作、问题分页与 submit gate、计划内联修改、prompt warning、写入失败 receipt、overview 错误重试，以及从 workspace 动作创建并切换到第二个真实宿主会话后读取其独立 fixture 和筛选。断言使用 DOM/ARIA、可见文案和 HTTP 请求；截图只在失败时保留，不替代断言。

**4. 依赖和证据面。** `playwright@1.65.1` 固定在 `devDependencies`，仓库提交首个 `package-lock.json`；Chromium 由 `npx playwright install chromium` 安装。`tools/workflow.json` 新增 `browser` surface，匹配 `src/client/**/*.tsx`、`tests/browser/**` 和浏览器脚本，状态为 `observational`，证据命令为 `npm run test:browser`。缺少 `dsh` 或 Chromium 时本地打印具名 `SKIP`；`DSH_BROWSER_STRICT=1` 使缺失变成失败。仓库仍没有 CI 配置，本记录不声称存在 CI lane。

## Alternatives considered

**只用 jsdom + React Testing Library。** 否决：它能执行事件处理，但不能证明宿主侧栏注入、真实 CSS 布局、滚动容器、焦点环和浏览器行为；这些正是当前人工截图承担的集成风险。

**把 TSX 直接塞进 Node coverage。** 否决：Node 进程不渲染组件，`.tsx` 只会得到 bundle 静态加载或 0% 的假数字；执行区间必须来自浏览器。

**扩展现有 M12 进程内 panel probe。** 否决：`src/dev/panel-probe.ts` 有意绕过 host HTTP transport，只调用生产 handler；它不能证明真实面板注入、HTTP 认证、DOM、布局或焦点。

**继续用 BrowserSkill/人工 Chrome 截图。** 否决：它依赖用户已登录的浏览器和本机状态，不能在新机器或 CI 复现；截图也不能稳定定位未执行的组件行。人工截图仍适合设计审查，但不承担回归门禁。

**复用用户打开的 Chrome 和真实 profile。** 否决：不可重复、会污染用户数据，cookie 和会话状态也不可审计；lane 必须自己创建临时 profile、fixture 和 Chromium 上下文。

**直接使用 `lib/client.js.map` 映射安装后的 script。** 否决：宿主会把多个插件的 client 组合成一个 `/plugins/??…` script，单独的 `lib/client.js.map` 只描述单个文件的行号。实际实现使用同一宿主返回的 combo indexed map，并把本地 map 的 hash 保留为 artifact identity。

## Consequences

- 真实面板现在有可重复证据：`npm run test:browser` 会启动打包后的宿主、打开真实右侧栏并驱动 DOM/HTTP。当前报告的 line/function 基线来自一次实际运行；在连续三次 green 前只报告，不把百分比当产品指标。
- 浏览器 lane 引入首个 lockfile 和 Chromium 下载，运行时间明显高于 Node 测试。没有 `dsh` 或浏览器时，本地 skip 可能被误读成通过；发布或 CI 证据必须设置 `DSH_BROWSER_STRICT=1`。
- 覆盖报告只覆盖当前安装的 combo 和可达交互。`notice.tsx` 仍由 KI-40 阻塞；`model.ts`、`inbox-model.ts` 等 `.ts` 的偏低数字继续由 Node 覆盖负责，浏览器数据不是第二套 owner。
- 选择器依赖宿主侧栏和首用对话框。测试通过稳定的 test id、role 和文案定位，不修改宿主 DOM；宿主升级导致失败时先修 lane 并记录宿主版本。
- 失败证据写到 gitignored 的 `.dsh-cowork/browser/<runId>/`，包含截图、页面 HTML、console、网络摘要和失败 JSON；默认不保留成功产物。`coverage/client.json` 是 gitignored 的报告，不是提交物。
- 仓库没有 CI，因此当前状态是本地 observational。三次连续 green 后，才为稳定 TSX 设 per-file line/function 门槛并提升为 blocking。

## Testing

- [A1] `npm run test:browser` 从当前 `lib/` 打入临时 `DSH_HOME`，启动 host、完成认证、用一个 Chromium context 打开面板，并在成功/失败路径清理子进程、profile 和 fixture — `packaging`
- [A2] combo source map 能映射到 `src/client/**/*.tsx` 并写出 `coverage/client.json`；报告缺少预期 TSX、出现重复条目、或 `notice.tsx` 未以 blocked 原因存在时 lane 失败；`tests/browser/coverage-map.test.mjs` 的合成未执行行和缺失 source 会失败 — `tests`
- [A3] `tests/browser/scenarios.mjs` 覆盖四组主题、归档/恢复、宽窄布局、四类请求与八个动作、错误回滚、键盘焦点、overview 重试和新宿主会话切换；断言包含 DOM/ARIA 与真实 HTTP 请求 — `tests`
- [A4] `playwright@1.65.1`、`package-lock.json`、`npm run test:browser`、`browser` surface、observational 状态和 strict skip 规则由 [workflow.json](../../../../tools/workflow.json) 与 [testing.md](../../../../docs/testing.md) 固定；`npm run test:host-smoke` 继续通过 — `workflow`
