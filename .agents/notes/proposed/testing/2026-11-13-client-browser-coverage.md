# Proposal: 用真实浏览器覆盖 client TSX 与面板交互

Status: proposed
Date: 2026-11-13
Class: testing

## Problem

`npm run test:coverage` 的 include 是 `src/**/*.ts`，因此五个 React TSX（`src/client/index.tsx`、`panel.tsx`、`list.tsx`、`inbox.tsx`、`notice.tsx`）没有任何执行覆盖率。2026-11-14 的 `origin/main`（`e95060e`）基线中，同一次 `npm run test:coverage` 运行 989/989 通过，全局为 line 69.42% / branch 83.52% / function 84.42%；client 纯逻辑仍偏低：`src/client/model.ts` 50.29%、`src/client/inbox-model.ts` 55.53%、`src/client/api.ts` 68.96%、`src/client/inbox-layout.ts` 35.29%。

现有证据没有补上这段执行面：

- `tests/client/panel-model.test.mjs`、`inbox-model.test.mjs`、`notice-model.test.mjs` 主要加载纯模型并匹配源码片段；`tests/panel/*.test.mjs` 在进程内调用路由 handler。两者都不渲染 React。
- `src/dev/m12-e2e*` 与 `src/dev/panel-probe.ts` 让 M12 驱动在宿主进程内调用生产 panel handler，绕过真实 HTTP 传输和 DOM。
- `npm run test:host-smoke` 会从当前 `lib/` 打包并在临时 `DSH_HOME` 启动真实宿主，但只检查 health 与未认证 API 被拒绝，不打开浏览器。

因此，侧栏注入、面板宽窄布局、菜单焦点、键盘操作、滚动容器、宿主会话切换和 ARIA 回归仍只能靠人工 Chrome。`tools/workflow.json` 也没有匹配 `src/client/**/*.tsx` 的 surface；[KI-50](../../../../docs/KNOWN_ISSUES.md) 记录了这个缺口。另一个边界是 `src/client/notice.tsx`：它只在宿主提供 `ctx.sessionNotices` 时注册，而当前 DSH 0.2.1-rc.2 不提供该服务（[KI-40](../../../../docs/KNOWN_ISSUES.md)），所以不能假装真实宿主已经执行它。

## Proposal

**1. 一个隔离的、从构建产物启动的真实浏览器 lane。** 新增 `npm run test:browser`。它要求先执行 `npm run build`，从当前 `lib/`（gitignored 的构建产物，不是已提交文件）打包，装入临时 `DSH_HOME` 的 web profile，用随机端口启动 `dsh web --no-open`，通过启动输出的一次性 URL 完成认证；cookie 只留在内存，不写日志。浏览器、fixture 仓库、profile、npm cache 和宿主进程都在 `finally` 清理。

把 `scripts/evidence/host-smoke.mjs` 中已经验证过的 profile patch、ready URL 解析、认证和关停逻辑抽到 `scripts/evidence/dsh-host-session.mjs`，由 host-smoke 与新的 `scripts/evidence/browser-panel.mjs` 共用。场景文件放在 `tests/browser/*.test.mjs`，fixture 放在 `tests/browser/fixtures.mjs`：在 `os.tmpdir()` 建临时仓库，用生产 schema validator、store 与 request service 写入四组主题、四类请求和通知账本，并把 fixture 的 `masterSessionId` 绑定到浏览器里真实存在的宿主会话。绝不读写真实 profile 或用户项目的 `.dsh-cowork`。

**2. TSX 覆盖率来自真实 bundle sourcemap。** 浏览器 lane 在打开面板前启动 Playwright 的 Chromium JS coverage，关闭页面前取回执行区间；用 `lib/client.js.map` 把 `lib/client.js` 的生成位置映射回 `src/client/**`。映射使用 Node 22 内置的 `module.SourceMap.findOrigin`，不新增 sourcemap 依赖。新增 `coverage/client.json`，记录 per-file line/function、原始区间摘要、插件 HEAD、`lib/client.js` 与 `.map` 的 SHA-256。

