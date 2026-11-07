# M4 结果：单插件打包与发布

- 结论：**M4 已交付并在真实安装 profile 验证**。仓库现在是一个可安装的 bundle：`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 只插一行 `id: dsh-cowork`；一个新的 profile 只装 `@dsh-external/dsh-cowork` 一个包（`m4verify`，`--from-default-profile web`），重启后 preset、11 个业务工具、面板 API 与真实 Chrome 面板都来自已安装包；默认配置下 dev/E2E 面关闭；已安装 profile 跑通 15/15 步真实 flow；卸载后项目数据保留。
- 分支与提交：`feat/m4-packaging` 从 `fix/m3-closeout` 的 `5622759` 开。关键提交：`914f997`（bundle 层）、`9451efc`（packaging 契约测试）、`d3751ed`（dev 门 + `canonicalRepoPath`）、`46de4e3`（README 手册），集成合并 `bc00b59` / `e70d05d` / `9ceece7`。最终交付 HEAD 与 M4A8 的独立审查结论由收口 marker `.dsh-cowork/e2e/M4_DOCS_READY.json` 记录；本文不预写该结论。
- 环境：DSH `0.2.1-rc.2`、Desktop `2.0.18`、node `v22.22.1`、darwin arm64；DSH source checkout `/Users/ray/Workspace/deepseek-harness`；验证 profile `m4verify`（独立进程，未动用户 `web`/`desktop`）。
- 依据：[M4 决策](../.agents/notes/implemented/feature/2026-11-05-m4-packaging.md) 拥有分发形态、preset 与 dev 门的选择；[M4-P0 探针](M4_PROBE_RESULT.md) 拥有探针命令与 P0-F1..F3；[M4 交接](M4_HANDOFF.md) 拥有下一会话的验证 runbook；[PLAN](PLAN.md) §6 M4 拥有验收条目；[KNOWN_ISSUES](KNOWN_ISSUES.md) 拥有不修项。本文只拥有交付面、逐条验收证据与限制。

## 交付面

| 落点 | 职责 |
|---|---|
| [`package.json`](../package.json) | `version: 0.1.0`、`dsh.bundle.patch: ./cordis.patch.yml`、`files: [lib, cordis.patch.yml, README.md, LICENSE]`；`private: true`（不发布 npm）；`dsh.client` 仍只声明 `web` |
| [`cordis.patch.yml`](../cordis.patch.yml) | 唯一一行 `insert`：`id: dsh-cowork` / `name: '@dsh-external/dsh-cowork'`；id 与工具、preset、client 共用同一实例，不新增行名 |
| [`README.md`](../README.md) | 面向用户的安装（build → pack → 新 profile → add → 重启）、选择 preset、使用流程、数据落点、卸载与升级、限制与前提 |
| [`src/index.ts`](../src/index.ts) | `Config.enableDevRoutes`（`z.boolean().default(false)`，[L87](../src/index.ts#L87)）；默认不注册探针/E2E 路由、两个探针工具与 M0/S0/M2/M3 runner 监听（[L532](../src/index.ts#L532)）；dev 配置的 `repoPath` 启动时经 `canonicalRepoPath` 规范化（[L202](../src/index.ts#L202)） |
| [`src/probe-model.ts`](../src/probe-model.ts) | `canonicalRepoPath`：存在则 `realpath`，缺失原样返回（[L54](../src/probe-model.ts#L54)） |
| [`tests/packaging.test.mjs`](../tests/packaging.test.mjs) | 钉住安装契约：身份与入口、`dsh.client` 平台与注入、`dsh.bundle.patch` 指向仓库内文件、`files` 恰好 lib/patch/README/LICENSE、patch 只有一行 insert、`npm pack` 只含运行时文件 |
| [`tests/dev-gate.test.mjs`](../tests/dev-gate.test.mjs) | 钉住 dev 门：默认 `false`；`false` 保留业务面且不注册 dev 面；`true` 还原 M0/S0/M2/M3；软链 `repoPath` 规范化；dispose 释放 dev 监听 |

## 验收对照

| id | 结果 | 证据 |
|---|---|---|
| M4A1 bundle 包在干净 profile 中安装成功，`--dump-config` 出现 cowork 层，不改动 base/web 既有行 | 通过 | `m4verify` 上 `dsh plugin --profile m4verify add ./dsh-external-dsh-cowork-0.1.0.tgz` exit 0；`--dump-config` 出现 `# == @dsh-external/dsh-cowork` 与 `- id: dsh-cowork`；`tests/packaging.test.mjs` 钉住清单与 patch 形状 |
| M4A2 重启后三个 cowork preset 可选、工具面正确，`sessionController.create({agentPreset:'cowork-master'})` header 正确 | 通过 | 已安装 profile 的 15/15 E2E：`setup` 断言 preset 创建与 header；`tests/dev-gate.test.mjs` 证明 dev 门不影响 preset/业务工具；`src/presets.ts` 仍是唯一行清单 |
| M4A3 安装后的 client 在真实 Chrome 加载，底栏/tab/panel 可用，无 dev 注入 | 通过 | 面板证据见下「面板」；KI-11 的缓存例外只存在于 dev 注入器路径，安装 + 重启路径不复现 |
| M4A4 安装后的 profile 跑通真实 flow（init/thread/handoff/review/needs_revision 退回/pass 合并） | 通过 | 下方「真实安装 E2E」，`m3-d5e44800-91d0-41d7-a6f6-e80a9ac5213e`，15/15 |
| M4A5 卸载移除 bundle 层、保留 `.dsh-cowork` 数据；旧会话 preset 不可恢复写进文档 | 通过 | 下方「卸载」；[README](../README.md)「卸载与升级」写明旧会话恢复会失败 |
| M4A6 `enableDevRoutes=false` 时探针/E2E 路由与探针工具不注册；`true` 可跑 E2E；软链前缀下断言稳定 | 通过 | `tests/dev-gate.test.mjs`（默认值、两态路由/工具面、`canonicalRepoPath`、dispose）；下方「默认配置」实测 404/401 |
| M4A7 `files` 只含 lib/patch/README/LICENSE；tarball 可安装；git 安装不支持与 npm 未发布写清 | 通过 | 下方「打包产物」；[README](../README.md) 安装注意事项与限制 |
| M4A8 README/M4 结果/探针/交接、PLAN/KNOWN_ISSUES/publish 分类完成；四条命令通过；独立 reviewer pass | 由收口 marker 记录 | `.dsh-cowork/e2e/M4_DOCS_READY.json` 记录最终 HEAD、四条命令与独立 verifier/reviewer 的结论；本文不预写 pass |

