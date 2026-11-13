# Proposal: 用真实浏览器覆盖 client TSX 与面板交互

Status: proposed
Date: 2026-11-13
Class: testing

## Problem

当前 `npm run test:coverage` 只统计 `src/**/*.ts`。五个 `src/client/*.tsx` 组件和面板交互没有进入覆盖率，也没有可重复的浏览器测试；面板行为主要靠 `tests/panel-model.test.mjs`、API 测试和人工 Chrome 截图。

这留下三个盲区：

- 纯 client 模型已经偏低：本轮报告里 `src/client/model.ts` 50.48%、`src/client/inbox-model.ts` 55.80%、`src/client/api.ts` 68.96%；组件渲染与事件处理则完全没有数字。
- 只有真实浏览器能验证侧栏注入、宽窄布局切换、键盘操作、焦点管理、滚动容器和宿主会话切换；jsdom 或纯模型测试不能证明这些。
- 人工截图不是可重复门禁，不能阻止一次面板回归在“模型测试全绿”时落地。

## Proposal

**1. 建立隔离的真实浏览器 lane。** 新增 `npm run test:browser`，从已提交的 `lib/` 做 tarball，装进临时 `DSH_HOME` 的 web profile，启动 `dsh web --port 0 --no-open`，换 token 后复用同一个 Chromium 上下文。fixture 使用临时项目仓库与 `.dsh-cowork/` 数据，不读写真实 profile 或用户项目。先修宿主健康与 overview API，再驱动面板；不使用固定 sleep。

**2. 浏览器覆盖走 bundle sourcemap。** 用 Chromium DevTools Protocol 的 precise coverage 收集 `lib/client.js` 的执行区间，再按 `lib/client.js.map` 映射回 `src/client/*.tsx` 与 `src/client/*.ts`。新增 `npm run test:coverage:client`，只统计 client 源文件，排除 React、宿主模块和第三方 bundle；host coverage 继续由现有 `test:coverage` 负责。第一版先报告，锁定基线后对稳定的纯 model 文件和已完成交互的组件设置 per-file 门槛，再逐轮提高。

**3. 交互场景按用户结果分组。** 首批至少覆盖：面板注入与默认 tab、宽栏两列/窄栏单列、四组主题排序与归档/恢复菜单、请求收件箱四类筛选与四种动作、错误提示、键盘 Tab/Enter/Escape 与焦点回位。每个场景断言 DOM/ARIA、可见文案、API 请求（成功与失败）和浏览器控制台无未捕获错误；截图只作为附加证据，不作为唯一断言。

**4. 依赖和 CI 形态。** 浏览器 lane 使用固定版本的 Playwright 和项目锁文件；Chromium 由 lane 管理，不依赖用户已开的浏览器。测试失败时保留 DOM snapshot、console、网络摘要和截图到临时证据目录。CI 中先作为 `[observational]` 运行，连续三次绿后再与 `test:coverage` 一起成为阻塞 lane。

## Alternatives considered

**只用 jsdom + React Testing Library。** 否决：它能测事件处理，但不能证明宿主侧栏注入、真实布局、滚动容器、焦点和浏览器 CSS；会把面板最关键的集成风险留给人工截图。

**把 `.tsx` 直接塞进 Node coverage。** 否决：Node 测试不渲染组件，得到的只是 bundle 静态加载或 0% 的假数字，不能证明交互。浏览器执行区间才是 client 组件的真实覆盖。

**只截几张页面图。** 否决：截图能发现视觉破损，但不能证明筛选、动作、错误回滚、键盘可达或请求参数；图片也不能稳定定位到未覆盖分支。

**复用用户打开的 Chrome 和真实 profile。** 否决：不可重复、会污染用户数据，且无法在 CI 或新机器上复现。必须由测试自己创建临时 profile 和 fixture。

## Acceptance criteria

- [A1] `npm run test:browser` 能从 tarball 安装、启动临时宿主、用同一 Chromium 会话打开面板并在失败/成功路径都清理资源 — `tests`
- [A2] 浏览器覆盖能从 `lib/client.js.map` 映射到 `src/client/*.tsx` 与 `src/client/*.ts`，并证明一个故意未执行的组件分支会让门槛变红 — `tests`
- [A3] 面板场景覆盖宽/窄布局、四组排序、四类收件箱请求、归档/恢复、错误提示和键盘操作；断言使用 DOM/ARIA 与真实请求，不以截图代替 — `tests`
- [A4] Playwright 版本与 lockfile 固定，`test:browser` 的阻塞级别、命令和资源清理写入 `tools/workflow.json` 与 `docs/testing.md` — `workflow`

## Risks

- 浏览器覆盖是 Chromium/V8 的实现细节，跨 Playwright 或 Chromium 版本可能有区间差异；门槛应基于稳定基线，不把一次百分比当产品指标。
- JSX sourcemap 可能把多个组件映射到同一 bundle 区间；需要先验证 sourcemap 精度，再决定 per-file 门槛。
- 面板选择器依赖宿主 UI；优先使用 `data-*`、role 和可见文案，避免 CSS Modules 哈希。
- 浏览器 lane 比 Node 测试慢，且需要 Chromium；在 CI 上应先 observational，不能因为本地缺浏览器而伪绿。

## Delivery stages

1. 真实宿主 + 临时 fixture 的浏览器启动/清理骨架，先只断言面板注入与 overview。
2. 接入 client sourcemap coverage，输出 per-file 报告并锁定第一版基线。
3. 补齐交互、错误、键盘和窄宽布局场景，接入 observational CI。
4. 连续三次绿后提升为阻塞，并把稳定模块的门槛提高到目标值。