覆盖 ownership 保持单一：`src/client/**/*.ts` 仍由 Node `test:coverage` 负责；浏览器 lane 只对可执行的 `src/client/**/*.tsx` 设门槛，并把 `.ts` 的浏览器执行数据作为交叉信号报告。第一版不伪造 branch 指标：precise coverage 先提供 line/function，只有映射精度和基线稳定后才讨论更细的门槛。`src/client/notice.tsx` 明确列为“宿主能力阻塞”而不是 0% 覆盖；当 KI-40 解除、宿主提供 `sessionNotices` 后再纳入。

负向控制放在 host-free 的映射测试里：用一份合成的 bundle/sourcemap 证明映射后的未执行行会让报告和门槛变红。真实 lane 的负向证据则来自一个故意不触发的 fixture 分支，不能只检查“报告文件存在”。

**3. 场景按用户结果分组，断言 DOM/ARIA、请求和控制台错误。** 首批至少覆盖：

- 底栏入口打开 Cowork tab、默认页与标题注入、overview 成功和失败重试。
- 宿主自己的宽栏/窄栏切换：宽栏两列、窄栏 banner 与面板内收件箱全宽模式；主题筛选写入 `sessionStorage`，跨尺寸变化和页面重载仍恢复。
- 四组主题的固定顺序与计数；resolved 组默认折叠；菜单打开后焦点落在菜单项，ArrowUp/ArrowDown/Home/End 移动，Escape 关闭并把焦点还给 `⋯`，Tab 关闭菜单，Enter 执行归档；归档/恢复走真实 POST，失败时回滚卡片并显示 receipt。
- 四类收件箱请求（`user-review` / `authorization` / `question` / `plan`）和八个动作（`return` / `pass` / `deny` / `allow` / `skip` / `submit` / `revise` / `approve`），包括问题的分页与“全部回答后才可 submit”、计划的内联修改框、已解决行、prompt 失败 warning 和写入失败 receipt；断言 POST 的 `sessionId`、`requestId`、`action` 与评论/答案载荷。
- 宿主会话切换后取消旧请求、清空旧列表并从新会话恢复筛选。
- 每个场景捕获 `pageerror`；未捕获错误使场景失败。截图、DOM snapshot、console 和网络摘要只在失败时写入 gitignored 的 `.dsh-cowork/browser/<runId>/`，默认不保留，且不写 cookie、token 或真实用户路径。

选择器优先使用现有的 `data-testid`、role、可见文案和 `data-*`；只在缺少稳定锚点时补一个 `data-testid="cw-panel"`，不改现有 GUI 验证依赖的名字。所有等待都用 `waitForSelector`、`waitForResponse` 或带 deadline 的状态轮询，不用固定 sleep。

**4. 依赖、工作流和阻塞级别。** 使用 `playwright@1.65.1`（2026-11-14 registry 核实：Apache-2.0，Node >=20），在 `devDependencies` 中固定精确版本，并提交仓库首个 `package-lock.json`。Chromium 由 `npx playwright install chromium` 安装到 lane 自己的缓存，不依赖用户已开的 Chrome。缺少 `dsh` 或 Chromium 时本地打印具名 `SKIP`；`DSH_BROWSER_STRICT=1` 时直接失败，发布或 CI 证据必须使用 strict。

在 `tools/workflow.json` 增加 `browser` surface，匹配 `src/client/**/*.tsx`、`tests/browser/**`、`scripts/evidence/browser-panel.mjs` 和 `scripts/evidence/dsh-host-session.mjs`，证据命令为 `npm run test:browser`，初始标记 `[observational]`；同步更新 [docs/testing.md](../../../../docs/testing.md)。仓库当前没有 CI 配置，本提案不声称已接入 CI；如果之后建立 CI，job 必须设置 `DSH_BROWSER_STRICT=1`。连续三次本地 green 后，给稳定的可达 TSX 设 per-file line/function 门槛并提升为 blocking；届时再按分层覆盖率提案消费这份报告。

## Alternatives considered

**只用 jsdom + React Testing Library。** 否决：它能执行事件处理，但不能证明宿主侧栏注入、真实 CSS 布局、滚动容器、焦点环和浏览器行为；这些正是当前人工截图承担的集成风险。

**把 TSX 直接塞进 Node coverage。** 否决：Node 进程不渲染组件，`.tsx` 只会得到 bundle 静态加载或 0% 的假数字；执行区间必须来自浏览器。