## 真实安装 E2E（通过）

- profile：`m4verify`，用 `dsh --profile m4verify --from-default-profile web` 创建，只安装 `@dsh-external/dsh-cowork`；用户 `web`/`desktop` profile 未改。E2E 期间用 profile patch 覆盖 `id: dsh-cowork` 的 `config`：`enableDevRoutes: true`、`repoPath: /private/tmp/m4-e2e`（维护者面，见 `/private/tmp/m4-e2e/profile-dev.patch.yml`）。
- 证据：`/private/tmp/m4-e2e/.dsh-cowork/e2e/M3_E2E.json`（132,229 B；路径相对 repoPath 为 `.dsh-cowork/e2e/M3_E2E.json`）。runId `m3-d5e44800-91d0-41d7-a6f6-e80a9ac5213e`，`state=done`，**15/15 步 passed**；`host.pluginVersion=0.1.0`、`host.repoPath=/private/tmp/m4-e2e`，证明插件从已安装包加载而不是 dev 注入。
- 覆盖：`thread-a` work → review pass → merge；`thread-b` 首轮 `needs_revision` → 修复 → 第二轮 pass → merge。两次合并提交 `040a6eb786d7d058791eb3acd4013c21feedb41e` / `1e48585f43418077585b70f2a0834e1fc711e491`。
- 最终索引：两条 thread 均 `status=done` / `reviewStatus=pass`（subject 分别为 `M3 E2E review pass`、`M3 E2E review repair`）；review 文件两条，均为 `verdict=pass`：
  - `.dsh-cowork/e2e/m3-repo/.dsh-cowork/reviews/session-e95215f7-b3da-4172-8751-8595f3e25c5d-20261107T084148208Z.json`
  - `.dsh-cowork/e2e/m3-repo/.dsh-cowork/reviews/session-0e1a2f4f-ce1f-4339-bdea-de547162b086-20261107T084247344Z.json`
- 清理：`cleanup.archived` 归档 6 个会话（master、两条 thread、三个 reviewer），`archiveErrors=[]`、`errors=[]`、`tempRepoRemoved=true`。

## 默认配置（产品面）

