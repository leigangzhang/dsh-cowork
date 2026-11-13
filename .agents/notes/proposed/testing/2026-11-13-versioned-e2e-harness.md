# Proposal: 版本化、可移植、覆盖更全的 E2E 机制

Status: proposed
Date: 2026-11-13
Class: testing

## Problem

当前 E2E 的真实运行材料分成两半：

- `src/m12-e2e.ts` 与 `src/m12-e2e-support.ts` 在 git 里，但它们通过 `enableDevRoutes` 的 dev route 启动，17 步场景绑定 0.2.0 的 topic/work-item/review/merge 流程；M2/M3 驱动已经过期，M12 的部分步骤也已被后续 inbox、notice、authorization、panel v2 改动越过。
- `.dsh-cowork/e2e/` 里有 fixture、组装脚本、安装补丁、截图和证据（例如 `m11/assemble-run.mjs`、`m11/panel-fixture`、`m12/INSTALL_EVIDENCE.json`），但这个目录被 gitignore。换机器后场景、fixture 和证据都找不到，只能靠历史记忆重做。
- 新工具、新 API 路由、新 preset 或新生命周期分支可以合并而没有任何 E2E 场景覆盖；M12 只在手工运行时证明过一条路径，且模型路由在 E2E 中关闭。

结果是 E2E 既不可移植，也不能随版本自动要求更新，更无法回答“这次发布覆盖了哪些公开能力”。

## Proposal

**1. 场景和 fixture 进 git，`.dsh-cowork/e2e/` 只做输出。** 所有可复用 fixture、驱动、runbook 和断言迁到 `tests/e2e/`；启动/清理代码放 `tools/e2e/`。`.dsh-cowork/e2e/` 只存本次运行的原始证据和截图，不作为任何测试逻辑的唯一副本。迁移时逐文件审查现有 `.dsh-cowork/e2e`，只搬可复现的代码，不搬机器路径、token 或旧截图。

**2. 版本 manifest 是 E2E 的入口。** 新增 `tests/e2e/manifest.json`，声明 `pluginVersion`、支持的 DSH 主机范围、场景列表、场景到公开能力的覆盖矩阵，以及每个场景是 keyless deterministic 还是 live-model observational。`npm run check` 校验 manifest 的 `pluginVersion` 与 `package.json` 一致；版本号变更而没有更新 manifest/场景时直接变红。

**3. 覆盖矩阵按公开面自动检查。** 从 `src/tools.ts`、`src/api-contract.ts`、`src/presets.ts` 和生命周期常量导出当前工具、路由、preset、状态与动作清单，`tools/check-e2e-coverage.mjs` 要求每个公开项至少绑定一个场景 ID。新增业务工具或 `/api/cowork.*` 路由而没有场景时，门禁失败；这条检查不把行覆盖率当行为覆盖率。

**4. 用一个真实宿主 harness 驱动所有场景。** `npm run test:e2e` 从当前 `lib/` 打包，装进临时 `DSH_HOME` 的 web profile，启动 `dsh web --port 0 --no-open`，换 token 后用真实会话、工具、HTTP 路由和面板动作执行场景。每个场景自己创建 fixture、会话和工作项并在 `finally` 清理；等待状态变化而不是固定 sleep。keyless 场景通过受控模型适配器或测试 profile patch 固定模型输出；live-model 场景独立标记，缺少模型时 self-skip。

**5. 证据可移植。** 原始证据仍可写 `.dsh-cowork/e2e/`，但 runner 同时生成一份去敏摘要：场景 ID、pass/fail、插件版本、DSH 版本、HEAD、diff digest、命令和退出码，不含 hostname、token、绝对用户路径。发布时把摘要写入 `docs/handoff/e2e/<version>.json` 并随代码提交；新机器用同一命令可重新生成它，摘要不是测试逻辑的唯一副本。

**6. 替换顺序。** 先让新 harness 覆盖 M12 的现有 17 步并补上 panel/inbox/notice/authorization/migration 的缺口；确认 parity 后把 `src/m2-e2e*`、`src/m3-e2e*`、`src/m12-e2e*` 从产品源码中移出或明确标记为 legacy。旧 `.dsh-cowork/e2e` 只保留历史摘要，不再作为验收入口。

## Alternatives considered

**把 `.dsh-cowork/e2e/` 整个提交。** 否决：里面有机器路径、临时 profile、截图和重复/失败证据，无法区分测试代码与运行产物，也会把本地状态变成仓库事实。只提交可复现的代码和去敏摘要。

**继续维护 M12 并在文件里加版本注释。** 否决：它绑死 dev route 和 0.2.0 的业务链，新增能力不会自动触发场景更新；注释不能阻止“没有场景也算绿”。

**只做单元/契约测试。** 否决：模型路由、session 唤醒、工作项 clone/merge、真实 HTTP 与面板注入都必须经过真实宿主；同进程 mock 不能证明这些。

**只做真实模型 E2E。** 否决：成本、速度和模型非确定性会让主门禁不稳定；确定性场景必须 keyless，真实模型只覆盖路由质量、工具调用和取消等观测性目标。

## Acceptance criteria

- [A1] `npm run test:e2e` 从 tarball 在临时 `DSH_HOME` 启动真实宿主，运行 git 内场景并在成功/失败路径都清理进程、profile、fixture 和缓存 — `packaging`
- [A2] `tests/e2e/manifest.json` 与 `package.json` 版本一致；新增公开工具、路由或 preset 而没有场景映射时检查变红 — `workflow`
- [A3] 覆盖矩阵逐项列出所有公开工具、API 路由、preset、生命周期状态和面板动作，并至少有一条 keyless 场景；缺口可定位到能力名 — `tests`
- [A4] live-model lane 独立标记、无模型 self-skip；其通过/失败不伪装成 keyless deterministic 结果 — `tests`
- [A5] 发布摘要写入 `docs/handoff/e2e/<version>.json`，去敏且可从同一版本重新生成；`npm run check` 校验摘要包含场景结果与 artifact identity — `workflow`

## Risks

- 真实宿主的 UI/API 会随 DSH 版本变化；manifest 必须声明测试范围，runner 先检查 `dsh --version`，不支持的版本明确失败或标记 observational。
- 受控模型适配器可能与真实 provider 行为不同；keyless lane 证明确定性与宿主链路，不能替代 live-model 的质量观测。
- 场景覆盖矩阵只证明“有能力被点名”，不证明组合爆炸和边界值；边界仍由 unit/contract 测试承担。
- 每个场景启动/清理真实宿主可能很慢；共享 fixture 只在不会互相污染时使用，失败重试不能掩盖状态依赖。
- 旧 M2/M3/M12 驱动与 `.dsh-cowork/e2e` 有历史价值，但迁移前必须保留 cross-link，不能直接删除旧证据。

## Delivery stages

1. 盘点 `.dsh-cowork/e2e` 与 `src/*e2e*`，把可复用 fixture/驱动迁到 `tests/e2e/`，建立 manifest 与公开面清单。
2. 实现临时 `DSH_HOME` harness 与 3–5 个最小 keyless 场景（init/route/work-item/review/merge），先报告不阻塞。
3. 补齐 panel/inbox/notice/authorization/migration 场景和覆盖矩阵门禁，写出第一份版本摘要。
4. 增加 live-model observational 场景；连续稳定后把 keyless E2E 提升为发布阻塞，并下线 legacy M12 入口。