**扩展现有 M12 进程内 panel probe。** 否决：`src/dev/panel-probe.ts` 有意绕过 host HTTP transport，只调用生产 handler；它不能证明真实面板注入、HTTP 认证、DOM、布局或焦点，继续扩展会制造“请求通过但界面坏了”的假信心。

**继续用 BrowserSkill/人工 Chrome 截图。** 否决：它依赖用户已登录的浏览器和本机状态，不能在新机器或 CI 复现；截图也不能稳定定位未执行的组件行。人工截图仍适合设计审查，但不承担回归门禁。

**维持 KI-50，不做浏览器 lane。** 否决：这等于继续让面板 TSX 和交互在覆盖率外，且每次回归都靠人工复现；[2026-11-14 fallow 决策](../../implemented/process/2026-11-14-fallow-code-health.md)已经把浏览器 lane 留给 V0.3，本提案就是对该后续项的落地方案。

**复用用户打开的 Chrome 和真实 profile。** 否决：不可重复、会污染用户数据，cookie 和会话状态也不可审计；lane 必须自己创建临时 profile、fixture 和 Chromium 上下文。

## Acceptance criteria

- [A1] `npm run test:browser` 能先要求当前 `lib/`，在临时 `DSH_HOME` 安装 tarball、启动真实宿主、完成认证、用同一个 Chromium context 打开 Cowork 面板，并在成功/失败路径都清理子进程、fixture 和临时目录 — `packaging`
- [A2] 浏览器执行区间能经 `lib/client.js.map` 映射为 `src/client/**/*.tsx` 的 per-file line/function 报告；合成负向控制证明未执行行会让报告或门槛变红；`notice.tsx` 以宿主能力原因显式排除并保留重估条件 — `tests`
- [A3] 场景覆盖面板注入、四组主题与归档/恢复、宽窄布局、四类请求与八个动作、错误回滚、键盘与焦点、宿主会话切换；断言 DOM/ARIA、可见文案和真实 HTTP 请求，截图不能替代断言 — `tests`
- [A4] `playwright@1.65.1` 与 `package-lock.json` 固定，`npm run test:browser`、`browser` surface、`[observational]` 状态和 strict skip 规则写入 `package.json`、`tools/workflow.json`、`docs/testing.md`；`npm run test:host-smoke` 继续通过 — `workflow`

## Risks

- Playwright 会增加一个浏览器下载和仓库首个 lockfile。若 CI 或本机无法稳定提供 Chromium，lane 会退化为只能手工运行；此时应重新评估 driver，而不是把它伪装成 green。
- JSX sourcemap 可能把多个组件映射到同一生成行。先只承诺 line/function，并用合成负向控制验证映射；per-file 门槛必须基于三次稳定报告，不把一次百分比当产品指标。
- 选择器依赖宿主侧栏 DOM。优先使用现有 test id、role 和可见文案，不修改宿主 DOM 来制造通过；宿主升级导致选择器失效时，先修 lane 并记录宿主版本。
- fixture 需要把 v2 数据绑定到真实宿主会话 id，启动和认证路径较长。共享 host-session helper 缩小差异；认证失败或会话不存在必须明确失败，不能回退到伪造 session。
- `notice.tsx` 当前不可达，排除它会留下未验证的适配器。KI-40 解除时必须重新纳入，否则 exclusion 会变成永久盲区。
- 仓库没有 CI，observational 的本地 green 可能被误读为发布保证。strict 模式必须出现在任何发布证据里；缺少浏览器时的 `SKIP` 不是通过。
- 浏览器 lane 比 Node 测试慢。同一形状连续失败两次就停下补 fast test 或修 fixture，不靠重试或更长超时掩盖。

## Delivery stages

1. 抽出共享 host-session helper，建立 `npm run test:browser` 骨架：构建产物、临时宿主、认证、面板注入与 overview，验证成功/失败清理。
2. 建立 fixture 与交互场景：四组主题、四类请求、错误回滚、键盘焦点、宽窄布局和会话切换。
3. 接入 bundle sourcemap coverage、per-file 报告和合成负向控制；记录可达 TSX 的第一版基线，明确 `notice.tsx` 的阻塞排除。
4. 提交 Playwright、lockfile、`browser` workflow surface 与 docs/testing 更新；连续三次 observational green 后设置稳定 TSX 门槛并提升为 blocking。
