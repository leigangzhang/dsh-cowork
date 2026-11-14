# Decision: 把测试分层落成可执行门禁

Status: implemented
Date: 2026-11-13
Class: process

## Problem

[docs/testing.md](../../../../docs/testing.md) 曾声明 Unit、Real entry、Replayable expectation、Coverage 四层，但只有 Unit 和仓库约定检查有命令；`tools/workflow.json` 的 `source` surface 只要求 `typecheck` 和 `build`，行为变更可以在不跑测试的情况下落地。Coverage 与 Real entry 仍依赖人工判断。

三个可复现的缺口：

- `tests/packaging.test.mjs` 调 `npm pack` 时继承用户级 `~/.npm` 缓存。本机缓存被 root 所有的旧文件占住时，默认 `npm test` 会红；隔离缓存后 980/980 绿。
- 没有覆盖率门禁。按 Node 22 内置 coverage 实测，排除 dev-only 驱动后 `src/**/*.ts` 约为 line 68%、branch 83%、functions 81%。
- `npm pack --dry-run` 只检查文件清单，没有启动真实安装包。M12 真实链能证明业务闭环，但它是手工 dev route；没有命令能在改完构建或 bundle 补丁后确认产物真的能被宿主装载。

## Decision

**1. 覆盖率由 `npm run test:coverage` 执行。** [scripts/test-coverage.mjs](../../../../scripts/evidence/test-coverage.mjs) 用 Node 内置 coverage 跑 `tests/*.mjs`，include `src/**/*.ts`，排除 dev-only probe/E2E 驱动，并锁定 line 65%、branch 82%、functions 80% 的全局下限。排除名单与阈值都是具名常量；[tests/coverage-policy.test.mjs](../../../../tests/guards/coverage-policy.test.mjs) 固定名单、验证每个排除文件存在，并用一个故意未覆盖的 fixture 证明 100% 函数门槛会红。`src/client/*.tsx` 不进入该命令，它们留给浏览器 lane。

**2. 构建产物有 `npm run test:host-smoke`。** [scripts/host-smoke.mjs](../../../../scripts/evidence/host-smoke.mjs) 对当前 `lib/` 执行 `npm pack`，在临时 `DSH_HOME` 建 profile、安装 tarball、用 `enableDevRoutes: true` 的 `--patch` 启动 `dsh web --port 0 --no-open`，换 token 后断言 `/dsh-cowork/probe/health` 的插件名、版本、repoPath 与 200；并断言未认证的 `/api/cowork.overview` 被 401/403 拒绝。进程、profile、npm cache、tarball 与临时目录都在 `finally` 清理。该命令消费当前 `lib/`，源码变更后先跑 `npm run build`；没有 `dsh` 时默认打印 SKIP，`DSH_HOST_SMOKE_STRICT=1` 让缺失变成失败。它不调用模型，完整 M12 链仍是 observational lane。

**3. packaging 测试自持资源。** [tests/packaging.test.mjs](../../../../tests/guards/packaging.test.mjs) 为 `npm pack --dry-run` 建临时 `npm_config_cache`，设置 60 秒上限，并在 `finally` 删除缓存。默认 `npm test` 不再受用户 npm 缓存状态影响。

**4. 证据映射与文档同步。** [tools/workflow.json](../../../../tools/workflow.json) 的 `source` evidence 现在包含 `test:coverage`、typecheck、build、host smoke；`packaging` 包含 check、typecheck、npm test、build、host smoke，并拥有 `cordis.patch.yml`。`tests` 表面要求 `npm test` 与 `test:coverage`。[AGENTS.md](../../../../AGENTS.md)、[README.md](../../../../README.md)、[docs/testing.md](../../../../docs/testing.md) 与 [docs/PLAN-V0.2.md](../../../../docs/PLAN-V0.2.md) §7 的当前命令入口同步到 testing.md；[tests/workflow.test.mjs](../../../../tests/guards/workflow.test.mjs) 固定脚本、workflow evidence 与 testing guide 的一致性。

## Alternatives considered

**直接使用 c8 或 vitest coverage。** 否决：当前运行器是 `node:test`，Node 22 已内置 coverage；为同一能力引入新依赖不划算。需要 per-file 门槛或 HTML 报告时再评估 c8。

**先包装完整 M12 真模型 E2E。** 否决为本阶段第一刀：它需要模型、较长时间和真实宿主会话；先用无模型的 built-artifact smoke 锁住“产物能装载”，再把 M12 驱动包成 opt-in lane。

**继续只检查 `npm pack --dry-run`。** 否决：文件清单正确不代表 bundle patch、peer 解析、host 注册和认证路由可用。

**把 `.tsx` 塞进 Node coverage。** 否决：Node 测试不渲染 React 组件，计入只会制造虚假的低覆盖数字；浏览器 smoke 才是它的证据。

## Consequences

- `source` 变更现在欠 tests、typecheck、build 与真实装载证据；只跑 `npm test` 不再是完整的源码证据。没有 DSH 主机的环境会明确缺少 host smoke，而不是把它当成绿。
- `test:host-smoke` 证明安装包能装载、dev surface 能注册、认证负面被拒绝；它不证明业务工具、模型、面板或 M12 全链。
- 覆盖率是全局门槛，不是 per-file 100%；一个已经覆盖较多的模块仍可能掩盖低覆盖模块。需要 per-file 门槛时应新增独立检查，不能把全局数字当等价物。
- Node 的 test coverage 仍是 experimental，跨 Node 小版本的百分比可能变化。门槛取观测基线以下；跨版本差异先复核报告，不直接抬阈值。
- `src/client/*.tsx` 与面板交互目前仍靠 `tests/panel-model.test.mjs`、API 测试和人工 Chrome 证据，不在 `test:coverage` 的证明范围。
- M12 真实模型链、浏览器快照与 expected-output replay 仍未成为命令；它们不能被引用为已执行证据。重估触发条件是：增加浏览器 lane、需要 per-file 覆盖率，或把 M12 包装成可重复命令。

## Testing

- [A1] `npm run test:coverage` 在 line 65 / branch 82 / functions 80 下通过；排除名单与阈值被改坏时契约测试变红；100% 函数门槛的负向 fixture 会失败 — `tests`：`tests/coverage-policy.test.mjs`、`npm run test:coverage`
- [A2] 默认 `npm test` 不再读取用户级 npm 缓存；packaging 子进程有独立缓存与 60 秒超时 — `tests`：`tests/packaging.test.mjs`、`npm test`
- [A3] `npm run test:host-smoke` 从当前 `lib/` 打包、装进临时 profile、启动宿主、换取 token 后拿到健康 200，并拒绝未认证的 panel API；结束后无临时 profile/进程 — `packaging`：`npm run test:host-smoke`、`tests/host-smoke.test.mjs`
- [A4] `package.json`、`tools/workflow.json`、`AGENTS.md`、`README.md`、`docs/testing.md` 与 `docs/PLAN-V0.2.md` 的命令和证据一致，`npm run check`/`check:self-test` 通过 — `workflow`：`tests/workflow.test.mjs`、`npm run check`、`npm run check:self-test`