- 证据：仓库根 `.dsh-cowork/e2e/m4/02-default-config-routes.txt`（gitignored，下同）。产品默认（`enableDevRoutes` 缺省 => `false`）下，`/dsh-cowork/probe/*` 与 `/dsh-cowork/e2e/*` **全部 404**；`/api/cowork.overview` **401**（路由存在，trust fence 生效，不是 404）。
- 默认阶段用的 profile patch 只覆盖 `repoPath`（不设 `enableDevRoutes`），见 `/private/tmp/m4-e2e/profile-default.patch.yml`；`repoPath` 不是产品工具的项目发现入口——业务工具按调用者 cwd 找项目（[`src/tools.ts:181`](../src/tools.ts#L181)），只在失败提示里回显插件默认仓库，dev runner 才用它定位 fixture 与证据。
- 门在哪：`src/index.ts` 的 `Config.enableDevRoutes` 默认 `false`，探针/E2E 路由、`cowork_probe`/`cowork_identity_probe` 与 runner 监听都包在开关内；`tests/dev-gate.test.mjs` 同时钉住两态。

## 面板（真实 Chrome）

- 证据：仓库根 `.dsh-cowork/e2e/m4/01-installed-panel-real-project.jpg`（gitignored）：真实 Chrome 打开 `m4verify` 宿主，底栏出现「打开 Cowork 面板」，tab 与面板显示 dsh-cowork 项目「路由演示」。
- 结论：client 从已安装包进入浏览器 boot 列表，不依赖 `dev_inject_plugin`；旧进程不算数（KI-11 只余 dev 注入路径）。
- 支撑：`tests/packaging.test.mjs` 钉住 `dsh.client.platform=web` 与 sidebar/workspace 注入；`lib/client.js` 由构建产出并随 `lib/` 进包。

## 打包产物

- `npm run build` 后 `npm pack` → `dsh-external-dsh-cowork-0.1.0.tgz`：**78 个文件、249,566 B**；内容只有 `lib/**`（含 `.js.map`）、`cordis.patch.yml`、`README.md`、`LICENSE`、`package.json`；`tools/`、`tests/`、`docs/`、`.dsh-cowork/` 均不进包。
- 该 tarball 在干净 profile 中安装、重启、跑 E2E 均通过（上面的 run）。`tests/packaging.test.mjs` 用 `npm pack --dry-run --json` 检查清单（只读，不写产物）。

## 卸载

- `dsh plugin --profile m4verify remove @dsh-external/dsh-cowork` exit 0 后，profile 的 bundles 回到 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`，`node_modules/@dsh-external/` 为空；profile 里残留的 `cordis.patch.yml` 只有 `repoPath` 覆盖，不提供 cowork 行。
- 项目数据未变：卸载前后 `.dsh-cowork` 目录内容 hash 一致（E2E fixture 之外的真实项目数据）。
- 旧会话后果：会话 header 仍记 `cowork-master`/`cowork-thread`/`cowork-reviewer`，preset 定义随包消失，恢复会失败；已写进 [README](../README.md)「卸载与升级」。

## 四条命令

`npm run check` exit 0；`npm test` **342/342**；`npm run typecheck` exit 0；`npm run build` exit 0（`lib/client.js` 69 KB）。相对 M3-FIX 的 330 个用例，M4 新增 12 个（packaging 6 + dev-gate 5 + `canonicalRepoPath` 1）。最终提交上的复跑结果由收口 marker 记录。

## 限制（不修项见 KNOWN_ISSUES）

1. **未发布 npm**：`private: true`；npm 发布、创建远端仓库与合并 `main` 都需要用户明确授权，M4 只验证本地 tarball。
2. **不支持 git 安装**：git 装到的是源码仓库，没有预构建 `lib/`；README 不写跑不通的 `prepare`。
3. **dev 面默认关闭**：`/dsh-cowork/probe/*`、`/dsh-cowork/e2e/*` 与两个探针工具是维护者选项，用户装完看不到；E2E 用 profile patch 覆盖。
4. **reviewer 仍可用 bash 写被审文件**：工具面无 write/edit，只读性靠 preset 与 protocol，不是沙箱（KI-15）。
5. **source map 进包**：`lib/**` 整目录打包，`.js.map` 随行；当前接受（便于维护者定位），需要缩小体积时再在 `files`/构建里排除。
6. **共享 home 的测试会话只归档未删除**：`m4verify` 与用户 `web` 共用 `~/.dsh`，runner 归档 6 个测试会话但不删除；收口时删除 `m4verify` profile，测试会话按 P0-F2 的处置留在归档态。
7. **`m4verify` 在收口时删除**：它与测试会话不属于交付物；保留会让下一个人的 `~/.dsh` 里多一个只装过测试包的 profile。

## 回滚

- 代码：按提交 revert `914f997`、`9451efc`、`d3751ed`、`46de4e3` 及其集成合并；`main` 未由 M4 改动。
- 安装：`dsh plugin --profile m4verify remove @dsh-external/dsh-cowork`，再删除 `m4verify` profile；不动 `web`/`desktop`。
- 数据：`.dsh-cowork` 不随包删除；需要保留旧会话时先归档/导出，回滚代码不影响索引（version 仍为 1）。
- 运行时回退：开发期可继续 `dev_inject_plugin /Users/ray/Workspace/dsh-cowork`，但那是 dev 路径，不是 M4 的验收路径。
